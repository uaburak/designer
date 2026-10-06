import { app, Menu, nativeTheme, shell, webContents, type KeyboardEvent, type MenuItemConstructorOptions } from "electron";
import { command, type CommandId } from "../shared/commands";
import type { WindowController } from "./window";

/**
 * The menu bar (docs/desktop.md §8), its items from src/shared/commands.ts.
 * On a Mac every key goes to the focused page first: the menu gets only
 * what the page leaves unhandled (the editor's ⌘S, ⌘Z… are the editor's).
 * A click, or such a key, runs the command against the window in front:
 * main does the shell's (tabs, theme), an editor gets the others as
 * `menu:command` — Undo, Redo, Select All and Delete included, so they go
 * through the editor's own model rather than the DOM's. Copy, Cut and Paste
 * stay roles: the page's DOM clipboard events fire in the focused view.
 */
export function appMenu(current: () => WindowController | null, dev: boolean): Menu {
  const mac = process.platform === "darwin";
  const item = (id: CommandId, extra: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions => {
    const spec = command(id);
    return {
      id,
      label: spec.label,
      accelerator: spec.accelerator,
      ...extra,
      click: (_item, _win, event: KeyboardEvent) => current()?.tabs.command(id, event.triggeredByAccelerator ? "accelerator" : "menu", webContents.getFocusedWebContents()),
    };
  };

  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              {
                label: "Theme",
                submenu: (["app.theme-light", "app.theme-dark", "app.theme-system"] as const).map((id) => item(id, { type: "radio", checked: nativeTheme.themeSource === id.slice("app.theme-".length) })),
              },
              { type: "separator" },
              item("app.sign-out"),
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        item("file.new"),
        { type: "separator" },
        item("file.save"),
        { type: "separator" },
        item("file.close-tab"),
        item("file.close-window"),
        item("file.reopen-closed-tab"),
        ...(mac ? [] : [{ type: "separator" } as const, { role: "quit" } as const]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        item("edit.undo"),
        item("edit.redo"),
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        item("edit.delete"),
        item("edit.select-all"),
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "togglefullscreen" },
        { type: "separator" },
        {
          label: "Developer",
          submenu: [item("view.toggle-devtools"), item("view.toggle-tabbar-devtools"), item("view.reload-tab", dev ? { accelerator: "CmdOrCtrl+Shift+R" } : {})],
        },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        item("window.next-tab"),
        item("window.previous-tab"),
        { type: "separator" },
        ...Array.from({ length: 9 }, (_, i) => item(`window.tab-${i + 1}` as CommandId)),
        ...(mac ? [{ type: "separator" } as const, { role: "front" } as const] : []),
      ],
    },
    {
      role: "help",
      submenu: [{ label: "Open burakkoc.net", click: () => void shell.openExternal("https://burakkoc.net") }],
    },
  ];
  return Menu.buildFromTemplate(template);
}
