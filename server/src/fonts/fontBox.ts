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
 */
import type { SqlLike } from "../previews";
import { concat, sha1Hex } from "../libraries/libraryBox";
import { ICON_BAD_TYPE, ICON_TOO_LARGE, MAX_ICON_BYTES, iconType } from "../org/iconImage";

const CHUNK = 1024 * 1024;
/** As your uploaded fonts (desktop.md §14.2) */
export const MAX_FONT_BYTES = 50 * 1024 * 1024;

export interface FontBoxHost {
  sql: SqlLike;
  transaction(fn: () => void): void;
  deleteAll(): Promise<void>;
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
  constructor(private host: FontBoxHost) {}

  private ensure(): void {
    this.host.sql.exec(`CREATE TABLE IF NOT EXISTS fonts (sha1 TEXT NOT NULL, idx INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (sha1, idx))`);
    this.host.sql.exec(`CREATE TABLE IF NOT EXISTS images (sha1 TEXT PRIMARY KEY, type TEXT NOT NULL, bytes BLOB NOT NULL)`);
  }

  async fetch(req: Request): Promise<Response> {
    this.ensure();
    const path = new URL(req.url).pathname;
    const m = req.method;
    if (path === "/delete" && m === "POST") {
      await this.host.deleteAll();
      return json({ ok: true });
    }
    if (path === "/font" && m === "PUT") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length > MAX_FONT_BYTES) return json({ error: "the font file is larger than 50 MB", code: "too_large" }, 413);
      const format = fontFormat(bytes);
      if (!format) return json({ error: "only .ttf and .otf fonts can be uploaded", code: "invalid" }, 400);
      const sha1 = await sha1Hex(bytes);
      const had = this.host.sql.exec(`SELECT 1 FROM fonts WHERE sha1 = ? AND idx = 0`, sha1).toArray().length > 0;
      if (!had) {
        this.host.transaction(() => {
          for (let i = 0, idx = 0; i < bytes.length; i += CHUNK, idx++) this.host.sql.exec(`INSERT INTO fonts (sha1, idx, bytes) VALUES (?, ?, ?)`, sha1, idx, bytes.slice(i, i + CHUNK).buffer);
        });
      }
      return json({ sha1, format, size: bytes.length });
    }
    if (path === "/image" && m === "PUT") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length > MAX_ICON_BYTES) return json({ error: ICON_TOO_LARGE, code: "too_large" }, 413);
      const type = iconType(bytes);
      if (!type) return json({ error: ICON_BAD_TYPE, code: "invalid" }, 400);
      const sha1 = await sha1Hex(bytes);
      this.host.sql.exec(`INSERT OR IGNORE INTO images (sha1, type, bytes) VALUES (?, ?, ?)`, sha1, type, bytes.slice().buffer);
      return json({ sha1, type, size: bytes.length });
    }
    const image = /^\/image\/([0-9a-f]{40})$/.exec(path);
    if (image && m === "GET") {
      const row = this.host.sql.exec<{ type: string; bytes: ArrayBuffer }>(`SELECT type, bytes FROM images WHERE sha1 = ?`, image[1]).toArray()[0];
      if (!row) return json({ error: "not found", code: "not_found" }, 404);
      return new Response(new Uint8Array(row.bytes), { headers: { "content-type": row.type } });
    }
    if (image && m === "DELETE") {
      this.host.sql.exec(`DELETE FROM images WHERE sha1 = ?`, image[1]);
      return new Response(null, { status: 204 });
    }
    const one = /^\/font\/([0-9a-f]{40})$/.exec(path);
    if (one && m === "GET") {
      const rows = this.host.sql.exec<{ bytes: ArrayBuffer }>(`SELECT bytes FROM fonts WHERE sha1 = ? ORDER BY idx`, one[1]).toArray();
      if (!rows.length) return json({ error: "not found", code: "not_found" }, 404);
      return new Response(concat(rows.map((r) => new Uint8Array(r.bytes))), { headers: { "content-type": "application/octet-stream" } });
    }
    if (one && m === "DELETE") {
      this.host.sql.exec(`DELETE FROM fonts WHERE sha1 = ?`, one[1]);
      return new Response(null, { status: 204 });
    }
    return json({ error: "not found", code: "not_found" }, 404);
  }
}
