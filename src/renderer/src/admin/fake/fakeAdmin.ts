/**
 * A fake `AdminRepository` (docs/multiplayer.md §14.6) over the seed, in memory: what the Admin app runs against until
 * round 1b's store repositories land. It keeps the server's rules that the views show — counts follow changes, every
 * write logs Figma's activity action, removed people's drafts go to Unassigned drafts — and also implements the parts
 * of `OrgsRepository` (user groups) and `TeamsRepository` (restore) the Admin app uses.
 */
import type { AdminRepository, OrgsRepository } from "@shared/org/repositories";
import type * as O from "@shared/org/types";
import { ACTION_LABEL, SEAT_LABEL, formatUtc, productOf, teamAccess, toCsv, userType } from "../labels";
import { makeSeed, type Seed } from "./seed";
import { fakeOrgLibraries, fakeSharedFonts, seedResources, type FakeSharedFonts, type ResourcesState } from "./fakeResources";
import type { OrgLibrariesRepository } from "@shared/libraries/orgTypes";

export type { AdminTeamsApi } from "../context";
import type { AdminTeamsApi } from "../context";
export interface FakeAdminStore {
  admin: AdminRepository;
  orgs: OrgsRepository;
  teams: AdminTeamsApi;
  /** Admin › Resources › Libraries (docs/data.md §16.10 "Managing") */
  orgLibraries: OrgLibrariesRepository;
  /** Admin › Resources › Fonts: the preload's shared-fonts API (docs/desktop.md §14.3) — pass as AdminApp's `fonts` */
  fonts: FakeSharedFonts;
  /** The seed's state (tests read it) */
  state: Seed;
  /** Libraries, their settings rows and the org's fonts (tests read them) */
  resources: ResourcesState;
  /** The caller (the acting admin) */
  me: string;
}

class Fail extends Error {
  constructor(public code: "not-found" | "invalid" | "conflict" | "forbidden", message: string) {
    super(message);
  }
}

const clone = <T,>(v: T): T => structuredClone(v);

export function createFakeAdminStore(options: { now?: number; me?: string; latency?: number } = {}): FakeAdminStore {
  const now = options.now ?? Date.now();
  const s = makeSeed(now);
  const me = options.me ?? "u1";
  let seq = 0;
  const wait = <T,>(v: T): Promise<T> => (options.latency ? new Promise((r) => setTimeout(() => r(clone(v)), options.latency)) : Promise.resolve(clone(v)));
  const person = (id: string) => {
    const p = s.people.find((x) => x.id === id);
    if (!p) throw new Fail("not-found", `person ${id}`);
    return p;
  };
  const ref = (id: string): O.PersonRef => {
    const p = person(id);
    return { id: p.id, email: p.email, name: p.name, picture: p.picture, role: p.role };
  };
  const ws = (id: string) => {
    const w = s.workspaces.find((x) => x.id === id);
    if (!w) throw new Fail("not-found", `workspace ${id}`);
    return w;
  };
  const bg = (id: string) => {
    const b = s.billingGroups.find((x) => x.id === id);
    if (!b) throw new Fail("not-found", `billing group ${id}`);
    return b;
  };
  const recount = () => {
    for (const w of s.workspaces) {
      w.memberCount = s.people.filter((p) => p.workspaceId === w.id).length;
      w.teamCount = s.teams.filter((t) => t.workspaceId === w.id && t.deletedAt === null).length;
    }
    for (const b of s.billingGroups) b.memberCount = s.people.filter((p) => p.billingGroupId === b.id).length;
  };
  const log = (type: O.ActivityAction, entity: O.ActivityLog["entity"], details: Record<string, unknown> = {}, teamId: string | null = null) => {
    const a = person(me);
    s.activity.unshift({
      id: String(900_000 + ++seq), timestamp: Math.floor(Date.now() / 1000),
      actor: { type: "user", id: a.id, email: a.email, name: a.name ?? a.email },
      action: { type, details }, entity,
      context: { client_name: "DesignerV2 Desktop", ip_address: "127.0.0.1", is_figma_support_team_action: false, org_id: s.orgId, team_id: teamId },
    });
  };
  const userEntity = (p: O.AdminPerson): O.ActivityLog["entity"] => ({ type: "user", id: p.id, name: p.name ?? p.email, email: p.email });
  const page = <T,>(all: T[], cursor?: string, limit = 100): O.Page<T> => {
    const from = cursor ? Number(cursor) : 0;
    const items = all.slice(from, from + limit);
    return { items, cursor: from + limit < all.length ? String(from + limit) : null, total: all.length };
  };
  const filterPeople = (q: O.PeopleQuery = {}) => {
    const text = q.text?.trim().toLowerCase();
    return s.people.filter((p) => {
      if (text && !(p.name ?? "").toLowerCase().includes(text) && !p.email.toLowerCase().includes(text)) return false;
      if (q.role && p.role !== q.role) return false;
      if (q.seat && p.seat !== q.seat) return false;
      if (q.workspaceId && (q.workspaceId === "none" ? p.workspaceId !== null : p.workspaceId !== q.workspaceId)) return false;
      if (q.billingGroupId && (q.billingGroupId === "none" ? p.billingGroupId !== null : p.billingGroupId !== q.billingGroupId)) return false;
      if (q.activeBefore !== undefined && p.lastActiveAt !== null && p.lastActiveAt >= q.activeBefore) return false;
      return true;
    });
  };
  const filterTeams = (q: O.TeamsQuery = {}) => {
    const text = q.text?.trim().toLowerCase();
    return s.teams.filter((t) => {
      if (text && !t.name.toLowerCase().includes(text)) return false;
      if (q.workspaceId && (q.workspaceId === "none" ? t.workspaceId !== null : t.workspaceId !== q.workspaceId)) return false;
      if (!q.includeHidden && t.visibility === "hidden") return false;
      if (!q.includeDeleted && t.deletedAt !== null) return false;
      return true;
    });
  };
  const filterActivity = (q: O.ActivityQuery = {}) => {
    const rows = s.activity.filter((r) => {
      if (q.events?.length && !q.events.includes(r.action.type)) return false;
      if (q.email && r.actor?.email.toLowerCase() !== q.email.trim().toLowerCase()) return false;
      if (q.teamId && r.context.team_id !== q.teamId) return false;
      if (q.startTime !== undefined && r.timestamp < q.startTime) return false;
      if (q.endTime !== undefined && r.timestamp > q.endTime) return false;
      return true;
    });
    return q.order === "asc" ? rows.reverse() : rows;
  };
  const wsName = (id: string | null) => (id ? s.workspaces.find((w) => w.id === id)?.name ?? "" : "Unassigned");
  const bgName = (id: string | null) => (id ? s.billingGroups.find((b) => b.id === id)?.name ?? "" : "Unassigned");

  const admin: AdminRepository = {
    async dashboard() {
      const active = s.people.filter((p) => !p.pending);
      const seats = { full: 0, dev: 0, collab: 0, view: 0 } as Record<O.Seat, number>;
      for (const p of active) seats[p.seat]++;
      return wait({
        members: active.filter((p) => p.role !== "guest").length,
        guests: active.filter((p) => p.role === "guest").length,
        seats,
        pendingSeatRequests: s.seatRequests.filter((r) => r.state === "pending").length,
        pendingGuestRequests: s.guestRequests.filter((r) => r.state === "pending").length,
        teams: s.teams.filter((t) => t.deletedAt === null).length,
        workspaces: s.workspaces.length,
        activeLast30Days: active.filter((p) => p.lastActiveAt !== null && p.lastActiveAt > Date.now() - 30 * 86_400_000).length,
      });
    },
    async people(_org, q) {
      return wait(page(filterPeople(q), q?.cursor, q?.limit ?? 500));
    },
    async addPeople(_org, input) {
      const added: O.AdminPerson[] = [];
      for (const raw of input.emails) {
        const email = raw.trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Fail("invalid", `"${raw}" isn't an email address`);
        if (s.people.some((p) => p.email === email)) throw new Fail("conflict", `${email} is already in the organization`);
        const p: O.AdminPerson = { id: `n${++seq}`, email, name: null, picture: null, role: input.role, seat: input.seat ?? s.settings.defaultSeat, workspaceId: input.workspaceId ?? null, billingGroupId: input.billingGroupId ?? null, lastActiveAt: null, joinedAt: Date.now(), pending: true, teams: 0 };
        s.people.push(p);
        added.push(p);
        log("org_invite_create", userEntity(p), { role: input.role, seat: p.seat });
      }
      recount();
      return wait(added);
    },
    async updatePeople(_org, input) {
      const out: O.AdminPerson[] = [];
      for (const id of input.userIds) {
        const p = person(id);
        if (input.role && input.role !== p.role) {
          if (p.role === "admin" && s.people.filter((x) => x.role === "admin").length === 1) throw new Fail("invalid", "An organization needs at least one admin");
          log("org_user_permission_change", userEntity(p), { from: p.role, to: input.role });
          p.role = input.role;
        }
        if (input.seat && input.seat !== p.seat) {
          log(input.seat === "full" ? "org_user_account_type_change_to_full" : "org_user_account_type_change", userEntity(p), { from: p.seat, to: input.seat });
          p.seat = input.seat;
        }
        if (input.workspaceId !== undefined && input.workspaceId !== p.workspaceId) {
          if (p.workspaceId) log("workspace_member_remove", { type: "workspace", id: p.workspaceId, name: wsName(p.workspaceId) }, { user_id: p.id });
          if (input.workspaceId) log("workspace_member_add", { type: "workspace", id: input.workspaceId, name: wsName(input.workspaceId) }, { user_id: p.id });
          p.workspaceId = input.workspaceId;
        }
        if (input.billingGroupId !== undefined && input.billingGroupId !== p.billingGroupId) {
          log("license_group_membership_change", userEntity(p), { from: p.billingGroupId, to: input.billingGroupId });
          p.billingGroupId = input.billingGroupId;
        }
        out.push(p);
      }
      recount();
      return wait(out);
    },
    async removePeople(_org, ids) {
      for (const id of ids) {
        if (id === me) throw new Fail("invalid", "You can't remove yourself");
        const p = person(id);
        s.people = s.people.filter((x) => x.id !== id);
        log(p.role === "guest" ? "org_user_delete_external" : "org_user_delete", userEntity(p));
        // The fake keeps no drafts per person: each removed member leaves one, as most would
        if (p.role !== "guest" && !p.pending) {
          const at = Date.now();
          const draft: O.OrgFile = { key: `d${++seq}`, name: "Untitled", editorType: "design", ownerId: p.id, ownerName: p.name, orgId: s.orgId, teamId: null, projectId: null, updatedAt: at - 86_400_000, createdAt: at - 30 * 86_400_000, trashedAt: null, thumbnailUrl: null, access: { role: "editor", canEdit: true, canComment: true, canExport: true, canDevMode: true, canShare: true, canManage: true, capped: null, via: ["org-admin"] }, fileKey: null };
          s.unassigned.unshift({ owner: { id: p.id, email: p.email, name: p.name, removedAt: at }, files: [draft] });
        }
      }
      recount();
      return wait(undefined);
    },
    async seatRequests(_org, state = "pending") {
      return wait(s.seatRequests.filter((r) => state === "all" || r.state === "pending"));
    },
    async answerSeatRequest(_org, id, approve) {
      const r = s.seatRequests.find((x) => x.id === id);
      if (!r) throw new Fail("not-found", `seat request ${id}`);
      if (r.state !== "pending") throw new Fail("conflict", "This request was already answered");
      r.state = approve ? "approved" : "denied";
      r.answeredAt = Date.now();
      r.answeredBy = me;
      const p = s.people.find((x) => x.id === r.userId);
      if (p && approve) p.seat = r.seat;
      if (p) log(approve ? "org_user_account_type_upgrade_approved" : "org_user_account_type_upgrade_denied", userEntity(p), { seat: r.seat });
      return wait(r);
    },
    async guestRequests() {
      return wait(s.guestRequests.filter((r) => r.state === "pending"));
    },
    async answerGuestRequest(_org, id, approve) {
      const r = s.guestRequests.find((x) => x.id === id);
      if (!r) throw new Fail("not-found", `guest request ${id}`);
      r.state = approve ? "approved" : "denied";
      if (approve) {
        const p: O.AdminPerson = { id: `n${++seq}`, email: r.email, name: null, picture: null, role: "guest", seat: "view", workspaceId: null, billingGroupId: null, lastActiveAt: null, joinedAt: Date.now(), pending: true, teams: r.resource.type === "team" ? 1 : 0 };
        s.people.push(p);
        log("org_user_create_external", userEntity(p), { resource: r.resource });
      }
      return wait(r);
    },
    async teams(_org, q) {
      return wait(page(filterTeams(q), q?.cursor, q?.limit ?? 500));
    },
    async workspaces() {
      return wait(s.workspaces);
    },
    async createWorkspace(_org, input) {
      const name = input.name.trim();
      if (!name) throw new Fail("invalid", "A workspace needs a name");
      if (input.adminIds.length === 0) throw new Fail("invalid", "A workspace needs at least one workspace admin");
      if (s.workspaces.some((w) => w.name.toLowerCase() === name.toLowerCase())) throw new Fail("conflict", `A workspace named "${name}" already exists`);
      const w: O.OrgWorkspace = { id: `ws${++seq}`, name, hidden: Boolean(input.hidden), admins: input.adminIds.map(ref), defaultTeamIds: [], memberCount: 0, teamCount: 0, createdAt: Date.now() };
      s.workspaces.push(w);
      log("workspace_create", { type: "workspace", id: w.id, name });
      return wait(w);
    },
    async updateWorkspace(id, patch) {
      const w = ws(id);
      const entity = () => ({ type: "workspace" as const, id: w.id, name: w.name });
      if (patch.name !== undefined && patch.name.trim() && patch.name !== w.name) {
        w.name = patch.name.trim();
        log("workspace_rename", entity());
      }
      if (patch.hidden !== undefined && patch.hidden !== w.hidden) {
        w.hidden = patch.hidden;
        log("workspace_visibility_setting_change", entity(), { hidden: w.hidden });
      }
      if (patch.adminIds) {
        if (patch.adminIds.length === 0) throw new Fail("invalid", "A workspace needs at least one workspace admin");
        const before = new Set(w.admins.map((a) => a.id));
        for (const a of patch.adminIds) if (!before.has(a)) log("workspace_admins_add", entity(), { user_id: a });
        for (const a of before) if (!patch.adminIds.includes(a)) log("workspace_admins_remove", entity(), { user_id: a });
        w.admins = patch.adminIds.map(ref);
      }
      if (patch.defaultTeamIds) w.defaultTeamIds = [...patch.defaultTeamIds];
      for (const uid of patch.members?.add ?? []) {
        person(uid).workspaceId = w.id;
        log("workspace_member_add", entity(), { user_id: uid });
      }
      for (const uid of patch.members?.remove ?? []) {
        const p = person(uid);
        if (p.workspaceId === w.id) p.workspaceId = null;
        log("workspace_member_remove", entity(), { user_id: uid });
      }
      for (const tid of patch.teams?.add ?? []) {
        const t = s.teams.find((x) => x.id === tid);
        if (t) {
          t.workspaceId = w.id;
          log("team_workspace_change", { type: "team", id: t.id, name: t.name }, { workspace_id: w.id }, t.id);
        }
      }
      for (const tid of patch.teams?.remove ?? []) {
        const t = s.teams.find((x) => x.id === tid);
        if (t && t.workspaceId === w.id) {
          t.workspaceId = null;
          w.defaultTeamIds = w.defaultTeamIds.filter((d) => d !== tid);
          log("team_workspace_change", { type: "team", id: t.id, name: t.name }, { workspace_id: null }, t.id);
        }
      }
      recount();
      return wait(w);
    },
    async deleteWorkspace(id) {
      const w = ws(id);
      for (const p of s.people) if (p.workspaceId === id) p.workspaceId = null;
      for (const t of s.teams) if (t.workspaceId === id) t.workspaceId = null;
      s.workspaces = s.workspaces.filter((x) => x.id !== id);
      log("workspace_delete", { type: "workspace", id, name: w.name });
      return wait(undefined);
    },
    async billingGroups() {
      return wait(s.billingGroups);
    },
    async createBillingGroup(_org, input) {
      const name = input.name.trim();
      if (!name) throw new Fail("invalid", "A billing group needs a name");
      const b: O.BillingGroup = { id: `bg${++seq}`, name, admins: (input.adminIds ?? []).map(ref), memberCount: 0 };
      s.billingGroups.push(b);
      log("license_group_create", { type: "org", id: s.orgId, name: s.orgName }, { billing_group: name });
      return wait(b);
    },
    async updateBillingGroup(id, patch) {
      const b = bg(id);
      if (patch.name !== undefined && patch.name.trim() && patch.name !== b.name) {
        log("license_group_rename", { type: "org", id: s.orgId, name: s.orgName }, { from: b.name, to: patch.name });
        b.name = patch.name.trim();
      }
      if (patch.adminIds) {
        const before = new Set(b.admins.map((a) => a.id));
        for (const a of patch.adminIds) if (!before.has(a)) log("license_group_admins_add", { type: "org", id: s.orgId, name: s.orgName }, { billing_group: b.name, user_id: a });
        for (const a of before) if (!patch.adminIds.includes(a)) log("license_group_admins_remove", { type: "org", id: s.orgId, name: s.orgName }, { billing_group: b.name, user_id: a });
        b.admins = patch.adminIds.map(ref);
      }
      return wait(b);
    },
    async deleteBillingGroup(id) {
      const b = bg(id);
      // [F-bg] its members go back to Unassigned
      for (const p of s.people) if (p.billingGroupId === id) p.billingGroupId = null;
      s.billingGroups = s.billingGroups.filter((x) => x.id !== id);
      log("license_group_delete", { type: "org", id: s.orgId, name: s.orgName }, { billing_group: b.name });
      return wait(undefined);
    },
    async activity(_org, q) {
      const rows = filterActivity(q);
      const from = q?.cursor ? Number(q.cursor) : 0;
      const limit = q?.limit ?? 100;
      const next = from + limit < rows.length;
      return wait({ activity_logs: rows.slice(from, from + limit), cursor: next ? String(from + limit) : null, next_page: next });
    },
    async settings() {
      return wait(s.settings);
    },
    async updateSettings(_org, patch) {
      const org = { type: "org" as const, id: s.orgId, name: s.orgName };
      if (patch.teamCreation && patch.teamCreation !== s.settings.teamCreation) log("org_team_creation_controls", org, { to: patch.teamCreation });
      if (patch.guestMembership && patch.guestMembership !== s.settings.guestMembership) log("org_guest_invite_setting_change", org, { to: patch.guestMembership });
      if (patch.defaultSeat && patch.defaultSeat !== s.settings.defaultSeat) log("org_default_license_type_change", org, { to: patch.defaultSeat });
      if (patch.publicLinks !== undefined && patch.publicLinks !== s.settings.publicLinks) log("public_link_setting_change", org, { to: patch.publicLinks });
      s.settings = { ...s.settings, ...patch, seatApproval: { ...s.settings.seatApproval, ...patch.seatApproval } };
      return wait(s.settings);
    },
    async unassignedDrafts() {
      return wait(s.unassigned);
    },
    async moveUnassigned(_org, input) {
      const teamId = "teamId" in input.to ? input.to.teamId : null;
      const team = teamId ? s.teams.find((t) => t.id === teamId) : null;
      for (const u of s.unassigned) {
        const moving = u.files.filter((f) => (input.ownerId !== undefined && u.owner.id === input.ownerId) || input.fileKeys?.includes(f.key));
        for (const f of moving) log("fig_file_move", { type: "file", id: f.key, name: f.name, key: f.key, editor_type: f.editorType, link_access: "inherit", proto_link_access: "inherit" }, { to: input.to }, team?.id ?? null);
        u.files = u.files.filter((f) => !moving.includes(f));
      }
      s.unassigned = s.unassigned.filter((u) => u.files.length > 0);
      return wait(undefined);
    },
    async deleteUnassigned(_org, keys) {
      for (const u of s.unassigned) {
        for (const f of u.files.filter((x) => keys.includes(x.key))) log("fig_file_permanent_delete", { type: "file", id: f.key, name: f.name, key: f.key, editor_type: f.editorType, link_access: "inherit", proto_link_access: "inherit" });
        u.files = u.files.filter((f) => !keys.includes(f.key));
      }
      s.unassigned = s.unassigned.filter((u) => u.files.length > 0);
      return wait(undefined);
    },
    async exportCsv(_org, what, query) {
      const org = { type: "org" as const, id: s.orgId, name: s.orgName };
      if (what === "people") {
        log("roster_exported", org);
        const rows = filterPeople(query as O.PeopleQuery).map((p) => [p.name ?? "", p.email, userType(p), SEAT_LABEL[p.seat], wsName(p.workspaceId), bgName(p.billingGroupId), p.lastActiveAt ? new Date(p.lastActiveAt).toISOString() : "", new Date(p.joinedAt).toISOString()]);
        return toCsv(["Name", "Email", "User type", "Seat type", "Workspace", "Billing group", "Last active", "Joined"], rows);
      }
      if (what === "teams") {
        log("org_team_csv_exported", org);
        const rows = filterTeams({ includeHidden: true, ...(query as O.TeamsQuery) }).map((t) => {
          const owner = s.people.find((p) => p.id === t.ownerId);
          return [t.name, owner?.name ?? "", owner?.email ?? "", t.lastEditedAt ? new Date(t.lastEditedAt).toISOString() : "", t.projectCount, t.memberCount, teamAccess(t), wsName(t.workspaceId)];
        });
        return toCsv(["Team name", "Owner name", "Owner email", "Last active", "Folders", "Members", "Access", "Workspace"], rows);
      }
      // [F-act] the CSV covers the date range and ignores the other filters
      const q = (query ?? {}) as O.ActivityQuery;
      const rows = filterActivity({ startTime: q.startTime, endTime: q.endTime }).map((r) => [formatUtc(r.timestamp), r.actor?.name ?? "", r.actor?.email ?? "", r.action.type, ACTION_LABEL[r.action.type], r.entity.type, r.entity.name, productOf(r), s.teams.find((t) => t.id === r.context.team_id)?.name ?? "", r.context.ip_address]);
      return toCsv(["Date (UTC)", "Team member", "Email", "Event type", "Event", "Entity type", "Entity", "Product", "Team", "IP address"], rows);
    },
  };

  const group = (id: string) => {
    const g = s.groups.find((x) => x.id === id);
    if (!g) throw new Fail("not-found", `group ${id}`);
    return g;
  };
  const groupEntity = (g: O.UserGroup) => ({ type: "org" as const, id: s.orgId, name: s.orgName, group_id: g.id, group_name: g.name });
  const unsupported = (name: string) => async (): Promise<never> => {
    throw new Fail("invalid", `${name} isn't part of the Admin fake`);
  };
  const orgs: OrgsRepository = {
    list: async () => wait([{ id: s.orgId, name: s.orgName, role: person(me).role, seat: person(me).seat, workspaceId: person(me).workspaceId }]),
    get: async () => {
      const p = person(me);
      return wait({ id: s.orgId, name: s.orgName, role: p.role, seat: p.seat, workspaceId: p.workspaceId, createdAt: now - 500 * 86_400_000, workspaceAdminOf: s.workspaces.filter((w) => w.admins.some((a) => a.id === me)).map((w) => w.id), billingGroupAdminOf: s.billingGroups.filter((b) => b.admins.some((a) => a.id === me)).map((b) => b.id), counts: { members: s.people.filter((x) => x.role !== "guest").length, guests: s.people.filter((x) => x.role === "guest").length, teams: s.teams.filter((t) => t.deletedAt === null).length }, settings: s.settings });
    },
    create: unsupported("orgs.create"),
    people: async () => wait({ people: s.people.map((p) => ref(p.id)), groups: s.groups.map((g) => ({ id: g.id, name: g.name, memberCount: g.memberCount })) }),
    drafts: unsupported("orgs.drafts"),
    createDraft: unsupported("orgs.createDraft"),
    search: unsupported("orgs.search"),
    requestSeat: unsupported("orgs.requestSeat"),
    groups: async () => wait(s.groups),
    createGroup: async (_org, input) => {
      const name = input.name.trim();
      if (!name) throw new Fail("invalid", "A group needs a name");
      const members = (input.userIds ?? []).map(ref);
      const g: O.UserGroup = { id: `grp-n${++seq}`, name, description: input.description ?? "", createdBy: me, external: false, members, memberCount: members.length, canManage: true };
      s.groups.push(g);
      log("user_group_create", groupEntity(g));
      return wait(g);
    },
    updateGroup: async (id, patch) => {
      const g = group(id);
      if (patch.name !== undefined && patch.name.trim() && patch.name !== g.name) {
        g.name = patch.name.trim();
        log("user_group_rename", groupEntity(g));
      }
      if (patch.description !== undefined) g.description = patch.description;
      return wait(g);
    },
    setGroupMembers: async (id, change) => {
      const g = group(id);
      for (const uid of change.add ?? []) {
        if (g.members.some((m) => m.id === uid)) continue;
        g.members.push(ref(uid));
        log("user_group_member_add", groupEntity(g), { user_id: uid });
      }
      for (const uid of change.remove ?? []) {
        g.members = g.members.filter((m) => m.id !== uid);
        log("user_group_member_remove", groupEntity(g), { user_id: uid });
      }
      g.memberCount = g.members.length;
      return wait(g);
    },
    deleteGroup: async (id) => {
      const g = group(id);
      s.groups = s.groups.filter((x) => x.id !== id);
      log("user_group_delete", groupEntity(g));
      return wait(undefined);
    },
    leave: unsupported("orgs.leave"),
    watch: () => () => {},
  };

  const teamInfo = (t: O.AdminTeam): O.TeamInfo => {
    const { ownerName: _o, adminCount: _a, fileCount: _f, lastEditedAt: _l, ...info } = t;
    return info;
  };
  const teams: AdminTeamsApi = {
    async restore(id) {
      const t = s.teams.find((x) => x.id === id);
      if (!t) throw new Fail("not-found", `team ${id}`);
      t.deletedAt = null;
      log("team_restore", { type: "team", id: t.id, name: t.name }, {}, t.id);
      recount();
      return wait(teamInfo(t));
    },
    async remove(id) {
      const t = s.teams.find((x) => x.id === id);
      if (!t) throw new Fail("not-found", `team ${id}`);
      t.deletedAt = Date.now();
      log("team_delete", { type: "team", id: t.id, name: t.name }, {}, t.id);
      recount();
      return wait(undefined);
    },
    async update(id, patch) {
      const t = s.teams.find((x) => x.id === id);
      if (!t) throw new Fail("not-found", `team ${id}`);
      if (patch.visibility && patch.visibility !== t.visibility) log("team_sharing_audience_control_change", { type: "team", id: t.id, name: t.name }, { to: patch.visibility }, t.id);
      Object.assign(t, patch);
      recount();
      return wait(teamInfo(t));
    },
  };

  const resources = seedResources(s, now);
  const orgLibraries = fakeOrgLibraries(s, resources, me, log, wait, () => Date.now());
  const fonts = fakeSharedFonts(s, resources, me, wait, () => Date.now());
  return { admin, orgs, teams, orgLibraries, fonts, state: s, resources, me };
}
