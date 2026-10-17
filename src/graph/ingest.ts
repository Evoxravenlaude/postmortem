import { chainOf } from "../chains.js";
import { Blockscout, approvalOf, nativeTransferOf, type FetchLike } from "../sources/blockscout.js";
import type { Approval, Holding, Party, TokenRef, Transfer, TxRec } from "../types.js";
import { isAddress, lc, toUnits } from "../util.js";
import { Q, graphFor } from "./db.js";

export interface LoadOptions {
  pages?: number; // pages of 50 per list
  detailCap?: number; // how many "who sent this?" lookups for outflows the wallet did not sign
  fetchImpl?: FetchLike;
}

export interface LoadReport {
  chain: string;
  wallet: string;
  transfers: number;
  txs: number;
  approvals: number;
  holdings: number;
  pulledLookups: number;
  coverageFrom: number; // oldest timestamp the wallet's own transaction list covers (0 = full history)
  complete: { transfers: boolean; txs: boolean };
  warnings: string[]; // parts the explorer could not serve; the load continued without them
  cypher: string[];
}

export async function loadWallet(chainKey: string, address: string, opts: LoadOptions = {}): Promise<LoadReport> {
  if (!isAddress(address)) throw new Error(`"${address}" is not a 0x address`);
  const chain = chainOf(chainKey);
  const w = lc(address);
  const pages = Math.max(1, Math.min(opts.pages ?? Number(process.env.INGEST_PAGES ?? 6), 40));
  const bs = new Blockscout(chain.blockscout, chain.native, opts.fetchImpl);

  // Transfers and the wallet's own transactions are required. Everything else is optional:
  // if the explorer times out on it, the load goes on and says what was skipped.
  const warnings: string[] = [];
  const soft = async <T,>(label: string, p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch (e: any) {
      warnings.push(`${label} skipped: ${String(e?.message ?? e)}`);
      return fallback;
    }
  };
  const [tt, tx, it, self, holdings, nativeRaw, coinPrice] = await Promise.all([
    bs.tokenTransfers(w, pages),
    bs.transactions(w, pages),
    soft("internal transfers", bs.internalTransactions(w, Math.ceil(pages / 2)), { transfers: [] as Transfer[], complete: false, error: undefined as string | undefined }),
    bs.address(w),
    bs.tokenBalances(w),
    bs.nativeBalance(w),
    bs.coinPrice(),
  ]);
  if (tt.error) warnings.push(`token transfers stopped early: ${tt.error}`);
  if (tx.error) warnings.push(`transactions stopped early: ${tx.error}`);
  if (it.error) warnings.push(`internal transfers stopped early: ${it.error}`);
  const nativeToken: TokenRef = { addr: "native", symbol: chain.native, decimals: 18, type: "native", priceUsd: coinPrice };
  for (const t of it.transfers) t.token = nativeToken;

  const tokens = new Map<string, TokenRef>();
  for (const t of tt.transfers) tokens.set(t.token.addr, t.token);
  for (const h of holdings) tokens.set(h.token.addr, h.token);

  const txs = tx.txs.filter((x) => x.hash);
  const signed = new Set(txs.filter((x) => lc(x.from.addr) === w).map((x) => x.hash));
  const coverageFrom = tx.complete ? 0 : Math.min(...txs.map((x) => x.ts).filter((t) => t > 0), Number.MAX_SAFE_INTEGER);

  const approvals = latestApprovals(txs.map((x) => approvalOf(x, (a) => tokens.get(a))).filter((a): a is Approval => !!a && a.owner === w));
  const natives = txs.map((x) => nativeTransferOf(x, chain.native)).filter((t): t is Transfer => !!t).map((t) => ({ ...t, token: nativeToken }));
  const transfers = [...tt.transfers, ...natives, ...it.transfers];

  // Outflows the wallet did not sign were pulled by someone else. Look up who, newest first.
  const cap = opts.detailCap ?? Number(process.env.DETAIL_LOOKUPS ?? 25);
  const pulledHashes = [...new Set(
    transfers
      .filter((t) => t.from.addr === w && t.kind === "token" && !signed.has(t.tx) && t.ts >= coverageFrom)
      .sort((a, b) => b.ts - a.ts)
      .map((t) => t.tx),
  )].slice(0, cap);
  const details = (await Promise.all(pulledHashes.map((h) => bs.transaction(h)))).filter((d): d is TxRec => !!d);

  const nativeHolding: Holding[] = nativeRaw
    ? [{ token: nativeToken, raw: nativeRaw, amount: toUnits(nativeRaw, 18) }]
    : [];

  const g = await graphFor(chain.key);
  const q = new Q(g);
  await writeParties(q, [self ?? { addr: w }, ...partiesOf(transfers, [...txs, ...details], approvals)]);
  await writeTokens(q, [...tokens.values(), nativeToken]);
  await writeTxs(q, [...txs, ...details]);
  await writeTransfers(q, transfers);
  await writeApprovals(q, approvals);
  await writeHoldings(q, w, [...holdings, ...nativeHolding]);
  await linkInitiators(q, [...txs, ...details].map((x) => x.hash));
  await q.rw(
    `MATCH (a:Address {addr:$w}) SET a.wallet = true, a.loadedAt = $now, a.coverageFrom = $cov, a.chain = $chain`,
    { w, now: Math.floor(Date.now() / 1000), cov: coverageFrom === Number.MAX_SAFE_INTEGER ? 0 : coverageFrom, chain: chain.key },
  );

  return {
    chain: chain.key,
    wallet: w,
    transfers: transfers.length,
    txs: txs.length,
    approvals: approvals.length,
    holdings: holdings.length + nativeHolding.length,
    pulledLookups: details.length,
    coverageFrom: coverageFrom === Number.MAX_SAFE_INTEGER ? 0 : coverageFrom,
    complete: { transfers: tt.complete, txs: tx.complete },
    warnings,
    cypher: q.log,
  };
}

/** Follows money one hop further: loads where an address sent a given token after a moment. */
export async function expandOutflows(chainKey: string, address: string, token: string, since: number, opts: LoadOptions = {}) {
  const chain = chainOf(chainKey);
  const bs = new Blockscout(chain.blockscout, chain.native, opts.fetchImpl);
  const { transfers } = await bs.tokenTransfers(lc(address), opts.pages ?? 1, { filter: "from", token });
  const fresh = transfers.filter((t) => t.ts >= since);
  const q = new Q(await graphFor(chain.key));
  await writeParties(q, partiesOf(fresh, [], []));
  await writeTokens(q, fresh.map((t) => t.token));
  await writeTransfers(q, fresh);
  await q.rw(`MATCH (a:Address {addr:$a}) SET a.expandedAt = $now`, { a: lc(address), now: Math.floor(Date.now() / 1000) });
  return { transfers: fresh.length, cypher: q.log };
}

function latestApprovals(list: Approval[]): Approval[] {
  const m = new Map<string, Approval>();
  for (const a of list.sort((x, y) => x.ts - y.ts)) m.set(`${a.owner}|${a.token.addr}|${a.spender.addr}|${a.kind}`, a);
  return [...m.values()];
}

function partiesOf(transfers: Transfer[], txs: TxRec[], approvals: Approval[]): Party[] {
  const m = new Map<string, Party>();
  const add = (p?: Party) => {
    if (!p?.addr) return;
    const prev = m.get(p.addr);
    m.set(p.addr, { ...prev, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) } as Party);
  };
  for (const t of transfers) (add(t.from), add(t.to));
  for (const x of txs) (add(x.from), add(x.to));
  for (const a of approvals) add(a.spender);
  return [...m.values()];
}

const chunk = <T,>(xs: T[], n = 400): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

async function writeParties(q: Q, parties: Party[]) {
  for (const rows of chunk(parties.map((p) => ({ addr: p.addr, name: p.name ?? null, c: p.isContract ?? null, v: p.verified ?? null, ens: p.ens ?? null, tags: p.tags ?? null })))) {
    if (!rows.length) continue;
    await q.rw(
      `UNWIND $rows AS r MERGE (a:Address {addr:r.addr})
       SET a.name = coalesce(r.name, a.name), a.isContract = coalesce(r.c, a.isContract),
           a.verified = coalesce(r.v, a.verified), a.ens = coalesce(r.ens, a.ens), a.tags = coalesce(r.tags, a.tags)`,
      { rows },
    );
  }
}

async function writeTokens(q: Q, tokens: TokenRef[]) {
  const uniq = [...new Map(tokens.map((t) => [t.addr, t])).values()];
  for (const rows of chunk(uniq.map((t) => ({ addr: t.addr, symbol: t.symbol, name: t.name ?? null, d: t.decimals, type: t.type, price: t.priceUsd ?? null })))) {
    if (!rows.length) continue;
    await q.rw(
      `UNWIND $rows AS r MERGE (t:Token {addr:r.addr})
       SET t.symbol = r.symbol, t.name = coalesce(r.name, t.name), t.decimals = r.d, t.type = r.type, t.priceUsd = coalesce(r.price, t.priceUsd)`,
      { rows },
    );
  }
}

async function writeTxs(q: Q, txs: TxRec[]) {
  const uniq = [...new Map(txs.map((x) => [x.hash, x])).values()];
  const rows = uniq.map((x) => ({ h: x.hash, ts: x.ts, m: x.method ?? null, s: x.status, f: lc(x.from.addr), t: x.to ? lc(x.to.addr) : null, fee: x.feeRaw, v: x.valueRaw }));
  for (const part of chunk(rows)) {
    if (!part.length) continue;
    await q.rw(
      `UNWIND $rows AS r MERGE (x:Tx {hash:r.h})
       SET x.ts = r.ts, x.method = r.m, x.status = r.s, x.from = r.f, x.to = r.t, x.feeRaw = r.fee, x.valueRaw = r.v`,
      { rows: part },
    );
    const calls = part.filter((r) => r.t);
    if (calls.length)
      await q.rw(
        `UNWIND $rows AS r MATCH (a:Address {addr:r.f}), (b:Address {addr:r.t})
         MERGE (a)-[c:CALLED {tx:r.h}]->(b) SET c.ts = r.ts, c.method = r.m, c.status = r.s`,
        { rows: calls },
      );
  }
}

async function writeTransfers(q: Q, transfers: Transfer[]) {
  const uniq = [...new Map(transfers.map((t) => [t.key, t])).values()];
  const rows = uniq.map((t) => ({
    k: t.key, f: t.from.addr, to: t.to.addr, tx: t.tx, ts: t.ts, tok: t.token.addr, sym: t.token.symbol,
    raw: t.raw, amt: t.amount, kind: t.kind, m: t.method ?? null, usd: t.token.priceUsd != null ? t.amount * t.token.priceUsd : null,
  }));
  for (const part of chunk(rows)) {
    if (!part.length) continue;
    await q.rw(
      `UNWIND $rows AS r MATCH (a:Address {addr:r.f}), (b:Address {addr:r.to})
       MERGE (a)-[s:SENT {key:r.k}]->(b)
       SET s.tx = r.tx, s.ts = r.ts, s.token = r.tok, s.symbol = r.sym, s.raw = r.raw, s.amount = r.amt,
           s.kind = r.kind, s.method = r.m, s.usdNow = r.usd`,
      { rows: part },
    );
  }
}

async function writeApprovals(q: Q, approvals: Approval[]) {
  const rows = approvals.map((a) => ({
    o: a.owner, s: a.spender.addr, tok: a.token.addr, sym: a.token.symbol, raw: a.raw, u: a.unlimited, ts: a.ts, tx: a.tx, kind: a.kind, d: a.token.decimals,
  }));
  for (const part of chunk(rows)) {
    if (!part.length) continue;
    await q.rw(
      `UNWIND $rows AS r MATCH (o:Address {addr:r.o}) MERGE (s:Address {addr:r.s})
       MERGE (o)-[a:APPROVED {token:r.tok, kind:r.kind}]->(s)
       SET a.symbol = r.sym, a.raw = r.raw, a.unlimited = r.u, a.ts = r.ts, a.tx = r.tx, a.decimals = r.d,
           a.active = (r.raw <> '0')`,
      { rows: part },
    );
  }
}

async function writeHoldings(q: Q, wallet: string, holdings: Holding[]) {
  const rows = holdings.map((h) => ({ tok: h.token.addr, raw: h.raw, amt: h.amount, usd: h.token.priceUsd != null ? h.amount * h.token.priceUsd : null }));
  await q.rw(`MATCH (w:Address {addr:$w})-[h:HOLDS]->() DELETE h`, { w: wallet });
  if (rows.length)
    await q.rw(
      `UNWIND $rows AS r MATCH (w:Address {addr:$w}), (t:Token {addr:r.tok})
       MERGE (w)-[h:HOLDS]->(t) SET h.raw = r.raw, h.amount = r.amt, h.usdNow = r.usd`,
      { w: wallet, rows },
    );
}

/** Stamps every movement with who signed its transaction (by) and which contract it called (via). */
async function linkInitiators(q: Q, hashes: string[]) {
  for (const part of chunk([...new Set(hashes)])) {
    if (!part.length) continue;
    await q.rw(
      `UNWIND $hs AS h MATCH (x:Tx {hash:h}) MATCH ()-[s:SENT]->() WHERE s.tx = h SET s.by = x.from, s.via = x.to`,
      { hs: part },
    );
  }
}
