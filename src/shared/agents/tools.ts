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

import { layerPropsSchema } from "./layerProps";

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

/** What create_nodes and update_nodes take for one layer (all optional on update): layerProps.ts, generated in part from schema/document.kiwi. */
const layerProps: Record<string, unknown> = layerPropsSchema();

const ids = { type: "array", items: { type: "string" } };
const STYLE_PROPS = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, layerProps[k]]));
const nodeSpec: Record<string, unknown> = {
  type: "object",
  properties: {
    type: { enum: ["FRAME", "RECTANGLE", "ELLIPSE", "TEXT", "LINE", "GROUP", "POLYGON", "STAR", "SECTION"], description: "GROUP needs children. Components, instances, vectors, boolean groups: run_command (list_commands)." },
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
      "A sparse XML outline: the file's pages, then a layer (default: the selection; with nothing selected, the current page and its top-level layers) with ids, names, types, positions and sizes of it and its descendants. Use it to find layers, then call get_design_context on the ones that matter.",
    inputSchema: { type: "object", properties: { nodeId, depth: { type: "number", description: "Levels below the layer (default 6)." } } },
    write: false,
  },
  {
    name: "get_design_context",
    title: "Get design context",
    description:
      "The structured design of a layer and its descendants (default: the selection), with every non-default property under the same names and shapes update_nodes takes: layout, sizing, position and size, constraints, fills (every paint type), strokes, corners, effects (every type, GLASS with all its parameters), layout guides, text and typography, component properties, bound variables and styles, plus a CSS hint per layer. Use it before changing or adapting a design.",
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
      "Creates layers from specs (nested `children` allowed) under `parentId` (default: the current page) — e.g. a whole frame from a description. Every property is checked and read back: the result lists per layer what was applied, what was rejected (with why) and what didn't take (notApplied), with the values the layers now have. Text uses Inter unless fontFamily is given.",
    inputSchema: { type: "object", properties: { parentId: { type: "string" }, nodes: { type: "array", items: nodeSpec } }, required: ["nodes"] },
    write: true,
  },
  {
    name: "update_nodes",
    title: "Update layers",
    description: "Changes properties of existing layers. Each update names a nodeId and the properties to set (the same names and shapes as create_nodes and get_design_context). Strict: unknown properties, values it can't read and properties that don't apply to the layer are listed under rejected; properties the engine didn't take (e.g. a width on a hugging frame) under notApplied — the summary line says so. For any other document field use set_properties.",
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
    description: "Duplicates layers with everything inside them (instances stay instances). Optionally into `parentId` at `index` (default: on top) and/or at x, y. Returns the copies' ids and parents, in order.",
    inputSchema: { type: "object", properties: { nodeIds: ids, parentId: { type: "string" }, index: { type: "number" }, x: { type: "number" }, y: { type: "number" } }, required: ["nodeIds"] },
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
    name: "set_properties",
    title: "Set document fields",
    description:
      "Sets any document field on layers, by its schema/document.kiwi name and shape (stackSpacing, stackChildPrimaryGrow, fillPaints, strokePaints, effects, layoutGrids, textCase, gridRows, arcData, …) straight through the engine — for anything update_nodes doesn't name. Colours may be \"#RRGGBBAA\"; paints and effects take the same shapes as update_nodes (GLASS, NOISE, TEXTURE, progressive blurs, gradients, patterns). Read back: notApplied lists what the engine kept differently.",
    inputSchema: { type: "object", properties: { nodeIds: ids, nodeId: { type: "string" }, properties: { type: "object", description: "{field: value} in the document's names" } }, required: ["properties"] },
    write: true,
  },
  {
    name: "bind_variable",
    title: "Bind variable",
    description:
      'Binds a variable to a property of layers (null variableId: detach). field: characters (a STRING variable — the text follows the mode, e.g. translations), visible (BOOLEAN), opacity, width, height, min/maxWidth/Height, itemSpacing, counterAxisSpacing, padding / paddingTop…, cornerRadius / topLeftRadius…, strokeWeight / strokeTopWeight…, fontFamily, fontStyle, fontSize, lineHeight, letterSpacing, paragraphSpacing, paragraphIndent, gridRowGap, gridColumnGap, "fills[i]" ("fill" = fills[0]), "fills[i].opacity", "fills[i].stops[j]", "strokes[i]", "effects[i].color|radius|spread|x|y", "layoutGrids[i].numSections|sectionSize|gutterSize|offset", "componentProperties.<name>".',
    inputSchema: { type: "object", properties: { nodeIds: ids, nodeId: { type: "string" }, field: { type: "string" }, variableId: { type: ["string", "null"] } }, required: ["field", "variableId"] },
    write: true,
  },
  {
    name: "apply_variable",
    title: "Apply variable",
    description: "The same as bind_variable (kept for older prompts).",
    inputSchema: { type: "object", properties: { nodeId: { type: "string" }, nodeIds: ids, field: { type: "string" }, variableId: { type: "string" } }, required: ["field", "variableId"] },
    write: true,
  },
  {
    name: "create_variable_collection",
    title: "Create variable collection",
    description: 'Creates a local variable collection with modes (e.g. name "Content", modes ["TR", "EN"]; default one mode "Mode 1"). Returns its id and mode ids.',
    inputSchema: { type: "object", properties: { name: { type: "string" }, modes: { type: "array", items: { type: "string" } } }, required: ["name"] },
    write: true,
  },
  {
    name: "edit_variable_collection",
    title: "Edit variable collection",
    description: "rename, delete, add_mode (name), rename_mode (mode, name), delete_mode, duplicate_mode, set_default_mode (mode), extend (an extended collection), duplicate. Modes by name or id.",
    inputSchema: { type: "object", properties: { collectionId: { type: "string", description: "id or name" }, action: { enum: ["rename", "delete", "add_mode", "rename_mode", "delete_mode", "duplicate_mode", "set_default_mode", "extend", "duplicate"] }, mode: { type: "string" }, name: { type: "string" } }, required: ["collectionId", "action"] },
    write: true,
  },
  {
    name: "create_variable",
    title: "Create variable",
    description: 'Creates a variable in a collection: type COLOR ("#RRGGBBAA"), FLOAT, STRING or BOOLEAN; `values` per mode name ({"TR": "Merhaba", "EN": "Hello"}) or one `value` for every mode; an alias is {alias: variableId}. A slash in the name groups it ("text/title"). Also scopes, codeSyntax {WEB, ANDROID, iOS}, description, hiddenFromPublishing.',
    inputSchema: { type: "object", properties: { collectionId: { type: "string", description: "id or name" }, name: { type: "string" }, type: { enum: ["COLOR", "FLOAT", "STRING", "BOOLEAN"] }, values: { type: "object" }, value: {}, scopes: { type: "array", items: { type: "string" } }, codeSyntax: { type: "object" }, description: { type: "string" }, hiddenFromPublishing: { type: "boolean" } }, required: ["collectionId", "type", "name"] },
    write: true,
  },
  {
    name: "set_variable_value",
    title: "Set variable value",
    description: "Sets a variable's value per mode: values {modeName: value} (or mode + value). An alias: {alias: variableId}.",
    inputSchema: { type: "object", properties: { variableId: { type: "string" }, values: { type: "object" }, mode: { type: "string" }, value: {} }, required: ["variableId"] },
    write: true,
  },
  {
    name: "edit_variable",
    title: "Edit variable",
    description: "Renames a variable or sets its scopes, codeSyntax, description, hiddenFromPublishing; delete: true deletes it.",
    inputSchema: { type: "object", properties: { variableId: { type: "string" }, name: { type: "string" }, scopes: { type: "array", items: { type: "string" } }, codeSyntax: { type: "object" }, description: { type: "string" }, hiddenFromPublishing: { type: "boolean" }, delete: { type: "boolean" } }, required: ["variableId"] },
    write: true,
  },
  {
    name: "set_variable_mode",
    title: "Set variable mode",
    description: 'Sets the explicit mode of a collection on frames / layers or a page (mode: name or id; "auto" or null: back to inherited) — e.g. a duplicated frame switched to "EN".',
    inputSchema: { type: "object", properties: { nodeIds: ids, nodeId: { type: "string" }, collectionId: { type: "string" }, mode: { type: ["string", "null"] } }, required: ["collectionId", "mode"] },
    write: true,
  },
  {
    name: "apply_style",
    title: "Apply style",
    description: 'Applies a style (id from get_variable_defs with all: true, or one you created) to layers: slot "fill", "stroke", "text", "effect" or "grid"; styleId null detaches.',
    inputSchema: { type: "object", properties: { nodeIds: ids, slot: { enum: ["fill", "stroke", "text", "effect", "grid"] }, styleId: { type: ["string", "null"] } }, required: ["nodeIds", "slot", "styleId"] },
    write: true,
  },
  {
    name: "create_paint_style",
    title: "Create color style",
    description: "Creates a color style from fills (same shapes as update_nodes) or from a layer (fromNodeId); applyTo: layer ids to apply it to.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, fills: layerProps.fills, fromNodeId: { type: "string" }, description: { type: "string" }, applyTo: ids }, required: ["name"] },
    write: true,
  },
  {
    name: "create_text_style",
    title: "Create text style",
    description: "Creates a text style from typography properties (fontFamily, fontStyle, fontSize, lineHeight, letterSpacing, paragraphSpacing, textCase, textDecoration …) or from a text layer (fromNodeId).",
    inputSchema: { type: "object", properties: { name: { type: "string" }, ...STYLE_PROPS(["fontFamily", "fontStyle", "fontSize", "lineHeight", "letterSpacing", "paragraphSpacing", "paragraphIndent", "textCase", "textDecoration", "listSpacing", "leadingTrim", "hangingPunctuation", "hangingList", "fontVariations", "toggledOnOTFeatures", "toggledOffOTFeatures"]), fromNodeId: { type: "string" }, description: { type: "string" }, applyTo: ids }, required: ["name"] },
    write: true,
  },
  {
    name: "create_effect_style",
    title: "Create effect style",
    description: "Creates an effect style from effects (every type, GLASS included; same shapes as update_nodes) or from a layer (fromNodeId).",
    inputSchema: { type: "object", properties: { name: { type: "string" }, effects: layerProps.effects, fromNodeId: { type: "string" }, description: { type: "string" }, applyTo: ids }, required: ["name"] },
    write: true,
  },
  {
    name: "create_grid_style",
    title: "Create layout guide style",
    description: "Creates a layout guide style from layoutGrids or from a frame (fromNodeId).",
    inputSchema: { type: "object", properties: { name: { type: "string" }, layoutGrids: layerProps.layoutGrids, fromNodeId: { type: "string" }, description: { type: "string" }, applyTo: ids }, required: ["name"] },
    write: true,
  },
  {
    name: "list_commands",
    title: "List commands",
    description: "Every command the app has: the editor's menu and shortcut commands (id, label, shortcut, enabled now) and the engine's commands with their arguments — components (CREATE_COMPONENT, COMBINE_AS_VARIANTS, ADD_VARIANT, ADD_COMPONENT_PROPERTY, INSERT_INSTANCE, SWAP_INSTANCE, RESET_INSTANCE, DETACH_INSTANCE …), pages (CREATE_PAGE, RENAME_PAGE, DELETE_PAGE, DUPLICATE_PAGE), boolean operations, flatten, masks, alignment, undo / redo, zoom … `query` filters.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    write: false,
  },
  {
    name: "run_command",
    title: "Run command",
    description: 'Runs any of the app\'s commands (list_commands lists them): {command: "<editor id>", nodeIds?} as from the menus / shortcuts on those layers (default: the selection), or {engineCommand: "<NAME>", args: {...}, nodeIds?} — an engine command with its arguments; ids it created come back. Refusals say why.',
    inputSchema: { type: "object", properties: { command: { type: "string" }, engineCommand: { type: "string" }, args: { type: "object" }, nodeIds: ids } },
    write: true,
  },
  {
    name: "set_current_page",
    title: "Go to page",
    description: "Switches the current page (id or name). Tools work on any page's layers by id; this changes what the user sees and where new layers go by default.",
    inputSchema: { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"] },
    write: false,
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
