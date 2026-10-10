import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handle, type Deps } from "../../../server/src/api";
import { Db } from "../../../server/src/db";
import type { PreviewEnv } from "../../../server/src/previews";
import { memoryPreviews, type MemoryPreviewObject } from "../../../server/src/testing/memoryPreviews";
import { sqliteD1 } from "../../../server/src/testing/sqliteD1";
import { decodeCanvas } from "../../shared/fig/container";
import { PREVIEW_DATA_PLACEHOLDER, readInlinePreview } from "../../shared/preview/html";
import { buildPreviewPackage, keepPages, previewPagesOf } from "../../shared/preview/package";
import { codec, newDocumentNodes, type Message, type NodeChange } from "../../shared/schema/codec";
import { fromHex } from "../../shared/schema/visit";
import { nodeCodecs } from "../kiwi/codecs";
import { openTestStore, tempDir, type TestStore } from "../testing/harness";
import { previewsOf } from "../localStore";

const PAGE = { sessionID: 0, localID: 1 };
const PAGE2 = { sessionID: 0, localID: 3 };
const INTERNAL = { sessionID: 0, localID: 2 };

/** A synthetic file: two pages, a frame with a rectangle filled with an image, a component on the internal canvas. */
function synthetic(imageSha1: string): Message {
  const nodes: NodeChange[] = [
    ...newDocumentNodes(),
    { guid: PAGE2, phase: "CREATED", type: "CANVAS", name: "Second page", parentIndex: { guid: { sessionID: 0, localID: 0 }, position: "#" } },
    { guid: { sessionID: 1, localID: 1 }, phase: "CREATED", type: "FRAME", name: "Desktop", parentIndex: { guid: PAGE, position: "a" }, size: { x: 1440, y: 1024 } },
    { guid: { sessionID: 1, localID: 4 }, phase: "CREATED", type: "FRAME", name: "Mobile", parentIndex: { guid: PAGE, position: "b" }, size: { x: 375, y: 812 } },
    {
      guid: { sessionID: 1, localID: 2 },
      phase: "CREATED",
      type: "ROUNDED_RECTANGLE",
      name: "Photo",
      parentIndex: { guid: { sessionID: 1, localID: 1 }, position: "a" },
      size: { x: 100, y: 100 },
      fillPaints: [{ type: "IMAGE", visible: true, opacity: 1, image: { hash: fromHex(imageSha1) }, imageScaleMode: "FILL" }],
    },
    { guid: { sessionID: 1, localID: 3 }, phase: "CREATED", type: "FRAME", name: "Other", parentIndex: { guid: PAGE2, position: "a" }, size: { x: 10, y: 10 } },
    { guid: { sessionID: 1, localID: 9 }, phase: "CREATED", type: "SYMBOL", name: "Button", parentIndex: { guid: INTERNAL, position: "a" }, size: { x: 10, y: 10 } },
  ];
  return { type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: nodes, blobs: [], derivedDataVersion: 1 };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const TEMPLATE = `<!doctype html><html data-surface="viewer"><head><title>Developer preview</title></head><body><div id="root"></div>${PREVIEW_DATA_PLACEHOLDER}<script>/* viewer */</script></body></html>`;

describe("the preview package (docs/data.md §13)", () => {
  const sha1 = "a".repeat(40);
  const snapshot = codec.encodeMessage(synthetic(sha1));

  it("lists the pages and their top-level layers, topmost first, without the internal canvas", () => {
    expect(previewPagesOf(synthetic(sha1))).toEqual([
      { id: "0:1", name: "Page 1", frames: [{ id: "1:4", name: "Mobile", type: "FRAME" }, { id: "1:1", name: "Desktop", type: "FRAME" }] },
      { id: "0:3", name: "Second page", frames: [{ id: "1:3", name: "Other", type: "FRAME" }] },
    ]);
  });

  it("keeps only the chosen pages (and the internal canvas)", () => {
    const kept = keepPages(synthetic(sha1), ["0:3"]);
    const ids = kept.nodeChanges!.map((n) => `${n.guid!.sessionID}:${n.guid!.localID}`);
    expect(ids).toEqual(["0:0", "0:2", "0:3", "1:3", "1:9"]);
    expect(() => keepPages(synthetic(sha1), ["9:9"])).toThrow();
  });

  it("packs the snapshot in a deflate-raw container with its images and a manifest", async () => {
    const pkg = await buildPreviewPackage(
      { snapshot, fileName: "Landing page", previewId: "p".repeat(22), now: 1000, options: { pageIds: "all", inspect: true, export: false, expiresInDays: 7 }, readImage: async (s) => (s === sha1 ? PNG : null) },
      nodeCodecs,
    );
    expect(pkg.manifest).toMatchObject({
      format: 1,
      previewId: "p".repeat(22),
      fileName: "Landing page",
      publishedAt: 1000,
      expiresAt: 1000 + 7 * 86400000,
      snapshot: "doc.kiwi",
      derivedDataVersion: 1,
      images: [sha1],
      options: { inspect: true, export: false },
    });
    const doc = decodeCanvas(pkg.doc, nodeCodecs);
    expect(doc.prelude).toBe("fig-kiwi");
    expect(doc.compression).toBe("deflate-raw");
    expect(doc.message).toEqual(snapshot);
    expect(pkg.images.get(sha1)).toEqual(PNG);
  });

  it("goes into the viewer's page as one data block and comes back out", async () => {
    const { inlinePreviewHtml } = await import("../../shared/preview/html");
    const pkg = await buildPreviewPackage(
      { snapshot, fileName: "A </script> file", previewId: "q".repeat(22), now: 1, options: { pageIds: "all", inspect: true, export: true, expiresInDays: null }, readImage: async () => PNG },
      nodeCodecs,
    );
    const html = inlinePreviewHtml(TEMPLATE, pkg);
    expect(html).toContain("<title>A &lt;/script&gt; file – Developer preview</title>");
    expect(html.match(/<\/script>/g)?.length).toBe(2);
    const json = /<script id="designer-preview-data" type="application\/json">([^<]*)<\/script>/.exec(html)![1];
    const back = readInlinePreview(json);
    expect(back.manifest).toEqual(pkg.manifest);
    expect(back.doc).toEqual(pkg.doc);
    expect(back.images.get(sha1)).toEqual(PNG);
    expect(() => inlinePreviewHtml("<html></html>", pkg)).toThrow(/rebuild/);
  });
});

// --- the server: the Worker's handler on node:sqlite, previews' objects in process ---

const SERVER = "https://designer.test";
let serverNow = Date.UTC(2026, 9, 11);
let server: Deps;
let objects: Map<string, MemoryPreviewObject>;
const serverFetch: typeof fetch = async (input, init) => handle(new Request(String(input), init), server);

beforeEach(() => {
  const d1 = sqliteD1();
  const previews = memoryPreviews(() => serverNow);
  objects = previews.objects;
  const env: Deps["env"] & PreviewEnv = { SESSION_SECRET: "s".repeat(40), DEV_AUTH: "1", DB: d1, PREVIEWS: previews.binding };
  server = { db: new Db(d1), env, rooms: { fetch: async () => Response.json({ ok: true }) }, fetch: async () => new Response(null, { status: 500 }), now: () => serverNow };
});

async function devSession(email: string) {
  const res = await serverFetch(`${SERVER}/auth/dev`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  return { server: SERVER, token: ((await res.json()) as { token: string }).token };
}

const get = (path: string) => serverFetch(`${SERVER}${path}`);

describe("previews in the store, published to the server (docs/multiplayer.md §9)", () => {
  const stores: TestStore[] = [];
  afterEach(async () => {
    for (const t of stores.splice(0)) {
      await t.close().catch(() => {});
      t.dispose();
    }
  });

  async function storeWith() {
    const dir = tempDir();
    const template = join(dir, "viewer.html");
    writeFileSync(template, TEMPLATE);
    const t = await openTestStore({ dir, viewerTemplate: template, fetch: serverFetch });
    stores.push(t);
    serverNow = t.clock.now();
    const file = await t.api.workspace.createFile({ name: "Landing page", folderId: null });
    const { sha1 } = await t.api.blobs.put(PNG);
    return { t, fileKey: file.fileKey, sha1, snapshot: codec.encodeMessage(synthetic(sha1)) };
  }

  it("exports one HTML file with the images from the blob store (main only)", async () => {
    const { t, fileKey, sha1, snapshot } = await storeWith();
    const out = join(t.dir, "Landing page.html");
    const r = await t.api.previews.exportHtml(fileKey, { snapshot, options: { pageIds: ["0:1"] } }, out);
    expect(r).toMatchObject({ path: out, images: 1 });
    const html = readFileSync(out, "utf8");
    const json = /<script id="designer-preview-data" type="application\/json">([^<]*)<\/script>/.exec(html)![1];
    const pkg = readInlinePreview(json);
    expect(pkg.manifest.pages.map((p) => p.name)).toEqual(["Page 1"]);
    expect(pkg.images.get(sha1)).toEqual(PNG);
    const { roleMayCall } = await import("../../shared/store/protocol");
    expect(roleMayCall("editor", "previews.exportHtml")).toBe(false);
    expect(roleMayCall("editor", "previews.publish")).toBe(true);
  });

  it("says Log in to publish until main hands over a session; then publishes, updates in place and unpublishes", async () => {
    const { t, fileKey, snapshot, sha1 } = await storeWith();
    const options = { pageIds: "all" as const, inspect: true, export: true, expiresInDays: 30 as const };
    expect(await t.api.previews.status()).toEqual({ publish: false, reason: "Log in to publish" });
    await expect(t.api.previews.publish(fileKey, { snapshot, options })).rejects.toMatchObject({ code: "offline", message: "Log in to publish" });

    await t.api.multiplayer.setSession(await devSession("owner@x.co"));
    expect(await t.api.previews.status()).toEqual({ publish: true, reason: null });
    const first = await t.api.previews.publish(fileKey, { snapshot, options });
    expect(first.url).toBe(`${SERVER}/p/${first.previewId}`);
    expect(first.blobRefs).toEqual([sha1]);
    expect(first.expiresAt).toBe(t.clock.now() + 30 * 86400000);
    // Anyone reads it by id: what the viewer at /p/<id> fetches.
    const manifest = (await (await get(`/previews/${first.previewId}/manifest.json`)).json()) as { fileName: string; images: string[] };
    expect(manifest).toMatchObject({ fileName: "Landing page", images: [sha1] });
    expect(new Uint8Array(await (await get(`/previews/${first.previewId}/images/${sha1}`)).arrayBuffer())).toEqual(PNG);
    const doc = decodeCanvas(new Uint8Array(await (await get(`/previews/${first.previewId}/doc.kiwi`)).arrayBuffer()), nodeCodecs);
    expect(doc.message).toEqual(snapshot);

    t.clock.advance(1000);
    const second = await t.api.previews.publish(fileKey, { snapshot, options });
    expect(second.previewId).toBe(first.previewId);
    expect(second.url).toBe(first.url);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(await t.api.previews.list(fileKey)).toHaveLength(1);
    // The blob GC keeps the published images.
    expect((await t.api.store.collectGarbage()).live).toBeGreaterThan(0);

    await t.api.previews.stop(first.previewId);
    expect(await t.api.previews.list()).toEqual([]);
    expect((await get(`/previews/${first.previewId}/manifest.json`)).status).toBe(404);
    await expect(t.api.previews.stop(first.previewId)).rejects.toMatchObject({ code: "not-found" });
  });

  it("forgets a preview the server no longer has on Unpublish, and refuses one owned by someone else", async () => {
    const { t, fileKey, snapshot } = await storeWith();
    const options = { pageIds: "all" as const, inspect: true, export: true, expiresInDays: null };
    await t.api.multiplayer.setSession(await devSession("owner@x.co"));
    const r = await t.api.previews.publish(fileKey, { snapshot, options });
    // Another account on this installation can't overwrite it.
    await t.api.multiplayer.setSession(await devSession("other@x.co"));
    await expect(t.api.previews.publish(fileKey, { snapshot, options })).rejects.toMatchObject({ code: "not-found" });
    expect((await get(`/previews/${r.previewId}/manifest.json`)).status).toBe(200);
    // Gone from the server (deleted elsewhere): Unpublish just forgets it.
    await objects.get(r.previewId)!.box.fetch(new Request("https://preview/box", { method: "DELETE" }));
    await t.api.previews.stop(r.previewId);
    expect(await t.api.previews.list()).toEqual([]);
  });

  it("sweeps expired previews off the server when a session arrives", async () => {
    const { t, fileKey, snapshot } = await storeWith();
    const session = await devSession("owner@x.co");
    await t.api.multiplayer.setSession(session);
    const lasting = await t.api.previews.publish(fileKey, { snapshot, options: { pageIds: "all", inspect: true, export: true, expiresInDays: null } });
    const other = await t.api.workspace.createFile({ name: "Other", folderId: null });
    const brief = await t.api.previews.publish(other.fileKey, { snapshot, options: { pageIds: "all", inspect: true, export: true, expiresInDays: 7 } });
    await t.api.multiplayer.setSession(null);
    expect(await previewsOf(t.store).sweepExpired()).toEqual([]); // logged out: nothing
    t.clock.advance(8 * 86400000);
    serverNow = t.clock.now();
    expect((await get(`/previews/${brief.previewId}/manifest.json`)).status).toBe(410);
    await t.api.multiplayer.setSession(session);
    await vi.waitFor(async () => expect((await t.api.previews.list()).map((p) => p.previewId)).toEqual([lasting.previewId]));
    expect((await get(`/previews/${brief.previewId}/manifest.json`)).status).toBe(404);
    expect((await get(`/previews/${lasting.previewId}/manifest.json`)).status).toBe(200);
  });
});
