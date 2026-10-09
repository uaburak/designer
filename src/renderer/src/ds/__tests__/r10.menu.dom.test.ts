// @vitest-environment happy-dom
// Round 10 (live popovers/boolean-operations-menu, instance-more-actions-menu, gap-menu, width-sizing-menu;
// menus/main-*.txt): a menu under its trigger has no padding above or below its rows and opens with its first row
// lit; a list over its field opens with its value lit; a disabled row's keys are the disabled colour; rows are the
// menu's full width, their highlight 8 in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextMenu, MenuButton, type ContextMenuProps, type MenuButtonProps, type MenuEntry } from "../components/Menu";
import { Toolbar, ToolTextButton, type ToolbarProps } from "../components/Toolbar";
import { createElement } from "react";
import { $, $$, click, mount, spy, type Mounted } from "./dom";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

const booleans: MenuEntry[] = [
  { id: "union", label: "Union", shortcut: "⌥⇧U" },
  { id: "subtract", label: "Subtract", shortcut: "⌥⇧S" },
  "-",
  { id: "flatten", label: "Flatten", shortcut: "⌥⇧F", disabled: true },
];
const lit = () => $$('#ds-overlays [data-highlighted]').map((e) => e.textContent);
const css = readFileSync(join(__dirname, "../components/Menu.module.css"), "utf8");

describe("Round 10 menus", () => {
  it("a menu under its trigger is flush and opens with its first row lit", () => {
    m = mount(MenuButton, { label: "Boolean operations", entries: booleans, onSelect: spy<[string]>(), children: "▾" } as MenuButtonProps);
    click($('[aria-label="Boolean operations"]'));
    const panel = $('#ds-overlays [role="menu"]');
    expect(panel.className).toMatch(/flush/);
    expect(lit()).toEqual(["Union⌥⇧U"]);
  });

  it("a context menu keeps its padding and lights nothing", () => {
    m = mount(ContextMenu, { at: { x: 10, y: 10 }, entries: booleans, onSelect: spy<[string]>(), onClose: spy<[]>() } as ContextMenuProps);
    const panel = $('#ds-overlays [role="menu"]');
    expect(panel.className).not.toMatch(/flush/);
    expect(lit()).toEqual([]);
  });

  it("a list over its field lights its checked value", () => {
    const rect = { left: 0, top: 0, right: 100, bottom: 24, width: 100, height: 24, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    const entries: MenuEntry[] = [
      { id: "fixed", label: "Fixed width (232)", checked: false },
      { id: "hug", label: "Hug contents", checked: true },
    ];
    m = mount(ContextMenu, { at: { x: 0, y: 0 }, over: { rect }, entries, onSelect: spy<[string]>(), onClose: spy<[]>() } as ContextMenuProps);
    expect(lit()).toEqual(["Hug contents"]);
    expect($('#ds-overlays [role="menu"]').className).toMatch(/inset/);
  });

  it("styles: full-width rows, the highlight 8 in, flush menus without padding, disabled keys dimmed", () => {
    expect(css).toMatch(/\.panel \{[^}]*padding: var\(--ds-size-menu-pad\) 0;/);
    expect(css).toMatch(/\.item::before \{[^}]*inset: 0 var\(--menu-inset\)/);
    expect(css).toMatch(/\.flush \{ padding-block: 0; \}/);
    expect(css).toMatch(/\.flush > \.separator \{ margin-block: 7px; \}/);
    expect(css).toMatch(/\.item\[aria-disabled="true"\] \.shortcut \{ color: var\(--ds-color-menu-text-disabled\); \}/);
    expect(css).toMatch(/\.item\[data-highlighted\] \.hint, \.item\[data-highlighted\] \.shortcut \{ color: var\(--ds-color-menu-text-on-highlight-secondary\); \}/);
  });

  it("a badge at the row's end (live context-layer-row.txt: Rename layers, \"AI\"); a radio menu named by a hidden label", () => {
    m = mount(ContextMenu, { at: { x: 0, y: 0 }, context: true, entries: [{ id: "r", label: "Rename layers", badge: "AI", disabled: true }], onSelect: spy<[string]>(), onClose: spy<[]>() } as ContextMenuProps);
    expect($('#ds-overlays [aria-label="AI, Learn more"]').textContent).toBe("AI");
    m.unmount();
    const strokes: MenuEntry[] = [
      { id: "ALL", label: "All", checked: true, radio: true },
      { id: "TOP", label: "Top", checked: false, radio: true },
    ];
    m = mount(MenuButton, { label: "Individual strokes", entries: strokes, onSelect: spy<[string]>(), children: "▾" } as MenuButtonProps);
    click($('[aria-label="Individual strokes"]'));
    const panel = $('#ds-overlays [role="menu"]');
    expect(panel.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.getElementById(panel.getAttribute("aria-labelledby")!)!.textContent).toBe("Individual strokes");
    expect(lit()).toEqual(["All"]);
  });

  it("a secondary toolbar's labelled tools (live vector edit toolbar): pressed when active, More with a chevron", () => {
    const pick = spy<[unknown]>();
    m = mount(Toolbar, {
      secondary: true,
      label: "Vector edit tools",
      children: [
        createElement(ToolTextButton, { key: "m", icon: "24.move", label: "Move", active: true, onSelect: pick }),
        createElement(ToolTextButton, { key: "c", icon: "24.cut", label: "Cut", onSelect: pick }),
        createElement(ToolTextButton, { key: "x", label: "More", chevron: true, onSelect: pick }),
      ],
    } as ToolbarProps);
    const bar = $('[role="toolbar"]');
    expect(bar.className).toMatch(/secondary/);
    expect($('[aria-label="Move"]').getAttribute("aria-pressed")).toBe("true");
    expect($('[aria-label="Cut"]').getAttribute("aria-pressed")).toBe("false");
    expect($('[aria-label="More"]').getAttribute("aria-pressed")).toBeNull();
    expect($('[aria-label="More"]').textContent).toBe("More");
    click($('[aria-label="Cut"]'));
    expect(pick.calls.length).toBe(1);
  });
});

