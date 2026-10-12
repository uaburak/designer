/**
 * One shared file's Durable Object (docs/multiplayer.md §4): the pure `Room` on SQLite storage, with hibernatable
 * WebSockets — each socket's member state rides in its serialized attachment, so an object woken by a message rebuilds
 * its members without anyone reconnecting. Reached only through the Worker, which has already resolved the caller's
 * identity and role (headers `x-user-id`, `x-user-name`, `x-role`) and the org's room policy (`x-policy`, §15.9).
 *
 * Moving to another region (docs/multiplayer.md §15.10): `POST /room/freeze {moving: true}` closes every socket with
 * 4012 (`CLOSE_MOVING`: clients reconnect after a moment, reaching the copy once the Worker flipped the file's
 * jurisdiction) and refuses new ones with 503 `{code: "moving"}` until the object is deleted.
 *
 * REST (docs/multiplayer.md §16.6, §16.10): render jobs, their parts and the thumbnail are `RestJobs`' (rest/roomJobs.ts);
 * `{t: "rest-wanted"}` goes to inboxes through `INBOXES`; FILE_UPDATE is emitted from the alarm with the object's own
 * D1 (`emitWebhook`), only when the file has a webhook that could want it (asked at wake, kept 5 minutes). The file's
 * key is the object's name (`ctx.id.name`, set by `idFromName`), else the one the Worker's REST calls carry (`?fileKey=`).
 *
 * Key management (docs/governance.md §2.10, ekm/room.ts): on every wake the object reads its org's key from D1 and
 * unwraps it before any event (`blockConcurrencyWhile`), seals the rows still plain, and checks again every hour.
 * While the key can't be unwrapped, calls answer 503 `key_unavailable` and sockets are refused.
 */
import { DurableObject } from "cloudflare:workers";
import { CLOSE_MOVING, type Role } from "../../src/shared/multiplayer/protocol";
import { Room, type MemberState } from "../../src/shared/multiplayer/room";
import type { SqlLike } from "./previews";
import { RoomBox } from "./roomBox";
import { parseRoomPolicy } from "./policy/roomPolicy";
import { RestJobs } from "./rest/roomJobs";
import { Db } from "./db";
import { BROADCAST_KINDS } from "./roomBroadcast";
import { RoomEkm, KEY_UNAVAILABLE } from "./ekm/room";
import { discoveryAlarm, discoveryTake, forgetDiscoveryRoom, type DiscoveryRoom } from "./discovery/record";

export { MAX_BLOB_BYTES } from "./roomBox";
/** Close codes the client reads: 4001 the file stopped being shared, 4003 access changed, 4009 a snapshot replaced history. */
export const CLOSE_UNSHARED = 4001;
export const CLOSE_ACCESS = 4003;

interface RoomEnv {
  DB?: D1Database;
  INBOXES?: DurableObjectNamespace;
  SESSION_SECRET?: string;
  /** Key management's root key (32 bytes, base64; `wrangler secret put EKM_ROOT_KEY`) */
  EKM_ROOT_KEY?: string;
}

/** How long the room trusts its answer to "does this file have a webhook?" (§16.10) */
const HOOKS_TTL_MS = 5 * 60_000;

export class FileRoom extends DurableObject {
  private box: RoomBox;
  private room: Room;
  private rest: RestJobs;
  private discovery: DiscoveryRoom;
  private hooks: { at: number; has: boolean } | null = null;
  private fileKey: string | null;
  private ekm: RoomEkm;

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
      cipher: () => this.ekm.key.cipher,
    });
    this.fileKey = ctx.id.name ?? null;
    this.ekm = new RoomEkm({
      d1: (env as RoomEnv).DB as never,
      sql: ctx.storage.sql as unknown as SqlLike,
      rootKey: () => (env as RoomEnv).EKM_ROOT_KEY,
      now: () => Date.now(),
      fileKey: () => this.fileKey,
      box: () => this.box,
      refuseSockets: () => this.refuseSockets(),
    });
    this.room = new Room(this.box.storage, (ws, state) => (ws as WebSocket).serializeAttachment(state), {
      onRest: (conn, member, answer) => this.rest.answer(conn, member, answer),
      onRenderer: () => this.rest.renderer(),
    });
    this.rest = new RestJobs({
      sql: ctx.storage.sql as unknown as SqlLike,
      transaction: (fn) => ctx.storage.transactionSync(fn),
      now: () => Date.now(),
      room: this.room,
      lastSeq: () => this.box.storage.lastSeq(),
      hasVersion: (id) => this.box.versions().some((v) => v.id === id),
      wanted: async (userIds) => {
        const ns = (env as RoomEnv).INBOXES;
        if (!ns || !this.fileKey) return;
        const body = JSON.stringify({ t: "rest-wanted", fileKey: this.fileKey });
        await Promise.all(userIds.map((u) => ns.get(ns.idFromName(u)).fetch(new Request("https://inbox/inbox/notify", { method: "POST", body })).catch(() => undefined)));
      },
    });
    this.discovery = { fileKey: () => this.fileKey, sql: ctx.storage.sql as unknown as SqlLike, now: () => Date.now(), d1: (env as RoomEnv).DB ?? null, rest: this.rest };
    for (const ws of ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as MemberState | null;
      if (state) this.room.restore(ws, state);
    }
    // The org's key before any event (one D1 read per wake); the rows still plain are sealed then.
    void ctx.blockConcurrencyWhile(async () => void (await this.ekm.check()));
  }

  /** The key became unavailable: every member is told and closed (they reconnect into a 503). */
  private refuseSockets(): void {
    const text = JSON.stringify({ t: "error", code: KEY_UNAVAILABLE.code, message: KEY_UNAVAILABLE.error });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // already closed
      }
    }
    this.room.closeAll(CLOSE_ACCESS, "the encryption key is unavailable");
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const policy = parseRoomPolicy(req.headers.get("x-policy"));
    const identity = { userId: req.headers.get("x-user-id") ?? "", name: req.headers.get("x-user-name") || undefined, role: (req.headers.get("x-role") ?? "viewer") as Role, ...(policy ? { policy } : {}) };
    // The Worker names the file on every call (x-file-key, roomsOn) and on REST / encrypt-next (?fileKey=): the object's name when the runtime
    // doesn't give it. Learning it reads the org's key again.
    const named = url.searchParams.get("fileKey") ?? req.headers.get("x-file-key");
    if (!this.fileKey && named && /^[A-Za-z0-9_-]{6,64}$/.test(named)) {
      this.fileKey = named;
      await this.ekm.check(true);
    }
    const gated = (await this.ekm.gate(req.method, url.pathname)) ?? (await this.ekm.route(req.method, url.pathname));
    if (gated) return gated;
    if (url.pathname.startsWith("/room/rest") || url.pathname === "/room/thumbnail") {
      return (await this.ekm.rest(req, url, this.rest)) ?? new Response("not found", { status: 404 });
    }
    switch (`${req.method} ${url.pathname}`) {
      case "GET /room/ws": {
        if (!identity.userId) return new Response("no identity", { status: 400 });
        if (this.box.moving()) return Response.json({ error: "this file is moving to another region", code: "moving" }, { status: 503 });
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        this.room.connect(pair[1], identity);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      case "POST /room/broadcast": {
        // Non-stored notices (roomBroadcast.ts): dev resources, Code Connect changed — open copies read them again.
        const msg = (await req.json().catch(() => null)) as { t?: unknown } | null;
        if (!msg || !(BROADCAST_KINDS as readonly unknown[]).includes(msg.t)) return new Response("bad notice", { status: 400 });
        this.room.broadcastNotice(msg as { t: string });
        return Response.json({ ok: true });
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
      case "POST /room/policy": {
        // The org changed cursor chat or audio (§15.9): every member is told at once.
        const p = parseRoomPolicy(await req.text());
        if (!p) return new Response("bad policy", { status: 400 });
        this.room.setPolicy(p);
        return Response.json({ ok: true });
      }
      case "POST /room/freeze": {
        const res = await this.box.fetch(req);
        if (res?.ok && this.box.moving()) this.room.closeAll(CLOSE_MOVING, "moving to another region");
        return res ?? new Response("not found", { status: 404 });
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
        this.rest.reset();
        forgetDiscoveryRoom(this.discovery);
        return Response.json({ ok: true });
      }
    }
    return (await this.box.fetch(req)) ?? new Response("not found", { status: 404 });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (this.ekm.key.state === "unavailable") {
      try {
        ws.send(JSON.stringify({ t: "error", code: KEY_UNAVAILABLE.code, message: KEY_UNAVAILABLE.error }));
        ws.close(CLOSE_ACCESS, "the encryption key is unavailable");
      } catch {
        // already closed
      }
      return;
    }
    // The hourly re-check (frames are the plain journal: nothing waits for it)
    if (this.ekm.key.due()) void this.ekm.check();
    if (this.box.moving()) {
      ws.close(CLOSE_MOVING, "moving to another region");
      return;
    }
    if (typeof message !== "string" && this.box.frozen()) {
      // A merged branch (or one being merged) takes no more frames: the client reconnects and is told its role.
      ws.send(JSON.stringify({ t: "error", code: "forbidden", message: "this branch was merged" }));
      ws.close(CLOSE_ACCESS, "access changed");
      return;
    }
    const before = this.box.storage.lastSeq();
    this.room.receive(ws, typeof message === "string" ? message : new Uint8Array(message));
    if (this.box.storage.lastSeq() > before) this.box.edited(this.wantsFileUpdate());
    this.discover(); // after edited(), which sets the alarm
  }

  /** Discovery's capture (docs/governance.md §2.11): the last writer and cursor chat; the alarm moves earlier when due sooner */
  private discover(): void {
    const cap = this.room.drainDiscovery();
    if (cap) this.ctx.waitUntil(discoveryTake(this.discovery, cap).then((due) => this.armDiscovery(due)).catch((e) => console.error("discovery", e)));
  }

  private async armDiscovery(due: number | null): Promise<void> {
    if (due === null) return;
    const at = await this.ctx.storage.getAlarm();
    if (at === null || at > due) await this.ctx.storage.setAlarm(due);
  }

  /** Does the file have a webhook FILE_UPDATE could reach? Unknown → yes (the alarm asks D1 again). */
  private wantsFileUpdate(): boolean {
    const now = Date.now();
    if (!this.hooks || now - this.hooks.at > HOOKS_TTL_MS) {
      const db = (this.env as RoomEnv).DB;
      if (db && this.fileKey) {
        const at = now;
        void import("./webhooks/emit").then(({ fileHasWebhooks }) => fileHasWebhooks(new Db(db), this.fileKey!)).then((has) => void (this.hooks = { at, has }), () => undefined);
      }
      return this.hooks?.has ?? true;
    }
    return this.hooks.has;
  }

  /** Autosave (docs/data.md §6: 30 minutes of edits) and FILE_UPDATE (§16.10: 30 minutes after a burst of edits) */
  async alarm(): Promise<void> {
    // No autosave while the key is unavailable: the version's frames couldn't be sealed (the next edit sets the alarm again).
    if ((await this.ekm.check()) === "unavailable") return;
    const { fileUpdate } = this.box.alarm();
    await this.armDiscovery(await discoveryAlarm(this.discovery).catch((e) => (console.error("discovery", e), null)));
    await this.box.sealPending();
    const db = (this.env as RoomEnv).DB;
    if (!fileUpdate || !db || !this.fileKey) return;
    const { emitFileUpdate } = await import("./webhooks/emit");
    await emitFileUpdate(new Db(db), this.env as never, this.fileKey, (p) => this.ctx.waitUntil(p));
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.room.leave(ws);
    this.discover();
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }

  webSocketError(ws: WebSocket): void {
    this.room.leave(ws);
    this.discover();
  }
}
