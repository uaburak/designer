/**
 * Figma's facepile rules (atlas 19 §4.5, `2108.min.js`), pure: how many others the header shows for its width, where
 * the overflow starts, and the order people are listed in.
 */

/** Width per avatar in the header (24 px avatars, 21 apart) */
export const FACE_STEP = 21;
/** Others shown at most */
export const MAX_FACES = 8;
/** Shown when the width isn't known (the properties panel closed) */
export const FACES_UNMEASURED = 3;
/** The Multiplayer tools popover's search shows past this many people (you included) */
export const SEARCH_PAST = 8;

/** `min(floor(width / 21) + 1, 8)`, or 3 without a measured width */
export function maxFaces(availableWidth: number | null): number {
  if (availableWidth === null || !Number.isFinite(availableWidth)) return FACES_UNMEASURED;
  return Math.max(1, Math.min(Math.floor(availableWidth / FACE_STEP) + 1, MAX_FACES));
}

/** The others shown before the count takes over: all when they fit, else `max − 1` (the count chip is the last) */
export function shownFaces<T>(people: readonly T[], max: number): T[] {
  return people.length >= max ? people.slice(0, Math.max(0, max - 1)) : [...people];
}

export interface FaceRank {
  id: number;
  name: string;
  /** No name (a link visitor not signed in): last */
  anonymous?: boolean;
}

/**
 * Figma's order: the presenter, the person you follow, the file's creator, the one speaking most in the conversation,
 * everyone else, anonymous people last; ties by lower-cased name, then session.
 */
export function sortFaces<T extends FaceRank>(people: readonly T[], ctx: { presenter?: number | null; following?: number | null; creator?: (p: T) => boolean; speaker?: number | null }): T[] {
  const rank = (p: T) =>
    p.anonymous ? 6 : p.id === ctx.presenter ? 1 : p.id === ctx.following ? 2 : ctx.creator?.(p) ? 3 : p.id === ctx.speaker ? 4 : 5;
  return [...people].sort((a, b) => rank(a) - rank(b) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id - b.id);
}

/**
 * One session per running app (docs/multiplayer.md §4.1): were the room ever to list the same person's same app twice
 * (an older socket not yet expired), only its newest session (the highest) is kept. Apps that don't say which they are
 * (no `client`) are all kept. Order is kept.
 */
export function dedupePeers<T extends { sessionID: number; userId: string; client?: string }>(peers: readonly T[]): T[] {
  const newest = new Map<string, number>();
  for (const p of peers) {
    if (!p.client) continue;
    const k = `${p.userId}\u0000${p.client}`;
    newest.set(k, Math.max(newest.get(k) ?? 0, p.sessionID));
  }
  return peers.filter((p) => !p.client || newest.get(`${p.userId}\u0000${p.client}`) === p.sessionID);
}
