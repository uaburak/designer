/**
 * The engine's state as an external store for React (docs/engine.md §10.5):
 * immutable snapshots per topic, replaced only when an event touches them, so
 * `useSyncExternalStore` re-renders exactly the components that read what
 * changed. The camera is a topic too, but nothing should put it in React state
 * on every frame: rulers and the zoom label subscribe and read it when told.
 */
import type { Camera, Guid, NodeChange, PageInfo, Selection, UndoState } from "./codec";
import type { Engine } from "./Engine";

export type Topic = "selection" | "tool" | "undo" | "camera" | "hover" | "pages" | "page" | "structure";

const NO_UNDO: UndoState = { canUndo: false, canRedo: false, undoLabel: "", redoLabel: "" };

export class EngineStore {
  readonly engine: Engine;
  selection: Selection;
  tool = "MOVE";
  undo: UndoState = NO_UNDO;
  hover: Guid | null = null;
  pages: PageInfo[];
  page: Guid;
  /** Bumped by any change to the current page's tree (Layers). */
  structure = 0;

  private cameraValue: Camera | null = null;
  private readonly listeners = new Map<Topic, Set<() => void>>();
  private readonly nodeListeners = new Map<Guid, Set<() => void>>();
  private readonly versions = new Map<Guid, number>();
  private readonly nodes = new Map<Guid, { version: number; node: NodeChange | null }>();
  private readonly unsubscribe: () => void;

  constructor(engine: Engine) {
    this.engine = engine;
    this.selection = engine.getSelection();
    this.pages = engine.pages();
    this.page = this.selection.pageId;
    this.unsubscribe = engine.onAny((event) => {
      switch (event.type) {
        case "SELECTION_CHANGED":
          this.selection = { pageId: event.pageId, refs: event.refs };
          return this.emit("selection");
        case "TOOL_CHANGED":
          this.tool = event.tool;
          return this.emit("tool");
        case "UNDO_STATE":
          this.undo = { canUndo: event.canUndo, canRedo: event.canRedo, undoLabel: event.undoLabel, redoLabel: event.redoLabel };
          return this.emit("undo");
        case "CAMERA_CHANGED":
          this.cameraValue = { x: event.x, y: event.y, zoom: event.zoom };
          return this.emit("camera");
        case "HOVER_CHANGED":
          this.hover = event.ref;
          return this.emit("hover");
        case "PAGES_CHANGED":
          this.pages = engine.pages();
          return this.emit("pages");
        case "CURRENT_PAGE_CHANGED":
          this.page = event.pageId;
          return this.emit("page");
        case "STRUCTURE_CHANGED":
          this.structure++;
          return this.emit("structure");
        case "NODES_CHANGED":
          for (const ref of event.refs) this.touch(ref);
          return;
        case "DOCUMENT_CHANGED":
          for (const change of event.message.nodeChanges) this.touch(change.guid);
          return;
      }
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
    this.nodeListeners.clear();
  }

  subscribe(topic: Topic, listener: () => void): () => void {
    let set = this.listeners.get(topic);
    if (!set) this.listeners.set(topic, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  /** The camera now (read when "camera" fires; not React state). */
  get camera(): Camera {
    this.cameraValue ??= this.engine.getCamera();
    return this.cameraValue;
  }

  subscribeNode(ref: Guid, listener: () => void): () => void {
    let set = this.nodeListeners.get(ref);
    if (!set) this.nodeListeners.set(ref, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  /** The node's fields, re-read from the engine only after a change touched it (stable identity otherwise). */
  readNode(ref: Guid): NodeChange | null {
    const version = this.versions.get(ref) ?? 0;
    const cached = this.nodes.get(ref);
    if (cached && cached.version === version) return cached.node;
    const node = this.engine.destroyed ? null : this.engine.readNode(ref);
    this.nodes.set(ref, { version, node });
    return node;
  }

  private touch(ref: Guid): void {
    this.versions.set(ref, (this.versions.get(ref) ?? 0) + 1);
    this.nodeListeners.get(ref)?.forEach((l) => l());
  }

  private emit(topic: Topic): void {
    this.listeners.get(topic)?.forEach((l) => l());
  }
}
