// Paths (docs/engine.md §5): MOVE / LINE / QUAD / CUBIC / CLOSE verbs over
// double points in a node's local space, plus what the renderer, the stroker,
// hit-testing and booleans need from them: Figma's commandsBlob encoding
// (docs/schema.md §11.3), bounds, flattening to polylines, and quadratic
// curves for the GPU (cubics approximated within a tolerance).
#pragma once

#include <cstdint>
#include <vector>

#include "math/Math.h"

namespace eng::geom {

enum class Verb : uint8_t { Move = 0, Line = 1, Quad = 2, Cubic = 3, Close = 4 };

struct Path {
  std::vector<Verb> verbs;
  std::vector<Vec2> points;  // Move/Line: 1, Quad: 2, Cubic: 3, Close: 0

  void moveTo(Vec2 p);
  void lineTo(Vec2 p);
  void quadTo(Vec2 c, Vec2 p);
  void cubicTo(Vec2 c1, Vec2 c2, Vec2 p);
  void close();
  bool empty() const { return verbs.empty(); }
  void clear() {
    verbs.clear();
    points.clear();
  }
  void append(const Path& o);
  // Every point mapped by `m`.
  void transform(const Mat2x3& m);
  Path transformed(const Mat2x3& m) const {
    Path p = *this;
    p.transform(m);
    return p;
  }
  // The bounds of the curves themselves (extrema, not control points); empty paths: {0,0,0,0}.
  Rect bounds() const;
  // Each contour reversed (the same shape, the other winding direction).
  Path reversed() const;
  // A content hash (geometry caches).
  uint64_t hash() const;

  // Figma's commandsBlob: u8 opcode (0 Z, 1 M, 2 L, 3 Q, 4 C) then f32 LE coordinates.
  static Path fromCommands(const uint8_t* data, size_t size);
  std::vector<uint8_t> toCommands() const;

  bool operator==(const Path& o) const { return verbs == o.verbs && points == o.points; }
};

// Calls f(verb, from, pts) for every drawing segment (Line, Quad, Cubic and the
// implicit lines that Close adds), with `from` the current point and `pts` the
// segment's own points (1, 2 or 3). Contour starts get onMove(p); open contours
// end with onEnd(closed=false), closed ones with onEnd(true).
template <typename OnMove, typename OnSeg, typename OnEnd>
void forEachSegment(const Path& path, OnMove&& onMove, OnSeg&& onSeg, OnEnd&& onEnd) {
  size_t pi = 0;
  Vec2 start, cur;
  bool open = false;
  for (Verb v : path.verbs) {
    switch (v) {
      case Verb::Move:
        if (open) onEnd(false);
        start = cur = path.points[pi++];
        open = true;
        onMove(start);
        break;
      case Verb::Line: {
        const Vec2* p = &path.points[pi];
        onSeg(Verb::Line, cur, p);
        cur = p[0];
        pi += 1;
        break;
      }
      case Verb::Quad: {
        const Vec2* p = &path.points[pi];
        onSeg(Verb::Quad, cur, p);
        cur = p[1];
        pi += 2;
        break;
      }
      case Verb::Cubic: {
        const Vec2* p = &path.points[pi];
        onSeg(Verb::Cubic, cur, p);
        cur = p[2];
        pi += 3;
        break;
      }
      case Verb::Close:
        if (open) {
          if (!(cur == start)) onSeg(Verb::Line, cur, &start);
          onEnd(true);
          open = false;
          cur = start;
        }
        break;
    }
  }
  if (open) onEnd(false);
}

// A flattened contour.
struct Polyline {
  std::vector<Vec2> points;
  bool closed = false;
};

// The path as polylines, each curve split until it is within `tolerance` of its chord.
std::vector<Polyline> flatten(const Path& path, double tolerance);
// Points along one curve (excluding `from`, including its end), within `tolerance`.
void flattenQuad(Vec2 p0, Vec2 p1, Vec2 p2, double tolerance, std::vector<Vec2>& out);
void flattenCubic(Vec2 p0, Vec2 p1, Vec2 p2, Vec2 p3, double tolerance, std::vector<Vec2>& out);

// The path as quadratic curves for the GPU's coverage shader: 6 floats each
// (p0, control, p2); lines are curves with the control on their start;
// cubics are split into quadratics within `tolerance`. Every contour is closed
// (fills): an open one gets its closing line.
void toQuads(const Path& path, double tolerance, std::vector<float>& out);

// Winding number at `p` of the closed polylines (open ones are closed implicitly).
int windingAt(const std::vector<Polyline>& polys, Vec2 p);
// Whether `p` is inside under the fill rule (evenOdd: ODD, else NONZERO).
bool contains(const std::vector<Polyline>& polys, Vec2 p, bool evenOdd);
// The distance from `p` to the polylines' edges.
double distanceTo(const std::vector<Polyline>& polys, Vec2 p);

// Cubic Bézier evaluation and splitting.
Vec2 cubicAt(Vec2 p0, Vec2 p1, Vec2 p2, Vec2 p3, double t);
Vec2 quadAt(Vec2 p0, Vec2 p1, Vec2 p2, double t);
// The part [t0, t1] of a cubic (4 points out).
void cubicSection(const Vec2 in[4], double t0, double t1, Vec2 out[4]);

}  // namespace eng::geom
