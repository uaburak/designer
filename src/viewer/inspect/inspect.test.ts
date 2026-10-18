import { describe, expect, it } from "vitest";
import type { Color, NodeChange } from "@/engine/codec";
import { sectionText } from "./code";
import { codeSections } from "./codegen";
import { aspectRatio, cssSections, cssSnippet, cssText } from "./css";
import { redlines } from "./measure";
import { camelName, cssColor, cssVar, cssVariableName, gradientAngle, num, px, sizingOf, typeLabel, typographyOf } from "./model";
import { composeSections, swiftColor, swiftUISections } from "./native";
import { androidXmlSections, uikitSections } from "./nativeClassic";
import { DEFAULT_UNITS } from "./units";

const rgb = (hex: number, a = 1): Color => ({ r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255, a });

const card: NodeChange = {
  guid: "1:5",
  type: "FRAME",
  name: "Card",
  size: { x: 320, y: 200 },
  transform: { m00: 1, m01: 0, m02: 24, m10: 0, m11: 1, m12: 88 },
  stackMode: "VERTICAL",
  stackSpacing: 8,
  stackHorizontalPadding: 24,
  stackVerticalPadding: 16,
  stackPaddingRight: 24,
  stackPaddingBottom: 16,
  stackPrimarySizing: "RESIZE_TO_FIT",
  stackCounterSizing: "FIXED",
  cornerRadius: 8,
  fillPaints: [{ type: "SOLID", color: rgb(0xffffff), opacity: 1, visible: true }],
  strokePaints: [{ type: "SOLID", color: rgb(0xd9d9d9), opacity: 1, visible: true }],
  strokeWeight: 1,
  effects: [{ type: "DROP_SHADOW", color: rgb(0x000000, 0.25), offset: { x: 0, y: 4 }, radius: 4, spread: 0, visible: true }],
};

const heading: NodeChange = {
  guid: "1:6",
  type: "TEXT",
  name: "Heading",
  size: { x: 200, y: 30 },
  textAutoResize: "WIDTH_AND_HEIGHT",
  fontName: { family: "New Science", style: "Bold" },
  fontSize: 24,
  lineHeight: { value: 30, units: "PIXELS" },
  letterSpacing: { value: -2, units: "PERCENT" },
  textData: { characters: 'Say "hi"' },
  fillPaints: [{ type: "SOLID", color: rgb(0x231f20), opacity: 1, visible: true }],
};

describe("Dev Mode's values", () => {
  it("formats numbers and colours as Figma's CSS does (atlas 14 §5.1)", () => {
    expect(num(12)).toBe("12");
    expect(num(12.345)).toBe("12.35");
    expect(num(-0.001)).toBe("0");
    expect([px(12.3456), px(0), px(-0.0001), px(8)]).toEqual(["12.346px", "0", "0", "8px"]);
    expect(cssColor(rgb(0xffffff))).toBe("#FFF");
    expect(cssColor(rgb(0x0d99ff))).toBe("#0D99FF");
    expect(cssColor(rgb(0x000000, 0.25))).toBe("rgba(0, 0, 0, 0.25)");
    expect(cssColor(rgb(0xff0000), 0.5)).toBe("rgba(255, 0, 0, 0.50)");
    expect(cssColor(rgb(0xffffff, 0.999))).toBe("rgba(255, 255, 255, 1.00)");
  });

  it("names variables in CSS (case kept when valid, else kebab-case) and Swift / Kotlin, honouring code syntax", () => {
    expect(cssVariableName("Color/Primary 500")).toBe("--Color-Primary-500");
    expect(cssVariableName("Brand (new)")).toBe("--brand-new");
    expect(cssVariableName("Size.Large2")).toBe("--size-large-2");
    expect(cssVariableName("’’")).toBe("--unnamed");
    expect(camelName("brand/primary 500")).toBe("brandPrimary500");
    expect(camelName("Spacing/2XL")).toBe("Spacing2XL");
    expect(cssVar({ name: "Color/Primary" }, "#0D99FF")).toBe("var(--Color-Primary, #0D99FF)");
    expect(cssVar({ name: "x", codeSyntax: { WEB: "var(--brand-bg)" } }, "#000")).toBe("var(--brand-bg)");
    expect(cssVar({ name: "x", codeSyntax: { WEB: "--brand" } }, "#000")).toBe("--brand");
    expect(cssVar(undefined, "#000")).toBe("#000");
  });

  it("reads sizing, typography, types, gradient angles and aspect ratios", () => {
    expect(sizingOf({ node: card })).toEqual({ width: "Fixed", height: "Hug" });
    expect(sizingOf({ node: { ...card, stackChildPrimaryGrow: 1, stackChildAlignSelf: "STRETCH" }, parentStackMode: "HORIZONTAL" })).toEqual({ width: "Fill", height: "Fill" });
    expect(typographyOf(heading)).toMatchObject({ weight: 700, italic: false, lineHeightPx: 30, lineHeightPercent: 125, lineHeightUnit: "PIXELS", letterSpacingPx: -0.48 });
    expect(typeLabel(card)).toBe("Frame");
    expect(typeLabel({ ...card, resizeToFit: true })).toBe("Group");
    expect(gradientAngle({ type: "GRADIENT_LINEAR", transform: { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 } })).toBe(180);
    expect(gradientAngle({ type: "GRADIENT_LINEAR", transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 } })).toBe(90);
    // A diagonal in a wide box: the handles' direction in px, not in the unit square.
    expect(gradientAngle({ type: "GRADIENT_LINEAR", transform: { m00: 0.5, m01: 0.5, m02: 0, m10: -0.5, m11: 0.5, m12: 0.5 } }, { x: 200, y: 100 })).toBe(117);
    expect([aspectRatio(1920, 1080), aspectRatio(100, 100), aspectRatio(100, 33.3333)]).toEqual(["16/9", "1/1", "3/1"]);
    expect(aspectRatio(Math.PI * 1000, 1000)).toBe("333/106");
  });
});

describe("Dev Mode's CSS", () => {
  it("writes an auto layout frame in Figma's order, defaults dropped (no flex-direction: row), effects after the look", () => {
    expect(cssText({ node: card })).toBe(
      [
        "display: flex;",
        "width: 320px;",
        "padding: 16px 24px;",
        "flex-direction: column;",
        "align-items: flex-start;",
        "gap: 8px;",
        "",
        "border-radius: 8px;",
        "border: 1px solid #D9D9D9;",
        "background: #FFF;",
        "box-shadow: 0 4px 4px 0 rgba(0, 0, 0, 0.25);",
      ].join("\n"),
    );
    const row = cssSnippet({ node: { ...card, stackMode: "HORIZONTAL", stackPrimaryAlignItems: "CENTER", stackCounterAlignItems: "CENTER" } });
    expect(row.layout.map((d) => `${d.property}: ${d.value}`)).toEqual(["display: inline-flex", "height: 200px", "padding: 16px 24px", "justify-content: center", "align-items: center", "gap: 8px"]);
  });

  it("writes inline-flex for a hugging frame outside auto layout, one-sided padding, wrap gaps and align-content", () => {
    const hug = { ...card, stackMode: "HORIZONTAL" as const, stackPrimarySizing: "RESIZE_TO_FIT" as const, stackHorizontalPadding: 0, stackPaddingRight: 0, stackVerticalPadding: 0, stackPaddingBottom: 12 };
    const s = cssSnippet({ node: hug });
    expect(s.layout.map((d) => `${d.property}: ${d.value}`)).toEqual(["display: inline-flex", "height: 200px", "padding-bottom: 12px", "align-items: flex-start", "gap: 8px"]);
    expect(cssSnippet({ node: hug, parentStackMode: "VERTICAL" }).layout[0].value).toBe("flex");
    const wrap = cssSnippet({ node: { ...hug, stackWrap: "WRAP", stackCounterSpacing: 16 } }).layout.map((d) => `${d.property}: ${d.value}`);
    expect(wrap).toEqual(expect.arrayContaining(["align-content: flex-start", "gap: 16px 8px", "flex-wrap: wrap"]));
    expect(cssSnippet({ node: { ...hug, stackWrap: "WRAP", stackCounterSpacing: 16 }, childrenFill: true }).layout.some((d) => d.property === "align-content")).toBe(false);
    const between = cssSnippet({ node: { ...hug, stackWrap: "WRAP", stackCounterSpacing: 16, stackPrimaryAlignItems: "SPACE_EVENLY" } }).layout.map((d) => `${d.property}: ${d.value}`);
    expect(between).toEqual(expect.arrayContaining(["justify-content: space-between", "row-gap: 16px"]));
    expect(between.some((d) => d.startsWith("gap"))).toBe(false);
  });

  it("writes flex items: fill grows, a fixed child of a fixed parent doesn't shrink, counter fill stretches", () => {
    const child: NodeChange = { guid: "1:7", type: "ROUNDED_RECTANGLE", size: { x: 40, y: 40 } };
    const fixedParent = { type: "FRAME" as const, stackMode: "HORIZONTAL" as const, stackPrimarySizing: "FIXED" as const };
    expect(cssText({ node: child, parent: fixedParent })).toBe("width: 40px;\nheight: 40px;\nflex-shrink: 0;");
    expect(cssText({ node: child, parent: { ...fixedParent, stackPrimarySizing: "RESIZE_TO_FIT" } })).toBe("width: 40px;\nheight: 40px;");
    expect(cssText({ node: { ...child, stackChildPrimaryGrow: 1, stackChildAlignSelf: "STRETCH" }, parent: fixedParent })).toBe("flex: 1 0 0;\nalign-self: stretch;");
  });

  it("puts an absolute child's offsets in Position, with the hint naming its parent", () => {
    const sections = cssSections({ node: { guid: "1:8", type: "ROUNDED_RECTANGLE", size: { x: 20, y: 20 }, stackPositioning: "ABSOLUTE", transform: { m00: 1, m01: 0, m02: 12, m10: 0, m11: 1, m12: 0 }, horizontalConstraint: "MIN", verticalConstraint: "MAX" }, parent: { type: "FRAME", name: "Card", size: { x: 100, y: 60 }, stackMode: "VERTICAL" } });
    expect(sections.map((s) => s.name)).toEqual(["Layout", "Position"]);
    expect(sectionText(sections[1])).toBe("position: absolute;\nleft: 12px;\nbottom: 40px;");
    expect(sections[1].lines[1].hint).toEqual({ id: "absolute_position", params: { name: "Card" } });
  });

  it("writes variables as var(--name, fallback)", () => {
    const s = cssSnippet({ node: card, variables: { "fillPaints[0].color": { name: "Surface/Default" }, STACK_SPACING: { name: "Spacing/2" } } });
    expect(s.style.find((d) => d.property === "background")?.value).toBe("var(--Surface-Default, #FFF)");
    expect(s.layout.find((d) => d.property === "gap")?.value).toBe("var(--Spacing-2, 8px)");
  });

  it("writes a text's typography: colour first, then a blank line, its style's name and the font", () => {
    expect(cssText({ node: heading, styles: { text: "Heading 1" } })).toBe(
      ["color: #231F20;", "", "/* Heading 1 */", 'font-family: "New Science";', "font-size: 24px;", "font-style: normal;", "font-weight: 700;", "line-height: 30px; /* 125% */", "letter-spacing: -0.48px;"].join("\n"),
    );
    const auto = cssSnippet({ node: { ...heading, lineHeight: { value: 150, units: "PERCENT" }, fontName: { family: "Inter", style: "Medium Italic" } } });
    expect(auto.typography.map((d) => `${d.property}: ${d.value}`)).toContain("line-height: 150%");
    expect(auto.typography.find((d) => d.property === "line-height")?.comment).toBe("36px");
    expect(auto.typography.map((d) => `${d.property}: ${d.value}`)).toContain("font-style: italic");
    expect(auto.typography.map((d) => `${d.property}: ${d.value}`)).toContain("font-family: Inter");
  });

  it("writes truncation, line clamps, vertical alignment, leading trim, OpenType and underline details", () => {
    const body = { ...heading, textAutoResize: "NONE" as const, lineHeight: undefined, letterSpacing: undefined };
    const truncate = cssSnippet({ node: { ...body, textTruncation: "ENDING" } });
    expect(truncate.typography.map((d) => d.property)).toEqual(expect.arrayContaining(["text-overflow", "white-space", "overflow"]));
    const clamp = cssSnippet({ node: { ...body, textTruncation: "ENDING", maxLines: 2 } });
    expect(clamp.layout.map((d) => `${d.property}: ${d.value}`)).toEqual(["display: -webkit-box", "width: 200px", "height: 30px", "-webkit-box-orient: vertical", "-webkit-line-clamp: 2"]);
    const centred = cssSnippet({ node: { ...body, textAlignVertical: "CENTER" } });
    expect(centred.layout.map((d) => `${d.property}: ${d.value}`)).toEqual(["display: flex", "width: 200px", "height: 30px", "flex-direction: column", "justify-content: center"]);
    const fancy = cssSections({ node: { ...body, leadingTrim: "CAP_HEIGHT", toggledOnOTFeatures: ["TNUM", "SS01"], toggledOffOTFeatures: ["KERN"], textDecoration: "UNDERLINE", textDecorationStyle: "WAVY" } as NodeChange });
    const text = sectionText(fancy.find((s) => s.name === "Typography")!);
    expect(text).toContain("leading-trim: both;\ntext-edge: cap;\nfont-kerning: none;\nfont-variant-numeric: tabular-nums;\nfont-feature-settings: 'ss01' on;");
    expect(text).toContain("text-decoration-line: underline;\ntext-decoration-style: wavy;\ntext-decoration-skip-ink: auto;\ntext-decoration-thickness: auto;\ntext-underline-offset: auto;\ntext-underline-position: from-font;");
    expect(fancy.find((s) => s.name === "Typography")!.lines.find((l) => l.code.startsWith("leading-trim"))?.hint?.id).toBe("leading_trim");
  });

  it("writes gradient text with background-clip, and a text run styled apart as its own section", () => {
    const gradient = cssSnippet({ node: { ...heading, fillPaints: [{ type: "GRADIENT_LINEAR", visible: true, stops: [{ color: rgb(0xff0000), position: 0 }, { color: rgb(0x0000ff), position: 1 }] }] } });
    expect(gradient.style.map((d) => `${d.property}: ${d.value}`)).toEqual(["background: linear-gradient(90deg, #F00 0%, #00F 100%)", "background-clip: text", "-webkit-background-clip: text", "-webkit-text-fill-color: transparent"]);
    const runs = cssSections({ node: { ...heading, textData: { characters: "Hello brave world", characterStyleIDs: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1], styleOverrideTable: [{ styleID: 1, fontName: { family: "New Science", style: "Regular" } }] } } });
    expect(runs.map((s) => s.name)).toEqual(["Typography", "brave"]);
    expect(sectionText(runs[1])).toContain("font-weight: 400;");
  });

  it("lists the paints top first (upper solids as gradients), effects in reverse, blends and blurs", () => {
    const rect: NodeChange = {
      guid: "1:9",
      type: "ROUNDED_RECTANGLE",
      size: { x: 100, y: 50 },
      transform: { m00: Math.cos(Math.PI / 4), m01: -Math.sin(Math.PI / 4), m02: 0, m10: Math.sin(Math.PI / 4), m11: Math.cos(Math.PI / 4), m12: 0 },
      opacity: 0.5,
      blendMode: "LINEAR_BURN",
      fillPaints: [
        { type: "SOLID", visible: true, color: rgb(0xffffff) },
        { type: "IMAGE", visible: true, imageScaleMode: "FIT" },
        { type: "SOLID", visible: true, color: rgb(0x000000), opacity: 0.2 },
      ],
      effects: [
        { type: "DROP_SHADOW", color: rgb(0x000000, 0.25), offset: { x: 0, y: 4 }, radius: 4, visible: true },
        { type: "INNER_SHADOW", color: rgb(0x000000, 0.5), offset: { x: 1, y: 1 }, radius: 2, visible: true },
        { type: "FOREGROUND_BLUR", radius: 5, visible: true },
      ],
    };
    const s = cssSections({ node: rect });
    const style = sectionText(s.find((x) => x.name === "Style")!);
    expect(style).toBe(
      [
        "opacity: 0.5;",
        "background: linear-gradient(0deg, rgba(0, 0, 0, 0.20) 0%, rgba(0, 0, 0, 0.20) 100%), url(<path-to-image>) lightgray 50% / contain no-repeat, #FFF;",
        "mix-blend-mode: plus-darker;",
        "box-shadow: 1px 1px 2px 0 rgba(0, 0, 0, 0.50) inset, 0 4px 4px 0 rgba(0, 0, 0, 0.25);",
        "filter: blur(2.5px);",
      ].join("\n"),
    );
    expect(s.find((x) => x.name === "Style")!.lines[2].hint?.id).toBe("plus_darker");
    expect(sectionText(s[0])).toContain("transform: rotate(45deg);");
    expect(cssSnippet({ node: { ...rect, effects: [], fillPaints: [{ type: "GRADIENT_RADIAL", visible: true, stops: [{ color: rgb(0xffffff), position: 0 }] }] } }).style.find((d) => d.property === "background")?.value).toBe("radial-gradient(50% 50% at 50% 50%, #FFF 0%)");
  });

  it("writes a vector's paints as fill and stroke, a group's drop shadow as a filter, and an effect style's comment", () => {
    const vector: NodeChange = { guid: "1:10", type: "VECTOR", size: { x: 24, y: 24 }, fillPaints: [{ type: "SOLID", visible: true, color: rgb(0x0d99ff) }], strokePaints: [{ type: "SOLID", visible: true, color: rgb(0x000000) }], strokeWeight: 2, effects: [{ type: "DROP_SHADOW", color: rgb(0x000000, 0.25), offset: { x: 0, y: 1 }, radius: 2, visible: true }] };
    expect(cssText({ node: vector, styles: { effect: "Shadow/Small" } })).toBe(["width: 24px;", "height: 24px;", "", "stroke-width: 2px;", "stroke: #000;", "fill: #0D99FF;", "", "/* Shadow/Small */", "filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.25));"].join("\n"));
  });

  it("raises hints for extra paints and borders an auto layout doesn't count", () => {
    const s = cssSections({ node: { ...card, strokePaints: [...card.strokePaints!, { type: "SOLID", color: rgb(0xff0000), visible: true }] } });
    expect(s.find((x) => x.name === "Style")!.lines.find((l) => l.code.startsWith("border:"))?.hint?.id).toBe("single_paint");
    expect(cssSections({ node: card }).find((x) => x.name === "Style")!.lines.find((l) => l.code.startsWith("border:"))?.hint?.id).toBe("borders_dont_take_up_space");
    expect(cssSections({ node: { ...card, bordersTakeSpace: true } as NodeChange }).find((x) => x.name === "Style")!.lines.find((l) => l.code.startsWith("border:"))?.hint).toBeUndefined();
  });
});

describe("Dev Mode's iOS and Android code", () => {
  it("writes SwiftUI's view line and modifiers in Figma's order", () => {
    const [s] = swiftUISections({ node: card });
    expect(s.name).toBe("VStack");
    expect(sectionText(s)).toBe(
      [
        "VStack(alignment: .leading, spacing: 8) { ... }",
        ".padding(.horizontal, 24)",
        ".padding(.vertical, 16)",
        ".frame(width: 320, alignment: .topLeading)",
        ".background(.white)",
        ".cornerRadius(8)",
        ".shadow(color: .black.opacity(0.25), radius: 2, x: 0, y: 4)",
        ".overlay(",
        "  RoundedRectangle(cornerRadius: 8)",
        "    .inset(by: 0.5)",
        "    .stroke(Color(red: 0.85, green: 0.85, blue: 0.85), lineWidth: 1)",
        ")",
      ].join("\n"),
    );
    expect(swiftColor(rgb(0x0d99ff), 0.5)).toBe("Color(red: 0.05, green: 0.6, blue: 1).opacity(0.5)");
  });

  it("writes SwiftUI text one level in, its font over lines, kerning only when positive", () => {
    const [s] = swiftUISections({ node: heading, styles: { text: "Heading 1" } });
    expect(sectionText(s)).toBe(['// Heading 1', 'Text("Say \\"hi\\"")', "  .font(", '    Font.custom("New Science", size: 24)', "      .weight(.bold)", "  )", "  .foregroundColor(Color(red: 0.14, green: 0.12, blue: 0.13))"].join("\n"));
    expect(sectionText(swiftUISections({ node: { ...heading, letterSpacing: { value: 1, units: "PIXELS" } } })[0])).toContain("  .kerning(1)");
  });

  it("lists SwiftUI's bound variables as Constants, code syntax verbatim", () => {
    const sections = swiftUISections({ node: card, variables: { "fillPaints[0].color": { name: "Surface/Default" }, STACK_SPACING: { name: "spacing/md", codeSyntax: { iOS: "Spacing.md" } } } });
    expect(sectionText(sections[0])).toContain("VStack(alignment: .leading, spacing: Spacing.md) { ... }");
    expect(sectionText(sections[0])).toContain(".background(Constants.SurfaceDefault)");
    expect(sections[1].name).toBe("Variables");
    expect(sectionText(sections[1])).toBe("struct Constants {\n  static let SurfaceDefault: Color = .white\n}");
  });

  it("writes SwiftUI's space-between stacks with spacers and its hints", () => {
    const [s] = swiftUISections({ node: { ...card, stackMode: "HORIZONTAL", stackPrimaryAlignItems: "SPACE_EVENLY", rectangleCornerRadiiIndependent: true, rectangleTopLeftCornerRadius: 8, rectangleBottomRightCornerRadius: 4 } });
    expect(s.lines[0]).toMatchObject({ code: "HStack(alignment: .top) {", hint: { id: "swift_ui_spacers_for_space_between" } });
    expect(s.lines[1].code).toBe("// Space Between");
    expect(s.lines.find((l) => l.code.startsWith(".cornerRadius"))).toMatchObject({ code: ".cornerRadius(8)", hint: { id: "swift_ui_separate_corner_radius" } });
  });

  it("writes Compose's Modifier (padding last), Layout stub, Text and Variables", () => {
    const sections = composeSections({ node: card });
    expect(sections.map((s) => s.name)).toEqual(["Modifier", "Layout"]);
    expect(sectionText(sections[0])).toBe(
      [
        "Modifier",
        "  .shadow(elevation = 4.dp, spotColor = Color(0x40000000), ambientColor = Color(0x40000000))",
        "  .border(width = 1.dp, color = Color(0xFFD9D9D9), shape = RoundedCornerShape(size = 8.dp))",
        "  .width(320.dp)",
        "  .height(200.dp)",
        "  .background(color = Color(0xFFFFFFFF), shape = RoundedCornerShape(size = 8.dp))",
        "  .padding(start = 24.dp, top = 16.dp, end = 24.dp, bottom = 16.dp)",
      ].join("\n"),
    );
    expect(sectionText(sections[1])).toBe(["Column(", "  verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.Top),", "  horizontalAlignment = Alignment.Start,", ") {", "  // Child views.", "}"].join("\n"));
    const text = composeSections({ node: heading, styles: { text: "Heading 1" } }).find((s) => s.name === "Text")!;
    expect(sectionText(text)).toBe(
      ["Text(", '  text = "Say \\"hi\\"",', "  ", "  // Heading 1", "  style = TextStyle(", "    fontSize = 24.sp,", "    lineHeight = 30.sp,", "    fontFamily = FontFamily(Font(R.font.new_science)),", "    fontWeight = FontWeight(700),", "    color = Color(0xFF231F20),", "  )", ")"].join("\n"),
    );
    const bound = composeSections({ node: card, variables: { STACK_SPACING: { name: "Spacing/2" } } });
    expect(sectionText(bound[1])).toContain("Arrangement.spacedBy(Variables.Spacing2, Alignment.Top)");
    expect(sectionText(bound[2])).toBe("object Variables {\n  val Spacing2: Dp = 8.dp\n}");
  });

  it("writes UIKit and Android XML with the 'not yet supported' line, XML indented by its tags", () => {
    const [ui] = uikitSections({ node: card });
    expect(ui.lines[0].code).toBe("// Auto layout, grids, variables, and unit scale are not yet supported");
    expect(sectionText(ui)).toContain("view.layer.cornerRadius = 8");
    expect(sectionText(ui)).toContain("view.widthAnchor.constraint(equalToConstant: 320).isActive = true");
    const xml = androidXmlSections({ node: heading });
    expect(xml.map((s) => s.name)).toEqual(["TextView", "Style"]);
    expect(xml[0].lines.slice(0, 3).map((l) => [l.code, l.indent])).toEqual([
      ["<!-- Auto layout, grids, variables, and unit scale are not yet supported -->", 0],
      ["<TextView", 0],
      ['android:id="@+id/heading"', 1],
    ]);
    expect(xml[0].lines.at(-1)!.indent).toBe(0);
    expect(sectionText(xml[1])).toContain('<item name="android:textSize">24sp</item>');
  });

  it("collapses a section after 15 lines and converts units per language", () => {
    expect(cssSections({ node: card }).every((s) => s.collapseAfterIndex === 15)).toBe(true);
    const rem = { ...DEFAULT_UNITS, unit: { ...DEFAULT_UNITS.unit, css: "rem" as const } };
    expect(sectionText(codeSections({ node: card }, "css", rem)[0])).toContain("padding: 1rem 1.5rem;");
    expect(sectionText(codeSections({ node: card }, "css", rem)[1])).toContain("border: 1px solid #D9D9D9;");
    const pt = { ...DEFAULT_UNITS, scale: { ...DEFAULT_UNITS.scale, swiftui: 2 } };
    expect(sectionText(codeSections({ node: card }, "swiftui", pt)[0])).toContain(".frame(width: 160, alignment: .topLeading)");
    expect(sectionText(codeSections({ node: card }, "uikit", pt)[0])).toContain("equalToConstant: 320)");
  });
});

describe("measurements", () => {
  const s = { x: 100, y: 100, width: 100, height: 50 };
  it("measures the gaps to a layer beside or below", () => {
    expect(redlines(s, { x: 260, y: 110, width: 40, height: 20 })).toEqual([{ x1: 200, y1: 120, x2: 260, y2: 120, value: 60 }]);
    expect(redlines(s, { x: 100, y: 180, width: 100, height: 10 })).toEqual([{ x1: 150, y1: 150, x2: 150, y2: 180, value: 30 }]);
  });
  it("measures from the inside of a container, and nothing for the same box", () => {
    const lines = redlines(s, { x: 0, y: 0, width: 300, height: 300 });
    expect(lines.map((l) => l.value)).toEqual([100, 150, 100, 100]);
    expect(redlines(s, { ...s })).toEqual([]);
  });
  it("adds a dashed guide when the two don't overlap on the other axis", () => {
    const lines = redlines(s, { x: 300, y: 300, width: 10, height: 10 });
    expect(lines.filter((l) => !l.guide).map((l) => l.value)).toEqual([100, 150]);
    expect(lines.some((l) => l.guide)).toBe(true);
  });
});
