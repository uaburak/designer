// Library usage events (docs/data.md §17.3): the recorder's rules on kiwi-shaped batches over a fake document of org
// library copies — component inserts (a pasted frame of three instances, one nested in a pasted instance, slot
// content), swaps (not variant switches), detaches; style and variable inserts and detaches; only `edit` batches; the
// 2 s debounce.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withImages } from "../sourceImages";
import type { EditorController } from "../controller";
import { attachLibraryUsage, LibraryUsageRecorder, noteLibraryUsage, type UsageCopy, type UsageCount, type UsageWorld } from "../libraryUsage";

const LIB = "libf_A";
const g = (localID: number) => ({ sessionID: 7, localID });
const COPIES: Record<string, UsageCopy> = {
  "7:100": { library: LIB, key: "button", type: "component" },
  "7:101": { library: LIB, key: "chip", type: "component" },
  "7:110": { library: LIB, key: "toggle-on", type: "component", set: "toggle" },
  "7:111": { library: LIB, key: "toggle-off", type: "component", set: "toggle" },
  "7:200": { library: LIB, key: "red", type: "style" },
  "7:300": { library: LIB, key: "brand", type: "variable" },
};
function world(nodes: Record<string, unknown> = {}): UsageWorld & { reads: string[][] } {
  const reads: string[][] = [];
  return { reads, copy: (id) => COPIES[id] ?? null, invalidate: () => {}, read: (ids) => (reads.push([...ids]), ids.map((id) => nodes[id]).filter(Boolean)) };
}
const inst = (localID: number, main: number, parent = 1, phase: "CREATED" | undefined = "CREATED") => ({ guid: g(localID), ...(phase ? { phase } : {}), type: "INSTANCE", parentIndex: { guid: g(parent), position: "a" }, symbolData: { symbolID: g(main) } });
const frame = (localID: number, parent = 1) => ({ guid: g(localID), phase: "CREATED", type: "FRAME", parentIndex: { guid: g(parent), position: "a" } });
const solid = (variable?: number) => ({ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, ...(variable ? { colorVar: { value: { alias: { guid: g(variable) } }, dataType: "ALIAS" } } : {}) });
const sorted = (c: UsageCount[]) => [...c].sort((a, b) => `${a.asset}${a.action}`.localeCompare(`${b.asset}${b.action}`));

afterEach(() => vi.useRealTimers());

describe("library usage events (docs/data.md §17.3)", () => {
  it("a pasted frame holding three instances counts three; an instance nested in a pasted instance doesn't", () => {
    const r = new LibraryUsageRecorder(world(), () => {});
    const counts = r.onBatch("edit", [frame(10), inst(11, 100, 10), inst(12, 100, 10), inst(13, 101, 10), inst(14, 100, 11)], "Paste");
    expect(sorted(counts)).toEqual([
      { library: LIB, asset: "button", type: "component", action: "insert", count: 2 },
      { library: LIB, asset: "chip", type: "component", action: "insert", count: 1 },
    ]);
  });

  it("an instance created in an existing instance's slot counts; a local main doesn't", () => {
    const r = new LibraryUsageRecorder(world(), () => {});
    expect(r.onBatch("edit", [inst(20, 100, 5)], "Add instances")).toEqual([{ library: LIB, asset: "button", type: "component", action: "insert", count: 1 }]);
    expect(r.onBatch("edit", [inst(21, 999)], "Insert instance")).toEqual([]);
  });

  it("only the person's own edits count: undo, redo, system, remote and restore never do", () => {
    const r = new LibraryUsageRecorder(world(), () => {});
    for (const kind of ["undo", "redo", "system", "remote", "restore"] as const) expect(r.onBatch(kind, [inst(30, 100)])).toEqual([]);
  });

  it("a swap to another component counts; a variant switch inside one set doesn't; an unseen instance goes by the label", () => {
    const r = new LibraryUsageRecorder(world(), () => {});
    r.onBatch("system", [inst(40, 110)]); // seen: Toggle / On
    expect(r.onBatch("edit", [{ guid: g(40), symbolData: { symbolID: g(111) } }], "Apply property")).toEqual([]);
    expect(r.onBatch("edit", [{ guid: g(40), symbolData: { symbolID: g(100) } }], "Swap instance")).toEqual([{ library: LIB, asset: "button", type: "component", action: "insert", count: 1 }]);
    // Overrides rewrite symbolData with the same main: nothing
    expect(r.onBatch("edit", [{ guid: g(40), symbolData: { symbolID: g(100), symbolOverrides: [] } }], "Change text")).toEqual([]);
    expect(r.onBatch("edit", [{ guid: g(41), symbolData: { symbolID: g(101) } }], "Swap instance")).toEqual([{ library: LIB, asset: "chip", type: "component", action: "insert", count: 1 }]);
    expect(r.onBatch("edit", [{ guid: g(42), symbolData: { symbolID: g(101) } }], "Edit")).toEqual([]);
  });

  it("Detach instance counts a detach of its component", () => {
    const r = new LibraryUsageRecorder(world(), () => {});
    expect(r.onBatch("edit", [{ guid: g(50), type: "FRAME", detachedSymbolId: { guid: g(100) } }], "Detach instance")).toEqual([{ library: LIB, asset: "button", type: "component", action: "detach", count: 1 }]);
  });

  it("styles: applied (once per node and style), not on an inserted instance; detached only with the look written", () => {
    const r = new LibraryUsageRecorder(world(), () => {});
    const counts = r.onBatch("edit", [frame(60), { ...frame(61, 60), styleIdForFill: { guid: g(200) }, styleIdForStrokeFill: { guid: g(200) } }, { ...inst(62, 100), styleIdForFill: { guid: g(200) } }], "Paste");
    expect(sorted(counts)).toEqual([
      { library: LIB, asset: "button", type: "component", action: "insert", count: 1 },
      { library: LIB, asset: "red", type: "style", action: "insert", count: 1 },
    ]);
    // A plain removal: no detach; Detach style writes the fill inline: a detach
    expect(r.onBatch("edit", [{ guid: g(61), styleIdForStrokeFill: {} }], "Remove style")).toEqual([]);
    expect(r.onBatch("edit", [{ guid: g(61), styleIdForFill: {}, fillPaints: [solid()] }], "Detach style")).toEqual([{ library: LIB, asset: "red", type: "style", action: "detach", count: 1 }]);
    // An existing node never seen: Apply style counts by its label
    expect(r.onBatch("edit", [{ guid: g(63), styleIdForFill: { guid: g(200) } }], "Apply style")).toEqual([{ library: LIB, asset: "red", type: "style", action: "insert", count: 1 }]);
  });

  it("variables: a binding counts, not with a style applied to the same paints; Detach variable counts", () => {
    const r = new LibraryUsageRecorder(world(), () => {});
    expect(r.onBatch("edit", [{ ...frame(70), fillPaints: [solid(300)] }], "Paste")).toEqual([{ library: LIB, asset: "brand", type: "variable", action: "insert", count: 1 }]);
    expect(sorted(r.onBatch("edit", [{ ...frame(71), styleIdForFill: { guid: g(200) }, fillPaints: [solid(300)] }], "Paste"))).toEqual([{ library: LIB, asset: "red", type: "style", action: "insert", count: 1 }]);
    expect(r.onBatch("edit", [{ guid: g(70), fillPaints: [solid()] }], "Detach variable")).toEqual([{ library: LIB, asset: "brand", type: "variable", action: "detach", count: 1 }]);
    // A field binding: added, then removed with the raw value written
    expect(r.onBatch("edit", [{ guid: g(70), parameterConsumptionMap: { entries: [{ variableField: "WIDTH", variableData: { value: { alias: { guid: g(300) } } } }] } }], "Apply variable")).toEqual([{ library: LIB, asset: "brand", type: "variable", action: "insert", count: 1 }]);
    expect(r.onBatch("edit", [{ guid: g(70), parameterConsumptionMap: { entries: [] }, size: { x: 10, y: 10 } }], "Detach variable")).toEqual([{ library: LIB, asset: "brand", type: "variable", action: "detach", count: 1 }]);
  });

  it("the selection is read so a detach knows what a node pointed at", () => {
    const w = world({ "7:80": { guid: "7:80", type: "RECTANGLE", styleIdForFill: { guid: "7:200" } } });
    const r = new LibraryUsageRecorder(w, () => {});
    r.prime(["7:80", "I7:1;2"]);
    expect(w.reads).toEqual([["7:80"]]);
    expect(r.onBatch("edit", [{ guid: g(80), styleIdForFill: {}, fillPaints: [solid()] }], "Detach style")).toEqual([{ library: LIB, asset: "red", type: "style", action: "detach", count: 1 }]);
  });

  it("counts are handed over 2 s after the first, summed; a source's batches reach its recorder through noteLibraryUsage", () => {
    vi.useFakeTimers();
    const sink = vi.fn();
    const r = new LibraryUsageRecorder(world(), sink);
    r.onBatch("edit", [inst(90, 100)]);
    vi.advanceTimersByTime(1000);
    r.onBatch("edit", [inst(91, 100)]);
    expect(sink).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(sink).toHaveBeenCalledWith([{ library: LIB, asset: "button", type: "component", action: "insert", count: 2 }]);
    // Without an attached recorder the hook does nothing
    expect(() => noteLibraryUsage({}, "edit", [inst(92, 100)])).not.toThrow();
  });

  it("the editor's source is the store's own object, so the store's batches reach the editor's recorder", () => {
    vi.useFakeTimers();
    // The store's document source (it calls noteLibraryUsage(this, …)) and what EditorRoute gives the editor
    const record = vi.fn(async () => {});
    const raw = { fileKey: "F1", libraries: { fileKey: "F1", analytics: { reports: () => true, record } } };
    const source = withImages(raw, () => ({ put: async () => "", get: async () => null }));
    expect(source).toBe(raw);
    const engine = {
      destroyed: false,
      libraryUsage: () => [{ id: "7:100", key: "button", kind: "COMPONENT", libraryKey: LIB }],
      readNodes: () => [],
      onSelectionChanged: () => () => {},
    };
    const stop = attachLibraryUsage({ source, engine } as unknown as EditorController, () => 1);
    noteLibraryUsage(raw, "edit", [inst(90, 100)]);
    vi.advanceTimersByTime(2000);
    expect(record).toHaveBeenCalledWith([expect.objectContaining({ fileKey: "F1", libraryKey: LIB, assetKey: "button", action: "insert", count: 1 })]);
    stop();
  });
});
