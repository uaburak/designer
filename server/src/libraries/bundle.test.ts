import { beforeEach, describe, expect, it } from "vitest";
import { MAX_BUNDLE_ITEMS, readBundle, writeBundle, type BundleItem } from "./libraryBox";
import { assetKey, LIB, manifestOf, payload, sha1, world, type TestAsset, type World } from "../testing/orgWorld";

let w: World;
beforeEach(async () => {
  w = await world();
});

const uploadsCounted = async (userId: string) => (await w.rows<{ n: number }>(`SELECT n FROM quota_counters WHERE subject = ?1 AND kind = 'uploads_per_day'`, userId))[0]?.n ?? 0;
const storedOf = async (userId: string) => (await w.rows<{ stored_bytes: number }>(`SELECT stored_bytes FROM users WHERE id = ?1`, userId))[0].stored_bytes;

function assets(n: number): TestAsset[] {
  return Array.from({ length: n }, (_, i) => ({ key: assetKey(`A${i}`), kind: "COMPONENT" as const, name: `A${i}`, seed: `a${i} v1`, thumb: new TextEncoder().encode(`thumb ${i}`) }));
}

function itemsOf(list: TestAsset[]): BundleItem[] {
  return list.flatMap((a): BundleItem[] => [{ type: "payload", key: a.key, versionHash: sha1(payload(a.seed)), bytes: payload(a.seed) }, ...(a.thumb ? [{ type: "blob" as const, sha1: sha1(a.thumb), bytes: a.thumb }] : [])]);
}

describe("POST /libraries/:key/bundle", () => {
  it("stores many payloads and images in one upload of the day, each item's bytes charged, and the publish commits", async () => {
    const alice = w.people.alice;
    const list = assets(200);
    const items = itemsOf(list);
    const before = await storedOf(alice.id);
    const r1 = await w.call("POST", `/libraries/${LIB}/bundle`, alice.token, writeBundle(items.slice(0, 250)));
    expect(r1.status).toBe(204);
    const r2 = await w.call("POST", `/libraries/${LIB}/bundle`, alice.token, writeBundle(items.slice(250)));
    expect(r2.status).toBe(204);
    expect(await uploadsCounted(alice.id)).toBe(2);
    const bytes = items.reduce((n, i) => n + i.bytes.length, 0);
    expect((await storedOf(alice.id)) - before).toBe(bytes);
    expect((await w.rows(`SELECT COUNT(*) AS n FROM stored_items WHERE item LIKE ?1`, `l:${LIB}:%`))[0].n).toBe(items.length);
    // The object has them all: nothing missing, and the commit finds every payload and thumbnail
    const man = manifestOf(list);
    const missing = await w.call("POST", `/libraries/${LIB}/missing`, alice.token, { payloads: man.map((a) => ({ key: a.key, versionHash: a.versionHash })), blobs: list.map((a) => sha1(a.thumb!)) });
    expect(missing.body).toEqual({ payloads: [], blobs: [] });
    const v = await w.call("POST", `/libraries/${LIB}/versions`, alice.token, { baseVersion: 0, description: "", assets: man, changes: { created: man.map((a) => a.key), modified: [], removed: [], moved: [] }, moves: [], collections: [] });
    expect(v.status).toBe(201);
    // Sent again (a retry): stored once, charged by its change only (none)
    expect((await w.call("POST", `/libraries/${LIB}/bundle`, alice.token, writeBundle(items.slice(0, 10)))).status).toBe(204);
    expect((await storedOf(alice.id)) - before).toBe(bytes);
  });

  it("checks every item before writing any, and refuses viewers, too many items and bad frames", async () => {
    const alice = w.people.alice.token;
    const [a, b] = assets(2);
    const good = itemsOf([a]);
    // A blob whose bytes aren't its SHA-1: 400, and the good payload beside it isn't stored or charged
    const bad = await w.call("POST", `/libraries/${LIB}/bundle`, alice, writeBundle([...good, { type: "blob", sha1: sha1("other"), bytes: b.thumb! }]));
    expect(bad.status).toBe(400);
    expect((await w.call("POST", `/libraries/${LIB}/missing`, alice, { payloads: [{ key: a.key, versionHash: sha1(payload(a.seed)) }], blobs: [] })).body.payloads).toHaveLength(1);
    expect(await w.rows(`SELECT * FROM stored_items WHERE item LIKE ?1`, `l:${LIB}:%`)).toEqual([]);
    // Not a container
    expect((await w.call("POST", `/libraries/${LIB}/bundle`, alice, writeBundle([{ type: "payload", key: a.key, versionHash: sha1("x"), bytes: new Uint8Array(20) }]))).status).toBe(400);
    // Cut short, trailing bytes, garbage
    const whole = writeBundle(good);
    expect((await w.call("POST", `/libraries/${LIB}/bundle`, alice, whole.slice(0, whole.length - 1))).status).toBe(400);
    expect((await w.call("POST", `/libraries/${LIB}/bundle`, alice, new Uint8Array([...whole, 0]))).status).toBe(400);
    // More items than a bundle holds
    const many = new Uint8Array(4);
    new DataView(many.buffer).setUint32(0, MAX_BUNDLE_ITEMS + 1, true);
    expect((await w.call("POST", `/libraries/${LIB}/bundle`, alice, many)).status).toBe(400);
    // Declared larger than a bundle may be
    expect((await w.call("POST", `/libraries/${LIB}/bundle`, alice, whole, { "content-length": String(64 * 1024 * 1024) })).status).toBe(413);
    // Viewers (Gus) and the signed out can't upload
    expect((await w.call("POST", `/libraries/${LIB}/bundle`, w.people.gus.token, whole)).status).toBe(403);
    expect((await w.call("POST", `/libraries/${LIB}/bundle`, undefined, whole)).status).toBe(401);
  });

  it("counts against the day's uploads and the owner's storage", async () => {
    const op = w.people.alice;
    const items = itemsOf(assets(3));
    await w.run(`UPDATE users SET quota_overrides = ?2 WHERE id = ?1`, op.id, JSON.stringify({ uploads_per_day: 1 }));
    expect((await w.call("POST", `/libraries/${LIB}/bundle`, op.token, writeBundle(items))).status).toBe(204);
    const again = await w.call("POST", `/libraries/${LIB}/bundle`, op.token, writeBundle(items));
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({ code: "quota_exceeded", kind: "uploads_per_day" });
    await w.run(`UPDATE users SET quota_overrides = ?2, stored_bytes = 0 WHERE id = ?1`, op.id, JSON.stringify({ storage_bytes: 10 }));
    await w.run(`DELETE FROM stored_items`);
    const full = await w.call("POST", `/libraries/${LIB}/bundle`, op.token, writeBundle(itemsOf(assets(5))));
    expect(full.status).toBe(403);
    expect(full.body).toMatchObject({ code: "quota_exceeded", kind: "storage_bytes" });
  });

  it("readBundle round-trips writeBundle", () => {
    const items = itemsOf(assets(3));
    expect(readBundle(writeBundle(items)).map((i) => ({ ...i, bytes: [...i.bytes] }))).toEqual(items.map((i) => ({ ...i, bytes: [...i.bytes] })));
  });
});
