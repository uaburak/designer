// The Path shader's coverage (gfx/gl/Shaders.h kPathFragmentBody) in C++, on
// the CurveCache's packed data: bands, early exit, both fill rules. Kept
// identical to the GLSL; the native tests rasterize paths with it.
#pragma once

#include <algorithm>
#include <cmath>
#include <vector>

#include "render/GlyphCoverage.h"

namespace eng {

// Coverage (0–1) at (px, py) of the entry whose header is texel `start` of `data` (4 floats per texel).
inline float curveCoverage(const std::vector<float>& data, uint32_t start, float px, float py, float ppeX, float ppeY, bool evenOdd) {
  auto texel = [&](size_t i) { return &data[i * 4]; };
  const float* h = texel(start);
  const float* b = texel(start + 1);
  int nH = static_cast<int>(h[0]), nV = static_cast<int>(h[1]);
  float sy = std::max(b[3] - b[1], 1e-20f), sx = std::max(b[2] - b[0], 1e-20f);
  int bh = std::clamp(static_cast<int>(std::floor((py - b[1]) / sy * static_cast<float>(nH))), 0, nH - 1);
  int bv = std::clamp(static_cast<int>(std::floor((px - b[0]) / sx * static_cast<float>(nV))), 0, nV - 1);
  const float* dh = texel(start + 2 + static_cast<uint32_t>(bh));
  const float* dv = texel(start + 2 + static_cast<uint32_t>(nH + bv));
  RayCoverage hr, vr;
  for (int k = 0; k < static_cast<int>(dh[1]); k++) {
    size_t ci = static_cast<size_t>(texel(static_cast<size_t>(dh[0]) + static_cast<size_t>(k >> 2))[k & 3]);
    const float* a = texel(ci);
    const float* c = texel(ci + 1);
    if ((c[2] - px) * ppeX < -0.5f) break;
    float p0[2] = {a[0] - px, a[1] - py}, p1[2] = {a[2] - px, a[3] - py}, p2[2] = {c[0] - px, c[1] - py};
    crossX(p0, p1, p2, ppeX, hr);
  }
  for (int k = 0; k < static_cast<int>(dv[1]); k++) {
    size_t ci = static_cast<size_t>(texel(static_cast<size_t>(dv[0]) + static_cast<size_t>(k >> 2))[k & 3]);
    const float* a = texel(ci);
    const float* c = texel(ci + 1);
    if ((c[3] - py) * ppeY < -0.5f) break;
    float p0[2] = {a[1] - py, a[0] - px}, p1[2] = {a[3] - py, a[2] - px}, p2[2] = {c[1] - py, c[0] - px};
    crossX(p0, p1, p2, ppeY, vr);
  }
  auto fold = [&](float w) {
    if (!evenOdd) return std::min(std::fabs(w), 1.f);
    float m = w - 2.f * std::floor(w / 2.f);
    return 1.f - std::fabs(m - 1.f);
  };
  float ch = fold(hr.coverage), cv = fold(vr.coverage);
  float blended = (ch * hr.weight + cv * vr.weight) / std::max(hr.weight + vr.weight, 1.f / 65536);
  return std::clamp(std::max(blended, std::min(ch, cv)), 0.f, 1.f);
}

}  // namespace eng
