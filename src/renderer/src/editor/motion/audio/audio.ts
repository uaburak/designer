/**
 * Audio on the timeline (docs/motion.md §4.11, §6.6; round 8e): files Figma takes (AAC, MPA, MP3, WAV) stored in the
 * file's image store by SHA-1, as videos are, and added to a timeline root as a clip on a row of its own
 * (MOTION_ADD_AUDIO); decoded once per hash (`decodeAudioData`) for the waveform's peaks, the playback and the export's
 * mix. The engine only stores the clips: the scheduling here is shared by the editor's playback (AudioPlayer, against
 * an AudioContext) and the MP4 / WebM export's mix (`mixAudio`, an OfflineAudioContext at 48 kHz stereo).
 *
 * Volume and mute are the clip's times its row's (gain, mute). Scrubbing plays nothing [unverified]; Ping-pong plays
 * no audio (Figma disables it with audio, §6.2).
 */
import { showToast } from "@/ds";
import { t } from "@/i18n";
import type { GuidString, Micros, TimelineAudioClip, TimelineModel } from "@shared/motion/types";
import type { EditorController } from "../../controller";
import { motionRead } from "../motionState";

/** Audio Figma takes (help.figma.com 43825294171927: AAC, MPA, MP3, WAV). */
const AUDIO_TYPES = /^audio\/(aac|x-aac|mp4|x-m4a|m4a|mpeg|mp3|x-mpeg|mpa|wav|x-wav|wave|vnd\.wave)$/;
const AUDIO_EXTENSIONS = /\.(aac|m4a|mpa|mp2|mp3|wav)$/i;
export const isAudioFile = (f: { type: string; name?: string }) => AUDIO_TYPES.test(f.type) || AUDIO_EXTENSIONS.test(f.name ?? "");
export const AUDIO_ACCEPT = ".aac,.m4a,.mpa,.mp2,.mp3,.wav,audio/aac,audio/mp4,audio/mpeg,audio/wav";
/** The largest audio file taken [ours]. */
export const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
/** Peaks per second of audio (the waveform's resolution). */
export const PEAKS_PER_SECOND = 100;
/** The export's mix (docs/motion.md §7.3). */
export const MIX_SAMPLE_RATE = 48_000;

/** A clip's file name without its extension (the row's name, as layers drop theirs). */
export const audioName = (fileName: string | undefined) => (fileName ?? "").replace(/\.[a-z0-9]+$/i, "").trim() || t("Audio");

/** The largest |sample| over each 1 / PEAKS_PER_SECOND of the channels: the waveform. */
export function peaksOf(channels: readonly Float32Array[], sampleRate: number): Float32Array {
  const length = channels[0]?.length ?? 0;
  const step = Math.max(1, Math.round(sampleRate / PEAKS_PER_SECOND));
  const out = new Float32Array(Math.ceil(length / step));
  for (const ch of channels)
    for (let i = 0; i < out.length; i++) {
      let peak = out[i];
      const end = Math.min(length, (i + 1) * step);
      for (let s = i * step; s < end; s++) {
        const v = Math.abs(ch[s]);
        if (v > peak) peak = v;
      }
      out[i] = peak;
    }
  return out;
}

/**
 * A region's waveform as a path over `width` × `height`: per pixel column, the loudest peak it covers, symmetric about
 * the middle (the timeline's audio clips).
 */
export function waveformPath(peaks: Float32Array, startUs: Micros, durationUs: Micros, width: number, height: number): string {
  const cols = Math.max(1, Math.min(4000, Math.floor(width)));
  const mid = height / 2;
  let d = "";
  for (let x = 0; x < cols; x++) {
    const a = Math.floor(((startUs + (x / cols) * durationUs) / 1e6) * PEAKS_PER_SECOND);
    const b = Math.max(a + 1, Math.floor(((startUs + ((x + 1) / cols) * durationUs) / 1e6) * PEAKS_PER_SECOND));
    let peak = 0;
    for (let i = a; i < b && i < peaks.length; i++) peak = Math.max(peak, peaks[i]);
    const h = Math.max(0.5, peak * mid);
    d += `M${x + 0.5} ${(mid - h).toFixed(1)}V${(mid + h).toFixed(1)}`;
  }
  return d;
}

/** A clip's audible gain: its volume times its row's gain, 0 when either is muted. */
export function clipGain(clip: TimelineAudioClip, model: Pick<TimelineModel, "audioTracks">): number {
  const row = model.audioTracks.find((r) => r.id === clip.trackId);
  if (clip.mute || row?.mute) return 0;
  return clip.volume * (row?.gain ?? 1);
}

/** What one clip plays from `fromUs` of the timeline: where in the file, for how long, after how long (µs). */
export interface ClipSpan {
  clip: TimelineAudioClip;
  /** From the start of the scheduling (`fromUs`) to the clip's first sample */
  delayUs: Micros;
  /** Into the file */
  offsetUs: Micros;
  durationUs: Micros;
}

/** The audible clips' spans over [fromUs, toUs) of the timeline (a clip the playhead is inside starts mid-way). */
export function clipSpans(model: Pick<TimelineModel, "audio" | "audioTracks">, fromUs: Micros, toUs: Micros): ClipSpan[] {
  const out: ClipSpan[] = [];
  for (const clip of model.audio) {
    if (clipGain(clip, model) <= 0) continue;
    const start = Math.max(fromUs, clip.offsetUs);
    const end = Math.min(toUs, clip.offsetUs + clip.durationUs);
    if (end <= start) continue;
    out.push({ clip, delayUs: start - fromUs, offsetUs: clip.startUs + (start - clip.offsetUs), durationUs: end - start });
  }
  return out;
}

/** Schedules the spans on `ctx` at its time `when` (s): a source and a gain per clip. The sources, to stop. */
export function scheduleSpans(ctx: BaseAudioContext, destination: AudioNode, spans: readonly ClipSpan[], model: Pick<TimelineModel, "audioTracks">, buffers: (hash: string) => AudioBuffer | null, when: number): AudioBufferSourceNode[] {
  const sources: AudioBufferSourceNode[] = [];
  for (const s of spans) {
    const buffer = buffers(s.clip.mediaHash);
    if (!buffer) continue;
    const offset = s.offsetUs / 1e6;
    if (offset >= buffer.duration) continue;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = clipGain(s.clip, model);
    src.connect(gain).connect(destination);
    src.start(when + s.delayUs / 1e6, offset, Math.min(s.durationUs / 1e6, buffer.duration - offset));
    sources.push(src);
  }
  return sources;
}

/**
 * One editor's decoded audio: the buffers and peaks per hash, read from the store once. A shared AudioContext decodes
 * and plays; `version` bumps when a file arrives (the waveforms draw again).
 */
export class AudioLibrary {
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly peaks = new Map<string, Float32Array>();
  /** Samples a generated sound handed over (generate_sound, motion/sound/): no decode needed, and node's tests have no AudioContext */
  private readonly pcm = new Map<string, { sampleRate: number; channels: Float32Array[] }>();
  private readonly loading = new Map<string, Promise<AudioBuffer | null>>();
  private readonly listeners = new Set<() => void>();
  private ctx: AudioContext | null = null;
  version = 0;

  constructor(private readonly ed: EditorController) {}

  /** The playback context (made on first use; null where Web Audio is missing). */
  context(): AudioContext | null {
    if (!this.ctx && typeof AudioContext !== "undefined") this.ctx = new AudioContext({ latencyHint: "interactive" });
    return this.ctx;
  }

  buffer(hash: string): AudioBuffer | null {
    return this.buffers.get(hash) ?? null;
  }
  peaksOf(hash: string): Float32Array | null {
    return this.peaks.get(hash) ?? null;
  }

  /** A file's samples: a generated sound's, or the decoded buffer's channels (null: not here yet). */
  samplesOf(hash: string): { sampleRate: number; channels: Float32Array[] } | null {
    const own = this.pcm.get(hash);
    if (own) return own;
    const b = this.buffers.get(hash);
    return b ? { sampleRate: b.sampleRate, channels: Array.from({ length: Math.max(2, b.numberOfChannels) }, (_, i) => b.getChannelData(Math.min(i, b.numberOfChannels - 1))) } : null;
  }

  /**
   * A sound made here (generate_sound): its samples kept as they are, its peaks drawn, and an AudioBuffer made from them
   * where Web Audio exists (playback and the export's mix), so the stored WAV needn't be decoded again in this session.
   */
  adopt(hash: string, sound: { sampleRate: number; channels: Float32Array[] }): void {
    this.pcm.set(hash, sound);
    this.peaks.set(hash, peaksOf(sound.channels, sound.sampleRate));
    if (!this.buffers.has(hash) && typeof AudioBuffer !== "undefined") {
      try {
        const buffer = new AudioBuffer({ numberOfChannels: sound.channels.length, length: sound.channels[0].length, sampleRate: sound.sampleRate });
        sound.channels.forEach((ch, i) => buffer.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
        this.buffers.set(hash, buffer);
      } catch {
        // No Web Audio here: the samples are enough for the mix check.
      }
    }
    this.version++;
    this.listeners.forEach((l) => l());
  }

  /** Decodes `bytes` for `hash` (an import already has them), keeping the buffer and its peaks. */
  async decode(hash: string, bytes: Uint8Array): Promise<AudioBuffer | null> {
    const have = this.buffers.get(hash);
    if (have) return have;
    const ctx = this.context();
    if (!ctx) return null;
    try {
      const buffer = await ctx.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
      this.buffers.set(hash, buffer);
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
      this.peaks.set(hash, peaksOf(channels, buffer.sampleRate));
      this.version++;
      this.listeners.forEach((l) => l());
      return buffer;
    } catch {
      return null;
    }
  }

  /** The decoded file of `hash`, from the store once (null: missing or undecodable). */
  load(hash: string): Promise<AudioBuffer | null> {
    const have = this.buffers.get(hash);
    if (have) return Promise.resolve(have);
    let p = this.loading.get(hash);
    if (!p) {
      p = this.ed.images.bytes(hash).then((bytes) => (bytes ? this.decode(hash, bytes) : null));
      this.loading.set(hash, p);
    }
    return p;
  }

  /** Every file the model's clips play, decoded. */
  async loadAll(model: Pick<TimelineModel, "audio">): Promise<void> {
    await Promise.all([...new Set(model.audio.map((c) => c.mediaHash))].map((h) => this.load(h)));
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  getVersion = (): number => this.version;

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}

const libraries = new WeakMap<EditorController, AudioLibrary>();

/** The editor's audio library. */
export function audioLibrary(ed: EditorController): AudioLibrary {
  let lib = libraries.get(ed);
  if (!lib) libraries.set(ed, (lib = new AudioLibrary(ed)));
  return lib;
}

/** Files dropped or picked: stored, decoded and added to `root` at `offsetUs` (one undo step); the error to toast. */
export async function importAudioFiles(ed: EditorController, files: readonly (Blob & { name?: string })[], root: GuidString, offsetUs: Micros): Promise<{ added: GuidString[]; error?: string }> {
  const store = ed.images.store;
  const lib = audioLibrary(ed);
  const ready: { hash: string; name: string; durationUs: Micros }[] = [];
  let error: string | undefined;
  for (const f of files) {
    if (f.size > MAX_AUDIO_BYTES) {
      error = t("Audio files can be up to 100 MB");
      continue;
    }
    const bytes = new Uint8Array(await f.arrayBuffer());
    const hash = store ? await store.put(bytes, f.type || "audio/mpeg") : null;
    const buffer = hash ? await lib.decode(hash, bytes) : null;
    if (!hash || !buffer) {
      error = t("Couldn't add audio");
      continue;
    }
    ready.push({ hash, name: audioName(f.name), durationUs: Math.round(buffer.duration * 1e6) });
  }
  const added: GuidString[] = [];
  if (!ready.length || ed.engine.destroyed) return { added, error };
  ed.engine.txnBegin("Add audio");
  try {
    for (const r of ready) {
      const res = ed.engine.runMotionCommandCreating("MOTION_ADD_AUDIO", { root, mediaHash: r.hash, name: r.name, offsetUs, durationUs: r.durationUs });
      added.push(...res.created);
    }
  } finally {
    ed.engine.txnCommit();
  }
  return { added, error };
}

/**
 * Audio files dropped on the canvas in Motion mode (help: "drop onto a frame or the timeline"): added to the timeline
 * root under the drop point (else the selection's) at the playhead. False when nothing took them (not Motion, no root).
 */
export function dropAudioOnCanvas(ed: EditorController, files: readonly File[], at: { x: number; y: number }): boolean {
  const audio = files.filter(isAudioFile);
  if (!audio.length || ed.ui.get().mode !== "motion") return false;
  const hit = motionRead(() => ed.engine.hitTest(at.x, at.y), []);
  const model = (hit.length ? motionRead(() => ed.engine.motionTimeline(hit[0]), null) : null) ?? motionRead(() => ed.engine.motionTimeline(), null);
  if (!model) return false;
  void importAudioFiles(ed, audio, model.root, ed.ui.get().motion?.timeUs ?? 0).then((r) => {
    if (r.error) showToast({ message: r.error, kind: "error" });
  });
  return true;
}

/**
 * The editor's playback (docs/motion.md §6.6): while the clock plays, the clips under the playhead are scheduled on the
 * AudioContext from where the playhead is, and again whenever it jumps (a loop's wrap, a seek while playing); pausing
 * stops them. The context's clock is the editor's clock while audio plays (`masterMs`), so picture and sound agree.
 */
export class AudioPlayer {
  private sources: AudioBufferSourceNode[] = [];
  private startCtx = 0;
  private startUs = 0;
  private running = false;
  /** Clips scheduled before their file was decoded (scheduled again once it is) */
  private missing = false;
  /** The timeline's model (MotionMode sets it; a change while playing schedules again) */
  private model: TimelineModel | null = null;

  constructor(private readonly lib: AudioLibrary) {}

  /** The context's clock (ms) while audio plays: the editor's clock follows it (Clock's `master`); null otherwise. */
  masterMs = (): number | null => {
    const ctx = this.running ? this.lib.context() : null;
    return ctx && ctx.state === "running" ? ctx.currentTime * 1000 : null;
  };

  /** Whether `model` plays any audio (the clock then follows the context). */
  static audible(model: TimelineModel | null): boolean {
    return !!model && model.playback !== "PING_PONG" && model.audio.some((c) => clipGain(c, model) > 0);
  }

  /** The timeline's model; while playing, its clips are scheduled again from where the sound is. */
  setModel(model: TimelineModel | null): void {
    if (model === this.model) return;
    this.model = model;
    if (model?.audio.length) void this.lib.loadAll(model);
    if (this.running) this.start(this.playedUs());
  }

  /** Starts (or restarts) the sound from `timeUs`; the context is resumed first (a click's gesture allows it). */
  start(timeUs: Micros): void {
    this.stop();
    const model = this.model;
    const ctx = this.lib.context();
    if (!ctx || !model || !AudioPlayer.audible(model)) return;
    void ctx.resume();
    this.running = true;
    this.startUs = timeUs;
    // To the end of the timeline; a loop's wrap schedules the next pass (follow).
    const when = ctx.currentTime + 0.02;
    this.startCtx = when;
    const spans = clipSpans(model, timeUs, model.durationUs);
    this.missing = spans.some((sp) => !this.lib.buffer(sp.clip.mediaHash));
    this.sources = scheduleSpans(ctx, ctx.destination, spans, model, (h) => this.lib.buffer(h), when);
  }

  /** Each frame while playing: a jump of the playhead (a wrap, a seek) or a file decoded since schedules again. */
  follow(timeUs: Micros): void {
    if (!this.running) return;
    const late = this.missing && (this.model?.audio ?? []).every((c) => this.lib.buffer(c.mediaHash));
    if (late || Math.abs(this.playedUs() - timeUs) > 100_000) this.start(timeUs);
  }

  /** Where the sound is in the timeline's time. */
  private playedUs(): Micros {
    const ctx = this.lib.context();
    return this.startUs + Math.max(0, (ctx?.currentTime ?? this.startCtx) - this.startCtx) * 1e6;
  }

  stop(): void {
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        // Not started yet, or ended.
      }
      src.disconnect();
    }
    this.sources = [];
    this.running = false;
  }
}

/** The export's soundtrack: the clips over [0, spanUs) mixed offline at 48 kHz stereo (null: no audible clip). */
export async function mixAudio(ed: EditorController, model: TimelineModel, spanUs: Micros): Promise<AudioBuffer | null> {
  if (!AudioPlayer.audible(model) || typeof OfflineAudioContext === "undefined") return null;
  const lib = audioLibrary(ed);
  await lib.loadAll(model);
  const spans = clipSpans(model, 0, spanUs);
  if (!spans.some((s) => lib.buffer(s.clip.mediaHash))) return null;
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil((spanUs / 1e6) * MIX_SAMPLE_RATE)), MIX_SAMPLE_RATE);
  scheduleSpans(ctx, ctx.destination, spans, model, (h) => lib.buffer(h), 0);
  return ctx.startRendering();
}
