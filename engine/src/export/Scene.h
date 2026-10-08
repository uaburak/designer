// What the vector writers read from a layer (export/SvgWriter, export/PdfWriter):
// the same drawing rules as the renderer (render/Renderer.cpp) — which layers
// draw and in what order, masks over the siblings above them, a frame's fills,
// clipped children then strokes, booleans drawn from their own geometry — but
// as paths and paints instead of GPU instances.
#pragma once

#include <vector>

#include "geometry/NodeGeometry.h"
#include "geometry/Path.h"
#include "render/Renderer.h"
#include "scene/Document.h"
#include "text/TextLayout.h"

namespace eng::exporter {

// A layer's fill geometry in its own space: a (rounded) rectangle or a full ellipse when it is one (what SVG writes
// as <rect> / <ellipse>), else its paths (vectors, stars, polygons, lines, booleans, arcs, smoothed corners).
struct Shape {
  enum class Kind : uint8_t { None, Rect, Ellipse, Path } kind = Kind::None;
  Vec2 size;
  CornerRadii radii{0, 0, 0, 0};          // Rect, clamped
  std::vector<geom::FillRegion> regions;  // Path
  bool empty() const { return kind == Kind::None; }
  // Every region as one path (Rect / Ellipse: their outline).
  geom::Path path() const;
  bool evenOdd() const { return kind == Kind::Path && regions.size() == 1 && regions[0].windingRule == WindingRule::ODD; }
};
Shape fillShape(const Document& doc, Guid id, const NodeProps& p);

// A layer's stroke: its paints and style, its centre line, and whether INSIDE / OUTSIDE applies (a closed area).
struct Stroke {
  std::vector<const Paint*> paints;  // visible
  double weight = 0;
  StrokeAlign align = StrokeAlign::CENTER;
  StrokeCap cap = StrokeCap::NONE;
  StrokeJoin join = StrokeJoin::MITER;
  double miterLimit = 4;
  std::vector<double> dashes;
  Shape::Kind primitive = Shape::Kind::Path;  // Rect / Ellipse: a plain shape's box (SVG insets or outsets it)
  Vec2 size;
  CornerRadii radii{0, 0, 0, 0};
  geom::Path center;   // node space
  std::vector<std::pair<StrokeCap, StrokeCap>> caps;  // per contour of `center`
  bool aligned = false;  // INSIDE / OUTSIDE kept to the fill (a closed area)
  // Per-side weights or arrowheads: only an outline draws it right.
  bool outlineOnly = false;
  // Per-side weights: `center` is the stroke's area itself (a ring), not a centre line.
  bool ring = false;
  bool present() const { return weight > 0 && !paints.empty(); }
};
Stroke strokeOf(const Document& doc, Guid id, const NodeProps& p);
// The area the stroke covers (node space, NONZERO): the outline at its weight (twice it when aligned) kept inside /
// outside the fill. `tolerance`: how finely curves are flattened (node units).
geom::Path strokeArea(const Stroke& s, const Shape& fill, double tolerance);
// The stroke's outline before INSIDE / OUTSIDE (at twice the weight when aligned).
geom::Path strokeOutline(const Stroke& s, double tolerance);

// A paint as the writers see it: visible and with something to draw.
bool drawable(const Paint& p);

// A child list in paint order, and what masks there: a mask masks every sibling above it in its parent.
struct Drawn {
  Guid id = kNoGuid;
  const Node* node = nullptr;
};
// `parent`'s visible children (back to front).
std::vector<Drawn> drawnChildren(const Document& doc, Guid parent);
// Whether `p`'s children draw (frames, groups — not a boolean's operands).
bool drawsChildren(const NodeProps& p);

// Text: the glyphs of `layout` by fill layer — for each fill index (bottom first), the glyphs whose run has a fill
// there, as one path in node space per paint (runs with the same paints merge).
struct GlyphFill {
  const Paint* paint = nullptr;
  geom::Path path;  // node space
};
std::vector<GlyphFill> glyphFills(const text::TextLayout& layout);
// A glyph's outline in node space (em → its size, at its origin).
geom::Path glyphPath(const text::LaidGlyph& g);

// Paints' own space: gradients map node space → their unit space (linear: t = x; radial: |g − ½| × 2), images node
// space → the image's uv (0..1, y down) — the renderer's matrices.
Mat2x3 gradientMatrix(const Paint& paint, Vec2 nodeSize);
Mat2x3 imageMatrix(const Paint& paint, Vec2 nodeSize, double imageWidth, double imageHeight);
// An image paint's size in px (its original's when the paint knows it; else what was handed in; else 0).
void imageSize(const Paint& paint, uint32_t knownWidth, uint32_t knownHeight, double& w, double& h);

// Base64 (data URIs).
std::string base64(std::string_view bytes);

// Number formatting for the writers: at most `decimals` places, trailing zeros dropped, no "-0".
std::string num(double v, int decimals = 4);

}  // namespace eng::exporter
