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

double Renderer::drawStatusChip(const DevStatusMark& mark, double x, double centerY, bool alignRight, bool compact, const OverlayStyle& style) {
  // Ready for dev's chip, for each of the owner's statuses (docs/editor.md "Frame status (ours)"): the status's colour
  // filled, its label in Inter Medium white, 6 px either side — Dev Mode's chip after the name (17 high, round ends),
  // or in Design mode where the `</>` button is (`compact`: its 16 px height and 4 px corners). Changed: Figma's
  // yellow with dark text; Cancelled muted (disabled grey, the title's grey label).
  const double dpr = viewport_.scaleX();
  const bool changed = mark.kind == DevStatusMark::Kind::Changed;
  const int wf = std::clamp<int>(mark.workflow, 0, kWorkflowCount);
  const char* text = changed ? "Changed" : wf ? kWorkflowLabels[wf] : "Set status";
  const text::TextLayout* L = label(text, "Medium", style.labelSize);
  double tw = L ? L->size.x : 6.2 * std::char_traits<char>::length(text);
  double h = compact ? kDevButton : style.badgeHeight, w = std::round(tw + 2 * 6), r = compact ? kDevButtonRadius : h / 2;
  double bx = std::round((alignRight ? x - w : x) * dpr) / dpr, by = std::round((centerY - h / 2) * dpr) / dpr;
  const bool muted = !changed && wf == kWorkflowCancelled;
  Color fill = changed ? style.statusChanged : style.workflow[wf];
  emit(makeShape(Mat2x3::translate(bx, by), {w, h}, ShapeKind::Rect, {r, r, r, r}, fill, 1.0, fill, 0.0, 0, 0), Pass::Shape);
  if (L && !L->lines.empty())
    drawGlyphs(*L, Mat2x3::translate(bx + (w - tw) / 2, std::round((by + (h - L->lines[0].height) / 2) * dpr) / dpr),
               muted ? style.title : changed ? Color{0, 0, 0, 0.9f} : Color{1, 1, 1, 1}, muted ? std::max(0.6, style.titleAlpha) : 1);
  if (recordHits_) {
    CanvasHits::Status hit;
    hit.frame = mark.frame;
    hit.rect = {bx, by, w, h};
    hit.kind = mark.kind;
    hits_.statuses.push_back(hit);
  }
  return w;
}

double Renderer::drawStatusIcon(const DevStatusMark& mark, double right, double centerY, const DevOverlay& dev, const OverlayStyle& style,
                                bool changedSquare) {
  // A design's status in Design mode (the owner, 2026-10-28; live Figma's Ready for dev: a 16 × 16 square of its colour,
  // 4 px corners, the glyph white in it): the status's own glyph (ds/icons/svg/24/status.*.svg, the menu's) — 1 px
  // round strokes from its 24 box, centred in the square. Where the `</>` button's box is: 2 past the frame's right.
  const double dpr = viewport_.scaleX();
  // `changedSquare`: the design's Changed square instead, `right` its right edge — Figma's Changed yellow, the glyph
  // dark on it ("±"), its tooltip "Changed".
  const int wf = std::clamp<int>(mark.workflow, 1, kWorkflowCount);
  const double s = kDevButton, r = kDevButtonRadius;
  double bx = std::round((changedSquare ? right - s : right - kDevIconWidth / 2 - s / 2) * dpr) / dpr, by = std::round((centerY - s / 2) * dpr) / dpr;
  const Color fill = changedSquare ? style.statusChanged : style.workflow[wf];
  const Color ink = changedSquare ? Color{0, 0, 0, 0.9f} : Color{1, 1, 1, 1};
  const bool hovered = dev.iconHover == mark.frame && dev.iconHoverChanged == changedSquare;
  emit(makeShape(Mat2x3::translate(bx, by), {s, s}, ShapeKind::Rect, {r, r, r, r}, fill, 1.0, fill, 0.0, 0, 0), Pass::Shape);
  // Hovered (live Figma's Ready for dev): "…" in place of the glyph — three 2 px dots 4 apart —, and after the
  // tooltip delay the status's name under it.
  if (hovered) {
    for (int i = -1; i <= 1; i++)
      emit(makeShape(Mat2x3::translate(bx + s / 2 + 4 * i - 1, by + s / 2 - 1), {2, 2}, ShapeKind::Ellipse, kSquare, ink, 1, ink, 0, 0, 0), Pass::Shape);
    if (dev.tooltip) {
      devTooltip_ = true;
      devTooltipUnder_ = {bx, by, s, s};
      devTooltipText_ = changedSquare ? "Changed" : kWorkflowLabels[wf];
    }
  }
  // The glyph's 24 box centred on the square's.
  const Vec2 o{bx + s / 2 - 12, by + s / 2 - 12};
  const double w = 1;
  auto line = [&](Vec2 a, Vec2 b) {
    a = a + o, b = b + o;
    Vec2 d = b - a;
    double len = d.length();
    if (len < 1e-9) return;
    Vec2 u{d.x / len, d.y / len}, n{-u.y, u.x};
    emit(makeShape(Mat2x3{u.x, n.x, a.x - n.x * w / 2, u.y, n.y, a.y - n.y * w / 2}, {len, w}, ShapeKind::Rect, kSquare, ink, 1, ink, 0, 0, 0),
         Pass::Shape);
    for (Vec2 p : {a, b}) emit(makeShape(Mat2x3::translate(p.x - w / 2, p.y - w / 2), {w, w}, ShapeKind::Ellipse, kSquare, ink, 1, ink, 0, 0, 0), Pass::Shape);
  };
  auto ring = [&](Vec2 c, double rad) {
    c = c + o;
    emit(makeShape(Mat2x3::translate(c.x - rad - w / 2, c.y - rad - w / 2), {2 * rad + w, 2 * rad + w}, ShapeKind::Ellipse, kSquare, ink, 0, ink, 1, w, 0),
         Pass::Shape);
  };
  auto disc = [&](Vec2 c, double rad) {
    c = c + o;
    emit(makeShape(Mat2x3::translate(c.x - rad, c.y - rad), {2 * rad, 2 * rad}, ShapeKind::Ellipse, kSquare, ink, 1, ink, 0, 0, 0), Pass::Shape);
  };
  // An arc about `c` from angle a0 to a1 (radians, y down), as short strokes.
  auto arc = [&](Vec2 c, double rad, double a0, double a1) {
    const int n = 24;
    Vec2 prev{c.x + rad * std::cos(a0), c.y + rad * std::sin(a0)};
    for (int i = 1; i <= n; i++) {
      double a = a0 + (a1 - a0) * i / n;
      Vec2 p{c.x + rad * std::cos(a), c.y + rad * std::sin(a)};
      line(prev, p);
      prev = p;
    }
  };
  if (hovered) {
  } else if (changedSquare) {  // Changed: "±"
    line({9, 10}, {15, 10});
    line({12, 7}, {12, 13});
    line({9, 16}, {15, 16});
  } else switch (wf) {
    case 1:  // Done: a check
      line({7.5, 12.5}, {10.5, 15.5});
      line({10.5, 15.5}, {16.5, 8.5});
      break;
    case 2: {  // R to Merge: a branch merging
      line({8.5, 8.5}, {8.5, 15.5});
      Vec2 p0{8.5, 8.5}, p1{8.5, 11.5}, p2{10, 12}, p3{14, 12}, prev = p0;
      for (int i = 1; i <= 12; i++) {
        double t = i / 12.0, u = 1 - t;
        Vec2 p = p0 * (u * u * u) + p1 * (3 * u * u * t) + p2 * (3 * u * t * t) + p3 * (t * t * t);
        line(prev, p);
        prev = p;
      }
      ring({8.5, 7}, 1.5);
      ring({8.5, 17}, 1.5);
      ring({15.5, 12}, 1.5);
      break;
    }
    case 3:  // Ready to Dev: Figma's `</>`
      line({9, 8.9}, {6.5, 11.4});
      line({6.5, 11.4}, {9, 13.9});
      line({13.3, 7.2}, {10.7, 16.8});
      line({15, 8.9}, {17.5, 11.4});
      line({17.5, 11.4}, {15, 13.9});
      break;
    case 4:  // To be done: an empty ring
      ring({12, 12}, 5.5);
      break;
    case 5:  // Process: a ring, a dot in it
      ring({12, 12}, 5.5);
      disc({12, 12}, 2.5);
      break;
    case 6:  // Revised: an arrow turning back
      arc({12, 12}, 5, 0, 2 * 3.14159265358979 - 0.81);
      line({15.5, 5.5}, {15.5, 8.5});
      line({15.5, 8.5}, {12.5, 8.5});
      break;
    default:  // Cancelled: a ring struck through
      ring({12, 12}, 5.5);
      line({8.1, 15.9}, {15.9, 8.1});
      break;
  }
  if (recordHits_) {
    CanvasHits::Status hit;
    hit.frame = mark.frame;
    hit.rect = {bx, by, s, s};
    hit.kind = changedSquare ? DevStatusMark::Kind::Changed : mark.kind;
    hits_.statuses.push_back(hit);
  }
  return s;
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
