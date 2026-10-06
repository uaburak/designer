// TEXT nodes and overlay labels: glyphs as Path-shader instances (curves from
// the CurveCache), any paint (gradients and images span the text box),
// decorations as rectangles (docs/engine.md §7.5).

#include <cmath>

#include "render/Renderer.h"

namespace eng {

namespace {

const CornerRadii kSquare{0, 0, 0, 0};

}  // namespace

void Renderer::drawText(const Document& doc, const NodeProps& p, Guid id, const Mat2x3& m, double alpha) {
  (void)doc;
  if (!texts_) return;
  const text::TextLayout* L = texts_->textLayout(id);
  if (!L) return;
  Rect ink = L->inkBounds;
  Rect onScreen = transformedBounds(m * Mat2x3::translate(ink.x, ink.y), ink.w, ink.h);
  Rect padded{onScreen.x - 2, onScreen.y - 2, onScreen.w + 4, onScreen.h + 4};
  if (!padded.intersects(screen_)) return;
  // Fill by fill (bottom first), each glyph in its run's fills.
  size_t layers = 0;
  for (const auto& s : L->styles) layers = std::max(layers, s.fills ? s.fills->size() : 0);
  for (size_t f = 0; f < layers; f++) {
    for (const text::LaidGlyph& g : L->glyphs) {
      const auto* fills = L->styles[g.style].fills;
      if (!fills || f >= fills->size()) continue;
      const Paint& paint = (*fills)[f];
      if (!paint.visible) continue;
      const CurveEntry* e = curves_.glyph(g.font, g.glyph);
      if (!e) continue;
      // em → node space: scale by the font size, then to the glyph's origin.
      Mat2x3 em{g.size, 0, g.x, 0, g.size, g.y};
      DrawInstance q{};
      Mat2x3 gm = m * em;
      q.linear[0] = static_cast<float>(gm.m00);
      q.linear[1] = static_cast<float>(gm.m10);
      q.linear[2] = static_cast<float>(gm.m01);
      q.linear[3] = static_cast<float>(gm.m11);
      q.origin[0] = static_cast<float>(gm.m02);
      q.origin[1] = static_cast<float>(gm.m12);
      q.origin[2] = static_cast<float>(e->start);
      q.origin[3] = -1;
      for (int i = 0; i < 4; i++) q.box[i] = e->bounds[i];
      q.geom[2] = static_cast<float>(ShapeKind::Path);
      DrawState state;
      if (!setPaint(q, state, paint, em, p.size, alpha)) continue;
      emit(q, Pass::Path, state);
      stats_.glyphs++;
    }
    for (const text::Decoration& d : L->decorations) {
      const auto* fills = L->styles[d.style].fills;
      if (!fills || f >= fills->size()) continue;
      const Paint& paint = (*fills)[f];
      Mat2x3 dm = m * Mat2x3::translate(d.rect.x, d.rect.y);
      DrawInstance q = makeShape(dm, {d.rect.w, d.rect.h}, ShapeKind::Rect, kSquare, Color{}, 1, Color{}, 0, 0, 0);
      DrawState state;
      if (!setPaint(q, state, paint, Mat2x3::translate(d.rect.x, d.rect.y), p.size, alpha)) continue;
      emit(q, Pass::Shape, state);
    }
  }
}

void Renderer::drawGlyphs(const text::TextLayout& L, const Mat2x3& m, const Color& color, double alpha) {
  Paint paint = Paint::solid(color);
  for (const text::LaidGlyph& g : L.glyphs) {
    const CurveEntry* e = curves_.glyph(g.font, g.glyph);
    if (!e) continue;
    Mat2x3 gm = m * Mat2x3{g.size, 0, g.x, 0, g.size, g.y};
    DrawInstance q{};
    q.linear[0] = static_cast<float>(gm.m00);
    q.linear[1] = static_cast<float>(gm.m10);
    q.linear[2] = static_cast<float>(gm.m01);
    q.linear[3] = static_cast<float>(gm.m11);
    q.origin[0] = static_cast<float>(gm.m02);
    q.origin[1] = static_cast<float>(gm.m12);
    q.origin[2] = static_cast<float>(e->start);
    q.origin[3] = -1;
    for (int i = 0; i < 4; i++) q.box[i] = e->bounds[i];
    q.geom[2] = static_cast<float>(ShapeKind::Path);
    DrawState state;
    if (!setPaint(q, state, paint, Mat2x3{}, {1, 1}, alpha)) continue;
    emit(q, Pass::Path, state);
    stats_.glyphs++;
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
