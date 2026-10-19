// The Motion model the engine evaluates (docs/motion.md §4.2–§4.4), decoded from the document: the KEYFRAME_TRACK nodes
// and their KEYFRAME children, the KEYFRAME expressions that bind a layer's fields (and its paints' and effects'
// slots) to tracks, the timeline roots, and each animated layer's motion-transform base and anchor. The document keeps
// these as Figma's fields (NodeProps::extra and the binding maps); `MotionIndex` reads them once per change and the
// evaluator (Evaluate.h) and the motion layer (MotionLayer.h) work on the decoded structs.
#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "base/Json.h"
#include "motion/Easing.h"
#include "motion/Fields.h"
#include "motion/TextStagger.h"
#include "scene/Document.h"

namespace eng::motion {

// A keyframe's value (schema KeyframeAnyValue), in Figma's stored units (Fields.h converts).
struct KeyframeValue {
  ValueKind kind = ValueKind::FLOAT;
  double f = 0;
  Vec2 v;
  Color c;
  bool b = false;
  std::string text;
  static KeyframeValue number(double x) {
    KeyframeValue k;
    k.f = x;
    return k;
  }
  static KeyframeValue vector(Vec2 x) {
    KeyframeValue k;
    k.kind = ValueKind::VECTOR;
    k.v = x;
    return k;
  }
  static KeyframeValue color(Color x) {
    KeyframeValue k;
    k.kind = ValueKind::COLOR;
    k.c = x;
    return k;
  }
};

// schema EasingType (the same numbers as proto::Easing; Prototype.h isn't included here).
enum class EasingType : uint8_t {
  IN_CUBIC = 0, OUT_CUBIC = 1, INOUT_CUBIC = 2, LINEAR = 3, IN_BACK_CUBIC = 4, OUT_BACK_CUBIC = 5, INOUT_BACK_CUBIC = 6,
  CUSTOM_CUBIC = 7, SPRING = 8, GENTLE_SPRING = 9, CUSTOM_SPRING = 10, SPRING_PRESET_ONE = 11, SPRING_PRESET_TWO = 12,
  SPRING_PRESET_THREE = 13, HOLD = 14, EASE_IN = 15
};

// A keyframe's or clip's easing (schema EasingData). On a keyframe, IN_CUBIC (the kiwi default) or an absent easing
// means "no easing" and plays as CUSTOM_CUBIC (0.5, 0, 0.5, 1) (docs/motion.md §4.7).
struct EasingSpec {
  bool present = false;
  EasingType type = EasingType::IN_CUBIC;
  Bezier bezier{0.5, 0, 0.5, 1};  // CUSTOM_CUBIC
  Spring spring = kGentle;        // CUSTOM_SPRING (stored physical)
  bool springValid = true;
};

enum class ColorSpace : uint8_t { DEFAULT = 0, OKLAB = 1, OKLCH = 2, HSL = 3, SRGB_LINEAR = 4 };
enum class HueMethod : uint8_t { SHORTER = 0, LONGER = 1, INCREASING = 2, DECREASING = 3 };
enum class Operation : uint8_t { SET = 0, SCALE = 1, OFFSET = 2 };
enum class Playback : uint8_t { ONCE = 0, LOOP = 1, BOOMERANG = 2 };

struct Keyframe {
  Guid id = kNoGuid;
  int64_t timeUs = 0;
  KeyframeValue value;
  EasingSpec easing;  // into this keyframe
  ColorSpace colorSpace = ColorSpace::DEFAULT;
  HueMethod hueMethod = HueMethod::SHORTER;
  bool hasPathHandles = false;
  Vec2 pathIn, pathOut;  // motionPathBezierHandles: (p1x, p1y) in, (p2x, p2y) out, relative to the value
  // Its easing bound to an EASING variable (the KEYFRAME's own `parameterConsumptionMap` EASING_DATA alias, docs/
  // motion.md §4.7; round 8i): `easing` then holds the variable's value in the animated layer's modes once the index is
  // resolved (MotionIndex::rebuild's Resolver), the stored easingData until then.
  VariableData easingVar;
};

struct Track {
  Guid id = kNoGuid;
  Operation operation = Operation::SET;
  bool loop = false;  // trackLoopMode LOOP
  std::vector<Keyframe> keyframes;  // sorted by timeUs; unique positions
};

// One parameter of a KEYFRAME expression (schema KeyframeTrackParameter).
struct Param {
  enum class Kind : uint8_t { MANUAL, ANIMATION_PRESET, STYLE } kind = Kind::MANUAL;
  Guid track = kNoGuid;
  Guid preset = kNoGuid;        // ANIMATION_PRESET: the ANIMATION_PRESET_INSTANCE
  Guid timelineDef = kNoGuid;   // the timeline (a root's GUID: its default timeline)
  Guid styleBinding = kNoGuid;  // STYLE: animationStyleBindingId
  // ANIMATION_PRESET: its clip's place in time and off switch (filled by MotionIndex::rebuild from the instance): the
  // preset's tracks are in the clip's own time, from 0 (docs/motion.md §4.6).
  int64_t offsetUs = 0;
  bool disabled = false;
  bool staggered = false;  // its clip plays it per text element (TextStagger.h)
};

// Where a binding sits on the node (docs/motion.md §4.2): a node field, a paint's colour / opacity, an effect's field.
struct Slot {
  enum class Kind : uint8_t { NODE, FILL_COLOR, FILL_OPACITY, STROKE_COLOR, STROKE_OPACITY, EFFECT } kind = Kind::NODE;
  VariableField field = VariableField::MISSING;  // NODE: the field; EFFECT: which effect field (below)
  uint32_t index = 0;                            // the paint's / effect's index
  enum class EffectField : uint8_t { RADIUS, COLOR, SPREAD, OFFSET_X, OFFSET_Y } effect = EffectField::RADIUS;
  bool operator==(const Slot& o) const { return kind == o.kind && field == o.field && index == o.index && effect == o.effect; }
};

// A KEYFRAME expression on one slot: the base value (its first argument) and the tracks folded over it.
struct Binding {
  Slot slot;
  VariableData base;  // argument 0: a literal or an alias (resolved in the node's modes by the caller)
  std::vector<Param> params;
};

struct Timeline {
  Guid root = kNoGuid;
  int64_t durationUs = 2000000;  // help: "New animations default to 2000 milliseconds"
  Playback playback = Playback::LOOP;  // [unverified]
  uint32_t fpsNumerator = 60, fpsDenominator = 1;
  bool disabled = false;
  int64_t offsetUs = 0;
};

// An animated layer's motion-transform base (motionTransform; absent = identity) and anchor (transformOrigin; absent =
// 50 % / 50 %), docs/motion.md §4.5.
struct LayerBase {
  Vec2 translation{0, 0};
  double rotation = 0;  // stored −radians
  Vec2 scale{1, 1};
  double shear = 0;
  Number originX{50, NumberUnits::PERCENT}, originY{50, NumberUnits::PERCENT};
  bool linkScale = false;
};

// An animation preset's clip (an ANIMATION_PRESET_INSTANCE, docs/motion.md §4.6; round 8h): the preset type
// (`backingAnimationPresetId`'s assetRef key, e.g. "opacity"), its place in time (`timelineOffset`, µs — the Delay),
// its length (`timelineDuration`), its easing and off switch. Its tracks are its KEYFRAME_TRACK children, in the
// clip's own time; the engine knows no preset's code (the TypeScript runtime materialises them, round 8h).
struct Preset {
  Guid id = kNoGuid;
  std::string key;
  std::string name;
  int64_t offsetUs = 0;
  int64_t durationUs = 500000;  // Figma's presets: Duration 0.5 s
  bool disabled = false;
  EasingSpec easing;
  Stagger stagger;  // its own textElementDelayBehaviour (a text preset's, TextStagger.h)
  // Delay, Duration and Easing bound to TIMING / EASING variables (round 8i): its `componentPropAssignments`' varValue
  // on those props' defIDs (presetPropId). Resolved, the clip plays at the variables' values — its tracks stretched
  // from `storedDurationUs`, their keyframes eased by the variable — in the index's decoded copy only.
  VariableData delayVar, durationVar, easingVar;
  int64_t storedDurationUs = 500000;
};

// A preset prop's defID on its clip (src/renderer/src/editor/motion/presets.ts `propId`): sessionID 0, the FNV-1a 32
// hash of the prop's key ("delay", "duration", "easing").
Guid presetPropId(const char* key);

struct AnimatedNode {
  Guid id = kNoGuid;
  std::vector<Binding> bindings;
  LayerBase base;
  std::vector<Guid> presets;  // animationPresets, in stacking order (a preset with no tracks yet animates nothing)
  // A TEXT layer's own textElementDelayBehaviour (MOTION_SET_TEXT_STAGGER, round 8i): its manual tracks play per
  // element (§4.10); a text preset's clips keep their own.
  Stagger stagger;
};

// What the index asks of the editor to resolve variable bindings (round 8i): an EASING variable's value, a TIMING
// variable's (ms), for a consumer — the animated layer, whose modes decide (Figma: "switching a page's mode updates
// every animation that references them").
struct Resolver {
  std::function<bool(const VariableData& alias, Guid consumer, EasingSpec& out)> easing;
  std::function<bool(const VariableData& alias, Guid consumer, double& ms)> timing;
};

// An animated instance's place in its container's time (docs/motion.md §4.3): its `timelineAssignments` entry for
// (its main's timeline, the container's timeline); absent = offset 0, playing.
struct Assignment {
  int64_t offsetUs = 0;
  bool disabled = false;
  bool found = false;  // the entry is in the instance's map
};

// An audio clip on a timeline root (schema AudioFill, `audioFills 603`; docs/motion.md §4.11; round 8e): a region of a
// stored audio file (`mediaHash`, the file's image store as videos) from `startUs` into it for `durationUs`, placed at
// `offsetUs` in the root's time, on the row `track` (`audioTracks 605`). The engine stores and edits them; the renderer
// plays and mixes them (Web Audio), so nothing here is evaluated.
struct AudioClip {
  Guid id = kNoGuid;
  std::string mediaHash;
  int64_t offsetUs = 0;
  int64_t startUs = 0;
  int64_t durationUs = 0;
  double volume = 1;
  bool mute = false;
  std::string name;
  bool loop = false;
  int64_t playbackDurationUs = 0;
  Guid track = kNoGuid;
  int64_t loopPhaseUs = 0;
  // The clip as stored: the fields not modelled here (Figma's current build: sourceDurationUs, the beat grid 14–18,
  // volumeVar / timelineOffsetVar) are written back as they came.
  json::Value kept;
};

struct AudioRow {
  Guid id = kNoGuid;
  std::string name;
  double gain = 1;
  bool mute = false;
};

// The decoded model of a document, rebuilt when the document changes (MotionLayer asks).
class MotionIndex {
 public:
  // `resolve` (nullptr: variable bindings play their stored values) resolves easing and timing variables once per
  // rebuild — every commit rebuilds, so a mode switched or a variable edited plays at once.
  void rebuild(const Document& doc, const Resolver* resolve = nullptr);
  void clear();

  const Track* track(Guid id) const;
  const AnimatedNode* node(Guid id) const;
  const Preset* preset(Guid id) const;
  bool animated(Guid id) const { return nodes_.count(id) != 0; }
  // The timeline root above `id` (a page's direct child, a section's direct child frame, or a SYMBOL), kNoGuid when
  // none; `id` itself when it is one.
  Guid rootOf(const Document& doc, Guid id) const;
  // The root's timeline (its own fields, or the defaults); `root` must be a root.
  Timeline timeline(const Document& doc, Guid root) const;
  // The animated nodes under `root` (real nodes; the motion layer walks instance sublayers itself), in document order.
  std::vector<Guid> animatedUnder(const Document& doc, Guid root) const;
  // Whether a timeline root plays anything: animated layers of its own, or an instance of a main that plays (an
  // animated component's instances play its timeline, docs/motion.md §4.3). Real nodes; rebuilt with the index.
  bool plays(Guid root) const { return playing_.count(root) != 0; }
  size_t trackCount() const { return tracks_.size(); }
  size_t nodeCount() const { return nodes_.size(); }
  // Nothing decoded: no track, clip, animated layer or playing root (Batch D: a commit that brings no motion data into
  // such a document leaves it so, and skips the whole-document rebuild).
  bool empty() const { return tracks_.empty() && nodes_.empty() && presets_.empty() && playing_.empty(); }
  // Whether a node's own fields put anything in the index (a track, a keyframe, a clip, a KEYFRAME expression on a
  // field, paint or effect, a clip list) — the per-node test of rebuild's steps 1–2.
  static bool mayAnimate(const NodeProps& p);

 private:
  std::unordered_map<Guid, Track, GuidHash> tracks_;
  std::unordered_map<Guid, AnimatedNode, GuidHash> nodes_;
  std::unordered_map<Guid, Preset, GuidHash> presets_;
  std::unordered_set<Guid, GuidHash> playing_;
};

// Decoding helpers (also used by the tests and, in round 8b, by the commands).
bool decodeKeyframe(const NodeProps& p, Guid id, Keyframe& out);
bool decodeTrack(const NodeProps& p, Guid id, Track& out);  // without its keyframes
bool decodePreset(const NodeProps& p, Guid id, Preset& out);
// A textElementDelayBehaviour (610) as JSON (a TEXT layer's or a text preset's own; round 8i).
Stagger decodeStagger(const json::Value& behaviour);
// A layer's `animationPresets` (521): the instances in stacking order.
std::vector<Guid> decodePresetList(const NodeProps& p);
bool decodeEasing(const json::Value& easingData, EasingSpec& out);
bool decodeKeyframeValue(const json::Value& keyframeValue, KeyframeValue& out);
// A KEYFRAME expression's second argument (KEYFRAME_TRACK_PARAMETER_DATA): its parameters. False when `arg` isn't one.
bool decodeParams(const VariableData& arg, std::vector<Param>& out);
LayerBase decodeLayerBase(const NodeProps& p);
// An instance's `timelineAssignments` entry for its main's timeline `assigned` placed in `containing`'s.
Assignment decodeAssignment(const NodeProps& instance, Guid assigned, Guid containing);
bool isTimelineRoot(const Document& doc, Guid id);
// A root's audio clips and rows (round 8e), in their stored order.
std::vector<AudioClip> decodeAudioClips(const NodeProps& root);
std::vector<AudioRow> decodeAudioRows(const NodeProps& root);
// One of the node's `extra` fields as JSON (null when absent or unreadable).
json::Value extraJson(const NodeProps& p, const char* key);

}  // namespace eng::motion
