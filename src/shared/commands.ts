/**
 * The menu bar's commands (docs/desktop.md §8): one registry that the menu
 * (src/main/menu.ts) is built from and the views' `menu:command` handlers
 * read. Ids are `<area>.<verb>` and never change once shipped; the editor's
 * ids and wording are the editor's own (src/renderer/src/editor/commands.ts,
 * Figma's sentence-case labels), so `menu:command {id}` runs the editor
 * command of the same id.
 *
 * Scopes (who runs it):
 * - `app`: main, whatever is in front (theme, Open data folder)
 * - `shell`: main's TabManager (tabs, new file, import, dev tools)
 * - `view`: the content view in front — Home or a file — as `menu:command`
 *   (in Home, Undo and Redo, and any Edit key it left unhandled, run
 *   natively: its text fields are DOM)
 * - `editor`: the file tab in front, as `menu:command`; disabled on Home
 *
 * Enablement: `view` and `editor` items are disabled until the view in front
 * reports them (`menu:state`, §8.4); main manages `app` and `shell`.
 * Accelerators without ⌘ or ⌃ (⇧R, ⌥A, ⌫, PgUp…) are shown, never
 * registered: the page handles those keys itself, and a registered one would
 * eat the letter typed into a text field.
 */
export type CommandScope = "app" | "shell" | "view" | "editor";

export interface CommandSpec {
  id: string;
  label: string;
  accelerator?: string;
  scope: CommandScope;
  /** View toggles: a check the view reports (`menu:state` checked) */
  kind?: "checkbox" | "radio";
}

export const COMMANDS = [
  // ── DesignerV2 ──
  { id: "app.theme-light", label: "Light", scope: "app", kind: "radio" },
  { id: "app.theme-dark", label: "Dark", scope: "app", kind: "radio" },
  { id: "app.theme-system", label: "Use System Setting", scope: "app", kind: "radio" },

  // ── File ──
  { id: "file.new", label: "New design file", accelerator: "CmdOrCtrl+N", scope: "shell" },
  { id: "file.import", label: "Import…", scope: "shell" },
  { id: "file.place-image", label: "Place image…", accelerator: "CmdOrCtrl+Shift+K", scope: "editor" },
  { id: "file.close-tab", label: "Close tab", accelerator: "CmdOrCtrl+W", scope: "shell" },
  { id: "file.close-window", label: "Close window", accelerator: "CmdOrCtrl+Shift+W", scope: "shell" },
  { id: "file.reopen-closed-tab", label: "Reopen closed tab", accelerator: "CmdOrCtrl+Shift+T", scope: "shell" },
  { id: "file.save-version", label: "Save to version history…", accelerator: "Alt+CmdOrCtrl+S", scope: "editor" },
  { id: "file.version-history", label: "Show version history", scope: "editor" },
  { id: "file.save-local-copy", label: "Save local copy…", scope: "view" },
  { id: "file.export", label: "Export…", accelerator: "CmdOrCtrl+Shift+E", scope: "editor" },
  { id: "file.export-frames-to-pdf", label: "Export frames to PDF…", scope: "editor" },
  { id: "file.share-preview", label: "Share preview…", scope: "editor" },
  { id: "file.duplicate", label: "Duplicate", scope: "view" },
  { id: "file.rename", label: "Rename", scope: "view" },
  { id: "file.move", label: "Move to folder…", scope: "view" },
  { id: "file.delete", label: "Move to trash", scope: "view" },

  // ── Edit ──
  { id: "edit.undo", label: "Undo", accelerator: "CmdOrCtrl+Z", scope: "view" },
  { id: "edit.redo", label: "Redo", accelerator: "Shift+CmdOrCtrl+Z", scope: "view" },
  { id: "edit.paste-over-selection", label: "Paste over selection", accelerator: "CmdOrCtrl+Shift+V", scope: "editor" },
  { id: "edit.paste-to-replace", label: "Paste to replace", accelerator: "CmdOrCtrl+Shift+R", scope: "editor" },
  { id: "edit.duplicate", label: "Duplicate", accelerator: "CmdOrCtrl+D", scope: "editor" },
  { id: "edit.delete", label: "Delete", accelerator: "Backspace", scope: "view" },
  { id: "edit.copy-as-text", label: "Copy as text", scope: "editor" },
  { id: "edit.copy-as-svg", label: "Copy as SVG", scope: "editor" },
  { id: "edit.copy-as-png", label: "Copy as PNG", accelerator: "CmdOrCtrl+Shift+C", scope: "editor" },
  { id: "edit.copy-properties", label: "Copy properties", accelerator: "Alt+CmdOrCtrl+C", scope: "editor" },
  { id: "edit.paste-properties", label: "Paste properties", accelerator: "Alt+CmdOrCtrl+V", scope: "editor" },
  { id: "edit.select-all", label: "Select all", accelerator: "CmdOrCtrl+A", scope: "view" },
  { id: "edit.select-inverse", label: "Select inverse", accelerator: "CmdOrCtrl+Shift+A", scope: "editor" },
  { id: "edit.select-none", label: "Select none", scope: "editor" },
  { id: "edit.select-matching", label: "Select matching layers", accelerator: "Alt+CmdOrCtrl+A", scope: "editor" },
  { id: "edit.find", label: "Find and replace…", accelerator: "CmdOrCtrl+F", scope: "editor" },

  // ── View ──
  { id: "view.pixel-grid", label: "Pixel grid", accelerator: "Shift+'", scope: "editor", kind: "checkbox" },
  { id: "view.snap-pixel-grid", label: "Snap to pixel grid", accelerator: "CmdOrCtrl+Shift+'", scope: "editor", kind: "checkbox" },
  { id: "view.layout-guides", label: "Layout guides", accelerator: "Ctrl+G", scope: "editor", kind: "checkbox" },
  { id: "view.rulers", label: "Rulers", accelerator: "Shift+R", scope: "editor", kind: "checkbox" },
  { id: "view.outlines", label: "Outlines", accelerator: "CmdOrCtrl+Y", scope: "editor", kind: "checkbox" },
  { id: "view.property-labels", label: "Property labels", scope: "editor", kind: "checkbox" },
  { id: "view.annotations", label: "Annotations", accelerator: "Shift+Y", scope: "editor", kind: "checkbox" },
  { id: "view.toggle-ui", label: "Show/Hide UI", accelerator: "CmdOrCtrl+\\", scope: "editor" },
  { id: "view.minimize-ui", label: "Minimize UI", accelerator: "Shift+\\", scope: "editor", kind: "checkbox" },
  { id: "view.layers", label: "Layers", accelerator: "Alt+1", scope: "editor" },
  { id: "view.assets", label: "Assets", accelerator: "Alt+2", scope: "editor" },
  { id: "view.local-variables", label: "Local variables", scope: "editor" },
  { id: "view.zoom-in", label: "Zoom in", accelerator: "CmdOrCtrl+=", scope: "editor" },
  { id: "view.zoom-out", label: "Zoom out", accelerator: "CmdOrCtrl+-", scope: "editor" },
  { id: "view.zoom-100", label: "Zoom to 100%", accelerator: "Shift+0", scope: "editor" },
  { id: "view.zoom-fit", label: "Zoom to fit", accelerator: "Shift+1", scope: "editor" },
  { id: "view.zoom-selection", label: "Zoom to selection", accelerator: "Shift+2", scope: "editor" },
  { id: "view.previous-page", label: "Previous page", accelerator: "PageUp", scope: "editor" },
  { id: "view.next-page", label: "Next page", accelerator: "PageDown", scope: "editor" },
  { id: "view.reload-tab", label: "Reload Tab", scope: "shell" },
  { id: "view.toggle-devtools", label: "Toggle Developer Tools", accelerator: "Alt+CmdOrCtrl+I", scope: "shell" },
  { id: "view.toggle-tabbar-devtools", label: "Toggle Tab Bar Developer Tools", scope: "shell" },

  // ── Object ──
  { id: "object.group", label: "Group selection", accelerator: "CmdOrCtrl+G", scope: "editor" },
  { id: "object.ungroup", label: "Ungroup selection", accelerator: "CmdOrCtrl+Shift+G", scope: "editor" },
  { id: "object.frame-selection", label: "Frame selection", accelerator: "Alt+CmdOrCtrl+G", scope: "editor" },
  { id: "object.add-auto-layout", label: "Add auto layout", accelerator: "Shift+A", scope: "editor" },
  { id: "object.remove-auto-layout", label: "Remove auto layout", accelerator: "Alt+Shift+A", scope: "editor" },
  { id: "object.create-component", label: "Create component", accelerator: "Alt+CmdOrCtrl+K", scope: "editor" },
  { id: "object.create-multiple-components", label: "Create multiple components", scope: "editor" },
  { id: "object.combine-as-variants", label: "Combine as variants", scope: "editor" },
  { id: "object.add-variant", label: "Add variant", scope: "editor" },
  { id: "object.detach-instance", label: "Detach instance", accelerator: "Alt+CmdOrCtrl+B", scope: "editor" },
  { id: "object.go-to-main-component", label: "Go to main component", accelerator: "Ctrl+Alt+CmdOrCtrl+K", scope: "editor" },
  { id: "object.push-changes", label: "Push changes to main component", scope: "editor" },
  { id: "object.reset-all-changes", label: "Reset all changes", scope: "editor" },
  { id: "object.restore-component", label: "Restore component", scope: "editor" },
  { id: "object.convert-to-slot", label: "Convert to slot", accelerator: "Shift+CmdOrCtrl+S", scope: "editor" },
  { id: "object.wrap-in-new-slot", label: "Wrap in new slot", scope: "editor" },
  { id: "object.use-as-mask", label: "Use as mask", accelerator: "Ctrl+CmdOrCtrl+M", scope: "editor" },
  { id: "object.bring-to-front", label: "Bring to front", accelerator: "Alt+CmdOrCtrl+]", scope: "editor" },
  { id: "object.bring-forward", label: "Bring forward", accelerator: "CmdOrCtrl+]", scope: "editor" },
  { id: "object.send-backward", label: "Send backward", accelerator: "CmdOrCtrl+[", scope: "editor" },
  { id: "object.send-to-back", label: "Send to back", accelerator: "Alt+CmdOrCtrl+[", scope: "editor" },
  { id: "object.flip-horizontal", label: "Flip horizontal", accelerator: "Shift+H", scope: "editor" },
  { id: "object.flip-vertical", label: "Flip vertical", accelerator: "Shift+V", scope: "editor" },
  { id: "object.rotate-180", label: "Rotate 180°", scope: "editor" },
  { id: "object.rotate-90-left", label: "Rotate 90° left", scope: "editor" },
  { id: "object.rotate-90-right", label: "Rotate 90° right", scope: "editor" },
  { id: "object.toggle-visible", label: "Show/Hide selection", accelerator: "CmdOrCtrl+Shift+H", scope: "editor" },
  { id: "object.toggle-lock", label: "Lock/Unlock selection", accelerator: "CmdOrCtrl+Shift+L", scope: "editor" },
  { id: "object.rename", label: "Rename", accelerator: "CmdOrCtrl+R", scope: "editor" },

  // ── Text ──
  { id: "text.bold", label: "Bold", accelerator: "CmdOrCtrl+B", scope: "editor" },
  { id: "text.italic", label: "Italic", accelerator: "CmdOrCtrl+I", scope: "editor" },
  { id: "text.underline", label: "Underline", accelerator: "CmdOrCtrl+U", scope: "editor" },
  { id: "text.strikethrough", label: "Strikethrough", accelerator: "CmdOrCtrl+Shift+X", scope: "editor" },
  { id: "text.align-left", label: "Text align left", accelerator: "Alt+CmdOrCtrl+L", scope: "editor" },
  { id: "text.align-center", label: "Text align center", accelerator: "Alt+CmdOrCtrl+T", scope: "editor" },
  { id: "text.align-right", label: "Text align right", accelerator: "Alt+CmdOrCtrl+R", scope: "editor" },

  // ── Arrange ──
  { id: "arrange.align-left", label: "Align left", accelerator: "Alt+A", scope: "editor" },
  { id: "arrange.align-horizontal-center", label: "Align horizontal centers", accelerator: "Alt+H", scope: "editor" },
  { id: "arrange.align-right", label: "Align right", accelerator: "Alt+D", scope: "editor" },
  { id: "arrange.align-top", label: "Align top", accelerator: "Alt+W", scope: "editor" },
  { id: "arrange.align-vertical-center", label: "Align vertical centers", accelerator: "Alt+V", scope: "editor" },
  { id: "arrange.align-bottom", label: "Align bottom", accelerator: "Alt+S", scope: "editor" },
  { id: "arrange.distribute-horizontal", label: "Distribute horizontal spacing", accelerator: "Ctrl+Alt+H", scope: "editor" },
  { id: "arrange.distribute-vertical", label: "Distribute vertical spacing", accelerator: "Ctrl+Alt+V", scope: "editor" },
  { id: "arrange.tidy-up", label: "Tidy up", accelerator: "Ctrl+Alt+T", scope: "editor" },

  // ── Vector ──
  { id: "vector.flatten", label: "Flatten", accelerator: "CmdOrCtrl+E", scope: "editor" },
  { id: "vector.outline-stroke", label: "Outline stroke", accelerator: "Alt+CmdOrCtrl+O", scope: "editor" },
  { id: "vector.union", label: "Union selection", accelerator: "Alt+Shift+U", scope: "editor" },
  { id: "vector.subtract", label: "Subtract selection", accelerator: "Alt+Shift+S", scope: "editor" },
  { id: "vector.intersect", label: "Intersect selection", accelerator: "Alt+Shift+I", scope: "editor" },
  { id: "vector.exclude", label: "Exclude selection", accelerator: "Alt+Shift+E", scope: "editor" },

  // ── Window ──
  { id: "window.next-tab", label: "Show Next Tab", accelerator: "Ctrl+Tab", scope: "shell" },
  { id: "window.previous-tab", label: "Show Previous Tab", accelerator: "Ctrl+Shift+Tab", scope: "shell" },
  { id: "window.tab-1", label: "Home", accelerator: "CmdOrCtrl+1", scope: "shell" },
  { id: "window.tab-2", label: "Tab 2", accelerator: "CmdOrCtrl+2", scope: "shell" },
  { id: "window.tab-3", label: "Tab 3", accelerator: "CmdOrCtrl+3", scope: "shell" },
  { id: "window.tab-4", label: "Tab 4", accelerator: "CmdOrCtrl+4", scope: "shell" },
  { id: "window.tab-5", label: "Tab 5", accelerator: "CmdOrCtrl+5", scope: "shell" },
  { id: "window.tab-6", label: "Tab 6", accelerator: "CmdOrCtrl+6", scope: "shell" },
  { id: "window.tab-7", label: "Tab 7", accelerator: "CmdOrCtrl+7", scope: "shell" },
  { id: "window.tab-8", label: "Tab 8", accelerator: "CmdOrCtrl+8", scope: "shell" },
  { id: "window.tab-9", label: "Last Tab", accelerator: "CmdOrCtrl+9", scope: "shell" },

  // ── Help ──
  { id: "help.shortcuts", label: "Keyboard shortcuts", accelerator: "Ctrl+Shift+/", scope: "editor" },
  { id: "help.open-data-folder", label: "Open data folder", scope: "app" },
] as const satisfies readonly CommandSpec[];

export type CommandId = (typeof COMMANDS)[number]["id"];

const BY_ID = new Map<string, CommandSpec>(COMMANDS.map((c) => [c.id, c]));

export const command = (id: CommandId): CommandSpec => BY_ID.get(id)!;

export const isCommandId = (id: unknown): id is CommandId => typeof id === "string" && BY_ID.has(id);

/** An accelerator the menu may register: with ⌘ or ⌃ (anything else is the page's own key, only shown). */
export const registersAccelerator = (accelerator: string | undefined) => !!accelerator && /(^|\+)(CmdOrCtrl|CommandOrControl|Cmd|Command|Ctrl|Control)\+/.test(accelerator);

/** The Edit commands a view runs on a focused text field natively (document.execCommand). */
export const TEXT_FIELD_COMMANDS: Partial<Record<CommandId, string>> = {
  "edit.undo": "undo",
  "edit.redo": "redo",
  "edit.select-all": "selectAll",
  "edit.delete": "delete",
};

// ── The menu bar's layout ────────────────────────────────────────────────────

export type TopMenu = "File" | "Edit" | "View" | "Object" | "Text" | "Arrange" | "Vector" | "Window" | "Help";

/** Electron's own items (they act in the focused view: the DOM clipboard events fire there) */
export type MenuRole = "copy" | "cut" | "paste" | "togglefullscreen" | "minimize" | "zoom" | "front";

export type MenuEntry = CommandId | "-" | { role: MenuRole } | { submenu: string; items: MenuEntry[] };

/**
 * Figma's menu bar (docs/desktop.md §8.2) without Plugins and Widgets. The
 * app menu (About, Theme, Services, Hide, Quit) is main's (src/main/menu.ts).
 */
export const MENU_LAYOUT: Record<TopMenu, MenuEntry[]> = {
  File: [
    "file.new",
    "file.import",
    "-",
    "file.place-image",
    "-",
    "file.close-tab",
    "file.close-window",
    "file.reopen-closed-tab",
    "-",
    "file.save-version",
    "file.version-history",
    "-",
    "file.save-local-copy",
    "file.export",
    "file.export-frames-to-pdf",
    "-",
    "file.share-preview",
    "-",
    "file.duplicate",
    "file.rename",
    "file.move",
    "file.delete",
  ],
  Edit: [
    "edit.undo",
    "edit.redo",
    "-",
    { role: "copy" },
    { role: "cut" },
    { role: "paste" },
    "edit.paste-over-selection",
    "edit.paste-to-replace",
    "edit.duplicate",
    "edit.delete",
    "-",
    { submenu: "Copy as", items: ["edit.copy-as-text", "edit.copy-as-svg", "edit.copy-as-png"] },
    "edit.copy-properties",
    "edit.paste-properties",
    "-",
    "edit.select-all",
    "edit.select-inverse",
    "edit.select-none",
    "edit.select-matching",
    "-",
    "edit.find",
  ],
  View: [
    "view.pixel-grid",
    "view.snap-pixel-grid",
    "view.layout-guides",
    "view.rulers",
    "view.outlines",
    "view.property-labels",
    "view.annotations",
    "-",
    "view.toggle-ui",
    "view.minimize-ui",
    "-",
    "view.layers",
    "view.assets",
    "view.local-variables",
    "-",
    "view.zoom-in",
    "view.zoom-out",
    "view.zoom-100",
    "view.zoom-fit",
    "view.zoom-selection",
    "-",
    "view.previous-page",
    "view.next-page",
    "-",
    { role: "togglefullscreen" },
    { submenu: "Developer", items: ["view.toggle-devtools", "view.toggle-tabbar-devtools", "view.reload-tab"] },
  ],
  Object: [
    "object.group",
    "object.ungroup",
    "object.frame-selection",
    "-",
    "object.add-auto-layout",
    "object.remove-auto-layout",
    "-",
    "object.create-component",
    "object.create-multiple-components",
    "object.combine-as-variants",
    "object.add-variant",
    "object.detach-instance",
    "object.go-to-main-component",
    "object.push-changes",
    "object.reset-all-changes",
    "object.restore-component",
    "object.convert-to-slot",
    "object.wrap-in-new-slot",
    "object.use-as-mask",
    "-",
    "object.bring-to-front",
    "object.bring-forward",
    "object.send-backward",
    "object.send-to-back",
    "-",
    "object.flip-horizontal",
    "object.flip-vertical",
    "object.rotate-180",
    "object.rotate-90-left",
    "object.rotate-90-right",
    "-",
    "object.toggle-visible",
    "object.toggle-lock",
    "object.rename",
  ],
  Text: ["text.bold", "text.italic", "text.underline", "text.strikethrough", "-", "text.align-left", "text.align-center", "text.align-right"],
  Arrange: [
    "arrange.align-left",
    "arrange.align-horizontal-center",
    "arrange.align-right",
    "-",
    "arrange.align-top",
    "arrange.align-vertical-center",
    "arrange.align-bottom",
    "-",
    "arrange.distribute-horizontal",
    "arrange.distribute-vertical",
    "arrange.tidy-up",
  ],
  Vector: ["vector.flatten", "vector.outline-stroke", "-", { submenu: "Boolean groups", items: ["vector.union", "vector.subtract", "vector.intersect", "vector.exclude"] }],
  Window: [
    { role: "minimize" },
    { role: "zoom" },
    "-",
    "window.next-tab",
    "window.previous-tab",
    "-",
    "window.tab-1",
    "window.tab-2",
    "window.tab-3",
    "window.tab-4",
    "window.tab-5",
    "window.tab-6",
    "window.tab-7",
    "window.tab-8",
    "window.tab-9",
    "-",
    { role: "front" },
  ],
  Help: ["help.shortcuts", "-", "help.open-data-folder"],
};

/** Every command a layout places (each once: an Electron menu item id is unique). */
export function layoutCommands(entries: MenuEntry[] = Object.values(MENU_LAYOUT).flat()): CommandId[] {
  return entries.flatMap((e) => (typeof e === "string" ? (e === "-" ? [] : [e]) : "submenu" in e ? layoutCommands(e.items) : []));
}

/** What a view says about the menu (docs/desktop.md §8.4): only the keys that changed. */
export interface MenuStatePatch {
  enabled?: Partial<Record<CommandId, boolean>>;
  checked?: Partial<Record<CommandId, boolean>>;
}
