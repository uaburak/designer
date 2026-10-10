// The canvas scrollbars (round 16; docs/engine.md §6.11 "Scrollbars"): their geometry from the visible canvas and the
// page's content on screen, and their look — measured on the owner's live Figma screenshots 58 / 59.png (both bars,
// content past two corners) and 61–63.png (the docked UI: the bars inside the panels and rulers; no bar on an axis the
// content fits).

#include <algorithm>
#include <cmath>

#include "render/Renderer.h"

namespace eng {

Scrollbars scrollbarGeometry(const Rect& vis, const Rect& content, bool any, double rightClear) {
  Scrollbars s;
  const double T = Scrollbars::kThickness, I = Scrollbars::kInset;
  auto axis = [&](bool vertical) {
    ScrollbarAxis a;
    a.vertical = vertical;
    const double vs = vertical ? vis.y : vis.x, vl = vertical ? vis.h : vis.w;
    a.viewStart = vs;
    a.viewLength = vl;
    a.extentStart = vs;
    a.extentLength = vl;
    if (!any || vl <= 0) return a;
    const double cs = vertical ? content.y : content.x, ce = cs + (vertical ? content.h : content.w);
    const double es = std::min(vs, cs), ee = std::max(vs + vl, ce);
    a.extentStart = es;
    a.extentLength = ee - es;
    // Each track starts `kInset` in and stops short of the corner the other bar takes (live: both do, whether or not
    // the other bar shows — 61.png's lone bar ends 9 px short of the right edge too).
    const double trackStart = vs + I, trackLength = vl - I - (I + T) - (vertical ? 0 : rightClear);
    if (a.extentLength <= vl + 0.5 || trackLength < 2 * Scrollbars::kMinThumb) return a;
    a.show = true;
    const double len = std::max(Scrollbars::kMinThumb, trackLength * vl / a.extentLength);
    const double offset = (vs - es) / (a.extentLength - vl) * (trackLength - len);
    if (vertical) {
      a.track = {vis.right() - rightClear - I - T, trackStart, T, trackLength};
      a.thumb = {a.track.x, trackStart + offset, T, len};
    } else {
      a.track = {trackStart, vis.bottom() - I - T, trackLength, T};
      a.thumb = {trackStart + offset, a.track.y, len, T};
    }
    return a;
  };
  s.h = axis(false);
  s.v = axis(true);
  return s;
}

void Renderer::drawScrollbars(const ScrollbarOverlay& o, const OverlayStyle& style) {
  if (o.alpha <= 0) return;
  const double sx = viewport_.scaleX() > 0 ? viewport_.scaleX() : 1, sy = viewport_.scaleY() > 0 ? viewport_.scaleY() : 1;
  auto bar = [&](const ScrollbarAxis& a, bool hot) {
    if (!a.show) return;
    // On whole device pixels: a thumb is a pill, 1 px of rim inside.
    double x0 = std::round(a.thumb.x * sx) / sx, y0 = std::round(a.thumb.y * sy) / sy;
    double x1 = std::round(a.thumb.right() * sx) / sx, y1 = std::round(a.thumb.bottom() * sy) / sy;
    double r = std::min(x1 - x0, y1 - y0) / 2;
    const Color& fill = hot ? style.scrollbarFillHover : style.scrollbarFill;
    emit(makeShape(Mat2x3::translate(x0, y0), {x1 - x0, y1 - y0}, ShapeKind::Rect, {r, r, r, r}, fill, fill.a * o.alpha, style.scrollbarRim,
                   style.scrollbarRim.a * o.alpha, 1, 0),
         Pass::Shape);
  };
  bar(o.bars.h, o.hotH);
  bar(o.bars.v, o.hotV);
}

}  // namespace eng
