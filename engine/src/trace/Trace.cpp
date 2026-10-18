#include "trace/Trace.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>

#include "trace/Potrace.h"

namespace eng::trace {

bool readOptions(const json::Value& v, Options& out) {
  if (!v.isObject()) return v.isNull();
  if (const json::Value* m = v.get("mode"); m && m->isString()) {
    if (m->string == "FULL_COLOR") out.mode = Mode::FULL_COLOR;
    else if (m->string == "GRAYSCALE") out.mode = Mode::GRAYSCALE;
    else if (m->string == "BLACK_AND_WHITE") out.mode = Mode::BLACK_AND_WHITE;
    else return false;
  }
  auto num = [&](const char* k, double def) {
    const json::Value* x = v.get(k);
    return x && x->isNumber() && std::isfinite(x->number) ? x->number : def;
  };
  out.colors = static_cast<int>(std::clamp(std::round(num("colors", out.colors)), 1.0, 32.0));
  out.grays = static_cast<int>(std::clamp(std::round(num("grays", out.grays)), 1.0, 16.0));
  out.threshold = std::clamp(num("threshold", out.threshold), 0.0, 100.0);
  out.speckle = static_cast<int>(std::clamp(std::round(num("speckle", out.speckle)), 0.0, 1000.0));
  out.alphaMax = std::clamp(num("alphaMax", out.alphaMax), 0.0, 4.0 / 3.0);
  out.optTolerance = std::clamp(num("optTolerance", out.optTolerance), 0.0, 1.0);
  return true;
}

Result trace(const uint8_t* rgba, int w, int h, const Options& opts, const Budget& budget) {
  auto t0 = std::chrono::steady_clock::now();
  Result r;
  r.width = w;
  r.height = h;
  if (w <= 0 || h <= 0 || !rgba) return r;
  Image img = fitToBudget(rgba, w, h);
  r.tracedWidth = img.w;
  r.tracedHeight = img.h;
  int k = opts.mode == Mode::FULL_COLOR ? opts.colors : opts.mode == Mode::GRAYSCALE ? opts.grays : 2;
  Palette pal = quantize(img, opts.mode, k, opts.threshold);
  despeckle(pal, opts.speckle);
  sortByArea(pal);

  Limits limits;
  limits.deadline = t0 + std::chrono::microseconds(static_cast<int64_t>(budget.timeLimitMs * 1000));
  limits.maxSegments = budget.maxSegments;
  TraceParams params;
  params.alphaMax = opts.alphaMax;
  params.optTolerance = opts.optTolerance;
  const double sx = static_cast<double>(w) / img.w, sy = static_cast<double>(h) / img.h;
  const Mat2x3 toOut{sx, 0, 0, 0, sy, 0};
  Mask mask;
  mask.w = img.w;
  mask.h = img.h;
  mask.px.resize(pal.labels.size());
  for (size_t i = 0; i < pal.colors.size(); i++) {
    // Stacked: this colour and every colour above it (smaller areas).
    for (size_t p = 0; p < pal.labels.size(); p++) mask.px[p] = pal.labels[p] != kNoLabel && pal.labels[p] >= i ? 1 : 0;
    Layer layer;
    layer.color = pal.colors[i];
    layer.area = static_cast<uint64_t>(std::llround(pal.area[i] * sx * sy));
    traceMask(mask, params, toOut, layer.path, limits);
    if (limits.exceeded) break;
    if (!layer.path.empty()) r.layers.push_back(std::move(layer));
  }
  r.segments = limits.segments;
  r.exceeded = limits.exceeded;
  if (r.exceeded) r.layers.clear();
  r.ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  return r;
}

std::string hexOf(const std::array<uint8_t, 3>& c) {
  char buf[8];
  std::snprintf(buf, sizeof buf, "#%02X%02X%02X", c[0], c[1], c[2]);
  return buf;
}

namespace {

void number(std::string& out, double v) {
  char buf[32];
  double r = std::round(v * 100) / 100;
  if (r == 0) r = 0;  // no "-0"
  int len = std::snprintf(buf, sizeof buf, "%.2f", r);
  // Trailing zeros and a bare point off.
  while (len > 0 && buf[len - 1] == '0') len--;
  if (len > 0 && buf[len - 1] == '.') len--;
  out.append(buf, static_cast<size_t>(len));
}

}  // namespace

std::string svgPathData(const geom::Path& p) {
  std::string out;
  size_t pi = 0;
  auto point = [&](Vec2 v) {
    out += ' ';
    number(out, v.x);
    out += ' ';
    number(out, v.y);
  };
  for (geom::Verb v : p.verbs) {
    if (!out.empty()) out += ' ';
    switch (v) {
      case geom::Verb::Move: out += 'M'; point(p.points[pi++]); break;
      case geom::Verb::Line: out += 'L'; point(p.points[pi++]); break;
      case geom::Verb::Quad:
        out += 'Q';
        point(p.points[pi]);
        point(p.points[pi + 1]);
        pi += 2;
        break;
      case geom::Verb::Cubic:
        out += 'C';
        point(p.points[pi]);
        point(p.points[pi + 1]);
        point(p.points[pi + 2]);
        pi += 3;
        break;
      case geom::Verb::Close: out += 'Z'; break;
    }
  }
  return out;
}

}  // namespace eng::trace
