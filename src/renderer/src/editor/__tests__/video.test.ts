// Video in the editor and the presentation view as plain data (help.figma.com 8878274530455 "Use videos in
// prototypes", 360040035874 "Prototype actions", 360040318013 "Play your prototypes"): video files and paints, the
// video triggers and actions in Figma's words, their times, and the presentation view's options.
import { describe, expect, it } from "vitest";
import { isMediaFile, isVideoFile, MAX_VIDEO_BYTES } from "../images";
import { DEFAULT_VIDEO_PLAYBACK, fromPicker, hashHex, mediaPaint, paintLabel, paintVideoHash, toPicker, videoPaint } from "../model/paints";
import {
  MEDIA_CHOICES,
  VIDEO_ACTIONS,
  VIDEO_TRIGGERS,
  actionKind,
  actionLabel,
  actionOfKind,
  formatMediaTime,
  interactionSummary,
  mediaKind,
  parseMediaTime,
  triggerLabel,
  withTrigger,
} from "../model/prototype";
import { deviceName, deviceOptions, presentOptions, recommendedScales, PRESENT_SHORTCUTS } from "@/present/PresentationView";
import { sniffVideoMime } from "@/present/presentationVideos";
import type { PresentState } from "@/engine/Engine";

const POSTER = "ffeeddccbbaa99887766554433221100ffeeddcc";
const VIDEO = "00112233445566778899aabbccddeeff00112233";

describe("video files and paints", () => {
  it("takes .mp4, .mov and .webm (Figma's formats), up to 300 MB", () => {
    expect(isVideoFile({ type: "video/mp4" })).toBe(true);
    expect(isVideoFile({ type: "video/quicktime" })).toBe(true);
    expect(isVideoFile({ type: "video/webm" })).toBe(true);
    expect(isVideoFile({ type: "", name: "clip.MOV" })).toBe(true);
    expect(isVideoFile({ type: "video/x-msvideo" })).toBe(false);
    expect(isMediaFile({ type: "image/png" })).toBe(true);
    expect(isMediaFile({ type: "application/pdf" })).toBe(false);
    expect(MAX_VIDEO_BYTES).toBe(300 * 1024 * 1024);
  });

  it("sniffs a video's type from its bytes", () => {
    const mp4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const mov = new Uint8Array([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]);
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sniffVideoMime(mp4)).toBe("video/mp4");
    expect(sniffVideoMime(mov)).toBe("video/quicktime");
    expect(sniffVideoMime(webm)).toBe("video/webm");
    expect(sniffVideoMime(new Uint8Array(12))).toBe("");
  });

  it("a VIDEO paint holds the video and its poster frame; the picker edits it as an image and keeps it a video", () => {
    const p = videoPaint(VIDEO, { hash: POSTER, width: 1920, height: 1080 }, "Clip");
    expect(p.type).toBe("VIDEO");
    expect(hashHex(p.image?.hash)).toBe(POSTER);
    expect(paintVideoHash(p)).toBe(VIDEO);
    expect(p.imageScaleMode).toBe("FILL");
    expect(p.originalImageWidth).toBe(1920);
    expect(paintLabel(p)).toBe("Video");
    expect(mediaPaint({ hash: POSTER, width: 10, height: 10, video: VIDEO }).type).toBe("VIDEO");
    expect(mediaPaint({ hash: POSTER, width: 10, height: 10 }).type).toBe("IMAGE");
    const picked = toPicker(p);
    expect(picked.type).toBe("IMAGE");
    const fit = fromPicker(p, { ...picked, imageScaleMode: "FIT" });
    expect(fit.type).toBe("VIDEO");
    expect(fit.imageScaleMode).toBe("FIT");
    expect(paintVideoHash(fit)).toBe(VIDEO);
    // Another type: no longer a video.
    const solid = fromPicker(p, { type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1 });
    expect(solid.type).toBe("SOLID");
    expect((solid as { video?: unknown }).video).toBeUndefined();
    expect(DEFAULT_VIDEO_PLAYBACK).toEqual({ autoplay: true, mediaLoop: true, muted: false });
  });
});

describe("video triggers and actions", () => {
  it("uses Figma's words", () => {
    expect(VIDEO_TRIGGERS.map((t) => t.label)).toEqual(["When video hits", "When video ends"]);
    expect(triggerLabel("ON_MEDIA_END")).toBe("When video ends");
    expect(VIDEO_ACTIONS.map((a) => a.label)).toEqual(["Play/pause video", "Mute/unmute video", "Set to specific time", "Jump forward/backward in time"]);
    expect(MEDIA_CHOICES.VIDEO_PLAY!.map((c) => c.label)).toEqual(["Play video", "Pause video", "Toggle play/pause"]);
    expect(MEDIA_CHOICES.VIDEO_SOUND!.map((c) => c.label)).toEqual(["Mute video", "Unmute video", "Toggle mute/unmute"]);
    expect(MEDIA_CHOICES.VIDEO_JUMP!.map((c) => c.label)).toEqual(["Jump forward", "Jump backward"]);
    expect(actionLabel("VIDEO_SET_TIME")).toBe("Set to specific time");
  });

  it("maps the schema's UPDATE_MEDIA_RUNTIME to the panel's actions and back", () => {
    expect(mediaKind("TOGGLE_MUTE_UNMUTE")).toBe("VIDEO_SOUND");
    expect(actionKind({ connectionType: "UPDATE_MEDIA_RUNTIME", mediaAction: "SKIP_BACKWARD" })).toBe("VIDEO_JUMP");
    expect(actionKind({ connectionType: "UPDATE_MEDIA_RUNTIME" })).toBe("VIDEO_PLAY");
    const prev = { connectionType: "UPDATE_MEDIA_RUNTIME" as const, transitionNodeID: { sessionID: 1, localID: 9 }, mediaAction: "PLAY" as const };
    expect(actionOfKind("VIDEO_JUMP", prev)).toEqual({ connectionType: "UPDATE_MEDIA_RUNTIME", transitionNodeID: { sessionID: 1, localID: 9 }, mediaAction: "SKIP_FORWARD", mediaSkipByAmount: 5 });
    expect(actionOfKind("VIDEO_SET_TIME", {})).toEqual({ connectionType: "UPDATE_MEDIA_RUNTIME", mediaAction: "SKIP_TO", mediaSkipToTime: 0 });
  });

  it("times read and write as m:ss", () => {
    expect(formatMediaTime(5)).toBe("0:05");
    expect(formatMediaTime(65)).toBe("1:05");
    expect(formatMediaTime(3.5)).toBe("0:03.5");
    expect(parseMediaTime("1:05")).toBe(65);
    expect(parseMediaTime("12")).toBe(12);
    expect(parseMediaTime("0:03.5")).toBe(3.5);
    expect(parseMediaTime("soon")).toBeNull();
  });

  it("rows read as Figma's", () => {
    const hit = withTrigger({ event: { interactionType: "ON_CLICK" }, actions: [{ connectionType: "UPDATE_MEDIA_RUNTIME", mediaAction: "SKIP_FORWARD", mediaSkipByAmount: 10 }] }, "ON_MEDIA_HIT");
    expect(hit.event?.mediaHitTime).toBe(0);
    hit.event!.mediaHitTime = 12;
    expect(interactionSummary(hit, () => null)).toEqual({ trigger: "When video hits 0:12", action: "Jump forward 10s" });
    expect(withTrigger(hit, "ON_CLICK").event?.mediaHitTime).toBeUndefined();
  });
});

describe("the presentation view's options", () => {
  const state = (s: Partial<PresentState>): PresentState => ({ active: true, events: [], ...s });
  const labels = (entries: ReturnType<typeof presentOptions>) => entries.map((e) => (e === "-" ? "-" : "header" in e ? `# ${e.header}` : e.label));

  it("lists Figma's options, the recommended scales first (help's table)", () => {
    expect(recommendedScales(state({ firstFrameWidth: 1440 }))).toEqual(["ACTUAL", "RESPONSIVE"]);
    expect(recommendedScales(state({ firstFrameWidth: 375 }))).toEqual(["ACTUAL", "FIT"]);
    expect(recommendedScales(state({ allWide: true }))).toEqual(["FILL", "ACTUAL"]);
    expect(recommendedScales(state({ deviceType: "CUSTOM" }))).toEqual(["FIT", "FILL", "ACTUAL"]);
    expect(labels(presentOptions(state({ firstFrameWidth: 375, scale: "ACTUAL" })))).toEqual([
      "Enable Figma shortcuts",
      "Show hints on click",
      "Show sidebar",
      "Hide UI",
      "-",
      "# Recommended",
      "Actual size (100%)",
      "Fit width and height",
      "# Other",
      "Responsive",
      "Fit width",
      "Fill screen",
      "-",
      "Keyboard shortcuts",
    ]);
  });

  it("with a device: Responsive / Fixed size in the options, the device's scaling in the device menu", () => {
    const s = state({ device: true, deviceType: "PRESET", devicePreset: "IPHONE_16_PRO", hasDeviceFrame: true, deviceFrame: true, scale: "FIT", responsive: false });
    const options = labels(presentOptions(s));
    expect(options).toContain("Fixed size");
    expect(options).not.toContain("Fit device on screen");
    expect(labels(deviceOptions(s))).toEqual(["Fit device on screen", "Zoom device to fill screen", "Show device at 100%", "-", "Show device frame"]);
    expect(deviceName("IPHONE_16_PRO")).toBe("iPhone 16 Pro");
    expect(deviceName("MACBOOK_PRO_14")).toBe("MacBook Pro 14");
    expect(PRESENT_SHORTCUTS.find((k) => k.label === "Next frame")?.keys).toEqual(["→", "Space", "N"]);
  });
});
