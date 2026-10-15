// @vitest-environment happy-dom
// Round 17b — Simplify vector and Offset path as Figma's tools (docs/research/rea/vector.md §8, §10): the secondary
// toolbar (a fake engine records its engine_path_tool calls): Simplify's slider −2…3 between its "simpler" and "more
// detailed" icons, Offset's slider over the engine's range with Join Square / Round, Cancel and ✓, Enter and Esc; the
// menu commands open the tool; the toolbar follows PATH_TOOL.
import { act, createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { PathToolInput, PathToolState } from "@/engine/codec";
import { $, $$, click, key, mount, type Mounted } from "../../ds/__tests__/dom";
import { EditorContext, type EditorController } from "../controller";
import { openPathTool, PathToolbar, usePathTool } from "../canvas/PathToolbar";

const CLOSED: PathToolState = { active: false, kind: null, node: null, threshold: 3, offset: 0, join: "MITER", minOffset: 0, maxOffset: 0 };

function fakeEditor(refuse = false) {
  const calls: PathToolInput[] = [];
  let state: PathToolState = CLOSED;
  const listeners: ((e: unknown) => void)[] = [];
  const emit = () => listeners.forEach((l) => l({ type: "PATH_TOOL", ...state }));
  const engine = {
    destroyed: false,
    pathTool: (input: PathToolInput) => {
      calls.push(input);
      if (input.op === "begin") {
        if (refuse) return null;
        state = { ...CLOSED, active: true, kind: input.kind, node: "1:2", minOffset: -25, maxOffset: 100 };
      } else if (input.op === "set") {
        const { op: _op, ...values } = input;
        state = { ...state, ...values };
      }
      else if (input.op === "apply" || input.op === "cancel") state = CLOSED;
      if (input.op !== "state") emit();
      return state;
    },
    on: (type: string, l: (e: unknown) => void) => {
      if (type === "PATH_TOOL") listeners.push(l);
      return () => listeners.splice(listeners.indexOf(l), 1);
    },
  };
  let focused = 0;
  const ed = { engine, focusCanvas: () => void focused++ } as unknown as EditorController;
  return { ed, calls, focusedCount: () => focused };
}

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

const withEditor = (ed: EditorController, child: () => ReactNode) =>
  function Host() {
    return createElement(EditorContext.Provider, { value: ed }, child());
  };

describe("round 17b: the Simplify vector / Offset path toolbar", () => {
  it("opens from the command, shows Simplify's slider between its icons; ✓ applies, Cancel restores", () => {
    const { ed, calls } = fakeEditor();
    function Host() {
      const state = usePathTool(ed);
      return state ? createElement(PathToolbar, { state }) : null;
    }
    m = mount(withEditor(ed, () => createElement(Host)), {});
    expect($("[data-path-toolbar]")).toBeNull();
    act(() => void expect(openPathTool(ed, "SIMPLIFY")).toBe(true));
    const bar = $("[data-path-toolbar='simplify']");
    expect(bar).not.toBeNull();
    expect(bar.getAttribute("aria-label")).toBe("Simplify vector");
    expect($$("[title]", bar).map((e) => e.getAttribute("title"))).toEqual(["Simpler", "More detailed"]);
    const slider = $("[role='slider']", bar);
    expect(slider.getAttribute("aria-valuemin")).toBe("-2");
    expect(slider.getAttribute("aria-valuemax")).toBe("3");
    expect(slider.getAttribute("aria-valuenow")).toBe("3");
    // ← steps by 0.01: a live preview.
    key(slider, "ArrowLeft");
    expect(calls.at(-1)).toEqual({ op: "set", threshold: 2.99 });
    click($("[data-path-apply]", bar));
    expect(calls.at(-1)).toEqual({ op: "apply" });
    expect($("[data-path-toolbar]")).toBeNull();
    act(() => void openPathTool(ed, "SIMPLIFY"));
    click($("[data-path-cancel]"));
    expect(calls.at(-1)).toEqual({ op: "cancel" });
    expect($("[data-path-toolbar]")).toBeNull();
  });

  it("Offset: the engine's range, Join Square / Round; Enter applies, Esc cancels", () => {
    const { ed, calls } = fakeEditor();
    function Host() {
      const state = usePathTool(ed);
      return state ? createElement(PathToolbar, { state }) : null;
    }
    m = mount(withEditor(ed, () => createElement(Host)), {});
    act(() => void openPathTool(ed, "OFFSET"));
    const bar = $("[data-path-toolbar='offset']");
    expect(bar.getAttribute("aria-label")).toBe("Offset vector");
    const slider = $("[role='slider']", bar);
    expect(slider.getAttribute("aria-valuemin")).toBe("-25");
    expect(slider.getAttribute("aria-valuemax")).toBe("100");
    key(slider, "ArrowRight");
    expect(calls.at(-1)).toEqual({ op: "set", offset: 1 });
    const round = $$("[role='radio'], button", bar).find((b) => b.getAttribute("aria-label") === "Round" || b.getAttribute("data-value") === "ROUND");
    expect(round).toBeTruthy();
    click(round!);
    expect(calls.at(-1)).toEqual({ op: "set", join: "ROUND" });
    key(slider, "Enter");
    expect(calls.at(-1)).toEqual({ op: "apply" });
    act(() => void openPathTool(ed, "OFFSET"));
    key($("[role='slider']"), "Escape");
    expect(calls.at(-1)).toEqual({ op: "cancel" });
  });

  it("a refused open (nothing to simplify) shows nothing", () => {
    const { ed } = fakeEditor(true);
    expect(openPathTool(ed, "SIMPLIFY")).toBe(false);
  });
});
