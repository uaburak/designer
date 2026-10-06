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

}  // namespace eng
