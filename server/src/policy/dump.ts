/**
 * Copying a Durable Object's SQLite to another object (docs/multiplayer.md §15.10): Cloudflare can't relocate an
 * object, so moving a room or a library to another jurisdiction is a dump of the old object's tables in pages and a
 * load into the new one. Pure over `SqlLike`: `RoomBox` and `LibraryBox` serve it as `GET …/dump?after=` and
 * `POST …/load`.
 *
 * A page is `{rows: {table, row}[], cursor}` — every listed table in rowid order, blobs as `{$b64}` — at most
 * `PAGE_BYTES` of JSON (one row larger than that still goes, alone); `cursor` is null after the last row.
 */
import type { SqlLike } from "../previews";

/** A page's JSON stays under 4 MB (§15.10); a 1 MB chunk is ~1.4 MB as base64 */
export const PAGE_BYTES = 3 * 1024 * 1024;
const ROWS_PER_QUERY = 32;

export interface DumpRow {
  table: string;
  row: Record<string, unknown>;
}
export interface DumpPage {
  rows: DumpRow[];
  cursor: string | null;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

// By tag, not `instanceof`: SQLite drivers may hand back buffers of another realm.
const tag = (v: unknown) => Object.prototype.toString.call(v);
const encode = (v: unknown): unknown => {
  if (tag(v) === "[object ArrayBuffer]") return { $b64: toB64(new Uint8Array(v as ArrayBuffer)) };
  if (ArrayBuffer.isView(v) || tag(v) === "[object Uint8Array]") {
    const b = v as Uint8Array;
    return { $b64: toB64(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)) };
  }
  if (v !== null && typeof v === "object") throw new Error(`can't copy a ${tag(v)}`);
  return v;
};
const decode = (v: unknown): unknown => (v && typeof v === "object" && typeof (v as { $b64?: unknown }).$b64 === "string" ? fromB64((v as { $b64: string }).$b64) : v);

/** One page after `after` (`"<table index>:<last rowid sent>"`, null: from the start). `skip` leaves rows out (the freeze mark). */
export function dumpPage(sql: SqlLike, tables: readonly string[], after: string | null, skip: (table: string, row: Record<string, unknown>) => boolean = () => false): DumpPage {
  let [ti, rowid] = parseCursor(after);
  const rows: DumpRow[] = [];
  let size = 0;
  while (ti < tables.length) {
    const t = tables[ti];
    // rowid null: from the table's first row (an INTEGER PRIMARY KEY is the rowid, and may be 0 or negative)
    const batch = (rowid === null ? sql.exec<Record<string, unknown>>(`SELECT rowid AS __rowid, * FROM ${t} ORDER BY rowid LIMIT ${ROWS_PER_QUERY}`) : sql.exec<Record<string, unknown>>(`SELECT rowid AS __rowid, * FROM ${t} WHERE rowid > ? ORDER BY rowid LIMIT ${ROWS_PER_QUERY}`, rowid)).toArray();
    if (!batch.length) {
      ti++;
      rowid = null;
      continue;
    }
    for (const r of batch) {
      const { __rowid, ...cols } = r;
      const row = Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, encode(v)]));
      const n = JSON.stringify(row).length + t.length + 20;
      if (rows.length && size + n > PAGE_BYTES) return { rows, cursor: `${ti}:${rowid ?? ""}` };
      rowid = Number(__rowid);
      if (skip(t, cols)) continue;
      rows.push({ table: t, row });
      size += n;
    }
  }
  return { rows, cursor: null };
}

function parseCursor(c: string | null): [number, number | null] {
  // "<table>:" — that table from its first row
  const m = c ? /^(\d+):(-?\d+)?$/.exec(c) : null;
  return m ? [Number(m[1]), m[2] === undefined ? null : Number(m[2])] : [0, null];
}

/** A page into this object's tables (only those listed; column names checked), replacing rows with the same key */
export function loadPage(sql: SqlLike, tables: readonly string[], rows: unknown): number {
  if (!Array.isArray(rows)) throw new Error("rows");
  let n = 0;
  for (const r of rows as DumpRow[]) {
    if (!r || !tables.includes(r.table) || !r.row || typeof r.row !== "object") throw new Error(`bad row for ${String(r?.table)}`);
    const cols = Object.keys(r.row);
    if (!cols.length || !cols.every((c) => /^[a-z_][a-z0-9_]*$/.test(c))) throw new Error(`bad columns for ${r.table}`);
    sql.exec(`INSERT OR REPLACE INTO ${r.table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((c) => decode(r.row[c])));
    n++;
  }
  return n;
}
