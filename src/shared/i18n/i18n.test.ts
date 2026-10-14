import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, intlLocale, onLocaleChange, parseLocale, registerDictionary, setLocale, t, tp } from "./index";
import { TR } from "./tr";

registerDictionary("tr", { Share: "Paylaş", "Moved {name} to {folder}": "{name}, {folder} klasörüne taşındı", "{n} file": "{n} dosya", "{n} files": "{n} dosya" });

afterEach(() => setLocale("en"));

describe("i18n", () => {
  it("is English by default: the key is the text", () => {
    expect(getLocale()).toBe("en");
    expect(t("Share")).toBe("Share");
    expect(intlLocale()).toBe("en-US");
  });

  it("translates, and falls back to English for a missing key", () => {
    setLocale("tr");
    expect(t("Share")).toBe("Paylaş");
    expect(t("Not in the dictionary")).toBe("Not in the dictionary");
    expect(intlLocale()).toBe("tr-TR");
  });

  it("fills {vars} in either language, leaving unknown ones", () => {
    expect(t("Moved {name} to {folder}", { name: "A", folder: "B" })).toBe("Moved A to B");
    setLocale("tr");
    expect(t("Moved {name} to {folder}", { name: "A", folder: "B" })).toBe("A, B klasörüne taşındı");
    expect(t("Hi {who}")).toBe("Hi {who}");
  });

  it("picks the plural form by count", () => {
    expect(tp(1, "{n} file", "{n} files")).toBe("1 file");
    expect(tp(3, "{n} file", "{n} files")).toBe("3 files");
    expect(tp(0, "{n} file", "{n} files")).toBe("0 files");
    setLocale("tr");
    expect(tp(3, "{n} file", "{n} files")).toBe("3 dosya");
  });

  it("tells listeners only on an actual change", () => {
    const cb = vi.fn();
    const off = onLocaleChange(cb);
    setLocale("en");
    setLocale("tr");
    setLocale("tr");
    off();
    setLocale("en");
    expect(cb.mock.calls).toEqual([["tr"]]);
  });

  it("reads anything unknown as English", () => {
    expect(parseLocale("tr")).toBe("tr");
    expect(parseLocale("de")).toBe("en");
    expect(parseLocale(undefined)).toBe("en");
  });

  it("keeps every {var} of an English key in its Turkish text", () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    const bad = Object.entries(TR).filter(([en, tr]) => vars(en) !== vars(tr) || !tr.trim());
    expect(bad).toEqual([]);
  });
});
