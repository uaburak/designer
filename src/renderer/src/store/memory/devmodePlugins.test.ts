// Round 5g over MemoryStore: a local file's dev resources and Code Connect mappings one storage key each (deleted
// with the file), and saved / recent plugins in `designer.devStore.v1.plugins` (src/store/devmode, src/store/plugins).
import { describe, expect, it } from "vitest";
import { memoryStorage } from "./kv";
import { MemoryStore } from "./memoryStore";

describe("MemoryStore's devMode and plugins", () => {
  it("keeps a local file's Dev Mode records in the storage, one key each", async () => {
    const storage = memoryStorage();
    const store = await MemoryStore.open({ storage });
    try {
      const api = store.api({});
      const file = await api.workspace.createFile({ name: "Browser", folderId: null });
      await api.devMode.addDevResource(file.fileKey, { nodeId: "1:2", name: "", url: "https://x.test/a" });
      await api.devMode.setCodeConnect(file.fileKey, { nodeId: "1:2", label: "Vue", language: "", source: null, component: "XButton", imports: [], nestable: true, instructions: "" });
      expect(JSON.parse(storage.get(`designer.devStore.v1.devResources.${file.fileKey}`)!).devResources).toHaveLength(1);
      expect(JSON.parse(storage.get(`designer.devStore.v1.codeConnect.${file.fileKey}`)!).mappings[0]).toMatchObject({ label: "Vue", language: "vue" });
      await api.workspace.trash({ files: [file.fileKey], folders: [] });
      await api.workspace.deleteForever({ files: [file.fileKey], folders: [] });
      expect(storage.get(`designer.devStore.v1.devResources.${file.fileKey}`)).toBeNull();
      expect(storage.get(`designer.devStore.v1.codeConnect.${file.fileKey}`)).toBeNull();
    } finally {
      store.dispose();
    }
  });

  it("keeps saved and recent plugins across page loads", async () => {
    const storage = memoryStorage();
    const ref = { id: "dev-1", name: "One", kind: "plugin" as const, source: { type: "development" as const, path: "/p/manifest.json" }, editorTypes: ["figma" as const] };
    const first = await MemoryStore.open({ storage });
    await first.api({}).plugins.setSaved(ref, true);
    await first.api({}).plugins.ranRecently(ref);
    first.dispose();
    const second = await MemoryStore.open({ storage });
    try {
      expect(await second.api({}).plugins.local()).toEqual({ saved: [ref], recents: [ref] });
      expect(JSON.parse(storage.get("designer.devStore.v1.plugins")!).v).toBe(1);
    } finally {
      second.dispose();
    }
  });
});
