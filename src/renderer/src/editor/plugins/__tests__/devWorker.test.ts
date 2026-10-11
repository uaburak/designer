// The developer VM's main-thread side (vm/devWorker.ts): host calls answered into the SharedArrayBuffer, in chunks when
// longer than the buffer; eval / call answered by id; terminate on Stop. The worker is a fake playing its protocol.
import { describe, expect, it } from "vitest";
import { DevWorkerVm, type WorkerLike } from "../vm/devWorker";

/** A fake worker: on eval it makes one host call and reads the answer from the shared buffer as the real one does. */
function fakeWorker(op: string, args: string) {
  let header: Int32Array | null = null;
  let data: Uint8Array | null = null;
  const answers: string[] = [];
  let terminated = false;
  const w: WorkerLike & { answers: string[]; terminated: () => boolean } = {
    onmessage: null,
    onerror: null,
    answers,
    terminated: () => terminated,
    terminate: () => void (terminated = true),
    postMessage(m: unknown) {
      const msg = m as { t: string; id?: number; sab?: SharedArrayBuffer; code?: string };
      if (msg.t === "init") {
        header = new Int32Array(msg.sab!, 0, 2);
        data = new Uint8Array(msg.sab!, 8);
        return;
      }
      const send = (x: unknown) => w.onmessage?.({ data: x } as MessageEvent);
      if (msg.t === "eval") {
        // The worker's hostCall: post, then (instead of Atomics.wait) read what was written.
        const parts: Uint8Array[] = [];
        send({ t: "host", op, args });
        for (;;) {
          parts.push(data!.slice(0, header![1]));
          if (header![0] === 1) break;
          send({ t: "more" });
        }
        const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const p of parts) {
          all.set(p, at);
          at += p.length;
        }
        answers.push(new TextDecoder().decode(all));
        if (msg.code === "throw") send({ t: "fail", id: msg.id, message: "boom" });
        else send({ t: "done", id: msg.id, result: "" });
      } else if (msg.t === "call") send({ t: "done", id: msg.id, result: "called" });
    },
  };
  return w;
}

describe("developer VM bridge", () => {
  it("answers a host call through the shared buffer, a long answer in chunks", async () => {
    const big = "x".repeat(3 * (1 << 20) + 17);
    const worker = fakeWorker("get", '["1:2","name"]');
    const seen: [string, string][] = [];
    const vm = new DevWorkerVm(worker, { host: (op, args) => (seen.push([op, args]), JSON.stringify({ ok: big })) });
    await vm.evaluate("code", "code.js");
    expect(seen).toEqual([["get", '["1:2","name"]']]);
    expect(worker.answers[0]).toBe(JSON.stringify({ ok: big }));
    expect(await vm.call("__dispatch", "run", "{}")).toBe("called");
  });

  it("rejects a failed evaluation with the worker's message; Stop terminates the worker", async () => {
    const worker = fakeWorker("console", "[]");
    const vm = new DevWorkerVm(worker, { host: () => JSON.stringify({ ok: null }) });
    await expect(vm.evaluate("throw", "code.js")).rejects.toThrow("boom");
    vm.interrupt();
    expect(worker.terminated()).toBe(true);
    await expect(vm.call("__dispatch", "run", "")).rejects.toThrow("stopped");
  });
});
