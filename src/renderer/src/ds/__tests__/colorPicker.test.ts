// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { ColorPicker, type ColorPickerProps } from "../components/ColorPicker";
import type { PickerPaint } from "../util/paint";
import type { ChangeInfo } from "../types";
import { $, $$, box, click, focus, key, mount, pointer, spy, type, type Mounted } from "./dom";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

type Paint = PickerPaint & { visible?: boolean };
const red: Paint = { type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true };

const setup = (value: Paint = red, props: Partial<ColorPickerProps<Paint>> = {}) => {
  const onChange = spy<[Paint, ChangeInfo]>();
  m = mount(ColorPicker<Paint>, { value, onChange, onClose: () => {}, anchor: null, static: true, ...props } as ColorPickerProps<Paint>);
  return { onChange };
};
const finals = (calls: [Paint, ChangeInfo][]) => calls.filter(([, i]) => i.final);
const byte = (n: number) => Math.round(n * 255);

describe("ColorPicker", () => {
  it("drags the saturation/brightness square as one undo step: previews, then exactly one final change", () => {
    const { onChange } = setup();
    const sv = $('[aria-label="Color picker reticle"]');
    box(sv, { left: 0, top: 0, width: 100, height: 100 });
    pointer(sv, "pointerdown", { clientX: 50, clientY: 50 });
    pointer(sv, "pointermove", { clientX: 60, clientY: 40 });
    pointer(sv, "pointermove", { clientX: 100, clientY: 0 });
    pointer(sv, "pointerup", { clientX: 100, clientY: 0 });
    expect(onChange.calls.filter(([, i]) => !i.final).length).toBe(3);
    const done = finals(onChange.calls);
    expect(done).toHaveLength(1);
    const [paint, info] = done[0];
    expect(info).toEqual({ final: true, source: "drag" });
    // s = 1, v = 1 on hue 0: pure red again; other fields pass through
    expect([byte(paint.color!.r), byte(paint.color!.g), byte(paint.color!.b)]).toEqual([255, 0, 0]);
    expect(paint.visible).toBe(true);
    // the middle preview: s .6, v .6 → (153, 61, 61)
    const mid = onChange.calls[1][0].color!;
    expect([byte(mid.r), byte(mid.g), byte(mid.b)]).toEqual([153, 61, 61]);
  });

  it("puts the colour back on Esc during a drag (onCancel), with no final change", () => {
    const onCancel = spy<[]>();
    const { onChange } = setup(red, { onCancel });
    const hue = $('[aria-label="Hue"]');
    box(hue, { left: 0, top: 0, width: 384, height: 24 }); // 360 + the 12px insets
    pointer(hue, "pointerdown", { clientX: 120, clientY: 6 });
    pointer(hue, "pointermove", { clientX: 240, clientY: 6 });
    key(window.document.body, "Escape");
    expect(onCancel.calls).toHaveLength(1);
    expect(finals(onChange.calls)).toHaveLength(0);
  });

  it("drags opacity into the paint's opacity (SOLID keeps its colour opaque)", () => {
    const { onChange } = setup();
    const alpha = $('[aria-label="Opacity"][role="slider"]');
    box(alpha, { left: 0, top: 0, width: 124, height: 24 }); // the thumb's centre travels 12…112 (live: 180 wide, 12 in)
    pointer(alpha, "pointerdown", { clientX: 37, clientY: 12 });
    pointer(alpha, "pointerup", { clientX: 37, clientY: 12 });
    const [paint] = finals(onChange.calls)[0];
    expect(paint.opacity).toBeCloseTo(0.25);
    expect(paint.color!.a).toBe(1);
  });

  it("steps the square with the arrows (each a final change)", () => {
    const { onChange } = setup({ type: "SOLID", color: { r: 0.5, g: 0.25, b: 0.25, a: 1 }, opacity: 1 });
    const sv = $('[aria-label="Color picker reticle"]');
    focus(sv);
    key(sv, "ArrowUp", { shiftKey: true });
    expect(onChange.calls).toHaveLength(1);
    expect(onChange.calls[0][1]).toEqual({ final: true, source: "step" });
    expect(byte(onChange.calls[0][0].color!.r)).toBe(153); // v .5 → .6
  });

  it("takes a typed hex", () => {
    const { onChange } = setup();
    const hex = $('input[aria-label="Color"]') as HTMLInputElement;
    expect(hex.value).toBe("FF0000");
    focus(hex);
    type(hex, "0c8ce9");
    key(hex, "Enter");
    const [paint, info] = onChange.calls[0];
    expect(info.final).toBe(true);
    expect([byte(paint.color!.r), byte(paint.color!.g), byte(paint.color!.b)]).toEqual([12, 140, 233]);
  });

  it("switches the paint type: Solid → Gradient (Linear) gives Figma's default stops (the colour to transparent)", () => {
    const { onChange } = setup();
    // Figma's live picker: Solid, Gradient, Pattern, Image, Video — the gradient's type in its own dropdown.
    expect($$('[role="radiogroup"][aria-label="Fill type"] [role="radio"]').map((r) => r.getAttribute("aria-label"))).toEqual(["Solid", "Gradient", "Pattern", "Image", "Video"]);
    click($('[role="radio"][aria-label="Gradient"]'));
    const [paint, info] = onChange.calls[0];
    expect(info).toEqual({ final: true, source: "pick" });
    expect(paint.type).toBe("GRADIENT_LINEAR");
    expect(paint.stops).toEqual([
      { color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 },
      { color: { r: 1, g: 0, b: 0, a: 0 }, position: 1 },
    ]);
  });

  it("adds a stop by pressing the bar and drags it in the same gesture (one final change)", () => {
    const gradient: Paint = { type: "GRADIENT_LINEAR", opacity: 1, stops: [{ color: { r: 0, g: 0, b: 0, a: 1 }, position: 0 }, { color: { r: 1, g: 1, b: 1, a: 1 }, position: 1 }] };
    const { onChange } = setup(gradient);
    const bar = $('[data-ds="GradientBar"]');
    box(bar, { left: 0, top: 0, width: 200, height: 24 }); // live: the bar's ends are 0 % and 100 %
    pointer(bar, "pointerdown", { clientX: 100, clientY: 12 });
    pointer(bar, "pointermove", { clientX: 150, clientY: 12 });
    pointer(bar, "pointerup", { clientX: 150, clientY: 12 });
    const done = finals(onChange.calls);
    expect(done).toHaveLength(1);
    const stops = done[0][0].stops!;
    expect(stops).toHaveLength(3);
    expect(stops[2].position).toBeCloseTo(0.75);
    // its colour: the gradient's at 50% (where it was added)
    expect(byte(stops[2].color.r)).toBe(128);
  });

  it("removes a stop dragged off the bar, never below two", () => {
    const three: Paint = { type: "GRADIENT_LINEAR", opacity: 1, stops: [0, 0.5, 1].map((p) => ({ color: { r: p, g: p, b: p, a: 1 }, position: p })) };
    const { onChange } = setup(three);
    const bar = $('[data-ds="GradientBar"]');
    box(bar, { left: 0, top: 0, width: 200, height: 24 });
    const handle = $$('[data-ds="GradientBar"] [role="slider"]')[1];
    pointer(handle, "pointerdown", { clientX: 100, clientY: 12 });
    pointer(handle, "pointermove", { clientX: 100, clientY: 80 });
    pointer(handle, "pointerup", { clientX: 100, clientY: 80 });
    expect(finals(onChange.calls)[0][0].stops).toHaveLength(2);
  });

  it("lists the document's colours under On this page", () => {
    const { onChange } = setup(red, { documentColors: ["#0c8ce9", "rgba(0, 0, 0, 0.5)"] });
    // Live: "Solid color hex: …" squares
    const swatches = $$('[aria-label="Solid color hex: 0C8CE9"], [aria-label="Solid color hex: 000000"]');
    expect(swatches).toHaveLength(2);
    click(swatches[1]);
    const [paint] = onChange.calls[0];
    expect(paint.opacity).toBeCloseTo(0.5);
  });

  it("Pattern: Tile type, Scale, Spacing and the anchor write Figma's PATTERN fields; Select source… asks the editor", () => {
    const pattern: Paint = { type: "PATTERN", opacity: 1, scale: 1, patternSpacing: { x: 0, y: 0 }, patternTileType: "RECTANGULAR", horizontalAlignment: "START", verticalAlignment: "START" };
    const onSelectSource = spy<[]>();
    const { onChange } = setup(pattern, { pattern: { source: null, onSelectSource } });
    click($('[role="radio"][aria-label="Hexagonal"]'));
    expect(onChange.calls[0][0].patternTileType).toBe("HORIZONTAL_HEXAGONAL");
    click($('[role="radio"][aria-label="Align bottom right"]'));
    expect([onChange.calls[1][0].horizontalAlignment, onChange.calls[1][0].verticalAlignment]).toEqual(["END", "END"]);
    const scale = $('input[aria-label="Scale"]') as HTMLInputElement;
    expect(scale.value).toBe("100%");
    focus(scale);
    type(scale, "50");
    key(scale, "Enter");
    expect(onChange.calls[2][0].scale).toBeCloseTo(0.5);
    click([...$$("button")].find((b) => b.textContent === "Select source…")!);
    expect(onSelectSource.calls).toHaveLength(1);
  });

  it("Solid → Pattern: Figma's defaults (100 %, no spacing, rectangular, top left)", () => {
    const { onChange } = setup();
    click($('[role="radio"][aria-label="Pattern"]'));
    const [paint] = onChange.calls[0];
    expect(paint).toMatchObject({ type: "PATTERN", scale: 1, patternSpacing: { x: 0, y: 0 }, patternTileType: "RECTANGULAR", horizontalAlignment: "START", verticalAlignment: "START" });
  });

  it("the Shader tab opens Figma's shader fill browser (beside the picker) and paints nothing", () => {
    const onShaders = spy<[HTMLElement]>();
    const { onChange } = setup(red, { onShaders });
    click($('button[aria-label="Shader"]'));
    expect(onShaders.calls).toHaveLength(1);
    expect(onChange.calls).toHaveLength(0);
  });

  it("shows the RGB model's channels", () => {
    m = mount(ColorPicker<Paint>, { value: red, onChange: () => {}, onClose: () => {}, anchor: null, static: true, colorModel: "rgb" } as ColorPickerProps<Paint>);
    expect(($('input[aria-label="Red"]') as HTMLInputElement).value).toBe("255");
    expect(($('input[aria-label="Green"]') as HTMLInputElement).value).toBe("0");
  });
});
