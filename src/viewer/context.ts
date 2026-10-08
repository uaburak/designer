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
  /** The editor's Dev Mode hosting these panels (absent: the developer preview viewer). */
  host?: ViewerHost;
}

/** What the editor adds when it shows the Dev Mode panels (src/renderer/src/editor/devmode). */
export interface ViewerHost {
  /** Under the file's name in the left panel ("Dev Mode"; the viewer says "Developer preview") */
  subtitle: string;
  /** "Compare changes" on a top-level frame or component (help.figma.com 15023193382935) */
  onCompare?(id: string): void;
  /** "Open in focus view" on a design with a status */
  onFocus?(id: string): void;
  /** The status chip in Inspect's header: its menu */
  onStatus?(id: string, rect: DOMRect): void;
}

export const ViewerContext = createContext<ViewerState | null>(null);

export function useViewer(): ViewerState {
  const v = useContext(ViewerContext);
  if (!v) throw new Error("useViewer outside the viewer");
  return v;
}
