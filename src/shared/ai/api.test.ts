// runOnce: a run's `ai:event` stream as one promise (what the editor's actions await).
import { describe, expect, it, vi } from "vitest";
import { AiRunError, runOnce, type AiApi } from "./api";
import type { AiRunEvent, AiRunEventMsg, AiRunRequest } from "./types";

function fakeApi(script: AiRunEvent[]) {
  let listener: ((m: AiRunEventMsg) => void) | null = null;
  const api: Pick<AiApi, "run" | "cancel" | "onEvent"> = {
    onEvent: (cb) => ((listener = cb), () => (listener = null)),
    run: vi.fn(async (r: AiRunRequest) => {
      queueMicrotask(() => {
        listener?.({ runId: "other", event: { type: "done" } });
        for (const event of script) listener?.({ runId: r.runId, event });
      });
    }),
    cancel: vi.fn(async () => undefined),
  };
  return api;
}

const req: AiRunRequest = { runId: "r1", action: "rewrite", system: "s", prompt: "p" };

describe("runOnce", () => {
  it("resolves with the result and usage; sees the deltas", async () => {
    const seen: string[] = [];
    const out = await runOnce(fakeApi([{ type: "delta", text: "{" }, { type: "usage", usage: { input: 1, output: 2, images: 0, credits: 1 } }, { type: "result", text: "{}", json: {} }, { type: "done" }]), req, { onEvent: (e) => seen.push(e.type) });
    expect(out).toEqual({ text: "{}", json: {}, usage: { input: 1, output: 2, images: 0, credits: 1 } });
    expect(seen).toEqual(["delta", "usage", "result", "done"]);
  });

  it("rejects with the run's error code, or cancelled", async () => {
    await expect(runOnce(fakeApi([{ type: "error", code: "over-limit", message: "Used up" }, { type: "done" }]), req)).rejects.toMatchObject({ code: "over-limit", message: "Used up" });
    await expect(runOnce(fakeApi([{ type: "done", cancelled: true }]), req)).rejects.toBeInstanceOf(AiRunError);
  });

  it("an abort signal cancels the run in main", async () => {
    const api = fakeApi([]);
    const ctl = new AbortController();
    const p = runOnce(api, req, { signal: ctl.signal });
    ctl.abort();
    expect(api.cancel).toHaveBeenCalledWith("r1");
    void p.catch(() => undefined);
  });
});
