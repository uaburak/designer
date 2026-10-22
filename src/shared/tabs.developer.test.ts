import { describe, expect, it } from "vitest";
import { emptyTabs, isPageTab, persistable, restoreTabs, tabsReducer } from "./tabs";

// Home's Developer button: the design system's gallery in a tab of its own — one at most, a page (no file), never in
// the closed history, not kept between launches.
describe("the Developer tab", () => {
  const open = (s = emptyTabs()) => tabsReducer(s, { type: "open", kind: "developer", fileKey: "", title: "Developer", id: "dev1", at: 1 });

  it("opens once, in front, and comes forward when opened again", () => {
    let s = open();
    expect(s.tabs).toMatchObject([{ id: "dev1", kind: "developer", fileKey: "", title: "Developer", status: "loading" }]);
    expect(s.active).toBe("dev1");
    s = tabsReducer(s, { type: "activate", id: "home" });
    s = tabsReducer(s, { type: "open", kind: "developer", fileKey: "", title: "Developer", at: 2 });
    expect(s.tabs).toHaveLength(1);
    expect(s.active).toBe("dev1");
    expect(isPageTab(s.tabs[0])).toBe(true);
  });

  it("closes without a closed entry and isn't restored", () => {
    const s = open();
    expect(tabsReducer(s, { type: "close", ids: ["dev1"] }).closed).toEqual([]);
    expect(restoreTabs(persistable(s)).tabs).toEqual([]);
  });
});
