import { describe, expect, it } from "vitest";
import type { Color, NodeChange } from "@/engine/codec";
import { cssSnippet, cssText } from "./css";
import { redlines } from "./measure";
import { cssColor, cssVar, cssVariableName, gradientAngle, num, sizingOf, typeLabel, typographyOf } from "./model";
import { compose, swiftUI } from "./native";

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
  it("formats numbers and colours as Dev Mode does", () => {
    expect(num(12)).toBe("12");
    expect(num(12.345)).toBe("12.35");
    expect(num(-0.001)).toBe("0");
    expect(cssColor(rgb(0xffffff))).toBe("#FFF");
    expect(cssColor(rgb(0x0d99ff))).toBe("#0D99FF");
    expect(cssColor(rgb(0x000000, 0.25))).toBe("rgba(0, 0, 0, 0.25)");
    expect(cssColor(rgb(0xff0000), 0.5)).toBe("rgba(255, 0, 0, 0.5)");
  });

  it("names variables in CSS, honouring their Web code syntax", () => {
    expect(cssVariableName("Color/Primary 500")).toBe("--Color-Primary-500");
    expect(cssVar({ name: "Color/Primary" }, "#0D99FF")).toBe("var(--Color-Primary, #0D99FF)");
    expect(cssVar({ name: "x", codeSyntax: { WEB: "--brand" } }, "#000")).toBe("var(--brand, #000)");
    expect(cssVar({ name: "x", codeSyntax: { WEB: "var(--brand-bg)" } }, "#000")).toBe("var(--brand-bg)");
    expect(cssVar(undefined, "#000")).toBe("#000");
  });

  it("reads sizing, typography, types and gradient angles", () => {
    expect(sizingOf({ node: card })).toEqual({ width: "Fixed", height: "Hug" });
    expect(sizingOf({ node: { ...card, stackChildPrimaryGrow: 1, stackChildAlignSelf: "STRETCH" }, parentStackMode: "HORIZONTAL" })).toEqual({ width: "Fill", height: "Fill" });
    expect(typographyOf(heading)).toMatchObject({ weight: 700, italic: false, lineHeightPx: 30, lineHeightPercent: 125, letterSpacingPx: -0.48 });
    expect(typeLabel(card)).toBe("Frame");
    expect(typeLabel({ ...card, resizeToFit: true })).toBe("Group");
    expect(gradientAngle({ type: "GRADIENT_LINEAR", transform: { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 } })).toBe(180);
    expect(gradientAngle({ type: "GRADIENT_LINEAR", transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 } })).toBe(90);
  });
});

describe("Dev Mode's CSS", () => {
  it("writes an auto layout frame as a flex container, in Figma's order", () => {
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
        "box-shadow: 0px 4px 4px 0px rgba(0, 0, 0, 0.25);",
      ].join("\n"),
    );
  });

  it("writes variables as var(--name, fallback)", () => {
    const s = cssSnippet({ node: card, variables: { "fillPaints[0].color": { name: "Surface/Default" }, STACK_SPACING: { name: "Spacing/2" } } });
    expect(s.style.find((d) => d.property === "background")?.value).toBe("var(--Surface-Default, #FFF)");
    expect(s.layout.find((d) => d.property === "gap")?.value).toBe("var(--Spacing-2, 8px)");
  });

  it("writes a text's typography with its style's name and the line height's percentage", () => {
    expect(cssText({ node: heading, styles: { text: "Heading 1" } })).toBe(
      ["/* Heading 1 */", "color: #231F20;", 'font-family: "New Science";', "font-size: 24px;", "font-style: normal;", "font-weight: 700;", "line-height: 30px; /* 125% */", "letter-spacing: -0.48px;"].join("\n"),
    );
    const auto = cssSnippet({ node: { ...heading, lineHeight: undefined, fontName: { family: "Inter", style: "Medium Italic" } } });
    expect(auto.typography.map((d) => `${d.property}: ${d.value}`)).toContain("line-height: normal");
    expect(auto.typography.map((d) => `${d.property}: ${d.value}`)).toContain("font-style: italic");
    expect(auto.typography.map((d) => `${d.property}: ${d.value}`)).toContain("font-family: Inter");
  });

  it("writes flex items, rotation, opacity, gradients, images and blurs", () => {
    const rect: NodeChange = {
      guid: "1:9",
      type: "ROUNDED_RECTANGLE",
      size: { x: 100, y: 50 },
      transform: { m00: Math.cos(Math.PI / 4), m01: -Math.sin(Math.PI / 4), m02: 0, m10: Math.sin(Math.PI / 4), m11: Math.cos(Math.PI / 4), m12: 0 },
      opacity: 0.5,
      fillPaints: [
        { type: "IMAGE", visible: true, imageScaleMode: "FILL" },
        { type: "GRADIENT_LINEAR", visible: true, transform: { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 }, stops: [{ color: rgb(0xffffff), position: 0 }, { color: rgb(0x000000), position: 1 }] },
      ],
      effects: [{ type: "FOREGROUND_BLUR", radius: 8, visible: true }],
    };
    const text = cssText({ node: rect, parentStackMode: "HORIZONTAL" });
    expect(text).toContain("flex-shrink: 0;");
    expect(text).toContain("transform: rotate(45deg);");
    expect(text).toContain("opacity: 0.5;");
    expect(text).toContain("background: linear-gradient(180deg, #FFF 0%, #000 100%), url(<path-to-image>) lightgray 50% / cover no-repeat;");
    expect(text).toContain("filter: blur(4px);");
  });
});

describe("Dev Mode's iOS and Android snippets", () => {
  it("writes SwiftUI stacks, shapes and text", () => {
    const s = swiftUI({ node: card });
    expect(s.split("\n")[0]).toBe("VStack(alignment: .leading, spacing: 8) { // Child views... }");
    expect(s).toContain(".padding(.horizontal, 24)");
    expect(s).toContain(".padding(.vertical, 16)");
    expect(s).toContain(".frame(width: 320, alignment: .topLeading)");
    expect(s).toContain(".background(Color(red: 1, green: 1, blue: 1))");
    expect(s).toContain(".cornerRadius(8)");
    expect(swiftUI({ node: heading })).toContain('Text("Say \\"hi\\"")');
    expect(swiftUI({ node: card, variables: { "fillPaints[0].color": { name: "Surface/Default" } } })).toContain('.background(Color("surfaceDefault"))');
  });

  it("writes Compose layouts, boxes and text", () => {
    const c = compose({ node: card });
    expect(c.startsWith("Column(\n  verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.Top),\n  horizontalAlignment = Alignment.Start,")).toBe(true);
    expect(c).toContain(".width(320.dp)");
    expect(c).toContain(".background(color = Color(0xFFFFFFFF), shape = RoundedCornerShape(size = 8.dp))");
    expect(c).toContain(".padding(start = 24.dp, top = 16.dp, end = 24.dp, bottom = 16.dp)");
    expect(c).toContain("// Child views.");
    const t = compose({ node: heading });
    expect(t).toContain('text = "Say \\"hi\\""');
    expect(t).toContain("fontSize = 24.sp");
    expect(t).toContain("fontWeight = FontWeight(700)");
    expect(t).toContain("color = Color(0xFF231F20)");
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
