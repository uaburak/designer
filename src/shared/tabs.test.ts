import { describe, expect, it } from "vitest";
import { emptyTabs, HOME, neighbourTab, persistable, restoreTabs, tabAtShortcut, tabsReducer, type TabsState } from "./tabs";

const open = (state: TabsState, slug: string, extra: object = {}) => tabsReducer(state, { type: "open", kind: "project", slug, id: slug.toUpperCase(), ...extra });

describe("tabsReducer", () => {
  it("opens next to the one in front, at the end from Home, and dedupes", () => {
    let s = open(emptyTabs(), "a");
    s = open(s, "b");
    s = tabsReducer(s, { type: "activate", id: "A" });
    s = open(s, "c");
    expect(s.tabs.map((t) => t.slug)).toEqual(["a", "c", "b"]);
    expect(s.active).toBe("C");
    s = tabsReducer(s, { type: "activate", id: HOME });
    s = open(s, "d");
    expect(s.tabs.map((t) => t.slug)).toEqual(["a", "c", "b", "d"]);
    const again = open(s, "a");
    expect(again.tabs).toHaveLength(4);
    expect(again.active).toBe("A");
  });

  it("closing the one in front brings its right neighbour, then its left, then Home", () => {
    let s = open(open(open(emptyTabs(), "a"), "b"), "c");
    s = tabsReducer(s, { type: "activate", id: "B" });
    s = tabsReducer(s, { type: "close", ids: ["B"] });
    expect(s.active).toBe("C");
    s = tabsReducer(s, { type: "close", ids: ["C"] });
    expect(s.active).toBe("A");
    s = tabsReducer(s, { type: "close", ids: ["A"] });
    expect(s.active).toBe(HOME);
    expect(s.closed.map((c) => c.slug)).toEqual(["a", "c", "b"]);
  });

  it("moves without touching anything else, and reopens the last closed", () => {
    let s = open(open(open(emptyTabs(), "a"), "b"), "c");
    const before = s.tabs.map((t) => t.id);
    s = tabsReducer(s, { type: "move", id: "A", to: 2 });
    expect(s.tabs.map((t) => t.slug)).toEqual(["b", "c", "a"]);
    expect([...s.tabs.map((t) => t.id)].sort()).toEqual([...before].sort());
    s = tabsReducer(s, { type: "close", ids: ["C"] });
    s = tabsReducer(s, { type: "reopen", id: "NEWC" });
    expect(s.active).toBe("NEWC");
    expect(s.tabs.find((t) => t.id === "NEWC")?.slug).toBe("c");
    expect(s.closed).toEqual([]);
  });

  it("takes reports and statuses, returning the same state when nothing changed", () => {
    const s = open(emptyTabs(), "a");
    const r = tabsReducer(s, { type: "report", id: "A", report: { title: "A", dirty: true, status: "ready" } });
    expect(r.tabs[0]).toMatchObject({ title: "A", dirty: true, status: "ready" });
    expect(tabsReducer(r, { type: "report", id: "A", report: { dirty: true } })).toBe(r);
    expect(tabsReducer(r, { type: "status", id: "A", status: "crashed" }).tabs[0].status).toBe("crashed");
  });

  it("finds ⌘1–⌘9 and ⌃Tab neighbours", () => {
    const s = open(open(open(emptyTabs(), "a"), "b"), "c");
    expect(tabAtShortcut(s, 1)).toBe(HOME);
    expect(tabAtShortcut(s, 2)).toBe("A");
    expect(tabAtShortcut(s, 9)).toBe("C");
    expect(tabAtShortcut(s, 7)).toBeUndefined();
    expect(neighbourTab(s, 1)).toBe(HOME);
    expect(neighbourTab(s, -1)).toBe("B");
  });
});

describe("restoreTabs", () => {
  it("round-trips what persistable keeps, every tab not loaded", () => {
    let s = open(open(emptyTabs(), "a"), "b");
    s = tabsReducer(s, { type: "close", ids: ["A"] });
    const back = restoreTabs(JSON.parse(JSON.stringify(persistable(s))));
    expect(back.tabs.map((t) => [t.id, t.slug, t.status])).toEqual([["B", "b", "discarded"]]);
    expect(back.active).toBe("B");
    expect(back.closed.map((c) => c.slug)).toEqual(["a"]);
  });

  it("drops what is malformed", () => {
    const back = restoreTabs({ tabs: [{ kind: "nope", slug: "x" }, { kind: "cv", slug: "cv", id: "home" }, { kind: "cv", slug: "cv" }, null], active: "gone", closed: "x" });
    expect(back.tabs).toHaveLength(1);
    expect(back.tabs[0].id).not.toBe(HOME);
    expect(back.active).toBe(HOME);
    expect(restoreTabs(null)).toEqual(emptyTabs());
  });
});
