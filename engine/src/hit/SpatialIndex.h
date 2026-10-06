// A dynamic AABB tree (docs/engine.md §8.1, Box2D's b2DynamicTree): leaves are
// "fat" boxes (the node's box grown by a margin), so small moves don't touch
// the tree; inserts, removals and moves are incremental and the tree stays
// balanced (AVL rotations). Used by hit-testing, marquee and snapping.
#pragma once

#include <cstdint>
#include <vector>

#include "base/Guid.h"
#include "math/Math.h"

namespace eng {

class SpatialIndex {
 public:
  static constexpr int kNull = -1;

  explicit SpatialIndex(double margin = 2) : margin_(margin) {}

  // Adds a leaf for `id` with box `r`; returns its proxy.
  int insert(const Rect& r, Guid id);
  void remove(int proxy);
  // Updates a leaf's box; returns true when the tree changed (the box left its fat box).
  bool move(int proxy, const Rect& r);
  void clear();

  Guid idOf(int proxy) const { return nodes_[static_cast<size_t>(proxy)].id; }
  Rect fatBox(int proxy) const;
  size_t size() const { return leaves_; }
  int height() const { return root_ == kNull ? 0 : nodes_[static_cast<size_t>(root_)].height; }
  // Checks the tree's invariants (tests).
  bool valid() const;

  // Calls f(id) for every leaf whose fat box touches `r`; stop by returning false.
  template <typename F>
  void query(const Rect& r, F&& f) const {
    if (root_ == kNull) return;
    Box q{r.x, r.y, r.x + r.w, r.y + r.h};
    stack_.clear();
    stack_.push_back(root_);
    while (!stack_.empty()) {
      int i = stack_.back();
      stack_.pop_back();
      const TreeNode& n = nodes_[static_cast<size_t>(i)];
      if (!n.box.overlaps(q)) continue;
      if (n.leaf()) {
        if (!f(n.id)) return;
      } else {
        stack_.push_back(n.child1);
        stack_.push_back(n.child2);
      }
    }
  }

 private:
  struct Box {
    double x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    bool overlaps(const Box& o) const { return x0 <= o.x1 && o.x0 <= x1 && y0 <= o.y1 && o.y0 <= y1; }
    bool contains(const Box& o) const { return x0 <= o.x0 && y0 <= o.y0 && o.x1 <= x1 && o.y1 <= y1; }
    double perimeter() const { return 2 * ((x1 - x0) + (y1 - y0)); }
    static Box combine(const Box& a, const Box& b) {
      return {a.x0 < b.x0 ? a.x0 : b.x0, a.y0 < b.y0 ? a.y0 : b.y0, a.x1 > b.x1 ? a.x1 : b.x1, a.y1 > b.y1 ? a.y1 : b.y1};
    }
  };
  struct TreeNode {
    Box box;
    int parent = kNull;  // also the free list's next
    int child1 = kNull, child2 = kNull;
    int height = -1;  // -1: free
    Guid id;
    bool leaf() const { return child1 == kNull; }
  };

  Box fatten(const Rect& r) const { return {r.x - margin_, r.y - margin_, r.x + r.w + margin_, r.y + r.h + margin_}; }
  int allocate();
  void release(int i);
  void insertLeaf(int leaf);
  void removeLeaf(int leaf);
  int balance(int a);
  int validate(int i, bool& ok) const;

  std::vector<TreeNode> nodes_;
  int root_ = kNull;
  int free_ = kNull;
  size_t leaves_ = 0;
  double margin_;
  mutable std::vector<int> stack_;
};

}  // namespace eng
