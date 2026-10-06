#include "render/Renderer.h"

#include <cmath>

namespace eng {

namespace {

const CornerRadii kSquare{0, 0, 0, 0};

void premultiply(float out[4], const Color& c, double alpha) {
  float a = static_cast<float>(c.a * alpha);
  out[0] = c.r * a;
  out[1] = c.g * a;
  out[2] = c.b * a;
  out[3] = a;
}

void strokeExtent(const NodeProps& p, double& inner, double& outer) {
  double w = p.strokeWeight;
  switch (p.strokeAlign) {
    case StrokeAlign::INSIDE: inner = w, outer = 0; break;
    case StrokeAlign::OUTSIDE: inner = 0, outer = w; break;
    default: inner = outer = w / 2;
  }
}

bool nearlyAxisAligned(const Mat2x3& m) {
  return std::fabs(m.m01) < 1e-9 && std::fabs(m.m10) < 1e-9 && m.m00 > 0 && m.m11 > 0;
}

}  // namespace

ShapeInstance makeShape(const Mat2x3& m, Vec2 size, ShapeKind kind, const CornerRadii& radii, const Color& fill,
                        double fillAlpha, const Color& stroke, double strokeAlpha, double inner, double outer) {
  ShapeInstance q;
  q.linear[0] = static_cast<float>(m.m00);
  q.linear[1] = static_cast<float>(m.m10);
  q.linear[2] = static_cast<float>(m.m01);
  q.linear[3] = static_cast<float>(m.m11);
  q.origin[0] = static_cast<float>(m.m02);
  q.origin[1] = static_cast<float>(m.m12);
  q.origin[2] = static_cast<float>(size.x);
  q.origin[3] = static_cast<float>(size.y);
  for (int i = 0; i < 4; i++) q.radii[i] = static_cast<float>(radii[i]);
  premultiply(q.fill, fill, fillAlpha);
  premultiply(q.stroke, stroke, strokeAlpha);
  q.params[0] = static_cast<float>(inner);
  q.params[1] = static_cast<float>(outer);
  q.params[2] = kind == ShapeKind::Ellipse ? 1.f : 0.f;
  q.params[3] = 0;
  return q;
}

Renderer::~Renderer() {
  if (buffer_) device_.destroyBuffer(buffer_);
  if (glyphBuffer_) device_.destroyBuffer(glyphBuffer_);
}

void Renderer::ensurePipelines() {
  if (pipelines_[0]) return;
  using namespace gfx;
  PipelineDesc color;
  pipelines_[static_cast<int>(Pass::Color)] = device_.createPipeline(color);
  PipelineDesc clipped = color;
  clipped.stencil = {true, StencilFunc::Equal, StencilOp::Keep};
  pipelines_[static_cast<int>(Pass::ColorClipped)] = device_.createPipeline(clipped);
  PipelineDesc incr = color;
  incr.colorMask = ColorMask::None;
  incr.stencil = {true, StencilFunc::Equal, StencilOp::Increment};
  pipelines_[static_cast<int>(Pass::StencilIncrement)] = device_.createPipeline(incr);
  PipelineDesc decr = incr;
  decr.stencil.pass = StencilOp::Decrement;
  pipelines_[static_cast<int>(Pass::StencilDecrement)] = device_.createPipeline(decr);
  PipelineDesc glyph = color;
  glyph.shader = ShaderId::Glyph;
  pipelines_[static_cast<int>(Pass::Glyph)] = device_.createPipeline(glyph);
  PipelineDesc glyphClipped = clipped;
  glyphClipped.shader = ShaderId::Glyph;
  pipelines_[static_cast<int>(Pass::GlyphClipped)] = device_.createPipeline(glyphClipped);
}

void Renderer::emitGlyph(const GlyphInstance& g) {
  Pass pass = stencilDepth_ > 0 ? Pass::GlyphClipped : Pass::Glyph;
  uint8_t ref = stencilDepth_;
  bool merge = !draws_.empty();
  if (merge) {
    const PendingDraw& d = draws_.back();
    merge = d.pass == pass && d.stencilRef == ref && d.scissorEnabled == scissorEnabled_ &&
            (!scissorEnabled_ || (d.scissor.x == scissor_.x && d.scissor.y == scissor_.y && d.scissor.w == scissor_.w &&
                                   d.scissor.h == scissor_.h));
  }
  if (merge) draws_.back().count++;
  else draws_.push_back({pass, static_cast<uint32_t>(glyphs_.size()), 1, scissorEnabled_, scissor_, ref});
  glyphs_.push_back(g);
}

void Renderer::emit(const ShapeInstance& s, Pass pass) {
  uint8_t ref = stencilDepth_;
  if (pass == Pass::Color && stencilDepth_ > 0) pass = Pass::ColorClipped;
  if (pass == Pass::StencilDecrement) ref = static_cast<uint8_t>(stencilDepth_ + 1);
  bool merge = !draws_.empty();
  if (merge) {
    const PendingDraw& d = draws_.back();
    merge = d.pass == pass && d.stencilRef == ref && d.scissorEnabled == scissorEnabled_ &&
            (!scissorEnabled_ || (d.scissor.x == scissor_.x && d.scissor.y == scissor_.y && d.scissor.w == scissor_.w &&
                                   d.scissor.h == scissor_.h));
  }
  if (merge) draws_.back().count++;
  else draws_.push_back({pass, static_cast<uint32_t>(shapes_.size()), 1, scissorEnabled_, scissor_, ref});
  shapes_.push_back(s);
}

void Renderer::pushClip(const Mat2x3& m, Vec2 size, const CornerRadii& radii) {
  bool square = radii[0] <= 0 && radii[1] <= 0 && radii[2] <= 0 && radii[3] <= 0;
  Clip clip{false, scissorEnabled_, scissor_, {}};
  if (square && nearlyAxisAligned(m)) {
    // Axis-aligned and square: a scissor rect, intersected with the current one.
    Rect r = transformedBounds(m, size.x, size.y);
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
  } else {
    // Rounded or turned: the shape's fill into the stencil, one level deeper.
    clip.stencil = true;
    clip.shape = makeShape(m, size, ShapeKind::Rect, radii, Color{1, 1, 1, 1}, 1, Color{}, 0, 0, 0);
    emit(clip.shape, Pass::StencilIncrement);
    stencilDepth_++;
  }
  clips_.push_back(clip);
}

void Renderer::popClip() {
  Clip clip = clips_.back();
  clips_.pop_back();
  if (clip.stencil) {
    stencilDepth_--;
    emit(clip.shape, Pass::StencilDecrement);
  }
  scissorEnabled_ = clip.scissorEnabled;
  scissor_ = clip.scissor;
}

void Renderer::drawNode(const Document& doc, Guid id, const Mat2x3& parentScreen, double opacity) {
  const Node* n = doc.get(id);
  if (!n || !n->props.visible) return;
  const NodeProps& p = n->props;
  Mat2x3 m = parentScreen * p.transform;
  double alpha = opacity * p.opacity;  // interim: group opacity multiplies down (layers come in E5)
  if (alpha <= 0) return;

  if (p.isGroupLike()) {
    for (Guid c : doc.children(id)) drawNode(doc, c, m, alpha);
    return;
  }
  if (p.type == NodeType::TEXT) {
    drawText(p, id, m, alpha);
    return;
  }
  bool frame = p.type == NodeType::FRAME;
  if (!frame && !p.isRectLike() && p.type != NodeType::ELLIPSE) return;

  ShapeKind kind = p.type == NodeType::ELLIPSE ? ShapeKind::Ellipse : ShapeKind::Rect;
  const CornerRadii& radii = kind == ShapeKind::Rect ? p.cornerRadii : kSquare;
  double inner = 0, outer = 0;
  strokeExtent(p, inner, outer);
  bool clips = p.clipsContent();

  // Off screen: skip the node (and a clipping frame's whole subtree).
  double scale = std::sqrt(std::fabs(m.determinant()));
  Rect bounds = transformedBounds(m, p.size.x, p.size.y);
  double grow = outer * scale + 2;
  Rect padded{bounds.x - grow, bounds.y - grow, bounds.w + 2 * grow, bounds.h + 2 * grow};
  bool onScreen = padded.intersects(screen_);
  if (!onScreen && (!frame || clips)) return;

  if (onScreen)
    for (auto& f : p.fillPaints)
      if (f.visible && f.type == PaintType::SOLID) emit(makeShape(m, p.size, kind, radii, f.color, alpha * f.opacity, f.color, 0, 0, 0), Pass::Color);

  if (frame) {
    const auto& kids = doc.children(id);
    if (!kids.empty()) {
      if (clips) pushClip(m, p.size, radii);
      for (Guid c : kids) drawNode(doc, c, m, alpha);
      if (clips) popClip();
    }
  }

  // Strokes go over the fills (and over a frame's content).
  if (onScreen && p.strokeWeight > 0)
    for (auto& s : p.strokePaints)
      if (s.visible && s.type == PaintType::SOLID)
        emit(makeShape(m, p.size, kind, radii, s.color, 0, s.color, alpha * s.opacity, inner, outer), Pass::Color);
}

RenderStats Renderer::render(const Document& doc, Guid page, const Camera& camera, const Viewport& viewport,
                             const Overlay& overlay, const OverlayStyle& style, gfx::TargetId target) {
  ensurePipelines();
  viewport_ = viewport;
  screen_ = {0, 0, viewport.width, viewport.height};
  shapes_.clear();
  glyphs_.clear();
  draws_.clear();
  clips_.clear();
  scissorEnabled_ = false;
  stencilDepth_ = 0;

  Mat2x3 view = camera.matrix();
  for (Guid c : doc.children(page)) drawNode(doc, c, view, 1);
  scissorEnabled_ = false;
  stencilDepth_ = 0;
  // The page's own colour, unless it is Figma's default (#F5F5F5), which follows the theme.
  Color clear = style.canvas;
  if (const Node* pg = doc.get(page); pg && pg->props.backgroundEnabled) {
    const Color& bg = pg->props.backgroundColor;
    Color light = Color::hex(0xF5F5F5);
    bool figmaDefault = std::fabs(bg.r - light.r) < 0.003f && std::fabs(bg.g - light.g) < 0.003f && std::fabs(bg.b - light.b) < 0.003f;
    if (!figmaDefault) clear = bg;
  }
  // Frame titles read on the page's colour: light grey on a dark page, black at 50% on a light one.
  OverlayStyle adapted = style;
  double luma = 0.2126 * clear.r + 0.7152 * clear.g + 0.0722 * clear.b;
  OverlayStyle dark = OverlayStyle::of(Theme::Dark), light = OverlayStyle::of(Theme::Light);
  adapted.title = luma < 0.5 ? dark.title : light.title;
  adapted.titleAlpha = luma < 0.5 ? dark.titleAlpha : light.titleAlpha;
  drawOverlay(doc, page, camera, overlay, adapted);
  gfx::TextureId curves = glyphs_.empty() ? 0 : glyphCache_.flush();

  RenderStats stats;
  gfx::PassDesc pass;
  pass.clear[0] = clear.r;
  pass.clear[1] = clear.g;
  pass.clear[2] = clear.b;
  pass.clear[3] = 1;
  pass.viewport = {0, 0, viewport.deviceWidth(), viewport.deviceHeight()};
  pass.target = target;
  if (!device_.beginPass(pass)) return stats;

  uint32_t bytes = static_cast<uint32_t>(shapes_.size() * sizeof(ShapeInstance));
  if (bytes) {
    if (!buffer_) {
      capacity_ = std::max<uint32_t>(bytes, 4096 * sizeof(ShapeInstance));
      buffer_ = device_.createBuffer(gfx::BufferKind::Instance, capacity_, gfx::Usage::Stream);
    } else if (bytes > capacity_) {
      while (capacity_ < bytes) capacity_ *= 2;
      device_.reserve(buffer_, capacity_);
    }
    device_.write(buffer_, 0, {reinterpret_cast<const uint8_t*>(shapes_.data()), bytes});
  }

  uint32_t glyphBytes = static_cast<uint32_t>(glyphs_.size() * sizeof(GlyphInstance));
  if (glyphBytes) {
    if (!glyphBuffer_) {
      glyphCapacity_ = std::max<uint32_t>(glyphBytes, 4096 * sizeof(GlyphInstance));
      glyphBuffer_ = device_.createBuffer(gfx::BufferKind::Instance, glyphCapacity_, gfx::Usage::Stream);
    } else if (glyphBytes > glyphCapacity_) {
      while (glyphCapacity_ < glyphBytes) glyphCapacity_ *= 2;
      device_.reserve(glyphBuffer_, glyphCapacity_);
    }
    device_.write(glyphBuffer_, 0, {reinterpret_cast<const uint8_t*>(glyphs_.data()), glyphBytes});
  }

  double w = std::max(1.0, viewport.width), h = std::max(1.0, viewport.height);
  for (const PendingDraw& d : draws_) {
    gfx::DrawCall call;
    call.pipeline = pipelines_[static_cast<int>(d.pass)];
    bool glyph = d.pass == Pass::Glyph || d.pass == Pass::GlyphClipped;
    if (glyph && !curves) continue;
    if (glyph) {
      call.instances = {glyphBuffer_, static_cast<uint32_t>(d.first * sizeof(GlyphInstance)),
                        static_cast<uint32_t>(d.count * sizeof(GlyphInstance))};
      call.texture = curves;
    } else {
      call.instances = {buffer_, static_cast<uint32_t>(d.first * sizeof(ShapeInstance)),
                        static_cast<uint32_t>(d.count * sizeof(ShapeInstance))};
    }
    call.instanceCount = d.count;
    // CSS px → clip space.
    float rows[8] = {static_cast<float>(2 / w), 0, -1, 0, static_cast<float>(-2 / h), 1, 0, 0};
    for (int i = 0; i < 8; i++) call.uniforms[i] = rows[i];
    call.scissorEnabled = d.scissorEnabled;
    call.scissor = d.scissor;
    call.stencilRef = d.stencilRef;
    device_.draw(call);
    stats.drawCalls++;
  }
  device_.endPass();
  device_.submit();
  stats.shapes = static_cast<uint32_t>(shapes_.size());
  stats.glyphs = static_cast<uint32_t>(glyphs_.size());
  return stats;
}

}  // namespace eng
