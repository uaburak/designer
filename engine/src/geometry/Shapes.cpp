#include "geometry/Shapes.h"

#include <algorithm>
#include <cmath>

namespace eng::geom {

namespace {

constexpr double kPi = 3.14159265358979323846;

Vec2 normalized(Vec2 v) {
  double l = v.length();
  return l > 0 ? v * (1 / l) : Vec2{};
}

// One corner of a (smoothed) rounded rectangle, walked clockwise: the path is at
// V − u·p on the edge coming in along `u` and ends at V + v·p on the edge going
// out along `v`. Figma's squircle ("Desperately seeking squircles", Figma 2018):
// an arc in the middle, eased into the edges by two cubics; smoothing 0 is a
// plain quarter circle.
void corner(Path& path, Vec2 V, Vec2 u, Vec2 v, double radius, double smoothing, double budget) {
  if (radius <= 0) {
    path.lineTo(V);
    return;
  }
  radius = std::min(radius, budget);
  double s = std::clamp(smoothing, 0.0, 1.0);
  double p = (1 + s) * radius;
  // Not enough room for the full smoothing: less of it (Figma keeps the radius, gives up smoothing).
  double maxSmoothing = budget / radius - 1;
  s = std::max(0.0, std::min(s, maxSmoothing));
  p = std::min(p, budget);
  double arcMeasure = (kPi / 2) * (1 - s);
  double arcSection = std::sin(arcMeasure / 2) * radius * std::sqrt(2.0);
  double alpha = (kPi / 2 - arcMeasure) / 2;
  double p3p4 = radius * std::tan(alpha / 2);
  double beta = (kPi / 4) * s;
  double c = p3p4 * std::cos(beta);
  double d = c * std::tan(beta);
  double b = (p - arcSection - c - d) / 3;
  double a = 2 * b;
  Vec2 S = V - u * p;
  path.lineTo(S);
  Vec2 A = S + u * (a + b + c) + v * d;
  if (a + b + c + d > 1e-9) path.cubicTo(S + u * a, S + u * (a + b), A);
  Vec2 B = A + u * arcSection + v * arcSection;
  Vec2 tA = (c == 0 && d == 0) ? u : normalized(u * c + v * d);
  Vec2 tB = (c == 0 && d == 0) ? v : normalized(u * d + v * c);
  double k = 4.0 / 3 * std::tan(arcMeasure / 4) * radius;
  if (arcMeasure > 1e-9) path.cubicTo(A + tA * k, B - tB * k, B);
  Vec2 E = B + u * d + v * (a + b + c);
  if (a + b + c + d > 1e-9) path.cubicTo(B + u * d + v * c, B + u * d + v * (b + c), E);
}

// Points of a regular star / polygon on the unit circle, the first at the top.
std::vector<Vec2> starPoints(uint32_t count, double inner, bool star) {
  std::vector<Vec2> pts;
  uint32_t n = std::max<uint32_t>(count, 3);
  for (uint32_t i = 0; i < n; i++) {
    double a = -kPi / 2 + 2 * kPi * i / n;
    pts.push_back({std::cos(a), std::sin(a)});
    if (star) {
      double b = a + kPi / n;
      pts.push_back({std::cos(b) * inner, std::sin(b) * inner});
    }
  }
  return pts;
}

// Stretches `pts` so the outer points' bounds fill the box.
std::vector<Vec2> fitToBox(std::vector<Vec2> pts, Vec2 size, size_t stride) {
  double x0 = 1e300, x1 = -1e300, y0 = 1e300, y1 = -1e300;
  for (size_t i = 0; i < pts.size(); i += stride) {
    x0 = std::min(x0, pts[i].x), x1 = std::max(x1, pts[i].x);
    y0 = std::min(y0, pts[i].y), y1 = std::max(y1, pts[i].y);
  }
  double sx = x1 > x0 ? size.x / (x1 - x0) : 0, sy = y1 > y0 ? size.y / (y1 - y0) : 0;
  for (auto& p : pts) p = {(p.x - x0) * sx, (p.y - y0) * sy};
  return pts;
}

}  // namespace

CornerRadii clampRadii(Vec2 size, const CornerRadii& r) {
  double w = std::fabs(size.x), h = std::fabs(size.y);
  double f = 1;
  auto side = [&](double a, double b, double len) {
    if (a + b > len && a + b > 0) f = std::min(f, len / (a + b));
  };
  side(r[0], r[1], w);  // top
  side(r[3], r[2], w);  // bottom
  side(r[0], r[3], h);  // left
  side(r[1], r[2], h);  // right
  CornerRadii out;
  for (int i = 0; i < 4; i++) out[static_cast<size_t>(i)] = std::max(0.0, r[static_cast<size_t>(i)] * f);
  return out;
}

Path rectPath(Vec2 size, const CornerRadii& radii0, double smoothing) {
  Path path;
  double w = size.x, h = size.y;
  CornerRadii r = clampRadii(size, radii0);
  bool rounded = r[0] > 0 || r[1] > 0 || r[2] > 0 || r[3] > 0;
  if (!rounded) {
    path.moveTo({0, 0});
    path.lineTo({w, 0});
    path.lineTo({w, h});
    path.lineTo({0, h});
    path.close();
    return path;
  }
  CornerRadii budget = cornerBudgets({std::fabs(w), std::fabs(h)}, r);
  // Start mid-way along the top edge, clockwise.
  path.moveTo({w / 2, 0});
  corner(path, {w, 0}, {1, 0}, {0, 1}, r[1], smoothing, budget[1]);
  corner(path, {w, h}, {0, 1}, {-1, 0}, r[2], smoothing, budget[2]);
  corner(path, {0, h}, {-1, 0}, {0, -1}, r[3], smoothing, budget[3]);
  corner(path, {0, 0}, {0, -1}, {1, 0}, r[0], smoothing, budget[0]);
  path.close();
  return path;
}

CornerRadii cornerBudgets(Vec2 size, CornerRadii& r) {
  // Each corner's room along its two edges (figma-squircle's distributeAndNormalize, which Figma's smoothed
  // outlines follow): largest radius first, a corner takes its share of each edge by radius (r / (r + r'), the
  // edge's rest when the neighbour has had its share), the smaller of its two edges; the radius is kept within it.
  // Next to a square corner a corner has the whole edge — smoothing isn't given up for room it has.
  static constexpr int kAdjacent[4][2] = {{1, 3}, {0, 2}, {3, 1}, {2, 0}};  // tl: tr (top), bl (left); …
  CornerRadii budget{-1, -1, -1, -1};
  int order[4] = {0, 1, 2, 3};
  std::stable_sort(order, order + 4, [&](int a, int b) { return r[static_cast<size_t>(a)] > r[static_cast<size_t>(b)]; });
  for (int c : order) {
    double radius = r[static_cast<size_t>(c)];
    double room = 1e300;
    for (int k = 0; k < 2; k++) {
      int n = kAdjacent[c][k];
      double rn = r[static_cast<size_t>(n)];
      double side = k == 0 ? size.x : size.y;  // the first neighbour is along the top or bottom edge
      double share;
      if (radius == 0 && rn == 0) share = 0;
      else if (budget[static_cast<size_t>(n)] >= 0) share = side - budget[static_cast<size_t>(n)];
      else share = radius / (radius + rn) * side;
      room = std::min(room, share);
    }
    budget[static_cast<size_t>(c)] = room;
    r[static_cast<size_t>(c)] = std::min(radius, room);
  }
  return budget;
}

void arcTo(Path& path, Vec2 c, double rx, double ry, double a0, double a1) {
  double sweep = a1 - a0;
  int n = std::max(1, static_cast<int>(std::ceil(std::fabs(sweep) / (kPi / 2) - 1e-9)));
  double step = sweep / n;
  double k = 4.0 / 3 * std::tan(step / 4);
  for (int i = 0; i < n; i++) {
    double t0 = a0 + step * i, t1 = t0 + step;
    Vec2 p0{std::cos(t0), std::sin(t0)}, p1{std::cos(t1), std::sin(t1)};
    Vec2 c1{p0.x - k * p0.y, p0.y + k * p0.x};
    Vec2 c2{p1.x + k * p1.y, p1.y - k * p1.x};
    auto map = [&](Vec2 q) { return Vec2{c.x + q.x * rx, c.y + q.y * ry}; };
    path.cubicTo(map(c1), map(c2), map(p1));
  }
}

Path ellipsePath(Vec2 size, const ArcData& arc) {
  Path path;
  double rx = size.x / 2, ry = size.y / 2;
  Vec2 c{rx, ry};
  auto at = [&](double a, double s) { return Vec2{c.x + std::cos(a) * rx * s, c.y + std::sin(a) * ry * s}; };
  double inner = std::clamp(arc.innerRadius, 0.0, 1.0);
  bool full = arc.isFull();
  double a0 = arc.startingAngle, a1 = arc.endingAngle;
  if (full || (a0 == 0 && a1 == 0)) {
    a0 = 0;
    a1 = 2 * kPi;
  }
  if (a1 < a0) std::swap(a0, a1);
  bool whole = a1 - a0 >= 2 * kPi - 1e-9;
  if (whole) a1 = a0 + 2 * kPi;
  path.moveTo(at(a0, 1));
  arcTo(path, c, rx, ry, a0, a1);
  path.close();
  if (inner > 0) {
    if (whole) {
      // A ring: the hole is a second contour, the other way round.
      path.moveTo(at(a1, inner));
      arcTo(path, c, rx * inner, ry * inner, a1, a0);
      path.close();
    } else {
      // A donut segment: replace the simple contour with outer arc + inner arc back.
      path.clear();
      path.moveTo(at(a0, 1));
      arcTo(path, c, rx, ry, a0, a1);
      path.lineTo(at(a1, inner));
      arcTo(path, c, rx * inner, ry * inner, a1, a0);
      path.close();
    }
  } else if (!whole) {
    // A pie: back through the centre.
    path.clear();
    path.moveTo(c);
    path.lineTo(at(a0, 1));
    arcTo(path, c, rx, ry, a0, a1);
    path.close();
  }
  return path;
}

Path roundedPolygon(const std::vector<Vec2>& pts, double radius) {
  Path path;
  size_t n = pts.size();
  if (n < 3) return path;
  if (radius <= 0) {
    path.moveTo(pts[0]);
    for (size_t i = 1; i < n; i++) path.lineTo(pts[i]);
    path.close();
    return path;
  }
  for (size_t i = 0; i < n; i++) {
    Vec2 prev = pts[(i + n - 1) % n], v = pts[i], next = pts[(i + 1) % n];
    Vec2 a = normalized(prev - v), b = normalized(next - v);
    double cosT = std::clamp(a.x * b.x + a.y * b.y, -1.0, 1.0);
    double theta = std::acos(cosT);  // the corner's interior angle
    double cut = theta > 1e-6 ? radius / std::tan(theta / 2) : 0;
    double maxCut = std::min((prev - v).length(), (next - v).length()) / 2;
    double r = radius;
    if (cut > maxCut) {
      cut = maxCut;
      r = cut * std::tan(theta / 2);
    }
    Vec2 p0 = v + a * cut, p1 = v + b * cut;
    if (i == 0) path.moveTo(p0);
    else path.lineTo(p0);
    double phi = kPi - theta;  // the turn
    double k = 4.0 / 3 * std::tan(phi / 4) * r;
    path.cubicTo(p0 - a * k, p1 - b * k, p1);
  }
  path.close();
  return path;
}

Path polygonPath(Vec2 size, uint32_t count, double cornerRadius) {
  return roundedPolygon(fitToBox(starPoints(count, 0, false), size, 1), cornerRadius);
}

Path starPath(Vec2 size, uint32_t count, double innerScale, double cornerRadius) {
  return roundedPolygon(fitToBox(starPoints(count, std::clamp(innerScale, 0.0, 1.0), true), size, 2), cornerRadius);
}

Path linePath(Vec2 size) {
  Path path;
  path.moveTo({0, 0});
  path.lineTo({size.x, 0});
  return path;
}

}  // namespace eng::geom
