// Vectorize's palette (docs/ai.md §5 steps 2–4): the image's colours reduced to a few (Figma's three modes: "Full
// color" by k-means in OKLab, "Grayscale" by k-means on luminance, "Black and white" by a luminance threshold), small
// regions merged into a neighbour, and the colours ranked by area for stacking.
#pragma once

#include <array>
#include <cstdint>
#include <vector>

#include "trace/Bitmap.h"

namespace eng::trace {

enum class Mode : uint8_t { FULL_COLOR, GRAYSCALE, BLACK_AND_WHITE };

struct Palette {
  int w = 0, h = 0;
  std::vector<uint8_t> labels;                 // per pixel: an index into colors, kNoLabel when transparent
  std::vector<std::array<uint8_t, 3>> colors;  // sRGB
  std::vector<uint32_t> area;                  // pixels per colour
};

// K-means' limits (docs/ai.md §5): at most this many sampled pixels and iterations; k-means++ seeded with 1.
inline constexpr int kMaxSamples = 65536;
inline constexpr int kMaxIterations = 16;

// Every opaque pixel labelled with one of at most `k` colours (FULL_COLOR / GRAYSCALE; colours nobody uses are
// dropped), or black / white by Rec. 709 luminance < threshold · 2.55 (BLACK_AND_WHITE, threshold 0–100).
// Deterministic: the same image and options give the same labels.
Palette quantize(const Image& img, Mode mode, int k, double threshold);

// Regions (4-connected, one label) under `speckle` pixels take the label of their largest neighbouring region.
void despeckle(Palette& p, int speckle);

// Colours renumbered by area, largest first (ties: the darker first), unused ones dropped.
void sortByArea(Palette& p);

}  // namespace eng::trace
