import type { Approval, Holding, Party, TokenRef, Transfer, TxRec } from "../types.js";
import { isUnlimited, lc, toUnits, tsOf } from "../util.js";

type Json = Record<string, any>;
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Reads one Blockscout instance's REST API v2. Field names follow docs.blockscout.com; both old and new token address keys are accepted. */
export class Blockscout {
  constructor(
    private base: string,
    private native: string,
    private fetchImpl: FetchLike = fetch,
    private apiKey = process.env.BLOCKSCOUT_API_KEY,
  ) {}

  private async get(path: string, params: Record<string, string | number | undefined> = {}): Promise<Json> {
    const u = new URL(this.base.replace(/\/$/, "") + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    if (this.apiKey) u.searchParams.set("apikey", this.apiKey);
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchImpl(u.toString(), { headers: { accept: "application/json" } });
        if (res.status === 429 || res.status >= 500) throw new Error(`Blockscout ${res.status} on ${u.pathname}`);
        if (!res.ok) throw Object.assign(new Error(`Blockscout ${res.status} on ${u.pathname}`), { fatal: true });
        return (await res.json()) as Json;
      } catch (e: any) {
        last = e;
        if (e?.fatal) throw e;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw last;
  }

  /** Follows next_page_params until it runs out or maxPages is reached. */
  async paged(path: string, params: Record<string, string | number | undefined>, maxPages: number): Promise<{ items: Json[]; complete: boolean }> {
    const items: Json[] = [];
    let next: Record<string, any> | null = {};
    let pages = 0;
    while (next && pages < maxPages) {
      const page = await this.get(path, { ...params, ...next });
      items.push(...((page.items as Json[]) ?? []));
      next = page.next_page_params ?? null;
      pages++;
    }
    return { items, complete: next == null };
  }

  async tokenTransfers(addr: string, maxPages: number, opts: { filter?: "to" | "from"; token?: string } = {}) {
    const { items, complete } = await this.paged(`/addresses/${addr}/token-transfers`, { type: "ERC-20,ERC-721,ERC-1155", filter: opts.filter, token: opts.token }, maxPages);
    return { transfers: items.map((i) => normTokenTransfer(i)).filter((t): t is Transfer => !!t), complete };
  }

  async transactions(addr: string, maxPages: number) {
    const { items, complete } = await this.paged(`/addresses/${addr}/transactions`, {}, maxPages);
    return { txs: items.map((i) => normTx(i)), complete };
  }

  async internalTransactions(addr: string, maxPages: number) {
    const { items, complete } = await this.paged(`/addresses/${addr}/internal-transactions`, {}, maxPages);
    return { transfers: items.map((i, n) => normInternal(i, n, this.native)).filter((t): t is Transfer => !!t), complete };
  }

  async transaction(hash: string): Promise<TxRec | null> {
    try {
      return normTx(await this.get(`/transactions/${hash}`));
    } catch {
      return null;
    }
  }

  async address(addr: string): Promise<Party | null> {
    try {
      const a = await this.get(`/addresses/${addr}`);
      return party(a) ?? null;
    } catch {
      return null;
    }
  }

  async tokenBalances(addr: string): Promise<Holding[]> {
    try {
      const res = await this.get(`/addresses/${addr}/token-balances`);
      const rows: Json[] = Array.isArray(res) ? res : (res.items ?? []);
      return rows
        .map((r) => {
          const token = tokenRef(r.token);
          if (!token || token.type !== "ERC-20") return null;
          const raw = String(r.value ?? "0");
          return { token, raw, amount: toUnits(raw, token.decimals) };
        })
        .filter((h): h is Holding => !!h);
    } catch {
      return [];
    }
  }

  async nativeBalance(addr: string): Promise<string | null> {
    try {
      const a = await this.get(`/addresses/${addr}`);
      return a.coin_balance != null ? String(a.coin_balance) : null;
    } catch {
      return null;
    }
  }
}

export function party(p: Json | null | undefined): Party | undefined {
  const addr = lc(p?.hash ?? p?.address_hash ?? p?.address);
  if (!addr) return undefined;
  const tags = [
    ...((p?.public_tags ?? []) as Json[]).map((t) => t?.display_name ?? t?.label),
    ...((p?.metadata?.tags ?? []) as Json[]).map((t) => t?.name),
  ].filter((x): x is string => typeof x === "string" && x.length > 0);
  return {
    addr,
    name: p?.name ?? p?.implementation_name ?? undefined,
    isContract: p?.is_contract ?? undefined,
    verified: p?.is_verified ?? undefined,
    ens: p?.ens_domain_name ?? undefined,
    tags: tags.length ? [...new Set(tags)] : undefined,
  };
}

export function tokenRef(t: Json | null | undefined): TokenRef | undefined {
  const addr = lc(t?.address_hash ?? t?.address);
  if (!addr) return undefined;
  const rate = Number(t?.exchange_rate);
  return {
    addr,
    symbol: t?.symbol ?? "?",
    name: t?.name ?? undefined,
    decimals: Number(t?.decimals ?? 0) || (t?.type === "ERC-20" ? 18 : 0),
    type: t?.type ?? "ERC-20",
    priceUsd: Number.isFinite(rate) && rate > 0 ? rate : undefined,
  };
}

export function normTokenTransfer(i: Json): Transfer | null {
  const from = party(i.from);
  const to = party(i.to);
  const token = tokenRef(i.token);
  if (!from || !to || !token || !i.transaction_hash) return null;
  const isNft = token.type === "ERC-721";
  const raw = isNft ? "1" : String(i.total?.value ?? "0");
  const decimals = isNft ? 0 : Number(i.total?.decimals ?? token.decimals ?? 0);
  return {
    key: `${lc(i.transaction_hash)}:${i.log_index ?? 0}`,
    tx: lc(i.transaction_hash),
    ts: tsOf(i.timestamp),
    from,
    to,
    token: { ...token, decimals: isNft ? 0 : token.decimals },
    raw,
    amount: toUnits(raw, decimals),
    method: i.method ?? undefined,
    kind: "token",
  };
}

export function normTx(i: Json): TxRec {
  return {
    hash: lc(i.hash),
    ts: tsOf(i.timestamp),
    from: party(i.from) ?? { addr: "" },
    to: party(i.to),
    method: i.method ?? i.decoded_input?.method_call?.split("(")[0] ?? undefined,
    status: i.status === "error" || i.result === "error" ? "error" : "ok",
    valueRaw: String(i.value ?? "0"),
    feeRaw: String(i.fee?.value ?? "0"),
    params: Array.isArray(i.decoded_input?.parameters)
      ? (i.decoded_input.parameters as Json[]).map((p) => ({ name: String(p.name ?? ""), type: String(p.type ?? ""), value: p.value }))
      : undefined,
  };
}

export function normInternal(i: Json, n: number, native: string): Transfer | null {
  const from = party(i.from);
  const to = party(i.to);
  const raw = String(i.value ?? "0");
  if (!from || !to || raw === "0" || i.success === false || i.error) return null;
  return {
    key: `${lc(i.transaction_hash)}:internal:${i.index ?? n}`,
    tx: lc(i.transaction_hash),
    ts: tsOf(i.timestamp),
    from,
    to,
    token: { addr: "native", symbol: native, decimals: 18, type: "native" },
    raw,
    amount: toUnits(raw, 18),
    kind: "internal",
  };
}

/** A wallet's own transaction that moved native coin. */
export function nativeTransferOf(tx: TxRec, native: string): Transfer | null {
  if (tx.status !== "ok" || !tx.to || tx.valueRaw === "0") return null;
  return {
    key: `${tx.hash}:native`,
    tx: tx.hash,
    ts: tx.ts,
    from: tx.from,
    to: tx.to,
    token: { addr: "native", symbol: native, decimals: 18, type: "native" },
    raw: tx.valueRaw,
    amount: toUnits(tx.valueRaw, 18),
    method: tx.method,
    kind: "native",
  };
}

const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const SPENDER_KEYS = ["spender", "_spender", "operator", "_operator", "guy", "usr", "to"];
const AMOUNT_KEYS = ["amount", "_amount", "value", "_value", "wad", "addedValue", "approved", "_approved"];

/** Reads approve / increaseAllowance / setApprovalForAll / Permit2.approve calls the wallet sent itself. */
export function approvalOf(tx: TxRec, tokenLookup: (addr: string) => TokenRef | undefined): Approval | null {
  if (tx.status !== "ok" || !tx.to || !tx.params?.length) return null;
  const m = (tx.method ?? "").toLowerCase();
  if (!["approve", "increaseallowance", "setapprovalforall"].includes(m)) return null;
  const byName = (keys: string[]) => tx.params!.find((p) => keys.includes(p.name));
  const isPermit2 = lc(tx.to.addr) === PERMIT2;
  const spenderP = byName(SPENDER_KEYS) ?? tx.params.find((p) => p.type === "address" && (!isPermit2 || p.name !== "token"));
  if (!spenderP) return null;
  const spender = lc(String(spenderP.value));
  let kind: Approval["kind"] = "erc20";
  let tokenAddr = lc(tx.to.addr);
  let raw: string;
  if (m === "setapprovalforall") {
    kind = "all";
    const v = byName(AMOUNT_KEYS)?.value ?? tx.params.find((p) => p.type === "bool")?.value;
    raw = v === true || v === "true" ? "1" : "0";
  } else {
    if (isPermit2) {
      kind = "permit2";
      tokenAddr = lc(String(byName(["token"])?.value ?? ""));
    }
    const v = byName(AMOUNT_KEYS) ?? tx.params.find((p) => p.type.startsWith("uint"));
    raw = String(v?.value ?? "0");
  }
  if (!tokenAddr) return null;
  const token = tokenLookup(tokenAddr) ?? { addr: tokenAddr, symbol: tx.to.name ?? "?", decimals: 18, type: kind === "all" ? "ERC-721" : "ERC-20" };
  return {
    owner: lc(tx.from.addr),
    spender: { addr: spender },
    token,
    raw,
    unlimited: kind === "all" ? raw === "1" : isUnlimited(raw),
    ts: tx.ts,
    tx: tx.hash,
    kind,
  };
}
