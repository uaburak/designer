#include "render/Renderer.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "geometry/Shapes.h"
#include "geometry/Stroker.h"

namespace eng {

namespace {

const CornerRadii kSquare{0, 0, 0, 0};
constexpr int kRampWidth = 256;

void premultiply(float out[4], const Color& c, double alpha) {
  float a = static_cast<float>(c.a * alpha);
  out[0] = c.r * a;
  out[1] = c.g * a;
  out[2] = c.b * a;
  out[3] = a;
}

void setLinear(DrawInstance& q, const Mat2x3& m) {
  q.linear[0] = static_cast<float>(m.m00);
  q.linear[1] = static_cast<float>(m.m10);
  q.linear[2] = static_cast<float>(m.m01);
  q.linear[3] = static_cast<float>(m.m11);
  q.origin[0] = static_cast<float>(m.m02);
  q.origin[1] = static_cast<float>(m.m12);
}

bool nearlyAxisAligned(const Mat2x3& m) { return std::fabs(m.m01) < 1e-9 && std::fabs(m.m10) < 1e-9 && m.m00 > 0 && m.m11 > 0; }

bool anyVisible(const std::vector<Paint>& paints) {
  for (auto& p : paints)
    if (p.visible && p.opacity > 0) return true;
  return false;
}

struct Hash {
  uint64_t h = 1469598103934665603ull;
  template <typename T>
  Hash& add(const T& v) {
    const auto* p = reinterpret_cast<const uint8_t*>(&v);
    for (size_t i = 0; i < sizeof(T); i++) {
      h ^= p[i];
      h *= 1099511628211ull;
    }
    return *this;
  }
};

gfx::IRect intersect(gfx::IRect a, gfx::IRect b) {
  int x0 = std::max(a.x, b.x), y0 = std::max(a.y, b.y);
  int x1 = std::min(a.x + a.w, b.x + b.w), y1 = std::min(a.y + a.h, b.y + b.h);
  return {x0, y0, std::max(0, x1 - x0), std::max(0, y1 - y0)};
}

int roundUp(int v, int step) { return (std::max(v, 1) + step - 1) / step * step; }

// The image paint's matrix: node space → the image's uv (0..1, y down), per Figma's scale modes.
Mat2x3 imageMatrix(const Paint& paint, Vec2 size, double iw, double ih) {
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

}  // namespace

DrawInstance makeShape(const Mat2x3& m, Vec2 size, ShapeKind kind, const CornerRadii& radii, const Color& fill,
                       double fillAlpha, const Color& stroke, double strokeAlpha, double inner, double outer) {
  DrawInstance q{};
  setLinear(q, m);
  q.origin[2] = static_cast<float>(size.x);
  q.origin[3] = static_cast<float>(size.y);
  for (int i = 0; i < 4; i++) q.box[i] = static_cast<float>(radii[static_cast<size_t>(i)]);
  q.geom[0] = static_cast<float>(inner);
  q.geom[1] = static_cast<float>(outer);
  q.geom[2] = static_cast<float>(kind);
  bool f = fillAlpha > 0, s = strokeAlpha > 0 && inner + outer > 0;
  if (f && s) {
    premultiply(q.color, fill, fillAlpha);
    premultiply(q.paint0, stroke, strokeAlpha);
    q.geom[3] = drawFlags(DF_FILL_AND_STROKE, PaintKind::Solid);
  } else if (s) {
    premultiply(q.color, stroke, strokeAlpha);
    q.geom[3] = drawFlags(DF_STROKE, PaintKind::Solid);
  } else {
    premultiply(q.color, fill, fillAlpha);
    q.geom[3] = drawFlags(0, PaintKind::Solid);
  }
  return q;
}

bool Renderer::DrawState::operator==(const DrawState& o) const {
  return image == o.image && backdrop == o.backdrop && std::memcmp(filters, o.filters, sizeof filters) == 0;
}

Color Renderer::titleColor(const Color& page, double* alpha) {
  // Figma reads the page's luminance: light text on a dark page, dark text on a light one.
  auto linear = [](float c) { return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); };
  double l = 0.2126 * linear(page.r) + 0.7152 * linear(page.g) + 0.0722 * linear(page.b);
  if (l < 0.18) {
    *alpha = 0.7;  // white at 70 % (Figma's secondary text on dark)
    return Color{1, 1, 1, 1};
  }
  *alpha = 0.5;
  return Color{0, 0, 0, 1};
}

Renderer::Renderer(gfx::Device& device) : device_(device), curves_(device), images_(device) {}

Renderer::~Renderer() {
  if (buffer_) device_.destroyBuffer(buffer_);
  if (ramp_) device_.destroyTexture(ramp_);
  if (white_) device_.destroyTexture(white_);
  for (auto& t : pool_) device_.destroyTarget(t.target);
}

void Renderer::ensurePipelines() {
  if (pipelines_[0]) return;
  using namespace gfx;
  auto make = [&](Pass pass, ShaderId shader, Blend blend, StencilState stencil, ColorMask mask) {
    PipelineDesc d;
    d.shader = shader;
    d.blend = blend;
    d.stencil = stencil;
    d.colorMask = mask;
    pipelines_[static_cast<int>(pass)] = device_.createPipeline(d);
  };
  StencilState none, equal{true, StencilFunc::Equal, StencilOp::Keep}, inc{true, StencilFunc::Equal, StencilOp::Increment},
      dec{true, StencilFunc::Equal, StencilOp::Decrement};
  make(Pass::Shape, ShaderId::Shape, Blend::Premultiplied, none, ColorMask::All);
  make(Pass::ShapeClipped, ShaderId::Shape, Blend::Premultiplied, equal, ColorMask::All);
  make(Pass::ShapeStencilInc, ShaderId::Shape, Blend::Premultiplied, inc, ColorMask::None);
  make(Pass::ShapeStencilDec, ShaderId::Shape, Blend::Premultiplied, dec, ColorMask::None);
  make(Pass::Path, ShaderId::Path, Blend::Premultiplied, none, ColorMask::All);
  make(Pass::PathClipped, ShaderId::Path, Blend::Premultiplied, equal, ColorMask::All);
  make(Pass::PathStencilInc, ShaderId::Path, Blend::Premultiplied, inc, ColorMask::None);
  make(Pass::PathStencilDec, ShaderId::Path, Blend::Premultiplied, dec, ColorMask::None);
  make(Pass::Composite, ShaderId::Composite, Blend::Premultiplied, none, ColorMask::All);
  make(Pass::CompositeClipped, ShaderId::Composite, Blend::Premultiplied, equal, ColorMask::All);
  make(Pass::CompositeReplace, ShaderId::Composite, Blend::Replace, none, ColorMask::All);
  make(Pass::CompositeReplaceClipped, ShaderId::Composite, Blend::Replace, equal, ColorMask::All);
  make(Pass::Blur, ShaderId::Blur, Blend::Replace, none, ColorMask::All);
  white_ = device_.createTexture(TextureFormat::RGBA8, 1, 1);
  if (white_) {
    const uint8_t px[4] = {255, 255, 255, 255};
    device_.writeTexture(white_, {0, 0, 1, 1}, {px, 4});
  }
}

// ---- Recording ----------------------------------------------------------------------------------

void Renderer::emit(const DrawInstance& s, Pass pass) { emit(s, pass, DrawState{}); }

void Renderer::emit(const DrawInstance& s, Pass pass, const DrawState& state) {
  uint8_t ref = stencilDepth_;
  if (stencilDepth_ > 0) {
    if (pass == Pass::Shape) pass = Pass::ShapeClipped;
    else if (pass == Pass::Path) pass = Pass::PathClipped;
  }
  if (pass == Pass::ShapeStencilDec || pass == Pass::PathStencilDec) ref = static_cast<uint8_t>(stencilDepth_ + 1);
  std::vector<Cmd>& cmds = layers_[static_cast<size_t>(current_)].cmds;
  bool merge = !cmds.empty();
  if (merge) {
    const Cmd& d = cmds.back();
    merge = d.kind == Cmd::Kind::Draw && d.pass == pass && d.stencilRef == ref && d.scissorEnabled == scissorEnabled_ &&
            d.first + d.count == instances_.size() && d.state == state &&
            (!scissorEnabled_ || (d.scissor.x == scissor_.x && d.scissor.y == scissor_.y && d.scissor.w == scissor_.w &&
                                   d.scissor.h == scissor_.h));
  }
  if (merge) {
    cmds.back().count++;
  } else {
    Cmd c;
    c.kind = Cmd::Kind::Draw;
    c.pass = pass;
    c.first = static_cast<uint32_t>(instances_.size());
    c.count = 1;
    c.scissorEnabled = scissorEnabled_;
    c.scissor = scissor_;
    c.stencilRef = ref;
    c.state = state;
    cmds.push_back(c);
  }
  instances_.push_back(s);
  stats_.shapes++;
  if (s.geom[2] == static_cast<float>(ShapeKind::Path)) stats_.paths++;
}

int Renderer::rampRow(const std::vector<ColorStop>& stops0) {
  Hash h;
  for (auto& s : stops0) h.add(s.position).add(s.color.r).add(s.color.g).add(s.color.b).add(s.color.a);
  auto it = rampRows_.find(h.h);
  if (it != rampRows_.end()) return it->second;
  std::vector<ColorStop> stops = stops0;
  std::stable_sort(stops.begin(), stops.end(), [](const ColorStop& a, const ColorStop& b) { return a.position < b.position; });
  int row = static_cast<int>(rampData_.size() / (kRampWidth * 4));
  for (int i = 0; i < kRampWidth; i++) {
    double t = i / double(kRampWidth - 1);
    float c[4] = {0, 0, 0, 0};
    if (!stops.empty()) {
      size_t k = 0;
      while (k < stops.size() && stops[k].position < t) k++;
      const ColorStop& a = stops[k == 0 ? 0 : k - 1];
      const ColorStop& b = stops[k >= stops.size() ? stops.size() - 1 : k];
      double span = b.position - a.position;
      double f = span > 1e-9 ? std::clamp((t - a.position) / span, 0.0, 1.0) : 0;
      if (k == 0) f = 0;
      // Interpolated premultiplied (CSS gradients).
      float pa[4], pb[4];
      premultiply(pa, a.color, 1);
      premultiply(pb, b.color, 1);
      for (int j = 0; j < 4; j++) c[j] = static_cast<float>(pa[j] + (pb[j] - pa[j]) * f);
    }
    for (int j = 0; j < 4; j++) rampData_.push_back(static_cast<uint8_t>(std::clamp(c[j], 0.f, 1.f) * 255.f + 0.5f));
  }
  rampRows_[h.h] = row;
  return row;
}

bool Renderer::setPaint(DrawInstance& q, DrawState& state, const Paint& paint, const Mat2x3& localToNode, Vec2 nodeSize, double alpha) {
  if (!paint.visible || paint.type == PaintType::OTHER) return false;
  double a = alpha * paint.opacity;
  if (a <= 0) return false;
  uint32_t flags = static_cast<uint32_t>(q.geom[3]) & 0xff;
  PaintKind kind = PaintKind::Solid;
  if (paint.type == PaintType::SOLID) {
    premultiply(q.color, paint.color, a);
  } else if (paint.isGradient()) {
    if (paint.stops.empty()) return false;
    Mat2x3 P = paint.transform * Mat2x3{1 / std::max(nodeSize.x, 1e-9), 0, 0, 0, 1 / std::max(nodeSize.y, 1e-9), 0} * localToNode;
    q.color[0] = q.color[1] = q.color[2] = q.color[3] = static_cast<float>(a);
    q.paint0[0] = static_cast<float>(P.m00), q.paint0[1] = static_cast<float>(P.m01), q.paint0[2] = static_cast<float>(P.m02);
    q.paint1[0] = static_cast<float>(P.m10), q.paint1[1] = static_cast<float>(P.m11), q.paint1[2] = static_cast<float>(P.m12);
    q.paint1[3] = static_cast<float>(rampRow(paint.stops));
    kind = paint.type == PaintType::GRADIENT_LINEAR    ? PaintKind::Linear
           : paint.type == PaintType::GRADIENT_RADIAL  ? PaintKind::Radial
           : paint.type == PaintType::GRADIENT_ANGULAR ? PaintKind::Angular
                                                       : PaintKind::Diamond;
  } else if (paint.type == PaintType::IMAGE) {
    bool failed = false;
    ImageCache::Texture t = images_.texture(paint.image, &failed);
    if (!t.id) {
      // Loading (or missing): Figma's grey.
      premultiply(q.color, Color::hex(0xE6E6E6), a);
    } else {
      double iw = t.width, ih = t.height;
      Mat2x3 P = imageMatrix(paint, nodeSize, iw, ih) * localToNode;
      q.color[0] = q.color[1] = q.color[2] = q.color[3] = static_cast<float>(a);
      q.paint0[0] = static_cast<float>(P.m00), q.paint0[1] = static_cast<float>(P.m01), q.paint0[2] = static_cast<float>(P.m02);
      q.paint1[0] = static_cast<float>(P.m10), q.paint1[1] = static_cast<float>(P.m11), q.paint1[2] = static_cast<float>(P.m12);
      q.paint0[3] = paint.imageScaleMode == ImageScaleMode::TILE ? 1.f : 0.f;
      state.image = t.id;
      const PaintFilter& f = paint.paintFilter;
      float filters[8] = {f.exposure, f.contrast, f.vibrance, f.temperature, f.tint, f.highlights, f.shadows, 0};
      std::memcpy(state.filters, filters, sizeof filters);
      kind = PaintKind::Image;
    }
  }
  q.geom[3] = drawFlags(flags, kind);
  return true;
}

void Renderer::emitPath(const CurveEntry* entry, const Mat2x3& m, bool evenOdd, const Paint& paint, Vec2 nodeSize, double alpha,
                        const CurveEntry* clip, bool clipSubtract, bool clipEvenOdd, Pass pass) {
  if (!entry) return;
  DrawInstance q{};
  setLinear(q, m);
  q.origin[2] = static_cast<float>(entry->start);
  q.origin[3] = clip ? static_cast<float>(clip->start) : -1.f;
  for (int i = 0; i < 4; i++) q.box[i] = entry->bounds[i];
  q.geom[2] = static_cast<float>(ShapeKind::Path);
  uint32_t flags = evenOdd ? DF_EVEN_ODD : 0;
  if (clip) flags |= (clipSubtract ? DF_CLIP_SUBTRACT : DF_CLIP_INTERSECT) | (clipEvenOdd ? DF_CLIP_EVEN_ODD : 0);
  q.geom[3] = static_cast<float>(flags);
  DrawState state;
  if (pass == Pass::Path || pass == Pass::PathClipped) {
    if (!setPaint(q, state, paint, Mat2x3{}, nodeSize, alpha)) return;
  }
  emit(q, pass, state);
}

double Renderer::levelScale(const Mat2x3& m) const {
  return std::sqrt(std::fabs(m.determinant())) * std::sqrt(viewport_.scaleX() * viewport_.scaleY());
}

namespace {

// The zoom level a path is approximated for (re-made when the scale crosses a power of two) and its tolerance.
int levelOf(double deviceScale) {
  if (!(deviceScale > 0)) return 0;
  return std::clamp(static_cast<int>(std::ceil(std::log2(deviceScale))), -10, 14);
}
double toleranceOf(int level) { return 0.2 / std::ldexp(1.0, level); }

}  // namespace

void Renderer::drawFills(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m, double alpha, bool whiteMask) {
  std::vector<Paint> white;
  if (whiteMask) white.push_back(Paint::solid(Color{1, 1, 1, 1}));
  const std::vector<Paint>& fills = whiteMask ? white : p.fillPaints;
  if (!anyVisible(fills) && p.type != NodeType::VECTOR) return;
  bool sdf = !p.isPathShape() && (p.isRectLike() || p.isFrameLike() || p.type == NodeType::ELLIPSE);
  if (sdf) {
    ShapeKind kind = p.type == NodeType::ELLIPSE ? ShapeKind::Ellipse : ShapeKind::Rect;
    CornerRadii radii = kind == ShapeKind::Rect ? geom::clampRadii(p.size, p.cornerRadii) : kSquare;
    for (const Paint& f : fills)
      blendedPaint(f, m, p.size, alpha, [&](double a) {
        DrawInstance q = makeShape(m, p.size, kind, radii, Color{}, 1, Color{}, 0, 0, 0);
        DrawState state;
        if (setPaint(q, state, f, Mat2x3{}, p.size, a)) emit(q, Pass::Shape, state);
      });
    return;
  }
  const NodeGeometry* g = doc.geometry(id);
  if (!g) return;
  int level = levelOf(levelScale(m));
  double tol = toleranceOf(level);
  for (size_t r = 0; r < g->fills.size(); r++) {
    const geom::FillRegion& region = g->fills[r];
    const std::vector<Paint>* paints = &fills;
    if (!whiteMask && region.styleID) {
      const VectorStyle* st = p.vectorData.style(region.styleID);
      if (st && (st->mask & VS_FILLS)) paints = &st->fillPaints;
    }
    if (!anyVisible(*paints)) continue;
    uint64_t key = Hash().add(g->fillKey).add(r).add(level).add(0xF111ull).h;
    const CurveEntry* entry = curves_.path(key, [&](std::vector<float>& out) { geom::toQuads(region.path, tol, out); });
    for (const Paint& f : *paints)
      blendedPaint(f, m, p.size, alpha, [&](double a) { emitPath(entry, m, region.windingRule == WindingRule::ODD, f, p.size, a); });
  }
}

void Renderer::drawStrokes(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m, double alpha) {
  if (!(p.strokeWeight > 0) || !anyVisible(p.strokePaints)) return;
  bool independent = p.borderStrokeWeightsIndependent && (p.isRectLike() || p.isFrameLike());
  // A dashed frame stroke (a component set's) goes through the stroker like a dashed rectangle's.
  bool dashedFrame = p.isFrameLike() && !p.dashPattern.empty();
  bool sdf = !p.isPathShape() && !independent && !dashedFrame && (p.isRectLike() || p.isFrameLike() || p.type == NodeType::ELLIPSE);
  if (sdf) {
    ShapeKind kind = p.type == NodeType::ELLIPSE ? ShapeKind::Ellipse : ShapeKind::Rect;
    CornerRadii radii = kind == ShapeKind::Rect ? geom::clampRadii(p.size, p.cornerRadii) : kSquare;
    double w = p.strokeWeight, inner = 0, outer = 0;
    switch (p.strokeAlign) {
      case StrokeAlign::INSIDE: inner = w; break;
      case StrokeAlign::OUTSIDE: outer = w; break;
      default: inner = outer = w / 2;
    }
    for (const Paint& s : p.strokePaints) {
      DrawInstance q = makeShape(m, p.size, kind, radii, Color{}, 0, Color{}, 1, inner, outer);
      q.geom[3] = drawFlags(DF_STROKE, PaintKind::Solid);
      DrawState state;
      if (!setPaint(q, state, s, Mat2x3{}, p.size, alpha)) continue;
      emit(q, Pass::Shape, state);
    }
    return;
  }
  int level = levelOf(levelScale(m));
  double tol = toleranceOf(level);
  if (independent) {
    // Per-side weights: the ring between the box and the box inset by each side's weight (aligned as asked).
    const auto& bw = p.borderWeights;  // top, right, bottom, left
    double k0 = p.strokeAlign == StrokeAlign::INSIDE ? 0 : p.strokeAlign == StrokeAlign::OUTSIDE ? 1 : 0.5;
    double t = bw[0], r = bw[1], b = bw[2], l = bw[3];
    Rect outerBox{-l * k0, -t * k0, p.size.x + (l + r) * k0, p.size.y + (t + b) * k0};
    Rect innerBox{outerBox.x + l, outerBox.y + t, outerBox.w - l - r, outerBox.h - t - b};
    uint64_t key = Hash().add(p.size.x).add(p.size.y).add(t).add(r).add(b).add(l).add(k0).add(p.cornerRadii).add(level).add(0xB0ull).h;
    const CurveEntry* entry = curves_.path(key, [&](std::vector<float>& out) {
      CornerRadii radii = geom::clampRadii(p.size, p.cornerRadii);
      geom::Path ring = geom::rectPath({outerBox.w, outerBox.h}, radii).transformed(Mat2x3::translate(outerBox.x, outerBox.y));
      if (innerBox.w > 0 && innerBox.h > 0) {
        CornerRadii ir;
        for (size_t i = 0; i < 4; i++) ir[i] = std::max(0.0, radii[i] - std::max(t, l));
        ring.append(geom::rectPath({innerBox.w, innerBox.h}, ir).transformed(Mat2x3::translate(innerBox.x, innerBox.y)).reversed());
      }
      geom::toQuads(ring, tol, out);
    });
    for (const Paint& s : p.strokePaints) emitPath(entry, m, false, s, p.size, alpha);
    return;
  }
  const NodeGeometry* g = doc.geometry(id);
  if (!g || g->stroke.path.empty()) return;
  bool closedArea = !g->fills.empty() && !g->hasOpenEnds;
  bool aligned = closedArea && p.strokeAlign != StrokeAlign::CENTER;
  geom::StrokeStyle style;
  style.width = p.strokeWeight * (aligned ? 2 : 1);
  style.join = p.strokeJoin;
  style.miterLimit = p.miterLimit;
  style.cap = p.strokeCap;
  style.dashes = p.dashPattern;
  style.caps = g->stroke.caps.empty() ? nullptr : &g->stroke.caps;
  Hash h;
  h.add(g->strokeKey).add(style.width).add(style.join).add(style.miterLimit).add(style.cap).add(level).add(0x57ull);
  for (double d : style.dashes) h.add(d);
  const CurveEntry* entry =
      curves_.path(h.h, [&](std::vector<float>& out) { geom::toQuads(geom::strokePath(g->stroke.path, style, tol), tol, out); });
  const CurveEntry* clip = nullptr;
  bool clipOdd = false;
  if (aligned) {
    uint64_t ck = Hash().add(g->fillKey).add(level).add(0xC11Full).h;
    clipOdd = g->fills.size() == 1 && g->fills[0].windingRule == WindingRule::ODD;
    clip = curves_.path(ck, [&](std::vector<float>& out) {
      for (auto& f : g->fills) geom::toQuads(f.path, tol, out);
    });
  }
  for (const Paint& s : p.strokePaints)
    emitPath(entry, m, false, s, p.size, alpha, clip, p.strokeAlign == StrokeAlign::OUTSIDE, clipOdd);
}

namespace {

// Whether a node's shadows can be drawn analytically: a rectangle or frame without smoothing, with an
// opaque solid fill hiding what is under it (and a frame clipping its children to it).
bool analyticShadows(const Document& doc, Guid id, const NodeProps& p) {
  if (!(p.isRectLike() || p.isFrameLike()) || p.cornerSmoothing > 0) return false;
  bool opaque = false;
  for (auto& f : p.fillPaints)
    opaque |= f.visible && f.type == PaintType::SOLID && f.opacity >= 1 && f.color.a >= 1 &&
              (f.blendMode == BlendMode::NORMAL || f.blendMode == BlendMode::PASS_THROUGH);
  if (!opaque) return false;
  if (p.isFrameLike() && !p.clipsContent() && !doc.children(id).empty()) return false;
  for (auto& e : p.effects)
    if (e.visible && e.isShadow() && e.blendMode != BlendMode::NORMAL && e.blendMode != BlendMode::PASS_THROUGH) return false;
  return true;
}

// A shadow's offset in the node's own space, so it falls the same way on screen however the node is turned.
Vec2 localOffset(const Mat2x3& m, Vec2 offset) {
  double s = std::sqrt(std::fabs(m.determinant()));
  Mat2x3 lin = m;
  lin.m02 = lin.m12 = 0;
  return lin.inverse().apply(offset * s);
}

}  // namespace

void Renderer::drawAnalyticShadows(const NodeProps& p, const Mat2x3& m, double alpha, bool inner) {
  CornerRadii radii = geom::clampRadii(p.size, p.cornerRadii);
  for (const Effect& e : p.effects) {
    if (!e.visible || (inner ? e.type != EffectType::INNER_SHADOW : e.type != EffectType::DROP_SHADOW)) continue;
    double sigma = std::max(0.0, e.radius / 2);
    Vec2 off = localOffset(m, e.offset);
    if (!inner) {
      double s = e.spread;
      Vec2 size{p.size.x + 2 * s, p.size.y + 2 * s};
      if (size.x <= 0 || size.y <= 0) continue;
      CornerRadii r;
      for (size_t i = 0; i < 4; i++) r[i] = radii[i] > 0 ? std::max(0.0, radii[i] + s) : 0;
      DrawInstance q = makeShape(m * Mat2x3::translate(off.x - s, off.y - s), size, ShapeKind::DropShadow, r, e.color, alpha, Color{}, 0, 0, 0);
      q.geom[0] = static_cast<float>(sigma);
      q.geom[1] = 0;
      q.geom[2] = static_cast<float>(ShapeKind::DropShadow);
      emit(q, Pass::Shape);
    } else {
      DrawInstance q = makeShape(m, p.size, ShapeKind::InnerShadow, radii, e.color, alpha, Color{}, 0, 0, 0);
      q.geom[0] = static_cast<float>(sigma);
      q.geom[1] = static_cast<float>(e.spread);
      q.geom[2] = static_cast<float>(ShapeKind::InnerShadow);
      q.paint0[0] = static_cast<float>(off.x);
      q.paint0[1] = static_cast<float>(off.y);
      emit(q, Pass::Shape);
    }
  }
}

void Renderer::drawBackgroundBlur(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m, double alpha, const Effect& e) {
  double scale = levelScale(m);
  double sigma = std::max(0.0, e.radius / 2) * scale;
  if (sigma <= 0.01) return;
  Rect own = transformedBounds(m, p.size.x, p.size.y);
  gfx::IRect r = deviceRect(own, 3 * sigma + 2);
  r = intersect(r, layers_[static_cast<size_t>(current_)].rect);
  if (r.w <= 0 || r.h <= 0) return;
  int b = static_cast<int>(backdrops_.size());
  backdrops_.push_back({0, r, {0, 0, 1, 1}});
  Cmd c;
  c.kind = Cmd::Kind::BackdropBlur;
  c.rect = r;
  c.sigma = sigma;
  c.layer = b;
  layers_[static_cast<size_t>(current_)].cmds.push_back(c);
  // The node's shape, painted with the blurred backdrop.
  DrawState state;
  state.backdrop = b;
  bool sdf = !p.isPathShape() && (p.isRectLike() || p.isFrameLike() || p.type == NodeType::ELLIPSE);
  if (sdf) {
    ShapeKind kind = p.type == NodeType::ELLIPSE ? ShapeKind::Ellipse : ShapeKind::Rect;
    DrawInstance q = makeShape(m, p.size, kind, kind == ShapeKind::Rect ? geom::clampRadii(p.size, p.cornerRadii) : kSquare,
                               Color{1, 1, 1, 1}, alpha, Color{}, 0, 0, 0);
    q.geom[3] = drawFlags(0, PaintKind::Backdrop);
    emit(q, Pass::Shape, state);
    return;
  }
  const NodeGeometry* g = doc.geometry(id);
  if (!g) return;
  int level = levelOf(levelScale(m));
  double tol = toleranceOf(level);
  for (size_t i = 0; i < g->fills.size(); i++) {
    uint64_t key = Hash().add(g->fillKey).add(i).add(level).add(0xF111ull).h;
    const CurveEntry* entry = curves_.path(key, [&](std::vector<float>& out) { geom::toQuads(g->fills[i].path, tol, out); });
    if (!entry) continue;
    DrawInstance q{};
    setLinear(q, m);
    q.origin[2] = static_cast<float>(entry->start);
    q.origin[3] = -1;
    for (int k = 0; k < 4; k++) q.box[k] = entry->bounds[k];
    q.geom[2] = static_cast<float>(ShapeKind::Path);
    q.geom[3] = drawFlags(g->fills[i].windingRule == WindingRule::ODD ? DF_EVEN_ODD : 0, PaintKind::Backdrop);
    q.color[0] = q.color[1] = q.color[2] = q.color[3] = static_cast<float>(alpha);
    emit(q, Pass::Path, state);
  }
}

void Renderer::pushClip(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m) {
  bool square = p.cornerRadii[0] <= 0 && p.cornerRadii[1] <= 0 && p.cornerRadii[2] <= 0 && p.cornerRadii[3] <= 0;
  Clip clip{false, scissorEnabled_, scissor_, {}, false};
  if (square && nearlyAxisAligned(m)) {
    // Axis-aligned and square: a scissor rect, intersected with the current one.
    Rect r = transformedBounds(m, p.size.x, p.size.y);
    double sx = viewport_.scaleX(), sy = viewport_.scaleY();
    // Every pixel the frame touches: its children's anti-aliased edges are not cut off.
    int x0 = static_cast<int>(std::floor(r.x * sx)), y0 = static_cast<int>(std::floor(r.y * sy));
    int x1 = static_cast<int>(std::ceil(r.right() * sx)), y1 = static_cast<int>(std::ceil(r.bottom() * sy));
    if (scissorEnabled_) {
      x0 = std::max(x0, scissor_.x);
      y0 = std::max(y0, scissor_.y);
      x1 = std::min(x1, scissor_.x + scissor_.w);
      y1 = std::min(y1, scissor_.y + scissor_.h);
    }
    scissorEnabled_ = true;
    scissor_ = {x0, y0, std::max(0, x1 - x0), std::max(0, y1 - y0)};
  } else if (p.cornerSmoothing > 0) {
    // Smoothed corners: the path into the stencil.
    clip.stencil = true;
    clip.path = true;
    const NodeGeometry* g = doc.geometry(id);
    int level = levelOf(levelScale(m));
    if (g && !g->fills.empty()) {
      uint64_t key = Hash().add(g->fillKey).add(size_t{0}).add(level).add(0xF111ull).h;
      double tol = toleranceOf(level);
      const CurveEntry* entry = curves_.path(key, [&](std::vector<float>& out) { geom::toQuads(g->fills[0].path, tol, out); });
      if (entry) {
        DrawInstance q{};
        setLinear(q, m);
        q.origin[2] = static_cast<float>(entry->start);
        q.origin[3] = -1;
        for (int k = 0; k < 4; k++) q.box[k] = entry->bounds[k];
        q.geom[2] = static_cast<float>(ShapeKind::Path);
        clip.shape = q;
      }
    }
    emit(clip.shape, Pass::PathStencilInc);
    stencilDepth_++;
  } else {
    // Rounded or turned: the shape's fill into the stencil, one level deeper.
    clip.stencil = true;
    clip.shape = makeShape(m, p.size, ShapeKind::Rect, geom::clampRadii(p.size, p.cornerRadii), Color{1, 1, 1, 1}, 1, Color{}, 0, 0, 0);
    emit(clip.shape, Pass::ShapeStencilInc);
    stencilDepth_++;
  }
  clips_.push_back(clip);
}

void Renderer::popClip() {
  Clip clip = clips_.back();
  clips_.pop_back();
  if (clip.stencil) {
    stencilDepth_--;
    emit(clip.shape, clip.path ? Pass::PathStencilDec : Pass::ShapeStencilDec);
  }
  scissorEnabled_ = clip.scissorEnabled;
  scissor_ = clip.scissor;
}

gfx::IRect Renderer::deviceRect(const Rect& css, double margin) const {
  double sx = viewport_.scaleX(), sy = viewport_.scaleY();
  double x0 = css.x * sx - margin, y0 = css.y * sy - margin, x1 = css.right() * sx + margin, y1 = css.bottom() * sy + margin;
  // What can matter: the viewport, plus the margin (blurs read past the edge).
  double vx0 = -margin, vy0 = -margin, vx1 = viewport_.deviceWidth() + margin, vy1 = viewport_.deviceHeight() + margin;
  x0 = std::max(x0, vx0), y0 = std::max(y0, vy0), x1 = std::min(x1, vx1), y1 = std::min(y1, vy1);
  if (x1 <= x0 || y1 <= y0) return {0, 0, 0, 0};
  int ix0 = static_cast<int>(std::floor(x0)), iy0 = static_cast<int>(std::floor(y0));
  int ix1 = static_cast<int>(std::ceil(x1)), iy1 = static_cast<int>(std::ceil(y1));
  // Large layers are capped (the device's texture size).
  int cap = static_cast<int>(device_.caps().maxTextureSize);
  return {ix0, iy0, std::min(ix1 - ix0, cap), std::min(iy1 - iy0, cap)};
}

Rect Renderer::visualBounds(const Document& doc, Guid id, const Mat2x3& m, int depth) const {
  const Node* n = doc.get(id);
  if (!n) return {};
  const NodeProps& p = n->props;
  double scale = std::sqrt(std::fabs(m.determinant()));
  Rect own = transformedBounds(m, p.size.x, p.size.y);
  // The outside of strokes and effects (Document::renderBounds' outset, in this space).
  Rect world = doc.renderBounds(id), box = doc.worldBounds(id);
  double grow = std::max({box.x - world.x, world.right() - box.right(), box.y - world.y, world.bottom() - box.bottom(), 0.0});
  double worldScale = std::sqrt(std::fabs(doc.worldTransform(id).determinant()));
  double g = worldScale > 0 ? grow / worldScale * scale : 0;
  own = {own.x - g, own.y - g, own.w + 2 * g, own.h + 2 * g};
  bool group = p.fitsChildren() && !p.isBoolean();
  if ((p.isFrameLike() && !p.clipsContent()) || group) {
    bool any = !group;
    Rect u = group ? Rect{} : own;
    if (depth < 64)
      for (Guid c : doc.children(id)) {
        const Node* cn = doc.get(c);
        if (!cn || !cn->props.visible) continue;
        Rect cb = visualBounds(doc, c, m * cn->props.transform, depth + 1);
        u = any ? u.united(cb) : cb;
        any = true;
      }
    if (group) {
      // A group's own effects reach past its children.
      u = {u.x - g, u.y - g, u.w + 2 * g, u.h + 2 * g};
      return any ? u : own;
    }
    return u;
  }
  return own;
}

int Renderer::beginLayer(gfx::IRect rect) {
  int saved = current_;
  Layer L;
  L.rect = rect;
  layers_.push_back(std::move(L));
  current_ = static_cast<int>(layers_.size() - 1);
  // A layer starts unclipped (its parent's clip applies when it is composited).
  clips_.push_back({false, scissorEnabled_, scissor_, {}, false});
  scissorEnabled_ = false;
  stencilDepth_ = 0;
  return saved;
}

void Renderer::endLayer(int saved) {
  Clip c = clips_.back();
  clips_.pop_back();
  scissorEnabled_ = c.scissorEnabled;
  scissor_ = c.scissor;
  // The parent's stencil depth: count the stencil clips still open below.
  stencilDepth_ = 0;
  for (auto& k : clips_) stencilDepth_ += k.stencil ? 1 : 0;
  current_ = saved;
}

void Renderer::drawChildren(const Document& doc, const std::vector<Guid>& kids, size_t from, const Mat2x3& m, double alpha) {
  for (size_t i = from; i < kids.size(); i++) {
    const Node* n = doc.get(kids[i]);
    if (!n) continue;
    if (n->props.mask && n->props.visible) {
      // A mask: it masks the layers above it in this parent (and is not drawn itself).
      Mat2x3 mm = m * n->props.transform;
      Rect mb = visualBounds(doc, kids[i], mm);
      gfx::IRect r = deviceRect(mb, 2);
      if (r.w <= 0 || r.h <= 0 || i + 1 >= kids.size()) return;
      int saved = beginLayer(r);
      int M = current_;
      if (n->props.maskType == MaskType::OUTLINE) {
        // The mask's geometry, opaque.
        drawFills(doc, kids[i], n->props, mm, 1, true);
        if (n->props.fitsChildren()) drawChildren(doc, doc.children(kids[i]), 0, mm, 1);
      } else {
        drawNode(doc, kids[i], m, 1);
      }
      endLayer(saved);
      int saved2 = beginLayer(r);
      int C = current_;
      drawChildren(doc, kids, i + 1, m, 1);
      endLayer(saved2);
      Cmd c;
      c.kind = Cmd::Kind::Composite;
      c.pass = stencilDepth_ > 0 ? Pass::CompositeClipped : Pass::Composite;
      c.stencilRef = stencilDepth_;
      c.scissorEnabled = scissorEnabled_;
      c.scissor = scissor_;
      c.layer = C;
      c.aux = M;
      c.mode = n->props.maskType == MaskType::LUMINANCE ? 2 : 1;
      c.opacity = static_cast<float>(alpha);
      c.rect = r;
      layers_[static_cast<size_t>(current_)].cmds.push_back(c);
      return;
    }
    drawNode(doc, kids[i], m, alpha);
  }
}

void Renderer::drawContent(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m, double alpha, bool analytic) {
  if (analytic) drawAnalyticShadows(p, m, alpha, false);
  if (p.type == NodeType::TEXT) {
    drawText(doc, p, id, m, alpha);
    drawStrokes(doc, id, p, m, alpha);
    return;
  }
  if (p.isBoolean()) {
    drawFills(doc, id, p, m, alpha);
    drawStrokes(doc, id, p, m, alpha);
    return;
  }
  if (p.isGroupLike()) {
    drawChildren(doc, doc.children(id), 0, m, alpha);
    return;
  }
  drawFills(doc, id, p, m, alpha);
  if (analytic) drawAnalyticShadows(p, m, alpha, true);
  if (p.isFrameLike()) {
    const auto& kids = doc.children(id);
    bool clips = p.clipsContent();
    bool grids = false;
    for (auto& g : p.layoutGrids) grids |= g.visible;
    if (!kids.empty() || grids) {
      if (clips) pushClip(doc, id, p, m);
      drawChildren(doc, kids, 0, m, alpha);
      if (grids) {
        // Layout guides over the frame's content (columns, rows, grid).
        for (const LayoutGrid& g : p.layoutGrids) {
          if (!g.visible) continue;
          bool x = g.axis == Axis::X;
          double len = x ? p.size.x : p.size.y, across = x ? p.size.y : p.size.x;
          auto band = [&](double a, double w) {
            if (w <= 0) return;
            Mat2x3 bm = x ? m * Mat2x3::translate(a, 0) : m * Mat2x3::translate(0, a);
            emit(makeShape(bm, x ? Vec2{w, across} : Vec2{across, w}, ShapeKind::Rect, kSquare, g.color, alpha, Color{}, 0, 0, 0), Pass::Shape);
          };
          if (g.pattern == LayoutGridPattern::GRID) {
            double step = std::max(g.sectionSize, 1.0);
            double line = 1 / std::max(std::sqrt(std::fabs(m.determinant())), 1e-9);  // one CSS px
            for (double a = step; a < len; a += step) band(a, line);
            continue;
          }
          double gutter = g.gutterSize, size = g.sectionSize;
          int n = g.numSections;
          if (g.type == LayoutGridType::STRETCH) {
            if (n <= 0) n = 1;
            double w = (len - 2 * g.offset - gutter * (n - 1)) / n;
            for (int i = 0; i < n; i++) band(g.offset + i * (w + gutter), w);
          } else {
            if (n <= 0) n = std::max(1, static_cast<int>(std::floor((len - 2 * g.offset + gutter) / std::max(size + gutter, 1e-9))));
            double total = n * size + (n - 1) * gutter;
            double start = g.type == LayoutGridType::MIN ? g.offset : g.type == LayoutGridType::MAX ? len - g.offset - total : (len - total) / 2;
            for (int i = 0; i < n; i++) band(start + i * (size + gutter), size);
          }
        }
      }
      if (clips) popClip();
    }
  }
  // Strokes go over the fills (and over a frame's content).
  drawStrokes(doc, id, p, m, alpha);
}

void Renderer::compositeLayer(int src, int aux, int mode, float opacity, BlendMode bm, const Color& color, Vec2 offset, bool knockout,
                              gfx::IRect rect) {
  Cmd c;
  c.kind = Cmd::Kind::Composite;
  bool replace = bm != BlendMode::NORMAL && bm != BlendMode::PASS_THROUGH;
  c.pass = replace ? (stencilDepth_ > 0 ? Pass::CompositeReplaceClipped : Pass::CompositeReplace)
                   : (stencilDepth_ > 0 ? Pass::CompositeClipped : Pass::Composite);
  c.stencilRef = stencilDepth_;
  c.scissorEnabled = scissorEnabled_;
  c.scissor = scissor_;
  c.layer = src;
  c.aux = aux;
  c.mode = mode;
  c.opacity = opacity;
  c.blend = bm;
  c.color = color;
  c.offset = offset;
  c.knockout = knockout;
  c.rect = rect;
  layers_[static_cast<size_t>(current_)].cmds.push_back(c);
}

void Renderer::blendedPaint(const Paint& paint, const Mat2x3& m, Vec2 size, double alpha, const std::function<void(double)>& draw) {
  bool blend = paint.blendMode != BlendMode::NORMAL && paint.blendMode != BlendMode::PASS_THROUGH;
  if (!blend) return draw(alpha);
  // A paint with its own blend mode: drawn into a layer, blended onto what is below it.
  gfx::IRect r = deviceRect(transformedBounds(m, size.x, size.y), 2);
  if (r.w <= 0 || r.h <= 0) return;
  int saved = beginLayer(r);
  int L = current_;
  draw(1);
  endLayer(saved);
  stats_.layers++;
  compositeLayer(L, -1, 0, static_cast<float>(alpha), paint.blendMode, Color{}, {}, false, r);
}

void Renderer::drawNode(const Document& doc, Guid id, const Mat2x3& parentCss, double alpha) {
  const Node* n = doc.get(id);
  if (!n || !n->props.visible) return;
  const NodeProps& p = n->props;
  if (p.opacity <= 0 || alpha <= 0) return;
  Mat2x3 m = parentCss * p.transform;
  Rect vb = visualBounds(doc, id, m);
  Rect padded{vb.x - 2, vb.y - 2, vb.w + 4, vb.h + 4};
  if (!padded.intersects(screen_)) return;

  bool analytic = analyticShadows(doc, id, p);
  std::vector<const Effect*> drops, inners, backgrounds;
  double layerBlur = 0;
  for (const Effect& e : p.effects) {
    if (!e.visible) continue;
    if (e.type == EffectType::DROP_SHADOW) drops.push_back(&e);
    else if (e.type == EffectType::INNER_SHADOW) inners.push_back(&e);
    else if (e.type == EffectType::BACKGROUND_BLUR && e.radius > 0) backgrounds.push_back(&e);
    else if (e.type == EffectType::FOREGROUND_BLUR && e.radius > 0) layerBlur = std::max(layerBlur, e.radius);
  }
  bool generic = !analytic && (!drops.empty() || !inners.empty());
  bool container = (p.isFrameLike() || p.isGroupLike()) && !doc.children(id).empty();
  size_t paints = 0;
  for (auto& f : p.fillPaints) paints += f.visible ? 1 : 0;
  if (p.strokeWeight > 0)
    for (auto& s : p.strokePaints) paints += s.visible ? 1 : 0;
  bool blend = p.blendMode != BlendMode::PASS_THROUGH && p.blendMode != BlendMode::NORMAL;
  bool opacityLayer = p.opacity < 1 && (container || paints > 1 || p.type == NodeType::TEXT || generic);
  bool needsLayer = opacityLayer || blend || layerBlur > 0 || generic;
  double a = alpha * p.opacity;

  for (const Effect* e : backgrounds) drawBackgroundBlur(doc, id, p, m, a, *e);
  if (!needsLayer) {
    drawContent(doc, id, p, m, a, analytic);
    return;
  }
  stats_.layers++;
  double scale = levelScale(m);
  double blurSigma = layerBlur / 2 * scale;
  gfx::IRect r = deviceRect(vb, 3 * blurSigma + 2);
  if (r.w <= 0 || r.h <= 0) return;
  int saved = beginLayer(r);
  int C = current_;
  drawContent(doc, id, p, m, 1, analytic);
  endLayer(saved);
  layers_[static_cast<size_t>(C)].blur = blurSigma;

  auto composite = [&](int src, int aux, int mode, float opacity, BlendMode bm, const Color& color, Vec2 offset, bool knockout,
                       gfx::IRect rect) { compositeLayer(src, aux, mode, opacity, bm, color, offset, knockout, rect); };
  auto shadowLayer = [&](const Effect& e, double morph) {
    double sigma = std::max(0.0, e.radius / 2) * scale;
    double spread = e.spread * scale;
    double grow = 3 * sigma + std::max(0.0, morph) + 2;
    gfx::IRect sr{r.x - static_cast<int>(std::ceil(grow)), r.y - static_cast<int>(std::ceil(grow)),
                  r.w + 2 * static_cast<int>(std::ceil(grow)), r.h + 2 * static_cast<int>(std::ceil(grow))};
    Layer S;
    S.rect = sr;
    S.copyOf = C;
    S.blur = sigma;
    S.morph = morph != 0 ? (morph > 0 ? spread : -std::fabs(spread)) : 0;
    layers_.push_back(std::move(S));
    stats_.layers++;
    return static_cast<int>(layers_.size() - 1);
  };
  auto deviceOffset = [&](Vec2 o) { return Vec2{o.x * std::sqrt(std::fabs(m.determinant())) * viewport_.scaleX(), o.y * std::sqrt(std::fabs(m.determinant())) * viewport_.scaleY()}; };
  if (generic) {
    for (const Effect* e : drops) {
      int S = shadowLayer(*e, e->spread);
      Vec2 off = deviceOffset(e->offset);
      gfx::IRect q = layers_[static_cast<size_t>(S)].rect;
      q.x += static_cast<int>(std::floor(off.x));
      q.y += static_cast<int>(std::floor(off.y));
      q.w += 2;
      q.h += 2;
      Color premul = e->color;
      composite(S, C, 3, static_cast<float>(a), BlendMode::NORMAL, premul, off, !e->showShadowBehindNode, q);
    }
  }
  composite(C, -1, 0, static_cast<float>(a), p.blendMode, Color{}, {}, false, r);
  if (generic) {
    for (const Effect* e : inners) {
      int S = shadowLayer(*e, e->spread != 0 ? -1 : 0);
      composite(S, C, 4, static_cast<float>(a), BlendMode::NORMAL, e->color, deviceOffset(e->offset), false, r);
    }
  }
}

// ---- Execution ---------------------------------------------------------------------------------

void Renderer::rows(float out[2][4], double sx, double sy, int ox, int oy, int w, int h) const {
  double W = std::max(1, w), H = std::max(1, h);
  out[0][0] = static_cast<float>(2 * sx / W);
  out[0][1] = 0;
  out[0][2] = static_cast<float>(-2.0 * ox / W - 1);
  out[0][3] = 0;
  out[1][0] = 0;
  out[1][1] = static_cast<float>(-2 * sy / H);
  out[1][2] = static_cast<float>(2.0 * oy / H + 1);
  out[1][3] = 0;
}

Renderer::PoolTarget* Renderer::acquire(int w, int h) {
  int bw = roundUp(w, 64), bh = roundUp(h, 64);
  for (auto& t : pool_)
    if (!t.busy && t.w == bw && t.h == bh) {
      t.busy = true;
      t.lastUsed = frame_;
      return &t;
    }
  gfx::TargetId id = device_.createTarget(static_cast<uint32_t>(bw), static_cast<uint32_t>(bh));
  if (!id) return nullptr;
  PoolTarget t;
  t.target = id;
  t.texture = device_.targetTexture(id);
  t.w = bw;
  t.h = bh;
  t.busy = true;
  t.lastUsed = frame_;
  pool_.push_back(t);
  return &pool_.back();
}

void Renderer::release(gfx::TargetId target) {
  for (auto& t : pool_)
    if (t.target == target) t.busy = false;
}

namespace {

void compositeUniforms(gfx::DrawCall& call, const float r[2][4], gfx::IRect quad) {
  for (int i = 0; i < 4; i++) call.uniforms[0][i] = r[0][i], call.uniforms[1][i] = r[1][i];
  call.uniforms[2][0] = static_cast<float>(quad.x);
  call.uniforms[2][1] = static_cast<float>(quad.y);
  call.uniforms[2][2] = static_cast<float>(quad.x + quad.w);
  call.uniforms[2][3] = static_cast<float>(quad.y + quad.h);
}

void place(float out[4], double ox, double oy, double contentH, double scale) {
  out[0] = static_cast<float>(ox);
  out[1] = static_cast<float>(oy);
  out[2] = static_cast<float>(contentH);
  out[3] = static_cast<float>(scale);
}

}  // namespace

void Renderer::blurLayer(Layer& L) {
  if (L.blur <= 0.01 && L.morph == 0) return;
  // Work in the layer's own device frame: (0, 0) = its top left.
  int w = L.rect.w, h = L.rect.h;
  PoolTarget* cur = nullptr;
  for (auto& t : pool_)
    if (t.target == L.target) cur = &t;
  if (!cur) return;
  auto pass = [&](PoolTarget* dst, int vw, int vh) {
    gfx::PassDesc pd;
    pd.target = dst->target;
    pd.clear[0] = pd.clear[1] = pd.clear[2] = pd.clear[3] = 0;
    pd.viewport = {0, 0, vw, vh};
    return device_.beginPass(pd);
  };
  auto blurPass = [&](PoolTarget* src, PoolTarget* dst, int vw, int vh, float dx, float dy, float sigma, int mode, float radius) {
    if (!pass(dst, vw, vh)) return;
    gfx::DrawCall call;
    call.pipeline = pipelines_[static_cast<int>(Pass::Blur)];
    call.instanceCount = 1;
    call.uniforms[2][0] = dx, call.uniforms[2][1] = dy, call.uniforms[2][2] = sigma, call.uniforms[2][3] = static_cast<float>(mode);
    call.uniforms[3][0] = radius;
    call.textures[0] = src->texture;
    device_.draw(call);
    stats_.drawCalls++;
    device_.endPass();
  };
  // Spread: dilate / erode at full size.
  if (L.morph != 0) {
    PoolTarget* tmp = acquire(w, h);
    if (tmp && tmp->w == cur->w && tmp->h == cur->h) {
      int mode = L.morph > 0 ? 1 : 2;
      float r = static_cast<float>(std::fabs(L.morph));
      blurPass(cur, tmp, w, h, 1, 0, 0, mode, r);
      blurPass(tmp, cur, w, h, 0, 1, 0, mode, r);
    }
    if (tmp) release(tmp->target);
  }
  double sigma = L.blur, scale = 1;
  int cw = w, ch = h;
  // Large blurs: halve the image until σ ≤ 8 texels (at most 32×), then blur, then let the composite upsample.
  while (sigma * scale > 8 && scale > 1.0 / 32) {
    int nw = std::max(1, (cw + 1) / 2), nh = std::max(1, (ch + 1) / 2);
    PoolTarget* down = acquire(nw, nh);
    if (!down || !pass(down, nw, nh)) break;
    gfx::DrawCall call;
    call.pipeline = pipelines_[static_cast<int>(Pass::CompositeReplace)];
    call.instanceCount = 1;
    float r[2][4];
    rows(r, scale / 2, scale / 2, 0, 0, nw, nh);
    // rows() maps device px × (scale/2): here "device" is the layer's own px at full size.
    compositeUniforms(call, r, {0, 0, w, h});
    place(call.uniforms[3], 0, 0, ch, scale);
    call.uniforms[7][0] = 1;
    call.uniforms[7][1] = 1;
    call.textures[0] = cur->texture;
    call.textures[1] = call.textures[2] = white_;
    device_.draw(call);
    stats_.drawCalls++;
    device_.endPass();
    release(cur->target);
    cur = down;
    cw = nw, ch = nh;
    scale /= 2;
  }
  if (sigma * scale > 0.01) {
    PoolTarget* tmp = acquire(cw, ch);
    if (tmp && tmp->w == cur->w && tmp->h == cur->h) {
      blurPass(cur, tmp, cw, ch, 1, 0, static_cast<float>(sigma * scale), 0, 0);
      blurPass(tmp, cur, cw, ch, 0, 1, static_cast<float>(sigma * scale), 0, 0);
    }
    if (tmp) release(tmp->target);
  }
  L.target = cur->target;
  L.texture = cur->texture;
  L.scale = scale;
  L.contentH = ch;
}

void Renderer::runLayer(int index) {
  Layer& L0 = layers_[static_cast<size_t>(index)];
  if (L0.executed) return;
  L0.executed = true;
  // What it composites must exist first.
  if (L0.copyOf >= 0) runLayer(L0.copyOf);
  for (size_t i = 0; i < layers_[static_cast<size_t>(index)].cmds.size(); i++) {
    const Cmd c = layers_[static_cast<size_t>(index)].cmds[i];
    if (c.kind != Cmd::Kind::Composite) continue;
    if (c.layer >= 0) runLayer(c.layer);
    if (c.aux >= 0) runLayer(c.aux);
  }
  Layer& L = layers_[static_cast<size_t>(index)];
  if (L.rect.w <= 0 || L.rect.h <= 0) return;
  PoolTarget* t = acquire(L.rect.w, L.rect.h);
  if (!t) return;
  L.target = t->target;
  L.texture = t->texture;
  L.scale = 1;
  L.contentH = L.rect.h;
  const float transparent[4] = {0, 0, 0, 0};
  if (L.copyOf >= 0) {
    // A copy of another layer (to blur for a shadow).
    const Layer& src = layers_[static_cast<size_t>(L.copyOf)];
    gfx::PassDesc pd;
    pd.target = t->target;
    pd.viewport = {0, 0, L.rect.w, L.rect.h};
    for (int i = 0; i < 4; i++) pd.clear[i] = 0;
    if (device_.beginPass(pd) && src.texture) {
      gfx::DrawCall call;
      call.pipeline = pipelines_[static_cast<int>(Pass::CompositeReplace)];
      call.instanceCount = 1;
      float r[2][4];
      rows(r, 1, 1, L.rect.x, L.rect.y, L.rect.w, L.rect.h);
      compositeUniforms(call, r, L.rect);
      place(call.uniforms[3], src.rect.x, src.rect.y, src.contentH, src.scale);
      call.uniforms[7][0] = 1;
      call.uniforms[7][1] = 1;
      call.textures[0] = src.texture;
      call.textures[1] = call.textures[2] = white_;
      device_.draw(call);
      stats_.drawCalls++;
      device_.endPass();
    }
  } else {
    runCmds(L, t->target, {0, 0, L.rect.w, L.rect.h}, transparent);
  }
  blurLayer(layers_[static_cast<size_t>(index)]);
}

void Renderer::runCmds(Layer& L, gfx::TargetId target, gfx::IRect viewport, const float clear[4]) {
  gfx::PassDesc pd;
  pd.target = target;
  pd.viewport = viewport;
  for (int i = 0; i < 4; i++) pd.clear[i] = clear[i];
  if (!device_.beginPass(pd)) return;
  const int ox = L.rect.x, oy = L.rect.y, W = viewport.w, H = viewport.h;
  float cssRows[2][4], devRows[2][4];
  rows(cssRows, viewport_.scaleX(), viewport_.scaleY(), ox, oy, W, H);
  rows(devRows, 1, 1, ox, oy, W, H);
  auto localScissor = [&](gfx::DrawCall& call, const Cmd& c) {
    call.scissorEnabled = c.scissorEnabled;
    call.scissor = {c.scissor.x - ox, c.scissor.y - oy, c.scissor.w, c.scissor.h};
    call.stencilRef = c.stencilRef;
  };
  gfx::TextureId white = white_;
  for (const Cmd& c : L.cmds) {
    if (c.kind == Cmd::Kind::Draw) {
      bool path = c.pass == Pass::Path || c.pass == Pass::PathClipped || c.pass == Pass::PathStencilInc || c.pass == Pass::PathStencilDec;
      if (path && !curveTexture_) continue;
      gfx::DrawCall call;
      call.pipeline = pipelines_[static_cast<int>(c.pass)];
      call.instances = {buffer_, static_cast<uint32_t>(c.first * sizeof(DrawInstance)), static_cast<uint32_t>(c.count * sizeof(DrawInstance))};
      call.instanceCount = c.count;
      for (int i = 0; i < 4; i++) call.uniforms[0][i] = cssRows[0][i], call.uniforms[1][i] = cssRows[1][i];
      for (int i = 0; i < 4; i++) call.uniforms[2][i] = c.state.filters[i], call.uniforms[3][i] = c.state.filters[4 + i];
      call.textures[0] = curveTexture_ ? curveTexture_ : white;
      call.textures[1] = ramp_ ? ramp_ : white;
      call.textures[2] = c.state.image ? c.state.image : white;
      if (c.state.backdrop >= 0) {
        const BackdropBlur& b = backdrops_[static_cast<size_t>(c.state.backdrop)];
        if (!b.texture) continue;
        call.textures[2] = b.texture;
        for (int i = 0; i < 4; i++) call.uniforms[4][i] = b.place[i];
      }
      localScissor(call, c);
      device_.draw(call);
      stats_.drawCalls++;
    } else if (c.kind == Cmd::Kind::Composite) {
      const Layer& src = layers_[static_cast<size_t>(c.layer)];
      if (!src.texture) continue;
      gfx::IRect quad = intersect(c.rect, L.rect);
      if (quad.w <= 0 || quad.h <= 0) continue;
      gfx::DrawCall call;
      call.pipeline = pipelines_[static_cast<int>(c.pass)];
      call.instanceCount = 1;
      compositeUniforms(call, devRows, quad);
      place(call.uniforms[3], src.rect.x, src.rect.y, src.contentH, src.scale);
      call.textures[0] = src.texture;
      call.textures[1] = white;
      call.textures[2] = white;
      if (c.aux >= 0) {
        const Layer& aux = layers_[static_cast<size_t>(c.aux)];
        place(call.uniforms[4], aux.rect.x, aux.rect.y, aux.contentH, aux.scale);
        call.textures[1] = aux.texture ? aux.texture : white;
      }
      bool replace = c.pass == Pass::CompositeReplace || c.pass == Pass::CompositeReplaceClipped;
      if (replace) {
        // The backdrop under the quad, for the blend formulas.
        gfx::IRect local{quad.x - ox, quad.y - oy, quad.w, quad.h};
        PoolTarget* back = acquire(quad.w, quad.h);
        if (back) {
          device_.copyToTexture(back->texture, local);
          scratch_.push_back(back->target);
          place(call.uniforms[5], quad.x, quad.y, quad.h, 1);
          call.textures[2] = back->texture;
        }
      }
      premultiply(call.uniforms[6], c.color, 1);
      call.uniforms[7][0] = c.opacity;
      call.uniforms[7][1] = static_cast<float>(c.blend == BlendMode::PASS_THROUGH ? BlendMode::NORMAL : c.blend);
      call.uniforms[7][2] = static_cast<float>(c.mode);
      call.uniforms[7][3] = c.knockout ? 1.f : 0.f;
      call.uniforms[8][0] = static_cast<float>(c.offset.x);
      call.uniforms[8][1] = static_cast<float>(c.offset.y);
      localScissor(call, c);
      device_.draw(call);
      stats_.drawCalls++;
    } else if (c.kind == Cmd::Kind::BackdropBlur) {
      BackdropBlur& b = backdrops_[static_cast<size_t>(c.layer)];
      gfx::IRect r = intersect(c.rect, L.rect);
      if (r.w <= 0 || r.h <= 0) continue;
      gfx::IRect local{r.x - ox, r.y - oy, r.w, r.h};
      PoolTarget* copy = acquire(r.w, r.h);
      if (!copy) continue;
      device_.copyToTexture(copy->texture, local);
      device_.endPass();
      // Blur it as a layer of its own.
      Layer tmp;
      tmp.rect = r;
      tmp.target = copy->target;
      tmp.texture = copy->texture;
      tmp.blur = c.sigma;
      tmp.contentH = r.h;
      blurLayer(tmp);
      scratch_.push_back(tmp.target);
      b.texture = tmp.texture;
      // gl_FragCoord (window px, origin bottom left) → the blurred texture's uv.
      PoolTarget* res = nullptr;
      for (auto& t : pool_)
        if (t.target == tmp.target) res = &t;
      double sw = res ? res->w : r.w, sh = res ? res->h : r.h;
      b.place[0] = static_cast<float>(local.x);
      b.place[1] = static_cast<float>(H - local.y - local.h);
      b.place[2] = static_cast<float>(sw / tmp.scale);
      b.place[3] = static_cast<float>(sh / tmp.scale);
      // Back to this layer, as it was.
      gfx::PassDesc resume = pd;
      resume.keep = true;
      if (!device_.beginPass(resume)) return;
    }
  }
  device_.endPass();
}

void Renderer::execute(int index, gfx::TargetId target, const float clear[4]) {
  Layer& root = layers_[static_cast<size_t>(index)];
  root.executed = true;
  for (size_t i = 0; i < root.cmds.size(); i++) {
    const Cmd c = layers_[static_cast<size_t>(index)].cmds[i];
    if (c.kind != Cmd::Kind::Composite) continue;
    if (c.layer >= 0) runLayer(c.layer);
    if (c.aux >= 0) runLayer(c.aux);
  }
  Layer& L = layers_[static_cast<size_t>(index)];
  runCmds(L, target, {0, 0, L.rect.w, L.rect.h}, clear);
}

RenderStats Renderer::render(const Document& doc, Guid page, const Camera& camera, const Viewport& viewport,
                             const Overlay& overlay, const OverlayStyle& style, gfx::TargetId target, Guid only) {
  ensurePipelines();
  frame_++;
  doc_ = &doc;
  viewport_ = viewport;
  screen_ = {0, 0, viewport.width, viewport.height};
  stats_ = {};
  instances_.clear();
  layers_.clear();
  backdrops_.clear();
  clips_.clear();
  scissorEnabled_ = false;
  stencilDepth_ = 0;
  curves_.beginFrame();
  if (rampData_.size() > static_cast<size_t>(kRampWidth) * 4 * 2048) {
    rampRows_.clear();
    rampData_.clear();
    rampRowsUploaded_ = 0;
  }
  Layer root;
  root.rect = {0, 0, viewport.deviceWidth(), viewport.deviceHeight()};
  layers_.push_back(root);
  current_ = 0;

  Mat2x3 view = camera.matrix();
  if (only != kNoGuid) drawChildren(doc, {only}, 0, view * doc.worldTransform(doc.parentOf(only)), 1);  // one node, nothing else
  else drawChildren(doc, doc.children(page), 0, view, 1);
  scissorEnabled_ = false;
  stencilDepth_ = 0;
  clips_.clear();
  current_ = 0;
  // The page's own colour, unless it is Figma's default (#F5F5F5), which follows the theme.
  Color clear = style.canvas;
  if (const Node* pg = doc.get(page); pg && pg->props.backgroundEnabled) {
    const Color& bg = pg->props.backgroundColor;
    Color light = Color::hex(0xF5F5F5);
    bool figmaDefault = std::fabs(bg.r - light.r) < 0.003f && std::fabs(bg.g - light.g) < 0.003f && std::fabs(bg.b - light.b) < 0.003f;
    if (!figmaDefault) clear = bg;
  }
  if (only != kNoGuid) clear = Color{0, 0, 0, 0};  // a node's thumbnail: transparent around it
  // Frame titles read on the page's colour.
  OverlayStyle adapted = style;
  adapted.title = titleColor(clear, &adapted.titleAlpha);
  if (only == kNoGuid) drawOverlay(doc, page, camera, overlay, adapted);

  curveTexture_ = curves_.flush();
  // Gradient ramps.
  int rows = static_cast<int>(rampData_.size() / (kRampWidth * 4));
  if (rows > 0) {
    if (!ramp_ || rows > rampCapacity_) {
      int cap = std::max(16, rampCapacity_);
      while (cap < rows) cap *= 2;
      if (ramp_) device_.destroyTexture(ramp_);
      gfx::TextureDesc d;
      d.format = gfx::TextureFormat::RGBA8;
      d.width = kRampWidth;
      d.height = static_cast<uint32_t>(cap);
      ramp_ = device_.createTexture(d);
      rampCapacity_ = ramp_ ? cap : 0;
      rampRowsUploaded_ = 0;
    }
    if (ramp_ && rampRowsUploaded_ < rows) {
      size_t from = static_cast<size_t>(rampRowsUploaded_) * kRampWidth * 4;
      device_.writeTexture(ramp_, {0, rampRowsUploaded_, kRampWidth, rows - rampRowsUploaded_},
                           {rampData_.data() + from, rampData_.size() - from});
      rampRowsUploaded_ = rows;
    }
  }

  uint32_t bytes = static_cast<uint32_t>(instances_.size() * sizeof(DrawInstance));
  if (bytes) {
    if (!buffer_) {
      capacity_ = std::max<uint32_t>(bytes, 4096 * sizeof(DrawInstance));
      buffer_ = device_.createBuffer(gfx::BufferKind::Instance, capacity_, gfx::Usage::Stream);
    } else if (bytes > capacity_) {
      while (capacity_ < bytes) capacity_ *= 2;
      device_.reserve(buffer_, capacity_);
    }
    device_.write(buffer_, 0, {reinterpret_cast<const uint8_t*>(instances_.data()), bytes});
  }

  float clearColor[4] = {clear.r, clear.g, clear.b, 1};
  if (only != kNoGuid) clearColor[0] = clearColor[1] = clearColor[2] = clearColor[3] = 0;
  execute(0, target, clearColor);
  device_.submit();
  // Every layer's target goes back to the pool; ones unused for a while are freed.
  for (auto& t : pool_) t.busy = false;
  scratch_.clear();
  for (size_t i = 0; i < pool_.size();) {
    if (frame_ - pool_[i].lastUsed > 120) {
      device_.destroyTarget(pool_[i].target);
      pool_.erase(pool_.begin() + static_cast<long>(i));
    } else {
      i++;
    }
  }
  images_.endFrame();
  RenderStats s = stats_;
  return s;
}

}  // namespace eng
