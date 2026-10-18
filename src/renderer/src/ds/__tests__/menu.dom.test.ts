// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { ContextMenu, type ContextMenuProps, type MenuEntry } from "../components/Menu";
import { Select, type SelectProps } from "../components/Select";
import { MIXED } from "../types";
import { act } from "react";
import { $, $$, click, key, mount, spy, type Mounted } from "./dom";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

const entries: MenuEntry[] = [
  { id: "copy", label: "Copy", shortcut: "⌘C" },
  { id: "paste", label: "Paste", disabled: true },
  "-",
  { id: "frame", label: "Frame selection" },
  { id: "select", label: "Select layer", items: [{ id: "a", label: "Frame 1" }, { id: "b", label: "Card" }] },
];

describe("ContextMenu", () => {
  const open = () => {
    const onSelect = spy<[string]>();
    const onClose = spy<[]>();
    m = mount(ContextMenu, { at: { x: 10, y: 10 }, entries, onSelect, onClose } as ContextMenuProps);
    const panel = $('#ds-overlays [role="menu"]');
    return { onSelect, onClose, panel };
  };
  const lit = () => $$('#ds-overlays [data-highlighted]').map((e) => e.textContent);

  it("opens in the overlay root, focused, dark", () => {
    const { panel } = open();
    expect(panel).toBeTruthy();
    expect(document.activeElement).toBe(panel);
    expect(panel.getAttribute("data-theme")).toBe("dark");
  });

  it("moves over enabled items with ↑ ↓ (wrapping) and picks with Enter", () => {
    const { panel, onSelect, onClose } = open();
    key(panel, "ArrowDown");
    expect(lit()).toEqual(["Copy⌘C"]);
    key(panel, "ArrowDown"); // skips the disabled Paste
    expect(lit()).toEqual(["Frame selection"]);
    key(panel, "ArrowUp");
    key(panel, "ArrowUp"); // wraps to the last
    expect(lit()).toEqual(["Select layer"]);
    key(panel, "ArrowUp");
    key(panel, "Enter");
    expect(onSelect.calls).toEqual([["frame"]]);
    expect(onClose.calls).toHaveLength(1);
  });

  it("jumps by typed letters", () => {
    const { panel } = open();
    key(panel, "s");
    expect(lit()).toEqual(["Select layer"]);
  });

  it("opens a submenu with →, goes back with ←, picks inside it", () => {
    const { panel, onSelect } = open();
    key(panel, "End");
    key(panel, "ArrowRight");
    const menus = $$('#ds-overlays [role="menu"]');
    expect(menus).toHaveLength(2);
    expect(document.activeElement).toBe(menus[1]);
    key(menus[1], "ArrowDown");
    key(menus[1], "ArrowLeft");
    expect($$('#ds-overlays [role="menu"]')).toHaveLength(1);
    key(panel, "ArrowRight");
    const sub = $$('#ds-overlays [role="menu"]')[1];
    key(sub, "ArrowDown");
    key(sub, "ArrowDown");
    key(sub, "Enter");
    expect(onSelect.calls).toEqual([["b"]]);
  });

  it("closes on Esc", () => {
    const { panel, onClose } = open();
    key(panel, "Escape");
    expect(onClose.calls).toHaveLength(1);
  });
});

describe("Select", () => {
  const options = [
    { value: "regular", label: "Regular" },
    { value: "medium", label: "Medium" },
    "-" as const,
    { value: "bold", label: "Bold" },
  ];
  const setup = (props: Partial<SelectProps> = {}) => {
    const onChange = spy<[string]>();
    m = mount(Select, { label: "Weight", value: "medium", options, onChange, ...props } as SelectProps);
    return { onChange, trigger: $('[role="combobox"]', m.host) };
  };

  it("opens on Enter with the chosen option active, picks with ↓ Enter, gives focus back", () => {
    const { onChange, trigger } = setup();
    trigger.focus();
    key(trigger, "Enter");
    const list = $('#ds-overlays [role="listbox"]');
    expect(list).toBeTruthy();
    expect(document.activeElement).toBe(list);
    expect($('#ds-overlays [aria-selected="true"]').textContent).toBe("Medium");
    expect(list.getAttribute("aria-activedescendant")).toBe($('#ds-overlays [aria-selected="true"]').id);
    key(list, "ArrowDown");
    key(list, "Enter");
    expect(onChange.calls).toEqual([["bold"]]);
    expect($('#ds-overlays [role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("previews a hovered option after 50 ms, puts it back on leaving the list and before a pick (Figma's hover preview)", async () => {
    const onPreview = spy<[string | null]>();
    const { onChange, trigger } = setup({ onPreview });
    click(trigger);
    const option = (label: string) => [...document.querySelectorAll('#ds-overlays [role="option"]')].find((o) => o.textContent === label)!;
    // (React makes enter / leave from "out" to the element on the other side; "over" only coming from outside it.)
    const enter = (el: Element) => act(() => void el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body })));
    const move = (from: Element, to: Element) => act(() => void from.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: to })));
    enter(option("Regular"));
    move(option("Regular"), option("Bold"));
    expect(onPreview.calls).toEqual([]);
    await new Promise((r) => setTimeout(r, 70));
    expect(onPreview.calls).toEqual([["bold"]]);
    move(option("Bold"), document.body);
    enter(option("Medium")); // the value's own option: nothing to preview
    move(option("Medium"), option("Regular"));
    await new Promise((r) => setTimeout(r, 70));
    click(option("Regular"));
    expect(onPreview.calls).toEqual([["bold"], [null], ["regular"], [null]]);
    expect(onChange.calls).toEqual([["regular"]]);
  });

  it("types ahead and closes on Esc without a change", () => {
    const { onChange, trigger } = setup();
    click(trigger);
    const list = $('#ds-overlays [role="listbox"]');
    key(list, "r");
    expect(list.getAttribute("aria-activedescendant")).toBe($$('#ds-overlays [role="option"]')[0].id);
    key(list, "Escape");
    expect(onChange.calls).toHaveLength(0);
    expect($('#ds-overlays [role="listbox"]')).toBeNull();
  });

  it("shows Mixed", () => {
    const { trigger } = setup({ value: MIXED });
    expect(trigger.textContent).toBe("Mixed");
  });
});
