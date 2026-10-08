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
// clipping or masking changed) re-places that node's subtree in the array —
// taken out where it was, built again where it belongs now — and only many
// such changes at once rebuild the page's tree; any other change only
// recomputes the bounds of the changed node's subtree and of its ancestors.
#pragma once

#include <cstdint>
#include <functional>
#include <unordered_map>
#include <unordered_set>
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
  // Rebuilds, subtree relocations and bound updates since construction (tests, stats).
  uint32_t rebuilds() const { return rebuilds_; }
  uint32_t relocations() const { return relocations_; }
  uint32_t updates() const { return updates_; }
  // The array as a fresh build would make it (tests): false when it differs (an index, range, parent or
  // visual-bounds mismatch).
  bool consistent(const Document& doc) const;

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
  // `id`'s subtree built into `out` (indices absolute from `base`), as add() would.
  void addTo(std::vector<RenderNode>& out, const Document& doc, Guid id, uint32_t parent, int depth, uint32_t base);
  // Re-placing a changed subtree, in two passes over all of them: detach() takes it out of where it is (damage where
  // it was; its ancestors go into `chains` for rebound()); attach() builds it again where the document puts it now
  // (nowhere when it is hidden or gone; damage where it is; `placed` gathers the ids built, so a later record of one
  // of them is skipped).
  void detach(const Document& doc, Guid id, std::vector<Guid>& chains);
  void attach(const Document& doc, Guid id, std::unordered_set<Guid, GuidHash>& placed, std::vector<Guid>& chains);
  // The visual bounds of node `i` from its own render bounds and its children's (already current).
  void bound(const Document& doc, uint32_t i);
  // bound() for `ids` (ancestor chains), deepest first.
  void rebound(const Document& doc, std::vector<Guid>& ids);

  Guid page_ = kNoGuid;
  bool built_ = false;
  uint64_t version_ = 0;
  std::vector<RenderNode> nodes_;
  std::unordered_map<Guid, uint32_t, GuidHash> index_;
  std::vector<Document::ChangeRecord> changes_;
  std::vector<uint8_t> marks_;
  uint32_t rebuilds_ = 0, relocations_ = 0, updates_ = 0;
  Damage damage_{true, {}};
  std::function<bool(Guid, Rect&)> ink_;
  void damage(const Rect& r);
  // PATTERN fills (docs/engine.md §6.5): each drawn node with one → the layers its patterns tile. A change to such a
  // source, or anywhere in its subtree, on any page, damages the nodes that tile it (their pixels are its pixels).
  std::unordered_map<Guid, std::vector<Guid>, GuidHash> patternSources_;
  void notePatterns(Guid id, const Node* n);
  void damagePatternUsers(const Document& doc);
};

}  // namespace eng
