#include "geometry/DynamicStroke.h"

#include <cmath>
#include <cstring>
#include <string>
#include <unordered_map>

#include "base/Json.h"
#include "geometry/Brush.h"
#include "geometry/NodeGeometry.h"
#include "scene/CodecKiwi.h"

namespace eng {

namespace geom {

namespace {

uint64_t splitmix(uint64_t x) {
  x += 0x9E3779B97F4A7C15ull;
  x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ull;
  x = (x ^ (x >> 27)) * 0x94D049BB133111EBull;
  return x ^ (x >> 31);
}

// A knot's value in [−1, 1]: a counter-based hash of (seed, contour, knot) — the same for the same inputs everywhere.
double knot(uint64_t seed, uint32_t contour, int64_t j) {
  uint64_t h = splitmix(seed ^ splitmix(static_cast<uint64_t>(contour) * 0xC2B2AE3D27D4EB4Full ^ static_cast<uint64_t>(j) * 0x165667B19E3779F9ull));
  return static_cast<double>(h >> 11) / static_cast<double>(1ull << 52) - 1.0;
}

double wavelength(double frequency) { return kDynWavelengthPx / std::clamp(frequency, 0.01, 20.0); }

}  // namespace

double dynamicWave(double s, double length, bool closed, double frequency, double smoothen, uint64_t seed, uint32_t contour) {
  double half = wavelength(frequency) / 2;
  double spacing = half;
  int64_t n = 0;
  if (closed) {
    // Knots evenly around the loop, so the end meets the start.
    n = std::max<int64_t>(3, std::llround(length / half));
    spacing = length / static_cast<double>(n);
  }
  auto u = [&](int64_t j) {
    if (closed) j = ((j % n) + n) % n;
    return knot(seed, contour, j);
  };
  double t = spacing > 0 ? s / spacing : 0;
  int64_t j = static_cast<int64_t>(std::floor(t));
  double f = t - static_cast<double>(j);
  double u0 = u(j - 1), u1 = u(j), u2 = u(j + 1), u3 = u(j + 2);
  double lin = u1 + (u2 - u1) * f;
  // Catmull-Rom (uniform): C¹ through the knots.
  double f2 = f * f, f3 = f2 * f;
  double cr = 0.5 * ((2 * u1) + (-u0 + u2) * f + (2 * u0 - 5 * u1 + 4 * u2 - u3) * f2 + (-u0 + 3 * u1 - 3 * u2 + u3) * f3);
  double k = std::clamp(smoothen, 0.0, 1.0);
  return lin * (1 - k) + cr * k;
}

Path dynamicCenterline(const Path& center, double weight, const DynamicSettings& s, uint64_t seed, double tolerance) {
  if (!(s.wiggle > 0) || !(weight > 0) || center.empty()) return center;
  Path out;
  double lambda = wavelength(s.frequency);
  double amp = kDynAmplitude * s.wiggle * weight;
  double smooth = std::clamp(s.smoothen, 0.0, 1.0);
  uint32_t contour = 0;
  for (const Polyline& pl : flatten(center, std::max(tolerance, 1e-4))) {
    std::vector<Vec2> pts = pl.points;
    bool closed = pl.closed;
    if (closed && pts.size() > 1 && pts.front() == pts.back()) pts.pop_back();
    uint32_t c = contour++;
    if (pts.size() < 2) continue;
    // Arc length along the contour (closed: back to the start).
    size_t m = pts.size();
    std::vector<double> at(m + 1, 0);
    for (size_t i = 1; i <= m; i++) {
      if (i == m && !closed) break;
      at[i] = at[i - 1] + (pts[i % m] - pts[i - 1]).length();
    }
    double L = closed ? at[m] : at[m - 1];
    if (!(L > 1e-9)) continue;
    auto pointAt = [&](double sAt) {
      size_t last = closed ? m : m - 1;
      sAt = std::clamp(sAt, 0.0, L);
      size_t i = static_cast<size_t>(std::upper_bound(at.begin(), at.begin() + static_cast<long>(last) + 1, sAt) - at.begin());
      i = std::clamp<size_t>(i, 1, last);
      double seg = at[i] - at[i - 1];
      double f = seg > 0 ? (sAt - at[i - 1]) / seg : 0;
      Vec2 a = pts[i - 1], b = pts[i % m];
      return a + (b - a) * f;
    };
    // Resampled evenly (a sixteenth of a wavelength, at most 20 000 samples a contour).
    double ds = std::max({std::min(lambda / 16, L / 8), L / 20000, 1e-3});
    size_t N = std::max<size_t>(closed ? 8 : 2, static_cast<size_t>(std::ceil(L / ds)));
    ds = L / static_cast<double>(N);
    size_t count = closed ? N : N + 1;
    std::vector<Vec2> q(count);
    for (size_t i = 0; i < count; i++) q[i] = pointAt(static_cast<double>(i) * ds);
    // Smoothen's low pass: a moving average over smoothen · λ/2 (open ends keep their place: the window shrinks there).
    size_t K = static_cast<size_t>(std::floor(smooth * lambda / 2 / ds / 2));
    if (K > 0) {
      std::vector<Vec2> sm(count);
      if (closed) {
        K = std::min(K, (count - 1) / 2);
        std::vector<Vec2> pre(3 * count + 1);
        for (size_t i = 0; i < 3 * count; i++) pre[i + 1] = pre[i] + q[i % count];
        for (size_t i = 0; i < count; i++) {
          size_t lo = i + count - K, hi = i + count + K + 1;
          sm[i] = (pre[hi] - pre[lo]) * (1.0 / static_cast<double>(2 * K + 1));
        }
      } else {
        std::vector<Vec2> pre(count + 1);
        for (size_t i = 0; i < count; i++) pre[i + 1] = pre[i] + q[i];
        for (size_t i = 0; i < count; i++) {
          size_t k = std::min({K, i, count - 1 - i});
          sm[i] = (pre[i + k + 1] - pre[i - k]) * (1.0 / static_cast<double>(2 * k + 1));
        }
      }
      q.swap(sm);
    }
    // Displaced along the normal.
    std::vector<Vec2> d(count);
    for (size_t i = 0; i < count; i++) {
      Vec2 a = closed ? q[(i + count - 1) % count] : q[i > 0 ? i - 1 : 0];
      Vec2 b = closed ? q[(i + 1) % count] : q[std::min(i + 1, count - 1)];
      Vec2 t = b - a;
      double len = t.length();
      Vec2 n = len > 0 ? Vec2{-t.y / len, t.x / len} : Vec2{0, 0};
      double w = dynamicWave(static_cast<double>(i) * ds, L, closed, s.frequency, smooth, seed, c);
      d[i] = q[i] + n * (amp * w);
    }
    out.moveTo(d[0]);
    for (size_t i = 1; i < count; i++) out.lineTo(d[i]);
    if (closed) out.close();
  }
  return out;
}

}  // namespace geom

namespace {

bool extraJsonOf(const NodeProps& p, const char* key, json::Value& out) {
  auto it = p.extra.find(key);
  if (it == p.extra.end() || it->second.empty()) return false;
  return json::parse(codec::extraValueToJson("NodeChange", it->second), out);
}

}  // namespace

bool dynamicSettingsOf(const NodeProps& p, geom::DynamicSettings& out) {
  if (p.extra.empty()) return false;
  auto it = p.extra.find("dynamicStrokeSettings");
  if (it == p.extra.end() || it->second.empty()) return false;
  if (strokeBrushOf(p) != kNoGuid) return false;  // a brush stroke draws its brush
  // Parsed once per distinct value; `dynamic` false for the neutral value.
  struct Entry {
    geom::DynamicSettings s;
    bool dynamic = true;
  };
  static std::unordered_map<std::string, Entry> cache;
  auto c = cache.find(it->second);
  if (c == cache.end()) {
    geom::DynamicSettings s;
    json::Value v;
    if (json::parse(codec::extraValueToJson("NodeChange", it->second), v) && v.isObject()) {
      if (const json::Value* x = v.get("frequency")) s.frequency = x->numberOr(s.frequency);
      if (const json::Value* x = v.get("wiggle")) s.wiggle = x->numberOr(s.wiggle);
      if (const json::Value* x = v.get("smoothen")) s.smoothen = x->numberOr(s.smoothen);
    }
    Entry e;
    e.dynamic = !geom::isNeutralDynamic(s);
    // The plugin API's ranges (src/shared/draw/types.ts DYNAMIC_RANGE); wiggle has no upper bound there.
    s.frequency = std::clamp(s.frequency, 0.01, 20.0);
    s.wiggle = std::clamp(s.wiggle, 0.0, geom::kDynWiggleCap);
    s.smoothen = std::clamp(s.smoothen, 0.0, 1.0);
    e.s = s;
    if (cache.size() > 1024) cache.clear();
    c = cache.emplace(it->second, e).first;
  }
  if (!c->second.dynamic) return false;
  out = c->second.s;
  return true;
}

bool hasDynamicStroke(const NodeProps& p) {
  geom::DynamicSettings s;
  return dynamicSettingsOf(p, s);
}

uint64_t strokeSeedOf(const NodeProps& p) {
  json::Value v;
  if (!extraJsonOf(p, "strokeSeed", v)) return 0;
  if (v.isNumber()) return static_cast<uint64_t>(v.number);
  if (v.isString()) return std::strtoull(v.string.c_str(), nullptr, 10);
  return 0;
}

bool dynamicCenter(const NodeProps& p, const NodeGeometry& g, double tolerance, geom::Path& out, uint64_t* key) {
  geom::DynamicSettings s;
  if (!dynamicSettingsOf(p, s) || g.stroke.path.empty()) return false;
  uint64_t seed = strokeSeedOf(p);
  // The cache's key: the centre line, the settings, the seed, the weight and the tolerance's power of two.
  uint64_t h = g.strokeKey * 1099511628211ull ^ 0xD1A0ull;
  auto mix = [&](double v) {
    uint64_t b = 0;
    std::memcpy(&b, &v, sizeof b);
    h = (h ^ b) * 1099511628211ull;
  };
  mix(s.frequency), mix(s.wiggle), mix(s.smoothen), mix(p.strokeWeight), mix(std::floor(std::log2(std::max(tolerance, 1e-6))));
  h = (h ^ seed) * 1099511628211ull;
  if (key) *key = h;
  static std::unordered_map<uint64_t, geom::Path> cache;
  if (auto it = cache.find(h); it != cache.end()) {
    out = it->second;
    return true;
  }
  if (cache.size() > 256) cache.clear();
  out = geom::dynamicCenterline(g.stroke.path, p.strokeWeight, s, seed, tolerance);
  cache[h] = out;
  return true;
}

}  // namespace eng
