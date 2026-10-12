// @vitest-environment happy-dom
// Tooltips never show under an open menu (ds TooltipManager): a menu that opens during the tooltip delay — by a key, by
// the control's own press, or a canvas menu — keeps the pending tooltip from showing (the "Set status" bug, 2026-10-12).
import { act, createElement, Fragment } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu } from "../components/Menu";
import { TooltipManager } from "../overlay/TooltipManager";
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

describe("tooltips and menus", () => {
  it("a hovered control's tooltip shows after the delay", () => {
    vi.useFakeTimers();
    m = mount(Host, { menu: false });
    over(document.getElementById("b")!);
    act(() => vi.advanceTimersByTime(600));
    expect(tooltip()?.textContent).toBe("Set status");
  });

  it("a menu opened during the delay keeps it hidden", () => {
    vi.useFakeTimers();
    m = mount(Host, { menu: false });
    over(document.getElementById("b")!);
    m.rerender(Host, { menu: true });
    act(() => vi.advanceTimersByTime(600));
    expect(tooltip()).toBeNull();
  });
});
