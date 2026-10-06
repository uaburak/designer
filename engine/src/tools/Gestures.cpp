// The pointer side of the editor: hover, handles, and the gestures — pan,
// press/click, move, resize, rotate, draw, marquee (docs/engine.md §8.4).
// Each gesture owns a GESTURE transaction from its 3 px drag threshold to
// pointer-up; Esc, blur and pointer-cancel roll it back exactly.

#include <algorithm>
#include <cmath>

#include <unordered_set>

#include "editor/Editor.h"
#include "hit/HitTest.h"
#include "hit/Marquee.h"
#include "hit/Picking.h"

namespace eng {

namespace {

constexpr double kDragThreshold = 3;  // CSS px before a press becomes a drag
constexpr double kCornerReach = 6;    // CSS px around a corner handle
constexpr double kEdgeReach = 4;      // CSS px around an edge
constexpr double kRotateReach = 16;   // CSS px outside a corner: rotation
constexpr double kPi = 3.14159265358979323846;
constexpr double kSnapReach = 6;      // CSS px: snapping threshold (docs/engine.md §8.5)

using GuidSet = std::unordered_set<Guid, GuidHash>;

bool axisAligned(const Mat2x3& m) { return std::fabs(m.m01) < 1e-9 && std::fabs(m.m10) < 1e-9; }

// Matrix entries within 1e-9 of a whole number become it.
Mat2x3 tidy(Mat2x3 m) {
  for (double* v : {&m.m00, &m.m01, &m.m02, &m.m10, &m.m11, &m.m12}) {
    double r = std::round(*v);
    if (std::fabs(*v - r) < 1e-9) *v = r == 0 ? 0 : r;
  }
  return m;
}

double distanceToSegment(Vec2 p, Vec2 a, Vec2 b) {
  Vec2 ab = b - a;
  double len2 = ab.x * ab.x + ab.y * ab.y;
  double t = len2 > 0 ? std::clamp(((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / len2, 0.0, 1.0) : 0;
  return (p - (a + ab * t)).length();
}

double degrees(Vec2 v) { return std::atan2(v.y, v.x) * 180 / kPi; }

}  // namespace

// ---- Handles, cursor, hover -------------------------------------------------

Editor::Handle Editor::handleAt(Vec2 s, int& hx, int& hy) const {
  if (tool_ != Tool::MOVE || spaceHeld_ || selection_.empty()) return Handle::None;
  SelectionBox box = selectionBox(doc_, selection_);
  if (!box.valid) return Handle::None;
  for (Guid id : selection_) {
    const Node* n = doc_.get(id);
    if (n && n->props.locked) return Handle::None;
  }
  Mat2x3 m = camera_.matrix() * box.toWorld;
  double w = box.size.x, h = box.size.y;
  Vec2 c[4] = {m.apply({0, 0}), m.apply({w, 0}), m.apply({w, h}), m.apply({0, h})};
  const int cx[4] = {-1, 1, 1, -1}, cy[4] = {-1, -1, 1, 1};
  double sw = (c[1] - c[0]).length(), sh = (c[3] - c[0]).length();
  bool roomy = sw >= OverlayStyle::of(theme_).handlesMinBox && sh >= OverlayStyle::of(theme_).handlesMinBox;
  if (roomy)
    for (int i = 0; i < 4; i++)
      if ((s - c[i]).length() <= kCornerReach) {
        hx = cx[i], hy = cy[i];
        return Handle::Resize;
      }
  // Edges, unless the box is too small on screen to grab it anywhere else.
  if (sw >= 3 * kEdgeReach && sh >= 3 * kEdgeReach) {
    const int ex[4] = {0, 1, 0, -1}, ey[4] = {-1, 0, 1, 0};
    for (int i = 0; i < 4; i++)
      if (distanceToSegment(s, c[i], c[(i + 1) % 4]) <= kEdgeReach) {
        hx = ex[i], hy = ey[i];
        return Handle::Resize;
      }
  }
  // Just outside a corner: rotation.
  Vec2 local = m.inverse().apply(s);
  bool outside = local.x < 0 || local.y < 0 || local.x > w || local.y > h;
  if (outside)
    for (int i = 0; i < 4; i++) {
      double d = (s - c[i]).length();
      if (d > kCornerReach && d <= kCornerReach + kRotateReach) {
        hx = cx[i], hy = cy[i];
        return Handle::Rotate;
      }
    }
  return Handle::None;
}

void Editor::updateCursor(Vec2 s) {
  if (spaceHeld_ || tool_ == Tool::HAND) return changeCursor(CursorKind::HAND);
  if (tool_ != Tool::MOVE) return changeCursor(CursorKind::CROSSHAIR);
  int hx = 0, hy = 0;
  Handle h = handleAt(s, hx, hy);
  if (h == Handle::None) return changeCursor(CursorKind::DEFAULT);
  // The angle of the handle's direction on screen (0 = pointing right).
  SelectionBox box = selectionBox(doc_, selection_);
  Mat2x3 m = camera_.matrix() * box.toWorld;
  Vec2 centre = m.apply({box.size.x / 2, box.size.y / 2});
  Vec2 at = m.apply({(hx + 1) * box.size.x / 2, (hy + 1) * box.size.y / 2});
  double angle = std::round(degrees(at - centre));
  changeCursor(h == Handle::Resize ? CursorKind::RESIZE : CursorKind::ROTATE, angle);
}

void Editor::updateHover(Vec2 s, uint32_t mods) {
  Guid next = kNoGuid;
  int hx, hy;
  if (tool_ == Tool::MOVE && !spaceHeld_ && page_ != kNoGuid && handleAt(s, hx, hy) == Handle::None) {
    auto path = hitPath(doc_, page_, camera_.toWorld(s), pixel());
    next = pick(doc_, path, selection_, (mods & MOD_PRIMARY) != 0);
  }
  if (next != hover_) {
    hover_ = next;
    events_.hover = true;
    needsRender_ = true;
  }
  updateMeasure(mods);
  updateAutoLayoutBands(camera_.toWorld(s));
  updateCursor(s);
}

void Editor::updateMeasure(uint32_t mods) {
  // ⌥: the distances from the selection to the hovered layer, or to the selection's parent frame.
  Guid target = kNoGuid;
  std::vector<SpacingMark> marks;
  std::vector<GuideLine> extensions;
  if ((mods & MOD_ALT) && gesture_ == Gesture::None && tool_ == Tool::MOVE && !spaceHeld_ && !selection_.empty()) {
    bool any = false;
    Rect sel;
    for (Guid id : selection_)
      if (doc_.has(id)) sel = any ? sel.united(doc_.worldBounds(id)) : doc_.worldBounds(id), any = true;
    if (hover_ != kNoGuid && !selected(hover_)) {
      target = hover_;
    } else {
      Guid parent = doc_.parentOf(selection_[0]);
      const Node* p = doc_.get(parent);
      if (p && p->props.type != NodeType::CANVAS && p->props.type != NodeType::DOCUMENT) target = parent;
    }
    if (any && target != kNoGuid) measureBetween(sel, doc_.worldBounds(target), marks, extensions);
    else target = kNoGuid;
  }
  bool changed = target != measureTarget_ || marks.size() != measures_.size() || extensions.size() != measureGuides_.size();
  for (size_t i = 0; !changed && i < marks.size(); i++) changed = !(marks[i].a == measures_[i].a && marks[i].b == measures_[i].b);
  measureTarget_ = target;
  measures_ = std::move(marks);
  measureGuides_ = std::move(extensions);
  if (changed) needsRender_ = true;
}

void Editor::updateAutoLayoutBands(Vec2 world) {
  // A selected auto-layout frame shows its padding (the side under the pointer) or its gaps (all of them).
  std::vector<Rect> bands;
  if (gesture_ == Gesture::None && tool_ == Tool::MOVE && !spaceHeld_ && selection_.size() == 1) {
    Guid id = selection_[0];
    const Node* n = doc_.get(id);
    Mat2x3 W = doc_.worldTransform(id);
    if (n && n->props.isAutoLayout() && axisAligned(W) && W.m00 > 0 && W.m11 > 0) {
      const NodeProps& p = n->props;
      Vec2 q = W.inverse().apply(world);
      double w = p.size.x, h = p.size.y;
      if (q.x >= 0 && q.y >= 0 && q.x <= w && q.y <= h) {
        int P = p.stackMode == StackMode::HORIZONTAL ? 0 : 1;
        double pad[4];
        Layout::padding(p, pad);
        auto inside = [&](const Rect& r) { return r.w > 0 && r.h > 0 && r.contains(q); };
        bool onChild = false;
        std::vector<Rect> boxes;
        for (Guid c : Layout(*this).flowChildren(id)) {
          const NodeProps& cp = doc_.get(c)->props;
          boxes.push_back(layoutBox(cp.transform, cp.size));
          onChild |= boxes.back().contains(q);
        }
        std::vector<Rect> gaps;
        for (size_t i = 1; i < boxes.size() && p.stackWrap != StackWrap::WRAP; i++) {
          const Rect& a = boxes[i - 1];
          const Rect& b = boxes[i];
          if (P == 0 && b.x > a.right()) gaps.push_back({a.right(), pad[1], b.x - a.right(), h - pad[1] - pad[3]});
          if (P == 1 && b.y > a.bottom()) gaps.push_back({pad[0], a.bottom(), w - pad[0] - pad[2], b.y - a.bottom()});
        }
        Rect sides[4] = {{0, 0, pad[0], h}, {0, 0, w, pad[1]}, {w - pad[2], 0, pad[2], h}, {0, h - pad[3], w, pad[3]}};
        if (!onChild) {
          bool inGap = false;
          for (auto& g : gaps) inGap |= inside(g);
          if (inGap) bands = gaps;
          else
            for (auto& side : sides)
              if (inside(side)) {
                bands.push_back(side);
                break;
              }
        }
        for (auto& b : bands) b = transformedBounds(W * Mat2x3::translate(b.x, b.y), b.w, b.h);
      }
    }
  }
  if (!(bands.size() == bands_.size() && std::equal(bands.begin(), bands.end(), bands_.begin()))) needsRender_ = true;
  bands_ = std::move(bands);
}

// ---- Pointer and wheel ------------------------------------------------------

uint32_t Editor::pointer(PointerEvent type, double x, double y, int button, uint32_t /*buttons*/, uint32_t mods, int /*clickCount*/) {
  mods_ = mods;
  Vec2 s{x, y};
  switch (type) {
    case PointerEvent::DOWN: return pointerDown(s, button, mods);
    case PointerEvent::MOVE: pointerMove(s, mods); return 0;
    case PointerEvent::UP: {
      bool had = gesture_ != Gesture::None;
      pointerUp(s, mods);
      return had ? P_HANDLED : 0;
    }
    case PointerEvent::CANCEL: cancelGesture(); return P_HANDLED;
    case PointerEvent::LEAVE:
      if (gesture_ == Gesture::None && hover_ != kNoGuid) {
        hover_ = kNoGuid;
        events_.hover = true;
        needsRender_ = true;
      }
      return 0;
    case PointerEvent::ENTER: return 0;
  }
  return 0;
}

uint32_t Editor::wheel(double x, double y, double dx, double dy, DeltaMode mode, uint32_t mods, uint32_t flags) {
  double unit = mode == DeltaMode::LINE ? 16 : mode == DeltaMode::PAGE ? std::max(1.0, viewport_.height) : 1;
  if ((flags & WHEEL_PINCH) || (mods & (MOD_CTRL | MOD_META))) {
    // A pinch (ctrlKey from a trackpad) or ⌘/Ctrl + wheel zooms about the pointer.
    double rate = mode == DeltaMode::LINE ? 0.05 : 0.01;
    changeCamera(camera_.zoomedAround(camera_.zoom * std::exp(-dy * (mode == DeltaMode::PAGE ? unit : 1) * rate), {x, y}));
  } else if ((mods & MOD_SHIFT) && dx == 0) {
    changeCamera(camera_.panned(-dy * unit, 0));
  } else {
    changeCamera(camera_.panned(-dx * unit, -dy * unit));
  }
  // The pointer now sits over another part of the page: carry on whatever it was doing there.
  lastScreen_ = {x, y};
  if (gesture_ == Gesture::None) updateHover(lastScreen_, mods);
  else if (gesture_ != Gesture::Pan) pointerMove(lastScreen_, mods);
  return P_HANDLED;
}

uint32_t Editor::pointerDown(Vec2 s, int button, uint32_t mods) {
  if (gesture_ != Gesture::None || page_ == kNoGuid) return 0;
  downScreen_ = lastScreen_ = s;
  downWorld_ = camera_.toWorld(s);
  downCamera_ = camera_;
  downMods_ = mods;
  baseSelection_ = selection_;

  if (button == 1 || (button == 0 && (tool_ == Tool::HAND || spaceHeld_))) {
    gesture_ = Gesture::Pan;
    changeCursor(CursorKind::GRABBING);
    return P_HANDLED | P_CAPTURE;
  }
  // A right-click, or ⌃-click where ⌃ isn't the command key (a Mac).
  if (button == 2 || (button == 0 && (mods & MOD_CTRL) && !(mods & MOD_PRIMARY))) return contextMenu(s, mods);
  if (button != 0) return 0;

  if (tool_ == Tool::FRAME || tool_ == Tool::RECTANGLE || tool_ == Tool::ELLIPSE) {
    drawType_ = tool_ == Tool::FRAME ? NodeType::FRAME : tool_ == Tool::RECTANGLE ? NodeType::ROUNDED_RECTANGLE : NodeType::ELLIPSE;
    // Into the innermost frame under the press (the page when none).
    drawParent_ = page_;
    auto path = hitPath(doc_, page_, downWorld_, pixel());
    for (auto it = path.rbegin(); it != path.rend(); ++it)
      if (doc_.get(*it)->props.isFrameLike()) {
        drawParent_ = *it;
        break;
      }
    drawn_ = kNoGuid;
    prepareSnapping(drawParent_, {});
    gesture_ = Gesture::Draw;
    return P_HANDLED | P_CAPTURE;
  }

  int hx = 0, hy = 0;
  Handle h = handleAt(s, hx, hy);
  if (h == Handle::Resize) {
    startResize(hx, hy);
    gesture_ = Gesture::Resize;
    return P_HANDLED | P_CAPTURE;
  }
  if (h == Handle::Rotate) {
    startRotate();
    gesture_ = Gesture::Rotate;
    return P_HANDLED | P_CAPTURE;
  }

  bool deep = (mods & MOD_PRIMARY) != 0, shift = (mods & MOD_SHIFT) != 0;
  auto path = hitPath(doc_, page_, downWorld_, pixel());
  pressed_ = pick(doc_, path, selection_, deep);
  pressMarquee_ = false;
  marqueeScope_ = kNoGuid;
  pressedWasSelected_ = pressed_ != kNoGuid && selected(pressed_);
  if (pressed_ == kNoGuid) {
    pressMarquee_ = true;
  } else if (!deep && path.size() == 1 && doc_.get(path[0])->props.isFrameLike() && !pressedWasSelected_ &&
             !doc_.children(path[0]).empty()) {
    // A top-level frame's own background: a drag is a marquee among its children, a click selects it.
    pressMarquee_ = true;
    marqueeScope_ = path[0];
  } else if (!pressedWasSelected_) {
    std::vector<Guid> next = shift ? selection_ : std::vector<Guid>{};
    next.push_back(pressed_);
    changeSelection(std::move(next));
  }
  gesture_ = Gesture::Press;
  return P_HANDLED | P_CAPTURE;
}

uint32_t Editor::contextMenu(Vec2 s, uint32_t mods) {
  // As Figma: what a click would pick becomes the selection unless it is already
  // selected; on empty canvas the selection stays. TS draws the menu.
  Vec2 world = camera_.toWorld(s);
  ContextMenu menu;
  menu.x = s.x;
  menu.y = s.y;
  if (tool_ != Tool::MOVE) setTool(Tool::MOVE);
  auto path = hitPath(doc_, page_, world, pixel());
  Guid picked = pick(doc_, path, selection_, (mods & MOD_PRIMARY) != 0);
  if (picked != kNoGuid && !selected(picked)) changeSelection({picked});
  for (auto& p : hitPaths(doc_, page_, world, pixel())) {
    std::reverse(p.begin(), p.end());
    menu.hits.push_back(std::move(p));
  }
  menu.selection = !selection_.empty();
  events_.contextMenus.push_back(std::move(menu));
  needsRender_ = true;
  return P_HANDLED;
}

void Editor::pointerMove(Vec2 s, uint32_t mods) {
  lastScreen_ = s;
  Vec2 world = camera_.toWorld(s);
  switch (gesture_) {
    case Gesture::None: updateHover(s, mods); break;
    case Gesture::Pan: changeCamera(downCamera_.panned(s.x - downScreen_.x, s.y - downScreen_.y)); break;
    case Gesture::Press:
      if ((s - downScreen_).length() < kDragThreshold) break;
      if (pressMarquee_) {
        gesture_ = Gesture::Marquee;
        dragMarquee(world, mods);
      } else {
        startMove(mods);
        gesture_ = Gesture::Move;
        dragMove(world, mods);
      }
      break;
    case Gesture::Move: dragMove(world, mods); break;
    case Gesture::Resize: dragResize(world, mods); break;
    case Gesture::Rotate: dragRotate(world, mods); break;
    case Gesture::Draw:
      if (drawn_ == kNoGuid && (s - downScreen_).length() < kDragThreshold) break;
      dragDraw(world, mods, false);
      break;
    case Gesture::Marquee: dragMarquee(world, mods); break;
  }
}

void Editor::pointerUp(Vec2 s, uint32_t mods) {
  lastScreen_ = s;
  Vec2 world = camera_.toWorld(s);
  switch (gesture_) {
    case Gesture::None: return;
    case Gesture::Pan: break;
    case Gesture::Press: finishClick(mods); break;
    case Gesture::Move: finishMove(); break;
    case Gesture::Resize:
    case Gesture::Rotate: commit(); break;
    case Gesture::Draw:
      if (drawn_ == kNoGuid) dragDraw(world, mods, true);
      if (excluded_.count(drawn_)) layoutDirty_.insert(doc_.parentOf(drawn_));
      excluded_.clear();
      commit();
      drawn_ = kNoGuid;
      gesture_ = Gesture::None;
      setTool(Tool::MOVE);  // after a draw, back to Move (Figma)
      break;
    case Gesture::Marquee: needsRender_ = true; break;
  }
  gesture_ = Gesture::None;
  endGesture();
  updateHover(s, mods);
}

void Editor::endGesture() {
  targets_.clear();
  originalTargets_.clear();
  originals_.clear();
  duplicating_ = false;
  excluded_.clear();
  pinned_.clear();
  guides_.clear();
  spacings_.clear();
  hasInsertion_ = false;
  dropParent_ = kNoGuid;
  snapParent_ = kNoGuid;
  needsRender_ = true;
}

void Editor::redrag(uint32_t mods) { pointerMove(lastScreen_, mods); }

void Editor::cancelGesture() {
  switch (gesture_) {
    case Gesture::Move:
    case Gesture::Resize:
    case Gesture::Rotate: rollback(); break;
    case Gesture::Draw:
      if (drawn_ != kNoGuid) rollback();
      changeSelection(baseSelection_);
      break;
    case Gesture::Marquee:
      changeSelection(baseSelection_);
      needsRender_ = true;
      break;
    default: break;
  }
  gesture_ = Gesture::None;
  endGesture();
  drawn_ = kNoGuid;
  pruneSelection();
  updateCursor(lastScreen_);
}

void Editor::finishClick(uint32_t mods) {
  bool shift = (mods & MOD_SHIFT) != 0;
  if (pressMarquee_) {
    if (marqueeScope_ != kNoGuid) {
      std::vector<Guid> next = shift ? selection_ : std::vector<Guid>{};
      auto it = std::find(next.begin(), next.end(), marqueeScope_);
      if (it != next.end()) next.erase(it);
      else next.push_back(marqueeScope_);
      changeSelection(std::move(next));
    } else if (!shift) {
      changeSelection({});
    }
    return;
  }
  if (pressed_ == kNoGuid || !pressedWasSelected_) return;
  if (shift) {
    std::vector<Guid> next = selection_;
    next.erase(std::remove(next.begin(), next.end(), pressed_), next.end());
    changeSelection(std::move(next));
  } else if (selection_.size() > 1) {
    changeSelection({pressed_});
  }
}

// ---- Gestures ---------------------------------------------------------------

std::vector<Editor::Target> Editor::targetsOf(const std::vector<Guid>& ids) const {
  std::vector<Target> out;
  for (Guid id : ids) {
    const Node* n = doc_.get(id);
    if (!n || n->props.locked) continue;
    out.push_back({id, n->props.transform, doc_.worldTransform(id), n->props.size, n->props.parentIndex.guid,
                   n->props.parentIndex.position});
  }
  return out;
}

void Editor::prepareSnapping(Guid parent, const std::unordered_set<Guid, GuidHash>& moving) {
  // What can be snapped to: the parent's other children in and around the view, and the parent frame.
  snapParent_ = parent;
  std::vector<Rect> boxes;
  Vec2 a = camera_.toWorld({0, 0}), b = camera_.toWorld({viewport_.width, viewport_.height});
  Rect view = Rect::fromPoints(a, b);
  double margin = std::max(view.w, view.h) * 0.5;
  view = {view.x - margin, view.y - margin, view.w + 2 * margin, view.h + 2 * margin};
  doc_.query(page_, view, [&](Guid id) {
    const Node* n = doc_.get(id);
    if (n && n->props.parentIndex.guid == parent && !moving.count(id) && n->props.visible) boxes.push_back(doc_.worldBounds(id));
    return true;
  });
  std::optional<Rect> container;
  const Node* p = doc_.get(parent);
  if (p && p->props.isFrameLike()) container = doc_.worldBounds(parent);
  snapper_.reset(std::move(boxes), container);
}

Guid Editor::dropTargetAt(Vec2 world) const {
  // The topmost frame under the pointer that isn't being moved (nor inside what is): its box, inside every
  // frame that clips it. Instances and locked or hidden frames don't take layers.
  GuidSet moving;
  for (const Target& t : targets_) moving.insert(t.id);
  Guid best = page_;
  doc_.query(page_, Rect{world.x, world.y, 0, 0}, [&](Guid id) {
    const Node* n = doc_.get(id);
    if (!n || !n->props.isFrameLike() || n->props.type == NodeType::INSTANCE) return true;
    if (!doc_.visibleInTree(id)) return true;
    bool ok = true;
    for (Guid cur = id; ok && doc_.has(cur); cur = doc_.parentOf(cur)) {
      const Node* c = doc_.get(cur);
      if (c->props.type == NodeType::CANVAS || c->props.type == NodeType::DOCUMENT) break;
      if (moving.count(cur) || c->props.locked) ok = false;
      Vec2 q = doc_.worldTransform(cur).inverse().apply(world);
      bool in = q.x >= 0 && q.y >= 0 && q.x <= c->props.size.x && q.y <= c->props.size.y;
      if (!in && (cur == id || c->props.clipsContent())) ok = false;
    }
    if (ok && (best == page_ || doc_.paintsBefore(best, id))) best = id;
    return true;
  });
  return best;
}

Guid Editor::containerOf(Guid parent) const {
  // A group's layers belong where the group is: the nearest frame (or page) above them.
  Guid cur = parent;
  for (int guard = 0; guard < 100000; guard++) {
    const Node* n = doc_.get(cur);
    if (!n || !n->props.isGroupLike()) return cur;
    cur = n->props.parentIndex.guid;
  }
  return cur;
}

void Editor::startMove(uint32_t mods) {
  begin(TxnKind::GESTURE, "Move");
  targets_ = targetsOf(topSelectionInPaintOrder());
  originalTargets_ = targets_;
  originals_.clear();
  duplicating_ = false;
  excluded_.clear();
  pinned_.clear();
  bool any = false;
  for (const Target& t : targets_) {
    pinned_.insert(t.id);  // layout leaves it to the pointer while it moves
    Rect b = doc_.worldBounds(t.id);
    moveBox_ = any ? moveBox_.united(b) : b;
    any = true;
  }
  dropParent_ = snapParent_ = kNoGuid;
  hasInsertion_ = false;
  if (mods & MOD_ALT) setDuplicating(true);
}

void Editor::setDuplicating(bool on) {
  if (on == duplicating_ || originalTargets_.empty()) return;
  auto putBack = [&](const Target& t) {
    NodeChange c = NodeChange::changed(t.id);
    c.mask = F_PARENT_INDEX | F_TRANSFORM;
    c.props.parentIndex = {t.parent, t.position};
    c.props.transform = t.transform;
    write(c);
  };
  if (on) {
    // ⌥: the copies move; the originals go back where they were.
    for (const Target& t : originalTargets_) putBack(t);
    targets_.clear();
    originals_.clear();
    std::vector<Guid> copies;
    for (const Target& t : originalTargets_) {
      const auto& siblings = doc_.children(t.parent);
      size_t index = static_cast<size_t>(std::find(siblings.begin(), siblings.end(), t.id) - siblings.begin()) + 1;
      std::string key = placeAt(t.parent, index, kNoGuid);
      Target copy = t;
      copy.id = cloneSubtree(t.id, t.parent, key, t.transform);
      copy.position = key;
      targets_.push_back(copy);
      originals_.push_back(t.id);
      copies.push_back(copy.id);
    }
    excluded_.clear();
    pinned_.clear();
    for (const Target& t : targets_) excluded_.insert(t.id);  // a copy takes no space until dropped
    changeSelection(std::move(copies));
    duplicating_ = true;
  } else {
    // ⌥ let go mid-drag: the copies go away and the originals move again.
    for (const Target& t : targets_) {
      std::vector<Guid> order;
      auto collect = [&](auto&& self, Guid id) -> void {
        std::vector<Guid> kids = doc_.children(id);
        for (Guid c : kids) self(self, c);
        order.push_back(id);
      };
      collect(collect, t.id);
      for (Guid id : order) write(NodeChange::removed(id));
    }
    targets_ = originalTargets_;
    originals_.clear();
    excluded_.clear();
    pinned_.clear();
    for (const Target& t : targets_) pinned_.insert(t.id);
    std::vector<Guid> ids;
    for (const Target& t : targets_) ids.push_back(t.id);
    changeSelection(std::move(ids));
    duplicating_ = false;
  }
  dropParent_ = snapParent_ = kNoGuid;
  changeCursor(duplicating_ ? CursorKind::MOVE_DUPLICATE : CursorKind::DEFAULT);
}

void Editor::dragMove(Vec2 world, uint32_t mods) {
  if (((mods & MOD_ALT) != 0) != duplicating_) setDuplicating((mods & MOD_ALT) != 0);
  if (targets_.empty()) return;
  Vec2 d = world - downWorld_;
  bool lockX = false, lockY = false;
  if (mods & MOD_SHIFT) {
    if (std::fabs(d.x) > std::fabs(d.y)) d.y = 0, lockY = true;
    else d.x = 0, lockX = true;
  }
  const bool keepParent = (mods & MOD_PRIMARY) != 0;
  const bool snapping = !(mods & (MOD_CTRL | MOD_PRIMARY));

  // Into the frame under the pointer, out of the one it left (⌘ keeps the parents).
  Guid drop = keepParent ? kNoGuid : dropTargetAt(world);
  for (const Target& t : targets_) {
    const Node* n = doc_.get(t.id);
    if (!n) continue;
    Guid now = n->props.parentIndex.guid;
    Guid want = now;
    if (!keepParent) want = drop == containerOf(t.parent) ? t.parent : drop;
    if (want == now) continue;
    NodeChange c = NodeChange::changed(t.id);
    c.mask = F_PARENT_INDEX;
    c.props.parentIndex = {want, want == t.parent ? t.position : placeAt(want, doc_.children(want).size(), t.id)};
    write(c);
  }
  // In its own frame it keeps its slot; anywhere else (and a copy anywhere) it takes no space until dropped.
  for (const Target& t : targets_) {
    bool home = !duplicating_ && doc_.parentOf(t.id) == t.parent;
    if (home) excluded_.erase(t.id), pinned_.insert(t.id);
    else pinned_.erase(t.id), excluded_.insert(t.id);
  }
  Guid parent = doc_.parentOf(targets_[0].id);
  dropParent_ = parent;
  const Node* pn = doc_.get(parent);
  bool intoAutoLayout = pn && pn->props.isAutoLayout();

  // Snap the moving box (not inside auto layout: the flow places it), else whole pixels.
  guides_.clear();
  spacings_.clear();
  Rect box{moveBox_.x + d.x, moveBox_.y + d.y, moveBox_.w, moveBox_.h};
  SnapResult snap;
  if (snapping && !intoAutoLayout) {
    if (snapParent_ != parent) {
      GuidSet moving;
      for (const Target& t : targets_) moving.insert(t.id);
      for (Guid o : originals_) moving.insert(o);
      prepareSnapping(parent, moving);
    }
    snap = snapper_.snapBox(box, kSnapReach / camera_.zoom, !lockX, !lockY);
  }
  d.x = snap.snappedX ? d.x + snap.offset.x : std::round(moveBox_.x + d.x) - moveBox_.x;
  d.y = snap.snappedY ? d.y + snap.offset.y : std::round(moveBox_.y + d.y) - moveBox_.y;
  if (lockX) d.x = 0;
  if (lockY) d.y = 0;
  guides_ = std::move(snap.guides);
  spacings_ = std::move(snap.spacings);

  // Each layer goes where its start, moved by d, lands, under whatever its parent is now.
  Mat2x3 by = Mat2x3::translate(d.x, d.y);
  for (const Target& t : targets_) {
    const Node* n = doc_.get(t.id);
    if (!n) continue;
    NodeChange c = NodeChange::changed(t.id);
    c.mask = F_TRANSFORM;
    c.props.transform = tidy(doc_.worldTransform(n->props.parentIndex.guid).inverse() * by * t.world);
    if (n->props.transform == c.props.transform) continue;
    write(c);
  }
  flushLayout();
  if (intoAutoLayout) updateInsertion(parent, world);
  else hasInsertion_ = false;
  needsRender_ = true;
}

void Editor::updateInsertion(Guid frame, Vec2 world) {
  // Where the dragged layers will join the flow: before the first child whose middle is past the pointer.
  const NodeProps& fp = doc_.get(frame)->props;
  int P = fp.stackMode == StackMode::HORIZONTAL ? 0 : 1, C = 1 - P;
  std::vector<Guid> flow;
  for (Guid c : Layout(*this).flowChildren(frame))
    if (!placedByGesture(c)) flow.push_back(c);
  Mat2x3 W = doc_.worldTransform(frame);
  Vec2 q = W.inverse().apply(world);
  auto lo = [](const Rect& r, int a) { return a == 0 ? r.x : r.y; };
  auto hi = [](const Rect& r, int a) { return a == 0 ? r.right() : r.bottom(); };
  std::vector<Rect> boxes;
  for (Guid c : flow) boxes.push_back(layoutBox(doc_.get(c)->props.transform, doc_.get(c)->props.size));
  double qp = P == 0 ? q.x : q.y, qc = C == 0 ? q.x : q.y;
  size_t i = 0;
  if (fp.stackWrap == StackWrap::WRAP && P == 0) {
    // Wrapped rows: the first child past the pointer on its row (or any later row).
    for (; i < boxes.size(); i++) {
      const Rect& b = boxes[i];
      if (b.y > qc || (qc <= b.bottom() && qp < b.x + b.w / 2)) break;
    }
  } else {
    for (; i < boxes.size(); i++)
      if (qp < lo(boxes[i], P) + (hi(boxes[i], P) - lo(boxes[i], P)) / 2) break;
  }
  insertIndex_ = i;
  double pad[4];
  Layout::padding(fp, pad);
  double at;
  double c0 = C == 0 ? pad[0] : pad[1], c1 = (C == 0 ? fp.size.x - pad[2] : fp.size.y - pad[3]);
  if (boxes.empty()) at = P == 0 ? pad[0] : pad[1];
  else if (i == 0) at = lo(boxes[0], P);
  else if (i == boxes.size()) at = hi(boxes.back(), P);
  else at = (hi(boxes[i - 1], P) + lo(boxes[i], P)) / 2;
  if (fp.stackWrap == StackWrap::WRAP && P == 0 && !boxes.empty()) {
    // The row's own height.
    const Rect& row = boxes[std::min(i, boxes.size() - 1)];
    const Rect& prev = i > 0 ? boxes[i - 1] : row;
    if (i == boxes.size() || (i > 0 && prev.y == row.y)) {
      c0 = prev.y, c1 = prev.bottom();
      if (i > 0 && i < boxes.size() && prev.y != row.y) at = hi(prev, P);
    } else {
      c0 = row.y, c1 = row.bottom();
    }
  }
  if (c1 <= c0) c1 = c0 + 1;
  Vec2 a = P == 0 ? Vec2{at, c0} : Vec2{c0, at};
  Vec2 b = P == 0 ? Vec2{at, c1} : Vec2{c1, at};
  insertion_ = {W.apply(a), W.apply(b)};
  hasInsertion_ = true;
}

void Editor::finishMove() {
  GuidSet moving;
  for (const Target& t : targets_) moving.insert(t.id);
  const Node* pn = doc_.get(dropParent_);
  if (hasInsertion_ && pn && pn->props.isAutoLayout()) {
    // Into the flow at the insertion index (counted among the flow children without the dragged ones).
    std::vector<Guid> flow;
    for (Guid c : Layout(*this).flowChildren(dropParent_))
      if (!moving.count(c)) flow.push_back(c);
    std::vector<Guid> others;
    for (Guid c : doc_.children(dropParent_))
      if (!moving.count(c)) others.push_back(c);
    size_t index = others.size();
    if (insertIndex_ < flow.size()) index = static_cast<size_t>(std::find(others.begin(), others.end(), flow[insertIndex_]) - others.begin());
    else if (!flow.empty()) index = static_cast<size_t>(std::find(others.begin(), others.end(), flow.back()) - others.begin()) + 1;
    std::vector<Guid> ids;
    for (const Target& t : targets_)
      if (doc_.parentOf(t.id) == dropParent_) ids.push_back(t.id);
    auto keys = placeManyAt(dropParent_, index, ids.size(), moving);
    for (size_t i = 0; i < ids.size(); i++) {
      NodeChange c = NodeChange::changed(ids[i]);
      c.mask = F_PARENT_INDEX;
      c.props.parentIndex = {dropParent_, keys[i]};
      write(c);
    }
  }
  // Back into the flow: their auto-layout parents lay out again.
  for (const Target& t : targets_) {
    const Node* p = doc_.get(doc_.parentOf(t.id));
    if (p && p->props.isAutoLayout()) layoutDirty_.insert(doc_.parentOf(t.id));
  }
  excluded_.clear();
  pinned_.clear();
  commit();
}

void Editor::startResize(int hx, int hy) {
  begin(TxnKind::GESTURE, "Resize");
  handleX_ = hx;
  handleY_ = hy;
  box_ = selectionBox(doc_, selection_);
  std::vector<Guid> ids = topLevelSelection(doc_, selection_);
  // A group has no size of its own: resizing it resizes what is in it.
  GuidSet moving(ids.begin(), ids.end());
  Guid parent = ids.empty() ? page_ : doc_.parentOf(ids[0]);
  if (ids.size() == 1 && doc_.get(ids[0])->props.isGroupLike()) ids = doc_.children(ids[0]);
  targets_ = targetsOf(ids);
  for (const Target& t : targets_) moving.insert(t.id);
  prepareSnapping(parent, moving);
  changeCursor(cursor_, cursorAngle_);
}

void Editor::dragResize(Vec2 world, uint32_t mods) {
  const double W = box_.size.x, H = box_.size.y;
  if (!(W > 0) || !(H > 0)) return;
  bool alt = (mods & MOD_ALT) != 0, shift = (mods & MOD_SHIFT) != 0;
  // Snap the dragged edge (boxes turned against the page don't snap).
  bool snapping = !(mods & (MOD_CTRL | MOD_PRIMARY)) && axisAligned(box_.toWorld);
  SnapResult snap;
  if (snapping) {
    snap = snapper_.snapPoint(world, kSnapReach / camera_.zoom, handleX_ != 0, handleY_ != 0);
    world = world + snap.offset;
  }
  Vec2 p = box_.toWorld.inverse().apply(world);

  // Where the dragged edges go, in the box's own space [0,W]×[0,H]. Past the
  // opposite edge the extent turns negative: the box flips.
  auto follow = [&](int h, double pos, double len, double& lo, double& hi) {
    if (h == 0) lo = 0, hi = len;
    else if (h > 0) hi = pos, lo = alt ? len - pos : 0;
    else lo = pos, hi = alt ? len - pos : len;
  };
  auto place = [&](int h, double len, double scale, double& lo, double& hi) {
    if (alt || h == 0) lo = len / 2 - len * scale / 2, hi = len / 2 + len * scale / 2;
    else if (h > 0) lo = 0, hi = len * scale;
    else hi = len, lo = len - len * scale;
  };
  double x0, x1, y0, y1;
  follow(handleX_, p.x, W, x0, x1);
  follow(handleY_, p.y, H, y0, y1);
  if (shift) {
    double sx = (x1 - x0) / W, sy = (y1 - y0) / H;
    if (handleX_ && handleY_) {
      double s = std::max(std::fabs(sx), std::fabs(sy));
      sx = std::copysign(s, sx);
      sy = std::copysign(s, sy);
    } else if (handleX_) {
      sy = std::fabs(sx);
    } else {
      sx = std::fabs(sy);
    }
    place(handleX_, W, sx, x0, x1);
    place(handleY_, H, sy, y0, y1);
  }
  // Pixel-grid snapping: whole px when the box is at least 1 px; never zero.
  auto toPixels = [](double& lo, double& hi, double len) {
    double sign = hi >= lo ? 1 : -1;
    if (len >= 1) {
      lo = std::round(lo);
      hi = std::round(hi);
      if (std::fabs(hi - lo) < 1) hi = lo + sign;
    } else if (std::fabs(hi - lo) < 0.01) {
      hi = lo + 0.01 * sign;
    }
  };
  toPixels(x0, x1, W);
  toPixels(y0, y1, H);

  Mat2x3 boxScale{(x1 - x0) / W, 0, x0, 0, (y1 - y0) / H, y0};
  Mat2x3 S = box_.toWorld * boxScale * box_.toWorld.inverse();
  for (const Target& t : targets_) {
    Mat2x3 nextWorld = S * t.world;
    Mat2x3 local = t.world.inverse() * nextWorld;
    NodeChange c = NodeChange::changed(t.id);
    c.mask = F_TRANSFORM | F_SIZE;
    const double eps = 1e-6;
    if (std::fabs(local.m01) < eps && std::fabs(local.m10) < eps) {
      // Aligned with the box: the node grows along its own axes (a negative scale flips it).
      double ax = std::fabs(local.m00), ay = std::fabs(local.m11);
      c.props.size = {t.size.x * ax, t.size.y * ay};
      Mat2x3 unscale{ax > 0 ? 1 / ax : 1, 0, 0, 0, ay > 0 ? 1 / ay : 1, 0};
      c.props.transform = doc_.worldTransform(t.parent).inverse() * nextWorld * unscale;
    } else {
      // Turned against the box: it keeps its size and follows with its centre.
      Vec2 centre = t.world.apply({t.size.x / 2, t.size.y / 2});
      Vec2 dc = S.apply(centre) - centre;
      c.props.size = t.size;
      c.props.transform = doc_.worldTransform(t.parent).inverse() * Mat2x3::translate(dc.x, dc.y) * t.world;
    }
    write(c);
    keepResizedSize(t.id, handleX_ != 0 || (shift && handleY_ != 0), handleY_ != 0 || (shift && handleX_ != 0));
  }
  guides_.clear();
  if (snapping && (snap.snappedX || snap.snappedY))
    guides_ = snapper_.guidesFor(transformedBounds(box_.toWorld * boxScale, W, H), snap.snappedX, snap.snappedY);
  flushLayout();
  needsRender_ = true;
}

void Editor::keepResizedSize(Guid id, bool x, bool y) {
  // Resizing a layer by hand fixes the axes it changed: Fill → Fixed, Stretch → Auto, Hug → Fixed.
  const Node* n = doc_.get(id);
  if (!n || (!x && !y)) return;
  const NodeProps& p = n->props;
  const Node* parent = doc_.get(p.parentIndex.guid);
  NodeChange c = NodeChange::changed(id);
  if (parent && parent->props.isAutoLayout() && p.inFlow()) {
    bool horizontal = parent->props.stackMode == StackMode::HORIZONTAL;
    bool primary = horizontal ? x : y, counter = horizontal ? y : x;
    if (primary && p.stackChildPrimaryGrow > 0) c.mask |= F_STACK_CHILD_GROW, c.props.stackChildPrimaryGrow = 0;
    if (counter && p.stackChildAlignSelf == StackCounterAlign::STRETCH)
      c.mask |= F_STACK_CHILD_ALIGN_SELF, c.props.stackChildAlignSelf = StackCounterAlign::AUTO;
  }
  if (p.isAutoLayout()) {
    bool horizontal = p.stackMode == StackMode::HORIZONTAL;
    bool primary = horizontal ? x : y, counter = horizontal ? y : x;
    if (primary && p.hugsPrimary()) c.mask |= F_STACK_PRIMARY_SIZING, c.props.stackPrimarySizing = StackSize::FIXED;
    if (counter && p.hugsCounter()) c.mask |= F_STACK_COUNTER_SIZING, c.props.stackCounterSizing = StackSize::FIXED;
  }
  if (c.mask) write(c);
}

void Editor::startRotate() {
  begin(TxnKind::GESTURE, "Rotate");
  box_ = selectionBox(doc_, selection_);
  targets_ = targetsOf(topLevelSelection(doc_, selection_));
}

void Editor::dragRotate(Vec2 world, uint32_t mods) {
  if (targets_.empty()) return;
  Vec2 centre = box_.toWorld.apply({box_.size.x / 2, box_.size.y / 2});
  Vec2 a = downWorld_ - centre, b = world - centre;
  double delta = std::atan2(b.y, b.x) - std::atan2(a.y, a.x);
  if (mods & MOD_SHIFT) {
    // ⇧ snaps the first layer's rotation to 15°.
    const Mat2x3& w = targets_[0].world;
    double r0 = std::atan2(w.m10, w.m00);
    double step = kPi / 12;
    delta = std::round((r0 + delta) / step) * step - r0;
  }
  Mat2x3 R = Mat2x3::translate(centre.x, centre.y) * Mat2x3::rotate(delta) * Mat2x3::translate(-centre.x, -centre.y);
  for (const Target& t : targets_) {
    NodeChange c = NodeChange::changed(t.id);
    c.mask = F_TRANSFORM;
    c.props.transform = doc_.worldTransform(doc_.parentOf(t.id)).inverse() * R * t.world;
    write(c);
  }
  flushLayout();
  changeCursor(CursorKind::ROTATE, std::round(degrees(camera_.toScreen(world) - camera_.toScreen(centre))));
}

void Editor::dragDraw(Vec2 world, uint32_t mods, bool click) {
  Rect r;
  // Both corners snap to the parent's other layers and the parent frame.
  bool snapping = !(mods & (MOD_CTRL | MOD_PRIMARY));
  double reach = kSnapReach / camera_.zoom;
  Vec2 start = downWorld_;
  SnapResult s0, s1;
  if (snapping) {
    s0 = snapper_.snapPoint(start, reach, true, true);
    start = start + s0.offset;
  }
  if (snapping && !click && !(mods & MOD_SHIFT)) {
    s1 = snapper_.snapPoint(world, reach, true, true);
    world = world + s1.offset;
  }
  if (click) {
    r = {start.x, start.y, 100, 100};  // a click makes 100×100
  } else {
    Vec2 d = world - start;
    if (mods & MOD_SHIFT) {
      double s = std::max(std::fabs(d.x), std::fabs(d.y));
      d = {std::copysign(s, d.x), std::copysign(s, d.y)};
    }
    r = (mods & MOD_ALT) ? Rect::fromPoints(start - d, start + d) : Rect::fromPoints(start, start + d);
  }
  double x0 = std::round(r.x), y0 = std::round(r.y);
  double x1 = std::max(x0 + 1, std::round(r.right())), y1 = std::max(y0 + 1, std::round(r.bottom()));
  Mat2x3 parentInv = doc_.worldTransform(drawParent_).inverse();

  NodeChange c;
  if (drawn_ == kNoGuid) {
    begin(TxnKind::GESTURE, drawType_ == NodeType::FRAME ? "Create frame" : drawType_ == NodeType::ELLIPSE ? "Create ellipse" : "Create rectangle");
    Guid id = newGuid();
    c = NodeChange::created(id, defaultProps(drawType_));
    c.props.name = nextName(drawType_ == NodeType::FRAME ? "Frame" : drawType_ == NodeType::ELLIPSE ? "Ellipse" : "Rectangle");
    c.props.parentIndex = {drawParent_, placeAt(drawParent_, doc_.children(drawParent_).size(), kNoGuid)};
    drawn_ = id;
    // Drawn inside auto layout: it joins the flow when the drawing ends.
    const Node* dp = doc_.get(drawParent_);
    if (dp && dp->props.isAutoLayout()) excluded_.insert(id);
  } else {
    c = NodeChange::changed(drawn_);
    c.mask = F_TRANSFORM | F_SIZE;
  }
  c.props.transform = parentInv * Mat2x3::translate(x0, y0);
  c.props.size = {x1 - x0, y1 - y0};
  write(c);
  changeSelection({drawn_});
  guides_.clear();
  bool sx = s0.snappedX || s1.snappedX, sy = s0.snappedY || s1.snappedY;
  if (snapping && (sx || sy)) guides_ = snapper_.guidesFor({x0, y0, x1 - x0, y1 - y0}, sx, sy);
  flushLayout();
  needsRender_ = true;
}

void Editor::dragMarquee(Vec2 world, uint32_t mods) {
  marquee_ = Rect::fromPoints(downWorld_, world);
  needsRender_ = true;
  std::vector<Guid> hits = marqueeHits(doc_, page_, marquee_, marqueeScope_);
  std::vector<Guid> next;
  if ((mods | downMods_) & MOD_SHIFT) next = baseSelection_;
  for (Guid h : hits)
    if (std::find(next.begin(), next.end(), h) == next.end()) next.push_back(h);
  changeSelection(std::move(next));
}

}  // namespace eng
