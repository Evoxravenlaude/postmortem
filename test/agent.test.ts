import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ask } from "../src/agent/agent.js";
import { autopilot } from "../src/agent/autopilot.js";
import type { ChatFn } from "../src/agent/llm.js";
import { closeDb, db, graphName } from "../src/graph/db.js";
import { createMcpServer } from "../src/mcp.js";
import { DRAINER, T, W, fakeFetch } from "./fixtures.js";

process.env.GRAPH_PREFIX = "pmagent";
process.env.FALKORDB_URL ??= "redis://127.0.0.1:6390";

let up = false;
const ctx = { fetchImpl: fakeFetch().fn as any, now: () => T(9000) };

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

describe("agent", () => {
  it("autopilot lets the graph pick the route: a pull triggers a trace, a risky approval triggers revokes", async (t) => {
    if (!up) return t.skip();
    const { steps, answer } = await autopilot("ethereum", W, ctx);
    expect(steps.map((s) => s.tool)).toEqual(["load_wallet", "wallet_overview", "explain_outflows", "trace_funds", "who_can_spend", "plan_revokes", "write_postmortem"]);
    expect(steps.every((s) => !s.error)).toBe(true);
    expect(answer).toMatch(/# Postmortem/);
  });

  it("runs the LLM's tool calls and fills in the wallet and chain", async (t) => {
    if (!up) return t.skip();
    const script = [
      { content: "Checking who can spend.", tool_calls: [{ id: "1", type: "function" as const, function: { name: "who_can_spend", arguments: "{}" } }] },
      { content: "The drainer contract still has an unlimited USDC approval." },
    ];
    const seen: number[] = [];
    const chat: ChatFn = async (messages) => {
      seen.push(messages.length);
      return script.shift()!;
    };
    const r = await ask({ chain: "ethereum", address: W, question: "who can still spend my tokens?" }, chat, ctx);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].args).toMatchObject({ chain: "ethereum", address: W });
    expect((r.steps[0].data as any).approvals.some((a: any) => a.spender === DRAINER && a.risk === "high")).toBe(true);
    expect(r.answer).toMatch(/unlimited/);
    expect(seen).toEqual([2, 4]); // system+user, then + assistant tool call + tool result
  });

  it("serves the same tools over MCP", async (t) => {
    if (!up) return t.skip();
    const server = createMcpServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(b);
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name)).toContain("explain_outflows");
    const res: any = await client.callTool({ name: "query_graph", arguments: { chain: "ethereum", cypher: "MATCH (a:Address {wallet:true}) RETURN count(a) AS n" } });
    expect(JSON.parse(res.content[0].text).data.rows[0].n).toBe(1);
    await client.close();
  });
});
