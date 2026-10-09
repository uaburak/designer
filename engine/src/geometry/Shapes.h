// The shapes Figma's primitive nodes stand for, as paths in the node's space
// (docs/engine.md §5): rectangles with per-corner radii and corner smoothing
// (Figma's squircle), ellipses with arcs (pies and donuts), regular polygons,
// stars, lines. The renderer draws plain rectangles and ellipses with its SDF
// fast path; these are for everything else (smoothing, arcs, dashes, booleans,
// Flatten, hit-testing).
#pragma once

#include "geometry/Path.h"
#include "scene/Node.h"

namespace eng::geom {

// Figma's clamp: on every side whose two corner radii add up to more than the
// side, both shrink by the same factor (the smallest factor over the four sides wins).
CornerRadii clampRadii(Vec2 size, const CornerRadii& radii);

// Each corner's room for its rounding and smoothing (tl tr br bl), and `radii` kept within it (figma-squircle's
// per-edge budget: a corner next to a square one has the whole edge).
CornerRadii cornerBudgets(Vec2 size, CornerRadii& radii);
Path rectPath(Vec2 size, const CornerRadii& radii, double smoothing = 0);
Path ellipsePath(Vec2 size, const ArcData& arc);
// Regular polygon / star with `count` points on the ellipse the box holds (Figma: the top point at the top edge, the
// box not stretched to the points — a triangle leaves a quarter of its box empty), corners rounded by `cornerRadius`.
Path polygonPath(Vec2 size, uint32_t count, double cornerRadius);
Path starPath(Vec2 size, uint32_t count, double innerScale, double cornerRadius);
// Their corners (node space), clockwise from the top: a polygon's `count`, a star's 2 × `count` (outer, inner, …).
std::vector<Vec2> polygonPoints(Vec2 size, uint32_t count);
std::vector<Vec2> starPoints(Vec2 size, uint32_t count, double innerScale);
// LINE: from (0, 0) to (size.x, 0).
Path linePath(Vec2 size);
// A closed polygon with every corner rounded by `radius` (clamped to half of the shorter neighbouring edge).
Path roundedPolygon(const std::vector<Vec2>& points, double radius);

// A circular arc of radius `r` around `c` from angle a0 to a1 (radians, y down: clockwise from +x), as cubics
// appended to `path` (no moveTo; the path must be at the arc's start).
void arcTo(Path& path, Vec2 c, double rx, double ry, double a0, double a1);

}  // namespace eng::geom
