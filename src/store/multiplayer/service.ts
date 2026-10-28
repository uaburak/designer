/**
 * The store's side of multiplayer (docs/multiplayer.md §5): the session with the server, this installation's device
 * ordinal, and one link per shared file — a WebSocket to the file's room that sends every local journal frame and
 * appends the room's other frames as `remote` ones (the open editor applies them with APPLY_REMOTE). Imports nothing
 * from Node or the DOM: the desktop store (LocalStore) and the browser's dev store (MemoryStore) both run it.
 *
 * Per link, persisted: the room's file key, `since` (the last room seq this file holds), `acked` (the last local journal
 * seq the room has acknowledged — the frames after it are resent on reconnect) and the room sessions this client has
 * been (to recognise its own frames in a catch-up after a reconnect).
 */
import type { RoomPolicy } from "../../shared/org/identity";
import { GOVERNANCE_SIGN_IN_ERROR_TEXT, REQUIRES_GOVERNANCE_PLUS, type GovernanceErrorCode, type OrgGate } from "../../shared/org/governance";
import { CLOSE_FULL, CLOSE_MOVING, CLOSE_REPLACED, CLOSE_TOO_OLD, DEAD_AFTER_MS, HEARTBEAT_MS, HEARTBEAT_REPLY, HEARTBEAT_TEXT, encodeChangesUp, decodeChangesDown, PROTOCOL_VERSION, type ClientControl, type PeerInfo, type Role, type ServerControl } from "../../shared/multiplayer/protocol";
import type { AccessRequest, FileMember, FileShareState, InheritedPerson, LinkAccess, LinkSettingsPatch, MultiplayerNotice, MultiplayerSession, MultiplayerSignal, MultiplayerStatus, OpenIntent, OpeningProgress, RemoteFile, RestJobAnswer, RestJobRequest, SessionEnded, SharedFileInfo } from "../../shared/multiplayer/types";
import type { RestJob, RestJobPart } from "../../shared/rest/types";
import { decodeMessage } from "../../shared/schema/codec";
import type { Message } from "../../shared/schema/document.generated";
import { isPackedSnapshot, packSnapshot, unpackSnapshot } from "../../shared/multiplayer/snapshotWire";
import { messageImageHashes } from "../../shared/schema/patch";
import { StoreError } from "../../shared/store/protocol";
import { isQuotaRefusal } from "../../shared/quota";
import { accountSuspendedMessage, quotaMessage } from "../i18n";
import type { FileChange, Unsubscribe } from "../../shared/store/repositories";
import type { FileKey, FileMeta, FileSpace } from "../../shared/store/types";
import { touchedBy, withoutPending, type Touched } from "../../shared/multiplayer/conflict";
import { splitFrame } from "../../shared/multiplayer/split";
import { applyStructure, changesStructure, repairStructure, structureTouched, type Structure } from "../../shared/multiplayer/structure";
import { encodeMessage, type ParentIndex } from "../../shared/schema/codec";
import { guidKey } from "../../shared/schema/guid";
import { busyError, fetchWithRetry, isErrorPage, READ_RETRY_DELAYS, STILL_UPLOADING_TEXT, UPLOAD_RETRY_DELAYS, withRetry } from "./http";
import { countingBody, pool, sendBlobs, UploadTracker, BLOB_CONCURRENCY, type BlobSender, type MultipartStart, type UploadClock } from "./uploads";
import { BlobDownloads, DOWNLOAD_CONCURRENCY, imageDownloadOrder, type BlobSource } from "./downloads";
import { UPLOAD_CANCELED, UPLOAD_CANCELED_TEXT, type UploadEvent } from "../../shared/multiplayer/uploads";
import { t as tr } from "../../shared/i18n";
import type { FileActivityKind, FileActivityPage, FileServerReport } from "../../shared/store/fileSettings";

/** What the store gives the service. */
export interface MultiplayerHost {
  readonly fileChanges: { on(listener: (c: FileChange) => void): Unsubscribe };
  backlog(fileKey: FileKey, fromSeq: number): Promise<FileChange[]>;
  appendRemote(fileKey: FileKey, message: Uint8Array): Promise<{ seq: number }>;
  /** A change the store writes for the link (docs/multiplayer.md §18.12, a refused move or a rescued orphan): sent to the
   *  room as this copy's edits are, applied by the editor as another session's. Absent: the tree isn't repaired. */
  appendCorrection?(fileKey: FileKey, message: Uint8Array): Promise<{ seq: number }>;
  /** The file's tree from its snapshot and every journaled frame but `skip` (this copy's changes still waiting: what is
   *  left is the room's tree); null when one of them is folded into the snapshot already (§18.12) */
  structureAt?(fileKey: FileKey, skip: readonly number[]): Promise<Structure | null>;
  /** A new local file holding this snapshot as it is (no GUID remapping: the room's nodes keep their ids); `space`: the
   *  org file it copies (docs/multiplayer.md §14.6), so it never lists among local Drafts */
  createSharedFile(input: { name: string; snapshot: Uint8Array; space?: FileSpace | null; fileKey?: FileKey; message?: Message }): Promise<FileMeta>;
  /** A record listed from the server with no document here (docs/cloud.md §2) gets the room's snapshot as it is
   *  (`message`: the snapshot already decoded, so it isn't decoded twice) */
  fillFile?(fileKey: FileKey, snapshot: Uint8Array, message?: Message): Promise<void>;
  /** A key for a new file (a shared copy opened before its document is here: its tab opens on it at once) */
  newFileKey?(): FileKey;
  /** A new file's document (a draft registered whose content never reached its room) */
  newDocument?(): Uint8Array;
  /** An org file's copy moved (or a local file moved into an org): its `FileMeta.space` */
  setFileSpace?(fileKey: FileKey, space: FileSpace | null): Promise<void>;
  getMeta(fileKey: FileKey): FileMeta | null;
  readonly deviceOrdinal: number;
  /** New edit sessions use it from now on (and it is kept for the next start) */
  setDeviceOrdinal(ordinal: number): Promise<void>;
  /** The service's own state: the installation id and one record per link, each saved on its own (several browser tabs
   *  share one storage, each saving only the links it changed) */
  load(): Promise<{ installationId?: unknown; links?: Record<string, unknown> } | null>;
  saveInstallationId(id: string): Promise<void>;
  saveLink(fileKey: FileKey, link: unknown): Promise<void>;
  log(level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown): void;
  /** Images (and other blobs frames refer to by SHA-1): which the store has, their bytes, new ones */
  hasBlobs(sha1s: string[]): Promise<boolean[]>;
  getBlob(sha1: string): Promise<Uint8Array>;
  putBlob(bytes: Uint8Array): Promise<void>;
  /** The file's document at its journal head — snapshot and frames merged — as a kiwi Message (for the room's compaction) */
  headSnapshot(fileKey: FileKey): Promise<Uint8Array>;
  /** The file's thumbnail PNG (Home's card), null when it has none: uploaded for the REST API's `thumbnailUrl` (§16.7) */
  thumbnail?(fileKey: FileKey): Promise<Uint8Array | null>;
  /** Images' sizes in bytes (an upload's total before it starts); absent: each one's size is added as it is read */
  blobSizes?(sha1s: string[]): Promise<number[]>;
  /** Where an upload goes, in the upload panel's words ("Anex Tour › Design › KOC"); `place`: the org file's place, null
   *  for a file shared outside any org (docs/multiplayer.md §5.1) */
  describeUpload?(fileKey: FileKey, place: UploadPlace | null): Promise<string>;
}

/** An org file's place, as `POST /files` answers it and `FileMeta.space` keeps it */
export interface UploadPlace {
  orgId: string;
  teamId: string | null;
  projectId: string | null;
}

interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number; reason: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export interface MultiplayerDeps {
  fetch: typeof fetch;
  WebSocket: new (url: string) => WebSocketLike;
  random(): number;
  /** Milliseconds before reconnect attempt n (1, 2, …) */
  backoff?(attempt: number): number;
  /** Frames past the room's snapshot before a client compacts (default COMPACT_EVERY) */
  compactEvery?: number;
  /** Quiet this long after the room's last frame, a client compacts any frames past the snapshot (default
   *  QUIET_COMPACT_MS; 0: never), at most once a QUIET_COMPACT_EVERY_MS (default) */
  quietCompactMs?: number;
  quietCompactEveryMs?: number;
  /** Milliseconds between heartbeats on a ready room socket (default HEARTBEAT_MS; 0: none) and the silence after which a
   *  socket whose heartbeats were answered before is given up (default DEAD_AFTER_MS) — docs/multiplayer.md §4.1 */
  heartbeatMs?: number;
  deadAfterMs?: number;
  /** Milliseconds a sent frame waits for its echo before the socket is closed and the link reconnects (default ACK_TIMEOUT_MS) */
  ackTimeoutMs?: number;
  /** Milliseconds between a read's tries when the server is busy or unreachable (default READ_RETRY_DELAYS; [] never) */
  retryDelays?: readonly number[];
  /** Milliseconds between a share's upload tries — its images and snapshot (default UPLOAD_RETRY_DELAYS) */
  uploadRetryDelays?: readonly number[];
  /** Upload bodies as streams read in slices, so the upload panel sees their bytes go (the desktop store; a browser's
   *  fetch can't stream a request over HTTP/1.1): otherwise each part counts once it has gone */
  streamUploads?: boolean;
  /** The upload panel's clock (tests) */
  uploadClock?: UploadClock;
  /** Images coming down at once (default DOWNLOAD_CONCURRENCY) and the waits between an image's tries (tests) */
  downloadConcurrency?: number;
  downloadRetryDelays?: readonly number[];
  sleep?(ms: number): Promise<void>;
}

/** An upload the panel follows: its entry and the signal that cancels it */
interface Tracked {
  id: string;
  signal: AbortSignal;
}

/** A call's request body as it goes (uploads) and the signal that aborts it */
interface CallOptions {
  onSent?(bytes: number): void;
  signal?: AbortSignal;
}

const canceledError = () => new StoreError("invalid", tr(UPLOAD_CANCELED_TEXT), { code: UPLOAD_CANCELED });
export const isCanceled = (e: unknown): boolean => e instanceof StoreError && (e.detail as { code?: unknown } | undefined)?.code === UPLOAD_CANCELED;

interface LinkRecord {
  key: string;
  since: number;
  acked: number;
  sessions: number[];
  role: Role;
  /** The pass for a file's link password, when this user is in by the link alone and the file has one */
  pass?: string;
  /** Shared from here, but its images and snapshot didn't all reach the room yet: the link uploads them before it joins */
  pendingUpload?: true;
  /** Wecra 1.1.1 (docs/cloud.md §4.1): images of the room's snapshot not downloaded yet when the copy opened, in the
   *  order they come; the next start continues them (`resumeDownloads`). Cleared once all are here. */
  images?: string[];
  /** The account (server user id) the link was made with (docs/cloud.md §2): another account signed in leaves it idle
   *  rather than joining with a session that can't open it. Absent on links made before 1.1: joined by any account. */
  uid?: string;
  /** Phase 6 (docs/multiplayer.md §18.1): a journal frame too large for one room frame, sent as `parts`; `echoed` of them
   *  came back so far (a reconnect sends the rest). Gone once all did. */
  partial?: { batch: number; parts: number; echoed: number };
}

/** Why a linked copy was replaced by a fresh one (docs/multiplayer.md §18.3): it fell behind the room's history; its
 *  unsaved changes can't reach the room any more (this person can only view it now); one of them is too large to send */
export type ReplacedWhy = "too-old" | "read-only" | "too-large";

interface State {
  installationId: string;
  links: Record<FileKey, LinkRecord>;
}

export interface SessionOptions {
  /**
   * Only these files' rooms are joined (a browser tab joins only the file it edits or presents; Home tabs none), named by
   * the local key or by the room's (a prototype link names the room: its copy here is made, or found, after). Default: all.
   */
  only?: string[];
}

const CLOSE_UNSHARED = 4001;
const CLOSE_ACCESS = 4003;
/** After a 4012 (the room is moving to another region, docs/multiplayer.md §15.9) the link reconnects after this long */
export const MOVING_RETRY_MS = 2000;
/** A client uploads a new snapshot when the room holds this many frames past the last one (the room keeps a tail) */
export const COMPACT_EVERY = 1000;
/**
 * …and when the room has been quiet this long with any frames past it, at most once a QUIET_COMPACT_EVERY_MS from one
 * client (2026-10-28): frames never carry derived data, so a text edited since the last snapshot had no stored glyph
 * outlines in the room, and a viewer without its font (a phone opening a prototype set in a local font) drew it in
 * Inter, wider. The copy's head is the editor's snapshot by then, with fresh outlines.
 */
export const QUIET_COMPACT_MS = 2 * 60_000;
export const QUIET_COMPACT_EVERY_MS = 10 * 60_000;
/**
 * A frame the room hasn't echoed this long after it went closes the socket, and the reconnect sends it again (Figma:
 * "Disconnecting multiplayer session after not receiving ack for %fs"; its value isn't read — ours), plus ACK_PER_MB_MS
 * for each MB the frame carries (a large change on a slow connection is still going out).
 */
export const ACK_TIMEOUT_MS = 30_000;
export const ACK_PER_MB_MS = 8_000;
/**
 * A move (or delete) of this copy's journaled this soon after another person's change to the tree is checked against
 * it (docs/multiplayer.md §18.12): the editor made it before that change reached its engine, so it may close a cycle
 * or leave a layer without a parent in the room's order (ours).
 */
export const STRUCTURE_RECENT_MS = 10_000;
/** A full file (Figma's too-many-connections, §18.13) is tried again this long after (ours) */
export const FULL_RETRY_MS = 60_000;
/**
 * Figma's "Offline sync" savepoint (atlas 22 §3.3): before changes made away from the room are sent, the room's state is
 * kept as a version — on the link's first connection with changes waiting (edits restored at start), or after it was
 * offline this long (ours: Figma's own trigger is a restored session).
 */
export const OFFLINE_SYNC_AFTER_MS = 60_000;
/** The savepoint's words — Figma's, literal in its code (a version's title, kept on the server as data) */
export const OFFLINE_SYNC_TITLE = "Offline sync";
export const OFFLINE_SYNC_DESCRIPTION = "Before syncing changes";
/** A read of a file's members or access requests answers the reads asked for within this long after it */
export const READ_FRESH_MS = 2000;
/** A shared file's thumbnail goes to the server at most this often (docs/multiplayer.md §16.7: `thumbnailUrl`) */
export const THUMBNAIL_EVERY_MS = 60_000;

/** A link the server refuses with a Governance+ code tries again after this long (or at once when the person acts) */
export const BLOCKED_RETRY_MS = 5 * 60_000;

/** Governance+'s refusals (docs/governance.md §4): 403s, and 503 `key_unavailable` (`two_factor_invalid` is a 400) */
export type GovernanceRefusalCode = Exclude<GovernanceErrorCode, "two_factor_invalid">;
const GOVERNANCE_REFUSALS = new Set<string>(["governance_plus_required", "two_factor_required", "policy_acknowledgement_required", "ip_not_allowed", "network_restricted", "key_unavailable", "export_restricted"] satisfies GovernanceRefusalCode[]);
export const isGovernanceCode = (c: unknown): c is GovernanceRefusalCode => typeof c === "string" && GOVERNANCE_REFUSALS.has(c);
const isGate = (g: unknown): g is OrgGate => !!g && typeof g === "object" && typeof (g as { kind?: unknown }).kind === "string";

/** The text a refusal shows (ours where Figma's is unpublished, as docs/governance.md §5's screens) */
const GOVERNANCE_REFUSAL_TEXT: Partial<Record<GovernanceRefusalCode, string>> = {
  governance_plus_required: REQUIRES_GOVERNANCE_PLUS,
  two_factor_required: "This organization requires two-factor authentication for guests.",
  policy_acknowledgement_required: "Agree to your organization's policies to continue.",
  ip_not_allowed: "This organization only allows access from approved networks.",
  network_restricted: GOVERNANCE_SIGN_IN_ERROR_TEXT.network_restricted,
  key_unavailable: "This file is unavailable because its encryption key can't be reached.",
  export_restricted: "Exporting is turned off for you in this file.",
};

/** A call or a file's socket refused with a Governance+ code (MultiplayerService.onGovernance) */
export interface GovernanceRefusal {
  code: GovernanceRefusalCode;
  gate?: OrgGate;
  /** The org whose gate it is; null when account-wide (`network_restricted`) or not known */
  orgId: string | null;
  /** The shared file refused, when the call named one */
  fileKey?: FileKey;
}

const sha1Hex = async (bytes: Uint8Array): Promise<string> => [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, "0")).join("");

const imagesOf = (message: Uint8Array): string[] => {
  try {
    return [...messageImageHashes(decodeMessage(message))];
  } catch {
    return [];
  }
};

export class MultiplayerService {
  private session: MultiplayerSession | null = null;
  private only: Set<string> | null = null;
  private state: State | null = null;
  private live = new Map<FileKey, Link>();
  private listeners = new Set<(fileKey: FileKey, s: FileShareState) => void>();
  private saving: Promise<void> = Promise.resolve();
  private off: Unsubscribe;

  /** Uploads to the server as the upload panel shows them (topic `uploads`, docs/multiplayer.md §5.1) */
  readonly uploads: UploadTracker;
  /** The upload under way per file: aborting it cancels it */
  private uploading = new Map<FileKey, AbortController>();
  /** Images coming down after their file opened (docs/cloud.md §4.1): the transfers panel's "Downloading images" */
  readonly downloads: BlobDownloads;
  /** This running app in the rooms (`hello.client`, docs/multiplayer.md §4.1): a reconnect replaces its older socket */
  readonly clientId: string;

  constructor(
    private host: MultiplayerHost,
    private deps: MultiplayerDeps,
  ) {
    this.clientId = Array.from({ length: 4 }, () => Math.floor(deps.random() * 0x1000000).toString(36).padStart(5, "0")).join("");
    this.off = host.fileChanges.on((c) => this.live.get(c.fileKey)?.local(c));
    this.uploads = new UploadTracker(deps.uploadClock);
    this.downloads = new BlobDownloads(this.blobSource(), this.uploads, {
      concurrency: deps.downloadConcurrency,
      retryDelays: deps.downloadRetryDelays,
      onFileDone: (fileKey) => void this.imagesDone(fileKey),
    });
  }

  /** Main (desktop) or the page (browser) hands the session over; null signs out (links stay, sockets close). */
  async setSession(session: MultiplayerSession | null, opts: SessionOptions = {}): Promise<MultiplayerStatus> {
    const only = opts.only ? new Set(opts.only) : null;
    const sameOnly = (only === null) === (this.only === null) && (!only || (only.size === this.only!.size && [...only].every((k) => this.only!.has(k))));
    const same = session && this.session && session.server === this.session.server && session.token === this.session.token && sameOnly;
    if (same) return this.status();
    for (const l of this.live.values()) l.stop();
    this.dropVisits();
    this.live.clear();
    this.session = session;
    this.ended = false;
    this.policies.clear();
    this.blocked.clear();
    this.reads.clear(); // another person's reads aren't this one's
    this.only = only;
    for (const l of this.sessionListeners) l(session);
    if (!session) return this.status();
    const st = await this.loadState();
    try {
      const { ordinal } = await this.api<{ ordinal: number }>("POST", "/devices", { installationId: st.installationId });
      if (ordinal !== this.host.deviceOrdinal) await this.host.setDeviceOrdinal(ordinal);
    } catch (e) {
      // Offline: shared files wait. The ordinal is only needed before a first share or join, which need the server anyway.
      this.host.log("warn", "multiplayer: couldn't reach the server", e);
    }
    for (const fileKey of Object.keys(st.links)) this.startLink(fileKey);
    void this.resumeDownloads();
    return this.status();
  }

  async status(): Promise<MultiplayerStatus> {
    return { signedIn: this.session !== null, server: this.session?.server ?? null, deviceOrdinal: this.host.deviceOrdinal };
  }

  async fileState(fileKey: FileKey): Promise<FileShareState> {
    const st = await this.loadState();
    const rec = st.links[fileKey];
    const link = this.live.get(fileKey);
    return {
      shared: !!rec,
      key: rec?.key ?? null,
      // Past the editors' limit the room made this session a viewer's (§18.13): the editor is read-only meanwhile
      role: link?.limited ? "viewer" : (rec?.role ?? null),
      ...(link?.limited ? { limited: "editors" as const } : {}),
      connection: link?.connection ?? "offline",
      peers: link ? [...link.peers.values()] : [],
      requests: this.requestCounts.get(fileKey) ?? 0,
      me: link?.sessionID || null,
      locked: this.locked.has(fileKey),
      policy: this.policies.get(fileKey) ?? null,
      blocked: this.blocked.get(fileKey) ?? null,
      unacked: link ? { since: link.unackedSince, lastAckAt: link.lastAckAt } : null,
    };
  }

  // --- Governance+ refusals (docs/governance.md §2.5, §2.10; round 14e) ---

  /** Shared files whose room the server refuses with a Governance+ code: their links wait */
  private blocked = new Map<FileKey, { code: GovernanceRefusalCode; gate?: OrgGate }>();
  private blockedTimer: ReturnType<typeof setTimeout> | null = null;
  private governanceListeners = new Set<(e: GovernanceRefusal) => void>();

  /** A call or a socket refused with one of Governance+'s codes (the stores refresh the org and say `access.blocked`) */
  onGovernance(listener: (e: GovernanceRefusal) => void): Unsubscribe {
    this.governanceListeners.add(listener);
    return () => this.governanceListeners.delete(listener);
  }

  private governanceRefused(e: GovernanceRefusal): void {
    for (const l of [...this.governanceListeners]) {
      try {
        l(e);
      } catch (err) {
        this.host.log("warn", "multiplayer: a governance listener failed", err);
      }
    }
  }

  /** The refusal's body, read off a copy of the answer (only 403 and 503 answers are looked at) */
  private async governanceAnswer(res: Response, path: string): Promise<void> {
    let body: { code?: unknown; gate?: unknown } | null = null;
    try {
      body = (await res.json()) as { code?: unknown; gate?: unknown };
    } catch {
      return;
    }
    // Gates and restrictions only: the add-on missing (Admin) and the export restriction (one file's action) aren't
    if (!isGovernanceCode(body?.code) || body.code === "governance_plus_required" || body.code === "export_restricted") return;
    const roomKey = /^\/files\/([^/?]+)/.exec(path)?.[1] ?? null;
    const fileKey = roomKey ? this.fileOfRoom(roomKey) : null;
    const orgId = /^\/orgs\/([^/?]+)/.exec(path)?.[1] ?? (fileKey ? (this.host.getMeta(fileKey)?.space?.orgId ?? null) : null);
    this.governanceRefused({ code: body.code, ...(isGate(body.gate) ? { gate: body.gate } : {}), orgId: body.code === "network_restricted" ? null : orgId, ...(fileKey ? { fileKey } : {}) });
  }

  private fileOfRoom(roomKey: string): FileKey | null {
    for (const [fileKey, rec] of Object.entries(this.state?.links ?? {})) if (rec.key === roomKey) return fileKey;
    return null;
  }

  /** @internal The room refuses this link (a gate, the network, the org's key): it waits, the editor is told. */
  block(fileKey: FileKey, b: { code: GovernanceRefusalCode; gate?: OrgGate }, say = false): void {
    this.blocked.set(fileKey, b);
    this.live.get(fileKey)?.stop();
    this.live.delete(fileKey);
    this.emitState(fileKey);
    if (say) {
      const orgId = b.code === "network_restricted" ? null : (this.host.getMeta(fileKey)?.space?.orgId ?? null);
      this.governanceRefused({ ...b, orgId, fileKey });
    }
    if (!this.blockedTimer) {
      this.blockedTimer = setTimeout(() => {
        this.blockedTimer = null;
        this.retryBlocked();
      }, BLOCKED_RETRY_MS);
    }
  }

  /** The waiting links try again: the person agreed to a policy, turned on 2FA, or the slow timer rang. `orgId`: only
   *  that org's files (and those whose org isn't known). */
  retryBlocked(orgId?: string | null): void {
    for (const fileKey of [...this.blocked.keys()]) {
      const org = this.host.getMeta(fileKey)?.space?.orgId ?? null;
      if (orgId && org && org !== orgId) continue;
      this.blocked.delete(fileKey);
      this.startLink(fileKey);
      this.emitState(fileKey);
    }
    if (!this.blocked.size && this.blockedTimer) {
      clearTimeout(this.blockedTimer);
      this.blockedTimer = null;
    }
  }

  /** The room's policy per open file (docs/multiplayer.md §15.9): from `welcome.policy`, then `{t: "policy"}` */
  private policies = new Map<FileKey, RoomPolicy>();
  private policyListeners = new Set<(fileKey: FileKey, policy: RoomPolicy) => void>();
  /** The org changed cursor chat or audio while the file is open (the editor applies it at once) */
  onPolicy(listener: (fileKey: FileKey, policy: RoomPolicy) => void): Unsubscribe {
    this.policyListeners.add(listener);
    return () => this.policyListeners.delete(listener);
  }

  /** @internal The room's policy, from its welcome (null: none — outside orgs) or a `{t: "policy"}` (`changed`) */
  setPolicy(fileKey: FileKey, policy: RoomPolicy | null, changed: boolean): void {
    const before = this.policies.get(fileKey) ?? null;
    if (policy) this.policies.set(fileKey, { cursorChat: policy.cursorChat !== false, audio: policy.audio !== false });
    else this.policies.delete(fileKey);
    const after = this.policies.get(fileKey) ?? null;
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    if (changed && after) for (const l of [...this.policyListeners]) l(fileKey, after);
    this.emitState(fileKey);
  }

  /** The session ended by the server's 401 (once per session) */
  private ended = false;
  private endedListeners = new Set<(e: SessionEnded) => void>();
  /** The server ended the session (docs/multiplayer.md §15.8): main / the web page signs out on `idle_timeout` */
  onSessionEnded(listener: (e: SessionEnded) => void): Unsubscribe {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  /** A 401 on one of our calls (the server answers 401 only for a dead session): said once, and the session is dropped
   *  here too (sockets close, the org caches and the inbox follow `onSession`), so nothing keeps retrying with it. A
   *  refusal of an earlier session (signed in again meanwhile) changes nothing. */
  private async sessionRefused(res: Response, session: MultiplayerSession): Promise<void> {
    if (this.ended || this.session !== session) return;
    let code: unknown = null;
    try {
      code = ((await res.clone().json()) as { code?: unknown }).code;
    } catch {
      // not JSON
    }
    if (this.ended || this.session !== session) return;
    this.ended = true;
    const e: SessionEnded = { reason: code === "idle_timeout" ? "idle_timeout" : "expired" };
    this.host.log("warn", `multiplayer: the server ended the session (${e.reason})`);
    await this.setSession(null);
    this.ended = true;
    for (const l of [...this.endedListeners]) {
      try {
        l(e);
      } catch (err) {
        this.host.log("warn", "multiplayer: a session listener failed", err);
      }
    }
  }

  /** Share › Invite on a file not shared yet: registers it on the server with the editor's snapshot of it at `headSeq`. */
  async share(fileKey: FileKey, input: { snapshot: Uint8Array; headSeq: number }): Promise<FileShareState> {
    if ((await this.loadState()).links[fileKey]) return this.fileState(fileKey);
    await this.shareTo(fileKey, input, (key, name) => this.api("POST", "/files", { key, name }));
    return this.fileState(fileKey);
  }

  /**
   * Share with a destination (docs/multiplayer.md §14.6): registers a local file on the server through `register` (the
   * plain `POST /files`, an org's folder or drafts), uploads its images and the editor's snapshot at `headSeq`, and links
   * it. `key` is the room key to use (default: one made from the file's key). Returns what `register` answered.
   */
  async shareTo<T>(fileKey: FileKey, input: { snapshot: Uint8Array; headSeq: number }, register: (key: string, name: string) => Promise<T>, key?: string): Promise<T> {
    const st = await this.loadState();
    if (st.links[fileKey]) throw new StoreError("invalid", tr("This file is shared already"));
    const meta = this.host.getMeta(fileKey);
    if (!meta) throw new StoreError("not-found", tr("No such file"));
    this.needOrdinal();
    const room = key ?? roomKeyFor(fileKey, this.deps.random);
    // The upload panel shows it from here (queued while the server registers it)
    const ac = new AbortController();
    this.uploading.set(fileKey, ac);
    const id = this.uploads.begin({ fileKey, name: meta.name }, this.uploadControls(fileKey));
    let answer: T;
    try {
      answer = await register(room, meta.name);
    } catch (e) {
      this.uploading.delete(fileKey);
      this.uploads.remove(id);
      throw e;
    }
    const place = placeOf(answer) ?? spacePlace(meta.space);
    void this.describeUpload(id, fileKey, place);
    // The file exists on the server from here: the link remembers its upload until the snapshot has landed, so a
    // failure part-way (the 2026-10-12 incident: the row made, then the image check and the snapshot refused) is
    // finished by the next start of the link instead of leaving a file with no snapshot behind.
    const rec: LinkRecord = { key: room, since: 0, acked: input.headSeq, sessions: [], role: "owner", pendingUpload: true, ...this.uidField() };
    st.links[fileKey] = rec;
    await this.persist(fileKey);
    try {
      if (ac.signal.aborted) throw canceledError();
      await this.uploadContent(room, input.snapshot, undefined, { id, signal: ac.signal });
    } catch (e) {
      this.uploading.delete(fileKey);
      if (isCanceled(e)) {
        // Cancelled in the panel: the file stays here as it was, and the server's empty file goes
        await this.abandonUpload(fileKey, id, room, { local: false, inOrg: !!place });
        throw canceledError();
      }
      this.host.log("warn", `multiplayer ${fileKey}: the upload to ${room} didn't finish; it goes again when the file is next opened`, e);
      const err = e instanceof StoreError ? e : new StoreError("offline", tr("Couldn't reach the server. Check your connection and try again."));
      this.uploads.failed(id, err.message);
      // The link keeps trying in the background (with its backoff), as it would after a restart
      this.startLink(fileKey);
      throw new StoreError(err.code, tr("“{name}” didn't finish uploading. It will try again the next time it's opened.", { name: meta.name }), { code: "upload_incomplete", pendingUpload: true, fileKey, key: room, cause: err.message });
    }
    this.uploading.delete(fileKey);
    delete rec.pendingUpload;
    await this.persist(fileKey);
    this.uploads.done(id);
    this.startLink(fileKey);
    void this.uploadThumbnail(fileKey);
    return answer;
  }

  /** Uploads' progress for the upload panel (topic `uploads`) */
  onUploads(listener: (e: UploadEvent) => void): Unsubscribe {
    return this.uploads.on(listener);
  }

  /**
   * Bytes PUT part by part as one upload of `fileKey` in the panel (a library publish's payloads and images, data.md
   * §16.6): each part tried again through a busy moment; Cancel aborts it (the caller's call fails), no Retry — the
   * person publishes again. `concurrency`: parts in flight at once (BLOB_CONCURRENCY by default; a publish's bundles
   * more, src/store/libraries/org.ts PUBLISH_CONCURRENCY).
   */
  async uploadParts(fileKey: FileKey, parts: { path: string; bytes: Uint8Array; method?: "PUT" | "POST" }[], opts?: { concurrency?: number }): Promise<void> {
    const meta = this.host.getMeta(fileKey);
    const ac = new AbortController();
    const id = this.uploads.begin({ fileKey, name: meta?.name ?? "Library" }, { cancel: () => ac.abort() });
    void this.describeUpload(id, fileKey, spacePlace(meta?.space));
    const delays = this.deps.uploadRetryDelays ?? UPLOAD_RETRY_DELAYS;
    this.uploads.setTotal(
      id,
      parts.reduce((n, p) => n + p.bytes.length, 0),
    );
    // 4 at a time (docs/cloud.md §4); each part's bytes counted as it goes, falling back to what landed when it goes again
    let landed = 0;
    const going = new Map<number, number>();
    const say = () => this.uploads.progress(id, landed + [...going.values()].reduce((a, b) => a + b, 0));
    // Uploading from the first request (not "Waiting to upload…" until a body's first slice or a part's answer)
    if (parts.length) say();
    try {
      await pool(parts, Math.max(1, opts?.concurrency ?? BLOB_CONCURRENCY), async (p, i) => {
        await withRetry(
          delays,
          () => {
            if (ac.signal.aborted) throw canceledError();
            going.set(i, 0);
            return this.raw(p.method ?? "PUT", p.path, p.bytes, {
              signal: ac.signal,
              onSent: (n) => {
                going.set(i, n);
                say();
              },
            });
          },
          (attempt) => this.uploads.retrying(id, attempt, landed),
        );
        going.delete(i);
        landed += p.bytes.length;
        say();
      });
    } catch (e) {
      if (isCanceled(e)) this.uploads.remove(id);
      else this.uploads.failed(id, e instanceof StoreError ? e.message : tr("Couldn't reach the server. Check your connection and try again."));
      throw e;
    }
    this.uploads.done(id);
  }

  /** The panel's Retry and Cancel for a file's upload */
  private uploadControls(fileKey: FileKey) {
    return { retry: () => this.retryUpload(fileKey), cancel: () => void this.cancelUpload(fileKey) };
  }

  private async describeUpload(id: string, fileKey: FileKey, place: UploadPlace | null): Promise<void> {
    if (!this.host.describeUpload) return;
    try {
      this.uploads.setDestination(id, await this.host.describeUpload(fileKey, place));
    } catch (e) {
      this.host.log("debug", `multiplayer ${fileKey}: the upload's destination couldn't be named`, e);
    }
  }

  /** Retry in the panel: a waiting upload goes now (its link starts again at once) */
  retryUpload(fileKey: FileKey): void {
    if (this.uploading.has(fileKey) || !this.state?.links[fileKey]?.pendingUpload) return;
    this.live.get(fileKey)?.stop();
    this.live.delete(fileKey);
    this.startLink(fileKey);
  }

  /**
   * Cancel in the panel: the upload under way stops (its own catch tidies up); one waiting to try again is dropped now —
   * the link goes, the file stays here as a local file, and the server's file without content is removed.
   */
  async cancelUpload(fileKey: FileKey): Promise<void> {
    const running = this.uploading.get(fileKey);
    if (running) return running.abort();
    const id = this.uploads.of(fileKey);
    const rec = this.state?.links[fileKey];
    if (rec?.pendingUpload) await this.abandonUpload(fileKey, id, rec.key, { local: true, inOrg: !!this.host.getMeta(fileKey)?.space });
    else if (id) this.uploads.remove(id);
  }

  /** A cancelled upload: unlinked (`pendingUpload` gone with the link), back to a local file when `local` (an org file's
   *  copy leaves the org), and the server's empty file removed (an org's trashed first, as "Delete forever" asks) */
  private async abandonUpload(fileKey: FileKey, id: string | null, room: string, o: { local: boolean; inOrg: boolean }): Promise<void> {
    this.host.log("info", `multiplayer ${fileKey}: the upload to ${room} was cancelled; the file stays here`);
    await this.unlink(fileKey);
    if (o.local && this.host.getMeta(fileKey)?.space) await this.host.setFileSpace?.(fileKey, null);
    if (id) this.uploads.remove(id);
    void (async () => {
      try {
        if (o.inOrg) await this.api("POST", `/files/${room}/trash`);
        await this.api("DELETE", `/files/${room}`);
      } catch (e) {
        this.host.log("warn", `multiplayer: the cancelled upload's file ${room} wasn't removed from the server`, e);
      }
    })();
  }

  /**
   * A shared file's first content in its room — its images (4 at a time, big ones in parts: docs/cloud.md §4), then its
   * snapshot at seq 0 — each request tried again while the server is busy or unreachable for a moment; resolves only
   * once the snapshot has landed. `up`: the panel's entry (bytes as they go, speed, retries) and its cancel.
   */
  private async uploadContent(room: string, snapshot: Uint8Array, alive: () => boolean = () => !this.closed, up?: Tracked): Promise<void> {
    const delays = this.deps.uploadRetryDelays ?? UPLOAD_RETRY_DELAYS;
    const step = <T>(run: () => Promise<T>) => () => {
      if (up?.signal.aborted) throw canceledError();
      if (!alive()) throw new StoreError("offline", tr(PAUSED_TEXT));
      return run();
    };
    // Bytes of the requests landed; one going again falls back to it
    let landed = 0;
    const sha1s = imagesOf(snapshot);
    // Gzipped for the wire (snapshotWire.ts): a large file's ~80 MB Message goes as ~12 MB
    const packed = await packSnapshot(snapshot);
    let total = packed.length;
    const onRetry = up && ((attempt: number) => this.uploads.retrying(up.id, attempt, landed));
    const missing = sha1s.length ? await withRetry(delays, step(() => this.missingBlobs(room, sha1s)), onRetry) : [];
    const sizes = up && missing.length && this.host.blobSizes ? await this.host.blobSizes(missing).catch(() => null) : null;
    if (sizes) total += sizes.reduce((a, b) => a + b, 0);
    if (up) this.uploads.setTotal(up.id, total);
    await sendBlobs(missing, this.blobSender(room, { signal: up?.signal, retry: (run) => withRetry(delays, step(run), onRetry) }), {
      signal: up?.signal,
      onSize: (_sha1, size) => {
        if (up && !sizes) this.uploads.setTotal(up.id, (total += size));
      },
      onProgress: (sent, done) => {
        landed = done;
        if (up) this.uploads.progress(up.id, sent);
      },
    });
    const base = landed;
    const call: CallOptions | undefined = up && { signal: up.signal, onSent: (n) => this.uploads.progress(up.id, base + n) };
    await withRetry(delays, step(() => this.api("PUT", `/files/${room}/snapshot?seq=0`, packed, call)), onRetry);
  }

  /**
   * How a file's images reach its room (uploads.ts `sendBlobs`): one PUT each, or — over 8 MB, where the server takes it
   * (docs/cloud.md §4) — a multipart upload whose parts go one by one. An older server (404) or an org whose images are
   * sealed (409 `multipart_unavailable`) takes the one PUT.
   */
  private blobSender(room: string, o: { signal?: AbortSignal; retry<T>(run: () => Promise<T>): Promise<T> }): BlobSender {
    const base = `/files/${room}/blobs`;
    const opts = (onSent?: (n: number) => void): CallOptions => ({ ...(o.signal ? { signal: o.signal } : {}), ...(onSent ? { onSent } : {}) });
    return {
      bytes: (sha1) => this.host.getBlob(sha1),
      put: async (sha1, bytes, onSent) => void (await this.raw("PUT", `${base}/${sha1}`, bytes, opts(onSent))),
      start: async (sha1, size) => {
        const res = await this.request("POST", `${base}/${sha1}/uploads`, { size }, opts());
        if (res.status === 404 || res.status === 405) return null;
        if (!res.ok) {
          const e = await httpError(res);
          if ((e.detail as { code?: unknown } | undefined)?.code === "multipart_unavailable") return null;
          throw e;
        }
        return (await res.json()) as MultipartStart;
      },
      part: (sha1, id, n, bytes, onSent) => this.api("PUT", `${base}/${sha1}/uploads/${encodeURIComponent(id)}/parts/${n}`, bytes, opts(onSent)),
      complete: async (sha1, id, parts) => void (await this.api("POST", `${base}/${sha1}/uploads/${encodeURIComponent(id)}/complete`, { parts }, opts())),
      abort: async (sha1, id) => void (await this.request("DELETE", `${base}/${sha1}/uploads/${encodeURIComponent(id)}`)),
      retry: (run) => o.retry(run),
    };
  }

  /**
   * @internal A link whose share didn't finish uploading (`pendingUpload`): its images and snapshot go now, from this
   * copy's head, unless the room holds a snapshot already (an earlier try landed and only its answer was lost). True
   * when the room has the file's content; false when it should try again later — or the file is gone (then unlinked).
   */
  async finishUpload(fileKey: FileKey): Promise<boolean> {
    const rec = this.state?.links[fileKey];
    if (!rec?.pendingUpload) return !!rec;
    const meta = this.host.getMeta(fileKey);
    if (!meta || this.uploading.has(fileKey)) return false;
    // Signed out, another session or the store closing meanwhile: this try stops (the next start goes again)
    const session = this.session;
    const alive = () => !this.closed && this.session === session && this.state?.links[fileKey] === rec;
    // The upload panel shows the resumed upload (continuing its entry when it has one)
    const ac = new AbortController();
    this.uploading.set(fileKey, ac);
    const id = this.uploads.begin({ fileKey, name: meta.name }, this.uploadControls(fileKey));
    void this.describeUpload(id, fileKey, spacePlace(meta.space));
    try {
      let has = true;
      try {
        const res = await this.raw("GET", `/files/${rec.key}/snapshot`);
        await res.body?.cancel().catch(() => {});
      } catch (e) {
        if (!(e instanceof StoreError && (e.detail as { code?: unknown } | undefined)?.code === "no_snapshot")) throw e;
        has = false;
      }
      if (!has) {
        // The head's seq before its document: a frame journaled meanwhile is sent again rather than lost
        const head = Math.max(0, ...(await this.host.backlog(fileKey, 0)).map((c) => c.seq));
        await this.uploadContent(rec.key, await this.host.headSnapshot(fileKey), alive, { id, signal: ac.signal });
        rec.acked = Math.max(rec.acked, head);
      }
      if (ac.signal.aborted) throw canceledError();
      if (!alive()) throw new StoreError("offline", tr(PAUSED_TEXT));
      this.uploading.delete(fileKey);
      delete rec.pendingUpload;
      await this.persist(fileKey);
      this.uploads.done(id);
      this.host.log("info", `multiplayer ${fileKey}: finished uploading to ${rec.key}`);
      void this.uploadThumbnail(fileKey);
      return true;
    } catch (e) {
      this.uploading.delete(fileKey);
      if (isCanceled(e)) await this.abandonUpload(fileKey, id, rec.key, { local: true, inOrg: !!meta.space });
      else if (isGone(e)) {
        this.uploads.remove(id);
        await this.dropDead(fileKey, rec.key);
      } else {
        this.uploads.failed(id, e instanceof StoreError ? e.message : tr("Couldn't reach the server. Check your connection and try again."));
        this.host.log("warn", `multiplayer ${fileKey}: the upload to ${rec.key} didn't finish yet`, e);
      }
      return false;
    }
  }

  /**
   * @internal The server answered that a linked file doesn't exist (deleted, or no longer shared with this person): the
   * link is dropped and the copy stays here as a local file — said once, not retried every 30 s forever.
   */
  async dropDead(fileKey: FileKey, key: string): Promise<void> {
    if (!this.state?.links[fileKey]) return;
    this.host.log("warn", `multiplayer ${fileKey}: ${key} is gone from the server; the copy stays here, unlinked`);
    this.blocked.delete(fileKey);
    this.locked.delete(fileKey);
    await this.unlink(fileKey);
  }

  /** A fresh room key (an org file created on the server: docs/multiplayer.md §14.6) */
  newRoomKey(base = "file"): string {
    return roomKeyFor(base, this.deps.random);
  }

  /** The local copy linked to a room, if this installation has one */
  async linkedCopy(key: string): Promise<FileKey | null> {
    const st = await this.loadState();
    const hit = Object.entries(st.links).find(([fileKey, l]) => l.key === key && this.host.getMeta(fileKey));
    return hit?.[0] ?? null;
  }

  /** Every room key → its local copy (listings fill in `OrgFile.fileKey`) */
  async linkedCopies(): Promise<Map<string, FileKey>> {
    const st = await this.loadState();
    return new Map(Object.entries(st.links).filter(([fileKey]) => this.host.getMeta(fileKey)).map(([fileKey, l]) => [l.key, fileKey]));
  }

  /** The signed-in person's id, read from the session token's payload (unverified: it only keys caches), else null */
  get userId(): string | null {
    const token = this.session?.token;
    const part = token?.split(".")[1];
    if (!part) return null;
    try {
      const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="))) as { uid?: unknown };
      return typeof json.uid === "string" ? json.uid : null;
    } catch {
      return null;
    }
  }

  /**
   * A shared file's sync position (branching, docs/data.md §15.7): its room key, the room seq the copy holds, the last
   * local seq the room acknowledged, the connection and the frames not acknowledged yet. Null when it isn't shared.
   */
  async syncState(fileKey: FileKey): Promise<{ key: string; since: number; acked: number; connection: FileShareState["connection"]; pending: number; unsent: number } | null> {
    const rec = (await this.loadState()).links[fileKey];
    if (!rec) return null;
    const link = this.live.get(fileKey);
    // This copy's own frames the room hasn't acknowledged. Not `head - acked`: the journal's tail can be other people's
    // frames (a merge into main arrives as one), which are never acknowledged — the room sent them.
    const unsent = (await this.host.backlog(fileKey, rec.acked)).filter((c) => c.kind !== "remote").length;
    return { key: rec.key, since: rec.since, acked: rec.acked, connection: link?.connection ?? "offline", pending: link?.pendingCount ?? 0, unsent };
  }

  /** Files on the server the user owns or was invited to. */
  async listRemote(): Promise<RemoteFile[]> {
    const st = await this.loadState();
    const byKey = new Map(Object.entries(st.links).map(([fileKey, l]) => [l.key, fileKey]));
    const { files } = await this.api<{ files: { key: string; name: string; role: Role; ownerId: string; ownerName: string | null; sharedAt: number; updatedAt: number }[] }>("GET", "/files");
    return files.map((f) => ({ ...f, fileKey: byKey.get(f.key) ?? null }));
  }

  /** Opens a file shared with the user: its local copy, made from the room's snapshot the first time. A file whose link
   *  has a password (and the user isn't invited) needs `password`; without it the error's detail says
   *  `{passwordRequired: true}` (and `wrong: true` when the one given was wrong). */
  async openShared(key: string, password?: string, intent?: OpenIntent, opts: { early?: boolean } = {}): Promise<{ fileKey: FileKey }> {
    const { fileKey } = await this.openSharedCopy(key, password, opts.early === true);
    if (intent && (intent.nodeId || intent.mode)) this.intents.set(fileKey, intent);
    return { fileKey };
  }

  private intents = new Map<FileKey, OpenIntent>();
  async takeOpenIntent(fileKey: FileKey): Promise<OpenIntent | null> {
    const i = this.intents.get(fileKey) ?? null;
    this.intents.delete(fileKey);
    return i;
  }

  private async openSharedCopy(key: string, password: string | undefined, early: boolean): Promise<{ fileKey: FileKey }> {
    const st = await this.loadState();
    const had = Object.entries(st.links).find(([, l]) => l.key === key);
    if (had && this.host.getMeta(had[0])) return { fileKey: had[0] };
    const going = [...this.copying.entries()].find(([, c]) => c.key === key);
    if (going) {
      if (!early) await going[1].done;
      return { fileKey: going[0] };
    }
    this.needOrdinal();
    // By invite or by the link: the server answers with the caller's role (404 when neither).
    const remote = await this.api<SharedFileInfo>("GET", `/files/${key}`).catch((e: unknown) => {
      throw e instanceof StoreError && e.code === "not-found" ? new StoreError("not-found", tr("This file isn't shared with you, or the link is off")) : e;
    });
    // A branch goes by its main file's link password (docs/multiplayer.md §18.7): main's pass, when this person has it
    const mainKey = (remote as { branch?: { mainKey?: unknown } | null }).branch?.mainKey;
    if (remote.needsPassword && typeof mainKey === "string" && this.passes.has(mainKey) && !password) {
      this.passes.set(key, this.passes.get(mainKey)!);
      const again = await this.api<SharedFileInfo>("GET", `/files/${key}`).catch(() => null);
      if (again && !again.needsPassword) remote.needsPassword = false;
      else this.passes.delete(key);
    }
    if (remote.needsPassword) await this.unlock(key, password);
    // The copy is made under a key known now: an early open hands it back at once, so the file's tab opens and shows
    // the document coming down (Figma's progress bar) while `files.open` waits for it (`whenCopied`)
    const fileKey = this.host.newFileKey?.() ?? null;
    const space = spaceOf(key, (remote as RemoteWithOrg).org);
    if (!fileKey) return { fileKey: await this.copyFromRoom(key, remote.name, remote.role, space) };
    const done = this.copyFromRoom(key, remote.name, remote.role, space, fileKey)
      .then(() => this.opening(fileKey, { done: true }))
      .catch((e: unknown) => {
        this.opening(fileKey, { error: e instanceof Error ? e.message : String(e) });
        throw e;
      })
      .finally(() => this.copying.delete(fileKey));
    const copied = done.then(() => undefined);
    void copied.catch(() => {}); // said to whoever waits (the open, `whenCopied`); none may
    this.copying.set(fileKey, { key, done: copied });
    if (!early) await done;
    return { fileKey };
  }

  /** Shared copies being made (an early open's file key → its room and the copy) */
  private copying = new Map<FileKey, { key: string; done: Promise<void> }>();
  private openingListeners = new Set<(fileKey: FileKey, p: OpeningProgress) => void>();

  /** Before a file opens: a shared copy still coming down is waited for (its tab opened early) */
  async whenCopied(fileKey: FileKey): Promise<void> {
    await this.copying.get(fileKey)?.done;
  }

  /** A copy's document coming down: bytes so far of `total` (null: not said), then done or failed */
  onOpening(listener: (fileKey: FileKey, p: OpeningProgress) => void): Unsubscribe {
    this.openingListeners.add(listener);
    return () => this.openingListeners.delete(listener);
  }

  private opening(fileKey: FileKey, p: OpeningProgress): void {
    for (const l of this.openingListeners) l(fileKey, p);
  }

  /**
   * The room's snapshot, unpacked (snapshotWire.ts), its bytes said on topic `multiplayer` as they come for `fileKey`'s
   * opening (at most ~10 a second).
   */
  private async roomSnapshot(key: string, fileKey?: FileKey): Promise<{ seq: number; snapshot: Uint8Array; bare: boolean }> {
    const res = await this.raw("GET", `/files/${key}/snapshot`);
    const seq = Number(res.headers.get("x-seq") ?? "0");
    const total = Number(res.headers.get("content-length") ?? "") || null;
    let said = 0;
    const bytes = await readCounting(res, (n) => {
      const now = Date.now();
      if (!fileKey || (now - said < 100 && n !== total)) return;
      said = now;
      this.opening(fileKey, { received: n, total });
    });
    if (fileKey) this.opening(fileKey, { received: bytes.length, total: bytes.length, reading: true });
    return { seq, snapshot: await unpackSnapshot(bytes), bare: !isPackedSnapshot(bytes) };
  }

  /**
   * A room still holding a bare snapshot (sent before snapshots were packed) gets it packed at the same seq by someone
   * who may edit it — the next opens download a fraction of it. The same document, so nothing else changes; a refusal
   * (the room moved on meanwhile, a viewer) is left as it is.
   */
  private repack(key: string, seq: number, snapshot: Uint8Array, role: Role): void {
    if (role === "viewer") return;
    void (async () => {
      try {
        await this.api("PUT", `/files/${key}/snapshot?seq=${seq}`, await packSnapshot(snapshot));
      } catch (e) {
        this.host.log("debug", `multiplayer: ${key}'s snapshot stays bare`, e);
      }
    })();
  }

  /** The pass for a link password, kept for this room key (and with the file's link record once there is one). */
  private async unlock(key: string, password: string | undefined): Promise<void> {
    if (!password) throw new StoreError("forbidden", tr("This file is password protected"), { passwordRequired: true });
    const { pass } = await this.api<{ pass: string | null }>("POST", `/files/${key}/unlock`, { password }).catch((e: unknown) => {
      throw e instanceof StoreError && e.code === "forbidden" ? new StoreError("forbidden", tr("Incorrect password"), { passwordRequired: true, wrong: true }) : e;
    });
    if (pass) this.passes.set(key, pass);
    else this.passes.delete(key);
  }

  /** An open shared file whose link password changed: the new password, then the link carries on. */
  async unlockFile(fileKey: FileKey, password: string): Promise<FileShareState> {
    const rec = (await this.loadState()).links[fileKey];
    if (!rec) throw new StoreError("invalid", tr("This file isn't shared"));
    await this.unlock(rec.key, password);
    rec.pass = this.passes.get(rec.key);
    await this.persist(fileKey);
    this.locked.delete(fileKey);
    this.live.get(fileKey)?.stop();
    this.live.delete(fileKey);
    this.startLink(fileKey);
    return this.fileState(fileKey);
  }

  /** @internal The room refused this link's socket: is it the link password? Then the link waits for `unlockFile`. */
  async checkLocked(fileKey: FileKey): Promise<boolean> {
    const rec = this.state?.links[fileKey];
    if (!rec) return false;
    try {
      const info = await this.api<SharedFileInfo>("GET", `/files/${rec.key}`);
      if (!info.needsPassword) return false;
      this.passes.delete(rec.key);
      delete rec.pass;
      await this.persist(fileKey);
      this.locked.add(fileKey);
      this.live.get(fileKey)?.stop();
      this.live.delete(fileKey);
      this.emitState(fileKey);
      return true;
    } catch (e) {
      // Deleted on the server, or no longer shared with this person (our JSON 404 / 410 — not a busy page or no
      // network, which keep reconnecting): the link is dropped, the copy stays as a local file
      if (isGone(e)) {
        await this.dropDead(fileKey, rec.key);
        return true;
      }
      // A Governance+ refusal (the file's org gate, the network): the link waits instead of retrying
      const code = e instanceof StoreError ? (e.detail as { code?: unknown } | undefined)?.code : undefined;
      if (isGovernanceCode(code)) {
        const gate = (e as StoreError & { detail: { gate?: unknown } }).detail.gate;
        this.block(fileKey, { code, ...(isGate(gate) ? { gate } : {}) });
        return true;
      }
      return false;
    }
  }

  private passes = new Map<string, string>();
  private locked = new Set<FileKey>();

  /** A local copy made from the room's snapshot (and its images), linked at the snapshot's seq. */
  private async copyFromRoom(key: string, name: string, role: Role, space: FileSpace | null = null, fileKey?: FileKey): Promise<FileKey> {
    const st = await this.loadState();
    const { seq, snapshot, bare } = await this.roomSnapshot(key, fileKey);
    if (bare) this.repack(key, seq, snapshot, role);
    // Opened as soon as the document is here; its images come down after (docs/cloud.md §4.1). Decoded once here
    const message = decodeMessage(snapshot);
    const meta = await this.host.createSharedFile({ name, snapshot, message, ...(space ? { space } : {}), ...(fileKey ? { fileKey } : {}) });
    const head = Math.max(0, ...(await this.host.backlog(meta.fileKey, 0)).map((c) => c.seq));
    st.links[meta.fileKey] = { key, since: seq, acked: head, sessions: [], role, ...this.uidField(), ...(this.passes.has(key) ? { pass: this.passes.get(key) } : {}) };
    await this.persist(meta.fileKey);
    this.startLink(meta.fileKey);
    await this.queueImages(meta.fileKey, key, name, message);
    return meta.fileKey;
  }

  /**
   * A copy's images not in the store, queued to come down in the background (the page it opens on first) and kept
   * with its link for the next start. Never fails the open: a queue that can't start is said in the log.
   */
  private async queueImages(fileKey: FileKey, key: string, name: string, snapshot: Uint8Array | Message): Promise<void> {
    try {
      const { first, rest } = imageDownloadOrder(snapshot);
      const missing = await this.downloads.add({ fileKey, key, name, first, rest });
      const rec = this.state?.links[fileKey];
      if (!missing.length || !rec) return;
      rec.images = missing;
      await this.persist(fileKey);
    } catch (e) {
      this.host.log("warn", `multiplayer ${fileKey}: couldn't queue its images`, e);
    }
  }

  /** Every image of a copy came down (or isn't in its room): its link forgets them */
  private async imagesDone(fileKey: FileKey): Promise<void> {
    const rec = this.state?.links[fileKey];
    if (!rec?.images) return;
    delete rec.images;
    await this.persist(fileKey).catch((e: unknown) => this.host.log("warn", `multiplayer ${fileKey}: couldn't save its link`, e));
  }

  /** The images copies were still waiting for when the store last stopped (or the session went), queued again */
  private async resumeDownloads(): Promise<void> {
    const st = this.state;
    if (!st || !this.session) return;
    for (const [fileKey, rec] of Object.entries(st.links)) {
      if (!rec.images?.length || !this.ownLink(fileKey)) continue;
      const meta = this.host.getMeta(fileKey);
      if (!meta) continue;
      try {
        const missing = await this.downloads.add({ fileKey, key: rec.key, name: meta.name, rest: rec.images });
        if (!missing.length) await this.imagesDone(fileKey);
      } catch (e) {
        this.host.log("warn", `multiplayer ${fileKey}: couldn't continue its images`, e);
      }
    }
  }

  /**
   * An image something here needs now (an editor drawing it, an export): moved to the front of the download queue and
   * waited for. True once it is in the store; false when nothing here is fetching it, or it can't come.
   */
  async wantBlob(sha1: string): Promise<boolean> {
    return (await this.downloads.want(sha1)) ?? false;
  }

  /** Images that came down after their file opened (topic `blobs`) */
  onBlobsArrived(listener: (e: { arrived: string[] }) => void): Unsubscribe {
    return this.downloads.onArrived((arrived) => listener({ arrived }));
  }

  /** How the background downloads reach the server and the store */
  private blobSource(): BlobSource {
    return {
      has: (sha1s) => this.host.hasBlobs(sha1s),
      put: (bytes) => this.host.putBlob(bytes),
      get: async (key, sha1, onReceived, onSize) => {
        const res = await this.raw("GET", `/files/${key}/blobs/${sha1}`);
        const length = Number(res.headers.get("content-length") ?? "");
        if (length > 0) onSize(length);
        return readCounting(res, onReceived);
      },
      sizes: async (key, sha1s) => (await this.api<{ sizes?: Record<string, number> }>("POST", `/files/${key}/blobs/sizes`, { sha1s })).sizes ?? {},
      sleep: this.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      log: (level, message, detail) => this.host.log(level, message, detail),
    };
  }

  /** `{uid}` of the signed-in account for a new link record (nothing when the token says no one) */
  private uidField(): { uid?: string } {
    const uid = this.userId;
    return uid ? { uid } : {};
  }

  /** The link was made by the signed-in account (or before 1.1, by any): its room may be joined with this session */
  private ownLink(fileKey: FileKey): boolean {
    const uid = this.state?.links[fileKey]?.uid;
    return !uid || !this.userId || uid === this.userId;
  }

  /**
   * A draft of the person's Drafts listed from the server, with no document here yet (docs/cloud.md §2): the room's
   * snapshot (and its images) fill the record `fileKey` as it is, and the record is linked at the snapshot's seq. A
   * draft whose content never reached its room (registered, then the upload stopped elsewhere) opens as a new document
   * whose upload this link finishes (`pendingUpload`).
   */
  async linkInto(fileKey: FileKey, key: string, role: Role = "owner"): Promise<void> {
    const st = await this.loadState();
    if (st.links[fileKey]) return;
    if (!this.host.fillFile || !this.host.newDocument) throw new StoreError("invalid", "This store keeps no cloud files");
    this.needOrdinal();
    let seq = 0;
    let snapshot: Uint8Array;
    let pendingUpload = false;
    try {
      let bare: boolean;
      ({ seq, snapshot, bare } = await this.roomSnapshot(key, fileKey));
      if (bare) this.repack(key, seq, snapshot, role);
    } catch (e) {
      if (!(e instanceof StoreError && (e.detail as { code?: unknown } | undefined)?.code === "no_snapshot")) throw e;
      snapshot = this.host.newDocument();
      pendingUpload = true;
    }
    // Opened as soon as the document is here; its images come down after (docs/cloud.md §4.1). Decoded once here
    const message = pendingUpload ? undefined : decodeMessage(snapshot);
    await this.host.fillFile(fileKey, snapshot, message);
    const head = Math.max(0, ...(await this.host.backlog(fileKey, 0)).map((c) => c.seq));
    st.links[fileKey] = { key, since: seq, acked: head, sessions: [], role, ...this.uidField(), ...(pendingUpload ? { pendingUpload: true as const } : {}) };
    await this.persist(fileKey);
    this.startLink(fileKey);
    if (message) await this.queueImages(fileKey, key, this.host.getMeta(fileKey)?.name ?? "Untitled", message);
  }

  /** A link made before 1.1 becomes the signed-in account's (the 1.1 migration of the person's own files) */
  async claimLink(fileKey: FileKey): Promise<void> {
    const rec = (await this.loadState()).links[fileKey];
    const uid = this.userId;
    if (!rec || !uid || rec.uid === uid) return;
    rec.uid = uid;
    await this.persist(fileKey);
  }

  /** A link's record as the cache sees it (docs/cloud.md §2): its room, role, account and an upload not finished */
  async linkInfo(fileKey: FileKey): Promise<{ key: string; role: Role; uid: string | null; pendingUpload: boolean; uploading: boolean } | null> {
    const rec = (await this.loadState()).links[fileKey];
    return rec ? { key: rec.key, role: rec.role, uid: rec.uid ?? null, pendingUpload: !!rec.pendingUpload, uploading: this.uploading.has(fileKey) } : null;
  }

  /** @internal This copy fell behind what the room still holds (away too long): a fresh copy replaces it as the
   *  linked one; the old copy stays, unlinked, so nothing in it is lost. */
  async recover(fileKey: FileKey, why: ReplacedWhy = "too-old"): Promise<void> {
    const rec = this.state?.links[fileKey];
    if (!rec) return;
    const name = this.host.getMeta(fileKey)?.name ?? "Untitled";
    const space = this.host.getMeta(fileKey)?.space ?? null;
    this.live.get(fileKey)?.stop();
    this.live.delete(fileKey);
    delete this.state!.links[fileKey];
    await this.persist(fileKey);
    // Changes the room never took stay in the old copy — a local draft from now on (an org copy's `space` would hide it:
    // org files are listed from the server), so nothing made here is lost.
    const unsent = (await this.host.backlog(fileKey, rec.acked).catch(() => [])).some((c) => c.kind !== "remote");
    if (unsent && space) await this.host.setFileSpace?.(fileKey, null).catch((e) => this.host.log("warn", `multiplayer: ${name} kept in the org's space`, e));
    try {
      const fresh = await this.copyFromRoom(rec.key, name, rec.role, space);
      for (const l of this.replaced) l(fileKey, fresh, why);
    } catch (e) {
      this.host.log("error", `multiplayer: couldn't get a fresh copy of ${name}`, e);
    }
    this.emitState(fileKey);
  }

  /**
   * Figma's rollback (docs/multiplayer.md §18.3): local changes the room will never take — this person can only view the
   * file now, or a change no frame can carry — leave this copy behind the file's. It is replaced by a fresh copy of the
   * room's state (the server's values win, as Figma's client rolls back what the server didn't accept) and keeps the
   * changes as a local draft.
   */
  rollBack(fileKey: FileKey, why: Exclude<ReplacedWhy, "too-old">): Promise<void> {
    this.host.log("warn", `multiplayer ${fileKey}: local changes the room won't take (${why}) — a fresh copy replaces it`);
    return this.recover(fileKey, why);
  }

  private replaced = new Set<(from: FileKey, to: FileKey, why: ReplacedWhy) => void>();
  /** A linked copy was replaced by a fresh one (recover, rollBack) */
  onReplaced(listener: (from: FileKey, to: FileKey, why: ReplacedWhy) => void): Unsubscribe {
    this.replaced.add(listener);
    return () => this.replaced.delete(listener);
  }

  /** @internal Images the room doesn't have yet, uploaded from the store (those the store has), 4 at a time. */
  async uploadBlobs(key: string, sha1s: string[]): Promise<void> {
    await sendBlobs(await this.missingBlobs(key, sha1s), this.blobSender(key, { retry: (run) => run() }));
  }

  /** The images the room lacks that the store has (those it never had can't go) */
  private async missingBlobs(key: string, sha1s: string[]): Promise<string[]> {
    if (!sha1s.length) return [];
    const { missing } = await this.api<{ missing: string[] }>("POST", `/files/${key}/blobs/missing`, { sha1s });
    if (!missing.length) return [];
    const have = await this.host.hasBlobs(missing);
    return missing.filter((_, i) => have[i]);
  }

  /**
   * @internal Images the store doesn't have yet, downloaded from the room before the frame that uses them lands (a
   * version's, a collaborator's new image), DOWNLOAD_CONCURRENCY at a time; one coming down in the background already
   * is moved to the front and waited for rather than fetched twice. `fileKey` (a link's frame, Phase 6): one that
   * couldn't come now goes to the background downloads — tried again with their backoff, kept with the link for the next
   * start, the editor told when it lands (`onBlobsArrived`) — instead of leaving its layer on a placeholder for good.
   */
  async downloadBlobs(key: string, sha1s: string[], fileKey?: FileKey): Promise<void> {
    if (!sha1s.length) return;
    const have = await this.host.hasBlobs(sha1s);
    const missing = sha1s.filter((_, i) => !have[i]);
    const failed: string[] = [];
    await pool(missing, this.deps.downloadConcurrency ?? DOWNLOAD_CONCURRENCY, async (sha1) => {
      try {
        const queued = this.downloads.want(sha1);
        if (queued && (await queued)) return;
        const res = await this.raw("GET", `/files/${key}/blobs/${sha1}`);
        await this.host.putBlob(new Uint8Array(await res.arrayBuffer()));
      } catch (e) {
        // An image the uploader never had: the layer shows its placeholder, as with a missing image anywhere.
        this.host.log("warn", `multiplayer: image ${sha1} isn't in the room`, e);
        failed.push(sha1);
      }
    });
    if (fileKey && failed.length) await this.retryImages(fileKey, key, failed);
  }

  /** A frame's images that didn't come down: queued in the background and kept with the link (`images`) */
  private async retryImages(fileKey: FileKey, key: string, sha1s: string[]): Promise<void> {
    const rec = this.state?.links[fileKey];
    if (!rec) return;
    try {
      const queued = await this.downloads.add({ fileKey, key, name: this.host.getMeta(fileKey)?.name ?? "Untitled", rest: sha1s });
      if (!queued.length) return;
      rec.images = [...new Set([...(rec.images ?? []), ...queued])];
      await this.persist(fileKey);
    } catch (e) {
      this.host.log("warn", `multiplayer ${fileKey}: couldn't queue its images`, e);
    }
  }

  /** @internal The "Offline sync" savepoint (OFFLINE_SYNC_AFTER_MS): a named version of the room's head; a failure doesn't stop the sync */
  async offlineSavepoint(key: string): Promise<void> {
    await this.api("POST", `/files/${key}/versions`, { kind: "named", title: OFFLINE_SYNC_TITLE, description: OFFLINE_SYNC_DESCRIPTION }).catch((e) => this.host.log("warn", "multiplayer: the offline sync savepoint wasn't made", e));
  }

  /** @internal The room's history compacted at `seq` from this copy's head. */
  async uploadSnapshot(fileKey: FileKey, key: string, seq: number): Promise<boolean> {
    const snapshot = await this.host.headSnapshot(fileKey);
    try {
      await this.api("PUT", `/files/${key}/snapshot?seq=${seq}`, await packSnapshot(snapshot));
      void this.uploadThumbnail(fileKey);
      return true;
    } catch (e) {
      this.host.log("warn", "multiplayer: the room didn't take the snapshot", e);
      return false;
    }
  }

  /**
   * A shared file's people. Reads asked for while one is under way, or within READ_FRESH_MS of its answer, share it:
   * opening a file asked for them several times at once (comments' mentions on every read, the Share dialog). A change
   * made here (invite, remove, transfer) reads them again.
   */
  async members(fileKey: FileKey, fresh = false): Promise<FileMember[]> {
    return this.shared(`members:${fileKey}`, fresh, async () => {
      const { members } = await this.api<{ members: FileMember[] }>("GET", `/files/${await this.keyOf(fileKey)}/members`);
      return members;
    });
  }

  /** Reads in flight or answered within READ_FRESH_MS, by what they read */
  private reads = new Map<string, { p: Promise<unknown>; doneAt: number | null }>();
  private shared<T>(id: string, fresh: boolean, load: () => Promise<T>): Promise<T> {
    const hit = this.reads.get(id);
    if (!fresh && hit && (hit.doneAt === null || Date.now() - hit.doneAt < READ_FRESH_MS)) return hit.p as Promise<T>;
    const entry: { p: Promise<unknown>; doneAt: number | null } = { p: load(), doneAt: null };
    this.reads.set(id, entry);
    entry.p.then(
      () => void (entry.doneAt = Date.now()),
      () => void (this.reads.get(id) === entry && this.reads.delete(id)),
    );
    return entry.p as Promise<T>;
  }

  private requestCounts = new Map<FileKey, number>();
  private notices = new Set<(fileKey: FileKey, notice: MultiplayerNotice) => void>();
  onNotice(listener: (fileKey: FileKey, notice: MultiplayerNotice) => void): Unsubscribe {
    this.notices.add(listener);
    return () => this.notices.delete(listener);
  }

  /** @internal One of Figma's multiplayer signals for the file (§18.13), with whether this copy has unsaved changes:
   *  the editor says it in Figma's words */
  mpSignal(fileKey: FileKey, signal: MultiplayerSignal, unsaved: boolean): void {
    this.emitState(fileKey);
    for (const l of this.notices) l(fileKey, { kind: "signal", signal, unsaved });
  }

  /** @internal A notice from the room: requests are counted for editors, answers reach the person who asked. */
  async notice(fileKey: FileKey, n: MultiplayerNotice): Promise<void> {
    if (n.kind === "access-request") await this.requests(fileKey, true).catch(() => []);
    for (const l of this.notices) l(fileKey, n);
  }

  async requestEdit(fileKey: FileKey): Promise<void> {
    await this.api("POST", `/files/${await this.keyOf(fileKey)}/requests`);
  }

  /** Access requests (editors); shared as `members` reads are, read again on a new request and after an answer */
  async requests(fileKey: FileKey, fresh = false): Promise<AccessRequest[]> {
    return this.shared(`requests:${fileKey}`, fresh, async () => {
      const { requests } = await this.api<{ requests: AccessRequest[] }>("GET", `/files/${await this.keyOf(fileKey)}/requests`);
      if (this.requestCounts.get(fileKey) !== requests.length) {
        this.requestCounts.set(fileKey, requests.length);
        this.emitState(fileKey);
      }
      return requests;
    });
  }

  async answerRequest(fileKey: FileKey, userId: string, approve: boolean): Promise<AccessRequest[]> {
    await this.api("POST", `/files/${await this.keyOf(fileKey)}/requests/${encodeURIComponent(userId)}`, { approve });
    this.reads.delete(`members:${fileKey}`);
    return this.requests(fileKey, true);
  }

  /**
   * A shared file renamed here (the editor's title, Home's Rename): its name on the server too — Home's org listings,
   * the people it is shared with, its library's name and Library analytics read it there. Branches keep their own
   * names (BranchService); a viewer's copy, signed out or offline, the server keeps its name (logged).
   */
  async renameRemote(fileKey: FileKey, name: string): Promise<void> {
    const rec = (await this.loadState()).links[fileKey];
    if (!rec || rec.role === "viewer" || !this.session || this.host.getMeta(fileKey)?.branch) return;
    await this.api("PATCH", `/files/${rec.key}`, { name }).catch((e: unknown) => this.host.log("warn", `multiplayer: couldn't rename ${rec.key} on the server`, e));
  }

  async setViewersCanCopy(fileKey: FileKey, on: boolean): Promise<SharedFileInfo> {
    await this.api("PATCH", `/files/${await this.keyOf(fileKey)}`, { viewersCanCopy: on });
    return this.fileInfo(fileKey);
  }

  async fileInfo(fileKey: FileKey): Promise<SharedFileInfo> {
    return this.api<SharedFileInfo>("GET", `/files/${await this.keyOf(fileKey)}`);
  }

  /** The file's room key for File settings: a shared file's link, an org copy's or a cloud draft's own; null: a file
   *  only this computer has (or signed out) */
  private async serverKeyOf(fileKey: FileKey): Promise<string | null> {
    if (!this.session) return null;
    const meta = this.host.getMeta(fileKey);
    return (await this.loadState()).links[fileKey]?.key ?? meta?.space?.key ?? (meta?.cloud && !meta.cloud.pendingCreate ? meta.cloud.key : null) ?? null;
  }

  /** Home's File settings (docs/home.md "File settings [ours]"): what the server knows about the file; null when it
   *  isn't on the server or nobody is signed in */
  async fileReport(fileKey: FileKey): Promise<FileServerReport | null> {
    const key = await this.serverKeyOf(fileKey);
    return key ? this.api<FileServerReport>("GET", `/files/${key}/report`) : null;
  }

  /** One page of the file's activity on the server (newest first); null as `fileReport` */
  async fileActivity(fileKey: FileKey, query: { cursor?: number; kinds?: readonly FileActivityKind[]; limit?: number } = {}): Promise<FileActivityPage | null> {
    const key = await this.serverKeyOf(fileKey);
    if (!key) return null;
    const q = new URLSearchParams();
    if (query.cursor) q.set("cursor", String(Math.max(0, Math.floor(query.cursor))));
    if (query.limit) q.set("limit", String(Math.max(1, Math.floor(query.limit))));
    if (query.kinds?.length) q.set("kinds", query.kinds.join(","));
    const s = q.toString();
    return this.api<FileActivityPage>("GET", `/files/${key}/activity${s ? `?${s}` : ""}`);
  }

  async setLinkAccess(fileKey: FileKey, access: LinkAccess): Promise<SharedFileInfo> {
    await this.api("PATCH", `/files/${await this.keyOf(fileKey)}`, { linkAccess: access });
    return this.fileInfo(fileKey);
  }

  /** Share settings' Save: one PATCH, checked whole against the org's policy (docs/multiplayer.md §15.16) */
  async updateLink(fileKey: FileKey, patch: LinkSettingsPatch): Promise<SharedFileInfo> {
    if (Object.keys(patch).length) await this.api("PATCH", `/files/${await this.keyOf(fileKey)}`, patch);
    return this.fileInfo(fileKey);
  }

  async invite(fileKey: FileKey, email: string, role: "editor" | "viewer"): Promise<FileMember[]> {
    await this.api("PUT", `/files/${await this.keyOf(fileKey)}/members`, { email, role });
    return this.members(fileKey, true);
  }

  async removeMember(fileKey: FileKey, email: string): Promise<FileMember[]> {
    await this.api("DELETE", `/files/${await this.keyOf(fileKey)}/members/${encodeURIComponent(email)}`);
    return this.members(fileKey, true);
  }

  /** A team file's people through its team, with whose access to this file is taken away (file_exclusions) */
  async exclusions(fileKey: FileKey): Promise<InheritedPerson[]> {
    const { people } = await this.api<{ people: InheritedPerson[] }>("GET", `/files/${await this.keyOf(fileKey)}/exclusions`);
    return people;
  }

  async exclude(fileKey: FileKey, userId: string): Promise<InheritedPerson[]> {
    await this.api("PUT", `/files/${await this.keyOf(fileKey)}/exclusions`, { userId });
    this.reads.delete(`members:${fileKey}`);
    return this.exclusions(fileKey);
  }

  async include(fileKey: FileKey, userId: string): Promise<InheritedPerson[]> {
    await this.api("DELETE", `/files/${await this.keyOf(fileKey)}/exclusions/${encodeURIComponent(userId)}`);
    this.reads.delete(`members:${fileKey}`);
    return this.exclusions(fileKey);
  }

  /** "Transfer ownership" to an invited member (owner only; can't be undone). */
  async transferOwnership(fileKey: FileKey, email: string): Promise<FileMember[]> {
    await this.api("POST", `/files/${await this.keyOf(fileKey)}/transfer`, { email });
    const rec = this.state?.links[fileKey];
    if (rec) {
      rec.role = "editor";
      await this.persist(fileKey);
      this.emitState(fileKey);
    }
    return this.members(fileKey, true);
  }

  /** "Password required" for people in by the link (null turns it off). */
  async setLinkPassword(fileKey: FileKey, password: string | null): Promise<SharedFileInfo> {
    await this.api("PATCH", `/files/${await this.keyOf(fileKey)}`, { linkPassword: password });
    return this.fileInfo(fileKey);
  }

  /** A message to one session in the file's room ("Ask to spotlight", audio's WebRTC signalling) */
  async signal(fileKey: FileKey, to: number, data: unknown): Promise<void> {
    this.live.get(fileKey)?.signal(to, data);
  }

  private signals = new Set<(fileKey: FileKey, from: number, data: unknown) => void>();
  onSignal(listener: (fileKey: FileKey, from: number, data: unknown) => void): Unsubscribe {
    this.signals.add(listener);
    return () => this.signals.delete(listener);
  }

  /** @internal */
  signalled(fileKey: FileKey, from: number, data: unknown): void {
    for (const l of this.signals) l(fileKey, from, data);
  }

  /** Presence for a file's room (cursor, selection, page …), relayed to the others */
  async presence(fileKey: FileKey, data: unknown): Promise<void> {
    this.live.get(fileKey)?.presence(data);
  }

  onFileState(listener: (fileKey: FileKey, s: FileShareState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Closed (the store stops): uploads under way stop before their next step */
  private closed = false;

  close(): void {
    this.closed = true;
    this.off();
    this.uploads.close();
    this.downloads.close();
    this.blocked.clear();
    if (this.blockedTimer) clearTimeout(this.blockedTimer);
    this.blockedTimer = null;
    for (const t of this.thumbs.values()) if (t.timer) clearTimeout(t.timer);
    this.thumbs.clear();
    for (const l of this.live.values()) l.stop();
    this.dropVisits();
    this.live.clear();
  }

  // --- REST render jobs (docs/multiplayer.md §16.6, as built §16.16) ---

  /** Editors that can answer render jobs, per file: token → whether it is the hidden render helper */
  private renderers = new Map<FileKey, Map<string, { helper: boolean; owner?: object }>>();
  private restListeners = new Set<(fileKey: FileKey, req: RestJobRequest) => void>();
  private wantedListeners = new Set<(fileKey: FileKey) => void>();

  /**
   * An editor with the file's engine loaded can render (on), or no longer (off, its token; none: all of them). The
   * room hears it in the link's hello — `{render: true}`, `helper: true` too when only the hidden helper renders — so a
   * change of either reconnects the link (a hello is said once per socket). Returns the renderer's token (on).
   */
  async restRender(fileKey: FileKey, on: boolean, opts: { helper?: boolean } = {}, token?: string, owner?: object): Promise<string | null> {
    const before = this.renderFlags(fileKey);
    let set = this.renderers.get(fileKey);
    let id: string | null = null;
    if (on) {
      id = token ?? `r_${randomId(this.deps.random, 12)}`;
      if (!set) this.renderers.set(fileKey, (set = new Map()));
      set.set(id, { helper: opts.helper === true, ...(owner ? { owner } : {}) });
    } else {
      if (token) set?.delete(token);
      else set?.clear();
      if (set && !set.size) this.renderers.delete(fileKey);
    }
    const after = this.renderFlags(fileKey);
    if (before.render !== after.render || before.helper !== after.helper) this.live.get(fileKey)?.rehello();
    return id;
  }

  /**
   * A port closed (a tab or the hidden helper went away without saying `restRender(off)` — a view's renderer process
   * ends without React's cleanups): its renderers go, so the room stops sending it jobs that nobody answers (each one
   * waited out the 20 s a client gets before the helper was even asked — found running round 5 end to end, 2026-10-12).
   */
  releaseRenderersOf(owner: object): void {
    for (const [fileKey, set] of [...this.renderers]) {
      const mine = [...set].filter(([, r]) => r.owner === owner).map(([id]) => id);
      if (!mine.length) continue;
      const before = this.renderFlags(fileKey);
      for (const id of mine) set.delete(id);
      if (!set.size) this.renderers.delete(fileKey);
      const after = this.renderFlags(fileKey);
      if (before.render !== after.render || before.helper !== after.helper) this.live.get(fileKey)?.rehello();
    }
  }

  /** @internal What this client's hello says about rendering the file */
  renderFlags(fileKey: FileKey): { render: boolean; helper: boolean } {
    const set = this.renderers.get(fileKey);
    if (!set?.size) return { render: false, helper: false };
    return { render: true, helper: [...set.values()].every((r) => r.helper) };
  }

  /** A job for one of the file's renderers (an editor before the hidden helper) */
  onRestJob(listener: (fileKey: FileKey, req: RestJobRequest) => void): Unsubscribe {
    this.restListeners.add(listener);
    return () => this.restListeners.delete(listener);
  }

  /** A room of this person's has no client that can render (`{t: "rest-wanted"}` on the inbox): main's helper hears it */
  onRestWanted(listener: (fileKey: FileKey) => void): Unsubscribe {
    this.wantedListeners.add(listener);
    return () => this.wantedListeners.delete(listener);
  }

  /** @internal The room's `rest-job`: handed to a renderer, or refused when none is left (it went meanwhile). */
  restJob(fileKey: FileKey, id: string, job: RestJob): void {
    const rec = this.state?.links[fileKey];
    const set = this.renderers.get(fileKey);
    const to = set ? [...set.entries()].sort((a, b) => Number(a[1].helper) - Number(b[1].helper))[0]?.[0] : undefined;
    if (!rec || !to || !this.restListeners.size) {
      this.live.get(fileKey)?.say({ t: "rest-job-failed", id, err: "503 No client available to render this file. Open the file in Wecra and try again." });
      return;
    }
    const meta = this.host.getMeta(fileKey);
    const req: RestJobRequest = { id, job, to, seq: rec.since, name: meta?.name ?? "Untitled", lastModified: meta?.updatedAt ?? Date.now() };
    for (const l of [...this.restListeners]) l(fileKey, req);
  }

  /**
   * A renderer's answer: each part uploaded (`PUT /files/:key/rest-jobs/:id/parts/:name`, the room checks it by SHA-1),
   * then `rest-job-done` with the parts — after the frames this copy queued before it (a POST's variables reach the
   * room first, so the next read's job key has moved). A failed upload answers `rest-job-failed`.
   */
  async restAnswer(fileKey: FileKey, id: string, answer: RestJobAnswer): Promise<void> {
    const rec = (await this.loadState()).links[fileKey];
    const link = this.live.get(fileKey);
    if (!rec || !link) throw new StoreError("invalid", tr("This file isn't shared"));
    if ("err" in answer) return link.say({ t: "rest-job-failed", id, err: String(answer.err).slice(0, 1000) });
    const parts: RestJobPart[] = [];
    try {
      for (const p of answer.parts) {
        await this.raw("PUT", `/files/${rec.key}/rest-jobs/${encodeURIComponent(id)}/parts/${encodeURIComponent(p.name)}`, p.bytes);
        parts.push({ name: p.name, sha1: await sha1Hex(p.bytes), size: p.bytes.length, contentType: p.contentType });
      }
    } catch (e) {
      this.host.log("warn", `multiplayer ${fileKey}: a render job's part wasn't uploaded`, e);
      return link.say({ t: "rest-job-failed", id, err: `The render's upload failed: ${e instanceof Error ? e.message : String(e)}` });
    }
    await link.settled();
    link.say({ t: "rest-job-done", id, parts });
  }

  /** @internal The inbox's `{t: "rest-wanted", fileKey}` (the room key): said for this installation's copy, if it has one */
  async restWanted(key: string): Promise<void> {
    const fileKey = await this.linkedCopy(key);
    if (fileKey) for (const l of [...this.wantedListeners]) l(fileKey);
  }

  /** Throttled thumbnail uploads per file */
  private thumbs = new Map<FileKey, { last: number; timer: ReturnType<typeof setTimeout> | null }>();

  /**
   * The file's thumbnail changed (the editor saved one): a shared file this person can edit sends it to the server, at
   * most once a minute — `thumbnailUrl` in the REST API (§16.7). Snapshots send it too (share, compaction).
   */
  thumbnailSaved(fileKey: FileKey): void {
    const rec = this.state?.links[fileKey];
    if (!rec || rec.role === "viewer" || !this.session || !this.host.thumbnail) return;
    let t = this.thumbs.get(fileKey);
    if (!t) this.thumbs.set(fileKey, (t = { last: 0, timer: null }));
    if (t.timer) return;
    const entry = t;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.last = Date.now();
      void this.uploadThumbnail(fileKey);
    }, Math.max(0, entry.last + THUMBNAIL_EVERY_MS - Date.now()));
  }

  /** @internal `PUT /files/:key/thumbnail` with the store's PNG (editors; ≤ 2 MB). False when there was none or it failed. */
  async uploadThumbnail(fileKey: FileKey): Promise<boolean> {
    const rec = this.state?.links[fileKey];
    if (!rec || rec.role === "viewer" || !this.session || !this.host.thumbnail) return false;
    try {
      const png = await this.host.thumbnail(fileKey);
      if (!png || png.length > 2 * 1024 * 1024) return false;
      await this.raw("PUT", `/files/${rec.key}/thumbnail`, png);
      return true;
    } catch (e) {
      this.host.log("warn", `multiplayer ${fileKey}: the thumbnail wasn't uploaded`, e);
      return false;
    }
  }

  // --- internals, used by links ---

  /** @internal */
  emitState(fileKey: FileKey): void {
    void this.fileState(fileKey).then((s) => {
      for (const l of this.listeners) l(fileKey, s);
    });
  }

  /** @internal */
  record(fileKey: FileKey): LinkRecord | undefined {
    return this.state?.links[fileKey];
  }

  /** @internal Saves one link's record (null: removed), one write at a time. */
  persist(fileKey: FileKey): Promise<void> {
    const rec = this.state?.links[fileKey];
    const copy = rec ? (JSON.parse(JSON.stringify(rec)) as LinkRecord) : null;
    this.saving = this.saving.then(() => this.host.saveLink(fileKey, copy)).catch((e) => this.host.log("error", "multiplayer: saving a link failed", e));
    return this.saving;
  }

  /** @internal The file stopped being shared, or this user lost access: the local copy stays, unlinked. */
  async unlink(fileKey: FileKey): Promise<void> {
    this.live.get(fileKey)?.stop();
    this.live.delete(fileKey);
    if (this.state) delete this.state.links[fileKey];
    await this.persist(fileKey);
    this.emitState(fileKey);
  }

  /** @internal */
  socketUrl(key: string): string | null {
    if (!this.session) return null;
    const u = new URL(`/files/${key}/ws`, this.session.server);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.searchParams.set("token", this.session.token);
    const pass = this.passes.get(key);
    if (pass) u.searchParams.set("pass", pass);
    return u.toString();
  }

  /** @internal */
  get host_(): MultiplayerHost {
    return this.host;
  }

  /** @internal */
  get deps_(): MultiplayerDeps {
    return this.deps;
  }

  /** Links joined for a while outside `only` (`visit`): how many callers hold each, and the timer that ends it */
  private visits = new Map<FileKey, { count: number; link: Link; timer: ReturnType<typeof setTimeout> | null }>();

  /**
   * Joins a shared file's room for a while even when this client joins only some rooms (`only`: a browser tab edits
   * one file) — a branch's merge in a tab that has only the branch open needs main's copy caught up with its room
   * (docs/data.md §15.7). Returns the release; the link stays `lingerMs` after the last release (a merge right after
   * its preview doesn't reconnect), then closes. A no-op for a file whose room this client is in anyway.
   */
  async visit(fileKey: FileKey, lingerMs = 30_000): Promise<() => void> {
    const st = await this.loadState();
    if (!this.session || !st.links[fileKey]) return () => {};
    let v = this.visits.get(fileKey);
    if (!v) {
      if (this.live.has(fileKey)) return () => {};
      const link = new Link(this, fileKey);
      this.live.set(fileKey, link);
      link.start();
      v = { count: 0, link, timer: null };
      this.visits.set(fileKey, v);
    }
    if (v.timer) clearTimeout(v.timer);
    v.timer = null;
    v.count++;
    const visit = v;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--visit.count > 0) return;
      visit.timer = setTimeout(() => {
        if (this.visits.get(fileKey) !== visit || visit.count > 0) return;
        this.visits.delete(fileKey);
        if (this.live.get(fileKey) === visit.link && !this.joins(fileKey)) {
          visit.link.stop();
          this.live.delete(fileKey);
          this.emitState(fileKey);
        }
      }, lingerMs);
    };
  }

  /** The links were all stopped (sign-out, a new session, close): the visits end with them */
  private dropVisits(): void {
    for (const v of this.visits.values()) if (v.timer) clearTimeout(v.timer);
    this.visits.clear();
  }

  /** Whether this client joins `fileKey`'s room (`only`: by its local key or its room's) */
  private joins(fileKey: FileKey): boolean {
    if (!this.only) return true;
    const key = this.record(fileKey)?.key;
    return this.only.has(fileKey) || (key !== undefined && this.only.has(key));
  }

  private startLink(fileKey: FileKey): void {
    if (!this.session || this.live.has(fileKey) || !this.joins(fileKey) || !this.ownLink(fileKey)) return;
    const link = new Link(this, fileKey);
    this.live.set(fileKey, link);
    link.start();
  }

  private needOrdinal(): void {
    if (this.host.deviceOrdinal <= 1) throw new StoreError("offline", tr("Couldn't reach the server. Check your connection and try again."));
  }

  private async keyOf(fileKey: FileKey): Promise<string> {
    const rec = (await this.loadState()).links[fileKey];
    if (!rec) throw new StoreError("invalid", tr("This file isn't shared"));
    return rec.key;
  }

  private async loadState(): Promise<State> {
    if (this.state) return this.state;
    const raw = await this.host.load().catch(() => null);
    const id = typeof raw?.installationId === "string" && raw.installationId.length >= 16 ? raw.installationId : `i_${randomId(this.deps.random, 24)}`;
    const links: Record<FileKey, LinkRecord> = {};
    for (const [k, v] of Object.entries(raw?.links ?? {})) {
      const r = v as Partial<LinkRecord> | null;
      if (!r || typeof r.key !== "string") continue;
      links[k] = { key: r.key, since: Number(r.since) || 0, acked: Number(r.acked) || 0, sessions: Array.isArray(r.sessions) ? r.sessions.filter(Number.isInteger) : [], role: r.role === "owner" || r.role === "viewer" ? r.role : "editor" };
      if (r.pendingUpload === true) links[k].pendingUpload = true;
      if (typeof r.uid === "string" && r.uid) links[k].uid = r.uid;
      const part = r.partial;
      if (part && Number.isInteger(part.batch) && Number.isInteger(part.parts) && Number.isInteger(part.echoed) && part.echoed < part.parts) links[k].partial = { batch: part.batch, parts: part.parts, echoed: part.echoed };
      if (Array.isArray(r.images)) {
        const images = r.images.filter((s): s is string => typeof s === "string" && /^[0-9a-f]{40}$/.test(s));
        if (images.length) links[k].images = images;
      }
      if (typeof r.pass === "string") {
        links[k].pass = r.pass;
        this.passes.set(r.key, r.pass);
      }
    }
    this.state = { installationId: id, links };
    if (id !== raw?.installationId) await this.host.saveInstallationId(id);
    return this.state;
  }

  private async raw(method: string, path: string, body?: unknown, opts?: CallOptions): Promise<Response> {
    const res = await this.request(method, path, body, opts);
    if (res.ok) return res;
    throw await httpError(res);
  }

  /**
   * A call with the session whatever the answer's status (the libraries' analytics queue tells 4xx from 5xx, and
   * payloads answer bytes: src/store/libraries/org.ts); signed out or unreachable → `offline`.
   */
  async request(method: string, path: string, body?: unknown, opts?: CallOptions): Promise<Response> {
    if (!this.session) throw new StoreError("offline", tr("Log in to share files"));
    const session = this.session;
    const init: RequestInit = { method, headers: { authorization: `Bearer ${session.token}` } };
    if (opts?.signal) init.signal = opts.signal;
    const pass = this.passes.get(/^\/files\/([^/?]+)/.exec(path)?.[1] ?? "");
    if (pass) (init.headers as Record<string, string>)["x-file-pass"] = pass;
    if (body instanceof Uint8Array) {
      init.body = body as unknown as RequestInit["body"];
      (init.headers as Record<string, string>)["content-type"] = "application/octet-stream";
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
    // An upload the panel follows: its body read in slices as it goes (streamed, with its length declared so the server
    // streams it on: quota.ts guardedStream), or counted whole once sent
    const counted = opts?.onSent && body instanceof Uint8Array ? body : null;
    const streamed = counted && this.deps.streamUploads;
    if (streamed) (init.headers as Record<string, string>)["content-length"] = String(counted.length);
    let res: Response;
    try {
      // Reads try again when the server is busy or unreachable for a moment (Cloudflare's 1102 pages, 5xx, 429)
      const url = new URL(path, this.session.server).toString();
      res = await fetchWithRetry(method, this.deps.retryDelays ?? READ_RETRY_DELAYS, () =>
        this.deps.fetch(url, streamed ? ({ ...init, body: countingBody(counted, opts!.onSent!), duplex: "half" } as RequestInit) : init),
      );
    } catch {
      if (opts?.signal?.aborted) throw canceledError();
      throw new StoreError("offline", tr("Couldn't reach the server. Check your connection and try again."));
    }
    if (counted && !streamed && res.ok) opts!.onSent!(counted.length);
    if (res.status === 401) await this.sessionRefused(res, session);
    // Governance+'s refusals (403 gates and restrictions, 503 key_unavailable) are said once read (§2.5)
    if ((res.status === 403 || res.status === 503) && this.governanceListeners.size && this.session === session) void this.governanceAnswer(res.clone(), path);
    return res;
  }

  /** A call answering bytes (a room version's snapshot and frames, docs/data.md §15.7.1): the body and its headers */
  async callBytes(method: string, path: string, body?: unknown): Promise<{ bytes: Uint8Array; headers: Headers }> {
    const res = await this.raw(method, path, body);
    return { bytes: new Uint8Array(await res.arrayBuffer()), headers: res.headers };
  }

  /** A call answering text (the Admin's CSV exports) */
  async callText(method: string, path: string, body?: unknown): Promise<string> {
    return (await this.raw(method, path, body)).text();
  }

  // --- for the store's comments (src/store/comments/service.ts, docs/multiplayer.md §10) ---

  /** The room key of a shared file; null when it isn't shared */
  async roomKey(fileKey: FileKey): Promise<string | null> {
    return (await this.loadState()).links[fileKey]?.key ?? null;
  }

  get signedIn(): boolean {
    return this.session !== null;
  }

  /** A JSON call to the server with the session */
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    return this.api<T>(method, path, body);
  }

  private sessionListeners = new Set<(session: MultiplayerSession | null) => void>();
  /** The session changed (the store's notifications follow it: src/store/notifications/service.ts) */
  onSession(listener: (session: MultiplayerSession | null) => void): Unsubscribe {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  /** A WebSocket URL on the server with the session's token (null signed out) */
  wsUrl(path: string): string | null {
    if (!this.session) return null;
    const u = new URL(path, this.session.server);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.searchParams.set("token", this.session.token);
    return u.toString();
  }

  private roomComments = new Set<(fileKey: FileKey) => void>();
  /** A file's room said its comments changed */
  onComments(listener: (fileKey: FileKey) => void): Unsubscribe {
    this.roomComments.add(listener);
    return () => this.roomComments.delete(listener);
  }

  /** @internal */
  commentsChanged(fileKey: FileKey): void {
    for (const l of this.roomComments) l(fileKey);
  }

  private roomDevMode = new Set<(fileKey: FileKey, what: "resources" | "codeConnect") => void>();
  /** A file's room said its dev resources or Code Connect mappings changed (someone's write, docs/editor.md D-1 / D-3) */
  onDevMode(listener: (fileKey: FileKey, what: "resources" | "codeConnect") => void): Unsubscribe {
    this.roomDevMode.add(listener);
    return () => this.roomDevMode.delete(listener);
  }

  /** @internal */
  devModeChanged(fileKey: FileKey, what: "resources" | "codeConnect"): void {
    for (const l of this.roomDevMode) l(fileKey, what);
  }
  private async api<T = unknown>(method: string, path: string, body?: unknown, opts?: CallOptions): Promise<T> {
    const res = await this.raw(method, path, body, opts);
    // 204 (a delete, leaving): nothing to read
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

/**
 * The server said the file doesn't exist for this person: our own JSON 404 `not_found` or 410 `gone` (a room with no
 * snapshot yet, `no_snapshot`, is not gone; Cloudflare's pages and no network are `unavailable` / `offline`).
 */
export function isGone(e: unknown): boolean {
  if (!(e instanceof StoreError) || e.code !== "not-found") return false;
  const code = (e.detail as { code?: unknown } | undefined)?.code;
  return code === "not_found" || code === "gone";
}

/** An upload stopped by the session or the store going away (it goes again with the next start) */
const PAUSED_TEXT = "Upload paused. It will continue when Wecra reconnects.";

/** An org file's place in `register`'s answer (`POST /files` with an org, a folder's `POST …/files`: `{file}`) */
function placeOf(answer: unknown): UploadPlace | null {
  const f = answer && typeof answer === "object" ? (answer as { file?: unknown }).file : null;
  if (!f || typeof f !== "object") return null;
  const { orgId, teamId, projectId } = f as Partial<Record<keyof UploadPlace, unknown>>;
  if (typeof orgId !== "string") return null;
  return { orgId, teamId: typeof teamId === "string" ? teamId : null, projectId: typeof projectId === "string" ? projectId : null };
}

const spacePlace = (space: FileSpace | null | undefined): UploadPlace | null => (space ? { orgId: space.orgId, teamId: space.teamId ?? null, projectId: space.projectId ?? null } : null);

/** `GET /files/:key` of an org file adds where it lives (docs/multiplayer.md §14.12) */
type RemoteWithOrg = SharedFileInfo & { org?: { id: string; teamId: string | null; projectId: string | null } | null };

function spaceOf(key: string, org: RemoteWithOrg["org"]): FileSpace | null {
  return org && typeof org.id === "string" ? { orgId: org.id, key, teamId: org.teamId ?? null, projectId: org.projectId ?? null } : null;
}

/**
 * The server's refusal as a StoreError (docs/multiplayer.md §14.6, §14.12): `{error, code}` bodies; the machine code (and
 * the body's other fields, e.g. `seat`) go in `detail`. 401 → forbidden (log in again), 403 → forbidden, 404 / 410 →
 * not-found, 409 → conflict, 413 → too-large, the rest → invalid.
 */
export async function httpError(res: Response): Promise<StoreError> {
  const text = await res.text().catch(() => "");
  let message = text;
  let detail: Record<string, unknown> | undefined;
  let json = false;
  try {
    const body = JSON.parse(text) as { error?: string; code?: unknown };
    json = !!body && typeof body === "object";
    message = body.error ?? text;
    if (typeof body.code === "string") {
      const { error: _e, ...rest } = body;
      detail = rest;
    }
  } catch {
    // plain text
  }
  // A room's snapshot not uploaded yet (an earlier server said it in plain text): the file isn't gone, it's coming
  if (res.status === 404 && (detail?.code === "no_snapshot" || (!json && text.trim() === "no snapshot yet"))) return new StoreError("unavailable", tr(STILL_UPLOADING_TEXT), { ...(detail ?? {}), code: "no_snapshot" });
  // Cloudflare's pages (1102, 1101, 1015, its 5xx) and any other page: never shown, our words instead (the 2026-10-12 incident)
  if (!json && isErrorPage(res, text)) return busyError(res.status, text, true);
  if (!json) message = message.length > 200 ? "" : message;
  // 401 `idle_timeout` (§15.8): detail.code says it; MultiplayerService has also said `SessionEnded` and dropped the session
  if (res.status === 401 && detail?.code === "idle_timeout") return new StoreError("forbidden", tr("You were logged out because you were inactive."), detail);
  if (res.status === 401) return new StoreError("forbidden", tr("Your session expired. Log in again."), detail);
  // Public sign-up's limits (docs/multiplayer.md §17): `detail` keeps `{code, kind, limit}`; the words are the shared ones
  if (isQuotaRefusal(detail)) return new StoreError(res.status === 413 ? "too-large" : "forbidden", quotaMessage(detail.kind, detail.limit), detail);
  if (detail?.code === "account_suspended") return new StoreError("forbidden", accountSuspendedMessage(), detail);
  // The server's spend guard (§17.1): 503 `capacity_reached`, its message says it ("…Try again on the 1st.")
  if (detail?.code === "capacity_reached") return new StoreError("unavailable", message, detail);
  // Governance+ (docs/governance.md §2.5, §2.10): `detail` keeps `{code, gate}`; the org's encryption key → unavailable
  const gcode = detail?.code;
  if ((res.status === 403 || res.status === 503) && isGovernanceCode(gcode)) {
    return new StoreError(gcode === "key_unavailable" ? "unavailable" : "forbidden", (GOVERNANCE_REFUSAL_TEXT[gcode] ? tr(GOVERNANCE_REFUSAL_TEXT[gcode]) : message || tr("You don't have access")), detail);
  }
  if (res.status === 403) return new StoreError("forbidden", message || tr("You don't have access"), detail);
  if (res.status === 404) return new StoreError("not-found", message || tr("Not found"), detail);
  if (res.status === 410) return new StoreError("not-found", message || tr("This link has expired"), detail ?? { code: "gone" });
  if (res.status === 409) return new StoreError("conflict", message || tr("That changed meanwhile"), detail);
  if (res.status === 413) return new StoreError("too-large", message || tr("That is too large"), detail);
  // The server's own trouble (5xx) or rate limiting: our words, not its internals
  if (res.status >= 500 || res.status === 429) return busyError(res.status, text, false, detail?.code);
  return new StoreError("invalid", message || tr("The server said {status}", { status: res.status }), detail);
}

/** One shared file's socket. */
class Link {
  connection: FileShareState["connection"] = "connecting";
  peers = new Map<number, PeerInfo>();
  private ws: WebSocketLike | null = null;
  private stopped = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private session = 0;
  private ready = false;
  /** Local frames sent and not acknowledged (branching waits for a merge's frame: docs/data.md §15.7) */
  get pendingCount(): number {
    return this.pending.size;
  }
  /** This client's session in the room (0 until welcome) */
  get sessionID(): number {
    return this.ready ? this.session : 0;
  }
  /** Local frames sent and not acknowledged: local seq → the properties they touch */
  private pending = new Map<number, Touched>();
  /** Since when local frames have waited for the room (null: none) and the last acknowledgement: the save status */
  unackedSince: number | null = null;
  lastAckAt = 0;
  /** After `pending` changed: the views hear when frames start or stop waiting (not of every frame) */
  private notePending(): void {
    const waiting = this.pending.size > 0;
    if (waiting === (this.unackedSince !== null)) return;
    if (waiting) this.unackedSince = Date.now();
    else {
      this.shadow.clear();
      this.unackedSince = null;
      this.lastAckAt = Date.now();
    }
    this.svc.emitState(this.fileKey);
  }
  /** Received frames are handled one at a time, in order */
  private chain: Promise<void> = Promise.resolve();
  /** Sent frames go one at a time, in journal order, each after the images it uses are in the room */
  private sending: Promise<void> = Promise.resolve();
  /** The room's latest snapshot seq (welcome), and whether this client is uploading a new one */
  private snapshotSeq = 0;
  private compacting = false;
  /** The quiet compaction's timer, and when this client last uploaded a snapshot (0: not yet) */
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private compactedAt = 0;
  /** welcome made this link a viewer's (it was an editor's): unsent local changes are rolled back at `ready` */
  private demoted = false;
  /** `ready` is sending the backlog: frames journaled meanwhile go with it, in order (never ahead of older ones) */
  private flushing = false;
  /** Local frames sent on this socket (the backlog's flush sends each once) */
  private sentHere = new Set<number>();
  /** Was this link live before (the first connection's waiting changes were made before this start), and since when
   *  it has been offline — the Offline sync savepoint */
  private wasLive = false;
  private offlineSince: number | null = null;
  /** The room's places of nodes this copy is moving, from frames whose move lost to ours meanwhile (§18.12: the journal
   *  doesn't hold them, the room's tree does); emptied when nothing waits */
  private shadow = new Map<string, ParentIndex>();
  /** When another person's change to the tree was last journaled (STRUCTURE_RECENT_MS) */
  private remoteStructureAt = 0;
  /** Joined past the room's editors' limit (§18.13): a viewer for this socket, its changes wait (unsaved) */
  limited = false;
  /** Sent frames waiting for their echo: local seq → when the link gives up on this socket (ACK_TIMEOUT_MS) */
  private deadlines = new Map<number, number>();
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  /** The heartbeat (docs/multiplayer.md §4.1): sent every HEARTBEAT_MS once ready; the socket is given up when nothing
   *  came for DEAD_AFTER_MS — only after the room answered one (an older room ignores it and never answers) */
  private beat: ReturnType<typeof setInterval> | null = null;
  private heardAt = 0;
  private answered = false;

  private startBeat(ws: WebSocketLike): void {
    this.stopBeat();
    const every = this.svc.deps_.heartbeatMs ?? HEARTBEAT_MS;
    if (every <= 0) return;
    const dead = this.svc.deps_.deadAfterMs ?? DEAD_AFTER_MS;
    this.beat = setInterval(() => {
      if (this.ws !== ws) return this.stopBeat();
      if (this.answered && Date.now() - this.heardAt > dead) {
        this.svc.host_.log("warn", `multiplayer ${this.fileKey}: the room stopped answering — reconnecting`);
        return this.abandon(ws, "no pong");
      }
      if (ws.readyState === 1) ws.send(HEARTBEAT_TEXT);
    }, every);
  }

  private stopBeat(): void {
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
  }

  /** A dead socket (a half-open connection never delivers its close): closed, and the link goes on as if it had */
  private abandon(ws: WebSocketLike, reason: string): void {
    const onclose = ws.onclose;
    ws.onclose = null;
    ws.onmessage = null;
    try {
      ws.close(4000, reason);
    } catch {
      // already closing
    }
    onclose?.({ code: 4000, reason });
  }

  /** `batch` went out on `ws` (`bytes` of it): its echo is awaited, else the socket closes and the reconnect resends it */
  private awaitAck(ws: WebSocketLike, batch: number, bytes: number): void {
    const ms = (this.svc.deps_.ackTimeoutMs ?? ACK_TIMEOUT_MS) + Math.floor(bytes / 1_000_000) * ACK_PER_MB_MS;
    this.deadlines.set(batch, Date.now() + ms);
    this.arm(ws);
  }

  private arm(ws: WebSocketLike): void {
    if (this.watchdog || !this.deadlines.size) return;
    const next = Math.min(...this.deadlines.values());
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.ws !== ws) return;
      const now = Date.now();
      for (const batch of [...this.deadlines.keys()]) if (!this.pending.has(batch)) this.deadlines.delete(batch);
      if ([...this.deadlines.values()].some((at) => at <= now)) {
        this.svc.host_.log("warn", `multiplayer ${this.fileKey}: no acknowledgement from the room — reconnecting`);
        this.disarm();
        ws.close(4000, "no ack");
        return;
      }
      this.arm(ws);
    }, Math.max(0, next - Date.now()));
  }

  private disarm(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.deadlines.clear();
  }

  constructor(
    private svc: MultiplayerService,
    private fileKey: FileKey,
  ) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    this.disarm();
    this.stopBeat();
    this.ws?.close(1000, "closing");
    this.ws = null;
  }

  /** A frame the store just journaled. */
  local(c: FileChange): void {
    // A move or delete made just after another person's change to the tree: checked against it (§18.12)
    if (c.kind !== "remote" && Date.now() - this.remoteStructureAt < STRUCTURE_RECENT_MS && this.svc.host_.structureAt && this.svc.host_.appendCorrection) {
      if (changesStructure(decodeMessage(c.message))) this.chain = this.chain.then(() => this.repairLocal()).catch((err) => this.svc.host_.log("warn", `multiplayer ${this.fileKey}: the tree wasn't checked`, err));
    }
    // While the backlog goes out (`ready`) a new frame waits its turn: it is sent in journal order with it
    if (c.kind === "remote" || !this.ready || this.flushing || this.pending.has(c.seq)) return;
    const rec = this.svc.record(this.fileKey);
    if (!rec || c.seq <= rec.acked || rec.role === "viewer" || this.limited) return;
    this.send(c);
  }

  presence(data: unknown): void {
    if (this.ready) this.ws?.send(JSON.stringify({ t: "presence", data }));
  }

  signal(to: number, data: unknown): void {
    if (this.ready) this.ws?.send(JSON.stringify({ t: "signal", to, data }));
  }

  /** A control message to the room (a render job's answer) */
  say(msg: ClientControl): void {
    if (this.ready) this.ws?.send(JSON.stringify(msg));
  }

  /** Resolves once the frames queued before now are sent */
  settled(): Promise<void> {
    return this.sending.catch(() => {});
  }

  /** What the hello says changed (this client can render now, or no longer): a new socket says it */
  rehello(): void {
    const ws = this.ws;
    if (this.stopped || !ws) return;
    this.ws = null;
    this.ready = false;
    this.peers.clear();
    this.stopBeat();
    ws.close(1000, "hello again");
    this.connect();
  }

  private send(c: FileChange): void {
    // Too large for one frame: its parts (split.ts); a field too large for any frame can't reach the room at all.
    const parts = splitFrame(c.message);
    if (!parts) {
      this.stopped = true;
      void this.svc.rollBack(this.fileKey, "too-large");
      return;
    }
    this.pending.set(c.seq, touchedBy(decodeMessage(c.message)));
    this.notePending();
    this.sentHere.add(c.seq);
    const ws = this.ws;
    const rec = this.svc.record(this.fileKey);
    const key = rec?.key;
    // Parts the room already took (before a reconnect or a restart) aren't sent again.
    let from = 0;
    if (parts.length > 1 && rec) {
      if (rec.partial?.batch === c.seq && rec.partial.parts === parts.length) from = rec.partial.echoed;
      else {
        rec.partial = { batch: c.seq, parts: parts.length, echoed: 0 };
        void this.svc.persist(this.fileKey);
      }
    }
    const images = imagesOf(c.message);
    this.sending = this.sending
      .then(async () => {
        if (images.length && key) await this.svc.uploadBlobs(key, images);
        let bytes = 0;
        for (const part of parts.slice(from)) {
          if (this.ws !== ws || !ws) return;
          ws.send(encodeChangesUp(c.seq, part));
          bytes += part.length;
        }
        if (this.pending.has(c.seq)) this.awaitAck(ws!, c.seq, bytes);
      })
      .catch((e) => {
        // Not sent: it goes again from the backlog after the next reconnect.
        this.svc.host_.log("warn", `multiplayer ${this.fileKey}: a frame wasn't sent`, e);
        ws?.close(4000, "send failed");
      });
  }

  /** The room holds many frames past its snapshot: one client (the owner, else the present editor with the lowest
   *  session) uploads a new one from its copy, when its copy is exactly the room's state (nothing pending). */
  private maybeCompact(rec: LinkRecord, quiet = false): void {
    if (!quiet) this.armQuietCompact(rec);
    const past = rec.since - this.snapshotSeq;
    const due = quiet ? past > 0 && Date.now() - this.compactedAt >= (this.svc.deps_.quietCompactEveryMs ?? QUIET_COMPACT_EVERY_MS) : past >= (this.svc.deps_.compactEvery ?? COMPACT_EVERY);
    if (this.compacting || rec.role === "viewer" || this.limited || this.pending.size || !due) return;
    const writers = [...this.peers.values()].filter((p) => p.role !== "viewer");
    const ownerHere = writers.some((p) => p.role === "owner");
    if (rec.role !== "owner" && (ownerHere || writers.some((p) => p.sessionID < this.session))) return;
    this.compacting = true;
    const seq = rec.since;
    this.chain = this.chain.then(async () => {
      try {
        const local = await this.svc.host_.backlog(this.fileKey, rec.acked);
        if (local.some((c) => c.kind !== "remote") || rec.since !== seq || this.pending.size) return;
        if (await this.svc.uploadSnapshot(this.fileKey, rec.key, seq)) {
          this.snapshotSeq = seq;
          this.compactedAt = Date.now();
        }
      } finally {
        this.compacting = false;
      }
    });
  }

  /** The quiet compaction (QUIET_COMPACT_MS after the room's last frame), started again by every frame */
  private armQuietCompact(rec: LinkRecord): void {
    const ms = this.svc.deps_.quietCompactMs ?? QUIET_COMPACT_MS;
    if (!ms || rec.role === "viewer") return;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      if (!this.stopped && this.ready) this.maybeCompact(rec, true);
    }, ms);
  }

  /**
   * Another session's frame, as this copy journals it: without what this copy's waiting changes override (Figma's rule,
   * conflict.ts) and, when it meets a move or delete of this copy's still waiting, with the tree repaired (§18.12) — a
   * cycle our later move closes or a layer left without a parent is put right by a change journaled (and sent) before
   * the frame, so neither this copy's engine nor anyone's tree is left broken.
   */
  private async remoteFrame(rec: LinkRecord, incoming: Uint8Array): Promise<Uint8Array | null> {
    const touched = this.pendingTouched();
    const host = this.svc.host_;
    if (!host.structureAt || !host.appendCorrection || rec.role === "viewer" || this.limited) return withoutPending(incoming, touched);
    const decoded = decodeMessage(incoming);
    if (!changesStructure(decoded)) return withoutPending(incoming, touched);
    this.remoteStructureAt = Date.now();
    if (!touched.size) return incoming;
    const shadowBefore = new Map(this.shadow);
    for (const nc of decoded.nodeChanges ?? []) {
      if (!nc.guid || !nc.parentIndex || nc.phase === "REMOVED") continue;
      const mine = touched.get(guidKey(nc.guid));
      if (mine && (mine.has("parentIndex") || mine.has("*"))) this.shadow.set(guidKey(nc.guid), nc.parentIndex);
    }
    if (![...touched.values()].some((f) => f.has("parentIndex") || f.has("*"))) return withoutPending(incoming, touched);
    const fix = await this.structureRepair(rec, shadowBefore, decoded, incoming);
    if (!fix) return withoutPending(incoming, touched);
    if (fix.corrections.length) await this.correct(fix.corrections);
    const kept = withoutPending(incoming, this.pendingTouched());
    if (!fix.reasserts.length) return kept;
    const base: Message = kept ? decodeMessage(kept) : { ...decoded, nodeChanges: [], blobs: [] };
    return encodeMessage({ ...base, nodeChanges: [...(base.nodeChanges ?? []), ...fix.reasserts] });
  }

  /** The repair the tree needs once `frame` (another session's, null: none) lands after this copy's waiting changes */
  private async structureRepair(rec: LinkRecord, shadow: Map<string, ParentIndex>, frame: Message | null, frameBytes: Uint8Array | null) {
    const host = this.svc.host_;
    const mine = (await host.backlog(this.fileKey, rec.acked)).filter((c) => c.kind !== "remote");
    if (!mine.length) return null;
    const before = await host.structureAt!(this.fileKey, mine.map((c) => c.seq));
    if (!before) {
      host.log("info", `multiplayer ${this.fileKey}: the tree can't be checked (this copy's waiting changes are compacted)`);
      return null;
    }
    for (const [k, p] of shadow) if (before.has(k)) before.set(k, p);
    const messages = mine.map((c) => decodeMessage(c.message));
    const room: Structure = frame ? applyStructure(new Map(before), frame) : before;
    const local: Structure = new Map(before);
    for (const m of messages) applyStructure(local, m);
    if (frame && frameBytes) {
      const kept = withoutPending(frameBytes, this.pendingTouched());
      if (kept) applyStructure(local, kept === frameBytes ? frame : decodeMessage(kept));
    }
    const { placed, removed } = structureTouched(messages);
    const fix = repairStructure({ local, room, ancestry: before, placed, removed });
    if (fix.corrections.length) host.log("info", `multiplayer ${this.fileKey}: ${fix.corrections.length} layer(s) put back after a concurrent move or delete`);
    return fix;
  }

  /** A move or delete of this copy's journaled after another session's change to the tree (the editor made it before
   *  that change reached it): repaired if, in the room's order, it breaks the tree (§18.12) */
  private async repairLocal(): Promise<void> {
    const rec = this.svc.record(this.fileKey);
    if (!rec || rec.role === "viewer" || this.limited || this.stopped) return;
    const fix = await this.structureRepair(rec, new Map(this.shadow), null, null);
    if (!fix) return;
    if (fix.corrections.length) await this.correct(fix.corrections);
    if (fix.reasserts.length) await this.svc.host_.appendRemote(this.fileKey, encodeMessage({ type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: fix.reasserts, blobs: [] } as Message));
  }

  /** The repair journaled as a change of this copy's: sent to the room in its turn, waiting like any other */
  private async correct(corrections: Message["nodeChanges"]): Promise<void> {
    const bytes = encodeMessage({ type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: corrections, blobs: [] } as Message);
    const { seq } = await this.svc.host_.appendCorrection!(this.fileKey, bytes);
    // Not sent yet (the catch-up before `ready`): it waits with the backlog, and the room's frames give way to it now
    if (!this.pending.has(seq)) {
      this.pending.set(seq, touchedBy(decodeMessage(bytes)));
      this.notePending();
    }
  }

  private pendingTouched(): Touched {
    const all: Touched = new Map();
    for (const t of this.pending.values()) for (const [k, fields] of t) {
      let set = all.get(k);
      if (!set) all.set(k, (set = new Set()));
      for (const f of fields) set.add(f);
    }
    return all;
  }

  private connect(): void {
    if (this.stopped) return;
    const rec = this.svc.record(this.fileKey);
    const url = rec && this.svc.socketUrl(rec.key);
    if (!rec || !url) return;
    this.connection = "connecting";
    this.ready = false;
    this.svc.emitState(this.fileKey);
    // A share that didn't finish uploading: its images and snapshot first (the room has nothing to send without them)
    if (rec.pendingUpload) {
      void this.svc.finishUpload(this.fileKey).then((done) => {
        if (this.stopped) return;
        if (!done) return this.retry();
        this.connect();
      });
      return;
    }
    const ws = new this.svc.deps_.WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.sentHere = new Set();
    ws.onopen = () => {
      // Unacknowledged local frames (offline edits, or sent before a drop): their properties win over the catch-up.
      this.chain = this.chain.then(async () => {
        const r = this.svc.record(this.fileKey);
        if (!r || this.ws !== ws) return;
        this.pending.clear();
        if (r.role !== "viewer") for (const c of await this.svc.host_.backlog(this.fileKey, r.acked)) if (c.kind !== "remote") this.pending.set(c.seq, touchedBy(decodeMessage(c.message)));
        this.notePending();
        const flags = this.svc.renderFlags(this.fileKey);
        // `client`: a reconnect replaces this app's older socket in the room; `beat`: the heartbeat follows (§4.1)
        const every = this.svc.deps_.heartbeatMs ?? HEARTBEAT_MS;
        const hello: ClientControl = { t: "hello", since: r.since, v: PROTOCOL_VERSION, client: this.svc.clientId, ...(every > 0 ? { beat: every } : {}), ...(flags.render ? { render: true } : {}), ...(flags.helper ? { helper: true } : {}) };
        ws.send(JSON.stringify(hello));
      });
    };
    this.heardAt = Date.now();
    this.answered = false;
    ws.onmessage = (e) => {
      const data = e.data;
      this.heardAt = Date.now();
      if (data === HEARTBEAT_REPLY) {
        this.answered = true;
        return;
      }
      // Figma's signals (§18.13) come right before the room closes the socket (or as a bell): said now, not after it
      if (typeof data === "string" && data.includes('"t":"mp-signal"')) {
        const msg = JSON.parse(data) as Extract<ServerControl, { t: "mp-signal" }>;
        this.svc.host_.log("warn", `multiplayer ${this.fileKey}: ${msg.name}`);
        this.svc.mpSignal(this.fileKey, msg.name, this.pending.size > 0);
        return;
      }
      // The room's refusals come right before it closes the socket: acted on now, before the close can schedule a retry.
      if (typeof data === "string" && data.includes('"t":"error"')) {
        const msg = JSON.parse(data) as Extract<ServerControl, { t: "error" }>;
        this.svc.host_.log("warn", `multiplayer ${this.fileKey}: ${msg.code} — ${msg.message}`);
        // The org's encryption key became unavailable (docs/governance.md §2.10; the room closes with 4003 next): the
        // link waits rather than reconnecting into the room's 503, and the editor is told as for other access errors.
        const code: unknown = msg.code;
        if (isGovernanceCode(code)) {
          this.stopped = true;
          this.svc.block(this.fileKey, { code }, true);
          return;
        }
        if (msg.code === "too-old") {
          // This copy is older than what the room still holds: a fresh copy takes its place.
          this.stopped = true;
          void this.svc.recover(this.fileKey);
        }
        // A frame the room couldn't read (Figma's message-decode-failure): the bell, then the reconnect sends it again
        if (msg.code === "bad-frame") this.svc.mpSignal(this.fileKey, "message-decode-failure", this.pending.size > 0);
        return;
      }
      this.chain = this.chain.then(() => this.receive(ws, data)).catch((err) => this.svc.host_.log("error", `multiplayer ${this.fileKey}: a frame failed`, err));
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.disarm();
      this.stopBeat();
      if (this.ready) this.offlineSince = Date.now();
      this.ws = null;
      this.ready = false;
      this.connection = "offline";
      this.peers.clear();
      this.svc.emitState(this.fileKey);
      if (e.code === CLOSE_UNSHARED) return void this.svc.unlink(this.fileKey);
      // A newer socket of this same app took this one's place in the room (it is only ever an older one, which the check
      // above drops); were it this link's own, it waits long before trying again rather than trading places
      if (e.code === CLOSE_REPLACED) return this.retry(FULL_RETRY_MS);
      // Figma's signals (§18.13): an app too old for the room stops (updating it is the way back); a full file is
      // tried again after a while, its changes kept here meanwhile
      if (e.code === CLOSE_TOO_OLD) {
        this.stopped = true;
        return;
      }
      if (e.code === CLOSE_FULL) return this.retry(FULL_RETRY_MS);
      // The room is moving to another region (§15.10): its copy answers once the Worker flipped the file — like 4003,
      // a reconnect without backoff, after a moment.
      // A move that keeps refusing falls back to the backoff (every loop here is bounded).
      if (e.code === CLOSE_MOVING) return this.retry(this.attempt < 3 ? MOVING_RETRY_MS : undefined);
      // Refused before the socket opened (no welcome) or its access changed: a new link password stops the link until
      // the person enters it (Figma: open sessions re-enter a changed password); a file gone from the server (404 /
      // 410) drops the link. Only the first 4003 reconnects at once: a room that keeps refusing gets the backoff.
      if (e.code === CLOSE_ACCESS || this.attempt >= 1) {
        const now = e.code === CLOSE_ACCESS && this.attempt === 0;
        void this.svc.checkLocked(this.fileKey).then((locked) => !locked && this.retry(now ? 0 : undefined));
        return;
      }
      this.retry();
    };
    ws.onerror = () => {};
  }

  private retry(delay?: number): void {
    if (this.stopped) return;
    this.attempt++;
    const ms = delay ?? this.svc.deps_.backoff?.(this.attempt) ?? Math.min(30_000, 500 * 2 ** Math.min(this.attempt, 6));
    this.timer = setTimeout(() => this.connect(), ms);
  }

  private async receive(ws: WebSocketLike, data: unknown): Promise<void> {
    if (this.ws !== ws) return;
    const rec = this.svc.record(this.fileKey);
    if (!rec) return;
    if (typeof data === "string") {
      const msg = JSON.parse(data) as ServerControl;
      switch (msg.t) {
        case "welcome":
          this.session = msg.sessionID;
          // Lost the right to edit (made a viewer, a merged branch) with changes the room hasn't taken: rolled back at
          // `ready`, once the catch-up has acknowledged whatever of them it had.
          // Past the editors' limit (§18.13) the room says viewer for this session only: the person's role stays, their
          // changes wait (they aren't rolled back), the editor says so
          this.limited = msg.limited === "editors";
          this.demoted = rec.role !== "viewer" && msg.role === "viewer" && !this.limited;
          if (!this.limited) rec.role = msg.role;
          else if (rec.role === "viewer") rec.role = "editor";
          if (this.limited) this.svc.mpSignal(this.fileKey, "converted-to-viewer", this.pending.size > 0);
          if (msg.cursorHidden) this.svc.mpSignal(this.fileKey, "cursor-hidden", false);
          if (!rec.sessions.includes(msg.sessionID)) rec.sessions = [...rec.sessions.slice(-63), msg.sessionID];
          // This app's own older sockets aren't other people (the room replaces them; defensive)
          this.peers = new Map(msg.peers.filter((p) => p.client !== this.svc.clientId).map((p) => [p.sessionID, p]));
          this.snapshotSeq = msg.snapshotSeq ?? 0;
          this.svc.setPolicy(this.fileKey, msg.policy ?? null, false);
          await this.svc.persist(this.fileKey);
          return;
        case "ready": {
          if (rec.role !== "viewer") void this.svc.requests(this.fileKey).catch(() => {});
          this.attempt = 0;
          this.connection = "live";
          const unsent = (await this.svc.host_.backlog(this.fileKey, rec.acked)).some((c) => c.kind !== "remote");
          if (this.ws !== ws) return;
          if (this.demoted && unsent) {
            this.stopped = true;
            ws.close(1000, "rolled back");
            void this.svc.rollBack(this.fileKey, "read-only");
            return;
          }
          this.demoted = false;
          // Changes made away from the room: its state is kept as a version before they land (Figma's Offline sync).
          const away = !this.wasLive || (this.offlineSince !== null && Date.now() - this.offlineSince >= OFFLINE_SYNC_AFTER_MS);
          if (unsent && away && rec.role !== "viewer" && !this.limited) await this.svc.offlineSavepoint(rec.key);
          if (this.ws !== ws) return;
          this.wasLive = true;
          this.offlineSince = null;
          this.ready = true;
          this.startBeat(ws);
          // What the room hasn't acknowledged goes (again) now, in journal order — frames journaled meanwhile with it,
          // never ahead of an older one (a later read finds them; nothing new between the last read and the end).
          if (rec.role !== "viewer" && !this.limited) {
            this.flushing = true;
            try {
              for (;;) {
                const todo = (await this.svc.host_.backlog(this.fileKey, rec.acked)).filter((c) => c.kind !== "remote" && !this.sentHere.has(c.seq));
                if (!todo.length || this.ws !== ws) break;
                for (const c of todo) this.send(c);
              }
            } finally {
              this.flushing = false;
            }
          }
          this.svc.emitState(this.fileKey);
          return;
        }
        case "peer-joined":
          if (msg.peer.client === this.svc.clientId) return;
          this.peers.set(msg.peer.sessionID, msg.peer);
          return this.svc.emitState(this.fileKey);
        case "peer-left":
          this.peers.delete(msg.sessionID);
          return this.svc.emitState(this.fileKey);
        case "notice":
          await this.svc.notice(this.fileKey, { kind: msg.kind, name: msg.name });
          return;
        case "comments":
          return this.svc.commentsChanged(this.fileKey);
        case "dev-resources":
          return this.svc.devModeChanged(this.fileKey, "resources");
        case "code-connect":
          return this.svc.devModeChanged(this.fileKey, "codeConnect");
        case "presence": {
          const p = this.peers.get(msg.sessionID);
          if (p) p.presence = msg.data;
          return this.svc.emitState(this.fileKey);
        }
        case "signal":
          return this.svc.signalled(this.fileKey, msg.from, msg.data);
        case "policy":
          return this.svc.setPolicy(this.fileKey, msg.policy ?? null, true);
        case "rest-job":
          return this.svc.restJob(this.fileKey, msg.id, msg.job);
        case "cursor":
          return this.svc.mpSignal(this.fileKey, msg.why === "observed" ? "cursor-visible-observed" : "cursor-visible-left", false);
      }
      return;
    }
    const frame = decodeChangesDown(new Uint8Array(data as ArrayBuffer));
    if (!frame || frame.seq <= rec.since) return;
    if (rec.sessions.includes(frame.sessionID)) {
      // Our own frame, as the room ordered it: acknowledged — a frame sent in parts once the room took its last.
      const part = rec.partial?.batch === frame.batch ? rec.partial : null;
      if (part && ++part.echoed < part.parts) {
        // more parts of it to come
      } else {
        if (part) delete rec.partial;
        this.deadlines.delete(frame.batch);
        this.pending.delete(frame.batch);
        this.notePending();
        rec.acked = Math.max(rec.acked, frame.batch);
      }
    } else {
      const message = await this.remoteFrame(rec, frame.message);
      if (message) {
        await this.svc.downloadBlobs(rec.key, imagesOf(message), this.fileKey);
        await this.svc.host_.appendRemote(this.fileKey, message);
      }
    }
    rec.since = frame.seq;
    await this.svc.persist(this.fileKey);
    if (this.ready) this.maybeCompact(rec);
  }
}

/** An answer's body read as it comes, `onReceived` told the bytes so far; a connection lost part-way is `offline` (the
 *  download tries again) */
async function readCounting(res: Response, onReceived: (n: number) => void): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  try {
    if (!reader) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      onReceived(bytes.length);
      return bytes;
    }
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      n += value.length;
      onReceived(n);
    }
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(n);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  } catch (e) {
    if (e instanceof StoreError) throw e;
    throw new StoreError("offline", tr("Couldn't reach the server. Check your connection and try again."));
  }
}

/** A room key for a local file: its own key when that fits the server's pattern, plus randomness (keys are global). */
function roomKeyFor(fileKey: FileKey, random: () => number): string {
  const base = fileKey.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  return `${base || "file"}_${randomId(random, 12)}`;
}

function randomId(random: () => number, n: number): string {
  const abc = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < n; i++) s += abc[Math.floor(random() * abc.length)];
  return s;
}
