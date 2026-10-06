// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { EditorToolbar, groupOf, TOOL_GROUPS, TOOLS, toolForKey, type EditorMode, type EditorToolbarProps, type ToolId } from "../components/EditorToolbar";
import { $, $$, click, mount, spy, type Mounted } from "./dom";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

describe("toolbar model", () => {
  it("has Figma's slots and tools", () => {
    expect(TOOL_GROUPS.map((g) => g.tools)).toEqual([
      ["move", "hand", "scale"],
      ["frame", "section", "slice"],
      ["rectangle", "line", "arrow", "ellipse", "polygon", "star", "image"],
      ["pen", "pencil"],
      ["text", "text-on-path"],
      ["comment", "annotation", "measurement"],
    ]);
    expect(groupOf("ellipse")).toBe("shape");
  });
  it("maps keys to tools", () => {
    const k = (key: string, mods: { shiftKey?: boolean; metaKey?: boolean } = {}) => toolForKey({ key, shiftKey: false, ...mods });
    expect([k("v"), k("H"), k("k"), k("f"), k("s"), k("r"), k("l"), k("o"), k("p"), k("t"), k("c")]).toEqual(["move", "hand", "scale", "frame", "slice", "rectangle", "line", "ellipse", "pen", "text", "comment"]);
    expect([k("S", { shiftKey: true }), k("L", { shiftKey: true }), k("P", { shiftKey: true }), k("k", { shiftKey: true, metaKey: true })]).toEqual(["section", "arrow", "pencil", "image"]);
    expect(k("x")).toBeNull();
    expect(k("v", { metaKey: true })).toBeNull();
  });
});

describe("EditorToolbar", () => {
  const setup = (props: Partial<EditorToolbarProps> = {}) => {
    const onTool = spy<[ToolId]>();
    const onMode = spy<[EditorMode]>();
    m = mount(EditorToolbar, { tool: "move", onTool, mode: "design", onMode, ...props } as EditorToolbarProps);
    return { onTool, onMode };
  };

  it("draws eight tool slots, the current one pressed, and the mode switch", () => {
    setup({ tool: "ellipse", groupTools: { region: "section" } });
    const tools = $$('[data-ds="ToolButton"] > button[aria-pressed]', m!.host);
    expect(tools.map((t) => t.getAttribute("aria-label"))).toEqual(["Move", "Section", "Ellipse", "Pen", "Text", "Comment", "Actions"]);
    expect(tools.filter((t) => t.getAttribute("aria-pressed") === "true").map((t) => t.getAttribute("aria-label"))).toEqual(["Ellipse"]);
    expect($$('[data-ds="ModeSwitch"] [role="radio"]', m!.host).map((b) => `${b.getAttribute("aria-label")}:${b.getAttribute("aria-checked")}`)).toEqual(["Draw:false", "Design:true", "Motion:false", "Dev Mode:false"]);
  });

  it("chooses a slot's shown tool, a tool from its menu, and a mode", () => {
    const { onTool, onMode } = setup({ groupTools: { shape: "star" } });
    click($('[aria-label="Star"]', m!.host));
    expect(onTool.calls.at(-1)).toEqual(["star"]);
    click($('[aria-label="Creation tools"]', m!.host));
    const items = $$('#ds-overlays [role="menuitemcheckbox"]');
    expect(items.map((i) => i.textContent)).toEqual(["PenP", `Pencil${TOOLS.pencil.shortcut}`]);
    click(items[1]);
    expect(onTool.calls.at(-1)).toEqual(["pencil"]);
    click($('[aria-label="Dev Mode"]', m!.host));
    expect(onMode.calls).toEqual([["dev"]]);
  });
});
