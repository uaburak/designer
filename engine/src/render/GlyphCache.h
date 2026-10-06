// Glyph outlines on the GPU (docs/engine.md §7.5): every glyph drawn so far as
// its quadratic curves in one RGBA32F texture (two texels per curve), read by
// the Glyph shader, which computes each pixel's coverage from the curves
// directly — resolution-independent, crisp at every zoom, no atlas of bitmaps.
// One cache per Renderer (per GL context); it only grows.
#pragma once

#include <cstdint>
#include <unordered_map>
#include <vector>

#include "gfx/Device.h"
#include "text/Fonts.h"

namespace eng {

struct GlyphEntry {
  uint32_t start = 0;  // first texel
  uint32_t count = 0;  // curves
  float bounds[4] = {0, 0, 0, 0};
};

class GlyphCache {
 public:
  static constexpr uint32_t kWidth = 2048;  // texels per row

  explicit GlyphCache(gfx::Device& device) : device_(device) {}
  ~GlyphCache();
  GlyphCache(const GlyphCache&) = delete;
  GlyphCache& operator=(const GlyphCache&) = delete;

  // The glyph's curves (added on first use); nullptr for a glyph with no outline (a space).
  const GlyphEntry* get(text::Font* font, uint32_t glyph);
  // Uploads what was added since the last call; the texture (0 when there is none).
  gfx::TextureId flush();
  size_t glyphCount() const { return map_.size(); }
  uint32_t texelCount() const { return texels_; }
  const std::vector<float>& data() const { return data_; }  // 4 floats per texel (tests)

 private:
  gfx::Device& device_;
  std::unordered_map<uint64_t, GlyphEntry> map_;
  std::vector<float> data_;
  uint32_t texels_ = 0;
  uint32_t uploadedTexels_ = 0;
  uint32_t uploadedRows_ = 0;  // rows already on the GPU, complete ones
  uint32_t rows_ = 0;          // the texture's height
  gfx::TextureId texture_ = 0;
};

}  // namespace eng
