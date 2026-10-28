/**
 * The room's liveness schedule (docs/multiplayer.md §4.1), apart from `FileRoom` so Node tests reach it: sweeps run at
 * most every SWEEP_EVERY_MS on messages, and the object's one alarm — shared with autosave and Discovery — rings at
 * least that often while two or more member sockets are open. One alone has nobody to show a ghost to: its sweeps wait
 * for the next join or message (2026-10-28: every desktop app keeps each shared file's room open, and a ring every 30 s
 * in ~35 rooms used up the month's included Durable Objects requests).
 */

/** Liveness sweeps: at most this often on messages, and the alarm at least this often while 2+ sockets are open */
export const SWEEP_EVERY_MS = 30_000;

/**
 * The one alarm's time when presence wants a sweep: `at` (autosave / Discovery, null: none) or the next sweep, the
 * earlier — `at` unchanged with fewer than two sockets open.
 */
export function withSweep(at: number | null, sockets: number, now: number): number | null {
  if (sockets < 2) return at;
  const sweep = now + SWEEP_EVERY_MS;
  return at === null ? sweep : Math.min(at, sweep);
}
