/**
 * Key management on objects (docs/cloud.md §1, docs/governance.md §2.10): an org with a managed key has its blobs
 * sealed before they reach R2, under its own prefix `e/<orgId>/` (content addressing by the plaintext SHA-1, no dedup
 * across orgs). A blob is shared by every file of the org that uses it, so its associated data names the org
 * (`<orgId>|blobs`) where a room's checkpoints name the file (`<fileKey>|snapshot`, the room's own cipher).
 *
 * The Worker unwraps the org's DEK (one D1 read, `EKM_ROOT_KEY`) once per isolate and key row; a room uses its
 * `RoomKey.objectCipher`. A key that can't be unwrapped is 503 `key_unavailable`, as the room says it.
 */
import type { D1Like } from "../db";
import { aesCipher, type RoomCipher } from "../ekm/cipher";
import { unwrapDek } from "../ekm/keys";
import { HttpError } from "../org/http";

/** The org's key row (prefetched with a blob route's other reads) */
export const orgKeyQ = (orgId: string) => ({ sql: `SELECT wrapped_dek FROM org_keys WHERE org_id = ?1`, args: [orgId] });

const ciphers = new Map<string, Promise<RoomCipher>>();

/** The org's object cipher; null when the org has no key (objects plain) */
export async function orgObjectCipher(d1: D1Like, rootKey: string | undefined, orgId: string | null): Promise<RoomCipher | null> {
  if (!orgId) return null;
  const q = orgKeyQ(orgId);
  const row = await d1.prepare(q.sql).bind(...q.args).first<{ wrapped_dek: string }>();
  if (!row) return null;
  const k = `${orgId}\u0000${row.wrapped_dek}\u0000${rootKey ?? ""}`;
  let p = ciphers.get(k);
  if (!p) {
    p = unwrapDek(rootKey, orgId, row.wrapped_dek).then((dek) => aesCipher(dek, orgId));
    ciphers.set(k, p);
    p.catch(() => ciphers.delete(k));
  }
  try {
    return await p;
  } catch {
    throw new HttpError(503, "this file's encryption key is unavailable", "key_unavailable");
  }
}

/** The org a sealed key belongs to (`e/<orgId>/…`), null for plain keys */
export const orgOfKey = (key: string): string | null => /^e\/([^/]+)\//.exec(key)?.[1] ?? null;
