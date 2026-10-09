/**
 * A layer's properties as the agents' tools read and write them — one table for create_nodes, update_nodes and
 * get_design_context (src/shared/agents/tools.ts), implemented in src/renderer/src/editor/agents/nodeSpec.ts (a test
 * checks both name the same properties, and that every field the Design panel edits is one of them).
 *
 * Two kinds:
 *   - Figma's Plugin API names for what agents know by them (layoutMode, itemSpacing, characters, fontSize,
 *     layoutSizingHorizontal …), each naming the document fields it stands for;
 *   - the rest of the panel's fields under the document's own names and shapes (schema/document.kiwi through
 *     docSchema.ts: textCase, paragraphSpacing, gridRowGap, arcData, exportSettings …).
 */
import { MODEL } from "../schema/model";
import { enumValues, structSchema, typeSchema } from "./docSchema";

type Obj = Record<string, unknown>;

export interface LayerPropInfo {
  schema: Obj;
  /** The document fields it reads and writes */
  fields: readonly string[];
}

const num = (description?: string): Obj => ({ type: "number", ...(description ? { description } : {}) });
const en = (values: readonly string[], description?: string): Obj => ({ enum: values, ...(description ? { description } : {}) });
const bool = (description?: string): Obj => ({ type: "boolean", ...(description ? { description } : {}) });

const paintList = (what: string): Obj => ({
  description: `${what}: "#RRGGBB" for one solid colour, [] for none, or a list of paints (bottom first) — ${"SOLID {color, opacity?}; GRADIENT_LINEAR / RADIAL / ANGULAR / DIAMOND {stops: [{color, position}], transform?}; IMAGE {imageRef, scaleMode?, rotation?, scale?, paintFilter?}; VIDEO {videoRef, imageRef?}; PATTERN {sourceNodeId, patternTileType?, scale?, patternSpacing?, horizontalAlignment?, verticalAlignment?}; NOISE {noiseType, color, density, noiseSize}"}; every paint takes visible and blendMode. Missing fields take the Design panel's defaults for that type.`,
  anyOf: [{ type: "string" }, { type: "array", items: { anyOf: [{ type: "string" }, structSchema("Paint", 1)] } }],
});

/** Figma-named properties. */
export const NAMED_PROPS: Record<string, LayerPropInfo> = {
  name: { schema: { type: "string" }, fields: ["name"] },
  visible: { schema: bool(), fields: ["visible"] },
  locked: { schema: bool(), fields: ["locked"] },
  opacity: { schema: num("0–1"), fields: ["opacity"] },
  blendMode: { schema: en(enumValues("BlendMode"), "Layer blend"), fields: ["blendMode"] },
  isMask: { schema: bool("Use as mask"), fields: ["mask"] },
  maskType: { schema: en(enumValues("MaskType")), fields: ["maskType"] },
  // Auto layout, as a container (frames, components, instances).
  layoutMode: { schema: en(["NONE", "HORIZONTAL", "VERTICAL", "GRID"], "Frames: auto layout direction (GRID: grid layout — gridRows / gridColumns / gridRowGap / gridColumnGap)."), fields: ["stackMode"] },
  itemSpacing: { schema: num("Gap between items"), fields: ["stackSpacing"] },
  padding: { schema: { anyOf: [{ type: "number" }, { type: "array", items: { type: "number" }, minItems: 2, maxItems: 4, description: "[vertical, horizontal] or [top, right, bottom, left]" }] }, fields: ["stackVerticalPadding", "stackPaddingRight", "stackPaddingBottom", "stackHorizontalPadding"] },
  paddingTop: { schema: num(), fields: ["stackVerticalPadding"] },
  paddingRight: { schema: num(), fields: ["stackPaddingRight"] },
  paddingBottom: { schema: num(), fields: ["stackPaddingBottom"] },
  paddingLeft: { schema: num(), fields: ["stackHorizontalPadding"] },
  primaryAxisAlignItems: { schema: en(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]), fields: ["stackPrimaryAlignItems"] },
  counterAxisAlignItems: { schema: en(["MIN", "CENTER", "MAX", "BASELINE"]), fields: ["stackCounterAlignItems"] },
  layoutWrap: { schema: en(["NO_WRAP", "WRAP"]), fields: ["stackWrap"] },
  counterAxisSpacing: { schema: num("Gap between wrapped rows"), fields: ["stackCounterSpacing"] },
  counterAxisAlignContent: { schema: en(["AUTO", "SPACE_BETWEEN"], "Wrapped rows"), fields: ["stackCounterAlignContent"] },
  primaryAxisSizingMode: { schema: en(["FIXED", "AUTO"], "AUTO = hug along the layout direction"), fields: ["stackPrimarySizing"] },
  counterAxisSizingMode: { schema: en(["FIXED", "AUTO"]), fields: ["stackCounterSizing"] },
  itemReverseZIndex: { schema: bool('Canvas stacking "First on top"'), fields: ["stackReverseZIndex"] },
  strokesIncludedInLayout: { schema: bool("Strokes included in layout"), fields: ["bordersTakeSpace"] },
  clipsContent: { schema: bool("Frames: clip content"), fields: ["frameMaskDisabled"] },
  // Text.
  characters: { schema: { type: "string", description: "TEXT: its text" }, fields: ["textData"] },
  fontFamily: { schema: { type: "string", description: 'TEXT: e.g. "Inter"' }, fields: ["fontName"] },
  fontStyle: { schema: { type: "string", description: 'TEXT: e.g. "Regular", "Semi Bold", "Bold"' }, fields: ["fontName"] },
  fontSize: { schema: num(), fields: ["fontSize"] },
  lineHeight: { schema: { anyOf: [{ type: "number", description: "px" }, { type: "string", description: '"auto" or "150%"' }] }, fields: ["lineHeight"] },
  letterSpacing: { schema: { anyOf: [{ type: "number", description: "px" }, { type: "string", description: '"2%" or "1px"' }] }, fields: ["letterSpacing"] },
  textAlignHorizontal: { schema: en(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]), fields: ["textAlignHorizontal"] },
  textAutoResize: { schema: en(["NONE", "WIDTH_AND_HEIGHT", "HEIGHT"], "NONE = fixed size, WIDTH_AND_HEIGHT = auto width, HEIGHT = auto height (wraps at its width)"), fields: ["textAutoResize"] },
  // Paints, strokes, effects, guides.
  fills: { schema: paintList("Fills"), fields: ["fillPaints"] },
  strokes: { schema: paintList("Strokes"), fields: ["strokePaints"] },
  strokeWeight: { schema: num(), fields: ["strokeWeight"] },
  strokeAlign: { schema: en(["INSIDE", "OUTSIDE", "CENTER"]), fields: ["strokeAlign"] },
  strokeCap: { schema: en(enumValues("StrokeCap")), fields: ["strokeCap"] },
  strokeJoin: { schema: en(enumValues("StrokeJoin")), fields: ["strokeJoin"] },
  strokeMiterLimit: { schema: num("Miter angle limit"), fields: ["miterLimit"] },
  strokeTopWeight: { schema: num("Per side (frames, rectangles): makes the sides independent"), fields: ["borderTopWeight", "borderStrokeWeightsIndependent"] },
  strokeRightWeight: { schema: num(), fields: ["borderRightWeight", "borderStrokeWeightsIndependent"] },
  strokeBottomWeight: { schema: num(), fields: ["borderBottomWeight", "borderStrokeWeightsIndependent"] },
  strokeLeftWeight: { schema: num(), fields: ["borderLeftWeight", "borderStrokeWeightsIndependent"] },
  effects: {
    schema: {
      type: "array",
      items: structSchema("Effect", 1),
      description:
        "The whole list (top first). Missing fields take the Design panel's defaults for the type. GLASS: radius (Frost, default 4), specularAngle (Light angle °, −45), specularIntensity (Light intensity 0–1, 0.8), refractionIntensity (Refraction 0–1, 0.8), bevelSize (Depth 0–100, 20), chromaticAberration (Dispersion 0–1, 0.5), refractionRadius (Splay 0–100, 0) — the Plugin API names lightAngle, lightIntensity, refraction, depth, dispersion, splay, frost are read too. LAYER_BLUR / BACKGROUND_BLUR: radius, blurOpType NORMAL | PROGRESSIVE (+ startRadius, startOffset, endOffset). NOISE: noiseType, color, secondaryColor (Duo), density, opacity (Multi), noiseSize, seed. TEXTURE: noiseSize, radius, clipToShape, seed.",
    },
    fields: ["effects"],
  },
  layoutGrids: { schema: { type: "array", items: structSchema("LayoutGrid", 1), description: 'Layout guides: [{pattern: "STRIPES", axis: "X", type: "STRETCH", numSections: 12, gutterSize: 20, offset: 40, color}] or {pattern: "GRID", sectionSize: 8}' }, fields: ["layoutGrids"] },
  // Corners.
  cornerRadius: { schema: { anyOf: [{ type: "number" }, { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "top-left, top-right, bottom-right, bottom-left" }] }, fields: ["cornerRadius", "rectangleCornerRadiiIndependent", "rectangleTopLeftCornerRadius", "rectangleTopRightCornerRadius", "rectangleBottomRightCornerRadius", "rectangleBottomLeftCornerRadius"] },
  cornerSmoothing: { schema: num("0–1 (iOS-like: 0.6)"), fields: ["cornerSmoothing"] },
  // Shapes.
  pointCount: { schema: num("Polygons and stars: points"), fields: ["count"] },
  innerRadius: { schema: num("Stars: ratio 0–1"), fields: ["starInnerScale"] },
  // Position and size.
  x: { schema: num("Relative to the parent (in an auto layout parent only with layoutPositioning ABSOLUTE)"), fields: ["transform"] },
  y: { schema: num(), fields: ["transform"] },
  rotation: { schema: num("Degrees"), fields: ["transform"] },
  width: { schema: num(), fields: ["size"] },
  height: { schema: num(), fields: ["size"] },
  constrainProportions: { schema: bool(), fields: ["proportionsConstrained"] },
  constraints: {
    schema: { type: "object", properties: { horizontal: en(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"], "MIN = Left, MAX = Right, STRETCH = Left & right"), vertical: en(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]) }, additionalProperties: false, description: "Outside auto layout" },
    fields: ["horizontalConstraint", "verticalConstraint"],
  },
  // In an auto layout parent.
  layoutPositioning: { schema: en(["AUTO", "ABSOLUTE"]), fields: ["stackPositioning"] },
  layoutSizingHorizontal: { schema: en(["FIXED", "HUG", "FILL"], "FILL needs an auto layout parent; HUG an auto layout frame or a text"), fields: ["stackChildPrimaryGrow", "stackChildAlignSelf", "stackPrimarySizing", "stackCounterSizing", "textAutoResize"] },
  layoutSizingVertical: { schema: en(["FIXED", "HUG", "FILL"]), fields: ["stackChildPrimaryGrow", "stackChildAlignSelf", "stackPrimarySizing", "stackCounterSizing", "textAutoResize"] },
  layoutGrow: { schema: num("0 or 1: fill along the parent's direction"), fields: ["stackChildPrimaryGrow"] },
  layoutAlign: { schema: en(["INHERIT", "STRETCH"], "STRETCH: fill across the parent's direction"), fields: ["stackChildAlignSelf"] },
  minWidth: { schema: num(), fields: ["minSize"] },
  maxWidth: { schema: num(), fields: ["maxSize"] },
  minHeight: { schema: num(), fields: ["minSize"] },
  maxHeight: { schema: num(), fields: ["maxSize"] },
  // Components.
  componentProperties: {
    schema: { type: "object", additionalProperties: { type: ["string", "boolean"] }, description: 'Instances: property values by name ("Label": "Buy", "Show icon": false, "Size": "Large" for a variant, an instance swap: a component id).' },
    fields: ["componentPropAssignments"],
  },
};

/** Text fields under the document's names (TEXT layers). */
export const RAW_TEXT_FIELDS = [
  "textAlignVertical", "textCase", "textDecoration", "paragraphSpacing", "paragraphIndent", "listSpacing", "hangingPunctuation", "hangingList",
  "leadingTrim", "textTruncation", "maxLines", "textDecorationStyle", "textDecorationSkipInk", "textUnderlineOffset", "textDecorationThickness",
  "textDecorationFillPaints", "fontVariations", "toggledOnOTFeatures", "toggledOffOTFeatures", "fontVariantCommonLigatures",
  "fontVariantContextualLigatures", "fontVariantDiscretionaryLigatures", "fontVariantHistoricalLigatures", "fontVariantOrdinal",
  "fontVariantSlashedZero", "fontVariantNumericFigure", "fontVariantNumericSpacing", "fontVariantNumericFraction", "fontVariantCaps",
  "fontVariantPosition", "textWrapStyle", "hyperlink",
] as const;

/** Grid layout fields under the document's names (frames with layoutMode GRID, and their children). */
export const RAW_GRID_FIELDS = [
  "gridRows", "gridColumns", "gridRowGap", "gridColumnGap", "gridRowsSizing", "gridColumnsSizing", "gridAutoTracks", "gridReflowEnabled",
  "gridRowSpan", "gridColumnSpan", "gridRowAnchor", "gridColumnAnchor", "gridChildHorizontalAlign", "gridChildVerticalAlign",
] as const;

/** Other panel fields under the document's names. */
export const RAW_OTHER_FIELDS = [
  "arcData", "booleanOperation", "dashPattern", "variableWidthPoints", "dynamicStrokeSettings", "exportSettings", "guides", "resizeToFit",
  "backgroundColor", "backgroundEnabled", "symbolLinks", "description", "propsAreBubbled",
] as const;

export const RAW_FIELDS: readonly string[] = [...RAW_TEXT_FIELDS, ...RAW_GRID_FIELDS, ...RAW_OTHER_FIELDS];

const RAW_DOC: Record<string, string> = {
  arcData: "Ellipses: {startingAngle, endingAngle, innerRadius} (radians; innerRadius 0–1)",
  booleanOperation: "Boolean groups: UNION | INTERSECT | SUBTRACT | XOR",
  dashPattern: "Dashed strokes: [dash, gap, …]",
  exportSettings: "Export settings (as the Export section)",
  backgroundColor: "Pages: the canvas colour",
  textCase: "TEXT", textDecoration: "TEXT", paragraphSpacing: "TEXT", paragraphIndent: "TEXT", listSpacing: "TEXT", maxLines: "TEXT (with textTruncation ENDING)",
};

/** The JSON Schema of every layer property (create_nodes' specs, update_nodes' updates). */
export function layerPropsSchema(): Obj {
  const out: Obj = {};
  for (const [k, p] of Object.entries(NAMED_PROPS)) out[k] = p.schema;
  const nc = MODEL.def("NodeChange");
  for (const f of RAW_FIELDS) {
    const def = nc.byName.get(f);
    if (!def) continue;
    const s = typeSchema(def.type!, def.isArray, 1);
    out[f] = RAW_DOC[f] ? { ...s, description: [RAW_DOC[f], (s as { description?: string }).description].filter(Boolean).join("; ") } : s;
  }
  return out;
}

/** Document field → the property that writes it (for "unknown property" errors naming the right one). */
export function propForField(field: string): string | null {
  if (RAW_FIELDS.includes(field)) return field;
  for (const [k, p] of Object.entries(NAMED_PROPS)) if (p.fields.length && p.fields[0] === field) return k;
  for (const [k, p] of Object.entries(NAMED_PROPS)) if (p.fields.includes(field)) return k;
  return null;
}

/** Every property name. */
export const LAYER_PROP_NAMES: readonly string[] = [...Object.keys(NAMED_PROPS), ...RAW_FIELDS];
