/**
 * The first-party animation presets (docs/motion.md §4.6; round 8h): our own code against the `figma:motion` runtime
 * (../runtime), written from Figma's catalogue and defaults (types.ts ANIMATION_PRESETS; docs/research/rea/motion.md
 * §2.18) — Figma's sources are not copied. Each returns its tracks over the clip, from 0 to its duration, with the
 * clip's easing on every keyframe:
 * - Opacity: OPACITY, SCALE (Fade in amount → 100 %, Fade out 100 % → amount, Custom start → end).
 * - Position: TRANSLATION_XY, OFFSET (Slide in from `distance` back along the direction to 0, Slide out from 0 along it).
 * - Scale: SCALE_XY, SCALE (Scale in amount → 100 %, Scale out 100 % → amount).
 * - Rotation: ROTATION, OFFSET (a clockwise Rotate in turns from +amount° to 0 — Figma's −amount → 0 in its stored
 *   −radians; Rotate out from 0 on).
 * - Size: WIDTH and HEIGHT, OFFSET (Resize in −amount → 0, Resize out 0 → −amount).
 * - Corner Radius: CORNER_RADIUS, OFFSET (Round in 0 → amount, Round out amount → 0).
 * - Path: PATH_TRIM_*, SET (Draw: the end 0 → 1, Erase: the start 0 → 1, Travel: a `segment` long piece along it).
 * - Text: a typewriter — each character, word or line appears in turn (OPACITY held at 0, then 1, no overlap).
 * - Text stagger (§4.10): its sub-animations (position, rotation, scale, opacity) per element, `overlap` % overlapping.
 * [unverified] A direction is the way the layer travels (Slide in "Left" comes from the right); Figma's arrows were
 * not seen.
 */
import { animate, tween, type PresetCode, type PresetContext } from "../runtime";
import { ANIMATION_PRESETS, TIMING_PROP_KEYS, type PresetKey, type PresetOutput, type PresetPropValue, type TextStaggerOutput } from "../types";

const DIRECTION: Record<string, { x: number; y: number }> = {
  left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 },
  top_left: { x: -1, y: -1 }, top_right: { x: 1, y: -1 }, bottom_left: { x: -1, y: 1 }, bottom_right: { x: 1, y: 1 },
};

const num = (v: PresetPropValue | undefined, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: PresetPropValue | undefined, fallback: string) => (typeof v === "string" ? v : fallback);
const along = (direction: string, distance: number) => {
  const d = DIRECTION[direction] ?? DIRECTION.left;
  return { x: d.x * distance, y: d.y * distance };
};

/** in / out / custom from a preset's `type`: the pair of values its one tween runs between. */
function inOut<V>(type: string, inType: string, outType: string, inFrom: V, rest: V, custom: [V, V]): [V, V] {
  if (type === inType) return [inFrom, rest];
  if (type === outType) return [rest, inFrom];
  return custom;
}

const opacity: PresetCode = ({ props, duration, easing }) => {
  const amount = num(props.amount, 0) / 100;
  const [from, to] = inOut(str(props.type, "fadeIn"), "fadeIn", "fadeOut", amount, 1, [num(props.start, 0) / 100, num(props.end, 100) / 100]);
  return { tracks: [animate("OPACITY", tween({ mode: "SCALE", duration, from, to, easing }))] };
};

const position: PresetCode = ({ props, duration, easing }) => {
  const type = str(props.type, "slide_in");
  const travel = along(str(props.direction, "left"), num(props.distance, 200));
  const away = { x: -travel.x, y: -travel.y };
  const zero = { x: 0, y: 0 };
  const [from, to] =
    type === "slide_in" ? [away, zero] : type === "slide_out" ? [zero, travel] : [{ x: num(props.startX, 200), y: num(props.startY, 200) }, { x: num(props.endX, 0), y: num(props.endY, 0) }];
  return { tracks: [animate("TRANSLATION_XY", tween({ mode: "OFFSET", duration, from, to, easing }))] };
};

const scale: PresetCode = ({ props, duration, easing }) => {
  const [from, to] = inOut(str(props.type, "scaleIn"), "scaleIn", "scaleOut", num(props.amount, 120) / 100, 1, [num(props.start, 120) / 100, num(props.end, 100) / 100]);
  return { tracks: [animate("SCALE_XY", tween({ mode: "SCALE", duration, from, to, easing }))] };
};

const rotation: PresetCode = ({ props, duration, easing }) => {
  // Public degrees are counter-clockwise: a clockwise turn ends at 0 from a positive angle.
  const sign = str(props.direction, "clockwise") === "counterclockwise" ? -1 : 1;
  const amount = num(props.amount, 180);
  const type = str(props.type, "rotateIn");
  const [from, to] = type === "rotateIn" ? [sign * amount, 0] : type === "rotateOut" ? [0, -sign * amount] : [num(props.start, 180), num(props.end, 0)];
  return { tracks: [animate("ROTATION", tween({ mode: "OFFSET", duration, from, to, easing }))] };
};

const size: PresetCode = ({ props, duration, easing }) => {
  const [from, to] = inOut(str(props.type, "resize_in"), "resize_in", "resize_out", -num(props.amount, 50), 0, [num(props.start, 50), num(props.end, 100)]);
  return { tracks: [animate("WIDTH", tween({ mode: "OFFSET", duration, from, to, easing })), animate("HEIGHT", tween({ mode: "OFFSET", duration, from, to, easing }))] };
};

const cornerRadius: PresetCode = ({ props, duration, easing }) => {
  // Figma's: Round out [amount, 0], otherwise [0, amount] (probe 5.11).
  const amount = num(props.amount, 10);
  const type = str(props.type, "roundIn");
  const [from, to] = type === "roundOut" ? [amount, 0] : type === "custom" ? [num(props.start, 0), num(props.end, 10)] : [0, amount];
  return { tracks: [animate("CORNER_RADIUS", tween({ mode: "OFFSET", duration, from, to, easing }))] };
};

const path: PresetCode = ({ props, duration, easing }) => {
  const type = str(props.type, "draw");
  const t = (from: number, to: number) => tween({ mode: "SET", duration, from, to, easing });
  if (type === "erase") return { tracks: [animate("PATH_TRIM_START", t(0, 1))] };
  if (type === "travel") {
    const seg = Math.min(1, Math.max(0, num(props.segment, 10) / 100));
    return { tracks: [animate("PATH_TRIM_START", t(0, 1 - seg)), animate("PATH_TRIM_END", t(seg, 1))] };
  }
  if (type === "custom") return { tracks: [animate("PATH_TRIM_END", t(num(props.start, 0) / 100, num(props.end, 100) / 100))] };
  return { tracks: [animate("PATH_TRIM_END", t(0, 1))] };
};

const text: PresetCode = ({ props, duration }) => {
  const by = str(props.revealBy, "character");
  const stagger: TextStaggerOutput = { grouping: by === "word" ? "WORD" : by === "line" ? "LINE" : "CHARACTER", order: "LEFT_RIGHT", overlap: 0 };
  // Each element held invisible over its slot, then shown: a typewriter.
  return { tracks: [animate("OPACITY", tween({ mode: "SCALE", duration, from: 0, to: 1, easing: { type: "HOLD" } }))], textStagger: stagger };
};

const textStagger: PresetCode = ({ props, duration, easing }) => {
  const enter = str(props.animationDirection, "in") !== "out";
  const pair = <V,>(away: V, rest: V): [V, V] => (enter ? [away, rest] : [rest, away]);
  const tracks = [];
  if (props.position !== false) {
    const travel = along(str(props.positionDirection, "top"), num(props.positionDistance, 40));
    const [from, to] = enter ? [{ x: -travel.x, y: -travel.y }, { x: 0, y: 0 }] : [{ x: 0, y: 0 }, travel];
    tracks.push(animate("TRANSLATION_XY", tween({ mode: "OFFSET", duration, from, to, easing })));
  }
  if (props.rotation === true) {
    const [from, to] = pair(num(props.rotationAmount, 180), 0);
    tracks.push(animate("ROTATION", tween({ mode: "OFFSET", duration, from, to, easing })));
  }
  if (props.scale === true) {
    const [from, to] = pair(num(props.scaleAmount, 120) / 100, 1);
    tracks.push(animate("SCALE_XY", tween({ mode: "SCALE", duration, from, to, easing })));
  }
  if (props.opacity === true) {
    const [from, to] = pair(num(props.opacityAmount, 0) / 100, 1);
    tracks.push(animate("OPACITY", tween({ mode: "SCALE", duration, from, to, easing })));
  }
  const grouping = str(props.textDelayGrouping, "CHARACTER") as TextStaggerOutput["grouping"];
  const order = str(props.textDelayOrder, "LEFT_RIGHT") as TextStaggerOutput["order"];
  return { tracks, textStagger: { grouping, order, overlap: Math.min(100, Math.max(0, num(props.presetStaggerOverlap, 50))), clipContent: props.clipContent === true } };
};

export const PRESET_CODE: Record<PresetKey, PresetCode> = {
  new: () => ({ tracks: [] }),
  opacity,
  position,
  scale,
  rotation,
  size,
  cornerRadius,
  path,
  text,
  textStagger,
};

/** A preset's props with its defaults filled in (the shared Delay, Duration and Easing left out: they are the clip's). */
export function presetProps(key: PresetKey, props: Record<string, PresetPropValue> = {}): Record<string, PresetPropValue> {
  const def = ANIMATION_PRESETS.find((p) => p.key === key);
  const out: Record<string, PresetPropValue> = {};
  for (const d of def?.props ?? []) if (!TIMING_PROP_KEYS.includes(d.key)) out[d.key] = props[d.key] ?? d.default;
  return out;
}

/** A preset's code run: its output for these props, clip length (s) and easing. */
export function runPreset(key: PresetKey, ctx: Omit<PresetContext, "props"> & { props?: Record<string, PresetPropValue> }): PresetOutput {
  return PRESET_CODE[key]({ ...ctx, props: presetProps(key, ctx.props) });
}
