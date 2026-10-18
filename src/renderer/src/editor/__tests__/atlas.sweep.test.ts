// The Atlas sweep of 2026-10-18 (the "As built … not done" lists of chapters 06, 09, 10, 11, 12, 13 and 15): the
// Missing fonts dialog's scopes, a grid item's span maxima, binding a variable to an Auto gap.
import { describe, expect, it } from "vitest";
import { currentToast, dismissToast } from "@/ds";
import type { NodeChange } from "@/engine/codec";
import { defaultModeToast, unaddedLibraries } from "../libraries";
import { publishRetryable } from "../panels/libraries/PublishDialog";
import { isHideUiKey, presentUrlOptions } from "../../present/PresentationView";
import { missingInScope } from "../panels/MissingFonts";
import { spanMax, type GridNode } from "../model/grid";
import { gapUnpacking } from "../variables";

describe("Missing fonts' scopes (atlas 06 §7)", () => {
  const missing = [
    { family: "Matter", style: "Medium", uses: 5 },
    { family: "Proxima Nova", style: "Bold", uses: 2 },
  ];
  it("lists the file's missing fonts the scope's layers name, with the scope's counts and layers", () => {
    const scoped = [
      { family: "matter", style: "medium", uses: 2, nodes: ["1:2", "1:3"] },
      { family: "Inter", style: "Regular", uses: 9, nodes: ["1:4"] },
    ];
    expect(missingInScope(missing, scoped)).toEqual([{ family: "Matter", style: "Medium", uses: 2, nodes: ["1:2", "1:3"] }]);
  });
  it("lists every missing font for All pages", () => {
    expect(missingInScope(missing, null)).toEqual(missing);
    expect(missingInScope(missing, [])).toEqual([]);
  });
});

describe("a grid item's span maxima (atlas 09 §6)", () => {
  const id = (l: number) => ({ sessionID: 1, localID: l });
  const grid: GridNode = {
    stackMode: "GRID",
    gridColumns: { entries: [1, 2, 3, 4].map((l, i) => ({ id: id(l), position: String.fromCharCode(33 + i) })) },
    gridRows: { entries: [5, 6].map((l, i) => ({ id: id(l), position: String.fromCharCode(33 + i) })) },
    gridAutoTracks: "NONE",
  };
  it("reaches the last track from the item's anchor", () => {
    expect(spanMax(grid, { gridColumnAnchor: id(1) }, "columns")).toBe(4);
    expect(spanMax(grid, { gridColumnAnchor: id(3) }, "columns")).toBe(2);
    expect(spanMax(grid, { gridRowAnchor: id(6) }, "rows")).toBe(1);
  });
  it("spans the whole axis without an anchor; Auto rows don't limit it", () => {
    expect(spanMax(grid, {}, "columns")).toBe(4);
    expect(spanMax({ ...grid, gridAutoTracks: "ROWS" }, { gridRowAnchor: id(6) }, "rows")).toBe(100);
  });
});

describe("a library update that changes a collection's default mode (atlas 11 §3.2)", () => {
  it("tells it once, naming the collection and its new default", () => {
    dismissToast();
    defaultModeToast(new Map([["1:1", { mode: "1:2" }]]), new Map([["1:1", { collection: "Theme", mode: "1:2", modeName: "Light" }]]));
    expect(currentToast()).toBeNull();
    defaultModeToast(new Map([["1:1", { mode: "1:2" }]]), new Map([["1:1", { collection: "Theme", mode: "1:3", modeName: "Dark" }]]));
    expect(currentToast()?.message).toBe("The default mode of Theme is now Dark");
    dismissToast();
  });
});

describe("libraries (atlas 12 §3.8, §10.2)", () => {
  const entry = (fileKey: string, name: string) => ({ fileKey, name }) as never;
  const state = { on: true, own: { libraryFileKey: "own" } as never, available: [entry("a", "Icons"), entry("b", "Brand"), entry("own", "This")], enabled: ["b"], names: new Map<string, string>() };
  it("names the published libraries a paste brought copies from that aren't added", () => {
    expect(unaddedLibraries(state, new Set(), new Set(["a", "b", "own", "gone"]))).toEqual([{ library: "a", name: "Icons" }]);
    expect(unaddedLibraries(state, new Set(["a"]), new Set(["a"]))).toEqual([]);
    expect(unaddedLibraries({ ...state, on: false }, new Set(), new Set(["a"]))).toEqual([]);
  });
  it("offers Retry where retrying can help", () => {
    expect(publishRetryable({ code: "offline" })).toBe(true);
    expect(publishRetryable(new Error("boom"))).toBe(true);
    expect(publishRetryable({ code: "too-large" })).toBe(false);
    expect(publishRetryable({ code: "conflict" })).toBe(false);
    expect(publishRetryable({ code: "forbidden", detail: { code: "seat_required" } })).toBe(false);
  });
});

describe("a prototype link's parameters (atlas 13 §10.6)", () => {
  const read = (q: string) => presentUrlOptions(new URLSearchParams(q));
  it("maps Figma's scaling, hints, device frame, hidden UI and start node", () => {
    expect(read("scaling=min-zoom")).toEqual({ scale: "ACTUAL" });
    expect(read("scaling=scale-down&hotspot-hints=0")).toEqual({ scale: "FIT", hints: false });
    expect(read("scaling=scale-down-width&device-frame=0&hide-ui=1")).toEqual({ scale: "FIT_WIDTH", deviceFrame: false, hideUi: true });
    expect(read("scaling=contain")).toEqual({ scale: "FILL" });
    expect(read("scaling=contain&content-scaling=responsive")).toEqual({ scale: "RESPONSIVE" });
    expect(read("node-id=12-34&starting-point-node-id=1-2")).toEqual({ node: "12:34" });
    expect(read("starting-point-node-id=1%3A2")).toEqual({ node: "1:2" });
  });
  it("ignores what it doesn't know", () => {
    expect(read("scaling=zoom&hotspot-hints=1&node-id=abc")).toEqual({});
  });
});

describe("Hide / show UI's key in the presentation view (atlas 13 §10.3)", () => {
  const key = (k: string, code: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({ key: k, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  it("is ⌘\\ on the Mac, Ctrl+\\ elsewhere, the layout's character on that key too", () => {
    expect(isHideUiKey(key("\\", "Backslash", { metaKey: true }), true)).toBe(true);
    expect(isHideUiKey(key("^", "Backquote", { metaKey: true }), true)).toBe(true); // German
    expect(isHideUiKey(key("\\", "Backslash", { ctrlKey: true }), false)).toBe(true);
    expect(isHideUiKey(key("\\", "Backslash", { ctrlKey: true }), true)).toBe(false);
    expect(isHideUiKey(key("\\", "Backslash", {}), true)).toBe(false);
    expect(isHideUiKey(key("a", "KeyA", { metaKey: true }), true)).toBe(false);
  });
});

describe("binding a variable to an Auto gap (atlas 09 §3.3 – §3.4)", () => {
  const node = (f: Record<string, unknown>) => ({ guid: "1:1", ...f }) as unknown as NodeChange;
  it("packs a Between / Evenly / Around gap and turns an Auto gap between rows to AUTO", () => {
    expect(gapUnpacking([node({ stackPrimaryAlignItems: "SPACE_EVENLY" })], ["STACK_SPACING"])).toEqual([{ guid: "1:1", fields: { stackPrimaryAlignItems: "MIN" } }]);
    expect(gapUnpacking([node({ stackPrimaryAlignItems: "SPACE_AROUND" })], ["STACK_SPACING"])[0].fields).toEqual({ stackPrimaryAlignItems: "MIN" });
    expect(gapUnpacking([node({ stackCounterAlignContent: "SPACE_BETWEEN" })], ["STACK_COUNTER_SPACING"])[0].fields).toEqual({ stackCounterAlignContent: "AUTO" });
  });
  it("leaves a packed gap and other fields alone", () => {
    expect(gapUnpacking([node({ stackPrimaryAlignItems: "CENTER" })], ["STACK_SPACING"])).toEqual([]);
    expect(gapUnpacking([node({ stackPrimaryAlignItems: "SPACE_EVENLY" })], ["PADDING_LEFT"])).toEqual([]);
  });
});
