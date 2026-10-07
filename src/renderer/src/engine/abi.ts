/**
 * The engine ABI's numbers: tools, commands, flags and status codes
 * (docs/engine.md §8.4, §10.3, §10.6). They mirror engine/src/editor/Editor.h
 * and Commands.h — append only; a test checks the two agree. Interim: written
 * by hand until apigen generates them from engine/api/*.def.ts.
 */

/** The Tool enum (§8.4). The engine implements all but SCALE, SECTION, SLICE, IMAGE and COMMENT. */
export const TOOLS = [
  "MOVE", "SCALE", "HAND", "FRAME", "SECTION", "SLICE", "RECTANGLE", "LINE", "ARROW",
  "ELLIPSE", "POLYGON", "STAR", "IMAGE", "PEN", "PENCIL", "TEXT", "COMMENT",
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
/** engine_read_nodes flags. */
export const INCLUDE_CHILD_IDS = 1;
/** engine_paste flags. */
export const PASTE_IN_PLACE = 1;
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
