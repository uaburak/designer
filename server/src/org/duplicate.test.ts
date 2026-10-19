/**
 * Duplicate of an org file (docs/multiplayer.md §14.15; leftovers 2026-10-18): Home makes the copy from the person's
 * local copy and shares it in with `POST /files {…, duplicateOf}` — the server checks the person may copy from the
 * original (`canExport`) and logs `fig_file_duplicate`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { P1, P2, WEB, world, type World } from "../testing/orgWorld";

let w: World;
beforeEach(async () => {
  w = await world();
});

const copy = (token: string, key: string, projectId: string, duplicateOf: unknown) => w.call("POST", "/files", token, { key, name: "Site (Copy)", orgId: w.orgId, projectId, duplicateOf });

describe("Duplicate (fig_file_duplicate)", () => {
  it("a copy in the folder, logged with its original; refused where the original's viewers may not copy", async () => {
    const made = await copy(w.people.carol.token, "copy_web001", P2, WEB);
    expect(made.status).toBe(201);
    expect(made.body.file).toMatchObject({ key: "copy_web001", projectId: P2 });
    const log = await w.rows(`SELECT action, details FROM activity_log WHERE entity_id = 'copy_web001'`);
    expect(log.map((r) => r.action)).toEqual(["fig_file_duplicate"]);
    expect(JSON.parse(log[0].details as string)).toMatchObject({ source_file_key: WEB, source_file_name: "Website" });

    // Bob views WEB, whose viewers may not copy: no copy of it in his team's folder
    await w.run(`INSERT INTO members (file_key, email, user_id, role, created_at) VALUES (?1, 'bob@x.co', ?2, 'viewer', 0)`, WEB, w.people.bob.id);
    await w.run(`UPDATE files SET viewers_can_copy = 0 WHERE key = ?1`, WEB);
    const refused = await copy(w.people.bob.token, "copy_web002", P1, WEB);
    expect([refused.status, refused.body.code]).toEqual([403, "export_restricted"]);
    expect(await w.rows(`SELECT key FROM files WHERE key = 'copy_web002'`)).toEqual([]);

    // An original the caller can't open, or a key that isn't one
    expect((await copy(w.people.bob.token, "copy_web003", P1, "file_nope01")).status).toBe(404);
    expect((await copy(w.people.carol.token, "copy_web004", P2, 7)).status).toBe(400);
  });
});
