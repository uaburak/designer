import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeCanvas } from "../../shared/fig/container";
import { readFigFile, writeFigFile } from "../../shared/fig/figFile";
import { decodeMessage } from "../../shared/schema/codec";
import { RESERVED_SESSION_LIMIT, sessionIdFor } from "../../shared/schema/guid";
import { NodeTable, tablesEqual } from "../../shared/schema/patch";
import { toHex } from "../../shared/schema/visit";
import { nodeCodecs } from "../kiwi/codecs";
import { batch, openTestStore, rect, type TestStore } from "../testing/harness";

let t: TestStore | null = null;
afterEach(async () => {
  await t?.close().catch(() => {});
  t?.dispose();
  t = null;
});

const SAMPLES = join(__dirname, "../../../docs/research/figma/samples");

describe(".fig import and Save Local Copy (docs/data.md §11)", () => {
  for (const name of ["structure.fig", "sections.fig", "stacks_wrap.fig"]) {
    it(`imports Figma's ${name} into a new file with its images, thumbnail and an import version`, async () => {
      t = await openTestStore();
      const meta = await t.api.files.importLocalCopy(join(SAMPLES, name), null);
      const source = readFigFile(new Uint8Array(readFileSync(join(SAMPLES, name))), nodeCodecs);
      expect(meta.name).toBe(source.meta?.file_name);
      expect(meta.importedFrom).toEqual({ kind: "fig", name: source.meta?.file_name });
      expect(meta.thumbnail?.version).toBe(1);
      expect((await t.api.files.listVersions(meta.fileKey)).map((v) => v.kind)).toEqual(["import"]);
      for (const hash of source.images.keys()) expect(await t.api.blobs.has([hash])).toEqual([true]);
      const o = await t.api.files.open(meta.fileKey, { mode: "edit" });
      expect(o.sessionID).toBe(sessionIdFor(1, 2)); // session 1 went to the import's remapped GUIDs
      const nodes = decodeMessage(o.snapshot).nodeChanges!;
      expect(nodes[0].type).toBe("DOCUMENT");
      // Every GUID is either Figma-reserved (session < 2^20, kept) or in the import session.
      for (const n of nodes) expect(n.guid!.sessionID < RESERVED_SESSION_LIMIT || n.guid!.sessionID === sessionIdFor(1, 1)).toBe(true);
      const images = new Set(NodeTable.fromMessage(decodeMessage(o.snapshot)).imageHashes());
      expect([...images].sort()).toEqual([...source.images.keys()].sort());
    });
  }

  it("refuses FigJam, Slides and things that are not .fig files", async () => {
    t = await openTestStore();
    const jam = join(t.dir, "board.fig");
    writeFileSync(jam, Buffer.concat([Buffer.from("fig-jam."), Buffer.alloc(8)]));
    await expect(t.api.files.importLocalCopy(jam, null)).rejects.toMatchObject({ code: "unsupported-format" });
    const txt = join(t.dir, "notes.fig");
    writeFileSync(txt, "hello");
    await expect(t.api.files.importLocalCopy(txt, null)).rejects.toMatchObject({ code: "unsupported-format" });
  });

  it("re-points paints when an image's bytes do not hash to its name", async () => {
    t = await openTestStore();
    const src = readFigFile(new Uint8Array(readFileSync(join(SAMPLES, "structure.fig"))), nodeCodecs);
    const [name, bytes] = [...src.images][0];
    const damaged = bytes.slice();
    damaged[damaged.length - 1] ^= 1;
    const path = join(t.dir, "broken.fig");
    writeFileSync(path, writeFigFile({ canvas: src.canvas, meta: src.meta, thumbnail: src.thumbnail, images: [...src.images].map(([k, v]) => [k, k === name ? damaged : v] as [string, Uint8Array]) }));
    const meta = await t.api.files.importLocalCopy(path, null);
    const o = await t.api.files.open(meta.fileKey, { mode: "view" });
    const hashes = NodeTable.fromMessage(decodeMessage(o.snapshot)).imageHashes();
    const computed = (await t.api.blobs.put(damaged)).sha1;
    expect(hashes.has(computed)).toBe(true);
    expect(hashes.has(name)).toBe(false);
  });

  it("Save Local Copy writes canvas.fig as the head snapshot, meta.json, the thumbnail and the images; it imports back identically", async () => {
    t = await openTestStore();
    const imported = await t.api.files.importLocalCopy(join(SAMPLES, "structure.fig"), null);
    const o = await t.api.files.open(imported.fileKey, { mode: "edit" });
    await t.api.files.append(imported.fileKey, batch(o.sessionID, 1, [rect(o.sessionID, 1, "~~", { name: "Added after import" })]));
    const out = join(t.dir, "Exported.fig");
    await t.api.files.exportLocalCopy(imported.fileKey, out);
    const fig = readFigFile(new Uint8Array(readFileSync(out)), nodeCodecs);
    expect(fig.meta).toMatchObject({ file_name: "structure", client_meta: { thumbnail_size: { width: 400, height: 190 } } });
    expect(fig.thumbnail).not.toBeNull();
    expect(fig.images.size).toBe(3);
    const head = decodeCanvas(fig.canvas, nodeCodecs);
    expect(head.prelude).toBe("fig-kiwi");
    expect(head.version).toBe(1);
    expect(head.compression).toBe("zstd");
    const state = JSON.parse(readFileSync(join(t.dir, "Workspace", "files", imported.fileKey, "store.json"), "utf8"));
    expect(new Uint8Array(readFileSync(join(t.dir, "Workspace", "files", imported.fileKey, state.head.snapshot)))).toEqual(fig.canvas); // as is, no re-encoding
    const again = await t.api.files.importLocalCopy(out, null);
    const a = NodeTable.fromMessage(decodeMessage((await t.api.files.open(imported.fileKey, { mode: "view" })).snapshot));
    const b = NodeTable.fromMessage(decodeMessage((await t.api.files.open(again.fileKey, { mode: "view" })).snapshot));
    expect(b.size).toBe(a.size);
    // Our own GUIDs (session ≥ 2^20) are remapped into the new file's import session; everything else is equal.
    expect([...b.nodes.values()].some((n) => n.name === "Added after import")).toBe(true);
    expect(toHex(new Uint8Array(20))).toHaveLength(40);
    expect(tablesEqual(a, a.clone())).toBe(true);
  });

  it("duplicates a file with its content and thumbnail but not its versions", async () => {
    t = await openTestStore();
    const imported = await t.api.files.importLocalCopy(join(SAMPLES, "sections.fig"), null);
    const dup = await t.api.workspace.duplicateFile(imported.fileKey);
    expect(dup.name).toBe(`${imported.name} (Copy)`);
    expect(dup.thumbnail).toMatchObject({ version: 1 });
    expect(await t.api.files.listVersions(dup.fileKey)).toEqual([]);
    const a = NodeTable.fromMessage(decodeMessage((await t.api.files.open(imported.fileKey, { mode: "view" })).snapshot));
    const b = NodeTable.fromMessage(decodeMessage((await t.api.files.open(dup.fileKey, { mode: "view" })).snapshot));
    expect(tablesEqual(a, b)).toBe(true);
  });
});
