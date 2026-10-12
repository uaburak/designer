/**
 * Prefetch on intent (Figma's file browser feels instant): resting the pointer on a team or folder row of the sidebar,
 * or on a folder tile, for 150 ms — or focusing it from the keyboard — reads its page into the store's cache
 * (`teams.page` / `projects.page`), so the click shows it at once. Each target is read at most once at a time; leaving
 * before the 150 ms cancels it; a read already sent finishes (it only warms the cache).
 */
import { useEffect, useMemo } from "react";
import type { OrgBackend } from "./storeAccess";

export type PrefetchTarget = { kind: "team"; teamId: string } | { kind: "project"; projectId: string };

/** Spread on the element a pointer rests on or the keyboard focuses */
export interface IntentHandlers {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
}

export const PREFETCH_DELAY_MS = 150;

const keyOf = (t: PrefetchTarget) => (t.kind === "team" ? `team:${t.teamId}` : `project:${t.projectId}`);

export interface Prefetcher {
  /** The pointer rests on it, or it has the focus: read it in 150 ms */
  intent(target: PrefetchTarget): void;
  /** Left before the 150 ms: not read */
  leave(target: PrefetchTarget): void;
  handlers(target: PrefetchTarget): IntentHandlers;
  dispose(): void;
  /** Reads sent so far (tests) */
  readonly sent: number;
}

export function createPrefetcher(org: OrgBackend | undefined, delayMs = PREFETCH_DELAY_MS): Prefetcher {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Set<string>();
  let sent = 0;
  const read = (t: PrefetchTarget): Promise<unknown> | null => {
    if (!org) return null;
    if (t.kind === "team") return org.teams.page ? org.teams.page(t.teamId) : null;
    return org.projects.page ? org.projects.page(t.projectId) : null;
  };
  const self: Prefetcher = {
    intent(t) {
      const k = keyOf(t);
      if (timers.has(k) || running.has(k) || !org) return;
      timers.set(
        k,
        setTimeout(() => {
          timers.delete(k);
          const p = read(t);
          if (!p) return;
          sent++;
          running.add(k);
          const done = () => void running.delete(k);
          p.then(done, done);
        }, delayMs),
      );
    },
    leave(t) {
      const k = keyOf(t);
      const timer = timers.get(k);
      if (timer === undefined) return;
      clearTimeout(timer);
      timers.delete(k);
    },
    handlers(t) {
      return { onMouseEnter: () => self.intent(t), onMouseLeave: () => self.leave(t), onFocus: () => self.intent(t), onBlur: () => self.leave(t) };
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
    get sent() {
      return sent;
    },
  };
  return self;
}

/** One prefetcher per org backend, for the view's lifetime */
export function usePrefetcher(org: OrgBackend | undefined): Prefetcher {
  const p = useMemo(() => createPrefetcher(org), [org]);
  useEffect(() => () => p.dispose(), [p]);
  return p;
}
