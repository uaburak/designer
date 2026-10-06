// The pointer side of the editor: hover, handles, and the gestures — pan,
// press/click, move, resize, rotate, draw, marquee (docs/engine.md §8.4).
// Each gesture owns a GESTURE transaction from its 3 px drag threshold to
// pointer-up; Esc, blur and pointer-cancel roll it back exactly.

#include <algorithm>
#include <cmath>

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
  updateCursor(s);
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
    case Gesture::Move:
    case Gesture::Resize:
    case Gesture::Rotate: commit(); break;
    case Gesture::Draw:
      if (drawn_ == kNoGuid) dragDraw(world, mods, true);
      commit();
      drawn_ = kNoGuid;
      gesture_ = Gesture::None;
      setTool(Tool::MOVE);  // after a draw, back to Move (Figma)
      break;
    case Gesture::Marquee: needsRender_ = true; break;
  }
  gesture_ = Gesture::None;
  targets_.clear();
  updateHover(s, mods);
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
  targets_.clear();
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

void Editor::startMove(uint32_t /*mods*/) {
  begin(TxnKind::GESTURE, "Move");
  targets_ = targetsOf(topLevelSelection(doc_, selection_));
}

void Editor::dragMove(Vec2 world, uint32_t mods) {
  Vec2 d = world - downWorld_;
  if (mods & MOD_SHIFT) {
    if (std::fabs(d.x) > std::fabs(d.y)) d.y = 0;
    else d.x = 0;
  }
  for (const Target& t : targets_) {
    Vec2 dp = doc_.worldTransform(t.parent).inverse().applyLinear(d);
    NodeChange c = NodeChange::changed(t.id);
    c.mask = F_TRANSFORM;
    c.props.transform = t.transform;
    // Pixel-grid snapping (on by default in Figma): whole px.
    c.props.transform.m02 = std::round(t.transform.m02 + dp.x);
    c.props.transform.m12 = std::round(t.transform.m12 + dp.y);
    const Node* n = doc_.get(t.id);
    if (n && n->props.transform == c.props.transform) continue;
    write(c);
  }
}

void Editor::startResize(int hx, int hy) {
  begin(TxnKind::GESTURE, "Resize");
  handleX_ = hx;
  handleY_ = hy;
  box_ = selectionBox(doc_, selection_);
  std::vector<Guid> ids = topLevelSelection(doc_, selection_);
  // A group has no size of its own: resizing it resizes what is in it.
  if (ids.size() == 1 && doc_.get(ids[0])->props.isGroupLike()) ids = doc_.children(ids[0]);
  targets_ = targetsOf(ids);
  changeCursor(cursor_, cursorAngle_);
}

void Editor::dragResize(Vec2 world, uint32_t mods) {
  const double W = box_.size.x, H = box_.size.y;
  if (!(W > 0) || !(H > 0)) return;
  bool alt = (mods & MOD_ALT) != 0, shift = (mods & MOD_SHIFT) != 0;
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
  auto snap = [](double& lo, double& hi, double len) {
    double sign = hi >= lo ? 1 : -1;
    if (len >= 1) {
      lo = std::round(lo);
      hi = std::round(hi);
      if (std::fabs(hi - lo) < 1) hi = lo + sign;
    } else if (std::fabs(hi - lo) < 0.01) {
      hi = lo + 0.01 * sign;
    }
  };
  snap(x0, x1, W);
  snap(y0, y1, H);

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
      Vec2 dp = doc_.worldTransform(t.parent).inverse().applyLinear(S.apply(centre) - centre);
      c.props.size = t.size;
      c.props.transform = t.transform;
      c.props.transform.m02 += dp.x;
      c.props.transform.m12 += dp.y;
    }
    write(c);
  }
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
    c.props.transform = doc_.worldTransform(t.parent).inverse() * R * t.world;
    write(c);
  }
  changeCursor(CursorKind::ROTATE, std::round(degrees(camera_.toScreen(world) - camera_.toScreen(centre))));
}

void Editor::dragDraw(Vec2 world, uint32_t mods, bool click) {
  Rect r;
  if (click) {
    r = {downWorld_.x, downWorld_.y, 100, 100};  // a click makes 100×100
  } else {
    Vec2 d = world - downWorld_;
    if (mods & MOD_SHIFT) {
      double s = std::max(std::fabs(d.x), std::fabs(d.y));
      d = {std::copysign(s, d.x), std::copysign(s, d.y)};
    }
    r = (mods & MOD_ALT) ? Rect::fromPoints(downWorld_ - d, downWorld_ + d) : Rect::fromPoints(downWorld_, downWorld_ + d);
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
  } else {
    c = NodeChange::changed(drawn_);
    c.mask = F_TRANSFORM | F_SIZE;
  }
  c.props.transform = parentInv * Mat2x3::translate(x0, y0);
  c.props.size = {x1 - x0, y1 - y0};
  write(c);
  changeSelection({drawn_});
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
