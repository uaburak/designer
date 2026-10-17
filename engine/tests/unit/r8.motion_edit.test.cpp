// Figma Motion, round 8b increment 1 (docs/motion.md §4.2, §4.9, §10): the keyframe commands on KEYFRAME_TRACK nodes
// bound through KEYFRAME expressions, their undo, the panel writes routed into keyframes while Motion is on, the tracks
// removed with their last layer, and the JSON reads (the timeline model, the diamonds, the resolved model).
#include <cmath>

#include "Helpers.h"
#include "doctest.h"
#include "editor/Editor.h"
#include "motion/Evaluate.h"
#include "scene/CodecJson.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid kRoot{1, 1}, kRect{1, 2}, kOther{1, 3};

// A root frame with two rectangles, nothing animated yet.
void load(Editor& e) {
  std::vector<NodeChange> nodes = baseChanges();
  nodes.push_back(make(kRoot, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "Root"));
  nodes.push_back(make(kRect, NodeType::ROUNDED_RECTANGLE, kRoot, "!", {20, 30, 100, 50}, "Rect"));
  nodes.push_back(make(kOther, NodeType::ROUNDED_RECTANGLE, kRoot, "\"", {200, 30, 50, 50}, "Other"));
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kPage);
  e.takeEvents();
}

CommandArgs args(const char* json) {
  CommandArgs a;
  REQUIRE(json::parse(json, a.raw));
  return a;
}

json::Value parsed(const std::string& text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  return v;
}

motion::State on(int64_t timeUs, bool autoKey = false) {
  motion::State s;
  s.on = true;
  s.root = kRoot;
  s.timeUs = timeUs;
  s.autoKeyframe = autoKey;
  return s;
}

size_t countType(const Document& d, NodeType t) {
  size_t n = 0;
  d.forEach([&](const Node& node) { n += node.props.type == t ? 1 : 0; });
  return n;
}

}  // namespace

TEST_CASE("motion edit: Add keyframe makes the track, binds the field and upserts by position; the layer plays it") {
  Editor e;
  load(e);
  e.setMotion(on(0));
  e.setSelection({kRect});
  // t = 0: opacity 1 (the current value, no value given).
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"field":{"type":"PROPERTY","name":"OPACITY"}})")) == OK);
  const Document& doc = e.document();
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 1);
  CHECK(countType(doc, NodeType::KEYFRAME) == 1);
  const Node* r = doc.get(kRect);
  REQUIRE(r->props.parameterConsumptionMap.size() == 1);
  const VariableData& d = r->props.parameterConsumptionMap[0].data;
  CHECK(r->props.parameterConsumptionMap[0].field == VariableField::OPACITY);
  CHECK(d.kind == VariableData::Kind::EXPRESSION);
  CHECK(d.function == ExpressionFunction::KEYFRAME);
  REQUIRE(d.args.size() == 2);
  CHECK(d.args[0].floatValue == 100);  // the base, stored ×100
  CHECK(d.args[1].kind == VariableData::Kind::OTHER);
  REQUIRE(e.lastCreated().size() == 1);
  Guid k0 = e.lastCreated()[0];
  // t = 500 ms, opacity 0 (public units: 0–1) with Ease out.
  e.setMotion(on(500000));
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"nodes":["1:2"],"field":{"type":"PROPERTY","name":"OPACITY"},"value":{"type":"FLOAT","value":0},"easing":{"type":"EASE_OUT"}})")) == OK);
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 1);  // the same track
  CHECK(countType(doc, NodeType::KEYFRAME) == 2);
  Guid k1 = e.lastCreated()[0];
  CHECK(k1 != k0);
  // The same position again: an upsert (the value changes, no third keyframe).
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"field":{"type":"PROPERTY","name":"OPACITY"},"value":{"type":"FLOAT","value":0.2}})")) == OK);
  CHECK(countType(doc, NodeType::KEYFRAME) == 2);
  CHECK(e.lastCreated()[0] == k1);
  // The model plays it: at 250 ms the opacity is between 1 and 0.2, eased out.
  e.setMotion(on(250000));
  double eased = motion::cubicBezier(0, 0, 0.58, 1, 0.5);
  CHECK(r->props.opacity == doctest::Approx(1 + (0.2 - 1) * eased));
  e.setMotion(on(500000));
  CHECK(r->props.opacity == doctest::Approx(0.2));
  // The timeline model names the layer, the track and both keyframes in public units.
  json::Writer w;
  e.writeMotionTimeline(w, kNoGuid);
  json::Value tl = parsed(w.take());
  CHECK(tl.get("root")->string == "1:1");
  CHECK(tl.get("durationUs")->number == 2000000);
  REQUIRE(tl.get("layers")->array.size() == 1);
  const json::Value& layer = tl.get("layers")->array[0];
  CHECK(layer.get("node")->string == "1:2");
  REQUIRE(layer.get("tracks")->array.size() == 1);
  const json::Value& track = layer.get("tracks")->array[0];
  CHECK(track.get("field")->get("name")->string == "OPACITY");
  CHECK(track.get("label")->string == "Opacity");
  REQUIRE(track.get("keyframes")->array.size() == 2);
  CHECK(track.get("keyframes")->array[0].get("value")->get("value")->number == 1);
  CHECK(track.get("keyframes")->array[1].get("value")->get("value")->number == doctest::Approx(0.2));
  CHECK(track.get("keyframes")->array[1].get("easing")->get("type")->string == "EASE_OUT");
  CHECK(track.get("keyframes")->array[0].get("easing")->get("type")->string == "CUSTOM_CUBIC_BEZIER");  // the default curve
  CHECK(layer.get("endUs")->number == 500000);
  // The diamonds: at the playhead (500 ms) the field is at a keyframe; at 250 ms it has a track.
  json::Writer fs;
  e.writeMotionFieldStates(fs, {kRect, kOther});
  json::Value states = parsed(fs.take());
  CHECK(states.get("1:2")->get("OPACITY")->get("state")->string == "keyframe");
  CHECK(states.get("1:2")->get("OPACITY")->get("keyframe")->string == k1.toString());
  CHECK(states.get("1:3")->object.empty());
  e.setMotion(on(250000));
  json::Writer fs2;
  e.writeMotionFieldStates(fs2, {kRect});
  CHECK(parsed(fs2.take()).get("1:2")->get("OPACITY")->get("state")->string == "track");
  // The resolved model.
  json::Writer rw;
  e.writeMotionResolved(rw, kRoot);
  json::Value res = parsed(rw.take());
  REQUIRE(res.get("layers")->array.size() == 1);
  CHECK(res.get("layers")->array[0].get("properties")->array[0].get("kind")->string == "absolute");
  CHECK(res.get("layers")->array[0].get("anchor")->get("x")->number == 50);
  // Undo takes the whole step back: the second keyframe's upsert, then the keyframe, then the track and its binding.
  e.setMotion(motion::State{});
  REQUIRE(e.command(CommandId::UNDO) == OK);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(countType(doc, NodeType::KEYFRAME) == 1);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 0);
  CHECK(doc.get(kRect)->props.parameterConsumptionMap.empty());
  CHECK(doc.get(kRect)->props.opacity == 1);
  REQUIRE(e.command(CommandId::REDO) == OK);
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 1);
}

TEST_CASE("motion edit: Set keyframes (time, value, easing), Delete keyframes (an empty track goes), Delete animation") {
  Editor e;
  load(e);
  e.setMotion(on(0));
  e.setSelection({kRect});
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"field":{"type":"PROPERTY","name":"CORNER_RADIUS"},"value":{"type":"FLOAT","value":0}})")) == OK);
  Guid k0 = e.lastCreated()[0];
  e.setMotion(on(1000000));
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"field":{"type":"PROPERTY","name":"CORNER_RADIUS"},"value":{"type":"FLOAT","value":20}})")) == OK);
  Guid k1 = e.lastCreated()[0];
  const Document& doc = e.document();
  const Node* r = doc.get(kRect);
  // Move k1 to 400 ms with a new value and a Hold.
  std::string edit = R"({"edits":[{"id":")" + k1.toString() + R"(","timeUs":400000,"value":{"type":"FLOAT","value":10},"easing":{"type":"HOLD"}}]})";
  REQUIRE(e.command(CommandId::MOTION_SET_KEYFRAMES, args(edit.c_str())) == OK);
  e.setMotion(on(399999));
  CHECK(r->props.cornerRadii[0] == 0);  // Hold: the previous value until the keyframe
  e.setMotion(on(400000));
  CHECK(r->props.cornerRadii[0] == doctest::Approx(10));
  // Moving k0 onto k1's position removes k1 (unique positions).
  std::string onto = R"({"edits":[{"id":")" + k0.toString() + R"(","timeUs":400000}]})";
  REQUIRE(e.command(CommandId::MOTION_SET_KEYFRAMES, args(onto.c_str())) == OK);
  CHECK(countType(doc, NodeType::KEYFRAME) == 1);
  CHECK_FALSE(doc.has(k1));
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(countType(doc, NodeType::KEYFRAME) == 2);
  CHECK(doc.has(k1));
  // Delete both keyframes: the track and the binding go with the last one; the base stays in the field.
  std::string del = R"({"ids":[")" + k0.toString() + R"(",")" + k1.toString() + R"("]})";
  REQUIRE(e.command(CommandId::MOTION_DELETE_KEYFRAMES, args(del.c_str())) == OK);
  CHECK(countType(doc, NodeType::KEYFRAME) == 0);
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 0);
  CHECK(r->props.parameterConsumptionMap.empty());
  CHECK(r->props.cornerRadii[0] == 0);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 1);
  CHECK(r->props.parameterConsumptionMap.size() == 1);
  // Delete animation (the node's tracks): the same end.
  REQUIRE(e.command(CommandId::MOTION_DELETE_TRACKS, args(R"({"node":"1:2"})")) == OK);
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 0);
  CHECK(r->props.parameterConsumptionMap.empty());
}

TEST_CASE("motion edit: the timeline's duration and playback, a layer retimed, the anchor, the path handles") {
  Editor e;
  load(e);
  e.setMotion(on(0));
  REQUIRE(e.command(CommandId::MOTION_SET_TIMELINE, args(R"({"root":"1:1","durationUs":3000000,"playback":"PING_PONG","snappingFps":29.97})")) == OK);
  motion::Timeline tl = e.motionIndex().timeline(e.document(), kRoot);
  CHECK(tl.durationUs == 3000000);
  CHECK(tl.playback == motion::Playback::BOOMERANG);
  CHECK(tl.fpsNumerator == 30000);
  CHECK(tl.fpsDenominator == 1001);
  e.setSelection({kRect});
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"field":{"type":"PROPERTY","name":"TRANSLATION_XY"},"timeUs":200000,"value":{"type":"VECTOR","value":{"x":0,"y":0}}})")) == OK);
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"field":{"type":"PROPERTY","name":"TRANSLATION_XY"},"timeUs":1200000,"value":{"type":"VECTOR","value":{"x":100,"y":0}}})")) == OK);
  Guid k1 = e.lastCreated()[0];
  Guid trackId = e.motionIndex().node(kRect)->bindings[0].params[0].track;  // the index is rebuilt by every command: keep the id
  const motion::Track* t = e.motionIndex().track(trackId);
  REQUIRE(t);
  REQUIRE(t->keyframes.size() == 2);
  CHECK(t->keyframes[0].timeUs == 200000);
  // Moved 100 ms later, then scaled ×2 about the first keyframe.
  REQUIRE(e.command(CommandId::MOTION_RETIME_LAYER, args(R"({"node":"1:2","deltaUs":100000})")) == OK);
  t = e.motionIndex().track(trackId);
  CHECK(t->keyframes[0].timeUs == 300000);
  CHECK(t->keyframes[1].timeUs == 1300000);
  REQUIRE(e.command(CommandId::MOTION_RETIME_LAYER, args(R"({"node":"1:2","scale":{"factor":2,"pivotUs":300000}})")) == OK);
  t = e.motionIndex().track(trackId);
  CHECK(t->keyframes[0].timeUs == 300000);
  CHECK(t->keyframes[1].timeUs == 2300000);
  // The motion transform plays the translation: at 2.3 s the rect is 100 to the right.
  e.setMotion(on(2300000));
  const Node* r = e.document().get(kRect);
  CHECK(r->props.transform.m02 == doctest::Approx(120));
  // The anchor at the top-left: a scale track would pivot there (the base decodes it).
  REQUIRE(e.command(CommandId::MOTION_SET_ANCHOR, args(R"({"x":0,"y":0})")) == OK);
  motion::LayerBase b = motion::decodeLayerBase(e.motionLayer().baseOf(kRect) ? *e.motionLayer().baseOf(kRect) : r->props);
  CHECK(b.originX.value == 0);
  CHECK(b.originX.units == NumberUnits::PERCENT);
  // Path handles on the second keyframe.
  std::string handles = R"({"keyframe":")" + k1.toString() + R"(","in":{"x":0,"y":-50},"out":{"x":0,"y":0}})";
  REQUIRE(e.command(CommandId::MOTION_SET_PATH_HANDLES, args(handles.c_str())) == OK);
  t = e.motionIndex().track(trackId);
  CHECK(t->keyframes[1].hasPathHandles);
  CHECK(t->keyframes[1].pathIn.y == -50);
  e.setMotion(on(1300000));  // half-way along a curved path: above the straight line
  CHECK(r->props.transform.m12 < 30);
}

TEST_CASE("motion edit: a panel write becomes a keyframe when the field has a track, or with auto-keyframe on") {
  Editor e;
  load(e);
  const Document& doc = e.document();
  const Node* r = doc.get(kRect);
  // Auto-keyframe off, no track: the panel edits the base (Design's write).
  e.setMotion(on(500000));
  NodeChange c = NodeChange::changed(kRect);
  c.mask = F_OPACITY;
  c.props.opacity = 0.5;
  REQUIRE(e.setProps({kRect}, c, 0) == OK);
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 0);
  CHECK(r->props.opacity == doctest::Approx(0.5));
  // Auto-keyframe on: the first write makes the track with a keyframe at 0 holding the old value and one at the playhead.
  e.setMotion(on(500000, true));
  c.props.opacity = 0.1;
  REQUIRE(e.setProps({kRect}, c, 0) == OK);
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 1);
  CHECK(countType(doc, NodeType::KEYFRAME) == 2);
  CHECK(r->props.opacity == doctest::Approx(0.1));  // the playhead's value, through the layer
  e.setMotion(on(0, true));
  CHECK(r->props.opacity == doctest::Approx(0.5));  // the base kept at t = 0
  CHECK(e.motionLayer().baseOf(kRect)->opacity == doctest::Approx(0.5));  // the document's base value is unchanged
  // Auto-keyframe off again, a track exists: the write goes to the keyframe at the playhead (t = 0).
  e.setMotion(on(0, false));
  c.props.opacity = 0.9;
  REQUIRE(e.setProps({kRect}, c, 0) == OK);
  CHECK(countType(doc, NodeType::KEYFRAME) == 2);
  CHECK(r->props.opacity == doctest::Approx(0.9));
  CHECK(e.motionLayer().baseOf(kRect)->opacity == doctest::Approx(0.5));
  // Deleting the layer removes its track (no other layer binds it).
  e.setMotion(motion::State{});
  e.setSelection({kRect});
  REQUIRE(e.command(CommandId::DELETE) == OK);
  CHECK_FALSE(doc.has(kRect));
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 0);
  CHECK(countType(doc, NodeType::KEYFRAME) == 0);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(doc.has(kRect));
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 1);
  CHECK(countType(doc, NodeType::KEYFRAME) == 2);
}
