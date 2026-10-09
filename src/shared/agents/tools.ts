/**
 * The MCP server's tools (docs/research/figma/R12-agents-mcp.md): one list, read by main (tools/list, the bridge
 * to OpenAI-compatible servers) and run by the editor view that holds the file (src/renderer/src/editor/agents).
 * Read tools are modelled on Figma's MCP server (get_metadata, get_design_context, get_screenshot,
 * get_variable_defs) plus get_selection; the write tools are ours, in the Plugin API's vocabulary (node types,
 * auto layout field names), so an agent that knows Figma knows them.
 *
 * Every tool takes an optional `nodeId` / `nodeIds` in Figma's "123:456" form ("123-456", the URL form, is read
 * too); none names a file — a session is bound to one file (the one its chat started from, or the one in front when
 * an outside client first called), and its writes go nowhere else.
 */

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** JSON Schema of the arguments (MCP `inputSchema`, OpenAI `parameters`). */
  inputSchema: Record<string, unknown>;
  /** Changes the document (refused on a read-only session). */
  write: boolean;
}

const nodeId = { type: "string", description: 'A layer id as "123:456" (the URL form "123-456" is read too). Default: the current selection.' };
const color = { type: "string", description: 'A colour as "#RRGGBB" or "#RRGGBBAA".' };

const paint = {
  description: 'Fills: "#RRGGBB" for a solid colour, or a list of paints ({type:"SOLID", color:"#RRGGBB", opacity?}, {type:"IMAGE", imageRef, scaleMode?: "FILL"|"FIT"|"CROP"|"TILE"} reusing an image hash read from get_design_context), [] for none.',
  anyOf: [color, { type: "array", items: { type: "object" } }],
};

/** What create_nodes and update_nodes take for one layer (all optional on update). */
const layerProps: Record<string, unknown> = {
  name: { type: "string" },
  x: { type: "number", description: "Relative to the parent (ignored for children of an auto layout frame unless positioning is ABSOLUTE)." },
  y: { type: "number" },
  width: { type: "number" },
  height: { type: "number" },
  rotation: { type: "number", description: "Degrees." },
  visible: { type: "boolean" },
  opacity: { type: "number", description: "0–1" },
  fills: paint,
  strokes: paint,
  strokeWeight: { type: "number" },
  cornerRadius: { anyOf: [{ type: "number" }, { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "top-left, top-right, bottom-right, bottom-left" }] },
  clipsContent: { type: "boolean", description: "Frames: clip content." },
  effects: { type: "array", items: { type: "object" }, description: '[{type:"DROP_SHADOW"|"INNER_SHADOW", color, offset:{x,y}, radius, spread?} | {type:"LAYER_BLUR"|"BACKGROUND_BLUR", radius}]' },
  // Text.
  characters: { type: "string", description: "TEXT: its text." },
  fontFamily: { type: "string", description: 'TEXT: e.g. "Inter".' },
  fontStyle: { type: "string", description: 'TEXT: e.g. "Regular", "Semi Bold", "Bold".' },
  fontSize: { type: "number" },
  lineHeight: { anyOf: [{ type: "number", description: "px" }, { type: "string", description: '"auto" or "150%"' }] },
  letterSpacing: { anyOf: [{ type: "number", description: "px" }, { type: "string", description: '"2%"' }] },
  textAlignHorizontal: { enum: ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"] },
  textAutoResize: { enum: ["NONE", "WIDTH_AND_HEIGHT", "HEIGHT"], description: "NONE = fixed size, WIDTH_AND_HEIGHT = auto width, HEIGHT = auto height (wraps at its width)." },
  // Auto layout, as a container.
  layoutMode: { enum: ["NONE", "HORIZONTAL", "VERTICAL"], description: "Frames: auto layout direction." },
  itemSpacing: { type: "number" },
  padding: { anyOf: [{ type: "number" }, { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "top, right, bottom, left" }] },
  primaryAxisAlignItems: { enum: ["MIN", "CENTER", "MAX", "SPACE_BETWEEN"] },
  counterAxisAlignItems: { enum: ["MIN", "CENTER", "MAX", "BASELINE"] },
  layoutWrap: { enum: ["NO_WRAP", "WRAP"] },
  counterAxisSpacing: { type: "number", description: "Gap between wrapped rows." },
  primaryAxisSizingMode: { enum: ["FIXED", "AUTO"], description: "AUTO = hug contents along the layout direction." },
  counterAxisSizingMode: { enum: ["FIXED", "AUTO"] },
  // Auto layout, as a child.
  layoutSizingHorizontal: { enum: ["FIXED", "HUG", "FILL"], description: "In an auto layout parent (or as an auto layout frame / text)." },
  layoutSizingVertical: { enum: ["FIXED", "HUG", "FILL"] },
  layoutPositioning: { enum: ["AUTO", "ABSOLUTE"] },
  minWidth: { type: "number" },
  maxWidth: { type: "number" },
};

const nodeSpec: Record<string, unknown> = {
  type: "object",
  properties: {
    type: { enum: ["FRAME", "RECTANGLE", "ELLIPSE", "TEXT", "LINE", "GROUP"], description: "GROUP needs children." },
    ...layerProps,
    children: { type: "array", items: { type: "object" }, description: "Nested node specs (same shape), created inside this one in order." },
  },
  required: ["type"],
};

export const TOOLS: ToolDef[] = [
  {
    name: "get_selection",
    title: "Get selection",
    description: "The open file's name, the current page and the selected layers (id, name, type, position, size). Start here.",
    inputSchema: { type: "object", properties: {} },
    write: false,
  },
  {
    name: "get_metadata",
    title: "Get metadata",
    description:
      "A sparse XML outline of a layer (default: the selection, else the current page's top-level layers): ids, names, types, positions and sizes of it and its descendants. Use it to find layers, then call get_design_context on the ones that matter.",
    inputSchema: { type: "object", properties: { nodeId, depth: { type: "number", description: "Levels below the layer (default 6)." } } },
    write: false,
  },
  {
    name: "get_design_context",
    title: "Get design context",
    description:
      "The structured design of a layer and its descendants (default: the selection): layout (auto layout direction, gaps, padding, alignment, sizing), position and size, fills, strokes, corner radii, effects, text content and typography, images (hash and scale mode), bound variables and styles, plus a CSS hint per layer. Use it before changing or adapting a design.",
    inputSchema: { type: "object", properties: { nodeId, depth: { type: "number", description: "Levels below the layer (default 8)." } } },
    write: false,
  },
  {
    name: "get_screenshot",
    title: "Get screenshot",
    description: "A PNG of a layer (default: the selection, else the current page), at most `maxSize` px on its long side (default 1024).",
    inputSchema: { type: "object", properties: { nodeId, maxSize: { type: "number" } } },
    write: false,
  },
  {
    name: "get_variable_defs",
    title: "Get variable definitions",
    description: "The variables and styles a layer uses (default: the selection) with their resolved values — or, with `all: true`, every local variable collection with its modes and values.",
    inputSchema: { type: "object", properties: { nodeId, all: { type: "boolean" } } },
    write: false,
  },
  {
    name: "create_nodes",
    title: "Create layers",
    description:
      "Creates layers from specs (nested `children` allowed) under `parentId` (default: the current page) — e.g. a whole frame from a description. Returns the new ids. Text uses Inter unless fontFamily is given.",
    inputSchema: { type: "object", properties: { parentId: { type: "string" }, nodes: { type: "array", items: nodeSpec } }, required: ["nodes"] },
    write: true,
  },
  {
    name: "update_nodes",
    title: "Update layers",
    description: "Changes properties of existing layers. Each update names a nodeId and the properties to set (the same names as create_nodes).",
    inputSchema: { type: "object", properties: { updates: { type: "array", items: { type: "object", properties: { nodeId: { type: "string" }, ...layerProps }, required: ["nodeId"] } } }, required: ["updates"] },
    write: true,
  },
  {
    name: "delete_nodes",
    title: "Delete layers",
    description: "Deletes layers.",
    inputSchema: { type: "object", properties: { nodeIds: { type: "array", items: { type: "string" } } }, required: ["nodeIds"] },
    write: true,
  },
  {
    name: "duplicate_nodes",
    title: "Duplicate layers",
    description: "Duplicates layers with everything inside them (instances stay instances). Optionally into `parentId` and/or at x, y. Returns the copies' ids, in order.",
    inputSchema: { type: "object", properties: { nodeIds: { type: "array", items: { type: "string" } }, parentId: { type: "string" }, x: { type: "number" }, y: { type: "number" } }, required: ["nodeIds"] },
    write: true,
  },
  {
    name: "reparent_nodes",
    title: "Move layers",
    description: "Moves layers into another parent at an index (0 = first in layout order / bottom).",
    inputSchema: { type: "object", properties: { nodeIds: { type: "array", items: { type: "string" } }, parentId: { type: "string" }, index: { type: "number" } }, required: ["nodeIds", "parentId"] },
    write: true,
  },
  {
    name: "set_auto_layout",
    title: "Set auto layout",
    description: "Turns auto layout on or off on a frame and sets its direction, gap, padding, alignment, wrap and sizing (same names as create_nodes).",
    inputSchema: { type: "object", properties: { nodeId: { type: "string" }, layoutMode: layerProps.layoutMode, itemSpacing: layerProps.itemSpacing, padding: layerProps.padding, primaryAxisAlignItems: layerProps.primaryAxisAlignItems, counterAxisAlignItems: layerProps.counterAxisAlignItems, layoutWrap: layerProps.layoutWrap, counterAxisSpacing: layerProps.counterAxisSpacing, primaryAxisSizingMode: layerProps.primaryAxisSizingMode, counterAxisSizingMode: layerProps.counterAxisSizingMode }, required: ["nodeId", "layoutMode"] },
    write: true,
  },
  {
    name: "apply_variable",
    title: "Apply variable",
    description: 'Binds a variable (id from get_variable_defs) to a layer\'s property: field "fill" / "stroke" (colour variables, the first paint) or a number field ("width", "height", "itemSpacing", "paddingTop"…, "cornerRadius", "opacity").',
    inputSchema: { type: "object", properties: { nodeId: { type: "string" }, field: { type: "string" }, variableId: { type: "string" } }, required: ["nodeId", "field", "variableId"] },
    write: true,
  },
  {
    name: "apply_style",
    title: "Apply style",
    description: 'Applies a local style (id from get_variable_defs with all: true) to layers: slot "fill", "stroke", "text", "effect" or "grid".',
    inputSchema: { type: "object", properties: { nodeIds: { type: "array", items: { type: "string" } }, slot: { enum: ["fill", "stroke", "text", "effect", "grid"] }, styleId: { type: "string" } }, required: ["nodeIds", "slot", "styleId"] },
    write: true,
  },
  {
    name: "create_responsive_variant",
    title: "Create responsive variant",
    description:
      "Makes an adapted copy of a frame at another width (default 390, a phone) next to it: the copy is re-laid out as a vertical auto layout stack — rows stacked or wrapped, children filling the width, headings scaled down, images scaled to the width keeping their aspect ratio. Returns the new frame's id and what it changed, for you to refine with update_nodes / set_auto_layout.",
    inputSchema: { type: "object", properties: { nodeId: { type: "string" }, width: { type: "number" }, name: { type: "string" } }, required: ["nodeId"] },
    write: true,
  },
  {
    name: "set_selection",
    title: "Select layers",
    description: "Selects layers and brings them into view (on their page).",
    inputSchema: { type: "object", properties: { nodeIds: { type: "array", items: { type: "string" } } }, required: ["nodeIds"] },
    write: false,
  },
];

export const TOOL_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(TOOLS.map((t) => [t.name, t]));

/** The MCP server's name in clients' configs and tool prefixes (`mcp__designer__get_metadata`). */
export const MCP_SERVER_NAME = "designer";

/** A tool call's result, as MCP content blocks. */
export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
  /** The layers the call created or changed (the panel's "Changes" row; not sent to the agent). */
  touched?: string[];
}

export const textResult = (value: unknown, isError = false): ToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }], isError: isError || undefined });
