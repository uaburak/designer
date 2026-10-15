// Figma Draw's transform groups (docs/draw.md §4.2): a TRANSFORM node is a group whose `transformModifiers` repeat
// its children. What they make is derived, never stored: a list of instances — matrices in the group's space, each
// drawing the children's subtree once more, in paint order — rebuilt from the modifiers and the children's box.
//
//   - LINEAR: copy k at translate(k · step); step = (B.w + gap, 0) on X, (0, B.h + gap) on Y, (B.w + gapX, B.h + gapY)
//     on X_AND_Y; the gap is `offset` px (PIXELS) or `offset` × B.w / B.h (RELATIVE).
//   - RADIAL: copy k turned k · 360° / count clockwise about P = (B.centerX, B.bottom + r), r = offset.x px or
//     offset.x × B.h (RELATIVE).
//   - Each visible REPEAT multiplies the instance list; B becomes the union of the copies. SYMMETRY / SKEW pass
//     through. Order FORWARD draws copy 0 (the source) lowest; REVERSE the other way round.
//   - At most kMaxRepeatInstances instances (the first ones); `count` is clamped to 1…kMaxRepeatCount.
#pragma once

#include <cstdint>
#include <vector>

#include "math/Math.h"
#include "scene/Node.h"

namespace eng {

class Document;

namespace geom {

inline constexpr uint32_t kMaxRepeatCount = 1000;        // what a file's count is read up to (lenient) [ours]
// What authoring writes: Figma's plugin takes an integer 2…40 (live, docs/research/rea/vector.md §6) —
// REPEAT_COUNT_RANGE (src/shared/draw/types.ts).
inline constexpr uint32_t kRepeatCountMin = 2;
inline constexpr uint32_t kRepeatCountMax = 40;
inline constexpr size_t kMaxRepeatInstances = 10000;     // MAX_REPEAT_INSTANCES

// schema TransformModifier (enums by value: TransformModifierType, RepeatType, EffectAxis, UnitType, RepeatOrder).
struct TransformModifier {
  enum class Type : uint8_t { REPEAT = 0, SYMMETRY = 1, SKEW = 2 } type = Type::REPEAT;
  enum class Repeat : uint8_t { LINEAR = 0, RADIAL = 1 } repeatType = Repeat::LINEAR;
  enum class Axis : uint8_t { X = 0, Y = 1, X_AND_Y = 2 } axis = Axis::X;
  enum class Unit : uint8_t { PIXELS = 0, RELATIVE = 1 } unitType = Unit::PIXELS;
  enum class Order : uint8_t { FORWARD = 0, REVERSE = 1 } order = Order::FORWARD;
  Vec2 offset;
  bool visible = true;
  uint32_t count = 1;
  double skewX = 0, skewY = 0;
};

struct RepeatResult {
  std::vector<Mat2x3> instances;  // group space, paint order (bottom first); copy 0 is the identity
  Rect bounds;                    // the union of every copy of the content box
  bool capped = false;            // more than kMaxRepeatInstances were asked for (the first ones are kept)
};

// The instances of `content` (the children's box, group space) under `modifiers`.
RepeatResult evaluateRepeat(const std::vector<TransformModifier>& modifiers, const Rect& content,
                            size_t cap = kMaxRepeatInstances);

}  // namespace geom

// A node's transformModifiers (NodeProps::extra, decoded once per distinct bytes); empty when it has none.
const std::vector<geom::TransformModifier>& transformModifiersOf(const NodeProps& p);
// The children's box of a TRANSFORM (the union of its visible children's layout boxes, group space); false without one.
bool repeatContent(const Document& doc, Guid id, Rect& out);
// The TRANSFORM node's instances (nullptr when `id` isn't a TRANSFORM or has nothing to repeat): one entry — the
// identity — when it has no visible modifier. Cached per node, rebuilt when its modifiers or its children's boxes change.
const geom::RepeatResult* repeatOf(const Document& doc, Guid id);
// Whether `id` lies inside a TRANSFORM (its content is drawn more than once): the innermost such ancestor, else kNoGuid.
Guid repeatAncestor(const Document& doc, Guid id);

}  // namespace eng
