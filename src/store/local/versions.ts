/**
 * Version history rules (docs/data.md §6): autosave checkpoints after 30 min of editing, retention thinning.
 */
import type { VersionRecord } from "../../shared/store/types";

export const CHECKPOINT_INTERVAL_MS = 30 * 60 * 1000;
/** A due checkpoint waits for this long without appends… */
export const CHECKPOINT_QUIET_MS = 2_000;
/** …but no longer than this. */
export const CHECKPOINT_MAX_WAIT_MS = 60_000;

const DAY = 24 * 60 * 60 * 1000;

/**
 * Retention (thinned at store start and after each checkpoint):
 *   named, restore, publish, import → forever
 *   autosave newer than 30 days → all; 30–180 days → the last one of each day; older → the last one of each week.
 * Versions cannot be deleted by hand (Figma has no such action).
 */
export function thinVersions(records: VersionRecord[], now: number): { keep: VersionRecord[]; drop: VersionRecord[] } {
  const keep: VersionRecord[] = [];
  const drop: VersionRecord[] = [];
  const seen = new Set<string>();
  // Newest first, so the first autosave seen in a bucket is that bucket's last one.
  for (const r of [...records].sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq)) {
    if (r.kind !== "autosave") {
      keep.push(r);
      continue;
    }
    const age = now - r.createdAt;
    if (age < 30 * DAY) {
      keep.push(r);
      continue;
    }
    const day = Math.floor(r.createdAt / DAY);
    const bucket = age < 180 * DAY ? `d${day}` : `w${Math.floor((day + 3) / 7)}`; // weeks start on Monday (1970-01-01 was a Thursday)
    if (seen.has(bucket)) drop.push(r);
    else {
      seen.add(bucket);
      keep.push(r);
    }
  }
  return { keep, drop };
}

/** "Restored version from ‹date›" style default titles are the UI's; the store keeps title null unless given. */
export function versionDateLabel(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
