/**
 * The store port protocol (docs/data.md §8.3). One MessagePort per view (and one for main); arguments and results
 * are structured clones (Uint8Arrays are copied once, no JSON). The store sends `hello` first on every new port.
 */

export type Repository = "workspace" | "files" | "blobs" | "libraries" | "previews" | "store" | "multiplayer" | "comments" | "notifications" | "orgs" | "teams" | "projects" | "admin" | "branches" | "orgLibraries" | "analytics" | "identity" | "plugins" | "devMode";
export type StoreMethod = `${Repository}.${string}`;
export type PortRole = "main" | "home" | "editor";
/** `org`: OrgEvent (docs/multiplayer.md §14.6); `branches`: BranchEvent (docs/data.md §15.6); `fonts`: FontsEvent (docs/desktop.md §14.3); `session`: SessionEnded (docs/multiplayer.md §15.8) */
export type EventTopic = "workspace" | "file.changes" | "library" | "multiplayer" | "comments" | "notifications" | "org" | "branches" | "fonts" | "session" | "plugins" | "devmode";

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
  /** A name taken or a stale write (the server's 409; docs/multiplayer.md §14.6) */
  | "conflict"
  /** A head moved since a merge preview (docs/data.md §15.6): preview again */
  | "stale"
  /** Libraries publish from main only (docs/data.md §15.5) */
  | "branch-cannot-publish"
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
  previews: ["status", "list", "publish", "stop", "exportHtml"],
  store: ["shutdown", "flushAll", "info", "collectGarbage"],
  multiplayer: ["setSession", "status", "fileState", "share", "listRemote", "openShared", "members", "fileInfo", "setLinkAccess", "updateLink", "setViewersCanCopy", "requestEdit", "requests", "answerRequest", "invite", "removeMember", "presence", "takeOpenIntent", "unlockFile", "setLinkPassword", "transferOwnership", "signal"],
  comments: ["list", "add", "edit", "remove", "setResolved", "setRead", "react", "move", "mentionable"],
  notifications: ["list", "markRead", "prefs", "setPrefs", "answer"],
  // The org spaces (docs/multiplayer.md §14.6); `watch` is the `org` event topic
  orgs: ["list", "get", "create", "people", "drafts", "createDraft", "search", "requestSeat", "groups", "createGroup", "updateGroup", "setGroupMembers", "deleteGroup", "leave"],
  teams: ["list", "get", "create", "update", "remove", "restore", "transfer", "members", "invite", "setMember", "removeMember", "join", "leave", "requests", "answerRequest"],
  projects: [
    "list",
    "get",
    "create",
    "update",
    "move",
    "trash",
    "restore",
    "deleteForever",
    "members",
    "invite",
    "setMember",
    "removeMember",
    "files",
    "createFile",
    "moveFiles",
    "moveLocalFile",
    "trashFiles",
    "restoreFiles",
    "trashed",
  ],
  admin: [
    "dashboard",
    "people",
    "addPeople",
    "updatePeople",
    "removePeople",
    "seatRequests",
    "answerSeatRequest",
    "guestRequests",
    "answerGuestRequest",
    "teams",
    "workspaces",
    "createWorkspace",
    "updateWorkspace",
    "deleteWorkspace",
    "billingGroups",
    "createBillingGroup",
    "updateBillingGroup",
    "deleteBillingGroup",
    "activity",
    "settings",
    "updateSettings",
    "unassignedDrafts",
    "moveUnassigned",
    "deleteUnassigned",
    "exportCsv",
  ],
  // Branches (docs/data.md §15.6); `watch` is the `branches` event topic
  branches: ["create", "list", "get", "rename", "archive", "restore", "mainStatus", "preview", "openSide", "applyUpdate", "merge", "requestReview", "answerReview"],
  // Org libraries' settings (docs/data.md §16.3, §16.5) and library analytics (§17)
  orgLibraries: ["list", "get", "updateSettings", "setScope", "teamLibraries"],
  analytics: ["record", "orgOverview", "overview", "actions", "usage", "modes", "csv"],
  // Identity and security (docs/multiplayer.md §15, round 4)
  identity: ["overview", "saveIdp", "refreshIdpMetadata", "deleteIdp", "generateScimToken", "revokeScimToken", "addDomain", "verifyDomain", "removeDomain", "domainAccounts", "dataRegion", "setDataRegion", "moveNext"],
  // Plugins (docs/plugins.md §10.4, round 5g); `plugins` is also an event topic
  plugins: ["local", "setSaved", "ranRecently", "listPrivate", "bundle", "publish", "removePrivate", "allowed", "request", "admin", "approve", "unapprove", "answer"],
  // Dev Mode (docs/editor.md D-8, round 5g); `devmode` is also an event topic
  devMode: ["devResources", "addDevResource", "editDevResource", "removeDevResource", "codeConnect", "setCodeConnect", "removeCodeConnect", "reportStatus", "viewed", "setStatusNotifications", "prototypeMembers", "invitePrototype", "removePrototype"],
} as const satisfies Record<Repository, readonly string[]>;

/** Methods that take filesystem paths stay in main, behind native dialogs, so a renderer can never name a path. */
const MAIN_ONLY = new Set<string>(["files.importLocalCopy", "files.exportLocalCopy", "previews.exportHtml", "multiplayer.setSession"]);

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
  "multiplayer.status",
  "multiplayer.fileState",
  "multiplayer.listRemote",
  "multiplayer.members",
  "multiplayer.fileInfo",
  "comments.list",
  "comments.mentionable",
  "notifications.list",
  "notifications.prefs",
  "orgs.list",
  "orgs.get",
  "orgs.people",
  "orgs.drafts",
  "orgs.search",
  "orgs.groups",
  "teams.list",
  "teams.get",
  "teams.members",
  "teams.requests",
  "projects.list",
  "projects.get",
  "projects.members",
  "projects.files",
  "projects.trashed",
  "admin.dashboard",
  "admin.people",
  "admin.seatRequests",
  "admin.guestRequests",
  "admin.teams",
  "admin.workspaces",
  "admin.billingGroups",
  "admin.activity",
  "admin.settings",
  "admin.unassignedDrafts",
  "admin.exportCsv",
  "branches.list",
  "branches.get",
  "branches.mainStatus",
  "orgLibraries.list",
  "orgLibraries.get",
  "orgLibraries.teamLibraries",
  "analytics.orgOverview",
  "analytics.overview",
  "analytics.actions",
  "analytics.usage",
  "analytics.modes",
  "analytics.csv",
  "identity.overview",
  "identity.domainAccounts",
  "identity.dataRegion",
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
