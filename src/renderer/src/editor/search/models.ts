/**
 * Visual search's two local models through main (`ai:models`, `ai:model-download`, `ai:model-state` — 6b's downloads,
 * docs/ai.md §2.4, §10.2): whether they are on this computer, their size for the confirmation, and the download.
 */
import type { AiSetupApi } from "../../../../shared/ai/api";
import type { AiModelId, AiModelState, AiSettings } from "../../../../shared/ai/types";
import { DEFAULT_AI_SETTINGS } from "../../../../shared/ai/types";
import { aiSetupBridge } from "../../settings/bridge";
import { SEARCH_MODELS } from "./embedder";

export type ModelsApi = Pick<AiSetupApi, "models" | "modelDownload" | "onModelState" | "settings">;

/** Where the models stand: "unavailable" — this build or this place (a browser) has no local models */
export interface SearchModels {
  state: "unavailable" | "absent" | "downloading" | "ready" | "error";
  /** Both models' size in bytes (what the confirmation shows) */
  bytes: number;
  /** Still to download */
  missing: AiModelId[];
  /** Downloading: bytes received so far */
  received?: number;
  error?: string;
}

export const modelsApi = (): ModelsApi | null => aiSetupBridge();

/** The two models' state, read from main. */
export async function searchModels(api: ModelsApi | null = modelsApi()): Promise<SearchModels> {
  if (!api) return { state: "unavailable", bytes: 0, missing: [...SEARCH_MODELS] };
  const listed = await api.models().catch(() => null);
  const info = SEARCH_MODELS.map((id) => listed?.info.find((i) => i.id === id));
  if (!listed || info.some((i) => !i)) return { state: "unavailable", bytes: 0, missing: [...SEARCH_MODELS] };
  return combine(SEARCH_MODELS.map((id, i) => listed.state.find((s) => s.id === id) ?? { id, state: "absent", bytes: info[i]!.bytes }));
}

export function combine(states: readonly AiModelState[]): SearchModels {
  const bytes = states.reduce((n, s) => n + s.bytes, 0);
  const missing = states.filter((s) => s.state !== "ready").map((s) => s.id);
  const error = states.find((s) => s.state === "error");
  if (error) return { state: "error", bytes, missing, error: error.error ?? "The download didn't finish." };
  if (states.some((s) => s.state === "downloading")) {
    return { state: "downloading", bytes, missing, received: states.reduce((n, s) => n + (s.state === "ready" ? s.bytes : (s.received ?? 0)), 0) };
  }
  return { state: missing.length ? "absent" : "ready", bytes, missing };
}

/** Downloads what is missing, one model after the other; resolves when both are there (rejects on a failure). */
export async function downloadSearchModels(api: ModelsApi, onProgress?: (m: SearchModels) => void): Promise<void> {
  const latest = new Map<AiModelId, AiModelState>();
  const first = await searchModels(api);
  if (first.state === "unavailable") throw new Error("Local models aren't available in this version yet.");
  const listed = await api.models();
  for (const id of SEARCH_MODELS) {
    const s = listed.state.find((x) => x.id === id);
    const info = listed.info.find((x) => x.id === id)!;
    latest.set(id, s ?? { id, state: "absent", bytes: info.bytes });
  }
  const report = () => onProgress?.(combine([...latest.values()]));
  const off = api.onModelState((s) => {
    if (!latest.has(s.id)) return;
    latest.set(s.id, s);
    report();
  });
  try {
    for (const id of first.missing) {
      const done = await api.modelDownload(id);
      latest.set(id, done);
      report();
      if (done.state === "error") throw new Error(done.error ?? "The download didn't finish.");
    }
  } finally {
    off();
  }
}

/** Settings › AI's "Index files for visual search" and the AI switch (on when the settings can't be read). */
export async function indexingOn(api: ModelsApi | null = modelsApi()): Promise<boolean> {
  const s: AiSettings = (await api?.settings().catch(() => null)) ?? DEFAULT_AI_SETTINGS;
  return s.enabled && s.indexForSearch;
}

/** "154 MB" */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
