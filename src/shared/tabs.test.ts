import { describe, expect, it } from "vitest";
import { emptyTabs, HOME, neighbourTab, persistable, restoreTabs, tabAtShortcut, tabsReducer, type TabsState } from "./tabs";

const open = (state: TabsState, fileKey: string, extra: object = {}) => tabsReducer(state, { type: "open", fileKey, id: fileKey.toUpperCase(), ...extra });
const keys = (s: TabsState) => s.tabs.map((t) => t.fileKey);

describe("tabsReducer", () => {
  it("opens next to the one in front, at the end from Home, one tab per file", () => {
    let s = open(emptyTabs(), "a", { title: "Landing" });
    s = open(s, "b");
    expect(s.tabs.map((t) => [t.fileKey, t.title])).toEqual([
      ["a", "Landing"],
      ["b", "Untitled"],
    ]);
    s = tabsReducer(s, { type: "activate", id: "A" });
    s = open(s, "c");
    expect(keys(s)).toEqual(["a", "c", "b"]);
    expect(s.active).toBe("C");
    s = tabsReducer(s, { type: "activate", id: HOME });
    s = open(s, "d");
    expect(keys(s)).toEqual(["a", "c", "b", "d"]);
    const again = open(s, "a");
    expect(again.tabs).toHaveLength(4);
    expect(again.active).toBe("A");
    expect(tabsReducer(s, { type: "open", fileKey: "" })).toBe(s);
    // In the background: Home stays in front.
    expect(open(s, "e", { background: true }).active).toBe("D");
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
    expect(s.closed.map((c) => c.fileKey)).toEqual(["a", "c", "b"]);
  });

  it("moves without touching anything else, and reopens the last closed (once in the history)", () => {
    let s = open(open(open(emptyTabs(), "a"), "b"), "c");
    const before = s.tabs.map((t) => t.id);
    s = tabsReducer(s, { type: "move", id: "A", to: 2 });
    expect(keys(s)).toEqual(["b", "c", "a"]);
    expect([...s.tabs.map((t) => t.id)].sort()).toEqual([...before].sort());
    s = tabsReducer(s, { type: "close", ids: ["C"] });
    s = open(s, "c", { id: "C2" });
    expect(s.closed).toEqual([]);
    s = tabsReducer(s, { type: "close", ids: ["C2"] });
    s = tabsReducer(s, { type: "reopen", id: "NEWC" });
    expect(s.active).toBe("NEWC");
    expect(s.tabs.find((t) => t.id === "NEWC")?.fileKey).toBe("c");
    expect(s.closed).toEqual([]);
  });

  it("takes reports and statuses, returning the same state when nothing changed", () => {
    const s = open(emptyTabs(), "a");
    const r = tabsReducer(s, { type: "report", id: "A", report: { title: "A", status: "ready" } });
    expect(r.tabs[0]).toMatchObject({ title: "A", status: "ready" });
    expect(tabsReducer(r, { type: "report", id: "A", report: { title: "A" } })).toBe(r);
    expect(tabsReducer(r, { type: "status", id: "A", status: "crashed" }).tabs[0].status).toBe("crashed");
  });

  it("follows renames, and a trashed file's tabs close without entering the closed history", () => {
    let s = open(open(open(emptyTabs(), "k1"), "k2"), "k3");
    s = tabsReducer(s, { type: "close", ids: ["K3"] });
    s = tabsReducer(s, { type: "retitle-file", fileKey: "k3", title: "Renamed" });
    expect(s.closed).toEqual([{ kind: "file", fileKey: "k3", title: "Renamed" }]);
    s = tabsReducer(s, { type: "retitle-file", fileKey: "k1", title: "One" });
    expect(s.tabs[0].title).toBe("One");
    expect(tabsReducer(s, { type: "retitle-file", fileKey: "k1", title: "One" })).toBe(s);
    s = tabsReducer(s, { type: "activate", id: "K1" });
    s = tabsReducer(s, { type: "drop-file", fileKey: "k1" });
    expect(s.tabs.map((t) => t.id)).toEqual(["K2"]);
    expect(s.active).toBe("K2");
    s = tabsReducer(s, { type: "drop-file", fileKey: "k3" });
    expect(s.closed).toEqual([]);
    expect(tabsReducer(s, { type: "drop-file", fileKey: "nope" })).toBe(s);
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
    let s = open(open(emptyTabs(), "a", { title: "One" }), "b");
    s = tabsReducer(s, { type: "close", ids: ["A"] });
    const back = restoreTabs(JSON.parse(JSON.stringify(persistable(s))));
    expect(back.tabs.map((t) => [t.id, t.fileKey, t.status])).toEqual([["B", "b", "discarded"]]);
    expect(back.active).toBe("B");
    expect(back.closed).toEqual([{ kind: "file", fileKey: "a", title: "One" }]);
  });

  it("drops what is malformed, and the old site admin's tabs", () => {
    const back = restoreTabs({
      tabs: [{ kind: "project", slug: "x" }, { kind: "file", fileKey: "../x" }, { kind: "file", fileKey: "k", id: "home" }, { kind: "file", fileKey: "k" }, null],
      active: "gone",
      closed: [{ kind: "cv", slug: "cv" }],
    });
    expect(back.tabs).toHaveLength(1);
    expect(back.tabs[0].id).not.toBe(HOME);
    expect(back.active).toBe(HOME);
    expect(back.closed).toEqual([]);
    expect(restoreTabs(null)).toEqual(emptyTabs());
  });
});

describe("prototype tabs (Present, R8 §9)", () => {
  it("one per file and starting frame, beside the file's own tab; closed and reopened with their place; kept between launches", () => {
    let s = tabsReducer(emptyTabs(), { type: "open", fileKey: "F1", title: "App", id: "t1" });
    s = tabsReducer(s, { type: "open", kind: "prototype", fileKey: "F1", title: "App", pageId: "0:1", startNodeId: "2:1", id: "p1" });
    expect(s.tabs.map((t) => [t.id, t.kind])).toEqual([["t1", "file"], ["p1", "prototype"]]);
    expect(s.tabs[1]).toMatchObject({ pageId: "0:1", startNodeId: "2:1" });
    expect(s.active).toBe("p1");
    // The file again: its own tab, not the prototype's.
    s = tabsReducer(s, { type: "open", fileKey: "F1" });
    expect(s.active).toBe("t1");
    // The same prototype again: the same tab; another start: another tab.
    s = tabsReducer(s, { type: "open", kind: "prototype", fileKey: "F1", pageId: "0:1", startNodeId: "2:1" });
    expect(s.active).toBe("p1");
    s = tabsReducer(s, { type: "open", kind: "prototype", fileKey: "F1", pageId: "0:1", startNodeId: "2:10", id: "p2" });
    expect(s.tabs).toHaveLength(3);
    // Kept and restored.
    const kept = restoreTabs(JSON.parse(JSON.stringify(persistable(s))));
    expect(kept.tabs.map((t) => [t.kind, t.startNodeId ?? null])).toEqual([["file", null], ["prototype", "2:1"], ["prototype", "2:10"]]);
    // Closed, then ⇧⌘T brings it back as a prototype tab.
    s = tabsReducer(s, { type: "close", ids: ["p1"] });
    expect(s.closed[0]).toMatchObject({ kind: "prototype", fileKey: "F1", startNodeId: "2:1" });
    s = tabsReducer(s, { type: "reopen", id: "p3" });
    expect(s.tabs.find((t) => t.id === "p3")).toMatchObject({ kind: "prototype", startNodeId: "2:1", pageId: "0:1" });
    // A file trashed: its prototype tabs go too.
    s = tabsReducer(s, { type: "drop-file", fileKey: "F1" });
    expect(s.tabs).toEqual([]);
  });
});
