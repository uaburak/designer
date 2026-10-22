#include "scene/ChangeSet.h"

namespace eng {

void ChangeSet::touch(const Document& doc, const NodeChange& change) {
  auto it = entries_.find(change.guid);
  if (it == entries_.end()) {
    it = entries_.emplace(change.guid, Entry{doc.has(change.guid), 0, {}}).first;
    order_.push_back(change.guid);
  }
  Entry& e = it->second;
  if (change.phase == Phase::CHANGED) {
    e.mask |= change.mask;
    if (change.mask & F_EXTRA)
      for (auto& kv : change.props.extra) e.extraKeys.insert(kv.first);
    return;
  }
  // A removal or a full replace drops the live node's unmodelled fields: each may be gone at the end.
  if (const Node* before = doc.get(change.guid))
    for (auto& kv : before->props.extra) e.extraKeys.insert(kv.first);
  if (const Node* live = change.phase == Phase::CREATED ? doc.get(change.guid) : nullptr) {
    // CREATED for a live GUID is a full replace (docs/schema.md §4.2; Detach instance, a library copy replaced): the
    // forward change carries only the fields it really changes. F_ALL wrote every field with its value — defaults
    // too — so a detached frame stored `textData {characters: ""}` and the rest of a TEXT's defaults (2026-10-19).
    it->second.mask |= differingFields(live->props, change.props, F_ALL);
  } else {
    it->second.mask |= F_ALL;
  }
}

void ChangeSet::clear() {
  order_.clear();
  entries_.clear();
}

std::vector<NodeChange> ChangeSet::build(const Document& doc) const {
  std::vector<NodeChange> out;
  out.reserve(order_.size());
  for (Guid id : order_) {
    const Entry& e = entries_.at(id);
    const Node* now = doc.get(id);
    if (!e.existedBefore && now) {
      out.push_back(NodeChange::created(id, now->props));
    } else if (e.existedBefore && !now) {
      out.push_back(NodeChange::removed(id));
    } else if (e.existedBefore && now && e.mask) {
      NodeChange& c = out.emplace_back();  // in place: a NodeChange is large
      c.guid = id;
      c.mask = e.mask;
      copyFields(c.props, now->props, c.mask);
      // A cleared unmodelled field: an empty value, which the codecs write as a removal (docs/schema.md §4.2).
      for (const std::string& k : e.extraKeys)
        if (!now->props.extra.count(k)) {
          c.props.extra[k] = std::string();
          c.mask |= F_EXTRA;
        }
    }
  }
  return out;
}

}  // namespace eng
