/** Quitting with uploads in flight (docs/multiplayer.md §5.1): when main asks, once per quit, and what it says. */
import { afterEach, describe, expect, it } from "vitest";
import type { UploadProgress } from "../shared/multiplayer/uploads";
import { confirmQuitWithUploads, resetUploadsQuit, uploadsInFlight, uploadsQuitText } from "./uploadsQuit";

const up = (state: UploadProgress["state"], id: string = state): UploadProgress => ({ id, fileKey: id, name: id, destination: "", bytesSent: 0, bytesTotal: 1, state, startedAt: 0, retryable: true });

afterEach(() => resetUploadsQuit());

describe("the quit's uploads question", () => {
  it("counts queued, uploading and retrying uploads, not done or failed ones", () => {
    expect(uploadsInFlight([up("queued"), up("uploading"), up("retrying"), up("done"), up("failed")])).toBe(3);
  });

  it("quits without asking when nothing is going (or there is no store)", async () => {
    const asked: number[] = [];
    expect(await confirmQuitWithUploads({ list: async () => [up("done"), up("failed")], ask: async (n) => (asked.push(n), false) })).toBe(true);
    resetUploadsQuit();
    expect(await confirmQuitWithUploads({ list: () => null, ask: async (n) => (asked.push(n), false) })).toBe(true);
    expect(asked).toEqual([]);
  });

  it("asks with the count; Quit goes on (once for every window), Cancel stops and the next quit asks again", async () => {
    const asked: number[] = [];
    let answer = false;
    const deps = { list: async () => [up("uploading", "a"), up("queued", "b")], ask: async (n: number) => (asked.push(n), answer) };
    expect(await confirmQuitWithUploads(deps)).toBe(false);
    answer = true;
    expect(await Promise.all([confirmQuitWithUploads(deps), confirmQuitWithUploads(deps)])).toEqual([true, true]);
    expect(asked).toEqual([2, 2]);
  });

  it("doesn't hold the quit when the store doesn't answer", async () => {
    const asked: number[] = [];
    expect(await confirmQuitWithUploads({ list: () => new Promise(() => {}), ask: async (n) => (asked.push(n), false), timeoutMs: 10 })).toBe(true);
    resetUploadsQuit();
    expect(await confirmQuitWithUploads({ list: async () => Promise.reject(new Error("gone")), ask: async (n) => (asked.push(n), false) })).toBe(true);
    expect(asked).toEqual([]);
  });

  it("says it in our words", () => {
    expect(uploadsQuitText(3)).toEqual({ message: "Uploads in progress", detail: "Wecra is still uploading 3 files. If you quit, they’ll continue next time you open Wecra." });
    expect(uploadsQuitText(1).detail).toContain("uploading 1 file.");
  });
});
