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
  /** View › Pixel grid (⇧'): drawn from 300 % zoom; default on */
  pixelGrid?: boolean;
  /** View › Outlines › Show outlines (⇧⌘O) */
  outlines?: boolean;
  /** View › Layout guides (⇧G); default on */
  layoutGuides?: boolean;
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
  /** File › Export… (⇧⌘E): the page's layers with export settings */
  exportDialog: boolean;
  /** The presentation view over the editor ("Present in this tab"): the page and where it starts */
  presenting: { page: Guid; node: Guid | null } | null;
  /** The inline preview (⇧Space): the page and the frame it started at */
  preview: { page: Guid; node: Guid | null } | null;
  /** Share › developer preview (docs/data.md §13) */
  shareOpen: boolean;
  /** "Create link" (⇧⌘U): the link field, over this rect (viewport px: the caret or the layer) */
  linkEditor?: { x: number; y: number; width: number; height: number } | null;
  /** Grid tracks selected on the canvas (the engine's GRID_TRACKS): the grid, the axis, the tracks' indices */
  gridTracks?: { frame: Guid; axis: "COLUMNS" | "ROWS"; tracks: number[] } | null;
  /** The track label editor on the canvas, over this rect (viewport px) */
  gridTrackEditor?: { x: number; y: number; width: number; height: number } | null;
  /** Dev Mode (⇧D, the toolbar's mode switch): the Inspect panel, read-only canvas, annotations as dots (devmode/) */
  mode?: "design" | "dev";
  /** View › Annotations (labels, dots and saved measurements); default on */
  annotations?: boolean;
  /** The note editor: the layer, which note (−1: a new one), where (viewport px) */
  annotationEditor?: { ref: Guid; index: number; x: number; y: number; width: number; height: number } | null;
  /** A frame's or section's name edited in place over its title on the canvas (viewport px: the title) */
  titleRename?: { ref: Guid; name: string; x: number; y: number; width: number; height: number } | null;
  /** A saved measurement's custom text being edited (viewport px: its pill) */
  measurementEditor?: { id: Guid; text: string; x: number; y: number; width: number; height: number } | null;
  /** A design's status menu (viewport px: the chip) */
  statusMenu?: { ref: Guid; x: number; y: number; width: number; height: number } | null;
  /** Edit categories… */
  categoriesOpen?: boolean;
  /** Compare changes: the design compared */
  compare?: { ref: Guid } | null;
  /** Focus view: the design shown alone */
  focus?: Guid | null;
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
