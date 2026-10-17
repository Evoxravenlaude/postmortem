import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db, graphName } from "../src/graph/db.js";
import { runTool } from "../src/tools/index.js";
import { ATTACKER, DRAINER, EXCHANGE, ROUTER, T, USDC, W, fakeFetch } from "./fixtures.js";

process.env.GRAPH_PREFIX = "pmtest";
process.env.FALKORDB_URL ??= "redis://127.0.0.1:6390";

let up = false;
const fx = fakeFetch();
const ctx = { fetchImpl: fx.fn as any, now: () => T(9000) };

beforeAll(async () => {
  try {
    const d = await db();
    if ((await d.list()).includes(graphName("ethereum"))) await d.selectGraph(graphName("ethereum")).delete();
    up = true;
  } catch {
    up = false;
  }
});
afterAll(async () => {
  if (up) await closeDb();
});

describe("postmortem tools on a local FalkorDB", () => {
  it("loads the wallet into the graph", async (t) => {
    if (!up) return t.skip();
    const r = await runTool("load_wallet", { chain: "ethereum", address: W }, ctx);
    const d = r.data as any;
    expect(d.transfers).toBe(5); // 4 token transfers + 1 native send
    expect(d.approvals).toBe(2);
    expect(d.pulledLookups).toBe(1);
    expect(d.coverageFrom).toBe(0);
  });

  it("classifies every outflow by walking the graph", async (t) => {
    if (!up) return t.skip();
    const r = await runTool("explain_outflows", { chain: "ethereum", address: W }, ctx);
    const d = r.data as any;
    expect(Object.keys(d.totals).sort()).toEqual(["pulled by approval", "sent", "swap"]);
    expect(d.totals["swap"].bySymbol.USDC).toBe(100);
    expect(d.totals["sent"].bySymbol.ETH).toBeCloseTo(0.1);
    const pull = d.pulls[0];
    expect(pull.amount).toBe(900);
    expect(pull.signer).toBe(ATTACKER);
    expect(pull.approval.spender).toBe(DRAINER);
    expect(pull.approval.unlimited).toBe(true);
    expect(r.evidence.paths[0].edges.map((e) => e.type).sort()).toEqual(["APPROVED", "SENT"]);
    expect(d.gas.txs).toBe(4);
  });

  it("scores the blast radius with live allowances", async (t) => {
    if (!up) return t.skip();
    const r = await runTool("who_can_spend", { chain: "ethereum", address: W }, ctx);
    const items = (r.data as any).approvals;
    const drainer = items.find((i: any) => i.spender === DRAINER);
    const router = items.find((i: any) => i.spender === ROUTER);
    expect(drainer.risk).toBe("high");
    expect(drainer.atRisk).toBe(50);
    expect(drainer.reasons.join(" ")).toMatch(/unlimited/);
    expect(drainer.reasons.join(" ")).toMatch(/pulled 900 USDC/);
    expect(router.allowance).toBe("400000000");
    expect(["low", "medium"]).toContain(router.risk);
  });

  it("follows the money to where it rests, expanding the graph as it goes", async (t) => {
    if (!up) return t.skip();
    const r = await runTool("trace_funds", { chain: "ethereum", address: W, token: USDC, hops: 2 }, ctx);
    const ends = (r.data as any).ends;
    expect(ends.some((e: any) => e.addr === EXCHANGE && e.tags?.includes("Binance 14") && e.hops === 2)).toBe(true);
    expect(fx.calls.some((c) => c.includes(`/addresses/${ATTACKER}/token-transfers`))).toBe(true);
  });

  it("finds the shortest connection between two addresses", async (t) => {
    if (!up) return t.skip();
    const r = await runTool("connection_path", { chain: "ethereum", from: W, to: EXCHANGE }, ctx);
    expect((r.data as any).hops).toBe(1); // the exchange funded the wallet directly
  });

  it("acts: drafts revoke transactions and records them in the graph", async (t) => {
    if (!up) return t.skip();
    const r = await runTool("plan_revokes", { chain: "ethereum", address: W }, ctx);
    const acts = (r.data as any).actions;
    const d = acts.find((a: any) => a.spender === DRAINER);
    expect(d.tx.to).toBe(USDC);
    expect(d.tx.data).toBe("0x095ea7b3" + DRAINER.slice(2).padStart(64, "0") + "0".repeat(64));
    expect(r.evidence.paths[0].edges.some((e) => e.type === "REVOKES")).toBe(true);
  });

  it("writes the postmortem and saves it as a Report node", async (t) => {
    if (!up) return t.skip();
    const r = await runTool("write_postmortem", { chain: "ethereum", address: W }, ctx);
    const md = (r.data as any).markdown as string;
    expect(md).toMatch(/Pulled without the wallet signing/);
    expect(md).toMatch(/approve\(spender, 0\)/);
    const q = await runTool("query_graph", { chain: "ethereum", cypher: "MATCH (:Address {addr:'" + W + "'})-[:HAS_REPORT]->(r:Report) RETURN count(r) AS n" }, ctx);
    expect((q.data as any).rows[0].n).toBe(1);
  });

  it("refuses writes through the open query tool", async (t) => {
    if (!up) return t.skip();
    await expect(runTool("query_graph", { chain: "ethereum", cypher: "MATCH (n) DETACH DELETE n" }, ctx)).rejects.toThrow(/read-only/);
  });
});
