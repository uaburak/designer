/**
 * Key management in a file's room (docs/governance.md §2.10): what `FileRoom` adds over its `RoomBox` and `RestJobs`,
 * pure enough for Node's tests.
 *
 *   wake / every EKM_RECHECK_MS   `check()`: the org's key from D1, unwrapped (roomKey.ts); with a key, the room's rows
 *                                  still plain are sealed (`RoomBox.encryptAll`) and `files.encrypted_at` set the first
 *                                  time (`fig_file_encrypt`)
 *   any call but the keyless ones  503 `{code: "key_unavailable"}` while the key can't be unwrapped; sockets are refused
 *                                  the same way and open ones closed (4003, after `{t: "error", code: "key_unavailable"}`)
 *   POST /room/ekm/encrypt         `encrypt-next`'s call: the key read again and every plain row sealed → `{ok, sealed}`;
 *                                  409 `ekm_off` when the org has no key
 *   /room/rest-blob, /room/thumbnail  `rest_blobs` (rest/roomJobs.ts) read opened, and sealed after RestJobs stored them
 *
 * Keyless calls are those that never read sealed bytes: a region move's freeze / dump / load / unfreeze and the room's
 * deletion copy rows as stored, and notices carry no content — so a move works even while the key is unavailable.
 */
import type { SqlLike } from "../previews";
import type { RoomBox } from "../roomBox";
import { SealError } from "./cipher";
import { RoomKey, type RoomKeyHost, type RoomKeyState } from "./roomKey";
import { openJoined, sealWhere } from "./rows";

export const KEY_UNAVAILABLE = { error: "this file's encryption key is unavailable", code: "key_unavailable" } as const;

const KEYLESS = new Set([
  "GET /room/dump",
  "POST /room/load",
  "POST /room/freeze",
  "POST /room/unfreeze",
  "DELETE /room",
  "POST /room/reauth",
  "POST /room/revoke",
  "POST /room/revoke-link",
  "POST /room/notice",
  "POST /room/comments",
  "POST /room/broadcast",
  "POST /room/policy",
]);

export interface RoomEkmHost extends Omit<RoomKeyHost, "sealedBefore"> {
  box(): RoomBox;
  sql: SqlLike;
  /** The key just became unavailable: close every socket (4003 after the error) */
  refuseSockets(): void;
}

export const keyUnavailable = (): Response => Response.json(KEY_UNAVAILABLE, { status: 503 });

export class RoomEkm {
  readonly key: RoomKey;

  constructor(private host: RoomEkmHost) {
    this.key = new RoomKey({ ...host, d1: host.d1, sealedBefore: () => host.box().encrypted() });
  }

  /** The key (when due, or `reload`) and, with one, the room's plain rows sealed. Never throws. */
  async check(reload = false): Promise<RoomKeyState> {
    const was = this.key.state;
    const state = reload ? await this.key.load() : await this.key.ready();
    // Not while a move copies the rows out (the copy seals what came plain, roomBox.ts POST /room/load)
    if (state === "ok" && !this.host.box().moving()) {
      try {
        const { first } = await this.host.box().encryptAll();
        const file = this.host.fileKey();
        if (first && file) await this.key.markEncrypted(file);
      } catch (e) {
        console.error("ekm: the room's rows weren't sealed", e);
      }
    }
    if (state === "unavailable" && was !== "unavailable") this.host.refuseSockets();
    return state;
  }

  /** The gate in front of every call: null to go on, else the answer */
  async gate(method: string, path: string): Promise<Response | null> {
    if (KEYLESS.has(`${method} ${path}`)) return null;
    if ((await this.check()) === "unavailable") return keyUnavailable();
    return null;
  }

  /** POST /room/ekm/encrypt; null for other paths */
  async route(method: string, path: string): Promise<Response | null> {
    if (path !== "/room/ekm/encrypt" || method !== "POST") return null;
    if (this.host.box().moving()) return Response.json({ error: "this file is moving to another region; try again in a moment", code: "moving" }, { status: 503 });
    const state = await this.key.load();
    if (state === "none") return Response.json({ error: "key management is off for this file's organization", code: "ekm_off" }, { status: 409 });
    if (state === "unavailable") return keyUnavailable();
    const { sealed } = await this.host.box().encryptAll(true);
    return Response.json({ ok: true, sealed });
  }

  /**
   * The REST tables' bytes: GET /room/rest-blob/:sha1 and GET /room/thumbnail are read here, opened; a part or a
   * thumbnail RestJobs stored is sealed right after. `rest` handles everything else.
   */
  async rest(req: Request, url: URL, rest: { fetch(req: Request): Promise<Response | null> }): Promise<Response | null> {
    const { sql } = this.host;
    const cipher = this.key.cipher;
    const m = req.method;
    try {
      const blob = /^\/room\/rest-blob\/([0-9a-f]{40})$/.exec(url.pathname);
      if (blob && m === "GET") {
        let rows = sql.exec<{ bytes: ArrayBuffer }>(`SELECT bytes FROM rest_blobs WHERE sha1 = ? ORDER BY idx`, blob[1]).toArray();
        if (!rows.length) rows = sql.exec<{ bytes: ArrayBuffer }>(`SELECT bytes FROM blobs WHERE sha1 = ? ORDER BY idx`, blob[1]).toArray();
        if (!rows.length) return new Response("no such blob", { status: 404 });
        return new Response(await openJoined(cipher, rows), { headers: { "content-type": "application/octet-stream" } });
      }
      if (url.pathname === "/room/thumbnail" && m === "GET") {
        const t = sql.exec<{ parts: string }>(`SELECT parts FROM rest_cache WHERE job_key = 'thumbnail'`).toArray()[0];
        const sha1 = t ? (JSON.parse(t.parts) as { sha1: string }[])[0]?.sha1 : undefined;
        if (!sha1) return new Response("no thumbnail", { status: 404 });
        const rows = sql.exec<{ bytes: ArrayBuffer }>(`SELECT bytes FROM rest_blobs WHERE sha1 = ? ORDER BY idx`, sha1).toArray();
        return new Response(await openJoined(cipher, rows), { headers: { "content-type": "image/png", "x-sha1": sha1 } });
      }
    } catch (e) {
      if (e instanceof SealError) return keyUnavailable();
      throw e;
    }
    const res = await rest.fetch(req);
    if (res?.ok && m === "PUT" && cipher.enabled && (url.pathname === "/room/thumbnail" || url.pathname.startsWith("/room/rest-parts/"))) {
      const { sha1 } = (await res.clone().json().catch(() => ({}))) as { sha1?: unknown };
      if (typeof sha1 === "string") await sealWhere(sql, cipher, "rest_blobs", "sha1 = ?", sha1);
    }
    return res;
  }
}
