// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { NumericInput, type NumericInputProps } from "../components/NumericInput";
import { MIXED, type ChangeInfo } from "../types";
import { $, focus, key, mount, pointer, spy, type, type Mounted } from "./dom";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

const setup = (props: Partial<NumericInputProps> = {}) => {
  const onChange = spy<[number, ChangeInfo]>();
  m = mount(NumericInput, { label: "Width", prefix: "W", value: 10, onChange, ...props } as NumericInputProps);
  return { onChange, input: $("input", m.host) as HTMLInputElement, prefix: $('[data-ds="NumericInput"] > span', m.host) };
};

describe("NumericInput", () => {
  it("steps with ↑ ↓ (⇧: 10), each a final change", () => {
    const { onChange, input } = setup();
    focus(input);
    key(input, "ArrowUp");
    key(input, "ArrowDown", { shiftKey: true });
    expect(onChange.calls).toEqual([
      [11, { final: true, source: "step" }],
      [0, { final: true, source: "step" }],
    ]);
  });

  it("takes arithmetic on Enter, ignoring a typed unit; invalid text reverts", () => {
    const { onChange, input } = setup({ unit: "%" });
    focus(input);
    type(input, "100+20%");
    key(input, "Enter");
    expect(onChange.calls).toEqual([[120, { final: true, source: "type" }]]);
    type(input, "abc");
    key(input, "Enter");
    expect(onChange.calls).toHaveLength(1);
  });

  it("drops what was typed on Esc", () => {
    const { onChange, input } = setup();
    focus(input);
    type(input, "55");
    key(input, "Escape");
    expect(onChange.calls).toHaveLength(0);
    expect(input.value).toBe("10");
  });

  it("scrubs the prefix: 1 per px (⇧ ×10), previews, then one final change", () => {
    const { onChange, prefix } = setup();
    pointer(prefix, "pointerdown", { clientX: 100 });
    pointer(prefix, "pointermove", { clientX: 101 }); // under the 2px threshold: nothing yet
    pointer(prefix, "pointermove", { clientX: 130 });
    pointer(prefix, "pointermove", { clientX: 105, shiftKey: true });
    expect(document.documentElement.getAttribute("data-cursor")).toBe("ew-resize");
    pointer(prefix, "pointerup", { clientX: 105 });
    expect(onChange.calls).toEqual([
      [40, { final: false, source: "scrub" }],
      [60, { final: false, source: "scrub" }],
      [60, { final: true, source: "scrub" }],
    ]);
    expect(document.documentElement.hasAttribute("data-cursor")).toBe(false);
  });

  it("cancels a scrub on Esc", () => {
    const onCancel = spy<[]>();
    const { onChange, prefix } = setup({ onCancel });
    pointer(prefix, "pointerdown", { clientX: 100 });
    pointer(prefix, "pointermove", { clientX: 120 });
    key(document.body, "Escape");
    expect(onCancel.calls).toHaveLength(1);
    expect(onChange.calls.filter(([, i]) => i.final)).toHaveLength(0);
  });

  it("a press without movement focuses the field", () => {
    const { onChange, prefix, input } = setup();
    pointer(prefix, "pointerdown", { clientX: 100 });
    pointer(prefix, "pointerup", { clientX: 100 });
    expect(onChange.calls).toHaveLength(0);
    expect(document.activeElement).toBe(input);
  });

  it("shows Mixed and hands the arrows' delta to onStep", () => {
    const onStep = spy<[number]>();
    const { onChange, input } = setup({ value: MIXED, onStep });
    expect(input.placeholder).toBe("Mixed");
    focus(input);
    key(input, "ArrowUp", { shiftKey: true });
    expect(onStep.calls).toEqual([[10]]);
    expect(onChange.calls).toHaveLength(0);
  });
});
