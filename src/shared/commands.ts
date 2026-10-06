/**
 * The menu bar's commands (docs/desktop.md §8): one registry that the menu
 * (src/main/menu.ts) is built from and the views' `menu:command` handlers
 * read. Ids are `<area>.<verb>` and never change once shipped. This is the
 * shell's own set; the editor's commands (Object, Text, Arrange…) are added
 * here by the editor's work.
 *
 * Scopes:
 * - `shell`: main does it (tabs, theme, sign-out, dev tools)
 * - `view`: whichever view has the focus (Home's text fields, an editor) —
 *   main runs it natively in Home, an editor gets it as `menu:command`
 * - `editor`: the active file tab gets it as `menu:command`
 */
export type CommandScope = "shell" | "view" | "editor";

export interface CommandSpec {
  id: string;
  label: string;
  accelerator?: string;
  scope: CommandScope;
}

export const COMMANDS = [
  { id: "app.theme-light", label: "Light", scope: "shell" },
  { id: "app.theme-dark", label: "Dark", scope: "shell" },
  { id: "app.theme-system", label: "Use System Setting", scope: "shell" },
  { id: "app.sign-out", label: "Sign Out", scope: "shell" },
  { id: "file.new", label: "New Project…", accelerator: "CmdOrCtrl+N", scope: "shell" },
  { id: "file.save", label: "Save", accelerator: "CmdOrCtrl+S", scope: "editor" },
  { id: "file.close-tab", label: "Close Tab", accelerator: "CmdOrCtrl+W", scope: "shell" },
  { id: "file.reopen-closed-tab", label: "Reopen Closed Tab", accelerator: "CmdOrCtrl+Shift+T", scope: "shell" },
  { id: "file.close-window", label: "Close Window", accelerator: "CmdOrCtrl+Shift+W", scope: "shell" },
  { id: "edit.undo", label: "Undo", accelerator: "CmdOrCtrl+Z", scope: "view" },
  { id: "edit.redo", label: "Redo", accelerator: "Shift+CmdOrCtrl+Z", scope: "view" },
  { id: "edit.delete", label: "Delete", scope: "view" },
  { id: "edit.select-all", label: "Select All", accelerator: "CmdOrCtrl+A", scope: "view" },
  { id: "view.reload-tab", label: "Reload Tab", scope: "shell" },
  { id: "view.toggle-devtools", label: "Toggle Developer Tools", accelerator: "Alt+CmdOrCtrl+I", scope: "shell" },
  { id: "view.toggle-tabbar-devtools", label: "Toggle Tab Bar Developer Tools", scope: "shell" },
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
] as const satisfies readonly CommandSpec[];

export type CommandId = (typeof COMMANDS)[number]["id"];

export const command = (id: CommandId): CommandSpec => COMMANDS.find((c) => c.id === id)!;

export const isCommandId = (id: unknown): id is CommandId => typeof id === "string" && COMMANDS.some((c) => c.id === id);

/** The Edit commands a view runs on a focused text field natively (document.execCommand). */
export const TEXT_FIELD_COMMANDS: Partial<Record<CommandId, string>> = {
  "edit.undo": "undo",
  "edit.redo": "redo",
  "edit.select-all": "selectAll",
  "edit.delete": "delete",
};
