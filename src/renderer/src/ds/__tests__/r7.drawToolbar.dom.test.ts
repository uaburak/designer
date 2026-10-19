// @vitest-environment happy-dom
// Round 7c (docs/draw.md §5.1): the bottom toolbar per mode — Design keeps Figma's six slots; Draw has Move ▾, Shape ▾,
// the quick-access Pen, Pencil and Brush (slots of their own, no menu), Type ▾ (Text on path enabled), Comment ▾.
import { afterEach, describe, expect, it } from "vitest";
import { DRAW_TOOL_GROUPS, EditorToolbar, groupOf, TOOLS, toolForKey, toolGroups, type EditorToolbarProps, type ToolId } from "../components/EditorToolbar";
import { $, $$, click, mount, spy, type Mounted } from "./dom";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

const setup = (props: Partial<EditorToolbarProps>) => {
  const onTool = spy<[ToolId]>();
  m = mount(EditorToolbar, { tool: "move", onTool, mode: "design", onMode: spy(), ...props } as EditorToolbarProps);
  return { onTool };
};
const slots = () => $$('[data-ds="ToolButton"] > button[aria-pressed]', m!.host).map((t) => t.getAttribute("aria-label"));
const chevrons = () => $$('[data-ds="ToolButton"] > button[aria-haspopup="menu"]', m!.host).map((t) => t.getAttribute("aria-label"));

describe("round 7c: the toolbar per mode", () => {
  it("models Draw's slots", () => {
    expect(DRAW_TOOL_GROUPS.map((g) => g.tools)).toEqual([["move", "hand", "scale"], ["rectangle", "line", "arrow", "ellipse", "polygon", "star", "image"], ["pen"], ["pencil"], ["brush"], ["text", "text-on-path"], ["comment", "annotation", "measurement"]]);
    // Dev Mode: Move, Measurement, Annotation, Comment, a slot each (the owner's capture 2026-10-18)
    expect(toolGroups("dev").map((g) => g.tools)).toEqual([["move"], ["measurement"], ["annotation"], ["comment"]]);
    expect(TOOLS.brush).toEqual({ id: "brush", label: "Brush", shortcut: "B", icon: "24.brush" });
    expect([groupOf("pen", "draw"), groupOf("pen"), groupOf("brush", "draw"), groupOf("brush")]).toEqual(["pen", "creation", "brush", "creation"]);
    // Frame has no slot in Draw: none lights
    expect(DRAW_TOOL_GROUPS.some((g) => g.id === groupOf("frame", "draw"))).toBe(false);
    expect(toolForKey({ key: "b", shiftKey: false })).toBe("brush");
  });

  it("Design: Figma's six slots, Pen and Pencil in Creation tools", () => {
    setup({});
    expect(slots()).toEqual(["Move", "Frame", "Rectangle", "Pen", "Text", "Comment", "Actions"]);
    expect(chevrons()).toEqual(["Move tools", "Region tools", "Shape tools", "Creation tools", "Type tools", "Comment tools"]);
  });

  it("Draw: Pen, Pencil and Brush as quick-access slots without a menu; the Brush lit", () => {
    const { onTool } = setup({ mode: "draw", tool: "brush" });
    expect(slots()).toEqual(["Move", "Rectangle", "Pen", "Pencil", "Brush", "Text", "Comment", "Actions"]);
    expect(chevrons()).toEqual(["Move tools", "Shape tools", "Type tools", "Comment tools"]);
    expect($$('[data-ds="ToolButton"] > button[aria-pressed="true"]', m!.host).map((b) => b.getAttribute("aria-label"))).toEqual(["Brush"]);
    expect($('[aria-label="Brush"]', m!.host).getAttribute("aria-keyshortcuts")).toBe("B");
    click($('[aria-label="Pencil"]', m!.host));
    expect(onTool.calls.at(-1)).toEqual(["pencil"]);
    expect($('[data-ds="ModeSwitch"] [aria-checked="true"]', m!.host).getAttribute("aria-label")).toBe("Draw");
  });

  it("Text on path is offered in Type tools (in both modes) unless the editor disables it", () => {
    for (const mode of ["design", "draw"] as const) {
      const { onTool } = setup({ mode });
      click($('[aria-label="Type tools"]', m!.host));
      const items = $$('#ds-overlays [role="menuitemradio"]');
      expect(items.map((i) => i.textContent)).toEqual(["TextT", "Text on path"]);
      expect(items[1].getAttribute("aria-disabled")).toBeNull();
      click(items[1]);
      expect(onTool.calls.at(-1)).toEqual(["text-on-path"]);
      m!.unmount();
      m = null;
    }
  });
});
