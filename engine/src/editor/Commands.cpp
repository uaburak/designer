// Editor commands (docs/engine.md §10.6): selection, delete, nudge, order,
// lock/visibility, zoom, group / frame selection / ungroup, duplicate, flip,
// align, distribute, auto layout, pages; the Layers panel's moveNodes and the
// clipboard (copySelection / paste).

#include <algorithm>
#include <cmath>
#include <optional>
#include <unordered_map>

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
  if (text_.node != kNoGuid) {
    // Editing text: ⌘A selects its text, zooms keep the session, anything else ends it first.
    if (id == CommandId::SELECT_ALL) {
      setTextSelection(0, static_cast<uint32_t>(editedText().size()));
      return OK;
    }
    bool zoom = id == CommandId::ZOOM_IN || id == CommandId::ZOOM_OUT || id == CommandId::ZOOM_TO_100 ||
                id == CommandId::ZOOM_TO_FIT || id == CommandId::ZOOM_TO_SELECTION;
    if (!zoom) endTextEdit();
  }
  switch (id) {
    case CommandId::UNDO: undoStep(false); return OK;
    case CommandId::REDO: undoStep(true); return OK;
    case CommandId::SELECT_ALL: selectAll(); return OK;
    case CommandId::SELECT_NONE: changeSelection({}); return OK;
    case CommandId::SELECT_CHILDREN: selectRelative(0); return OK;
    case CommandId::SELECT_PARENT: selectRelative(1); return OK;
    case CommandId::SELECT_NEXT_SIBLING: selectRelative(2); return OK;
    case CommandId::SELECT_PREV_SIBLING: selectRelative(3); return OK;
    case CommandId::SELECT_INVERSE: selectInverse(); return OK;
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
    case CommandId::GROUP: wrapSelection("Group"); return OK;
    case CommandId::UNGROUP: ungroup(); return OK;
    case CommandId::FRAME_SELECTION: wrapSelection("Frame"); return OK;
    case CommandId::DUPLICATE: duplicate(); return OK;
    case CommandId::FLIP_HORIZONTAL: flip(true); return OK;
    case CommandId::FLIP_VERTICAL: flip(false); return OK;
    case CommandId::ALIGN_LEFT:
    case CommandId::ALIGN_HORIZONTAL_CENTER:
    case CommandId::ALIGN_RIGHT:
    case CommandId::ALIGN_TOP:
    case CommandId::ALIGN_VERTICAL_CENTER:
    case CommandId::ALIGN_BOTTOM: align(id); return OK;
    case CommandId::DISTRIBUTE_HORIZONTAL: distribute(true); return OK;
    case CommandId::DISTRIBUTE_VERTICAL: distribute(false); return OK;
    case CommandId::ADD_AUTO_LAYOUT: addAutoLayout(); return OK;
    case CommandId::REMOVE_AUTO_LAYOUT: removeAutoLayout(); return OK;
    case CommandId::CREATE_PAGE: return createPage() == kNoGuid ? E_INVALID : OK;
    case CommandId::DELETE_PAGE: return deletePage(args.page == kNoGuid ? page_ : args.page);
    case CommandId::DUPLICATE_PAGE: return duplicatePage(args.page == kNoGuid ? page_ : args.page) == kNoGuid ? E_NOT_FOUND : OK;
  }
  return E_UNSUPPORTED;
}

uint32_t Editor::commandState(CommandId id) const {
  bool any = !selection_.empty();
  switch (id) {
    case CommandId::UNDO: return undo_.canUndo() ? CMD_ENABLED : 0;
    case CommandId::REDO: return undo_.canRedo() ? CMD_ENABLED : 0;
    case CommandId::SELECT_ALL:
    case CommandId::SELECT_INVERSE:
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
    case CommandId::UNGROUP: {
      for (Guid id : selection_)
        if (canUngroup(id)) return CMD_ENABLED;
      return 0;
    }
    case CommandId::ALIGN_LEFT:
    case CommandId::ALIGN_HORIZONTAL_CENTER:
    case CommandId::ALIGN_RIGHT:
    case CommandId::ALIGN_TOP:
    case CommandId::ALIGN_VERTICAL_CENTER:
    case CommandId::ALIGN_BOTTOM: {
      auto movable = arrangeable();
      if (movable.size() >= 2) return CMD_ENABLED;
      if (movable.size() == 1) {
        const Node* p = doc_.get(doc_.parentOf(movable[0]));
        return p && p->props.type != NodeType::CANVAS ? CMD_ENABLED : 0;
      }
      return 0;
    }
    case CommandId::DISTRIBUTE_HORIZONTAL:
    case CommandId::DISTRIBUTE_VERTICAL: return arrangeable().size() >= 3 ? CMD_ENABLED : 0;
    case CommandId::REMOVE_AUTO_LAYOUT: {
      for (Guid id : selection_) {
        const Node* n = doc_.get(id);
        if (n && n->props.isAutoLayout()) return CMD_ENABLED;
      }
      return 0;
    }
    case CommandId::CREATE_PAGE: return doc_.has(documentNode()) ? CMD_ENABLED : 0;
    case CommandId::DELETE_PAGE: return pages().size() > 1 ? CMD_ENABLED : 0;
    case CommandId::DUPLICATE_PAGE: return doc_.has(page_) ? CMD_ENABLED : 0;
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
  if (reorderInFlow(top, dx, dy)) return;
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

bool Editor::reorderInFlow(const std::vector<Guid>& top, double dx, double dy) {
  // Inside auto layout the arrows along the flow move the layers one place (Figma); across it they do nothing.
  Guid parent = doc_.parentOf(top[0]);
  const Node* pn = doc_.get(parent);
  if (!pn || !pn->props.isAutoLayout()) return false;
  for (Guid id : top) {
    const Node* n = doc_.get(id);
    if (!n || doc_.parentOf(id) != parent || !n->props.inFlow()) return false;
  }
  double along = pn->props.stackMode == StackMode::HORIZONTAL ? dx : dy;
  if (along == 0) return true;
  int dir = along > 0 ? 1 : -1;
  std::vector<Guid> flow = Layout(*this).flowChildren(parent);
  auto flowIndex = [&](Guid id) { return std::find(flow.begin(), flow.end(), id) - flow.begin(); };
  std::vector<Guid> order = top;
  std::sort(order.begin(), order.end(), [&](Guid a, Guid b) { return dir > 0 ? flowIndex(a) > flowIndex(b) : flowIndex(a) < flowIndex(b); });
  begin(TxnKind::USER, "Reorder");
  for (Guid id : order) {
    flow = Layout(*this).flowChildren(parent);
    long i = flowIndex(id), j = i + dir;
    if (j < 0 || j >= static_cast<long>(flow.size()) || selected(flow[static_cast<size_t>(j)])) continue;
    std::vector<Guid> others;
    for (Guid c : doc_.children(parent))
      if (c != id) others.push_back(c);
    size_t at = static_cast<size_t>(std::find(others.begin(), others.end(), flow[static_cast<size_t>(j)]) - others.begin());
    std::string key = placeAt(parent, dir > 0 ? at + 1 : at, id);
    NodeChange c = NodeChange::changed(id);
    c.mask = F_PARENT_INDEX;
    c.props.parentIndex = {parent, key};
    write(c);
  }
  commit();
  return true;
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

void Editor::selectInverse() {
  // Figma's Select inverse: everything beside the selection (its parent's other
  // children, visible and unlocked) instead of it; with nothing selected, the page's.
  std::vector<Guid> base = selection_;
  Guid parent = page_;
  if (!base.empty()) {
    Guid p = doc_.parentOf(base[0]);
    if (p != kNoGuid) parent = p;
  }
  std::vector<Guid> next;
  for (Guid c : doc_.children(parent)) {
    const Node* n = doc_.get(c);
    if (n && n->props.visible && !n->props.locked && !selected(c)) next.push_back(c);
  }
  changeSelection(std::move(next));
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

// ---- Helpers for structural commands --------------------------------------------

namespace {

// Matrix entries within 1e-9 of a whole number become it (composing a transform
// with its parent's inverse leaves float dust).
Mat2x3 cleaned(Mat2x3 m) {
  for (double* v : {&m.m00, &m.m01, &m.m02, &m.m10, &m.m11, &m.m12}) {
    double r = std::round(*v);
    if (std::fabs(*v - r) < 1e-9) *v = r == 0 ? 0 : r;
  }
  return m;
}

using GuidSet = std::unordered_set<Guid, GuidHash>;

}  // namespace

Mat2x3 Editor::localFor(Guid parent, const Mat2x3& world) const {
  return cleaned(doc_.worldTransform(parent).inverse() * world);
}

Guid Editor::documentNode() const {
  Guid d = doc_.parentOf(page_);
  if (doc_.has(d)) return d;
  Guid found = kNoGuid;
  doc_.forEach([&](const Node& n) {
    if (n.props.type == NodeType::DOCUMENT) found = n.guid;
  });
  return found;
}

std::vector<Guid> Editor::topSelectionInPaintOrder() const {
  std::vector<Guid> top;
  for (Guid id : topLevelSelection(doc_, selection_)) {
    const Node* n = doc_.get(id);
    if (n && n->props.type != NodeType::CANVAS && n->props.type != NodeType::DOCUMENT) top.push_back(id);
  }
  std::stable_sort(top.begin(), top.end(), [&](Guid a, Guid b) { return doc_.paintsBefore(a, b); });
  return top;
}

std::vector<Guid> Editor::arrangeable() const {
  // Align and distribute move layers the user placed: not locked ones, not ones an auto-layout parent places.
  std::vector<Guid> out;
  for (Guid id : topLevelSelection(doc_, selection_)) {
    const Node* n = doc_.get(id);
    if (!n || n->props.locked) continue;
    const Node* p = doc_.get(n->props.parentIndex.guid);
    if (p && p->props.isAutoLayout() && n->props.inFlow()) continue;
    out.push_back(id);
  }
  return out;
}

bool Editor::canUngroup(Guid id) const {
  const Node* n = doc_.get(id);
  if (!n || doc_.children(id).empty()) return false;
  return n->props.isGroupLike() || n->props.type == NodeType::FRAME;
}

std::vector<std::string> Editor::placeManyAt(Guid parent, size_t index, size_t count, const std::unordered_set<Guid, GuidHash>& moving) {
  auto siblingsOf = [&] {
    std::vector<Guid> s;
    for (Guid c : doc_.children(parent))
      if (!moving.count(c)) s.push_back(c);
    return s;
  };
  auto keysAt = [&](const std::vector<Guid>& s) {
    size_t i = std::min(index, s.size());
    std::string lo = i > 0 ? doc_.get(s[i - 1])->props.parentIndex.position : std::string();
    std::optional<std::string> hi;
    if (i < s.size()) hi = doc_.get(s[i])->props.parentIndex.position;
    std::optional<std::string_view> hv = hi ? std::optional<std::string_view>(*hi) : std::nullopt;
    if (count == 1) {
      fractional::Bias bias = !hi ? fractional::Bias::Low : lo.empty() ? fractional::Bias::High : fractional::Bias::Mid;
      return std::vector<std::string>{fractional::keyBetween(lo, hv, bias)};
    }
    return fractional::keysBetween(lo, hv, static_cast<int>(count));
  };
  auto usable = [&](const std::vector<std::string>& keys) {
    if (keys.size() != count) return false;
    for (auto& k : keys)
      if (k.empty() || k.size() > fractional::kMaxKeyLength) return false;
    return true;
  };
  if (count == 0) return {};
  std::vector<Guid> siblings = siblingsOf();
  auto keys = keysAt(siblings);
  if (usable(keys)) return keys;
  // Too long (or tied keys): respace the siblings, order unchanged, in this transaction (docs/schema.md §10.3).
  auto spaced = fractional::rebalancedKeys(static_cast<int>(siblings.size()));
  for (size_t i = 0; i < siblings.size(); i++) {
    NodeChange c = NodeChange::changed(siblings[i]);
    c.mask = F_PARENT_INDEX;
    c.props.parentIndex = {parent, spaced[i]};
    write(c);
  }
  return keysAt(siblingsOf());
}

void Editor::reparent(Guid id, Guid parent, const std::string& position) {
  if (!doc_.has(id)) return;
  Mat2x3 world = doc_.worldTransform(id);
  NodeChange c = NodeChange::changed(id);
  c.mask = F_PARENT_INDEX | F_TRANSFORM;
  c.props.parentIndex = {parent, position};
  c.props.transform = localFor(parent, world);
  write(c);
}

Guid Editor::cloneSubtree(Guid src, Guid parent, const std::string& position, const Mat2x3& transform, const std::string* name) {
  const Node* n = doc_.get(src);
  if (!n) return kNoGuid;
  NodeProps p = n->props;
  std::vector<Guid> kids = doc_.children(src);
  Guid id = newGuid();
  p.parentIndex = {parent, position};
  p.transform = transform;
  if (name) p.name = *name;
  write(NodeChange::created(id, p));
  for (Guid c : kids) {
    const Node* cn = doc_.get(c);
    if (cn) cloneSubtree(c, id, cn->props.parentIndex.position, cn->props.transform);
  }
  return id;
}

// ---- Group, frame selection, ungroup -------------------------------------------------

Guid Editor::wrapSelection(const char* kind) {
  std::vector<Guid> top = topSelectionInPaintOrder();
  if (top.empty()) return kNoGuid;
  const std::string k = kind;
  const bool group = k == "Group";
  // At the topmost layer's place, once they are all taken out (Figma).
  Guid topmost = top.back();
  Guid parent = doc_.parentOf(topmost);
  GuidSet moving(top.begin(), top.end());
  size_t index = 0;
  for (Guid c : doc_.children(parent)) {
    if (c == topmost) break;
    if (!moving.count(c)) index++;
  }
  // Their union, in the parent's space.
  Mat2x3 toParent = doc_.worldTransform(parent).inverse();
  Rect u;
  bool any = false;
  for (Guid id : top) {
    const Node* n = doc_.get(id);
    Rect b = transformedBounds(toParent * doc_.worldTransform(id), n->props.size.x, n->props.size.y);
    u = any ? u.united(b) : b;
    any = true;
  }

  begin(TxnKind::USER, group ? "Group selection" : k == "Frame" ? "Frame selection" : "Add auto layout");
  NodeProps p = defaultProps(NodeType::FRAME);
  p.name = nextName(group ? "Group" : "Frame");
  if (group) p.resizeToFit = true;
  if (k != "Frame") p.fillPaints.clear();  // a group and an auto-layout wrapper have no fill
  p.frameMaskDisabled = true;              // none of them clips
  p.transform = Mat2x3::translate(u.x, u.y);
  p.size = {u.w, u.h};
  p.parentIndex = {parent, placeManyAt(parent, index, 1, moving)[0]};
  Guid wrapper = newGuid();
  write(NodeChange::created(wrapper, p));
  auto keys = fractional::keysBetween("", std::nullopt, static_cast<int>(top.size()));
  for (size_t i = 0; i < top.size(); i++) reparent(top[i], wrapper, keys[i]);
  changeSelection({wrapper});
  commit();
  return wrapper;
}

void Editor::ungroup() {
  std::vector<Guid> top = topSelectionInPaintOrder();
  std::vector<Guid> targets;
  for (Guid id : top)
    if (canUngroup(id)) targets.push_back(id);
  if (targets.empty()) return;
  begin(TxnKind::USER, "Ungroup selection");
  std::vector<Guid> next;
  for (Guid id : top)
    if (std::find(targets.begin(), targets.end(), id) == targets.end()) next.push_back(id);
  for (Guid g : targets) {
    Guid parent = doc_.parentOf(g);
    std::vector<Guid> kids = doc_.children(g);
    const auto& siblings = doc_.children(parent);
    size_t index = static_cast<size_t>(std::find(siblings.begin(), siblings.end(), g) - siblings.begin());
    auto keys = placeManyAt(parent, index, kids.size(), GuidSet{g});
    for (size_t i = 0; i < kids.size(); i++) {
      reparent(kids[i], parent, keys[i]);
      next.push_back(kids[i]);
    }
    write(NodeChange::removed(g));
  }
  changeSelection(std::move(next));
  commit();
}

// ---- Duplicate, flip, align, distribute -----------------------------------------------

void Editor::duplicate() {
  std::vector<Guid> top = topSelectionInPaintOrder();
  if (top.empty()) return;
  // Top-level frames go beside the originals, to the right, where there is room
  // (Figma); anything else is duplicated in place, just above its original.
  bool frames = true;
  Rect u;
  for (size_t i = 0; i < top.size(); i++) {
    const Node* n = doc_.get(top[i]);
    const Node* p = doc_.get(n->props.parentIndex.guid);
    frames &= n->props.isFrameLike() && p && p->props.type == NodeType::CANVAS;
    Rect b = doc_.worldBounds(top[i]);
    u = i ? u.united(b) : b;
  }
  double dx = 0;
  if (frames) {
    const double gap = kDuplicateGap;
    GuidSet mine(top.begin(), top.end());
    for (int tries = 0; tries < 1000; tries++) {
      dx += u.w + gap;
      Rect at{u.x + dx, u.y, u.w, u.h};
      bool taken = false;
      for (Guid c : doc_.children(page_)) {
        if (mine.count(c)) continue;
        Rect b = doc_.worldBounds(c);
        if (b.x < at.right() && at.x < b.right() && b.y < at.bottom() && at.y < b.bottom()) taken = true;
      }
      if (!taken) break;
    }
  }
  begin(TxnKind::USER, "Duplicate");
  std::vector<Guid> copies;
  for (Guid id : top) {
    const Node* n = doc_.get(id);
    Guid parent = n->props.parentIndex.guid;
    const auto& siblings = doc_.children(parent);
    size_t index = static_cast<size_t>(std::find(siblings.begin(), siblings.end(), id) - siblings.begin()) + 1;
    std::string key = placeAt(parent, index, kNoGuid);
    Mat2x3 t = n->props.transform;
    t.m02 += dx;
    copies.push_back(cloneSubtree(id, parent, key, t));
  }
  changeSelection(std::move(copies));
  commit();
}

void Editor::flip(bool horizontal) {
  std::vector<Guid> top;
  for (Guid id : topSelectionInPaintOrder())
    if (!doc_.get(id)->props.locked) top.push_back(id);
  SelectionBox box = selectionBox(doc_, top);
  if (!box.valid) return;
  // The mirror about the selection box's own axis.
  Mat2x3 mirror = horizontal ? Mat2x3{-1, 0, box.size.x, 0, 1, 0} : Mat2x3{1, 0, 0, 0, -1, box.size.y};
  Mat2x3 F = box.toWorld * mirror * box.toWorld.inverse();
  begin(TxnKind::USER, horizontal ? "Flip horizontal" : "Flip vertical");
  for (Guid id : top) {
    NodeChange c = NodeChange::changed(id);
    c.mask = F_TRANSFORM;
    c.props.transform = localFor(doc_.parentOf(id), F * doc_.worldTransform(id));
    write(c);
  }
  commit();
}

void Editor::shiftWorld(Guid id, Vec2 d) {
  const Node* n = doc_.get(id);
  if (!n || (d.x == 0 && d.y == 0)) return;
  Vec2 dp = doc_.worldTransform(n->props.parentIndex.guid).inverse().applyLinear(d);
  NodeChange c = NodeChange::changed(id);
  c.mask = F_TRANSFORM;
  c.props.transform = n->props.transform;
  c.props.transform.m02 += dp.x;
  c.props.transform.m12 += dp.y;
  c.props.transform = cleaned(c.props.transform);
  write(c);
}

void Editor::align(CommandId how) {
  std::vector<Guid> ids = arrangeable();
  if (ids.empty()) return;
  Rect target;
  if (ids.size() == 1) {
    // One layer aligns within its parent frame (not the page).
    Guid parent = doc_.parentOf(ids[0]);
    const Node* p = doc_.get(parent);
    if (!p || p->props.type == NodeType::CANVAS || p->props.type == NodeType::DOCUMENT) return;
    target = doc_.worldBounds(parent);
  } else {
    for (size_t i = 0; i < ids.size(); i++) target = i ? target.united(doc_.worldBounds(ids[i])) : doc_.worldBounds(ids[i]);
  }
  const char* label = "Align";
  switch (how) {
    case CommandId::ALIGN_LEFT: label = "Align left"; break;
    case CommandId::ALIGN_HORIZONTAL_CENTER: label = "Align horizontal centers"; break;
    case CommandId::ALIGN_RIGHT: label = "Align right"; break;
    case CommandId::ALIGN_TOP: label = "Align top"; break;
    case CommandId::ALIGN_VERTICAL_CENTER: label = "Align vertical centers"; break;
    case CommandId::ALIGN_BOTTOM: label = "Align bottom"; break;
    default: return;
  }
  begin(TxnKind::USER, label);
  for (Guid id : ids) {
    Rect b = doc_.worldBounds(id);
    Vec2 d;
    switch (how) {
      case CommandId::ALIGN_LEFT: d.x = target.x - b.x; break;
      case CommandId::ALIGN_HORIZONTAL_CENTER: d.x = (target.x + target.w / 2) - (b.x + b.w / 2); break;
      case CommandId::ALIGN_RIGHT: d.x = target.right() - b.right(); break;
      case CommandId::ALIGN_TOP: d.y = target.y - b.y; break;
      case CommandId::ALIGN_VERTICAL_CENTER: d.y = (target.y + target.h / 2) - (b.y + b.h / 2); break;
      case CommandId::ALIGN_BOTTOM: d.y = target.bottom() - b.bottom(); break;
      default: break;
    }
    shiftWorld(id, d);
  }
  commit();
}

void Editor::distribute(bool horizontal) {
  std::vector<Guid> ids = arrangeable();
  if (ids.size() < 3) return;
  auto lo = [&](const Rect& r) { return horizontal ? r.x : r.y; };
  auto len = [&](const Rect& r) { return horizontal ? r.w : r.h; };
  std::vector<std::pair<Guid, Rect>> items;
  for (Guid id : ids) items.push_back({id, doc_.worldBounds(id)});
  std::stable_sort(items.begin(), items.end(), [&](auto& a, auto& b) {
    return lo(a.second) + len(a.second) / 2 < lo(b.second) + len(b.second) / 2;
  });
  double start = lo(items.front().second), end = start, total = 0;
  for (auto& [id, r] : items) {
    start = std::min(start, lo(r));
    end = std::max(end, lo(r) + len(r));
    total += len(r);
  }
  // The first and last stay; the space between them is shared equally.
  double gap = (end - start - total) / static_cast<double>(items.size() - 1);
  begin(TxnKind::USER, horizontal ? "Distribute horizontal spacing" : "Distribute vertical spacing");
  double at = start;
  for (auto& [id, r] : items) {
    double d = at - lo(r);
    shiftWorld(id, horizontal ? Vec2{d, 0} : Vec2{0, d});
    at += len(r) + gap;
  }
  commit();
}

// ---- Auto layout -------------------------------------------------------------------------

void Editor::inferAutoLayout(Guid frame, bool padFromContent) {
  const Node* fn = doc_.get(frame);
  if (!fn) return;
  const NodeProps fp = fn->props;
  std::vector<Guid> kids = doc_.children(frame);
  NodeChange c = NodeChange::changed(frame);
  c.mask = F_STACK_MODE | F_STACK_SPACING | F_STACK_PADDING_LEFT | F_STACK_PADDING_TOP | F_STACK_PADDING_RIGHT |
           F_STACK_PADDING_BOTTOM | F_STACK_PRIMARY_SIZING | F_STACK_COUNTER_SIZING | F_STACK_COUNTER_ALIGN;
  NodeProps& p = c.props;
  p.stackCounterAlignItems = StackAlign::MIN;
  if (kids.empty()) {
    // An empty frame keeps its size.
    p.stackMode = StackMode::VERTICAL;
    p.stackSpacing = 10;
    p.stackPrimarySizing = StackSize::FIXED;
    p.stackCounterSizing = StackSize::FIXED;
    write(c);
    return;
  }
  std::vector<std::pair<Guid, Rect>> boxes;
  Rect u;
  for (size_t i = 0; i < kids.size(); i++) {
    const NodeProps& kp = doc_.get(kids[i])->props;
    Rect b = layoutBox(kp.transform, kp.size);
    boxes.push_back({kids[i], b});
    u = i ? u.united(b) : b;
  }
  // The direction the layers spread in: where their centres differ more.
  double minCx = 1e300, maxCx = -1e300, minCy = 1e300, maxCy = -1e300;
  for (auto& [id, b] : boxes) {
    minCx = std::min(minCx, b.x + b.w / 2), maxCx = std::max(maxCx, b.x + b.w / 2);
    minCy = std::min(minCy, b.y + b.h / 2), maxCy = std::max(maxCy, b.y + b.h / 2);
  }
  bool horizontal = boxes.size() == 1 || maxCx - minCx >= maxCy - minCy;
  int P = horizontal ? 0 : 1;
  auto lo = [&](const Rect& r, int a) { return a == 0 ? r.x : r.y; };
  auto len = [&](const Rect& r, int a) { return a == 0 ? r.w : r.h; };
  std::stable_sort(boxes.begin(), boxes.end(), [&](auto& a, auto& b) { return lo(a.second, P) < lo(b.second, P); });
  // The gap: the mean space between neighbours (never negative).
  double sum = 0;
  for (size_t i = 1; i < boxes.size(); i++) sum += lo(boxes[i].second, P) - (lo(boxes[i - 1].second, P) + len(boxes[i - 1].second, P));
  p.stackMode = horizontal ? StackMode::HORIZONTAL : StackMode::VERTICAL;
  p.stackSpacing = boxes.size() > 1 ? std::max(0.0, std::round(sum / static_cast<double>(boxes.size() - 1))) : 10;
  // The counter alignment they share (else top / left).
  int C = 1 - P;
  bool mins = true, mids = true, maxs = true;
  for (auto& [id, b] : boxes) {
    const Rect& f = boxes[0].second;
    mins &= std::fabs(lo(b, C) - lo(f, C)) < 0.5;
    mids &= std::fabs(lo(b, C) + len(b, C) / 2 - (lo(f, C) + len(f, C) / 2)) < 0.5;
    maxs &= std::fabs(lo(b, C) + len(b, C) - (lo(f, C) + len(f, C))) < 0.5;
  }
  if (!mins && mids) p.stackCounterAlignItems = StackAlign::CENTER;
  else if (!mins && maxs) p.stackCounterAlignItems = StackAlign::MAX;
  if (padFromContent) {
    p.stackPaddingLeft = std::max(0.0, std::round(u.x));
    p.stackPaddingTop = std::max(0.0, std::round(u.y));
    p.stackPaddingRight = std::max(0.0, std::round(fp.size.x - u.right()));
    p.stackPaddingBottom = std::max(0.0, std::round(fp.size.y - u.bottom()));
  }
  p.stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;  // Hug both ways
  p.stackCounterSizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  write(c);
  // The flow follows the order they sat in.
  auto keys = fractional::keysBetween("", std::nullopt, static_cast<int>(boxes.size()));
  for (size_t i = 0; i < boxes.size(); i++) {
    NodeChange k = NodeChange::changed(boxes[i].first);
    k.mask = F_PARENT_INDEX;
    k.props.parentIndex = {frame, keys[i]};
    write(k);
  }
}

void Editor::addAutoLayout() {
  std::vector<Guid> top = topSelectionInPaintOrder();
  if (top.empty()) return;
  begin(TxnKind::USER, "Add auto layout");
  const Node* only = top.size() == 1 ? doc_.get(top[0]) : nullptr;
  if (only && only->props.type == NodeType::FRAME && !only->props.resizeToFit && !only->props.isAutoLayout()) {
    // A lone frame gets auto layout itself, its padding from where its content sits.
    inferAutoLayout(top[0], true);
    changeSelection({top[0]});
  } else {
    // Anything else (an auto-layout frame too) is wrapped in a new auto-layout frame.
    Guid wrapper = wrapSelection("Auto");
    if (wrapper != kNoGuid) inferAutoLayout(wrapper, false);
  }
  commit();
}

void Editor::removeAutoLayout() {
  std::vector<Guid> frames;
  for (Guid id : selection_) {
    const Node* n = doc_.get(id);
    if (n && n->props.isAutoLayout()) frames.push_back(id);
  }
  if (frames.empty()) return;
  begin(TxnKind::USER, "Remove auto layout");
  for (Guid id : frames) {
    // The children stay where the layout put them; the frame keeps its size.
    NodeChange c = NodeChange::changed(id);
    c.mask = F_STACK_MODE;
    c.props.stackMode = StackMode::NONE;
    write(c);
  }
  commit();
}

// ---- Pages -------------------------------------------------------------------------------

Guid Editor::createPage() {
  Guid docId = documentNode();
  if (!doc_.has(docId)) return kNoGuid;
  auto all = pages();
  const auto& kids = doc_.children(docId);
  size_t index = all.empty() ? 0 : static_cast<size_t>(std::find(kids.begin(), kids.end(), all.back()) - kids.begin()) + 1;
  begin(TxnKind::USER, "Add page");
  NodeProps p;
  p.type = NodeType::CANVAS;
  p.name = nextName("Page");
  p.backgroundColor = Color::hex(0xF5F5F5);
  p.backgroundEnabled = true;
  p.parentIndex = {docId, placeAt(docId, index, kNoGuid)};
  Guid id = newGuid();
  write(NodeChange::created(id, p));
  commit();
  setCurrentPage(id);
  return id;
}

Status Editor::deletePage(Guid page) {
  const Node* n = doc_.get(page);
  if (!n || n->props.type != NodeType::CANVAS || n->props.internalOnly) return E_NOT_FOUND;
  auto all = pages();
  if (all.size() <= 1) return E_INVALID;  // a file keeps one page
  auto at = std::find(all.begin(), all.end(), page);
  Guid neighbour = at + 1 != all.end() ? *(at + 1) : *(at - 1);
  begin(TxnKind::USER, "Delete page");
  std::vector<Guid> order;
  auto collect = [&](auto&& self, Guid id) -> void {
    std::vector<Guid> kids = doc_.children(id);
    for (Guid c : kids) self(self, c);
    order.push_back(id);
  };
  collect(collect, page);
  if (page == page_) changeSelection({});
  for (Guid id : order) write(NodeChange::removed(id));
  commit();
  if (page == page_) {
    page_ = kNoGuid;
    setCurrentPage(neighbour);
  }
  pageSelections_.erase(page);
  events_.pages = true;
  return OK;
}

Guid Editor::duplicatePage(Guid page) {
  const Node* n = doc_.get(page);
  if (!n || n->props.type != NodeType::CANVAS || n->props.internalOnly) return kNoGuid;
  Guid docId = n->props.parentIndex.guid;
  const auto& kids = doc_.children(docId);
  size_t index = static_cast<size_t>(std::find(kids.begin(), kids.end(), page) - kids.begin()) + 1;
  std::string name = n->props.name + " copy";
  begin(TxnKind::USER, "Duplicate page");
  Guid copy = cloneSubtree(page, docId, placeAt(docId, index, kNoGuid), n->props.transform, &name);
  commit();
  setCurrentPage(copy);
  return copy;
}

// ---- Layers panel, clipboard -------------------------------------------------------------

uint32_t Editor::moveNodes(const std::vector<Guid>& ids, Guid parent, uint32_t index) {
  if (busy() || txn_.open) return 0;
  const Node* pn = doc_.get(parent);
  if (!pn || !pn->props.isContainer()) return 0;
  bool pagesMove = pn->props.type == NodeType::DOCUMENT;
  std::vector<Guid> live;
  for (Guid id : ids) {
    const Node* n = doc_.get(id);
    if (!n || n->props.type == NodeType::DOCUMENT || std::find(live.begin(), live.end(), id) != live.end()) continue;
    // Pages go only under the document, and nothing else does.
    if ((n->props.type == NodeType::CANVAS) != pagesMove) return 0;
    if (id == parent || doc_.isAncestor(id, parent)) return 0;  // into itself
    live.push_back(id);
  }
  live = topLevelSelection(doc_, live);
  if (live.empty()) return 0;
  std::stable_sort(live.begin(), live.end(), [&](Guid a, Guid b) { return doc_.paintsBefore(a, b); });
  GuidSet moving(live.begin(), live.end());
  begin(TxnKind::USER, pagesMove ? "Move page" : "Move layers");
  auto keys = placeManyAt(parent, index, live.size(), moving);
  for (size_t i = 0; i < live.size(); i++) {
    if (pagesMove) {
      NodeChange c = NodeChange::changed(live[i]);
      c.mask = F_PARENT_INDEX;
      c.props.parentIndex = {parent, keys[i]};
      write(c);
    } else {
      reparent(live[i], parent, keys[i]);
    }
  }
  commit();
  pruneSelection();
  return static_cast<uint32_t>(live.size());
}

bool Editor::copySelection(Clipboard& out) const {
  out = Clipboard{};
  std::vector<Guid> top = topSelectionInPaintOrder();
  if (top.empty()) return false;
  out.page = page_;
  auto visit = [&](auto&& self, Guid id) -> void {
    out.nodes.push_back(NodeChange::created(id, doc_.get(id)->props));
    for (Guid c : doc_.children(id)) self(self, c);
  };
  for (Guid id : top) {
    visit(visit, id);
    Guid parent = doc_.parentOf(id);
    auto region = std::find_if(out.regions.begin(), out.regions.end(), [&](const Clipboard::Region& r) { return r.parent == parent; });
    if (region == out.regions.end()) {
      out.regions.push_back({parent, {}, doc_.worldTransform(parent).translation()});
      region = out.regions.end() - 1;
    }
    region->nodes.push_back(id);
  }
  return true;
}

uint32_t Editor::paste(const Clipboard& clip, bool inPlace) {
  if (busy() || txn_.open || page_ == kNoGuid) return 0;
  std::unordered_map<Guid, const NodeChange*, GuidHash> byId;
  for (const NodeChange& c : clip.nodes)
    if (c.phase != Phase::REMOVED && c.props.type != NodeType::CANVAS && c.props.type != NodeType::DOCUMENT && c.props.type != NodeType::NONE)
      byId[c.guid] = &c;
  std::vector<const NodeChange*> roots;
  std::unordered_map<Guid, std::vector<const NodeChange*>, GuidHash> kids;
  for (const NodeChange& c : clip.nodes) {
    if (!byId.count(c.guid) || byId[c.guid] != &c) continue;
    if (byId.count(c.props.parentIndex.guid)) kids[c.props.parentIndex.guid].push_back(&c);
    else roots.push_back(&c);
  }
  if (roots.empty()) return 0;
  for (auto& [parent, list] : kids)
    std::stable_sort(list.begin(), list.end(), [](const NodeChange* a, const NodeChange* b) {
      return a->props.parentIndex.position < b->props.parentIndex.position;
    });

  // Where each root was on its page, and their union.
  auto offsetOf = [&](Guid parent) {
    for (auto& r : clip.regions)
      if (r.parent == parent) return r.offset;
    return Vec2{};
  };
  std::vector<Mat2x3> worlds;
  Rect u;
  GuidSet sourceRoots;
  for (size_t i = 0; i < roots.size(); i++) {
    Vec2 o = offsetOf(roots[i]->props.parentIndex.guid);
    worlds.push_back(Mat2x3::translate(o.x, o.y) * roots[i]->props.transform);
    Rect b = transformedBounds(worlds.back(), roots[i]->props.size.x, roots[i]->props.size.y);
    u = i ? u.united(b) : b;
    sourceRoots.insert(roots[i]->guid);
  }

  // Into the selected frame, beside the selected layer, or on the page.
  Guid target = page_;
  size_t index = doc_.children(page_).size();
  bool intoFrame = false;
  std::vector<Guid> sel = topSelectionInPaintOrder();
  if (!sel.empty()) {
    Guid s = sel.back();
    const Node* sn = doc_.get(s);
    if (sel.size() == 1 && sn->props.isFrameLike() && !sourceRoots.count(s)) {
      target = s;
      index = doc_.children(s).size();
      intoFrame = true;
    } else {
      target = doc_.parentOf(s);
      const auto& siblings = doc_.children(target);
      index = static_cast<size_t>(std::find(siblings.begin(), siblings.end(), s) - siblings.begin()) + 1;
    }
  }
  Vec2 d;
  if (!inPlace) {
    auto centreIn = [&](const Rect& r) {
      return Vec2{std::round(r.x + r.w / 2 - u.w / 2) - u.x, std::round(r.y + r.h / 2 - u.h / 2) - u.y};
    };
    if (intoFrame) {
      // Where it sat in its own parent, if that fits in the frame; else in the frame's middle.
      Guid sourceParent = roots[0]->props.parentIndex.guid;
      if (sourceParent != target) {
        Rect fb = doc_.worldBounds(target);
        Vec2 o = offsetOf(sourceParent);
        Vec2 rel{u.x - o.x, u.y - o.y};
        Rect placed{fb.x + rel.x, fb.y + rel.y, u.w, u.h};
        d = fb.containsRect(placed) ? Vec2{placed.x - u.x, placed.y - u.y} : centreIn(fb);
      }
    } else if (target == page_ && sel.empty()) {
      // Where it was when that is in view; else in the middle of the view.
      Vec2 a = camera_.toWorld({0, 0}), b = camera_.toWorld({viewport_.width, viewport_.height});
      Rect view = Rect::fromPoints(a, b);
      if (!view.intersects(u)) d = centreIn(view);
    }
  }

  begin(TxnKind::USER, "Paste");
  auto keys = placeManyAt(target, index, roots.size(), {});
  std::vector<Guid> pasted;
  auto create = [&](auto&& self, const NodeChange& src, Guid parent, const std::string& position, const Mat2x3& transform) -> void {
    NodeProps p = src.props;
    p.parentIndex = {parent, position};
    p.transform = transform;
    Guid id = newGuid();
    write(NodeChange::created(id, p));
    if (parent == target) pasted.push_back(id);
    auto it = kids.find(src.guid);
    if (it == kids.end()) return;
    for (const NodeChange* c : it->second) self(self, *c, id, c->props.parentIndex.position, c->props.transform);
  };
  for (size_t i = 0; i < roots.size(); i++)
    create(create, *roots[i], target, keys[i], localFor(target, Mat2x3::translate(d.x, d.y) * worlds[i]));
  changeSelection(pasted);
  commit();
  return static_cast<uint32_t>(pasted.size());
}

}  // namespace eng
