/**
 * Main's AI as the views reach it (`window.designer.ai`, docs/ai.md §8): the settings, one-shot runs and their
 * events, image runs and local models (6b's in main). `runOnce` turns a run's events into one promise — what the
 * editor's actions (6a) await.
 */
import type { ImageRouteInfo, AiImageRequest, AiModelId, AiModelInfo, AiModelState, AiRunEvent, AiRunEventMsg, AiRunRequest, AiSettings, AiUsage, AiErrorCode } from "./types";

export interface AiApi {
  settings(): Promise<AiSettings>;
  setSettings(patch: Partial<Omit<AiSettings, "imageKeys">>): Promise<AiSettings>;
  setImageKey(provider: "openai" | "gemini", key: string | null): Promise<AiSettings>;
  /** A one-shot text run: its events come to `onEvent` with this runId */
  run(request: AiRunRequest): Promise<void>;
  /** An image run (Make, Edit, Expand, Erase — 6b) */
  image(request: AiImageRequest): Promise<void>;
  /** The image routes and whether each can run now (docs/studio.md §2.4) */
  imageRoutes(): Promise<ImageRouteInfo[]>;
  cancel(runId: string): Promise<void>;
  onEvent(cb: (m: AiRunEventMsg) => void): () => void;
  models(): Promise<{ info: AiModelInfo[]; state: AiModelState[] }>;
  modelDownload(id: AiModelId): Promise<AiModelState>;
  modelRemove(id: AiModelId): Promise<AiModelState>;
  onModelState(cb: (s: AiModelState) => void): () => void;
}

/** What Home's Settings › AI uses (no runs). */
export type AiSetupApi = Pick<AiApi, "settings" | "setSettings" | "setImageKey" | "models" | "modelDownload" | "modelRemove" | "onModelState"> &
  Partial<Pick<AiApi, "imageRoutes">>;

/** A run's failure as the action shows it. */
export class AiRunError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface AiRunOutcome {
  text: string;
  json?: unknown;
  usage?: AiUsage;
}

/**
 * One run as a promise: resolved with its result (and usage), rejected with an AiRunError (`cancelled` when cancelled).
 * `onEvent` sees every event (status, deltas) as it comes; `signal` cancels it.
 */
export function runOnce(api: Pick<AiApi, "run" | "cancel" | "onEvent">, request: AiRunRequest, o: { onEvent?: (e: AiRunEvent) => void; signal?: AbortSignal } = {}): Promise<AiRunOutcome> {
  return new Promise((resolve, reject) => {
    let result: AiRunOutcome | null = null;
    let usage: AiUsage | undefined;
    let error: AiRunError | null = null;
    const onAbort = () => void api.cancel(request.runId);
    const off = api.onEvent(({ runId, event }) => {
      if (runId !== request.runId) return;
      o.onEvent?.(event);
      if (event.type === "usage") usage = event.usage;
      else if (event.type === "result") result = { text: event.text, ...(event.json !== undefined ? { json: event.json } : {}) };
      else if (event.type === "error") error = new AiRunError(event.code, event.message);
      else if (event.type === "done") {
        off();
        o.signal?.removeEventListener("abort", onAbort);
        if (event.cancelled) reject(new AiRunError("cancelled", "Cancelled."));
        else if (error || !result) reject(error ?? new AiRunError("bad-output", "No answer."));
        else resolve({ ...(result as AiRunOutcome), ...(usage ? { usage } : {}) });
      }
    });
    if (o.signal?.aborted) {
      off();
      return reject(new AiRunError("cancelled", "Cancelled."));
    }
    o.signal?.addEventListener("abort", onAbort);
    api.run(request).catch((err: unknown) => {
      off();
      o.signal?.removeEventListener("abort", onAbort);
      reject(new AiRunError("no-provider", err instanceof Error ? err.message : String(err)));
    });
  });
}
