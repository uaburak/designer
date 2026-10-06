/**
 * The engine ABI's numbers: tools, commands, flags and status codes
 * (docs/engine.md §8.4, §10.3, §10.6). They mirror engine/src/editor/Editor.h
 * and Commands.h — append only; a test checks the two agree. Interim: written
 * by hand until apigen generates them from engine/api/*.def.ts.
 */

/** The Tool enum (§8.4). The engine implements MOVE, HAND, FRAME, RECTANGLE, ELLIPSE and TEXT so far. */
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
