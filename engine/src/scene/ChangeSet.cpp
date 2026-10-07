#include "scene/ChangeSet.h"

namespace eng {

void ChangeSet::touch(const Document& doc, const NodeChange& change) {
  auto it = entries_.find(change.guid);
  if (it == entries_.end()) {
    it = entries_.emplace(change.guid, Entry{doc.has(change.guid), 0}).first;
    order_.push_back(change.guid);
  }
  it->second.mask |= change.phase == Phase::CHANGED ? change.mask : F_ALL;
}

void ChangeSet::clear() {
  order_.clear();
  entries_.clear();
}

std::vector<NodeChange> ChangeSet::build(const Document& doc) const {
  std::vector<NodeChange> out;
  for (Guid id : order_) {
    const Entry& e = entries_.at(id);
    const Node* now = doc.get(id);
    if (!e.existedBefore && now) {
      out.push_back(NodeChange::created(id, now->props));
    } else if (e.existedBefore && !now) {
      out.push_back(NodeChange::removed(id));
    } else if (e.existedBefore && now) {
      NodeChange c = NodeChange::changed(id);
      c.mask = e.mask;
      copyFields(c.props, now->props, c.mask);
      if (c.mask) out.push_back(std::move(c));
    }
  }
  return out;
}

}  // namespace eng
