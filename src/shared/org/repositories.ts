/**
 * The org spaces' repositories (docs/multiplayer.md §14.6), committed before Phase 7 round 1: round 1b adds them to
 * StoreApi (orgs / teams / projects / admin) and the `org` event topic; 1d's fake implements AdminRepository.
 */
import type * as O from "./types";
import type * as I from "./identity";
import type { FileKey } from "../store/types";
import type { Unsubscribe } from "../store/emitter";
import type { AccessTokenInfo, TokenScope } from "../account";

export type SpaceId = "local" | `org:${string}`;

export type OrgEvent =
  | { type: "orgs.changed" }                                  // membership, role or seat of the user changed
  | { type: "org.updated"; orgId: string }
  | { type: "teams.changed"; orgId: string }
  | { type: "team.updated"; teamId: string }
  | { type: "projects.changed"; teamId: string; parentId: string | null }
  | { type: "files.changed"; orgId: string; projectId: string | null } // null: drafts
  | { type: "cache.stale"; orgId: string; offline: boolean };

export interface OrgsRepository {
  /** The orgs the user is in (cached; empty when signed out) */
  list(): Promise<O.OrgSummary[]>;
  get(orgId: string): Promise<O.OrgInfo>;
  /** "Create organization": the caller becomes its admin with a Full seat; `importSharedFiles` runs §14.8 */
  create(input: { name: string; importSharedFiles?: boolean }): Promise<O.OrgInfo>;
  /** The people the caller may share with or @mention: members (to members), the groups (§14.1) */
  people(orgId: string, query?: { text?: string; limit?: number }): Promise<{ people: O.PersonRef[]; groups: O.GroupRef[] }>;
  /** The caller's drafts in this org */
  drafts(orgId: string): Promise<O.OrgFile[]>;
  createDraft(orgId: string, input?: { name?: string; editorType?: O.EditorType }): Promise<{ fileKey: FileKey; file: O.OrgFile }>;
  search(orgId: string, text: string): Promise<O.OrgSearchResult>;
  /** "Ask to upgrade" */
  requestSeat(orgId: string, seat: Exclude<O.Seat, "view">, note?: string): Promise<O.SeatRequest>;
  /** User groups (any member may create unless OrgSettings.groupCreation is "admins") */
  groups(orgId: string): Promise<O.UserGroup[]>;
  createGroup(orgId: string, input: { name: string; description?: string; userIds?: string[] }): Promise<O.UserGroup>;
  updateGroup(groupId: string, patch: { name?: string; description?: string }): Promise<O.UserGroup>;
  setGroupMembers(groupId: string, change: { add?: string[]; remove?: string[] }): Promise<O.UserGroup>;
  deleteGroup(groupId: string): Promise<void>;
  leave(orgId: string): Promise<void>;
  watch(listener: (e: OrgEvent) => void): Unsubscribe;
}

export interface TeamsRepository {
  /** "mine": teams the user is in; "browse": also the Visible and audience-reachable teams of the org (members only) */
  list(orgId: string, filter?: "mine" | "browse"): Promise<O.TeamSummary[]>;
  get(teamId: string): Promise<O.TeamInfo>;
  create(orgId: string, input: { name: string; workspaceId?: string | null }): Promise<O.TeamInfo>;
  update(teamId: string, patch: O.TeamPatch): Promise<O.TeamInfo>;
  /** Soft delete (admins and the owner); restore from Admin or by the owner within the sweep */
  remove(teamId: string): Promise<void>;
  restore(teamId: string): Promise<O.TeamInfo>;
  /** Only the owner; the new owner must be a member of the team */
  transfer(teamId: string, userId: string): Promise<O.TeamInfo>;
  members(teamId: string): Promise<O.TeamMember[]>;
  /** Invite a person (email) or a group as can edit / can view; `admin` only by admins */
  invite(teamId: string, input: { email?: string; groupId?: string; role: O.GrantRole; admin?: boolean }): Promise<O.TeamMember[]>;
  setMember(teamId: string, principal: O.Principal, patch: { role?: O.GrantRole; admin?: boolean }): Promise<O.TeamMember[]>;
  removeMember(teamId: string, principal: O.Principal): Promise<O.TeamMember[]>;
  /** A Visible team: joins at once when the team's audience allows, else asks the admins */
  join(teamId: string): Promise<{ status: "joined" | "requested" }>;
  leave(teamId: string): Promise<void>;
  requests(teamId: string): Promise<O.JoinRequest[]>;
  answerRequest(teamId: string, userId: string, approve: boolean): Promise<O.JoinRequest[]>;
}

export interface ProjectsRepository {
  /** Folders of a team at one level (parentId null: top level), with counts */
  list(teamId: string, parentId?: string | null): Promise<O.ProjectSummary[]>;
  get(projectId: string): Promise<O.ProjectInfo>;
  create(teamId: string, input: { name: string; parentId?: string | null; access?: O.InheritMode }): Promise<O.ProjectInfo>;
  update(projectId: string, patch: { name?: string; access?: O.InheritMode }): Promise<O.ProjectInfo>;
  /** Move within the org: another parent or another team (depth ≤ 10 kept, else `invalid`) */
  move(projectId: string, to: { teamId: string; parentId: string | null }): Promise<O.ProjectInfo>;
  trash(projectId: string): Promise<void>;
  restore(projectId: string): Promise<O.ProjectInfo>;
  deleteForever(projectId: string): Promise<void>;
  members(projectId: string): Promise<O.ProjectMember[]>;
  invite(projectId: string, input: { email?: string; groupId?: string; role: O.GrantRole }): Promise<O.ProjectMember[]>;
  setMember(projectId: string, principal: O.Principal, role: O.GrantRole): Promise<O.ProjectMember[]>;
  removeMember(projectId: string, principal: O.Principal): Promise<O.ProjectMember[]>;
  /** Files directly in the folder */
  files(projectId: string): Promise<O.OrgFile[]>;
  createFile(projectId: string, input?: { name?: string; editorType?: O.EditorType }): Promise<{ fileKey: FileKey; file: O.OrgFile }>;
  /** Org files (by room key) into a folder, or into the mover's drafts (null) — same org only */
  moveFiles(keys: string[], to: { projectId: string | null }): Promise<void>;
  /** A local file into a folder: §5's share with a destination; the editor hands the snapshot (as multiplayer.share) */
  moveLocalFile(fileKey: FileKey, projectId: string, input: { snapshot: Uint8Array; headSeq: number }): Promise<O.OrgFile>;
  trashFiles(keys: string[]): Promise<void>;
  restoreFiles(keys: string[]): Promise<void>;
  /** The team's trash (folders and files), for editors and admins */
  trashed(teamId: string): Promise<{ projects: O.ProjectSummary[]; files: O.OrgFile[] }>;
}

/** The Admin location (src/renderer/src/admin/): org admins; workspace / billing group admins see their part. */
export interface AdminRepository {
  dashboard(orgId: string): Promise<O.AdminDashboard>;
  people(orgId: string, query?: O.PeopleQuery): Promise<O.Page<O.AdminPerson>>;
  addPeople(orgId: string, input: O.AddPeopleInput): Promise<O.AdminPerson[]>;
  updatePeople(orgId: string, input: O.UpdatePeopleInput): Promise<O.AdminPerson[]>;
  removePeople(orgId: string, userIds: string[]): Promise<void>;
  seatRequests(orgId: string, state?: "pending" | "all"): Promise<O.SeatRequest[]>;
  answerSeatRequest(orgId: string, id: string, approve: boolean): Promise<O.SeatRequest>;
  guestRequests(orgId: string): Promise<O.GuestRequest[]>;
  answerGuestRequest(orgId: string, id: string, approve: boolean): Promise<O.GuestRequest>;
  teams(orgId: string, query?: O.TeamsQuery): Promise<O.Page<O.AdminTeam>>;
  workspaces(orgId: string): Promise<O.OrgWorkspace[]>;
  createWorkspace(orgId: string, input: { name: string; adminIds: string[]; hidden?: boolean }): Promise<O.OrgWorkspace>;
  updateWorkspace(workspaceId: string, patch: O.WorkspacePatch): Promise<O.OrgWorkspace>;
  deleteWorkspace(workspaceId: string): Promise<void>;
  billingGroups(orgId: string): Promise<O.BillingGroup[]>;
  createBillingGroup(orgId: string, input: { name: string; adminIds?: string[] }): Promise<O.BillingGroup>;
  updateBillingGroup(id: string, patch: { name?: string; adminIds?: string[] }): Promise<O.BillingGroup>;
  deleteBillingGroup(id: string): Promise<void>;
  activity(orgId: string, query?: O.ActivityQuery): Promise<O.ActivityPage>;
  settings(orgId: string): Promise<O.OrgSettings>;
  updateSettings(orgId: string, patch: Partial<O.OrgSettings>): Promise<O.OrgSettings>;
  unassignedDrafts(orgId: string): Promise<O.UnassignedDrafts[]>;
  moveUnassigned(orgId: string, input: { fileKeys?: string[]; ownerId?: string; to: { projectId: string } | { teamId: string } }): Promise<void>;
  deleteUnassigned(orgId: string, fileKeys: string[]): Promise<void>;
  /** CSV text of People, Teams or Activity with the same query (the view saves it through main's Save dialog) */
  exportCsv(orgId: string, what: "people" | "teams" | "activity", query?: unknown): Promise<string>;
  /** Admin › Settings › Plan access tokens (docs/multiplayer.md §16.3; org admins): the org's tokens, newest first */
  planTokens(orgId: string): Promise<AccessTokenInfo[]>;
  /** A new plan access token; `token` is shown once */
  createPlanToken(orgId: string, input: { description: string; expiresInDays: number; scopes: TokenScope[] }): Promise<{ token: string; info: AccessTokenInfo }>;
  revokePlanToken(orgId: string, tokenId: string): Promise<void>;
}

/** Admin › Settings › Login and provisioning, domains, data storage localization (docs/multiplayer.md §15; org admins) */
export interface IdentityRepository {
  overview(orgId: string): Promise<I.IdentityOverview>;
  saveIdp(orgId: string, input: I.IdpConfigInput): Promise<I.IdpConfig>;
  refreshIdpMetadata(orgId: string): Promise<I.IdpConfig>;
  deleteIdp(orgId: string): Promise<void>;
  generateScimToken(orgId: string): Promise<I.ScimTokenCreated>;
  revokeScimToken(orgId: string): Promise<void>;
  addDomain(orgId: string, domain: string): Promise<I.OrgDomain>;
  /** The record not there: a StoreError "conflict" with `detail: {code: "domain_unverified", found}` (the TXT values seen); another org's: `detail.code` "domain_taken" */
  verifyDomain(orgId: string, domain: string): Promise<I.OrgDomain>;
  removeDomain(orgId: string, domain: string): Promise<void>;
  domainAccounts(orgId: string, domain: string): Promise<O.PersonRef[]>;
  dataRegion(orgId: string): Promise<I.DataRegionStatus>;
  setDataRegion(orgId: string, region: I.DataRegion): Promise<I.DataRegionStatus>;
  /** Moves one file or library (`moving`: the key this call moved); call until `moving` is null (docs/multiplayer.md §15.16) */
  moveNext(orgId: string): Promise<I.DataRegionStatus>;
}
