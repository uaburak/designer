import { describe, expect, it } from "vitest";
import { dropIndex, initials, thumbGeometry, visibleRange } from "../util/geometry";
import { hexDigits, normalizeHex, withOpacity } from "../util/color";
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
    expect(normalizeHex("#ggg")).toBeNull();
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
