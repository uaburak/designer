// Geometry primitives shared by the scene graph, the editor and the renderer.
// Doubles in the engine (world coordinates can be far from the origin); the
// GPU gets floats relative to the camera.
#pragma once

#include <algorithm>
#include <cmath>

namespace eng {

struct Vec2 {
  double x = 0, y = 0;
  Vec2 operator+(Vec2 o) const { return {x + o.x, y + o.y}; }
  Vec2 operator-(Vec2 o) const { return {x - o.x, y - o.y}; }
  Vec2 operator*(double s) const { return {x * s, y * s}; }
  bool operator==(const Vec2& o) const { return x == o.x && y == o.y; }
  double length() const { return std::sqrt(x * x + y * y); }
};

// Figma's Matrix: x' = m00*x + m01*y + m02, y' = m10*x + m11*y + m12.
struct Mat2x3 {
  double m00 = 1, m01 = 0, m02 = 0;
  double m10 = 0, m11 = 1, m12 = 0;

  static Mat2x3 translate(double x, double y) { return {1, 0, x, 0, 1, y}; }
  static Mat2x3 scale(double s) { return {s, 0, 0, 0, s, 0}; }
  static Mat2x3 rotate(double radians) {
    double c = std::cos(radians), s = std::sin(radians);
    return {c, -s, 0, s, c, 0};
  }

  Vec2 apply(Vec2 p) const { return {m00 * p.x + m01 * p.y + m02, m10 * p.x + m11 * p.y + m12}; }
  Vec2 applyLinear(Vec2 v) const { return {m00 * v.x + m01 * v.y, m10 * v.x + m11 * v.y}; }
  Vec2 translation() const { return {m02, m12}; }
  double determinant() const { return m00 * m11 - m01 * m10; }

  // this ∘ o: apply o first, then this.
  Mat2x3 operator*(const Mat2x3& o) const {
    return {m00 * o.m00 + m01 * o.m10, m00 * o.m01 + m01 * o.m11, m00 * o.m02 + m01 * o.m12 + m02,
            m10 * o.m00 + m11 * o.m10, m10 * o.m01 + m11 * o.m11, m10 * o.m02 + m11 * o.m12 + m12};
  }

  Mat2x3 inverse() const {
    double det = determinant();
    if (det == 0) return {};
    double inv = 1.0 / det;
    double a = m11 * inv, b = -m01 * inv, d = -m10 * inv, e = m00 * inv;
    return {a, b, -(a * m02 + b * m12), d, e, -(d * m02 + e * m12)};
  }

  // Whether the linear part keeps axes axis-aligned without flipping (scale only).
  bool isAxisAligned() const { return m01 == 0 && m10 == 0 && m00 > 0 && m11 > 0; }

  bool operator==(const Mat2x3& o) const {
    return m00 == o.m00 && m01 == o.m01 && m02 == o.m02 && m10 == o.m10 && m11 == o.m11 && m12 == o.m12;
  }
};

struct Rect {
  double x = 0, y = 0, w = 0, h = 0;
  double right() const { return x + w; }
  double bottom() const { return y + h; }
  bool empty() const { return !(w > 0 || h > 0); }
  bool contains(Vec2 p) const { return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h; }
  bool intersects(const Rect& o) const { return x <= o.right() && o.x <= right() && y <= o.bottom() && o.y <= bottom(); }
  bool containsRect(const Rect& o) const { return o.x >= x && o.y >= y && o.right() <= right() && o.bottom() <= bottom(); }
  Rect united(const Rect& o) const {
    double l = std::min(x, o.x), t = std::min(y, o.y);
    return {l, t, std::max(right(), o.right()) - l, std::max(bottom(), o.bottom()) - t};
  }
  static Rect fromPoints(Vec2 a, Vec2 b) {
    return {std::min(a.x, b.x), std::min(a.y, b.y), std::fabs(a.x - b.x), std::fabs(a.y - b.y)};
  }
  bool operator==(const Rect& o) const { return x == o.x && y == o.y && w == o.w && h == o.h; }
};

// The axis-aligned bounds of a w×h box placed by `m`.
inline Rect transformedBounds(const Mat2x3& m, double w, double h) {
  Vec2 p[4] = {m.apply({0, 0}), m.apply({w, 0}), m.apply({w, h}), m.apply({0, h})};
  double l = p[0].x, r = p[0].x, t = p[0].y, b = p[0].y;
  for (auto& q : p) {
    l = std::min(l, q.x);
    r = std::max(r, q.x);
    t = std::min(t, q.y);
    b = std::max(b, q.y);
  }
  return {l, t, r - l, b - t};
}

// Signed distance from p (relative to the box's centre) to a box of half-size
// `half` with per-corner radii {tl, tr, br, bl} (y down). Negative inside.
inline double sdRoundedBox(Vec2 p, Vec2 half, const double radii[4]) {
  double r = p.x > 0 ? (p.y > 0 ? radii[2] : radii[1]) : (p.y > 0 ? radii[3] : radii[0]);
  r = std::min(r, std::min(half.x, half.y));
  r = std::max(r, 0.0);
  double qx = std::fabs(p.x) - half.x + r, qy = std::fabs(p.y) - half.y + r;
  double outside = std::sqrt(std::max(qx, 0.0) * std::max(qx, 0.0) + std::max(qy, 0.0) * std::max(qy, 0.0));
  return std::min(std::max(qx, qy), 0.0) + outside - r;
}

// Approximate signed distance to an axis-aligned ellipse of radii `r` centred at 0.
inline double sdEllipse(Vec2 p, Vec2 r) {
  if (r.x <= 0 || r.y <= 0) return std::max(std::fabs(p.x) - r.x, std::fabs(p.y) - r.y);
  double k0 = std::sqrt((p.x / r.x) * (p.x / r.x) + (p.y / r.y) * (p.y / r.y));
  double k1 = std::sqrt((p.x / (r.x * r.x)) * (p.x / (r.x * r.x)) + (p.y / (r.y * r.y)) * (p.y / (r.y * r.y)));
  if (k1 == 0) return -std::min(r.x, r.y);
  return k0 * (k0 - 1.0) / k1;
}

}  // namespace eng
