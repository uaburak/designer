/**
 * Admin › Resources on the fake org: an `OrgLibrariesRepository` (docs/data.md §16.5, §16.10 "Managing") and the
 * preload's `SharedFontsApi` (docs/desktop.md §14.3) over in-memory rows. They keep the server's rules the views show
 * (server/src/libraries/routes.ts, access.ts; server/src/fonts/routes.ts): who sees which library and which settings
 * rows, who may change what, an org default on a team-scope library publishing it to the org, approved first, the
 * activity actions; fonts' conflicts with Skip / Replace, the licence, removal by id or family.
 */
import type { OrgLibrariesRepository, OrgLibraryInfo, OrgLibrarySummary, LibraryScopeSetting, LibraryEditorType, SettingScope, CollectionModes, LibraryScope, TeamLibraryRow } from "@shared/libraries/orgTypes";
import { LIBRARY_EDITOR_TYPES } from "@shared/libraries/orgTypes";
import type { SharedFontsApi } from "@shared/desktop";
import type { FontConflict, FontConflictChoice, FontUploadCandidate, SharedFontFace, SharedFontScope } from "@shared/fonts/sharedTypes";
import type * as O from "@shared/org/types";
import type { Seed } from "./seed";

const DAY = 86_400_000;

export interface FakeLibrary {
  key: string;
  name: string;
  teamId: string;
  scope: LibraryScope;
  status: "published" | "unpublished" | "trashed" | "deleted";
  latestVersion: number;
  lastPublishedAt: number;
  counts: { components: number; styles: number; variables: number };
  collections: CollectionModes[];
  insertsLastWeek: number;
}

export interface ResourcesState {
  libraries: FakeLibrary[];
  /** `${key}|${type}|${id}` → the row */
  settings: Map<string, LibraryScopeSetting>;
  fonts: SharedFontFace[];
}

type Log = (type: O.ActivityAction, entity: O.ActivityLog["entity"], details?: Record<string, unknown>, teamId?: string | null) => void;

class Fail extends Error {
  constructor(public code: "not-found" | "invalid" | "forbidden", message: string) {
    super(message);
  }
}

const noDefaults = (): Record<LibraryEditorType, boolean | null> => ({ design: null, figjam: null, slides: null, buzz: null });
const modes = (...names: string[]) => names.map((name, i) => ({ id: `1:${10 + i}`, name }));

export function seedResources(s: Seed, now: number): ResourcesState {
  const lib = (key: string, name: string, teamId: string, scope: LibraryScope, counts: [number, number, number], collections: CollectionModes[] = [], inserts = 0, days = 3): FakeLibrary => ({
    key, name, teamId, scope, status: "published", latestVersion: 4 + (inserts % 7), lastPublishedAt: now - days * DAY,
    counts: { components: counts[0], styles: counts[1], variables: counts[2] }, collections, insertsLastWeek: inserts,
  });
  const libraries = [
    lib("lib_core01", "Core Design System", "t1", "org", [214, 38, 162], [{ collectionKey: "c-colors", name: "Colors", modes: modes("Light", "Dark") }, { collectionKey: "c-space", name: "Spacing", modes: modes("Default") }], 1240, 2),
    lib("lib_icons1", "Icons", "t1", "org", [612, 0, 0], [], 860, 9),
    lib("lib_mobile", "Mobile Components", "t2", "team", [88, 12, 40], [{ collectionKey: "c-mtheme", name: "Theme", modes: modes("Light", "Dark") }], 310, 5),
    lib("lib_brand1", "Marketing Brand", "t4", "org", [46, 24, 18], [], 95, 21),
    lib("lib_webui1", "Web Platform UI", "t3", "team", [132, 20, 76], [{ collectionKey: "c-wtheme", name: "Theme", modes: modes("Light", "Dark", "High contrast") }], 420, 1),
    lib("lib_dataviz", "Data Viz", "t6", "org", [54, 16, 30], [], 140, 14),
    lib("lib_resrch", "Research Templates", "t7", "team", [22, 4, 0], [], 12, 40),
  ];
  const settings = new Map<string, LibraryScopeSetting>();
  const row = (key: string, scope: SettingScope, patch: Partial<LibraryScopeSetting>) => {
    const scopeName = scope.type === "org" ? s.orgName : scope.type === "workspace" ? s.workspaces.find((w) => w.id === scope.id)!.name : s.teams.find((t) => t.id === scope.id)!.name;
    settings.set(`${key}|${scope.type}|${scope.id}`, { scope, scopeName, approved: false, defaults: noDefaults(), defaultModes: [], updatedAt: now - 30 * DAY, updatedBy: null, ...patch });
  };
  row("lib_core01", { type: "org", id: s.orgId }, { approved: true, defaults: { ...noDefaults(), design: true, figjam: true } });
  row("lib_core01", { type: "workspace", id: "ws-design" }, { defaultModes: [{ collectionKey: "c-colors", modeId: "1:10" }] });
  row("lib_icons1", { type: "org", id: s.orgId }, { approved: true });
  row("lib_mobile", { type: "workspace", id: "ws-design" }, { approved: true, defaults: { ...noDefaults(), design: true } });
  row("lib_dataviz", { type: "workspace", id: "ws-eng" }, { approved: true });
  row("lib_webui1", { type: "team", id: "t3" }, { defaults: { ...noDefaults(), design: true } });
  const face = (id: string, family: string, style: string, weight: number, italic = false, teamId: string | null = null, days = 60): SharedFontFace => ({
    id, family, style, postscriptName: `${family.replace(/ /g, "")}-${style.replace(/ /g, "")}`, weight, italic, stretch: 5, variable: false,
    sha1: id.padEnd(40, "0").slice(0, 40), format: "otf", size: 84_000 + weight * 10, fileName: `${family.replace(/ /g, "")}-${style.replace(/ /g, "")}.otf`,
    orgId: s.orgId, teamId, uploadedAt: now - days * DAY, uploadedBy: { id: "u1", name: "Burak Koç" },
  });
  const fonts = [
    face("f01", "Studio Sans", "Regular", 400), face("f02", "Studio Sans", "Medium", 500), face("f03", "Studio Sans", "Bold", 700),
    face("f04", "Studio Serif", "Regular", 400, false, null, 120), face("f05", "Studio Serif", "Italic", 400, true, null, 120),
    face("f06", "Campaign Display", "Black", 900, false, "t4", 20),
  ];
  return { libraries, settings, fonts };
}

/** What the caller reaches (server/src/libraries/access.ts `reachOf`) */
function reach(s: Seed, me: string) {
  const p = s.people.find((x) => x.id === me);
  const orgAdmin = p?.role === "admin";
  const workspaces = new Set(s.workspaces.filter((w) => w.admins.some((a) => a.id === me)).map((w) => w.id));
  return { orgAdmin, workspaces, workspaceOf: p?.workspaceId ?? null };
}

export function fakeOrgLibraries(s: Seed, r: ResourcesState, me: string, log: Log, wait: <T>(v: T) => Promise<T>, now: () => number): OrgLibrariesRepository {
  const team = (id: string) => s.teams.find((t) => t.id === id) ?? null;
  const wsOf = (l: FakeLibrary) => team(l.teamId)?.workspaceId ?? null;
  const rows = (key: string) => [...r.settings.values()].filter((x) => r.settings.get(`${key}|${x.scope.type}|${x.scope.id}`) === x);
  const isTeamMember = (teamId: string) => team(teamId)?.ownerId === me;
  const sees = (l: FakeLibrary) => {
    const x = reach(s, me);
    if (l.status !== "published") return false;
    if (x.orgAdmin) return true;
    const ws = wsOf(l);
    return l.scope === "org" || (ws !== null && x.workspaces.has(ws)) || isTeamMember(l.teamId);
  };
  const lib = (key: string) => {
    const l = r.libraries.find((x) => x.key === key);
    if (!l || !sees(l)) throw new Fail("not-found", "no such library");
    return l;
  };
  const summary = (l: FakeLibrary): OrgLibrarySummary => {
    const mine = rows(l.key);
    const org = mine.find((x) => x.scope.type === "org") ?? null;
    const on = (x: LibraryScopeSetting) => LIBRARY_EDITOR_TYPES.some((t) => x.defaults[t] === true);
    const t = team(l.teamId);
    return {
      key: l.key, name: l.name, orgId: s.orgId, teamId: l.teamId, teamName: t?.name ?? null, workspaceId: wsOf(l), scope: l.scope, status: l.status,
      latestVersion: l.latestVersion, lastPublishedAt: l.lastPublishedAt, counts: { ...l.counts }, thumbnailUrl: null,
      approved: { org: org?.approved === true, workspaceIds: mine.filter((x) => x.scope.type === "workspace" && x.approved).map((x) => x.scope.id) },
      defaultIn: {
        org: LIBRARY_EDITOR_TYPES.filter((ty) => org?.defaults[ty] === true),
        workspaceIds: mine.filter((x) => x.scope.type === "workspace" && on(x)).map((x) => x.scope.id),
        teamIds: mine.filter((x) => x.scope.type === "team" && on(x)).map((x) => x.scope.id),
      },
      insertsLastWeek: l.insertsLastWeek,
    };
  };
  const canManage = (l: FakeLibrary) => {
    const x = reach(s, me);
    const workspaceIds = x.orgAdmin ? s.workspaces.map((w) => w.id) : [...x.workspaces];
    const teamIds = s.teams.filter((t) => t.deletedAt === null && (l.scope === "org" || t.id === l.teamId) && (x.orgAdmin || (t.workspaceId !== null && x.workspaces.has(t.workspaceId)))).map((t) => t.id);
    return { org: x.orgAdmin, workspaceIds, teamIds };
  };
  const info = (l: FakeLibrary): OrgLibraryInfo => {
    const x = reach(s, me);
    const visible = rows(l.key).filter((row) => x.orgAdmin || row.scope.type === "org" || (row.scope.type === "workspace" && (x.workspaces.has(row.scope.id) || x.workspaceOf === row.scope.id)));
    return { ...summary(l), collections: structuredClone(l.collections), settings: structuredClone(visible), canManage: canManage(l) };
  };
  const approvedFirst = (a: OrgLibrarySummary, b: OrgLibrarySummary) => Number(b.approved.org || b.approved.workspaceIds.length > 0) - Number(a.approved.org || a.approved.workspaceIds.length > 0);
  return {
    async list(_orgId, q = {}) {
      let libs = r.libraries.filter(sees);
      const text = q.text?.trim().toLowerCase();
      if (text) libs = libs.filter((l) => l.name.toLowerCase().includes(text));
      if (q.workspaceId) libs = libs.filter((l) => wsOf(l) === q.workspaceId);
      if (q.teamId) libs = libs.filter((l) => l.teamId === q.teamId);
      let out = libs.map(summary);
      if (q.approved) out = out.filter((x) => x.approved.org || (q.workspaceId ? x.approved.workspaceIds.includes(q.workspaceId) : x.approved.workspaceIds.length > 0));
      if (q.enabledByDefault) out = out.filter((x) => x.defaultIn.org.length > 0 || x.defaultIn.workspaceIds.length > 0 || x.defaultIn.teamIds.length > 0);
      return wait(out.sort(approvedFirst));
    },
    async get(_orgId, key) {
      return wait(info(lib(key)));
    },
    async updateSettings(_orgId, key, input) {
      const l = lib(key);
      const scope = input.scope;
      if (input.approved !== undefined && scope.type === "team") throw new Fail("invalid", "approved is a boolean, for the organization or a workspace");
      if (input.defaultModes !== undefined && scope.type === "org") throw new Fail("invalid", "default modes are set for a workspace or a team");
      const may = canManage(l);
      const allowed = scope.type === "org" ? may.org : scope.type === "workspace" ? may.workspaceIds.includes(scope.id) : may.teamIds.includes(scope.id);
      if (!allowed) throw new Fail("forbidden", "only admins can change this");
      const id = `${key}|${scope.type}|${scope.id}`;
      const scopeName = scope.type === "org" ? s.orgName : scope.type === "workspace" ? (s.workspaces.find((w) => w.id === scope.id)?.name ?? "") : (team(scope.id)?.name ?? "");
      const before = r.settings.get(id) ?? null;
      const row: LibraryScopeSetting = structuredClone(before) ?? { scope, scopeName, approved: false, defaults: noDefaults(), defaultModes: [], updatedAt: 0, updatedBy: null };
      if (input.approved !== undefined) row.approved = input.approved;
      for (const t of LIBRARY_EDITOR_TYPES) if (input.defaults && input.defaults[t] !== undefined) row.defaults[t] = input.defaults[t]!;
      if (input.defaultModes) {
        const map = new Map(row.defaultModes.map((m) => [m.collectionKey, m.modeId]));
        for (const dm of input.defaultModes) {
          if (dm.modeId === null) {
            map.delete(dm.collectionKey);
            continue;
          }
          const c = l.collections.find((x) => x.collectionKey === dm.collectionKey);
          if (!c || c.modes.length < 2 || !c.modes.some((m) => m.id === dm.modeId)) throw new Fail("invalid", "no such mode in a published collection with two or more modes");
          map.set(dm.collectionKey, dm.modeId);
        }
        row.defaultModes = [...map].map(([collectionKey, modeId]) => ({ collectionKey, modeId }));
      }
      const p = s.people.find((x) => x.id === me)!;
      row.updatedAt = now();
      row.updatedBy = { id: p.id, email: p.email, name: p.name, picture: p.picture, role: p.role };
      const entity = { type: "file" as const, id: l.key, name: l.name };
      // An org default on a team-scope library publishes it to the org (§16.5: "changes the file's permissions")
      if (scope.type === "org" && LIBRARY_EDITOR_TYPES.some((t) => row.defaults[t] === true) && l.scope === "team") {
        l.scope = "org";
        log("fig_file_link_access_change", entity, { org_link_access: "viewer" }, l.teamId);
      }
      r.settings.set(id, row);
      if (scope.type !== "team") {
        const prefix = scope.type === "org" ? "org" : "workspace";
        const ws = scope.type === "workspace" ? { workspace_id: scope.id } : {};
        if (row.approved !== (before?.approved ?? false)) log(`${prefix}_library_${row.approved ? "approve" : "unapprove"}` as O.ActivityAction, entity, ws, l.teamId);
        const changed = LIBRARY_EDITOR_TYPES.filter((t) => (before?.defaults[t] ?? null) !== row.defaults[t]);
        if (changed.length || input.defaultModes !== undefined) log(`${prefix}_library_setting_change` as O.ActivityAction, entity, { ...ws, defaults: Object.fromEntries(changed.map((t) => [t, row.defaults[t]])) }, l.teamId);
      }
      return wait(info(l));
    },
    async setScope(key, scope) {
      const l = lib(key);
      l.scope = scope;
      return wait(info(l));
    },
    async teamLibraries(teamId): Promise<TeamLibraryRow[]> {
      const t = team(teamId);
      if (!t) throw new Fail("not-found", "no such team");
      const libs = r.libraries.filter((l) => l.status === "published" && (l.teamId === teamId || l.scope === "org"));
      return wait(libs.map((l) => ({ ...summary(l), setting: structuredClone(r.settings.get(`${l.key}|team|${teamId}`)) ?? { scope: { type: "team", id: teamId }, scopeName: t.name, approved: false, defaults: noDefaults(), defaultModes: [], updatedAt: 0, updatedBy: null } })));
    },
  };
}

/** A file the next `sharedPick` returns (tests set `nextPick`) */
export interface FakeFontFile {
  fileName: string;
  /** Faces in it; none: refused with `reason` */
  faces?: { family: string; style: string; weight?: number; italic?: boolean }[];
  reason?: string;
}

export interface FakeSharedFonts extends SharedFontsApi {
  /** What the next Open dialog picks; null: Cancel. Default: two new faces, one family already uploaded, a web font refused */
  nextPick: FakeFontFile[] | null;
  /** Calls made (tests) */
  calls: string[];
}

export function fakeSharedFonts(s: Seed, r: ResourcesState, me: string, wait: <T>(v: T) => Promise<T>, now: () => number): FakeSharedFonts {
  const tokens = new Map<string, { scope: SharedFontScope; candidate: FontUploadCandidate }>();
  let seq = 0;
  const inScope = (f: SharedFontFace, scope: SharedFontScope) => f.orgId === scope.orgId && f.teamId === (scope.type === "team" ? scope.teamId : null);
  const isAdmin = () => s.people.find((p) => p.id === me)?.role === "admin";
  const check = (scope: SharedFontScope) => {
    if (scope.orgId !== s.orgId) throw new Fail("not-found", "no such organization");
    if (scope.type === "org" && !isAdmin()) throw new Fail("forbidden", "Only organization admins can upload fonts to the organization");
  };
  const list = (scope: SharedFontScope) => r.fonts.filter((f) => inScope(f, scope));
  const api: FakeSharedFonts = {
    nextPick: [
      { fileName: "Brand Grotesk-Regular.otf", faces: [{ family: "Brand Grotesk", style: "Regular", weight: 400 }] },
      { fileName: "Brand Grotesk-Bold.otf", faces: [{ family: "Brand Grotesk", style: "Bold", weight: 700 }] },
      { fileName: "StudioSans-Black.otf", faces: [{ family: "Studio Sans", style: "Black", weight: 900 }] },
      { fileName: "brand-grotesk.woff2", reason: "Only .TTF and .OTF files can be uploaded" },
    ],
    calls: [],
    async sharedList(scope) {
      api.calls.push("list");
      return wait({ faces: list(scope) });
    },
    async sharedPick(scope) {
      api.calls.push("pick");
      check(scope);
      const picked = api.nextPick;
      if (!picked) return wait({ cancelled: true as const });
      const candidates: FontUploadCandidate[] = [];
      const failed: { fileName: string; reason: string }[] = [];
      for (const f of picked) {
        if (!f.faces?.length) {
          failed.push({ fileName: f.fileName, reason: f.reason ?? "No font in it" });
          continue;
        }
        const token = `tok${++seq}`;
        const candidate: FontUploadCandidate = {
          token, fileName: f.fileName, format: f.fileName.toLowerCase().endsWith(".ttf") ? "ttf" : "otf", size: 64_000, sha1: `sha${seq}`.padEnd(40, "0"),
          faces: f.faces.map((x) => ({ family: x.family, style: x.style, postscriptName: `${x.family}-${x.style}`.replace(/ /g, ""), weight: x.weight ?? 400, italic: x.italic ?? false, stretch: 5, variable: false })),
        };
        tokens.set(token, { scope, candidate });
        candidates.push(candidate);
      }
      const families = [...new Set(candidates.flatMap((c) => c.faces.map((x) => x.family)))];
      const conflicts: FontConflict[] = families
        .map((family) => ({ family, existing: list(scope).filter((x) => x.family.toLowerCase() === family.toLowerCase()).length }))
        .filter((c) => c.existing > 0);
      return wait({ candidates, conflicts, failed });
    },
    async sharedUpload({ scope, tokens: ids, licenceConfirmed, choices }) {
      api.calls.push("upload");
      check(scope);
      if (licenceConfirmed !== true) throw new Fail("invalid", "Confirm you have the necessary rights and licenses to use the font(s)");
      const out = { uploaded: [] as SharedFontFace[], skipped: [] as string[], replaced: [] as string[], failed: [] as { fileName: string; reason: string }[] };
      const choice = (family: string): FontConflictChoice | undefined => Object.entries(choices).find(([k]) => k.toLowerCase() === family.toLowerCase())?.[1];
      const p = s.people.find((x) => x.id === me)!;
      for (const id of ids) {
        const t = tokens.get(id);
        tokens.delete(id);
        if (!t || t.scope.type !== scope.type || t.scope.orgId !== scope.orgId) {
          out.failed.push({ fileName: t?.candidate.fileName ?? id, reason: "Pick the file again" });
          continue;
        }
        const faces = t.candidate.faces.filter((f) => {
          const exists = list(scope).some((x) => x.family.toLowerCase() === f.family.toLowerCase()) && !out.replaced.includes(f.family);
          if (!exists) return true;
          const c = choice(f.family);
          if (c === "skip") {
            if (!out.skipped.includes(f.family)) out.skipped.push(f.family);
            return false;
          }
          if (c === "replace") {
            r.fonts = r.fonts.filter((x) => !(inScope(x, scope) && x.family.toLowerCase() === f.family.toLowerCase()));
            out.replaced.push(f.family);
            return true;
          }
          out.failed.push({ fileName: t.candidate.fileName, reason: "Upload it again to choose" });
          return false;
        });
        for (const f of faces) {
          const face: SharedFontFace = { ...f, id: `f${100 + ++seq}`, sha1: t.candidate.sha1, format: t.candidate.format, size: t.candidate.size, fileName: t.candidate.fileName, orgId: scope.orgId, teamId: scope.type === "team" ? scope.teamId : null, uploadedAt: now(), uploadedBy: { id: p.id, name: p.name } };
          r.fonts.push(face);
          out.uploaded.push(face);
        }
      }
      return wait(out);
    },
    async sharedRemove({ scope, ids, family }) {
      api.calls.push("remove");
      check(scope);
      r.fonts = r.fonts.filter((f) => !(inScope(f, scope) && ((ids && ids.includes(f.id)) || (family !== undefined && f.family.toLowerCase() === family.toLowerCase()))));
      return wait({ faces: list(scope) });
    },
  };
  return api;
}
