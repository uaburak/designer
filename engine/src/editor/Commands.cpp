// Editor commands (docs/engine.md §10.6): selection, delete, nudge, order,
// lock/visibility, zoom. The round-2 commands (group, frame selection,
// duplicate, flip, align, distribute, auto layout, pages) have their ids but
// answer E_UNSUPPORTED until implemented (docs/engine-build.md, "Status at handoff").

#include <algorithm>
#include <optional>

#include "base/FractionalIndex.h"
#include "editor/Editor.h"

namespace eng {

Status Editor::command(CommandId id, double dx, double dy) {
  CommandArgs args;
  args.dx = dx;
  args.dy = dy;
  return command(id, args);
}

Status Editor::command(CommandId id, const CommandArgs& args) {
  if (busy() && id != CommandId::ZOOM_IN && id != CommandId::ZOOM_OUT) return E_BUSY;
  switch (id) {
    case CommandId::UNDO: undoStep(false); return OK;
    case CommandId::REDO: undoStep(true); return OK;
    case CommandId::SELECT_ALL: selectAll(); return OK;
    case CommandId::SELECT_NONE: changeSelection({}); return OK;
    case CommandId::SELECT_CHILDREN: selectRelative(0); return OK;
    case CommandId::SELECT_PARENT: selectRelative(1); return OK;
    case CommandId::SELECT_NEXT_SIBLING: selectRelative(2); return OK;
    case CommandId::SELECT_PREV_SIBLING: selectRelative(3); return OK;
    case CommandId::DELETE: deleteSelection(); return OK;
    case CommandId::NUDGE: nudge(args.dx, args.dy, false); return OK;
    case CommandId::BRING_FORWARD: reorder(1); return OK;
    case CommandId::SEND_BACKWARD: reorder(-1); return OK;
    case CommandId::BRING_TO_FRONT: reorder(2); return OK;
    case CommandId::SEND_TO_BACK: reorder(-2); return OK;
    case CommandId::TOGGLE_LOCK: toggle(F_LOCKED); return OK;
    case CommandId::TOGGLE_VISIBLE: toggle(F_VISIBLE); return OK;
    case CommandId::ZOOM_IN: zoomTo(camera_.zoom * 2); return OK;
    case CommandId::ZOOM_OUT: zoomTo(camera_.zoom / 2); return OK;
    case CommandId::ZOOM_TO_100: zoomTo(1); return OK;
    case CommandId::ZOOM_TO_FIT: zoomToFit(); return OK;
    case CommandId::ZOOM_TO_SELECTION: zoomToSelection(); return OK;
    // Round 2, not implemented yet.
    case CommandId::GROUP:
    case CommandId::UNGROUP:
    case CommandId::FRAME_SELECTION:
    case CommandId::DUPLICATE:
    case CommandId::FLIP_HORIZONTAL:
    case CommandId::FLIP_VERTICAL:
    case CommandId::ALIGN_LEFT:
    case CommandId::ALIGN_HORIZONTAL_CENTER:
    case CommandId::ALIGN_RIGHT:
    case CommandId::ALIGN_TOP:
    case CommandId::ALIGN_VERTICAL_CENTER:
    case CommandId::ALIGN_BOTTOM:
    case CommandId::DISTRIBUTE_HORIZONTAL:
    case CommandId::DISTRIBUTE_VERTICAL:
    case CommandId::ADD_AUTO_LAYOUT:
    case CommandId::REMOVE_AUTO_LAYOUT:
    case CommandId::CREATE_PAGE:
    case CommandId::DELETE_PAGE:
    case CommandId::DUPLICATE_PAGE: return E_UNSUPPORTED;
  }
  return E_UNSUPPORTED;
}

uint32_t Editor::commandState(CommandId id) const {
  bool any = !selection_.empty();
  switch (id) {
    case CommandId::UNDO: return undo_.canUndo() ? CMD_ENABLED : 0;
    case CommandId::REDO: return undo_.canRedo() ? CMD_ENABLED : 0;
    case CommandId::SELECT_ALL:
    case CommandId::ZOOM_IN:
    case CommandId::ZOOM_OUT:
    case CommandId::ZOOM_TO_100:
    case CommandId::ZOOM_TO_FIT: return CMD_ENABLED;
    case CommandId::TOGGLE_LOCK:
    case CommandId::TOGGLE_VISIBLE: {
      if (!any) return 0;
      const Node* n = doc_.get(selection_[0]);
      bool on = n && (id == CommandId::TOGGLE_LOCK ? n->props.locked : !n->props.visible);
      return CMD_ENABLED | (on ? CMD_CHECKED : 0);
    }
    case CommandId::GROUP:
    case CommandId::UNGROUP:
    case CommandId::FRAME_SELECTION:
    case CommandId::DUPLICATE:
    case CommandId::FLIP_HORIZONTAL:
    case CommandId::FLIP_VERTICAL:
    case CommandId::ALIGN_LEFT:
    case CommandId::ALIGN_HORIZONTAL_CENTER:
    case CommandId::ALIGN_RIGHT:
    case CommandId::ALIGN_TOP:
    case CommandId::ALIGN_VERTICAL_CENTER:
    case CommandId::ALIGN_BOTTOM:
    case CommandId::DISTRIBUTE_HORIZONTAL:
    case CommandId::DISTRIBUTE_VERTICAL:
    case CommandId::ADD_AUTO_LAYOUT:
    case CommandId::REMOVE_AUTO_LAYOUT:
    case CommandId::CREATE_PAGE:
    case CommandId::DELETE_PAGE:
    case CommandId::DUPLICATE_PAGE: return 0;  // not implemented yet
    default: return any ? CMD_ENABLED : 0;
  }
}

void Editor::deleteSelection() {
  auto top = topLevelSelection(doc_, selection_);
  if (top.empty()) return;
  begin(TxnKind::USER, "Delete");
  // Children before their parent (removals children-first; undo recreates parents first).
  std::vector<Guid> order;
  auto collect = [&](auto&& self, Guid id) -> void {
    std::vector<Guid> kids = doc_.children(id);
    for (Guid c : kids) self(self, c);
    order.push_back(id);
  };
  for (Guid id : top) collect(collect, id);
  for (Guid id : order) write(NodeChange::removed(id));
  changeSelection({});
  commit();
}

void Editor::nudge(double dx, double dy, bool repeat) {
  auto top = topLevelSelection(doc_, selection_);
  if (top.empty()) return;
  bool merge = repeat && lastNudged_ == selection_ && undo_.canUndo() && undo_.undoLabel() == "Nudge";
  begin(TxnKind::USER, "Nudge");
  for (Guid id : top) {
    const Node* n = doc_.get(id);
    if (!n || n->props.locked) continue;
    Vec2 dp = doc_.worldTransform(doc_.parentOf(id)).inverse().applyLinear({dx, dy});
    NodeChange c = NodeChange::changed(id);
    c.mask = F_TRANSFORM;
    c.props.transform = n->props.transform;
    c.props.transform.m02 += dp.x;
    c.props.transform.m12 += dp.y;
    write(c);
  }
  commit(merge);
  lastNudged_ = selection_;
}

std::string Editor::placeAt(Guid parent, size_t index, Guid moving) {
  auto siblingsOf = [&] {
    std::vector<Guid> s = doc_.children(parent);
    s.erase(std::remove(s.begin(), s.end(), moving), s.end());
    return s;
  };
  auto keyAt = [&](const std::vector<Guid>& s) {
    size_t i = std::min(index, s.size());
    std::string lo = i > 0 ? doc_.get(s[i - 1])->props.parentIndex.position : std::string();
    std::optional<std::string> hi;
    if (i < s.size()) hi = doc_.get(s[i])->props.parentIndex.position;
    fractional::Bias bias = !hi ? fractional::Bias::Low : lo.empty() ? fractional::Bias::High : fractional::Bias::Mid;
    return fractional::keyBetween(lo, hi ? std::optional<std::string_view>(*hi) : std::nullopt, bias);
  };
  std::vector<Guid> siblings = siblingsOf();
  std::string key = keyAt(siblings);
  if (!key.empty() && key.size() <= fractional::kMaxKeyLength) return key;
  // Too long (or tied keys): respace the siblings, order unchanged, in this transaction (docs/schema.md §10.3).
  auto keys = fractional::rebalancedKeys(static_cast<int>(siblings.size()));
  for (size_t i = 0; i < siblings.size(); i++) {
    NodeChange c = NodeChange::changed(siblings[i]);
    c.mask = F_PARENT_INDEX;
    c.props.parentIndex = {parent, keys[i]};
    write(c);
  }
  return keyAt(siblingsOf());
}

void Editor::reorder(int direction) {
  auto top = topLevelSelection(doc_, selection_);
  if (top.empty()) return;
  begin(TxnKind::USER, direction > 1 ? "Bring to front" : direction > 0 ? "Bring forward" : direction < -1 ? "Send to back" : "Send backward");
  // Front-most first when moving forward, back-most first when moving back, so selected siblings keep their order.
  auto indexOf = [&](Guid id) {
    const auto& kids = doc_.children(doc_.parentOf(id));
    return std::find(kids.begin(), kids.end(), id) - kids.begin();
  };
  std::sort(top.begin(), top.end(), [&](Guid a, Guid b) { return direction > 0 ? indexOf(a) > indexOf(b) : indexOf(a) < indexOf(b); });
  for (Guid id : top) {
    Guid parent = doc_.parentOf(id);
    std::vector<Guid> kids = doc_.children(parent);
    size_t i = static_cast<size_t>(std::find(kids.begin(), kids.end(), id) - kids.begin());
    size_t n = kids.size();
    size_t target;  // the index among the siblings without this node
    if (direction == 2) {
      if (i == n - 1) continue;
      target = n - 1;
    } else if (direction == -2) {
      if (i == 0) continue;
      target = 0;
    } else if (direction == 1) {
      if (i == n - 1 || selected(kids[i + 1])) continue;
      target = i + 1;
    } else {
      if (i == 0 || selected(kids[i - 1])) continue;
      target = i - 1;
    }
    std::string p = placeAt(parent, target, id);
    if (p.empty()) continue;
    NodeChange c = NodeChange::changed(id);
    c.mask = F_PARENT_INDEX;
    c.props.parentIndex = {parent, p};
    write(c);
  }
  commit();
}

void Editor::toggle(FieldMask field) {
  if (selection_.empty()) return;
  const Node* first = doc_.get(selection_[0]);
  if (!first) return;
  bool value = field == F_LOCKED ? !first->props.locked : !first->props.visible;
  begin(TxnKind::USER, field == F_LOCKED ? "Lock" : "Show/Hide");
  for (Guid id : selection_) {
    NodeChange c = NodeChange::changed(id);
    c.mask = field;
    c.props.locked = value;
    c.props.visible = value;
    write(c);
  }
  commit();
}

void Editor::selectAll() {
  // With a selection: everything beside it (its parent's children); otherwise the page's.
  Guid parent = page_;
  if (!selection_.empty()) {
    Guid p = doc_.parentOf(selection_[0]);
    bool same = true;
    for (Guid id : selection_) same &= doc_.parentOf(id) == p;
    if (same && p != kNoGuid) parent = p;
  }
  std::vector<Guid> all;
  for (Guid c : doc_.children(parent)) {
    const Node* n = doc_.get(c);
    if (n && n->props.visible && !n->props.locked) all.push_back(c);
  }
  changeSelection(std::move(all));
}

void Editor::selectRelative(int which) {
  if (selection_.empty()) return;
  std::vector<Guid> next;
  auto add = [&](Guid id) {
    if (std::find(next.begin(), next.end(), id) == next.end()) next.push_back(id);
  };
  for (Guid id : selection_) {
    Guid parent = doc_.parentOf(id);
    const auto& siblings = doc_.children(parent);
    long i = std::find(siblings.begin(), siblings.end(), id) - siblings.begin();
    long n = static_cast<long>(siblings.size());
    switch (which) {
      case 0:  // Enter: all children (Figma)
        for (Guid c : doc_.children(id)) add(c);
        if (doc_.children(id).empty()) add(id);
        break;
      case 1: {  // ⇧Enter: the parent (not the page)
        const Node* p = doc_.get(parent);
        add(p && p->props.type != NodeType::CANVAS ? parent : id);
        break;
      }
      case 2: add(siblings[static_cast<size_t>((i + n - 1) % n)]); break;  // Tab: the next layer down in the Layers list
      case 3: add(siblings[static_cast<size_t>((i + 1) % n)]); break;      // ⇧Tab: the one above
    }
  }
  changeSelection(std::move(next));
}

}  // namespace eng
