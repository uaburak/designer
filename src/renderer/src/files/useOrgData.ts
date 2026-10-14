/**
 * The store's org spaces for Home (docs/multiplayer.md §14.6): the orgs the person is in, the shown org and its
 * teams (the sidebar), the folders under each opened team or folder (loaded when opened), and what the current
 * org location lists — reloaded whenever the `org` topic reports a change (the store's cache answers first, then
 * refreshes behind and says so).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "@/i18n";
import type * as O from "@shared/org/types";
import type { OrgGate } from "@shared/org/governance";
import { effectiveGate, gateOfError, isNetworkRestricted } from "./governance";
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
  /** The account is on a network that only allows work accounts (docs/governance.md §2.5: 403 `network_restricted`) */
  network?: boolean;
  /**
   * The space (`orgId`, null for the local one) `orgs` was read for, once the store answered the list: an org missing
   * from it then is gone for the person (removed, left, an expired guest), and Home falls back to their own space.
   */
  listedFor?: string | null;
}

export type OrgPageData =
  | { kind: "none" }
  | { kind: "drafts"; files: O.OrgFile[] }
  /** `teamNames`: each team's name by id (a card says its team) */
  | { kind: "all-projects"; files: O.OrgFile[]; teamNames: Record<string, string> }
  | { kind: "teams"; teams: O.TeamSummary[]; groups: O.UserGroup[] }
  /** `files`: the team's projects — every file in its folders (Home shows a team's projects, not its folders) */
  | { kind: "team"; team: O.TeamInfo; folders: O.ProjectSummary[]; members: O.TeamMember[]; requests: O.JoinRequest[]; files: O.OrgFile[] }
  | { kind: "project"; project: O.ProjectInfo; team: O.TeamInfo | null; folders: O.ProjectSummary[]; files: O.OrgFile[]; members: O.ProjectMember[] }
  | { kind: "trash"; drafts: O.OrgFile[]; teams: { team: O.TeamSummary; projects: O.ProjectSummary[]; files: O.OrgFile[] }[] }
  | { kind: "search"; text: string; result: O.OrgSearchResult };

export interface OrgPageState {
  ready: boolean;
  error: string | null;
  /** The location it was loaded for (a stale page isn't shown) */
  key: string;
  page: OrgPageData;
  loadedAt: number;
  /** What refused the page (docs/governance.md §2.5): an org gate, or the network restriction */
  blocked?: OrgGate | "network" | null;
  /** The org whose read was refused (a gate is that org's only) */
  blockedOrg?: string | null;
}

const NO_REFUSALS: { gates: Readonly<Record<string, OrgGate>>; network: boolean } = { gates: {}, network: false };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const folderKey = (teamId: string, parentId: string | null) => `${teamId}/${parentId ?? ""}`;
const quiet = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
const NO_AGREED: ReadonlySet<string> = new Set();

export async function loadOrgPage(org: OrgBackend, orgId: string, loc: Location, teams: readonly O.TeamSummary[]): Promise<OrgPageData> {
  switch (loc.kind) {
    case "all-projects": {
      // The org shown (the space chosen): every project the person can open in it — their drafts and every team's
      // folders, all levels — from the server's one listing; a server without that route (before its deploy) is read
      // team by team, folder by folder
      const teams = await quiet(org.teams.list(orgId, "browse"), []);
      const teamNames = Object.fromEntries(teams.map((t) => [t.id, t.name]));
      const files = await org.orgs.files(orgId).catch(async () => {
        const drafts = await quiet(org.orgs.drafts(orgId), []);
        const filesIn = async (teamId: string, parentId: string | null): Promise<O.OrgFile[]> => {
          const folders = (await quiet(org.projects.list(teamId, parentId), [])).filter((f) => f.trashedAt === null);
          const lists = await Promise.all(folders.map(async (f) => [...(await quiet(org.projects.files(f.id), [])), ...(f.folderCount > 0 ? await filesIn(teamId, f.id) : [])]));
          return lists.flat();
        };
        return [...drafts, ...(await Promise.all(teams.map((t) => filesIn(t.id, null)))).flat()];
      });
      const seen = new Set<string>();
      return { kind: "all-projects", files: files.filter((f) => f.trashedAt === null && !seen.has(f.key) && seen.add(f.key)), teamNames };
    }
    case "org-drafts":
      return { kind: "drafts", files: await org.orgs.drafts(orgId) };
    case "teams": {
      const [browse, groups] = await Promise.all([org.teams.list(orgId, "browse"), quiet(org.orgs.groups(orgId), [])]);
      return { kind: "teams", teams: browse, groups };
    }
    case "team": {
      // One request (`GET /teams/:id/page`), answered from the store's cache at once when it has the page
      const filesOf = async (folders: readonly O.ProjectSummary[]) => (await Promise.all(folders.filter((f) => f.trashedAt === null).map((f) => quiet(org.projects.files(f.id), [])))).flat();
      if (org.teams.page) {
        const page = await org.teams.page(loc.teamId);
        return { kind: "team", ...page, files: await filesOf(page.folders) };
      }
      const team = await org.teams.get(loc.teamId);
      const [folders, members, requests] = await Promise.all([
        quiet(org.projects.list(team.id, null), []),
        quiet(org.teams.members(team.id), []),
        team.me?.admin || team.me?.owner ? quiet(org.teams.requests(team.id), []) : Promise.resolve([]),
      ]);
      return { kind: "team", team, folders, members, requests, files: await filesOf(folders) };
    }
    case "project": {
      if (org.projects.page) return { kind: "project", ...(await org.projects.page(loc.projectId)) };
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
      // The person's drafts in the trash first, then each team's trash (Figma's Trash lists what you deleted)
      const [drafts, out] = await Promise.all([quiet(org.orgs.trashedDrafts(orgId), []), Promise.all(teams.map(async (team) => ({ team, ...(await quiet(org.projects.trashed(team.id), { projects: [], files: [] })) })))]);
      return { kind: "trash", drafts, teams: out.filter((t) => t.projects.length || t.files.length) };
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
  const out: Destination[] = input.forFolder ? [] : [{ id: "drafts", label: t("Drafts"), depth: 1, kind: "drafts" }];
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
export function useOrgData(org: OrgBackend | undefined, orgId: string | null, location: Location, active: boolean, agreed: ReadonlySet<string> = NO_AGREED) {
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
  // What the store said refused a call or a shared file's socket (`access.blocked`, docs/governance.md §9 14e): an
  // org's gate, or the account-wide network restriction. Cleared when the orgs are read again (`orgs.changed`: an
  // agreement, 2FA turned on, another account), which comes before a new refusal's event.
  const [refused, setRefused] = useState<{ gates: Readonly<Record<string, OrgGate>>; network: boolean }>(NO_REFUSALS);
  // Another org: a read of the last one still on its way is dropped (its refusal is not this org's; the page's
  // `blockedOrg` keeps a gate to its own org, below).
  useLayoutEffect(() => {
    seq.current++;
  }, [orgId]);

  const readShell = useCallback(async (): Promise<OrgShell | null> => {
    if (!org) return null;
    let network = false;
    let listed = true;
    const orgs = await org.orgs.list().catch((e: unknown) => {
      network = isNetworkRestricted(e);
      listed = false;
      return [] as O.OrgSummary[];
    });
    if (network) return { orgs, info: null, teams: [], folders: {}, network };
    const listedFor = listed ? orgId : undefined;
    if (!orgId) return { orgs, info: null, teams: [], folders: {}, listedFor };
    // Gone from the list: nothing more to read there (Home switches back to the person's own space)
    if (listed && !orgs.some((o) => o.id === orgId)) return { orgs, info: null, teams: [], folders: {}, listedFor };
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
    return { orgs, info, teams, folders, listedFor };
  }, [org, orgId]);
  const loadShell = useCallback(
    () =>
      readShell().then((s) => {
        if (s) setShell(s);
      }),
    [readShell],
  );

  // A gated org (its list entry says so, docs/governance.md §2.5) loads no page: every read would be refused.
  const eventGate = orgId ? (refused.gates[orgId] ?? null) : null;
  const gated = !!effectiveGate(shell.orgs.find((o) => o.id === orgId)?.gate ?? eventGate, agreed);
  const loadPage = useCallback(async () => {
    if (!org || !orgId || !active || gated) return;
    const mine = ++seq.current;
    const loc = locRef.current;
    const key = JSON.stringify(loc);
    try {
      const data = await loadOrgPage(org, orgId, loc, teamsRef.current);
      if (mine === seq.current) setPage({ ready: true, error: null, key, page: data, loadedAt: Date.now() });
    } catch (e) {
      const blocked = isNetworkRestricted(e) ? "network" : gateOfError(e);
      if (mine === seq.current) setPage({ ready: true, error: message(e), key, page: { kind: "none" }, loadedAt: Date.now(), blocked, blockedOrg: orgId });
    }
  }, [org, orgId, active, gated]);

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
  // Only the org's Trash lists by the sidebar's teams: other pages don't load again when the shell arrives (a team
  // page read /members and /requests twice on open)
  const teamsDep = location.kind === "org-trash" ? shell.teams.length : -1;
  useEffect(() => {
    void loadPage();
  }, [loadPage, key, teamsDep]);

  // Live: the `org` topic (writes from this view or another, Inbox notices, cache refreshes), coalesced.
  useEffect(() => {
    if (!org) return;
    let timer: number | undefined;
    const off = org.orgs.watch((e) => {
      if (e.type === "access.blocked") {
        if (e.code === "network_restricted") setRefused((r) => (r.network ? r : { ...r, network: true }));
        else if (e.orgId && e.gate) setRefused((r) => ({ ...r, gates: { ...r.gates, [e.orgId!]: e.gate! } }));
        return;
      }
      if (e.type === "orgs.changed") setRefused((r) => (r === NO_REFUSALS ? r : NO_REFUSALS));
      window.clearTimeout(timer);
      timer = window.setTimeout(reload, 16);
    });
    return () => {
      window.clearTimeout(timer);
      off();
    };
  }, [org, reload]);

  const shown = useMemo(() => (refused.network && !shell.network ? { ...shell, network: true } : shell), [shell, refused.network]);
  // No org A gate in org B (a gated B's page isn't read: its gate comes from the list)
  const shownPage = useMemo(() => (page.blocked && page.blocked !== "network" && page.blockedOrg !== orgId ? { ...page, blocked: null } : page), [page, orgId]);
  return { shell: shown, page: shownPage, reload, openFolders, eventGate };
}
