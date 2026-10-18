import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ZOOM_STOP, ZOOM_STOPS, isZoomStop, stepZoomStop } from "../shared/interfaceScale";
import { command, MENU_LAYOUT, type MenuEntry } from "../shared/commands";

vi.mock("electron", () => ({ app: { getPath: () => "/nowhere", disableHardwareAcceleration: () => {}, relaunch: () => {}, quit: () => {} } }));
vi.mock("./dialogs", () => ({ askRestartRequired: async () => false }));
vi.mock("./window", () => ({ controllers: new Map() }));
const { backendQuery, withBackend } = await import("./troubleshooting");
const { sanitizeSettings } = await import("./session");

const submenu = (list: MenuEntry[], name: string) => (list.find((e) => typeof e === "object" && "submenu" in e && e.submenu === name) as { items: MenuEntry[] } | undefined)?.items;

describe("View › Interface Scale (atlas 21 §7)", () => {
  it("Figma's stops, 100 by default; Make Larger / Smaller step one, the ends stay", () => {
    expect(ZOOM_STOPS).toEqual([25, 33, 50, 66, 80, 90, 100, 110, 120, 130, 140, 150, 175, 200, 250, 300, 400, 500]);
    expect(DEFAULT_ZOOM_STOP).toBe(100);
    expect(stepZoomStop(100, 1)).toBe(110);
    expect(stepZoomStop(150, 1)).toBe(175);
    expect(stepZoomStop(25, -1)).toBe(25);
    expect(stepZoomStop(500, 1)).toBe(500);
    // A value that isn't a stop (an edited settings.json) steps from 100.
    expect(stepZoomStop(123, -1)).toBe(90);
    expect(isZoomStop(66)).toBe(true);
    expect(isZoomStop(65)).toBe(false);
  });

  it("in the View menu with Figma desktop's keys", () => {
    expect(submenu(MENU_LAYOUT.View, "Interface Scale")).toEqual(["app.interface-scale-reset", "app.interface-scale-larger", "app.interface-scale-smaller"]);
    expect(command("app.interface-scale-reset").accelerator).toBe("Alt+Shift+CmdOrCtrl+0");
    expect(command("app.interface-scale-larger").accelerator).toBe("Alt+Shift+CmdOrCtrl+=");
    expect(command("app.interface-scale-smaller").accelerator).toBe("Alt+Shift+CmdOrCtrl+-");
  });
});

describe("Help › Troubleshooting (atlas 21 §7)", () => {
  it("Disable Hardware Acceleration, Graphics Backend ▸, Reload All Tabs", () => {
    const items = submenu(MENU_LAYOUT.Help, "Troubleshooting")!;
    expect(items[0]).toBe("app.disable-hardware-acceleration");
    expect(submenu(items, "Graphics Backend")).toEqual(["app.graphics-backend-default", "app.graphics-backend-webgl2", "app.graphics-backend-webgpu"]);
    expect(items.at(-1)).toBe("app.reload-all-tabs");
    expect(command("app.disable-hardware-acceleration").kind).toBe("checkbox");
  });

  it("the backend reaches the engine as its address's switch, replacing another one", () => {
    expect(backendQuery("default")).toEqual({});
    expect(backendQuery("webgpu")).toEqual({ "force-webgpu": "1" });
    expect(withBackend("app://designer/index.html?editor=&file=k", "webgl2")).toBe("app://designer/index.html?editor=&file=k&force-webgl2=1");
    expect(withBackend("app://designer/index.html?editor=&force-webgl2=1", "webgpu")).toBe("app://designer/index.html?editor=&force-webgpu=1");
    expect(withBackend("app://designer/index.html?editor=&force-webgpu=1", "default")).toBe("app://designer/index.html?editor=");
  });
});

describe("settings.json read forward (atlas 21 §4.1, §7)", () => {
  it("keeps what an older file has, and the new keys only when valid", () => {
    // Before 2026-10-18: Enhance contrast was kept only as true.
    expect(sanitizeSettings({ theme: "dark", contrast: true, locale: "tr" })).toEqual({ theme: "dark", contrast: true, locale: "tr" });
    // Set off now stays off (else the system's would decide).
    expect(sanitizeSettings({ theme: "system", contrast: false })).toEqual({ theme: "system", contrast: false });
    expect(sanitizeSettings({ theme: "light", underlineLinks: true, zoomStop: 150, disableHardwareAcceleration: true })).toEqual({ theme: "light", underlineLinks: true, zoomStop: 150, disableHardwareAcceleration: true });
    // Not a stop, the default, or junk: left out.
    expect(sanitizeSettings({ theme: "light", zoomStop: 123 })).toEqual({ theme: "light" });
    expect(sanitizeSettings({ theme: "light", zoomStop: 100 })).toEqual({ theme: "light" });
    expect(sanitizeSettings({ theme: "light", underlineLinks: "yes" as unknown as boolean, contrast: "more" as unknown as boolean })).toEqual({ theme: "light" });
  });
});
