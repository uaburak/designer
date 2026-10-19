/**
 * The soundtrack of an MP4 / WebM export (docs/motion.md §7.3; round 8e): the timeline's clips mixed offline at 48 kHz
 * stereo (audio/audio.ts `mixAudio`) and encoded with WebCodecs' AudioEncoder — MP4: AAC-LC `mp4a.40.2` at 128 kb/s
 * when the device takes it, else Opus (mp4-muxer writes both); WebM: Opus 128 kb/s. No audible clip, or no codec the
 * device takes: no audio track (the video is exported all the same).
 */
import type { VideoFormat } from "./video";

/** The mixed soundtrack: planar channels at a sample rate (an AudioBuffer's, or a test's). */
export interface AudioTrackSource {
  sampleRate: number;
  channels: Float32Array[];
}

/** The codecs tried in order per container, with the muxer's name for each. */
export const AUDIO_CODECS: Record<VideoFormat, readonly { codec: string; muxer: "aac" | "opus" | "A_OPUS" }[]> = {
  MP4: [
    { codec: "mp4a.40.2", muxer: "aac" },
    { codec: "opus", muxer: "opus" },
  ],
  WEBM: [{ codec: "opus", muxer: "A_OPUS" }],
};
export const AUDIO_BITRATE = 128_000;
/** Frames per AudioData handed to the encoder (~21 ms at 48 kHz). */
const CHUNK_FRAMES = 1024;

export type AudioConfigSupport = (config: AudioEncoderConfig) => Promise<boolean>;

const defaultSupport: AudioConfigSupport = async (config) => {
  if (typeof AudioEncoder === "undefined") return false;
  try {
    return (await AudioEncoder.isConfigSupported(config)).supported === true;
  } catch {
    return false;
  }
};

/** The first codec the device takes for the container (null: none). */
export async function pickAudioConfig(format: VideoFormat, source: AudioTrackSource, support: AudioConfigSupport = defaultSupport): Promise<{ config: AudioEncoderConfig; muxer: "aac" | "opus" | "A_OPUS" } | null> {
  for (const c of AUDIO_CODECS[format]) {
    const config: AudioEncoderConfig = { codec: c.codec, sampleRate: source.sampleRate, numberOfChannels: source.channels.length, bitrate: AUDIO_BITRATE };
    if (await support(config)) return { config, muxer: c.muxer };
  }
  return null;
}

/** An AudioBuffer as a track source (its channels copied out). */
export const audioBufferSource = (b: AudioBuffer): AudioTrackSource => ({ sampleRate: b.sampleRate, channels: Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i).slice()) });

/** Encodes the whole source, handing each chunk to `onChunk` (the muxer) in order. */
export async function encodeAudio(source: AudioTrackSource, config: AudioEncoderConfig, onChunk: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void, signal?: AbortSignal): Promise<void> {
  let failure: Error | null = null;
  const encoder = new AudioEncoder({ output: (chunk, meta) => onChunk(chunk, meta), error: (e) => (failure = e) });
  encoder.configure(config);
  const channels = source.channels.length;
  const length = source.channels[0]?.length ?? 0;
  try {
    for (let at = 0; at < length; at += CHUNK_FRAMES) {
      if (signal?.aborted || failure) break;
      const frames = Math.min(CHUNK_FRAMES, length - at);
      // f32-planar: each channel's frames one after the other.
      const data = new Float32Array(frames * channels);
      for (let c = 0; c < channels; c++) data.set(source.channels[c].subarray(at, at + frames), c * frames);
      const chunk = new AudioData({ format: "f32-planar", sampleRate: source.sampleRate, numberOfFrames: frames, numberOfChannels: channels, timestamp: Math.round((at / source.sampleRate) * 1e6), data });
      encoder.encode(chunk);
      chunk.close();
    }
    await encoder.flush();
    if (failure) throw failure;
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
}
