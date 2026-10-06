// Helpers for the geometry and vector tests: Figma's sample documents with
// their blobs (engine/tools/fixtures.mjs → *.full.json), and area / coverage
// measurements of paths by sampling.
#pragma once

#include <cmath>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "base/Json.h"
#include "geometry/Path.h"
#include "scene/CodecJson.h"

namespace eng::test {

inline std::string readFile(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  std::stringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

// A Figma sample as the engine reads it: every node, blobs resolved.
inline std::vector<NodeChange> figmaSample(const std::string& name) {
  json::Value v;
  json::parse(readFile(std::string(ENG_TEST_DATA) + "/figma/" + name + ".full.json"), v);
  return codec::readMessage(v);
}

// The raw JSON of a sample (Figma's derived fields, e.g. fillGeometry, included).
inline json::Value figmaSampleJson(const std::string& name) {
  json::Value v;
  json::parse(readFile(std::string(ENG_TEST_DATA) + "/figma/" + name + ".full.json"), v);
  return v;
}

inline const NodeChange* byName(const std::vector<NodeChange>& nodes, const std::string& name, size_t nth = 0) {
  for (auto& n : nodes)
    if (n.props.name == name && nth-- == 0) return &n;
  return nullptr;
}

// The area inside `path` under a fill rule, by sampling a grid of `step` over its bounds.
inline double sampledArea(const geom::Path& path, bool evenOdd, double step) {
  Rect b = path.bounds();
  auto polys = geom::flatten(path, step * 0.05);
  double area = 0;
  for (double y = b.y + step / 2; y < b.bottom(); y += step)
    for (double x = b.x + step / 2; x < b.right(); x += step)
      if (geom::contains(polys, {x, y}, evenOdd)) area += step * step;
  return area;
}

// The share of a grid's samples on which two paths disagree (0 = the same shape).
inline double mismatch(const geom::Path& a, bool evenOddA, const geom::Path& b, bool evenOddB, double step) {
  Rect r = a.bounds().united(b.bounds());
  auto pa = geom::flatten(a, step * 0.05), pb = geom::flatten(b, step * 0.05);
  double total = 0, diff = 0;
  for (double y = r.y + step / 2; y < r.bottom(); y += step)
    for (double x = r.x + step / 2; x < r.right(); x += step) {
      bool ia = geom::contains(pa, {x, y}, evenOddA), ib = geom::contains(pb, {x, y}, evenOddB);
      if (ia || ib) total++;
      if (ia != ib) diff++;
    }
  return total > 0 ? diff / total : 0;
}

inline size_t countVerb(const geom::Path& p, geom::Verb v) {
  size_t n = 0;
  for (auto x : p.verbs) n += x == v;
  return n;
}

}  // namespace eng::test
