// @vitest-environment happy-dom
// The presentation's Website behaviours switch and Keep state on reload (webBehaviours.ts): the viewer's own settings in
// this browser, a link's web-behaviours=0, the menu rows, the kept state's key.
import { beforeEach, describe, expect, it } from "vitest";
import { presentUrlOptions } from "./PresentationView";
import { forgetKeptState, keptStateKey, readWebOptions, webBehavioursParam, webMenuEntries, writeWebOptions } from "./webBehaviours";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("Website behaviours", () => {
  it("is on by default, Keep state on reload off; both remembered in this browser", () => {
    expect(readWebOptions()).toEqual({ websiteBehaviours: true, keepState: false });
    writeWebOptions({ websiteBehaviours: false });
    expect(readWebOptions()).toEqual({ websiteBehaviours: false, keepState: false });
    writeWebOptions({ keepState: true });
    expect(readWebOptions()).toEqual({ websiteBehaviours: false, keepState: true });
    localStorage.setItem("designer.present.web", "not json");
    expect(readWebOptions()).toEqual({ websiteBehaviours: true, keepState: false });
  });

  it("a prototype link's web-behaviours=0 turns it off for that view", () => {
    expect(webBehavioursParam(new URLSearchParams("web-behaviours=0"))).toBe(false);
    expect(webBehavioursParam(new URLSearchParams("scaling=contain"))).toBeUndefined();
    expect(presentUrlOptions(new URLSearchParams("web-behaviours=0&hotspot-hints=0"))).toEqual({ hints: false, websiteBehaviours: false });
  });

  it("the Advanced settings rows: the engine's state wins; Keep state on reload needs Website behaviours", () => {
    const rows = (s: { websiteBehaviours?: boolean } | null) =>
      webMenuEntries(s ? { active: true, events: [], ...s } : null).map((e) => (typeof e === "string" || "header" in e ? e : { id: e.id, checked: e.checked, disabled: e.disabled }));
    expect(rows(null)).toEqual([
      { id: "web", checked: true, disabled: undefined },
      { id: "keep-state", checked: false, disabled: false },
    ]);
    expect(rows({ websiteBehaviours: false })).toEqual([
      { id: "web", checked: false, disabled: undefined },
      { id: "keep-state", checked: false, disabled: true },
    ]);
  });

  it("keeps a prototype's state per file, page and start; forgetting it removes it", () => {
    const key = keptStateKey("file-1", "0:1", "1:2");
    expect(key).not.toBe(keptStateKey("file-1", "0:1", "1:3"));
    expect(key).not.toBe(keptStateKey("file-2", "0:1", "1:2"));
    sessionStorage.setItem(key, "{}");
    forgetKeptState(key);
    expect(sessionStorage.getItem(key)).toBeNull();
  });
});
