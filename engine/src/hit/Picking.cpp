#include "hit/Picking.h"

#include <unordered_set>

namespace eng {

Guid pick(const Document& doc, const std::vector<Guid>& path, const std::vector<Guid>& selection, bool deep) {
  if (path.empty()) return kNoGuid;
  if (deep) return path.back();
  std::unordered_set<Guid, GuidHash> open;
  for (Guid s : selection) {
    Guid cur = s;
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
  // An instance is picked whole until it is opened (double-click, Enter, ⌘-click), as Figma.
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
