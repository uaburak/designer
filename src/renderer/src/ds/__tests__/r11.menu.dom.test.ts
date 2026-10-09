// @vitest-environment happy-dom
// Round 11 (live menus/main-object.txt, context-*.txt; menus/main-*.txt widths): a submenu taller than the window is not
// clamped to it (185 × 1050 at 210, 6 in a 900 high window); the context menus' modifier glyphs are 13 / 11 wide boxes;
// the shortcut glyphs come from Inter 3.19 ("Inter Symbols").
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, type ContextMenuProps, type MenuEntry } from "../components/Menu";
import { $, $$, click, mount, spy, type Mounted } from "./dom";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  vi.restoreAllMocks();
});

const css = readFileSync(join(__dirname, "../components/Menu.module.css"), "utf8");
const globalCss = readFileSync(join(__dirname, "../global.css"), "utf8");

describe("round 11: menus", () => {
  it("a submenu taller than the window runs past it (6 from the top), the rows moving on the wheel", () => {
    const rows: MenuEntry[] = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, label: `Row ${i}` }));
    const entries: MenuEntry[] = [{ id: "object", label: "Object", items: rows }];
    // happy-dom has no layout: a panel with the rows is 1050 high, the one with the parent's row 48
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const h = this.querySelectorAll('[role="menuitem"]').length > 10 ? 1050 : 48;
      return { left: 0, top: 0, right: 185, bottom: h, width: 185, height: h, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    m = mount(ContextMenu, { at: { x: 12, y: 44 }, entries, onSelect: spy<[string]>(), onClose: spy<[]>() } as ContextMenuProps);
    click($('#ds-overlays [role="menuitem"]'));
    const panels = $$('#ds-overlays [role="menu"]');
    const sub = panels.at(-1)!;
    expect(panels.length).toBe(2);
    expect(sub.style.maxHeight).toBe("none");
    expect(sub.style.top).toBe("6px");
  });

  it("the modifier glyphs of a context menu are 13 (⌘ ⇧ ⌥) and 11 (⌃) wide, a letter its own width", () => {
    expect(css).toMatch(/\.keys > \[data-key="⌘"\], \.keys > \[data-key="⇧"\], \.keys > \[data-key="⌥"\] \{ min-width: 13px;/);
    expect(css).toMatch(/\.keys > \[data-key="⌃"\] \{ min-width: 11px;/);
    m = mount(ContextMenu, { at: { x: 0, y: 0 }, context: true, entries: [{ id: "a", label: "Frame selection", shortcut: "⌥⌘G" }], onSelect: spy<[string]>(), onClose: spy<[]>() } as ContextMenuProps);
    expect($$('#ds-overlays [data-key]').map((e) => e.getAttribute("data-key"))).toEqual(["⌥", "⌘", "G"]);
  });

  it("the shortcut glyphs load Inter 3.19 for their code points only", () => {
    expect(globalCss).toMatch(/font-family: "Inter Symbols";[^}]*Inter-3\.19\.ttf[^}]*unicode-range: [^;]*U\+2318[^;]*U\+232B/);
    const tokens = readFileSync(join(__dirname, "../tokens.css"), "utf8");
    expect(tokens).toMatch(/--ds-font-family: "Inter Symbols", "Inter Variable"/);
  });
});
