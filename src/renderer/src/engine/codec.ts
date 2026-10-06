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
/**
 * A paint. The engine draws SOLID ones; any other kind (gradients, images: E5) comes back exactly as it went in
 * (its own fields included), so it survives edits, copies and undo.
 */
export interface Paint {
  type: "SOLID" | (string & {});
  color?: Color;
  opacity?: number;
  visible?: boolean;
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
  /** Kiwi field ids reset to absent (updates only). */
  clearedFields?: number[];
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
  /** Clipboard Messages (docs/schema.md §4.1): the page copied from, and each source parent's place. */
  pastePageId?: Guid;
  clipboardSelectionRegions?: ClipboardSelectionRegion[];
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
  | ({ type: "UNDO_STATE" } & UndoState);

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
export const encodeFields = (fields: NodeFields): Uint8Array => encode(fields);
/** Command args: numbers, and GUID strings ({ page: "0:3" }). */
export const encodeArgs = (args: Record<string, number | string>): Uint8Array => encode(args);
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
