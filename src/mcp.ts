import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLS, runTool } from "./tools/index.js";

/** Every graph tool, served over MCP so any assistant can pick them. */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "postmortem", version: "0.1.0" });
  for (const t of TOOLS) {
    const readOnly = !["load_wallet", "plan_revokes", "write_postmortem", "trace_funds", "who_can_spend"].includes(t.name);
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.shape, annotations: { readOnlyHint: readOnly, openWorldHint: t.name === "load_wallet" || t.name === "trace_funds" } },
      async (args: any) => {
        try {
          const r = await runTool(t.name, args);
          return { content: [{ type: "text" as const, text: JSON.stringify({ summary: r.summary, data: r.data, evidence: r.evidence }) }] };
        } catch (e: any) {
          return { isError: true, content: [{ type: "text" as const, text: String(e?.message ?? e) }] };
        }
      },
    );
  }
  return server;
}
