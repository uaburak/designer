import { SYSTEM_PROMPT } from "../../shared/agents/prompts";
import { TOOLS, type ToolResult } from "../../shared/agents/tools";
import type { ChatEvent, TurnRequest } from "../../shared/agents/types";
import { promptWithContext } from "./cliProviders";

/**
 * Local models behind an OpenAI-compatible chat API (Ollama at localhost:11434/v1, LM Studio at localhost:1234/v1,
 * or a base URL the user enters): we are their MCP bridge — the design tools are offered as functions, each call
 * runs on the open file (as an MCP call would), and its result goes back until the model answers. Streams the
 * answer (SSE), as the CLIs do. Nothing is sent anywhere but `baseUrl`.
 */

export interface OpenAiTurn {
  baseUrl: string;
  apiKey?: string;
  model: string;
  request: TurnRequest;
  runTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  emit(e: ChatEvent): void;
  signal: AbortSignal;
  fetch?: typeof fetch;
  /** Tool rounds before the model must answer */
  maxRounds?: number;
}

type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export const openAiTools = () => TOOLS.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

export const trimBase = (url: string) => url.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "");

/** A tool result as the text a chat API takes (images can't go in a tool message: their size is named instead). */
export function resultText(r: ToolResult): string {
  return r.content.map((c) => (c.type === "text" ? c.text : `[A PNG screenshot was taken; this chat gets text only — read the layout with get_design_context.]`)).join("\n") + (r.isError ? "\n(error)" : "");
}

/** The SSE stream of one completion: its text deltas emitted, its tool calls assembled. */
export async function readStream(body: ReadableStream<Uint8Array>, onText: (t: string) => void): Promise<{ text: string; toolCalls: { id: string; name: string; arguments: string }[]; finish: string | null }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let finish: string | null = null;
  const calls: { id: string; name: string; arguments: string }[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let chunk: { choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[] };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      if (d.content) {
        text += d.content;
        onText(d.content);
      }
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? calls.length;
        calls[i] ??= { id: tc.id ?? `call_${i}`, name: "", arguments: "" };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  return { text, toolCalls: calls.filter(Boolean), finish };
}

export async function runOpenAiTurn(t: OpenAiTurn): Promise<void> {
  const doFetch = t.fetch ?? fetch;
  const url = `${trimBase(t.baseUrl)}/chat/completions`;
  const messages: Msg[] = [{ role: "system", content: SYSTEM_PROMPT }, ...t.request.history.slice(-20).map((m) => ({ role: m.role, content: m.text }) as Msg), { role: "user", content: promptWithContext(t.request) }];
  const tools = openAiTools();
  const max = t.maxRounds ?? 24;
  for (let round = 0; round <= max; round++) {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(t.apiKey ? { Authorization: `Bearer ${t.apiKey}` } : {}) },
      body: JSON.stringify({ model: t.model, messages, tools: round < max ? tools : undefined, stream: true }),
      signal: t.signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    }
    const out = await readStream(res.body, (delta) => t.emit({ type: "text", delta }));
    if (!out.toolCalls.length) return;
    messages.push({ role: "assistant", content: out.text || null, tool_calls: out.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } })) });
    for (const c of out.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = c.arguments ? JSON.parse(c.arguments) : {};
      } catch {
        args = {};
      }
      t.emit({ type: "tool", id: c.id, name: c.name, args, state: "running" });
      const r = await t.runTool(c.name, args);
      const content = resultText(r);
      t.emit({ type: "tool", id: c.id, name: c.name, state: r.isError ? "error" : "done", summary: content.split("\n")[0].slice(0, 140) });
      messages.push({ role: "tool", tool_call_id: c.id, content: content.slice(0, 60_000) });
    }
  }
  t.emit({ type: "error", message: "The model kept calling tools without answering; stopped." });
}

/** The models a server offers (`/models`, OpenAI's shape; Ollama's `/api/tags` as a fallback). */
export async function listModels(baseUrl: string, options: { apiKey?: string; fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<string[]> {
  const doFetch = options.fetch ?? fetch;
  const base = trimBase(baseUrl);
  const get = async (u: string) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), options.timeoutMs ?? 1500);
    try {
      const r = await doFetch(u, { headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}, signal: ctl.signal });
      if (!r.ok) throw new Error(`${r.status}`);
      return (await r.json()) as { data?: { id: string }[]; models?: { name: string }[] };
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const j = await get(`${base}/models`);
    if (Array.isArray(j.data)) return j.data.map((m) => m.id).filter(Boolean);
  } catch (err) {
    if (!/\/v1$/.test(base)) throw err;
  }
  const j = await get(`${base.replace(/\/v1$/, "")}/api/tags`);
  return (j.models ?? []).map((m) => m.name).filter(Boolean);
}
