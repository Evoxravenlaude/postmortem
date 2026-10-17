import { TOOLS, jsonSchemaOf, runTool, type ToolCtx } from "../tools/index.js";
import type { Evidence } from "../types.js";
import { lc } from "../util.js";
import type { ChatFn, Msg, ToolSpec } from "./llm.js";

export interface Step {
  tool: string;
  args: Record<string, unknown>;
  why?: string;
  summary: string;
  data?: unknown;
  evidence: Evidence;
  error?: string;
  ms: number;
}

export type Emit = (event: "step-start" | "step" | "answer" | "error", payload: unknown) => void;

const SYSTEM = (chain: string, address: string) => `You are Postmortem, an investigator for on-chain wallets. The user's wallet is ${address} on ${chain}.
Everything you know comes from a FalkorDB graph of the wallet's history, reached only through your tools.
Rules:
- Call load_wallet first if the wallet has not been loaded in this conversation.
- Answer from tool results only. Never invent amounts, dates or addresses.
- Prefer explain_outflows for "why did my money move", who_can_spend for exposure, trace_funds to follow money, connection_path for links, query_graph for anything else.
- When who_can_spend finds high or medium risk approvals and the user asks what to do, call plan_revokes. You only draft transactions; the user signs them.
- Keep answers short: 2 to 6 sentences or a short list. Name the tool whose path proves each claim. Values marked "now" use today's prices.`;

function trimForModel(v: unknown, max = 6000): string {
  const s = JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + "…(truncated)" : s;
}

export function toolSpecs(): ToolSpec[] {
  return TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: jsonSchemaOf(t) } }));
}

/** The LLM picks the tools; every step's Cypher and paths are kept for the UI. */
export async function ask(
  opts: { chain: string; address: string; question: string; history?: Msg[] },
  chat: ChatFn,
  ctx: ToolCtx = {},
  emit: Emit = () => {},
  maxSteps = 8,
): Promise<{ answer: string; steps: Step[]; messages: Msg[] }> {
  const chain = opts.chain;
  const address = lc(opts.address);
  const messages: Msg[] = [{ role: "system", content: SYSTEM(chain, address) }, ...(opts.history ?? []), { role: "user", content: opts.question }];
  const steps: Step[] = [];
  const specs = toolSpecs();
  for (let i = 0; i < maxSteps; i++) {
    const reply = await chat(messages, specs);
    if (!reply.tool_calls?.length) {
      const answer = reply.content ?? "";
      messages.push({ role: "assistant", content: answer });
      emit("answer", { answer });
      return { answer, steps, messages };
    }
    messages.push({ role: "assistant", content: reply.content ?? null, tool_calls: reply.tool_calls });
    for (const call of reply.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        /* fall through with empty args */
      }
      args.chain ??= chain;
      if (call.function.name !== "connection_path" && call.function.name !== "query_graph") args.address ??= address;
      emit("step-start", { tool: call.function.name, args, why: reply.content ?? undefined });
      const t0 = Date.now();
      try {
        const r = await runTool(call.function.name, args, ctx);
        const step: Step = { tool: call.function.name, args, why: reply.content ?? undefined, summary: r.summary, data: r.data, evidence: r.evidence, ms: Date.now() - t0 };
        steps.push(step);
        emit("step", step);
        messages.push({ role: "tool", tool_call_id: call.id, content: trimForModel({ summary: r.summary, data: r.data }) });
      } catch (e: any) {
        const step: Step = { tool: call.function.name, args, summary: "", evidence: { cypher: [], paths: [] }, error: String(e?.message ?? e), ms: Date.now() - t0 };
        steps.push(step);
        emit("step", step);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: step.error }) });
      }
    }
  }
  const answer = "I stopped after the step limit. The steps above show what the graph returned.";
  emit("answer", { answer });
  return { answer, steps, messages };
}
