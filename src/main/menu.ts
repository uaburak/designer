import { app, Menu, nativeTheme, webContents, type KeyboardEvent, type MenuItemConstructorOptions } from "electron";
import { command, layoutCommands, MENU_LAYOUT, RECENTLY_CLOSED, registersAccelerator, runsFromMenuBar, type CommandId, type MenuEntry } from "../shared/commands";
import { acceleratorFor, type KeyCombo } from "../shared/shortcuts";
import { getLocale, t, tx } from "../shared/i18n";
import { readSettings } from "./session";
import { interfaceScale } from "./interfaceScale";
import { graphicsBackend, hardwareAccelerationDisabled } from "./troubleshooting";
import { checkForUpdates, onUpdaterChange, restartToUpdate, updaterStatus } from "./updater";
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
      label: t(spec.label),
      accelerator,
      // Keys without ⌘ or ⌃ are the page's own (a registered ⇧R would eat the R typed into a field): shown only.
      registerAccelerator: registersAccelerator(accelerator),
      type: spec.kind === "checkbox" ? "checkbox" : spec.kind === "radio" ? "radio" : "normal",
      // Hidden items keep their keys (macOS; Windows and Linux register them as any other).
      ...(spec.hidden ? { visible: false, acceleratorWorksWhenHidden: true } : {}),
      // Disabled until the view in front says otherwise (TabManager.applyMenu runs once the window is up).
      enabled: signedOut ? enabledSignedOut(id) : spec.scope === "app" || spec.scope === "shell",
      // Help › Troubleshooting's checks are main's (troubleshooting.ts).
      ...appChecked(id),
      ...extra,
      click: (_item, _win, event: KeyboardEvent) => {
        // A plain key (N, [, ⇧V…) a page left unhandled is typing in a text field, never this command (runsFromMenuBar).
        if (!runsFromMenuBar(extra.accelerator ?? accelerator, !!event.triggeredByAccelerator)) return;
        // Signed out (docs/desktop.md §18.6): nothing but the app's own items, whatever the item's state says.
        if (signedOut && !enabledSignedOut(id)) return;
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
      if ("role" in e) return roleItem(e.role);
      // View › Interface Scale: the scale now as a line of its own above its items (Figma desktop's "{n}%").
      if (e.submenu === "Interface Scale") return { label: t(e.submenu), submenu: [{ id: "app.interface-scale-current", label: `${interfaceScale()}%`, enabled: false }, ...entries(e.items)] };
      // File › Recently closed tabs: the window in front's (rebuilt when they change, syncClosedMenu).
      if (e.submenu === RECENTLY_CLOSED) {
        const ctl = signedOut ? null : current();
        closedKey = ctl?.tabs.recentlyClosedKey() ?? "";
        const recent = ctl?.tabs.recentlyClosedItems() ?? [];
        return { label: t(e.submenu), enabled: recent.length > 0, submenu: recent.length ? recent : [{ label: t(e.submenu), enabled: false }] };
      }
      return { label: t(e.submenu), submenu: entries(e.items) };
    });

  const theme = (["app.theme-light", "app.theme-dark", "app.theme-system"] as const).map((id) => item(id, { checked: nativeTheme.themeSource === id.slice("app.theme-".length) }));

  // "Check for Updates…" (docs/desktop.md §12.6): Figma's — in the app menu on a Mac, under Help in the Windows main
  // menu; "Restart to Update" once an update is in. Left out when the updater is off (development, DisableUpdater, MSI).
  const updates = updaterStatus();
  const update: MenuItemConstructorOptions[] = updates.enabled
    ? [updates.state.kind === "ready" ? { id: "app.restart-to-update", label: t("Restart to Update"), click: () => restartToUpdate() } : { id: "app.check-for-updates", label: t("Check for Updates…"), click: () => checkForUpdates() }]
    : [];

  const appSubmenu: MenuItemConstructorOptions[] = [
    roleItem("about"),
    ...update,
    { type: "separator" },
    { label: t("Theme"), submenu: theme },
    { type: "separator" },
    roleItem("services"),
    { type: "separator" },
    roleItem("hide"),
    roleItem("hideOthers"),
    roleItem("unhide"),
    { type: "separator" },
    roleItem("quit"),
  ];

  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ label: app.name, submenu: appSubmenu }] : []),
    ...Object.entries(MENU_LAYOUT).map(([label, list]): MenuItemConstructorOptions => {
      const submenu = entries(list);
      if (label === "File" && !mac) submenu.push({ type: "separator" }, { label: t("Theme"), submenu: theme }, { type: "separator" }, roleItem("quit"));
      if (label === "Help" && !mac && update.length) submenu.push({ type: "separator" }, ...update);
      return label === "Help" ? { role: "help", label: t("Help"), submenu } : { label: t(label), submenu };
    }),
  ];
  return Menu.buildFromTemplate(template);
}

/** Help › Troubleshooting's check and radio set, as main keeps them (troubleshooting.ts). */
function appChecked(id: CommandId): Partial<MenuItemConstructorOptions> {
  if (id === "app.disable-hardware-acceleration") return { checked: hardwareAccelerationDisabled() };
  if (id.startsWith("app.graphics-backend-")) return { checked: graphicsBackend() === id.slice("app.graphics-backend-".length) };
  return {};
}

/** A role's item: Electron's own English label, or the language's (src/shared/i18n) when the UI isn't in English. */
const ROLE_LABELS: Partial<Record<NonNullable<MenuItemConstructorOptions["role"]>, string>> = {
  about: "About {app}",
  services: "Services",
  hide: "Hide {app}",
  hideOthers: "Hide Others",
  unhide: "Show All",
  quit: "Quit {app}",
  copy: "Copy",
  cut: "Cut",
  paste: "Paste",
  togglefullscreen: "Toggle Full Screen",
  minimize: "Minimize",
  zoom: "Zoom",
  front: "Bring All to Front",
};

function roleItem(role: NonNullable<MenuItemConstructorOptions["role"]>): MenuItemConstructorOptions {
  const label = ROLE_LABELS[role];
  return getLocale() === "en" || !label ? { role } : { role, label: tx("role", label, { app: app.name }) };
}

let built: { current: () => WindowController | null; dev: boolean } | null = null;
/** What File › Recently closed tabs was built with (the window in front's last 8) */
let closedKey = "";

/** The window in front changed, or its closed tabs did: the menu bar again when File › Recently closed tabs would differ. */
export function syncClosedMenu(): void {
  if (!built || (built.current()?.tabs.recentlyClosedKey() ?? "") === closedKey) return;
  refreshAppMenu();
}

/** The menu bar set at launch, with the user's shortcuts. */
export function installAppMenu(current: () => WindowController | null, dev: boolean): void {
  built = { current, dev };
  Menu.setApplicationMenu(appMenu(current, dev, readSettings().shortcuts?.bindings));
  // The update item's label follows the updater: rebuilt when it turns on, off or ready, not on every percent.
  let shown = updateItemKey();
  onUpdaterChange(() => {
    if (updateItemKey() === shown) return;
    shown = updateItemKey();
    refreshAppMenu();
  });
}

const updateItemKey = () => {
  const s = updaterStatus();
  return !s.enabled ? "off" : s.state.kind === "ready" ? "ready" : "check";
};

/** The user changed a shortcut: the menu bar again with its accelerators, then the window in front's enabled / checked items. */
export function refreshAppMenu(): void {
  if (!built) return;
  Menu.setApplicationMenu(appMenu(built.current, built.dev, readSettings().shortcuts?.bindings));
  if (signedOut) setMenuSignedOut(true);
  else built.current()?.tabs.applyMenu();
}

// ---- signed out (docs/desktop.md §18.6) ------------------------------------------------------------------------------

let signedOut = false;

/** Signed out, only the app's own items stay on (Theme, Open data folder): New design file, Import…, Save local copy,
 *  the tabs' and the editor's commands are all off — the menu bar can't reach a file. */
export const enabledSignedOut = (id: CommandId): boolean => command(id).scope === "app";

/** The gate's switch (src/main/gate.ts): off → every item as signedOut says; on → the app window's own state again. */
export function setMenuSignedOut(on: boolean): void {
  signedOut = on;
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  if (!on) return void built?.current()?.tabs.applyMenu();
  for (const id of layoutCommands()) {
    const item = menu.getMenuItemById(id);
    if (item && item.enabled !== enabledSignedOut(id)) item.enabled = enabledSignedOut(id);
  }
}

export const menuSignedOut = (): boolean => signedOut;
