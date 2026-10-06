// The editor's canvas overlays, drawn after the scene in CSS px with 1-px lines
// snapped to device pixels (docs/engine.md §6.11).

#include <cmath>
#include <cstdio>
#include <string>

#include "editor/Selection.h"
#include "render/Renderer.h"

namespace eng {

namespace {

const CornerRadii kSquare{0, 0, 0, 0};

// A box `toScreen` maps from [0,size], re-expressed with unit-length axes so a
// stroke of 1 is one CSS px; axis-aligned boxes are snapped to device pixels.
struct ScreenBox {
  Mat2x3 m;
  Vec2 size;
  double axisScale = 1;
};

ScreenBox screenBox(const Mat2x3& toScreen, Vec2 size, double dpr) {
  ScreenBox b;
  if (std::fabs(toScreen.m01) < 1e-9 && std::fabs(toScreen.m10) < 1e-9) {
    Rect r = transformedBounds(toScreen, size.x, size.y);
    double x0 = std::round(r.x * dpr) / dpr, y0 = std::round(r.y * dpr) / dpr;
    double x1 = std::round(r.right() * dpr) / dpr, y1 = std::round(r.bottom() * dpr) / dpr;
    b.m = Mat2x3::translate(x0, y0);
    b.size = {x1 - x0, y1 - y0};
    b.axisScale = std::fabs(toScreen.m00);
    return b;
  }
  double l0 = std::hypot(toScreen.m00, toScreen.m10), l1 = std::hypot(toScreen.m01, toScreen.m11);
  if (l0 <= 0) l0 = 1;
  if (l1 <= 0) l1 = 1;
  b.m = {toScreen.m00 / l0, toScreen.m01 / l1, toScreen.m02, toScreen.m10 / l0, toScreen.m11 / l1, toScreen.m12};
  b.size = {size.x * l0, size.y * l1};
  b.axisScale = l0;
  return b;
}

// "W × H" with up to 2 decimals, trailing zeros trimmed.
std::string formatNumber(double v) {
  char buf[32];
  std::snprintf(buf, sizeof buf, "%.2f", std::round(v * 100) / 100);
  std::string s = buf;
  while (!s.empty() && s.back() == '0') s.pop_back();
  if (!s.empty() && s.back() == '.') s.pop_back();
  return s == "-0" ? "0" : s;
}

}  // namespace

void Renderer::drawOverlay(const Document& doc, const Camera& camera, const Overlay& overlay, const OverlayStyle& style) {
  const double dpr = viewport_.scaleX();  // snap to the canvas's real pixels
  const Color& blue = style.selection;
  const Color white{1, 1, 1, 1};
  Mat2x3 view = camera.matrix();

  auto outline = [&](const Mat2x3& toScreen, Vec2 size, ShapeKind kind, const CornerRadii& radii, double weight) {
    ScreenBox b = screenBox(toScreen, size, dpr);
    CornerRadii r = kSquare;
    for (int i = 0; i < 4; i++) r[i] = radii[i] * b.axisScale;
    emit(makeShape(b.m, b.size, kind, r, blue, 0, blue, 1, weight, 0), Pass::Color);
  };
  auto nodeOutline = [&](Guid id, double weight, bool ownShape) {
    const Node* n = doc.get(id);
    if (!n) return;
    Rect lb = doc.localBounds(id);
    Mat2x3 m = view * doc.worldTransform(id) * Mat2x3::translate(lb.x, lb.y);
    ShapeKind kind = ownShape && n->props.type == NodeType::ELLIPSE ? ShapeKind::Ellipse : ShapeKind::Rect;
    bool rounded = ownShape && (n->props.isRectLike() || n->props.isFrameLike());
    outline(m, {lb.w, lb.h}, kind, rounded ? n->props.cornerRadii : kSquare, weight);
  };

  // Hover: the hovered layer's own outline (not when it is selected).
  for (Guid h : overlay.hover) {
    bool selected = false;
    for (Guid s : overlay.selection) selected |= s == h;
    if (!selected && doc.has(h)) nodeOutline(h, style.hoverWidth, true);
  }

  // Selection: each layer's box, the selection's box, its handles and size badge.
  SelectionBox box = selectionBox(doc, overlay.selection);
  if (box.valid) {
    if (overlay.selection.size() > 1)
      for (Guid s : overlay.selection) nodeOutline(s, 1, false);
    Mat2x3 toScreen = view * box.toWorld;
    ScreenBox sb = screenBox(toScreen, box.size, dpr);
    emit(makeShape(sb.m, sb.size, ShapeKind::Rect, kSquare, blue, 0, blue, 1, 1, 0), Pass::Color);

    bool roomy = sb.size.x >= style.handlesMinBox && sb.size.y >= style.handlesMinBox;
    if (overlay.handles && roomy) {
      const double hs = style.handleSize;
      Vec2 corners[4] = {{0, 0}, {sb.size.x, 0}, {sb.size.x, sb.size.y}, {0, sb.size.y}};
      for (auto& c : corners) {
        Mat2x3 hm = sb.m;
        Vec2 o = sb.m.apply(c) - sb.m.applyLinear({hs / 2, hs / 2});
        hm.m02 = std::round(o.x * dpr) / dpr;
        hm.m12 = std::round(o.y * dpr) / dpr;
        emit(makeShape(hm, {hs, hs}, ShapeKind::Rect, kSquare, white, 1, blue, 1, 1, 0), Pass::Color);
      }
    }

    if (overlay.sizeBadge) {
      // The pill under the box; its text arrives with the text engine (E3), so it is sized for it now.
      Rect r = transformedBounds(toScreen, box.size.x, box.size.y);
      Mat2x3 w = box.toWorld;
      Vec2 worldSize{box.size.x * std::hypot(w.m00, w.m10), box.size.y * std::hypot(w.m01, w.m11)};
      std::string label = formatNumber(worldSize.x) + " x " + formatNumber(worldSize.y);
      double bw = 8 + 6.2 * static_cast<double>(label.size()), bh = style.badgeHeight;
      double bx = std::round((r.x + r.w / 2 - bw / 2) * dpr) / dpr;
      double by = std::round((r.bottom() + style.badgeGap) * dpr) / dpr;
      double rr = style.badgeRadius;
      emit(makeShape(Mat2x3::translate(bx, by), {bw, bh}, ShapeKind::Rect, {rr, rr, rr, rr}, blue, 1, blue, 0, 0, 0),
           Pass::Color);
    }
  }

  if (overlay.hasMarquee) {
    const Rect& q = overlay.marquee;
    Rect r = transformedBounds(view * Mat2x3::translate(q.x, q.y), q.w, q.h);
    ScreenBox b = screenBox(Mat2x3::translate(r.x, r.y), {r.w, r.h}, dpr);
    emit(makeShape(b.m, b.size, ShapeKind::Rect, kSquare, blue, style.marqueeFill, blue, 1, 1, 0), Pass::Color);
  }
}

}  // namespace eng
