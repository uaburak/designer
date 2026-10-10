#include "export/Scene.h"

#include <cmath>
#include <cstdio>
#include <map>

#include "geometry/Boolean.h"
#include "geometry/Shapes.h"
#include "geometry/Stroker.h"
#include "render/ImageCache.h"

namespace eng::exporter {

namespace {

const CornerRadii kSquare{0, 0, 0, 0};

// The renderer's SDF rule (Renderer::drawFills): plain rectangles, frames and full ellipses.
bool plainShape(const NodeProps& p) {
  if (p.isPathShape()) return false;
  if (p.isFrameLike() && p.stroke().cornerSmoothing > 0) return false;
  if (p.invertedCorners()) return false;  // inverted corners: the outline's path (docs/schema.md §3.6)
  return p.isRectLike() || p.isFrameLike() || p.type == NodeType::ELLIPSE;
}

}  // namespace

// Pattern, noise and shader paints aren't written as vectors (PNG / JPG exports draw them).
bool drawable(const Paint& p) {
  return p.visible && p.type != PaintType::OTHER && p.type != PaintType::PATTERN && p.type != PaintType::NOISE && p.type != PaintType::CUSTOM &&
         p.opacity > 0;
}

geom::Path Shape::path() const {
  switch (kind) {
    case Kind::Rect: return geom::rectPath(size, radii);
    case Kind::Ellipse: return geom::ellipsePath(size, ArcData{});
    case Kind::Path: {
      geom::Path out;
      for (auto& r : regions) out.append(r.path);
      return out;
    }
    default: return {};
  }
}

Shape fillShape(const Document& doc, Guid id, const NodeProps& p) {
  Shape s;
  s.size = p.size;
  if (p.type == NodeType::TEXT || p.isGroupLike() || p.type == NodeType::SLICE || p.type == NodeType::CANVAS) return s;
  if (plainShape(p)) {
    s.kind = p.type == NodeType::ELLIPSE ? Shape::Kind::Ellipse : Shape::Kind::Rect;
    if (s.kind == Shape::Kind::Rect) s.radii = geom::clampRadii(p.size, p.cornerRadii);
    return s;
  }
  const NodeGeometry* g = doc.geometry(id);
  if (!g || g->fills.empty()) return s;
  s.kind = Shape::Kind::Path;
  s.regions = g->fills;
  return s;
}

Stroke strokeOf(const Document& doc, Guid id, const NodeProps& p) {
  Stroke s;
  for (const Paint& paint : p.strokePaints)
    if (drawable(paint)) s.paints.push_back(&paint);
  s.weight = p.strokeWeight;
  if (!s.present()) return s;
  s.align = p.strokeAlign;
  s.cap = p.strokeCap;
  s.join = p.strokeJoin;
  s.miterLimit = p.miterLimit;
  s.dashes = p.stroke().dashPattern;
  s.fitDashes = p.isRectLike() || p.isFrameLike();
  s.size = p.size;
  bool independent = p.stroke().borderStrokeWeightsIndependent && (p.isRectLike() || p.isFrameLike());
  bool dashedFrame = p.isFrameLike() && !p.stroke().dashPattern.empty();
  if (!p.extra.empty() && widthProfileAllowed(p)) s.profile = widthPointsOf(p);
  if (!independent && !dashedFrame && s.profile.empty() && plainShape(p)) {
    s.primitive = p.type == NodeType::ELLIPSE ? Shape::Kind::Ellipse : Shape::Kind::Rect;
    if (s.primitive == Shape::Kind::Rect) s.radii = geom::clampRadii(p.size, p.cornerRadii);
    s.aligned = s.align != StrokeAlign::CENTER;
    s.center = s.primitive == Shape::Kind::Rect ? geom::rectPath(p.size, s.radii) : geom::ellipsePath(p.size, ArcData{});
    return s;
  }
  if (independent) {
    // Per-side weights (Renderer::drawStrokes): the ring between the box and the box inset by each side's weight.
    s.outlineOnly = true;
    const auto& bw = p.stroke().borderWeights;
    double k0 = p.strokeAlign == StrokeAlign::INSIDE ? 0 : p.strokeAlign == StrokeAlign::OUTSIDE ? 1 : 0.5;
    double t = bw[0], r = bw[1], b = bw[2], l = bw[3];
    Rect outer{-l * k0, -t * k0, p.size.x + (l + r) * k0, p.size.y + (t + b) * k0};
    Rect inner{outer.x + l, outer.y + t, outer.w - l - r, outer.h - t - b};
    CornerRadii radii = geom::clampRadii(p.size, p.cornerRadii);
    const uint32_t inv = p.invertedCorners();
    geom::Path ring = geom::rectPath({outer.w, outer.h}, radii, 0, inv).transformed(Mat2x3::translate(outer.x, outer.y));
    if (inner.w > 0 && inner.h > 0) {
      CornerRadii ir;
      for (size_t i = 0; i < 4; i++) ir[i] = (inv >> i) & 1 ? radii[i] + std::max(t, l) : std::max(0.0, radii[i] - std::max(t, l));
      ring.append(geom::rectPath({inner.w, inner.h}, ir, 0, inv).transformed(Mat2x3::translate(inner.x, inner.y)).reversed());
    }
    s.center = std::move(ring);  // the area itself
    s.ring = true;
    return s;
  }
  const NodeGeometry* g = doc.geometry(id);
  if (!g || g->stroke.path.empty()) {
    s.weight = 0;
    return s;
  }
  s.center = g->stroke.path;
  s.caps = g->stroke.caps;
  bool closedArea = !g->fills.empty() && !g->hasOpenEnds;
  s.aligned = closedArea && p.strokeAlign != StrokeAlign::CENTER;
  auto arrow = [](StrokeCap c) { return c != StrokeCap::NONE && c != StrokeCap::ROUND && c != StrokeCap::SQUARE; };
  if (arrow(s.cap) || !s.profile.empty()) s.outlineOnly = true;
  for (auto& [a, b] : s.caps)
    if (arrow(a) || arrow(b)) s.outlineOnly = true;
  return s;
}

geom::Path strokeOutline(const Stroke& s, double tolerance) {
  if (s.ring) return s.center;
  geom::StrokeStyle style;
  style.width = s.weight * (s.aligned ? 2 : 1);
  style.join = s.join;
  style.miterLimit = s.miterLimit;
  style.cap = s.cap;
  style.dashes = s.dashes;
  style.fitDashes = s.fitDashes;
  style.caps = s.caps.empty() ? nullptr : &s.caps;
  if (!s.profile.empty()) style.profile = &s.profile;
  return geom::strokePath(s.center, style, tolerance);
}

geom::Path strokeArea(const Stroke& s, const Shape& fill, double tolerance) {
  // Per-side weights: `center` holds the ring itself.
  if (s.ring) return geom::simplify(s.center, WindingRule::NONZERO, tolerance);
  geom::Path outline = strokeOutline(s, tolerance);
  if (!s.aligned) return geom::simplify(outline, WindingRule::NONZERO, tolerance);
  std::vector<geom::Operand> ops;
  ops.push_back({std::move(outline), WindingRule::NONZERO});
  geom::Operand f{fill.path(), fill.evenOdd() ? WindingRule::ODD : WindingRule::NONZERO};
  if (s.primitive != Shape::Kind::Path) f.path = s.center;
  ops.push_back(std::move(f));
  return geom::booleanOp(ops, s.align == StrokeAlign::INSIDE ? BooleanOperation::INTERSECT : BooleanOperation::SUBTRACT, tolerance);
}

bool drawsChildren(const NodeProps& p) { return !p.isBoolean() && (p.isFrameLike() || p.isGroupLike()); }

std::vector<Drawn> drawnChildren(const Document& doc, Guid parent) {
  std::vector<Drawn> out;
  for (Guid c : doc.children(parent)) {
    const Node* n = doc.get(c);
    if (!n || !n->props.visible || n->props.opacity <= 0) continue;
    if (n->props.type == NodeType::SLICE) continue;  // slices draw nothing
    out.push_back({c, n});
  }
  return out;
}

geom::Path glyphPath(const text::LaidGlyph& g) {
  geom::Path path;
  if (!g.font) return path;
  const text::GlyphOutline& o = g.font->outline(g.glyph);
  Vec2 last{1e300, 1e300};
  bool open = false;
  for (size_t c = 0; c < o.curveCount(); c++) {
    const float* q = &o.curves[c * 6];
    auto at = [&](float x, float y) { return Vec2{g.x + x * g.size, g.y + y * g.size}; };
    Vec2 p0 = at(q[0], q[1]), p1 = at(q[2], q[3]), p2 = at(q[4], q[5]);
    if (!(p0 == last)) {
      if (open) path.close();
      path.moveTo(p0);
      open = true;
    }
    // Lines come as quadratics with the control in the middle: write them as lines.
    Vec2 mid{(p0.x + p2.x) / 2, (p0.y + p2.y) / 2};
    if (std::fabs(p1.x - mid.x) < 1e-6 && std::fabs(p1.y - mid.y) < 1e-6) path.lineTo(p2);
    else path.quadTo(p1, p2);
    last = p2;
  }
  if (open) path.close();
  return path;
}

std::vector<GlyphFill> glyphFills(const text::TextLayout& L) {
  std::vector<GlyphFill> out;
  size_t layers = 0;
  for (const auto& s : L.styles) layers = std::max(layers, s.fills ? s.fills->size() : 0);
  for (size_t f = 0; f < layers; f++) {
    // One path per distinct paint at this layer, in the order the runs first use them.
    std::vector<GlyphFill> layer;
    auto slot = [&](const Paint* paint) -> geom::Path& {
      for (auto& g : layer)
        if (*g.paint == *paint) return g.path;
      layer.push_back({paint, {}});
      return layer.back().path;
    };
    for (const text::LaidGlyph& g : L.glyphs) {
      const auto* fills = L.styles[g.style].fills;
      if (!fills || f >= fills->size() || !drawable((*fills)[f])) continue;
      slot(&(*fills)[f]).append(glyphPath(g));
    }
    for (const text::Decoration& d : L.decorations) {
      const auto* fills = text::decorationFills(L, d);
      if (!fills || f >= fills->size() || !drawable((*fills)[f])) continue;
      geom::Path shape = d.round ? geom::ellipsePath({d.rect.w, d.rect.h}, ArcData{}) : geom::rectPath({d.rect.w, d.rect.h}, kSquare);
      slot(&(*fills)[f]).append(shape.transformed(text::decorationTransform(d)));
    }
    for (auto& g : layer)
      if (!g.path.empty()) out.push_back(std::move(g));
  }
  return out;
}

Mat2x3 gradientMatrix(const Paint& paint, Vec2 size) {
  return paint.transform * Mat2x3{1 / std::max(size.x, 1e-9), 0, 0, 0, 1 / std::max(size.y, 1e-9), 0};
}

Mat2x3 imageMatrix(const Paint& paint, Vec2 size, double iw, double ih) {
  // Renderer.cpp's imageMatrix (the same rules, kept in step).
  double w = std::max(size.x, 1e-9), h = std::max(size.y, 1e-9);
  iw = std::max(iw, 1.0);
  ih = std::max(ih, 1.0);
  double turns = std::fmod(std::round(paint.rotation / 90.0), 4.0);
  if (turns < 0) turns += 4;
  double angle = turns * 3.14159265358979323846 / 2;
  bool sideways = static_cast<int>(turns) % 2 == 1;
  double rw = sideways ? ih : iw, rh = sideways ? iw : ih;
  switch (paint.imageScaleMode) {
    case ImageScaleMode::STRETCH: return paint.transform * Mat2x3{1 / w, 0, 0, 0, 1 / h, 0};
    case ImageScaleMode::TILE: {
      double s = paint.scale > 0 ? paint.scale : 1;
      return Mat2x3{1 / (iw * s), 0, 0, 0, 1 / (ih * s), 0} * Mat2x3::rotate(-angle);
    }
    case ImageScaleMode::FILL:
    case ImageScaleMode::FIT: {
      double s = paint.imageScaleMode == ImageScaleMode::FILL ? std::max(w / rw, h / rh) : std::min(w / rw, h / rh);
      return Mat2x3::translate(0.5, 0.5) * Mat2x3{1 / (iw * s), 0, 0, 0, 1 / (ih * s), 0} * Mat2x3::rotate(-angle) *
             Mat2x3::translate(-w / 2, -h / 2);
    }
  }
  return {};
}

void imageSize(const Paint& paint, uint32_t knownWidth, uint32_t knownHeight, double& w, double& h) {
  ImageHints hints = imageHints(paint);
  if (hints.originalWidth && hints.originalHeight) {
    w = hints.originalWidth;
    h = hints.originalHeight;
  } else {
    w = knownWidth;
    h = knownHeight;
  }
}

std::string num(double v, int decimals) {
  if (!std::isfinite(v)) return "0";
  char buf[64];
  std::snprintf(buf, sizeof buf, "%.*f", decimals, v);
  std::string s = buf;
  if (s.find('.') != std::string::npos) {
    while (!s.empty() && s.back() == '0') s.pop_back();
    if (!s.empty() && s.back() == '.') s.pop_back();
  }
  if (s == "-0" || s.empty()) return "0";
  return s;
}

std::string base64(std::string_view in) {
  static const char* k = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve((in.size() + 2) / 3 * 4);
  size_t i = 0;
  auto at = [&](size_t j) { return static_cast<uint32_t>(static_cast<uint8_t>(in[j])); };
  for (; i + 2 < in.size(); i += 3) {
    uint32_t v = at(i) << 16 | at(i + 1) << 8 | at(i + 2);
    out += k[v >> 18], out += k[(v >> 12) & 63], out += k[(v >> 6) & 63], out += k[v & 63];
  }
  if (i + 1 == in.size()) {
    uint32_t v = at(i) << 16;
    out += k[v >> 18], out += k[(v >> 12) & 63], out += "==";
  } else if (i + 2 == in.size()) {
    uint32_t v = at(i) << 16 | at(i + 1) << 8;
    out += k[v >> 18], out += k[(v >> 12) & 63], out += k[(v >> 6) & 63], out += '=';
  }
  return out;
}

}  // namespace eng::exporter
