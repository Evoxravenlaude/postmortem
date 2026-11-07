// Find wallets drained by the same operator, starting from one known drain transaction.
//
//   npm run victims -- <tx hash> [chain] [max txs]
//   npm run victims -- 0x6e88…ffb9 ethereum 60
//
// How it works: the drain tx was signed by the drainer's operator. Every token that tx moved *out of*
// an address other than the operator is a pull: that address is a victim. The script then walks the
// operator's other transactions and collects every address it pulled from the same way, with what
// was taken and how much it was worth today. Those are the wallets to run through Postmortem; they
// all share a spender, so the second run shows the record.
//
// Read-only. Public Blockscout API, no keys.
import { chainOf } from "../src/chains.js";

const [hash, chainKey = "ethereum", maxArg = "60"] = process.argv.slice(2);
if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? "")) {
  console.error("usage: npm run victims -- <tx hash> [chain] [max txs]");
  process.exit(1);
}
const ch = chainOf(chainKey);
const API = ch.blockscout;
const MAX = Number(maxArg);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(path: string): Promise<any> {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(API + path, { headers: { accept: "application/json" } });
    if (r.status === 429) {
      await sleep(1500 * (i + 1));
      continue;
    }
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.json();
  }
  throw new Error(`rate limited: ${path}`);
}

type Hit = { victim: string; token: string; amount: number; usd: number | null; tx: string; at: string };
const lc = (s: string) => s.toLowerCase();

async function pullsIn(txHash: string, operator: string, at: string): Promise<Hit[]> {
  const t = await get(`/transactions/${txHash}/token-transfers`);
  const out: Hit[] = [];
  for (const x of t.items ?? []) {
    const from = lc(x.from?.hash ?? "");
    if (!from || from === operator || from === "0x0000000000000000000000000000000000000000") continue;
    if (x.from?.is_contract) continue; // pools, routers: not a victim
    const dec = Number(x.total?.decimals ?? x.token?.decimals ?? 18);
    const amount = Number(x.total?.value ?? 0) / 10 ** dec;
    const rate = x.token?.exchange_rate != null ? Number(x.token.exchange_rate) : null;
    out.push({ victim: from, token: x.token?.symbol ?? "?", amount, usd: rate != null ? amount * rate : null, tx: txHash, at });
  }
  return out;
}

const seed = await get(`/transactions/${hash}`);
const operator = lc(seed.from.hash);
const target = lc(seed.to?.hash ?? "");
console.log(`chain     ${ch.name}`);
console.log(`seed tx   ${hash}  (${seed.method ?? "call"} on ${seed.to?.name ?? target})`);
console.log(`operator  ${operator}  (signed the drain)`);

const hits: Hit[] = await pullsIn(hash, operator, seed.timestamp);

// Walk the operator's other transactions.
let next: any = null;
let seen = 1;
outer: while (seen < MAX) {
  const qs = next ? "?" + new URLSearchParams(next).toString() : "";
  const page = await get(`/addresses/${operator}/transactions${qs}`);
  for (const tx of page.items ?? []) {
    if (seen >= MAX) break outer;
    if (lc(tx.from?.hash ?? "") !== operator || tx.hash === hash || tx.status !== "ok") continue;
    seen++;
    try {
      hits.push(...(await pullsIn(tx.hash, operator, tx.timestamp)));
    } catch (e) {
      console.error("skip", tx.hash, (e as Error).message);
    }
    await sleep(250);
  }
  next = page.next_page_params;
  if (!next) break;
}

const byVictim = new Map<string, { usd: number; tokens: Set<string>; txs: number; last: string }>();
for (const h of hits) {
  const v = byVictim.get(h.victim) ?? { usd: 0, tokens: new Set(), txs: 0, last: h.at };
  v.usd += h.usd ?? 0;
  v.tokens.add(h.token);
  v.txs++;
  if (h.at > v.last) v.last = h.at;
  byVictim.set(h.victim, v);
}
const rows = [...byVictim.entries()].sort((a, b) => b[1].usd - a[1].usd);

console.log(`\nscanned ${seen} operator tx · ${rows.length} victim wallet(s)\n`);
console.log("victim                                      ≈ USD now    tokens            pulls  last");
for (const [addr, v] of rows) {
  console.log(`${addr}  ${("$" + Math.round(v.usd).toLocaleString("en-US")).padStart(11)}  ${[...v.tokens].join(",").slice(0, 16).padEnd(16)}  ${String(v.txs).padStart(5)}  ${v.last.slice(0, 10)}`);
}
if (rows.length) console.log(`\nRun these through Postmortem on ${ch.key}, biggest first. Same operator, so run 2 onward shows the record.`);
else console.log("\nNo pulls found from this operator's recent transactions. Try a larger [max txs] or another seed tx.");
