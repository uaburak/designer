// Animated export (docs/motion.md §7), the parts that run without a browser: the frame plan and Ping-pong folding,
// the even padding and flattening, the GIF delays, sampling and the file itself (gifenc in node), the video codec
// choice with its fallbacks and the muxer names, the file names and the Size → scale; round 8e: the Animated tab's
// settings as the layer's exportSettings entry.
import { describe, expect, it } from "vitest";
import type { Pixels } from "@/engine/codec";
import { MAX_FRAMES, flattenOnto, frameTime, padToEven, planFrames, type FrameSource } from "../export/frames";
import { GIF_MAX_FPS, encodeGif, gifDelays, gifFrameIndices, paletteSampleIndices } from "../export/gif";
import { animatedFileName, scaleOf } from "../export/exportAnimated";
import { VIDEO_CODECS, bitrateOf, muxerCodecOf, pickVideoConfig } from "../export/video";
import { entryOf, settingsOf } from "../export/animatedSettings";
import { exportSettingsOf, isAnimatedSetting } from "../../model/exports";

const solid = (w: number, h: number, rgba: [number, number, number, number]): Pixels => {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set(rgba, i * 4);
  return { width: w, height: h, pixels: px };
};

describe("the frame plan", () => {
  it("counts frames over the playback's span, Ping-pong there and back, within the limits", () => {
    expect(planFrames(2_000_000, "LOOP", 30)).toEqual({ fps: 30, rangeUs: 2_000_000, frames: 60, stepUs: 1e6 / 30 });
    expect(planFrames(2_000_000, "ONCE", 24)?.frames).toBe(48);
    expect(planFrames(2_000_000, "PING_PONG", 30)?.frames).toBe(120);
    expect(planFrames(0, "LOOP", 30)).toBeNull();
    expect(planFrames(11 * 60 * 1e6, "LOOP", 30)).toBeNull();
    expect(planFrames((MAX_FRAMES + 1) * (1e6 / 60), "LOOP", 60)).toBeNull();
  });
  it("frame k is at k / fps; Ping-pong folds the way back", () => {
    const plan = planFrames(1_000_000, "PING_PONG", 10)!;
    expect(frameTime(3, plan, 1_000_000, "PING_PONG")).toBe(300_000);
    expect(frameTime(10, plan, 1_000_000, "PING_PONG")).toBe(1_000_000);
    expect(frameTime(13, plan, 1_000_000, "PING_PONG")).toBe(700_000);
    expect(frameTime(19, plan, 1_000_000, "PING_PONG")).toBe(100_000);
    const once = planFrames(1_000_000, "ONCE", 10)!;
    expect(frameTime(12, once, 1_000_000, "ONCE")).toBe(1_000_000);
  });
  it("pads odd sides to even by repeating the edge, flattens alpha on a colour", () => {
    const p = solid(3, 3, [10, 20, 30, 255]);
    p.pixels.set([1, 2, 3, 255], (2 * 3 + 2) * 4); // the bottom-right pixel
    const q = padToEven(p);
    expect([q.width, q.height]).toEqual([4, 4]);
    expect([...q.pixels.subarray((3 * 4 + 3) * 4, (3 * 4 + 3) * 4 + 4)]).toEqual([1, 2, 3, 255]); // the corner repeated
    expect(padToEven(solid(2, 2, [0, 0, 0, 255]))).toEqual(solid(2, 2, [0, 0, 0, 255]));
    const half = flattenOnto(solid(1, 1, [0, 0, 0, 128]), [255, 255, 255]);
    expect([...half.pixels]).toEqual([127, 127, 127, 255]);
  });
});

describe("GIF", () => {
  it("delays carry the rounding: 30 fps alternates 3 and 4 cs and sums to the span; 60 fps is thinned to 50", () => {
    const d = gifDelays(30, 30);
    expect(d.slice(0, 6)).toEqual([3, 4, 3, 3, 4, 3]);
    expect(d.reduce((a, b) => a + b, 0)).toBe(100);
    expect(gifDelays(5, 60)).toEqual([2, 2, 2, 2, 2]);
    expect(gifFrameIndices(120, 60)).toHaveLength(100);
    expect(gifFrameIndices(4, 30)).toEqual([0, 1, 2, 3]);
    expect(GIF_MAX_FPS).toBe(50);
    expect(paletteSampleIndices(100)).toHaveLength(32);
    expect(paletteSampleIndices(5)).toEqual([0, 1, 2, 3, 4]);
  });
  it("writes a looping file with every frame and a global palette; Loop off has no NETSCAPE block", async () => {
    const frames = [solid(4, 4, [255, 0, 0, 255]), solid(4, 4, [0, 255, 0, 255]), solid(4, 4, [0, 0, 255, 255])];
    const source: FrameSource = { width: 4, height: 4, count: 3, at: async (k) => frames[k] };
    const seen: number[] = [];
    const bytes = await encodeGif(source, { fps: 10, loop: true }, (done) => seen.push(done));
    expect(bytes).not.toBeNull();
    const text = Array.from(bytes!.subarray(0, 6), (b) => String.fromCharCode(b)).join("");
    expect(text).toBe("GIF89a");
    expect(seen).toEqual([1, 2, 3]);
    const ascii = Array.from(bytes!, (b) => String.fromCharCode(b)).join("");
    expect(ascii).toContain("NETSCAPE2.0");
    // Three image descriptors (0x2C) each after a graphic control extension (0x21 0xF9).
    let images = 0;
    for (let i = 0; i + 1 < bytes!.length; i++) if (bytes![i] === 0x21 && bytes![i + 1] === 0xf9) images++;
    expect(images).toBe(3);
    const once = await encodeGif(source, { fps: 10, loop: false });
    expect(Array.from(once!, (b) => String.fromCharCode(b)).join("")).not.toContain("NETSCAPE2.0");
    // Cancelled before the end: null.
    const ctl = new AbortController();
    ctl.abort();
    expect(await encodeGif(source, { fps: 10, loop: true }, undefined, ctl.signal)).toBeNull();
  });
});

describe("video", () => {
  it("picks the first codec the device supports, with the H.264 / VP9 fallbacks, and names it for the muxer", async () => {
    const asked: string[] = [];
    const only = (ok: string) => async (c: VideoEncoderConfig) => {
      asked.push(c.codec);
      return c.codec === ok;
    };
    expect((await pickVideoConfig({ format: "MP4", fps: 30, quality: "HIGH" }, 640, 480, only("avc1.42E033")))?.codec).toBe("avc1.42E033");
    expect(asked).toEqual([...VIDEO_CODECS.MP4]);
    const vp9 = await pickVideoConfig({ format: "WEBM", fps: 30, quality: "LOW" }, 640, 480, only("vp09.00.41.08"));
    expect(vp9?.codec).toBe("vp09.00.41.08");
    expect(vp9?.bitrate).toBe(bitrateOf(640, 480, 30, "LOW"));
    expect(await pickVideoConfig({ format: "MP4", fps: 30, quality: "HIGH" }, 640, 480, async () => false)).toBeNull();
    expect(muxerCodecOf("avc1.640033")).toBe("avc");
    expect(muxerCodecOf("vp09.00.41.08")).toBe("V_VP9");
    expect(muxerCodecOf("vp8")).toBe("V_VP8");
    expect(bitrateOf(1920, 1080, 30, "HIGH")).toBe(Math.round(1920 * 1080 * 30 * 0.2));
    expect(bitrateOf(10, 10, 1, "LOW")).toBe(100_000);
  });
});

describe("the job", () => {
  it("names the file by the frame and the format; Size gives the scale", () => {
    expect(animatedFileName("Card", "MP4")).toBe("Card.mp4");
    expect(animatedFileName("", "GIF")).toBe("Animation.gif");
    expect(animatedFileName("Logo", "DOTLOTTIE")).toBe("Logo.lottie");
    expect(scaleOf({ scale: 2 }, 400, 600)).toBe(2);
    expect(scaleOf({ width: 800, height: 0 }, 400, 600)).toBe(2);
    expect(scaleOf({ width: 0, height: 300 }, 400, 600)).toBe(0.5);
    expect(scaleOf({ width: 0, height: 0 }, 400, 600)).toBe(1);
  });
});

describe("the Animated tab's settings on the layer", () => {
  it("round-trip through an exportSettings entry with Figma's Motion fields; the Static rows leave it out", () => {
    const gif = { format: "GIF" as const, size: { scale: 2 }, fps: 24 as const, quality: "MEDIUM" as const, loop: false };
    expect(entryOf(gif)).toEqual({ imageType: "GIF", constraint: { type: "CONTENT_SCALE", value: 2 }, frameRate: 24, loopCount: 1, quality: 0.5 });
    expect(settingsOf(entryOf(gif))).toEqual(gif);
    const svg = { format: "SVG" as const, size: { width: 1080, height: 0 }, fps: 60 as const, quality: "HIGH" as const, loop: true };
    expect(entryOf(svg).svgAnimated).toBe(true);
    expect(settingsOf(entryOf(svg))).toEqual(svg);
    expect(isAnimatedSetting({ imageType: "SVG" })).toBe(false);
    expect(isAnimatedSetting(entryOf(svg))).toBe(true);
    expect(exportSettingsOf({ exportSettings: [{ imageType: "PNG" }, entryOf(gif)] })).toEqual([{ imageType: "PNG" }]);
  });
});
