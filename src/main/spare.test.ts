// The spare editor's timing (docs/desktop.md §3.1), with the window's parts faked: made 3 s after the content is
// ready, adopted once, replaced 3 s after the adoption, at most one, off under DESIGNER_DISABLE_SPARE, dropped when
// its renderer dies, gone with the window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabAttach } from "../shared/ipc";
import { MAX_SPARE_CRASHES, SPARE_DELAY_MS, SpareEditor, type SpareHost } from "./spare";

interface FakeView {
  id: number;
  destroyed: boolean;
  gone: (() => void) | null;
}

function fakeHost(env: Record<string, string | undefined> = {}) {
  let next = 1;
  const created: FakeView[] = [];
  const attached: { view: FakeView; attach: TabAttach }[] = [];
  const logs: string[] = [];
  const host: SpareHost<FakeView> = {
    create: () => {
      const view: FakeView = { id: next++, destroyed: false, gone: null };
      created.push(view);
      return view;
    },
    destroy: (view) => {
      view.destroyed = true;
    },
    attach: (view, attach) => attached.push({ view, attach }),
    onGone: (view, cb) => {
      view.gone = cb;
      return () => {
        if (view.gone === cb) view.gone = null;
      };
    },
    env,
    log: (m) => logs.push(m),
  };
  return { host, created, attached, logs };
}

const ATTACH: TabAttach = { tabId: "t1", fileKey: "f1", mode: "edit" };

describe("SpareEditor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("makes one spare 3 s after the content is ready, and only one", () => {
    const { host, created } = fakeHost();
    const spare = new SpareEditor(host);
    spare.ready();
    spare.ready();
    expect(created).toHaveLength(0);
    vi.advanceTimersByTime(SPARE_DELAY_MS - 1);
    expect(created).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(created).toHaveLength(1);
    expect(spare.view()).toBe(created[0]);
    spare.ready();
    vi.advanceTimersByTime(60_000);
    expect(created).toHaveLength(1);
  });

  it("is adopted once — told its tab and file — and a new one comes 3 s later", () => {
    const { host, created, attached } = fakeHost();
    const spare = new SpareEditor(host);
    spare.ready();
    vi.advanceTimersByTime(SPARE_DELAY_MS);
    const first = created[0];
    expect(spare.adopt(ATTACH)).toBe(first);
    expect(attached).toEqual([{ view: first, attach: ATTACH }]);
    expect(spare.view()).toBeNull();
    // The adopted view is the tab's now: its death is the tab's business, not the spare's.
    expect(first.gone).toBeNull();
    // Nothing to adopt until the next one is made.
    expect(spare.adopt({ ...ATTACH, tabId: "t2" })).toBeNull();
    vi.advanceTimersByTime(SPARE_DELAY_MS - 1);
    expect(created).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(created).toHaveLength(2);
    expect(spare.view()).toBe(created[1]);
    expect(first.destroyed).toBe(false);
  });

  it("is off under DESIGNER_DISABLE_SPARE=1", () => {
    const { host, created } = fakeHost({ DESIGNER_DISABLE_SPARE: "1" });
    const spare = new SpareEditor(host);
    expect(spare.enabled).toBe(false);
    spare.ready();
    vi.advanceTimersByTime(60_000);
    expect(created).toHaveLength(0);
    expect(spare.adopt(ATTACH)).toBeNull();
  });

  it("reads the flag from process.env by default", () => {
    const fromProcess = () => ({ ...fakeHost().host, env: undefined });
    vi.stubEnv("DESIGNER_DISABLE_SPARE", "1");
    try {
      expect(new SpareEditor(fromProcess()).enabled).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(new SpareEditor(fromProcess()).enabled).toBe(true);
  });

  it("drops a spare whose renderer died and makes another 3 s later", () => {
    const { host, created } = fakeHost();
    const spare = new SpareEditor(host);
    spare.ready();
    vi.advanceTimersByTime(SPARE_DELAY_MS);
    const first = created[0];
    first.gone!();
    expect(first.destroyed).toBe(true);
    expect(spare.view()).toBeNull();
    expect(spare.adopt(ATTACH)).toBeNull();
    vi.advanceTimersByTime(SPARE_DELAY_MS);
    expect(created).toHaveLength(2);
    expect(spare.view()).toBe(created[1]);
  });

  it("gives up after the renderer died a few times in a row, and starts over after an adoption", () => {
    const { host, created, logs } = fakeHost();
    const spare = new SpareEditor(host);
    spare.ready();
    for (let i = 0; i < MAX_SPARE_CRASHES; i++) {
      vi.advanceTimersByTime(SPARE_DELAY_MS);
      expect(created).toHaveLength(i + 1);
      created[i].gone!();
    }
    vi.advanceTimersByTime(60_000);
    expect(created).toHaveLength(MAX_SPARE_CRASHES);
    expect(logs).toHaveLength(1);
    // The content ready again (nothing happens: it is the crash count that stopped it), then a crash-free adoption resets it.
    spare.ready();
    vi.advanceTimersByTime(SPARE_DELAY_MS);
    expect(created).toHaveLength(MAX_SPARE_CRASHES + 1);
    expect(spare.adopt(ATTACH)).toBe(created[MAX_SPARE_CRASHES]);
    vi.advanceTimersByTime(SPARE_DELAY_MS);
    expect(created).toHaveLength(MAX_SPARE_CRASHES + 2);
  });

  it("is destroyed with the window: the view closed, no timer left", () => {
    const { host, created } = fakeHost();
    const spare = new SpareEditor(host);
    spare.ready();
    vi.advanceTimersByTime(SPARE_DELAY_MS);
    spare.adopt(ATTACH);
    // A replacement is on its way; destroying cancels it.
    spare.destroy();
    vi.advanceTimersByTime(60_000);
    expect(created).toHaveLength(1);
    // And a live spare is closed.
    const again = fakeHost();
    const second = new SpareEditor(again.host);
    second.ready();
    vi.advanceTimersByTime(SPARE_DELAY_MS);
    expect(again.created[0].destroyed).toBe(false);
    second.destroy();
    expect(again.created[0].destroyed).toBe(true);
    expect(second.view()).toBeNull();
    second.ready();
    vi.advanceTimersByTime(60_000);
    expect(again.created).toHaveLength(1);
  });

  it("uses the injected timers", () => {
    const timers = { setTimeout: vi.fn((fn: () => void, _ms: number) => fn as unknown), clearTimeout: vi.fn() };
    const { host, created } = fakeHost();
    const spare = new SpareEditor({ ...host, timers });
    spare.ready();
    expect(timers.setTimeout).toHaveBeenCalledWith(expect.any(Function), SPARE_DELAY_MS);
    (timers.setTimeout.mock.calls[0][0] as () => void)();
    expect(created).toHaveLength(1);
    spare.adopt(ATTACH);
    spare.destroy();
    expect(timers.clearTimeout).toHaveBeenCalledTimes(1);
  });
});
