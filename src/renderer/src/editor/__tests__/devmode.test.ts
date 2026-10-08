// Dev Mode's pure parts (devmode/annotations.ts, devmode/compare.ts; R9 "Round 6"): markdown as the canvas shows it
// (the twin of engine/src/editor/Annotations.cpp), notes and categories in Figma's fields, "+ Property" per layer type,
// and Compare changes' diff.
import { describe, expect, it } from "vitest";
import type { NodeChange } from "@/engine/codec";
import { categoriesOf, encodeCategories, encodeNotes, markdownLines, markdownPlain, notesOf, propertiesFor } from "../devmode/annotations";
import { codeDiff, diffDesign, propertyChanges, valueText, versionAtOrBefore } from "../devmode/compare";

describe("annotations", () => {
  it("reads markdown as the engine draws it", () => {
    const lines = markdownLines("## Header\nUse **bold** and _italic_ with [a link](https://x.y)\n- one\n* two\n1. first\n\n```\ncode **kept**\n```");
    expect(lines.map((l) => l.text)).toEqual(["Header", "Use bold and italic with a link", "one", "two", "first", "code **kept**"]);
    expect(lines[0].heading).toBe(true);
    expect(lines[2].bullet && lines[3].bullet).toBe(true);
    expect(lines[4].number).toBe(1);
    expect(markdownPlain("- a\n2. b")).toBe("• a\n2. b");
    expect(markdownLines("my_var_name")[0].text).toBe("my_var_name");
  });

  it("writes notes into Figma's fields and reads them back (older HTML labels as text)", () => {
    const encoded = encodeNotes([{ markdown: "Use the **brand** card", properties: ["WIDTH", "FILL"], categoryId: "2:5" }]);
    expect(encoded).toEqual([
      { label: "Use the brand card", labelV2: "Use the **brand** card", properties: [{ type: "WIDTH" }, { type: "FILL" }], categoryId: { sessionID: 2, localID: 5 } },
    ]);
    expect(notesOf({ annotations: encoded })).toEqual([{ markdown: "Use the **brand** card", properties: ["WIDTH", "FILL"], categoryId: "2:5" }]);
    expect(notesOf({ annotations: [{ label: "<p>Header</p><p>Body &amp; more</p>" }] })[0].markdown).toBe("Header\nBody & more");
    // An empty note isn't kept; no notes removes the field.
    expect(encodeNotes([{ markdown: "  ", properties: [], categoryId: null }])).toBeNull();
  });

  it("offers properties by layer type", () => {
    const text = propertiesFor({ type: "TEXT" });
    expect(text).toEqual(expect.arrayContaining(["FONT_FAMILY", "FONT_SIZE", "LINE_HEIGHT", "TEXT_ALIGN_HORIZONTAL"]));
    expect(text).not.toContain("CORNER_RADIUS");
    const auto = propertiesFor({ type: "FRAME", stackMode: "VERTICAL" });
    expect(auto).toEqual(expect.arrayContaining(["STACK_SPACING", "STACK_PADDING", "MIN_WIDTH"]));
    expect(propertiesFor({ type: "INSTANCE" })).toContain("COMPONENT");
    expect(propertiesFor({ type: "FRAME", stackMode: "GRID" })).toContain("GRID_COLUMN_COUNT");
    expect(propertiesFor({ type: "RECTANGLE", parentStackMode: "GRID" })).toContain("GRID_ROW_SPAN");
    expect(propertiesFor({ type: "RECTANGLE" })).not.toContain("FONT_SIZE");
  });

  it("keeps Figma's preset categories (as its files do) and custom ones", () => {
    const presets = categoriesOf(null);
    expect(presets.map((c) => c.label)).toEqual(["Development", "Interaction", "Accessibility", "Content"]);
    expect(presets.every((c) => c.id === null)).toBe(true);
    let n = 0;
    const { list, json } = encodeCategories([...presets, { id: null, preset: null, label: "Motion", color: "PINK", custom: true }], () => `9:${++n}`);
    expect(list.every((c) => c.id)).toBe(true);
    expect(json.version).toBe(3);
    expect(json.items?.[0]).toEqual({ id: { sessionID: 9, localID: 1 }, preset: "DEVELOPMENT" });
    expect(json.items?.[4]).toEqual({ id: { sessionID: 9, localID: 5 }, preset: "NONE", custom: { color: "PINK", label: "Motion" } });
    // The owner's file form: presets with ids, no colours.
    const read = categoriesOf({ version: 3, items: [{ id: { sessionID: 2, localID: 0 }, preset: "DEVELOPMENT" }, ...json.items!.slice(4)] });
    expect(read).toEqual([
      { id: "2:0", preset: "DEVELOPMENT", label: "Development", color: "BLUE", custom: false },
      { id: "9:5", preset: null, label: "Motion", color: "PINK", custom: true },
    ]);
    // A renamed preset keeps its preset and writes its label.
    const renamed = encodeCategories([{ ...read[0], label: "Dev notes", custom: true }], () => "9:9").json;
    expect(renamed.items?.[0]).toEqual({ id: { sessionID: 2, localID: 0 }, preset: "DEVELOPMENT", custom: { color: "BLUE", label: "Dev notes" } });
  });
});

describe("Compare changes", () => {
  const node = (guid: string, parent: string, position: string, extra: Partial<NodeChange> & Record<string, unknown> = {}) =>
    ({ guid, type: "FRAME", name: guid, parentIndex: { guid: parent, position }, size: { x: 100, y: 50 }, ...extra }) as NodeChange;

  it("tags layers Edited, Added and Deleted with their property changes", () => {
    const before = [
      node("1:1", "0:1", "a", { name: "Card" }),
      node("1:2", "1:1", "a", { name: "Title", type: "TEXT", fontSize: 16, fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }] }),
      node("1:3", "1:1", "b", { name: "Old badge" }),
      node("1:5", "1:3", "a", { name: "Badge text", type: "TEXT" }),
      node("I1:9;2:2", "1:1", "c", { name: "derived" }),
    ];
    const after = [
      node("1:1", "0:1", "a", { name: "Card", editInfo: { lastEditedAt: 9 } }),
      node("1:2", "1:1", "a", { name: "Title", type: "TEXT", fontSize: 18, fillPaints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }] }),
      node("1:4", "1:1", "c", { name: "New button" }),
    ];
    const diff = diffDesign("1:1", before, after);
    expect(diff.map((d) => [d.name, d.kind])).toEqual([
      ["New button", "Added"],
      ["Title", "Edited"],
      ["Old badge", "Deleted"],
      ["Badge text", "Deleted"],
    ]);
    const title = diff.find((d) => d.name === "Title")!;
    expect(title.changes).toEqual([
      { field: "fillPaints", label: "Fill", before: "#000000", after: "#FF0000" },
      { field: "fontSize", label: "Font size", before: "16", after: "18" },
    ]);
    // editInfo alone isn't a change: the root isn't listed.
    expect(diff.some((d) => d.id === "1:1")).toBe(false);
  });

  it("formats values as the properties list shows them", () => {
    expect(valueText("size", { x: 120, y: 40.5 })).toBe("120 × 40.5");
    expect(valueText("transform", { m00: 1, m01: 0, m02: 12, m10: 0, m11: 1, m12: 30 })).toBe("X 12, Y 30");
    expect(valueText("opacity", 0.5)).toBe("50%");
    expect(valueText("lineHeight", { value: 1.4, units: "RAW" })).toBe("140%");
    expect(valueText("textData", { characters: "Hi" })).toBe('"Hi"');
    expect(valueText("visible", false)).toBe("Off");
    // A reorder isn't a new parent.
    expect(propertyChanges(node("1:1", "0:1", "a"), node("1:1", "0:1", "b"))).toEqual([]);
    expect(propertyChanges(node("1:1", "0:1", "a"), node("1:1", "0:2", "a"))[0].label).toBe("Parent");
  });

  it("opens on the version saved when the design was marked ready", () => {
    const versions = [{ id: "a", createdAt: 1000 }, { id: "b", createdAt: 5000 }, { id: "c", createdAt: 9000 }];
    expect(versionAtOrBefore(versions, 6000)?.id).toBe("b");
    expect(versionAtOrBefore(versions, null)?.id).toBe("c");
    expect(versionAtOrBefore(versions, 10)?.id).toBe("a");
    expect(versionAtOrBefore([], 10)).toBeNull();
  });

  it("marks the code lines each side lacks", () => {
    const d = codeDiff("width: 100px;\nheight: 40px;", "width: 120px;\nheight: 40px;");
    expect(d.before).toEqual([{ text: "width: 100px;", changed: true }, { text: "height: 40px;", changed: false }]);
    expect(d.after[0]).toEqual({ text: "width: 120px;", changed: true });
  });
});
