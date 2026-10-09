// The planar faces of overlapping shapes (round 12, the Shape builder; help.figma.com "Create custom shapes with the
// shape builder tool": "hover over the individual regions of the selected layers"). Every shape's outline (its fill
// contours, open ones closed) is flattened, the polylines are split where they cross themselves or each other, and
// the resulting planar graph's bounded faces are traced (holes: what lies inside a face without touching it). Each
// face knows which inputs cover it (inside under their own winding rule) and comes back as exact curves: runs of the
// flattened boundary along one input curve become that curve's section (as the booleans do, Boolean.h), so adjacent
// faces share their boundaries exactly and a union of faces is the shapes' own curves again.
#pragma once

#include <cstdint>
#include <vector>

#include "geometry/Path.h"
#include "scene/Node.h"

namespace eng::geom {

struct FaceInput {
  Path path;  // closed contours (open ones are closed)
  WindingRule rule = WindingRule::NONZERO;
};

struct PlanarFace {
  Path path;                                 // the outer contour then its holes (NONZERO: holes wound the other way)
  std::vector<std::vector<Vec2>> rings;      // the same flattened: outer ring first (hit-testing, the overlay)
  std::vector<uint32_t> covers;              // the inputs inside which the face lies (ascending)
  Vec2 sample;                               // a point inside the face
  double area = 0;                           // of the outer ring minus the holes
  bool contains(Vec2 p) const;               // inside the outer ring and outside the holes
};

// The arrangement: its faces, and what unions of them are drawn from (the planar graph, kept).
struct PlanarMap {
  std::vector<PlanarFace> faces;
  // The union of faces (indices into `faces`) as exact contours — the edges between them and the rest, so a union
  // and the union of the other faces share their boundary curve for curve (no slivers, unlike clipping them apart).
  Path unionOf(const std::vector<int>& which) const;

  // The graph: half-edges 2e (u → v) and 2e + 1 (v → u) of each edge, the curve each lies on (its parameters at u and
  // v), each half-edge's next one around its face and the face on its left (−1: outside every input).
  struct Curve {
    Vec2 p[4];
    bool line = false;
  };
  struct Edge {
    uint32_t u = 0, v = 0, curve = 0;
    double tu = 0, tv = 0;
  };
  std::vector<Vec2> points;
  std::vector<Curve> curves;
  std::vector<Edge> edges;
  std::vector<uint32_t> nextHalf;
  std::vector<int> faceOfHalf;
  // The contour through these half-edges (in order), runs along one curve turned back into its sections.
  void appendRing(Path& out, const std::vector<uint32_t>& halves) const;
};

// The bounded faces of the inputs' arrangement that lie inside at least one input. `tolerance`: how finely curves are
// flattened (input units); `maxEdges` bounds the work (more flattened edges: no faces).
PlanarMap planarMap(const std::vector<FaceInput>& inputs, double tolerance, size_t maxEdges = 40000);
inline std::vector<PlanarFace> planarFaces(const std::vector<FaceInput>& inputs, double tolerance, size_t maxEdges = 40000) {
  return planarMap(inputs, tolerance, maxEdges).faces;
}

}  // namespace eng::geom
