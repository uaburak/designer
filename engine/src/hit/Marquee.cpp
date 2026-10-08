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
  for (Guid c : ordered) {
    if (!usable(c)) continue;
    Rect b = doc.worldBounds(c);
    if (!rect.intersects(b)) continue;
    const Node* n = doc.get(c);
    if (n->props.isFrameLike() && !rect.containsRect(b) && !doc.children(c).empty()) {
      // Only partly covered: the frame's touched children instead of the frame.
      for (Guid gc : doc.children(c))
        if (usable(gc) && rect.intersects(doc.worldBounds(gc))) out.push_back(gc);
      continue;
    }
    out.push_back(c);
  }
  return out;
}

std::vector<Guid> marqueeDeepHits(const Document& doc, Guid page, const Rect& rect) {
  std::vector<Guid> out;
  doc.query(page, rect, [&](Guid id) {
    const Node* n = doc.get(id);
    if (!n || id.isDerived() || doc.pageOf(id) != page) return true;
    bool leaf = n->props.type == NodeType::INSTANCE || doc.children(id).empty();
    if (!leaf || n->props.type == NodeType::CANVAS) return true;
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
  return out;
}

}  // namespace eng
