/**
 * Vectorize's live preview on the engine's tracer (docs/ai.md §5, 6e's API): begin with the layer's contents as drawn
 * (`exportNodes` contents only, the long side ≤ 1024) → updates debounced by 120 ms as the mode and its setting change
 * → ✓ commits one undo step "Vectorize" (the traced frame replaces the image layer and is selected) or ✕ cancels
 * (nothing in the history). Figma's modes and settings: "Full color" (Number of colors), "Grayscale" (Number of
 * grays), "Black and white" (Threshold) — ranges and defaults are ours [unverified].
 */
import type { Guid, Pixels } from "@/engine/codec";
import type { VectorizeStats } from "@/engine/Engine";
import { AiRunError } from "../../../../shared/ai/api";
import { creditsFor, type TraceOptions } from "../../../../shared/ai/types";
import type { EditorController } from "../controller";
import type { ToolHooks } from "./tools";

export type VectorizeMode = TraceOptions["mode"];

export const VECTORIZE_MODES: { id: VectorizeMode; label: string; setting: "colors" | "grays" | "threshold"; settingLabel: string; min: number; max: number }[] = [
  { id: "FULL_COLOR", label: "Full color", setting: "colors", settingLabel: "Number of colors", min: 2, max: 32 },
  { id: "GRAYSCALE", label: "Grayscale", setting: "grays", settingLabel: "Number of grays", min: 2, max: 16 },
  { id: "BLACK_AND_WHITE", label: "Black and white", setting: "threshold", settingLabel: "Threshold", min: 0, max: 100 },
];

export interface VectorizeSettings {
  mode: VectorizeMode;
  colors: number;
  grays: number;
  threshold: number;
}

export const VECTORIZE_DEFAULTS: VectorizeSettings = { mode: "FULL_COLOR", colors: 8, grays: 4, threshold: 50 };
export const VECTORIZE_DEBOUNCE_MS = 120;
export const VECTORIZE_MAX_SIDE = 1024;

export const traceOptions = (s: VectorizeSettings): TraceOptions =>
  s.mode === "FULL_COLOR" ? { mode: s.mode, colors: s.colors } : s.mode === "GRAYSCALE" ? { mode: s.mode, grays: s.grays } : { mode: s.mode, threshold: s.threshold };

/** The layer's contents as drawn, the long side ≤ 1024 (tries again while its images load). */
export async function contentsPixels(ed: EditorController, id: Guid, tries = 20): Promise<Pixels> {
  const node = ed.engine.readNode(id);
  const long = Math.max(node?.size?.x ?? 1, node?.size?.y ?? 1);
  const scale = Math.min(2, VECTORIZE_MAX_SIDE / Math.max(1, long));
  for (let i = 0; i < tries; i++) {
    const out = ed.engine.exportNodes([id], { imageType: "PNG", contentsOnly: true, constraint: { type: "CONTENT_SCALE", value: scale } }, { allowPending: i === tries - 1 });
    if (out.status === "ok" && "pixels" in out) return out.pixels;
    if (out.status === "error") throw new AiRunError("unsupported", "This layer couldn't be read.");
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new AiRunError("unsupported", "This layer's image hasn't loaded yet.");
}

export class VectorizeSession {
  settings: VectorizeSettings = { ...VECTORIZE_DEFAULTS };
  stats: VectorizeStats | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private open = true;
  private readonly listeners = new Set<() => void>();

  private constructor(
    private readonly ed: EditorController,
    private readonly hooks: Pick<ToolHooks, "record">,
    readonly layer: Guid,
    readonly frame: Guid,
    private readonly debounceMs: number
  ) {}

  /** Starts on one image layer: the credits checked, the preview frame put up and traced with the defaults. */
  static async begin(ed: EditorController, hooks: Pick<ToolHooks, "checkCredits" | "record">, layer: Guid, o: { debounceMs?: number; pixels?: Pixels } = {}): Promise<VectorizeSession> {
    await hooks.checkCredits("vectorize");
    const pixels = o.pixels ?? (await contentsPixels(ed, layer));
    const begun = ed.engine.vectorizeBegin(layer, pixels);
    if (begun.status === "busy") throw new AiRunError("unsupported", "Finish what you're doing on the canvas first, then try again.");
    if (begun.status !== "ok") throw new AiRunError("unsupported", "This layer can't be vectorized.");
    const s = new VectorizeSession(ed, hooks, layer, begun.frame, o.debounceMs ?? VECTORIZE_DEBOUNCE_MS);
    s.trace();
    return s;
  }

  get active(): boolean {
    return this.open;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  /** A setting changed: the preview follows 120 ms after the last change. */
  set(patch: Partial<VectorizeSettings>): void {
    if (!this.open) return;
    this.settings = { ...this.settings, ...patch };
    this.notify();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.trace(), this.debounceMs);
  }

  /** Traces now (an update waiting is done first). */
  trace(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.open) return;
    this.stats = this.ed.engine.vectorizeUpdate(traceOptions(this.settings));
    this.notify();
  }

  get pending(): boolean {
    return this.timer !== null;
  }

  /** ✓: one undo step "Vectorize"; the frame (selected) answered. */
  apply(): Guid | null {
    if (!this.open) return null;
    if (this.timer) this.trace();
    this.open = false;
    const frame = this.ed.engine.vectorizeEnd(true);
    const colors = this.settings.mode === "FULL_COLOR" ? this.settings.colors : this.settings.mode === "GRAYSCALE" ? this.settings.grays : 2;
    this.hooks.record({ action: "vectorize", providerId: "local", model: "engine-trace", images: 1, credits: creditsFor("vectorize", { colors }), local: true, ok: !!frame });
    this.notify();
    return frame;
  }

  /** ✕ / Esc: back as it was, nothing in the history. */
  cancel(): void {
    if (!this.open) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.open = false;
    this.ed.engine.vectorizeEnd(false);
    this.notify();
  }
}
