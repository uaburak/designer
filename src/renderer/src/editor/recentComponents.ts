/**
 * Recently used components (atlas 10 §8.5, §7.1): Figma adds every inserted instance to the user's recents
 * (`storeInRecentsKey`), and the instance swap picker lists them under "Recently used" (its starting section when the
 * property has no preferred values and the current component's library has none). Kept per file, newest first, in
 * this computer's localStorage (a viewer's convenience: nothing in the document); how many Figma keeps is
 * unverified — 20 here.
 */
import type { Guid } from "@/engine/codec";

/** How many are kept (ours). */
export const RECENT_COMPONENTS_MAX = 20;

const keyOf = (file: string) => `wecra.recentComponents.${file}`;

/** The file's recently used components (their ids, a set's or a component's), newest first. */
export function recentComponents(file: string): Guid[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(keyOf(file)) : null;
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** `id` used now: first in the file's recents (once), the oldest past the limit dropped. */
export function addRecentComponent(file: string, id: Guid): void {
  const next = [id, ...recentComponents(file).filter((x) => x !== id)].slice(0, RECENT_COMPONENTS_MAX);
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(keyOf(file), JSON.stringify(next));
  } catch {
    // Storage unavailable (a private window): recents aren't kept.
  }
}
