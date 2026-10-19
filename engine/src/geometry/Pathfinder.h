// Illustrator's Pathfinders (round 19b [ours], docs/roadmap.md Round 19, docs/engine.md §5 "Pathfinder"): the six
// destructive operations Adobe Illustrator's Pathfinder panel has beside its shape modes (Figma's four live booleans
// are those shape modes). Illustrator's documented behaviour (helpx.adobe.com "Combine objects", Pathfinder effects):
// - Divide: the artwork split into its component faces (an area no line crosses); each face takes the paint of the
//   shape on top there; open paths cut too.
// - Trim: the hidden part of each filled shape removed, nothing merged; strokes removed.
// - Merge: Trim, then touching pieces of the same fill merged.
// - Crop: the top shape crops everything below (its faces outside it removed, hidden parts removed); the top shape
//   itself goes; strokes removed.
// - Outline: every shape's edges as open paths, split where they cross (stroked with the shape's fill colour by the
//   editor, fills removed).
// - Minus Back: the shapes behind subtracted from the front-most one.
// Pathfinder Options: precision (how finely curves are followed), Remove Redundant Points, "Divide and Outline will
// remove unpainted artwork".
//
// Built on the planar map of the shapes (PlanarFaces.h, the Shape builder's): every result is a union of its faces or
// a run of its edges, so neighbouring pieces share their boundaries curve for curve and keep the shapes' own curves.
#pragma once

#include <cstdint>
#include <vector>

#include "geometry/Path.h"
#include "scene/Node.h"

namespace eng::geom {

enum class PathfinderOp : uint8_t { DIVIDE, TRIM, MERGE, CROP, OUTLINE, MINUS_BACK };

struct PathfinderInput {
  Path path;                               // its fill area's contours (an open path only: a line, which cuts)
  WindingRule rule = WindingRule::NONZERO;
  bool filled = false;                     // has a visible fill ("painted")
  uint64_t fillKey = 0;                    // Merge: the same fill, the same key
};

struct PathfinderOptions {
  double precision = 0.028;                // Illustrator's default (pt; here local units)
  bool removeRedundantPoints = true;
  bool removeUnpainted = false;            // Divide and Outline drop unfilled shapes first
};

struct PathfinderPiece {
  Path path;
  uint32_t source = 0;                     // the input whose paint it takes
  bool open = false;                       // Outline's edges
};

// The inputs bottom first (paint order); the pieces in the order they paint (bottom first).
std::vector<PathfinderPiece> pathfinder(const std::vector<PathfinderInput>& inputs, PathfinderOp op, const PathfinderOptions& options);

// Illustrator's names (Divide, Trim, Merge, Crop, Outline, Minus Back).
const char* pathfinderName(PathfinderOp op);

}  // namespace eng::geom
