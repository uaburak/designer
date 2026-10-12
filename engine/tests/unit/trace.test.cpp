// Vectorize (docs/ai.md §5): Potrace's method on synthetic bitmaps (a square, a disk, a ring within 0.5 px of their
// analytic outlines), the palette (k-means determinism, the threshold's extremes, speckle merging), stacking (no
// uncovered opaque pixel), the limits, and the C ABI (engine_trace; begin / update / end with commit, undo and cancel).
#include <chrono>
#include <cmath>
#include <cstring>
#include <functional>
#include <string>
#include <vector>

#include "base/Json.h"
#include "doctest.h"
#include "geometry/Path.h"
#include "scene/CodecKiwi.h"
#include "trace/Potrace.h"
#include "trace/Quantize.h"
#include "trace/Trace.h"

using namespace eng;
using namespace eng::trace;

using Ptr = uintptr_t;
using Handle = uintptr_t;

extern "C" {
Ptr engine_result_ptr();
uint32_t engine_result_len();
Handle engine_create(const char* selector, Ptr optsPtr, uint32_t optsLen);
void engine_destroy(Handle h);
int32_t engine_load(Handle h, Ptr ptr, uint32_t len);
int32_t engine_read_nodes(Handle h, Ptr ptr, uint32_t len, uint32_t flags);
int32_t engine_encode_document(Handle h, uint32_t flags);
int32_t engine_command(Handle h, uint32_t commandId, Ptr argsPtr, uint32_t argsLen);
int32_t engine_get_selection(Handle h);
int32_t engine_take_events(Handle h);
int32_t engine_trace(Ptr rgbaPtr, uint32_t len, uint32_t w, uint32_t h, Ptr optsPtr, uint32_t optsLen);
int32_t engine_vectorize_begin(Handle h, Ptr refsPtr, uint32_t refsLen, Ptr rgbaPtr, uint32_t len, uint32_t width, uint32_t height);
int32_t engine_vectorize_update(Handle h, Ptr optsPtr, uint32_t optsLen);
int32_t engine_vectorize_end(Handle h, uint32_t commit);
}

namespace {

using Pixel = std::array<uint8_t, 4>;

Image makeImage(int w, int h, const std::function<Pixel(int, int)>& f) {
  Image img;
  img.w = w;
  img.h = h;
  img.rgba.resize(static_cast<size_t>(w) * h * 4);
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) {
      Pixel p = f(x, y);
      std::memcpy(img.rgba.data() + (static_cast<size_t>(y) * w + x) * 4, p.data(), 4);
    }
  return img;
}

constexpr Pixel kClear{0, 0, 0, 0}, kBlack{0, 0, 0, 255}, kWhite{255, 255, 255, 255};

Result traced(const Image& img, Options opts = {}, Budget budget = {}) { return trace::trace(img.rgba.data(), img.w, img.h, opts, budget); }

std::vector<Vec2> outlinePoints(const geom::Path& p) {
  std::vector<Vec2> out;
  for (auto& poly : geom::flatten(p, 0.02))
    for (Vec2 v : poly.points) out.push_back(v);
  return out;
}

double pathArea(const geom::Path& p) {
  double a = 0;
  for (auto& poly : geom::flatten(p, 0.02)) {
    double s = 0;
    for (size_t i = 0; i < poly.points.size(); i++) {
      Vec2 u = poly.points[i], v = poly.points[(i + 1) % poly.points.size()];
      s += u.x * v.y - v.x * u.y;
    }
    a += s / 2;
  }
  return a;
}

size_t contourCount(const geom::Path& p) { return static_cast<size_t>(std::count(p.verbs.begin(), p.verbs.end(), geom::Verb::Move)); }

// Which layer is on top at each pixel centre (−1: none), from the layers' outlines (even-odd).
std::vector<int> topLayers(const Result& r) {
  std::vector<int> top(static_cast<size_t>(r.width) * r.height, -1);
  for (size_t i = 0; i < r.layers.size(); i++) {
    auto polys = geom::flatten(r.layers[i].path, 0.05);
    for (int y = 0; y < r.height; y++)
      for (int x = 0; x < r.width; x++)
        if (geom::contains(polys, {x + 0.5, y + 0.5}, true)) top[static_cast<size_t>(y) * r.width + x] = static_cast<int>(i);
  }
  return top;
}

// Share of opaque pixels some layer covers.
double coverage(const Image& img, const Result& r) {
  std::vector<int> top = topLayers(r);
  size_t opaque = 0, covered = 0;
  for (size_t i = 0; i < top.size(); i++) {
    if (img.rgba[i * 4 + 3] < kAlphaCutoff) continue;
    opaque++;
    covered += top[i] >= 0;
  }
  return opaque ? static_cast<double>(covered) / opaque : 1.0;
}

// A deterministic "photo": smooth colour fields with noise.
Image photo(int w, int h) {
  uint32_t s = 12345;
  return makeImage(w, h, [&](int x, int y) {
    s = s * 1664525u + 1013904223u;
    int n = static_cast<int>((s >> 24) % 24) - 12;
    double fx = static_cast<double>(x) / w, fy = static_cast<double>(y) / h;
    auto c = [&](double v) { return static_cast<uint8_t>(std::clamp(v * 255 + n, 0.0, 255.0)); };
    return Pixel{c(0.5 + 0.5 * std::sin(fx * 7 + fy * 3)), c(0.5 + 0.5 * std::cos(fy * 9 - fx * 2)), c(fx * fy), 255};
  });
}

}  // namespace

TEST_CASE("trace: a square comes out within 0.5 px of its outline, corners kept") {
  Image img = makeImage(64, 64, [](int x, int y) { return x >= 16 && x < 48 && y >= 10 && y < 50 ? kBlack : kClear; });
  Result r = traced(img);
  REQUIRE(r.layers.size() == 1);
  CHECK(hexOf(r.layers[0].color) == "#000000");
  CHECK(contourCount(r.layers[0].path) == 1);
  for (Vec2 p : outlinePoints(r.layers[0].path)) {
    double d = std::min({std::abs(p.x - 16), std::abs(p.x - 48), std::abs(p.y - 10), std::abs(p.y - 50)});
    CHECK(d <= 0.5);
    CHECK(p.x >= 15.5);
    CHECK(p.x <= 48.5);
  }
  Rect b = r.layers[0].path.bounds();
  CHECK(b.x == doctest::Approx(16).epsilon(0.01));
  CHECK(b.y == doctest::Approx(10).epsilon(0.01));
  CHECK(b.w == doctest::Approx(32).epsilon(0.01));
  CHECK(b.h == doctest::Approx(40).epsilon(0.01));
  CHECK(std::abs(pathArea(r.layers[0].path)) == doctest::Approx(32 * 40).epsilon(0.005));
}

TEST_CASE("trace: a disk and a ring (a hole) come out within 0.5 px of their circles") {
  const double cx = 40, cy = 40;
  auto in = [&](int x, int y, double rr) { return std::hypot(x + 0.5 - cx, y + 0.5 - cy) <= rr; };
  {
    const double R = 28;
    Image img = makeImage(80, 80, [&](int x, int y) { return in(x, y, R) ? kBlack : kWhite; });
    Options o;
    o.mode = Mode::BLACK_AND_WHITE;
    Result r = traced(img, o);
    REQUIRE(r.layers.size() == 2);  // white (more area) at the bottom, black above
    CHECK(hexOf(r.layers[0].color) == "#FFFFFF");
    CHECK(hexOf(r.layers[1].color) == "#000000");
    const geom::Path& disk = r.layers[1].path;
    CHECK(contourCount(disk) == 1);
    double worst = 0;
    for (Vec2 p : outlinePoints(disk)) worst = std::max(worst, std::abs(std::hypot(p.x - cx, p.y - cy) - R));
    CHECK(worst <= 0.5);
    CHECK(std::abs(pathArea(disk)) == doctest::Approx(3.14159265 * R * R).epsilon(0.01));
    // A circle is curves, not a polygon of steps: few segments.
    CHECK(disk.verbs.size() < 40);
  }
  {
    const double R1 = 30, R0 = 14;
    Image img = makeImage(80, 80, [&](int x, int y) { return in(x, y, R1) && !in(x, y, R0) ? kBlack : kClear; });
    Result r = traced(img);
    REQUIRE(r.layers.size() == 1);
    const geom::Path& ring = r.layers[0].path;
    CHECK(contourCount(ring) == 2);
    double worst = 0;
    for (Vec2 p : outlinePoints(ring)) {
      double d = std::hypot(p.x - cx, p.y - cy);
      worst = std::max(worst, std::min(std::abs(d - R1), std::abs(d - R0)));
    }
    CHECK(worst <= 0.5);
    auto polys = geom::flatten(ring, 0.05);
    CHECK_FALSE(geom::contains(polys, {cx, cy}, true));       // the hole
    CHECK(geom::contains(polys, {cx + 22, cy}, true));         // the ring
    CHECK(std::abs(pathArea(ring)) == doctest::Approx(3.14159265 * (R1 * R1 - R0 * R0)).epsilon(0.015));
  }
}

TEST_CASE("trace: path decomposition — outlines clockwise, holes the other way; diagonals by the minority policy") {
  Mask m;
  m.w = 5;
  m.h = 5;
  m.px.assign(25, 0);
  for (int y = 0; y < 5; y++)
    for (int x = 0; x < 5; x++) m.px[y * 5 + x] = x == 0 || y == 0 || x == 4 || y == 4;
  auto cs = decompose(m);
  REQUIRE(cs.size() == 2);
  CHECK(cs[0].area == 25);
  CHECK(cs[1].area == -9);
  // Two pixels touching at a corner, alone: they are the minority, so they join (one contour of 8 edges).
  Mask d;
  d.w = 4;
  d.h = 4;
  d.px.assign(16, 0);
  d.px[1 * 4 + 1] = 1;
  d.px[2 * 4 + 2] = 1;
  auto ds = decompose(d);
  REQUIRE(ds.size() == 1);
  CHECK(ds[0].points.size() == 8);
  // Inverted (two holes touching at a corner in a set field): the unset pixels are the minority and join.
  for (auto& p : d.px) p = !p;
  ds = decompose(d);
  REQUIRE(ds.size() == 2);
  CHECK(ds[0].area == 16);
  CHECK(ds[1].area == -2);
}

TEST_CASE("trace: two-colour stripes stack with no gaps") {
  Image img = makeImage(96, 64, [](int x, int) { return (x / 12) % 2 ? Pixel{0, 0, 255, 255} : Pixel{255, 0, 0, 255}; });
  Options o;
  o.colors = 2;
  Result r = traced(img, o);
  REQUIRE(r.layers.size() == 2);
  CHECK(hexOf(r.layers[0].color) == "#0000FF");  // 4 stripes each: equal areas, the darker (blue) at the bottom
  CHECK(hexOf(r.layers[1].color) == "#FF0000");
  // The bottom layer is the whole image; the top one the blue stripes.
  CHECK(contourCount(r.layers[0].path) == 1);
  CHECK(contourCount(r.layers[1].path) == 4);  // the red stripes
  Rect b = r.layers[0].path.bounds();
  CHECK(b.w == doctest::Approx(96));
  CHECK(b.h == doctest::Approx(64));
  std::vector<int> top = topLayers(r);
  size_t right = 0;
  for (int y = 0; y < 64; y++)
    for (int x = 0; x < 96; x++) right += top[static_cast<size_t>(y) * 96 + x] == ((x / 12) % 2 ? 0 : 1);
  CHECK(static_cast<double>(right) / (96 * 64) >= 0.995);
  CHECK(coverage(img, r) == 1.0);
}

TEST_CASE("trace: a gradient quantized — grays and colours, stacked with no gaps") {
  Image img = makeImage(128, 48, [](int x, int) {
    auto v = static_cast<uint8_t>(x * 2);
    return Pixel{v, v, v, 255};
  });
  Options g;
  g.mode = Mode::GRAYSCALE;
  g.grays = 4;
  Result r = traced(img, g);
  REQUIRE(r.layers.size() == 4);
  for (auto& l : r.layers) CHECK((l.color[0] == l.color[1] && l.color[1] == l.color[2]));
  CHECK(coverage(img, r) >= 0.995);

  Image colour = makeImage(128, 96, [](int x, int y) { return Pixel{static_cast<uint8_t>(x * 2), static_cast<uint8_t>(y * 2), 128, 255}; });
  Options c;
  c.colors = 8;
  Result rc = traced(colour, c);
  CHECK(rc.layers.size() <= 8);
  CHECK(rc.layers.size() >= 6);
  CHECK(coverage(colour, rc) >= 0.995);
  // The bottom layer is the whole opaque area.
  CHECK(std::abs(pathArea(rc.layers[0].path)) == doctest::Approx(128 * 96).epsilon(0.002));
}

TEST_CASE("trace: k-means is deterministic") {
  Image img = photo(160, 120);
  Palette a = quantize(img, Mode::FULL_COLOR, 8, 50), b = quantize(img, Mode::FULL_COLOR, 8, 50);
  CHECK(a.labels == b.labels);
  CHECK(a.colors == b.colors);
  CHECK(a.colors.size() == 8);
  Options o;
  Result r1 = traced(img, o), r2 = traced(img, o);
  REQUIRE(r1.layers.size() == r2.layers.size());
  for (size_t i = 0; i < r1.layers.size(); i++) CHECK(svgPathData(r1.layers[i].path) == svgPathData(r2.layers[i].path));
  CHECK(coverage(img, r1) >= 0.995);
}

TEST_CASE("trace: the threshold's extremes") {
  Image img = makeImage(32, 32, [](int x, int) {
    auto v = static_cast<uint8_t>(x * 8);  // 0 … 248: no pure white
    return Pixel{v, v, v, 255};
  });
  Options o;
  o.mode = Mode::BLACK_AND_WHITE;
  o.threshold = 0;
  Result r = traced(img, o);
  REQUIRE(r.layers.size() == 1);
  CHECK(hexOf(r.layers[0].color) == "#FFFFFF");
  o.threshold = 100;
  r = traced(img, o);
  REQUIRE(r.layers.size() == 1);
  CHECK(hexOf(r.layers[0].color) == "#000000");
  o.threshold = 50;  // luminance < 127.5: x < 16
  r = traced(img, o);
  REQUIRE(r.layers.size() == 2);
  CHECK(r.layers[0].area == r.layers[1].area);
}

TEST_CASE("trace: specks merge into their largest neighbour") {
  Image img = makeImage(64, 64, [](int x, int y) {
    if (x >= 20 && x < 40 && y >= 20 && y < 40) return kBlack;
    if ((x == 5 && y == 5) || (x == 50 && y == 9) || (x == 9 && y >= 50 && y <= 51)) return kBlack;  // 1, 1 and 2 px
    return kWhite;
  });
  Options o;
  o.mode = Mode::BLACK_AND_WHITE;
  o.speckle = 4;
  Result r = traced(img, o);
  REQUIRE(r.layers.size() == 2);
  CHECK(contourCount(r.layers[1].path) == 1);
  CHECK(r.layers[1].area == 400);
  o.speckle = 0;
  r = traced(img, o);
  CHECK(contourCount(r.layers[1].path) == 4);  // the red stripes
}

TEST_CASE("trace: limits — the pixel budget, the segment cap, node counts") {
  // A large input is traced at ≤ 1024 px; the paths are in the input's pixels.
  Image big = makeImage(2048, 512, [](int x, int y) { return x >= 512 && x < 1536 && y >= 128 && y < 384 ? kBlack : kClear; });
  Result r = traced(big);
  CHECK(r.tracedWidth == 1024);
  CHECK(r.tracedHeight == 256);
  REQUIRE(r.layers.size() == 1);
  Rect b = r.layers[0].path.bounds();
  CHECK(b.x == doctest::Approx(512).epsilon(0.01));
  CHECK(b.w == doctest::Approx(1024).epsilon(0.01));
  CHECK(r.layers[0].area == 1024 * 256);

  // Noise with 32 colours: at most 32 layers; a tight segment cap stops the trace instead of a partial result.
  Image noise = photo(200, 200);
  Options o;
  o.colors = 32;
  o.speckle = 0;
  Result full = traced(noise, o);
  CHECK(full.layers.size() <= 32);
  CHECK_FALSE(full.exceeded);
  CHECK(full.segments < 200000);
  Budget tight;
  tight.maxSegments = 100;
  Result capped = traced(noise, o, tight);
  CHECK(capped.exceeded);
  CHECK(capped.layers.empty());
}

TEST_CASE("trace: bench — a 512² photo, 8 colours (informational: the budget's 1024² case runs in vectorize.wasm.test.ts)") {
  Image img = photo(512, 512);
  Result r = traced(img, Options{}, Budget{60000, 2000000});
  MESSAGE("512² 8 colours: " << r.ms << " ms, " << r.layers.size() << " layers, " << r.segments << " segments");
  CHECK_FALSE(r.exceeded);
  CHECK(r.layers.size() == 8);
}

// ---- The C ABI ----------------------------------------------------------------------------------------------

namespace {

std::string result() { return std::string(reinterpret_cast<const char*>(engine_result_ptr()), engine_result_len()); }

json::Value resultJson() {
  json::Value v;
  REQUIRE(json::parse(result(), v));
  return v;
}

Ptr ptrOf(const std::string& s) { return reinterpret_cast<Ptr>(s.data()); }
uint32_t lenOf(const std::string& s) { return static_cast<uint32_t>(s.size()); }

const char* kDoc = R"({"type":"NODE_CHANGES","sessionID":0,"nodeChanges":[
  {"guid":"0:0","phase":"CREATED","type":"DOCUMENT","name":"Document"},
  {"guid":"0:1","phase":"CREATED","type":"CANVAS","name":"Page 1","parentIndex":{"guid":"0:0","position":"!"}},
  {"guid":"0:2","phase":"CREATED","type":"CANVAS","name":"Internal Only Canvas","internalOnly":true,"visible":false,"parentIndex":{"guid":"0:0","position":"~"}},
  {"guid":"1:2","phase":"CREATED","type":"ROUNDED_RECTANGLE","name":"Photo","parentIndex":{"guid":"0:1","position":"!"},
   "size":{"x":160,"y":160},"transform":{"m00":1,"m01":0,"m02":10,"m10":0,"m11":1,"m12":20},
   "fillPaints":[{"type":"SOLID","color":{"r":0.85,"g":0.85,"b":0.85,"a":1}}]},
  {"guid":"1:3","phase":"CREATED","type":"ROUNDED_RECTANGLE","name":"Above","parentIndex":{"guid":"0:1","position":"U"},
   "size":{"x":10,"y":10}}
]})";

std::string kiwiOf(const char* jsonMessage) {
  json::Value v;
  REQUIRE(json::parse(jsonMessage, v));
  return codec::writeMessage(0, codec::readMessage(v));
}

std::vector<std::string> guids(Handle h) {
  REQUIRE(engine_encode_document(h, 0) == 0);
  std::vector<std::string> out;
  json::Value v = resultJson();
  for (auto& c : v.get("nodeChanges")->array) out.push_back(c.get("guid")->string);
  return out;
}

bool has(Handle h, const std::string& id) {
  auto all = guids(h);
  return std::find(all.begin(), all.end(), id) != all.end();
}

json::Value node(Handle h, const std::string& id) {
  std::string refs = "{\"refs\":[\"" + id + "\"]}";
  REQUIRE(engine_read_nodes(h, ptrOf(refs), lenOf(refs), 1) == 0);
  json::Value v = resultJson();
  REQUIRE(v.get("nodeChanges")->array.size() == 1);
  return v.get("nodeChanges")->array[0];
}

}  // namespace

TEST_CASE("trace: engine_trace — a TraceResult") {
  Image img = makeImage(40, 30, [](int x, int y) { return x >= 10 && x < 30 && y >= 5 && y < 25 ? kBlack : kWhite; });
  std::string opts = R"({"mode":"BLACK_AND_WHITE","threshold":50})";
  REQUIRE(engine_trace(reinterpret_cast<Ptr>(img.rgba.data()), static_cast<uint32_t>(img.rgba.size()), 40, 30, ptrOf(opts), lenOf(opts)) == 0);
  json::Value v = resultJson();
  CHECK(v.get("width")->number == 40);
  CHECK(v.get("height")->number == 30);
  auto& layers = v.get("layers")->array;
  REQUIRE(layers.size() == 2);
  CHECK(layers[0].get("color")->string == "#FFFFFF");
  CHECK(layers[0].get("area")->number == 800);
  CHECK(layers[1].get("color")->string == "#000000");
  CHECK(layers[1].get("area")->number == 400);
  CHECK(layers[1].get("d")->string == "M 10 5 L 30 5 L 30 25 L 10 25 Z");
  // Bad sizes and modes.
  CHECK(engine_trace(reinterpret_cast<Ptr>(img.rgba.data()), 100, 40, 30, 0, 0) == -3);
  std::string bad = R"({"mode":"SEPIA"})";
  CHECK(engine_trace(reinterpret_cast<Ptr>(img.rgba.data()), static_cast<uint32_t>(img.rgba.size()), 40, 30, ptrOf(bad), lenOf(bad)) == -2);
}

TEST_CASE("trace: engine_vectorize — begin, update, end (commit, undo, cancel)") {
  std::string opts0 = R"({"sessionID":3})";
  Handle h = engine_create(nullptr, ptrOf(opts0), lenOf(opts0));
  REQUIRE(h != 0);
  std::string doc = kiwiOf(kDoc);
  REQUIRE(engine_load(h, ptrOf(doc), lenOf(doc)) == 0);
  engine_take_events(h);
  Image img = makeImage(80, 80, [](int x, int y) {
    double d = std::hypot(x + 0.5 - 40, y + 0.5 - 40);
    return d < 20 ? Pixel{200, 30, 30, 255} : d < 32 ? Pixel{20, 20, 160, 255} : kWhite;
  });
  Ptr px = reinterpret_cast<Ptr>(img.rgba.data());
  uint32_t len = static_cast<uint32_t>(img.rgba.size());
  std::string refs = R"({"refs":["1:2"]})";
  const size_t before = guids(h).size();

  // Begin: an empty frame above the layer, in one open step.
  REQUIRE(engine_vectorize_begin(h, ptrOf(refs), lenOf(refs), px, len, 80, 80) == 0);
  std::string frame = resultJson().get("frame")->string;
  CHECK(engine_vectorize_begin(h, ptrOf(refs), lenOf(refs), px, len, 80, 80) == -7);  // E_BUSY
  json::Value f = node(h, frame);
  CHECK(f.get("type")->string == "FRAME");
  CHECK(f.get("name")->string == "Photo");
  CHECK(f.get("size")->get("x")->number == 160);
  CHECK(f.get("transform")->get("m12")->number == 20);

  // Updates re-trace into it.
  std::string full = R"({"mode":"FULL_COLOR","colors":3})";
  REQUIRE(engine_vectorize_update(h, ptrOf(full), lenOf(full)) == 0);
  json::Value stats = resultJson();
  CHECK(stats.get("layers")->number == 3);
  CHECK_FALSE(stats.get("exceeded")->boolean);
  f = node(h, frame);
  REQUIRE(f.get("childIds")->array.size() == 3);
  json::Value bottom = node(h, f.get("childIds")->array[0].string);
  CHECK(bottom.get("type")->string == "VECTOR");
  CHECK(bottom.get("name")->string == "FFFFFF");
  CHECK(bottom.get("size")->get("x")->number == doctest::Approx(160));  // 80 px over a 160 px layer
  std::string bw = R"({"mode":"BLACK_AND_WHITE","threshold":50})";
  REQUIRE(engine_vectorize_update(h, ptrOf(bw), lenOf(bw)) == 0);
  CHECK(resultJson().get("layers")->number == 2);
  f = node(h, frame);
  CHECK(f.get("childIds")->array.size() == 2);
  CHECK(has(h, "1:2"));  // the layer stays while previewing

  // Commit: the frame replaces the layer, selected, as one step "Vectorize".
  REQUIRE(engine_take_events(h) == 0);
  REQUIRE(engine_vectorize_end(h, 1) == 0);
  CHECK_FALSE(has(h, "1:2"));
  CHECK(has(h, frame));
  REQUIRE(engine_get_selection(h) == 0);
  CHECK(resultJson().get("refs")->array.at(0).string == frame);
  REQUIRE(engine_take_events(h) == 0);
  int steps = 0;
  json::Value events = resultJson();
  for (auto& e : events.get("events")->array)
    if (e.get("type")->string == "DOCUMENT_CHANGED") {
      steps++;
      CHECK(e.get("label")->string == "Vectorize");
      CHECK(e.get("kind")->string == "USER");
    }
  CHECK(steps == 1);
  CHECK(engine_vectorize_update(h, ptrOf(bw), lenOf(bw)) == -3);  // no session

  // Undo restores the image layer.
  REQUIRE(engine_command(h, 1, 0, 0) == 0);
  CHECK(has(h, "1:2"));
  CHECK_FALSE(has(h, frame));
  CHECK(guids(h).size() == before);

  // Cancel: the document as it was, nothing in the history.
  REQUIRE(engine_vectorize_begin(h, ptrOf(refs), lenOf(refs), px, len, 80, 80) == 0);
  REQUIRE(engine_vectorize_update(h, ptrOf(full), lenOf(full)) == 0);
  CHECK(guids(h).size() == before + 4);
  engine_take_events(h);
  REQUIRE(engine_vectorize_end(h, 0) == 0);
  CHECK(guids(h).size() == before);
  CHECK(has(h, "1:2"));
  // Commit without an update traces with the defaults.
  REQUIRE(engine_vectorize_begin(h, ptrOf(refs), lenOf(refs), px, len, 80, 80) == 0);
  REQUIRE(engine_vectorize_end(h, 1) == 0);
  CHECK_FALSE(has(h, "1:2"));
  CHECK(guids(h).size() == before + 3);  // − the layer + the frame + 3 colours
  engine_destroy(h);
}
