// Branches in the browser's dev store (docs/data.md §15.5): the scenario the desktop store runs
// (src/store/branches/scenario.ts), over MemoryStore.
import { describe, it } from "vitest";
import { scenario } from "../../../../store/branches/scenario";
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
});
