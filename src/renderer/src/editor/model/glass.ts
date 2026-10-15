/**
 * Figma's glass effect fields (docs/research/rea/effects.md §2.14, from the Plugin API converter): Depth =
 * `refractionRadius` (1–100), Splay = `reflectionDistance` (0–1), light Angle = `specularAngle` (stored −899…900,
 * shown (a + 360) % 360), Intensity = `specularIntensity`, Refraction = `refractionIntensity`, Dispersion =
 * `chromaticAberration`, Frost = `radius`; `bevelSize` is always 1. One glass per node.
 */
import type { Effect } from "@/engine/codec";

/** Figma's new glass (its effect panel's template). */
export const GLASS_DEFAULTS = {
  radius: 4,
  specularAngle: -45,
  specularIntensity: 0.8,
  refractionIntensity: 0.8,
  refractionRadius: 20,
  bevelSize: 1,
  chromaticAberration: 0.5,
  reflectionDistance: 0,
} as const;

/** Figma's message when a second glass is set on a node. */
export const ONE_GLASS = "Only one glass effect is allowed per node.";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * A glass as Figma's fields. Wecra wrote Depth in `bevelSize` and Splay (0–100) in `refractionRadius` before round 17;
 * Figma always writes `bevelSize` 1, so a larger one is such a glass — moved over, as the engine reads it.
 */
export function figmaGlass<E extends Effect>(e: E): E {
  if (e.type !== "GLASS") return e;
  const bevel = e.bevelSize;
  if (typeof bevel !== "number" || !(bevel > 1)) return e;
  const splay = typeof e.refractionRadius === "number" ? clamp01(e.refractionRadius / 100) : 0;
  return { ...e, refractionRadius: bevel, reflectionDistance: typeof e.reflectionDistance === "number" ? e.reflectionDistance : splay, bevelSize: 1 };
}

/** The light angle as the panel shows it: 0–359°. */
export const shownAngle = (a: number) => ((Math.round(a) % 360) + 360) % 360;

/** Whether `effects` holds more than one glass (Figma allows one per node). */
export const tooManyGlass = (effects: readonly { type?: string }[]) => effects.filter((e) => e.type === "GLASS").length > 1;
