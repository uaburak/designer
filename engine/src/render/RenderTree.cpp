#include "render/RenderTree.h"

#include <algorithm>

namespace eng {

void RenderTree::add(const Document& doc, Guid id, uint32_t parent, int depth) {
  const Node* n = doc.get(id);
  if (!n || !n->props.visible || depth > 256) return;
  uint32_t i = static_cast<uint32_t>(nodes_.size());
  RenderNode r;
  r.id = id;
  r.node = n;
  r.parent = parent;
  nodes_.push_back(r);
  index_[id] = i;
  const std::vector<Guid>& kids = doc.children(id);
  nodes_[i].hasChildren = !kids.empty();
  for (Guid c : kids) add(doc, c, i, depth + 1);
  nodes_[i].end = static_cast<uint32_t>(nodes_.size());
}

void RenderTree::bound(const Document& doc, uint32_t i) {
  RenderNode& r = nodes_[i];
  const NodeProps& p = r.node->props;
  Rect own = doc.renderBounds(r.id);
  Rect ink;
  if (p.type == NodeType::TEXT && ink_ && ink_(r.id, ink) && ink.w > 0 && ink.h > 0) own = own.united(transformedBounds(doc.worldTransform(r.id) * Mat2x3::translate(ink.x, ink.y), ink.w, ink.h));
  bool group = p.fitsChildren() && !p.isBoolean();
  if (!group && !(p.isFrameLike() && !p.clipsContent())) {
    r.visual = own;
    return;
  }
  // Groups and frames that don't clip: their children's too (a group: only its children's, its own effects around).
  bool any = !group;
  Rect u = group ? Rect{} : own;
  for (uint32_t c = i + 1; c < r.end; c = nodes_[c].end) {
    u = any ? u.united(nodes_[c].visual) : nodes_[c].visual;
    any = true;
  }
  if (group) {
    if (!any) {
      r.visual = own;
      return;
    }
    Rect box = doc.worldBounds(r.id);
    double g = std::max({box.x - own.x, own.right() - box.right(), box.y - own.y, own.bottom() - box.bottom(), 0.0});
    u = {u.x - g, u.y - g, u.w + 2 * g, u.h + 2 * g};
  }
  r.visual = u;
}

void RenderTree::build(const Document& doc) {
  rebuilds_++;
  nodes_.clear();
  index_.clear();
  version_ = doc.version();
  if (page_ != kNoGuid)
    for (Guid c : doc.children(page_)) add(doc, c, kNoParent, 0);
  for (size_t i = nodes_.size(); i-- > 0;) bound(doc, static_cast<uint32_t>(i));
  built_ = true;
}

void RenderTree::damage(const Rect& r) {
  if (damage_.all || r.w < 0 || r.h < 0) return;
  if (damage_.rects.size() >= 512) {
    damage_.all = true;
    damage_.rects.clear();
    return;
  }
  damage_.rects.push_back(r);
}

RenderTree::Damage RenderTree::takeDamage() {
  Damage d = std::move(damage_);
  damage_ = Damage{};
  return d;
}

bool RenderTree::sync(const Document& doc, Guid page) {
  if (!built_ || page != page_) {
    page_ = page;
    build(doc);
    damage_ = Damage{true, {}};
    return true;
  }
  if (doc.version() == version_) return false;
  changes_.clear();
  if (!doc.changesSince(version_, changes_) || changes_.size() > nodes_.size() + 64) {
    build(doc);
    damage_ = Damage{true, {}};
    return true;
  }
  // A structural change here (or one that brings a node here) rebuilds; one elsewhere doesn't matter.
  auto here = [&](Guid id) { return id == page_ || index_.count(id) != 0; };
  for (const Document::ChangeRecord& c : changes_) {
    if (!c.structural) continue;
    if (index_.count(c.id) || here(doc.parentOf(c.id))) {
      // What the changed nodes covered before and cover now.
      for (const Document::ChangeRecord& k : changes_)
        if (auto it = index_.find(k.id); it != index_.end()) damage(nodes_[it->second].visual);
      build(doc);
      for (const Document::ChangeRecord& k : changes_)
        if (auto it = index_.find(k.id); it != index_.end()) damage(nodes_[it->second].visual);
      return true;
    }
  }
  // Otherwise the changed nodes' subtrees and their ancestors get their bounds again, children before parents.
  marks_.assign(nodes_.size(), 0);
  bool any = false;
  for (const Document::ChangeRecord& c : changes_) {
    auto it = index_.find(c.id);
    if (it == index_.end()) continue;
    uint32_t i = it->second;
    if (marks_[i] == 2) continue;
    damage(nodes_[i].visual);
    any = true;
    for (uint32_t j = i; j < nodes_[i].end; j++) marks_[j] = std::max<uint8_t>(marks_[j], 1);
    marks_[i] = 2;  // changed itself: damaged again with its new bounds
    for (uint32_t a = nodes_[i].parent; a != kNoParent && !marks_[a]; a = nodes_[a].parent) marks_[a] = 1;
  }
  if (any) {
    updates_++;
    for (size_t j = nodes_.size(); j-- > 0;)
      if (marks_[j]) bound(doc, static_cast<uint32_t>(j));
    for (size_t j = 0; j < nodes_.size(); j++)
      if (marks_[j] == 2) damage(nodes_[j].visual);
  }
  version_ = doc.version();
  return false;
}

}  // namespace eng
