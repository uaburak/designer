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
  const Node* top = doc.get(path[0]);
  // An instance is picked whole until it is opened (double-click, Enter, ⌘-click), as Figma.
  if (top && top->props.isFrameLike() && top->props.type != NodeType::INSTANCE && path.size() > 1) {
    return path[1];
  }
  return path[0];
}

}  // namespace eng
