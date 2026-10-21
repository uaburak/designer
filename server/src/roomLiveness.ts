/**
 * The room's liveness schedule (docs/multiplayer.md §4.1), apart from `FileRoom` so Node tests reach it: sweeps run at
 * most every SWEEP_EVERY_MS on messages, and the object's one alarm — shared with autosave and Discovery — rings at
 * least that often while sockets are open.
 */

/** Liveness sweeps: at most this often on messages, and the alarm at least this often while sockets are open */
export const SWEEP_EVERY_MS = 30_000;

/**
 * The one alarm's time when presence wants a sweep: `at` (autosave / Discovery, null: none) or the next sweep, the
 * earlier — `at` unchanged with no socket open.
 */
export function withSweep(at: number | null, sockets: number, now: number): number | null {
  if (!sockets) return at;
  const sweep = now + SWEEP_EVERY_MS;
  return at === null ? sweep : Math.min(at, sweep);
}
