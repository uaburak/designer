/**
 * Round 4b — data storage localization (docs/multiplayer.md §15.10): rooms and library objects addressed by their
 * jurisdiction (a fake `ROOMS` / `LIBRARIES` namespace with `jurisdiction()`), new files and branches in the org's
 * region, and the move — freeze, dump / load in pages, flip, delete; a failure unfreezes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { encodeChangesUp } from "../../../src/shared/multiplayer/protocol";
import { memoryRoomNamespace, type MemoryRoomNamespace, type MemoryRoomObject } from "../testing/memoryRooms";
import { assetKey, LIB, publish, sha1, WEB, world, type Any, type World } from "../testing/orgWorld";
import { roomsOn } from "./region";

let w: World;
let ns: MemoryRoomNamespace;

beforeEach(async () => {
  w = await world();
  ns = memoryRoomNamespace(() => w.now.t);
  w.deps.rooms = roomsOn(ns.binding, w.d1);
  (w.deps.env as Any).ROOMS = ns.binding;
});

const bytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);
const alice = () => w.people.alice.token;
const region = (path = "", method = "GET", body?: unknown, token = alice()) => w.call(method, `/orgs/${w.orgId}/admin/data-region${path}`, token, body);
const room = (j: "default" | "eu", key: string) => ns.objects[j].get(key) as MemoryRoomObject | undefined;
const jurisdiction = async (key: string) => (await w.rows(`SELECT jurisdiction FROM files WHERE key = ?1`, key))[0]?.jurisdiction ?? null;
const big = (n: number, seed: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255;
  return b;
};

/** WEB with a snapshot, two frames, two large images and a named version, in the default region; carol connected */
async function populated() {
  expect((await w.call("PUT", `/files/${WEB}/snapshot?seq=0`, alice(), bytes("WEB@0"))).status).toBe(200);
  const carol = ns.join("default", WEB, w.people.carol.id, "editor", { cursorChat: true, audio: true });
  const o = room("default", WEB)!;
  for (const m of ["edit-1", "edit-2"]) {
    o.room.receive(carol, encodeChangesUp(1, bytes(m)));
    o.box.edited();
  }
  const images = [big(1_300_000, 1), big(1_200_000, 2)]; // 3.3 MB as base64: more than one page
  for (const img of images) expect((await w.call("PUT", `/files/${WEB}/blobs/${sha1(img)}`, alice(), img)).status).toBe(200);
  await w.deps.rooms.fetch(WEB, "/room/versions", { method: "POST", identity: { userId: w.people.alice.id, name: "alice", role: "owner" }, body: JSON.stringify({ kind: "named", title: "V1" }) });
  return { carol, images };
}

describe("addressing by jurisdiction (§15.10)", () => {
  it("a room is reached in its file's jurisdiction, read from D1 on every call", async () => {
    await w.call("PUT", `/files/${WEB}/snapshot?seq=0`, alice(), bytes("default"));
    expect(room("default", WEB)!.box.storage.snapshotSeq()).toBe(0);
    expect(room("eu", WEB)).toBeUndefined();
    await w.run(`UPDATE files SET jurisdiction = 'eu' WHERE key = ?1`, WEB);
    await w.call("PUT", `/files/${WEB}/snapshot?seq=0`, alice(), bytes("in the EU"));
    expect(str((await w.call("GET", `/files/${WEB}/snapshot`, alice())).bytes)).toBe("in the EU");
    expect(room("eu", WEB)).toBeDefined();
  });

  it("new files in an EU org are made there; files outside orgs aren't; a branch lives with its main file", async () => {
    expect((await region()).body).toEqual({ region: "default", files: { total: 5, moved: 5 }, libraries: { total: 0, moved: 0 }, moving: null, available: true });
    expect((await region("", "PUT", { region: "eu" }, w.people.wade.token)).body.code).toBe("not_admin");
    expect((await region("", "PUT", { region: "mars" })).status).toBe(400);
    const set = await region("", "PUT", { region: "eu" });
    expect(set.body).toMatchObject({ region: "eu", files: { total: 5, moved: 0 } });
    expect((await w.rows(`SELECT action, details FROM activity_log WHERE action = 'data_storage_localization_change'`)).map((r) => JSON.parse(r.details))).toEqual([expect.objectContaining({ from: "default", to: "eu" })]);
    expect((await w.call("GET", `/orgs/${w.orgId}`, alice())).body.org.dataRegion).toBe("eu");
    expect((await w.call("POST", `/orgs/${w.orgId}/drafts`, alice(), { key: "eu_draft01", name: "D" })).status).toBe(201);
    expect(await jurisdiction("eu_draft01")).toBe("eu");
    await w.call("PUT", `/files/eu_draft01/snapshot?seq=0`, alice(), bytes("draft"));
    expect(room("eu", "eu_draft01")!.box.storage.snapshotSeq()).toBe(0);
    await w.call("POST", "/files", w.people.olga.token, { key: "olga_file1", name: "Mine" });
    expect(await jurisdiction("olga_file1")).toBeNull();
    // a branch of an EU file: its room in the EU too
    await w.run(`UPDATE files SET jurisdiction = 'eu' WHERE key = ?1`, WEB);
    await w.call("PUT", `/files/${WEB}/snapshot?seq=0`, alice(), bytes("WEB@0"));
    const b = await w.call("POST", `/files/${WEB}/branches`, alice(), { branchKey: "web_branch1", name: "Try", baseSeq: 0 });
    expect(b.status).toBe(201);
    expect(await jurisdiction("web_branch1")).toBe("eu");
    expect(room("eu", "web_branch1")).toBeDefined();
    expect(room("default", "web_branch1")).toBeUndefined();
  });

  it("without a jurisdiction-restricted namespace the region is unavailable", async () => {
    (w.deps.env as Any).ROOMS = undefined;
    expect((await region()).body.available).toBe(false);
    expect((await region("", "PUT", { region: "eu" })).status).toBe(503);
  });
});

describe("moving an org's content (§15.10)", () => {
  it("a full move: each room and library copied to the EU, the old objects deleted, sockets closed with 4012", async () => {
    const { carol, images } = await populated();
    const before = room("default", WEB)!;
    const head = { last: before.box.storage.lastSeq(), versions: before.box.versions() };
    const BUTTON = { key: assetKey("Button"), kind: "COMPONENT" as const, name: "Button", seed: "b1" };
    expect((await publish(w, LIB, alice(), [BUTTON])).status).toBe(201);
    expect(w.libs.objects.has(LIB)).toBe(true);
    await region("", "PUT", { region: "eu" });
    expect((await region("/move", "POST", undefined, w.people.wade.token)).body.code).toBe("not_admin");

    const moved: string[] = [];
    for (let i = 0; i < 20; i++) {
      const s = (await region("/move", "POST")).body;
      if (!s.moving) break;
      moved.push(s.moving);
      if (s.moving === WEB) expect(carol.closed).toBe(4012);
    }
    expect(moved).toContain(WEB);
    expect(moved.at(-1)).toBe(LIB); // libraries after files
    expect((await region()).body).toMatchObject({ region: "eu", files: { total: 5, moved: 5 }, libraries: { total: 1, moved: 1 }, moving: null });
    expect(await jurisdiction(WEB)).toBe("eu");

    // the copy holds everything; the old object is empty
    const eu = room("eu", WEB)!;
    expect(eu.box.storage.lastSeq()).toBe(head.last);
    expect(eu.box.versions()).toEqual(head.versions);
    expect(eu.box.moving()).toBe(false);
    expect(str((await w.call("GET", `/files/${WEB}/snapshot`, alice())).bytes)).toBe("WEB@0");
    for (const img of images) expect(sha1((await w.call("GET", `/files/${WEB}/blobs/${sha1(img)}`, alice())).bytes)).toBe(sha1(img));
    expect([...eu.box.storage.readAfter(0)].map((f) => str(f.message))).toEqual(["edit-1", "edit-2"]);
    expect(room("default", WEB)!.box.storage.lastSeq()).toBe(0);
    // the library: read through the EU object; the old one deleted
    expect((await w.call("GET", `/libraries/${LIB}/versions/latest`, alice())).body.version).toBe(1);
    expect(w.libs.euObjects.has(LIB)).toBe(true);
    expect(w.libs.objects.get(LIB)!.wiped).toBe(1);
    expect((await w.rows(`SELECT jurisdiction FROM libraries WHERE key = ?1`, LIB))[0].jurisdiction).toBe("eu");
    expect((await w.rows(`SELECT COUNT(*) AS n FROM activity_log WHERE action = 'fig_file_region_move'`))[0].n).toBe(6);
    // a newly connected member reaches the copy and edits on
    const back = ns.join("eu", WEB, w.people.carol.id);
    eu.room.receive(back, encodeChangesUp(2, bytes("edit-3")));
    expect(eu.box.storage.lastSeq()).toBe(head.last + 1);

    // and back to the default region
    await region("", "PUT", { region: "default" });
    for (let i = 0; i < 20 && (await region("/move", "POST")).body.moving; i++);
    expect(await jurisdiction(WEB)).toBeNull();
    expect(str((await w.call("GET", `/files/${WEB}/snapshot`, alice())).bytes)).toBe("WEB@0");
    expect(room("default", WEB)!.box.storage.lastSeq()).toBe(head.last + 1);
  });

  it("while frozen: writes refused 503 moving, sockets refused, members closed with 4012; unfrozen, all works again", async () => {
    const { carol } = await populated();
    await w.deps.rooms.fetch(WEB, "/room/freeze", { method: "POST", body: JSON.stringify({ moving: true }) });
    expect(carol.closed).toBe(4012);
    const put = await w.call("PUT", `/files/${WEB}/snapshot?seq=2`, alice(), bytes("late"));
    expect(put.status).toBe(503);
    expect(put.body.code).toBe("moving");
    expect((await w.call("GET", `/files/${WEB}/ws`, w.people.carol.token, undefined, { upgrade: "websocket" })).status).toBe(503);
    expect(str((await w.call("GET", `/files/${WEB}/snapshot`, alice())).bytes)).toBe("WEB@0"); // reads go on
    await w.deps.rooms.fetch(WEB, "/room/unfreeze", { method: "POST", body: JSON.stringify({ moving: true }) });
    expect((await w.call("PUT", `/files/${WEB}/snapshot?seq=2`, alice(), bytes("late"))).status).toBe(200);
  });

  it("a failure before the flip unfreezes the old object and deletes the partial copy; the next call moves it", async () => {
    await populated();
    await region("", "PUT", { region: "eu" });
    // the first file in key order is BRAND's (empty room); fail WEB's second page
    await w.run(`UPDATE files SET jurisdiction = 'eu' WHERE key <> ?1 AND org_id = ?2`, WEB, w.orgId);
    ns.failNext("/room/load");
    const failed = await region("/move", "POST");
    expect(failed.status).toBe(502);
    expect(await jurisdiction(WEB)).toBeNull();
    expect(room("default", WEB)!.box.moving()).toBe(false);
    expect(room("eu", WEB)!.box.storage.lastSeq()).toBe(0); // the partial copy deleted
    expect((await w.call("PUT", `/files/${WEB}/snapshot?seq=2`, alice(), bytes("WEB@2"))).status).toBe(200);
    expect((await region("/move", "POST")).body.moving).toBe(WEB);
    expect(str((await w.call("GET", `/files/${WEB}/snapshot`, alice())).bytes)).toBe("WEB@2");

    // a library's move failing the same way
    const BUTTON = { key: assetKey("Button"), kind: "COMPONENT" as const, name: "Button", seed: "b1" };
    await w.run(`UPDATE orgs SET data_region = 'default' WHERE id = ?1`, w.orgId);
    expect((await publish(w, LIB, alice(), [BUTTON])).status).toBe(201);
    await w.run(`UPDATE orgs SET data_region = 'eu' WHERE id = ?1`, w.orgId);
    await w.run(`UPDATE files SET jurisdiction = 'eu' WHERE org_id = ?1`, w.orgId);
    w.libs.failNext("/load");
    expect((await region("/move", "POST")).status).toBe(502);
    expect((await w.rows(`SELECT jurisdiction FROM libraries WHERE key = ?1`, LIB))[0].jurisdiction).toBeNull();
    expect((await w.call("GET", `/libraries/${LIB}/versions/latest`, alice())).body.version).toBe(1);
    expect((await region("/move", "POST")).body.moving).toBe(LIB);
    expect((await w.call("GET", `/libraries/${LIB}/versions/latest`, alice())).body.version).toBe(1);
  });
});
