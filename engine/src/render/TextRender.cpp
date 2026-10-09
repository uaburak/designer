// TEXT nodes and overlay labels: glyphs as Path-shader instances (curves from
// the CurveCache), any paint (gradients and images span the text box),
// decorations as rectangles (docs/engine.md §7.5).

#include <algorithm>
#include <cmath>

#include "render/Renderer.h"
#include "scene/CodecKiwi.h"

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
  // LOD (docs/engine.md §6.8): glyphs down to an em of one device pixel (Figma still draws small text as glyphs:
  // dark blobs, not faint bars, in its own thumbnails); under that, each line as a bar holding the line's ink — its
  // glyphs' area spread over the bar (full colour × coverage), so the text weighs on the page as its glyphs would.
  double scale = levelScale(m);
  float em = 0;
  for (const text::LaidGlyph& g : L->glyphs) em = std::max(em, g.size);
  if (!L->glyphs.empty() && em * scale < kGlyphMinEmPx && !exporting_) {
    stats_.greeked++;
    const text::LaidGlyph& first = L->glyphs.front();
    const auto* fills = L->styles[first.style].fills;
    const Paint* paint = nullptr;
    if (fills)
      for (const Paint& f : *fills)
        if (f.visible && f.opacity > 0) paint = &f;
    if (!paint) return;
    static const Paint kGrey = Paint::solid(Color{0.5f, 0.5f, 0.5f, 1});  // gradients and images: a neutral bar
    const Paint& bar = paint->type == PaintType::SOLID ? *paint : kGrey;
    for (const text::LaidLine& l : L->lines) {
      if (l.width <= 0 || l.glyphCount == 0) continue;
      double h = std::max(l.ascent * 0.7, 0.0);
      Rect r{l.x, l.baseline - h, l.width, h};
      double ink = 0;
      for (uint32_t k = l.firstGlyph; k < l.firstGlyph + l.glyphCount && k < L->glyphs.size(); k++) {
        const text::LaidGlyph& g = L->glyphs[k];
        ink += glyphArea(g.font, g.glyph) * static_cast<double>(g.size) * g.size;
      }
      double coverage = r.w * r.h > 0 ? std::clamp(ink / (r.w * r.h), 0.0, 1.0) : 0;
      if (coverage <= 0) continue;
      Mat2x3 bm = m * Mat2x3::translate(r.x, r.y);
      DrawInstance q = makeShape(bm, {r.w, r.h}, ShapeKind::Rect, kSquare, Color{}, 1, Color{}, 0, 0, 0);
      DrawState state;
      if (!setPaint(q, state, bar, Mat2x3::translate(r.x, r.y), p.size, alpha * coverage)) continue;
      emit(q, Pass::Shape, state);
    }
    return;
  }
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
      // The underline's own colour (textDecorationFillPaints) when it has one, else the text's.
      const text::TextFeatures& tf = L->styles[d.style].features;
      const auto* fills = tf.hasDecorationFills ? &tf.decorationFills : L->styles[d.style].fills;
      if (!fills || f >= fills->size()) continue;
      const Paint& paint = (*fills)[f];
      if (!paint.visible) continue;
      Mat2x3 dm = m * Mat2x3::translate(d.rect.x, d.rect.y);
      if (d.angle != 0) {
        double c = std::cos(d.angle), s = std::sin(d.angle);
        dm = dm * Mat2x3{c, -s, 0, s, c, 0};
      }
      DrawInstance q = makeShape(dm, {d.rect.w, d.rect.h}, d.round ? ShapeKind::Ellipse : ShapeKind::Rect, kSquare, Color{}, 1, Color{}, 0, 0, 0);
      DrawState state;
      if (!setPaint(q, state, paint, Mat2x3::translate(d.rect.x, d.rect.y), p.size, alpha)) continue;
      emit(q, Pass::Shape, state);
    }
  }
}

double Renderer::glyphArea(text::Font* font, uint32_t glyph) {
  if (!font) return 0;
  uint64_t key = (static_cast<uint64_t>(font->id()) << 32) | glyph;
  auto it = glyphAreas_.find(key);
  if (it != glyphAreas_.end()) return it->second;
  // The outline's area (em²) by Green's theorem over its quadratics: ∑ (2 p0×p1 + 2 p1×p2 + p0×p2) / 6.
  const text::GlyphOutline& o = font->outline(glyph);
  double a = 0;
  for (size_t i = 0; i + 6 <= o.curves.size(); i += 6) {
    double x0 = o.curves[i], y0 = o.curves[i + 1], x1 = o.curves[i + 2], y1 = o.curves[i + 3], x2 = o.curves[i + 4], y2 = o.curves[i + 5];
    a += (2 * (x0 * y1 - y0 * x1) + 2 * (x1 * y2 - y1 * x2) + (x0 * y2 - y0 * x2)) / 6;
  }
  if (glyphAreas_.size() > 65536) glyphAreas_.clear();
  return glyphAreas_[key] = std::fabs(a);
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

const text::TextLayout* Renderer::label(const std::string& characters, const char* style, double size, double maxWidth, int maxLines, double weight) {
  text::FontRegistry& fonts = text::FontRegistry::get();
  if (labelsGeneration_ != fonts.generation() || labels_.size() > 512) {
    labels_.clear();
    labelsGeneration_ = fonts.generation();
  }
  double width = maxWidth >= 0 ? std::floor(maxWidth) : -1;
  std::string key = std::string(style) + "\n" + std::to_string(size) + "\n" + std::to_string(width) + "\n" + std::to_string(maxLines) + "\n" +
                    std::to_string(weight) + "\n" + characters;
  auto it = labels_.find(key);
  if (it != labels_.end()) return it->second.get();
  FontName name{"Inter", style, ""};
  text::FontRegistry::State state;
  if (!fonts.find(name, &state)) return nullptr;
  NodeProps p;
  p.type = NodeType::TEXT;
  p.text().textData.characters = characters;
  p.text().fontName = name;
  p.text().fontSize = size;
  p.text().textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
  if (weight > 0) {
    // Inter is variable: the weight axis ('wght') set on top of the style's own.
    json::Value v;
    if (json::parse("[{\"axisTag\":2003265652,\"value\":" + std::to_string(weight) + "}]", v))
      p.extra["fontVariations"] = codec::extraFromJson("NodeChange", "fontVariations", v);
  }
  text::LayoutOptions o;
  if (width >= 0) {
    p.text().textTruncation = TextTruncation::ENDING;
    p.text().maxLines = maxLines > 0 ? maxLines : 1;
    p.text().textAutoResize = TextAutoResize::HEIGHT;
    o.width = width;
  }
  auto layout = text::layoutText(p, o);
  if (layout->pendingFont) return nullptr;
  auto* raw = layout.get();
  labels_[key] = std::move(layout);
  return raw;
}

}  // namespace eng
