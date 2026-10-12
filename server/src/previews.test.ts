import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { PreviewManifest } from "../../src/shared/preview/format";
import { handle, type Deps } from "./api";
import { Db, type D1Like } from "./db";
import { MAX_PREVIEWS_PER_USER, type PreviewEnv } from "./previews";
import { memoryPreviews, type MemoryPreviewObject } from "./testing/memoryPreviews";
import { sqliteD1 } from "./testing/sqliteD1";

const ORIGIN = "https://designer.example.workers.dev";
const DAY = 86_400_000;


let now: number;
let deps: Deps;
let boxes: Map<string, MemoryPreviewObject>;
let viewerFetches: string[];

beforeEach(() => {
  now = Date.UTC(2026, 9, 11);
  viewerFetches = [];
  const d1: D1Like = sqliteD1();
  const previews = memoryPreviews(() => now);
  boxes = previews.objects;
  const env: PreviewEnv & Deps["env"] = {
    SESSION_SECRET: "s".repeat(40),
    DEV_AUTH: "1",
    DB: d1,
    PREVIEWS: previews.binding,
    ASSETS: {
      fetch: async (req) => {
        viewerFetches.push(typeof req === "string" ? req : req.url);
        return new Response("<!doctype html><title>Developer preview</title>", { headers: { "content-type": "text/html" } });
      },
    },
  };
  deps = { db: new Db(d1), env, rooms: { fetch: async () => new Response("room") }, fetch: async () => new Response(null, { status: 500 }), now: () => now };
});

const call = (method: string, path: string, opts: { token?: string; body?: unknown } = {}) =>
  handle(
    new Request(ORIGIN + path, {
      method,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body === undefined ? undefined : opts.body instanceof Uint8Array ? (opts.body as BodyInit) : JSON.stringify(opts.body),
    }),
    deps,
  );

async function signIn(email: string): Promise<string> {
  const res = await call("POST", "/auth/dev", { body: { email, name: email.split("@")[0] } });
  return ((await res.json()) as { token: string }).token;
}

const ID = "P".repeat(22);
const sha1 = (b: Uint8Array) => createHash("sha1").update(b).digest("hex");
const IMG_A = new Uint8Array([1, 2, 3]);
const IMG_B = new Uint8Array(1024 * 1024 + 10).fill(7); // two chunks

function manifest(images: string[], expiresAt: number | null = null, id = ID): PreviewManifest {
  return {
    format: 1,
    previewId: id,
    fileName: "Landing page",
    publishedAt: now,
    expiresAt,
    pages: [{ id: "0:1", name: "Page 1", frames: [] }],
    snapshot: "doc.kiwi",
    documentFormatVersion: 1,
    derivedDataVersion: 1,
    images,
    options: { inspect: true, export: true },
  };
}

async function publish(token: string, doc: Uint8Array, images: Uint8Array[], expiresAt: number | null = null, id = ID) {
  const missing = await call("POST", `/previews/${id}/images/missing`, { token, body: { sha1s: images.map(sha1) } });
  expect(missing.status).toBe(200);
  for (const s of ((await missing.json()) as { missing: string[] }).missing) {
    const bytes = images.find((b) => sha1(b) === s)!;
    expect((await call("PUT", `/previews/${id}/images/${s}`, { token, body: bytes })).status).toBe(200);
  }
  expect((await call("PUT", `/previews/${id}/doc`, { token, body: doc })).status).toBe(200);
  return call("PUT", `/previews/${id}/manifest`, { token, body: { manifest: manifest(images.map(sha1), expiresAt, id), fileKey: "F".repeat(22) } });
}

const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

describe("developer previews (docs/multiplayer.md §9)", () => {
  it("publishes a package that anyone reads by id, and serves the viewer at /p/<id>", async () => {
    const owner = await signIn("o@x.co");
    const doc = new Uint8Array(2.5 * 1024 * 1024).fill(5); // three chunks
    doc.set([1, 2, 3], 1024 * 1024 - 1);
    const res = await publish(owner, doc, [IMG_A, IMG_B]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ID, url: `${ORIGIN}/p/${ID}`, expiresAt: null });

    const m = await call("GET", `/previews/${ID}/manifest.json`);
    expect(m.status).toBe(200);
    expect(m.headers.get("access-control-allow-origin")).toBe("*");
    expect(((await m.json()) as PreviewManifest).images).toEqual([sha1(IMG_A), sha1(IMG_B)]);
    expect(Buffer.from(await bytesOf(await call("GET", `/previews/${ID}/doc.kiwi`))).equals(doc)).toBe(true);
    expect(Buffer.from(await bytesOf(await call("GET", `/previews/${ID}/images/${sha1(IMG_B)}`))).equals(IMG_B)).toBe(true);
    expect((await call("GET", `/previews/${ID}/images/${"0".repeat(40)}`)).status).toBe(404);

    const page = await call("GET", `/p/${ID}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Developer preview");
    expect(viewerFetches).toEqual([`${ORIGIN}/index.html`]);
    expect((await call("GET", "/p/short")).status).toBe(404);

    const list = await call("GET", "/previews", { token: owner });
    expect(await list.json()).toEqual({ previews: [{ id: ID, fileKey: "F".repeat(22), fileName: "Landing page", createdAt: now, updatedAt: now, expiresAt: null, url: `${ORIGIN}/p/${ID}` }] });
  });

  it("republishes in place: the old document is read until the new manifest, images only uploaded once, unused ones dropped", async () => {
    const owner = await signIn("o@x.co");
    await publish(owner, new Uint8Array([1]), [IMG_A, IMG_B]);
    // A new document staged: readers still get the old one.
    expect((await call("PUT", `/previews/${ID}/doc`, { token: owner, body: new Uint8Array([2]) })).status).toBe(200);
    expect(await bytesOf(await call("GET", `/previews/${ID}/doc.kiwi`))).toEqual(new Uint8Array([1]));
    // Already there: nothing to upload.
    const missing = await call("POST", `/previews/${ID}/images/missing`, { token: owner, body: { sha1s: [sha1(IMG_A)] } });
    expect(await missing.json()).toEqual({ missing: [] });
    now += 1000;
    expect((await call("PUT", `/previews/${ID}/manifest`, { token: owner, body: { manifest: manifest([sha1(IMG_A)]) } })).status).toBe(200);
    expect(await bytesOf(await call("GET", `/previews/${ID}/doc.kiwi`))).toEqual(new Uint8Array([2]));
    const again = await call("POST", `/previews/${ID}/images/missing`, { token: owner, body: { sha1s: [sha1(IMG_A), sha1(IMG_B)] } });
    expect(await again.json()).toEqual({ missing: [sha1(IMG_B)] });
    const [row] = ((await (await call("GET", "/previews", { token: owner })).json()) as { previews: { createdAt: number; updatedAt: number }[] }).previews;
    expect(row.updatedAt).toBe(row.createdAt + 1000);
  });

  it("refuses a manifest whose files aren't there, a wrong id, an image whose bytes don't match, and anyone not signed in", async () => {
    const owner = await signIn("o@x.co");
    expect((await call("PUT", `/previews/${ID}/manifest`, { token: owner, body: { manifest: manifest([]) } })).status).toBe(409); // no document
    expect((await call("PUT", `/previews/${ID}/doc`, { token: owner, body: new Uint8Array([1]) })).status).toBe(200);
    const noImage = await call("PUT", `/previews/${ID}/manifest`, { token: owner, body: { manifest: manifest([sha1(IMG_A)]) } });
    expect(noImage.status).toBe(409);
    expect(await noImage.json()).toMatchObject({ missing: [sha1(IMG_A)] });
    expect((await call("PUT", `/previews/${ID}/manifest`, { token: owner, body: { manifest: manifest([], null, "Q".repeat(22)) } })).status).toBe(400);
    expect((await call("PUT", `/previews/${ID}/manifest`, { token: owner, body: { manifest: { format: 1 } } })).status).toBe(400);
    expect((await call("PUT", `/previews/${ID}/images/${"a".repeat(40)}`, { token: owner, body: IMG_A })).status).toBe(400);
    expect((await call("PUT", `/previews/${ID}/doc`, { body: new Uint8Array([1]) })).status).toBe(401);
    expect((await call("GET", "/previews")).status).toBe(401);
    expect((await call("GET", `/previews/${ID}/manifest.json`)).status).toBe(404); // never went live
    expect((await call("GET", `/previews/bad/manifest.json`)).status).toBe(400);
  });

  it("keeps someone else's preview theirs: writes and Unpublish answer 404", async () => {
    const owner = await signIn("o@x.co");
    const other = await signIn("x@x.co");
    await publish(owner, new Uint8Array([1]), []);
    expect((await call("PUT", `/previews/${ID}/doc`, { token: other, body: new Uint8Array([9]) })).status).toBe(404);
    expect((await call("POST", `/previews/${ID}/images/missing`, { token: other, body: { sha1s: [] } })).status).toBe(404);
    expect((await call("DELETE", `/previews/${ID}`, { token: other })).status).toBe(404);
    expect(await (await call("GET", "/previews", { token: other })).json()).toEqual({ previews: [] });
    expect(await bytesOf(await call("GET", `/previews/${ID}/doc.kiwi`))).toEqual(new Uint8Array([1]));
  });

  it("unpublishes: the files and the row are gone, and the id can be published again", async () => {
    const owner = await signIn("o@x.co");
    await publish(owner, new Uint8Array([1]), [IMG_A]);
    expect((await call("DELETE", `/previews/${ID}`, { token: owner })).status).toBe(200);
    expect((await call("GET", `/previews/${ID}/manifest.json`)).status).toBe(404);
    expect((await call("GET", `/previews/${ID}/images/${sha1(IMG_A)}`)).status).toBe(404);
    expect(await (await call("GET", "/previews", { token: owner })).json()).toEqual({ previews: [] });
    expect((await call("DELETE", `/previews/${ID}`, { token: owner })).status).toBe(404);
    expect((await publish(owner, new Uint8Array([3]), [IMG_A])).status).toBe(200);
    expect(await bytesOf(await call("GET", `/previews/${ID}/doc.kiwi`))).toEqual(new Uint8Array([3]));
  });

  it("expires: reads answer 410, the list leaves it out, and the object's alarm deletes it", async () => {
    const owner = await signIn("o@x.co");
    await publish(owner, new Uint8Array([1]), [IMG_A], now + 7 * DAY);
    expect(boxes.get(ID)!.alarm).toBe(now + 7 * DAY);
    expect((await call("PUT", `/previews/${ID}/manifest`, { token: owner, body: { manifest: manifest([], now - 1) } })).status).toBe(400);
    now += 8 * DAY;
    expect((await call("GET", `/previews/${ID}/manifest.json`)).status).toBe(410);
    expect((await call("GET", `/previews/${ID}/doc.kiwi`)).status).toBe(410);
    expect(await (await call("GET", "/previews", { token: owner })).json()).toEqual({ previews: [] });
    await boxes.get(ID)!.box.alarm();
    expect((await call("GET", `/previews/${ID}/manifest.json`)).status).toBe(404);
    // Published again without expiry: the alarm is cleared.
    expect((await publish(owner, new Uint8Array([2]), [])).status).toBe(200);
    expect(boxes.get(ID)!.alarm).toBeNull();
  });

  it(`allows ${MAX_PREVIEWS_PER_USER} previews per person`, async () => {
    const owner = await signIn("o@x.co");
    const userId = ((await (await call("GET", "/me", { token: owner })).json()) as { id: string }).id;
    const db = (deps.env as PreviewEnv).DB!;
    for (let i = 0; i < MAX_PREVIEWS_PER_USER; i++) await db.prepare(`INSERT INTO previews (id, owner_id, created_at, updated_at) VALUES (?, ?, 0, 0)`).bind(`id${i}`, userId).run();
    const res = await call("PUT", `/previews/${ID}/doc`, { token: owner, body: new Uint8Array([1]) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "quota_exceeded", kind: "previews", limit: MAX_PREVIEWS_PER_USER });
  });
});
