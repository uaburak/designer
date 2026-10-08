/**
 * Where an editor's document comes from and where its changes go
 * (docs/editor.md §3). The editor never writes files: it loads one snapshot,
 * hands every committed change Message (engine.onDocumentChanged, one per
 * transaction) to `onChanges` in order, and asks for a `flush` before the
 * tab closes. The store integration supplies its own DocumentSource; the
 * `?editor` route and the tests use `memoryDocumentSource`.
 */
import type { Guid, Message, NodeChange } from "@/engine/codec";
import type { DocumentFacts, EngineWireFormat, PreparedDocument } from "@/store/loadDocument";
import type { LibraryEvent } from "../../../shared/store/repositories";
import type { LibraryDiff, LibraryRecord, LibraryVersion, PreviewOptions, PreviewRecord, PublishAsset, PublishPreview } from "../../../shared/store/types";
import { memoryImageStore, type ImageStore } from "./images";

export interface DocumentSource {
  /** The file's name, as the left panel's header shows it ("burakkoc"). */
  readonly fileName: string;
  /** Where the file lives, under its name ("Drafts", a project's name). */
  readonly location: string;
  /** The session new nodes are created in (allocated by storage, docs/data.md §1); default 1. */
  readonly sessionID?: number;
  /** The document to open: a snapshot Message (DOCUMENT first, parents before children). */
  load(): Promise<Message>;
  /**
   * The document as the engine loads it, prepared off the main thread where the source can (the store's source runs
   * a worker), with what is known of the file (its fonts by page, derived data) before the bytes are. `format`: the
   * wire form the engine in hand reads (the store's own kiwi, or the interim JSON). Optional: the editor falls back
   * to `load()`. Both answer the same document; a source memoizes them (React's StrictMode mounts twice).
   */
  prepare?(format?: EngineWireFormat): PreparedLoad;
  /**
   * One committed change (a NODE_CHANGES Message carrying only the touched fields), in commit order; `info`: the
   * engine's kind and undo label, and the change as kiwi bytes when the engine wrote them (journaled as they are).
   */
  onChanges(changes: Message, info?: ChangeKindInfo): void;
  /**
   * The engine's own snapshot of the whole document, derived fields included (docs/data.md §5.5): the store adopts it
   * as the file's snapshot when nothing it doesn't know of happened since — the next open then draws its first frame
   * from stored geometry, before fonts arrive, as Figma's files do. Optional. Resolves to whether it was adopted —
   * "refused" when the store won't take this engine's snapshots at all (it would lose a node or a value the file
   * holds): the editor stops sending them.
   */
  saveSnapshot?(snapshot: Uint8Array, info: { derivedDataVersion: number }): Promise<boolean | "refused">;
  /** Resolves once every change handed to `onChanges` is stored. */
  flush(): Promise<void>;
  /** The file was renamed from the file menu; absent: the name can't be changed here. */
  rename?(name: string): void | Promise<void>;
  /** Changes this editor didn't make (another window, sync): applied without an undo entry; `info.bytes`: the change as the store holds it (kiwi), for an engine that reads it. Optional. */
  onExternalChanges?(listener: (changes: Message, info?: { seq?: number; bytes?: Uint8Array }) => void): () => void;
  /** The file was renamed, moved, trashed or deleted elsewhere. Optional. */
  onMetaChanged?(listener: (meta: { fileName: string; location: string; trashed?: boolean; deleted?: boolean }) => void): () => void;
  /** The editor is going away: flush and end the session. Optional. */
  close?(): Promise<void>;
  /** The file's UI state from its last session (camera and selection per page, panel widths). Optional. */
  readonly uiState?: EditorUiState | null;
  /** The UI state changed (the source debounces and keeps it). Optional. */
  setUiState?(patch: Partial<EditorUiState>): void;
  /** A PNG of the file's first page (≤ 800 × 600) for Home's card. Optional. */
  saveThumbnail?(png: Uint8Array, size: { width: number; height: number }): Promise<void>;
  /** Version history (docs/data.md §6). Optional: absent, the File menu's version items are disabled. */
  listVersions?(): Promise<VersionInfo[]>;
  saveVersion?(input?: { title?: string; description?: string }): Promise<VersionInfo>;
  /** A saved version as a document, read-only (Dev Mode's Compare changes loads it into an engine of its own). Optional. */
  openVersion?(id: string): Promise<Message>;
  /** Non-destructive restore: `apply` gets the diff (and its kiwi bytes when the source has them) and applies it as one undoable edit labelled "Restore version". */
  restoreVersion?(id: string, apply: (diff: Message, bytes?: Uint8Array) => void | Promise<void>): Promise<VersionInfo>;
  /** The file's images by SHA-1 (the store's blobs). Optional: absent, images can't be placed or drawn. */
  readonly images?: ImageStore;
  /** The workspace's libraries as this file sees them (docs/data.md §9). Optional: absent, libraries are off. */
  readonly libraries?: LibraryAccess;
  /** Developer previews of this file (docs/data.md §13). Optional: absent, only nothing can be published. */
  readonly previews?: PreviewAccess;
}

/**
 * The store's `previews.*` for one file (docs/data.md §13): whether links can be published (Firebase configured and
 * sync on), the file's published preview, publishing the editor's derived snapshot (create or update in place) and
 * Stop sharing. Exporting as HTML goes through main (its Save dialog), not here.
 */
export interface PreviewAccess {
  readonly fileKey: string;
  status(): Promise<{ publish: boolean; reason: string | null }>;
  list(): Promise<PreviewRecord[]>;
  publish(snapshot: Uint8Array, options: PreviewOptions): Promise<PreviewRecord>;
  stop(previewId: string): Promise<void>;
}

/**
 * `prepare()`'s answers: the store's own bytes at once (a kiwi-reading engine takes them as they are, docs/desktop.md
 * §3.1: `engine_load(snapshot)`, then each journal frame with `applyChanges(frame, "load")`), the document's facts as
 * soon as it is decoded (its fonts by page, derived data), the converted bytes when there are any to convert.
 */
export interface PreparedLoad {
  /** The snapshot and its journal as the store holds them (kiwi Messages); null when the source has no such bytes */
  raw: { snapshot: Uint8Array; frames: readonly Uint8Array[]; derivedDataVersion: number } | null;
  facts: Promise<DocumentFacts>;
  document: Promise<PreparedDocument>;
}

/** A publish's asset with its payload as the engine's Message (the source encodes it for the store), or as the kiwi bytes a kiwi-writing engine gave (`encodeAssetsKiwi`): stored as they are. */
export type EditorPublishAsset = Omit<PublishAsset, "payload"> & { payload?: Message; payloadBytes?: Uint8Array };

/** A published library in the workspace, as the Libraries modal lists it. */
export interface LibraryEntry {
  fileKey: string;
  /** The library file's name */
  name: string;
  /** "Drafts" or its folder's name */
  location: string;
  record: LibraryRecord;
}

/** What a library event or a change of this file's enabled libraries looks like to the editor. */
export type LibraryNotice = LibraryEvent | { type: "enabled"; enabled: readonly string[] } | { type: "moved"; inDrafts: boolean };

/**
 * The library registry for one open file (docs/data.md §9): publish this file, enable others, fetch payloads,
 * find updates. Payloads cross as the engine's Messages; the store keeps kiwi.
 */
export interface LibraryAccess {
  /** This file's key (the library's key when it publishes) */
  readonly fileKey: string;
  /** In Drafts: Figma refuses to publish ("Move to a folder to publish") */
  inDrafts(): boolean;
  /** The libraries enabled in this file */
  enabled(): readonly string[];
  /** Every published library in the workspace but this file */
  available(): Promise<LibraryEntry[]>;
  /** A library file's name (null when it is gone) */
  fileName(lib: string): Promise<string | null>;
  record(lib: string): Promise<LibraryRecord | null>;
  version(lib: string, version?: number): Promise<LibraryVersion>;
  previewPublish(assets: EditorPublishAsset[]): Promise<PublishPreview>;
  publish(input: { description: string; assets: EditorPublishAsset[]; moves: { key: string; fromLibraryFileKey: string; fromKey: string; mode: "move" | "copy" }[] }): Promise<LibraryVersion>;
  setEnabled(lib: string, enabled: boolean): Promise<void>;
  /** Payloads as the store holds them (`bytes`, kiwi) and as the engine's Message (`message`, decoded lazily) */
  payloads(lib: string, wants: { key: string; versionHash: string }[], opts: { withDependencies: boolean }): Promise<{ key: string; versionHash: string; message: Message; bytes?: Uint8Array }[]>;
  diff(lib: string, have: { key: string; versionHash: string }[]): Promise<LibraryDiff>;
  /** Published / status events of every library, and this file's own enabled list or folder changing */
  onChange(listener: (e: LibraryNotice) => void): () => void;
  /** Where a manifest's thumbnail (a blob) can be shown; "" when it can't */
  blobUrl(sha1: string): string;
}

/** What a source keeps of the editor's UI between sessions (the store's FileUiState). */
export interface EditorUiState {
  currentPageId: string | null;
  pages: Record<string, { viewport: { x: number; y: number; zoom: number }; selection: string[] }>;
  leftPanelWidth: number;
  rightPanelWidth: number;
}

/** A saved version, as the version history lists it. */
export interface VersionInfo {
  id: string;
  kind: "autosave" | "named" | "restore" | "publish" | "import";
  title: string | null;
  description: string | null;
  createdAt: number;
}

/** What the editor knows about a change besides its Message. */
export interface ChangeKindInfo {
  kind?: "USER" | "UNDO" | "REDO" | "SYSTEM";
  /** The undo label ("Move", "Rename") */
  label?: string;
  /** The change as the kiwi Message the engine wrote (an engine with kiwi at its boundary): the store journals it as it is */
  bytes?: Uint8Array;
}

/**
 * Applies a change Message to a snapshot's nodes (docs/schema.md §4.3): REMOVED
 * deletes, CREATED replaces, an update replaces each carried field wholesale
 * and deletes the `clearedFields` (by name: the interim codec carries names).
 */
export function applyMessage(nodes: Map<Guid, NodeChange>, message: Message, clearedName: (id: number) => string | undefined = () => undefined): void {
  for (const change of message.nodeChanges) {
    if (change.phase === "REMOVED") {
      nodes.delete(change.guid);
      continue;
    }
    if (change.phase === "CREATED") {
      nodes.set(change.guid, { ...change });
      continue;
    }
    const current = nodes.get(change.guid);
    if (!current) continue; // an update of a node we don't have: skipped, as the apply algorithm says
    const next: NodeChange = { ...current };
    for (const [key, value] of Object.entries(change)) {
      if (key === "guid" || key === "phase" || key === "clearedFields") continue;
      (next as unknown as Record<string, unknown>)[key] = value;
    }
    for (const id of change.clearedFields ?? []) {
      const name = clearedName(id);
      if (name) delete (next as unknown as Record<string, unknown>)[name];
    }
    nodes.set(change.guid, next);
  }
}

export interface MemoryDocumentSource extends DocumentSource {
  /** The document as it is now: the snapshot with every change applied (parents before children). */
  snapshot(): Message;
  /** Every change received, in order. */
  readonly changes: readonly Message[];
}

/** A DocumentSource held in memory: the snapshot it was given plus every change since. */
export function memoryDocumentSource(
  document: Message,
  options: { fileName?: string; location?: string; sessionID?: number; images?: ImageStore; versions?: boolean } = {}
): MemoryDocumentSource {
  const nodes = new Map<Guid, NodeChange>(document.nodeChanges.map((n) => [n.guid, { ...n, phase: "CREATED" as const }]));
  const changes: Message[] = [];
  let fileName = options.fileName ?? "Untitled";
  const snapshot = (): Message => ({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: orderParentsFirst([...nodes.values()]) });
  // `versions`: version history in memory (the browser's demo files: Dev Mode's Compare changes reads it).
  const saved: { info: VersionInfo; message: Message }[] = [];
  const history = options.versions
    ? {
        listVersions: async () => saved.map((v) => ({ ...v.info })),
        saveVersion: async (input: { title?: string; description?: string } = {}) => {
          const info: VersionInfo = { id: `v${saved.length + 1}`, kind: "named", title: input.title ?? null, description: input.description ?? null, createdAt: Date.now() };
          saved.push({ info, message: structuredClone(snapshot()) });
          return { ...info };
        },
        openVersion: async (id: string) => {
          const v = saved.find((x) => x.info.id === id);
          if (!v) throw new Error("This version doesn't exist");
          return structuredClone(v.message);
        },
      }
    : {};
  return {
    ...history,
    get fileName() {
      return fileName;
    },
    location: options.location ?? "Drafts",
    sessionID: options.sessionID ?? 1,
    images: options.images ?? memoryImageStore(),
    changes,
    load: async () => snapshot(),
    onChanges: (message) => {
      changes.push(message);
      applyMessage(nodes, message);
    },
    flush: async () => {},
    rename: (name) => {
      fileName = name;
    },
    snapshot,
  };
}

/** Nodes ordered parents before children (a snapshot's order; orphans last). */
export function orderParentsFirst(nodes: NodeChange[]): NodeChange[] {
  const byParent = new Map<Guid, NodeChange[]>();
  const ids = new Set(nodes.map((n) => n.guid));
  const roots: NodeChange[] = [];
  for (const n of nodes) {
    const parent = n.parentIndex?.guid;
    if (!parent || !ids.has(parent)) roots.push(n);
    else {
      const list = byParent.get(parent);
      if (list) list.push(n);
      else byParent.set(parent, [n]);
    }
  }
  const byPosition = (a: NodeChange, b: NodeChange) => {
    const pa = a.parentIndex?.position ?? "";
    const pb = b.parentIndex?.position ?? "";
    return pa < pb ? -1 : pa > pb ? 1 : a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0;
  };
  const out: NodeChange[] = [];
  const seen = new Set<Guid>();
  const visit = (n: NodeChange) => {
    if (seen.has(n.guid)) return;
    seen.add(n.guid);
    out.push(n);
    for (const child of (byParent.get(n.guid) ?? []).sort(byPosition)) visit(child);
  };
  roots.sort((a, b) => (a.type === "DOCUMENT" ? -1 : b.type === "DOCUMENT" ? 1 : byPosition(a, b))).forEach(visit);
  return out;
}
