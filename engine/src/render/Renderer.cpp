#include "render/Renderer.h"

#include "geometry/Brush.h"
#include "geometry/DynamicStroke.h"
#include "geometry/Repeat.h"
#include "render/GradientRamp.h"

#include <algorithm>
#include <cmath>
#include <chrono>
#include <cstring>
#include <limits>

#include "geometry/Path.h"
#include "geometry/Shapes.h"
#include "geometry/Stroker.h"
#include "geometry/VariableWidth.h"
#include "layout/Layout.h"
#include "render/shader_presets.h"
#include "scene/Extras.h"

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

// Rects with w < 0 are "unknown: anywhere" (Cmd::bounds): they overlap everything and stay unknown in a union.
bool overlaps(gfx::IRect a, gfx::IRect b) {
  if (a.w < 0 || b.w < 0) return true;
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

gfx::IRect unite(gfx::IRect a, gfx::IRect b) {
  if (a.w < 0 || b.w < 0) return {0, 0, -1, -1};
  if (a.w == 0 || a.h == 0) return b;
  if (b.w == 0 || b.h == 0) return a;
  int x0 = std::min(a.x, b.x), y0 = std::min(a.y, b.y);
  return {x0, y0, std::max(a.x + a.w, b.x + b.w) - x0, std::max(a.y + a.h, b.y + b.h) - y0};
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

// Canvas device px → the node's space (its px ÷ `unit`): uniform slots 16–17 of the effects' shaders.
void effectRows(float out[2][4], const Mat2x3& m, double sx, double sy, Vec2 unit) {
  Mat2x3 t = Mat2x3{1 / std::max(unit.x, 1e-9), 0, 0, 0, 1 / std::max(unit.y, 1e-9), 0} * m.inverse() * Mat2x3{1 / sx, 0, 0, 0, 1 / sy, 0};
  out[0][0] = static_cast<float>(t.m00), out[0][1] = static_cast<float>(t.m01), out[0][2] = static_cast<float>(t.m02), out[0][3] = 0;
  out[1][0] = static_cast<float>(t.m10), out[1][1] = static_cast<float>(t.m11), out[1][2] = static_cast<float>(t.m12), out[1][3] = 0;
}

// A progressive blur's levels between blur radii `a` and `b` (device px), ascending: the larger halved down to the
// smaller, at most Renderer's kMaxBlurLevels (8).
std::vector<double> blurLevels(double a, double b) {
  double lo = std::min(a, b), hi = std::max(a, b);
  std::vector<double> out{hi};
  for (double s = hi / 2; s > std::max(lo, 1.0) * 1.25 && out.size() < 7; s /= 2) out.push_back(s);
  out.push_back(lo);
  std::reverse(out.begin(), out.end());
  return out;
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
  return image == o.image && backdrop == o.backdrop && level == o.level && clip == o.clip &&
         std::memcmp(filters, o.filters, sizeof filters) == 0;
}

bool Renderer::darkCanvas(const Color& page) {
  // Figma reads the page's luminance: light text on a dark page, dark text on a light one.
  auto linear = [](float c) { return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); };
  double l = 0.2126 * linear(page.r) + 0.7152 * linear(page.g) + 0.0722 * linear(page.b);
  return l < 0.18;
}

Renderer::Renderer(gfx::Device& device) : device_(device), curves_(device), images_(device) {}

Renderer::~Renderer() {
  dropCache();
  dropTiles();
  if (preview_.target) device_.destroyTarget(preview_.target);
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
  // Paths and glyphs share the shapes' program (one uber shader): their passes are the shapes' (emit()).
  make(Pass::Composite, ShaderId::Composite, Blend::Premultiplied, none, ColorMask::All);
  make(Pass::CompositeClipped, ShaderId::Composite, Blend::Premultiplied, equal, ColorMask::All);
  make(Pass::CompositeReplace, ShaderId::Composite, Blend::Replace, none, ColorMask::All);
  make(Pass::CompositeReplaceClipped, ShaderId::Composite, Blend::Replace, equal, ColorMask::All);
  make(Pass::Blur, ShaderId::Blur, Blend::Replace, none, ColorMask::All);
  make(Pass::Shader, ShaderId::Custom, Blend::Replace, none, ColorMask::All);
  white_ = device_.createTexture(TextureFormat::RGBA8, 1, 1);
  if (white_) {
    const uint8_t px[4] = {255, 255, 255, 255};
    device_.writeTexture(white_, {0, 0, 1, 1}, {px, 4});
  }
}

// ---- Recording ----------------------------------------------------------------------------------

void Renderer::emit(const DrawInstance& s, Pass pass) { emit(s, pass, DrawState{}); }

gfx::IRect Renderer::instanceBounds(const DrawInstance& q) const {
  // kDrawVertex's quad: a path's box grown by 1.5 px, any other shape [0, size] grown by 2 px and its reach (a drop
  // shadow's blur radius, a stroke's outer width), mapped by the instance's matrix to CSS px, then to device px.
  float sx = std::max(std::hypot(q.linear[0], q.linear[1]), 1e-6f), sy = std::max(std::hypot(q.linear[2], q.linear[3]), 1e-6f);
  int kind = static_cast<int>(q.geom[2] + 0.5f);
  float x0, y0, x1, y1;
  if (kind == static_cast<int>(ShapeKind::Path)) {
    x0 = q.box[0] - 1.5f / sx, y0 = q.box[1] - 1.5f / sy, x1 = q.box[2] + 1.5f / sx, y1 = q.box[3] + 1.5f / sy;
  } else {
    float grow = kind == static_cast<int>(ShapeKind::DropShadow) ? q.geom[0] : kind == static_cast<int>(ShapeKind::InnerShadow) ? 0 : q.geom[1];
    if (!std::isfinite(grow) || grow < 0) grow = 0;
    x0 = -grow - 2 / sx, y0 = -grow - 2 / sy, x1 = q.origin[2] + grow + 2 / sx, y1 = q.origin[3] + grow + 2 / sy;
  }
  double minX = 1e300, minY = 1e300, maxX = -1e300, maxY = -1e300;
  for (int k = 0; k < 4; k++) {
    double lx = (k & 1) ? x1 : x0, ly = (k & 2) ? y1 : y0;
    double px = q.linear[0] * lx + q.linear[2] * ly + q.origin[0];
    double py = q.linear[1] * lx + q.linear[3] * ly + q.origin[1];
    minX = std::min(minX, px), maxX = std::max(maxX, px), minY = std::min(minY, py), maxY = std::max(maxY, py);
  }
  double ksx = viewport_.scaleX(), ksy = viewport_.scaleY();
  minX *= ksx, maxX *= ksx, minY *= ksy, maxY *= ksy;
  if (!std::isfinite(minX) || !std::isfinite(minY) || !std::isfinite(maxX) || !std::isfinite(maxY) || maxX - minX > 1e7 || maxY - minY > 1e7)
    return {0, 0, -1, -1};
  // A device pixel of slack each side (the coverage's antialiasing rounds outward).
  int ix0 = static_cast<int>(std::floor(minX)) - 1, iy0 = static_cast<int>(std::floor(minY)) - 1;
  int ix1 = static_cast<int>(std::ceil(maxX)) + 1, iy1 = static_cast<int>(std::ceil(maxY)) + 1;
  return {ix0, iy0, ix1 - ix0, iy1 - iy0};
}

void Renderer::emit(const DrawInstance& s, Pass pass, const DrawState& state0) {
  DrawState state = state0;
  state.clip = shapeClip_;  // the clip shape in force (uniforms: batches split where it changes)
  // Shapes, paths and glyphs are one program: their passes are one.
  if (pass == Pass::Path) pass = Pass::Shape;
  else if (pass == Pass::PathClipped) pass = Pass::ShapeClipped;
  else if (pass == Pass::PathStencilInc) pass = Pass::ShapeStencilInc;
  else if (pass == Pass::PathStencilDec) pass = Pass::ShapeStencilDec;
  uint8_t ref = stencilDepth_;
  if (stencilDepth_ > 0 && pass == Pass::Shape) pass = Pass::ShapeClipped;
  if (pass == Pass::ShapeStencilDec) ref = static_cast<uint8_t>(stencilDepth_ + 1);
  Layer& layer = layers_[static_cast<size_t>(current_)];
  std::vector<Cmd>& cmds = layer.cmds;
  // Bounds only matter after a background blur in this layer (before it nothing waits for a capture): a page
  // without one pays nothing for them.
  gfx::IRect bounds{0, 0, -1, -1};
  if (!layer.backdropRects.empty()) bounds = instanceBounds(s);
  if (!layer.backdropRects.empty() && scissorEnabled_) {
    gfx::IRect clip{static_cast<int>(std::floor(clipRect_[0])), static_cast<int>(std::floor(clipRect_[1])), 0, 0};
    clip.w = static_cast<int>(std::ceil(clipRect_[2])) - clip.x;
    clip.h = static_cast<int>(std::ceil(clipRect_[3])) - clip.y;
    if (clip.w >= 0 && clip.h >= 0) bounds = intersect(bounds, clip);
  }
  bool over = false;
  for (const gfx::IRect& r : layer.backdropRects) over |= overlaps(bounds, r);
  bool merge = !cmds.empty();
  if (merge) {
    // An axis-aligned clip travels with the instance (DrawInstance::clip), so it never splits a batch.
    const Cmd& d = cmds.back();
    // Instances that sample no image (state.image 0: solids, gradients, glyphs) join a batch that binds one, and
    // the other way round: only two different images (or backdrops) split a run.
    bool states = d.state == state || (d.state.backdrop == state.backdrop && d.state.level == state.level && d.state.clip == state.clip &&
                                       (state.image == 0 || d.state.image == 0) &&
                                       (state.image == 0 ? true : std::memcmp(d.state.filters, DrawState{}.filters, sizeof d.state.filters) == 0));
    merge = d.kind == Cmd::Kind::Draw && d.pass == pass && d.stencilRef == ref && d.first + d.count == instances_.size() && states &&
            d.overBackdrop == over;
    // A batch clear of the blurs stays clear: its box (one rectangle round all its instances) mustn't reach one.
    if (merge && !over && !layer.backdropRects.empty()) {
      gfx::IRect grown = unite(d.bounds, bounds);
      for (const gfx::IRect& r : layer.backdropRects) merge = merge && !overlaps(grown, r);
    }
  }
  if (merge) {
    Cmd& d = cmds.back();
    d.count++;
    d.bounds = unite(d.bounds, bounds);
    if (d.state.image == 0 && state.image != 0) d.state = state;  // the batch binds the image now
  } else {
    Cmd c;
    c.kind = Cmd::Kind::Draw;
    c.pass = pass;
    c.first = static_cast<uint32_t>(instances_.size());
    c.count = 1;
    c.stencilRef = ref;
    c.state = state;
    c.bounds = bounds;
    c.overBackdrop = over;
    cmds.push_back(c);
  }
  instances_.push_back(s);
  if (round_.on) {
    DrawInstance& q = instances_.back();
    for (int i = 0; i < 4; i++) q.round[i] = round_.rect[i], q.radii[i] = round_.radii[i];
  }
  if (scissorEnabled_) {
    // The clip rectangle at its exact place: the shaders cover the pixels its edges cross by how much they're in.
    DrawInstance& q = instances_.back();
    for (int i = 0; i < 4; i++) q.clip[i] = clipRect_[i];
  }
  stats_.shapes++;
  if (s.geom[2] == static_cast<float>(ShapeKind::Path)) stats_.paths++;
}

int Renderer::rampRow(const std::vector<ColorStop>& stops0, InterpolationColorSpace space, InterpolationHueMethod hue) {
  Hash h;
  for (auto& s : stops0) h.add(s.position).add(s.color.r).add(s.color.g).add(s.color.b).add(s.color.a);
  if (space != InterpolationColorSpace::DEFAULT) h.add(static_cast<double>(space) + 1).add(static_cast<double>(hue) + 1);
  auto it = rampRows_.find(h.h);
  if (it != rampRows_.end()) return it->second;
  if (space != InterpolationColorSpace::DEFAULT) {
    // Another space than the document's (Paint.interpolationColorSpace): baked as CSS Color 4 blends.
    int row = static_cast<int>(rampData_.size() / (kRampWidth * 4));
    bakeGradientRamp(stops0, space, hue, kRampWidth, rampData_);
    rampRows_[h.h] = row;
    return row;
  }
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

void Renderer::noteImageUser(const ImageHash& hash) {
  if (!hash.present || imageUsersLost_) return;
  if (drawing_ == kNoGuid || imageUserCount_ >= 200000) {
    // Drawn for no layer of the page, or too many to keep: unknown from now until everything is drawn again.
    imageUsersLost_ = true;
    imageUsers_.clear();
    imageUserCount_ = 0;
    return;
  }
  if (imageUsers_[hash].insert(drawing_).second) imageUserCount_++;
}

bool Renderer::setPaint(DrawInstance& q, DrawState& state, const Paint& paint, const Mat2x3& localToNode, Vec2 nodeSize, double alpha) {
  // PATTERN and shader fills go through layers (drawPattern, drawShaderPaint); such a stroke isn't drawn.
  if (!paint.visible || paint.type == PaintType::OTHER || paint.type == PaintType::PATTERN || paint.type == PaintType::CUSTOM) return false;
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
    const PaintExtras& px = paintExtras(paint);
    q.paint1[3] = static_cast<float>(rampRow(paint.stops, px.interpolationColorSpace, px.interpolationHueMethod));
    kind = paint.type == PaintType::GRADIENT_LINEAR    ? PaintKind::Linear
           : paint.type == PaintType::GRADIENT_RADIAL  ? PaintKind::Radial
           : paint.type == PaintType::GRADIENT_ANGULAR ? PaintKind::Angular
                                                       : PaintKind::Diamond;
  } else if (paint.type == PaintType::NOISE) {
    // Noise (Figma Draw): Figma's noise (the NOISE effect's, docs/research/rea/effects.md §2.17; seed 0) over the
    // node's space from its centre at 1 / noiseSize — Mono the paint's colour, Duo the colour in the high band,
    // Multi every channel its own — where it falls in the `density` band; noiseSize ≤ 1 supersampled (type + 4).
    const PaintExtras& x = paintExtras(paint);
    double fx = 1 / std::max(x.noiseSize.x, 1e-3), fy = 1 / std::max(x.noiseSize.y, 1e-3);
    Mat2x3 P = Mat2x3{fx, 0, -nodeSize.x / 2 * fx, 0, fy, -nodeSize.y / 2 * fy} * localToNode;
    if (x.noiseType == NoiseType::MULTITONE) q.color[0] = q.color[1] = q.color[2] = q.color[3] = static_cast<float>(a);
    else premultiply(q.color, paint.color, a);
    q.paint0[0] = static_cast<float>(P.m00), q.paint0[1] = static_cast<float>(P.m01), q.paint0[2] = static_cast<float>(P.m02);
    q.paint1[0] = static_cast<float>(P.m10), q.paint1[1] = static_cast<float>(P.m11), q.paint1[2] = static_cast<float>(P.m12);
    q.paint0[3] = static_cast<float>(std::clamp(x.density, 0.0, 1.0));
    q.paint1[3] = static_cast<float>(static_cast<int>(x.noiseType) + (x.noiseSize.x <= 1 ? 4 : 0));
    kind = PaintKind::Noise;
  } else if (isImageLike(paint.type)) {
    bool failed = false, placeholder = false;
    // How large the image is drawn (device px): the node's box through this draw's transform. The registry asks for
    // a larger copy when a tier is drawn bigger than it is (docs/engine-build.md "Figma parity round 3" §5).
    double det = std::fabs(static_cast<double>(q.linear[0]) * q.linear[3] - static_cast<double>(q.linear[1]) * q.linear[2]);
    double local = std::fabs(localToNode.m00 * localToNode.m11 - localToNode.m01 * localToNode.m10);
    double devicePx = std::max(nodeSize.x, nodeSize.y) * std::sqrt(det / std::max(local, 1e-12)) * viewport_.scaleX();
    ImageHints hints = imageHints(paint);
    noteImageUser(paint.image);
    ImageCache::Texture t = images_.texture(paint.image, &failed, devicePx, &hints, &placeholder);
    if (!t.id) {
      // Loading (or missing), and no ThumbHash: Figma's grey.
      premultiply(q.color, Color::hex(0xE6E6E6), a);
    } else {
      // The image's own size (a tier, a downscaled copy or the ThumbHash stands in for it): the original's when known.
      double iw = t.width, ih = t.height;
      if (hints.originalWidth && hints.originalHeight) iw = hints.originalWidth, ih = hints.originalHeight;
      Mat2x3 P = imageMatrix(paint, nodeSize, iw, ih) * localToNode;
      q.color[0] = q.color[1] = q.color[2] = q.color[3] = static_cast<float>(a);
      q.paint0[0] = static_cast<float>(P.m00), q.paint0[1] = static_cast<float>(P.m01), q.paint0[2] = static_cast<float>(P.m02);
      q.paint1[0] = static_cast<float>(P.m10), q.paint1[1] = static_cast<float>(P.m11), q.paint1[2] = static_cast<float>(P.m12);
      q.paint0[3] = paint.imageScaleMode == ImageScaleMode::TILE ? 1.f : 0.f;
      state.image = t.id;
      const PaintFilter& f = paint.paintFilter;
      // Figma's image colour-adjust uniforms (gfx/gl/Shaders.h adjust): contrast as stored (±0.3), the others ±1.
      float filters[8] = {f.exposure, imageContrast(f.contrast), f.vibrance, f.temperature, f.tint, f.highlights, f.shadows, 0};
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
  bool sdf = !p.isPathShape() && !p.invertedCorners() && (p.isRectLike() || p.isFrameLike() || p.type == NodeType::ELLIPSE);
  if (sdf) {
    ShapeKind kind = p.type == NodeType::ELLIPSE ? ShapeKind::Ellipse : ShapeKind::Rect;
    CornerRadii radii = kind == ShapeKind::Rect ? geom::clampRadii(p.size, p.cornerRadii) : kSquare;
    for (const Paint& f : fills) {
      if (f.type == PaintType::PATTERN) {
        if (f.visible) drawPattern(doc, id, p, m, alpha, f);
        continue;
      }
      if (f.type == PaintType::CUSTOM) {
        if (f.visible) drawShaderPaint(doc, id, p, m, alpha, f);
        continue;
      }
      blendedPaint(f, m, p.size, alpha, [&](double a) {
        DrawInstance q = makeShape(m, p.size, kind, radii, Color{}, 1, Color{}, 0, 0, 0);
        DrawState state;
        if (setPaint(q, state, f, Mat2x3{}, p.size, a)) emit(q, Pass::Shape, state);
      });
    }
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
      const VectorStyle* st = p.shape().vectorData.style(region.styleID);
      if (st && (st->mask & VS_FILLS)) paints = &st->fillPaints;
    }
    if (!anyVisible(*paints)) continue;
    uint64_t key = Hash().add(g->fillKey).add(r).add(level).add(0xF111ull).h;
    const CurveEntry* entry = curves_.path(key, [&](std::vector<float>& out) { geom::toQuads(region.path, tol, out); });
    for (const Paint& f : *paints) {
      if (f.type == PaintType::PATTERN) {
        if (f.visible && r == 0) drawPattern(doc, id, p, m, alpha, f);
        continue;
      }
      if (f.type == PaintType::CUSTOM) {
        if (f.visible && r == 0) drawShaderPaint(doc, id, p, m, alpha, f);
        continue;
      }
      blendedPaint(f, m, p.size, alpha, [&](double a) { emitPath(entry, m, region.windingRule == WindingRule::ODD, f, p.size, a); });
    }
  }
}

void Renderer::drawPattern(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m, double alpha, const Paint& paint, bool stroke) {
  double a = alpha * paint.opacity;
  const PaintExtras& x = paintExtras(paint);
  if (!(a > 0) || patternDepth_ > 1 || x.sourceNodeId == kNoGuid || x.sourceNodeId == id) return;
  // The source's render tree: this page's, or the page it is on.
  const RenderTree* tree = tree_;
  int src = tree->indexOf(x.sourceNodeId);
  if (src < 0) {
    Guid page = doc.pageOf(x.sourceNodeId);
    if (page == kNoGuid || page == tree_->page()) return;
    RenderTree& t = trees_[page];
    t.sync(doc, page);
    tree = &t;
    src = t.indexOf(x.sourceNodeId);
    if (src < 0) return;
  }
  const NodeProps& sp = tree->nodes()[static_cast<size_t>(src)].node->props;
  // A tile: the source's box at the paint's scale, apart by "Spacing" (a share of the tile), anchored at the
  // "Alignment" point of the node's box; hexagonal tiles shift every other row (or column) by half a step.
  double scale = paint.scale > 0 ? paint.scale : 1;
  Vec2 tile{sp.size.x * scale, sp.size.y * scale};
  if (!(tile.x > 0) || !(tile.y > 0)) return;
  if (std::max(tile.x, tile.y) * levelScale(m) < 0.5) return;  // under half a device px: nothing to see
  Vec2 step{std::max(tile.x * (1 + x.patternSpacing.x), tile.x * 0.01), std::max(tile.y * (1 + x.patternSpacing.y), tile.y * 0.01)};
  auto anchor = [](PatternAlignment al, double len, double t) {
    return al == PatternAlignment::START ? 0.0 : al == PatternAlignment::CENTER ? (len - t) / 2 : len - t;
  };
  Vec2 origin{anchor(x.horizontalAlignment, p.size.x, tile.x), anchor(x.verticalAlignment, p.size.y, tile.y)};
  // A pattern stroke reaches past the box by the stroke's reach (node units): the tiles cover that too.
  double pad = 0;
  if (stroke) {
    pad = p.strokeWeight * (p.strokeAlign == StrokeAlign::CENTER ? 0.5 : 1) * std::max(1.0, std::min(p.miterLimit, 4.0)) + 1;
    geom::DynamicSettings dyn;
    if (!p.extra.empty() && dynamicSettingsOf(p, dyn)) pad += geom::dynamicReach(dyn, p.strokeWeight);
    if (!p.extra.empty() && strokeBrushOf(p) != kNoGuid) pad = std::max(pad, p.strokeWeight * 4);
  }
  // The part of the box on screen (node space).
  Mat2x3 inv = m.inverse();
  Rect seen = Rect::fromPoints(inv.apply({screen_.x, screen_.y}), inv.apply({screen_.right(), screen_.bottom()}));
  seen = seen.united(Rect::fromPoints(inv.apply({screen_.right(), screen_.y}), inv.apply({screen_.x, screen_.bottom()})));
  double x0 = std::max(-pad, seen.x), y0 = std::max(-pad, seen.y);
  double x1 = std::min(p.size.x + pad, seen.right()), y1 = std::min(p.size.y + pad, seen.bottom());
  if (x1 <= x0 || y1 <= y0) return;
  gfx::IRect r = deviceRect(transformedBounds(m * Mat2x3::translate(-pad, -pad), p.size.x + 2 * pad, p.size.y + 2 * pad), 2);
  if (r.w <= 0 || r.h <= 0) return;
  bool hexRows = x.tileType == PatternTileType::HORIZONTAL_HEXAGONAL, hexCols = x.tileType == PatternTileType::VERTICAL_HEXAGONAL;
  long i0 = static_cast<long>(std::floor((x0 - origin.x - tile.x) / step.x)) - (hexRows ? 1 : 0);
  long i1 = static_cast<long>(std::ceil((x1 - origin.x) / step.x));
  long j0 = static_cast<long>(std::floor((y0 - origin.y - tile.y) / step.y)) - (hexCols ? 1 : 0);
  long j1 = static_cast<long>(std::ceil((y1 - origin.y) / step.y));
  if ((i1 - i0 + 1) * (j1 - j0 + 1) > 4096) return;  // too many to draw one by one
  int saved = beginLayer(r);
  int P = current_;
  const RenderTree* savedTree = tree_;
  bool savedCull = cull_;
  tree_ = tree;
  cull_ = false;  // the tiles aren't where the tree's bounds say
  patternDepth_++;
  Mat2x3 back = sp.transform.inverse();
  for (long j = j0; j <= j1; j++)
    for (long i = i0; i <= i1; i++) {
      double tx = origin.x + static_cast<double>(i) * step.x + (hexRows && (j & 1) ? step.x / 2 : 0);
      double ty = origin.y + static_cast<double>(j) * step.y + (hexCols && (i & 1) ? step.y / 2 : 0);
      if (tx >= x1 || ty >= y1 || tx + tile.x <= x0 || ty + tile.y <= y0) continue;
      drawNode(doc, static_cast<uint32_t>(src), m * Mat2x3::translate(tx, ty) * Mat2x3::scale(scale) * back, 1);
    }
  patternDepth_--;
  cull_ = savedCull;
  tree_ = savedTree;
  endLayer(saved);
  // Through the node's fill shape — or, for a pattern stroke, its stroke (Figma Draw's pattern strokes).
  int saved2 = beginLayer(r);
  int M = current_;
  if (stroke) {
    NodeProps white = p;
    white.strokePaints = {Paint::solid(Color{1, 1, 1, 1})};
    drawStrokePaints(doc, id, white, m, 1);
  } else {
    drawFills(doc, id, p, m, 1, true);
  }
  endLayer(saved2);
  stats_.layers += 2;
  compositeLayer(P, M, 1, static_cast<float>(a), paint.blendMode == BlendMode::PASS_THROUGH ? BlendMode::NORMAL : paint.blendMode,
                 Color{}, {}, false, r);
}

namespace {

// A shader's uniform slots 4–19 (gfx/gl/CustomShader.h): canvas device px → the node's px, the program, the node's px →
// device px, the preset's colours (from slot 8) and other parameters (from slot 14) in order.
void packShader(float u[gfx::kUniformSlots][4], const ShaderSetup& s, const Mat2x3& m, Vec2 size, double sx, double sy) {
  float rows[2][4];
  effectRows(rows, m, sx, sy, {1, 1});
  for (int i = 0; i < 4; i++) u[4][i] = rows[0][i], u[5][i] = rows[1][i];
  u[6][0] = static_cast<float>(s.preset->program);
  u[6][1] = s.preset->effect ? 1.f : 0.f;
  u[6][2] = static_cast<float>(size.x);
  u[6][3] = static_cast<float>(size.y);
  u[7][0] = static_cast<float>(sx * m.m00), u[7][1] = static_cast<float>(sx * m.m01);
  u[7][2] = static_cast<float>(sy * m.m10), u[7][3] = static_cast<float>(sy * m.m11);
  int colors = 0, scalars = 0;
  for (int i = 0; i < s.preset->count; i++) {
    if (s.preset->params[i].type == shaders::ParamType::Color) {
      if (colors < 6) std::memcpy(u[8 + colors++], s.values[i], sizeof(float) * 4);
    } else if (scalars < 24) {
      u[14 + scalars / 4][scalars % 4] = s.values[i][0];
      scalars++;
    }
  }
}

}  // namespace

int Renderer::shaderLayer(const ShaderSetup& s, int source, gfx::IRect r, const Mat2x3& m, Vec2 size) {
  int saved = beginLayer(r);
  int L = current_;
  ShaderCall call;
  packShader(call.u, s, m, size, viewport_.scaleX(), viewport_.scaleY());
  shaderCalls_.push_back(call);
  Cmd c;
  c.kind = Cmd::Kind::Shader;
  c.pass = Pass::Shader;
  c.layer = source;
  c.aux = static_cast<int>(shaderCalls_.size() - 1);
  c.rect = r;
  layers_[static_cast<size_t>(L)].cmds.push_back(c);
  endLayer(saved);
  stats_.layers++;
  return L;
}

void Renderer::drawShaderPaint(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m, double alpha, const Paint& paint) {
  double a = alpha * paint.opacity;
  const ShaderSetup& s = shaderOf(paint);
  // A preset this engine doesn't know (or an effect's) isn't drawn.
  if (!(a > 0) || !s.preset || s.preset->effect || patternDepth_ > 1) return;
  gfx::IRect r = deviceRect(transformedBounds(m, p.size.x, p.size.y), 2);
  if (r.w <= 0 || r.h <= 0) return;
  int P = shaderLayer(s, -1, r, m, p.size);
  // Through the node's fill shape.
  int saved = beginLayer(r);
  int M = current_;
  drawFills(doc, id, p, m, 1, true);
  endLayer(saved);
  stats_.layers++;
  compositeLayer(P, M, 1, static_cast<float>(a), paint.blendMode == BlendMode::PASS_THROUGH ? BlendMode::NORMAL : paint.blendMode,
                 Color{}, {}, false, r);
}

void Renderer::drawStrokes(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m, double alpha) {
  if (!(p.strokeWeight > 0) || !anyVisible(p.strokePaints)) return;
  bool pattern = false;
  for (const Paint& s : p.strokePaints) pattern |= s.visible && s.type == PaintType::PATTERN;
  if (!pattern) return drawStrokePaints(doc, id, p, m, alpha);
  // Pattern strokes (Figma Draw): the source's tiles through the stroke; the other paints as they are, in order.
  for (const Paint& s : p.strokePaints) {
    if (!s.visible) continue;
    if (s.type == PaintType::PATTERN) {
      drawPattern(doc, id, p, m, alpha, s, true);
      continue;
    }
    NodeProps one = p;
    one.strokePaints = {s};
    drawStrokePaints(doc, id, one, m, alpha);
  }
}

void Renderer::drawStrokePaints(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m, double alpha) {
  if (!(p.strokeWeight > 0) || !anyVisible(p.strokePaints)) return;
  bool independent = p.stroke().borderStrokeWeightsIndependent && (p.isRectLike() || p.isFrameLike());
  // A dashed frame stroke (a component set's) goes through the stroker like a dashed rectangle's.
  bool dashedFrame = p.isFrameLike() && !p.stroke().dashPattern.empty();
  // A variable width (round 12) goes through the stroker.
  bool variable = !p.extra.empty() && hasWidthPoints(p) && widthProfileAllowed(p);
  // Figma Draw's dynamic and brush strokes are drawn from the geometry's centre line, whatever the shape.
  bool drawn = !p.extra.empty() && (strokeBrushOf(p) != kNoGuid || hasDynamicStroke(p));
  // Path trim (docs/motion.md §4.13): a centre stroke cut by it is drawn from the geometry's trimmed centre line.
  double trimStart = 0, trimEnd = 1;
  bool trimmed = p.strokeAlign == StrokeAlign::CENTER && !p.extra.empty() && pathTrimOf(p, trimStart, trimEnd);
  bool sdf = !p.isPathShape() && !p.invertedCorners() && !independent && !dashedFrame && !variable && !drawn && !trimmed &&
             (p.isRectLike() || p.isFrameLike() || p.type == NodeType::ELLIPSE);
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
    const auto& bw = p.stroke().borderWeights;  // top, right, bottom, left
    double k0 = p.strokeAlign == StrokeAlign::INSIDE ? 0 : p.strokeAlign == StrokeAlign::OUTSIDE ? 1 : 0.5;
    double t = bw[0], r = bw[1], b = bw[2], l = bw[3];
    Rect outerBox{-l * k0, -t * k0, p.size.x + (l + r) * k0, p.size.y + (t + b) * k0};
    Rect innerBox{outerBox.x + l, outerBox.y + t, outerBox.w - l - r, outerBox.h - t - b};
    const uint32_t inv = p.invertedCorners();
    uint64_t key = Hash().add(p.size.x).add(p.size.y).add(t).add(r).add(b).add(l).add(k0).add(p.cornerRadii).add(inv).add(level).add(0xB0ull).h;
    const CurveEntry* entry = curves_.path(key, [&](std::vector<float>& out) {
      CornerRadii radii = geom::clampRadii(p.size, p.cornerRadii);
      geom::Path ring = geom::rectPath({outerBox.w, outerBox.h}, radii, 0, inv).transformed(Mat2x3::translate(outerBox.x, outerBox.y));
      if (innerBox.w > 0 && innerBox.h > 0) {
        // Inside: a rounded corner's radius less the weight, an inverted one's more (its circle is around the corner).
        CornerRadii ir;
        for (size_t i = 0; i < 4; i++) ir[i] = (inv >> i) & 1 ? radii[i] + std::max(t, l) : std::max(0.0, radii[i] - std::max(t, l));
        ring.append(geom::rectPath({innerBox.w, innerBox.h}, ir, 0, inv).transformed(Mat2x3::translate(innerBox.x, innerBox.y)).reversed());
      }
      geom::toQuads(ring, tol, out);
    });
    for (const Paint& s : p.strokePaints) emitPath(entry, m, false, s, p.size, alpha);
    return;
  }
  const NodeGeometry* g = doc.geometry(id);
  if (!g || g->stroke.path.empty()) return;
  if (!p.extra.empty() && strokeBrushOf(p) != kNoGuid) {
    // A brush stroke (Figma Draw): the brush's artwork along the path, filled with the stroke paints.
    geom::Path brushed;
    uint64_t key = 0;
    if (brushStroke(doc, p, *g, tol, brushed, &key)) {
      const CurveEntry* entry = curves_.path(Hash().add(key).add(p.strokeWeight).add(level).add(0xB205ull).h,
                                             [&](std::vector<float>& out) { geom::toQuads(brushed, tol, out); });
      for (const Paint& s : p.strokePaints) emitPath(entry, m, false, s, p.size, alpha);
      return;
    }
  }
  // A dynamic stroke (Figma Draw, docs/draw.md §4.3): its wandering centre line, stroked as any other.
  geom::Path dynamic;
  uint64_t dynamicKey = 0;
  const geom::Path* center = &g->stroke.path;
  if (drawn && dynamicCenter(p, *g, tol, dynamic, &dynamicKey)) center = &dynamic;
  bool closedArea = !g->fills.empty() && !g->hasOpenEnds;
  bool aligned = closedArea && p.strokeAlign != StrokeAlign::CENTER;
  geom::StrokeStyle style;
  style.width = p.strokeWeight * (aligned ? 2 : 1);
  style.join = p.strokeJoin;
  style.miterLimit = p.miterLimit;
  style.cap = p.strokeCap;
  // A dynamic stroke keeps a Basic stroke's dashes in the document (Figma, docs/draw.md §4.3) but doesn't draw them:
  // Stroke settings shows dashes for Basic strokes only.
  if (center != &dynamic) style.dashes = p.stroke().dashPattern;
  style.fitDashes = p.isRectLike() || p.isFrameLike();
  style.caps = g->stroke.caps.empty() ? nullptr : &g->stroke.caps;
  Hash h;
  h.add(g->strokeKey).add(style.width).add(style.join).add(style.miterLimit).add(style.cap).add(style.fitDashes).add(level).add(0x57ull);
  for (double d : style.dashes) h.add(d);
  if (variable) h.add(widthPointsKey(p)).add(0x7a1dull);
  if (dynamicKey) h.add(dynamicKey).add(0xD1Aull);
  const CurveEntry* entry = curves_.path(h.h, [&](std::vector<float>& out) {
    std::vector<geom::WidthPoint> profile;
    if (variable) profile = widthPointsOf(p);
    if (!profile.empty()) style.profile = &profile;
    geom::toQuads(geom::strokePath(*center, style, tol), tol, out);
  });
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
bool analyticShadows(const NodeProps& p, bool hasChildren) {
  if (!(p.isRectLike() || p.isFrameLike()) || p.stroke().cornerSmoothing > 0 || p.invertedCorners()) return false;
  bool opaque = false;
  for (auto& f : p.fillPaints)
    opaque |= f.visible && f.type == PaintType::SOLID && f.opacity >= 1 && f.color.a >= 1 &&
              (f.blendMode == BlendMode::NORMAL || f.blendMode == BlendMode::PASS_THROUGH);
  if (!opaque) return false;
  if (p.isFrameLike() && !p.clipsContent() && hasChildren) return false;
  for (auto& e : p.effects)
    if (visibleForRendering(e) && e.isShadow() && e.blendMode != BlendMode::NORMAL && e.blendMode != BlendMode::PASS_THROUGH) return false;
  return true;
}

// Whether every paint the node draws itself is opaque (its alpha is then its shape's coverage).
bool opaquePaints(const NodeProps& p) {
  auto opaque = [](const std::vector<Paint>& paints) {
    for (const Paint& f : paints)
      if (f.visible && (f.type != PaintType::SOLID || f.opacity < 1 || f.color.a < 1 ||
                        (f.blendMode != BlendMode::NORMAL && f.blendMode != BlendMode::PASS_THROUGH)))
        return false;
    return true;
  };
  return opaque(p.fillPaints) && (!(p.strokeWeight > 0) || opaque(p.strokePaints));
}

// The node's paints made opaque white (its geometry's coverage): what hides a drop shadow under the layer.
NodeProps opaqueCopy(const NodeProps& p) {
  NodeProps q = p;
  auto whiten = [](std::vector<Paint>& paints) {
    for (Paint& f : paints)
      if (f.visible) f = Paint::solid(Color{1, 1, 1, 1});
  };
  whiten(q.fillPaints);
  whiten(q.strokePaints);
  return q;
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
    if (!visibleForRendering(e) || (inner ? e.type != EffectType::INNER_SHADOW : e.type != EffectType::DROP_SHADOW)) continue;
    double blur = std::max(0.0, e.radius);  // the tent's half-width (Figma's blur radius)
    Vec2 off = localOffset(m, e.offset);
    if (!inner) {
      double s = shadowSpread(p, e);
      Vec2 size{p.size.x + 2 * s, p.size.y + 2 * s};
      if (size.x <= 0 || size.y <= 0) continue;
      CornerRadii r;
      for (size_t i = 0; i < 4; i++) r[i] = radii[i] > 0 ? std::max(0.0, radii[i] + s) : 0;
      DrawInstance q = makeShape(m * Mat2x3::translate(off.x - s, off.y - s), size, ShapeKind::DropShadow, r, e.color, alpha, Color{}, 0, 0, 0);
      q.geom[0] = static_cast<float>(blur);
      q.geom[1] = 0;
      q.geom[2] = static_cast<float>(ShapeKind::DropShadow);
      emit(q, Pass::Shape);
    } else {
      DrawInstance q = makeShape(m, p.size, ShapeKind::InnerShadow, radii, e.color, alpha, Color{}, 0, 0, 0);
      q.geom[0] = static_cast<float>(blur);
      q.geom[1] = static_cast<float>(shadowSpread(p, e));
      q.geom[2] = static_cast<float>(ShapeKind::InnerShadow);
      q.paint0[0] = static_cast<float>(off.x);
      q.paint0[1] = static_cast<float>(off.y);
      emit(q, Pass::Shape);
    }
  }
}

Rect Renderer::blurClampBox(const NodeProps& p, const Rect& ink) {
  Rect box{0, 0, p.size.x, p.size.y};
  if ((p.strokeAlign == StrokeAlign::OUTSIDE || p.strokeAlign == StrokeAlign::CENTER) && p.strokeWeight > 0 && anyVisible(p.strokePaints)) {
    double grow = (p.strokeAlign == StrokeAlign::OUTSIDE ? p.strokeWeight : p.strokeWeight / 2) * p.miterLimit;
    // Figma's size.withOnesForZeros(): a line's box is a unit thick before the stroke grows it.
    box = {-grow, -grow, (p.size.x != 0 ? p.size.x : 1) + 2 * grow, (p.size.y != 0 ? p.size.y : 1) + 2 * grow};
  }
  if (!ink.empty()) box = box.united(ink);
  return box;
}

double Renderer::backdropReach(const NodeProps& p, const Effect& e, bool glass, double scale) {
  const EffectExtras& x = effectExtras(e);
  double r1 = std::max(glass ? 1.0 : 0.0, e.radius) * scale;  // glass frosts by at least 1 (Figma's)
  double r0 = std::max(0.0, x.startRadius) * scale;
  bool progressive = !glass && x.blurOpType == BlurOpType::PROGRESSIVE && std::fabs(r0 - r1) > 0.01;
  if (!glass && !progressive) {
    // Clamped to its box (§2.11): its copy holds only the box grown by the stroke (drawBackgroundBlur). The parts the
    // content cache draws again still grow by the radius, as before the clamp: grown less, a pan at 200 % left a
    // glass at the canvas's edge 8 columns off a fresh draw (engine-shot r17) — a gap of the glass's own the wider
    // growth covers, not yet found.
    Rect b = blurClampBox(p, {});
    return std::max({-b.x, -b.y, b.right() - p.size.x, b.bottom() - p.size.y, 0.0}) * scale + std::max(r1, 0.0) + 2;
  }
  // The tent reaches exactly its radius; 2 px more for the ×2 level's bilinear fetches.
  double reach = (progressive ? std::max(r0, r1) : r1) + 2;
  if (glass) reach += std::max(0.0, x.refractionRadius) * scale * (1 + std::clamp(x.chromaticAberration, 0.0, 1.0));
  return reach;
}

std::vector<Renderer::BackdropArea> Renderer::backdropAreas(const Document& doc, bool world) const {
  std::vector<BackdropArea> out;
  const std::vector<RenderNode>& nodes = tree_->nodes();
  // World space: the view at 100 %, one unit a px (what a blur reads past a layer scales with the zoom, nearly).
  const Mat2x3 view = world ? Mat2x3{} : view_;
  const double sx = world ? 1 : viewport_.scaleX(), sy = world ? 1 : viewport_.scaleY();
  for (uint32_t i = 0; i < nodes.size();) {
    const RenderNode& rn = nodes[i];
    if (!rn.backdropInside) {
      i = rn.end;
      continue;
    }
    if (rn.samplesBackdrop) {
      const NodeProps& p = propsAt(i);
      double scale = std::sqrt(std::fabs((view * doc.worldTransform(rn.id)).determinant())) * std::sqrt(sx * sy);
      double reach = 0;
      // As drawNode picks it: the first background blur or glass, whichever comes first (Figma's).
      for (const Effect& e : p.effects) {
        if (!visibleForRendering(e) || (e.type != EffectType::BACKGROUND_BLUR && e.type != EffectType::GLASS)) continue;
        reach = backdropReach(p, e, e.type == EffectType::GLASS, scale);
        break;
      }
      const Rect& w = rn.visual;
      Rect box{(w.x * view.m00 + view.m02) * sx, (w.y * view.m11 + view.m12) * sy, w.w * view.m00 * sx, w.h * view.m11 * sy};
      out.push_back({box, reach});
    }
    i++;
  }
  return out;
}

void Renderer::growForBackdrops(const Document& doc, std::vector<gfx::IRect>& regions, int dx, int dy) const {
  if (regions.empty()) return;
  // The page's layers (their subtrees' flags): none reading a backdrop, nothing to grow.
  bool any = false;
  for (uint32_t i = 0; i < tree_->size() && !any; i = tree_->nodes()[i].end) any = tree_->nodes()[i].backdropInside;
  if (!any) return;
  const int W = viewport_.deviceWidth(), H = viewport_.deviceHeight();
  struct Area {
    gfx::IRect rect;  // what it reads and draws, on the canvas
    bool trailing;    // the canvas's edge the view moves away from cuts it
    bool added = false;
  };
  std::vector<Area> areas;
  for (const BackdropArea& b : backdropAreas(doc)) {
    // Its box plus what its blur and refraction read (as drawBackgroundBlur's copy), and a few px for rounding.
    double m = b.reach + 4;
    double x0 = std::floor(b.box.x - m), y0 = std::floor(b.box.y - m), x1 = std::ceil(b.box.right() + m), y1 = std::ceil(b.box.bottom() + m);
    double cx0 = std::max(0.0, x0), cy0 = std::max(0.0, y0), cx1 = std::min<double>(W, x1), cy1 = std::min<double>(H, y1);
    if (cx1 <= cx0 || cy1 <= cy0) continue;  // off the canvas: nothing of it is drawn
    gfx::IRect r{static_cast<int>(cx0), static_cast<int>(cy0), static_cast<int>(cx1 - cx0), static_cast<int>(cy1 - cy0)};
    bool trailing = (dx > 0 && x1 > W) || (dx < 0 && x0 < 0) || (dy > 0 && y1 > H) || (dy < 0 && y0 < 0);
    areas.push_back({r, trailing});
  }
  auto overlaps = [](const gfx::IRect& a, const gfx::IRect& b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  };
  // A part drawn again that touches what such a layer reads: the layer is drawn again whole, over all it reads drawn
  // again too (its own old pixels, or another part's backdrop, must not be what it reads). Until nothing more is
  // added (an added area may touch another layer's). One the edge the view leaves cuts: a fresh draw reads it to the
  // edge where it is now, the cache's pixels were drawn reading to where it was: drawn again too. (The edge the view
  // moves toward needs nothing more: the strip coming in there touches each layer it cuts.)
  for (bool grew = true; grew;) {
    grew = false;
    for (Area& a : areas) {
      if (a.added) continue;
      bool hit = a.trailing;
      for (size_t k = 0; k < regions.size() && !hit; k++) hit = overlaps(a.rect, regions[k]);
      if (!hit) continue;
      a.added = true;
      regions.push_back(a.rect);
      grew = true;
    }
  }
}

void Renderer::mergeRegions(std::vector<gfx::IRect>& regions, size_t most) {
  auto box = [](const gfx::IRect& a, const gfx::IRect& b) {
    int x0 = std::min(a.x, b.x), y0 = std::min(a.y, b.y), x1 = std::max(a.x + a.w, b.x + b.w), y1 = std::max(a.y + a.h, b.y + b.h);
    return gfx::IRect{x0, y0, x1 - x0, y1 - y0};
  };
  auto px = [](const gfx::IRect& r) { return static_cast<double>(r.w) * r.h; };
  while (regions.size() > most) {
    size_t bi = 0, bj = 1;
    double best = std::numeric_limits<double>::infinity();
    for (size_t i = 0; i < regions.size(); i++)
      for (size_t j = i + 1; j < regions.size(); j++) {
        double waste = px(box(regions[i], regions[j])) - px(regions[i]) - px(regions[j]);
        if (waste < best) best = waste, bi = i, bj = j;
      }
    regions[bi] = box(regions[bi], regions[bj]);
    regions.erase(regions.begin() + static_cast<std::ptrdiff_t>(bj));
  }
}

void Renderer::drawBackgroundBlur(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m, double alpha, const Effect& e,
                                  bool glass) {
  const EffectExtras& x = effectExtras(e);
  double scale = levelScale(m);
  double s1 = std::max(0.0, e.radius) * scale;  // blur radii, device px
  double s0 = std::max(0.0, x.startRadius) * scale;
  bool progressive = !glass && x.blurOpType == BlurOpType::PROGRESSIVE && std::fabs(s0 - s1) > 0.01;
  if (!glass && !progressive && s1 <= 0.01) return;
  BackdropBlur b;
  double reach = backdropReach(p, e, glass, scale);
  Rect own = transformedBounds(m, p.size.x, p.size.y);
  if (glass) {
    // Glass, Figma's (docs/research/rea/effects.md §2.15): the backdrop frosted by "Frost" (the radius, at least 1),
    // read displaced inward within "Depth" (refractionRadius, the node's units) by "Refraction", split by colour by
    // "Dispersion" (× 0.2, Figma's CHROMATIC_EXPANSION_FACTOR), "Splay" (reflectionDistance) turning the displacement
    // from the edge's normal toward the centre's, lit by the light at its angle less the frame's rotation.
    b.kind = BackdropBlur::Kind::Glass;
    double depth = std::max(0.0, x.refractionRadius);
    double refraction = std::clamp(x.refractionIntensity, 0.0, 1.0);
    double dispersion = std::clamp(x.chromaticAberration, 0.0, 1.0) * 0.2;
    constexpr double kPi = 3.14159265358979323846;
    double light = x.specularAngle * kPi / 180 - std::atan2(m.m10, m.m00) + kPi / 2;
    float g0[4] = {static_cast<float>(depth), static_cast<float>(refraction), static_cast<float>(dispersion),
                   static_cast<float>(std::clamp(x.reflectionDistance, 0.0, 1.0))};
    float g1[4] = {static_cast<float>(light), static_cast<float>(std::clamp(x.specularIntensity, 0.0, 1.0)), static_cast<float>(std::max(0.0, x.bevelSize)), 0};
    std::memcpy(b.glass[0], g0, sizeof g0);
    std::memcpy(b.glass[1], g1, sizeof g1);
    // What it reads past where it paints: the displacement (at most the depth, within half the size) and the dispersion.
    b.glassReach = std::min({depth, p.size.x / 2, p.size.y / 2}) * scale * refraction * (1 + dispersion);
    s1 = std::max(s1, scale);
    b.radii[0] = s1;
  } else if (progressive) {
    b.kind = BackdropBlur::Kind::Progressive;
    std::vector<double> lv = blurLevels(s0, s1);
    b.count = static_cast<int>(lv.size());
    for (size_t k = 0; k < lv.size(); k++) b.radii[k] = lv[k];
    b.start = s0;
    b.end = s1;
    float rows2[2][4];
    effectRows(rows2, m, viewport_.scaleX(), viewport_.scaleY(), p.size);
    std::memcpy(b.fx, rows2, sizeof rows2);
    b.fx[2][0] = static_cast<float>(x.startOffset.x), b.fx[2][1] = static_cast<float>(x.startOffset.y);
    b.fx[2][2] = static_cast<float>(x.endOffset.x), b.fx[2][3] = static_cast<float>(x.endOffset.y);
  } else {
    // Uniform: Figma's clamped blur (§2.11) — the backdrop past the node's box (grown by its stroke, a text's glyphs)
    // never bleeds into it. Only that box is copied (and 2 px for the ×2 level's bilinear reads).
    b.radii[0] = s1;
    Rect ink;
    if (p.isTextLike() && texts_)
      if (const text::TextLayout* L = texts_->textLayout(id)) ink = L->inkBounds;
    b.clamped = true;
    b.clampBox = blurClampBox(p, ink);
    b.nodeFromDevice = m.inverse() * Mat2x3{1 / viewport_.scaleX(), 0, 0, 0, 1 / viewport_.scaleY(), 0};
    own = transformedBounds(m * Mat2x3::translate(b.clampBox.x, b.clampBox.y), b.clampBox.w, b.clampBox.h);
    reach = 2;
  }
  gfx::IRect whole = deviceRect(own, reach);
  gfx::IRect r = intersect(whole, layers_[static_cast<size_t>(current_)].rect);
  if (r.w <= 0 || r.h <= 0) return;
  // Where the layer's edge cuts it (left, bottom, right, top — rows from the bottom as the atlas counts them).
  b.cut[0] = r.x > whole.x, b.cut[2] = r.x + r.w < whole.x + whole.w;
  b.cut[3] = r.y > whole.y, b.cut[1] = r.y + r.h < whole.y + whole.h;
  int bi = static_cast<int>(backdrops_.size());
  backdrops_.push_back(b);
  Cmd c;
  c.kind = Cmd::Kind::BackdropBlur;
  c.rect = r;
  c.blurRadius = s1;
  c.layer = bi;
  c.bounds = r;
  Layer& into = layers_[static_cast<size_t>(current_)];
  into.cmds.push_back(c);
  if (into.backdropRects.size() >= kRecentBackdrops) into.backdropRects.erase(into.backdropRects.begin());
  into.backdropRects.push_back(r);
  // The node's shape, painted with the blurred backdrop: once per interval between a progressive blur's levels.
  PaintKind kind = glass ? PaintKind::Glass : progressive ? PaintKind::Progressive : PaintKind::Backdrop;
  int intervals = progressive ? b.count - 1 : 1;
  bool sdf = !p.isPathShape() && !p.invertedCorners() && (p.isRectLike() || p.isFrameLike() || p.type == NodeType::ELLIPSE);
  const NodeGeometry* g = sdf ? nullptr : doc.geometry(id);
  if (!sdf && !g) return;
  int level = levelOf(levelScale(m));
  double tol = toleranceOf(level);
  for (int k = 0; k < intervals; k++) {
    DrawState state;
    state.backdrop = bi;
    state.level = k;
    if (sdf) {
      ShapeKind sk = p.type == NodeType::ELLIPSE ? ShapeKind::Ellipse : ShapeKind::Rect;
      DrawInstance q = makeShape(m, p.size, sk, sk == ShapeKind::Rect ? geom::clampRadii(p.size, p.cornerRadii) : kSquare,
                                 Color{1, 1, 1, 1}, alpha, Color{}, 0, 0, 0);
      q.geom[3] = drawFlags(0, kind);
      emit(q, Pass::Shape, state);
      continue;
    }
    for (size_t i = 0; i < g->fills.size(); i++) {
      uint64_t key = Hash().add(g->fillKey).add(i).add(level).add(0xF111ull).h;
      const CurveEntry* entry = curves_.path(key, [&](std::vector<float>& out) { geom::toQuads(g->fills[i].path, tol, out); });
      if (!entry) continue;
      DrawInstance q{};
      setLinear(q, m);
      q.origin[2] = static_cast<float>(entry->start);
      q.origin[3] = -1;
      for (int j = 0; j < 4; j++) q.box[j] = entry->bounds[j];
      q.geom[2] = static_cast<float>(ShapeKind::Path);
      q.geom[3] = drawFlags(g->fills[i].windingRule == WindingRule::ODD ? DF_EVEN_ODD : 0, kind);
      q.color[0] = q.color[1] = q.color[2] = q.color[3] = static_cast<float>(alpha);
      emit(q, Pass::Path, state);
    }
  }
}

void Renderer::progressiveComposite(int src, float opacity, BlendMode bm, gfx::IRect r, double s0, double s1, const Effect& e,
                                    const Mat2x3& m, Vec2 size) {
  std::vector<double> lv = blurLevels(s0, s1);
  std::vector<int> ids;
  for (double s : lv) {
    if (s <= 0.01) {
      ids.push_back(src);
      continue;
    }
    Layer S;
    S.rect = r;
    S.copyOf = src;
    S.blurRadius = s;
    layers_.push_back(std::move(S));
    stats_.layers++;
    ids.push_back(static_cast<int>(layers_.size() - 1));
  }
  const EffectExtras& x = effectExtras(e);
  float rows2[2][4];
  effectRows(rows2, m, viewport_.scaleX(), viewport_.scaleY(), size);
  for (size_t k = 0; k + 1 < lv.size(); k++) {
    compositeLayer(ids[k], ids[k + 1], 5, opacity, bm, Color{}, {}, false, r);
    Cmd& c = layers_[static_cast<size_t>(current_)].cmds.back();
    c.fxOn = true;
    std::memcpy(c.fx, rows2, sizeof rows2);
    c.fx[2][0] = static_cast<float>(x.startOffset.x), c.fx[2][1] = static_cast<float>(x.startOffset.y);
    c.fx[2][2] = static_cast<float>(x.endOffset.x), c.fx[2][3] = static_cast<float>(x.endOffset.y);
    bool last = k + 2 == lv.size();
    c.fx[3][0] = static_cast<float>(s0), c.fx[3][1] = static_cast<float>(s1);
    c.fx[3][2] = static_cast<float>(lv[k]), c.fx[3][3] = static_cast<float>(last ? lv[k + 1] * 1.001 + 1e-3 : lv[k + 1]);
  }
}

namespace {

// Whether `inner` stays clear of `outer`'s rounded corners (so `outer` ∩ `inner` is `inner`, cut only by
// `outer`'s straight edges — which the scissor does).
bool clearOfCorners(const float outer[4], const float radii[4], const float inner[4]) {
  const float x0 = outer[0], y0 = outer[1], x1 = outer[2], y1 = outer[3];
  if (radii[0] > 0 && inner[0] < x0 + radii[0] && inner[1] < y0 + radii[0]) return false;
  if (radii[1] > 0 && inner[2] > x1 - radii[1] && inner[1] < y0 + radii[1]) return false;
  if (radii[2] > 0 && inner[2] > x1 - radii[2] && inner[3] > y1 - radii[2]) return false;
  if (radii[3] > 0 && inner[0] < x0 + radii[3] && inner[3] > y1 - radii[3]) return false;
  return true;
}

}  // namespace

void Renderer::pushClip(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m) {
  bool square = p.cornerRadii[0] <= 0 && p.cornerRadii[1] <= 0 && p.cornerRadii[2] <= 0 && p.cornerRadii[3] <= 0;
  // Smoothed or inverted corners: the clip is the outline's path.
  const bool pathCorners = p.stroke().cornerSmoothing > 0 || p.invertedCorners() != 0;
  Clip clip{false, scissorEnabled_, scissor_, {}, false, round_};
  for (int i = 0; i < 4; i++) clip.clipRect[i] = clipRect_[i];
  clip.shapeClip = shapeClip_;
  double sx = viewport_.scaleX(), sy = viewport_.scaleY();
  // Clips are anti-aliased at their exact place (Figma clips at the frame's edge, not at whole pixels): the scissor
  // keeps every pixel the clip touches (hard bounds: culling, GPU scissors), the clip rectangle / rounded clip / clip
  // shape cover the pixels on its edge by how much of them is inside.
  Rect box = transformedBounds(m, p.size.x, p.size.y);
  float dev[4] = {static_cast<float>(box.x * sx), static_cast<float>(box.y * sy), static_cast<float>(box.right() * sx),
                  static_cast<float>(box.bottom() * sy)};
  auto scissorTo = [&](const Rect& r) {
    int x0 = static_cast<int>(std::floor(r.x * sx)), y0 = static_cast<int>(std::floor(r.y * sy));
    int x1 = static_cast<int>(std::ceil(r.right() * sx)), y1 = static_cast<int>(std::ceil(r.bottom() * sy));
    if (scissorEnabled_) {
      x0 = std::max(x0, scissor_.x);
      y0 = std::max(y0, scissor_.y);
      x1 = std::min(x1, scissor_.x + scissor_.w);
      y1 = std::min(y1, scissor_.y + scissor_.h);
    } else {
      // No clip rectangle yet: none (whatever is drawn is inside it).
      clipRect_[0] = clipRect_[1] = -1e9f;
      clipRect_[2] = clipRect_[3] = 1e9f;
    }
    scissorEnabled_ = true;
    scissor_ = {x0, y0, std::max(0, x1 - x0), std::max(0, y1 - y0)};
  };
  // The clip rectangle ∩ `r` (device px).
  auto clipRectTo = [&](const float r[4]) {
    clipRect_[0] = std::max(clipRect_[0], r[0]);
    clipRect_[1] = std::max(clipRect_[1], r[1]);
    clipRect_[2] = std::min(clipRect_[2], r[2]);
    clipRect_[3] = std::min(clipRect_[3], r[3]);
  };
  // Whether `r` lies inside the clip rectangle in force (then the shape cutting it also does what the rectangle does,
  // and the rectangle steps aside: two coverages of one edge would multiply).
  auto insideClipRect = [&](const float r[4]) {
    return !scissorEnabled_ || (r[0] >= clipRect_[0] - 1e-3f && r[1] >= clipRect_[1] - 1e-3f && r[2] <= clipRect_[2] + 1e-3f &&
                                r[3] <= clipRect_[3] + 1e-3f);
  };
  auto clearClipRect = [&]() {
    // The scissor still bounds what is drawn (whole pixels around the shape).
    clipRect_[0] = clipRect_[1] = -1e9f;
    clipRect_[2] = clipRect_[3] = 1e9f;
  };
  if (square && nearlyAxisAligned(m)) {
    // Axis-aligned and square: the clip rectangle, intersected with the one in force.
    scissorTo(box);
    clipRectTo(dev);
    clips_.push_back(clip);
    return;
  }
  // Axis-aligned and rounded: an anti-aliased rounded clip in the shaders (no stencil passes, so whatever is
  // inside batches with everything else), when it combines with the one already in force.
  RoundClip next;
  bool rounded = false;
  bool outerRounded = false;  // the rounded clip in force stays, this one is inside it
  if (!square && !pathCorners && nearlyAxisAligned(m)) {
    next.on = true;
    for (int i = 0; i < 4; i++) next.rect[i] = dev[i];
    CornerRadii cr = geom::clampRadii(p.size, p.cornerRadii);
    double k = std::min(std::fabs(m.m00) * sx, std::fabs(m.m11) * sy);
    for (size_t i = 0; i < 4; i++) next.radii[i] = static_cast<float>(cr[i] * k);
    rounded = true;
    if (round_.on) {
      if (clearOfCorners(round_.rect, round_.radii, next.rect)) {
        // Inside the one in force (clear of its corners): this one is the clip; the outer one's straight edges, where
        // this one reaches past them, go into the clip rectangle.
        float outer[4] = {round_.rect[0], round_.rect[1], round_.rect[2], round_.rect[3]};
        bool past = next.rect[0] < outer[0] || next.rect[1] < outer[1] || next.rect[2] > outer[2] || next.rect[3] > outer[3];
        if (past) {
          scissorTo(box);
          clipRectTo(outer);
        }
        outerRounded = !past;
      } else if (clearOfCorners(next.rect, next.radii, round_.rect)) {
        next = round_;  // the one in force is inside this one
        outerRounded = true;
      } else {
        rounded = false;  // two sets of corners: the clip shape (below)
      }
    }
  }
  if (rounded) {
    bool inside = insideClipRect(next.rect);
    scissorTo(box);
    if (inside && !outerRounded) clearClipRect();
    else if (!inside) clipRectTo(dev);
    round_ = next;
    clips_.push_back(clip);
    return;
  }
  // Turned, smoothed, or a second set of corners: the clip shape, anti-aliased by its coverage in the shaders — a
  // rounded box, or the smoothed outline's path. A clip shape already in force: the stencil (whole pixels).
  ShapeClip sc;
  bool shape = false;
  Mat2x3 toDevice = Mat2x3{sx, 0, 0, 0, sy, 0} * m;
  if (std::fabs(toDevice.determinant()) > 1e-12 && shapeClip_ < 0) {
    Mat2x3 inv = toDevice.inverse();
    sc.rows[0][0] = static_cast<float>(inv.m00), sc.rows[0][1] = static_cast<float>(inv.m01), sc.rows[0][2] = static_cast<float>(inv.m02);
    sc.rows[1][0] = static_cast<float>(inv.m10), sc.rows[1][1] = static_cast<float>(inv.m11), sc.rows[1][2] = static_cast<float>(inv.m12);
    if (pathCorners) {
      const NodeGeometry* g = doc.geometry(id);
      int level = levelOf(levelScale(m));
      if (g && !g->fills.empty()) {
        uint64_t key = Hash().add(g->fillKey).add(size_t{0}).add(level).add(0xF111ull).h;
        double tol = toleranceOf(level);
        const CurveEntry* entry = curves_.path(key, [&](std::vector<float>& out) { geom::toQuads(g->fills[0].path, tol, out); });
        if (entry) {
          sc.rows[0][3] = g->fills[0].windingRule == WindingRule::ODD ? 3.f : 2.f;
          sc.rows[1][3] = static_cast<float>(entry->start);
          shape = true;
        }
      }
    } else {
      CornerRadii cr = geom::clampRadii(p.size, p.cornerRadii);
      sc.rows[0][3] = 1;
      sc.size[0] = static_cast<float>(p.size.x);
      sc.size[1] = static_cast<float>(p.size.y);
      for (size_t i = 0; i < 4; i++) sc.radii[i] = static_cast<float>(cr[i]);
      shape = true;
    }
  }
  if (shape) {
    bool inside = insideClipRect(dev);
    scissorTo(box);
    if (inside) clearClipRect();
    shapeClips_.push_back(sc);
    shapeClip_ = static_cast<int>(shapeClips_.size() - 1);
    clips_.push_back(clip);
    return;
  }
  scissorTo(box);
  if (pathCorners) {
    // Smoothed or inverted corners: the path into the stencil.
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
  round_ = clip.round;
  for (int i = 0; i < 4; i++) clipRect_[i] = clip.clipRect[i];
  shapeClip_ = clip.shapeClip;
}

gfx::IRect Renderer::deviceRect(const Rect& css, double margin) const {
  double sx = viewport_.scaleX(), sy = viewport_.scaleY();
  double x0 = css.x * sx - margin, y0 = css.y * sy - margin, x1 = css.right() * sx + margin, y1 = css.bottom() * sy + margin;
  // What can matter: the part being drawn, plus the margin (blurs read past the edge).
  double vx0 = region_.x - margin, vy0 = region_.y - margin, vx1 = region_.x + region_.w + margin, vy1 = region_.y + region_.h + margin;
  x0 = std::max(x0, vx0), y0 = std::max(y0, vy0), x1 = std::min(x1, vx1), y1 = std::min(y1, vy1);
  if (x1 <= x0 || y1 <= y0) return {0, 0, 0, 0};
  int ix0 = static_cast<int>(std::floor(x0)), iy0 = static_cast<int>(std::floor(y0));
  int ix1 = static_cast<int>(std::ceil(x1)), iy1 = static_cast<int>(std::ceil(y1));
  // Large layers are capped (the device's texture size). 2026-10-20: the margins go first, each in proportion to how
  // far it reaches, and the part being drawn stays — capped from the right only, a big margin (a glass's or a blur's
  // reach at a deep zoom: 15,000 px at 25,600 %) left the canvas outside the rectangle, and the glass wasn't drawn.
  int cap = static_cast<int>(device_.caps().maxTextureSize);
  auto fit = [cap](int& lo, int& hi, int keepLo, int keepHi) {
    int over = (hi - lo) - cap;
    if (over <= 0) return;
    int roomLo = std::max(0, keepLo - lo), roomHi = std::max(0, hi - keepHi);
    int room = roomLo + roomHi;
    int cutLo = room > 0 ? std::min(roomLo, static_cast<int>((static_cast<long long>(over) * roomLo + room - 1) / room)) : 0;
    lo += cutLo;
    hi -= std::min(roomHi, over - cutLo);
    hi = std::min(hi, lo + cap);  // the part itself is wider than a texture: its start kept, as before
  };
  fit(ix0, ix1, region_.x, region_.x + region_.w);
  fit(iy0, iy1, region_.y, region_.y + region_.h);
  return {ix0, iy0, ix1 - ix0, iy1 - iy0};
}

Rect Renderer::screenBounds(uint32_t i) const {
  // renderScene: a layer may be anywhere (scrolled, animated): the whole screen.
  if (!cull_) return screen_;
  // The view is a scale and a translation: the world box maps to the screen box exactly.
  const Rect& w = tree_->nodes()[i].visual;
  return {w.x * view_.m00 + view_.m02, w.y * view_.m11 + view_.m12, w.w * view_.m00, w.h * view_.m11};
}

int Renderer::beginLayer(gfx::IRect rect) {
  int saved = current_;
  Layer L;
  L.rect = rect;
  layers_.push_back(std::move(L));
  current_ = static_cast<int>(layers_.size() - 1);
  // A layer starts unclipped (its parent's clip applies when it is composited).
  Clip saved0{false, scissorEnabled_, scissor_, {}, false, round_};
  for (int i = 0; i < 4; i++) saved0.clipRect[i] = clipRect_[i];
  saved0.shapeClip = shapeClip_;
  clips_.push_back(saved0);
  scissorEnabled_ = false;
  round_ = RoundClip{};
  shapeClip_ = -1;
  stencilDepth_ = 0;
  return saved;
}

void Renderer::endLayer(int saved) {
  Clip c = clips_.back();
  clips_.pop_back();
  scissorEnabled_ = c.scissorEnabled;
  scissor_ = c.scissor;
  round_ = c.round;
  for (int i = 0; i < 4; i++) clipRect_[i] = c.clipRect[i];
  shapeClip_ = c.shapeClip;
  // The parent's stencil depth: count the stencil clips still open below.
  stencilDepth_ = 0;
  for (auto& k : clips_) stencilDepth_ += k.stencil ? 1 : 0;
  current_ = saved;
}

void Renderer::drawChildren(const Document& doc, uint32_t first, uint32_t end, const Mat2x3& m, double alpha) {
  const std::vector<RenderNode>& nodes = tree_->nodes();
  // Layers dragged inside their auto-layout flow draw above their siblings (round 15): after them. Ghosts (layers
  // dragged into a flow from elsewhere) aren't drawn here: drawGhosts puts them over everything.
  std::vector<uint32_t> liftedAt;
  auto has = [](const std::vector<Guid>& v, Guid id) { return !v.empty() && std::find(v.begin(), v.end(), id) != v.end(); };
  auto drawLifted = [&]() {
    for (uint32_t k : liftedAt) drawNode(doc, k, m, alpha);
  };
  for (uint32_t i = first; i < end; i = nodes[i].end) {
    if (has(ghosts_, nodes[i].id)) continue;
    if (has(lifted_, nodes[i].id) && !propsAt(i).mask) {
      liftedAt.push_back(i);
      continue;
    }
    const NodeProps& p = propsAt(i);
    if (p.mask && !outlines_) {
      // A mask: it masks the layers above it in this parent (and is not drawn itself).
      Mat2x3 mm = m * p.transform;
      gfx::IRect r = deviceRect(screenBounds(i), 2);
      uint32_t next = nodes[i].end;
      if (r.w <= 0 || r.h <= 0 || next >= end) {
        drawLifted();
        return;
      }
      int saved = beginLayer(r);
      int M = current_;
      if (p.maskType == MaskType::OUTLINE) {
        // The mask's geometry, opaque.
        drawFills(doc, nodes[i].id, p, mm, 1, true);
        if (p.fitsChildren()) drawChildren(doc, i + 1, nodes[i].end, mm, 1);
      } else {
        drawNode(doc, i, m, 1);
      }
      endLayer(saved);
      int saved2 = beginLayer(r);
      int C = current_;
      drawChildren(doc, next, end, m, 1);
      endLayer(saved2);
      Cmd c;
      c.kind = Cmd::Kind::Composite;
      c.pass = stencilDepth_ > 0 ? Pass::CompositeClipped : Pass::Composite;
      c.stencilRef = stencilDepth_;
      c.scissorEnabled = scissorEnabled_;
      c.scissor = scissor_;
      c.round = round_;
      if (scissorEnabled_)
        for (int k = 0; k < 4; k++) c.clipRect[k] = clipRect_[k];
      c.shapeClip = shapeClip_;
      c.layer = C;
      c.aux = M;
      c.mode = p.maskType == MaskType::LUMINANCE ? 2 : 1;
      c.opacity = static_cast<float>(alpha);
      c.rect = r;
      layers_[static_cast<size_t>(current_)].cmds.push_back(c);
      drawLifted();
      return;
    }
    drawNode(doc, i, m, alpha);
  }
  drawLifted();
}

void Renderer::drawGhosts(const Document& doc) {
  // Round 15, round 2 (live Figma): a layer dragged into an auto-layout flow from elsewhere follows the pointer over
  // everything — its new frame doesn't clip it — at 30 % (one layer, composited: its parts don't show through each
  // other).
  for (Guid g : ghosts_) {
    int i = tree_->indexOf(g);
    if (i < 0 || !doc.has(g)) continue;
    gfx::IRect r = deviceRect(screenBounds(static_cast<uint32_t>(i)), 2);
    if (r.w <= 0 || r.h <= 0) continue;
    int saved = beginLayer(r);
    int C = current_;
    drawNode(doc, static_cast<uint32_t>(i), view_ * doc.worldTransform(doc.parentOf(g)), 1);
    endLayer(saved);
    stats_.layers++;
    compositeLayer(C, -1, 0, static_cast<float>(ghostOpacity_), BlendMode::NORMAL, Color{}, {}, false, r);
  }
}

void Renderer::drawContent(const Document& doc, uint32_t i, const NodeProps& p, const Mat2x3& m, double alpha, bool analytic,
                           bool strokes) {
  const RenderNode& rn = tree_->nodes()[i];
  Guid id = rn.id;
  if (analytic) drawAnalyticShadows(p, m, alpha, false);
  if (p.isTextLike()) {
    drawText(doc, p, id, m, alpha);
    if (strokes) drawStrokes(doc, id, p, m, alpha);
    return;
  }
  if (p.isBoolean()) {
    drawFills(doc, id, p, m, alpha);
    if (strokes) drawStrokes(doc, id, p, m, alpha);
    return;
  }
  if (p.isGroupLike()) {
    if (p.type == NodeType::TRANSFORM) drawRepeat(doc, i, m, alpha);
    else drawChildren(doc, i + 1, rn.end, m, alpha);
    return;
  }
  drawFills(doc, id, p, m, alpha);
  if (analytic) drawAnalyticShadows(p, m, alpha, true);
  if (p.isFrameLike()) {
    bool clips = p.clipsContent();
    bool grids = false;
    for (auto& g : p.rare().layoutGrids) grids |= g.visible && layoutGuides_;
    if ((rn.hasChildren && lodLeaf_ != i) || grids) {
      if (clips) pushClip(doc, id, p, m);
      if (lodLeaf_ != i) drawChildren(doc, i + 1, rn.end, m, alpha);
      if (grids) {
        // Layout guides over the frame's content (columns, rows, grid).
        for (const LayoutGrid& g : p.rare().layoutGrids) {
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
          int n = layoutGridCount(g, len);
          if (g.type == LayoutGridType::STRETCH) {
            double w = (len - 2 * g.offset - gutter * (n - 1)) / n;
            for (int i = 0; i < n; i++) band(g.offset + i * (w + gutter), w);
          } else {
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
  if (strokes) drawStrokes(doc, id, p, m, alpha);
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
  c.round = round_;
  if (scissorEnabled_)
    for (int k = 0; k < 4; k++) c.clipRect[k] = clipRect_[k];
  c.shapeClip = shapeClip_;
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

void Renderer::drawNode(const Document& doc, uint32_t i, const Mat2x3& parentCss, double alpha) {
  const RenderNode& rn = tree_->nodes()[i];
  Guid id = rn.id;
  const NodeProps& p = propsAt(i);
  if (p.opacity <= 0 || alpha <= 0) return;
  stats_.nodes++;
  // The layer whose paints are set from here (its children set their own): images drawn are noted as its.
  struct Drawing {
    Guid& slot;
    Guid prev;
    ~Drawing() { slot = prev; }
  } drawing{drawing_, drawing_};
  drawing_ = id;
  // Culling (docs/engine.md §6.8): the whole subtree goes when what it can cover is off screen…
  Rect vb = screenBounds(i);
  Rect padded{vb.x - 2, vb.y - 2, vb.w + 4, vb.h + 4};
  if (cull_ && !padded.intersects(screen_)) {
    stats_.culled++;
    return;
  }
  // …or smaller than a quarter of a device pixel (LOD: what is larger still darkens the pixel it falls on, as in
  // Figma's renders of zoomed-out pages).
  if (cull_ && std::max(vb.w * viewport_.scaleX(), vb.h * viewport_.scaleY()) < 0.25) {
    stats_.tiny++;
    return;
  }
  Mat2x3 m = parentCss * p.transform;
  if (outlines_) return drawOutlined(doc, i, p, m);
  // LOD: a frame or instance a few device pixels across with a fill of its own is drawn as that fill — its children
  // are a handful of pixels on top of it (owner's B2C "Desktop" at fit: 20–27k nodes visited a frame, 21–28 ms).
  // Not in exports, which draw at full size.
  lodLeaf_ = UINT32_MAX;
  if (cull_ && !exporting_ && p.isFrameLike() && tree_->nodes()[i].hasChildren &&
      std::max(vb.w * viewport_.scaleX(), vb.h * viewport_.scaleY()) < kLodContainerPx) {
    for (const Paint& f : p.fillPaints)
      if (f.visible && f.opacity >= 0.5f && (f.type != PaintType::SOLID || f.color.a >= 0.5f)) {
        lodLeaf_ = i;
        break;
      }
  }

  // Figma's effect stage (docs/research/rea/effects.md §2.10, its render-tree builder): the content (with its inner
  // shadows) → the first visible background blur or glass, whichever comes first, under it → the drop shadows (apart
  // while a noise or a texture clipped to the shape is to come) → shader effects → then every layer blur, texture and
  // noise in the list's order, each wrapping what the ones before left: a layer blur and an unclipped texture take the
  // pending drop shadows with them, a noise goes over the content only → the shadows still pending go under → the
  // node's opacity and blend mode. Up to eight drop and eight inner shadows (help 360041488473).
  std::vector<const Effect*> drops, inners, customs, ops;
  const Effect* backdropE = nullptr;
  for (const Effect& e : p.effects) {
    if (!visibleForRendering(e)) continue;
    switch (e.type) {
      case EffectType::DROP_SHADOW:
        if (drops.size() < 8) drops.push_back(&e);
        break;
      case EffectType::INNER_SHADOW:
        if (inners.size() < 8) inners.push_back(&e);
        break;
      case EffectType::BACKGROUND_BLUR:
      case EffectType::GLASS:
        if (!backdropE) backdropE = &e;
        break;
      case EffectType::FOREGROUND_BLUR:
      case EffectType::GRAIN:
      case EffectType::NOISE:
        if (ops.size() < 16) ops.push_back(&e);
        break;
      case EffectType::CUSTOM:
        // Shader effects (round 11) stack in order, each reading what the ones before it left.
        if (customs.size() < 8 && shaderOf(e).preset && shaderOf(e).preset->effect) customs.push_back(&e);
        break;
    }
  }
  // A background blur shows through the layer's fill: none without a visible fill (Figma: "set the layer's fill
  // opacity to any value between .10 and 99.99%"; at 100 % the fill covers it).
  if (backdropE && backdropE->type == EffectType::BACKGROUND_BLUR) {
    bool fill = false;
    for (const Paint& f : p.fillPaints) fill |= f.visible && f.opacity * (f.type == PaintType::SOLID ? f.color.a : 1.f) >= 0.001f;
    if (!fill && !p.isGroupLike()) backdropE = nullptr;
  }
  double scale = levelScale(m);
  // What the list's effects need: how far they draw past the content (device px; they compound, so their reaches add).
  bool anyNoise = false, anyTexture = false, clippedTexture = false, anyProgressive = false, layerBlur = false;
  double reach = 0;
  for (const Effect* e : ops) {
    const EffectExtras& x = effectExtras(*e);
    if (e->type == EffectType::FOREGROUND_BLUR) {
      layerBlur = true;
      double r1 = std::max(0.0, e->radius) * scale;
      double r0 = x.blurOpType == BlurOpType::PROGRESSIVE ? std::max(0.0, x.startRadius) * scale : r1;
      anyProgressive |= std::fabs(r0 - r1) > 0.01;
      reach += std::max(r0, r1);
    } else if (e->type == EffectType::GRAIN) {
      anyTexture = true;
      if (x.clipToShape) clippedTexture = true;
      else reach += std::max(0.0, e->radius) * scale;  // an unclipped texture moves the edge out by up to its radius
    } else {
      anyNoise = true;
    }
  }
  bool analytic = !(anyProgressive || anyTexture || anyNoise || !customs.empty()) && analyticShadows(p, rn.hasChildren);
  bool generic = !analytic && (!drops.empty() || !inners.empty());
  bool container = (p.isFrameLike() || p.isGroupLike()) && rn.hasChildren;
  size_t paints = 0;
  for (auto& f : p.fillPaints) paints += f.visible ? 1 : 0;
  if (p.strokeWeight > 0)
    for (auto& s : p.strokePaints) paints += s.visible ? 1 : 0;
  bool blend = p.blendMode != BlendMode::PASS_THROUGH && p.blendMode != BlendMode::NORMAL;
  bool opacityLayer = p.opacity < 1 && (container || paints > 1 || p.isTextLike() || generic);
  bool needsLayer = opacityLayer || blend || !ops.empty() || generic || !customs.empty();
  double a = alpha * p.opacity;

  // A layer a few device pixels across isn't worth its offscreen pass (owner's B2C "Desktop" page at fit: 31–39
  // layers, 600–900 draw calls, a 22–25 ms frame): its blur, shadows, group opacity and backdrop can't be told apart
  // at that size — drawn straight, its opacity on each paint, no backdrop (not exports, which draw at full size).
  if ((needsLayer || backdropE) && !exporting_) {
    double dw = vb.w * viewport_.scaleX(), dh = vb.h * viewport_.scaleY();
    if (std::max(dw, dh) < kTinyLayerPx) {
      drawContent(doc, i, p, m, a, analytic);
      return;
    }
  }
  if (backdropE) drawBackgroundBlur(doc, id, p, m, a, *backdropE, backdropE->type == EffectType::GLASS);
  if (!needsLayer) {
    drawContent(doc, i, p, m, a, analytic);
    return;
  }
  stats_.layers++;
  double customReach = 0;
  for (const Effect* e : customs) customReach += shaderReach(shaderOf(*e));
  reach += customReach * scale;
  gfx::IRect r = deviceRect(vb, reach + 2);
  if (r.w <= 0 || r.h <= 0) return;
  // Figma's order, top to bottom (help 360041488473): layer blur, stroke paints, inner shadow, fill paints, drop
  // shadow. Inner shadows under visible strokes — the content without its strokes, the inner shadows, then the
  // strokes — except when a layer blur is there too (Figma's builder keeps the strokes in the content then).
  bool strokes = false;
  if (p.strokeWeight > 0)
    for (const Paint& s : p.strokePaints) strokes |= s.visible && s.opacity > 0;
  bool split = generic && !inners.empty() && strokes && !layerBlur;
  int saved = beginLayer(r);
  int C = current_;
  drawContent(doc, i, p, m, 1, analytic);
  endLayer(saved);

  // What the node draws so far, bottom to top: composites of layers (each at its own blend mode), drawn into a layer of
  // their own when an effect must wrap them (materialize) or straight into the parent when nothing does.
  struct Piece {
    int src = -1, aux = -1, mode = 0;
    BlendMode bm = BlendMode::NORMAL;
    Color color;
    Vec2 offset;
    bool knockout = false;
    gfx::IRect rect;
    bool fxOn = false;
    float fx[4][4] = {};
  };
  auto plain = [&](int L) {
    Piece pc;
    pc.src = L;
    pc.rect = r;
    return pc;
  };
  auto isPlain = [](const Piece& pc) {
    return pc.mode == 0 && pc.aux < 0 && !pc.fxOn && (pc.bm == BlendMode::NORMAL || pc.bm == BlendMode::PASS_THROUGH);
  };
  auto emitPiece = [&](const Piece& pc, float opacity, BlendMode bm) {
    compositeLayer(pc.src, pc.aux, pc.mode, opacity, bm, pc.color, pc.offset, pc.knockout, pc.rect);
    if (pc.fxOn) {
      Cmd& c = layers_[static_cast<size_t>(current_)].cmds.back();
      c.fxOn = true;
      std::memcpy(c.fx, pc.fx, sizeof pc.fx);
    }
  };
  auto materialize = [&](std::vector<Piece>& st) {
    if (st.size() == 1 && isPlain(st[0])) return st[0].src;
    int s = beginLayer(r);
    int L = current_;
    for (const Piece& pc : st) emitPiece(pc, 1.f, pc.bm);
    endLayer(s);
    stats_.layers++;
    st = {plain(L)};
    return L;
  };
  auto effectBlend = [](const Effect& e) { return e.blendMode == BlendMode::PASS_THROUGH ? BlendMode::NORMAL : e.blendMode; };
  auto deviceOffset = [&](Vec2 o) { return Vec2{o.x * std::sqrt(std::fabs(m.determinant())) * viewport_.scaleX(), o.y * std::sqrt(std::fabs(m.determinant())) * viewport_.scaleY()}; };
  // Slots 16–17 of the noise and texture: canvas device px → the node's space from its centre (Figma's anchor).
  float centred[2][4];
  effectRows(centred, m, viewport_.scaleX(), viewport_.scaleY(), {1, 1});
  centred[0][2] -= static_cast<float>(p.size.x / 2);
  centred[1][2] -= static_cast<float>(p.size.y / 2);
  auto shadowLayer = [&](const Effect& e, double morph) {
    double blur = std::max(0.0, e.radius) * scale;
    double spread = shadowSpread(p, e) * scale;
    double grow = blur + std::max(0.0, morph > 0 ? spread : 0.0) + 2;
    gfx::IRect sr{r.x - static_cast<int>(std::ceil(grow)), r.y - static_cast<int>(std::ceil(grow)),
                  r.w + 2 * static_cast<int>(std::ceil(grow)), r.h + 2 * static_cast<int>(std::ceil(grow))};
    Layer S;
    S.rect = sr;
    S.copyOf = C;
    S.blurRadius = blur;
    S.morph = morph != 0 ? (morph > 0 ? spread : -std::fabs(spread)) : 0;
    layers_.push_back(std::move(S));
    stats_.layers++;
    return static_cast<int>(layers_.size() - 1);
  };
  // A texture (GRAIN) over layer `src`: a layer of its own reading it through Figma's displacement.
  auto textureOf = [&](int src, const Effect& e) {
    const EffectExtras& x = effectExtras(e);
    int s3 = beginLayer(r);
    int T = current_;
    compositeLayer(src, -1, 7, 1, BlendMode::NORMAL, Color{}, Vec2{static_cast<double>(x.seed % 65536u), 0}, false, r);
    Cmd& c = layers_[static_cast<size_t>(current_)].cmds.back();
    c.fxOn = true;
    std::memcpy(c.fx, centred, sizeof centred);
    c.fx[2][0] = static_cast<float>(std::max(x.noiseSize.x, 1e-3)), c.fx[2][1] = static_cast<float>(std::max(x.noiseSize.y, 1e-3));
    c.fx[2][2] = static_cast<float>(std::max(0.0, e.radius)), c.fx[2][3] = x.clipToShape ? 1.f : 0.f;
    // Slot 19: the node's space → canvas device px (linear part), to move by a displacement in the node's units.
    Mat2x3 d = Mat2x3{viewport_.scaleX(), 0, 0, 0, viewport_.scaleY(), 0} * m;
    c.fx[3][0] = static_cast<float>(d.m00), c.fx[3][1] = static_cast<float>(d.m01);
    c.fx[3][2] = static_cast<float>(d.m10), c.fx[3][3] = static_cast<float>(d.m11);
    endLayer(s3);
    stats_.layers++;
    return T;
  };

  // The content and its inner shadows.
  std::vector<Piece> stack;
  if (split) {
    // The content without its strokes, then (below) the inner shadows, then the strokes.
    int s1 = beginLayer(r);
    int F = current_;
    drawContent(doc, i, p, m, 1, analytic, false);
    endLayer(s1);
    int s2 = beginLayer(r);
    int K = current_;
    drawStrokes(doc, id, p, m, 1);
    endLayer(s2);
    stats_.layers += 2;
    stack.push_back(plain(F));
    for (const Effect* e : inners) {
      Piece pc;
      pc.src = shadowLayer(*e, shadowSpread(p, *e) != 0 ? -1 : 0);
      pc.aux = C, pc.mode = 4, pc.bm = effectBlend(*e), pc.color = e->color, pc.offset = deviceOffset(e->offset), pc.rect = r;
      stack.push_back(pc);
    }
    stack.push_back(plain(K));
  } else {
    stack.push_back(plain(C));
    if (generic)
      for (const Effect* e : inners) {
        Piece pc;
        pc.src = shadowLayer(*e, shadowSpread(p, *e) != 0 ? -1 : 0);
        pc.aux = C, pc.mode = 4, pc.bm = effectBlend(*e), pc.color = e->color, pc.offset = deviceOffset(e->offset), pc.rect = r;
        stack.push_back(pc);
      }
  }
  // The drop shadows, the first at the bottom. "Show behind transparent areas" off (Figma's default): the shadow is
  // hidden under the layer's shape — its geometry, not its alpha (a 50 % fill doesn't let half of it through).
  std::vector<Piece> shadows;
  if (generic && !drops.empty()) {
    int knock = C;
    bool anyHidden = false;
    for (const Effect* e : drops) anyHidden |= !e->showShadowBehindNode;
    if (anyHidden && !opaquePaints(p)) {
      NodeProps solid = opaqueCopy(p);
      int s2 = beginLayer(r);
      knock = current_;
      drawContent(doc, i, solid, m, 1, false);
      endLayer(s2);
      stats_.layers++;
    }
    for (const Effect* e : drops) {
      Piece pc;
      pc.src = shadowLayer(*e, shadowSpread(p, *e));
      Vec2 off = deviceOffset(e->offset);
      gfx::IRect q = layers_[static_cast<size_t>(pc.src)].rect;
      q.x += static_cast<int>(std::floor(off.x));
      q.y += static_cast<int>(std::floor(off.y));
      q.w += 2;
      q.h += 2;
      pc.aux = knock, pc.mode = 3, pc.bm = effectBlend(*e), pc.color = e->color, pc.offset = off, pc.knockout = !e->showShadowBehindNode, pc.rect = q;
      shadows.push_back(pc);
    }
  }
  auto mergeShadows = [&] {
    stack.insert(stack.begin(), shadows.begin(), shadows.end());
    shadows.clear();
  };
  // A texture clipped to the shape textures the drop shadows too, in their own pipeline (Figma's: after the shadow's
  // blur, before it joins anything) — so also when a layer blur or an unclipped texture merges them later.
  if (clippedTexture && !shadows.empty()) {
    int S = materialize(shadows);
    for (const Effect* e : ops)
      if (e->type == EffectType::GRAIN && effectExtras(*e).clipToShape) S = textureOf(S, *e);
    shadows = {plain(S)};
  }
  // Kept apart only while a noise or a clipped texture is to come; else under the content now (so a shader effect, a
  // layer blur or a texture takes them too).
  if (!(anyNoise || clippedTexture)) mergeShadows();
  // Shader effects: each a layer drawn from what is under it.
  if (!customs.empty()) {
    int top = materialize(stack);
    for (const Effect* e : customs) top = shaderLayer(shaderOf(*e), top, r, m, p.size);
    stack = {plain(top)};
  }
  // The list's layer blurs, textures and noises, in order.
  for (const Effect* e : ops) {
    const EffectExtras& x = effectExtras(*e);
    if (e->type == EffectType::FOREGROUND_BLUR) {
      // A layer blur blurs the pending drop shadows too.
      mergeShadows();
      int X = materialize(stack);
      double r1 = std::max(0.0, e->radius) * scale;
      double r0 = x.blurOpType == BlurOpType::PROGRESSIVE ? std::max(0.0, x.startRadius) * scale : r1;
      if (std::fabs(r0 - r1) > 0.01) {
        // Progressive: from "Start" at its start offset to "End".
        int s4 = beginLayer(r);
        int P = current_;
        progressiveComposite(X, 1.f, BlendMode::NORMAL, r, r0, r1, *e, m, p.size);
        endLayer(s4);
        stats_.layers++;
        stack = {plain(P)};
      } else if (X != C && layers_[static_cast<size_t>(X)].blurRadius == 0) {
        layers_[static_cast<size_t>(X)].blurRadius = r1;  // a layer of this stage's own: blurred where it is
      } else if (X == C && !generic && layers_[static_cast<size_t>(C)].blurRadius == 0) {
        layers_[static_cast<size_t>(C)].blurRadius = r1;  // the content, read by nothing else
      } else {
        // Already blurred (a second blur), or read by the shadows: a blurred copy.
        Layer B;
        B.rect = r;
        B.copyOf = X;
        B.blurRadius = r1;
        layers_.push_back(std::move(B));
        stats_.layers++;
        stack = {plain(static_cast<int>(layers_.size() - 1))};
      }
    } else if (e->type == EffectType::GRAIN) {
      // An unclipped texture moves the pending drop shadows too; a clipped one has textured them apart (above).
      if (!x.clipToShape) mergeShadows();
      stack = {plain(textureOf(materialize(stack), *e))};
    } else {
      // Noise: over what the node draws so far, within its alpha, in the effect's blend mode — never over the drop
      // shadows still pending.
      int X = materialize(stack);
      Piece pc;
      pc.src = X, pc.mode = 6, pc.bm = effectBlend(*e), pc.rect = r;
      // Multi's alpha is the effect's opacity (Figma's); Mono / Duo the colour's.
      pc.color = x.noiseType == NoiseType::MULTITONE ? Color{0, 0, 0, static_cast<float>(std::clamp(x.opacity, 0.0, 1.0))} : e->color;
      pc.offset = Vec2{static_cast<double>(x.seed % 65536u), 0};
      pc.fxOn = true;
      std::memcpy(pc.fx, centred, sizeof centred);
      pc.fx[2][0] = static_cast<float>(std::max(x.noiseSize.x, 1e-3)), pc.fx[2][1] = static_cast<float>(std::max(x.noiseSize.y, 1e-3));
      pc.fx[2][2] = static_cast<float>(std::clamp(x.density, 0.0, 1.0));
      pc.fx[2][3] = static_cast<float>(static_cast<int>(x.noiseType) + (x.noiseSize.x <= 1 ? 4 : 0));  // ≤ 1: supersampled
      premultiply(pc.fx[3], x.noiseType == NoiseType::DUOTONE ? x.secondaryColor : Color{0, 0, 0, 0}, 1);
      stack.push_back(pc);
    }
  }
  // The drop shadows still apart go under.
  mergeShadows();
  // The node's opacity and blend mode, last: on the whole when there is more than one piece.
  if (stack.size() > 1 && (a < 1 || blend)) materialize(stack);
  if (stack.size() == 1) {
    const Piece& pc = stack[0];
    emitPiece(pc, static_cast<float>(a), isPlain(pc) ? p.blendMode : pc.bm);
  } else {
    for (const Piece& pc : stack) emitPiece(pc, static_cast<float>(a), pc.bm);
  }
}

void Renderer::strokePolyline(const std::vector<Vec2>& pts, bool closed, double width, const Color& color, double alpha) {
  size_t n = pts.size();
  if (n < 2) return;
  size_t segs = closed ? n : n - 1;
  for (size_t k = 0; k < segs; k++) {
    Vec2 a = pts[k], b = pts[(k + 1) % n];
    Vec2 d = b - a;
    double len = d.length();
    if (len < 1e-9) continue;
    Vec2 u{d.x / len, d.y / len}, nn{-u.y, u.x};
    Mat2x3 sm{u.x, nn.x, a.x - nn.x * width / 2, u.y, nn.y, a.y - nn.y * width / 2};
    emit(makeShape(sm, {len, width}, ShapeKind::Rect, kSquare, color, alpha, color, 0, 0, 0), Pass::Shape);
  }
}

void Renderer::drawOutlined(const Document& doc, uint32_t i, const NodeProps& p, const Mat2x3& m) {
  const RenderNode& rn = tree_->nodes()[i];
  outlineShape(doc, rn.id, p, m, outlineInk_.a);
  if (p.isTextLike()) return;
  if (rn.hasChildren) {
    if (p.type == NodeType::TRANSFORM) drawRepeat(doc, i, m, 1);
    else drawChildren(doc, i + 1, rn.end, m, 1);
  }
}

void Renderer::outlineShape(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m, double alpha) {
  const Color ink{outlineInk_.r, outlineInk_.g, outlineInk_.b, 1};
  if (p.isTextLike()) {
    if (const text::TextLayout* L = texts_ ? texts_->textLayout(id) : nullptr) drawGlyphs(*L, m, ink, alpha);
    return;
  }
  if (!p.isGroupLike()) {
    if ((p.isFrameLike() || p.isRectLike() || p.type == NodeType::ELLIPSE) && !p.invertedCorners()) {
      // The box (or ellipse) with unit-length axes so its line is one CSS px.
      double l0 = std::hypot(m.m00, m.m10), l1 = std::hypot(m.m01, m.m11);
      if (l0 > 0 && l1 > 0) {
        Mat2x3 um{m.m00 / l0, m.m01 / l1, m.m02, m.m10 / l0, m.m11 / l1, m.m12};
        CornerRadii r = kSquare;
        if (p.type != NodeType::ELLIPSE)
          for (size_t k = 0; k < 4; k++) r[k] = p.cornerRadii[k] * l0;
        emit(makeShape(um, {p.size.x * l0, p.size.y * l1}, p.type == NodeType::ELLIPSE ? ShapeKind::Ellipse : ShapeKind::Rect, r, ink, 0, ink, alpha, 1, 0),
             Pass::Shape);
      }
    } else if (const NodeGeometry* g = doc.geometry(id)) {
      auto outline = [&](const geom::Path& path) {
        for (const geom::Polyline& pl : geom::flatten(path.transformed(m), 0.25)) strokePolyline(pl.points, pl.closed, 1, ink, alpha);
      };
      if (!g->fills.empty())
        for (auto& f : g->fills) outline(f.path);
      else if (!g->stroke.path.empty())
        outline(g->stroke.path);
    }
  }
}

void Renderer::drawOutlineOptions(const Document& doc, Guid page, const Mat2x3& view, const Overlay& overlay) {
  // Drawn over the page each frame, not into its cached tiles (a hidden layer's changes don't damage them). What a
  // clipping frame keeps off screen is skipped.
  const Color ink{outlineInk_.r, outlineInk_.g, outlineInk_.b, 1};
  auto visit = [&](auto&& self, Guid parent, const Mat2x3& parentM, bool hiddenAbove) -> void {
    for (Guid c : doc.children(parent)) {
      const Node* n = doc.get(c);
      if (!n) continue;
      const NodeProps& p = n->props;
      bool hidden = hiddenAbove || !p.visible;
      if (hidden && !overlay.outlineHidden) continue;
      Mat2x3 m = parentM * p.transform;
      Rect box = transformedBounds(m, p.size.x, p.size.y);
      bool onScreen = box.intersects(screen_);
      if (hidden && onScreen) outlineShape(doc, c, p, m, outlineInk_.a);
      if (overlay.outlineBounds && onScreen && !p.isGroupLike() && std::max(box.w, box.h) >= 2) {
        // The box with unit-length axes so its line is one CSS px (as drawOutlined's boxes).
        double l0 = std::hypot(m.m00, m.m10), l1 = std::hypot(m.m01, m.m11);
        if (l0 > 0 && l1 > 0) {
          Mat2x3 um{m.m00 / l0, m.m01 / l1, m.m02, m.m10 / l0, m.m11 / l1, m.m12};
          emit(makeShape(um, {p.size.x * l0, p.size.y * l1}, ShapeKind::Rect, kSquare, ink, 0, ink, outlineInk_.a * 0.5, 1, 0), Pass::Shape);
        }
      }
      if (!onScreen && p.isFrameLike() && p.clipsContent()) continue;
      if (!p.isTextLike()) self(self, c, m, hidden);
    }
  };
  visit(visit, page, view, false);
}

void Renderer::drawRepeat(const Document& doc, uint32_t i, const Mat2x3& m, double alpha) {
  const std::vector<RenderNode>& nodes = tree_->nodes();
  const RenderNode& rn = nodes[i];
  const geom::RepeatResult* rep = repeatOf(doc, rn.id);
  if (!rep || rep->instances.size() <= 1) return drawChildren(doc, i + 1, rn.end, m, alpha);
  // Nested groups multiply: at most kMaxRepeatInstances copies of anything, the first ones.
  size_t n = rep->instances.size();
  size_t budget = static_cast<size_t>(std::max(1.0, std::floor(static_cast<double>(geom::kMaxRepeatInstances) / repeatScale_)));
  n = std::min(n, budget);
  // What the children cover on screen (copy 0), to cull each copy (their tree bounds are copy 0's).
  bool culling = cull_;
  Rect content;
  bool any = false;
  if (culling)
    for (uint32_t c = i + 1; c < rn.end; c = nodes[c].end) {
      Rect b = screenBounds(c);
      content = any ? content.united(b) : b;
      any = true;
    }
  Mat2x3 mi = m.inverse();
  double savedScale = repeatScale_;
  repeatScale_ *= static_cast<double>(n);
  for (size_t k = 0; k < n; k++) {
    const Mat2x3& inst = rep->instances[k];
    Mat2x3 mk = m * inst;
    bool identity = inst == Mat2x3{};
    if (culling && any && !identity) {
      Rect r = transformedBounds(mk * mi * Mat2x3::translate(content.x, content.y), content.w, content.h);
      Rect padded{r.x - 2, r.y - 2, r.w + 4, r.h + 4};
      if (!padded.intersects(screen_)) {
        stats_.culled++;
        continue;
      }
    }
    // A copy isn't where the tree's bounds say: drawn without culling (as pattern tiles are).
    cull_ = culling && identity;
    drawChildren(doc, i + 1, rn.end, mk, alpha);
  }
  cull_ = culling;
  repeatScale_ = savedScale;
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

namespace {

// Pool sizes: 64 px steps up to 1024, 256 px steps above (fewer sizes to keep: a zoom changes layers' sizes every
// frame).
int poolSize(int v) { return v <= 1024 ? roundUp(v, 64) : roundUp(v, 256); }
uint64_t targetBytes(int w, int h) { return static_cast<uint64_t>(w) * static_cast<uint64_t>(h) * 8; }  // colour + stencil

}  // namespace

void Renderer::setShapeClip(gfx::DrawCall& call, int index) const {
  if (index < 0 || index >= static_cast<int>(shapeClips_.size())) return;  // slot 12.w = 0: none
  const ShapeClip& sc = shapeClips_[static_cast<size_t>(index)];
  for (int i = 0; i < 4; i++) {
    call.uniforms[12][i] = sc.rows[0][i];
    call.uniforms[13][i] = sc.rows[1][i];
    call.uniforms[14][i] = sc.size[i];
    call.uniforms[15][i] = sc.radii[i];
  }
}

Renderer::PoolTarget* Renderer::acquire(int w, int h) {
  int bw = poolSize(w), bh = poolSize(h);
  for (auto& t : pool_)
    if (!t.busy && t.w == bw && t.h == bh) {
      t.busy = true;
      t.lastUsed = frame_;
      return &t;
    }
  // Within the budget: idle targets go first, least recently used first (layers of other sizes from earlier
  // frames — during a zoom every frame's are new — must not pile up on the GPU).
  uint64_t need = targetBytes(bw, bh);
  while (poolBytes() + need > kPoolBudgetBytes) {
    auto victim = pool_.end();
    for (auto it = pool_.begin(); it != pool_.end(); ++it)
      if (!it->busy && (victim == pool_.end() || it->lastUsed < victim->lastUsed)) victim = it;
    if (victim == pool_.end()) break;  // everything is in use this frame
    device_.destroyTarget(victim->target);
    pool_.erase(victim);  // the other targets stay where they are: callers hold pointers to them
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

void Renderer::dropIdleTargets() {
  for (auto it = pool_.begin(); it != pool_.end();) {
    if (frame_ - it->lastUsed > 30) {
      device_.destroyTarget(it->target);
      it = pool_.erase(it);
    } else {
      ++it;
    }
  }
}

uint64_t Renderer::poolBytes() const {
  uint64_t b = 0;
  for (const PoolTarget& t : pool_) b += targetBytes(t.w, t.h);
  return b;
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
  // Figma skips a blur under one device px.
  const double blur = L.blurRadius >= 1 ? L.blurRadius : 0;
  if (blur <= 0 && L.morph == 0) return;
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
    return openPass(pd);
  };
  // A clamped tent (mode 3): slots 4–8 = the target's px → the node's space, the clamp box, and back.
  float clampRows[5][4] = {};
  auto blurPass = [&](PoolTarget* src, PoolTarget* dst, int vw, int vh, float dx, float dy, float tent, int mode, float radius) {
    if (!pass(dst, vw, vh)) return;
    gfx::DrawCall call;
    call.textures[3] = white_;  // Composite: the curves (a clip path), else unused
    call.pipeline = pipelines_[static_cast<int>(Pass::Blur)];
    call.instanceCount = 1;
    call.uniforms[2][0] = dx, call.uniforms[2][1] = dy, call.uniforms[2][2] = tent, call.uniforms[2][3] = static_cast<float>(mode);
    call.uniforms[3][0] = radius;
    if (mode == 3) std::memcpy(call.uniforms[4], clampRows, sizeof clampRows);
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
  double scale = 1;
  int cw = w, ch = h;
  // Figma's renderBlur: a blur over 4 texels runs on the layer halved once (one bilinear fetch) with half the radius,
  // then is scaled back up bilinearly by the composite; one past 64 texels is halved again until it isn't (Figma draws
  // such a layer smaller first), at most 32×.
  while ((blur * scale > 64 || (scale == 1 && blur > 4)) && scale > 1.0 / 32) {
    int nw = std::max(1, (cw + 1) / 2), nh = std::max(1, (ch + 1) / 2);
    PoolTarget* down = acquire(nw, nh);
    if (!down || !pass(down, nw, nh)) break;
    gfx::DrawCall call;
    call.textures[3] = white_;  // Composite: the curves (a clip path), else unused
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
  if (blur > 0) {
    int mode = 0;
    if (L.clamped) {
      // The target's px (gl_FragCoord: x right, y up from the layer's bottom) → canvas device px → the node's space.
      Mat2x3 texelToDevice{1 / scale, 0, static_cast<double>(L.rect.x), 0, -1 / scale, L.rect.y + ch / scale};
      Mat2x3 toNode = L.nodeFromDevice * texelToDevice;
      Mat2x3 back = toNode.inverse();
      const Rect& B = L.clampBox;
      float rows5[5][4] = {{static_cast<float>(toNode.m00), static_cast<float>(toNode.m01), static_cast<float>(toNode.m02), 0},
                           {static_cast<float>(toNode.m10), static_cast<float>(toNode.m11), static_cast<float>(toNode.m12), 0},
                           {static_cast<float>(B.x), static_cast<float>(B.y), static_cast<float>(B.right()), static_cast<float>(B.bottom())},
                           {static_cast<float>(back.m00), static_cast<float>(back.m01), static_cast<float>(back.m02), 0},
                           {static_cast<float>(back.m10), static_cast<float>(back.m11), static_cast<float>(back.m12), 0}};
      std::memcpy(clampRows, rows5, sizeof rows5);
      mode = 3;
    }
    PoolTarget* tmp = acquire(cw, ch);
    if (tmp && tmp->w == cur->w && tmp->h == cur->h) {
      blurPass(cur, tmp, cw, ch, 1, 0, static_cast<float>(blur * scale), mode, 0);
      blurPass(tmp, cur, cw, ch, 0, 1, static_cast<float>(blur * scale), mode, 0);
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
    if (c.kind == Cmd::Kind::Shader && c.layer >= 0) runLayer(c.layer);  // the layer a shader effect reads
    if (c.kind != Cmd::Kind::Composite) continue;
    if (c.layer >= 0) runLayer(c.layer);
    if (c.aux >= 0) runLayer(c.aux);
  }
  Layer& L = layers_[static_cast<size_t>(index)];
  if (L.rect.w <= 0 || L.rect.h <= 0) return doneReading(index);
  PoolTarget* t = acquire(L.rect.w, L.rect.h);
  if (!t) return doneReading(index);
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
    if (openPass(pd) && src.texture) {
      gfx::DrawCall call;
      call.textures[3] = white_;  // Composite: the curves (a clip path), else unused
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
    runCmds(L, t->target, {0, 0, L.rect.w, L.rect.h}, transparent, false);
  }
  blurLayer(layers_[static_cast<size_t>(index)]);
  doneReading(index);
}

void Renderer::doneReading(int index) {
  eachRead(layers_[static_cast<size_t>(index)], [&](int k) {
    Layer& src = layers_[static_cast<size_t>(k)];
    if (k == 0 || --src.readers > 0 || !src.target) return;
    release(src.target);
    src.target = 0;
    src.texture = 0;  // read by nothing more this frame
  });
}

void Renderer::runCmds(Layer& L, gfx::TargetId target, gfx::IRect viewport, const float clear[4], bool keep) {
  gfx::PassDesc pd;
  pd.target = target;
  pd.viewport = viewport;
  pd.keep = keep;
  for (int i = 0; i < 4; i++) pd.clear[i] = clear[i];
  if (!openPass(pd)) return;
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
  auto run = [&](const Cmd& c) {
    if (c.kind == Cmd::Kind::Draw) {
      gfx::DrawCall call;
      call.textures[3] = white_;  // Composite: the curves (a clip path), else unused
      call.pipeline = pipelines_[static_cast<int>(c.pass)];
      call.instances = {buffer_, static_cast<uint32_t>(c.first * sizeof(DrawInstance)), static_cast<uint32_t>(c.count * sizeof(DrawInstance))};
      call.instanceCount = c.count;
      for (int i = 0; i < 4; i++) call.uniforms[0][i] = cssRows[0][i], call.uniforms[1][i] = cssRows[1][i];
      for (int i = 0; i < 4; i++) call.uniforms[2][i] = c.state.filters[i], call.uniforms[3][i] = c.state.filters[4 + i];
      // Where this pass lies on the canvas (instances' clip rectangles are in canvas device px).
      call.uniforms[5][0] = static_cast<float>(ox);
      call.uniforms[5][1] = static_cast<float>(oy);
      call.uniforms[5][2] = static_cast<float>(H);
      setShapeClip(call, c.state.clip);
      call.textures[0] = curveTexture_ ? curveTexture_ : white;
      call.textures[1] = ramp_ ? ramp_ : white;
      call.textures[2] = c.state.image ? c.state.image : white;
      if (c.state.backdrop >= 0) {
        const BackdropBlur& b = backdrops_[static_cast<size_t>(c.state.backdrop)];
        int k = std::clamp(c.state.level, 0, b.count - 1);
        if (b.kind == BackdropBlur::Kind::Progressive) {
          // The interval between levels k (u_t3, slot 7) and k + 1 (u_t2, slot 4); slots 16–18 the node's box and the
          // effect's start / end, 19 = (the radius at the start, at the end, the interval's two radii).
          int k1 = std::min(k + 1, b.count - 1);
          if (!b.textures[k] || !b.textures[k1]) return;
          call.textures[3] = b.textures[k];
          call.textures[2] = b.textures[k1];
          for (int i = 0; i < 4; i++) call.uniforms[7][i] = b.places[k][i], call.uniforms[4][i] = b.places[k1][i];
          for (int i = 0; i < 4; i++) call.uniforms[10][i] = b.slots[k][i], call.uniforms[9][i] = b.slots[k1][i];
          for (int j = 0; j < 3; j++)
            for (int i = 0; i < 4; i++) call.uniforms[16 + j][i] = b.fx[j][i];
          bool last = k1 == b.count - 1;
          call.uniforms[19][0] = static_cast<float>(b.start), call.uniforms[19][1] = static_cast<float>(b.end);
          call.uniforms[19][2] = static_cast<float>(b.radii[k]);
          call.uniforms[19][3] = static_cast<float>(last ? b.radii[k1] * 1.001 + 1e-3 : b.radii[k1]);
        } else {
          if (!b.textures[0]) return;
          call.textures[2] = b.textures[0];
          for (int i = 0; i < 4; i++) call.uniforms[4][i] = b.places[0][i], call.uniforms[9][i] = b.slots[0][i];
          if (b.kind == BackdropBlur::Kind::Glass)
            for (int i = 0; i < 4; i++) call.uniforms[6][i] = b.glass[0][i], call.uniforms[8][i] = b.glass[1][i];
        }
      }
      localScissor(call, c);
      device_.draw(call);
      stats_.drawCalls++;
    } else if (c.kind == Cmd::Kind::Composite) {
      const Layer& src = layers_[static_cast<size_t>(c.layer)];
      if (!src.texture) return;
      gfx::IRect quad = intersect(c.rect, L.rect);
      if (quad.w <= 0 || quad.h <= 0) return;
      gfx::DrawCall call;
      call.textures[3] = white_;  // Composite: the curves (a clip path), else unused
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
      if (c.fxOn)
        for (int j = 0; j < 4; j++)
          for (int i = 0; i < 4; i++) call.uniforms[16 + j][i] = c.fx[j][i];
      if (c.round.on)
        for (int i = 0; i < 4; i++) call.uniforms[9][i] = c.round.rect[i], call.uniforms[10][i] = c.round.radii[i];
      for (int i = 0; i < 4; i++) call.uniforms[11][i] = c.clipRect[i];
      setShapeClip(call, c.shapeClip);
      if (curveTexture_) call.textures[3] = curveTexture_;
      localScissor(call, c);
      device_.draw(call);
      stats_.drawCalls++;
    } else if (c.kind == Cmd::Kind::Shader) {
      // A shader paint's or effect's quad (round 11, gfx/gl/CustomShader.h), into this layer of its own.
      gfx::IRect quad = intersect(c.rect, L.rect);
      if (quad.w <= 0 || quad.h <= 0 || c.aux < 0 || c.aux >= static_cast<int>(shaderCalls_.size())) return;
      gfx::DrawCall call;
      std::memcpy(call.uniforms, shaderCalls_[static_cast<size_t>(c.aux)].u, sizeof call.uniforms);
      call.pipeline = pipelines_[static_cast<int>(Pass::Shader)];
      call.instanceCount = 1;
      compositeUniforms(call, devRows, quad);
      for (int t = 0; t < gfx::DrawCall::kTextures; t++) call.textures[t] = white;
      if (c.layer >= 0) {
        const Layer& src = layers_[static_cast<size_t>(c.layer)];
        if (!src.texture) return;  // an effect with nothing under it draws nothing
        place(call.uniforms[3], src.rect.x, src.rect.y, src.contentH, src.scale);
        call.textures[0] = src.texture;
      }
      device_.draw(call);
      stats_.drawCalls++;
    } else if (c.kind == Cmd::Kind::Blit) {
      // The content cache onto the canvas (scaled while a zoom settles).
      gfx::IRect quad = intersect(c.rect, L.rect);
      if (quad.w <= 0 || quad.h <= 0 || !c.blitTexture) return;
      gfx::DrawCall call;
      call.textures[3] = white_;  // Composite: the curves (a clip path), else unused
      call.pipeline = pipelines_[static_cast<int>(Pass::Composite)];
      call.instanceCount = 1;
      compositeUniforms(call, devRows, quad);
      call.uniforms[3][0] = static_cast<float>(c.blitOrigin.x);
      call.uniforms[3][1] = static_cast<float>(c.blitOrigin.y);
      call.uniforms[3][2] = static_cast<float>(c.blitHeight);
      call.uniforms[3][3] = static_cast<float>(c.blitScale);
      call.textures[0] = c.blitTexture;
      call.textures[1] = white;
      call.textures[2] = white;
      call.uniforms[7][0] = 1;
      call.uniforms[7][1] = static_cast<float>(BlendMode::NORMAL);
      device_.draw(call);
      stats_.drawCalls++;
    }
  };
  // The background blurs' scheduler (see the declaration), in waves: a wave runs what lies clear of every capture it
  // holds and of everything it holds back, gathers the captures whose backdrops are complete, holds back what lies
  // over them — and a background blur over something held back, which can't be captured yet (its backdrop holds
  // that), with whatever lies over it. The wave's captures are taken in one break of the pass; the next wave takes
  // what was held back, in order. So blurs in blurred containers cost a capture per level of nesting, not per pair.
  auto boundsOf = [&](const Cmd& c) -> gfx::IRect {
    if (c.kind == Cmd::Kind::Draw) return c.bounds;
    gfx::IRect r = c.rect;
    if (c.scissorEnabled) r = intersect(r, c.scissor);
    return r;
  };
  auto any = [](const std::vector<gfx::IRect>& rs, gfx::IRect b) {
    for (const gfx::IRect& r : rs)
      if (overlaps(b, r)) return true;
    return false;
  };
  std::vector<const Cmd*> queue;
  queue.reserve(L.cmds.size());
  for (const Cmd& c : L.cmds) queue.push_back(&c);
  std::vector<const Cmd*> grabs, held;
  std::vector<gfx::IRect> grabRects, heldRects;
  std::vector<int> grabbed, heldBlurs;  // backdrops_ indices
  while (!queue.empty()) {
    grabs.clear(), held.clear(), grabRects.clear(), heldRects.clear(), grabbed.clear(), heldBlurs.clear();
    for (const Cmd* c : queue) {
      if (c->kind == Cmd::Kind::BackdropBlur) {
        gfx::IRect r = intersect(c->rect, L.rect);
        if (r.w <= 0 || r.h <= 0) continue;
        if (any(heldRects, r)) {
          held.push_back(c);
          heldRects.push_back(r);
          heldBlurs.push_back(c->layer);
        } else {
          grabs.push_back(c);
          grabRects.push_back(r);
          grabbed.push_back(c->layer);
        }
        continue;
      }
      if (!grabs.empty() || !held.empty()) {
        gfx::IRect b = boundsOf(*c);
        bool paints = c->kind == Cmd::Kind::Draw && c->state.backdrop >= 0 &&
                      (std::find(grabbed.begin(), grabbed.end(), c->state.backdrop) != grabbed.end() ||
                       std::find(heldBlurs.begin(), heldBlurs.end(), c->state.backdrop) != heldBlurs.end());
        if (paints || any(grabRects, b) || any(heldRects, b)) {
          held.push_back(c);
          heldRects.push_back(b);
          continue;
        }
      }
      run(*c);
    }
    if (!grabs.empty() && !captureBackdrops(L, pd, grabs)) return;
    queue.swap(held);
  }
  device_.endPass();
}

bool Renderer::captureBackdrops(Layer& L, const gfx::PassDesc& pd, const std::vector<const Cmd*>& grabs) {
  // Round 18: every backdrop of the capture (each level of a progressive blur) goes into one atlas — copied in one
  // step, halved for the big radii (Figma's renderBlur: once over 4 texels, again past 64) by one pass over the whole
  // atlas per level, and tent-blurred by two passes per level, one draw per backdrop clipped to its slot. A slot is
  // its copy plus a margin the blur can read into: 2 px (the ×2 level's bilinear reads) for a clamped blur whose
  // whole box was copied (taps outside the box weigh nothing), else the radius + 2 — cleared to transparent, as the
  // copy's surroundings were (round 17). Slots are aligned to the deepest level's step, so each level is the atlas
  // scaled exactly.
  const int ox = L.rect.x, oy = L.rect.y, H = pd.viewport.h;
  stats_.captures++;
  stats_.backdrops += static_cast<uint32_t>(grabs.size());
  struct Item {
    BackdropBlur* b;
    int level;            // of the backdrop (a progressive blur has several)
    gfx::IRect r, local;  // canvas device px, and in this pass
    bool clamped;
    double radius;        // device px
    int depth = 0;        // halvings (scale 2^−depth)
    int pad = 2;
    int page = 0, sx = 0, sy = 0, sw = 0, sh = 0;  // the slot: atlas page, texels at full size, rows from the bottom
    bool cut[4] = {false, false, false, false};     // the layer's edge cut it: left, bottom, right, top
  };
  std::vector<Item> items;
  int deepest = 0;
  for (const Cmd* c : grabs) {
    BackdropBlur& b = backdrops_[static_cast<size_t>(c->layer)];
    gfx::IRect r = intersect(c->rect, L.rect);
    bool cut = r.x != c->rect.x || r.y != c->rect.y || r.w != c->rect.w || r.h != c->rect.h || b.cut[0] || b.cut[1] || b.cut[2] || b.cut[3];
    for (int k = 0; k < b.count; k++) {
      Item it{&b, k, r, {r.x - ox, r.y - oy, r.w, r.h}, b.clamped, b.radii[k] >= 1 ? b.radii[k] : 0};
      it.cut[0] = b.cut[0] || r.x > c->rect.x, it.cut[2] = b.cut[2] || r.x + r.w < c->rect.x + c->rect.w;
      it.cut[3] = b.cut[3] || r.y > c->rect.y, it.cut[1] = b.cut[1] || r.y + r.h < c->rect.y + c->rect.h;
      double scale = 1;
      while (it.radius > 0 && (it.radius * scale > 64 || (scale == 1 && it.radius > 4)) && it.depth < kMaxBackdropDepth) scale /= 2, it.depth++;
      // Glass reads its frost displaced from where it paints (drawBackgroundBlur's glassReach).
      double bend = b.kind == BackdropBlur::Kind::Glass ? b.glassReach : 0;
      // At most kMaxBackdropPad: past it the readers clamp to the slot, whose border holds what lies past it (the
      // margin cleared where the copy wasn't cut, its edge repeated where it was). Exact for the tent's input at any
      // margin; what the glass reads past the margin is the blurred border's (only where the canvas's edge cut it).
      it.pad = it.clamped && !cut ? 2 : std::min(kMaxBackdropPad, static_cast<int>(std::ceil(it.radius + bend)) + 2);
      deepest = std::max(deepest, it.depth);
      items.push_back(it);
    }
  }
  if (items.empty()) return true;
  // Shelves, tallest first, at most kAtlasMax wide and high (more pages when they don't fit). Slots align to the
  // deepest level's step (32 at most); a backdrop halved further (a huge blur: glass at a deep zoom) takes a page of
  // its own aligned to its step, so it doesn't round every slot up with it.
  constexpr int kSharedDepth = 5;
  const int A = 1 << std::min(deepest, kSharedDepth);
  const int kAtlasMax = std::min<int>(4096, static_cast<int>(std::max<uint32_t>(device_.caps().maxTextureSize, 2048)));
  std::vector<size_t> order(items.size());
  for (size_t i = 0; i < order.size(); i++) order[i] = i;
  for (Item& it : items) {
    const int step = it.depth > kSharedDepth ? 1 << it.depth : A;
    it.sw = roundUp(it.r.w + 2 * it.pad, step), it.sh = roundUp(it.r.h + 2 * it.pad, step);
  }
  std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) {
    bool da = items[a].depth > kSharedDepth, db = items[b].depth > kSharedDepth;
    return da != db ? db : items[a].sh > items[b].sh;  // the shared pages first, then the deep ones
  });
  struct Page {
    int w = 0, h = 0;
    PoolTarget* levels[kMaxBackdropDepth + 1] = {};  // depth 0 … kMaxBackdropDepth
  };
  std::vector<Page> pages(1);
  int x = 0, y = 0, shelf = 0;
  for (size_t i : order) {
    Item& it = items[i];
    if (it.depth > kSharedDepth && (x > 0 || y > 0)) pages.push_back({}), x = 0, y = 0, shelf = 0;
    if (x + it.sw > kAtlasMax && x > 0) y += shelf, x = 0, shelf = 0;
    if (y + it.sh > kAtlasMax && y > 0) pages.push_back({}), x = 0, y = 0, shelf = 0;
    it.page = static_cast<int>(pages.size()) - 1;
    it.sx = x, it.sy = y;
    x += it.sw;
    shelf = std::max(shelf, it.sh);
    Page& pg = pages.back();
    pg.w = std::max(pg.w, x), pg.h = std::max(pg.h, y + shelf);
  }
  // Each page's copies, in one step each, while this layer's pass is still the source.
  for (size_t p = 0; p < pages.size(); p++) {
    Page& pg = pages[p];
    pg.levels[0] = acquire(pg.w, pg.h);
    if (!pg.levels[0]) continue;
    std::vector<gfx::Device::CopyRegion> regions;
    for (const Item& it : items) {
      if (it.page != static_cast<int>(p)) continue;
      gfx::Device::CopyRegion c{it.local, it.sx + it.pad, it.sy + it.pad};
      // Where the layer's edge cut the backdrop, its edge goes on across the margin (a clamped texture's reads, as the
      // copy at the target's origin gave before round 18 — a fresh draw and a pan agree).
      for (int i = 0; i < 4; i++) c.grow[i] = it.cut[i] ? it.pad : 0;
      regions.push_back(c);
    }
    device_.copyRegionsToTexture(pg.levels[0]->texture, regions, true);
  }
  device_.endPass();
  auto pass = [&](PoolTarget* dst, int vw, int vh) {
    gfx::PassDesc d;
    d.target = dst->target;
    for (int i = 0; i < 4; i++) d.clear[i] = 0;
    d.viewport = {0, 0, vw, vh};
    return openPass(d);
  };
  for (size_t p = 0; p < pages.size(); p++) {
    Page& pg = pages[p];
    if (!pg.levels[0]) continue;
    int pageDeepest = 0;
    bool unblurred = false;  // a backdrop under a pixel of blur reads the full-size atlas itself
    for (const Item& it : items)
      if (it.page == static_cast<int>(p)) pageDeepest = std::max(pageDeepest, it.depth), unblurred |= it.radius <= 0;
    // A level goes back to the pool as soon as nothing reads it any more (the pool's budget: a few screen-sized
    // backdrops fill it).
    auto done = [&](int d) {
      if (!pg.levels[d]) return;
      if (d == 0 && unblurred) scratch_.push_back(pg.levels[0]->target);
      else release(pg.levels[d]->target);
      pg.levels[d] = nullptr;
    };
    for (int d = 0; d <= pageDeepest; d++) {
      const double s = std::ldexp(1.0, -d);
      const int vw = pg.w >> d, vh = pg.h >> d;
      if (d > 0) {
        // The whole atlas halved: one bilinear fetch per texel (renderBlur's downscale).
        PoolTarget* down = acquire(vw, vh);
        if (!down || !pass(down, vw, vh)) break;
        pg.levels[d] = down;
        gfx::DrawCall call;
        call.textures[3] = white_;
        call.pipeline = pipelines_[static_cast<int>(Pass::CompositeReplace)];
        call.instanceCount = 1;
        float rr[2][4];
        rows(rr, s, s, 0, 0, vw, vh);
        compositeUniforms(call, rr, {0, 0, pg.w, pg.h});
        place(call.uniforms[3], 0, 0, pg.h >> (d - 1), s * 2);
        call.uniforms[7][0] = 1;
        call.uniforms[7][1] = 1;
        call.textures[0] = pg.levels[d - 1]->texture;
        call.textures[1] = call.textures[2] = white_;
        device_.draw(call);
        stats_.drawCalls++;
        device_.endPass();
        done(d - 1);  // its blur ran in the iteration before
      }
      std::vector<Item*> here;
      gfx::TextureId atlas0 = pg.levels[0] ? pg.levels[0]->texture : 0;
      int atlas0W = pg.levels[0] ? pg.levels[0]->w : 0, atlas0H = pg.levels[0] ? pg.levels[0]->h : 0;
      for (Item& it : items)
        if (it.page == static_cast<int>(p) && it.depth == d && it.radius > 0) here.push_back(&it);
      PoolTarget* out = nullptr;
      if (!here.empty()) {
        // The tent, across then down, one draw per backdrop within its slot.
        PoolTarget* across = acquire(vw, vh);
        out = acquire(vw, vh);
        if (!across || !out) break;
        for (int dir = 0; dir < 2; dir++) {
          PoolTarget* dst = dir == 0 ? across : out;
          gfx::TextureId src = dir == 0 ? pg.levels[d]->texture : across->texture;
          if (!pass(dst, vw, vh)) break;
          for (Item* it : here) {
            gfx::DrawCall call;
            call.textures[3] = white_;
            call.pipeline = pipelines_[static_cast<int>(Pass::Blur)];
            call.instanceCount = 1;
            int mode = 0;
            if (it->clamped) {
              // The atlas's texels at this level (gl_FragCoord: rows from the bottom) → canvas device px → the node.
              const int cx = it->sx + it->pad, cy = it->sy + it->pad;
              Mat2x3 texelToDevice{1 / s, 0, static_cast<double>(it->r.x - cx), 0, -1 / s, static_cast<double>(it->r.y + it->r.h + cy)};
              Mat2x3 toNode = it->b->nodeFromDevice * texelToDevice;
              Mat2x3 back = toNode.inverse();
              const Rect& B = it->b->clampBox;
              float rows5[5][4] = {{static_cast<float>(toNode.m00), static_cast<float>(toNode.m01), static_cast<float>(toNode.m02), 0},
                                   {static_cast<float>(toNode.m10), static_cast<float>(toNode.m11), static_cast<float>(toNode.m12), 0},
                                   {static_cast<float>(B.x), static_cast<float>(B.y), static_cast<float>(B.right()), static_cast<float>(B.bottom())},
                                   {static_cast<float>(back.m00), static_cast<float>(back.m01), static_cast<float>(back.m02), 0},
                                   {static_cast<float>(back.m10), static_cast<float>(back.m11), static_cast<float>(back.m12), 0}};
              std::memcpy(call.uniforms[4], rows5, sizeof rows5);
              mode = 3;
            }
            call.uniforms[2][0] = dir == 0 ? 1.f : 0.f, call.uniforms[2][1] = dir == 0 ? 0.f : 1.f;
            call.uniforms[2][2] = static_cast<float>(it->radius * s), call.uniforms[2][3] = static_cast<float>(mode);
            call.textures[0] = src;
            // The slot at this level (scissors are top-left: the pass's rows flipped); the taps clamp to it.
            int sx = it->sx >> d, sy = it->sy >> d, sw = it->sw >> d, sh = it->sh >> d;
            // Where the layer's edge cut the copy, its taps stop at the copy's edge (a clamped texture's reads: the
            // margin there repeats the edge, but not into its corners — those are cleared — and a tent wider than the
            // slot would read them); elsewhere at the slot's edge (the cleared margin).
            const double cx0 = (it->sx + it->pad) * s, cy0 = (it->sy + it->pad) * s;
            call.uniforms[9][0] = static_cast<float>(it->cut[0] ? cx0 : sx);
            call.uniforms[9][1] = static_cast<float>(it->cut[1] ? cy0 : sy);
            call.uniforms[9][2] = static_cast<float>(it->cut[2] ? cx0 + it->r.w * s : sx + sw);
            call.uniforms[9][3] = static_cast<float>(it->cut[3] ? cy0 + it->r.h * s : sy + sh);
            for (int a = 0; a < 2; a++)  // at least a texel (the shader clamps half a texel in from each side)
              if (call.uniforms[9][a + 2] - call.uniforms[9][a] < 1) {
                float mid = (call.uniforms[9][a] + call.uniforms[9][a + 2]) / 2;
                call.uniforms[9][a] = mid - 0.5f, call.uniforms[9][a + 2] = mid + 0.5f;
              }
            call.scissorEnabled = true;
            call.scissor = {sx, vh - sy - sh, sw, sh};
            device_.draw(call);
            stats_.drawCalls++;
          }
          device_.endPass();
        }
        release(across->target);
        scratch_.push_back(out->target);
      }
      // Where each backdrop of this level ended up: gl_FragCoord (this layer's pass, rows from the bottom) → its uv.
      for (Item& it : items) {
        if (it.page != static_cast<int>(p) || it.depth != d) continue;
        gfx::TextureId tex = it.radius > 0 ? (out ? out->texture : 0) : atlas0;
        if (!tex) continue;
        int tw = it.radius > 0 ? out->w : atlas0W, th = it.radius > 0 ? out->h : atlas0H;
        BackdropBlur& b = *it.b;
        b.textures[it.level] = tex;
        b.places[it.level][0] = static_cast<float>(it.local.x - (it.sx + it.pad));
        b.places[it.level][1] = static_cast<float>(H - it.local.y - it.local.h - (it.sy + it.pad));
        b.places[it.level][2] = static_cast<float>(tw / s);
        b.places[it.level][3] = static_cast<float>(th / s);
        // Its slot at this level as uv, half a texel in: the paint's reads past it take its border.
        const int ld = it.radius > 0 ? d : 0;
        b.slots[it.level][0] = static_cast<float>(((it.sx >> ld) + 0.5) / tw);
        b.slots[it.level][1] = static_cast<float>(((it.sy >> ld) + 0.5) / th);
        b.slots[it.level][2] = static_cast<float>((((it.sx + it.sw) >> ld) - 0.5) / tw);
        b.slots[it.level][3] = static_cast<float>((((it.sy + it.sh) >> ld) - 0.5) / th);
      }
    }
    for (int d = 0; d <= kMaxBackdropDepth; d++) done(d);
  }
  // Back to this layer, as it was.
  gfx::PassDesc resume = pd;
  resume.keep = true;
  return openPass(resume);
}

void Renderer::execute(int index, gfx::TargetId target, const float clear[4], bool keep) {
  // Who reads each layer: a layer gives its target back to the pool as soon as the last of them has run.
  for (Layer& L : layers_) L.readers = 0;
  for (const Layer& L : layers_) eachRead(L, [&](int k) { layers_[static_cast<size_t>(k)].readers++; });
  Layer& root = layers_[static_cast<size_t>(index)];
  root.executed = true;
  for (size_t i = 0; i < root.cmds.size(); i++) {
    const Cmd c = layers_[static_cast<size_t>(index)].cmds[i];
    if (c.kind == Cmd::Kind::Shader && c.layer >= 0) runLayer(c.layer);
    if (c.kind != Cmd::Kind::Composite) continue;
    if (c.layer >= 0) runLayer(c.layer);
    if (c.aux >= 0) runLayer(c.aux);
  }
  Layer& L = layers_[static_cast<size_t>(index)];
  runCmds(L, target, {0, 0, L.rect.w, L.rect.h}, clear, keep);
}

void Renderer::beginRecording(gfx::IRect region, bool clipToRegion) {
  instances_.clear();
  layers_.clear();
  shaderCalls_.clear();
  backdrops_.clear();
  clips_.clear();
  stencilDepth_ = 0;
  Layer root;
  root.rect = {0, 0, viewport_.deviceWidth(), viewport_.deviceHeight()};
  layers_.push_back(root);
  current_ = 0;
  region_ = region;
  double sx = viewport_.scaleX(), sy = viewport_.scaleY();
  screen_ = {region.x / sx, region.y / sy, region.w / sx, region.h / sy};
  // A part of the frame: everything drawn into it is clipped to it (frames' clips intersect with it).
  scissorEnabled_ = clipToRegion;
  scissor_ = region;
  clipRect_[0] = static_cast<float>(region.x), clipRect_[1] = static_cast<float>(region.y);
  clipRect_[2] = static_cast<float>(region.x + region.w), clipRect_[3] = static_cast<float>(region.y + region.h);
  round_ = RoundClip{};
  shapeClips_.clear();
  shapeClip_ = -1;
}

void Renderer::finishRecording(gfx::TargetId target, const float clear[4], bool keep) {
  scissorEnabled_ = false;
  shapeClip_ = -1;
  stencilDepth_ = 0;
  clips_.clear();
  current_ = 0;
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
  execute(0, target, clear, keep);
  // Every layer's target goes back to the pool.
  for (auto& t : pool_) t.busy = false;
  scratch_.clear();
}

void Renderer::drawPageContent(const Document& doc, const Color& page, bool background) {
  if (background) {
    // The page colour under the part being drawn again (the cache keeps the rest).
    DrawInstance q = makeShape(Mat2x3::translate(screen_.x, screen_.y), {screen_.w, screen_.h}, ShapeKind::Rect, kSquare,
                               Color{page.r, page.g, page.b, 1}, 1, Color{}, 0, 0, 0);
    emit(q, Pass::Shape);
  }
  drawChildren(doc, 0, static_cast<uint32_t>(tree_->size()), view_, 1);
}

double Renderer::nowMs() const {
  if (clock_) return clock_();
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

double Renderer::wantsFrameAt() const {
  if (cache_.settleAt) return cache_.settleAt;
  if (cache_.imagesWaitAt) return cache_.imagesWaitAt;
  return tiles_.prefetchAt;
}

void Renderer::dropCache() {
  if (cache_.target) device_.destroyTarget(cache_.target);
  if (cache_.spare) device_.destroyTarget(cache_.spare);
  cache_ = ContentCache{};
}

void Renderer::purgeMemory() {
  dropCache();
  dropTiles();
  for (auto it = pool_.begin(); it != pool_.end();) {
    if (!it->busy) {
      device_.destroyTarget(it->target);
      it = pool_.erase(it);
    } else {
      ++it;
    }
  }
  curves_.purge();
  images_.purge();
}

RenderStats Renderer::render(const Document& doc, Guid page, const Camera& camera, const Viewport& viewport,
                             const Overlay& overlay, const OverlayStyle& style, gfx::TargetId target, Guid only) {
  lodZoom_ = overlay.zooming;  // refined below on the cached path (only while the zoom is still changing)
  ensurePipelines();
  frame_++;
  doc_ = &doc;
  lifted_ = overlay.lifted;
  recordHits_ = target == 0 && only == kNoGuid && !exporting_;
  // Ghosts only on the canvas itself (not in thumbnails or exports: there the layers are where they are).
  ghosts_ = recordHits_ ? overlay.ghosts : std::vector<Guid>{};
  ghostOpacity_ = overlay.ghostOpacity;
  viewport_ = viewport;
  stats_ = {};
  curves_.beginFrame();
  if (rampData_.size() > static_cast<size_t>(kRampWidth) * 4 * 2048) {
    rampRows_.clear();
    rampData_.clear();
    rampRowsUploaded_ = 0;
  }
  view_ = camera.matrix();
  // The page's render tree, brought up to the document (a few trees are kept: the current page's, thumbnails').
  if (trees_.size() > 4 && !trees_.count(page)) trees_.clear();
  RenderTree& tree = trees_[page];
  // Text's glyphs reach past their box at times: the tree knows where (and starts over when fonts change it).
  uint32_t fontGeneration = text::FontRegistry::get().generation();
  if (fontGeneration != treeFonts_) {
    for (auto& [id, t] : trees_) t.invalidate();
    treeFonts_ = fontGeneration;
  }
  tree.setTextInk([this](Guid id, Rect& out) {
    const text::TextLayout* L = texts_ ? texts_->textLayout(id) : nullptr;
    if (!L) return false;
    out = L->inkBounds;
    // Motion's text stagger (round 8h): its glyphs reach where their elements are.
    if (const motion::TextElementPoses* st = texts_->textElements(id); st && !st->reach.empty()) out = out.united(st->reach);
    return true;
  });
  tree.sync(doc, page);
  tree_ = &tree;
  // The page's own colour, unless it is Figma's default (#F5F5F5), which follows the theme.
  Color clear = style.canvas;
  if (const Node* pg = doc.get(page); pg && pg->props.rare().backgroundEnabled) {
    const Color& bg = pg->props.rare().backgroundColor;
    Color light = Color::hex(0xF5F5F5);
    bool figmaDefault = std::fabs(bg.r - light.r) < 0.003f && std::fabs(bg.g - light.g) < 0.003f && std::fabs(bg.b - light.b) < 0.003f;
    if (!figmaDefault) clear = bg;
  }
  if (only != kNoGuid || exporting_) clear = Color{0, 0, 0, 0};  // a node's thumbnail, an export: transparent around it
  // Outline mode: the page's pixels are drawn another way — the cache starts over when it turns on or off.
  bool outlines = overlay.outlines && only == kNoGuid && !exporting_;
  bool guides = overlay.layoutGuides || only != kNoGuid || exporting_;
  if (outlines != outlines_ || guides != layoutGuides_) {
    outlines_ = outlines;
    layoutGuides_ = guides;
    dropCache();
    dropTiles();
  }
  outlineInk_ = darkCanvas(clear) ? Color{1, 1, 1, 0.55f} : Color{0, 0, 0, 0.6f};
  // Frame titles read on the page's colour.
  OverlayStyle adapted = style;
  adapted.darkCanvas = darkCanvas(clear);
  const Color& title = adapted.darkCanvas ? style.titleOnDark : style.titleOnLight;
  adapted.title = Color{title.r, title.g, title.b, 1};
  adapted.titleAlpha = title.a;
  float clearColor[4] = {clear.r, clear.g, clear.b, 1};
  if (only != kNoGuid || exporting_) clearColor[0] = clearColor[1] = clearColor[2] = clearColor[3] = 0;
  const int W = viewport.deviceWidth(), H = viewport.deviceHeight();
  const gfx::IRect full{0, 0, W, H};

  // Pixel preview (⌃P): the page at 1x / 2x, scaled up without smoothing (only where that is larger than the canvas's
  // own pixels).
  if (overlay.pixelPreview > 0 && target == 0 && only == kNoGuid && overlay.dev.focus == kNoGuid && !exporting_ && !inPreview_ && W > 0 && H > 0 &&
      renderPixelPreview(doc, page, camera, viewport, overlay, adapted, clearColor, overlay.pixelPreview)) {
    device_.submit();
    dropIdleTargets();
    images_.endFrame();
    return stats_;
  }

  if (!cacheEnabled_ || target != 0 || only != kNoGuid || overlay.dev.focus != kNoGuid || W <= 0 || H <= 0) {
    // Direct: everything into the target this frame (thumbnails, tests, no cache).
    beginRecording(full, false);
    if (only == kNoGuid && overlay.dev.focus != kNoGuid) {
      // Focus view: the one design over the page, then the overlays.
      int i = tree.indexOf(overlay.dev.focus);
      if (i >= 0)
        drawChildren(doc, static_cast<uint32_t>(i), tree.nodes()[static_cast<size_t>(i)].end,
                     view_ * doc.worldTransform(doc.parentOf(overlay.dev.focus)), 1);
      current_ = 0;
      scissorEnabled_ = false;
      drawOverlay(doc, page, camera, overlay, adapted);
    } else if (only != kNoGuid) {
      // One node, nothing else.
      int i = tree.indexOf(only);
      if (i >= 0)
        drawChildren(doc, static_cast<uint32_t>(i), tree.nodes()[static_cast<size_t>(i)].end, view_ * doc.worldTransform(doc.parentOf(only)), 1);
    } else {
      drawChildren(doc, 0, static_cast<uint32_t>(tree.size()), view_, 1);
      current_ = 0;
      scissorEnabled_ = false;
      drawGhosts(doc);
      drawOverlay(doc, page, camera, overlay, adapted);
    }
    finishRecording(target, clearColor, false);
  } else {
    renderCached(doc, page, camera, overlay, adapted, clear, clearColor);
  }
  device_.submit();
  // Pooled targets unused for a while are freed.
  dropIdleTargets();
  images_.endFrame();
  RenderStats s = stats_;
  return s;
}

// ---- Pixel preview --------------------------------------------------------------------------------------------

bool Renderer::renderPixelPreview(const Document& doc, Guid page, const Camera& camera, const Viewport& viewport, const Overlay& overlay,
                                  const OverlayStyle& style, const float clearColor[4], int factor) {
  const double sx = viewport.scaleX(), sy = viewport.scaleY();
  const double kx = camera.zoom * sx / factor, ky = camera.zoom * sy / factor;  // canvas device px per preview px
  if (!(kx > 1.001) || !(ky > 1.001)) return false;
  const int W = viewport.deviceWidth(), H = viewport.deviceHeight();
  // Preview px (i, j) is page [i, i + 1) / factor: its grid is the page's, whatever the camera's offset.
  const double ox = std::ceil(camera.x * sx / kx), oy = std::ceil(camera.y * sy / ky);
  const int w = static_cast<int>(std::ceil(W / kx)) + 2, h = static_cast<int>(std::ceil(H / ky)) + 2;
  if (w > static_cast<int>(device_.caps().maxTextureSize) || h > static_cast<int>(device_.caps().maxTextureSize)) return false;
  if (preview_.target && (preview_.w != w || preview_.h != h)) {
    device_.destroyTarget(preview_.target);
    preview_ = {};
  }
  if (!preview_.target) {
    preview_.target = device_.createTarget(static_cast<uint32_t>(w), static_cast<uint32_t>(h));
    if (!preview_.target) return false;
    preview_.w = w;
    preview_.h = h;
    device_.setTextureFiltering(device_.targetTexture(preview_.target), false);
  }
  // The page into the preview target (no overlays), directly.
  Overlay none;
  none.handles = false;
  none.sizeBadge = false;
  none.selectionBox = false;
  none.frameTitles = false;
  none.pixelGrid = false;
  none.outlines = overlay.outlines;
  none.layoutGuides = overlay.layoutGuides;
  Viewport low{static_cast<double>(w), static_cast<double>(h), 1, w, h};
  Camera lowCamera{ox, oy, static_cast<double>(factor)};
  inPreview_ = true;
  RenderStats inner = render(doc, page, lowCamera, low, none, style, preview_.target);
  inPreview_ = false;
  // The content cache isn't kept meanwhile: drawn whole when the preview ends.
  (void)trees_[page].takeDamage();
  cache_.valid = false;
  // Back to the canvas: the preview scaled up (nearest), the overlays over it.
  doc_ = &doc;
  viewport_ = viewport;
  view_ = camera.matrix();
  tree_ = &trees_[page];
  recordHits_ = true;
  stats_ = inner;
  beginRecording({0, 0, W, H}, false);
  Cmd b;
  b.kind = Cmd::Kind::Blit;
  b.blitTexture = device_.targetTexture(preview_.target);
  // Preview px u lands at u·k + (offset − ox·k), canvas device px.
  b.blitOrigin = Vec2{camera.x * sx - ox * kx, camera.y * sy - oy * ky};
  b.blitScale = 1 / kx;
  b.blitHeight = h;
  b.rect = {0, 0, W, H};
  layers_[0].cmds.push_back(b);
  drawOverlay(doc, page, camera, overlay, style);
  finishRecording(0, clearColor, false);
  return true;
}

// ---- The content cache ---------------------------------------------------------------------------
//
// The page's pixels without the overlays, kept in a canvas-sized target across frames (docs/engine.md §6.9, as
// built): a frame where only the overlays changed (hover, selection, the caret) composites it; a pan by whole
// device pixels shifts it and draws only the strips that came into view; an edit draws again only where the
// changed layers were and are (the render tree's damage). A zoom draws everything again — or, during a
// continuous zoom on a page that takes long to draw, shows the cache scaled and draws once the zoom settles.

void Renderer::renderCached(const Document& doc, Guid page, const Camera& camera, const Overlay& overlay, const OverlayStyle& style,
                            const Color& clear, const float clearColor[4]) {
  const int W = viewport_.deviceWidth(), H = viewport_.deviceHeight();
  const gfx::IRect full{0, 0, W, H};
  const double sx = viewport_.scaleX(), sy = viewport_.scaleY();
  const double now = nowMs();
  RenderTree::Damage damage = trees_[page].takeDamage();
  // Layers that became ghosts (or stopped being ones) since the cache was drawn: their pixels there change.
  if (ghosts_ != cachedGhosts_) {
    for (const std::vector<Guid>* v : {&ghosts_, &cachedGhosts_})
      for (Guid g : *v)
        if (int i = tree_->indexOf(g); i >= 0) damage.rects.push_back(tree_->nodes()[static_cast<size_t>(i)].visual);
    cachedGhosts_ = ghosts_;
  }
  ContentCache& c = cache_;
  if (c.target && (c.w != W || c.h != H)) dropCache();
  if (!c.target) {
    c.target = device_.createTarget(static_cast<uint32_t>(W), static_cast<uint32_t>(H));
    c.spare = device_.createTarget(static_cast<uint32_t>(W), static_cast<uint32_t>(H));
    c.w = W;
    c.h = H;
    c.valid = false;
    if (!c.target || !c.spare) {
      // No room for a cache: draw directly.
      dropCache();
      cacheEnabled_ = false;
      beginRecording(full, false);
      drawChildren(doc, 0, static_cast<uint32_t>(tree_->size()), view_, 1);
      current_ = 0;
      scissorEnabled_ = false;
      drawGhosts(doc);
      drawOverlay(doc, page, camera, overlay, style);
      finishRecording(0, clearColor, false);
      return;
    }
  }
  const uint32_t fonts = text::FontRegistry::get().generation(), arrived = ImageRegistry::get().generation();
  uint32_t images = arrived;
  // Images that arrived (or failed) since the cache was drawn: drawn again where the layers that drew them are — not
  // the whole page, nor every tile — when that is known. On a slow page that drew everything for images moments ago,
  // they wait kImageBatchMs and come in together (a file opening with many images: a few redraws, not one each).
  bool imagesWait = false, imagesNow = false;
  if (c.valid && c.page == page && c.images != arrived && !damage.all) {
    if (c.fullMs > kZoomRasterBudgetMs && now - c.imagesAt < kImageBatchMs) {
      imagesWait = true;
      images = c.images;
      c.imagesWaitAt = c.imagesAt + kImageBatchMs;
    } else {
      imagesNow = true;
      uint32_t since = c.images;
      bool tilesToo = tiles_.page == page && tiles_.images != arrived;
      if (tilesToo) since = std::min(since, tiles_.images);
      std::vector<ImageHash> changed;
      if (!imageUsersLost_ && ImageRegistry::get().changedSince(since, changed)) {
        std::unordered_set<int> seen;
        for (const ImageHash& h : changed)
          if (auto it = imageUsers_.find(h); it != imageUsers_.end())
            for (Guid g : it->second)
              if (int i = tree_->indexOf(g); i >= 0 && seen.insert(i).second) damage.rects.push_back(tree_->nodes()[static_cast<size_t>(i)].visual);
        c.images = arrived;
        if (tilesToo) tiles_.images = arrived;
      }
    }
  }
  if (!imagesWait) c.imagesWaitAt = 0;
  bool same = c.valid && c.page == page && c.fonts == fonts && c.images == images && c.sx == sx && c.sy == sy &&
              c.clear.r == clear.r && c.clear.g == clear.g && c.clear.b == clear.b && !damage.all;
  if (camera.zoom != c.lastZoom) {
    c.lastZoom = camera.zoom;
    c.zoomChangedAt = now;
  }
  bool needFull = !same || c.pendingFull || c.zoom != camera.zoom;
  // A continuous zoom on a page that takes long to draw: the cache, scaled, until the zoom settles — when the scaled
  // cache covers the canvas (zooming in; zooming out would show blank margins: drawn sharp instead).
  bool covers = false;
  if (same && c.zoom > 0) {
    double k = camera.zoom / c.zoom;
    double ox = camera.x * sx - c.camX * sx * k, oy = camera.y * sy - c.camY * sy * k;
    covers = ox <= 0.5 && oy <= 0.5 && ox + W * k >= W - 0.5 && oy + H * k >= H - 0.5;
  }
  // While a zoom goes on, text under kGlyphZoomEmPx is drawn as its lines' ink bars (Figma's small text costs it no
  // glyph coverage either): tens of thousands of 1–6 px glyphs made each zoom frame GPU-bound (owner's Test page:
  // 70 fps drawn sharp at full resolution; 111 with this).
  lodZoom_ = overlay.zooming && now - c.zoomChangedAt < kZoomSettleMs;
  bool slowZoom = same && c.zoom != camera.zoom && overlay.zooming && c.zoomFullMs > kZoomScaledCacheMs &&
                  now - c.zoomChangedAt < kZoomSettleMs;
  // Zooming in, the cache scaled covers the canvas; zooming out it doesn't: tiles fill in around it.
  bool stale = slowZoom && covers;
  bool tiled = slowZoom && !covers;
  // Tiles follow the document: whatever changed is drawn again when shown; a new page, fonts, images: start over.
  bool tilesDropped = false;
  if (tiles_.page != page || tiles_.fonts != fonts || tiles_.images != images || tiles_.sx != sx || tiles_.sy != sy ||
      !(tiles_.clear == clear) || damage.all) {
    tilesDropped = true;
    dropTiles();
    tiles_.page = page;
    tiles_.fonts = fonts;
    tiles_.images = images;
    tiles_.sx = sx;
    tiles_.sy = sy;
    tiles_.clear = clear;
  } else if (!damage.rects.empty()) {
    // A change under what a layer reads its backdrop from (glass, background blur) changes that layer's pixels too.
    std::vector<Rect> rects = damage.rects;
    if (tree_->size()) {
      std::vector<BackdropArea> areas = backdropAreas(doc, true);
      std::vector<bool> added(areas.size(), false);
      for (bool grew = true; grew;) {
        grew = false;
        for (size_t k = 0; k < areas.size(); k++) {
          if (added[k]) continue;
          const BackdropArea& b = areas[k];
          Rect a{b.box.x - b.reach, b.box.y - b.reach, b.box.w + 2 * b.reach, b.box.h + 2 * b.reach};
          bool hit = false;
          for (size_t j = 0; j < rects.size() && !hit; j++) hit = a.intersects(rects[j]);
          if (!hit) continue;
          added[k] = true;
          rects.push_back(a);
          grew = true;
        }
      }
    }
    invalidateTiles(rects);
  }
  tiles_.prefetchAt = 0;
  // The level a zoom's tiles are drawn at: the power of two at or above it (never blurrier than the zoom).
  int level = static_cast<int>(std::ceil(std::log2(std::max(camera.zoom, 1e-6)) - 1e-9));
  level = std::clamp(level, -12, 8);
  if (tiled) rasterTiles(doc, visibleTiles(camera, level, 0), kTileInteractingMs, clear, clearColor);
  std::vector<gfx::IRect> regions;
  double shiftX = (camera.x - c.camX) * sx, shiftY = (camera.y - c.camY) * sy;
  if (stale || tiled) {
    c.settleAt = c.zoomChangedAt + kZoomSettleMs;
  } else {
    c.settleAt = 0;
    if (!needFull && (std::fabs(shiftX - std::round(shiftX)) > 1e-6 || std::fabs(shiftY - std::round(shiftY)) > 1e-6)) needFull = true;
    if (!needFull && (std::fabs(shiftX) >= W || std::fabs(shiftY) >= H)) needFull = true;
    if (needFull) {
      regions.push_back(full);
    } else {
      int dx = static_cast<int>(std::lround(shiftX)), dy = static_cast<int>(std::lround(shiftY));
      if (dx || dy) {
        // Shift what is there; draw what came into view.
        blitCache(c.target, c.spare, dx, dy, 1);
        std::swap(c.target, c.spare);
        if (dx > 0) regions.push_back({0, 0, dx, H});
        if (dx < 0) regions.push_back({W + dx, 0, -dx, H});
        int x0 = std::max(0, dx), x1 = std::min(W, W + dx);
        if (dy > 0) regions.push_back({x0, 0, x1 - x0, dy});
        if (dy < 0) regions.push_back({x0, H + dy, x1 - x0, -dy});
        c.camX = camera.x;
        c.camY = camera.y;
      }
      // Where layers changed: their visual bounds before and after, on screen, a little wider for anti-aliasing.
      for (const Rect& w : damage.rects) {
        double x0 = (w.x * view_.m00 + view_.m02) * sx - 4, y0 = (w.y * view_.m11 + view_.m12) * sy - 4;
        double x1 = (w.right() * view_.m00 + view_.m02) * sx + 4, y1 = (w.bottom() * view_.m11 + view_.m12) * sy + 4;
        int ix0 = std::max(0, static_cast<int>(std::floor(x0))), iy0 = std::max(0, static_cast<int>(std::floor(y0)));
        int ix1 = std::min(W, static_cast<int>(std::ceil(x1))), iy1 = std::min(H, static_cast<int>(std::ceil(y1)));
        if (ix1 > ix0 && iy1 > iy0) regions.push_back({ix0, iy0, ix1 - ix0, iy1 - iy0});
      }
      // Layers that read their backdrop (glass, background blurs) touched by those parts: drawn again whole.
      growForBackdrops(doc, regions, dx, dy);
      // Many: merged, those that waste the fewest pixels first (a strip and the layers it touches become one band),
      // down to 16; too many to merge, or large: once, whole.
      if (regions.size() > 16 && regions.size() <= 96) mergeRegions(regions, 16);
      double area = 0;
      for (auto& r : regions) area += static_cast<double>(r.w) * r.h;
      if (regions.size() > 16 || area > 0.6 * W * H) {
        regions.clear();
        regions.push_back(full);
      }
    }
  }
  // Changes while a zoom goes on are not drawn into the cache: the settle frame draws everything.
  if ((stale || tiled) && !damage.rects.empty()) c.pendingFull = true;
  bool drawsWhole = false;
  for (const gfx::IRect& r : regions) drawsWhole |= r.x == 0 && r.y == 0 && r.w == W && r.h == H;
  // Everything drawn again, the tiles gone: the record of which layers drew which image starts over complete.
  if (imageUsersLost_ && drawsWhole && tilesDropped && !tiled) {
    imageUsersLost_ = false;
    imageUsers_.clear();
    imageUserCount_ = 0;
  }
  bool drewFull = false;
  for (const gfx::IRect& r : regions) {
    double t0 = now;
    bool whole = r.x == 0 && r.y == 0 && r.w == W && r.h == H;
    beginRecording(r, !whole);
    drawPageContent(doc, clear, !whole);
    finishRecording(c.target, clearColor, !whole);
    stats_.cachedRegions++;
    if (whole) {
      drewFull = true;
      c.fullMs = nowMs() - t0;
      c.zoomFullMs = lodZoom_ ? c.fullMs : 0;  // each zoom measures afresh
    }
  }
  if (drewFull) {
    c.valid = true;
    c.page = page;
    c.zoom = camera.zoom;
    c.camX = camera.x;
    c.camY = camera.y;
    c.fonts = fonts;
    c.images = images;
    c.sx = sx;
    c.sy = sy;
    c.clear = clear;
    c.pendingFull = false;
    if (imagesNow) c.imagesAt = now;
  }
  // The canvas: the cache (scaled while a zoom settles), then the overlays. Zooming out on tiles: the coarser levels'
  // tiles under the cache (it is sharper where it lands), the zoom's own level over it.
  beginRecording(full, false);
  if (tiled) composeTiles(camera, level, true);
  double k = camera.zoom / c.zoom;
  Cmd b;
  b.kind = Cmd::Kind::Blit;
  b.blitTexture = device_.targetTexture(c.target);
  // Cache px u lands at u·k + (current offset − cached offset · k), in device px.
  b.blitOrigin = Vec2{camera.x * sx - c.camX * sx * k, camera.y * sy - c.camY * sy * k};
  b.blitScale = 1 / k;
  b.blitHeight = H;
  double qx0 = std::max(0.0, b.blitOrigin.x), qy0 = std::max(0.0, b.blitOrigin.y);
  double qx1 = std::min<double>(W, b.blitOrigin.x + W * k), qy1 = std::min<double>(H, b.blitOrigin.y + H * k);
  b.rect = {static_cast<int>(std::floor(qx0)), static_cast<int>(std::floor(qy0)), static_cast<int>(std::ceil(qx1) - std::floor(qx0)),
            static_cast<int>(std::ceil(qy1) - std::floor(qy0))};
  if (b.rect.w > 0 && b.rect.h > 0) layers_[0].cmds.push_back(b);
  if (tiled) composeTiles(camera, level, false);
  current_ = 0;
  scissorEnabled_ = false;
  drawGhosts(doc);
  drawOverlay(doc, page, camera, overlay, style);
  finishRecording(0, clearColor, false);
  if (stale || tiled) stats_.stale = 1;
  // At rest on a slow page: the next zoom out's tiles (one level coarser, twice the view around it), drawn ahead in
  // quiet frames within the idle budget; a frame is asked for while some are missing.
  if (!slowZoom && !overlay.zooming && c.valid && c.fullMs > kZoomRasterBudgetMs) {
    std::vector<TileCoord> ahead = visibleTiles(camera, level - 1, 1.0);
    size_t left = 0;
    if (regions.empty() && damage.rects.empty()) {
      left = rasterTiles(doc, ahead, kTileIdleMs, clear, clearColor);
    } else {
      for (const TileCoord& t : ahead) {
        uint64_t key;
        if (tileKey(t, key) && !tiles_.map.count(key)) left++;
      }
    }
    if (left) tiles_.prefetchAt = nowMs() + 16;
  }
}

// ---- Tiles ------------------------------------------------------------------------------------------

bool Renderer::tileKey(const TileCoord& t, uint64_t& key) {
  constexpr int kHalf = 1 << 23;
  if (t.tx < -kHalf || t.tx >= kHalf || t.ty < -kHalf || t.ty >= kHalf || t.level < -64 || t.level > 63) return false;
  key = (static_cast<uint64_t>(t.level + 64) << 48) | (static_cast<uint64_t>(t.tx + kHalf) << 24) | static_cast<uint64_t>(t.ty + kHalf);
  return true;
}

std::vector<Renderer::TileCoord> Renderer::visibleTiles(const Camera& camera, int level, double grow) const {
  std::vector<TileCoord> out;
  const double sx = viewport_.scaleX(), sy = viewport_.scaleY();
  const double W = viewport_.deviceWidth(), H = viewport_.deviceHeight();
  const double Z = std::ldexp(1.0, level);
  // The canvas in world units, grown by `grow` of its size on each side; then in tiles of `level`.
  double wx0 = (0 / sx - camera.x) / camera.zoom, wx1 = (W / sx - camera.x) / camera.zoom;
  double wy0 = (0 / sy - camera.y) / camera.zoom, wy1 = (H / sy - camera.y) / camera.zoom;
  double gx = (wx1 - wx0) * grow, gy = (wy1 - wy0) * grow;
  wx0 -= gx, wx1 += gx, wy0 -= gy, wy1 += gy;
  double perX = kTileContent / (Z * sx), perY = kTileContent / (Z * sy);  // a tile's world size
  int tx0 = static_cast<int>(std::floor(wx0 / perX)), tx1 = static_cast<int>(std::ceil(wx1 / perX));
  int ty0 = static_cast<int>(std::floor(wy0 / perY)), ty1 = static_cast<int>(std::ceil(wy1 / perY));
  if (static_cast<double>(tx1 - tx0) * (ty1 - ty0) > 4096) return out;  // a level far from the zoom: nothing
  double cx = (wx0 + wx1) / 2 / perX, cy = (wy0 + wy1) / 2 / perY;
  for (int ty = ty0; ty < ty1; ty++)
    for (int tx = tx0; tx < tx1; tx++) out.push_back({level, tx, ty});
  std::sort(out.begin(), out.end(), [&](const TileCoord& a, const TileCoord& b) {
    double da = (a.tx + 0.5 - cx) * (a.tx + 0.5 - cx) + (a.ty + 0.5 - cy) * (a.ty + 0.5 - cy);
    double db = (b.tx + 0.5 - cx) * (b.tx + 0.5 - cx) + (b.ty + 0.5 - cy) * (b.ty + 0.5 - cy);
    return da < db;
  });
  return out;
}

bool Renderer::rasterTile(const Document& doc, const TileCoord& t, const Color& clear, const float clearColor[4]) {
  uint64_t key;
  if (!tileKey(t, key)) return false;
  constexpr uint32_t kPerRow = kAtlasSize / kTileSize, kPerAtlas = kPerRow * kPerRow;
  uint32_t slot;
  if (!tiles_.free.empty()) {
    slot = tiles_.free.back();
    tiles_.free.pop_back();
  } else if (tileBytes() + static_cast<uint64_t>(kAtlasSize) * kAtlasSize * 8 <= kTileBudgetBytes) {
    gfx::TargetId atlas = device_.createTarget(kAtlasSize, kAtlasSize);
    if (!atlas) return false;
    uint32_t a = static_cast<uint32_t>(tiles_.atlases.size());
    tiles_.atlases.push_back(atlas);
    for (uint32_t i = kPerAtlas; i-- > 1;) tiles_.free.push_back(a * kPerAtlas + i);
    slot = a * kPerAtlas;
  } else {
    // The budget is full: the tile shown least recently goes (never one shown this frame).
    auto oldest = tiles_.map.end();
    for (auto it = tiles_.map.begin(); it != tiles_.map.end(); ++it)
      if (oldest == tiles_.map.end() || it->second.used < oldest->second.used) oldest = it;
    if (oldest == tiles_.map.end() || oldest->second.used >= frame_) return false;
    slot = oldest->second.slot;
    tiles_.map.erase(oldest);
  }
  gfx::TargetId atlas = tiles_.atlases[slot / kPerAtlas];
  int ax = static_cast<int>((slot % kPerAtlas) % kPerRow) * kTileSize, ay = static_cast<int>((slot % kPerAtlas) / kPerRow) * kTileSize;
  // The tile's world origin lands on its slot: device px = (world · Z + cam) · s.
  const Viewport saved = viewport_;
  const Mat2x3 savedView = view_;
  const double sx = saved.scaleX(), sy = saved.scaleY();
  viewport_ = Viewport{kAtlasSize / sx, kAtlasSize / sy, saved.dpr, kAtlasSize, kAtlasSize};
  // Its content starts 1 px into the slot (the apron around it is drawn too).
  Camera cam{(ax + 1) / sx - static_cast<double>(t.tx) * kTileContent / sx, (ay + 1) / sy - static_cast<double>(t.ty) * kTileContent / sy,
             std::ldexp(1.0, t.level)};
  view_ = cam.matrix();
  // Layers reading their backdrop (glass, background blurs) across the tile: what they read past the tile is in
  // its neighbours' slots of the atlas (or not drawn yet). Such a tile is drawn in a scratch target with a margin
  // holding what they read (up to kTileBackdropMargin), its middle then copied into the slot: no seams between tiles.
  const gfx::IRect slotRect{ax, ay, kTileSize, kTileSize};
  double margin = 0;
  for (const BackdropArea& b : backdropAreas(doc)) {
    double m = b.reach + 4;
    double x0 = b.box.x - m, y0 = b.box.y - m, x1 = b.box.right() + m, y1 = b.box.bottom() + m;
    // How far the layer and what it reads reach past the tile, on any side.
    if (x0 < ax + kTileSize && x1 > ax && y0 < ay + kTileSize && y1 > ay)
      margin = std::max({margin, ax - x0, x1 - (ax + kTileSize), ay - y0, y1 - (ay + kTileSize)});
  }
  int M = std::min(static_cast<int>(std::ceil(margin)), kTileBackdropMargin);
  bool drawn = false;
  if (M > 0) {
    int S = kTileSize + 2 * M;
    if (tiles_.scratch && tiles_.scratchSize < S) {
      device_.destroyTarget(tiles_.scratch);
      tiles_.scratch = 0;
    }
    if (!tiles_.scratch) {
      int size = std::min(kTileSize + 2 * kTileBackdropMargin, std::max(S, kTileSize + 128));
      tiles_.scratch = device_.createTarget(static_cast<uint32_t>(size), static_cast<uint32_t>(size));
      tiles_.scratchSize = tiles_.scratch ? size : 0;
    }
    if (tiles_.scratch) {
      int size = tiles_.scratchSize;
      viewport_ = Viewport{size / sx, size / sy, saved.dpr, size, size};
      Camera inScratch{(M + 1) / sx - static_cast<double>(t.tx) * kTileContent / sx, (M + 1) / sy - static_cast<double>(t.ty) * kTileContent / sy,
                       std::ldexp(1.0, t.level)};
      view_ = inScratch.matrix();
      beginRecording({0, 0, S, S}, true);
      drawPageContent(doc, clear, true);
      finishRecording(tiles_.scratch, clearColor, false);
      // The middle into the slot.
      viewport_ = Viewport{kAtlasSize / sx, kAtlasSize / sy, saved.dpr, kAtlasSize, kAtlasSize};
      view_ = cam.matrix();
      beginRecording(slotRect, true);
      Cmd copy;
      copy.kind = Cmd::Kind::Blit;
      copy.blitTexture = device_.targetTexture(tiles_.scratch);
      copy.blitOrigin = Vec2{static_cast<double>(ax - M), static_cast<double>(ay - M)};
      copy.blitScale = 1;
      copy.blitHeight = size;
      copy.rect = slotRect;
      layers_[0].cmds.push_back(copy);
      finishRecording(atlas, clearColor, true);
      drawn = true;
    }
  }
  if (!drawn) {
    beginRecording(slotRect, true);
    drawPageContent(doc, clear, true);
    finishRecording(atlas, clearColor, true);
  }
  viewport_ = saved;
  view_ = savedView;
  tiles_.map[key] = TileEntry{t, slot, frame_};
  stats_.tilesRastered++;
  return true;
}

size_t Renderer::rasterTiles(const Document& doc, const std::vector<TileCoord>& want, double budgetMs, const Color& clear,
                             const float clearColor[4]) {
  double start = nowMs();
  size_t left = 0;
  bool any = false;
  for (const TileCoord& t : want) {
    uint64_t key;
    if (!tileKey(t, key)) continue;
    auto it = tiles_.map.find(key);
    if (it != tiles_.map.end()) {
      it->second.used = frame_;
      continue;
    }
    // Within the budget, one at least (a tile can't be drawn in parts).
    if (any && nowMs() - start >= budgetMs) {
      left++;
      continue;
    }
    if (!rasterTile(doc, t, clear, clearColor)) {
      left++;
      continue;
    }
    any = true;
  }
  return left;
}

void Renderer::composeTiles(const Camera& camera, int level, bool coarseOnly) {
  constexpr uint32_t kPerRow = kAtlasSize / kTileSize, kPerAtlas = kPerRow * kPerRow;
  const double sx = viewport_.scaleX(), sy = viewport_.scaleY();
  const int W = viewport_.deviceWidth(), H = viewport_.deviceHeight();
  auto blit = [&](const TileEntry& e) {
    const TileCoord& t = e.coord;
    double Z = std::ldexp(1.0, t.level);
    double k = camera.zoom / Z;  // canvas px per tile px
    // The tile's origin on the canvas (device px).
    double px = (static_cast<double>(t.tx) * kTileContent / (Z * sx) * camera.zoom + camera.x) * sx;
    double py = (static_cast<double>(t.ty) * kTileContent / (Z * sy) * camera.zoom + camera.y) * sy;
    int ax = static_cast<int>((e.slot % kPerAtlas) % kPerRow) * kTileSize + 1, ay = static_cast<int>((e.slot % kPerAtlas) / kPerRow) * kTileSize + 1;
    Cmd b;
    b.kind = Cmd::Kind::Blit;
    b.blitTexture = device_.targetTexture(tiles_.atlases[e.slot / kPerAtlas]);
    b.blitOrigin = Vec2{px - ax * k, py - ay * k};
    b.blitScale = 1 / k;
    b.blitHeight = kAtlasSize;
    int x0 = static_cast<int>(std::floor(px)), y0 = static_cast<int>(std::floor(py));
    int x1 = static_cast<int>(std::ceil(px + kTileContent * k)), y1 = static_cast<int>(std::ceil(py + kTileContent * k));
    x0 = std::max(x0, 0), y0 = std::max(y0, 0), x1 = std::min(x1, W), y1 = std::min(y1, H);
    if (x1 <= x0 || y1 <= y0) return;
    b.rect = {x0, y0, x1 - x0, y1 - y0};
    layers_[0].cmds.push_back(b);
    stats_.tilesShown++;
  };
  std::vector<TileCoord> want = visibleTiles(camera, level, 0);
  // Coarser levels first (under), each tile once; then the level's own tiles over them.
  std::vector<uint64_t> drawn;
  std::vector<const TileEntry*> exact, coarse;
  for (const TileCoord& t : want) {
    uint64_t key;
    if (!tileKey(t, key)) continue;
    auto it = tiles_.map.find(key);
    if (it != tiles_.map.end()) {
      it->second.used = frame_;
      exact.push_back(&it->second);
      continue;
    }
    for (int up = 1; up <= 4; up++) {
      TileCoord p{t.level - up, t.tx >> up, t.ty >> up};
      uint64_t pk;
      if (!tileKey(p, pk)) break;
      auto pit = tiles_.map.find(pk);
      if (pit == tiles_.map.end()) continue;
      if (std::find(drawn.begin(), drawn.end(), pk) == drawn.end()) {
        drawn.push_back(pk);
        pit->second.used = frame_;
        coarse.push_back(&pit->second);
        if (coarseOnly) stats_.tilesStale++;
      }
      break;
    }
  }
  if (coarseOnly) {
    std::sort(coarse.begin(), coarse.end(), [](const TileEntry* a, const TileEntry* b) { return a->coord.level < b->coord.level; });
    for (const TileEntry* e : coarse) blit(*e);
  } else {
    for (const TileEntry* e : exact) blit(*e);
  }
}

void Renderer::invalidateTiles(const std::vector<Rect>& world) {
  const double sx = tiles_.sx > 0 ? tiles_.sx : 1, sy = tiles_.sy > 0 ? tiles_.sy : 1;
  for (auto it = tiles_.map.begin(); it != tiles_.map.end();) {
    const TileCoord& t = it->second.coord;
    double Z = std::ldexp(1.0, t.level);
    double perX = kTileContent / (Z * sx), perY = kTileContent / (Z * sy);
    // Anti-aliasing and effects reach a little past a layer's bounds: a few device px of margin.
    double mx = 4 / (Z * sx), my = 4 / (Z * sy);
    Rect r{t.tx * perX - mx, t.ty * perY - my, perX + 2 * mx, perY + 2 * my};
    bool hit = false;
    for (const Rect& w : world) hit |= r.intersects(w);
    if (hit) {
      tiles_.free.push_back(it->second.slot);
      it = tiles_.map.erase(it);
    } else {
      ++it;
    }
  }
}

void Renderer::dropTiles() {
  for (gfx::TargetId a : tiles_.atlases) device_.destroyTarget(a);
  if (tiles_.scratch) device_.destroyTarget(tiles_.scratch);
  tiles_ = TileCache{};
}

void Renderer::blitCache(gfx::TargetId from, gfx::TargetId to, int dx, int dy, double scale) {
  const int W = viewport_.deviceWidth(), H = viewport_.deviceHeight();
  gfx::PassDesc pd;
  pd.target = to;
  pd.viewport = {0, 0, W, H};
  for (int i = 0; i < 4; i++) pd.clear[i] = 0;
  if (!openPass(pd)) return;
  gfx::DrawCall call;
  call.textures[3] = white_;  // Composite: the curves (a clip path), else unused
  call.pipeline = pipelines_[static_cast<int>(Pass::CompositeReplace)];
  call.instanceCount = 1;
  float r[2][4];
  rows(r, 1, 1, 0, 0, W, H);
  for (int i = 0; i < 4; i++) call.uniforms[0][i] = r[0][i], call.uniforms[1][i] = r[1][i];
  call.uniforms[2][0] = 0;
  call.uniforms[2][1] = 0;
  call.uniforms[2][2] = static_cast<float>(W);
  call.uniforms[2][3] = static_cast<float>(H);
  call.uniforms[3][0] = static_cast<float>(dx);
  call.uniforms[3][1] = static_cast<float>(dy);
  call.uniforms[3][2] = static_cast<float>(H);
  call.uniforms[3][3] = static_cast<float>(scale);
  call.uniforms[7][0] = 1;
  call.uniforms[7][1] = 1;
  call.textures[0] = device_.targetTexture(from);
  call.textures[1] = call.textures[2] = white_;
  device_.draw(call);
  stats_.drawCalls++;
  device_.endPass();
}

}  // namespace eng
