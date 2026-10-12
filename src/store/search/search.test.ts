/**
 * The visual search index (docs/ai.md §6): the file format (half floats, thumbnails, refusals), the ranking (cosine,
 * 0.6·clip + 0.4·text, exact names first, sort by last modified, filters), versions and incremental updates, removed
 * nodes and deleted files — on a memory host, then through LocalStore (Workspace/spaces/search). The browser's dev
 * store: src/renderer/src/store/memory/search.test.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SearchDoc, SearchKind } from "../../shared/ai/types";
import { StoreError } from "../../shared/store/protocol";
import type { FileMeta } from "../../shared/store/types";
import { openTestStore, type TestStore } from "../testing/harness";
import { CLIP_DIM, TEXT_DIM, decodeIndex, dot, encodeIndex, fromHalf, normalize, toHalf, type FileIndex } from "./format";
import { MIN_SCORE, nameMatch, rank } from "./rank";
import { SearchService, type SearchStoreHost } from "./service";

// ---- helpers ----

/** A unit vector pointing mostly along axis `i` (with a little of `j`, so vectors aren't all orthogonal). */
function axis(dim: number, i: number, mix = 0, j = (i + 1) % dim): Float32Array {
  const v = new Float32Array(dim);
  v[i] = 1;
  v[j] += mix;
  return normalize(v);
}

let seq = 0;
function doc(fileKey: string, nodeId: string, name: string, extra: Partial<SearchDoc> = {}): SearchDoc {
  return { fileKey, fileName: `File ${fileKey}`, nodeId, kind: "frame" as SearchKind, name, pageId: "0:1", pageName: "Page 1", version: "v1", text: "", width: 100, height: 80, modifiedAt: ++seq, ...extra };
}

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n, n + 1, n + 2]);

function memoryHost(files: Record<string, Partial<FileMeta>>) {
  const disk = new Map<string, Uint8Array>();
  const host: SearchStoreHost = {
    read: async (name) => disk.get(name) ?? null,
    write: async (name, bytes) => void disk.set(name, bytes.slice()),
    remove: async (name) => void disk.delete(name),
    list: async () => [...disk.keys()],
    getMeta: (k) => (files[k] ? ({ fileKey: k, name: `File ${k}`, trashedAt: null, ...files[k] } as FileMeta) : null),
    log: () => undefined,
  };
  return { host, disk, files };
}

// ---- format ----

describe("the index format", () => {
  it("round-trips half floats within half precision, with the special values", () => {
    for (const x of [0, 1, -1, 0.5, 0.1, -0.333, 65504, 6.1e-5, 1e-7, 3.14159]) {
      const back = fromHalf(toHalf(x));
      expect(Math.abs(back - x)).toBeLessThanOrEqual(Math.max(Math.abs(x) * 0.001, 6e-8));
    }
    expect(fromHalf(toHalf(1e6))).toBe(Infinity);
    expect(fromHalf(toHalf(-1e6))).toBe(-Infinity);
    expect(Number.isNaN(fromHalf(toHalf(NaN)))).toBe(true);
    expect(toHalf(1)).toBe(0x3c00);
    expect(toHalf(-2)).toBe(0xc000);
  });

  it("writes docs, unit vectors as Float16 and thumbnails, and reads them back", () => {
    const index: FileIndex = { fileKey: "abc", dims: { clip: CLIP_DIM, text: TEXT_DIM }, entries: new Map() };
    const a = { doc: doc("abc", "1:2", "Login"), clip: axis(CLIP_DIM, 3, 0.4), text: axis(TEXT_DIM, 7), thumb: png(1) };
    const b = { doc: doc("abc", "1:9", "Settings", { kind: "component", text: "Wi‑Fi · Bluetooth" }), clip: axis(CLIP_DIM, 10), text: axis(TEXT_DIM, 20, 0.2), thumb: png(40) };
    index.entries.set(a.doc.nodeId, a);
    index.entries.set(b.doc.nodeId, b);
    const bytes = encodeIndex(index);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("DVSI");
    // Header + 2 × (512 + 384) half floats + the two thumbnails
    expect(bytes.length).toBeGreaterThan(2 * (CLIP_DIM + TEXT_DIM) * 2 + 14);
    expect(bytes.length).toBeLessThan(2 * (CLIP_DIM + TEXT_DIM) * 4);
    const back = decodeIndex(bytes)!;
    expect(back.fileKey).toBe("abc");
    expect([...back.entries.keys()]).toEqual(["1:2", "1:9"]);
    expect(back.entries.get("1:9")!.doc).toEqual(b.doc);
    expect([...back.entries.get("1:9")!.thumb]).toEqual([...b.thumb]);
    expect(dot(back.entries.get("1:2")!.clip, a.clip)).toBeCloseTo(1, 3);
    expect(dot(back.entries.get("1:9")!.text, b.text)).toBeCloseTo(1, 3);
  });

  it("refuses what isn't an index of this format", () => {
    expect(decodeIndex(new Uint8Array([1, 2, 3]))).toBeNull();
    const index: FileIndex = { fileKey: "abc", dims: { clip: CLIP_DIM, text: TEXT_DIM }, entries: new Map([["1:2", { doc: doc("abc", "1:2", "A"), clip: axis(CLIP_DIM, 1), text: axis(TEXT_DIM, 1), thumb: png(1) }]]) };
    const bytes = encodeIndex(index);
    const other = bytes.slice();
    other[4] = 9; // format 9
    expect(decodeIndex(other)).toBeNull();
    expect(decodeIndex(bytes.subarray(0, bytes.length - 3))).toBeNull(); // cut short
  });
});

// ---- ranking ----

describe("ranking (cosine, exact names first)", () => {
  const entries = [
    { doc: doc("f", "1", "Card"), clip: axis(CLIP_DIM, 0), text: axis(TEXT_DIM, 0), thumb: png(0) },
    { doc: doc("f", "2", "Checkout"), clip: axis(CLIP_DIM, 0, 0.3), text: axis(TEXT_DIM, 5), thumb: png(0) },
    { doc: doc("f", "3", "Button/Primary", { kind: "component" }), clip: axis(CLIP_DIM, 50), text: axis(TEXT_DIM, 50), thumb: png(0) },
    { doc: doc("g", "4", "Primary actions"), clip: axis(CLIP_DIM, 60), text: axis(TEXT_DIM, 60), thumb: png(0) },
    { doc: doc("g", "5", "Profile"), clip: axis(CLIP_DIM, 0, 1.5), text: axis(TEXT_DIM, 0, 1.5), thumb: png(0) },
  ];

  it("matches names: the whole name or its last part, then every word", () => {
    expect(nameMatch("Button/Primary", "primary")).toBe(2);
    expect(nameMatch("Card", " CARD ")).toBe(2);
    expect(nameMatch("Primary actions", "primary")).toBe(1);
    expect(nameMatch("Primary actions", "actions primary")).toBe(1);
    expect(nameMatch("Card", "cart")).toBe(0);
    expect(nameMatch("Card", "")).toBe(0);
  });

  it("orders by 0.6·clip + 0.4·text", () => {
    const hits = rank(entries, { clip: axis(CLIP_DIM, 0), textVec: axis(TEXT_DIM, 0), sort: "relevance" });
    expect(hits.map((h) => h.doc.nodeId)).toEqual(["1", "2", "5"]);
    expect(hits[0].score).toBeCloseTo(1, 5);
    // Checkout: clip cos(0, 0+0.3·1) = 1/√1.09, text 0
    expect(hits[1].score).toBeCloseTo(0.6 / Math.sqrt(1.09), 5);
    expect(hits.every((h) => !h.exact)).toBe(true);
  });

  it("an image query ranks by CLIP alone; scores under the floor are left out", () => {
    const hits = rank(entries, { clip: axis(CLIP_DIM, 50), sort: "relevance" });
    expect(hits.map((h) => h.doc.nodeId)).toEqual(["3"]);
    expect(hits[0].score).toBeCloseTo(1, 5);
    expect(rank(entries, { clip: axis(CLIP_DIM, 200), sort: "relevance" })).toEqual([]);
    expect(MIN_SCORE).toBeGreaterThan(0);
  });

  it("puts exact name matches first, the whole name before its words, whatever the vectors say", () => {
    // The vectors point at Card; the text names Primary.
    const hits = rank(entries, { text: "primary", clip: axis(CLIP_DIM, 0), textVec: axis(TEXT_DIM, 0), sort: "relevance" });
    expect(hits.map((h) => [h.doc.nodeId, h.exact])).toEqual([
      ["3", true],
      ["4", true],
      ["1", false],
      ["2", false],
      ["5", false],
    ]);
  });

  it("without vectors (no models yet) a text query is the keyword search", () => {
    expect(rank(entries, { text: "card", sort: "relevance" }).map((h) => h.doc.nodeId)).toEqual(["1"]);
    expect(rank(entries, { text: "nothing like it", sort: "relevance" })).toEqual([]);
  });

  it("sorts by last modified, filters by kind, file and library, and limits", () => {
    const q = { clip: axis(CLIP_DIM, 0), textVec: axis(TEXT_DIM, 0) };
    expect(rank(entries, { ...q, sort: "modified" }).map((h) => h.doc.nodeId)).toEqual(["5", "2", "1"]);
    expect(rank(entries, { ...q, sort: "relevance", limit: 1 }).map((h) => h.doc.nodeId)).toEqual(["1"]);
    expect(rank(entries, { text: "primary", sort: "relevance", kinds: ["component", "componentSet"] }).map((h) => h.doc.nodeId)).toEqual(["3"]);
    expect(rank(entries, { ...q, sort: "relevance", fileKey: "g" }).map((h) => h.doc.nodeId)).toEqual(["5"]);
    // A library's components only, never its frames
    expect(rank(entries, { text: "primary", sort: "relevance", libraryKey: "f" }).map((h) => h.doc.nodeId)).toEqual(["3"]);
  });
});

// ---- the service ----

describe("the store's search repository", () => {
  const vectors = (i: number) => ({ clip: axis(CLIP_DIM, i), text: axis(TEXT_DIM, i) });

  it("keeps versions per node, updates incrementally and writes one index per file", async () => {
    const { host, disk } = memoryHost({ f1: {}, f2: {} });
    const repo = new SearchService(host).repository();
    expect(await repo.versions("f1")).toEqual({});
    await repo.upsert([
      { doc: doc("f1", "1:1", "Home"), vectors: vectors(1), thumb: png(1) },
      { doc: doc("f1", "1:2", "Profile"), vectors: vectors(2), thumb: png(2) },
      { doc: doc("f2", "5:1", "Checkout"), vectors: vectors(3), thumb: png(3) },
    ]);
    expect([...disk.keys()].sort()).toEqual(["f1.idx", "f2.idx"]);
    expect(await repo.versions("f1")).toEqual({ "1:1": "v1", "1:2": "v1" });
    // One node changed: only it is sent again, with its new version
    await repo.upsert([{ doc: doc("f1", "1:2", "Profile page", { version: "v2" }), vectors: vectors(9), thumb: png(9) }]);
    expect(await repo.versions("f1")).toEqual({ "1:1": "v1", "1:2": "v2" });
    expect([...(await repo.thumb("f1", "1:2"))!]).toEqual([...png(9)]);
    expect(await repo.thumb("f1", "7:7")).toBeNull();
    // A new service reads the same files back (a store restart)
    const again = new SearchService(host).repository();
    expect(await again.versions("f1")).toEqual({ "1:1": "v1", "1:2": "v2" });
    const hits = await again.query({ clip: vectors(9).clip, sort: "relevance" });
    expect(hits[0].doc).toMatchObject({ nodeId: "1:2", name: "Profile page" });
    expect(await again.stats()).toMatchObject({ files: 2, docs: 3 });
  });

  it("removes nodes that are gone, and a whole file", async () => {
    const { host, disk } = memoryHost({ f1: {} });
    const repo = new SearchService(host).repository();
    await repo.upsert([
      { doc: doc("f1", "1:1", "A"), vectors: vectors(1), thumb: png(1) },
      { doc: doc("f1", "1:2", "B"), vectors: vectors(2), thumb: png(2) },
    ]);
    await repo.remove("f1", ["1:1", "9:9"]);
    expect(Object.keys(await repo.versions("f1"))).toEqual(["1:2"]);
    await repo.remove("f1", ["1:2"]);
    expect(disk.has("f1.idx")).toBe(false); // the last node gone: no file
    await repo.upsert([{ doc: doc("f1", "1:3", "C"), vectors: vectors(3), thumb: png(3) }]);
    await repo.remove("f1");
    expect(disk.size).toBe(0);
    expect(await repo.versions("f1")).toEqual({});
  });

  it("drops a deleted file's index, leaves trashed files out of results, and uses a renamed file's name", async () => {
    const { host, disk, files } = memoryHost({ keep: {}, bin: {}, gone: {} });
    const service = new SearchService(host);
    const repo = service.repository();
    await repo.upsert([
      { doc: doc("keep", "1:1", "Card"), vectors: vectors(1), thumb: png(1) },
      { doc: doc("bin", "1:1", "Card"), vectors: vectors(1), thumb: png(1) },
      { doc: doc("gone", "1:1", "Card"), vectors: vectors(1), thumb: png(1) },
    ]);
    files.bin.trashedAt = 1;
    files.keep.name = "Renamed";
    delete files.gone; // deleted elsewhere
    const hits = await repo.query({ text: "card", sort: "relevance" });
    expect(hits.map((h) => [h.doc.fileKey, h.doc.fileName])).toEqual([["keep", "Renamed"]]);
    await new Promise((r) => setTimeout(r, 0));
    expect(disk.has("gone.idx")).toBe(false);
    expect(disk.has("bin.idx")).toBe(true); // a restore brings it back
    await service.fileDeleted("bin");
    expect(disk.has("bin.idx")).toBe(false);
  });

  it("starts an index of another version again, and checks what it is given", async () => {
    const { host, disk } = memoryHost({ f1: {} });
    disk.set("f1.idx", new Uint8Array([68, 86, 83, 73, 99, 0, 0, 0]));
    const repo = new SearchService(host).repository();
    expect(await repo.versions("f1")).toEqual({});
    expect(disk.has("f1.idx")).toBe(false);
    await expect(repo.upsert([{ doc: doc("f1", "1:1", "A"), vectors: { clip: new Float32Array(3), text: vectors(1).text }, thumb: png(1) }])).rejects.toBeInstanceOf(StoreError);
    await expect(repo.upsert([{ doc: doc("nofile", "1:1", "A"), vectors: vectors(1), thumb: png(1) }])).rejects.toMatchObject({ code: "not-found" });
    await expect(repo.upsert([{ doc: { ...doc("f1", "1:1", "A"), kind: "text" as SearchKind }, vectors: vectors(1), thumb: png(1) }])).rejects.toBeInstanceOf(StoreError);
    await expect(repo.query({ clip: new Float32Array(10), sort: "relevance" })).rejects.toBeInstanceOf(StoreError);
    await expect(repo.versions("../etc")).rejects.toBeInstanceOf(StoreError);
    // The text is cut to 2,000 characters
    await repo.upsert([{ doc: doc("f1", "1:1", "A", { text: "x".repeat(5000) }), vectors: vectors(1), thumb: png(1) }]);
    expect((await repo.query({ text: "a", sort: "relevance" }))[0].doc.text.length).toBe(2000);
    await repo.clear();
    expect(disk.size).toBe(0);
  });
});

// ---- through the stores ----

const opened: TestStore[] = [];
afterEach(async () => {
  for (const s of opened.splice(0)) {
    await s.close().catch(() => undefined);
    s.dispose();
  }
});

describe("LocalStore's search (Workspace/spaces/search)", () => {
  it("writes <fileKey>.idx, reads it after a restart, and drops it when the file is deleted forever", async () => {
    const s = await openTestStore();
    opened.push(s);
    const f = await s.api.workspace.createFile({ name: "Screens", folderId: null });
    await s.api.search.upsert([{ doc: doc(f.fileKey, "1:1", "Sign in", { fileName: "Screens" }), vectors: { clip: axis(CLIP_DIM, 4), text: axis(TEXT_DIM, 4) }, thumb: png(5) }]);
    const path = join(s.dir, "Workspace", "spaces", "search", `${f.fileKey}.idx`);
    expect(existsSync(path)).toBe(true);
    expect(decodeIndex(new Uint8Array(readFileSync(path)))!.entries.get("1:1")!.doc.name).toBe("Sign in");
    await s.close();
    const again = await s.reopen();
    opened.push(again);
    expect(await again.api.search.versions(f.fileKey)).toEqual({ "1:1": "v1" });
    // Trash hides it, Delete forever drops it
    await again.api.workspace.trash({ files: [f.fileKey] });
    expect(await again.api.search.query({ text: "sign in", sort: "relevance" })).toEqual([]);
    await again.api.workspace.deleteForever({ files: [f.fileKey] });
    expect(existsSync(path)).toBe(false);
  });
});
