#include "render/GlyphCache.h"

#include <algorithm>

namespace eng {

GlyphCache::~GlyphCache() {
  if (texture_) device_.destroyTexture(texture_);
}

const GlyphEntry* GlyphCache::get(text::Font* font, uint32_t glyph) {
  if (!font) return nullptr;
  uint64_t key = (static_cast<uint64_t>(font->id()) << 32) | glyph;
  auto it = map_.find(key);
  if (it != map_.end()) return it->second.count ? &it->second : nullptr;
  const text::GlyphOutline& o = font->outline(glyph);
  GlyphEntry e;
  e.start = texels_;
  e.count = static_cast<uint32_t>(o.curveCount());
  for (int i = 0; i < 4; i++) e.bounds[i] = o.bounds[i];
  for (size_t c = 0; c < e.count; c++) {
    const float* q = &o.curves[c * 6];
    float texels[8] = {q[0], q[1], q[2], q[3], q[4], q[5], 0, 0};
    data_.insert(data_.end(), texels, texels + 8);
  }
  texels_ += e.count * 2;
  auto& stored = map_[key] = e;
  return stored.count ? &stored : nullptr;
}

gfx::TextureId GlyphCache::flush() {
  if (texels_ == 0 || (texels_ == uploadedTexels_ && texture_)) return texture_;
  uint32_t neededRows = (texels_ + kWidth - 1) / kWidth;
  if (neededRows > rows_) {
    uint32_t rows = std::max<uint32_t>(rows_ ? rows_ : 16, 16);
    while (rows < neededRows) rows *= 2;
    rows = std::min(rows, std::max<uint32_t>(device_.caps().maxTextureSize, neededRows));
    if (texture_) device_.destroyTexture(texture_);
    texture_ = device_.createTexture(gfx::TextureFormat::RGBA32F, kWidth, rows);
    rows_ = texture_ ? rows : 0;
    uploadedRows_ = 0;
    if (!texture_) return 0;
  }
  // The rows from the first incomplete one on (the last row may grow later).
  uint32_t first = uploadedRows_, last = neededRows;
  if (first < last) {
    std::vector<float> rows(static_cast<size_t>(last - first) * kWidth * 4, 0.f);
    size_t from = static_cast<size_t>(first) * kWidth * 4;
    size_t count = std::min(rows.size(), data_.size() - std::min(from, data_.size()));
    std::copy(data_.begin() + static_cast<long>(from), data_.begin() + static_cast<long>(from + count), rows.begin());
    device_.writeTexture(texture_, {0, static_cast<int>(first), static_cast<int>(kWidth), static_cast<int>(last - first)},
                         {reinterpret_cast<const uint8_t*>(rows.data()), rows.size() * sizeof(float)});
    uploadedRows_ = texels_ % kWidth == 0 ? last : last - 1;
  }
  uploadedTexels_ = texels_;
  return texture_;
}

}  // namespace eng
