/**
 * One shared file's storage behind its `FileRoom` (docs/multiplayer.md §4, docs/data.md §15.7): the snapshot, the
 * frames, the images, and — round 2c — the branch base, the session-counter blocks and the room's version history.
 * The HTTP side of the Durable Object, minus the sockets: pure over a narrow SQL interface, so Node's tests run it on
 * node:sqlite (as `PreviewBox`). `FileRoom` gives it SQLite storage and a way to reach its members.
 *
 * Tables (the object's own SQLite, created on start — no wrangler migration):
 *   meta (k, v INTEGER)                    session, base, snapshotSeq, baseSeq, baseNextSeq, frozen, branchPending,
 *                                          lastVersionAt, lastVersionSeq, editedSince, dueSince
 *   frames, snapshot, blobs                as before round 2c
 *   base_chunks (slot, idx, bytes)         slot 'base' (the branch's merge base, main's document at baseSeq) and
 *                                          'next' (staged by PUT /room/base until an update promotes it)
 *   versions                               the room's version history (newest first by seq, created_at)
 *   history_snapshots (seq, idx, bytes)    snapshots versions start from, shared by the versions that use them
 *   history_frames (seq, …)                frames after such a snapshot, up to a version's seq, shared likewise
 *
 * A version is "the document at `seq`": a snapshot at `snapshot_seq` ≤ seq plus the frames (snapshot_seq, seq]. The room
 * never decodes kiwi, so it keeps what it has; a client may later replace a version's content with one snapshot at its
 * seq (PUT /room/versions/:id/snapshot), and what no version needs any more is dropped.
 */
import { encodeChangesDown, type ChangesDown } from "../../src/shared/multiplayer/protocol";
import type { RoomStorage } from "../../src/shared/multiplayer/room";
import type { SqlLike } from "./previews";

/** SQLite values hold 2 MB; snapshots and images are stored in 1 MB rows. */
const CHUNK = 1024 * 1024;
/** Frames kept before a snapshot, so a client away for a while still catches up from its own seq */
const KEEP_FRAMES = 5000;
/** An image (or another blob a frame refers to by SHA-1) is at most this large */
export const MAX_BLOB_BYTES = 40 * 1024 * 1024;
/** docs/data.md §15.2: the main room's session counter jumps by this at "Create branch"; the branch owns the block */
export const SESSION_BLOCK = 65536;
/** An autosave version after this much time of edits (docs/data.md §6, Figma's 30 minutes) … */
export const AUTOSAVE_MS = 30 * 60_000;
/** … taken once the room has been quiet this long … */
export const AUTOSAVE_QUIET_MS = 2000;
/** … or at the latest this long after it fell due */
export const AUTOSAVE_MAX_WAIT_MS = 60_000;

/** docs/data.md §6 kinds and §15.2's branch kinds */
export const VERSION_KINDS = ["autosave", "named", "restore", "publish", "import", "branch", "update", "merge"] as const;
export type RoomVersionKind = (typeof VERSION_KINDS)[number];

/** A version as the routes answer it (`VersionRecord`'s fields the room knows; `blobRefs` are the client's to read) */
export interface RoomVersion {
  id: string;
  kind: RoomVersionKind;
  title: string | null;
  description: string | null;
  createdAt: number;
  seq: number;
  /** The snapshot the version's content starts from (= seq once compacted) */
  snapshotSeq: number;
  sizeBytes: number;
  restoredFrom: string | null;
  libraryVersion: number | null;
  user: { id: string | null; name: string | null };
}

export interface RoomHost {
  sql: SqlLike;
  /** All of `fn` or none of it (`ctx.storage.transactionSync`) */
  transaction(fn: () => void): void;
  now(): number;
  /** The object's alarm (autosave); null clears it */
  setAlarm(at: number | null): void;
  /** A frame to every member that said hello (as the room sends accepted frames) */
  broadcast(frame: Uint8Array): void;
  /** Is `sessionID` a member of this room signed in as `userId` now? */
  hasSession(userId: string, sessionID: number): boolean;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** A `VersionId` (16 base62 characters, src/shared/store/types.ts isVersionId) */
export function versionId(): string {
  let out = "";
  while (out.length < 16) for (const b of crypto.getRandomValues(new Uint8Array(32))) if (b < 248 && out.length < 16) out += B62[b % 62];
  return out;
}

// --- The apply envelope (merge / update) -----------------------------------------------------------------------------

/**
 * `POST /branches/:key/merge|update` and `POST /room/apply` carry `[u32 BE json length][JSON (UTF-8)][kiwi Message]`:
 * the merge core's batch (the bytes a `changes-up` frame would carry) with what the room needs to order it.
 */
export function encodeEnvelope(meta: unknown, message: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + head.length + message.length);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  out.set(message, 4 + head.length);
  return out;
}

export function decodeEnvelope<T = Record<string, unknown>>(bytes: Uint8Array): { meta: T; message: Uint8Array } | null {
  if (bytes.length < 4) return null;
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (4 + n > bytes.length) return null;
  try {
    const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + n))) as unknown;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
    return { meta: meta as T, message: bytes.slice(4 + n) };
  } catch {
    return null;
  }
}

/** What the room's apply takes (the Worker fills it after its checks) */
export interface ApplyMeta {
  /** The room's head the batch was computed against: anything else is `stale` */
  expectSeq: number;
  kind: "merge" | "update";
  /** The sender's session in this room, when it is in it (its store then reads the frame as its own); else 0 */
  sessionID?: number;
  batch?: number;
  title?: string | null;
  description?: string | null;
  /** merge: an autosave version of the head first (the pre-merge checkpoint, §15.5 step 4) */
  checkpoint?: boolean;
  /** update: the staged base (PUT /room/base) at this seq becomes the base with the frame */
  promoteBase?: number;
}

// --- Frames and snapshot -----------------------------------------------------------------------------------------------

export class SqlRoomStorage implements RoomStorage {
  private last: number | undefined;

  constructor(private sql: SqlLike) {}

  /** -1 when unset */
  meta(k: string): number {
    const r = this.sql.exec<{ v: number }>(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0];
    return r ? r.v : -1;
  }

  setMeta(k: string, v: number): void {
    this.sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, k, v);
  }

  clearMeta(k: string): void {
    this.sql.exec(`DELETE FROM meta WHERE k = ?`, k);
  }

  nextSessionID(): number {
    const n = Math.max(this.meta("session"), 0) + 1;
    this.setMeta("session", n);
    return n;
  }

  lastSeq(): number {
    if (this.last === undefined) {
      const r = this.sql.exec<{ s: number | null }>(`SELECT MAX(seq) AS s FROM frames`).toArray()[0];
      this.last = r?.s ?? Math.max(this.meta("base"), 0);
    }
    return this.last;
  }

  firstSeq(): number {
    const r = this.sql.exec<{ s: number | null }>(`SELECT MIN(seq) AS s FROM frames`).toArray()[0];
    const base = Math.max(this.meta("base"), 0);
    return r?.s != null ? Math.min(r.s, base + 1) : base + 1;
  }

  snapshotSeq(): number {
    return Math.max(this.meta("snapshotSeq"), 0);
  }

  append(f: ChangesDown): void {
    this.sql.exec(`INSERT INTO frames (seq, session, batch, message) VALUES (?, ?, ?, ?)`, f.seq, f.sessionID, f.batch, f.message.slice().buffer);
    this.last = f.seq;
  }

  *readAfter(since: number): Iterable<ChangesDown> {
    for (const r of this.sql.exec<{ seq: number; session: number; batch: number; message: ArrayBuffer }>(`SELECT seq, session, batch, message FROM frames WHERE seq > ? ORDER BY seq`, since).toArray()) {
      yield { seq: r.seq, sessionID: r.session, batch: r.batch, message: new Uint8Array(r.message) };
    }
  }

  /** The snapshot at `seq` replaces the frames up to it. */
  compact(seq: number): void {
    const last = this.lastSeq();
    this.sql.exec(`DELETE FROM frames WHERE seq <= ?`, seq - KEEP_FRAMES);
    this.setMeta("base", seq);
    this.last = Math.max(last, seq);
  }

  /** Forget the cached head (after a rolled-back transaction) */
  reload(): void {
    this.last = undefined;
  }
}

/** `[u32 length][changes-down frame]` each — GET /room/frames' body */
export function packFrames(frames: Iterable<ChangesDown>): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const f of frames) {
    const enc = encodeChangesDown(f);
    parts.push(enc);
    total += 4 + enc.length;
  }
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const p of parts) {
    view.setUint32(at, p.length);
    out.set(p, at + 4);
    at += 4 + p.length;
  }
  return out;
}

interface VersionRow {
  id: string;
  kind: RoomVersionKind;
  title: string | null;
  description: string | null;
  seq: number;
  snapshot_seq: number;
  created_at: number;
  user_id: string | null;
  user_name: string | null;
  restored_from: string | null;
  library_version: number | null;
  size: number;
}

const toVersion = (r: VersionRow): RoomVersion => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  description: r.description,
  createdAt: r.created_at,
  seq: r.seq,
  snapshotSeq: r.snapshot_seq,
  sizeBytes: r.size,
  restoredFrom: r.restored_from,
  libraryVersion: r.library_version,
  user: { id: r.user_id, name: r.user_name },
});

class RoomError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface TakeVersion {
  kind: RoomVersionKind;
  title?: string | null;
  description?: string | null;
  /** Default: the head */
  seq?: number;
  userId?: string | null;
  userName?: string | null;
  restoredFrom?: string | null;
  libraryVersion?: number | null;
}

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export class RoomBox {
  readonly storage: SqlRoomStorage;

  constructor(private host: RoomHost) {
    this.storage = new SqlRoomStorage(host.sql);
    this.reset();
  }

  /** The tables (again after the object's storage was deleted) */
  reset(): void {
    for (const s of [
      `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS frames (seq INTEGER PRIMARY KEY, session INTEGER NOT NULL, batch INTEGER NOT NULL, message BLOB NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS snapshot (idx INTEGER PRIMARY KEY, bytes BLOB NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS blobs (sha1 TEXT NOT NULL, idx INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (sha1, idx))`,
      `CREATE TABLE IF NOT EXISTS base_chunks (slot TEXT NOT NULL, idx INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (slot, idx))`,
      `CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, description TEXT, seq INTEGER NOT NULL, snapshot_seq INTEGER NOT NULL,
         created_at INTEGER NOT NULL, user_id TEXT, user_name TEXT, restored_from TEXT, library_version INTEGER, size INTEGER NOT NULL DEFAULT 0)`,
      `CREATE INDEX IF NOT EXISTS versions_seq ON versions (seq)`,
      `CREATE TABLE IF NOT EXISTS history_snapshots (seq INTEGER NOT NULL, idx INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (seq, idx))`,
      `CREATE TABLE IF NOT EXISTS history_frames (seq INTEGER PRIMARY KEY, session INTEGER NOT NULL, batch INTEGER NOT NULL, message BLOB NOT NULL)`,
    ])
      this.host.sql.exec(s);
    this.storage.reload();
  }

  private get sql(): SqlLike {
    return this.host.sql;
  }

  /** No more frames (a merged branch; one being merged): the socket's frames are refused. */
  frozen(): boolean {
    return this.storage.meta("frozen") === 1;
  }

  /**
   * The /room/… routes that need no socket; null for the others (FileRoom's). Identity comes from the Worker's
   * headers (`x-user-id`, `x-user-name`).
   */
  async fetch(req: Request): Promise<Response | null> {
    try {
      return await this.route(req);
    } catch (e) {
      if (e instanceof RoomError) return json({ error: e.message, ...e.extra }, e.status);
      throw e;
    }
  }

  private async route(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;
    const m = req.method;
    const userId = req.headers.get("x-user-id") || null;
    const userName = req.headers.get("x-user-name") || null;
    const st = this.storage;
    switch (`${m} ${path}`) {
      case "GET /room/snapshot": {
        const seq = st.meta("snapshotSeq");
        if (seq < 0) return new Response("no snapshot yet", { status: 404 });
        return this.bytesResponse(this.read(`SELECT bytes FROM snapshot ORDER BY idx`), { "x-seq": String(seq), "x-last-seq": String(st.lastSeq()) });
      }
      case "GET /room/frames": {
        // The frames after `since` (an embed's catch-up on the snapshot): [u32 length][changes-down frame] each.
        const since = Number(url.searchParams.get("since") ?? "0");
        return new Response(packFrames(st.readAfter(Number.isInteger(since) && since >= 0 ? since : 0)), { headers: { "content-type": "application/octet-stream" } });
      }
      case "PUT /room/snapshot": {
        const seq = Number(url.searchParams.get("seq"));
        const current = st.meta("snapshotSeq");
        // A snapshot holds the document as of `seq`: it can only move forward, and not past what the room accepted.
        if (!Number.isInteger(seq) || seq < Math.max(current, 0) || seq > st.lastSeq()) {
          return json({ error: "snapshot seq out of range", snapshotSeq: current, lastSeq: st.lastSeq() }, 409);
        }
        const bytes = new Uint8Array(await req.arrayBuffer());
        const made: { id?: string } = {};
        this.host.transaction(() => {
          this.sql.exec(`DELETE FROM snapshot`);
          this.chunks(bytes, (idx, part) => this.sql.exec(`INSERT INTO snapshot (idx, bytes) VALUES (?, ?)`, idx, part));
          st.compact(seq);
          st.setMeta("snapshotSeq", seq);
          // A new branch's room: its first snapshot is "Branch created" (§15.5 step 3).
          if (st.meta("branchPending") === 1) {
            st.clearMeta("branchPending");
            made.id = this.take({ kind: "branch", seq, userId, userName }).id;
          }
        });
        return json({ ok: true, seq, lastSeq: st.lastSeq(), ...(made.id ? { versionId: made.id } : {}) });
      }
      case "POST /room/blobs/missing": {
        const { sha1s } = (await req.json()) as { sha1s: string[] };
        return json({ missing: sha1s.filter((s) => /^[0-9a-f]{40}$/.test(s) && !this.sql.exec(`SELECT 1 AS x FROM blobs WHERE sha1 = ? AND idx = 0`, s).toArray().length) });
      }
      case "GET /room/head":
        return json(this.head());
      case "POST /room/session-block": {
        // Main at "Create branch": the branch room's counter starts where this one was; this one jumps a block.
        const { size } = (await req.json()) as { size?: number };
        const n = Number.isInteger(size) && size! > 0 ? size! : SESSION_BLOCK;
        let sessionBase = 0;
        this.host.transaction(() => {
          sessionBase = Math.max(st.meta("session"), 0);
          st.setMeta("session", sessionBase + n);
        });
        return json({ sessionBase });
      }
      case "POST /room/init-branch": {
        // A new branch's room: its sessions start at the block main gave; its first snapshot will be "Branch created".
        const { sessionBase } = (await req.json()) as { sessionBase?: number };
        if (!Number.isInteger(sessionBase) || sessionBase! < 0) throw new RoomError(400, "sessionBase");
        if (st.meta("snapshotSeq") >= 0 || st.lastSeq() > 0) throw new RoomError(409, "the room already holds a document");
        this.host.transaction(() => {
          st.setMeta("session", Math.max(st.meta("session"), sessionBase!));
          st.setMeta("branchPending", 1);
        });
        return json({ ok: true });
      }
      case "GET /room/base": {
        const seq = st.meta("baseSeq");
        if (seq < 0) return new Response("no base yet", { status: 404 });
        return this.bytesResponse(this.read(`SELECT bytes FROM base_chunks WHERE slot = 'base' ORDER BY idx`), { "x-seq": String(seq) });
      }
      case "PUT /room/base": {
        // The first base is the base; later ones are staged until the update that absorbs them (POST /room/apply).
        const seq = Number(url.searchParams.get("seq"));
        if (!Number.isInteger(seq) || seq < 0) throw new RoomError(400, "bad seq");
        const bytes = new Uint8Array(await req.arrayBuffer());
        const first = st.meta("baseSeq") < 0;
        const slot = first ? "base" : "next";
        this.host.transaction(() => {
          this.sql.exec(`DELETE FROM base_chunks WHERE slot = ?`, slot);
          this.chunks(bytes, (idx, part) => this.sql.exec(`INSERT INTO base_chunks (slot, idx, bytes) VALUES (?, ?, ?)`, slot, idx, part));
          st.setMeta(first ? "baseSeq" : "baseNextSeq", seq);
        });
        return json({ ok: true, seq, staged: !first });
      }
      case "GET /room/versions":
        return json({ versions: this.versions() });
      case "POST /room/versions": {
        const b = (await req.json()) as Record<string, unknown>;
        const kind = b.kind as RoomVersionKind;
        if (!VERSION_KINDS.includes(kind)) throw new RoomError(400, `kind is one of ${VERSION_KINDS.join(", ")}`);
        const seq = b.seq === undefined || b.seq === null ? undefined : Number(b.seq);
        const made: { v?: RoomVersion } = {};
        this.host.transaction(() => {
          made.v = this.take({
            kind,
            title: text(b.title, 200),
            description: text(b.description, 5000),
            seq,
            userId,
            userName,
            restoredFrom: typeof b.restoredFrom === "string" ? b.restoredFrom : null,
            libraryVersion: typeof b.libraryVersion === "number" ? b.libraryVersion : null,
          });
        });
        return json({ version: made.v }, 201);
      }
      case "POST /room/apply":
        return this.apply(new Uint8Array(await req.arrayBuffer()), userId, userName);
      case "POST /room/freeze": {
        // The branch side of a merge: its head must be the one the merge read, and it takes no more frames.
        const { expectSeq } = (await req.json()) as { expectSeq?: number };
        if (expectSeq !== st.lastSeq()) throw new RoomError(409, "the branch changed since the preview", { code: "stale", lastSeq: st.lastSeq() });
        st.setMeta("frozen", 1);
        return json({ ok: true, lastSeq: st.lastSeq() });
      }
      case "POST /room/unfreeze":
        st.clearMeta("frozen");
        return json({ ok: true });
    }
    const blob = /^\/room\/blobs\/([0-9a-f]{40})$/.exec(path);
    if (blob && m === "GET") {
      const rows = this.read(`SELECT bytes FROM blobs WHERE sha1 = ? ORDER BY idx`, blob[1]);
      if (!rows.length) return new Response("no such blob", { status: 404 });
      return this.bytesResponse(rows, { "cache-control": "private, max-age=31536000, immutable" });
    }
    if (blob && m === "PUT") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length > MAX_BLOB_BYTES) return new Response("too large", { status: 413 });
      // Content-addressed: the bytes must be what the name says (nobody can swap an image under a hash).
      const sum = [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
      if (sum !== blob[1]) return new Response("the bytes don't match their SHA-1", { status: 400 });
      this.host.transaction(() => {
        this.sql.exec(`DELETE FROM blobs WHERE sha1 = ?`, blob[1]);
        this.chunks(bytes, (idx, part) => this.sql.exec(`INSERT INTO blobs (sha1, idx, bytes) VALUES (?, ?, ?)`, blob[1], idx, part));
      });
      return json({ ok: true });
    }
    const version = /^\/room\/versions\/([0-9A-Za-z]{16})(?:\/(snapshot|frames))?$/.exec(path);
    if (version) {
      const row = this.versionRow(version[1]);
      if (!row) throw new RoomError(404, "no such version");
      const part = version[2];
      if (!part && m === "GET") return json({ version: toVersion(row) });
      if (!part && m === "PATCH") {
        // "Name this version" (data.md §6): an autosave given a title becomes a named version.
        const b = (await req.json()) as Record<string, unknown>;
        const title = b.title === undefined ? row.title : text(b.title, 200);
        const description = b.description === undefined ? row.description : text(b.description, 5000);
        const kind = row.kind === "autosave" && title ? "named" : row.kind;
        this.sql.exec(`UPDATE versions SET title = ?, description = ?, kind = ? WHERE id = ?`, title, description, kind, row.id);
        return json({ version: toVersion(this.versionRow(row.id)!) });
      }
      if (part === "snapshot" && m === "GET") {
        return this.bytesResponse(this.read(`SELECT bytes FROM history_snapshots WHERE seq = ? ORDER BY idx`, row.snapshot_seq), { "x-seq": String(row.seq), "x-snapshot-seq": String(row.snapshot_seq) });
      }
      if (part === "frames" && m === "GET") {
        const frames = this.sql
          .exec<{ seq: number; session: number; batch: number; message: ArrayBuffer }>(`SELECT seq, session, batch, message FROM history_frames WHERE seq > ? AND seq <= ? ORDER BY seq`, row.snapshot_seq, row.seq)
          .toArray()
          .map((r) => ({ seq: r.seq, sessionID: r.session, batch: r.batch, message: new Uint8Array(r.message) }));
        return new Response(packFrames(frames), { headers: { "content-type": "application/octet-stream", "x-seq": String(row.seq) } });
      }
      if (part === "snapshot" && m === "PUT") {
        // The client's own snapshot of the version (its document at seq): the version needs no frames any more.
        const bytes = new Uint8Array(await req.arrayBuffer());
        this.host.transaction(() => {
          this.sql.exec(`DELETE FROM history_snapshots WHERE seq = ?`, row.seq);
          this.chunks(bytes, (idx, part) => this.sql.exec(`INSERT INTO history_snapshots (seq, idx, bytes) VALUES (?, ?, ?)`, row.seq, idx, part));
          this.sql.exec(`UPDATE versions SET snapshot_seq = seq, size = ? WHERE seq = ?`, bytes.length, row.seq);
          this.collect();
        });
        return json({ version: toVersion(this.versionRow(row.id)!) });
      }
    }
    return null;
  }

  head(): { lastSeq: number; firstSeq: number; snapshotSeq: number; baseSeq: number | null; baseNextSeq: number | null; frozen: boolean } {
    const st = this.storage;
    const opt = (k: string) => (st.meta(k) >= 0 ? st.meta(k) : null);
    return { lastSeq: st.lastSeq(), firstSeq: st.firstSeq(), snapshotSeq: st.meta("snapshotSeq"), baseSeq: opt("baseSeq"), baseNextSeq: opt("baseNextSeq"), frozen: this.frozen() };
  }

  versions(): RoomVersion[] {
    return this.sql.exec<VersionRow>(`SELECT * FROM versions ORDER BY seq DESC, created_at DESC`).toArray().map(toVersion);
  }

  private versionRow(id: string): VersionRow | null {
    return this.sql.exec<VersionRow>(`SELECT * FROM versions WHERE id = ?`, id).toArray()[0] ?? null;
  }

  /**
   * A version of the document at `seq` (default: the head), inside the caller's transaction: the current snapshot is
   * kept under its seq (once) and the frames after it up to `seq` are kept with it.
   */
  take(v: TakeVersion): RoomVersion {
    const st = this.storage;
    const snap = st.meta("snapshotSeq");
    if (snap < 0) throw new RoomError(409, "the file has no snapshot yet");
    const seq = v.seq ?? st.lastSeq();
    if (!Number.isInteger(seq) || seq < snap || seq > st.lastSeq()) throw new RoomError(409, "version seq out of range", { snapshotSeq: snap, lastSeq: st.lastSeq() });
    if (!this.sql.exec(`SELECT 1 AS x FROM history_snapshots WHERE seq = ? AND idx = 0`, snap).toArray().length) {
      for (const r of this.sql.exec<{ idx: number; bytes: ArrayBuffer }>(`SELECT idx, bytes FROM snapshot ORDER BY idx`).toArray()) {
        this.sql.exec(`INSERT INTO history_snapshots (seq, idx, bytes) VALUES (?, ?, ?)`, snap, r.idx, r.bytes);
      }
    }
    let size = 0;
    for (const r of this.sql.exec<{ n: number | null }>(`SELECT SUM(LENGTH(bytes)) AS n FROM history_snapshots WHERE seq = ?`, snap).toArray()) size += r.n ?? 0;
    for (const f of this.sql.exec<{ seq: number; session: number; batch: number; message: ArrayBuffer }>(`SELECT seq, session, batch, message FROM frames WHERE seq > ? AND seq <= ? ORDER BY seq`, snap, seq).toArray()) {
      this.sql.exec(`INSERT OR IGNORE INTO history_frames (seq, session, batch, message) VALUES (?, ?, ?, ?)`, f.seq, f.session, f.batch, f.message);
      size += f.message.byteLength;
    }
    const now = this.host.now();
    const row: VersionRow = {
      id: versionId(),
      kind: v.kind,
      title: v.title ?? null,
      description: v.description ?? null,
      seq,
      snapshot_seq: snap,
      created_at: now,
      user_id: v.userId ?? null,
      user_name: v.userName ?? null,
      restored_from: v.restoredFrom ?? null,
      library_version: v.libraryVersion ?? null,
      size,
    };
    this.sql.exec(
      `INSERT INTO versions (id, kind, title, description, seq, snapshot_seq, created_at, user_id, user_name, restored_from, library_version, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id, row.kind, row.title, row.description, row.seq, row.snapshot_seq, row.created_at, row.user_id, row.user_name, row.restored_from, row.library_version, row.size,
    );
    // Any version restarts the autosave clock.
    st.setMeta("lastVersionAt", now);
    st.setMeta("lastVersionSeq", Math.max(seq, st.meta("lastVersionSeq")));
    if (seq >= st.lastSeq()) {
      st.clearMeta("editedSince");
      st.clearMeta("dueSince");
    }
    return toVersion(row);
  }

  /** History rows no version needs any more */
  private collect(): void {
    this.sql.exec(`DELETE FROM history_snapshots WHERE seq NOT IN (SELECT snapshot_seq FROM versions)`);
    this.sql.exec(`DELETE FROM history_frames WHERE NOT EXISTS (SELECT 1 FROM versions v WHERE history_frames.seq > v.snapshot_seq AND history_frames.seq <= v.seq)`);
  }

  /**
   * A merge (main ← branch) or an update (branch ← main) computed by the client: one frame ordered like any other —
   * the next seq, stored, sent to every member — if and only if the head is still the one it was computed against,
   * then its version ("Branch merged" / "Updated from main"). Atomic: the object runs one request at a time.
   */
  private apply(body: Uint8Array, userId: string | null, userName: string | null): Response {
    const env = decodeEnvelope<ApplyMeta>(body);
    if (!env) throw new RoomError(400, "bad envelope");
    const { meta, message } = env;
    if (meta.kind !== "merge" && meta.kind !== "update") throw new RoomError(400, "kind is merge or update");
    const st = this.storage;
    if (meta.expectSeq !== st.lastSeq()) throw new RoomError(409, "the file changed since the preview", { code: "stale", lastSeq: st.lastSeq() });
    if (this.frozen()) throw new RoomError(409, "this file takes no more changes", { code: "frozen" });
    if (meta.promoteBase !== undefined && meta.promoteBase !== st.meta("baseNextSeq")) throw new RoomError(409, "upload the new base first", { code: "base_missing", baseNextSeq: st.meta("baseNextSeq") });
    const sessionID = userId && meta.sessionID && this.host.hasSession(userId, meta.sessionID) ? meta.sessionID : 0;
    const batch = Number.isInteger(meta.batch) && meta.batch! >= 0 ? meta.batch! : 0;
    const out: { frame?: ChangesDown; pre?: RoomVersion; version?: RoomVersion } = {};
    try {
      this.host.transaction(() => {
        if (meta.checkpoint) out.pre = this.take({ kind: "autosave", userId, userName });
        if (message.length) {
          out.frame = { seq: st.lastSeq() + 1, sessionID, batch, message };
          st.append(out.frame);
        }
        if (meta.promoteBase !== undefined) {
          this.sql.exec(`DELETE FROM base_chunks WHERE slot = 'base'`);
          this.sql.exec(`UPDATE base_chunks SET slot = 'base' WHERE slot = 'next'`);
          st.setMeta("baseSeq", meta.promoteBase);
          st.clearMeta("baseNextSeq");
        }
        out.version = this.take({ kind: meta.kind, title: text(meta.title, 200), description: text(meta.description, 5000), userId, userName });
      });
    } catch (e) {
      st.reload();
      throw e;
    }
    if (out.frame) this.host.broadcast(encodeChangesDown(out.frame));
    return json({ seq: st.lastSeq(), frameSeq: out.frame?.seq ?? null, versionId: out.version!.id, version: out.version, preVersionId: out.pre?.id ?? null });
  }

  // --- Autosave ------------------------------------------------------------------------------------------------------

  /**
   * After the room accepted frames: an autosave is due once 30 minutes passed since the last version (the first edit
   * starts the clock); it is taken when the room has been quiet 2 s, 60 s after it fell due at the latest.
   */
  edited(): void {
    const st = this.storage;
    const now = this.host.now();
    st.setMeta("editedSince", 1);
    if (st.meta("lastVersionAt") < 0) st.setMeta("lastVersionAt", now);
    const at = autosaveAlarm({ lastVersionAt: st.meta("lastVersionAt"), dueSince: st.meta("dueSince") }, now);
    if (at === null) return;
    if (st.meta("dueSince") < 0) st.setMeta("dueSince", now);
    this.host.setAlarm(at);
  }

  /** The object's alarm */
  alarm(): void {
    const st = this.storage;
    if (st.meta("editedSince") !== 1 || st.meta("snapshotSeq") < 0 || st.lastSeq() <= st.meta("lastVersionSeq")) return;
    this.host.transaction(() => void this.take({ kind: "autosave" }));
  }

  // --- Bytes ---------------------------------------------------------------------------------------------------------

  private chunks(bytes: Uint8Array, put: (idx: number, part: ArrayBuffer) => void): void {
    for (let i = 0, idx = 0; i < bytes.length || idx === 0; i += CHUNK, idx++) put(idx, bytes.slice(i, i + CHUNK).buffer);
  }

  private read(query: string, ...binds: unknown[]): { bytes: ArrayBuffer }[] {
    return this.sql.exec<{ bytes: ArrayBuffer }>(query, ...binds).toArray();
  }

  private bytesResponse(rows: { bytes: ArrayBuffer }[], headers: Record<string, string>): Response {
    const out = new Uint8Array(rows.reduce((n, r) => n + r.bytes.byteLength, 0));
    let at = 0;
    for (const r of rows) {
      out.set(new Uint8Array(r.bytes), at);
      at += r.bytes.byteLength;
    }
    return new Response(out, { headers: { "content-type": "application/octet-stream", ...headers } });
  }
}

/** When the autosave alarm should ring after an edit at `now` (null: not due yet) */
export function autosaveAlarm(s: { lastVersionAt: number; dueSince: number }, now: number): number | null {
  if (s.lastVersionAt >= 0 && now - s.lastVersionAt < AUTOSAVE_MS) return null;
  const dueSince = s.dueSince >= 0 ? s.dueSince : now;
  return Math.min(now + AUTOSAVE_QUIET_MS, dueSince + AUTOSAVE_MAX_WAIT_MS);
}
