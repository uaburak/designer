/**
 * Libraries in organizations, the HTTP routes (docs/data.md §16.10). `:key` is a library's key: its file's room key.
 *
 * Consuming and publishing (`librariesRoute`, `fileLibrariesRoute`):
 *   GET   /libraries?file=<roomKey>                    {libraries: OrgLibraryRecord[]} usable in that file
 *   GET   /libraries/:key                              {library: OrgLibraryRecord}
 *   GET   /libraries/:key/versions/:n|latest           LibraryVersion
 *   POST  /libraries/:key/diff {have}                  LibraryDiff
 *   POST  /libraries/:key/payloads {wants, withDependencies}   octet-stream (libraryBox.ts)
 *   GET   /libraries/:key/blobs/:sha1                  bytes
 *   POST  /libraries/:key/missing {payloads, blobs}    the same shape: what the object lacks
 *   PUT   /libraries/:key/payloads/:assetKey/:hash     bytes → 204
 *   PUT   /libraries/:key/blobs/:sha1                  bytes → 204
 *   POST  /libraries/:key/bundle                       many payloads and blobs (libraryBox.ts readBundle) → 204: one
 *                                                      upload of the day however many it holds, each item's bytes charged
 *   POST  /libraries/:key/versions OrgPublishInput     {version, library}; 409 conflict on a stale baseVersion
 *   PATCH /libraries/:key {scope}                      {library: OrgLibraryInfo}
 *   POST  /libraries/:key/unpublish                    204
 *   GET   /files/:key/libraries                        FileLibraries
 *   PUT   /files/:key/libraries/:libraryKey {enabled}  FileLibraries
 *   …/libraries/:key/analytics/…                       analytics/query.ts
 *
 * Managing (`orgLibrariesRoute`, `teamLibrariesRoute`):
 *   GET   /orgs/:org/libraries?text=&workspace=&team=&approved=1&default=1   {libraries: OrgLibrarySummary[]}
 *   GET   /orgs/:org/libraries/analytics?…             analytics/query.ts (matched before :key)
 *   GET   /orgs/:org/libraries/:key                    {library: OrgLibraryInfo}
 *   PUT   /orgs/:org/libraries/:key/settings           LibrarySettingsInput → {library: OrgLibraryInfo}
 *   GET   /teams/:team/libraries                       {libraries: TeamLibraryRow[]}
 *
 * Free plan (§16.2): bulk writes are one statement over json_each (in chunks under D1's 2 MB value limit), bytes go
 * to the library's Durable Object untouched, the Worker reads no payload.
 */
import { libraryCounts, movesOf } from "../../../src/shared/store/libraryRules";
import { isSha1, type AssetKind, type LibraryAsset, type LibraryVersion } from "../../../src/shared/store/types";
import {
  LIBRARY_EDITOR_TYPES,
  type CollectionModes,
  type FileLibraries,
  type LibraryEditorType,
  type LibraryScope,
  type LibrarySettingsInput,
  type OrgLibraryInfo,
  type OrgLibraryRecord,
  type OrgLibrarySummary,
  type OrgPublishInput,
  type SettingScope,
  type TeamLibraryRow,
} from "../../../src/shared/libraries/orgTypes";
import type { ActivityAction } from "../../../src/shared/org/types";
import { fileEntity, logActivity } from "../activity";
import type { FileRow } from "../org/db";
import { body, HttpError, json, noContent, type Ctx } from "../org/http";
import { reauth } from "../org/reauth";
import { countFor, guardedUpload, reserveStorageMany } from "../quota/quota";
import { notifyLibraryOverride } from "../notifications";
import { adminSees, canManage, canUseLibrary, reachOf, usable, type Reach, type Via } from "./access";
import {
  contextScopes,
  defaultsOf,
  fileContext,
  libraryFetch,
  libraryRow,
  libName,
  countsOf,
  modesOf,
  movedInto,
  movedOutOf,
  orgLibraryRows,
  peopleIn,
  resolveSettings,
  scopeNames,
  scopeSettings,
  settingsFor,
  syncLibraryScope,
  toRecord,
  type FileContext,
  type LibRow,
  type SettingRow,
} from "./db";
import { libraryPublishedNotice, librarySettingsNotice, libraryStatusNotice } from "./notices";
import { MAX_BUNDLE_BYTES, readBundle, type BundleItem } from "./libraryBox";

const KEY = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_ASSETS = 20_000;
const ASSET_KINDS: AssetKind[] = ["COMPONENT", "COMPONENT_SET", "STYLE", "VARIABLE_COLLECTION", "VARIABLE"];
/** Rows per json_each statement: well under D1's 2 MB per bound value */
const ROWS_PER_STATEMENT = 2000;

const chunks = <T>(list: T[], n = ROWS_PER_STATEMENT): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};

// ---- access helpers -------------------------------------------------------------------------------------------------

/** The caller can edit the library's file (an org file): its row and access, or the refusal */
async function editable(ctx: Ctx, key: string) {
  const f = await ctx.acc.fileRow(key);
  if (!f) throw new HttpError(404, "no such file");
  const a = await ctx.acc.openFile(f, { viaLink: true, passOk: false });
  if (!a.ok) throw new HttpError(404, "no such file");
  if (!f.org_id) throw new HttpError(400, "only files in an organization publish organization libraries");
  if (a.trashed) throw new HttpError(403, "the file is in the trash");
  if (!a.canEdit) {
    if (a.capped === "seat") throw new HttpError(403, "your seat can't edit this file", "seat_required", { seat: "full" });
    throw new HttpError(403, "you can only view this file");
  }
  return { f, a };
}

/** A published library the caller can use (§16.4), or 404 */
async function usableLibrary(ctx: Ctx, key: string): Promise<{ lib: LibRow; via: Via[]; reach: Reach }> {
  const lib = await libraryRow(ctx.acc.d1, key);
  if (!lib) throw new HttpError(404, "no such library");
  const reach = await reachOf(ctx.acc, lib.org_id);
  const via = await canUseLibrary(ctx.acc, lib, reach);
  if (!via.length) throw new HttpError(404, "no such library");
  // Governance+ gates (§2.5) for the org's people (a library is the org's; people outside it have no gate)
  await ctx.acc.checkGate(lib.org_id);
  return { lib, via, reach };
}

/** The caller's own context, for records outside a file: their workspace, Design files */
const callerContext = (r: Reach): FileContext => ({ orgId: r.orgId, teamId: null, workspaceId: r.membership?.workspace_id ?? null, editorType: "design" });

/** Records of `list`, relative to `c` (settings, moves and publishers read in three queries) */
async function records(ctx: Ctx, list: { lib: LibRow; via: Via[] }[], c: FileContext): Promise<OrgLibraryRecord[]> {
  if (!list.length) return [];
  const d1 = ctx.acc.d1;
  const keys = list.map((x) => x.lib.key);
  const rows = await settingsFor(d1, keys, contextScopes(c));
  const moved = await movedInto(d1, keys);
  const people = await peopleIn(d1, c.orgId, list.map((x) => x.lib.published_by));
  return list.map(({ lib, via }) =>
    toRecord(lib, { settings: resolveSettings(rows.filter((r) => r.library_key === lib.key), c), via, movedIn: moved.get(lib.key) ?? [], publishedBy: lib.published_by ? (people.get(lib.published_by) ?? null) : null }),
  );
}

/** The libraries usable in an org file, other than its own (§16.4: same org; trashed and unpublished list nowhere) */
async function availableIn(ctx: Ctx, f: FileRow): Promise<{ list: { lib: LibRow; via: Via[] }[]; c: FileContext } | null> {
  const c = await fileContext(ctx.acc.d1, f);
  if (!c) return null;
  const reach = await reachOf(ctx.acc, c.orgId);
  const rows = (await orgLibraryRows(ctx.acc.d1, c.orgId)).filter((l) => l.key !== f.key);
  return { list: await usable(ctx.acc, reach, rows), c };
}

// ---- /libraries -----------------------------------------------------------------------------------------------------

export async function librariesRoute(ctx: Ctx): Promise<Response> {
  const { parts, m, url, req, acc, deps } = ctx;
  if (parts.length === 1) {
    if (m !== "GET") throw new HttpError(405, "method not allowed");
    const fileKey = url.searchParams.get("file") ?? "";
    if (!KEY.test(fileKey)) throw new HttpError(400, "file is a file's key");
    const f = await acc.fileRow(fileKey);
    const a = f ? await acc.openFile(f, { viaLink: true, passOk: false }) : null;
    if (!f || !a?.ok) throw new HttpError(404, "no such file");
    // Figma's rule (§16.2): org libraries are offered in that org's files only; a file outside any org lists none.
    const av = await availableIn(ctx, f);
    return json({ libraries: av ? await records(ctx, av.list, av.c) : [] });
  }
  const key = parts[1];
  if (!KEY.test(key)) throw new HttpError(400, "bad library key");
  const sub = parts[2];

  if (sub === "analytics") return (await import("../analytics/query")).libraryAnalyticsRoute(ctx, key);

  if (parts.length === 2 && m === "GET") {
    const { lib, via, reach } = await usableLibrary(ctx, key);
    return json({ library: (await records(ctx, [{ lib, via }], callerContext(reach)))[0] });
  }
  if (parts.length === 2 && m === "PATCH") return setScope(ctx, key);
  if (parts.length === 3 && sub === "unpublish" && m === "POST") {
    await editable(ctx, key);
    const r = await acc.d1.prepare(`UPDATE libraries SET status = 'unpublished' WHERE key = ?1 AND status = 'published' RETURNING key`).bind(key).first();
    if (r) await (await libraryStatusNotice(deps, key))("unpublished");
    return noContent();
  }
  if (parts.length === 3 && sub === "versions" && m === "POST") return publish(ctx, key);

  // Writes of bytes before a publish: the file's editors (the library may not exist yet).
  if (parts.length === 3 && sub === "missing" && m === "POST") {
    await editable(ctx, key);
    const b = await body<{ payloads?: unknown; blobs?: unknown }>(req);
    const payloads = Array.isArray(b.payloads) ? b.payloads : [];
    const blobs = Array.isArray(b.blobs) ? b.blobs : [];
    if (payloads.length > MAX_ASSETS || blobs.length > MAX_ASSETS) throw new HttpError(400, "too many");
    if (!payloads.every((p) => isSha1((p as { key?: unknown })?.key) && isSha1((p as { versionHash?: unknown })?.versionHash)) || !blobs.every(isSha1)) throw new HttpError(400, "payloads are {key, versionHash} and blobs SHA-1s");
    return libraryFetch(deps, key, "/missing", { method: "POST", body: JSON.stringify({ payloads: payloads.map((p) => ({ key: (p as { key: string }).key, versionHash: (p as { versionHash: string }).versionHash })), blobs }) });
  }
  if (parts.length === 3 && sub === "bundle" && m === "POST") return bundle(ctx, key);
  if (parts.length === 5 && sub === "payloads" && m === "PUT") {
    if (!isSha1(parts[3]) || !isSha1(parts[4])) throw new HttpError(400, "an asset key and its versionHash are SHA-1s");
    await editable(ctx, key);
    // Daily uploads and stored bytes (docs/multiplayer.md §17), charged to the publisher, before the body is read
    const up = await guardedUpload(deps, req, ctx.user, { ownerId: ctx.user.id, item: `l:${key}:p:${parts[3]}:${parts[4]}` }, MAX_BYTES, "larger than 50 MB");
    const res = await libraryFetch(deps, key, `/payload/${parts[3]}/${parts[4]}`, { method: "PUT", body: up.body });
    if (res.ok) await up.commit();
    return res;
  }
  if (parts.length === 4 && sub === "blobs" && m === "PUT") {
    if (!isSha1(parts[3])) throw new HttpError(400, "bad SHA-1");
    await editable(ctx, key);
    const up = await guardedUpload(deps, req, ctx.user, { ownerId: ctx.user.id, item: `l:${key}:b:${parts[3]}` }, MAX_BYTES, "larger than 50 MB");
    const res = await libraryFetch(deps, key, `/blob/${parts[3]}`, { method: "PUT", body: up.body });
    if (res.ok) await up.commit();
    return res;
  }

  // Reads: anyone who can use the library.
  if (parts.length === 4 && sub === "versions" && m === "GET") {
    if (parts[3] !== "latest" && !/^\d{1,9}$/.test(parts[3])) throw new HttpError(400, "a version number or latest");
    await usableLibrary(ctx, key);
    return libraryFetch(deps, key, `/version/${parts[3]}`);
  }
  if (parts.length === 3 && sub === "diff" && m === "POST") {
    await usableLibrary(ctx, key);
    const b = await body<{ have?: unknown }>(req);
    const have = Array.isArray(b.have) ? b.have.filter((h) => isSha1((h as { key?: unknown })?.key) && typeof (h as { versionHash?: unknown })?.versionHash === "string") : [];
    if (have.length > 100_000) throw new HttpError(400, "too many");
    return libraryFetch(deps, key, "/diff", { method: "POST", body: JSON.stringify({ have, movedOut: await movedOutOf(acc.d1, key) }) });
  }
  if (parts.length === 3 && sub === "payloads" && m === "POST") {
    await usableLibrary(ctx, key);
    const b = await body<{ wants?: unknown; withDependencies?: unknown }>(req);
    const wants = Array.isArray(b.wants) ? b.wants : [];
    if (wants.length > MAX_ASSETS) throw new HttpError(400, "too many");
    return libraryFetch(deps, key, "/payloads", { method: "POST", body: JSON.stringify({ wants, withDependencies: b.withDependencies === true }) });
  }
  if (parts.length === 4 && sub === "blobs" && m === "GET") {
    if (!isSha1(parts[3])) throw new HttpError(400, "bad SHA-1");
    await usableLibrary(ctx, key);
    return libraryFetch(deps, key, `/blob/${parts[3]}`);
  }
  throw new HttpError(404, "not found");
}


/**
 * POST /libraries/:key/bundle: a publish's payloads and images in one request (a publish is one operation, as in
 * Figma): one `uploads_per_day` count for the request, every item's bytes charged to the publisher as its single PUT
 * would charge them, and one write into the library's object (/batch, which checks each item as the single PUTs do).
 */
async function bundle(ctx: Ctx, key: string): Promise<Response> {
  const { req, deps } = ctx;
  await editable(ctx, key);
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BUNDLE_BYTES) throw new HttpError(413, "a bundle is 32 MB at most");
  await countFor(deps, ctx.user, "uploads_per_day");
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_BUNDLE_BYTES) throw new HttpError(413, "a bundle is 32 MB at most");
  let items: BundleItem[];
  try {
    items = readBundle(new Uint8Array(buf));
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  if (!items.length) return noContent();
  if (items.some((i) => i.bytes.length > MAX_BYTES)) throw new HttpError(413, "larger than 50 MB");
  const charges = items.map((i) => ({ item: i.type === "payload" ? `l:${key}:p:${i.key}:${i.versionHash}` : `l:${key}:b:${i.sha1}`, bytes: i.bytes.length }));
  const reservation = await reserveStorageMany(deps, ctx.user.id, charges);
  const res = await libraryFetch(deps, key, "/batch", { method: "POST", body: buf });
  if (res.ok) await reservation.commit();
  return res;
}

// ---- publishing (§16.6) ---------------------------------------------------------------------------------------------

type PublishInput = Omit<OrgPublishInput, "scope"> & { scope?: LibraryScope };

function cleanPublish(v: Record<string, unknown>): PublishInput {
  const base = v.baseVersion;
  if (typeof base !== "number" || !Number.isInteger(base) || base < 0) throw new HttpError(400, "baseVersion is the latest version (0 for a first publish)");
  // Absent (PublishRequest.scope is optional): the file's current scope stays — its org link decides.
  if (v.scope !== undefined && v.scope !== "team" && v.scope !== "org") throw new HttpError(400, "scope is team or org");
  if (!Array.isArray(v.assets) || v.assets.length > MAX_ASSETS) throw new HttpError(400, `assets is a list of at most ${MAX_ASSETS}`);
  const seen = new Set<string>();
  for (const a of v.assets as LibraryAsset[]) {
    if (!a || !isSha1(a.key) || !isSha1(a.versionHash)) throw new HttpError(400, `an asset needs a key and a versionHash (SHA-1s): ${a?.key}`);
    if (seen.has(a.key)) throw new HttpError(400, `asset ${a.key} is listed twice`);
    seen.add(a.key);
    if (!ASSET_KINDS.includes(a.kind)) throw new HttpError(400, `asset ${a.key}: kind`);
    if (typeof a.name !== "string") throw new HttpError(400, `asset ${a.key}: name`);
    if (a.thumbnail !== null && a.thumbnail !== undefined && !isSha1(a.thumbnail.sha1)) throw new HttpError(400, `asset ${a.key}: thumbnail`);
  }
  const ch = (v.changes ?? {}) as Partial<OrgPublishInput["changes"]>;
  const list = (x: unknown) => (Array.isArray(x) ? x : []);
  return {
    baseVersion: base,
    description: typeof v.description === "string" ? v.description.slice(0, 5000) : "",
    ...(v.scope ? { scope: v.scope as LibraryScope } : {}),
    assets: (v.assets as LibraryAsset[]).map((a) => ({ ...a, description: typeof a.description === "string" ? a.description : "", dependencyOnly: a.dependencyOnly === true, dependencies: list(a.dependencies).filter(isSha1), thumbnail: a.thumbnail ?? null })),
    changes: { created: list(ch.created), modified: list(ch.modified), removed: list(ch.removed), moved: list(ch.moved) },
    moves: list(v.moves).filter((x) => x && isSha1(x.key) && typeof x.fromLibraryFileKey === "string" && isSha1(x.fromKey) && (x.mode === "move" || x.mode === "copy")),
    collections: list(v.collections).filter((c) => c && typeof c.collectionKey === "string" && Array.isArray(c.modes)),
  };
}

async function publish(ctx: Ctx, key: string): Promise<Response> {
  const { acc, deps, user, req } = ctx;
  const { f, a } = await editable(ctx, key);
  // §9.3 and §15: drafts and branches can't publish.
  if (!f.project_id) throw new HttpError(403, "drafts can't be published; move the file to a team first", "draft_cannot_publish");
  if (await acc.branch(key)) throw new HttpError(403, "branches can't publish; merge into the main file first", "branch_cannot_publish");
  const m = await acc.membership(f.org_id!);
  if (m?.role === "guest" || (m && m.seat !== "full")) throw new HttpError(403, "publishing needs a Full seat", "seat_required", { seat: "full" });
  const input = cleanPublish(await body(req));
  const now = deps.now();

  const res = await libraryFetch(deps, key, "/commit", {
    method: "POST",
    body: JSON.stringify({ libraryFileKey: key, baseVersion: input.baseVersion, publishedAt: now, description: input.description, changes: input.changes, assets: input.assets }),
  });
  if (res.status === 409) throw new HttpError(409, "someone published this library meanwhile", "conflict", { latest: ((await res.json()) as { latest: number }).latest });
  if (res.status === 400) {
    const e = (await res.json()) as { error: string; missing: string[] };
    throw new HttpError(400, e.error, "invalid", { missing: e.missing });
  }
  if (!res.ok) throw new HttpError(502, "the library's storage refused the version");
  const { version } = (await res.json()) as { version: LibraryVersion };
  const n = version.version;
  const d1 = acc.d1;

  // D1 after the object (idempotent): the row, the version, the asset list, the redirects.
  const scope = await scopeOf(ctx, f, a.canShare || a.canManage, input.scope);
  await d1
    .prepare(
      `INSERT INTO libraries (key, org_id, name, scope, status, latest_version, counts, first_published_at, last_published_at, published_by, jurisdiction)
       VALUES (?1, ?2, ?3, ?4, 'published', ?5, ?6, ?7, ?7, ?8, (SELECT CASE data_region WHEN 'eu' THEN 'eu' END FROM orgs WHERE id = ?2))
       ON CONFLICT (key) DO UPDATE SET name = excluded.name, scope = excluded.scope, status = 'published', latest_version = MAX(latest_version, excluded.latest_version),
         counts = excluded.counts, last_published_at = excluded.last_published_at, published_by = excluded.published_by`,
    )
    .bind(key, f.org_id, f.name, scope, n, JSON.stringify(libraryCounts(input.assets)), now, user.id)
    .run();
  const changes = { created: input.changes.created.length, modified: input.changes.modified.length, removed: input.changes.removed.length, moved: input.changes.moved.length };
  await d1.prepare(`INSERT OR IGNORE INTO library_versions (library_key, version, description, changes, published_at, published_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).bind(key, n, input.description, JSON.stringify(changes), now, user.id).run();
  const before = await assetNames(ctx, key);
  await writeAssets(ctx, key, n, input);
  const redirects = movesOf(input.moves, key, n, now);
  for (const part of chunks(redirects)) {
    await d1
      .prepare(
        `INSERT OR REPLACE INTO library_redirects (from_library, from_key, to_library, to_key, version, at)
         SELECT e.value ->> 'fromLibraryFileKey', e.value ->> 'fromKey', e.value ->> 'toLibraryFileKey', e.value ->> 'toKey', e.value ->> 'version', e.value ->> 'at' FROM json_each(?1) e`,
      )
      .bind(JSON.stringify(part))
      .run();
  }

  // A version history checkpoint (§16.1), in the file's room (§15.7.1).
  try {
    await deps.rooms.fetch(key, "/room/versions", { method: "POST", identity: { userId: user.id, name: user.name, role: "editor" }, body: JSON.stringify({ kind: "publish", title: input.description.slice(0, 200) || null, libraryVersion: n }) });
  } catch (e) {
    console.error("libraries: no publish checkpoint", key, e);
  }
  await libraryPublishedNotice(deps, key, n);
  // LIBRARY_PUBLISH, one event per asset type that changed (docs/multiplayer.md §16.9)
  const named = new Map(input.assets.filter((x) => !x.dependencyOnly).map((x) => [x.key, { key: x.key, kind: x.kind, name: x.name }]));
  const pick = (keys: unknown[], from: Map<string, { key: string; kind: string; name: string }>) => keys.filter((k): k is string => typeof k === "string" && from.has(k)).map((k) => from.get(k)!);
  await (await import("../webhooks/events")).libraryPublished(deps, key, user, input.description, { created: pick(input.changes.created, named), modified: pick(input.changes.modified, named), deleted: pick(input.changes.removed, before) });

  const lib = (await libraryRow(d1, key))!;
  const reach = await reachOf(acc, lib.org_id);
  const c = (await fileContext(d1, f))!;
  return json({ version, library: (await records(ctx, [{ lib, via: await canUseLibrary(acc, lib, reach) }], c))[0] }, 201);
}

/** The library's assets as they were (names of what a publish removes) */
async function assetNames(ctx: Ctx, key: string): Promise<Map<string, { key: string; kind: string; name: string }>> {
  const { results } = await ctx.acc.d1.prepare(`SELECT key, kind, name FROM library_assets WHERE library_key = ?1 AND dependency_only = 0`).bind(key).all<{ key: string; kind: string; name: string }>();
  return new Map(results.map((r) => [r.key, r]));
}

/** library_assets: upserts what is new or changed (fewer rows written), marks what left the manifest (§16.11); the REST
 *  API's node id (the manifest's guid) and dates (docs/multiplayer.md §16.10, 0015). */
async function writeAssets(ctx: Ctx, key: string, n: number, input: PublishInput): Promise<void> {
  const d1 = ctx.acc.d1;
  const { results: had } = await d1.prepare(`SELECT key, version_hash, removed_in FROM library_assets WHERE library_key = ?1`).bind(key).all<{ key: string; version_hash: string; removed_in: number | null }>();
  const before = new Map(had.map((r) => [r.key, r]));
  const modes = new Map(input.collections.map((c) => [c.collectionKey, c.modes]));
  const rows = input.assets
    .filter((a) => {
      const b = before.get(a.key);
      return !b || b.version_hash !== a.versionHash || b.removed_in !== null;
    })
    .map((a) => ({
      key: a.key,
      kind: a.kind,
      name: a.name.slice(0, 500),
      description: (a.description ?? "").slice(0, 5000),
      style: a.styleType ?? null,
      resolved: a.resolvedType ?? null,
      set: a.componentSetKey ?? null,
      collection: a.collectionKey ?? null,
      modes: a.kind === "VARIABLE_COLLECTION" && modes.has(a.key) ? JSON.stringify(modes.get(a.key)) : null,
      hash: a.versionHash,
      dep: a.dependencyOnly ? 1 : 0,
      thumb: a.thumbnail?.sha1 ?? null,
      guid: typeof a.guid === "string" && a.guid ? a.guid : null,
    }));
  const at = ctx.deps.now();
  for (const part of chunks(rows)) {
    await d1
      .prepare(
        `INSERT INTO library_assets (library_key, key, kind, name, description, style_type, resolved_type, component_set_key, collection_key, modes, version_hash, dependency_only, thumbnail_sha1, removed_in,
           node_id, created_at, updated_at, created_by)
         SELECT ?1, e.value ->> 'key', e.value ->> 'kind', e.value ->> 'name', e.value ->> 'description', e.value ->> 'style', e.value ->> 'resolved', e.value ->> 'set',
                e.value ->> 'collection', e.value ->> 'modes', e.value ->> 'hash', e.value ->> 'dep', e.value ->> 'thumb', NULL, e.value ->> 'guid', ?3, ?3, ?4
         FROM json_each(?2) e WHERE true
         ON CONFLICT (library_key, key) DO UPDATE SET kind = excluded.kind, name = excluded.name, description = excluded.description, style_type = excluded.style_type,
           resolved_type = excluded.resolved_type, component_set_key = excluded.component_set_key, collection_key = excluded.collection_key, modes = excluded.modes,
           version_hash = excluded.version_hash, dependency_only = excluded.dependency_only, thumbnail_sha1 = excluded.thumbnail_sha1, removed_in = NULL,
           node_id = COALESCE(excluded.node_id, library_assets.node_id), updated_at = excluded.updated_at,
           created_at = COALESCE(library_assets.created_at, excluded.created_at), created_by = COALESCE(library_assets.created_by, excluded.created_by)`,
      )
      .bind(key, JSON.stringify(part), at, ctx.user.id)
      .run();
  }
  const now = new Set(input.assets.map((a) => a.key));
  const gone = had.filter((r) => r.removed_in === null && !now.has(r.key)).map((r) => r.key);
  for (const part of chunks(gone)) await d1.prepare(`UPDATE library_assets SET removed_in = ?2 WHERE library_key = ?1 AND key IN (SELECT value FROM json_each(?3))`).bind(key, n, JSON.stringify(part)).run();
}

/**
 * "Allow any member of ‹org› to access the file" ⇔ the org link (§16.2): `org` turns "Anyone at ‹org›" on (can view)
 * when it was off; `team` turns it off. Only people who can change the link change it; for the others the link
 * decides. Returns the scope that now holds.
 */
async function scopeOf(ctx: Ctx, f: FileRow, canShare: boolean, wanted: LibraryScope | undefined): Promise<LibraryScope> {
  const current: LibraryScope = f.org_link_access === "none" ? "team" : "org";
  if (!wanted || wanted === current || !canShare) return current;
  await setOrgLink(ctx, f, wanted === "org" ? "viewer" : "none");
  return wanted;
}

async function setOrgLink(ctx: Ctx, f: FileRow, to: "none" | "viewer"): Promise<void> {
  const { acc, deps, user, req } = ctx;
  if (f.org_link_access === to) return;
  await acc.d1.prepare(`UPDATE files SET org_link_access = ?2, updated_at = ?3 WHERE key = ?1`).bind(f.key, to, deps.now()).run();
  await logActivity(deps, { orgId: f.org_id!, action: "fig_file_link_access_change", actor: user, entity: fileEntity(f), teamId: f.team_id, details: { link: "org", from: f.org_link_access, to }, req });
  if (to === "none") await reauth(deps, [f.key]);
  acc.reset();
  await syncLibraryScope(deps, f.key, to);
}

/** PATCH /libraries/:key {scope}: the file's sharers (§16.10) */
async function setScope(ctx: Ctx, key: string): Promise<Response> {
  const { acc, req } = ctx;
  const f = await acc.fileRow(key);
  const a = f ? await acc.openFile(f, { viaLink: true, passOk: false }) : null;
  if (!f || !a?.ok) throw new HttpError(404, "no such library");
  if (!(await libraryRow(acc.d1, key))) throw new HttpError(404, "no such library");
  if (a.trashed || !(a.canShare || a.canManage)) throw new HttpError(403, "only people who can share the file can change who can use the library");
  const { scope } = await body<{ scope?: unknown }>(req);
  if (scope !== "team" && scope !== "org") throw new HttpError(400, "scope is team or org");
  await scopeOf(ctx, f, true, scope);
  const lib = (await libraryRow(acc.d1, key))!;
  return json({ library: await info(ctx, await reachOf(acc, lib.org_id), lib) });
}

// ---- a file's libraries (§16.5 subscriptions) ---------------------------------------------------------------------

export async function fileLibrariesRoute(ctx: Ctx): Promise<Response> {
  const { parts, m, acc, req, deps, user } = ctx;
  const key = parts[1];
  const f = await acc.fileRow(key);
  const a = f ? await acc.openFile(f, { viaLink: true, passOk: false }) : null;
  if (!f || !a?.ok) throw new HttpError(404, "no such file");
  if (parts.length === 3 && m === "GET") return json(await fileLibraries(ctx, f));
  if (parts.length === 4 && m === "PUT") {
    if (a.trashed || !a.canEdit) throw new HttpError(403, "you can only view this file");
    const libKey = parts[3];
    const { enabled } = await body<{ enabled?: unknown }>(req);
    if (enabled !== true && enabled !== false && enabled !== null) throw new HttpError(400, "enabled is true, false or null");
    if (enabled === true) {
      const lib = await libraryRow(acc.d1, libKey);
      if (!lib || lib.org_id !== f.org_id || lib.key === f.key || !(await canUseLibrary(acc, lib)).length) throw new HttpError(404, "no such library");
    } else if (!(await acc.d1.prepare(`SELECT 1 AS x FROM libraries WHERE key = ?1`).bind(libKey).first())) throw new HttpError(404, "no such library");
    if (enabled === null) await acc.d1.prepare(`DELETE FROM library_subscriptions WHERE file_key = ?1 AND library_key = ?2`).bind(key, libKey).run();
    else {
      await acc.d1
        .prepare(`INSERT INTO library_subscriptions (file_key, library_key, enabled, changed_by, changed_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (file_key, library_key) DO UPDATE SET enabled = ?3, changed_by = ?4, changed_at = ?5`)
        .bind(key, libKey, enabled ? 1 : 0, user.id, deps.now())
        .run();
    }
    return json(await fileLibraries(ctx, f));
  }
  throw new HttpError(405, "method not allowed");
}

/** Effective = the file's explicit choices over the defaults (§16.5) */
async function fileLibraries(ctx: Ctx, f: FileRow): Promise<FileLibraries> {
  const { results } = await ctx.acc.d1.prepare(`SELECT library_key, enabled FROM library_subscriptions WHERE file_key = ?1 ORDER BY changed_at`).bind(f.key).all<{ library_key: string; enabled: number }>();
  const overrides = results.map((r) => ({ libraryKey: r.library_key, enabled: r.enabled === 1 }));
  const av = await availableIn(ctx, f);
  const defaults = av ? (await records(ctx, av.list, av.c)).filter((r) => r.org.enabledByDefault).map((r) => r.libraryFileKey) : [];
  const off = new Set(overrides.filter((o) => !o.enabled).map((o) => o.libraryKey));
  const enabled = [...new Set([...overrides.filter((o) => o.enabled).map((o) => o.libraryKey), ...defaults.filter((k) => !off.has(k))])];
  return { enabled, defaults, overrides };
}

// ---- managing (Admin › Resources › Libraries, team settings) --------------------------------------------------------

/** Summaries of `libs` (settings and the roll-up's "Inserts last week" read in two queries) */
async function summaries(ctx: Ctx, libs: LibRow[], rows?: SettingRow[]): Promise<OrgLibrarySummary[]> {
  if (!libs.length) return [];
  const d1 = ctx.acc.d1;
  const keys = libs.map((l) => l.key);
  const settings = rows ?? (await settingsFor(d1, keys, "all"));
  const { results: stats } = await d1.prepare(`SELECT library_key, inserts_last_week FROM library_stats WHERE library_key IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(keys)).all<{ library_key: string; inserts_last_week: number }>();
  const inserts = new Map(stats.map((s) => [s.library_key, s.inserts_last_week]));
  return libs.map((l) => {
    const mine = settings.filter((r) => r.library_key === l.key);
    const org = mine.find((r) => r.scope_type === "org") ?? null;
    const on = (r: SettingRow) => LIBRARY_EDITOR_TYPES.some((t) => defaultsOf(r)[t] === true);
    return {
      key: l.key,
      name: libName(l),
      orgId: l.org_id,
      teamId: l.team_id,
      teamName: l.team_name,
      workspaceId: l.workspace_id,
      scope: l.scope,
      status: l.status,
      latestVersion: l.latest_version,
      lastPublishedAt: l.last_published_at,
      counts: countsOf(l),
      thumbnailUrl: null,
      approved: { org: org?.approved === 1, workspaceIds: mine.filter((r) => r.scope_type === "workspace" && r.approved === 1).map((r) => r.scope_id) },
      defaultIn: {
        org: LIBRARY_EDITOR_TYPES.filter((t) => defaultsOf(org)[t] === true),
        workspaceIds: mine.filter((r) => r.scope_type === "workspace" && on(r)).map((r) => r.scope_id),
        teamIds: mine.filter((r) => r.scope_type === "team" && on(r)).map((r) => r.scope_id),
      },
      insertsLastWeek: inserts.get(l.key) ?? 0,
    };
  });
}

/** "Manage this library": the summary, the collections' modes, the rows the caller may see, what they may change */
async function info(ctx: Ctx, r: Reach, lib: LibRow): Promise<OrgLibraryInfo> {
  const d1 = ctx.acc.d1;
  const all = await settingsFor(d1, [lib.key], "all");
  const [summary] = await summaries(ctx, [lib], all);
  const { results: cols } = await d1
    .prepare(`SELECT key, name, modes FROM library_assets WHERE library_key = ?1 AND kind = 'VARIABLE_COLLECTION' AND removed_in IS NULL ORDER BY name`)
    .bind(lib.key)
    .all<{ key: string; name: string; modes: string | null }>();
  const collections: CollectionModes[] = cols.map((c) => ({ collectionKey: c.key, name: c.name, modes: parseModes(c.modes) }));
  const adminWorkspaceTeams = new Set([...r.allTeams].filter(([, ws]) => ws && r.workspaces.has(ws)).map(([id]) => id));
  const sees = (s: SettingRow) =>
    r.orgAdmin ||
    s.scope_type === "org" ||
    (s.scope_type === "workspace" && (r.workspaces.has(s.scope_id) || r.membership?.workspace_id === s.scope_id)) ||
    (s.scope_type === "team" && (r.teams.has(s.scope_id) || r.adminTeams.has(s.scope_id) || adminWorkspaceTeams.has(s.scope_id)));
  return { ...summary, collections, settings: await scopeSettings(d1, lib.org_id, all.filter(sees)), canManage: await canManage(ctx.acc, r, lib) };
}

const parseModes = (s: string | null): { id: string; name: string }[] => {
  try {
    const v = JSON.parse(s ?? "[]") as { id: string; name: string }[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/** /orgs/:org/libraries… (api.ts dispatches `parts[2] === "libraries"` here) */
export async function orgLibrariesRoute(ctx: Ctx): Promise<Response> {
  const { parts, m, url, acc } = ctx;
  const orgId = parts[1];
  if (parts[3] === "analytics") return (await import("../analytics/query")).orgAnalyticsRoute(ctx, orgId);
  await acc.requireMember(orgId, { guests: true });
  const r = await reachOf(acc, orgId);
  if (parts.length === 3 && m === "GET") {
    const rows = await orgLibraryRows(acc.d1, orgId);
    const usableKeys = new Set((await usable(acc, r, rows.filter((l) => !adminSees(r, l)))).map((x) => x.lib.key));
    let libs = rows.filter((l) => adminSees(r, l) || usableKeys.has(l.key));
    const text = url.searchParams.get("text")?.trim().toLowerCase();
    if (text) libs = libs.filter((l) => libName(l).toLowerCase().includes(text));
    const ws = url.searchParams.get("workspace");
    if (ws) libs = libs.filter((l) => l.workspace_id === ws);
    const team = url.searchParams.get("team");
    if (team) libs = libs.filter((l) => l.team_id === team);
    let out = await summaries(ctx, libs);
    if (url.searchParams.get("approved") === "1") out = out.filter((s) => s.approved.org || (ws ? s.approved.workspaceIds.includes(ws) : s.approved.workspaceIds.length > 0));
    if (url.searchParams.get("default") === "1") out = out.filter((s) => s.defaultIn.org.length > 0 || s.defaultIn.workspaceIds.length > 0 || s.defaultIn.teamIds.length > 0);
    // Approved libraries are pinned to the top (§16.1).
    out.sort((a, b) => Number(b.approved.org || b.approved.workspaceIds.length > 0) - Number(a.approved.org || a.approved.workspaceIds.length > 0));
    return json({ libraries: out });
  }
  const key = parts[3];
  const lib = key ? await libraryRow(acc.d1, key) : null;
  if (!lib || lib.org_id !== orgId || lib.status === "deleted" || !(adminSees(r, lib) || (await canUseLibrary(acc, lib, r)).length)) throw new HttpError(404, "no such library");
  if (parts.length === 4 && m === "GET") return json({ library: await info(ctx, r, lib) });
  if (parts.length === 5 && parts[4] === "settings" && m === "PUT") return updateSettings(ctx, r, lib);
  throw new HttpError(404, "not found");
}

/** PUT /orgs/:org/libraries/:key/settings (§16.5's table) */
async function updateSettings(ctx: Ctx, r: Reach, lib: LibRow): Promise<Response> {
  const { acc, deps, user, req } = ctx;
  const d1 = acc.d1;
  const input = await body<LibrarySettingsInput>(req);
  const scope = input.scope as SettingScope | undefined;
  if (!scope || (scope.type !== "org" && scope.type !== "workspace" && scope.type !== "team") || typeof scope.id !== "string") throw new HttpError(400, "scope is {type: org | workspace | team, id}");
  if (scope.type === "org" && scope.id !== lib.org_id) throw new HttpError(400, "not this organization");
  if (scope.type === "workspace" && !(await d1.prepare(`SELECT 1 AS x FROM workspaces WHERE id = ?1 AND org_id = ?2`).bind(scope.id, lib.org_id).first())) throw new HttpError(400, "no such workspace");
  if (scope.type === "team" && !r.allTeams.has(scope.id)) throw new HttpError(400, "no such team");
  if (input.approved !== undefined && (typeof input.approved !== "boolean" || scope.type === "team")) throw new HttpError(400, "approved is a boolean, for the organization or a workspace");
  if (input.defaultModes !== undefined && scope.type === "org") throw new HttpError(400, "default modes are set for a workspace or a team");
  if (lib.status !== "published") throw new HttpError(409, "the library isn't published");

  const may = await canManage(acc, r, lib);
  const allowed = scope.type === "org" ? may.org : scope.type === "workspace" ? may.workspaceIds.includes(scope.id) : may.teamIds.includes(scope.id);
  if (!allowed) throw new HttpError(403, scope.type === "team" && !r.adminTeams.has(scope.id) && !r.orgAdmin ? "only the team's admins can change its libraries" : "only admins can change this", "not_admin");

  const before = (await settingsFor(d1, [lib.key], [scope]))[0] ?? null;
  const defaults = defaultsOf(before);
  if (input.defaults !== undefined) {
    if (!input.defaults || typeof input.defaults !== "object") throw new HttpError(400, "defaults is {design?, figjam?, slides?, buzz?}");
    for (const t of LIBRARY_EDITOR_TYPES) {
      const v = (input.defaults as Record<string, unknown>)[t];
      if (v === undefined) continue;
      if (v !== true && v !== false && v !== null) throw new HttpError(400, `defaults.${t} is true, false or null`);
      defaults[t] = v;
    }
  }
  const modes = new Map(modesOf(before).map((x) => [x.collectionKey, x.modeId]));
  if (input.defaultModes !== undefined) {
    if (!Array.isArray(input.defaultModes)) throw new HttpError(400, "defaultModes is a list");
    const { results: cols } = await d1.prepare(`SELECT key, modes FROM library_assets WHERE library_key = ?1 AND kind = 'VARIABLE_COLLECTION' AND removed_in IS NULL`).bind(lib.key).all<{ key: string; modes: string | null }>();
    const known = new Map(cols.map((c) => [c.key, parseModes(c.modes)]));
    for (const dm of input.defaultModes) {
      if (!dm || typeof dm.collectionKey !== "string") throw new HttpError(400, "a default mode is {collectionKey, modeId}");
      if (dm.modeId === null) {
        modes.delete(dm.collectionKey);
        continue;
      }
      const ms = known.get(dm.collectionKey);
      // Figma: the library must hold a collection with at least two modes (§16.1).
      if (!ms || ms.length < 2 || !ms.some((x) => x.id === dm.modeId)) throw new HttpError(400, "no such mode in a published collection with two or more modes");
      modes.set(dm.collectionKey, dm.modeId);
    }
  }
  const approved = input.approved !== undefined ? input.approved : before?.approved === 1;
  const now = deps.now();
  const bit = (v: boolean | null) => (v === null ? null : v ? 1 : 0);

  // Enabling a default for the whole org publishes the library to the org (§16.5: "changes the file's permissions").
  if (scope.type === "org" && LIBRARY_EDITOR_TYPES.some((t) => defaults[t] === true) && lib.scope === "team") {
    const f = await acc.fileRow(lib.key);
    if (f) await setOrgLink(ctx, f, "viewer");
  }
  await d1
    .prepare(
      `INSERT INTO library_settings (library_key, scope_type, scope_id, approved, default_design, default_figjam, default_slides, default_buzz, default_modes, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT (library_key, scope_type, scope_id) DO UPDATE SET approved = ?4, default_design = ?5, default_figjam = ?6, default_slides = ?7, default_buzz = ?8, default_modes = ?9, updated_by = ?10, updated_at = ?11`,
    )
    .bind(lib.key, scope.type, scope.id, approved ? 1 : 0, bit(defaults.design), bit(defaults.figjam), bit(defaults.slides), bit(defaults.buzz), JSON.stringify([...modes].map(([collectionKey, modeId]) => ({ collectionKey, modeId }))), user.id, now)
    .run();

  // The activity log ([L-log]): org and workspace rows; team rows log nothing (Figma names none).
  if (scope.type !== "team") {
    const prefix = scope.type === "org" ? "org" : "workspace";
    const wasApproved = before?.approved === 1;
    const entity = fileEntity({ key: lib.key, name: libName(lib), editor_type: lib.editor_type ?? "design" });
    const log = (action: string, details: Record<string, unknown>) => logActivity(deps, { orgId: lib.org_id, action: action as ActivityAction, actor: user, entity, teamId: lib.team_id, details: { ...details, ...(scope.type === "workspace" ? { workspace_id: scope.id } : {}) }, req });
    if (approved !== wasApproved) await log(`${prefix}_library_${approved ? "approve" : "unapprove"}`, {});
    const was = defaultsOf(before);
    const changed = LIBRARY_EDITOR_TYPES.filter((t) => was[t] !== defaults[t]);
    if (changed.length || input.defaultModes !== undefined) await log(`${prefix}_library_setting_change`, { defaults: Object.fromEntries(changed.map((t) => [t, defaults[t]])), ...(input.defaultModes !== undefined ? { default_modes: [...modes].length } : {}) });
  }

  // An override below an approval: the admins above are told (§16.5).
  const turnedOff = LIBRARY_EDITOR_TYPES.some((t) => defaults[t] === false && defaultsOf(before)[t] !== false);
  if (turnedOff && scope.type !== "org") await overrideNotice(ctx, lib, scope);

  await librarySettingsNotice(deps, lib.org_id);
  const fresh = (await libraryRow(d1, lib.key))!;
  return json({ library: await info(ctx, await reachOf(acc, lib.org_id), fresh) });
}

async function overrideNotice(ctx: Ctx, lib: LibRow, scope: SettingScope): Promise<void> {
  const { acc, deps, user } = ctx;
  const d1 = acc.d1;
  const workspaceId = scope.type === "workspace" ? scope.id : ((await d1.prepare(`SELECT workspace_id FROM teams WHERE id = ?1`).bind(scope.id).first<{ workspace_id: string | null }>())?.workspace_id ?? null);
  const rows = await settingsFor(d1, [lib.key], [{ type: "org", id: lib.org_id }, ...(workspaceId ? [{ type: "workspace" as const, id: workspaceId }] : [])]);
  const orgApproved = rows.some((r) => r.scope_type === "org" && r.approved === 1);
  const wsApproved = scope.type === "team" && rows.some((r) => r.scope_type === "workspace" && r.approved === 1);
  if (!orgApproved && !wsApproved) return;
  const { results: admins } = await d1.prepare(`SELECT user_id FROM org_members WHERE org_id = ?1 AND role = 'admin' AND user_id IS NOT NULL`).bind(lib.org_id).all<{ user_id: string }>();
  const ids = admins.map((a) => a.user_id);
  if (scope.type === "team" && workspaceId) {
    const { results } = await d1.prepare(`SELECT user_id FROM workspace_admins WHERE workspace_id = ?1`).bind(workspaceId).all<{ user_id: string }>();
    ids.push(...results.map((x) => x.user_id));
  }
  const names = await scopeNames(d1, lib.org_id, [scope]);
  await notifyLibraryOverride(deps, { userIds: ids, actorId: user.id, orgId: lib.org_id, teamId: scope.type === "team" ? scope.id : null, libraryName: libName(lib), scopeName: names.get(`${scope.type}:${scope.id}`) ?? "" });
}

/** GET /teams/:team/libraries ("View team's libraries"): the team's own and every org-scope library, with its row */
export async function teamLibrariesRoute(ctx: Ctx): Promise<Response> {
  const { parts, m, acc } = ctx;
  if (parts.length !== 3 || m !== "GET") throw new HttpError(405, "method not allowed");
  const { team, rights } = await acc.requireTeam(parts[1]);
  if (!rights.inTeam && !rights.admin) throw new HttpError(403, "only the team's members can see its libraries");
  const libs = (await orgLibraryRows(acc.d1, team.org_id)).filter((l) => l.team_id === team.id || l.scope === "org");
  const rows = await settingsFor(acc.d1, libs.map((l) => l.key), "all");
  const list = await summaries(ctx, libs, rows);
  const teamRows = rows.filter((r) => r.scope_type === "team" && r.scope_id === team.id);
  const shaped = await scopeSettings(acc.d1, team.org_id, teamRows);
  const mine = new Map(teamRows.map((r, i) => [r.library_key, shaped[i]]));
  const out: TeamLibraryRow[] = list.map((s) => ({
    ...s,
    setting: mine.get(s.key) ?? {
      scope: { type: "team", id: team.id },
      scopeName: team.name,
      approved: false,
      defaults: { design: null, figjam: null, slides: null, buzz: null } satisfies Record<LibraryEditorType, boolean | null>,
      defaultModes: [],
      updatedAt: 0,
      updatedBy: null,
    },
  }));
  return json({ libraries: out });
}
