// Prototyping data (docs/schema.md §12, Figma's kiwi fields): the interactions on a layer, a frame's overflow and
// overlay settings, a child's scroll behaviour, the page's flows and prototype device. The engine doesn't model these
// in NodeProps — they stay as kiwi bytes in NodeProps::extra, so they round-trip with .fig files untouched — and
// this module reads them on demand (through the schema's JSON view of those bytes) and writes them back.
//
// Enum values are the schema's (schema/document.kiwi "Prototyping").
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "base/Json.h"
#include "scene/Document.h"

namespace eng::proto {

enum class Trigger : uint8_t {
  ON_CLICK = 0, AFTER_TIMEOUT = 1, MOUSE_IN = 2, MOUSE_OUT = 3, ON_HOVER = 4, MOUSE_DOWN = 5, MOUSE_UP = 6,
  ON_PRESS = 7, NONE = 8, DRAG = 9, ON_KEY_DOWN = 10, MOUSE_ENTER = 14, MOUSE_LEAVE = 15
};
enum class Connection : uint8_t { NONE = 0, INTERNAL_NODE = 1, URL = 2, BACK = 3, CLOSE = 4, SET_VARIABLE = 5, CONDITIONAL = 7, SET_VARIABLE_MODE = 8 };
enum class Navigation : uint8_t { NAVIGATE = 0, OVERLAY = 1, SWAP = 2, SWAP_STATE = 3, SCROLL_TO = 4 };
enum class Transition : uint8_t {
  INSTANT = 0, DISSOLVE = 1, FADE = 2,
  SLIDE_FROM_LEFT = 3, SLIDE_FROM_RIGHT = 4, SLIDE_FROM_TOP = 5, SLIDE_FROM_BOTTOM = 6,
  PUSH_FROM_LEFT = 7, PUSH_FROM_RIGHT = 8, PUSH_FROM_TOP = 9, PUSH_FROM_BOTTOM = 10,
  MOVE_FROM_LEFT = 11, MOVE_FROM_RIGHT = 12, MOVE_FROM_TOP = 13, MOVE_FROM_BOTTOM = 14,
  SLIDE_OUT_TO_LEFT = 15, SLIDE_OUT_TO_RIGHT = 16, SLIDE_OUT_TO_TOP = 17, SLIDE_OUT_TO_BOTTOM = 18,
  MOVE_OUT_TO_LEFT = 19, MOVE_OUT_TO_RIGHT = 20, MOVE_OUT_TO_TOP = 21, MOVE_OUT_TO_BOTTOM = 22,
  MAGIC_MOVE = 23, SMART_ANIMATE = 24, SCROLL_ANIMATE = 25
};
enum class Easing : uint8_t {
  IN_CUBIC = 0, OUT_CUBIC = 1, INOUT_CUBIC = 2, LINEAR = 3, IN_BACK_CUBIC = 4, OUT_BACK_CUBIC = 5, INOUT_BACK_CUBIC = 6,
  CUSTOM_CUBIC = 7, SPRING = 8, GENTLE_SPRING = 9, CUSTOM_SPRING = 10, SPRING_PRESET_ONE = 11, SPRING_PRESET_TWO = 12,
  SPRING_PRESET_THREE = 13, HOLD = 14, EASE_IN = 15
};
enum class OverlayPosition : uint8_t { CENTER = 0, TOP_LEFT, TOP_CENTER, TOP_RIGHT, BOTTOM_LEFT, BOTTOM_CENTER, BOTTOM_RIGHT, MANUAL };
enum class Overflow : uint8_t { NONE = 0, HORIZONTAL = 1, VERTICAL = 2, BOTH = 3 };
enum class ScrollBehavior : uint8_t { SCROLLS = 0, FIXED = 1, STICKY = 2 };

const char* triggerName(Trigger t);
const char* connectionName(Connection c);
const char* navigationName(Navigation n);
const char* transitionName(Transition t);
const char* easingName(Easing e);

struct Action;
struct Branch {
  bool hasCondition = false;
  json::Value condition;  // a VariableData (BOOLEAN literal, alias or EXPRESSION), as the schema's JSON
  std::vector<Action> actions;
};

struct Action {
  Connection connection = Connection::NONE;
  Navigation navigation = Navigation::NAVIGATE;
  Guid dest = kNoGuid;
  Transition transition = Transition::INSTANT;
  double duration = 0.3;  // seconds
  Easing easing = Easing::OUT_CUBIC;
  std::vector<double> easingFunction;  // CUSTOM_CUBIC: x1 y1 x2 y2; CUSTOM_SPRING: mass stiffness damping
  bool smartAnimate = false;           // "Animate matching layers" (MAGIC_MOVE / SMART_ANIMATE imply it)
  bool preserveScroll = false;
  bool resetScroll = false;
  bool resetComponents = false;
  std::string url;
  bool newTab = false;
  bool hasOverlayOffset = false;
  Vec2 overlayOffset;  // MANUAL overlays: where the overlay lands, relative to the hotspot's top-left
  Vec2 scrollOffset;   // SCROLL_TO: extraScrollOffset
  json::Value targetVariable;      // SET_VARIABLE: VariableID
  json::Value targetVariableData;  // SET_VARIABLE: VariableData
  json::Value targetVariableSet;   // SET_VARIABLE_MODE: VariableSetID
  Guid targetMode = kNoGuid;
  std::vector<Branch> branches;    // CONDITIONAL
};

struct Interaction {
  Guid id = kNoGuid;
  Trigger trigger = Trigger::ON_CLICK;
  double timeout = 0.8;  // AFTER_TIMEOUT, seconds (the event's transitionTimeout)
  std::vector<int> keyCodes;  // ON_KEY_DOWN
  std::vector<Action> actions;
};

struct OverlaySettings {
  OverlayPosition position = OverlayPosition::CENTER;
  bool closeOnClickOutside = false;
  bool background = false;
  Color backgroundColor{0, 0, 0, 0.25f};
};

struct Device {
  enum class Type : uint8_t { NONE, PRESET, CUSTOM, PRESENTATION } type = Type::NONE;
  bool none = true;  // PrototypeDeviceType NONE (or absent, or PRESENTATION): frames shown at their own size
  Vec2 size;          // PRESET / CUSTOM: the screen
  std::string preset;
  bool rotated = false;  // CCW_90: landscape
};

struct Flow {
  Guid node = kNoGuid;
  std::string name, description, position;
};

// Reads. Absent fields read as their schema defaults; unreadable bytes as absent.
std::vector<Interaction> interactions(const NodeProps& p);
bool hasInteractions(const NodeProps& p);
Overflow overflow(const NodeProps& p);
ScrollBehavior scrollBehavior(const NodeProps& p);
OverlaySettings overlaySettings(const NodeProps& p);
bool flowStart(const NodeProps& p, Flow& out);  // the node's prototypeStartingPoint
Device device(const NodeProps& page);
Color background(const NodeProps& page);  // prototypeBackgroundColor (absent: Figma's #1E1E1E)
// The page's flows in their order (prototypeStartingPoint.position), top-level frames only.
std::vector<Flow> flows(const Document& doc, Guid page);

// The interactions' JSON (the schema's shape: enums by name, GUIDs as {sessionID, localID}) for writes, and the
// whole field as the change NodeProps::extra entry it becomes ("" removes the field).
json::Value toJson(const Interaction& i);
std::string encodeInteractions(const std::vector<Interaction>& list);
// One extra entry from any JSON value of a NodeChange field (empty: the schema doesn't know it / it doesn't fit).
std::string encodeField(const char* key, const json::Value& v);

// A fresh interaction as Figma makes one for a new connection: On click → Navigate to `dest`, Instant (the
// animation Figma gives a new connection; ease out, 300 ms when one is chosen).
Interaction newConnection(Guid id, Guid dest);

// Easing: progress t ∈ [0, 1] → eased value (springs and back easings overshoot 1).
double ease(const Action& a, double t);
// How long an action's animation runs (springs: until they settle), seconds.
double durationOf(const Action& a);

// Every destination of an action and its conditional branches (navigate / overlay / swap / change to / scroll to).
void destinations(const Action& a, std::vector<std::pair<Navigation, Guid>>& out);

}  // namespace eng::proto
