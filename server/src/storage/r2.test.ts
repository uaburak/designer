/**
 * Object storage on R2 (docs/cloud.md §1, §3, §4), against the real handler, rooms on node:sqlite and in-memory buckets
 * (testing/memoryR2.ts): checkpoints as objects (versions sharing them, the trash), images content-addressed and
 * referenced per file (dedup, charged once per owner), multipart uploads, key management's sealed objects, the lazy and
 * the operator's migration of old rows, the daily sweep, and a region move re-homing everything.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { encodeChangesUp } from "../../../src/shared/multiplayer/protocol";
import { memoryRoomNamespace, type MemoryRoomNamespace, type MemoryRoomObject } from "../testing/memoryRooms";
import { memoryBuckets } from "../testing/memoryR2";
import { BRAND, sha1, WEB, world, type Any, type World } from "../testing/orgWorld";
import { roomsOn } from "../policy/region";
import { RoomBox } from "../roomBox";
import { sqliteStorage } from "../testing/memoryPreviews";
import { newWrappedDek } from "../ekm/keys";
import { PART_BYTES } from "./blobs";
import { resolveR2, type StorageEnv } from "./objects";
import { ORPHAN_GRACE_MS, sweepR2 } from "./refs";
import { roomObjectsHost, noteRegion } from "./roomHost";

let w: World;
let ns: MemoryRoomNamespace;
let r2: ReturnType<typeof memoryBuckets>;

beforeEach(async () => {
  w = await world();
  r2 = memoryBuckets();
  Object.assign(w.deps.env, r2, { OPERATOR_EMAILS: "alice@x.co" });
  ns = memoryRoomNamespace(() => w.now.t, { env: r2, d1: w.d1 });
  w.deps.rooms = roomsOn(ns.binding, w.d1, r2);
  (w.deps.env as Any).ROOMS = ns.binding;
});

const alice = () => w.people.alice.token;
const bytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);
const big = (n: number, seed: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255;
  return b;
};
const room = (key: string, j: "default" | "eu" = "default") => ns.objects[j].get(key) as MemoryRoomObject;
const count = (o: MemoryRoomObject, table: string) => (o.box as Any).host.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0].n as number;
const keys = (b: "FILES" | "FILES_EU", prefix = "") => [...r2[b].objects.keys()].filter((k) => k.startsWith(prefix)).sort();
const identity = () => ({ userId: w.people.alice.id, name: "alice", role: "owner" as const });

async function edits(key: string, n: number) {
  const carol = ns.join("default", key, w.people.carol.id, "editor");
  for (let i = 0; i < n; i++) room(key).room.receive(carol, encodeChangesUp(i + 1, bytes(`edit-${i}`)));
}

describe("checkpoints on R2", () => {
  it("a snapshot is one object, read by the Worker straight from R2; a version shares it; unneeded ones go", async () => {
    expect((await w.call("PUT", `/files/${WEB}/snapshot?seq=0`, alice(), bytes("WEB@0"))).status).toBe(200);
    expect(keys("FILES")).toEqual([`c/${WEB}/0`]);
    expect(count(room(WEB), "snapshot")).toBe(0);
    // The room answers by name; the Worker streams the object
    const direct = await room(WEB).fetch(new Request("https://room/room/snapshot"));
    expect(direct.headers.get("x-r2-key")).toBe(`c/${WEB}/0`);
    const got = await w.call("GET", `/files/${WEB}/snapshot`, alice());
    expect([got.status, str(got.bytes), got.headers.get("x-seq")]).toEqual([200, "WEB@0", "0"]);

    await edits(WEB, 2);
    const v = await w.deps.rooms.fetch(WEB, "/room/versions", { method: "POST", identity: identity(), body: JSON.stringify({ kind: "named", title: "V1" }) });
    const version = ((await v.json()) as Any).version;
    expect(version).toMatchObject({ seq: 2, snapshotSeq: 0, sizeBytes: 5 + 12 });
    expect(count(room(WEB), "history_snapshots")).toBe(0);

    expect((await w.call("PUT", `/files/${WEB}/snapshot?seq=2`, alice(), bytes("WEB@2"))).status).toBe(200);
    expect(keys("FILES")).toEqual([`c/${WEB}/0`, `c/${WEB}/2`]); // the version still needs seq 0
    const vs = await w.deps.rooms.fetch(WEB, `/room/versions/${version.id}/snapshot`, { method: "GET", identity: identity() });
    expect(str(new Uint8Array(await vs.arrayBuffer()))).toBe("WEB@0");

    // The client compacts the version to its own snapshot at seq 2: the same document as the live one (one object)
    await w.deps.rooms.fetch(WEB, `/room/versions/${version.id}/snapshot`, { method: "PUT", identity: identity(), body: bytes("WEB@2") });
    expect(keys("FILES")).toEqual([`c/${WEB}/2`]);
    expect(str((await w.call("GET", `/files/${WEB}/snapshot`, alice())).bytes)).toBe("WEB@2");

    // Out of range after the write: the object goes again
    expect((await w.call("PUT", `/files/${WEB}/snapshot?seq=9`, alice(), bytes("nope"))).status).toBe(409);
    expect(keys("FILES")).toEqual([`c/${WEB}/2`]);

    await w.deps.rooms.fetch(WEB, "/room", { method: "DELETE" });
    expect(keys("FILES", "c/")).toEqual([]);
  });

  it("a branch's base and its staged next base are objects; promoting one drops the other", async () => {
    const o = ns.binding.get("file_br0001" as never) as unknown as MemoryRoomObject;
    noteRegion(o.box.storage, "default");
    const put = (seq: number, body: string) => o.fetch(new Request(`https://room/room/base?seq=${seq}`, { method: "PUT", body: bytes(body) }));
    await put(3, "base@3");
    await put(7, "base@7");
    expect(keys("FILES", "c/file_br0001/")).toEqual(["c/file_br0001/base-3", "c/file_br0001/base-7"]);
    await o.fetch(new Request("https://room/room/snapshot?seq=0", { method: "PUT", body: bytes("doc") }));
    const { encodeEnvelope } = await import("../roomBox");
    const apply = await o.fetch(new Request("https://room/room/apply", { method: "POST", body: encodeEnvelope({ expectSeq: 0, kind: "update", promoteBase: 7 }, bytes("m")) }));
    expect(apply.status).toBe(200);
    expect(keys("FILES", "c/file_br0001/base")).toEqual(["c/file_br0001/base-7"]);
    const base = await resolveR2(await o.fetch(new Request("https://room/room/base")), r2);
    expect([str(new Uint8Array(await base.arrayBuffer())), base.headers.get("x-seq")]).toEqual(["base@7", "7"]);
  });
});

describe("images on R2", () => {
  it("content-addressed, referenced per file, read back immutable; a bad hash leaves nothing", async () => {
    const img = big(5000, 1);
    const s = sha1(img);
    expect((await w.call("POST", `/files/${WEB}/blobs/missing`, alice(), { sha1s: [s] })).body).toEqual({ missing: [s] });
    expect((await w.call("PUT", `/files/${WEB}/blobs/${s}`, alice(), img, { "content-length": String(img.length) })).status).toBe(200);
    expect(keys("FILES", "b/")).toEqual([`b/${s}`]);
    expect(await w.rows(`SELECT sha1, file_key, bucket, key, owner_id FROM r2_refs`)).toEqual([{ sha1: s, file_key: WEB, bucket: "files", key: `b/${s}`, owner_id: w.people.alice.id }]);
    expect(await w.rows(`SELECT item, bytes FROM stored_items WHERE item LIKE 'b:%'`)).toEqual([{ item: `b:${w.people.alice.id}:${s}`, bytes: 5000 }]);
    expect(count(room(WEB), "blobs")).toBe(0);
    const got = await w.call("GET", `/files/${WEB}/blobs/${s}`, w.people.carol.token);
    expect(got.bytes).toEqual(img);
    expect(got.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect((await w.call("POST", `/files/${WEB}/blobs/missing`, alice(), { sha1s: [s] })).body).toEqual({ missing: [] });
    // Without a declared length too (read, hashed, stored)
    const img2 = big(3000, 2);
    expect((await w.call("PUT", `/files/${WEB}/blobs/${sha1(img2)}`, alice(), img2)).status).toBe(200);
    // A body that isn't what its name says
    const lie = sha1(bytes("something else"));
    expect((await w.call("PUT", `/files/${WEB}/blobs/${lie}`, alice(), big(100, 3), { "content-length": "100" })).status).toBe(400);
    expect((await w.call("PUT", `/files/${WEB}/blobs/${lie}`, alice(), big(100, 3))).status).toBe(400);
    expect(keys("FILES", "b/")).toEqual([`b/${s}`, `b/${sha1(img2)}`].sort());
    // A viewer can't upload
    expect((await w.call("PUT", `/files/${WEB}/blobs/${s}`, w.people.dan.token, img)).status).toBe(404);
  });

  it("another file using the same image refers to the object (no upload), its owner charged once", async () => {
    const img = big(4000, 9);
    const s = sha1(img);
    await w.call("PUT", `/files/${WEB}/blobs/${s}`, alice(), img);
    const puts = r2.FILES.ops.a;
    expect((await w.call("POST", `/files/${BRAND}/blobs/missing`, alice(), { sha1s: [s] })).body).toEqual({ missing: [] });
    expect(r2.FILES.ops.a).toBe(puts);
    expect((await w.rows(`SELECT file_key FROM r2_refs ORDER BY file_key`)).map((r) => r.file_key)).toEqual([BRAND, WEB].sort());
    expect((await w.call("GET", `/files/${BRAND}/blobs/${s}`, alice())).bytes).toEqual(img);
    expect((await w.rows(`SELECT stored_bytes FROM users WHERE id = ?1`, w.people.alice.id))[0].stored_bytes).toBe(4000);
    // Bob's draft: Bob neither owns nor edits WEB, so he sends the bytes; they're checked, the object isn't written again
    expect((await w.call("POST", `/files/draft_bob01/blobs/missing`, w.people.bob.token, { sha1s: [s] })).body).toEqual({ missing: [s] });
    const before = r2.FILES.ops.a;
    expect((await w.call("PUT", `/files/draft_bob01/blobs/${s}`, w.people.bob.token, img, { "content-length": String(img.length) })).status).toBe(200);
    expect(r2.FILES.ops.a).toBe(before);
    expect((await w.rows(`SELECT stored_bytes FROM users WHERE id = ?1`, w.people.bob.id))[0].stored_bytes).toBe(4000);
  });

  it("someone in another place can't claim an image by its hash: missing, and wrong bytes refused", async () => {
    const img = big(6000, 11);
    const s = sha1(img);
    await w.call("PUT", `/files/${WEB}/blobs/${s}`, alice(), img);
    // Olga: outside Acme, her own file
    const olga = w.people.olga.token;
    expect((await w.call("POST", "/files", olga, { key: "olga_file1", name: "Mine" })).status).toBe(201);
    expect((await w.call("POST", `/files/olga_file1/blobs/missing`, olga, { sha1s: [s] })).body).toEqual({ missing: [s] });
    expect((await w.call("POST", `/files/olga_file1/blobs/${s}/uploads`, olga, { size: 9_000_000 })).status).toBe(201); // parts to send, not {done}
    for (const headers of [{ "content-length": "6000" }, {}]) expect((await w.call("PUT", `/files/olga_file1/blobs/${s}`, olga, big(6000, 12), headers)).status).toBe(400);
    expect(await w.rows(`SELECT file_key FROM r2_refs WHERE file_key = 'olga_file1'`)).toEqual([]);
    expect((await w.call("GET", `/files/olga_file1/blobs/${s}`, olga)).status).toBe(404);
    expect(r2.FILES.objects.get(`b/${s}`)).toEqual(img); // A's object untouched
    // With the real bytes she has it (sent and checked; the object isn't written again)
    expect((await w.call("PUT", `/files/olga_file1/blobs/${s}`, olga, img)).status).toBe(200);
    expect(sha1((await w.call("GET", `/files/olga_file1/blobs/${s}`, olga)).bytes)).toBe(s);
  });

  it("an embed reads its images from R2", async () => {
    const img = big(2000, 4);
    await w.call("PUT", `/files/${WEB}/blobs/${sha1(img)}`, alice(), img);
    await w.call("PUT", `/files/${WEB}/snapshot?seq=0`, alice(), bytes("doc"));
    await w.run(`UPDATE files SET link_access = 'viewer' WHERE key = ?1`, WEB);
    const got = await w.call("GET", `/embed/${WEB}/images/${sha1(img)}`);
    expect([got.status, got.bytes]).toEqual([200, img]);
    expect(str((await w.call("GET", `/embed/${WEB}/snapshot`)).bytes)).toBe("doc");
  });
});

describe("multipart uploads (blobs over 8 MB)", () => {
  it("create → parts → complete: checked, stored under b/<sha1>, the staging object gone", async () => {
    const img = big(PART_BYTES + 2_500_000, 5);
    const s = sha1(img);
    const created = await w.call("POST", `/files/${WEB}/blobs/${s}/uploads`, alice(), { size: img.length });
    expect(created.status).toBe(201);
    expect(created.body.partSize).toBe(PART_BYTES);
    const id = created.body.uploadId as string;
    const parts: Any[] = [];
    for (let n = 1, at = 0; at < img.length; n++, at += PART_BYTES) {
      const part = img.subarray(at, at + PART_BYTES);
      if (n === 2) r2.FILES.failNext("uploadPart"); // a part fails alone and goes again
      let r = await w.call("PUT", `/files/${WEB}/blobs/${s}/uploads/${id}/parts/${n}`, alice(), part, { "content-length": String(part.length) });
      if (r.status !== 200) r = await w.call("PUT", `/files/${WEB}/blobs/${s}/uploads/${id}/parts/${n}`, alice(), part, { "content-length": String(part.length) });
      expect(r.status).toBe(200);
      parts.push(r.body);
    }
    const done = await w.call("POST", `/files/${WEB}/blobs/${s}/uploads/${id}/complete`, alice(), { parts });
    expect([done.status, done.body]).toEqual([200, { ok: true, size: img.length }]);
    expect(keys("FILES")).toEqual([`b/${s}`]);
    expect(sha1((await w.call("GET", `/files/${WEB}/blobs/${s}`, alice())).bytes)).toBe(s);
    expect((await w.rows(`SELECT bytes FROM stored_items WHERE item = ?1`, `b:${w.people.alice.id}:${s}`))[0].bytes).toBe(img.length);
    // Asked again: already there
    expect((await w.call("POST", `/files/${WEB}/blobs/${s}/uploads`, alice(), { size: img.length })).body).toEqual({ done: true });
  });

  it("wrong bytes are refused at complete and leave nothing; Cancel aborts", async () => {
    const img = big(PART_BYTES + 100, 6);
    const s = sha1(bytes("not these"));
    const id = (await w.call("POST", `/files/${WEB}/blobs/${s}/uploads`, alice(), { size: img.length })).body.uploadId;
    const p1 = (await w.call("PUT", `/files/${WEB}/blobs/${s}/uploads/${id}/parts/1`, alice(), img.subarray(0, PART_BYTES))).body;
    const p2 = (await w.call("PUT", `/files/${WEB}/blobs/${s}/uploads/${id}/parts/2`, alice(), img.subarray(PART_BYTES))).body;
    expect((await w.call("POST", `/files/${WEB}/blobs/${s}/uploads/${id}/complete`, alice(), { parts: [p1, p2] })).status).toBe(400);
    expect(keys("FILES")).toEqual([]);
    const id2 = (await w.call("POST", `/files/${WEB}/blobs/${sha1(img)}/uploads`, alice(), { size: img.length })).body.uploadId;
    expect(r2.FILES.uploads.size).toBe(1);
    expect((await w.call("DELETE", `/files/${WEB}/blobs/${sha1(img)}/uploads/${id2}`, alice())).status).toBe(200);
    expect(r2.FILES.uploads.size).toBe(0);
    expect((await w.call("POST", `/files/${WEB}/blobs/${s}/uploads`, alice(), { size: 50 * 1024 * 1024 })).status).toBe(413);
  });
});

describe("key management on objects (docs/governance.md §2.10)", () => {
  it("an org with a key: images sealed under e/<orgId>/, opened on read; multipart refused", async () => {
    const root = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    (w.deps.env as Any).EKM_ROOT_KEY = root;
    await w.run(`INSERT INTO org_keys (org_id, source, wrapped_dek, state, created_at, updated_at) VALUES (?1, 'managed', ?2, 'ok', 1, 1)`, w.orgId, await newWrappedDek(root, w.orgId));
    const img = big(3000, 7);
    const s = sha1(img);
    expect((await w.call("PUT", `/files/${WEB}/blobs/${s}`, alice(), img, { "content-length": "3000" })).status).toBe(200);
    expect(keys("FILES", "b/")).toEqual([]);
    const key = `e/${w.orgId}/b/${s}`;
    expect(keys("FILES", "e/")).toEqual([key]);
    expect(str(r2.FILES.objects.get(key)!.subarray(0, 4))).toBe("DV2E");
    expect(sha1((await w.call("GET", `/files/${WEB}/blobs/${s}`, alice())).bytes)).toBe(s);
    // Another file of the org: the same sealed object
    expect((await w.call("POST", `/files/${BRAND}/blobs/missing`, alice(), { sha1s: [s] })).body).toEqual({ missing: [] });
    expect((await w.call("GET", `/files/${BRAND}/blobs/${s}`, alice())).bytes).toEqual(img);
    expect((await w.call("POST", `/files/${WEB}/blobs/${sha1(big(9, 1))}/uploads`, alice(), { size: 9_000_000 })).body.code).toBe("multipart_unavailable");
  });
});

describe("the migration of old rows", () => {
  /** A room written before R2 (rows), then given R2 */
  async function legacyRoom(key: string) {
    const env: StorageEnv = {};
    const st = sqliteStorage();
    const box: RoomBox = new RoomBox({
      sql: st.sql,
      transaction: st.transaction,
      now: () => w.now.t,
      setAlarm: () => {},
      broadcast: () => {},
      hasSession: () => false,
      objects: roomObjectsHost({ env, d1: w.d1, storage: () => box.storage, fileKey: () => key, orgId: () => null, blobCipher: () => null, now: () => w.now.t }),
    });
    noteRegion(box.storage, "default");
    const call = async (method: string, path: string, body?: Uint8Array | string) => resolveR2((await box.fetch(new Request(`https://room${path}`, { method, body, headers: { "x-user-id": w.people.alice.id } })))!, r2);
    const img = big(2_500_000, 8);
    await call("PUT", "/room/snapshot?seq=0", bytes("old@0"));
    await call("PUT", `/room/blobs/${sha1(img)}`, img);
    box.storage.append({ seq: 1, sessionID: 1, batch: 1, message: bytes("e1") });
    await call("POST", "/room/versions", JSON.stringify({ kind: "named", title: "Before" }));
    box.storage.append({ seq: 2, sessionID: 1, batch: 2, message: bytes("e2") });
    await call("PUT", "/room/snapshot?seq=2", bytes("old@2"));
    const rows = (t: string) => st.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`).toArray()[0].n;
    expect([rows("snapshot"), rows("history_snapshots"), rows("blobs")]).toEqual([1, 1, 3]);
    Object.assign(env, r2);
    return { box, call, rows, img };
  }

  it("one step per call, each idempotent; reads stay right throughout; the file is marked once nothing is left", async () => {
    const { box, call, rows, img } = await legacyRoom(WEB);
    const steps: (string | null)[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await box.objects.step();
      steps.push(r.moved);
      expect(str(new Uint8Array(await (await call("GET", "/room/snapshot")).arrayBuffer()))).toBe("old@2");
      if (r.done) break;
    }
    expect(steps).toEqual(["snapshot", "version", "blob", null]);
    expect([rows("snapshot"), rows("history_snapshots"), rows("blobs")]).toEqual([0, 0, 0]);
    expect(keys("FILES")).toEqual([`b/${sha1(img)}`, `c/${WEB}/0`, `c/${WEB}/2`].sort());
    const version = box.versions()[0];
    expect(str(new Uint8Array(await (await call("GET", `/room/versions/${version.id}/snapshot`)).arrayBuffer()))).toBe("old@0");
    expect(await w.rows(`SELECT sha1, file_key, owner_id FROM r2_refs`)).toEqual([{ sha1: sha1(img), file_key: WEB, owner_id: null }]);
    expect((await w.rows(`SELECT storage_r2_at FROM files WHERE key = ?1`, WEB))[0].storage_r2_at).toBe(w.now.t);
    expect((await box.objects.step()).done).toBe(true);
    // The Worker serves the moved image from R2
    expect(sha1((await w.call("GET", `/files/${WEB}/blobs/${sha1(img)}`, alice())).bytes)).toBe(sha1(img));
  });

  it("the operator's loop: progress, then each file until finished; others refused", async () => {
    await w.call("PUT", `/files/${WEB}/snapshot?seq=0`, alice(), bytes("new"));
    expect((await w.call("POST", "/operator/storage/migrate-next", w.people.bob.token, {})).status).toBe(403);
    const before = await w.call("GET", "/operator/storage", alice());
    expect(before.body).toMatchObject({ files: { total: 5, migrated: 0 }, finished: false });
    let cursor: string | null = null;
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r: Any = await w.call("POST", "/operator/storage/migrate-next", alice(), cursor ? { after: cursor } : {});
      expect(r.status).toBe(200);
      if (r.body.finished) break;
      seen.push(`${r.body.key}:${r.body.done}`);
      cursor = r.body.cursor;
    }
    expect(seen).toEqual(["draft_bob01:true", "file_brand1:true", "file_web001:true", "lib_design1:true", "lib_secret1:true"]);
    expect((await w.call("GET", "/operator/storage", alice())).body).toMatchObject({ files: { total: 5, migrated: 5 }, finished: true });
  });
});

describe("the daily sweep", () => {
  it("references of deleted files dropped (stored bytes released), orphans deleted after 7 days, shared objects kept", async () => {
    const shared = big(1000, 1);
    const only = big(1500, 2);
    await w.call("PUT", `/files/${WEB}/blobs/${sha1(shared)}`, alice(), shared);
    await w.call("PUT", `/files/${WEB}/blobs/${sha1(only)}`, alice(), only);
    await w.call("POST", `/files/${BRAND}/blobs/missing`, alice(), { sha1s: [sha1(shared)] });
    await w.run(`DELETE FROM files WHERE key = ?1`, WEB);
    expect(await sweepR2(w.deps)).toEqual({ dropped: 2, orphaned: 1, deleted: 0 });
    // Alice still uses `shared` in BRAND: only `only` is released
    expect((await w.rows(`SELECT item FROM stored_items WHERE item LIKE 'b:%'`)).map((r) => r.item)).toEqual([`b:${w.people.alice.id}:${sha1(shared)}`]);
    expect(keys("FILES", "b/")).toHaveLength(2);
    w.now.t += ORPHAN_GRACE_MS - 1000;
    expect((await sweepR2(w.deps)).deleted).toBe(0);
    w.now.t += 2000;
    expect(await sweepR2(w.deps)).toEqual({ dropped: 0, orphaned: 0, deleted: 1 });
    expect(keys("FILES", "b/")).toEqual([`b/${sha1(shared)}`]);
    expect(await w.rows(`SELECT key FROM r2_objects`)).toEqual([{ key: `b/${sha1(shared)}` }]);
  });

  it("an orphan uploaded again within the grace is kept", async () => {
    const img = big(800, 3);
    await w.call("PUT", `/files/${WEB}/blobs/${sha1(img)}`, alice(), img);
    await w.run(`DELETE FROM files WHERE key = ?1`, WEB);
    await sweepR2(w.deps);
    w.now.t += 86_400_000;
    // No file uses it any more: missing, so its bytes are sent again (and checked); the object is referenced again
    expect((await w.call("POST", `/files/${BRAND}/blobs/missing`, alice(), { sha1s: [sha1(img)] })).body).toEqual({ missing: [sha1(img)] });
    expect((await w.call("PUT", `/files/${BRAND}/blobs/${sha1(img)}`, alice(), img)).status).toBe(200);
    w.now.t += ORPHAN_GRACE_MS;
    expect((await sweepR2(w.deps)).deleted).toBe(0);
    expect(keys("FILES", "b/")).toEqual([`b/${sha1(img)}`]);
  });
});

describe("a region move (docs/multiplayer.md §15.10)", () => {
  it("checkpoints and images re-homed in the EU bucket before the flip; the old room's objects gone", async () => {
    const img = big(1200, 4);
    await w.call("PUT", `/files/${WEB}/snapshot?seq=0`, alice(), bytes("WEB@0"));
    await w.call("PUT", `/files/${WEB}/blobs/${sha1(img)}`, alice(), img);
    await w.call("PUT", `/orgs/${w.orgId}/admin/data-region`, alice(), { region: "eu" });
    for (let i = 0; i < 10; i++) if (!(await w.call("POST", `/orgs/${w.orgId}/admin/data-region/move`, alice())).body.moving) break;
    expect(keys("FILES_EU")).toEqual([`b/${sha1(img)}`, `c/${WEB}/0`].sort());
    expect(keys("FILES", "c/")).toEqual([]);
    expect(str((await w.call("GET", `/files/${WEB}/snapshot`, alice())).bytes)).toBe("WEB@0");
    expect(sha1((await w.call("GET", `/files/${WEB}/blobs/${sha1(img)}`, alice())).bytes)).toBe(sha1(img));
    expect(await w.rows(`SELECT bucket FROM r2_refs WHERE file_key = ?1`, WEB)).toEqual([{ bucket: "files_eu" }]);
    // The default bucket's copy is orphaned and swept later
    await sweepR2(w.deps);
    w.now.t += ORPHAN_GRACE_MS + 1;
    await sweepR2(w.deps);
    expect(keys("FILES")).toEqual([]);
  });
});
