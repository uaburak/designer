/** Typeahead over a list's labels (menus, selects): 500ms buffer. */
export const TYPEAHEAD_MS = 500;

/** The first item after `from` (wrapping) whose label starts with `query`, ignoring case; null labels are skipped; -1 if none. */
export function typeahead(labels: (string | null)[], from: number, query: string): number {
  const q = query.toLocaleLowerCase();
  if (!q) return -1;
  const n = labels.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + k) % n) + n) % n;
    const l = labels[i];
    if (l !== null && l.toLocaleLowerCase().startsWith(q)) return i;
  }
  return -1;
}

/** A buffer of typed letters: `push(key)` returns the query so far (reset after a pause). */
export function createTypeahead(ms = TYPEAHEAD_MS, now: () => number = Date.now) {
  let text = "";
  let at = 0;
  return {
    push(key: string): string {
      const t = now();
      text = t - at < ms ? text + key : key;
      at = t;
      return text;
    },
  };
}
