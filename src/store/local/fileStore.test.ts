import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage } from "../../shared/schema/codec";
import { sessionIdFor } from "../../shared/schema/guid";
import { NodeTable, tablesEqual } from "../../shared/schema/patch";
import type { FileChange, OpenedFile } from "../../shared/store/repositories";
import { batch, openTestStore, rect, settle, type TestStore } from "../testing/harness";
import { COMPACT_SEGMENT_FRAMES } from "./fileStore";
import { CHECKPOINT_INTERVAL_MS } from "./versions";

let t: TestStore | null = null;
afterEach(async () => {
  await t?.close().catch(() => {});
  t?.dispose();
  t = null;
});

/** What the engine would show: the snapshot with every journal frame applied. */
function tableOf(o: OpenedFile): NodeTable {
  const table = NodeTable.fromMessage(decodeMessage(o.snapshot));
  for (const f of o.journal) table.apply(decodeMessage(f.message));
  return table;
}

const fileDir = (t: TestStore, key: string) => join(t.dir, "Workspace", "files", key);

describe("sessions and the write path (docs/data.md §5.4, §5.6)", () => {
  it("allocates (deviceOrdinal << 20) | n per edit open, locks, dedupes resends, replays on reopen", async () => {
    t = await openTestStore();
    const { workspace, files } = t.api;
    const f = await workspace.createFile({ folderId: null });
    const o = await files.open(f.fileKey, { mode: "edit", tabId: "tab-1" });
    expect(o.sessionID).toBe(sessionIdFor(1, 1));
    expect(o.snapshotSeq).toBe(0);
    expect(o.headSeq).toBe(0);
    expect(decodeMessage(o.snapshot).nodeChanges!.map((n) => n.name)).toEqual(["Document", "Page 1", "Internal Only Canvas"]);
    await expect(files.open(f.fileKey, { mode: "edit" })).rejects.toMatchObject({ code: "already-open", detail: { tabId: "tab-1" } });
    const view = await files.open(f.fileKey, { mode: "view" });
    expect(view.sessionID).toBe(0);

    const s = o.sessionID;
    const a1 = await files.append(f.fileKey, batch(s, 1, [rect(s, 1, "!")]));
    const a2 = await files.append(f.fileKey, batch(s, 2, [{ guid: { sessionID: s, localID: 1 }, name: "Renamed" }], { kind: "edit", label: "Rename" }));
    expect([a1.seq, a2.seq]).toEqual([1, 2]);
    expect(a2.hlc > a1.hlc).toBe(true);
    expect(await files.append(f.fileKey, batch(s, 2, [{ guid: { sessionID: s, localID: 1 }, name: "Ignored" }]))).toEqual(a2); // resend
    await expect(files.append(f.fileKey, batch(s + 1, 1, []))).rejects.toMatchObject({ code: "read-only" });
    const other = t.store.api({}); // another port
    await expect(other.files.append(f.fileKey, batch(s, 3, []))).rejects.toMatchObject({ code: "forbidden" });
    await files.flush(f.fileKey);
    await files.close(f.fileKey, s);

    const again = await files.open(f.fileKey, { mode: "edit" });
    expect(again.sessionID).toBe(sessionIdFor(1, 2));
    expect(again.headSeq).toBe(2);
    expect(again.journal.map((j) => [j.seq, j.kind])).toEqual([
      [1, "edit"],
      [2, "edit"],
    ]);
    expect(tableOf(again).get({ sessionID: s, localID: 1 })!.name).toBe("Renamed");
  });

  it("broadcasts changes to subscribers with catch-up, and fsyncs within a second", async () => {
    t = await openTestStore();
    const { workspace, files } = t.api;
    const f = await workspace.createFile({ folderId: null });
    const o = await files.open(f.fileKey, { mode: "edit" });
    const s = o.sessionID;
    await files.append(f.fileKey, batch(s, 1, [rect(s, 1, "!")]));
    const seen: FileChange[] = [];
    const off = files.subscribe(f.fileKey, 0, (c) => seen.push(c));
    await settle();
    await files.append(f.fileKey, batch(s, 2, [rect(s, 2, '"')]));
    await settle();
    expect(seen.map((c) => c.seq)).toEqual([1, 2]);
    off();
    await files.append(f.fileKey, batch(s, 3, [rect(s, 3, "#")]));
    expect(seen).toHaveLength(2);
    expect(t.timers.size).toBeGreaterThan(0); // the 1 s fdatasync and the 5 s updatedAt
    const before = (await workspace.getFile(f.fileKey)).updatedAt;
    t.clock.advance(10);
    await t.timers.advance(6000);
    expect((await workspace.getFile(f.fileKey)).updatedAt).toBeGreaterThan(before);
  });

  it("recovers from a torn tail: truncates at the last good frame and keeps appending after it", async () => {
    t = await openTestStore();
    const f = await t.api.workspace.createFile({ folderId: null });
    const o = await t.api.files.open(f.fileKey, { mode: "edit" });
    const s = o.sessionID;
    for (let i = 1; i <= 5; i++) await t.api.files.append(f.fileKey, batch(s, i, [rect(s, i, String.fromCharCode(33 + i))]));
    await t.api.files.flush(f.fileKey);
    t.crash();
    const seg = join(fileDir(t, f.fileKey), "journal-000000000001.log");
    const size = readFileSync(seg).length;
    truncateSync(seg, size - 7); // power loss in the middle of frame 5
    appendFileSync(seg, new Uint8Array([1, 2, 3]));
    t = await t.reopen();
    const r = await t.api.files.open(f.fileKey, { mode: "edit" });
    expect(r.recovery).toMatchObject({ droppedFrames: 0, fellBackTo: null });
    expect(r.recovery!.truncatedBytes).toBeGreaterThan(0);
    expect(r.headSeq).toBe(4);
    expect(tableOf(r).size).toBe(3 + 4);
    // The client resends batch 5 after reattaching; the store accepts it as the next seq.
    const ack = await t.api.files.append(f.fileKey, batch(r.sessionID, 1, [rect(s, 5, "&")]));
    expect(ack.seq).toBe(5);
  });

  it("falls back to the previous snapshot generation when the head snapshot is damaged", async () => {
    t = await openTestStore();
    const f = await t.api.workspace.createFile({ folderId: null });
    const o = await t.api.files.open(f.fileKey, { mode: "edit" });
    const s = o.sessionID;
    for (let i = 1; i <= 3; i++) await t.api.files.append(f.fileKey, batch(s, i, [rect(s, i, String.fromCharCode(33 + i))]));
    expect(await t.store.files.compact(f.fileKey)).toBe(true);
    await t.api.files.append(f.fileKey, batch(s, 4, [rect(s, 4, "%")]));
    const expected = tableOf(await t.api.files.open(f.fileKey, { mode: "view" }));
    await t.api.files.flush(f.fileKey);
    t.crash();
    const dir = fileDir(t, f.fileKey);
    const head = join(dir, "snapshot-000000000003.kiwi");
    const bytes = readFileSync(head);
    bytes[bytes.length - 3] ^= 0x55; // bit rot in the zstd data (its checksum catches it)
    writeFileSync(head, bytes);
    t = await t.reopen();
    const r = await t.api.files.open(f.fileKey, { mode: "edit" });
    expect(r.recovery?.fellBackTo).toBe("previous-snapshot");
    expect(r.snapshotSeq).toBe(0);
    expect(r.headSeq).toBe(4);
    expect(tablesEqual(tableOf(r), expected)).toBe(true);
    expect(readdirSync(dir).some((n) => n.startsWith("snapshot-000000000003.kiwi.damaged-"))).toBe(true);
  });

  it("recovers from the newest version when no snapshot generation decodes, and refuses when nothing does", async () => {
    t = await openTestStore();
    const f = await t.api.workspace.createFile({ folderId: null });
    const o = await t.api.files.open(f.fileKey, { mode: "edit" });
    await t.api.files.append(f.fileKey, batch(o.sessionID, 1, [rect(o.sessionID, 1, "!")]));
    const v = await t.api.files.createVersion(f.fileKey, { title: "Good" });
    await t.api.files.append(f.fileKey, batch(o.sessionID, 2, [rect(o.sessionID, 2, '"')]));
    await t.api.files.close(f.fileKey, o.sessionID);
    await t.close();
    const dir = fileDir(t, f.fileKey);
    // Replace (not overwrite: versions are hard links of the same inode) every snapshot with garbage.
    for (const n of readdirSync(dir).filter((n) => n.startsWith("snapshot-"))) {
      rmSync(join(dir, n));
      writeFileSync(join(dir, n), "garbage");
    }
    t = await t.reopen();
    const r = await t.api.files.open(f.fileKey, { mode: "edit" });
    expect(r.recovery?.fellBackTo).toBe("version");
    expect(r.headSeq).toBeGreaterThanOrEqual(v.seq); // seqs stay unique: the restored snapshot takes the highest seq written
    expect(tableOf(r).get({ sessionID: o.sessionID, localID: 1 })).toBeDefined();
    await t.api.files.close(f.fileKey, r.sessionID);
    await t.close();

    for (const n of readdirSync(dir).filter((n) => n.startsWith("snapshot-"))) {
      rmSync(join(dir, n));
      writeFileSync(join(dir, n), "garbage");
    }
    for (const n of readdirSync(join(dir, "versions")).filter((n) => n.endsWith(".kiwi"))) {
      rmSync(join(dir, "versions", n));
      writeFileSync(join(dir, "versions", n), "garbage");
    }
    t = await t.reopen();
    await expect(t.api.files.open(f.fileKey, { mode: "edit" })).rejects.toMatchObject({ code: "corrupt" });
    await expect(t.api.files.open(f.fileKey, { mode: "view" })).rejects.toMatchObject({ code: "corrupt" });
    // Nothing that could not be read was overwritten.
    expect(readdirSync(dir).filter((n) => n.startsWith("snapshot-")).every((n) => readFileSync(join(dir, n), "utf8") === "garbage")).toBe(true);
  });
});

describe("compaction (docs/data.md §5.5)", () => {
  it("merges snapshot + frames into a new snapshot, keeps one previous generation, and drops the one before", async () => {
    t = await openTestStore();
    const f = await t.api.workspace.createFile({ folderId: null });
    const o = await t.api.files.open(f.fileKey, { mode: "edit" });
    const s = o.sessionID;
    const hash = new Uint8Array(20).fill(0xcd);
    await t.api.files.append(f.fileKey, batch(s, 1, [rect(s, 1, "!", { fillPaints: [{ type: "IMAGE", image: { hash } }] })], { blobRefsAdded: ["cd".repeat(20)] }));
    await t.api.files.append(f.fileKey, batch(s, 2, [rect(s, 2, '"', { type: "VECTOR", vectorData: { vectorNetworkBlob: 0 } })], { blobs: [new Uint8Array([1, 2, 3, 4])] }));
    await t.api.files.append(f.fileKey, batch(s, 3, [{ guid: { sessionID: s, localID: 1 }, phase: "REMOVED" }]));
    const before = tableOf(await t.api.files.open(f.fileKey, { mode: "view" }));
    expect(await t.store.files.compact(f.fileKey)).toBe(true);
    const dir = fileDir(t, f.fileKey);
    const state = JSON.parse(readFileSync(join(dir, "store.json"), "utf8"));
    expect(state.head).toMatchObject({ snapshot: "snapshot-000000000003.kiwi", snapshotSeq: 3, segments: [], previous: { snapshot: "snapshot-000000000000.kiwi", segments: ["journal-000000000001.log"] } });
    expect(state.blobRefs).toEqual([]); // exact again: the image's node was removed
    const after = await t.api.files.open(f.fileKey, { mode: "view" });
    expect(after.journal).toEqual([]);
    expect(tablesEqual(tableOf(after), before)).toBe(true);
    expect(decodeMessage(after.snapshot).blobs!.map((b) => [...b.bytes])).toEqual([[1, 2, 3, 4]]);

    await t.api.files.append(f.fileKey, batch(s, 4, [rect(s, 5, "#")]));
    expect(await t.store.files.compact(f.fileKey)).toBe(true);
    const names = readdirSync(dir).filter((n) => n.startsWith("snapshot-") || n.startsWith("journal-"));
    expect(names.sort()).toEqual(["journal-000000000004.log", "snapshot-000000000003.kiwi", "snapshot-000000000004.kiwi"]);
    expect(await t.store.files.compact(f.fileKey)).toBe(false); // nothing new
  });

  it("compacts by itself past 5,000 frames and keeps appending into a new segment", async () => {
    t = await openTestStore();
    const f = await t.api.workspace.createFile({ folderId: null });
    const o = await t.api.files.open(f.fileKey, { mode: "edit" });
    const s = o.sessionID;
    await t.api.files.append(f.fileKey, batch(s, 1, [rect(s, 1, "!")]));
    for (let i = 2; i <= COMPACT_SEGMENT_FRAMES + 2; i++) await t.api.files.append(f.fileKey, batch(s, i, [{ guid: { sessionID: s, localID: 1 }, opacity: (i % 100) / 100 }]));
    await t.idle();
    const state = JSON.parse(readFileSync(join(fileDir(t, f.fileKey), "store.json"), "utf8"));
    expect(state.head.snapshotSeq).toBeGreaterThan(COMPACT_SEGMENT_FRAMES);
    const r = await t.api.files.open(f.fileKey, { mode: "view" });
    expect(r.headSeq).toBe(COMPACT_SEGMENT_FRAMES + 2);
    expect(tableOf(r).get({ sessionID: s, localID: 1 })!.opacity).toBeCloseTo(((COMPACT_SEGMENT_FRAMES + 2) % 100) / 100, 5);
  });
});

describe("version history (docs/data.md §6)", () => {
  it("names versions, opens them read-only, restores non-destructively and duplicates them", async () => {
    t = await openTestStore();
    const { workspace, files } = t.api;
    const f = await workspace.createFile({ name: "Poster", folderId: null });
    const o = await files.open(f.fileKey, { mode: "edit" });
    const s = o.sessionID;
    await files.append(f.fileKey, batch(s, 1, [rect(s, 1, "!", { opacity: 0.5 })]));
    await files.flush(f.fileKey);
    const v1 = await files.createVersion(f.fileKey, { title: "First", description: "Just one" });
    expect(v1).toMatchObject({ kind: "named", title: "First", description: "Just one", seq: 1, restoredFrom: null });
    await files.append(f.fileKey, batch(s, 2, [{ guid: { sessionID: s, localID: 1 }, clearedFields: [8], name: "Changed" }, rect(s, 2, '"')]));

    const view = await files.openVersion(f.fileKey, v1.id);
    expect(view.mode).toBe("view");
    expect(tableOf(view).get({ sessionID: s, localID: 1 })!.opacity).toBe(0.5);

    const diff = decodeMessage(await files.restoreDiff(f.fileKey, v1.id));
    expect(diff.nodeChanges!.map((n) => [n.guid!.localID, n.phase ?? "update"])).toEqual([
      [2, "REMOVED"],
      [1, "update"],
    ]);
    // The editor applies it as one undoable batch, journaled as kind "restore", then records the restore.
    await files.append(f.fileKey, { ...batch(s, 3, diff.nodeChanges!, { kind: "restore", label: "Restore version" }), message: encodeMessage(diff) });
    const restored = await files.createVersion(f.fileKey, { kind: "restore", restoredFrom: v1.id });
    expect(restored.restoredFrom).toBe(v1.id);
    const now = tableOf(await files.open(f.fileKey, { mode: "view" }));
    expect(tablesEqual(now, tableOf(view))).toBe(true);
    expect((await files.listVersions(f.fileKey)).map((v) => v.kind)).toEqual(["restore", "named"]);

    const named = await files.updateVersion(f.fileKey, v1.id, { title: "Renamed version" });
    expect(named.title).toBe("Renamed version");
    const dup = await files.duplicateVersion(f.fileKey, v1.id);
    expect(dup.name).toBe("Poster (Renamed version)");
    expect(dup.folderId).toBeNull();
    expect(tablesEqual(tableOf(await files.open(dup.fileKey, { mode: "view" })), tableOf(view))).toBe(true);
  });

  it("takes an autosave checkpoint after 30 minutes of editing, 2 s after the last append", async () => {
    t = await openTestStore();
    const { workspace, files } = t.api;
    const f = await workspace.createFile({ folderId: null });
    const o = await files.open(f.fileKey, { mode: "edit" });
    const s = o.sessionID;
    await files.append(f.fileKey, batch(s, 1, [rect(s, 1, "!")]));
    t.clock.advance(CHECKPOINT_INTERVAL_MS + 1000);
    await files.append(f.fileKey, batch(s, 2, [rect(s, 2, '"')]));
    expect(await files.listVersions(f.fileKey)).toEqual([]);
    await t.timers.advance(2500);
    const versions = await files.listVersions(f.fileKey);
    expect(versions.map((v) => [v.kind, v.seq])).toEqual([["autosave", 2]]);
    const dir = fileDir(t, f.fileKey);
    expect(existsSync(join(dir, "versions", `${versions[0].id}.kiwi`))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "store.json"), "utf8")).checkpoint.editedSince).toBe(false);
  });

  it("keeps thumbnails and UI state per file", async () => {
    t = await openTestStore();
    const f = await t.api.workspace.createFile({ folderId: null });
    const png = new Uint8Array(readFileSync(join(__dirname, "../../../build/icon.png")));
    await expect(t.api.files.saveThumbnail(f.fileKey, png, { width: 1024, height: 1024 })).rejects.toMatchObject({ code: "invalid" }); // > 800×600
    const small = new Uint8Array(png.length);
    small.set(png);
    const v = new DataView(small.buffer);
    v.setUint32(16, 400);
    v.setUint32(20, 300);
    await t.api.files.saveThumbnail(f.fileKey, small, { width: 400, height: 300 });
    expect((await t.api.workspace.getFile(f.fileKey)).thumbnail).toEqual({ version: 1, width: 400, height: 300 });
    await t.api.files.setUiState(f.fileKey, { currentPageId: "0:1", pages: { "0:1": { viewport: { x: 1, y: 2, zoom: 0.5 }, selection: ["1:2"] } } });
    await t.api.files.setUiState(f.fileKey, { leftPanelWidth: 300 });
    const o = await t.api.files.open(f.fileKey, { mode: "view" });
    expect(o.ui).toMatchObject({ currentPageId: "0:1", leftPanelWidth: 300, pages: { "0:1": { selection: ["1:2"] } } });
  });
});
