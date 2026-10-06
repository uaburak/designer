// The Glyph shader's coverage computation (gfx/gl/Shaders.h kGlyphFragment),
// in C++: for a sample point, a ray along +x and one along +y are crossed with
// every quadratic curve of the glyph; each crossing adds or removes coverage by
// how far into the pixel it lies (which roots count comes from the curve's
// endpoints' sides of the ray, as in Lengyel's "GPU-Centered Font Rendering
// Directly from Glyph Outlines", JCGT 2017). The two rays are blended by how
// close their nearest crossing is. Kept identical to the GLSL; the native
// tests rasterize glyphs with it.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>

namespace eng {

struct RayCoverage {
  float coverage = 0;  // signed
  float weight = 0;    // how close the nearest crossing is (1 = in this pixel)
};

// Crossings of the ray from the origin along +x with one curve (points relative to the sample, em).
inline void crossX(const float p0[2], const float p1[2], const float p2[2], float pixelsPerEm, RayCoverage& r) {
  unsigned code = (0x2E74u >> (((p0[1] > 0) ? 2u : 0u) + ((p1[1] > 0) ? 4u : 0u) + ((p2[1] > 0) ? 8u : 0u))) & 3u;
  if (!code) return;
  float ay = p0[1] - 2 * p1[1] + p2[1], by = p0[1] - p1[1];
  float ax = p0[0] - 2 * p1[0] + p2[0], bx = p0[0] - p1[0];
  float t1, t2;
  if (std::fabs(ay) < 1e-5f * std::max(std::fabs(by), 1e-30f) || std::fabs(ay) < 1e-12f) {
    t1 = t2 = p0[1] / (2 * by);
  } else {
    float d = std::sqrt(std::max(by * by - ay * p0[1], 0.f));
    t1 = (by - d) / ay;
    t2 = (by + d) / ay;
  }
  float x1 = (ax * t1 - 2 * bx) * t1 + p0[0];
  float x2 = (ax * t2 - 2 * bx) * t2 + p0[0];
  if (code & 1u) {
    r.coverage += std::clamp(x1 * pixelsPerEm + 0.5f, 0.f, 1.f);
    r.weight = std::max(r.weight, std::clamp(1 - std::fabs(x1 * pixelsPerEm) * 2, 0.f, 1.f));
  }
  if (code > 1u) {
    r.coverage -= std::clamp(x2 * pixelsPerEm + 0.5f, 0.f, 1.f);
    r.weight = std::max(r.weight, std::clamp(1 - std::fabs(x2 * pixelsPerEm) * 2, 0.f, 1.f));
  }
}

// Coverage (0–1) at `p` (em) of a glyph whose curves are `curves` (6 floats each), `ppe` pixels per em along x and y.
inline float glyphCoverage(const float* curves, size_t count, float px, float py, float ppeX, float ppeY) {
  RayCoverage h, v;
  for (size_t k = 0; k < count; k++) {
    const float* q = curves + k * 6;
    float a[2] = {q[0] - px, q[1] - py}, b[2] = {q[2] - px, q[3] - py}, c[2] = {q[4] - px, q[5] - py};
    crossX(a, b, c, ppeX, h);
    // The +y ray: the same with the axes swapped.
    float as[2] = {a[1], a[0]}, bs[2] = {b[1], b[0]}, cs[2] = {c[1], c[0]};
    crossX(as, bs, cs, ppeY, v);
  }
  float ch = std::min(std::fabs(h.coverage), 1.f), cv = std::min(std::fabs(v.coverage), 1.f);
  float blended = (ch * h.weight + cv * v.weight) / std::max(h.weight + v.weight, 1.f / 65536);
  return std::clamp(std::max(blended, std::min(ch, cv)), 0.f, 1.f);
}

}  // namespace eng
