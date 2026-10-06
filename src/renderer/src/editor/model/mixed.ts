/**
 * Figma's "Mixed" (docs/engine.md §10.5: the panels read every selected ref
 * and derive it in TS): one value when every layer agrees, MIXED otherwise.
 */
import { MIXED, type Mixed } from "@/ds/types";
import type { Paint } from "@/engine/codec";

/** The shared value of `values` by `equal`, MIXED when they differ; `undefined` for no values. */
export function mixed<T>(values: readonly T[], equal: (a: T, b: T) => boolean = Object.is): Mixed<T> | undefined {
  if (!values.length) return undefined;
  const first = values[0];
  for (let i = 1; i < values.length; i++) if (!equal(first, values[i])) return MIXED;
  return first;
}

/** Numbers agreeing to `epsilon` (panel precision) count as one. */
export function mixedNumber(values: readonly number[], epsilon = 0.005): Mixed<number> | undefined {
  return mixed(values, (a, b) => Math.abs(a - b) <= epsilon);
}

/** Structural equality for plain data (paints, vectors, settings lists). */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-6;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameData(v, b[i]));
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** A paint list shared by every layer, or MIXED ("Click + to replace mixed fills"). */
export function mixedPaints(lists: readonly (readonly Paint[])[]): Mixed<readonly Paint[]> | undefined {
  return mixed(lists, sameData);
}

/** For a NumericInput: MIXED, the value, or null (nothing to show). */
export const fieldValue = (v: Mixed<number> | undefined): Mixed<number> | null => (v === undefined ? null : v);
