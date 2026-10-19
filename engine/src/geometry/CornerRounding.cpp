#include "geometry/CornerRounding.h"

#include <algorithm>
#include <cmath>
#include <vector>

namespace eng::geom {

namespace {

constexpr double kPi = 3.14159265358979323846;
// A join turning less than this is smooth (a curve's sections, a circle's quarters): not a corner.
constexpr double kSmoothTurn = 0.5 * kPi / 180;

double cross(Vec2 a, Vec2 b) { return a.x * b.y - a.y * b.x; }
double dot(Vec2 a, Vec2 b) { return a.x * b.x + a.y * b.y; }
Vec2 unit(Vec2 v) {
  double l = v.length();
  return l > 0 ? v * (1 / l) : Vec2{};
}

// One segment as a cubic (a line: p1 = p0, p2 = p3).
struct Seg {
  Vec2 p[4];
  bool line = true;
};

struct Contour {
  std::vector<Seg> segs;
  bool closed = false;
};

Seg lineSeg(Vec2 a, Vec2 b) {
  Seg s;
  s.p[0] = s.p[1] = a;
  s.p[2] = s.p[3] = b;
  s.line = true;
  return s;
}

// A cubic whose handles lie on its chord (between its ends) draws a line.
bool straight(const Seg& s, double eps) {
  Vec2 d = s.p[3] - s.p[0];
  double l = d.length();
  if (l <= eps) return false;
  for (int k = 1; k <= 2; k++) {
    Vec2 c = s.p[k] - s.p[0];
    if (std::fabs(cross(c, d)) / l > eps) return false;
    double along = dot(c, d) / l;
    if (along < -eps || along > l + eps) return false;
  }
  return true;
}

std::vector<Contour> contoursOf(const Path& path, double eps) {
  std::vector<Contour> out;
  forEachSegment(
      path, [&](Vec2) { out.emplace_back(); },
      [&](Verb v, Vec2 from, const Vec2* p) {
        Seg s;
        if (v == Verb::Line) {
          s = lineSeg(from, p[0]);
        } else if (v == Verb::Quad) {
          s.p[0] = from;
          s.p[1] = from + (p[0] - from) * (2.0 / 3);
          s.p[2] = p[1] + (p[0] - p[1]) * (2.0 / 3);
          s.p[3] = p[1];
          s.line = false;
        } else {
          s.p[0] = from, s.p[1] = p[0], s.p[2] = p[1], s.p[3] = p[2];
          s.line = false;
        }
        if (!s.line && straight(s, eps)) s = lineSeg(s.p[0], s.p[3]);
        out.back().segs.push_back(s);
      },
      [&](bool closed) { out.back().closed = closed; });
  return out;
}

double segLength(const Seg& s) {
  if (s.line) return (s.p[3] - s.p[0]).length();
  double len = 0;
  Vec2 prev = s.p[0];
  for (int k = 1; k <= 32; k++) {
    Vec2 q = cubicAt(s.p[0], s.p[1], s.p[2], s.p[3], k / 32.0);
    len += (q - prev).length();
    prev = q;
  }
  return len;
}

bool degenerate(const Seg& s, double eps) {
  for (int k = 1; k < 4; k++)
    if ((s.p[k] - s.p[0]).length() > eps) return false;
  return true;
}

// Zero-length segments dropped, collinear lines going on in the same direction merged (around the start too).
void clean(Contour& c, double eps) {
  std::vector<Seg> segs;
  for (const Seg& s : c.segs)
    if (!degenerate(s, eps)) segs.push_back(s);
  // Removing a degenerate segment can leave a gap of < eps: the next one starts where the previous ended.
  for (size_t i = 1; i < segs.size(); i++) {
    segs[i].p[0] = segs[i - 1].p[3];
    if (segs[i].line) segs[i].p[1] = segs[i].p[0];
  }
  auto mergeable = [&](const Seg& a, const Seg& b) {
    if (!a.line || !b.line) return false;
    Vec2 d = b.p[3] - a.p[0];
    double l = d.length();
    if (l <= eps) return false;
    if (dot(a.p[3] - a.p[0], b.p[3] - b.p[0]) <= 0) return false;
    return std::fabs(cross(a.p[3] - a.p[0], d)) / l <= eps;
  };
  std::vector<Seg> merged;
  for (const Seg& s : segs) {
    if (!merged.empty() && mergeable(merged.back(), s)) merged.back() = lineSeg(merged.back().p[0], s.p[3]);
    else merged.push_back(s);
  }
  if (c.closed) {
    while (merged.size() > 2 && mergeable(merged.back(), merged.front())) {
      merged.front() = lineSeg(merged.back().p[0], merged.front().p[3]);
      merged.pop_back();
    }
  }
  c.segs = std::move(merged);
}

Vec2 startTangent(const Seg& s) {
  for (int k = 1; k < 4; k++)
    if ((s.p[k] - s.p[0]).length() > 1e-12) return unit(s.p[k] - s.p[0]);
  return {};
}
Vec2 endTangent(const Seg& s) {
  for (int k = 2; k >= 0; k--)
    if ((s.p[3] - s.p[k]).length() > 1e-12) return unit(s.p[3] - s.p[k]);
  return {};
}

// The parameter at arc length `len` from the start.
double paramAt(const Seg& s, double len, double total) {
  if (total <= 0) return 0;
  if (s.line) return std::clamp(len / total, 0.0, 1.0);
  constexpr int kSteps = 64;
  double acc = 0;
  Vec2 prev = s.p[0];
  for (int k = 1; k <= kSteps; k++) {
    Vec2 q = cubicAt(s.p[0], s.p[1], s.p[2], s.p[3], static_cast<double>(k) / kSteps);
    double d = (q - prev).length();
    if (acc + d >= len) return (k - 1 + (d > 0 ? (len - acc) / d : 0)) / kSteps;
    acc += d;
    prev = q;
  }
  return 1;
}

void emit(Path& out, const Seg& s) {
  if (s.line) {
    if ((s.p[3] - s.p[0]).length() > 1e-9) out.lineTo(s.p[3]);
  } else {
    out.cubicTo(s.p[1], s.p[2], s.p[3]);
  }
}

// Figma's squircle on a corner between two lines, for any angle: the path is at V − u·p, ends at V + v·p. `phi`: the
// turn, `cut`: the plain arc's tangent length (r · tan(φ/2)), `s`: the smoothing (fits: (1 + s) · cut ≤ the room).
void squircle(Path& out, Vec2 V, Vec2 u, Vec2 v, double phi, double cut, double s) {
  double sigma = cross(u, v) >= 0 ? 1 : -1;
  double r = cut / std::tan(phi / 2);
  double p = (1 + s) * cut;
  auto rot = [&](Vec2 w, double a) {
    a *= sigma;
    double c = std::cos(a), n = std::sin(a);
    return Vec2{w.x * c - w.y * n, w.x * n + w.y * c};
  };
  Vec2 nIn = Vec2{-u.y, u.x} * sigma;  // towards the corner's inside
  Vec2 T1 = V - u * cut, T2 = V + v * cut, C = T1 + nIn * r;
  double alpha = phi * s / 2;      // each easing's turn
  double arc = phi * (1 - s);      // the circular part's
  Vec2 S = V - u * p, E = V + v * p;
  Vec2 A = C + rot(T1 - C, alpha), B = C + rot(T2 - C, -alpha);
  double h = r * std::tan(alpha / 2);
  Vec2 Q1 = T1 + u * h, Q2 = T2 - v * h;
  if (alpha > 1e-9) out.cubicTo(S + (Q1 - S) * (2.0 / 3), Q1, A);
  if (arc > 1e-9) {
    double k = 4.0 / 3 * std::tan(arc / 4) * r;
    out.cubicTo(A + rot(u, alpha) * k, B - rot(v, -alpha) * k, B);
  }
  if (alpha > 1e-9) out.cubicTo(Q2, Q2 + (E - Q2) * (1.0 / 3), E);
}

// A circular arc from P (heading along a) to Q (arriving along b), tangent to both: a corner next to a curve.
void arcBetween(Path& out, Vec2 P, Vec2 a, Vec2 Q, Vec2 b) {
  double den = cross(a, b);
  double psi = std::acos(std::clamp(dot(a, b), -1.0, 1.0));
  if (std::fabs(den) > 1e-12 && psi > 1e-6) {
    double t = cross(Q - P, b) / den, s = cross(a, Q - P) / den;
    if (t > 0 && s > 0) {
      double ratio = 4.0 / 3 * std::tan(psi / 4) / std::tan(psi / 2);
      out.cubicTo(P + a * (t * ratio), Q - b * (s * ratio), Q);
      return;
    }
  }
  double k = (Q - P).length() / 3;
  out.cubicTo(P + a * k, Q - b * k, Q);
}

void roundContour(Path& out, Contour& c, double radius, double smoothing) {
  const size_t n = c.segs.size();
  if (n == 0) return;
  if (radius <= 0 || n < 2) {
    out.moveTo(c.segs[0].p[0]);
    // A closed contour's last line back to its start: Close draws it.
    for (size_t i = 0; i < n; i++)
      if (!(c.closed && i + 1 == n && c.segs[i].line)) emit(out, c.segs[i]);
    if (c.closed) out.close();
    return;
  }
  // Vertex i: where segment i starts (segment i − 1 ends).
  struct Corner {
    bool on = false;
    double phi = 0, cut = 0, p = 0, s = 0;
    Vec2 u, v;
  };
  std::vector<double> len(n);
  for (size_t i = 0; i < n; i++) len[i] = segLength(c.segs[i]);
  std::vector<Corner> k(n);
  for (size_t i = 0; i < n; i++) {
    if (!c.closed && i == 0) continue;
    const Seg& in = c.segs[(i + n - 1) % n];
    const Seg& outSeg = c.segs[i];
    Vec2 u = endTangent(in), v = startTangent(outSeg);
    double phi = std::acos(std::clamp(dot(u, v), -1.0, 1.0));
    if (phi < kSmoothTurn || phi > kPi - 1e-3) continue;
    k[i].on = true;
    k[i].phi = phi;
    k[i].u = u;
    k[i].v = v;
  }
  for (size_t i = 0; i < n; i++) {
    if (!k[i].on) continue;
    size_t prev = (i + n - 1) % n;  // the segment coming in (from vertex prev)
    size_t nextEnd = (i + 1) % n;   // the vertex the segment going out ends at
    bool prevCorner = k[prev].on, nextCorner = (c.closed || i + 1 < n) && k[nextEnd].on;
    // Figma's clamp: at most half of each neighbouring edge (the whole edge where its other end is no corner).
    double room = std::min(len[prev] * (prevCorner ? 0.5 : 1), len[i] * (nextCorner ? 0.5 : 1));
    double cut = std::min(radius * std::tan(k[i].phi / 2), room);
    bool lines = c.segs[prev].line && c.segs[i].line;
    double s = lines ? std::clamp(smoothing, 0.0, 1.0) : 0;
    // Not enough room for the full smoothing: less of it (Figma keeps the radius, gives up smoothing).
    if (cut > 0 && (1 + s) * cut > room) s = std::max(0.0, room / cut - 1);
    k[i].cut = cut;
    k[i].s = s;
    k[i].p = (1 + s) * cut;
  }
  // Each segment trimmed by its corners' reach.
  std::vector<Seg> t(n);
  for (size_t i = 0; i < n; i++) {
    const Seg& s = c.segs[i];
    double a = k[i].on ? k[i].p : 0;
    size_t j = (i + 1) % n;
    double b = (c.closed || i + 1 < n) && k[j].on ? k[j].p : 0;
    if (s.line) {
      Vec2 dir = unit(s.p[3] - s.p[0]);
      t[i] = lineSeg(a > 0 ? s.p[0] + dir * a : s.p[0], b > 0 ? s.p[3] - dir * b : s.p[3]);
    } else if (a > 0 || b > 0) {
      double t0 = a > 0 ? paramAt(s, a, len[i]) : 0, t1 = b > 0 ? paramAt(s, len[i] - b, len[i]) : 1;
      if (t1 < t0) t0 = t1 = (t0 + t1) / 2;
      Seg cut;
      cut.line = false;
      cubicSection(s.p, t0, t1, cut.p);
      t[i] = cut;
    } else {
      t[i] = s;
    }
  }
  auto corner = [&](size_t i) {
    const Corner& q = k[i];
    if (!q.on || q.cut <= 0) return;
    size_t prev = (i + n - 1) % n;
    if (c.segs[prev].line && c.segs[i].line) squircle(out, c.segs[i].p[0], q.u, q.v, q.phi, q.cut, q.s);
    else arcBetween(out, t[prev].p[3], endTangent(t[prev]).length() > 0 ? endTangent(t[prev]) : q.u, t[i].p[0], startTangent(t[i]).length() > 0 ? startTangent(t[i]) : q.v);
  };
  out.moveTo(t[0].p[0]);
  for (size_t i = 0; i < n; i++) {
    if (!(c.closed && i + 1 == n && t[i].line && !k[0].on)) emit(out, t[i]);  // (Close draws that last line)
    size_t j = i + 1;
    if (j < n) corner(j);
    else if (c.closed) corner(0);
  }
  if (c.closed) out.close();
}

}  // namespace

Path roundCorners(const Path& path, double radius, double smoothing) {
  Rect b = path.bounds();
  // Clipper's results are on a 1/65536 grid: points that close count as one, lines that straight as one.
  const double eps = std::max(1e-4, std::max(b.w, b.h) * 1e-7);
  Path out;
  for (Contour& c : contoursOf(path, eps)) {
    clean(c, eps);
    roundContour(out, c, radius, smoothing);
  }
  return out;
}

Path removeRedundantPoints(const Path& path, double eps) {
  Path out;
  for (Contour& c : contoursOf(path, eps)) {
    clean(c, eps);
    roundContour(out, c, 0, 0);
  }
  return out;
}

}  // namespace eng::geom
