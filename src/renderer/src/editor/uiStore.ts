/**
 * The editor's own UI state (panel widths, which rail tab, hidden UI, the
 * layer being renamed, expanded layers…): one immutable snapshot in a tiny
 * external store, read with `useUI(selector)` so a component re-renders only
 * when what it selects changes. Document state is never here — it is the
 * engine's (EngineStore).
 */
import { useCallback, useSyncExternalStore } from "react";
import type { Camera, Guid } from "@/engine/codec";
import type { ImportedImage } from "./images";

export type RailTab = "file" | "assets";
export type Renaming = { kind: "layer" | "page" | "file"; id: Guid } | null;

export interface UIState {
  fileName: string;
  railTab: RailTab;
  leftWidth: number;
  rightWidth: number;
  rightTab: "design" | "prototype";
  /** ⌘\ — every panel hidden */
  uiHidden: boolean;
  /** ⇧\ — panels collapsed into floating cards */
  uiMinimized: boolean;
  /** ⇧R */
  rulers: boolean;
  renaming: Renaming;
  /** Layers shown open, every page's */
  expanded: ReadonlySet<Guid>;
  /** ⇧-click's anchor in the Layers panel */
  anchor: Guid | null;
  /** The Pages search, null while closed */
  pageSearch: string | null;
  /** The shortcuts help (⌃⇧?) */
  shortcutsOpen: boolean;
  /** Figma's "Property labels" (zoom menu) */
  propertyLabels: boolean;
  /** Version history: "Save to version history" (⌥⌘S) or the list */
  versionDialog: "save" | "history" | null;
  /** The context menu over the canvas or a layer: where it opens (view px) and, on the canvas, the point it was opened at (canvas CSS px) */
  contextMenu: { x: number; y: number; canvas: { x: number; y: number } | null; layers?: Guid[] } | null;
  /** Images chosen with the Image tool, waiting for a click each (the first is next) */
  placingImages: readonly ImportedImage[] | null;
  /** After "Go to main component": where "Return to instance" goes back to */
  returnToInstance: { instance: Guid; page: Guid; camera: Camera } | null;
  /** Assets: grid or list */
  assetsView: "grid" | "list";
  /** Assets: the closed page / frame groups */
  assetsClosed: ReadonlySet<string>;
  /** The Local variables window */
  variablesOpen: boolean;
  /** Styles list (nothing selected): the closed folders ("KIND:path") */
  stylesClosed: ReadonlySet<string>;
  /** The Libraries modal: its tab, and the library previewed (null: the list) */
  librariesDialog: { tab: "libraries" | "updates"; library?: string | null; update?: string | null } | null;
  /** The Publish library modal */
  publishOpen: boolean;
  /** Share › developer preview (docs/data.md §13) */
  shareOpen: boolean;
}

export class Store<T> {
  private value: T;
  private readonly listeners = new Set<() => void>();

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    return this.value;
  }

  set(patch: Partial<T> | ((s: T) => Partial<T>)): void {
    const next = typeof patch === "function" ? patch(this.value) : patch;
    let changed = false;
    for (const k of Object.keys(next) as (keyof T)[])
      if (!Object.is(this.value[k], next[k])) {
        changed = true;
        break;
      }
    if (!changed) return;
    this.value = { ...this.value, ...next };
    this.listeners.forEach((l) => l());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

/** A slice of a Store; re-renders when the selected value changes (by Object.is). */
export function useStoreSlice<T, S>(store: Store<T>, select: (s: T) => S): S {
  const get = useCallback(() => select(store.get()), [store, select]);
  return useSyncExternalStore(store.subscribe, get);
}
