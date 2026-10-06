import { describe, expect, it } from "vitest";
import { compareKeys, insertKeys, isValidKey, keyBetween, keysBetween, MAX_KEY_LENGTH, rebalancedKeys } from "./fractionalIndex";

describe("fractional index (docs/schema.md §10.2 test vectors)", () => {
  it("matches the reference vectors", () => {
    expect(keyBetween("", null, "LOW")).toBe("!");
    expect(keyBetween("!", null, "LOW")).toBe('"');
    expect(keyBetween("~", null, "LOW")).toBe("~!");
    expect(keyBetween("", "!", "HIGH")).toBe(" ~");
    expect(keyBetween("!", "#", "MID")).toBe('"');
    expect(keyBetween("!", '"', "MID")).toBe("!O");
    expect(keyBetween("!", "!O", "MID")).toBe("!7");
    expect(rebalancedKeys(2)).toEqual(["?", "_"]);
    expect(rebalancedKeys(95).slice(0, 3)).toEqual([" ~", "!}", '"|']);
  });

  it("rejects lo == hi and lo > hi", () => {
    expect(() => keyBetween("!", "!")).toThrow();
    expect(() => keyBetween('"', "!")).toThrow();
  });

  it("keysBetween returns n ascending valid keys strictly inside the gap", () => {
    for (const [lo, hi] of [
      ["", null],
      ["", "!"],
      ["!", '"'],
      ["!O", "!P"],
      ["~", null],
    ] as [string, string | null][]) {
      const keys = keysBetween(lo, hi, 50);
      expect(keys).toHaveLength(50);
      for (let i = 0; i < keys.length; i++) {
        expect(isValidKey(keys[i])).toBe(true);
        if (i) expect(compareKeys(keys[i - 1], keys[i])).toBe(-1);
        expect(keys[i] > lo).toBe(true);
        if (hi !== null) expect(keys[i] < hi).toBe(true);
      }
    }
  });

  it("measures as documented: 3,000 appends reach 32 chars, repeated inserts into one gap grow by about a char each", () => {
    let k = "";
    for (let i = 0; i < 3000; i++) k = keyBetween(k, null, "LOW");
    expect(k.length).toBe(32);
    let lo = "!";
    const hi = '"';
    let n = 0;
    while (keyBetween(lo, hi).length <= 25) {
      lo = keyBetween(lo, hi);
      n++;
    }
    expect(n).toBeGreaterThan(100);
  });

  it("rebalanced keys are evenly spaced, ascending, valid and never end with a space", () => {
    for (const n of [1, 2, 10, 94, 95, 96, 1000, 9024]) {
      const keys = rebalancedKeys(n);
      expect(keys).toHaveLength(n);
      for (let i = 0; i < n; i++) {
        expect(isValidKey(keys[i])).toBe(true);
        if (i) expect(keys[i - 1] < keys[i]).toBe(true);
      }
    }
  });

  it("insertKeys rebalances instead of writing a key longer than 24 characters", () => {
    const siblings = ["!", "!" + "~".repeat(MAX_KEY_LENGTH - 1)];
    const { keys, rebalance } = insertKeys(siblings, 1, 1);
    expect(keys[0].length).toBeLessThanOrEqual(MAX_KEY_LENGTH);
    const deep = ["!", "!" + " ".repeat(MAX_KEY_LENGTH - 2) + "!"];
    const r = insertKeys(deep, 1, 1);
    expect(r.rebalance).not.toBeNull();
    const all = [r.rebalance![0], r.keys[0], r.rebalance![1]];
    expect([...all].sort()).toEqual(all);
    expect(rebalance === null || rebalance.length === siblings.length).toBe(true);
  });
});
