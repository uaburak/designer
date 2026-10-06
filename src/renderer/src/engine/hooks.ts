/** React hooks over an EngineStore (useSyncExternalStore: a component re-renders only for its topic). */
import { useCallback, useSyncExternalStore } from "react";
import type { Camera, Guid, NodeChange, Selection, UndoState } from "./codec";
import type { EngineStore, Topic } from "./EngineStore";

function useTopic<T>(store: EngineStore, topic: Topic, read: (store: EngineStore) => T): T {
  const subscribe = useCallback((listener: () => void) => store.subscribe(topic, listener), [store, topic]);
  return useSyncExternalStore(subscribe, () => read(store));
}

export const useSelection = (store: EngineStore): Selection => useTopic(store, "selection", (s) => s.selection);
export const useTool = (store: EngineStore): string => useTopic(store, "tool", (s) => s.tool);
export const useUndoState = (store: EngineStore): UndoState => useTopic(store, "undo", (s) => s.undo);
export const useHover = (store: EngineStore): Guid | null => useTopic(store, "hover", (s) => s.hover);
export const useCurrentPage = (store: EngineStore): Guid => useTopic(store, "page", (s) => s.page);
/** For a zoom label: re-renders on every camera change — keep the component small. */
export const useCamera = (store: EngineStore): Camera => useTopic(store, "camera", (s) => s.camera);

/** One node's fields for a panel, re-read only when a change touched it. */
export function useNode(store: EngineStore, ref: Guid | null): NodeChange | null {
  const subscribe = useCallback((listener: () => void) => (ref ? store.subscribeNode(ref, listener) : () => {}), [store, ref]);
  return useSyncExternalStore(subscribe, () => (ref ? store.readNode(ref) : null));
}
