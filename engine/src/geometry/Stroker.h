// The stroker (docs/engine.md §5): a centre line → the outline of its stroke,
// as a path drawn with the NONZERO rule. The centre line is flattened (within
// a tolerance the caller picks for the zoom), dashed by arc length, and every
// segment, join and cap becomes its own positively wound piece, so overlaps
// union under NONZERO with no self-intersection handling to get wrong.
// strokeAlign INSIDE / OUTSIDE are not done here: the renderer strokes at twice
// the weight and keeps the part inside (outside) the fill (engine.md §6.4);
// Outline stroke does the same with booleans.
#pragma once

#include <utility>
#include <vector>

#include "geometry/Path.h"
#include "geometry/VariableWidth.h"
#include "scene/Node.h"

namespace eng::geom {

struct StrokeStyle {
  double width = 1;
  StrokeJoin join = StrokeJoin::MITER;
  double miterLimit = 4;
  StrokeCap cap = StrokeCap::NONE;  // both ends of open contours, unless `caps` says otherwise
  std::vector<double> dashes;       // dash, gap, dash, gap… (empty: solid)
  // Per contour of the centre line: its start and end caps (overrides `cap`).
  const std::vector<std::pair<StrokeCap, StrokeCap>>* caps = nullptr;
  // Figma's dashes on rectangles and frames (sections.fig's strokeGeometry): each straight side of a closed contour
  // gets the pattern scaled to fit it a whole number of times, half a dash at each end; curved corners are drawn
  // whole, joining the half dashes around them (a contour without a straight side: the pattern fitted to it all).
  bool fitDashes = false;
  // Round 12: a variable width (geometry/VariableWidth.h; sorted points, `width` the full weight): each contour's
  // width follows it from its start (0) to its end (1). Not with dashes (Figma: no width profile on a dashed stroke).
  const std::vector<WidthPoint>* profile = nullptr;
};

// The outline of `center` stroked with `style`; `tolerance` = how far flattened curves may stray (local units).
Path strokePath(const Path& center, const StrokeStyle& style, double tolerance);

// How far a stroke can reach past its centre line (for bounds): half the width
// grown for miters, square caps and arrowheads.
double strokeReach(const StrokeStyle& style, bool hasOpenEnds);

// The width points' place on a stroke: where along `center` (its contours as flattened by `tolerance`) a point at
// `position` of contour `contour` is, and the path's direction there (unit). False when the contour has no length.
bool pointAlong(const Path& center, size_t contour, double position, double tolerance, Vec2& at, Vec2& direction);
// The nearest place on `center` to `p`: its contour, position (0…1 along it), distance. False on an empty path.
bool nearestAlong(const Path& center, Vec2 p, double tolerance, size_t& contour, double& position, double& distance);

}  // namespace eng::geom
