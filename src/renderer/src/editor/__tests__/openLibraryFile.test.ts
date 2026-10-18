/**
 * Go to main component on a library instance opens the library file (editor/libraries.ts `openLibraryFile`): a local
 * library by its own key; an org library — named by its room key (docs/data.md §16.1) — through its local copy, made
 * first when there is none (leftovers 2026-10-18).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const local = new Set(["local_lib01"]);
const store = {
  workspace: { getFile: vi.fn(async (key: string) => (local.has(key) ? { key } : Promise.reject(new Error("not-found")))) },
  multiplayer: { openShared: vi.fn(async (key: string) => ({ fileKey: `copy_of_${key}` })) },
};
vi.mock("@/store", () => ({ getStoreClient: () => store }));

const { openLibraryFile } = await import("../libraries");

describe("openLibraryFile", () => {
  const openFile = vi.fn(async () => undefined);
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { designer: { nav: { openFile } } };
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    vi.clearAllMocks();
  });

  it("opens a local library by its key, without asking the server", async () => {
    await openLibraryFile("local_lib01", "Icons");
    expect(openFile).toHaveBeenCalledWith("local_lib01", { title: "Icons" });
    expect(store.multiplayer.openShared).not.toHaveBeenCalled();
  });

  it("opens an org library through its local copy", async () => {
    await openLibraryFile("roomkey_ds01", "Design System");
    expect(store.multiplayer.openShared).toHaveBeenCalledWith("roomkey_ds01", undefined, undefined, { early: true });
    expect(openFile).toHaveBeenCalledWith("copy_of_roomkey_ds01", { title: "Design System" });
  });
});
