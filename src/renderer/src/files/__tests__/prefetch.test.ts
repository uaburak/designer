import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrefetcher, PREFETCH_DELAY_MS } from "../prefetch";
import type { OrgBackend } from "../storeAccess";

/** An org backend whose page reads stay open until `finish` */
function backend() {
  const calls: string[] = [];
  const open: (() => void)[] = [];
  const read = (what: string) => {
    calls.push(what);
    return new Promise<never>((_, reject) => open.push(() => reject(new Error("done"))));
  };
  const org = { teams: { page: (id: string) => read(`team:${id}`) }, projects: { page: (id: string) => read(`project:${id}`) } } as unknown as OrgBackend;
  return { org, calls, finish: async () => void (await Promise.resolve(open.splice(0).forEach((f) => f()))) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("prefetch on intent", () => {
  it("reads after 150 ms of resting; leaving sooner cancels", () => {
    const b = backend();
    const p = createPrefetcher(b.org);
    const team = { kind: "team", teamId: "T1" } as const;
    p.intent(team);
    vi.advanceTimersByTime(PREFETCH_DELAY_MS - 10);
    p.leave(team);
    vi.advanceTimersByTime(1000);
    expect(b.calls).toEqual([]);
    p.handlers(team).onFocus();
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    expect(b.calls).toEqual(["team:T1"]);
  });

  it("at most one read in flight per target; other targets go their own way", async () => {
    const b = backend();
    const p = createPrefetcher(b.org);
    const folder = { kind: "project", projectId: "F1" } as const;
    p.intent(folder);
    p.intent(folder);
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    p.handlers(folder).onMouseLeave();
    p.handlers(folder).onMouseEnter();
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    p.intent({ kind: "team", teamId: "T1" });
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    expect(b.calls).toEqual(["project:F1", "team:T1"]);
    expect(p.sent).toBe(2);
    // Done (even refused): the next rest reads again
    await b.finish();
    await vi.runAllTimersAsync();
    p.intent(folder);
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    expect(b.calls).toEqual(["project:F1", "team:T1", "project:F1"]);
    p.intent({ kind: "team", teamId: "T2" });
    p.dispose();
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    expect(b.calls).toHaveLength(3);
  });

  it("does nothing without the page reads (an older store)", () => {
    const p = createPrefetcher({ teams: {}, projects: {} } as unknown as OrgBackend);
    p.intent({ kind: "team", teamId: "T1" });
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    expect(p.sent).toBe(0);
  });
});
