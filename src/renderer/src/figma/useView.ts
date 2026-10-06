import { useSyncExternalStore } from "react";
import type { CanvasView, ViewStore } from "./view";

/** A view store's view, drawn again when it changes. */
export const useView = (store: ViewStore): CanvasView => useSyncExternalStore(store.subscribe, store.get, store.get);
