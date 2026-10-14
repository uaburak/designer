/**
 * The manager's task queue (docs/studio.md §2.3): the work it handed out in a chat, as StudioTasks. A task waits
 * (queued) until the tasks it depends on are done and a slot is free — `parallel` CLI tasks at once (the 16 GB rule),
 * IMAGE_TASKS_AT_ONCE image runs, a review task takes none — then runs; it ends done, failed or stopped. A failed or
 * stopped dependency fails the tasks after it. Pure of the editor: how a task runs is the closure it was added with
 * (a worker turn, an image run), so the tests drive it with fakes.
 */
import type { StudioTask, TaskKind } from "@shared/studio/types";
import { t } from "@/i18n";

export interface TaskResult {
  /** What it did, in a line (a worker's last answer, shortened) */
  summary?: string;
  /** What it made on the canvas */
  nodeIds?: string[];
  credits?: number;
}

/** How a task runs: resolves with its result, rejects with why it failed; `signal` aborts on Stop. */
export type TaskRun = (signal: AbortSignal, task: StudioTask) => Promise<TaskResult>;

export interface QueueLimits {
  /** Agent tasks (CLI processes, server turns) at once */
  cli: number;
  /** Image runs at once */
  image: number;
}

interface Entry {
  task: StudioTask;
  run: TaskRun | null;
  abort?: AbortController;
  ended: Promise<StudioTask>;
  settle: (t: StudioTask) => void;
}

const ENDED = new Set<StudioTask["state"]>(["done", "failed", "stopped"]);
export const isEnded = (t: Pick<StudioTask, "state">) => ENDED.has(t.state);

const slotOf = (kind: TaskKind): keyof QueueLimits | null => (kind === "image" ? "image" : kind === "agent" ? "cli" : null);

export class TaskQueue {
  private entries = new Map<string, Entry>();

  constructor(
    private opts: {
      limits(): QueueLimits;
      /** A task changed (its card follows; the chat saves it) */
      onChange(task: StudioTask): void;
      now?(): number;
    }
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private entry(task: StudioTask, run: TaskRun | null): Entry {
    let settle!: (t: StudioTask) => void;
    const ended = new Promise<StudioTask>((r) => (settle = r));
    return { task, run, ended, settle };
  }

  /** A new task (queued); it starts as soon as its dependencies are done and a slot is free. */
  add(task: Omit<StudioTask, "state"> & { state?: StudioTask["state"] }, run: TaskRun): StudioTask {
    const t: StudioTask = { ...task, state: "queued", dependsOn: [...(task.dependsOn ?? [])] };
    this.entries.set(t.id, this.entry(t, run));
    this.opts.onChange(t);
    this.pump();
    return t;
  }

  /** Tasks kept with a chat (ended ones; a running one when its file closed is stopped): wait_tasks can still read them. */
  restore(tasks: readonly StudioTask[]) {
    for (const task of tasks) {
      if (this.entries.has(task.id)) continue;
      const t = isEnded(task) ? task : { ...task, state: "stopped" as const, endedAt: task.endedAt ?? this.now() };
      const e = this.entry(t, null);
      e.settle(t);
      this.entries.set(t.id, e);
    }
  }

  get(id: string): StudioTask | undefined {
    return this.entries.get(id)?.task;
  }

  list(filter: (t: StudioTask) => boolean = () => true): StudioTask[] {
    return [...this.entries.values()].map((e) => e.task).filter(filter);
  }

  /** Resolves with the task once it has ended. */
  ended(id: string): Promise<StudioTask> {
    const e = this.entries.get(id);
    return e ? e.ended : Promise.reject(new Error(`No task ${id}`));
  }

  private update(e: Entry, patch: Partial<StudioTask>) {
    e.task = { ...e.task, ...patch };
    this.opts.onChange(e.task);
    if (isEnded(e.task)) e.settle(e.task);
  }

  private running(slot: keyof QueueLimits): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.task.state === "running" && slotOf(e.task.kind) === slot) n++;
    return n;
  }

  /** Starts what can start, in the order the tasks were added; fails tasks whose dependency failed. */
  private pump() {
    const limits = this.opts.limits();
    for (let again = true; again; ) {
      again = false;
      for (const e of this.entries.values()) {
        if (e.task.state !== "queued") continue;
        const deps = e.task.dependsOn.map((id) => ({ id, t: this.entries.get(id)?.task }));
        const bad = deps.find((d) => !d.t || d.t.state === "failed" || d.t.state === "stopped");
        if (bad) {
          const why = !bad.t ? t("It depends on a task that doesn't exist ({id}).", { id: bad.id }) : bad.t.state === "stopped" ? t("“{title}” was stopped.", { title: bad.t.title }) : t("“{title}” failed.", { title: bad.t.title });
          this.update(e, { state: "failed", error: why, endedAt: this.now() });
          // Its own dependants fail in turn.
          again = true;
          continue;
        }
        if (deps.some((d) => d.t!.state !== "done")) continue;
        const slot = slotOf(e.task.kind);
        if (slot && this.running(slot) >= Math.max(1, slot === "cli" ? limits.cli : limits.image)) continue;
        this.start(e);
      }
    }
  }

  private start(e: Entry) {
    const abort = new AbortController();
    e.abort = abort;
    this.update(e, { state: "running", startedAt: this.now() });
    const run = e.run;
    void (async () => {
      try {
        if (!run) throw new Error("The task can't run again here.");
        // Never inside add(): the caller has its task before the run begins.
        await Promise.resolve();
        if (e.task.state !== "running") return;
        const r = await run(abort.signal, e.task);
        if (e.task.state !== "running") return;
        this.update(e, { state: "done", endedAt: this.now(), ...(r.summary !== undefined ? { summary: r.summary } : {}), ...(r.nodeIds ? { nodeIds: r.nodeIds } : {}), ...(r.credits !== undefined ? { credits: r.credits } : {}) });
      } catch (err) {
        if (e.task.state !== "running") return;
        if (abort.signal.aborted) this.update(e, { state: "stopped", endedAt: this.now() });
        else this.update(e, { state: "failed", endedAt: this.now(), error: err instanceof Error ? err.message : String(err) });
      } finally {
        this.pump();
      }
    })();
  }

  /** Stop: a queued task never starts, a running one is aborted; either ends stopped (its dependants fail). */
  stop(id: string) {
    if (this.halt(id)) this.pump();
  }

  private halt(id: string): boolean {
    const e = this.entries.get(id);
    if (!e || isEnded(e.task)) return false;
    e.abort?.abort();
    this.update(e, { state: "stopped", endedAt: this.now() });
    return true;
  }

  /** Every task that matches (a manager's answer's, a chat's) stopped. */
  stopWhere(match: (t: StudioTask) => boolean) {
    // All of them stopped first (a dependant among them is stopped, not failed), then what can start starts.
    let any = false;
    for (const e of [...this.entries.values()]) if (match(e.task)) any = this.halt(e.task.id) || any;
    if (any) this.pump();
  }

  /** The limits changed (the settings' At once): what can start now starts. */
  refresh() {
    this.pump();
  }

  /** wait_tasks: the tasks once all have ended, or as they stand at the timeout (or when `signal` aborts). */
  async wait(ids: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<StudioTask[]> {
    const known = ids.filter((id) => this.entries.has(id));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = new Promise<void>((r) => {
      timer = setTimeout(r, Math.max(0, timeoutMs));
      signal?.addEventListener("abort", () => r(), { once: true });
    });
    await Promise.race([Promise.all(known.map((id) => this.entries.get(id)!.ended)), stop]);
    clearTimeout(timer);
    return known.map((id) => this.entries.get(id)!.task);
  }
}
