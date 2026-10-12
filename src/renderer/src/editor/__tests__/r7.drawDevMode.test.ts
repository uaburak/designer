// Dev Mode for Figma Draw (docs/draw.md §7, round 7e): a TEXT_PATH inspects as text (Typography, text colour, its
// CSS is typography only), a TRANSFORM as a group (no repeat in CSS); their names, icons and "+ Property" offers.
import { describe, expect, it } from "vitest";
import type { Color, NodeChange } from "@/engine/codec";
import { cssSnippet, cssText } from "../../../../viewer/inspect/css";
import { annotationProperty } from "../../../../viewer/inspect/devMode";
import { isTextLike, isTransformGroup, typeLabel } from "../../../../viewer/inspect/model";
import { layerIcon } from "../../../../viewer/LeftPanel";
import { propertiesFor } from "../devmode/annotations";

const rgb = (hex: number, a = 1): Color => ({ r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255, a });

const textPath = {
  guid: "1:7",
  type: "TEXT_PATH",
  name: "Around",
  size: { x: 120, y: 120 },
  fontName: { family: "Inter", style: "Bold" },
  fontSize: 18,
  letterSpacing: { value: 10, units: "PERCENT" },
  textData: { characters: "Around the circle" },
  textPathStart: { tValue: 1.5, forward: false },
  cornerRadius: 4,
  fillPaints: [{ type: "SOLID", color: rgb(0xf24822), opacity: 1, visible: true }],
  strokePaints: [{ type: "SOLID", color: rgb(0x000000), opacity: 1, visible: true }],
  strokeWeight: 1,
} as unknown as NodeChange;

const repeat = {
  guid: "1:8",
  type: "TRANSFORM",
  name: "Repeat group 1",
  size: { x: 300, y: 40 },
  transform: { m00: 1, m01: 0, m02: 10, m10: 0, m11: 1, m12: 20 },
  transformModifiers: [{ type: "REPEAT", repeatType: "LINEAR", axis: "X", count: 4, unitType: "PIXELS", offset: { x: 12, y: 0 }, visible: true }],
} as unknown as NodeChange;

describe("Dev Mode: Draw's layers (docs/draw.md §7)", () => {
  it("names and icons: Text on path, Transform group", () => {
    expect([typeLabel(textPath), typeLabel(repeat)]).toEqual(["Text on path", "Transform group"]);
    expect([layerIcon(textPath as never), layerIcon(repeat as never)]).toEqual(["16.text-path", "16.repeat"]);
    expect([isTextLike(textPath), isTextLike(repeat), isTransformGroup(repeat)]).toEqual([true, false, true]);
  });

  it("a text path's CSS is its typography: colour, font, letter spacing — no border, background or radius", () => {
    const css = cssText({ node: textPath });
    expect(css).toContain("color: #F24822;");
    expect(css).toContain("font-family: Inter;");
    expect(css).toContain("font-size: 18px;");
    expect(css).toContain("font-weight: 700;");
    expect(css).toContain("letter-spacing: 1.8px;");
    expect(css).not.toMatch(/border|background|border-radius/);
  });

  it("a transform group's CSS is a group's: its box, no repeat (CSS has none) [ours]", () => {
    const snippet = cssSnippet({ node: repeat });
    const all = [...snippet.layout, ...snippet.style, ...snippet.typography].map((d) => `${d.property}: ${d.value}`).join("\n");
    expect(all).toContain("width: 300px");
    expect(all).not.toMatch(/repeat|background|border/);
  });

  it("annotations: a text path offers typography without line height and no corner radius; a transform group as a group", () => {
    const tp = propertiesFor({ type: "TEXT_PATH" });
    expect(tp).toEqual(expect.arrayContaining(["FONT_FAMILY", "FONT_SIZE", "LETTER_SPACING", "TEXT_ALIGN_HORIZONTAL"]));
    expect(tp).not.toContain("LINE_HEIGHT");
    expect(tp).not.toContain("CORNER_RADIUS");
    expect(propertiesFor({ type: "TRANSFORM" })).not.toContain("CORNER_RADIUS");
    expect(annotationProperty("FONT_SIZE", textPath).value).toBe("18px");
  });
});
