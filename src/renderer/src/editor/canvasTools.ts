/**
 * Round 8's canvas tools on the editor's side (docs/engine-build.md "Round 8 — selection", docs/editor.md): the view
 * options sent to the engine whenever the UI changes them (rulers, Snap to pixel grid, Show slices, Pixel preview…),
 * Preferences › Nudge amount (kept per machine), the eyedropper's pick (COLOR_PICK: the canvas pixel under the
 * pointer becomes the selection's fill), an auto-layout bar's value edited in place (REQUEST_INLINE_EDIT), the
 * Comment tool's note (comments come with multiplayer), and the text size / weight / spacing keys.
 */
import { showToast } from "@/ds";
import type { Guid, NodeChange, NodeFields } from "@/engine/codec";
import type { EditorController } from "./controller";
import type { UIState } from "./uiStore";
import { fields } from "./panels/design/shared";

/** The engine's view options as the UI holds them (defaults: pixel grid, layout guides, snap to pixel grid, slices on). */
export function viewOptionsOf(ui: UIState) {
  return {
    pixelGrid: ui.pixelGrid !== false,
    outlines: !!ui.outlines,
    layoutGuides: ui.layoutGuides !== false,
    rulers: !!ui.rulers,
    snapToPixelGrid: ui.snapToPixelGrid !== false,
    showSlices: ui.showSlices !== false,
    pixelPreview: (ui.pixelPreview ?? 0) as 0 | 1 | 2,
  };
}

const viewKey = (o: ReturnType<typeof viewOptionsOf>) => JSON.stringify(o);

/** Sends the view options now (and remembers them, so the next UI change sends only a difference). */
export function syncViewOptions(ed: EditorController): void {
  const options = viewOptionsOf(ed.ui.get());
  lastSent.set(ed, viewKey(options));
  ed.engine.setViewOptions(options);
}
const lastSent = new WeakMap<EditorController, string>();

/** Preferences › Nudge amount…: Small nudge, Big nudge (Figma's defaults 1 and 10), kept per machine. */
export interface NudgeAmounts {
  small: number;
  big: number;
}
const NUDGE_KEY = "designer.nudge";
export const DEFAULT_NUDGE: NudgeAmounts = { small: 1, big: 10 };

export function loadNudge(): NudgeAmounts {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(NUDGE_KEY) : null;
    if (!raw) return DEFAULT_NUDGE;
    const v = JSON.parse(raw) as Partial<NudgeAmounts>;
    const ok = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0;
    return { small: ok(v.small) ? v.small! : DEFAULT_NUDGE.small, big: ok(v.big) ? v.big! : DEFAULT_NUDGE.big };
  } catch {
    return DEFAULT_NUDGE;
  }
}

export function setNudge(ed: EditorController, amounts: NudgeAmounts): void {
  ed.engine.setNudge(amounts.small, amounts.big);
  ed.ui.set({ nudge: amounts });
  try {
    localStorage.setItem(NUDGE_KEY, JSON.stringify(amounts));
  } catch {
    // no storage (a test, a private window): this session only
  }
}

/** The colour of the canvas pixel at (x, y) (canvas CSS px) as drawn — the page's layers over its colour, no overlays. */
export function canvasColorAt(ed: EditorController, x: number, y: number): { r: number; g: number; b: number } | null {
  const cam = ed.engine.getCamera();
  if (!(cam.zoom > 0)) return null;
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  // One device pixel's worth of the page under the point.
  const unit = 1 / (cam.zoom * dpr);
  const wx = (x - cam.x) / cam.zoom, wy = (y - cam.y) / cam.zoom;
  const px = ed.engine.renderRegionPixels({ x: wx - unit / 2, y: wy - unit / 2, w: unit, h: unit, width: 1, height: 1 });
  if (!px || px.pixels.length < 4) return null;
  return { r: px.pixels[0] / 255, g: px.pixels[1] / 255, b: px.pixels[2] / 255 };
}

/** The canvas's pixels around (x, y): `size` × `size` device pixels centred there (the eyedropper's loupe). */
export function canvasPixelsAround(ed: EditorController, x: number, y: number, size: number) {
  const cam = ed.engine.getCamera();
  if (!(cam.zoom > 0)) return null;
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const unit = 1 / (cam.zoom * dpr);
  // Snapped to the device pixel grid so each loupe cell is one screen pixel.
  const dx = Math.floor(x * dpr) / dpr, dy = Math.floor(y * dpr) / dpr;
  const wx = (dx - cam.x) / cam.zoom - Math.floor(size / 2) * unit, wy = (dy - cam.y) / cam.zoom - Math.floor(size / 2) * unit;
  return ed.engine.renderRegionPixels({ x: wx, y: wy, w: unit * size, h: unit * size, width: size, height: size });
}

/** The eyedropper's pick: the selected layers' fill becomes the colour (their first solid fill's, else a new fill). */
export function applyPickedColor(ed: EditorController, color: { r: number; g: number; b: number }): void {
  const nodes = ed.selectedNodes();
  const hex = `#${[color.r, color.g, color.b].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
  if (!nodes.length) {
    // Nothing selected: the colour is noted (Figma shows it in the picker; here a toast with its hex).
    showToast({ message: `Picked ${hex}` });
    return;
  }
  ed.batch("Pick color", () => {
    for (const n of nodes) {
      const paints = ((n as NodeChange & { fillPaints?: unknown[] }).fillPaints ?? []) as Record<string, unknown>[];
      const at = paints.findIndex((p) => p.type === "SOLID");
      const solid = { type: "SOLID", color: { ...color, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" };
      const next = at >= 0 ? paints.map((p, i) => (i === at ? { ...p, color: { ...color, a: 1 } } : p)) : [...paints, solid];
      ed.setProps([n.guid], fields({ fillPaints: next } as unknown as NodeFields), "Pick color");
    }
  });
}

/** REQUEST_INLINE_EDIT's field → the auto-layout field it writes. */
const INLINE_FIELD = {
  PADDING_LEFT: "stackHorizontalPadding",
  PADDING_TOP: "stackVerticalPadding",
  PADDING_RIGHT: "stackPaddingRight",
  PADDING_BOTTOM: "stackPaddingBottom",
  GAP: "stackSpacing",
} as const;
export type InlineField = keyof typeof INLINE_FIELD;

/** An auto-layout bar's value typed in place: the padding, or the gap (an Auto gap becomes that number). */
export function commitInlineValue(ed: EditorController, ref: Guid, field: InlineField, value: number): void {
  if (!Number.isFinite(value)) return;
  const v = Math.max(0, value);
  if (field === "GAP") {
    ed.setProps([ref], fields({ stackSpacing: v, stackPrimaryAlignItems: "MIN" } as unknown as NodeFields), "Gap");
    return;
  }
  ed.setProps([ref], fields({ [INLINE_FIELD[field]]: v } as unknown as NodeFields), "Padding");
}

/**
 * Text › Adjust (help.figma.com keyboard shortcuts): font size ±1 (⇧⌘. / ⇧⌘,), weight to the next / previous style
 * of the family (⌥⌘. / ⌥⌘,), line height ±1 px (⌥⇧. / ⌥⇧,), letter spacing ±1 % (⌥. / ⌥,) — on the selected text
 * layers. The steps are unverified.
 */
export type TextAdjust = "size" | "weight" | "lineHeight" | "letterSpacing";
const WEIGHTS = ["Thin", "ExtraLight", "Light", "Regular", "Medium", "SemiBold", "Bold", "ExtraBold", "Black"];

export function adjustText(ed: EditorController, refs: Guid[], what: TextAdjust, dir: 1 | -1): void {
  const nodes = refs.map((r) => ed.store.readNode(r) as (NodeChange & Record<string, unknown>) | null).filter((n): n is NodeChange & Record<string, unknown> => !!n);
  if (!nodes.length) return;
  const label = what === "size" ? "Font size" : what === "weight" ? "Font weight" : what === "lineHeight" ? "Line height" : "Letter spacing";
  ed.batch(label, () => {
    for (const n of nodes) {
      const size = typeof n.fontSize === "number" ? n.fontSize : 12;
      if (what === "size") {
        ed.setProps([n.guid], fields({ fontSize: Math.max(1, size + dir) } as unknown as NodeFields), label);
      } else if (what === "weight") {
        const font = n.fontName as { family: string; style: string } | undefined;
        if (!font) continue;
        const italic = /italic/i.test(font.style);
        const base = font.style.replace(/\s*italic/i, "").replace(/\s+/g, "") || "Regular";
        const at = WEIGHTS.findIndex((w) => w.toLowerCase() === base.toLowerCase());
        const next = WEIGHTS[Math.max(0, Math.min(WEIGHTS.length - 1, (at < 0 ? 3 : at) + dir))];
        const style = italic ? (next === "Regular" ? "Italic" : `${next} Italic`) : next;
        ed.setProps([n.guid], fields({ fontName: { family: font.family, style, postscript: "" } } as unknown as NodeFields), label);
      } else if (what === "lineHeight") {
        const lh = n.lineHeight as { value: number; units: string } | undefined;
        const px = lh?.units === "PIXELS" ? lh.value : lh?.units === "RAW" ? lh.value * size : Math.round(size * 1.2);
        ed.setProps([n.guid], fields({ lineHeight: { value: Math.max(0, Math.round(px + dir)), units: "PIXELS" } } as unknown as NodeFields), label);
      } else {
        const ls = n.letterSpacing as { value: number; units: string } | undefined;
        const value = (ls?.value ?? 0) + dir;
        ed.setProps([n.guid], fields({ letterSpacing: { value, units: ls?.units ?? "PERCENT" } } as unknown as NodeFields), label);
      }
    }
  });
}

/** Wires round 8's engine events and view options; returns the detach. */
export function attachCanvasTools(ed: EditorController, canvas: HTMLCanvasElement): () => void {
  const offs: (() => void)[] = [];
  syncViewOptions(ed);
  offs.push(
    ed.ui.subscribe(() => {
      const options = viewOptionsOf(ed.ui.get());
      if (lastSent.get(ed) === viewKey(options)) return;
      lastSent.set(ed, viewKey(options));
      ed.engine.setViewOptions(options);
    })
  );
  const nudge = loadNudge();
  ed.engine.setNudge(nudge.small, nudge.big);
  ed.ui.set({ nudge });
  offs.push(
    ed.engine.on("COLOR_PICK", (e) => {
      const color = canvasColorAt(ed, e.x, e.y);
      if (color) applyPickedColor(ed, color);
    })
  );
  offs.push(
    ed.engine.on("REQUEST_INLINE_EDIT", (e) => {
      const r = canvas.getBoundingClientRect();
      ed.ui.set({ inlineValueEdit: { ref: e.ref, field: e.field, value: e.value, x: r.left + e.x, y: r.top + e.y, width: Math.max(40, e.width), height: Math.max(20, e.height) } });
    })
  );
  // The field goes when the canvas moves under it.
  offs.push(
    ed.engine.on("CAMERA_CHANGED", () => {
      if (ed.ui.get().inlineValueEdit) ed.ui.set({ inlineValueEdit: null });
    })
  );
  offs.push(
    ed.engine.on("TOOL_CHANGED", (e) => {
      if (e.tool === "COMMENT") showToast({ message: "Comments come with multiplayer" });
    })
  );
  return () => offs.forEach((off) => off());
}
