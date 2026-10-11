// Branches in the browser's dev store (docs/data.md §15.5): the scenario the desktop store runs
// (src/store/branches/scenario.ts), over MemoryStore.
import { describe, expect, it } from "vitest";
import { editFile, rect, scenario } from "../../../../store/branches/scenario";
import { memoryStorage } from "./kv";
import { MemoryStore } from "./memoryStore";

describe("branches in the dev store (docs/data.md §15.5)", () => {
  it("create, update, merge, archive, reviews", async () => {
    const store = await MemoryStore.open({ storage: memoryStorage() });
    try {
      await scenario(store.api({}), () => new Promise((r) => setTimeout(r, 0)));
    } finally {
      store.dispose();
    }
  });

  it("two previews asked for at once: the later one is kept, whatever order they finish in", async () => {
    // Review and merge mounted twice (StrictMode) asked twice; the window kept an id the store had dropped.
    const store = await MemoryStore.open({ storage: memoryStorage() });
    try {
      const api = store.api({});
      const main = await api.workspace.createFile({ name: "Design", folderId: null });
      await editFile(api, main.fileKey, (s) => [rect(s, 1, "!")]);
      const b = await api.branches.create(main.fileKey, "Feature");
      await editFile(api, b.branchFileKey, (s) => [rect(s, 2, '"')]);
      const [first, second] = await Promise.all([api.branches.preview(b.branchFileKey, "merge"), api.branches.preview(b.branchFileKey, "merge")]);
      await expect(api.branches.openSide(first.previewId, "branch")).rejects.toMatchObject({ code: "stale" });
      expect((await api.branches.openSide(second.previewId, "branch")).mode).toBe("view");
    } finally {
      store.dispose();
    }
  });
});
