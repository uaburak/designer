/**
 * The agents' sound tools (docs/motion.md §9.3, docs/ai.md §8.4; [ours]): free and local — no paid API.
 * - `generate_sound`: recipes (motion/sound/recipes.ts) synthesised here into WAV, stored in the file's image store as a
 *   dropped WAV is, and placed on a timeline as ordinary audio clips (MOTION_ADD_AUDIO / MOTION_SET_AUDIO) — each
 *   sound's sync point on the time it is given; every sound of one call is one undo step. `place: false` saves the WAVs
 *   in the agent's working folder instead.
 * - `score_motion`: the timeline as a cue sheet (motion/sound/score.ts) — what to sync sounds to.
 * - `get_sound_mix`: the timeline's audio mixed and measured (motion/sound/mix.ts) — the agent's ears.
 */
import type { Guid } from "@/engine/codec";
import { textResult, type ToolResult } from "@shared/agents/tools";
import type { AudioEdit, MotionSamples, ResolvedMotion, TimelineModel } from "@shared/motion/types";
import type { ToolEnv } from "./mcpTools";
import { ToolError } from "./toolError";
import { normId, type Spec } from "./nodeSpec";
import { audioLibrary } from "../motion/audio/audio";
import { timelineOf } from "../motion/publicApi";
import { base64 } from "../motion/export/vectorAnim";
import { dbToGain, gainToDb, lengthOf, SR } from "../motion/sound/dsp";
import { FAMILY_DB, RecipeError, renderSound, resolveRecipe, SOUND_PRESETS, type RenderedSound, type SoundFamily, type SoundRecipe } from "../motion/sound/recipes";
import { encodeWav, decodeWav } from "../motion/sound/wav";
import { scoreMotion } from "../motion/sound/score";
import { analyzeMix, type MixClip } from "../motion/sound/mix";

const US = 1e6;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** Sounds per call, and their total length (s). */
export const MAX_SOUNDS = 40;
export const MAX_SOUND_SECONDS = 600;

/** The timeline a call names (a layer in it, its frame, or the selection's). */
function timelineFor(env: ToolEnv, args: Spec, tool: string): TimelineModel {
  const id = normId(args.nodeId) || env.ed.selection[0];
  if (!id) throw new ToolError(`${tool}: nodeId — the top-level frame (or any layer in it) whose timeline this is.`);
  if (!env.ed.engine.readNode(id, { fields: ["name"] })) throw new ToolError(`No layer ${id} in this file. Use get_metadata to find ids.`);
  const model = timelineOf(env.ed, id);
  if (!model) throw new ToolError(`${tool}: ${id} isn't in a top-level frame (a page's direct child holds the timeline).`);
  return model;
}

/** The family's row name (sounds of a kind share a row while they don't overlap). */
const ROW_NAME: Record<SoundFamily, string> = { ui: "UI", move: "Whooshes", build: "Risers", hit: "Hits", magic: "Magic", notify: "Chimes", glitch: "Glitch", ambience: "Ambience", beat: "Beat", music: "Music" };

const LENGTH_FITS_TIMELINE = new Set(["music", "beat", "drone", "pad"]);

interface Planned {
  sound: RenderedSound;
  name: string;
  row: string;
  offset: number;
  trim: number;
  length: number;
  volume: number;
  syncAt: number;
}

/** One entry of `sounds`, or the call itself when it has no list. */
function entriesOf(args: Spec): Spec[] {
  if (Array.isArray(args.sounds)) return args.sounds as Spec[];
  if (args.sound && typeof args.sound === "object") return [args.sound as Spec];
  const { nodeId: _n, place: _p, sounds: _s, ...one } = args;
  return [one];
}

/** generate_sound: recipes synthesised, stored and placed (one undo step), or saved as WAV files. */
export async function generateSoundTool(env: ToolEnv, args: Spec): Promise<ToolResult> {
  const entries = entriesOf(args);
  if (!entries.length) throw new ToolError("generate_sound: sounds — [{type | preset, …recipe, at, name, volumeDb}]");
  if (entries.length > MAX_SOUNDS) throw new ToolError(`generate_sound: at most ${MAX_SOUNDS} sounds per call`);
  const place = args.place !== false;
  const model = place ? timelineFor(env, args, "generate_sound") : null;
  const timeline = model ? model.durationUs / US : 0;

  // Render (yielding between sounds: a bed takes a few hundred ms).
  const rendered: { sound: RenderedSound; entry: Spec; at: number }[] = [];
  let total = 0;
  for (const [k, e] of entries.entries()) {
    if (!e || typeof e !== "object") throw new ToolError(`sounds[${k}]: an object {type | preset, …}`);
    const at = e.at === undefined ? 0 : Number(e.at);
    if (!Number.isFinite(at) || at < 0) throw new ToolError(`sounds[${k}].at: seconds on the timeline, 0 or more`);
    const recipe = { ...(e as SoundRecipe) };
    try {
      const resolved = resolveRecipe(recipe);
      // Beds and beats with no length of their own run to the timeline's end (a looping timeline: a seamless loop).
      if (model && LENGTH_FITS_TIMELINE.has(resolved.type) && resolved.duration === undefined && !(resolved.type === "beat" && resolved.bars)) {
        recipe.duration = Math.max(0.5, Math.min(120, timeline - at));
        if (recipe.loop === undefined && at === 0 && model.playback === "LOOP" && resolved.type !== "pad") recipe.loop = true;
      }
      if (recipe.seed === undefined) recipe.seed = k + 1;
      const sound = renderSound(recipe);
      total += lengthOf(sound.pcm) / SR;
      if (total > MAX_SOUND_SECONDS) throw new ToolError(`generate_sound: more than ${MAX_SOUND_SECONDS} s of sound in one call`);
      rendered.push({ sound, entry: e, at });
    } catch (err) {
      if (err instanceof RecipeError) throw new ToolError(`sounds[${k}].${err.message}`);
      throw err;
    }
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  if (!place) {
    const files = rendered.map(({ sound, entry }, k) => {
      const name = `${(typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : sound.label).replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) || `Sound ${k + 1}`}.wav`;
      return { name, data: base64(encodeWav(sound.pcm)), mimeType: "audio/wav" };
    });
    const out = textResult({ files: files.map((f, k) => ({ file: f.name, duration: r3(lengthOf(rendered[k].sound.pcm) / SR), sync: r3(rendered[k].sound.sync) })) });
    out.files = files;
    return out;
  }

  // Placement: the sound's sync point on `at` (align "start": its first sample), trimmed where it would start before 0.
  const m = model!;
  const plans: Planned[] = rendered.map(({ sound, entry, at }) => {
    const len = lengthOf(sound.pcm) / SR;
    const align = entry.align === "start" ? "start" : "sync";
    let offset = at - (align === "sync" ? sound.sync : 0);
    let trim = 0;
    if (offset < 0) {
      trim = -offset;
      offset = 0;
    }
    const volumeDb = typeof entry.volumeDb === "number" ? Math.min(0, entry.volumeDb) : typeof entry.volume === "number" ? gainToDb(Math.max(0, Math.min(1, entry.volume))) : FAMILY_DB[sound.family];
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim().slice(0, 120) : sound.label;
    return { sound, name, row: typeof entry.row === "string" && entry.row.trim() ? entry.row.trim().slice(0, 60) : ROW_NAME[sound.family], offset, trim, length: Math.max(0.001, len - trim), volume: Math.max(0, Math.min(1, dbToGain(volumeDb))), syncAt: offset - trim + sound.sync };
  });

  // Store the files first (as add_audio does); the timeline's edits follow in one step.
  const store = env.ed.images.store;
  if (!store) throw new ToolError("generate_sound: audio can't be added to this file.");
  const lib = audioLibrary(env.ed);
  const hashes: string[] = [];
  for (const p of plans) {
    const hash = await store.put(encodeWav(p.sound.pcm), "audio/wav");
    if (!hash) throw new ToolError("generate_sound: the sound couldn't be stored.");
    lib.adopt(hash, p.sound.pcm);
    hashes.push(hash);
  }

  const root = m.root;
  const e = env.ed.engine;
  const made: { id: string; plan: Planned }[] = [];
  env.write("Generate sound", () => {
    // Rows by name: an existing row of that name takes a clip that doesn't overlap its clips, else a new row.
    const rows = new Map<string, { id: string; spans: [number, number][] }[]>();
    for (const r of m.audioTracks) {
      const spans = m.audio.filter((a) => a.trackId === r.id).map((a) => [a.offsetUs / US, (a.offsetUs + a.durationUs) / US] as [number, number]);
      (rows.get(r.name) ?? rows.set(r.name, []).get(r.name)!).push({ id: r.id, spans });
    }
    plans.forEach((p, k) => {
      const span: [number, number] = [p.offset, p.offset + p.length];
      const free = (rows.get(p.row) ?? []).find((r) => r.spans.every(([a, b]) => span[1] <= a + 1e-6 || span[0] >= b - 1e-6));
      const res = e.runMotionCommandCreating("MOTION_ADD_AUDIO", { root, mediaHash: hashes[k], name: p.name, offsetUs: Math.round(p.offset * US), durationUs: Math.round(p.length * US), ...(free ? { trackId: free.id } : {}) });
      if (res.status !== 0 || !res.created[0]) throw new ToolError(`generate_sound was refused by the engine (status ${res.status}).`);
      const id = res.created[0];
      const after = timelineOf(env.ed, root);
      const clip = after?.audio.find((a) => a.id === id);
      const edit: AudioEdit = { id, volume: p.volume, ...(p.trim > 0 ? { startUs: Math.round(p.trim * US), durationUs: Math.round(p.length * US) } : {}) };
      const tracks = !free && clip ? [{ id: clip.trackId, name: rowName(p.row, rows) }] : [];
      const st = e.runMotionCommand("MOTION_SET_AUDIO", { root, edits: [edit], ...(tracks.length ? { tracks } : {}) });
      if (st !== 0) throw new ToolError(`generate_sound: the clip's volume was refused by the engine (status ${st}).`);
      if (free) free.spans.push(span);
      else if (clip) (rows.get(p.row) ?? rows.set(p.row, []).get(p.row)!).push({ id: clip.trackId, spans: [span] });
      made.push({ id, plan: p });
    });
  });

  const after = timelineOf(env.ed, root);
  const rowOf = (id: string) => after?.audioTracks.find((r) => r.id === after.audio.find((a) => a.id === id)?.trackId)?.name;
  const late = made.filter((x) => x.plan.offset >= timeline - 1e-6).map((x) => x.plan.name);
  return textResult({
    added: made.map(({ id, plan }) => ({
      id,
      name: plan.name,
      row: rowOf(id),
      type: plan.sound.type,
      offset: r3(plan.offset),
      sync: r3(plan.syncAt),
      duration: r3(plan.length),
      ...(plan.trim > 0 ? { trimStart: r3(plan.trim) } : {}),
      volumeDb: Math.round(gainToDb(plan.volume) * 10) / 10,
    })),
    timeline: { duration: r3(timeline), playback: m.playback },
    ...(late.length ? { warnings: [`Starts after the timeline's end (not heard in playback or export): ${late.join(", ")} — lengthen the timeline with set_timeline or move them.`] } : {}),
    next: "Check the mix with get_sound_mix; edit_audio moves, trims, sets the volume of or removes a clip (one undo step per call).",
  });
}

/** The row's name, numbered when that name's rows are all taken ("Hits 2"). */
function rowName(name: string, rows: Map<string, unknown[]>): string {
  const n = rows.get(name)?.length ?? 0;
  return n ? `${name} ${n + 1}` : name;
}

/** score_motion: the timeline's events, accents, climax, energy and suggested cues. */
export function scoreMotionTool(env: ToolEnv, args: Spec): ToolResult {
  const model = timelineFor(env, args, "score_motion");
  const root: Guid = model.root;
  let resolved: ResolvedMotion | null = null;
  try {
    resolved = env.ed.engine.motionResolved(root);
  } catch {
    resolved = null;
  }
  if (!resolved) throw new ToolError("score_motion: this timeline couldn't be read.");
  const node = env.ed.engine.readNode(root, { fields: ["size"] }) as { size?: { x: number; y: number } } | null;
  const duration = model.durationUs / US;
  // Samples for the true moment of peak speed: at most 1200 times (30 fps, fewer on long timelines).
  const fps = Math.max(5, Math.min(typeof args.fps === "number" ? args.fps : 30, 1200 / Math.max(0.1, duration)));
  const count = Math.max(2, Math.floor(duration * fps) + 1);
  let samples: MotionSamples | null = null;
  try {
    samples = env.ed.engine.motionSamples(root, Array.from({ length: count }, (_, k) => Math.round(((k * duration) / (count - 1)) * US)));
  } catch {
    samples = null;
  }
  const score = scoreMotion({ resolved, rootSize: { width: node?.size?.x ?? 1, height: node?.size?.y ?? 1 }, samples });
  return textResult({
    frame: model.rootName,
    ...score,
    audio: model.audio.map((a) => ({ id: a.id, name: a.name, offset: r3(a.offsetUs / US), duration: r3(a.durationUs / US), volumeDb: Math.round(gainToDb(a.volume) * 10) / 10, mute: a.mute })),
    units: "seconds on the timeline; strength 0–1; cues are suggestions — align: sync puts a sound's own moment (a whoosh's peak, a riser's end, a hit's transient) on t",
  });
}

/** get_sound_mix: the timeline's clips mixed and measured. */
export async function getSoundMixTool(env: ToolEnv, args: Spec): Promise<ToolResult> {
  const model = timelineFor(env, args, "get_sound_mix");
  const lib = audioLibrary(env.ed);
  const clips: MixClip[] = [];
  for (const a of model.audio) {
    const row = model.audioTracks.find((r) => r.id === a.trackId);
    let pcm = lib.samplesOf(a.mediaHash);
    if (!pcm) {
      await lib.load(a.mediaHash);
      pcm = lib.samplesOf(a.mediaHash);
    }
    if (!pcm) {
      // A WAV (ours) read straight from the store where nothing decodes (node's tests, a worker).
      const bytes = await env.ed.images.bytes(a.mediaHash).catch(() => null);
      const wav = bytes ? decodeWav(bytes) : null;
      if (wav) lib.adopt(a.mediaHash, wav);
      pcm = wav;
    }
    const gain = a.mute || row?.mute ? 0 : a.volume * (row?.gain ?? 1);
    clips.push({ id: a.id, name: a.name, offset: a.offsetUs / US, trimStart: a.startUs / US, duration: a.durationUs / US, gain, pcm: pcm && pcm.channels.length >= 2 ? { sampleRate: pcm.sampleRate, channels: [pcm.channels[0], pcm.channels[1]] } : pcm ? { sampleRate: pcm.sampleRate, channels: [pcm.channels[0], pcm.channels[0]] } : null });
  }
  const report = analyzeMix(clips, model.durationUs / US);
  return textResult({ frame: model.rootName, clips: clips.map((c) => ({ id: c.id, name: c.name, offset: r3(c.offset), duration: r3(c.duration), volumeDb: Math.round(gainToDb(c.gain) * 10) / 10 })), ...report });
}

/** The presets' names, for the tool's description and errors. */
export const SOUND_PRESET_NAMES = Object.keys(SOUND_PRESETS);
