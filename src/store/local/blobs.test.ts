import { createHash } from "node:crypto";
import { existsSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { batch, openTestStore, rect, type TestStore } from "../testing/harness";

let t: TestStore | null = null;
afterEach(async () => {
  await t?.close().catch(() => {});
  t?.dispose();
  t = null;
});

const PNG = new Uint8Array(readFileSync(join(__dirname, "../../../build/icon.png")));
const sha1 = (b: Uint8Array) => createHash("sha1").update(b).digest("hex");
const old = (t: TestStore, s: string) => {
  const p = join(t.dir, "Workspace", "blobs", s.slice(0, 2), s);
  const when = new Date(t.clock.now() - 2 * 24 * 60 * 60 * 1000);
  utimesSync(p, when, when);
  return p;
};

describe("blob store (docs/data.md §10)", () => {
  it("stores by SHA-1, idempotently, and sniffs the MIME type", async () => {
    t = await openTestStore();
    const { blobs } = t.api;
    const r = await blobs.put(PNG);
    expect(r).toEqual({ sha1: sha1(PNG), size: PNG.length, mime: "image/png" });
    expect(await blobs.put(PNG)).toEqual(r);
    expect(existsSync(join(t.dir, "Workspace", "blobs", r.sha1.slice(0, 2), r.sha1))).toBe(true);
    expect(await blobs.has([r.sha1, "0".repeat(40), "nope"])).toEqual([true, false, false]);
    expect(await blobs.get(r.sha1)).toEqual(PNG);
    await expect(blobs.get("0".repeat(40))).rejects.toMatchObject({ code: "not-found" });
    expect((await blobs.put(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).mime).toBe("image/jpeg");
    expect((await blobs.put(new Uint8Array([1, 2, 3]), { mime: "image/webp" })).mime).toBe("image/webp");
    expect(blobs.url(r.sha1)).toBe(`app://designer/_blob/${r.sha1}`);
  });

  it("collects garbage by mark and sweep, with a 24 h grace for fresh puts", async () => {
    t = await openTestStore();
    const { workspace, files, blobs } = t.api;
    const used = await blobs.put(PNG);
    const unused = await blobs.put(new Uint8Array([7, 7, 7]));
    const fresh = await blobs.put(new Uint8Array([8, 8, 8]));
    const pUsed = old(t, used.sha1);
    const pUnused = old(t, unused.sha1);
    const f = await workspace.createFile({ folderId: null });
    const o = await files.open(f.fileKey, { mode: "edit" });
    const hash = Uint8Array.from(Buffer.from(used.sha1, "hex"));
    await files.append(f.fileKey, batch(o.sessionID, 1, [rect(o.sessionID, 1, "!", { fillPaints: [{ type: "IMAGE", image: { hash } }] })], { blobRefsAdded: [used.sha1] }));
    await files.flush(f.fileKey);
    const r = await t.api.store.collectGarbage();
    expect(r.deleted).toBe(1);
    expect(existsSync(pUsed)).toBe(true);
    expect(existsSync(pUnused)).toBe(false);
    expect(await blobs.has([fresh.sha1])).toEqual([true]);
    // A file in Trash still holds its images; deleting it forever releases them.
    await workspace.trash({ files: [f.fileKey] });
    expect((await t.api.store.collectGarbage()).deleted).toBe(0);
    await files.close(f.fileKey, o.sessionID);
    await workspace.deleteForever({ files: [f.fileKey] });
    await t.idle();
    expect((await t.api.store.collectGarbage()).deleted).toBe(1);
    expect(existsSync(pUsed)).toBe(false);
  });
});
