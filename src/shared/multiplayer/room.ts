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
 * - Signals go to one session only (by its sessionID), never stored.
 */
import {
  decodeChangesUp,
  encodeChangesDown,
  MAX_FRAME_BYTES,
  MAX_SIGNAL_BYTES,
  type ChangesDown,
  type ClientControl,
  type PeerInfo,
  type Role,
  type ServerControl,
} from "./protocol";

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
}

/** What a member is; a host that hibernates keeps it with the socket and gives it back through `restore`. */
export interface MemberState extends Identity {
  /** 0 until the member said hello */
  sessionID: number;
  presence?: unknown;
}

export class Room {
  private members = new Map<Connection, MemberState>();

  constructor(
    private storage: RoomStorage,
    /** Called when a member's state changes (the host persists it with the socket) */
    private onState: (conn: Connection, state: MemberState) => void = () => {},
  ) {}

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
      if (msg.t === "hello") return this.hello(conn, m, msg.since);
      if (!m.sessionID) return this.fail(conn, "unauthorized", "hello first");
      if (msg.t === "presence") {
        m.presence = msg.data;
        this.onState(conn, m);
        this.broadcast({ t: "presence", sessionID: m.sessionID, data: msg.data }, conn);
      } else if (msg.t === "signal") {
        if (data.length > MAX_SIGNAL_BYTES) return this.fail(conn, "too-large", "signal over the limit");
        const text = JSON.stringify({ t: "signal", from: m.sessionID, data: msg.data } satisfies ServerControl);
        for (const [c, o] of this.members) if (o.sessionID === msg.to && c !== conn) c.send(text);
      }
      return;
    }
    if (!m.sessionID) return this.fail(conn, "unauthorized", "hello first");
    if (m.role === "viewer") return this.fail(conn, "forbidden", "viewers can't edit");
    if (data.length > MAX_FRAME_BYTES) return this.fail(conn, "too-large", "frame over the limit");
    const up = decodeChangesUp(data);
    if (!up) return this.fail(conn, "bad-frame", "unknown binary frame");
    const frame: ChangesDown = { seq: this.storage.lastSeq() + 1, sessionID: m.sessionID, batch: up.batch, message: up.message };
    this.storage.append(frame);
    const out = encodeChangesDown(frame);
    for (const [c, other] of this.members) if (other.sessionID) c.send(out);
  }

  leave(conn: Connection): void {
    const m = this.members.get(conn);
    if (!m) return;
    this.members.delete(conn);
    if (m.sessionID) this.broadcast({ t: "peer-left", sessionID: m.sessionID });
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

  /** Close a user's sockets (removed, or their role changed: they reconnect with the new one). */
  closeUser(userId: string, code: number, reason: string): void {
    for (const [c, m] of [...this.members]) {
      if (m.userId !== userId) continue;
      this.leave(c);
      c.close(code, reason);
    }
  }

  private hello(conn: Connection, m: MemberState, since: number): void {
    if (m.sessionID) return;
    if (!Number.isInteger(since) || since < 0) return this.fail(conn, "bad-frame", "bad since");
    if (since < this.storage.firstSeq() - 1 || since > this.storage.lastSeq()) return this.fail(conn, "too-old", "load the file's snapshot first");
    m.sessionID = this.storage.nextSessionID();
    this.onState(conn, m);
    const peers: PeerInfo[] = [];
    for (const [c, o] of this.members) if (c !== conn && o.sessionID) peers.push(peerOf(o));
    this.send(conn, { t: "welcome", sessionID: m.sessionID, role: m.role, seq: this.storage.lastSeq(), peers, snapshotSeq: this.storage.snapshotSeq() });
    for (const f of this.storage.readAfter(since)) conn.send(encodeChangesDown(f));
    this.send(conn, { t: "ready", seq: this.storage.lastSeq() });
    this.broadcast({ t: "peer-joined", peer: { sessionID: m.sessionID, userId: m.userId, name: m.name, role: m.role } }, conn);
  }

  private broadcast(msg: ServerControl, except?: Connection): void {
    const text = JSON.stringify(msg);
    for (const [c, m] of this.members) if (c !== except && m.sessionID) c.send(text);
  }

  private send(conn: Connection, msg: ServerControl): void {
    conn.send(JSON.stringify(msg));
  }

  private fail(conn: Connection, code: Extract<ServerControl, { t: "error" }>["code"], message: string): void {
    this.send(conn, { t: "error", code, message });
    this.members.delete(conn);
    conn.close(1008, code);
  }
}

function peerOf(m: MemberState): PeerInfo {
  return { sessionID: m.sessionID, userId: m.userId, name: m.name, role: m.role, presence: m.presence };
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
