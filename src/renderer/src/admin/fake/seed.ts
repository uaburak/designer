/**
 * The fake organization's seed (deterministic: a seeded PRNG): ~40 people with seats, three workspaces (one hidden),
 * two billing groups, teams (hidden and deleted ones too), seat and guest requests, user groups, unassigned drafts and
 * a few hundred activity rows with Figma's action names.
 */
import { DEFAULT_ORG_SETTINGS, type ActivityAction, type ActivityLog, type AdminPerson, type AdminTeam, type BillingGroup, type EditorType, type GuestRequest, type OrgFile, type OrgSettings, type OrgWorkspace, type PersonRef, type Seat, type SeatRequest, type UnassignedDrafts, type UserGroup } from "@shared/org/types";

export interface Seed {
  orgId: string;
  orgName: string;
  people: AdminPerson[];
  workspaces: OrgWorkspace[];
  billingGroups: BillingGroup[];
  teams: AdminTeam[];
  seatRequests: SeatRequest[];
  guestRequests: GuestRequest[];
  groups: UserGroup[];
  unassigned: UnassignedDrafts[];
  activity: ActivityLog[];
  settings: OrgSettings;
}

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [
  "Burak Koç", "Ayşe Demir", "Mehmet Yılmaz", "Elif Kaya", "Can Öztürk", "Zeynep Arslan", "Emre Şahin", "Selin Aydın",
  "Deniz Çelik", "Ece Yıldız", "Mert Doğan", "Ceren Kılıç", "Kaan Aslan", "Defne Çetin", "Onur Kara", "İrem Koç",
  "Barış Kurt", "Melis Özdemir", "Tolga Aksoy", "Gizem Polat", "Ali Erdem", "Naz Güneş", "Cem Tekin", "Pelin Acar",
  "Umut Bulut", "Derya Kaplan", "Serkan Ünal", "Buse Turan", "Volkan Er", "Esra Uçar", "Hakan Sezer", "Lale Bozkurt",
  "Ozan Tuna", "Sena Akın", "Kerem Işık", "Duru Ateş",
];
const GUESTS = ["Jamie Fox", "Priya Patel", "Lukas Meyer", "Sofia Rossi"];
const ascii = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i").replace(/İ/g, "I").replace(/ş/g, "s").replace(/ğ/g, "g").toLowerCase();

const DAY = 86_400_000;

export function makeSeed(now = Date.now(), orgId = "org1"): Seed {
  const rnd = prng(19);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const ago = (maxDays: number) => now - Math.floor(rnd() * maxDays * DAY);

  // People: 3 admins, members, 4 guests, 2 pending invites
  const people: AdminPerson[] = [];
  NAMES.forEach((name, i) => {
    const [first, last] = ascii(name).split(" ");
    const role = i < 3 ? "admin" : "member";
    const seat: Seat = i < 3 ? "full" : i < 14 ? "full" : i < 19 ? "dev" : i < 25 ? "collab" : "view";
    people.push({
      id: `u${i + 1}`, email: `${first}.${last}@studio.co`, name, picture: null, role, seat,
      workspaceId: i < 12 ? "ws-design" : i < 22 ? "ws-eng" : i < 26 ? "ws-research" : null,
      billingGroupId: i < 14 ? "bg-product" : i < 24 ? "bg-brand" : null,
      lastActiveAt: i === 30 ? null : i > 31 ? now - (200 + i * 6) * DAY : ago(i < 20 ? 6 : 120),
      joinedAt: now - (400 - i * 7) * DAY, pending: false, teams: 1 + (i % 4),
      // Round 14: most members use 2FA (the CSV's 2FA_enabled)
      twoFactor: i % 3 !== 2,
    });
  });
  GUESTS.forEach((name, i) => {
    const [first] = ascii(name).split(" ");
    people.push({ id: `g${i + 1}`, email: `${first}@${["agency.com", "freelance.io", "partner.de", "studio-rossi.it"][i]}`, name, picture: null, role: "guest", seat: i === 0 ? "collab" : "view", workspaceId: null, billingGroupId: null, lastActiveAt: ago(40), joinedAt: now - (60 + i * 9) * DAY, pending: false, teams: 1,
      // Round 14: one guest uses 2FA; two have an access expiration date
      twoFactor: i === 0, guestExpiresAt: i === 0 ? now + 60 * DAY : i === 2 ? now + 10 * DAY : null });
  });
  people.push({ id: "p1", email: "new.hire@studio.co", name: null, picture: null, role: "member", seat: "view", workspaceId: null, billingGroupId: null, lastActiveAt: null, joinedAt: now - 2 * DAY, pending: true, teams: 0, twoFactor: false });
  people.push({ id: "p2", email: "contractor@outside.dev", name: null, picture: null, role: "guest", seat: "view", workspaceId: null, billingGroupId: null, lastActiveAt: null, joinedAt: now - 5 * DAY, pending: true, teams: 0, twoFactor: false });
  const ref = (id: string): PersonRef => {
    const p = people.find((x) => x.id === id)!;
    return { id: p.id, email: p.email, name: p.name, picture: p.picture, role: p.role };
  };

  const teams: AdminTeam[] = [];
  const team = (id: string, name: string, workspaceId: string | null, ownerId: string, extra: Partial<AdminTeam> = {}) => {
    const owner = people.find((p) => p.id === ownerId)!;
    teams.push({
      id, name, icon: null, workspaceId, visibility: "visible", orgAccess: "none", workspaceAccess: workspaceId ? "viewer" : "none",
      me: null, memberCount: 3 + Math.floor(rnd() * 20), projectCount: 1 + Math.floor(rnd() * 9), description: "",
      ownerId, createdAt: now - Math.floor(100 + rnd() * 500) * DAY, deletedAt: null, ownerName: owner.name,
      adminCount: 1 + Math.floor(rnd() * 3), fileCount: 4 + Math.floor(rnd() * 80), lastEditedAt: ago(50), ...extra,
    });
  };
  team("t1", "Design System", "ws-design", "u1", { orgAccess: "viewer" });
  team("t2", "Mobile App", "ws-design", "u4");
  team("t3", "Web Platform", "ws-eng", "u13");
  team("t4", "Marketing Site", "ws-design", "u5", { orgAccess: "editor" });
  team("t5", "Brand", null, "u2", { orgAccess: "viewer" });
  team("t6", "Data Platform", "ws-eng", "u15");
  team("t7", "User Research", "ws-research", "u23");
  team("t8", "Exec Reviews", null, "u1", { visibility: "hidden" });
  team("t9", "Acquisition Project", "ws-eng", "u14", { visibility: "hidden" });
  team("t10", "Onboarding", "ws-design", "u6");
  team("t11", "Holiday Campaign 2025", null, "u7", { deletedAt: now - 9 * DAY });
  team("t12", "Old Prototypes", "ws-eng", "u16", { deletedAt: now - 20 * DAY });
  team("t13", "Illustrations", null, "u8");

  const wsMembers = (ws: string) => people.filter((p) => p.workspaceId === ws).length;
  const wsTeams = (ws: string) => teams.filter((t) => t.workspaceId === ws && t.deletedAt === null).length;
  const workspaces: OrgWorkspace[] = [
    { id: "ws-design", name: "Design", hidden: false, admins: [ref("u1"), ref("u4")], defaultTeamIds: ["t1", "t10"], memberCount: wsMembers("ws-design"), teamCount: wsTeams("ws-design"), createdAt: now - 300 * DAY },
    { id: "ws-eng", name: "Engineering", hidden: false, admins: [ref("u13")], defaultTeamIds: ["t3"], memberCount: wsMembers("ws-eng"), teamCount: wsTeams("ws-eng"), createdAt: now - 280 * DAY },
    { id: "ws-research", name: "Research", hidden: true, admins: [ref("u23")], defaultTeamIds: [], memberCount: wsMembers("ws-research"), teamCount: wsTeams("ws-research"), createdAt: now - 90 * DAY },
  ];
  const billingGroups: BillingGroup[] = [
    { id: "bg-product", name: "Product", admins: [ref("u1")], memberCount: people.filter((p) => p.billingGroupId === "bg-product").length },
    { id: "bg-brand", name: "Brand & Marketing", admins: [ref("u2"), ref("u5")], memberCount: people.filter((p) => p.billingGroupId === "bg-brand").length },
  ];

  const notes = ["I need to edit the design system components.", "Handing off specs to engineering.", "Working on the onboarding flow.", "", "Need Dev Mode for the sprint."];
  const seatRequests: SeatRequest[] = [
    ...["u26", "u27", "u20", "u29", "g2"].map((uid, i): SeatRequest => ({ id: `sr${i + 1}`, orgId, userId: uid, person: ref(uid), seat: (["full", "full", "full", "dev", "collab"] as const)[i], note: notes[i], state: "pending", createdAt: now - (i + 1) * 7_200_000, answeredAt: null, answeredBy: null })),
    { id: "sr6", orgId, userId: "u21", person: ref("u21"), seat: "dev", note: "", state: "approved", createdAt: now - 12 * DAY, answeredAt: now - 11 * DAY, answeredBy: "u1" },
    { id: "sr7", orgId, userId: "u28", person: ref("u28"), seat: "full", note: "For the redesign.", state: "denied", createdAt: now - 20 * DAY, answeredAt: now - 19 * DAY, answeredBy: "u2" },
  ];
  const guestRequests: GuestRequest[] = [
    { id: "gr1", email: "alex@partner-agency.com", invitedBy: ref("u5"), resource: { type: "file", id: "f-hero", name: "Homepage hero" }, role: "editor", state: "pending", createdAt: now - 3_600_000 },
    { id: "gr2", email: "m.chen@freelance.io", invitedBy: ref("u4"), resource: { type: "team", id: "t2", name: "Mobile App" }, role: "viewer", state: "pending", createdAt: now - DAY },
    { id: "gr3", email: "review@legal-firm.com", invitedBy: ref("u2"), resource: { type: "project", id: "pr-brand", name: "Brand guidelines" }, role: "viewer", state: "pending", createdAt: now - 3 * DAY },
  ];

  const groups: UserGroup[] = [
    { id: "grp1", name: "Designers", description: "Everyone who designs product UI", createdBy: "u1", external: false, members: ["u1", "u4", "u5", "u6", "u7", "u8", "u9"].map(ref), memberCount: 7, canManage: true },
    { id: "grp2", name: "Engineering leads", description: "", createdBy: "u13", external: false, members: ["u13", "u14", "u15"].map(ref), memberCount: 3, canManage: true },
    { id: "grp3", name: "Brand reviewers", description: "Approve brand changes", createdBy: "u2", external: false, members: ["u2", "u5", "u24"].map(ref), memberCount: 3, canManage: true },
    { id: "grp4", name: "Research panel", description: "", createdBy: "u23", external: false, members: ["u23", "u24", "u25", "g1"].map(ref), memberCount: 4, canManage: true },
  ];

  const file = (key: string, name: string, ownerId: string, ownerName: string, editorType: EditorType, trashed = false): OrgFile => ({
    key, name, editorType, ownerId, ownerName, orgId, teamId: null, projectId: null, updatedAt: ago(200), createdAt: now - 300 * DAY, trashedAt: trashed ? now - 30 * DAY : null, thumbnailUrl: null,
    access: { role: "editor", canEdit: true, canComment: true, canExport: true, canDevMode: true, canShare: true, canManage: true, capped: null, prototypeOnly: false, via: ["org-admin"] }, fileKey: null,
  });
  const unassigned: UnassignedDrafts[] = [
    { owner: { id: "x1", email: "oguz.yalcin@studio.co", name: "Oğuz Yalçın", removedAt: now - 14 * DAY }, files: [file("ud1", "Checkout explorations", "x1", "Oğuz Yalçın", "design"), file("ud2", "Sprint retro board", "x1", "Oğuz Yalçın", "figjam"), file("ud3", "Pricing page v2", "x1", "Oğuz Yalçın", "design"), file("ud4", "Old icon sketches", "x1", "Oğuz Yalçın", "design", true)] },
    { owner: { id: "x2", email: "nil.basar@studio.co", name: "Nil Başar", removedAt: now - 45 * DAY }, files: [file("ud5", "Quarterly review deck", "x2", "Nil Başar", "slides"), file("ud6", "Moodboard", "x2", "Nil Başar", "figjam")] },
  ];

  // Activity: a few hundred rows over the last 60 days, newest first
  const live = teams.filter((t) => t.deletedAt === null);
  const fileNames = ["Homepage hero", "Checkout flow", "Design tokens", "Onboarding v3", "Icon set", "Settings redesign", "Pricing page", "Mobile nav", "Dashboard charts", "Email templates"];
  const weighted: ActivityAction[] = [
    ...Array<ActivityAction>(8).fill("fig_file_view"), ...Array<ActivityAction>(4).fill("user_sign_in"), "fig_file_create", "fig_file_create", "fig_file_rename", "fig_file_export", "fig_file_export",
    "fig_file_move", "fig_file_trash", "fig_file_restore", "fig_file_member_add", "fig_file_member_permission_change", "fig_file_link_access_change", "fig_file_set_password", "fig_file_view_prototype",
    "fig_file_view_external", "fig_file_duplicate", "project_create", "project_rename", "project_member_add", "team_member_add", "team_member_permission_change", "team_create", "team_rename",
    "org_user_create", "org_user_account_type_change", "org_user_account_type_upgrade_requested", "org_user_account_type_upgrade_approved", "workspace_member_add", "license_group_membership_change",
    "user_sign_out", "user_group_member_add", "branch_create", "repo_merge_to_source", "org_invite_create", "personal_access_token_create",
  ];
  const ips = ["88.247.12.4", "78.180.33.21", "176.88.4.150", "212.156.70.8", "95.70.140.3"];
  const activity: ActivityLog[] = [];
  const N = 320;
  for (let i = 0; i < N; i++) {
    const action = pick(weighted);
    const actorP = pick(people.filter((p) => !p.pending));
    const t = pick(live);
    let entity: ActivityLog["entity"];
    if (action.startsWith("fig_file") || action.startsWith("branch") || action.startsWith("repo")) {
      const name = pick(fileNames);
      entity = action.startsWith("fig_file") ? { type: "file", id: `k${Math.floor(rnd() * 1e6)}`, name, key: `k${i}`, editor_type: rnd() < 0.8 ? "design" : "figjam", link_access: "org_view", proto_link_access: "org_view" } : { type: "file_repo", id: `r${i}`, name, main_file_key: `k${i}` };
    } else if (action.startsWith("project")) entity = { type: "project", id: `pr${i}`, name: pick(["Sprint 42", "Explorations", "Handoff", "Archive", "Q4 launches"]) };
    else if (action.startsWith("team")) entity = { type: "team", id: t.id, name: t.name };
    else if (action.startsWith("workspace")) entity = { type: "workspace", id: "ws-design", name: "Design" };
    else if (action.startsWith("org_invite") || action.startsWith("license")) entity = { type: "org", id: orgId, name: "Studio" };
    else {
      const target = pick(people);
      entity = { type: "user", id: target.id, name: target.name ?? target.email, email: target.email };
    }
    const at = now - Math.floor((i / N) * 60 * DAY) - Math.floor(rnd() * 3_000_000);
    activity.push({
      id: String(100_000 + N - i), timestamp: Math.floor(at / 1000),
      actor: { type: "user", id: actorP.id, email: actorP.email, name: actorP.name ?? actorP.email },
      action: { type: action, details: {} }, entity,
      context: { client_name: rnd() < 0.7 ? "Designer Desktop" : "Chrome", ip_address: pick(ips), is_figma_support_team_action: false, org_id: orgId, team_id: entity.type === "file" || entity.type === "project" || entity.type === "team" ? t.id : null },
    });
  }

  return { orgId, orgName: "Studio", people, workspaces, billingGroups, teams, seatRequests, guestRequests, groups, unassigned, activity, settings: structuredClone(DEFAULT_ORG_SETTINGS) };
}
