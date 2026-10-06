// Layout (docs/engine.md §4): auto layout (horizontal / vertical, wrap, gaps
// incl. auto, padding, alignment, Hug / Fill / Fixed, min / max, absolute
// children), constraints for children of resized frames, and groups fitting
// their children. Results are written back as real `size` / `transform`
// (system writes in the current transaction, through the host).
#pragma once

#include <unordered_map>
#include <vector>

#include "scene/Document.h"

namespace eng {

class LayoutHost {
 public:
  virtual ~LayoutHost() = default;
  virtual const Document& document() const = 0;
  // Writes the node's transform and size (only what differs).
  virtual void writeGeometry(Guid id, const Mat2x3& transform, Vec2 size) = 0;
  // Whether the frame's size was written in this transaction, and what it was
  // when the transaction began (constraints act only then, docs/engine.md §4.4).
  virtual bool resizedInTxn(Guid frame, Vec2& oldSize) const = 0;
  // A node's transform and size when the transaction began (what constraints
  // start from, so a gesture never drifts).
  virtual void base(Guid id, Mat2x3& transform, Vec2& size) const = 0;
  // Taken out of the flow for now: being dragged into an auto-layout frame (it
  // takes no space there until it is dropped).
  virtual bool excludedFromFlow(Guid id) const = 0;
  // Placed by a gesture for now: it keeps its slot in the flow (its frame keeps
  // its shape while it is dragged inside it) but layout doesn't move it.
  virtual bool placedByGesture(Guid id) const = 0;
  // Resizing with ⌘ held: children keep their place (Figma's "ignore constraints").
  virtual bool ignoreConstraints(Guid frame) const = 0;
};

class Layout {
 public:
  explicit Layout(LayoutHost& host) : host_(host), doc_(host.document()) {}

  // Lays out everything that depends on the nodes in `dirty` (whose layout
  // inputs changed): their layout roots are found by walking up through
  // auto-layout parents and groups.
  void run(const std::vector<Guid>& dirty);

  // The size `id` takes on its own (Hug computed, Fixed as is, clamped by
  // min/max); `width` / `height` > 0 fix that axis first (a Fill width decides
  // a wrapping frame's height).
  Vec2 natural(Guid id, double width = -1, double height = -1);

  // Where an auto-layout frame's children go, without writing anything:
  // their sizes and the positions of their layout boxes, in the frame's space.
  struct Placement {
    Guid id;
    Vec2 size;
    Vec2 position;  // the top-left of the child's layout box (its bounds in the frame's space)
  };
  std::vector<Placement> place(Guid frame, Vec2 frameSize);

  // The flow children of an auto-layout frame, in order.
  std::vector<Guid> flowChildren(Guid frame) const;

  // Padding (left, top, right, bottom) of an auto-layout frame, strokes included when they take space.
  static void padding(const NodeProps& p, double out[4]);

 private:
  void arrange(Guid id, Vec2 size, bool sizeFromParent);
  void arrangeAutoLayout(Guid id, Vec2 size);
  void applyConstraints(Guid frame, bool flowChildrenToo);
  void fitGroup(Guid id);
  Vec2 contentSize(Guid frame, Vec2 frameSize);

  LayoutHost& host_;
  const Document& doc_;
  struct MemoKey {
    Guid id;
    double w, h;
    bool operator==(const MemoKey& o) const { return id == o.id && w == o.w && h == o.h; }
  };
  struct MemoHash {
    size_t operator()(const MemoKey& k) const noexcept {
      return GuidHash()(k.id) ^ (std::hash<double>()(k.w) * 31) ^ (std::hash<double>()(k.h) * 131);
    }
  };
  std::unordered_map<MemoKey, Vec2, MemoHash> memo_;
};

// A child's layout box: the bounds of its box in its parent's space, for a given size.
Rect layoutBox(const Mat2x3& transform, Vec2 size);

}  // namespace eng
