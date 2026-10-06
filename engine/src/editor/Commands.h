// Command ids (docs/engine.md §10.6). Interim: hand-kept until
// engine/api/commands.def.ts generates them; the TS twin is
// src/renderer/src/engine/commands.ts. Values are the wire format: append only.
#pragma once

#include <cstdint>

namespace eng {

enum class CommandId : uint32_t {
  UNDO = 1,
  REDO = 2,
  SELECT_ALL = 10,
  SELECT_NONE = 11,
  SELECT_CHILDREN = 12,
  SELECT_PARENT = 13,
  SELECT_NEXT_SIBLING = 14,
  SELECT_PREV_SIBLING = 15,
  DELETE = 20,
  NUDGE = 21,  // args {dx, dy}
  BRING_FORWARD = 30,
  SEND_BACKWARD = 31,
  BRING_TO_FRONT = 32,
  SEND_TO_BACK = 33,
  TOGGLE_LOCK = 40,
  TOGGLE_VISIBLE = 41,
  ZOOM_IN = 50,
  ZOOM_OUT = 51,
  ZOOM_TO_100 = 52,
  ZOOM_TO_FIT = 53,
  ZOOM_TO_SELECTION = 54,
  GROUP = 60,
  UNGROUP = 61,
  FRAME_SELECTION = 62,
  DUPLICATE = 63,
  FLIP_HORIZONTAL = 64,
  FLIP_VERTICAL = 65,
  ALIGN_LEFT = 70,
  ALIGN_HORIZONTAL_CENTER = 71,
  ALIGN_RIGHT = 72,
  ALIGN_TOP = 73,
  ALIGN_VERTICAL_CENTER = 74,
  ALIGN_BOTTOM = 75,
  DISTRIBUTE_HORIZONTAL = 76,
  DISTRIBUTE_VERTICAL = 77,
  ADD_AUTO_LAYOUT = 80,
  REMOVE_AUTO_LAYOUT = 81,
  CREATE_PAGE = 90,
  DELETE_PAGE = 91,     // args {page} (the current page when absent)
  DUPLICATE_PAGE = 92,  // args {page}
};

// engine_command_state bits.
enum CommandState : uint32_t { CMD_ENABLED = 1, CMD_CHECKED = 2 };

}  // namespace eng
