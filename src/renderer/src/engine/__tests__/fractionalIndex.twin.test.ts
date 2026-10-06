// docs/engine.md §2.4: the C++ fractional index and its TS twin produce identical keys —
// both are checked against engine/tests/data/fractional-index-vectors.txt (the C++ side in
// engine/tests/unit/base.fractional_index.test.cpp, the TS side here).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { keyBetween, keysBetween, rebalancedKeys, type Bias } from "@shared/schema/fractionalIndex";

const vectors = readFileSync(fileURLToPath(new URL("../../../../../engine/tests/data/fractional-index-vectors.txt", import.meta.url)), "utf8")
  .split("\n")
  .filter((line) => line && !line.startsWith("#"))
  .map((line) => JSON.parse(line) as { fn: string; lo?: string; hi?: string | null; bias?: Bias; n?: number; out: string | string[] });

describe("fractional index: the TS twin reproduces the engine's vectors", () => {
  it(`all ${vectors.length} lines`, () => {
    expect(vectors.length).toBeGreaterThan(300);
    for (const v of vectors) {
      if (v.fn === "keyBetween") expect(keyBetween(v.lo!, v.hi ?? null, v.bias), JSON.stringify(v)).toBe(v.out);
      else if (v.fn === "keysBetween") expect(keysBetween(v.lo!, v.hi ?? null, v.n!)).toEqual(v.out);
      else if (v.fn === "rebalancedKeys") expect(rebalancedKeys(v.n!).slice(0, (v.out as string[]).length)).toEqual(v.out);
      else if (v.fn === "appendRun") {
        let k = "";
        for (let i = 0; i < v.n!; i++) k = keyBetween(k, null, "LOW");
        expect(k).toBe(v.out);
      }
    }
  });
});
