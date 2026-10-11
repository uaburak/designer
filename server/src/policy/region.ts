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
 *
 * Addressing: `roomsOn` (index.ts's `Rooms`) reads `files.jurisdiction` on every room call — no cache, a stale one would
 * wake an empty object in the old namespace — and `libraries/db.ts libraryFetch` reads `libraries.jurisdiction`.
 *
 * A move (one object): freeze the old one (sockets closed with 4012, writes refused 503 `moving`), copy its tables in
 * pages (`GET dump` → `POST load`, policy/dump.ts), flip the D1 row, delete the old object. A failure before the flip
 * unfreezes the old object and deletes the partial copy. Cloudflare can't relocate an object: moving is copying.
 */
import { DATA_REGION_LABEL, type DataRegion, type DataRegionStatus, type RoomPolicy } from "../../../src/shared/org/identity";
import type { Rooms } from "../api";
import { fileEntity, logActivity } from "../activity";
import type { D1Like } from "../db";
import { inJurisdiction, libraries, type ObjectNamespace } from "../libraries/db";
import { body, HttpError, json, type Ctx } from "../org/http";
import { encodeRoomPolicy } from "./roomPolicy";

type Jurisdiction = "eu" | null;
const jurisdictionOf = (region: DataRegion): Jurisdiction => (region === "eu" ? "eu" : null);

/** What the move needs of the Worker's env (index.ts passes the whole env as `deps.env`) */
export interface RegionEnv {
  /** The FileRoom namespace */
  ROOMS?: ObjectNamespace;
}

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
 * the Worker resolved (`x-user-id`, `x-user-name`, `x-role`) and the org's room policy (`x-policy`, §15.9).
 */
export function roomsOn(ns: ObjectNamespace, d1: D1Like): Rooms {
  return {
    async fetch(fileKey, path, init, original) {
      const stub = stubOf(ns, await fileJurisdiction(d1, fileKey), fileKey);
      const headers = new Headers(original?.headers);
      headers.delete("authorization");
      if (init.identity) {
        headers.set("x-user-id", init.identity.userId);
        headers.set("x-user-name", init.identity.name ?? "");
        headers.set("x-role", init.identity.role);
      }
      if (init.policy) headers.set("x-policy", encodeRoomPolicy(init.policy as RoomPolicy));
      return stub.fetch(new Request(`https://room${path}`, { method: init.method, headers, body: init.body }));
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

/** Moves the next file (then library) whose object isn't in the org's region yet. */
async function moveNext(ctx: Ctx, orgId: string): Promise<DataRegionStatus> {
  const { deps, user } = ctx;
  const d1 = deps.db.d1;
  const to = jurisdictionOf(await regionOf(d1, orgId));
  const file = await d1.prepare(`SELECT key, name, editor_type, link_access, proto_link_access, team_id, jurisdiction FROM files WHERE org_id = ?1 AND jurisdiction IS NOT ?2 ORDER BY key LIMIT 1`).bind(orgId, to).first<{ key: string; name: string; editor_type: string; link_access: string; proto_link_access: string; team_id: string | null; jurisdiction: string | null }>();
  if (file) {
    const from: Jurisdiction = file.jurisdiction === "eu" ? "eu" : null;
    await moveObject(regionEnv(ctx).ROOMS, file.key, from, to, ROOM_PATHS, async () => {
      await d1.prepare(`UPDATE files SET jurisdiction = ?2 WHERE key = ?1`).bind(file.key, to).run();
    });
    await logActivity(deps, { orgId, action: "fig_file_region_move", actor: user, entity: fileEntity(file), teamId: file.team_id, details: { object: "room", from: from ?? "default", to: to ?? "default" }, req: ctx.req });
    return dataRegionStatus(ctx, orgId, file.key);
  }
  const lib = await d1.prepare(`SELECT key, name, jurisdiction FROM libraries WHERE org_id = ?1 AND status <> 'deleted' AND jurisdiction IS NOT ?2 ORDER BY key LIMIT 1`).bind(orgId, to).first<{ key: string; name: string; jurisdiction: string | null }>();
  if (lib) {
    const from: Jurisdiction = lib.jurisdiction === "eu" ? "eu" : null;
    await moveObject(libraries(deps), lib.key, from, to, LIBRARY_PATHS, async () => {
      await d1.prepare(`UPDATE libraries SET jurisdiction = ?2 WHERE key = ?1`).bind(lib.key, to).run();
    });
    await logActivity(deps, { orgId, action: "fig_file_region_move", actor: user, entity: fileEntity({ key: lib.key, name: lib.name }), details: { object: "library", from: from ?? "default", to: to ?? "default" }, req: ctx.req });
    return dataRegionStatus(ctx, orgId, lib.key);
  }
  return dataRegionStatus(ctx, orgId);
}

// ---- moving one object ----------------------------------------------------------------------------------------------

interface MovePaths {
  base: string;
  freeze: [string, string, string | null];
  unfreeze: [string, string, string | null];
  dump: string;
  load: string;
  remove: [string, string];
}

const ROOM_PATHS: MovePaths = {
  base: "https://room",
  freeze: ["POST", "/room/freeze", JSON.stringify({ moving: true })],
  unfreeze: ["POST", "/room/unfreeze", JSON.stringify({ moving: true })],
  dump: "/room/dump",
  load: "/room/load",
  remove: ["DELETE", "/room"],
};

const LIBRARY_PATHS: MovePaths = {
  base: "https://object",
  freeze: ["POST", "/freeze", null],
  unfreeze: ["POST", "/unfreeze", null],
  dump: "/dump",
  load: "/load",
  remove: ["POST", "/delete"],
};

type Stub = { fetch(req: Request): Promise<Response> };

async function call(stub: Stub, p: MovePaths, method: string, path: string, body: string | null = null): Promise<Response> {
  const res = await stub.fetch(new Request(`${p.base}${path}`, { method, body, headers: body ? { "content-type": "application/json" } : {} }));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text().catch(() => "")}`.trim());
  return res;
}

/**
 * Freeze → dump / load in pages → `flip` (the D1 row) → delete the old object. Before the flip, a failure unfreezes the
 * old object and deletes the partial copy, then answers 502; after it, a failed delete only leaves an unused object.
 */
export async function moveObject(ns: ObjectNamespace | undefined, name: string, from: Jurisdiction, to: Jurisdiction, p: MovePaths, flip: () => Promise<void>): Promise<void> {
  if (from === to) return flip();
  const old = stubOf(ns, from, name);
  let copy: Stub | null = null;
  let frozen = false;
  try {
    copy = stubOf(ns, to, name);
    await call(old, p, p.freeze[0], p.freeze[1], p.freeze[2]);
    frozen = true;
    let after: string | null = null;
    do {
      const page = (await (await call(old, p, "GET", `${p.dump}${after ? `?after=${encodeURIComponent(after)}` : ""}`)).json()) as { rows: unknown[]; cursor: string | null };
      if (page.rows.length) await call(copy, p, "POST", p.load, JSON.stringify({ rows: page.rows }));
      after = page.cursor;
    } while (after);
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
  } catch (e) {
    console.error("region: the old object wasn't deleted", name, e);
  }
}

export { ROOM_PATHS, LIBRARY_PATHS };
