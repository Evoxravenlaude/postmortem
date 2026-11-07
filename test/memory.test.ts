import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MEMORY_LEDGER = join(mkdtempSync(join(tmpdir(), "pm-mem-")), "ledger.json");
delete process.env.MEMWAL_PRIVATE_KEY;
delete process.env.TATUM_API_KEY;

const mem = await import("../src/memory/memwal.js");
const tools = await import("../src/tools/index.js");

const DRAINER = "0x1111111111111111111111111111111111111111";
const DEX = "0x2222222222222222222222222222222222222222";

describe("Walrus Memory layer (mock)", () => {
  beforeEach(() => mem._reset());

  it("renders a record as a sentence plus exact JSON, and parses it back", () => {
    const rec = { kind: "counterparty" as const, chain: "ethereum", wallet: "0xabc", address: DRAINER, verdict: "pulled" as const, pulls: 2, symbol: "USDC", at: "2026-11-07T00:00:00Z" };
    const text = mem.render(rec);
    expect(text.split("\n")[0]).toMatch(/Counterparty 0x1111.*verdict pulled.*2 tx/);
    expect(mem.parse(text)).toEqual(rec);
  });

  it("remembers and recalls a counterparty record, scoring credibility from the record", async () => {
    const at = "2026-11-07T00:00:00Z";
    await mem.remember(mem.NS.counterparties, { kind: "counterparty", chain: "ethereum", wallet: "0xaaa", address: DRAINER, verdict: "pulled", pulls: 1, pulled_usd: 900, symbol: "USDC", at });
    await mem.remember(mem.NS.counterparties, { kind: "counterparty", chain: "ethereum", wallet: "0xbbb", address: DRAINER, verdict: "pulled", pulls: 1, pulled_usd: 300, symbol: "USDT", at });
    await mem.remember(mem.NS.counterparties, { kind: "counterparty", chain: "ethereum", wallet: "0xaaa", address: DEX, verdict: "low", symbol: "USDC", at });
    const bad = await mem.recordOf(DRAINER);
    expect(bad.seen).toBe(2);
    expect(bad.wallets).toHaveLength(2);
    expect(bad.pulls).toBe(2);
    expect(bad.credibility).toBeLessThan(20);
    const ok = await mem.recordOf(DEX);
    expect(ok.seen).toBe(1);
    expect(ok.credibility).toBeGreaterThan(90);
    const none = await mem.recordOf("0x3333333333333333333333333333333333333333");
    expect(none.seen).toBe(0);
    expect(none.credibility).toBe(100);
  });

  it("keeps a local ledger of writes with blob ids", async () => {
    await mem.remember(mem.NS.incidents, { kind: "incident", chain: "base", wallet: "0xccc", reasons: ["x pulled 1 ETH"], at: "2026-11-07T00:00:00Z" });
    const l = mem.ledger();
    expect(l.length).toBeGreaterThan(0);
    expect(l[0].blob_id).toBeTruthy();
    expect(l[0].mode).toBe("mock");
  });

  it("check_record and memory_ledger are tools the agent and MCP clients can call", async () => {
    await mem.remember(mem.NS.counterparties, { kind: "counterparty", chain: "ethereum", wallet: "0xaaa", address: DRAINER, verdict: "tagged", reasons: ["spender tagged: phish"], at: "2026-11-07T00:00:00Z" });
    const r = await tools.runTool("check_record", { address: DRAINER });
    expect(r.summary).toMatch(/has a record/);
    expect((r.data as any).credibility).toBeLessThan(70);
    const l = await tools.runTool("memory_ledger", {});
    expect((l.data as any).total).toBeGreaterThan(0);
    expect(tools.TOOLS.map((t) => t.name)).toContain("check_record");
  });

  it("stamps records with the chain block only when Tatum is configured", async () => {
    const e = await mem.remember(mem.NS.incidents, { kind: "incident", chain: "ethereum", wallet: "0xddd", reasons: [], at: "2026-11-07T00:00:00Z" });
    expect(e.block).toBeNull();
  });

  it("reads the block stamp through the Tatum gateway with the key header", async () => {
    process.env.TATUM_API_KEY = "test-key";
    const { blockStamp } = await import("../src/sources/tatum.js");
    let seen: any = null;
    const fake = (async (url: string, init: any) => {
      seen = { url, key: init.headers["x-api-key"], body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1923cd9" }), { status: 200 });
    }) as any;
    expect(await blockStamp("base", fake)).toBe(26361049);
    expect(seen.url).toBe("https://base-mainnet.gateway.tatum.io/");
    expect(seen.key).toBe("test-key");
    expect(seen.body.method).toBe("eth_blockNumber");
    expect(await blockStamp("solana", fake)).toBeNull();
    delete process.env.TATUM_API_KEY;
  });

  it("follows the payout wallet when the drainer rotates spender contracts", async () => {
    const FEE = "0x4444444444444444444444444444444444444444";
    const at = "2026-11-07T00:00:00Z";
    // Two victims, two different fresh spender contracts, one fee wallet.
    await mem.remember(mem.NS.counterparties, { kind: "counterparty", role: "spender", chain: "ethereum", wallet: "0xv1", address: "0x5555555555555555555555555555555555555555", verdict: "pulled", pulls: 1, at });
    await mem.remember(mem.NS.counterparties, { kind: "counterparty", role: "payout", chain: "ethereum", wallet: "0xv1", address: FEE, verdict: "pulled", symbol: "USDT", at });
    await mem.remember(mem.NS.counterparties, { kind: "counterparty", role: "spender", chain: "ethereum", wallet: "0xv2", address: "0x6666666666666666666666666666666666666666", verdict: "pulled", pulls: 1, at });
    await mem.remember(mem.NS.counterparties, { kind: "counterparty", role: "payout", chain: "ethereum", wallet: "0xv2", address: FEE, verdict: "pulled", symbol: "WBTC", at });
    const r = await mem.recordOf(FEE);
    expect(r.wallets).toEqual(["0xv1", "0xv2"]);
    expect(r.roles.payout).toBe(2);
    expect(r.summary).toMatch(/received pulled funds from 2 drained wallet/);
    expect(r.credibility).toBeLessThan(20);
    expect(mem.render({ kind: "counterparty", role: "payout", chain: "ethereum", wallet: "0xv1", address: FEE, verdict: "pulled", symbol: "USDT", at }).split("\n")[0]).toMatch(/received USDT pulled from wallet 0xv1/);
  });
});
