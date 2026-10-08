// The Typography section's text model (model/text.ts): merging the engine's range summaries into "Mixed", Figma's
// weight steps for ⌘B / ⌘I, variable axes as fontVariations, links.
import { describe, expect, it } from "vitest";
import { axisTagNumber, mergeRangeStyles, normalizeLink, styleFor, styleWeight, textSummary, toggledBold, toggledItalic, withAxis } from "../model/text";
import type { TextRangeStyle } from "@/engine/codec";

const range = (values: TextRangeStyle["values"], mixed: string[] = []): TextRangeStyle => ({ from: 0, to: 1, values, mixed });

describe("text model", () => {
  it("merges summaries: a field differing between layers, or mixed in one, is Mixed", () => {
    const s = mergeRangeStyles([
      range({ fontSize: 12, fontFamily: "Inter", textDecoration: "NONE" }, ["fontStyle"]),
      range({ fontSize: 14, fontFamily: "Inter", textDecoration: "NONE" }),
    ]);
    expect([...s.mixed].sort()).toEqual(["fontSize", "fontStyle"]);
    expect(s.values.fontFamily).toBe("Inter");
    expect(s.values.fontSize).toBe(12);
  });

  it("reads the engine's summaries; null without the API or texts", () => {
    expect(textSummary({}, ["1:1"])).toBeNull();
    const engine = { textRangeStyle: (r: string) => (r === "1:1" ? range({ fontSize: 20 }) : null) };
    expect(textSummary(engine, ["1:1", "1:2"])?.values.fontSize).toBe(20);
    expect(textSummary(engine, ["1:2"])).toBeNull();
  });

  it("⌘B and ⌘I step weight and slant as Figma's styles name them", () => {
    expect(styleWeight("Semi Bold Italic")).toEqual({ weight: 600, italic: true });
    expect(toggledBold("Regular")).toBe("Bold");
    expect(toggledBold("Bold")).toBe("Regular");
    expect(toggledBold("Semi Bold")).toBe("Regular");
    expect(toggledBold("Italic")).toBe("Bold Italic");
    expect(toggledItalic("Regular")).toBe("Italic");
    expect(toggledItalic("Medium")).toBe("Medium Italic");
    expect(toggledItalic("Bold Italic")).toBe("Bold");
    // A family's own naming wins ("SemiBold").
    expect(styleFor(600, false, ["Regular", "SemiBold", "Bold"])).toBe("SemiBold");
  });

  it("variable axes: a tag as fontVariations' number, one axis set and the others kept", () => {
    expect(axisTagNumber("wght")).toBe(2003265652);
    const v = withAxis([{ axisTag: axisTagNumber("wdth"), axisName: "Width", value: 90 }], "wght", "Weight", 650);
    expect(v).toEqual([
      { axisTag: axisTagNumber("wdth"), axisName: "Width", value: 90 },
      { axisTag: 2003265652, axisName: "Weight", value: 650 },
    ]);
    expect(withAxis(v, "wght", "Weight", 300).filter((a) => a.axisTag === 2003265652)).toEqual([{ axisTag: 2003265652, axisName: "Weight", value: 300 }]);
  });

  it("links: URLs and bare domains; mailto isn't supported (Figma)", () => {
    expect(normalizeLink("https://www.figma.com/file/x")).toBe("https://www.figma.com/file/x");
    expect(normalizeLink("figma.com")).toBe("https://figma.com");
    expect(normalizeLink("mailto:a@b.c")).toBeNull();
    expect(normalizeLink("  ")).toBeNull();
    expect(normalizeLink("not a link")).toBeNull();
  });
});
