import type { ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AiErrorCode } from "../../shared/ai/types";
import { LineSplitter, type CliSpec, type OneShotInput, type SpawnFn } from "../agents/providers/turns";
import { trimBase } from "../agents/openaiBridge";

/**
 * One attempt of a one-shot AI run (docs/ai.md §2.2), on a CLI (its adapter's `oneShot` plan) or on an
 * OpenAI-compatible server (Ollama, LM Studio, a server the owner added): the answer's text collected while its
 * deltas stream, the tokens it reports, an AiError when it fails. No tools, no MCP. Electron-free (run.ts injects
 * spawn and fetch; the tests use a stub CLI and a local HTTP server).
 */

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string
  ) {
    super(message);
  }
}

/** A provider's failure as one of the run's error codes, by what it said. */
export function classify(message: string, fallback: AiErrorCode = "network"): AiError {
  const m = message || "The provider failed.";
  if (/isn.t signed in|not (?:logged|signed) in|unauthori[sz]ed|\b401\b|invalid api key|authenticat/i.test(m)) return new AiError("signed-out", m);
  if (/rate.?limit|\b429\b|usage limit|quota|too many requests|resource.?exhausted|overloaded/i.test(m)) return new AiError("rate-limited", m);
  if (/ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|socket hang up/i.test(m)) return new AiError("network", m);
  if (/refus|content.?policy|safety|blocked/i.test(m)) return new AiError("refused", m);
  if (/model .*(?:not found|does not exist)|no such model|unknown model/i.test(m)) return new AiError("no-model", m);
  if (/context.?length|too long|too large|maximum context/i.test(m)) return new AiError("too-large", m);
  return new AiError(fallback, m);
}

export interface Attempt {
  text: string;
  /** The CLI's structured output (its schema flag), already parsed */
  json?: unknown;
  usage: { input: number; output: number };
  model?: string;
}

export interface AttemptControl {
  signal: AbortSignal;
  onDelta(text: string): void;
}

const cancelled = () => new AiError("cancelled", "Cancelled.");

/** The run's CLI attempt: spawned in `input.cwd` with the plan, its lines read, killed on abort. */
export function runCliOneShot(o: { spec: CliSpec; path: string; input: OneShotInput; env: NodeJS.ProcessEnv; spawn: SpawnFn } & AttemptControl): Promise<Attempt> {
  const plan = o.spec.oneShot?.(o.input);
  if (!plan) return Promise.reject(new AiError("unsupported", `${o.spec.label} can't run AI actions.`));
  mkdirSync(o.input.cwd, { recursive: true });
  for (const [name, text] of Object.entries(plan.files ?? {})) {
    const path = isAbsolute(name) ? name : join(o.input.cwd, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { mode: 0o600 });
  }
  return new Promise((resolve, reject) => {
    if (o.signal.aborted) return reject(cancelled());
    let child: ChildProcess;
    try {
      child = o.spawn(o.path, plan.args, { cwd: o.input.cwd, env: { ...o.env, ...plan.env }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      return reject(new AiError("no-provider", `${o.spec.label} couldn't start: ${err instanceof Error ? err.message : String(err)}`));
    }
    const lines = new LineSplitter();
    let streamed = "";
    let result: string | undefined;
    let json: unknown;
    let error: string | undefined;
    let model: string | undefined;
    const usage = { input: 0, output: 0 };
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      o.signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      if (child.exitCode === null) {
        child.kill("SIGINT");
        setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 3000).unref?.();
      }
      finish(() => reject(o.signal.reason instanceof AiError ? o.signal.reason : cancelled()));
    };
    o.signal.addEventListener("abort", onAbort);
    const take = (l: Record<string, unknown>) => {
      const r = plan.line(l);
      if (r.delta) {
        streamed += r.delta;
        o.onDelta(r.delta);
      }
      if (r.result !== undefined) result = r.result;
      if (r.json !== undefined) json = r.json;
      if (r.error) error = r.error;
      if (r.model) model = r.model;
      if (r.usage) {
        usage.input += r.usage.input;
        usage.output += r.usage.output;
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => lines.push(chunk).forEach(take));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    child.on("error", (err) => finish(() => reject(new AiError("no-provider", `${o.spec.label}: ${err.message}`))));
    child.on("close", (code) => {
      lines.push("\n").forEach(take);
      finish(() => {
        if (error) return reject(classify(error));
        if (code !== 0 && result === undefined) {
          const why = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 600);
          return reject(classify(`${o.spec.label} exited (${code})${why ? `: ${why}` : ""}`));
        }
        resolve({ text: result ?? streamed, json, usage, model });
      });
    });
    child.stdin?.on("error", () => {
      /* it exited before reading: its close says why */
    });
    child.stdin?.end(plan.stdin ?? "");
  });
}

/** How a server took the answer's format last time (`json_schema`, else `json_object`, else none): kept per base URL. */
const formatMemo = new Map<string, "json_schema" | "json_object" | "none">();

export interface ServerOneShot {
  baseUrl: string;
  apiKey?: string;
  model: string;
  system: string;
  prompt: string;
  schema?: Record<string, unknown>;
  images?: { name: string; data: string }[];
  maxOutputTokens?: number;
  fetch?: typeof fetch;
}

/**
 * The server attempt: `POST /chat/completions`, streamed, `response_format` json_schema — falling back to json_object,
 * then to none, when the server refuses it (docs/ai.md §2.2) — usage from the last chunk (`stream_options.include_usage`).
 */
export async function runServerOneShot(o: ServerOneShot & AttemptControl): Promise<Attempt> {
  const doFetch = o.fetch ?? fetch;
  const base = trimBase(o.baseUrl);
  const content = o.images?.length ? [{ type: "text", text: o.prompt }, ...o.images.map((i) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${i.data}` } }))] : o.prompt;
  const formats: ("json_schema" | "json_object" | "none")[] = !o.schema ? ["none"] : (["json_schema", "json_object", "none"] as const).slice(["json_schema", "json_object", "none"].indexOf(formatMemo.get(base) ?? "json_schema"));
  let last = "";
  for (const format of formats) {
    const body = {
      model: o.model,
      messages: [{ role: "system", content: o.system }, { role: "user", content }],
      stream: true,
      stream_options: { include_usage: true },
      ...(o.maxOutputTokens ? { max_tokens: o.maxOutputTokens } : {}),
      ...(format === "json_schema" ? { response_format: { type: "json_schema", json_schema: { name: "answer", schema: o.schema, strict: false } } } : format === "json_object" ? { response_format: { type: "json_object" } } : {}),
    };
    let res: Response;
    try {
      res = await doFetch(`${base}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", ...(o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}) }, body: JSON.stringify(body), signal: o.signal });
    } catch (err) {
      if (o.signal.aborted) throw o.signal.reason instanceof AiError ? o.signal.reason : cancelled();
      throw new AiError("network", `${base}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok || !res.body) {
      last = `${res.status} ${res.statusText}${await res
        .text()
        .then((t) => (t ? `: ${t.slice(0, 300)}` : ""))
        .catch(() => "")}`;
      // A server that doesn't take this response_format: the next one.
      if ((res.status === 400 || res.status === 422 || res.status === 500) && format !== "none" && /response_format|json_schema|json_object|format|schema/i.test(last)) continue;
      throw classify(last, res.status >= 500 ? "network" : "refused");
    }
    if (o.schema) formatMemo.set(base, format);
    try {
      return await readCompletion(res.body, o.onDelta);
    } catch (err) {
      if (o.signal.aborted) throw o.signal.reason instanceof AiError ? o.signal.reason : cancelled();
      throw err instanceof AiError ? err : new AiError("network", err instanceof Error ? err.message : String(err));
    }
  }
  throw classify(last || "The server refused the request.", "refused");
}

/** An SSE completion: its text (deltas streamed), its refusal, its usage. */
async function readCompletion(body: ReadableStream<Uint8Array>, onDelta: (t: string) => void): Promise<Attempt> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let refusal = "";
  let model: string | undefined;
  const usage = { input: 0, output: 0 };
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
      let chunk: { model?: string; error?: { message?: string }; usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: { delta?: { content?: string | null; refusal?: string | null } }[] };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) throw classify(chunk.error.message ?? "The server failed.");
      if (chunk.model) model = chunk.model;
      if (chunk.usage) {
        usage.input = chunk.usage.prompt_tokens ?? usage.input;
        usage.output = chunk.usage.completion_tokens ?? usage.output;
      }
      const d = chunk.choices?.[0]?.delta;
      if (d?.content) {
        text += d.content;
        onDelta(d.content);
      }
      if (d?.refusal) refusal += d.refusal;
    }
  }
  if (refusal && !text) throw new AiError("refused", refusal);
  return { text, usage, model };
}
