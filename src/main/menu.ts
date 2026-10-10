import { app, Menu, nativeTheme, webContents, type KeyboardEvent, type MenuItemConstructorOptions } from "electron";
import { command, MENU_LAYOUT, registersAccelerator, runsFromMenuBar, type CommandId, type MenuEntry } from "../shared/commands";
import { acceleratorFor, type KeyCombo } from "../shared/shortcuts";
import { readSettings } from "./session";
import type { WindowController } from "./window";

/**
 * The menu bar (docs/desktop.md §8): Figma's — File, Edit, View, Object,
 * Text, Arrange, Vector, Window, Help — built from the one registry
 * (src/shared/commands.ts, `MENU_LAYOUT`), after the app menu.
 *
 * On a Mac every key goes to the focused page first: the menu gets only
 * what the page leaves unhandled (the editor's ⌘G, ⌘Z… are the editor's),
 * and runs only its ⌘ / ⌃ keys: a plain key it gets (N, [, ⇧V…) was typed
 * into a text field (shared/commands.ts runsFromMenuBar).
 * A click, or such a key, runs `TabManager.command`: main does the app's
 * and the shell's; the view in front gets the rest as `menu:command`.
 * Copy, Cut and Paste stay roles: the DOM clipboard events fire in the
 * focused view. Which items are enabled and checked follows the view in
 * front (`menu:state`, TabManager.applyMenu). The menu is rebuilt only when
 * the user changes a shortcut (the Keyboard shortcuts panel's `bindings`, in
 * settings.json — src/shared/shortcuts.ts): its accelerators are theirs.
 */
export function appMenu(current: () => WindowController | null, dev: boolean, bindings: Record<string, KeyCombo[]> = {}): Menu {
  const mac = process.platform === "darwin";

  const item = (id: CommandId, extra: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions => {
    const spec = command(id);
    const accelerator = acceleratorFor(id, spec.accelerator, bindings);
    return {
      id,
      label: spec.label,
      accelerator,
      // Keys without ⌘ or ⌃ are the page's own (a registered ⇧R would eat the R typed into a field): shown only.
      registerAccelerator: registersAccelerator(accelerator),
      type: spec.kind === "checkbox" ? "checkbox" : spec.kind === "radio" ? "radio" : "normal",
      // Disabled until the view in front says otherwise (TabManager.applyMenu runs once the window is up).
      enabled: spec.scope === "app" || spec.scope === "shell",
      ...extra,
      click: (_item, _win, event: KeyboardEvent) => {
        // A plain key (N, [, ⇧V…) a page left unhandled is typing in a text field, never this command (runsFromMenuBar).
        if (!runsFromMenuBar(extra.accelerator ?? accelerator, !!event.triggeredByAccelerator)) return;
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

let built: { current: () => WindowController | null; dev: boolean } | null = null;

/** The menu bar set at launch, with the user's shortcuts. */
export function installAppMenu(current: () => WindowController | null, dev: boolean): void {
  built = { current, dev };
  Menu.setApplicationMenu(appMenu(current, dev, readSettings().shortcuts?.bindings));
}

/** The user changed a shortcut: the menu bar again with its accelerators, then the window in front's enabled / checked items. */
export function refreshAppMenu(): void {
  if (!built) return;
  Menu.setApplicationMenu(appMenu(built.current, built.dev, readSettings().shortcuts?.bindings));
  built.current()?.tabs.applyMenu();
}
