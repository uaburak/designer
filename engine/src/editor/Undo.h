// Undo/redo: transaction-batched inverse patches, one batch per user gesture
// (a drag is one step however many moves it made). Undoing a batch applies its
// inverses in reverse order and records the redo batch from what that returns.
#pragma once

#include <unordered_map>
#include <vector>

#include <string>

#include "scene/ChangeSet.h"
#include "scene/Document.h"

namespace eng {

struct UndoBatch {
  std::string label;
  std::vector<NodeChange> inverse;  // in the order they were recorded; applied backwards
  std::vector<Guid> selectionBefore;
  std::vector<Guid> selectionAfter;
};

class UndoStack {
 public:
  // Opens a transaction (nested begin() calls join the outer one).
  void begin(const std::vector<Guid>& selection, const std::string& label = {});
  // Records the inverse of a change applied inside the transaction. Successive
  // CHANGED inverses of one node fold into the first (its oldest values win).
  void record(const NodeChange& inverse);
  // Closes the transaction; a non-empty one becomes an undo step and clears redo.
  // `mergeWithLast` joins it to the previous step instead (key-repeat nudges).
  // Past kMaxBatches the oldest steps are dropped.
  void commit(const std::vector<Guid>& selection, bool mergeWithLast = false);
  static constexpr size_t kMaxBatches = 1000;
  // Drops the open transaction, applying its inverses to `doc` (a cancelled gesture).
  // Returns the changes that were applied (for listeners).
  std::vector<NodeChange> rollback(Document& doc);
  bool inTransaction() const { return depth_ > 0; }
  // The open transaction's folded CHANGED inverse of `id` — the values its
  // fields had when the transaction first wrote them — or nullptr.
  const NodeChange* openInverse(Guid id) const;

  bool canUndo() const { return !undo_.empty(); }
  bool canRedo() const { return !redo_.empty(); }
  // Undo/redo one step on `doc`. Returns the changes applied (forward, for
  // listeners) and sets `selection` to what it was at that point.
  // `changes` (if given) is told about each change before it is applied.
  std::vector<NodeChange> undo(Document& doc, std::vector<Guid>& selection, ChangeSet* changes = nullptr);
  std::vector<NodeChange> redo(Document& doc, std::vector<Guid>& selection, ChangeSet* changes = nullptr);
  const std::string& undoLabel() const;
  const std::string& redoLabel() const;
  void clear();

  size_t undoCount() const { return undo_.size(); }
  size_t redoCount() const { return redo_.size(); }

 private:
  static std::vector<NodeChange> replay(Document& doc, const UndoBatch& batch, UndoBatch& opposite, ChangeSet* changes);

  std::vector<UndoBatch> undo_, redo_;
  UndoBatch open_;
  std::unordered_map<Guid, size_t, GuidHash> foldable_;  // node → its CHANGED inverse in open_
  int depth_ = 0;
};

}  // namespace eng
