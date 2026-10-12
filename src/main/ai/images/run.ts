import { rmSync } from "node:fs";
import { join } from "node:path";
import { creditsFor, type AiBalance, type AiImageRequest, type AiRoute, type AiSettings } from "../../../shared/ai/types";
import type { SpawnFn } from "../../agents/providers/turns";
import { AiError } from "../oneShot";
import { overLimit, type Emit } from "../run";
import { antigravityImage } from "./antigravity";
import { geminiImage } from "./gemini";
import { openAiImage } from "./openai";
import { jobPrompt, type ImageAnswer, type ImageJob } from "./types";

/**
 * One image run (`ai:image`, docs/ai.md §2.5–2.6): AI on → the credits stop → the route (the request's, the action's
 * override, Settings › AI's image route, else Antigravity — owner §10.1) → the client → events `status`, `image`,
 * `usage` (one image, Figma-like credits), `done`; a failure `error`, `done`; a cancel `done {cancelled}`. Electron-free:
 * keys, spawn and fetch are injected. The view records the run in the ledger (it knows the file).
 */

export const IMAGE_PROVIDERS = ["antigravity", "openai-images", "gemini-images"] as const;
export const IMAGE_ACTIONS: readonly AiImageRequest["action"][] = ["make-image", "edit-image", "expand-image", "erase-object"];
/** Pictures in a request: base64 of at most this many bytes (≈ 20 MB decoded). */
export const MAX_IMAGE_B64 = 28_000_000;

export interface ImageRunDeps {
  settings(): AiSettings;
  balance(allowance: number): Promise<AiBalance | null>;
  imageKey(provider: "openai" | "gemini"): string | null;
  /** Antigravity's binary, or null when it isn't installed */
  agyPath(): string | null;
  spawn: SpawnFn;
  env(): NodeJS.ProcessEnv;
  home: string;
  workDir: string;
  fetch?: typeof fetch;
  /** Per run (default 240 s) */
  timeoutMs?: number;
  /** Tests: the APIs' base URLs */
  openaiBaseUrl?: string;
  geminiBaseUrl?: string;
}

/** The request as plain checked data (the IPC's). */
export function cleanImageRequest(v: unknown): AiImageRequest {
  const r = (v ?? {}) as Record<string, unknown>;
  const runId = typeof r.runId === "string" && /^[\w:.-]{1,100}$/.test(r.runId) ? r.runId : null;
  if (!runId) throw new Error("ai:image: a runId");
  const action = r.action as AiImageRequest["action"];
  if (!IMAGE_ACTIONS.includes(action)) throw new Error("ai:image: unknown action");
  const b64 = (x: unknown, name: string) => {
    if (x === undefined || x === null) return undefined;
    if (typeof x !== "string" || x.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/=]*$/.test(x.slice(0, 200))) throw new Error(`ai:image: ${name} is not a PNG of at most 20 MB`);
    return x;
  };
  const route = r.route && typeof r.route === "object" ? (r.route as AiRoute) : undefined;
  const sizeRaw = r.size as { width?: unknown; height?: unknown } | undefined;
  const dim = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 1 && n <= 16384 ? Math.round(n) : null);
  const size = sizeRaw && dim(sizeRaw.width) && dim(sizeRaw.height) ? { width: dim(sizeRaw.width)!, height: dim(sizeRaw.height)! } : undefined;
  const out: AiImageRequest = {
    runId,
    action,
    ...(route && typeof route.providerId === "string" ? { route: { providerId: route.providerId.slice(0, 100), ...(typeof route.model === "string" ? { model: route.model.slice(0, 300) } : {}) } } : {}),
    ...(typeof r.prompt === "string" ? { prompt: r.prompt.slice(0, 8000) } : {}),
    ...(b64(r.image, "image") ? { image: r.image as string } : {}),
    ...(b64(r.mask, "mask") ? { mask: r.mask as string } : {}),
    ...(b64(r.reference, "reference") ? { reference: r.reference as string } : {}),
    ...(size ? { size } : {}),
  };
  if (action !== "make-image" && !out.image) throw new Error("ai:image: this action needs the picture");
  if (action === "make-image" && !out.prompt?.trim()) throw new Error("ai:image: Make an image needs a prompt");
  return out;
}

/** The route of an image action: asked, the action's override, the image route, else Antigravity. */
export function imageRoute(s: AiSettings, req: Pick<AiImageRequest, "action" | "route">): AiRoute {
  return req.route ?? s.actions[req.action] ?? s.image ?? { providerId: "antigravity" };
}

const megapixels = (a: ImageAnswer) => (a.width * a.height) / 1_000_000;

export async function runImage(req: AiImageRequest, deps: ImageRunDeps, emit: Emit, signal: AbortSignal): Promise<void> {
  const local = new AbortController();
  const onAbort = () => local.abort(signal.reason);
  signal.addEventListener("abort", onAbort);
  const ms = deps.timeoutMs ?? 240_000;
  const timer = setTimeout(() => local.abort(new AiError("timeout", `No picture in ${Math.round(ms / 1000)} s.`)), ms);
  const cwd = join(deps.workDir, `img-${req.runId.replace(/[^\w-]/g, "_").slice(0, 60)}-${Date.now().toString(36)}`);
  try {
    const s = deps.settings();
    if (!s.enabled) throw new AiError("disabled", "AI is turned off in Settings › AI.");
    const over = await overLimit(deps, req.action);
    if (over) throw over;
    const route = imageRoute(s, req);
    const job: ImageJob = {
      action: req.action,
      prompt: jobPrompt(req.action, req.prompt),
      ...(req.image ? { image: Buffer.from(req.image, "base64") } : {}),
      ...(req.mask ? { mask: Buffer.from(req.mask, "base64") } : {}),
      ...(req.reference ? { reference: Buffer.from(req.reference, "base64") } : {}),
      ...(req.size ? { size: req.size } : {}),
      ...(route.model ? { model: route.model } : {}),
      signal: local.signal,
    };
    let answer: ImageAnswer;
    if (route.providerId === "antigravity") {
      const path = deps.agyPath();
      if (!path) throw new AiError("no-provider", "Antigravity isn't installed on this computer. Set it up in Settings › Agents, or pick another image provider in Settings › AI.");
      emit({ type: "status", text: "Asking Antigravity…" });
      answer = await antigravityImage(job, { path, spawn: deps.spawn, env: deps.env(), home: deps.home, cwd });
    } else if (route.providerId === "openai-images" || route.providerId === "gemini-images") {
      const which = route.providerId === "openai-images" ? "openai" : "gemini";
      const key = deps.imageKey(which);
      if (!key) throw new AiError("no-provider", `Add your ${which === "openai" ? "OpenAI" : "Gemini"} API key in Settings › AI.`);
      emit({ type: "status", text: which === "openai" ? "Asking OpenAI…" : "Asking Gemini…" });
      answer = which === "openai" ? await openAiImage(job, { key, fetch: deps.fetch, baseUrl: deps.openaiBaseUrl }) : await geminiImage(job, { key, fetch: deps.fetch, baseUrl: deps.geminiBaseUrl });
    } else throw new AiError("unsupported", "Pick an image provider in Settings › AI: Antigravity, OpenAI Images or the Gemini API.");
    if (local.signal.aborted) throw local.signal.reason;
    emit({ type: "image", data: answer.data.toString("base64"), mime: answer.mime, width: answer.width, height: answer.height });
    const model = answer.model ?? route.model;
    emit({ type: "usage", usage: { input: 0, output: 0, images: 1, credits: creditsFor(req.action, { model, megapixels: megapixels(answer) }), providerId: route.providerId, ...(model ? { model } : {}) } });
    emit({ type: "done" });
  } catch (err) {
    const reason = local.signal.aborted ? local.signal.reason : err;
    const e = reason instanceof AiError ? reason : new AiError("network", reason instanceof Error ? reason.message : String(reason));
    if (e.code === "cancelled" || (signal.aborted && !(reason instanceof AiError && reason.code === "timeout"))) emit({ type: "done", cancelled: true });
    else {
      emit({ type: "error", code: e.code, message: e.message });
      emit({ type: "done" });
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    rmSync(cwd, { recursive: true, force: true });
  }
}
