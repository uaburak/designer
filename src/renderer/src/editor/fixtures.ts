/**
 * Documents the `?editor` route opens without a store: `&doc=reference` is a
 * file matching the owner's reference screenshots of Figma (docs/editor.md,
 * docs/research/visual-diff.md); `&doc=empty` a new file's three nodes;
 * `&doc=types` the Design panel's Phase 2 cases.
 */
import type { Color, Message, NodeChange } from "@/engine/codec";

const hex = (rgb: number, a = 1): Color => ({ r: ((rgb >> 16) & 255) / 255, g: ((rgb >> 8) & 255) / 255, b: (rgb & 255) / 255, a });

/** Fractional positions, ascending (docs/schema.md §3.5: base-95 strings). */
const position = (i: number) => String.fromCharCode(33 + i);

function page(guid: string, name: string, i: number, background = 0xf5f5f5): NodeChange {
  return { guid, phase: "CREATED", type: "CANVAS", name, parentIndex: { guid: "0:0", position: position(i) }, backgroundColor: hex(background), backgroundEnabled: true };
}

const internalCanvas = (): NodeChange => ({ guid: "0:2", phase: "CREATED", type: "CANVAS", name: "Internal Only Canvas", parentIndex: { guid: "0:0", position: "~" }, internalOnly: true, visible: false });

/** A new design file: the document, "Page 1", the internal canvas. */
export const EMPTY_DOCUMENT: Message = {
  type: "NODE_CHANGES",
  sessionID: 0,
  nodeChanges: [{ guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" }, page("0:1", "Page 1", 0), internalCanvas()],
};

/** The pages of the owner's file "burakkoc" (screenshot 1). */
export const REFERENCE_PAGES = ["Page 10", "New Page", "burakkoc.net ( new )", "OXTV", "Page 7", "theStudio", "CV", "Logolar"];

/** File "burakkoc" in Drafts: eight pages, the first one #232323 with "Frame 1" (437 × 305 at −34, 3, white). */
export const REFERENCE_DOCUMENT: Message = {
  type: "NODE_CHANGES",
  sessionID: 0,
  nodeChanges: [
    { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
    ...REFERENCE_PAGES.map((name, i) => page(i === 0 ? "0:1" : `0:${i + 2}`, name, i, i === 0 ? 0x232323 : 0xf5f5f5)),
    internalCanvas(),
    {
      guid: "1:1",
      phase: "CREATED",
      type: "FRAME",
      name: "Frame 1",
      parentIndex: { guid: "0:1", position: "!" },
      size: { x: 437, y: 305 },
      transform: { m00: 1, m01: 0, m02: -34, m10: 0, m11: 1, m12: 3 },
      fillPaints: [{ type: "SOLID", color: hex(0xffffff), opacity: 1, visible: true }],
      strokeWeight: 1,
      strokeAlign: "INSIDE",
    },
  ],
};

const solidFill = (rgb: number) => [{ type: "SOLID" as const, color: hex(rgb), opacity: 1, visible: true }];
const at = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });

/**
 * `&doc=types`: one of each kind the Design panel handles in Phase 2 — an auto-layout frame (Hug, a Fill child,
 * an "Ignore auto layout" child), a plain frame with a pinned child (Constraints), and layers the engine doesn't
 * draw yet but the panels name by type: a vector, a boolean group and a text layer.
 */
export const TYPES_DOCUMENT: Message = {
  type: "NODE_CHANGES",
  sessionID: 0,
  nodeChanges: [
    { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
    page("0:1", "Page 1", 0, 0x1e1e1e),
    internalCanvas(),
    { guid: "1:1", phase: "CREATED", type: "FRAME", name: "Auto layout", parentIndex: { guid: "0:1", position: "!" }, size: { x: 320, y: 120 }, transform: at(0, 0), fillPaints: solidFill(0xffffff), stackMode: "HORIZONTAL", stackSpacing: 12, stackHorizontalPadding: 16, stackVerticalPadding: 16, stackPaddingRight: 16, stackPaddingBottom: 16, stackPrimarySizing: "FIXED", stackCounterSizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" },
    { guid: "1:2", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Fixed", parentIndex: { guid: "1:1", position: "!" }, size: { x: 64, y: 64 }, transform: at(16, 16), fillPaints: solidFill(0x0d99ff) },
    { guid: "1:3", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Fill", parentIndex: { guid: "1:1", position: '"' }, size: { x: 100, y: 64 }, transform: at(92, 16), fillPaints: solidFill(0x14ae5c), stackChildPrimaryGrow: 1 },
    { guid: "1:4", phase: "CREATED", type: "ELLIPSE", name: "Absolute", parentIndex: { guid: "1:1", position: "#" }, size: { x: 24, y: 24 }, transform: at(284, 8), fillPaints: solidFill(0xf24822), stackPositioning: "ABSOLUTE", horizontalConstraint: "MAX" },
    { guid: "1:10", phase: "CREATED", type: "FRAME", name: "Constraints", parentIndex: { guid: "0:1", position: '"' }, size: { x: 240, y: 160 }, transform: at(380, 0), fillPaints: solidFill(0xffffff) },
    { guid: "1:11", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Pinned", parentIndex: { guid: "1:10", position: "!" }, size: { x: 80, y: 40 }, transform: at(144, 104), fillPaints: solidFill(0xffc700), horizontalConstraint: "STRETCH", verticalConstraint: "MAX" },
    { guid: "1:12", phase: "CREATED", type: "ELLIPSE", name: "Dot", parentIndex: { guid: "1:10", position: '"' }, size: { x: 32, y: 32 }, transform: at(16, 16), fillPaints: solidFill(0x9747ff), horizontalConstraint: "CENTER", verticalConstraint: "SCALE" },
    { guid: "1:20", phase: "CREATED", type: "VECTOR" as never, name: "Vector", parentIndex: { guid: "0:1", position: "#" }, size: { x: 80, y: 60 }, transform: at(0, 200), fillPaints: solidFill(0xd9d9d9) },
    { guid: "1:21", phase: "CREATED", type: "BOOLEAN_OPERATION" as never, booleanOperation: "SUBTRACT", name: "Subtract", parentIndex: { guid: "0:1", position: "$" }, size: { x: 80, y: 80 }, transform: at(120, 200), fillPaints: solidFill(0xd9d9d9) } as NodeChange,
    { guid: "1:22", phase: "CREATED", type: "TEXT" as never, name: "Heading", parentIndex: { guid: "0:1", position: "%" }, size: { x: 120, y: 24 }, transform: at(240, 200), fillPaints: solidFill(0x000000), fontSize: 20, textAutoResize: "WIDTH_AND_HEIGHT" } as NodeChange,
  ],
};

const stops = (a: number, b: number) => [
  { color: hex(a), position: 0 },
  { color: hex(b), position: 1 },
];
const gradient = (type: string, a: number, b: number) => [{ type, stops: stops(a, b), transform: type === "GRADIENT_LINEAR" ? { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 } : { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }, opacity: 1, visible: true }];
const shadow = (type: "DROP_SHADOW" | "INNER_SHADOW", y = 4, blur = 4) => ({ type, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y }, radius: blur, spread: 0, visible: true, blendMode: "NORMAL" as const });
const node = (n: Record<string, unknown>) => ({ phase: "CREATED", ...n }) as NodeChange;

/**
 * `&doc=paints`: E4 / E5 — the four gradients, shadows and blurs, a star, a polygon, a line, an arrow-capped line, a
 * boolean group, a dashed stroke with individual sides, and a frame with layout guides.
 */
export const PAINTS_DOCUMENT: Message = {
  type: "NODE_CHANGES",
  sessionID: 0,
  nodeChanges: [
    { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
    page("0:1", "Page 1", 0, 0x1e1e1e),
    internalCanvas(),
    node({ guid: "2:1", type: "FRAME", name: "Gradients", parentIndex: { guid: "0:1", position: "!" }, size: { x: 520, y: 160 }, transform: at(0, 0), fillPaints: solidFill(0xffffff), stackMode: "HORIZONTAL", stackSpacing: 16, stackHorizontalPadding: 16, stackVerticalPadding: 16, stackPaddingRight: 16, stackPaddingBottom: 16 }),
    node({ guid: "2:2", type: "ROUNDED_RECTANGLE", name: "Linear", parentIndex: { guid: "2:1", position: "!" }, size: { x: 110, y: 128 }, transform: at(16, 16), cornerRadius: 8, fillPaints: gradient("GRADIENT_LINEAR", 0x0d99ff, 0x9747ff) }),
    node({ guid: "2:3", type: "ROUNDED_RECTANGLE", name: "Radial", parentIndex: { guid: "2:1", position: '"' }, size: { x: 110, y: 128 }, transform: at(142, 16), cornerRadius: 8, fillPaints: gradient("GRADIENT_RADIAL", 0xffc700, 0xf24822) }),
    node({ guid: "2:4", type: "ROUNDED_RECTANGLE", name: "Angular", parentIndex: { guid: "2:1", position: "#" }, size: { x: 110, y: 128 }, transform: at(268, 16), cornerRadius: 8, fillPaints: gradient("GRADIENT_ANGULAR", 0x14ae5c, 0x0d99ff) }),
    node({ guid: "2:5", type: "ROUNDED_RECTANGLE", name: "Diamond", parentIndex: { guid: "2:1", position: "$" }, size: { x: 110, y: 128 }, transform: at(394, 16), cornerRadius: 8, fillPaints: gradient("GRADIENT_DIAMOND", 0xff24bd, 0xffffff) }),
    node({ guid: "2:10", type: "ROUNDED_RECTANGLE", name: "Drop shadow", parentIndex: { guid: "0:1", position: '"' }, size: { x: 120, y: 80 }, transform: at(0, 200), cornerRadius: 12, fillPaints: solidFill(0xffffff), effects: [shadow("DROP_SHADOW", 8, 16)] }),
    node({ guid: "2:11", type: "ROUNDED_RECTANGLE", name: "Inner shadow", parentIndex: { guid: "0:1", position: "#" }, size: { x: 120, y: 80 }, transform: at(140, 200), cornerRadius: 12, fillPaints: solidFill(0xe6e6e6), effects: [shadow("INNER_SHADOW")] }),
    node({ guid: "2:12", type: "ELLIPSE", name: "Layer blur", parentIndex: { guid: "0:1", position: "$" }, size: { x: 80, y: 80 }, transform: at(280, 200), fillPaints: solidFill(0x0d99ff), effects: [{ type: "FOREGROUND_BLUR", radius: 8, visible: true }] }),
    node({ guid: "2:20", type: "STAR", name: "Star", parentIndex: { guid: "0:1", position: "%" }, size: { x: 80, y: 80 }, transform: at(0, 320), fillPaints: solidFill(0xffc700), count: 5, starInnerScale: 0.382 }),
    node({ guid: "2:21", type: "REGULAR_POLYGON", name: "Polygon", parentIndex: { guid: "0:1", position: "&" }, size: { x: 80, y: 80 }, transform: at(100, 320), fillPaints: solidFill(0x14ae5c), count: 3 }),
    node({ guid: "2:22", type: "LINE", name: "Line", parentIndex: { guid: "0:1", position: "'" }, size: { x: 120, y: 0 }, transform: at(200, 360), strokePaints: solidFill(0xffffff), strokeWeight: 2 }),
    node({ guid: "2:23", type: "LINE", name: "Arrow", parentIndex: { guid: "0:1", position: "(" }, size: { x: 120, y: 0 }, transform: at(200, 390), strokePaints: solidFill(0xffffff), strokeWeight: 2, strokeCap: "ARROW_LINES" }),
    node({ guid: "2:30", type: "BOOLEAN_OPERATION", booleanOperation: "SUBTRACT", name: "Subtract", parentIndex: { guid: "0:1", position: ")" }, size: { x: 100, y: 100 }, transform: at(360, 320), fillPaints: solidFill(0xf24822) }),
    node({ guid: "2:31", type: "ROUNDED_RECTANGLE", name: "Base", parentIndex: { guid: "2:30", position: "!" }, size: { x: 80, y: 80 }, transform: at(0, 0), fillPaints: solidFill(0xd9d9d9) }),
    node({ guid: "2:32", type: "ELLIPSE", name: "Hole", parentIndex: { guid: "2:30", position: '"' }, size: { x: 60, y: 60 }, transform: at(40, 40), fillPaints: solidFill(0xd9d9d9) }),
    node({ guid: "2:40", type: "ROUNDED_RECTANGLE", name: "Dashed", parentIndex: { guid: "0:1", position: "*" }, size: { x: 120, y: 80 }, transform: at(480, 200), fillPaints: [], strokePaints: solidFill(0x0d99ff), strokeWeight: 2, strokeAlign: "INSIDE", dashPattern: [6, 4], strokeJoin: "ROUND" }),
    node({ guid: "2:41", type: "FRAME", name: "Bottom border", parentIndex: { guid: "0:1", position: "+" }, size: { x: 120, y: 48 }, transform: at(480, 320), fillPaints: solidFill(0xffffff), strokePaints: solidFill(0x000000), strokeWeight: 2, borderStrokeWeightsIndependent: true, borderTopWeight: 0, borderRightWeight: 0, borderBottomWeight: 2, borderLeftWeight: 0 }),
    node({ guid: "2:50", type: "FRAME", name: "Layout guides", parentIndex: { guid: "0:1", position: "," }, size: { x: 360, y: 240 }, transform: at(640, 0), fillPaints: solidFill(0xffffff), layoutGrids: [
      { pattern: "STRIPES", axis: "X", numSections: 4, type: "STRETCH", offset: 16, gutterSize: 16, sectionSize: 10, color: { r: 1, g: 0, b: 0, a: 0.1 }, visible: true },
      { pattern: "GRID", sectionSize: 20, color: { r: 0.05, g: 0.6, b: 1, a: 0.1 }, visible: true, axis: "X", type: "STRETCH" },
    ] }),
  ],
};

// ---- `&doc=components`: components, a set with variants, instances on another page ----------------------------

const g = (s: number, l: number) => ({ sessionID: s, localID: l });
const def = (l: number) => g(1, 0x7fffff00 + l);
const text = (characters: string) => ({ characters });
const propRef = (field: string, resolved: string, id: { sessionID: number; localID: number }) => ({ variableField: field, variableData: { dataType: "PROP_REF", resolvedDataType: resolved, value: { propRefValue: { defId: id } } } });
const purple = { r: 0x97 / 255, g: 0x47 / 255, b: 1, a: 1 };

const BUTTON_ROOT = {
  size: { x: 120, y: 40 },
  fillPaints: solidFill(0x0d99ff),
  cornerRadius: 8,
  stackMode: "HORIZONTAL",
  stackSpacing: 8,
  stackHorizontalPadding: 16,
  stackVerticalPadding: 12,
  stackPaddingRight: 16,
  stackPaddingBottom: 12,
  stackPrimaryAlignItems: "CENTER",
  stackCounterAlignItems: "CENTER",
};
const CHIP_SMALL = { size: { x: 80, y: 28 }, fillPaints: solidFill(0xe5f4ff), cornerRadius: 14 };
const CHIP_LARGE = { size: { x: 104, y: 36 }, fillPaints: solidFill(0xe5f4ff), cornerRadius: 18 };

/**
 * `&doc=components`: page "Screens" with instances (a Button with a changed label and fill, a Chip of a set) and
 * page "Components" with the mains: "Button" (Boolean, Text and Instance swap properties bound to its layers, an
 * exposed nested "Icon" instance), two icons in a frame, and the set "Chip" (State × Size).
 */
export const COMPONENTS_DOCUMENT: Message = {
  type: "NODE_CHANGES",
  sessionID: 0,
  nodeChanges: [
    { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
    page("0:1", "Screens", 0, 0x1e1e1e),
    page("0:3", "Components", 1, 0x1e1e1e),
    internalCanvas(),
    // Components
    node({
      guid: "1:1",
      type: "SYMBOL",
      name: "Button",
      parentIndex: { guid: "0:3", position: "!" },
      transform: at(0, 0),
      ...BUTTON_ROOT,
      description: "The primary action.",
      componentPropDefs: [
        { id: def(1), name: "Show icon", type: "BOOL", initialValue: { boolValue: true }, sortPosition: "!" },
        { id: def(2), name: "Label", type: "TEXT", initialValue: { textValue: text("Button") }, sortPosition: '"' },
        { id: def(3), name: "Icon", type: "INSTANCE_SWAP", initialValue: { guidValue: g(1, 20) }, sortPosition: "#", preferredValues: { instanceSwapValues: [{ type: "COMPONENT", key: "1:20" }, { type: "COMPONENT", key: "1:21" }] } },
      ],
    }),
    node({
      guid: "1:2",
      type: "INSTANCE",
      name: "Icons/Star",
      parentIndex: { guid: "1:1", position: "!" },
      size: { x: 16, y: 16 },
      transform: at(16, 12),
      symbolData: { symbolID: g(1, 20), symbolOverrides: [] },
      propsAreBubbled: true,
      parameterConsumptionMap: { entries: [propRef("VISIBLE", "BOOLEAN", def(1)), propRef("OVERRIDDEN_SYMBOL_ID", "SYMBOL_ID", def(3))] },
    }),
    node({ guid: "1:3", type: "TEXT", name: "Label", parentIndex: { guid: "1:1", position: '"' }, size: { x: 48, y: 16 }, transform: at(40, 12), fillPaints: solidFill(0xffffff), textData: text("Button"), fontSize: 13, textAutoResize: "WIDTH_AND_HEIGHT", parameterConsumptionMap: { entries: [propRef("TEXT_DATA", "TEXT_DATA", def(2))] } }),
    node({ guid: "1:30", type: "FRAME", name: "Icons", parentIndex: { guid: "0:3", position: '"' }, size: { x: 96, y: 48 }, transform: at(0, 80), fillPaints: solidFill(0x2c2c2c) }),
    node({ guid: "1:20", type: "SYMBOL", name: "Icons/Star", parentIndex: { guid: "1:30", position: "!" }, size: { x: 16, y: 16 }, transform: at(16, 16), componentPropDefs: [{ id: def(9), name: "Filled", type: "BOOL", initialValue: { boolValue: true } }] }),
    node({ guid: "1:22", type: "STAR", name: "Star", parentIndex: { guid: "1:20", position: "!" }, size: { x: 16, y: 16 }, transform: at(0, 0), fillPaints: solidFill(0xffc700), count: 5, starInnerScale: 0.382, parameterConsumptionMap: { entries: [propRef("VISIBLE", "BOOLEAN", def(9))] } }),
    node({ guid: "1:21", type: "SYMBOL", name: "Icons/Heart", parentIndex: { guid: "1:30", position: '"' }, size: { x: 16, y: 16 }, transform: at(56, 16) }),
    node({ guid: "1:23", type: "ELLIPSE", name: "Heart", parentIndex: { guid: "1:21", position: "!" }, size: { x: 16, y: 16 }, transform: at(0, 0), fillPaints: solidFill(0xf24822) }),
    node({
      guid: "1:40",
      type: "FRAME",
      name: "Chip",
      isStateGroup: true,
      parentIndex: { guid: "0:3", position: "#" },
      size: { x: 264, y: 112 },
      transform: at(200, 0),
      fillPaints: [],
      strokePaints: [{ type: "SOLID", color: purple, opacity: 1, visible: true }],
      strokeWeight: 1,
      strokeAlign: "INSIDE",
      dashPattern: [10, 5],
      cornerRadius: 5,
      componentPropDefs: [
        { id: def(10), name: "State", type: "VARIANT", initialValue: { textValue: text("Default") } },
        { id: def(11), name: "Size", type: "VARIANT", initialValue: { textValue: text("Small") } },
      ],
      stateGroupPropertyValueOrders: [
        { property: "State", values: ["Default", "Hover"] },
        { property: "Size", values: ["Small", "Large"] },
      ],
    }),
    ...(
      [
        ["1:41", "Default", "Small", 20, 20, CHIP_SMALL, '!'],
        ["1:42", "Hover", "Small", 140, 20, { ...CHIP_SMALL, fillPaints: solidFill(0xbde3ff) }, '"'],
        ["1:43", "Default", "Large", 20, 60, CHIP_LARGE, "#"],
        ["1:44", "Hover", "Large", 140, 60, { ...CHIP_LARGE, fillPaints: solidFill(0xbde3ff) }, "$"],
      ] as const
    ).map(([guid, state, sz, x, y, root, position]) =>
      node({ guid, type: "SYMBOL", name: `State=${state}, Size=${sz}`, parentIndex: { guid: "1:40", position }, transform: at(x, y), ...root, variantPropSpecs: [{ propDefId: def(10), value: state }, { propDefId: def(11), value: sz }] })
    ),
    // Instances (their root fields are the main's, as the engine materializes them)
    node({ guid: "2:1", type: "FRAME", name: "Sign in", parentIndex: { guid: "0:1", position: "!" }, size: { x: 375, y: 240 }, transform: at(0, 0), fillPaints: solidFill(0xffffff) }),
    node({
      guid: "2:2",
      type: "INSTANCE",
      name: "Button",
      parentIndex: { guid: "2:1", position: "!" },
      transform: at(24, 24),
      ...BUTTON_ROOT,
      fillPaints: solidFill(0x14ae5c),
      symbolData: { symbolID: g(1, 1), symbolOverrides: [{ guidPath: { guids: [] }, fillPaints: solidFill(0x14ae5c) }, { guidPath: { guids: [g(1, 3)] }, fontSize: 14 }] },
      componentPropAssignments: [{ defID: def(2), value: { textValue: text("Sign in") } }],
    }),
    node({ guid: "2:3", type: "INSTANCE", name: "Chip", parentIndex: { guid: "2:1", position: '"' }, transform: at(24, 96), ...CHIP_SMALL, symbolData: { symbolID: g(1, 41), symbolOverrides: [] } }),
  ],
};

// ---- `&doc=variables`: collections, modes, aliases, styles, bound layers ------------------------------------------

const mode = (l: number) => g(5, l);
const vColor = (rgb: number, a = 1) => ({ dataType: "COLOR", resolvedDataType: "COLOR", value: { colorValue: hex(rgb, a) } });
const vFloat = (n: number) => ({ dataType: "FLOAT", resolvedDataType: "FLOAT", value: { floatValue: n } });
const vString = (s: string) => ({ dataType: "STRING", resolvedDataType: "STRING", value: { textValue: s } });
const vBool = (b: boolean) => ({ dataType: "BOOLEAN", resolvedDataType: "BOOLEAN", value: { boolValue: b } });
const vAlias = (l: number, type: string) => ({ dataType: "ALIAS", resolvedDataType: type, value: { alias: { guid: g(5, l) } } });
const alias = (l: number, type: string) => ({ dataType: "ALIAS", resolvedDataType: type, value: { alias: { guid: g(5, l) } } });
const PRIMITIVES = "7:1";
const THEME = "7:2";
const VALUE = mode(100);
const LIGHT = mode(200);
const DARK = mode(201);

/** A VARIABLE under the internal canvas: one value per mode. */
function variable(l: number, name: string, collection: string, type: string, values: [ReturnType<typeof mode>, unknown][], position: string, extra: Record<string, unknown> = {}): NodeChange {
  const [s, c] = collection.split(":").map(Number);
  return node({
    guid: `5:${l}`,
    type: "VARIABLE",
    name,
    parentIndex: { guid: "0:2", position: `v${position}` },
    variableSetID: { guid: g(s, c) },
    variableResolvedType: type,
    variableDataValues: { entries: values.map(([m, d]) => ({ modeID: m, variableData: d })) },
    sortPosition: position,
    ...extra,
  });
}

/** A style node under the internal canvas. */
function style(l: number, kind: "FILL" | "TEXT" | "EFFECT" | "GRID", name: string, position: string, fields: Record<string, unknown>): NodeChange {
  return node({ guid: `6:${l}`, type: kind === "TEXT" ? "TEXT" : "ROUNDED_RECTANGLE", name, parentIndex: { guid: "0:2", position: `s${position}` }, styleType: kind, sortPosition: position, size: { x: 100, y: 100 }, visible: false, ...fields });
}

const styleRef = (l: number) => ({ guid: g(6, l) });
const bindNum = (field: string, l: number) => ({ variableField: field, variableData: alias(l, "FLOAT") });
const colorVarOf = (l: number) => ({ colorVar: vAlias(l, "COLOR") });
const H2 = { fontName: { family: "Inter", style: "Semi Bold", postscript: "" }, fontSize: 24, lineHeight: { value: 32, units: "PIXELS" }, letterSpacing: { value: -1, units: "PERCENT" } };
const SHADOW_SMALL = [{ type: "DROP_SHADOW", color: hex(0x000000, 0.15), offset: { x: 0, y: 2 }, radius: 4, spread: 0, visible: true, blendMode: "NORMAL", showShadowBehindNode: false }];

/** One card: a vertical auto-layout frame bound to Theme's variables, with a styled title and accent. */
function card(id: number, name: string, x: number, dark: boolean, position: string): NodeChange[] {
  const bg = dark ? 0x1e1e1e : 0xf5f5f5;
  const fg = dark ? 0xffffff : 0x1e1e1e;
  const radius = dark ? 16 : 8;
  return [
    node({
      guid: `2:${id}`,
      type: "FRAME",
      name,
      parentIndex: { guid: "0:1", position },
      size: { x: 280, y: 180 },
      transform: at(x, 0),
      fillPaints: [{ ...solidFill(bg)[0], ...colorVarOf(20) }],
      cornerRadius: radius,
      rectangleTopLeftCornerRadius: radius,
      rectangleTopRightCornerRadius: radius,
      rectangleBottomLeftCornerRadius: radius,
      rectangleBottomRightCornerRadius: radius,
      stackMode: "VERTICAL",
      stackSpacing: 16,
      stackHorizontalPadding: 24,
      stackVerticalPadding: 24,
      stackPaddingRight: 24,
      stackPaddingBottom: 24,
      parameterConsumptionMap: { entries: [bindNum("CORNER_RADIUS", 23), bindNum("STACK_SPACING", 12)] },
      ...(dark ? { variableModeBySetMap: { entries: [{ variableSetID: { guid: g(7, 2) }, variableModeID: DARK }] } } : {}),
    }),
    node({
      guid: `2:${id + 1}`,
      type: "TEXT",
      name: "Title",
      parentIndex: { guid: `2:${id}`, position: "!" },
      size: { x: 232, y: 32 },
      transform: at(24, 24),
      textData: { characters: "Card title" },
      textAutoResize: "HEIGHT",
      ...H2,
      styleIdForText: styleRef(2),
      fillPaints: [{ ...solidFill(fg)[0], ...colorVarOf(22) }],
    }),
    node({
      guid: `2:${id + 2}`,
      type: "ROUNDED_RECTANGLE",
      name: "Accent",
      parentIndex: { guid: `2:${id}`, position: '"' },
      size: { x: 232, y: 60 },
      transform: at(24, 72),
      cornerRadius: 8,
      fillPaints: solidFill(0x0d99ff),
      styleIdForFill: styleRef(10),
      effects: SHADOW_SMALL,
      styleIdForEffect: styleRef(20),
    }),
  ];
}

/**
 * `&doc=variables`: two collections — "Primitives" (one mode: colours, spacing, radii) and "Theme" (Light / Dark:
 * aliases into Primitives, a literal colour, a number alias, a string and a boolean) — local text, color, effect and
 * layout guide styles in folders, and two cards bound to Theme (fill, corner radius, gap; a styled title and
 * accent), the second set to Dark.
 */
export const VARIABLES_DOCUMENT: Message = {
  type: "NODE_CHANGES",
  sessionID: 0,
  nodeChanges: [
    { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
    page("0:1", "Page 1", 0, 0x2c2c2c),
    internalCanvas(),
    node({ guid: PRIMITIVES, type: "VARIABLE_SET", name: "Primitives", parentIndex: { guid: "0:2", position: "a" }, sortPosition: "a", variableSetModes: [{ id: VALUE, name: "Value", sortPosition: "a" }] }),
    node({ guid: THEME, type: "VARIABLE_SET", name: "Theme", parentIndex: { guid: "0:2", position: "b" }, sortPosition: "b", variableSetModes: [{ id: LIGHT, name: "Light", sortPosition: "a" }, { id: DARK, name: "Dark", sortPosition: "b" }] }),
    variable(1, "color/blue/500", PRIMITIVES, "COLOR", [[VALUE, vColor(0x0d99ff)]], "a"),
    variable(2, "color/blue/100", PRIMITIVES, "COLOR", [[VALUE, vColor(0xe5f4ff)]], "b"),
    variable(3, "color/gray/900", PRIMITIVES, "COLOR", [[VALUE, vColor(0x1e1e1e)]], "c"),
    variable(4, "color/gray/50", PRIMITIVES, "COLOR", [[VALUE, vColor(0xf5f5f5)]], "d"),
    variable(5, "color/white", PRIMITIVES, "COLOR", [[VALUE, vColor(0xffffff)]], "e"),
    variable(11, "spacing/sm", PRIMITIVES, "FLOAT", [[VALUE, vFloat(8)]], "f", { variableScopes: ["GAP"] }),
    variable(12, "spacing/md", PRIMITIVES, "FLOAT", [[VALUE, vFloat(16)]], "g", { variableScopes: ["GAP"] }),
    variable(13, "spacing/lg", PRIMITIVES, "FLOAT", [[VALUE, vFloat(24)]], "h", { variableScopes: ["GAP"], description: "Space between a card's blocks" }),
    variable(14, "radius/md", PRIMITIVES, "FLOAT", [[VALUE, vFloat(8)]], "i", { variableScopes: ["CORNER_RADIUS"] }),
    variable(15, "radius/lg", PRIMITIVES, "FLOAT", [[VALUE, vFloat(16)]], "j", { variableScopes: ["CORNER_RADIUS"] }),
    variable(20, "bg/primary", THEME, "COLOR", [[LIGHT, vAlias(4, "COLOR")], [DARK, vAlias(3, "COLOR")]], "a", { codeSyntax: { entries: [{ platform: "WEB", value: "var(--bg-primary)" }] } }),
    variable(21, "bg/brand", THEME, "COLOR", [[LIGHT, vAlias(1, "COLOR")], [DARK, vAlias(1, "COLOR")]], "b"),
    variable(22, "text/primary", THEME, "COLOR", [[LIGHT, vColor(0x1e1e1e)], [DARK, vColor(0xffffff)]], "c"),
    variable(23, "radius/card", THEME, "FLOAT", [[LIGHT, vAlias(14, "FLOAT")], [DARK, vAlias(15, "FLOAT")]], "d", { variableScopes: ["CORNER_RADIUS"] }),
    variable(24, "label/cta", THEME, "STRING", [[LIGHT, vString("Sign up")], [DARK, vString("Join now")]], "e"),
    variable(25, "feature/beta", THEME, "BOOLEAN", [[LIGHT, vBool(true)], [DARK, vBool(false)]], "f"),
    style(1, "TEXT", "Heading/H1", "a", { fontName: { family: "Inter", style: "Bold", postscript: "" }, fontSize: 32, lineHeight: { value: 40, units: "PIXELS" }, letterSpacing: { value: -2, units: "PERCENT" }, textData: { characters: "Ag" } }),
    style(2, "TEXT", "Heading/H2", "b", { ...H2, textData: { characters: "Ag" } }),
    style(3, "TEXT", "Body/Regular", "c", { fontName: { family: "Inter", style: "Regular", postscript: "" }, fontSize: 14, lineHeight: { value: 1.5, units: "RAW" }, letterSpacing: { value: 0, units: "PERCENT" }, textData: { characters: "Ag" } }),
    style(10, "FILL", "Brand/Primary", "a", { fillPaints: solidFill(0x0d99ff) }),
    style(11, "FILL", "Brand/Secondary", "b", { fillPaints: solidFill(0x9747ff) }),
    style(12, "FILL", "Neutral/Gray 100", "c", { fillPaints: solidFill(0xf5f5f5) }),
    style(20, "EFFECT", "Shadow/Small", "a", { effects: SHADOW_SMALL }),
    style(21, "EFFECT", "Shadow/Large", "b", { effects: [{ ...SHADOW_SMALL[0], offset: { x: 0, y: 8 }, radius: 24, color: hex(0x000000, 0.2) }] }),
    style(30, "GRID", "Grid/8pt", "a", { layoutGrids: [{ pattern: "GRID", sectionSize: 8, visible: true, color: hex(0xff0000, 0.1) }] }),
    ...card(1, "Card", 0, false, "!"),
    ...card(10, "Card (Dark)", 320, true, '"'),
  ],
};

// ── Prototyping (E8) ─────────────────────────────────────────────────────────

const click = (dest: string, navigationType: string, transitionType = "INSTANT_TRANSITION", duration = 0.3, easingType = "OUT_CUBIC") => [
  {
    id: g(9, Number(dest.split(":")[1]) + 1000),
    event: { interactionType: "ON_CLICK" },
    actions: [{ connectionType: "INTERNAL_NODE", navigationType, transitionNodeID: dest, transitionType, transitionDuration: duration, easingType }],
  },
];
const onTap = (connectionType: string) => [{ event: { interactionType: "ON_CLICK" }, actions: [{ connectionType, transitionType: "INSTANT_TRANSITION", transitionDuration: 0.3, easingType: "OUT_CUBIC" }] }];

/**
 * A prototype (Phase 5 E8): "Home" (the flow "Onboarding" starts there) → "Details" by Smart animate (the Card grows),
 * Back; a menu button opening "Menu" as an overlay from the bottom (closes when clicking outside, 40% black behind it,
 * its × closes it); a horizontal carousel that scrolls; and a "Toggle" — an interactive component whose variants
 * change to each other on click with Smart animate.
 */
export const PROTOTYPE_DOCUMENT: Message = {
  type: "NODE_CHANGES",
  sessionID: 0,
  nodeChanges: [
    { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
    page("0:1", "Prototype", 0, 0x1e1e1e),
    internalCanvas(),
    node({ guid: "2:1", type: "FRAME", name: "Home", parentIndex: { guid: "0:1", position: "!" }, size: { x: 375, y: 812 }, transform: at(0, 0), fillPaints: solidFill(0xffffff), prototypeStartingPoint: { name: "Onboarding", position: "!" } }),
    node({ guid: "2:2", type: "FRAME", name: "Card", parentIndex: { guid: "2:1", position: "!" }, size: { x: 327, y: 160 }, transform: at(24, 120), fillPaints: solidFill(0x0d99ff), cornerRadius: 16 }),
    node({ guid: "2:3", type: "ROUNDED_RECTANGLE", name: "Title", parentIndex: { guid: "2:2", position: "!" }, size: { x: 120, y: 24 }, transform: at(16, 16), fillPaints: solidFill(0xffffff), cornerRadius: 4 }),
    node({ guid: "2:6", type: "FRAME", name: "Carousel", parentIndex: { guid: "2:1", position: '"' }, size: { x: 375, y: 180 }, transform: at(0, 320), fillPaints: [], scrollDirection: "HORIZONTAL" }),
    node({ guid: "2:30", type: "ROUNDED_RECTANGLE", name: "Slide 1", parentIndex: { guid: "2:6", position: "!" }, size: { x: 240, y: 180 }, transform: at(24, 0), fillPaints: solidFill(0xffcd29), cornerRadius: 12 }),
    node({ guid: "2:31", type: "ROUNDED_RECTANGLE", name: "Slide 2", parentIndex: { guid: "2:6", position: '"' }, size: { x: 240, y: 180 }, transform: at(280, 0), fillPaints: solidFill(0x14ae5c), cornerRadius: 12 }),
    node({ guid: "2:32", type: "ROUNDED_RECTANGLE", name: "Slide 3", parentIndex: { guid: "2:6", position: "#" }, size: { x: 240, y: 180 }, transform: at(536, 0), fillPaints: solidFill(0x9747ff), cornerRadius: 12 }),
    node({ guid: "2:4", type: "FRAME", name: "Next", parentIndex: { guid: "2:1", position: "#" }, size: { x: 327, y: 56 }, transform: at(24, 720), fillPaints: solidFill(0x000000), cornerRadius: 12, prototypeInteractions: click("2:10", "NAVIGATE", "SMART_ANIMATE", 0.5) }),
    node({ guid: "2:5", type: "ELLIPSE", name: "Menu button", parentIndex: { guid: "2:1", position: "$" }, size: { x: 40, y: 40 }, transform: at(311, 40), fillPaints: solidFill(0xe6e6e6), prototypeInteractions: click("2:20", "OVERLAY", "MOVE_FROM_BOTTOM", 0.3) }),
    node({ guid: "2:7", type: "INSTANCE", name: "Toggle", parentIndex: { guid: "2:1", position: "%" }, size: { x: 52, y: 32 }, transform: at(299, 640), symbolData: { symbolID: g(3, 2), symbolOverrides: [] } }),
    node({ guid: "2:10", type: "FRAME", name: "Details", parentIndex: { guid: "0:1", position: '"' }, size: { x: 375, y: 812 }, transform: at(475, 0), fillPaints: solidFill(0xffffff) }),
    node({ guid: "2:11", type: "FRAME", name: "Card", parentIndex: { guid: "2:10", position: "!" }, size: { x: 375, y: 360 }, transform: at(0, 0), fillPaints: solidFill(0x0d99ff), cornerRadius: 0 }),
    node({ guid: "2:12", type: "ROUNDED_RECTANGLE", name: "Title", parentIndex: { guid: "2:11", position: "!" }, size: { x: 200, y: 32 }, transform: at(24, 280), fillPaints: solidFill(0xffffff), cornerRadius: 4 }),
    node({ guid: "2:13", type: "FRAME", name: "Back", parentIndex: { guid: "2:10", position: '"' }, size: { x: 100, y: 40 }, transform: at(24, 384), fillPaints: solidFill(0x000000), cornerRadius: 8, prototypeInteractions: onTap("BACK") }),
    node({ guid: "2:20", type: "FRAME", name: "Menu", parentIndex: { guid: "0:1", position: "#" }, size: { x: 375, y: 300 }, transform: at(950, 0), fillPaints: solidFill(0xffffff), cornerRadius: 16, overlayPositionType: "BOTTOM_CENTER", overlayBackgroundInteraction: "CLOSE_ON_CLICK_OUTSIDE", overlayBackgroundAppearance: { backgroundType: "SOLID_COLOR", backgroundColor: hex(0x000000, 0.4) } }),
    node({ guid: "2:21", type: "ELLIPSE", name: "Close", parentIndex: { guid: "2:20", position: "!" }, size: { x: 32, y: 32 }, transform: at(327, 16), fillPaints: solidFill(0xe6e6e6), prototypeInteractions: onTap("CLOSE") }),
    node({ guid: "3:1", type: "FRAME", name: "Toggle", isStateGroup: true, parentIndex: { guid: "0:1", position: "$" }, size: { x: 168, y: 64 }, transform: at(0, 900), fillPaints: [], strokePaints: [{ type: "SOLID", color: purple, opacity: 1, visible: true }], strokeWeight: 1, dashPattern: [10, 5], cornerRadius: 5 }),
    node({ guid: "3:2", type: "SYMBOL", name: "State=Off", parentIndex: { guid: "3:1", position: "!" }, size: { x: 52, y: 32 }, transform: at(16, 16), fillPaints: solidFill(0xe6e6e6), cornerRadius: 16, prototypeInteractions: click("3:4", "SWAP_STATE", "SMART_ANIMATE", 0.3) }),
    node({ guid: "3:3", type: "ELLIPSE", name: "Knob", parentIndex: { guid: "3:2", position: "!" }, size: { x: 24, y: 24 }, transform: at(4, 4), fillPaints: solidFill(0xffffff) }),
    node({ guid: "3:4", type: "SYMBOL", name: "State=On", parentIndex: { guid: "3:1", position: '"' }, size: { x: 52, y: 32 }, transform: at(100, 16), fillPaints: solidFill(0x14ae5c), cornerRadius: 16, prototypeInteractions: click("3:2", "SWAP_STATE", "SMART_ANIMATE", 0.3) }),
    node({ guid: "3:5", type: "ELLIPSE", name: "Knob", parentIndex: { guid: "3:4", position: "!" }, size: { x: 24, y: 24 }, transform: at(24, 4), fillPaints: solidFill(0xffffff) }),
  ],
};

const specimenText = (guid: string, parent: string, pos: string, x: number, y: number, characters: string, more: Record<string, unknown> = {}) =>
  node({
    guid,
    type: "TEXT",
    name: characters.split("\n")[0].slice(0, 40),
    parentIndex: { guid: parent, position: pos },
    size: { x: 360, y: 20 },
    transform: at(x, y),
    fillPaints: solidFill(0x1e1e1e),
    textData: { characters },
    fontName: { family: "Inter", style: "Regular", postscript: "" },
    fontSize: 16,
    textAutoResize: "HEIGHT",
    autoRename: true,
    ...more,
  });
const line = (lineType: "PLAIN" | "ORDERED_LIST" | "UNORDERED_LIST", indentationLevel = lineType === "PLAIN" ? 0 : 1) => ({ lineType, indentationLevel });
const runs = (n: number, spans: [from: number, to: number, id: number][]) => {
  const ids = new Array<number>(n).fill(0);
  for (const [from, to, id] of spans) for (let i = from; i < to; i++) ids[i] = id;
  return ids;
};

/** `&doc=text`: the text round's cases — runs, a link, lists, decorations, variable axes, OpenType features, truncation, vertical trim, wrap balance. */
export const TEXT_DOCUMENT: Message = {
  type: "NODE_CHANGES",
  sessionID: 0,
  nodeChanges: [
    { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
    page("0:1", "Text", 0, 0xf5f5f5),
    internalCanvas(),
    node({ guid: "4:1", type: "FRAME", name: "Type specimen", parentIndex: { guid: "0:1", position: "!" }, size: { x: 440, y: 680 }, transform: at(0, 0), fillPaints: solidFill(0xffffff) }),
    specimenText("4:2", "4:1", "!", 40, 32, "Typography", { fontName: { family: "Inter", style: "Bold", postscript: "" }, fontSize: 32, textAutoResize: "WIDTH_AND_HEIGHT", size: { x: 190, y: 39 } }),
    specimenText("4:3", "4:1", '"', 40, 88, "Read the help center for text properties, then style a range.", {
      size: { x: 360, y: 38 },
      textData: {
        characters: "Read the help center for text properties, then style a range.",
        characterStyleIDs: runs(62, [
          [9, 20, 1],
          [55, 62, 2],
        ]),
        styleOverrideTable: [
          { styleID: 1, textDecoration: "UNDERLINE", hyperlink: { url: "https://help.figma.com" }, fillPaints: solidFill(0x0d99ff) },
          { styleID: 2, fontName: { family: "Inter", style: "Bold", postscript: "" } },
        ],
      },
    }),
    specimenText("4:4", "4:1", "#", 40, 150, "Bulleted lists\nKeep their bullets\nAt every level", {
      size: { x: 360, y: 60 },
      textData: { characters: "Bulleted lists\nKeep their bullets\nAt every level", lines: [line("UNORDERED_LIST"), line("UNORDERED_LIST"), line("UNORDERED_LIST", 2)] },
    }),
    specimenText("4:5", "4:1", "$", 40, 230, "Numbered lists\nCount per level\nWith letters\nAnd back", {
      size: { x: 360, y: 80 },
      listSpacing: 4,
      textData: { characters: "Numbered lists\nCount per level\nWith letters\nAnd back", lines: [line("ORDERED_LIST"), line("ORDERED_LIST"), line("ORDERED_LIST", 2), line("ORDERED_LIST")] },
    }),
    specimenText("4:6", "4:1", "%", 40, 340, "Dotted and wavy underlines", {
      textData: {
        characters: "Dotted and wavy underlines",
        characterStyleIDs: runs(26, [[11, 15, 1]]),
        styleOverrideTable: [{ styleID: 1, textDecoration: "UNDERLINE", textDecorationStyle: "WAVY", textDecorationFillPaints: solidFill(0xf24822) }],
      },
      textDecoration: "UNDERLINE",
      textDecorationStyle: "DOTTED",
    }),
    specimenText("4:7", "4:1", "&", 40, 384, "Variable weight 850", { fontVariations: [{ axisTag: 2003265652, axisName: "Weight", value: 850 }], fontSize: 20 }),
    specimenText("4:8", "4:1", "'", 40, 424, "0123 1/2 tabular, slashed zero", { fontVariantNumericSpacing: "TABULAR", fontVariantSlashedZero: true, toggledOnOTFeatures: ["SS01"] }),
    specimenText("4:9", "4:1", "(", 40, 464, "A long line that does not fit in its box is truncated with an ellipsis", { textTruncation: "ENDING", maxLines: 1, size: { x: 240, y: 20 } }),
    node({ guid: "4:10", type: "ROUNDED_RECTANGLE", name: "Trim box", parentIndex: { guid: "4:1", position: ")" }, size: { x: 360, y: 24 }, transform: at(40, 520), fillPaints: solidFill(0xe5f4ff) }),
    specimenText("4:11", "4:1", "*", 40, 520, "Cap height to baseline", { leadingTrim: "CAP_HEIGHT", fontSize: 32, textAutoResize: "WIDTH_AND_HEIGHT", size: { x: 350, y: 24 } }),
    specimenText("4:12", "4:1", "+", 40, 580, "Balanced wrapping keeps the lines of a short paragraph about the same width.", { textWrapStyle: "BALANCE", size: { x: 360, y: 40 } }),
  ],
};
