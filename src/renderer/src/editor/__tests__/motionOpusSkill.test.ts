// The default skill motion-opus (docs/ai.md §8.6) carries three worked `animate` scripts: each must be valid JSON the
// animate compiler takes without warnings, against a stand-in frame holding every layer it names.
import { describe, expect, it } from "vitest";
import { MOTION_OPUS } from "@shared/agents/defaultSkills";
import { compileScript, type Channel, type Host, type Value } from "../agents/animateScript";

/** The scripts in the skill: from a line starting `{"nodeId"` to the line ending `]}`. */
function scripts(text: string): { tweens: unknown[]; timeline?: { duration?: number } }[] {
  const out: { tweens: unknown[] }[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('{"nodeId"')) continue;
    let j = i;
    while (!lines[j].trimEnd().endsWith("]}")) j++;
    out.push(JSON.parse(lines.slice(i, j + 1).join("\n")));
    i = j;
  }
  return out;
}

/** Every named target resolves (a path with "/*" to four children); texts split into a few elements. */
const host: Host = {
  resolve: (targets) => {
    const list = (Array.isArray(targets) ? targets : [targets]) as string[];
    return { ids: list.flatMap((t) => (t.endsWith("/*") ? [1, 2, 3, 4].map((n) => `${t}#${n}`) : [t])), warnings: [] };
  },
  rest: (_id, c: Channel): Value | null => (c === "opacity" || c === "scale" || c === "scaleX" || c === "scaleY" ? 1 : c === "fill" || c === "stroke" ? { r: 0, g: 0, b: 0, a: 1 } : 0),
  elements: (id, split) => (/Title|Wordmark/.test(id) ? (split === "chars" ? 8 : split === "words" ? 3 : 1) : null),
};

describe("motion-opus's worked scripts", () => {
  const found = scripts(MOTION_OPUS.instructions);

  it("has the three examples (UI card, logo reveal, data viz)", () => {
    expect(found).toHaveLength(3);
  });

  it.each(found.map((s, i) => [i, s] as const))("script %i compiles without warnings and ends inside its timeline", (_i, s) => {
    const c = compileScript(s, host, { timelineDuration: s.timeline?.duration });
    expect(c.warnings).toEqual([]);
    expect(c.tweens.length).toBeGreaterThan(3);
    expect(c.end).toBeLessThanOrEqual(s.timeline?.duration ?? Infinity);
  });
});
