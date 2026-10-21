// @vitest-environment happy-dom
// The presentation view's own pieces found while recording the "Web davranışları turu": a press on the prototype keeps
// the focus where pointerdown put it (mousedown's default gave it back to the canvas, so the text input pressed got no
// keys); the scale chosen for a file comes back on the next presentation; ⌘R is Reload.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type Mounted } from "@/ds/__tests__/dom";
import { isReloadKey, PresentationView, readKeptScale, writeKeptScale, type PresentationSource } from "./PresentationView";

// No engine here (no WebGL, no Wasm fetch): one that never comes up.
vi.mock("@/engine/Engine", async (original) => ({ ...(await original<typeof import("@/engine/Engine")>()), Engine: { create: () => new Promise(() => {}) } }));

let view: Mounted | null = null;
beforeEach(() => localStorage.clear());
afterEach(() => {
  view?.unmount();
  view = null;
  document.body.innerHTML = "";
});

// A document that never arrives: the view, its canvas and its hidden field, no engine (no WebGL here).
const source: PresentationSource = { fileName: "Tour", stateKey: "file-1", load: () => new Promise(() => {}) };

describe("presentation view", () => {
  for (const variant of ["full", "inline"] as const)
    it(`a press on the prototype doesn't move the focus by mousedown's default (${variant})`, () => {
      view = mount(PresentationView, { source, variant, canvasId: `present-${variant}` });
      const canvas = document.getElementById(`present-${variant}`)!;
      expect(canvas).toBeTruthy();
      const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
      canvas.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
    });

  it("keeps the scale chosen per file in this browser", () => {
    expect(readKeptScale("file-1")).toEqual({});
    writeKeptScale("file-1", { scale: "RESPONSIVE", responsive: true });
    expect(readKeptScale("file-1")).toEqual({ scale: "RESPONSIVE", responsive: true });
    expect(readKeptScale("file-2")).toEqual({});
    localStorage.setItem("designer.present.scale:file-1", JSON.stringify({ scale: "HUGE" }));
    expect(readKeptScale("file-1")).toEqual({});
    localStorage.setItem("designer.present.scale:file-1", "not json");
    expect(readKeptScale("file-1")).toEqual({});
  });

  it("⌘R (Ctrl+R off the Mac) is Reload; with another modifier it isn't", () => {
    const k = (init: Partial<{ code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({ code: "KeyR", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init });
    expect(isReloadKey(k({ metaKey: true }), true)).toBe(true);
    expect(isReloadKey(k({ ctrlKey: true }), true)).toBe(false);
    expect(isReloadKey(k({ ctrlKey: true }), false)).toBe(true);
    expect(isReloadKey(k({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isReloadKey(k({}), true)).toBe(false);
    expect(isReloadKey(k({ code: "KeyT", metaKey: true }), true)).toBe(false);
  });
});
