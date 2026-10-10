#include "render/RenderTree.h"

#include <algorithm>

#include "scene/Extras.h"

namespace eng {

namespace {
// Past this many structural changes in one sync the page's tree is rebuilt instead of re-placed piecemeal.
constexpr size_t kMaxRelocations = 24;
}  // namespace

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
  notePatterns(id, n);
  const std::vector<Guid>& kids = doc.children(id);
  nodes_[i].hasChildren = !kids.empty();
  for (Guid c : kids) add(doc, c, i, depth + 1);
  nodes_[i].end = static_cast<uint32_t>(nodes_.size());
}

void RenderTree::addTo(std::vector<RenderNode>& out, const Document& doc, Guid id, uint32_t parent, int depth, uint32_t base) {
  const Node* n = doc.get(id);
  if (!n || !n->props.visible || depth > 256) return;
  uint32_t i = base + static_cast<uint32_t>(out.size());
  RenderNode r;
  r.id = id;
  r.node = n;
  r.parent = parent;
  out.push_back(r);
  notePatterns(id, n);
  size_t at = out.size() - 1;
  const std::vector<Guid>& kids = doc.children(id);
  out[at].hasChildren = !kids.empty();
  for (Guid c : kids) addTo(out, doc, c, i, depth + 1, base);
  out[at].end = base + static_cast<uint32_t>(out.size());
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

void RenderTree::rebound(const Document& doc, std::vector<Guid>& ids) {
  std::vector<uint32_t> at;
  for (Guid id : ids) {
    auto it = index_.find(id);
    // An ancestor the document has removed (its own record comes later in this sync) has nothing to bound.
    if (it == index_.end() || !doc.get(id)) continue;
    at.push_back(it->second);
    nodes_[it->second].hasChildren = !doc.children(id).empty();  // a first child came, or the last went
  }
  // Deepest first: a node's index is always past its ancestors' (pre-order), so descending index order does it.
  std::sort(at.begin(), at.end(), std::greater<uint32_t>());
  at.erase(std::unique(at.begin(), at.end()), at.end());
  // An ancestor whose bounds change (a frame that hugs what it lost or gained): its pixels there change too — where it
  // was as well as where it is (its own size change comes later in the sync, after these bounds are already new).
  for (uint32_t i : at) {
    Rect before = nodes_[i].visual;
    bound(doc, i);
    if (!(before == nodes_[i].visual)) {
      damage(before);
      damage(nodes_[i].visual);
    }
  }
}

void RenderTree::build(const Document& doc) {
  rebuilds_++;
  nodes_.clear();
  index_.clear();
  patternSources_.clear();
  version_ = doc.version();
  if (page_ != kNoGuid)
    for (Guid c : doc.children(page_)) add(doc, c, kNoParent, 0);
  for (size_t i = nodes_.size(); i-- > 0;) bound(doc, static_cast<uint32_t>(i));
  built_ = true;
}

void RenderTree::detach(const Document& doc, Guid id, std::vector<Guid>& chains) {
  auto it = index_.find(id);
  if (it == index_.end()) return;
  uint32_t i = it->second;
  uint32_t end = nodes_[i].end, len = end - i;
  damage(nodes_[i].visual);
  for (uint32_t a = nodes_[i].parent; a != kNoParent; a = nodes_[a].parent) chains.push_back(nodes_[a].id);
  for (uint32_t j = i; j < end; j++) index_.erase(nodes_[j].id);
  nodes_.erase(nodes_.begin() + i, nodes_.begin() + end);
  for (uint32_t j = 0; j < nodes_.size(); j++) {
    RenderNode& r = nodes_[j];
    if (r.end > i) r.end -= len;  // a range past the gap, or one that held it (ancestors): both shrink
    if (r.parent != kNoParent && r.parent >= end) r.parent -= len;
    if (j >= i) index_[r.id] = j;
  }
  (void)doc;
}

void RenderTree::attach(const Document& doc, Guid id, std::unordered_set<Guid, GuidHash>& placed, std::vector<Guid>& chains) {
  // Where it belongs now: under a drawn parent (or the page), after the nearest earlier sibling that is drawn. Every
  // drawn node is at its right place by now (the changed ones were all taken out first), so that sibling's end is it.
  const Node* n = doc.get(id);
  if (!n || !n->props.visible) return;
  Guid parent = n->props.parentIndex.guid;
  uint32_t parentIndex = kNoParent;
  if (parent != page_) {
    auto pit = index_.find(parent);
    if (pit == index_.end()) return;  // its parent isn't drawn (hidden, elsewhere, or itself waiting to be attached)
    parentIndex = pit->second;
  }
  const std::vector<Guid>& siblings = doc.children(parent);
  uint32_t pos = parentIndex == kNoParent ? 0 : parentIndex + 1;
  for (size_t k = 0; k < siblings.size() && siblings[k] != id; k++)
    if (auto sit = index_.find(siblings[k]); sit != index_.end() && nodes_[sit->second].parent == parentIndex) pos = nodes_[sit->second].end;
  std::vector<RenderNode> fresh;
  addTo(fresh, doc, id, parentIndex, 0, pos);
  if (fresh.empty()) return;
  uint32_t len = static_cast<uint32_t>(fresh.size());
  // Ancestors of the insertion point: their ranges grow; everything from `pos` on moves up by `len`.
  std::vector<uint8_t> ancestor(nodes_.size(), 0);
  for (uint32_t a = parentIndex; a != kNoParent; a = nodes_[a].parent) {
    ancestor[a] = 1;
    chains.push_back(nodes_[a].id);
  }
  for (uint32_t j = 0; j < nodes_.size(); j++) {
    RenderNode& r = nodes_[j];
    if (r.end > pos || (r.end == pos && ancestor[j])) r.end += len;
    if (r.parent != kNoParent && r.parent >= pos) r.parent += len;
  }
  nodes_.insert(nodes_.begin() + pos, fresh.begin(), fresh.end());
  for (uint32_t j = pos; j < nodes_.size(); j++) index_[nodes_[j].id] = j;
  for (uint32_t j = pos + len; j-- > pos;) {
    bound(doc, j);
    placed.insert(nodes_[j].id);
  }
  damage(nodes_[pos].visual);
}

void RenderTree::notePatterns(Guid id, const Node* n) {
  auto it = patternSources_.find(id);
  if (it != patternSources_.end()) it->second.clear();
  if (!n) {
    if (it != patternSources_.end()) patternSources_.erase(it);
    return;
  }
  for (const Paint& f : n->props.fillPaints) {
    if (f.type != PaintType::PATTERN) continue;
    Guid src = paintExtras(f).sourceNodeId;
    if (src == kNoGuid) continue;
    std::vector<Guid>& v = patternSources_[id];
    if (std::find(v.begin(), v.end(), src) == v.end()) v.push_back(src);
  }
  if (auto e = patternSources_.find(id); e != patternSources_.end() && e->second.empty()) patternSources_.erase(e);
}

void RenderTree::damagePatternUsers(const Document& doc) {
  if (patternSources_.empty()) return;
  // Whether `id` or one of its ancestors is a source some user here tiles.
  std::unordered_set<Guid, GuidHash> sources;
  for (auto& [user, srcs] : patternSources_)
    for (Guid s : srcs) sources.insert(s);
  std::unordered_set<Guid, GuidHash> hit;
  auto climb = [&](Guid id) {
    for (int d = 0; id != kNoGuid && d < 512; d++, id = doc.parentOf(id))
      if (sources.count(id)) hit.insert(id);
  };
  for (const Document::ChangeRecord& c : changes_) {
    climb(c.id);
    if (c.parentBefore != kNoGuid) climb(c.parentBefore);  // taken out of (or moved within) a source
  }
  if (hit.empty()) return;
  for (auto& [user, srcs] : patternSources_) {
    auto it = index_.find(user);
    if (it == index_.end()) continue;
    for (Guid s : srcs)
      if (hit.count(s)) {
        damage(nodes_[it->second].visual);
        break;
      }
  }
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
  // Structural changes here (or ones that bring a node here) re-place the node's subtree; the page itself changing,
  // or many at once, rebuild. A change elsewhere doesn't matter.
  auto here = [&](Guid id) { return id == page_ || index_.count(id) != 0; };
  std::vector<Guid> structural;
  for (const Document::ChangeRecord& c : changes_) {
    if (!c.structural) continue;
    if (c.id == page_) {
      structural.clear();
      structural.push_back(page_);
      break;
    }
    if (index_.count(c.id) || here(doc.parentOf(c.id)) || here(c.parentBefore)) structural.push_back(c.id);
  }
  if (!structural.empty() && (structural.size() > kMaxRelocations || structural[0] == page_)) {
    for (const Document::ChangeRecord& k : changes_)
      if (auto it = index_.find(k.id); it != index_.end()) damage(nodes_[it->second].visual);
    build(doc);
    for (const Document::ChangeRecord& k : changes_)
      if (auto it = index_.find(k.id); it != index_.end()) damage(nodes_[it->second].visual);
    return true;
  }
  // Two passes: every changed subtree out, then each back in where the document puts it now. Taking them all out
  // first matters: a changed sibling still at its stale place would otherwise decide where another one goes.
  relocations_ += static_cast<uint32_t>(structural.size());
  std::vector<Guid> chains;
  for (Guid id : structural) detach(doc, id, chains);
  std::unordered_set<Guid, GuidHash> placed;
  for (Guid id : structural) {
    if (placed.count(id)) continue;  // built already as part of an ancestor attached this sync, from the same document
    attach(doc, id, placed, chains);
  }
  rebound(doc, chains);
  // The other changed nodes' subtrees and their ancestors get their bounds again, children before parents.
  marks_.assign(nodes_.size(), 0);
  bool any = false;
  for (const Document::ChangeRecord& c : changes_) {
    if (c.structural) continue;
    auto it = index_.find(c.id);
    if (it == index_.end()) continue;
    uint32_t i = it->second;
    if (marks_[i] == 2) continue;
    notePatterns(c.id, nodes_[i].node);
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
  damagePatternUsers(doc);
  version_ = doc.version();
  return false;
}

bool RenderTree::consistent(const Document& doc) const {
  RenderTree fresh;
  fresh.ink_ = ink_;
  fresh.page_ = page_;
  fresh.build(doc);
  if (fresh.nodes_.size() != nodes_.size() || fresh.index_.size() != index_.size()) return false;
  auto near = [](const Rect& a, const Rect& b) {
    return std::fabs(a.x - b.x) < 1e-6 && std::fabs(a.y - b.y) < 1e-6 && std::fabs(a.w - b.w) < 1e-6 && std::fabs(a.h - b.h) < 1e-6;
  };
  for (size_t i = 0; i < nodes_.size(); i++) {
    const RenderNode& a = nodes_[i];
    const RenderNode& b = fresh.nodes_[i];
    if (a.id != b.id || a.end != b.end || a.parent != b.parent || a.hasChildren != b.hasChildren || a.node != b.node || !near(a.visual, b.visual))
      return false;
    auto it = index_.find(a.id);
    if (it == index_.end() || it->second != i) return false;
  }
  return true;
}

}  // namespace eng
