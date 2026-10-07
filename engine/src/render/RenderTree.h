// The render tree (docs/engine.md §6.2): one page's drawn layers flattened in
// paint order — a node, then its subtree, then its next sibling — each with the
// index just past its subtree and its visual bounds in world space (what it and
// its subtree can cover: strokes, effects, children a frame doesn't clip). A
// frame walks it instead of the scene graph: whole subtrees off screen or too
// small to see are skipped by one test (culling and LOD, §6.8), and no node is
// looked up by GUID on the way.
//
// It is kept in step with the document through Document's change log: a
// structural change (a node added, removed, moved, shown or hidden, its type,
// clipping or masking changed) rebuilds the page's tree; any other change only
// recomputes the bounds of the changed node's subtree and of its ancestors.
#pragma once

#include <cstdint>
#include <functional>
#include <unordered_map>
#include <vector>

#include "scene/Document.h"

namespace eng {

struct RenderNode {
  Guid id;
  const Node* node = nullptr;
  uint32_t end = 0;         // one past the last node of its subtree
  uint32_t parent = 0;      // its parent's index (kNoParent for the page's children)
  bool hasChildren = false;  // in the document, hidden ones included (what the effect rules look at)
  Rect visual;              // world space
};

class RenderTree {
 public:
  static constexpr uint32_t kNoParent = 0xffffffffu;

  // Brings the tree up to the document's version for `page` (built on first use or when the page changes).
  // Returns true when it was rebuilt.
  bool sync(const Document& doc, Guid page);
  // Where a TEXT node's glyphs reach (node space; false: unknown) — text can overflow its box (a fixed-size box,
  // overhangs): its visual bounds include it, so it is neither culled nor left stale where it overflows.
  void setTextInk(std::function<bool(Guid, Rect&)> ink) { ink_ = std::move(ink); }
  // Starts over at the next sync.
  void invalidate() { built_ = false; }

  const std::vector<RenderNode>& nodes() const { return nodes_; }
  size_t size() const { return nodes_.size(); }
  Guid page() const { return page_; }
  // The node's index (−1 when it isn't drawn on this page: hidden, elsewhere, gone).
  int indexOf(Guid id) const {
    auto it = index_.find(id);
    return it == index_.end() ? -1 : static_cast<int>(it->second);
  }
  // Rebuilds and bound updates since construction (tests, stats).
  uint32_t rebuilds() const { return rebuilds_; }
  uint32_t updates() const { return updates_; }

  // Damage: where the page's pixels may have changed since the last takeDamage (world space) — each changed
  // node's visual bounds before and after the change. `all`: everything (a first build, a page that changed,
  // changes no longer in the log, or too many rectangles to keep).
  struct Damage {
    bool all = false;
    std::vector<Rect> rects;
  };
  Damage takeDamage();

 private:
  void build(const Document& doc);
  void add(const Document& doc, Guid id, uint32_t parent, int depth);
  // The visual bounds of node `i` from its own render bounds and its children's (already current).
  void bound(const Document& doc, uint32_t i);

  Guid page_ = kNoGuid;
  bool built_ = false;
  uint64_t version_ = 0;
  std::vector<RenderNode> nodes_;
  std::unordered_map<Guid, uint32_t, GuidHash> index_;
  std::vector<Document::ChangeRecord> changes_;
  std::vector<uint8_t> marks_;
  uint32_t rebuilds_ = 0, updates_ = 0;
  Damage damage_{true, {}};
  std::function<bool(Guid, Rect&)> ink_;
  void damage(const Rect& r);
};

}  // namespace eng
