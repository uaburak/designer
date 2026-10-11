/** The viewer's engine, its store and the preview, for the panels. */
import { createContext, useContext } from "react";
import type { Engine } from "@/engine/Engine";
import type { EngineStore } from "@/engine/EngineStore";
import type { LoadedPreview } from "./source";
import type { ViewerDoc } from "./viewerDoc";
import type { DevResourceRecord } from "@shared/devmode/types";
import type { CodeConnectSource } from "./inspect/codeConnect";

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
  /** Dev Mode's round 5 data (dev resources, Code Connect, codegen plugins); the viewer gives its preview's */
  dev?: DevData;
}

/** What Inspect reads and changes beyond the document (docs/editor.md D-1, D-3; docs/plugins.md §7). */
export interface DevData {
  /** This file's key (records of its own layers); null: none (a preview without them) */
  fileKey: string | null;
  /** May add, edit and remove dev resources and open the Code Connect UI */
  canEdit: boolean;
  /** A file's dev resources on these nodes (a library's, for a main component of the library) */
  devResources(fileKey: string, nodeIds: string[]): Promise<DevResourceRecord[]>;
  addDevResource?(nodeId: string, input: { name: string; url: string }): Promise<DevResourceRecord>;
  editDevResource?(id: string, patch: { name?: string; url?: string }): Promise<DevResourceRecord>;
  removeDevResource?(id: string): Promise<void>;
  /** The page's title for a link (the desktop app's `devmode:link-title`); null: none, host + path names it */
  linkTitle?(url: string): Promise<string | null>;
  codeConnect: CodeConnectSource;
  /** Records changed (here, or another person's through the room): read again */
  watch(listener: (what: "resources" | "codeConnect") => void): () => void;
  /** Codegen plugins' languages in Inspect › Code (docs/plugins.md §7) */
  codegen?: CodegenHost;
  /** Inspect › Connect components: the Code Connect UI for these components */
  onConnectComponents?(nodeIds: string[]): void;
  /** "Explore component behavior" (D-2) */
  onPlayground?(nodeId: string): void;
  /** Opens a link in the browser */
  openUrl?(url: string): void;
}

/** A codegen plugin's language, as Inspect's language menu lists it after the built-in ones. */
export interface CodegenLanguage {
  pluginId: string;
  pluginName: string;
  label: string;
  value: string;
}

export interface CodegenHost {
  languages(): CodegenLanguage[];
  /** A codegen plugin's results for a node: titled code blocks, or Figma's error */
  generate(lang: CodegenLanguage, nodeId: string): Promise<{ blocks: { title: string; code: string; language: string }[]; error: string | null }>;
  /** The language chosen in the menu (the VM stays alive while it is chosen; null disposes it) */
  select(lang: CodegenLanguage | null): void;
  subscribe(listener: () => void): () => void;
}

export const ViewerContext = createContext<ViewerState | null>(null);

export function useViewer(): ViewerState {
  const v = useContext(ViewerContext);
  if (!v) throw new Error("useViewer outside the viewer");
  return v;
}
