import { describe, expect, it } from "vitest";
import { discardable, emptyTabs, HOME, liveAtStart, MAX_CLOSED, neighbourTab, NEW_TAB, persistable, restoreTabs, splitPartner, tabAtShortcut, tabsReducer, type TabsState } from "./tabs";

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

describe("another account (docs/desktop.md §18.7)", () => {
  it("resets: every file tab and the closed history gone, Home in front", () => {
    let s: TabsState = emptyTabs();
    s = tabsReducer(s, { type: "open", fileKey: "k1", title: "One" });
    s = tabsReducer(s, { type: "open", fileKey: "k2", title: "Two" });
    s = tabsReducer(s, { type: "close", ids: [s.tabs[0].id] });
    expect(s.closed.length).toBe(1);
    s = tabsReducer(s, { type: "reset" });
    expect(s).toEqual({ tabs: [], active: HOME, closed: [] });
    expect(tabsReducer(s, { type: "reset" })).toBe(s);
  });
});

describe("Figma's tab rules (atlas 01 §2.3–2.7)", () => {
  const four = () => open(open(open(open(emptyTabs(), "a"), "b"), "c"), "d");
  const ids = (s: TabsState) => s.tabs.map((t) => t.id);

  it("keeps 100 closed tabs, never the new-tab page", () => {
    let s = emptyTabs();
    for (let i = 0; i < 105; i++) s = open(s, `k${i}`);
    s = tabsReducer(s, { type: "close", ids: ids(s) });
    expect(s.closed).toHaveLength(MAX_CLOSED);
    expect(MAX_CLOSED).toBe(100);
    s = tabsReducer(s, { type: "open", kind: "new-tab", fileKey: "", id: "N1" });
    s = tabsReducer(s, { type: "open", kind: "new-tab", fileKey: "", id: "N2" });
    expect(s.tabs.map((t) => [t.id, t.title])).toEqual([
      ["N1", NEW_TAB],
      ["N2", NEW_TAB],
    ]);
    const before = s.closed;
    s = tabsReducer(s, { type: "close", ids: ["N1"] });
    expect(s.closed).toEqual(before);
  });

  it("a file picked on the new-tab page takes its place, or brings its open tab forward", () => {
    let s = open(open(emptyTabs(), "a"), "b");
    s = tabsReducer(s, { type: "activate", id: "A" });
    s = tabsReducer(s, { type: "open", kind: "new-tab", fileKey: "", id: "N" });
    expect(ids(s)).toEqual(["A", "N", "B"]);
    s = tabsReducer(s, { type: "open", fileKey: "c", id: "C", replace: "N" });
    expect(ids(s)).toEqual(["A", "C", "B"]);
    expect(s.active).toBe("C");
    s = tabsReducer(s, { type: "open", kind: "new-tab", fileKey: "", id: "N2" });
    s = tabsReducer(s, { type: "open", fileKey: "a", replace: "N2", at: 5 });
    expect(ids(s)).toEqual(["A", "C", "B"]);
    expect(s.active).toBe("A");
    expect(s.tabs[0].viewedAt).toBe(5);
  });

  it("pins: first, out of any group, moving only among the pinned", () => {
    let s = four();
    s = tabsReducer(s, { type: "group-add", ids: ["C"], groupId: "g1" });
    s = tabsReducer(s, { type: "pin", id: "C", pinned: true });
    expect(ids(s)).toEqual(["C", "A", "B", "D"]);
    expect(s.tabs[0].groupId).toBeUndefined();
    expect(s.groups).toBeUndefined();
    s = tabsReducer(s, { type: "pin", id: "D", pinned: true });
    expect(ids(s)).toEqual(["C", "D", "A", "B"]);
    // Neither out of the pinned run nor into it.
    expect(ids(tabsReducer(s, { type: "move", id: "C", to: 3 }))).toEqual(["D", "C", "A", "B"]);
    expect(ids(tabsReducer(s, { type: "move", id: "B", to: 0 }))).toEqual(["C", "D", "B", "A"]);
    // Pinned tabs never join a group.
    expect(tabsReducer(s, { type: "group-add", ids: ["C"], groupId: "g2" })).toBe(s);
    s = tabsReducer(s, { type: "pin", id: "C", pinned: false });
    expect(ids(s)).toEqual(["D", "C", "A", "B"]);
    expect(s.tabs[1].pinned).toBeUndefined();
  });

  it("groups: Group {number} in Figma's colours, kept together, gone when empty", () => {
    let s = four();
    s = tabsReducer(s, { type: "group-add", ids: ["B", "D"], groupId: "g1" });
    expect(ids(s)).toEqual(["A", "B", "D", "C"]);
    expect(s.groups).toEqual([{ id: "g1", number: 1, name: "", color: "blue" }]);
    s = tabsReducer(s, { type: "group-add", ids: ["C"], groupId: "g2" });
    expect(s.groups?.[1]).toMatchObject({ number: 2, color: "red" });
    s = tabsReducer(s, { type: "group-set", groupId: "g1", name: "  Work  ", color: "green" });
    expect(s.groups?.[0]).toMatchObject({ name: "Work", color: "green" });
    expect(tabsReducer(s, { type: "group-set", groupId: "g1", name: "Work" })).toBe(s);
    // A file opened from a grouped tab joins its group.
    s = tabsReducer(s, { type: "activate", id: "B" });
    s = open(s, "e");
    expect(ids(s)).toEqual(["A", "B", "E", "D", "C"]);
    expect(s.tabs[2].groupId).toBe("g1");
    // Dragged out of the group's run: out of it; between two of its tabs: in it.
    s = tabsReducer(s, { type: "move", id: "E", to: 0 });
    expect(s.tabs[0]).not.toHaveProperty("groupId");
    s = tabsReducer(s, { type: "move", id: "A", to: 2 });
    expect(ids(s)).toEqual(["E", "B", "A", "D", "C"]);
    expect(s.tabs[2].groupId).toBe("g1");
    s = tabsReducer(s, { type: "group-remove", ids: ["B"] });
    expect(ids(s)).toEqual(["E", "A", "D", "B", "C"]);
    s = tabsReducer(s, { type: "ungroup", groupId: "g1" });
    expect(s.groups?.map((g) => g.id)).toEqual(["g2"]);
    // The last tab of a group closed: the group goes; its number is free again.
    s = tabsReducer(s, { type: "close", ids: ["C"] });
    expect(s.groups).toBeUndefined();
    s = tabsReducer(s, { type: "group-add", ids: ["E"], groupId: "g3" });
    expect(s.groups?.[0]).toMatchObject({ number: 1, color: "blue" });
  });

  it("keeps pins, groups and when each was viewed between launches", () => {
    let s = four();
    s = tabsReducer(s, { type: "pin", id: "D", pinned: true });
    s = tabsReducer(s, { type: "group-add", ids: ["A", "B"], groupId: "g1" });
    s = tabsReducer(s, { type: "activate", id: "C", at: 1234 });
    s = tabsReducer(s, { type: "open", kind: "new-tab", fileKey: "", id: "N" });
    const back = restoreTabs(JSON.parse(JSON.stringify(persistable(s))));
    expect(back.tabs.map((t) => [t.id, t.pinned ?? false, t.groupId ?? null])).toEqual([
      ["D", true, null],
      ["A", false, "g1"],
      ["B", false, "g1"],
      ["C", false, null],
      ["N", false, null],
    ]);
    expect(back.tabs[3].viewedAt).toBe(1234);
    expect(back.groups).toEqual(s.groups);
    // A group that isn't kept: its tabs restored without it.
    const orphan = restoreTabs({ tabs: [{ id: "X", kind: "file", fileKey: "x", groupId: "gone" }], groups: [{ id: "../" }] });
    expect(orphan.tabs[0]).not.toHaveProperty("groupId");
    expect(orphan.groups).toBeUndefined();
  });

  it("offloads loaded file tabs unseen for 48 h, oldest first, keeping 3 live and never with fewer than 5 tabs", () => {
    const H = 3_600_000;
    const now = 100 * 24 * H;
    let s = emptyTabs();
    for (const [k, ago] of [["a", 50], ["b", 60], ["c", 1], ["d", 70], ["e", 80], ["f", 90]] as const) s = open(s, k, { at: now - ago * H });
    s = tabsReducer(s, { type: "pin", id: "F", pinned: true });
    s = tabsReducer(s, { type: "activate", id: "C" });
    const loaded = new Set(ids(s));
    // F pinned, C in front; then by age E, D, B, A — six loaded, three kept.
    expect(discardable(s, loaded, now)).toEqual(["E", "D", "B"]);
    expect(discardable(s, new Set(["A", "C"]), now)).toEqual([]);
    expect(discardable(tabsReducer(s, { type: "close", ids: ["F", "E"] }), loaded, now)).toEqual([]);
    // At launch: the most recently viewed, the one in front counted.
    expect(liveAtStart(s, 3)).toEqual(["A", "B"]);
  });

  it("split tabs: the tab opened beside the one in front, kept next to it in its group, separated again", () => {
    let s = four();
    s = tabsReducer(s, { type: "group-add", ids: ["A"], groupId: "g1" });
    s = tabsReducer(s, { type: "activate", id: "A" });
    s = tabsReducer(s, { type: "split", id: "D", with: "A" });
    expect(ids(s)).toEqual(["A", "D", "B", "C"]);
    expect(s.active).toBe("D");
    expect(splitPartner(s, "A")?.id).toBe("D");
    expect(s.tabs[1].groupId).toBe("g1");
    // Neither half splits again; pinned tabs don't split.
    expect(tabsReducer(s, { type: "split", id: "B", with: "A" })).toBe(s);
    const pinned = tabsReducer(tabsReducer(four(), { type: "pin", id: "B", pinned: true }), { type: "split", id: "B", with: "A" });
    expect(splitPartner(pinned, "B")).toBeUndefined();
    // Dragged away, the other half follows; a file opened from it lands after the pair.
    let moved = tabsReducer(s, { type: "move", id: "A", to: 3 });
    expect(ids(moved).join()).toMatch(/A,D/);
    moved = tabsReducer(tabsReducer(s, { type: "activate", id: "A" }), { type: "open", fileKey: "e", id: "E" });
    expect(ids(moved)).toEqual(["A", "D", "E", "B", "C"]);
    // Pinning one half, closing it or Separate Tabs leaves the other a tab of its own.
    expect(splitPartner(tabsReducer(s, { type: "pin", id: "D", pinned: true }), "A")).toBeUndefined();
    expect(tabsReducer(s, { type: "close", ids: ["D"] }).tabs[0]).not.toHaveProperty("splitWith");
    const apart = tabsReducer(s, { type: "unsplit", id: "A" });
    expect(apart.tabs.some((t) => t.splitWith)).toBe(false);
    expect(ids(apart)).toEqual(["A", "D", "B", "C"]);
    // Kept between launches.
    expect(splitPartner(restoreTabs(persistable(s)), "D")?.id).toBe("A");
    // The half beside the one in front is never offloaded.
    const H = 3_600_000;
    expect(discardable({ ...s, tabs: s.tabs.map((t) => ({ ...t, viewedAt: 1 })), active: "D" }, new Set(ids(s)), 100 * H)).not.toContain("A");
  });

  it("moves tabs between windows without the closed history", () => {
    let s = four();
    s = tabsReducer(s, { type: "activate", id: "B" });
    const moving = s.tabs.filter((t) => t.id === "B");
    const left = tabsReducer(s, { type: "detach", ids: ["B"] });
    expect(ids(left)).toEqual(["A", "C", "D"]);
    expect(left.active).toBe("C");
    expect(left.closed).toEqual(s.closed);
    let other = tabsReducer(open(emptyTabs(), "x"), { type: "group-add", ids: ["X"], groupId: "g9" });
    other = tabsReducer(other, { type: "adopt", tabs: [{ ...moving[0], groupId: "g1" }], at: 7 });
    expect(ids(other)).toEqual(["X", "B"]);
    expect(other.active).toBe("B");
    expect(other.tabs[1]).not.toHaveProperty("groupId");
    expect(other.tabs[1].viewedAt).toBe(7);
    // A file already open there isn't opened twice.
    expect(tabsReducer(other, { type: "adopt", tabs: [{ ...moving[0], id: "Q" }] })).toBe(other);
  });
});
