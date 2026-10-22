#include "hit/Picking.h"

#include <unordered_set>

namespace eng {

Guid pick(const Document& doc, const std::vector<Guid>& path, const std::vector<Guid>& selection, bool deep, bool enter) {
  if (path.empty()) return kNoGuid;
  if (deep) return path.back();
  // "Open": what the selection's layers are in (their parents and up) — a click picks at the selection's depth, so a
  // sibling of a deep selection is picked directly (live Figma S1, S2) and a click inside a selected layer picks that
  // layer again (#3, #6, #8, #10: a single click never goes one level down). `enter` (a double-click) opens the
  // selected layers themselves too: one level down (K5, K6, K12).
  std::unordered_set<Guid, GuidHash> open;
  for (Guid s : selection) {
    Guid cur = enter ? s : doc.parentOf(s);
    for (int guard = 0; cur != kNoGuid && guard < 100000; guard++) {
      if (!open.insert(cur).second) break;
      cur = doc.parentOf(cur);
    }
  }
  for (size_t i = path.size() - 1; i >= 1; i--)
    if (open.count(path[i - 1])) return path[i];
  // Sections are canvas-level: what is in them picks as if it were on the page (a click on a section's own
  // background picks the innermost section).
  size_t k = topLevelIndex(doc, path);
  const Node* top = doc.get(path[k]);
  // A top-level frame's child is picked even when the frame is selected (#1, #9, K8–K10); an instance is picked whole
  // until it is opened (double-click, Enter, ⌘-click), as Figma.
  if (top && top->props.isFrameLike() && top->props.type != NodeType::INSTANCE && top->props.type != NodeType::SECTION &&
      path.size() > k + 1) {
    return path[k + 1];
  }
  return path[k];
}

size_t topLevelIndex(const Document& doc, const std::vector<Guid>& path) {
  size_t k = 0;
  while (k + 1 < path.size()) {
    const Node* n = doc.get(path[k]);
    if (!n || n->props.type != NodeType::SECTION) break;
    k++;
  }
  return k;
}

}  // namespace eng
