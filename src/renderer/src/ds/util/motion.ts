/**
 * The system's Reduce motion (atlas 21 §4.2): Figma's animated viewport navigation (zoom to a layer, going to a
 * comment, a page jump) jumps at once when `prefers-reduced-motion: reduce` matches — read at each move, so a change in
 * the system's settings holds from the next one. The chrome's CSS follows the same query (global.css).
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A camera glide's length: `ms`, or 0 (a jump) with Reduce motion on. */
export const glideMs = (ms: number): number => (prefersReducedMotion() ? 0 : ms);
