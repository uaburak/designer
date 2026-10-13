import { describe, expect, it } from "vitest";
import type { NodeChange } from "@/engine/codec";
import { layerRows, withChildIds } from "./layers";

const n = (guid: string, parent: string, position: string, type: string, name: string, more: Partial<NodeChange> = {}): NodeChange =>
  ({ guid, phase: "CREATED", type, name, parentIndex: { guid: parent, position }, ...more }) as NodeChange;

const DOC = withChildIds([
  { guid: "0:1", phase: "CREATED", type: "CANVAS", name: "Page" } as NodeChange,
  n("1:1", "0:1", "!", "FRAME", "Back"),
  n("1:2", "0:1", '"', "FRAME", "Front"),
  n("1:3", "1:2", "!", "TEXT", "Title"),
  n("1:4", "1:2", '"', "ELLIPSE", "Dot"),
  n("1:5", "0:1", "#", "FRAME", "Row", { stackMode: "HORIZONTAL" }),
  n("1:6", "1:5", "!", "TEXT", "First"),
  n("1:7", "1:5", '"', "TEXT", "Second"),
]);

describe("layerRows", () => {
  it("lists the top layer first, closed frames without their children", () => {
    const rows = layerRows(DOC, "0:1", new Set(), new Set());
    expect(rows.map((r) => r.name)).toEqual(["Row", "Front", "Back"]);
    expect(rows[1].expanded).toBe(false);
    expect(rows[2].expanded).toBeUndefined();
    expect(rows[0].icon).toBe("16.autolayout.horizontal");
    expect(rows[1].strong).toBe(true);
  });

  it("opens a frame the visitor opened; an auto layout's children in flow order", () => {
    const rows = layerRows(DOC, "0:1", new Set(["1:2", "1:5"]), new Set());
    expect(rows.map((r) => `${r.depth}${r.name}`)).toEqual(["0Row", "1First", "1Second", "0Front", "1Dot", "1Title", "0Back"]);
  });

  it("opens the ancestors of the selection and marks runs and what is inside a selected layer", () => {
    const rows = layerRows(DOC, "0:1", new Set(), new Set(["1:6", "1:7"]));
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by.Row.expanded).toBe(true);
    expect(by.First.run).toBe("start");
    expect(by.Second.run).toBe("end");
    const inside = layerRows(DOC, "0:1", new Set(["1:2"]), new Set(["1:2"]));
    expect(inside.find((r) => r.name === "Title")?.selectedAncestor).toBe(true);
    expect(inside.find((r) => r.name === "Front")?.run).toBe("single");
  });
});
