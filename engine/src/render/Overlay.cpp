// The editor's canvas overlays, drawn after the scene in CSS px with 1-px lines
// snapped to device pixels (docs/engine.md §6.11).

#include <cmath>
#include <cstdio>
#include <string>

#include "editor/Selection.h"
#include "geometry/Path.h"
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

void Renderer::drawTitleIcon(TitleIcon icon, const Rect& box, const Color& color) {
  // Diamonds: squares turned 45°, `d` across their diagonal.
  auto diamond = [&](Vec2 c, double d, bool filled) {
    double side = d / std::sqrt(2.0);
    const double k = std::sqrt(0.5);
    // A side×side square turned 45° about its centre c: T(c)·R(45°)·T(−side/2, −side/2).
    Mat2x3 at{k, -k, c.x, k, k, c.y - side * k};
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

void Renderer::drawOverlay(const Document& doc, Guid page, const Camera& camera, const Overlay& overlay, const OverlayStyle& style) {
  const double dpr = viewport_.scaleX();  // snap to the canvas's real pixels
  if (recordHits_) hits_ = CanvasHits{};
  const Color& blue = style.selection;
  const Color white{1, 1, 1, 1};
  Mat2x3 view = camera.matrix();

  // Components, component sets and instances are outlined in the component purple.
  auto colorOf = [&](Guid id) -> const Color& {
    const Node* n = doc.get(id);
    return n && n->props.isComponentish() ? style.component : blue;
  };
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
  auto nodeOutline = [&](Guid id, double weight, bool ownShape) {
    const Node* n = doc.get(id);
    if (!n) return;
    if (ownShape && n->props.isPathShape()) {
      // Vectors, stars, booleans…: their own outline.
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
    bool rounded = ownShape && (n->props.isRectLike() || n->props.isFrameLike());
    outline(m, {lb.w, lb.h}, kind, rounded ? n->props.cornerRadii : kSquare, weight, colorOf(id));
  };

  // Text being edited: the selection highlight and the caret.
  if (overlay.textNode != kNoGuid && doc.has(overlay.textNode)) {
    Mat2x3 m = view * doc.worldTransform(overlay.textNode);
    for (const Rect& r : overlay.textSelection) {
      Mat2x3 rm = m * Mat2x3::translate(r.x, r.y);
      emit(makeShape(rm, {r.w, r.h}, ShapeKind::Rect, kSquare, blue, style.textSelectionAlpha, blue, 0, 0, 0), Pass::Shape);
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
      const text::TextLayout* L = label(name, section ? "Medium" : "Regular", size);
      return L ? L->size.x : 6.2 * static_cast<double>(name.size()) * size / 11;
    };
    auto has = [](const std::vector<Guid>& ids, Guid id) { return std::find(ids.begin(), ids.end(), id) != ids.end(); };
    for (const FrameTitle& t : frameTitles(doc, page, view, screen_, style, measure, overlay.dev.focus)) {
      const Node* n = doc.get(t.id);
      if (!n) continue;
      bool isSelected = has(overlay.selection, t.id), hovered = has(overlay.hover, t.id);
      if (t.section) {
        // The pill: the section's own colour a shade darker (the selection colour when selected or hovered), its
        // name in Inter Medium.
        Color fill = Color::hex(0xE6E6E6);
        for (const Paint& p : n->props.fillPaints)
          if (p.visible && p.type == PaintType::SOLID) fill = Color{p.color.r * 0.9f, p.color.g * 0.9f, p.color.b * 0.9f, 1};
        bool darkFill = 0.2126 * fill.r + 0.7152 * fill.g + 0.0722 * fill.b < 0.5;
        Color ink = darkFill ? Color{1, 1, 1, 1} : Color{0, 0, 0, 0.9f};
        if (isSelected || hovered) fill = blue, ink = white;
        const Rect& h = t.hit;
        const double r = 2;
        emit(makeShape(Mat2x3::translate(std::round(h.x * dpr) / dpr, std::round(h.y * dpr) / dpr), {h.w, h.h}, ShapeKind::Rect, {r, r, r, r}, fill,
                       1, fill, 0, 0, 0),
             Pass::Shape);
        const text::TextLayout* L = label(n->props.name, "Medium", style.sectionTitleSize, t.text.w);
        if (L && !L->lines.empty()) {
          double ty = std::round((h.y + (h.h - L->lines[0].height) / 2) * dpr) / dpr;
          drawGlyphs(*L, Mat2x3::translate(std::round(t.text.x * dpr) / dpr, ty), Color{ink.r, ink.g, ink.b, 1}, ink.a);
        }
        continue;
      }
      // Components' and instances' names in the component purple, after Figma's icon; a selected frame's in the
      // selection's text colour; others grey.
      Color ink = n->props.isComponentish() ? componentText : isSelected ? selectedText : grey;
      if (t.icon != TitleIcon::None) drawTitleIcon(t.icon, t.iconBox, ink);
      double x = std::round((t.text.x + overlay.prototype.labelWidth(t.id)) * dpr) / dpr;
      double baseline = std::round(t.baseline * dpr) / dpr;
      double room = t.frame.right() - x;
      if (room < 1) continue;
      const text::TextLayout* L = label(n->props.name, "Regular", style.titleSize, room);
      if (!L || L->lines.empty()) continue;
      drawGlyphs(*L, Mat2x3::translate(x, baseline - L->lines[0].baseline), Color{ink.r, ink.g, ink.b, 1}, ink.a);
      // Dev Mode: the design's status (or, hovered or selected, "Mark as ready for dev") after its name.
      for (const DevStatusMark& mark : overlay.dev.statuses)
        if (mark.frame == t.id) drawStatusChip(mark, x + L->size.x + 6, baseline, style);
    }
  }

  // Auto-layout padding / gap bands under the pointer.
  for (const Rect& band : overlay.bands) {
    Rect r = transformedBounds(view * Mat2x3::translate(band.x, band.y), band.w, band.h);
    ScreenBox b = screenBox(Mat2x3::translate(r.x, r.y), {r.w, r.h}, dpr);
    emit(makeShape(b.m, b.size, ShapeKind::Rect, kSquare, style.autoLayoutBand, style.bandAlpha, blue, 0, 0, 0), Pass::Shape);
  }

  // A selected grid's tracks: a pill per column above the frame and per row left of it; the hovered one is solid and
  // shows its size in a badge (Figma: "the blue pill" with its label).
  for (const Overlay::GridTrack& t : overlay.gridTracks) {
    Vec2 a = view.apply(t.a), b = view.apply(t.b);
    if (t.column ? std::fabs(a.y - b.y) > 0.5 : std::fabs(a.x - b.x) > 0.5) continue;  // turned frames: none
    const double inset = 3, thick = 4, gap = 8;
    double len = (t.column ? b.x - a.x : b.y - a.y) - 2 * inset;
    if (len < 2) len = 2;
    double x = t.column ? a.x + inset : a.x - gap - thick, y = t.column ? a.y - gap - thick : a.y + inset;
    Vec2 size = t.column ? Vec2{len, thick} : Vec2{thick, len};
    double r = thick / 2;
    emit(makeShape(Mat2x3::translate(std::round(x * dpr) / dpr, std::round(y * dpr) / dpr), size, ShapeKind::Rect, {r, r, r, r}, blue,
                   t.hovered || t.selected ? 1.0 : 0.45, blue, 0, 0, 0),
         Pass::Shape);
    if (!(t.hovered || t.selected) || t.label.empty()) continue;
    const text::TextLayout* L = label(t.label, "Medium", style.labelSize);
    double tw = L ? L->size.x : 6.2 * static_cast<double>(t.label.size());
    // The badge as wide as the editor's hit test takes it (tools/GridGestures.cpp gridBadgeWidth).
    double bw = t.column ? std::round(6.2 * static_cast<double>(t.label.size()) + 2 * style.badgePadding + 2) : std::round(tw + 2 * style.badgePadding),
           bh = style.badgeHeight;
    bw = std::max(bw, std::round(tw + 2 * style.badgePadding));
    double cx = t.column ? x + len / 2 : x + thick / 2, cy = t.column ? y + thick / 2 : y + len / 2;
    double bx = std::round((cx - bw / 2) * dpr) / dpr, by = std::round((cy - bh / 2) * dpr) / dpr;
    double rr = style.badgeRadius;
    emit(makeShape(Mat2x3::translate(bx, by), {bw, bh}, ShapeKind::Rect, {rr, rr, rr, rr}, blue, 1, blue, 0, 0, 0), Pass::Shape);
    if (L && !L->lines.empty()) drawGlyphs(*L, Mat2x3::translate(bx + (bw - tw) / 2, std::round((by + (bh - L->lines[0].height) / 2) * dpr) / dpr), white, 1);
    if (t.selected) emit(makeShape(Mat2x3::translate(bx - 1, by - 1), {bw + 2, bh + 2}, ShapeKind::Rect, {rr + 1, rr + 1, rr + 1, rr + 1}, white, 0, white, 1, 1, 0), Pass::Shape);
    if (t.grabber) {
      // The grabber: two columns of three dots just before the label (columns: left of it; rows: above it).
      const double gw = 10, gh = 14;
      double gx = t.column ? bx - 2 - gw : cx - gw / 2, gy = t.column ? cy - gh / 2 : by - 2 - gh;
      emit(makeShape(Mat2x3::translate(std::round(gx * dpr) / dpr, std::round(gy * dpr) / dpr), {gw, gh}, ShapeKind::Rect, {3, 3, 3, 3}, blue, 1, blue, 0, 0, 0),
           Pass::Shape);
      for (int k = 0; k < 6; k++) {
        double dx = gx + 3 + (k % 2) * 3, dy = gy + 3 + (k / 2) * 3.5;
        emit(makeShape(Mat2x3::translate(dx, dy), {1.5, 1.5}, ShapeKind::Ellipse, kSquare, white, 1, white, 0, 0, 0), Pass::Shape);
      }
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

  // Hover: the hovered layer's own outline (not when it is selected).
  for (Guid h : overlay.hover) {
    bool selected = false;
    for (Guid s : overlay.selection) selected |= s == h;
    if (!selected && doc.has(h)) nodeOutline(h, style.hoverWidth, true);
  }

  // Selection: each layer's box, the selection's box, its handles and size badge.
  SelectionBox box = selectionBox(doc, overlay.selection);
  // The selection's box, handles and badge: purple when everything selected is a component or an instance.
  bool allComponents = !overlay.selection.empty();
  for (Guid s : overlay.selection) allComponents &= &colorOf(s) == &style.component;
  const Color& blueSel = allComponents ? style.component : blue;
  if (box.valid && overlay.selectionBox) {
    const Color& blue = blueSel;
    if (overlay.selection.size() > 1)
      for (Guid s : overlay.selection) nodeOutline(s, 1, false);
    Mat2x3 toScreen = view * box.toWorld;
    ScreenBox sb = screenBox(toScreen, box.size, dpr);
    emit(makeShape(sb.m, sb.size, ShapeKind::Rect, kSquare, blue, 0, blue, 1, 1, 0), Pass::Shape);

    bool roomy = sb.size.x >= style.handlesMinBox && sb.size.y >= style.handlesMinBox;
    if (overlay.handles && roomy) {
      const double hs = style.handleSize;
      Vec2 corners[4] = {{0, 0}, {sb.size.x, 0}, {sb.size.x, sb.size.y}, {0, sb.size.y}};
      for (auto& c : corners) {
        Mat2x3 hm = sb.m;
        Vec2 o = sb.m.apply(c) - sb.m.applyLinear({hs / 2, hs / 2});
        hm.m02 = std::round(o.x * dpr) / dpr;
        hm.m12 = std::round(o.y * dpr) / dpr;
        emit(makeShape(hm, {hs, hs}, ShapeKind::Rect, kSquare, white, 1, blue, 1, 1, 0), Pass::Shape);
      }
    }

    if (overlay.sizeBadge) {
      // The pill under the box; its text arrives with the text engine (E3), so it is sized for it now.
      Rect r = transformedBounds(toScreen, box.size.x, box.size.y);
      Mat2x3 w = box.toWorld;
      Vec2 worldSize{box.size.x * std::hypot(w.m00, w.m10), box.size.y * std::hypot(w.m01, w.m11)};
      std::string text = formatNumber(worldSize.x) + " \u00D7 " + formatNumber(worldSize.y);
      const text::TextLayout* L = label(text, "Medium", style.labelSize);
      double tw = L ? L->size.x : 6.2 * static_cast<double>(text.size());
      double bw = std::round(tw + 2 * style.badgePadding), bh = style.badgeHeight;
      double bx = std::round((r.x + r.w / 2 - bw / 2) * dpr) / dpr;
      double by = std::round((r.bottom() + style.badgeGap) * dpr) / dpr;
      double rr = style.badgeRadius;
      emit(makeShape(Mat2x3::translate(bx, by), {bw, bh}, ShapeKind::Rect, {rr, rr, rr, rr}, blue, 1, blue, 0, 0, 0),
           Pass::Shape);
      if (L && !L->lines.empty()) {
        const text::LaidLine& line = L->lines[0];
        double ty = by + (bh - line.height) / 2;
        drawGlyphs(*L, Mat2x3::translate(bx + (bw - tw) / 2, std::round(ty * dpr) / dpr), white, 1);
      }
    }
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
  for (const SpacingMark& m : overlay.spacings) distance(m, style.measure);

  // ⌥ measurement: the measured layer outlined in red, its distances, and dashed extensions.
  if (overlay.measureTarget != kNoGuid && doc.has(overlay.measureTarget)) {
    Guid id = overlay.measureTarget;
    Rect lb = doc.localBounds(id);
    ScreenBox b = screenBox(view * doc.worldTransform(id) * Mat2x3::translate(lb.x, lb.y), {lb.w, lb.h}, dpr);
    emit(makeShape(b.m, b.size, ShapeKind::Rect, kSquare, style.measure, 0, style.measure, 1, 1, 0), Pass::Shape);
  }
  for (const GuideLine& g : overlay.measureGuides) dashed(g.a, g.b, style.measure);
  for (const SpacingMark& m : overlay.measures) distance(m, style.measure);

  // Where a dragged layer will join an auto-layout flow.
  if (overlay.hasInsertion) line(overlay.insertion.a, overlay.insertion.b, style.insertionWidth, blue);

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

  if (overlay.hasMarquee) {
    const Rect& q = overlay.marquee;
    Rect r = transformedBounds(view * Mat2x3::translate(q.x, q.y), q.w, q.h);
    ScreenBox b = screenBox(Mat2x3::translate(r.x, r.y), {r.w, r.h}, dpr);
    emit(makeShape(b.m, b.size, ShapeKind::Rect, kSquare, blue, style.marqueeFill, blue, 1, 1, 0), Pass::Shape);
  }

  // Prototype mode: connections and their handles, over everything else.
  if (overlay.prototype.on) drawPrototypeOverlay(doc, page, camera, overlay, style);
}

}  // namespace eng
