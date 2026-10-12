/**
 * Key management's row cipher (docs/governance.md §2.10): AES-256-GCM per stored row under the org's DEK —
 * `"DV2E" | version | iv(12) | ciphertext + tag(16)`. Version 2 (every new seal) authenticates the 5-byte header **and**
 * `fileKey|table` as associated data, so a sealed row can't be moved to another file's room or another table and still
 * open; version 1 (the header alone) stays readable. Rows without a header read as plain, so a room's existing rows
 * encrypt gradually (on its next wake or by `encrypt-next`). WebCrypto only: the DEK is imported once per wake
 * (roomKey.ts) and every row has its own random IV — no per-row derivation.
 *
 * "table" is the table's AAD name: `snapshot` and `history_snapshots` share one (a version keeps the current snapshot's
 * rows as stored, roomBox.ts `take`).
 */
import { ENC_HEADER_BYTES, ENC_MAGIC, ENC_VERSION } from "../../../src/shared/org/governance";

/** The tables whose rows are sealed (rows.ts SEALED_TABLES) */
export type SealedTable = "snapshot" | "blobs" | "base_chunks" | "history_snapshots" | "history_frames" | "rest_blobs";

export interface RoomCipher {
  readonly enabled: boolean;
  seal(plain: Uint8Array, table: SealedTable): Promise<Uint8Array>;
  open(stored: Uint8Array, table: SealedTable): Promise<Uint8Array>;
}

export const PLAIN_CIPHER: RoomCipher = {
  enabled: false,
  seal: async (p) => p,
  open: async (s) => s,
};

const MAGIC = new TextEncoder().encode(ENC_MAGIC);
const prefix = (version: number) => new Uint8Array([...MAGIC, version]);
/** "DV2E" | 2 — what a row sealed now starts with */
export const ENC_PREFIX = prefix(ENC_VERSION);
/** "DV2E" | 1 — rows sealed before the file and table were bound (still read) */
export const ENC_PREFIX_V1 = prefix(1);
const hexOf = (b: Uint8Array) => `X'${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}'`;
/** The prefixes as SQLite blob literals, for `substr(col, 1, 5) NOT IN (…)` sweeps */
export const ENC_PREFIXES_SQL = `(${hexOf(ENC_PREFIX_V1)}, ${hexOf(ENC_PREFIX)})`;
/** What sealing adds to a row: the header and GCM's tag */
export const ENC_OVERHEAD = ENC_HEADER_BYTES + 16;

/** The header's version (1 or 2), or 0 when the row has none */
function versionOf(bytes: Uint8Array): number {
  if (bytes.length < ENC_OVERHEAD) return 0;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return 0;
  const v = bytes[MAGIC.length];
  return v === 1 || v === ENC_VERSION ? v : 0;
}

/** Does a stored row carry a header? */
export function isSealed(bytes: Uint8Array): boolean {
  return versionOf(bytes) !== 0;
}

/** CryptoKey, named so both Node's and Workers' typings accept it (as tokens.ts) */
export type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** A row's bytes could not be opened (a wrong DEK, or a damaged row) */
export class SealError extends Error {}

/** The AAD name of a table */
const aadTable = (t: SealedTable): string => (t === "history_snapshots" ? "snapshot" : t);

/** The cipher over an imported AES-GCM key (`encrypt` + `decrypt` usages), for one file's rows */
export function aesCipher(key: Key, fileKey: string): RoomCipher {
  const aad = (table: SealedTable) => {
    const tail = new TextEncoder().encode(`${fileKey}|${aadTable(table)}`);
    const out = new Uint8Array(ENC_PREFIX.length + tail.length);
    out.set(ENC_PREFIX, 0);
    out.set(tail, ENC_PREFIX.length);
    return out;
  };
  return {
    enabled: true,
    async seal(plain, table) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(table) }, key, plain));
      const out = new Uint8Array(ENC_HEADER_BYTES + ct.length);
      out.set(ENC_PREFIX, 0);
      out.set(iv, ENC_PREFIX.length);
      out.set(ct, ENC_HEADER_BYTES);
      return out;
    },
    async open(stored, table) {
      const v = versionOf(stored);
      if (!v) return stored;
      try {
        const iv = stored.subarray(ENC_PREFIX.length, ENC_HEADER_BYTES);
        return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: v === 1 ? ENC_PREFIX_V1 : aad(table) }, key, stored.subarray(ENC_HEADER_BYTES)));
      } catch {
        throw new SealError("a stored row couldn't be decrypted");
      }
    },
  };
}
