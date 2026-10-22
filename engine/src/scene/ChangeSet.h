// What a transaction touched, turned into its one forward Message at commit
// (docs/engine.md §9.1): one NodeChange per touched node carrying only its
// changed fields; creations with every field; removals as phase REMOVED.
#pragma once

#include <set>
#include <string>
#include <unordered_map>
#include <vector>

#include "scene/Document.h"

namespace eng {

class ChangeSet {
 public:
  // Call before applying `change` to `doc`.
  void touch(const Document& doc, const NodeChange& change);
  bool empty() const { return order_.empty(); }
  void clear();
  // The forward changes, in first-touch order, against the document as it is now.
  std::vector<NodeChange> build(const Document& doc) const;
  // Every touched node with the union of its touched fields (for NODES_CHANGED).
  const std::vector<Guid>& touched() const { return order_; }
  // The fields touched on `id` (every field when it was created or removed; 0: untouched).
  FieldMask fieldsOf(Guid id) const {
    auto it = entries_.find(id);
    return it == entries_.end() ? 0 : it->second.mask;
  }

 private:
  struct Entry {
    bool existedBefore = false;
    FieldMask mask = 0;
    // The unmodelled fields (NodeProps::extra keys) written or removed: one gone by the end of the transaction is
    // carried as a removal (an empty value: clearedFields in kiwi, null in JSON) — the node no longer holds it, so
    // copying the node's `extra` alone would lose the clear (2026-10-22: Remove link, Remove flow starting point…).
    std::set<std::string> extraKeys;
  };
  std::vector<Guid> order_;
  std::unordered_map<Guid, Entry, GuidHash> entries_;
};

}  // namespace eng
