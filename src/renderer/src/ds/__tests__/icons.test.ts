import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ICONS, type IconEntry } from "../icons/registry";
import { buildRegistry, entryToSvg, REGISTRY, svgToEntry } from "../../../../../scripts/gen-icons";

describe("icon registry", () => {
  const entries = Object.entries(ICONS) as [string, IconEntry][];
  it("names every icon <box>.<name>, its box matching", () => {
    for (const [name, [box]] of entries) {
      expect(name, name).toMatch(/^(16|24)\.[a-z0-9][a-z0-9.-]*$/);
      expect(String(box), name).toBe(name.split(".")[0]);
    }
  });
  it("gives every icon a drawing mode and at least one path", () => {
    for (const [name, [, mode, ...paths]] of entries) {
      expect(mode === 0 || mode === 1 || /^s\d+$/.test(String(mode)), name).toBe(true);
      expect(paths.length, name).toBeGreaterThan(0);
      for (const p of paths) expect(p.replace(/^(f|[\d.]+)\|/, ""), name).toMatch(/^M/i);
    }
  });
  it("has the shell glyphs the chrome needs", () => {
    for (const n of ["24.home", "24.help", "24.close.small", "16.chevron.down", "16.chevron.right", "16.check", "24.search.small", "16.design"]) expect(n in ICONS, n).toBe(true);
  });
  it("dropped the legacy duplicates", () => {
    for (const n of ["chevron.right", "library", "close.small", "24.chevron.right.small"]) expect(n in ICONS, n).toBe(false);
  });
  it("is what the SVG sources give (`npm run icons`)", () => {
    expect(readFileSync(REGISTRY, "utf8"), "registry.ts is out of date: run `npm run icons`").toBe(buildRegistry());
  });
  it("round-trips through SVG unchanged", () => {
    for (const [name, entry] of entries) expect(svgToEntry(entryToSvg(entry), entry[0]), name).toEqual([...entry]);
  });
  it("reads Figma's own SVG export (black at 0.9 / 0.3, even-odd)", () => {
    const figma = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M1 1H2Z" fill="black" fill-opacity="0.9"/><path d="M3 3H4Z" fill="black" fill-opacity="0.3"/></svg>`;
    expect(svgToEntry(figma, 24)).toEqual([24, 1, "M1 1H2Z", "0.3|M3 3H4Z"]);
  });
});
