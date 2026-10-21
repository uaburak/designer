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
    svg: { type: "string", description: "SVG markup, at any depth (type FRAME): the layer is made from it as Figma's createNodeFromSvg does — a frame the SVG's size (its width / height, else its viewBox) holding its vectors (paths, shapes; text and images left out), at its x / y in its parent; the other properties then apply to that frame." },
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
    description: "Duplicates layers with everything inside them (instances stay instances). Each entry of nodeIds is one copy, as Figma's clone() per node: an id listed twice is duplicated twice. Optionally into `parentId` at `index` (default: on top) and/or at x, y. Returns the copies' ids and parents. " + WRITE_IDS,
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
  // Motion (docs/motion.md §9, round 8f): Figma's Plugin API shapes — seconds, public field names and units.
  {
    name: "get_motion",
    title: "Get motion",
    description:
      "The Motion timeline of a top-level frame (nodeId: the frame or any layer in it; default: the selection's): its duration (seconds), playback (LOOP, ONCE, PING_PONG) and snapping fps; each animated layer's manualKeyframeTracks (Figma's Plugin API object: {OPACITY: {id, keyframes: [{id, timelinePosition, value, easing}]}, fills: {0: track}, effects: {0: {RADIUS: track}}}), its animations (applied presets: {id, styleId, name, duration, timelineOffset, props, visible}) and the composite animation styles they came from; the audio clips. `resolved: true` adds the resolved model (every property's keyframes in timeline time, presets materialised — what Dev Mode's code is written from). Read it before changing motion.",
    inputSchema: { type: "object", properties: { nodeId, resolved: { type: "boolean" } } },
    write: false,
  },
  {
    name: "set_keyframes",
    title: "Set keyframes",
    description:
      'Writes one field\'s keyframe track on layers (Figma\'s applyManualKeyframeTrack): keyframes [{id?, timelinePosition (seconds ≥ 0), value: {type: "FLOAT" | "VECTOR" | "COLOR", value}, easing?: {type: EASE_OUT | EASE_IN | EASE_IN_AND_OUT | LINEAR | EASE_IN_BACK | EASE_OUT_BACK | EASE_IN_AND_OUT_BACK | GENTLE | QUICK | BOUNCY | SLOW | HOLD | CUSTOM_CUBIC_BEZIER (easingFunctionCubicBezier {x1, y1, x2, y2}) | CUSTOM_SPRING (easingFunctionSpring {bounce})}}]. The track becomes this list: keyframes with an id it has are edited, the others added, the ones left out deleted (an empty list removes the track); `merge: true` only adds and edits. field: OPACITY (0–1), TRANSLATION_X / TRANSLATION_Y (px, added to the resting position), TRANSLATION_XY (VECTOR px), ROTATION (degrees, counter-clockwise +, added), SCALE_X / SCALE_Y / SCALE_XY (multipliers, 1 = unchanged), WIDTH, HEIGHT, CORNER_RADIUS, RECTANGLE_*_CORNER_RADIUS, STROKE_WEIGHT, BORDER_*_WEIGHT, STACK_SPACING, STACK_COUNTER_SPACING, STACK_PADDING_*, GRID_ROW_GAP, GRID_COLUMN_GAP, PATH_TRIM_START / PATH_TRIM_END (0–1); or {type: "INDEXED_ITEM", collection: "fills" | "strokes", index} (a SOLID paint\'s COLOR {r, g, b, a} 0–1) or {type: "INDEXED_ITEM", collection: "effects", index, field: RADIUS | SPREAD | OFFSET_X | OFFSET_Y | COLOR …}. The first keyframe\'s value holds back to 0 and the last one\'s to the end; the easing is into the keyframe. Never on a top-level frame (it is the timeline): animate its descendants. X / Y and XY tracks are exclusive. The timeline grows to hold the last keyframe unless extendTimeline is false. ' + WRITE_IDS,
    inputSchema: {
      type: "object",
      properties: {
        nodeIds: writeIds,
        nodeId: writeId,
        field: { description: 'A field name ("OPACITY") or {type: "PROPERTY", name} | {type: "INDEXED_ITEM", collection, index[, field]}' },
        keyframes: { type: "array", items: { type: "object", properties: { id: { type: "string" }, timelinePosition: { type: "number" }, value: {}, easing: { type: "object" } }, required: ["timelinePosition", "value"] } },
        merge: { type: "boolean" },
        extendTimeline: { type: "boolean" },
      },
      required: ["field", "keyframes"],
    },
    write: true,
  },
  {
    name: "remove_keyframes",
    title: "Remove keyframes",
    description: "Deletes keyframes by `keyframeIds` (get_motion lists them; a track left empty goes), and / or whole tracks: `fields` on nodeIds (Figma's removeManualKeyframeTrack).",
    inputSchema: { type: "object", properties: { keyframeIds: ids, nodeIds: writeIds, nodeId: writeId, fields: { type: "array", items: {} } } },
    write: true,
  },
  {
    name: "set_timeline",
    title: "Set timeline",
    description: "A top-level frame's timeline (nodeId: the frame or any layer in it): duration in seconds (≤ 600), playback LOOP | ONCE | PING_PONG (not PING_PONG with audio), fps — the keyframes' snapping rate.",
    inputSchema: { type: "object", properties: { nodeId: { type: "string" }, duration: { type: "number" }, playback: { enum: ["LOOP", "ONCE", "PING_PONG"] }, fps: { type: "number" } }, required: ["nodeId"] },
    write: true,
  },
  {
    name: "add_animation",
    title: "Add animation",
    description:
      'Adds an animation preset to layers (Figma\'s applyAnimationStyle): style Opacity | Position | Scale | Rotation | Size | CornerRadius | Path (stroked layers) | TextStagger (text layers: characters, words, lines appear in turn) | New; timelineOffset (its start, seconds; default 0), duration (seconds; default 0.5), props — the preset\'s settings (e.g. Opacity {type: "fadeIn" | "fadeOut" | "custom", amount}, Position {type: "slide_in" | "slide_out" | "custom", direction: left | right | top | bottom | top_left …, distance}, Scale {type: "scaleIn" | "scaleOut", amount %}, TextStagger {animationDirection: "in" | "out", textDelayGrouping: CHARACTER | WORD | LINE | PARAGRAPH, textDelayOrder: LEFT_RIGHT | RIGHT_LEFT | CENTER_OUT | RANDOM, presetStaggerOverlap 0–100, positionEnabled, direction, distance, opacityEnabled, opacityAmount, scaleEnabled, scaleAmount, rotationEnabled, rotationAmount}; easing {type}). get_motion shows each preset\'s props as stored. Returns each layer\'s new animation (its id edits or removes it). ' + WRITE_IDS,
    inputSchema: { type: "object", properties: { nodeIds: writeIds, nodeId: writeId, style: { type: "string" }, timelineOffset: { type: "number" }, duration: { type: "number" }, props: { type: "object" }, visible: { type: "boolean" }, extendTimeline: { type: "boolean" } }, required: ["style"] },
    write: true,
  },
  {
    name: "edit_animation",
    title: "Edit animation",
    description: "Changes one animation (animationId from get_motion / add_animation; nodeId: its layer): props (merged over its own; its preset's code runs again), timelineOffset, duration (seconds), style (another preset type), visible (its eye).",
    inputSchema: { type: "object", properties: { nodeId: { type: "string" }, animationId: { type: "string" }, style: { type: "string" }, timelineOffset: { type: "number" }, duration: { type: "number" }, props: { type: "object" }, visible: { type: "boolean" } }, required: ["animationId"] },
    write: true,
  },
  {
    name: "remove_animations",
    title: "Remove animations",
    description: "Removes animations (presets) by id, with their keyframes (nodeId: their layer, when they are all on one).",
    inputSchema: { type: "object", properties: { nodeId: { type: "string" }, animationIds: ids }, required: ["animationIds"] },
    write: true,
  },
  {
    name: "apply_animation_style",
    title: "Apply animation style",
    description: "Applies a composite animation style — its presets stacked to play together — to layers at timelineOffset (seconds; default 0): fadeIn, fadeOut, slideIn, slideOut, scaleIn, scaleOut, spinIn, textEnter / textExit (text layers), or one of the file's custom styles by id or name (get_motion's customAnimationStyles). One preset at a time is add_animation. " + WRITE_IDS,
    inputSchema: { type: "object", properties: { nodeIds: writeIds, nodeId: writeId, style: { type: "string" }, timelineOffset: { type: "number" }, extendTimeline: { type: "boolean" } }, required: ["style"] },
    write: true,
  },
  {
    name: "save_animation_style",
    title: "Save animation style",
    description:
      'Makes or changes a custom animation style of the file (a reusable, named set of presets): name with fromNodeId (that layer\'s animations become the style) or entries [{style: "Opacity", props: {duration, delay, easing, …}}] (figma presets, in order; delay is the entry\'s place in the style). With styleId: its content replaced the same way (the layers it is applied to follow), name renames it, delete: true deletes it (the layers keep their animations). Apply one with apply_animation_style.',
    inputSchema: { type: "object", properties: { styleId: { type: "string" }, name: { type: "string" }, fromNodeId: { type: "string" }, entries: { type: "array", items: { type: "object" } }, delete: { type: "boolean" } } },
    write: true,
  },
  {
    name: "detach_animation_style",
    title: "Detach animation style",
    description: "Detaches an applied composite style (styleEntryId: get_motion's animationStyles[].id): its animations stay, editable one by one.",
    inputSchema: { type: "object", properties: { styleEntryId: { type: "string" } }, required: ["styleEntryId"] },
    write: true,
  },
  {
    name: "add_audio",
    title: "Add audio",
    description: "Puts a sound on a top-level frame's timeline (nodeId: the frame or a layer in it) at `offset` seconds: `path` — an AAC, MP3, WAV or M4A file in your working folder — or `data`, its bytes as base64; `name`. Exported MP4 / WebM carry it.",
    inputSchema: { type: "object", properties: { nodeId: { type: "string" }, path: { type: "string" }, data: { type: "string" }, name: { type: "string" }, offset: { type: "number" } }, required: ["nodeId"] },
    write: true,
  },
  {
    name: "edit_audio",
    title: "Edit audio",
    description: "Changes an audio clip of a timeline (nodeId: its frame; audioId from get_motion): offset (its start on the timeline, s), trimStart (where in the file it starts, s), duration (s), volume 0–1, mute; splitAt (timeline seconds: cut in two); remove: true deletes it.",
    inputSchema: { type: "object", properties: { nodeId: { type: "string" }, audioId: { type: "string" }, offset: { type: "number" }, trimStart: { type: "number" }, duration: { type: "number" }, volume: { type: "number" }, mute: { type: "boolean" }, splitAt: { type: "number" }, remove: { type: "boolean" } }, required: ["nodeId", "audioId"] },
    write: true,
  },
  {
    name: "export_animation",
    title: "Export animation",
    description:
      "Exports a top-level frame's animation (nodeId: the frame or a layer in it) as a file saved in your working folder (the result gives its path): format MP4 (default, with the timeline's audio), WEBM, GIF (loop: true by default), SVG (animated), LOTTIE (JSON) or DOTLOTTIE; scale 0.5–4 (default 1) or width / height in px; fps 24, 25, 30 (default), 50 or 60; quality LOW | MEDIUM | HIGH (video); name (the file's). The whole timeline once (Ping-pong: there and back). To check motion, export a small GIF and look at its frames — get_screenshot shows the design at rest.",
    inputSchema: { type: "object", properties: { nodeId: { type: "string" }, format: { enum: ["MP4", "WEBM", "GIF", "SVG", "LOTTIE", "DOTLOTTIE"] }, scale: { type: "number" }, width: { type: "number" }, height: { type: "number" }, fps: { type: "number" }, quality: { enum: ["LOW", "MEDIUM", "HIGH"] }, loop: { type: "boolean" }, name: { type: "string" } }, required: ["nodeId"] },
    write: false,
  },
  // Social (docs/social.md §7.2, round 18): posts are top-level frames carrying a record (format, brand, caption …);
  // the same functions the Social mode's controls call (editor/social/actions.ts).
  {
    name: "get_board",
    title: "Get board",
    description:
      "Social mode's board of a page (default: the current one): the board's brand, the campaigns in order with their posts — each {nodeId, name, formatId, format {name, width, height, platform}, brandId, productIds, template, group, status (draft | reviewed | approved | exported), caption, hashtags, altText, animated, durationSec, problems, duplicateOf?} — and the posts outside any campaign (unplaced). Read it first in every Social turn.",
    inputSchema: { type: "object", properties: { pageId: { type: "string" } } },
    write: false,
  },
  {
    name: "list_formats",
    title: "List formats",
    description: "The social formats catalogue: id (\"instagram.post\"), name, size, kind (image | carousel | document | video | thumbnail), aspect, safe area (px the platform's UI covers), caption limits (max, unit, fold, hashtags, mentions), image and video limits, and which values are unverified. `platform` filters; `brandId` adds the brand's own sizes (ids \"brand:<brandId>:<formatId>\", no limits).",
    inputSchema: { type: "object", properties: { platform: { enum: ["instagram", "linkedin", "facebook", "x", "tiktok", "youtube", "pinterest"] }, brandId: { type: "string", description: "Adds the brand's own sizes" } } },
    write: false,
  },
  {
    name: "list_templates",
    title: "List templates",
    description: "The post templates this file can use (its own component sets marked as templates, and the enabled libraries'): key, name, source (\"local\" or the library's name), formats (Format variant → format id), animated, and the slots ({role: logo | picture | headline | body | cta | label | accent | background, property, locked, maxChars}). Filters: platform, formatId, animated.",
    inputSchema: { type: "object", properties: { platform: { type: "string" }, formatId: { type: "string" }, animated: { type: "boolean" } } },
    write: false,
  },
  {
    name: "new_post",
    title: "New post",
    description:
      "Makes a post on the current page: a frame of the format's size (formatId from list_formats) carrying its record, placed at the end of its campaign's row (or a new row) unless x / y say where; from a template (templateKey, variant: its Format value — default the format's) when given. brandId, productId, campaignId — or `campaign`, a new campaign's name. Returns {nodeId, campaignId, slots: [{role, nodeId, property}]}.",
    inputSchema: {
      type: "object",
      properties: {
        formatId: { type: "string" },
        name: { type: "string" },
        brandId: { type: "string" },
        productId: { type: "string" },
        campaignId: { type: "string" },
        campaign: { type: "string", description: "A new campaign's name (instead of campaignId)" },
        templateKey: { type: "string" },
        variant: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["formatId"],
    },
    write: true,
  },
  {
    name: "apply_template",
    title: "Apply template",
    description: "Puts posts on a template (list_templates' key; variant: its Format value, default the post's format): an instance swaps its component; a plain frame is replaced by an instance at its place, its texts carried to the slots by role. brandId / productId fill the brand (colours, fonts, logo) and the product's picture. " + WRITE_IDS,
    inputSchema: { type: "object", properties: { nodeIds: writeIds, nodeId: writeId, templateKey: { type: "string" }, variant: { type: "string" }, brandId: { type: "string" }, productId: { type: "string" } }, required: ["templateKey"] },
    write: true,
  },
  {
    name: "fill_slots",
    title: "Fill slots",
    description: "Writes a template post's text slots (values: headline, body, cta, label — through their component properties) and its picture slot (picture, as place_image takes it). A locked slot is refused (\"‹role› is locked in this template\"); text over a slot's maxChars is written and reported.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        values: { type: "object", properties: { headline: { type: "string" }, body: { type: "string" }, cta: { type: "string" }, label: { type: "string" } } },
        picture: imageArg,
      },
      required: ["nodeId"],
    },
    write: true,
  },
  {
    name: "set_post",
    title: "Set post",
    description:
      "Changes posts' records: brandId, productIds, campaignId (null: no campaign), caption (without the hashtags), hashtags (without \"#\"), altText, status (draft | reviewed | approved | exported); formatId marks a frame that isn't a post yet as one (resizing is resize_post). Returns each post's caption count against its format ({count, max, fold, hashtags}), so an overrun shows at once. " + WRITE_IDS,
    inputSchema: {
      type: "object",
      properties: {
        nodeIds: writeIds,
        nodeId: writeId,
        brandId: { type: ["string", "null"] },
        productIds: ids,
        campaignId: { type: ["string", "null"] },
        caption: { type: "string" },
        hashtags: ids,
        altText: { type: "string" },
        status: { enum: ["draft", "reviewed", "approved", "exported"] },
        formatId: { type: "string", description: "Marks a frame as a post of this format (it isn't one yet); resizing is resize_post" },
      },
    },
    write: true,
  },
  {
    name: "resize_post",
    title: "Resize post",
    description: "Puts posts in another format (formatId): the frame's size (its layers by their constraints; a template post takes the template's variant for that format), or with duplicate: true a copy in the new format at the end of its campaign's row — a fresh draft. Returns the posts resized (the copies). " + WRITE_IDS,
    inputSchema: { type: "object", properties: { nodeIds: writeIds, nodeId: writeId, formatId: { type: "string" }, duplicate: { type: "boolean", description: "Make a copy in the new format next to it (default false)" } }, required: ["formatId"] },
    write: true,
  },
  {
    name: "set_campaign",
    title: "Set campaign",
    description: "Adds a campaign to the current page (name, brandId; returns its campaignId), renames or re-brands one (campaignId and the fields), or removes one (campaignId, remove: true — its posts stay, without a campaign).",
    inputSchema: { type: "object", properties: { campaignId: { type: "string" }, name: { type: "string" }, brandId: { type: "string" }, remove: { type: "boolean" } } },
    write: true,
  },
  {
    name: "check_posts",
    title: "Check posts",
    description:
      "Checks posts (default: every post on the board) against their formats' rules: caption, hashtag and mention counts; text and logo layers inside the safe area; video duration against the format; a missing logo (a post with a brand) or more than one; text contrast over its backdrop (WCAG 4.5:1 under 24 px, 3:1 above). → [{nodeId, problems: [{id, kind: caption | safe-area | video | logo | contrast, detail, box?, fix}]}]; the problems also show on the canvas as pins (a problem no longer found leaves).",
    inputSchema: { type: "object", properties: { nodeIds: ids } },
    write: false,
  },
  {
    name: "save_as_template",
    title: "Save as template",
    description: "Makes a post a template: the frame becomes a component in a component set with a Format variant, its slots tagged (slots: [{nodeId, role, locked?, maxChars?}]; the texts, logo and picture are inferred when left out). Refuses with the missing wiring named (a text slot needs its TEXT property, the logo an instance of the Brands library's Logo, a picture an image fill).",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        name: { type: "string" },
        slots: { type: "array", items: { type: "object", properties: { nodeId: { type: "string" }, role: { type: "string" }, locked: { type: "boolean" }, maxChars: { type: "number" } }, required: ["nodeId", "role"] } },
      },
      required: ["nodeId", "name"],
    },
    write: true,
  },
  {
    name: "export_posts",
    title: "Export posts",
    description: "Exports posts (nodeIds, or a campaign's: campaignId) with the platforms' presets into files saved in your working folder (the result gives their paths): preset — a preset id, or \"auto\" (default: each post's own: JPEG / PNG for a still post, MP4 for an animated one); zip — one zip (default when more than one file). Each post's file, bytes and warnings (over a size limit).",
    inputSchema: {
      type: "object",
      properties: {
        nodeIds: ids,
        campaignId: { type: "string" },
        preset: { type: "string", description: 'A preset id (§8), or "auto" (default): each post\'s own' },
        zip: { type: "boolean", description: "One zip (default when more than one file)" },
      },
    },
    write: false,
  },
  {
    name: "describe_schema",
    title: "Describe schema",
    description:
      "The JSON shape any tool takes for a name: a layer property (fills, effects, layoutMode), a document field (stackSpacing, prototypeInteractions, arcData), a schema type (Paint, Effect, PrototypeAction, VariableData) or \"Type.field\", an enum's values (EasingType), the prototype shapes Reaction, Trigger, Action, Transition, Easing, VariableData, device, flowStartingPoints, or an engine command's arguments (BIND_COMPONENT_PROPERTY, INSERT_INSTANCE …).",
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
    description: 'Runs any of the app\'s commands (list_commands lists them): {command: "<editor id>", nodeIds} as from the menus / shortcuts with those layers selected, or {engineCommand: "<NAME>", args: {...}, nodeIds?} — an engine command with its arguments (layers as its refs, or nodeIds as its selection); the ids it created come back in `created` (CREATE_PAGE / DUPLICATE_PAGE: the new page\'s id, as Figma\'s createPage() returns the page). Never on the user\'s selection: without nodeIds nothing is selected, and an empty nodeIds is an error. Refusals say why. BIND_COMPONENT_PROPERTY {refs, field, prop} applies a main\'s property to its layers — field is Figma\'s componentPropertyReferences key: "characters" (TEXT), "visible" (BOOLEAN) or "mainComponent" (INSTANCE_SWAP); describe_schema {field: "<COMMAND>"} gives any command\'s arguments.',
    inputSchema: { type: "object", properties: { command: { type: "string" }, engineCommand: { type: "string" }, args: { type: "object" }, nodeIds: { ...writeIds, description: "The layers the command acts on (its selection). " + WRITE_IDS } } },
    write: true,
  },
  {
    name: "pathfinder",
    title: "Pathfinder",
    description:
      "Adobe Illustrator's Pathfinders on the given layers (destructive: they are replaced by plain vectors, grouped — Minus Back: one vector; one undo step; the result's ids come back). DIVIDE: every overlap a separate piece, painted by the shape on top there (open paths cut too). TRIM: the hidden parts removed, strokes removed. MERGE: Trim, then touching pieces of the same fill merged. CROP: the top layer crops everything below it and goes. OUTLINE: every edge, split where they cross, as open paths stroked with the shape's fill colour. MINUS_BACK: the layers behind subtracted from the front one. Groups and frames are opened up; a boolean group counts as its result. For live (non-destructive) booleans use run_command BOOLEAN_UNION / SUBTRACT / INTERSECT / EXCLUDE.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { enum: ["DIVIDE", "TRIM", "MERGE", "CROP", "OUTLINE", "MINUS_BACK"] },
        nodeIds: { ...writeIds, description: "The layers, any order (their stacking decides what is on top). " + WRITE_IDS },
        precision: { type: "number", description: "How closely curves are followed, px (default 0.028, Illustrator's)." },
        removeRedundantPoints: { type: "boolean", description: "Default true." },
        removeUnpainted: { type: "boolean", description: "Divide and Outline drop unfilled shapes first. Default false." },
      },
      required: ["operation", "nodeIds"],
    },
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
      "Shows the owner a choice card in the chat and waits for the click: {question, options: [{id, label, detail?}]} → the option picked. `imageRoute: true` instead lists the image models (Gemini API, Gemini CLI, Antigravity, OpenAI) with \"Use this for this chat\" — ask it when pictures are needed and no image model is set. `suggestions: true` shows at most three options as chips under your answer (Social's follow-ups after a review passes) and returns at once — the chip the owner picks comes back as his next message.",
    inputSchema: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, detail: { type: "string" } }, required: ["id", "label"] } }, remember: { type: "boolean" }, imageRoute: { type: "boolean" }, suggestions: { type: "boolean" } } },
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
        formats: { ...ids, description: "Format ids: the brand's (default: post and story), or catalogue ids (list_formats: \"instagram.post\", \"linkedin.landscape\" …)" },
        scene: { type: "string" },
        variations: { type: "number", description: "Default 2" },
        request: { type: "string", description: "The owner's words" },
        template: { type: "string", description: "Social: a template's key (list_templates) — the frames are made from it and their slots filled" },
        captions: { type: "boolean", description: "Social: write each post's caption, hashtags and alt text afterwards (default true in Social)" },
        campaign: { type: "string", description: "Social: the campaign's name (default \"‹Products› — ‹Month›\")" },
        animate: { type: "object", description: "Social: a Motion pass per video format (seconds; style: a composite animation style)", properties: { seconds: { type: "number" }, style: { type: "string" } }, required: ["seconds"] },
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
      "Shows the review card (each frame ✓ or its problems; a problem: {id, kind: sharp-text | soft-text | shape | extra | missing | layout | brand | safe-area | caption | contrast | logo | video, detail, box?: frame coordinates, fix: fix-label | blur | regenerate | relayout | rewrite | retime}) and waits for the owner: \"Fix selected\" starts the fixes and returns their task ids (wait_tasks, then review the changed frames again) and the ones that are yours to do (rewrite: the caption with set_post; retime: set_timeline / the clips); \"Leave as is\" ends the loop. On posts, the problems also show as pins on the canvas until fixed or left.",
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
  {
    name: "make_brand_library",
    title: "Make brands library",
    description: "Creates the Brands library file (one Brand collection with a mode per brand, colour and font variables, text styles, a Logo component set with a Brand variant per brand) or updates it from the library, in a background tab, and returns {fileKey, brands}. Ask the owner first (ask_choice); publishing it stays his click.",
    inputSchema: { type: "object", properties: {} },
    write: false,
  },
];

export const MANAGER_TOOL_NAMES: ReadonlySet<string> = new Set(MANAGER_TOOLS.map((t) => t.name));

/**
 * Tools that wait for the owner, for tasks or for a long render: main gives them 30 minutes instead of 120 s
 * (docs/studio.md §2.2; export_animation, docs/motion.md §9; export_posts and make_brand_library, docs/social.md §7.2).
 */
export const WAITING_TOOLS: ReadonlySet<string> = new Set(["wait_tasks", "ask_choice", "show_form", "report_review", "make_posts", "library_read_labels", "export_animation", "export_posts", "make_brand_library"]);
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
  /** Files the call made (export_animation): main saves them in the agent's working folder and tells it where (not sent as such). */
  files?: ToolFile[];
}

/** A file a tool made, its bytes as base64. */
export interface ToolFile {
  name: string;
  data: string;
  mimeType: string;
}

export const textResult = (value: unknown, isError = false): ToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }], isError: isError || undefined });
