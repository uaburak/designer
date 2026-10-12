/**
 * Sealed rows in a room's SQLite (docs/governance.md §2.10). The encrypted tables are Figma's checkpoints and media:
 * `snapshot`, `history_snapshots`, `history_frames`, `base_chunks`, `blobs` (roomBox.ts) and `rest_blobs`
 * (rest/roomJobs.ts). The live `frames` journal, `meta`, `versions` and the REST cache's index stay plain.
 *
 * Writes are sealed before the synchronous transaction that stores them (`sealChunks`); what a transaction copies in
 * plain (a version's frames) is sealed right after it (`sealWhere`). A sweep (`sealAll`) seals whatever is still plain —
 * a room's existing rows on the wake after its org turned key management on. Each UPDATE names the bytes it read, so a
 * row replaced while it was being sealed is left alone (the next sweep sees it).
 */
import type { SqlLike } from "../previews";
import { ENC_OVERHEAD, ENC_PREFIX_SQL, isSealed, type RoomCipher } from "./cipher";

/** Table → its bytes column */
export const SEALED_TABLES = [
  ["snapshot", "bytes"],
  ["blobs", "bytes"],
  ["base_chunks", "bytes"],
  ["history_snapshots", "bytes"],
  ["history_frames", "message"],
  ["rest_blobs", "bytes"],
] as const;
export type SealedTable = (typeof SEALED_TABLES)[number][0];

const COLUMN = Object.fromEntries(SEALED_TABLES) as Record<SealedTable, string>;

/** SQLite values hold 2 MB: plain rows are 1 MB, so a sealed one (+33 bytes) still fits. */
const CHUNK = 1024 * 1024;
/** Rows read per sweep query (each ≤ 1 MB) */
const SWEEP_ROWS = 8;

const u8 = (b: ArrayBuffer | Uint8Array): Uint8Array => (b instanceof Uint8Array ? b : new Uint8Array(b));
const buf = (b: Uint8Array): ArrayBuffer => (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? (b.buffer as ArrayBuffer) : (b.slice().buffer as ArrayBuffer));

/** `bytes` in 1 MB rows, each sealed (as they are when the cipher is off); at least one row */
export async function sealChunks(cipher: RoomCipher, bytes: Uint8Array): Promise<ArrayBuffer[]> {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < bytes.length || i === 0; i += CHUNK) parts.push(bytes.slice(i, i + CHUNK));
  if (!cipher.enabled) return parts.map(buf);
  return Promise.all(parts.map(async (p) => buf(await cipher.seal(p))));
}

/** One row's bytes as stored (sealed when the cipher is on) */
export async function sealOne(cipher: RoomCipher, bytes: Uint8Array): Promise<ArrayBuffer> {
  return buf(cipher.enabled ? await cipher.seal(bytes) : bytes.slice());
}

/** Rows' bytes opened and joined, in order */
export async function openJoined(cipher: RoomCipher, rows: { bytes: ArrayBuffer }[]): Promise<Uint8Array> {
  const parts = await Promise.all(rows.map((r) => cipher.open(u8(r.bytes))));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The plain size of a stored row (sealing adds ENC_OVERHEAD) */
export const plainLength = (bytes: Uint8Array): number => (isSealed(bytes) ? bytes.length - ENC_OVERHEAD : bytes.length);

/** SQL: the plain size of a bytes column, summed */
export const plainSizeSql = (col: string) => `SUM(LENGTH(${col}) - CASE WHEN substr(${col}, 1, 5) = ${ENC_PREFIX_SQL} THEN ${ENC_OVERHEAD} ELSE 0 END)`;

const hasTable = (sql: SqlLike, t: string) => sql.exec(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`, t).toArray().length > 0;

/**
 * Seals the plain rows of `table` matching `where` (rowid order, a few at a time). Returns how many it sealed.
 * `where` is SQL over the table's columns with `?` binds.
 */
export async function sealWhere(sql: SqlLike, cipher: RoomCipher, table: SealedTable, where = "1", ...binds: unknown[]): Promise<number> {
  if (!cipher.enabled || !hasTable(sql, table)) return 0;
  const col = COLUMN[table];
  let after = Number.MIN_SAFE_INTEGER;
  let n = 0;
  for (;;) {
    const rows = sql.exec<{ r: number; b: ArrayBuffer }>(`SELECT rowid AS r, ${col} AS b FROM ${table} WHERE rowid > ? AND (${where}) AND substr(${col}, 1, 5) IS NOT ${ENC_PREFIX_SQL} ORDER BY rowid LIMIT ${SWEEP_ROWS}`, after, ...binds).toArray();
    if (!rows.length) return n;
    for (const row of rows) {
      after = row.r;
      const plain = u8(row.b);
      if (isSealed(plain)) continue;
      const sealed = await cipher.seal(plain);
      sql.exec(`UPDATE ${table} SET ${col} = ? WHERE rowid = ? AND ${col} = ?`, buf(sealed), row.r, row.b);
      n++;
    }
  }
}

/** "DV2E" | 1 as base64: the first 6 characters, then one of E–H (the IV's first bits) */
const SEALED_B64 = /^RFYyRQ[EFGH]/;

/**
 * Does a region move's page (policy/dump.ts rows, bytes as `{$b64}`) carry plain rows of the encrypted tables? Read from
 * the base64 text, nothing decoded: the copy then seals them on its next check (meta `ekmDirty`).
 */
export function pageHasPlain(rows: unknown): boolean {
  if (!Array.isArray(rows)) return false;
  for (const r of rows as { table?: unknown; row?: Record<string, unknown> }[]) {
    const col = COLUMN[r?.table as SealedTable];
    if (!col || !r.row) continue;
    const v = r.row[col] as { $b64?: unknown } | null;
    if (v && typeof v.$b64 === "string" && !SEALED_B64.test(v.$b64)) return true;
  }
  return false;
}

/** Every encrypted table's plain rows sealed; how many */
export async function sealAll(sql: SqlLike, cipher: RoomCipher): Promise<number> {
  let n = 0;
  for (const [t] of SEALED_TABLES) n += await sealWhere(sql, cipher, t);
  return n;
}
