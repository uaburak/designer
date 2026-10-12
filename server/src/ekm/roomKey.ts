/**
 * A room's key (docs/governance.md §2.10): on wake the room reads its file's org key from D1 itself (one query), unwraps
 * the DEK under `EKM_ROOT_KEY` and keeps the cipher in memory; it does that again every `EKM_RECHECK_MS`.
 *
 *   "none"         the file's org has no key (or the file is outside any org): rows are written plain
 *   "ok"           rows are sealed with the org's DEK
 *   "unavailable"  the org has a key that can't be unwrapped (the secret is missing or rotated): the room answers 503
 *                  `key_unavailable` to sockets and REST. The first room to see it sets `org_keys.state = 'unavailable'`
 *                  and logs `ekm_key_unavailable`; a room that unwraps it again sets `state = 'ok'`.
 *
 * D1 is written only on those transitions (and `files.encrypted_at` once per file, `markEncrypted`).
 */
import { EKM_RECHECK_MS } from "../../../src/shared/org/governance";
import { fileEntity, logActivity } from "../activity";
import type { Deps } from "../api";
import { Db, type D1Like } from "../db";
import { PLAIN_CIPHER, type RoomCipher } from "./cipher";
import { orgCipher } from "./keys";

export type RoomKeyState = "none" | "ok" | "unavailable";

export interface RoomKeyHost {
  d1?: D1Like;
  rootKey(): string | undefined;
  now(): number;
  /** The room's file (null while unknown: rows stay plain until a call names it) */
  fileKey(): string | null;
  /** Does the room already hold sealed rows (meta `ekm`)? Then "no key in D1" is "unavailable", not "none". */
  sealedBefore(): boolean;
}

interface KeyRow {
  org: string | null;
  dek: string | null;
  state: string | null;
}

export class RoomKey {
  state: RoomKeyState | null = null;
  cipher: RoomCipher = PLAIN_CIPHER;
  orgId: string | null = null;
  private checkedAt = 0;
  private loading: Promise<RoomKeyState> | null = null;

  constructor(private host: RoomKeyHost) {}

  /** Not loaded yet, or loaded more than `EKM_RECHECK_MS` ago */
  due(): boolean {
    return this.state === null || this.host.now() - this.checkedAt >= EKM_RECHECK_MS;
  }

  /** Loads (or re-checks) the key; one load at a time. Never throws. */
  load(): Promise<RoomKeyState> {
    this.loading ??= this.read().finally(() => (this.loading = null));
    return this.loading;
  }

  /** `load()` when due */
  async ready(): Promise<RoomKeyState> {
    return this.due() ? this.load() : this.state!;
  }

  private async read(): Promise<RoomKeyState> {
    const { d1 } = this.host;
    const key = this.host.fileKey();
    if (!d1 || !key) return this.set(this.host.sealedBefore() ? "unavailable" : "none", PLAIN_CIPHER, !key);
    let row: KeyRow | null;
    try {
      row = await d1.prepare(`SELECT f.org_id AS org, k.wrapped_dek AS dek, k.state AS state FROM files f LEFT JOIN org_keys k ON k.org_id = f.org_id WHERE f.key = ?1`).bind(key).first<KeyRow>();
    } catch (e) {
      // D1 unreachable: keep what we had; nothing known and sealed rows here → unavailable for now (asked again next call)
      console.error("ekm: the key couldn't be read", key, e);
      if (this.state !== null) return this.state;
      return this.set(this.host.sealedBefore() ? "unavailable" : "none", PLAIN_CIPHER, true);
    }
    this.orgId = row?.org ?? null;
    if (!row?.org || !row.dek) return this.set(this.host.sealedBefore() ? "unavailable" : "none", PLAIN_CIPHER);
    // Unwrapped again on every check: that is the check that the root key still opens it (native; no subrequest).
    try {
      const cipher = await orgCipher(this.host.rootKey(), row.org, row.dek);
      if (row.state === "unavailable") await this.flip(row.org, "ok");
      return this.set("ok", cipher);
    } catch (e) {
      console.error("ekm: the org's key couldn't be unwrapped", row.org, (e as Error).message);
      if (row.state !== "unavailable") await this.flip(row.org, "unavailable", key);
      return this.set("unavailable", PLAIN_CIPHER);
    }
  }

  private set(state: RoomKeyState, cipher: RoomCipher, retry = false): RoomKeyState {
    this.state = state;
    this.cipher = cipher;
    // `retry`: not really known — ask again on the next call
    this.checkedAt = retry ? this.host.now() - EKM_RECHECK_MS : this.host.now();
    return state;
  }

  /** `org_keys.state` on a transition; the first room to see the key fail logs `ekm_key_unavailable` */
  private async flip(orgId: string, to: "ok" | "unavailable", fileKey?: string): Promise<void> {
    const d1 = this.host.d1!;
    try {
      const { results } = await d1
        .prepare(`UPDATE org_keys SET state = ?2, checked_at = ?3, updated_at = ?3 WHERE org_id = ?1 AND state <> ?2 RETURNING org_id`)
        .bind(orgId, to, this.host.now())
        .all<{ org_id: string }>();
      if (to === "unavailable" && results.length) {
        const org = await d1.prepare(`SELECT name FROM orgs WHERE id = ?1`).bind(orgId).first<{ name: string }>();
        await logActivity(roomDeps(d1, this.host.now), { orgId, action: "ekm_key_unavailable", actor: null, entity: { type: "org", id: orgId, name: org?.name ?? "" }, details: { source: "managed", ...(fileKey ? { file_key: fileKey } : {}) } });
      }
    } catch (e) {
      console.error("ekm: org_keys not updated", orgId, e);
    }
  }

  /**
   * `files.encrypted_at` once the room's rows are all sealed; logs `fig_file_encrypt` when this call set it (the room's
   * own lazy encryption; `encrypt-next` logs with the admin as the actor).
   */
  async markEncrypted(fileKey: string): Promise<void> {
    const d1 = this.host.d1;
    if (!d1) return;
    try {
      const { results } = await d1
        .prepare(`UPDATE files SET encrypted_at = ?2 WHERE key = ?1 AND encrypted_at IS NULL RETURNING key, name, org_id, team_id, editor_type, link_access, proto_link_access`)
        .bind(fileKey, this.host.now())
        .all<{ key: string; name: string; org_id: string | null; team_id: string | null; editor_type?: string; link_access?: string; proto_link_access?: string }>();
      const f = results[0];
      if (f?.org_id) await logActivity(roomDeps(d1, this.host.now), { orgId: f.org_id, action: "fig_file_encrypt", actor: null, entity: fileEntity(f), teamId: f.team_id, details: { source: "managed", trigger: "wake" } });
    } catch (e) {
      console.error("ekm: encrypted_at not set", fileKey, e);
    }
  }
}

/** What `logActivity` reads of the Worker's deps, for a room */
const roomDeps = (d1: D1Like, now: () => number) => ({ db: new Db(d1), now }) as unknown as Deps;
