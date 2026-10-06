#include "geometry/Path.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace eng::geom {

namespace {

void grow(double& lo, double& hi, double v) {
  lo = std::min(lo, v);
  hi = std::max(hi, v);
}

// The roots in (0, 1) of the derivative of a 1-D cubic Bézier (a, b, c, d).
int cubicExtrema(double a, double b, double c, double d, double t[2]) {
  // B'(t)/3 = (b-a)(1-t)² + 2(c-b)(1-t)t + (d-c)t²  →  A t² + B t + C
  double A = (d - c) - 2 * (c - b) + (b - a), B = 2 * ((c - b) - (b - a)), C = b - a;
  int n = 0;
  if (std::fabs(A) < 1e-12) {
    if (std::fabs(B) > 1e-12) {
      double r = -C / B;
      if (r > 0 && r < 1) t[n++] = r;
    }
    return n;
  }
  double disc = B * B - 4 * A * C;
  if (disc < 0) return 0;
  double s = std::sqrt(disc);
  for (double r : {(-B + s) / (2 * A), (-B - s) / (2 * A)})
    if (r > 0 && r < 1) t[n++] = r;
  return n;
}

uint64_t fnv(uint64_t h, const void* data, size_t size) {
  const auto* p = static_cast<const uint8_t*>(data);
  for (size_t i = 0; i < size; i++) {
    h ^= p[i];
    h *= 1099511628211ull;
  }
  return h;
}

float readF32(const uint8_t* p) {
  uint32_t bits = static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16) |
                  (static_cast<uint32_t>(p[3]) << 24);
  float f;
  std::memcpy(&f, &bits, 4);
  return f;
}

void writeF32(std::vector<uint8_t>& out, double v) {
  float f = static_cast<float>(v);
  uint32_t bits;
  std::memcpy(&bits, &f, 4);
  for (int i = 0; i < 4; i++) out.push_back(static_cast<uint8_t>((bits >> (8 * i)) & 0xff));
}

}  // namespace

void Path::moveTo(Vec2 p) {
  verbs.push_back(Verb::Move);
  points.push_back(p);
}
void Path::lineTo(Vec2 p) {
  verbs.push_back(Verb::Line);
  points.push_back(p);
}
void Path::quadTo(Vec2 c, Vec2 p) {
  verbs.push_back(Verb::Quad);
  points.push_back(c);
  points.push_back(p);
}
void Path::cubicTo(Vec2 c1, Vec2 c2, Vec2 p) {
  verbs.push_back(Verb::Cubic);
  points.push_back(c1);
  points.push_back(c2);
  points.push_back(p);
}
void Path::close() { verbs.push_back(Verb::Close); }

void Path::append(const Path& o) {
  verbs.insert(verbs.end(), o.verbs.begin(), o.verbs.end());
  points.insert(points.end(), o.points.begin(), o.points.end());
}

void Path::transform(const Mat2x3& m) {
  for (Vec2& p : points) p = m.apply(p);
}

Rect Path::bounds() const {
  if (points.empty()) return {};
  double x0 = 1e300, x1 = -1e300, y0 = 1e300, y1 = -1e300;
  bool any = false;
  forEachSegment(
      *this,
      [&](Vec2 p) {
        grow(x0, x1, p.x);
        grow(y0, y1, p.y);
        any = true;
      },
      [&](Verb v, Vec2 from, const Vec2* p) {
        Vec2 end = v == Verb::Line ? p[0] : v == Verb::Quad ? p[1] : p[2];
        grow(x0, x1, end.x);
        grow(y0, y1, end.y);
        if (v == Verb::Quad) {
          // Elevate to a cubic for the extrema.
          Vec2 c1 = from + (p[0] - from) * (2.0 / 3), c2 = p[1] + (p[0] - p[1]) * (2.0 / 3);
          double t[2];
          int n = cubicExtrema(from.x, c1.x, c2.x, p[1].x, t);
          for (int i = 0; i < n; i++) grow(x0, x1, cubicAt(from, c1, c2, p[1], t[i]).x);
          n = cubicExtrema(from.y, c1.y, c2.y, p[1].y, t);
          for (int i = 0; i < n; i++) grow(y0, y1, cubicAt(from, c1, c2, p[1], t[i]).y);
        } else if (v == Verb::Cubic) {
          double t[2];
          int n = cubicExtrema(from.x, p[0].x, p[1].x, p[2].x, t);
          for (int i = 0; i < n; i++) grow(x0, x1, cubicAt(from, p[0], p[1], p[2], t[i]).x);
          n = cubicExtrema(from.y, p[0].y, p[1].y, p[2].y, t);
          for (int i = 0; i < n; i++) grow(y0, y1, cubicAt(from, p[0], p[1], p[2], t[i]).y);
        }
      },
      [](bool) {});
  if (!any) return {};
  return {x0, y0, x1 - x0, y1 - y0};
}

Path Path::reversed() const {
  // Collect contours as (start, segments) then emit them backwards.
  struct Seg {
    Verb v;
    Vec2 from;
    Vec2 p[3];
  };
  Path out;
  std::vector<Seg> segs;
  Vec2 start;
  auto flush = [&](bool closed) {
    if (segs.empty()) {
      out.moveTo(start);
      if (closed) out.close();
      return;
    }
    Vec2 end = segs.back().v == Verb::Line ? segs.back().p[0] : segs.back().v == Verb::Quad ? segs.back().p[1] : segs.back().p[2];
    out.moveTo(end);
    for (auto it = segs.rbegin(); it != segs.rend(); ++it) {
      switch (it->v) {
        case Verb::Line: out.lineTo(it->from); break;
        case Verb::Quad: out.quadTo(it->p[0], it->from); break;
        case Verb::Cubic: out.cubicTo(it->p[1], it->p[0], it->from); break;
        default: break;
      }
    }
    if (closed) out.close();
    segs.clear();
  };
  forEachSegment(
      *this, [&](Vec2 p) { start = p; },
      [&](Verb v, Vec2 from, const Vec2* p) {
        Seg s{v, from, {}};
        int n = v == Verb::Line ? 1 : v == Verb::Quad ? 2 : 3;
        for (int i = 0; i < n; i++) s.p[i] = p[i];
        segs.push_back(s);
      },
      flush);
  return out;
}

uint64_t Path::hash() const {
  uint64_t h = 1469598103934665603ull;
  h = fnv(h, verbs.data(), verbs.size());
  h = fnv(h, points.data(), points.size() * sizeof(Vec2));
  return h;
}

Path Path::fromCommands(const uint8_t* data, size_t size) {
  Path p;
  size_t i = 0;
  auto pt = [&](Vec2& out) {
    if (i + 8 > size) return false;
    out = {readF32(data + i), readF32(data + i + 4)};
    i += 8;
    return true;
  };
  bool open = false;
  while (i < size) {
    uint8_t op = data[i++];
    Vec2 a, b, c;
    switch (op) {
      case 0:
        if (open) p.close();
        open = false;
        break;
      case 1:
        if (!pt(a)) return p;
        p.moveTo(a);
        open = true;
        break;
      case 2:
        if (!pt(a)) return p;
        if (!open) p.moveTo(p.points.empty() ? Vec2{} : p.points.back()), open = true;
        p.lineTo(a);
        break;
      case 3:
        if (!pt(a) || !pt(b)) return p;
        if (!open) p.moveTo(p.points.empty() ? Vec2{} : p.points.back()), open = true;
        p.quadTo(a, b);
        break;
      case 4:
        if (!pt(a) || !pt(b) || !pt(c)) return p;
        if (!open) p.moveTo(p.points.empty() ? Vec2{} : p.points.back()), open = true;
        p.cubicTo(a, b, c);
        break;
      default: return p;  // unknown opcode: stop
    }
  }
  return p;
}

std::vector<uint8_t> Path::toCommands() const {
  std::vector<uint8_t> out;
  size_t pi = 0;
  for (Verb v : verbs) {
    int n = 0;
    switch (v) {
      case Verb::Move: out.push_back(1), n = 1; break;
      case Verb::Line: out.push_back(2), n = 1; break;
      case Verb::Quad: out.push_back(3), n = 2; break;
      case Verb::Cubic: out.push_back(4), n = 3; break;
      case Verb::Close: out.push_back(0); break;
    }
    for (int k = 0; k < n; k++, pi++) {
      writeF32(out, points[pi].x);
      writeF32(out, points[pi].y);
    }
  }
  return out;
}

Vec2 quadAt(Vec2 p0, Vec2 p1, Vec2 p2, double t) {
  double u = 1 - t;
  return p0 * (u * u) + p1 * (2 * u * t) + p2 * (t * t);
}

Vec2 cubicAt(Vec2 p0, Vec2 p1, Vec2 p2, Vec2 p3, double t) {
  double u = 1 - t;
  return p0 * (u * u * u) + p1 * (3 * u * u * t) + p2 * (3 * u * t * t) + p3 * (t * t * t);
}

void cubicSection(const Vec2 in[4], double t0, double t1, Vec2 out[4]) {
  // Blossoming: the control points of [t0, t1] are B(t0,t0,t0), B(t0,t0,t1), B(t0,t1,t1), B(t1,t1,t1).
  auto blossom = [&](double a, double b, double c) {
    auto lerp = [](Vec2 p, Vec2 q, double t) { return p + (q - p) * t; };
    Vec2 q0 = lerp(in[0], in[1], a), q1 = lerp(in[1], in[2], a), q2 = lerp(in[2], in[3], a);
    Vec2 r0 = lerp(q0, q1, b), r1 = lerp(q1, q2, b);
    return lerp(r0, r1, c);
  };
  out[0] = blossom(t0, t0, t0);
  out[1] = blossom(t0, t0, t1);
  out[2] = blossom(t0, t1, t1);
  out[3] = blossom(t1, t1, t1);
}

void flattenQuad(Vec2 p0, Vec2 p1, Vec2 p2, double tolerance, std::vector<Vec2>& out) {
  Vec2 dd = p0 - p1 * 2 + p2;
  double m = dd.length();
  int n = std::clamp(static_cast<int>(std::ceil(std::sqrt(m / (4 * std::max(tolerance, 1e-9))))), 1, 1000);
  for (int i = 1; i < n; i++) out.push_back(quadAt(p0, p1, p2, static_cast<double>(i) / n));
  out.push_back(p2);
}

void flattenCubic(Vec2 p0, Vec2 p1, Vec2 p2, Vec2 p3, double tolerance, std::vector<Vec2>& out) {
  double m = std::max((p0 - p1 * 2 + p2).length(), (p1 - p2 * 2 + p3).length());
  int n = std::clamp(static_cast<int>(std::ceil(std::sqrt(0.75 * m / std::max(tolerance, 1e-9)))), 1, 1000);
  for (int i = 1; i < n; i++) out.push_back(cubicAt(p0, p1, p2, p3, static_cast<double>(i) / n));
  out.push_back(p3);
}

std::vector<Polyline> flatten(const Path& path, double tolerance) {
  std::vector<Polyline> out;
  forEachSegment(
      path,
      [&](Vec2 p) {
        out.push_back({});
        out.back().points.push_back(p);
      },
      [&](Verb v, Vec2 from, const Vec2* p) {
        auto& pts = out.back().points;
        if (v == Verb::Line) pts.push_back(p[0]);
        else if (v == Verb::Quad) flattenQuad(from, p[0], p[1], tolerance, pts);
        else flattenCubic(from, p[0], p[1], p[2], tolerance, pts);
      },
      [&](bool closed) {
        Polyline& pl = out.back();
        pl.closed = closed;
        if (closed && pl.points.size() > 1 && pl.points.front() == pl.points.back()) pl.points.pop_back();
      });
  return out;
}

void toQuads(const Path& path, double tolerance, std::vector<float>& out) {
  auto emit = [&](Vec2 a, Vec2 c, Vec2 b) {
    float q[6] = {static_cast<float>(a.x), static_cast<float>(a.y), static_cast<float>(c.x),
                  static_cast<float>(c.y), static_cast<float>(b.x), static_cast<float>(b.y)};
    out.insert(out.end(), q, q + 6);
  };
  // A line is a quadratic whose control point is its start: exactly straight in floats (a midpoint control
  // would round into a slightly bent curve).
  auto line = [&](Vec2 a, Vec2 b) {
    if (a == b) return;
    emit(a, a, b);
  };
  Vec2 start, cur;
  forEachSegment(
      path, [&](Vec2 p) { start = cur = p; },
      [&](Verb v, Vec2 from, const Vec2* p) {
        if (v == Verb::Line) {
          line(from, p[0]);
          cur = p[0];
        } else if (v == Verb::Quad) {
          emit(from, p[0], p[1]);
          cur = p[1];
        } else {
          Vec2 c[4] = {from, p[0], p[1], p[2]};
          Vec2 d = c[3] - c[2] * 3 + c[1] * 3 - c[0];
          double err = std::sqrt(3.0) / 36 * d.length();
          int n = std::clamp(static_cast<int>(std::ceil(std::cbrt(err / std::max(tolerance, 1e-9)))), 1, 64);
          for (int i = 0; i < n; i++) {
            Vec2 s[4];
            cubicSection(c, static_cast<double>(i) / n, static_cast<double>(i + 1) / n, s);
            Vec2 ctrl = ((s[1] + s[2]) * 3 - (s[0] + s[3])) * 0.25;
            emit(s[0], ctrl, s[3]);
          }
          cur = p[2];
        }
      },
      [&](bool closed) {
        if (!closed) line(cur, start);  // fills close every contour
      });
}

int windingAt(const std::vector<Polyline>& polys, Vec2 p) {
  int w = 0;
  for (const Polyline& pl : polys) {
    size_t n = pl.points.size();
    if (n < 2) continue;
    for (size_t i = 0; i < n; i++) {
      Vec2 a = pl.points[i], b = pl.points[(i + 1) % n];
      if (a.y <= p.y) {
        if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) w++;
      } else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) {
        w--;
      }
    }
  }
  return w;
}

bool contains(const std::vector<Polyline>& polys, Vec2 p, bool evenOdd) {
  int w = windingAt(polys, p);
  return evenOdd ? (w & 1) != 0 : w != 0;
}

double distanceTo(const std::vector<Polyline>& polys, Vec2 p) {
  double best = 1e300;
  for (const Polyline& pl : polys) {
    size_t n = pl.points.size();
    if (n == 1) best = std::min(best, (p - pl.points[0]).length());
    size_t edges = pl.closed ? n : (n ? n - 1 : 0);
    for (size_t i = 0; i < edges; i++) {
      Vec2 a = pl.points[i], b = pl.points[(i + 1) % n];
      Vec2 ab = b - a;
      double len2 = ab.x * ab.x + ab.y * ab.y;
      double t = len2 > 0 ? std::clamp(((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / len2, 0.0, 1.0) : 0;
      best = std::min(best, (p - (a + ab * t)).length());
    }
  }
  return best;
}

}  // namespace eng::geom
