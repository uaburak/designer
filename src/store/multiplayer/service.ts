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
import { encodeChangesUp, decodeChangesDown, type PeerInfo, type Role, type ServerControl } from "../../shared/multiplayer/protocol";
import type { AccessRequest, FileMember, FileShareState, LinkAccess, MultiplayerNotice, MultiplayerSession, MultiplayerStatus, OpenIntent, RemoteFile, SharedFileInfo } from "../../shared/multiplayer/types";
import { decodeMessage } from "../../shared/schema/codec";
import { messageImageHashes } from "../../shared/schema/patch";
import { StoreError } from "../../shared/store/protocol";
import type { FileChange, Unsubscribe } from "../../shared/store/repositories";
import type { FileKey, FileMeta } from "../../shared/store/types";
import { touchedBy, withoutPending, type Touched } from "./conflict";

/** What the store gives the service. */
export interface MultiplayerHost {
  readonly fileChanges: { on(listener: (c: FileChange) => void): Unsubscribe };
  backlog(fileKey: FileKey, fromSeq: number): Promise<FileChange[]>;
  appendRemote(fileKey: FileKey, message: Uint8Array): Promise<{ seq: number }>;
  /** A new local file holding this snapshot as it is (no GUID remapping: the room's nodes keep their ids) */
  createSharedFile(input: { name: string; snapshot: Uint8Array }): Promise<FileMeta>;
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
}

interface LinkRecord {
  key: string;
  since: number;
  acked: number;
  sessions: number[];
  role: Role;
  /** The pass for a file's link password, when this user is in by the link alone and the file has one */
  pass?: string;
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
/** A client uploads a new snapshot when the room holds this many frames past the last one (the room keeps a tail) */
export const COMPACT_EVERY = 1000;

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

  constructor(
    private host: MultiplayerHost,
    private deps: MultiplayerDeps,
  ) {
    this.off = host.fileChanges.on((c) => this.live.get(c.fileKey)?.local(c));
  }

  /** Main (desktop) or the page (browser) hands the session over; null signs out (links stay, sockets close). */
  async setSession(session: MultiplayerSession | null, opts: SessionOptions = {}): Promise<MultiplayerStatus> {
    const only = opts.only ? new Set(opts.only) : null;
    const sameOnly = (only === null) === (this.only === null) && (!only || (only.size === this.only!.size && [...only].every((k) => this.only!.has(k))));
    const same = session && this.session && session.server === this.session.server && session.token === this.session.token && sameOnly;
    if (same) return this.status();
    for (const l of this.live.values()) l.stop();
    this.live.clear();
    this.session = session;
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
    };
  }

  /** Share › Invite on a file not shared yet: registers it on the server with the editor's snapshot of it at `headSeq`. */
  async share(fileKey: FileKey, input: { snapshot: Uint8Array; headSeq: number }): Promise<FileShareState> {
    const st = await this.loadState();
    if (st.links[fileKey]) return this.fileState(fileKey);
    const meta = this.host.getMeta(fileKey);
    if (!meta) throw new StoreError("not-found", "No such file");
    this.needOrdinal();
    const key = roomKeyFor(fileKey, this.deps.random);
    await this.api("POST", "/files", { key, name: meta.name });
    await this.uploadBlobs(key, imagesOf(input.snapshot));
    await this.api("PUT", `/files/${key}/snapshot?seq=0`, input.snapshot);
    st.links[fileKey] = { key, since: 0, acked: input.headSeq, sessions: [], role: "owner" };
    await this.persist(fileKey);
    this.startLink(fileKey);
    return this.fileState(fileKey);
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
    const fileKey = await this.copyFromRoom(key, remote.name, remote.role);
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
    } catch {
      return false;
    }
  }

  private passes = new Map<string, string>();
  private locked = new Set<FileKey>();

  /** A local copy made from the room's snapshot (and its images), linked at the snapshot's seq. */
  private async copyFromRoom(key: string, name: string, role: Role): Promise<FileKey> {
    const st = await this.loadState();
    const res = await this.raw("GET", `/files/${key}/snapshot`);
    const seq = Number(res.headers.get("x-seq") ?? "0");
    const snapshot = new Uint8Array(await res.arrayBuffer());
    await this.downloadBlobs(key, imagesOf(snapshot));
    const meta = await this.host.createSharedFile({ name, snapshot });
    const head = Math.max(0, ...(await this.host.backlog(meta.fileKey, 0)).map((c) => c.seq));
    st.links[meta.fileKey] = { key, since: seq, acked: head, sessions: [], role, ...(this.passes.has(key) ? { pass: this.passes.get(key) } : {}) };
    await this.persist(meta.fileKey);
    this.startLink(meta.fileKey);
    return meta.fileKey;
  }

  /** @internal This copy fell behind what the room still holds (away too long): a fresh copy replaces it as the
   *  linked one; the old copy stays, unlinked, so nothing in it is lost. */
  async recover(fileKey: FileKey): Promise<void> {
    const rec = this.state?.links[fileKey];
    if (!rec) return;
    const name = this.host.getMeta(fileKey)?.name ?? "Untitled";
    this.live.get(fileKey)?.stop();
    this.live.delete(fileKey);
    delete this.state!.links[fileKey];
    await this.persist(fileKey);
    try {
      const fresh = await this.copyFromRoom(rec.key, name, rec.role);
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

  /** @internal Images the room doesn't have yet, uploaded from the store (those the store has). */
  async uploadBlobs(key: string, sha1s: string[]): Promise<void> {
    if (!sha1s.length) return;
    const { missing } = await this.api<{ missing: string[] }>("POST", `/files/${key}/blobs/missing`, { sha1s });
    if (!missing.length) return;
    const have = await this.host.hasBlobs(missing);
    for (let i = 0; i < missing.length; i++) if (have[i]) await this.raw("PUT", `/files/${key}/blobs/${missing[i]}`, await this.host.getBlob(missing[i]));
  }

  /** @internal Images the store doesn't have yet, downloaded from the room before the frame that uses them lands. */
  async downloadBlobs(key: string, sha1s: string[]): Promise<void> {
    if (!sha1s.length) return;
    const have = await this.host.hasBlobs(sha1s);
    for (let i = 0; i < sha1s.length; i++) {
      if (have[i]) continue;
      try {
        const res = await this.raw("GET", `/files/${key}/blobs/${sha1s[i]}`);
        await this.host.putBlob(new Uint8Array(await res.arrayBuffer()));
      } catch (e) {
        // An image the uploader never had: the layer shows its placeholder, as with a missing image anywhere.
        this.host.log("warn", `multiplayer: image ${sha1s[i]} isn't in the room`, e);
      }
    }
  }

  /** @internal The room's history compacted at `seq` from this copy's head. */
  async uploadSnapshot(fileKey: FileKey, key: string, seq: number): Promise<boolean> {
    const snapshot = await this.host.headSnapshot(fileKey);
    try {
      await this.api("PUT", `/files/${key}/snapshot?seq=${seq}`, snapshot);
      return true;
    } catch (e) {
      this.host.log("warn", "multiplayer: the room didn't take the snapshot", e);
      return false;
    }
  }

  async members(fileKey: FileKey): Promise<FileMember[]> {
    const { members } = await this.api<{ members: FileMember[] }>("GET", `/files/${await this.keyOf(fileKey)}/members`);
    return members;
  }

  private requestCounts = new Map<FileKey, number>();
  private notices = new Set<(fileKey: FileKey, notice: MultiplayerNotice) => void>();
  onNotice(listener: (fileKey: FileKey, notice: MultiplayerNotice) => void): Unsubscribe {
    this.notices.add(listener);
    return () => this.notices.delete(listener);
  }

  /** @internal A notice from the room: requests are counted for editors, answers reach the person who asked. */
  async notice(fileKey: FileKey, n: MultiplayerNotice): Promise<void> {
    if (n.kind === "access-request") await this.requests(fileKey).catch(() => []);
    for (const l of this.notices) l(fileKey, n);
  }

  async requestEdit(fileKey: FileKey): Promise<void> {
    await this.api("POST", `/files/${await this.keyOf(fileKey)}/requests`);
  }

  async requests(fileKey: FileKey): Promise<AccessRequest[]> {
    const { requests } = await this.api<{ requests: AccessRequest[] }>("GET", `/files/${await this.keyOf(fileKey)}/requests`);
    if (this.requestCounts.get(fileKey) !== requests.length) {
      this.requestCounts.set(fileKey, requests.length);
      this.emitState(fileKey);
    }
    return requests;
  }

  async answerRequest(fileKey: FileKey, userId: string, approve: boolean): Promise<AccessRequest[]> {
    await this.api("POST", `/files/${await this.keyOf(fileKey)}/requests/${encodeURIComponent(userId)}`, { approve });
    return this.requests(fileKey);
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

  async invite(fileKey: FileKey, email: string, role: "editor" | "viewer"): Promise<FileMember[]> {
    await this.api("PUT", `/files/${await this.keyOf(fileKey)}/members`, { email, role });
    return this.members(fileKey);
  }

  async removeMember(fileKey: FileKey, email: string): Promise<FileMember[]> {
    await this.api("DELETE", `/files/${await this.keyOf(fileKey)}/members/${encodeURIComponent(email)}`);
    return this.members(fileKey);
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
    return this.members(fileKey);
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

  close(): void {
    this.off();
    for (const l of this.live.values()) l.stop();
    this.live.clear();
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

  private startLink(fileKey: FileKey): void {
    if (!this.session || this.live.has(fileKey) || (this.only && !this.only.has(fileKey))) return;
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
      if (typeof r.pass === "string") {
        links[k].pass = r.pass;
        this.passes.set(r.key, r.pass);
      }
    }
    this.state = { installationId: id, links };
    if (id !== raw?.installationId) await this.host.saveInstallationId(id);
    return this.state;
  }

  private async raw(method: string, path: string, body?: unknown): Promise<Response> {
    if (!this.session) throw new StoreError("offline", "Log in to share files");
    const init: RequestInit = { method, headers: { authorization: `Bearer ${this.session.token}` } };
    const pass = this.passes.get(/^\/files\/([^/?]+)/.exec(path)?.[1] ?? "");
    if (pass) (init.headers as Record<string, string>)["x-file-pass"] = pass;
    if (body instanceof Uint8Array) {
      init.body = body as unknown as RequestInit["body"];
      (init.headers as Record<string, string>)["content-type"] = "application/octet-stream";
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
    let res: Response;
    try {
      res = await this.deps.fetch(new URL(path, this.session.server).toString(), init);
    } catch {
      throw new StoreError("offline", "Couldn't reach the server. Check your connection and try again.");
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // plain text
    }
    if (res.status === 401) throw new StoreError("forbidden", "Your session expired. Log in again.");
    if (res.status === 403) throw new StoreError("forbidden", message || "You don't have access");
    if (res.status === 404) throw new StoreError("not-found", message || "Not found");
    throw new StoreError("invalid", message || `The server said ${res.status}`);
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

  private async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    return (await res.json()) as T;
  }
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
        ws.send(JSON.stringify({ t: "hello", since: r.since }));
      });
    };
    ws.onmessage = (e) => {
      const data = e.data;
      // The room's refusals come right before it closes the socket: acted on now, before the close can schedule a retry.
      if (typeof data === "string" && data.includes('"t":"error"')) {
        const msg = JSON.parse(data) as Extract<ServerControl, { t: "error" }>;
        this.svc.host_.log("warn", `multiplayer ${this.fileKey}: ${msg.code} — ${msg.message}`);
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
      // Refused before the socket opened (no welcome) or its access changed: a new link password stops the link until
      // the person enters it (Figma: open sessions re-enter a changed password).
      if (e.code === CLOSE_ACCESS || this.attempt >= 1) {
        void this.svc.checkLocked(this.fileKey).then((locked) => !locked && this.retry(e.code === CLOSE_ACCESS ? 0 : undefined));
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
        case "presence": {
          const p = this.peers.get(msg.sessionID);
          if (p) p.presence = msg.data;
          return this.svc.emitState(this.fileKey);
        }
        case "signal":
          return this.svc.signalled(this.fileKey, msg.from, msg.data);
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
