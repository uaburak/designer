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
#include "text/Fonts.h"

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

// ---- Frame titles -----------------------------------------------------------

double Editor::labelWidth(const std::string& name, bool section) const {
  text::FontRegistry& fonts = text::FontRegistry::get();
  if (labelWidthsGeneration_ != fonts.generation() || labelWidths_.size() > 4096) {
    labelWidths_.clear();
    labelWidthsGeneration_ = fonts.generation();
  }
  const OverlayStyle style = OverlayStyle::of(theme_);
  double size = section ? style.sectionTitleSize : style.titleSize;
  std::string key = (section ? "M\n" : "R\n") + name;
  if (auto it = labelWidths_.find(key); it != labelWidths_.end()) return it->second;
  // As Renderer::label lays it out (Inter, auto width); a rough width until Inter has loaded.
  double w = 6.2 * static_cast<double>(name.size()) * size / 11;
  FontName font{"Inter", section ? "Medium" : "Regular", ""};
  // Never requests the font (the overlay's labels do): only measured once it is in.
  if (fonts.state(font) == text::FontRegistry::State::Ready && fonts.find(font, nullptr)) {
    NodeProps p;
    p.type = NodeType::TEXT;
    p.text().textData.characters = name;
    p.text().fontName = font;
    p.text().fontSize = size;
    p.text().textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
    auto layout = text::layoutText(p, text::LayoutOptions{});
    if (layout && !layout->pendingFont) w = layout->size.x;
    else return w;  // not cached: measured again once the font is in
  }
  labelWidths_[key] = w;
  return w;
}

std::vector<FrameTitle> Editor::titles() const {
  if (page_ == kNoGuid) return {};
  Rect screen{0, 0, viewport_.width, viewport_.height};
  return frameTitles(doc_, page_, camera_.matrix(), screen, OverlayStyle::of(theme_),
                     [&](const std::string& name, bool section) { return labelWidth(name, section); }, dev_.focus);
}

Guid Editor::titleAt(Vec2 s) const {
  if (tool_ != Tool::MOVE || spaceHeld_) return kNoGuid;
  std::vector<FrameTitle> list = titles();
  // The topmost title first (later frames paint over earlier ones); locked frames' titles don't take a press.
  for (auto it = list.rbegin(); it != list.rend(); ++it) {
    if (!it->hit.contains(s)) continue;
    const Node* n = doc_.get(it->id);
    if (n && n->props.locked) continue;
    return it->id;
  }
  return kNoGuid;
}

// ---- Handles, cursor, hover -------------------------------------------------

Editor::Handle Editor::handleAt(Vec2 s, int& hx, int& hy) const {
  if (tool_ != Tool::MOVE || spaceHeld_ || selection_.empty()) return Handle::None;
  SelectionBox box = selectionBox(doc_, selection_);
  if (!box.valid) return Handle::None;
  for (Guid id : selection_) {
    const Node* n = doc_.get(id);
    if (n && n->props.locked) return Handle::None;
  }
  // A line: its two ends, nothing else.
  Guid line = kNoGuid;
  Vec2 ends[2];
  if (selectedLine(line, ends[0], ends[1])) {
    for (int i = 0; i < 2; i++)
      if ((s - camera_.toScreen(ends[i])).length() <= kCornerReach) {
        hx = i, hy = 0;
        return Handle::LineEnd;
      }
    return Handle::None;
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

bool Editor::selectedLine(Guid& id, Vec2& a, Vec2& b) const {
  if (selection_.size() != 1) return false;
  const Node* n = doc_.get(selection_[0]);
  if (!n || n->props.locked || selection_[0].isDerived()) return false;
  const NodeProps& p = n->props;
  bool flatX = p.size.x == 0, flatY = p.size.y == 0;
  if (!(p.type == NodeType::LINE || (p.type == NodeType::VECTOR && (flatX != flatY)))) return false;
  if (p.type == NodeType::LINE && !flatY) return false;
  // Along its own x (a LINE, a flat vector), or its own y (a vector with no width).
  Mat2x3 w = doc_.worldTransform(selection_[0]);
  id = selection_[0];
  a = w.apply({0, 0});
  b = flatX ? w.apply({0, p.size.y}) : w.apply({p.size.x, 0});
  return true;
}

void Editor::startLineEnd(int end) {
  begin(TxnKind::GESTURE, "Resize");
  lineEnd_ = end;
  Guid id;
  Vec2 a, b;
  selectedLine(id, a, b);
  targets_ = targetsOf({id});
  GuidSet moving{id};
  prepareSnapping(doc_.parentOf(id), moving);
}

void Editor::dragLineEnd(Vec2 world, uint32_t mods) {
  if (targets_.empty()) return;
  const Target& t = targets_[0];
  const Node* n = doc_.get(t.id);
  if (!n) return;
  bool flatX = n->props.type == NodeType::VECTOR && t.size.x == 0;
  // The other end stays; this one follows the pointer (snapped to the other layers; ⇧: 45° steps; ⌃: no snapping).
  Vec2 a = t.world.apply({0, 0}), b = flatX ? t.world.apply({0, t.size.y}) : t.world.apply({t.size.x, 0});
  Vec2 fixed = lineEnd_ == 0 ? b : a;
  SnapResult snap;
  guides_.clear();
  if (!(mods & (MOD_CTRL | MOD_SHIFT))) {
    snap = snapper_.snapPoint(world, kSnapReach / camera_.zoom, true, true);
    world = world + snap.offset;
  }
  Vec2 d = world - fixed;
  if (mods & MOD_SHIFT) {
    double len = d.length(), angle = std::round(std::atan2(d.y, d.x) / (kPi / 4)) * (kPi / 4);
    d = {std::cos(angle) * len, std::sin(angle) * len};
  }
  Vec2 moved = fixed + d;
  moved = {std::round(moved.x), std::round(moved.y)};
  Vec2 start = lineEnd_ == 0 ? moved : fixed, end = lineEnd_ == 0 ? fixed : moved;
  Vec2 v = end - start;
  double len = std::max(v.length(), 0.01);
  // The line's own axis turned to the new direction (a vector with no width runs along its y).
  double angle = std::atan2(v.y, v.x) - (flatX ? kPi / 2 : 0);
  NodeChange c = NodeChange::changed(t.id);
  c.mask = F_TRANSFORM | F_SIZE;
  c.props.transform = tidy(doc_.worldTransform(t.parent).inverse() * Mat2x3::translate(start.x, start.y) * Mat2x3::rotate(angle));
  c.props.size = flatX ? Vec2{0, len} : Vec2{len, 0};
  write(c);
  if (snap.snappedX || snap.snappedY) guides_ = snapper_.guidesFor({moved.x, moved.y, 0, 0}, snap.snappedX, snap.snappedY);
  flushLayout();
  needsRender_ = true;
}

void Editor::updateCursor(Vec2 s) {
  if (spaceHeld_ || tool_ == Tool::HAND) return changeCursor(CursorKind::HAND);
  if (tool_ == Tool::TEXT || gesture_ == Gesture::TextSelect) return changeCursor(CursorKind::IBEAM);
  if (tool_ != Tool::MOVE) return changeCursor(CursorKind::CROSSHAIR);
  if (text_.node != kNoGuid) {
    // Over the text being edited: an I-beam.
    Vec2 local = doc_.worldTransform(text_.node).inverse().apply(camera_.toWorld(s));
    const Node* n = doc_.get(text_.node);
    if (n && Rect{0, 0, n->props.size.x, n->props.size.y}.contains(local)) return changeCursor(CursorKind::IBEAM);
  }
  if (!viewer_ && gesture_ == Gesture::None && gridCursor(s)) return;
  int hx = 0, hy = 0;
  Handle h = viewer_ ? Handle::None : handleAt(s, hx, hy);
  if (h == Handle::Rotate && titleAt(s) != kNoGuid) h = Handle::None;  // a title takes the press, not the rotation zone
  if (h == Handle::None || h == Handle::LineEnd) return changeCursor(CursorKind::DEFAULT);
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
  if ((tool_ == Tool::MOVE || tool_ == Tool::ANNOTATION) && !spaceHeld_ && page_ != kNoGuid && handleAt(s, hx, hy) != Handle::Resize) {
    // Over a frame's title: that frame (Figma outlines it).
    next = titleAt(s);
    if (next == kNoGuid && handleAt(s, hx, hy) == Handle::None) {
      auto path = hitPath(doc_, page_, camera_.toWorld(s), pixel());
      focusFilter(path);
      next = pick(doc_, path, selection_, (mods & MOD_PRIMARY) != 0);
    }
  }
  devHover(s);
  if (next != hover_) {
    hover_ = next;
    events_.hover = true;
    needsRender_ = true;
  }
  // A selected grid's track pills label the one under the pointer.
  if (selection_.size() == 1)
    if (const Node* sn = doc_.get(selection_[0]); sn && sn->props.stack().stackMode == StackMode::GRID) needsRender_ = true;
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
        int P = p.stack().stackMode == StackMode::HORIZONTAL ? 0 : 1;
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
        for (size_t i = 1; i < boxes.size() && p.stack().stackWrap != StackWrap::WRAP; i++) {
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

uint32_t Editor::pointer(PointerEvent type, double x, double y, int button, uint32_t /*buttons*/, uint32_t mods, int clickCount) {
  mods_ = mods;
  if (type == PointerEvent::DOWN) clickCount_ = std::max(1, clickCount);
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
  // Pans move by whole device pixels, so the page's cached pixels can simply shift (docs/engine.md §6.9).
  double sx = viewport_.scaleX() > 0 ? viewport_.scaleX() : 1, sy = viewport_.scaleY() > 0 ? viewport_.scaleY() : 1;
  auto pan = [&](double px, double py) { changeCamera(camera_.panned(std::round(px * sx) / sx, std::round(py * sy) / sy)); };
  if ((flags & WHEEL_PINCH) || (mods & (MOD_CTRL | MOD_META))) {
    // A pinch (ctrlKey from a trackpad) or ⌘/Ctrl + wheel zooms about the pointer.
    double rate = mode == DeltaMode::LINE ? 0.05 : 0.01;
    zooming_ = true;
    changeCamera(camera_.zoomedAround(camera_.zoom * std::exp(-dy * (mode == DeltaMode::PAGE ? unit : 1) * rate), {x, y}));
  } else if ((mods & MOD_SHIFT) && dx == 0) {
    pan(-dy * unit, 0);
  } else {
    pan(-dx * unit, -dy * unit);
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
  // Viewer mode: no context menu, nothing but selecting (and panning, above).
  if (viewer_ && button != 0) return 0;
  // A right-click, or ⌃-click where ⌃ isn't the command key (a Mac).
  if (!viewer_ && (button == 2 || (button == 0 && (mods & MOD_CTRL) && !(mods & MOD_PRIMARY)))) return contextMenu(s, mods);
  if (button != 0) return 0;

  // Dev Mode: status chips, annotation labels and dots, saved measurements, the Annotation and Measurement tools.
  if (uint32_t r = devPointerDown(s, mods)) return r;

  // Editing text: a press in it moves the caret or selects; elsewhere it ends the editing first.
  if (text_.node != kNoGuid)
    if (uint32_t r = textPointerDown(s, mods, clickCount_)) return r;

  // Prototype mode: a press on a "+" connection handle or a noodle's end drags a connection.
  if (proto_.on)
    if (uint32_t r = protoPointerDown(s, mods)) return r;

  if (tool_ == Tool::TEXT) {
    // On a text layer: edit it there. Elsewhere: a click makes auto-width text, a drag a box of that width.
    auto path = hitPath(doc_, page_, downWorld_, pixel());
    if (!path.empty()) {
      const Node* hit = doc_.get(path.back());
      if (hit && hit->props.type == NodeType::TEXT && !hit->props.locked) {
        setTool(Tool::MOVE);
        startTextEdit(path.back(), false);
        return textPointerDown(s, mods, clickCount_);
      }
    }
    drawType_ = NodeType::TEXT;
    drawn_ = kNoGuid;
    gesture_ = Gesture::Draw;
    return P_HANDLED | P_CAPTURE;
  }

  if (paint_.node != kNoGuid)
    if (uint32_t r = paintPointerDown(s, mods)) return r;

  if (tool_ == Tool::PEN || tool_ == Tool::PENCIL || vector_.node != kNoGuid) {
    if (uint32_t r = vectorPointerDown(s, mods, clickCount_)) return r;
  }

  if (tool_ == Tool::FRAME || tool_ == Tool::SECTION || tool_ == Tool::RECTANGLE || tool_ == Tool::ELLIPSE || tool_ == Tool::POLYGON ||
      tool_ == Tool::STAR || tool_ == Tool::LINE || tool_ == Tool::ARROW) {
    drawType_ = tool_ == Tool::FRAME       ? NodeType::FRAME
                : tool_ == Tool::SECTION   ? NodeType::SECTION
                : tool_ == Tool::RECTANGLE ? NodeType::ROUNDED_RECTANGLE
                : tool_ == Tool::ELLIPSE   ? NodeType::ELLIPSE
                : tool_ == Tool::POLYGON   ? NodeType::REGULAR_POLYGON
                : tool_ == Tool::STAR      ? NodeType::STAR
                                           : NodeType::LINE;
    drawArrow_ = tool_ == Tool::ARROW;
    // Into the innermost frame under the press (the page when none).
    drawParent_ = page_;
    auto path = hitPath(doc_, page_, downWorld_, pixel());
    for (auto it = path.rbegin(); it != path.rend(); ++it)
      if (acceptsChildren(*it)) {
        // A section goes on the canvas or into another section only (Figma).
        if (drawType_ == NodeType::SECTION && doc_.get(*it)->props.type != NodeType::SECTION) continue;
        drawParent_ = *it;
        break;
      }
    drawn_ = kNoGuid;
    prepareSnapping(drawParent_, {});
    gesture_ = Gesture::Draw;
    return P_HANDLED | P_CAPTURE;
  }

  // A selected grid's track pills and a grid item's span handles (tools/GridGestures.cpp).
  if (!viewer_ && tool_ == Tool::MOVE && !spaceHeld_)
    if (uint32_t r = gridPointerDown(s, mods)) return r;

  int hx = 0, hy = 0;
  Handle h = viewer_ ? Handle::None : handleAt(s, hx, hy);
  if (h == Handle::Resize) {
    startResize(hx, hy);
    gesture_ = Gesture::Resize;
    return P_HANDLED | P_CAPTURE;
  }
  if (h == Handle::LineEnd) {
    startLineEnd(hx);
    gesture_ = Gesture::Resize;
    return P_HANDLED | P_CAPTURE;
  }
  // A frame's title (or a section's pill): a press selects the frame (⇧ adds or removes it), a drag moves it,
  // a double-click renames it in place.
  if (Guid titled = titleAt(s); titled != kNoGuid) {
    if (!viewer_ && clickCount_ >= 2 && !(mods & MOD_SHIFT)) {
      changeSelection({titled});
      for (const FrameTitle& t : titles())
        if (t.id == titled) {
          Rect r = t.section ? t.hit : Rect{t.text.x - 2, t.text.y - 2, std::max(t.frame.right() - t.text.x, 60.0) + 4, t.text.h + 4};
          events_.renames.push_back({titled, r});
        }
      needsRender_ = true;
      return P_HANDLED;
    }
    pressed_ = titled;
    pressMarquee_ = pressInSelected_ = pressNoop_ = false;
    marqueeScope_ = kNoGuid;
    pressedWasSelected_ = selected(titled);
    if (!pressedWasSelected_) {
      std::vector<Guid> next = (mods & MOD_SHIFT) ? selection_ : std::vector<Guid>{};
      next.push_back(titled);
      changeSelection(std::move(next));
    }
    gesture_ = Gesture::Press;
    return P_HANDLED | P_CAPTURE;
  }
  if (h == Handle::Rotate) {
    startRotate();
    gesture_ = Gesture::Rotate;
    return P_HANDLED | P_CAPTURE;
  }

  bool deep = (mods & MOD_PRIMARY) != 0, shift = (mods & MOD_SHIFT) != 0;
  auto path = hitPath(doc_, page_, downWorld_, pixel());
  focusFilter(path);
  if (!viewer_ && clickCount_ >= 2 && !shift && !path.empty()) {
    // Double-click on a text layer: edit it, the word under the pointer selected.
    const Node* hit = doc_.get(path.back());
    if (hit && hit->props.type == NodeType::TEXT && !hit->props.locked && (selected(path.back()) || pick(doc_, path, selection_, deep) == path.back())) {
      if (startTextEdit(path.back(), false) == OK) return textPointerDown(s, mods, 2);
    }
  }
  if (!viewer_ && clickCount_ >= 2 && !shift && !path.empty()) {
    // Double-click on a selected vector or shape: vector edit mode.
    Guid hit = pick(doc_, path, selection_, deep);
    if (hit != kNoGuid && selected(hit) && startVectorEdit(hit) == OK) return P_HANDLED;
  }
  pressed_ = pick(doc_, path, selection_, deep);
  pressMarquee_ = false;
  pressInSelected_ = false;
  pressNoop_ = false;
  marqueeScope_ = kNoGuid;
  pressedWasSelected_ = pressed_ != kNoGuid && selected(pressed_);
  size_t topAt = path.empty() ? 0 : topLevelIndex(doc_, path);
  if (pressed_ == kNoGuid) {
    pressMarquee_ = true;
  } else if (path.size() == topAt + 1 && doc_.get(path[topAt])->props.isFrameLike() &&
             doc_.get(path[topAt])->props.type != NodeType::INSTANCE && !pressedWasSelected_ &&
             !doc_.children(path[topAt]).empty()) {
    // A top-level frame's (or a section's) own background: a drag is a marquee among its children (⌘: a deep
    // one), a click selects nothing (live Figma: like empty canvas).
    pressMarquee_ = true;
    marqueeScope_ = path[topAt];
  } else if (!pressedWasSelected_) {
    // Figma's press rule: a press on a layer inside a selected layer keeps the selection — a drag moves the
    // selection (⇧ then locks the axis), and the pressed layer is selected only by a click (finishClick). A press
    // outside the selection selects what it picked at once (⌘ deep-selects at once too).
    if (!deep)
      for (Guid p : path) {
        if (p == pressed_) break;
        if (selected(p)) {
          pressInSelected_ = true;
          break;
        }
      }
    if (!pressInSelected_) {
      std::vector<Guid> next = shift ? selection_ : std::vector<Guid>{};
      next.push_back(pressed_);
      changeSelection(std::move(next));
    }
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
    case Gesture::None:
      updateHover(s, mods);
      if (vector_.node != kNoGuid || tool_ == Tool::PEN) vectorPointerMove(s, mods);
      if (proto_.on) protoHover(s);
      break;
    case Gesture::Noodle: protoPointerMove(s); break;
    case Gesture::Measure:
    case Gesture::MeasureDrag: devPointerMove(s); break;
    case Gesture::Vector: vectorPointerMove(s, mods); break;
    case Gesture::Paint: paintPointerMove(s, mods); break;
    case Gesture::Pencil:
      if (pencilPoints_.empty() || (camera_.toScreen(pencilPoints_.back()) - s).length() >= 1) pencilPoints_.push_back(world);
      needsRender_ = true;
      break;
    case Gesture::Pan: {
      // By whole device pixels (the cached page pixels shift, docs/engine.md §6.9).
      double sx = viewport_.scaleX() > 0 ? viewport_.scaleX() : 1, sy = viewport_.scaleY() > 0 ? viewport_.scaleY() : 1;
      changeCamera(downCamera_.panned(std::round((s.x - downScreen_.x) * sx) / sx, std::round((s.y - downScreen_.y) * sy) / sy));
      break;
    }
    case Gesture::Press:
      if (pressNoop_ || (s - downScreen_).length() < kDragThreshold) break;
      if (pressMarquee_) {
        gesture_ = Gesture::Marquee;
        dragMarquee(world, mods);
      } else if (!viewer_ && startMove(mods)) {
        gesture_ = Gesture::Move;
        dragMove(world, mods);
      } else {
        // Nothing movable under the press (instance sublayers stay where their main puts them; locked layers):
        // no gesture, no transaction — the press ends as nothing when the button comes up.
        pressNoop_ = true;
        if (!viewer_) changeCursor(CursorKind::NOT_ALLOWED);
      }
      break;
    case Gesture::Move: dragMove(world, mods); break;
    case Gesture::Resize: dragResize(world, mods); break;
    case Gesture::Rotate: dragRotate(world, mods); break;
    case Gesture::Draw:
      if (drawn_ == kNoGuid && (s - downScreen_).length() < kDragThreshold) break;
      if (drawType_ == NodeType::TEXT) {
        marquee_ = Rect::fromPoints(downWorld_, world);  // the text box being dragged
        needsRender_ = true;
        break;
      }
      dragDraw(world, mods, false);
      break;
    case Gesture::Marquee: dragMarquee(world, mods); break;
    case Gesture::TextSelect: textDrag(s); break;
    case Gesture::Grid: gridPointerMove(s, mods); break;
  }
}

void Editor::pointerUp(Vec2 s, uint32_t mods) {
  lastScreen_ = s;
  Vec2 world = camera_.toWorld(s);
  switch (gesture_) {
    case Gesture::None: return;
    case Gesture::Vector:
      vectorPointerUp(s, mods);
      gesture_ = Gesture::None;
      updateHover(s, mods);
      vectorPointerMove(s, mods);
      return;
    case Gesture::Paint:
      paintPointerUp();
      gesture_ = Gesture::None;
      return;
    case Gesture::Noodle:
      protoPointerUp(s);
      gesture_ = Gesture::None;
      return;
    case Gesture::Measure:
    case Gesture::MeasureDrag:
      devPointerUp(s);
      gesture_ = Gesture::None;
      endGesture();
      updateHover(s, mods);
      return;
    case Gesture::Pencil:
      pencilPoints_.push_back(world);
      gesture_ = Gesture::None;
      pencilFinish();
      endGesture();
      return;
    case Gesture::Pan: break;
    case Gesture::Press: finishClick(mods); break;
    case Gesture::Move: finishMove(); break;
    case Gesture::Resize:
    case Gesture::Rotate: commit(); break;
    case Gesture::Draw:
      if (drawType_ == NodeType::TEXT) {
        // A click: auto-width text at the point; a drag: a box of the dragged width.
        Rect r = Rect::fromPoints(downWorld_, world);
        bool drag = (s - downScreen_).length() >= kDragThreshold && r.w >= 1;
        gesture_ = Gesture::None;
        endGesture();
        setTool(Tool::MOVE);
        createTextAt(drag ? Vec2{r.x, r.y} : downWorld_, drag ? std::round(r.w) : -1);
        updateCursor(s);
        return;
      }
      if (drawn_ == kNoGuid) dragDraw(world, mods, true);
      if (drawType_ == NodeType::SECTION) adoptIntoSection(drawn_);
      if (excluded_.count(drawn_)) layoutDirty_.insert(doc_.parentOf(drawn_));
      excluded_.clear();
      commit();
      drawn_ = kNoGuid;
      gesture_ = Gesture::None;
      setTool(Tool::MOVE);  // after a draw, back to Move (Figma)
      break;
    case Gesture::Marquee: needsRender_ = true; break;
    case Gesture::TextSelect: break;
    case Gesture::Grid: gridPointerUp(s, mods); break;
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
  lineEnd_ = -1;
  ignoreConstraints_ = false;
  needsRender_ = true;
}

void Editor::redrag(uint32_t mods) { pointerMove(lastScreen_, mods); }

void Editor::cancelGesture() {
  switch (gesture_) {
    case Gesture::Vector:
      if (txn_.open) rollback();
      vector_.drag = VectorSession::Drag::None;
      reloadVector();
      break;
    case Gesture::Pencil: pencilPoints_.clear(); break;
    case Gesture::Noodle:
      proto_.drag = ProtoSession::Drag::None;
      proto_.target = kNoGuid;
      needsRender_ = true;
      break;
    case Gesture::Paint:
      if (txn_.open) rollback();
      paint_.drag = PaintSession::Drag::None;
      break;
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
    case Gesture::Grid: gridCancel(); break;
    case Gesture::Measure:
    case Gesture::MeasureDrag: needsRender_ = true; break;
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
  if (pressNoop_) {
    pressNoop_ = false;
    changeCursor(CursorKind::DEFAULT);
    return;
  }
  if (pressInSelected_) {
    // Released without a drag inside a selected layer: the pressed layer is selected (⇧: added).
    pressInSelected_ = false;
    std::vector<Guid> next = shift ? selection_ : std::vector<Guid>{};
    if (std::find(next.begin(), next.end(), pressed_) == next.end()) next.push_back(pressed_);
    changeSelection(std::move(next));
    return;
  }
  if (pressMarquee_) {
    // Empty canvas, or the empty background of a top-level frame (or section) with layers in it: live Figma
    // (2026-10-08) treats both alike — a click selects nothing (⇧ keeps the selection).
    if (!shift) changeSelection({});
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

Guid Editor::dropTargetAt(Vec2 world, bool force) const {
  // The topmost frame under the pointer that isn't being moved (nor inside what is): its box, inside every
  // frame that clips it. Instances and locked or hidden frames don't take layers. The pointer decides, not the
  // sizes: live Figma (2026-10-08) nests a 500×350 layer dropped on a 150×150 frame. (`force`, ⌘: kept for the
  // safeguards Figma's ⌘ overrides; none here yet.)
  (void)force;
  GuidSet moving;
  for (const Target& t : targets_) moving.insert(t.id);
  Guid best = page_;
  doc_.query(page_, Rect{world.x, world.y, 0, 0}, [&](Guid id) {
    const Node* n = doc_.get(id);
    if (!n || !acceptsChildren(id)) return true;
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
    if (!n || !n->props.fitsChildren()) return cur;
    cur = n->props.parentIndex.guid;
  }
  return cur;
}

bool Editor::startMove(uint32_t mods) {
  std::vector<Target> targets = targetsOf(topSelectionInPaintOrder());
  // Layers inside an instance can't be moved (Figma): they stay where their main puts them.
  targets.erase(std::remove_if(targets.begin(), targets.end(), [](const Target& t) { return t.id.isDerived(); }), targets.end());
  if (targets.empty()) return false;
  begin(TxnKind::GESTURE, "Move");
  targets_ = std::move(targets);
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
  return true;
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
      // ⌥-drag of a main component makes an instance of it (R4 §2).
      const Node* tn = doc_.get(t.id);
      bool main = tn && tn->props.type == NodeType::SYMBOL && setOf(t.id) == kNoGuid;
      copy.id = main ? createInstance(t.id, t.parent, key, t.transform) : cloneSubtree(t.id, t.parent, key, t.transform);
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
  // Figma's modifiers while moving: Space held keeps the layers out of frames (their parents stay); ⌘ nests them
  // even into a frame smaller than they are; ⌃ turns snapping off.
  const bool keepParent = spaceHeld_;
  const bool forceNest = (mods & MOD_PRIMARY) != 0;
  const bool snapping = !(mods & MOD_CTRL);

  // Into the frame under the pointer, out of the one it left.
  Guid drop = keepParent ? kNoGuid : dropTargetAt(world, forceNest);
  for (const Target& t : targets_) {
    const Node* n = doc_.get(t.id);
    if (!n) continue;
    Guid now = n->props.parentIndex.guid;
    Guid want = keepParent ? t.parent : drop == containerOf(t.parent) ? t.parent : drop;
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
  gridDrop_ = false;
  if (fp.stack().stackMode == StackMode::GRID) {
    // A grid: the cell under the pointer. With automatic placement the layers join the flow before the first item
    // at or after that cell (row by row); without it they take that cell. The line marks the cell's leading edge.
    Layout L(*this);
    Layout::GridCells g = L.gridCells(frame);
    Mat2x3 W = doc_.worldTransform(frame);
    Vec2 q = W.inverse().apply(world);
    size_t col = 0, row = 0;
    if (!g.cellAt(q, col, row)) {
      hasInsertion_ = false;
      return;
    }
    GuidSet moving;
    for (const Target& t : targets_) moving.insert(t.id);
    size_t i = 0, k = 0;
    for (const auto& it : g.items) {
      if (moving.count(it.id) || placedByGesture(it.id)) continue;
      if (it.row * g.colX.size() + it.col >= row * g.colX.size() + col) break;
      i = ++k;
    }
    insertIndex_ = i;
    if (!g.reflow && col < g.colIds.size() && row < g.rowIds.size() && g.colIds[col] != kNoGuid && g.rowIds[row] != kNoGuid) {
      gridDrop_ = true;
      gridDropCol_ = g.colIds[col];
      gridDropRow_ = g.rowIds[row];
    }
    Vec2 a{g.colX[col], g.rowY[row]}, b{g.colX[col], g.rowY[row] + std::max(1.0, g.rowH[row])};
    insertion_ = {W.apply(a), W.apply(b)};
    hasInsertion_ = true;
    return;
  }
  int P = fp.stack().stackMode == StackMode::HORIZONTAL ? 0 : 1, C = 1 - P;
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
  if (fp.stack().stackWrap == StackWrap::WRAP && P == 0) {
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
  if (fp.stack().stackWrap == StackWrap::WRAP && P == 0 && !boxes.empty()) {
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
    // A grid without automatic placement: the first layer takes the cell it was dropped on (Figma's grid).
    if (gridDrop_ && !ids.empty()) {
      const std::string colBytes = Layout::gridAnchorBytes(true, gridDropCol_), rowBytes = Layout::gridAnchorBytes(false, gridDropRow_);
      const auto before = doc_.get(ids[0])->props.extra;
      auto field = [](const std::map<std::string, std::string>& extra, const char* key) {
        auto it = extra.find(key);
        return it == extra.end() ? std::string() : it->second;
      };
      // The item that held the cell takes the dragged one's old cell (two items swap, as Figma's do).
      for (Guid o : others) {
        const auto& oe = doc_.get(o)->props.extra;
        if (field(oe, "gridColumnAnchor") != colBytes || field(oe, "gridRowAnchor") != rowBytes) continue;
        if (field(before, "gridColumnAnchor").empty() || field(before, "gridRowAnchor").empty()) break;
        NodeChange s = NodeChange::changed(o);
        s.mask = F_EXTRA;
        s.props.extra = oe;
        s.props.extra["gridColumnAnchor"] = field(before, "gridColumnAnchor");
        s.props.extra["gridRowAnchor"] = field(before, "gridRowAnchor");
        write(s);
        break;
      }
      NodeChange c = NodeChange::changed(ids[0]);
      c.mask = F_EXTRA;
      c.props.extra = before;
      c.props.extra["gridColumnAnchor"] = colBytes;
      c.props.extra["gridRowAnchor"] = rowBytes;
      write(c);
    }
  }
  gridDrop_ = false;
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
  lineEnd_ = -1;
  handleX_ = hx;
  handleY_ = hy;
  box_ = selectionBox(doc_, selection_);
  std::vector<Guid> ids = topLevelSelection(doc_, selection_);
  // A group has no size of its own: resizing it resizes what is in it.
  GuidSet moving(ids.begin(), ids.end());
  Guid parent = ids.empty() ? page_ : doc_.parentOf(ids[0]);
  if (ids.size() == 1 && doc_.get(ids[0])->props.fitsChildren()) ids = doc_.children(ids[0]);
  targets_ = targetsOf(ids);
  for (const Target& t : targets_) moving.insert(t.id);
  prepareSnapping(parent, moving);
  changeCursor(cursor_, cursorAngle_);
}

void Editor::dragResize(Vec2 world, uint32_t mods) {
  if (lineEnd_ >= 0) return dragLineEnd(world, mods);
  const double W = box_.size.x, H = box_.size.y;
  if (!(W > 0) || !(H > 0)) return;
  bool alt = (mods & MOD_ALT) != 0;
  // The ratio is kept with ⇧, or always for layers with Lock aspect ratio on — then ⌃ lets it go (Figma).
  std::vector<Guid> resized = topLevelSelection(doc_, selection_);
  bool locked = !resized.empty();
  for (Guid id : resized) {
    const Node* n = doc_.get(id);
    locked &= n && n->props.proportionsConstrained;
  }
  bool shift = locked ? !(mods & MOD_CTRL) : (mods & MOD_SHIFT) != 0;
  // ⌘: the frames' children stay where they are on the page (constraints ignored, Figma).
  ignoreConstraints_ = (mods & MOD_PRIMARY) != 0;
  // Snap the dragged edge (boxes turned against the page don't snap); ⌃ turns snapping off.
  bool snapping = !(mods & MOD_CTRL) && axisAligned(box_.toWorld);
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
    // ⌘: a frame's children keep their place on the page (and their size); layout leaves them (ignoreConstraints).
    const Node* tn = doc_.get(t.id);
    if (tn && tn->props.isFrameLike() && !tn->props.isAutoLayout()) {
      Mat2x3 nowWorld = doc_.worldTransform(t.id);
      for (Guid ch : doc_.children(t.id)) {
        if (ch.isDerived()) continue;
        Mat2x3 t0;
        Vec2 s0;
        base(ch, t0, s0);
        NodeChange cc = NodeChange::changed(ch);
        cc.mask = F_TRANSFORM | F_SIZE;
        cc.props.transform = tidy(nowWorld.inverse() * t.world * t0);
        cc.props.size = s0;
        if (ignoreConstraints_) write(cc);
      }
    }
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
    bool horizontal = parent->props.stack().stackMode == StackMode::HORIZONTAL;
    bool primary = horizontal ? x : y, counter = horizontal ? y : x;
    if (primary && p.stackChildPrimaryGrow > 0) c.mask |= F_STACK_CHILD_GROW, c.props.stackChildPrimaryGrow = 0;
    if (counter && p.stackChildAlignSelf == StackCounterAlign::STRETCH)
      c.mask |= F_STACK_CHILD_ALIGN_SELF, c.props.stackChildAlignSelf = StackCounterAlign::AUTO;
  }
  if (p.isAutoLayout()) {
    bool horizontal = p.stack().stackMode == StackMode::HORIZONTAL;
    bool primary = horizontal ? x : y, counter = horizontal ? y : x;
    if (primary && p.hugsPrimary()) c.mask |= F_STACK_PRIMARY_SIZING, c.props.stack().stackPrimarySizing = StackSize::FIXED;
    if (counter && p.hugsCounter()) c.mask |= F_STACK_COUNTER_SIZING, c.props.stack().stackCounterSizing = StackSize::FIXED;
  }
  // A text resized by hand: a new width makes auto width auto height, a new height makes it a fixed box (Figma).
  if (p.type == NodeType::TEXT && p.text().textAutoResize != TextAutoResize::NONE) {
    if (y) c.mask |= F_TEXT_AUTO_RESIZE, c.props.text().textAutoResize = TextAutoResize::NONE;
    else if (x && p.text().textAutoResize == TextAutoResize::WIDTH_AND_HEIGHT)
      c.mask |= F_TEXT_AUTO_RESIZE, c.props.text().textAutoResize = TextAutoResize::HEIGHT;
  }
  if (c.mask) write(c);
}

void Editor::startRotate() {
  begin(TxnKind::GESTURE, "Rotate");
  box_ = selectionBox(doc_, selection_);
  targets_ = targetsOf(topLevelSelection(doc_, selection_));
  // Layers inside an instance keep their place (Figma).
  targets_.erase(std::remove_if(targets_.begin(), targets_.end(), [](const Target& t) { return t.id.isDerived(); }), targets_.end());
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
  if (drawType_ == NodeType::LINE) return dragLine(world, mods, click);
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
    const char* label = drawType_ == NodeType::FRAME             ? "Create frame"
                        : drawType_ == NodeType::SECTION         ? "Create section"
                        : drawType_ == NodeType::ELLIPSE         ? "Create ellipse"
                        : drawType_ == NodeType::REGULAR_POLYGON ? "Create polygon"
                        : drawType_ == NodeType::STAR            ? "Create star"
                                                                 : "Create rectangle";
    begin(TxnKind::GESTURE, label);
    Guid id = newGuid();
    c = NodeChange::created(id, drawType_ == NodeType::SECTION ? sectionProps() : defaultProps(drawType_));
    c.props.name = nextName(drawType_ == NodeType::FRAME             ? "Frame"
                            : drawType_ == NodeType::SECTION         ? "Section"
                            : drawType_ == NodeType::ELLIPSE         ? "Ellipse"
                            : drawType_ == NodeType::REGULAR_POLYGON ? "Polygon"
                            : drawType_ == NodeType::STAR            ? "Star"
                                                                     : "Rectangle");
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

void Editor::dragLine(Vec2 world, uint32_t mods, bool click) {
  // A line from the press to the pointer (⇧: 45° steps); a click makes a 100 px line.
  Vec2 a = {std::round(downWorld_.x), std::round(downWorld_.y)};
  Vec2 b = click ? a + Vec2{100, 0} : world;
  Vec2 d = b - a;
  double len = d.length(), angle = std::atan2(d.y, d.x);
  if (mods & MOD_SHIFT) angle = std::round(angle / (kPi / 4)) * (kPi / 4);
  if (!click) {
    b = a + Vec2{std::cos(angle) * len, std::sin(angle) * len};
    b = {std::round(b.x), std::round(b.y)};
    d = b - a;
    len = d.length();
    angle = std::atan2(d.y, d.x);
  }
  len = std::max(len, 1.0);
  Mat2x3 parentInv = doc_.worldTransform(drawParent_).inverse();
  NodeChange c;
  if (drawn_ == kNoGuid) {
    begin(TxnKind::GESTURE, drawArrow_ ? "Create arrow" : "Create line");
    Guid id = newGuid();
    c = NodeChange::created(id, defaultProps(NodeType::LINE));
    c.props.name = nextName(drawArrow_ ? "Arrow" : "Line");
    c.props.parentIndex = {drawParent_, placeAt(drawParent_, doc_.children(drawParent_).size(), kNoGuid)};
    drawn_ = id;
    const Node* dp = doc_.get(drawParent_);
    if (dp && dp->props.isAutoLayout()) excluded_.insert(id);
  } else {
    c = NodeChange::changed(drawn_);
    c.mask = F_TRANSFORM | F_SIZE | (drawArrow_ ? F_VECTOR_DATA : 0);
  }
  c.props.transform = parentInv * Mat2x3::translate(a.x, a.y) * Mat2x3::rotate(angle);
  c.props.size = {len, 0};
  if (drawArrow_) c.props.shape().vectorData = lineNetwork(len, StrokeCap::NONE, StrokeCap::ARROW_LINES);
  write(c);
  changeSelection({drawn_});
  guides_.clear();
  flushLayout();
  needsRender_ = true;
}

void Editor::dragMarquee(Vec2 world, uint32_t mods) {
  marquee_ = Rect::fromPoints(downWorld_, world);
  needsRender_ = true;
  // ⌘ (held at the press or now): the nested layers under the rect, at any depth (Figma's deep marquee).
  bool deep = ((mods | downMods_) & MOD_PRIMARY) != 0;
  std::vector<Guid> hits = deep ? marqueeDeepHits(doc_, page_, marquee_) : marqueeHits(doc_, page_, marquee_, marqueeScope_);
  std::vector<Guid> next;
  if ((mods | downMods_) & MOD_SHIFT) next = baseSelection_;
  for (Guid h : hits)
    if (std::find(next.begin(), next.end(), h) == next.end()) next.push_back(h);
  changeSelection(std::move(next));
}

}  // namespace eng
