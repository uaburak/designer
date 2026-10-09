// @vitest-environment happy-dom
// Round 12 (live menus/main-view.txt, main-preferences.txt, toolbar/*): a submenu's bottom margin is 8 (View 105 + 787
// in a 900 high window; Preferences 5 by its `edgeBottom`), a menu holds live's measured width, and so do the tool
// menus and the vector edit toolbar's text buttons.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, type ContextMenuProps, type MenuEntry } from "../components/Menu";
import { placeMenu } from "../overlay/position";
import { EditorToolbar, TOOL_GROUPS, ToolTextButton, type EditorToolbarProps, type ToolId } from "../index";
import { $, $$, click, mount, spy, type Mounted } from "./dom";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  vi.restoreAllMocks();
});

const view = { width: 1440, height: 900 };

describe("round 12: menu geometry", () => {
  it("a submenu keeps 8 from the window's bottom (View 210, 105), Preferences 5, a tall one 6 from the top", () => {
    expect(placeMenu(210, 174, { width: 201, height: 787 }, view, 8, { top: 6, bottom: 8 })).toEqual({ x: 210, y: 105 });
    expect(placeMenu(210, 359, { width: 235, height: 763 }, view, 8, { top: 6, bottom: 5 })).toEqual({ x: 210, y: 132 });
    expect(placeMenu(210, 198, { width: 185, height: 1050 }, view, 8, { top: 6, bottom: 8 })).toEqual({ x: 210, y: 6 });
  });

  it("a submenu opens with the bottom margin of 8 (or its own `edgeBottom`)", () => {
    const rows = (n: number): MenuEntry[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, label: `Row ${i}` }));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "menuitem") return { left: 12, top: 182, right: 206, bottom: 206, width: 194, height: 24, x: 12, y: 182, toJSON: () => ({}) } as DOMRect;
      const h = this.querySelectorAll('[role="menuitem"]').length > 10 ? 787 : 48;
      return { left: 0, top: 0, right: 201, bottom: h, width: 201, height: h, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
    const tops = (edgeBottom?: number) => {
      m?.unmount();
      m = mount(ContextMenu, { at: { x: 12, y: 174 }, entries: [{ id: "view", label: "View", items: rows(30), width: 201, ...(edgeBottom === undefined ? {} : { edgeBottom }) }], onSelect: spy<[string]>(), onClose: spy<[]>() } as ContextMenuProps);
      click($('#ds-overlays [role="menuitem"]'));
      const sub = $$('#ds-overlays [role="menu"]').at(-1)!;
      return [sub.style.top, sub.style.width];
    };
    expect(tops()).toEqual(["105px", "201px"]);
    expect(tops(5)).toEqual(["108px", "201px"]);
  });

  it("a menu given live's width has it, its labels free to run into the gap before the keys", () => {
    m = mount(ContextMenu, { at: { x: 0, y: 0 }, context: true, width: 203, entries: [{ id: "a", label: "Go to main component", shortcut: "⌃⌥G" }], onSelect: spy<[string]>(), onClose: spy<[]>() } as ContextMenuProps);
    expect($('#ds-overlays [role="menu"]').style.width).toBe("203px");
  });

  it("the tool menus' widths are live's (toolbar/*-tools-menu.txt)", () => {
    expect(Object.fromEntries(TOOL_GROUPS.map((g) => [g.id, g.menuWidth]))).toEqual({ move: 151, region: 150, shape: 196, creation: 142, text: 142, comment: 186 });
    m = mount(EditorToolbar, { tool: "move", onTool: spy<[ToolId]>(), mode: "design", onMode: spy(), } as EditorToolbarProps);
    click($('[aria-label="Shape tools"]', m.host));
    expect($('#ds-overlays [role="menu"]').style.width).toBe("196px");
  });

  it("a text tool button can be held to live's width", () => {
    m = mount(ToolTextButton, { icon: "24.move", label: "Move", width: 60.3, onSelect: spy() } as never);
    expect($('[data-ds="ToolTextButton"]', m.host).style.width).toBe("60.3px");
  });
});
