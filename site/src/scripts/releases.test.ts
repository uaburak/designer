import { describe, expect, it } from "vitest";
import { detectPlatform, formatDate, formatSize, offerFor, parseReleases } from "./releases";

const json = {
  releases: [
    { version: "1.2.0", date: "2026-10-20", notes: "x", files: { mac: { name: "a.dmg", size: 148_234_567 } } },
    { version: "1.1.0", date: "2026-10-01", files: { mac: { name: "b.dmg", size: 1 }, windows: { name: "b.exe", size: 98_765_432 } } },
    { version: 3, files: {} },
  ],
};

describe("releases", () => {
  it("parses and drops malformed entries", () => {
    const r = parseReleases(json);
    expect(r.map((x) => x.version)).toEqual(["1.2.0", "1.1.0"]);
    expect(r[1].notes).toBe("");
    expect(parseReleases(null)).toEqual([]);
    expect(parseReleases({ releases: "no" })).toEqual([]);
  });

  it("offers the newest release that has the platform", () => {
    const r = parseReleases(json);
    expect(offerFor(r, "mac")?.version).toBe("1.2.0");
    expect(offerFor(r, "windows")?.version).toBe("1.1.0");
    expect(offerFor([], "mac")).toBeNull();
  });

  it("formats size and date", () => {
    expect(formatSize(148_234_567)).toBe("148 MB");
    expect(formatSize(98_765_432)).toBe("98.8 MB");
    expect(formatSize(0)).toBe("");
    expect(formatDate("2026-10-20")).toBe("Oct 20, 2026");
    expect(formatDate("soon")).toBe("soon");
  });

  it("detects the platform", () => {
    const mac = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 0 };
    expect(detectPlatform(mac)).toBe("mac");
    expect(detectPlatform({ ...mac, maxTouchPoints: 5 })).toBeNull(); // iPad
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32", maxTouchPoints: 0 })).toBe("windows");
    expect(detectPlatform({ userAgent: "X", platform: "", maxTouchPoints: 0, userAgentData: { platform: "Windows" } })).toBe("windows");
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (Linux; Android 14) Mobile", platform: "Linux armv8l", maxTouchPoints: 5 })).toBeNull();
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)", platform: "Linux x86_64", maxTouchPoints: 0 })).toBeNull();
  });
});
