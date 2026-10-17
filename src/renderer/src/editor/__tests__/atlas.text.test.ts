// Atlas wave 3, "text" (docs/research/atlas/06-text-typography.md §14): the font picker's search, order, Popular fonts,
// hidden families and remembered font set; the Underline panel's limits and units; the Variable tab's steps, hints and
// folds; the layout-version banner's upgrades; Auto line height within 0.1.
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareFamilyNames, groupFamilies, type FontFaceInfo } from "@/engine/fonts";
import { filterFamilies, popularFamilies, searchTokens } from "../fontList";
import { readFontSet, writeFontSet } from "../panels/design/FontPicker";
import { UNDERLINE_LIMITS, axisSteps, axisStops, clampMetric, parseMetric, pendingUpgrades, variableAxes } from "../panels/design/TypeSettings";
import { documentFamilies, lineHeightView } from "../panels/design/Typography";

const face = (family: string, source: FontFaceInfo["source"] = "system", variable = false): FontFaceInfo => ({
  id: `${family}-r`, family, style: "Regular", weight: 400, italic: false, source, collectionIndex: 0, ...(variable ? { variable } : {}),
});
const names = (l: { family: string }[]) => l.map((f) => f.family);

describe("atlas wave 3: the font picker", () => {
  it("orders names starting with punctuation last", () => {
    expect(["(Beta)", "zeta", "Alpha"].sort(compareFamilyNames)).toEqual(["Alpha", "zeta", "(Beta)"]);
    expect(names(groupFamilies([face("#Test"), face("Inter"), face("abc")]))).toEqual(["abc", "Inter", "#Test"]);
  });

  it("searches Figma's way: words split at punctuation, every word found, names starting with the first word first, dot names hidden", () => {
    expect(searchTokens("Helvetica-Neue  Bold")).toEqual(["helvetica", "neue", "bold"]);
    const list = groupFamilies([face("Open Sans"), face("Sans Forgetica"), face("Noto Sans"), face(".SF NS"), face("Sansita")]);
    expect(names(filterFamilies(list, "all", "sans"))).toEqual(["Sans Forgetica", "Sansita", "Noto Sans", "Open Sans"]);
    expect(names(filterFamilies(list, "all", "sans-open"))).toEqual(["Open Sans"]);
    expect(names(filterFamilies(list, "all", "sf"))).toEqual([]);
  });

  it("Popular fonts is Figma's fifteen slots, each its first name the list has", () => {
    const list = groupFamilies([face("Inter"), face("Roboto"), face("Segoe UI"), face("SF Pro Text"), face("SF UI Text"), face("Lora", "google"), face("Caveat", "google"), face("Roboto Mono", "google")]);
    expect([...popularFamilies(list)]).toEqual(["inter", "roboto", "segoe ui", "sf pro text", "caveat", "roboto mono"]);
    expect(names(filterFamilies(list, "popular", ""))).toEqual(["Caveat", "Inter", "Roboto", "Roboto Mono", "Segoe UI", "SF Pro Text"]);
  });

  it("hides Figma's hidden Google families, and keeps its own families out of Google fonts", () => {
    const list = groupFamilies([
      face("Noto Color Emoji", "google"), face("Bungee Spice", "google"), face("Playwrite DE Grund", "google"), face("Playwrite US Trad", "google"),
      face("Unicharted", "google"), face("Material Icons", "google"), face("Lora", "google"), face("Honk"),
    ]);
    expect(names(filterFamilies(list, "all", ""))).toEqual(["Honk", "Lora", "Material Icons", "Playwrite US Trad"]);
    expect(names(filterFamilies(list, "google", ""))).toEqual(["Lora", "Playwrite US Trad"]);
  });

  it("Variable fonts needs every face variable; In this file is by use, most used first", () => {
    const list = groupFamilies([face("Mixed One", "system", true), { ...face("Mixed One"), id: "x", style: "Bold", weight: 700 }, face("Flex", "system", true), face("Aa"), face("Bb")]);
    expect(names(filterFamilies(list, "variable", ""))).toEqual(["Flex"]);
    expect(names(filterFamilies(list, "file", "", new Map([["aa", 1], ["bb", 9]])))).toEqual(["Bb", "Aa"]);
    expect([...documentFamilies({ documentFonts: () => [{ family: "Aa", uses: 2 }, { family: "aa", uses: 3 }, { family: "Bb" }] })]).toEqual([["aa", 5], ["bb", 1]]);
  });

  it("remembers the font set in localStorage under Figma's names", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    expect(readFontSet()).toBe("all");
    writeFontSet("variable");
    expect(localStorage.getItem("fontPickerFontSet")).toBe("variable_fonts");
    expect(readFontSet()).toBe("variable");
    localStorage.setItem("fontPickerFontSet", "user_installed_fonts");
    expect(readFontSet()).toBe("installed");
    localStorage.setItem("fontPickerFontSet", "summer_new");
    expect(readFontSet()).toBe("all");
  });
  afterEach(() => vi.unstubAllGlobals());
});

describe("atlas wave 3: Type settings", () => {
  const thick = UNDERLINE_LIMITS.thickness;
  const off = UNDERLINE_LIMITS.offset;
  it("limits the underline: thickness 0.5–20 % or 0.5 px–0.2 × size, offset 0–25 % or 0–0.25 × size", () => {
    expect(clampMetric({ value: 40, units: "PERCENT" }, thick, 16)).toEqual({ value: 20, units: "PERCENT" });
    expect(clampMetric({ value: 0.1, units: "PERCENT" }, thick, 16)).toEqual({ value: 0.5, units: "PERCENT" });
    expect(clampMetric({ value: 9, units: "PIXELS" }, thick, 16)).toEqual({ value: 3.2, units: "PIXELS" });
    expect(clampMetric({ value: 30, units: "PERCENT" }, off, 16)).toEqual({ value: 25, units: "PERCENT" });
    expect(clampMetric({ value: 9, units: "PIXELS" }, off, 16)).toEqual({ value: 4, units: "PIXELS" });
  });

  it("reads typed thicknesses and offsets: Auto, units switching, bare numbers in the current unit", () => {
    const auto = 0.0732; // Inter's underline thickness (em)
    expect(parseMetric("", null, auto, thick, 16)).toBeNull();
    expect(parseMetric("au", { value: 2, units: "PIXELS" }, auto, thick, 16)).toBeNull();
    expect(parseMetric("%", null, auto, thick, 16)).toEqual({ value: 7.32, units: "PERCENT" });
    expect(parseMetric("px", null, auto, thick, 16)).toEqual({ value: 1.17, units: "PIXELS" });
    expect(parseMetric("px", { value: 10, units: "PERCENT" }, auto, thick, 16)).toEqual({ value: 1.6, units: "PIXELS" });
    expect(parseMetric("2px", null, auto, thick, 16)).toEqual({ value: 2, units: "PIXELS" });
    expect(parseMetric("3", { value: 2, units: "PIXELS" }, auto, thick, 16)).toEqual({ value: 3, units: "PIXELS" });
    expect(parseMetric("3", null, auto, thick, 16)).toEqual({ value: 3, units: "PERCENT" });
    expect(parseMetric("50%", null, auto, off, 16)).toEqual({ value: 25, units: "PERCENT" });
    expect(parseMetric("2+1", null, auto, thick, 16)).toBeUndefined();
  });

  it("steps each axis by its range, and hints at its instances 15 steps apart at the least", () => {
    expect(axisSteps({ min: 0, max: 1 })).toEqual({ step: 0.01, bigStep: 0.25 });
    expect(axisSteps({ min: 0, max: 5 })).toEqual({ step: 0.1, bigStep: 1 });
    expect(axisSteps({ min: 8, max: 144 })).toEqual({ step: 1, bigStep: 10 });
    expect(axisSteps({ min: 100, max: 1000 })).toEqual({ step: 1, bigStep: 25 });
    // Instances 10 apart on a 1-step axis: every other one is dropped; the default is kept first.
    expect(axisStops({ min: 0, max: 100, default: 45, instances: [0, 10, 20, 30, 40, 50, 60] })).toEqual([0, 20, 45, 60]);
    // More than 15 left: the default alone.
    const many = Array.from({ length: 20 }, (_, i) => 100 + i * 45);
    expect(axisStops({ min: 100, max: 1000, default: 400, instances: many })).toEqual([400]);
  });

  it("never shows ital, folds the hidden axes, and shows SF Pro's width but not its yaxs", () => {
    const ax = (tag: string, hidden = false) => ({ tag, hidden });
    const plain = variableAxes([ax("wght"), ax("ital"), ax("GRAD", true)], "Roboto Flex");
    expect(plain.shown.map((a) => a.tag)).toEqual(["wght"]);
    expect(plain.more.map((a) => a.tag)).toEqual(["GRAD"]);
    const sf = variableAxes([ax("wght"), ax("wdth", true), ax("yaxs")], "SF Pro");
    expect(sf.shown.map((a) => a.tag)).toEqual(["wght", "wdth"]);
    expect(sf.more.map((a) => a.tag)).toEqual(["yaxs"]);
  });

  it("tells the upgrades a text is due; a text without the fields is today's", () => {
    expect(pendingUpgrades({})).toEqual([]);
    expect(pendingUpgrades({ textUserLayoutVersion: 1, textExplicitLayoutVersion: 1, textBidiVersion: 1 })).toEqual([]);
    expect(pendingUpgrades({ textUserLayoutVersion: 0, textExplicitLayoutVersion: 0 })).toEqual(["layout"]);
    expect(pendingUpgrades({ textBidiVersion: 0 })).toEqual(["bidi"]);
    expect(pendingUpgrades({ textExplicitLayoutVersion: 0, textBidiVersion: 0 })).toEqual(["layout", "bidi"]);
  });

  it("Auto line height is 100 % within 0.1", () => {
    expect(lineHeightView({ value: 100.05, units: "PERCENT" }).label).toBe("Auto");
    expect(lineHeightView({ value: 100.2, units: "PERCENT" }).label).toBeUndefined();
  });
});
