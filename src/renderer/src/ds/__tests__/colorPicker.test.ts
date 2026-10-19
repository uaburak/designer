// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { ColorPicker, wheelAlpha, wheelHue, type ColorPickerProps } from "../components/ColorPicker";
import { convertPaint, type PickerPaint } from "../util/paint";
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

  it("Solid D9D9D9 (Figma's default fill) → Gradient: D9D9D9 100 % then 737373 100 % (live popovers/fill-picker-gradient_linear.txt)", () => {
    const gray: Paint = { type: "SOLID", color: { r: 0xd9 / 255, g: 0xd9 / 255, b: 0xd9 / 255, a: 1 }, opacity: 1 };
    const stops = (p: Paint) => (p.stops ?? []).map((s) => [byte(s.color.r), byte(s.color.g), byte(s.color.b), s.color.a, s.position]);
    expect(stops(convertPaint(gray, "GRADIENT_LINEAR"))).toEqual([[217, 217, 217, 1, 0], [115, 115, 115, 1, 1]]);
    // an image / video / shader paint (no colour of its own) stands in with the default fill, as live's Image → Video → Shader → Gradient
    expect(stops(convertPaint({ type: "IMAGE", opacity: 1 } as Paint, "GRADIENT_LINEAR"))).toEqual([[217, 217, 217, 1, 0], [115, 115, 115, 1, 1]]);
  });

  it("the Image tab's Make an image (AI) reads as enabled with a glyph, and only says why it does nothing", () => {
    setup({ type: "IMAGE", opacity: 1 } as Paint);
    const b = Array.from(document.querySelectorAll("button")).find((x) => x.textContent === "Make an image")!;
    expect(b.disabled).toBe(false);
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(b.querySelector("svg")).not.toBeNull();
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
    // the stops in order of position (Figma re-sorts after every change)
    const stops = done[0][0].stops!;
    expect(stops.map((s) => s.position)).toEqual([0, 0.75, 1]);
    // its colour: the gradient's at 50% (where it was added)
    expect(byte(stops[1].color.r)).toBe(128);
  });

  // Figma's GradientControl (atlas 07 §7.2)
  const three: Paint = { type: "GRADIENT_LINEAR", opacity: 1, stops: [0, 0.5, 1].map((p) => ({ color: { r: p, g: p, b: p, a: 1 }, position: p })) };
  const stopAt = (i: number) => $$('[data-ds="GradientBar"] [role="slider"]')[i];
  const dragStopTo = (i: number, clientX: number, init: { shiftKey?: boolean; altKey?: boolean } = {}) => {
    box($('[data-ds="GradientBar"]'), { left: 0, top: 0, width: 200, height: 24 });
    const handle = stopAt(i);
    pointer(handle, "pointerdown", { clientX: 100, clientY: 12, ...init });
    pointer(handle, "pointermove", { clientX, clientY: 12, ...init });
    pointer(handle, "pointerup", { clientX, clientY: 12, ...init });
  };

  it("moves a stop only past 5 px, in 5 % steps with ⇧; dragging it off the bar removes nothing", () => {
    let { onChange } = setup(three);
    dragStopTo(1, 104);
    expect(finals(onChange.calls)[0][0].stops!.map((s) => s.position)).toEqual([0, 0.5, 1]);
    m!.unmount();
    ({ onChange } = setup(three));
    dragStopTo(1, 147, { shiftKey: true }); // 0.735 → 0.75
    expect(finals(onChange.calls)[0][0].stops!.map((s) => s.position)).toEqual([0, 0.75, 1]);
    m!.unmount();
    ({ onChange } = setup(three));
    box($('[data-ds="GradientBar"]'), { left: 0, top: 0, width: 200, height: 24 });
    pointer(stopAt(1), "pointerdown", { clientX: 100, clientY: 12 });
    pointer(stopAt(1), "pointermove", { clientX: 100, clientY: 80 });
    pointer(stopAt(1), "pointerup", { clientX: 100, clientY: 80 });
    expect(finals(onChange.calls)[0][0].stops).toHaveLength(3);
  });

  it("pulls a stop dropped within 2 % onto its neighbour (just inside it), unless ⌥", () => {
    let { onChange } = setup(three);
    dragStopTo(1, 197); // 0.985: within 2 % of 1
    expect(finals(onChange.calls)[0][0].stops!.map((s) => s.position)).toEqual([0, 0.9999, 1]);
    m!.unmount();
    ({ onChange } = setup({ ...three, stops: [three.stops![0], { ...three.stops![1], position: 0.3 }, three.stops![2]] }));
    box($('[data-ds="GradientBar"]'), { left: 0, top: 0, width: 200, height: 24 });
    // a ⌥-press copies the stop at the pointer; dropped with ⌥ held it stays where it is
    pointer(stopAt(1), "pointerdown", { clientX: 100, clientY: 12, altKey: true });
    pointer(stopAt(1), "pointerup", { clientX: 197, clientY: 12, altKey: true });
    const stops = finals(onChange.calls)[0][0].stops!;
    expect(stops.map((s) => s.position)).toEqual([0, 0.3, 0.5, 1]);
    expect(byte(stops[2].color.r)).toBe(128);
  });

  it("double-click redistributes the stops; the arrows move one 1 % (⇧ 5 %); Delete goes down to one stop", () => {
    const { onChange } = setup({ ...three, stops: [three.stops![0], { ...three.stops![1], position: 0.2 }, three.stops![2]] });
    act(() => void stopAt(1).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(onChange.calls.at(-1)![0].stops!.map((s) => s.position)).toEqual([0, 0.5, 1]);
    key(stopAt(1), "ArrowRight");
    expect(onChange.calls.at(-1)![0].stops![1].position).toBeCloseTo(0.21);
    key(stopAt(1), "ArrowLeft", { shiftKey: true });
    expect(onChange.calls.at(-1)![0].stops![1].position).toBeCloseTo(0.15);
    m!.unmount();
    const two = setup({ ...three, stops: three.stops!.slice(0, 2) });
    key(stopAt(0), "Delete");
    expect(two.onChange.calls.at(-1)![0].stops).toHaveLength(1);
  });

  it("adds a stop with + halfway to the next one, or at the far end of a lone stop", () => {
    let { onChange } = setup(three);
    click($('[aria-label="Add gradient stop"]'));
    expect(onChange.calls.at(-1)![0].stops!.map((s) => s.position)).toEqual([0, 0.25, 0.5, 1]);
    m!.unmount();
    ({ onChange } = setup({ ...three, stops: [{ color: { r: 1, g: 0, b: 0, a: 1 }, position: 0.2 }] }));
    // a lone stop: no "Delete gradient stop", and + puts the copy at 1
    expect($('[aria-label="Delete gradient stop"]')).toBeNull();
    click($('[aria-label="Add gradient stop"]'));
    expect(onChange.calls.at(-1)![0].stops!.map((s) => s.position)).toEqual([0.2, 1]);
  });

  it("Color interpolation: OKLCH writes the space and Increasing; Flip makes it Decreasing", () => {
    const { onChange } = setup(three);
    expect($('[aria-label="Interpolation hue method"]')).toBeNull();
    m!.rerender(ColorPicker<Paint>, { value: { ...three, interpolationColorSpace: "OKLCH", interpolationHueMethod: "INCREASING" }, onChange, onClose: () => {}, anchor: null, static: true } as ColorPickerProps<Paint>);
    expect($('[aria-label="Interpolation hue method"]')).not.toBeNull();
    click($('[aria-label="Flip gradient"]'));
    const [flipped] = onChange.calls.at(-1)!;
    expect(flipped.interpolationHueMethod).toBe("DECREASING");
    expect(flipped.stops!.map((s) => s.position)).toEqual([1, 0.5, 0]);
  });

  it("the wheel over the square turns the hue, ⌥-wheel the opacity (snapped to 10 %), as one undo step", () => {
    vi.useFakeTimers();
    try {
      const { onChange } = setup({ ...red, opacity: 0.5 });
      const sv = $('[aria-label="Color picker reticle"]');
      const wheel = (init: WheelEventInit) => {
        const ev = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
        // (happy-dom's WheelEvent drops the modifier keys)
        Object.defineProperty(ev, "altKey", { value: !!init.altKey });
        act(() => void sv.dispatchEvent(ev));
      };
      wheel({ deltaY: 200 }); // 0.1 of the circle: 36°
      wheel({ deltaY: 200, altKey: true }); // opacity .5 → .6
      expect(finals(onChange.calls)).toHaveLength(0);
      act(() => void vi.advanceTimersByTime(400));
      const done = finals(onChange.calls);
      expect(done).toHaveLength(1);
      const [paint] = done[0];
      expect([byte(paint.color!.r), byte(paint.color!.g), byte(paint.color!.b)]).toEqual([255, 153, 0]);
      expect(paint.opacity).toBeCloseTo(0.6);
    } finally {
      vi.useRealTimers();
    }
    expect(wheelAlpha(0.498, 0.003)).toBe(0.5);
    expect(wheelAlpha(0.45, 0.001)).toBe(0.451);
    expect(wheelHue(350, 0.1)).toBeCloseTo(26);
  });

  it("steps the hue 1° (⇧ 10°) round the circle, and reads any colour string in the hex field", () => {
    const { onChange } = setup();
    key($('[aria-label="Hue"]'), "ArrowLeft");
    const h = onChange.calls.at(-1)![0].color!;
    expect([byte(h.r), byte(h.g), byte(h.b)]).toEqual([255, 0, 4]); // 359°
    const hex = $('input[aria-label="Color"]') as HTMLInputElement;
    focus(hex);
    type(hex, "rebeccapurple");
    key(hex, "Enter");
    const c = onChange.calls.at(-1)![0];
    expect([byte(c.color!.r), byte(c.color!.g), byte(c.color!.b)]).toEqual([102, 51, 153]);
    expect(c.opacity).toBe(1);
  });

  it("shows a swatch set after On this page (Local assets) when the editor picks it", () => {
    setup(red, { documentColors: ["#0c8ce9"], swatchSets: [{ id: "local", label: "Local assets", colors: ["#00ff00"] }], swatchSet: "local" });
    expect($('[aria-label="Solid color hex: 00FF00"]')).not.toBeNull();
    expect($('[aria-label="Solid color hex: 0C8CE9"]')).toBeNull();
  });

  it("greys out a type the list can't take (one Pattern per list)", () => {
    setup(red, { disabledTypes: ["PATTERN"] });
    expect(($('[role="radio"][aria-label="Pattern"]') as HTMLButtonElement).disabled).toBe(true);
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
