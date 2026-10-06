import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract §3: no colour, shadow or font literals in the DS's stylesheets —
 * only var(--figma-color-*) / var(--ds-*). Pixel lengths are allowed.
 */
const ds = fileURLToPath(new URL("..", import.meta.url));
const modules = (readdirSync(ds, { recursive: true }) as string[]).filter((f) => f.endsWith(".module.css"));

/** The declarations of a stylesheet, comments dropped: [property, value, line]. */
function declarations(css: string): [string, string, number][] {
  const out: [string, string, number][] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  for (const m of clean.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)) out.push([m[1], m[2].trim(), clean.slice(0, m.index).split("\n").length]);
  return out;
}

describe("DS stylesheets", () => {
  it("exist", () => expect(modules.length).toBeGreaterThan(20));

  for (const file of modules) {
    it(`${file} uses tokens, not literals`, () => {
      const problems: string[] = [];
      for (const [prop, value, line] of declarations(readFileSync(join(ds, file), "utf8"))) {
        if (prop.startsWith("--")) continue;
        if (/#[0-9a-f]{3,8}\b/i.test(value) || /\b(rgba?|hsla?)\(/i.test(value)) problems.push(`${line}: ${prop}: ${value}`);
        if (prop === "box-shadow" && value !== "none" && !value.includes("var(")) problems.push(`${line}: ${prop}: ${value}`);
        if (prop === "font" && !value.startsWith("var(") && value !== "inherit") problems.push(`${line}: ${prop}: ${value}`);
        if (prop === "font-family" && !value.startsWith("var(")) problems.push(`${line}: ${prop}: ${value}`);
      }
      expect(problems).toEqual([]);
    });
  }

  it("wrap their rules in a cascade layer", () => {
    for (const file of modules) expect(readFileSync(join(ds, file), "utf8"), file).toMatch(/@layer (ds|app) \{/);
  });
});
