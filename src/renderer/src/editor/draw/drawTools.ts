/**
 * Draw mode's tools (docs/draw.md §4.5, §5.1, §5.2, §5.6, §5.7; round 7c): the Pencil's and the Brush's settings kept in
 * the UI (`ui.drawTools`) and sent to the engine with `setDrawToolSettings` on every change and on entering Draw; the
 * brush list for the Brush styles menu (Figma's 25 built-in names, then the file's own BRUSH nodes), built-ins installed
 * into the file only when first used; brush previews; ⌘-click sampling (DRAW_TOOL_SAMPLED); Create brush.
 *
 * The engine side is round 7b's: until it lands, Engine.ts's Draw calls are stubs that throw "not built" — every call
 * here goes through `drawCall`, which reads that as "nothing yet" (the chrome keeps working on its own state).
 */
import { t } from "@/i18n";
import { showToast } from "@/ds";
import { CMD_ENABLED, Status } from "@/engine/abi";
import type { Pixels } from "@/engine/codec";
import {
  brushDisplayName,
  DRAW_TOOL_DEFAULTS,
  DRAW_WEIGHT_RANGE,
  DYNAMIC_RANGE,
  SCATTER_BRUSH_NAMES,
  STRETCH_BRUSH_NAMES,
  type BrushArtwork,
  type BrushEntry,
  type BrushType,
  type BuiltinBrush,
  type BuiltinBrushName,
  type DrawCommandArgs,
  type DrawToolSampled,
  type DrawToolSettings,
  type DynamicSettings,
  type GuidString,
} from "@shared/draw/types";
import type { EditorController } from "../controller";
import type { DrawToolsState } from "../uiStore";
import { modeOf } from "../devmode/devMode";

// ---- The engine's Draw calls ---------------------------------------------------------------------------------------

/** An Engine.ts Draw call; the stubs' "not built" (until round 7b) answers `fallback`, anything else is thrown. */
export function drawCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Error && /not built/.test(e.message)) return fallback;
    throw e;
  }
}

/** A Draw command (CommandId 310–321) with its typed args; E_UNSUPPORTED while the engine hasn't got it. */
export function runDraw<K extends keyof DrawCommandArgs>(ed: EditorController, id: K, args: DrawCommandArgs[K]): number {
  return drawCall(() => ed.engine.runDrawCommand(id, args), Status.E_UNSUPPORTED);
}

// ---- Built-in brushes ----------------------------------------------------------------------------------------------

/**
 * The built-ins' own artwork (round 7e's `src/shared/draw/brushes/`, docs/draw.md §6): picked up by the bundler when
 * the module exists, none before (the menu still lists Figma's 25 names; one can't be installed without artwork).
 */
const brushModules = import.meta.glob<{ BUILTIN_BRUSHES?: readonly BuiltinBrush[] }>("../../../../shared/draw/brushes/index.ts", { eager: true });
let builtins: readonly BuiltinBrush[] = Object.values(brushModules)[0]?.BUILTIN_BRUSHES ?? [];

/** Replaces the built-ins' artwork (tests; a later asset set). */
export function setBuiltinBrushes(list: readonly BuiltinBrush[]): void {
  builtins = list;
}

export const builtinArtwork = (key: BuiltinBrushName): BrushArtwork | null => builtins.find((b) => b.key === key)?.artwork ?? null;

export const builtinType = (key: BuiltinBrushName): BrushType => ((STRETCH_BRUSH_NAMES as readonly string[]).includes(key) ? "STRETCH" : "SCATTER");

/** The built-in a BRUSH node is (by its name and type, as INSTALL_BRUSH names it), or null for a custom brush. */
export function builtinOf(name: string, type: BrushType): BuiltinBrushName | null {
  const keys: readonly BuiltinBrushName[] = type === "STRETCH" ? STRETCH_BRUSH_NAMES : SCATTER_BRUSH_NAMES;
  return keys.find((k) => brushDisplayName(k) === name) ?? null;
}

// ---- The tools' settings -------------------------------------------------------------------------------------------

/** The Brush's first brush [unverified] (docs/draw.md §5.2). */
export const DEFAULT_BRUSH: BuiltinBrushName = "HEIST";

export const DRAW_TOOLS_DEFAULT: DrawToolsState = {
  settings: DRAW_TOOL_DEFAULTS,
  brush: { name: brushDisplayName(DEFAULT_BRUSH), type: builtinType(DEFAULT_BRUSH), builtin: DEFAULT_BRUSH, guid: null },
};

export const drawToolsOf = (ed: EditorController): DrawToolsState => ed.ui.get().drawTools ?? DRAW_TOOLS_DEFAULT;

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

/** The settings to the engine (on change, on entering Draw, after sampling). */
export function sendDrawTools(ed: EditorController): number {
  if (ed.engine.destroyed) return Status.E_HANDLE;
  const s = drawToolsOf(ed).settings;
  return drawCall(() => ed.engine.setDrawToolSettings(s), Status.E_UNSUPPORTED);
}

function update(ed: EditorController, next: DrawToolsState): void {
  ed.ui.set({ drawTools: next });
  sendDrawTools(ed);
}

/** The Pencil's colour, opacity, weight, style or Dynamic settings (each clamped to its range). */
export function setPencil(ed: EditorController, patch: Partial<Omit<DrawToolSettings["pencil"], "dynamic">> & { dynamic?: Partial<DynamicSettings> }): void {
  const cur = drawToolsOf(ed);
  const p = cur.settings.pencil;
  const d = { ...p.dynamic, ...patch.dynamic };
  const pencil = {
    ...p,
    ...patch,
    weight: clamp(patch.weight ?? p.weight, DRAW_WEIGHT_RANGE),
    dynamic: { frequency: clamp(d.frequency, DYNAMIC_RANGE.frequency), wiggle: clamp(d.wiggle, DYNAMIC_RANGE.wiggle), smoothen: clamp(d.smoothen, DYNAMIC_RANGE.smoothen) },
  };
  update(ed, { ...cur, settings: { ...cur.settings, pencil } });
}

/** The Brush's colour, opacity or weight (its brush: `chooseBrush`). */
export function setBrushTool(ed: EditorController, patch: Partial<Omit<DrawToolSettings["brush"], "brush">>): void {
  const cur = drawToolsOf(ed);
  const b = cur.settings.brush;
  update(ed, { ...cur, settings: { ...cur.settings, brush: { ...b, ...patch, weight: clamp(patch.weight ?? b.weight, DRAW_WEIGHT_RANGE) } } });
}

// ---- Brushes -------------------------------------------------------------------------------------------------------

/** The Brush styles menu's sections (docs/draw.md §5.6; section names [unverified]). */
export interface BrushSections {
  stretch: BrushEntry[];
  scatter: BrushEntry[];
  /** This file's BRUSH nodes that aren't built-ins */
  custom: BrushEntry[];
}

/** Figma's 25 built-ins in Figma's order (with their GUIDs where this file has them), then the file's own brushes. */
export function brushSections(ed: EditorController): BrushSections {
  const installed = drawCall(() => ed.engine.listBrushes(), []);
  const builtin = (key: BuiltinBrushName): BrushEntry => {
    const type = builtinType(key);
    const name = brushDisplayName(key);
    return { guid: installed.find((b) => b.name === name && b.type === type)?.guid ?? null, name, type, builtin: key };
  };
  return {
    stretch: STRETCH_BRUSH_NAMES.map(builtin),
    scatter: SCATTER_BRUSH_NAMES.map(builtin),
    custom: installed.filter((b) => !builtinOf(b.name, b.type)).map((b) => ({ guid: b.guid, name: b.name, type: b.type, builtin: null })),
  };
}

/**
 * A brush's BRUSH node in this file: its GUID, a built-in installed first (INSTALL_BRUSH answers the existing node when
 * the file has it). Null when it can't be: no artwork for that built-in yet, or no engine support.
 */
export function installedBrush(ed: EditorController, entry: Pick<BrushEntry, "guid" | "builtin">): GuidString | null {
  if (entry.guid) return entry.guid;
  if (!entry.builtin) return null;
  const artwork = builtinArtwork(entry.builtin);
  if (!artwork) return null;
  const key = entry.builtin;
  return drawCall(() => ed.engine.installBrush({ name: brushDisplayName(key), type: builtinType(key), artwork }), null);
}

/** The Brush styles menu's pick: the Brush draws with it from now on (a built-in installed into the file first). */
export function chooseBrush(ed: EditorController, entry: BrushEntry): GuidString | null {
  const guid = installedBrush(ed, entry);
  const cur = drawToolsOf(ed);
  update(ed, {
    brush: { name: entry.name, type: entry.type, builtin: entry.builtin, guid },
    settings: { ...cur.settings, brush: { ...cur.settings.brush, brush: guid } },
  });
  return guid;
}

/** The Brush became the tool: its brush installed now if it is a built-in the file hasn't got yet. */
export function ensureBrushInstalled(ed: EditorController): void {
  const cur = drawToolsOf(ed);
  if (cur.brush.guid || !cur.brush.builtin) return;
  const guid = installedBrush(ed, cur.brush);
  if (guid) update(ed, { brush: { ...cur.brush, guid }, settings: { ...cur.settings, brush: { ...cur.settings.brush, brush: guid } } });
}

// ---- Previews ------------------------------------------------------------------------------------------------------

/** A preview's stroke weight (CSS px) along the engine's S-curve [ours]. */
export const PREVIEW_WEIGHT = 6;

const previews = new WeakMap<object, Map<string, string | null>>();

/** RGBA → a PNG data URL (null without a 2D canvas: tests). */
function pixelsToUrl(px: Pixels): string | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = px.width;
  c.height = px.height;
  const g = c.getContext?.("2d");
  if (!g) return null;
  g.putImageData(new ImageData(new Uint8ClampedArray(px.pixels), px.width, px.height), 0, 0);
  return c.toDataURL("image/png");
}

/**
 * A brush drawn along the engine's fixed S-curve (`brushPreview`), as a data URL, cached per engine and brush. The
 * menus use it as a mask over the icon colour, so one image serves both themes. Null while there is nothing to draw.
 */
export function brushPreviewUrl(ed: EditorController, entry: Pick<BrushEntry, "guid" | "builtin" | "type">, width: number, height: number): string | null {
  const dpr = typeof window !== "undefined" ? Math.max(1, Math.round(window.devicePixelRatio || 1)) : 1;
  const key = `${entry.guid ?? `builtin:${entry.builtin}`}@${width}x${height}@${dpr}`;
  let cache = previews.get(ed.engine);
  if (!cache) previews.set(ed.engine, (cache = new Map()));
  if (cache.has(key)) return cache.get(key)!;
  const artwork = !entry.guid && entry.builtin ? builtinArtwork(entry.builtin) : null;
  const src = entry.guid ? { brush: entry.guid } : artwork ? { artwork, type: entry.type } : null;
  const px = src ? drawCall(() => ed.engine.brushPreview(src, width * dpr, height * dpr, PREVIEW_WEIGHT * dpr), null) : null;
  const url = px ? pixelsToUrl(px) : null;
  // Nothing drawn yet (no engine support, no artwork) isn't cached: a later engine may draw it.
  if (url) cache.set(key, url);
  return url;
}

// ---- Commands ------------------------------------------------------------------------------------------------------

/** Layers whose geometry can become a brush (CREATE_BRUSH checks it is closed). */
const VECTOR_LIKE = new Set(["VECTOR", "RECTANGLE", "ROUNDED_RECTANGLE", "ELLIPSE", "REGULAR_POLYGON", "STAR", "LINE", "BOOLEAN_OPERATION"]);

/** A layer type Create brush ▸ is offered for. */
export const isBrushSource = (type: unknown): boolean => VECTOR_LIKE.has(String(type));

const engineEnabled = (ed: EditorController, name: "CREATE_BRUSH" | "APPLY_TRANSFORMS" | "FLIP_TEXT_PATH") => !ed.engine.destroyed && (ed.engine.commandState(name) & CMD_ENABLED) !== 0;

const selectedTypes = (ed: EditorController): string[] => ed.selectedNodes().map((n) => String(n.type));

/** Create brush ▸: one vector-like layer selected, and the engine can (docs/draw.md §5.7). */
export function canCreateBrush(ed: EditorController): boolean {
  if (ed.selection.length !== 1) return false;
  const [type] = selectedTypes(ed);
  return VECTOR_LIKE.has(type) && engineEnabled(ed, "CREATE_BRUSH");
}

/** Right-click › Create brush › Stretch brush / Scatter brush: a BRUSH node from the layer's closed geometry. */
export function createBrush(ed: EditorController, brushType: BrushType): number {
  const ref = ed.selection[0];
  if (!ref) return Status.E_INVALID;
  const status = runDraw(ed, "CREATE_BRUSH", { ref, brushType });
  // [wording ours] (docs/draw.md §4.5): Figma's help says only closed vector paths can be sources.
  if (status === Status.E_INVALID) showToast({ message: t("Only closed paths can be used as brushes") });
  return status;
}

/** "Apply transforms to selection": a transform group (TRANSFORM) selected. */
export const canApplyTransforms = (ed: EditorController): boolean => selectedTypes(ed).includes("TRANSFORM") && engineEnabled(ed, "APPLY_TRANSFORMS");

export const applyTransforms = (ed: EditorController): number => runDraw(ed, "APPLY_TRANSFORMS", {});

/** Flip (text on a path): a TEXT_PATH selected. */
export const canFlipTextPath = (ed: EditorController): boolean => selectedTypes(ed).includes("TEXT_PATH") && engineEnabled(ed, "FLIP_TEXT_PATH");

export const flipTextPath = (ed: EditorController): number => runDraw(ed, "FLIP_TEXT_PATH", {});

// ---- Sampling and the mode -----------------------------------------------------------------------------------------

/** ⌘-click with the Pencil or the Brush on a stroke (DRAW_TOOL_SAMPLED): its colour, weight and style become the tool's. */
export function applySampled(ed: EditorController, e: DrawToolSampled): void {
  const cur = drawToolsOf(ed);
  if (e.tool === "PENCIL") {
    const pencil = { ...cur.settings.pencil, color: e.color, opacity: e.opacity, weight: e.weight, kind: e.kind === "DYNAMIC" ? ("DYNAMIC" as const) : ("BASIC" as const), dynamic: e.dynamic ?? cur.settings.pencil.dynamic };
    update(ed, { ...cur, settings: { ...cur.settings, pencil } });
    return;
  }
  let brushShown = cur.brush;
  if (e.brush && e.brush !== cur.brush.guid) {
    const node = drawCall(() => ed.engine.listBrushes(), []).find((b) => b.guid === e.brush);
    if (node) brushShown = { name: node.name, type: node.type, builtin: builtinOf(node.name, node.type), guid: node.guid };
  }
  const brush = { ...cur.settings.brush, color: e.color, opacity: e.opacity, weight: e.weight, brush: e.brush ?? cur.settings.brush.brush };
  update(ed, { brush: brushShown, settings: { ...cur.settings, brush } });
}

/**
 * Draw's tools follow the editor: the settings go to the engine on entering Draw; leaving it with the Brush puts the
 * Move tool back (Design has no Brush); the Brush taking over installs its built-in; ⌘-click samples.
 */
export function attachDrawTools(ed: EditorController): () => void {
  let mode = modeOf(ed);
  if (mode === "draw") sendDrawTools(ed);
  const offUi = ed.ui.subscribe(() => {
    const next = modeOf(ed);
    if (next === mode) return;
    const left = mode === "draw";
    mode = next;
    if (next === "draw") sendDrawTools(ed);
    else if (left && ed.store.tool === "BRUSH") ed.setTool("MOVE");
  });
  const offTool = ed.store.subscribe("tool", () => {
    if (ed.store.tool === "BRUSH") ensureBrushInstalled(ed);
  });
  const offSampled = ed.engine.on("DRAW_TOOL_SAMPLED", (e) => applySampled(ed, e));
  return () => {
    offUi();
    offTool();
    offSampled();
  };
}
