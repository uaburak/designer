/**
 * The MCP server's tools (docs/research/figma/R12-agents-mcp.md): one list, read by main (tools/list, the bridge
 * to OpenAI-compatible servers) and run by the editor view that holds the file (src/renderer/src/editor/agents).
 * Read tools are modelled on Figma's MCP server (get_metadata, get_design_context, get_screenshot,
 * get_variable_defs) plus get_selection; the write tools are ours, in the Plugin API's vocabulary (node types,
 * auto layout field names), so an agent that knows Figma knows them.
 *
 * Layers are named by `nodeId` / `nodeIds` in Figma's "123:456" form ("123-456", the URL form, is read too). Read
 * tools default to the user's selection; write tools never do — they act only on the ids they are given, and an
 * empty list is refused ("no nodes given"), so an agent's bug can't change what the owner has selected. None names a file — a session is bound to one file (the one its chat started from, or the one in front when
 * an outside client first called), and its writes go nowhere else.
 */

import { layerPropsSchema } from "./layerProps";
import { actionSchema, deviceSchema, triggerSchema } from "./prototypeSchema";

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

/** Writes name their layers: never the selection (mcpTools.ts writeTargets). */
const WRITE_IDS = "Required: the layers' ids (nodeIds, or nodeId for one) — writes never fall back to the selection; an empty list is an error.";
const writeIds = { type: "array", items: { type: "string" }, minItems: 1, description: WRITE_IDS };
const writeId = { type: "string", description: 'One layer id ("123:456"), instead of nodeIds.' };

/** What create_nodes and update_nodes take for one layer (all optional on update): layerProps.ts, generated in part from schema/document.kiwi. */
const layerProps: Record<string, unknown> = layerPropsSchema();

const ids = { type: "array", items: { type: "string" } };

/** An image from the agent: a file in its working folder, or the bytes (PNG, JPEG, WebP, GIF). */
const imageArg = {
  type: "object",
  description:
    "A picture to fill the layer with (it replaces its fills; a new layer without width/height gets the image's size): `path` — a PNG, JPEG, WebP or GIF file in your working folder (e.g. one an image generator saved there) — or `data` — its bytes as base64. `scaleMode`: FILL (default), FIT, CROP, TILE.",
  properties: { path: { type: "string" }, data: { type: "string" }, name: { type: "string" }, scaleMode: { enum: ["FILL", "FIT", "CROP", "TILE"] } },
};
const STYLE_PROPS = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, layerProps[k]]));
const nodeSpec: Record<string, unknown> = {
  type: "object",
  properties: {
    type: { enum: ["FRAME", "RECTANGLE", "ELLIPSE", "TEXT", "LINE", "GROUP", "POLYGON", "STAR", "SECTION"], description: "GROUP needs children. Components, instances, vectors, boolean groups: run_command (list_commands)." },
    ...layerProps,
    image: imageArg,
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
    name: "get_code_connect_map",
    title: "Get Code Connect map",
    description:
      "The code components mapped to a layer (default: the selection) and the instances inside it, by node id: { componentName, source, snippet, snippetImports, snippetNestedFunctions, version: \"UI\" | \"CLI\", label, instructions } — Figma's Code Connect map. Use the mapped components instead of writing new ones; follow each mapping's instructions.",
    inputSchema: { type: "object", properties: { nodeId, label: { type: "string", description: "Only this label's mappings (React, SwiftUI …); default: the first label of each layer." } } },
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
    inputSchema: { type: "object", properties: { updates: { type: "array", items: { type: "object", properties: { nodeId: { type: "string" }, ...layerProps, image: imageArg }, required: ["nodeId"] } } }, required: ["updates"] },
    write: true,
  },
  {
    name: "place_image",
    title: "Place image",
    description:
      "Puts a picture on the canvas, as Place image does: a rectangle the image's size (or `width` / `height`; one of them keeps the aspect ratio) filled with it, named after the file, at `x` / `y` in `parentId` (default: the current page, right of the existing layers) — or, with `nodeId`, fills that layer with it instead. The image: `path` — a PNG, JPEG, WebP or GIF file in your working folder (an image generator's output, e.g. nanobanana-output/…) — or `data`, its bytes as base64. Returns the layer's id and the image's hash (usable as imageRef in fills).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        data: { type: "string" },
        name: { type: "string" },
        nodeId: { type: "string", description: "Fill this existing layer instead of making a new one." },
        parentId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        scaleMode: { enum: ["FILL", "FIT", "CROP", "TILE"] },
      },
    },
    write: true,
  },
  {
    name: "delete_nodes",
    title: "Delete layers",
    description: `Deletes layers. ${WRITE_IDS}`,
    inputSchema: { type: "object", properties: { nodeIds: writeIds }, required: ["nodeIds"] },
    write: true,
  },
  {
    name: "duplicate_nodes",
    title: "Duplicate layers",
    description: "Duplicates layers with everything inside them (instances stay instances). Optionally into `parentId` at `index` (default: on top) and/or at x, y. Returns the copies' ids and parents, in order. " + WRITE_IDS,
    inputSchema: { type: "object", properties: { nodeIds: writeIds, parentId: { type: "string" }, index: { type: "number" }, x: { type: "number" }, y: { type: "number" } }, required: ["nodeIds"] },
    write: true,
  },
  {
    name: "reparent_nodes",
    title: "Move layers",
    description: `Moves layers into another parent at an index (0 = first in layout order / bottom). ${WRITE_IDS}`,
    inputSchema: { type: "object", properties: { nodeIds: writeIds, parentId: { type: "string" }, index: { type: "number" } }, required: ["nodeIds", "parentId"] },
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
      "Sets any document field on layers, by its schema/document.kiwi name and shape (stackSpacing, stackChildPrimaryGrow, fillPaints, strokePaints, effects, layoutGrids, textCase, gridRows, arcData, …) straight through the engine — for anything update_nodes doesn't name. Colours may be \"#RRGGBBAA\"; paints and effects take the same shapes as update_nodes (GLASS, NOISE, TEXTURE, progressive blurs, gradients, patterns). Prototype interactions: prototypeInteractions takes a list of Reactions (add_interaction's shape) and replaces the layer's; prefer add_interaction / update_interaction. describe_schema gives any field's shape. Read back: notApplied lists what the engine kept differently. " + WRITE_IDS,
    inputSchema: { type: "object", properties: { nodeIds: writeIds, nodeId: writeId, properties: { type: "object", description: "{field: value} in the document's names" } }, required: ["properties"] },
    write: true,
  },
  {
    name: "bind_variable",
    title: "Bind variable",
    description:
      'Binds a variable to a property of layers (null variableId: detach). field: characters (a STRING variable — the text follows the mode, e.g. translations), visible (BOOLEAN), opacity, width, height, min/maxWidth/Height, itemSpacing, counterAxisSpacing, padding / paddingTop…, cornerRadius / topLeftRadius…, strokeWeight / strokeTopWeight…, fontFamily, fontStyle, fontSize, lineHeight, letterSpacing, paragraphSpacing, paragraphIndent, gridRowGap, gridColumnGap, "fills[i]" ("fill" = fills[0]), "fills[i].opacity", "fills[i].stops[j]", "strokes[i]", "effects[i].color|radius|spread|x|y", "layoutGrids[i].numSections|sectionSize|gutterSize|offset", "componentProperties.<name>". ' + WRITE_IDS,
    inputSchema: { type: "object", properties: { nodeIds: writeIds, nodeId: writeId, field: { type: "string" }, variableId: { type: ["string", "null"] } }, required: ["field", "variableId"] },
    write: true,
  },
  {
    name: "apply_variable",
    title: "Apply variable",
    description: `The same as bind_variable (kept for older prompts). ${WRITE_IDS}`,
    inputSchema: { type: "object", properties: { nodeId: writeId, nodeIds: writeIds, field: { type: "string" }, variableId: { type: "string" } }, required: ["field", "variableId"] },
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
    description: 'Sets the explicit mode of a collection on frames / layers or a page (mode: name or id; "auto" or null: back to inherited) — e.g. a duplicated frame switched to "EN". ' + WRITE_IDS,
    inputSchema: { type: "object", properties: { nodeIds: writeIds, nodeId: writeId, collectionId: { type: "string" }, mode: { type: ["string", "null"] } }, required: ["collectionId", "mode"] },
    write: true,
  },
  {
    name: "apply_style",
    title: "Apply style",
    description: 'Applies a style (id from get_variable_defs with all: true, or one you created) to layers: slot "fill", "stroke", "text", "effect" or "grid"; styleId null detaches. ' + WRITE_IDS,
    inputSchema: { type: "object", properties: { nodeIds: writeIds, slot: { enum: ["fill", "stroke", "text", "effect", "grid"] }, styleId: { type: ["string", "null"] } }, required: ["nodeIds", "slot", "styleId"] },
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
    name: "get_prototype",
    title: "Get prototype",
    description:
      "A page's prototype (default: the current page): its flows (starting points: name, frame), device and background, every layer's interactions as Reactions (Plugin API shape: {index, id, trigger, actions}) and the layers' prototype settings (overflowDirection, scrollBehavior, overlay position / background / close on click outside).",
    inputSchema: { type: "object", properties: { pageId: { type: "string", description: "Page id or name" } } },
    write: false,
  },
  {
    name: "add_interaction",
    title: "Add interaction",
    description:
      'Adds an interaction (a Reaction, Figma\'s Plugin API shape) to a layer: {nodeId, trigger, actions}. E.g. a splash: {nodeId: splash, trigger: {type: "AFTER_TIMEOUT", timeout: 2}, actions: [{type: "NAVIGATE", destinationId: home, transition: {type: "DISSOLVE", duration: 0.3, easing: "EASE_OUT"}}]}; a language toggle: {trigger: {type: "ON_CLICK"}, actions: [{type: "SET_VARIABLE_MODE", variableCollectionId: "Content", variableModeId: "EN"}]}; an overlay: {type: "OPEN_OVERLAY", destinationId, overlay: {position: "BOTTOM_CENTER", background: "#00000066", closeOnClickOutside: true}}. Validated (errors name the field and what it takes); one undo step. Returns the layer\'s interactions. describe_schema Reaction / Action / Trigger / Transition for the full shapes. ' + WRITE_IDS,
    inputSchema: { type: "object", properties: { nodeId: writeId, nodeIds: writeIds, trigger: triggerSchema, actions: { type: "array", items: actionSchema }, action: actionSchema }, required: ["trigger"] },
    write: true,
  },
  {
    name: "update_interaction",
    title: "Update interaction",
    description: "Changes one interaction of a layer, by `index` (as get_prototype lists them) or `interactionId`: a new trigger and / or actions (the whole list), same shapes as add_interaction.",
    inputSchema: { type: "object", properties: { nodeId: { type: "string" }, index: { type: "number" }, interactionId: { type: "string" }, trigger: triggerSchema, actions: { type: "array", items: actionSchema } }, required: ["nodeId"] },
    write: true,
  },
  {
    name: "remove_interaction",
    title: "Remove interaction",
    description: `Removes interactions from a layer: by \`index\`, \`interactionId\`, or all: true. ${WRITE_IDS}`,
    inputSchema: { type: "object", properties: { nodeId: writeId, nodeIds: writeIds, index: { type: "number" }, interactionId: { type: "string" }, all: { type: "boolean" } } },
    write: true,
  },
  {
    name: "set_flow_starting_point",
    title: "Add / rename flow starting point",
    description: 'Makes a top-level frame a flow\'s starting point ("Flow 1" if no name; renames an existing one), with an optional description. Presentation starts there.',
    inputSchema: { type: "object", properties: { nodeId: { type: "string" }, name: { type: "string" }, description: { type: "string" } }, required: ["nodeId"] },
    write: true,
  },
  {
    name: "remove_flow_starting_point",
    title: "Remove flow starting point",
    description: "Removes a frame's flow starting point.",
    inputSchema: { type: "object", properties: { nodeId: { type: "string" } }, required: ["nodeId"] },
    write: true,
  },
  {
    name: "set_prototype_settings",
    title: "Set prototype settings",
    description:
      'The page\'s prototype settings — device (the Prototype tab\'s Device) and backgroundColor — and per layer settings in `nodes`: [{nodeId, overflowDirection: NONE | HORIZONTAL | VERTICAL | BOTH (a frame\'s scrolling), scrollBehavior: SCROLLS | FIXED | STICKY_SCROLLS (a child\'s position when its frame scrolls), overlayPositionType: CENTER | TOP_LEFT | TOP_CENTER | TOP_RIGHT | BOTTOM_LEFT | BOTTOM_CENTER | BOTTOM_RIGHT | MANUAL, overlayBackground: {type: "SOLID_COLOR", color: "#00000066"} | {type: "NONE"}, overlayBackgroundInteraction: NONE | CLOSE_ON_CLICK_OUTSIDE (a frame used as an overlay)}]. null resets a setting. One undo step.',
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string" },
        device: deviceSchema,
        backgroundColor: { type: ["string", "null"], description: '"#RRGGBB" (the presentation background); null: the default' },
        nodes: { type: "array", items: { type: "object", properties: { nodeId: { type: "string" }, overflowDirection: { type: ["string", "null"] }, scrollBehavior: { type: ["string", "null"] }, overlayPositionType: { type: ["string", "null"] }, overlayBackground: {}, overlayBackgroundInteraction: { type: ["string", "null"] } }, required: ["nodeId"] } },
      },
    },
    write: true,
  },
  {
    name: "describe_schema",
    title: "Describe schema",
    description:
      "The JSON shape any tool takes for a name: a layer property (fills, effects, layoutMode), a document field (stackSpacing, prototypeInteractions, arcData), a schema type (Paint, Effect, PrototypeAction, VariableData) or \"Type.field\", an enum's values (EasingType), or the prototype shapes Reaction, Trigger, Action, Transition, Easing, VariableData, device, flowStartingPoints.",
    inputSchema: { type: "object", properties: { field: { type: "string" } }, required: ["field"] },
    write: false,
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
    description: 'Runs any of the app\'s commands (list_commands lists them): {command: "<editor id>", nodeIds} as from the menus / shortcuts with those layers selected, or {engineCommand: "<NAME>", args: {...}, nodeIds?} — an engine command with its arguments (layers as its refs, or nodeIds as its selection); ids it created come back. Never on the user\'s selection: without nodeIds nothing is selected, and an empty nodeIds is an error. Refusals say why.',
    inputSchema: { type: "object", properties: { command: { type: "string" }, engineCommand: { type: "string" }, args: { type: "object" }, nodeIds: { ...writeIds, description: "The layers the command acts on (its selection). " + WRITE_IDS } } },
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
    description: "Selects layers and brings them into view (on their page). nodeIds required (an empty list is an error).",
    inputSchema: { type: "object", properties: { nodeIds: writeIds }, required: ["nodeIds"] },
    write: false,
  },
  {
    name: "get_skill",
    title: "Get skill",
    description:
      "A Skill's full instructions, by its name (the Skills this chat can use are listed with the message, each with its description). Fetch one when its description fits the task, then follow its instructions. Answered by the app itself — no layers are read or changed.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "The Skill's name, as listed (lowercase, hyphens), without the /." } }, required: ["name"] },
    write: false,
  },
];

/**
 * The manager's own tools (docs/studio.md §2.2, §5.4, §6): listed for a manager's turns only and refused for every
 * other session — a worker, a chat without the manager, an outside client. Answered by the view's AgentsService
 * (editor/agents/managerTools.ts). The library's tools (§3.3, editor/studio/libraryTools.ts) join them in the view.
 */
const box = { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } } };
export const MANAGER_TOOLS: ToolDef[] = [
  {
    name: "delegate_task",
    title: "Delegate task",
    description:
      "Hands a piece of work to another agent as a task, returned at once ({taskId}); it runs as its own turn with the canvas tools (not yours), its own folder and its own undo step, beside the other tasks. `prompt` must say everything the worker needs (it doesn't see this chat). `agent`: a provider id (default: the general agent of the settings); `dependsOn`: task ids that must be done first (a failed one fails this task). Then wait_tasks.",
    inputSchema: { type: "object", properties: { kind: { enum: ["agent"] }, title: { type: "string" }, prompt: { type: "string" }, agent: { type: "string" }, model: { type: "string" }, dependsOn: ids }, required: ["title", "prompt"] },
    write: false,
  },
  {
    name: "wait_tasks",
    title: "Wait for tasks",
    description: "Waits until the tasks have all ended (or `timeoutSec`, default 600) and returns each one's state (done / failed / stopped / still running), its summary or error, and the layers it made.",
    inputSchema: { type: "object", properties: { taskIds: ids, timeoutSec: { type: "number" } }, required: ["taskIds"] },
    write: false,
  },
  {
    name: "stop_task",
    title: "Stop task",
    description: "Stops a task (queued or running).",
    inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
    write: false,
  },
  {
    name: "ask_choice",
    title: "Ask a choice",
    description:
      "Shows the owner a choice card in the chat and waits for the click: {question, options: [{id, label, detail?}]} → the option picked. `imageRoute: true` instead lists the image models (Gemini API, Gemini CLI, Antigravity, OpenAI) with \"Use this for this chat\" — ask it when pictures are needed and no image model is set.",
    inputSchema: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, detail: { type: "string" } }, required: ["id", "label"] } }, remember: { type: "boolean" }, imageRoute: { type: "boolean" } } },
    write: false,
  },
  {
    name: "show_form",
    title: "Show form",
    description: "Opens the brand or product form in the chat (prefilled with what the owner said) and waits: → the saved brandId / productId, or \"cancelled\".",
    inputSchema: { type: "object", properties: { form: { enum: ["brand", "product"] }, brandId: { type: "string" }, productId: { type: "string" }, prefill: { type: "object" } }, required: ["form"] },
    write: false,
  },
  {
    name: "make_posts",
    title: "Make posts",
    description:
      "Makes social posts from the library: for each format × variation an image task (the image model, the product references and the strict prompt) and a frame task (the general agent: the frame at the format's size, named \"‹Product› — ‹Format› v‹n›\", the brand's text and logo, a bottom layer \"Picture\"); the picture goes into its frame when both are done; a last review task waits for all. Call it only when library_missing is empty (or the owner said go anyway). Returns the brief and the task ids: wait_tasks on the review task, then review.",
    inputSchema: {
      type: "object",
      properties: {
        briefId: { type: "string", description: "Run a brief again (its id); else a new brief from the fields below" },
        brand: { type: "string", description: "Brand id" },
        products: { ...ids, description: "Product ids" },
        formats: { ...ids, description: "Format ids of the brand (default: post and story)" },
        scene: { type: "string" },
        variations: { type: "number", description: "Default 2" },
        request: { type: "string", description: "The owner's words" },
      },
    },
    write: false,
  },
  {
    name: "review",
    title: "Review",
    description: "The frames' pictures (as images) with the brief's exact (sharp) and illegible (soft) label texts and the products' shapes, for you to check: every sharp text exact, shapes and colours as the references (library_image), nothing extra, nothing missing or cropped, soft areas not readable as wrong words, text and logo inside the safe area. Then report_review.",
    inputSchema: { type: "object", properties: { nodeIds: ids, briefId: { type: "string" } }, required: ["nodeIds"] },
    write: false,
  },
  {
    name: "report_review",
    title: "Report review",
    description:
      "Shows the review card (each frame ✓ or its problems; a problem: {id, kind: sharp-text | soft-text | shape | extra | missing | layout | brand, detail, box?: frame coordinates, fix: fix-label | blur | regenerate | relayout}) and waits for the owner: \"Fix selected\" starts the fixes and returns their task ids (wait_tasks, then review the changed frames again); \"Leave as is\" ends the loop.",
    inputSchema: {
      type: "object",
      properties: {
        report: {
          type: "object",
          properties: {
            briefId: { type: "string" },
            items: { type: "array", items: { type: "object", properties: { nodeId: { type: "string" }, name: { type: "string" }, ok: { type: "boolean" }, problems: { type: "array", items: { type: "object", properties: { id: { type: "string" }, kind: { type: "string" }, detail: { type: "string" }, box, fix: { type: "string" } } } } } } },
          },
        },
      },
      required: ["report"],
    },
    write: false,
  },
];

export const MANAGER_TOOL_NAMES: ReadonlySet<string> = new Set(MANAGER_TOOLS.map((t) => t.name));

/** Tools that wait for the owner or for tasks: main gives them 30 minutes instead of 120 s (docs/studio.md §2.2). */
export const WAITING_TOOLS: ReadonlySet<string> = new Set(["wait_tasks", "ask_choice", "show_form", "report_review", "make_posts", "library_read_labels"]);
export const WAITING_TOOL_MS = 30 * 60_000;

/** Tools main answers itself (never sent to the editor view): `get_skill` (docs/ai.md §2.10). */
export const MAIN_TOOLS: ReadonlySet<string> = new Set(["get_skill"]);

/** A connector's tool as agents see it through our server (docs/ai.md §2.11): `‹connector›__‹tool›`. */
export const CONNECTOR_TOOL_SEP = "__";

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
