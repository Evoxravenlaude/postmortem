/** OpenAI-compatible chat completions with tool calling. Works with OpenAI, Gemini's OpenAI endpoint, OpenRouter, Groq and others. */
export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export function llmFromEnv(): LlmConfig | null {
  const e = process.env;
  if (e.LLM_API_KEY) return { baseUrl: e.LLM_BASE_URL ?? "https://api.openai.com/v1", apiKey: e.LLM_API_KEY, model: e.LLM_MODEL ?? "gpt-4.1-mini" };
  if (e.GEMINI_API_KEY) return { baseUrl: e.LLM_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: e.GEMINI_API_KEY, model: e.LLM_MODEL ?? "gemini-2.5-flash" };
  if (e.OPENAI_API_KEY) return { baseUrl: e.LLM_BASE_URL ?? "https://api.openai.com/v1", apiKey: e.OPENAI_API_KEY, model: e.LLM_MODEL ?? "gpt-4.1-mini" };
  return null;
}

export type ChatFn = (messages: Msg[], tools: ToolSpec[]) => Promise<{ content: string | null; tool_calls?: ToolCall[] }>;

export function chatFn(cfg: LlmConfig, fetchImpl: typeof fetch = fetch): ChatFn {
  return async (messages, tools) => {
    const res = await fetchImpl(cfg.baseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages, tools, tool_choice: "auto", temperature: 0.2 }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j: any = await res.json();
    const m = j.choices?.[0]?.message;
    if (!m) throw new Error("LLM returned no message");
    return { content: m.content ?? null, tool_calls: m.tool_calls };
  };
}
