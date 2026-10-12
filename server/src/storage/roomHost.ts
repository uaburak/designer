/**
 * The `RoomObjectsHost` of a room on Cloudflare (fileRoom.ts) and in Node's tests (testing/memoryRooms.ts): its bucket by
 * the file's region (the Worker says it on every call, `x-region`, kept in meta `region`: 1 eu, 0 default — unknown
 * means nothing is written to R2 yet, so an EU room never writes into the default bucket), D1 for blob references and
 * `files.storage_r2_at`.
 */
import type { D1Like } from "../db";
import type { RoomCipher } from "../ekm/cipher";
import type { SqlRoomStorage } from "../roomBox";
import { bucket, type StorageEnv } from "./objects";
import { addRefs } from "./refs";
import type { RoomObjectsHost } from "./roomObjects";

export interface RoomHostDeps {
  env: StorageEnv | undefined;
  d1?: D1Like | null;
  storage(): SqlRoomStorage;
  fileKey(): string | null;
  /** The org of the room's key while key management is on */
  orgId(): string | null;
  blobCipher(): RoomCipher | null;
  now(): number;
}

/** `x-region` of a call ("eu" | "default"), remembered in the room's meta */
export function noteRegion(st: SqlRoomStorage, header: string | null): void {
  if (header !== "eu" && header !== "default") return;
  const v = header === "eu" ? 1 : 0;
  if (st.meta("region") !== v) st.setMeta("region", v);
}

export function roomObjectsHost(d: RoomHostDeps): RoomObjectsHost {
  return {
    target() {
      const r = d.storage().meta("region");
      if (r < 0) return null;
      const name = r === 1 ? "files_eu" : "files";
      const store = bucket(d.env, name);
      return store ? { name, store } : null;
    },
    store: (name) => bucket(d.env, name),
    fileKey: () => d.fileKey(),
    orgId: () => d.orgId(),
    blobCipher: () => d.blobCipher(),
    // Images move only where their references can be written
    addRefs: d.d1 ? (refs) => addRefs(d.d1!, refs, d.now()) : undefined,
    migrated: async () => {
      const key = d.fileKey();
      if (d.d1 && key) await d.d1.prepare(`UPDATE files SET storage_r2_at = ?2 WHERE key = ?1 AND storage_r2_at IS NULL`).bind(key, d.now()).run();
    },
  };
}
