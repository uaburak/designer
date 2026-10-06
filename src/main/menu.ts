import { app, Menu, nativeTheme, webContents, type KeyboardEvent, type MenuItemConstructorOptions } from "electron";
import { command, MENU_LAYOUT, registersAccelerator, type CommandId, type MenuEntry } from "../shared/commands";
import type { WindowController } from "./window";

/**
 * The menu bar (docs/desktop.md §8): Figma's — File, Edit, View, Object,
 * Text, Arrange, Vector, Window, Help — built from the one registry
 * (src/shared/commands.ts, `MENU_LAYOUT`), after the app menu.
 *
 * On a Mac every key goes to the focused page first: the menu gets only
 * what the page leaves unhandled (the editor's ⌘G, ⌘Z… are the editor's).
 * A click, or such a key, runs `TabManager.command`: main does the app's
 * and the shell's; the view in front gets the rest as `menu:command`.
 * Copy, Cut and Paste stay roles: the DOM clipboard events fire in the
 * focused view. Which items are enabled and checked follows the view in
 * front (`menu:state`, TabManager.applyMenu); the menu is never rebuilt.
 */
export function appMenu(current: () => WindowController | null, dev: boolean): Menu {
  const mac = process.platform === "darwin";

  const item = (id: CommandId, extra: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions => {
    const spec = command(id);
    return {
      id,
      label: spec.label,
      accelerator: spec.accelerator,
      // Keys without ⌘ or ⌃ are the page's own (a registered ⇧R would eat the R typed into a field): shown only.
      registerAccelerator: registersAccelerator(spec.accelerator),
      type: spec.kind === "checkbox" ? "checkbox" : spec.kind === "radio" ? "radio" : "normal",
      // Disabled until the view in front says otherwise (TabManager.applyMenu runs once the window is up).
      enabled: spec.scope === "app" || spec.scope === "shell",
      ...extra,
      click: (_item, _win, event: KeyboardEvent) => {
        const ctl = current();
        ctl?.tabs.command(id, event.triggeredByAccelerator ? "accelerator" : "menu", webContents.getFocusedWebContents());
        // A checkbox flips itself on click: the view's report decides.
        if (spec.kind === "checkbox") ctl?.tabs.applyMenu();
      },
    };
  };

  const entries = (list: MenuEntry[]): MenuItemConstructorOptions[] =>
    list.map((e): MenuItemConstructorOptions => {
      if (e === "-") return { type: "separator" };
      if (typeof e === "string") return e === "view.reload-tab" && dev ? item(e, { accelerator: "CmdOrCtrl+Shift+R", registerAccelerator: true }) : item(e);
      if ("role" in e) return { role: e.role };
      return { label: e.submenu, submenu: entries(e.items) };
    });

  const theme = (["app.theme-light", "app.theme-dark", "app.theme-system"] as const).map((id) => item(id, { checked: nativeTheme.themeSource === id.slice("app.theme-".length) }));

  const appSubmenu: MenuItemConstructorOptions[] = [
    { role: "about" },
    { type: "separator" },
    { label: "Theme", submenu: theme },
    { type: "separator" },
    { role: "services" },
    { type: "separator" },
    { role: "hide" },
    { role: "hideOthers" },
    { role: "unhide" },
    { type: "separator" },
    { role: "quit" },
  ];

  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ label: app.name, submenu: appSubmenu }] : []),
    ...Object.entries(MENU_LAYOUT).map(([label, list]): MenuItemConstructorOptions => {
      const submenu = entries(list);
      if (label === "File" && !mac) submenu.push({ type: "separator" }, { label: "Theme", submenu: theme }, { type: "separator" }, { role: "quit" });
      return label === "Help" ? { role: "help", submenu } : { label, submenu };
    }),
  ];
  return Menu.buildFromTemplate(template);
}
