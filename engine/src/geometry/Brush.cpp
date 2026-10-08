#include "geometry/Brush.h"

#include <algorithm>
#include <cmath>

#include "base/Json.h"
#include "geometry/NodeGeometry.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"
#include "scene/Document.h"

namespace eng::geom {

namespace {

// A contour by arc length: where a distance along it lands, and which way it goes there.
struct Walk {
  std::vector<Vec2> pts;
  std::vector<double> at;  // cumulative length at each point
  double length() const { return at.empty() ? 0 : at.back(); }
  explicit Walk(const Polyline& p) : pts(p.points) {
    if (p.closed && !pts.empty() && !(pts.front() == pts.back())) pts.push_back(pts.front());
    at.resize(pts.size(), 0);
    for (size_t i = 1; i < pts.size(); i++) at[i] = at[i - 1] + (pts[i] - pts[i - 1]).length();
  }
  void sample(double s, Vec2& pos, Vec2& dir) const {
    if (pts.size() < 2) {
      pos = pts.empty() ? Vec2{} : pts[0];
      dir = {1, 0};
      return;
    }
    s = std::clamp(s, 0.0, length());
    size_t i = static_cast<size_t>(std::upper_bound(at.begin(), at.end(), s) - at.begin());
    i = std::clamp<size_t>(i, 1, pts.size() - 1);
    double seg = at[i] - at[i - 1];
    double f = seg > 0 ? (s - at[i - 1]) / seg : 0;
    pos = pts[i - 1] + (pts[i] - pts[i - 1]) * f;
    Vec2 d = pts[i] - pts[i - 1];
    double len = d.length();
    dir = len > 0 ? d * (1 / len) : Vec2{1, 0};
  }
};

// Deterministic jitter (Figma seeds its brushes with strokeSeed).
struct Rng {
  uint64_t s;
  explicit Rng(uint64_t seed) : s(seed ? seed : 0x9E3779B97F4A7C15ull) {}
  double next() {  // [0, 1)
    s ^= s << 13;
    s ^= s >> 7;
    s ^= s << 17;
    return static_cast<double>(s >> 11) / static_cast<double>(1ull << 53);
  }
};

}  // namespace

Path stretchBrush(const Path& center, const Path& artwork, Vec2 box, double weight, bool reverse, double tolerance) {
  Path out;
  if (box.x <= 0 || box.y <= 0 || artwork.empty()) return out;
  double tol = std::max(tolerance, 1e-3);
  std::vector<Polyline> art = flatten(artwork, tol * box.y / std::max(weight, 1e-6));
  for (const Polyline& contour : flatten(center, tol)) {
    Walk w(contour);
    double L = w.length();
    if (L <= 0) continue;
    // Artwork edges cut so a piece covers at most ~2 units of the path: the bend follows the curve.
    double maxU = std::max(1e-4, 2.0 / L);
    auto map = [&](Vec2 a) {
      double u = a.x / box.x;
      if (reverse) u = 1 - u;
      Vec2 pos, dir;
      w.sample(u * L, pos, dir);
      Vec2 normal{-dir.y, dir.x};
      double across = (a.y - box.y / 2) / box.y * weight * (reverse ? -1 : 1);
      return pos + normal * across;
    };
    for (const Polyline& a : art) {
      if (a.points.size() < 2) continue;
      out.moveTo(map(a.points[0]));
      size_t n = a.points.size();
      for (size_t i = 1; i <= n; i++) {
        if (i == n && !a.closed) break;
        Vec2 p0 = a.points[i - 1], p1 = a.points[i % n];
        int steps = std::max(1, static_cast<int>(std::ceil(std::fabs(p1.x - p0.x) / box.x / maxU)));
        for (int k = 1; k <= steps; k++) out.lineTo(map(p0 + (p1 - p0) * (static_cast<double>(k) / steps)));
      }
      out.close();
    }
  }
  return out;
}

Path scatterBrush(const Path& center, const Path& artwork, Vec2 box, double weight, const ScatterSettings& s, uint64_t seed,
                  double tolerance) {
  Path out;
  if (box.x <= 0 || box.y <= 0 || artwork.empty() || weight <= 0) return out;
  double k = weight / box.y;  // the artwork at the stroke's weight
  double stamp = box.x * k;
  double spacing = std::max(0.25, s.gap) * stamp;
  Rng rng(seed);
  for (const Polyline& contour : flatten(center, std::max(tolerance, 1e-3))) {
    Walk w(contour);
    double L = w.length();
    if (L <= 0) continue;
    for (double t = stamp / 2; t <= L + 1e-6 && t < 1e7; t += spacing) {
      Vec2 pos, dir;
      w.sample(t, pos, dir);
      double size = std::max(0.1, 1 + s.sizeJitter * (rng.next() - 0.5));
      double angle = std::atan2(dir.y, dir.x) + (s.rotation + s.angularJitter * (2 * rng.next() - 1)) * M_PI / 180;
      double off = s.wiggle * (2 * rng.next() - 1) * weight;
      Vec2 at = pos + Vec2{-dir.y, dir.x} * off;
      Mat2x3 m = Mat2x3::translate(at.x, at.y) * Mat2x3::rotate(angle) * Mat2x3::scale(k * size) *
                 Mat2x3::translate(-box.x / 2, -box.y / 2);
      out.append(artwork.transformed(m));
    }
  }
  return out;
}

Path scatterAt(const Path& artwork, const std::vector<Mat2x3>& transforms) {
  Path out;
  for (const Mat2x3& m : transforms) out.append(artwork.transformed(m));
  return out;
}

}  // namespace eng::geom

namespace eng {

namespace {

bool extraJson(const NodeProps& p, const char* key, json::Value& out) {
  auto it = p.extra.find(key);
  if (it == p.extra.end() || it->second.empty()) return false;
  return json::parse(codec::extraValueToJson("NodeChange", it->second), out);
}

}  // namespace

Guid strokeBrushOf(const NodeProps& p) {
  json::Value v;
  if (!extraJson(p, "strokeBrushGuid", v)) return kNoGuid;
  Guid g = kNoGuid;
  if (v.isObject() && v.get("sessionID") && v.get("localID"))
    g = Guid{static_cast<uint32_t>(v.get("sessionID")->numberOr(0)), static_cast<uint32_t>(v.get("localID")->numberOr(0))};
  else codec::readGuid(v, g);
  return g;
}

bool brushStroke(const Document& doc, const NodeProps& p, const NodeGeometry& g, double tolerance, geom::Path& out, uint64_t* key) {
  if (p.extra.empty() || p.strokeWeight <= 0) return false;
  Guid brush = strokeBrushOf(p);
  if (brush == kNoGuid) return false;
  const Node* bn = doc.get(brush);
  if (!bn || bn->props.type != NodeType::BRUSH) return false;
  const NodeGeometry* bg = doc.geometry(brush);
  if (!bg || bg->fills.empty()) return false;
  geom::Path art;
  for (const auto& f : bg->fills) art.append(f.path);
  Vec2 box = bn->props.size;
  // The stroked node's own settings, else the brush's defaults.
  json::Value type, scatter, stretch, seed, transforms;
  bool isScatter = (extraJson(p, "brushType", type) || extraJson(bn->props, "brushType", type)) && type.isString() && type.string == "SCATTER";
  if (key) {
    uint64_t h = g.strokeKey * 1099511628211ull ^ static_cast<uint64_t>(brush.sessionID) << 32 ^ brush.localID;
    h = h * 31 + bg->fillKey;
    for (const char* k : {"brushType", "scatterStrokeSettings", "stretchStrokeSettings", "strokeSeed", "scatterBrushTransforms"}) {
      auto it = p.extra.find(k);
      if (it != p.extra.end()) h = h * 1315423911ull + std::hash<std::string>()(it->second);
    }
    *key = h;
  }
  if (!isScatter) {
    bool reverse = false;
    if (extraJson(p, "stretchStrokeSettings", stretch) || extraJson(bn->props, "stretchStrokeSettings", stretch))
      if (const json::Value* o = stretch.get("orientation")) reverse = o->isString() && o->string == "REVERSE";
    out = geom::stretchBrush(g.stroke.path, art, box, p.strokeWeight, reverse, tolerance);
    return true;
  }
  // Figma's own stamps when it stored them; else laid out here.
  if (extraJson(p, "scatterBrushTransforms", transforms) && transforms.isArray() && !transforms.array.empty()) {
    std::vector<Mat2x3> ms;
    for (const json::Value& m : transforms.array)
      ms.push_back(Mat2x3{m.get("m00") ? m.get("m00")->numberOr(1) : 1, m.get("m01") ? m.get("m01")->numberOr(0) : 0,
                          m.get("m02") ? m.get("m02")->numberOr(0) : 0, m.get("m10") ? m.get("m10")->numberOr(0) : 0,
                          m.get("m11") ? m.get("m11")->numberOr(1) : 1, m.get("m12") ? m.get("m12")->numberOr(0) : 0});
    out = geom::scatterAt(art, ms);
    return true;
  }
  geom::ScatterSettings s;
  if (extraJson(p, "scatterStrokeSettings", scatter) || extraJson(bn->props, "scatterStrokeSettings", scatter)) {
    auto num = [&](const char* k, double& v) {
      if (const json::Value* x = scatter.get(k)) v = x->numberOr(v);
    };
    num("gap", s.gap);
    num("wiggle", s.wiggle);
    num("angularJitter", s.angularJitter);
    num("rotation", s.rotation);
    num("sizeJitter", s.sizeJitter);
  }
  uint64_t sd = 0;
  if (extraJson(p, "strokeSeed", seed)) sd = static_cast<uint64_t>(seed.numberOr(0));
  out = geom::scatterBrush(g.stroke.path, art, box, p.strokeWeight, s, sd, tolerance);
  return true;
}

}  // namespace eng
