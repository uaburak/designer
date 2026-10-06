import { useCallback, useEffect, useRef } from "react";

/**
 * Undo and redo, as Figma's ⌘Z / ⇧⌘Z: the last `limit` steps of what is
 * edited, kept in memory only — nothing is written anywhere (the project and
 * the design system reach Firestore with Kaydet alone, see the editor).
 * Edits in quick succession (typing, a drag, a resize) are one step: a new
 * step starts after `pause` ms without an edit. `state` is compared piece by
 * piece, by reference — memoize it on its pieces.
 */
export function useUndo<S extends object>(
  state: S,
  restore: (state: S) => void,
  { ready, limit = 20, pause = 600 }: { ready: boolean; limit?: number; pause?: number }
) {
  const history = useRef<{ past: S[]; future: S[]; current: S | null; last: number }>({ past: [], future: [], current: null, last: 0 });
  const restoreRef = useRef(restore);
  useEffect(() => {
    restoreRef.current = restore;
  });

  // Every change of what is edited: a step starts (what was there goes to the past), or the step goes on.
  useEffect(() => {
    if (!ready) return;
    const h = history.current;
    if (!h.current) {
      h.current = state;
      return;
    }
    const current = h.current;
    const keys = Object.keys(state) as (keyof S)[];
    if (keys.length === Object.keys(current).length && keys.every((key) => state[key] === current[key])) return;
    const now = Date.now();
    if (now - h.last > pause) {
      h.past = [...h.past, current].slice(-limit);
      h.future = [];
    }
    h.last = now;
    h.current = state;
  }, [ready, state, limit, pause]);

  /** One step back — false when there is none. */
  const undo = useCallback(() => {
    const h = history.current;
    const previous = h.past[h.past.length - 1];
    if (!previous || !h.current) return false;
    h.past = h.past.slice(0, -1);
    h.future = [h.current, ...h.future];
    h.current = previous;
    // The next edit is a step of its own.
    h.last = 0;
    restoreRef.current(previous);
    return true;
  }, []);

  /** One step forward again — false when there is none. */
  const redo = useCallback(() => {
    const h = history.current;
    const next = h.future[0];
    if (!next || !h.current) return false;
    h.future = h.future.slice(1);
    h.past = [...h.past, h.current].slice(-limit);
    h.current = next;
    h.last = 0;
    restoreRef.current(next);
    return true;
  }, [limit]);

  /** How many steps there are to undo and to redo (read when needed — a menu opening). */
  const counts = useCallback(() => ({ undo: history.current.past.length, redo: history.current.future.length }), []);

  return { undo, redo, counts };
}

export type UndoHistory = ReturnType<typeof useUndo>;
