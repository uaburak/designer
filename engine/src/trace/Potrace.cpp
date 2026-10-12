// Potrace's method from Selinger's paper (see Potrace.h). Coordinates: x right, y down, on the pixel-corner lattice
// (pixel (x, y) is the square [x, x+1] × [y, y+1]).

#include "trace/Potrace.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <limits>

namespace eng::trace {

namespace {

double cross(Vec2 a, Vec2 b) { return a.x * b.y - a.y * b.x; }
double dot(Vec2 a, Vec2 b) { return a.x * b.x + a.y * b.y; }
Vec2 mid(Vec2 a, Vec2 b) { return {(a.x + b.x) / 2, (a.y + b.y) / 2}; }
Vec2 lerp(Vec2 a, Vec2 b, double t) { return {a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t}; }

// ---- 1. Path decomposition ---------------------------------------------------------------------------------

// Whether set pixels are the majority around lattice point p (squares of growing radius; 0 when they tie throughout).
int majority(const Mask& m, IPt p) {
  for (int r = 2; r <= 4; r++) {
    int ct = 0;
    for (int y = p.y - r; y < p.y + r; y++)
      for (int x = p.x - r; x < p.x + r; x++) ct += m.get(x, y) ? 1 : -1;
    if (ct > 0) return 1;
    if (ct < 0) return -1;
  }
  return 0;
}

}  // namespace

std::vector<Contour> decompose(const Mask& m) {
  std::vector<Contour> out;
  const int w = m.w, h = m.h;
  if (w <= 0 || h <= 0) return out;
  // Walked edges: horizontal (x, y)–(x+1, y) at y·w + x, vertical (x, y)–(x, y+1) at y·(w+1) + x.
  std::vector<uint8_t> walkedH(static_cast<size_t>(w) * (h + 1), 0), walkedV(static_cast<size_t>(w + 1) * h, 0);
  auto walked = [&](IPt p, int dx, int dy) -> uint8_t& {
    if (dy == 0) return walkedH[static_cast<size_t>(p.y) * w + std::min(p.x, p.x + dx)];
    return walkedV[static_cast<size_t>(std::min(p.y, p.y + dy)) * (w + 1) + p.x];
  };
  for (int y = 0; y <= h; y++)
    for (int x = 0; x < w; x++) {
      bool above = m.get(x, y - 1), below = m.get(x, y);
      if (above == below || walkedH[static_cast<size_t>(y) * w + x]) continue;
      // Set pixels on the right: east along the top of a set pixel, west along the bottom of one.
      IPt p = below ? IPt{x, y} : IPt{x + 1, y};
      int dx = below ? 1 : -1, dy = 0;
      Contour c;
      for (;;) {
        walked(p, dx, dy) = 1;
        c.points.push_back(p);
        p = {p.x + dx, p.y + dy};
        // The two pixels ahead: left of the way on (d + L) and right of it (d − L), L = (dy, −dx) the left normal.
        int lx = dx + dy, ly = dy - dx, rx = dx - dy, ry = dy + dx;
        bool left = m.get(p.x + (lx > 0 ? 0 : -1), p.y + (ly > 0 ? 0 : -1));
        bool right = m.get(p.x + (rx > 0 ? 0 : -1), p.y + (ry > 0 ? 0 : -1));
        // Both set: turn left; both unset: turn right; only the right one: straight on; only the left one (a
        // diagonal): join the set pixels (left) when they are the minority around p, else keep them apart (right).
        int ndx = dx, ndy = dy;
        if (!(right && !left)) {
          bool turnLeft = left && right ? true : !left && !right ? false : majority(m, p) < 0;
          ndx = turnLeft ? dy : -dy;
          ndy = turnLeft ? -dx : dx;
        }
        if (walked(p, ndx, ndy)) break;
        dx = ndx;
        dy = ndy;
      }
      int64_t a2 = 0;
      const size_t n = c.points.size();
      for (size_t i = 0; i < n; i++) {
        const IPt &a = c.points[i], &b = c.points[(i + 1) % n];
        a2 += static_cast<int64_t>(a.x) * b.y - static_cast<int64_t>(b.x) * a.y;
      }
      c.area = a2 / 2;
      out.push_back(std::move(c));
    }
  return out;
}

namespace {

// ---- 2.–5. One contour ---------------------------------------------------------------------------------------

struct Sums {
  double x = 0, y = 0, xx = 0, xy = 0, yy = 0;
};

class ContourTracer {
 public:
  ContourTracer(const Contour& c, const TraceParams& params) : pts_(c.points), n_(static_cast<int>(c.points.size())), params_(params) {}

  // The curve, in lattice coordinates, appended to `out` through `toOut`. False when it is too small to trace.
  bool run(const Mat2x3& toOut, geom::Path& out, Limits& limits);

 private:
  const std::vector<IPt>& pts_;
  const int n_;
  const TraceParams& params_;
  IPt origin_;
  std::vector<int> lon_;  // per point: the furthest index (absolute, ≥ i) that i..lon is straight to
  std::vector<Sums> sums_;  // prefix sums over 2n + 1 points, relative to origin_

  Vec2 at(int64_t i) const {
    const IPt& p = pts_[static_cast<size_t>(((i % n_) + n_) % n_)];
    return {static_cast<double>(p.x - origin_.x), static_cast<double>(p.y - origin_.y)};
  }
  void straightness();
  void prefixSums();
  int maxEnd(int64_t i) const;  // the furthest j that (i, j) is a possible segment to
  double penalty(int64_t i, int64_t j) const;
  bool bestPolygon(int start, int maxStep, std::vector<int64_t>& vertices, int& count, double& pen) const;
  std::vector<int64_t> optimalPolygon() const;
  std::vector<Vec2> adjust(const std::vector<int64_t>& poly) const;
};

void ContourTracer::straightness() {
  lon_.assign(static_cast<size_t>(n_), 0);
  for (int i = 0; i < n_; i++) {
    unsigned dirs = 0;
    bool cone = false;
    int64_t c0x = 0, c0y = 0, c1x = 0, c1y = 0;  // the cone of directions (doubled coordinates): cw and ccw bounds
    const IPt& s = pts_[static_cast<size_t>(i)];
    int k = i;
    for (;;) {
      if (k - i >= n_ - 1) break;
      const IPt& a = pts_[static_cast<size_t>(k % n_)];
      const IPt& b = pts_[static_cast<size_t>((k + 1) % n_)];
      int dx = b.x - a.x, dy = b.y - a.y;
      dirs |= 1u << ((dx > 0 ? 0 : dx < 0 ? 2 : dy > 0 ? 1 : 3));
      if (dirs == 15u) break;  // all four directions: not straight
      int64_t cx = 2 * static_cast<int64_t>(b.x - s.x), cy = 2 * static_cast<int64_t>(b.y - s.y);
      if (cone && (c0x * cy - c0y * cx < 0 || cx * c1y - cy * c1x < 0)) break;  // outside the cone
      if (std::abs(cx) > 2 || std::abs(cy) > 2) {
        // The cone of rays passing within ½ (L∞) of the point: its square's extreme corners.
        int64_t qx[4] = {cx - 1, cx + 1, cx + 1, cx - 1}, qy[4] = {cy - 1, cy - 1, cy + 1, cy + 1};
        int lo = 0, hi = 0;
        for (int q = 1; q < 4; q++) {
          if (qx[lo] * qy[q] - qy[lo] * qx[q] < 0) lo = q;
          if (qx[hi] * qy[q] - qy[hi] * qx[q] > 0) hi = q;
        }
        if (!cone) {
          c0x = qx[lo], c0y = qy[lo], c1x = qx[hi], c1y = qy[hi];
          cone = true;
        } else {
          if (c0x * qy[lo] - c0y * qx[lo] > 0) c0x = qx[lo], c0y = qy[lo];
          if (c1x * qy[hi] - c1y * qx[hi] < 0) c1x = qx[hi], c1y = qy[hi];
        }
      }
      k++;
    }
    lon_[static_cast<size_t>(i)] = k;
  }
}

void ContourTracer::prefixSums() {
  sums_.assign(static_cast<size_t>(2 * n_ + 1), Sums{});
  for (int k = 0; k < 2 * n_; k++) {
    Vec2 p = at(k);
    Sums s = sums_[static_cast<size_t>(k)];
    s.x += p.x;
    s.y += p.y;
    s.xx += p.x * p.x;
    s.xy += p.x * p.y;
    s.yy += p.y * p.y;
    sums_[static_cast<size_t>(k + 1)] = s;
  }
}

int ContourTracer::maxEnd(int64_t i) const {
  // (i, j) is possible when the subpath i … j is straight and j − i ≤ n − 3.
  int64_t r = ((i % n_) + n_) % n_;
  int64_t lon = lon_[static_cast<size_t>(r)] + (i - r);
  return static_cast<int>(std::min<int64_t>(std::max<int64_t>(lon, i + 1), i + n_ - 3));
}

double ContourTracer::penalty(int64_t i, int64_t j) const {
  // |vj − vi| times the standard deviation of the points' distances from the line vi vj.
  int64_t off = (i / n_) * n_;
  int64_t a = i - off, b = j - off;  // a in [0, n), b < a + n ≤ 2n
  const Sums &s0 = sums_[static_cast<size_t>(a)], &s1 = sums_[static_cast<size_t>(b + 1)];
  double m = static_cast<double>(b - a + 1);
  double sx = s1.x - s0.x, sy = s1.y - s0.y, sxx = s1.xx - s0.xx, sxy = s1.xy - s0.xy, syy = s1.yy - s0.yy;
  Vec2 p0 = at(a), p1 = at(b);
  double dx = p1.x - p0.x, dy = p1.y - p0.y, len = std::sqrt(dx * dx + dy * dy);
  if (len < 1e-12) return 1e9;
  double la = -dy / len, lb = dx / len, lc = -(la * p0.x + lb * p0.y);
  double ss = la * la * sxx + 2 * la * lb * sxy + lb * lb * syy + 2 * la * lc * sx + 2 * lb * lc * sy + lc * lc * m;
  return len * std::sqrt(std::max(0.0, ss) / m);
}

bool ContourTracer::bestPolygon(int start, int maxStep, std::vector<int64_t>& vertices, int& count, double& pen) const {
  // Positions a = 0 … n relative to `start`. reach[a]: the furthest b that (a, b) is a segment to, made non-decreasing
  // (the least over a and everything after it), so the fewest segments come from a greedy walk.
  const int n = n_;
  std::vector<int> reach(static_cast<size_t>(n + 1));
  reach[static_cast<size_t>(n)] = n;
  for (int a = n - 1; a >= 0; a--) {
    int e = std::min({static_cast<int>(maxEnd(start + a) - start), a + maxStep, n});
    reach[static_cast<size_t>(a)] = std::min(e, reach[static_cast<size_t>(a + 1)]);
  }
  // hi[k]: the furthest position k segments get to; lo[k]: the nearest position from which the rest still fits in
  // m − k. An optimal polygon's k-th vertex lies in [lo[k], hi[k]] (the paper's §2.2.2 ranges).
  std::vector<int> hi{0};
  while (hi.back() < n) {
    int next = reach[static_cast<size_t>(hi.back())];
    if (next <= hi.back()) return false;
    hi.push_back(next);
  }
  const int m = static_cast<int>(hi.size()) - 1;
  hi.back() = n;
  std::vector<int> lo(static_cast<size_t>(m + 1));
  lo[static_cast<size_t>(m)] = n;
  for (int k = m - 1; k >= 0; k--) {
    // The least a with reach[a] ≥ lo[k + 1] (reach is non-decreasing).
    int target = lo[static_cast<size_t>(k + 1)], l = 0, r = hi[static_cast<size_t>(k)];
    while (l < r) {
      int mid = (l + r) / 2;
      if (reach[static_cast<size_t>(mid)] >= target) r = mid;
      else l = mid + 1;
    }
    lo[static_cast<size_t>(k)] = l;
  }
  lo[0] = 0;
  // The least penalty, layer by layer (a position can be in two layers' ranges: each layer keeps its own).
  std::vector<std::vector<double>> cost(static_cast<size_t>(m + 1));
  std::vector<std::vector<int>> prev(static_cast<size_t>(m + 1));
  for (int k = 0; k <= m; k++) {
    size_t size = static_cast<size_t>(hi[static_cast<size_t>(k)] - lo[static_cast<size_t>(k)] + 1);
    cost[static_cast<size_t>(k)].assign(size, std::numeric_limits<double>::infinity());
    prev[static_cast<size_t>(k)].assign(size, -1);
  }
  cost[0][0] = 0;
  for (int k = 0; k < m; k++) {
    const int l0 = lo[static_cast<size_t>(k)], l1 = lo[static_cast<size_t>(k + 1)], h1 = hi[static_cast<size_t>(k + 1)];
    for (int a = l0; a <= hi[static_cast<size_t>(k)]; a++) {
      double ca = cost[static_cast<size_t>(k)][static_cast<size_t>(a - l0)];
      if (ca == std::numeric_limits<double>::infinity()) continue;
      int bEnd = std::min(reach[static_cast<size_t>(a)], h1);
      for (int b = std::max(a + 1, l1); b <= bEnd; b++) {
        double p = ca + penalty(start + a, start + b);
        double& cb = cost[static_cast<size_t>(k + 1)][static_cast<size_t>(b - l1)];
        if (p < cb) {
          cb = p;
          prev[static_cast<size_t>(k + 1)][static_cast<size_t>(b - l1)] = a;
        }
      }
    }
  }
  if (cost[static_cast<size_t>(m)][0] == std::numeric_limits<double>::infinity()) return false;
  count = m;
  pen = cost[static_cast<size_t>(m)][0];
  vertices.assign(static_cast<size_t>(m), 0);
  int b = n;
  for (int k = m; k > 0; k--) {
    b = prev[static_cast<size_t>(k)][static_cast<size_t>(b - lo[static_cast<size_t>(k)])];
    vertices[static_cast<size_t>(k - 1)] = start + b;
  }
  return true;
}

std::vector<int64_t> ContourTracer::optimalPolygon() const {
  // Any polygon has a vertex in [s, maxEnd(s)] (the edge over s ends there at the latest): the cyclic problem is
  // solved from each start in that window of the narrowest s (at most 24 of them, evenly spaced).
  int s0 = 0, reach = std::numeric_limits<int>::max();
  for (int i = 0; i < n_; i++) {
    int r = maxEnd(i) - i;
    if (r < reach) {
      reach = r;
      s0 = i;
    }
  }
  reach = std::max(reach, 1);
  int tries = std::min(reach + 1, 24);
  std::vector<int64_t> best, cand;
  int bestCount = std::numeric_limits<int>::max();
  double bestPen = 0;
  for (int maxStep : {n_, std::max(1, n_ / 3)}) {
    for (int t = 0; t < tries; t++) {
      int s = s0 + static_cast<int>(static_cast<int64_t>(t) * (reach + 1) / tries);
      int c;
      double p;
      if (!bestPolygon(s % n_, maxStep, cand, c, p) || c < 3) continue;
      if (c < bestCount || (c == bestCount && p < bestPen)) {
        bestCount = c;
        bestPen = p;
        best = cand;
      }
    }
    if (!best.empty()) break;  // (a polygon of two segments only: try again with shorter steps)
  }
  return best;
}

std::vector<Vec2> ContourTracer::adjust(const std::vector<int64_t>& poly) const {
  const size_t m = poly.size();
  // Each edge's least-squares line as a quadratic form on (x, y, 1): the squared distance to it.
  struct Q {
    double q[3][3] = {};
  };
  std::vector<Q> lines(m);
  for (size_t k = 0; k < m; k++) {
    int64_t i = poly[k], j = k + 1 < m ? poly[k + 1] : poly[0] + n_;
    int64_t off = (i / n_) * n_;
    int64_t a = i - off, b = j - off;
    const Sums &s0 = sums_[static_cast<size_t>(a)], &s1 = sums_[static_cast<size_t>(b + 1)];
    double cnt = static_cast<double>(b - a + 1);
    double cx = (s1.x - s0.x) / cnt, cy = (s1.y - s0.y) / cnt;
    double vxx = (s1.xx - s0.xx) / cnt - cx * cx, vxy = (s1.xy - s0.xy) / cnt - cx * cy, vyy = (s1.yy - s0.yy) / cnt - cy * cy;
    // The principal direction of the points.
    double lambda = (vxx + vyy) / 2 + std::sqrt(((vxx - vyy) / 2) * ((vxx - vyy) / 2) + vxy * vxy);
    Vec2 d1{vxy, lambda - vxx}, d2{lambda - vyy, vxy};
    Vec2 dir = d1.length() >= d2.length() ? d1 : d2;
    if (dir.length() < 1e-12) dir = at(j) - at(i);
    double len = dir.length();
    if (len < 1e-12) dir = {1, 0}, len = 1;
    Vec2 nrm{-dir.y / len, dir.x / len};
    double v[3] = {nrm.x, nrm.y, -(nrm.x * cx + nrm.y * cy)};
    for (int r = 0; r < 3; r++)
      for (int c = 0; c < 3; c++) lines[k].q[r][c] = v[r] * v[c];
  }
  std::vector<Vec2> out(m);
  for (size_t k = 0; k < m; k++) {
    const Q& a = lines[(k + m - 1) % m];
    const Q& b = lines[k];
    double q[3][3];
    for (int r = 0; r < 3; r++)
      for (int c = 0; c < 3; c++) q[r][c] = a.q[r][c] + b.q[r][c];
    auto value = [&](double x, double y) {
      double p[3] = {x, y, 1}, s = 0;
      for (int r = 0; r < 3; r++)
        for (int c = 0; c < 3; c++) s += p[r] * q[r][c] * p[c];
      return s;
    };
    Vec2 v = at(poly[k]);
    double x0 = v.x - 0.5, x1 = v.x + 0.5, y0 = v.y - 0.5, y1 = v.y + 0.5;
    // The lines' meeting point (the unconstrained minimum) when it lies in the square.
    double det = q[0][0] * q[1][1] - q[0][1] * q[1][0];
    if (std::abs(det) > 1e-9) {
      double x = (-q[0][2] * q[1][1] + q[1][2] * q[0][1]) / det, y = (q[0][2] * q[1][0] - q[0][0] * q[1][2]) / det;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
        out[k] = {x, y};
        continue;
      }
    }
    // Else the least value on the square's boundary.
    double best = std::numeric_limits<double>::max();
    Vec2 bp = v;
    auto consider = [&](double x, double y) {
      double s = value(x, y);
      if (s < best) {
        best = s;
        bp = {x, y};
      }
    };
    for (double x : {x0, x1}) {
      double y = q[1][1] > 1e-12 ? std::clamp(-(q[0][1] * x + q[1][2]) / q[1][1], y0, y1) : y0;
      consider(x, y);
      consider(x, y0);
      consider(x, y1);
    }
    for (double y : {y0, y1}) {
      double x = q[0][0] > 1e-12 ? std::clamp(-(q[0][1] * y + q[0][2]) / q[0][0], x0, x1) : x0;
      consider(x, y);
    }
    out[k] = bp;
  }
  return out;
}

// ---- 4. Smoothing and 5. curve optimisation ------------------------------------------------------------------

struct Seg {
  bool corner = false;
  Vec2 vertex;     // the polygon vertex (a corner's point)
  Vec2 c1, c2;     // a curve's controls
  Vec2 end;        // the midpoint of the next edge
};

// ∮ x dy along a cubic (the curve's part of a closed region's signed area).
double cubicXdy(Vec2 p0, Vec2 p1, Vec2 p2, Vec2 p3) {
  // x(t) = Σ xi B3i(t), y'(t) = 3 Σ (y(j+1) − yj) B2j(t); ∫ B3i B2j = C(3,i) C(2,j) / (C(5,i+j) · 6).
  static const double c3[4] = {1, 3, 3, 1}, c2[3] = {1, 2, 1}, c5[6] = {1, 5, 10, 10, 5, 1};
  const Vec2 p[4] = {p0, p1, p2, p3};
  double s = 0;
  for (int i = 0; i < 4; i++)
    for (int j = 0; j < 3; j++) s += p[i].x * (p[j + 1].y - p[j].y) * c3[i] * c2[j] / (c5[i + j] * 6);
  return 3 * s;
}

double lineXdy(Vec2 a, Vec2 b) { return (a.x + b.x) / 2 * (b.y - a.y); }

double pointToCubic(Vec2 q, Vec2 p0, Vec2 p1, Vec2 p2, Vec2 p3) {
  auto d2 = [&](double t) {
    Vec2 p = geom::cubicAt(p0, p1, p2, p3, t);
    return (p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y);
  };
  constexpr int kSamples = 16;
  int bi = 0;
  double bd = d2(0);
  for (int i = 1; i <= kSamples; i++) {
    double d = d2(static_cast<double>(i) / kSamples);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  double lo = std::max(0.0, (bi - 1.0) / kSamples), hi = std::min(1.0, (bi + 1.0) / kSamples);
  for (int it = 0; it < 24; it++) {
    double a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
    if (d2(a) < d2(b)) hi = b;
    else lo = a;
  }
  return std::sqrt(std::min(bd, d2((lo + hi) / 2)));
}

class Smoother {
 public:
  Smoother(const std::vector<Vec2>& b, const TraceParams& params) : b_(b), m_(b.size()), params_(params) {}

  std::vector<Seg> smooth() const {
    std::vector<Seg> segs(m_);
    for (size_t k = 0; k < m_; k++) {
      Vec2 a = b_[(k + m_ - 1) % m_], b = b_[k], c = b_[(k + 1) % m_];
      Vec2 m1 = mid(a, b), m2 = mid(b, c);
      Seg& s = segs[k];
      s.vertex = b;
      s.end = m2;
      // α from how far b stands off the chord, against the unit square around b (the paper's §2.3.3).
      Vec2 u = c - a;
      double ul = u.length();
      double alpha = 4.0 / 3.0;
      if (ul > 1e-12) {
        double dist = std::abs(cross(u, b - m1)) / ul;
        double support = 0.5 * (std::abs(u.x) + std::abs(u.y)) / ul;
        double dd = support > 0 ? dist / support : 0;
        alpha = (dd > 1 ? 1 - 1 / dd : 0) / 0.75;
      }
      if (alpha > params_.alphaMax) {
        s.corner = true;
        continue;
      }
      alpha = std::clamp(alpha, 0.55, 1.0);
      s.c1 = lerp(m1, b, alpha);
      s.c2 = lerp(m2, b, alpha);
    }
    return segs;
  }

  // Runs of curves joined where one curve stays within optTolerance of them (the paper's §2.4).
  std::vector<Seg> optimise(const std::vector<Seg>& segs) const {
    const size_t m = segs.size();
    if (params_.optTolerance <= 0 || m < 3) return segs;
    std::vector<int> cnt(m + 1, std::numeric_limits<int>::max());
    std::vector<double> pen(m + 1, 0);
    std::vector<int> from(m + 1, -1);
    std::vector<Seg> joined(m + 1);  // the joined curve ending at j (from `from[j]`)
    cnt[0] = 0;
    for (size_t j = 1; j <= m; j++) {
      // A single segment: always.
      cnt[j] = cnt[j - 1] + 1;
      pen[j] = pen[j - 1];
      from[j] = static_cast<int>(j - 1);
      if (segs[j - 1].corner) continue;
      int sign = 0;
      double turn = 0;
      for (size_t first = j; first-- > 0 && j - first <= kMaxRun;) {
        // Segments first … j−1 joined: all curves, turning one way, less than 179° in all.
        if (segs[first].corner) break;
        Vec2 e0 = b_[first] - b_[(first + m_ - 1) % m_], e1 = b_[(first + 1) % m_] - b_[first];
        double cr = cross(e0, e1);
        int sg = cr > 1e-12 ? 1 : cr < -1e-12 ? -1 : 0;
        if (sign && sg && sg != sign) break;
        if (sg) sign = sg;
        turn += std::atan2(std::abs(cr), dot(e0, e1));
        if (j - 1 == first) continue;
        if (turn >= kMaxTurn) break;
        if (cnt[first] == std::numeric_limits<int>::max()) continue;
        Seg s;
        double p;
        if (!join(segs, first, j - 1, s, p)) continue;
        int c = cnt[first] + 1;
        double total = pen[first] + p;
        if (c < cnt[j] || (c == cnt[j] && total < pen[j])) {
          cnt[j] = c;
          pen[j] = total;
          from[j] = static_cast<int>(first);
          joined[j] = s;
        }
      }
    }
    std::vector<Seg> out;
    for (int j = static_cast<int>(m); j > 0; j = from[static_cast<size_t>(j)]) {
      int i = from[static_cast<size_t>(j)];
      out.push_back(j - i == 1 ? segs[static_cast<size_t>(j - 1)] : joined[static_cast<size_t>(j)]);
    }
    std::reverse(out.begin(), out.end());
    return out;
  }

  Vec2 start(size_t k) const { return mid(b_[(k + m_ - 1) % m_], b_[k]); }

 private:
  static constexpr size_t kMaxRun = 32;
  static constexpr double kMaxTurn = 179.0 * 3.14159265358979323846 / 180.0;
  const std::vector<Vec2>& b_;
  const size_t m_;
  const TraceParams& params_;

  // Segments i … j (j > i) as one curve: the same ends and end tangents, the same area; within tolerance.
  bool join(const std::vector<Seg>& segs, size_t i, size_t j, Seg& out, double& pen) const {
    Vec2 p0 = start(i), p3 = segs[j].end;
    Vec2 t0 = b_[i] - b_[(i + m_ - 1) % m_], t3 = b_[(j + 1) % m_] - b_[j];
    double det = cross(t0, t3);
    if (std::abs(det) < 1e-12) return false;
    // O = p0 + s·t0 = p3 + r·t3, with O ahead of p0 and behind p3.
    Vec2 d = p3 - p0;
    double s = cross(d, t3) / det, r = cross(d, t0) / det;
    if (s <= 0 || r >= 0) return false;
    Vec2 o = p0 + t0 * s;
    // The area the segments enclose with the chord back.
    double target = lineXdy(p3, p0);
    Vec2 at = p0;
    for (size_t k = i; k <= j; k++) {
      const Seg& g = segs[k];
      target += cubicXdy(at, g.c1, g.c2, g.end);
      at = g.end;
    }
    auto area = [&](double a) { return cubicXdy(p0, lerp(p0, o, a), lerp(p3, o, a), p3) + lineXdy(p3, p0); };
    double f0 = area(0), fh = area(0.5), f1 = area(1);
    double qa = 2 * (f1 - 2 * fh + f0), qb = f1 - f0 - qa, qc = f0 - target;
    double alpha = -1;
    if (std::abs(qa) < 1e-12) {
      if (std::abs(qb) > 1e-12) alpha = -qc / qb;
    } else {
      double disc = qb * qb - 4 * qa * qc;
      if (disc >= 0) {
        double sq = std::sqrt(disc);
        double r1 = (-qb - sq) / (2 * qa), r2 = (-qb + sq) / (2 * qa);
        // The root in range nearest the usual α.
        for (double rr : {r1, r2})
          if (rr > 0 && rr < 2 && (alpha < 0 || std::abs(rr - 0.75) < std::abs(alpha - 0.75))) alpha = rr;
      }
    }
    if (!(alpha > 0 && alpha < 2)) return false;
    Vec2 c1 = lerp(p0, o, alpha), c2 = lerp(p3, o, alpha);
    // Every joint and every segment's middle within tolerance.
    pen = 0;
    at = p0;
    for (size_t k = i; k <= j; k++) {
      const Seg& g = segs[k];
      Vec2 probes[2] = {geom::cubicAt(at, g.c1, g.c2, g.end, 0.5), g.end};
      for (int q = 0; q < (k == j ? 1 : 2); q++) {
        double dd = pointToCubic(probes[q], p0, c1, c2, p3);
        if (dd > params_.optTolerance) return false;
        pen += dd * dd;
      }
      at = g.end;
    }
    // And the joined curve near the segments throughout (no overshoot between the probes): its points against the
    // polyline through the segments' ends and middles.
    std::vector<Vec2> chain{p0};
    at = p0;
    for (size_t k = i; k <= j; k++) {
      chain.push_back(geom::cubicAt(at, segs[k].c1, segs[k].c2, segs[k].end, 0.5));
      chain.push_back(segs[k].end);
      at = segs[k].end;
    }
    const double guard = params_.optTolerance + 0.5;
    for (int q = 1; q < 8; q++) {
      Vec2 c = geom::cubicAt(p0, c1, c2, p3, q / 8.0);
      double best = std::numeric_limits<double>::max();
      for (size_t e = 0; e + 1 < chain.size(); e++) {
        Vec2 a = chain[e], ab = chain[e + 1] - a;
        double len2 = dot(ab, ab), t = len2 > 0 ? std::clamp(dot(c - a, ab) / len2, 0.0, 1.0) : 0.0;
        Vec2 d = c - (a + ab * t);
        best = std::min(best, dot(d, d));
      }
      if (best > guard * guard) return false;
    }
    out.corner = false;
    out.vertex = o;
    out.c1 = c1;
    out.c2 = c2;
    out.end = p3;
    return true;
  }
};

bool ContourTracer::run(const Mat2x3& toOut, geom::Path& out, Limits& limits) {
  if (n_ < 4) return false;
  origin_ = pts_[0];
  straightness();
  prefixSums();
  std::vector<int64_t> poly = optimalPolygon();
  if (poly.size() < 3) return false;
  std::vector<Vec2> verts = adjust(poly);
  Smoother sm(verts, params_);
  std::vector<Seg> segs = sm.optimise(sm.smooth());
  // Lines and cubics, each ending at its point; a corner's two lines lose the edge midpoint between two corners
  // (it lies on their straight edge).
  struct Op {
    bool line;
    Vec2 c1, c2, end;
  };
  std::vector<Op> ops;
  for (const Seg& sg : segs) {
    if (sg.corner) {
      ops.push_back({true, {}, {}, sg.vertex});
      ops.push_back({true, {}, {}, sg.end});
    } else {
      ops.push_back({false, sg.c1, sg.c2, sg.end});
    }
  }
  for (bool again = true; again && ops.size() > 3;) {
    again = false;
    for (size_t i = 0; i < ops.size() && ops.size() > 3; i++) {
      size_t next = (i + 1) % ops.size(), prev = (i + ops.size() - 1) % ops.size();
      if (!ops[i].line || !ops[next].line) continue;
      Vec2 a = ops[prev].end, b = ops[i].end, c = ops[next].end;
      Vec2 ab = b - a, ac = c - a;
      if (std::abs(cross(ab, ac)) > 1e-9 * std::max(1.0, dot(ac, ac)) || dot(ab, ac) <= 0 || dot(ab, ab) >= dot(ac, ac)) continue;
      ops.erase(ops.begin() + static_cast<std::ptrdiff_t>(i));
      again = true;
      i--;
    }
  }
  Vec2 o{static_cast<double>(origin_.x), static_cast<double>(origin_.y)};
  auto map = [&](Vec2 p) { return toOut.apply(p + o); };
  out.moveTo(map(ops.back().end));
  for (size_t i = 0; i < ops.size(); i++) {
    const Op& op = ops[i];
    if (op.line && i + 1 == ops.size()) break;  // the closing line is the close's
    if (op.line) out.lineTo(map(op.end));
    else out.cubicTo(map(op.c1), map(op.c2), map(op.end));
  }
  limits.segments += ops.size();
  out.close();
  return true;
}

}  // namespace

void traceMask(const Mask& m, const TraceParams& params, const Mat2x3& toOut, geom::Path& out, Limits& limits) {
  std::vector<Contour> contours = decompose(m);
  for (const Contour& c : contours) {
    if (!limits.check()) return;
    ContourTracer(c, params).run(toOut, out, limits);
  }
  limits.check();
}

}  // namespace eng::trace
