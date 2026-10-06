// Curves on the GPU (docs/engine.md §6.3, §7.5): glyphs and paths as quadratic
// curves in one RGBA32F texture, read by the Path shader, which computes each
// pixel's coverage from them directly — resolution-independent, crisp at every
// zoom, any fill rule, no MSAA and no atlas of bitmaps.
//
// An entry: header (bands, bounds), one descriptor per horizontal and vertical
// band, each band's curve indices sorted for early exit, then the curves (the
// format is in gfx/gl/Shaders.h kPathFragment; render/CurveCoverage.h reads it
// in C++). Bands keep the per-pixel work small for paths of thousands of curves.
//
// Decision (replaces engine.md §6.3's stencil-then-cover + Loop-Blinn + MSAA for
// paths, as E3 did for glyphs): the canvas has no MSAA and this needs none.
// Entries live until the texture passes its budget; then the cache starts over
// at the next frame (beginFrame), and what is on screen is added again.
#pragma once

#include <cstdint>
#include <functional>
#include <unordered_map>
#include <vector>

#include "gfx/Device.h"
#include "text/Fonts.h"

namespace eng {

struct CurveEntry {
  uint32_t start = 0;     // the header texel
  uint32_t curves = 0;
  float bounds[4] = {0, 0, 0, 0};  // x0, y0, x1, y1 of the control points
};

class CurveCache {
 public:
  static constexpr uint32_t kWidth = 2048;               // texels per row
  static constexpr uint32_t kBudgetTexels = 1u << 22;    // 4M texels = 64 MB

  explicit CurveCache(gfx::Device& device) : device_(device) {}
  ~CurveCache();
  CurveCache(const CurveCache&) = delete;
  CurveCache& operator=(const CurveCache&) = delete;

  // Starts a frame: past the budget, everything is dropped (entries handed out before are invalid).
  void beginFrame();
  // A glyph's curves (added on first use); nullptr for a glyph with no outline (a space).
  const CurveEntry* glyph(text::Font* font, uint32_t glyph);
  // A path's curves under `key` (6 floats per quadratic), made by `make` the first time; nullptr when empty.
  const CurveEntry* path(uint64_t key, const std::function<void(std::vector<float>&)>& make);
  // Uploads what was added since the last call; the texture (0 when there is none).
  gfx::TextureId flush();

  size_t glyphCount() const { return glyphs_.size(); }
  size_t pathCount() const { return paths_.size(); }
  uint32_t texelCount() const { return texels_; }
  uint32_t generation() const { return generation_; }
  const std::vector<float>& data() const { return data_; }  // 4 floats per texel (tests)

  // Lays out an entry for `curves` at texel `base` into `out` (appended); the CPU side of the format.
  static CurveEntry pack(const float* curves, size_t count, uint32_t base, std::vector<float>& out);

 private:
  const CurveEntry* add(const float* curves, size_t count);

  gfx::Device& device_;
  std::unordered_map<uint64_t, CurveEntry> glyphs_;
  std::unordered_map<uint64_t, CurveEntry> paths_;
  std::vector<float> data_;
  uint32_t texels_ = 0;
  uint32_t uploadedRows_ = 0;  // rows already on the GPU, complete ones
  uint32_t uploadedTexels_ = 0;
  uint32_t rows_ = 0;          // the texture's height
  uint32_t generation_ = 0;
  gfx::TextureId texture_ = 0;
  CurveEntry none_;
};

}  // namespace eng
