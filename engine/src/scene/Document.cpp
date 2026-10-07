#include "scene/Document.h"

#include <algorithm>
#include <cmath>

#include "base/FractionalIndex.h"

namespace eng {

namespace {

const std::vector<Guid> kNoChildren;
const Mat2x3 kIdentity;

// Fields whose change moves a node's box (or its descendants').
constexpr FieldMask kGeometryFields = F_TRANSFORM | F_SIZE | F_PARENT_INDEX | F_STROKES | F_STROKE_WEIGHT | F_STROKE_ALIGN |
                                      F_TYPE | F_RESIZE_TO_FIT | F_EFFECTS | F_STROKE_CAP | F_STROKE_JOIN | F_MITER_LIMIT |
                                      F_VECTOR_DATA;

double outerStroke(const NodeProps& p) {
  bool stroke = false;
  for (auto& s : p.strokePaints) stroke |= s.visible;
  if (!stroke || p.strokeWeight <= 0) return 0;
  double w = p.strokeWeight;
  double reach = p.strokeAlign == StrokeAlign::OUTSIDE ? w : p.strokeAlign == StrokeAlign::CENTER ? w / 2 : 0;
  if (p.isPathShape() && reach > 0) {
    // Miters, square caps and arrowheads reach past half the width.
    if (p.strokeJoin == StrokeJoin::MITER) reach *= std::max(1.0, std::min(p.miterLimit, 16.0));
    if (p.type == NodeType::LINE || p.type == NodeType::VECTOR) reach = std::max(reach, 3 * w + 6);
  }
  return reach;
}

// How far effects draw past the node's box (shadows, layer blur).
double effectsOutset(const NodeProps& p) {
  double out = 0;
  for (const Effect& e : p.effects) {
    if (!e.visible) continue;
    if (e.type == EffectType::DROP_SHADOW)
      out = std::max(out, std::max(std::fabs(e.offset.x), std::fabs(e.offset.y)) + e.radius + std::max(0.0, e.spread));
    else if (e.type == EffectType::FOREGROUND_BLUR)
      out = std::max(out, e.radius);
  }
  return out;
}

}  // namespace

// Past this many changes the log starts over (a cache that fell that far behind rebuilds).
constexpr size_t kMaxLog = 1 << 16;
// Fields that change which nodes draw or how they nest (Document::ChangeRecord::structural).
constexpr FieldMask kStructuralFields = F_PARENT_INDEX | F_VISIBLE | F_TYPE | F_RESIZE_TO_FIT | F_FRAME_MASK_DISABLED | F_MASK | F_MASK_TYPE;

void Document::record(Guid id, bool structural, const Rect& before, Guid parentBefore, FieldMask fields) {
  if (log_.size() >= kMaxLog) {
    log_.clear();
    logStart_ = version_;
  }
  version_++;
  log_.push_back({id, structural, before, parentBefore, fields});
}

Rect Document::boundsBefore(Guid id) const {
  // What it last drew at: its derived bounds, kept (stale) until it is derived again.
  auto it = derived_.find(id);
  if (it == derived_.end() || it->second.page == kNoGuid) return {};
  return it->second.bounds;
}

bool Document::changesSince(uint64_t since, std::vector<ChangeRecord>& out) const {
  if (since < logStart_ || since > version_) return false;
  for (size_t k = static_cast<size_t>(since - logStart_); k < log_.size(); k++) out.push_back(log_[k]);
  return true;
}

void Document::clear() {
  version_++;
  log_.clear();
  logStart_ = version_;
  nodes_.clear();
  children_.clear();
  unsorted_.clear();
  siblingIndex_.clear();
  derived_.clear();
  indexes_.clear();
  dirty_.clear();
  geometry_.clear();
}

const Node* Document::get(Guid id) const {
  auto it = nodes_.find(id);
  return it == nodes_.end() ? nullptr : &it->second;
}

void Document::link(Guid id, Guid parent) {
  if (parent == kNoGuid) return;
  children_[parent].push_back(id);
  unsorted_.insert(parent);
}

void Document::unlink(Guid id, Guid parent) {
  auto it = children_.find(parent);
  if (it == children_.end()) return;
  auto& v = it->second;
  v.erase(std::remove(v.begin(), v.end(), id), v.end());
  unsorted_.insert(parent);
  if (v.empty()) children_.erase(it);
}

const std::vector<Guid>& Document::children(Guid parent) const {
  auto it = children_.find(parent);
  if (it == children_.end()) return kNoChildren;
  if (unsorted_.erase(parent)) {
    std::sort(it->second.begin(), it->second.end(), [this](Guid a, Guid b) {
      const std::string& pa = nodes_.at(a).props.parentIndex.position;
      const std::string& pb = nodes_.at(b).props.parentIndex.position;
      return pa != pb ? pa < pb : a < b;
    });
    uint32_t i = 0;
    for (Guid c : it->second) siblingIndex_[c] = i++;
  }
  return it->second;
}

uint32_t Document::siblingIndex(Guid id) const {
  children(parentOf(id));  // sorted, indexes current
  auto it = siblingIndex_.find(id);
  return it == siblingIndex_.end() ? 0 : it->second;
}

Guid Document::parentOf(Guid id) const {
  const Node* n = get(id);
  return n ? n->props.parentIndex.guid : kNoGuid;
}

bool Document::isAncestor(Guid ancestor, Guid id) const {
  Guid p = parentOf(id);
  for (int guard = 0; p != kNoGuid && guard < 100000; guard++) {
    if (p == ancestor) return true;
    p = parentOf(p);
  }
  return false;
}

std::vector<Guid> Document::pathFromPage(Guid id) const {
  std::vector<Guid> path;
  Guid cur = id;
  for (int guard = 0; guard < 100000; guard++) {
    const Node* n = get(cur);
    if (!n || n->props.type == NodeType::CANVAS || n->props.type == NodeType::DOCUMENT) break;
    path.push_back(cur);
    cur = n->props.parentIndex.guid;
  }
  const Node* top = get(cur);
  if (!top || top->props.type != NodeType::CANVAS) return {};
  std::reverse(path.begin(), path.end());
  return path;
}

Guid Document::pageOf(Guid id) const {
  Guid cur = id;
  for (int guard = 0; guard < 100000; guard++) {
    const Node* n = get(cur);
    if (!n) return kNoGuid;
    if (n->props.type == NodeType::CANVAS) return cur;
    cur = n->props.parentIndex.guid;
  }
  return kNoGuid;
}

bool Document::visibleInTree(Guid id) const {
  Guid cur = id;
  for (int guard = 0; guard < 100000; guard++) {
    const Node* n = get(cur);
    if (!n) return false;
    if (n->props.type == NodeType::CANVAS || n->props.type == NodeType::DOCUMENT) return true;
    if (!n->props.visible) return false;
    cur = n->props.parentIndex.guid;
  }
  return false;
}

bool Document::paintsBefore(Guid a, Guid b) const {
  if (a == b) return false;
  auto chain = [this](Guid id) {
    std::vector<Guid> c;
    for (Guid cur = id; cur != kNoGuid && c.size() < 100000; cur = parentOf(cur)) c.push_back(cur);
    std::reverse(c.begin(), c.end());
    return c;
  };
  std::vector<Guid> ca = chain(a), cb = chain(b);
  size_t i = 0;
  while (i < ca.size() && i < cb.size() && ca[i] == cb[i]) i++;
  if (i == ca.size()) return true;   // a is an ancestor of b: painted first
  if (i == cb.size()) return false;  // b is an ancestor of a
  if (i == 0) return ca[0] < cb[0];  // different roots (orphans): any stable order
  const Node* parent = get(ca[i - 1]);
  bool reversed = parent && parent->props.stackReverseZIndex && parent->props.isAutoLayout();
  uint32_t ia = siblingIndex(ca[i]), ib = siblingIndex(cb[i]);
  return reversed ? ia > ib : ia < ib;
}

// ---- Derived geometry ----------------------------------------------------------

void Document::invalidate(Guid id) const {
  stack_.clear();
  stack_.push_back(id);
  while (!stack_.empty()) {
    Guid cur = stack_.back();
    stack_.pop_back();
    auto it = derived_.find(cur);
    if (it != derived_.end()) {
      if (!it->second.valid) continue;  // its subtree is already marked
      it->second.valid = false;
    }
    dirty_.push_back(cur);
    for (Guid c : children(cur)) stack_.push_back(c);
  }
}

void Document::unindex(Derived& d) const {
  if (d.proxy != SpatialIndex::kNull) {
    auto it = indexes_.find(d.page);
    if (it != indexes_.end()) it->second.remove(d.proxy);
    d.proxy = SpatialIndex::kNull;
  }
}

Document::Derived& Document::derive(Guid id) const {
  Derived& d = derived_[id];
  if (d.valid) return d;
  const Node* n = get(id);
  d.valid = true;
  if (!n) {
    d.world = kIdentity;
    return d;
  }
  const NodeProps& p = n->props;
  Guid page = kNoGuid;
  if (p.type == NodeType::DOCUMENT || p.type == NodeType::CANVAS) {
    d.world = kIdentity;
  } else {
    const Node* parent = get(p.parentIndex.guid);
    if (!parent) {
      d.world = p.transform;  // parked (no parent yet)
    } else if (parent->props.type == NodeType::CANVAS) {
      d.world = p.transform;
      page = p.parentIndex.guid;
    } else if (parent->props.type == NodeType::DOCUMENT) {
      d.world = p.transform;
    } else {
      const Derived& pd = derive(p.parentIndex.guid);
      d.world = pd.world * p.transform;
      page = pd.page;
    }
  }
  // The render bounds: the box, grown by the outside part of visible strokes.
  Rect box = transformedBounds(d.world, p.size.x, p.size.y);
  double grow = (outerStroke(p) + effectsOutset(p)) * std::sqrt(std::fabs(d.world.determinant()));
  d.bounds = {box.x - grow, box.y - grow, box.w + 2 * grow, box.h + 2 * grow};
  // The page's spatial index (pages and the document aren't in one).
  bool indexed = page != kNoGuid && p.type != NodeType::DOCUMENT && p.type != NodeType::CANVAS;
  if (d.proxy != SpatialIndex::kNull && (!indexed || page != d.page)) unindex(d);
  d.page = page;
  if (indexed) {
    if (d.proxy == SpatialIndex::kNull) d.proxy = indexes_[page].insert(d.bounds, id);
    else indexes_[page].move(d.proxy, d.bounds);
  }
  return d;
}

void Document::flush() const {
  if (dirty_.empty()) return;
  // derive() may add entries to derived_; the dirty list is copied so it can't change under us.
  std::vector<Guid> work;
  work.swap(dirty_);
  for (Guid id : work)
    if (nodes_.count(id)) derive(id);
}

Mat2x3 Document::worldTransform(Guid id) const {
  if (!nodes_.count(id)) return kIdentity;
  flush();
  return derive(id).world;
}

Rect Document::localBounds(Guid id) const {
  const Node* n = get(id);
  if (!n) return {};
  return {0, 0, n->props.size.x, n->props.size.y};
}

Rect Document::worldBounds(Guid id) const {
  const Node* n = get(id);
  if (!n) return {};
  return transformedBounds(worldTransform(id), n->props.size.x, n->props.size.y);
}

Rect Document::renderBounds(Guid id) const {
  if (!nodes_.count(id)) return {};
  flush();
  return derive(id).bounds;
}

const SpatialIndex* Document::indexOf(Guid page) const {
  flush();
  auto it = indexes_.find(page);
  return it == indexes_.end() ? nullptr : &it->second;
}

std::string Document::positionAtEnd(Guid parent) const {
  const auto& kids = children(parent);
  std::string last = kids.empty() ? std::string() : get(kids.back())->props.parentIndex.position;
  return fractional::keyBetween(last, std::nullopt, fractional::Bias::Low);
}

uint32_t Document::maxLocalID(uint32_t sessionID) const {
  uint32_t m = 0;
  for (auto& [id, n] : nodes_)
    if (id.sessionID == sessionID) m = std::max(m, id.localID);
  return m;
}

// ---- Changes ------------------------------------------------------------------------

bool Document::apply(const NodeChange& change, NodeChange* inverse) {
  auto it = nodes_.find(change.guid);
  switch (change.phase) {
    case Phase::CREATED: {
      if (change.guid == kNoGuid) return false;
      Guid parent = change.props.parentIndex.guid;
      if (parent == change.guid || (parent != kNoGuid && it != nodes_.end() && isAncestor(change.guid, parent))) return false;
      if (it != nodes_.end()) {
        // CREATED for a live GUID is a full replace (docs/schema.md §4.2); its inverse puts the old state back.
        if (inverse) *inverse = NodeChange::created(change.guid, it->second.props);
        record(change.guid, true, boundsBefore(change.guid), it->second.props.parentIndex.guid, F_ALL);
        unlink(change.guid, it->second.props.parentIndex.guid);
        it->second.props = change.props;
        link(change.guid, parent);
        invalidate(change.guid);
        return true;
      }
      nodes_.emplace(change.guid, Node{change.guid, change.props});
      record(change.guid, true, {}, kNoGuid, F_ALL);
      link(change.guid, parent);
      invalidate(change.guid);  // its subtree too: parked children may be waiting for it
      if (inverse) *inverse = NodeChange::removed(change.guid);
      return true;
    }
    case Phase::REMOVED: {
      if (it == nodes_.end()) return false;
      if (inverse) *inverse = NodeChange::created(change.guid, it->second.props);
      record(change.guid, true, boundsBefore(change.guid), it->second.props.parentIndex.guid, F_ALL);
      // Its children (if any are left) become parked: out of the index.
      for (Guid c : children(change.guid)) invalidate(c);
      auto d = derived_.find(change.guid);
      if (d != derived_.end()) {
        unindex(d->second);
        derived_.erase(d);
      }
      unlink(change.guid, it->second.props.parentIndex.guid);
      siblingIndex_.erase(change.guid);
      nodes_.erase(it);
      return true;
    }
    case Phase::CHANGED: {
      if (it == nodes_.end()) return false;
      NodeProps& props = it->second.props;
      Guid oldParent = props.parentIndex.guid;
      if (change.mask & F_PARENT_INDEX) {
        Guid np = change.props.parentIndex.guid;
        if (np == change.guid || (np != kNoGuid && isAncestor(change.guid, np))) return false;
      }
      FieldMask plain = change.mask & ~static_cast<FieldMask>(F_EXTRA);
      record(change.guid, (change.mask & kStructuralFields) != 0, boundsBefore(change.guid), oldParent, change.mask);
      if (inverse) {
        *inverse = NodeChange::changed(change.guid);
        inverse->mask = change.mask;
        copyFields(inverse->props, props, plain);
      }
      copyFields(props, change.props, plain);
      if (change.mask & F_EXTRA) {
        // Unmodelled fields merge: each key of the change is set (an empty value removes it).
        for (auto& [key, value] : change.props.extra) {
          auto old = props.extra.find(key);
          if (inverse) inverse->props.extra[key] = old == props.extra.end() ? std::string() : old->second;
          if (value.empty()) {
            if (old != props.extra.end()) props.extra.erase(old);
          } else {
            props.extra[key] = value;
          }
        }
      }
      if (change.mask & F_PARENT_INDEX) {
        if (props.parentIndex.guid != oldParent) {
          unlink(change.guid, oldParent);
          link(change.guid, props.parentIndex.guid);
        } else {
          unsorted_.insert(oldParent);
        }
      }
      if (change.mask & kGeometryFields) invalidate(change.guid);
      return true;
    }
  }
  return false;
}

}  // namespace eng
