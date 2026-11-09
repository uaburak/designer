// @vitest-environment happy-dom
/**
 * The device's own interface over a prototype (present/deviceUi.ts): the settings (status bar on, no browser by
 * default; kept), each preset's kind, and what each kind draws and takes off the screen.
 */
import { describe, expect, it } from "vitest";
import { applyDeviceUiOption, chromeKind, chromeLayout, deviceUiEntries, isDark, readDeviceUi } from "@/present/deviceUi";

describe("deviceUi", () => {
  it("starts with the status bar on and no browser; the menus change and keep it", () => {
    expect(readDeviceUi()).toEqual({ statusBar: true, browser: "none" });
    expect(applyDeviceUiOption("deviceui:browser:safari")).toBe(true);
    expect(applyDeviceUiOption("deviceui:status")).toBe(true);
    expect(readDeviceUi()).toEqual({ statusBar: false, browser: "safari" });
    expect(JSON.parse(localStorage.getItem("wecra.preview.deviceUi")!)).toEqual({ statusBar: false, browser: "safari" });
    expect(applyDeviceUiOption("frame")).toBe(false);
    applyDeviceUiOption("deviceui:status");
    applyDeviceUiOption("deviceui:browser:none");
    expect(deviceUiEntries("iphone")[0]).toMatchObject({ id: "deviceui:status", checked: true });
    expect(deviceUiEntries("none")).toEqual([]);
  });

  it("knows each preset's kind", () => {
    expect(chromeKind("IPHONE_16_PRO_DESERT_TITANIUM")).toBe("iphone");
    expect(chromeKind("IPHONE_SE")).toBe("iphone-home");
    expect(chromeKind("APPLE_IPAD_PRO_11_SILVER")).toBe("ipad");
    expect(chromeKind("GOOGLE_PIXEL_8")).toBe("android");
    expect(chromeKind("MACBOOK_AIR")).toBe("mac");
    expect(chromeKind("SURFACE_PRO_8")).toBe("desktop");
    expect(chromeKind("APPLE_WATCH")).toBe("none");
  });

  it("floats the status bar over the page; opaque browser bars take their height off it", () => {
    const on = { statusBar: true, browser: "none" as const };
    expect(chromeLayout("iphone", "IPHONE_16_PRO", on, false)).toMatchObject({ status: 62, homeIndicator: true, top: 62, under: true, bottom: 34 });
    expect(chromeLayout("iphone", "IPHONE_16", on, false).status).toBe(59);
    expect(chromeLayout("iphone", "IPHONE_16", on, true).status).toBe(0); // landscape: iOS hides it
    expect(chromeLayout("iphone", "IPHONE_16", { ...on, browser: "safari" }, false)).toMatchObject({ floatingBar: true, top: 59, under: true, bottom: 82 });
    expect(chromeLayout("iphone", "IPHONE_16", { ...on, browser: "chrome" }, false)).toMatchObject({ toolbar: 52, top: 111, under: false, bottom: 84 });
    expect(chromeLayout("android", "GOOGLE_PIXEL_8", { ...on, browser: "safari" }, false)).toMatchObject({ browser: "chrome", top: 92 });
    expect(chromeLayout("mac", "MACBOOK_AIR", { ...on, browser: "chrome" }, true)).toMatchObject({ status: 37, top: 117 });
    expect(chromeLayout("iphone", "IPHONE_16", { statusBar: false, browser: "none" }, false)).toMatchObject({ status: 0, homeIndicator: false, top: 0, bottom: 0, under: false });
  });

  it("reads the page's colour as light or dark", () => {
    expect(isDark("#101010")).toBe(true);
    expect(isDark("#f5f2ed")).toBe(false);
    expect(isDark(null)).toBe(false);
  });
});
