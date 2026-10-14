import { beforeEach, describe, expect, it } from "vitest";
import { LIB, P1, T1, world, type Any, type World } from "../testing/orgWorld";

// A team file's people through the team, one of them taken off the file and given back (file_exclusions, 0024)
let w: World;
const OTHER = "file_design2";
beforeEach(async () => {
  w = await world();
  await w.run(
    `INSERT INTO files (key, owner_id, name, created_at, updated_at, org_id, team_id, project_id, editor_type) VALUES (?1, ?2, 'Other', ?3, ?3, ?4, ?5, ?6, 'design')`,
    OTHER,
    w.people.alice.id,
    w.now.t,
    w.orgId,
    T1,
    P1,
  );
  // carol views the Design team (no share rights)
  await w.run(`INSERT INTO team_members (team_id, email, user_id, role, admin, created_at) VALUES (?1, 'carol@x.co', ?2, 'viewer', 0, ?3)`, T1, w.people.carol.id, w.now.t);
});

const folderFiles = async (who: keyof World["people"]) => ((await w.call("GET", `/projects/${P1}/files`, w.people[who].token)).body.files as Any[]).map((f) => f.key).sort();

describe("taking a team member off one file", () => {
  it("lists the team's people, removes one person's access to that file only, and gives it back", async () => {
    const alice = w.people.alice.token;
    const bob = w.people.bob;
    expect((await w.call("GET", `/files/${LIB}`, bob.token)).body.access.via).toContain("team");
    expect(await folderFiles("bob")).toEqual([OTHER, LIB].sort());

    const list = await w.call("GET", `/files/${LIB}/exclusions`, alice);
    expect(list.status).toBe(200);
    expect(list.body.people.find((p: Any) => p.userId === bob.id)).toMatchObject({ email: "bob@x.co", role: "editor", owner: false, excluded: false });

    expect((await w.call("PUT", `/files/${LIB}/exclusions`, alice, { userId: bob.id })).status).toBe(200);
    expect(w.rooms.some((r) => r.key === LIB && r.path === "/room/revoke" && r.body.userId === bob.id)).toBe(true);
    expect((await w.call("GET", `/files/${LIB}`, bob.token)).status).toBe(404);
    expect((await w.call("GET", `/files/${OTHER}`, bob.token)).status).toBe(200);
    expect(await folderFiles("bob")).toEqual([OTHER]);
    expect((await w.call("GET", `/files/${LIB}/exclusions`, alice)).body.people.find((p: Any) => p.userId === bob.id).excluded).toBe(true);

    expect((await w.call("DELETE", `/files/${LIB}/exclusions/${bob.id}`, alice)).status).toBe(200);
    expect((await w.call("GET", `/files/${LIB}`, bob.token)).body.access.canEdit).toBe(true);
    expect(await folderFiles("bob")).toEqual([OTHER, LIB].sort());
  });

  it("keeps the owner, and only lets sharers change it", async () => {
    const r = await w.call("PUT", `/files/${LIB}/exclusions`, w.people.alice.token, { userId: w.people.alice.id });
    expect(r.status).toBe(400);
    expect((await w.call("GET", `/files/${LIB}`, w.people.alice.token)).status).toBe(200);
    // carol only views: she opens the file but can't take anyone off it
    expect((await w.call("GET", `/files/${LIB}`, w.people.carol.token)).status).toBe(200);
    expect((await w.call("GET", `/files/${LIB}/exclusions`, w.people.carol.token)).status).toBe(403);
    expect((await w.call("PUT", `/files/${LIB}/exclusions`, w.people.carol.token, { userId: w.people.bob.id })).status).toBe(403);
    expect((await w.call("DELETE", `/files/${LIB}/exclusions/${w.people.bob.id}`, w.people.carol.token)).status).toBe(403);
    // a draft isn't a team file
    expect((await w.call("GET", `/files/draft_bob01/exclusions`, w.people.bob.token)).status).toBe(404);
  });
});
