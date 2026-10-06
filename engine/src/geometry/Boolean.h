// Path booleans (docs/engine.md §5, E4): Union, Subtract, Intersect, Exclude
// (XOR) over paths that keep their curves.
//
// Decision (recorded in docs/engine-build.md): the clipping itself is Clipper2
// (vendored, Boost licence) on the flattened operands — robust on overlapping,
// touching and self-intersecting input; every flattened point carries (in
// Clipper's Z) the curve and parameter it came from, intersections are given
// the parameters on both curves, and the result's runs of points along one
// source curve are turned back into that curve's exact section. So a union of
// two circles is two arcs of the original cubics, not a polyline. (This replaces
// engine.md's planned paper.js port and its Clipper2 fallback "marked approximate".)
#pragma once

#include <vector>

#include "geometry/Path.h"
#include "scene/Node.h"

namespace eng::geom {

struct Operand {
  Path path;
  WindingRule rule = WindingRule::NONZERO;
};

// The boolean of the operands, bottom first, as Figma combines them: UNION all;
// SUBTRACT the rest from the first; INTERSECT all; XOR (Exclude) one after
// another. The result is closed contours for the NONZERO rule. `tolerance` is
// how finely curves are flattened for the clipping (local units).
Path booleanOp(const std::vector<Operand>& operands, BooleanOperation op, double tolerance);

// One path's area under its own rule, as clean contours for NONZERO (self-overlaps merged).
Path simplify(const Path& path, WindingRule rule, double tolerance);

}  // namespace eng::geom
