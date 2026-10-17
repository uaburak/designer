import { describe, expect, it } from "vitest";
import { dropIndex, initials, thumbGeometry, visibleRange } from "../util/geometry";
import { hexDigits, hexDigitsToRgba, normalizeHex, parseColor, parseHexInput, withOpacity } from "../util/color";
import { formatEdited } from "../util/time";

describe("tab drag", () => {
  it("drops before the first tab whose middle is past the dragged middle", () => {
    expect(dropIndex([100, 200, 300], 50)).toBe(0);
    expect(dropIndex([100, 200, 300], 150)).toBe(1);
    expect(dropIndex([100, 200, 300], 350)).toBe(3);
  });
});

describe("scroll thumbs", () => {
  it("are absent when nothing scrolls", () => expect(thumbGeometry(100, 100, 0, 96)).toBeNull());
  it("are sized by the visible share and placed by the scroll", () => {
    expect(thumbGeometry(100, 400, 0, 100)).toEqual({ size: 25, offset: 0 });
    expect(thumbGeometry(100, 400, 300, 100)).toEqual({ size: 25, offset: 75 });
    expect(thumbGeometry(100, 10000, 0, 100)?.size).toBe(20);
  });
});

describe("virtual list", () => {
  it("draws the rows in view plus overscan", () => {
    expect(visibleRange(0, 240, 24, 1000, 8)).toEqual([0, 18]);
    expect(visibleRange(2400, 240, 24, 1000, 8)).toEqual([92, 118]);
    expect(visibleRange(23900, 240, 24, 1000, 8)).toEqual([987, 1000]);
  });
});

describe("avatar initials", () => {
  it("takes the first and last word", () => {
    expect(initials("Burak Koç")).toBe("BK");
    expect(initials("burak ali koç")).toBe("BK");
    expect(initials("Burak", 2)).toBe("BU");
    expect(initials("Burak Koç", 1)).toBe("B");
    expect(initials("  ")).toBe("");
  });
});

describe("colour fields", () => {
  it("read 3 or 6 hex digits, with or without #, and colour names", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("0C8CE9")).toBe("#0c8ce9");
    expect(normalizeHex("White")).toBe("#ffffff");
    expect(normalizeHex("12345")).toBeNull();
    // 8-digit (and 4-digit) hex: the last pair is the alpha (help 360043042113).
    expect(parseHexInput("#FF000080")).toEqual({ hex: "#ff0000", opacity: 50 });
    expect(parseHexInput("0c8ce9ff")).toEqual({ hex: "#0c8ce9", opacity: 100 });
    expect(parseHexInput("f008")).toEqual({ hex: "#ff0000", opacity: 53 });
    expect(parseHexInput("abc")).toEqual({ hex: "#aabbcc" });
    expect(normalizeHex("#ggg")).toBeNull();
  });
  it("read 1 to 8 hex digits as Figma's fields do, the first run after any junk (atlas 07 §5.4)", () => {
    expect(parseHexInput("8")).toEqual({ hex: "#888888" });
    expect(parseHexInput("80")).toEqual({ hex: "#808080" });
    expect(parseHexInput("f80")).toEqual({ hex: "#ff8800" });
    // 5: #RGB + a two-digit alpha; 7: #RRGGBB + one alpha digit, doubled
    expect(parseHexInput("12345")).toEqual({ hex: "#112233", opacity: 27 });
    expect(parseHexInput("1234568")).toEqual({ hex: "#123456", opacity: 53 });
    expect(parseHexInput("0c8ce9ff99")).toEqual({ hex: "#0c8ce9", opacity: 100 });
    expect(parseHexInput("  #ff0000;")).toEqual({ hex: "#ff0000" });
    expect(parseHexInput("zz")).toBeNull();
    expect(hexDigitsToRgba("f008", false)).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColor("#ff0;", { strict: true })?.color).toEqual({ r: 1, g: 1, b: 0, a: 1 });
    expect(parseColor("x ff0", { strict: true })).toBeNull();
  });
  it("read the 148 CSS colour names and CSS colour functions", () => {
    expect(normalizeHex("RebeccaPurple")).toBe("#663399");
    expect(normalizeHex("lightgoldenrodyellow")).toBe("#fafad2");
    expect(parseHexInput("DarkSlateGrey")).toEqual({ hex: "#2f4f4f" });
    expect(parseHexInput("rgba(255, 0, 0, 0.5)")).toEqual({ hex: "#ff0000", opacity: 50 });
    expect(parseHexInput("rgb(100% 50% 0% / 25%)")).toEqual({ hex: "#ff8000", opacity: 25 });
    expect(parseHexInput("hsl(120deg 100% 50%)")).toEqual({ hex: "#00ff00" });
    expect(parseHexInput("color(srgb 0 0 1)")).toEqual({ hex: "#0000ff" });
    // P3's own green is outside sRGB: clamped
    expect(parseHexInput("color(display-p3 0 1 0)")).toEqual({ hex: "#00ff00" });
    expect(parseHexInput("oklab(62.8% 0.225 0.126)")).toEqual({ hex: "#ff0000" });
    expect(parseHexInput("oklch(0.628 0.258 29.23)")).toEqual({ hex: "#ff0000" });
    expect(parseHexInput("lab(53.24 80.09 67.2)")).toEqual({ hex: "#ff0000" });
  });
  it("write six upper-case digits and translucent CSS", () => {
    expect(hexDigits("#0c8ce9")).toBe("0C8CE9");
    expect(withOpacity("#ff0000", 50)).toBe("rgba(255, 0, 0, 0.5)");
    expect(withOpacity("#ff0000", 150)).toBe("rgba(255, 0, 0, 1)");
  });
});

describe("relative times (Figma's wording)", () => {
  const now = Date.UTC(2026, 9, 6, 15, 5);
  const ago = (ms: number) => formatEdited(now - ms, now);
  it("says just now, then minutes, hours, days, months, years — singular when one", () => {
    expect(ago(10_000)).toBe("Edited just now");
    expect(ago(60_000)).toBe("Edited 1 minute ago");
    expect(ago(34 * 60_000)).toBe("Edited 34 minutes ago");
    expect(ago(3_600_000)).toBe("Edited 1 hour ago");
    expect(ago(86_400_000)).toBe("Edited 1 day ago");
    expect(ago(3 * 86_400_000)).toBe("Edited 3 days ago");
    expect(ago(31 * 86_400_000)).toBe("Edited 1 month ago");
    expect(ago(70 * 86_400_000)).toBe("Edited 2 months ago");
    expect(ago(400 * 86_400_000)).toBe("Edited 1 year ago");
  });
});
