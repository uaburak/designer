/**
 * Vectorize's live preview on the engine's tracer (docs/ai.md §5, 6e's API): begin with the layer's contents as drawn
 * (`exportNodes` contents only, the long side ≤ 1024) → updates debounced by 120 ms as the mode and its setting change
 * → ✓ or Enter commits one undo step "Vectorize" (the traced frame, "<name> [Vectorized]", takes the image layer's
 * place and is selected; the image layer is hidden, kept) or ✕ cancels (nothing in the history). Figma's Recolor
 * (atlas 18 §7.7): "Full color" (Number of colors: 1 … the colours the vector came back with), "Grayscale" (Number of
 * grays: the same rule), "Black and white" (Threshold 0–1, step 0.01, big step 0.1, default 0.5). Figma's server
 * answers the vector at once; here the first trace asks for up to 16 colours and its count is the sliders' maximum.
 */
import { t } from "@/i18n";
import type { Guid, Pixels } from "@/engine/codec";
import type { VectorizeStats } from "@/engine/Engine";
import { AiRunError } from "../../../../shared/ai/api";
import { creditsFor, type TraceOptions } from "../../../../shared/ai/types";
import type { EditorController } from "../controller";
import type { ToolHooks } from "./tools";

export type VectorizeMode = TraceOptions["mode"];

export const VECTORIZE_MODES: { id: VectorizeMode; label: string; setting: "colors" | "grays" | "threshold"; settingLabel: string; min: number; max: number; step: number; bigStep: number }[] = [
  { id: "FULL_COLOR", label: "Full color", setting: "colors", settingLabel: "Number of colors", min: 1, max: 32, step: 1, bigStep: 10 },
  { id: "GRAYSCALE", label: "Grayscale", setting: "grays", settingLabel: "Number of grays", min: 1, max: 16, step: 1, bigStep: 10 },
  { id: "BLACK_AND_WHITE", label: "Black and white", setting: "threshold", settingLabel: "Threshold", min: 0, max: 1, step: 0.01, bigStep: 0.1 },
];

export interface VectorizeSettings {
  mode: VectorizeMode;
  colors: number;
  grays: number;
  /** 0–1 (the engine's 0–100) */
  threshold: number;
}

/** The first trace's colours [ours: Figma's server decides how many it answers]. */
export const VECTORIZE_DETECT_COLORS = 16;
export const VECTORIZE_DEFAULTS: VectorizeSettings = { mode: "FULL_COLOR", colors: VECTORIZE_DETECT_COLORS, grays: VECTORIZE_DETECT_COLORS, threshold: 0.5 };
export const VECTORIZE_DEBOUNCE_MS = 120;
export const VECTORIZE_MAX_SIDE = 1024;

/** Figma's render limits (atlas 18 §7.7, 3187 `m` / `T`): the layer scaled into 256…4096 px a side, 5 MP at most. */
export const VECTORIZE_RENDER = { max: 4096, min: 256, area: 5_242_880 } as const;

/**
 * Figma's check before tracing: the layer's size scaled down so its long side is 4096 (or up so its short side is 256);
 * still past 4096 or under 256 on a side, or over 5 MP → too large / too small. Ours traces its own ≤ 1024 px copy.
 */
export function vectorizeRenderSize(size: { x: number; y: number }): { width: number; height: number } {
  const long = Math.max(size.x, size.y);
  const short = Math.min(size.x, size.y);
  const r = long > VECTORIZE_RENDER.max ? VECTORIZE_RENDER.max / long : short < VECTORIZE_RENDER.min ? VECTORIZE_RENDER.min / short : 1;
  const width = size.x * r;
  const height = size.y * r;
  if (width > VECTORIZE_RENDER.max || height > VECTORIZE_RENDER.max) throw new AiRunError("unsupported", t("This layer is too large to vectorize."));
  if (width < VECTORIZE_RENDER.min || height < VECTORIZE_RENDER.min) throw new AiRunError("unsupported", t("This layer is too small to vectorize."));
  if (width * height > VECTORIZE_RENDER.area) throw new AiRunError("unsupported", t("This layer is too large to vectorize."));
  return { width, height };
}

export const traceOptions = (s: VectorizeSettings): TraceOptions =>
  s.mode === "FULL_COLOR" ? { mode: s.mode, colors: s.colors } : s.mode === "GRAYSCALE" ? { mode: s.mode, grays: s.grays } : { mode: s.mode, threshold: Math.round(s.threshold * 10000) / 100 };

/** The layer's contents as drawn, the long side ≤ 1024 (tries again while its images load). */
export async function contentsPixels(ed: EditorController, id: Guid, tries = 20): Promise<Pixels> {
  const node = ed.engine.readNode(id);
  const long = Math.max(node?.size?.x ?? 1, node?.size?.y ?? 1);
  const scale = Math.min(2, VECTORIZE_MAX_SIDE / Math.max(1, long));
  for (let i = 0; i < tries; i++) {
    const out = ed.engine.exportNodes([id], { imageType: "PNG", contentsOnly: true, constraint: { type: "CONTENT_SCALE", value: scale } }, { allowPending: i === tries - 1 });
    if (out.status === "ok" && "pixels" in out) return out.pixels;
    if (out.status === "error") throw new AiRunError("unsupported", t("This layer couldn't be read."));
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new AiRunError("unsupported", t("This layer's image hasn't loaded yet."));
}

export class VectorizeSession {
  settings: VectorizeSettings = { ...VECTORIZE_DEFAULTS };
  stats: VectorizeStats | null = null;
  /** The colours the first trace came back with: the colour and gray sliders' maximum */
  detected = VECTORIZE_DETECT_COLORS;
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
    const size = ed.engine.readNode(layer, { fields: ["size"] })?.size;
    if (size) vectorizeRenderSize(size);
    await hooks.checkCredits("vectorize");
    const pixels = o.pixels ?? (await contentsPixels(ed, layer));
    const begun = ed.engine.vectorizeBegin(layer, pixels);
    if (begun.status === "busy") throw new AiRunError("unsupported", t("Finish what you're doing on the canvas first, then try again."));
    if (begun.status !== "ok") throw new AiRunError("unsupported", t("This layer can't be vectorized."));
    const s = new VectorizeSession(ed, hooks, layer, begun.frame, o.debounceMs ?? VECTORIZE_DEBOUNCE_MS);
    s.trace();
    s.detected = Math.max(1, s.stats?.exceeded ? VECTORIZE_DETECT_COLORS : (s.stats?.layers ?? 1));
    s.settings = { ...s.settings, colors: s.detected, grays: Math.min(16, s.detected) };
    return s;
  }

  /** A mode's setting's range (Figma's: the colours and grays from 1 to what the vector came back with). */
  range(mode: VectorizeMode): { min: number; max: number; step: number; bigStep: number } {
    const m = VECTORIZE_MODES.find((x) => x.id === mode)!;
    return { min: m.min, max: m.setting === "threshold" ? m.max : Math.min(m.max, this.detected), step: m.step, bigStep: m.bigStep };
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

  /** ✓ / Enter: one undo step "Vectorize"; the frame (selected) answered. */
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
