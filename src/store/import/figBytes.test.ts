import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFigFile } from "../../shared/fig/figFile";
import { decodeMessage } from "../../shared/schema/codec";
import { NodeTable, tablesEqual } from "../../shared/schema/patch";
import { nodeCodecs } from "../kiwi/codecs";
import { openTestStore, type TestStore } from "../testing/harness";
import { rpcTestbed, type RpcTestbed } from "../testing/rpcHarness";

const SAMPLES = join(__dirname, "../../../docs/research/figma/samples");
const sample = (name: string) => new Uint8Array(readFileSync(join(SAMPLES, name)));

let t: TestStore | null = null;
let bed: RpcTestbed | null = null;
afterEach(async () => {
  await t?.close().catch(() => {});
  t?.dispose();
  t = null;
  await bed?.close();
  bed = null;
});

describe("files.importFigBytes (Home's Import, a file dropped from Finder)", () => {
  for (const name of ["structure.fig", "sections.fig", "stacks_wrap.fig"]) {
    it(`imports ${name} from its bytes over a Home port, the same as from its path`, async () => {
      bed = await rpcTestbed();
      const home = await bed.connect("home");
      const folder = await home.workspace.createFolder({ name: "Imports", parentId: null });
      const meta = await home.files.importFigBytes(sample(name), name, folder.id);
      const source = readFigFile(sample(name), nodeCodecs);
      expect(meta).toMatchObject({ name: source.meta?.file_name, folderId: folder.id, importedFrom: { kind: "fig", name: source.meta?.file_name }, thumbnail: { version: 1 } });
      expect((await home.files.listVersions(meta.fileKey)).map((v) => v.kind)).toEqual(["import"]);
      for (const hash of source.images.keys()) expect(await home.blobs.has([hash])).toEqual([true]);
      const viaPath = await bed.t.api.files.importLocalCopy(join(SAMPLES, name), null);
      const a = NodeTable.fromMessage(decodeMessage((await home.files.open(meta.fileKey, { mode: "view" })).snapshot));
      const b = NodeTable.fromMessage(decodeMessage((await home.files.open(viaPath.fileKey, { mode: "view" })).snapshot));
      expect(tablesEqual(a, b)).toBe(true);
    });
  }

  it("names a bare canvas.fig after the dropped file, defaults to Drafts, and refuses what isn't a design file", async () => {
    t = await openTestStore();
    const canvas = readFigFile(sample("structure.fig"), nodeCodecs).canvas;
    const meta = await t.api.files.importFigBytes(canvas, "Dropped design.fig");
    expect(meta).toMatchObject({ name: "Dropped design", folderId: null });
    await expect(t.api.files.importFigBytes(new TextEncoder().encode("hello"), "notes.fig")).rejects.toMatchObject({ code: "unsupported-format" });
    const jam = new Uint8Array([...new TextEncoder().encode("fig-jam."), 0, 0, 0, 0, 0, 0, 0, 0]);
    await expect(t.api.files.importFigBytes(jam, "board.fig")).rejects.toMatchObject({ code: "unsupported-format" });
    const trashed = await t.api.workspace.createFolder({ name: "Gone", parentId: null });
    await t.api.workspace.trash({ folders: [trashed.id] });
    await expect(t.api.files.importFigBytes(canvas, "x.fig", trashed.id)).rejects.toMatchObject({ code: "trashed" });
  });
});
