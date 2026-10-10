// Round 8 (r8-selection): the keys, menus and view options of the selection / canvas audit's open items — as plain
// data — and on the real engine (the committed Wasm build, headless in Node): ruler guides from a ruler, the
// eyedropper's COLOR_PICK, the Scale / Slice / Comment tools, nudge amounts, view options, the auto-layout bar's
// in-place edit.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { MOD_ALT, MOD_SHIFT, PointerType, Status, TOOLS } from "@/engine/abi";
import { cssCursor } from "@/engine/cursors";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import type { EventOf, NodeFields } from "@/engine/codec";
import { COMMAND_BY_ID, comboText, matchesCombo } from "../commands";
import { MAIN_MENU } from "../menus";
import { DEFAULT_NUDGE, loadNudge, viewOptionsOf } from "../canvasTools";
import type { UIState } from "../uiStore";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

const key = (code: string, mods: Partial<Record<"shiftKey" | "altKey" | "ctrlKey" | "metaKey", boolean>> = {}) => ({
  code,
  shiftKey: !!mods.shiftKey,
  altKey: !!mods.altKey,
  ctrlKey: !!mods.ctrlKey,
  metaKey: !!mods.metaKey,
});
const pressed = (id: string, e: ReturnType<typeof key>) => COMMAND_BY_ID.get(id)!.keys!.some((c) => matchesCombo(c, e, true));
const sub = (specs: unknown[], label: string) => (specs.find((s) => typeof s === "object" && s && "label" in s && (s as { label: string }).label === label) as { items: unknown[] }).items;

describe("round 8: keys and menus", () => {
  it("tools: K Scale, S Slice, C Comment, I and ⌃C the eyedropper (Pick color), Y Annotation (live toolbar)", () => {
    expect(pressed("tool.scale", key("KeyK"))).toBe(true);
    expect(pressed("tool.slice", key("KeyS"))).toBe(true);
    expect(pressed("tool.comment", key("KeyC"))).toBe(true);
    expect(pressed("edit.pick-color", key("KeyI"))).toBe(true);
    expect(pressed("edit.pick-color", key("KeyC", { ctrlKey: true }))).toBe(true);
    expect(comboText(COMMAND_BY_ID.get("edit.pick-color")!.keys![0])).toContain("C");
    expect(pressed("tool.annotation", key("KeyY"))).toBe(true);
    expect(TOOLS).toContain("EYEDROPPER");
  });

  it("view keys: ⌃P and ⇧⌘P pixel preview, ⇧⌘′ snap to pixel grid, ⌥R the rotation origin", () => {
    expect(pressed("view.pixel-preview", key("KeyP", { ctrlKey: true }))).toBe(true);
    expect(pressed("view.pixel-preview", key("KeyP", { metaKey: true, shiftKey: true }))).toBe(true);
    expect(pressed("view.snap-pixel-grid", key("Quote", { metaKey: true, shiftKey: true }))).toBe(true);
    expect(pressed("object.rotation-origin", key("KeyR", { altKey: true }))).toBe(true);
  });

  it("Text › Adjust: size ⇧⌘. / ⇧⌘,, weight ⌥⌘. / ⌥⌘,, line height ⌥⇧. / ⌥⇧,, letter spacing ⌥. / ⌥,", () => {
    expect(pressed("text.font-size-up", key("Period", { metaKey: true, shiftKey: true }))).toBe(true);
    expect(pressed("text.font-size-down", key("Comma", { metaKey: true, shiftKey: true }))).toBe(true);
    expect(pressed("text.font-weight-up", key("Period", { metaKey: true, altKey: true }))).toBe(true);
    expect(pressed("text.line-height-down", key("Comma", { altKey: true, shiftKey: true }))).toBe(true);
    expect(pressed("text.letter-spacing-up", key("Period", { altKey: true }))).toBe(true);
    const adjust = sub(sub(MAIN_MENU, "Text"), "Adjust").filter((s) => s !== "-");
    expect(adjust).toHaveLength(8);
  });

  it("menus: View has Show slices and Pixel preview where live Figma has them; Preferences has Snap to pixel grid and Nudge amount", () => {
    const view = sub(MAIN_MENU, "View").filter((s): s is string => typeof s === "string");
    expect(view.slice(0, 4)).toEqual(["view.pixel-grid", "view.layout-guides", "view.rulers", "view.show-slices"]);
    expect(view).toContain("view.pixel-preview");
    const prefs = sub(MAIN_MENU, "Preferences").filter((s): s is string => typeof s === "string");
    expect(prefs.slice(0, 3)).toEqual(["prefs.snap-to-geometry", "prefs.snap-to-objects", "view.snap-pixel-grid"]);
    expect(prefs).toContain("prefs.nudge-amount");
    expect(COMMAND_BY_ID.get("prefs.nudge-amount")!.label).toBe("Nudge amount…");
  });

  it("view options from the UI: snap to pixel grid and slices on by default, rulers as the UI has them", () => {
    const ui = { rulers: true } as UIState;
    expect(viewOptionsOf(ui)).toMatchObject({ pixelGrid: true, outlines: false, layoutGuides: true, rulers: true, snapToPixelGrid: true, showSlices: true, pixelPreview: 0 });
    expect(viewOptionsOf({ ...ui, rulers: false, snapToPixelGrid: false, pixelPreview: 1 } as UIState)).toMatchObject({ rulers: false, snapToPixelGrid: false, pixelPreview: 1 });
    expect(loadNudge()).toEqual(DEFAULT_NUDGE); // no storage in Node: Figma's 1 and 10
  });

  it("Figma's own cursors: SVG arrows, crosshair, magnifiers, eyedropper, scale and comment, the system ones behind", () => {
    for (const kind of ["DEFAULT", "CROSSHAIR", "ZOOM_IN", "ZOOM_OUT", "EYEDROPPER", "SCALE", "COMMENT", "MOVE_DUPLICATE"] as const)
      expect(cssCursor(kind, 0)).toMatch(/^image-set\(url\("data:image\/svg\+xml,/);
    expect(cssCursor("DEFAULT", 0)).toMatch(/, default$/);
    expect(cssCursor("ZOOM_OUT", 0)).toMatch(/, zoom-out$/);
    expect(cssCursor("HAND", 0)).toBe("grab");
  });
});

describe("round 8 on the engine", () => {
  const make = async () => {
    const engine = await Engine.create(null, { sessionID: 1 });
    engine.setViewport(1280, 800, 1, 1280, 800);
    engine.load(SAMPLE_DOCUMENT);
    engine.setCamera({ x: 100, y: 100, zoom: 1 });
    return engine;
  };

  it("guides: dragged out of the top ruler onto the page (rulers on), selected, removed with ⌫", async () => {
    const engine = await make();
    expect(engine.startGuide("Y", 600, 10, 20)).not.toBe(Status.OK); // rulers off
    engine.setViewOptions({ pixelGrid: true, outlines: false, rulers: true });
    expect(engine.startGuide("Y", 600, 10, 20)).toBe(Status.OK);
    engine.pointer(PointerType.MOVE, 600, 300, 0, 1, 0);
    engine.pointer(PointerType.UP, 600, 300, 0, 0, 0);
    const page = engine.readNode("0:1") as { guides?: { axis: string; offset: number }[] } | null;
    expect(page?.guides).toEqual([expect.objectContaining({ axis: "Y", offset: 200 })]);
    // A click on it selects it; ⌫ removes it (the engine's key).
    engine.pointer(PointerType.MOVE, 1100, 300, 0, 0, 0);
    engine.pointer(PointerType.DOWN, 1100, 300, 0, 1, 0);
    engine.pointer(PointerType.UP, 1100, 300, 0, 0, 0);
    expect(engine.commandState("REMOVE_GUIDE") & 1).toBe(1);
    engine.key("down", "Backspace", "Backspace", 0);
    expect((engine.readNode("0:1") as { guides?: unknown[] }).guides ?? []).toHaveLength(0);
    engine.destroy();
  });

  it("the eyedropper: a click emits COLOR_PICK at the point and the tool goes back to Move; Comment takes no clicks", async () => {
    const engine = await make();
    const picks: EventOf<"COLOR_PICK">[] = [];
    const tools: string[] = [];
    engine.on("COLOR_PICK", (e) => picks.push(e));
    engine.on("TOOL_CHANGED", (e) => tools.push(e.tool));
    expect(engine.setTool("EYEDROPPER")).toBe(Status.OK);
    engine.pointer(PointerType.DOWN, 150, 150, 0, 1, 0);
    engine.pointer(PointerType.UP, 150, 150, 0, 0, 0);
    expect(picks).toEqual([expect.objectContaining({ x: 150, y: 150 })]);
    expect(tools.at(-1)).toBe("MOVE");
    engine.setSelection([]);
    expect(engine.setTool("COMMENT")).toBe(Status.OK);
    engine.pointer(PointerType.DOWN, 150, 150, 0, 1, 0);
    engine.pointer(PointerType.UP, 150, 150, 0, 0, 0);
    expect(engine.getSelection().refs).toEqual([]);
    engine.destroy();
  });

  it("the Scale tool (K) doubles a card and its corner radius; the Slice tool (S) draws a slice", async () => {
    const engine = await make();
    expect(engine.setTool("SCALE")).toBe(Status.OK);
    engine.setSelection(["1:5"]); // Card: 280 × 160 at (24, 88) in Desktop, radius 12 → screen 124..404 × 188..348
    engine.pointer(PointerType.MOVE, 404, 348, 0, 0, 0);
    engine.pointer(PointerType.DOWN, 404, 348, 0, 1, 0);
    for (let i = 1; i <= 4; i++) engine.pointer(PointerType.MOVE, 404 + 70 * i, 348 + 40 * i, 0, 1, 0);
    engine.pointer(PointerType.UP, 684, 508, 0, 0, 0);
    const card = engine.readNode("1:5") as { size: { x: number; y: number }; cornerRadius?: number; rectangleTopLeftCornerRadius?: number } & NodeFields;
    expect(card.size).toEqual({ x: 560, y: 320 });
    expect(card.rectangleTopLeftCornerRadius ?? card.cornerRadius).toBe(24);
    expect(engine.setTool("SLICE")).toBe(Status.OK);
    engine.pointer(PointerType.DOWN, 1000, 650, 0, 1, 0);
    engine.pointer(PointerType.MOVE, 1050, 700, 0, 1, 0);
    engine.pointer(PointerType.UP, 1100, 750, 0, 0, 0);
    const slice = engine.readNode(engine.getSelection().refs[0]) as { type: string; name: string; exportSettings?: unknown[] };
    expect(slice.type).toBe("SLICE");
    expect(slice.name).toBe("Slice 1");
    expect(slice.exportSettings).toHaveLength(1);
    engine.destroy();
  });

  it("nudge amounts: the arrows move by Small nudge, ⇧ by Big nudge", async () => {
    const engine = await make();
    engine.setSelection(["1:20"]); // at (0, 480)
    engine.setNudge(5, 50);
    engine.key("down", "ArrowRight", "ArrowRight", 0);
    engine.key("down", "ArrowDown", "ArrowDown", 1);
    const n = engine.readNode("1:20") as { transform: { m02: number; m12: number } };
    expect(n.transform.m02).toBe(5);
    expect(n.transform.m12).toBe(530);
    engine.destroy();
  });

  it("a click on an auto-layout bar asks to edit its value in place (REQUEST_INLINE_EDIT)", async () => {
    const engine = await make();
    expect(engine.setProps(["1:7"], { stackMode: "HORIZONTAL", stackSpacing: 10, stackHorizontalPadding: 16, stackVerticalPadding: 16, stackPaddingRight: 16, stackPaddingBottom: 16, stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED" } as unknown as NodeFields)).toBe(0);
    engine.setSelection(["1:7"]); // Clip at (24, 272) in Desktop: 592 × 124 → screen 124..716 × 372..496
    const edits: EventOf<"REQUEST_INLINE_EDIT">[] = [];
    engine.on("REQUEST_INLINE_EDIT", (e) => edits.push(e));
    engine.pointer(PointerType.MOVE, 130, 434, 0, 0, 0); // the left padding
    engine.pointer(PointerType.DOWN, 130, 434, 0, 1, 0);
    engine.pointer(PointerType.UP, 130, 434, 0, 0, 0);
    expect(edits).toEqual([expect.objectContaining({ ref: "1:7", field: "PADDING_LEFT", value: 16 })]);
    // Round 15: ⌥-click on the left padding off its bar — left and right; ⌥⇧ — all four (help.figma.com).
    for (const [mods, field] of [[MOD_ALT, "PADDING_HORIZONTAL"], [MOD_ALT | MOD_SHIFT, "PADDING_ALL"]] as const) {
      edits.length = 0;
      engine.pointer(PointerType.MOVE, 132, 400, 0, 0, mods);
      engine.pointer(PointerType.DOWN, 132, 400, 0, 1, mods);
      engine.pointer(PointerType.UP, 132, 400, 0, 0, mods);
      expect(edits).toEqual([expect.objectContaining({ ref: "1:7", field, value: 16 })]);
    }
    engine.destroy();
  });
});
