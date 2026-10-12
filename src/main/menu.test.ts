import { afterEach, describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import type { UpdaterStatus } from "../shared/ipc";

const appMenuNow = vi.hoisted(() => ({ menu: null as null | { getMenuItemById(id: string): { enabled: boolean } | null } }));
vi.mock("electron", () => ({
  app: { name: "Designer" },
  Menu: { buildFromTemplate: (t: MenuItemConstructorOptions[]) => t, setApplicationMenu: () => {}, getApplicationMenu: () => appMenuNow.menu },
  nativeTheme: { themeSource: "system" },
  webContents: { getFocusedWebContents: () => null },
}));
vi.mock("./session", () => ({ readSettings: () => ({}) }));
const updater = vi.hoisted(() => ({ status: null as UpdaterStatus | null, checks: 0, restarts: 0 }));
vi.mock("./updater", () => ({
  updaterStatus: () => updater.status,
  onUpdaterChange: () => () => {},
  checkForUpdates: () => updater.checks++,
  restartToUpdate: () => updater.restarts++,
}));
const { appMenu, enabledSignedOut, menuSignedOut, setMenuSignedOut } = await import("./menu");

const platform = process.platform;
afterEach(() => Object.defineProperty(process, "platform", { value: platform }));

function menu(os: NodeJS.Platform, status: Partial<UpdaterStatus> | null) {
  Object.defineProperty(process, "platform", { value: os });
  updater.status = { enabled: true, state: { kind: "idle" }, manual: false, current: "0.1.0", ...status };
  return appMenu(() => null, false) as unknown as MenuItemConstructorOptions[];
}
const sub = (item: MenuItemConstructorOptions | undefined) => (item?.submenu ?? []) as MenuItemConstructorOptions[];
const labels = (items: MenuItemConstructorOptions[]) => items.map((i) => i.label ?? i.role ?? i.type);

describe("Check for Updates… (docs/desktop.md §12.6)", () => {
  it("macOS: in the app menu, under About", () => {
    const app = sub(menu("darwin", {})[0]);
    expect(labels(app).slice(0, 3)).toEqual(["about", "Check for Updates…", "separator"]);
    app[1].click?.(undefined as never, undefined, undefined as never);
    expect(updater.checks).toBe(1);
  });

  it("an update in: “Restart to Update”", () => {
    const app = sub(menu("darwin", { state: { kind: "ready", version: "0.2.0" } })[0]);
    expect(app[1].label).toBe("Restart to Update");
    app[1].click?.(undefined as never, undefined, undefined as never);
    expect(updater.restarts).toBe(1);
  });

  it("Windows: at the end of Help in the main menu", () => {
    const help = menu("win32", {}).find((m) => m.role === "help");
    expect(labels(sub(help)).slice(-2)).toEqual(["separator", "Check for Updates…"]);
  });

  it("hidden when the updater is off", () => {
    const mac = sub(menu("darwin", { enabled: false })[0]);
    expect(labels(mac)).not.toContain("Check for Updates…");
    const help = menu("win32", { enabled: false }).find((m) => m.role === "help");
    expect(labels(sub(help))).not.toContain("Check for Updates…");
  });
});

describe("signed out (docs/desktop.md §18.6)", () => {
  afterEach(() => {
    setMenuSignedOut(false);
    appMenuNow.menu = null;
  });
  const fileMenu = (items: MenuItemConstructorOptions[]) => sub(items.find((m) => m.label === "File"));
  const byId = (items: MenuItemConstructorOptions[], id: string) => items.find((i) => i.id === id);

  it("only the app's own items stay on: New design file, Import…, Save local copy and the tabs' commands are off", () => {
    expect(enabledSignedOut("file.new")).toBe(false);
    expect(enabledSignedOut("file.import")).toBe(false);
    expect(enabledSignedOut("file.save-local-copy")).toBe(false);
    expect(enabledSignedOut("file.reopen-closed-tab")).toBe(false);
    expect(enabledSignedOut("window.tab-1")).toBe(false);
    expect(enabledSignedOut("app.theme-dark")).toBe(true);
    // A menu built while signed out starts that way …
    setMenuSignedOut(true);
    expect(menuSignedOut()).toBe(true);
    const file = fileMenu(menu("darwin", { enabled: false }));
    for (const id of ["file.new", "file.import", "file.save-local-copy", "file.close-tab"]) expect(byId(file, id)?.enabled).toBe(false);
    // … and a click or a ⌘N that still arrives does nothing.
    const commands: string[] = [];
    const ctl = { tabs: { command: (id: string) => commands.push(id), applyMenu: () => {} } };
    const built = appMenu(() => ctl as never, false) as unknown as MenuItemConstructorOptions[];
    byId(fileMenu(built), "file.new")!.click?.(undefined as never, undefined, { triggeredByAccelerator: true } as never);
    expect(commands).toEqual([]);
  });

  it("switching: the live menu's items turned off; signed in again, the window's own state comes back", () => {
    const items = new Map<string, { enabled: boolean }>([
      ["file.new", { enabled: true }],
      ["file.import", { enabled: true }],
      ["file.save-local-copy", { enabled: true }],
      ["app.theme-dark", { enabled: true }],
    ]);
    appMenuNow.menu = { getMenuItemById: (id) => items.get(id) ?? null };
    setMenuSignedOut(true);
    expect(Object.fromEntries([...items].map(([id, i]) => [id, i.enabled]))).toEqual({ "file.new": false, "file.import": false, "file.save-local-copy": false, "app.theme-dark": true });
    setMenuSignedOut(false);
    expect(menuSignedOut()).toBe(false);
    const file = fileMenu(menu("darwin", { enabled: false }));
    expect(byId(file, "file.new")?.enabled).toBe(true);
  });
});
