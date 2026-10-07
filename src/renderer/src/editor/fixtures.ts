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
