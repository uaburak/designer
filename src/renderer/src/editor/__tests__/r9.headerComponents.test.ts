// Round 9 — the Design panel's header and the component / instance panels as live Figma's (docs/editor.md "Round 9 —
// Design panel header, component and instance panels"): the header's actions per kind, Frame ▾'s list, the component
// header's actions, Create property's order, the swap menu's levels, the description's Markdown.
import { describe, expect, it } from "vitest";
import { FRAME_PRESETS, HEADER_ACTIONS, frameMenu, headerKind } from "../panels/design/Header";
import { ADD_TYPES, COMPONENT_HEADER_ACTIONS, applyLabel } from "../panels/design/Component";
import { assetPath, levelContents, startLevel } from "../panels/design/ComponentPicker";
import { DESCRIPTION_TOOLS } from "../panels/design/ComponentConfiguration";
import { markdownToHtml, plainDescription } from "../panels/design/richText";
import type { ComponentAsset } from "../model/components";
import type { PanelNode } from "../panels/design/shared";

const n = (type: string, more: Partial<PanelNode> = {}) => ({ guid: "1:1", type, ...more }) as PanelNode;

describe("the header's actions (live design/*.txt)", () => {
  it("a shape in a frame, an auto layout or a grid: Select matching layers, Create component, Use as mask, More actions", () => {
    expect(headerKind([n("ROUNDED_RECTANGLE")], true)).toBe("nested");
    expect(headerKind([n("VECTOR")], true)).toBe("nested");
    expect(HEADER_ACTIONS.nested).toEqual(["matching", "create", "mask", "more"]);
  });

  it("on the page: a rectangle keeps Create component, Use as mask, Boolean operations, Edit object", () => {
    expect(headerKind([n("ROUNDED_RECTANGLE")])).toBe("rect");
    expect(HEADER_ACTIONS.rect).toEqual(["create", "mask", "boolean", "edit"]);
    // A text or a frame in a frame keeps its own row (only shapes were captured nested).
    expect(headerKind([n("TEXT")], true)).toBe("text");
    expect(headerKind([n("FRAME")], true)).toBe("frame");
    expect(headerKind([n("FRAME", { resizeToFit: true })], true)).toBe("group");
  });
});

describe("Frame ▾ (live popovers/frame-presets-menu.txt)", () => {
  it("one flat list: Section, Frame, Group, then the preset blocks after lines, their titles kept for assistive tech", () => {
    const entries = frameMenu("Frame");
    const items = entries.filter((e) => typeof e === "object" && "id" in e);
    expect(items.slice(0, 3).map((e) => (e as { label: string }).label)).toEqual(["Section", "Frame", "Group"]);
    expect(items[0]).toMatchObject({ checked: false, disabled: false });
    expect(items[1]).toMatchObject({ checked: true });
    expect(entries.filter((e) => e === "-")).toHaveLength(FRAME_PRESETS.length);
    expect(entries.filter((e) => typeof e === "object" && "header" in e).map((e) => (e as { header: string }).header)).toEqual(["Frame Layout Options", ...FRAME_PRESETS.map((g) => g.header)]);
    expect(items[3]).toMatchObject({ label: "iPhone 17", hint: "402×874" });
  });

  it("what can't be made is shown disabled", () => {
    const items = frameMenu("Frame", { Section: false, Frame: true, Group: true }).filter((e) => typeof e === "object" && "id" in e);
    expect(items[0]).toMatchObject({ label: "Section", disabled: true });
  });
});

describe("the component panels (live design/component.txt, component-set.txt, variant.txt, instance.txt)", () => {
  it("the headers' actions", () => {
    expect(COMPONENT_HEADER_ACTIONS.component).toEqual(["add-variant", "configuration", "more"]);
    expect(COMPONENT_HEADER_ACTIONS.set).toEqual(["multi-edit", "add-variant", "configuration", "more"]);
    expect(COMPONENT_HEADER_ACTIONS.variant).toEqual(["multi-edit", "matching", "configuration"]);
  });

  it("Create property's order: Variant, Text, Boolean, Instance swap, Slot", () => {
    expect(ADD_TYPES).toEqual(["VARIANT", "TEXT", "BOOL", "INSTANCE_SWAP", "SLOT"]);
  });

  it("the apply buttons' wording", () => {
    expect(applyLabel({ type: "BOOL", name: "Show icon" })).toBe("Apply variable/property to Show icon");
    expect(applyLabel({ type: "VARIANT", name: "State" })).toBe("Apply variable");
  });
});

describe("the swap menu's levels (live popovers/instance-header-swap-menu.txt)", () => {
  const a = (id: string, name: string, frameName: string | null = null, page = "0:1"): ComponentAsset => ({ id, name, kind: "component", target: id, page, pageName: "Capture", frame: frameName ? "9:9" : null, frameName });
  const assets = [a("8:1", "Button"), a("8:50", "Card"), { ...a("8:40", "Chip"), kind: "set" as const }, a("8:20", "Icon/Star"), a("8:21", "Icon/Heart"), a("5:1", "Logo", "Brand")];
  const pages = [
    { guid: "0:1", name: "Capture" },
    { guid: "0:2", name: "Page 3" },
  ];

  it("a page lists its components by name, then its folders (frames and slash names)", () => {
    const top = levelContents(assets, { page: "0:1", path: [] }, pages);
    expect(top.items.map((x) => x.name)).toEqual(["Button", "Card", "Chip"]);
    expect(top.folders.map((f) => f.name)).toEqual(["Brand", "Icon"]);
    const icons = levelContents(assets, top.folders[1].level, pages);
    expect(icons.items.map((x) => x.name)).toEqual(["Icon/Heart", "Icon/Star"]);
    expect(assetPath(assets[5])).toEqual(["Brand"]);
  });

  it("opens at the current component's level; the library's root lists its pages", () => {
    expect(startLevel(assets, assets[3])).toEqual({ page: "0:1", path: ["Icon"] });
    expect(startLevel(assets, null)).toEqual({ page: "0:1", path: [] });
    const two = [...assets, a("6:1", "Other", null, "0:2")];
    expect(startLevel(two, null)).toEqual({ page: null, path: [] });
    expect(levelContents(two, { page: null, path: [] }, pages).folders.map((f) => f.name)).toEqual(["Capture", "Page 3"]);
  });
});

describe("Component configuration (live popovers/component-configuration.txt)", () => {
  it("the description's toolbar as live, its keys", () => {
    expect(DESCRIPTION_TOOLS.map((t) => t.label)).toEqual(["Bold", "Italic", "Strikethrough", "Header 1", "Bulleted list", "Ordered list", "Link", "Code", "Code block"]);
    expect(DESCRIPTION_TOOLS.map((t) => t.mac ?? "")).toEqual(["⌘B", "⌘I", "⌘⇧X", "", "", "", "⌘⇧U", "⌘⇧C", "⌘⇧⌥C"]);
  });

  it("Markdown in, the editor's HTML out; the plain text for search", () => {
    const md = "# Button\nPrimary **action**, *quiet* and ~~old~~ with `code`\n- one\n- two\n1. first\n```\nlet a = 1;\n```\nSee [docs](https://example.com)";
    const html = markdownToHtml(md);
    expect(html).toContain("<h1>Button</h1>");
    expect(html).toContain("<b>action</b>");
    expect(html).toContain("<i>quiet</i>");
    expect(html).toContain("<s>old</s>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li></ol>");
    expect(html).toContain("<pre>let a = 1;</pre>");
    expect(html).toContain('<a href="https://example.com">docs</a>');
    expect(markdownToHtml("<b>")).toBe("<div>&lt;b&gt;</div>");
    expect(plainDescription(md)).toBe("Button\nPrimary action, quiet and old with code\none\ntwo\nfirst\n\nlet a = 1;\n\nSee docs");
  });
});
