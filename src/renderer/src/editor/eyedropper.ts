/**
 * The eyedropper's choices (Figma's DROPPER_COLOR, atlas 07 §6): the colour under the pointer may be a local colour
 * variable's or a fill style's — its card's second row then names it, and holding ⇧ applies the colour bound to it;
 * otherwise a click samples the colour onto the selection, or with nothing selected copies it (in the colour format)
 * to the clipboard. The card (canvas/CanvasTools.tsx) keeps what ⇧ would apply here for the pick (canvasTools.ts).
 */
import type { Color } from "@/engine/codec";
import type { EditorController } from "./controller";
import type { LocalAssets } from "./variables";
import { resolveVariable } from "./model/variables";

export type EyedropperMatch = { kind: "variable" | "style"; id: string; name: string };

const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
const same = (a: Pick<Color, "r" | "g" | "b">, b: Pick<Color, "r" | "g" | "b">) => byte(a.r) === byte(b.r) && byte(a.g) === byte(b.g) && byte(a.b) === byte(b.b);

/**
 * The local colour variable (its default mode's value, opaque) or else the fill style (one visible opaque solid paint)
 * whose colour is `color` at 8-bit precision; null when none is. Variables first, as Figma lists them before styles.
 */
export function matchColor(assets: Pick<LocalAssets, "variables" | "styles" | "lookup">, color: Pick<Color, "r" | "g" | "b">): EyedropperMatch | null {
  for (const v of assets.variables) {
    if (v.type !== "COLOR") continue;
    const value = resolveVariable(v.id, assets.lookup);
    if (value && typeof value === "object" && (value.a ?? 1) >= 1 && same(value, color)) return { kind: "variable", id: v.id, name: v.name };
  }
  for (const s of assets.styles) {
    if (s.kind !== "FILL") continue;
    const paints = ((s.node as { fillPaints?: { type?: string; visible?: boolean; opacity?: number; color?: Color }[] }).fillPaints ?? []).filter((p) => p.visible !== false);
    const p = paints.length === 1 ? paints[0] : null;
    if (p?.type === "SOLID" && p.color && (p.opacity ?? 1) >= 1 && same(p.color, color)) return { kind: "style", id: s.id, name: s.name };
  }
  return null;
}

/** What the next pick binds (⇧ held over a match), per editor. */
const chosen = new WeakMap<EditorController, EyedropperMatch | null>();
export const setEyedropperChoice = (ed: EditorController, match: EyedropperMatch | null) => void chosen.set(ed, match);
export const eyedropperChoice = (ed: EditorController): EyedropperMatch | null => chosen.get(ed) ?? null;
