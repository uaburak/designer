/**
 * The engine ABI's numbers: tools, commands, flags and status codes
 * (docs/engine.md §8.4, §10.3, §10.6). They mirror engine/src/editor/Editor.h
 * and Commands.h — append only; a test checks the two agree. Interim: written
 * by hand until apigen generates them from engine/api/*.def.ts.
 */

/** The Tool enum (§8.4). The engine implements all but SCALE, SLICE, IMAGE and COMMENT. */
export const TOOLS = [
  "MOVE", "SCALE", "HAND", "FRAME", "SECTION", "SLICE", "RECTANGLE", "LINE", "ARROW",
  "ELLIPSE", "POLYGON", "STAR", "IMAGE", "PEN", "PENCIL", "TEXT", "COMMENT",
  // Dev Mode's tools (⇧T, ⇧M; engine/src/editor/DevMode.cpp)
  "ANNOTATION", "MEASUREMENT",
] as const;
export type ToolName = (typeof TOOLS)[number];
export const toolId = (tool: ToolName): number => TOOLS.indexOf(tool);

/** Command ids (§10.6). */
export const CommandId = {
  UNDO: 1,
  REDO: 2,
  SELECT_ALL: 10,
  SELECT_NONE: 11,
  SELECT_CHILDREN: 12,
  SELECT_PARENT: 13,
  SELECT_NEXT_SIBLING: 14,
  SELECT_PREV_SIBLING: 15,
  SELECT_INVERSE: 16,
  DELETE: 20,
  NUDGE: 21,
  BRING_FORWARD: 30,
  SEND_BACKWARD: 31,
  BRING_TO_FRONT: 32,
  SEND_TO_BACK: 33,
  TOGGLE_LOCK: 40,
  TOGGLE_VISIBLE: 41,
  ZOOM_IN: 50,
  ZOOM_OUT: 51,
  ZOOM_TO_100: 52,
  ZOOM_TO_FIT: 53,
  ZOOM_TO_SELECTION: 54,
  GROUP: 60,
  UNGROUP: 61,
  FRAME_SELECTION: 62,
  DUPLICATE: 63,
  FLIP_HORIZONTAL: 64,
  FLIP_VERTICAL: 65,
  ALIGN_LEFT: 70,
  ALIGN_HORIZONTAL_CENTER: 71,
  ALIGN_RIGHT: 72,
  ALIGN_TOP: 73,
  ALIGN_VERTICAL_CENTER: 74,
  ALIGN_BOTTOM: 75,
  DISTRIBUTE_HORIZONTAL: 76,
  DISTRIBUTE_VERTICAL: 77,
  ADD_AUTO_LAYOUT: 80,
  REMOVE_AUTO_LAYOUT: 81,
  CREATE_PAGE: 90,
  /** args { page: "s:l" } (the current page when absent) */
  DELETE_PAGE: 91,
  /** args { page: "s:l" } (the current page when absent) */
  DUPLICATE_PAGE: 92,
  /** "Union selection" (⌥⇧U); with boolean groups selected: changes their operation. */
  BOOLEAN_UNION: 100,
  BOOLEAN_SUBTRACT: 101,
  BOOLEAN_INTERSECT: 102,
  BOOLEAN_EXCLUDE: 103,
  /** ⌘E: the selection becomes one VECTOR (the topmost layer's GUID). */
  FLATTEN: 104,
  /** ⌥⌘O */
  OUTLINE_STROKE: 105,
  /** ⌃⌘M: toggles; CMD_CHECKED when the selection is a mask. Several layers: grouped, the bottom one the mask. */
  USE_AS_MASK: 106,
  /** args { hash, width, height, name?, x?, y? }: a rectangle that size with the image (Fill), at the page point or the view's centre. */
  PLACE_IMAGES: 107,
  /** Vector edit mode, the selected points: args { mirroring: "NONE" | "ANGLE" | "ANGLE_AND_LENGTH" } */
  VECTOR_SET_MIRRORING: 110,
  VECTOR_DELETE_AND_HEAL: 111,
  /** args { x?, y?, cornerRadius? }: x / y in the parent's space (the points' bounds' top left). */
  VECTOR_SET_POINTS: 112,
  /** args { start?, end?: StrokeCap }: open paths' ends (the selection, or the vector being edited). */
  SET_END_CAPS: 113,
  // E6: components and instances (docs/engine-build.md "E6"). `ref` args default to the selection.
  /** ⌥⌘K. args { mode?: "SINGLE" | "MULTIPLE" | "SET" } ("Create component" / "Create multiple components" / "Create component set"). */
  CREATE_COMPONENT: 120,
  COMBINE_AS_VARIANTS: 121,
  ADD_VARIANT: 122,
  /** ⌥⌘B. args { ref? } (a nested instance detaches its ancestors first). */
  DETACH_INSTANCE: 123,
  /** args { ref?, field?, fields? }: "Reset all changes", or Reset › those properties (schema field names). */
  RESET_OVERRIDES: 124,
  PUSH_CHANGES_TO_MAIN: 125,
  /** ⌃⌥⌘K: selects the main (switching page), zooms to it; INSTANCE_NAVIGATION follows. */
  GO_TO_MAIN_COMPONENT: 126,
  RETURN_TO_INSTANCE: 127,
  /** args { main, ref? } */
  SWAP_INSTANCE: 128,
  /** args { ref?, prop: id | name, value: boolean | string | Guid } */
  SET_COMPONENT_PROPERTY: 129,
  /** args { ref?, name?, type: "BOOL" | "TEXT" | "INSTANCE_SWAP" | "VARIANT" | "SLOT", defaultValue?, bind?: Guid[], preferredValues?: Guid[] } */
  ADD_COMPONENT_PROPERTY: 130,
  /** args { ref?, prop, name?, defaultValue?, preferredValues?, oldValue?, newValue? } */
  EDIT_COMPONENT_PROPERTY: 131,
  /** args { ref?, prop } */
  DELETE_COMPONENT_PROPERTY: 132,
  /** args { refs?, field: "VISIBLE" | "TEXT_DATA" | "OVERRIDDEN_SYMBOL_ID" | "SLOT_CONTENT_ID", prop ("" unbinds) } */
  BIND_COMPONENT_PROPERTY: 133,
  /** args { ref? }: an instance whose main was deleted, or the deleted main. */
  RESTORE_COMPONENT: 134,
  /** args { ref?, exposed: boolean }: a nested instance in a main ("Expose properties from nested instances"). */
  SET_EXPOSED_INSTANCE: 135,
  /** args { ref? }: a slot (or its content) back to the main's content. */
  RESET_SLOT: 136,
  /** args { main, x?, y?, parent? }: an instance of a main (a set: its default variant) centred at the page point (else the view's centre). */
  INSERT_INSTANCE: 137,
  /** args { ref?, values: { [property]: value } }: a variant's own values in its set (renames it). */
  SET_VARIANT_PROPERTIES: 138,
  // E6: variables, modes and styles (docs/engine-build.md "E6 variables"). `engine.runCommand` returns what was created.
  /** args { name? } ("Collection", one mode "Mode 1"); created: [collection, its mode]. */
  CREATE_VARIABLE_COLLECTION: 140,
  /** args { collection, name } */
  RENAME_VARIABLE_COLLECTION: 141,
  /** args { collection } (its variables too; soft-deleted while used) */
  DELETE_VARIABLE_COLLECTION: 142,
  /** args { collection, index } */
  MOVE_VARIABLE_COLLECTION: 143,
  /** args { collection }; created: [the copy, its variables…] */
  DUPLICATE_VARIABLE_COLLECTION: 144,
  /** args { collection, name? } ("Mode N", values copied from the default mode); created: [mode] */
  ADD_VARIABLE_MODE: 145,
  /** args { collection, mode, name } (≤ 40 characters) */
  RENAME_VARIABLE_MODE: 146,
  /** args { collection, mode } (never the last) */
  DELETE_VARIABLE_MODE: 147,
  /** args { collection, mode, index } (index 0 = "Set as default") */
  MOVE_VARIABLE_MODE: 148,
  /** args { collection, mode }; created: [mode] */
  DUPLICATE_VARIABLE_MODE: 149,
  /** args { collection, type: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN", name?, value?, group? }; created: [variable] */
  CREATE_VARIABLE: 150,
  /** args { variable, name } (unique in its collection; no `.`, `{`, `}`) */
  RENAME_VARIABLE: 151,
  /** args { variables } */
  DELETE_VARIABLES: 152,
  /** args { variables, index, group? } */
  MOVE_VARIABLES: 153,
  /** args { variables }; created: the copies */
  DUPLICATE_VARIABLES: 154,
  /** args { variable, mode?, value: VariableValue } */
  SET_VARIABLE_VALUE: 155,
  /** args { variables, scopes: VariableScope[] } */
  SET_VARIABLE_SCOPES: 156,
  /** args { variable, platform: "WEB" | "ANDROID" | "iOS", value } ("" removes) */
  SET_VARIABLE_CODE_SYNTAX: 157,
  /** args { variable, description } */
  SET_VARIABLE_DESCRIPTION: 158,
  /** args { variables, hidden } (Hide from publishing) */
  SET_VARIABLE_HIDDEN: 159,
  /** args { variables, name } ("New group with selection") */
  GROUP_VARIABLES: 160,
  /** args { collection, group, name } */
  RENAME_VARIABLE_GROUP: 161,
  /** args { collection, group } */
  UNGROUP_VARIABLES: 162,
  /** args { collection, group } */
  DELETE_VARIABLE_GROUP: 163,
  /** args { collection, group }; created: the copies */
  DUPLICATE_VARIABLE_GROUP: 164,
  /** args { refs?, target: BindingTarget, variable } (variable "" / null detaches) */
  BIND_VARIABLE: 165,
  /** args { refs?, target } */
  DETACH_VARIABLE: 166,
  /** args { refs?, page?, collection, mode } (mode "" = Auto) */
  SET_VARIABLE_MODE: 167,
  /** args { collection, name? } — "Extend collection": an extended collection of `collection` */
  EXTEND_VARIABLE_COLLECTION: 168,
  /** args { collection, variable | variables, mode? } — an extended collection's override removed ("Reset change") */
  RESET_VARIABLE_OVERRIDE: 169,
  /** args { type: "FILL" | "TEXT" | "EFFECT" | "GRID", name?, from?, apply?, target?: "FILL" | "STROKE" }; created: [style] */
  CREATE_STYLE: 170,
  /** args { style } (its users keep the values, detached) */
  DELETE_STYLE: 171,
  /** args { refs?, style, target?: "FILL" | "STROKE" } */
  APPLY_STYLE: 172,
  /** args { refs?, target: "FILL" | "STROKE" | "TEXT" | "EFFECT" | "GRID" } */
  DETACH_STYLE: 173,
  /** args { style, index } (among its type) */
  MOVE_STYLE: 174,
  /** args { styles, name } ("Add new folder") */
  GROUP_STYLES: 175,
  /** args { type, group, name } */
  RENAME_STYLE_GROUP: 176,
  /** args { type, group } */
  UNGROUP_STYLES: 177,
  /** args { fonts: [{ from: { family, style }, to: { family, style } }] } (the Missing fonts dialog's "Replace fonts") */
  REPLACE_FONTS: 190,
  // Round 6 (r6-components-grid): slots.
  /** args { ref?: Guid | Guid[] } ("Convert to slot", ⇧⌘S): nested frames of a main become slots (a SLOT property each) */
  CONVERT_TO_SLOT: 210,
  /** The selection framed and the frame made a slot ("Wrap in new slot") */
  WRAP_IN_NEW_SLOT: 211,
  /** args { ref? }: a slot emptied — an instance's slot row (its content diverges) or a main's slot frame ("Delete contents") */
  CLEAR_SLOT: 212,
  // Round 6 (r6-annotations-devmode): Dev Mode's saved measurements; 220-229.
  /** args { from, to?, side: "TOP" | "BOTTOM" | "LEFT" | "RIGHT", toSameSide?, inner?, outer?, freeText?, page? }; created: [id] */
  MEASUREMENT_ADD: 220,
  /** args { id, freeText?, inner?, outer?, page? } */
  MEASUREMENT_UPDATE: 221,
  /** args { id, page? } */
  MEASUREMENT_DELETE: 222,
  // Round 7 (r7-selection): selection and canvas commands (engine/src/editor/SelectionCommands.cpp); 230-249.
  /** "Wrap in new section" (⌘S): the canvas-level selection in a new section around it; created: the section selected. */
  WRAP_IN_SECTION: 230,
  /** A section, frame or group removed, its layers kept where they are (selected) — ⌘⌫ on a frame or section. */
  REMOVE_KEEP_CONTENTS: 231,
  /** args { mode?: "LAYERS" | "FILL" | "STROKE" | "EFFECT" | "TEXT" | "FONT" | "INSTANCE" }: "Select matching layers" (⌥⌘A), "Select all with same …". */
  SELECT_MATCHING: 232,
  /** "Tidy up" (⌃⌥T): the selection into an even grid of its rows and columns. */
  TIDY_UP: 233,
  /** N: the view to the next frame (the selection stays). */
  ZOOM_TO_NEXT_FRAME: 234,
  /** ⇧N: the view to the previous frame. */
  ZOOM_TO_PREVIOUS_FRAME: 235,
} as const;
export type CommandName = keyof typeof CommandId;

export const CMD_ENABLED = 1;
export const CMD_CHECKED = 2;

/** Modifier bits. PRIMARY is the platform's command key: ⌘ on a Mac, Ctrl elsewhere. */
export const MOD_SHIFT = 1;
export const MOD_ALT = 2;
export const MOD_CTRL = 4;
export const MOD_META = 8;
export const MOD_PRIMARY = 16;

export const PointerType = { DOWN: 0, MOVE: 1, UP: 2, CANCEL: 3, ENTER: 4, LEAVE: 5 } as const;
export const POINTER_HANDLED = 1;
export const POINTER_CAPTURE = 2;
export const KeyType = { DOWN: 0, UP: 1 } as const;
export const KEY_HANDLED = 1;
export const WHEEL_PINCH = 1;
export const TICK_NEEDS_RENDER = 1;

/** engine_apply_changes flags. */
export const APPLY_USER = 1;
export const APPLY_REMOTE = 2;
export const APPLY_LOAD = 4;
/** Journaled and emitted, not an undo step (library bookkeeping); never writes into library copies. */
export const APPLY_SYSTEM = 8;
/** A store-computed document state (Restore version): library copies written too, none of the user-edit rules. */
export const APPLY_EXACT = 16;
/** engine_read_nodes flags. */
export const INCLUDE_CHILD_IDS = 1;
/** Each ref followed by its descendants (pre-order, children back to front: paint order). */
export const READ_SUBTREE = 2;
/** With READ_SUBTREE: hidden layers and what is under them left out (the refs themselves are always written). */
export const READ_VISIBLE_ONLY = 4;
/** engine_paste flags. */
export const PASTE_IN_PLACE = 1;
/** ⇧⌘V "Paste over selection": just above the selection (with PASTE_IN_PLACE: where it was copied from). */
export const PASTE_OVER = 2;
/** ⇧⌘R "Paste to replace": a copy at each selected layer's place, which goes. */
export const PASTE_REPLACE = 4;
/** engine_set_view_options bits: View › Pixel grid, outline mode (⇧⌘O). */
export const VIEW_PIXEL_GRID = 1;
export const VIEW_OUTLINES = 2;
/** engine_encode_selection flags. */
export const ENCODE_SELECTION_CUT = 1;
/** engine_encode_document flags: the derived data (derivedSymbolData, derivedTextData, derivedDataVersion) too — kiwi only. */
export const ENCODE_DERIVED = 1;
/** engine_set_wire_format values (docs/engine-build.md "Figma parity round 3"): the engine's structured outputs. */
export const WIRE_JSON = 0;
export const WIRE_KIWI = 1;
/** engine_variable_collections / engine_variables / engine_styles flags: library copies too. */
export const INCLUDE_REMOTE = 1;
/** engine_export flags: draw even while fonts or images it needs are still loading. */
export const EXPORT_ALLOW_PENDING = 1;
/** engine_text_edit flags. */
export const TEXT_EDIT_SELECT_ALL = 1;
/** engine_vector_edit_tool values. */
export const VECTOR_EDIT_TOOLS = ["MOVE", "PEN", "BEND", "LASSO", "PAINT_BUCKET"] as const;

/** Status codes (§10.3). */
export const Status = {
  OK: 0,
  E_HANDLE: -1,
  E_DECODE: -2,
  E_INVALID: -3,
  E_OOM: -4,
  E_NOT_FOUND: -5,
  E_READONLY: -6,
  E_BUSY: -7,
  E_UNSUPPORTED: -8,
} as const;

/** NODES_CHANGED field groups (§10.4). */
export const FieldGroup = { GEOMETRY: 1, LAYOUT: 2, PAINT: 4, TEXT: 8, NAME: 16, VISIBILITY: 32, COMPONENT: 64, BINDINGS: 128 } as const;

export const ABI_VERSION = 1;
