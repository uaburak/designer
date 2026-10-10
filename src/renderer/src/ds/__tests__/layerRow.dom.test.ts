// @vitest-environment happy-dom
// Round 14, Layers polish (the owner's reports; measured in the browser by editor-shot EDITOR_ONLY=layers14): the
// name's fade leaves room for the cells showing, rows never move their content in a selection's block, the cells
// stick to the list's visible edge, and the navigation bar's tabs are icons only unless labels are turned on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { LayerRow, tailCells } from "../components/LayerRow";
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
