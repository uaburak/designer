// Figma Draw's brushes and video fills (docs/engine-build.md "Text round" → BRUSH and VIDEO): a BRUSH node is drawn
// as its artwork (a vector); a path stroked with a brush lays that artwork along itself (stretch) or stamps it
// (scatter); a VIDEO paint round-trips and draws its poster frame as an image fill does.
#include <cmath>

#include "base/Json.h"
#include "doctest.h"
#include "editor/Editor.h"
#include "geometry/Brush.h"
#include "geometry/NodeGeometry.h"
#include "geometry/Shapes.h"
#include "geometry/VectorNetwork.h"
#include "Helpers.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

VectorData vectorOf(const geom::Path& path, Vec2 size, bool closed) {
  geom::VectorNetwork net = geom::networkFromPath(path, WindingRule::NONZERO);
  VectorData d;
  d.present = true;
  d.normalizedSize = size;
  d.network = std::make_shared<const std::vector<uint8_t>>(net.encode());
  (void)closed;
  return d;
}

std::string extra(const char* key, const char* jsonValue) {
  json::Value v;
  REQUIRE(json::parse(jsonValue, v));
  std::string bytes = codec::extraFromJson("NodeChange", key, v);
  REQUIRE(!bytes.empty());
  return bytes;
}

const Guid BR{1, 5}, P{1, 6};

// A brush 256 × 16 (a lens: thick in the middle) on the internal canvas, and a horizontal path 200 long stroked with it.
std::vector<NodeChange> scene(const char* brushType) {
  auto nodes = baseChanges();
  NodeChange brush = make(BR, NodeType::BRUSH, kPage, "!", {0, 0, 256, 16}, "Heist");
  geom::Path lens = geom::ellipsePath({256, 16}, ArcData{});
  brush.props.shape().vectorData = vectorOf(lens, {256, 16}, true);
  brush.props.extra["brushType"] = extra("brushType", brushType);
  nodes.push_back(brush);
  NodeChange path = make(P, NodeType::VECTOR, kPage, "\"", {100, 100, 200, 0}, "Stroke");
  geom::Path line;
  line.moveTo({0, 0});
  line.lineTo({200, 0});
  path.props.shape().vectorData = vectorOf(line, {200, 0}, false);
  path.props.fillPaints.clear();
  path.props.strokePaints = {Paint::solid(Color{0, 0, 0, 1})};
  path.props.strokeWeight = 10;
  path.props.extra["strokeBrushGuid"] = extra("strokeBrushGuid", R"({"sessionID": 1, "localID": 5})");
  nodes.push_back(path);
  return nodes;
}

}  // namespace

TEST_CASE("brushes: a BRUSH node is its artwork; a stretch brush stroke follows the path at the stroke's weight") {
  Editor e;
  e.setSessionID(1);
  e.loadDocument(scene(R"("STRETCH")"), kNoGuid);
  const Document& doc = e.document();
  CHECK(doc.get(BR)->props.type == NodeType::BRUSH);
  CHECK(std::string(nodeTypeName(NodeType::BRUSH)) == "BRUSH");
  const NodeGeometry* bg = doc.geometry(BR);
  REQUIRE(bg);
  REQUIRE(!bg->fills.empty());  // drawn like a vector
  CHECK(bg->bounds.w == doctest::Approx(256).epsilon(0.01));
  const NodeGeometry* g = doc.geometry(P);
  REQUIRE(g);
  geom::Path out;
  uint64_t key = 0;
  REQUIRE(brushStroke(doc, doc.get(P)->props, *g, 0.1, out, &key));
  CHECK(key != 0);
  Rect b = out.bounds();
  CHECK(b.x == doctest::Approx(0).epsilon(0.01));
  CHECK(b.w == doctest::Approx(200).epsilon(0.01));  // the artwork's length → the path's
  CHECK(b.h == doctest::Approx(10).epsilon(0.02));   // its height → the stroke weight
  CHECK(b.y == doctest::Approx(-5).epsilon(0.02));
  // Without a brush: the plain stroke.
  NodeProps plain = doc.get(P)->props;
  plain.extra.erase("strokeBrushGuid");
  CHECK_FALSE(brushStroke(doc, plain, *g, 0.1, out));
}

TEST_CASE("brushes: a scatter brush stamps its artwork along the path, gap stamp lengths apart") {
  Editor e;
  e.setSessionID(1);
  auto nodes = scene(R"("SCATTER")");
  nodes.back().props.extra["scatterStrokeSettings"] = extra("scatterStrokeSettings", R"({"gap": 1, "wiggle": 0, "sizeJitter": 0})");
  // A small square brush so stamps are countable: 10 × 10 at weight 10 → a stamp 10 long.
  nodes[nodes.size() - 2].props.size = {10, 10};
  nodes[nodes.size() - 2].props.shape().vectorData = vectorOf(geom::rectPath({10, 10}, {0, 0, 0, 0}), {10, 10}, true);
  e.loadDocument(nodes, kNoGuid);
  const Document& doc = e.document();
  geom::Path out;
  REQUIRE(brushStroke(doc, doc.get(P)->props, *doc.geometry(P), 0.1, out));
  size_t stamps = 0;
  for (geom::Verb v : out.verbs) stamps += v == geom::Verb::Move;
  CHECK(stamps == 20);  // 200 / 10
  Rect b = out.bounds();
  CHECK(b.w == doctest::Approx(200).epsilon(0.02));
}

TEST_CASE("video fills: VIDEO paints are read, written and drawn from their poster frame") {
  json::Value v;
  REQUIRE(json::parse(R"([{"type": "VIDEO", "opacity": 1, "visible": true, "imageScaleMode": "FILL",
    "image": {"hash": [76,109,79,126,207,115,229,75,17,208,214,158,242,154,27,238,126,174,228,230]},
    "video": {"hash": [60,71,39,226,163,54,235,37,222,21,158,83,105,175,187,178,100,128,67,173]}}])",
                      v));
  std::vector<Paint> paints = codec::readPaints(v);
  REQUIRE(paints.size() == 1);
  CHECK(paints[0].type == PaintType::VIDEO);
  CHECK(isImageLike(paints[0].type));
  CHECK(paints[0].image.present);
  CHECK(paints[0].imageScaleMode == ImageScaleMode::FILL);
  json::Writer w;
  codec::writePaints(w, paints);
  CHECK(w.str().find("\"VIDEO\"") != std::string::npos);
  CHECK(w.str().find("\"video\"") != std::string::npos);  // kept as it came
  // Kiwi round trip.
  kiwi::ByteBuffer bb;
  codec::writePaint(bb, paints[0], nullptr);
  kiwi::ByteBuffer in(bb.data(), bb.size());
  Paint back;
  REQUIRE(codec::readPaint(in, back, nullptr));
  CHECK(back.type == PaintType::VIDEO);
  CHECK(back.image == paints[0].image);
  CHECK(back.extra == paints[0].extra);
}
