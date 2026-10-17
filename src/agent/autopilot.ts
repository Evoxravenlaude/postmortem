import { runTool, type ToolCtx } from "../tools/index.js";
import { lc } from "../util.js";
import type { Emit, Step } from "./agent.js";

/**
 * The full postmortem without an LLM. The graph still decides the route: a pull through an
 * approval triggers a trace of that token, and any high or medium risk approval triggers revokes.
 */
export async function autopilot(chain: string, address: string, ctx: ToolCtx = {}, emit: Emit = () => {}, pages?: number) {
  const w = lc(address);
  const steps: Step[] = [];
  const step = async (tool: string, args: Record<string, unknown>, why: string) => {
    emit("step-start", { tool, args, why });
    const t0 = Date.now();
    try {
      const r = await runTool(tool, args, ctx);
      const s: Step = { tool, args, why, summary: r.summary, data: r.data, evidence: r.evidence, ms: Date.now() - t0 };
      steps.push(s);
      emit("step", s);
      return s;
    } catch (e: any) {
      const s: Step = { tool, args, why, summary: "", evidence: { cypher: [], paths: [] }, error: String(e?.message ?? e), ms: Date.now() - t0 };
      steps.push(s);
      emit("step", s);
      return s;
    }
  };

  const loaded = await step("load_wallet", { chain, address: w, ...(pages ? { pages } : {}) }, "Pull the wallet's history into the graph.");
  if (loaded.error) {
    emit("answer", { answer: `Could not load the wallet: ${loaded.error}` });
    return { steps, answer: loaded.error };
  }
  await step("wallet_overview", { chain, address: w }, "Get the shape of the wallet and its central counterparties.");
  const out = await step("explain_outflows", { chain, address: w }, "Classify every outflow by walking who signed it and which approval allowed it.");
  const pulls = ((out.data as any)?.pulls ?? []) as any[];
  if (pulls.length) {
    const biggest = [...pulls].sort((a, b) => (b.usdNow ?? 0) - (a.usdNow ?? 0))[0];
    if (biggest?.token && biggest.token !== "native")
      await step("trace_funds", { chain, address: w, token: biggest.token, hops: 2, since: biggest.when.slice(0, 10) }, `Money was pulled without the wallet signing. Follow the ${biggest.symbol} to see where it went.`);
  }
  const exp = await step("who_can_spend", { chain, address: w }, "Check every approval on-chain and score what is still exposed.");
  const risky = (((exp.data as any)?.approvals ?? []) as any[]).filter((a) => a.active && (a.risk === "high" || a.risk === "medium"));
  if (risky.length) await step("plan_revokes", { chain, address: w }, `${risky.length} risky approval(s) are still live. Draft the revokes.`);
  const rep = await step("write_postmortem", { chain, address: w }, "Write the postmortem and save it to the graph.");
  const answer = (rep.data as any)?.markdown ?? "Postmortem could not be written.";
  emit("answer", { answer, markdown: true });
  return { steps, answer };
}
