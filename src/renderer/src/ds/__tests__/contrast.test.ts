import { describe, expect, it } from "vitest";
import { autoCorrect, contrastCategoryOf, contrastLines, contrastOf, CONTRAST_RATIOS, selectionCategory, wcagLuminance } from "../util/contrast";
import { rgbToHsv } from "../util/color";

const white = { r: 1, g: 1, b: 1, a: 1 };
const black = { r: 0, g: 0, b: 0, a: 1 };

describe("the colour picker's contrast check (atlas 07 §5.7)", () => {
  it("reads WCAG contrast of the fill over what's behind it, cut to 2 decimals", () => {
    expect(contrastOf(black, white)).toBe(21);
    expect(contrastOf(white, white)).toBe(1);
    // #767676 on white: 4.54…:1 (cut, not rounded)
    expect(contrastOf({ r: 0x76 / 255, g: 0x76 / 255, b: 0x76 / 255, a: 1 }, white)).toBe(4.54);
    // Half-transparent black over white is grey.
    expect(contrastOf({ ...black, a: 0.5 }, white)).toBeLessThan(5);
    expect(wcagLuminance(white)).toBeCloseTo(1);
  });

  it("asks for Figma's ratios: normal text 4.5 / 7, large text 3 / 4.5, graphics 3 (no AAA)", () => {
    expect(CONTRAST_RATIOS.normalText).toEqual({ AA: 4.5, AAA: 7 });
    expect(CONTRAST_RATIOS.largeText).toEqual({ AA: 3, AAA: 4.5 });
    expect(CONTRAST_RATIOS.graphics).toEqual({ AA: 3, AAA: null });
    expect(contrastCategoryOf("RECTANGLE")).toBe("graphics");
    expect(contrastCategoryOf("TEXT", [{ fontSize: 24, fontWeight: 400 }])).toBe("largeText");
    expect(contrastCategoryOf("TEXT", [{ fontSize: 19, fontWeight: 700 }])).toBe("largeText");
    expect(contrastCategoryOf("TEXT", [{ fontSize: 24 }, { fontSize: 12 }])).toBe("normalText");
    expect(selectionCategory(new Set(["largeText"]))).toBe("largeText");
    expect(selectionCategory(new Set(["largeText", "graphics"]))).toBe("mixed");
    expect(selectionCategory(new Set(["normalText", "graphics"]))).toBeNull();
  });

  it("finds the lines where the ratio is met exactly, and auto-corrects to the nearest colour of the same hue on them", () => {
    const fg = { r: 0.6, g: 0.75, b: 1, a: 1 }; // a light blue on white: about 1.9:1
    const hue = rgbToHsv(fg).h / 360;
    const lines = contrastLines(4.5, hue, 1, white);
    expect(lines.lighter).toBeNull(); // nothing on white is lighter enough
    expect(lines.darker!.length).toBeGreaterThan(10);
    const fixed = autoCorrect({ ratio: 4.5, hue, alpha: 1, fg, bg: white })!;
    expect(fixed).not.toBeNull();
    expect(contrastOf(fixed, white)).toBeGreaterThanOrEqual(4.5);
    expect(contrastOf(fixed, white)).toBeLessThan(4.7);
    expect(rgbToHsv(fixed).h).toBeCloseTo(rgbToHsv(fg).h, 0);
    // A ratio no colour reaches on this background: none.
    expect(autoCorrect({ ratio: 21.5, hue, alpha: 1, fg, bg: white })).toBeNull();
  });
});
