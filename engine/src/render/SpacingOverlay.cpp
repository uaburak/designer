// Auto layout's spacing handles on the canvas (round 15; live Figma, the owner's recording and screenshots —
// docs/research/figma/live/behaviour/spacing-handles.md): a short bar in the middle of each padding (the selection
// blue — purple in a component or instance) and gap (pink), 1 px across with a white edge; the padding or gap under the pointer hatched in its colour
// (a light wash and "/" stripes, fixed on screen); the one being dragged outlined 1 px instead; the value in a badge of
// its colour hanging right of and above the pointer. Screen space (CSS px); axis-aligned pieces on device pixels.

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>

#include "render/Renderer.h"

namespace eng {

namespace {

const CornerRadii kSquare{0, 0, 0, 0};

std::string formatValue(double v) {
  char buf[32];
  std::snprintf(buf, sizeof buf, "%.2f", std::round(v * 100) / 100);
  std::string s = buf;
  while (!s.empty() && s.back() == '0') s.pop_back();
  if (!s.empty() && s.back() == '.') s.pop_back();
  return s == "-0" ? "0" : s;
}

double dot(Vec2 a, Vec2 b) { return a.x * b.x + a.y * b.y; }

}  // namespace

void Renderer::drawSpacing(const Mat2x3& view, const Overlay& overlay, const OverlayStyle& style, const Color& padding) {
  const double dpr = viewport_.scaleX();
  auto snap = [&](double v) { return std::round(v * dpr) / dpr; };
  const Color white{1, 1, 1, 1};

  // The hatched (hovered) or outlined (dragged) padding / gap.
  for (const Overlay::SpacingArea& area : overlay.spacingAreas) {
    const Color& color = area.gap ? style.spacing : padding;
    Vec2 q[4];
    for (int i = 0; i < 4; i++) q[i] = view.apply(area.quad[i]);
    Vec2 e1 = q[1] - q[0], e2 = q[3] - q[0];
    double l1 = e1.length(), l2 = e2.length();
    bool upright = (std::fabs(e1.y) < 1e-9 && std::fabs(e2.x) < 1e-9) || (std::fabs(e1.x) < 1e-9 && std::fabs(e2.y) < 1e-9);
    Mat2x3 box;
    Vec2 size;
    if (upright) {
      double x0 = snap(std::min({q[0].x, q[1].x, q[2].x, q[3].x})), x1 = snap(std::max({q[0].x, q[1].x, q[2].x, q[3].x}));
      double y0 = snap(std::min({q[0].y, q[1].y, q[2].y, q[3].y})), y1 = snap(std::max({q[0].y, q[1].y, q[2].y, q[3].y}));
      box = Mat2x3::translate(x0, y0);
      size = {x1 - x0, y1 - y0};
      q[0] = {x0, y0}, q[1] = {x1, y0}, q[2] = {x1, y1}, q[3] = {x0, y1};
    } else {
      Vec2 a = l1 > 1e-9 ? Vec2{e1.x / l1, e1.y / l1} : Vec2{1, 0};
      Vec2 b = l2 > 1e-9 ? Vec2{e2.x / l2, e2.y / l2} : Vec2{-a.y, a.x};
      box = Mat2x3{a.x, b.x, q[0].x, a.y, b.y, q[0].y};
      size = {l1, l2};
    }
    if (area.outline) {
      // A zero-wide gap (or a padding of 0): one line.
      if (size.x < 1 / dpr || size.y < 1 / dpr) {
        Vec2 s{std::max(size.x, 1.0), std::max(size.y, 1.0)};
        Mat2x3 m = box;
        if (size.x < 1 / dpr) m = m * Mat2x3::translate(-0.5, 0);
        else m = m * Mat2x3::translate(0, -0.5);
        emit(makeShape(m, s, ShapeKind::Rect, kSquare, color, 1, color, 0, 0, 0), Pass::Shape);
      } else {
        emit(makeShape(box, size, ShapeKind::Rect, kSquare, color, 0, color, 1, 1, 0), Pass::Shape);
      }
      continue;
    }
    if (size.x <= 0 || size.y <= 0) continue;
    emit(makeShape(box, size, ShapeKind::Rect, kSquare, color, style.hatchWash, color, 0, 0, 0), Pass::Shape);
    // The stripes: lines n·p = c, `period / √2` apart across them (`period` along a row), each clipped to the quad.
    const double k = std::sqrt(0.5);
    const Vec2 u{k, -k}, n{k, k};
    const double sp = style.hatchPeriod * k, w = style.hatchWidth;
    double cMin = 1e300, cMax = -1e300;
    Vec2 mid{0, 0};
    for (const Vec2& p : q) {
      cMin = std::min(cMin, dot(n, p)), cMax = std::max(cMax, dot(n, p));
      mid = {mid.x + p.x / 4, mid.y + p.y / 4};
    }
    // The pattern's phase: from the quad's first corner (it moves with the frame, not with the screen).
    const double c0 = dot(n, q[0]);
    double first = c0 + std::ceil((cMin - c0) / sp) * sp;
    for (double c = first; c <= cMax; c += sp) {
      double t0 = -1e300, t1 = 1e300;
      bool empty = false;
      for (int i = 0; i < 4 && !empty; i++) {
        Vec2 a = q[i], b = q[(i + 1) % 4];
        Vec2 d = b - a;
        Vec2 m{-d.y, d.x};
        if (dot(m, mid - a) < 0) m = {-m.x, -m.y};  // inward
        // m·(n c + u t − a) ≥ 0
        double mu = dot(m, u), rhs = dot(m, Vec2{a.x - n.x * c, a.y - n.y * c});
        if (std::fabs(mu) < 1e-12) {
          if (rhs > 0) empty = true;
        } else if (mu > 0) {
          t0 = std::max(t0, rhs / mu);
        } else {
          t1 = std::min(t1, rhs / mu);
        }
      }
      if (empty || t1 - t0 < 1e-6) continue;
      Vec2 o{n.x * c + u.x * t0 - n.x * w / 2, n.y * c + u.y * t0 - n.y * w / 2};
      emit(makeShape(Mat2x3{u.x, n.x, o.x, u.y, n.y, o.y}, {t1 - t0, w}, ShapeKind::Rect, kSquare, color, style.hatchInk, color, 0, 0, 0), Pass::Shape);
    }
  }

  // The bars: 12 px along, 1 across, on a white edge (live 49.png at 2×: a 1 px white rim round the pink line).
  for (const Overlay::LayoutBar& bar : overlay.layoutBars) {
    if (bar.box) continue;
    const Color& color = bar.gap ? style.spacing : padding;
    Vec2 c = view.apply(bar.at);
    Vec2 d = view.applyLinear(bar.axis);
    double dl = d.length();
    Vec2 a = dl > 1e-9 ? Vec2{d.x / dl, d.y / dl} : Vec2{1, 0};
    Vec2 nrm{-a.y, a.x};
    const double len = 12, thick = 1, rim = 0.5;
    bool upright = std::fabs(a.x) < 1e-9 || std::fabs(a.y) < 1e-9;
    for (int pass = 0; pass < 2; pass++) {
      double L = len + (pass == 0 ? 2 * rim : 0), T = thick + (pass == 0 ? 2 * rim : 0);
      const Color& ink = pass == 0 ? white : color;
      if (upright) {
        bool horizontal = std::fabs(a.y) < 1e-9;
        Vec2 s = horizontal ? Vec2{L, T} : Vec2{T, L};
        double x = snap(c.x - s.x / 2), y = snap(c.y - s.y / 2);
        emit(makeShape(Mat2x3::translate(x, y), s, ShapeKind::Rect, kSquare, ink, 1, ink, 0, 0, 0), Pass::Shape);
      } else {
        Vec2 o{c.x - a.x * L / 2 - nrm.x * T / 2, c.y - a.y * L / 2 - nrm.y * T / 2};
        emit(makeShape(Mat2x3{a.x, nrm.x, o.x, a.y, nrm.y, o.y}, {L, T}, ShapeKind::Rect, kSquare, ink, 1, ink, 0, 0, 0), Pass::Shape);
      }
    }
  }

  // The value: right of the pointer and above it (live Figma, the owner's recording — measured over hovers and drags of
  // padding and gaps: the badge's left 10 px right of the pointer, its bottom 10 px above it), in its handle's colour;
  // an Auto gap reads "Auto".
  for (const Overlay::LayoutBar& bar : overlay.layoutBars) {
    if (!bar.hovered) continue;
    const Color& color = bar.gap ? style.spacing : padding;
    std::string text = bar.autoGap ? "Auto" : formatValue(bar.value);
    const text::TextLayout* L = label(text, "Medium", style.labelSize);
    double tw = L ? L->size.x : 6.2 * static_cast<double>(text.size());
    double pw = std::max(std::round(tw + 2 * style.badgePadding), style.badgeHeight), ph = style.badgeHeight, rr = style.badgeRadius;
    Vec2 p = view.apply(bar.edge);
    double px = snap(p.x + 10), py = snap(p.y - 10 - ph);
    emit(makeShape(Mat2x3::translate(px, py), {pw, ph}, ShapeKind::Rect, {rr, rr, rr, rr}, color, 1, color, 0, 0, 0), Pass::Shape);
    if (L && !L->lines.empty()) drawGlyphs(*L, Mat2x3::translate(px + (pw - tw) / 2, snap(py + (ph - L->lines[0].height) / 2)), white, 1);
  }
}

}  // namespace eng
