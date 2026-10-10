// @vitest-environment happy-dom
// Round 17 — the Design panel as the owner's live Figma (74–77.png, docs/research/panel17): no per-row labels ("Flow",
// "Dimensions", "Alignment" / "Gap", "Padding") unless View › Additional labels is on; W / H fields — Fixed shows its
// number and the chevron, Hug / Fill the number grey and the mode's word in the chevron's place (hovered too); Tab goes
// from text field to text field, the field menus and "Apply variable" no tab stops (⌥↓ opens them from the field).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { $, $$, key, mount, type, type Mounted } from "../../ds/__tests__/dom";
import { EditorContext, EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { useNodes } from "../hooks";
import { sizingChanges } from "../model/sizing";
import { LayoutSection } from "../panels/design/Layout";
import { designPanelTab } from "../panels/design/tabOrder";
import type { PanelNode } from "../panels/design/shared";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
const FRAME = "1:7";
const CHILD = "1:9";

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

/** A vertical auto-layout frame: W fixed, H hugging; `select` is shown in the Layout section inside a Design-panel-like box. */
async function setup(select = FRAME) {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Test" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  ed.setProps([FRAME], { stackMode: "VERTICAL", stackSpacing: 10, stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "FIXED" } as never, "Auto layout");
  engine.setSelection([select]);
  function Harness() {
    const nodes = useNodes([select]) as PanelNode[];
    return createElement("div", { onKeyDownCapture: designPanelTab, "data-panel-body": "" }, nodes.length ? createElement(LayoutSection, { nodes }) : null);
  }
  m = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(Harness)), {});
  return { ed, engine, host: m.host };
}

const input = (host: HTMLElement, label: string) => $(`input[aria-label="${label}"]`, host) as HTMLInputElement | null;
const box = (el: Element | null) => el?.closest('[data-ds="NumericInput"]') as HTMLElement | null;
const sizingButton = (host: HTMLElement, label: string) => box(input(host, label))?.querySelector<HTMLButtonElement>("[data-field-menu]") ?? null;

describe("r17 Design panel: no per-row labels by default", () => {
  it("shows only the section title; View › Additional labels brings Flow, Resizing, Alignment / Gap, Padding back", async () => {
    const { ed, host } = await setup();
    expect(ed.ui.get().propertyLabels).toBe(false);
    const text = () => host.textContent ?? "";
    expect(text()).toContain("Auto layout");
    for (const l of ["Flow", "Resizing", "Dimensions", "Alignment", "Gap", "Padding"]) expect(text(), l).not.toContain(l);
    act(() => ed.ui.set({ propertyLabels: true }));
    const t = host.textContent ?? "";
    for (const l of ["Flow", "Resizing", "Alignment", "Gap", "Padding"]) expect(t, l).toContain(l);
  });
});

describe("r17 W / H fields", () => {
  it("Fixed: the number in the text colour and the chevron; Hug: the number grey and the word Hug, no chevron", async () => {
    const { host } = await setup();
    const w = sizingButton(host, "Horizontal resizing");
    const h = sizingButton(host, "Vertical resizing");
    // W fixed: a chevron glyph, no word; the number not dimmed.
    expect(w?.querySelector("svg")).toBeTruthy();
    expect(w?.textContent).toBe("");
    expect(box(input(host, "Horizontal resizing"))?.hasAttribute("data-dim-value")).toBe(false);
    // H hugs: the word, no glyph; the number dimmed.
    expect(h?.textContent).toBe("Hug");
    expect(h?.querySelector("svg")).toBeNull();
    expect(box(input(host, "Vertical resizing"))?.hasAttribute("data-dim-value")).toBe(true);
    // Hovered, nothing swaps: the word stays and no chevron comes.
    const hb = box(input(host, "Vertical resizing"))!;
    hb.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerId: 1, pointerType: "mouse" }));
    hb.dispatchEvent(new PointerEvent("pointerenter", { pointerId: 1, pointerType: "mouse" }));
    expect(sizingButton(host, "Vertical resizing")?.textContent).toBe("Hug");
    expect(hb.querySelector("svg")).toBeNull();
    // Focused, the number is the text colour again (typing replaces it).
    act(() => input(host, "Vertical resizing")!.focus());
    expect(hb.hasAttribute("data-dim-value")).toBe(false);
  });

  it("Fill: a layer filling its auto-layout parent's width reads its number grey and the word Fill", async () => {
    const { ed, engine } = await setup();
    const child = engine.readNode(CHILD) as never;
    const parent = engine.readNode(FRAME) as never;
    const { node, parent: pf } = sizingChanges(child, parent, "x", "FILL");
    ed.batch("Fill container", () => {
      if (pf) engine.setProps([FRAME], pf);
      engine.setProps([CHILD], node);
    });
    m!.unmount();
    m = null;
    const { host } = await setupWith(ed);
    expect(sizingButton(host, "Horizontal resizing")?.textContent).toBe("Fill");
    expect(box(input(host, "Horizontal resizing"))?.hasAttribute("data-dim-value")).toBe(true);
  });
});

/** The Layout section of the child, on an editor already set up. */
async function setupWith(ed: EditorController) {
  ed.engine.setSelection([CHILD]);
  function Harness() {
    const nodes = useNodes([CHILD]) as PanelNode[];
    return createElement("div", { onKeyDownCapture: designPanelTab }, nodes.length ? createElement(LayoutSection, { nodes }) : null);
  }
  m = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(Harness)), {});
  return { host: m.host };
}

describe("r17 Tab order", () => {
  it("the field menus and Apply variable are no tab stops", async () => {
    const { host } = await setup();
    const menus = $$("[data-field-menu]", host);
    expect(menus.length).toBeGreaterThanOrEqual(3); // W, H, the gap's list (and Apply variable on the paddings)
    for (const b of menus) expect((b as HTMLElement).tabIndex, b.getAttribute("aria-label") ?? "").toBe(-1);
    expect($$('[aria-label="Apply variable"]', host).every((b) => (b as HTMLElement).tabIndex === -1)).toBe(true);
  });

  it("Tab / ⇧Tab go from text field to text field (W → H → gap → paddings), skipping every button", async () => {
    const { host } = await setup();
    const order = ["Horizontal resizing", "Vertical resizing", "Vertical gap between objects", "Horizontal padding", "Vertical padding"];
    const w = input(host, order[0])!;
    act(() => w.focus());
    for (let i = 1; i < order.length; i++) {
      key(document.activeElement!, "Tab");
      expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe(order[i]);
    }
    for (let i = order.length - 2; i >= 0; i--) {
      key(document.activeElement!, "Tab", { shiftKey: true });
      expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe(order[i]);
    }
    // At either end it goes round.
    key(document.activeElement!, "Tab", { shiftKey: true });
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe(order[order.length - 1]);
  });

  it("a value typed and then Tab is committed", async () => {
    const { engine, host } = await setup();
    const w = input(host, "Horizontal resizing")!;
    act(() => w.focus());
    type(w, "300");
    key(w, "Tab");
    expect((engine.readNode(FRAME) as { size: { x: number } }).size.x).toBe(300);
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("Vertical resizing");
  });

  it("⌥↓ in W opens its sizing list", async () => {
    const { host } = await setup();
    const w = input(host, "Horizontal resizing")!;
    act(() => w.focus());
    key(w, "ArrowDown", { altKey: true });
    const menu = document.querySelector('[role="menu"]');
    expect(menu).toBeTruthy();
    expect(menu?.textContent).toContain("Fixed width");
    expect(menu?.textContent).toContain("Hug contents");
  });
});
