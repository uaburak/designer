/**
 * Stroke settings' limits, Figma's (docs/research/rea/vector.md §14, static): a dash pattern holds at most 8
 * entries, each positive ("A maximum of 8 dash patterns is supported"); `strokeMiterLimit` runs 1–16 (the Miter angle
 * field: 180° … about 7.2°). One reading for the Stroke panel and the Plugin API.
 */

export const MAX_DASHES = 8;
export const MITER_LIMIT_RANGE = [1, 16] as const;

/** Why a dash pattern is refused (Figma's message for the length), or null when it is valid. */
export function dashPatternError(list: readonly unknown[]): string | null {
  if (list.length > MAX_DASHES) return `A maximum of ${MAX_DASHES} dash patterns is supported`;
  if (list.some((n) => typeof n !== "number" || !Number.isFinite(n) || n <= 0)) return "Dash pattern values must be positive numbers";
  return null;
}
