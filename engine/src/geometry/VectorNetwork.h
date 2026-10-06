// Figma's vector networks (docs/schema.md §11.3, docs/engine.md §5): vertices,
// segments (cubic Béziers by tangents relative to their ends) and regions
// (loops of segments with a winding rule), decoded from and encoded to the
// vectorNetworkBlob byte for byte. What a VECTOR node draws comes from here:
// the fill = its regions' loops; the stroke = every segment, chained through
// vertices where exactly two segments meet.
#pragma once

#include <cstdint>
#include <vector>

#include "geometry/Path.h"
#include "scene/Node.h"

namespace eng::geom {

struct VNVertex {
  Vec2 p;
  uint32_t styleID = 0;
};

struct VNSegment {
  uint32_t start = 0, end = 0;
  Vec2 tangentStart, tangentEnd;  // control points relative to their vertex
  uint32_t styleID = 0;
  bool isLine() const { return tangentStart.x == 0 && tangentStart.y == 0 && tangentEnd.x == 0 && tangentEnd.y == 0; }
};

struct VNRegion {
  uint32_t styleID = 0;
  WindingRule windingRule = WindingRule::NONZERO;
  std::vector<std::vector<uint32_t>> loops;  // segment indices, in order around each loop
};

// A chain of segments for stroking: `segments` in order, each walked forwards or backwards.
struct VNChain {
  std::vector<uint32_t> segments;
  std::vector<bool> reversed;
  uint32_t firstVertex = 0, lastVertex = 0;
  bool closed = false;
};

struct VectorNetwork {
  std::vector<VNVertex> vertices;
  std::vector<VNSegment> segments;
  std::vector<VNRegion> regions;

  // False on a truncated or inconsistent blob (indices out of range).
  static bool decode(const uint8_t* data, size_t size, VectorNetwork& out);
  std::vector<uint8_t> encode() const;
  bool empty() const { return vertices.empty(); }

  // The segment's curve from `from` to `to` (walked backwards when reversed): appended to `path` (no moveTo).
  void appendSegment(Path& path, uint32_t segment, bool reversed) const;
  // A region as closed contours (one per loop).
  Path regionPath(const VNRegion& region) const;
  // The chains every segment belongs to exactly once (stroking).
  std::vector<VNChain> chains() const;
  // A chain as one contour (closed when the chain is).
  Path chainPath(const VNChain& chain) const;
  // How many segments meet at each vertex.
  std::vector<uint32_t> degrees() const;
  // Every coordinate scaled (normalizedSize → size).
  void scale(double sx, double sy);
  // The bounds of the curves.
  Rect bounds() const;
};

// What a node draws as paths, in its own space: the fill regions (each with its
// winding rule and the styleID its fills come from) and the stroke's centre line
// (open and closed contours; per-end caps from the vertices' styles).
struct FillRegion {
  Path path;
  WindingRule windingRule = WindingRule::NONZERO;
  uint32_t styleID = 0;
};
struct StrokeCenter {
  Path path;
  // Per contour of `path`, in order: the caps at its start and end (open contours).
  std::vector<std::pair<StrokeCap, StrokeCap>> caps;
  // Per contour: the join at each vertex is the node's unless a vertex overrides it (kept simple: the node's).
};

// The fill regions of a VECTOR's network at the node's size (the network is in normalizedSize space).
// A network without regions fills its closed chains (and closes the open ones), as Figma does for pen paths.
std::vector<FillRegion> networkFills(const VectorNetwork& net, const VectorData& data, Vec2 size);
// The stroke centre line of a network at the node's size; `defaultCap` for open ends without their own style.
StrokeCenter networkStroke(const VectorNetwork& net, const VectorData& data, Vec2 size, StrokeCap defaultCap);

// Corner radius on a network (the node's cornerRadius, or a vertex's own style): every vertex joining two
// straight segments is cut back and joined by a circular arc, as Figma rounds vector corners.
VectorNetwork withRoundedCorners(const VectorNetwork& net, const VectorData& data, double nodeRadius);

// A network from a path (Flatten, Outline stroke, shapes entering vector edit): every
// contour becomes vertices and segments; closed contours become one region's loops.
VectorNetwork networkFromPath(const Path& path, WindingRule rule);

}  // namespace eng::geom
