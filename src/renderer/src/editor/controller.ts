/**
 * One open file's editor (docs/editor.md §2): the engine and its store, the
 * document source, the editor's UI state, the Layers tree read from the
 * engine, and the command registry the menus, shortcuts and buttons share.
 * Not React: components get it from EditorContext and read through hooks.
 */
import { createContext, useContext } from "react";
import { KEY_HANDLED, Status, TOOLS, type ToolName } from "@/engine/abi";
import type { Guid, NodeChange, NodeFields } from "@/engine/codec";
import type { Engine } from "@/engine/Engine";
import type { EngineStore } from "@/engine/EngineStore";
import { size } from "@/ds/tokens";
import type { ChangeInfo } from "@/ds/types";
import type { DocumentSource } from "./documentSource";
import { engineCall, keepsField } from "./engineCompat";
import { ImageService } from "./images";
import { VectorEditor } from "./vectorEdit";
import { ComponentIndex, deriveInstanceRows, type DerivedRow } from "./components";
import { VariableIndex } from "./variables";
import { LibraryIndex } from "./libraries";
import type { CNode } from "./model/components";
import { EMPTY_TREE, treeFromNodes, type LayerTree } from "./model/layerTree";
import { Store, type UIState } from "./uiStore";

/** Node types the engine reads back as they are (anything else reads NONE until the engine has it). */
const ENGINE_TYPES = new Set(["DOCUMENT", "CANVAS", "GROUP", "FRAME", "ELLIPSE", "RECTANGLE", "ROUNDED_RECTANGLE", "SYMBOL", "INSTANCE", "SECTION"]);

/** Groups of NODES_CHANGED that can change a Layers row's icon (auto layout). */
const LAYOUT_GROUP = 2;

/** What `noteSourceTypes` reads of a change: a Message's NodeChange, or the load worker's slimmer record. */
export type SourceTypeChange = Pick<NodeChange, "guid" | "type"> & { phase?: NodeChange["phase"]; booleanOperation?: string };

export class EditorController {
  readonly engine: Engine;
  readonly store: EngineStore;
  readonly source: DocumentSource;
  readonly ui: Store<UIState>;
  /** The <canvas> the engine draws into (focus returns there after a field) */
  canvas: HTMLCanvasElement | null = null;
  /** Tools the engine implements (probed once) */
  readonly tools: ReadonlySet<ToolName>;
  /** The file's images: the store's bytes for the engine, object URLs for the panels */
  readonly images: ImageService;
  /** The engine's vector edit mode (E4): the toolbar and the panel follow it */
  readonly vector: VectorEditor;
  /** The file's local components (Assets, the instance menu) */
  readonly components: ComponentIndex;
  /** The file's local collections, variables and styles (the internal canvas) */
  readonly variables: VariableIndex;
  /** This file as a library and the libraries it uses (docs/data.md §9) */
  readonly libraries: LibraryIndex;
  /** The next paste: where it goes (⇧⌘V sets "inPlace" before the DOM paste event) */
  pendingPaste: { mode: "inPlace" } | { mode: "point"; x: number; y: number } | null = null;
  /** The last copy's formats (a paste with no system clipboard access falls back to them) */
  lastCopy: Record<string, string> | null = null;
  /** "Back to files" (EditorApp's `onBackToFiles`); null: the desktop's Home, else a note */
  backToFiles: (() => void) | null = null;
  /**
   * Work that must reach the store before the tab may close (the thumbnail of the last edits): the desktop's flush
   * handshake (desktop.ts) awaits each before it answers, since main ends the view right after.
   */
  readonly beforeFlush = new Set<() => Promise<void>>();

  private treeCache: { key: string; tree: LayerTree } | null = null;
  /** The document version the cached tree is of (the engine's layer_tree / layer_changes), for the next delta */
  private treeVersion: number | null = null;
  private layoutVersion = 0;
  /** Bumped by changes that can change instances' derived rows in Layers (a main's layers, a swap) */
  private instanceVersion = 0;
  /** Bumped by types noted from the source (a node the engine reads as NONE): part of the tree's key */
  private typesVersion = 0;
  private readonly treeListeners = new Set<() => void>();
  /** The tree React shows: refreshed once per animation frame after a change, after the gesture when one is live */
  private treeDirty = false;
  private treeFrame = 0;
  /** A canvas pointer gesture is in progress (pressed, not yet released): Layers follows on release, as Figma's does */
  private gestureLive = false;
  private readonly cleanups: (() => void)[] = [];
  private openEdit: string | null = null;
  /**
   * The file's own node types where the engine doesn't know them yet (it reads VECTOR, TEXT, BOOLEAN_OPERATION…
   * as NONE until E3/E4): taken from the loaded document and changes from elsewhere, so Layers and the Design
   * panel name and draw them by their real type.
   */
  private readonly sourceTypes = new Map<Guid, { type: string; booleanOperation?: string }>();

  constructor(engine: Engine, store: EngineStore, source: DocumentSource, ui: Partial<UIState> = {}) {
    this.engine = engine;
    this.store = store;
    this.source = source;
    this.ui = new Store<UIState>({
      fileName: source.fileName,
      railTab: "file",
      leftWidth: size.panel,
      rightWidth: size.panel,
      rightTab: "design",
      uiHidden: false,
      uiMinimized: false,
      rulers: true,
      renaming: null,
      expanded: new Set(),
      anchor: null,
      pageSearch: null,
      shortcutsOpen: false,
      propertyLabels: false,
      contextMenu: null,
      versionDialog: null,
      placingImages: null,
      returnToInstance: null,
      assetsView: "list",
      assetsClosed: new Set(),
      variablesOpen: false,
      stylesClosed: new Set(),
      librariesDialog: null,
      publishOpen: false,
      ...ui,
    });
    this.tools = probeTools(engine);
    this.images = new ImageService(engine, source.images ?? null);
    this.vector = new VectorEditor(engine);
    this.components = new ComponentIndex(this);
    this.variables = new VariableIndex(this);
    this.libraries = new LibraryIndex(this);
    // Whether the engine keeps fields it doesn't model yet is probed now, before any edit opens a transaction.
    keepsField(engine, "effects");
    const bump = () => this.invalidateTree();
    this.cleanups.push(
      store.subscribe("structure", bump),
      store.subscribe("page", () => this.invalidateTree({ now: true })),
      engine.on("DOCUMENT_CHANGED", (e) => {
        if (!this.treeCache?.tree.hasInstances) return;
        const touches = e.message.nodeChanges.some((c) => {
          const f = c as unknown as Record<string, unknown>;
          return c.phase !== undefined || "symbolData" in f || "overriddenSymbolID" in f || "name" in f || "visible" in f || "parentIndex" in f;
        });
        if (touches) {
          this.instanceVersion++;
          bump();
        }
      }),
      engine.on("NODES_CHANGED", (e) => {
        if (e.fieldGroupMask.some((m) => (m & LAYOUT_GROUP) !== 0)) {
          this.layoutVersion++;
          bump();
        }
      })
    );
  }

  // ---- The Layers tree's refresh ----------------------------------------------------------

  /**
   * The tree changed. React's snapshot is refreshed at the next animation frame — never inside the engine's event
   * dispatch, where a reparent during a drag used to re-read the whole page synchronously — and, while a canvas
   * gesture is live, only when it ends (Figma's Layers panel reflects a reorder or reparent on drop). `now`: a page
   * switch shows its tree at once.
   */
  private invalidateTree(opts: { now?: boolean } = {}): void {
    this.treeDirty = true;
    if (typeof requestAnimationFrame !== "function" || opts.now) {
      this.refreshTree();
      return;
    }
    if (this.gestureLive || this.treeFrame) return;
    this.treeFrame = requestAnimationFrame(() => {
      this.treeFrame = 0;
      if (!this.gestureLive) this.refreshTree();
    });
  }

  /** Reads the tree again (when its key moved) and tells React. */
  private refreshTree(): void {
    this.treeDirty = false;
    if (this.engine.destroyed) return;
    const before = this.treeCache?.tree;
    this.getTree();
    if (this.treeCache?.tree !== before) this.treeListeners.forEach((l) => l());
  }

  /** A canvas pointer gesture started (pressed): the Layers tree waits for its end. */
  beginGesture(): void {
    this.gestureLive = true;
  }

  /** The gesture ended (released, cancelled, the window blurred): the tree catches up at the next frame. */
  endGesture(): void {
    if (!this.gestureLive) return;
    this.gestureLive = false;
    if (this.treeDirty) this.invalidateTree();
  }

  /** Is a canvas pointer gesture live? (Panels may hold expensive reads until it ends.) */
  get gestureActive(): boolean {
    return this.gestureLive;
  }

  /** Follows the canvas's pointer: pressed → a gesture is live; released, cancelled or the window blurred → it ended. */
  attachGestureTracking(canvas: HTMLElement): () => void {
    const down = (e: PointerEvent) => {
      if (e.button === 0 || e.button === 1) this.beginGesture();
    };
    const up = () => this.endGesture();
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("lostpointercapture", up);
    window.addEventListener("blur", up);
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("lostpointercapture", up);
      window.removeEventListener("blur", up);
      this.endGesture();
    };
  }

  /** EditorApp's `onBackToFiles` (null: the desktop's Home, else a note). */
  setBackToFiles(go: (() => void) | null): void {
    this.backToFiles = go;
  }

  dispose(): void {
    this.cancelEdit();
    for (const c of this.cleanups.splice(0)) c();
    if (this.treeFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.treeFrame);
    this.treeFrame = 0;
    this.treeListeners.clear();
    this.images.dispose();
    this.vector.dispose();
    this.components.dispose();
    this.variables.dispose();
    this.libraries.dispose();
  }

  // ---- Reads ----------------------------------------------------------------------------

  /** Remembers the types (and boolean operations) a document or a change from elsewhere carries. */
  noteSourceTypes(message: { nodeChanges: readonly SourceTypeChange[] }): void {
    let touched = false;
    for (const c of message.nodeChanges) {
      if (c.phase === "REMOVED") {
        touched = this.sourceTypes.delete(c.guid) || touched;
        continue;
      }
      const extra = c;
      if (!c.type && extra.booleanOperation === undefined) continue;
      if (c.type && ENGINE_TYPES.has(c.type) && extra.booleanOperation === undefined && !this.sourceTypes.has(c.guid)) continue;
      const was = this.sourceTypes.get(c.guid);
      this.sourceTypes.set(c.guid, { type: c.type ?? was?.type ?? "NONE", booleanOperation: extra.booleanOperation ?? was?.booleanOperation });
      touched = true;
    }
    if (touched) {
      this.typesVersion++;
      this.invalidateTree();
    }
  }

  /** The node with its real type (the engine's when it knows it, else the file's), and a boolean's operation. */
  readonly withRealType = <T extends NodeChange>(n: T): T => {
    const known = this.sourceTypes.get(n.guid);
    if (!known || (n.type && n.type !== "NONE" && known.type === n.type && !known.booleanOperation)) return n;
    const type = n.type && n.type !== "NONE" ? n.type : known.type;
    return { ...n, type, ...(known.booleanOperation ? { booleanOperation: known.booleanOperation } : {}) } as T;
  };

  get selection(): Guid[] {
    return this.store.selection.refs;
  }

  /** The selected nodes' fields (fresh). */
  selectedNodes(): NodeChange[] {
    const refs = this.selection;
    return refs.length ? this.engine.readNodes(refs) : [];
  }

  /**
   * The current page's Layers tree, read again only after its structure changed (synchronous, always current). With
   * an engine that keeps a change log (`layerChanges`, docs/engine-build.md "Performance round 2") a stale tree of
   * the same page is patched from the rows that changed since its version instead of re-read whole.
   */
  readonly getTree = (): LayerTree => {
    if (this.engine.destroyed) return EMPTY_TREE;
    const page = this.store.page;
    const key = `${page}#${this.store.structure}#${this.layoutVersion}#${this.instanceVersion}#${this.typesVersion}`;
    if (this.treeCache?.key === key) return this.treeCache.tree;
    const previous = this.treeCache?.tree;
    const changes = previous && previous.page === page && this.treeVersion !== null ? layerChangesOf(this.engine, page, this.treeVersion) : null;
    let tree: LayerTree;
    if (changes && !changes.full && previous) {
      tree = patchTree(previous, changes, this.withRealType);
      this.treeVersion = changes.version;
    } else {
      const read = changes ? { version: changes.version, nodes: changes.nodes } : layerTreeOf(this.engine, page);
      tree = treeFromRows(this.engine, page, read.nodes, this.withRealType);
      this.treeVersion = read.version;
    }
    this.treeCache = { key, tree };
    return tree;
  };

  /**
   * The tree as React shows it (`useLayerTree`): the last one read. It is read here only when none has been yet;
   * after a change, `invalidateTree` reads it again at the next frame (after the gesture) and the subscribers hear.
   */
  readonly getTreeSnapshot = (): LayerTree => {
    if (this.engine.destroyed) return EMPTY_TREE;
    return this.treeCache?.tree ?? this.getTree();
  };

  readonly subscribeTree = (listener: () => void): (() => void) => {
    this.treeListeners.add(listener);
    return () => this.treeListeners.delete(listener);
  };

  // ---- Focus ----------------------------------------------------------------------------

  /** Back to the canvas (after Enter / Esc in a field, a menu pick, a toolbar click). */
  focusCanvas(): void {
    this.canvas?.focus({ preventScroll: true });
  }

  // ---- Writes ---------------------------------------------------------------------------

  /** The generic setter on `refs`, as one undo step labelled `label`. */
  setProps(refs: readonly Guid[], fields: NodeFields, label = "Edit"): number {
    if (!refs.length) return Status.OK;
    this.engine.txnBegin(label);
    const status = this.engine.setProps(refs, fields);
    this.engine.txnCommit();
    return status;
  }

  /** Several writes as one undo step. */
  batch(label: string, write: () => void): void {
    this.engine.txnBegin(label);
    try {
      write();
    } finally {
      this.engine.txnCommit();
    }
  }

  /**
   * A panel edit that may be a gesture (DS ChangeInfo): live values
   * (`final: false`, a scrub) share one open transaction — the canvas follows
   * — and the final value commits it, so one gesture is one undo step.
   */
  edit(label: string, info: ChangeInfo, write: () => void): void {
    if (!info.final) {
      if (this.openEdit === null) {
        this.engine.txnBegin(label);
        this.openEdit = label;
      }
      write();
      return;
    }
    if (this.openEdit === null) this.engine.txnBegin(label);
    try {
      write();
    } finally {
      this.openEdit = null;
      this.engine.txnCommit();
    }
  }

  /** Esc during a scrub: everything since its first value is rolled back. */
  cancelEdit(): void {
    if (this.openEdit === null) return;
    this.openEdit = null;
    if (!this.engine.destroyed) this.engine.txnCancel();
  }

  setTool(tool: ToolName): void {
    if (this.tools.has(tool)) this.engine.setTool(tool);
  }

  /** Forwards a key the canvas didn't get (focus in a panel) to the engine first. */
  engineKey(type: "down" | "up", e: KeyboardEvent, mods: number): boolean {
    return (this.engine.key(type, e.code, e.key, mods, e.repeat) & KEY_HANDLED) !== 0;
  }
}

/** The engine's versioned layer-tree read (`layerTreeVersioned`), or the plain one with no version (older builds). */
function layerTreeOf(engine: Engine, page: Guid): { version: number | null; nodes: NodeChange[] } {
  if (!page) return { version: null, nodes: [] };
  const versioned = engineCall<(p: Guid) => { version: number; nodes: NodeChange[] }>(engine, "layerTreeVersioned", "layer_tree");
  if (versioned && engineCall(engine, "layerChanges", "layer_changes")) {
    const r = versioned(page);
    if (r && Array.isArray(r.nodes)) return { version: typeof r.version === "number" ? r.version : null, nodes: r.nodes };
  }
  return { version: null, nodes: engine.layerTree(page) };
}

/** The Layers rows changed since `since` (`layerChanges`), or null when the build has no change log. */
export interface LayerDelta {
  version: number;
  full: boolean;
  nodes: NodeChange[];
  removed: Guid[];
}
function layerChangesOf(engine: Engine, page: Guid, since: number): LayerDelta | null {
  const read = engineCall<(p: Guid, since: number) => LayerDelta | null>(engine, "layerChanges", "layer_changes");
  if (!read) return null;
  const d = read(page, since);
  return d && Array.isArray(d.nodes) && typeof d.version === "number" ? d : null;
}

/**
 * The tree with a delta applied (docs/engine-build.md): `removed` dropped, each row upserted (its `childIds`
 * replacing the old ones), the rest kept as they were.
 */
export function patchTree(tree: LayerTree, delta: Pick<LayerDelta, "nodes" | "removed">, resolve: (n: NodeChange) => NodeChange = (n) => n): LayerTree {
  const nodes = new Map(tree.nodes);
  for (const id of delta.removed) nodes.delete(id);
  const fresh = treeFromNodes(tree.page, delta.nodes.map(resolve));
  for (const [id, node] of fresh.nodes) nodes.set(id, node);
  // Rows no longer in the document or on this page: a removed id, or a parent whose child list no longer lists it
  // would only be dropped if the engine said so (`removed` names every node that left the document).
  return { page: tree.page, nodes, hasInstances: tree.hasInstances || fresh.hasInstances };
}

/** The Layers tree of `page`, in one engine read of only what the rows show (Engine.layerTree). */
export function readTree(engine: Engine, page: Guid, resolve: (n: NodeChange) => NodeChange = (n) => n): LayerTree {
  if (!page) return EMPTY_TREE;
  return treeFromRows(engine, page, engine.layerTree(page), resolve);
}

/** The tree from the rows an engine read gave (`layerTree` / `layerChanges` with `full`). */
export function treeFromRows(engine: Engine, page: Guid, rows: readonly NodeChange[], resolve: (n: NodeChange) => NodeChange = (n) => n): LayerTree {
  if (!page) return EMPTY_TREE;
  const nodes: NodeChange[] = [];
  const seen = new Set<Guid>();
  for (const n of rows) {
    if (seen.has(n.guid)) continue;
    seen.add(n.guid);
    nodes.push(resolve(n));
  }
  // Instance sublayers: the engine lists them once it materializes instances (E6); until then they are derived
  // here from the main component, for Layers only (ids `I<instance>;<key>…`, docs/schema.md §5.1).
  const read = (ids: Guid[]) => (ids.length ? engine.readNodes(ids, { childIds: true }).map((n) => resolve(n) as CNode) : []);
  const derived: NodeChange[] = [];
  for (const n of nodes) {
    if (n.type !== "INSTANCE" || n.childIds?.length) continue;
    const rows: DerivedRow[] = [];
    const full = (read([n.guid])[0] ?? n) as CNode;  // layerTree's rows carry no symbolData
    const kids = deriveInstanceRows(read, full, 0, [], full, rows);
    n.childIds = kids;
    for (const r of rows) derived.push({ ...(r.node as NodeChange), parentIndex: { guid: r.parent, position: "" }, childIds: r.children, derived: true } as NodeChange);
  }
  return treeFromNodes(page, derived.length ? [...nodes, ...derived] : nodes);
}

/** Which tools the engine implements: setTool answers OK only for those. */
function probeTools(engine: Engine): ReadonlySet<ToolName> {
  const out = new Set<ToolName>();
  for (const t of TOOLS) if (engine.setTool(t) === Status.OK) out.add(t);
  engine.setTool("MOVE");
  return out;
}

export const EditorContext = createContext<EditorController | null>(null);

export function useEditor(): EditorController {
  const ed = useContext(EditorContext);
  if (!ed) throw new Error("useEditor outside an editor");
  return ed;
}

