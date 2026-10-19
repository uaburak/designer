// The timeline's geometry (docs/motion.md §6.2): time ↔ x about the 18 px origin, the ruler's labels, frame snapping
// and ⇧-snapping, the time formats, the layer bar's extent; the marquee, the top edge's clamp, the keyframes copied;
// the Design fields' routing in Motion mode (panels/motionWrites.ts).
import { describe, expect, it } from "vitest";
import type { TimelineLayer } from "@shared/motion/types";
import { ORIGIN_PX, adjacentKeyframe, clampTimelineHeight, copyKeyframes, fitScale, formatTime, formatTrackValue, frameUs, layerExtent, marqueeBox, otherKeyframeTimes, overlaps, parseTime, rulerLabel, rulerTicks, snapTime, snapToFrame, timeNumber, timeToX, trackValueAt, xToTime } from "../timeline/maths";
import type { TimelineTrack } from "@shared/motion/types";
import { motionFieldOf, movedValue } from "../panels/motionWrites";

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

  it("labels the ruler at the first step whose labels are 80 px apart", () => {
    const s = { pxPerUs: 0.0005 }; // 0.5 px / ms → 200 ms = 100 px, 100 ms = 50 px (too close)
    const ticks = rulerTicks(1_000_000, s, "ms", 60);
    const labels = ticks.filter((t) => t.label !== null).map((t) => t.label);
    expect(labels).toEqual(["0s", "200ms", "400ms", "600ms", "800ms", "1s"]);
    expect(ticks.filter((t) => t.label === null).length).toBe(20);
    expect(rulerTicks(1_000_000, s, "frames", 60).find((t) => t.timeUs === 400_000)?.label).toBe("24");
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

  it("the marquee spans the press and the pointer either way; a diamond it touches is in it", () => {
    expect(marqueeBox({ x: 100, y: 80 }, { x: 40, y: 20 })).toEqual({ left: 40, top: 20, width: 60, height: 60 });
    const m = marqueeBox({ x: 0, y: 0 }, { x: 50, y: 50 });
    expect(overlaps(m, { left: 45, top: 45, width: 16, height: 16 })).toBe(true);
    expect(overlaps(m, { left: 51, top: 10, width: 16, height: 16 })).toBe(false);
    expect(overlaps(m, { left: -16, top: -16, width: 16, height: 16 })).toBe(true);
  });

  it("the timeline's height dragged by its top edge: 120 at least, 60 % of the window at most", () => {
    expect(clampTimelineHeight(80, 1000)).toBe(120);
    expect(clampTimelineHeight(333.4, 1000)).toBe(333);
    expect(clampTimelineHeight(900, 1000)).toBe(600);
  });

  it("copies the selected keyframes per layer and track, timed from the earliest", () => {
    const a = layer([{ id: "a", times: [100, 400, 900] }]);
    const b = { ...layer([{ id: "b", times: [250] }]), node: "1:2" };
    const copy = copyKeyframes([a, b], new Set(["ak1", "ak2", "bk0"]));
    expect(copy.map((c) => c.node)).toEqual(["1:1", "1:2"]);
    expect(copy[0].tracks[0].keyframes.map((k) => k.dtUs)).toEqual([150_000, 650_000]);
    expect(copy[1].tracks[0].keyframes.map((k) => k.dtUs)).toEqual([0]);
    expect(copy[0].tracks[0].field).toEqual({ type: "PROPERTY", name: "OPACITY" });
    expect(copyKeyframes([a], new Set())).toEqual([]);
  });

  it("Design's X / Y key the Position track (a layer's own X / Y track when it has one); a value moves by the change", () => {
    expect(motionFieldOf("x", undefined)).toBe("TRANSLATION_XY");
    expect(motionFieldOf("y", { TRANSLATION_Y: { state: "track" } })).toBe("TRANSLATION_Y");
    expect(motionFieldOf("x", { TRANSLATION_Y: { state: "track" } })).toBe("TRANSLATION_XY");
    expect(motionFieldOf("rotation", undefined)).toBe("ROTATION");
    expect(movedValue({ type: "VECTOR", value: { x: 10, y: -5 } }, { x: 5, y: 1 })).toEqual({ type: "VECTOR", value: { x: 15, y: -4 } });
    expect(movedValue({ type: "FLOAT", value: 90 }, { x: -10, y: 0 })).toEqual({ type: "FLOAT", value: 80 });
  });

  it("Figma's timeline wording (2026-10-18): ruler labels, the header's bare numbers, a property row's value and its ‹ ›", () => {
    expect([0, 500_000, 1_000_000, 1_500_000, 2_000_000].map((t) => rulerLabel(t, "ms", 60))).toEqual(["0s", "500ms", "1s", "500ms", "2s"]);
    expect(rulerLabel(500_000, "frames", 60)).toBe("30");
    expect(timeNumber(1_855_000, "ms", 60)).toBe("1855");
    const opacity: TimelineTrack = { id: "t", field: { type: "PROPERTY", name: "OPACITY" }, label: "Opacity", keyframes: [
      { id: "a", timeUs: 0, value: { type: "FLOAT", value: 0 }, easing: { type: "LINEAR" } },
      { id: "b", timeUs: 1_000_000, value: { type: "FLOAT", value: 1 }, easing: { type: "LINEAR" } },
    ] };
    expect(formatTrackValue(opacity, trackValueAt(opacity, 250_000))).toBe("25%");
    expect(formatTrackValue(opacity, trackValueAt(opacity, 5_000_000))).toBe("100%");
    const position: TimelineTrack = { id: "p", field: { type: "PROPERTY", name: "TRANSLATION_XY" }, label: "Position", keyframes: [
      { id: "c", timeUs: 0, value: { type: "VECTOR", value: { x: 0, y: 0 } }, easing: { type: "LINEAR" } },
      { id: "d", timeUs: 1_000_000, value: { type: "VECTOR", value: { x: 381.2, y: 492 } }, easing: { type: "LINEAR" } },
    ] };
    expect(formatTrackValue(position, trackValueAt(position, 500_000))).toBe("190.6, 246");
    expect(adjacentKeyframe(position, 500_000, -1)).toBe(0);
    expect(adjacentKeyframe(position, 500_000, 1)).toBe(1_000_000);
    expect(adjacentKeyframe(position, 1_000_000, 1)).toBeNull();
  });
});
