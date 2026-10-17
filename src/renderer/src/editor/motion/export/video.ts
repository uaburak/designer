/**
 * MP4 / WebM export (docs/motion.md §7.3) with WebCodecs: a VideoEncoder per export — H.264 High 5.1 (`avc1.640033`,
 * fallback Baseline `avc1.42E033`) muxed by mp4-muxer, VP9 (`vp09.00.41.08`, fallback VP8) by webm-muxer —, variable
 * bitrate from the Quality setting (0.05 / 0.1 / 0.2 bits per pixel per frame), a key frame every 2 s, hardware
 * preferred, back-pressure on the encode queue. Audio tracks come with the audio increment (§7.3's AudioEncoder part).
 */
import { ArrayBufferTarget as Mp4Target, Muxer as Mp4Muxer } from "mp4-muxer";
import { ArrayBufferTarget as WebmTarget, Muxer as WebmMuxer } from "webm-muxer";
import type { AnimatedExportSettings } from "@shared/motion/types";
import { flattenOnto, padToEven, type FrameSource } from "./frames";

export type VideoFormat = "MP4" | "WEBM";

/** The codecs tried in order per container. */
export const VIDEO_CODECS: Record<VideoFormat, readonly string[]> = {
  MP4: ["avc1.640033", "avc1.42E033"],
  WEBM: ["vp09.00.41.08", "vp8"],
};
/** Bits per pixel per frame by quality [ours]. */
export const BITS_PER_PIXEL: Record<AnimatedExportSettings["quality"], number> = { LOW: 0.05, MEDIUM: 0.1, HIGH: 0.2 };
/** H.264 level 5.2's ceiling and ours for every video format. */
export const MAX_VIDEO_SIDE = 4096;
const KEYFRAME_EVERY_S = 2;
const QUEUE_LIMIT = 4;

export const bitrateOf = (width: number, height: number, fps: number, quality: AnimatedExportSettings["quality"]): number => Math.max(100_000, Math.round(width * height * fps * BITS_PER_PIXEL[quality]));

export interface VideoOptions {
  format: VideoFormat;
  fps: number;
  quality: AnimatedExportSettings["quality"];
}

export type ConfigSupport = (config: VideoEncoderConfig) => Promise<boolean>;

const defaultSupport: ConfigSupport = async (config) => {
  if (typeof VideoEncoder === "undefined") return false;
  try {
    return (await VideoEncoder.isConfigSupported(config)).supported === true;
  } catch {
    return false;
  }
};

/** The encoder configuration for a size and rate: the first codec the device takes (null: none). */
export async function pickVideoConfig(opts: VideoOptions, width: number, height: number, support: ConfigSupport = defaultSupport): Promise<VideoEncoderConfig | null> {
  for (const codec of VIDEO_CODECS[opts.format]) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate: bitrateOf(width, height, opts.fps, opts.quality),
      framerate: opts.fps,
      bitrateMode: "variable",
      latencyMode: "quality",
      hardwareAcceleration: "prefer-hardware",
      ...(codec.startsWith("avc1") ? { avc: { format: "avc" } } : {}),
    };
    if (await support(config)) return config;
  }
  return null;
}

/** What the file's muxer calls the codec. */
export function muxerCodecOf(codec: string): "avc" | "V_VP9" | "V_VP8" {
  if (codec.startsWith("avc1")) return "avc";
  return codec.startsWith("vp09") ? "V_VP9" : "V_VP8";
}

export class VideoExportError extends Error {
  constructor(message: string, readonly code: "unsupported" | "cancelled" | "frame" | "encoder") {
    super(message);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Encodes every frame of `source` (padded to even sides, flattened on white) to an MP4 or WebM file. */
export async function encodeVideo(source: FrameSource, opts: VideoOptions, onProgress?: (done: number, total: number) => void, signal?: AbortSignal, support?: ConfigSupport): Promise<Uint8Array> {
  const width = Math.min(MAX_VIDEO_SIDE, source.width + (source.width % 2));
  const height = Math.min(MAX_VIDEO_SIDE, source.height + (source.height % 2));
  const config = await pickVideoConfig(opts, width, height, support);
  if (!config) throw new VideoExportError("This format isn't supported on this device", "unsupported");
  const codec = muxerCodecOf(config.codec);
  const mp4 = opts.format === "MP4";
  const mp4Target = mp4 ? new Mp4Target() : null;
  const webmTarget = mp4 ? null : new WebmTarget();
  const mp4Muxer = mp4Target ? new Mp4Muxer({ target: mp4Target, video: { codec: "avc", width, height, frameRate: opts.fps }, fastStart: "in-memory" }) : null;
  const webmMuxer = webmTarget ? new WebmMuxer({ target: webmTarget, video: { codec: codec === "avc" ? "V_VP9" : codec, width, height, frameRate: opts.fps } }) : null;
  let failure: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (mp4Muxer) mp4Muxer.addVideoChunk(chunk, meta);
      else webmMuxer!.addVideoChunk(chunk, meta);
    },
    error: (e) => {
      failure = e;
    },
  });
  encoder.configure(config);
  const stepUs = 1e6 / opts.fps;
  const keyEvery = Math.max(1, Math.round(opts.fps * KEYFRAME_EVERY_S));
  try {
    for (let k = 0; k < source.count; k++) {
      if (signal?.aborted) throw new VideoExportError("Cancelled", "cancelled");
      if (failure) throw new VideoExportError(String((failure as Error).message), "encoder");
      const raw = await source.at(k);
      if (!raw) throw new VideoExportError("Couldn't draw a frame", "frame");
      const p = padToEven(flattenOnto({ ...raw, pixels: raw.pixels.slice() }, [255, 255, 255]));
      const frame = new VideoFrame(p.pixels, { format: "RGBA", codedWidth: p.width, codedHeight: p.height, timestamp: Math.round(k * stepUs), duration: Math.round(stepUs) });
      while (encoder.encodeQueueSize > QUEUE_LIMIT && !signal?.aborted) await sleep(4);
      encoder.encode(frame, { keyFrame: k % keyEvery === 0 });
      frame.close();
      onProgress?.(k + 1, source.count);
    }
    await encoder.flush();
    if (failure) throw new VideoExportError(String((failure as Error).message), "encoder");
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
  if (mp4Muxer) {
    mp4Muxer.finalize();
    return new Uint8Array(mp4Target!.buffer);
  }
  webmMuxer!.finalize();
  return new Uint8Array(webmTarget!.buffer);
}
