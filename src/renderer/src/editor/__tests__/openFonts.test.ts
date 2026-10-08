// Fonts at open (openFonts.ts): the shown page's fonts first, and — as Figma loads pages on demand — nothing for the
// other pages unless a prefetch is asked for.
import { describe, expect, it, vi } from "vitest";
import { planFonts, requestFonts } from "../openFonts";

const facts = {
  fonts: [
    { family: "Inter", style: "Regular" },
    { family: "Matter", style: "Medium" },
    { family: "SF Pro Rounded", style: "Regular" },
  ],
  fontsByPage: {
    "0:1": [{ family: "Inter", style: "Regular" }, { family: "Matter", style: "Medium" }],
    "1:1": [{ family: "SF Pro Rounded", style: "Regular" }, { family: "Inter", style: "Regular" }],
  },
  needsFallbackFont: false,
};

describe("openFonts", () => {
  it("plans the shown page's fonts first and the other pages' apart", () => {
    const plan = planFonts(facts, "0:1");
    expect(plan.first.map((f) => `${f.family} ${f.style}`)).toEqual(["Inter Regular", "Matter Medium"]);
    expect(plan.later.map((f) => `${f.family} ${f.style}`)).toEqual(["SF Pro Rounded Regular"]);
  });

  it("requests only the shown page's fonts unless a prefetch is asked for", () => {
    vi.useFakeTimers();
    const g = globalThis as Record<string, unknown>;
    g.window ??= globalThis;  // the prefetch schedules with window.setTimeout (a node test has no window)
    try {
      const asked: string[] = [];
      const request = (f: { family: string; style: string }) => asked.push(`${f.family} ${f.style}`);
      const cancel = requestFonts(planFonts(facts, "1:1"), { request, delayMs: 0 });
      vi.advanceTimersByTime(10_000);
      expect(asked).toEqual(["SF Pro Rounded Regular", "Inter Regular"]);
      cancel();
      asked.length = 0;
      const cancelPrefetch = requestFonts(planFonts(facts, "1:1"), { request, delayMs: 0, prefetch: true });
      vi.advanceTimersByTime(10_000);
      expect(asked).toContain("Matter Medium");
      cancelPrefetch();
    } finally {
      vi.useRealTimers();
    }
  });
});
