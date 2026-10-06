/** React reads of the editor: UI slices, the Layers tree, pages, several nodes at once. */
import { useMemo, useSyncExternalStore } from "react";
import type { Guid, NodeChange, PageInfo } from "@/engine/codec";
import type { Engine } from "@/engine/Engine";
import type { EngineStore, Topic } from "@/engine/EngineStore";
import { useEditor } from "./controller";
import type { LayerTree } from "./model/layerTree";
import { useStoreSlice, type UIState } from "./uiStore";

interface Source<T> {
  subscribe: (listener: () => void) => () => void;
  get: () => T;
}

export function useUI<S>(select: (s: UIState) => S): S {
  return useStoreSlice(useEditor().ui, select);
}

export function useLayerTree(): LayerTree {
  const ed = useEditor();
  return useSyncExternalStore(ed.subscribeTree, ed.getTree);
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
