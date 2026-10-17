// Variables, modes and styles as plain data (model/variables.ts, model/styles.ts): values and aliases, resolution in
// the consumer's modes, cycles, groups and names, positions, scopes, bindings and their resolved copies, styles.
import { describe, expect, it } from "vitest";
import {
  aliasMakesCycle,
  BIND_TYPE,
  bindingWarning,
  bindTypes,
  boundPaint,
  canExtend,
  cleanName,
  LIMITS,
  SCOPE_OPTIONS,
  stripNumber,
  detachedPaint,
  explicitModes,
  formatLiteral,
  fromData,
  groupTree,
  inGroup,
  lookupOf,
  modeAt,
  nextModeName,
  nextName,
  paintVariable,
  positionAfter,
  positionBetween,
  readCollection,
  readVariable,
  renameGroupIn,
  resolveVariable,
  resolvedFields,
  scopeAllows,
  scopeChecked,
  splitName,
  toData,
  toggleScope,
  validVariableName,
  valueIn,
  variableBindings,
  withExplicitMode,
  withValue,
  withVariableBinding,
  type VNode,
} from "../model/variables";
import { applyStyleFields, isStyleNode, readStyle, styleContent, styleFieldsFrom, styleIdOf, styleLeaf, textStyleSummary } from "../model/styles";
import { parseColorText } from "../panels/variables/ValueEditor";

const g = (l: number) => ({ sessionID: 1, localID: l });
const collection = (id: string, modes: [number, string, string][]): VNode => ({ guid: id, type: "VARIABLE_SET", name: id, variableSetModes: modes.map(([l, name, sortPosition]) => ({ id: g(l), name, sortPosition })) });
const variable = (id: string, set: number, type: string, values: [number, unknown][], name = id): VNode => ({
  guid: id,
  type: "VARIABLE",
  name,
  variableSetID: { guid: g(set) },
  variableResolvedType: type,
  variableDataValues: { entries: values.map(([m, d]) => ({ modeID: g(m), variableData: d as never })) },
});
const color = (r: number, gg: number, b: number, a = 1) => ({ dataType: "COLOR", resolvedDataType: "COLOR", value: { colorValue: { r, g: gg, b, a } } });
const alias = (l: number, type = "COLOR") => ({ dataType: "ALIAS", resolvedDataType: type, value: { alias: { guid: g(l) } } });

describe("variables (pure)", () => {
  // Primitives (one mode) and Theme (Light first by sortPosition, then Dark — listed out of order on purpose).
  const prim = readCollection(collection("1:1", [[100, "Value", "a"]]));
  const theme = readCollection(collection("1:2", [[201, "Dark", "b"], [200, "Light", "a"]]));
  const white = readVariable(variable("1:10", 1, "COLOR", [[100, color(1, 1, 1)]], "color/white"));
  const black = readVariable(variable("1:11", 1, "COLOR", [[100, color(0, 0, 0)]], "color/black"));
  const bg = readVariable(variable("1:20", 2, "COLOR", [[200, alias(10)], [201, alias(11)]], "bg/primary"));
  const fg = readVariable(variable("1:21", 2, "COLOR", [[200, alias(20)]], "fg/primary"));
  const lookup = lookupOf([prim, theme], [white, black, bg, fg]);

  it("reads collections (default mode = first by sortPosition) and values", () => {
    expect(theme.modes.map((m) => m.name)).toEqual(["Light", "Dark"]);
    expect(theme.defaultMode).toBe("1:200");
    expect(bg.values.get("1:201")).toEqual({ kind: "alias", id: "1:11" });
    expect(fromData({ dataType: "FLOAT", resolvedDataType: "FLOAT", value: {} })).toEqual({ kind: "literal", value: 0 });
    // A mode without its own value falls back to the default mode's.
    expect(valueIn(fg, "1:201", theme)).toEqual({ kind: "alias", id: "1:20" });
    expect(toData("FLOAT", { kind: "literal", value: 4 })).toEqual({ dataType: "FLOAT", resolvedDataType: "FLOAT", value: { floatValue: 4 } });
    expect(withValue(white, "1:100", { kind: "literal", value: { r: 0, g: 0, b: 1, a: 1 } }).entries).toHaveLength(1);
  });

  it("resolves aliases in the consumer's mode of each collection; cycles and missing targets are unresolved", () => {
    expect(resolveVariable("1:20", lookup)).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(resolveVariable("1:20", lookup, (c) => (c === "1:2" ? "1:201" : undefined))).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    // fg → bg → black in Dark (fg has no Dark value: its Light alias is used, read in Dark further down the chain).
    expect(resolveVariable("1:21", lookup, (c) => (c === "1:2" ? "1:201" : undefined))).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    const a = readVariable(variable("1:30", 1, "FLOAT", [[100, alias(31, "FLOAT")]]));
    const b = readVariable(variable("1:31", 1, "FLOAT", [[100, alias(30, "FLOAT")]]));
    const loop = lookupOf([prim], [a, b]);
    expect(resolveVariable("1:30", loop)).toBeNull();
    expect(resolveVariable("1:99", loop)).toBeNull();
    expect(aliasMakesCycle("1:10", "1:20", lookup)).toBe(true); // bg aliases white
    expect(aliasMakesCycle("1:21", "1:21", lookup)).toBe(true); // itself
    expect(aliasMakesCycle("1:10", "1:11", lookup)).toBe(false);
  });

  it("modes on nodes: nearest explicit one up to the page, else the default; set and cleared", () => {
    const frame = { variableModeBySetMap: { entries: [{ variableSetID: { guid: g(2) }, variableModeID: g(201) }] } };
    expect(explicitModes(frame).get("1:2")).toBe("1:201");
    expect(modeAt([{}, frame, {}], theme)).toBe("1:201");
    expect(modeAt([{}], theme)).toBe("1:200");
    // A mode that no longer exists is ignored.
    expect(modeAt([{ variableModeBySetMap: { entries: [{ variableSetID: { guid: g(2) }, variableModeID: g(999) }] } }], theme)).toBe("1:200");
    expect(withExplicitMode(frame, "1:2", null).entries).toEqual([]);
    expect(withExplicitMode({}, "1:2", "1:200").entries).toEqual([{ variableSetID: { guid: g(2) }, variableModeID: g(200) }]);
    expect(nextModeName(theme)).toBe("Mode 3");
  });

  it("names: groups are slash paths, cleaned; the group tree; renaming a group; free names", () => {
    expect(cleanName(" color / bg //primary ")).toBe("color/bg/primary");
    expect(splitName("color/bg/primary")).toEqual({ group: "color/bg", leaf: "primary" });
    expect(inGroup("color/bg/primary", "color")).toBe(true);
    expect(inGroup("colorful", "color")).toBe(false);
    const tree = groupTree(["color/bg/a", "color/bg/b", "color/fg", "space"]);
    expect(tree.map((t) => [t.path, t.count])).toEqual([["color", 3]]);
    expect(tree[0].children.map((t) => [t.path, t.count])).toEqual([["color/bg", 2]]);
    expect(renameGroupIn("color/bg/a", "color/bg", "brand")).toBe("brand/a");
    expect(renameGroupIn("space", "color", "x")).toBeNull();
    expect(nextName("Color", ["Color", "Color 2"])).toBe("Color 3");
    expect(validVariableName("a.b")).toBeNull();
    expect(validVariableName("{x}")).toBeNull();
    expect(validVariableName(" a / b ")).toBe("a/b");
  });

  it("fractional positions sort between their neighbours", () => {
    const a = positionBetween("", null);
    const b = positionBetween(a, null);
    const mid = positionBetween(a, b);
    expect(a < mid && mid < b).toBe(true);
    expect(positionBetween("", "!") < "!" || positionBetween("", "!") > "").toBe(true);
    const tight = positionBetween("a", "b");
    expect("a" < tight && tight < "b").toBe(true);
    expect(positionAfter(["a", "c", "b"]) > "c").toBe(true);
    let lo = "a";
    for (let i = 0; i < 20; i++) {
      const next = positionBetween(lo, "b");
      expect(next > lo && next < "b").toBe(true);
      lo = next;
    }
  });

  it("scopes: absent = all; Fill covers its three; toggling collapses to all and splits Fill", () => {
    expect(scopeAllows(null, "GAP")).toBe(true);
    expect(scopeAllows([], "GAP")).toBe(false);
    expect(scopeAllows(["ALL_FILLS"], "TEXT_FILL")).toBe(true);
    expect(scopeAllows(["STROKE"], "FRAME_FILL")).toBe(false);
    expect(toggleScope("FLOAT", null, "GAP", false)).not.toContain("GAP");
    expect(toggleScope("FLOAT", ["GAP"], "ALL_SCOPES", true)).toEqual(["ALL_SCOPES"]);
    const noText = toggleScope("COLOR", ["ALL_FILLS"], "TEXT_FILL", false);
    expect(noText).toEqual(["FRAME_FILL", "SHAPE_FILL"]);
    expect(toggleScope("COLOR", noText, "TEXT_FILL", true)).toEqual(["ALL_FILLS"]);
    expect(scopeChecked(["ALL_FILLS"], "SHAPE_FILL")).toBe(true);
  });

  it("bindings: entries kept apart from component properties; the resolved copy of each field", () => {
    const node = { parameterConsumptionMap: { entries: [{ variableField: "VISIBLE", variableData: { dataType: "PROP_REF", value: { propRefValue: { defId: g(1) } } } }] } };
    const bound = { parameterConsumptionMap: withVariableBinding(node as never, "CORNER_RADIUS", { id: "1:30", type: "FLOAT" }) };
    expect(bound.parameterConsumptionMap.entries).toHaveLength(2);
    expect(variableBindings(bound as never)).toEqual(new Map([["CORNER_RADIUS", "1:30"]]));
    expect(withVariableBinding(bound as never, "CORNER_RADIUS", null).entries).toHaveLength(1);
    expect(resolvedFields("OPACITY", 150, {})).toEqual({ opacity: 1 });
    expect(resolvedFields("OPACITY", 40, {})).toEqual({ opacity: 0.4 });
    expect(resolvedFields("WIDTH", 120, { size: { x: 10, y: 20 } })).toEqual({ size: { x: 120, y: 20 } });
    expect(resolvedFields("RECTANGLE_TOP_LEFT_CORNER_RADIUS", 6, {})).toEqual({ rectangleTopLeftCornerRadius: 6, rectangleCornerRadiiIndependent: true });
    expect(resolvedFields("STACK_PADDING_LEFT", 12, {})).toEqual({ stackHorizontalPadding: 12 });
    expect(resolvedFields("LINE_HEIGHT", 24, {})).toEqual({ lineHeight: { value: 24, units: "PIXELS" } });
    expect(resolvedFields("FONT_FAMILY", "Roboto", { fontName: { family: "Inter", style: "Bold" } })).toEqual({ fontName: { family: "Roboto", style: "Bold", postscript: "" } });
    expect(resolvedFields("VISIBLE", "x", {})).toBeNull();
  });

  it("paints: bound to a colour variable keep their colour when detached", () => {
    const p = boundPaint({ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }, "1:10", { r: 0, g: 0.5, b: 1, a: 0.5 });
    expect(paintVariable(p)).toBe("1:10");
    expect(p.color).toEqual({ r: 0, g: 0.5, b: 1, a: 0.5 });
    const d = detachedPaint(p);
    expect(paintVariable(d)).toBeNull();
    expect(d.color).toEqual(p.color);
  });

  it("formats values as the table shows them; parses typed colours", () => {
    expect(formatLiteral("COLOR", { r: 13 / 255, g: 153 / 255, b: 1, a: 1 })).toBe("0D99FF");
    expect(formatLiteral("COLOR", { r: 0, g: 0, b: 0, a: 0.5 })).toBe("000000 50%");
    expect(formatLiteral("FLOAT", 1.23456)).toBe("1.23");
    expect(formatLiteral("BOOLEAN", true)).toBe("true");
    expect(parseColorText("0d99ff")).toEqual({ r: 13 / 255, g: 153 / 255, b: 1, a: 1 });
    expect(parseColorText("#fff 50%")).toEqual({ r: 1, g: 1, b: 1, a: 0.5 });
    expect(parseColorText("nope")).toBeNull();
  });
});

describe("styles (pure)", () => {
  const fill = readStyle({ guid: "6:1", type: "ROUNDED_RECTANGLE", name: "Brand/Primary", styleType: "FILL", sortPosition: "a", fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 1, a: 1 }, opacity: 1, visible: true }] });
  const text = readStyle({ guid: "6:2", type: "TEXT", name: "Heading/H1", styleType: "TEXT", fontName: { family: "Inter", style: "Bold" }, fontSize: 32, lineHeight: { value: 40, units: "PIXELS" }, textAlignHorizontal: "CENTER" });

  it("reads style nodes and what each slot takes from them", () => {
    expect(isStyleNode({ styleType: "FILL" })).toBe(true);
    expect(isStyleNode({ styleType: "NONE" })).toBe(false);
    expect(styleContent(fill, "stroke")).toEqual({ strokePaints: fill.node.fillPaints });
    // A text style never carries alignment.
    expect(Object.keys(styleContent(text, "text")).sort()).toEqual(["fontName", "fontSize", "lineHeight"]);
    expect(applyStyleFields(fill, "fill")).toMatchObject({ styleIdForFill: { guid: { sessionID: 6, localID: 1 } } });
    expect(styleIdOf({ styleIdForText: { guid: { sessionID: 6, localID: 2 } } }, "text")).toBe("6:2");
    expect(styleIdOf({ styleIdForText: {} }, "text")).toBeNull();
    expect(textStyleSummary(text.node)).toBe("32/40");
    expect(textStyleSummary({ guid: "x", fontSize: 14, lineHeight: { value: 1.5, units: "RAW" } })).toBe("14/150%");
    expect(styleLeaf("Brand/Primary")).toBe("Primary");
  });

  it("a new style takes a layer's look, else Figma's defaults", () => {
    expect(styleFieldsFrom("FILL", null)).toMatchObject({ fillPaints: [{ type: "SOLID" }] });
    expect(styleFieldsFrom("EFFECT", { effects: [{ type: "INNER_SHADOW" }] } as never)).toEqual({ effects: [{ type: "INNER_SHADOW" }] });
    expect(styleFieldsFrom("TEXT", { fontSize: 20 } as never)).toMatchObject({ fontSize: 20, textData: { characters: "Ag" } });
  });
});

describe("variables (atlas 11, wave 3)", () => {
  it("names: Figma's \"Name 2\" — one past the largest number; duplicates numbered from the name without its number", () => {
    expect(nextName("Color", [])).toBe("Color");
    expect(nextName("Color", ["Color"])).toBe("Color 2");
    expect(nextName("Color", ["Color", "Color 7", "Color 3"])).toBe("Color 8");
    expect(nextName("Color", ["Color", "Color 2a", "Colorful 9"])).toBe("Color 2");
    expect(stripNumber("Color 3")).toBe("Color");
    expect(stripNumber("Grey900")).toBe("Grey900");
    expect(stripNumber("12")).toBe("12");
    expect(nextName(stripNumber("Color 7"), ["Color", "Color 7"])).toBe("Color 8");
  });

  it("limits: Enterprise's 40 modes (Figma: 1 / 10 / 20 / 40 by plan) and extension chains of 10 sets", () => {
    expect(LIMITS.modes).toBe(40);
    let c = readCollection(collection("1:1", [[1, "Light", "!"]]));
    for (let i = 0; i < 8; i++) c = { ...readCollection(collection(`2:${i}`, [[1, "Light", "!"]])), parentCollection: c, parent: c.id };
    expect(canExtend(c)).toBe(true); // nine sets so far
    c = { ...readCollection(collection("3:1", [[1, "Light", "!"]])), parentCollection: c, parent: c.id };
    expect(canExtend(c)).toBe(false); // ten
  });

  it("scopes: Figma's per-type lists — numbers' Text content fourth, Gap's \"Auto layout\", the Typography heading", () => {
    expect(SCOPE_OPTIONS.FLOAT.map((o) => o.scope).slice(0, 5)).toEqual(["CORNER_RADIUS", "WIDTH_HEIGHT", "GAP", "TEXT_CONTENT", "STROKE_FLOAT"]);
    expect(SCOPE_OPTIONS.FLOAT.find((o) => o.scope === "GAP")?.sublabel).toBe("Auto layout");
    expect(SCOPE_OPTIONS.FLOAT.find((o) => o.section)?.scope).toBe("FONT_STYLE");
    expect(SCOPE_OPTIONS.STRING.find((o) => o.scope === "FONT_STYLE")?.label).toBe("Font weight or style");
    // X / Y / rotation need TRANSFORM (no checkbox): only "all" variables offer themselves; text content takes numbers
    expect(BIND_TYPE.X_POSITION.scope).toBe("TRANSFORM");
    expect(scopeAllows(["CORNER_RADIUS"], "TRANSFORM")).toBe(false);
    expect(scopeAllows(["ALL_SCOPES"], "TRANSFORM")).toBe(true);
    expect(bindTypes("TEXT_DATA")).toEqual(["STRING", "FLOAT"]);
  });

  it("warnings: a bound value the field can't use as it is", () => {
    const n = { minSize: { value: { x: 40, y: 0 } }, maxSize: { value: { x: 400, y: 0 } } };
    expect(bindingWarning("WIDTH", 20, n)).toBe("Less than the min width");
    expect(bindingWarning("WIDTH", 500, n)).toBe("Greater than the max width");
    expect(bindingWarning("WIDTH", 100, n)).toBeNull();
    expect(bindingWarning("HEIGHT", 0, n)).toBe("Must be greater than 0");
    expect(bindingWarning("OPACITY", 120, null)).toBe("Above 100%: the layer is fully opaque");
    expect(bindingWarning("OPACITY", -5, null)).toBe("Below 0%: the layer is fully transparent");
    expect(bindingWarning("FONT_SIZE", 0.5, null)).toBe("Must be at least 1");
    expect(bindingWarning("CORNER_RADIUS", -2, null)).toBe("Can't be negative");
    expect(bindingWarning("STACK_SPACING", -2, null)).toBeNull();
    expect(bindingWarning("TEXT_DATA", "x", null)).toBeNull();
  });
});
