// Dev Mode on the canvas (docs/research/figma/R9-dev-mode.md "Round 6"): saved measurements (a line with end ticks and
// a pill for the value), annotation labels beside their design with a leader line to the annotated layer (Figma places
// them; they can't be dragged) or, in Dev Mode, a dot that opens its label, the measurement tool's edges and the
// measurement being dragged out, and the status chip after a design's name. Screen space (CSS px); 1 px lines on
// device pixels. Records where it drew what can be clicked (CanvasHits) for the editor's hit tests.

#include <algorithm>
#include <cmath>
#include <map>

#include "render/Renderer.h"

namespace eng {

namespace {

const CornerRadii kSquare{0, 0, 0, 0};

struct Placed {
  const AnnotationCard* card = nullptr;
  bool right = true;
  double desired = 0;  // the top the label would like (screen)
  double top = 0, height = 0;
  Rect target;         // screen
  Rect frame;          // screen
  Vec2 anchor;         // screen: where the leader line meets the layer
};

}  // namespace

void Renderer::drawStatusChip(const DevStatusMark& mark, double x, double baseline, const OverlayStyle& style) {
  const double dpr = viewport_.scaleX();
  const char* text = mark.kind == DevStatusMark::Kind::Ready       ? "Ready for dev"
                     : mark.kind == DevStatusMark::Kind::Completed ? "Completed"
                     : mark.kind == DevStatusMark::Kind::Changed   ? "Changed"
                                                                   : "Mark as ready for dev";
  const text::TextLayout* L = label(text, "Medium", style.labelSize);
  double tw = L ? L->size.x : 6.2 * std::char_traits<char>::length(text);
  double h = style.badgeHeight, w = std::round(tw + 2 * 6), r = h / 2;
  double bx = std::round(x * dpr) / dpr, by = std::round((baseline - 12) * dpr) / dpr;
  Color fill = mark.kind == DevStatusMark::Kind::Ready       ? style.statusReady
               : mark.kind == DevStatusMark::Kind::Completed ? style.statusCompleted
               : mark.kind == DevStatusMark::Kind::Changed   ? style.statusChanged
                                                             : style.title;
  bool button = mark.kind == DevStatusMark::Kind::MarkButton;
  emit(makeShape(Mat2x3::translate(bx, by), {w, h}, ShapeKind::Rect, {r, r, r, r}, fill, button ? 0.0 : 1.0, fill, button ? 0.45 : 0.0,
                 button ? 1 : 0, 0),
       Pass::Shape);
  if (L && !L->lines.empty())
    drawGlyphs(*L, Mat2x3::translate(bx + (w - tw) / 2, std::round((by + (h - L->lines[0].height) / 2) * dpr) / dpr),
               button ? style.title : Color{1, 1, 1, 1}, button ? std::max(0.6, style.titleAlpha) : 1);
  if (recordHits_) hits_.statuses.push_back({mark.frame, {bx, by, w, h}, mark.kind});
}

void Renderer::drawDevOverlay(const Document& doc, const Camera& camera, const Overlay& overlay, const OverlayStyle& style) {
  const DevOverlay& dev = overlay.dev;
  const double dpr = viewport_.scaleX();
  const Mat2x3 view = camera.matrix();
  auto snap = [&](double v) { return std::round(v * dpr) / dpr; };
  // A straight screen line, `width` across (axis-aligned ones on device pixels).
  auto segment = [&](Vec2 a, Vec2 b, double width, const Color& color, double alpha) {
    Vec2 d = b - a;
    double len = d.length();
    if (len < 1e-9) return;
    if (std::fabs(d.x) < 1e-9 || std::fabs(d.y) < 1e-9) {
      bool horizontal = std::fabs(d.y) < 1e-9;
      double lo = horizontal ? std::min(a.x, b.x) : std::min(a.y, b.y), hi = horizontal ? std::max(a.x, b.x) : std::max(a.y, b.y);
      double mid = horizontal ? a.y : a.x;
      double c0 = snap(mid - width / 2), c1 = std::max(c0 + 1 / dpr, snap(mid + width / 2));
      double l0 = snap(lo), l1 = std::max(l0 + 1 / dpr, snap(hi));
      Rect r = horizontal ? Rect{l0, c0, l1 - l0, c1 - c0} : Rect{c0, l0, c1 - c0, l1 - l0};
      emit(makeShape(Mat2x3::translate(r.x, r.y), {r.w, r.h}, ShapeKind::Rect, kSquare, color, alpha, color, 0, 0, 0), Pass::Shape);
      return;
    }
    Vec2 u{d.x / len, d.y / len}, n{-u.y, u.x};
    Mat2x3 m{u.x, n.x, a.x - n.x * width / 2, u.y, n.y, a.y - n.y * width / 2};
    emit(makeShape(m, {len, width}, ShapeKind::Rect, kSquare, color, alpha, color, 0, 0, 0), Pass::Shape);
  };
  auto dashed = [&](Vec2 a, Vec2 b, const Color& color) {
    double len = (b - a).length();
    for (double t = 0; t < len; t += 6) segment(a + (b - a) * (t / len), a + (b - a) * (std::min(len, t + 3) / len), 1, color, 1);
  };
  auto dot = [&](Vec2 c, double d, const Color& fill, const Color& ring) {
    emit(makeShape(Mat2x3::translate(snap(c.x - d / 2), snap(c.y - d / 2)), {d, d}, ShapeKind::Ellipse, kSquare, fill, 1, ring, 1, 1.5, 0),
         Pass::Shape);
  };
  const Color pink = Color::hex(0xFF24BD);

  // ---- Measurements: saved ones, then the tool's draft and the edge under the pointer.
  auto measurement = [&](const MeasurementMark& m, bool draft) {
    Vec2 a = view.apply(m.a), b = view.apply(m.b);
    for (const GuideLine& g : m.extensions) dashed(view.apply(g.a), view.apply(g.b), pink);
    double width = m.selected ? 2 : 1;
    segment(a, b, width, pink, 1);
    Vec2 d = b - a;
    double len = d.length();
    if (len < 1e-9) return;
    Vec2 n{-d.y / len, d.x / len};
    for (Vec2 end : {a, b}) segment(end - n * (style.tick / 2 + 1), end + n * (style.tick / 2 + 1), width, pink, 1);
    if (m.text.empty()) return;
    const text::TextLayout* L = label(m.text, "Medium", style.labelSize, 200);
    double tw = L ? L->size.x : 6.2 * static_cast<double>(m.text.size());
    if (L && !L->lines.empty()) tw = std::min(tw, L->lines[0].width + 1);
    double pw = std::round(tw + 2 * style.badgePadding), ph = style.pillHeight, rr = style.pillRadius;
    Vec2 c = (a + b) * 0.5;
    double px = snap(c.x - pw / 2), py = snap(c.y - ph / 2);
    emit(makeShape(Mat2x3::translate(px, py), {pw, ph}, ShapeKind::Rect, {rr, rr, rr, rr}, pink, 1, Color{1, 1, 1, 1}, m.selected ? 1 : 0,
                   m.selected ? 1 : 0, 0),
         Pass::Shape);
    if (L && !L->lines.empty()) drawGlyphs(*L, Mat2x3::translate(px + (pw - tw) / 2, snap(py + (ph - L->lines[0].height) / 2)), Color{1, 1, 1, 1}, 1);
    if (recordHits_ && !draft) hits_.measurements.push_back({m.id, {px, py, pw, ph}, a, b});
  };
  if (dev.annotations)
    for (const MeasurementMark& m : dev.measurements) measurement(m, false);
  for (const GuideLine& e : dev.edges) segment(view.apply(e.a), view.apply(e.b), 2, pink, 1);
  if (dev.hasDraft) measurement(dev.draft, true);

  if (!dev.annotations || dev.cards.empty()) return;

  // ---- Annotation labels: beside their design, the side nearer the layer, stacked top to bottom.
  const double W = style.cardWidth, pad = 8, lineGap = 2;
  auto bodyWidth = [&]() { return W - 2 * pad; };
  // A card's content height (and, with `draw`, the content drawn at its top-left).
  auto content = [&](const AnnotationCard& c, double x, double y, bool draw) {
    double h = pad;
    auto put = [&](const std::string& text, const char* weight, const Color& color, double alpha, double maxW, int maxLines, double dx) {
      const text::TextLayout* L = label(text, weight, style.labelSize, maxW, maxLines);
      double lh = L ? L->size.y : 14;
      if (draw && L) drawGlyphs(*L, Mat2x3::translate(snap(x + pad + dx), snap(y + h)), color, alpha);
      return lh;
    };
    if (!c.title.empty()) h += put(c.title, "Medium", c.color, 1, bodyWidth(), 1, 0) + 4;
    for (const AnnotationCard::Line& l : c.lines) h += put(l.text, l.heading ? "Medium" : "Regular", style.cardText, 1, bodyWidth(), l.heading ? 2 : 6, 0) + lineGap;
    if (!c.properties.empty() && (!c.lines.empty() || !c.title.empty())) h += 4;
    for (const auto& [name, value] : c.properties) {
      double lh = put(name, "Regular", style.cardMuted, 1, 96, 1, 0);
      put(value, "Medium", style.cardText, 1, bodyWidth() - 100, 1, 100);
      h += lh + lineGap;
    }
    if (c.lines.empty() && c.properties.empty() && c.title.empty()) h += 14;
    return h + pad - lineGap;
  };

  std::map<std::pair<Guid, bool>, std::vector<Placed>> sides;
  std::vector<Placed> dots;
  for (const AnnotationCard& c : dev.cards) {
    Placed p;
    p.card = &c;
    p.target = transformedBounds(view * Mat2x3::translate(c.target.x, c.target.y), c.target.w, c.target.h);
    p.frame = transformedBounds(view * Mat2x3::translate(c.frameBounds.x, c.frameBounds.y), c.frameBounds.w, c.frameBounds.h);
    double tcx = p.target.x + p.target.w / 2, fcx = p.frame.x + p.frame.w / 2;
    p.right = tcx >= fcx - 0.5;
    p.anchor = {p.right ? p.target.right() : p.target.x, p.target.y + std::min(p.target.h / 2, 12.0)};
    // Labels need room: a design drawn smaller than a label shows dots (as Dev Mode does).
    bool small = p.frame.w < 120 || p.frame.h < 40;
    if ((dev.dots && !c.open) || small) {
      dots.push_back(p);
      continue;
    }
    p.height = content(c, 0, 0, false);
    p.desired = p.anchor.y - 12;
    sides[{c.frame, p.right}].push_back(p);
  }
  // Dots: at the layer's top-right corner.
  for (const Placed& p : dots) {
    Vec2 c{p.target.right(), p.target.y};
    double d = 10;
    dot(c, d, p.card->color, Color{1, 1, 1, 1});
    if (recordHits_) hits_.annotations.push_back({p.card->node, p.card->index, {c.x - d / 2 - 3, c.y - d / 2 - 3, d + 6, d + 6}, true});
  }
  for (auto& [key, list] : sides) {
    std::stable_sort(list.begin(), list.end(), [](const Placed& a, const Placed& b) { return a.desired < b.desired; });
    double bottom = -1e18;
    for (Placed& p : list) {
      p.top = std::max(p.desired, bottom + 8);
      bottom = p.top + p.height;
    }
    for (const Placed& p : list) {
      const AnnotationCard& c = *p.card;
      double x = snap(p.right ? p.frame.right() + style.cardGap : p.frame.x - style.cardGap - W), y = snap(p.top);
      // The leader line: from the layer's edge to the label's near edge, a dot on the layer.
      Vec2 end{p.right ? x : x + W, y + 12};
      segment(p.anchor, end, c.selected ? 1.5 : 1, c.color, 1);
      dot(p.anchor, 6, c.color, c.color);
      // The label.
      double rr = 6;
      emit(makeShape(Mat2x3::translate(x, y), {W, p.height}, ShapeKind::Rect, {rr, rr, rr, rr}, style.cardFill, 1, c.selected ? c.color : style.cardBorder, 1,
                     c.selected ? 2 : 1, 0),
           Pass::Shape);
      // The category's colour along its leading edge.
      emit(makeShape(Mat2x3::translate(p.right ? x : x + W - 3, y + rr), {3, std::max(0.0, p.height - 2 * rr)}, ShapeKind::Rect, kSquare, c.color, 1, c.color, 0, 0, 0),
           Pass::Shape);
      content(c, x + (p.right ? 3 : 0), y, true);
      if (recordHits_) hits_.annotations.push_back({c.node, c.index, {x, y, W, p.height}, false});
    }
  }
}

}  // namespace eng
