// Prototype mode's canvas marks (docs/research/figma/R8-prototyping.md §6): the connections ("noodles") — a blue
// curve from a dot on the hotspot's edge to an arrow at the destination's edge —, the "+" connection handle on a
// selected hotspot's right edge, the frame a dragged noodle will connect to, and the flow starting point labels
// (a blue tag with a play icon and the flow's name, where the frame's title starts).

#include <algorithm>
#include <cmath>

#include "render/Renderer.h"

namespace eng {

namespace {
const CornerRadii kSquare{0, 0, 0, 0};
constexpr double kNoodleWidth = 2;
constexpr double kHandleRadius = 6;
constexpr double kDotRadius = 3;
constexpr double kArrow = 8;
}  // namespace

NoodleCurve prototypeNoodle(const Rect& source, const Rect& dest, bool toPoint, Vec2 point) {
  NoodleCurve n;
  double scy = source.y + source.h / 2;
  Vec2 target = toPoint ? point : Vec2{dest.x + dest.w / 2, dest.y + dest.h / 2};
  // Leave from the side facing the destination.
  bool right = target.x >= source.x + source.w / 2;
  n.a = {right ? source.right() : source.x, scy};
  if (toPoint) {
    n.b = point;
  } else {
    // Arrive at the destination's side facing the hotspot, level with it where the destination allows.
    bool fromLeft = n.a.x <= dest.x + dest.w / 2;
    double y = std::clamp(scy, dest.y + std::min(16.0, dest.h / 2), dest.bottom() - std::min(16.0, dest.h / 2));
    n.b = {fromLeft ? dest.x : dest.right(), y};
  }
  double reach = std::max(40.0, std::fabs(n.b.x - n.a.x) / 2);
  double s0 = right ? 1 : -1;
  n.c1 = {n.a.x + s0 * reach, n.a.y};
  double s1 = n.b.x >= n.a.x ? 1 : -1;
  if (!toPoint) s1 = n.a.x <= dest.x + dest.w / 2 ? 1 : -1;
  n.c2 = {n.b.x - s1 * reach, n.b.y};
  Vec2 d = n.b - n.c2;
  double len = d.length();
  n.dir = len > 1e-9 ? Vec2{d.x / len, d.y / len} : Vec2{s1, 0};
  return n;
}

void Renderer::drawPrototypeLabels(const Document& doc, const Camera& camera, const Overlay& overlay, const OverlayStyle& style) {
  const PrototypeOverlay& po = overlay.prototype;
  po.labelWidths.clear();
  const double dpr = viewport_.scaleX();
  Mat2x3 view = camera.matrix();
  const Color white{1, 1, 1, 1};
  const Color& blue = style.selection;
  for (const PrototypeFlowLabel& f : po.flows) {
    if (!doc.has(f.frame)) continue;
    Rect b = transformedBounds(view * Mat2x3::translate(f.bounds.x, f.bounds.y), f.bounds.w, f.bounds.h);
    if (b.w < 12) continue;
    const text::TextLayout* L = label(f.name, "Medium", style.labelSize, std::max(24.0, b.w - 40));
    double textW = L && !L->lines.empty() ? L->lines[0].width : 0;
    double h = 16, pad = 4, icon = 8;
    double w = std::round(pad + icon + (textW > 0 ? 4 + textW : 0) + pad);
    double x = std::round(b.x * dpr) / dpr;
    double baseline = std::round((b.y - style.titleBaselineGap) * dpr) / dpr;
    double top = std::round((baseline - 12) * dpr) / dpr;
    emit(makeShape(Mat2x3::translate(x, top), {w, h}, ShapeKind::Rect, {2, 2, 2, 2}, blue, 1, blue, 0, 0, 0), Pass::Shape);
    // The play icon: a triangle in white, rows of device pixels.
    double ix = x + pad, iy = top + (h - icon) / 2;
    int rows = std::max(1, static_cast<int>(std::round(icon * dpr)));
    for (int r = 0; r < rows; r++) {
      double t = (r + 0.5) / rows;
      double half = t <= 0.5 ? t : 1 - t;  // 0 at the tips, ½ at the middle
      double rw = icon * 0.9 * half * 2;
      emit(makeShape(Mat2x3::translate(ix + 1, iy + r / dpr), {rw, 1 / dpr}, ShapeKind::Rect, kSquare, white, 1, white, 0, 0, 0), Pass::Shape);
    }
    if (L && !L->lines.empty()) drawGlyphs(*L, Mat2x3::translate(ix + icon + 4, baseline - L->lines[0].baseline), white, 1);
    po.labelWidths.emplace_back(f.frame, w + 6);
  }
}

void Renderer::drawPrototypeOverlay(const Document& /*doc*/, Guid /*page*/, const Camera& camera, const Overlay& overlay,
                                    const OverlayStyle& style) {
  const PrototypeOverlay& po = overlay.prototype;
  Mat2x3 view = camera.matrix();
  const Color white{1, 1, 1, 1};
  const Color& blue = style.selection;
  auto toScreen = [&](const Rect& r) { return transformedBounds(view * Mat2x3::translate(r.x, r.y), r.w, r.h); };
  auto segment = [&](Vec2 a, Vec2 b, double width, const Color& c, double alpha) {
    Vec2 d = b - a;
    double len = d.length();
    if (len < 1e-9) return;
    Vec2 u{d.x / len, d.y / len}, nn{-u.y, u.x};
    Mat2x3 m{u.x, nn.x, a.x - nn.x * width / 2, u.y, nn.y, a.y - nn.y * width / 2};
    emit(makeShape(m, {len, width}, ShapeKind::Rect, kSquare, c, alpha, c, 0, 0, 0), Pass::Shape);
  };
  auto dot = [&](Vec2 p, double r, const Color& fill, double fillAlpha, const Color& stroke, double strokeWidth) {
    emit(makeShape(Mat2x3::translate(p.x - r, p.y - r), {2 * r, 2 * r}, ShapeKind::Ellipse, kSquare, fill, fillAlpha, stroke,
                   strokeWidth > 0 ? 1 : 0, strokeWidth, 0),
         Pass::Shape);
  };

  // The frame a dragged noodle connects to.
  if (po.hasTarget) {
    Rect r = toScreen(po.target);
    emit(makeShape(Mat2x3::translate(r.x, r.y), {r.w, r.h}, ShapeKind::Rect, kSquare, blue, 0, blue, 1, 2, 0), Pass::Shape);
  }

  // Noodles: the quieter ones first.
  for (int pass = 0; pass < 2; pass++)
    for (const PrototypeLink& l : po.links) {
      if (l.highlighted != (pass == 1)) continue;
      double alpha = l.highlighted ? 1 : 0.35;
      Rect src = toScreen(l.source);
      Rect dst = l.toPoint ? Rect{} : toScreen(l.dest);
      NoodleCurve n = prototypeNoodle(src, dst, l.toPoint, view.apply(l.point));
      // The arrow's tip at b; the curve stops at its base.
      Vec2 base = n.b - Vec2{n.dir.x * kArrow * 0.8, n.dir.y * kArrow * 0.8};
      Vec2 prev = n.a;
      const int steps = 32;
      for (int i = 1; i <= steps; i++) {
        double t = static_cast<double>(i) / steps;
        double u = 1 - t;
        Vec2 c2 = n.c2;
        Vec2 end = base;
        Vec2 p{u * u * u * n.a.x + 3 * u * u * t * n.c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
               u * u * u * n.a.y + 3 * u * u * t * n.c1.y + 3 * u * t * t * c2.y + t * t * t * end.y};
        segment(prev, p, kNoodleWidth, blue, alpha);
        if (i > 1) dot(prev, kNoodleWidth / 2, blue, alpha, blue, 0);
        prev = p;
      }
      // Arrowhead: a filled triangle in rows across its length.
      Vec2 nrm{-n.dir.y, n.dir.x};
      int rows = 10;
      for (int r = 0; r < rows; r++) {
        double t0 = static_cast<double>(r) / rows, t1 = static_cast<double>(r + 1) / rows;
        double halfW = (1 - (t0 + t1) / 2) * kArrow * 0.6;
        Vec2 a = n.b - Vec2{n.dir.x * kArrow * (1 - t0), n.dir.y * kArrow * (1 - t0)};
        segment(a - Vec2{nrm.x * halfW, nrm.y * halfW}, a + Vec2{nrm.x * halfW, nrm.y * halfW}, kArrow / rows + 0.5, blue, alpha);
      }
      // The start dot on the hotspot's edge.
      dot(n.a, kDotRadius, blue, alpha, blue, 0);
    }

  // "+" connection handles on the selected hotspots' right edges.
  for (const Rect& h : po.handles) {
    Rect r = toScreen(h);
    Vec2 c{r.right(), r.y + r.h / 2};
    if (po.handleHovered) {
      // Hovered: the plus that starts a connection.
      dot(c, kHandleRadius, white, 1, blue, 1.5);
      segment({c.x - 3, c.y}, {c.x + 3, c.y}, 1.5, blue, 1);
      segment({c.x, c.y - 3}, {c.x, c.y + 3}, 1.5, blue, 1);
    } else {
      dot(c, kDotRadius + 1, blue, 1, white, 1);
    }
  }
}

}  // namespace eng
