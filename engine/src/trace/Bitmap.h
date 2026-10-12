// Vectorize's images (docs/ai.md §5): the straight RGBA input, brought down to the tracer's pixel budget, the label
// image the palette makes of it, and the one-byte-per-pixel masks Potrace's method traces.
#pragma once

#include <algorithm>
#include <cstdint>
#include <vector>

namespace eng::trace {

// The tracer's pixel budget: larger inputs are box-filtered down to this long side first (the paths come back in the
// input's own pixels). 1024² keeps one update within the live-preview budget (docs/ai.md §5 "Budget").
inline constexpr int kMaxSide = 1024;
// Pixels with less alpha are left out (transparent).
inline constexpr uint8_t kAlphaCutoff = 128;
// The label of a transparent pixel.
inline constexpr uint8_t kNoLabel = 255;

// Straight RGBA8, rows top to bottom.
struct Image {
  int w = 0, h = 0;
  std::vector<uint8_t> rgba;
  const uint8_t* at(int x, int y) const { return rgba.data() + (static_cast<size_t>(y) * w + x) * 4; }
};

// One byte per pixel, 0 or 1, rows top to bottom; outside is 0.
struct Mask {
  int w = 0, h = 0;
  std::vector<uint8_t> px;
  bool get(int x, int y) const { return x >= 0 && y >= 0 && x < w && y < h && px[static_cast<size_t>(y) * w + x] != 0; }
};

// `rgba` (w × h) at most kMaxSide on its long side: a box filter over premultiplied colour (a copy when it fits).
inline Image fitToBudget(const uint8_t* rgba, int w, int h, int maxSide = kMaxSide) {
  Image out;
  int longSide = std::max(w, h);
  if (longSide <= maxSide) {
    out.w = w;
    out.h = h;
    out.rgba.assign(rgba, rgba + static_cast<size_t>(w) * h * 4);
    return out;
  }
  double s = static_cast<double>(maxSide) / longSide;
  out.w = std::max(1, static_cast<int>(w * s + 0.5));
  out.h = std::max(1, static_cast<int>(h * s + 0.5));
  out.rgba.assign(static_cast<size_t>(out.w) * out.h * 4, 0);
  for (int oy = 0; oy < out.h; oy++) {
    int y0 = static_cast<int>(static_cast<int64_t>(oy) * h / out.h), y1 = std::max(y0 + 1, static_cast<int>(static_cast<int64_t>(oy + 1) * h / out.h));
    for (int ox = 0; ox < out.w; ox++) {
      int x0 = static_cast<int>(static_cast<int64_t>(ox) * w / out.w), x1 = std::max(x0 + 1, static_cast<int>(static_cast<int64_t>(ox + 1) * w / out.w));
      uint64_t r = 0, g = 0, b = 0, a = 0, n = 0;
      for (int y = y0; y < y1; y++)
        for (int x = x0; x < x1; x++) {
          const uint8_t* p = rgba + (static_cast<size_t>(y) * w + x) * 4;
          r += static_cast<uint64_t>(p[0]) * p[3];
          g += static_cast<uint64_t>(p[1]) * p[3];
          b += static_cast<uint64_t>(p[2]) * p[3];
          a += p[3];
          n++;
        }
      uint8_t* o = out.rgba.data() + (static_cast<size_t>(oy) * out.w + ox) * 4;
      if (a) {
        o[0] = static_cast<uint8_t>((r + a / 2) / a);
        o[1] = static_cast<uint8_t>((g + a / 2) / a);
        o[2] = static_cast<uint8_t>((b + a / 2) / a);
      }
      o[3] = static_cast<uint8_t>((a + n / 2) / n);
    }
  }
  return out;
}

}  // namespace eng::trace
