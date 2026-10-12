/**
 * Home's pages in one request each (docs/multiplayer.md §14.12 "Pages"). A team page read `/teams/:id`, its folders,
 * `/members` and `/requests` one after another — four or five requests of 300–1000 ms each between Turkey and D1 in
 * Frankfurt. These routes answer the same parts in one response, each part exactly as its own route would (a part the
 * caller's own route would refuse is empty: the store read those quietly), with their reads prefetched together
 * (requestD1.ts): the page's lists in one round trip, then every listed folder's and file's access reads in one more.
 *
 * - `GET /teams/:id/page` → `{team, folders, members, requests}`
 * - `GET /projects/:id/page` → `{project, team, folders, files, members}`
 *
 * The single routes stay (older apps read them).
 */
import type { JoinRequest, OrgFile, ProjectInfo, ProjectMember, ProjectSummary, TeamInfo, TeamMember } from "../../../src/shared/org/types";
import { prefetch } from "../requestD1";
import { accessibleFiles, FOLDER_FILES, Q, readAll, type FileRow, type ProjectRow, type TeamRow } from "./db";
import { HttpError, type Ctx } from "./http";
import { projectInfo, projectMembers, projectSummaries } from "./projects";
import { joinRequests, teamInfo, teamMembers } from "./teams";

export interface TeamPage {
  team: TeamInfo;
  folders: ProjectSummary[];
  members: TeamMember[];
  requests: JoinRequest[];
}

export interface ProjectPage {
  project: ProjectInfo;
  team: TeamInfo | null;
  folders: ProjectSummary[];
  files: OrgFile[];
  members: ProjectMember[];
}

/** After `requireTeam` (teamsRoute): `/projects` and `/members` need a live team, `/requests` its admins */
export async function teamPage(ctx: Ctx, team: TeamRow, rights: { admin: boolean }): Promise<TeamPage> {
  const { acc } = ctx;
  const live = team.deleted_at === null;
  const admin = live && rights.admin;
  await prefetch(acc.d1, [live && Q.teamFolders(team.id, null), live && Q.teamMemberRows(team.id, team.org_id), live && Q.grantedGroups("team", team.id), admin && Q.joinRequests(team.id, team.org_id)]);
  const rows = live ? await readAll<ProjectRow>(acc.d1, Q.teamFolders(team.id, null)) : [];
  return {
    team: await teamInfo(ctx, team),
    folders: live ? await projectSummaries(acc, rows) : [],
    members: live ? await teamMembers(ctx, team) : [],
    requests: admin ? await joinRequests(ctx, team) : [],
  };
}

/** After projectsRoute's checks (the folder is the caller's to see, the gate): the team and its subfolders as the team
 *  routes answer them (null and none when the caller can't see the team), the files and members as the folder's own */
export async function projectPage(ctx: Ctx, p: ProjectRow, team: TeamRow): Promise<ProjectPage> {
  const { acc } = ctx;
  const seen = await acc.requireTeam(team.id).then(
    () => true,
    (e) => {
      if (e instanceof HttpError) return false;
      throw e;
    },
  );
  const folders = seen && team.deleted_at === null;
  const chain = await acc.chain(p.id);
  await prefetch(acc.d1, [
    folders && Q.teamFolders(team.id, p.id),
    Q.fileList(FOLDER_FILES, [p.id]),
    Q.folderOwner(p.owner_id, team.org_id),
    ...chain.flatMap((f) => [Q.folderMemberRows(f.id, team.org_id), Q.grantedGroups("project", f.id)]),
    Q.teamMemberRows(team.id, team.org_id),
    Q.grantedGroups("team", team.id),
  ]);
  const subfolders = folders ? await readAll<ProjectRow>(acc.d1, Q.teamFolders(team.id, p.id)) : [];
  const fileRows = await readAll<FileRow>(acc.d1, Q.fileList(FOLDER_FILES, [p.id]));
  // Every listed folder's and file's access reads, together
  await prefetch(acc.d1, [...acc.projectsQueries([p, ...subfolders]), ...acc.filesQueries(fileRows)]);
  return {
    project: await projectInfo(acc, p),
    team: seen ? await teamInfo(ctx, team) : null,
    folders: folders ? await projectSummaries(acc, subfolders) : [],
    files: await accessibleFiles(acc, FOLDER_FILES, [p.id]),
    members: await projectMembers(ctx, team, p),
  };
}
