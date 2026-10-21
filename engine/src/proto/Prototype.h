// Prototyping data (docs/schema.md §12, Figma's kiwi fields): the interactions on a layer, a frame's overflow and
// overlay settings, a child's scroll behaviour, the page's flows and prototype device. The engine doesn't model these
// in NodeProps — they stay as kiwi bytes in NodeProps::extra, so they round-trip with .fig files untouched — and
// this module reads them on demand (through the schema's JSON view of those bytes) and writes them back.
//
// Enum values are the schema's (schema/document.kiwi "Prototyping").
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "base/Json.h"
#include "scene/Document.h"

namespace eng::proto {

enum class Trigger : uint8_t {
  ON_CLICK = 0, AFTER_TIMEOUT = 1, MOUSE_IN = 2, MOUSE_OUT = 3, ON_HOVER = 4, MOUSE_DOWN = 5, MOUSE_UP = 6,
  ON_PRESS = 7, NONE = 8, DRAG = 9, ON_KEY_DOWN = 10, ON_MEDIA_HIT = 12, ON_MEDIA_END = 13, MOUSE_ENTER = 14, MOUSE_LEAVE = 15
};
enum class Connection : uint8_t {
  NONE = 0, INTERNAL_NODE = 1, URL = 2, BACK = 3, CLOSE = 4, SET_VARIABLE = 5, UPDATE_MEDIA_RUNTIME = 6, CONDITIONAL = 7, SET_VARIABLE_MODE = 8,
  UPDATE_ANIMATION_TIMELINE_STATE = 10
};
// UPDATE_ANIMATION_TIMELINE_STATE's action on a Motion timeline (docs/motion.md §4.12).
enum class TimelineAction : uint8_t { PLAY = 0, PAUSE = 1, TOGGLE_PLAY_PAUSE = 2, SET_PLAYHEAD = 3 };
// UPDATE_MEDIA_RUNTIME's action (help.figma.com 360040035874: Play/pause video, Mute/unmute video, Set to specific time,
// Jump forward/backward in time).
enum class MediaAction : uint8_t {
  PLAY = 0, PAUSE = 1, TOGGLE_PLAY_PAUSE = 2, MUTE = 3, UNMUTE = 4, TOGGLE_MUTE_UNMUTE = 5, SKIP_FORWARD = 6, SKIP_BACKWARD = 7, SKIP_TO = 8
};
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
// Wecra's overlay "Fit to window" (NodeChange.overlayFitWindow, @ours): the sides of an overlay that take the
// screen's size while it is presented (docs/engine.md §3.4).
enum class OverlayFit : uint8_t { NONE = 0, WIDTH = 1, HEIGHT = 2, BOTH = 3 };
// Wecra's "Keep in window" for a Manual overlay (NodeChange.overlayEdgeBehavior, @ours): AUTO follows its hotspot on
// scroll, flips to its other side and shifts inside the window (Floating UI's autoUpdate / flip / shift); NONE is
// Figma's (placed once at open); FOLLOW_ONLY follows without flipping or shifting (docs/engine.md §3.4).
enum class OverlayEdge : uint8_t { AUTO = 0, NONE = 1, FOLLOW_ONLY = 2 };

const char* triggerName(Trigger t);
const char* connectionName(Connection c);
const char* navigationName(Navigation n);
const char* transitionName(Transition t);
const char* easingName(Easing e);
const char* mediaActionName(MediaAction m);

struct Action;
struct Branch {
  bool hasCondition = false;
  json::Value condition;  // a VariableData (BOOLEAN literal, alias or EXPRESSION), as the schema's JSON
  std::vector<Action> actions;
};

struct Action {
  // The interaction's stateManagementVersion (not stored on the action; copied when read): 1 carries interacted
  // components' states and scroll positions across screens (Figma's v1), 0 is the legacy behaviour.
  int stateVersion = 1;
  Connection connection = Connection::NONE;
  Navigation navigation = Navigation::NAVIGATE;
  Guid dest = kNoGuid;
  Transition transition = Transition::INSTANT;
  double duration = 0.3;  // seconds
  json::Value durationVar;  // transitionDurationVar: the duration bound to a number variable (the player resolves it)
  Easing easing = Easing::OUT_CUBIC;
  std::vector<double> easingFunction;  // CUSTOM_CUBIC: x1 y1 x2 y2; CUSTOM_SPRING: mass stiffness damping
  bool smartAnimate = false;           // "Animate matching layers" (MAGIC_MOVE / SMART_ANIMATE imply it)
  bool preserveScroll = false;
  bool resetScroll = false;
  bool resetComponents = false;
  bool resetVideo = false;  // "Reset video state" (transitionResetVideoPosition)
  MediaAction media = MediaAction::PLAY;  // UPDATE_MEDIA_RUNTIME (on the video `dest`)
  double mediaSkipTo = 0;   // SKIP_TO, seconds
  double mediaSkipBy = 0;   // SKIP_FORWARD / SKIP_BACKWARD, seconds
  TimelineAction timeline = TimelineAction::PLAY;  // UPDATE_ANIMATION_TIMELINE_STATE (animationTimelineAction)
  double timelineSkipTo = 0;                       // SET_PLAYHEAD, seconds (animationSkipToTime)
  Guid timelineDef = kNoGuid;                      // the timeline's root (animationTimelineDefId)
  std::string url;
  bool newTab = true;  // Open link: a new tab unless the file says otherwise (Figma's `openUrlInNewTab === undefined`)
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
  double timeout = 0.8;  // AFTER_TIMEOUT, seconds (the event's transitionTimeout; missing or 0 reads 0.8, as Figma's)
  // Mouse enter / leave / down / up: how long the pointer must stay in (out, down, up) before the actions run, seconds
  // (the event's interactionMaintained + interactionDuration, Figma's placement; 0 = at once).
  double delay = 0;
  int stateManagementVersion = 0;  // Figma writes 1 on new interactions
  json::Value timeoutVar;  // transitionTimeoutVar: the delay bound to a number variable (the player resolves it)
  std::vector<int> keyCodes;  // ON_KEY_DOWN
  double mediaHitTime = 0;    // ON_MEDIA_HIT: the video's time, seconds
  std::vector<Action> actions;
};

struct OverlaySettings {
  OverlayPosition position = OverlayPosition::CENTER;
  bool closeOnClickOutside = false;
  bool background = false;
  Color backgroundColor{0, 0, 0, 0.25f};
  OverlayFit fit = OverlayFit::NONE;  // @ours: Fit to window
  OverlayEdge edge = OverlayEdge::AUTO;  // @ours: Keep in window (absent: AUTO while Website behaviours is on)
  bool edgeSet = false;                  // the field is present
  // @ours: Stack (overlayStack, absent: none) — overlays at one preset position stack like toasts, `stackGap` apart,
  // at most `stackMax` (0: no limit).
  bool stack = false;
  double stackGap = 0;
  int stackMax = 0;
  bool fitsWidth() const { return fit == OverlayFit::WIDTH || fit == OverlayFit::BOTH; }
  bool fitsHeight() const { return fit == OverlayFit::HEIGHT || fit == OverlayFit::BOTH; }
};

struct Device {
  enum class Type : uint8_t { NONE, PRESET, CUSTOM, PRESENTATION } type = Type::NONE;
  bool none = true;  // PrototypeDeviceType NONE (or absent, or PRESENTATION): frames shown at their own size
  Vec2 size;          // PRESET / CUSTOM: the screen
  std::string preset;
  bool rotated = false;  // CCW_90: landscape
};

// Prototype › Video (NodeChange.videoPlayback): what a video does when its frame is shown. Absent: the schema's
// defaults (all off — Figma writes the message when a video is placed).
struct VideoSettings {
  bool autoplay = false;
  bool loop = false;
  bool muted = false;
};

struct Flow {
  Guid node = kNoGuid;
  std::string name, description, position;
};

// Reads. Absent fields read as their schema defaults; unreadable bytes as absent.
std::vector<Interaction> interactions(const NodeProps& p);
// The same list, shared: read once per distinct value of the field (no copy).
std::shared_ptr<const std::vector<Interaction>> sharedInteractions(const NodeProps& p);
bool hasInteractions(const NodeProps& p);
// An instance's interactions as they play (Figma's model, as its files show it: an instance stores copies of its main's
// interactions under their ids, plus those added on the instance). An entry with the id of one of its main's stands for
// that one — the main's as it is now, unless the instance changed it (an override: equal to no variant's entry of that
// id); an entry with the id of another variant's of its set is a copy left from before a variant switch and goes; any
// other is the instance's own, after the main's. `main`: its main's props (null: unknown — its own list as it is);
// `variants`: every variant of the main's set (the main among them), or just the main. `ownIndex` (optional): for each
// entry, its index in the instance's own interactions(), −1 for one inherited from the main.
std::vector<Interaction> instanceInteractions(const NodeProps& own, const NodeProps* main, const std::vector<const NodeProps*>& variants,
                                              std::vector<int>* ownIndex = nullptr);
// Which of an instance's own interactions() it plays as its own (changed or added on it, not copies of its main's or
// left from another variant): instanceInteractions' ownIndex, without building the played list.
std::vector<bool> instanceOwnEntries(const NodeProps& own, const NodeProps* main, const std::vector<const NodeProps*>& variants);
// A layer's prototypeInteractions inside an instance, an override entry's list over what it inherits (both the
// field's kiwi bytes), as it plays: every inherited entry in its order — one the override changed (same id) in its
// place, one it marked isDeleted left out — then the override's own entries. Inherited entries with the override's
// triggers stay too (Wecra's web rule, docs/engine.md §3.4: the component's state change and the instance's action
// both run, the component's first; Figma keeps only the instance's for that trigger). Runtime / derived only: the
// stored override is untouched. Either side empty: the other.
std::string mergeInteractionOverride(const std::string& inherited, const std::string& over);
// An edit of a layer inside an instance (its list was `before`, it becomes `after`): the inherited / earlier entries
// the edit removed stay in the override as isDeleted copies, so the per-trigger merge doesn't bring them back.
std::string keepDeletions(const std::string& before, const std::string& after);
Overflow overflow(const NodeProps& p);
ScrollBehavior scrollBehavior(const NodeProps& p);
OverlaySettings overlaySettings(const NodeProps& p);
bool flowStart(const NodeProps& p, Flow& out);  // the node's prototypeStartingPoint
Device device(const NodeProps& page);
Color background(const NodeProps& page);  // prototypeBackgroundColor (absent or transparent: black, as Figma)
VideoSettings videoSettings(const NodeProps& p);
// The layer's first visible VIDEO fill (its index in fillPaints), −1 when it has none.
int videoFill(const NodeProps& p);
// The layer's first visible GIF fill (an IMAGE paint with an animatedImage: "GIFs in prototypes" play, atlas 07 §8.5),
// −1 when it has none.
int gifFill(const NodeProps& p);
// The page's flows in their order (prototypeStartingPoint.position), on its screens.
std::vector<Flow> flows(const Document& doc, Guid page);
// The page's screens in document order: its top-level layers and those inside its sections (nested sections too) —
// Figma treats a frame in a section as a top-level frame (live 2026-10-20: the owner's flows start at such frames).
std::vector<Guid> screens(const Document& doc, Guid page);
// The screen a layer is on: its outermost ancestor (or itself) that is not a section, under the page and sections
// only; kNoGuid for a section or a layer off the page.
Guid screenOf(const Document& doc, Guid id);
// Where Play starts for a selected section (or a layer only sections hold): the first flow (in flow order) starting
// on a screen inside it, else its first screen in document order — one frame, never the section (the owner's
// "Prototype deneme": the section "Desktop" starts at "1"). kNoGuid when it holds no screen.
Guid sectionStart(const Document& doc, Guid page, Guid section);

// The interactions' JSON (the schema's shape: enums by name, GUIDs as {sessionID, localID}) for writes, and the
// whole field as the change NodeProps::extra entry it becomes ("" removes the field).
json::Value toJson(const Interaction& i);
std::string encodeInteractions(const std::vector<Interaction>& list);
// One extra entry from any JSON value of a NodeChange field (empty: the schema doesn't know it / it doesn't fit).
std::string encodeField(const char* key, const json::Value& v);

// A fresh interaction as Figma makes one for a new connection: On click → Navigate to `dest`, Instant (the
// animation Figma gives a new connection; ease out, 300 ms when one is chosen).
Interaction newConnection(Guid id, Guid dest);

// The triggers that take a delay (interactionMaintained / interactionDuration): mouse enter, leave, down, up and the
// legacy mouse in / out.
bool hasDelay(Trigger t);

// Easing (motion/Easing.h: Figma's curves and springs): progress t ∈ [0, 1] → eased value (springs and back easings
// overshoot 1).
double ease(const Action& a, double t);
// How long an action's animation runs, seconds (springs: Figma's settle time T, motion::springSettleTime).
double durationOf(const Action& a);

// Figma's transition geometry (its viewer's transition class, atlas 13 §5.3): where the entering screen (the
// destination) and the exiting one (the source) go, in units of the screen's size (LEFT = (−1, 0) … BOTTOM = (0, 1)),
// their opacity, and which is drawn on top — linear in the eased progress. A _FROM_ type names the side the new screen
// comes from; the _OUT_TO_ types are the reversed _FROM_ ones of the other side (MOVE_OUT_TO_RIGHT is MOVE_FROM_LEFT
// reversed: the old screen leaves to the left). Slide in moves the other screen a quarter and fades it to 0.5.
struct Geometry {
  Vec2 inFrom, inTo, outFrom, outTo;
  double inAlphaFrom = 1, inAlphaTo = 1, outAlphaFrom = 1, outAlphaTo = 1;
  bool enteringOnTop = true;
  bool moves = false;  // Move / Push / Slide (Instant, Dissolve, Smart animate: false)
};
Geometry geometryOf(Transition t);

// Every destination of an action and its conditional branches (navigate / overlay / swap / change to / scroll to).
void destinations(const Action& a, std::vector<std::pair<Navigation, Guid>>& out);
// The videos the action and its branches act on (UPDATE_MEDIA_RUNTIME's `dest`).
void mediaTargets(const Action& a, std::vector<Guid>& out);

}  // namespace eng::proto
