// Prototype mode's canvas marks (docs/research/figma/R8-prototyping.md §6): the connections ("noodles") — a blue
// curve from a dot in the middle of one of the hotspot's sides to an arrow in the middle of one of the destination's
// (round 16: any of the four, Figma's rule in Renderer.h prototypeNoodle) —, the connection nub on a selected
// hotspot's side nearest the pointer ("+" when hovered), the frame a dragged noodle will connect to, and the flow
// starting point labels (a blue tag with a play icon and the flow's name, where the frame's title starts).

#include <algorithm>
#include <cmath>

#include "render/Renderer.h"

namespace eng {

namespace {
const CornerRadii kSquare{0, 0, 0, 0};
constexpr double kArrow = 8;
constexpr double kMinReach = 20;  // a control point's least distance from its end (boxes level with each other)
}  // namespace

Vec2 sideCentre(const Rect& r, NoodleSide side) {
  switch (side) {
    case NoodleSide::TOP: return {r.x + r.w / 2, r.y};
    case NoodleSide::RIGHT: return {r.right(), r.y + r.h / 2};
    case NoodleSide::BOTTOM: return {r.x + r.w / 2, r.bottom()};
    case NoodleSide::LEFT: return {r.x, r.y + r.h / 2};
  }
  return {r.right(), r.y + r.h / 2};
}

Vec2 sideNormal(NoodleSide side) {
  switch (side) {
    case NoodleSide::TOP: return {0, -1};
    case NoodleSide::RIGHT: return {1, 0};
    case NoodleSide::BOTTOM: return {0, 1};
    case NoodleSide::LEFT: return {-1, 0};
  }
  return {1, 0};
}

NoodleSide nearestSide(const Rect& r, Vec2 p) {
  // The distance from `p` to each side (a segment); ties go right, bottom, left, top.
  auto toSegment = [&](Vec2 a, Vec2 b) {
    Vec2 d = b - a;
    double len2 = d.x * d.x + d.y * d.y;
    double t = len2 > 0 ? std::clamp(((p.x - a.x) * d.x + (p.y - a.y) * d.y) / len2, 0.0, 1.0) : 0;
    Vec2 q{a.x + d.x * t, a.y + d.y * t};
    return (p - q).length();
  };
  const NoodleSide order[4] = {NoodleSide::RIGHT, NoodleSide::BOTTOM, NoodleSide::LEFT, NoodleSide::TOP};
  double best = 1e300;
  NoodleSide out = NoodleSide::RIGHT;
  for (NoodleSide s : order) {
    Vec2 a, b;
    switch (s) {
      case NoodleSide::TOP: a = {r.x, r.y}, b = {r.right(), r.y}; break;
      case NoodleSide::RIGHT: a = {r.right(), r.y}, b = {r.right(), r.bottom()}; break;
      case NoodleSide::BOTTOM: a = {r.x, r.bottom()}, b = {r.right(), r.bottom()}; break;
      case NoodleSide::LEFT: a = {r.x, r.y}, b = {r.x, r.bottom()}; break;
    }
    double d = toSegment(a, b);
    if (d < best - 1e-9) best = d, out = s;
  }
  return out;
}

NoodleCurve prototypeNoodle(const Rect& source, const Rect& dest, bool toPoint, Vec2 point, int startSide) {
  NoodleCurve n;
  Rect d = toPoint ? Rect{point.x, point.y, 0, 0} : dest;
  Vec2 sc{source.x + source.w / 2, source.y + source.h / 2}, dc{d.x + d.w / 2, d.y + d.h / 2};
  // Leave a side facing the destination: across when the boxes don't overlap across, else up or down.
  bool apartAcross = d.right() < source.x || d.x > source.right();
  if (startSide >= 0 && startSide <= 3) n.start = static_cast<NoodleSide>(startSide);
  else if (apartAcross) n.start = dc.x >= sc.x ? NoodleSide::RIGHT : NoodleSide::LEFT;
  else n.start = dc.y >= sc.y ? NoodleSide::BOTTOM : NoodleSide::TOP;
  n.a = sideCentre(source, n.start);
  Vec2 n1 = sideNormal(n.start);
  if (toPoint) {
    n.b = point;
    double k = std::max(kMinReach, std::fabs((n.b - n.a).x * n1.x + (n.b - n.a).y * n1.y) / 2);
    n.c1 = n.a + Vec2{n1.x * k, n1.y * k};
    n.c2 = n.b;
    Vec2 dd = n.b - n.c1;
    double len = dd.length();
    n.dir = len > 1e-9 ? Vec2{dd.x / len, dd.y / len} : n1;
    return n;
  }
  // Arrive at a side facing the hotspot: from above or below when they don't overlap down, else from the side.
  bool apartDown = d.bottom() < source.y || d.y > source.bottom();
  if (apartDown) n.end = sc.y <= dc.y ? NoodleSide::TOP : NoodleSide::BOTTOM;
  else n.end = sc.x <= dc.x ? NoodleSide::LEFT : NoodleSide::RIGHT;
  n.b = sideCentre(d, n.end);
  Vec2 n2 = sideNormal(n.end);
  Vec2 ab = n.b - n.a;
  // Each control point half the distance along its own side's normal (fitted on 61.png's curves: 0.47–0.58).
  double k1 = std::max(kMinReach, std::fabs(ab.x * n1.x + ab.y * n1.y) / 2);
  double k2 = std::max(kMinReach, std::fabs(ab.x * n2.x + ab.y * n2.y) / 2);
  n.c1 = n.a + Vec2{n1.x * k1, n1.y * k1};
  n.c2 = n.b + Vec2{n2.x * k2, n2.y * k2};
  n.dir = {-n2.x, -n2.y};
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

  // Noodles: the quieter ones (opaque light blue, live 61–67.png) first.
  const double kNoodleWidth = style.noodleWidth;
  const double dpr = viewport_.scaleX() > 0 ? viewport_.scaleX() : 1;
  std::vector<std::pair<Vec2, bool>> starts;
  for (int pass = 0; pass < 2; pass++)
    for (const PrototypeLink& l : po.links) {
      if (l.highlighted != (pass == 1)) continue;
      const double alpha = 1;
      const Color& ink = l.highlighted ? blue : style.noodleQuiet;
      Rect src = toScreen(l.source);
      Rect dst = l.toPoint ? Rect{} : toScreen(l.dest);
      NoodleCurve n = prototypeNoodle(src, dst, l.toPoint, view.apply(l.point), l.startSide);
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
        segment(prev, p, kNoodleWidth, ink, alpha);
        if (i > 1) dot(prev, kNoodleWidth / 2, ink, alpha, ink, 0);
        prev = p;
      }
      // Arrowhead: a filled triangle in rows across its length.
      Vec2 nrm{-n.dir.y, n.dir.x};
      int rows = 10;
      for (int r = 0; r < rows; r++) {
        double t0 = static_cast<double>(r) / rows, t1 = static_cast<double>(r + 1) / rows;
        double halfW = (1 - (t0 + t1) / 2) * kArrow * 0.6;
        Vec2 a = n.b - Vec2{n.dir.x * kArrow * (1 - t0), n.dir.y * kArrow * (1 - t0)};
        segment(a - Vec2{nrm.x * halfW, nrm.y * halfW}, a + Vec2{nrm.x * halfW, nrm.y * halfW}, kArrow / rows + 0.5, ink, alpha);
      }
      starts.push_back({n.a, l.highlighted});
    }
  // The start dots over every curve (live 67.png: a white disc in a 2 px ring of the noodle's colour), the
  // selection's last.
  for (int pass = 0; pass < 2; pass++)
    for (const auto& [at, hi] : starts)
      if (hi == (pass == 1)) dot(at, style.noodleDot / 2, white, 1, hi ? blue : style.noodleQuiet, style.nubRing);

  // The selected hotspots' nubs, each at the middle of its side nearest the pointer (live 64–66.png); the hovered one
  // larger with a "+" in it.
  for (const PrototypeHandle& h : po.handles) {
    Rect r = toScreen(h.box);
    Vec2 c = sideCentre(r, h.side);
    c = {std::round(c.x * dpr) / dpr, std::round(c.y * dpr) / dpr};
    if (h.hovered) {
      dot(c, style.nubHoverSize / 2, white, 1, blue, style.nubRing);
      const double arm = 4, bar = 2;  // an 8 × 2 plus
      segment({c.x - arm, c.y}, {c.x + arm, c.y}, bar, blue, 1);
      segment({c.x, c.y - arm}, {c.x, c.y + arm}, bar, blue, 1);
    } else {
      dot(c, style.nubSize / 2, white, 1, blue, style.nubRing);
    }
  }
}

}  // namespace eng
