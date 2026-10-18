/**
 * What a workspace admin (not an org admin) may change of their workspace (docs/multiplayer.md §15.19's leftover,
 * 2026-10-18): its name and default teams, people no workspace has in and out — never someone from another workspace.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { T2, W1, world, type World } from "../testing/orgWorld";

let w: World;
beforeEach(async () => {
  w = await world();
});

const patch = (token: string, id: string, body: unknown) => w.call("PATCH", `/orgs/${w.orgId}/admin/workspaces/${id}`, token, body);
const workspaceOf = async (userId: string) => (await w.rows(`SELECT workspace_id FROM org_members WHERE org_id = ?1 AND user_id = ?2`, w.orgId, userId))[0].workspace_id;

describe("a workspace admin's own workspace", () => {
  it("renames it, sets default teams, takes in people with no workspace; moving someone from another workspace is the org admins'", async () => {
    const wade = w.people.wade.token;
    expect((await patch(wade, W1, { name: "Product & Design" })).body.workspace.name).toBe("Product & Design");
    expect((await patch(wade, W1, { defaultTeamIds: [T2] })).body.workspace.defaultTeamIds).toEqual([T2]);
    // Carol has no workspace: wade takes her in, and lets her go again
    expect((await patch(wade, W1, { members: { add: [w.people.carol.id] } })).status).toBe(200);
    expect(await workspaceOf(w.people.carol.id)).toBe(W1);
    await patch(wade, W1, { members: { remove: [w.people.carol.id] } });
    expect(await workspaceOf(w.people.carol.id)).toBeNull();

    // Carol in another workspace: wade can't pull her out of it; an org admin can
    const other = (await w.call("POST", `/orgs/${w.orgId}/admin/workspaces`, w.people.alice.token, { name: "Marketing", adminIds: [w.people.alice.id] })).body.workspace;
    await patch(w.people.alice.token, other.id, { members: { add: [w.people.carol.id] } });
    const refused = await patch(wade, W1, { members: { add: [w.people.carol.id] } });
    expect([refused.status, refused.body.code]).toEqual([403, "not_admin"]);
    expect(await workspaceOf(w.people.carol.id)).toBe(other.id);
    expect((await patch(w.people.alice.token, W1, { members: { add: [w.people.carol.id] } })).status).toBe(200);
    expect(await workspaceOf(w.people.carol.id)).toBe(W1);

    // Hiding, admins and teams stay the org admins'
    for (const body of [{ hidden: true }, { adminIds: [w.people.wade.id, w.people.bob.id] }, { teams: { add: [T2] } }]) expect((await patch(wade, W1, body)).body.code).toBe("not_admin");
  });
});
