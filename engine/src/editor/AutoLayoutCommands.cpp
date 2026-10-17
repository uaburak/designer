// Atlas wave 2 — layout (docs/research/atlas/09-layout.md §3.2, §4): auto layout inferred from where layers sit (Add
// auto layout's, layout/Infer.h — grids and wraps too), Suggest auto layout (⌃⇧A: the selection stacked into nested
// auto-layout frames), Remove all auto layout (Figma's destroy-all-auto-layout: the selection and every layer inside it)
// and the layout version (stackLayoutVersion: Updated / Legacy, the Design panel's Layout row and Figma's "Update
// layout version for selection / page"). Each is one undo step.

#include <algorithm>
#include <cmath>
#include <functional>

#include "base/FractionalIndex.h"
#include "editor/Editor.h"
#include "layout/Infer.h"

namespace eng {

namespace {

// Layers whose own auto layout comes from elsewhere: an instance's (its main's) and anything derived inside one.
bool ownsLayout(const Node* n, Guid id) { return n && !id.isDerived() && n->props.type != NodeType::INSTANCE; }

// A plain frame Suggest auto layout may turn into auto layout itself (a frame with layers in it, not a group, section,
// instance or one that already has auto layout).
bool plainFrame(const Node* n, Guid id) {
  return ownsLayout(n, id) && (n->props.type == NodeType::FRAME || n->props.type == NodeType::SYMBOL) && !n->props.resizeToFit &&
         !n->props.isAutoLayout() && !n->props.isComponentSet();
}

}  // namespace

void Editor::inferAutoLayout(Guid frame, bool padFromContent) {
  const Node* fn = doc_.get(frame);
  if (!fn) return;
  const NodeProps fp = fn->props;
  std::vector<Guid> kids = doc_.children(frame);
  NodeChange c = NodeChange::changed(frame);
  c.mask = F_STACK_MODE | F_STACK_SPACING | F_STACK_PADDING_LEFT | F_STACK_PADDING_TOP | F_STACK_PADDING_RIGHT |
           F_STACK_PADDING_BOTTOM | F_STACK_PRIMARY_SIZING | F_STACK_COUNTER_SIZING | F_STACK_COUNTER_ALIGN;
  NodeProps& p = c.props;
  p.stack().stackCounterAlignItems = StackAlign::MIN;
  if (kids.empty()) {
    // An empty frame keeps its size.
    p.stack().stackMode = StackMode::VERTICAL;
    p.stack().stackSpacing = 10;
    p.stack().stackPrimarySizing = StackSize::FIXED;
    p.stack().stackCounterSizing = StackSize::FIXED;
    stampNewStack(fp, c);
    write(c);
    return;
  }
  std::vector<Rect> boxes;
  Rect u;
  for (size_t i = 0; i < kids.size(); i++) {
    const NodeProps& kp = doc_.get(kids[i])->props;
    boxes.push_back(layoutBox(kp.transform, kp.size));
    u = i ? u.united(boxes.back()) : boxes.back();
  }
  const infer::Stack s = infer::stack(boxes);
  p.stack().stackSpacing = s.gap;
  p.stack().stackCounterAlignItems = s.counterAlign == 1 ? StackAlign::CENTER : s.counterAlign == 2 ? StackAlign::MAX : StackAlign::MIN;
  if (padFromContent) {
    p.stack().stackPaddingLeft = std::max(0.0, std::round(u.x));
    p.stack().stackPaddingTop = std::max(0.0, std::round(u.y));
    p.stack().stackPaddingRight = std::max(0.0, std::round(fp.size.x - u.right()));
    p.stack().stackPaddingBottom = std::max(0.0, std::round(fp.size.y - u.bottom()));
  }
  p.stack().stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;  // Hug both ways
  p.stack().stackCounterSizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  switch (s.kind) {
    case infer::Kind::HORIZONTAL: p.stack().stackMode = StackMode::HORIZONTAL; break;
    case infer::Kind::VERTICAL: p.stack().stackMode = StackMode::VERTICAL; break;
    case infer::Kind::WRAP:
      // Rows that wrap: the width stays (it decides where they break), the height hugs them.
      p.stack().stackMode = StackMode::HORIZONTAL;
      p.stack().stackWrap = StackWrap::WRAP;
      p.stack().stackCounterSpacing = s.counterGap;
      p.stack().stackPrimarySizing = StackSize::FIXED;
      c.mask |= F_STACK_WRAP | F_STACK_COUNTER_SPACING;
      break;
    case infer::Kind::GRID: {
      // Its columns and rows Hug, the layers flowing into them in reading order (automatic positioning).
      p.stack().stackMode = StackMode::GRID;
      p.stack().stackSpacing = 0;
      p.stack().stackCounterAlignItems = StackAlign::MIN;
      for (bool column : {true, false}) {
        size_t n = column ? s.columns : s.rows;
        auto keys = fractional::keysBetween("", std::nullopt, static_cast<int>(n));
        std::vector<Layout::GridTrackDef> tracks;
        for (size_t i = 0; i < n; i++) tracks.push_back({newGuid(), keys[i], 2, 1});
        Layout::setGridTrackDefs(p, column, tracks);
      }
      p.extra["gridColumnGap"] = Layout::gridGapBytes(true, s.gap);
      p.extra["gridRowGap"] = Layout::gridGapBytes(false, s.counterGap);
      p.extra["gridReflowEnabled"] = Layout::gridReflowBytes(true);
      p.extra["gridAutoTracks"] = Layout::gridAutoRowsBytes(false);
      c.mask |= F_EXTRA;
      break;
    }
  }
  stampNewStack(fp, c);
  write(c);
  // The flow follows the order they sat in.
  auto keys = fractional::keysBetween("", std::nullopt, static_cast<int>(s.order.size()));
  for (size_t i = 0; i < s.order.size(); i++) {
    NodeChange k = NodeChange::changed(kids[s.order[i]]);
    k.mask = F_PARENT_INDEX;
    k.props.parentIndex = {frame, keys[i]};
    write(k);
  }
}

Guid Editor::wrapInAutoLayout(const std::vector<Guid>& ids) {
  if (ids.empty()) return kNoGuid;
  const Guid parent = doc_.parentOf(ids[0]);
  GuidSet moving(ids.begin(), ids.end());
  // At the topmost one's place, once they are all taken out (as Frame selection).
  size_t index = 0, seen = 0, topmost = 0;
  for (Guid c : doc_.children(parent)) {
    if (moving.count(c)) topmost = seen;
    else seen++;
  }
  index = topmost;
  Rect u;
  for (size_t i = 0; i < ids.size(); i++) {
    const NodeProps& cp = doc_.get(ids[i])->props;
    Rect b = layoutBox(cp.transform, cp.size);
    u = i ? u.united(b) : b;
  }
  NodeProps p = defaultProps(NodeType::FRAME);
  p.name = nextName("Frame");
  p.fillPaints.clear();       // an auto-layout wrapper has no fill
  p.frameMaskDisabled = true;  // and doesn't clip
  p.transform = Mat2x3::translate(u.x, u.y);
  p.size = {u.w, u.h};
  p.parentIndex = {parent, placeManyAt(parent, index, 1, moving)[0]};
  Guid wrapper = newGuid();
  write(NodeChange::created(wrapper, p));
  auto keys = fractional::keysBetween("", std::nullopt, static_cast<int>(ids.size()));
  for (size_t i = 0; i < ids.size(); i++) reparent(ids[i], wrapper, keys[i]);
  inferAutoLayout(wrapper, false);
  return wrapper;
}

// Suggest auto layout's stacking of sibling layers (ours until a live probe, Atlas 09 §12 question 3): a set that
// reads as a grid or a wrap becomes one; else it splits into rows (one above another) or, failing that, columns, each
// part of more than one layer stacked the same way in turn (a row splits into columns, a column into rows), and the
// parts become one stack. `into`: the frame they are in becomes that stack itself (no wrapper). Layers that overlap
// both ways stay as they are (and with them the whole set). Plain frames among them whose layers lie within them are
// stacked inside too. Returns what stands for them now (the new frame, `into`, or kNoGuid when nothing was stacked);
// `made` collects the frames created.
Guid Editor::suggestStack(const std::vector<Guid>& ids, Guid into, std::vector<Guid>& made, int depth) {
  // Frames among them are stacked inside too when their layers lie within them (one whose content spills out — a
  // clipped illustration — is no layout).
  auto contained = [&](Guid f) {
    const Vec2 s = doc_.get(f)->props.size;
    for (Guid c : doc_.children(f)) {
      const NodeProps& cp = doc_.get(c)->props;
      Rect b = layoutBox(cp.transform, cp.size);
      if (cp.visible && (b.x < -0.5 || b.y < -0.5 || b.right() > s.x + 0.5 || b.bottom() > s.y + 0.5)) return false;
    }
    return true;
  };
  for (Guid id : ids)
    if (plainFrame(doc_.get(id), id) && !doc_.children(id).empty() && contained(id) && depth < 32) suggestInside(id, made, depth + 1);
  if (ids.size() < 2 && into == kNoGuid) return ids.empty() ? kNoGuid : ids[0];
  std::vector<Rect> boxes;
  for (Guid id : ids) {
    const NodeProps& cp = doc_.get(id)->props;
    boxes.push_back(layoutBox(cp.transform, cp.size));
  }
  const infer::Kind kind = infer::stack(boxes).kind;
  std::vector<Guid> parts = ids;
  if (kind != infer::Kind::GRID && kind != infer::Kind::WRAP && ids.size() > 1) {
    auto groups = infer::split(boxes, 1);
    if (groups.size() < 2) groups = infer::split(boxes, 0);
    if (groups.size() < 2) return kNoGuid;  // a pile: nothing reads as a stack
    parts.clear();
    for (const auto& g : groups) {
      std::vector<Guid> members;
      for (size_t i : g) members.push_back(ids[i]);
      Guid part = members.size() > 1 && depth < 32 ? suggestStack(members, kNoGuid, made, depth + 1) : members[0];
      if (part == kNoGuid) return kNoGuid;  // a part that can't be stacked: the whole set stays
      parts.push_back(part);
    }
  }
  if (into != kNoGuid) {
    inferAutoLayout(into, true);
    return into;
  }
  Guid w = wrapInAutoLayout(parts);
  if (w != kNoGuid) made.push_back(w);
  return w;
}

void Editor::suggestInside(Guid frame, std::vector<Guid>& made, int depth) {
  std::vector<Guid> kids;
  for (Guid c : doc_.children(frame))
    if (const Node* n = doc_.get(c); n && n->props.visible) kids.push_back(c);
  if (!kids.empty()) suggestStack(kids, frame, made, depth);
}

Status Editor::autoLayoutCommand(CommandId id, const CommandArgs& args) {
  const json::Value* raw = args.raw.isObject() ? &args.raw : nullptr;
  switch (id) {
    case CommandId::SUGGEST_AUTO_LAYOUT: {
      std::vector<Guid> top = topSelectionInPaintOrder();
      for (Guid t : top)
        if (!ownsLayout(doc_.get(t), t) || isLibraryCopy(t)) return E_INVALID;
      if (top.empty()) return E_INVALID;
      begin(TxnKind::USER, "Suggest auto layout");
      std::vector<Guid> made, next;
      // By parent: layers stack only with their siblings.
      std::vector<Guid> parents;
      for (Guid t : top)
        if (std::find(parents.begin(), parents.end(), doc_.parentOf(t)) == parents.end()) parents.push_back(doc_.parentOf(t));
      for (Guid parent : parents) {
        std::vector<Guid> set;
        for (Guid t : top)
          if (doc_.parentOf(t) == parent) set.push_back(t);
        Guid r = kNoGuid;
        if (set.size() == 1 && plainFrame(doc_.get(set[0]), set[0])) {
          // One frame: its layers, the frame itself the outer stack.
          suggestInside(set[0], made, 0);
          r = set[0];
        } else {
          r = suggestStack(set, kNoGuid, made, 0);
        }
        if (r != kNoGuid) next.push_back(r);
        else next.insert(next.end(), set.begin(), set.end());
      }
      bool changed = !made.empty();
      for (Guid t : top) changed |= doc_.get(t) && doc_.get(t)->props.isAutoLayout();
      if (!changed) {
        rollback();
        return E_INVALID;
      }
      changeSelection(next);
      commit();
      created_ = made;
      return OK;
    }
    case CommandId::REMOVE_ALL_AUTO_LAYOUT: {
      std::vector<Guid> frames;
      std::function<void(Guid)> visit = [&](Guid g) {
        const Node* n = doc_.get(g);
        if (!ownsLayout(n, g)) return;  // an instance's layout is its main's
        if (n->props.isAutoLayout()) frames.push_back(g);
        for (Guid c : doc_.children(g)) visit(c);
      };
      for (Guid t : topSelectionInPaintOrder())
        if (!isLibraryCopy(t)) visit(t);
      if (frames.empty()) return E_INVALID;
      begin(TxnKind::USER, "Remove all auto layout");
      for (Guid f : frames) {
        // The layers stay where the layout put them; each frame keeps its size.
        NodeChange c = NodeChange::changed(f);
        c.mask = F_STACK_MODE;
        c.props.stack().stackMode = StackMode::NONE;
        write(c);
      }
      commit();
      created_ = frames;  // the frames it took auto layout from (the toast counts them)
      return OK;
    }
    case CommandId::SET_STACK_LAYOUT_VERSION: {
      // args {version?: 0 | 1 (the latest when absent), deep?: the selected layers' insides too, page?: the whole page}.
      const json::Value* v = raw ? raw->get("version") : nullptr;
      const json::Value* deepArg = raw ? raw->get("deep") : nullptr;
      const json::Value* pageArg = raw ? raw->get("page") : nullptr;
      const uint32_t version = v && v->isNumber() ? static_cast<uint32_t>(std::clamp(v->number, 0.0, 1.0)) : Layout::kLatestStackLayoutVersion;
      const bool page = pageArg && pageArg->isBool() && pageArg->boolean;
      const bool deep = page || (deepArg && deepArg->isBool() && deepArg->boolean);
      std::vector<Guid> stacks = stacksAt(version, page, deep);
      if (stacks.empty()) return E_INVALID;
      begin(TxnKind::USER, version >= Layout::kLatestStackLayoutVersion ? "Update layout version" : "Layout version");
      for (Guid f : stacks) {
        NodeChange c = NodeChange::changed(f);
        c.mask = F_EXTRA;
        c.props.extra["stackLayoutVersion"] = Layout::stackLayoutVersionBytes(version);
        write(c);
        layoutDirty_.insert(f);
      }
      flushLayout();
      commit();
      return OK;
    }
    default: return E_UNSUPPORTED;
  }
}

std::vector<Guid> Editor::stacksAt(uint32_t version, bool page, bool deep) const {
  // The auto-layout frames (their own layout: no instances, nothing derived, no library copies) at another version.
  std::vector<Guid> out;
  std::function<void(Guid, bool)> visit = [&](Guid g, bool inside) {
    const Node* n = doc_.get(g);
    if (!n || g.isDerived() || isLibraryCopy(g)) return;
    if (n->props.type == NodeType::INSTANCE) return;  // the version can't be overridden on an instance (Figma)
    if (n->props.isAutoLayout() && (Layout::stackLayoutVersion(n->props) >= Layout::kLatestStackLayoutVersion) != (version >= Layout::kLatestStackLayoutVersion))
      out.push_back(g);
    if (inside)
      for (Guid c : doc_.children(g)) visit(c, true);
  };
  if (page) {
    for (Guid c : doc_.children(page_)) visit(c, true);
  } else {
    for (Guid s : selection_) visit(s, deep);
  }
  return out;
}

uint32_t Editor::autoLayoutCommandState(CommandId id) const {
  bool derived = false;
  for (Guid s : selection_) derived |= s.isDerived();
  switch (id) {
    case CommandId::SUGGEST_AUTO_LAYOUT: return !derived && !selection_.empty() ? CMD_ENABLED : 0;
    case CommandId::REMOVE_ALL_AUTO_LAYOUT: {
      std::function<bool(Guid)> any = [&](Guid g) {
        const Node* n = doc_.get(g);
        if (!ownsLayout(n, g)) return false;
        if (n->props.isAutoLayout()) return true;
        for (Guid c : doc_.children(g))
          if (any(c)) return true;
        return false;
      };
      for (Guid s : selection_)
        if (any(s)) return CMD_ENABLED;
      return 0;
    }
    // Enabled while the selection (and what is inside it) holds a Legacy stack; checked when every selected stack is
    // Updated (the Layout row's value).
    case CommandId::SET_STACK_LAYOUT_VERSION: {
      bool legacy = !stacksAt(Layout::kLatestStackLayoutVersion, false, true).empty();
      bool stacks = false, updated = true;
      for (Guid s : selection_)
        if (const Node* n = doc_.get(s); n && n->props.isAutoLayout()) {
          stacks = true;
          updated &= Layout::updatedLayout(n->props);
        }
      return (legacy ? CMD_ENABLED : 0) | (stacks && updated ? CMD_CHECKED : 0);
    }
    default: return 0;
  }
}

}  // namespace eng
