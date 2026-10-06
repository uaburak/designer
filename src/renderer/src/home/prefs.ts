import { useSyncExternalStore } from "react";

/**
 * What the home remembers on this computer (not in the site's data): the
 * files opened lately, the starred ones, how the lists are shown. Every
 * page of the app sees the same (localStorage; a change in one is told to
 * the others).
 */

const EVENT = "designer-prefs-change";

function store<T>(key: string, fallback: T, valid: (value: unknown) => value is T) {
  let cache: { raw: string | null; value: T } | null = null;
  const get = (): T => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      /* blocked: the fallback */
    }
    if (cache && cache.raw === raw) return cache.value;
    let value = fallback;
    try {
      const parsed: unknown = raw === null ? fallback : JSON.parse(raw);
      if (valid(parsed)) value = parsed;
    } catch {
      /* broken: the fallback */
    }
    cache = { raw, value };
    return value;
  };
  const set = (next: T | ((prev: T) => T)) => {
    const value = typeof next === "function" ? (next as (prev: T) => T)(get()) : next;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* this page only */
    }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: key }));
  };
  const subscribe = (cb: () => void) => {
    const local = (e: Event) => (e as CustomEvent).detail === key && cb();
    const other = (e: StorageEvent) => (e.key === key || e.key === null) && cb();
    window.addEventListener(EVENT, local);
    window.addEventListener("storage", other);
    return () => {
      window.removeEventListener(EVENT, local);
      window.removeEventListener("storage", other);
    };
  };
  const use = () => useSyncExternalStore(subscribe, get, () => fallback);
  return { get, set, use };
}

const isArray = (v: unknown): v is unknown[] => Array.isArray(v);

// ── Opened lately ──

export interface Opened {
  slug: string;
  /** ms */
  at: number;
}

const recents = store<Opened[]>("designer-recents", [], (v): v is Opened[] => isArray(v) && v.every((x) => x && typeof (x as Opened).slug === "string" && typeof (x as Opened).at === "number"));

/** A project opened now: first among the recent ones (the last 50 kept). */
export const rememberOpened = (slug: string) => recents.set((list) => [{ slug, at: Date.now() }, ...list.filter((o) => o.slug !== slug)].slice(0, 50));
export const forgetOpened = (slugs: string[]) => recents.set((list) => list.filter((o) => !slugs.includes(o.slug)));
export const useRecents = recents.use;

// ── Starred ──

const starred = store<string[]>("designer-starred", [], (v): v is string[] => isArray(v) && v.every((x) => typeof x === "string"));

export const useStarred = starred.use;
export const setStarred = (slugs: string[], on: boolean) => starred.set((list) => (on ? [...list, ...slugs.filter((s) => !list.includes(s))] : list.filter((s) => !slugs.includes(s))));

// ── How the lists are shown ──

export type Layout = "grid" | "list";
export type Sort = "modified" | "opened" | "created" | "name" | "order";
export type Filter = "all" | "published" | "drafts" | "changed";

export interface Browse {
  layout: Layout;
  sort: Sort;
  filter: Filter;
  starredOpen: boolean;
}

const browse = store<Browse>("designer-browse", { layout: "grid", sort: "modified", filter: "all", starredOpen: true }, (v): v is Browse => Boolean(v && typeof v === "object" && "layout" in v && "sort" in v));

export const useBrowse = browse.use;
export const setBrowse = (patch: Partial<Browse>) => browse.set((prev) => ({ ...prev, ...patch }));
