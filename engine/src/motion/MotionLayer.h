// The motion layer (docs/motion.md §5): the evaluated values of a timeline root's animated layers at a time, written over
// their base values as preview writes — into the live nodes, never through a transaction, never journaled, never in
// DOCUMENT_CHANGED — and put back by `restore()` before any transaction begins, before the document is read for storage
// or export, and when Motion mode ends. The document therefore always holds base values when anything else looks.
//
// As built (round 8a): a MOTION_* field composes into the node's `transform` as a preview write (the contract's
// `motionWorld`: render, hit-testing and bounds all read the transform; the base is in the restore list), so the layout
// transform is untouched the moment the layer restores. Layout-changing fields (WIDTH, paddings…) are written; the
// re-layout of the children (§4.5) is the next increment.
#pragma once

#include <cstdint>
#include <functional>
#include <unordered_map>
#include <vector>

#include "motion/Evaluate.h"
#include "motion/Model.h"

namespace eng::motion {

// Motion's view state (not in the document; per editor), engine.setMotion (docs/motion.md §4.9).
struct State {
  bool on = false;
  Guid root = kNoGuid;  // kNoGuid: the root of the selection
  int64_t timeUs = 0;
  bool autoKeyframe = false;
  bool showMotionPath = true;
};

class MotionLayer {
 public:
  // Resolves a binding's base argument (a literal, or an alias in the node's modes) to a value; false: unresolved.
  using BaseResolver = std::function<bool(Guid node, const VariableData& base, KeyframeValue& out)>;

  // Evaluates every animated layer under `root` at root time `timeUs` (the timeline's playback style applied) and
  // writes the values. Nodes already applied are re-evaluated from their remembered base. Returns the nodes written.
  size_t apply(Document& doc, const MotionIndex& index, Guid root, int64_t timeUs, const BaseResolver& resolve);
  // Puts every remembered base value back (bit-identical) and forgets it.
  void restore(Document& doc);
  bool active() const { return !entries_.empty(); }
  size_t appliedCount() const { return entries_.size(); }
  // The base props of an applied node (what the document held before the layer wrote it), or nullptr.
  const NodeProps* baseOf(Guid id) const;

  // The motion transform of a layer: M · T(o) · T(t) · R(−r) · Shear(k) · S(s) · T(−o) (docs/motion.md §4.5), with the
  // anchor o resolved against `size`. `rotationStored` is Figma's stored value (−radians).
  static Mat2x3 motionTransform(const Mat2x3& layout, Vec2 size, const LayerBase& anchor, Vec2 translation, double rotationStored,
                                Vec2 scale, double shear);
  static Vec2 anchorPoint(const LayerBase& b, Vec2 size);

 private:
  struct Entry {
    NodeProps base;  // the node as it was before the first preview write
    FieldMask mask = 0;
  };
  Entry& remember(const Document& doc, Guid id);
  std::unordered_map<Guid, Entry, GuidHash> entries_;
};

// Puts the base values back for the scope and applies again after it (nestable): storage, exports, clipboard reads.
class Suspend {
 public:
  Suspend(MotionLayer& layer, Document& doc, std::function<void()> reapply) : layer_(layer), doc_(doc), reapply_(std::move(reapply)) {
    was_ = layer_.active();
    if (was_) layer_.restore(doc_);
  }
  ~Suspend() {
    if (was_ && reapply_) reapply_();
  }
  Suspend(const Suspend&) = delete;
  Suspend& operator=(const Suspend&) = delete;

 private:
  MotionLayer& layer_;
  Document& doc_;
  std::function<void()> reapply_;
  bool was_ = false;
};

}  // namespace eng::motion
