// Grid auto layout editing (docs/research/figma/R9-grid-auto-layout.md): the model's track edits as plain data, and
// the same edits on the real engine (the committed Wasm build, headless in Node) — a frame turned into a grid, track
// counts and sizing, gaps, spans and automatic positioning laying the items out.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import type { NodeFields } from "@/engine/codec";
import { gridDefaults, parseTrackInput, reorderTracks, setTrackCount, setTrackSizing, spanOf, trackLabel, tracksOf, type GridNode } from "../model/grid";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

describe("grid model", () => {
  it("labels and parses track sizes as Figma does", () => {
    expect(trackLabel({ type: "FLEX", value: 1 })).toBe("1fr");
    expect(trackLabel({ type: "FIXED", value: 120 })).toBe("120");
    expect(trackLabel({ type: "HUG", value: 1 })).toBe("Hug");
    expect(parseTrackInput("2fr")).toEqual({ type: "FLEX", value: 2 });
    expect(parseTrackInput("A")).toEqual({ type: "FLEX", value: 1 });
    expect(parseTrackInput("Auto")).toEqual({ type: "FLEX", value: 1 });
    expect(parseTrackInput("hug")).toEqual({ type: "HUG", value: 1 });
    expect(parseTrackInput("80")).toEqual({ type: "FIXED", value: 80 });
    expect(parseTrackInput("wide")).toBeNull();
  });

  it("adds Hug tracks after the last, takes them from the end, moves anchored items to the last track", () => {
    let n: GridNode = { stackMode: "GRID", ...gridDefaults({}, 7) } as GridNode;
    expect(tracksOf(n, "columns").map((t) => t.sizing.type)).toEqual(["HUG", "HUG"]);
    expect(tracksOf(n, "rows")).toHaveLength(2);
    const ids = [...tracksOf(n, "columns"), ...tracksOf(n, "rows")].map((t) => `${t.id.sessionID}:${t.id.localID}`);
    expect(new Set(ids).size).toBe(4);
    n = { ...n, ...setTrackCount(n, "columns", 4, 7).frame } as GridNode;
    expect(tracksOf(n, "columns")).toHaveLength(4);
    const third = tracksOf(n, "columns")[2].id;
    const r = setTrackCount(n, "columns", 2, 7, [{ guid: "1:9", node: { gridColumnAnchor: third } }]);
    expect(r.items).toEqual([{ guid: "1:9", fields: { gridColumnAnchor: tracksOf(n, "columns")[1].id } }]);
  });

  it("sets one track's sizing and reorders tracks", () => {
    let n = { stackMode: "GRID", ...gridDefaults({}, 1, 3, 1) } as GridNode;
    const before = tracksOf(n, "columns").map((t) => t.id.localID);
    n = { ...n, ...setTrackSizing(n, "columns", 1, { type: "FLEX", value: 2 }) } as GridNode;
    expect(tracksOf(n, "columns")[1].sizing).toEqual({ type: "FLEX", value: 2 });
    n = { ...n, ...reorderTracks(n, "columns", [0], 3) } as GridNode;
    expect(tracksOf(n, "columns").map((t) => t.id.localID)).toEqual([before[1], before[2], before[0]]);
    expect(spanOf({ gridColumnSpan: 2 }, "columns")).toBe(2);
    expect(spanOf({}, "rows")).toBe(1);
  });
});

describe("grid on the engine (wasm, headless)", () => {
  it("lays a frame out as a grid: fixed and fill columns, gaps, automatic positioning, spans", async () => {
    const engine = await Engine.create(null, { sessionID: 1 });
    engine.load(SAMPLE_DOCUMENT);
    // "Desktop" (1:1, 640 × 420) holds six layers; as a 3-column grid with gaps of 10 and no padding.
    const desktop = engine.readNodes(["1:1"])[0] as unknown as GridNode;
    let grid = { ...desktop, ...gridDefaults(desktop, 1, 3, 2) } as GridNode;
    grid = { ...grid, ...setTrackSizing(grid, "columns", 0, { type: "FIXED", value: 100 }) } as GridNode;
    grid = { ...grid, ...setTrackSizing(grid, "columns", 1, { type: "FLEX", value: 1 }) } as GridNode;
    grid = { ...grid, ...setTrackSizing(grid, "columns", 2, { type: "FLEX", value: 1 }) } as GridNode;
    const fields = {
      stackMode: "GRID",
      stackPrimarySizing: "FIXED",
      stackCounterSizing: "FIXED",
      gridReflowEnabled: true,
      gridColumnGap: 10,
      gridRowGap: 10,
      gridColumns: grid.gridColumns,
      gridColumnsSizing: grid.gridColumnsSizing,
      gridRows: grid.gridRows,
      gridRowsSizing: grid.gridRowsSizing,
    } as unknown as NodeFields;
    expect(engine.setProps(["1:1"], fields)).toBe(0);
    const read = engine.readNodes(["1:1"])[0] as unknown as GridNode;
    expect(tracksOf(read, "columns").map((t) => t.sizing.type)).toEqual(["FIXED", "FLEX", "FLEX"]);
    // Columns: 100, then (640 - 100 - 20) / 2 = 260 each. Items flow row by row in layer order.
    const at = (id: string) => engine.readNodes([id])[0].transform!;
    expect(at("1:2").m02).toBe(0); // Header: column 0
    expect(at("1:3").m02).toBe(110); // Logo: column 1
    expect(at("1:4").m02).toBe(380); // Nav: column 2
    expect(at("1:5").m02).toBe(0); // Card: next row
    // A span of two columns takes the next free cells wide enough.
    expect(engine.setProps(["1:3"], { gridColumnSpan: 2 } as unknown as NodeFields)).toBe(0);
    expect(at("1:3").m02).toBe(110);
    expect(at("1:4").m02).toBe(0); // pushed to the next row
    // The column gap bound as a plain value change re-lays out.
    expect(engine.setProps(["1:1"], { gridColumnGap: 20 } as unknown as NodeFields)).toBe(0);
    expect(at("1:3").m02).toBe(120);
  });
});
