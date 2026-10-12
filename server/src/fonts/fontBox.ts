/**
 * One organization's font files (docs/desktop.md §14.3): the logic of the `FontObject` Durable Object over its SQLite
 * storage, content-addressed by SHA-1 in 1 MB rows. The Worker (fonts/routes.ts) has checked the caller.
 *
 *   PUT    /font        the file's bytes → {sha1, format, size} (magic checked: 0x00010000, "true" or "OTTO";
 *                       collections refused); the SHA-1 is computed here, not in the Worker (its 10 ms CPU)
 *   GET    /font/:sha1  → bytes
 *   DELETE /font/:sha1  the bytes (no D1 row uses them any more)
 *   POST   /delete      everything (the org was deleted)
 *
 * And the org's icons (docs/multiplayer.md §14.16: the organization icon and its teams' icons), one row each:
 *
 *   PUT    /image        the bytes (≤ 1 MB, PNG / JPEG / WebP / GIF by magic) → {sha1, type, size}
 *   GET    /image/:sha1  → the bytes with their type
 *   DELETE /image/:sha1  (no org or team row uses them any more)
 *
 * On R2 (docs/cloud.md §1, storage/boxObjects.ts): with the env's buckets, fonts are `f/<orgId>/<sha1>` and icons
 * `i/<orgId>/<sha1>` in the default bucket (fonts and icons aren't localized: docs/multiplayer.md §15.10 covers file
 * content); an icon keeps its `images` row (its type) with no bytes. Older rows stay readable; one is moved per wake.
 */
import type { SqlLike } from "../previews";
import { sha1Hex } from "../libraries/libraryBox";
import { ICON_BAD_TYPE, ICON_TOO_LARGE, MAX_ICON_BYTES, iconType } from "../org/iconImage";
import { BoxObjects, boxObjectsHost, type ChunkTable } from "../storage/boxObjects";
import type { StorageEnv } from "../storage/objects";

/** As your uploaded fonts (desktop.md §14.2) */
export const MAX_FONT_BYTES = 50 * 1024 * 1024;

export interface FontBoxHost {
  sql: SqlLike;
  transaction(fn: () => void): void;
  deleteAll(): Promise<void>;
  /** R2: the env's buckets and the org's id (the object's name); absent: rows only */
  env?: StorageEnv;
  name?(): string | null;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** "ttf" / "otf" from the file's first four bytes; null for anything else (collections, web fonts) */
export function fontFormat(bytes: Uint8Array): "ttf" | "otf" | null {
  if (bytes.length < 12) return null;
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  if (tag === "OTTO") return "otf";
  if (tag === "true" || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) return "ttf";
  return null;
}

export class FontBox {
  readonly objects: BoxObjects;
  private fonts: ChunkTable;
  private stepped = false;

  constructor(private host: FontBoxHost) {
    const org = () => host.name?.() ?? null;
    this.fonts = { table: "fonts", cols: ["sha1"], name: ([s]) => `f/${org()}/${s}` };
    // Keys are whole names (`f/<org>/…`, `i/<org>/…`): the prefix is empty once the org is known
    this.objects = new BoxObjects(host.sql, (fn) => host.transaction(fn), host.env ? boxObjectsHost(host.env, () => "default", () => (org() ? "" : null)) : undefined);
  }

  private imageName(sha1: string): string {
    return `i/${this.host.name?.()}/${sha1}`;
  }

  private ensure(): void {
    this.host.sql.exec(`CREATE TABLE IF NOT EXISTS fonts (sha1 TEXT NOT NULL, idx INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (sha1, idx))`);
    this.host.sql.exec(`CREATE TABLE IF NOT EXISTS images (sha1 TEXT PRIMARY KEY, type TEXT NOT NULL, bytes BLOB NOT NULL)`);
    this.objects.ensure();
  }

  async fetch(req: Request): Promise<Response> {
    this.ensure();
    try {
      return await this.route(req);
    } finally {
      await this.objects.flush();
    }
  }

  /** One old font or icon moved from rows to R2 → whether anything is left */
  async step(): Promise<{ done: boolean; enabled: boolean; moved: number }> {
    if (!this.objects.enabled()) return { done: false, enabled: false, moved: 0 };
    const icon = this.host.sql.exec<{ sha1: string; bytes: ArrayBuffer }>(`SELECT sha1, bytes FROM images WHERE LENGTH(bytes) > 0 LIMIT 1`).toArray()[0];
    if (icon) {
      const bytes = new Uint8Array(icon.bytes);
      await this.objects.putObject(this.imageName(icon.sha1), bytes, () => this.host.sql.exec(`UPDATE images SET bytes = X'' WHERE sha1 = ?`, icon.sha1));
      return { done: false, enabled: true, moved: bytes.length };
    }
    return this.objects.step([this.fonts]);
  }

  private async route(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const m = req.method;
    if (!this.stepped && path !== "/delete" && path !== "/storage/migrate") {
      this.stepped = true;
      void this.step().catch((e) => console.error("r2: the fonts' migration step failed", e));
    }
    if (path === "/delete" && m === "POST") {
      await this.objects.dropAll();
      await this.host.deleteAll();
      return json({ ok: true });
    }
    if (path === "/storage/migrate" && m === "POST") {
      let moved = 0;
      for (let i = 0; i < 256; i++) {
        const r = await this.step();
        moved += r.moved;
        if (r.done || !r.enabled) return json({ ...r, moved });
      }
      return json({ done: false, enabled: true, moved });
    }
    if (path === "/font" && m === "PUT") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length > MAX_FONT_BYTES) return json({ error: "the font file is larger than 50 MB", code: "too_large" }, 413);
      const format = fontFormat(bytes);
      if (!format) return json({ error: "only .ttf and .otf fonts can be uploaded", code: "invalid" }, 400);
      const sha1 = await sha1Hex(bytes);
      if (!this.objects.has(this.fonts, [sha1])) await this.objects.put(this.fonts, [sha1], bytes);
      return json({ sha1, format, size: bytes.length });
    }
    if (path === "/image" && m === "PUT") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length > MAX_ICON_BYTES) return json({ error: ICON_TOO_LARGE, code: "too_large" }, 413);
      const type = iconType(bytes);
      if (!type) return json({ error: ICON_BAD_TYPE, code: "invalid" }, 400);
      const sha1 = await sha1Hex(bytes);
      const had = this.host.sql.exec(`SELECT 1 AS x FROM images WHERE sha1 = ?`, sha1).toArray().length > 0;
      if (!had && !(await this.objects.putObject(this.imageName(sha1), bytes, () => this.host.sql.exec(`INSERT OR REPLACE INTO images (sha1, type, bytes) VALUES (?, ?, X'')`, sha1, type)))) {
        this.host.sql.exec(`INSERT OR IGNORE INTO images (sha1, type, bytes) VALUES (?, ?, ?)`, sha1, type, bytes.slice().buffer);
      }
      return json({ sha1, type, size: bytes.length });
    }
    const image = /^\/image\/([0-9a-f]{40})$/.exec(path);
    if (image && m === "GET") {
      const row = this.host.sql.exec<{ type: string; bytes: ArrayBuffer }>(`SELECT type, bytes FROM images WHERE sha1 = ?`, image[1]).toArray()[0];
      if (!row) return json({ error: "not found", code: "not_found" }, 404);
      if (!row.bytes.byteLength) return this.objects.objectResponse(this.imageName(image[1]), { "content-type": row.type }) ?? json({ error: "not found", code: "not_found" }, 404);
      return new Response(new Uint8Array(row.bytes), { headers: { "content-type": row.type } });
    }
    if (image && m === "DELETE") {
      this.host.transaction(() => {
        this.host.sql.exec(`DELETE FROM images WHERE sha1 = ?`, image[1]);
        this.objects.removeObject(this.imageName(image[1]));
      });
      return new Response(null, { status: 204 });
    }
    const one = /^\/font\/([0-9a-f]{40})$/.exec(path);
    if (one && m === "GET") {
      return this.objects.response(this.fonts, [one[1]], { "content-type": "application/octet-stream" }) ?? json({ error: "not found", code: "not_found" }, 404);
    }
    if (one && m === "DELETE") {
      this.host.transaction(() => this.objects.remove(this.fonts, [one[1]]));
      return new Response(null, { status: 204 });
    }
    return json({ error: "not found", code: "not_found" }, 404);
  }
}
