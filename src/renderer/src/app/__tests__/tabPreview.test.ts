// The tab preview card's lines (atlas 01 §2.2): the desktop shell's own "time ago", truncated per unit, and the memory.
import { describe, expect, it } from "vitest";
import { memoryLine, shellTimeAgo } from "../TabPreviewApp";

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

describe("the tab preview card", () => {
  it("says how long ago as the desktop shell does: each unit truncated, yesterday / last month / last year for one", () => {
    const now = 1_000 * D;
    expect(shellTimeAgo(now - 1 * S, now)).toBe("1 second ago");
    expect(shellTimeAgo(now - 59.9 * S, now)).toBe("59 seconds ago");
    expect(shellTimeAgo(now - 119 * S, now)).toBe("1 minute ago");
    expect(shellTimeAgo(now - 59 * M, now)).toBe("59 minutes ago");
    expect(shellTimeAgo(now - 23.9 * H, now)).toBe("23 hours ago");
    expect(shellTimeAgo(now - 1.9 * D, now)).toBe("yesterday");
    expect(shellTimeAgo(now - 29 * D, now)).toBe("29 days ago");
    expect(shellTimeAgo(now - 30 * D, now)).toBe("last month");
    expect(shellTimeAgo(now - 359 * D, now)).toBe("11 months ago");
    expect(shellTimeAgo(now - 400 * D, now)).toBe("last year");
    expect(shellTimeAgo(now - 800 * D, now)).toBe("2 years ago");
    // A clock that went back reads as now.
    expect(shellTimeAgo(now + 5 * S, now)).toBe("0 seconds ago");
  });

  it("says the memory in MB, past 1024 MB in GB", () => {
    expect(memoryLine({ kind: "usage", mb: 412.4 })).toBe("Memory usage: 412MB");
    expect(memoryLine({ kind: "usage", mb: 3277 })).toBe("Memory usage: 3.2GB");
    expect(memoryLine({ kind: "freed", mb: 650 })).toBe("Offloaded tab: 650MB freed up");
  });
});
