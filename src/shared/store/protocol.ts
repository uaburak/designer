/**
 * The store port protocol (docs/data.md §8.3). One MessagePort per view (and one for main); arguments and results
 * are structured clones (Uint8Arrays are copied once, no JSON). The store sends `hello` first on every new port.
 */

export type Repository = "workspace" | "files" | "blobs" | "libraries" | "previews" | "store" | "multiplayer" | "comments" | "notifications" | "orgs" | "teams" | "projects" | "admin" | "branches" | "orgLibraries" | "analytics" | "identity" | "governance" | "plugins" | "devMode" | "ai" | "search" | "cloud" | "brands";
export type StoreMethod = `${Repository}.${string}`;
export type PortRole = "main" | "home" | "editor";
/** `org`: OrgEvent (docs/multiplayer.md §14.6); `branches`: BranchEvent (docs/data.md §15.6); `fonts`: FontsEvent (docs/desktop.md §14.3); `session`: SessionEnded (docs/multiplayer.md §15.8); `plugins`: PluginsEvent (docs/plugins.md §10); `devmode`: DevModeEvent (docs/editor.md D-8); `uploads`: UploadEvent (docs/multiplayer.md §5.1); `cloud`: CloudEvent (docs/cloud.md §2) */
export type EventTopic = "workspace" | "file.changes" | "library" | "multiplayer" | "comments" | "notifications" | "org" | "branches" | "fonts" | "session" | "plugins" | "devmode" | "uploads" | "cloud" | "blobs" | "brands";

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
  /** The server can't serve it right now (an org file whose encryption key is unavailable: docs/governance.md §2.10) */
  | "unavailable"
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
    "setTeamName",
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
    "setUndoHistory",
    "saveSnapshot",
    "listVersions",
    "createVersion",
    "updateVersion",
    "openVersion",
    "restoreDiff",
    "duplicateVersion",
    "importLocalCopy",
    "exportLocalCopy",
    "missingImages",
    "details",
    "importFigBytes",
    "exportFigBytes",
  ],
  blobs: ["put", "has", "get"],
  libraries: ["listAvailable", "getRecord", "getVersion", "previewPublish", "publish", "unpublish", "setEnabled", "getPayloads", "diff"],
  previews: ["status", "list", "publish", "stop", "exportHtml"],
  store: ["shutdown", "flushAll", "info", "collectGarbage"],
  multiplayer: ["setSession", "status", "fileState", "share", "listRemote", "openShared", "members", "fileReport", "fileActivity", "fileInfo", "setLinkAccess", "updateLink", "setViewersCanCopy", "requestEdit", "requests", "answerRequest", "invite", "removeMember", "exclusions", "exclude", "include", "presence", "takeOpenIntent", "unlockFile", "setLinkPassword", "transferOwnership", "signal", "restRender", "restAnswer", "uploads", "retryUpload", "cancelUpload"],
  comments: ["list", "add", "edit", "remove", "setResolved", "setRead", "react", "move", "mentionable"],
  notifications: ["list", "markRead", "prefs", "setPrefs", "answer"],
  // The org spaces (docs/multiplayer.md §14.6); `watch` is the `org` event topic
  orgs: ["list", "get", "create", "people", "drafts", "createDraft", "search", "requestSeat", "groups", "createGroup", "updateGroup", "setGroupMembers", "deleteGroup", "leave", "remove", "restore", "trashedDrafts", "update", "setIcon", "removeIcon", "iconData"],
  teams: ["list", "get", "page", "create", "update", "setIcon", "removeIcon", "remove", "restore", "transfer", "members", "invite", "setMember", "removeMember", "join", "leave", "requests", "answerRequest"],
  projects: [
    "list",
    "get",
    "page",
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
    "deleteFilesForever",
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
    "planTokens",
    "createPlanToken",
    "revokePlanToken",
  ],
  // Branches (docs/data.md §15.6); `watch` is the `branches` event topic
  branches: ["create", "list", "get", "rename", "archive", "restore", "mainStatus", "preview", "openSide", "applyUpdate", "merge", "requestReview", "answerReview", "withdrawReview", "closeReview", "undoMerge"],
  // Org libraries' settings (docs/data.md §16.3, §16.5) and library analytics (§17)
  orgLibraries: ["list", "get", "updateSettings", "setScope", "teamLibraries"],
  analytics: ["record", "orgOverview", "overview", "actions", "usage", "modes", "csv"],
  // Identity and security (docs/multiplayer.md §15, round 4)
  identity: ["overview", "saveIdp", "refreshIdpMetadata", "deleteIdp", "generateScimToken", "revokeScimToken", "addDomain", "verifyDomain", "removeDomain", "domainAccounts", "dataRegion", "setDataRegion", "moveNext"],
  // Governance+ (docs/governance.md §4, round 14)
  governance: ["overview", "setGovernancePlus", "setIpAllowlist", "addNetworkRange", "setNetworkRange", "removeNetworkRange", "policies", "createPolicy", "setPolicyEnabled", "setGuestExpiration", "ekm", "enableEkm", "encryptNext", "developerLogs", "idps", "saveIdp", "refreshIdp", "removeIdp", "generateIdpScimToken", "revokeIdpScimToken", "mapDomain", "pendingPolicies", "acknowledgePolicy", "twoFactor", "setupTwoFactor", "enableTwoFactor", "regenerateRecoveryCodes", "disableTwoFactor"],
  // Plugins (docs/plugins.md §10.4, round 5g); `plugins` is also an event topic
  plugins: ["local", "setSaved", "ranRecently", "listPrivate", "bundle", "publish", "removePrivate", "allowed", "request", "admin", "approve", "unapprove", "answer"],
  // Dev Mode (docs/editor.md D-8, round 5g); `devmode` is also an event topic
  devMode: ["devResources", "addDevResource", "editDevResource", "removeDevResource", "codeConnect", "setCodeConnect", "removeCodeConnect", "reportStatus", "viewed", "setStatusNotifications", "prototypeMembers", "invitePrototype", "removePrototype"],
  // AI ledger and Skills (docs/ai.md §8, round 6g) and the search index (round 6d)
  ai: ["record", "balance", "history", "skills", "saveSkill", "removeSkill"],
  search: ["upsert", "remove", "versions", "query", "thumb", "stats", "clear"],
  // The brand and product library (docs/studio.md §3, round 15); `brands` is also an event topic
  brands: ["list", "get", "find", "saveBrand", "removeBrand", "saveProduct", "removeProduct", "addImage", "removeImage", "image"],
  // Personal Drafts in the cloud and the cache (docs/cloud.md §2); `cloud` is also an event topic
  cloud: ["status", "refresh", "cacheInfo", "setCacheLimit", "clearCache"],
} as const satisfies Record<Repository, readonly string[]>;

/** Methods that take filesystem paths stay in main, behind native dialogs, so a renderer can never name a path. */
const MAIN_ONLY = new Set<string>(["files.importLocalCopy", "files.exportLocalCopy", "previews.exportHtml", "multiplayer.setSession"]);

/**
 * Methods that make or open a file (docs/desktop.md §18.6): with the login gate on, the store answers them only while
 * a session is on — signed out nobody can reach a file, from a view or from main. Listing, flushing what is open and
 * the rest stay open (Log out flushes after the session is gone).
 */
export const SESSION_METHODS: ReadonlySet<string> = new Set<StoreMethod>([
  "workspace.createFile",
  "workspace.duplicateFile",
  "files.open",
  "files.openVersion",
  "files.duplicateVersion",
  "files.importLocalCopy",
  "files.importFigBytes",
  "projects.createFile",
  "orgs.createDraft",
  "multiplayer.openShared",
  "branches.create",
  "branches.openSide",
]);

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
  "cloud.status",
  "cloud.refresh",
  "cloud.cacheInfo",
  "cloud.clearCache",
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
  "multiplayer.exclusions",
  "multiplayer.fileInfo",
  "multiplayer.uploads",
  "comments.list",
  "comments.mentionable",
  "notifications.list",
  "notifications.prefs",
  "orgs.list",
  "orgs.get",
  "orgs.people",
  "orgs.drafts",
  "orgs.search",
  "orgs.files",
  "orgs.groups",
  "teams.list",
  "teams.get",
  "teams.page",
  "teams.members",
  "teams.requests",
  "projects.list",
  "projects.get",
  "projects.page",
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
  "admin.planTokens",
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
  "governance.overview",
  "governance.policies",
  "governance.ekm",
  "governance.developerLogs",
  "governance.idps",
  "governance.pendingPolicies",
  "governance.twoFactor",
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
