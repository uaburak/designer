/**
 * One shared file's Durable Object (docs/multiplayer.md §4): the pure `Room` on SQLite storage, with hibernatable
 * WebSockets — each socket's member state rides in its serialized attachment, so an object woken by a message rebuilds
 * its members without anyone reconnecting. Reached only through the Worker, which has already resolved the caller's
 * identity and role (headers `x-user-id`, `x-user-name`, `x-role`).
 */
import { DurableObject } from "cloudflare:workers";
import type { ChangesDown, Role } from "../../src/shared/multiplayer/protocol";
import { Room, type MemberState, type RoomStorage } from "../../src/shared/multiplayer/room";

/** SQLite values hold 2 MB; snapshots are stored in 1 MB rows. */
const CHUNK = 1024 * 1024;
/** Close codes the client reads: 4001 the file stopped being shared, 4003 access changed, 4009 a snapshot replaced history. */
export const CLOSE_UNSHARED = 4001;
export const CLOSE_ACCESS = 4003;

export class FileRoom extends DurableObject {
  private sql: SqlStorage;
  private store: SqlRoomStorage;
  private room: Room;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS frames (seq INTEGER PRIMARY KEY, session INTEGER NOT NULL, batch INTEGER NOT NULL, message BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshot (idx INTEGER PRIMARY KEY, bytes BLOB NOT NULL);`);
    this.store = new SqlRoomStorage(this.sql);
    this.room = new Room(this.store, (ws, state) => (ws as WebSocket).serializeAttachment(state));
    for (const ws of ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as MemberState | null;
      if (state) this.room.restore(ws, state);
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const identity = { userId: req.headers.get("x-user-id") ?? "", name: req.headers.get("x-user-name") || undefined, role: (req.headers.get("x-role") ?? "viewer") as Role };
    switch (`${req.method} ${url.pathname}`) {
      case "GET /room/ws": {
        if (!identity.userId) return new Response("no identity", { status: 400 });
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        this.room.connect(pair[1], identity);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      case "GET /room/snapshot": {
        const seq = this.store.meta("snapshotSeq");
        if (seq < 0) return new Response("no snapshot yet", { status: 404 });
        const rows = [...this.sql.exec<{ bytes: ArrayBuffer }>(`SELECT bytes FROM snapshot ORDER BY idx`)];
        const total = rows.reduce((n, r) => n + r.bytes.byteLength, 0);
        const out = new Uint8Array(total);
        let at = 0;
        for (const r of rows) {
          out.set(new Uint8Array(r.bytes), at);
          at += r.bytes.byteLength;
        }
        return new Response(out, { headers: { "content-type": "application/octet-stream", "x-seq": String(seq), "x-last-seq": String(this.store.lastSeq()) } });
      }
      case "PUT /room/snapshot": {
        const seq = Number(url.searchParams.get("seq"));
        const current = this.store.meta("snapshotSeq");
        // A snapshot holds the document as of `seq`: it can only move forward, and not past what the room accepted.
        if (!Number.isInteger(seq) || seq < Math.max(current, 0) || seq > this.store.lastSeq()) {
          return Response.json({ error: "snapshot seq out of range", snapshotSeq: current, lastSeq: this.store.lastSeq() }, { status: 409 });
        }
        const bytes = new Uint8Array(await req.arrayBuffer());
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(`DELETE FROM snapshot`);
          for (let i = 0, idx = 0; i < bytes.length || idx === 0; i += CHUNK, idx++) this.sql.exec(`INSERT INTO snapshot (idx, bytes) VALUES (?, ?)`, idx, bytes.slice(i, i + CHUNK).buffer);
          this.store.compact(seq);
          this.store.setMeta("snapshotSeq", seq);
        });
        return Response.json({ ok: true, seq, lastSeq: this.store.lastSeq() });
      }
      case "POST /room/revoke": {
        const { userId } = (await req.json()) as { userId: string };
        this.room.closeUser(userId, CLOSE_ACCESS, "access changed");
        return Response.json({ ok: true });
      }
      case "DELETE /room": {
        this.room.closeAll(CLOSE_UNSHARED, "file no longer shared");
        await this.ctx.storage.deleteAll();
        return Response.json({ ok: true });
      }
    }
    return new Response("not found", { status: 404 });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.room.receive(ws, typeof message === "string" ? message : new Uint8Array(message));
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.room.leave(ws);
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }

  webSocketError(ws: WebSocket): void {
    this.room.leave(ws);
  }
}

class SqlRoomStorage implements RoomStorage {
  private last: number | undefined;

  constructor(private sql: SqlStorage) {}

  /** -1 when unset */
  meta(k: string): number {
    const r = this.sql.exec<{ v: number }>(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0];
    return r ? r.v : -1;
  }

  setMeta(k: string, v: number): void {
    this.sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, k, v);
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
    return Math.max(this.meta("base"), 0) + 1;
  }

  append(f: ChangesDown): void {
    this.sql.exec(`INSERT INTO frames (seq, session, batch, message) VALUES (?, ?, ?, ?)`, f.seq, f.sessionID, f.batch, f.message.slice().buffer);
    this.last = f.seq;
  }

  *readAfter(since: number): Iterable<ChangesDown> {
    for (const r of this.sql.exec<{ seq: number; session: number; batch: number; message: ArrayBuffer }>(`SELECT seq, session, batch, message FROM frames WHERE seq > ? ORDER BY seq`, since)) {
      yield { seq: r.seq, sessionID: r.session, batch: r.batch, message: new Uint8Array(r.message) };
    }
  }

  /** The snapshot at `seq` replaces the frames up to it. */
  compact(seq: number): void {
    const last = this.lastSeq();
    this.sql.exec(`DELETE FROM frames WHERE seq <= ?`, seq);
    this.setMeta("base", seq);
    this.last = Math.max(last, seq);
  }
}
