import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeCanvas } from "../../shared/fig/container";
import { PREVIEW_DATA_PLACEHOLDER, readInlinePreview } from "../../shared/preview/html";
import { buildPreviewPackage, keepPages, previewPagesOf } from "../../shared/preview/package";
import { codec, newDocumentNodes, type Message, type NodeChange } from "../../shared/schema/codec";
import { fromHex } from "../../shared/schema/visit";
import { StoreError } from "../../shared/store/protocol";
import { nodeCodecs } from "../kiwi/codecs";
import { openTestStore, tempDir, type TestStore } from "../testing/harness";
import { MemoryStorage, type FirebaseDrivers, MemoryFirestore } from "../sync/drivers";
import { startSync } from "../sync/replicator";
import { previewsOf } from "../localStore";
import { previewUrl, revokePreview, uploadPreview } from "./previews";

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

describe("Firebase Storage publishing, on the in-memory fake", () => {
  it("uploads the manifest last, reuses images, and revokes then deletes on Stop sharing", async () => {
    const order: string[] = [];
    const storage = new MemoryStorage();
    const put = storage.put.bind(storage);
    const meta = new Map<string, Record<string, string> | undefined>();
    storage.put = async (path: string, bytes: Uint8Array, m?: { custom?: Record<string, string> }) => {
      order.push(path);
      meta.set(path, m?.custom);
      return put(path, bytes);
    };
    const sha1 = "b".repeat(40);
    const pkg = await buildPreviewPackage(
      { snapshot: codec.encodeMessage(synthetic(sha1)), fileName: "F", previewId: "r".repeat(22), now: 5, options: { pageIds: "all", inspect: true, export: true, expiresInDays: null }, readImage: async () => PNG },
      nodeCodecs,
    );
    await uploadPreview(storage, pkg);
    const base = `previews/${"r".repeat(22)}`;
    expect(order).toEqual([`${base}/doc.kiwi`, `${base}/images/${sha1}`, `${base}/manifest.json`]);
    expect(meta.get(`${base}/manifest.json`)).toEqual({ revoked: "false" });
    order.length = 0;
    await uploadPreview(storage, pkg, [sha1]);
    expect(order).toEqual([`${base}/doc.kiwi`, `${base}/manifest.json`]);
    await revokePreview(storage, "r".repeat(22), [sha1]);
    expect(meta.get(`${base}/manifest.json`)).toEqual({ revoked: "true" });
    expect([...storage.objects.keys()]).toEqual([]);
  });

  it("links to the configured viewer origin, else the project's Hosting site", () => {
    const firebase = { apiKey: "k", authDomain: "x", projectId: "proj", storageBucket: "b", appId: "a" };
    expect(previewUrl({ firebase }, "abc")).toBe("https://proj.web.app/p/abc");
    expect(previewUrl({ firebase, viewer: { origin: "https://view.example.com" } }, "abc")).toBe("https://view.example.com/p/abc");
  });
});

describe("previews in the store", () => {
  const stores: TestStore[] = [];
  afterEach(async () => {
    for (const t of stores.splice(0)) {
      await t.close().catch(() => {});
      t.dispose();
    }
  });

  async function storeWith(opts: { config?: boolean } = {}) {
    const dir = tempDir();
    if (opts.config) {
      mkdirSync(join(dir, "firebase"), { recursive: true });
      writeFileSync(join(dir, "firebase", "config.json"), JSON.stringify({ firebase: { apiKey: "k", authDomain: "x", projectId: "proj", storageBucket: "b", appId: "1" } }));
    }
    const template = join(dir, "viewer.html");
    writeFileSync(template, TEMPLATE);
    const t = await openTestStore({ dir, viewerTemplate: template });
    stores.push(t);
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

  it("refuses to publish until Firebase is configured and sync is on; then publishes, updates in place and stops", async () => {
    const plain = await storeWith();
    expect(await plain.t.api.previews.status()).toEqual({ publish: false, reason: "Sharing previews needs Firebase sync, which isn't set up" });
    await expect(plain.t.api.previews.publish(plain.fileKey, { snapshot: plain.snapshot, options: { pageIds: "all", inspect: true, export: true, expiresInDays: null } })).rejects.toMatchObject({ code: "offline" });

    const { t, fileKey, snapshot, sha1 } = await storeWith({ config: true });
    const options = { pageIds: "all" as const, inspect: true, export: true, expiresInDays: 30 as const };
    await expect(t.api.previews.publish(fileKey, { snapshot, options })).rejects.toBeInstanceOf(StoreError);
    const drivers: FirebaseDrivers = { firestore: new MemoryFirestore(), storage: new MemoryStorage(), signIn: async () => ({ uid: "owner" }) };
    const r = await startSync(t.store, { enabled: true, uid: "owner", drivers, intervalMs: 60_000 });
    expect(await t.api.previews.status()).toEqual({ publish: true, reason: null });
    const first = await t.api.previews.publish(fileKey, { snapshot, options });
    expect(first.url).toBe(`https://proj.web.app/p/${first.previewId}`);
    expect(first.blobRefs).toEqual([sha1]);
    const storage = drivers.storage as MemoryStorage;
    expect(storage.objects.has(`previews/${first.previewId}/manifest.json`)).toBe(true);
    const manifest = JSON.parse(new TextDecoder().decode(storage.objects.get(`previews/${first.previewId}/manifest.json`)!));
    expect(manifest.fileName).toBe("Landing page");
    t.clock.advance(1000);
    const second = await t.api.previews.publish(fileKey, { snapshot, options });
    expect(second.previewId).toBe(first.previewId);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(await t.api.previews.list(fileKey)).toHaveLength(1);
    // The blob GC keeps the published images.
    expect((await t.api.store.collectGarbage()).live).toBeGreaterThan(0);
    await t.api.previews.stop(first.previewId);
    expect(await t.api.previews.list()).toEqual([]);
    expect([...storage.objects.keys()].filter((k) => k.startsWith("previews/"))).toEqual([]);
    await r!.stop();
  });

  it("sweeps expired previews off Storage when sync starts", async () => {
    const { t, fileKey, snapshot } = await storeWith({ config: true });
    const drivers: FirebaseDrivers = { firestore: new MemoryFirestore(), storage: new MemoryStorage(), signIn: async () => ({ uid: "owner" }) };
    let r = await startSync(t.store, { enabled: true, uid: "owner", drivers, intervalMs: 60_000 });
    const lasting = await t.api.previews.publish(fileKey, { snapshot, options: { pageIds: "all", inspect: true, export: true, expiresInDays: null } });
    const other = await t.api.workspace.createFile({ name: "Other", folderId: null });
    const brief = await t.api.previews.publish(other.fileKey, { snapshot, options: { pageIds: "all", inspect: true, export: true, expiresInDays: 7 } });
    await r!.stop();
    const storage = drivers.storage as MemoryStorage;
    // Nothing to sweep yet.
    expect(await previewsOf(t.store).sweepExpired()).toEqual([]);
    t.clock.advance(8 * 86400000);
    r = await startSync(t.store, { enabled: true, uid: "owner", drivers, intervalMs: 60_000 });
    await vi.waitFor(async () => expect((await t.api.previews.list()).map((p) => p.previewId)).toEqual([lasting.previewId]));
    expect([...storage.objects.keys()].some((k) => k.startsWith(`previews/${brief.previewId}/`))).toBe(false);
    expect(storage.objects.has(`previews/${lasting.previewId}/manifest.json`)).toBe(true);
    await r!.stop();
  });
});
