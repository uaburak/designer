/**
 * `orgLibraries` (docs/data.md §16.3, §16.5, §16.10 "Managing"): Admin › Resources › Libraries, a team's "View team's
 * libraries", Home's org Libraries page. Thin over the server: no cache (these are admin views, online only; offline
 * fails with `offline`). A settings change also drops nothing here — the org's members hear `{t: "org", what:
 * "libraries"}` and the registry's reads are online-first anyway (org.ts).
 */
import { LIBRARY_EDITOR_TYPES, type LibraryEditorType, type LibrarySettingsInput, type OrgLibrariesQuery, type OrgLibrariesRepository, type OrgLibraryInfo, type OrgLibrarySummary, type TeamLibraryRow } from "../../shared/libraries/orgTypes";
import { StoreError } from "../../shared/store/protocol";
import { callJson, seg, type LibraryServer } from "./org";

function queryString(q: OrgLibrariesQuery | undefined): string {
  const p = new URLSearchParams();
  if (q && typeof q === "object") {
    if (typeof q.text === "string" && q.text.trim()) p.set("text", q.text.trim().slice(0, 256));
    if (typeof q.workspaceId === "string" && q.workspaceId) p.set("workspace", seg(q.workspaceId, "workspace id"));
    if (typeof q.teamId === "string" && q.teamId) p.set("team", seg(q.teamId, "team id"));
    if (q.approved === true) p.set("approved", "1");
    if (q.enabledByDefault === true) p.set("default", "1");
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** The input as the route takes it: only known fields, tri-states kept (null = inherit) */
export function cleanSettingsInput(input: LibrarySettingsInput): LibrarySettingsInput {
  const scope = input?.scope;
  if (!scope || (scope.type !== "org" && scope.type !== "workspace" && scope.type !== "team")) throw new StoreError("invalid", "bad scope");
  const out: LibrarySettingsInput = { scope: { type: scope.type, id: seg(scope.id, `${scope.type} id`) } };
  if (typeof input.approved === "boolean") out.approved = input.approved;
  if (input.defaults && typeof input.defaults === "object") {
    const d: Partial<Record<LibraryEditorType, boolean | null>> = {};
    for (const t of LIBRARY_EDITOR_TYPES) {
      const v = input.defaults[t];
      if (v === true || v === false || v === null) d[t] = v;
    }
    out.defaults = d;
  }
  if (Array.isArray(input.defaultModes)) {
    out.defaultModes = input.defaultModes
      .filter((m) => m && typeof m.collectionKey === "string" && (m.modeId === null || typeof m.modeId === "string"))
      .map((m) => ({ collectionKey: m.collectionKey, modeId: m.modeId }));
  }
  return out;
}

export function orgLibrariesRepository(server: LibraryServer): OrgLibrariesRepository {
  const call = <T>(method: string, path: string, body?: unknown) => callJson<T>(server, method, path, body);
  return {
    list: async (orgId, query) => (await call<{ libraries: OrgLibrarySummary[] }>("GET", `/orgs/${seg(orgId, "org id")}/libraries${queryString(query)}`)).libraries ?? [],
    get: async (orgId, key) => (await call<{ library: OrgLibraryInfo }>("GET", `/orgs/${seg(orgId, "org id")}/libraries/${seg(key, "library key")}`)).library,
    updateSettings: async (orgId, key, input) => (await call<{ library: OrgLibraryInfo }>("PUT", `/orgs/${seg(orgId, "org id")}/libraries/${seg(key, "library key")}/settings`, cleanSettingsInput(input))).library,
    setScope: async (key, scope) => {
      if (scope !== "team" && scope !== "org") throw new StoreError("invalid", "bad scope");
      return (await call<{ library: OrgLibraryInfo }>("PATCH", `/libraries/${seg(key, "library key")}`, { scope })).library;
    },
    teamLibraries: async (teamId) => (await call<{ libraries: TeamLibraryRow[] }>("GET", `/teams/${seg(teamId, "team id")}/libraries`)).libraries ?? [],
  };
}
