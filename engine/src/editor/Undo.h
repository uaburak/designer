// Undo/redo: transaction-batched inverse patches, one batch per user gesture
// (a drag is one step however many moves it made). Undoing a batch applies its
// inverses in reverse order and records the redo batch from what that returns.
//
// One stack per actor (docs/engine.md §9.5): the local user's, each agent turn's — and, with multiplayer, each
// session's. A step of one actor never takes back another's: when an actor commits, every other stack yields the
// fields it wrote (yield()), so their undo and redo skip them — Figma's rule, per property, last writer wins.
#pragma once

#include <unordered_map>
#include <unordered_set>
#include <deque>
#include <vector>

#include <string>

#include "scene/ChangeSet.h"
#include "scene/Document.h"

namespace eng {

struct UndoBatch {
  std::string label;
  std::deque<NodeChange> inverse;  // in the order they were recorded; applied backwards (a deque: never relocated)
  std::vector<Guid> selectionBefore;
  std::vector<Guid> selectionAfter;
  // The pages its changes were on when it was made, first first (Figma's Message.undoBatchPageIds 46): an undo with
  // nothing selected goes to the first of them. Empty: computed from the replayed changes.
  std::vector<Guid> pageIds;
};

// What one undo / redo replay did, beyond the changes it applied (docs/engine.md §9.3).
struct ReplayInfo {
  // Per applied change (same order): the node's parent before it was applied (layout marks the parent it left).
  std::vector<Guid> parentsBefore;
  // Something the user can see changed: a value that differed on a layer shown on its page, a layer created or
  // removed, or a Layers-panel field (name, visibility, lock, place in the tree) of any layer; a hidden layer inside a
  // main component or on the internal canvas counts as shown (instances, styles and variables carry it). A replay without it
  // has "no visible effect" (Figma skips such batches within the same ⌘Z).
  bool visible = false;
  // Inverses the dangling-reference filter dropped or cut down (their node or the parent they'd put it under is gone).
  size_t dangling = 0;
  // The opposite batch went onto the other stack (a replay that applied nothing leaves nothing to redo).
  bool pushed = false;
};

class UndoStack {
 public:
  // Opens a transaction (nested begin() calls join the outer one).
  void begin(const std::vector<Guid>& selection, const std::string& label = {});
  // Records the inverse of a change applied inside the transaction. Successive
  // CHANGED inverses of one node fold into the first (its oldest values win).
  void record(const NodeChange& inverse);
  void record(NodeChange&& inverse);
  // Closes the transaction; a non-empty one becomes an undo step and clears redo.
  // `mergeWithLast` joins it to the previous step instead (key-repeat nudges).
  // Past kMaxBatches the oldest steps are dropped. `doc` (the document after the step): the step's pages are noted
  // (UndoBatch::pageIds).
  void commit(const std::vector<Guid>& selection, bool mergeWithLast = false, const Document* doc = nullptr);
  // The pages a batch's inverses touch in `doc` as it is (pages on the internal canvas left out), first first.
  static std::vector<Guid> pagesOf(const Document& doc, const std::deque<NodeChange>& inverse);
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
  // Before applying, the dangling-reference filter drops the inverses whose node is gone (and the parent moves into
  // a parent that is gone), so nothing is left parked outside the tree. `info` (if given) says what the replay did.
  std::vector<NodeChange> undo(Document& doc, std::vector<Guid>& selection, ChangeSet* changes = nullptr, ReplayInfo* info = nullptr);
  std::vector<NodeChange> redo(Document& doc, std::vector<Guid>& selection, ChangeSet* changes = nullptr, ReplayInfo* info = nullptr);
  // The system writes an undo (redo) made after its replay — layout, groups, bindings — join the batch it just put on
  // the redo (undo) stack, as their inverses: applied before the batch's own (oldest values win). `redoSide`: the
  // redo stack's top (after an undo). Nothing happens when that stack is empty.
  void extendTop(bool redoSide, std::vector<NodeChange>&& inverses);
  const std::string& undoLabel() const;
  const std::string& redoLabel() const;
  void clear();
  // Forgets the last undo step (one whose net effect is nothing: a text created and left empty).
  void dropLast() {
    if (!undo_.empty()) undo_.pop_back();
  }

  // Another actor committed `by`: the fields it wrote leave this stack's steps (undo and redo), so taking them back
  // never overwrites the newer values; a node it created or removed leaves them whole. Returns how many of this
  // stack's node changes lost fields. Steps left empty stay (dropEmpty() takes them off the top when undoing).
  size_t yield(const ChangeSet& by);
  // Takes off the undo (redo) stack's top steps that yield() emptied.
  void dropEmpty(bool redo);
  // Nodes whose changes in this stack were overwritten by another actor since (yield()).
  const std::unordered_set<Guid, GuidHash>& overwritten() const { return overwritten_; }
  bool empty() const { return undo_.empty() && redo_.empty() && depth_ == 0; }

  size_t undoCount() const { return undo_.size(); }
  size_t redoCount() const { return redo_.size(); }
  // The steps, oldest first (an export of the history, docs/research/rea/canvas.md §2.18).
  const std::vector<UndoBatch>& undoBatches() const { return undo_; }
  const std::vector<UndoBatch>& redoBatches() const { return redo_; }
  // Replaces the history with `undo` / `redo` (oldest first; an import of an exported one). Not while a
  // transaction is open.
  bool restore(std::vector<UndoBatch>&& undo, std::vector<UndoBatch>&& redo);

 private:
  static std::vector<NodeChange> replay(Document& doc, UndoBatch& batch, UndoBatch& opposite, ChangeSet* changes, ReplayInfo* info);

  std::vector<UndoBatch> undo_, redo_;
  UndoBatch open_;
  std::unordered_map<Guid, size_t, GuidHash> foldable_;  // node → its CHANGED inverse in open_
  int depth_ = 0;
  std::unordered_set<Guid, GuidHash> overwritten_;
};

}  // namespace eng
