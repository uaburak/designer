// @vitest-environment happy-dom
// Round 7d — the DS Slider (docs/design-system.md §4.38) and LayerRow's thumbnail slot (§4.17, docs/draw.md §5.9).
import { afterEach, describe, expect, it } from "vitest";
import { MIXED, type ChangeInfo } from "../types";
import { Slider, sliderFraction, sliderValue } from "../components/Slider";
import { LayerRow, layerRowExtent } from "../components/LayerRow";
import { $, box, key, mount, pointer, type Mounted } from "./dom";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

describe("Slider: values", () => {
  it("clamps and snaps to the step from min, without float dust", () => {
    expect(sliderValue(150, 0, 100)).toBe(100);
    expect(sliderValue(-3, 0, 100)).toBe(0);
    expect(sliderValue(0.30000000000000004, 0, 1, 0.1)).toBe(0.3);
    expect(sliderValue(7.26, 0.5, 100, 0.5)).toBe(7.5);
    expect(sliderValue(0.333, 0.01, 20, 0.01)).toBe(0.33);
  });
  it("the thumb's place on the track", () => {
    expect(sliderFraction(25, 0, 100)).toBe(0.25);
    expect(sliderFraction(-180, -180, 180)).toBe(0);
    expect(sliderFraction(5, 5, 5)).toBe(0);
  });
});

describe("Slider: gestures", () => {
  const setup = (props: Partial<Parameters<typeof Slider>[0]> = {}) => {
    const calls: [number, ChangeInfo][] = [];
    let cancelled = 0;
    m = mount(Slider, { label: "Opacity", value: 40, min: 0, max: 100, onChange: (v: number, info: ChangeInfo) => calls.push([v, info]), onCancel: () => cancelled++, ...props });
    const el = $('[data-ds="Slider"]', m.host);
    box(el, { left: 0, top: 0, width: 200, height: 24 });
    return { el, calls, cancelled: () => cancelled };
  };

  it("a press jumps there and drags: live values, then one final value on release (one undo step)", () => {
    const { el, calls } = setup();
    pointer(el, "pointerdown", { clientX: 50 });
    pointer(el, "pointermove", { clientX: 100 });
    pointer(el, "pointermove", { clientX: 100 });
    pointer(el, "pointerup", { clientX: 100 });
    expect(calls).toEqual([
      [25, { final: false, source: "drag" }],
      [50, { final: false, source: "drag" }],
      [50, { final: true, source: "drag" }],
    ]);
  });

  it("a cancelled drag calls onCancel, not a final value", () => {
    const { el, calls, cancelled } = setup();
    pointer(el, "pointerdown", { clientX: 20 });
    key(el, "Escape");
    expect(cancelled()).toBe(1);
    pointer(el, "pointerup", { clientX: 20 });
    expect(calls.filter(([, i]) => i.final)).toEqual([]);
  });

  it("keys step (⇧ ten steps), Home / End go to the ends — each final", () => {
    const { el, calls } = setup();
    key(el, "ArrowRight");
    key(el, "ArrowLeft", { shiftKey: true });
    key(el, "End");
    expect(calls).toEqual([
      [41, { final: true, source: "step" }],
      [30, { final: true, source: "step" }],
      [100, { final: true, source: "step" }],
    ]);
  });

  it("is a slider to assistive tech; Mixed has no thumb; disabled ignores presses", () => {
    const { el } = setup({ value: MIXED });
    expect(el.getAttribute("role")).toBe("slider");
    expect(el.getAttribute("aria-valuetext")).toBe("Mixed");
    expect(el.querySelectorAll("span").length).toBe(2); // the track and its fill, no thumb
    m!.unmount();
    const calls: number[] = [];
    m = mount(Slider, { label: "Weight", value: 4, min: 0, max: 10, disabled: true, onChange: (v: number) => calls.push(v) });
    const d = $('[data-ds="Slider"]', m.host);
    box(d, { left: 0, top: 0, width: 100, height: 24 });
    pointer(d, "pointerdown", { clientX: 90 });
    key(d, "ArrowRight");
    expect(calls).toEqual([]);
    expect(d.getAttribute("aria-valuenow")).toBe("4");
  });
});

describe("LayerRow: Draw's thumbnail slot", () => {
  it("a thumbnail makes a 48 row with the 32 slot in the glyph's place (the glyph until it is drawn)", () => {
    m = mount(LayerRow, { id: "1:2", depth: 0, name: "Petal", icon: "16.vector", iconLabel: "Vector", thumbnail: null });
    const row = $('[data-ds="LayerRow"]', m.host);
    expect(row.dataset.size).toBe("large");
    const slot = $("[data-layer-thumb]", row);
    expect(slot.getAttribute("aria-label")).toBe("Vector");
    expect(slot.querySelector("svg")).not.toBeNull();
    expect(row.querySelector("[data-layer-icon]")).toBeNull();
  });
  it("without one the row is Design's", () => {
    m = mount(LayerRow, { id: "1:2", depth: 0, name: "Petal", icon: "16.vector" });
    expect($('[data-ds="LayerRow"]', m.host).dataset.size).toBeUndefined();
    expect($("[data-layer-icon]", m.host)).not.toBeNull();
  });
  it("the sideways extent counts the wider preview", () => {
    expect(layerRowExtent(0, 100, true) - layerRowExtent(0, 100)).toBe(16);
  });
});
