#include "editor/Undo.h"

namespace eng {

void UndoStack::begin(const std::vector<Guid>& selection, const std::string& label) {
  if (depth_++ == 0) {
    open_ = UndoBatch{};
    open_.label = label;
    open_.selectionBefore = selection;
    foldable_.clear();
  }
}

void UndoStack::record(const NodeChange& inverse) { record(NodeChange(inverse)); }

void UndoStack::record(NodeChange&& inverse) {
  if (depth_ == 0) return;
  if (inverse.phase == Phase::CHANGED) {
    auto it = foldable_.find(inverse.guid);
    if (it != foldable_.end()) {
      NodeChange& earlier = open_.inverse[it->second];
      FieldMask fresh = inverse.mask & ~earlier.mask;  // fields the earlier inverse doesn't hold yet
      copyFields(earlier.props, inverse.props, fresh);
      if ((inverse.mask & earlier.mask & F_EXTRA))
        for (auto& [k, v] : inverse.props.extra) earlier.props.extra.emplace(k, v);  // the oldest value of each key wins
      earlier.mask |= fresh;
      return;
    }
    foldable_[inverse.guid] = open_.inverse.size();
  } else {
    // Created or removed in between: later changes can't fold across it.
    foldable_.erase(inverse.guid);
  }
  open_.inverse.push_back(std::move(inverse));
}

const NodeChange* UndoStack::openInverse(Guid id) const {
  if (depth_ == 0) return nullptr;
  auto it = foldable_.find(id);
  if (it == foldable_.end()) return nullptr;
  const NodeChange& c = open_.inverse[it->second];
  return c.phase == Phase::CHANGED ? &c : nullptr;
}

void UndoStack::commit(const std::vector<Guid>& selection, bool mergeWithLast) {
  if (depth_ == 0 || --depth_ > 0) return;
  foldable_.clear();
  if (open_.inverse.empty()) return;
  open_.selectionAfter = selection;
  if (mergeWithLast && !undo_.empty()) {
    UndoBatch& last = undo_.back();
    for (auto& c : open_.inverse) last.inverse.push_back(std::move(c));
    last.selectionAfter = selection;
  } else {
    undo_.push_back(std::move(open_));
    if (undo_.size() > kMaxBatches) undo_.erase(undo_.begin());
  }
  open_ = UndoBatch{};
  redo_.clear();
}

std::vector<NodeChange> UndoStack::rollback(Document& doc) {
  std::vector<NodeChange> applied;
  if (depth_ == 0) return applied;
  depth_ = 0;
  foldable_.clear();
  for (auto it = open_.inverse.rbegin(); it != open_.inverse.rend(); ++it)
    if (doc.apply(*it)) applied.push_back(*it);
  open_ = UndoBatch{};
  return applied;
}

std::vector<NodeChange> UndoStack::replay(Document& doc, const UndoBatch& batch, UndoBatch& opposite, ChangeSet* changes) {
  std::vector<NodeChange> applied;
  opposite.label = batch.label;
  opposite.selectionBefore = batch.selectionAfter;
  opposite.selectionAfter = batch.selectionBefore;
  for (auto it = batch.inverse.rbegin(); it != batch.inverse.rend(); ++it) {
    NodeChange back;
    if (changes) changes->touch(doc, *it);
    if (!doc.apply(*it, &back)) continue;
    applied.push_back(*it);
    opposite.inverse.push_back(std::move(back));
  }
  return applied;
}

const std::string& UndoStack::undoLabel() const {
  static const std::string none;
  return undo_.empty() ? none : undo_.back().label;
}

const std::string& UndoStack::redoLabel() const {
  static const std::string none;
  return redo_.empty() ? none : redo_.back().label;
}

std::vector<NodeChange> UndoStack::undo(Document& doc, std::vector<Guid>& selection, ChangeSet* changes) {
  if (undo_.empty() || depth_ > 0) return {};
  UndoBatch batch = std::move(undo_.back());
  undo_.pop_back();
  UndoBatch opposite;
  auto applied = replay(doc, batch, opposite, changes);
  selection = batch.selectionBefore;
  redo_.push_back(std::move(opposite));
  return applied;
}

std::vector<NodeChange> UndoStack::redo(Document& doc, std::vector<Guid>& selection, ChangeSet* changes) {
  if (redo_.empty() || depth_ > 0) return {};
  UndoBatch batch = std::move(redo_.back());
  redo_.pop_back();
  UndoBatch opposite;
  auto applied = replay(doc, batch, opposite, changes);
  selection = batch.selectionBefore;
  undo_.push_back(std::move(opposite));
  return applied;
}

void UndoStack::clear() {
  undo_.clear();
  redo_.clear();
  open_ = UndoBatch{};
  foldable_.clear();
  depth_ = 0;
}

}  // namespace eng
