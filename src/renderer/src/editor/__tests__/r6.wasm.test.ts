// Round 6 (r6-components-grid): the grid's Number of rows (Auto), track label editing; slots' limits and settings;
// variant toggles and value order — as plain data, and on the real engine (the committed Wasm build, headless in
// Node): GRID_TRACKS from a click on a track pill, ⌫ deleting a track, Convert to slot / Wrap in new slot / Delete
// contents.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { PointerType } from "@/engine/abi";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import type { EventOf, NodeFields } from "@/engine/codec";
import { gridDefaults, isAutoRows, parseRowCount, rowCountLabel, setTrackSizing, tracksLabel, tracksOf, type GridNode } from "../model/grid";
import { hasSlotLimits, moveValue, slotGuidelines, slotViolations, variantToggle } from "../model/components";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

describe("grid model (round 6)", () => {
  it("reads and parses Number of rows: Auto or a count", () => {
    expect(parseRowCount("Auto")).toEqual({ auto: true });
    expect(parseRowCount("a")).toEqual({ auto: true });
    expect(parseRowCount("3")).toEqual({ auto: false, count: 3 });
    expect(parseRowCount("2*3")).toEqual({ auto: false, count: 6 });
    expect(parseRowCount("0")).toEqual({ auto: false, count: 1 });
    expect(parseRowCount("rows")).toBeNull();
    const g = gridDefaults({} as GridNode, 1, 2, 2) as GridNode;
    expect(isAutoRows(g)).toBe(true); // a new grid's rows are Auto
    expect(rowCountLabel(g)).toBe("Auto");
    expect(rowCountLabel({ ...g, gridAutoTracks: "NONE" })).toBe("2");
  });
  it("sizes several tracks at once and labels a selection", () => {
    const g = gridDefaults({} as GridNode, 1, 3, 1) as GridNode;
    const next = { ...g, ...setTrackSizing(g, "columns", [0, 2], { type: "FIXED", value: 80 }) } as GridNode;
    expect(tracksOf(next, "columns").map((t) => t.sizing.type)).toEqual(["FIXED", "HUG", "FIXED"]);
    expect(tracksLabel(next, "columns", [0, 2])).toBe("80");
    expect(tracksLabel(next, "columns", [0, 1])).toBe("Mixed");
  });
});

describe("slots and variants model (round 6)", () => {
  it("finds a slot's broken limits as Figma's limitViolations", () => {
    const kids = (n: number, preferred = true) => Array.from({ length: n }, () => ({ preferred }));
    expect(slotViolations({ minChildren: 1, maxChildren: 3 }, kids(0), 0)).toEqual(["BELOW_MIN"]);
    expect(slotViolations({ minChildren: 1, maxChildren: 3 }, kids(2), 0)).toEqual([]);
    expect(slotViolations({ minChildren: 1, maxChildren: 3 }, kids(4), 0)).toEqual(["ABOVE_MAX"]);
    expect(slotViolations({ allowPreferredValuesOnly: true }, [{ preferred: true }, { preferred: false }], 2)).toEqual(["HAS_NON_PREFERRED"]);
    expect(slotViolations({ allowPreferredValuesOnly: true }, [{ preferred: false }], 0)).toEqual([]); // nothing preferred: no rule
    expect(hasSlotLimits({ minChildren: 0, maxChildren: 0 }, 0)).toBe(false); // 0 = not set
    expect(hasSlotLimits({ maxChildren: 2 }, 0)).toBe(true);
    expect(slotGuidelines({ minChildren: 1, maxChildren: 3 }, kids(4), 0)).toEqual([{ text: "1–3 layers", ok: false }]);
    expect(slotGuidelines({ maxChildren: 1 }, kids(1), 0)).toEqual([{ text: "Up to 1 layer", ok: true }]);
  });
  it("shows True / False, Yes / No, On / Off variant properties as toggles; reorders values", () => {
    expect(variantToggle(["True", "False"])).toEqual({ on: "True", off: "False" });
    expect(variantToggle(["off", "on"])).toEqual({ on: "on", off: "off" });
    expect(variantToggle(["Yes", "No"])).toEqual({ on: "Yes", off: "No" });
    expect(variantToggle(["Default", "Hover"])).toBeNull();
    expect(variantToggle(["True", "False", "Mixed"])).toBeNull();
    expect(moveValue(["A", "B", "C"], 2, 0)).toEqual(["C", "A", "B"]);
    expect(moveValue(["A", "B", "C"], 0, 3)).toEqual(["B", "C", "A"]);
  });
});

describe("round 6 on the engine (wasm, headless)", () => {
  it("a click on a grid's column pill selects it, its chevron opens the label field and sizing list; ⌫ deletes it", async () => {
    const engine = await Engine.create(null, { sessionID: 1 });
    engine.setViewport(1280, 800, 1, 1280, 800);
    engine.load(SAMPLE_DOCUMENT);
    engine.setCamera({ x: 0, y: 0, zoom: 1 });
    const desktop = engine.readNodes(["1:1"])[0] as unknown as GridNode;
    let grid = { ...desktop, ...gridDefaults(desktop, 1, 3, 2) } as GridNode;
    for (const i of [0, 1, 2]) grid = { ...grid, ...setTrackSizing(grid, "columns", i, { type: "FIXED", value: 100 }) } as GridNode;
    const fields = { stackMode: "GRID", stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED", gridReflowEnabled: true, gridAutoTracks: "ROWS", gridColumnGap: 0, gridRowGap: 0, gridColumns: grid.gridColumns, gridColumnsSizing: grid.gridColumnsSizing, gridRows: grid.gridRows, gridRowsSizing: grid.gridRowsSizing } as unknown as NodeFields;
    expect(engine.setProps(["1:1"], fields)).toBe(0);
    engine.setSelection(["1:1"]);
    const events: EventOf<"GRID_TRACKS">[] = [];
    engine.on("GRID_TRACKS", (e) => events.push(e));
    // The frame at the origin on screen: column 2 (100–200) has its pill 31.5 px above the top edge (live Figma), its
    // label in the middle.
    const click = (x: number, y: number) => {
      engine.pointer(PointerType.MOVE, x, y, 0, 0, 0);
      engine.pointer(PointerType.DOWN, x, y, 0, 1, 0);
      engine.pointer(PointerType.UP, x, y, 0, 0, 0);
    };
    click(150, -31.5);
    let last = events[events.length - 1];
    expect(last.frame).toBe("1:1");
    expect(last.axis).toBe("COLUMNS");
    expect(last.tracks).toEqual([1]);
    expect(last.edit).toBe(false); // round 12 (live grid/row-track-menu.txt): the pill click only selects the track
    // Enter: the label's field and the sizing list, at the pill's label…
    engine.key("down", "Enter", "Enter", 0);
    last = events[events.length - 1];
    expect(last.edit).toBe(true);
    expect(last.width).toBeGreaterThan(0);
    expect(last.height).toBe(18);
    // …as a click on its chevron (the 16 px after the label) does.
    const count = events.length;
    click(last.x + last.width + 8, last.y + last.height / 2);
    expect(events.length).toBe(count + 1);
    last = events[events.length - 1];
    expect(last.tracks).toEqual([1]);
    expect(last.edit).toBe(true);
    engine.key("down", "Backspace", "Backspace", 0);
    expect(tracksOf(engine.readNodes(["1:1"])[0] as unknown as GridNode, "columns")).toHaveLength(2);
    expect((engine.readNodes(["1:1"])[0] as unknown as GridNode).gridAutoTracks).toBe("ROWS");
    engine.destroy();
  });

  it("Convert to slot, Wrap in new slot and Delete contents", async () => {
    const engine = await Engine.create(null, { sessionID: 1 });
    engine.setViewport(1280, 800, 1, 1280, 800);
    engine.load(SAMPLE_DOCUMENT);
    engine.setSelection(["1:1"]);
    expect(engine.runCommand("CREATE_COMPONENT").status).toBe(0);
    engine.setSelection(["1:7"]); // "Clip", a frame inside the component
    expect(engine.runCommand("CONVERT_TO_SLOT").status).toBe(0);
    const defs = (engine.readNodes(["1:1"])[0] as { componentPropDefs?: { name: string; type: string }[] }).componentPropDefs ?? [];
    expect(defs.map((d) => [d.name, d.type])).toContainEqual(["Slot", "SLOT"]);
    expect((engine.readNodes(["1:7"])[0] as { isSlot?: boolean }).isSlot).toBe(true);
    // A rectangle can't be a slot; it can be wrapped in one.
    engine.setSelection(["1:5"]);
    expect(engine.runCommand("CONVERT_TO_SLOT").status).not.toBe(0);
    expect(engine.runCommand("WRAP_IN_NEW_SLOT").status).toBe(0);
    const wrapper = engine.readNodes(["1:5"])[0].parentIndex?.guid;
    expect(wrapper).not.toBe("1:1");
    expect((engine.readNodes([wrapper!])[0] as { isSlot?: boolean }).isSlot).toBe(true);
    // The main's slot frame emptied.
    expect(engine.runCommand("CLEAR_SLOT", { ref: "1:7" }).status).toBe(0);
    expect(engine.readNodes(["1:7"], { childIds: true })[0].childIds ?? []).toHaveLength(0);
    engine.destroy();
  });
});
