// The scene graph: a flat table of nodes keyed by GUID. Parent and order live
// on the child (parentIndex = {parent, fractional position}); the children of
// a node are derived by sorting positions. Every edit goes through apply(),
// which hands back the change that undoes it.
//
// Derived data is cached here and kept current by apply() (docs/engine.md §3,
// steps 7 and §8.1): world transforms, world bounds, sibling order, and one
// spatial index per page (hit/SpatialIndex). It is recomputed lazily, only for
// what changed.
#pragma once

#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "geometry/NodeGeometry.h"
#include "hit/SpatialIndex.h"
#include "scene/Node.h"

namespace eng {

class Document {
 public:
  // Applies `change` (docs/schema.md §4.3). Returns false (and changes nothing)
  // when it is refused: CHANGED/REMOVED for an unknown id, or a parentIndex that
  // would make a cycle. CREATED for a live id replaces the node. A node whose
  // parent isn't there yet is kept (parked) and joins its parent when that
  // arrives. On success `inverse` (if given) is the change that puts things back.
  bool apply(const NodeChange& change, NodeChange* inverse = nullptr);

  const Node* get(Guid id) const;
  bool has(Guid id) const { return nodes_.count(id) != 0; }
  size_t size() const { return nodes_.size(); }
  void clear();

  // The children of `parent`, back to front (ascending position, then id).
  const std::vector<Guid>& children(Guid parent) const;
  // A node's index among its parent's children (back to front).
  uint32_t siblingIndex(Guid id) const;
  Guid parentOf(Guid id) const;
  // Whether `ancestor` is a strict ancestor of `id`.
  bool isAncestor(Guid ancestor, Guid id) const;
  // The ids from the page's direct child down to `id` (empty for pages and unknown ids).
  std::vector<Guid> pathFromPage(Guid id) const;
  // The CANVAS that holds `id` (kNoGuid when none).
  Guid pageOf(Guid id) const;
  // Whether `a` is painted before (below) `b` (stackReverseZIndex respected).
  bool paintsBefore(Guid a, Guid b) const;
  // Visible, and so are all its ancestors.
  bool visibleInTree(Guid id) const;

  // Node space → world (page) space. Cached.
  Mat2x3 worldTransform(Guid id) const;
  // The node's own box in its space: {0, 0, w, h}.
  Rect localBounds(Guid id) const;
  // The axis-aligned world bounds of the node's box.
  Rect worldBounds(Guid id) const;
  // worldBounds grown by the outside part of its strokes (what it can draw).
  Rect renderBounds(Guid id) const;

  // Calls f(id) for every node on `page` whose render bounds may touch `r`
  // (a superset: callers test exactly). Stop by returning false.
  template <typename F>
  void query(Guid page, const Rect& r, F&& f) const {
    flush();
    auto it = indexes_.find(page);
    if (it != indexes_.end()) it->second.query(r, f);
  }
  // The spatial index of `page` (tests and diagnostics).
  const SpatialIndex* indexOf(Guid page) const;

  // A position after the last child of `parent` (keyBetween(last, 1, LOW); no rebalancing).
  std::string positionAtEnd(Guid parent) const;
  // The largest localID used by `sessionID` (0 when none).
  uint32_t maxLocalID(uint32_t sessionID) const;

  // The paths nodes draw (vectors, shapes, booleans, text outlines), cached (geometry/NodeGeometry.h).
  GeometryCache& geometryCache() const { return geometry_; }
  const NodeGeometry* geometry(Guid id) const { return geometry_.get(*this, id); }

  template <typename F>
  void forEach(F&& f) const {
    for (auto& [id, node] : nodes_) f(node);
  }

  // Every applied change bumps the version and is logged, so caches built from the document (the render tree,
  // the tiles) catch up with what changed instead of starting over. `structural`: the node appeared, went, moved
  // to another parent or place, or changed in a way that changes which nodes draw and how they nest (type,
  // visibility, group-ness, clipping, masks).
  struct ChangeRecord {
    Guid id;
    bool structural = false;
    Rect before;  // its render bounds before the change (world; empty when it had none)
  };
  uint64_t version() const { return version_; }
  // The changes after version `since`, in order; false when they are no longer kept (start over).
  bool changesSince(uint64_t since, std::vector<ChangeRecord>& out) const;

 private:
  void record(Guid id, bool structural, const Rect& before);
  Rect boundsBefore(Guid id) const;
  struct Derived {
    Mat2x3 world;
    Rect bounds;  // render bounds, world
    Guid page = kNoGuid;
    int proxy = SpatialIndex::kNull;
    bool valid = false;
  };

  void link(Guid id, Guid parent);
  void unlink(Guid id, Guid parent);
  void invalidate(Guid id) const;
  void flush() const;
  Derived& derive(Guid id) const;
  void unindex(Derived& d) const;

  std::unordered_map<Guid, Node, GuidHash> nodes_;
  mutable std::unordered_map<Guid, std::vector<Guid>, GuidHash> children_;
  mutable std::unordered_set<Guid, GuidHash> unsorted_;
  mutable std::unordered_map<Guid, uint32_t, GuidHash> siblingIndex_;
  mutable std::unordered_map<Guid, Derived, GuidHash> derived_;
  mutable std::unordered_map<Guid, SpatialIndex, GuidHash> indexes_;
  mutable std::vector<Guid> dirty_;
  mutable std::vector<Guid> stack_;
  mutable GeometryCache geometry_;
  uint64_t version_ = 0;
  uint64_t logStart_ = 0;  // log_[k] is the change of version logStart_ + 1 + k
  std::vector<ChangeRecord> log_;
};

}  // namespace eng
