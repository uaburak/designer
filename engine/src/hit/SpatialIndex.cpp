#include "hit/SpatialIndex.h"

#include <algorithm>
#include <cmath>

namespace eng {

int SpatialIndex::allocate() {
  if (free_ == kNull) {
    nodes_.emplace_back();
    return static_cast<int>(nodes_.size() - 1);
  }
  int i = free_;
  TreeNode& n = nodes_[static_cast<size_t>(i)];
  free_ = n.parent;
  n = TreeNode{};
  return i;
}

void SpatialIndex::release(int i) {
  TreeNode& n = nodes_[static_cast<size_t>(i)];
  n.height = -1;
  n.child1 = n.child2 = kNull;
  n.parent = free_;
  free_ = i;
}

void SpatialIndex::clear() {
  nodes_.clear();
  root_ = kNull;
  free_ = kNull;
  leaves_ = 0;
}

Rect SpatialIndex::fatBox(int proxy) const {
  const Box& b = nodes_[static_cast<size_t>(proxy)].box;
  return {b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0};
}

int SpatialIndex::insert(const Rect& r, Guid id) {
  int leaf = allocate();
  TreeNode& n = nodes_[static_cast<size_t>(leaf)];
  n.box = fatten(r);
  n.id = id;
  n.height = 0;
  insertLeaf(leaf);
  leaves_++;
  return leaf;
}

void SpatialIndex::remove(int proxy) {
  removeLeaf(proxy);
  release(proxy);
  leaves_--;
}

bool SpatialIndex::move(int proxy, const Rect& r) {
  Box tight{r.x, r.y, r.x + r.w, r.y + r.h};
  if (nodes_[static_cast<size_t>(proxy)].box.contains(tight)) return false;
  removeLeaf(proxy);
  nodes_[static_cast<size_t>(proxy)].box = fatten(r);
  insertLeaf(proxy);
  return true;
}

void SpatialIndex::insertLeaf(int leaf) {
  if (root_ == kNull) {
    root_ = leaf;
    nodes_[static_cast<size_t>(root_)].parent = kNull;
    return;
  }
  // Find the best sibling (Box2D's surface-area heuristic, with perimeters in 2D).
  Box leafBox = nodes_[static_cast<size_t>(leaf)].box;
  int index = root_;
  while (!nodes_[static_cast<size_t>(index)].leaf()) {
    const TreeNode& n = nodes_[static_cast<size_t>(index)];
    int c1 = n.child1, c2 = n.child2;
    double area = n.box.perimeter();
    double combined = Box::combine(n.box, leafBox).perimeter();
    double cost = 2 * combined;               // a new parent for this node and the leaf
    double inheritance = 2 * (combined - area);  // pushing the leaf down costs this at every level
    auto childCost = [&](int c) {
      const TreeNode& cn = nodes_[static_cast<size_t>(c)];
      Box box = Box::combine(leafBox, cn.box);
      return cn.leaf() ? box.perimeter() + inheritance : box.perimeter() - cn.box.perimeter() + inheritance;
    };
    double cost1 = childCost(c1), cost2 = childCost(c2);
    if (cost < cost1 && cost < cost2) break;
    index = cost1 < cost2 ? c1 : c2;
  }
  int sibling = index;

  // A new parent for the sibling and the leaf.
  int oldParent = nodes_[static_cast<size_t>(sibling)].parent;
  int newParent = allocate();
  {
    TreeNode& np = nodes_[static_cast<size_t>(newParent)];
    np.parent = oldParent;
    np.box = Box::combine(leafBox, nodes_[static_cast<size_t>(sibling)].box);
    np.height = nodes_[static_cast<size_t>(sibling)].height + 1;
    np.child1 = sibling;
    np.child2 = leaf;
  }
  if (oldParent != kNull) {
    TreeNode& op = nodes_[static_cast<size_t>(oldParent)];
    if (op.child1 == sibling) op.child1 = newParent;
    else op.child2 = newParent;
  } else {
    root_ = newParent;
  }
  nodes_[static_cast<size_t>(sibling)].parent = newParent;
  nodes_[static_cast<size_t>(leaf)].parent = newParent;

  // Walk back up fixing heights and boxes, rebalancing on the way.
  index = nodes_[static_cast<size_t>(leaf)].parent;
  while (index != kNull) {
    index = balance(index);
    TreeNode& n = nodes_[static_cast<size_t>(index)];
    const TreeNode& c1 = nodes_[static_cast<size_t>(n.child1)];
    const TreeNode& c2 = nodes_[static_cast<size_t>(n.child2)];
    n.height = 1 + std::max(c1.height, c2.height);
    n.box = Box::combine(c1.box, c2.box);
    index = n.parent;
  }
}

void SpatialIndex::removeLeaf(int leaf) {
  if (leaf == root_) {
    root_ = kNull;
    return;
  }
  int parent = nodes_[static_cast<size_t>(leaf)].parent;
  int grandParent = nodes_[static_cast<size_t>(parent)].parent;
  const TreeNode& p = nodes_[static_cast<size_t>(parent)];
  int sibling = p.child1 == leaf ? p.child2 : p.child1;
  if (grandParent != kNull) {
    TreeNode& g = nodes_[static_cast<size_t>(grandParent)];
    if (g.child1 == parent) g.child1 = sibling;
    else g.child2 = sibling;
    nodes_[static_cast<size_t>(sibling)].parent = grandParent;
    release(parent);
    int index = grandParent;
    while (index != kNull) {
      index = balance(index);
      TreeNode& n = nodes_[static_cast<size_t>(index)];
      const TreeNode& c1 = nodes_[static_cast<size_t>(n.child1)];
      const TreeNode& c2 = nodes_[static_cast<size_t>(n.child2)];
      n.box = Box::combine(c1.box, c2.box);
      n.height = 1 + std::max(c1.height, c2.height);
      index = n.parent;
    }
  } else {
    root_ = sibling;
    nodes_[static_cast<size_t>(sibling)].parent = kNull;
    release(parent);
  }
}

// A left or right rotation if `a` is imbalanced; returns the new root of the subtree.
int SpatialIndex::balance(int iA) {
  TreeNode& A = nodes_[static_cast<size_t>(iA)];
  if (A.leaf() || A.height < 2) return iA;
  int iB = A.child1, iC = A.child2;
  TreeNode& B = nodes_[static_cast<size_t>(iB)];
  TreeNode& C = nodes_[static_cast<size_t>(iC)];
  int balanceFactor = C.height - B.height;

  auto rotate = [&](int iUp, int iSide, bool upIsChild2) {
    // `up` (C or B) moves up to A's place; A becomes its child.
    TreeNode& Up = nodes_[static_cast<size_t>(iUp)];
    TreeNode& Side = nodes_[static_cast<size_t>(iSide)];
    int iF = Up.child1, iG = Up.child2;
    TreeNode& F = nodes_[static_cast<size_t>(iF)];
    TreeNode& G = nodes_[static_cast<size_t>(iG)];
    Up.child1 = iA;
    Up.parent = A.parent;
    A.parent = iUp;
    if (Up.parent != kNull) {
      TreeNode& P = nodes_[static_cast<size_t>(Up.parent)];
      if (P.child1 == iA) P.child1 = iUp;
      else P.child2 = iUp;
    } else {
      root_ = iUp;
    }
    // The taller grandchild stays with `up`; the other goes to A.
    int keep = F.height > G.height ? iF : iG;
    int give = keep == iF ? iG : iF;
    Up.child2 = keep;
    if (upIsChild2) A.child2 = give;
    else A.child1 = give;
    nodes_[static_cast<size_t>(give)].parent = iA;
    const TreeNode& K = nodes_[static_cast<size_t>(keep)];
    const TreeNode& Gv = nodes_[static_cast<size_t>(give)];
    A.box = Box::combine(Side.box, Gv.box);
    Up.box = Box::combine(A.box, K.box);
    A.height = 1 + std::max(Side.height, Gv.height);
    Up.height = 1 + std::max(A.height, K.height);
    return iUp;
  };

  if (balanceFactor > 1) return rotate(iC, iB, true);    // C up
  if (balanceFactor < -1) return rotate(iB, iC, false);  // B up
  return iA;
}

int SpatialIndex::validate(int i, bool& ok) const {
  if (i == kNull) return 0;
  const TreeNode& n = nodes_[static_cast<size_t>(i)];
  if (n.leaf()) {
    if (n.height != 0) ok = false;
    return 1;
  }
  const TreeNode& c1 = nodes_[static_cast<size_t>(n.child1)];
  const TreeNode& c2 = nodes_[static_cast<size_t>(n.child2)];
  if (c1.parent != i || c2.parent != i) ok = false;
  if (n.height != 1 + std::max(c1.height, c2.height)) ok = false;
  if (std::abs(c1.height - c2.height) > 1) ok = false;
  if (!n.box.contains(c1.box) || !n.box.contains(c2.box)) ok = false;
  return validate(n.child1, ok) + validate(n.child2, ok);
}

bool SpatialIndex::valid() const {
  bool ok = true;
  if (root_ != kNull && nodes_[static_cast<size_t>(root_)].parent != kNull) ok = false;
  int counted = validate(root_, ok);
  return ok && static_cast<size_t>(counted) == leaves_;
}

}  // namespace eng
