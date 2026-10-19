// @vitest-environment happy-dom
// Tooltips never show under an open menu (ds TooltipManager): a menu that opens during the tooltip delay — by a key, by
// the control's own press, or a canvas menu — keeps the pending tooltip from showing (the "Set status" bug, 2026-10-12).
// A badge follows the label: the mode switch's "Motion  Beta" (docs/motion.md §6.1).
import { act, createElement, Fragment } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EDITOR_MODES } from "../components/EditorToolbar";
import { ContextMenu } from "../components/Menu";
import { TooltipManager, tooltipProps } from "../overlay/TooltipManager";
import { mount, spy, type Mounted } from "./dom";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  vi.useRealTimers();
});

function Host({ menu }: { menu: boolean }) {
  return createElement(
    Fragment,
    null,
    createElement(TooltipManager),
    createElement("button", { "data-tooltip": "Set status", id: "b" }, "x"),
    menu ? createElement(ContextMenu, { at: { x: 0, y: 0 }, entries: [{ id: "a", label: "Done" }], onSelect: spy<[string]>(), onClose: spy<[]>() }) : null,
  );
}

const over = (el: Element) =>
  act(() => {
    el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse", buttons: 0 }));
  });
const tooltip = () => document.querySelector('[role="tooltip"]');

const leave = (el: Element) =>
  act(() => {
    el.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: document.body }));
  });

function Pair() {
  return createElement(
    Fragment,
    null,
    createElement(TooltipManager),
    createElement("button", { "data-tooltip": "Move", id: "a" }, "a"),
    createElement("button", { "data-tooltip": "Frame", id: "b" }, "b"),
    createElement("button", { "data-tooltip": "Quick", "data-tooltip-delay": "150", id: "c" }, "c"),
  );
}

describe("Figma's tooltip timing (atlas 02 §6)", () => {
  it("shows after 1000 ms, not before", () => {
    vi.useFakeTimers();
    m = mount(Pair, {});
    over(document.getElementById("a")!);
    act(() => vi.advanceTimersByTime(900));
    expect(tooltip()).toBeNull();
    act(() => vi.advanceTimersByTime(100));
    expect(tooltip()?.textContent).toBe("Move");
  });

  it("while one shows, the next target's shows at once; leaving hides it 300 ms later", () => {
    vi.useFakeTimers();
    m = mount(Pair, {});
    over(document.getElementById("a")!);
    act(() => vi.advanceTimersByTime(1000));
    over(document.getElementById("b")!);
    expect(tooltip()?.textContent).toBe("Frame");
    leave(document.getElementById("b")!);
    act(() => vi.advanceTimersByTime(299));
    expect(tooltip()?.textContent).toBe("Frame");
    act(() => vi.advanceTimersByTime(1));
    expect(tooltip()).toBeNull();
  });

  it("a pending tooltip is dropped at once when the pointer leaves; a per-element delay overrides the default", () => {
    vi.useFakeTimers();
    m = mount(Pair, {});
    over(document.getElementById("a")!);
    act(() => vi.advanceTimersByTime(500));
    leave(document.getElementById("a")!);
    act(() => vi.advanceTimersByTime(1000));
    expect(tooltip()).toBeNull();
    over(document.getElementById("c")!);
    act(() => vi.advanceTimersByTime(150));
    expect(tooltip()?.textContent).toBe("Quick");
  });
});

describe("tooltips and menus", () => {
  it("a hovered control's tooltip shows after the delay", () => {
    vi.useFakeTimers();
    m = mount(Host, { menu: false });
    over(document.getElementById("b")!);
    act(() => vi.advanceTimersByTime(1000));
    expect(tooltip()?.textContent).toBe("Set status");
  });

  it("a menu opened during the delay keeps it hidden", () => {
    vi.useFakeTimers();
    m = mount(Host, { menu: false });
    over(document.getElementById("b")!);
    m.rerender(Host, { menu: true });
    act(() => vi.advanceTimersByTime(1000));
    expect(tooltip()).toBeNull();
  });

  it("a badge follows the label: the mode switch's Motion radio carries Beta", () => {
    vi.useFakeTimers();
    const motion = EDITOR_MODES.find((mode) => mode.id === "motion")!;
    expect(motion.badge).toBe("Beta");
    const Beta = () => createElement(Fragment, null, createElement(TooltipManager), createElement("button", { id: "m", ...tooltipProps(motion.label, motion.shortcut, "top", undefined, motion.badge) }, "x"));
    m = mount(Beta, {});
    over(document.getElementById("m")!);
    act(() => vi.advanceTimersByTime(1000));
    expect([...tooltip()!.children].map((c) => c.textContent)).toEqual(["Motion", "Beta"]);
  });
});
