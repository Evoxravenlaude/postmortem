import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db, graphName } from "../src/graph/db.js";
import { runTool } from "../src/tools/index.js";
import { DRAINER, ROUTER, SPAM, T, W, fakeFetch } from "./fixtures.js";

process.env.GRAPH_PREFIX = "pmresil";
process.env.FALKORDB_URL ??= "redis://127.0.0.1:6390";

let up = false;
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

describe("explorer failures on busy wallets", () => {
  it("keeps loading when internal transfers time out, and says so", async (t) => {
    if (!up) return t.skip();
    const r = await runTool("load_wallet", { chain: "ethereum", address: W }, { fetchImpl: fakeFetch({ internalFails: true }).fn as any, now: () => T(9000) });
    const d = r.data as any;
    expect(d.transfers).toBe(5);
    expect(d.warnings.join(" ")).toMatch(/internal transfers skipped: Blockscout 524/);
    expect(r.summary).toMatch(/Note: internal transfers skipped/);
  });

  it("keeps the pages it got when a later page fails, and marks the history as partial", async (t) => {
    if (!up) return t.skip();
    const r = await runTool("load_wallet", { chain: "ethereum", address: W }, { fetchImpl: fakeFetch({ txPage2Fails: true }).fn as any, now: () => T(9000) });
    const d = r.data as any;
    expect(d.txs).toBe(3);
    expect(d.complete.txs).toBe(false);
    expect(d.coverageFrom).toBeGreaterThan(0);
    expect(d.warnings.join(" ")).toMatch(/transactions stopped early/);
  });

  it("does not call a spam token's fake transfer a pull, or a verified router with nothing at risk high risk", async (t) => {
    if (!up) return t.skip();
    const ctx = { fetchImpl: fakeFetch({ withSpam: true }).fn as any, now: () => T(400 * 86400) };
    await runTool("load_wallet", { chain: "ethereum", address: W }, ctx);
    const out = (await runTool("explain_outflows", { chain: "ethereum", address: W }, ctx)).data as any;
    expect(out.totals["unpriced token moved by others (often spam)"].events).toBe(1);
    expect(out.pulls.every((p: any) => p.symbol !== "FREEMOON")).toBe(true);
    expect(out.totals["pulled by approval"].bySymbol.USDC).toBe(900);
    const exp = (await runTool("who_can_spend", { chain: "ethereum", address: W }, ctx)).data as any;
    const routerSpam = exp.approvals.find((a: any) => a.spender === ROUTER && a.token === SPAM);
    expect(routerSpam.unlimited).toBe(true);
    expect(routerSpam.risk).toBe("low");
    expect(exp.approvals.find((a: any) => a.spender === DRAINER).risk).toBe("high");
  });
});
