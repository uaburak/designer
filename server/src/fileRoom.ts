/**
 * One shared file's Durable Object (docs/multiplayer.md §4): the pure `Room` on SQLite storage, with hibernatable
 * WebSockets — each socket's member state rides in its serialized attachment, so an object woken by a message rebuilds
 * its members without anyone reconnecting. Reached only through the Worker, which has already resolved the caller's
 * identity and role (headers `x-user-id`, `x-user-name`, `x-role`).
 */
import { DurableObject } from "cloudflare:workers";
import { type Role } from "../../src/shared/multiplayer/protocol";
import { Room, type MemberState } from "../../src/shared/multiplayer/room";
import type { SqlLike } from "./previews";
import { RoomBox } from "./roomBox";

export { MAX_BLOB_BYTES } from "./roomBox";
/** Close codes the client reads: 4001 the file stopped being shared, 4003 access changed, 4009 a snapshot replaced history. */
export const CLOSE_UNSHARED = 4001;
export const CLOSE_ACCESS = 4003;

export class FileRoom extends DurableObject {
  private box: RoomBox;
  private room: Room;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Snapshot, frames, images, the branch base, versions and autosave (roomBox.ts); the sockets are this object's.
    this.box = new RoomBox({
      sql: ctx.storage.sql as unknown as SqlLike,
      transaction: (fn) => ctx.storage.transactionSync(fn),
      now: () => Date.now(),
      setAlarm: (at) => void (at === null ? ctx.storage.deleteAlarm() : ctx.storage.setAlarm(at)),
      broadcast: (frame) => {
        for (const ws of ctx.getWebSockets()) if ((ws.deserializeAttachment() as MemberState | null)?.sessionID) ws.send(frame);
      },
      hasSession: (userId, sessionID) =>
        ctx.getWebSockets().some((ws) => {
          const s = ws.deserializeAttachment() as MemberState | null;
          return s?.userId === userId && s.sessionID === sessionID;
        }),
    });
    this.room = new Room(this.box.storage, (ws, state) => (ws as WebSocket).serializeAttachment(state));
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
      case "POST /room/notice": {
        this.room.notice((await req.json()) as Parameters<Room["notice"]>[0]);
        return Response.json({ ok: true });
      }
      case "POST /room/comments": {
        // Comments changed (server/src/comments.ts): everyone in the file reads them again.
        const { threadId, by } = (await req.json()) as { threadId: string; by: string };
        const text = JSON.stringify({ t: "comments", threadId, by });
        for (const ws of this.ctx.getWebSockets()) if ((ws.deserializeAttachment() as MemberState | null)?.sessionID) ws.send(text);
        return Response.json({ ok: true });
      }
      case "POST /room/revoke-link": {
        // Everyone not owner / member reconnects: those in only by the link are refused or come back as viewers.
        for (const ws of this.ctx.getWebSockets()) {
          const s = ws.deserializeAttachment() as MemberState | null;
          if (s && s.role !== "owner") this.room.closeUser(s.userId, CLOSE_ACCESS, "access changed");
        }
        return Response.json({ ok: true });
      }
      case "POST /room/revoke": {
        const { userId } = (await req.json()) as { userId: string };
        this.room.closeUser(userId, CLOSE_ACCESS, "access changed");
        return Response.json({ ok: true });
      }
      case "POST /room/reauth": {
        // Access may have gone down (docs/multiplayer.md §14.9): those users (everyone, when absent) reconnect and the
        // Worker resolves their role again. A room with nobody in it wakes, finds no one and sleeps.
        const body = (await req.json().catch(() => ({}))) as { userIds?: unknown };
        const ids = Array.isArray(body.userIds) ? body.userIds.filter((u): u is string => typeof u === "string") : null;
        if (ids) for (const id of ids) this.room.closeUser(id, CLOSE_ACCESS, "access changed");
        else this.room.closeAll(CLOSE_ACCESS, "access changed");
        return Response.json({ ok: true });
      }
      case "DELETE /room": {
        this.room.closeAll(CLOSE_UNSHARED, "file no longer shared");
        await this.ctx.storage.deleteAll();
        this.box.reset();
        return Response.json({ ok: true });
      }
    }
    return (await this.box.fetch(req)) ?? new Response("not found", { status: 404 });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string" && this.box.frozen()) {
      // A merged branch (or one being merged) takes no more frames: the client reconnects and is told its role.
      ws.send(JSON.stringify({ t: "error", code: "forbidden", message: "this branch was merged" }));
      ws.close(CLOSE_ACCESS, "access changed");
      return;
    }
    const before = this.box.storage.lastSeq();
    this.room.receive(ws, typeof message === "string" ? message : new Uint8Array(message));
    if (this.box.storage.lastSeq() > before) this.box.edited();
  }

  /** Autosave (docs/data.md §6: 30 minutes of edits) */
  alarm(): void {
    this.box.alarm();
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
