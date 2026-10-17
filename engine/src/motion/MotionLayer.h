// The motion layer (docs/motion.md §5): the evaluated values of a timeline root's animated layers at a time, written over
// their base values as preview writes — into the live nodes, never through a transaction, never journaled, never in
// DOCUMENT_CHANGED — and put back by `restore()` before any transaction begins, before the document is read for storage
// or export, and when Motion mode ends. The document therefore always holds base values when anything else looks.
//
// As built (round 8a): a MOTION_* field composes into the node's `transform` as a preview write (the contract's
// `motionWorld`: render, hit-testing and bounds all read the transform; the base is in the restore list), so the layout
// transform is untouched the moment the layer restores. Increment 2: an animated component's instances play their
// main's timeline placed in their container's (instance sublayers, `timelineAssignments`, §4.3), and layout-changing
// fields (WIDTH, paddings, gaps…) lay out again through the caller's hook, its writes previews too (§4.5) — the motion
// transforms then compose over where layout put each layer.
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

  // What the layer asks of the editor: the bases (above), an instance's main and a sublayer's layer in it (instance
  // sublayers play their main's tracks), and the layout of what layout-changing fields touched.
  struct Hooks {
    BaseResolver resolve;
    // An INSTANCE's main component, real or derived (nullptr: its own symbolData's).
    std::function<Guid(Guid)> mainOf;
    // A derived row's layer in its main (nullptr, or kNoGuid: the row plays nothing).
    std::function<Guid(Guid)> sourceOf;
    // Lays out what depends on these nodes (their layout inputs changed), writing through preview() (nullptr: no
    // layout, siblings stay where they were).
    std::function<void(const std::vector<Guid>&)> relayout;
  };

  // Evaluates every animated layer under `root` at root time `timeUs` (the timeline's playback style applied) — the
  // root's own layers, and the sublayers of the instances whose main plays, each in its main's time (§4.3) — and writes
  // the values, starting from the base values (what an earlier apply wrote is restored first). Returns the nodes written.
  size_t apply(Document& doc, const MotionIndex& index, Guid root, int64_t timeUs, const Hooks& hooks);
  size_t apply(Document& doc, const MotionIndex& index, Guid root, int64_t timeUs, const BaseResolver& resolve) {
    Hooks hooks;
    hooks.resolve = resolve;
    return apply(doc, index, root, timeUs, hooks);
  }
  // Where an instance's main's time is at its container's time `tau` (µs): its assignment's offset, then the main's
  // playback style over the main's duration; false when its timeline is disabled.
  static bool instanceTime(const Document& doc, const MotionIndex& index, Guid instance, Guid main, Guid containing, int64_t tau,
                           int64_t& out);
  // A gesture's preview (round 8b, increment 2): `c`'s fields written over the node as the layer's own values are, its
  // base remembered once; the next restore (or apply, which restores first) takes them back.
  bool preview(Document& doc, const NodeChange& c);
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
  // A layer's motion transform components at local time `tau`: its MOTION_* tracks folded over their literal bases (an
  // alias base reads as the layer's motionTransform), the anchor included — what the canvas overlays draw from.
  static LayerBase poseAt(const MotionIndex& index, const AnimatedNode& an, int64_t tau);

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
