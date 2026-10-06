// TEXT nodes and overlay labels: glyphs as instances of the Glyph shader
// (curves from the GlyphCache), decorations as rectangles (docs/engine.md §7.5).

#include <cmath>

#include "render/Renderer.h"

namespace eng {

namespace {

const CornerRadii kSquare{0, 0, 0, 0};

GlyphInstance glyphInstance(const Mat2x3& m, const text::LaidGlyph& g, const GlyphEntry& e, const Color& c, double alpha) {
  // em → layout space: scale by the font size, then to the glyph's origin.
  Mat2x3 em = m * Mat2x3{g.size, 0, g.x, 0, g.size, g.y};
  GlyphInstance gi;
  gi.linear[0] = static_cast<float>(em.m00);
  gi.linear[1] = static_cast<float>(em.m10);
  gi.linear[2] = static_cast<float>(em.m01);
  gi.linear[3] = static_cast<float>(em.m11);
  gi.origin[0] = static_cast<float>(em.m02);
  gi.origin[1] = static_cast<float>(em.m12);
  gi.origin[2] = static_cast<float>(e.start);
  gi.origin[3] = static_cast<float>(e.count);
  for (int i = 0; i < 4; i++) gi.bounds[i] = e.bounds[i];
  float a = static_cast<float>(c.a * alpha);
  gi.color[0] = c.r * a;
  gi.color[1] = c.g * a;
  gi.color[2] = c.b * a;
  gi.color[3] = a;
  return gi;
}

}  // namespace

void Renderer::drawText(const NodeProps& p, Guid id, const Mat2x3& m, double alpha) {
  if (!texts_) return;
  const text::TextLayout* L = texts_->textLayout(id);
  if (!L) return;
  Rect ink = L->inkBounds;
  Rect onScreen = transformedBounds(m * Mat2x3::translate(ink.x, ink.y), ink.w, ink.h);
  Rect padded{onScreen.x - 2, onScreen.y - 2, onScreen.w + 4, onScreen.h + 4};
  if (!padded.intersects(screen_)) return;
  (void)p;
  // Fill by fill (bottom first), each glyph in its run's fills.
  size_t layers = 0;
  for (const auto& s : L->styles) layers = std::max(layers, s.fills ? s.fills->size() : 0);
  for (size_t f = 0; f < layers; f++) {
    for (const text::LaidGlyph& g : L->glyphs) {
      const auto* fills = L->styles[g.style].fills;
      if (!fills || f >= fills->size()) continue;
      const Paint& paint = (*fills)[f];
      if (!paint.visible || paint.type != PaintType::SOLID) continue;
      const GlyphEntry* e = glyphCache_.get(g.font, g.glyph);
      if (!e) continue;
      emitGlyph(glyphInstance(m, g, *e, paint.color, alpha * paint.opacity));
    }
    for (const text::Decoration& d : L->decorations) {
      const auto* fills = L->styles[d.style].fills;
      if (!fills || f >= fills->size()) continue;
      const Paint& paint = (*fills)[f];
      if (!paint.visible || paint.type != PaintType::SOLID) continue;
      Mat2x3 dm = m * Mat2x3::translate(d.rect.x, d.rect.y);
      emit(makeShape(dm, {d.rect.w, d.rect.h}, ShapeKind::Rect, kSquare, paint.color, alpha * paint.opacity, paint.color, 0, 0, 0),
           Pass::Color);
    }
  }
}

void Renderer::drawGlyphs(const text::TextLayout& L, const Mat2x3& m, const Color& color, double alpha) {
  for (const text::LaidGlyph& g : L.glyphs) {
    const GlyphEntry* e = glyphCache_.get(g.font, g.glyph);
    if (e) emitGlyph(glyphInstance(m, g, *e, color, alpha));
  }
}

const text::TextLayout* Renderer::label(const std::string& characters, const char* style, double size, double maxWidth) {
  text::FontRegistry& fonts = text::FontRegistry::get();
  if (labelsGeneration_ != fonts.generation() || labels_.size() > 512) {
    labels_.clear();
    labelsGeneration_ = fonts.generation();
  }
  double width = maxWidth >= 0 ? std::floor(maxWidth) : -1;
  std::string key = std::string(style) + "\n" + std::to_string(size) + "\n" + std::to_string(width) + "\n" + characters;
  auto it = labels_.find(key);
  if (it != labels_.end()) return it->second.get();
  FontName name{"Inter", style, ""};
  text::FontRegistry::State state;
  if (!fonts.find(name, &state)) return nullptr;
  NodeProps p;
  p.type = NodeType::TEXT;
  p.textData.characters = characters;
  p.fontName = name;
  p.fontSize = size;
  p.textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
  text::LayoutOptions o;
  if (width >= 0) {
    p.textTruncation = TextTruncation::ENDING;
    p.maxLines = 1;
    p.textAutoResize = TextAutoResize::HEIGHT;
    o.width = width;
  }
  auto layout = text::layoutText(p, o);
  if (layout->pendingFont) return nullptr;
  auto* raw = layout.get();
  labels_[key] = std::move(layout);
  return raw;
}

}  // namespace eng
