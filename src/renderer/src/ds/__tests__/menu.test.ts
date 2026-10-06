import { describe, expect, it } from "vitest";
import { inTriangle, isItem, nextItem, tidy, toNativeTemplate, type MenuEntry } from "../util/menu";
import { createTypeahead, typeahead } from "../util/typeahead";
import { nextEnabled, rovingTarget } from "../util/rovingFocus";

const entries: MenuEntry[] = [
  "-",
  { header: "Edit" },
  { id: "copy", label: "Copy", shortcut: "⌘C", accelerator: "CmdOrCtrl+C" },
  { id: "paste", label: "Paste", disabled: true },
  "-",
  "-",
  { id: "rulers", label: "Rulers", checked: true },
  { id: "select", label: "Select layer", hint: "Frame", items: [{ id: "a", label: "Frame 1" }] },
  "-",
];

describe("menu model", () => {
  it("tidies lines: none first, last or twice", () => {
    const t = tidy(entries);
    expect(t[0]).toEqual({ header: "Edit" });
    expect(t.filter((e) => e === "-")).toHaveLength(1);
    expect(t[t.length - 1]).not.toBe("-");
  });

  it("moves over enabled items only, wrapping", () => {
    const t = tidy(entries);
    const ids = (i: number) => (isItem(t[i]) ? t[i].id : null);
    const first = nextItem(t, -1, 1);
    expect(ids(first)).toBe("copy");
    expect(ids(nextItem(t, first, 1))).toBe("rulers"); // skips disabled Paste and the line
    expect(ids(nextItem(t, first, -1))).toBe("select"); // wraps
    expect(nextItem(["-", { header: "x" }], -1, 1)).toBe(-1);
  });

  it("builds a native template (menu:popup)", () => {
    expect(toNativeTemplate(entries)).toEqual([
      { label: "Edit", enabled: false },
      { id: "copy", label: "Copy", enabled: true, accelerator: "CmdOrCtrl+C" },
      { id: "paste", label: "Paste", enabled: false },
      { type: "separator" },
      { id: "rulers", label: "Rulers", enabled: true, type: "checkbox", checked: true },
      { id: "select", label: "Select layer", enabled: true, type: "submenu", submenu: [{ id: "a", label: "Frame 1", enabled: true }] },
    ]);
  });

  it("knows the submenu's safe triangle", () => {
    const from = { x: 0, y: 50 };
    const top = { x: 100, y: 0 };
    const bottom = { x: 100, y: 100 };
    expect(inTriangle({ x: 50, y: 50 }, from, top, bottom)).toBe(true);
    expect(inTriangle({ x: 50, y: 5 }, from, top, bottom)).toBe(false);
    expect(inTriangle({ x: -5, y: 50 }, from, top, bottom)).toBe(false);
  });
});

describe("typeahead", () => {
  const labels = ["Copy", null, "Cut", "Paste", "Rulers"];
  it("finds the next label starting with the query, wrapping, skipping disabled ones", () => {
    expect(typeahead(labels, -1, "c")).toBe(0);
    expect(typeahead(labels, 0, "c")).toBe(2);
    expect(typeahead(labels, 2, "c")).toBe(0);
    expect(typeahead(labels, 0, "R")).toBe(4);
    expect(typeahead(labels, 0, "cu")).toBe(2);
    expect(typeahead(labels, 0, "z")).toBe(-1);
  });
  it("buffers letters typed within 500ms", () => {
    let t = 0;
    const buf = createTypeahead(500, () => t);
    expect(buf.push("c")).toBe("c");
    t = 200;
    expect(buf.push("u")).toBe("cu");
    t = 900;
    expect(buf.push("p")).toBe("p");
  });
});

describe("roving focus", () => {
  const enabled = (i: number) => i !== 1;
  it("moves with arrows, Home and End, skipping disabled", () => {
    expect(nextEnabled(4, enabled, 0, 1)).toBe(2);
    expect(rovingTarget("ArrowRight", 4, enabled, 3, "horizontal")).toBe(0);
    expect(rovingTarget("ArrowDown", 4, enabled, 0, "horizontal")).toBeNull();
    expect(rovingTarget("Home", 4, enabled, 3)).toBe(0);
    expect(rovingTarget("End", 4, enabled, 0)).toBe(3);
    expect(rovingTarget("a", 4, enabled, 0)).toBeNull();
  });
});
