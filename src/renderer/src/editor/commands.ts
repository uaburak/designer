/**
 * The editor's commands (docs/editor.md §5): one registry for the main menu,
 * the canvas context menu, the shortcut layer and the panel buttons. Labels
 * and keys are Figma's (docs/research/figma/R7-editor.md). A command the
 * engine doesn't implement yet reads as disabled (its commandState).
 */
import { CMD_ENABLED, type CommandName, type ToolName } from "@/engine/abi";
import { t } from "@/i18n";
import { currentTheme, IS_MAC, keys as keyText, setThemePreference, showToast, type ThemePreference } from "@/ds";
import type { EditorController } from "./controller";
import { rotateSelection, zoomTo } from "./actions";
import { copyFromMenu, pasteFromMenu } from "./clipboardIO";
import { engineCommandEnabled, runEngineCommand } from "./engineCompat";
import { chooseAndPlaceImages } from "./canvas/ImagePlacer";
import { openPathTool } from "./canvas/PathToolbar";
import { canExport, copyAsCode, copyAsPng, copyAsSvg, copyAsText, exportAllowed, exportFramesToPdf, hasTextSelected } from "./exporting";
import { present, togglePreview } from "./present";
import { setDevStatus, statusOfTargets, statusTargets } from "./devStatus";
import { annotationsShown, modeOf, setMode, toggleAnnotations } from "./devmode/devMode";
import { toggleAutoKeyframe, toggleMotionPlaying } from "./motion/motionState";
import { MOTION_UI_DEFAULT } from "./uiStore";
import { round5, setRound5 } from "./devmode/round5";
import { textSummary, toggledBold, toggledItalic } from "./model/text";
import { fields, type ExtraFields } from "./panels/design/shared";
import { removeAllAutoLayout, suggestAutoLayout } from "./panels/design/layoutActions";
import type { Guid } from "@/engine/codec";
import { COMPONENT_COMMAND, canPushChanges, goToMainComponent, instanceChanges, mainOf, pageOf, resetChanges, returnToInstance, selectedInstance } from "./components";
import { collapsedLayers } from "./model/layerTree";
import { openFind, stepFind } from "./find";
import { adjustText, syncViewOptions, type TextAdjust } from "./canvasTools";
import { PREFERENCES, pref, togglePreference, type PreferenceKey } from "./preferences";
import { setSpellCheck, spellCheckOn, spellChecker } from "./spellcheck";
import {
  addLayout,
  canCopyProperties,
  canPasteProperties,
  canDuplicateFile,
  canSaveLocalCopy,
  canSetThumbnail,
  copyProperties,
  duplicateFile,
  fileOps,
  findFrame,
  hideOtherLayers,
  otherLayers,
  pasteProperties,
  saveLocalCopy,
  setThumbnail,
  thumbnailNode,
  type LayoutFlow,
} from "./objectCommands";
import { viewRect } from "./canvas/viewInsets";
import type { KeyCombo } from "@shared/shortcuts";
import { openSettings } from "../settings/bridge";
import { openAiBalance } from "../settings/AiBalance";
import { BRANCH_COMMANDS } from "./branching/commands";
import { isBranch } from "./branching/state";
import { accountBridge, accountSignedIn } from "../files/account";
import { canShowLibraryAnalytics, openLibraryAnalytics } from "./analytics/EditorAnalytics";
import { presenceOf } from "./multiplayer/presence";
import { pluginsOf } from "./plugins/service";
import { pluginDesktop } from "./plugins/desktop";
import { openActions } from "./panels/actionsTab";
import { applyTransforms, canApplyTransforms, canCreateBrush, canFlipTextPath, createBrush, flipTextPath } from "./draw/drawTools";

/**
 * The keyboard layout picked in the Keyboard shortcuts panel (shortcuts/layouts.ts): a pressed key's place → the U.S.
 * key the bindings name (null: no shortcut on it), and the legend a binding's key has on it. Null: Generic.
 */
export interface KeyLayout {
  toBinding(code: string): string | null;
  label(code: string): string | null;
}
let keyLayout: KeyLayout | null = null;

/** Shortcuts follow this layout from now on (null: Generic, the U.S. places). */
export function setKeyLayout(layout: KeyLayout | null): void {
  keyLayout = layout;
}

export type { KeyCombo };

export interface EditorCommand {
  id: string;
  /** Figma's wording */
  label: string;
  /**
   * The first is shown in menus and tooltips. The user's own keys replace these (the Keyboard shortcuts panel:
   * shortcuts/keymap.ts applyBindings keeps the defaults and writes the bindings in force here).
   */
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
  let key = keyLayout?.label(c.code)?.toUpperCase() ?? KEY_LABEL[c.code] ?? c.code.replace(/^Key|^Digit/, "");
  // Live: "⌃⇧?" (Keyboard shortcuts) but "⇧/" (Remove stroke).
  if (c.code === "Slash" && c.shift && c.ctrl) key = "?";
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
/** The Figma menu's Plugins items (plugins/service.ts holds the lists and runs). */
const PLUGIN_COMMANDS: EditorCommand[] = [
  { id: "plugins.run-last", label: "Run last plugin", keys: [k("KeyP", { mod: true, alt: true })], run: (ed) => pluginsOf(ed)?.runLast(), enabled: (ed) => !!pluginsOf(ed)?.get().last },
  { id: "plugins.manage", label: "Manage plugins…", run: (ed) => openActions(ed, "plugins"), enabled: (ed) => !!pluginsOf(ed) },
  { id: "plugins.none", label: "No saved plugins", run: () => {}, enabled: () => false },
  // "New plugin…": the "Create a plugin" dialog; main writes Figma's templates into a folder the person picks.
  { id: "plugins.new", label: "New plugin…", run: (ed) => pluginsOf(ed)?.openNewPlugin(), enabled: (ed) => !!pluginsOf(ed)?.canDevelop },
  { id: "plugins.import", label: "Import new plugin from manifest…", run: (ed) => void pluginsOf(ed)?.importManifest(), enabled: (ed) => !!pluginsOf(ed) && !!pluginDesktop() },
  { id: "plugins.hot-reload", label: "Hot reload plugin", run: (ed) => pluginsOf(ed)?.toggleHotReload(), enabled: (ed) => !!pluginsOf(ed), checked: (ed) => !!pluginsOf(ed)?.get().hotReload },
  { id: "plugins.developer-vm", label: "Use developer VM", run: (ed) => pluginsOf(ed)?.toggleDeveloperVm(), enabled: (ed) => !!pluginsOf(ed), checked: (ed) => !!pluginsOf(ed)?.get().developerVm },
  { id: "plugins.open-console", label: "Open console", run: (ed) => pluginsOf(ed)?.openConsole(), enabled: (ed) => !!pluginsOf(ed) && !!pluginDesktop() },
];

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

/**
 * Text › Text direction ▸ (round 10; live lists it, its items are help.figma.com's — unverified): the paragraphs'
 * direction (the edited selection's, else the whole texts'), checked when they all have it. The layout stays left to
 * right until bidi (docs/engine-build.md E3.2).
 */
const textDirection = (id: string, label: string, value: "AUTO" | "LTR" | "RTL"): EditorCommand => ({
  ...textCommand(id, label, [], (ed, refs) => ed.batch("Text direction", () => refs.forEach((r) => ed.engine.setTextDirection(r, value)))),
  keys: undefined,
  checked: (ed) => {
    const refs = textRefs(ed);
    if (!refs.length) return false;
    const s = textSummary(ed.engine, refs);
    return !!s && !s.mixed.has("sourceDirectionality") && ((s.values as { sourceDirectionality?: string }).sourceDirectionality ?? "AUTO") === value;
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
  const view = viewRect(ed.canvas) ?? canvas;
  if (view) ed.ui.set({ linkEditor: { x: view.left + view.width / 2, y: view.top + view.height / 3, width: 1, height: 1 } });
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

/**
 * Figma's toasts when a snapping preference is switched (docs/research/atlas/21-settings.md §3:
 * visual_bell.snap_to_{geometry,objects,pixel_grid}_enabled / _disabled; the English worded as its Pixel preview one).
 */
const TOGGLE_TOASTS: Partial<Record<PreferenceKey, readonly [on: string, off: string]>> = {
  snapToGeometry: ["Snap to geometry enabled", "Snap to geometry disabled"],
  snapToObjects: ["Snap to objects enabled", "Snap to objects disabled"],
  snapToPixelGrid: ["Snap to pixel grid enabled", "Snap to pixel grid disabled"],
};

/** View › Pixel grid's state (on unless turned off). */
const pixelGridOn = (ed: EditorController) => ed.ui.get().pixelGrid !== false;

/**
 * View › Pixel grid / Outlines / Layout guides / Rulers / Show slices / Pixel preview: the UI's state and the engine's (engine_set_view_options; canvasTools.ts sends every change).
 */
export function setViewOption(
  ed: EditorController,
  patch: {
    pixelGrid?: boolean;
    outlines?: boolean;
    outlineHiddenLayers?: boolean;
    outlineObjectBounds?: boolean;
    layoutGuides?: boolean;
    rulers?: boolean;
    showSlices?: boolean;
    pixelPreview?: 0 | 1 | 2;
    maskOutlines?: boolean;
    frameOutlines?: boolean;
  }
): void {
  ed.ui.set(patch);
  syncViewOptions(ed);
  if (patch.outlines !== undefined) showToast({ message: patch.outlines ? t("Outlines visible") : t("Outlines hidden") });
  // Figma's toggle toasts (docs/research/atlas/21-settings.md §3: visual_bell.render_grid_*, show_frame_guides_*).
  if (patch.pixelGrid !== undefined) showToast({ message: patch.pixelGrid ? t("Pixel grid visible") : t("Pixel grid hidden") });
  if (patch.layoutGuides !== undefined) showToast({ message: patch.layoutGuides ? t("Layout guides visible") : t("Layout guides hidden") });
  // Live Figma's toasts (behaviour/keys.md: ⌃P).
  if (patch.pixelPreview !== undefined) showToast({ message: patch.pixelPreview ? t("Pixel preview enabled ({n}x)", { n: patch.pixelPreview }) : t("Pixel preview disabled") });
}

/** Cursor chat (/): the bubble opens where the pointer last was over the canvas (else the canvas's middle). */
function openCursorChat(ed: EditorController): void {
  if (presenceOf(ed)?.chatAllowed === false) return; // the org turned Cursor chat off (docs/multiplayer.md §15.6)
  const r = ed.canvas?.getBoundingClientRect();
  const p = lastPointer.get(ed) ?? (r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 });
  ed.ui.set({ cursorChat: { x: p.x, y: p.y } });
}
/** The pointer's last place over the canvas (viewport px), for Cursor chat. */
export const lastPointer = new WeakMap<EditorController, { x: number; y: number }>();

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
  // Round 7c (docs/draw.md §5.7): Figma Draw's Brush — Draw's alone; its key B is ours [unverified].
  { ...tool("tool.brush", "Brush", "BRUSH", [k("KeyB")]), enabled: (ed) => ed.tools.has("BRUSH") && modeOf(ed) === "draw" },
  tool("tool.text", "Text", "TEXT", [k("KeyT")]),
  // Type tools › Text on path (live toolbar; no key): click a shape's edge, type along it (docs/draw.md §4.4).
  tool("tool.text-on-path", "Text on path", "TEXT_PATH", []),
  // Comment: the engine takes no clicks; the comments layer puts down a new comment (editor/comments, docs/multiplayer.md §10).
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
  // A viewer of a file whose owner turned off "Viewers can copy, share, and export" copies no layers (docs/governance.md §2.7)
  { id: "edit.copy", label: "Copy", keys: [k("KeyC", { mod: true })], native: true, run: (ed) => copyFromMenu(ed, false), enabled: (ed) => hasSelection(ed) && exportAllowed(ed) },
  { id: "edit.cut", label: "Cut", keys: [k("KeyX", { mod: true })], native: true, run: (ed) => copyFromMenu(ed, true), enabled: (ed) => hasSelection(ed) && exportAllowed(ed) },
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
  { id: "edit.copy-as-code", label: "Copy as code", run: (ed) => void copyAsCode(ed), enabled: (ed) => hasSelection(ed) && exportAllowed(ed) },
  { id: "edit.copy-as-text", label: "Copy as text", run: (ed) => void copyAsText(ed), enabled: (ed) => hasTextSelected(ed) },
  engine("edit.duplicate", "Duplicate", "DUPLICATE", [k("KeyD", { mod: true })]),
  engine("edit.delete", "Delete", "DELETE", [k("Backspace"), k("Delete")]),
  // Round 10: ⌥⌘C / ⌥⌘V (help.figma.com "Copy and paste properties").
  { id: "edit.copy-properties", label: "Copy properties", keys: [k("KeyC", { mod: true, alt: true })], run: (ed) => copyProperties(ed), enabled: canCopyProperties },
  { id: "edit.paste-properties", label: "Paste properties", keys: [k("KeyV", { mod: true, alt: true })], run: (ed) => pasteProperties(ed), enabled: canPasteProperties },
  // Find and replace (the left panel's Find; Edit menu wording and keys from the live capture).
  ui("edit.find", "Find", [k("KeyF", { mod: true })], (ed) => openFind(ed)),
  { id: "edit.find-next", label: "Find next", keys: [k("KeyF", { mod: true, shift: true })], run: (ed) => stepFind(ed, 1), enabled: (ed) => !!ed.ui.get().find?.query },
  { id: "edit.find-previous", label: "Find previous", keys: [k("KeyD", { mod: true, shift: true })], run: (ed) => stepFind(ed, -1), enabled: (ed) => !!ed.ui.get().find?.query },
  ui("edit.find-replace", "Find and replace…", undefined, (ed) => openFind(ed, { replace: true })),
  // Round 10: the selected layer's look for new layers of its type, this session (the engine's; live's toast).
  engine("edit.set-default-properties", "Set default properties", "SET_DEFAULT_PROPERTIES", undefined, {
    run: (ed) => {
      if (ed.engine.command("SET_DEFAULT_PROPERTIES") === 0) showToast({ message: t("Default properties set") });
    },
  }),
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
  // ⌘\, and ⌘. (Figma's shortcut table, docs/research/atlas/02-editor-chrome.md §5).
  ui("view.toggle-ui", "Show/Hide UI", [k("Backslash", { mod: true }), k("Period", { mod: true })], (ed) => ed.ui.set((s) => ({ uiHidden: !s.uiHidden })), (ed) => !ed.ui.get().uiHidden),
  // ⇧⌘\ (the live View menu; help "Navigate the left sidebar": collapses the navigation bar and both sidebars), and
  // Figma's ⇧\ and ⇧. (atlas 02 §5).
  ui("view.minimize-ui", "Minimize UI", [k("Backslash", { mod: true, shift: true }), k("Backslash", { shift: true }), k("Period", { shift: true })], (ed) => ed.ui.set((s) => ({ uiMinimized: !s.uiMinimized, uiHidden: false })), (ed) => ed.ui.get().uiMinimized),
  // View › Additional labels: the navigation bar's tab names and the Design panel's property labels, together. Its check
  // is the rail's labels (off by default: an icon-only rail, panels/Rail.tsx showsRailLabels), so one click from the
  // default turns both on, the next both off.
  ui(
    "view.additional-labels",
    "Additional labels",
    undefined,
    (ed) =>
      ed.ui.set((s) => {
        const on = s.railLabels !== true;
        return { railLabels: on, propertyLabels: on };
      }),
    (ed) => ed.ui.get().railLabels === true
  ),
  // Round 10: the navigation bar's tabs fold into the left panel's header (unverified look).
  ui("view.minimize-left-nav", "Minimize left navigation bar", undefined, (ed) => ed.ui.set((s) => ({ navMinimized: !s.navMinimized, uiHidden: false, uiMinimized: false })), (ed) => !!ed.ui.get().navMinimized),
  // Object › Collapse layers (⌥L): every expanded layer closes but the selection's branch.
  ui("view.collapse-layers", "Collapse layers", [k("KeyL", { alt: true })], (ed) => ed.ui.set((s) => ({ expanded: collapsedLayers(ed.getTree(), ed.selection, s.expanded) }))),
  ui("view.rulers", "Rulers", [k("KeyR", { shift: true })], (ed) => setViewOption(ed, { rulers: !ed.ui.get().rulers }), (ed) => ed.ui.get().rulers),
  // View › Annotations (help.figma.com 20774752502935; ⇧Y per a user report, unverified).
  ui("view.annotations", "Annotations", [k("KeyY", { shift: true })], (ed) => toggleAnnotations(ed), (ed) => annotationsShown(ed)),
  // The live View menu: Pixel grid ⇧' (drawn from 300 % zoom), Layout guides ⇧G, Outlines ▸ (⇧⌘O), Pixel preview ⇧⌘P.
  ui("view.pixel-grid", "Pixel grid", [k("Quote", { shift: true })], (ed) => setViewOption(ed, { pixelGrid: !pixelGridOn(ed) }), (ed) => pixelGridOn(ed)),
  ui("view.layout-guides", "Layout guides", [k("KeyG", { shift: true })], (ed) => setViewOption(ed, { layoutGuides: ed.ui.get().layoutGuides === false }), (ed) => ed.ui.get().layoutGuides !== false),
  ui("view.show-slices", "Show slices", undefined, (ed) => setViewOption(ed, { showSlices: ed.ui.get().showSlices === false }), (ed) => ed.ui.get().showSlices !== false),
  // Round 10, View › Comments ⇧C (on by default): comment pins shown on the canvas (editor/comments).
  ui("view.comments", "Comments", [k("KeyC", { shift: true })], (ed) => ed.ui.set((s) => ({ comments: s.comments === false })), (ed) => ed.ui.get().comments !== false),
  ui("view.outlines", "Show outlines", [k("KeyO", { mod: true, shift: true })], (ed) => setViewOption(ed, { outlines: !ed.ui.get().outlines }), (ed) => !!ed.ui.get().outlines),
  // The zoom menu's Outlines ▸ (Figma's toggle-outline-mode-hidden-layers / -object-bounds, Atlas 04 §9.3): in outline
  // mode, hidden layers outlined too; each layer's box drawn (the engine's VIEW_OUTLINE_HIDDEN / VIEW_OUTLINE_BOUNDS).
  ui("view.outline-hidden-layers", "Show hidden layers", undefined, (ed) => setViewOption(ed, { outlineHiddenLayers: !ed.ui.get().outlineHiddenLayers }), (ed) => !!ed.ui.get().outlineHiddenLayers),
  ui("view.outline-object-bounds", "Show object bounds", undefined, (ed) => setViewOption(ed, { outlineObjectBounds: !ed.ui.get().outlineObjectBounds }), (ed) => !!ed.ui.get().outlineObjectBounds),
  // Live: View › Pixel preview ⇧⌘P; ⌃P toggles it ("Pixel preview enabled (1x)" / "Pixel preview disabled").
  ui("view.pixel-preview", "Pixel preview", [k("KeyP", { mod: true, shift: true }), k("KeyP", { ctrl: true })], (ed) => setViewOption(ed, { pixelPreview: ed.ui.get().pixelPreview ? 0 : 1 }), (ed) => !!ed.ui.get().pixelPreview),
  // Round 10: the engine's thin boxes around masks / frames (VIEW_MASK_OUTLINES / VIEW_FRAME_OUTLINES).
  ui("view.mask-outlines", "Mask outlines", undefined, (ed) => setViewOption(ed, { maskOutlines: !ed.ui.get().maskOutlines }), (ed) => !!ed.ui.get().maskOutlines),
  ui("view.frame-outlines", "Frame outlines", undefined, (ed) => setViewOption(ed, { frameOutlines: !ed.ui.get().frameOutlines }), (ed) => !!ed.ui.get().frameOutlines),
  ui("view.memory-usage", "Memory usage", undefined, (ed) => ed.ui.set((s) => ({ memoryUsage: !s.memoryUsage })), (ed) => !!ed.ui.get().memoryUsage),
  // ⌥⌘\ (on by default): other people's cursors (none until multiplayer, roadmap Phase 6).
  ui("view.multiplayer-cursors", "Multiplayer cursors", [k("Backslash", { mod: true, alt: true })], (ed) => ed.ui.set((s) => ({ multiplayerCursors: s.multiplayerCursors === false })), (ed) => ed.ui.get().multiplayerCursors !== false),
  // Draw (live's View menu and the toolbar's mode switch; docs/draw.md §5.7): Draw's toolbar and panels; Draw starts on
  // Move [unverified]. Again: back to Design (leaving with the Brush puts Move back: draw/drawTools.ts).
  ui("view.switch-to-draw", "Switch to Draw", undefined, (ed) => {
    if (modeOf(ed) === "draw") return setMode(ed, "design");
    setMode(ed, "draw");
    ed.setTool("MOVE");
  }, (ed) => modeOf(ed) === "draw"),
  // Motion (docs/motion.md §6.1, §6.9): the mode switch's Motion segment, View › Switch to Motion (no shortcut [unverified]).
  ui("view.switch-to-motion", "Switch to Motion", undefined, (ed) => {
    if (modeOf(ed) === "motion") return setMode(ed, "design");
    setMode(ed, "motion");
    ed.setTool("MOVE");
  }, (ed) => modeOf(ed) === "motion"),
  // Space plays and pauses while Motion is on (help: "Spacebar plays, again pauses"); elsewhere Space is the Hand tool's.
  { id: "motion.play-pause", label: "Play/Pause", keys: [k("Space")], run: (ed) => toggleMotionPlaying(ed), enabled: (ed) => modeOf(ed) === "motion" },
  { id: "motion.toggle-auto-keyframe", label: "Toggle auto-keyframe", run: (ed) => toggleAutoKeyframe(ed), enabled: (ed) => modeOf(ed) === "motion", checked: (ed) => !!ed.ui.get().motion?.autoKeyframe },
  { id: "motion.collapse-timeline", label: "Collapse timeline", run: (ed) => ed.ui.set({ motion: { ...(ed.ui.get().motion ?? MOTION_UI_DEFAULT), collapsed: !(ed.ui.get().motion ?? MOTION_UI_DEFAULT).collapsed } }), enabled: (ed) => modeOf(ed) === "motion" },
  // Figma's shortcut table (Atlas 04 §2.5): ⌘= ⌘+ ⌘Num+ = + Num+ / ⌘- ⌘⇧- ⌘Num- - ⇧- Num-; ⇧1 and ⇧9 fit. With
  // Preferences › Use number keys for opacity off, 0 / 1 / 9 / 2 alone zoom (keyboard.ts).
  engine("view.zoom-in", "Zoom in", "ZOOM_IN", [k("Equal", { mod: true }), k("Equal", { mod: true, shift: true }), k("NumpadAdd", { mod: true }), k("Equal"), k("Equal", { shift: true }), k("NumpadAdd")]),
  engine("view.zoom-out", "Zoom out", "ZOOM_OUT", [k("Minus", { mod: true }), k("Minus", { mod: true, shift: true }), k("NumpadSubtract", { mod: true }), k("Minus"), k("Minus", { shift: true }), k("NumpadSubtract")]),
  engine("view.zoom-100", "Zoom to 100%", "ZOOM_TO_100", [k("Digit0", { mod: true }), k("Digit0", { shift: true })]),
  engine("view.zoom-fit", "Zoom to fit", "ZOOM_TO_FIT", [k("Digit1", { shift: true }), k("Digit9", { shift: true })]),
  engine("view.zoom-selection", "Zoom to selection", "ZOOM_TO_SELECTION", [k("Digit2", { shift: true })]),
  ui("view.zoom-50", "Zoom to 50%", undefined, (ed) => zoomTo(ed, 0.5)),
  ui("view.zoom-200", "Zoom to 200%", undefined, (ed) => zoomTo(ed, 2)),
  { id: "view.previous-page", label: "Previous page", keys: [k("PageUp")], run: (ed) => goToPage(ed, -1) },
  { id: "view.next-page", label: "Next page", keys: [k("PageDown")], run: (ed) => goToPage(ed, 1) },
  // N / ⇧N: the view to the next / previous frame; the selection stays (live Figma).
  engine("view.zoom-previous-frame", "Zoom to previous frame", "ZOOM_TO_PREVIOUS_FRAME", [k("KeyN", { shift: true })]),
  engine("view.zoom-next-frame", "Zoom to next frame", "ZOOM_TO_NEXT_FRAME", [k("KeyN")]),
  // Round 10, Home / End: the previous / next top-level frame selected and centred at the same zoom (objectCommands.ts).
  { id: "view.find-previous-frame", label: "Find previous frame", keys: [k("Home")], run: (ed) => findFrame(ed, -1), enabled: (ed) => !!ed.store.page },
  { id: "view.find-next-frame", label: "Find next frame", keys: [k("End")], run: (ed) => findFrame(ed, 1), enabled: (ed) => !!ed.store.page },

  // ---- Panels ----
  ui("view.layers", "Layers", [k("Digit1", { alt: true })], (ed) => ed.ui.set({ railTab: "file", uiHidden: false, uiMinimized: false }), (ed) => ed.ui.get().railTab === "file"),
  ui("view.assets", "Assets", [k("Digit2", { alt: true })], (ed) => ed.ui.set({ railTab: "assets", uiHidden: false, uiMinimized: false }), (ed) => ed.ui.get().railTab === "assets"),
  // The navigation bar's Variables (Figma 2026: the variables view moved there from the right sidebar).
  ui("view.local-variables", "Variables", undefined, (ed) => ed.ui.set((s) => ({ variablesOpen: !s.variablesOpen, uiHidden: false })), (ed) => ed.ui.get().variablesOpen),
  ui("view.agents", "Agents", undefined, (ed) => ed.ui.set({ railTab: "agents", uiHidden: false, uiMinimized: false }), (ed) => ed.ui.get().railTab === "agents"),
  ui("view.tools", "Tools", undefined, (ed) => ed.ui.set({ railTab: "tools", uiHidden: false, uiMinimized: false }), (ed) => ed.ui.get().railTab === "tools"),
  ui("view.design-panel", "Open design panel", [k("Digit8", { alt: true })], (ed) => ed.ui.set({ rightTab: "design", uiHidden: false, uiMinimized: false })),
  ui("view.prototype-panel", "Open prototype panel", [k("Digit9", { alt: true })], (ed) => ed.ui.set({ rightTab: "prototype", uiHidden: false, uiMinimized: false })),
  // ⌥3 (live's Keyboard shortcuts panel, View and Components: "Team library"): the Libraries modal. Its own command — the
  // live Figma menu's "Libraries…" shows no key.
  ui("view.team-library", "Team library", [k("Digit3", { alt: true })], (ed) => ed.ui.set({ librariesDialog: { tab: "libraries" }, uiHidden: false })),
  // ⇧I (live's Keyboard shortcuts panel, Essential: "Search for and insert components without losing your flow"): the
  // Assets tab with its search field focused.
  ui("view.component-search", "Component search", [k("KeyI", { shift: true })], (ed) => {
    ed.ui.set({ railTab: "assets", uiHidden: false, uiMinimized: false });
    const focus = () => document.querySelector<HTMLInputElement>("[data-panel='left'] [data-assets-search] input, [data-panel='left'] input[type='search']")?.focus();
    requestAnimationFrame(() => requestAnimationFrame(focus));
  }),

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
  // Round 10: in place, the engine's (same GUID, layers and look).
  engine("object.convert-to-section", "Convert to section", "CONVERT_TO_SECTION"),
  engine("object.convert-to-frame", "Convert to frame", "CONVERT_TO_FRAME"),
  // The file's thumbnail (the document's thumbnailInfo; persistence.ts renders it for Home's card).
  { id: "object.set-as-thumbnail", label: "Set as thumbnail", run: (ed) => setThumbnail(ed, ed.selection[0] ?? null), enabled: canSetThumbnail },
  { id: "object.restore-default-thumbnail", label: "Restore default thumbnail", run: (ed) => setThumbnail(ed, null), enabled: (ed) => thumbnailNode(ed) !== null },
  // More layout options ▸ (unverified items): auto layout of a chosen flow.
  ...(["HORIZONTAL", "VERTICAL", "GRID"] as LayoutFlow[]).map(
    (flow): EditorCommand => ({
      id: `object.add-layout-${flow.toLowerCase()}`,
      label: flow === "GRID" ? "Add grid layout" : `Add ${flow.toLowerCase()} auto layout`,
      run: (ed) => addLayout(ed, flow),
      enabled: (ed) => hasSelection(ed) && (engineEnabled(ed, "ADD_AUTO_LAYOUT") || ed.selectedNodes().every((n) => n.type === "FRAME" || n.type === "SYMBOL")),
    })
  ),
  { id: "object.hide-other-layers", label: "Hide other layers", run: (ed) => hideOtherLayers(ed), enabled: (ed) => otherLayers(ed).length > 0 },
  later("object.remove-interactions", "Remove interactions"),
  { id: "object.remove-fill", label: "Remove fill", keys: [k("Slash", { alt: true })], run: (ed) => removePaints(ed, "fillPaints", "Remove fill"), enabled: hasSelection },
  { id: "object.remove-stroke", label: "Remove stroke", keys: [k("Slash", { shift: true })], run: (ed) => removePaints(ed, "strokePaints", "Remove stroke"), enabled: hasSelection },
  { id: "object.swap-fill-stroke", label: "Swap fill and stroke", keys: [k("KeyX", { shift: true })], run: (ed) => swapFillAndStroke(ed), enabled: hasSelection },
  engine("object.add-auto-layout", "Add auto layout", "ADD_AUTO_LAYOUT", [k("KeyA", { shift: true })]),
  engine("object.remove-auto-layout", "Remove auto layout", "REMOVE_AUTO_LAYOUT", [k("KeyA", { shift: true, alt: true })]),
  // Atlas 09 §4 (wave 2): Suggest auto layout ⌃⇧A (live's Keyboard shortcuts panel, Arrange) and Figma's
  // destroy-all-auto-layout beside it; the layout version's bulk actions (search-only in Figma's Actions).
  engine("object.suggest-auto-layout", "Suggest auto layout", "SUGGEST_AUTO_LAYOUT", [k("KeyA", { ctrl: true, shift: true })], { run: suggestAutoLayout }),
  engine("object.remove-all-auto-layout", "Remove all auto layout", "REMOVE_ALL_AUTO_LAYOUT", undefined, { run: removeAllAutoLayout }),
  engine("object.update-layout-version", "Update layout version for selection", "SET_STACK_LAYOUT_VERSION", undefined, {
    run: (ed) => void ed.engine.runCommand("SET_STACK_LAYOUT_VERSION", { deep: true }),
  }),
  { id: "object.update-layout-version-page", label: "Update layout version for page", run: (ed) => void ed.engine.runCommand("SET_STACK_LAYOUT_VERSION", { page: true }) },
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
  // A ruler's context menu (Figma's rulerGuideMenu, Atlas 04 §4.2): the top ruler's guides or the left one's, then
  // Hide rulers. The English of the first two is unverified (keys remove-horizontal-guides / remove-vertical-guides).
  engine("canvas.remove-horizontal-guides", "Remove horizontal guides", "REMOVE_HORIZONTAL_GUIDES"),
  engine("canvas.remove-vertical-guides", "Remove vertical guides", "REMOVE_VERTICAL_GUIDES"),
  ui("canvas.hide-rulers", "Hide rulers", undefined, (ed) => setViewOption(ed, { rulers: false })),
  // Round 10 (engine/src/editor/ArrangeCommands.cpp).
  engine("arrange.round-to-pixel", "Round to pixel", "ROUND_TO_PIXEL"),
  engine("arrange.pack-horizontal", "Pack horizontal", "PACK_HORIZONTAL"),
  engine("arrange.pack-vertical", "Pack vertical", "PACK_VERTICAL"),
  engine("arrange.distribute-left", "Distribute left", "DISTRIBUTE_LEFT"),
  engine("arrange.distribute-horizontal-centers", "Distribute horizontal centers", "DISTRIBUTE_HORIZONTAL_CENTERS"),
  engine("arrange.distribute-right", "Distribute right", "DISTRIBUTE_RIGHT"),
  engine("arrange.distribute-top", "Distribute top", "DISTRIBUTE_TOP"),
  engine("arrange.distribute-vertical-centers", "Distribute vertical centers", "DISTRIBUTE_VERTICAL_CENTERS"),
  engine("arrange.distribute-bottom", "Distribute bottom", "DISTRIBUTE_BOTTOM"),

  // ---- Vector, booleans (E4) ----
  pending("vector.flatten", "Flatten", "FLATTEN", [k("KeyF", { alt: true, shift: true }), k("KeyE", { mod: true })]),
  pending("vector.outline-stroke", "Outline stroke", "OUTLINE_STROKE", [k("KeyO", { mod: true, alt: true })]),
  pending("vector.union", "Union selection", "BOOLEAN_UNION", [k("KeyU", { alt: true, shift: true })]),
  pending("vector.subtract", "Subtract selection", "BOOLEAN_SUBTRACT", [k("KeyS", { alt: true, shift: true })]),
  pending("vector.intersect", "Intersect selection", "BOOLEAN_INTERSECT", [k("KeyI", { alt: true, shift: true })]),
  pending("vector.exclude", "Exclude selection", "BOOLEAN_EXCLUDE", [k("KeyE", { alt: true, shift: true })]),
  // A boolean group made with an older version of the boolean operations brought to the latest (the Design panel's
  // Update, panels/design/VectorOperation.tsx; Atlas 05 §9.2).
  engine("vector.update-boolean", "Update boolean", "UPGRADE_VECTOR_OPERATION"),
  // The Figma menu › Vector (live main-vector.txt): vector edit mode's point commands.
  // Round 10 (the engine's): vector edit mode's selected points joined, straight or smooth.
  engine("vector.join", "Join selection", "VECTOR_JOIN", [k("KeyJ", { mod: true })]),
  engine("vector.smooth-join", "Smooth join selection", "VECTOR_JOIN", [k("KeyJ", { mod: true, shift: true })], { run: (ed) => void ed.engine.command("VECTOR_JOIN", { smooth: true }) }),
  engine("vector.delete-heal", "Delete and heal selection", "VECTOR_DELETE_AND_HEAL", [k("Backspace", { shift: true })]),
  engine("vector.split", "Split vector", "VECTOR_SPLIT"),
  // help.figma.com "Simplify a vector path" (a slider) / "Offset a vector path" (Amount, Join, ✓): their popover.
  // Figma's tools (rea/vector.md §8, §10): the menu opens them; their toolbar applies or cancels (canvas/PathToolbar).
  engine("vector.simplify", "Simplify vector", "VECTOR_SIMPLIFY", undefined, { run: (ed) => void openPathTool(ed, "SIMPLIFY") }),
  engine("vector.offset", "Offset vector", "VECTOR_OFFSET", undefined, { run: (ed) => void openPathTool(ed, "OFFSET") }),

  // ---- Draw (round 7c, docs/draw.md §5.7; the engine's CommandIds 310–321) ----
  // Right-click › Create brush › Stretch brush / Scatter brush (help.figma.com 31440438150935): one vector-like layer.
  { id: "object.create-brush.stretch", label: "Stretch brush", run: (ed) => void createBrush(ed, "STRETCH"), enabled: canCreateBrush },
  { id: "object.create-brush.scatter", label: "Scatter brush", run: (ed) => void createBrush(ed, "SCATTER"), enabled: canCreateBrush },
  // A transform group's repeats become real layers (help.figma.com 31440427042839).
  { id: "object.apply-transforms", label: "Apply transforms to selection", run: (ed) => void applyTransforms(ed), enabled: canApplyTransforms },
  // Text on a path: the text to the path's other side (Typography's Flip; wording [unverified]).
  { id: "text.flip-path", label: "Flip", run: (ed) => void flipTextPath(ed), enabled: canFlipTextPath },

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
  // Text › Text direction ▸ (live: listed, items not captured; unverified).
  textDirection("text.direction-auto", "Auto", "AUTO"),
  textDirection("text.direction-ltr", "Left to right", "LTR"),
  textDirection("text.direction-rtl", "Right to left", "RTL"),
  // Text › Spell check ▸ (round 10; help.figma.com, unverified): the edited text's misspelled words underlined (spellcheck.ts).
  { id: "text.spell-check", label: "Spell check", run: (ed) => setSpellCheck(ed, !spellCheckOn()), enabled: () => !!spellChecker(), checked: () => !!spellChecker() && spellCheckOn() },
  textCommand("text.align-center", "Text align center", [k("KeyT", { mod: true, alt: true })], (ed, refs) => ed.setProps(refs, fields({ textAlignHorizontal: "CENTER" }), "Text alignment")),
  textCommand("text.align-right", "Text align right", [k("KeyR", { mod: true, alt: true })], (ed, refs) => ed.setProps(refs, fields({ textAlignHorizontal: "RIGHT" }), "Text alignment")),
  // Live's Keyboard shortcuts panel (Text): "Text align justified ⌥⌘J".
  textCommand("text.align-justified", "Text align justified", [k("KeyJ", { mod: true, alt: true })], (ed, refs) => ed.setProps(refs, fields({ textAlignHorizontal: "JUSTIFIED" }), "Text alignment")),

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
  // Round 10: the workspace's file operations, where the document source has them (objectCommands.ts FileOps).
  { id: "file.duplicate", label: "Duplicate", run: (ed) => void duplicateFile(ed), enabled: (ed) => canDuplicateFile(ed) },
  { id: "file.move", label: "Move to folder…", run: (ed) => ed.ui.set({ moveFileDialog: true, uiHidden: false }), enabled: (ed) => !!fileOps(ed) },
  { id: "file.save-local-copy", label: "Save local copy…", run: (ed) => void saveLocalCopy(ed), enabled: canSaveLocalCopy },
  // Branching (Phase 7 round 2b, branching/commands.ts): Create branch…, See all branches, Update from main…, Review
  // and merge changes…, Archive.
  ...BRANCH_COMMANDS,
  // The document's colour profile: sRGB / Display P3, converted or assigned (ColorProfileDialog.tsx, atlas 07 §14).
  ui("file.color-profile", "Color profile…", undefined, (ed) => ed.ui.set({ colorProfileDialog: true, uiHidden: false })),
  // Plugins (docs/plugins.md §6; plugins/service.ts). Widgets aren't built (§11): listed as Figma lists them, disabled.
  ...PLUGIN_COMMANDS,
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
        const said = TOGGLE_TOASTS[p.key];
        if (said) showToast({ message: t(pref(ed.ui.get(), p.key) ? said[0] : said[1]) });
      },
      checked: (ed) => pref(ed.ui.get(), p.key),
    })
  ),
  later("prefs.color-profile", "Color profile…"),
  // help.figma.com "Select a keyboard layout": the Keyboard shortcuts panel's Layout tab.
  ui("prefs.keyboard-layout", "Keyboard layout…", undefined, (ed) => ed.ui.set({ shortcutsOpen: true, shortcutsTab: "layout" })),
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
    // Libraries publish from main only (docs/data.md §15.5 branch-cannot-publish).
    enabled: (ed) => ed.libraries.get().on && !isBranch(ed),
  },
  // The file name menu's "Library analytics" (help "View and explore library analytics": an org library's file)
  { id: "file.library-analytics", label: "Library analytics", run: openLibraryAnalytics, enabled: canShowLibraryAnalytics },
  // Dev Mode's file name menu › Library ▸ (docs/editor.md D-1, Code Connect UI): the file's components and their code.
  { id: "dev.connect-components", label: "Connect components to code", run: (ed) => setRound5(ed, { connect: { focus: [] } }), enabled: (ed) => modeOf(ed) === "dev" && round5(ed).canEdit && ed.components.assets().length > 0 },
  // exporting.ts's checks are called, not referenced, here: the modules import each other, and a hot update that
  // re-evaluated this list first met `canExport` in its temporal dead zone.
  { id: "file.export", label: "Export…", keys: [k("KeyE", { mod: true, shift: true })], run: (ed) => ed.ui.set({ exportDialog: true, uiHidden: false }), enabled: (ed) => canExport(ed) },
  { id: "file.export-frames-to-pdf", label: "Export frames to PDF…", run: (ed) => void exportFramesToPdf(ed), enabled: (ed) => canExport(ed) },
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
      else showToast({ message: t("Files open in the desktop app's Home") });
    },
  },
  theme("theme.light", "Light", "light"),
  theme("theme.dark", "Dark", "dark"),
  theme("theme.system", "Use system setting", "system"),
  later("canvas.send-to-make", "Send to Figma Make"),
  later("canvas.find-similar", "Find similar designs"),
  later("canvas.add-motion", "Add motion"),
  // Rename layers with AI (the Layers row's menu, "AI" tag; docs/ai.md §3, editor/ai): the selected layers' default names.
  {
    id: "canvas.rename-layers-ai",
    label: "Rename layers",
    run: (ed) => void import("./ai/service").then((m) => m.aiOf(ed).renameLayers({ refs: [...ed.selection] })),
    enabled: (ed) => ed.selection.length > 0,
  },
  // The main menu's "AI balance" (help 33459875669015: credits used, remaining, the reset date): the modal of settings/AiBalance.tsx.
  { id: "file.ai-balance", label: "AI balance", run: () => openAiBalance() },
  // Round 10, / : the cursor chat bubble at the pointer (seen by nobody else until multiplayer, roadmap Phase 6).
  ui("canvas.cursor-chat", "Cursor chat", [k("Slash")], (ed) => openCursorChat(ed)),
  // Help and account (live main-help.txt): Figma's own pages open in the browser; no account here.
  link("help.page", "Help page", "https://help.figma.com/"),
  ui("help.shortcuts", "Keyboard shortcuts", [k("Slash", { ctrl: true, shift: true })], (ed) => ed.ui.set((s) => ({ shortcutsOpen: !s.shortcutsOpen }))),
  link("help.forum", "Support forum", "https://forum.figma.com/"),
  link("help.videos", "Video tutorials", "https://www.youtube.com/@Figma"),
  link("help.release-notes", "Release notes", "https://www.figma.com/release-notes/"),
  later("help.font-settings", "Open font settings"),
  link("help.legal", "Legal summary", "https://www.figma.com/legal/"),
  // The Settings modal (src/renderer/src/settings) over the editor; Log out of the account (docs/multiplayer.md §2).
  { id: "help.account", label: "Account settings", run: () => openSettings("account") },
  { id: "help.log-out", label: "Log out", run: () => void accountBridge()?.signOut(), enabled: () => accountSignedIn() },
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

/** "can view" in a shared file (the role the room gave; the engine is in viewer mode then: Multiplayer.tsx). */
export function viewOnly(ed: EditorController): boolean {
  // An editor without a source (a test's stub) is no shared file.
  if (!ed.source) return false;
  const p = presenceOf(ed)?.state;
  return !!p?.shared && p.role === "viewer";
}

/**
 * The commands that change the file outside the engine's command table (whose own state already refuses edits in viewer
 * mode): off for a viewer. Figma's "can view" (help.figma.com "Share files and prototypes", "Guide to branching"):
 * view, comment, inspect, export and copy as the owner allows — no editing, no placing images, no renaming the file or
 * its layers, no moving it, no versions or publishing, and branches only by people who can edit the main file.
 */
const VIEWER_EDITS = new Set([
  "edit.cut",
  "edit.paste",
  "edit.paste-over-selection",
  "edit.paste-here",
  "edit.paste-to-replace",
  "edit.paste-properties",
  "edit.find-replace",
  "tool.image",
  "file.place-image",
  "file.rename",
  "file.move",
  "file.save-version",
  "file.publish-library",
  "file.create-branch",
  "file.update-from-main",
  "file.review-and-merge",
  "file.archive-branch",
  "object.ungroup",
  "object.set-as-thumbnail",
  "object.restore-default-thumbnail",
  "object.hide-other-layers",
  "object.remove-fill",
  "object.remove-stroke",
  "object.swap-fill-stroke",
  "object.reset-all-changes",
  "object.rotate-180",
  "object.rotate-90-left",
  "object.rotate-90-right",
  "object.rename",
  "object.create-brush.stretch",
  "object.create-brush.scatter",
  "object.apply-transforms",
  "object.mark-ready-for-dev",
  "object.mark-completed",
  "object.remove-dev-status",
  "canvas.rename-layers-ai",
]);
const viewerEdits = (id: string) => VIEWER_EDITS.has(id) || id.startsWith("object.add-layout-") || (id.startsWith("text.") && id !== "text.spell-check");
for (const c of COMMANDS) {
  if (!viewerEdits(c.id)) continue;
  const own = c.enabled;
  c.enabled = (ed) => !viewOnly(ed) && (own ? own(ed) : true);
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
export function commandForKey(e: Pick<KeyboardEvent, "code" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">): EditorCommand | null {
  // A layout picked in the Keyboard shortcuts panel: the key that types the binding's character.
  const code = keyLayout ? keyLayout.toBinding(e.code) : e.code;
  if (code === null) return null;
  const press = { code, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey };
  for (const c of COMMANDS) if (c.keys?.some((combo) => matchesCombo(combo, press))) return c;
  return null;
}

/** A pressed key as the bindings name it (the picked layout's key → the U.S. one), or null: no shortcut is on it. */
export const bindingCode = (code: string): string | null => (keyLayout ? keyLayout.toBinding(code) : code);

/** The shortcut shown next to a command. */
export const shortcutOf = (c: EditorCommand): string | undefined => (c.keys?.length ? comboText(c.keys[0]) : undefined);

/** Engine command state bits, for callers holding a CommandName. */
export const engineEnabled = (ed: EditorController, name: CommandName) => (ed.engine.commandState(name) & CMD_ENABLED) !== 0;
