/**
 * A generated sound as a WAV file (RIFF, 16-bit PCM, little-endian) — what generate_sound stores in the file's image
 * store, as a dropped WAV is (docs/motion.md §6.6); Chromium's decodeAudioData reads it back when the file opens again.
 */
import type { Pcm } from "./dsp";

export function encodeWav(p: Pcm): Uint8Array {
  const channels = p.channels.length;
  const frames = p.channels[0].length;
  const dataBytes = frames * channels * 2;
  const out = new Uint8Array(44 + dataBytes);
  const v = new DataView(out.buffer);
  const str = (at: number, s: string) => [...s].forEach((ch, i) => (out[at + i] = ch.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, p.sampleRate, true);
  v.setUint32(28, p.sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, p.channels[c][i]));
      v.setInt16(o, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
      o += 2;
    }
  return out;
}

/** A 16-bit PCM WAV's samples back (tests, and the mix check before a file is decoded); null when it isn't one. */
export function decodeWav(bytes: Uint8Array): Pcm | null {
  if (bytes.length < 44) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let at = 12;
  let channels = 0, rate = 0, bits = 0;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = v.getUint32(at + 4, true);
    if (id === "fmt ") {
      if (v.getUint16(at + 8, true) !== 1) return null;
      channels = v.getUint16(at + 10, true);
      rate = v.getUint32(at + 12, true);
      bits = v.getUint16(at + 22, true);
    } else if (id === "data") {
      if (bits !== 16 || channels < 1) return null;
      const frames = Math.floor(Math.min(size, bytes.length - at - 8) / (2 * channels));
      const out = [new Float32Array(frames), new Float32Array(frames)] as [Float32Array, Float32Array];
      for (let i = 0; i < frames; i++)
        for (let c = 0; c < channels; c++) {
          const s = v.getInt16(at + 8 + (i * channels + c) * 2, true) / 32768;
          if (c < 2) out[c][i] = s;
          if (channels === 1) out[1][i] = s;
        }
      return { sampleRate: rate, channels: out };
    }
    at += 8 + size + (size & 1);
  }
  return null;
}
