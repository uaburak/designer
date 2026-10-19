// Figma Motion, round 8e (docs/motion.md §7.5, §7.6): what the vector exports read — a timeline root's layers as shapes
// at base values (paths in each layer's space with their paints, strokes as a centre line with their style, the
// layers only a raster can draw marked so) and their evaluated values sampled at times, the view state put back.
#include "Helpers.h"
#include "doctest.h"
#include "editor/Editor.h"
#include "geometry/NodeGeometry.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid kRoot{1, 1}, kRect{1, 2}, kPhoto{1, 3}, kGroup{1, 4}, kDot{1, 5};

json::Value parsed(const std::string& text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  return v;
}

CommandArgs args(const std::string& json) {
  CommandArgs a;
  REQUIRE(json::parse(json, a.raw));
  return a;
}

void load(Editor& e) {
  std::vector<NodeChange> nodes = baseChanges();
  NodeChange root = make(kRoot, NodeType::FRAME, kPage, "!", {100, 50, 400, 300}, "Root");
  Paint white;
  white.color = Color{1, 1, 1, 1};
  root.props.fillPaints = {white};
  nodes.push_back(root);
  NodeChange rect = make(kRect, NodeType::ROUNDED_RECTANGLE, kRoot, "!", {20, 30, 100, 50}, "Rect");
  Paint red;
  red.color = Color{1, 0, 0, 1};
  red.opacity = 0.5f;
  rect.props.fillPaints = {red};
  Paint black;
  black.color = Color{0, 0, 0, 1};
  rect.props.strokePaints = {black};
  rect.props.strokeWeight = 4;
  rect.props.strokeAlign = StrokeAlign::CENTER;
  rect.props.extra["pathTrim"] = codec::extraFromJson("NodeChange", "pathTrim", parsed(R"({"value":{"x":0,"y":0.5}})"));
  nodes.push_back(rect);
  NodeChange photo = make(kPhoto, NodeType::ROUNDED_RECTANGLE, kRoot, "\"", {200, 30, 80, 80}, "Photo");
  Paint img;
  img.type = PaintType::IMAGE;
  photo.props.fillPaints = {img};
  nodes.push_back(photo);
  nodes.push_back(make(kGroup, NodeType::FRAME, kRoot, "#", {0, 200, 50, 50}, "Group"));
  nodes.push_back(make(kDot, NodeType::ELLIPSE, kGroup, "!", {10, 10, 20, 20}, "Dot"));
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kPage);
  e.takeEvents();
}

const json::Value* layerOf(const json::Value& list, Guid id) {
  for (const json::Value& l : list.array)
    if (l.get("node")->string == id.toString()) return &l;
  return nullptr;
}

}  // namespace

TEST_CASE("motion export: the shapes — the root at the origin, children after their parent, paths with paints, rasters marked") {
  Editor e;
  load(e);
  json::Writer w;
  e.writeMotionShapes(w, kRect);  // any layer: its root's shapes
  json::Value shapes = parsed(w.take());
  REQUIRE(shapes.isArray());
  // Back to front, each child after its parent: Root, Rect, Photo, Group, Dot.
  std::vector<std::string> order;
  for (const json::Value& l : shapes.array) order.push_back(l.get("name")->string);
  CHECK(order == std::vector<std::string>{"Root", "Rect", "Photo", "Group", "Dot"});
  const json::Value* root = layerOf(shapes, kRoot);
  REQUIRE(root);
  CHECK(root->get("parent")->isNull());
  CHECK(root->get("transform")->array[4].number == 0);  // drawn at the origin, not at its place on the page
  CHECK(root->get("clips")->boolean);
  REQUIRE(root->get("paths")->array.size() == 1);
  // The rect: its fill (the paint's opacity in the colour's alpha), then its centre stroke with its style — the whole
  // outline, though the base path trim cuts it (the samples carry the trim).
  const json::Value* rect = layerOf(shapes, kRect);
  REQUIRE(rect);
  CHECK(rect->get("parent")->string == kRoot.toString());
  CHECK(rect->get("transform")->array[4].number == 20);
  CHECK(rect->get("transform")->array[5].number == 30);
  CHECK_FALSE(rect->get("rasterize")->boolean);
  const json::Value& paths = *rect->get("paths");
  REQUIRE(paths.array.size() == 2);
  CHECK(paths.array[0].get("d")->string.rfind("M", 0) == 0);
  CHECK(paths.array[0].get("paint")->get("type")->string == "SOLID");
  CHECK(paths.array[0].get("paint")->get("color")->get("a")->number == doctest::Approx(0.5));
  CHECK(paths.array[0].get("source")->get("collection")->string == "fills");
  CHECK_FALSE(paths.array[0].get("stroke"));
  CHECK(paths.array[1].get("source")->get("collection")->string == "strokes");
  REQUIRE(paths.array[1].get("stroke"));
  CHECK(paths.array[1].get("stroke")->get("weight")->number == 4);
  CHECK(paths.array[1].get("d")->string == paths.array[0].get("d")->string);  // the whole rectangle
  // The base keeps its trim after the read.
  double s = 0, t = 1;
  CHECK(pathTrimOf(e.document().get(kRect)->props, s, t));
  CHECK(t == doctest::Approx(0.5));
  // An image fill: a raster of its base state, placed in its own space; no paths.
  const json::Value* photo = layerOf(shapes, kPhoto);
  REQUIRE(photo);
  CHECK(photo->get("rasterize")->boolean);
  CHECK(photo->get("paths")->array.empty());
  CHECK(photo->get("raster")->get("width")->number == doctest::Approx(80));
  CHECK(layerOf(shapes, kDot)->get("parent")->string == kGroup.toString());
}

TEST_CASE("motion export: the samples — each layer's transform, opacity and trim at each time; the view state put back") {
  Editor e;
  load(e);
  e.setSelection({kRect});
  motion::State on;
  on.on = true;
  on.root = kRoot;
  e.setMotion(on);
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"nodes":["1:2"],"field":{"type":"PROPERTY","name":"OPACITY"},"timeUs":0,"value":{"type":"FLOAT","value":0},"easing":{"type":"LINEAR"}})")) == OK);
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"nodes":["1:2"],"field":{"type":"PROPERTY","name":"OPACITY"},"timeUs":1000000,"value":{"type":"FLOAT","value":1},"easing":{"type":"LINEAR"}})")) == OK);
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"nodes":["1:2"],"field":{"type":"PROPERTY","name":"TRANSLATION_XY"},"timeUs":1000000,"value":{"type":"VECTOR","value":{"x":100,"y":0}},"easing":{"type":"LINEAR"}})")) == OK);
  motion::State at = on;
  at.timeUs = 250000;
  e.setMotion(at);
  json::Writer w;
  e.writeMotionSamples(w, kRoot, {0, 500000, 1000000});
  json::Value samples = parsed(w.take());
  REQUIRE(samples.get("times")->array.size() == 3);
  const json::Value* rect = layerOf(*samples.get("layers"), kRect);
  REQUIRE(rect);
  const json::Value& f = *rect->get("frames");
  REQUIRE(f.array.size() == 3);
  CHECK(f.array[0].get("o")->number == doctest::Approx(0));
  CHECK(f.array[1].get("o")->number == doctest::Approx(0.5));
  CHECK(f.array[2].get("o")->number == doctest::Approx(1));
  // The motion transform composed into the local transform: from 20 (the first value holds back) to 120.
  CHECK(f.array[2].get("t")->array[4].number == doctest::Approx(120));
  CHECK(f.array[0].get("trim")->array[1].number == doctest::Approx(0.5));
  CHECK(f.array[0].get("fills")->array[0].get("r")->number == doctest::Approx(1));
  CHECK(f.array[0].get("sw")->number == 4);
  // The root is still at the origin; the playhead is back at 250 ms.
  CHECK(layerOf(*samples.get("layers"), kRoot)->get("frames")->array[1].get("t")->array[4].number == 0);
  CHECK(e.motion().timeUs == 250000);
  CHECK(e.document().get(kRect)->props.opacity == doctest::Approx(0.25));
}
