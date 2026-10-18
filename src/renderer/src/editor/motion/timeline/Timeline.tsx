/**
 * Motion mode's timeline (docs/motion.md §6.2), increment 1: the header (Play / Pause, Toggle auto-keyframe, the
 * current time and duration fields, Playback, Collapse layers, zoom, Collapse timeline), the layer column (one row per
 * animated layer of the root, its property rows under it) and the track area (the ruler, the layer bars, the diamonds,
 * the segments between them, the playhead, the duration handle).
 *
 * Increment 2: a marquee in the track area selects the keyframes it touches (⇧ adds to the selection), ⌘C / ⌘V copy
 * the selected keyframes and paste them at the playhead, the top edge resizes the timeline. Round 8a increment 2: an
 * animated instance's purple bar drags in time (its offset in the root's timeline, docs/motion.md §4.3).
 *
 * Round 8h: each preset's clip is a row under its layer (docs/motion.md §6.2 "Clips"): a bar with its type's name from
 * its start for its duration — click selects it (and opens its settings in the Animations section), drag moves it,
 * its side handles change its start or its length (snapped as keyframes are), Delete removes it.
 *
 * Round 8e: the root's audio rows under the layers (docs/motion.md §6.2, §6.6) — each row's name and eye (its mute),
 * its clips as bars with their file's waveform: click selects one (the Audio section shows its volume), drag moves
 * it, its side handles trim it (never past the file's ends), Delete removes it, right-click opens its menu (Mute
 * audio, Split audio at playhead, Delete); audio files dropped on the timeline land at the drop's time. Ping-pong is
 * skipped by the Playback button while the timeline has audio (Figma disables it).
 *
 * Round 8i: the **Timeline settings** popover (units ms / frames, the snapping grid — Figma's presets per unit, Off, or
 * a typed one — and Once / Loop / Ping pong; TimelineSettings.tsx); the **layer bar** dragged moves all its layer's
 * keyframes and clips, its side handles scale them about the other end (MOTION_RETIME_LAYER); the lanes **scroll with
 * the layer column** (one scroll position: the column's, the lanes translated by it, the playhead and the past over
 * them; a plain wheel over the lanes scrolls the column); a segment bound to an EASING variable says so and its menu
 * offers the binding (`easingVariables`); a Position / Scale row's context menu combines or splits its X / Y tracks.
 * `readOnly` (Dev Mode's timeline view) leaves play, scrub and zoom: no resize edge, settings, segment menus, layer
 * bar or duration drags.
 *
 * A pure view of a `TimelineModel`: every change goes out through its callbacks, so MotionMode wires it to the engine
 * and the tests mount it on a fixed model.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from "react";
import { ContextMenu, Icon, IconButton, Slider, TextInput, type IconName, type MenuEntry } from "@/ds";
import { capture } from "@/ds/util/pointer";
import { t, useT } from "@/i18n";
import { ANIMATION_PRESETS, EASING_LABELS, PLAYBACK_CYCLE, PLAYBACK_LABELS, type EasingRef, type GuidString, type Micros, type MotionEasing, type PlaybackName, type TimelineAudioClip, type TimelineClip, type TimelineKeyframe, type TimelineLayer, type TimelineModel, type TimelineTrack, type TimelineUnit } from "@shared/motion/types";
import { isAudioFile, waveformPath } from "../audio/audio";
import { EasingMenu } from "../easing/EasingEditor";
import { DIAMOND_PX, clampTimelineHeight, fitScale, formatTime, frameUs, layerExtent, marqueeBox, otherKeyframeTimes, overlaps, parseTime, retimeLayer, rulerTicks, snapTime, snapToFrame, timeToX, trimAudio, xToTime, type Box, type Scale } from "./maths";
import { TimelineSettings } from "./TimelineSettings";
import styles from "./Timeline.module.css";

export interface TimelineProps {
  /** null: nothing selected inside a timeline root */
  model: TimelineModel | null;
  timeUs: Micros;
  playing: boolean;
  autoKeyframe: boolean;
  collapsed: boolean;
  unit: TimelineUnit;
  selectedKeyframes: ReadonlySet<GuidString>;
  /** The engine's selection (the layer rows lit) */
  selectedNodes: ReadonlySet<GuidString>;
  /** Dev Mode's timeline view (§8): the playhead, play and zoom only */
  readOnly?: boolean;
  /**
   * Social's header (docs/social.md §8): what the mount puts next to Duration (the post's format and its video limits),
   * and the length Duration must keep within — outside it, Duration reads in the danger colour
   */
  header?: { content: ReactNode; minUs?: Micros; maxUs?: Micros };
  onSeek(timeUs: Micros): void;
  onTogglePlay(): void;
  onToggleAutoKeyframe(): void;
  onToggleCollapse(): void;
  /** The duration field or handle (`final` false while the handle drags), the Playback button, the settings' grid */
  onSetTimeline(patch: { durationUs?: Micros; playback?: PlaybackName; snappingFps?: number }, final: boolean): void;
  /** The settings' units (round 8i) */
  onSetUnit?(unit: TimelineUnit): void;
  /**
   * The layer bar dragged (round 8i): each frame the change since the last one — a move by `deltaUs`, or a scale by
   * `factor` about `pivotUs` (the other end) — and once more on release (`final`, possibly no change)
   */
  onRetimeLayer?(node: GuidString, change: { deltaUs: Micros } | { scale: { factor: number; pivotUs: Micros } }, final: boolean): void;
  /** A Position / Scale row's menu: its X / Y tracks combined into one, or its XY track split (round 8i) */
  onCombineTracks?(node: GuidString, kind: "POSITION" | "SCALE", combine: boolean): void;
  /** Segments' Easing menus offer the EASING variable binding (needs the editor; off in the tests' bare mount) */
  easingVariables?: boolean;
  onSelectKeyframes(ids: GuidString[]): void;
  /** A keyframe drag: the moved keyframes' new times each frame (`final` false), once more with `final` true */
  onMoveKeyframes(edits: { id: GuidString; timeUs: Micros }[], final: boolean): void;
  onDeleteKeyframes(ids: GuidString[]): void;
  onDeleteTrack(node: GuidString, track: TimelineTrack): void;
  onSetEasing(ids: GuidString[], easing: EasingRef): void;
  /** A layer row clicked: select the layer on the canvas */
  onSelectLayer(node: GuidString, additive: boolean): void;
  /** ⌘C in the track area with keyframes selected (the editor keeps the copy) */
  onCopyKeyframes(ids: GuidString[]): void;
  /** ⌘V in the track area: the copied keyframes at the playhead; false when none were copied (the document's paste goes on) */
  onPasteKeyframes(): boolean;
  /** The top edge dragged: the timeline's height in px (`final` on release) */
  onResize(heightPx: number, final: boolean): void;
  /** An animated instance's bar dragged: its offset in the root's time each frame (`final` false), once more on release */
  onMoveInstance?(node: GuidString, offsetUs: Micros, final: boolean): void;
  /** The preset clip selected (round 8h; its settings open in the Animations section) */
  selectedClip?: GuidString | null;
  onSelectClip?(id: GuidString | null): void;
  /** A clip dragged (its start) or a side handle (its start and length): each frame (`final` false), once more on release */
  onEditClip?(clip: TimelineClip, patch: { startUs?: Micros; durationUs?: Micros }, final: boolean): void;
  onDeleteClip?(id: GuidString): void;
  /** The audio clip selected (round 8e; the Audio section shows its volume) */
  selectedAudio?: GuidString | null;
  onSelectAudio?(id: GuidString | null): void;
  /** An audio clip dragged (its offset) or trimmed (a side handle): each frame (`final` false), once more on release */
  onEditAudio?(clip: TimelineAudioClip, patch: { offsetUs?: Micros; startUs?: Micros; durationUs?: Micros }, final: boolean): void;
  onDeleteAudio?(ids: GuidString[]): void;
  /** An audio row's eye: mute or unmute the row */
  onToggleAudioRow?(trackId: GuidString, mute: boolean): void;
  /** An audio clip's menu picked: "mute" (Mute / Unmute audio), "split" (at the playhead), "delete" */
  onAudioMenu?(clip: TimelineAudioClip, action: "mute" | "split" | "delete"): void;
  /** Audio files dropped on the timeline, at the drop's time */
  onDropAudio?(files: File[], atUs: Micros): void;
  /** A file's waveform (PEAKS_PER_SECOND peaks, 0–1) and its length (µs); null while it isn't decoded */
  audioPeaks?(hash: string): Float32Array | null;
  audioLength?(hash: string): Micros | null;
}

const PLAYBACK_ICON: Record<PlaybackName, IconName> = { LOOP: "24.loop", ONCE: "24.play-once", PING_PONG: "24.ping-pong" };
/** A drag starts after this many px (a click selects). */
const DRAG_PX = 3;
/** ⇧-snap distance (px) to the playhead and the other keyframes. */
const SNAP_PX = 8;

interface Drag {
  pointerId: number;
  startX: number;
  /** The dragged keyframes with their times when the drag began */
  items: { id: GuidString; timeUs: Micros }[];
  /** Beyond DRAG_PX: a drag, not a click */
  moving: boolean;
}

interface EasingTarget {
  ids: GuidString[];
  easing: EasingRef;
  /** A bound one's value (what the graph shows) */
  resolved?: MotionEasing;
  anchor: { x: number; y: number; width: number; height: number };
}

/** One row of the layer column and its lane. */
type Row =
  | { kind: "layer"; layer: TimelineLayer }
  | { kind: "clip"; layer: TimelineLayer; clip: TimelineClip }
  | { kind: "track"; layer: TimelineLayer; track: TimelineTrack }
  | { kind: "audio"; row: TimelineModel["audioTracks"][number]; clips: TimelineAudioClip[] };

/** The Layers panel's icon name, or the frame glyph when the engine gave one the registry lacks. */
const iconOf = (name: string): IconName => (name.startsWith("16.") ? (name as IconName) : (`16.${name}` as IconName));

export function Timeline(p: TimelineProps) {
  useT();
  const { model, timeUs, autoKeyframe, collapsed, unit, selectedKeyframes, readOnly } = p;
  const fps = model?.snappingFps ?? 60;
  const durationUs = model?.durationUs ?? 2_000_000;
  const tracksEl = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [zoom, setZoom] = useState(1);
  const [collapsedLayers, setCollapsedLayers] = useState<ReadonlySet<GuidString>>(new Set());
  const [selectedRow, setSelectedRow] = useState<{ node: GuidString; track: GuidString } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [easingAt, setEasingAt] = useState<EasingTarget | null>(null);
  const [durationDrag, setDurationDrag] = useState<number | null>(null);
  const [marquee, setMarquee] = useState<Box | null>(null);
  // The layer column's scroll position: the lanes follow it (round 8i).
  const rowsEl = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [settingsAt, setSettingsAt] = useState<HTMLElement | null>(null);
  const [rowMenu, setRowMenu] = useState<{ node: GuidString; kind: "POSITION" | "SCALE"; combine: boolean; at: { x: number; y: number } } | null>(null);

  // The track area's width decides the scale (fit the duration, then the zoom factor).
  useEffect(() => {
    const el = tracksEl.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 600));
    ro.observe(el);
    setWidth(el.clientWidth || 600);
    return () => ro.disconnect();
  }, [collapsed]);
  const scale: Scale = useMemo(() => {
    const fit = fitScale(durationUs, width);
    return { pxPerUs: fit.pxPerUs * zoom };
  }, [durationUs, width, zoom]);

  const layers = useMemo(() => model?.layers ?? [], [model]);
  // A row per layer, then (expanded) a row per clip and a row per track, then the audio rows: the same list draws the
  // layer column and the lanes.
  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const l of layers) {
      out.push({ kind: "layer", layer: l });
      if (collapsedLayers.has(l.node) || l.instance) continue;
      for (const c of l.clips) out.push({ kind: "clip", layer: l, clip: c });
      for (const tr of l.tracks) out.push({ kind: "track", layer: l, track: tr });
    }
    for (const row of model?.audioTracks ?? []) out.push({ kind: "audio", row, clips: (model?.audio ?? []).filter((c) => c.trackId === row.id) });
    return out;
  }, [layers, collapsedLayers, model]);
  const rowKey = (r: Row) => (r.kind === "layer" ? r.layer.node : r.kind === "clip" ? r.clip.id : r.kind === "track" ? r.track.id : r.row.id);
  const [audioMenu, setAudioMenu] = useState<{ clip: TimelineAudioClip; at: { x: number; y: number } } | null>(null);

  const seekAt = (clientX: number) => {
    const el = tracksEl.current;
    if (!el) return;
    const x = clientX - el.getBoundingClientRect().left;
    p.onSeek(Math.min(durationUs, snapToFrame(xToTime(x, scale), fps)));
  };

  // ---- The ruler scrubs the playhead --------------------------------------------------------------------------------
  const onRulerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    capture(e.currentTarget, e.pointerId);
    seekAt(e.clientX);
    const move = (ev: PointerEvent) => seekAt(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---- Keyframes: click selects, ⇧ adds, double-click seeks, drag moves ---------------------------------------------
  const onDiamondDown = (e: ReactPointerEvent<HTMLButtonElement>, k: TimelineKeyframe) => {
    if (e.button !== 0 || readOnly) return;
    e.stopPropagation();
    let ids: GuidString[];
    if (e.shiftKey) ids = selectedKeyframes.has(k.id) ? [...selectedKeyframes].filter((x) => x !== k.id) : [...selectedKeyframes, k.id];
    else ids = selectedKeyframes.has(k.id) ? [...selectedKeyframes] : [k.id];
    p.onSelectKeyframes(ids);
    setSelectedRow(null);
    const times = new Map<GuidString, Micros>();
    for (const l of layers) for (const tr of l.tracks) for (const kf of tr.keyframes) times.set(kf.id, kf.timeUs);
    const items = ids.filter((id) => times.has(id)).map((id) => ({ id, timeUs: times.get(id)! }));
    if (!items.some((i) => i.id === k.id)) items.push({ id: k.id, timeUs: k.timeUs });
    capture(e.currentTarget, e.pointerId);
    setDrag({ pointerId: e.pointerId, startX: e.clientX, items, moving: false });
  };
  useEffect(() => {
    if (!drag) return;
    const except = new Set(drag.items.map((i) => i.id));
    const targets = [timeUs, ...otherKeyframeTimes(layers, except)];
    const edits = (clientX: number, shift: boolean) => {
      const dUs = (clientX - drag.startX) / scale.pxPerUs;
      const first = Math.min(...drag.items.map((i) => i.timeUs));
      // The earliest keyframe snaps (frames; ⇧: the playhead and the others), the rest keep their distances to it.
      const snapped = shift ? snapTime(first + dUs, fps, targets, SNAP_PX / scale.pxPerUs) : snapToFrame(first + dUs, fps);
      const shift0 = Math.max(-first, snapped - first);
      return drag.items.map((i) => ({ id: i.id, timeUs: Math.max(0, Math.round(i.timeUs + shift0)) }));
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== drag.pointerId) return;
      if (!drag.moving) {
        if (Math.abs(ev.clientX - drag.startX) < DRAG_PX) return;
        setDrag({ ...drag, moving: true });
      }
      p.onMoveKeyframes(edits(ev.clientX, ev.shiftKey), false);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== drag.pointerId) return;
      if (drag.moving) p.onMoveKeyframes(edits(ev.clientX, ev.shiftKey), true);
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [drag, fps, layers, p, scale.pxPerUs, timeUs]);

  // ---- An animated instance's bar: dragged in time (snapped to frames; ⇧ to the playhead and the keyframes) ------------
  const onInstanceDown = (e: ReactPointerEvent<HTMLDivElement>, layer: TimelineLayer) => {
    const inst = layer.instance;
    if (e.button !== 0 || !inst || !p.onMoveInstance) return;
    e.stopPropagation();
    p.onSelectLayer(layer.node, false);
    capture(e.currentTarget, e.pointerId);
    const startX = e.clientX;
    const targets = [timeUs, ...otherKeyframeTimes(layers, new Set())];
    let moving = false;
    const at = (clientX: number, shift: boolean) => {
      const want = inst.offsetUs + (clientX - startX) / scale.pxPerUs;
      return Math.round(shift ? snapTime(want, fps, targets, SNAP_PX / scale.pxPerUs) : snapToFrame(want, fps));
    };
    const move = (ev: PointerEvent) => {
      if (!moving && Math.abs(ev.clientX - startX) < DRAG_PX) return;
      moving = true;
      p.onMoveInstance!(layer.node, at(ev.clientX, ev.shiftKey), false);
    };
    const up = (ev: PointerEvent) => {
      if (moving) p.onMoveInstance!(layer.node, at(ev.clientX, ev.shiftKey), true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // ---- A preset's clip: drag moves it, its side handles change its start or its length (frames; ⇧ the playhead, keyframes) -
  const onClipDown = (e: ReactPointerEvent<HTMLElement>, clip: TimelineClip, edge: "move" | "start" | "end") => {
    if (e.button !== 0 || readOnly) return;
    e.stopPropagation();
    p.onSelectClip?.(clip.id);
    p.onSelectKeyframes([]);
    setSelectedRow(null);
    if (!p.onEditClip) return;
    capture(e.currentTarget, e.pointerId);
    const startX = e.clientX;
    const targets = [timeUs, ...otherKeyframeTimes(layers, new Set())];
    const minUs = frameUs(fps);
    let moving = false;
    const at = (clientX: number, shift: boolean): { startUs?: Micros; durationUs?: Micros } => {
      const d = (clientX - startX) / scale.pxPerUs;
      const snap = (us: number) => Math.round(shift ? snapTime(us, fps, targets, SNAP_PX / scale.pxPerUs) : snapToFrame(us, fps));
      if (edge === "move") return { startUs: Math.max(0, snap(clip.startUs + d)) };
      const end = clip.startUs + clip.durationUs;
      if (edge === "end") return { durationUs: Math.max(minUs, snap(end + d) - clip.startUs) };
      const start = Math.min(end - minUs, Math.max(0, snap(clip.startUs + d)));
      return { startUs: start, durationUs: end - start };
    };
    const move = (ev: PointerEvent) => {
      if (!moving && Math.abs(ev.clientX - startX) < DRAG_PX) return;
      moving = true;
      p.onEditClip!(clip, at(ev.clientX, ev.shiftKey), false);
    };
    const up = (ev: PointerEvent) => {
      if (moving) p.onEditClip!(clip, at(ev.clientX, ev.shiftKey), true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // ---- An audio clip: drag moves it, its side handles trim it (frames; ⇧ the playhead and keyframes) ------------------
  const onAudioDown = (e: ReactPointerEvent<HTMLElement>, clip: TimelineAudioClip, edge: "move" | "start" | "end") => {
    if (e.button !== 0 || readOnly) return;
    e.stopPropagation();
    p.onSelectAudio?.(clip.id);
    p.onSelectClip?.(null);
    p.onSelectKeyframes([]);
    setSelectedRow(null);
    if (!p.onEditAudio) return;
    capture(e.currentTarget, e.pointerId);
    const startX = e.clientX;
    const targets = [timeUs, ...otherKeyframeTimes(layers, new Set())];
    const lengthUs = p.audioLength?.(clip.mediaHash) ?? null;
    const from = edge === "end" ? clip.offsetUs + clip.durationUs : clip.offsetUs;
    let moving = false;
    const at = (clientX: number, shift: boolean) => {
      const want = from + (clientX - startX) / scale.pxPerUs;
      const to = shift ? snapTime(want, fps, targets, SNAP_PX / scale.pxPerUs) : snapToFrame(want, fps);
      return trimAudio(clip, edge, to, lengthUs, frameUs(fps));
    };
    const move = (ev: PointerEvent) => {
      if (!moving && Math.abs(ev.clientX - startX) < DRAG_PX) return;
      moving = true;
      p.onEditAudio!(clip, at(ev.clientX, ev.shiftKey), false);
    };
    const up = (ev: PointerEvent) => {
      if (moving) p.onEditAudio!(clip, at(ev.clientX, ev.shiftKey), true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const audioMenuEntries = (clip: TimelineAudioClip): MenuEntry[] => [
    { id: "mute", label: clip.mute ? t("Unmute audio") : t("Mute audio") },
    { id: "split", label: t("Split audio at playhead"), shortcut: "⌥K", disabled: !(timeUs > clip.offsetUs && timeUs < clip.offsetUs + clip.durationUs) },
    "-",
    { id: "delete", label: t("Delete"), shortcut: "⌫" },
  ];
  // Audio files dropped on the track area land at the drop's time; on the layer column, at the playhead.
  const onDragOver = (e: ReactDragEvent) => {
    if (readOnly || !p.onDropAudio || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e: ReactDragEvent) => {
    const files = [...e.dataTransfer.files].filter(isAudioFile);
    if (readOnly || !p.onDropAudio || !files.length) return;
    e.preventDefault();
    e.stopPropagation();
    const el = tracksEl.current;
    const r = el?.getBoundingClientRect();
    const inTracks = !!r && e.clientX >= r.left;
    p.onDropAudio(files, inTracks ? snapToFrame(xToTime(e.clientX - r!.left, scale), fps) : timeUs);
  };

  // ---- The layer bar: drag moves the layer's keyframes and clips, its side handles scale them about the other end ------
  const onLayerBarDown = (e: ReactPointerEvent<HTMLElement>, layer: TimelineLayer, edge: "move" | "start" | "end") => {
    const ext = layerExtent(layer);
    if (e.button !== 0 || readOnly || !ext || !p.onRetimeLayer) return;
    e.stopPropagation();
    p.onSelectLayer(layer.node, false);
    capture(e.currentTarget, e.pointerId);
    const startX = e.clientX;
    const targets = [timeUs, ...otherKeyframeTimes(layers.filter((l) => l.node !== layer.node), new Set())];
    // What has been sent so far (the engine applies each change on top of the last).
    let sent = { start: ext.startUs, end: ext.endUs };
    let moving = false;
    const send = (clientX: number, shift: boolean, final: boolean) => {
      const want = retimeLayer(ext, edge, (clientX - startX) / scale.pxPerUs, (us) => (shift ? snapTime(us, fps, targets, SNAP_PX / scale.pxPerUs) : snapToFrame(us, fps)), frameUs(fps));
      if (edge === "move") {
        const deltaUs = Math.round(want.startUs - sent.start);
        if (deltaUs || final) p.onRetimeLayer!(layer.node, { deltaUs }, final);
      } else {
        // Scaled about the other end: the factor from what was sent to what is wanted.
        const pivotUs = edge === "end" ? ext.startUs : ext.endUs;
        const from = sent.end - sent.start;
        const to = want.endUs - want.startUs;
        const factor = from > 0 ? to / from : 1;
        if (factor !== 1 || final) p.onRetimeLayer!(layer.node, { scale: { factor, pivotUs } }, final);
      }
      sent = { start: want.startUs, end: want.endUs };
    };
    const move = (ev: PointerEvent) => {
      if (!moving && Math.abs(ev.clientX - startX) < DRAG_PX) return;
      moving = true;
      send(ev.clientX, ev.shiftKey, false);
    };
    const up = (ev: PointerEvent) => {
      if (moving) send(ev.clientX, ev.shiftKey, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // ---- The duration handle --------------------------------------------------------------------------------------------
  const onDurationDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || readOnly) return;
    e.stopPropagation();
    capture(e.currentTarget, e.pointerId);
    const el = tracksEl.current;
    const at = (clientX: number) => Math.max(frameUs(fps), snapToFrame(xToTime(clientX - (el?.getBoundingClientRect().left ?? 0), scale), fps));
    const move = (ev: PointerEvent) => {
      const d = at(ev.clientX);
      setDurationDrag(d);
      p.onSetTimeline({ durationUs: d }, false);
    };
    const up = (ev: PointerEvent) => {
      p.onSetTimeline({ durationUs: at(ev.clientX) }, true);
      setDurationDrag(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---- A press on empty track area: a click clears the keyframe selection, a drag draws a marquee (⇧ adds to it) ------
  const onAreaDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (e.button !== 0 || !(target === e.currentTarget || target.classList.contains(styles.lane) || target.classList.contains(styles.lanes))) return;
    const base = e.shiftKey ? [...selectedKeyframes] : [];
    if (!e.shiftKey) p.onSelectKeyframes([]);
    setSelectedRow(null);
    const el = tracksEl.current;
    if (!el || readOnly) return;
    const start = { x: e.clientX, y: e.clientY };
    let moving = false;
    const move = (ev: PointerEvent) => {
      if (!moving && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_PX) return;
      moving = true;
      const area = el.getBoundingClientRect();
      const box = marqueeBox(start, { x: ev.clientX, y: ev.clientY });
      setMarquee({ ...box, left: box.left - area.left, top: box.top - area.top });
      // The diamonds as drawn: whatever the marquee touches is selected.
      const hit = [...el.querySelectorAll<HTMLElement>("[data-keyframe]")].filter((d) => overlaps(box, d.getBoundingClientRect())).map((d) => d.dataset.keyframe!);
      p.onSelectKeyframes([...new Set([...base, ...hit])]);
    };
    const up = () => {
      setMarquee(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // ---- The top edge: drag to resize (min 120, max 60 % of the window) ---------------------------------------------------
  const panelEl = useRef<HTMLElement>(null);
  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    capture(e.currentTarget, e.pointerId);
    const startY = e.clientY;
    const startH = panelEl.current?.getBoundingClientRect().height ?? 0;
    const at = (clientY: number) => clampTimelineHeight(startH + startY - clientY, window.innerHeight);
    const move = (ev: PointerEvent) => p.onResize(at(ev.clientY), false);
    const up = (ev: PointerEvent) => {
      p.onResize(at(ev.clientY), true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---- Keys in the track area: Delete, ← → (a frame; ⇧ ten), Home / End, Space ------------------------------------------
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === " ") {
      e.preventDefault();
      return p.onTogglePlay();
    }
    if (e.key === "Home") return p.onSeek(0);
    if (e.key === "End") return p.onSeek(durationUs);
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const step = frameUs(fps) * (e.shiftKey ? 10 : 1) * (e.key === "ArrowLeft" ? -1 : 1);
      return p.onSeek(Math.max(0, Math.min(durationUs, snapToFrame(timeUs + step, fps))));
    }
    if ((e.key === "Delete" || e.key === "Backspace") && !readOnly) {
      e.preventDefault();
      if (selectedKeyframes.size) return p.onDeleteKeyframes([...selectedKeyframes]);
      if (p.selectedClip && p.onDeleteClip) return p.onDeleteClip(p.selectedClip);
      if (p.selectedAudio && p.onDeleteAudio) return p.onDeleteAudio([p.selectedAudio]);
      if (selectedRow) {
        const track = layers.find((l) => l.node === selectedRow.node)?.tracks.find((tr) => tr.id === selectedRow.track);
        if (track) p.onDeleteTrack(selectedRow.node, track);
        setSelectedRow(null);
      }
    }
  };

  // ⌘ / Ctrl + wheel zooms the time axis; a plain wheel over the lanes scrolls the layer column (the lanes follow it).
  const onWheel = (e: ReactWheelEvent) => {
    if (!(e.metaKey || e.ctrlKey)) {
      if (rowsEl.current && e.deltaY) rowsEl.current.scrollTop += e.deltaY;
      return;
    }
    e.preventDefault();
    setZoom((z) => Math.min(16, Math.max(1, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
  };

  const cyclePlayback = () => {
    const cur = model?.playback ?? "LOOP";
    // Ping-pong is disabled while the timeline has audio (docs/motion.md §6.2).
    const cycle = model?.audio.length ? PLAYBACK_CYCLE.filter((m) => m !== "PING_PONG") : PLAYBACK_CYCLE;
    p.onSetTimeline({ playback: cycle[(cycle.indexOf(cur) + 1) % cycle.length] }, true);
  };
  const allCollapsed = layers.length > 0 && layers.every((l) => collapsedLayers.has(l.node));
  const collapseAll = () => setCollapsedLayers(allCollapsed ? new Set() : new Set(layers.map((l) => l.node)));

  const shownDuration = durationDrag ?? durationUs;
  // Social: the length outside the format's video limits (the header's).
  const outside = !!model && !!p.header && ((p.header.minUs !== undefined && shownDuration < p.header.minUs) || (p.header.maxUs !== undefined && shownDuration > p.header.maxUs));
  const playheadX = timeToX(timeUs, scale);
  const ticks = rulerTicks(Math.max(shownDuration, xToTime(width, scale)), scale, unit, fps);
  const state = collapsed ? "collapsed" : "open";

  return (
    <section ref={panelEl} data-motion-timeline={state} data-auto-keyframe={autoKeyframe || undefined} data-theme="dark" className={styles.panel} aria-label={t("Timeline")} onDragOver={onDragOver} onDrop={onDrop}>
      {!collapsed && !readOnly && <div className={styles.resize} role="separator" aria-orientation="horizontal" aria-label={t("Resize timeline")} data-timeline-resize onPointerDown={onResizeDown} />}
      <div className={styles.header}>
        <IconButton icon={p.playing ? "24.pause" : "24.play"} label={p.playing ? t("Pause") : t("Play")} shortcut="Space" onClick={p.onTogglePlay} />
        {!readOnly && <IconButton icon="24.auto-keyframe" label={t("Toggle auto-keyframe")} aria-pressed={autoKeyframe} className={autoKeyframe ? styles.autoOn : undefined} onClick={p.onToggleAutoKeyframe} />}
        <div className={styles.time}>
          <TextInput label={t("Current time")} value={formatTime(timeUs, unit, fps)} onCommit={(v) => {
            const us = parseTime(v, unit, fps);
            if (us !== null) p.onSeek(Math.min(durationUs, us));
          }} />
          <span aria-hidden>/</span>
          <TextInput label={t("Duration")} className={outside ? styles.over : undefined} data-duration-outside={outside || undefined} value={formatTime(shownDuration, unit, fps)} disabled={readOnly || !model} onCommit={(v) => {
            const us = parseTime(v, unit, fps);
            if (us !== null && us > 0) p.onSetTimeline({ durationUs: us }, true);
          }} />
        </div>
        {p.header && (
          <span className={styles.social} data-timeline-social="">
            {p.header.content}
          </span>
        )}
        {!readOnly && <IconButton icon="24.settings.small" label={t("Timeline settings")} aria-expanded={!!settingsAt} disabled={!model} data-timeline-settings onClick={(e) => setSettingsAt(settingsAt ? null : e.currentTarget)} />}
        {!readOnly && <IconButton icon={PLAYBACK_ICON[model?.playback ?? "LOOP"]} label={t("Playback: {mode}", { mode: t(PLAYBACK_LABELS[model?.playback ?? "LOOP"]) })} disabled={!model} onClick={cyclePlayback} />}
        <IconButton icon="24.collapse-layers" label={allCollapsed ? t("Expand layers") : t("Collapse layers")} disabled={!layers.length} onClick={collapseAll} />
        {model && <span className={styles.rootName}>{model.rootName}</span>}
        <div className={styles.headerRight}>
          <Slider className={styles.zoom} label={t("Zoom")} value={zoom} min={1} max={16} step={0.1} onChange={(v) => setZoom(v)} />
          <IconButton icon="24.timeline-collapse" label={collapsed ? t("Expand timeline") : t("Collapse timeline")} aria-expanded={!collapsed} onClick={p.onToggleCollapse} />
        </div>
      </div>
      {!collapsed && (
        <div className={styles.body}>
          {!model ? (
            <div className={styles.empty}>{t("Select a layer inside a top-level frame to animate it.")}</div>
          ) : (
            <>
              <div className={styles.layers}>
                <div className={styles.layersHead}>{t("Layers")}</div>
                <div ref={rowsEl} className={styles.rows} role="tree" aria-label={t("Animated layers")} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
                  {rows.map((r) =>
                    r.kind === "layer" ? (
                      <LayerRowView key={r.layer.node} layer={r.layer} expanded={!collapsedLayers.has(r.layer.node)} selected={p.selectedNodes.has(r.layer.node)} onToggle={() => setCollapsedLayers((s) => {
                        const n = new Set(s);
                        if (n.has(r.layer.node)) n.delete(r.layer.node);
                        else n.add(r.layer.node);
                        return n;
                      })} onSelect={(additive) => {
                        p.onSelectLayer(r.layer.node, additive);
                        // Selecting a layer in the timeline selects all its keyframes (help).
                        p.onSelectKeyframes(r.layer.tracks.flatMap((tr) => tr.keyframes.map((k) => k.id)));
                        setSelectedRow(null);
                      }} />
                    ) : r.kind === "clip" ? (
                      <button key={r.clip.id} type="button" role="treeitem" aria-level={r.layer.depth + 2} aria-selected={p.selectedClip === r.clip.id} data-clip-row={r.clip.id} className={styles.propertyRow} style={{ "--depth": r.layer.depth } as CSSProperties} onClick={() => {
                        setSelectedRow(null);
                        p.onSelectKeyframes([]);
                        p.onSelectClip?.(r.clip.id);
                      }}>
                        <span className={styles.name}>{clipName(r.clip)}</span>
                      </button>
                    ) : r.kind === "track" ? (
                      <button key={r.track.id} type="button" role="treeitem" aria-level={r.layer.depth + 2} aria-selected={selectedRow?.track === r.track.id} data-track-row={r.track.id} className={styles.propertyRow} style={{ "--depth": r.layer.depth } as CSSProperties} onClick={() => {
                        setSelectedRow({ node: r.layer.node, track: r.track.id });
                        p.onSelectKeyframes(r.track.keyframes.map((k) => k.id));
                      }} onContextMenu={(e) => {
                        const v = vectorKind(r.track);
                        if (!v || readOnly || !p.onCombineTracks) return;
                        e.preventDefault();
                        setRowMenu({ node: r.layer.node, kind: v.kind, combine: !v.combined, at: { x: e.clientX, y: e.clientY } });
                      }}>
                        <span className={styles.name}>{t(r.track.label)}</span>
                      </button>
                    ) : (
                      <div key={r.row.id} role="treeitem" aria-level={1} aria-selected={r.clips.some((c) => c.id === p.selectedAudio)} data-audio-row={r.row.id} className={`${styles.layerRow} ${styles.audioRow}`} data-muted={r.row.mute || undefined}>
                        <span className={styles.chevron} aria-hidden />
                        <span className={styles.glyph}><Icon name="16.audio" /></span>
                        <span className={styles.name}>{r.row.name || t("Audio")}</span>
                        {!readOnly && (
                          <button type="button" className={styles.eye} aria-label={r.row.mute ? t("Unmute audio") : t("Mute audio")} aria-pressed={r.row.mute} data-audio-eye={r.row.id} onClick={() => p.onToggleAudioRow?.(r.row.id, !r.row.mute)}>
                            <Icon name={r.row.mute ? "16.hidden" : "16.visible"} />
                          </button>
                        )}
                      </div>
                    )
                  )}
                </div>
              </div>
              <div ref={tracksEl} className={styles.tracks} tabIndex={0} aria-label={t("Tracks")} onKeyDown={onKeyDown} onWheel={onWheel} onPointerDown={onAreaDown} onCopy={(e) => {
                // ⌘C / ⌘V here are the keyframes' (the document's clipboard events stop at the track area).
                if (!selectedKeyframes.size || readOnly) return;
                e.preventDefault();
                e.stopPropagation();
                p.onCopyKeyframes([...selectedKeyframes]);
              }} onPaste={(e) => {
                if (readOnly || !p.onPasteKeyframes()) return;
                e.preventDefault();
                e.stopPropagation();
              }}>
                <div className={styles.ruler} data-ruler onPointerDown={onRulerDown}>
                  {ticks.map((tk) => (
                    <span key={tk.timeUs} style={{ left: tk.x }}>
                      <span className={styles.tick} data-major={tk.label !== null || undefined} style={{ left: tk.x }} />
                      {tk.label !== null && <span className={styles.tickLabel} style={{ left: tk.x }}>{tk.label}</span>}
                    </span>
                  ))}
                  <div className={styles.playhead} data-auto={autoKeyframe || undefined} style={{ left: playheadX, pointerEvents: "none" }}>
                    <span className={styles.playheadHandle} />
                  </div>
                </div>
                <div className={styles.lanes}>
                  <div className={styles.laneRows} style={{ transform: `translateY(${-scrollTop}px)` }}>
                  {rows.map((r) => (
                    <div key={rowKey(r)} className={styles.lane} aria-selected={r.kind === "track" && selectedRow?.track === r.track.id ? true : undefined} data-lane={rowKey(r)}>
                      {r.kind === "clip" ? (
                        <ClipLane clip={r.clip} scale={scale} selected={p.selectedClip === r.clip.id} onDown={(e, edge) => onClipDown(e, r.clip, edge)} />
                      ) : r.kind === "audio" ? (
                        r.clips.map((c) => (
                          <AudioClipLane key={c.id} clip={c} rowMuted={r.row.mute} scale={scale} selected={p.selectedAudio === c.id} peaks={p.audioPeaks?.(c.mediaHash) ?? null} onDown={(e, edge) => onAudioDown(e, c, edge)} onMenu={readOnly || !p.onAudioMenu ? undefined : (at) => {
                            p.onSelectAudio?.(c.id);
                            setAudioMenu({ clip: c, at });
                          }} />
                        ))
                      ) : r.kind === "layer" ? <LayerLane layer={r.layer} scale={scale} onInstanceDown={readOnly || !p.onMoveInstance ? undefined : (e) => onInstanceDown(e, r.layer)} onBarDown={readOnly || !p.onRetimeLayer ? undefined : (e, edge) => onLayerBarDown(e, r.layer, edge)} /> : <TrackLane track={r.track} scale={scale} durationUs={shownDuration} selected={selectedKeyframes} dragging={drag?.moving ? new Set(drag.items.map((i) => i.id)) : null} onDown={onDiamondDown} onDouble={(k) => {
                        p.onSeek(k.timeUs);
                        p.onSelectLayer(r.layer.node, false);
                      }} onSegment={readOnly ? undefined : (k, anchor) => setEasingAt({ ids: [k.id], easing: k.easingVariable ? { variable: k.easingVariable } : k.easing, resolved: "type" in k.easing ? k.easing : undefined, anchor })} />}
                    </div>
                  ))}
                  </div>
                  <div className={styles.past} style={{ left: timeToX(shownDuration, scale) }} />
                  <div className={styles.playhead} data-auto={autoKeyframe || undefined} style={{ left: playheadX }} />
                </div>
                {marquee && <div className={styles.marquee} data-marquee style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }} />}
                <div className={styles.duration} data-duration-handle data-readonly={readOnly || undefined} style={{ left: timeToX(shownDuration, scale) }} onPointerDown={onDurationDown} role="slider" aria-label={t("Duration")} aria-valuenow={Math.round(shownDuration / 1000)} aria-valuemin={0} aria-valuemax={Math.round(xToTime(width, scale) / 1000)}>
                  <span className={styles.durationHandle} />
                </div>
              </div>
            </>
          )}
        </div>
      )}
      {easingAt && (
        <EasingMenu
          value={easingAt.easing}
          resolved={easingAt.resolved}
          allowVariable={p.easingVariables}
          anchor={easingAt.anchor}
          onChange={(easing, commit) => {
            if (commit) p.onSetEasing(easingAt.ids, easing);
          }}
          onClose={() => setEasingAt(null)}
        />
      )}
      {audioMenu && (
        <ContextMenu at={audioMenu.at} context entries={audioMenuEntries(audioMenu.clip)} label={t("Audio")} onSelect={(id) => p.onAudioMenu?.(audioMenu.clip, id as "mute" | "split" | "delete")} onClose={() => setAudioMenu(null)} />
      )}
      {rowMenu && (
        <ContextMenu at={rowMenu.at} context entries={[{ id: "toggle", label: rowMenu.combine ? t("Combine tracks") : t("Split tracks") }]} label={t("Tracks")} onSelect={() => p.onCombineTracks?.(rowMenu.node, rowMenu.kind, rowMenu.combine)} onClose={() => setRowMenu(null)} />
      )}
      {settingsAt && model && (
        <TimelineSettings
          anchor={settingsAt}
          unit={unit}
          fps={fps}
          playback={model.playback}
          hasAudio={model.audio.length > 0}
          onUnit={(u) => p.onSetUnit?.(u)}
          onFps={(f) => p.onSetTimeline({ snappingFps: f }, true)}
          onPlayback={(m) => p.onSetTimeline({ playback: m }, true)}
          onClose={() => setSettingsAt(null)}
        />
      )}
    </section>
  );
}

function LayerRowView({ layer, expanded, selected, onToggle, onSelect }: { layer: TimelineLayer; expanded: boolean; selected: boolean; onToggle(): void; onSelect(additive: boolean): void }) {
  const leaf = layer.tracks.length === 0 || !!layer.instance;
  return (
    <div role="treeitem" aria-level={layer.depth + 1} aria-selected={selected} aria-expanded={leaf ? undefined : expanded} data-layer-row={layer.node} className={`${styles.layerRow} ${layer.instance ? styles.instanceRow : ""}`} style={{ "--depth": layer.depth } as CSSProperties} tabIndex={0} onClick={(e) => onSelect(e.shiftKey)} onKeyDown={(e) => {
      if (e.key === "Enter") onSelect(false);
      if (e.key === "ArrowRight" && !expanded && !leaf) onToggle();
      if (e.key === "ArrowLeft" && expanded && !leaf) onToggle();
    }}>
      <span className={styles.chevron} data-open={expanded && !leaf ? "" : undefined} onClick={(e) => {
        e.stopPropagation();
        if (!leaf) onToggle();
      }} aria-hidden>
        {!leaf && <Icon name="16.chevron.right" />}
      </span>
      <span className={styles.glyph}><Icon name={iconOf(layer.icon)} /></span>
      <span className={styles.name}>{layer.name}</span>
    </div>
  );
}

/** A clip's name: its preset type's, else the instance's own. */
const clipName = (c: TimelineClip) => t(ANIMATION_PRESETS.find((d) => d.key === c.preset)?.name ?? c.name);

/** A preset's clip: its bar from its start for its length, its name in it, a handle at each side. */
function ClipLane({ clip, scale, selected, onDown }: { clip: TimelineClip; scale: Scale; selected: boolean; onDown(e: ReactPointerEvent<HTMLElement>, edge: "move" | "start" | "end"): void }) {
  return (
    <div className={styles.clip} data-clip={clip.id} data-selected={selected || undefined} data-disabled={clip.disabled || undefined} style={{ left: timeToX(clip.startUs, scale), width: Math.max(6, clip.durationUs * scale.pxPerUs) }} title={clipName(clip)} onPointerDown={(e) => onDown(e, "move")}>
      <span className={styles.clipLabel}>{clipName(clip)}</span>
      <span className={styles.clipHandle} data-clip-handle="start" onPointerDown={(e) => onDown(e, "start")} />
      <span className={styles.clipHandle} data-clip-handle="end" onPointerDown={(e) => onDown(e, "end")} />
    </div>
  );
}

/** An audio clip: its bar over its region with the file's waveform and name, a handle at each side; right-click its menu. */
function AudioClipLane({ clip, rowMuted, scale, selected, peaks, onDown, onMenu }: {
  clip: TimelineAudioClip;
  rowMuted: boolean;
  scale: Scale;
  selected: boolean;
  peaks: Float32Array | null;
  onDown(e: ReactPointerEvent<HTMLElement>, edge: "move" | "start" | "end"): void;
  onMenu?(at: { x: number; y: number }): void;
}) {
  const width = Math.max(6, clip.durationUs * scale.pxPerUs);
  return (
    <div className={styles.audioClip} data-audio-clip={clip.id} data-selected={selected || undefined} data-muted={clip.mute || rowMuted || undefined} style={{ left: timeToX(clip.offsetUs, scale), width }} title={clip.name} onPointerDown={(e) => onDown(e, "move")} onContextMenu={(e) => {
      if (!onMenu) return;
      e.preventDefault();
      e.stopPropagation();
      onMenu({ x: e.clientX, y: e.clientY });
    }}>
      {peaks && (
        <svg className={styles.audioWave} viewBox={`0 0 ${Math.ceil(width)} 16`} preserveAspectRatio="none" aria-hidden>
          <path d={waveformPath(peaks, clip.startUs, clip.durationUs, width, 16)} />
        </svg>
      )}
      <span className={styles.clipLabel}>{clip.name || t("Audio")}</span>
      <span className={styles.clipHandle} data-audio-handle="start" onPointerDown={(e) => onDown(e, "start")} />
      <span className={styles.clipHandle} data-audio-handle="end" onPointerDown={(e) => onDown(e, "end")} />
    </div>
  );
}

/**
 * The layer's lane: its bar from the first to the last keyframe or clip — dragged to move them all, its side handles to
 * scale them about the other end (round 8i) — or an instance's purple clip bar, dragged in time.
 */
function LayerLane({ layer, scale, onInstanceDown, onBarDown }: { layer: TimelineLayer; scale: Scale; onInstanceDown?(e: ReactPointerEvent<HTMLDivElement>): void; onBarDown?(e: ReactPointerEvent<HTMLElement>, edge: "move" | "start" | "end"): void }) {
  if (layer.instance) {
    const x0 = timeToX(layer.instance.offsetUs, scale);
    return <div className={styles.instanceBar} data-instance-bar={layer.node} style={{ left: x0, width: Math.max(4, layer.instance.durationUs * scale.pxPerUs) }} title={layer.name} onPointerDown={onInstanceDown} />;
  }
  const ext = layerExtent(layer);
  if (!ext) return null;
  const x0 = timeToX(ext.startUs, scale);
  const span = ext.endUs > ext.startUs;
  return (
    <div className={styles.layerBar} data-layer-bar={layer.node} data-editable={onBarDown ? "" : undefined} style={{ left: x0, width: Math.max(2, (ext.endUs - ext.startUs) * scale.pxPerUs) }} onPointerDown={onBarDown ? (e) => onBarDown(e, "move") : undefined}>
      {onBarDown && span && (
        <>
          <span className={styles.barHandle} data-bar-handle="start" onPointerDown={(e) => onBarDown(e, "start")} />
          <span className={styles.barHandle} data-bar-handle="end" onPointerDown={(e) => onBarDown(e, "end")} />
        </>
      )}
    </div>
  );
}

/** A Position / Scale row's X / Y / XY kind: what its menu combines or splits (null: another field). */
function vectorKind(track: TimelineTrack): { kind: "POSITION" | "SCALE"; combined: boolean } | null {
  if (track.field.type !== "PROPERTY") return null;
  switch (track.field.name) {
    case "TRANSLATION_X":
    case "TRANSLATION_Y":
      return { kind: "POSITION", combined: false };
    case "TRANSLATION_XY":
      return { kind: "POSITION", combined: true };
    case "SCALE_X":
    case "SCALE_Y":
      return { kind: "SCALE", combined: false };
    case "SCALE_XY":
      return { kind: "SCALE", combined: true };
    default:
      return null;
  }
}

function TrackLane({ track, scale, durationUs, selected, dragging, onDown, onDouble, onSegment }: {
  track: TimelineTrack;
  scale: Scale;
  durationUs: Micros;
  selected: ReadonlySet<GuidString>;
  dragging: ReadonlySet<GuidString> | null;
  onDown(e: ReactPointerEvent<HTMLButtonElement>, k: TimelineKeyframe): void;
  onDouble(k: TimelineKeyframe): void;
  /** Absent (read-only): the segments are drawn, not opened */
  onSegment?(end: TimelineKeyframe, anchor: { x: number; y: number; width: number; height: number }): void;
}) {
  const out: ReactNode[] = [];
  const ks = track.keyframes;
  for (let i = 0; i < ks.length; i++) {
    const k = ks[i];
    if (i > 0) {
      const a = timeToX(ks[i - 1].timeUs, scale) + DIAMOND_PX / 2;
      const b = timeToX(k.timeUs, scale) - DIAMOND_PX / 2;
      const hold = "type" in k.easing && k.easing.type === "HOLD";
      const label = k.easingVariable || !("type" in k.easing) ? t("Easing variable") : t(EASING_LABELS[k.easing.type]);
      if (b > a)
        out.push(
          <button key={`s${k.id}`} type="button" className={styles.segment} data-hold={hold || undefined} data-variable={k.easingVariable ? "" : undefined} data-segment={k.id} aria-label={t("Easing: {name}", { name: label })} disabled={!onSegment} style={{ left: a, width: b - a }} onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            onSegment?.(k, { x: r.left, y: r.top, width: r.width, height: r.height });
          }} />
        );
    }
    const sel = selected.has(k.id);
    out.push(
      <button key={k.id} type="button" className={styles.diamond} data-keyframe={k.id} data-selected={sel || undefined} data-dragging={dragging?.has(k.id) || undefined} data-past={k.timeUs > durationUs || undefined} aria-label={t("Keyframe at {time}", { time: formatTime(k.timeUs, "ms", 60) })} aria-pressed={sel} style={{ left: timeToX(k.timeUs, scale) }} onPointerDown={(e) => onDown(e, k)} onDoubleClick={(e) => {
        e.stopPropagation();
        onDouble(k);
      }}>
        <svg viewBox="0 0 16 16" aria-hidden><path d="M8 2.5 13.5 8 8 13.5 2.5 8Z" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      </button>
    );
  }
  return <>{out}</>;
}
