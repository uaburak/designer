/**
 * Key management's row cipher (docs/governance.md §2.10): AES-256-GCM per stored row under the org's DEK —
 * `"DV2E" | v1 | iv(12) | ciphertext + tag(16)`, the 5-byte magic and version authenticated as associated data.
 * Rows without the header read as plain, so a room's existing rows encrypt gradually (on its next wake or by
 * `encrypt-next`). WebCrypto only: the DEK is imported once per wake (roomKey.ts) and every row has its own random IV —
 * no per-row derivation.
 */
import { ENC_HEADER_BYTES, ENC_MAGIC, ENC_VERSION } from "../../../src/shared/org/governance";

export interface RoomCipher {
  readonly enabled: boolean;
  seal(plain: Uint8Array): Promise<Uint8Array>;
  open(stored: Uint8Array): Promise<Uint8Array>;
}

export const PLAIN_CIPHER: RoomCipher = {
  enabled: false,
  seal: async (p) => p,
  open: async (s) => s,
};

/** "DV2E" | 1 — what a sealed row starts with (also SQL's `X'4456324501'`) */
export const ENC_PREFIX = new Uint8Array([...new TextEncoder().encode(ENC_MAGIC), ENC_VERSION]);
/** The prefix as an SQLite blob literal, for `substr(col, 1, 5) IS NOT …` sweeps */
export const ENC_PREFIX_SQL = `X'${[...ENC_PREFIX].map((b) => b.toString(16).padStart(2, "0")).join("")}'`;
/** What sealing adds to a row: the header and GCM's tag */
export const ENC_OVERHEAD = ENC_HEADER_BYTES + 16;

/** Does a stored row carry the header? */
export function isSealed(bytes: Uint8Array): boolean {
  if (bytes.length < ENC_OVERHEAD) return false;
  for (let i = 0; i < ENC_PREFIX.length; i++) if (bytes[i] !== ENC_PREFIX[i]) return false;
  return true;
}

/** CryptoKey, named so both Node's and Workers' typings accept it (as tokens.ts) */
export type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** A row's bytes could not be opened (a wrong DEK, or a damaged row) */
export class SealError extends Error {}

/** The cipher over an imported AES-GCM key (`encrypt` + `decrypt` usages) */
export function aesCipher(key: Key): RoomCipher {
  return {
    enabled: true,
    async seal(plain) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ENC_PREFIX }, key, plain));
      const out = new Uint8Array(ENC_HEADER_BYTES + ct.length);
      out.set(ENC_PREFIX, 0);
      out.set(iv, ENC_PREFIX.length);
      out.set(ct, ENC_HEADER_BYTES);
      return out;
    },
    async open(stored) {
      if (!isSealed(stored)) return stored;
      try {
        const iv = stored.subarray(ENC_PREFIX.length, ENC_HEADER_BYTES);
        return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: ENC_PREFIX }, key, stored.subarray(ENC_HEADER_BYTES)));
      } catch {
        throw new SealError("a stored row couldn't be decrypted");
      }
    },
  };
}
