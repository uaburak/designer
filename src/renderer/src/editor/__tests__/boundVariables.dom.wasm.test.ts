// @vitest-environment happy-dom
// The Design panel shows every variable bound to a layer where Figma shows it: visibility bound to a boolean variable
// (IS_TRUTHY in the file) as its own row in Appearance — the toggle glyph and the variable's pill; a click opens the
// boolean variables with True / False, Detach on hover keeps the layer as it shows —, "Mixed" across layers bound
// differently, "Apply variable" in Appearance's header while unbound; an effect's numbers and colour bound in its
// settings popover; a text's paragraph spacing / indent in Type settings.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { $, $$, click, mount, type Mounted } from "../../ds/__tests__/dom";
import { EditorContext, EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { VARIABLES_DOCUMENT } from "../fixtures";
import { useNodes } from "../hooks";
import { variableBindings } from "../model/variables";
import { bindEffect, bindVariable } from "../variables";
import { AppearanceSection } from "../panels/design/Sections";
import { EffectsSection } from "../panels/design/Effects";
import { TypeSettings } from "../panels/design/TypeSettings";
import type { PanelNode } from "../panels/design/shared";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
const CARD = "2:1";
const DARK_CARD = "2:10";
const TITLE = "2:2";
const BETA = "5:25"; // feature/beta: BOOLEAN, Light true / Dark false
const SPACING_SM = "5:11"; // spacing/sm: 8
const TEXT_PRIMARY = "5:22"; // text/primary: COLOR

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

async function editor() {
  const source = memoryDocumentSource(VARIABLES_DOCUMENT, { fileName: "Variables" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  return new EditorController(engine, new EngineStore(engine), source);
}

function show(ed: EditorController, refs: string[], section: (p: { nodes: PanelNode[] }) => ReturnType<typeof createElement> | null) {
  function Harness() {
    const nodes = useNodes(refs) as PanelNode[];
    return nodes.length ? section({ nodes }) : null;
  }
  m = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(Harness)), {});
  return m.host;
}

const appearance = (p: { nodes: PanelNode[] }) => createElement(AppearanceSection, p);
const visible = (ed: EditorController, id: string) => (ed.engine.readNode(id) as { visible?: boolean }).visible !== false;
const picker = () => $("[data-variable-picker]");

describe("visibility bound to a boolean variable", () => {
  it("is read from the file's IS_TRUTHY(alias)", async () => {
    const ed = await editor();
    bindVariable(ed, [CARD], ["VISIBLE"], BETA);
    const entry = ((ed.engine.readNode(CARD) as { parameterConsumptionMap?: { entries?: { variableField: string; variableData: { dataType?: string } }[] } }).parameterConsumptionMap?.entries ?? []).find((e) => e.variableField === "VISIBLE");
    expect(entry?.variableData.dataType).toBe("EXPRESSION");
    expect(variableBindings(ed.engine.readNode(CARD) as never).get("VISIBLE")).toBe(BETA);
  });

  it("shows its row in Appearance: the boolean glyph and the variable's pill; Opacity stays a field", async () => {
    const ed = await editor();
    let host = show(ed, [CARD], appearance);
    expect($("[data-visibility-variable]", host)).toBeNull();
    m!.unmount();
    bindVariable(ed, [CARD], ["VISIBLE"], BETA);
    host = show(ed, [CARD], appearance);
    const row = $("[data-visibility-variable]", host);
    expect(row).toBeTruthy();
    const pill = $('[data-bind-field="VISIBLE"] [data-bound-variable="feature/beta"]', row);
    expect(pill).toBeTruthy();
    expect(pill.textContent).toContain("beta");
    expect(pill.querySelector("svg")).toBeTruthy(); // the glyph
    expect($('[aria-label="Detach variable"]', pill)).toBeTruthy();
    // Opacity is not bound: its field, no pill; the corner radius is (radius/card): its pill
    expect($('[data-bind-field="OPACITY"] [data-bound-variable]', host)).toBeNull();
    expect($('[data-bind-field^="RECTANGLE_"] [data-bound-variable="radius/card"]', host)).toBeTruthy();
    // No "Apply variable" for visibility while it is bound
    expect($('[data-apply-variable="VISIBLE"]', host)).toBeNull();
  });

  it("a click opens the boolean variables with True / False; False detaches and hides", async () => {
    const ed = await editor();
    bindVariable(ed, [CARD], ["VISIBLE"], BETA);
    const host = show(ed, [CARD], appearance);
    click($('[data-visibility-variable] button[aria-label^="Visibility"]', host));
    const list = picker();
    expect(list).toBeTruthy();
    const names = $$("[data-variable]", list).map((b) => b.dataset.variable);
    expect(names).toEqual(["feature/beta"]); // boolean variables only
    expect($('[data-variable="feature/beta"]', list).getAttribute("aria-checked")).toBe("true");
    expect($$("[data-literal]", list).map((b) => b.textContent)).toEqual(["True", "False"]);
    click($('[data-literal="false"]', list));
    expect(variableBindings(ed.engine.readNode(CARD) as never).has("VISIBLE")).toBe(false);
    expect(visible(ed, CARD)).toBe(false);
    expect($("[data-visibility-variable]", host)).toBeNull();
  });

  it("Detach keeps the layer as it shows (the Dark card: hidden)", async () => {
    const ed = await editor();
    bindVariable(ed, [DARK_CARD], ["VISIBLE"], BETA);
    expect(visible(ed, DARK_CARD)).toBe(false);
    const host = show(ed, [DARK_CARD], appearance);
    click($('[data-visibility-variable] [aria-label="Detach variable"]', host));
    expect(variableBindings(ed.engine.readNode(DARK_CARD) as never).has("VISIBLE")).toBe(false);
    expect(visible(ed, DARK_CARD)).toBe(false);
  });

  it("layers bound differently show Mixed; picking a variable binds them all", async () => {
    const ed = await editor();
    bindVariable(ed, [CARD], ["VISIBLE"], BETA);
    const host = show(ed, [CARD, TITLE], appearance);
    const row = $('[data-visibility-variable="mixed"]', host);
    expect(row?.textContent).toContain("Mixed");
    click($('button[aria-label$="Mixed"]', row));
    click($('[data-variable="feature/beta"]', picker()));
    for (const id of [CARD, TITLE]) expect(variableBindings(ed.engine.readNode(id) as never).get("VISIBLE")).toBe(BETA);
    expect($('[data-visibility-variable=""] [data-bound-variable="feature/beta"]', host)).toBeTruthy();
  });

  it("Apply variable in Appearance's header binds an unbound layer's visibility", async () => {
    const ed = await editor();
    const host = show(ed, [TITLE], appearance);
    click($('[data-apply-variable="VISIBLE"]', host));
    click($('[data-variable="feature/beta"]', picker()));
    expect(variableBindings(ed.engine.readNode(TITLE) as never).get("VISIBLE")).toBe(BETA);
    expect($('[data-visibility-variable] [data-bound-variable="feature/beta"]', host)).toBeTruthy();
  });
});

describe("a radius bound as one field (CORNER_RADIUS, as Figma's files and polygons hold it)", () => {
  it("shows in Corner radius; Detach clears it and keeps the radius", async () => {
    const ed = await editor();
    const b = () => variableBindings(ed.engine.readNode(CARD) as never);
    expect(b().get("CORNER_RADIUS")).toBe("5:23");
    const host = show(ed, [CARD], appearance);
    const pill = $('[data-bind-field^="RECTANGLE_"] [data-bound-variable="radius/card"]', host);
    expect(pill?.textContent).toContain("8");
    click($('[aria-label="Detach variable"]', pill));
    expect(b().has("CORNER_RADIUS")).toBe(false);
    expect([...b().keys()].some((k) => k.endsWith("_CORNER_RADIUS"))).toBe(false);
    expect((ed.engine.readNode(CARD) as { rectangleTopLeftCornerRadius?: number }).rectangleTopLeftCornerRadius).toBe(8);
  });
});

describe("an effect's values bound to variables (its settings popover)", () => {
  it("shows the blur's and the colour's pills; Detach keeps the value", async () => {
    const ed = await editor();
    ed.setProps([CARD], { effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 4, spread: 0, visible: true, blendMode: "NORMAL" }] } as never, "Add effect");
    bindEffect(ed, [CARD], 0, "radius", SPACING_SM);
    bindEffect(ed, [CARD], 0, "color", TEXT_PRIMARY);
    const effect = () => ((ed.engine.readNode(CARD) as { effects?: Record<string, unknown>[] }).effects ?? [])[0];
    expect(effect().radius).toBe(8);
    const host = show(ed, [CARD], (p) => createElement(EffectsSection, p));
    click($('[data-effect-row] button[aria-label="Effect settings"]', host));
    const pop = $('[data-effect-settings="DROP_SHADOW"]');
    expect($('[data-bind-field="effects[0].radius"] [data-bound-variable="spacing/sm"]', pop)?.textContent).toContain("8");
    expect($('[data-bind-field="effects[0].color"] [data-bound-variable="text/primary"]', pop)).toBeTruthy();
    // X, Y and Spread unbound: their fields with Apply variable
    for (const f of ["x", "y", "spread"]) expect($(`[data-bind-field="effects[0].${f}"] [aria-label="Apply variable"]`, pop), f).toBeTruthy();
    click($('[data-bind-field="effects[0].radius"] [aria-label="Detach variable"]', pop));
    expect(effect().radiusVar).toBeFalsy();
    expect(effect().radius).toBe(8);
  });
});

describe("Type settings: paragraph spacing and indent take variables", () => {
  it("a bound paragraph spacing shows its pill", async () => {
    const ed = await editor();
    bindVariable(ed, [TITLE], ["PARAGRAPH_SPACING"], SPACING_SM);
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const host = show(ed, [TITLE], (p) => createElement(TypeSettings, { nodes: p.nodes, summary: null, anchor, onClose: () => {} }));
    void host;
    expect($('[data-bind-field="PARAGRAPH_SPACING"] [data-bound-variable="spacing/sm"]')).toBeTruthy();
    anchor.remove();
  });
});
