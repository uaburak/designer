import { describe, expect, it } from "vitest";
import { resolveAccess, resolveContainer, seatCanEdit, type AccessRows, type Grant } from "./access";
import type { FilePolicy } from "./identity";

const ME = { id: "u_me", email: "me@x.co" };
const NOW = Date.UTC(2026, 9, 11);
const user = (role: "editor" | "viewer", extra: Partial<Grant> = {}): Grant => ({ userId: ME.id, email: ME.email, groupId: null, role, ...extra });

function rows(over: Partial<AccessRows> = {}, file: Partial<AccessRows["file"]> = {}): AccessRows {
  return {
    user: ME,
    file: { key: "k", ownerId: "u_owner", orgId: "o1", teamId: "t1", projectId: "p1", editorType: "design", access: "inherited", linkAccess: "none", orgLinkAccess: "none", linkExpiresAt: null, viewersCanCopy: true, passwordProtected: false, trashedAt: null, ...file },
    fileGrants: [],
    folders: [{ id: "p1", ownerId: "u_owner", access: "inherited", grants: [] }],
    team: { id: "t1", ownerId: "u_owner", workspaceId: null, orgAccess: "none", workspaceAccess: "none", visibility: "visible", deletedAt: null, grants: [] },
    membership: { role: "member", seat: "full", workspaceId: null },
    workspaceAdminOf: [],
    userGroups: [],
    viaLink: false,
    passOk: false,
    externalRestricted: false,
    now: NOW,
    ...over,
  };
}

const ok = (r: ReturnType<typeof resolveAccess>) => {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
};

describe("resolveAccess (docs/multiplayer.md §14.4, the 22 cases)", () => {
  it("1: a file with no org, the caller its owner → owner (legacy)", () => {
    const r = ok(resolveAccess(rows({ membership: null, folders: [], team: null }, { orgId: null, teamId: null, projectId: null, ownerId: ME.id })));
    expect(r).toMatchObject({ role: "owner", roomRole: "owner", canEdit: true, canManage: true, via: ["file"] });
  });

  it("2: an org file, no row anywhere, team audience none → none (404)", () => {
    expect(resolveAccess(rows())).toEqual({ ok: false, reason: "none", role: null });
  });

  it("3: team member can view, file in a top-level Inherited folder → viewer via team", () => {
    const r = ok(resolveAccess(rows({ team: { ...rows().team!, grants: [user("viewer")] } })));
    expect(r).toMatchObject({ role: "viewer", canEdit: false, via: ["team"] });
  });

  it("3b: a team member taken off one file (excluded): no access through the team, folder or audience; a direct invite or admin still counts", () => {
    const team = { ...rows().team!, grants: [user("editor")], orgAccess: "viewer" as const };
    expect(ok(resolveAccess(rows({ team }))).role).toBe("editor");
    expect(resolveAccess(rows({ team, excluded: true, folders: [{ id: "p1", ownerId: "x", access: "inherited", grants: [user("editor")] }] }))).toEqual({ ok: false, reason: "none", role: null });
    expect(ok(resolveAccess(rows({ team, excluded: true, fileGrants: [user("viewer")] }))).role).toBe("viewer");
    expect(ok(resolveAccess(rows({ team, excluded: true, membership: { role: "admin", seat: "full", workspaceId: null } }))).role).toBe("editor");
  });

  it("4: team can view, folder grant can edit → editor via folder", () => {
    const r = ok(resolveAccess(rows({ team: { ...rows().team!, grants: [user("viewer")] }, folders: [{ id: "p1", ownerId: "x", access: "inherited", grants: [user("editor")] }] })));
    expect(r.role).toBe("editor");
    expect(r.via).toContain("folder");
  });

  it("5: team can edit, file grant can view → editor (a child can't reduce)", () => {
    const r = ok(resolveAccess(rows({ team: { ...rows().team!, grants: [user("editor")] }, fileGrants: [user("viewer")] })));
    expect(r.role).toBe("editor");
    expect(r.canEdit).toBe(true);
  });

  it("6: team org access can edit, a member with no rows → editor via audience", () => {
    const r = ok(resolveAccess(rows({ team: { ...rows().team!, orgAccess: "editor" } })));
    expect(r).toMatchObject({ role: "editor", via: ["audience"] });
  });

  it("7: the same, but the folder is Limited → none", () => {
    expect(resolveAccess(rows({ team: { ...rows().team!, orgAccess: "editor" }, folders: [{ id: "p1", ownerId: "x", access: "limited", grants: [] }] })).ok).toBe(false);
  });

  it("8: the same as 6 but the caller is a guest → none", () => {
    expect(resolveAccess(rows({ team: { ...rows().team!, orgAccess: "editor" }, membership: { role: "guest", seat: "full", workspaceId: null } })).ok).toBe(false);
  });

  it("9: a guest with a file grant can edit, Full seat → editor", () => {
    const r = ok(resolveAccess(rows({ fileGrants: [user("editor")], membership: { role: "guest", seat: "full", workspaceId: null } })));
    expect(r).toMatchObject({ role: "editor", canEdit: true, via: ["file"] });
  });

  it("10: a member with team can edit, Collab seat, design file → capped by the seat", () => {
    const r = ok(resolveAccess(rows({ team: { ...rows().team!, grants: [user("editor")] }, membership: { role: "member", seat: "collab", workspaceId: null } })));
    expect(r).toMatchObject({ role: "editor", canEdit: false, capped: "seat", roomRole: "viewer", canDevMode: false });
  });

  it("11: the same member, a FigJam file → editor", () => {
    const r = ok(resolveAccess(rows({ team: { ...rows().team!, grants: [user("editor")] }, membership: { role: "member", seat: "collab", workspaceId: null } }, { editorType: "figjam" })));
    expect(r).toMatchObject({ role: "editor", canEdit: true, capped: null, roomRole: "editor" });
  });

  it("12: an org admin with no rows, a team file → editor via org-admin", () => {
    const r = ok(resolveAccess(rows({ membership: { role: "admin", seat: "full", workspaceId: null } })));
    expect(r).toMatchObject({ role: "editor", via: ["org-admin"], canManage: true });
  });

  it("13: an org admin, another member's draft → none; once the owner is removed → editor", () => {
    const draft = { projectId: null, teamId: null };
    const admin = { membership: { role: "admin" as const, seat: "full" as const, workspaceId: null }, folders: [], team: null };
    expect(resolveAccess(rows(admin, draft)).ok).toBe(false);
    expect(ok(resolveAccess(rows({ ...admin, ownerInOrg: false }, draft))).role).toBe("editor");
  });

  it("14: a workspace admin, a Hidden team of their workspace → nothing from admin; rows still apply", () => {
    const team = { ...rows().team!, workspaceId: "w1", visibility: "hidden" as const };
    expect(resolveAccess(rows({ team, workspaceAdminOf: ["w1"] })).ok).toBe(false);
    expect(ok(resolveAccess(rows({ team: { ...team, visibility: "visible" }, workspaceAdminOf: ["w1"] }))).via).toEqual(["workspace-admin"]);
    expect(ok(resolveAccess(rows({ team: { ...team, grants: [user("viewer")] }, workspaceAdminOf: ["w1"] }))).role).toBe("viewer");
  });

  it("15: the team owner with no grant row → editor via team", () => {
    const r = ok(resolveAccess(rows({ team: { ...rows().team!, ownerId: ME.id } })));
    expect(r).toMatchObject({ role: "editor", via: ["team"], canManage: true });
  });

  it("16: user group granted can edit on a folder, the caller in it → editor via folder", () => {
    const g: Grant = { userId: null, email: null, groupId: "g1", role: "editor" };
    const r = ok(resolveAccess(rows({ userGroups: ["g1"], folders: [{ id: "p1", ownerId: "x", access: "inherited", grants: [g] }] })));
    expect(r).toMatchObject({ role: "editor", via: ["folder"] });
    expect(resolveAccess(rows({ userGroups: [], folders: [{ id: "p1", ownerId: "x", access: "inherited", grants: [g] }] })).ok).toBe(false);
  });

  it("17: a member opens by link, org link can view, file Limited → viewer", () => {
    const r = ok(resolveAccess(rows({ viaLink: true }, { access: "limited", orgLinkAccess: "viewer" })));
    expect(r).toMatchObject({ role: "viewer", via: ["audience"] });
    expect(resolveAccess(rows({ viaLink: false }, { access: "limited", orgLinkAccess: "viewer" })).ok).toBe(false);
  });

  it("18: an outsider, link can view, password set, no pass → password required", () => {
    const outsider = { membership: null };
    expect(resolveAccess(rows({ ...outsider, viaLink: true }, { linkAccess: "viewer", passwordProtected: true }))).toEqual({ ok: false, reason: "password_required", role: "viewer" });
    expect(ok(resolveAccess(rows({ ...outsider, viaLink: true, passOk: true }, { linkAccess: "viewer", passwordProtected: true }))).via).toEqual(["link"]);
    // legacy, the same
    expect(resolveAccess(rows({ ...outsider }, { orgId: null, linkAccess: "viewer", passwordProtected: true })).ok).toBe(false);
  });

  it("19: the link expired, the caller in only by link → none (gone)", () => {
    expect(resolveAccess(rows({ membership: null, viaLink: true }, { linkAccess: "viewer", linkExpiresAt: NOW - 1 }))).toEqual({ ok: false, reason: "gone", role: null });
    expect(ok(resolveAccess(rows({ membership: null, viaLink: true }, { linkAccess: "viewer", linkExpiresAt: NOW + 1 }))).role).toBe("viewer");
    // someone with a row of their own keeps it
    expect(ok(resolveAccess(rows({ viaLink: true, fileGrants: [user("viewer")] }, { linkAccess: "editor", linkExpiresAt: NOW - 1 }))).role).toBe("viewer");
  });

  it("20: a soft-deleted team → only admins see it; rows from the team ignored", () => {
    const team = { ...rows().team!, deletedAt: NOW - 5, grants: [user("editor")] };
    expect(resolveAccess(rows({ team })).ok).toBe(false);
    expect(resolveAccess(rows({ team, fileGrants: [user("editor")] })).ok).toBe(false);
    expect(ok(resolveAccess(rows({ team, membership: { role: "admin", seat: "full", workspaceId: null } }))).via).toEqual(["org-admin"]);
  });

  it("21: the owner of an org file on a View seat → owner, can't edit, can manage", () => {
    const r = ok(resolveAccess(rows({ membership: { role: "member", seat: "view", workspaceId: null } }, { ownerId: ME.id })));
    expect(r).toMatchObject({ role: "owner", canEdit: false, canManage: true, roomRole: "viewer", capped: "seat" });
  });

  it("22: external content restricted, a grant can edit on another org's file → viewer, no comments", () => {
    const r = ok(resolveAccess(rows({ membership: null, externalRestricted: true, fileGrants: [user("editor")] })));
    expect(r).toMatchObject({ role: "editor", roomRole: "viewer", canEdit: false, canComment: false, capped: "external" });
  });
});

describe("resolveAccess, round 4's policies (docs/multiplayer.md §15.9, cases 23–30)", () => {
  const policy = (over: Partial<FilePolicy> = {}): FilePolicy => ({ publicLinks: true, passwordRequired: false, passwordMode: "any", linkExpiryMaxHours: null, cursorChat: true, audio: true, openSessions: true, ...over });
  const outsider = { membership: null, viaLink: true };

  it("23: public links off, an outsider by the link → none", () => {
    expect(ok(resolveAccess(rows({ ...outsider, policy: policy() }, { linkAccess: "editor" }))).role).toBe("editor");
    expect(resolveAccess(rows({ ...outsider, policy: policy({ publicLinks: false }) }, { linkAccess: "editor" }))).toEqual({ ok: false, reason: "none", role: null });
  });

  it("24: public links off, a member by the org link → viewer (the org link keeps working)", () => {
    const r = ok(resolveAccess(rows({ viaLink: true, policy: policy({ publicLinks: false }) }, { linkAccess: "editor", orgLinkAccess: "viewer", access: "limited" })));
    expect(r).toMatchObject({ role: "viewer", via: ["audience"] });
  });

  it("25: passwords required, a link without a password → none for link-only people, unchanged for invited ones", () => {
    const p = policy({ passwordRequired: true });
    expect(resolveAccess(rows({ ...outsider, policy: p }, { linkAccess: "viewer" })).ok).toBe(false);
    expect(ok(resolveAccess(rows({ ...outsider, policy: p, fileGrants: [user("editor")] }, { linkAccess: "viewer" }))).role).toBe("editor");
    // with a password set (and the pass), the link works
    expect(ok(resolveAccess(rows({ ...outsider, policy: p, passOk: true }, { linkAccess: "viewer", passwordProtected: true }))).via).toEqual(["link"]);
  });

  it("26: a restricted member, a legacy file shared can edit → viewer, no comments", () => {
    const r = ok(resolveAccess(rows({ membership: null, folders: [], team: null, externalRestricted: true, homeOrgId: "home", fileGrants: [user("editor")] }, { orgId: null, teamId: null, projectId: null })));
    expect(r).toMatchObject({ role: "editor", roomRole: "viewer", canEdit: false, canComment: false, capped: "external", canShare: false });
  });

  it("27: a restricted member, their own legacy file → owner but view-only (capped: external)", () => {
    const r = ok(resolveAccess(rows({ membership: null, folders: [], team: null, externalRestricted: true, homeOrgId: "home" }, { orgId: null, teamId: null, projectId: null, ownerId: ME.id })));
    expect(r).toMatchObject({ role: "owner", roomRole: "viewer", canEdit: false, capped: "external" });
  });

  it("28: a restricted member, a file in their home org → unchanged", () => {
    const r = ok(resolveAccess(rows({ externalRestricted: true, homeOrgId: "o1", team: { ...rows().team!, grants: [user("editor")] } })));
    expect(r).toMatchObject({ role: "editor", canEdit: true, canComment: true, capped: null });
  });

  it("29: restricted, a file in another org by its public password link with the pass → viewer", () => {
    const r = ok(resolveAccess(rows({ ...outsider, passOk: true, externalRestricted: true, homeOrgId: "home", policy: policy() }, { linkAccess: "editor", passwordProtected: true })));
    expect(r).toMatchObject({ role: "editor", roomRole: "viewer", canEdit: false, capped: "external", via: ["link"] });
  });

  it("30: not captured (capture off: no home org, not restricted) → no cap", () => {
    const r = ok(resolveAccess(rows({ membership: null, externalRestricted: false, homeOrgId: null, fileGrants: [user("editor")] })));
    expect(r).toMatchObject({ role: "editor", canEdit: true, capped: null });
    const legacy = ok(resolveAccess(rows({ membership: null, folders: [], team: null, externalRestricted: false, homeOrgId: null }, { orgId: null, teamId: null, projectId: null, ownerId: ME.id })));
    expect(legacy).toMatchObject({ role: "owner", canEdit: true, capped: null });
  });
});

describe("resolveAccess, around the cases", () => {
  it("a trashed file: owner and editors read-only, viewers none", () => {
    const owner = ok(resolveAccess(rows({}, { ownerId: ME.id, trashedAt: NOW })));
    expect(owner).toMatchObject({ role: "owner", canEdit: false, trashed: true, roomRole: "viewer" });
    expect(resolveAccess(rows({ fileGrants: [user("viewer")] }, { trashedAt: NOW })).ok).toBe(false);
  });

  it("someone removed from the org no longer owns their draft", () => {
    expect(resolveAccess(rows({ membership: null, folders: [], team: null }, { ownerId: ME.id, projectId: null, teamId: null })).ok).toBe(false);
  });

  it("workspace audience reaches the workspace's members only", () => {
    const team = { ...rows().team!, workspaceId: "w1", workspaceAccess: "viewer" as const };
    expect(ok(resolveAccess(rows({ team, membership: { role: "member", seat: "view", workspaceId: "w1" } }))).role).toBe("viewer");
    expect(resolveAccess(rows({ team, membership: { role: "member", seat: "view", workspaceId: "w2" } })).ok).toBe(false);
  });

  it("viewers can't export when viewers_can_copy is off; Dev Mode follows the seat", () => {
    const r = ok(resolveAccess(rows({ fileGrants: [user("viewer")], membership: { role: "member", seat: "dev", workspaceId: null } }, { viewersCanCopy: false })));
    expect(r).toMatchObject({ canExport: false, canDevMode: true });
  });

  it("legacy: the link works without naming it (as today), members need no password", () => {
    const legacy = { membership: null, folders: [], team: null };
    expect(ok(resolveAccess(rows(legacy, { orgId: null, linkAccess: "editor" }))).role).toBe("editor");
    expect(ok(resolveAccess(rows({ ...legacy, fileGrants: [user("viewer")] }, { orgId: null, linkAccess: "editor", passwordProtected: true }))).role).toBe("editor");
    expect(resolveAccess(rows({ ...legacy, user: null }, { orgId: null, linkAccess: "editor" })).ok).toBe(false);
  });

  it("containers resolve as an Inherited file inside them", () => {
    const base = rows({ team: { ...rows().team!, orgAccess: "viewer" } });
    expect(ok(resolveContainer({ ...base, orgId: "o1", teamId: "t1", projectId: "p1" })).role).toBe("viewer");
    expect(resolveContainer({ ...base, folders: [{ id: "p1", ownerId: "x", access: "limited", grants: [] }], orgId: "o1", teamId: "t1", projectId: "p1" }).ok).toBe(false);
  });

  it("seats", () => {
    expect([seatCanEdit("dev", "design"), seatCanEdit("dev", "figjam"), seatCanEdit("collab", "slides"), seatCanEdit("collab", "sites"), seatCanEdit("view", "figjam")]).toEqual([false, true, true, false, false]);
  });
});

describe("resolveAccess: the prototype level (docs/editor.md D-6, round 5)", () => {
  const proto = { canEdit: false, canDevMode: false, canShare: false, canManage: false, prototypeOnly: true, roomRole: "viewer", role: "viewer" };

  it("an invitation from Share prototype: prototype-only, no link or password needed", () => {
    const r = ok(resolveAccess(rows({ prototypeMember: true, membership: null }, { passwordProtected: true })));
    expect(r).toMatchObject({ ...proto, via: ["file"], canComment: true });
  });

  it("anything above wins: a viewer of the file stays a full viewer", () => {
    const r = ok(resolveAccess(rows({ prototypeMember: true, fileGrants: [user("viewer")] })));
    expect(r).toMatchObject({ role: "viewer", prototypeOnly: false, canDevMode: true });
  });

  it("the prototype link for anyone: by the link in orgs, the policy, expiry and password apply", () => {
    const f = { protoLinkAccess: "viewer" as const };
    expect(resolveAccess(rows({ membership: null }, f)).ok).toBe(false); // not by the link
    expect(ok(resolveAccess(rows({ membership: null, viaLink: true }, f)))).toMatchObject({ ...proto, via: ["link"] });
    expect(resolveAccess(rows({ membership: null, viaLink: true, policy: { publicLinks: false } as FilePolicy }, f)).ok).toBe(false);
    expect(resolveAccess(rows({ membership: null, viaLink: true }, { ...f, linkExpiresAt: NOW - 1 }))).toEqual({ ok: false, reason: "gone", role: null });
    expect(resolveAccess(rows({ membership: null, viaLink: true }, { ...f, passwordProtected: true }))).toMatchObject({ ok: false, reason: "password_required" });
    expect(ok(resolveAccess(rows({ membership: null, viaLink: true, passOk: true }, { ...f, passwordProtected: true }))).prototypeOnly).toBe(true);
    expect(resolveAccess(rows({ membership: null, viaLink: true, user: null }, f)).ok).toBe(false);
  });

  it("legacy files: the prototype link works without naming it, as the file link", () => {
    const r = ok(resolveAccess(rows({ membership: null, folders: [], team: null }, { orgId: null, teamId: null, projectId: null, protoLinkAccess: "viewer" })));
    expect(r).toMatchObject({ ...proto, via: ["link"] });
  });

  it("the org's prototype link: members by the link, not guests", () => {
    const f = { protoOrgLinkAccess: "viewer" as const };
    expect(ok(resolveAccess(rows({ viaLink: true }, f)))).toMatchObject({ ...proto, via: ["audience"] });
    expect(resolveAccess(rows({ viaLink: false }, f)).ok).toBe(false);
    expect(resolveAccess(rows({ viaLink: true, membership: { role: "guest", seat: "view", workspaceId: null } }, f)).ok).toBe(false);
    expect(resolveAccess(rows({ viaLink: true, membership: null }, f)).ok).toBe(false);
  });

  it("a trashed file or a deleted team: no prototype either; export follows viewers_can_copy; the external cap", () => {
    expect(resolveAccess(rows({ prototypeMember: true }, { trashedAt: NOW })).ok).toBe(false);
    expect(resolveAccess(rows({ prototypeMember: true, team: { ...rows().team!, deletedAt: NOW } })).ok).toBe(false);
    expect(ok(resolveAccess(rows({ prototypeMember: true }, { viewersCanCopy: false }))).canExport).toBe(false);
    expect(ok(resolveAccess(rows({ prototypeMember: true, externalRestricted: true, homeOrgId: "o2" })))).toMatchObject({ capped: "external", canComment: false });
  });
});

describe("File exporting (docs/governance.md §2.7, round 14)", () => {
  const pol = (fileExporting: "all" | "guests_blocked" | "viewers_blocked") => ({ publicLinks: true, passwordRequired: false, fileExporting }) as FilePolicy;
  const viewer = { team: { ...rows().team!, grants: [user("viewer")] } };
  const guest = { role: "guest" as const, seat: "view" as const, workspaceId: null };

  it("all (and no policy, and Governance+ off): viewers export as viewers_can_copy says", () => {
    expect(ok(resolveAccess(rows({ ...viewer, policy: pol("all") }))).canExport).toBe(true);
    expect(ok(resolveAccess(rows({ ...viewer, policy: { publicLinks: true } as FilePolicy }))).canExport).toBe(true);
    expect(ok(resolveAccess(rows({ ...viewer, policy: pol("all") }, { viewersCanCopy: false }))).canExport).toBe(false);
  });

  it("guests_blocked: members and admins export, guests and link visitors from outside the org don't", () => {
    expect(ok(resolveAccess(rows({ ...viewer, policy: pol("guests_blocked") }))).canExport).toBe(true);
    expect(ok(resolveAccess(rows({ ...viewer, membership: { role: "admin", seat: "full", workspaceId: null }, policy: pol("guests_blocked") }))).canExport).toBe(true);
    expect(ok(resolveAccess(rows({ fileGrants: [user("viewer")], membership: { ...guest }, policy: pol("guests_blocked") }))).canExport).toBe(false);
    expect(ok(resolveAccess(rows({ membership: null, viaLink: true, policy: pol("guests_blocked") }, { linkAccess: "viewer" }))).canExport).toBe(false);
    expect(ok(resolveAccess(rows({ membership: null, viaLink: true, policy: pol("all") }, { linkAccess: "viewer" }))).canExport).toBe(true);
  });

  it("viewers_blocked: no viewer exports; editors always do (a guest editor too)", () => {
    expect(ok(resolveAccess(rows({ ...viewer, policy: pol("viewers_blocked") }))).canExport).toBe(false);
    expect(ok(resolveAccess(rows({ fileGrants: [user("editor")], membership: { ...guest, seat: "full" }, policy: pol("viewers_blocked") }))).canExport).toBe(true);
    expect(ok(resolveAccess(rows({ team: { ...rows().team!, grants: [user("editor")] }, policy: pol("viewers_blocked") }, { viewersCanCopy: false }))).canExport).toBe(true);
  });

  it("the prototype level follows it too", () => {
    expect(ok(resolveAccess(rows({ prototypeMember: true, membership: null, policy: pol("guests_blocked") }))).canExport).toBe(false);
    expect(ok(resolveAccess(rows({ prototypeMember: true, policy: pol("guests_blocked") }))).canExport).toBe(true);
  });

  it("an expired guest has no membership (the server leaves the row out): they count as outside the org", () => {
    const r = ok(resolveAccess(rows({ fileGrants: [user("viewer")], membership: null, policy: pol("guests_blocked") })));
    expect(r).toMatchObject({ role: "viewer", canExport: false });
    // …and lose what only membership gave (the team's org audience)
    expect(resolveAccess(rows({ team: { ...rows().team!, orgAccess: "viewer" }, membership: null })).ok).toBe(false);
  });
});
