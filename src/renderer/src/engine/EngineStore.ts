/**
 * The engine's state as an external store for React (docs/engine.md §10.5):
 * immutable snapshots per topic, replaced only when an event touches them, so
 * `useSyncExternalStore` re-renders exactly the components that read what
 * changed. The camera is a topic too, but nothing should put it in React state
 * on every frame: rulers and the zoom label subscribe and read it when told.
 */
import type { Camera, Guid, NodeChange, PageInfo, Selection, UndoState } from "./codec";
import type { Engine } from "./Engine";
import type { FacetName } from "./facets.generated";

/** NODES_CHANGED's GEOMETRY group (engine.md §10.4): what a gesture's frames change. */
const GEOMETRY_GROUP = 1;
/** What a geometry-only change can touch, read typed (engine_read_facets) instead of the whole node as JSON. */
const GEOMETRY_FACETS: readonly FacetName[] = ["geometry", "shape", "stroke"];

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
  /** Per node, the version of its last change that wasn't geometry only (a full read is needed past it). */
  private readonly fullVersions = new Map<Guid, number>();
  private readonly nodes = new Map<Guid, { version: number; full: number; node: NodeChange | null }>();
  /** Reads answered by patching geometry (typed facets) / by a full JSON read (tests, the bench). */
  readonly reads = { patched: 0, full: 0 };
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
          // A gesture's frames (geometry only) are patched in from typed facet reads; anything else is read again.
          event.refs.forEach((ref, i) => this.touch(ref, ((event.fieldGroupMask[i] ?? 0xff) & ~GEOMETRY_GROUP) === 0));
          return;
        case "DOCUMENT_CHANGED":
          // Either wire: a kiwi-wire message carries GUID objects (docs/engine-build.md "Figma parity round 3").
          for (const change of event.message.nodeChanges) {
            const g = change.guid as Guid | { sessionID: number; localID: number };
            this.touch(typeof g === "string" ? g : `${g.sessionID}:${g.localID}`);
          }
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

  /**
   * The node's fields, re-read from the engine only after a change touched it (stable identity otherwise). After
   * geometry-only changes (a drag's or a resize's frames) the cached node is patched from the typed geometry facets
   * (engine_read_facets: no JSON, a few dozen numbers) instead of reading every field again.
   */
  readNode(ref: Guid): NodeChange | null {
    const version = this.versions.get(ref) ?? 0;
    const full = this.fullVersions.get(ref) ?? 0;
    const cached = this.nodes.get(ref);
    if (cached && cached.version === version) return cached.node;
    if (this.engine.destroyed) {
      this.nodes.set(ref, { version, full, node: null });
      return null;
    }
    let node: NodeChange | null;
    if (cached?.node && cached.full === full) {
      const patch = this.engine.readFacets([ref], GEOMETRY_FACETS)[0];
      node = patch ? ({ ...cached.node, ...patch } as NodeChange) : null;
      this.reads.patched++;
    } else {
      node = this.engine.readNode(ref);
      this.reads.full++;
    }
    this.nodes.set(ref, { version, full, node });
    return node;
  }

  private touch(ref: Guid, geometryOnly = false): void {
    this.versions.set(ref, (this.versions.get(ref) ?? 0) + 1);
    if (!geometryOnly) this.fullVersions.set(ref, (this.fullVersions.get(ref) ?? 0) + 1);
    this.nodeListeners.get(ref)?.forEach((l) => l());
  }

  private emit(topic: Topic): void {
    this.listeners.get(topic)?.forEach((l) => l());
  }
}
