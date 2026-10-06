/**
 * Helpers for the DS's component tests (happy-dom, `// @vitest-environment happy-dom` per file):
 * React 19's act, native events (React listens at the root, so they reach its handlers), a fake box.
 */
import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export type Mounted = { host: HTMLElement; root: Root; rerender: <P extends object>(c: ComponentType<P>, props: P) => void; unmount: () => void };

export function mount<P extends object>(component: ComponentType<P>, props: P): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(component, props)));
  return {
    host,
    root,
    rerender: (c, p) => act(() => root.render(createElement(c, p))),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
      document.getElementById("ds-overlays")?.remove();
    },
  };
}

export function pointer(el: Element, type: "pointerdown" | "pointermove" | "pointerup" | "pointerenter" | "pointerleave", init: { clientX?: number; clientY?: number; shiftKey?: boolean; altKey?: boolean; button?: number } = {}) {
  act(() => {
    el.dispatchEvent(new PointerEvent(type, { bubbles: type !== "pointerenter" && type !== "pointerleave", cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, ...init }));
  });
}

export function key(el: Element, key: string, init: { shiftKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
}

export function click(el: Element) {
  act(() => {
    (el as HTMLElement).click();
  });
}

/** Types into an input as a user would (React's onChange listens to "input"). */
export function type(input: HTMLInputElement, text: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function focus(el: HTMLElement) {
  act(() => el.focus());
}

/** Gives an element a layout box (happy-dom has none). */
export function box(el: Element, rect: { left: number; top: number; width: number; height: number }) {
  (el as HTMLElement).getBoundingClientRect = () => ({ ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => rect }) as DOMRect;
}

/** A spy recording every call's arguments. */
export function spy<A extends unknown[]>() {
  const calls: A[] = [];
  const fn = (...args: A) => {
    calls.push(args);
  };
  return Object.assign(fn, { calls });
}

export const $ = (sel: string, root: ParentNode = document) => root.querySelector(sel) as HTMLElement;
export const $$ = (sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as HTMLElement[];
