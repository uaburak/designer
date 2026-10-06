// Gradient handles on the canvas (Figma's gradient edit mode): the panel opens
// a gradient paint's editor, the engine shows its handles — start and end
// (linear), centre, end and width (radial, angular, diamond) — and its stops
// along the line. Dragging a handle rewrites the paint's transform, dragging a
// stop its position, a click on the line adds a stop, ⌫ deletes the selected
// one. Each drag is one undo step.

#include <algorithm>
#include <cmath>

#include "editor/Editor.h"

namespace eng {

namespace {

constexpr double kHandleReach = 8;  // CSS px
constexpr double kLineReach = 5;

Vec2 perp(Vec2 v) { return {-v.y, v.x}; }

// The paint transform whose handles (in the node's unit square) are `h`: Figma's gradient space maps
// (0, .5) / (1, .5) / (0, 1) to start / end / width for linear, (.5, .5) / (1, .5) / (.5, 1) for the others.
Mat2x3 transformFromHandles(bool linear, const Vec2 h[3]) {
  Vec2 colX, colY, origin;
  if (linear) {
    colX = h[1] - h[0];
    colY = (h[2] - h[0]) * 2;
    origin = h[0] - colY * 0.5;
  } else {
    colX = (h[1] - h[0]) * 2;
    colY = (h[2] - h[0]) * 2;
    origin = h[0] - colX * 0.5 - colY * 0.5;
  }
  Mat2x3 inv{colX.x, colY.x, origin.x, colX.y, colY.y, origin.y};
  return inv.inverse();
}

}  // namespace

const Paint* Editor::editedPaint() const {
  const Node* n = paint_.node != kNoGuid ? doc_.get(paint_.node) : nullptr;
  if (!n) return nullptr;
  const auto& list = paint_.strokes ? n->props.strokePaints : n->props.fillPaints;
  if (paint_.index >= list.size() || !list[paint_.index].isGradient()) return nullptr;
  return &list[paint_.index];
}

void Editor::paintHandles(const Paint& p, Vec2 out[3]) const {
  Mat2x3 inv = p.transform.inverse();
  bool linear = p.type == PaintType::GRADIENT_LINEAR;
  out[0] = inv.apply(linear ? Vec2{0, 0.5} : Vec2{0.5, 0.5});
  out[1] = inv.apply({1, 0.5});
  out[2] = inv.apply(linear ? Vec2{0, 1} : Vec2{0.5, 1});
}

Status Editor::startPaintEdit(Guid id, bool strokes, uint32_t index) {
  const Node* n = doc_.get(id);
  if (!n) return E_NOT_FOUND;
  const auto& list = strokes ? n->props.strokePaints : n->props.fillPaints;
  if (index >= list.size() || !list[index].isGradient()) return E_INVALID;
  if (vector_.node != kNoGuid) endVectorEdit();
  if (text_.node != kNoGuid) endTextEdit();
  paint_ = PaintSession{};
  paint_.node = id;
  paint_.strokes = strokes;
  paint_.index = index;
  if (std::find(selection_.begin(), selection_.end(), id) == selection_.end()) changeSelection({id});
  paintChanged();
  return OK;
}

void Editor::endPaintEdit() {
  if (paint_.node == kNoGuid) return;
  if (gesture_ == Gesture::Paint) {
    if (txn_.open) commit();
    gesture_ = Gesture::None;
  }
  paint_ = PaintSession{};
  paintChanged();
}

Status Editor::setPaintStop(int stop) {
  const Paint* p = editedPaint();
  if (!p || stop < 0 || static_cast<size_t>(stop) >= p->stops.size()) return E_INVALID;
  paint_.stop = stop;
  paintChanged();
  return OK;
}

void Editor::paintChanged() {
  events_.paintEdit = true;
  needsRender_ = true;
}

void Editor::writePaint(const Paint& p) {
  const Node* n = doc_.get(paint_.node);
  if (!n) return;
  NodeChange c = NodeChange::changed(paint_.node);
  c.mask = paint_.strokes ? F_STROKES : F_FILLS;
  c.props.fillPaints = n->props.fillPaints;
  c.props.strokePaints = n->props.strokePaints;
  auto& list = paint_.strokes ? c.props.strokePaints : c.props.fillPaints;
  if (paint_.index < list.size()) list[paint_.index] = p;
  write(c);
}

uint32_t Editor::paintPointerDown(Vec2 s, uint32_t mods) {
  const Paint* p = editedPaint();
  if (!p) {
    endPaintEdit();
    return 0;
  }
  const Node* n = doc_.get(paint_.node);
  Mat2x3 toScreen = camera_.matrix() * doc_.worldTransform(paint_.node) * Mat2x3{n->props.size.x, 0, 0, 0, n->props.size.y, 0};
  Vec2 h[3];
  paintHandles(*p, h);
  bool linear = p->type == PaintType::GRADIENT_LINEAR;
  paint_.start = *p;
  paint_.dragged = false;
  // Handles first (the end stops sit on them: grabbing one also selects its stop), then the stops.
  Vec2 a = toScreen.apply(h[0]), b = toScreen.apply(h[1]);
  for (int i = 0; i < (linear ? 2 : 3); i++)
    if ((toScreen.apply(h[i]) - s).length() <= kHandleReach) {
      paint_.handle = i;
      paint_.drag = PaintSession::Drag::Handle;
      if (i < 2)
        for (size_t k = 0; k < p->stops.size(); k++)
          if (std::fabs(p->stops[k].position - (i == 0 ? 0 : 1)) < 1e-6) paint_.stop = static_cast<int>(k);
      begin(TxnKind::GESTURE, "Edit gradient");
      gesture_ = Gesture::Paint;
      paintChanged();
      return P_HANDLED | P_CAPTURE;
    }
  for (size_t i = 0; i < p->stops.size(); i++) {
    Vec2 at = a + (b - a) * p->stops[i].position;
    if ((at - s).length() <= kHandleReach) {
      paint_.stop = static_cast<int>(i);
      paint_.drag = PaintSession::Drag::Stop;
      begin(TxnKind::GESTURE, "Edit gradient");
      gesture_ = Gesture::Paint;
      paintChanged();
      return P_HANDLED | P_CAPTURE;
    }
  }
  // On the line: a new stop there, in the gradient's colour at that point.
  Vec2 ab = b - a;
  double len2 = ab.x * ab.x + ab.y * ab.y;
  double t = len2 > 0 ? ((s.x - a.x) * ab.x + (s.y - a.y) * ab.y) / len2 : -1;
  if (t > 0 && t < 1 && (a + ab * t - s).length() <= kLineReach && !(mods & MOD_SHIFT)) {
    Paint q = *p;
    std::vector<ColorStop> sorted = q.stops;
    std::sort(sorted.begin(), sorted.end(), [](auto& x, auto& y) { return x.position < y.position; });
    Color c = sorted.empty() ? Color{} : sorted.front().color;
    for (size_t i = 1; i < sorted.size(); i++)
      if (sorted[i].position >= t) {
        const ColorStop &x = sorted[i - 1], &y = sorted[i];
        double f = y.position > x.position ? (t - x.position) / (y.position - x.position) : 0;
        c = {static_cast<float>(x.color.r + (y.color.r - x.color.r) * f), static_cast<float>(x.color.g + (y.color.g - x.color.g) * f),
             static_cast<float>(x.color.b + (y.color.b - x.color.b) * f), static_cast<float>(x.color.a + (y.color.a - x.color.a) * f)};
        break;
      }
    q.stops.push_back({c, t});
    begin(TxnKind::GESTURE, "Add color stop");
    writePaint(q);
    paint_.stop = static_cast<int>(q.stops.size() - 1);
    paint_.start = q;
    paint_.drag = PaintSession::Drag::Stop;
    gesture_ = Gesture::Paint;
    paintChanged();
    return P_HANDLED | P_CAPTURE;
  }
  return 0;
}

void Editor::paintPointerMove(Vec2 s, uint32_t mods) {
  if (!paint_.dragged && (s - downScreen_).length() < 2) return;
  paint_.dragged = true;
  const Node* n = doc_.get(paint_.node);
  if (!n) return;
  Mat2x3 toUnit = (camera_.matrix() * doc_.worldTransform(paint_.node) * Mat2x3{n->props.size.x, 0, 0, 0, n->props.size.y, 0}).inverse();
  Vec2 u = toUnit.apply(s);
  Paint q = paint_.start;
  Vec2 h[3];
  paintHandles(paint_.start, h);
  bool linear = q.type == PaintType::GRADIENT_LINEAR;
  if (paint_.drag == PaintSession::Drag::Stop) {
    Vec2 ab = h[1] - h[0];
    double len2 = ab.x * ab.x + ab.y * ab.y;
    double t = len2 > 0 ? ((u.x - h[0].x) * ab.x + (u.y - h[0].y) * ab.y) / len2 : 0;
    if (mods & MOD_SHIFT) t = std::round(t * 10) / 10;  // ⇧: 10 % steps
    q.stops[static_cast<size_t>(paint_.stop)].position = std::clamp(t, 0.0, 1.0);
  } else {
    Vec2 n0 = h[0], n1 = h[1], n2 = h[2];
    // The width handle keeps its length relative to the main axis and stays square to it.
    double ratio = (n1 - n0).length() > 0 ? (n2 - n0).length() / (n1 - n0).length() : 1;
    double side = ((n1 - n0).x * (n2 - n0).y - (n1 - n0).y * (n2 - n0).x) >= 0 ? 1 : -1;
    if (paint_.handle == 0) {
      Vec2 d = u - n0;
      if (linear) {
        n0 = u;
        n2 = n0 + perp(n1 - n0) * (ratio * side);
      } else {
        n0 = n0 + d, n1 = n1 + d, n2 = n2 + d;  // the centre moves everything
      }
    } else if (paint_.handle == 1) {
      n1 = u;
      n2 = n0 + perp(n1 - n0) * (ratio * side);
    } else {
      n2 = u;
    }
    Vec2 nh[3] = {n0, n1, n2};
    q.transform = transformFromHandles(linear, nh);
  }
  writePaint(q);
  paintChanged();
}

void Editor::paintPointerUp() {
  // Stops keep their order by position (the selected one followed).
  const Paint* p = editedPaint();
  if (p && paint_.drag == PaintSession::Drag::Stop && paint_.stop >= 0) {
    Paint q = *p;
    ColorStop moved = q.stops[static_cast<size_t>(paint_.stop)];
    std::stable_sort(q.stops.begin(), q.stops.end(), [](auto& x, auto& y) { return x.position < y.position; });
    for (size_t i = 0; i < q.stops.size(); i++)
      if (q.stops[i] == moved) paint_.stop = static_cast<int>(i);
    writePaint(q);
  }
  if (txn_.open) commit();
  paint_.drag = PaintSession::Drag::None;
  paintChanged();
}

void Editor::paintOverlay(Overlay& o) const {
  const Paint* p = editedPaint();
  const Node* n = paint_.node != kNoGuid ? doc_.get(paint_.node) : nullptr;
  if (!p || !n) return;
  Mat2x3 toWorld = doc_.worldTransform(paint_.node) * Mat2x3{n->props.size.x, 0, 0, 0, n->props.size.y, 0};
  Vec2 h[3];
  paintHandles(*p, h);
  bool linear = p->type == PaintType::GRADIENT_LINEAR;
  Vec2 a = toWorld.apply(h[0]), b = toWorld.apply(h[1]), c = toWorld.apply(h[2]);
  o.lines.push_back({a, b, false, true});
  if (!linear) o.lines.push_back({a, c, false, true});
  OverlayMark m;
  m.shape = OverlayMark::Shape::GradientHandle;
  m.world = a;
  o.marks.push_back(m);
  m.world = b;
  o.marks.push_back(m);
  if (!linear) {
    m.world = c;
    o.marks.push_back(m);
  }
  for (size_t i = 0; i < p->stops.size(); i++) {
    OverlayMark s;
    s.shape = OverlayMark::Shape::GradientStop;
    s.world = a + (b - a) * p->stops[i].position;
    s.color = p->stops[i].color;
    s.selected = static_cast<int>(i) == paint_.stop;
    o.marks.push_back(s);
  }
}

}  // namespace eng
