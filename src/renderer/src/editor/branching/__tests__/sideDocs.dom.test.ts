// @vitest-environment happy-dom
// Review and merge's side previews (ChunkCompare.tsx SideDocs): a window's engines survive React's StrictMode mount
// (cleanup, then effects again) — the owner's run showed "Preview unavailable" on both sides because the window kept
// the SideDocs its first cleanup had destroyed. The engine is a stand-in (no WebGL here).
import { describe, expect, it, vi } from "vitest";

const engines: { destroyed: boolean }[] = [];
let gate: Promise<void> = Promise.resolve();
vi.mock("@/engine/Engine", () => ({
  Engine: {
    create: async () => {
      await gate;
      const e = { destroyed: false, setImageSource() {}, load() {}, setViewerMode() {}, destroy: () => void (e.destroyed = true) };
      engines.push(e);
      return e;
    },
  },
}));
vi.mock("@/store/documentSource", () => ({ mergedDocument: () => ({}) }));

const { SideDocs } = await import("../ChunkCompare");

const branches = { openSide: async () => ({}) } as never;

describe("SideDocs", () => {
  it("works again after destroy (StrictMode's second mount), and drops an engine that was loading when destroyed", async () => {
    const docs = new SideDocs(branches, null);
    const loading = docs.engine("p1", "main");
    docs.destroy(); // the simulated unmount, while the first side is loading
    await expect(loading).rejects.toThrow("closed");
    expect(engines.length).toBe(0);
    // Destroyed while its engine was being made: that engine is freed, its canvas removed.
    let open!: () => void;
    gate = new Promise((r) => (open = r));
    const making = docs.engine("p1", "branch");
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelectorAll("canvas").length).toBe(1);
    docs.destroy();
    open();
    await expect(making).rejects.toThrow("closed");
    expect(engines.at(-1)?.destroyed).toBe(true);
    expect(document.querySelectorAll("canvas").length).toBe(0);

    const main = await docs.engine("p1", "main"); // the second mount asks again
    expect((main as unknown as { destroyed: boolean }).destroyed).toBe(false);
    expect(await docs.engine("p1", "main")).toBe(main);
    expect(document.querySelectorAll("canvas").length).toBe(1);
    docs.destroy();
    await Promise.resolve();
    expect((main as unknown as { destroyed: boolean }).destroyed).toBe(true);
    expect(document.querySelectorAll("canvas").length).toBe(0);
  });
});
