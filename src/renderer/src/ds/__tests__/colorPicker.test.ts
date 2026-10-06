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
    const sv = $('[aria-label="Saturation and brightness"]');
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
    box(hue, { left: 0, top: 0, width: 372, height: 12 }); // 360 + the 6px insets
    pointer(hue, "pointerdown", { clientX: 120, clientY: 6 });
    pointer(hue, "pointermove", { clientX: 240, clientY: 6 });
    key(window.document.body, "Escape");
    expect(onCancel.calls).toHaveLength(1);
    expect(finals(onChange.calls)).toHaveLength(0);
  });

  it("drags opacity into the paint's opacity (SOLID keeps its colour opaque)", () => {
    const { onChange } = setup();
    const alpha = $('[aria-label="Opacity"][role="slider"]');
    box(alpha, { left: 0, top: 0, width: 112, height: 12 }); // the thumb's centre travels 6…106
    pointer(alpha, "pointerdown", { clientX: 31, clientY: 6 });
    pointer(alpha, "pointerup", { clientX: 31, clientY: 6 });
    const [paint] = finals(onChange.calls)[0];
    expect(paint.opacity).toBeCloseTo(0.25);
    expect(paint.color!.a).toBe(1);
  });

  it("steps the square with the arrows (each a final change)", () => {
    const { onChange } = setup({ type: "SOLID", color: { r: 0.5, g: 0.25, b: 0.25, a: 1 }, opacity: 1 });
    const sv = $('[aria-label="Saturation and brightness"]');
    focus(sv);
    key(sv, "ArrowUp", { shiftKey: true });
    expect(onChange.calls).toHaveLength(1);
    expect(onChange.calls[0][1]).toEqual({ final: true, source: "step" });
    expect(byte(onChange.calls[0][0].color!.r)).toBe(153); // v .5 → .6
  });

  it("takes a typed hex", () => {
    const { onChange } = setup();
    const hex = $('input[aria-label="Hex"]') as HTMLInputElement;
    expect(hex.value).toBe("FF0000");
    focus(hex);
    type(hex, "0c8ce9");
    key(hex, "Enter");
    const [paint, info] = onChange.calls[0];
    expect(info.final).toBe(true);
    expect([byte(paint.color!.r), byte(paint.color!.g), byte(paint.color!.b)]).toEqual([12, 140, 233]);
  });

  it("switches the paint type: Solid → Linear gives Figma's default stops (the colour to transparent)", () => {
    const { onChange } = setup();
    click($('[role="radio"][aria-label="Linear"]'));
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
    box(bar, { left: 0, top: 0, width: 212, height: 24 }); // stops travel 6…206
    pointer(bar, "pointerdown", { clientX: 106, clientY: 12 });
    pointer(bar, "pointermove", { clientX: 156, clientY: 12 });
    pointer(bar, "pointerup", { clientX: 156, clientY: 12 });
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
    const swatches = $$('[aria-label="#0c8ce9"], [aria-label="rgba(0, 0, 0, 0.5)"]');
    expect(swatches).toHaveLength(2);
    click(swatches[1]);
    const [paint] = onChange.calls[0];
    expect(paint.opacity).toBeCloseTo(0.5);
  });

  it("shows the RGB model's channels", () => {
    m = mount(ColorPicker<Paint>, { value: red, onChange: () => {}, onClose: () => {}, anchor: null, static: true, colorModel: "rgb" } as ColorPickerProps<Paint>);
    expect(($('input[aria-label="Red"]') as HTMLInputElement).value).toBe("255");
    expect(($('input[aria-label="Green"]') as HTMLInputElement).value).toBe("0");
  });
});
