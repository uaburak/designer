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
import { present } from "./present";
import { COMPONENT_COMMAND, canPushChanges, goToMainComponent, instanceChanges, mainOf, pageOf, resetChanges, returnToInstance, selectedInstance } from "./components";

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
  Minus: "-",
  Slash: "/",
  Quote: "'",
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
  PageUp: "PgUp",
  PageDown: "PgDn",
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

function goToPage(ed: EditorController, step: 1 | -1) {
  const pages = ed.store.pages;
  const at = pages.findIndex((p) => p.guid === ed.store.page);
  const next = pages[at + step];
  if (next) ed.engine.setCurrentPage(next.guid);
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
  tool("tool.comment", "Comment", "COMMENT", [k("KeyC")]),
  tool("tool.hand", "Hand tool", "HAND", [k("KeyH")]),
  later("tool.actions", "Actions…", [k("KeyK", { mod: true })]),

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
    id: "edit.paste-over-selection",
    label: "Paste over selection",
    keys: [k("KeyV", { mod: true, shift: true })],
    native: true,
    prepare: (ed) => {
      ed.pendingPaste = { mode: "inPlace" };
    },
    run: (ed) => pasteFromMenu(ed, { mode: "inPlace" }),
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
  later("edit.paste-to-replace", "Paste to replace", [k("KeyR", { mod: true, shift: true })]),
  later("edit.copy-as-png", "Copy as PNG", [k("KeyC", { mod: true, shift: true })]),
  later("edit.copy-as-svg", "Copy as SVG"),
  later("edit.copy-as-code", "Copy as code"),
  later("edit.copy-as-text", "Copy as text"),
  engine("edit.duplicate", "Duplicate", "DUPLICATE", [k("KeyD", { mod: true })]),
  engine("edit.delete", "Delete", "DELETE", [k("Backspace"), k("Delete")]),
  later("edit.copy-properties", "Copy properties", [k("KeyC", { mod: true, alt: true })]),
  later("edit.paste-properties", "Paste properties", [k("KeyV", { mod: true, alt: true })]),
  later("edit.find", "Find and replace…", [k("KeyF", { mod: true })]),
  engine("edit.select-all", "Select all", "SELECT_ALL", [k("KeyA", { mod: true })]),
  later("edit.select-matching", "Select matching layers", [k("KeyA", { mod: true, alt: true })]),
  engine("edit.select-none", "Select none", "SELECT_NONE"),
  engine("edit.select-inverse", "Select inverse", "SELECT_INVERSE", [k("KeyA", { mod: true, shift: true })]),

  // ---- View ----
  ui("view.toggle-ui", "Show/Hide UI", [k("Backslash", { mod: true })], (ed) => ed.ui.set((s) => ({ uiHidden: !s.uiHidden }))),
  ui("view.minimize-ui", "Minimize UI", [k("Backslash", { shift: true })], (ed) => ed.ui.set((s) => ({ uiMinimized: !s.uiMinimized, uiHidden: false })), (ed) => ed.ui.get().uiMinimized),
  ui("view.rulers", "Rulers", [k("KeyR", { shift: true })], (ed) => ed.ui.set((s) => ({ rulers: !s.rulers })), (ed) => ed.ui.get().rulers),
  ui("view.property-labels", "Property labels", undefined, (ed) => ed.ui.set((s) => ({ propertyLabels: !s.propertyLabels })), (ed) => ed.ui.get().propertyLabels),
  later("view.pixel-grid", "Pixel grid", [k("Quote", { shift: true })]),
  later("view.snap-pixel-grid", "Snap to pixel grid", [k("Quote", { mod: true, shift: true })]),
  later("view.layout-guides", "Layout guides", [k("KeyG", { ctrl: true })]),
  later("view.outlines", "Outlines", [k("KeyY", { mod: true })]),
  engine("view.zoom-in", "Zoom in", "ZOOM_IN", [k("Equal", { mod: true }), k("Equal", { mod: true, shift: true }), k("Equal"), k("NumpadAdd")]),
  engine("view.zoom-out", "Zoom out", "ZOOM_OUT", [k("Minus", { mod: true }), k("Minus"), k("NumpadSubtract")]),
  engine("view.zoom-100", "Zoom to 100%", "ZOOM_TO_100", [k("Digit0", { shift: true }), k("Digit0", { mod: true })]),
  engine("view.zoom-fit", "Zoom to fit", "ZOOM_TO_FIT", [k("Digit1", { shift: true })]),
  engine("view.zoom-selection", "Zoom to selection", "ZOOM_TO_SELECTION", [k("Digit2", { shift: true })]),
  ui("view.zoom-50", "Zoom to 50%", undefined, (ed) => zoomTo(ed, 0.5)),
  ui("view.zoom-200", "Zoom to 200%", undefined, (ed) => zoomTo(ed, 2)),
  { id: "view.previous-page", label: "Previous page", keys: [k("PageUp")], run: (ed) => goToPage(ed, -1) },
  { id: "view.next-page", label: "Next page", keys: [k("PageDown")], run: (ed) => goToPage(ed, 1) },

  // ---- Panels ----
  ui("view.layers", "Layers", [k("Digit1", { alt: true })], (ed) => ed.ui.set({ railTab: "file", uiHidden: false, uiMinimized: false }), (ed) => ed.ui.get().railTab === "file"),
  ui("view.assets", "Assets", [k("Digit2", { alt: true })], (ed) => ed.ui.set({ railTab: "assets", uiHidden: false, uiMinimized: false }), (ed) => ed.ui.get().railTab === "assets"),
  ui("view.local-variables", "Local variables", undefined, (ed) => ed.ui.set((s) => ({ variablesOpen: !s.variablesOpen, uiHidden: false })), (ed) => ed.ui.get().variablesOpen),

  // ---- Object ----
  engine("object.group", "Group selection", "GROUP", [k("KeyG", { mod: true })]),
  engine("object.ungroup", "Ungroup selection", "UNGROUP", [k("KeyG", { mod: true, shift: true })]),
  engine("object.frame-selection", "Frame selection", "FRAME_SELECTION", [k("KeyG", { mod: true, alt: true })]),
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
  {
    id: "object.return-to-instance",
    label: "Return to instance",
    run: (ed) => returnToInstance(ed),
    enabled: (ed) => !!ed.ui.get().returnToInstance,
  },
  pending("object.use-as-mask", "Use as mask", "USE_AS_MASK", [k("KeyM", { mod: true, ctrl: true })], {
    checked: (ed) => ed.selectedNodes().some((n) => (n as { mask?: boolean }).mask === true),
  }),
  engine("object.bring-to-front", "Bring to front", "BRING_TO_FRONT", [k("BracketRight", { mod: true, alt: true })]),
  engine("object.bring-forward", "Bring forward", "BRING_FORWARD", [k("BracketRight", { mod: true })]),
  engine("object.send-backward", "Send backward", "SEND_BACKWARD", [k("BracketLeft", { mod: true })]),
  engine("object.send-to-back", "Send to back", "SEND_TO_BACK", [k("BracketLeft", { mod: true, alt: true })]),
  engine("object.flip-horizontal", "Flip horizontal", "FLIP_HORIZONTAL", [k("KeyH", { shift: true })]),
  engine("object.flip-vertical", "Flip vertical", "FLIP_VERTICAL", [k("KeyV", { shift: true })]),
  { id: "object.rotate-180", label: "Rotate 180°", run: (ed) => rotateSelection(ed, 180), enabled: hasSelection },
  { id: "object.rotate-90-left", label: "Rotate 90° left", run: (ed) => rotateSelection(ed, 90), enabled: hasSelection },
  { id: "object.rotate-90-right", label: "Rotate 90° right", run: (ed) => rotateSelection(ed, -90), enabled: hasSelection },
  engine("object.toggle-visible", "Show/Hide selection", "TOGGLE_VISIBLE", [k("KeyH", { mod: true, shift: true })]),
  engine("object.toggle-lock", "Lock/Unlock selection", "TOGGLE_LOCK", [k("KeyL", { mod: true, shift: true })]),
  {
    id: "object.rename",
    label: "Rename",
    keys: [k("KeyR", { mod: true })],
    run: (ed) => {
      const first = ed.selection[0];
      if (first) ed.ui.set({ railTab: "file", renaming: { kind: "layer", id: first }, uiHidden: false, uiMinimized: false });
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
  later("arrange.tidy-up", "Tidy up", [k("KeyT", { alt: true, ctrl: true })]),

  // ---- Vector, booleans (E4) ----
  pending("vector.flatten", "Flatten", "FLATTEN", [k("KeyE", { mod: true })]),
  pending("vector.outline-stroke", "Outline stroke", "OUTLINE_STROKE", [k("KeyO", { mod: true, alt: true })]),
  pending("vector.union", "Union selection", "BOOLEAN_UNION", [k("KeyU", { alt: true, shift: true })]),
  pending("vector.subtract", "Subtract selection", "BOOLEAN_SUBTRACT", [k("KeyS", { alt: true, shift: true })]),
  pending("vector.intersect", "Intersect selection", "BOOLEAN_INTERSECT", [k("KeyI", { alt: true, shift: true })]),
  pending("vector.exclude", "Exclude selection", "BOOLEAN_EXCLUDE", [k("KeyE", { alt: true, shift: true })]),

  // ---- Text (E3) ----
  later("text.bold", "Bold", [k("KeyB", { mod: true })]),
  later("text.italic", "Italic", [k("KeyI", { mod: true })]),
  later("text.underline", "Underline", [k("KeyU", { mod: true })]),
  later("text.strikethrough", "Strikethrough", [k("KeyX", { mod: true, shift: true })]),
  later("text.align-left", "Text align left", [k("KeyL", { mod: true, alt: true })]),
  later("text.align-center", "Text align center", [k("KeyT", { mod: true, alt: true })]),
  later("text.align-right", "Text align right", [k("KeyR", { mod: true, alt: true })]),

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
    run: (ed) => ed.ui.set({ librariesDialog: { tab: "libraries" }, uiHidden: false }),
    enabled: (ed) => ed.libraries.get().on,
  },
  {
    id: "file.publish-library",
    label: "Publish library…",
    run: (ed) => ed.ui.set({ publishOpen: true, uiHidden: false }),
    enabled: (ed) => ed.libraries.get().on,
  },
  later("file.export", "Export…", [k("KeyE", { mod: true, shift: true })]),
  later("file.export-frames-to-pdf", "Export frames to PDF…"),
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
  ui("help.shortcuts", "Keyboard shortcuts", [k("Slash", { ctrl: true, shift: true })], (ed) => ed.ui.set((s) => ({ shortcutsOpen: !s.shortcutsOpen }))),
  // Prototyping (R8 §9): Present opens the presentation view in a new tab; "in this tab" over the editor.
  ui("view.present", "Present", [k("Enter", { mod: true, alt: true })], (ed) => present(ed)),
  ui("view.present-here", "Present in this tab", undefined, (ed) => present(ed, { here: true })),
  later("view.preview", "Preview", [k("Space", { shift: true })]),
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
