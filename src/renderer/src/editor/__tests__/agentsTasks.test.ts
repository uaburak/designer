// The manager's task queue (docs/studio.md §2.3): limits per kind, dependencies, failure propagation, stop, wait.
import { describe, expect, it } from "vitest";
import type { StudioTask, TaskKind } from "@shared/studio/types";
import { TaskQueue, type TaskResult } from "../agents/tasks";

/** A run the test ends by hand. */
function gate() {
  let resolve!: (r: TaskResult) => void;
  let reject!: (e: Error) => void;
  const p = new Promise<TaskResult>((a, b) => ((resolve = a), (reject = b)));
  return { p, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function queue(cli = 2, image = 3) {
  const changes: StudioTask[] = [];
  const q = new TaskQueue({ limits: () => ({ cli, image }), onChange: (t) => changes.push(t) });
  const gates = new Map<string, ReturnType<typeof gate>>();
  const signals = new Map<string, AbortSignal>();
  const add = (id: string, kind: TaskKind = "agent", dependsOn: string[] = []) => {
    const g = gate();
    gates.set(id, g);
    return q.add({ id, chatId: "c", messageId: "m", kind, title: id, route: { providerId: "claude-code" }, dependsOn }, (signal) => {
      signals.set(id, signal);
      signal.addEventListener("abort", () => g.reject(new Error("aborted")));
      return g.p;
    });
  };
  const state = (id: string) => q.get(id)!.state;
  return { q, add, gates, signals, state, changes };
}

describe("task queue", () => {
  it("runs at most `parallel` agent tasks and IMAGE_TASKS_AT_ONCE image tasks; the rest wait in order", async () => {
    const { add, gates, state } = queue(2, 3);
    for (const id of ["a1", "a2", "a3"]) add(id);
    for (const id of ["i1", "i2", "i3", "i4"]) add(id, "image");
    await tick();
    expect(["a1", "a2", "a3"].map(state)).toEqual(["running", "running", "queued"]);
    expect(["i1", "i2", "i3", "i4"].map(state)).toEqual(["running", "running", "running", "queued"]);
    gates.get("a1")!.resolve({ summary: "made it", nodeIds: ["1:2"], credits: 3 });
    gates.get("i2")!.resolve({});
    await tick();
    await tick();
    expect(state("a1")).toBe("done");
    expect(state("a3")).toBe("running");
    expect(state("i4")).toBe("running");
  });

  it("a task starts when its dependencies are done; a failed or stopped one fails it and its own dependants", async () => {
    const { q, add, gates, state } = queue(4);
    add("frame");
    add("pic", "image");
    add("review", "review", ["frame", "pic"]);
    add("after", "agent", ["review"]);
    await tick();
    expect(state("review")).toBe("queued");
    gates.get("frame")!.resolve({ nodeIds: ["5:1"] });
    await tick();
    await tick();
    expect(state("review")).toBe("queued");
    gates.get("pic")!.reject(new Error("The model refused"));
    await tick();
    await tick();
    expect(q.get("pic")).toMatchObject({ state: "failed", error: "The model refused" });
    expect(q.get("review")).toMatchObject({ state: "failed", error: "“pic” failed." });
    expect(q.get("after")).toMatchObject({ state: "failed", error: "“review” failed." });
    add("orphan", "agent", ["nope"]);
    expect(state("orphan")).toBe("failed");
  });

  it("Stop: a running task is aborted, a queued one never starts; stopping a manager's answer stops all its tasks", async () => {
    const { q, add, signals, state } = queue(1);
    add("one");
    add("two");
    await tick();
    q.stop("one");
    expect(signals.get("one")!.aborted).toBe(true);
    expect(state("one")).toBe("stopped");
    await tick();
    await tick();
    expect(state("two")).toBe("running");
    add("three", "agent", ["two"]);
    q.stopWhere((t) => t.messageId === "m");
    expect(["two", "three"].map(state)).toEqual(["stopped", "stopped"]);
  });

  it("wait resolves when all have ended, or with their states at the timeout", async () => {
    const { q, add, gates } = queue(4);
    add("x");
    add("y");
    await tick();
    const early = await q.wait(["x", "y"], 10);
    expect(early.map((t) => t.state)).toEqual(["running", "running"]);
    const later = q.wait(["x", "y"], 10_000);
    gates.get("x")!.resolve({ summary: "x done" });
    gates.get("y")!.resolve({ summary: "y done" });
    expect((await later).map((t) => [t.state, t.summary])).toEqual([["done", "x done"], ["done", "y done"]]);
  });

  it("tasks kept with a chat come back over (a running one stopped) for wait_tasks to read", async () => {
    const { q } = queue();
    q.restore([{ id: "old", chatId: "c", messageId: "m", kind: "agent", title: "old", route: { providerId: "claude-code" }, state: "running", dependsOn: [] }]);
    expect((await q.wait(["old"], 1000))[0].state).toBe("stopped");
  });
});
