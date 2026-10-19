/**
 * One file's room: the sequencer behind the WebSocket (docs/multiplayer.md §4). Pure — no Cloudflare, no sockets — so
 * it runs in Node tests and inside the `FileRoom` Durable Object alike. The host gives it a `RoomStorage` (synchronous:
 * Durable Objects' SQLite storage is) and `Connection`s, each with the identity the Worker resolved.
 *
 * Rules:
 * - A frame is accepted whole and gets the next `seq`; the room never reads the kiwi payload.
 * - Every accepted frame goes to every member, the sender's included (its acknowledgement, carrying its `batch`).
 * - `hello {since}` is answered by `welcome`, the frames after `since`, then `ready` — synchronously, so no frame lands
 *   between the catch-up and `ready`.
 * - Viewers receive everything but may not send changes.
 * - Presence is relayed, remembered per member for newcomers, never stored.
 * - Each member gets a multiplayer colour at hello (Phase 6, colors.ts): the one fewest of the others have (Figma's
 *   server fills `UserChange.color`); it goes out in `welcome.color` and with the member in `peers` / `peer-joined`.
 * - Signals go to one session only (by its sessionID), never stored.
 * - The org's room policy (cursor chat, audio — docs/multiplayer.md §15.9) arrives with each socket's identity (the
 *   Worker's `x-policy`) and goes out in `welcome.policy`; a change (`setPolicy`) is broadcast as `{t: "policy"}`.
 * - REST render jobs (docs/multiplayer.md §16.6): `hello {render: true}` marks a socket that can answer them
 *   (`helper: true` too: the desktop app's hidden render helper, asked last); `renderers()` lists them in the order
 *   jobs try them; `rest-job-done` / `rest-job-failed` go to the host's `onRest`.
 * - Discovery (docs/governance.md §2.11): only for members whose policy says `discovery: true`, the room keeps the last
 *   writer and each cursor chat message's final text (the last text before the bubble closed or the member left); the
 *   host drains them with `drainDiscovery()` after each message and does the I/O. Off: nothing is kept.
 */
import {
  decodeChangesUp,
  encodeChangesDown,
  MAX_FRAME_BYTES,
  MAX_SIGNAL_BYTES,
  MAX_CURSORS,
  MAX_EDITORS,
  MAX_PARTICIPANTS,
  MAX_PRESENCE_BYTES,
  EXTRA_EDITORS_WHEN_FULL,
  PRESENCE_PER_SECOND,
  CLOSE_FULL,
  CLOSE_TOO_OLD,
  type MultiplayerSignalName,
  type ChangesDown,
  type ClientControl,
  type PeerInfo,
  type Role,
  type ServerControl,
} from "./protocol";
import type { RoomPolicy } from "../org/identity";
import { leastUsedColor } from "./colors";
import type { RestJob, RestJobPart } from "../rest/types";

export interface RoomStorage {
  /** Next sessionID for this file (1, 2, 3 …), persisted */
  nextSessionID(): number;
  /** The seq of the last accepted frame (the snapshot's when no frame is kept after it; 0 for a new file) */
  lastSeq(): number;
  /** The first seq still held as a frame (a tail of frames before the snapshot is kept for returning clients) */
  firstSeq(): number;
  /** The seq of the latest snapshot (0 for a new file) */
  snapshotSeq(): number;
  append(frame: ChangesDown): void;
  /** Frames with seq > `since`, in order */
  readAfter(since: number): Iterable<ChangesDown>;
}

export interface Connection {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface Identity {
  userId: string;
  name?: string;
  role: Role;
  /** The org's room policy when the socket was opened (absent outside orgs: everything allowed) */
  policy?: RoomPolicy;
}

/** What a member is; a host that hibernates keeps it with the socket and gives it back through `restore`. */
export interface MemberState extends Identity {
  /** 0 until the member said hello */
  sessionID: number;
  presence?: unknown;
  /** `hello.render`: can answer REST render jobs (§16.6) */
  render?: boolean;
  /** `hello.helper`: the desktop app's hidden render helper (asked after editors and viewers) */
  helper?: boolean;
  /** When the member last sent a change (or said hello): the editor idle longest is asked first */
  activeAt?: number;
  /** Its multiplayer colour (an index into MULTIPLAYER_COLORS), given at hello */
  color?: number;
  /** Joined past MAX_EDITORS: can edit the file, a viewer in this session (§18.13) */
  limited?: boolean;
  /** Joined past MAX_PARTICIPANTS as one of the EXTRA_EDITORS_WHEN_FULL */
  overflow?: boolean;
  /** Joined past MAX_CURSORS: its cursor isn't relayed unless someone follows it; `observedTold`: it was told once */
  cursorHidden?: boolean;
  observedTold?: boolean;
}

/** The room's limits (§18.13): Figma's by default, smaller in tests */
export interface RoomLimits {
  editors: number;
  cursors: number;
  participants: number;
  extraEditors: number;
}

const LIMITS: RoomLimits = { editors: MAX_EDITORS, cursors: MAX_CURSORS, participants: MAX_PARTICIPANTS, extraEditors: EXTRA_EDITORS_WHEN_FULL };

/** Does the member write in this session (an owner or editor not limited)? */
const writes = (m: MemberState) => (m.role === "owner" || m.role === "editor") && !m.limited;

/** What the room captured for Discovery since the last drain (docs/governance.md §2.11) */
export interface DiscoveryCapture {
  /** Cursor chat messages that ended: their final text */
  chat: { userId: string; text: string; at: number }[];
  /** The last accepted frame's author and time */
  wrote: { userId: string; at: number } | null;
}

/** The longest cursor chat text kept (the client sends at most 52 characters) */
export const DISCOVERY_CHAT_MAX = 200;
/** Chat messages kept between drains (the oldest go first) */
export const DISCOVERY_CHAT_QUEUE = 100;

/** A REST job's answer from a member (§16.6) */
export type RestAnswer = { t: "rest-job-done"; id: string; parts: RestJobPart[] } | { t: "rest-job-failed"; id: string; err: string };

export interface RoomOptions {
  /** Milliseconds (render order); default Date.now */
  now?(): number;
  /** A member answered a REST job */
  onRest?(conn: Connection, member: MemberState, answer: RestAnswer): void;
  /** A member that can render said hello (a job waiting for one may go on) */
  onRenderer?(conn: Connection, member: MemberState): void;
  /** Figma's limits (default: theirs) */
  limits?: Partial<RoomLimits>;
  /** The oldest client protocol (hello.v) the room takes (default 0: every client) */
  minProtocol?: number;
}

export class Room {
  private members = new Map<Connection, MemberState>();
  private discovery: DiscoveryCapture | null = null;

  constructor(
    private storage: RoomStorage,
    /** Called when a member's state changes (the host persists it with the socket) */
    private onState: (conn: Connection, state: MemberState) => void = () => {},
    private opts: RoomOptions = {},
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private get limits(): RoomLimits {
    return { ...LIMITS, ...this.opts.limits };
  }

  /** Presence messages per member in the current second (PRESENCE_PER_SECOND; not kept across hibernation) */
  private presenceRate = new WeakMap<Connection, { second: number; n: number }>();

  /** One of Figma's signals to a user's sessions (`invalid-permissions` before their access goes) */
  signalUser(userId: string, name: MultiplayerSignalName): void {
    for (const [c, m] of this.members) if (m.userId === userId) this.send(c, { t: "mp-signal", name });
  }

  /**
   * Members that can answer REST jobs, in the order jobs try them (§16.6): editors (idle longest first), then viewers,
   * then render helpers. `canEdit`: only those whose role edits (POST variables).
   */
  renderers(opts: { canEdit?: boolean } = {}): Connection[] {
    const tier = (m: MemberState) => (m.helper ? 2 : m.role === "viewer" ? 1 : 0);
    return [...this.members]
      .filter(([, m]) => m.sessionID && m.render && (!opts.canEdit || writes(m)))
      .sort(([, a], [, b]) => tier(a) - tier(b) || (a.activeAt ?? 0) - (b.activeAt ?? 0))
      .map(([c]) => c);
  }

  /** The member behind a connection */
  member(conn: Connection): MemberState | undefined {
    return this.members.get(conn);
  }

  /** A REST job to one member */
  sendJob(conn: Connection, id: string, job: RestJob): void {
    this.send(conn, { t: "rest-job", id, job });
  }

  /** Discovery's capture since the last call (null: nothing), emptied */
  drainDiscovery(): DiscoveryCapture | null {
    const d = this.discovery;
    this.discovery = null;
    return d;
  }

  private captured(): DiscoveryCapture {
    return (this.discovery ??= { chat: [], wrote: null });
  }

  /** A member's chat bubble went from `before` to `after`: a message that ended is captured */
  private chatEnded(m: MemberState, before: unknown, after: unknown): void {
    if (!m.policy?.discovery) return;
    const prev = chatOf(before);
    if (!prev) return;
    const next = chatOf(after);
    if (next && (next.startsWith(prev) || prev.startsWith(next))) return; // still typing (or deleting)
    // Closed, emptied, or replaced by another message (at most DISCOVERY_CHAT_QUEUE wait for a drain)
    const chat = this.captured().chat;
    if (chat.length >= DISCOVERY_CHAT_QUEUE) chat.shift();
    chat.push({ userId: m.userId, text: prev.slice(0, DISCOVERY_CHAT_MAX), at: this.now() });
  }

  /** Members that said hello */
  get size(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.sessionID) n++;
    return n;
  }

  /** A socket the host accepted for `identity`; it is a member once it says hello. */
  connect(conn: Connection, identity: Identity): void {
    const state: MemberState = { ...identity, sessionID: 0 };
    this.members.set(conn, state);
    this.onState(conn, state);
  }

  /** A socket kept across hibernation, with the state `onState` last gave. Sends nothing. */
  restore(conn: Connection, state: MemberState): void {
    this.members.set(conn, state);
  }

  /** A text or binary frame from `conn`. */
  receive(conn: Connection, data: string | Uint8Array): void {
    const m = this.members.get(conn);
    if (!m) return this.fail(conn, "unauthorized", "not connected");
    if (typeof data === "string") {
      let msg: ClientControl;
      try {
        msg = JSON.parse(data) as ClientControl;
      } catch {
        return this.fail(conn, "bad-frame", "not JSON");
      }
      if (msg.t === "hello") return this.hello(conn, m, msg.since, msg.render === true, (msg as { helper?: unknown }).helper === true, typeof msg.v === "number" ? msg.v : 0);
      if (!m.sessionID) return this.fail(conn, "unauthorized", "hello first");
      if (msg.t === "rest-job-done" || msg.t === "rest-job-failed") {
        if (typeof msg.id === "string") this.opts.onRest?.(conn, m, msg);
        return;
      }
      if (msg.t === "presence") {
        // Past the size or the rate (§18.13): dropped — the next one carries the same state
        if (data.length > MAX_PRESENCE_BYTES) return;
        const second = Math.floor(this.now() / 1000);
        const rate = this.presenceRate.get(conn);
        if (rate && rate.second === second) {
          if (++rate.n > PRESENCE_PER_SECOND) return;
        } else this.presenceRate.set(conn, { second, n: 1 });
        this.chatEnded(m, m.presence, msg.data);
        m.presence = msg.data;
        this.onState(conn, m);
        this.broadcast({ t: "presence", sessionID: m.sessionID, data: this.relayed(m) }, conn);
        this.followed(m);
      } else if (msg.t === "signal") {
        if (data.length > MAX_SIGNAL_BYTES) return this.fail(conn, "too-large", "signal over the limit");
        const text = JSON.stringify({ t: "signal", from: m.sessionID, data: msg.data } satisfies ServerControl);
        for (const [c, o] of this.members) if (o.sessionID === msg.to && c !== conn) c.send(text);
      }
      return;
    }
    if (!m.sessionID) return this.fail(conn, "unauthorized", "hello first");
    // Only owners and editors write (defense in depth: any other level — viewer, prototype-only — is refused), and not
    // one who joined past the editors' limit (a viewer for this session)
    if (!writes(m)) return this.fail(conn, "forbidden", "viewers can't edit");
    if (data.length > MAX_FRAME_BYTES) return this.fail(conn, "too-large", "frame over the limit");
    const up = decodeChangesUp(data);
    if (!up) return this.fail(conn, "bad-frame", "unknown binary frame");
    const frame: ChangesDown = { seq: this.storage.lastSeq() + 1, sessionID: m.sessionID, batch: up.batch, message: up.message };
    this.storage.append(frame);
    m.activeAt = this.now();
    if (m.policy?.discovery) this.captured().wrote = { userId: m.userId, at: m.activeAt };
    const out = encodeChangesDown(frame);
    for (const [c, other] of this.members) if (other.sessionID) c.send(out);
  }

  leave(conn: Connection): void {
    const m = this.members.get(conn);
    if (!m) return;
    this.members.delete(conn);
    this.chatEnded(m, m.presence, undefined);
    if (m.sessionID) this.broadcast({ t: "peer-left", sessionID: m.sessionID });
    // A cursor shown left: the longest hidden one is shown again (§18.13)
    if (m.sessionID && !m.cursorHidden) {
      const shown = [...this.members.values()].filter((o) => o.sessionID && !o.cursorHidden).length;
      if (shown < this.limits.cursors) {
        const next = [...this.members].filter(([, o]) => o.sessionID && o.cursorHidden).sort(([, a], [, b]) => a.sessionID - b.sessionID)[0];
        if (next) {
          next[1].cursorHidden = false;
          this.onState(next[0], next[1]);
          this.send(next[0], { t: "cursor", hidden: false, why: "left" });
          if (next[1].presence !== undefined) this.broadcast({ t: "presence", sessionID: next[1].sessionID, data: next[1].presence }, next[0]);
        }
      }
    }
  }

  /** What others get of a member's presence: a hidden cursor (MAX_CURSORS) is left out unless someone follows it */
  private relayed(m: MemberState): unknown {
    if (!m.cursorHidden || this.observed(m)) return m.presence;
    const p = m.presence;
    return p && typeof p === "object" && "cursor" in p ? { ...(p as object), cursor: null } : p;
  }

  private observed(m: MemberState): boolean {
    for (const o of this.members.values()) {
      if (o === m || !o.sessionID || !o.presence || typeof o.presence !== "object") continue;
      if ((o.presence as { observing?: unknown }).observing === m.sessionID) return true;
    }
    return (m.presence as { spotlight?: unknown } | undefined)?.spotlight === true;
  }

  /** `m` may have started following a hidden cursor: its owner is told once, and its cursor goes out again */
  private followed(m: MemberState): void {
    const target = m.presence && typeof m.presence === "object" ? (m.presence as { observing?: unknown }).observing : undefined;
    if (typeof target !== "number") return;
    for (const [c, o] of this.members) {
      if (o.sessionID !== target || !o.cursorHidden || o.observedTold) continue;
      o.observedTold = true;
      this.onState(c, o);
      this.send(c, { t: "cursor", hidden: false, why: "observed" });
      if (o.presence !== undefined) this.broadcast({ t: "presence", sessionID: o.sessionID, data: o.presence }, c);
    }
  }

  /** Close every member (the file stopped being shared, or its snapshot was replaced under them). */
  closeAll(code: number, reason: string): void {
    for (const c of [...this.members.keys()]) {
      this.members.delete(c);
      c.close(code, reason);
    }
  }

  /** A notice from the Worker: access requests go to editors, answers to the person who asked. */
  notice(n: { kind: "access-request" | "access-granted" | "access-denied"; userId: string; name?: string }): void {
    const text = JSON.stringify({ t: "notice", ...n });
    for (const [c, m] of this.members) {
      if (!m.sessionID) continue;
      if (n.kind === "access-request" ? m.role !== "viewer" : m.userId === n.userId) c.send(text);
    }
  }

  /** A non-stored notice to every member that said hello (`{t: "dev-resources"}`, `{t: "code-connect"}`: read them again) */
  broadcastNotice(msg: { t: string } & Record<string, unknown>): void {
    const text = JSON.stringify(msg);
    for (const [c, m] of this.members) if (m.sessionID) c.send(text);
  }

  /** The org changed cursor chat or audio: every member's state takes it, and those that said hello are told. */
  setPolicy(policy: RoomPolicy): void {
    for (const [c, m] of this.members) {
      m.policy = { ...policy };
      this.onState(c, m);
    }
    this.broadcast({ t: "policy", policy: { ...policy } });
  }

  /** Close a user's sockets (removed, or their role changed: they reconnect with the new one). */
  closeUser(userId: string, code: number, reason: string): void {
    for (const [c, m] of [...this.members]) {
      if (m.userId !== userId) continue;
      this.leave(c);
      c.close(code, reason);
    }
  }

  private hello(conn: Connection, m: MemberState, since: number, render = false, helper = false, v = 0): void {
    if (m.sessionID) return;
    if (!Number.isInteger(since) || since < 0) return this.fail(conn, "bad-frame", "bad since");
    // Figma's signals (§18.13): an app older than the room takes, a full file
    if (v < (this.opts.minProtocol ?? 0)) return this.refuse(conn, "client-too-old", CLOSE_TOO_OLD);
    const present = [...this.members.values()].filter((o) => o !== m && o.sessionID);
    const limits = this.limits;
    const canWrite = m.role === "owner" || m.role === "editor";
    if (present.length >= limits.participants) {
      if (!canWrite || present.filter((o) => o.overflow).length >= limits.extraEditors) return this.refuse(conn, "too-many-connections", CLOSE_FULL);
      m.overflow = true;
    }
    if (canWrite && present.filter(writes).length >= limits.editors) m.limited = true;
    if (present.filter((o) => !o.cursorHidden).length >= limits.cursors) m.cursorHidden = true;
    if (since < this.storage.firstSeq() - 1 || since > this.storage.lastSeq()) return this.fail(conn, "too-old", "load the file's snapshot first");
    m.sessionID = this.storage.nextSessionID();
    m.activeAt = this.now();
    m.color = leastUsedColor([...this.members.values()].flatMap((o) => (o !== m && o.sessionID && o.color !== undefined ? [o.color] : [])));
    if (render) m.render = true;
    if (render && helper) m.helper = true;
    this.onState(conn, m);
    const peers: PeerInfo[] = [];
    for (const [c, o] of this.members) if (c !== conn && o.sessionID) peers.push(peerOf(o, this.relayed(o)));
    this.send(conn, {
      t: "welcome",
      sessionID: m.sessionID,
      role: roleOf(m),
      seq: this.storage.lastSeq(),
      peers,
      snapshotSeq: this.storage.snapshotSeq(),
      color: m.color,
      ...(m.policy ? { policy: m.policy } : {}),
      ...(m.limited ? { limited: "editors" as const } : {}),
      ...(m.cursorHidden ? { cursorHidden: true } : {}),
    });
    for (const f of this.storage.readAfter(since)) conn.send(encodeChangesDown(f));
    this.send(conn, { t: "ready", seq: this.storage.lastSeq() });
    this.broadcast({ t: "peer-joined", peer: { sessionID: m.sessionID, userId: m.userId, name: m.name, role: roleOf(m), color: m.color } }, conn);
    if (m.render) this.opts.onRenderer?.(conn, m);
  }

  private broadcast(msg: ServerControl, except?: Connection): void {
    const text = JSON.stringify(msg);
    for (const [c, m] of this.members) if (c !== except && m.sessionID) c.send(text);
  }

  private send(conn: Connection, msg: ServerControl): void {
    conn.send(JSON.stringify(msg));
  }

  /** One of Figma's signals, then the socket closes with `code` (the member never joined) */
  private refuse(conn: Connection, name: MultiplayerSignalName, code: number): void {
    this.send(conn, { t: "mp-signal", name });
    this.members.delete(conn);
    conn.close(code, name);
  }

  private fail(conn: Connection, code: Extract<ServerControl, { t: "error" }>["code"], message: string): void {
    this.send(conn, { t: "error", code, message });
    this.members.delete(conn);
    conn.close(1008, code);
  }
}

/** The chat text of a presence (null: no bubble; "" an empty one) */
function chatOf(presence: unknown): string | null {
  const c = presence && typeof presence === "object" ? (presence as { chat?: unknown }).chat : undefined;
  return typeof c === "string" ? c.trim() : null;
}

/** The role others see and the member is told: a viewer while limited (MAX_EDITORS) */
function roleOf(m: MemberState): Role {
  return m.limited ? "viewer" : m.role;
}

function peerOf(m: MemberState, presence: unknown = m.presence): PeerInfo {
  return { sessionID: m.sessionID, userId: m.userId, name: m.name, role: roleOf(m), presence, ...(m.color !== undefined ? { color: m.color } : {}) };
}

/** A `RoomStorage` in memory — tests, and the room's reference behaviour. */
export class MemoryRoomStorage implements RoomStorage {
  frames: ChangesDown[] = [];
  private session = 0;
  /** The snapshot's seq */
  base = 0;
  /** Frames before `base` kept for clients coming back (0 in tests: compaction drops everything up to the snapshot) */
  constructor(private keep = 0) {}
  nextSessionID(): number {
    return ++this.session;
  }
  lastSeq(): number {
    return this.frames.length ? this.frames[this.frames.length - 1].seq : this.base;
  }
  firstSeq(): number {
    return this.frames.length ? Math.min(this.frames[0].seq, this.base + 1) : this.base + 1;
  }
  snapshotSeq(): number {
    return this.base;
  }
  append(f: ChangesDown): void {
    this.frames.push({ ...f, message: f.message.slice() });
  }
  readAfter(since: number): Iterable<ChangesDown> {
    return this.frames.filter((f) => f.seq > since);
  }
  /** A snapshot at `seq` replaced the frames up to it */
  compact(seq: number): void {
    this.base = seq;
    this.frames = this.frames.filter((f) => f.seq > seq - this.keep);
  }
}
