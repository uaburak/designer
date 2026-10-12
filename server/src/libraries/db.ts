/**
 * Org libraries in D1 (docs/data.md §16.11): the rows, the settings resolution of §16.5, the record shapes of
 * src/shared/libraries/orgTypes.ts, and the two hooks the files routes call — `syncLibraryScope` (the org link ⇔ the
 * library's scope, §16.2) and `libraryFileStatus` (trash / restore / delete forever, §16.6).
 */
import { LIBRARY_EDITOR_TYPES, type DefaultMode, type LibraryEditorType, type LibraryScope, type LibraryScopeSetting, type OrgLibraryRecord, type SettingScope } from "../../../src/shared/libraries/orgTypes";
import type { EditorType, OrgRole, PersonRef } from "../../../src/shared/org/types";
import type { Redirect } from "../../../src/shared/store/types";
import type { Deps } from "../api";
import type { D1Like } from "../db";
import { HttpError } from "../org/http";
import { libraryStatusNotice, librarySettingsNotice } from "./notices";
import { resolveR2, type StorageEnv } from "../storage/objects";

// ---- the Durable Object bindings ------------------------------------------------------------------------------------

/** A Durable Object namespace as the Worker sees it (Cloudflare's, or testing/memoryLibraries.ts) */
export interface ObjectNamespace {
  idFromName(name: string): unknown;
  get(id: never): { fetch(req: Request): Promise<Response> };
  /** The namespace's objects restricted to a jurisdiction (docs/multiplayer.md §15.10; Cloudflare's `jurisdiction("eu")`) */
  jurisdiction?(name: "eu"): ObjectNamespace;
}

/** The namespace of a jurisdiction (null: the default one); 503 when this deployment has none */
export function inJurisdiction(ns: ObjectNamespace | undefined, j: "eu" | null): ObjectNamespace | undefined {
  if (!ns || !j) return ns;
  if (!ns.jurisdiction) throw new HttpError(503, "data storage localization isn't available here");
  return ns.jurisdiction(j);
}

/** What libraries and fonts need of the Worker's env (index.ts passes the whole env as `deps.env`) */
export interface LibraryEnv {
  /** One LibraryObject per library key */
  LIBRARIES?: ObjectNamespace;
  /** One FontObject per org id */
  FONTS?: ObjectNamespace;
}

/**
 * A call to a library's or an org's object. `at` (docs/cloud.md §1): the Worker's env, so an answer naming an R2 object
 * (`x-r2-key`) is read here straight from R2, and the object's region (`x-region`, its bucket).
 */
export async function objectFetch(ns: ObjectNamespace | undefined, name: string, path: string, init: { method?: string; body?: ArrayBuffer | string | null } = {}, at?: { env?: unknown; region?: "eu" | null }): Promise<Response> {
  if (!ns) throw new HttpError(503, "libraries and fonts aren't available here");
  const stub = ns.get(ns.idFromName(name) as never);
  const headers: Record<string, string> = at && at.region !== undefined ? { "x-region": at.region === "eu" ? "eu" : "default" } : {};
  const res = await stub.fetch(new Request(`https://object${path}`, { method: init.method ?? "GET", body: init.body ?? null, headers }));
  return resolveR2(res, at?.env as StorageEnv | undefined);
}

export const libraries = (deps: Deps) => (deps.env as LibraryEnv).LIBRARIES;

/**
 * Where a library's object lives (§15.10): `libraries.jurisdiction` once the library has a row; before its first
 * publish (bytes uploaded ahead of it), the file's org's region.
 */
export async function libraryJurisdiction(d1: D1Like, key: string): Promise<"eu" | null> {
  const r = await d1.prepare(`SELECT jurisdiction FROM libraries WHERE key = ?1`).bind(key).first<{ jurisdiction: string | null }>();
  if (r) return r.jurisdiction === "eu" ? "eu" : null;
  const o = await d1.prepare(`SELECT o.data_region FROM files f JOIN orgs o ON o.id = f.org_id WHERE f.key = ?1`).bind(key).first<{ data_region: string }>();
  return o?.data_region === "eu" ? "eu" : null;
}

/** `objectFetch` on a library's object in its jurisdiction (one D1 read per call, no cache — §15.10) */
export async function libraryFetch(deps: Deps, key: string, path: string, init: { method?: string; body?: ArrayBuffer | string | null } = {}): Promise<Response> {
  const j = await libraryJurisdiction(deps.db.d1, key);
  return objectFetch(inJurisdiction(libraries(deps), j), key, path, init, { env: deps.env, region: j });
}
export const fontObjects = (deps: Deps) => (deps.env as LibraryEnv).FONTS;

// ---- rows -----------------------------------------------------------------------------------------------------------

export interface LibRow {
  key: string;
  org_id: string;
  name: string;
  scope: LibraryScope;
  status: OrgLibraryRecord["status"];
  latest_version: number;
  counts: string;
  first_published_at: number;
  last_published_at: number;
  published_by: string | null;
  /** The file (null once deleted forever) */
  file_name: string | null;
  team_id: string | null;
  project_id: string | null;
  owner_id: string | null;
  editor_type: EditorType | null;
  team_name: string | null;
  workspace_id: string | null;
  team_org_access: string | null;
}

export const LIB_SELECT = `SELECT l.*, f.name AS file_name, f.team_id, f.project_id, f.owner_id, f.editor_type, t.name AS team_name, t.workspace_id, t.org_access AS team_org_access
  FROM libraries l LEFT JOIN files f ON f.key = l.key LEFT JOIN teams t ON t.id = f.team_id`;

export async function libraryRow(d1: D1Like, key: string): Promise<LibRow | null> {
  return d1.prepare(`${LIB_SELECT} WHERE l.key = ?1`).bind(key).first<LibRow>();
}

export async function orgLibraryRows(d1: D1Like, orgId: string, publishedOnly = true): Promise<LibRow[]> {
  const { results } = await d1.prepare(`${LIB_SELECT} WHERE l.org_id = ?1${publishedOnly ? ` AND l.status = 'published'` : ""} ORDER BY l.name COLLATE NOCASE`).bind(orgId).all<LibRow>();
  return results;
}

export const libName = (l: LibRow) => l.file_name ?? l.name;
export const countsOf = (l: Pick<LibRow, "counts">): { components: number; styles: number; variables: number } => {
  try {
    const c = JSON.parse(l.counts) as Partial<Record<"components" | "styles" | "variables", number>>;
    return { components: c.components ?? 0, styles: c.styles ?? 0, variables: c.variables ?? 0 };
  } catch {
    return { components: 0, styles: 0, variables: 0 };
  }
};

/** Figma's four file types that take default libraries; Sites and Make files take none */
export const libraryEditorType = (t: EditorType | null | undefined): LibraryEditorType | null => ((LIBRARY_EDITOR_TYPES as readonly string[]).includes(t ?? "") ? (t as LibraryEditorType) : null);

// ---- settings (§16.5) -----------------------------------------------------------------------------------------------

export interface SettingRow {
  library_key: string;
  scope_type: SettingScope["type"];
  scope_id: string;
  approved: number;
  default_design: number | null;
  default_figjam: number | null;
  default_slides: number | null;
  default_buzz: number | null;
  default_modes: string;
  updated_by: string | null;
  updated_at: number;
}

/** The settings rows of `keys` at these scopes (one query; any number of keys and scopes). */
export async function settingsFor(d1: D1Like, keys: string[], scopes: SettingScope[] | "all"): Promise<SettingRow[]> {
  if (!keys.length) return [];
  if (scopes === "all") {
    const { results } = await d1.prepare(`SELECT * FROM library_settings WHERE library_key IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(keys)).all<SettingRow>();
    return results;
  }
  if (!scopes.length) return [];
  const { results } = await d1
    .prepare(`SELECT * FROM library_settings WHERE library_key IN (SELECT value FROM json_each(?1)) AND (scope_type || ':' || scope_id) IN (SELECT value FROM json_each(?2))`)
    .bind(JSON.stringify(keys), JSON.stringify(scopes.map((s) => `${s.type}:${s.id}`)))
    .all<SettingRow>();
  return results;
}

const tri = (v: number | null): boolean | null => (v === null ? null : v === 1);
export const defaultsOf = (r: SettingRow | null): Record<LibraryEditorType, boolean | null> => ({
  design: r ? tri(r.default_design) : null,
  figjam: r ? tri(r.default_figjam) : null,
  slides: r ? tri(r.default_slides) : null,
  buzz: r ? tri(r.default_buzz) : null,
});
export const modesOf = (r: SettingRow | null): DefaultMode[] => {
  try {
    const v = JSON.parse(r?.default_modes ?? "[]") as DefaultMode[];
    return Array.isArray(v) ? v.filter((x) => typeof x?.collectionKey === "string" && typeof x?.modeId === "string") : [];
  } catch {
    return [];
  }
};

/** A file (or a caller, for records outside a file): its org, team and workspace, and its type */
export interface FileContext {
  orgId: string;
  teamId: string | null;
  workspaceId: string | null;
  editorType: LibraryEditorType | null;
}

export const contextScopes = (c: FileContext): SettingScope[] => [
  { type: "org", id: c.orgId },
  ...(c.workspaceId ? [{ type: "workspace" as const, id: c.workspaceId }] : []),
  ...(c.teamId ? [{ type: "team" as const, id: c.teamId }] : []),
];

/**
 * §16.5 for one library in one file: approved = the org's row, else the workspace's; on by default = the first
 * non-null of team, workspace, org for the file's type; default modes = the team's per collection, else the workspace's.
 */
export function resolveSettings(rows: SettingRow[], c: FileContext): { approved: "org" | "workspace" | null; enabledByDefault: boolean; defaultModes: DefaultMode[] } {
  const at = (type: SettingScope["type"], id: string | null) => (id ? (rows.find((r) => r.scope_type === type && r.scope_id === id) ?? null) : null);
  const org = at("org", c.orgId);
  const ws = at("workspace", c.workspaceId);
  const team = at("team", c.teamId);
  const approved = org?.approved ? "org" : ws?.approved ? "workspace" : null;
  let on: boolean | null = null;
  if (c.editorType) for (const r of [team, ws, org]) if (on === null) on = defaultsOf(r)[c.editorType];
  const modes = new Map<string, DefaultMode>();
  for (const m of modesOf(ws)) modes.set(m.collectionKey, m);
  for (const m of modesOf(team)) modes.set(m.collectionKey, m);
  return { approved, enabledByDefault: on === true, defaultModes: [...modes.values()] };
}

/** The file's own context: a draft is in its owner's workspace, with no team (§16.5) */
export async function fileContext(d1: D1Like, f: { org_id: string | null; team_id: string | null; owner_id: string; editor_type: EditorType }): Promise<FileContext | null> {
  if (!f.org_id) return null;
  let workspaceId: string | null = null;
  if (f.team_id) workspaceId = (await d1.prepare(`SELECT workspace_id FROM teams WHERE id = ?1`).bind(f.team_id).first<{ workspace_id: string | null }>())?.workspace_id ?? null;
  else workspaceId = (await d1.prepare(`SELECT workspace_id FROM org_members WHERE org_id = ?1 AND user_id = ?2`).bind(f.org_id, f.owner_id).first<{ workspace_id: string | null }>())?.workspace_id ?? null;
  return { orgId: f.org_id, teamId: f.team_id, workspaceId, editorType: libraryEditorType(f.editor_type) };
}

/** Rows into Figma's "Manage this library" shape (names and people read in two queries) */
export async function scopeSettings(d1: D1Like, orgId: string, rows: SettingRow[]): Promise<LibraryScopeSetting[]> {
  if (!rows.length) return [];
  const names = await scopeNames(d1, orgId, rows.map((r) => ({ type: r.scope_type, id: r.scope_id }) as SettingScope));
  const people = await peopleIn(d1, orgId, rows.map((r) => r.updated_by));
  return rows.map((r) => ({
    scope: { type: r.scope_type, id: r.scope_id } as SettingScope,
    scopeName: names.get(`${r.scope_type}:${r.scope_id}`) ?? "",
    approved: r.approved === 1,
    defaults: defaultsOf(r),
    defaultModes: modesOf(r),
    updatedAt: r.updated_at,
    updatedBy: r.updated_by ? (people.get(r.updated_by) ?? null) : null,
  }));
}

export async function scopeNames(d1: D1Like, orgId: string, scopes: SettingScope[]): Promise<Map<string, string>> {
  const { results } = await d1
    .prepare(
      `SELECT 'org:' || id AS k, name FROM orgs WHERE id = ?1
       UNION ALL SELECT 'workspace:' || id, name FROM workspaces WHERE org_id = ?1 AND id IN (SELECT value FROM json_each(?2))
       UNION ALL SELECT 'team:' || id, name FROM teams WHERE org_id = ?1 AND id IN (SELECT value FROM json_each(?2))`,
    )
    .bind(orgId, JSON.stringify(scopes.map((s) => s.id)))
    .all<{ k: string; name: string }>();
  return new Map(results.map((r) => [r.k, r.name]));
}

/** PersonRefs of these user ids, with their role in the org */
export async function peopleIn(d1: D1Like, orgId: string, ids: (string | null)[]): Promise<Map<string, PersonRef>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map();
  const { results } = await d1
    .prepare(`SELECT u.id, u.email, u.name, u.picture, m.role FROM users u LEFT JOIN org_members m ON m.user_id = u.id AND m.org_id = ?1 WHERE u.id IN (SELECT value FROM json_each(?2))`)
    .bind(orgId, JSON.stringify(want))
    .all<{ id: string; email: string; name: string | null; picture: string | null; role: OrgRole | null }>();
  return new Map(results.map((r) => [r.id, { id: r.id, email: r.email, name: r.name, picture: r.picture, role: r.role ?? "member" }]));
}

/** Assets moved into these libraries (§9.5), per library */
export async function movedInto(d1: D1Like, keys: string[]): Promise<Map<string, Redirect[]>> {
  const out = new Map<string, Redirect[]>();
  if (!keys.length) return out;
  const { results } = await d1
    .prepare(`SELECT * FROM library_redirects WHERE to_library IN (SELECT value FROM json_each(?1)) ORDER BY at`)
    .bind(JSON.stringify(keys))
    .all<{ from_library: string; from_key: string; to_library: string; to_key: string; version: number; at: number }>();
  for (const r of results) {
    const list = out.get(r.to_library) ?? [];
    list.push({ fromLibraryFileKey: r.from_library, fromKey: r.from_key, toLibraryFileKey: r.to_library, toKey: r.to_key, version: r.version, at: r.at });
    out.set(r.to_library, list);
  }
  return out;
}

/** Assets of `key` other libraries record as moved out of it (what its diff reports as moved) */
export async function movedOutOf(d1: D1Like, key: string): Promise<Redirect[]> {
  const { results } = await d1
    .prepare(`SELECT * FROM library_redirects WHERE from_library = ?1`)
    .bind(key)
    .all<{ from_library: string; from_key: string; to_library: string; to_key: string; version: number; at: number }>();
  return results.map((r) => ({ fromLibraryFileKey: r.from_library, fromKey: r.from_key, toLibraryFileKey: r.to_library, toKey: r.to_key, version: r.version, at: r.at }));
}

/** The record the store's LibraryRegistry returns for an org library (§16.3) */
export function toRecord(l: LibRow, o: { settings: ReturnType<typeof resolveSettings>; via: OrgLibraryRecord["org"]["via"]; movedIn: Redirect[]; publishedBy: PersonRef | null }): OrgLibraryRecord {
  return {
    libraryFileKey: l.key,
    status: l.status,
    latestVersion: l.latest_version,
    firstPublishedAt: l.first_published_at,
    lastPublishedAt: l.last_published_at,
    counts: countsOf(l),
    movedIn: o.movedIn,
    _clk: {},
    org: {
      orgId: l.org_id,
      teamId: l.team_id,
      teamName: l.team_name,
      workspaceId: l.workspace_id,
      scope: l.scope,
      name: libName(l),
      thumbnailUrl: null,
      publishedBy: o.publishedBy,
      approved: o.settings.approved,
      enabledByDefault: o.settings.enabledByDefault,
      defaultModes: o.settings.defaultModes,
      via: o.via,
    },
  };
}

// ---- the files routes' hooks ----------------------------------------------------------------------------------------

/**
 * The org link decides the scope (§16.2): "Anyone at ‹org›" (viewer or editor) is `org`, "Only people invited" is
 * `team`. Called by PATCH /files/:key when `orgLinkAccess` changes, and by the libraries routes after they set the link.
 */
export async function syncLibraryScope(deps: Deps, fileKey: string, orgLinkAccess: string): Promise<void> {
  const scope: LibraryScope = orgLinkAccess === "none" ? "team" : "org";
  const r = await deps.db.d1.prepare(`UPDATE libraries SET scope = ?2 WHERE key = ?1 AND scope != ?2 RETURNING org_id`).bind(fileKey, scope).first<{ org_id: string }>();
  if (r) await librarySettingsNotice(deps, r.org_id);
}

/**
 * The library file went to the trash, came back, or was deleted forever (§16.6): trashed libraries list nowhere,
 * restored ones are published again, a deleted one keeps its row ("Missing library") and loses its bytes and its
 * subscriptions. Consumers hear `{t: "library", libraryKey, status}`.
 */
export async function libraryFileStatus(deps: Deps, key: string, event: "trash" | "restore" | "delete"): Promise<void> {
  const d1 = deps.db.d1;
  const lib = await d1.prepare(`SELECT status, org_id FROM libraries WHERE key = ?1`).bind(key).first<{ status: string; org_id: string }>();
  if (!lib || lib.status === "deleted") return;
  // Who to tell is read before a deletion takes the file's rows.
  const notify = await libraryStatusNotice(deps, key);
  let status: OrgLibraryRecord["status"] | null = null;
  if (event === "trash" && lib.status !== "trashed") status = "trashed";
  if (event === "restore" && lib.status === "trashed") status = "published";
  if (event === "delete") status = "deleted";
  if (!status) return;
  await d1.prepare(`UPDATE libraries SET status = ?2 WHERE key = ?1`).bind(key, status).run();
  if (status === "deleted") {
    await d1.prepare(`DELETE FROM library_subscriptions WHERE library_key = ?1`).bind(key).run();
    try {
      await libraryFetch(deps, key, "/delete", { method: "POST" });
    } catch (e) {
      console.error("libraries: the object of a deleted library wasn't emptied", key, e);
    }
  }
  await notify(status);
}
