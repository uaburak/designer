/**
 * The compactor worker as the app runs it: the store's own bundle (built here with esbuild, as electron-vite builds
 * out/main/store.js) started as a worker thread with `workerData.designerStoreRole === "compactor"`.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeMessage } from "../shared/schema/codec";
import { inlineCompactor, workerCompactor, type Compactor } from "./compactor";
import { batch, openTestStore, rect, tempDir } from "./testing/harness";

const root = fileURLToPath(new URL("../..", import.meta.url));
let entry = "";
let dir = "";

beforeAll(async () => {
  dir = tempDir("designer-compactor-");
  entry = join(dir, "store.cjs");
  await build({ entryPoints: [join(root, "src/store/index.ts")], bundle: true, platform: "node", format: "cjs", target: "node22", outfile: entry, logLevel: "silent" });
}, 60_000);

const compactors: Compactor[] = [];
afterAll(async () => {
  for (const c of compactors) await c.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the compactor worker (docs/data.md §5.5)", () => {
  it("compacts a file off the store's thread, with the same result as inline", async () => {
    const results: string[][] = [];
    for (const compactor of [workerCompactor(entry), inlineCompactor]) {
      compactors.push(compactor);
      const t = await openTestStore({ compactor });
      try {
        const f = await t.api.workspace.createFile({ folderId: null });
        const o = await t.api.files.open(f.fileKey, { mode: "edit" });
        const s = o.sessionID;
        await t.api.files.append(f.fileKey, batch(s, 1, [rect(s, 1, "!"), rect(s, 2, '"')]));
        await t.api.files.append(f.fileKey, batch(s, 2, [{ guid: { sessionID: s, localID: 1 }, name: "Kept" }, { guid: { sessionID: s, localID: 2 }, phase: "REMOVED" }]));
        expect(await t.store.files.compact(f.fileKey, { force: true })).toBe(true);
        const view = await t.api.files.open(f.fileKey, { mode: "view" });
        expect(view.snapshotSeq).toBe(2);
        expect(view.journal).toEqual([]);
        results.push(decodeMessage(view.snapshot).nodeChanges!.map((n) => `${n.guid!.sessionID}:${n.guid!.localID} ${n.name}`));
      } finally {
        await t.close();
        t.dispose();
      }
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toHaveLength(4); // DOCUMENT, Page 1, the kept rectangle, the internal canvas
    expect(results[0].filter((n) => n.endsWith(" Kept"))).toHaveLength(1);
  });

  it("answers from the worker thread, errors included", async () => {
    const c = workerCompactor(entry);
    compactors.push(c);
    await expect(c.compact({ snapshotPath: join(dir, "missing.kiwi"), snapshotSeq: 0, segmentPaths: [], schemasDir: dir, upTo: 0 })).rejects.toThrow(/ENOENT|no such file/);
  });
});
