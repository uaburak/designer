/**
 * The engine's payload encoding, TS side — the twin of engine/src/scene/CodecJson.
 *
 * Interim (E1): JSON with schema/document.kiwi's names and meanings
 * (docs/schema.md §4), UTF-8 through the module's memory. This file and the
 * C++ codec are the only two places that know the encoding: when the kiwi
 * codecs exist (engine/tools/schemagen), they change and nothing else — the
 * types below become the generated ones.
 */

/** A node's GUID, `"sessionID:localID"`. */
export type Guid = string;

export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}
export interface Vector {
  x: number;
  y: number;
}
/** 2×3 affine, relative to the parent: x' = m00·x + m01·y + m02, y' = m10·x + m11·y + m12. */
export interface Matrix {
  m00: number;
  m01: number;
  m02: number;
  m10: number;
  m11: number;
  m12: number;
}
export interface ParentIndex {
  guid: Guid;
  position: string;
}
export type BlendMode =
  | "PASS_THROUGH" | "NORMAL" | "DARKEN" | "MULTIPLY" | "LINEAR_BURN" | "COLOR_BURN" | "LIGHTEN" | "SCREEN" | "LINEAR_DODGE"
  | "COLOR_DODGE" | "OVERLAY" | "SOFT_LIGHT" | "HARD_LIGHT" | "DIFFERENCE" | "EXCLUSION" | "HUE" | "SATURATION" | "COLOR"
  | "LUMINOSITY";
export type PaintType = "SOLID" | "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND" | "IMAGE";
/** STRETCH = "Crop" in the UI. */
export type ImageScaleMode = "STRETCH" | "FIT" | "FILL" | "TILE";
export interface ColorStop {
  color: Color;
  position: number;
}
/** Image adjustments, each −1…1 (0 = unchanged); `vibrance` is the UI's "Saturation". */
export interface PaintFilter {
  exposure?: number;
  contrast?: number;
  vibrance?: number;
  temperature?: number;
  tint?: number;
  highlights?: number;
  shadows?: number;
  [other: string]: number | undefined;
}
export interface Image {
  /** The SHA-1 of the image file's bytes, as 20 numbers (a 40-digit hex string is read too). */
  hash?: number[] | string;
  name?: string;
  /** Clipboard only: an index into the Message's blobs holding the image file's bytes. */
  dataBlob?: number;
}
/**
 * A paint (every kind is drawn). Fields the engine doesn't use (colorVar, stopsVar, imageThumbnail, thumbHash…)
 * come back exactly as they went in.
 */
export interface Paint {
  type: PaintType | (string & {});
  color?: Color;
  opacity?: number;
  visible?: boolean;
  blendMode?: BlendMode;
  /** Gradients. */
  stops?: ColorStop[];
  /** Gradients and images: Figma's matrix from the node's unit square to paint space (gradient: t along x). */
  transform?: Matrix;
  image?: Image;
  imageScaleMode?: ImageScaleMode;
  /** Image rotation in degrees (multiples of 90). */
  rotation?: number;
  /** TILE scale. */
  scale?: number;
  paintFilter?: PaintFilter;
  originalImageWidth?: number;
  originalImageHeight?: number;
  /** Variable bindings (docs/schema.md §6.3): the colour (an alias or a composed colour), the opacity (a FLOAT, in %). */
  colorVar?: VariableData;
  opacityVar?: VariableData;
  /** Gradient stops' bindings, index-aligned with `stops`. */
  stopsVar?: { color: Color; colorVar?: VariableData; position: number }[];
  [other: string]: unknown;
}
export type EffectType = "INNER_SHADOW" | "DROP_SHADOW" | "FOREGROUND_BLUR" | "BACKGROUND_BLUR" | "GRAIN" | "NOISE" | "GLASS";
/** An effect: FOREGROUND_BLUR is the UI's "Layer blur". Other fields are kept as given. */
export interface Effect {
  type: EffectType;
  color?: Color;
  offset?: Vector;
  radius?: number;
  visible?: boolean;
  blendMode?: BlendMode;
  spread?: number;
  /** "Show behind transparent areas". */
  showShadowBehindNode?: boolean;
  /** Variable bindings. */
  colorVar?: VariableData;
  radiusVar?: VariableData;
  spreadVar?: VariableData;
  xVar?: VariableData;
  yVar?: VariableData;
  [other: string]: unknown;
}
export type StrokeCap = "NONE" | "ROUND" | "SQUARE" | "ARROW_LINES" | "ARROW_EQUILATERAL" | "DIAMOND_FILLED" | "TRIANGLE_FILLED" | "CIRCLE_FILLED";
export type StrokeJoin = "MITER" | "BEVEL" | "ROUND";
/** OUTLINE = Figma's "Vector" mask. */
export type MaskType = "ALPHA" | "OUTLINE" | "LUMINANCE";
export type VectorMirror = "NONE" | "ANGLE" | "ANGLE_AND_LENGTH";
/** XOR = "Exclude". */
export type BooleanOperation = "UNION" | "INTERSECT" | "SUBTRACT" | "XOR";
export type VectorEditTool = "MOVE" | "PEN" | "BEND" | "LASSO" | "PAINT_BUCKET";
/** A layout guide ("Layout grid"): columns (axis X), rows (axis Y) or a square grid. */
export interface LayoutGrid {
  type?: "MIN" | "CENTER" | "STRETCH" | "MAX";
  axis?: "X" | "Y";
  visible?: boolean;
  numSections?: number;
  offset?: number;
  sectionSize?: number;
  gutterSize?: number;
  color?: Color;
  pattern?: "STRIPES" | "GRID";
  /** Variable bindings. */
  numSectionsVar?: VariableData;
  offsetVar?: VariableData;
  sectionSizeVar?: VariableData;
  gutterSizeVar?: VariableData;
  [other: string]: unknown;
}
export interface ArcData {
  /** Radians. */
  startingAngle: number;
  endingAngle: number;
  /** 0–1 of the radius. */
  innerRadius: number;
}
/** Per-vertex / segment / region styles of a vector network (keyed by styleID ≥ 1). */
export interface VectorStyleOverride {
  styleID: number;
  fillPaints?: Paint[];
  strokeCap?: StrokeCap;
  strokeJoin?: StrokeJoin;
  handleMirroring?: VectorMirror;
  cornerRadius?: number;
  [other: string]: unknown;
}
export interface VectorData {
  /** An index into the Message's blobs: the network (docs/schema.md §11.3). */
  vectorNetworkBlob?: number;
  /** The size the network's coordinates are in (the node's `size` scales it). */
  normalizedSize?: Vector;
  styleOverrideTable?: VectorStyleOverride[];
}

/**
 * Node types. The engine draws DOCUMENT…SECTION and TEXT; the others (VECTOR, BOOLEAN_OPERATION, STAR, LINE,
 * REGULAR_POLYGON, SLICE, VARIABLE, VARIABLE_SET) keep their type and every field the engine doesn't model.
 */
export type NodeType =
  | "DOCUMENT" | "CANVAS" | "GROUP" | "FRAME" | "ELLIPSE" | "RECTANGLE" | "ROUNDED_RECTANGLE"
  | "SYMBOL" | "INSTANCE" | "SECTION" | "TEXT" | "BOOLEAN_OPERATION" | "VECTOR" | "STAR" | "LINE"
  | "REGULAR_POLYGON" | "SLICE" | "VARIABLE" | "VARIABLE_SET" | "NONE";
export type StrokeAlign = "CENTER" | "INSIDE" | "OUTSIDE";

/** Auto layout and constraints (schema/document.kiwi's enums). */
export type StackMode = "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
export type StackAlign = "MIN" | "CENTER" | "MAX" | "BASELINE";
export type StackCounterAlign = "MIN" | "CENTER" | "MAX" | "STRETCH" | "AUTO" | "BASELINE";
export type StackJustify = "MIN" | "CENTER" | "MAX" | "SPACE_EVENLY" | "SPACE_BETWEEN" | "SPACE_AROUND" | "SPACE_EVENLY_CSS";
export type StackSize = "FIXED" | "RESIZE_TO_FIT" | "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE";
export type StackPositioning = "AUTO" | "ABSOLUTE";
export type StackWrap = "NO_WRAP" | "WRAP";
export type StackCounterAlignContent = "AUTO" | "SPACE_BETWEEN";
export type ConstraintType = "MIN" | "CENTER" | "MAX" | "STRETCH" | "SCALE" | "FIXED_MIN" | "FIXED_MAX";
/** minSize / maxSize: an axis value of 0 = no limit. */
export interface OptionalVector {
  value: Vector;
}

/** Text (schema/document.kiwi's Text section). */
export interface FontName {
  family: string;
  style: string;
  postscript?: string;
}
export type NumberUnits = "RAW" | "PIXELS" | "PERCENT";
/**
 * lineHeight: {100, PERCENT} = "Auto" (the font's own line height, rounded), {k, RAW} = k × font size (the UI's
 * k·100 %), {v, PIXELS}. letterSpacing: PERCENT of the font size, or PIXELS.
 */
export interface NumberValue {
  value: number;
  units: NumberUnits;
}
export type TextAlignHorizontal = "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
export type TextAlignVertical = "TOP" | "CENTER" | "BOTTOM";
/** NONE = Fixed size, WIDTH_AND_HEIGHT = Auto width, HEIGHT = Auto height. */
export type TextAutoResize = "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT";
export type TextTruncation = "DISABLED" | "ENDING";
export type TextCase = "ORIGINAL" | "UPPER" | "LOWER" | "TITLE" | "SMALL_CAPS" | "SMALL_CAPS_FORCED";
export type TextDecoration = "NONE" | "UNDERLINE" | "STRIKETHROUGH";
/** A run style of TextData.styleOverrideTable (keyed by styleID ≥ 1); only the fields it overrides. */
export interface TextStyleOverride {
  styleID: number;
  fontName?: FontName;
  fontSize?: number;
  lineHeight?: NumberValue;
  letterSpacing?: NumberValue;
  textCase?: TextCase;
  textDecoration?: TextDecoration;
  fillPaints?: Paint[];
  [other: string]: unknown;
}
/** A TEXT node's source: one property, replaced whole by edits. Offsets are UTF-16 code units. */
export interface TextData {
  /** Paragraphs split by "\n"; U+2028 is a line break inside a paragraph. */
  characters: string;
  /** The style id of each UTF-16 unit; a shorter array means the rest are 0 (the node's own style). */
  characterStyleIDs?: number[];
  styleOverrideTable?: TextStyleOverride[];
  /** TextLineData per paragraph (lists come with E3.2), kept as given. */
  lines?: unknown[];
}

/** The NodeChange fields the engine keeps so far (schema/document.kiwi names). Absent = the absence value (docs/schema.md §3.4). */
export interface NodeFields {
  parentIndex?: ParentIndex;
  type?: NodeType;
  name?: string;
  visible?: boolean;
  locked?: boolean;
  opacity?: number;
  size?: Vector;
  transform?: Matrix;
  cornerRadius?: number;
  rectangleCornerRadiiIndependent?: boolean;
  rectangleTopLeftCornerRadius?: number;
  rectangleTopRightCornerRadius?: number;
  rectangleBottomRightCornerRadius?: number;
  rectangleBottomLeftCornerRadius?: number;
  strokeWeight?: number;
  strokeAlign?: StrokeAlign;
  fillPaints?: Paint[];
  strokePaints?: Paint[];
  frameMaskDisabled?: boolean;
  resizeToFit?: boolean;
  backgroundColor?: Color;
  backgroundEnabled?: boolean;
  internalOnly?: boolean;
  // Auto layout, as a container (absent stackPrimarySizing = Hug).
  stackMode?: StackMode;
  stackSpacing?: number;
  /** Left padding. */
  stackHorizontalPadding?: number;
  /** Top padding. */
  stackVerticalPadding?: number;
  stackPaddingRight?: number;
  stackPaddingBottom?: number;
  stackPrimarySizing?: StackSize;
  stackCounterSizing?: StackSize;
  stackPrimaryAlignItems?: StackJustify;
  stackCounterAlignItems?: StackAlign;
  stackCounterAlignContent?: StackCounterAlignContent;
  stackWrap?: StackWrap;
  /** Absent = the same as stackSpacing. */
  stackCounterSpacing?: number;
  stackReverseZIndex?: boolean;
  bordersTakeSpace?: boolean;
  // Auto layout, as a child.
  stackChildPrimaryGrow?: number;
  stackChildAlignSelf?: StackCounterAlign;
  stackPositioning?: StackPositioning;
  minSize?: OptionalVector;
  maxSize?: OptionalVector;
  // Constraints.
  horizontalConstraint?: ConstraintType;
  verticalConstraint?: ConstraintType;
  proportionsConstrained?: boolean;
  // Text (TEXT nodes; absent = Inter Regular 12, Auto line height, 0% letter spacing, Fixed size, left, top).
  textData?: TextData;
  fontName?: FontName;
  fontSize?: number;
  lineHeight?: NumberValue;
  letterSpacing?: NumberValue;
  paragraphSpacing?: number;
  paragraphIndent?: number;
  textAlignHorizontal?: TextAlignHorizontal;
  textAlignVertical?: TextAlignVertical;
  textAutoResize?: TextAutoResize;
  textTruncation?: TextTruncation;
  /** With textTruncation ENDING; absent / 0 = no limit. */
  maxLines?: number;
  textCase?: TextCase;
  textDecoration?: TextDecoration;
  /** The layer name follows the characters until the layer is renamed. */
  autoRename?: boolean;
  // Paint, stroke, effects, masks (E4/E5).
  /** Absent = PASS_THROUGH. */
  blendMode?: BlendMode;
  /** "Use as mask": masks the layers above it in its parent. */
  mask?: boolean;
  maskType?: MaskType;
  strokeCap?: StrokeCap;
  strokeJoin?: StrokeJoin;
  /** Absent = 4. */
  miterLimit?: number;
  /** Dash, gap, dash, gap… in px. */
  dashPattern?: number[];
  borderTopWeight?: number;
  borderRightWeight?: number;
  borderBottomWeight?: number;
  borderLeftWeight?: number;
  borderStrokeWeightsIndependent?: boolean;
  /** 0–1 (iOS = 0.6). */
  cornerSmoothing?: number;
  effects?: Effect[];
  // Shapes and vectors.
  /** REGULAR_POLYGON / STAR point count. */
  count?: number;
  /** STAR "Ratio" (0–1). */
  starInnerScale?: number;
  /** ELLIPSE arcs, pies and donuts. */
  arcData?: ArcData;
  vectorData?: VectorData;
  handleMirroring?: VectorMirror;
  booleanOperation?: BooleanOperation;
  /** Layout guides on a frame. */
  layoutGrids?: LayoutGrid[];
  // ---- Components and instances (docs/schema.md §5; GUIDs inside are {sessionID, localID} objects, "s:l" read too) ----
  overrideKey?: GuidValue;
  symbolData?: SymbolData;
  overriddenSymbolID?: GuidValue;
  componentPropDefs?: ComponentPropDef[];
  componentPropAssignments?: ComponentPropAssignment[];
  parameterConsumptionMap?: { entries: ParameterEntry[] };
  isStateGroup?: boolean;
  variantPropSpecs?: { propDefId: GuidValue; value: string }[];
  stateGroupPropertyValueOrders?: { property: string; values: string[] }[];
  propsAreBubbled?: boolean;
  isSlot?: boolean;
  isSlotContent?: boolean;
  detachedSymbolId?: { guid: GuidValue };
  isSoftDeleted?: boolean;
  ancestorPathBeforeDeletion?: GuidValue[];
  // ---- Variables, modes, styles (docs/schema.md §6; docs/engine-build.md "E6 variables") ----
  /** Explicit modes ("Apply variable mode"): no entry for a collection = Auto. Any node, pages included. */
  variableModeBySetMap?: { entries: { variableSetID: AssetId; variableModeID: GuidValue }[] };
  /** Style references; the node's own fields hold the style's values. */
  styleIdForFill?: AssetId;
  styleIdForStrokeFill?: AssetId;
  styleIdForText?: AssetId;
  styleIdForEffect?: AssetId;
  styleIdForGrid?: AssetId;
  /** A style node (under the internal canvas). */
  styleType?: StyleType | "NONE";
  /** Styles, collections, variables: their order in the panels (fractional index). */
  sortPosition?: string;
  description?: string;
  /** Assets: the stable 40-hex key. */
  key?: string;
  /** Absent = true; false = "Hide when publishing". */
  isPublishable?: boolean;
  /** VARIABLE_SET: its modes (the default is the first by sortPosition). */
  variableSetModes?: { id: GuidValue; name: string; sortPosition: string }[];
  /** VARIABLE: its collection. */
  variableSetID?: AssetId;
  variableResolvedType?: VariableResolvedType;
  /** VARIABLE: one value per mode. */
  variableDataValues?: { entries: { modeID: GuidValue; variableData: VariableData }[] };
  /** Absent = ["ALL_SCOPES"]; [] = shown in no picker. */
  variableScopes?: VariableScope[];
  codeSyntax?: { entries: { platform: CodeSyntaxPlatform; value: string }[] };
  // Libraries (docs/schema.md §8).
  /** A library copy: the versionHash it was copied at. */
  version?: string;
  /** A local asset: its versionHash at its last publish. */
  publishedVersion?: string;
  /** A library copy's root: its library's FileKey. */
  sourceLibraryKey?: string;
  /** A library copy (and every SYMBOL / set inside one): the asset's GUID in its library file. */
  publishID?: GuidValue;
  /** A published main cut from another file and pasted here (Move to this file). */
  libraryMoveInfo?: { oldKey: string; pasteFileKey: string };
  /** Kiwi field ids reset to absent (updates only). */
  clearedFields?: number[];
}

// ---- Variables (docs/schema.md §6) ----

export type VariableResolvedType = "BOOLEAN" | "FLOAT" | "STRING" | "COLOR" | "EASING" | "TIMING";
/** STROKE = "Stroke color" (the plugin API's STROKE_COLOR is read too). */
export type VariableScope =
  | "ALL_SCOPES" | "TEXT_CONTENT" | "CORNER_RADIUS" | "WIDTH_HEIGHT" | "GAP" | "ALL_FILLS" | "FRAME_FILL" | "SHAPE_FILL"
  | "TEXT_FILL" | "STROKE" | "STROKE_FLOAT" | "EFFECT_FLOAT" | "EFFECT_COLOR" | "OPACITY" | "FONT_STYLE" | "FONT_FAMILY"
  | "FONT_SIZE" | "LINE_HEIGHT" | "LETTER_SPACING" | "PARAGRAPH_SPACING" | "PARAGRAPH_INDENT" | "FONT_VARIATIONS" | "TRANSFORM"
  | "COLOR_OPACITY";
export type CodeSyntaxPlatform = "WEB" | "ANDROID" | "iOS";
/** FILL = "Color style", GRID = "Layout guide style". */
export type StyleType = "FILL" | "TEXT" | "EFFECT" | "GRID";
/** A reference to an asset: by GUID (what DesignerV2 writes), or by a library key (imported .fig files). */
export interface AssetId {
  guid?: GuidValue;
  assetRef?: { key: string; version?: string };
}
/** schema VariableData: a literal, an alias, a composed colour (COMPOSE_COLOR), a font style, a property reference. */
export interface VariableData {
  value?: {
    boolValue?: boolean;
    textValue?: string;
    floatValue?: number;
    alias?: AssetId;
    colorValue?: Color;
    expressionValue?: { expressionFunction: string; expressionArguments?: VariableData[] };
    fontStyleValue?: { asString?: VariableData; asFloat?: VariableData; asVariations?: VariableData };
    propRefValue?: { defId: GuidValue };
    [other: string]: unknown;
  };
  dataType?: string;
  resolvedDataType?: string;
  [other: string]: unknown;
}

/** A value as the panels read and write it (Figma's plugin shapes). */
export interface VariableAlias {
  type: "VARIABLE_ALIAS";
  id: Guid | null;
}
/** "Control opacity at scale": a colour (or an alias) with its own opacity (%, or an alias to a number). */
export interface ComposedColor {
  color: Color | VariableAlias;
  opacity: number | VariableAlias;
}
export type VariableValue = boolean | number | string | Color | VariableAlias | ComposedColor;
/** A value with every alias followed (EASING: its raw data). */
export type ResolvedVariableValue = boolean | number | string | Color | Record<string, unknown>;
/**
 * What a binding binds: a VariableField name for node fields ("WIDTH", "OPACITY", "STACK_SPACING", "FONT_SIZE"…) or a
 * list member: "fillPaints[i].color" | ".opacity" | ".stops[j].color", the same for strokePaints,
 * "effects[i].color" | ".radius" | ".spread" | ".x" | ".y", "layoutGrids[i].numSections" | ".offset" | ".sectionSize" | ".gutterSize".
 */
export type BindingTarget = string;

/** engine.variableCollections(). */
export interface VariableCollectionInfo {
  id: Guid;
  name: string;
  modes: { modeId: Guid; name: string }[];
  defaultModeId: Guid | null;
  variableIds: Guid[];
  hiddenFromPublishing: boolean;
  key: string;
  description: string;
  /** A library copy (read-only). */
  remote: boolean;
  /** A library copy's library (FileKey); null for local ones. */
  libraryKey: string | null;
}
/** engine.variables() / engine.variable(). */
export interface VariableInfo {
  id: Guid;
  name: string;
  collectionId: Guid | null;
  resolvedType: VariableResolvedType;
  valuesByMode: Record<Guid, VariableValue | null>;
  resolvedValuesByMode: Record<Guid, ResolvedVariableValue | null>;
  scopes: VariableScope[];
  codeSyntax: Partial<Record<CodeSyntaxPlatform, string>>;
  description: string;
  hiddenFromPublishing: boolean;
  key: string;
  /** Deleted while something still uses it (Figma's deletedButReferenced). */
  deletedButReferenced: boolean;
  remote: boolean;
  libraryKey: string | null;
}
/** engine.boundVariables(): one per binding of a node. */
export interface BoundVariable {
  target: BindingTarget;
  /** The alias (a composed colour: its colour's alias). */
  variable: Guid | null;
  value: VariableValue | null;
  resolved: ResolvedVariableValue | null;
}
/** engine.variableModes(): a layer's or page's mode for every collection. */
export interface VariableModeInfo {
  collectionId: Guid;
  /** Its own ("Apply variable mode"); null = Auto. */
  explicitModeId: Guid | null;
  resolvedModeId: Guid | null;
}
/** engine.styles(). */
export interface StyleInfo {
  id: Guid;
  name: string;
  styleType: StyleType;
  description: string;
  key: string;
  hiddenFromPublishing: boolean;
  usageCount: number;
  remote: boolean;
  libraryKey: string | null;
  fillPaints?: Paint[];
  effects?: Effect[];
  layoutGrids?: LayoutGrid[];
  text?: {
    fontName: FontName;
    fontSize: number;
    lineHeight: NumberValue;
    letterSpacing: NumberValue;
    paragraphSpacing: number;
    paragraphIndent: number;
    textCase: TextCase;
    textDecoration: TextDecoration;
  };
  boundVariables: BoundVariable[];
}
/** engine.runCommand(): the status, and what the command created. */
export interface CommandResult {
  status: number;
  created: Guid[];
}

/** A GUID inside a structure (symbolData, property defs…), as decoded .fig files write it. */
export interface GuidValue {
  sessionID: number;
  localID: number;
}
export type ComponentPropType = "BOOL" | "TEXT" | "INSTANCE_SWAP" | "VARIANT" | "SLOT";
export interface ComponentPropValue {
  boolValue?: boolean;
  textValue?: { characters: string } & Record<string, unknown>;
  guidValue?: GuidValue;
}
export interface ComponentPropDef {
  id: GuidValue;
  name: string;
  type: ComponentPropType;
  initialValue?: ComponentPropValue;
  sortPosition?: string;
  preferredValues?: { instanceSwapValues?: { type: "COMPONENT" | "STATE_GROUP"; key: string }[]; [other: string]: unknown };
  description?: string;
  [other: string]: unknown;
}
export interface ComponentPropAssignment {
  defID: GuidValue;
  value?: ComponentPropValue;
  [other: string]: unknown;
}
export interface ParameterEntry {
  variableField: string;
  /** PROP_REF (a component property), ALIAS / COMPOSE_COLOR / FONT_STYLE (a variable). */
  variableData: VariableData;
}
/** One override entry: the overridden fields of the sublayer at `guidPath` (empty or absent: the instance root). */
export type SymbolOverride = NodeFields & { guidPath?: { guids?: GuidValue[] } } & Record<string, unknown>;
export interface SymbolData {
  symbolID?: GuidValue;
  symbolOverrides?: SymbolOverride[];
  uniformScaleFactor?: number;
}

/** A component property as the panels show it (engine.componentInfo). */
export interface ComponentProperty {
  id: Guid;
  name: string;
  /** Figma's `Name#id` (a VARIANT property: its name). */
  apiName: string;
  type: ComponentPropType;
  /** BOOL: boolean; TEXT and VARIANT: string; INSTANCE_SWAP and SLOT: a GUID; null when none. */
  defaultValue: boolean | string | null;
  value: boolean | string | null;
  /** The instance set it itself (not the default). */
  overridden: boolean;
  preferredValues: Guid[];
  variantOptions: string[];
  boundLayers: Guid[];
}
/** What a node is on the component side and what the panels show for it (engine.componentInfo). */
export interface ComponentInfo {
  ref: Guid;
  kind: "COMPONENT" | "VARIANT" | "COMPONENT_SET" | "INSTANCE" | "NESTED_INSTANCE" | "INSTANCE_SUBLAYER" | "COMPONENT_SUBLAYER" | "NONE";
  main: {
    ref: Guid;
    name: string;
    page: Guid | null;
    set: Guid | null;
    softDeleted: boolean;
    /** A library copy's main: its library, key and the version copied. */
    remote: { libraryKey: string; key: string; version: string } | null;
    /** A main copied in from another file (unpublished there), kept on the internal canvas. */
    copied: boolean;
  } | null;
  /** A sublayer or nested instance: the top-level instance holding it. */
  instance: Guid | null;
  /** Its guidPath (override keys) from that instance. */
  path: Guid[];
  /** The changes ("overrides"): per sublayer (the instance root: the instance's ref), the schema fields changed. */
  overrides: { ref: Guid; fields: string[] }[];
  properties: ComponentProperty[];
  exposedInstances: { ref: Guid; name: string; properties: ComponentProperty[] }[];
  variantProperties: Record<string, string> | null;
  canPush: boolean;
  canReset: boolean;
  canDetach: boolean;
  isExposed: boolean;
  mainDeleted: boolean;
  instanceCount: number;
}

export interface NodeChange extends NodeFields {
  guid: Guid;
  /** Absent: an update of an existing node. */
  phase?: "CREATED" | "REMOVED";
  /** engine_read_nodes with INCLUDE_CHILD_IDS: the children, back to front (not a schema field). */
  childIds?: Guid[];
}

/** A clipboard Message's region: the copied layers that shared a parent, and where that parent's origin was on its page. */
export interface ClipboardSelectionRegion {
  parent: Guid;
  nodes: Guid[];
  enclosingFrameOffset: Vector;
}

export interface Message {
  type: "NODE_CHANGES";
  sessionID: number;
  nodeChanges: NodeChange[];
  /**
   * The Message's blobs as base64 strings (kiwi's `Message.blobs`): blob-index fields (`vectorData.vectorNetworkBlob`,
   * `fillGeometry[i].commandsBlob`, `Image.dataBlob`) index into it.
   */
  blobs?: string[];
  /** Clipboard Messages (docs/schema.md §4.1): the page copied from, and each source parent's place. */
  pastePageId?: Guid;
  clipboardSelectionRegions?: ClipboardSelectionRegion[];
  /** Clipboard: the FileKey of the file it was copied from (engine.setFileKey); another file's paste is cross-file. */
  pasteFileKey?: string;
  /** Clipboard: a cut (⌘X). */
  isCut?: boolean;
}

// ---- Libraries (docs/data.md §9, docs/engine-build.md "E6 libraries") ----

export type AssetKind = "COMPONENT" | "COMPONENT_SET" | "STYLE" | "VARIABLE_COLLECTION" | "VARIABLE";
/** engine.localAssets(): a local asset, publishable or not. */
export interface LocalAssetInfo {
  id: Guid;
  /** "" until ensureAssetKeys / encodeAssets gives it one. */
  key: string;
  kind: AssetKind;
  name: string;
  description: string;
  styleType?: StyleType;
  resolvedType?: VariableResolvedType;
  /** A variant: its set. */
  componentSetKey?: string;
  componentSetId?: Guid;
  /** A variable: its collection. */
  collectionKey?: string;
  collectionId?: Guid;
  /** Hide when publishing, a name starting with "." or "_", or a hidden set / collection. */
  hiddenFromPublishing: boolean;
  /** Deleted but kept for what uses it ("Removed" when publishedVersion is set). */
  softDeleted: boolean;
  /** 40-hex SHA-1 of the asset's content. */
  versionHash: string;
  publishedVersion: string | null;
  /** Keys of this file's assets it needs. */
  dependencies: string[];
  containingFrame: { pageId: Guid; pageName: string; frameId?: Guid; frameName?: string } | null;
}
/** engine.encodeAssets(): an asset and its payload (its nodes and every node it depends on, library GUIDs). */
export interface EncodedAsset extends LocalAssetInfo {
  dependencyOnly: boolean;
  message: Message;
  /** Image hashes the payload's nodes use (a consumer's file needs them: blobRefs). */
  images: string[];
}
/** engine.importLibraryAssets / engine.applyLibraryUpdate options. */
export interface LibraryImportOptions {
  libraryKey: string;
  /**
   * importLibraryAssets: a new, complete copy of the asked assets (new GUIDs, every child and variant) even when
   * copies of them are here (Update selected instance); the result's `id` for those keys is the new copy. The asked
   * assets: `keys`, default the first message's own asset (getPayloads puts the asked one first). Dependencies are
   * reused as usual.
   */
  asNew?: boolean;
  /** applyLibraryUpdate: only these keys are replaced (default: every asset in the messages that has a copy here). With asNew: the assets that get new copies. */
  keys?: string[];
  /** applyLibraryUpdate: only these copy roots are replaced (default: every copy of each key — a file can hold several). */
  copies?: Guid[];
  /**
   * applyLibraryUpdate: Move to this file — the copies of fromKey (from fromLibraryKey; absent: from any library)
   * become toKey's (toKey's payload in the messages, or this file's own asset toKey).
   */
  redirects?: { fromKey: string; toKey: string; fromLibraryKey?: string }[];
}
export type LibraryUpdateOptions = LibraryImportOptions;
export interface LibraryImportResult {
  status: number;
  /** Every copy written or reused (several copies of one key: each listed with its own id). */
  assets: { key: string; id: Guid; kind: AssetKind; libraryKey: string; version: string; created: boolean; updated: boolean }[];
  /** Image hashes the copies written or reused use (the file's blobRefs need them). */
  images: string[];
}
/** engine.libraryUsage(): a library copy in this file. */
export interface LibraryAssetUsage {
  id: Guid;
  key: string;
  kind: AssetKind;
  name: string;
  description: string;
  libraryKey: string;
  version: string;
  publishID: Guid | null;
  usageCount: number;
  componentSetKey?: string;
  componentSetId?: Guid;
  collectionKey?: string;
  collectionId?: Guid;
  styleType?: StyleType;
  resolvedType?: VariableResolvedType;
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Selection {
  pageId: Guid;
  refs: Guid[];
}

export interface PageInfo {
  guid: Guid;
  name: string;
}

export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string;
  redoLabel: string;
}

export type CursorKind =
  | "DEFAULT" | "HAND" | "GRABBING" | "CROSSHAIR" | "PEN" | "PEN_ADD" | "PEN_REMOVE" | "PEN_CLOSE" | "IBEAM"
  | "RESIZE" | "ROTATE" | "MOVE_DUPLICATE" | "ZOOM_IN" | "ZOOM_OUT" | "EYEDROPPER" | "NOT_ALLOWED";

/** Engine → JS events (docs/engine.md §10.4), drained after every call. */
export type EngineEvent =
  | { type: "DOCUMENT_CHANGED"; kind: "USER" | "UNDO" | "REDO" | "SYSTEM"; label: string; message: Message }
  | { type: "NODES_CHANGED"; refs: Guid[]; fieldGroupMask: number[] }
  | { type: "STRUCTURE_CHANGED"; pageId: Guid }
  | { type: "PAGES_CHANGED"; pageId: Guid }
  | { type: "CURRENT_PAGE_CHANGED"; pageId: Guid }
  | ({ type: "SELECTION_CHANGED" } & Selection)
  | ({ type: "CAMERA_CHANGED" } & Camera)
  | { type: "TOOL_CHANGED"; tool: string }
  | { type: "CURSOR"; kind: CursorKind; angleDeg: number }
  | { type: "HOVER_CHANGED"; ref: Guid | null }
  /**
   * A right-click (or ⌃-click on a Mac), after the engine selected the layer under the pointer (unless it was
   * already in the selection). `hits`: every layer under the point, topmost first, each as its path innermost
   * first (the layer, then its parents up to the page's child) — "Select layer ▸". Comes after SELECTION_CHANGED.
   */
  | { type: "CONTEXT_MENU"; targetKind: "CANVAS" | "SELECTION"; x: number; y: number; hits: Guid[][] }
  /** A FontName a document uses that nobody has answered yet (once per name, module-wide). Engine.ts answers it. */
  | { type: "REQUEST_FONT"; family: string; style: string }
  /**
   * Text editing started, moved, changed or ended. `caretRectCss`: the caret in CSS px in the canvas (the hidden IME
   * textarea goes there); `selStart` ≤ `selEnd` in UTF-16 units of the node's characters.
   */
  | { type: "TEXT_EDIT"; active: boolean; ref: Guid | null; caretRectCss: { x: number; y: number; width: number; height: number }; selStart: number; selEnd: number }
  | ({ type: "UNDO_STATE" } & UndoState)
  /** An image the document draws that the engine has no pixels for (40 hex digits); Engine.ts answers it from its image source. */
  | { type: "REQUEST_IMAGE"; hash: string }
  /** Vector edit mode started, ended, or its tool or selection changed (indices into the network's vertices / segments). */
  | {
      type: "VECTOR_EDIT";
      active: boolean;
      ref: Guid | null;
      tool: VectorEditTool;
      selectedVertices: number[];
      selectedSegments: number[];
      vertexCount: number;
      segmentCount: number;
      /** The selected vertices' handle mirroring (MIXED when they differ, null when none is selected). */
      mirroring: VectorMirror | "MIXED" | null;
      /** The selected vertices: x / y in the node's parent's space (like the layer's X / Y), their corner radius. */
      points: { index: number; x: number; y: number; cornerRadius: number; mirroring: VectorMirror }[];
    }
  /** Gradient (paint) edit mode: which paint's handles are on the canvas, and the selected stop. */
  | { type: "PAINT_EDIT"; active: boolean; ref: Guid | null; paints: "FILL" | "STROKE"; index: number; stop: number }
  /** Instances re-derived (and the mains they come from) after a change reached them. */
  | { type: "COMPONENTS_CHANGED"; refs: Guid[] }
  /** After GO_TO_MAIN_COMPONENT / RETURN_TO_INSTANCE: where it went, and the instance "Return to instance" goes back to. */
  | { type: "INSTANCE_NAVIGATION"; main: Guid | null; returnTo: Guid | null }
  /** Collections or variables changed (any commit, undo, redo, remote change or load). */
  | { type: "VARIABLES_CHANGED"; collections: Guid[]; variables: Guid[] }
  /** Styles changed, or how many layers use them. */
  | { type: "STYLES_CHANGED"; styles: Guid[] };

export type EngineEventType = EngineEvent["type"];
export type EventOf<T extends EngineEventType> = Extract<EngineEvent, { type: T }>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const encode = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
function decode<T>(bytes: Uint8Array): T {
  return JSON.parse(decoder.decode(bytes)) as T;
}

export const encodeMessage = (message: Message): Uint8Array => encode(message);
export const decodeMessage = (bytes: Uint8Array): Message => decode<Message>(bytes);
export const encodeRefs = (refs: readonly Guid[]): Uint8Array => encode({ refs });
/** A sparse NodeChange for engine_set_props (no guid: the refs say which nodes). */
/**
 * What setProps writes: any NodeFields; a field set to null is cleared (absent), modelled or not — e.g.
 * `{ styleIdForFill: null }` detaches a style; an unmodelled field (`{ exportSettings: null }`) needs a cast.
 */
export type NodeFieldsPatch = { [K in keyof NodeFields]?: NodeFields[K] | null };
export const encodeFields = (fields: NodeFieldsPatch): Uint8Array => encode(fields);
/** A JSON value. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
/** Command args: any JSON (GUIDs as "s:l" strings; variable values in Figma's shapes). */
export type CommandArgValue = JsonValue;
export const encodeArgs = (args: Readonly<Record<string, CommandArgValue>>): Uint8Array => encode(args);
export const encodeOptions = (options: object): Uint8Array => encode(options);
export const encodeText = (text: string): Uint8Array => encoder.encode(text);
export const decodeEvents = (bytes: Uint8Array): EngineEvent[] => decode<{ events: EngineEvent[] }>(bytes).events;
export const decodeSelection = (bytes: Uint8Array): Selection => decode<Selection>(bytes);
export const decodePages = (bytes: Uint8Array): PageInfo[] => decode<{ pages: PageInfo[] }>(bytes).pages;
export const decodeCamera = (bytes: Uint8Array): Camera => decode<Camera>(bytes);
export const decodeRefs = (bytes: Uint8Array): Guid[] => decode<{ refs: Guid[] }>(bytes).refs;
export const decodeStats = (bytes: Uint8Array): Record<string, number> => decode<Record<string, number>>(bytes);
export const decodeText = (bytes: Uint8Array): string => decoder.decode(bytes);

/** engine_text_layout: a TEXT node's layout, shaped as schema/document.kiwi's DerivedTextData (node space, px). */
export interface TextLayoutInfo {
  layoutSize: Vector;
  baselines: { position: Vector; width: number; lineY: number; lineHeight: number; lineAscent: number; firstCharacter: number; endCharacter: number }[];
  glyphs: { position: Vector; fontSize: number; firstCharacter: number; advance: number; glyphID: number; styleID?: number }[];
  decorations: { rects: { x: number; y: number; w: number; h: number }[]; styleID: number }[];
  truncationStartIndex: number;
  truncatedHeight: number;
  /** The caret's x before each UTF-16 unit (and after the last). */
  logicalIndexToCharacterOffsetMap: number[];
  /** Some run's font is missing (drawn with Inter; Figma's "Missing fonts"). */
  missingFont: boolean;
  /** Some run's font is still loading. */
  pendingFont: boolean;
}
export const decodeTextLayout = (bytes: Uint8Array): TextLayoutInfo => decode<TextLayoutInfo>(bytes);

/** A rendered image: straight RGBA8, rows top to bottom. */
export interface Pixels {
  width: number;
  height: number;
  pixels: Uint8Array;
}
/** engine_render_thumbnail's result: u32 width, u32 height (little endian), then the RGBA8. */
export function decodePixels(bytes: Uint8Array): Pixels {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  return { width, height, pixels: bytes.subarray(8, 8 + width * height * 4) };
}
