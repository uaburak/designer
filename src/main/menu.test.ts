import { afterEach, describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import type { UpdaterStatus } from "../shared/ipc";

vi.mock("electron", () => ({
  app: { name: "DesignerV2" },
  Menu: { buildFromTemplate: (t: MenuItemConstructorOptions[]) => t, setApplicationMenu: () => {} },
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
const { appMenu } = await import("./menu");

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
