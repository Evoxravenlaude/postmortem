import { z } from "zod";
import { chainOf } from "../chains.js";
import { Q, graphFor } from "../graph/db.js";
import { expandOutflows, loadWallet } from "../graph/ingest.js";
import { mergeViews, pathView } from "../graph/paths.js";
import type { FetchLike } from "../sources/blockscout.js";
import { PERMIT2, Rpc } from "../sources/rpc.js";
import type { PathView, ToolResult } from "../types.js";
import { fmtAmount, fmtUsd, isAddress, isoOf, lc, pad32, short, toUnits } from "../util.js";

export interface ToolCtx {
  fetchImpl?: FetchLike;
  now?: () => number; // unix seconds
}

export interface Tool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  shape: S;
  run: (args: z.infer<z.ZodObject<S>>, ctx: ToolCtx) => Promise<ToolResult>;
}

function defineTool<S extends z.ZodRawShape>(t: Tool<S>): Tool<S> {
  return t;
}

const chain = z.string().describe("Chain key: ethereum, base, arbitrum, optimism, polygon or gnosis");
const address = z.string().describe("0x wallet address");
const nowOf = (ctx: ToolCtx) => (ctx.now ? ctx.now() : Math.floor(Date.now() / 1000));

function need(a: string, what = "address"): string {
  if (!isAddress(a)) throw new Error(`${what} must be a 0x address, got "${a}"`);
  return lc(a);
}

async function q(chainKey: string) {
  return new Q(await graphFor(chainOf(chainKey).key));
}

async function walletOrThrow(qq: Q, w: string) {
  const [row] = await qq.ro<{ w: any }>(`MATCH (w:Address {addr:$w}) WHERE w.wallet = true RETURN w`, { w });
  if (!row) throw new Error(`Wallet ${w} is not loaded yet. Call load_wallet first.`);
  return row.w.properties as Record<string, any>;
}

// ---------------------------------------------------------------- load_wallet
const load_wallet = defineTool({
  name: "load_wallet",
  description:
    "Fetch a wallet's on-chain history (token transfers, native transfers, transactions, approvals, balances) and write it into the FalkorDB graph. Call this before any other tool for a new wallet.",
  shape: { chain, address, pages: z.number().int().min(1).max(40).optional().describe("Pages of 50 items per list (default 6)") },
  async run({ chain: c, address: a, pages }, ctx) {
    const r = await loadWallet(c, need(a), { pages, fetchImpl: ctx.fetchImpl });
    const cov = r.coverageFrom ? `back to ${isoOf(r.coverageFrom).slice(0, 10)}` : "full history";
    return {
      summary:
        `Loaded ${r.transfers} movements, ${r.txs} transactions, ${r.approvals} approvals and ${r.holdings} balances for ${short(r.wallet)} on ${r.chain} (${cov}). Looked up the signer of ${r.pulledLookups} outflows the wallet did not sign.` +
        (r.warnings.length ? ` Note: ${r.warnings.join("; ")}.` : ""),
      data: r,
      evidence: { cypher: r.cypher.slice(0, 12), paths: [] },
    };
  },
});

// ---------------------------------------------------------------- wallet_overview
const wallet_overview = defineTool({
  name: "wallet_overview",
  description: "Summarise a loaded wallet: activity window, current holdings, and its most important counterparties ranked by PageRank over the money graph.",
  shape: { chain, address },
  async run({ chain: c, address: a }) {
    const w = need(a);
    const qq = await q(c);
    const wp = await walletOrThrow(qq, w);
    const [act] = await qq.ro<{ n: number; first: number; last: number }>(
      `MATCH (w:Address {addr:$w})-[s:SENT]-() RETURN count(s) AS n, min(s.ts) AS first, max(s.ts) AS last`,
      { w },
    );
    const holds = await qq.ro<{ sym: string; amt: number; usd: number | null }>(
      `MATCH (w:Address {addr:$w})-[h:HOLDS]->(t:Token) WHERE h.amount > 0 RETURN t.symbol AS sym, h.amount AS amt, h.usdNow AS usd ORDER BY coalesce(h.usdNow, 0) DESC LIMIT 12`,
      { w },
    );
    const ranked = await qq.ro<{ node: any; score: number; links: number; volume: number | null }>(
      `CALL algo.pageRank('Address', 'SENT') YIELD node, score
       MATCH (w:Address {addr:$w})-[r:SENT]-(node)
       RETURN node, score, count(r) AS links, sum(r.usdNow) AS volume ORDER BY score DESC LIMIT 8`,
      { w },
    );
    const top = await qq.ro<{ p: any }>(
      `MATCH p=(w:Address {addr:$w})-[r:SENT]-(o:Address) WITH p, r ORDER BY coalesce(r.usdNow, 0) DESC LIMIT 12 RETURN p`,
      { w },
    );
    const view = mergeViews("Largest movements around this wallet", top.map((t) => pathView("", t.p)));
    const totalUsd = holds.reduce((s, h) => s + (h.usd ?? 0), 0);
    const counterparties = ranked.map((r) => ({
      addr: r.node.properties.addr,
      name: r.node.properties.name ?? r.node.properties.ens ?? r.node.properties.tags?.[0] ?? null,
      tags: r.node.properties.tags ?? null,
      pagerank: Number(r.score.toFixed(4)),
      links: r.links,
      volumeUsdNow: r.volume,
    }));
    return {
      summary:
        `${short(w)}: ${act?.n ?? 0} movements between ${act?.first ? isoOf(act.first).slice(0, 10) : "?"} and ${act?.last ? isoOf(act.last).slice(0, 10) : "?"}. ` +
        `Holds ${holds.length} assets worth about ${fmtUsd(totalUsd)} at today's prices. ` +
        `Most central counterparties: ${counterparties.slice(0, 3).map((c2) => c2.name ?? short(c2.addr)).join(", ") || "none"}.`,
      data: { wallet: w, coverageFrom: wp.coverageFrom ?? 0, activity: act, holdings: holds, counterparties },
      evidence: { cypher: qq.log, paths: view.nodes.length ? [view] : [] },
    };
  },
});

// ---------------------------------------------------------------- explain_outflows
type Cause = "swap" | "sent" | "contract call" | "pulled by approval" | "pulled (signer not looked up)" | "older than loaded history";

const explain_outflows = defineTool({
  name: "explain_outflows",
  description:
    "Explain why money left the wallet. Every outflow is classified by walking the graph: swap (the same transaction paid something back), sent or contract call (the wallet signed it), or pulled by approval (someone else signed it and an earlier APPROVED edge let them). Returns totals per cause, the biggest events, and the approval path behind each pull. Also totals gas.",
  shape: {
    chain,
    address,
    token: z.string().optional().describe("Token contract address, or 'native'. Omit for all assets."),
    since: z.string().optional().describe("ISO date, e.g. 2026-09-01"),
    until: z.string().optional().describe("ISO date"),
  },
  async run({ chain: c, address: a, token, since, until }, ctx) {
    const w = need(a);
    const qq = await q(c);
    const wp = await walletOrThrow(qq, w);
    const from = since ? Math.floor(Date.parse(since) / 1000) : 0;
    const to = until ? Math.floor(Date.parse(until) / 1000) + 86399 : nowOf(ctx);
    const tok = token ? lc(token) : null;
    const rows = await qq.ro<{ s: any; d: any; back: number; ap: any; sp: any }>(
      `MATCH (w:Address {addr:$w})-[s:SENT]->(d:Address)
       WHERE ($tok IS NULL OR s.token = $tok) AND s.ts >= $from AND s.ts <= $to
       OPTIONAL MATCH (d)-[b:SENT]->(w) WHERE b.tx = s.tx
       WITH w, s, d, count(b) AS back
       OPTIONAL MATCH (w)-[ap:APPROVED]->(sp:Address) WHERE ap.token = s.token AND s.by <> $w AND (sp.addr = s.via OR sp.addr = s.by)
       RETURN s, d, back, ap, sp ORDER BY s.ts DESC LIMIT 2000`,
      { w, tok, from, to },
    );
    const cov = Number(wp.coverageFrom ?? 0);
    const seenKeys = new Set<string>();
    const uniqRows = rows.filter((r) => {
      const k = String(r.s.properties.key);
      if (seenKeys.has(k)) return false;
      seenKeys.add(k);
      return true;
    });
    const events = uniqRows.map((r) => {
      const s = r.s.properties;
      let cause: Cause;
      if (s.by === w || s.kind === "native") cause = r.back > 0 ? "swap" : r.d.properties.isContract ? "contract call" : "sent";
      else if (s.by) cause = "pulled by approval";
      else if (s.ts >= cov) cause = "pulled (signer not looked up)";
      else cause = "older than loaded history";
      return {
        cause,
        tx: s.tx,
        ts: s.ts,
        when: isoOf(s.ts),
        symbol: s.symbol,
        token: s.token,
        amount: s.amount,
        usdNow: s.usdNow ?? null,
        to: r.d.properties.addr,
        toName: r.d.properties.name ?? r.d.properties.ens ?? r.d.properties.tags?.[0] ?? null,
        signer: s.by ?? null,
        calledContract: s.via ?? null,
        approval: r.ap
          ? { spender: r.sp.properties.addr, spenderName: r.sp.properties.name ?? null, grantedAt: isoOf(r.ap.properties.ts), grantTx: r.ap.properties.tx, unlimited: r.ap.properties.unlimited }
          : null,
      };
    });
    const totals: Record<string, { events: number; usdNow: number; bySymbol: Record<string, number> }> = {};
    for (const e of events) {
      const t = (totals[e.cause] ??= { events: 0, usdNow: 0, bySymbol: {} });
      t.events++;
      t.usdNow += e.usdNow ?? 0;
      t.bySymbol[e.symbol] = (t.bySymbol[e.symbol] ?? 0) + e.amount;
    }
    const [gas] = await qq.ro<{ fee: number; n: number }>(
      `MATCH (x:Tx {from:$w}) WHERE x.ts >= $from AND x.ts <= $to RETURN count(x) AS n, sum(toFloat(x.feeRaw)) AS fee`,
      { w, from, to },
    );
    const gasNative = (gas?.fee ?? 0) / 1e18;

    // The proof for each pull: the approval that allowed it, then the movement itself.
    const pulls = events.filter((e) => e.cause === "pulled by approval").slice(0, 6);
    const views: PathView[] = [];
    for (const p of pulls) {
      const ps = await qq.ro<{ p1: any; p2: any }>(
        `MATCH p1=(w:Address {addr:$w})-[ap:APPROVED]->(sp:Address {addr:$sp}) WHERE ap.token = $tok
         MATCH p2=(w)-[s:SENT]->(d:Address {addr:$d}) WHERE s.tx = $tx
         RETURN p1, p2 LIMIT 1`,
        { w, sp: p.approval?.spender ?? "", tok: p.token, d: p.to, tx: p.tx },
      );
      if (ps[0]) views.push(mergeViews(`${fmtAmount(p.amount)} ${p.symbol} pulled on ${p.when.slice(0, 10)}`, [pathView("", ps[0].p1), pathView("", ps[0].p2)]));
    }
    const biggest = [...events].sort((x, y) => (y.usdNow ?? 0) - (x.usdNow ?? 0)).slice(0, 15);
    const parts = Object.entries(totals)
      .sort((x, y) => y[1].usdNow - x[1].usdNow)
      .map(([k, v]) => `${k}: ${v.events} events, ${fmtUsd(v.usdNow)} at today's prices`);
    return {
      summary:
        events.length === 0
          ? `No outflows from ${short(w)} in that window.`
          : `${events.length} outflows from ${short(w)}. ${parts.join("; ")}. Gas: ${fmtAmount(gasNative)} ${chainOf(c).native} across ${gas?.n ?? 0} signed transactions.` +
            (pulls.length ? ` ${pulls.length} pull(s) trace back to an approval; see the paths.` : ""),
      data: { window: { from: isoOf(from), to: isoOf(to) }, totals, gas: { native: gasNative, txs: gas?.n ?? 0 }, biggest, pulls: events.filter((e) => e.cause.startsWith("pulled")) },
      evidence: { cypher: qq.log, paths: views },
    };
  },
});

// ---------------------------------------------------------------- who_can_spend
const who_can_spend = defineTool({
  name: "who_can_spend",
  description:
    "Blast radius: every contract or account the wallet has approved to move its tokens, with the live allowance (checked on-chain), what is at risk right now, whether the spender has pulled funds before, when the wallet last used it, and a risk score with reasons.",
  shape: { chain, address, check_live: z.boolean().optional().describe("Re-check allowances on-chain (default true)") },
  async run({ chain: c, address: a, check_live }, ctx) {
    const w = need(a);
    const ch = chainOf(c);
    const qq = await q(c);
    await walletOrThrow(qq, w);
    const rows = await qq.ro<{ ap: any; sp: any; t: any; h: any }>(
      `MATCH (w:Address {addr:$w})-[ap:APPROVED]->(sp:Address)
       OPTIONAL MATCH (t:Token {addr:ap.token})
       OPTIONAL MATCH (w)-[h:HOLDS]->(t)
       RETURN ap, sp, t, h`,
      { w },
    );
    const uses = await qq.ro<{ sp: string; last: number }>(`MATCH (w:Address {addr:$w})-[c:CALLED]->(sp:Address) RETURN sp.addr AS sp, max(c.ts) AS last`, { w });
    const lastUse = new Map(uses.map((u) => [u.sp, u.last]));
    const pullsRows = await qq.ro<{ sp: string; tok: string; n: number; amt: number }>(
      `MATCH (w:Address {addr:$w})-[s:SENT]->() WHERE s.by IS NOT NULL AND s.by <> $w
       RETURN coalesce(s.via, s.by) AS sp, s.token AS tok, count(s) AS n, sum(s.amount) AS amt`,
      { w },
    );
    const pulls = new Map(pullsRows.map((p) => [`${p.sp}|${p.tok}`, p]));
    const rpc = new Rpc(ch.rpc, ctx.fetchImpl);
    const live = check_live !== false;
    const now = nowOf(ctx);

    const items = [] as any[];
    for (const r of rows) {
      const ap = r.ap.properties;
      const sp = r.sp.properties;
      const tok = r.t?.properties ?? { addr: ap.token, symbol: ap.symbol, decimals: ap.decimals ?? 18 };
      let current: string | null = ap.raw;
      let checked = false;
      if (live) {
        if (ap.kind === "all") {
          const ok = await rpc.isApprovedForAll(ap.token, w, sp.addr);
          if (ok !== null) (current = ok ? "1" : "0"), (checked = true);
        } else if (ap.kind === "permit2") {
          const v = await rpc.permit2Allowance(w, ap.token, sp.addr);
          if (v !== null) (current = v), (checked = true);
        } else {
          const v = await rpc.allowance(ap.token, w, sp.addr);
          if (v !== null) (current = v), (checked = true);
        }
      }
      const active = current !== "0";
      const decimals = Number(tok.decimals ?? 18);
      const bal = r.h?.properties.amount ?? 0;
      const allow = ap.kind === "all" ? Infinity : current ? toUnits(current, decimals) : 0;
      const atRisk = active ? Math.min(bal, allow) : 0;
      const price = tok.priceUsd ?? null;
      const tags: string[] = sp.tags ?? [];
      const reasons: string[] = [];
      let score = 0;
      const unlimited = ap.kind === "all" ? active : current ? BigInt(current) >= 2n ** 128n : false;
      if (unlimited) (score += 3), reasons.push("unlimited approval");
      if (sp.isContract === false) (score += 3), reasons.push("spender is a plain account, not a contract");
      else if (sp.verified === false) (score += 2), reasons.push("spender contract is not verified");
      if (tags.some((t) => /phish|scam|exploit|drain|hack/i.test(t))) (score += 5), reasons.push(`spender tagged: ${tags.join(", ")}`);
      const last = lastUse.get(sp.addr);
      if (!last || now - last > 90 * 86400) (score += 1), reasons.push(last ? `unused for ${Math.floor((now - last) / 86400)} days` : "never called by this wallet");
      const pulled = pulls.get(`${sp.addr}|${ap.token}`);
      if (pulled) reasons.push(`has pulled ${fmtAmount(pulled.amt)} ${tok.symbol} in ${pulled.n} tx before`);
      if (atRisk > 0) reasons.push(`${fmtAmount(atRisk)} ${tok.symbol} reachable now`);
      const level = !active ? "revoked" : score >= 4 ? "high" : score >= 2 ? "medium" : "low";
      items.push({
        spender: sp.addr, spenderName: sp.name ?? sp.tags?.[0] ?? null, token: ap.token, symbol: tok.symbol, kind: ap.kind,
        grantedAt: isoOf(ap.ts), grantTx: ap.tx, allowance: current, liveChecked: checked, active, unlimited,
        balance: bal, atRisk, atRiskUsd: price != null && Number.isFinite(atRisk) ? atRisk * price : null, lastUsed: last ? isoOf(last) : null,
        risk: level, score, reasons,
      });
      if (checked)
        await qq.rw(
          `MATCH (:Address {addr:$w})-[ap:APPROVED {token:$tok, kind:$kind}]->(:Address {addr:$sp}) SET ap.current = $cur, ap.active = $act, ap.checkedAt = $now, ap.risk = $risk, ap.score = $score`,
          { w, tok: ap.token, kind: ap.kind, sp: sp.addr, cur: current, act: active, now, risk: level, score },
        );
    }
    const order: Record<string, number> = { high: 0, medium: 1, low: 2, revoked: 3 };
    items.sort((x, y) => order[x.risk] - order[y.risk] || (y.atRiskUsd ?? 0) - (x.atRiskUsd ?? 0));
    const view = await qq.ro<{ p: any }>(`MATCH p=(w:Address {addr:$w})-[ap:APPROVED]->(sp:Address) WHERE coalesce(ap.active, true) RETURN p LIMIT 25`, { w });
    const activeN = items.filter((i) => i.active).length;
    const high = items.filter((i) => i.risk === "high");
    const usd = items.reduce((s, i) => s + (i.atRiskUsd ?? 0), 0);
    return {
      summary:
        items.length === 0
          ? `${short(w)} has no approvals in the loaded history.`
          : `${activeN} active approval(s), ${high.length} high risk. About ${fmtUsd(usd)} is reachable by approved spenders right now.` +
            (high.length ? ` Highest risk: ${high.slice(0, 3).map((h) => `${h.symbol} → ${h.spenderName ?? short(h.spender)} (${h.reasons[0]})`).join("; ")}.` : "") +
            (live ? "" : " Allowances not re-checked on-chain."),
      data: { approvals: items },
      evidence: { cypher: qq.log, paths: view.length ? [mergeViews("Who can move this wallet's tokens", view.map((v) => pathView("", v.p)))] : [] },
    };
  },
});

// ---------------------------------------------------------------- trace_funds
const trace_funds = defineTool({
  name: "trace_funds",
  description:
    "Follow a token out of the wallet for up to 3 hops. The agent expands the graph as it goes (fetching where each recipient sent the token next), then returns time-ordered multi-hop paths and where the money came to rest (exchanges and named contracts are labelled).",
  shape: {
    chain,
    address,
    token: z.string().describe("Token contract address to follow"),
    hops: z.number().int().min(1).max(3).optional().describe("How far to follow (default 2)"),
    since: z.string().optional().describe("ISO date; only follow outflows after this"),
  },
  async run({ chain: c, address: a, token, hops, since }, ctx) {
    const w = need(a);
    const tok = need(token, "token");
    const depth = hops ?? 2;
    const qq = await q(c);
    await walletOrThrow(qq, w);
    const from = since ? Math.floor(Date.parse(since) / 1000) : 0;
    let frontier = await qq.ro<{ addr: string; ts: number; amt: number }>(
      `MATCH (w:Address {addr:$w})-[s:SENT]->(d:Address) WHERE s.token = $tok AND s.ts >= $from
       RETURN d.addr AS addr, min(s.ts) AS ts, sum(s.amount) AS amt ORDER BY amt DESC LIMIT 5`,
      { w, tok, from },
    );
    let expanded = 0;
    for (let hop = 1; hop < depth && frontier.length; hop++) {
      const next: typeof frontier = [];
      for (const f of frontier.slice(0, 6)) {
        if (f.addr === w) continue;
        await expandOutflows(c, f.addr, tok, f.ts, { fetchImpl: ctx.fetchImpl });
        expanded++;
        const onward = await qq.ro<{ addr: string; ts: number; amt: number }>(
          `MATCH (a:Address {addr:$a})-[s:SENT]->(d:Address) WHERE s.token = $tok AND s.ts >= $ts
           RETURN d.addr AS addr, min(s.ts) AS ts, sum(s.amount) AS amt ORDER BY amt DESC LIMIT 3`,
          { a: f.addr, tok, ts: f.ts },
        );
        next.push(...onward);
      }
      frontier = next;
    }
    const paths = await qq.ro<{ p: any; end: any; total: number }>(
      `MATCH p=(w:Address {addr:$w})-[:SENT*1..${depth}]->(e:Address)
       WITH p, e, relationships(p) AS rs
       WHERE all(r IN rs WHERE r.token = $tok) AND rs[0].ts >= $from AND all(i IN range(0, size(rs) - 2) WHERE rs[i].ts <= rs[i + 1].ts)
       RETURN p, e AS end, reduce(t = 0.0, r IN rs | t + r.amount) AS total ORDER BY length(p) DESC, total DESC LIMIT 12`,
      { w, tok, from },
    );
    const ends = paths.map((r) => ({
      addr: r.end.properties.addr,
      name: r.end.properties.name ?? r.end.properties.ens ?? null,
      tags: r.end.properties.tags ?? null,
      isContract: r.end.properties.isContract ?? null,
      hops: r.p.edges.length,
    }));
    const named = ends.filter((e) => e.name || e.tags);
    return {
      summary:
        paths.length === 0
          ? `No outflows of that token from ${short(w)} to follow.`
          : `Followed the token ${depth} hop(s) and expanded ${expanded} recipient(s). Longest path: ${paths[0].p.edges.length} hops.` +
            (named.length ? ` It reaches ${[...new Set(named.map((n) => n.name ?? n.tags?.[0]))].slice(0, 4).join(", ")}.` : " None of the end points carry an explorer label."),
      data: { ends, expanded },
      evidence: { cypher: qq.log, paths: [mergeViews("Where the token went", paths.map((r) => pathView("", r.p)))] },
    };
  },
});

// ---------------------------------------------------------------- connection_path
const connection_path = defineTool({
  name: "connection_path",
  description: "Find the shortest chain of transfers, calls or approvals linking two addresses in the graph (either direction).",
  shape: { chain, from: z.string().describe("0x address"), to: z.string().describe("0x address") },
  async run({ chain: c, from, to }) {
    const a = need(from, "from");
    const b = need(to, "to");
    const qq = await q(c);
    const run = (x: string, y: string) =>
      qq.ro<{ p: any }>(
        `MATCH (x:Address {addr:$x}), (y:Address {addr:$y}) RETURN shortestPath((x)-[:SENT|CALLED|APPROVED*1..6]->(y)) AS p`,
        { x, y },
      );
    const fwd = (await run(a, b))[0]?.p;
    const rev = (await run(b, a))[0]?.p;
    const useRev = !!rev && (!fwd || rev.edges.length < fwd.edges.length);
    const p = useRev ? rev : fwd;
    const dir = useRev ? "reverse" : "forward";
    return {
      summary: p ? `${short(a)} and ${short(b)} are ${p.edges.length} hop(s) apart (${dir === "forward" ? `${short(a)} → ${short(b)}` : `${short(b)} → ${short(a)}`}).` : `No path within 6 hops between ${short(a)} and ${short(b)} in the loaded graph.`,
      data: { hops: p ? p.edges.length : null, direction: p ? dir : null },
      evidence: { cypher: qq.log, paths: p ? [pathView("Shortest connection", p)] : [] },
    };
  },
});

// ---------------------------------------------------------------- query_graph
const WRITE = /\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP|LOAD\s+CSV|FOREACH)\b|\bCALL\s+(db|dbms)\./i;
const query_graph = defineTool({
  name: "query_graph",
  description:
    "Run a read-only Cypher query on the chain's graph for questions the other tools don't cover. Schema: (:Address {addr,name,isContract,verified,tags,wallet}) -[:SENT {tx,ts,token,symbol,amount,usdNow,kind,by,via}]-> (:Address); (:Address)-[:APPROVED {token,symbol,raw,unlimited,ts,tx,kind,active,current,risk}]->(:Address); (:Address)-[:CALLED {tx,ts,method}]->(:Address); (:Address)-[:HOLDS {amount,usdNow}]->(:Token {addr,symbol,decimals,priceUsd}); (:Tx {hash,ts,from,to,method,status,feeRaw}); (:Address)-[:PLANNED]->(:Action)-[:REVOKES]->(:Address); (:Address)-[:HAS_REPORT]->(:Report). Addresses are lowercase; ts is unix seconds. Always LIMIT.",
  shape: { chain, cypher: z.string().describe("Read-only Cypher") },
  async run({ chain: c, cypher }) {
    if (WRITE.test(cypher)) throw new Error("query_graph is read-only. Use the action tools to change the graph.");
    const qq = await q(c);
    const text = /\blimit\s+\d+/i.test(cypher) ? cypher : `${cypher} LIMIT 50`;
    const rows = await qq.ro(text);
    const views: PathView[] = [];
    const flat = rows.map((r) => {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r as Record<string, any>)) {
        if (v && typeof v === "object" && Array.isArray(v.nodes) && Array.isArray(v.edges)) {
          views.push(pathView(k, v));
          o[k] = `path of ${v.edges.length} hop(s)`;
        } else if (v && typeof v === "object" && v.properties) o[k] = v.properties;
        else o[k] = v;
      }
      return o;
    });
    return {
      summary: `${rows.length} row(s).`,
      data: { rows: flat.slice(0, 50) },
      evidence: { cypher: qq.log, paths: views.length ? [mergeViews("Query paths", views)] : [] },
    };
  },
});

// ---------------------------------------------------------------- plan_revokes (acts)
function revokeCall(kind: string, token: string, spender: string) {
  if (kind === "all") return { to: token, data: "0xa22cb465" + pad32(spender.slice(2)) + pad32("0"), fn: "setApprovalForAll(spender, false)" };
  if (kind === "permit2") return { to: PERMIT2, data: "0x87517c45" + pad32(token.slice(2)) + pad32(spender.slice(2)) + pad32("0") + pad32("0"), fn: "Permit2.approve(token, spender, 0, 0)" };
  return { to: token, data: "0x095ea7b3" + pad32(spender.slice(2)) + pad32("0"), fn: "approve(spender, 0)" };
}

const plan_revokes = defineTool({
  name: "plan_revokes",
  description:
    "Act on the blast radius: draft the exact revoke transactions (to, data, chainId) for risky approvals and record each as an (:Action) node in the graph linked to the wallet and the spender. Nothing is signed or sent; the wallet owner signs them. Uses the risk computed by who_can_spend (call it first), or the spenders you name.",
  shape: {
    chain,
    address,
    spenders: z.array(z.string()).optional().describe("Spender addresses to revoke. Omit to revoke every high and medium risk approval."),
  },
  async run({ chain: c, address: a, spenders }, ctx) {
    const w = need(a);
    const ch = chainOf(c);
    const qq = await q(c);
    await walletOrThrow(qq, w);
    const only = spenders?.map((s) => need(s, "spender"));
    const rows = await qq.ro<{ ap: any; sp: any }>(
      `MATCH (w:Address {addr:$w})-[ap:APPROVED]->(sp:Address)
       WHERE coalesce(ap.active, true) AND ($only IS NULL OR sp.addr IN $only) AND ($only IS NOT NULL OR ap.risk IN ['high', 'medium'])
       RETURN ap, sp`,
      { w, only: only ?? null },
    );
    const now = nowOf(ctx);
    const actions = [];
    for (const r of rows) {
      const ap = r.ap.properties;
      const sp = r.sp.properties;
      const call = revokeCall(ap.kind, ap.token, sp.addr);
      const id = `revoke:${ch.key}:${w}:${ap.token}:${sp.addr}:${ap.kind}`;
      await qq.rw(
        `MATCH (w:Address {addr:$w}), (sp:Address {addr:$sp})
         MERGE (x:Action {id:$id})
         SET x.kind = 'revoke', x.status = 'planned', x.createdAt = $now, x.chainId = $cid, x.to = $to, x.data = $data, x.fn = $fn,
             x.token = $tok, x.symbol = $sym, x.reason = $why
         MERGE (w)-[:PLANNED]->(x) MERGE (x)-[:REVOKES]->(sp)`,
        { w, sp: sp.addr, id, now, cid: ch.id, to: call.to, data: call.data, fn: call.fn, tok: ap.token, sym: ap.symbol ?? "?", why: ap.risk ? `${ap.risk} risk (score ${ap.score ?? "?"})` : "requested" },
      );
      actions.push({ id, spender: sp.addr, spenderName: sp.name ?? null, symbol: ap.symbol, risk: ap.risk ?? null, tx: { chainId: ch.id, to: call.to, data: call.data, value: "0" }, fn: call.fn });
    }
    const view = await qq.ro<{ p: any }>(`MATCH p=(w:Address {addr:$w})-[:PLANNED]->(:Action)-[:REVOKES]->(:Address) RETURN p LIMIT 25`, { w });
    return {
      summary: actions.length
        ? `Drafted ${actions.length} revoke transaction(s) and recorded them in the graph. Sign each from the wallet to close the exposure: ${actions.map((x) => `${x.symbol} → ${x.spenderName ?? short(x.spender)}`).join(", ")}.`
        : "Nothing to revoke: no active approval matched (run who_can_spend first to score them).",
      data: { actions },
      evidence: { cypher: qq.log, paths: view.length ? [mergeViews("Planned revokes", view.map((v) => pathView("", v.p)))] : [] },
    };
  },
});

// ---------------------------------------------------------------- write_postmortem (acts)
const write_postmortem = defineTool({
  name: "write_postmortem",
  description:
    "Write the postmortem: a markdown report of where the money went, what was pulled by approvals, what is still exposed and the planned fixes. Saves it as a (:Report) node in the graph and returns the text.",
  shape: { chain, address, title: z.string().optional() },
  async run({ chain: c, address: a, title }, ctx) {
    const w = need(a);
    const ov = await wallet_overview.run({ chain: c, address: w }, ctx);
    const out = await explain_outflows.run({ chain: c, address: w }, ctx);
    const exp = await who_can_spend.run({ chain: c, address: w, check_live: true }, ctx);
    const qq = await q(c);
    const planned = await qq.ro<{ x: any }>(`MATCH (:Address {addr:$w})-[:PLANNED]->(x:Action) WHERE x.status = 'planned' RETURN x`, { w });
    const o: any = out.data;
    const e: any = exp.data;
    const v: any = ov.data;
    const lines: string[] = [];
    lines.push(`# ${title ?? `Postmortem: ${short(w)} on ${chainOf(c).name}`}`, "");
    lines.push(`Generated ${isoOf(nowOf(ctx))}. Values marked "now" use today's prices from the explorer.`, "");
    lines.push("## What happened", "", ov.summary, "", out.summary, "");
    lines.push("## Outflows by cause", "", "| Cause | Events | Value now |", "| --- | ---: | ---: |");
    for (const [k, t] of Object.entries<any>(o.totals).sort((x: any, y: any) => y[1].usdNow - x[1].usdNow)) lines.push(`| ${k} | ${t.events} | ${fmtUsd(t.usdNow)} |`);
    lines.push("");
    const pulls = (o.pulls as any[]).slice(0, 10);
    if (pulls.length) {
      lines.push("## Pulled without the wallet signing", "");
      for (const p of pulls)
        lines.push(
          `- ${p.when.slice(0, 10)}: ${fmtAmount(p.amount)} ${p.symbol} to ${p.toName ?? short(p.to)}, tx ${short(p.tx)}` +
            (p.approval ? `. Allowed by an approval to ${p.approval.spenderName ?? short(p.approval.spender)} granted ${p.approval.grantedAt.slice(0, 10)}${p.approval.unlimited ? " (unlimited)" : ""}.` : ". No matching approval in the loaded history."),
        );
      lines.push("");
    }
    lines.push("## Still exposed", "", exp.summary, "");
    const risky = (e.approvals as any[]).filter((x) => x.risk === "high" || x.risk === "medium");
    if (risky.length) {
      lines.push("| Token | Spender | Risk | Reachable now | Why |", "| --- | --- | --- | ---: | --- |");
      for (const x of risky.slice(0, 15)) lines.push(`| ${x.symbol} | ${x.spenderName ?? short(x.spender)} | ${x.risk} | ${Number.isFinite(x.atRisk) ? fmtAmount(x.atRisk) : "all"} | ${x.reasons.join("; ")} |`);
      lines.push("");
    }
    lines.push("## Fixes", "");
    if (planned.length) for (const p of planned) lines.push(`- [ ] ${p.x.properties.fn} for ${p.x.properties.symbol}: send to \`${p.x.properties.to}\` with data \`${String(p.x.properties.data).slice(0, 18)}…\``);
    else lines.push(risky.length ? "- Run plan_revokes to draft the revoke transactions." : "- Nothing urgent.");
    lines.push("", "## Limits", "", "- Only approvals the wallet sent itself are seen; signature-based permits are not.", "- Smart-contract wallets look like every outflow was pulled, because a bundler signs.", `- History covers ${v.coverageFrom ? `back to ${isoOf(v.coverageFrom).slice(0, 10)}` : "all loaded pages"}.`);
    const md = lines.join("\n");
    const id = `report:${chainOf(c).key}:${w}:${nowOf(ctx)}`;
    await qq.rw(`MATCH (w:Address {addr:$w}) MERGE (r:Report {id:$id}) SET r.createdAt = $now, r.md = $md MERGE (w)-[:HAS_REPORT]->(r)`, { w, id, now: nowOf(ctx), md });
    return {
      summary: `Postmortem written and saved to the graph as ${id}.`,
      data: { id, markdown: md },
      evidence: { cypher: [...ov.evidence.cypher, ...out.evidence.cypher, ...exp.evidence.cypher, ...qq.log], paths: [...out.evidence.paths, ...exp.evidence.paths] },
    };
  },
});

export const TOOLS: Tool<any>[] = [load_wallet, wallet_overview, explain_outflows, who_can_spend, trace_funds, connection_path, query_graph, plan_revokes, write_postmortem];

export function toolByName(name: string): Tool<any> | undefined {
  return TOOLS.find((t) => t.name === name);
}

export async function runTool(name: string, args: unknown, ctx: ToolCtx = {}): Promise<ToolResult> {
  const t = toolByName(name);
  if (!t) throw new Error(`Unknown tool ${name}`);
  const parsed = z.object(t.shape).parse(args ?? {});
  return t.run(parsed, ctx);
}

export function jsonSchemaOf(t: Tool<any>): Record<string, unknown> {
  const s = z.toJSONSchema(z.object(t.shape)) as Record<string, unknown>;
  delete s.$schema;
  return s;
}
