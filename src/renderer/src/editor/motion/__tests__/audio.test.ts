// Audio on the timeline (docs/motion.md §4.11, §6.6, §7.3; round 8e), the parts that run without Web Audio: the files
// taken, the waveform's peaks and path, a clip's gain and its span from a time, the scheduling on a context, a clip's
// trim limits, the clock following the AudioContext's, and the export's audio codec choice with its fallbacks.
import { describe, expect, it } from "vitest";
import type { TimelineAudioClip, TimelineModel } from "@shared/motion/types";
import { PEAKS_PER_SECOND, clipGain, clipSpans, isAudioFile, peaksOf, scheduleSpans, waveformPath } from "../audio/audio";
import { Clock } from "../clock";
import { AUDIO_CODECS, pickAudioConfig } from "../export/audioTrack";
import { trimAudio } from "../timeline/maths";

const clip = (over: Partial<TimelineAudioClip> = {}): TimelineAudioClip => ({ id: "a1", trackId: "r1", name: "Beat", mediaHash: "h1", offsetUs: 1_000_000, startUs: 500_000, durationUs: 2_000_000, volume: 0.5, mute: false, ...over });
const model = (audio: TimelineAudioClip[], rows: TimelineModel["audioTracks"] = [{ id: "r1", name: "Beat", gain: 1, mute: false }]): Pick<TimelineModel, "audio" | "audioTracks"> => ({ audio, audioTracks: rows });

describe("audio files and waveforms", () => {
  it("takes Figma's formats (AAC, MPA, MP3, WAV) by type or by name", () => {
    expect(isAudioFile({ type: "audio/mpeg" })).toBe(true);
    expect(isAudioFile({ type: "audio/wav" })).toBe(true);
    expect(isAudioFile({ type: "", name: "loop.m4a" })).toBe(true);
    expect(isAudioFile({ type: "", name: "voice.MPA" })).toBe(true);
    expect(isAudioFile({ type: "video/mp4", name: "clip.mp4" })).toBe(false);
    expect(isAudioFile({ type: "image/png" })).toBe(false);
  });
  it("keeps the loudest sample per 10 ms over every channel, and draws a column per pixel of a region", () => {
    const rate = PEAKS_PER_SECOND * 4; // four samples a peak
    const left = new Float32Array([0.1, -0.5, 0.2, 0, 0, 0, 0, 0.25]);
    const right = new Float32Array([0, 0, 0, 0, -0.9, 0, 0, 0]);
    expect([...peaksOf([left, right], rate)]).toEqual([0.5, 0.8999999761581421]);
    const d = waveformPath(new Float32Array([1, 0]), 0, 20_000, 2, 16);
    expect(d).toBe("M0.5 0.0V16.0M1.5 7.5V8.5");
  });
});

describe("a clip's sound", () => {
  it("plays at its volume times its row's gain; muted (itself or its row) it is silent", () => {
    expect(clipGain(clip(), model([]))).toBe(0.5);
    expect(clipGain(clip(), model([], [{ id: "r1", name: "", gain: 0.5, mute: false }]))).toBe(0.25);
    expect(clipGain(clip({ mute: true }), model([]))).toBe(0);
    expect(clipGain(clip(), model([], [{ id: "r1", name: "", gain: 1, mute: true }]))).toBe(0);
  });
  it("from a time: a clip ahead waits, one the playhead is inside starts mid-way, one behind or silent doesn't play", () => {
    const m = model([clip(), clip({ id: "a2", offsetUs: 0, durationUs: 500_000 }), clip({ id: "a3", mute: true })]);
    expect(clipSpans(m, 0, 4_000_000).map((s) => [s.clip.id, s.delayUs, s.offsetUs, s.durationUs])).toEqual([
      ["a1", 1_000_000, 500_000, 2_000_000],
      ["a2", 0, 500_000, 500_000],
    ]);
    expect(clipSpans(m, 1_500_000, 2_500_000).map((s) => [s.clip.id, s.delayUs, s.offsetUs, s.durationUs])).toEqual([["a1", 0, 1_000_000, 1_000_000]]);
  });
  it("schedules a source and a gain per clip on the context, at its delay, from its place in the file", () => {
    const started: [number, number, number][] = [];
    const gains: { gain: { value: number } }[] = [];
    const node = () => ({ connect: (n: unknown) => n });
    const ctx = {
      createBufferSource: () => ({ ...node(), buffer: null, start: (w: number, o: number, d: number) => started.push([w, o, d]) }),
      createGain: () => {
        const g = { ...node(), gain: { value: 1 } };
        gains.push(g);
        return g;
      },
    } as unknown as BaseAudioContext;
    const m = model([clip()]);
    const buffer = { duration: 10 } as AudioBuffer;
    const sources = scheduleSpans(ctx, {} as AudioNode, clipSpans(m, 0, 4_000_000), m, () => buffer, 2);
    expect(sources).toHaveLength(1);
    expect(started).toEqual([[3, 0.5, 2]]);
    expect(gains[0].gain.value).toBe(0.5);
    // A file not decoded yet schedules nothing.
    expect(scheduleSpans(ctx, {} as AudioNode, clipSpans(m, 0, 4_000_000), m, () => null, 0)).toHaveLength(0);
  });
  it("trims within the file: the head no earlier than the file's start, the tail no later than its end, at least a frame", () => {
    const c = clip();
    expect(trimAudio(c, "move", -50, 4_000_000, 1000)).toEqual({ offsetUs: 0 });
    expect(trimAudio(c, "end", 9_000_000, 4_000_000, 1000)).toEqual({ durationUs: 3_500_000 });
    expect(trimAudio(c, "end", 9_000_000, null, 1000)).toEqual({ durationUs: 8_000_000 });
    expect(trimAudio(c, "end", 0, 4_000_000, 1000)).toEqual({ durationUs: 1000 });
    expect(trimAudio(c, "start", 0, 4_000_000, 1000)).toEqual({ offsetUs: 500_000, startUs: 0, durationUs: 2_500_000 });
    expect(trimAudio(c, "start", 1_500_000, 4_000_000, 1000)).toEqual({ offsetUs: 1_500_000, startUs: 1_000_000, durationUs: 1_500_000 });
    expect(trimAudio(c, "start", 9_000_000, 4_000_000, 1000)).toEqual({ offsetUs: 2_999_000, startUs: 2_499_000, durationUs: 1000 });
  });
});

describe("the clock with audio", () => {
  it("follows the master clock while it runs (the AudioContext's), rAF's time otherwise, without a jump at the switch", () => {
    const queue: ((now: number) => void)[] = [];
    let master: number | null = null;
    const times: number[] = [];
    const c = new Clock({
      durationUs: 10_000_000,
      playback: "LOOP",
      onTime: (t) => times.push(t),
      raf: (cb) => queue.push(cb),
      caf: () => void queue.splice(0),
      now: () => 0,
      master: () => master,
    });
    const frame = (ms: number) => queue.splice(0).forEach((cb) => cb(ms));
    c.play(0);
    frame(100); // rAF time: +100 ms
    master = 5000; // the context starts running: this frame starts its interval
    frame(116);
    master = 5250;
    frame(132); // the context's 250 ms, not rAF's 16
    expect(times).toEqual([100_000, 100_000, 350_000]);
  });
});

describe("the export's soundtrack", () => {
  it("MP4 tries AAC then Opus, WebM Opus; nothing the device takes: no audio track", async () => {
    const source = { sampleRate: 48_000, channels: [new Float32Array(4), new Float32Array(4)] };
    expect(AUDIO_CODECS.MP4.map((c) => c.codec)).toEqual(["mp4a.40.2", "opus"]);
    const aac = await pickAudioConfig("MP4", source, async () => true);
    expect(aac).toEqual({ config: { codec: "mp4a.40.2", sampleRate: 48_000, numberOfChannels: 2, bitrate: 128_000 }, muxer: "aac" });
    const opus = await pickAudioConfig("MP4", source, async (c) => c.codec === "opus");
    expect(opus?.muxer).toBe("opus");
    expect((await pickAudioConfig("WEBM", source, async () => true))?.muxer).toBe("A_OPUS");
    expect(await pickAudioConfig("WEBM", source, async () => false)).toBeNull();
  });
});
