// The timeline's geometry (docs/motion.md §6.2): time ↔ x about the 18 px origin, the ruler's labels, frame snapping
// and ⇧-snapping, the time formats, the layer bar's extent.
import { describe, expect, it } from "vitest";
import type { TimelineLayer } from "@shared/motion/types";
import { ORIGIN_PX, fitScale, formatTime, frameUs, layerExtent, otherKeyframeTimes, parseTime, rulerTicks, snapTime, snapToFrame, timeToX, xToTime } from "../timeline/maths";

const layer = (tracks: { id: string; times: number[] }[]): TimelineLayer => ({
  node: "1:1",
  name: "Rect",
  icon: "16.rectangle",
  depth: 0,
  tracks: tracks.map((t) => ({ id: t.id, field: { type: "PROPERTY", name: "OPACITY" }, label: "Opacity", keyframes: t.times.map((ms, i) => ({ id: `${t.id}k${i}`, timeUs: ms * 1000, value: { type: "FLOAT", value: 1 }, easing: { type: "LINEAR" } })) })),
  clips: [],
  startUs: 0,
  endUs: 0,
});

describe("timeline maths", () => {
  it("fits the duration in the width and maps time ↔ x about the origin", () => {
    const s = fitScale(2_000_000, 18 + 2000 + 24);
    expect(s.pxPerUs).toBeCloseTo(0.001);
    expect(timeToX(0, s)).toBe(ORIGIN_PX);
    expect(timeToX(1_000_000, s)).toBeCloseTo(ORIGIN_PX + 1000);
    expect(xToTime(ORIGIN_PX + 500, s)).toBe(500_000);
    expect(xToTime(-40, s)).toBe(0);
  });

  it("labels the ruler at the first step whose labels are 56 px apart", () => {
    const s = { pxPerUs: 0.0005 }; // 0.5 px / ms → 250 ms = 125 px, 100 ms = 50 px (too close)
    const ticks = rulerTicks(1_000_000, s, "ms", 60);
    const labels = ticks.filter((t) => t.label !== null).map((t) => t.label);
    expect(labels).toEqual(["0 ms", "250 ms", "500 ms", "750 ms", "1000 ms"]);
    expect(ticks.filter((t) => t.label === null).length).toBe(16);
    expect(rulerTicks(1_000_000, s, "frames", 60).find((t) => t.timeUs === 500_000)?.label).toBe("30 f");
  });

  it("snaps to frames, and with ⇧ to the playhead and the other keyframes", () => {
    expect(frameUs(60)).toBeCloseTo(16666.67);
    expect(snapToFrame(20_000, 60)).toBeCloseTo(16666.67);
    expect(snapToFrame(-5, 60)).toBe(0);
    expect(snapTime(503_000, 60, [500_000], 5_000)).toBe(500_000);
    expect(snapTime(520_000, 60, [500_000], 5_000)).toBeCloseTo(516666.67); // out of reach: the frame grid
    expect(snapTime(0, 10)).toBe(0);
  });

  it("formats and parses times in ms and frames", () => {
    expect(formatTime(1_250_000, "ms", 60)).toBe("1250 ms");
    expect(formatTime(1_250_500, "ms", 60)).toBe("1250.5 ms");
    expect(formatTime(500_000, "frames", 30)).toBe("15 f");
    expect(parseTime("1250", "ms", 60)).toBe(1_250_000);
    expect(parseTime("1.5s", "ms", 60)).toBe(1_500_000);
    expect(parseTime("30", "frames", 60)).toBe(500_000);
    expect(parseTime("12 f", "ms", 24)).toBe(500_000);
    expect(parseTime("abc", "ms", 60)).toBeNull();
    expect(parseTime("-3", "ms", 60)).toBeNull();
  });

  it("the layer bar spans the first to the last keyframe; the ⇧ targets leave out the dragged ones", () => {
    const l = layer([{ id: "a", times: [200, 800] }, { id: "b", times: [100, 500] }]);
    expect(layerExtent(l)).toEqual({ startUs: 100_000, endUs: 800_000 });
    expect(layerExtent(layer([]))).toBeNull();
    expect(otherKeyframeTimes([l], new Set(["ak0", "bk1"]))).toEqual([800_000, 100_000]);
  });
});
