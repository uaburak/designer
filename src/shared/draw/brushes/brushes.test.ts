// The built-in brushes (docs/draw.md §6, round 7e): our own generated artwork under Figma's 25 names.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brushDisplayName, SCATTER_BRUSH_NAMES, STRETCH_BRUSH_NAMES } from "../types";
import { brushesJson, generateBrushes, MAX_COMMANDS, RECIPE_KEYS, rng, SCATTER_SIZE, STRETCH_SIZE } from "./generate";
import { BUILTIN_BRUSHES, builtinBrush } from "./index";

const committed = readFileSync(join(__dirname, "builtin.generated.json"), "utf8");
const fresh = () => brushesJson(generateBrushes(STRETCH_BRUSH_NAMES, SCATTER_BRUSH_NAMES));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Splits SVG path data into its commands with their numbers. */
function commands(d: string): { op: string; nums: number[] }[] {
  return [...d.matchAll(/([MLQCZ])([^MLQCZ]*)/g)].map((m) => ({ op: m[1], nums: m[2].trim() ? m[2].trim().split(/[\s,]+/).map(Number) : [] }));
}

describe("built-in brushes", () => {
  it("are deterministic: the generator twice, and the committed JSON, hash the same", () => {
    const a = fresh();
    expect(sha(fresh())).toBe(sha(a));
    // stale JSON → run `npm run brushes`
    expect(sha(committed)).toBe(sha(a));
  });

  it("the PRNG is seeded (same seed, same sequence; different seeds differ)", () => {
    const a = rng(42);
    const b = rng(42);
    const c = rng(43);
    const sa = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(sa);
    expect([c(), c(), c()]).not.toEqual(sa);
  });

  it("are Figma's 25 names in Figma's order: 15 stretch then 10 scatter", () => {
    expect(BUILTIN_BRUSHES.map((b) => b.key)).toEqual([...STRETCH_BRUSH_NAMES, ...SCATTER_BRUSH_NAMES]);
    expect(BUILTIN_BRUSHES.filter((b) => b.type === "STRETCH").map((b) => b.key)).toEqual([...STRETCH_BRUSH_NAMES]);
    expect(BUILTIN_BRUSHES.filter((b) => b.type === "SCATTER").map((b) => b.key)).toEqual([...SCATTER_BRUSH_NAMES]);
    expect(RECIPE_KEYS.stretch.sort()).toEqual([...STRETCH_BRUSH_NAMES].sort());
    expect(RECIPE_KEYS.scatter.sort()).toEqual([...SCATTER_BRUSH_NAMES].sort());
    for (const b of BUILTIN_BRUSHES) expect(b.name).toBe(brushDisplayName(b.key));
    expect(builtinBrush("SPAGHETTI_WESTERN")?.name).toBe("Spaghetti Western");
    expect(builtinBrush("OI")?.name).toBe("Oi");
  });

  it("have the sizes, the budget and closed NONZERO regions inside their box", () => {
    expect(committed.length).toBeLessThan(120 * 1024);
    for (const b of BUILTIN_BRUSHES) {
      const size = b.type === "STRETCH" ? STRETCH_SIZE : SCATTER_SIZE;
      expect([b.artwork.width, b.artwork.height], b.key).toEqual([size.width, size.height]);
      expect(b.artwork.windingRule).toBe("NONZERO");
      const cmds = commands(b.artwork.d);
      expect(cmds.length, b.key).toBeLessThanOrEqual(MAX_COMMANDS);
      expect(cmds[0].op, b.key).toBe("M");
      expect(cmds[cmds.length - 1].op, b.key).toBe("Z");
      let open = false;
      let regions = 0;
      for (const c of cmds) {
        if (c.op === "M") {
          expect(open, `${b.key}: a region left open`).toBe(false);
          open = true;
          regions++;
        } else if (c.op === "Z") {
          expect(open).toBe(true);
          open = false;
        } else expect(open, `${b.key}: drawing outside a region`).toBe(true);
        const arity = { M: 2, L: 2, Q: 4, C: 6, Z: 0 }[c.op];
        expect(c.nums.length, `${b.key} ${c.op}`).toBe(arity);
        for (let i = 0; i < c.nums.length; i += 2) {
          expect(Number.isFinite(c.nums[i]) && c.nums[i] >= 0 && c.nums[i] <= size.width, b.key).toBe(true);
          expect(Number.isFinite(c.nums[i + 1]) && c.nums[i + 1] >= 0 && c.nums[i + 1] <= size.height, b.key).toBe(true);
        }
      }
      expect(regions, b.key).toBeGreaterThan(0);
    }
  });

  it("stretch artwork (but the thin ones) fills the height at its thickest and spans the length", () => {
    for (const b of BUILTIN_BRUSHES.filter((x) => x.type === "STRETCH")) {
      const ys = commands(b.artwork.d).flatMap((c) => c.nums.filter((_, i) => i % 2 === 1));
      const xs = commands(b.artwork.d).flatMap((c) => c.nums.filter((_, i) => i % 2 === 0));
      expect(Math.max(...ys) - Math.min(...ys), b.key).toBeGreaterThan(b.key === "BIOPIC" || b.key === "VERITE" ? 6 : 10) // the fine pen and pencil grain are thin by recipe;
      expect(Math.max(...xs) - Math.min(...xs), b.key).toBeGreaterThan(200);
    }
  });
});
