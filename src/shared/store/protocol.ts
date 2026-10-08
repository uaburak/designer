/**
 * The store port protocol (docs/data.md §8.3). One MessagePort per view (and one for main); arguments and results
 * are structured clones (Uint8Arrays are copied once, no JSON). The store sends `hello` first on every new port.
 */

export type Repository = "workspace" | "files" | "blobs" | "libraries" | "previews" | "store";
export type StoreMethod = `${Repository}.${string}`;
export type PortRole = "main" | "home" | "editor";
export type EventTopic = "workspace" | "file.changes" | "library" | "sync";

export type RpcRequest = { t: "req"; id: number; m: StoreMethod; a: unknown[] };
export type RpcResponse = { t: "res"; id: number; ok: true; v: unknown } | { t: "res"; id: number; ok: false; e: { code: StoreErrorCode; message: string; detail?: unknown } };
export type RpcEvent = { t: "evt"; topic: EventTopic; d: unknown };
export type RpcHello = { t: "hello"; role: PortRole; generation: number };
export type RpcMessage = RpcRequest | RpcResponse | RpcEvent | RpcHello;

export type StoreErrorCode =
  | "not-found"
  | "trashed"
  | "already-open"
  | "read-only"
  | "corrupt"
  | "io"
  | "disk-full"
  | "unsupported-format"
  | "too-large"
  | "draft-cannot-publish"
  | "invalid"
  | "forbidden"
  | "offline"
  | "shutting-down";

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export const isStoreError = (e: unknown): e is StoreError => e instanceof StoreError || (typeof e === "object" && e !== null && (e as { name?: string }).name === "StoreError");

/**
 * Every method a port may call, by repository. The server dispatches only these names (never arbitrary properties);
 * `subscribe`/`unsubscribe` are the wire form of FileRepository.subscribe.
 */
export const STORE_METHODS = {
  workspace: [
    "getWorkspace",
    "updateWorkspace",
    "getPrefs",
    "setBrowsePrefs",
    "listFolders",
    "createFolder",
    "updateFolder",
    "listFiles",
    "getFile",
    "createFile",
    "duplicateFile",
    "renameFile",
    "moveFiles",
    "trash",
    "restore",
    "deleteForever",
    "emptyTrash",
    "setStarred",
    "recordViewed",
    "removeFromRecents",
  ],
  files: [
    "open",
    "reattach",
    "append",
    "flush",
    "close",
    "subscribe",
    "unsubscribe",
    "saveThumbnail",
    "setUiState",
    "saveSnapshot",
    "listVersions",
    "createVersion",
    "updateVersion",
    "openVersion",
    "restoreDiff",
    "duplicateVersion",
    "importLocalCopy",
    "exportLocalCopy",
    "importFigBytes",
  ],
  blobs: ["put", "has", "get"],
  libraries: ["listAvailable", "getRecord", "getVersion", "previewPublish", "publish", "unpublish", "setEnabled", "getPayloads", "diff"],
  previews: ["list", "publish", "stop"],
  store: ["shutdown", "flushAll", "info", "collectGarbage"],
} as const satisfies Record<Repository, readonly string[]>;

/** Methods that take filesystem paths stay in main, behind native dialogs, so a renderer can never name a path. */
const MAIN_ONLY = new Set<string>(["files.importLocalCopy", "files.exportLocalCopy"]);

export function isKnownMethod(m: string): m is StoreMethod {
  const dot = m.indexOf(".");
  if (dot < 0) return false;
  const repo = m.slice(0, dot) as Repository;
  const list = STORE_METHODS[repo] as readonly string[] | undefined;
  return !!list && list.includes(m.slice(dot + 1));
}

/** Role permissions: main may call everything; home and editor everything except path methods and `store.*`. */
export function roleMayCall(role: PortRole, m: StoreMethod): boolean {
  if (role === "main") return true;
  return !MAIN_ONLY.has(m) && !m.startsWith("store.");
}

/** Methods a client may resend on a new port after a store restart without changing their effect. */
export const RETRY_SAFE = new Set<string>([
  "workspace.getWorkspace",
  "workspace.getPrefs",
  "workspace.listFolders",
  "workspace.listFiles",
  "workspace.getFile",
  "workspace.recordViewed",
  "files.flush",
  "files.listVersions",
  "files.restoreDiff",
  "files.setUiState",
  "files.saveThumbnail",
  "blobs.put",
  "blobs.has",
  "blobs.get",
  "libraries.listAvailable",
  "libraries.getRecord",
  "libraries.getVersion",
  "libraries.previewPublish",
  "libraries.getPayloads",
  "libraries.diff",
  "store.info",
  "store.flushAll",
]);

/**
 * A port as either side sees it. Adapts a DOM/Node `MessagePort` (addEventListener + start) and Electron's
 * `MessagePortMain` (EventEmitter `on("message", e)` + start).
 */
export interface RpcTransport {
  send(message: RpcMessage): void;
  /** Starts delivery. `onClose` fires when the other side goes away (where the port can tell). */
  listen(onMessage: (data: unknown) => void, onClose: () => void): void;
  close(): void;
}

interface DomLikePort {
  postMessage(message: unknown): void;
  addEventListener(type: string, listener: (e: { data?: unknown }) => void): void;
  start?(): void;
  close(): void;
}

interface EmitterLikePort {
  postMessage(message: unknown): void;
  on(event: string, listener: (e: unknown) => void): unknown;
  start?(): void;
  close(): void;
}

export function portTransport(port: DomLikePort | EmitterLikePort): RpcTransport {
  return {
    send(message) {
      port.postMessage(message);
    },
    listen(onMessage, onClose) {
      if ("addEventListener" in port && typeof port.addEventListener === "function") {
        port.addEventListener("message", (e) => onMessage(e.data));
        port.addEventListener("close", () => onClose());
      } else {
        const p = port as EmitterLikePort;
        p.on("message", (e) => onMessage(e && typeof e === "object" && "data" in e ? (e as { data: unknown }).data : e));
        p.on("close", () => onClose());
      }
      port.start?.();
    },
    close() {
      port.close();
    },
  };
}

export function serializeError(e: unknown): { code: StoreErrorCode; message: string; detail?: unknown } {
  if (isStoreError(e)) return { code: e.code, message: e.message, ...(e.detail !== undefined ? { detail: e.detail } : {}) };
  const err = e as NodeLikeError;
  if (err && (err.code === "ENOSPC" || err.code === "EDQUOT")) return { code: "disk-full", message: "The disk is full" };
  if (err && typeof err.code === "string" && /^E[A-Z]+$/.test(err.code)) return { code: "io", message: err.message ?? String(e) };
  return { code: "io", message: err?.message ?? String(e) };
}

interface NodeLikeError {
  code?: string;
  message?: string;
}
