/**
 * Home's File settings (docs/home.md "File settings [ours]"): `files.details` reads one file's bytes on this computer by
 * kind (document, images, videos and sounds, versions, thumbnail), its versions and the editing sessions its journal
 * still holds — from disk, without loading the file.
 */
import { afterEach, describe, expect, it } from "vitest";
import { blobKind, fileDetailsOf, filterActivity, mergeActivity, type FileActivityEvent } from "../shared/store/fileSettings";
import { batch, openTestStore, rect, type TestStore } from "./testing/harness";

let t: TestStore | null = null;
afterEach(async () => {
  await t?.close();
  t?.dispose();
  t = null;
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 1, 2, 3, 4, 5, 6, 7, 8]);

describe("files.details", () => {
  it("splits the file's bytes by kind and lists its versions and editing sessions", async () => {
    t = await openTestStore();
    const { workspace, files, blobs } = t.api;
    const f = await workspace.createFile({ name: "Landing", folderId: null });
    const png = await blobs.put(PNG);
    const mp4 = await blobs.put(MP4);
    const o = await files.open(f.fileKey, { mode: "edit" });
    const s = o.sessionID;
    const hash = (hex: string) => new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
    const filled = (id: number, pos: string, sha1: string) => rect(s, id, pos, { fillPaints: [{ type: "IMAGE", image: { hash: hash(sha1) } }] });
    await files.append(f.fileKey, batch(s, 1, [filled(1, "!", png.sha1), filled(3, "#", mp4.sha1)], { blobRefsAdded: [png.sha1, mp4.sha1] }));
    await files.append(f.fileKey, batch(s, 2, [rect(s, 2, "\"")]));
    await files.flush(f.fileKey);
    // The journal's frames since the last compaction, one entry for the session
    const before = await files.details(f.fileKey);
    expect(before.activity.find((e) => e.action === "session")).toMatchObject({ kind: "edited", count: 2, source: "local" });
    expect(before.lastEditAt).not.toBeNull();
    await files.close(f.fileKey, s);
    // Closed, read again from disk: the same
    expect((await files.details(f.fileKey)).activity.find((e) => e.action === "session")?.count).toBe(2);

    t.clock.advance(60_000);
    await files.createVersion(f.fileKey, { title: "Hand-off" });
    const d = await files.details(f.fileKey);
    const by = Object.fromEntries(d.storage.map((p) => [p.kind, p]));
    expect(d.documentHere).toBe(true);
    expect(by.document.bytes).toBeGreaterThan(0);
    expect(by.images).toEqual({ kind: "images", bytes: PNG.length, count: 1 });
    expect(by.media).toEqual({ kind: "media", bytes: MP4.length, count: 1 });
    expect(by.versions.count).toBe(1);
    expect(d.totalBytes).toBe(d.storage.reduce((n, p) => n + p.bytes, 0));
    expect(d.versions).toMatchObject({ total: 1, named: 1, autosaves: 0 });
    expect(d.missingImages).toBe(0);
    expect(d.activity.find((e) => e.action === "named")?.detail).toBe("Hand-off");
    expect(d.activity.at(-1)?.kind).toBe("created");
  });
});

describe("fileSettings helpers", () => {
  const ev = (id: string, at: number, kind: FileActivityEvent["kind"], source: FileActivityEvent["source"], actor: string | null = null): FileActivityEvent => ({ id, at, kind, action: kind, actor, detail: null, source });

  it("merges the local and the server log, the same event once", () => {
    const merged = mergeActivity([ev("l:1", 5000, "version", "local"), ev("l:2", 1000, "edited", "local")], [ev("s:1", 5200, "version", "server", "Ada"), ev("s:2", 3000, "comment", "server")]);
    expect(merged.map((e) => e.id)).toEqual(["s:1", "s:2", "l:2"]);
  });

  it("filters by group and text", () => {
    const all = [ev("a", 3, "comment", "server", "Ada"), ev("b", 2, "access", "server", "Alan"), ev("c", 1, "opened", "server", "Ada")];
    expect(filterActivity(all, "sharing").map((e) => e.id)).toEqual(["b"]);
    expect(filterActivity(all, "all", "ada").map((e) => e.id)).toEqual(["a", "c"]);
  });

  it("tells images from videos and sounds", () => {
    expect(blobKind(PNG)).toBe("image");
    expect(blobKind(MP4)).toBe("media");
    expect(blobKind(new TextEncoder().encode("OggS\0\0\0\0\0\0\0\0"))).toBe("media");
    expect(blobKind(new TextEncoder().encode("<svg xmlns"))).toBe("image");
    expect(blobKind(new Uint8Array([1, 2, 3, 4]))).toBe("other");
  });

  it("counts what isn't here yet", () => {
    const d = fileDetailsOf({
      meta: { fileKey: "k", createdAt: 1, importedFrom: null } as never,
      documentHere: true,
      disk: { document: 10, versions: 0, thumbnail: 5, frames: [] },
      versions: [],
      blobs: [null, { size: 3, kind: "image" }],
      previews: { count: 0, at: [], bytes: 0 },
    });
    expect(d.missingImages).toBe(1);
    expect(d.totalBytes).toBe(18);
  });
});
