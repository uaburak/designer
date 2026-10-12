// The browser's dev store keeps visual search's index (docs/ai.md §6) one key per file, and drops it with the file.
import { describe, expect, it } from "vitest";
import { normalize } from "../../../../store/search/format";
import { memoryStorage } from "./kv";
import { MemoryStore } from "./memoryStore";

const unit = (dim: number, i: number) => {
  const v = new Float32Array(dim);
  v[i] = 1;
  return normalize(v);
};

describe("the dev store's search", () => {
  it("keeps the index in its keys", async () => {
    const kv = memoryStorage();
    const store = await MemoryStore.open({ storage: kv });
    try {
      const api = store.api({});
      const f = await api.workspace.createFile({ name: "Dev", folderId: null });
      const doc = { fileKey: f.fileKey, fileName: "Dev", nodeId: "1:1", kind: "frame" as const, name: "Card", pageId: "0:1", pageName: "Page 1", version: "v1", text: "", width: 10, height: 10, modifiedAt: 1 };
      await api.search.upsert([{ doc, vectors: { clip: unit(512, 4), text: unit(384, 4) }, thumb: new Uint8Array([1, 2, 3]) }]);
      expect([...kv.map.keys()].some((k) => k.endsWith(`search.${f.fileKey}.idx`))).toBe(true);
      expect((await api.search.query({ text: "card", sort: "relevance" })).map((h) => h.doc.nodeId)).toEqual(["1:1"]);
      expect([...((await api.search.thumb(f.fileKey, "1:1")) ?? [])]).toEqual([1, 2, 3]);
      await api.workspace.trash({ files: [f.fileKey] });
      await api.workspace.deleteForever({ files: [f.fileKey] });
      expect([...kv.map.keys()].some((k) => k.includes("search."))).toBe(false);
    } finally {
      store.dispose();
    }
  });
});
