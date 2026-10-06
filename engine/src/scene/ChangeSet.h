// What a transaction touched, turned into its one forward Message at commit
// (docs/engine.md §9.1): one NodeChange per touched node carrying only its
// changed fields; creations with every field; removals as phase REMOVED.
#pragma once

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

 private:
  struct Entry {
    bool existedBefore = false;
    FieldMask mask = 0;
  };
  std::vector<Guid> order_;
  std::unordered_map<Guid, Entry, GuidHash> entries_;
};

}  // namespace eng
