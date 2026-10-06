import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import type { MenuCommand } from "../shared/api";

/**
 * The app's menu. Its own items go to the page as commands (menu:command):
 * the shell does them, or hands them to the open tab. A key the page uses
 * itself (the editor's ⌘S, ⌘Z…) reaches the page first — the menu only gets
 * what the page lets through. The Edit menu's roles are what make copy and
 * paste work in text fields on a Mac.
 */
export function appMenu(win: () => BrowserWindow | null, dev: boolean): Menu {
  const send = (command: MenuCommand) => () => win()?.webContents.send("menu:command", command);
  const mac = process.platform === "darwin";
  // ⌘1 is Home, ⌘2 … ⌘8 the tabs after it, ⌘9 the last one — as a browser's.
  const tabs: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: i === 0 ? "Home" : i === 8 ? "Last Tab" : `Tab ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: send(i === 0 ? "home" : i === 8 ? "tab--1" : `tab-${i + 1}`),
  }));

  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { label: "Toggle Dark Theme", click: send("toggle-theme") },
              { type: "separator" },
              { label: "Sign Out", click: send("sign-out") },
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
        { label: "New Project…", accelerator: "CmdOrCtrl+N", click: send("new-project") },
        { type: "separator" },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: send("save") },
        { type: "separator" },
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: send("close-tab") },
        { label: "Reopen Closed Tab", accelerator: "CmdOrCtrl+Shift+T", click: send("reopen-tab") },
        ...(mac ? [] : [{ type: "separator" } as const, { role: "quit" } as const]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        ...(dev ? [{ role: "reload" } as const, { role: "forceReload" } as const] : []),
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { label: "Show Next Tab", accelerator: "Ctrl+Tab", click: send("next-tab") },
        { label: "Show Previous Tab", accelerator: "Ctrl+Shift+Tab", click: send("previous-tab") },
        { type: "separator" },
        ...tabs,
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
