import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { creditsFor, type AiAction, type AiBalance, type AiRoute, type AiRunEvent, type AiRunRequest, type AiSettings, type AiUsage } from "../../shared/ai/types";
import type { CliSpec, SpawnFn } from "../agents/providers/turns";
import { readAnswer } from "./json";
import { AiError, runCliOneShot, runServerOneShot, type Attempt, type AttemptControl } from "./oneShot";

/**
 * One-shot AI runs (docs/ai.md §2.2, §2.9): `ai:run` → events `ai:event` with the caller's runId.
 *
 * A run: AI on (Settings › AI) → the credits stop (`stopAtLimit`: the ledger's month used up → `over-limit`) → the
 * route (the request's, the action's override, the text route, else the first connected of AI_TEXT_DEFAULT_ORDER) →
 * one attempt on the provider (no tools), its text streamed as `delta` → the answer read (the CLI's structured
 * output, else the last JSON object) and checked against the schema → on a mismatch one repair attempt, then
 * `bad-output` → `usage` (tokens of every attempt, with Figma-like credits), `result`, `done`. Cancel (`ai:cancel`) kills
 * the CLI or aborts the request: `done {cancelled: true}` and nothing else. Each attempt has a timeout (`timeout`).
 *
 * Electron-free: settings, routes, the ledger, spawn and fetch are injected (src/main/ai/host.ts wires the app's; the
 * tests a stub CLI and a local HTTP server). Image runs (`ai:image`) are 6b's: they can register here with `track`
 * so `ai:cancel` reaches them too.
 */

export type ResolvedRoute =
  | { kind: "cli"; providerId: string; spec: CliSpec; path: string; model?: string; effort?: string }
  | { kind: "server"; providerId: string; label: string; baseUrl: string; apiKey?: string; model: string };

export interface RunDeps {
  settings(): AiSettings;
  /** The route for an action, or why there is none (no-provider, unsupported, no-model) */
  resolveRoute(action: AiAction, route?: AiRoute): Promise<ResolvedRoute>;
  /** The ledger's month (6g's store.ai.balance), null while it can't say — a run is never refused for that */
  balance(allowance: number): Promise<AiBalance | null>;
  spawn: SpawnFn;
  env(): NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** A folder for the runs' working folders (each run's is removed after it) */
  workDir: string;
  home: string;
  /** Whether a CLI takes `--json-schema` (its `--help` lists it); default yes */
  takesSchema?(route: Extract<ResolvedRoute, { kind: "cli" }>): Promise<boolean>;
  /** Each attempt's limit (default 180 s) */
  timeoutMs?: number;
}

export type Emit = (event: AiRunEvent) => void;

interface Live {
  abort: AbortController;
  emit: Emit;
}

/** Credits of a text action's tokens (the agent-chat default formula for token actions). */
export const usageOf = (action: AiAction, t: { input: number; output: number }, model?: string, providerId?: string): AiUsage => ({
  input: t.input,
  output: t.output,
  images: 0,
  credits: creditsFor(action, { input: t.input, output: t.output, model }),
  ...(providerId ? { providerId } : {}),
  ...(model ? { model } : {}),
});

/** "Your AI credits reset on November 1." */
export function overLimitMessage(b: AiBalance): string {
  const d = new Date(b.resetsAt);
  const when = d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  // An allowance of 0 (Settings › AI, or an organization's limit or AI turned off — 6g's ledger.ts)
  if (b.allowance <= 0) return `You don't have any AI credits this month. They reset on ${when}.`;
  return `You've used all ${b.allowance.toLocaleString("en-US")} AI credits for this month. They reset on ${when}.`;
}

/** The credits stop (docs/ai.md §2.9, owner §10.3): refused when the month's credits are used and the action costs any. */
export async function overLimit(deps: Pick<RunDeps, "settings" | "balance">, action: AiAction): Promise<AiError | null> {
  const s = deps.settings();
  if (!s.stopAtLimit) return null;
  // Free actions (Rename layers, search) run whatever the balance.
  if (creditsFor(action, { input: 1, output: 1, megapixels: 1, colors: 2 }) === 0) return null;
  const b = await deps.balance(s.monthlyCredits).catch(() => null);
  return b && b.remaining <= 0 ? new AiError("over-limit", overLimitMessage(b)) : null;
}

export class AiRuns {
  private live = new Map<string, Live>();

  constructor(private deps: RunDeps) {}

  /** Runs in progress (by owner and runId: one view can't cancel another's). */
  get size(): number {
    return this.live.size;
  }

  /** Another kind of run (6b's images) made cancellable by `cancel`. Returns its signal and its end. */
  track(owner: string | number, runId: string, emit: Emit): { signal: AbortSignal; end(): void } {
    const key = `${owner}:${runId}`;
    if (this.live.has(key)) throw new Error(`ai: run ${runId} is already running`);
    const abort = new AbortController();
    this.live.set(key, { abort, emit });
    return { signal: abort.signal, end: () => this.live.get(key)?.abort === abort && this.live.delete(key) };
  }

  cancel(owner: string | number, runId: string): void {
    this.live.get(`${owner}:${runId}`)?.abort.abort(new AiError("cancelled", "Cancelled."));
  }

  /** Cancels every run of an owner (its view went away). */
  cancelAll(owner?: string | number): void {
    for (const [key, l] of this.live) if (owner === undefined || key.startsWith(`${owner}:`)) l.abort.abort(new AiError("cancelled", "Cancelled."));
  }

  /** Starts a run; its events go to `emit`, `done` last. Resolves when it ended. */
  start(owner: string | number, req: AiRunRequest, emit: Emit): Promise<void> {
    const { signal, end } = this.track(owner, req.runId, emit);
    return this.execute(req, emit, signal).finally(end);
  }

  private async execute(req: AiRunRequest, emit: Emit, signal: AbortSignal): Promise<void> {
    const total = { input: 0, output: 0 };
    let model: string | undefined;
    let providerId: string | undefined;
    let attempted = false;
    const fail = (err: unknown) => {
      if (attempted && (total.input || total.output)) emit({ type: "usage", usage: usageOf(req.action, total, model, providerId) });
      if (signal.aborted && (!(err instanceof AiError) || err.code === "cancelled")) return emit({ type: "done", cancelled: true });
      const e = err instanceof AiError ? err : new AiError("network", err instanceof Error ? err.message : String(err));
      if (e.code === "cancelled") return emit({ type: "done", cancelled: true });
      emit({ type: "error", code: e.code, message: e.message });
      emit({ type: "done" });
    };
    try {
      const s = this.deps.settings();
      if (!s.enabled) throw new AiError("disabled", "AI is turned off in Settings › AI.");
      const over = await overLimit(this.deps, req.action);
      if (over) throw over;
      const route = await this.deps.resolveRoute(req.action, req.route);
      providerId = route.providerId;
      if (signal.aborted) throw new AiError("cancelled", "Cancelled.");
      const schemaFlag = route.kind === "cli" && req.schema ? ((await this.deps.takesSchema?.(route)) ?? true) : false;
      emit({ type: "status", text: `Asking ${route.kind === "cli" ? route.spec.label : route.label}…` });
      attempted = true;
      const first = await this.attempt(route, req, req.prompt, schemaFlag, emit, signal);
      total.input += first.usage.input;
      total.output += first.usage.output;
      model = first.model ?? route.model;
      let answer = readAnswer(first.text, req.schema, first.json);
      let text = first.text;
      if (answer.errors.length) {
        emit({ type: "status", text: "Fixing the answer…" });
        const repair = `${req.prompt}\n\nYour previous answer:\n${first.text.slice(0, 12_000)}\n\nIt doesn't match the required JSON schema: ${answer.errors.slice(0, 10).join("; ")}.\nAnswer again with only the corrected JSON object, matching this schema:\n${JSON.stringify(req.schema)}`;
        const second = await this.attempt(route, req, repair, schemaFlag, emit, signal);
        total.input += second.usage.input;
        total.output += second.usage.output;
        answer = readAnswer(second.text, req.schema, second.json);
        text = second.text;
        if (answer.errors.length) throw new AiError("bad-output", `The answer didn't match what this action needs (${answer.errors.slice(0, 3).join("; ")}).`);
      }
      emit({ type: "usage", usage: usageOf(req.action, total, model, providerId) });
      emit({ type: "result", text, ...(answer.json !== undefined ? { json: answer.json } : {}) });
      emit({ type: "done" });
    } catch (err) {
      fail(err);
    }
  }

  /** One attempt with the timeout; its working folder (a CLI's) removed after it. */
  private async attempt(route: ResolvedRoute, req: AiRunRequest, prompt: string, schemaFlag: boolean, emit: Emit, signal: AbortSignal): Promise<Attempt> {
    const local = new AbortController();
    const onAbort = () => local.abort(signal.reason);
    signal.addEventListener("abort", onAbort);
    const ms = Math.min(this.deps.timeoutMs ?? 180_000, req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : Infinity);
    const timer = setTimeout(() => local.abort(new AiError("timeout", `No answer in ${Math.round(ms / 1000)} s.`)), ms);
    const ctl: AttemptControl = { signal: local.signal, onDelta: (text) => emit({ type: "delta", text }) };
    const cwd = join(this.deps.workDir, `${req.runId.replace(/[^\w-]/g, "_").slice(0, 60)}-${Date.now().toString(36)}`);
    try {
      if (route.kind === "server")
        return await runServerOneShot({ baseUrl: route.baseUrl, apiKey: route.apiKey, model: route.model, system: req.system, prompt, schema: req.schema, images: req.images, maxOutputTokens: req.maxOutputTokens, fetch: this.deps.fetch, ...ctl });
      const images = (req.images ?? []).map((img, i) => ({ name: img.name, data: img.data, path: `image-${i + 1}.png` }));
      if (images.length) {
        mkdirSync(cwd, { recursive: true });
        for (const img of images) writeFileSync(join(cwd, img.path), Buffer.from(img.data, "base64"));
      }
      return await runCliOneShot({
        spec: route.spec,
        path: route.path,
        input: { system: req.system, prompt, schema: schemaFlag ? req.schema : undefined, model: route.model, effort: route.effort, images: images.length ? images : undefined, cwd, home: this.deps.home },
        env: this.deps.env(),
        spawn: this.deps.spawn,
        ...ctl,
      });
    } catch (err) {
      // Its own abort reason (the timeout), or the caller's cancel.
      if (local.signal.aborted && local.signal.reason instanceof AiError) throw local.signal.reason;
      throw err;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (route.kind === "cli") rmSync(cwd, { recursive: true, force: true });
    }
  }
}
