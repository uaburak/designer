#include "render/CurveCache.h"

#include <algorithm>
#include <cmath>

namespace eng {

CurveCache::~CurveCache() {
  if (texture_) device_.destroyTexture(texture_);
}

void CurveCache::beginFrame() {
  if (texels_ <= kBudgetTexels) return;
  glyphs_.clear();
  paths_.clear();
  data_.clear();
  texels_ = 0;
  uploadedRows_ = 0;
  uploadedTexels_ = 0;
  generation_++;
}

CurveEntry CurveCache::pack(const float* curves, size_t count, uint32_t base, std::vector<float>& out) {
  CurveEntry e;
  e.start = base;
  e.curves = static_cast<uint32_t>(count);
  float x0 = 1e30f, y0 = 1e30f, x1 = -1e30f, y1 = -1e30f;
  struct Info {
    float minX, minY, maxX, maxY;
  };
  std::vector<Info> info(count);
  for (size_t c = 0; c < count; c++) {
    const float* q = curves + c * 6;
    Info i{std::min({q[0], q[2], q[4]}), std::min({q[1], q[3], q[5]}), std::max({q[0], q[2], q[4]}), std::max({q[1], q[3], q[5]})};
    info[c] = i;
    x0 = std::min(x0, i.minX), y0 = std::min(y0, i.minY), x1 = std::max(x1, i.maxX), y1 = std::max(y1, i.maxY);
  }
  if (!count) x0 = y0 = x1 = y1 = 0;
  e.bounds[0] = x0, e.bounds[1] = y0, e.bounds[2] = x1, e.bounds[3] = y1;
  // Bands: about 4 curves per band and direction, at most 32.
  uint32_t n = std::clamp<uint32_t>(static_cast<uint32_t>(count / 4), 1, 32);
  std::vector<std::vector<uint32_t>> h(n), v(n);
  float bh = (y1 - y0) / static_cast<float>(n), bw = (x1 - x0) / static_cast<float>(n);
  for (uint32_t c = 0; c < count; c++) {
    const Info& i = info[c];
    for (uint32_t b = 0; b < n; b++) {
      float lo = y0 + bh * static_cast<float>(b), hi = b + 1 == n ? y1 : y0 + bh * static_cast<float>(b + 1);
      if (i.maxY >= lo && i.minY <= hi) h[b].push_back(c);
      float l = x0 + bw * static_cast<float>(b), r = b + 1 == n ? x1 : x0 + bw * static_cast<float>(b + 1);
      if (i.maxX >= l && i.minX <= r) v[b].push_back(c);
    }
  }
  for (auto& list : h) std::sort(list.begin(), list.end(), [&](uint32_t a, uint32_t b) { return info[a].maxX > info[b].maxX; });
  for (auto& list : v) std::sort(list.begin(), list.end(), [&](uint32_t a, uint32_t b) { return info[a].maxY > info[b].maxY; });
  // Texels: header, bounds, 2n descriptors, the index lists, the curves.
  uint32_t indexTexels = 0;
  for (auto& l : h) indexTexels += static_cast<uint32_t>((l.size() + 3) / 4);
  for (auto& l : v) indexTexels += static_cast<uint32_t>((l.size() + 3) / 4);
  uint32_t curveBase = base + 2 + 2 * n + indexTexels;
  auto texel = [&](float a, float b, float c, float d) { out.insert(out.end(), {a, b, c, d}); };
  texel(static_cast<float>(n), static_cast<float>(n), static_cast<float>(count), 0);
  texel(x0, y0, x1, y1);
  uint32_t at = base + 2 + 2 * n;
  for (auto* lists : {&h, &v})
    for (auto& l : *lists) {
      texel(static_cast<float>(at), static_cast<float>(l.size()), 0, 0);
      at += static_cast<uint32_t>((l.size() + 3) / 4);
    }
  for (auto* lists : {&h, &v})
    for (auto& l : *lists)
      for (size_t k = 0; k < l.size(); k += 4) {
        float t[4] = {0, 0, 0, 0};
        for (size_t j = 0; j < 4 && k + j < l.size(); j++) t[j] = static_cast<float>(curveBase + 2 * l[k + j]);
        texel(t[0], t[1], t[2], t[3]);
      }
  for (size_t c = 0; c < count; c++) {
    const float* q = curves + c * 6;
    texel(q[0], q[1], q[2], q[3]);
    texel(q[4], q[5], info[c].maxX, info[c].maxY);
  }
  return e;
}

const CurveEntry* CurveCache::add(const float* curves, size_t count) {
  size_t before = data_.size();
  CurveEntry e = pack(curves, count, texels_, data_);
  texels_ += static_cast<uint32_t>((data_.size() - before) / 4);
  none_ = e;
  return &none_;
}

const CurveEntry* CurveCache::glyph(text::Font* font, uint32_t glyph) {
  if (!font) return nullptr;
  uint64_t key = (static_cast<uint64_t>(font->id()) << 32) | glyph;
  auto it = glyphs_.find(key);
  if (it != glyphs_.end()) return it->second.curves ? &it->second : nullptr;
  const text::GlyphOutline& o = font->outline(glyph);
  CurveEntry e;
  if (o.curveCount()) e = *add(o.curves.data(), o.curveCount());
  auto& stored = glyphs_[key] = e;
  return stored.curves ? &stored : nullptr;
}

const CurveEntry* CurveCache::path(uint64_t key, const std::function<void(std::vector<float>&)>& make) {
  auto it = paths_.find(key);
  if (it != paths_.end()) return it->second.curves ? &it->second : nullptr;
  std::vector<float> curves;
  make(curves);
  CurveEntry e;
  if (curves.size() >= 6) e = *add(curves.data(), curves.size() / 6);
  auto& stored = paths_[key] = e;
  return stored.curves ? &stored : nullptr;
}

gfx::TextureId CurveCache::flush() {
  if (texels_ == 0 || (texels_ == uploadedTexels_ && texture_)) return texture_;
  uint32_t neededRows = (texels_ + kWidth - 1) / kWidth;
  if (neededRows > rows_ || !texture_) {
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
