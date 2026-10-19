// @vitest-environment happy-dom
// Fill / Stroke / Effect rows in the Design panel on the real engine, as Figma (live 2026-10-19,
// docs/research/figma/live/2026-10-18/property-rows-copy.txt): a click on a row's empty part selects it (⇧ a range,
// one section at a time, cleared by another layer or the canvas); Delete removes those items (one undo step); ⌘C
// writes the STYLE_PROPERTIES_* clipboard, and ⌘V adds its items on top of the layer's list, above a selected row,
// onto each of several equal layers, onto a group's layers — and nothing with nothing selected or mixed lists; a
// copy from Figma pastes the same way.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import type { Effect, Guid, Paint } from "@/engine/codec";
import { mount, type Mounted } from "@/ds/__tests__/dom";
import { EditorContext, EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { attachClipboard } from "../clipboardIO";
import { attachPropertyRows } from "../propertyRows";
import { DesignPanel } from "../panels/design/DesignPanel";
import { readClipboard, archiveMessage } from "../model/clipboard";
import { decodeMessage } from "../../../../shared/schema/codec";
import { figmaRowsHtml } from "./figmaRowsClipboard";

const wasm = resolve(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

const solid = (hex: number, opacity = 1): Paint => ({ type: "SOLID", color: { r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255, a: 1 }, opacity, visible: true, blendMode: "NORMAL" });
const shadow = (radius: number): Effect => ({ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius, spread: 0, visible: true, blendMode: "NORMAL", showShadowBehindNode: false }) as Effect;

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

async function setup() {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Rows" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const offClipboard = attachClipboard(ed);
  const offRows = attachPropertyRows(ed, canvas);
  const labels: string[] = [];
  engine.onAny((e) => {
    if (e.type === "DOCUMENT_CHANGED") labels.push(e.label);
  });
  const view: Mounted = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(DesignPanel)), {});
  cleanup.push(() => {
    view.unmount();
    offRows();
    offClipboard();
    canvas.remove();
    engine.destroy();
  });
  return { ed, engine, canvas, labels };
}

const fills = (engine: Engine, id: Guid) => (engine.readNode(id)?.fillPaints ?? []) as Paint[];
const hexes = (list: Paint[]) => list.map((p) => [p.color!.r, p.color!.g, p.color!.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join(""));
const rowsOf = (kind: "paint" | "effect") => [...document.querySelectorAll<HTMLElement>(kind === "paint" ? "[data-paint-row]" : "[data-effect-row]")];
/** The Fill section's rows (the first paint rows in the panel), top first. */
const fillRows = () => rowsOf("paint").filter((r) => r.closest("[data-ds='PanelSection']")?.textContent?.startsWith("Fill"));
const click = (el: HTMLElement, shift = false) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: shift })));
const key = (k: string) => act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));
const select = (engine: Engine, ids: Guid[]) => act(() => void engine.setSelection(ids));

/** A copy event with a clipboard to write into; its formats. */
function copy(): Record<string, string> {
  const data: Record<string, string> = {};
  const e = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clipboardData", { value: { setData: (t: string, v: string) => (data[t] = v), getData: (t: string) => data[t] ?? "", types: [] } });
  act(() => void document.body.dispatchEvent(e));
  return data;
}

/** A paste event of `formats`; waits for the (asynchronous) archive read. */
async function paste(formats: Record<string, string>): Promise<void> {
  const e = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clipboardData", { value: { getData: (t: string) => formats[t] ?? "", types: Object.keys(formats), files: [] } });
  await act(async () => {
    document.body.dispatchEvent(e);
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe("selecting Fill / Stroke / Effect rows", () => {
  it("a click on a row's empty part selects it (role row, aria-selected); ⇧ a range; the eye and minus don't", async () => {
    const { ed, engine } = await setup();
    engine.setProps(["1:5"], { fillPaints: [solid(0xff0000), solid(0x00ff00), solid(0x0000ff)] });
    select(engine, ["1:5"]);
    let rows = fillRows();
    expect(rows).toHaveLength(3);
    expect(rows[0].getAttribute("role")).toBe("row");
    click(rows[0]);
    rows = fillRows();
    expect(rows.map((r) => r.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(ed.ui.get().propertyRows).toEqual({ section: "fill", rows: [2], anchor: 0 });
    click(rows[2], true);
    expect(fillRows().map((r) => r.getAttribute("aria-selected"))).toEqual(["true", "true", "true"]);
    // The eye: its own action, no selection change.
    click(fillRows()[1].querySelector<HTMLElement>("button[aria-label='Toggle visibility']")!);
    expect(ed.ui.get().propertyRows?.rows).toEqual([0, 1, 2]);
    expect(engine.getSelection().refs).toEqual(["1:5"]);
  });

  it("one section at a time; another layer or a press on the canvas clears the rows", async () => {
    const { ed, engine, canvas } = await setup();
    engine.setProps(["1:5"], { effects: [shadow(4), shadow(8)] as never });
    select(engine, ["1:5"]);
    click(fillRows()[0]);
    expect(ed.ui.get().propertyRows?.section).toBe("fill");
    click(rowsOf("effect")[1], true);
    expect(ed.ui.get().propertyRows).toMatchObject({ section: "effect", rows: [0, 1] });
    expect(fillRows()[0].getAttribute("aria-selected")).toBe("false");
    select(engine, ["1:6"]);
    expect(ed.ui.get().propertyRows).toBeNull();
    select(engine, ["1:5"]);
    click(fillRows()[0]);
    act(() => void canvas.dispatchEvent(new Event("pointerdown")));
    expect(ed.ui.get().propertyRows).toBeNull();
  });

  it("Delete / Backspace removes the selected items, one undo step; the layer stays", async () => {
    const { ed, engine, labels } = await setup();
    engine.setProps(["1:5"], { fillPaints: [solid(0xff0000), solid(0x00ff00), solid(0x0000ff)] });
    select(engine, ["1:5"]);
    click(fillRows()[0]);
    click(fillRows()[1], true);
    labels.length = 0;
    key("Backspace");
    expect(hexes(fills(engine, "1:5"))).toEqual(["ff0000"]);
    expect(engine.readNode("1:5")).not.toBeNull();
    expect(engine.getSelection().refs).toEqual(["1:5"]);
    expect(ed.ui.get().propertyRows).toBeNull();
    expect(labels).toEqual(["Remove fill"]);
    act(() => void engine.command("UNDO"));
    expect(hexes(fills(engine, "1:5"))).toEqual(["ff0000", "00ff00", "0000ff"]);
  });
});

describe("⌘C / ⌘V on rows", () => {
  it("⌘C writes the STYLE_PROPERTIES_FILL Message; without a row it copies the layer", async () => {
    const { engine } = await setup();
    engine.setProps(["1:5"], { fillPaints: [solid(0xff0000), solid(0x0000ff, 0.5)] });
    select(engine, ["1:5"]);
    const layer = copy();
    click(fillRows()[0]);
    const rows = copy();
    const read = async (f: Record<string, string>) => {
      const p = readClipboard((t) => f[t]);
      return decodeMessage((await archiveMessage((p as { archive: Uint8Array }).archive))!);
    };
    expect((await read(layer)).pasteAssetType).toBeUndefined();
    expect(layer["text/plain"]).toBe("Card");
    expect(rows["text/plain"]).toBe("");
    const m = await read(rows);
    expect(m.pasteAssetType).toBe("STYLE_PROPERTIES_FILL");
    expect(m.clipboardSelectionRegions?.[0].nodes).toEqual([{ sessionID: 1, localID: 5 }]);
    const rect = m.nodeChanges!.find((n) => n.type === "ROUNDED_RECTANGLE")!;
    expect(rect.fillPaints).toHaveLength(1);
    expect(rect.fillPaints![0].opacity).toBe(0.5);
  });

  it("⌘V: on top of the layer's list; directly above a selected row (which the pasted rows then are); one undo step each", async () => {
    const { ed, engine, labels } = await setup();
    engine.setProps(["1:5"], { fillPaints: [solid(0xff0000), solid(0x0000ff)] });
    engine.setProps(["1:6"], { fillPaints: [solid(0x111111), solid(0x222222), solid(0x333333)] });
    select(engine, ["1:5"]);
    click(fillRows()[0]); // blue, the top one
    const blue = copy();
    select(engine, ["1:6"]);
    labels.length = 0;
    await paste(blue);
    expect(hexes(fills(engine, "1:6"))).toEqual(["111111", "222222", "333333", "0000ff"]);
    expect(ed.ui.get().propertyRows).toBeNull();
    expect(labels).toEqual(["Paste fill"]);
    // A row selected (222222, the panel's third): above it.
    click(fillRows()[2]);
    await paste(blue);
    expect(hexes(fills(engine, "1:6"))).toEqual(["111111", "222222", "0000ff", "333333", "0000ff"]);
    expect(ed.ui.get().propertyRows).toMatchObject({ section: "fill", rows: [2] });
    expect(fillRows().map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "false", "true", "false", "false"]);
    act(() => void engine.command("UNDO"));
    expect(hexes(fills(engine, "1:6"))).toEqual(["111111", "222222", "333333", "0000ff"]);
  });

  it("⌘V: nothing selected — nothing (no layer made); several layers with equal lists — each; mixed — nothing", async () => {
    const { engine } = await setup();
    engine.setProps(["1:5"], { fillPaints: [solid(0x0000ff)] });
    select(engine, ["1:5"]);
    click(fillRows()[0]);
    const blue = copy();
    select(engine, []);
    const before = engine.readNode("1:1", { childIds: true })?.childIds?.length;
    const pageKids = engine.readNode("0:1", { childIds: true })?.childIds?.length;
    await paste(blue);
    expect(engine.readNode("1:1", { childIds: true })?.childIds?.length).toBe(before);
    expect(engine.readNode("0:1", { childIds: true })?.childIds?.length).toBe(pageKids);
    // 1:2 and 1:4 differ (1E1E1E / 444444): nothing.
    select(engine, ["1:2", "1:4"]);
    await paste(blue);
    expect(hexes(fills(engine, "1:2"))).toEqual(["1e1e1e"]);
    expect(hexes(fills(engine, "1:4"))).toEqual(["444444"]);
    engine.setProps(["1:4"], { fillPaints: [solid(0x1e1e1e)] });
    select(engine, ["1:2", "1:4"]);
    await paste(blue);
    expect(hexes(fills(engine, "1:2"))).toEqual(["1e1e1e", "0000ff"]);
    expect(hexes(fills(engine, "1:4"))).toEqual(["1e1e1e", "0000ff"]);
  });

  it("⌘V onto a group: its layers get the paint on top of their own (when equal)", async () => {
    const { engine } = await setup();
    engine.setProps(["1:5"], { fillPaints: [solid(0x0000ff)] });
    engine.setProps(["1:24", "1:25"], { fillPaints: [solid(0xff24bd)] });
    select(engine, ["1:5"]);
    click(fillRows()[0]);
    const blue = copy();
    select(engine, ["1:23"]);
    await paste(blue);
    expect(hexes(fills(engine, "1:24"))).toEqual(["ff24bd", "0000ff"]);
    expect(hexes(fills(engine, "1:25"))).toEqual(["ff24bd", "0000ff"]);
    expect(fills(engine, "1:23")).toEqual([]);
  });

  it("effects copy and paste as effects, whatever section's row is selected; strokes give a first stroke its weight", async () => {
    const { engine } = await setup();
    engine.setProps(["1:5"], { effects: [shadow(4), shadow(8)] as never });
    select(engine, ["1:5"]);
    click(rowsOf("effect")[0]);
    click(rowsOf("effect")[1], true);
    const fx = copy();
    select(engine, ["1:6"]);
    click(fillRows()[0]);
    await paste(fx);
    expect(((engine.readNode("1:6")?.effects ?? []) as Effect[]).map((e) => e.radius)).toEqual([4, 8]);
    expect(hexes(fills(engine, "1:6"))).toEqual(["fff4d6"]);
    // 1:5's stroke onto a layer without one (1:22): the stroke, with weight 1.
    select(engine, ["1:5"]);
    const strokeRow = rowsOf("paint").find((r) => r.closest("[data-ds='PanelSection']")?.textContent?.startsWith("Stroke"))!;
    click(strokeRow);
    const stroke = copy();
    select(engine, ["1:22"]);
    await paste(stroke);
    const n = engine.readNode("1:22")!;
    expect(hexes((n.strokePaints ?? []) as Paint[])).toEqual(["d9d9d9"]);
    expect(n.strokeWeight).toBe(1);
  });

  it("Figma's copy of a Fill row pastes here as a fill", async () => {
    const { engine } = await setup();
    select(engine, ["1:5"]);
    await paste({ "text/html": figmaRowsHtml() });
    await vi.waitFor(() => expect(fills(engine, "1:5")).toHaveLength(2));
    const top = fills(engine, "1:5")[1];
    expect(hexes([top])).toEqual(["0000ff"]);
    expect(top.opacity).toBe(0.5);
  });
});
