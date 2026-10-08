// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { NumericInput, type NumericInputProps } from "../components/NumericInput";
import { MIXED, type ChangeInfo } from "../types";
import { ReturnFocusProvider } from "../util/returnFocus";
import { createElement } from "react";
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
    focus(input);
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
    expect(input.value).toBe("Mixed");
    focus(input);
    key(input, "ArrowUp", { shiftKey: true });
    expect(onStep.calls).toEqual([[10]]);
    expect(onChange.calls).toHaveLength(0);
  });

  it("applies Mixed+100 to every layer's own value (onExpression), clamped and rounded", () => {
    const onExpression = spy<[(x: number) => number, ChangeInfo]>();
    const { onChange, input } = setup({ value: MIXED, onExpression, max: 500 });
    focus(input);
    type(input, "Mixed+100");
    key(input, "Enter");
    expect(onChange.calls).toHaveLength(0);
    expect(onExpression.calls).toHaveLength(1);
    const [each, info] = onExpression.calls[0];
    expect([each(10), each(450), each(1.234)]).toEqual([110, 500, 101.23]);
    expect(info).toEqual({ final: true, source: "type" });
  });

  it("reads Mixed as the value when there is one, and takes ^", () => {
    const { onChange, input } = setup({ value: 10 });
    focus(input);
    type(input, "mixed*2");
    key(input, "Enter");
    focus(input);
    type(input, "2^3");
    key(input, "Enter");
    expect(onChange.calls.map((c) => c[0])).toEqual([20, 8]);
  });

  it("takes its keywords in any case (a gap's Auto)", () => {
    const onKeyword = spy<[string]>();
    const { onChange, input } = setup({ keywords: ["Auto"], onKeyword });
    focus(input);
    type(input, "auto");
    key(input, "Enter");
    expect(onKeyword.calls).toEqual([["Auto"]]);
    expect(onChange.calls).toHaveLength(0);
  });

  it("Enter commits and leaves; the first Esc reverts and stays, the second leaves (live Figma)", () => {
    const exits: string[] = [];
    const { onChange, input } = setup({ onExit: (r) => exits.push(r) });
    focus(input);
    type(input, "42");
    key(input, "Enter");
    expect(onChange.calls).toEqual([[42, { final: true, source: "type" }]]);
    expect(document.activeElement).not.toBe(input);
    expect(exits).toEqual(["enter"]);
    focus(input);
    type(input, "777");
    key(input, "Escape");
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("10");
    expect(exits).toEqual(["enter"]);
    key(input, "Escape");
    expect(document.activeElement).not.toBe(input);
    expect(exits).toEqual(["enter", "escape"]);
    expect(onChange.calls).toHaveLength(1);
  });

  it("a label before the field scrubs it (scrubHandle: previous), a press without movement focuses it", () => {
    const onChange = spy<[number, ChangeInfo]>();
    const Row = (p: NumericInputProps) => createElement("div", null, createElement("span", { id: "blur-label" }, "Blur"), createElement(NumericInput, p));
    m = mount(Row, { label: "Blur", value: 4, onChange, scrubHandle: "previous" } as NumericInputProps);
    const label = $("#blur-label", m.host);
    const input = $("input", m.host) as HTMLInputElement;
    expect(label.hasAttribute("data-ds-scrub-handle")).toBe(true);
    pointer(label, "pointerdown", { clientX: 100 });
    pointer(label, "pointermove", { clientX: 110 });
    pointer(label, "pointerup", { clientX: 110 });
    expect(onChange.calls).toEqual([
      [14, { final: false, source: "scrub" }],
      [14, { final: true, source: "scrub" }],
    ]);
    pointer(label, "pointerdown", { clientX: 100 });
    pointer(label, "pointerup", { clientX: 100 });
    expect(document.activeElement).toBe(input);
  });

  it("gives focus back through ReturnFocusProvider after Enter", () => {
    let returned = 0;
    const onChange = spy<[number, ChangeInfo]>();
    const Wrapped = (p: NumericInputProps) => createElement(ReturnFocusProvider, { value: () => returned++ }, createElement(NumericInput, p));
    m = mount(Wrapped, { label: "X", prefix: "X", value: 5, onChange } as NumericInputProps);
    const input = $("input", m.host) as HTMLInputElement;
    focus(input);
    type(input, "+10");
    key(input, "Enter");
    expect(onChange.calls).toEqual([[10, { final: true, source: "type" }]]);
    expect(returned).toBe(1);
  });

  it("scrubs faster toward the top and slower toward the bottom (2x, 1x, 1/2, 1/4)", () => {
    const { onChange, prefix } = setup({ value: 0 });
    pointer(prefix, "pointerdown", { clientX: 100, clientY: 300 });
    pointer(prefix, "pointermove", { clientX: 110, clientY: 300 }); // 1x: 10
    pointer(prefix, "pointermove", { clientX: 110, clientY: 200 }); // up: 2x from here
    pointer(prefix, "pointermove", { clientX: 120, clientY: 200 }); // +20
    pointer(prefix, "pointermove", { clientX: 120, clientY: 600 }); // far down: 1/4
    pointer(prefix, "pointermove", { clientX: 160, clientY: 600 }); // +10
    expect(document.documentElement.getAttribute("data-scrub-speed")).toBe("0.25");
    pointer(prefix, "pointerup", { clientX: 160, clientY: 600 });
    expect(onChange.calls.at(-1)).toEqual([40, { final: true, source: "scrub" }]);
  });

  it("scrubs the field itself while ⌥ is held", () => {
    const { onChange, input } = setup({ value: 0 });
    pointer(input, "pointerdown", { clientX: 100, altKey: true });
    pointer(input, "pointermove", { clientX: 105, altKey: true });
    pointer(input, "pointerup", { clientX: 105 });
    expect(onChange.calls.at(-1)).toEqual([5, { final: true, source: "scrub" }]);
    expect(document.activeElement).not.toBe(input);
  });
});
