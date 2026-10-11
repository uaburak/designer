/**
 * The store's org spaces for Home (docs/multiplayer.md §14.6): the orgs the person is in, the shown org and its
 * teams (the sidebar), the folders under each opened team or folder (loaded when opened), and what the current
 * org location lists — reloaded whenever the `org` topic reports a change (the store's cache answers first, then
 * refreshes behind and says so).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type * as O from "@shared/org/types";
import type { Location } from "./model";
import type { Destination } from "./orgDialogs";
import type { OrgBackend } from "./storeAccess";

export interface OrgShell {
  /** Every org the person is in (the space switcher); empty signed out */
  orgs: O.OrgSummary[];
  /** The shown org, once loaded */
  info: O.OrgInfo | null;
  /** The person's teams in it (the sidebar) */
  teams: O.TeamSummary[];
  /** Folders by "<teamId>/<parentId or ''>" — loaded as the sidebar opens them */
  folders: Record<string, O.ProjectSummary[]>;
}

export type OrgPageData =
  | { kind: "none" }
  | { kind: "drafts"; files: O.OrgFile[] }
  | { kind: "teams"; teams: O.TeamSummary[]; groups: O.UserGroup[] }
  | { kind: "team"; team: O.TeamInfo; folders: O.ProjectSummary[]; members: O.TeamMember[]; requests: O.JoinRequest[] }
  | { kind: "project"; project: O.ProjectInfo; team: O.TeamInfo | null; folders: O.ProjectSummary[]; files: O.OrgFile[]; members: O.ProjectMember[] }
  | { kind: "trash"; teams: { team: O.TeamSummary; projects: O.ProjectSummary[]; files: O.OrgFile[] }[] }
  | { kind: "search"; text: string; result: O.OrgSearchResult };

export interface OrgPageState {
  ready: boolean;
  error: string | null;
  /** The location it was loaded for (a stale page isn't shown) */
  key: string;
  page: OrgPageData;
  loadedAt: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const folderKey = (teamId: string, parentId: string | null) => `${teamId}/${parentId ?? ""}`;
const quiet = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);

export async function loadOrgPage(org: OrgBackend, orgId: string, loc: Location, teams: readonly O.TeamSummary[]): Promise<OrgPageData> {
  switch (loc.kind) {
    case "org-drafts":
      return { kind: "drafts", files: await org.orgs.drafts(orgId) };
    case "teams": {
      const [browse, groups] = await Promise.all([org.teams.list(orgId, "browse"), quiet(org.orgs.groups(orgId), [])]);
      return { kind: "teams", teams: browse, groups };
    }
    case "team": {
      const team = await org.teams.get(loc.teamId);
      const [folders, members, requests] = await Promise.all([
        quiet(org.projects.list(team.id, null), []),
        quiet(org.teams.members(team.id), []),
        team.me?.admin || team.me?.owner ? quiet(org.teams.requests(team.id), []) : Promise.resolve([]),
      ]);
      return { kind: "team", team, folders, members, requests };
    }
    case "project": {
      const project = await org.projects.get(loc.projectId);
      const [team, folders, files, members] = await Promise.all([
        quiet(org.teams.get(project.teamId), null),
        quiet(org.projects.list(project.teamId, project.id), []),
        org.projects.files(project.id),
        quiet(org.projects.members(project.id), []),
      ]);
      return { kind: "project", project, team, folders, files, members };
    }
    case "org-trash": {
      const out = await Promise.all(teams.map(async (team) => ({ team, ...(await quiet(org.projects.trashed(team.id), { projects: [], files: [] })) })));
      return { kind: "trash", teams: out.filter((t) => t.projects.length || t.files.length) };
    }
    case "search":
      return loc.text.trim() ? { kind: "search", text: loc.text, result: await org.orgs.search(orgId, loc.text.trim()) } : { kind: "none" };
    default:
      return { kind: "none" };
  }
}

/**
 * "Move to…" places in one org: Drafts (files only), each team the person can add to with its folders in tree order.
 * Files can't sit in a team directly (its row is a header); a folder can go to a team's top level. `exclude`: a moved
 * folder (and so everything under it).
 */
export async function orgDestinations(org: OrgBackend, orgId: string, input: { forFolder: boolean; exclude?: string | null; isAdmin: boolean }): Promise<Destination[]> {
  const teams = (await org.teams.list(orgId, "mine")).filter((t) => input.isAdmin || t.me?.role === "editor" || t.me?.admin || t.me?.owner);
  const out: Destination[] = input.forFolder ? [] : [{ id: "drafts", label: "Drafts", depth: 1, kind: "drafts" }];
  for (const t of [...teams].sort((a, b) => a.name.localeCompare(b.name))) {
    out.push({ id: `team:${t.id}`, label: t.name, depth: 1, kind: input.forFolder ? "team" : "header", teamId: t.id });
    const walk = async (parentId: string | null, depth: number): Promise<void> => {
      const list = await org.projects.list(t.id, parentId).catch(() => [] as O.ProjectSummary[]);
      for (const p of [...list].sort((a, b) => a.name.localeCompare(b.name))) {
        if (p.id === input.exclude) continue;
        out.push({ id: p.id, label: p.name, depth, kind: "folder", disabled: !input.isAdmin && p.me === "viewer", teamId: t.id });
        if (p.folderCount > 0 && depth < 11) await walk(p.id, depth + 1);
      }
    };
    await walk(null, 2);
  }
  return out;
}

/** The org's shell (switcher, sidebar) and the shown location's page. */
export function useOrgData(org: OrgBackend | undefined, orgId: string | null, location: Location, active: boolean) {
  const [shell, setShell] = useState<OrgShell>({ orgs: [], info: null, teams: [], folders: {} });
  const [page, setPage] = useState<OrgPageState>({ ready: false, error: null, key: "", page: { kind: "none" }, loadedAt: 0 });
  const opened = useRef(new Set<string>());
  const locRef = useRef(location);
  const teamsRef = useRef<O.TeamSummary[]>([]);
  useLayoutEffect(() => {
    locRef.current = location;
    teamsRef.current = shell.teams;
  });
  const seq = useRef(0);

  const readShell = useCallback(async (): Promise<OrgShell | null> => {
    if (!org) return null;
    const orgs = await org.orgs.list().catch(() => [] as O.OrgSummary[]);
    if (!orgId) return { orgs, info: null, teams: [], folders: {} };
    const [info, teams] = await Promise.all([org.orgs.get(orgId).catch(() => null), org.teams.list(orgId, "mine").catch(() => [] as O.TeamSummary[])]);
    teamsRef.current = teams;
    const folders: Record<string, O.ProjectSummary[]> = {};
    await Promise.all(
      [...opened.current].map(async (k) => {
        const [teamId, parent] = k.split("/");
        if (!teams.some((t) => t.id === teamId)) return;
        folders[k] = await org.projects.list(teamId, parent || null).catch(() => []);
      }),
    );
    return { orgs, info, teams, folders };
  }, [org, orgId]);
  const loadShell = useCallback(
    () =>
      readShell().then((s) => {
        if (s) setShell(s);
      }),
    [readShell],
  );

  const loadPage = useCallback(async () => {
    if (!org || !orgId || !active) return;
    const mine = ++seq.current;
    const loc = locRef.current;
    const key = JSON.stringify(loc);
    try {
      const data = await loadOrgPage(org, orgId, loc, teamsRef.current);
      if (mine === seq.current) setPage({ ready: true, error: null, key, page: data, loadedAt: Date.now() });
    } catch (e) {
      if (mine === seq.current) setPage({ ready: true, error: message(e), key, page: { kind: "none" }, loadedAt: Date.now() });
    }
  }, [org, orgId, active]);

  const reload = useCallback(() => {
    void loadShell().then(() => loadPage());
  }, [loadShell, loadPage]);

  /** The sidebar opens a team or a folder: its folders, once */
  const openFolders = useCallback(
    (teamId: string, parentId: string | null) => {
      if (!org) return;
      const k = folderKey(teamId, parentId);
      opened.current.add(k);
      void org.projects.list(teamId, parentId).then(
        (list) => setShell((s) => ({ ...s, folders: { ...s.folders, [k]: list } })),
        () => {},
      );
    },
    [org],
  );

  useEffect(() => {
    opened.current.clear();
    void loadShell();
  }, [loadShell]);
  const key = JSON.stringify(location);
  useEffect(() => {
    void loadPage();
  }, [loadPage, key, shell.teams.length]);

  // Live: the `org` topic (writes from this view or another, Inbox notices, cache refreshes), coalesced.
  useEffect(() => {
    if (!org) return;
    let timer: number | undefined;
    const off = org.orgs.watch(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(reload, 16);
    });
    return () => {
      window.clearTimeout(timer);
      off();
    };
  }, [org, reload]);

  return { shell, page, reload, openFolders };
}
