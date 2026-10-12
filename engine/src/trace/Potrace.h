// Potrace's method (Peter Selinger, "Potrace: a polygon-based tracing algorithm", 2003), written here from the paper
// (no GPL code read or copied): a binary mask's boundaries become smooth closed curves (docs/ai.md §5 step 5).
//
//   1. Path decomposition: every boundary between set and unset pixels, walked on the pixel-corner lattice with the
//      set pixels on the right (outlines come out clockwise on screen, holes counter-clockwise), the ambiguous
//      diagonal corners resolved by the "minority" turn policy. Each boundary edge is walked once (an edge-marking
//      walk rather than the paper's invert-and-repeat; the same paths, in time linear in the image).
//   2. Optimal polygon: the fewest straight segments (then the least penalty) whose subpaths are straight in the
//      paper's sense (§2.2: not all four directions, every point within ½ of the line, points within 1 of the start
//      not constraining it); each point's reach made non-decreasing, so the fewest segments bound each vertex to a
//      range and the penalty is minimised over those ranges only. The cyclic problem is solved from the starts in
//      the narrowest point's reach (any polygon has a vertex there).
//   3. Vertex adjustment: each vertex moved to the point nearest the two least-squares lines of its edges, within the
//      unit square around it (§2.3.2).
//   4. Smoothing: each corner becomes a Bézier curve through the edges' midpoints, or stays a corner when its α
//      exceeds alphaMax (§2.3.3).
//   5. Curve optimisation: runs of curves joined into one when the joined curve stays within optTolerance (§2.4).
#pragma once

#include <chrono>
#include <cstdint>
#include <vector>

#include "geometry/Path.h"
#include "math/Math.h"
#include "trace/Bitmap.h"

namespace eng::trace {

struct TraceParams {
  double alphaMax = 1.0;      // corners: α above this stays a corner (0: all corners; 4/3: none)
  double optTolerance = 0.2;  // curve optimisation's tolerance in pixels (0: off)
};

// What one trace may spend: a wall-clock deadline and a cap on the curve segments it makes. Exceeding either stops
// the trace (`exceeded`), and the caller reports it instead of a partial result.
struct Limits {
  std::chrono::steady_clock::time_point deadline = std::chrono::steady_clock::time_point::max();
  uint64_t maxSegments = UINT64_MAX;
  uint64_t segments = 0;
  bool exceeded = false;
  bool check() {
    if (!exceeded && (segments > maxSegments || std::chrono::steady_clock::now() > deadline)) exceeded = true;
    return !exceeded;
  }
};

// A pixel-corner lattice point.
struct IPt {
  int x = 0, y = 0;
  bool operator==(const IPt& o) const { return x == o.x && y == o.y; }
};

// A boundary on the pixel-corner lattice (step 1): every lattice point it passes, in order; closed.
struct Contour {
  std::vector<IPt> points;
  int64_t area = 0;  // signed: > 0 an outline, < 0 a hole
};

std::vector<Contour> decompose(const Mask& m);

// The mask's boundaries as closed curves (fill rule EVENODD), mapped by `toOut` from mask pixels.
void traceMask(const Mask& m, const TraceParams& params, const Mat2x3& toOut, geom::Path& out, Limits& limits);

}  // namespace eng::trace
