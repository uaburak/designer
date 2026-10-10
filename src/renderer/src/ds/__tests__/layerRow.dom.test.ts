// @vitest-environment happy-dom
// Round 14, Layers polish (the owner's reports; measured in the browser by editor-shot EDITOR_ONLY=layers14): the
// name's fade leaves room for the cells showing, rows never move their content in a selection's block, the cells
// stick to the list's visible edge, and the navigation bar's tabs are icons only unless labels are turned on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { LAYER_NAME_END, LayerRow, layerListWidth, layerRowExtent, tailCells } from "../components/LayerRow";
import { VirtualList } from "../components/VirtualList";
import { textWidth } from "../util/textWidth";
import { Rail, RailItem } from "../components/Rail";
import { $, mount, type Mounted } from "./dom";

const css = (f: string) => readFileSync(join(__dirname, "../components", f), "utf8");
const noop = () => {};

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

describe("LayerRow: the name's room", () => {
  it("leaves room at rest for a lock kept on (both cells) or a closed eye (its own), and for every cell on hover", () => {
    expect(tailCells({ lock: true, visible: true })).toEqual({ rest: 0, hover: 2 });
    expect(tailCells({ locked: true, lock: true, visible: true })).toEqual({ rest: 2, hover: 2 });
    expect(tailCells({ hidden: true, lock: true, visible: true })).toEqual({ rest: 1, hover: 2 });
    expect(tailCells({ locked: true, hidden: true, lock: true, visible: true })).toEqual({ rest: 2, hover: 2 });
    // An instance's layer: no lock cell (it can't be locked there), the eye only.
    expect(tailCells({ hidden: true, lock: false, visible: true })).toEqual({ rest: 1, hover: 1 });
    expect(tailCells({ lock: false, visible: false })).toEqual({ rest: 0, hover: 0 });
  });

  it("hands the counts to its CSS (--tail-rest / --tail-hover), none while renaming", () => {
    m = mount(LayerRow, { id: "1:1", depth: 2, name: "A long layer name", icon: "16.frame", locked: true, onToggleLock: noop, onToggleVisible: noop });
    const row = $('[data-ds="LayerRow"]');
    expect(row.style.getPropertyValue("--tail-rest")).toBe("2");
    expect(row.style.getPropertyValue("--tail-hover")).toBe("2");
    expect(row.style.getPropertyValue("--depth")).toBe("2");
    expect($("[data-layer-name]").textContent).toBe("A long layer name");
    m.rerender(LayerRow, { id: "1:1", depth: 2, name: "A long layer name", icon: "16.frame", locked: true, renaming: true, onToggleLock: noop, onToggleVisible: noop });
    expect($('[data-ds="LayerRow"]').style.getPropertyValue("--tail-rest")).toBe("0");
  });

  it("fades the name with a mask at the cut (no ellipsis); the cells take no room and stick to the visible edge", () => {
    const s = css("LayerRow.module.css");
    const name = s.slice(s.indexOf(".row .name {"), s.indexOf("}", s.indexOf(".row .name {")));
    expect(name).toContain("text-overflow: clip");
    expect(name).toContain("mask-image: linear-gradient(to right");
    expect(name).toContain("var(--ds-size-layer-fade)");
    expect(name).toContain("var(--layer-clip-right, 0px)");
    expect(s).toMatch(/\.row:hover \.name, \.row\[data-hover\] \.name \{ --layer-tail: calc\(var\(--tail-hover/);
    expect(s).toMatch(/\.row \.tail \{ position: sticky; right: var\(--ds-size-row-inset\);[^}]*width: 0;/);
  });
});

describe("Layers: the list scrolls sideways only as far as its widest row (Figma, the owner's capture 39.png)", () => {
  it("a row's full extent: inset, 4, the indent, chevron, glyph + 8, the whole name, the gap, lock and eye, inset", () => {
    expect(LAYER_NAME_END).toBe(24);
    // A top-level name starts 52 in (live); its 100 px, 24 to the lock, the two 24 cells, 8 to the list's edge.
    expect(layerRowExtent(0, 100)).toBe(52 + 100 + 24 + 48 + 8);
    expect(layerRowExtent(3, 100)).toBe(layerRowExtent(0, 100) + 3 * 24);
    expect(layerRowExtent(0, "Frame 1")).toBe(layerRowExtent(0, textWidth("Frame 1")));
  });

  it("every name fits: narrower than the panel, so the list (never narrower than its view) doesn't scroll sideways", () => {
    const rows = [{ depth: 0, name: "Frame 1" }, { depth: 1, name: "Rectangle" }, { depth: 2, name: "Text" }];
    expect(layerListWidth(rows)).toBeLessThan(240);
    expect(layerListWidth([])).toBe(0);
  });

  it("one long name: the list is as wide as that row's full extent, icons included — scrolled to the end it shows whole", () => {
    const long = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaassdddddddddddddddddddddddddddddddd end";
    const w = layerListWidth([{ depth: 0, name: "Short" }, { depth: 1, name: long }, { depth: 0, name: "Frame" }]);
    expect(w).toBe(Math.ceil(layerRowExtent(1, long)));
    expect(w).toBe(Math.ceil(8 + 4 + 24 + 16 + 16 + 8 + textWidth(long) + 24 + 48 + 8));
    // Names not read yet don't count (they do once read).
    expect(layerListWidth([{ depth: 0, name: "Short" }, { depth: 0, name: null }])).toBe(Math.ceil(layerRowExtent(0, "Short")));
  });

  it("deep nesting: a short name eleven levels in is as wide as its indent makes it; one level open with short names fits", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ depth: i, name: `Frame ${20 - i}` }));
    expect(layerListWidth(rows)).toBe(Math.ceil(layerRowExtent(11, "Frame 9")));
    expect(layerListWidth(rows.slice(0, 2))).toBeLessThan(240);
  });

  it("the VirtualList's rows take that width, never narrower than the list", () => {
    m = mount(VirtualList, { count: 3, rowHeight: 32, axis: "both", contentWidth: 300, renderRow: (i: number) => h("div", null, String(i)) });
    const list = () => $('[data-ds="VirtualList"]').style;
    expect([list().width, list().minWidth]).toEqual(["300px", "100%"]);
    m.rerender(VirtualList, { count: 3, rowHeight: 32, axis: "y", renderRow: (i: number) => h("div", null, String(i)) });
    expect([list().width, list().minWidth]).toEqual(["", ""]);
  });

  it("the vertical scrollbar overlays the rows: the viewport hides the native one (no gutter), the thumb's track is absolute", () => {
    const s = css("ScrollArea.module.css");
    expect(s).toMatch(/\.viewport \{[^}]*scrollbar-width: none;/);
    expect(s).toContain(".viewport::-webkit-scrollbar { display: none; }");
    expect(s).toContain(".track { position: absolute;");
  });
});

describe("LayerRow: one height and one line in every state", () => {
  it("never changes the box's margins or size by state: a selection's block is drawn by the highlight under the content", () => {
    const s = css("LayerRow.module.css").replace(/\/\*[\s\S]*?\*\//g, "");
    // The box (the content's line) is set once; every state rule paints ::before.
    const boxRules = [...s.matchAll(/([^{}]*)\{([^}]*)\}/g)].filter(([, sel]) => /\.box\s*$/.test(sel.trim().split(",").pop()!.trim()));
    expect(boxRules.map(([, sel]) => sel.trim())).toEqual([".box"]);
    for (const run of ["start", "middle", "end"]) expect(s).toMatch(new RegExp(`\\.row\\[data-run="${run}"\\] \\.box::before \\{`));
    expect(s).not.toMatch(/data-run="[a-z]+"\] \.box \{/);
  });
});

describe("Rail: icons only unless labels are on", () => {
  it("draws no names under the tiles without labels (each tab is its tile and 8 around it); the name is the tooltip", () => {
    m = mount(() => h(Rail, { labels: false, children: h(RailItem, { icon: "24.page", label: "File", shortcut: "⌥1", active: true }) }), {});
    const rail = $('[data-ds="Rail"]');
    expect(rail.hasAttribute("data-labels")).toBe(false);
    const s = css("Rail.module.css");
    expect(s).toContain(".rail:not([data-labels]) .label { display: none; }");
    expect(s).toContain(".rail:not([data-labels]) .item { height: calc(var(--ds-size-rail-tile) + var(--ds-space-2)); }");
    expect($('[data-ds="RailItem"]').getAttribute("aria-label")).toBe("File");
  });
});
