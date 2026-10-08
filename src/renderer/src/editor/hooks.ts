/** React reads of the editor: UI slices, the Layers tree, pages, several nodes at once. */
import { useMemo, useSyncExternalStore } from "react";
import type { Guid, NodeChange, PageInfo } from "@/engine/codec";
import type { Engine } from "@/engine/Engine";
import type { EngineStore, Topic } from "@/engine/EngineStore";
import { useEditor } from "./controller";
import { changesOf } from "./engineCompat";
import type { LayerTree } from "./model/layerTree";
import type { LocalAssets } from "./variables";
import type { LibraryState } from "./libraries";
import { useStoreSlice, type UIState } from "./uiStore";

interface Source<T> {
  subscribe: (listener: () => void) => () => void;
  get: () => T;
}

export function useUI<S>(select: (s: UIState) => S): S {
  return useStoreSlice(useEditor().ui, select);
}

/**
 * The current page's Layers tree, refreshed once per frame after a change (after the gesture while one is live).
 * Two passes (model/layerTree.ts): the tree holds every row's place and kind; a row's name, eye, lock and icon
 * come from `tree.details` as the panel draws it (Layers.tsx prefetches the window of rows it is about to draw).
 */
export function useLayerTree(): LayerTree {
  const ed = useEditor();
  return useSyncExternalStore(ed.subscribeTree, ed.getTreeSnapshot);
}

/** A counter bumped whenever any of `topics` fires. */
function topicsSource(store: EngineStore, topics: readonly Topic[]): Source<number> {
  let version = 0;
  return {
    subscribe: (listener) => {
      const offs = topics.map((t) =>
        store.subscribe(t, () => {
          version++;
          listener();
        })
      );
      return () => offs.forEach((off) => off());
    },
    get: () => version,
  };
}

/** A number that changes whenever any of `topics` fires (for reads that aren't snapshots, like command states). */
export function useTopics(store: EngineStore, topics: readonly Topic[]): number {
  const key = topics.join(",");
  const source = useMemo(() => topicsSource(store, key.split(",") as Topic[]), [store, key]);
  return useSyncExternalStore(source.subscribe, source.get);
}

/** The page list, re-read only when the store's list or the structure version moved (a rename is a structure change). */
function pagesSource(store: EngineStore, engine: Engine): Source<PageInfo[]> {
  let cache: { list: PageInfo[]; structure: number; key: string; pages: PageInfo[] } | null = null;
  return {
    subscribe: (listener) => {
      const a = store.subscribe("pages", listener);
      const b = store.subscribe("structure", listener);
      return () => {
        a();
        b();
      };
    },
    get: () => {
      if (cache && cache.list === store.pages && cache.structure === store.structure) return cache.pages;
      const pages = engine.destroyed ? [] : engine.pages();
      const key = pages.map((p) => `${p.guid}\u0000${p.name}`).join("\u0001");
      cache = { list: store.pages, structure: store.structure, key, pages: cache?.key === key ? cache.pages : pages };
      return cache.pages;
    },
  };
}

/** The pages, in order. */
export function usePages(): PageInfo[] {
  const { store, engine } = useEditor();
  const source = useMemo(() => pagesSource(store, engine), [store, engine]);
  return useSyncExternalStore(source.subscribe, source.get);
}

/** Several nodes, the same array while none of them changed. */
function nodesSource(store: EngineStore, ids: readonly Guid[]): Source<(NodeChange | null)[]> {
  let last: (NodeChange | null)[] = [];
  return {
    subscribe: (listener) => {
      const offs = ids.map((id) => store.subscribeNode(id, listener));
      return () => offs.forEach((off) => off());
    },
    get: () => {
      const next = ids.map((id) => store.readNode(id));
      if (next.length === last.length && next.every((n, i) => n === last[i])) return last;
      last = next;
      return next;
    },
  };
}

/** Several nodes' fields, re-read only when a change touched one of them (stable identity otherwise). */
export function useNodes(refs: readonly Guid[]): (NodeChange | null)[] {
  const { store } = useEditor();
  const key = refs.join(",");
  const source = useMemo(() => nodesSource(store, key ? key.split(",") : []), [store, key]);
  return useSyncExternalStore(source.subscribe, source.get);
}

/** NODES_CHANGED's GEOMETRY and LAYOUT groups: what a move or a resize touches before it commits (engine.md §10.4). */
export const GEOMETRY_GROUPS = 1 | 2;

/**
 * A number bumped by every committed change (DOCUMENT_CHANGED), by structure changes and by live changes
 * (NODES_CHANGED, before a commit) whose field groups intersect `liveGroups` (default: every group) — for reads
 * over many nodes. A reader that doesn't depend on geometry passes `~GEOMETRY_GROUPS`, so a drag's frames don't
 * re-run it.
 */
export function useDocumentVersion(liveGroups = 0xff): number {
  const { engine, store } = useEditor();
  const source = useMemo<Source<number>>(() => {
    let version = 0;
    return {
      subscribe: (listener) => {
        const bump = () => {
          version++;
          listener();
        };
        const offs = [
          engine.on("NODES_CHANGED", (e) => {
            if (e.fieldGroupMask.some((m) => (m & liveGroups) !== 0)) bump();
          }),
          engine.on("DOCUMENT_CHANGED", bump),
          store.subscribe("structure", bump),
        ];
        return () => offs.forEach((off) => off());
      },
      get: () => version,
    };
  }, [engine, store, liveGroups]);
  return useSyncExternalStore(source.subscribe, source.get);
}

/** NODES_CHANGED groups that can change the colours a selection shows (engine.md §10.4: PAINT, VISIBILITY). */
const COLOR_GROUPS = 4 | 32;
/** Committed fields that can change the colours a selection shows, or what is inside it. */
const COLOR_FIELDS = ["fillPaints", "strokePaints", "visible", "mask", "parentIndex", "symbolData", "overriddenSymbolID", "componentPropAssignments"];

/** Does a committed change touch the selection's colours (paints, visibility, masks) or the layers inside it? */
export function changeTouchesColors(message: { nodeChanges: readonly NodeChange[] }): boolean {
  for (const c of message.nodeChanges) {
    if (c.phase !== undefined) return true;
    const f = c as unknown as Record<string, unknown>;
    for (const key of COLOR_FIELDS) if (key in f) return true;
  }
  return false;
}

/**
 * A number bumped only by changes that can alter "Selection colors": a paint or visibility change (live or
 * committed), a layer added, removed or moved, an instance re-pointed — never by a plain move or resize, so a
 * drag doesn't re-read the selected subtree every frame.
 */
export function useSelectionColorsVersion(): number {
  const { engine, store } = useEditor();
  const source = useMemo<Source<number>>(() => {
    let version = 0;
    return {
      subscribe: (listener) => {
        const bump = () => {
          version++;
          listener();
        };
        const offs = [
          engine.on("NODES_CHANGED", (e) => {
            if (e.fieldGroupMask.some((m) => (m & COLOR_GROUPS) !== 0)) bump();
          }),
          engine.on("DOCUMENT_CHANGED", (e) => {
            if (changeTouchesColors({ nodeChanges: changesOf(e) })) bump();
          }),
          engine.on("COMPONENTS_CHANGED", bump),
          store.subscribe("structure", bump),
        ];
        return () => offs.forEach((off) => off());
      },
      get: () => version,
    };
  }, [engine, store]);
  return useSyncExternalStore(source.subscribe, source.get);
}

/** The file's local collections, variables and styles (re-read after a change touches them). */
export function useLocalAssets(): LocalAssets {
  const ed = useEditor();
  const version = useSyncExternalStore(ed.variables.subscribe, ed.variables.getVersion);
  return useMemo(() => {
    void version;
    return ed.variables.get();
  }, [ed, version]);
}

/** This file's libraries (the registry's view, updates, copies), re-read after any library change. */
export function useLibraries(): LibraryState {
  const ed = useEditor();
  const version = useSyncExternalStore(ed.libraries.subscribe, ed.libraries.getVersion);
  return useMemo(() => {
    void version;
    return ed.libraries.get();
  }, [ed, version]);
}
