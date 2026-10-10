// The editor's canvas overlays, drawn after the scene in CSS px with 1-px lines
// snapped to device pixels (docs/engine.md §6.11).

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>

#include "editor/Selection.h"
#include "geometry/Path.h"
#include "geometry/Shapes.h"
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

void Renderer::drawTitleIcon(TitleIcon icon, const Rect& box, const Color& color, const Mat2x3& place) {
  // Diamonds: squares turned 45°, `d` across their diagonal.
  auto diamond = [&](Vec2 c, double d, bool filled) {
    double side = d / std::sqrt(2.0);
    const double k = std::sqrt(0.5);
    // A side×side square turned 45° about its centre c: T(c)·R(45°)·T(−side/2, −side/2).
    Mat2x3 at = place * Mat2x3{k, -k, c.x, k, k, c.y - side * k};
    emit(makeShape(at, {side, side}, ShapeKind::Rect, {0.5, 0.5, 0.5, 0.5}, color, filled ? color.a : 0, color, filled ? 0 : color.a, filled ? 0 : 1, 0),
         Pass::Shape);
  };
  Vec2 c{box.x + box.w / 2, box.y + box.h / 2};
  if (icon == TitleIcon::Instance) {
    diamond(c, box.w - 1, false);
  } else {
    double q = box.w / 4;
    diamond({c.x, c.y - q}, box.w / 2 - 0.5, true);
    diamond({c.x, c.y + q}, box.w / 2 - 0.5, true);
    diamond({c.x - q, c.y}, box.w / 2 - 0.5, true);
    diamond({c.x + q, c.y}, box.w / 2 - 0.5, true);
  }
}

void Renderer::drawDevIcon(Guid frame, DevStatusMark::Kind kind, double right, double baseline, const Color& color, const Mat2x3& place,
                           bool upright, const DevOverlay& dev, const OverlayStyle& style) {
  // Live Figma's `</>` (canvas-autolayout-selected-hover-gap, 2026-10-08): 12 × 10 CSS px, its right edge on the
  // frame's, from 8 px above the name's baseline to 1.5 px below it; 1 px strokes with round ends. Round 15 (the owner's
  // 47.png and recording): it is a button — hovered, a 16 × 16 rounded square of the selection colour behind a white
  // glyph, and after the tooltip delay "Mark as ready for dev" under it; a design ready for dev shows it green (white
  // glyph; hovered "•••"). A turned frame's lies along its top edge at the right end, turned with it (`place`).
  const double dpr = viewport_.scaleX();
  auto snap = [&](double v) { return upright ? std::round(v * dpr) / dpr : v; };
  double x0 = snap(right - kDevIconWidth), y0 = snap(baseline - 8);
  const bool hovered = dev.iconHover == frame;
  const bool ready = kind == DevStatusMark::Kind::ReadyIcon;
  // The button's box: centred on the glyph (12 × 9.6), 16 square.
  Rect box{x0 + kDevIconWidth / 2 - kDevButton / 2, y0 + 4.8 - kDevButton / 2, kDevButton, kDevButton};
  box.x = snap(box.x), box.y = snap(box.y);
  if (hovered || ready) {
    const Color& fill = ready ? style.statusReady : style.selection;
    const double r = kDevButtonRadius;
    emit(makeShape(place * Mat2x3::translate(box.x, box.y), {box.w, box.h}, ShapeKind::Rect, {r, r, r, r}, fill, 1, fill, 0, 0, 0), Pass::Shape);
  }
  const Color ink = hovered || ready ? Color{1, 1, 1, 1} : Color{color.r, color.g, color.b, 1};
  const double alpha = hovered || ready ? 1.0 : color.a;
  const double w = 1;
  auto segment = [&](Vec2 a, Vec2 b) {
    a = {x0 + a.x, y0 + a.y}, b = {x0 + b.x, y0 + b.y};
    Vec2 d = b - a;
    double len = d.length();
    if (len < 1e-9) return;
    Vec2 u{d.x / len, d.y / len}, n{-u.y, u.x};
    emit(makeShape(place * Mat2x3{u.x, n.x, a.x - n.x * w / 2, u.y, n.y, a.y - n.y * w / 2}, {len, w}, ShapeKind::Rect, kSquare, ink, alpha, ink, 0, 0, 0),
         Pass::Shape);
    for (Vec2 p : {a, b})
      emit(makeShape(place * Mat2x3::translate(p.x - w / 2, p.y - w / 2), {w, w}, ShapeKind::Ellipse, kSquare, ink, alpha, ink, 0, 0, 0), Pass::Shape);
  };
  if (ready && hovered) {
    // "•••": three white dots across the middle (live Figma, the owner's recording at 22.0 s).
    const double d = 2.2;
    Vec2 c{box.x + box.w / 2, box.y + box.h / 2};
    for (double dx : {-4.0, 0.0, 4.0})
      emit(makeShape(place * Mat2x3::translate(c.x + dx - d / 2, c.y - d / 2), {d, d}, ShapeKind::Ellipse, kSquare, ink, 1, ink, 0, 0, 0), Pass::Shape);
  } else {
    segment({3, 1.7}, {0.5, 4.2});
    segment({0.5, 4.2}, {3, 6.7});
    segment({7.3, 0}, {4.7, 9.6});
    segment({9, 1.7}, {11.5, 4.2});
    segment({11.5, 4.2}, {9, 6.7});
  }
  Rect screenBox = upright ? box : transformedBounds(place * Mat2x3::translate(box.x, box.y), box.w, box.h);
  // A click on it takes it: its 16 × 16 box (a turned one's, turned).
  if (recordHits_) {
    CanvasHits::Status hit;
    hit.frame = frame;
    hit.rect = screenBox;
    hit.kind = kind;
    if (!upright) {
      hit.turned = true;
      hit.box = box;
      hit.toLocal = place.inverse();
    }
    hits_.statuses.push_back(hit);
  }
  // Its tooltip, drawn over everything else (drawDevTooltip, at the overlay's end).
  if (hovered && dev.tooltip && kind == DevStatusMark::Kind::MarkButton) {
    devTooltip_ = true;
    devTooltipUnder_ = screenBox;
  }
}

void Renderer::drawDevTooltip(const OverlayStyle& style) {
  // Under the button, centred on it, a 5 px arrow pointing up at it (live Figma 47.png: 132 × 24, Inter 11 white on
  // #1e1e1e, the arrow's tip on the button's bottom edge). Unturned, under a turned button's bounds.
  if (!devTooltip_) return;
  devTooltip_ = false;
  const double dpr = viewport_.scaleX();
  static const std::string text = "Mark as ready for dev";
  const text::TextLayout* L = label(text, "Regular", style.labelSize);
  double tw = L ? L->size.x : 6.2 * static_cast<double>(text.size());
  double bw = std::round(tw + 2 * style.tooltipPadding), bh = style.tooltipHeight, r = style.tooltipRadius, a = style.tooltipArrow;
  const Rect& under = devTooltipUnder_;
  double cx = under.x + under.w / 2;
  double bx = std::round((cx - bw / 2) * dpr) / dpr, by = std::round((under.bottom() + a) * dpr) / dpr;
  // The arrow: a square turned 45° whose top corner is the tip; its lower half lies under the box.
  double side = a * std::sqrt(2.0);
  const double k = std::sqrt(0.5);
  emit(makeShape(Mat2x3{k, -k, cx, k, k, by - a}, {side, side}, ShapeKind::Rect, kSquare, style.tooltipFill, 1, style.tooltipFill, 0, 0, 0), Pass::Shape);
  emit(makeShape(Mat2x3::translate(bx, by), {bw, bh}, ShapeKind::Rect, {r, r, r, r}, style.tooltipFill, 1, style.tooltipFill, 0, 0, 0), Pass::Shape);
  if (L && !L->lines.empty())
    drawGlyphs(*L, Mat2x3::translate(bx + (bw - tw) / 2, std::round((by + (bh - L->lines[0].height) / 2) * dpr) / dpr), style.tooltipText, 1);
}

bool Renderer::baselineUnderline(const Document& doc, Guid id, const Mat2x3& view, const Overlay& overlay, const OverlayStyle& style) {
  if (!texts_) return false;
  const text::TextLayout* L = texts_->textLayout(id);
  if (!L) return false;
  const double dpr = viewport_.scaleX();
  bool selected = std::find(overlay.selection.begin(), overlay.selection.end(), id) != overlay.selection.end();
  const double w = selected ? style.selectionWidth : style.hoverWidth;
  const Color& color = style.selection;
  Mat2x3 m = view * doc.worldTransform(id);
  bool upright = std::fabs(m.m01) < 1e-9 && std::fabs(m.m10) < 1e-9 && m.m00 > 0 && m.m11 > 0;
  bool drawn = false;
  for (const text::LaidLine& line : L->lines) {
    if (line.width <= 0) continue;
    Vec2 a = m.apply({line.x, line.baseline}), b = m.apply({line.x + line.width, line.baseline});
    if (upright) {
      // On device pixels: from the baseline down, the line's ends rounded.
      double x0 = std::round(a.x * dpr) / dpr, x1 = std::round(b.x * dpr) / dpr, y = std::round(a.y * dpr) / dpr;
      if (x1 <= x0) continue;
      emit(makeShape(Mat2x3::translate(x0, y), {x1 - x0, w}, ShapeKind::Rect, kSquare, color, 1, color, 0, 0, 0), Pass::Shape);
    } else {
      Vec2 d = b - a;
      double len = d.length();
      if (len < 1e-9) continue;
      // Along the line, `w` towards the text's own "down".
      Vec2 u{d.x / len, d.y / len};
      Vec2 down = m.applyLinear({0, 1});
      double dl = down.length();
      Vec2 n = dl > 1e-9 ? Vec2{down.x / dl, down.y / dl} : Vec2{-u.y, u.x};
      emit(makeShape({u.x, n.x, a.x, u.y, n.y, a.y}, {len, w}, ShapeKind::Rect, kSquare, color, 1, color, 0, 0, 0), Pass::Shape);
    }
    drawn = true;
  }
  return drawn;
}

void Renderer::drawAddVariant(Guid set, double x, double y, const Color& color, const OverlayStyle& s) {
  const double dpr = viewport_.scaleX();
  auto snap = [&](double v) { return std::round(v * dpr) / dpr; };
  // A rounded square of the component purple holding a white plus (live Figma, canvas-component-set-selected).
  const double size = s.addVariantSize, r = s.badgeRadius, g = s.addVariantGlyph, t = s.addVariantStroke;
  x = snap(x), y = snap(y);
  const Color ink{color.r, color.g, color.b, 1};
  emit(makeShape(Mat2x3::translate(x, y), {size, size}, ShapeKind::Rect, {r, r, r, r}, ink, color.a, ink, 0, 0, 0), Pass::Shape);
  const Color white{1, 1, 1, 1};
  double cx = x + size / 2, cy = y + size / 2;
  emit(makeShape(Mat2x3::translate(snap(cx - g / 2), snap(cy - t / 2)), {g, t}, ShapeKind::Rect, kSquare, white, 1, white, 0, 0, 0), Pass::Shape);
  emit(makeShape(Mat2x3::translate(snap(cx - t / 2), snap(cy - g / 2)), {t, g}, ShapeKind::Rect, kSquare, white, 1, white, 0, 0, 0), Pass::Shape);
  if (recordHits_) hits_.addVariant = {set, {x, y, size, size}};
}

void Renderer::drawOverlay(const Document& doc, Guid page, const Camera& camera, const Overlay& overlay, const OverlayStyle& style) {
  const double dpr = viewport_.scaleX();  // snap to the canvas's real pixels
  if (recordHits_) hits_ = CanvasHits{};
  const Color& blue = style.selection;
  const Color white{1, 1, 1, 1};
  Mat2x3 view = camera.matrix();

  // Components, component sets and instances — and every layer inside one — are outlined in the component purple
  // (live Figma; round 15, the owner's screenshots in docs/research/components15/).
  auto colorOf = [&](Guid id) -> const Color& { return inComponentChrome(doc, id) ? style.component : blue; };
  // The selection's own chrome (box, handles, badge, padding bars): purple when everything selected is a component, an
  // instance or a layer inside one.
  bool allComponents = !overlay.selection.empty();
  for (Guid s : overlay.selection) allComponents &= &colorOf(s) == &style.component;
  const Color& blueSel = allComponents ? style.component : blue;
  auto outline = [&](const Mat2x3& toScreen, Vec2 size, ShapeKind kind, const CornerRadii& radii, double weight, const Color& color) {
    ScreenBox b = screenBox(toScreen, size, dpr);
    CornerRadii r = kSquare;
    for (int i = 0; i < 4; i++) r[i] = radii[i] * b.axisScale;
    emit(makeShape(b.m, b.size, kind, r, color, 0, color, 1, weight, 0), Pass::Shape);
  };
  // A polyline on screen (CSS px), `width` across: one thin rectangle per segment, squares at the joins.
  auto polyline = [&](const std::vector<Vec2>& pts, bool closed, double width, const Color& color, double alpha) {
    size_t n = pts.size();
    if (n < 2) return;
    size_t segs = closed ? n : n - 1;
    for (size_t i = 0; i < segs; i++) {
      Vec2 a = pts[i], b = pts[(i + 1) % n];
      Vec2 d = b - a;
      double len = d.length();
      if (len < 1e-9) continue;
      Vec2 u{d.x / len, d.y / len}, nn{-u.y, u.x};
      Mat2x3 m{u.x, nn.x, a.x - nn.x * width / 2, u.y, nn.y, a.y - nn.y * width / 2};
      emit(makeShape(m, {len, width}, ShapeKind::Rect, kSquare, color, alpha, color, 0, 0, 0), Pass::Shape);
      if (i > 0 || closed)
        emit(makeShape(Mat2x3::translate(a.x - width / 2, a.y - width / 2), {width, width}, ShapeKind::Ellipse, kSquare, color, alpha,
                       color, 0, 0, 0),
             Pass::Shape);
    }
  };
  auto pathOutline = [&](const geom::Path& path, const Mat2x3& toScreen, double width, const Color& color) {
    geom::Path screen = path.transformed(toScreen);
    for (const geom::Polyline& pl : geom::flatten(screen, 0.25)) polyline(pl.points, pl.closed, width, color, 1);
  };
  // A box dashed 1.5 px on, 1.5 px off, 1 px across (calibrated on canvas-autolayout-child-selected).
  // The line lies inside the box along its edge (crisp at any whole device pixel ratio, as the 1 px outlines).
  auto dashedBox = [&](const ScreenBox& b, const Color& color) {
    const double h = 0.5;  // the 1 px line inside the edge, as an inside stroke
    Vec2 c[4] = {b.m.apply({h, h}), b.m.apply({b.size.x - h, h}), b.m.apply({b.size.x - h, b.size.y - h}), b.m.apply({h, b.size.y - h})};
    for (int k = 0; k < 4; k++) {
      Vec2 a = c[k], e = c[(k + 1) % 4];
      double len = (e - a).length();
      if (len < 1e-9) continue;
      for (double t = 0; t < len; t += 3) {
        Vec2 p0 = a + (e - a) * (t / len), p1 = a + (e - a) * (std::min(len, t + 1.5) / len);
        polyline({p0, p1}, false, 1, color, 1);
      }
    }
  };
  auto nodeOutline = [&](Guid id, double weight, bool ownShape) {
    const Node* n = doc.get(id);
    if (!n) return;
    // Frames, components, instances and sections: their box, square whatever their corners (live Figma, the owner's
    // 79.png: a frame with a big radius hovered outlines its whole box, the rounded fill inside); shapes: their own
    // outline (80.png was ours, wrongly rounded on a frame).
    if (n->props.isFrameLike()) ownShape = false;
    if (ownShape && (n->props.isPathShape() || n->props.invertedCorners() ||
                     (n->props.isRectLike() && n->props.stroke().cornerSmoothing > 0))) {
      // Vectors, stars, booleans…, inverted or smoothed corners: their own outline.
      if (const NodeGeometry* g = doc.geometry(id)) {
        Mat2x3 m = view * doc.worldTransform(id);
        if (!g->stroke.path.empty()) pathOutline(g->stroke.path, m, weight, colorOf(id));
        else
          for (auto& f : g->fills) pathOutline(f.path, m, weight, colorOf(id));
        return;
      }
    }
    Rect lb = doc.localBounds(id);
    Mat2x3 m = view * doc.worldTransform(id) * Mat2x3::translate(lb.x, lb.y);
    ShapeKind kind = ownShape && n->props.type == NodeType::ELLIPSE ? ShapeKind::Ellipse : ShapeKind::Rect;
    bool rounded = ownShape && n->props.isRectLike();
    outline(m, {lb.w, lb.h}, kind, rounded ? geom::clampRadii(n->props.size, n->props.cornerRadii) : kSquare, weight, colorOf(id));
  };

  // The pixel grid (View › Pixel grid): a line on every whole canvas unit from 300 % zoom (faint at 300 %, full from
  // 400 %: live Figma), under the other overlays.
  if (overlay.pixelGrid && camera.zoom >= 3 && std::fabs(view.m01) < 1e-9 && std::fabs(view.m10) < 1e-9) {
    double alpha = camera.zoom >= 4 ? 1.0 : 0.5;
    const Color gc{style.pixelGrid.r, style.pixelGrid.g, style.pixelGrid.b, 1};
    alpha *= style.pixelGrid.a;
    double px = 1 / dpr;
    Vec2 a = view.inverse().apply({screen_.x, screen_.y}), b = view.inverse().apply({screen_.right(), screen_.bottom()});
    for (double x = std::ceil(a.x); x <= b.x; x += 1) {
      double sx = std::round(view.apply({x, 0}).x * dpr) / dpr;
      emit(makeShape(Mat2x3::translate(sx, screen_.y), {px, screen_.h}, ShapeKind::Rect, kSquare, gc, alpha, gc, 0, 0, 0), Pass::Shape);
    }
    for (double y = std::ceil(a.y); y <= b.y; y += 1) {
      double sy = std::round(view.apply({0, y}).y * dpr) / dpr;
      emit(makeShape(Mat2x3::translate(screen_.x, sy), {screen_.w, px}, ShapeKind::Rect, kSquare, gc, alpha, gc, 0, 0, 0), Pass::Shape);
    }
  }

  // Ruler guides (rulers on): 1 px lines in the guide colour, the selected or dragged one in the selection colour with
  // its position in a pill by the ruler (unverified colours: Figma's guides read red).
  for (const Overlay::RulerGuide& g : overlay.rulerGuides) {
    Vec2 a = view.apply(g.a), b = view.apply(g.b);
    const Color& color = g.active ? blue : style.measure;
    if (g.vertical) {
      double x = std::round(a.x * dpr) / dpr, y0 = std::max(screen_.y, std::min(a.y, b.y)), y1 = std::min(screen_.bottom(), std::max(a.y, b.y));
      if (y1 > y0) emit(makeShape(Mat2x3::translate(x, y0), {1 / dpr * std::max(1.0, dpr), y1 - y0}, ShapeKind::Rect, kSquare, color, 1, color, 0, 0, 0), Pass::Shape);
    } else {
      double y = std::round(a.y * dpr) / dpr, x0 = std::max(screen_.x, std::min(a.x, b.x)), x1 = std::min(screen_.right(), std::max(a.x, b.x));
      if (x1 > x0) emit(makeShape(Mat2x3::translate(x0, y), {x1 - x0, 1 / dpr * std::max(1.0, dpr)}, ShapeKind::Rect, kSquare, color, 1, color, 0, 0, 0), Pass::Shape);
    }
    if (!g.label) continue;
    std::string text = formatNumber(g.value);
    const text::TextLayout* L = label(text, "Medium", style.labelSize);
    double tw = L ? L->size.x : 6.2 * static_cast<double>(text.size());
    double pw = std::round(tw + 2 * style.badgePadding), ph = style.badgeHeight, rr = style.badgeRadius;
    double px = g.vertical ? a.x + 4 : screen_.x + 24, py = g.vertical ? screen_.y + 24 : a.y + 4;
    px = std::round(px * dpr) / dpr, py = std::round(py * dpr) / dpr;
    emit(makeShape(Mat2x3::translate(px, py), {pw, ph}, ShapeKind::Rect, {rr, rr, rr, rr}, blue, 1, blue, 0, 0, 0), Pass::Shape);
    if (L && !L->lines.empty()) drawGlyphs(*L, Mat2x3::translate(px + (pw - tw) / 2, std::round((py + (ph - L->lines[0].height) / 2) * dpr) / dpr), white, 1);
  }
  // View › Show slices: each slice's box dashed (unverified look).
  for (const Overlay::SliceBox& sl : overlay.slices) {
    Mat2x3 m = view * sl.world;
    Vec2 c[4] = {m.apply({0, 0}), m.apply({sl.size.x, 0}), m.apply({sl.size.x, sl.size.y}), m.apply({0, sl.size.y})};
    const Color grey{0.55f, 0.55f, 0.55f, 1};
    for (int k = 0; k < 4; k++) {
      Vec2 a = c[k], e = c[(k + 1) % 4];
      double len = (e - a).length();
      for (double t = 0; t < len; t += 6) {
        Vec2 p0 = a + (e - a) * (t / len), p1 = a + (e - a) * (std::min(len, t + 3) / len);
        polyline({p0, p1}, false, 1, grey, 1);
      }
    }
  }

  // Text being edited: the selection highlight and the caret.
  if (overlay.textNode != kNoGuid && doc.has(overlay.textNode)) {
    Mat2x3 m = view * doc.worldTransform(overlay.textNode);
    for (const Rect& r : overlay.textSelection) {
      Mat2x3 rm = m * Mat2x3::translate(r.x, r.y);
      emit(makeShape(rm, {r.w, r.h}, ShapeKind::Rect, kSquare, blue, style.textSelectionAlpha, blue, 0, 0, 0), Pass::Shape);
    }
    // Misspelled words: a red wavy line along the line's foot, 1 px, waves of 4 (unverified look: the system's).
    const Color red = Color::hex(0xF24822);
    for (const Rect& r : overlay.misspelled) {
      Vec2 a = m.apply({r.x, r.y + r.h}), b = m.apply({r.x + r.w, r.y + r.h});
      Vec2 d = b - a;
      double len = d.length();
      if (len < 2) continue;
      Vec2 u{d.x / len, d.y / len}, n{-u.y, u.x};
      std::vector<Vec2> wave;
      for (double t = 0; t <= len; t += 2) wave.push_back(a + u * t + n * ((static_cast<int>(t / 2) % 2) ? 1.0 : -1.0) - n * 1.5);
      polyline(wave, false, 1, red, 1);
    }
    if (overlay.caretVisible) {
      // 1 px wide (2 px from 200% zoom), the line's height, on device pixels when upright.
      double width = camera.zoom >= 2 ? 2 : 1;
      Vec2 top = m.apply({overlay.caret.x, overlay.caret.y}), bottom = m.apply({overlay.caret.x, overlay.caret.y + overlay.caret.h});
      Vec2 d = bottom - top;
      double len = d.length();
      if (len > 0) {
        Vec2 u{d.x / len, d.y / len};
        if (std::fabs(u.x) < 1e-6) {
          double x = std::round((top.x - width / 2) * dpr) / dpr;
          emit(makeShape(Mat2x3::translate(x, top.y), {width, len}, ShapeKind::Rect, kSquare, blue, 1, blue, 0, 0, 0), Pass::Shape);
        } else {
          Mat2x3 cm{-u.y, u.x, top.x + u.y * width / 2, u.x, u.y, top.y - u.x * width / 2};
          emit(makeShape(cm, {width, len}, ShapeKind::Rect, kSquare, blue, 1, blue, 0, 0, 0), Pass::Shape);
        }
      }
    }
  }

  // Frames' names above their top-left corner (top-level frames and those directly in sections), sections' pills
  // (render/FrameTitles.cpp: the same boxes the editor hit-tests).
  // Prototype mode: flow starting point labels (before the titles: a title moves right past its frame's label).
  if (overlay.prototype.on) drawPrototypeLabels(doc, camera, overlay, style);
  if (overlay.frameTitles && page != kNoGuid) {
    // The title colours follow the page's background (Figma: light text on a dark canvas), not the UI theme.
    const bool darkPage = style.darkCanvas;
    const Color& grey = darkPage ? style.titleOnDark : style.titleOnLight;
    const Color& selectedText = darkPage ? style.titleSelectedOnDark : style.titleSelectedOnLight;
    const Color& componentText = darkPage ? style.titleComponentOnDark : style.titleComponentOnLight;
    auto measure = [&](const std::string& name, bool section) {
      double size = section ? style.sectionTitleSize : style.titleSize;
      const text::TextLayout* L = label(name, section ? "Medium" : "Regular", size, -1, 1, section ? style.sectionTitleWeight : 0);
      return L ? L->size.x : 6.2 * static_cast<double>(name.size()) * size / 11;
    };
    auto has = [](const std::vector<Guid>& ids, Guid id) { return std::find(ids.begin(), ids.end(), id) != ids.end(); };
    for (const FrameTitle& t : frameTitles(doc, page, view, screen_, style, measure, overlay.dev.focus)) {
      const Node* n = doc.get(t.id);
      if (!n) continue;
      bool isSelected = has(overlay.selection, t.id), hovered = has(overlay.hover, t.id);
      if (t.section) {
        // The pill: the section's own fill colour, selected or not (live Figma), its name in Inter Medium.
        (void)isSelected;
        (void)hovered;
        Color fill = Color::hex(0xE6E6E6);
        for (const Paint& p : n->props.fillPaints)
          if (p.visible && p.type == PaintType::SOLID) fill = Color{p.color.r, p.color.g, p.color.b, 1};
        bool darkFill = 0.2126 * fill.r + 0.7152 * fill.g + 0.0722 * fill.b < 0.5;
        Color ink = darkFill ? Color{1, 1, 1, 1} : Color{0, 0, 0, 0.9f};
        const Rect& h = t.hit;
        const double r = 2;
        emit(makeShape(Mat2x3::translate(std::round(h.x * dpr) / dpr, std::round(h.y * dpr) / dpr), {h.w, h.h}, ShapeKind::Rect, {r, r, r, r}, fill,
                       1, fill, 0, 0, 0),
             Pass::Shape);
        const text::TextLayout* L = label(n->props.name, "Medium", style.sectionTitleSize, t.text.w, 1, style.sectionTitleWeight);
        if (L && !L->lines.empty()) {
          double ty = std::round((h.y + (h.h - L->lines[0].height) / 2) * dpr) / dpr;
          drawGlyphs(*L, Mat2x3::translate(std::round(t.text.x * dpr) / dpr, ty), Color{ink.r, ink.g, ink.b, 1}, ink.a);
        }
        continue;
      }
      // Components' and instances' names in the component purple, after Figma's icon; a selected or hovered frame's
      // in the selection's text colour (round 17, the owner's live 68–70.png: grey `#828282` on the dark canvas, the
      // pointer on the frame or its name `#7bc4f8`, as selected); others grey.
      Color ink = n->props.isComponentish() ? componentText : isSelected || hovered ? selectedText : grey;
      // A turned frame's name lies along its edge, turned with it (t.place; FrameTitles.h labelFrame): label-local
      // coordinates, snapped to device pixels only when upright.
      auto snap = [&](double v) { return t.upright ? std::round(v * dpr) / dpr : v; };
      double baseline = snap(t.baseline);
      // A selected design without a status: live Figma's `</>` at its top right (a click marks it ready for dev), in
      // the title's colour; a design ready for dev (Design mode): the green button there. The name stops short of it.
      // Round 15 (the owner's recording, 26–33 s): a turned frame's too, along its top edge at the right end.
      bool devIcon = false;
      DevStatusMark::Kind iconKind = DevStatusMark::Kind::MarkButton;
      for (const DevStatusMark& mark : overlay.dev.statuses)
        if (mark.frame == t.id && (mark.kind == DevStatusMark::Kind::MarkButton || mark.kind == DevStatusMark::Kind::ReadyIcon)) {
          devIcon = true;
          iconKind = mark.kind;
        }
      devIcon &= t.frame.w >= 3 * kDevIconWidth;
      if (devIcon && overlay.hideTitle != t.id) drawDevIcon(t.id, iconKind, t.frame.right(), baseline, ink, t.place, t.upright, overlay.dev, style);
      if (overlay.hideTitle == t.id) continue;  // a grid's track selected: its name gives way (live Figma)
      if (t.icon != TitleIcon::None) drawTitleIcon(t.icon, t.iconBox, ink, t.place);
      double x = snap(t.text.x + overlay.prototype.labelWidth(t.id));
      double room = t.frame.right() - x - (devIcon ? kDevIconWidth + kDevIconGap : 0);
      if (room < 1) continue;
      const text::TextLayout* L = label(n->props.name, "Regular", style.titleSize, room);
      if (!L || L->lines.empty()) continue;
      drawGlyphs(*L, t.place * Mat2x3::translate(x, baseline - L->lines[0].baseline), Color{ink.r, ink.g, ink.b, 1}, ink.a);
      // Dev Mode: the design's status after its name (a turned frame's chip at its place, unturned).
      for (const DevStatusMark& mark : overlay.dev.statuses)
        if (mark.frame == t.id && mark.kind != DevStatusMark::Kind::MarkButton && mark.kind != DevStatusMark::Kind::ReadyIcon) {
          Vec2 at = t.place.apply({x + L->size.x + 6, baseline});
          drawStatusChip(mark, at.x, at.y, style);
        }
    }
  }

  // Auto layout's padding and gap handles, the padding or gap under the pointer hatched (round 15), the value badge
  // (render/SpacingOverlay.cpp) — a padding's in the selection's chrome colour (purple in a component or instance).
  drawSpacing(view, overlay, style, blueSel);

  // A selected grid (live Figma, canvas-grid-*): every cell outlined in a light blue (the selection colour at 37 %), a
  // selected track's empty cells filled (15 %), an expanded pill's track outlined, and the pills — compact: a capsule
  // of the selection colour half-way to white with a white ring; expanded: the selection colour with its grabber, its
  // size and a chevron, the segment under the pointer darker.
  {
    auto upright = [&](const Overlay::GridCell& c) {
      Rect r = Rect::fromPoints(view.apply(c.a), view.apply(c.b));
      return screenBox(Mat2x3::translate(r.x, r.y), {r.w, r.h}, dpr);
    };
    for (const Overlay::GridCell& c : overlay.gridCells) {
      ScreenBox b = upright(c);
      if (c.fill) emit(makeShape(b.m, b.size, ShapeKind::Rect, kSquare, blue, 0.15, blue, 0, 0, 0), Pass::Shape);
      emit(makeShape(b.m, b.size, ShapeKind::Rect, kSquare, blue, 0, blue, 0.37, 1, 0), Pass::Shape);
    }
    // The track under an expanded pill: a 2 px outline in the selection colour, centred on the track's own edges and,
    // where it meets the frame's edges, inside them (live Figma round 10, canvas-grid-hover-column-track-pill /
    // -row-track-pill at 1.46× / 1.31×: 2.9 / 3.0 px across, the column's sides centred on its edges, its ends' outer
    // edge on the frame's outer edge — and the row's the other way round). So: the box 1 px wider across the track,
    // stroked 2 px inside.
    for (const Overlay::GridCell& c : overlay.gridTrackBoxes) {
      ScreenBox b = upright(c);
      Vec2 at{b.m.m02, b.m.m12}, size = b.size;
      if (c.column) at.x -= 1, size.x += 2;
      else at.y -= 1, size.y += 2;
      emit(makeShape(Mat2x3::translate(at.x, at.y), size, ShapeKind::Rect, kSquare, blue, 0, blue, 1, 2, 0), Pass::Shape);
    }
    auto snap = [&](double v) { return std::round(v * dpr) / dpr; };
    const Color light{(blue.r + 1) / 2, (blue.g + 1) / 2, (blue.b + 1) / 2, 1};
    const Color dark{blue.r * 0.78f, blue.g * 0.78f, blue.b * 0.78f, 1};
    for (const Overlay::GridPill& p : overlay.gridPills) {
      Rect r{snap(p.rect.x), snap(p.rect.y), p.rect.w, p.rect.h};
      if (!p.expanded) {
        double rr = std::min(r.w, r.h) / 2;
        emit(makeShape(Mat2x3::translate(r.x, r.y), {r.w, r.h}, ShapeKind::Rect, {rr, rr, rr, rr}, white, 1, white, 0, 0, 0), Pass::Shape);
        emit(makeShape(Mat2x3::translate(r.x + 1, r.y + 1), {r.w - 2, r.h - 2}, ShapeKind::Rect, {rr - 1, rr - 1, rr - 1, rr - 1}, light, 1, light, 0, 0, 0),
             Pass::Shape);
        continue;
      }
      const double rr = 3, seg = p.segment;
      emit(makeShape(Mat2x3::translate(r.x, r.y), {r.w, r.h}, ShapeKind::Rect, {rr, rr, rr, rr}, blue, 1, blue, 0, 0, 0), Pass::Shape);
      if (p.hovered >= 0) {
        double x = p.hovered == 0 ? r.x : p.hovered == 1 ? r.x + seg : r.x + seg + p.labelWidth;
        double w = p.hovered == 1 ? p.labelWidth : seg;
        CornerRadii cr = p.hovered == 0 ? CornerRadii{rr, 0, 0, rr} : p.hovered == 2 ? CornerRadii{0, rr, rr, 0} : kSquare;
        emit(makeShape(Mat2x3::translate(x, r.y), {w, r.h}, ShapeKind::Rect, cr, dark, 1, dark, 0, 0, 0), Pass::Shape);
      }
      // The grabber: three bars across the axis it reorders along (a column's upright, a row's lying).
      double gx = r.x + seg / 2, gy = r.y + r.h / 2;
      for (int k = -1; k <= 1; k++) {
        Rect bar = p.column ? Rect{snap(gx + k * 3 - 0.5), snap(gy - 3.5), 1, 7} : Rect{snap(gx - 3.5), snap(gy + k * 2.5 - 0.5), 7, 1};
        emit(makeShape(Mat2x3::translate(bar.x, bar.y), {bar.w, bar.h}, ShapeKind::Rect, kSquare, white, 1, white, 0, 0, 0), Pass::Shape);
      }
      const text::TextLayout* L = label(p.label, "Medium", style.labelSize);
      if (L && !L->lines.empty())
        drawGlyphs(*L, Mat2x3::translate(snap(r.x + seg + (p.labelWidth - L->size.x) / 2), snap(r.y + (r.h - L->lines[0].height) / 2)), white, 1);
      // The chevron: a 6 × 3 "v".
      Vec2 cc{r.x + seg + p.labelWidth + seg / 2, r.y + r.h / 2 + 0.5};
      polyline({{cc.x - 3, cc.y - 1.5}, {cc.x, cc.y + 1.5}, {cc.x + 3, cc.y - 1.5}}, false, 1, white, 1);
    }
  }
  // Reordering tracks: the blue line where they land.
  if (overlay.hasGridDrop) {
    Vec2 a = view.apply(overlay.gridDrop.a), b = view.apply(overlay.gridDrop.b);
    Rect r = Rect::fromPoints(a, b);
    if (r.w < 2) r.x -= 1, r.w = 2;
    if (r.h < 2) r.y -= 1, r.h = 2;
    emit(makeShape(Mat2x3::translate(std::round(r.x * dpr) / dpr, std::round(r.y * dpr) / dpr), {r.w, r.h}, ShapeKind::Rect, kSquare, blue, 1, blue, 0, 0, 0),
         Pass::Shape);
  }

  // Hover: the hovered layer's own outline — selected layers too (live Figma). A text layer's lines are underlined at
  // their baseline instead (live Figma round 11, canvas-text-hover-baseline-underline: 2 px just under the baseline,
  // across the line's text; a hovered selected text keeps a 1 px one inside its box, canvas-text-selected).
  for (Guid h : overlay.hover) {
    const Node* hn = doc.get(h);
    if (!hn) continue;
    if (hn->props.type == NodeType::TEXT && h != overlay.textNode && baselineUnderline(doc, h, view, overlay, style)) continue;
    // A layer inside an instance (the instance opened, or ⌘ held): its box dotted in the component purple, 1 px, 1.5 px
    // dashes and gaps (live Figma round 15, components15/figma-instance-child-hover.png at 2× — the auto-layout
    // parent's dashes).
    if (insideInstance(doc, h)) {
      Rect lb = doc.localBounds(h);
      dashedBox(screenBox(view * doc.worldTransform(h) * Mat2x3::translate(lb.x, lb.y), {lb.w, lb.h}, dpr), style.component);
      continue;
    }
    nodeOutline(h, style.hoverWidth, true);
  }

  // A layer in an auto-layout flow selected: its parent's box dashed (live Figma).
  {
    std::vector<Guid> parents;
    for (Guid s : overlay.selection) {
      const Node* n = doc.get(s);
      if (!n || !n->props.inFlow()) continue;
      Guid pid = n->props.parentIndex.guid;
      const Node* pn = doc.get(pid);
      if (!pn || !pn->props.isAutoLayout() || std::find(parents.begin(), parents.end(), pid) != parents.end()) continue;
      bool selectedToo = false;
      for (Guid t : overlay.selection) selectedToo |= t == pid;
      if (!selectedToo) parents.push_back(pid);
    }
    for (Guid pid : parents) dashedBox(screenBox(view * doc.worldTransform(pid), doc.get(pid)->props.size, dpr), colorOf(pid));
  }

  // A selected auto-layout component, set or instance: a pink box in each gap, 1 px inside it (live Figma round 11:
  // the gap between two layers, across the frame's content box — canvas-component-set-selected, -main-component-,
  // -instance-selected); a selected grid's gaps of one axis, the pointer in one (round 12, grid-selected-hover-gap-1440:
  // the gap wide, its row high).
  for (const Overlay::GapBox& g : overlay.gapBoxes) {
    if (g.rect.w <= 0 || g.rect.h <= 0) continue;
    ScreenBox b = screenBox(view * g.world * Mat2x3::translate(g.rect.x, g.rect.y), {g.rect.w, g.rect.h}, dpr);
    emit(makeShape(b.m, b.size, ShapeKind::Rect, kSquare, style.spacing, 0, style.spacing, 1, 1, 0), Pass::Shape);
  }

  // Selection: each layer's box, the selection's box, its handles and size badge.
  SelectionBox box = selectionBox(doc, overlay.selection);
  if (box.valid && overlay.selectionBox) {
    const Color& blue = blueSel;
    // Each selected layer's own outline, 1 px (live Figma: a multi-selection outlines every shape along its path; one
    // selected ellipse, polygon, star or vector is outlined along its path inside the box).
    if (overlay.selection.size() > 1)
      for (Guid s : overlay.selection) nodeOutline(s, style.selectionWidth, true);
    else if (const Node* only = doc.get(overlay.selection[0]);
             only && overlay.lineEnds.empty() && (only->props.type == NodeType::ELLIPSE || only->props.isPathShape()))
      nodeOutline(overlay.selection[0], style.selectionWidth, true);
    Mat2x3 toScreen = view * box.toWorld;
    ScreenBox sb = screenBox(toScreen, box.size, dpr);
    if (overlay.selectionDashed) {
      // A grid's track selected: the box dashed, 2 px dashes and gaps (live Figma, canvas-grid-row-track-selected).
      Vec2 c[4] = {sb.m.apply({0, 0}), sb.m.apply({sb.size.x, 0}), sb.m.apply({sb.size.x, sb.size.y}), sb.m.apply({0, sb.size.y})};
      for (int k = 0; k < 4; k++) {
        Vec2 a = c[k], e = c[(k + 1) % 4];
        double len = (e - a).length();
        for (double t = 0; t < len; t += 4) {
          Vec2 p0 = a + (e - a) * (t / len), p1 = a + (e - a) * (std::min(len, t + 2) / len);
          polyline({p0, p1}, false, 1, blue, 1);
        }
      }
    } else {
      emit(makeShape(sb.m, sb.size, ShapeKind::Rect, kSquare, blue, 0, blue, 1, 1, 0), Pass::Shape);
    }

    bool roomy = sb.size.x >= style.handlesMinBox && sb.size.y >= style.handlesMinBox;
    const double hs = style.handleSize;
    if (overlay.handles && roomy && overlay.lineEnds.empty()) {
      Vec2 corners[4] = {{0, 0}, {sb.size.x, 0}, {sb.size.x, sb.size.y}, {0, sb.size.y}};
      for (auto& c : corners) {
        Mat2x3 hm = sb.m;
        Vec2 o = sb.m.apply(c) - sb.m.applyLinear({hs / 2, hs / 2});
        hm.m02 = std::round(o.x * dpr) / dpr;
        hm.m12 = std::round(o.y * dpr) / dpr;
        emit(makeShape(hm, {hs, hs}, ShapeKind::Rect, kSquare, style.handleFill, 1, blue, 1, 1, 0), Pass::Shape);
      }
    }
    // Corner radius handles: white rings with the selection's colour, inset from the corners.
    for (size_t k = 0; k < overlay.radiusHandles.size(); k++) {
      Vec2 c = view.apply(overlay.radiusHandles[k]);
      double d = style.radiusHandleSize + (static_cast<int>(k) == overlay.radiusHovered ? 1 : 0);
      emit(makeShape(Mat2x3::translate(std::round((c.x - d / 2) * dpr) / dpr, std::round((c.y - d / 2) * dpr) / dpr), {d, d}, ShapeKind::Ellipse, kSquare,
                     style.radiusHandleFill, 1, blue, 1, 1, 0),
           Pass::Shape);
    }
    // An ellipse's arc handles, a polygon's or a star's radius / ratio / count handles: the radius handles' rings.
    for (size_t k = 0; k < overlay.shapeHandles.size(); k++) {
      Vec2 c = view.apply(overlay.shapeHandles[k]);
      double d = style.radiusHandleSize + (static_cast<int>(k) == overlay.shapeHovered ? 1 : 0);
      emit(makeShape(Mat2x3::translate(std::round((c.x - d / 2) * dpr) / dpr, std::round((c.y - d / 2) * dpr) / dpr), {d, d}, ShapeKind::Ellipse, kSquare,
                     style.radiusHandleFill, 1, blue, 1, 1, 0),
           Pass::Shape);
    }
    // A line: a handle on each end instead.
    for (Vec2 w : overlay.lineEnds) {
      Vec2 c = view.apply(w);
      Mat2x3 hm = Mat2x3::translate(std::round((c.x - hs / 2) * dpr) / dpr, std::round((c.y - hs / 2) * dpr) / dpr);
      emit(makeShape(hm, {hs, hs}, ShapeKind::Rect, kSquare, style.handleFill, 1, blue, 1, 1, 0), Pass::Shape);
    }

    // One component set selected: "N Variants" in the pill instead of its size, and the "+" (Add variant) under it
    // (live Figma round 11, canvas-component-set-selected).
    const Node* set = overlay.selection.size() == 1 ? doc.get(overlay.selection[0]) : nullptr;
    if (set && (!set->props.isComponentSet() || overlay.selection[0].isDerived())) set = nullptr;
    Rect sr = transformedBounds(toScreen, box.size.x, box.size.y);
    double below = std::round((sr.bottom() + style.badgeGap) * dpr) / dpr;  // where the pill (or else the "+") goes
    if (overlay.sizeBadge) {
      // The pill under the box; its text arrives with the text engine (E3), so it is sized for it now.
      Rect r = sr;
      Mat2x3 w = box.toWorld;
      Vec2 worldSize{box.size.x * std::hypot(w.m00, w.m10), box.size.y * std::hypot(w.m01, w.m11)};
      // One auto-layout frame or flow child: "Hug" / "Fill" after each axis that has it (live Figma: "232 Hug × 72 Hug").
      std::string sx, sy;
      if (overlay.selection.size() == 1)
        if (const Node* n = doc.get(overlay.selection[0])) {
          const NodeProps& p = n->props;
          const Node* parent = doc.get(p.parentIndex.guid);
          for (int axis = 0; axis < 2; axis++) {
            std::string& out = axis == 0 ? sx : sy;
            if (parent && parent->props.isAutoLayout() && p.inFlow() && parent->props.stack().stackMode != StackMode::GRID) {
              bool along = (parent->props.stack().stackMode == StackMode::VERTICAL) == (axis == 1);
              if (along ? p.stackChildPrimaryGrow > 0 : p.stackChildAlignSelf == StackCounterAlign::STRETCH) out = " Fill";
            }
            if (out.empty() && p.isAutoLayout() && p.stack().stackMode != StackMode::GRID) {
              bool primary = (p.stack().stackMode == StackMode::VERTICAL) == (axis == 1);
              if (primary ? p.hugsPrimary() : p.hugsCounter()) out = " Hug";
            }
          }
        }
      std::string text = formatNumber(worldSize.x) + sx + " \u00D7 " + formatNumber(worldSize.y) + sy;
      if (set) {
        size_t variants = 0;
        for (Guid c : doc.children(overlay.selection[0]))
          if (const Node* v = doc.get(c); v && v->props.type == NodeType::SYMBOL) variants++;
        text = std::to_string(variants) + (variants == 1 ? " Variant" : " Variants");  // "1 Variant": unverified
      }
      if (!overlay.badgeText.empty()) text = overlay.badgeText;  // rotating: the angle
      const text::TextLayout* L = label(text, "Medium", style.labelSize);
      double tw = L ? L->size.x : 6.2 * static_cast<double>(text.size());
      double bw = std::round(tw + 2 * style.badgePadding), bh = style.badgeHeight;
      // A turned selection's badge lies under its bottom edge, centred, turned with it and never upside down (live
      // Figma, the owner's 42.png; FrameTitles.h labelFrame) — in label-local coordinates, snapped when upright.
      LabelFrame lf = labelFrame(toScreen, box.size);
      if (!lf.upright) r = lf.box;
      auto snap = [&](double v) { return lf.upright ? std::round(v * dpr) / dpr : v; };
      double bx = snap(r.x + r.w / 2 - bw / 2);
      double by = snap(r.bottom() + style.badgeGap);
      double rr = style.badgeRadius;
      emit(makeShape(lf.place * Mat2x3::translate(bx, by), {bw, bh}, ShapeKind::Rect, {rr, rr, rr, rr}, blue, 1, blue, 0, 0, 0),
           Pass::Shape);
      if (L && !L->lines.empty()) {
        const text::LaidLine& line = L->lines[0];
        double ty = by + (bh - line.height) / 2;
        drawGlyphs(*L, lf.place * Mat2x3::translate(bx + (bw - tw) / 2, snap(ty)), white, 1);
      }
      if (lf.upright) below = by + bh + style.addVariantGap;
    }
    // The "+": centred under the pill, with the handles (not while moving or in view-only mode).
    if (set && overlay.handles && overlay.badgeText.empty())
      drawAddVariant(overlay.selection[0], sr.x + sr.w / 2 - style.addVariantSize / 2, below, blue, style);
  }
  // A grid item's span handles: small white circles with a blue ring on its sides' midpoints.
  for (const Vec2& w : overlay.gridSpanHandles) {
    Vec2 c = view.apply(w);
    const double d = 8;
    emit(makeShape(Mat2x3::translate(std::round((c.x - d / 2) * dpr) / dpr, std::round((c.y - d / 2) * dpr) / dpr), {d, d}, ShapeKind::Ellipse, kSquare, white, 1,
                   blueSel, 1, 1, 0),
         Pass::Shape);
  }

  // A straight line between two world points, `width` CSS px across; axis-aligned ones land on device pixels.
  auto line = [&](Vec2 aw, Vec2 bw, double width, const Color& color) {
    Vec2 a = view.apply(aw), b = view.apply(bw);
    Vec2 d = b - a;
    double len = d.length();
    if (len < 1e-9) return;
    auto snap = [&](double v) { return std::round(v * dpr) / dpr; };
    double minPx = 1 / dpr;
    if (std::fabs(d.y) < 1e-9 || std::fabs(d.x) < 1e-9) {
      bool horizontal = std::fabs(d.y) < 1e-9;
      double lo = horizontal ? std::min(a.x, b.x) : std::min(a.y, b.y), hi = horizontal ? std::max(a.x, b.x) : std::max(a.y, b.y);
      double mid = horizontal ? a.y : a.x;
      double c0 = snap(mid - width / 2), c1 = std::max(c0 + minPx, snap(mid + width / 2));
      double l0 = snap(lo), l1 = std::max(l0 + minPx, snap(hi));
      Rect r = horizontal ? Rect{l0, c0, l1 - l0, c1 - c0} : Rect{c0, l0, c1 - c0, l1 - l0};
      emit(makeShape(Mat2x3::translate(r.x, r.y), {r.w, r.h}, ShapeKind::Rect, kSquare, color, 1, color, 0, 0, 0), Pass::Shape);
      return;
    }
    Vec2 u{d.x / len, d.y / len}, n{-u.y, u.x};
    Mat2x3 m{u.x, n.x, a.x - n.x * width / 2, u.y, n.y, a.y - n.y * width / 2};
    emit(makeShape(m, {len, width}, ShapeKind::Rect, kSquare, color, 1, color, 0, 0, 0), Pass::Shape);
  };
  // A dashed line (⌥ measurement's extension lines): 4 px dashes, 4 px gaps on screen.
  auto dashed = [&](Vec2 aw, Vec2 bw, const Color& color) {
    Vec2 a = view.apply(aw), b = view.apply(bw);
    double len = (b - a).length();
    if (len < 1e-9) return;
    Mat2x3 back = view.inverse();
    for (double t = 0; t < len; t += 8) {
      double e = std::min(len, t + 4);
      Vec2 p0 = a + (b - a) * (t / len), p1 = a + (b - a) * (e / len);
      line(back.apply(p0), back.apply(p1), 1, color);
    }
  };
  // A measured distance: the line, a tick across each end, and a pill for its number in the middle.
  auto distance = [&](const SpacingMark& m, const Color& color) {
    line(m.a, m.b, 1, color);
    Vec2 a = view.apply(m.a), b = view.apply(m.b);
    Vec2 d = b - a;
    double len = d.length();
    if (len < 1e-9) return;
    Vec2 n{-d.y / len, d.x / len};
    Mat2x3 back = view.inverse();
    for (Vec2 end : {a, b}) line(back.apply(end - n * (style.tick / 2)), back.apply(end + n * (style.tick / 2)), 1, color);
    // The number (text comes with E3): the world distance, sized for its digits.
    double value = (m.b - m.a).length();
    std::string text = formatNumber(value);
    const text::TextLayout* L = label(text, "Medium", style.labelSize);
    double tw = L ? L->size.x : 6.2 * static_cast<double>(text.size());
    double pw = std::round(tw + 2 * style.badgePadding), ph = style.pillHeight, rr = style.pillRadius;
    Vec2 c = (a + b) * 0.5;
    double px = std::round((c.x - pw / 2) * dpr) / dpr, py = std::round((c.y - ph / 2) * dpr) / dpr;
    emit(makeShape(Mat2x3::translate(px, py), {pw, ph}, ShapeKind::Rect, {rr, rr, rr, rr}, color, 1, color, 0, 0, 0), Pass::Shape);
    if (L && !L->lines.empty()) {
      double ty = py + (ph - L->lines[0].height) / 2;
      drawGlyphs(*L, Mat2x3::translate(px + (pw - tw) / 2, std::round(ty * dpr) / dpr), Color{1, 1, 1, 1}, 1);
    }
  };

  // Smart guides and equal spacing while moving, resizing or drawing.
  for (const GuideLine& g : overlay.guides) line(g.a, g.b, 1, style.measure);
  // Equal spacing while moving: pink (Figma's spacing guide), as the gaps of an auto layout.
  for (const SpacingMark& m : overlay.spacings) distance(m, style.spacing);

  // Smart selection: a pink dot in the middle of each equally spaced layer and a pink handle in each gap; the hovered
  // gap shows its value.
  for (size_t k = 0; k < overlay.centreDots.size(); k++) {
    Vec2 c = view.apply(overlay.centreDots[k]);
    c = {std::round(c.x * dpr) / dpr, std::round(c.y * dpr) / dpr};  // one centre for the concentric marks
    // A circle `d` across about c: filled (`fill`) and / or a 1 px ring just inside its edge (`ring`).
    auto circle = [&](double d, const Color* fill, const Color* ring) {
      emit(makeShape(Mat2x3::translate(c.x - d / 2, c.y - d / 2), {d, d}, ShapeKind::Ellipse, kSquare, fill ? *fill : white, fill ? 1 : 0, ring ? *ring : white,
                     ring ? 1 : 0, ring ? 1 : 0, 0),
           Pass::Shape);
    };
    const Color& pink = style.spacing;
    // The ring under the pointer (or dragged to reorder): filled pink (live menu-context-multi-and-smart-selection).
    bool lit = static_cast<int>(k) == overlay.centreDotHovered;
    const double ring = style.ringSize;
    if (overlay.centreDotsIdle && !lit) {
      circle(style.dotSize, &white, nullptr);
      circle(style.dotCore, &pink, nullptr);
    } else if (lit) {
      circle(ring + 3, &white, nullptr);
      circle(ring + 1, &pink, nullptr);
    } else {
      // Pink between two white rings, hollow: the layer shows through.
      circle(ring + 3, nullptr, &white);
      circle(ring + 1, nullptr, &pink);
      circle(ring - 1, nullptr, &white);
    }
  }
  for (const Overlay::GapHandle& g : overlay.gapHandles) {
    Vec2 c = view.apply(g.at);
    double len = std::min(12.0, std::max(6.0, g.length * camera.zoom * 0.25)), thick = 2;
    Vec2 size = g.vertical ? Vec2{len, thick} : Vec2{thick, len};
    emit(makeShape(Mat2x3::translate(std::round((c.x - size.x / 2) * dpr) / dpr, std::round((c.y - size.y / 2) * dpr) / dpr), size, ShapeKind::Rect, {1, 1, 1, 1},
                   style.spacing, 1, style.spacing, 0, 0, 0),
         Pass::Shape);
    if (!g.hovered) continue;
    std::string text = formatNumber(g.value);
    const text::TextLayout* L = label(text, "Medium", style.labelSize);
    double tw = L ? L->size.x : 6.2 * static_cast<double>(text.size());
    double pw = std::round(tw + 2 * style.badgePadding), ph = style.pillHeight, rr = style.pillRadius;
    double px = std::round((c.x + 6) * dpr) / dpr, py = std::round((c.y - len / 2 - ph - 2) * dpr) / dpr;
    emit(makeShape(Mat2x3::translate(px, py), {pw, ph}, ShapeKind::Rect, {rr, rr, rr, rr}, style.spacing, 1, style.spacing, 0, 0, 0), Pass::Shape);
    if (L && !L->lines.empty())
      drawGlyphs(*L, Mat2x3::translate(px + (pw - tw) / 2, std::round((py + (ph - L->lines[0].height) / 2) * dpr) / dpr), white, 1);
  }

  // ⌥R: the rotation origin — a white ring with the selection colour and a dot in it (unverified look).
  if (overlay.hasRotationOrigin) {
    Vec2 c = view.apply(overlay.rotationOrigin);
    const double d = 11, dot = 3;
    emit(makeShape(Mat2x3::translate(std::round((c.x - d / 2) * dpr) / dpr, std::round((c.y - d / 2) * dpr) / dpr), {d, d}, ShapeKind::Ellipse, kSquare,
                   white, 1, blueSel, 1, 1.5, 0),
         Pass::Shape);
    emit(makeShape(Mat2x3::translate(std::round((c.x - dot / 2) * dpr) / dpr, std::round((c.y - dot / 2) * dpr) / dpr), {dot, dot}, ShapeKind::Ellipse,
                   kSquare, blueSel, 1, blueSel, 0, 0, 0),
         Pass::Shape);
  }

  // ⌥ measurement: the measured layer outlined in red, its distances, and dashed extensions.
  if (overlay.measureTarget != kNoGuid && doc.has(overlay.measureTarget)) {
    Guid id = overlay.measureTarget;
    Rect lb = doc.localBounds(id);
    ScreenBox b = screenBox(view * doc.worldTransform(id) * Mat2x3::translate(lb.x, lb.y), {lb.w, lb.h}, dpr);
    emit(makeShape(b.m, b.size, ShapeKind::Rect, kSquare, style.measure, 0, style.measure, 1, 1, 0), Pass::Shape);
  }
  for (const GuideLine& g : overlay.measureGuides) dashed(g.a, g.b, style.measure);
  for (const SpacingMark& m : overlay.measures) distance(m, style.measure);

  // A layer dragged into an auto-layout frame from elsewhere (round 15, round 2: the owner's recording of live Figma,
  // autolayout-drag.md): the frame outlined as hovered (2 px), each layer of its flow 1 px in the selection colour,
  // faint; then the line where it will join the flow.
  if (overlay.dropFrame != kNoGuid && doc.has(overlay.dropFrame)) {
    const Node* fn = doc.get(overlay.dropFrame);
    const Color& c = colorOf(overlay.dropFrame);
    for (Guid k : doc.children(overlay.dropFrame)) {
      const Node* kn = doc.get(k);
      if (!kn || !kn->props.visible || !kn->props.inFlow() || std::find(overlay.ghosts.begin(), overlay.ghosts.end(), k) != overlay.ghosts.end()) continue;
      Rect lb = doc.localBounds(k);
      ScreenBox b = screenBox(view * doc.worldTransform(k) * Mat2x3::translate(lb.x, lb.y), {lb.w, lb.h}, dpr);
      emit(makeShape(b.m, b.size, ShapeKind::Rect, kSquare, c, 0, c, overlay.dropChildAlpha, 1, 0), Pass::Shape);
    }
    outline(view * doc.worldTransform(overlay.dropFrame), fn->props.size, ShapeKind::Rect, kSquare, style.hoverWidth, c);
  }
  // Where a dragged layer will join an auto-layout flow.
  if (overlay.hasInsertion) line(overlay.insertion.a, overlay.insertion.b, style.insertionWidth, blue);

  // Round 12: the Shape builder's regions — filled in the selection colour (a path in screen space), outlined.
  for (const Overlay::Region& r : overlay.regions) {
    if (r.path.empty()) continue;
    // Cached in world space per zoom octave (panning keeps it).
    int octave = static_cast<int>(std::floor(std::log2(std::max(camera.zoom, 1e-6))));
    double tol = 0.25 / std::ldexp(1.0, octave);
    const CurveEntry* entry = curves_.path(r.path.hash() * 31 + static_cast<uint64_t>(octave + 64) * 0x5b1d3e6a7c9f2b41ull,
                                           [&](std::vector<float>& out) { geom::toQuads(r.path, tol, out); });
    emitPath(entry, view, false, Paint::solid(Color{blue.r, blue.g, blue.b, 1}, static_cast<float>(r.alpha)), {1, 1}, 1);
    for (const geom::Polyline& pl : geom::flatten(r.path.transformed(view), 0.25)) polyline(pl.points, true, 1, blue, 1);
  }

  // Vector edit mode, the pen, gradient handles: segments, tangent lines, vertices and handles.
  for (const OverlayCurve& c : overlay.curves) {
    geom::Path p;
    p.moveTo(view.apply(c.p0));
    p.cubicTo(view.apply(c.c1), view.apply(c.c2), view.apply(c.p3));
    Color col = c.highlight ? blue : Color{blue.r, blue.g, blue.b, 1};
    for (const geom::Polyline& pl : geom::flatten(p, 0.25)) polyline(pl.points, false, c.width, col, c.highlight ? 1 : 0.85);
  }
  for (const OverlayLine& l : overlay.lines) {
    Vec2 a = view.apply(l.a), b = view.apply(l.b);
    if (l.dark) {
      polyline({a, b}, false, 3, white, 1);
      polyline({a, b}, false, 1, Color{0, 0, 0, 1}, 0.35);
    } else if (l.dashed) {
      double len = (b - a).length();
      for (double t = 0; t < len; t += 8) polyline({a + (b - a) * (t / len), a + (b - a) * (std::min(len, t + 4) / len)}, false, 1, blue, 1);
    } else {
      polyline({a, b}, false, 1, blue, 1);
    }
  }
  for (const OverlayMark& k : overlay.marks) {
    Vec2 c = view.apply(k.world);
    c = {std::round(c.x * dpr) / dpr, std::round(c.y * dpr) / dpr};
    switch (k.shape) {
      case OverlayMark::Shape::Vertex: {
        double d = k.hovered || k.selected ? 8 : 7;
        Color fill = k.selected ? blue : white;
        emit(makeShape(Mat2x3::translate(c.x - d / 2, c.y - d / 2), {d, d}, ShapeKind::Ellipse, kSquare, fill, 1, k.selected ? white : blue, 1,
                       1, 0),
             Pass::Shape);
        break;
      }
      case OverlayMark::Shape::Handle: {
        double d = 5;
        emit(makeShape(Mat2x3::translate(c.x - d / 2, c.y - d / 2), {d, d}, ShapeKind::Ellipse, kSquare, k.selected ? blue : white, 1, blue, 1,
                       1, 0),
             Pass::Shape);
        break;
      }
      case OverlayMark::Shape::GradientHandle: {
        double d = k.selected ? 12 : 10;
        emit(makeShape(Mat2x3::translate(c.x - d / 2 - 1, c.y - d / 2 - 1), {d + 2, d + 2}, ShapeKind::Ellipse, kSquare, Color{0, 0, 0, 1}, 0.2,
                       blue, 0, 0, 0),
             Pass::Shape);
        emit(makeShape(Mat2x3::translate(c.x - d / 2, c.y - d / 2), {d, d}, ShapeKind::Ellipse, kSquare, white, 1, blue, k.selected ? 1 : 0, 2, 0),
             Pass::Shape);
        break;
      }
      case OverlayMark::Shape::GradientStop: {
        double d = k.selected ? 14 : 12, r = 3;
        emit(makeShape(Mat2x3::translate(c.x - d / 2 - 1, c.y - d / 2 - 1), {d + 2, d + 2}, ShapeKind::Rect, {r + 1, r + 1, r + 1, r + 1},
                       Color{0, 0, 0, 1}, 0.25, blue, 0, 0, 0),
             Pass::Shape);
        emit(makeShape(Mat2x3::translate(c.x - d / 2, c.y - d / 2), {d, d}, ShapeKind::Rect, {r, r, r, r}, k.color, k.color.a,
                       k.selected ? blue : white, 1, 2, 0),
             Pass::Shape);
        break;
      }
    }
  }
  // Dev Mode: saved measurements, annotation labels (or dots), the measurement tool.
  drawDevOverlay(doc, camera, overlay, style);

  if (overlay.lasso.size() > 1) {
    std::vector<Vec2> pts;
    for (Vec2 w : overlay.lasso) pts.push_back(view.apply(w));
    polyline(pts, true, 1, blue, 1);
  }
  if (overlay.trail.size() > 1) {
    std::vector<Vec2> pts;
    for (Vec2 w : overlay.trail) pts.push_back(view.apply(w));
    polyline(pts, false, overlay.trailWidth, blue, overlay.trailWidth > 1 ? 0.4 : 1);
  }

  if (overlay.hasMarquee) {
    const Rect& q = overlay.marquee;
    Rect r = transformedBounds(view * Mat2x3::translate(q.x, q.y), q.w, q.h);
    ScreenBox b = screenBox(Mat2x3::translate(r.x, r.y), {r.w, r.h}, dpr);
    emit(makeShape(b.m, b.size, ShapeKind::Rect, kSquare, blue, style.marqueeFill, blue, 1, 1, 0), Pass::Shape);
  }

  // Prototype mode: connections and their handles, over everything else.
  if (overlay.prototype.on) drawPrototypeOverlay(doc, page, camera, overlay, style);
  // Round 16: the canvas scrollbars.
  drawScrollbars(overlay.scrollbars, style);
  // The `</>` button's tooltip over all of it.
  drawDevTooltip(style);
}

}  // namespace eng
