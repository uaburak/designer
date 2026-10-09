// Command ids (docs/engine.md §10.6). Interim: hand-kept until
// engine/api/commands.def.ts generates them; the TS twin is
// src/renderer/src/engine/abi.ts (CommandId). Values are the wire format: append only.
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
  SELECT_INVERSE = 16,
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
  // E4: booleans, vector commands, masks; E5: images.
  BOOLEAN_UNION = 100,
  BOOLEAN_SUBTRACT = 101,
  BOOLEAN_INTERSECT = 102,
  BOOLEAN_EXCLUDE = 103,
  FLATTEN = 104,
  OUTLINE_STROKE = 105,
  USE_AS_MASK = 106,             // toggles; CMD_CHECKED when the selection is a mask
  PLACE_IMAGES = 107,            // args {hash, width, height, name?, x?, y?}
  VECTOR_SET_MIRRORING = 110,    // args {mirroring: "NONE" | "ANGLE" | "ANGLE_AND_LENGTH"}
  VECTOR_DELETE_AND_HEAL = 111,
  VECTOR_SET_POINTS = 112,       // args {x?, y?, cornerRadius?}
  SET_END_CAPS = 113,            // args {start?, end?: StrokeCap}
  // E6: components and instances (docs/engine-build.md "E6").
  CREATE_COMPONENT = 120,           // args {mode?: "SINGLE" | "MULTIPLE" | "SET"}
  COMBINE_AS_VARIANTS = 121,
  ADD_VARIANT = 122,
  DETACH_INSTANCE = 123,            // args {ref?}
  RESET_OVERRIDES = 124,            // args {ref?, field? | fields?}
  PUSH_CHANGES_TO_MAIN = 125,
  GO_TO_MAIN_COMPONENT = 126,
  RETURN_TO_INSTANCE = 127,
  SWAP_INSTANCE = 128,              // args {main, ref?}
  SET_COMPONENT_PROPERTY = 129,     // args {ref?, prop, value}
  ADD_COMPONENT_PROPERTY = 130,     // args {ref?, name?, type, defaultValue?, bind?, preferredValues?}
  EDIT_COMPONENT_PROPERTY = 131,    // args {ref?, prop, name?, defaultValue?, preferredValues?, oldValue?, newValue?}
  DELETE_COMPONENT_PROPERTY = 132,  // args {ref?, prop}
  BIND_COMPONENT_PROPERTY = 133,    // args {refs?, field, prop}
  RESTORE_COMPONENT = 134,          // args {ref?}
  SET_EXPOSED_INSTANCE = 135,       // args {ref?, exposed}
  RESET_SLOT = 136,                 // args {ref?}
  INSERT_INSTANCE = 137,            // args {main, x?, y?, parent?}
  SET_VARIANT_PROPERTIES = 138,     // args {ref?, values: {prop: value}}
  // E6: variables, modes and styles (docs/engine-build.md "E6 variables"). `created` ids go to the result slot.
  CREATE_VARIABLE_COLLECTION = 140,     // args {name?}
  RENAME_VARIABLE_COLLECTION = 141,     // args {collection, name}
  DELETE_VARIABLE_COLLECTION = 142,     // args {collection}
  MOVE_VARIABLE_COLLECTION = 143,       // args {collection, index}
  DUPLICATE_VARIABLE_COLLECTION = 144,  // args {collection}
  ADD_VARIABLE_MODE = 145,              // args {collection, name?}
  RENAME_VARIABLE_MODE = 146,           // args {collection, mode, name}
  DELETE_VARIABLE_MODE = 147,           // args {collection, mode}
  MOVE_VARIABLE_MODE = 148,             // args {collection, mode, index}
  DUPLICATE_VARIABLE_MODE = 149,        // args {collection, mode}
  CREATE_VARIABLE = 150,                // args {collection, type, name?, value?, group?}
  RENAME_VARIABLE = 151,                // args {variable, name}
  DELETE_VARIABLES = 152,               // args {variables}
  MOVE_VARIABLES = 153,                 // args {variables, index, group?}
  DUPLICATE_VARIABLES = 154,            // args {variables}
  SET_VARIABLE_VALUE = 155,             // args {variable, mode?, value}
  SET_VARIABLE_SCOPES = 156,            // args {variables, scopes}
  SET_VARIABLE_CODE_SYNTAX = 157,       // args {variable, platform, value}
  SET_VARIABLE_DESCRIPTION = 158,       // args {variable, description}
  SET_VARIABLE_HIDDEN = 159,            // args {variables, hidden}
  GROUP_VARIABLES = 160,                // args {variables, name}
  RENAME_VARIABLE_GROUP = 161,          // args {collection, group, name}
  UNGROUP_VARIABLES = 162,              // args {collection, group}
  DELETE_VARIABLE_GROUP = 163,          // args {collection, group}
  DUPLICATE_VARIABLE_GROUP = 164,       // args {collection, group}
  BIND_VARIABLE = 165,                  // args {refs?, target, variable}
  DETACH_VARIABLE = 166,                // args {refs?, target}
  SET_VARIABLE_MODE = 167,              // args {refs?, page?, collection, mode} (collection: an extended one too)
  EXTEND_VARIABLE_COLLECTION = 168,     // args {collection, name?} ("Extend collection")
  RESET_VARIABLE_OVERRIDE = 169,        // args {collection, variable(s), mode?} (an extended collection: "Reset change")
  CREATE_STYLE = 170,                   // args {type, name?, from?, apply?, target?}
  DELETE_STYLE = 171,                   // args {style}
  APPLY_STYLE = 172,                    // args {refs?, style, target?}
  DETACH_STYLE = 173,                   // args {refs?, target}
  MOVE_STYLE = 174,                     // args {style, index}
  GROUP_STYLES = 175,                   // args {styles, name}
  RENAME_STYLE_GROUP = 176,             // args {type, group, name}
  UNGROUP_STYLES = 177,                 // args {type, group}
  REPLACE_FONTS = 190,                  // args {fonts: [{from: {family, style}, to: {family, style}}]} (Missing fonts' "Replace fonts")
  // Round 6 (branch r6-components-grid; 210-219 kept clear of parallel rounds): slots.
  CONVERT_TO_SLOT = 210,                // args {ref?: Guid | Guid[]} ("Convert to slot", ⌘⇧S): nested frames of a main
  WRAP_IN_NEW_SLOT = 211,               // the selection framed, the frame made a slot ("Wrap in new slot")
  CLEAR_SLOT = 212,                     // args {ref?}: a slot (an instance's slot row, or a main's slot frame) emptied ("Delete contents")
  // Round 6 (branch r6-annotations-devmode): Dev Mode's saved measurements (editor/DevMode.cpp); 220-229.
  MEASUREMENT_ADD = 220,                // args {from, to?, side, toSameSide?, inner?, outer?, freeText?, page?}; created: [id]
  MEASUREMENT_UPDATE = 221,             // args {id, freeText?, inner?, outer?, page?}
  MEASUREMENT_DELETE = 222,             // args {id, page?}
  // Round 7 (branch r7-selection): selection and canvas commands (editor/SelectionCommands.cpp); 230-249.
  WRAP_IN_SECTION = 230,                // "Wrap in new section" (⌘S in live Figma's context menu): canvas-level layers
  REMOVE_KEEP_CONTENTS = 231,           // a section, frame or group removed, its layers kept where they are
  SELECT_MATCHING = 232,                // args {mode?: "LAYERS" | "FILL" | "STROKE" | "EFFECT" | "TEXT" | "FONT" | "INSTANCE"}
  TIDY_UP = 233,                        // ⌃⌥T
  ZOOM_TO_NEXT_FRAME = 234,             // N
  ZOOM_TO_PREVIOUS_FRAME = 235,         // ⇧N
  // Round 8 (branch r8-selection): canvas tools and views (tools/CanvasTools.cpp).
  SHOW_ROTATION_ORIGIN = 236,           // ⌥R: the selection's rotation origin shown (drag it; rotation turns about it); toggles
  REMOVE_GUIDE = 237,                   // the selected ruler guide removed ("Remove guide")
  // Round 8 (branch r8-design-panel): the Grid panel (tools/GridGestures.cpp); 260-269.
  SELECT_GRID_TRACKS = 260,             // args {frame, axis: "COLUMNS" | "ROWS", tracks: number[]} — the selected grid's tracks ([] clears)
  // Round 10 (branch r10-menus-commands): the Figma menu's Object, Arrange and Vector commands live Figma has
  // (editor/ArrangeCommands.cpp); 270-289.
  CONVERT_TO_SECTION = 270,             // top-level frames become sections in place (same GUID, layers and look)
  CONVERT_TO_FRAME = 271,               // sections become frames in place
  DISTRIBUTE_LEFT = 272,                // the left edges evenly spaced, the first and last layer staying
  DISTRIBUTE_HORIZONTAL_CENTERS = 273,
  DISTRIBUTE_RIGHT = 274,
  DISTRIBUTE_TOP = 275,
  DISTRIBUTE_VERTICAL_CENTERS = 276,
  DISTRIBUTE_BOTTOM = 277,
  PACK_HORIZONTAL = 278,                // side by side, no space between them, the first staying
  PACK_VERTICAL = 279,
  ROUND_TO_PIXEL = 280,                 // the selection's position and size on whole pixels
  VECTOR_JOIN = 281,                    // args {smooth?}: vector edit mode's selected points joined (⌘J / ⇧⌘J)
  VECTOR_SPLIT = 282,                   // edit mode: the path split at the selected points; else a layer's parts apart
  VECTOR_SIMPLIFY = 283,                // args {amount: 0…1}: fewer points, the shape kept within a tolerance
  VECTOR_OFFSET = 284,                  // args {amount, join: "MITER" | "ROUND"}: the outline grown (+) or shrunk (−)
  SET_DEFAULT_PROPERTIES = 285,         // the selected layer's look: what new layers of its type start with (this session)
};

// engine_command_state bits.
enum CommandState : uint32_t { CMD_ENABLED = 1, CMD_CHECKED = 2 };

}  // namespace eng
