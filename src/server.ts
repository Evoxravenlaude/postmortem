import { serve } from "@hono/node-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ask, type Step } from "./agent/agent.js";
import { autopilot } from "./agent/autopilot.js";
import { chatFn, llmFromEnv, type Msg } from "./agent/llm.js";
import { chains, chainOf } from "./chains.js";
import { db, graphFor, Q } from "./graph/db.js";
import { createMcpServer } from "./mcp.js";
import { TOOLS, runTool } from "./tools/index.js";
import { isAddress, lc } from "./util.js";

const app = new Hono();

// Local development only: FAKE_CHAIN_DATA=1 serves the synthetic test wallet instead of calling Blockscout.
const devCtx: { fetchImpl?: any } = {};
if (process.env.FAKE_CHAIN_DATA === "1") {
  const fx = await import("../test/fixtures.js");
  devCtx.fetchImpl = fx.fakeFetch().fn;
  console.warn(`FAKE_CHAIN_DATA=1: serving the synthetic test wallet ${fx.W}. Never set this in production.`);
}
const page = () => readFileSync(fileURLToPath(new URL("../public/index.html", import.meta.url)), "utf8");

// A small per-IP budget so a public demo can't be used to hammer the explorers.
const hits = new Map<string, number[]>();
function allowed(ip: string, max = Number(process.env.RUNS_PER_HOUR ?? 40)) {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (list.length >= max) return false;
  list.push(now);
  hits.set(ip, list);
  return true;
}
const ipOf = (c: any) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

/** Writes server-sent events in order and lets the handler wait for the last one before the stream closes. */
function sse(s: { writeSSE: (m: { event: string; data: string }) => Promise<void> }) {
  let chain = Promise.resolve();
  return {
    emit: (event: string, payload: unknown) => {
      chain = chain.then(() => s.writeSSE({ event, data: JSON.stringify(payload) })).catch(() => {});
    },
    flush: () => chain,
  };
}

app.get("/", (c) => c.html(page()));

const VENDOR: Record<string, string> = {
  "vis-network.min.js": "../node_modules/vis-network/standalone/umd/vis-network.min.js",
  "marked.min.js": "../node_modules/marked/marked.min.js",
  "purify.min.js": "../node_modules/dompurify/dist/purify.min.js",
};
app.get("/vendor/:file", (c) => {
  const rel = VENDOR[c.req.param("file")];
  if (!rel) return c.notFound();
  const body = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  return c.body(body, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400" });
});

app.get("/api/health", async (c) => {
  let falkordb = false;
  try {
    await (await db()).list();
    falkordb = true;
  } catch {
    /* down */
  }
  const llm = llmFromEnv();
  return c.json({ ok: falkordb, falkordb, llm: llm ? { model: llm.model } : null, chains: chains().map((x) => ({ key: x.key, name: x.name })), tools: TOOLS.map((t) => t.name) });
});

function validate(body: any) {
  const chain = String(body?.chain ?? "ethereum");
  const address = String(body?.address ?? "");
  chainOf(chain);
  if (!isAddress(address)) throw new Error("Enter a 0x wallet address (42 characters).");
  return { chain, address: lc(address) };
}

app.post("/api/run", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  let v: { chain: string; address: string };
  try {
    v = validate(body);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
  if (!allowed(ipOf(c))) return c.json({ error: "Hourly run limit reached. Try again later." }, 429);
  const pages = Number(body?.pages) || undefined;
  return streamSSE(c, async (s) => {
    const { emit, flush } = sse(s);
    try {
      await autopilot(v.chain, v.address, devCtx, emit as any, pages);
    } catch (e: any) {
      emit("error", { error: String(e?.message ?? e) });
    }
    await flush();
  });
});

app.post("/api/ask", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  let v: { chain: string; address: string };
  try {
    v = validate(body);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
  const cfg = llmFromEnv();
  if (!cfg) return c.json({ error: "No LLM key is configured on this server. Use Run postmortem, or set LLM_API_KEY / GEMINI_API_KEY." }, 400);
  if (!allowed(ipOf(c))) return c.json({ error: "Hourly run limit reached. Try again later." }, 429);
  const question = String(body?.question ?? "").slice(0, 1000);
  const history: Msg[] = Array.isArray(body?.history)
    ? body.history.filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string").slice(-10).map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 4000) }))
    : [];
  return streamSSE(c, async (s) => {
    const { emit, flush } = sse(s);
    try {
      await ask({ chain: v.chain, address: v.address, question, history }, chatFn(cfg), devCtx, emit as any);
    } catch (e: any) {
      emit("error", { error: String(e?.message ?? e) });
    }
    await flush();
  });
});

app.post("/api/tool/:name", async (c) => {
  const name = c.req.param("name");
  if (!TOOLS.some((t) => t.name === name)) return c.json({ error: "unknown tool" }, 404);
  if (!allowed(ipOf(c))) return c.json({ error: "Hourly run limit reached." }, 429);
  try {
    const r = await runTool(name, await c.req.json().catch(() => ({})), devCtx);
    return c.json(r);
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e) }, 400);
  }
});

app.get("/api/report", async (c) => {
  try {
    const { chain, address } = validate({ chain: c.req.query("chain"), address: c.req.query("address") });
    const q = new Q(await graphFor(chain));
    const [r] = await q.ro<{ md: string; at: number }>(
      `MATCH (:Address {addr:$w})-[:HAS_REPORT]->(r:Report) RETURN r.md AS md, r.createdAt AS at ORDER BY r.createdAt DESC LIMIT 1`,
      { w: address },
    );
    return r ? c.json(r) : c.json({ error: "No report yet for this wallet." }, 404);
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e) }, 400);
  }
});

// MCP over streamable HTTP, stateless: a fresh server per request.
app.all("/mcp", async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = createMcpServer();
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`postmortem listening on :${port}`));

export type { Step };
export default app;
