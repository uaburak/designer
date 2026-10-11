// The render helper's policy (docs/multiplayer.md §16.6) with a fake inbox: `rest-wanted` opens a hidden editor for
// a file the person owns while the switch is on; never for others' files, a file open in a tab or with the switch
// off; closed after five minutes without a job, or when a tab opens the file.
import { describe, expect, it } from "vitest";
import type { FileShareState, MultiplayerEvent } from "../shared/multiplayer/types";
import { HELPER_IDLE_MS, MAX_HELPERS, RestHelper } from "./restHelper";

const state = (role: FileShareState["role"]): FileShareState => ({ shared: true, key: "k", role, connection: "live", peers: [], requests: 0, me: 1, locked: false, policy: null });
const wanted = (fileKey: string, role: FileShareState["role"] = "owner"): MultiplayerEvent => ({ fileKey, state: state(role), restWanted: true });
const job = (fileKey: string): MultiplayerEvent => ({ fileKey, state: state("owner"), restJob: { id: "job12345", job: { kind: "variables_local" }, to: "r_1", seq: 1, name: "F", lastModified: 0 } });

function world(opts: { enabled?: boolean } = {}) {
  const clock = { t: 1_000_000 };
  const opened: string[] = [];
  const closed: string[] = [];
  const tabs = new Set<string>();
  let enabledCalls = 0;
  const helper = new RestHelper<string>({
    open: (fileKey) => (opened.push(fileKey), `view:${fileKey}`),
    close: (view) => void closed.push(view),
    openElsewhere: (fileKey) => tabs.has(fileKey),
    enabled: async () => (enabledCalls++, opts.enabled ?? true),
    now: () => clock.t,
    timers: { setInterval: () => 0, clearInterval: () => {} },
  });
  return { helper, clock, opened, closed, tabs, calls: () => enabledCalls };
}

describe("the render helper", () => {
  it("opens a hidden editor for a file the person owns when its room wants a renderer, once", async () => {
    const w = world();
    await w.helper.onEvent(wanted("a"));
    await w.helper.onEvent(wanted("a"));
    expect(w.opened).toEqual(["a"]);
    expect(w.helper.open()).toEqual(["a"]);
    // the switch is read once a minute
    await w.helper.onEvent(wanted("b"));
    expect(w.calls()).toBe(1);
  });

  it("never for files the person only edits or views, a file open in a tab, or with the switch off", async () => {
    const w = world();
    await w.helper.onEvent(wanted("e", "editor"));
    await w.helper.onEvent(wanted("v", "viewer"));
    w.tabs.add("t");
    await w.helper.onEvent(wanted("t"));
    expect(w.opened).toEqual([]);
    const off = world({ enabled: false });
    await off.helper.onEvent(wanted("a"));
    expect(off.opened).toEqual([]);
  });

  it("at most a few files at once", async () => {
    const w = world();
    for (let i = 0; i < MAX_HELPERS + 2; i++) await w.helper.onEvent(wanted(`f${i}`));
    expect(w.opened).toHaveLength(MAX_HELPERS);
  });

  it("closes after five minutes without a job, and when a tab opens the file", async () => {
    const w = world();
    await w.helper.onEvent(wanted("a"));
    await w.helper.onEvent(wanted("b"));
    w.clock.t += HELPER_IDLE_MS - 1000;
    await w.helper.onEvent(job("a"));
    w.clock.t += 2000;
    w.helper.sweep();
    expect(w.closed).toEqual(["view:b"]);
    w.tabs.add("a");
    w.helper.sweep();
    expect(w.closed).toEqual(["view:b", "view:a"]);
    expect(w.helper.open()).toEqual([]);
  });

  it("the switch turned off closes the helpers", async () => {
    const w = world();
    await w.helper.onEvent(wanted("a"));
    w.helper.settingChanged(false);
    expect(w.closed).toEqual(["view:a"]);
    await w.helper.onEvent(wanted("b"));
    expect(w.opened).toEqual(["a"]);
  });
});
