/**
 * The org spaces' repositories (docs/multiplayer.md §14.6), committed before Phase 7 round 1: round 1b adds them to
 * StoreApi (orgs / teams / projects / admin) and the `org` event topic; 1d's fake implements AdminRepository.
 */
import type * as O from "./types";
import type * as I from "./identity";
import type * as G from "./governance";
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
  | { type: "cache.stale"; orgId: string; offline: boolean }
  /** Governance+ (docs/governance.md §2.5, round 14e): the server refused a call or a file's socket with one of its codes.
   *  `orgId`: the org whose gate it is (null: account-wide, `network_restricted`); `fileKey`: the shared file refused.
   *  For org gates the store re-reads the org first (`org.updated`, `orgs.changed`), so `OrgSummary.gate` is fresh. */
  | { type: "access.blocked"; orgId: string | null; code: G.GovernanceErrorCode; gate?: G.OrgGate; fileKey?: FileKey };

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
  /**
   * Admin › Settings › Delete organization (org admins; docs/multiplayer.md §14.17): `confirmName` is the org's name as
   * typed. The org is hidden from its people and deleted for good 14 days later (`OrgInfo.purgeAt`); until then its
   * admins still list it (`deletedAt`) and can `restore` it.
   */
  remove(orgId: string, confirmName: string): Promise<O.OrgInfo>;
  restore(orgId: string): Promise<O.OrgInfo>;
  /** The caller's drafts in the trash (Home's Trash: Restore, Delete forever) */
  trashedDrafts(orgId: string): Promise<O.OrgFile[]>;
  /** Admin › Settings › Organization name (org admins; docs/multiplayer.md §14.16) */
  update(orgId: string, patch: { name: string }): Promise<O.OrgInfo>;
  /** Admin › Settings › Organization icon: a square PNG / JPEG / WebP / GIF ≤ 1 MB (the view crops it to 256 × 256) */
  setIcon(orgId: string, image: Uint8Array): Promise<O.OrgInfo>;
  removeIcon(orgId: string): Promise<O.OrgInfo>;
  /** An org's or team's `iconUrl` as a data: URL the views can show (the page loads no network pictures); null when
   *  it can't be had (offline, gone). Kept for the session: the URL names its bytes. */
  iconData(iconUrl: string): Promise<string | null>;
  watch(listener: (e: OrgEvent) => void): Unsubscribe;
}

export interface TeamsRepository {
  /** "mine": teams the user is in; "browse": also the Visible and audience-reachable teams of the org (members only) */
  list(orgId: string, filter?: "mine" | "browse"): Promise<O.TeamSummary[]>;
  get(teamId: string): Promise<O.TeamInfo>;
  create(orgId: string, input: { name: string; workspaceId?: string | null }): Promise<O.TeamInfo>;
  update(teamId: string, patch: O.TeamPatch): Promise<O.TeamInfo>;
  /** "Change icon" (the team's admins): as OrgsRepository.setIcon */
  setIcon(teamId: string, image: Uint8Array): Promise<O.TeamInfo>;
  /** "Remove icon" (ours): back to the initial */
  removeIcon(teamId: string): Promise<O.TeamInfo>;
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
  /** "Delete forever" for files in the trash (their owners, admins): gone with their rooms, comments and links */
  deleteFilesForever(keys: string[]): Promise<void>;
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

/** Governance+ (docs/governance.md §4; round 14): Admin's calls (org admins) plus the members' gates and the caller's
 *  own two-factor authentication. The store maps the server's 403 codes to StoreError "forbidden" with `detail.code`. */
export interface GovernanceRepository {
  // ---- admin
  overview(orgId: string): Promise<G.GovernanceOverview>;
  /** Admin › Billing › Governance+ Add / Remove; removing while key management is on: "conflict" */
  setGovernancePlus(orgId: string, on: boolean): Promise<G.GovernanceOverview>;
  setIpAllowlist(orgId: string, input: { enabled: boolean; ranges: string[] }): Promise<G.IpAllowlist>;
  addNetworkRange(orgId: string, cidr: string): Promise<G.NetworkRange>;
  setNetworkRange(orgId: string, rangeId: string, state: G.NetworkRangeState): Promise<G.NetworkRange>;
  removeNetworkRange(orgId: string, rangeId: string): Promise<void>;
  policies(orgId: string): Promise<G.InternalPolicy[]>;
  createPolicy(orgId: string, input: G.InternalPolicyInput): Promise<G.InternalPolicy>;
  /** Enable or disable; a policy's text never changes (§2.6) */
  setPolicyEnabled(orgId: string, policyId: string, enabled: boolean): Promise<G.InternalPolicy>;
  /** People › Change / Remove expiration date, and the bulk action; null removes */
  setGuestExpiration(orgId: string, userIds: string[], expiresAt: number | null): Promise<void>;
  ekm(orgId: string): Promise<G.EkmStatus>;
  enableEkm(orgId: string, input: G.EkmInput): Promise<G.EkmStatus>;
  /** Encrypts one existing file (`encrypting`); call until it is null */
  encryptNext(orgId: string): Promise<G.EkmStatus>;
  developerLogs(orgId: string, query: G.DeveloperLogsQuery): Promise<G.DeveloperLogsResponse["meta"]>;
  idps(orgId: string): Promise<I.IdpConfig[]>;
  /** tenantId absent: + Add IDP */
  saveIdp(orgId: string, tenantId: string | null, input: I.IdpConfigInput): Promise<I.IdpConfig>;
  refreshIdp(orgId: string, tenantId: string): Promise<I.IdpConfig>;
  removeIdp(orgId: string, tenantId: string): Promise<void>;
  generateIdpScimToken(orgId: string, tenantId: string): Promise<I.ScimTokenCreated>;
  revokeIdpScimToken(orgId: string, tenantId: string): Promise<void>;
  /** null unmaps the domain */
  mapDomain(orgId: string, domain: string, tenantId: string | null): Promise<I.OrgDomain>;
  // ---- members
  pendingPolicies(orgId: string): Promise<G.PolicyPrompt[]>;
  acknowledgePolicy(orgId: string, policyId: string): Promise<void>;
  // ---- the caller's account (Settings › Security)
  twoFactor(): Promise<G.TwoFactorStatus>;
  setupTwoFactor(): Promise<G.TwoFactorSetup>;
  enableTwoFactor(code: string): Promise<G.TwoFactorEnabled>;
  regenerateRecoveryCodes(code: string): Promise<G.TwoFactorEnabled>;
  disableTwoFactor(code: string): Promise<void>;
}
