// @vitest-environment happy-dom
// Round 16 — the padding fields as live Figma's (the owner's 53–55.png): a pair whose sides differ reads "19, 22" /
// "18, 17", typed lists set a pair's two sides, ⌘-click on any padding field makes one field "18, 22, 17, 19" (top,
// right, bottom, left) that takes CSS's shorthand and goes back when the keys leave it; ↑ steps each side; a padding or
// gap field under the pointer hatches what it edits on the canvas (Engine.setSpacingHighlight).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { $, key, mount, pointer, type, type Mounted } from "../../ds/__tests__/dom";
import { EditorContext, EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { useNodes } from "../hooks";
import { paddingOf } from "../model/padding";
import { LayoutSection } from "../panels/design/Layout";
import type { PanelNode } from "../panels/design/shared";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
const FRAME = "1:7";

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

async function setup() {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Test" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  // An auto-layout frame, padding 18 / 22 / 17 / 19 (top, right, bottom, left) as on 53.png.
  ed.setProps([FRAME], { stackMode: "VERTICAL", stackSpacing: 16, stackVerticalPadding: 18, stackPaddingRight: 22, stackPaddingBottom: 17, stackHorizontalPadding: 19 } as never, "Auto layout");
  engine.setSelection([FRAME]);
  const highlights: number[] = [];
  const set = engine.setSpacingHighlight.bind(engine);
  engine.setSpacingHighlight = (mask: number) => {
    highlights.push(mask);
    set(mask);
  };
  function Harness() {
    const nodes = useNodes([FRAME]) as PanelNode[];
    return nodes.length ? createElement(LayoutSection, { nodes }) : null;
  }
  m = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(Harness)), {});
  const pads = () => paddingOf(engine.readNode(FRAME) as never);
  return { ed, engine, highlights, pads, host: m.host };
}

const input = (host: HTMLElement, label: string) => $(`input[aria-label="${label}"]`, host) as HTMLInputElement | null;
const commit = (el: HTMLInputElement, text: string) => {
  act(() => el.focus());
  type(el, text);
  key(el, "Enter");
};
/** React's onPointerEnter / Leave come from pointerover / pointerout at its root. */
const hover = (el: Element, on: boolean) =>
  act(() => {
    el.dispatchEvent(new PointerEvent(on ? "pointerover" : "pointerout", { bubbles: true, pointerId: 1, pointerType: "mouse", relatedTarget: on ? null : document.body }));
  });
const metaPress = (el: Element) =>
  act(() => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, metaKey: true }));
  });

describe("r16 padding fields", () => {
  it('a pair whose sides differ reads "19, 22" / "18, 17" (not Mixed, not four fields)', async () => {
    const { host } = await setup();
    expect(input(host, "Horizontal padding")?.value).toBe("19, 22");
    expect(input(host, "Vertical padding")?.value).toBe("18, 17");
    expect(input(host, "Left padding")).toBeNull();
    expect(host.querySelector('[data-mixed][aria-label="Horizontal padding"]')).toBeNull();
  });

  it('"12, 18" in a pair sets its two sides; one number sets both; ↑ steps each side from its own value', async () => {
    const { host, pads } = await setup();
    commit(input(host, "Horizontal padding")!, "12, 18");
    expect(pads()).toEqual({ top: 18, right: 18, bottom: 17, left: 12 });
    expect(input(host, "Horizontal padding")?.value).toBe("12, 18");
    commit(input(host, "Vertical padding")!, "6");
    expect(pads()).toEqual({ top: 6, right: 18, bottom: 6, left: 12 });
    const h = input(host, "Horizontal padding")!;
    act(() => h.focus());
    key(h, "ArrowUp");
    expect(pads()).toEqual({ top: 6, right: 19, bottom: 6, left: 13 });
    expect(h.value).toBe("13, 19");
  });

  it('⌘-click on any padding field: one field "18, 22, 17, 19", focused; CSS shorthand typed; back to the pair when it leaves', async () => {
    const { host, pads, highlights } = await setup();
    metaPress(input(host, "Vertical padding")!);
    const one = input(host, "Padding")!;
    expect(one).not.toBeNull();
    expect(one.value).toBe("18, 22, 17, 19");
    expect(document.activeElement).toBe(one);
    expect(input(host, "Horizontal padding")).toBeNull();
    // The one field hatches all four sides.
    expect(highlights.at(-1)).toBe(15);
    type(one, "12, 18");
    key(one, "Enter");
    expect(pads()).toEqual({ top: 12, right: 18, bottom: 12, left: 18 });
    // Enter took the keys back to the canvas: the pair again.
    expect(input(host, "Padding")).toBeNull();
    expect(input(host, "Horizontal padding")?.value).toBe("18");
    expect(input(host, "Vertical padding")?.value).toBe("12");
    // Three values: top, horizontal, bottom; four: top, right, bottom, left; one: all.
    metaPress(input(host, "Horizontal padding")!);
    commit(input(host, "Padding")!, "1, 2, 3");
    expect(pads()).toEqual({ top: 1, right: 2, bottom: 3, left: 2 });
    metaPress(input(host, "Horizontal padding")!);
    commit(input(host, "Padding")!, "4, 5, 6, 7");
    expect(pads()).toEqual({ top: 4, right: 5, bottom: 6, left: 7 });
    metaPress(input(host, "Horizontal padding")!);
    expect(input(host, "Padding")?.value).toBe("4, 5, 6, 7");
    commit(input(host, "Padding")!, "9");
    expect(pads()).toEqual({ top: 9, right: 9, bottom: 9, left: 9 });
    expect(input(host, "Horizontal padding")?.value).toBe("9");
  });

  it('scrubbing "19, 22" moves each side from its own value in whole steps; one undo step; Esc puts them back', async () => {
    const { host, pads, engine } = await setup();
    const prefix = input(host, "Horizontal padding")!.closest('[data-ds="NumericInput"]')!.firstElementChild!;
    pointer(prefix, "pointerdown", { clientX: 100 });
    pointer(prefix, "pointermove", { clientX: 120 });
    pointer(prefix, "pointermove", { clientX: 140 });
    expect(pads()).toEqual({ top: 18, right: 32, bottom: 17, left: 29 });
    pointer(prefix, "pointerup", { clientX: 140 });
    expect(input(host, "Horizontal padding")?.value).toBe("29, 32");
    act(() => engine.undo());
    expect(pads()).toEqual({ top: 18, right: 22, bottom: 17, left: 19 });
    pointer(prefix, "pointerdown", { clientX: 100 });
    pointer(prefix, "pointermove", { clientX: 60 });
    expect(pads()).toEqual({ top: 18, right: 12, bottom: 17, left: 9 });
    key(document.body, "Escape");
    expect(pads()).toEqual({ top: 18, right: 22, bottom: 17, left: 19 });
  });

  it("Individual padding: the four sides; ⌘-click on one of them merges too", async () => {
    const { host } = await setup();
    act(() => ($('[aria-label="Individual padding"]', host) as HTMLElement).click());
    expect(input(host, "Left padding")?.value).toBe("19");
    expect(input(host, "Top padding")?.value).toBe("18");
    expect(input(host, "Right padding")?.value).toBe("22");
    expect(input(host, "Bottom padding")?.value).toBe("17");
    metaPress(input(host, "Bottom padding")!);
    expect(input(host, "Padding")?.value).toBe("18, 22, 17, 19");
  });

  it("a padding or gap field under the pointer hatches what it edits on the canvas", async () => {
    const { host, highlights } = await setup();
    const field = (sides: string) => host.querySelector(`[data-padding-field="${sides}"]`)!;
    hover(field("left,right"), true);
    expect(highlights.at(-1)).toBe(1 | 4);
    hover(field("left,right"), false);
    expect(highlights.at(-1)).toBe(0);
    hover(field("top,bottom"), true);
    expect(highlights.at(-1)).toBe(2 | 8);
    hover(field("top,bottom"), false);
    const gap = input(host, "Vertical gap between objects")!.closest('[data-ds="NumericInput"]')!;
    hover(gap, true);
    expect(highlights.at(-1)).toBe(16);
    hover(gap, false);
    // Focused, it stays hatched while the pointer is elsewhere.
    act(() => input(host, "Horizontal padding")!.focus());
    expect(highlights.at(-1)).toBe(1 | 4);
    act(() => input(host, "Horizontal padding")!.blur());
    expect(highlights.at(-1)).toBe(0);
  });
});
