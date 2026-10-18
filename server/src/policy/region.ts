/**
 * Data storage localization (docs/multiplayer.md §15.10) [F-region, CF-do]: an org's file content at rest — each org
 * file's room (`FileRoom`, branches included) and each org library's `LibraryObject` — in Cloudflare's `eu`
 * jurisdiction. Self-serve for org admins (ours; Figma: Support):
 *
 *   GET  /orgs/:org/admin/data-region                  DataRegionStatus
 *   PUT  /orgs/:org/admin/data-region {region}         DataRegionStatus — new files follow at once; logged
 *   POST /orgs/:org/admin/data-region/move             moves ONE file (or library) whose jurisdiction differs from
 *                                                      the org's region; DataRegionStatus with `moving` = the key moved
 *                                                      (null when nothing was left). The Admin page calls it in a loop.
 *                                                      One at a time per org (a lease, `orgs.region_move_until`, migration
 *                                                      0027): another call meanwhile answers 409 `conflict`.
 *
 * Addressing: `roomsOn` (index.ts's `Rooms`) reads `files.jurisdiction` on every room call — no cache, a stale one would
 * wake an empty object in the old namespace — and `libraries/db.ts libraryFetch` reads `libraries.jurisdiction`.
 *
 * A move (one object): freeze the old one (sockets closed with 4012, writes refused 503 `moving`), copy its tables in
 * pages (`GET dump` → `POST load`, policy/dump.ts), flip the D1 row, delete the old object. A failure before the flip
 * unfreezes the old object and deletes the partial copy. Cloudflare can't relocate an object: moving is copying. An old
 * object that couldn't be deleted is kept in `region_leftovers` and deleted by the daily cron (`sweepRegionLeftovers`):
 * its content would otherwise stay at rest in the region the org left.
 */
import { DATA_REGION_LABEL, type DataRegion, type DataRegionStatus, type RoomPolicy } from "../../../src/shared/org/identity";
import type { Deps, Rooms } from "../api";
import { fileEntity, logActivity } from "../activity";
import type { D1Like } from "../db";
import { inJurisdiction, libraries, type ObjectNamespace } from "../libraries/db";
import { body, HttpError, json, type Ctx } from "../org/http";
import { encodeRoomPolicy } from "./roomPolicy";
import { setIdentityHeaders } from "../identityHeaders";
import { resolveR2, type StorageEnv } from "../storage/objects";

type Jurisdiction = "eu" | null;
const jurisdictionOf = (region: DataRegion): Jurisdiction => (region === "eu" ? "eu" : null);

/** What the move needs of the Worker's env (index.ts passes the whole env as `deps.env`) */
export interface RegionEnv {
  /** The FileRoom namespace */
  ROOMS?: ObjectNamespace;
}

/** What a move does besides the objects' tables: the file's images re-homed in the new region's bucket (storage/relocate.ts) */
type AfterCopy = () => Promise<unknown>;

/** A file's room's jurisdiction (`files.jurisdiction`); null: the default namespace (and files not in D1) */
export async function fileJurisdiction(d1: D1Like, key: string): Promise<Jurisdiction> {
  const r = await d1.prepare(`SELECT jurisdiction FROM files WHERE key = ?1`).bind(key).first<{ jurisdiction: string | null }>();
  return r?.jurisdiction === "eu" ? "eu" : null;
}

const stubOf = (ns: ObjectNamespace | undefined, j: Jurisdiction, name: string) => {
  const n = inJurisdiction(ns, j);
  if (!n) throw new HttpError(503, "rooms aren't available here");
  return n.get(n.idFromName(name) as never);
};

/**
 * The Worker's `Rooms` over the FileRoom namespace: each call to the file's room in its jurisdiction, with the identity
 * the Worker resolved (`x-user-id`, `x-user-name`, `x-role`), the org's room policy (`x-policy`, §15.9) and the file's
 * region (`x-region`: the room's R2 bucket, docs/cloud.md §1). A checkpoint the room answers by name (`x-r2-key`) is
 * read here straight from R2 (`resolveR2`).
 */
export function roomsOn(ns: ObjectNamespace, d1: D1Like, env?: StorageEnv): Rooms {
  return {
    async fetch(fileKey, path, init, original) {
      // The caller's file row says it when it has one (`jurisdiction`); otherwise read now — never cached
      const j = init.jurisdiction !== undefined ? init.jurisdiction : await fileJurisdiction(d1, fileKey);
      const stub = stubOf(ns, j, fileKey);
      const headers = new Headers(original?.headers);
      headers.delete("authorization");
      headers.set("x-file-key", fileKey);
      headers.set("x-region", j === "eu" ? "eu" : "default");
      // The name percent-encoded: header values are bytes (identityHeaders.ts)
      if (init.identity) setIdentityHeaders(headers, init.identity);
      if (init.policy) headers.set("x-policy", encodeRoomPolicy(init.policy as RoomPolicy));
      // A stream body (an upload passed on: quota.ts guardedStream) needs `duplex` where fetch is Node's (tests)
      const res = await stub.fetch(new Request(`https://room${path}`, { method: init.method, headers, body: init.body, duplex: "half" } as RequestInit));
      return resolveR2(res, env);
    },
  };
}

// ---- the routes ---------------------------------------------------------------------------------------------------

export async function dataRegionRoute(ctx: Ctx, orgId: string, rest: string[]): Promise<Response> {
  const { m } = ctx;
  if (!rest.length && m === "GET") return json(await dataRegionStatus(ctx, orgId));
  if (!rest.length && m === "PUT") {
    const { region } = await body<{ region?: unknown }>(ctx.req);
    if (region !== "default" && region !== "eu") throw new HttpError(400, "region is default or eu");
    return json(await setDataRegion(ctx, orgId, region));
  }
  if (rest[0] === "move" && rest.length === 1 && m === "POST") return json(await moveNext(ctx, orgId));
  throw new HttpError(404, "not found");
}

const regionEnv = (ctx: Ctx) => ctx.deps.env as RegionEnv;

/** Is a jurisdiction-restricted namespace there at all? (whether the plan allows one is known only at the first move) */
function available(ctx: Ctx): boolean {
  const ns = regionEnv(ctx).ROOMS;
  if (!ns?.jurisdiction) return false;
  try {
    return !!ns.jurisdiction("eu");
  } catch {
    return false;
  }
}

async function regionOf(d1: D1Like, orgId: string): Promise<DataRegion> {
  const r = await d1.prepare(`SELECT data_region FROM orgs WHERE id = ?1`).bind(orgId).first<{ data_region: string }>();
  if (!r) throw new HttpError(404, "no such organization");
  return r.data_region === "eu" ? "eu" : "default";
}

export async function dataRegionStatus(ctx: Ctx, orgId: string, moving: string | null = null): Promise<DataRegionStatus> {
  const d1 = ctx.deps.db.d1;
  const region = await regionOf(d1, orgId);
  const j = jurisdictionOf(region);
  const f = await d1.prepare(`SELECT COUNT(*) AS total, SUM(jurisdiction IS ?2) AS moved FROM files WHERE org_id = ?1`).bind(orgId, j).first<{ total: number; moved: number | null }>();
  const l = await d1.prepare(`SELECT COUNT(*) AS total, SUM(jurisdiction IS ?2) AS moved FROM libraries WHERE org_id = ?1 AND status <> 'deleted'`).bind(orgId, j).first<{ total: number; moved: number | null }>();
  return { region, files: { total: f?.total ?? 0, moved: f?.moved ?? 0 }, libraries: { total: l?.total ?? 0, moved: l?.moved ?? 0 }, moving, available: available(ctx) };
}

async function setDataRegion(ctx: Ctx, orgId: string, region: DataRegion): Promise<DataRegionStatus> {
  const { deps, user } = ctx;
  const d1 = deps.db.d1;
  const before = await regionOf(d1, orgId);
  if (before !== region) {
    if (region === "eu" && !available(ctx)) throw new HttpError(503, "data storage localization isn't available on this server");
    await d1.prepare(`UPDATE orgs SET data_region = ?2, updated_at = ?3 WHERE id = ?1`).bind(orgId, region, deps.now()).run();
    const org = await d1.prepare(`SELECT name FROM orgs WHERE id = ?1`).bind(orgId).first<{ name: string }>();
    await logActivity(deps, { orgId, action: "data_storage_localization_change", actor: user, entity: { type: "org", id: orgId, name: org?.name ?? "" }, details: { from: before, to: region, from_label: DATA_REGION_LABEL[before], to_label: DATA_REGION_LABEL[region] }, req: ctx.req });
  }
  return dataRegionStatus(ctx, orgId);
}

/** How long a move holds its org's lease: past it (a Worker that died mid-move) the next call takes the lease again */
export const MOVE_LEASE_MS = 5 * 60_000;

/**
 * Moves the next file (then library) whose object isn't in the org's region yet — under the org's lease: two calls at
 * once would pick the same object, and the one failing would delete the copy the other had just made live.
 */
async function moveNext(ctx: Ctx, orgId: string): Promise<DataRegionStatus> {
  const d1 = ctx.deps.db.d1;
  const now = ctx.deps.now();
  const lease = await d1
    .prepare(`UPDATE orgs SET region_move_until = ?2 WHERE id = ?1 AND (region_move_until IS NULL OR region_move_until <= ?3) RETURNING id`)
    .bind(orgId, now + MOVE_LEASE_MS, now)
    .first<{ id: string }>();
  if (!lease) throw new HttpError(409, "another move is running in this organization", "conflict");
  try {
    return await moveOne(ctx, orgId);
  } finally {
    await d1.prepare(`UPDATE orgs SET region_move_until = NULL WHERE id = ?1`).bind(orgId).run();
  }
}

async function moveOne(ctx: Ctx, orgId: string): Promise<DataRegionStatus> {
  const { deps, user } = ctx;
  const d1 = deps.db.d1;
  const to = jurisdictionOf(await regionOf(d1, orgId));
  const file = await d1.prepare(`SELECT key, name, editor_type, link_access, proto_link_access, team_id, jurisdiction FROM files WHERE org_id = ?1 AND jurisdiction IS NOT ?2 ORDER BY key LIMIT 1`).bind(orgId, to).first<{ key: string; name: string; editor_type: string; link_access: string; proto_link_access: string; team_id: string | null; jurisdiction: string | null }>();
  if (file) {
    const from: Jurisdiction = file.jurisdiction === "eu" ? "eu" : null;
    const { relocateFileBlobs } = await import("../storage/relocate");
    const moved = await moveObject(
      regionEnv(ctx).ROOMS,
      file.key,
      from,
      to,
      ROOM_PATHS,
      async () => {
        await d1.prepare(`UPDATE files SET jurisdiction = ?2 WHERE key = ?1`).bind(file.key, to).run();
      },
      () => relocateFileBlobs(deps, file.key, to),
    );
    if (!moved.oldDeleted) await leftover(d1, "room", file.key, from, orgId, deps.now());
    await logActivity(deps, { orgId, action: "fig_file_region_move", actor: user, entity: fileEntity(file), teamId: file.team_id, details: { object: "room", from: from ?? "default", to: to ?? "default" }, req: ctx.req });
    return dataRegionStatus(ctx, orgId, file.key);
  }
  const lib = await d1.prepare(`SELECT key, name, jurisdiction FROM libraries WHERE org_id = ?1 AND status <> 'deleted' AND jurisdiction IS NOT ?2 ORDER BY key LIMIT 1`).bind(orgId, to).first<{ key: string; name: string; jurisdiction: string | null }>();
  if (lib) {
    const from: Jurisdiction = lib.jurisdiction === "eu" ? "eu" : null;
    const moved = await moveObject(libraries(deps), lib.key, from, to, LIBRARY_PATHS, async () => {
      await d1.prepare(`UPDATE libraries SET jurisdiction = ?2 WHERE key = ?1`).bind(lib.key, to).run();
    });
    if (!moved.oldDeleted) await leftover(d1, "library", lib.key, from, orgId, deps.now());
    await logActivity(deps, { orgId, action: "fig_file_region_move", actor: user, entity: fileEntity({ key: lib.key, name: lib.name }), details: { object: "library", from: from ?? "default", to: to ?? "default" }, req: ctx.req });
    return dataRegionStatus(ctx, orgId, lib.key);
  }
  return dataRegionStatus(ctx, orgId);
}

// ---- moving one object ----------------------------------------------------------------------------------------------

interface MovePaths {
  base: string;
  /** After the load: the copy copies its R2 objects into its own bucket (called until `{done: true}`) */
  relocate: string;
  freeze: [string, string, string | null];
  unfreeze: [string, string, string | null];
  dump: string;
  load: string;
  remove: [string, string];
}

const ROOM_PATHS: MovePaths = {
  base: "https://room",
  relocate: "/room/storage/relocate",
  freeze: ["POST", "/room/freeze", JSON.stringify({ moving: true })],
  unfreeze: ["POST", "/room/unfreeze", JSON.stringify({ moving: true })],
  dump: "/room/dump",
  load: "/room/load",
  remove: ["DELETE", "/room"],
};

const LIBRARY_PATHS: MovePaths = {
  base: "https://object",
  relocate: "/relocate",
  freeze: ["POST", "/freeze", null],
  unfreeze: ["POST", "/unfreeze", null],
  dump: "/dump",
  load: "/load",
  remove: ["POST", "/delete"],
};

type Stub = { fetch(req: Request): Promise<Response> };

async function call(stub: Stub, p: MovePaths, method: string, path: string, body: string | null = null, region?: Jurisdiction): Promise<Response> {
  // `x-region`: the object's R2 bucket (docs/cloud.md §1) — the copy's is the new region's
  const headers: Record<string, string> = { ...(body ? { "content-type": "application/json" } : {}), ...(region !== undefined ? { "x-region": region === "eu" ? "eu" : "default" } : {}) };
  const res = await stub.fetch(new Request(`${p.base}${path}`, { method, body, headers }));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text().catch(() => "")}`.trim());
  return res;
}

/**
 * Freeze → dump / load in pages → `flip` (the D1 row) → delete the old object. The target object is emptied first: one
 * left there by an earlier move whose delete failed would otherwise keep its stale rows under the copy's (the load is
 * INSERT OR REPLACE). Before the flip, a failure unfreezes the old object and deletes the partial copy, then answers 502;
 * after it, a failed delete leaves the old object (`oldDeleted` false: the caller records it for the cron).
 */
export async function moveObject(ns: ObjectNamespace | undefined, name: string, from: Jurisdiction, to: Jurisdiction, p: MovePaths, flip: () => Promise<void>, afterCopy?: AfterCopy): Promise<{ oldDeleted: boolean }> {
  if (from === to) {
    await flip();
    return { oldDeleted: true };
  }
  const old = stubOf(ns, from, name);
  let copy: Stub | null = null;
  let frozen = false;
  try {
    copy = stubOf(ns, to, name);
    await call(copy, p, p.remove[0], p.remove[1]);
    await call(old, p, p.freeze[0], p.freeze[1], p.freeze[2]);
    frozen = true;
    let after: string | null = null;
    do {
      const page = (await (await call(old, p, "GET", `${p.dump}${after ? `?after=${encodeURIComponent(after)}` : ""}`)).json()) as { rows: unknown[]; cursor: string | null };
      if (page.rows.length) await call(copy, p, "POST", p.load, JSON.stringify({ rows: page.rows }), to);
      after = page.cursor;
    } while (after);
    // R2 objects (docs/cloud.md §1): the copy's checkpoints into the new region's bucket, then the file's images
    for (let i = 0; i < 100; i++) {
      const r = (await (await call(copy, p, "POST", p.relocate, null, to)).json().catch(() => ({ done: true }))) as { done?: boolean };
      if (r.done !== false) break;
    }
    await afterCopy?.();
    await flip();
  } catch (e) {
    if (frozen) {
      try {
        await call(old, p, p.unfreeze[0], p.unfreeze[1], p.unfreeze[2]);
      } catch (u) {
        console.error("region: the old object wasn't unfrozen", name, u);
      }
    }
    if (copy) {
      try {
        await call(copy, p, p.remove[0], p.remove[1]);
      } catch (d) {
        console.error("region: the partial copy wasn't deleted", name, d);
      }
    }
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `moving ${name} failed: ${(e as Error).message}`);
  }
  try {
    await call(old, p, p.remove[0], p.remove[1]);
    return { oldDeleted: true };
  } catch (e) {
    console.error("region: the old object wasn't deleted", name, e);
    return { oldDeleted: false };
  }
}

export { ROOM_PATHS, LIBRARY_PATHS };

// ---- old objects left behind ------------------------------------------------------------------------------------------

type LeftoverKind = "room" | "library";
const regionName = (j: Jurisdiction) => (j === "eu" ? "eu" : "default");

async function leftover(d1: D1Like, kind: LeftoverKind, name: string, j: Jurisdiction, orgId: string, at: number): Promise<void> {
  await d1
    .prepare(`INSERT INTO region_leftovers (kind, name, jurisdiction, org_id, at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (kind, name, jurisdiction) DO UPDATE SET at = excluded.at`)
    .bind(kind, name, regionName(j), orgId, at)
    .run();
}

/** Leftovers deleted per cron run, and the tries after which one is only logged */
const LEFTOVERS_PER_RUN = 25;
const LEFTOVER_MAX_TRIES = 10;

/**
 * The daily cron: deletes the old objects moves left behind. One whose file or library lives in that jurisdiction
 * again (moved back since) is the live object now — its row is dropped, never the object.
 */
export async function sweepRegionLeftovers(deps: Deps): Promise<{ deleted: number; failed: number }> {
  const d1 = deps.db.d1;
  const { results } = await d1
    .prepare(`SELECT kind, name, jurisdiction FROM region_leftovers WHERE tries < ?1 ORDER BY at LIMIT ?2`)
    .bind(LEFTOVER_MAX_TRIES, LEFTOVERS_PER_RUN)
    .all<{ kind: LeftoverKind; name: string; jurisdiction: string }>();
  let deleted = 0;
  let failed = 0;
  for (const r of results) {
    const j: Jurisdiction = r.jurisdiction === "eu" ? "eu" : null;
    const forget = () => d1.prepare(`DELETE FROM region_leftovers WHERE kind = ?1 AND name = ?2 AND jurisdiction = ?3`).bind(r.kind, r.name, r.jurisdiction).run();
    const live = await d1
      .prepare(r.kind === "room" ? `SELECT jurisdiction FROM files WHERE key = ?1` : `SELECT jurisdiction FROM libraries WHERE key = ?1 AND status <> 'deleted'`)
      .bind(r.name)
      .first<{ jurisdiction: string | null }>();
    if (live && regionName(live.jurisdiction === "eu" ? "eu" : null) === r.jurisdiction) {
      await forget();
      continue;
    }
    try {
      const p = r.kind === "room" ? ROOM_PATHS : LIBRARY_PATHS;
      await call(stubOf(r.kind === "room" ? (deps.env as RegionEnv).ROOMS : libraries(deps), j, r.name), p, p.remove[0], p.remove[1]);
      await forget();
      deleted++;
    } catch (e) {
      console.error("region: a leftover object wasn't deleted", r.kind, r.name, r.jurisdiction, e);
      await d1.prepare(`UPDATE region_leftovers SET tries = tries + 1 WHERE kind = ?1 AND name = ?2 AND jurisdiction = ?3`).bind(r.kind, r.name, r.jurisdiction).run();
      failed++;
    }
  }
  return { deleted, failed };
}
