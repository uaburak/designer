// A path's corners rounded (round 19a, docs/engine.md §5 "Boolean corner radius"): what a boolean group's own
// cornerRadius / cornerSmoothing do to its result (live Figma 2026-10-19, docs/research/figma/live/2026-10-18/
// boolean-radius.txt). Every corner of the outline — convex and concave, where the tangent turns — gets the radius,
// clamped per corner as Figma clamps a vector path's corners: the cut along each neighbouring edge at most half of it
// (the whole of it next to a smooth join), so 999 is "as round as fits" (a 60-wide notch's corners: 30, a half
// circle). Smoothing is Figma's squircle ("Desperately seeking squircles": an arc in the middle eased into the edges by
// two cubics), the same construction as a rectangle's, for any angle; given up first when the edge has no room for it.
// Corners next to a curve get a plain circular arc tangent to both sides. Arcs are cubics (Figma's 0.5523 · r handles).
#pragma once

#include "geometry/Path.h"

namespace eng::geom {

// Every closed or open contour of `path` with its corners rounded by `radius` (≤ 0: the path as it is, cleaned of
// redundant points) and `smoothing` (0–1). Open contours keep their ends.
Path roundCorners(const Path& path, double radius, double smoothing = 0);

// The same path without what draws nothing: zero-length segments and the points between collinear lines that go on in
// the same direction (Clipper's results keep them). `eps`: how close counts (local units).
Path removeRedundantPoints(const Path& path, double eps = 1e-6);

}  // namespace eng::geom
