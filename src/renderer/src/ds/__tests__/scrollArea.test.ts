// @vitest-environment happy-dom
import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrollArea, type ScrollAreaProps } from "../components/ScrollArea";
import { $, box, mount, pointer, type Mounted } from "./dom";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  vi.useRealTimers();
});

/** A 100px viewport over 400px of content (happy-dom has no layout, so the sizes are given). */
function setup(props: Partial<ScrollAreaProps> = {}) {
  let viewport: HTMLDivElement | null = null;
  m = mount(ScrollArea, { children: createElement("div", { style: { height: 400 } }, "content"), viewportRef: (el: HTMLDivElement | null) => (viewport = el), ...props } as ScrollAreaProps);
  const v = viewport! as HTMLDivElement;
  Object.defineProperty(v, "clientHeight", { configurable: true, get: () => 100 });
  Object.defineProperty(v, "scrollHeight", { configurable: true, get: () => 400 });
  Object.defineProperty(v, "clientWidth", { configurable: true, get: () => 200 });
  Object.defineProperty(v, "scrollWidth", { configurable: true, get: () => 200 });
  let top = 0;
  Object.defineProperty(v, "scrollTop", { configurable: true, get: () => top, set: (n: number) => (top = Math.max(0, Math.min(300, n))) });
  v.scrollBy = ((opts: ScrollToOptions) => {
    v.scrollTop = top + (opts.top ?? 0);
    v.dispatchEvent(new Event("scroll"));
  }) as typeof v.scrollBy;
  scroll(v, 0); // measure with the sizes
  return v;
}

function scroll(v: HTMLDivElement, to: number) {
  act(() => {
    v.scrollTop = to;
    v.dispatchEvent(new Event("scroll", { bubbles: false }));
  });
}

const track = () => $('[data-ds="ScrollArea"] > div:nth-child(2)');
const thumb = () => track().firstElementChild as HTMLElement;

describe("ScrollArea", () => {
  it("draws no thumb when nothing scrolls", () => {
    m = mount(ScrollArea, { children: "short" });
    expect($('[data-ds="ScrollArea"]').children).toHaveLength(1);
  });

  it("sizes and places the thumb from the scroll position (track = viewport − 4)", () => {
    const v = setup();
    // 100 / 400 of a 96px track = 24px; at the top
    expect(thumb().style.height).toBe("24px");
    expect(thumb().style.top).toBe("0px");
    scroll(v, 150); // halfway: (96 − 24) / 2
    expect(thumb().style.top).toBe("36px");
    scroll(v, 300);
    expect(thumb().style.top).toBe("72px");
  });

  it("shows the thumbs while scrolling and hides them a second later", () => {
    vi.useFakeTimers();
    const v = setup();
    expect(track().dataset.visible).toBeDefined(); // the measuring scroll flashed them
    act(() => vi.advanceTimersByTime(1000));
    expect(track().dataset.visible).toBeUndefined();
    scroll(v, 20);
    expect(track().dataset.visible).toBeDefined();
    act(() => vi.advanceTimersByTime(999));
    expect(track().dataset.visible).toBeDefined();
    act(() => vi.advanceTimersByTime(1));
    expect(track().dataset.visible).toBeUndefined();
  });

  it("shows them while the pointer is over the area", () => {
    vi.useFakeTimers();
    setup();
    act(() => vi.advanceTimersByTime(1000));
    const root = $('[data-ds="ScrollArea"]');
    // React derives enter/leave from over/out
    act(() => {
      root.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
    });
    expect(track().dataset.visible).toBeDefined();
    act(() => {
      root.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    });
    expect(track().dataset.visible).toBeUndefined();
  });

  it("dragging the thumb scrolls in proportion (track travel 72px = 300px of content)", () => {
    const v = setup();
    pointer(thumb(), "pointerdown", { clientX: 196, clientY: 10 });
    expect(thumb().dataset.dragging).toBeDefined();
    pointer(thumb(), "pointermove", { clientX: 196, clientY: 46 }); // 36px of 72
    expect(v.scrollTop).toBe(150);
    pointer(thumb(), "pointermove", { clientX: 196, clientY: 500 }); // clamped by the viewport
    expect(v.scrollTop).toBe(300);
    pointer(thumb(), "pointerup", { clientX: 196, clientY: 500 });
    expect(thumb().dataset.dragging).toBeUndefined();
  });

  it("a press on the track pages towards it (90% of the viewport)", () => {
    const v = setup();
    box(track(), { left: 192, top: 2, width: 8, height: 96 });
    pointer(track(), "pointerdown", { clientX: 196, clientY: 80 });
    expect(v.scrollTop).toBe(90);
    pointer(track(), "pointerdown", { clientX: 196, clientY: 3 }); // above the thumb (now at 21.6)
    expect(v.scrollTop).toBe(0);
  });

  it("forceVisible keeps them drawn", () => {
    vi.useFakeTimers();
    setup({ forceVisible: true });
    act(() => vi.advanceTimersByTime(5000));
    expect(track().dataset.visible).toBeDefined();
  });
});
