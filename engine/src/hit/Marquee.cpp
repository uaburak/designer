#include "hit/Marquee.h"

#include <algorithm>
#include <unordered_set>

namespace eng {

std::vector<Guid> marqueeHits(const Document& doc, Guid page, const Rect& rect, Guid scope) {
  std::vector<Guid> out;
  auto usable = [&](Guid id) {
    const Node* n = doc.get(id);
    return n && n->props.visible && !n->props.locked;
  };
  if (scope != kNoGuid) {
    for (Guid c : doc.children(scope))
      if (usable(c) && rect.intersects(doc.worldBounds(c))) out.push_back(c);
    return out;
  }
  // The page's children that anything under the rect belongs to (from the spatial index).
  std::unordered_set<Guid, GuidHash> tops;
  doc.query(page, rect, [&](Guid id) {
    Guid top = id;
    for (Guid p = doc.parentOf(top); p != kNoGuid && p != page; p = doc.parentOf(p)) top = p;
    if (doc.parentOf(top) == page) tops.insert(top);
    return true;
  });
  std::vector<Guid> ordered(tops.begin(), tops.end());
  std::sort(ordered.begin(), ordered.end(), [&](Guid a, Guid b) { return doc.siblingIndex(a) < doc.siblingIndex(b); });
  // Only partly covered, a frame gives its touched children instead of itself (live Figma); a section is canvas, so a
  // frame in it partly covered gives its children too (round 8).
  auto take = [&](auto&& self, Guid c) -> void {
    if (!usable(c)) return;
    Rect b = doc.worldBounds(c);
    if (!rect.intersects(b)) return;
    const Node* n = doc.get(c);
    if (n->props.isFrameLike() && !rect.containsRect(b) && !doc.children(c).empty()) {
      bool section = n->props.type == NodeType::SECTION;
      for (Guid gc : doc.children(c)) {
        if (section) self(self, gc);
        else if (usable(gc) && rect.intersects(doc.worldBounds(gc))) out.push_back(gc);
      }
      return;
    }
    out.push_back(c);
  };
  for (Guid c : ordered) take(take, c);
  // A top-level frame taken whole: then only top-level layers (Figma doesn't mix levels in one marquee).
  bool wholeFrame = false;
  for (Guid id : out)
    if (doc.parentOf(id) == page && doc.get(id)->props.isFrameLike() && !doc.children(id).empty()) wholeFrame = true;
  if (wholeFrame) out.erase(std::remove_if(out.begin(), out.end(), [&](Guid id) { return doc.parentOf(id) != page; }), out.end());
  return out;
}

std::vector<Guid> marqueeDeepHits(const Document& doc, Guid page, const Rect& rect) {
  std::vector<Guid> out;
  std::unordered_set<Guid, GuidHash> containers;
  auto shows = [](const NodeProps& p) {
    for (auto& f : p.fillPaints)
      if (f.visible) return true;
    if (p.strokeWeight > 0)
      for (auto& s : p.strokePaints)
        if (s.visible) return true;
    return false;
  };
  doc.query(page, rect, [&](Guid id) {
    const Node* n = doc.get(id);
    if (!n || id.isDerived() || doc.pageOf(id) != page || n->props.type == NodeType::CANVAS) return true;
    bool leaf = n->props.type == NodeType::INSTANCE || doc.children(id).empty();
    // A nested frame with layers in it counts where it shows itself (a fill or a stroke, as a click hits it): it is
    // the deepest layer the rect touches when none of its layers is touched. Groups only through their layers;
    // top-level frames and sections stay canvas (the rect starts on them).
    if (!leaf) {
      const Node* parent = doc.get(n->props.parentIndex.guid);
      bool nested = parent && parent->props.type != NodeType::CANVAS && parent->props.type != NodeType::SECTION;
      if (!nested || !n->props.isFrameLike() || n->props.fitsChildren() || n->props.type == NodeType::SECTION || !shows(n->props))
        return true;
      containers.insert(id);
    }
    Rect b = doc.worldBounds(id);
    if (!rect.intersects(b)) return true;
    // Up to the page: nothing hidden, locked or an instance (its sublayers are its own); clipping frames cut it.
    for (Guid cur = id; cur != kNoGuid && cur != page; cur = doc.parentOf(cur)) {
      const Node* c = doc.get(cur);
      if (!c || !c->props.visible || c->props.locked) return true;
      if (cur != id && c->props.type == NodeType::INSTANCE) return true;
      if (cur != id && c->props.clipsContent()) {
        Rect clip = doc.worldBounds(cur);
        double x0 = std::max(b.x, clip.x), y0 = std::max(b.y, clip.y), x1 = std::min(b.right(), clip.right()), y1 = std::min(b.bottom(), clip.bottom());
        if (x1 < x0 || y1 < y0) return true;
        b = {x0, y0, x1 - x0, y1 - y0};
        if (!rect.intersects(b)) return true;
      }
    }
    out.push_back(id);
    return true;
  });
  std::sort(out.begin(), out.end(), [&](Guid a, Guid b) { return doc.paintsBefore(a, b); });
  out.erase(std::unique(out.begin(), out.end()), out.end());
  // The deepest only: a frame drops out when anything in it is taken.
  if (!containers.empty()) {
    std::unordered_set<Guid, GuidHash> above;
    for (Guid id : out)
      for (Guid p = doc.parentOf(id); p != kNoGuid && p != page && above.insert(p).second;) p = doc.parentOf(p);
    out.erase(std::remove_if(out.begin(), out.end(), [&](Guid id) { return containers.count(id) && above.count(id); }), out.end());
  }
  return out;
}

}  // namespace eng
