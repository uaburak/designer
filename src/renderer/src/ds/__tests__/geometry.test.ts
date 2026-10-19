import { describe, expect, it } from "vitest";
import { dropIndex, initials, thumbGeometry, visibleRange } from "../util/geometry";
import { hexDigits, hexDigitsToRgba, hexSelection, hexTargets, normalizeHex, parseColor, parseHexInput, stepHex, withOpacity } from "../util/color";
import { formatEdited, refreshDelay, timeAgo } from "../util/time";

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
  it("step the hex channel under the caret with ↑ ↓ (Figma's getIncrementTargets) and select it", () => {
    const of = (start: number, end = start) => [...hexTargets(start, end)];
    expect([of(0), of(2), of(3), of(4), of(5), of(6), of(0, 6), of(1, 3)]).toEqual([["r"], ["r"], ["g"], ["g"], ["b"], ["b"], ["r", "g", "b"], ["r", "g"]]);
    expect(stepHex("#0c8ce9", new Set(["g"]), 1)).toBe("#0c8de9");
    expect(stepHex("#0c8ce9", new Set(["r", "b"]), -20)).toBe("#008cd5");
    expect(stepHex("#fffffe", new Set(["r", "g", "b"]), 10)).toBe("#ffffff");
    expect([hexSelection(new Set(["g"])), hexSelection(new Set(["r", "g"])), hexSelection(new Set(["b"]))]).toEqual([{ start: 2, end: 4 }, { start: 0, end: 4 }, { start: 4, end: 6 }]);
  });
});

describe("relative times (Figma's wording)", () => {
  const now = Date.UTC(2026, 9, 6, 15, 5);
  const S = 1000;
  const MIN = 60 * S;
  const H = 60 * MIN;
  const D = 24 * H;
  const ago = (ms: number) => formatEdited(now - ms, now);
  it("says just now, then minutes, hours, days, months, years — singular when one", () => {
    expect(ago(10_000)).toBe("Edited just now");
    expect(ago(60_000)).toBe("Edited 1 minute ago");
    expect(ago(34 * 60_000)).toBe("Edited 34 minutes ago");
    expect(ago(3_600_000)).toBe("Edited 1 hour ago");
    expect(ago(86_400_000)).toBe("Edited yesterday");
    expect(ago(3 * 86_400_000)).toBe("Edited 3 days ago");
    expect(ago(31 * 86_400_000)).toBe("Edited last month");
    expect(ago(70 * 86_400_000)).toBe("Edited 2 months ago");
    expect(ago(400 * 86_400_000)).toBe("Edited last year");
  });
  it("rounds within moment's buckets: 45 s, 90 s, 45 min, 90 min, 22 h, 36 h, 26 days, 45 days, 320 days", () => {
    expect(timeAgo(now - 44 * S, now)).toBe("just now");
    expect(timeAgo(now - 45 * S, now)).toBe("1 minute ago");
    expect(timeAgo(now - 89 * S, now)).toBe("1 minute ago");
    expect(timeAgo(now - 90 * S, now)).toBe("2 minutes ago");
    expect(timeAgo(now - (2 * MIN + 30 * S), now)).toBe("3 minutes ago");
    expect(timeAgo(now - 44 * MIN, now)).toBe("44 minutes ago");
    expect(timeAgo(now - 45 * MIN, now)).toBe("1 hour ago");
    expect(timeAgo(now - 89 * MIN, now)).toBe("1 hour ago");
    expect(timeAgo(now - 90 * MIN, now)).toBe("2 hours ago");
    expect(timeAgo(now - 21 * H, now)).toBe("21 hours ago");
    expect(timeAgo(now - 22 * H, now)).toBe("yesterday");
    expect(timeAgo(now - 35 * H, now)).toBe("yesterday");
    expect(timeAgo(now - 36 * H, now)).toBe("2 days ago");
    expect(timeAgo(now - 25 * D, now)).toBe("25 days ago");
    expect(timeAgo(now - 26 * D, now)).toBe("last month");
    expect(timeAgo(now - 44 * D, now)).toBe("last month");
    expect(timeAgo(now - 45 * D, now)).toBe("2 months ago");
    expect(timeAgo(now - 319 * D, now)).toBe("11 months ago");
    expect(timeAgo(now - 320 * D, now)).toBe("last year");
    expect(timeAgo(now - 600 * D, now)).toBe("2 years ago");
    expect(timeAgo(now + 5 * MIN, now)).toBe("just now");
  });
  it("refreshes every 30 s under an hour, every 30 min under a day, else every 6 h", () => {
    expect(refreshDelay(0)).toBe(30 * S);
    expect(refreshDelay(59 * MIN)).toBe(30 * S);
    expect(refreshDelay(H)).toBe(30 * MIN);
    expect(refreshDelay(23 * H)).toBe(30 * MIN);
    expect(refreshDelay(D)).toBe(6 * H);
  });
});
