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
import { CLOSE_MOVING, encodeChangesUp, decodeChangesDown, type ClientControl, type PeerInfo, type Role, type ServerControl } from "../../shared/multiplayer/protocol";
import type { AccessRequest, FileMember, FileShareState, LinkAccess, LinkSettingsPatch, MultiplayerNotice, MultiplayerSession, MultiplayerStatus, OpenIntent, RemoteFile, RestJobAnswer, RestJobRequest, SessionEnded, SharedFileInfo } from "../../shared/multiplayer/types";
import type { RestJob, RestJobPart } from "../../shared/rest/types";
import { decodeMessage } from "../../shared/schema/codec";
import { messageImageHashes } from "../../shared/schema/patch";
import { StoreError } from "../../shared/store/protocol";
import { ACCOUNT_SUSPENDED_TEXT, isQuotaRefusal, quotaText } from "../../shared/quota";
import type { FileChange, Unsubscribe } from "../../shared/store/repositories";
import type { FileKey, FileMeta, FileSpace } from "../../shared/store/types";
import { touchedBy, withoutPending, type Touched } from "./conflict";
import { busyError, fetchWithRetry, isErrorPage, READ_RETRY_DELAYS, STILL_UPLOADING_TEXT, UPLOAD_RETRY_DELAYS, withRetry } from "./http";
import { countingBody, pool, sendBlobs, UploadTracker, BLOB_CONCURRENCY, type BlobSender, type MultipartStart, type UploadClock } from "./uploads";
import { BlobDownloads, DOWNLOAD_CONCURRENCY, imageDownloadOrder, type BlobSource } from "./downloads";
import { UPLOAD_CANCELED, UPLOAD_CANCELED_TEXT, type UploadEvent } from "../../shared/multiplayer/uploads";

/** What the store gives the service. */
export interface MultiplayerHost {
  readonly fileChanges: { on(listener: (c: FileChange) => void): Unsubscribe };
  backlog(fileKey: FileKey, fromSeq: number): Promise<FileChange[]>;
  appendRemote(fileKey: FileKey, message: Uint8Array): Promise<{ seq: number }>;
  /** A new local file holding this snapshot as it is (no GUID remapping: the room's nodes keep their ids); `space`: the
   *  org file it copies (docs/multiplayer.md §14.6), so it never lists among local Drafts */
  createSharedFile(input: { name: string; snapshot: Uint8Array; space?: FileSpace | null }): Promise<FileMeta>;
  /** A record listed from the server with no document here (docs/cloud.md §2) gets the room's snapshot as it is */
  fillFile?(fileKey: FileKey, snapshot: Uint8Array): Promise<void>;
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

const canceledError = () => new StoreError("invalid", UPLOAD_CANCELED_TEXT, { code: UPLOAD_CANCELED });
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
}

interface State {
  installationId: string;
  links: Record<FileKey, LinkRecord>;
}

export interface SessionOptions {
  /** Only these files' rooms are joined (a browser tab joins only the file it edits; Home tabs none). Default: all. */
  only?: FileKey[];
}

const CLOSE_UNSHARED = 4001;
const CLOSE_ACCESS = 4003;
/** After a 4012 (the room is moving to another region, docs/multiplayer.md §15.9) the link reconnects after this long */
export const MOVING_RETRY_MS = 2000;
/** A client uploads a new snapshot when the room holds this many frames past the last one (the room keeps a tail) */
export const COMPACT_EVERY = 1000;
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
  private only: Set<FileKey> | null = null;
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

  constructor(
    private host: MultiplayerHost,
    private deps: MultiplayerDeps,
  ) {
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
      role: rec?.role ?? null,
      connection: link?.connection ?? "offline",
      peers: link ? [...link.peers.values()] : [],
      requests: this.requestCounts.get(fileKey) ?? 0,
      me: link?.sessionID || null,
      locked: this.locked.has(fileKey),
      policy: this.policies.get(fileKey) ?? null,
      blocked: this.blocked.get(fileKey) ?? null,
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
    if (st.links[fileKey]) throw new StoreError("invalid", "This file is shared already");
    const meta = this.host.getMeta(fileKey);
    if (!meta) throw new StoreError("not-found", "No such file");
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
      const err = e instanceof StoreError ? e : new StoreError("offline", "Couldn't reach the server. Check your connection and try again.");
      this.uploads.failed(id, err.message);
      // The link keeps trying in the background (with its backoff), as it would after a restart
      this.startLink(fileKey);
      throw new StoreError(err.code, `“${meta.name}” didn't finish uploading. It will try again the next time it's opened.`, { code: "upload_incomplete", pendingUpload: true, fileKey, key: room, cause: err.message });
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
   * person publishes again.
   */
  async uploadParts(fileKey: FileKey, parts: { path: string; bytes: Uint8Array }[]): Promise<void> {
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
    try {
      await pool(parts, BLOB_CONCURRENCY, async (p, i) => {
        await withRetry(
          delays,
          () => {
            if (ac.signal.aborted) throw canceledError();
            going.set(i, 0);
            return this.raw("PUT", p.path, p.bytes, {
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
      else this.uploads.failed(id, e instanceof StoreError ? e.message : "Couldn't reach the server. Check your connection and try again.");
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
      if (!alive()) throw new StoreError("offline", PAUSED_TEXT);
      return run();
    };
    // Bytes of the requests landed; one going again falls back to it
    let landed = 0;
    let total = snapshot.length;
    const onRetry = up && ((attempt: number) => this.uploads.retrying(up.id, attempt, landed));
    const sha1s = imagesOf(snapshot);
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
    await withRetry(delays, step(() => this.api("PUT", `/files/${room}/snapshot?seq=0`, snapshot, call)), onRetry);
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
      if (!alive()) throw new StoreError("offline", PAUSED_TEXT);
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
        this.uploads.failed(id, e instanceof StoreError ? e.message : "Couldn't reach the server. Check your connection and try again.");
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
  async openShared(key: string, password?: string, intent?: OpenIntent): Promise<{ fileKey: FileKey }> {
    const { fileKey } = await this.openSharedCopy(key, password);
    if (intent && (intent.nodeId || intent.mode)) this.intents.set(fileKey, intent);
    return { fileKey };
  }

  private intents = new Map<FileKey, OpenIntent>();
  async takeOpenIntent(fileKey: FileKey): Promise<OpenIntent | null> {
    const i = this.intents.get(fileKey) ?? null;
    this.intents.delete(fileKey);
    return i;
  }

  private async openSharedCopy(key: string, password?: string): Promise<{ fileKey: FileKey }> {
    const st = await this.loadState();
    const had = Object.entries(st.links).find(([, l]) => l.key === key);
    if (had && this.host.getMeta(had[0])) return { fileKey: had[0] };
    this.needOrdinal();
    // By invite or by the link: the server answers with the caller's role (404 when neither).
    const remote = await this.api<SharedFileInfo>("GET", `/files/${key}`).catch((e: unknown) => {
      throw e instanceof StoreError && e.code === "not-found" ? new StoreError("not-found", "This file isn't shared with you, or the link is off") : e;
    });
    if (remote.needsPassword) await this.unlock(key, password);
    const fileKey = await this.copyFromRoom(key, remote.name, remote.role, spaceOf(key, (remote as RemoteWithOrg).org));
    return { fileKey };
  }

  /** The pass for a link password, kept for this room key (and with the file's link record once there is one). */
  private async unlock(key: string, password: string | undefined): Promise<void> {
    if (!password) throw new StoreError("forbidden", "This file is password protected", { passwordRequired: true });
    const { pass } = await this.api<{ pass: string | null }>("POST", `/files/${key}/unlock`, { password }).catch((e: unknown) => {
      throw e instanceof StoreError && e.code === "forbidden" ? new StoreError("forbidden", "Incorrect password", { passwordRequired: true, wrong: true }) : e;
    });
    if (pass) this.passes.set(key, pass);
    else this.passes.delete(key);
  }

  /** An open shared file whose link password changed: the new password, then the link carries on. */
  async unlockFile(fileKey: FileKey, password: string): Promise<FileShareState> {
    const rec = (await this.loadState()).links[fileKey];
    if (!rec) throw new StoreError("invalid", "This file isn't shared");
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
  private async copyFromRoom(key: string, name: string, role: Role, space: FileSpace | null = null): Promise<FileKey> {
    const st = await this.loadState();
    const res = await this.raw("GET", `/files/${key}/snapshot`);
    const seq = Number(res.headers.get("x-seq") ?? "0");
    const snapshot = new Uint8Array(await res.arrayBuffer());
    // Opened as soon as the document is here; its images come down after (docs/cloud.md §4.1)
    const meta = await this.host.createSharedFile({ name, snapshot, ...(space ? { space } : {}) });
    const head = Math.max(0, ...(await this.host.backlog(meta.fileKey, 0)).map((c) => c.seq));
    st.links[meta.fileKey] = { key, since: seq, acked: head, sessions: [], role, ...this.uidField(), ...(this.passes.has(key) ? { pass: this.passes.get(key) } : {}) };
    await this.persist(meta.fileKey);
    this.startLink(meta.fileKey);
    await this.queueImages(meta.fileKey, key, name, snapshot);
    return meta.fileKey;
  }

  /**
   * A copy's images not in the store, queued to come down in the background (the page it opens on first) and kept
   * with its link for the next start. Never fails the open: a queue that can't start is said in the log.
   */
  private async queueImages(fileKey: FileKey, key: string, name: string, snapshot: Uint8Array): Promise<void> {
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
      const res = await this.raw("GET", `/files/${key}/snapshot`);
      seq = Number(res.headers.get("x-seq") ?? "0");
      snapshot = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (!(e instanceof StoreError && (e.detail as { code?: unknown } | undefined)?.code === "no_snapshot")) throw e;
      snapshot = this.host.newDocument();
      pendingUpload = true;
    }
    // Opened as soon as the document is here; its images come down after (docs/cloud.md §4.1)
    await this.host.fillFile(fileKey, snapshot);
    const head = Math.max(0, ...(await this.host.backlog(fileKey, 0)).map((c) => c.seq));
    st.links[fileKey] = { key, since: seq, acked: head, sessions: [], role, ...this.uidField(), ...(pendingUpload ? { pendingUpload: true as const } : {}) };
    await this.persist(fileKey);
    this.startLink(fileKey);
    if (!pendingUpload) await this.queueImages(fileKey, key, this.host.getMeta(fileKey)?.name ?? "Untitled", snapshot);
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
  async recover(fileKey: FileKey): Promise<void> {
    const rec = this.state?.links[fileKey];
    if (!rec) return;
    const name = this.host.getMeta(fileKey)?.name ?? "Untitled";
    const space = this.host.getMeta(fileKey)?.space ?? null;
    this.live.get(fileKey)?.stop();
    this.live.delete(fileKey);
    delete this.state!.links[fileKey];
    await this.persist(fileKey);
    try {
      const fresh = await this.copyFromRoom(rec.key, name, rec.role, space);
      for (const l of this.replaced) l(fileKey, fresh);
    } catch (e) {
      this.host.log("error", `multiplayer: couldn't get a fresh copy of ${name}`, e);
    }
    this.emitState(fileKey);
  }

  private replaced = new Set<(from: FileKey, to: FileKey) => void>();
  /** A linked copy was replaced by a fresh one (recover) */
  onReplaced(listener: (from: FileKey, to: FileKey) => void): Unsubscribe {
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
   * is moved to the front and waited for rather than fetched twice.
   */
  async downloadBlobs(key: string, sha1s: string[]): Promise<void> {
    if (!sha1s.length) return;
    const have = await this.host.hasBlobs(sha1s);
    const missing = sha1s.filter((_, i) => !have[i]);
    await pool(missing, this.deps.downloadConcurrency ?? DOWNLOAD_CONCURRENCY, async (sha1) => {
      try {
        const queued = this.downloads.want(sha1);
        if (queued && (await queued)) return;
        const res = await this.raw("GET", `/files/${key}/blobs/${sha1}`);
        await this.host.putBlob(new Uint8Array(await res.arrayBuffer()));
      } catch (e) {
        // An image the uploader never had: the layer shows its placeholder, as with a missing image anywhere.
        this.host.log("warn", `multiplayer: image ${sha1} isn't in the room`, e);
      }
    });
  }

  /** @internal The room's history compacted at `seq` from this copy's head. */
  async uploadSnapshot(fileKey: FileKey, key: string, seq: number): Promise<boolean> {
    const snapshot = await this.host.headSnapshot(fileKey);
    try {
      await this.api("PUT", `/files/${key}/snapshot?seq=${seq}`, snapshot);
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
    if (!rec || !link) throw new StoreError("invalid", "This file isn't shared");
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
        if (this.live.get(fileKey) === visit.link && this.only && !this.only.has(fileKey)) {
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

  private startLink(fileKey: FileKey): void {
    if (!this.session || this.live.has(fileKey) || (this.only && !this.only.has(fileKey)) || !this.ownLink(fileKey)) return;
    const link = new Link(this, fileKey);
    this.live.set(fileKey, link);
    link.start();
  }

  private needOrdinal(): void {
    if (this.host.deviceOrdinal <= 1) throw new StoreError("offline", "Couldn't reach the server. Check your connection and try again.");
  }

  private async keyOf(fileKey: FileKey): Promise<string> {
    const rec = (await this.loadState()).links[fileKey];
    if (!rec) throw new StoreError("invalid", "This file isn't shared");
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
    if (!this.session) throw new StoreError("offline", "Log in to share files");
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
      throw new StoreError("offline", "Couldn't reach the server. Check your connection and try again.");
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
  if (res.status === 404 && (detail?.code === "no_snapshot" || (!json && text.trim() === "no snapshot yet"))) return new StoreError("unavailable", STILL_UPLOADING_TEXT, { ...(detail ?? {}), code: "no_snapshot" });
  // Cloudflare's pages (1102, 1101, 1015, its 5xx) and any other page: never shown, our words instead (the 2026-10-12 incident)
  if (!json && isErrorPage(res, text)) return busyError(res.status, text, true);
  if (!json) message = message.length > 200 ? "" : message;
  // 401 `idle_timeout` (§15.8): detail.code says it; MultiplayerService has also said `SessionEnded` and dropped the session
  if (res.status === 401 && detail?.code === "idle_timeout") return new StoreError("forbidden", "You were logged out because you were inactive.", detail);
  if (res.status === 401) return new StoreError("forbidden", "Your session expired. Log in again.", detail);
  // Public sign-up's limits (docs/multiplayer.md §17): `detail` keeps `{code, kind, limit}`; the words are the shared ones
  if (isQuotaRefusal(detail)) return new StoreError(res.status === 413 ? "too-large" : "forbidden", quotaText(detail.kind, detail.limit), detail);
  if (detail?.code === "account_suspended") return new StoreError("forbidden", ACCOUNT_SUSPENDED_TEXT, detail);
  // The server's spend guard (§17.1): 503 `capacity_reached`, its message says it ("…Try again on the 1st.")
  if (detail?.code === "capacity_reached") return new StoreError("unavailable", message, detail);
  // Governance+ (docs/governance.md §2.5, §2.10): `detail` keeps `{code, gate}`; the org's encryption key → unavailable
  const gcode = detail?.code;
  if ((res.status === 403 || res.status === 503) && isGovernanceCode(gcode)) {
    return new StoreError(gcode === "key_unavailable" ? "unavailable" : "forbidden", GOVERNANCE_REFUSAL_TEXT[gcode] ?? (message || "You don't have access"), detail);
  }
  if (res.status === 403) return new StoreError("forbidden", message || "You don't have access", detail);
  if (res.status === 404) return new StoreError("not-found", message || "Not found", detail);
  if (res.status === 410) return new StoreError("not-found", message || "This link has expired", detail ?? { code: "gone" });
  if (res.status === 409) return new StoreError("conflict", message || "That changed meanwhile", detail);
  if (res.status === 413) return new StoreError("too-large", message || "That is too large", detail);
  // The server's own trouble (5xx) or rate limiting: our words, not its internals
  if (res.status >= 500 || res.status === 429) return busyError(res.status, text, false, detail?.code);
  return new StoreError("invalid", message || `The server said ${res.status}`, detail);
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
  /** Received frames are handled one at a time, in order */
  private chain: Promise<void> = Promise.resolve();
  /** Sent frames go one at a time, in journal order, each after the images it uses are in the room */
  private sending: Promise<void> = Promise.resolve();
  /** The room's latest snapshot seq (welcome), and whether this client is uploading a new one */
  private snapshotSeq = 0;
  private compacting = false;

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
    this.ws?.close(1000, "closing");
    this.ws = null;
  }

  /** A frame the store just journaled. */
  local(c: FileChange): void {
    if (c.kind === "remote" || !this.ready || this.pending.has(c.seq)) return;
    const rec = this.svc.record(this.fileKey);
    if (!rec || c.seq <= rec.acked || rec.role === "viewer") return;
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
    ws.close(1000, "hello again");
    this.connect();
  }

  private send(c: FileChange): void {
    this.pending.set(c.seq, touchedBy(decodeMessage(c.message)));
    const ws = this.ws;
    const key = this.svc.record(this.fileKey)?.key;
    const images = imagesOf(c.message);
    this.sending = this.sending
      .then(async () => {
        if (images.length && key) await this.svc.uploadBlobs(key, images);
        if (this.ws === ws) ws?.send(encodeChangesUp(c.seq, c.message));
      })
      .catch((e) => {
        // Not sent: it goes again from the backlog after the next reconnect.
        this.svc.host_.log("warn", `multiplayer ${this.fileKey}: a frame wasn't sent`, e);
        ws?.close(4000, "send failed");
      });
  }

  /** The room holds many frames past its snapshot: one client (the owner, else the present editor with the lowest
   *  session) uploads a new one from its copy, when its copy is exactly the room's state (nothing pending). */
  private maybeCompact(rec: LinkRecord): void {
    if (this.compacting || rec.role === "viewer" || this.pending.size || rec.since - this.snapshotSeq < (this.svc.deps_.compactEvery ?? COMPACT_EVERY)) return;
    const writers = [...this.peers.values()].filter((p) => p.role !== "viewer");
    const ownerHere = writers.some((p) => p.role === "owner");
    if (rec.role !== "owner" && (ownerHere || writers.some((p) => p.sessionID < this.session))) return;
    this.compacting = true;
    const seq = rec.since;
    this.chain = this.chain.then(async () => {
      try {
        const local = await this.svc.host_.backlog(this.fileKey, rec.acked);
        if (local.some((c) => c.kind !== "remote") || rec.since !== seq || this.pending.size) return;
        if (await this.svc.uploadSnapshot(this.fileKey, rec.key, seq)) this.snapshotSeq = seq;
      } finally {
        this.compacting = false;
      }
    });
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
    ws.onopen = () => {
      // Unacknowledged local frames (offline edits, or sent before a drop): their properties win over the catch-up.
      this.chain = this.chain.then(async () => {
        const r = this.svc.record(this.fileKey);
        if (!r || this.ws !== ws) return;
        this.pending.clear();
        if (r.role !== "viewer") for (const c of await this.svc.host_.backlog(this.fileKey, r.acked)) if (c.kind !== "remote") this.pending.set(c.seq, touchedBy(decodeMessage(c.message)));
        const flags = this.svc.renderFlags(this.fileKey);
        const hello: ClientControl = { t: "hello", since: r.since, ...(flags.render ? { render: true } : {}), ...(flags.helper ? { helper: true } : {}) };
        ws.send(JSON.stringify(hello));
      });
    };
    ws.onmessage = (e) => {
      const data = e.data;
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
        return;
      }
      this.chain = this.chain.then(() => this.receive(ws, data)).catch((err) => this.svc.host_.log("error", `multiplayer ${this.fileKey}: a frame failed`, err));
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      this.connection = "offline";
      this.peers.clear();
      this.svc.emitState(this.fileKey);
      if (e.code === CLOSE_UNSHARED) return void this.svc.unlink(this.fileKey);
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
          rec.role = msg.role;
          if (!rec.sessions.includes(msg.sessionID)) rec.sessions = [...rec.sessions.slice(-63), msg.sessionID];
          this.peers = new Map(msg.peers.map((p) => [p.sessionID, p]));
          this.snapshotSeq = msg.snapshotSeq ?? 0;
          this.svc.setPolicy(this.fileKey, msg.policy ?? null, false);
          await this.svc.persist(this.fileKey);
          return;
        case "ready": {
          this.ready = true;
          if (rec.role !== "viewer") void this.svc.requests(this.fileKey).catch(() => {});
          this.attempt = 0;
          this.connection = "live";
          // What the room hasn't acknowledged goes (again) now, in journal order.
          if (rec.role !== "viewer") for (const c of await this.svc.host_.backlog(this.fileKey, rec.acked)) if (c.kind !== "remote") this.send(c);
          this.svc.emitState(this.fileKey);
          return;
        }
        case "peer-joined":
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
      }
      return;
    }
    const frame = decodeChangesDown(new Uint8Array(data as ArrayBuffer));
    if (!frame || frame.seq <= rec.since) return;
    if (rec.sessions.includes(frame.sessionID)) {
      // Our own frame, as the room ordered it: acknowledged.
      this.pending.delete(frame.batch);
      rec.acked = Math.max(rec.acked, frame.batch);
    } else {
      const message = withoutPending(frame.message, this.pendingTouched());
      if (message) {
        await this.svc.downloadBlobs(rec.key, imagesOf(message));
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
    throw new StoreError("offline", "Couldn't reach the server. Check your connection and try again.");
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
