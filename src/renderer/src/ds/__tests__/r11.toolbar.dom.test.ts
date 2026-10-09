// @vitest-environment happy-dom
// Round 11 (live toolbar/*-tools-menu.txt): a slot's menu lights the slot's own tool — F in Region tools, R in Shape
// tools, P in Creation tools, T in Type tools, C in Comment tools — whichever tool is active.
import { afterEach, describe, expect, it } from "vitest";
import { EditorToolbar, type EditorToolbarProps, type ToolId } from "../components/EditorToolbar";
import { $, $$, click, mount, spy, type Mounted } from "./dom";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

describe("round 11: the slot menus' lit row", () => {
  const checkedIn = (menu: string, props: Partial<EditorToolbarProps>): string[] => {
    m?.unmount();
    m = mount(EditorToolbar, { tool: "move", onTool: spy<[ToolId]>(), mode: "design", onMode: spy(), ...props } as EditorToolbarProps);
    click($(`[aria-label="${menu}"]`, m.host));
    return $$('#ds-overlays [role="menuitemradio"]').filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.textContent ?? "");
  };
  it("lights the slot's own tool while another slot's tool is the active one", () => {
    expect(checkedIn("Region tools", { tool: "ellipse" })).toEqual(["FrameF"]);
    expect(checkedIn("Type tools", { tool: "ellipse" })).toEqual(["TextT"]);
    expect(checkedIn("Comment tools", { tool: "ellipse" })).toEqual(["CommentC"]);
    expect(checkedIn("Creation tools", { tool: "ellipse" })).toEqual(["PenP"]);
    expect(checkedIn("Shape tools", { tool: "frame" })).toEqual(["RectangleR"]);
  });
  it("the slot's last chosen tool is the lit one", () => {
    const groupTools = { region: "section", shape: "star" } as const;
    expect(checkedIn("Region tools", { groupTools })[0]).toMatch(/^Section/);
    expect(checkedIn("Shape tools", { groupTools })[0]).toMatch(/^Star/);
  });
});
