/**
 * The agents' `animate` tool (docs/research/motion-for-agents.md §3a, docs/motion.md §9.2): a GSAP-like timeline script,
 * compiled by animateScript.ts, written as native Motion — manual keyframe tracks (publicApi.applyManualKeyframeTrack, so
 * Figma's checks hold), a text's own stagger (MOTION_SET_TEXT_STAGGER), anchors (MOTION_SET_ANCHOR), a layer blur effect
 * where `blur` needs one, and the timeline's settings — in one write, so a call is one undo step and the result is edited
 * in the timeline and exported to every format like hand-made motion.
 *
 * Channels → fields: x / y → TRANSLATION_X / _Y (an XY track's other axis kept), rotate (clockwise +, CSS's) → ROTATION
 * (counter-clockwise +, negated), scale → SCALE_XY (or SCALE_X / _Y with scaleX / scaleY), skewX (degrees) → MOTION_SHEAR
 * (tan), arcStart / arcEnd (degrees) → ARC_DATA_* (radians), fill / stroke → the first SOLID paint, blur → the layer blur's
 * radius, trimStart / trimEnd → PATH_TRIM_*, the rest one to one.
 */
import type { Guid, NodeChange } from "@/engine/codec";
import { textResult, type ToolResult } from "@shared/agents/tools";
import type { KeyframeField, KeyframeValue, MotionEasing, RGBA } from "@shared/motion/types";
import type { ToolEnv } from "./mcpTools";
import { ToolError } from "./toolError";
import { normId, type Spec } from "./nodeSpec";
import { CHANNELS, compileScript, ScriptError, type Channel, type Compiled, type Host, type Key, type Split, type Value } from "./animateScript";
import { applyManualKeyframeTrack, manualKeyframeTracks, removeManualKeyframeTrack, setTimeline, timelineOf, timelineRootOf, type PublicKeyframe } from "../motion/publicApi";
import { defaultEffect } from "../panels/design/Effects";

const US = 1e6;
const DEG = Math.PI / 180;
const ID = /^\d+[:-]\d+$/;

type Info = { id: Guid; name: string; type: string; parent: Guid | null; children: Guid[] };

/** The frame's layers by id, in layer order (the root first). */
function treeOf(env: ToolEnv, root: Guid): Map<Guid, Info> {
  const nodes = env.ed.engine.readNodes([root], { subtree: true, childIds: true, fields: ["name", "type", "parentIndex"] }).map(env.ed.withRealType);
  const byId = new Map<Guid, Info>();
  for (const n of nodes) {
    const id = normId(n.guid);
    if (!id) continue;
    byId.set(id, { id, name: String(n.name ?? ""), type: String(n.type ?? ""), parent: normId(n.parentIndex?.guid) || null, children: ((n.childIds ?? []) as unknown[]).map((c) => normId(c)).filter(Boolean) });
  }
  // Layer order: depth first from the root.
  const ordered = new Map<Guid, Info>();
  const walk = (id: Guid) => {
    const i = byId.get(id);
    if (!i || ordered.has(id)) return;
    ordered.set(id, i);
    i.children.forEach(walk);
  };
  walk(root);
  return ordered;
}

/** "Title" (every layer so named), "Card/Title" (a path down the tree), "Cards/*" (children), "12:34" (an id). */
function resolveTargets(tree: Map<Guid, Info>, root: Guid, targets: unknown, at: string): { ids: string[]; warnings: string[] } {
  const list = Array.isArray(targets) ? targets : [targets];
  if (!list.length || list.some((t) => typeof t !== "string" || !t.trim())) throw new ScriptError(`${at}: a layer id ("12:34"), a layer name ("Title"), a path ("Card/Title", "Cards/*") or a list of them`);
  const ids: string[] = [];
  const warnings: string[] = [];
  const all = [...tree.values()].filter((i) => i.id !== root);
  for (const raw of list as string[]) {
    const s = raw.trim();
    let found: Info[];
    if (ID.test(s)) {
      const id = normId(s);
      const hit = tree.get(id);
      found = hit && id !== root ? [hit] : [];
      if (!hit) warnings.push(`${at}: ${s} isn't a layer of this frame`);
      else if (id === root) warnings.push(`${at}: ${s} is the top-level frame — it is the timeline; animate its layers (or wrap them in a frame)`);
    } else {
      const parts = s.split("/").map((p) => p.trim()).filter(Boolean);
      const match = (i: Info, p: string) => p === "*" || i.name === p;
      found = all.filter((i) => match(i, parts[0]));
      if (!found.length && parts[0] !== "*") found = all.filter((i) => i.name.toLowerCase() === parts[0].toLowerCase());
      for (const p of parts.slice(1)) {
        const next: Info[] = [];
        for (const f of found) for (const c of f.children) {
          const ci = tree.get(c);
          if (ci && (match(ci, p) || ci.name.toLowerCase() === p.toLowerCase())) next.push(ci);
        }
        found = next;
      }
      if (!found.length) warnings.push(`${at}: no layer named "${s}" in this frame`);
    }
    for (const f of found) if (!ids.includes(f.id)) ids.push(f.id);
  }
  return { ids, warnings };
}

type Read = NodeChange & { pathTrim?: { value?: { x: number; y: number } } };

const firstSolid = (paints: NodeChange["fillPaints"]) => (paints ?? []).findIndex((p) => p.type === "SOLID" && p.visible !== false);
const blurIndex = (n: Read) => (n.effects ?? []).findIndex((e) => e.type === "FOREGROUND_BLUR");
const SHAPES_WITH_STROKE_TRIM = new Set(["VECTOR", "LINE", "ELLIPSE", "RECTANGLE", "ROUNDED_RECTANGLE", "REGULAR_POLYGON", "STAR", "BOOLEAN_OPERATION"]);

/** A channel's value at rest, in the script's units; null when the layer can't take it. */
function restOf(n: Read, c: Channel): Value | null {
  const type = String(n.type ?? "");
  const stacked = n.stackMode !== undefined && n.stackMode !== "NONE";
  switch (c) {
    case "x": case "y": case "rotate": case "skewX": return 0;
    case "scale": case "scaleX": case "scaleY": return 1;
    case "opacity": return n.opacity ?? 1;
    case "width": case "height": return type === "GROUP" || type === "VECTOR" || type === "BOOLEAN_OPERATION" ? null : (c === "width" ? n.size?.x : n.size?.y) ?? 0;
    case "cornerRadius": return n.cornerRadius ?? 0;
    case "strokeWeight": return n.strokeWeight ?? 1;
    case "fill": case "stroke": {
      const paints = c === "fill" ? n.fillPaints : n.strokePaints;
      const i = firstSolid(paints);
      if (i < 0) return null;
      const p = paints![i];
      const col = p.color ?? { r: 0, g: 0, b: 0, a: 1 };
      return { r: col.r, g: col.g, b: col.b, a: col.a ?? 1 };
    }
    case "blur": { const i = blurIndex(n); return i >= 0 ? (n.effects![i].radius ?? 0) : 0; }
    case "trimStart": case "trimEnd": {
      if (!SHAPES_WITH_STROKE_TRIM.has(type) || !(n.strokePaints ?? []).length) return null;
      const v = n.pathTrim?.value;
      return c === "trimStart" ? (v?.x ?? 0) : (v?.y ?? 1);
    }
    case "arcStart": case "arcEnd": case "arcInnerRadius": {
      if (type !== "ELLIPSE") return null;
      const a = n.arcData ?? { startingAngle: 0, endingAngle: 2 * Math.PI, innerRadius: 0 };
      return c === "arcStart" ? a.startingAngle / DEG : c === "arcEnd" ? a.endingAngle / DEG : a.innerRadius;
    }
    case "starInnerRadius": return type === "STAR" ? (n.starInnerScale ?? 0.38) : null;
    case "pointCount": return type === "STAR" || type === "REGULAR_POLYGON" ? (n.count ?? (type === "STAR" ? 5 : 3)) : null;
    case "gap": return stacked ? (n.stackSpacing ?? 0) : null;
    case "paddingLeft": return stacked ? (n.stackHorizontalPadding ?? 0) : null;
    case "paddingTop": return stacked ? (n.stackVerticalPadding ?? 0) : null;
    case "paddingRight": return stacked ? (n.stackPaddingRight ?? n.stackHorizontalPadding ?? 0) : null;
    case "paddingBottom": return stacked ? (n.stackPaddingBottom ?? n.stackVerticalPadding ?? 0) : null;
  }
  return null;
}

const ONE_TO_ONE: Partial<Record<Channel, string>> = {
  x: "TRANSLATION_X", y: "TRANSLATION_Y", rotate: "ROTATION", skewX: "MOTION_SHEAR", opacity: "OPACITY", width: "WIDTH", height: "HEIGHT",
  cornerRadius: "CORNER_RADIUS", strokeWeight: "STROKE_WEIGHT", trimStart: "PATH_TRIM_START", trimEnd: "PATH_TRIM_END",
  arcStart: "ARC_DATA_STARTING_ANGLE", arcEnd: "ARC_DATA_ENDING_ANGLE", arcInnerRadius: "ARC_DATA_INNER_RADIUS", starInnerRadius: "STAR_INNER_SCALE",
  pointCount: "POLYGON_COUNT", gap: "STACK_SPACING", paddingTop: "STACK_PADDING_TOP", paddingRight: "STACK_PADDING_RIGHT",
  paddingBottom: "STACK_PADDING_BOTTOM", paddingLeft: "STACK_PADDING_LEFT",
};

/** Script units → the field's public units (and back). */
const toField = (c: Channel, v: number): number => (c === "rotate" ? -v : c === "skewX" ? Math.tan(v * DEG) : c === "arcStart" || c === "arcEnd" ? v * DEG : v);
const fromField = (c: Channel, v: number): number => (c === "rotate" ? -v : c === "skewX" ? Math.atan(v) / DEG : c === "arcStart" || c === "arcEnd" ? v / DEG : v);

const easingOf = (e: unknown): MotionEasing => (e && typeof e === "object" && "type" in (e as object) && (e as { type: string }).type !== "VARIABLE_ALIAS" ? (e as MotionEasing) : { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.5, y1: 0, x2: 0.5, y2: 1 } });

/** The layer's existing keys on a channel, in script units (mode "merge", and an XY track's other axis). */
function existingKeys(env: ToolEnv, id: Guid, c: Channel): Key[] {
  const tracks = manualKeyframeTracks(env.ed, id) as Record<string, { keyframes: PublicKeyframe[] } | Record<number, { keyframes: PublicKeyframe[] }>>;
  const read = (track: { keyframes: PublicKeyframe[] } | undefined, pick: (v: KeyframeValue) => Value | null): Key[] =>
    (track?.keyframes ?? []).flatMap((k) => {
      const v = pick(k.value);
      return v === null ? [] : [{ t: k.timelinePosition, v, ease: easingOf(k.easing) }];
    });
  const num = (v: KeyframeValue) => (v.type === "FLOAT" ? fromField(c, v.value) : null);
  const vec = (axis: "x" | "y") => (v: KeyframeValue) => (v.type === "VECTOR" ? v.value[axis] : v.type === "FLOAT" ? v.value : null);
  const t = (name: string) => tracks[name] as { keyframes: PublicKeyframe[] } | undefined;
  if (c === "x" || c === "y") return t(`TRANSLATION_${c.toUpperCase()}`) ? read(t(`TRANSLATION_${c.toUpperCase()}`), num) : read(t("TRANSLATION_XY"), vec(c));
  if (c === "scale") return t("SCALE_XY") ? read(t("SCALE_XY"), vec("x")) : read(t("SCALE_X"), num);
  if (c === "scaleX" || c === "scaleY") return t(c === "scaleX" ? "SCALE_X" : "SCALE_Y") ? read(t(c === "scaleX" ? "SCALE_X" : "SCALE_Y"), num) : read(t("SCALE_XY"), vec(c === "scaleX" ? "x" : "y"));
  if (c === "fill" || c === "stroke") {
    const n = env.ed.engine.readNode(id, { fields: ["fillPaints", "strokePaints"] }) as Read | null;
    const i = firstSolid(c === "fill" ? n?.fillPaints : n?.strokePaints);
    const coll = tracks[c === "fill" ? "fills" : "strokes"] as Record<number, { keyframes: PublicKeyframe[] }> | undefined;
    return i >= 0 ? read(coll?.[i], (v) => (v.type === "COLOR" ? (v.value as RGBA) : null)) : [];
  }
  if (c === "blur") {
    const n = env.ed.engine.readNode(id, { fields: ["effects"] }) as Read | null;
    const i = n ? blurIndex(n) : -1;
    const eff = (tracks as { effects?: Record<number, Record<string, { keyframes: PublicKeyframe[] }>> }).effects;
    return i >= 0 ? read(eff?.[i]?.RADIUS, num) : [];
  }
  const name = ONE_TO_ONE[c];
  return name ? read(t(name), num) : [];
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The frame the script animates: nodeId's, else the first id target's, else the selection's. */
function rootFor(env: ToolEnv, args: Spec): Guid {
  const tryRoot = (id: unknown) => {
    const n = normId(id);
    return n && env.ed.engine.readNode(n, { fields: ["name"] }) ? timelineRootOf(env.ed, n) : null;
  };
  const explicit = args.nodeId ?? args.frameId;
  if (explicit !== undefined) {
    const r = tryRoot(explicit);
    if (!r) throw new ToolError(`animate: nodeId ${String(explicit)} isn't in a top-level frame (a page's direct child holds the timeline). Use get_metadata to find ids.`);
    return r;
  }
  for (const tw of Array.isArray(args.tweens) ? (args.tweens as Spec[]) : []) {
    for (const t of Array.isArray(tw?.targets) ? tw.targets : [tw?.targets]) {
      if (typeof t === "string" && ID.test(t.trim())) {
        const r = tryRoot(t.trim());
        if (r) return r;
      }
    }
  }
  const sel = env.ed.selection[0];
  const r = sel ? tryRoot(sel) : null;
  if (!r) throw new ToolError("animate: nodeId — the top-level frame whose timeline this is (or give a layer id in targets).");
  return r;
}

const round = (s: number) => Math.round(s * 1000) / 1000;

/** animate: the script compiled and written; a summary back. */
export function animateTool(env: ToolEnv, args: Spec): ToolResult {
  const root = rootFor(env, args);
  const tree = treeOf(env, root);
  const timeline = (args.timeline && typeof args.timeline === "object" ? args.timeline : {}) as Spec;
  const mode = args.mode === undefined ? "replace" : String(args.mode);
  if (mode !== "replace" && mode !== "merge") throw new ToolError('animate.mode: "replace" (the script owns the properties it animates; default) or "merge" (keys added to what the layers have)');
  if (timeline.duration !== undefined && !(finite(timeline.duration) && timeline.duration > 0 && timeline.duration <= 600)) throw new ToolError("animate.timeline.duration: seconds, more than 0, at most 600");
  const reads = new Map<Guid, Read>();
  const nodeOf = (id: Guid): Read => {
    let n = reads.get(id);
    if (!n) {
      n = (env.ed.engine.readNode(id, { fields: ["type", "opacity", "size", "cornerRadius", "strokeWeight", "fillPaints", "strokePaints", "effects", "pathTrim", "arcData", "starInnerScale", "count", "stackMode", "stackSpacing", "stackHorizontalPadding", "stackVerticalPadding", "stackPaddingRight", "stackPaddingBottom", "textData"] }) ?? {}) as Read;
      n = env.ed.withRealType(n) as Read;
      reads.set(id, n);
    }
    return n;
  };
  const host: Host = {
    resolve: (targets, at) => resolveTargets(tree, root, targets, at),
    rest: (id, c) => restOf(nodeOf(id), c),
    existing: (id, c) => existingKeys(env, id, c),
    elements: (id, split: Split) => {
      const n = nodeOf(id);
      if (n.type !== "TEXT") return null;
      const s = n.textData?.characters ?? "";
      if (split === "chars") return [...s].filter((ch) => !/\s/.test(ch)).length;
      if (split === "words") return s.split(/\s+/).filter(Boolean).length;
      return s.split(/[\n\u2028]/).length;
    },
  };
  let compiled: Compiled;
  try {
    compiled = compileScript({ tweens: args.tweens, defaults: args.defaults }, host, { timelineDuration: finite(timeline.duration) ? timeline.duration : undefined, offset: finite(args.offset) ? args.offset : 0, merge: mode === "merge" });
  } catch (e) {
    if (e instanceof ScriptError) throw new ToolError(`animate: ${e.message}`);
    throw e;
  }
  const warnings = [...compiled.warnings];
  const written: Record<string, { name: string; fields: Record<string, number> }> = {};
  const touched = [...compiled.layers.keys()].filter((id) => compiled.layers.get(id)!.channels.size || compiled.layers.get(id)!.origin);

  env.write("Animate", () => {
    for (const id of touched) {
      const L = compiled.layers.get(id)!;
      const info = tree.get(id);
      const fields: Record<string, number> = {};
      const put = (field: KeyframeField | string, keyframes: { timelinePosition: number; value: KeyframeValue; easing: MotionEasing }[]) => {
        applyManualKeyframeTrack(env.ed, id, field, { keyframes });
        fields[typeof field === "string" ? field : field.type === "INDEXED_ITEM" ? `${field.collection}[${field.index}]${"field" in field && field.field ? `.${field.field}` : ""}` : field.name] = keyframes.length;
      };
      const pub = (keys: Key[], value: (v: Value) => KeyframeValue) => keys.map((k) => ({ timelinePosition: Math.round(k.t * US) / US, value: value(k.v), easing: k.ease }));
      const float = (c: Channel) => (v: Value): KeyframeValue => ({ type: "FLOAT", value: toField(c, v as number) });
      const ch = L.channels;
      const unknown = [...ch.keys()].filter((c) => !(CHANNELS as readonly string[]).includes(c));
      if (unknown.length) throw new ToolError(`animate: unknown properties ${unknown.join(", ")}`);
      // The anchor first, so the keys are about it.
      if (L.origin) {
        const status = env.ed.engine.runMotionCommand("MOTION_SET_ANCHOR", { nodes: [id], x: L.origin.x, y: L.origin.y, keepInPlace: false });
        if (status !== 0) warnings.push(`${id}: the transform origin was refused (status ${status})`);
      }
      // Position: X and Y tracks (an XY track's other axis kept as its own track).
      const tracks = manualKeyframeTracks(env.ed, id) as Record<string, unknown>;
      if (ch.has("x") || ch.has("y")) {
        const other = (c: "x" | "y") => (ch.get(c) ?? (tracks.TRANSLATION_XY ? existingKeys(env, id, c) : null));
        const xs = other("x"), ys = other("y");
        if (tracks.TRANSLATION_XY) removeManualKeyframeTrack(env.ed, id, "TRANSLATION_XY");
        if (xs?.length) put("TRANSLATION_X", pub(xs, float("x")));
        if (ys?.length) put("TRANSLATION_Y", pub(ys, float("y")));
      }
      // Scale: one XY track for a uniform scale, X / Y with scaleX / scaleY (or when the layer already splits them).
      if (ch.has("scale") || ch.has("scaleX") || ch.has("scaleY")) {
        if (ch.has("scale") && (ch.has("scaleX") || ch.has("scaleY"))) throw new ToolError(`animate: ${info?.name ?? id} — scale, or scaleX / scaleY, not both on one layer`);
        const split = ch.has("scaleX") || ch.has("scaleY") || !!tracks.SCALE_X || !!tracks.SCALE_Y;
        if (split) {
          const sx = ch.get("scaleX") ?? ch.get("scale") ?? existingKeys(env, id, "scaleX");
          const sy = ch.get("scaleY") ?? ch.get("scale") ?? existingKeys(env, id, "scaleY");
          if (tracks.SCALE_XY) removeManualKeyframeTrack(env.ed, id, "SCALE_XY");
          if (sx.length) put("SCALE_X", pub(sx, float("scaleX")));
          if (sy.length) put("SCALE_Y", pub(sy, float("scaleY")));
        } else put("SCALE_XY", pub(ch.get("scale")!, (v) => ({ type: "VECTOR", value: { x: v as number, y: v as number } })));
      }
      for (const [c, keys] of ch) {
        if (["x", "y", "scale", "scaleX", "scaleY"].includes(c) || !keys.length) continue;
        if (c === "fill" || c === "stroke") {
          const n = nodeOf(id);
          const i = firstSolid(c === "fill" ? n.fillPaints : n.strokePaints);
          put({ type: "INDEXED_ITEM", collection: c === "fill" ? "fills" : "strokes", index: i }, pub(keys, (v) => ({ type: "COLOR", value: v as RGBA })));
          continue;
        }
        if (c === "blur") {
          const n = nodeOf(id);
          let i = blurIndex(n);
          if (i < 0) {
            // A layer blur at 0 (invisible at rest) for the radius to animate.
            const effects = [...(n.effects ?? []), { ...defaultEffect("FOREGROUND_BLUR"), radius: 0 }];
            const status = env.ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: env.ed.source.sessionID ?? 1, nodeChanges: [{ guid: id, effects } as NodeChange] }, "user");
            if (status !== 0) throw new ToolError(`animate: a layer blur couldn't be added to ${info?.name ?? id} (status ${status})`);
            i = effects.length - 1;
            n.effects = effects;
          }
          put({ type: "INDEXED_ITEM", collection: "effects", index: i, field: "RADIUS" }, pub(keys, float("blur")));
          continue;
        }
        put(ONE_TO_ONE[c]!, pub(keys, float(c)));
      }
      if (L.textStagger) {
        const status = env.ed.engine.runMotionCommand("MOTION_SET_TEXT_STAGGER", { node: id, enabled: true, ...L.textStagger });
        if (status !== 0) warnings.push(`${id}: the text stagger was refused (status ${status})`);
      }
      written[id] = { name: info?.name ?? id, fields };
    }
    // The timeline: as the script says, else grown to hold it (never shortened).
    const m = timelineOf(env.ed, root);
    const patch: { duration?: number; playback?: "LOOP" | "ONCE" | "PING_PONG"; fps?: number } = {};
    if (finite(timeline.duration)) patch.duration = timeline.duration;
    else if (m && compiled.end > m.durationUs / US + 1e-6) patch.duration = Math.min(600, Math.ceil(compiled.end * 100) / 100);
    if (timeline.playback !== undefined) {
      const p = String(timeline.playback).toUpperCase().replace("-", "_");
      if (!["LOOP", "ONCE", "PING_PONG"].includes(p)) throw new ToolError("animate.timeline.playback: LOOP, ONCE or PING_PONG");
      patch.playback = p as "LOOP" | "ONCE" | "PING_PONG";
    }
    if (finite(timeline.fps)) patch.fps = timeline.fps;
    if (Object.keys(patch).length) setTimeline(env.ed, root, null, patch);
  }, touched);

  const m = timelineOf(env.ed, root);
  const r = textResult({
    timeline: m ? { id: m.timelineId, frame: m.rootName, duration: m.durationUs / US, playback: m.playback } : null,
    tweens: compiled.tweens.map((t) => ({ index: t.index, targets: t.targets.map((id) => ({ id, name: tree.get(id)?.name })), start: round(t.start), end: round(t.end), ...(t.label ? { label: t.label } : {}) })),
    labels: Object.fromEntries(Object.entries(compiled.labels).map(([k, v]) => [k, round(v)])),
    end: round(compiled.end),
    layers: written,
    ...(warnings.length ? { warnings } : {}),
    next: "Look at it: get_motion_frames {nodeId, count: 8} — then refine (animate again; mode merge keeps the rest).",
  });
  r.touched = touched;
  return r;
}
