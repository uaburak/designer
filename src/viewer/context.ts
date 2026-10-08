/** The viewer's engine, its store and the preview, for the panels. */
import { createContext, useContext } from "react";
import type { Engine } from "@/engine/Engine";
import type { EngineStore } from "@/engine/EngineStore";
import type { LoadedPreview } from "./source";
import type { ViewerDoc } from "./viewerDoc";

export interface ViewerState {
  engine: Engine;
  store: EngineStore;
  doc: ViewerDoc;
  preview: LoadedPreview;
}

export const ViewerContext = createContext<ViewerState | null>(null);

export function useViewer(): ViewerState {
  const v = useContext(ViewerContext);
  if (!v) throw new Error("useViewer outside the viewer");
  return v;
}
