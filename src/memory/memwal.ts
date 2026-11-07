// Walrus Memory: Postmortem's long-term memory. Every postmortem leaves records that the next
// analysis, of any wallet, reads first. This is the Law Merchant's fee-to-check-a-partner's-record,
// rebuilt: before you deal with an address, ask what the record says.
//
// Live: set MEMWAL_PRIVATE_KEY + MEMWAL_ACCOUNT_ID (from memory.walrus.xyz). Writes go to Walrus
// mainnet through the relayer. Without them the SDK's in-memory mock runs, so tests and local demos
// need no keys; the UI says which one is active.
import { MemWal, MemWalMock } from "@mysten-incubation/memwal";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { blockStamp } from "../sources/tatum.js";

export const NS = { incidents: "incidents", counterparties: "counterparties" } as const;
type Ns = (typeof NS)[keyof typeof NS];

export interface MemoryRecord {
  kind: "incident" | "counterparty";
  chain: string;
  wallet?: string;
  address?: string; // counterparty
  verdict?: "pulled" | "tagged" | "high" | "medium" | "low" | "revoked" | "clean";
  pulled_usd?: number;
  pulls?: number;
  symbol?: string;
  reasons?: string[];
  report_id?: string;
  at: string; // ISO
  block?: number | null; // chain block at write time, via Tatum
}

export interface MemoryEntry extends MemoryRecord {
  blob_id: string;
  namespace: Ns;
  text: string;
  mode: "live" | "mock";
}

type Client = ReturnType<typeof MemWal.create> | ReturnType<typeof MemWalMock.create>;
let client: Client | null = null;
let mode: "live" | "mock" = "mock";

export function memoryMode() {
  return mode;
}

function get(): Client {
  if (client) return client;
  const key = process.env.MEMWAL_PRIVATE_KEY;
  const accountId = process.env.MEMWAL_ACCOUNT_ID;
  if (key && accountId) {
    client = MemWal.create({ key, accountId, serverUrl: process.env.MEMWAL_SERVER_URL ?? "https://relayer.memory.walrus.xyz", namespace: NS.incidents });
    mode = "live";
  } else {
    client = MemWalMock.create({ namespace: NS.incidents });
    mode = "mock";
  }
  return client;
}

// A local ledger of what was written, so the inspector can list memories without a recall and so a
// mock run still shows its writes. Live blob ids are the proof; this file is only the index.
const LEDGER = process.env.MEMORY_LEDGER ?? "./data/memory-ledger.json";
function readLedger(): MemoryEntry[] {
  try {
    return existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : [];
  } catch {
    return [];
  }
}
function appendLedger(e: MemoryEntry) {
  const all = readLedger();
  all.push(e);
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify(all, null, 2));
}
export function ledger(): MemoryEntry[] {
  return readLedger().slice().reverse();
}

/** One memory = one readable sentence plus the exact record as JSON, so recall works by meaning and parsing stays exact. */
export function render(rec: MemoryRecord): string {
  const head =
    rec.kind === "incident"
      ? `Postmortem for wallet ${rec.wallet} on ${rec.chain} (${rec.at.slice(0, 10)}): ${rec.reasons?.join("; ") ?? "no findings"}.`
      : `Counterparty ${rec.address} on ${rec.chain} (${rec.at.slice(0, 10)}): verdict ${rec.verdict}` +
        (rec.pulls ? `, pulled ${rec.symbol ?? "tokens"} from wallet ${rec.wallet} in ${rec.pulls} tx` : "") +
        (rec.reasons?.length ? `; ${rec.reasons.join("; ")}` : "") +
        ".";
  return `${head}\n${JSON.stringify(rec)}`;
}
export function parse(text: string): MemoryRecord | null {
  const i = text.lastIndexOf("\n{");
  if (i < 0) return null;
  try {
    return JSON.parse(text.slice(i + 1));
  } catch {
    return null;
  }
}

export async function remember(ns: Ns, rec: MemoryRecord, opts: { idempotencyKey?: string } = {}): Promise<MemoryEntry> {
  rec.block = rec.block ?? (await blockStamp(rec.chain));
  const text = render(rec);
  const c = get();
  const r = await c.rememberAndWait(text, ns, { idempotencyKey: opts.idempotencyKey, timeoutMs: 45_000 } as any);
  const entry: MemoryEntry = { ...rec, blob_id: r.blob_id, namespace: ns, text, mode };
  appendLedger(entry);
  return entry;
}

export async function recall(ns: Ns, query: string, limit = 20): Promise<MemoryEntry[]> {
  const c = get();
  const r = await c.recall({ query, namespace: ns, limit, maxDistance: 0.9 } as any);
  return (r.results as any[])
    .map((m) => {
      const rec = parse(m.text);
      return rec ? ({ ...rec, blob_id: m.blob_id, namespace: ns, text: m.text, mode } as MemoryEntry) : null;
    })
    .filter((x): x is MemoryEntry => !!x);
}

/** The record check. Everything memory holds about one address, folded into a credibility score. */
export interface Record_ {
  address: string;
  seen: number;
  wallets: string[];
  pulls: number;
  pulled_usd: number;
  verdicts: Record<string, number>;
  last?: MemoryEntry;
  credibility: number; // 0 (drainer) .. 100 (clean record)
  summary: string;
}
export async function recordOf(address: string, chain?: string): Promise<Record_> {
  const a = address.toLowerCase();
  const hits = (await recall(NS.counterparties, `counterparty ${a}`, 50)).filter((h) => h.address === a && (!chain || h.chain === chain));
  const wallets = [...new Set(hits.map((h) => h.wallet).filter(Boolean))] as string[];
  const verdicts: Record<string, number> = {};
  let pulls = 0,
    pulledUsd = 0;
  for (const h of hits) {
    verdicts[h.verdict ?? "unknown"] = (verdicts[h.verdict ?? "unknown"] ?? 0) + 1;
    pulls += h.pulls ?? 0;
    pulledUsd += h.pulled_usd ?? 0;
  }
  let cred = 100;
  cred -= 40 * (verdicts.pulled ?? 0) + 35 * (verdicts.tagged ?? 0) + 15 * (verdicts.high ?? 0) + 5 * (verdicts.medium ?? 0);
  cred -= 10 * Math.max(0, wallets.length - 1);
  cred += 5 * (verdicts.clean ?? 0) + 2 * (verdicts.low ?? 0);
  cred = Math.max(0, Math.min(100, cred));
  const last = hits.sort((x, y) => (x.at < y.at ? 1 : -1))[0];
  const summary = hits.length
    ? `${a.slice(0, 10)}… has a record: seen in ${hits.length} prior postmortem(s) across ${wallets.length} wallet(s); ${pulls ? `pulled funds ${pulls} time(s)` : "never pulled funds"}; last verdict ${last?.verdict} on ${last?.at.slice(0, 10)}. Credibility ${cred}/100.`
    : `${a.slice(0, 10)}… has no record in memory yet. Credibility ${cred}/100 by default.`;
  return { address: a, seen: hits.length, wallets, pulls, pulled_usd: pulledUsd, verdicts, last, credibility: cred, summary };
}

export async function health(): Promise<{ mode: "live" | "mock"; ok: boolean; writes: number }> {
  let ok = true;
  try {
    await (get() as any).health?.();
  } catch {
    ok = false;
  }
  return { mode, ok, writes: readLedger().length };
}

/** test hook */
export function _reset() {
  client = null;
  mode = "mock";
}
