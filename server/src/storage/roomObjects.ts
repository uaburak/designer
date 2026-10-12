/**
 * A room's checkpoints on R2 (docs/cloud.md §1): the document at a seq (`snapshot`, a version's `history_snapshots`)
 * and a branch's merge base (`base_chunks`) are objects `c/<fileKey>/<seq>` / `c/<fileKey>/base-<seq>` — written once,
 * read on wake and version open. The room keeps in SQLite only the live journal (`frames`), `meta`, `versions`,
 * `history_frames` and the index of its objects:
 *
 *   checkpoints (name, bucket, key, size, sealed)   name `<seq>` (the live snapshot when meta `snapR2` = 1 and seq =
 *                                                   snapshotSeq; any version's `snapshot_seq`) or `base-<seq>` (meta
 *                                                   `baseR2` / `nextR2`: the base / staged slot at baseSeq / baseNextSeq)
 *   r2_trash (bucket, key)                          objects no longer referenced, deleted after the request
 *
 * A document checkpoint is the same object whether it is the live snapshot or a version's (they are the document at
 * that seq): a version taken needs no copy. Objects are sealed with the room's cipher (AAD `<fileKey>|snapshot` /
 * `|base_chunks`, as the rows were) under `e/<orgId>/c/…` when key management is on; plain ones are read by the Worker
 * straight from R2 (`r2Redirect`), sealed ones opened here.
 *
 * Lazy migration (`step`): a room still holding checkpoints or images in rows moves one of them per step — the live
 * snapshot, a version's snapshot, a base slot, then images (to the shared `b/<sha1>`, referenced in D1) — each written
 * to R2 before its rows go, re-checked after the write (idempotent; nothing blocks a socket). When nothing is left,
 * meta `r2Done` = 1 and `files.storage_r2_at` is set (`host.migrated`).
 */
import type { SqlLike } from "../previews";
import type { SqlRoomStorage } from "../roomBox";
import type { RoomCipher, SealedTable } from "../ekm/cipher";
import { openJoined } from "../ekm/rows";
import { blobKey, checkpointKey, r2Redirect, sealedPrefix, type BucketName, type ObjectStore } from "./objects";
import type { NewRef } from "./refs";

export interface RoomObjectsHost {
  /** Where the room writes: its file's region's bucket (null: R2 isn't bound here, everything stays in rows) */
  target(): { name: BucketName; store: ObjectStore } | null;
  /** A bucket by name (objects written before a region move are read where they are) */
  store(name: BucketName): ObjectStore | null;
  fileKey(): string | null;
  /** The org of the room's key while key management is on (sealed objects' prefix) */
  orgId(): string | null;
  /** The org-bound cipher for blobs moved out of the rows (key management on); absent: plain */
  blobCipher?(): RoomCipher | null;
  /** Blobs moved out of the rows: their references in D1 (refs.ts) */
  addRefs?(refs: NewRef[]): Promise<void>;
  /** Nothing left in rows: `files.storage_r2_at` */
  migrated?(): Promise<void>;
}

interface Row {
  name: string;
  bucket: BucketName;
  key: string;
  size: number;
  sealed: number;
}

export interface StepResult {
  /** Nothing is left in rows */
  done: boolean;
  /** What this step moved: "snapshot" | "version" | "base" | "blob" | null */
  moved: string | null;
  bytes: number;
}

/** Images moved per step at most (bytes; one image at least) */
const BLOB_STEP_BYTES = 16 * 1024 * 1024;

export class RoomObjects {
  constructor(
    private sql: SqlLike,
    private transaction: (fn: () => void) => void,
    private st: SqlRoomStorage,
    private cipher: () => RoomCipher,
    private host: RoomObjectsHost | undefined,
    private now: () => number,
  ) {}

  static readonly TABLES = [
    `CREATE TABLE IF NOT EXISTS checkpoints (name TEXT PRIMARY KEY, bucket TEXT NOT NULL, key TEXT NOT NULL, size INTEGER NOT NULL, sealed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS r2_trash (bucket TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (bucket, key))`,
  ];

  /** Is R2 there for this room's writes? */
  enabled(): boolean {
    return !!this.host?.target() && !!this.host.fileKey();
  }

  row(name: string): Row | null {
    return this.sql.exec<Row>(`SELECT name, bucket, key, size, sealed FROM checkpoints WHERE name = ?`, name).toArray()[0] ?? null;
  }

  /**
   * `bytes` (plain) written as checkpoint `name`, sealed when the room's cipher is on → the row to record in the
   * caller's transaction; null when R2 isn't there (the caller keeps rows).
   */
  async put(name: string, bytes: Uint8Array, table: SealedTable): Promise<Row | null> {
    const t = this.host?.target();
    const fileKey = this.host?.fileKey();
    if (!t || !fileKey) return null;
    const c = this.cipher();
    const sealed = c.enabled;
    const key = checkpointKey(fileKey, name, sealed ? this.host!.orgId() : null);
    await t.store.put(key, sealed ? await c.seal(bytes, table) : bytes);
    return { name, bucket: t.name, key, size: bytes.length, sealed: sealed ? 1 : 0 };
  }

  /** Inside a transaction: the checkpoint `r` recorded (an older object of the same name trashed) */
  record(r: Row): void {
    const old = this.row(r.name);
    if (old && (old.key !== r.key || old.bucket !== r.bucket)) this.trash(old.bucket, old.key);
    this.sql.exec(`INSERT OR REPLACE INTO checkpoints (name, bucket, key, size, sealed, created_at) VALUES (?, ?, ?, ?, ?, ?)`, r.name, r.bucket, r.key, r.size, r.sealed, this.now());
  }

  /** An object written but not recorded (its request refused after the write) */
  discard(r: Row | null): void {
    if (r && !this.row(r.name)) this.trash(r.bucket, r.key);
  }

  private trash(bucket: BucketName, key: string): void {
    this.sql.exec(`INSERT OR IGNORE INTO r2_trash (bucket, key) VALUES (?, ?)`, bucket, key);
  }

  /** The answer for a checkpoint read: plain → the Worker reads R2 itself; sealed → opened here */
  async read(r: Row, table: SealedTable, headers: Record<string, string>): Promise<Response> {
    const all = { "content-type": "application/octet-stream", ...headers };
    if (!r.sealed) return r2Redirect(r.bucket, r.key, all);
    const store = this.host?.store(r.bucket);
    const obj = store ? await store.get(r.key) : null;
    if (!obj) return new Response("checkpoint missing", { status: 404 });
    return new Response(await this.cipher().open(new Uint8Array(await obj.arrayBuffer()), table), { headers: all });
  }

  /** A checkpoint's plain bytes (migration of sealing, moves) */
  async bytes(r: Row, table: SealedTable): Promise<Uint8Array | null> {
    const store = this.host?.store(r.bucket);
    const obj = store ? await store.get(r.key) : null;
    if (!obj) return null;
    const raw = new Uint8Array(await obj.arrayBuffer());
    return r.sealed ? this.cipher().open(raw, table) : raw;
  }

  /** Inside a transaction: checkpoints nothing refers to any more go to the trash */
  collect(): void {
    const keep = new Set<string>();
    const snap = this.st.meta("snapshotSeq");
    if (this.st.meta("snapR2") === 1 && snap >= 0) keep.add(String(snap));
    for (const v of this.sql.exec<{ s: number }>(`SELECT DISTINCT snapshot_seq AS s FROM versions`).toArray()) keep.add(String(v.s));
    if (this.st.meta("baseR2") === 1) keep.add(`base-${this.st.meta("baseSeq")}`);
    if (this.st.meta("nextR2") === 1) keep.add(`base-${this.st.meta("baseNextSeq")}`);
    for (const r of this.sql.exec<Row>(`SELECT name, bucket, key FROM checkpoints`).toArray()) {
      if (keep.has(r.name)) continue;
      this.trash(r.bucket, r.key);
      this.sql.exec(`DELETE FROM checkpoints WHERE name = ?`, r.name);
    }
  }

  /** Trashed objects deleted from R2 (after the request; kept for the next try when R2 fails) */
  async flush(): Promise<void> {
    const rows = this.sql.exec<{ bucket: BucketName; key: string }>(`SELECT bucket, key FROM r2_trash LIMIT 1000`).toArray();
    if (!rows.length) return;
    for (const name of ["files", "files_eu"] as const) {
      const keys = rows.filter((r) => r.bucket === name).map((r) => r.key);
      const store = this.host?.store(name);
      if (!keys.length || !store) continue;
      try {
        await store.delete(keys);
        for (const k of keys) this.sql.exec(`DELETE FROM r2_trash WHERE bucket = ? AND key = ?`, name, k);
      } catch (e) {
        console.error("r2: trashed checkpoints not deleted yet", e);
      }
    }
  }

  /** Everything the room wrote (the room is deleted): its checkpoints and trash */
  async dropAll(): Promise<void> {
    const rows = [...this.sql.exec<{ bucket: BucketName; key: string }>(`SELECT bucket, key FROM checkpoints`).toArray(), ...this.sql.exec<{ bucket: BucketName; key: string }>(`SELECT bucket, key FROM r2_trash`).toArray()];
    // The REST parts' objects (rest/roomJobs.ts), when the room has that table
    if (this.sql.exec(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'rest_r2'`).toArray().length) rows.push(...this.sql.exec<{ bucket: BucketName; key: string }>(`SELECT bucket, key FROM rest_r2`).toArray());
    for (const name of ["files", "files_eu"] as const) {
      const keys = rows.filter((r) => r.bucket === name).map((r) => r.key);
      const store = this.host?.store(name);
      for (let i = 0; store && i < keys.length; i += 1000) await store.delete(keys.slice(i, i + 1000));
    }
  }

  /**
   * After a region move's load (docs/multiplayer.md §15.10): checkpoints still in another bucket are copied into this
   * room's (the old room deletes its own when it goes). → done when none is left.
   */
  async relocate(): Promise<{ done: boolean; copied: number }> {
    const t = this.host?.target();
    if (!t) return { done: true, copied: 0 };
    let copied = 0;
    for (const r of this.sql.exec<Row>(`SELECT name, bucket, key, size, sealed FROM checkpoints WHERE bucket <> ?`, t.name).toArray()) {
      const from = this.host!.store(r.bucket);
      const obj = from ? await from.get(r.key) : null;
      if (obj) await t.store.put(r.key, new Uint8Array(await obj.arrayBuffer()));
      this.sql.exec(`UPDATE checkpoints SET bucket = ? WHERE name = ? AND key = ?`, t.name, r.name, r.key);
      copied++;
    }
    return { done: true, copied };
  }

  /** Key management turned on: plain checkpoints sealed (rewritten under the org's prefix). → how many. */
  async sealAll(): Promise<number> {
    const c = this.cipher();
    const fileKey = this.host?.fileKey();
    const org = this.host?.orgId();
    if (!c.enabled || !fileKey || !org) return 0;
    let n = 0;
    for (const r of this.sql.exec<Row>(`SELECT name, bucket, key, size, sealed FROM checkpoints WHERE sealed = 0`).toArray()) {
      const store = this.host!.store(r.bucket);
      const plain = await this.bytes(r, "snapshot");
      if (!store || !plain) continue;
      const table: SealedTable = r.name.startsWith("base-") ? "base_chunks" : "snapshot";
      const key = checkpointKey(fileKey, r.name, org);
      await store.put(key, await c.seal(plain, table));
      this.transaction(() => {
        if (this.row(r.name)?.key !== r.key) return;
        this.record({ ...r, key, sealed: 1 });
      });
      n++;
    }
    return n;
  }

  // ---- lazy migration ---------------------------------------------------------------------------------------------

  /** One step of moving rows to R2 (see the file's comment) */
  async step(): Promise<StepResult> {
    const none: StepResult = { done: false, moved: null, bytes: 0 };
    if (!this.enabled()) return none;
    if (this.st.meta("r2Done") === 1) return { done: true, moved: null, bytes: 0 };
    const c = this.cipher();
    // 1. The live snapshot
    const snap = this.st.meta("snapshotSeq");
    const live = this.sql.exec<{ bytes: ArrayBuffer }>(`SELECT bytes FROM snapshot ORDER BY idx`).toArray();
    if (live.length && snap >= 0) {
      const plain = await openJoined(c, live, "snapshot");
      const r = await this.put(String(snap), plain, "snapshot");
      this.transaction(() => {
        // Replaced meanwhile (a new snapshot came): this object is no one's; the next step moves the new one
        if (this.st.meta("snapshotSeq") !== snap || this.st.meta("snapR2") === 1) return this.discard(r);
        this.sql.exec(`DELETE FROM snapshot`);
        this.record(r!);
        this.st.setMeta("snapR2", 1);
      });
      return { ...none, moved: "snapshot", bytes: plain.length };
    }
    // 2. A version's snapshot
    const hist = this.sql.exec<{ seq: number }>(`SELECT DISTINCT seq FROM history_snapshots ORDER BY seq LIMIT 1`).toArray()[0];
    if (hist) {
      const rows = this.sql.exec<{ bytes: ArrayBuffer }>(`SELECT bytes FROM history_snapshots WHERE seq = ? ORDER BY idx`, hist.seq).toArray();
      const plain = await openJoined(c, rows, "history_snapshots");
      const r = this.row(String(hist.seq)) ? null : await this.put(String(hist.seq), plain, "history_snapshots");
      this.transaction(() => {
        this.sql.exec(`DELETE FROM history_snapshots WHERE seq = ?`, hist.seq);
        if (r && !this.row(r.name)) this.record(r);
        else this.discard(r);
      });
      return { ...none, moved: "version", bytes: plain.length };
    }
    // 3. The branch's base and its staged next base
    for (const [slot, seqKey, flag] of [["base", "baseSeq", "baseR2"], ["next", "baseNextSeq", "nextR2"]] as const) {
      const rows = this.sql.exec<{ bytes: ArrayBuffer }>(`SELECT bytes FROM base_chunks WHERE slot = ? ORDER BY idx`, slot).toArray();
      const seq = this.st.meta(seqKey);
      if (!rows.length) continue;
      if (seq < 0) {
        this.sql.exec(`DELETE FROM base_chunks WHERE slot = ?`, slot);
        continue;
      }
      const plain = await openJoined(c, rows, "base_chunks");
      const r = await this.put(`base-${seq}`, plain, "base_chunks");
      this.transaction(() => {
        if (this.st.meta(seqKey) !== seq || this.st.meta(flag) === 1) return this.discard(r);
        this.sql.exec(`DELETE FROM base_chunks WHERE slot = ?`, slot);
        this.record(r!);
        this.st.setMeta(flag, 1);
      });
      return { ...none, moved: "base", bytes: plain.length };
    }
    // 4. Images, a few per step (D1 references; the room's rows go once those are written)
    const t = this.host!.target()!;
    const fileKey = this.host!.fileKey()!;
    const sha1s = this.sql.exec<{ sha1: string }>(`SELECT DISTINCT sha1 FROM blobs ORDER BY sha1 LIMIT 64`).toArray().map((r) => r.sha1);
    if (sha1s.length && this.host!.addRefs) {
      const bc = c.enabled ? (this.host!.blobCipher?.() ?? null) : null;
      // Key management on but the org's blob cipher isn't there: nothing moves (asked again next wake)
      if (c.enabled && !bc) return none;
      const org = bc ? this.host!.orgId() : null;
      const refs: NewRef[] = [];
      let bytes = 0;
      for (const sha1 of sha1s) {
        const rows = this.sql.exec<{ bytes: ArrayBuffer }>(`SELECT bytes FROM blobs WHERE sha1 = ? ORDER BY idx`, sha1).toArray();
        const plain = await openJoined(c, rows, "blobs");
        const key = blobKey(sha1, org);
        await t.store.put(key, bc ? await bc.seal(plain, "blobs") : plain);
        refs.push({ sha1, fileKey, bucket: t.name, key, ownerId: null, bytes: plain.length });
        bytes += plain.length;
        if (bytes >= BLOB_STEP_BYTES) break;
      }
      await this.host!.addRefs(refs);
      this.transaction(() => {
        for (const r of refs) this.sql.exec(`DELETE FROM blobs WHERE sha1 = ?`, r.sha1);
      });
      return { ...none, moved: "blob", bytes };
    }
    if (sha1s.length) return none;
    this.st.setMeta("r2Done", 1);
    await this.host!.migrated?.();
    return { done: true, moved: null, bytes: 0 };
  }
}

/** The prefix a room's sealed checkpoints use (tests) */
export const sealedCheckpointPrefix = (orgId: string, fileKey: string): string => `${sealedPrefix(orgId)}c/${fileKey}/`;
