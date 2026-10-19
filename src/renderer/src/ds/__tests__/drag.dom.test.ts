// @vitest-environment happy-dom
/**
 * Figma's floating panels and draggable modals move by their header (ds/overlay/drag.ts): the shared drag of every
 * titled Popover (colour picker, effect settings, Interaction details, Edit variable, the pickers…) and of a
 * `draggable` Dialog (Manage libraries, Export) — kept in the window, controls in the header keep their press, the
 * place forgotten on reopen.
 */
import { createElement as h } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog } from "../components/Dialog";
import { Popover } from "../components/Popover";
import { IconButton } from "../components/Button";
import { clampToWindow } from "../overlay/drag";
import { $, box, mount, pointer, type Mounted } from "./dom";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

const VIEW = { width: window.innerWidth, height: window.innerHeight };

describe("clampToWindow", () => {
  it("keeps the whole panel inside the window, its top-left corner when it is bigger", () => {
    expect(clampToWindow(-20, 30, { width: 240, height: 300 }, { width: 1000, height: 800 })).toEqual({ x: 0, y: 30 });
    expect(clampToWindow(900, 700, { width: 240, height: 300 }, { width: 1000, height: 800 })).toEqual({ x: 760, y: 500 });
    expect(clampToWindow(50, 50, { width: 1200, height: 900 }, { width: 1000, height: 800 })).toEqual({ x: 0, y: 0 });
  });
});

describe("a titled Popover", () => {
  const open = () => {
    const anchor = new DOMRect(400, 200, 20, 20);
    m = mount(Popover, { anchor, placement: "bottom", title: "Effect settings", onClose: () => {}, headerActions: h(IconButton, { icon: "24.plus.small", label: "Add" }) } as Parameters<typeof Popover>[0]);
    const panel = $('[data-ds="Popover"]');
    panel.style.left = "300px";
    panel.style.top = "200px";
    box(panel, { left: 300, top: 200, width: 240, height: 200 });
    return panel;
  };

  it("drags by its header, kept in the window", () => {
    const panel = open();
    const header = panel.querySelector("h2")!.parentElement!;
    pointer(header, "pointerdown", { clientX: 320, clientY: 210 });
    pointer(window as unknown as Element, "pointermove", { clientX: 370, clientY: 250 });
    expect([panel.style.left, panel.style.top]).toEqual(["350px", "240px"]);
    // Past the window's edges: stopped there.
    pointer(window as unknown as Element, "pointermove", { clientX: -500, clientY: 99999 });
    expect([panel.style.left, panel.style.top]).toEqual(["0px", `${VIEW.height - 200}px`]);
    pointer(window as unknown as Element, "pointerup");
    pointer(window as unknown as Element, "pointermove", { clientX: 500, clientY: 300 });
    expect(panel.style.left).toBe("0px"); // the drag ended
  });

  it("a press on the header's buttons isn't a drag", () => {
    const panel = open();
    const add = panel.querySelector('[aria-label="Add"]')!;
    pointer(add, "pointerdown", { clientX: 320, clientY: 210 });
    pointer(window as unknown as Element, "pointermove", { clientX: 400, clientY: 300 });
    expect([panel.style.left, panel.style.top]).toEqual(["300px", "200px"]);
    pointer(window as unknown as Element, "pointerup");
  });
});

describe("a draggable Dialog", () => {
  const render = (open: boolean, draggable = true) => h(Dialog, { title: "Manage libraries", open, draggable, header: "small", onClose: () => {} }, "Body");

  it("moves by its header (a translate from its centred place), clamped, and is centred again when reopened", () => {
    m = mount(() => render(true), {});
    const panel = $('[data-ds="Dialog"]');
    box(panel, { left: 200, top: 100, width: 591, height: 641 });
    const header = panel.querySelector("h2")!.parentElement!;
    pointer(header, "pointerdown", { clientX: 250, clientY: 120 });
    pointer(window as unknown as Element, "pointermove", { clientX: 230, clientY: 140 });
    expect(panel.style.translate).toBe("-20px 20px");
    pointer(window as unknown as Element, "pointermove", { clientX: -1000, clientY: -1000 });
    expect(panel.style.translate).toBe("-200px -100px"); // at the window's top-left
    pointer(window as unknown as Element, "pointerup");
    m.rerender(() => render(false), {});
    m.rerender(() => render(true), {});
    expect($('[data-ds="Dialog"]').style.translate).toBe("");
  });

  it("a plain Dialog doesn't move", () => {
    m = mount(() => render(true, false), {});
    const panel = $('[data-ds="Dialog"]');
    box(panel, { left: 200, top: 100, width: 320, height: 200 });
    pointer(panel.querySelector("h2")!.parentElement!, "pointerdown", { clientX: 250, clientY: 120 });
    pointer(window as unknown as Element, "pointermove", { clientX: 400, clientY: 300 });
    expect(panel.style.translate).toBe("");
    pointer(window as unknown as Element, "pointerup");
  });
});
