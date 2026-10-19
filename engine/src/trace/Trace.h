// Vectorize (docs/ai.md §5): an image's pixels to stacked colour layers of smooth closed curves. The palette
// (Quantize.h), then one mask per colour — every pixel whose colour ranks at or above it by area, so the bottom layer
// is the whole opaque area and the layers leave no gaps between them (vtracer's "stacked" mode) — each traced with
// Potrace's method (Potrace.h).
#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <vector>

#include "base/Json.h"
#include "geometry/Path.h"
#include "trace/Quantize.h"

namespace eng::trace {

// The options (TraceOptions in src/shared/ai/types.ts). Ranges and defaults are ours (docs/ai.md §5 "Options").
struct Options {
  Mode mode = Mode::FULL_COLOR;
  int colors = 8;          // FULL_COLOR: 1–32 (Figma's Recolor: from 1)
  int grays = 4;           // GRAYSCALE: 1–16
  double threshold = 50;   // BLACK_AND_WHITE: 0–100
  int speckle = 4;         // regions under this many pixels merge into a neighbour (0–1000)
  double alphaMax = 1.0;   // 0–4/3
  double optTolerance = 0.2;  // 0–1
};

// Reads {mode, colors, grays, threshold, speckle, alphaMax, optTolerance}; missing fields keep their defaults, values
// are clamped to their ranges. False for an unknown mode.
bool readOptions(const json::Value& v, Options& out);

// What one trace may spend (docs/ai.md §5 "Budget"): past either, the trace stops and reports `exceeded`.
struct Budget {
  double timeLimitMs = 2000;
  uint64_t maxSegments = 200000;  // curve and line segments over all layers
};

struct Layer {
  std::array<uint8_t, 3> color{};
  uint64_t area = 0;  // the colour's pixels (input pixels)
  geom::Path path;    // closed contours in input pixels, fill rule EVENODD
};

struct Result {
  int width = 0, height = 0;              // the input's size
  int tracedWidth = 0, tracedHeight = 0;  // after fitting the pixel budget
  std::vector<Layer> layers;              // bottom (largest area) to top
  uint64_t segments = 0;
  double ms = 0;
  bool exceeded = false;  // over the budget: `layers` is empty
};

Result trace(const uint8_t* rgba, int w, int h, const Options& opts, const Budget& budget = {});

// "#RRGGBB".
std::string hexOf(const std::array<uint8_t, 3>& c);
// SVG path data (M / L / C / Z, absolute, two decimals).
std::string svgPathData(const geom::Path& p);

}  // namespace eng::trace
