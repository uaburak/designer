// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { TabBar, type TabBarProps } from "../components/TabBar";
import { $, $$, box, click, focus, key, mount, pointer, spy, type Mounted } from "./dom";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

/** React's drag listeners sit on window for move/up. */
function windowPointer(type: "pointermove" | "pointerup", clientX: number) {
  act(() => {
    window.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX, clientY: 19 }));
  });
}

const TABS = [
  { id: "a", title: "Alpha" },
  { id: "b", title: "Beta", dirty: true },
  { id: "c", title: "Gamma" },
];

function setup(props: Partial<TabBarProps> = {}) {
  const onActivate = spy<[string]>();
  const onClose = spy<[string]>();
  const onMove = spy<[string, number]>();
  m = mount(TabBar, { tabs: TABS, active: "a", onActivate, onClose, onMove, ...props } as TabBarProps);
  // Home 80…120, then three 120px tabs: a 120…240, b 240…360, c 360…480
  $$("[data-tab-id]").forEach((el, i) => box(el, { left: 120 + i * 120, top: 0, width: 120, height: 37 }));
  return { onActivate, onClose, onMove };
}

const tab = (id: string) => $(`[data-tab-id="${id}"]`);

describe("TabBar drag", () => {
  it("a press activates the tab; under 4px of travel it is a click, not a move", () => {
    const { onActivate, onMove } = setup({ active: "b" });
    pointer(tab("a"), "pointerdown", { clientX: 180, clientY: 19 });
    expect(onActivate.calls).toEqual([["a"]]);
    windowPointer("pointermove", 183);
    expect(tab("a").dataset.dragging).toBeUndefined();
    windowPointer("pointerup", 183);
    expect(onMove.calls).toHaveLength(0);
  });

  it("drags a tab past the others: it follows the pointer, they make room, and the drop reports the new index", () => {
    const { onMove } = setup();
    pointer(tab("a"), "pointerdown", { clientX: 180, clientY: 19 });
    windowPointer("pointermove", 330); // a's middle 180 → 330: past b's middle (300), short of c's (420)
    expect(tab("a").dataset.dragging).toBeDefined();
    expect(tab("a").style.transform).toBe("translateX(150px)");
    expect(tab("b").style.transform).toBe("translateX(-120px)");
    expect(tab("c").style.transform).toBe("");
    windowPointer("pointermove", 450); // past c too
    expect(tab("c").style.transform).toBe("translateX(-120px)");
    windowPointer("pointerup", 450);
    expect(onMove.calls).toEqual([["a", 2]]);
    expect(tab("a").dataset.dragging).toBeUndefined();
    expect(tab("b").style.transform).toBe("");
  });

  it("drags a tab leftwards", () => {
    const { onMove } = setup({ active: "c" });
    pointer(tab("c"), "pointerdown", { clientX: 420, clientY: 19 });
    windowPointer("pointermove", 170); // c's middle 420 → 170: before a's middle (180)
    expect(tab("a").style.transform).toBe("translateX(120px)");
    expect(tab("b").style.transform).toBe("translateX(120px)");
    windowPointer("pointerup", 170);
    expect(onMove.calls).toEqual([["c", 0]]);
  });

  it("a press on the close button neither activates nor drags; the click closes", () => {
    const { onActivate, onClose, onMove } = setup();
    const close = $('[data-tab-id="b"] button');
    pointer(close, "pointerdown", { clientX: 350, clientY: 19 });
    windowPointer("pointermove", 100);
    windowPointer("pointerup", 100);
    click(close);
    expect(onActivate.calls).toHaveLength(0);
    expect(onMove.calls).toHaveLength(0);
    expect(onClose.calls).toEqual([["b"]]);
  });

  it("a middle click closes; a right press does not start a drag", () => {
    const { onClose, onMove, onActivate } = setup();
    act(() => {
      tab("c").dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    });
    expect(onClose.calls).toEqual([["c"]]);
    pointer(tab("b"), "pointerdown", { clientX: 300, button: 2 });
    windowPointer("pointermove", 450);
    windowPointer("pointerup", 450);
    expect(onMove.calls).toHaveLength(0);
    expect(onActivate.calls).toHaveLength(0);
  });

  it("← → move between Home and the tabs, bringing each forward", () => {
    const { onActivate } = setup();
    focus(tab("a"));
    key(tab("a"), "ArrowRight");
    expect(onActivate.calls.at(-1)).toEqual(["b"]);
    key(document.activeElement!, "ArrowLeft");
    key(document.activeElement!, "ArrowLeft");
    expect(onActivate.calls.at(-1)).toEqual(["home"]);
    key(document.activeElement!, "ArrowLeft"); // wraps to the last tab
    expect(onActivate.calls.at(-1)).toEqual(["c"]);
  });

  it("marks unsaved tabs with the dot", () => {
    setup();
    expect(tab("b").dataset.dirty).toBeDefined();
    expect($('[data-tab-id="b"] [aria-label="Unsaved changes"]')).not.toBeNull();
    expect($('[data-tab-id="a"] [aria-label="Unsaved changes"]')).toBeNull();
  });
});

describe("TabBar pins, groups and the tabs menu (atlas 01 §2.3–2.5)", () => {
  it("says a pinned tab is pinned, puts a group's name before its tabs as pills, and renames it in place", () => {
    const onGroupMenu = spy<[string, { x: number; y: number }]>();
    const onRenameGroup = spy<[string, string | null]>();
    const tabs = [
      { id: "p", title: "Pinned", pinned: true },
      { id: "a", title: "Alpha", groupId: "g" },
      { id: "b", title: "Beta", groupId: "g" },
      { id: "c", title: "Gamma" },
    ];
    const props = { tabs, groups: [{ id: "g", name: "Work", color: "green" as const }], active: "a", onActivate: spy<[string]>(), onClose: spy<[string]>(), onGroupMenu, onRenameGroup };
    m = mount(TabBar, props);
    expect(tab("p").getAttribute("aria-label")).toBe("Pinned tab: Pinned");
    const labels = $$('[data-group-id="g"]');
    expect(labels).toHaveLength(1);
    expect(labels[0].textContent).toBe("Work");
    expect(labels[0].dataset.color).toBe("green");
    // The name sits right before the group's first tab.
    expect(labels[0].nextElementSibling).toBe(tab("a"));
    expect(tab("a").dataset.grouped).toBe("green");
    expect(tab("c").dataset.grouped).toBeUndefined();
    act(() => {
      labels[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 6 }));
    });
    expect(onGroupMenu.calls).toEqual([["g", { x: 5, y: 6 }]]);
    m.rerender(TabBar, { ...props, editingGroup: "g" });
    const input = $('[data-group-id="g"] input') as HTMLInputElement;
    focus(input);
    input.value = "Later";
    key(input, "Escape");
    expect(onRenameGroup.calls).toEqual([["g", null]]);
  });

  it("has the tabs menu at the right end, and the + says New file", () => {
    const onTabsMenu = spy<[{ x: number; y: number }]>();
    const onNew = spy<[]>();
    m = mount(TabBar, { tabs: TABS, active: "a", onActivate: spy<[string]>(), onClose: spy<[string]>(), onTabsMenu, onNew });
    click($('[aria-label="Open and recently closed tabs"]'));
    expect(onTabsMenu.calls).toHaveLength(1);
    click($('[aria-label="New file"]'));
    expect(onNew.calls).toHaveLength(1);
  });
});
