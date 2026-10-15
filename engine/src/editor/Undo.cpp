#include "editor/Undo.h"

#include <unordered_set>

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

namespace {

// Fields the Layers panel shows: a change to them is seen even on a hidden layer.
constexpr FieldMask kPanelFields = F_NAME | F_VISIBLE | F_LOCKED | F_PARENT_INDEX;

// Would applying `c` now change something the user sees (docs/engine.md §9.3)? A creation or a removal always does;
// a change does when one of its values differs and the layer is shown on its page (it and its ancestors visible),
// or when it touches a Layers-panel field.
bool visibleEffect(const Document& doc, const NodeChange& c) {
  if (c.phase != Phase::CHANGED) return true;
  const Node* n = doc.get(c.guid);
  if (!n) return false;
  FieldMask diff = differingFields(n->props, c.props, c.mask);
  if (!diff) return false;
  if (diff & kPanelFields) return true;
  if (doc.visibleInTree(c.guid)) return true;
  // A hidden layer can still show elsewhere: inside a main component (its instances may show the layer — a boolean
  // property's usual shape), and on the internal canvas (styles, variables, library mains: read by layers on pages).
  // A layer on no page is counted too: nothing proves it unseen.
  Guid cur = c.guid;
  for (int guard = 0; guard < 100000; guard++) {
    const Node* a = doc.get(cur);
    if (!a) return true;
    if (a->props.type == NodeType::SYMBOL) return true;
    if (a->props.type == NodeType::CANVAS) return a->props.rare().internalOnly;
    if (a->props.type == NodeType::DOCUMENT) return true;
    cur = a->props.parentIndex.guid;
  }
  return true;
}

// Figma's dangling-reference filter: a CHANGED (REMOVED) inverse of a node that is gone and not re-created by the
// batch is dropped, a creation under a parent that is gone is dropped, and a move back into a parent that is gone
// keeps its other fields (the transform was in that parent's space: it goes too). Until nothing more drops (a
// creation dropped can leave its children's creations dangling). Returns how many inverses it dropped or cut down.
size_t filterDangling(const Document& doc, std::deque<NodeChange>& list) {
  size_t count = 0;
  for (bool again = true; again;) {
    again = false;
    std::unordered_set<Guid, GuidHash> created;
    for (const NodeChange& c : list)
      if (c.phase == Phase::CREATED) created.insert(c.guid);
    auto lives = [&](Guid g) { return doc.has(g) || created.count(g) != 0; };
    for (auto it = list.begin(); it != list.end();) {
      NodeChange& c = *it;
      bool drop = false;
      if (c.phase == Phase::CREATED) {
        drop = c.props.parentIndex.guid != kNoGuid && !lives(c.props.parentIndex.guid);
      } else if (!lives(c.guid)) {
        drop = true;
      } else if (c.phase == Phase::CHANGED && (c.mask & F_PARENT_INDEX) && c.props.parentIndex.guid != kNoGuid &&
                 !lives(c.props.parentIndex.guid)) {
        c.mask &= ~static_cast<FieldMask>(F_PARENT_INDEX | F_TRANSFORM);
        drop = !c.mask;
        if (!drop) count++;
      }
      if (drop) {
        if (c.phase == Phase::CREATED) again = true;
        it = list.erase(it);
        count++;
        continue;
      }
      ++it;
    }
  }
  return count;
}

}  // namespace

std::vector<NodeChange> UndoStack::replay(Document& doc, UndoBatch& batch, UndoBatch& opposite, ChangeSet* changes, ReplayInfo* info) {
  std::vector<NodeChange> applied;
  opposite.label = batch.label;
  opposite.selectionBefore = batch.selectionAfter;
  opposite.selectionAfter = batch.selectionBefore;
  size_t dangling = filterDangling(doc, batch.inverse);
  if (info) info->dangling += dangling;
  for (auto it = batch.inverse.rbegin(); it != batch.inverse.rend(); ++it) {
    NodeChange back;
    bool visible = info && !info->visible && visibleEffect(doc, *it);
    Guid parentBefore = kNoGuid;
    if (info)
      if (const Node* n = doc.get(it->guid)) parentBefore = n->props.parentIndex.guid;
    if (changes) changes->touch(doc, *it);
    if (!doc.apply(*it, &back)) continue;
    if (info) {
      info->parentsBefore.push_back(parentBefore);
      if (visible) info->visible = true;
    }
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

std::vector<NodeChange> UndoStack::undo(Document& doc, std::vector<Guid>& selection, ChangeSet* changes, ReplayInfo* info) {
  if (undo_.empty() || depth_ > 0) return {};
  UndoBatch batch = std::move(undo_.back());
  undo_.pop_back();
  UndoBatch opposite;
  auto applied = replay(doc, batch, opposite, changes, info);
  selection = batch.selectionBefore;
  if (!opposite.inverse.empty()) {
    redo_.push_back(std::move(opposite));
    if (info) info->pushed = true;
  }
  return applied;
}

std::vector<NodeChange> UndoStack::redo(Document& doc, std::vector<Guid>& selection, ChangeSet* changes, ReplayInfo* info) {
  if (redo_.empty() || depth_ > 0) return {};
  UndoBatch batch = std::move(redo_.back());
  redo_.pop_back();
  UndoBatch opposite;
  auto applied = replay(doc, batch, opposite, changes, info);
  selection = batch.selectionBefore;
  if (!opposite.inverse.empty()) {
    undo_.push_back(std::move(opposite));
    if (info) info->pushed = true;
  }
  return applied;
}

void UndoStack::extendTop(bool redoSide, std::vector<NodeChange>&& inverses) {
  auto& stack = redoSide ? redo_ : undo_;
  if (stack.empty() || inverses.empty()) return;
  // Applied backwards: these (appended last) go first, so the batch's own values win where both hold a field.
  for (NodeChange& c : inverses) stack.back().inverse.push_back(std::move(c));
}

size_t UndoStack::yield(const ChangeSet& by) {
  size_t lost = 0;
  auto pass = [&](std::vector<UndoBatch>& stack) {
    for (UndoBatch& b : stack)
      for (auto it = b.inverse.begin(); it != b.inverse.end();) {
        if (it->phase == Phase::CHANGED) {
          FieldMask theirs = by.fieldsOf(it->guid);
          if (theirs & it->mask) {
            it->mask &= ~theirs;
            overwritten_.insert(it->guid);
            lost++;
            if (!it->mask) {
              it = b.inverse.erase(it);
              continue;
            }
          }
        }
        ++it;
      }
  };
  pass(undo_);
  pass(redo_);
  return lost;
}

void UndoStack::dropEmpty(bool redo) {
  auto& stack = redo ? redo_ : undo_;
  while (!stack.empty() && stack.back().inverse.empty()) stack.pop_back();
}

bool UndoStack::restore(std::vector<UndoBatch>&& undo, std::vector<UndoBatch>&& redo) {
  if (depth_ > 0) return false;
  undo_ = std::move(undo);
  redo_ = std::move(redo);
  if (undo_.size() > kMaxBatches) undo_.erase(undo_.begin(), undo_.end() - kMaxBatches);
  overwritten_.clear();
  return true;
}

void UndoStack::clear() {
  undo_.clear();
  redo_.clear();
  open_ = UndoBatch{};
  foldable_.clear();
  overwritten_.clear();
  depth_ = 0;
}

}  // namespace eng
