/**
 * Figma's 25 built-in brushes under Figma's names, on OUR OWN generated artwork (docs/draw.md §6, round 7e).
 * `builtin.generated.json` is written by `node scripts/brushes.mjs` from `generate.ts` and committed; 7c's
 * `editor/draw/drawTools.ts` picks `BUILTIN_BRUSHES` up (an eager glob) and installs one as a BRUSH node on first use.
 */
import { brushDisplayName, type BrushArtwork, type BrushType, type BuiltinBrush, type BuiltinBrushName } from "../types";
import data from "./builtin.generated.json";

interface GeneratedEntry {
  key: string;
  type: string;
  artwork: { width: number; height: number; d: string; windingRule: string };
}

/** Stretch (Figma's order) then scatter (Figma's order). */
export const BUILTIN_BRUSHES: readonly BuiltinBrush[] = (data as GeneratedEntry[]).map((b) => ({
  key: b.key as BuiltinBrushName,
  name: brushDisplayName(b.key as BuiltinBrushName),
  type: b.type as BrushType,
  artwork: b.artwork as BrushArtwork,
}));

export const builtinBrush = (key: BuiltinBrushName): BuiltinBrush | undefined => BUILTIN_BRUSHES.find((b) => b.key === key);
