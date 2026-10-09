/**
 * The editor's commands (docs/editor.md §5): one registry for the main menu,
 * the canvas context menu, the shortcut layer and the panel buttons. Labels
 * and keys are Figma's (docs/research/figma/R7-editor.md). A command the
 * engine doesn't implement yet reads as disabled (its commandState).
 */
import { CMD_ENABLED, type CommandName, type ToolName } from "@/engine/abi";
import { currentTheme, IS_MAC, keys as keyText, setThemePreference, showToast, type ThemePreference } from "@/ds";
import type { EditorController } from "./controller";
import { rotateSelection, zoomTo } from "./actions";
import { copyFromMenu, pasteFromMenu } from "./clipboardIO";
import { engineCommandEnabled, runEngineCommand } from "./engineCompat";
import { chooseAndPlaceImages } from "./canvas/ImagePlacer";
import { canExport, copyAsCode, copyAsPng, copyAsSvg, copyAsText, exportFramesToPdf, hasTextSelected } from "./exporting";
import { present, togglePreview } from "./present";
import { setDevStatus, statusOfTargets, statusTargets } from "./devStatus";
import { annotationsShown, modeOf, setMode, toggleAnnotations } from "./devmode/devMode";
import { textSummary, toggledBold, toggledItalic } from "./model/text";
import { fields, type ExtraFields } from "./panels/design/shared";
import type { Guid } from "@/engine/codec";
import { COMPONENT_COMMAND, canPushChanges, goToMainComponent, instanceChanges, mainOf, pageOf, resetChanges, returnToInstance, selectedInstance } from "./components";
import { collapsedLayers } from "./model/layerTree";
import { openFind, stepFind } from "./find";
import { adjustText, syncViewOptions, type TextAdjust } from "./canvasTools";
import { PREFERENCES, pref, togglePreference } from "./preferences";

export interface KeyCombo {
  /** KeyboardEvent.code */
  code: string;
  /** ⌘ on a Mac, Ctrl elsewhere */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** ⌃ (a Mac's Control) */
  ctrl?: boolean;
}

export interface EditorCommand {
  id: string;
  /** Figma's wording */
  label: string;
  /** The first is shown in menus and tooltips */
  keys?: KeyCombo[];
  /** The browser's default action does it (⌘C / ⌘X / ⌘V fire the DOM clipboard events); `prepare` runs first */
  native?: boolean;
  prepare?(ed: EditorController): void;
  run(ed: EditorController): void;
  enabled?(ed: EditorController): boolean;
  checked?(ed: EditorController): boolean;
}

const KEY_LABEL: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Equal: "+",
  Minus: "–", // live: Zoom out ⌘–
  Slash: "/",
  Quote: "′", // live menus: ⇧′, ⇧⌘′
  Comma: ",",
  Period: ".",
  Backspace: "backspace",
  Delete: "delete",
  Enter: "enter",
  Escape: "escape",
  Tab: "tab",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  PageUp: "pageup", // live: Previous page 🌐↑ on a Mac
  PageDown: "pagedown",
};

/** A combo as Figma writes it ("⇧⌘H", "⌥⌘G", "⌃⇧?"). */
export function comboText(c: KeyCombo): string {
  let key = KEY_LABEL[c.code] ?? c.code.replace(/^Key|^Digit/, "");
  if (c.code === "Slash" && c.shift) key = "?";
  const parts = [...(c.ctrl ? ["ctrl"] : []), ...(c.alt ? ["alt"] : []), ...(c.shift ? ["shift"] : []), ...(c.mod ? ["mod"] : []), key];
  return keyText(parts);
}

/** Does the event press this combo? (`primary`: ⌘ on a Mac, Ctrl elsewhere) */
export function matchesCombo(c: KeyCombo, e: Pick<KeyboardEvent, "code" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">, mac = IS_MAC): boolean {
  const primary = mac ? e.metaKey : e.ctrlKey;
  const ctrl = mac ? e.ctrlKey : false;
  return c.code === e.code && !!c.mod === primary && !!c.shift === e.shiftKey && !!c.alt === e.altKey && !!c.ctrl === ctrl;
}

const k = (code: string, mods: Omit<KeyCombo, "code"> = {}): KeyCombo => ({ code, ...mods });
const hasSelection = (ed: EditorController) => ed.selection.length > 0;

/** An engine command (in abi.ts or still pending): enabled as the engine says. */
function engine(id: string, label: string, name: CommandName, keys?: KeyCombo[], extra: Partial<EditorCommand> = {}): EditorCommand {
  return {
    id,
    label,
    keys,
    run: (ed) => {
      ed.engine.command(name);
    },
    enabled: (ed) => (ed.engine.commandState(name) & CMD_ENABLED) !== 0,
    ...extra,
  };
}

function tool(id: string, label: string, name: ToolName, keys: KeyCombo[]): EditorCommand {
  return {
    id,
    label,
    keys,
    run: (ed) => ed.setTool(name),
    enabled: (ed) => ed.tools.has(name),
    checked: (ed) => ed.store.tool === name,
  };
}

function ui(id: string, label: string, keys: KeyCombo[] | undefined, run: (ed: EditorController) => void, checked?: (ed: EditorController) => boolean): EditorCommand {
  return { id, label, keys, run, checked };
}

/** Preferences ▸ Theme: the app-wide choice (ds/theme.ts; main owns it on the desktop). */
const theme = (id: string, label: string, preference: ThemePreference): EditorCommand => ({
  id,
  label,
  run: () => setThemePreference(preference),
  checked: () => currentTheme().preference === preference,
});

/**
 * An engine command a later milestone brings (E4's booleans, Flatten, masks…): runs and enables itself once
 * abi.ts names it and the engine says it can run; until then shown, disabled.
 */
function pending(id: string, label: string, name: string, keys?: KeyCombo[], extra: Partial<EditorCommand> = {}): EditorCommand {
  return {
    id,
    label,
    keys,
    run: (ed) => {
      runEngineCommand(ed.engine, name);
    },
    enabled: (ed) => engineCommandEnabled(ed.engine, name),
    ...extra,
  };
}

/** ⇧⌘K "Image/video…" / "Place image…": the system's file picker, then Figma's placing (canvas/ImagePlacer.tsx). */
const placeImage = (id: string, label: string, keys?: KeyCombo[]): EditorCommand => ({
  id,
  label,
  keys,
  run: (ed) => void chooseAndPlaceImages(ed),
  enabled: (ed) => !!ed.images.store,
  checked: (ed) => id === "tool.image" && !!ed.ui.get().placingImages?.length,
});

/** Not built yet: shown, disabled (Figma's menus list them). */
const later = (id: string, label: string, keys?: KeyCombo[]): EditorCommand => ({ id, label, keys, run: () => {}, enabled: () => false });

/** One of Figma's own web pages (Help and account ▸), in the browser (the desktop app opens it outside). */
const link = (id: string, label: string, url: string): EditorCommand => ({ id, label, run: () => void window.open(url, "_blank", "noopener") });

/** The text layers a Text command acts on: the edited one, else the selected texts. */
export function textRefs(ed: EditorController): Guid[] {
  const editing = ed.engine.textEdit?.ref;
  if (editing) return [editing];
  return ed.selectedNodes().filter((n) => n.type === "TEXT").map((n) => n.guid);
}

const textCommand = (id: string, label: string, keys: KeyCombo[], run: (ed: EditorController, refs: Guid[]) => void): EditorCommand => ({
  id,
  label,
  keys,
  run: (ed) => {
    const refs = textRefs(ed);
    if (refs.length) run(ed, refs);
  },
  enabled: (ed) => textRefs(ed).length > 0,
});

/** Text › Case ▸: the selected text layers' letter case (checked when they all have it). */
const textCase = (id: string, label: string, value: NonNullable<ExtraFields["textCase"]>): EditorCommand => ({
  ...textCommand(id, label, [], (ed, refs) => ed.setProps(refs, fields({ textCase: value }), "Text case")),
  keys: undefined,
  checked: (ed) => {
    const refs = textRefs(ed);
    if (!refs.length) return false;
    const s = textSummary(ed.engine, refs);
    return !!s && !s.mixed.has("textCase") && (s.values.textCase ?? "ORIGINAL") === value;
  },
});

function toggleDecoration(ed: EditorController, refs: Guid[], d: "UNDERLINE" | "STRIKETHROUGH") {
  const s = textSummary(ed.engine, refs);
  const on = !s?.mixed.has("textDecoration") && s?.values.textDecoration === d;
  ed.setProps(refs, fields({ textDecoration: on ? "NONE" : d }), d === "UNDERLINE" ? "Underline" : "Strikethrough");
}

/** ⇧⌘U "Create link": the link field above the selected characters (or the layer). */
export function openLinkEditor(ed: EditorController) {
  const edit = ed.engine.textEdit;
  const canvas = ed.canvas?.getBoundingClientRect();
  if (edit && canvas) {
    const r = edit.caretRectCss;
    ed.ui.set({ linkEditor: { x: canvas.left + r.x, y: canvas.top + r.y, width: Math.max(1, r.width), height: r.height } });
    return;
  }
  // A whole layer: the field over the canvas's upper middle.
  if (canvas) ed.ui.set({ linkEditor: { x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 3, width: 1, height: 1 } });
}

function goToPage(ed: EditorController, step: 1 | -1) {
  const pages = ed.store.pages;
  const at = pages.findIndex((p) => p.guid === ed.store.page);
  const next = pages[at + step];
  if (next) ed.engine.setCurrentPage(next.guid);
}

/** Edit ▸ Select all with ▸ …: every layer on the page with the selection's property (SELECT_MATCHING's modes). */
const selectAllWith = (id: string, label: string, mode: string): EditorCommand => ({
  id,
  label,
  run: (ed) => void runEngineCommand(ed.engine, "SELECT_MATCHING", { mode }),
  enabled: (ed) => engineEnabled(ed, "SELECT_MATCHING"),
});

/** View › Pixel grid's state (on unless turned off). */
const pixelGridOn = (ed: EditorController) => ed.ui.get().pixelGrid !== false;

/**
 * View › Pixel grid / Outlines / Layout guides / Rulers / Show slices / Pixel preview: the UI's state and the engine's (engine_set_view_options; canvasTools.ts sends every change).
 */
export function setViewOption(
  ed: EditorController,
  patch: { pixelGrid?: boolean; outlines?: boolean; layoutGuides?: boolean; rulers?: boolean; showSlices?: boolean; pixelPreview?: 0 | 1 | 2 }
): void {
  ed.ui.set(patch);
  syncViewOptions(ed);
  if (patch.outlines !== undefined) showToast({ message: patch.outlines ? "Outlines visible" : "Outlines hidden" });
  // Live Figma's toasts (behaviour/keys.md: ⌃P).
  if (patch.pixelPreview !== undefined) showToast({ message: patch.pixelPreview ? `Pixel preview enabled (${patch.pixelPreview}x)` : "Pixel preview disabled" });
}

/** Text › Adjust: one of the size / weight / spacing steps on the selected text layers. */
const adjust = (id: string, label: string, keys: KeyCombo[], what: TextAdjust, dir: 1 | -1): EditorCommand =>
  textCommand(id, label, keys, (ed, refs) => adjustText(ed, refs, what, dir));

/** Object ▸ Remove fill (⌥/) / Remove stroke (⇧/): the selected layers' paints of that kind gone. */
function removePaints(ed: EditorController, field: "fillPaints" | "strokePaints", label: string): void {
  const refs = ed.selection;
  if (refs.length) ed.setProps(refs, fields({ [field]: [] }), label);
}

/** Object ▸ Swap fill and stroke (⇧X): each selected layer's fills become its strokes and its strokes its fills. */
function swapFillAndStroke(ed: EditorController): void {
  const nodes = ed.selectedNodes();
  if (!nodes.length) return;
  ed.batch("Swap fill and stroke", () => {
    for (const n of nodes) ed.setProps([n.guid], fields({ fillPaints: n.strokePaints ?? [], strokePaints: n.fillPaints ?? [] }), "Swap fill and stroke");
  });
}

export const COMMANDS: EditorCommand[] = [
  // ---- Tools ----
  tool("tool.move", "Move", "MOVE", [k("KeyV")]),
  tool("tool.scale", "Scale", "SCALE", [k("KeyK")]),
  tool("tool.frame", "Frame", "FRAME", [k("KeyF"), k("KeyA")]),
  tool("tool.section", "Section", "SECTION", [k("KeyS", { shift: true })]),
  tool("tool.slice", "Slice", "SLICE", [k("KeyS")]),
  tool("tool.rectangle", "Rectangle", "RECTANGLE", [k("KeyR")]),
  tool("tool.line", "Line", "LINE", [k("KeyL")]),
  tool("tool.arrow", "Arrow", "ARROW", [k("KeyL", { shift: true })]),
  tool("tool.ellipse", "Ellipse", "ELLIPSE", [k("KeyO")]),
  tool("tool.polygon", "Polygon", "POLYGON", []),
  tool("tool.star", "Star", "STAR", []),
  placeImage("tool.image", "Image/video…", [k("KeyK", { mod: true, shift: true })]),
  tool("tool.pen", "Pen", "PEN", [k("KeyP")]),
  tool("tool.pencil", "Pencil", "PENCIL", [k("KeyP", { shift: true })]),
  tool("tool.text", "Text", "TEXT", [k("KeyT")]),
  // Comment: inert until multiplayer (the engine takes no clicks; a toast says so).
  tool("tool.comment", "Comment", "COMMENT", [k("KeyC")]),
  // Dev Mode's tools, in Design too (live toolbar: "Annotation Y", "Measurement ⇧M"; help.figma.com also ⇧T).
  tool("tool.annotation", "Annotation", "ANNOTATION", [k("KeyY"), k("KeyT", { shift: true })]),
  tool("tool.measurement", "Measurement", "MEASUREMENT", [k("KeyM", { shift: true })]),
  // ⇧D: Design ⇄ Dev Mode (help.figma.com 15023124644247).
  ui("view.dev-mode", "Dev Mode", [k("KeyD", { shift: true })], (ed) => setMode(ed, modeOf(ed) === "dev" ? "design" : "dev"), (ed) => modeOf(ed) === "dev"),
  tool("tool.hand", "Hand tool", "HAND", [k("KeyH")]),
  // ⌘K: the Actions palette (live toolbar/actions-panel.txt; panels/ActionsPanel.tsx).
  ui("tool.actions", "Actions…", [k("KeyK", { mod: true })], (ed) => ed.ui.set((s) => ({ actionsOpen: !s.actionsOpen, uiHidden: false })), (ed) => !!ed.ui.get().actionsOpen),

  // ---- Edit ----
  {
    id: "edit.undo",
    label: "Undo",
    keys: [k("KeyZ", { mod: true })],
    run: (ed) => void ed.engine.undo(),
    enabled: (ed) => ed.store.undo.canUndo,
  },
  {
    id: "edit.redo",
    label: "Redo",
    keys: [k("KeyZ", { mod: true, shift: true }), ...(IS_MAC ? [] : [k("KeyY", { mod: true })])],
    run: (ed) => void ed.engine.redo(),
    enabled: (ed) => ed.store.undo.canRedo,
  },
  { id: "edit.copy", label: "Copy", keys: [k("KeyC", { mod: true })], native: true, run: (ed) => copyFromMenu(ed, false), enabled: hasSelection },
  { id: "edit.cut", label: "Cut", keys: [k("KeyX", { mod: true })], native: true, run: (ed) => copyFromMenu(ed, true), enabled: hasSelection },
  { id: "edit.paste", label: "Paste", keys: [k("KeyV", { mod: true })], native: true, run: (ed) => pasteFromMenu(ed, null) },
  {
    // ⇧⌘V: where it was copied from, just above the selection (not into it).
    id: "edit.paste-over-selection",
    label: "Paste over selection",
    keys: [k("KeyV", { mod: true, shift: true })],
    native: true,
    prepare: (ed) => {
      ed.pendingPaste = { mode: "over" };
    },
    run: (ed) => pasteFromMenu(ed, { mode: "over" }),
  },
  {
    id: "edit.paste-here",
    label: "Paste here",
    run: (ed) => {
      // Where the context menu was opened (canvas px → page units); without one, a plain paste.
      const at = ed.ui.get().contextMenu?.canvas;
      if (!at) return pasteFromMenu(ed, null);
      const cam = ed.engine.getCamera();
      pasteFromMenu(ed, { mode: "point", x: (at.x - cam.x) / cam.zoom, y: (at.y - cam.y) / cam.zoom });
    },
  },
  // ⇧⌘R: a copy in each selected layer's place (its parent, order, x / y, constraints); the layer goes.
  { id: "edit.paste-to-replace", label: "Paste to replace", keys: [k("KeyR", { mod: true, shift: true })], run: (ed) => pasteFromMenu(ed, { mode: "replace" }), enabled: hasSelection },
  { id: "edit.copy-as-png", label: "Copy as PNG", keys: [k("KeyC", { mod: true, shift: true })], run: (ed) => void copyAsPng(ed), enabled: (ed) => hasSelection(ed) && canExport(ed) },
  { id: "edit.copy-as-svg", label: "Copy as SVG", run: (ed) => void copyAsSvg(ed), enabled: (ed) => hasSelection(ed) && canExport(ed) },
  { id: "edit.copy-as-code", label: "Copy as code", run: (ed) => void copyAsCode(ed), enabled: hasSelection },
  { id: "edit.copy-as-text", label: "Copy as text", run: (ed) => void copyAsText(ed), enabled: hasTextSelected },
  engine("edit.duplicate", "Duplicate", "DUPLICATE", [k("KeyD", { mod: true })]),
  engine("edit.delete", "Delete", "DELETE", [k("Backspace"), k("Delete")]),
  later("edit.copy-properties", "Copy properties", [k("KeyC", { mod: true, alt: true })]),
  later("edit.paste-properties", "Paste properties", [k("KeyV", { mod: true, alt: true })]),
  // Find and replace (the left panel's Find; Edit menu wording and keys from the live capture).
  ui("edit.find", "Find", [k("KeyF", { mod: true })], (ed) => openFind(ed)),
  { id: "edit.find-next", label: "Find next", keys: [k("KeyF", { mod: true, shift: true })], run: (ed) => stepFind(ed, 1), enabled: (ed) => !!ed.ui.get().find?.query },
  { id: "edit.find-previous", label: "Find previous", keys: [k("KeyD", { mod: true, shift: true })], run: (ed) => stepFind(ed, -1), enabled: (ed) => !!ed.ui.get().find?.query },
  ui("edit.find-replace", "Find and replace…", undefined, (ed) => openFind(ed, { replace: true })),
  later("edit.set-default-properties", "Set default properties"),
  // The eyedropper (live Edit menu "Pick color ⌃C"; I): a click on the canvas sets the selection's fill to that colour.
  tool("edit.pick-color", "Pick color", "EYEDROPPER", [k("KeyC", { ctrl: true }), k("KeyI")]),
  engine("edit.select-all", "Select all", "SELECT_ALL", [k("KeyA", { mod: true })]),
  engine("edit.select-matching", "Select matching layers", "SELECT_MATCHING", [k("KeyA", { mod: true, alt: true })]),
  // Esc is the engine's (it clears the selection, live Figma); the menu shows it.
  engine("edit.select-none", "Select none", "SELECT_NONE", [k("Escape")]),
  engine("edit.select-inverse", "Select inverse", "SELECT_INVERSE", [k("KeyA", { mod: true, shift: true })]),
  // Edit ▸ Select all with ▸ (SELECT_MATCHING's modes).
  selectAllWith("edit.select-same-fill", "Same fill", "FILL"),
  selectAllWith("edit.select-same-stroke", "Same stroke", "STROKE"),
  selectAllWith("edit.select-same-effect", "Same effect", "EFFECT"),
  selectAllWith("edit.select-same-text", "Same text properties", "TEXT"),
  selectAllWith("edit.select-same-font", "Same font", "FONT"),
  selectAllWith("edit.select-same-instance", "Same instance", "INSTANCE"),

  // ---- View ----
  ui("view.toggle-ui", "Show/Hide UI", [k("Backslash", { mod: true })], (ed) => ed.ui.set((s) => ({ uiHidden: !s.uiHidden })), (ed) => !ed.ui.get().uiHidden),
  // ⇧⌘\ (the live View menu; help "Navigate the left sidebar": collapses the navigation bar and both sidebars).
  ui("view.minimize-ui", "Minimize UI", [k("Backslash", { mod: true, shift: true })], (ed) => ed.ui.set((s) => ({ uiMinimized: !s.uiMinimized, uiHidden: false })), (ed) => ed.ui.get().uiMinimized),
  // View › Additional labels (on by default): the navigation bar's tab names and the Design panel's property labels.
  ui(
    "view.additional-labels",
    "Additional labels",
    undefined,
    (ed) => ed.ui.set((s) => ({ railLabels: !s.propertyLabels, propertyLabels: !s.propertyLabels })),
    (ed) => ed.ui.get().propertyLabels
  ),
  later("view.minimize-left-nav", "Minimize left navigation bar"),
  // Object › Collapse layers (⌥L): every expanded layer closes but the selection's branch.
  ui("view.collapse-layers", "Collapse layers", [k("KeyL", { alt: true })], (ed) => ed.ui.set((s) => ({ expanded: collapsedLayers(ed.getTree(), ed.selection, s.expanded) }))),
  ui("view.rulers", "Rulers", [k("KeyR", { shift: true })], (ed) => setViewOption(ed, { rulers: !ed.ui.get().rulers }), (ed) => ed.ui.get().rulers),
  // View › Annotations (help.figma.com 20774752502935; ⇧Y per a user report, unverified).
  ui("view.annotations", "Annotations", [k("KeyY", { shift: true })], (ed) => toggleAnnotations(ed), (ed) => annotationsShown(ed)),
  // The live View menu: Pixel grid ⇧' (drawn from 300 % zoom), Layout guides ⇧G, Outlines ▸ (⇧⌘O), Pixel preview ⇧⌘P.
  ui("view.pixel-grid", "Pixel grid", [k("Quote", { shift: true })], (ed) => setViewOption(ed, { pixelGrid: !pixelGridOn(ed) }), (ed) => pixelGridOn(ed)),
  ui("view.layout-guides", "Layout guides", [k("KeyG", { shift: true })], (ed) => setViewOption(ed, { layoutGuides: ed.ui.get().layoutGuides === false }), (ed) => ed.ui.get().layoutGuides !== false),
  ui("view.show-slices", "Show slices", undefined, (ed) => setViewOption(ed, { showSlices: ed.ui.get().showSlices === false }), (ed) => ed.ui.get().showSlices !== false),
  later("view.comments", "Comments", [k("KeyC", { shift: true })]),
  ui("view.outlines", "Show outlines", [k("KeyO", { mod: true, shift: true })], (ed) => setViewOption(ed, { outlines: !ed.ui.get().outlines }), (ed) => !!ed.ui.get().outlines),
  // Live: View › Pixel preview ⇧⌘P; ⌃P toggles it ("Pixel preview enabled (1x)" / "Pixel preview disabled").
  ui("view.pixel-preview", "Pixel preview", [k("KeyP", { mod: true, shift: true }), k("KeyP", { ctrl: true })], (ed) => setViewOption(ed, { pixelPreview: ed.ui.get().pixelPreview ? 0 : 1 }), (ed) => !!ed.ui.get().pixelPreview),
  later("view.mask-outlines", "Mask outlines"),
  later("view.frame-outlines", "Frame outlines"),
  later("view.memory-usage", "Memory usage"),
  later("view.multiplayer-cursors", "Multiplayer cursors", [k("Backslash", { mod: true, alt: true })]),
  later("view.switch-to-draw", "Switch to Draw"),
  engine("view.zoom-in", "Zoom in", "ZOOM_IN", [k("Equal", { mod: true }), k("Equal", { mod: true, shift: true }), k("Equal"), k("NumpadAdd")]),
  engine("view.zoom-out", "Zoom out", "ZOOM_OUT", [k("Minus", { mod: true }), k("Minus"), k("NumpadSubtract")]),
  engine("view.zoom-100", "Zoom to 100%", "ZOOM_TO_100", [k("Digit0", { mod: true }), k("Digit0", { shift: true })]),
  engine("view.zoom-fit", "Zoom to fit", "ZOOM_TO_FIT", [k("Digit1", { shift: true })]),
  engine("view.zoom-selection", "Zoom to selection", "ZOOM_TO_SELECTION", [k("Digit2", { shift: true })]),
  ui("view.zoom-50", "Zoom to 50%", undefined, (ed) => zoomTo(ed, 0.5)),
  ui("view.zoom-200", "Zoom to 200%", undefined, (ed) => zoomTo(ed, 2)),
  { id: "view.previous-page", label: "Previous page", keys: [k("PageUp")], run: (ed) => goToPage(ed, -1) },
  { id: "view.next-page", label: "Next page", keys: [k("PageDown")], run: (ed) => goToPage(ed, 1) },
  // N / ⇧N: the view to the next / previous frame; the selection stays (live Figma).
  engine("view.zoom-previous-frame", "Zoom to previous frame", "ZOOM_TO_PREVIOUS_FRAME", [k("KeyN", { shift: true })]),
  engine("view.zoom-next-frame", "Zoom to next frame", "ZOOM_TO_NEXT_FRAME", [k("KeyN")]),
  later("view.find-previous-frame", "Find previous frame", [k("Home")]),
  later("view.find-next-frame", "Find next frame", [k("End")]),

  // ---- Panels ----
  ui("view.layers", "Layers", [k("Digit1", { alt: true })], (ed) => ed.ui.set({ railTab: "file", uiHidden: false, uiMinimized: false }), (ed) => ed.ui.get().railTab === "file"),
  ui("view.assets", "Assets", [k("Digit2", { alt: true })], (ed) => ed.ui.set({ railTab: "assets", uiHidden: false, uiMinimized: false }), (ed) => ed.ui.get().railTab === "assets"),
  // The navigation bar's Variables (Figma 2026: the variables view moved there from the right sidebar).
  ui("view.local-variables", "Variables", undefined, (ed) => ed.ui.set((s) => ({ variablesOpen: !s.variablesOpen, uiHidden: false })), (ed) => ed.ui.get().variablesOpen),
  ui("view.agents", "Agents", undefined, (ed) => ed.ui.set({ railTab: "agents", uiHidden: false, uiMinimized: false }), (ed) => ed.ui.get().railTab === "agents"),
  ui("view.tools", "Tools", undefined, (ed) => ed.ui.set({ railTab: "tools", uiHidden: false, uiMinimized: false }), (ed) => ed.ui.get().railTab === "tools"),
  ui("view.design-panel", "Open design panel", [k("Digit8", { alt: true })], (ed) => ed.ui.set({ rightTab: "design", uiHidden: false, uiMinimized: false })),
  ui("view.prototype-panel", "Open prototype panel", [k("Digit9", { alt: true })], (ed) => ed.ui.set({ rightTab: "prototype", uiHidden: false, uiMinimized: false })),

  // ---- Object ----
  engine("object.group", "Group selection", "GROUP", [k("KeyG", { mod: true })]),
  // ⌘⌫ (live Figma): a group ungrouped; a frame or section removed, its layers kept where they are.
  {
    id: "object.ungroup",
    label: "Ungroup selection",
    keys: [k("Backspace", { mod: true }), k("KeyG", { mod: true, shift: true })],
    run: (ed) => {
      if (engineEnabled(ed, "UNGROUP")) ed.engine.command("UNGROUP");
      else ed.engine.command("REMOVE_KEEP_CONTENTS");
    },
    enabled: (ed) => engineEnabled(ed, "UNGROUP") || engineEnabled(ed, "REMOVE_KEEP_CONTENTS"),
  },
  engine("object.frame-selection", "Frame selection", "FRAME_SELECTION", [k("KeyG", { mod: true, alt: true })]),
  engine("object.wrap-in-section", "Wrap in new section", "WRAP_IN_SECTION", [k("KeyS", { mod: true })]),
  later("object.convert-to-section", "Convert to section"),
  later("object.convert-to-frame", "Convert to frame"),
  later("object.set-as-thumbnail", "Set as thumbnail"),
  later("object.restore-default-thumbnail", "Restore default thumbnail"),
  later("object.more-layout-options", "More layout options"),
  later("object.hide-other-layers", "Hide other layers"),
  later("object.remove-interactions", "Remove interactions"),
  { id: "object.remove-fill", label: "Remove fill", keys: [k("Slash", { alt: true })], run: (ed) => removePaints(ed, "fillPaints", "Remove fill"), enabled: hasSelection },
  { id: "object.remove-stroke", label: "Remove stroke", keys: [k("Slash", { shift: true })], run: (ed) => removePaints(ed, "strokePaints", "Remove stroke"), enabled: hasSelection },
  { id: "object.swap-fill-stroke", label: "Swap fill and stroke", keys: [k("KeyX", { shift: true })], run: (ed) => swapFillAndStroke(ed), enabled: hasSelection },
  engine("object.add-auto-layout", "Add auto layout", "ADD_AUTO_LAYOUT", [k("KeyA", { shift: true })]),
  engine("object.remove-auto-layout", "Remove auto layout", "REMOVE_AUTO_LAYOUT", [k("KeyA", { shift: true, alt: true })]),
  // Components (E6: the structural ones are the engine's; R4-components.md for the wording and keys)
  pending("object.create-component", "Create component", COMPONENT_COMMAND.create, [k("KeyK", { mod: true, alt: true })]),
  pending("object.create-multiple-components", "Create multiple components", COMPONENT_COMMAND.create, undefined, {
    run: (ed) => void runEngineCommand(ed.engine, COMPONENT_COMMAND.create, { mode: "MULTIPLE" }),
    enabled: (ed) => ed.selection.length > 1 && engineCommandEnabled(ed.engine, COMPONENT_COMMAND.create),
  }),
  pending("object.combine-as-variants", "Combine as variants", COMPONENT_COMMAND.combine),
  pending("object.add-variant", "Add variant", COMPONENT_COMMAND.addVariant),
  pending("object.detach-instance", "Detach instance", COMPONENT_COMMAND.detach, [k("KeyB", { mod: true, alt: true })]),
  {
    id: "object.go-to-main-component",
    label: "Go to main component",
    keys: [k("KeyK", { mod: true, alt: true, ctrl: true })],
    run: (ed) => void goToMainComponent(ed),
    enabled: (ed) => {
      const inst = selectedInstance(ed);
      const main = inst ? mainOf(ed, inst) : null;
      return !!main && !!pageOf(ed, main.guid);
    },
  },
  pending("object.push-changes", "Push changes to main component", COMPONENT_COMMAND.push, undefined, { enabled: (ed) => canPushChanges(ed) }),
  {
    id: "object.reset-all-changes",
    label: "Reset all changes",
    run: (ed) => {
      const inst = selectedInstance(ed);
      if (inst) resetChanges(ed, inst, null);
    },
    enabled: (ed) => {
      const inst = selectedInstance(ed);
      return !!inst && instanceChanges(ed, inst).length > 0;
    },
  },
  pending("object.restore-component", "Restore component", COMPONENT_COMMAND.restore),
  pending("object.reset-slot", "Reset slot", COMPONENT_COMMAND.resetSlot),
  // Slots (help "Create and use slots"): a nested frame of a main becomes a slot; anything else is wrapped first.
  pending("object.convert-to-slot", "Convert to slot", COMPONENT_COMMAND.convertToSlot, [k("KeyS", { mod: true, shift: true })]),
  pending("object.wrap-in-new-slot", "Wrap in new slot", COMPONENT_COMMAND.wrapInSlot),
  pending("object.delete-slot-contents", "Delete contents", COMPONENT_COMMAND.clearSlot),
  {
    id: "object.return-to-instance",
    label: "Return to instance",
    run: (ed) => returnToInstance(ed),
    enabled: (ed) => !!ed.ui.get().returnToInstance,
  },
  pending("object.use-as-mask", "Use as mask", "USE_AS_MASK", [k("KeyM", { mod: true, ctrl: true })], {
    checked: (ed) => ed.selectedNodes().some((n) => (n as { mask?: boolean }).mask === true),
  }),
  // Live Figma: ] / [ to the front / back (⌥⌘] / ⌥⌘[ too), ⌘] / ⌘[ one step.
  engine("object.bring-to-front", "Bring to front", "BRING_TO_FRONT", [k("BracketRight"), k("BracketRight", { mod: true, alt: true })]),
  engine("object.bring-forward", "Bring forward", "BRING_FORWARD", [k("BracketRight", { mod: true })]),
  engine("object.send-backward", "Send backward", "SEND_BACKWARD", [k("BracketLeft", { mod: true })]),
  engine("object.send-to-back", "Send to back", "SEND_TO_BACK", [k("BracketLeft"), k("BracketLeft", { mod: true, alt: true })]),
  engine("object.flip-horizontal", "Flip horizontal", "FLIP_HORIZONTAL", [k("KeyH", { shift: true })]),
  engine("object.flip-vertical", "Flip vertical", "FLIP_VERTICAL", [k("KeyV", { shift: true })]),
  { id: "object.rotate-180", label: "Rotate 180˚", run: (ed) => rotateSelection(ed, 180), enabled: hasSelection },
  { id: "object.rotate-90-left", label: "Rotate 90˚ left", run: (ed) => rotateSelection(ed, 90), enabled: hasSelection },
  { id: "object.rotate-90-right", label: "Rotate 90˚ right", run: (ed) => rotateSelection(ed, -90), enabled: hasSelection },
  engine("object.toggle-visible", "Show/Hide selection", "TOGGLE_VISIBLE", [k("KeyH", { mod: true, shift: true })]),
  engine("object.toggle-lock", "Lock/Unlock selection", "TOGGLE_LOCK", [k("KeyL", { mod: true, shift: true })]),
  {
    id: "object.rename",
    label: "Rename",
    keys: [k("KeyR", { mod: true })],
    run: (ed) => {
      const refs = ed.selection;
      // Several layers: Figma's "Rename layers" dialog (rename to, match / replace, current name and numbers).
      if (refs.length > 1) return ed.ui.set({ renameLayers: [...refs], renaming: null });
      const first = refs[0];
      if (first) ed.ui.set({ railTab: "file", find: null, renaming: { kind: "layer", id: first }, uiHidden: false, uiMinimized: false });
    },
    enabled: hasSelection,
  },

  // ---- Arrange ----
  engine("arrange.align-left", "Align left", "ALIGN_LEFT", [k("KeyA", { alt: true })]),
  engine("arrange.align-horizontal-center", "Align horizontal centers", "ALIGN_HORIZONTAL_CENTER", [k("KeyH", { alt: true })]),
  engine("arrange.align-right", "Align right", "ALIGN_RIGHT", [k("KeyD", { alt: true })]),
  engine("arrange.align-top", "Align top", "ALIGN_TOP", [k("KeyW", { alt: true })]),
  engine("arrange.align-vertical-center", "Align vertical centers", "ALIGN_VERTICAL_CENTER", [k("KeyV", { alt: true })]),
  engine("arrange.align-bottom", "Align bottom", "ALIGN_BOTTOM", [k("KeyS", { alt: true })]),
  engine("arrange.distribute-horizontal", "Distribute horizontal spacing", "DISTRIBUTE_HORIZONTAL", [k("KeyH", { alt: true, ctrl: true })]),
  engine("arrange.distribute-vertical", "Distribute vertical spacing", "DISTRIBUTE_VERTICAL", [k("KeyV", { alt: true, ctrl: true })]),
  engine("arrange.tidy-up", "Tidy up", "TIDY_UP", [k("KeyT", { alt: true, ctrl: true })]),
  // ⌥R (a forum report; not in the live menus): the rotation origin shown, dragged; rotation turns about it.
  engine("object.rotation-origin", "Show rotation origin", "SHOW_ROTATION_ORIGIN", [k("KeyR", { alt: true })], { checked: (ed) => (ed.engine.commandState("SHOW_ROTATION_ORIGIN") & 2) !== 0 }),
  engine("canvas.remove-guide", "Remove guide", "REMOVE_GUIDE"),
  later("arrange.round-to-pixel", "Round to pixel"),
  later("arrange.pack-horizontal", "Pack horizontal"),
  later("arrange.pack-vertical", "Pack vertical"),
  later("arrange.distribute-left", "Distribute left"),
  later("arrange.distribute-horizontal-centers", "Distribute horizontal centers"),
  later("arrange.distribute-right", "Distribute right"),
  later("arrange.distribute-top", "Distribute top"),
  later("arrange.distribute-vertical-centers", "Distribute vertical centers"),
  later("arrange.distribute-bottom", "Distribute bottom"),

  // ---- Vector, booleans (E4) ----
  pending("vector.flatten", "Flatten", "FLATTEN", [k("KeyF", { alt: true, shift: true }), k("KeyE", { mod: true })]),
  pending("vector.outline-stroke", "Outline stroke", "OUTLINE_STROKE", [k("KeyO", { mod: true, alt: true })]),
  pending("vector.union", "Union selection", "BOOLEAN_UNION", [k("KeyU", { alt: true, shift: true })]),
  pending("vector.subtract", "Subtract selection", "BOOLEAN_SUBTRACT", [k("KeyS", { alt: true, shift: true })]),
  pending("vector.intersect", "Intersect selection", "BOOLEAN_INTERSECT", [k("KeyI", { alt: true, shift: true })]),
  pending("vector.exclude", "Exclude selection", "BOOLEAN_EXCLUDE", [k("KeyE", { alt: true, shift: true })]),
  // The Figma menu › Vector (live main-vector.txt): vector edit mode's point commands.
  later("vector.join", "Join selection", [k("KeyJ", { mod: true })]),
  later("vector.smooth-join", "Smooth join selection", [k("KeyJ", { mod: true, shift: true })]),
  engine("vector.delete-heal", "Delete and heal selection", "VECTOR_DELETE_AND_HEAL", [k("Backspace", { shift: true })]),
  later("vector.split", "Split vector"),
  later("vector.simplify", "Simplify vector"),
  later("vector.offset", "Offset vector"),

  // ---- Text (E3; the text round: links and lists) ----
  // While a text is edited the engine takes ⌘B ⌘I ⌘U ⇧⌘X ⇧⌘7 ⇧⌘8 itself (on the selected characters); these run
  // on the selected text layers, and from the menu.
  textCommand("text.bold", "Bold", [k("KeyB", { mod: true })], (ed, refs) => {
    const s = textSummary(ed.engine, refs);
    const font = s?.values.fontName as { family: string; style: string } | undefined;
    if (font) ed.setProps(refs, fields({ fontName: { family: font.family, style: toggledBold(font.style), postscript: "" } }), "Bold");
  }),
  textCommand("text.italic", "Italic", [k("KeyI", { mod: true })], (ed, refs) => {
    const s = textSummary(ed.engine, refs);
    const font = s?.values.fontName as { family: string; style: string } | undefined;
    if (font) ed.setProps(refs, fields({ fontName: { family: font.family, style: toggledItalic(font.style), postscript: "" } }), "Italic");
  }),
  textCommand("text.underline", "Underline", [k("KeyU", { mod: true })], (ed, refs) => toggleDecoration(ed, refs, "UNDERLINE")),
  textCommand("text.strikethrough", "Strikethrough", [k("KeyX", { mod: true, shift: true })], (ed, refs) => toggleDecoration(ed, refs, "STRIKETHROUGH")),
  textCommand("text.create-link", "Create link", [k("KeyU", { mod: true, shift: true })], (ed) => openLinkEditor(ed)),
  textCommand("text.bulleted-list", "Bulleted list", [k("Digit8", { mod: true, shift: true })], (ed, refs) =>
    ed.batch("Bulleted list", () => refs.forEach((r) => ed.engine.setTextList(r, "UNORDERED")))
  ),
  textCommand("text.numbered-list", "Numbered list", [k("Digit7", { mod: true, shift: true })], (ed, refs) =>
    ed.batch("Numbered list", () => refs.forEach((r) => ed.engine.setTextList(r, "ORDERED")))
  ),
  textCommand("text.align-left", "Text align left", [k("KeyL", { mod: true, alt: true })], (ed, refs) => ed.setProps(refs, fields({ textAlignHorizontal: "LEFT" }), "Text alignment")),
  // Text › Adjust (help.figma.com shortcuts; the steps unverified).
  adjust("text.font-size-up", "Increase font size", [k("Period", { mod: true, shift: true })], "size", 1),
  adjust("text.font-size-down", "Decrease font size", [k("Comma", { mod: true, shift: true })], "size", -1),
  adjust("text.font-weight-up", "Increase font weight", [k("Period", { mod: true, alt: true })], "weight", 1),
  adjust("text.font-weight-down", "Decrease font weight", [k("Comma", { mod: true, alt: true })], "weight", -1),
  adjust("text.line-height-up", "Increase line height", [k("Period", { alt: true, shift: true })], "lineHeight", 1),
  adjust("text.line-height-down", "Decrease line height", [k("Comma", { alt: true, shift: true })], "lineHeight", -1),
  adjust("text.letter-spacing-up", "Increase letter spacing", [k("Period", { alt: true })], "letterSpacing", 1),
  adjust("text.letter-spacing-down", "Decrease letter spacing", [k("Comma", { alt: true })], "letterSpacing", -1),
  // Text › Case ▸ (live: listed, its items not captured — Type settings' Case options; unverified).
  textCase("text.case-original", "As typed", "ORIGINAL"),
  textCase("text.case-upper", "Uppercase", "UPPER"),
  textCase("text.case-lower", "Lowercase", "LOWER"),
  textCase("text.case-title", "Title case", "TITLE"),
  textCase("text.case-small-caps", "Small caps", "SMALL_CAPS"),
  textCase("text.case-forced-small-caps", "Forced small caps", "SMALL_CAPS_FORCED"),
  // Text › Text direction ▸ and Spell check ▸ (live: listed, items not captured; unverified): not built.
  later("text.direction-auto", "Auto"),
  later("text.direction-ltr", "Left to right"),
  later("text.direction-rtl", "Right to left"),
  later("text.spell-check", "Spell check"),
  textCommand("text.align-center", "Text align center", [k("KeyT", { mod: true, alt: true })], (ed, refs) => ed.setProps(refs, fields({ textAlignHorizontal: "CENTER" }), "Text alignment")),
  textCommand("text.align-right", "Text align right", [k("KeyR", { mod: true, alt: true })], (ed, refs) => ed.setProps(refs, fields({ textAlignHorizontal: "RIGHT" }), "Text alignment")),

  // ---- File, help ----
  {
    id: "file.new",
    label: "New design file",
    run: () => designerNav()?.newFile?.(),
    enabled: () => !!designerNav()?.newFile,
  },
  {
    id: "file.rename",
    label: "Rename",
    run: (ed) => ed.ui.set({ renaming: { kind: "file", id: "" }, uiHidden: false, uiMinimized: false }),
    enabled: (ed) => typeof ed.source.rename === "function",
  },
  later("file.duplicate", "Duplicate"),
  later("file.move", "Move to project…"),
  later("file.save-local-copy", "Save local copy…"),
  later("file.create-branch", "Create branch…"),
  later("file.color-profile", "Color profile…"),
  // The Figma menu's Plugins, Widgets and Preferences items not built (shown as Figma lists them, disabled).
  later("plugins.run-last", "Run last plugin", [k("KeyP", { mod: true, alt: true })]),
  later("plugins.manage", "Manage plugins…"),
  later("plugins.none", "No saved plugins"),
  later("widgets.manage", "Manage widgets…"),
  later("widgets.select-all", "Select all widgets"),
  // Preferences' checks (preferences.ts: live Figma's order, defaults and wording; kept per machine). ⇧⌘′ Snap to
  // pixel grid; the view flags reach the engine at once.
  ...PREFERENCES.map(
    (p): EditorCommand => ({
      id: p.id,
      label: p.label,
      keys: p.key === "snapToPixelGrid" ? [k("Quote", { mod: true, shift: true })] : undefined,
      run: (ed) => {
        togglePreference(ed, p.key);
        syncViewOptions(ed);
      },
      checked: (ed) => pref(ed.ui.get(), p.key),
    })
  ),
  later("prefs.color-profile", "Color profile…"),
  later("prefs.keyboard-layout", "Keyboard layout…"),
  later("prefs.accessibility", "Accessibility settings…"),
  later("prefs.permissions", "Permissions and helpers…"),
  ui("prefs.nudge-amount", "Nudge amount…", undefined, (ed) => ed.ui.set({ nudgeDialog: true, uiHidden: false })),
  // The Figma menu's "Open in desktop app" (the web app's; this app has no deep links yet).
  later("file.open-in-desktop", "Open in desktop app"),
  {
    id: "file.save-version",
    label: "Save to version history…",
    keys: [k("KeyS", { mod: true, alt: true })],
    run: (ed) => ed.ui.set({ versionDialog: "save" }),
    enabled: (ed) => typeof ed.source.saveVersion === "function",
  },
  {
    id: "file.version-history",
    label: "Show version history",
    run: (ed) => ed.ui.set({ versionDialog: "history" }),
    enabled: (ed) => typeof ed.source.listVersions === "function",
  },
  {
    id: "file.libraries",
    label: "Libraries…",
    // Live: always there (the modal says what this file can use).
    run: (ed) => ed.ui.set({ librariesDialog: { tab: "libraries" }, uiHidden: false }),
  },
  {
    id: "file.publish-library",
    label: "Publish library…",
    run: (ed) => ed.ui.set({ publishOpen: true, uiHidden: false }),
    enabled: (ed) => ed.libraries.get().on,
  },
  { id: "file.export", label: "Export…", keys: [k("KeyE", { mod: true, shift: true })], run: (ed) => ed.ui.set({ exportDialog: true, uiHidden: false }), enabled: canExport },
  { id: "file.export-frames-to-pdf", label: "Export frames to PDF…", run: (ed) => void exportFramesToPdf(ed), enabled: canExport },
  {
    id: "file.share-preview",
    label: "Share preview…",
    run: (ed) => ed.ui.set({ shareOpen: true, uiHidden: false }),
  },
  placeImage("file.place-image", "Place image…", [k("KeyK", { mod: true, shift: true })]),
  {
    id: "file.back-to-files",
    label: "Back to files",
    run: (ed) => {
      const nav = designerNav();
      if (ed.backToFiles) ed.backToFiles();
      else if (nav?.goHome) nav.goHome();
      else showToast({ message: "Files open in the desktop app's Home" });
    },
  },
  theme("theme.light", "Light", "light"),
  theme("theme.dark", "Dark", "dark"),
  theme("theme.system", "Use system setting", "system"),
  later("canvas.send-to-make", "Send to Figma Make"),
  later("canvas.find-similar", "Find similar designs"),
  later("canvas.add-motion", "Add motion"),
  later("canvas.cursor-chat", "Cursor chat", [k("Slash")]),
  // Help and account (live main-help.txt): Figma's own pages open in the browser; no account here.
  link("help.page", "Help page", "https://help.figma.com/"),
  ui("help.shortcuts", "Keyboard shortcuts", [k("Slash", { ctrl: true, shift: true })], (ed) => ed.ui.set((s) => ({ shortcutsOpen: !s.shortcutsOpen }))),
  link("help.forum", "Support forum", "https://forum.figma.com/"),
  link("help.videos", "Video tutorials", "https://www.youtube.com/@Figma"),
  link("help.release-notes", "Release notes", "https://www.figma.com/release-notes/"),
  later("help.font-settings", "Open font settings"),
  link("help.legal", "Legal summary", "https://www.figma.com/legal/"),
  later("help.account", "Account settings"),
  later("help.log-out", "Log out"),
  // Prototyping (R8 §9): Present opens the presentation view in a new tab; "in this tab" over the editor.
  ui("view.present", "Present", [k("Enter", { mod: true, alt: true })], (ed) => present(ed)),
  ui("view.present-here", "Present in this tab", undefined, (ed) => present(ed, { here: true })),
  ui("view.preview", "Preview", [k("Space", { shift: true })], (ed) => togglePreview(ed)),
  // Dev Mode statuses (devStatus.ts).
  {
    id: "object.mark-ready-for-dev",
    label: "Mark as ready for dev",
    run: (ed) => setDevStatus(ed, "BUILD"),
    enabled: (ed) => {
      const t = statusTargets(ed);
      return t.length > 0 && statusOfTargets(ed, t) !== "BUILD";
    },
  },
  {
    id: "object.mark-completed",
    label: "Mark as completed",
    run: (ed) => setDevStatus(ed, "COMPLETED"),
    enabled: (ed) => {
      const t = statusTargets(ed);
      return t.length > 0 && statusOfTargets(ed, t) === "BUILD";
    },
  },
  {
    id: "object.remove-dev-status",
    label: "Remove status",
    run: (ed) => setDevStatus(ed, null),
    enabled: (ed) => {
      const t = statusTargets(ed);
      return t.length > 0 && statusOfTargets(ed, t) !== null;
    },
  },
  ui("view.prototype-tab", "Show prototype panel", undefined, (ed) =>
    ed.ui.set((s) => ({ rightTab: s.rightTab === "prototype" ? "design" : "prototype", uiHidden: false }))
  ),
];

/** The desktop app's navigation (absent in a browser). */
function designerNav(): { goHome?: () => void; newFile?: () => void } | undefined {
  return (window as unknown as { designer?: { nav?: { goHome?: () => void; newFile?: () => void } } }).designer?.nav;
}

export const COMMAND_BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

export function command(id: string): EditorCommand {
  const c = COMMAND_BY_ID.get(id);
  if (!c) throw new Error(`no command ${id}`);
  return c;
}

export const isEnabled = (ed: EditorController, c: EditorCommand) => (c.enabled ? c.enabled(ed) : true);

/** Runs a command if it is enabled; true when it ran. */
export function runEditorCommand(ed: EditorController, id: string): boolean {
  const c = COMMAND_BY_ID.get(id);
  if (!c || !isEnabled(ed, c)) return false;
  c.run(ed);
  return true;
}

/** The command a key press means (null: none). */
export function commandForKey(e: KeyboardEvent): EditorCommand | null {
  for (const c of COMMANDS) if (c.keys?.some((combo) => matchesCombo(combo, e))) return c;
  return null;
}

/** The shortcut shown next to a command. */
export const shortcutOf = (c: EditorCommand): string | undefined => (c.keys?.length ? comboText(c.keys[0]) : undefined);

/** Engine command state bits, for callers holding a CommandName. */
export const engineEnabled = (ed: EditorController, name: CommandName) => (ed.engine.commandState(name) & CMD_ENABLED) !== 0;
