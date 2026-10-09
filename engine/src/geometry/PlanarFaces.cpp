#include "geometry/PlanarFaces.h"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <unordered_map>

namespace eng::geom {

namespace {

double cross(Vec2 a, Vec2 b) { return a.x * b.y - a.y * b.x; }
double dot(Vec2 a, Vec2 b) { return a.x * b.x + a.y * b.y; }

// A source curve: a cubic (quads elevated; a line has `line` set).
struct Curve {
  Vec2 p[4];
  bool line = false;
};

// A flattened edge of one curve, between registered vertices, with the curve's parameters at its ends; `splits`:
// where other edges cross it (parameter along the edge, vertex).
struct Edge {
  uint32_t a = 0, b = 0;
  uint32_t curve = 0;
  double ta = 0, tb = 0;
  std::vector<std::pair<double, uint32_t>> splits;
};

// Vertices merged within `eps` (a hash grid of eps-sized cells).
class Vertices {
 public:
  explicit Vertices(double eps) : eps_(eps) {}
  uint32_t get(Vec2 p) {
    int64_t cx = static_cast<int64_t>(std::floor(p.x / eps_)), cy = static_cast<int64_t>(std::floor(p.y / eps_));
    for (int64_t dx = -1; dx <= 1; dx++)
      for (int64_t dy = -1; dy <= 1; dy++) {
        auto it = grid_.find(key(cx + dx, cy + dy));
        if (it == grid_.end()) continue;
        for (uint32_t id : it->second)
          if ((pts[id] - p).length() <= eps_) return id;
      }
    uint32_t id = static_cast<uint32_t>(pts.size());
    pts.push_back(p);
    grid_[key(cx, cy)].push_back(id);
    return id;
  }
  std::vector<Vec2> pts;

 private:
  static uint64_t key(int64_t x, int64_t y) { return static_cast<uint64_t>(x) * 0x9E3779B97F4A7C15ull ^ static_cast<uint64_t>(y) * 0xC2B2AE3D27D4EB4Full; }
  double eps_;
  std::unordered_map<uint64_t, std::vector<uint32_t>> grid_;
};

struct UnionFind {
  std::vector<uint32_t> parent;
  explicit UnionFind(size_t n) : parent(n) { std::iota(parent.begin(), parent.end(), 0u); }
  uint32_t find(uint32_t x) {
    while (parent[x] != x) x = parent[x] = parent[parent[x]];
    return x;
  }
  void unite(uint32_t a, uint32_t b) { parent[find(a)] = find(b); }
};

bool insideRing(const std::vector<Vec2>& ring, Vec2 p) {
  bool in = false;
  size_t n = ring.size();
  for (size_t i = 0, j = n - 1; i < n; j = i++) {
    const Vec2 &a = ring[i], &b = ring[j];
    if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) in = !in;
  }
  return in;
}

double ringArea(const std::vector<Vec2>& ring) {
  double a = 0;
  for (size_t i = 0; i < ring.size(); i++) a += cross(ring[i], ring[(i + 1) % ring.size()]);
  return a / 2;
}

double distanceToRings(const std::vector<std::vector<Vec2>>& rings, Vec2 p) {
  double best = 1e300;
  for (const auto& r : rings)
    for (size_t i = 0; i < r.size(); i++) {
      Vec2 a = r[i], ab = r[(i + 1) % r.size()] - a;
      double len2 = dot(ab, ab);
      double t = len2 > 0 ? std::clamp(dot(p - a, ab) / len2, 0.0, 1.0) : 0;
      best = std::min(best, (p - (a + ab * t)).length());
    }
  return best;
}

}  // namespace

bool PlanarFace::contains(Vec2 p) const {
  if (rings.empty() || !insideRing(rings[0], p)) return false;
  for (size_t i = 1; i < rings.size(); i++)
    if (insideRing(rings[i], p)) return false;
  return true;
}

std::vector<PlanarFace> planarFaces(const std::vector<FaceInput>& inputs, double tolerance, size_t maxEdges) {
  const double tol = std::max(tolerance, 1e-6);
  // Merge radius: far below anything drawn, above the round-off of the crossings.
  Rect all;
  bool any = false;
  for (const FaceInput& in : inputs)
    if (!in.path.empty()) all = any ? all.united(in.path.bounds()) : in.path.bounds(), any = true;
  if (!any) return {};
  const double eps = std::max(1e-7, std::max(all.w, all.h) * 1e-9);

  std::vector<Curve> curves;
  std::vector<Edge> edges;
  std::vector<std::vector<Polyline>> polys(inputs.size());
  Vertices verts(eps);
  // 1. Every input's contours, closed, flattened per curve (each point remembers its curve and parameter).
  for (size_t ii = 0; ii < inputs.size(); ii++) {
    Vec2 start, cur;
    bool open = false;
    auto addCurve = [&](const Curve& c) {
      uint32_t id = static_cast<uint32_t>(curves.size());
      curves.push_back(c);
      int steps = 1;
      if (!c.line) {
        double m = std::max((c.p[0] - c.p[1] * 2 + c.p[2]).length(), (c.p[1] - c.p[2] * 2 + c.p[3]).length());
        steps = std::clamp(static_cast<int>(std::ceil(std::sqrt(0.75 * m / tol))), 1, 4096);
      }
      Vec2 prev = c.p[0];
      uint32_t pv = verts.get(prev);
      double pt = 0;
      for (int k = 1; k <= steps; k++) {
        double t = static_cast<double>(k) / steps;
        Vec2 q = k == steps ? c.p[3] : cubicAt(c.p[0], c.p[1], c.p[2], c.p[3], t);
        polys[ii].back().points.push_back(q);
        uint32_t qv = verts.get(q);
        if (qv != pv) {
          Edge e;
          e.a = pv, e.b = qv, e.curve = id, e.ta = pt, e.tb = t;
          edges.push_back(std::move(e));
          pv = qv, pt = t;
        } else {
          pt = t;  // (a step shorter than eps: the edge goes on from the merged point)
        }
        prev = q;
      }
    };
    auto lineCurve = [](Vec2 a, Vec2 b) {
      Curve c;
      c.p[0] = c.p[1] = a;
      c.p[2] = c.p[3] = b;
      c.line = true;
      return c;
    };
    forEachSegment(
        inputs[ii].path,
        [&](Vec2 p) {
          start = cur = p;
          open = true;
          polys[ii].push_back(Polyline{{p}, true});
        },
        [&](Verb v, Vec2 from, const Vec2* p) {
          Curve c;
          if (v == Verb::Line) {
            c = lineCurve(from, p[0]);
          } else if (v == Verb::Quad) {
            c.p[0] = from;
            c.p[1] = from + (p[0] - from) * (2.0 / 3);
            c.p[2] = p[1] + (p[0] - p[1]) * (2.0 / 3);
            c.p[3] = p[1];
          } else {
            c.p[0] = from, c.p[1] = p[0], c.p[2] = p[1], c.p[3] = p[2];
          }
          addCurve(c);
          cur = c.p[3];
        },
        [&](bool closed) {
          if (!closed && open && !(cur == start)) addCurve(lineCurve(cur, start));
          open = false;
          if (!polys[ii].empty() && polys[ii].back().points.size() > 1 && polys[ii].back().points.back() == polys[ii].back().points.front())
            polys[ii].back().points.pop_back();
        });
    if (edges.size() > maxEdges) return {};
  }
  const std::vector<Vec2>& P = verts.pts;

  // 2. Crossings (a sweep along x): each crossing is one vertex, split into both edges.
  std::vector<uint32_t> order(edges.size());
  std::iota(order.begin(), order.end(), 0u);
  auto minX = [&](const Edge& e) { return std::min(P[e.a].x, P[e.b].x); };
  std::sort(order.begin(), order.end(), [&](uint32_t i, uint32_t j) { return minX(edges[i]) < minX(edges[j]); });
  auto split = [&](Edge& e, double t, uint32_t v) {
    if (v == e.a || v == e.b) return;
    e.splits.push_back({t, v});
  };
  for (size_t oi = 0; oi < order.size(); oi++) {
    Edge& ei = edges[order[oi]];
    Vec2 a = P[ei.a], b = P[ei.b], r = b - a;
    double maxX = std::max(a.x, b.x) + eps, loY = std::min(a.y, b.y) - eps, hiY = std::max(a.y, b.y) + eps;
    double rl = r.length();
    for (size_t oj = oi + 1; oj < order.size(); oj++) {
      Edge& ej = edges[order[oj]];
      if (minX(ej) > maxX) break;
      Vec2 c = P[ej.a], d = P[ej.b];
      if (std::max(c.y, d.y) < loY || std::min(c.y, d.y) > hiY) continue;
      if (ei.a == ej.a && ei.b == ej.b) continue;
      if (ei.a == ej.b && ei.b == ej.a) continue;
      Vec2 s = d - c;
      double sl = s.length();
      if (rl <= 0 || sl <= 0) continue;
      double denom = cross(r, s);
      if (std::fabs(denom) > 1e-12 * rl * sl) {
        double t = cross(c - a, s) / denom, u = cross(c - a, r) / denom;
        double et = eps / rl, eu = eps / sl;
        if (t < -et || t > 1 + et || u < -eu || u > 1 + eu) continue;
        // Shared endpoints need nothing.
        bool iEnd = t <= et || t >= 1 - et, jEnd = u <= eu || u >= 1 - eu;
        if (iEnd && jEnd) continue;
        Vec2 x = iEnd ? (t <= et ? a : b) : jEnd ? (u <= eu ? c : d) : a + r * std::clamp(t, 0.0, 1.0);
        uint32_t v = iEnd ? (t <= et ? ei.a : ei.b) : jEnd ? (u <= eu ? ej.a : ej.b) : verts.get(x);
        if (!iEnd) split(ei, std::clamp(t, 0.0, 1.0), v);
        if (!jEnd) split(ej, std::clamp(u, 0.0, 1.0), v);
      } else if (std::fabs(cross(c - a, r)) <= eps * rl) {
        // Collinear: each one's ends that fall inside the other split it.
        for (uint32_t q : {ej.a, ej.b}) {
          double t = dot(P[q] - a, r) / (rl * rl);
          if (t > eps / rl && t < 1 - eps / rl) split(ei, t, q);
        }
        for (uint32_t q : {ei.a, ei.b}) {
          double u = dot(P[q] - c, s) / (sl * sl);
          if (u > eps / sl && u < 1 - eps / sl) split(ej, u, q);
        }
      }
    }
  }

  // 3. The planar graph: edges split at their crossings, each pair of vertices joined once.
  struct GEdge {
    uint32_t u, v, curve;
    double tu, tv;
  };
  std::vector<GEdge> graph;
  std::unordered_map<uint64_t, uint32_t> seen;
  for (Edge& e : edges) {
    std::sort(e.splits.begin(), e.splits.end());
    uint32_t from = e.a;
    double fromT = 0;
    auto add = [&](uint32_t to, double toT) {
      if (to == from) return;
      uint64_t k = (static_cast<uint64_t>(std::min(from, to)) << 32) | std::max(from, to);
      if (!seen.count(k)) {
        seen[k] = static_cast<uint32_t>(graph.size());
        graph.push_back({from, to, e.curve, e.ta + (e.tb - e.ta) * fromT, e.ta + (e.tb - e.ta) * toT});
      }
      from = to;
      fromT = toT;
    };
    for (auto& [t, v] : e.splits) add(v, t);
    add(e.b, 1);
  }
  if (graph.empty()) return {};

  // 4. Faces: half-edges h = 2e (u → v) and 2e + 1 (v → u); around each vertex by angle; a face's next half-edge
  // is the one before the arriving half-edge's twin (bounded faces then wind positively, the outside negatively).
  size_t H = graph.size() * 2;
  auto origin = [&](size_t h) { return h & 1 ? graph[h >> 1].v : graph[h >> 1].u; };
  auto target = [&](size_t h) { return h & 1 ? graph[h >> 1].u : graph[h >> 1].v; };
  std::vector<std::vector<uint32_t>> around(P.size());
  for (size_t h = 0; h < H; h++) around[origin(h)].push_back(static_cast<uint32_t>(h));
  std::vector<uint32_t> slot(H, 0);
  for (auto& list : around) {
    if (list.empty()) continue;
    uint32_t o = origin(list[0]);
    std::vector<double> angle(list.size());
    std::vector<size_t> idx(list.size());
    std::iota(idx.begin(), idx.end(), 0);
    for (size_t i = 0; i < list.size(); i++) {
      Vec2 d = P[target(list[i])] - P[o];
      angle[i] = std::atan2(d.y, d.x);
    }
    std::sort(idx.begin(), idx.end(), [&](size_t a, size_t b) { return angle[a] < angle[b]; });
    std::vector<uint32_t> sorted;
    for (size_t i : idx) sorted.push_back(list[i]);
    list = std::move(sorted);
    for (size_t i = 0; i < list.size(); i++) slot[list[i]] = static_cast<uint32_t>(i);
  }
  auto next = [&](size_t h) -> size_t {
    size_t twin = h ^ 1;
    const auto& list = around[origin(twin)];
    return list[(slot[twin] + list.size() - 1) % list.size()];
  };
  UnionFind uf(P.size());
  for (const GEdge& g : graph) uf.unite(g.u, g.v);
  std::vector<bool> done(H, false);
  struct Cycle {
    std::vector<uint32_t> half;
    std::vector<Vec2> ring;
    double area = 0;
    uint32_t component = 0;
  };
  std::vector<Cycle> cycles;
  for (size_t h0 = 0; h0 < H; h0++) {
    if (done[h0]) continue;
    Cycle c;
    size_t h = h0;
    for (size_t guard = 0; guard <= H && !done[h]; guard++) {
      done[h] = true;
      c.half.push_back(static_cast<uint32_t>(h));
      c.ring.push_back(P[origin(h)]);
      h = next(h);
    }
    c.area = ringArea(c.ring);
    c.component = uf.find(origin(h0));
    cycles.push_back(std::move(c));
  }
  const double minArea = eps * eps * 4;
  std::vector<size_t> bounded;
  for (size_t i = 0; i < cycles.size(); i++)
    if (cycles[i].area > minArea) bounded.push_back(i);
  // Holes: each component's outside lies in the smallest face of another component around it (if any).
  std::vector<std::vector<size_t>> holes(cycles.size());
  for (size_t i = 0; i < cycles.size(); i++) {
    if (cycles[i].area >= -minArea) continue;
    Vec2 q = cycles[i].ring[0];
    size_t best = SIZE_MAX;
    for (size_t f : bounded) {
      if (cycles[f].component == cycles[i].component) continue;
      if (best != SIZE_MAX && cycles[f].area >= cycles[best].area) continue;
      if (insideRing(cycles[f].ring, q)) best = f;
    }
    if (best != SIZE_MAX) holes[best].push_back(i);
  }

  // 5. Each bounded face: its covers (a point inside, tested against every input), its curves.
  auto ringPath = [&](Path& out, const Cycle& c) {
    size_t n = c.half.size();
    if (n < 2) return;
    auto param = [&](size_t i, double& t0, double& t1) {
      const GEdge& g = graph[c.half[i] >> 1];
      bool rev = c.half[i] & 1;
      t0 = rev ? g.tv : g.tu;
      t1 = rev ? g.tu : g.tv;
      return g.curve;
    };
    out.moveTo(P[origin(c.half[0])]);
    size_t i = 0;
    while (i < n) {
      double t0, t1;
      uint32_t cv = param(i, t0, t1);
      if (curves[cv].line) {
        out.lineTo(P[target(c.half[i])]);
        i++;
        continue;
      }
      size_t j = i + 1;
      while (j < n) {
        double a, b;
        if (param(j, a, b) != cv || std::fabs(a - t1) > 1e-9 || (t1 - t0) * (b - a) <= 0) break;
        t1 = b;
        j++;
      }
      Vec2 s[4];
      cubicSection(curves[cv].p, t0, t1, s);
      out.cubicTo(s[1], s[2], P[target(c.half[j - 1])]);
      i = j;
    }
    out.close();
  };
  std::vector<PlanarFace> faces;
  for (size_t f : bounded) {
    PlanarFace face;
    face.rings.push_back(cycles[f].ring);
    face.area = cycles[f].area;
    for (size_t h : holes[f]) {
      face.rings.push_back(cycles[h].ring);
      face.area += cycles[h].area;  // negative
    }
    if (face.area <= minArea) continue;
    // A point inside, as far from the boundary as a few tries find (the covers are the same all over the face).
    const auto& ring = cycles[f].ring;
    std::vector<size_t> byLength(ring.size());
    std::iota(byLength.begin(), byLength.end(), 0);
    auto len = [&](size_t i) { return (ring[(i + 1) % ring.size()] - ring[i]).length(); };
    std::partial_sort(byLength.begin(), byLength.begin() + std::min<size_t>(12, byLength.size()), byLength.end(),
                      [&](size_t a, size_t b) { return len(a) > len(b); });
    Rect fb;
    for (size_t k = 0; k < ring.size(); k++) fb = k ? fb.united(Rect{ring[k].x, ring[k].y, 0, 0}) : Rect{ring[k].x, ring[k].y, 0, 0};
    double span = std::max(eps, std::min(fb.w, fb.h));
    double bestD = -1;
    for (size_t k = 0; k < std::min<size_t>(12, byLength.size()); k++) {
      size_t i = byLength[k];
      Vec2 a = ring[i], b = ring[(i + 1) % ring.size()], d = b - a;
      double l = d.length();
      if (l <= 0) continue;
      Vec2 n{-d.y / l, d.x / l};  // the face's side (positive winding)
      for (double delta : {span * 0.25, span * 0.05, span * 0.005, eps * 8}) {
        Vec2 p = a + d * 0.5 + n * delta;
        if (!face.contains(p)) continue;
        double dist = distanceToRings(face.rings, p);
        if (dist > bestD) bestD = dist, face.sample = p;
        break;
      }
    }
    if (bestD < 0) continue;
    for (size_t ii = 0; ii < inputs.size(); ii++)
      if (contains(polys[ii], face.sample, inputs[ii].rule == WindingRule::ODD)) face.covers.push_back(static_cast<uint32_t>(ii));
    if (face.covers.empty()) continue;
    ringPath(face.path, cycles[f]);
    for (size_t h : holes[f]) ringPath(face.path, cycles[h]);
    faces.push_back(std::move(face));
  }
  return faces;
}

}  // namespace eng::geom
