/**
 * The Durable Objects' other bytes on R2 (docs/cloud.md §1): a library's payloads and images, an org's fonts and icons,
 * a developer preview's files and a room's REST parts — one object each, read by the Worker straight from R2, older
 * rows readable until moved (one per wake, or the operator's loop), everything gone with its object.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { PreviewManifest } from "../../../src/shared/preview/format";
import { handle } from "../api";
import { memoryFonts, memoryLibraries } from "../testing/memoryLibraries";
import { memoryPreviews } from "../testing/memoryPreviews";
import { memoryRoomNamespace, memoryRooms, type MemoryRoomNamespace } from "../testing/memoryRooms";
import { memoryBuckets } from "../testing/memoryR2";
import { assetKey, LIB, publish, WEB, world, type Any, type World } from "../testing/orgWorld";
import { roomsOn } from "../policy/region";
import { readPayloads } from "../libraries/libraryBox";

let w: World;
let r2: ReturnType<typeof memoryBuckets>;
let ns: MemoryRoomNamespace;

beforeEach(async () => {
  w = await world();
  r2 = memoryBuckets();
  const libs = memoryLibraries(r2);
  const fonts = memoryFonts(r2);
  Object.assign(w.deps.env, r2, { LIBRARIES: libs.binding, FONTS: fonts.binding, OPERATOR_EMAILS: "alice@x.co" });
  w.libs = libs;
  w.fonts = fonts;
  ns = memoryRoomNamespace(() => w.now.t, { env: r2, d1: w.d1 });
  w.deps.rooms = roomsOn(ns.binding, w.d1, r2);
});

const sha1 = (b: Uint8Array | string) => createHash("sha1").update(b).digest("hex");
const keys = (prefix: string) => [...r2.FILES.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
const rowsOf = (box: unknown, table: string) => (box as Any).host.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0].n as number;

describe("a library's payloads and images", () => {
  it("published to l/<libKey>/…, read back through the Worker", async () => {
    const thumb = new Uint8Array([9, 9, 9, 1]);
    const r = await publish(w, LIB, w.people.alice.token, [{ key: assetKey("Button"), kind: "COMPONENT", name: "Button", seed: "b1", thumb }]);
    expect(r.status).toBe(201);
    const stored = keys(`l/${LIB}/`);
    expect(stored).toHaveLength(2);
    expect(stored[0]).toBe(`l/${LIB}/b/${sha1(thumb)}`);
    expect(stored[1]).toMatch(new RegExp(`^l/${LIB}/p/${assetKey("Button")}/[0-9a-f]{40}$`));
    const box = w.libs.objects.get(LIB)!.box;
    expect([rowsOf(box, "payloads"), rowsOf(box, "blobs")]).toEqual([0, 0]);
    const blob = await w.call("GET", `/libraries/${LIB}/blobs/${sha1(thumb)}`, w.people.bob.token);
    expect([blob.status, [...blob.bytes]]).toEqual([200, [...thumb]]);
    const v = r.body.version.assets[0];
    const p = await w.call("POST", `/libraries/${LIB}/payloads`, w.people.bob.token, { wants: [{ key: v.key, versionHash: v.versionHash }] });
    expect(readPayloads(p.bytes).map((x) => x.key)).toEqual([v.key]);
    // Missing asks R2's index too
    expect((await w.call("POST", `/libraries/${LIB}/missing`, w.people.alice.token, { payloads: [{ key: v.key, versionHash: v.versionHash }], blobs: [sha1(thumb)] })).body).toEqual({ payloads: [], blobs: [] });
  });

  it("old rows move to R2 with the operator's loop; deleting the library deletes its objects", async () => {
    // Written before R2: a library object without buckets, then the same storage with them
    const legacy = memoryLibraries();
    (w.deps.env as Any).LIBRARIES = legacy.binding;
    const thumb = new Uint8Array([7, 7, 7]);
    await publish(w, LIB, w.people.alice.token, [{ key: assetKey("Card"), kind: "COMPONENT", name: "Card", seed: "c1", thumb }]);
    const box = legacy.objects.get(LIB)!.box;
    expect(rowsOf(box, "payloads")).toBe(1);
    (box as Any).host.env = r2;
    (box as Any).host.name = () => LIB;
    (box as Any).objects.host = (await import("./boxObjects")).boxObjectsHost(r2, () => "default", () => `l/${LIB}/`);
    for (let i = 0; i < 12; i++) if ((await w.call("POST", "/operator/storage/migrate-next", w.people.alice.token, {})).body.finished) break;
    expect([rowsOf(box, "payloads"), rowsOf(box, "blobs")]).toEqual([0, 0]);
    expect(keys(`l/${LIB}/`)).toHaveLength(2);
    expect((await w.rows(`SELECT storage_r2_at FROM libraries WHERE key = ?1`, LIB))[0].storage_r2_at).toBe(w.now.t);
    expect([...(await w.call("GET", `/libraries/${LIB}/blobs/${sha1(thumb)}`, w.people.bob.token)).bytes]).toEqual([...thumb]);
    await box.fetch(new Request("https://object/delete", { method: "POST" }));
    expect(keys(`l/${LIB}/`)).toEqual([]);
  });
});

describe("an org's fonts and icons", () => {
  const ttf = (seed: string) => new Uint8Array([0, 1, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, ...new TextEncoder().encode(seed)]);
  const png = (seed: string) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(seed)]);
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

  it("fonts at f/<orgId>/<sha1>, icons at i/<orgId>/<sha1> (served public and immutable), removed with their rows", async () => {
    const face = { family: "Acme Sans", style: "Regular", postscriptName: "AcmeSans-Regular", weight: 400, italic: false, stretch: 5, variable: false };
    const font = ttf("regular");
    const up = await w.call("PUT", `/orgs/${w.orgId}/fonts`, w.people.alice.token, font, { "x-font-faces": b64([face]), "x-font-file-name": "Acme.ttf", "x-font-licence": "confirmed" });
    expect(up.status).toBe(201);
    expect(keys(`f/${w.orgId}/`)).toEqual([`f/${w.orgId}/${sha1(font)}`]);
    const file = await w.call("GET", `/fonts/${sha1(font)}`, w.people.bob.token);
    expect([file.status, [...file.bytes], file.headers.get("content-type")]).toEqual([200, [...font], "font/ttf"]);

    const icon = png("one");
    const set = await w.call("PUT", `/orgs/${w.orgId}/icon`, w.people.alice.token, icon);
    expect(set.status).toBe(200);
    expect(keys(`i/${w.orgId}/`)).toEqual([`i/${w.orgId}/${sha1(icon)}`]);
    const got = await w.call("GET", set.body.org.iconUrl);
    expect([got.status, [...got.bytes], got.headers.get("content-type"), got.headers.get("cache-control")]).toEqual([200, [...icon], "image/png", "public, max-age=31536000, immutable"]);
    await w.call("DELETE", `/orgs/${w.orgId}/icon`, w.people.alice.token);
    expect(keys(`i/${w.orgId}/`)).toEqual([]);
  });
});

describe("a developer preview's files", () => {
  it("p/<id>/…: a staged document swapped in by the manifest, images dropped with it, all gone when unpublished", async () => {
    const previews = memoryPreviews(() => w.now.t, r2);
    Object.assign(w.deps.env, { PREVIEWS: previews.binding, DB: w.d1 });
    const id = "Q".repeat(22);
    const img = new Uint8Array([1, 2, 3, 4]);
    const manifest = (images: string[]): PreviewManifest => ({ format: 1, previewId: id, fileName: "Landing", publishedAt: w.now.t, expiresAt: null, pages: [{ id: "0:1", name: "Page 1", frames: [] }], snapshot: "doc.kiwi", documentFormatVersion: 1, derivedDataVersion: 1, images, options: { inspect: true, export: true } });
    const t = w.people.alice.token;
    expect((await w.call("PUT", `/previews/${id}/doc`, t, new TextEncoder().encode("doc v1"))).status).toBe(200);
    expect((await w.call("PUT", `/previews/${id}/images/${sha1(img)}`, t, img)).status).toBe(200);
    expect((await w.call("PUT", `/previews/${id}/manifest`, t, { manifest: manifest([sha1(img)]) })).status).toBe(200);
    const read = (path: string) => handle(new Request(`https://designer.example.workers.dev/previews/${id}/${path}`), w.deps);
    expect(await (await read("doc.kiwi")).text()).toBe("doc v1");
    expect([...new Uint8Array(await (await read(`images/${sha1(img)}`)).arrayBuffer())]).toEqual([...img]);
    expect(keys(`p/${id}/`)).toHaveLength(2);
    // Republished without the image: the old document and the image go
    await w.call("PUT", `/previews/${id}/doc`, t, new TextEncoder().encode("doc v2"));
    await w.call("PUT", `/previews/${id}/manifest`, t, { manifest: manifest([]) });
    expect(keys(`p/${id}/`)).toHaveLength(1);
    expect(await (await read("doc.kiwi")).text()).toBe("doc v2");
    expect(previews.objects.get(id)!.box).toBeDefined();
    expect((await w.call("DELETE", `/previews/${id}`, t)).status).toBe(200);
    expect(keys(`p/${id}/`)).toEqual([]);
  });
});

describe("a room's REST parts", () => {
  it("the thumbnail at r/<fileKey>/<sha1>, read back; replaced, the old one goes", async () => {
    const one = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const two = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);
    const id = { userId: w.people.alice.id, name: "alice", role: "owner" as const };
    // Rooms with their REST jobs (testing/memoryRooms.ts), on R2
    w.deps.rooms = memoryRooms(() => w.now.t, { env: r2, d1: w.d1 }).rooms;
    await w.deps.rooms.fetch(WEB, "/room/thumbnail", { method: "PUT", identity: id, body: one });
    expect(keys(`r/${WEB}/`)).toEqual([`r/${WEB}/${sha1(one)}`]);
    const got = await w.deps.rooms.fetch(WEB, `/room/thumbnail?fileKey=${WEB}`, { method: "GET" });
    expect([got.status, [...new Uint8Array(await got.arrayBuffer())], got.headers.get("x-sha1")]).toEqual([200, [...one], sha1(one)]);
    await w.deps.rooms.fetch(WEB, "/room/thumbnail", { method: "PUT", identity: id, body: two });
    expect(keys(`r/${WEB}/`)).toEqual([`r/${WEB}/${sha1(two)}`]);
    const part = await w.deps.rooms.fetch(WEB, `/room/rest-blob/${sha1(two)}`, { method: "GET" });
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([...two]);
    await w.deps.rooms.fetch(WEB, "/room", { method: "DELETE" });
    expect(keys(`r/${WEB}/`)).toEqual([]);
  });
});
