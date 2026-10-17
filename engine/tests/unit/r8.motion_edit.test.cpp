// Figma Motion, round 8b increments 1–2 (docs/motion.md §4.2, §4.9, §10): the keyframe commands on KEYFRAME_TRACK nodes
// bound through KEYFRAME expressions, their undo, the panel writes and canvas gestures routed into keyframes while
// Motion is on, the anchor kept in place, the tracks removed with their last layer and copied with a duplicated, pasted
// or detached one, and the JSON reads (the timeline model, the diamonds, the resolved model).
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

void drag(Editor& e, Vec2 from, Vec2 to) {
  e.pointer(PointerEvent::DOWN, from.x, from.y, 0, 1, 0);
  for (int i = 1; i <= 4; i++) {
    double t = i / 4.0;
    e.pointer(PointerEvent::MOVE, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, 0, 1, 0);
  }
  e.pointer(PointerEvent::UP, to.x, to.y, 0, 0, 0);
}

// The manual track bound to a node's field (kNoGuid when none).
Guid trackOf(Editor& e, Guid node, VariableField f) {
  const motion::AnimatedNode* an = e.motionIndex().node(node);
  if (!an) return kNoGuid;
  for (const motion::Binding& b : an->bindings)
    if (b.slot.kind == motion::Slot::Kind::NODE && b.slot.field == f && !b.params.empty()) return b.params[0].track;
  return kNoGuid;
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

TEST_CASE("motion gestures: a drag keys the position at the playhead where the canvas shows the layer; the base stays") {
  Editor e;
  load(e);
  const Document& doc = e.document();
  const Node* r = doc.get(kRect);
  e.setSelection({kRect});
  // The owner's case: a Position track with its 0 ms keyframe, the playhead at 1.5 s.
  e.setMotion(on(0));
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"field":{"type":"PROPERTY","name":"TRANSLATION_XY"},"value":{"type":"VECTOR","value":{"x":0,"y":0}}})")) == OK);
  e.setMotion(on(1500000));
  drag(e, {70, 55}, {110, 65});
  Guid track = trackOf(e, kRect, VariableField::MOTION_TRANSLATION_XY);
  const motion::Track* t = e.motionIndex().track(track);
  REQUIRE(t);
  REQUIRE(t->keyframes.size() == 2);
  CHECK(t->keyframes[0].timeUs == 0);
  CHECK(t->keyframes[1].timeUs == 1500000);
  CHECK(t->keyframes[1].value.v.x == doctest::Approx(40));
  CHECK(t->keyframes[1].value.v.y == doctest::Approx(10));
  // The canvas keeps the evaluated position; the base (x 20, y 30) is untouched.
  CHECK(r->props.transform.m02 == doctest::Approx(60));
  CHECK(r->props.transform.m12 == doctest::Approx(40));
  REQUIRE(e.motionLayer().baseOf(kRect));
  CHECK(e.motionLayer().baseOf(kRect)->transform.m02 == 20);
  CHECK(e.motionLayer().baseOf(kRect)->transform.m12 == 30);
  e.setMotion(on(0));
  CHECK(r->props.transform.m02 == doctest::Approx(20));
  // A nudge at the playhead moves the same keyframe (1 px right).
  e.setMotion(on(1500000));
  e.key(KeyEvent::DOWN, KeyCode::ArrowRight, 0, 0, false);
  t = e.motionIndex().track(track);
  REQUIRE(t->keyframes.size() == 2);
  CHECK(t->keyframes[1].value.v.x == doctest::Approx(41));
  CHECK(r->props.transform.m02 == doctest::Approx(61));
  // One undo step per gesture: the nudge, then the drag's keyframe.
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(r->props.transform.m02 == doctest::Approx(60));
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(e.motionIndex().track(track)->keyframes.size() == 1);
  CHECK(r->props.transform.m02 == doctest::Approx(20));
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 1);
}

TEST_CASE("motion gestures: with auto-keyframe on, rotate keys ROTATION about the anchor and resize keys WIDTH / HEIGHT") {
  Editor e;
  load(e);
  const Document& doc = e.document();
  const Node* o = doc.get(kOther);
  e.setSelection({kOther});
  e.setMotion(on(1000000, true));
  // The rotate handle past the bottom-right corner (250, 80), turned 90° clockwise about the centre (225, 55).
  drag(e, {258, 88}, {192, 88});
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 1);  // no position track: the anchor didn't move
  Guid track = trackOf(e, kOther, VariableField::MOTION_ROTATION);
  const motion::Track* t = e.motionIndex().track(track);
  REQUIRE(t);
  REQUIRE(t->keyframes.size() == 2);  // the first auto-keyframe keeps the old value at 0
  CHECK(t->keyframes[0].value.f == doctest::Approx(0));
  CHECK(t->keyframes[1].timeUs == 1000000);
  CHECK(t->keyframes[1].value.f == doctest::Approx(std::acos(-1.0) / 2));  // stored −radians: the panel's −90°
  CHECK(o->props.transform.m10 == doctest::Approx(1));
  Vec2 centre = o->props.transform.apply({25, 25});
  CHECK(centre.x == doctest::Approx(225));
  CHECK(centre.y == doctest::Approx(55));
  CHECK(e.motionLayer().baseOf(kOther)->transform.m00 == 1);  // the base isn't turned
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 0);
  CHECK(o->props.transform.m00 == doctest::Approx(1));
  // The bottom-right corner of Rect (120, 80) dragged to (140, 100): WIDTH 120, HEIGHT 70 at the playhead.
  e.setSelection({kRect});
  e.setMotion(on(500000, true));
  const Node* r = doc.get(kRect);
  drag(e, {120, 80}, {140, 100});
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 2);
  CHECK(trackOf(e, kRect, VariableField::MOTION_TRANSLATION_XY) == kNoGuid);  // the top-left stayed
  CHECK(r->props.size.x == doctest::Approx(120));
  CHECK(r->props.size.y == doctest::Approx(70));
  CHECK(r->props.transform.m02 == 20);
  CHECK(e.motionLayer().baseOf(kRect)->size.x == 100);
  e.setMotion(on(0, true));
  CHECK(r->props.size.x == doctest::Approx(100));
}

TEST_CASE("motion gestures: without a track and auto-keyframe off, a drag of an animated layer moves its base") {
  Editor e;
  load(e);
  const Document& doc = e.document();
  const Node* r = doc.get(kRect);
  e.setSelection({kRect});
  e.setMotion(on(0));
  // Animated (turned 90° by a track), but no position track: the move is Design's, from where the canvas shows it.
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"field":{"type":"PROPERTY","name":"ROTATION"},"value":{"type":"FLOAT","value":90}})")) == OK);
  Vec2 centre = r->props.transform.apply({50, 25});
  CHECK(centre.x == doctest::Approx(70));
  CHECK(centre.y == doctest::Approx(55));
  drag(e, {70, 55}, {100, 55});
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 1);
  REQUIRE(e.motionLayer().baseOf(kRect));
  CHECK(e.motionLayer().baseOf(kRect)->transform.m02 == doctest::Approx(50));  // the base x moved 30
  CHECK(e.motionLayer().baseOf(kRect)->transform.m00 == doctest::Approx(1));   // and isn't turned
  centre = r->props.transform.apply({50, 25});
  CHECK(centre.x == doctest::Approx(100));
  CHECK(centre.y == doctest::Approx(55));
  CHECK(r->props.transform.m01 == doctest::Approx(1));  // still turned by the track
}

TEST_CASE("motion ownership: duplicate, paste and detach copy the tracks the copied layers animate on") {
  Editor e;
  load(e);
  const Document& doc = e.document();
  e.setSelection({kRect});
  e.setMotion(on(0));
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"field":{"type":"PROPERTY","name":"OPACITY"},"value":{"type":"FLOAT","value":1}})")) == OK);
  e.setMotion(on(1000000));
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"field":{"type":"PROPERTY","name":"OPACITY"},"value":{"type":"FLOAT","value":0}})")) == OK);
  Guid original = trackOf(e, kRect, VariableField::OPACITY);
  // Duplicate: a second track with its two keyframes, bound to the copy.
  REQUIRE(e.command(CommandId::DUPLICATE) == OK);
  REQUIRE(e.selection().size() == 1);
  Guid copy = e.selection()[0];
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 2);
  CHECK(countType(doc, NodeType::KEYFRAME) == 4);
  Guid copied = trackOf(e, copy, VariableField::OPACITY);
  REQUIRE(copied != kNoGuid);
  CHECK(copied != original);
  CHECK(e.motionIndex().node(copy)->bindings[0].params[0].timelineDef == kRoot);
  CHECK(doc.get(copy)->props.opacity == doctest::Approx(0));  // it plays: 0 at 1 s
  // Its keyframes are its own: editing them leaves the original's.
  Guid k = e.motionIndex().track(copied)->keyframes[1].id;
  std::string edit = R"({"edits":[{"id":")" + k.toString() + R"(","value":{"type":"FLOAT","value":0.5}}]})";
  REQUIRE(e.command(CommandId::MOTION_SET_KEYFRAMES, args(edit.c_str())) == OK);
  CHECK(doc.get(copy)->props.opacity == doctest::Approx(0.5));
  CHECK(doc.get(kRect)->props.opacity == doctest::Approx(0));
  REQUIRE(e.command(CommandId::UNDO) == OK);
  REQUIRE(e.command(CommandId::UNDO) == OK);  // the duplicate, its track with it
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 1);
  // Cut and paste: the track goes with the layer, and the paste brings it back from the clipboard.
  e.setSelection({kRect});
  Clipboard clip;
  REQUIRE(e.copySelection(clip, true));
  REQUIRE(e.command(CommandId::DELETE) == OK);
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 0);
  e.setSelection({kRoot});  // into the root frame again
  REQUIRE(e.paste(clip, true) == 1);
  Guid pasted = e.selection()[0];
  Guid back = trackOf(e, pasted, VariableField::OPACITY);
  REQUIRE(back != kNoGuid);
  CHECK(back != original);
  CHECK(countType(doc, NodeType::KEYFRAME) == 2);
  CHECK(e.motionIndex().node(pasted)->bindings[0].params[0].timelineDef == kRoot);
  CHECK(doc.get(pasted)->props.opacity == doctest::Approx(0));
}

TEST_CASE("motion ownership: a detached instance's layers get copies of the main's tracks") {
  const Guid kMain{2, 1}, kMainRect{2, 2}, kInstance{2, 3};
  std::vector<NodeChange> nodes = baseChanges();
  nodes.push_back(make(kMain, NodeType::SYMBOL, kPage, "!", {0, 0, 100, 100}, "Main"));
  nodes.push_back(make(kMainRect, NodeType::ROUNDED_RECTANGLE, kMain, "!", {10, 10, 50, 50}, "Dot"));
  nodes.push_back(make(kRoot, NodeType::FRAME, kPage, "\"", {200, 0, 400, 300}, "Root"));
  NodeChange inst = make(kInstance, NodeType::INSTANCE, kRoot, "!", {20, 20, 100, 100}, "Main");
  inst.props.comp().symbolData.symbolID = kMain;
  nodes.push_back(inst);
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kPage);
  e.takeEvents();
  // The main is a timeline root: its layer is animated there.
  motion::State s = on(0);
  s.root = kMain;
  e.setMotion(s);
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"nodes":["2:2"],"field":{"type":"PROPERTY","name":"OPACITY"},"value":{"type":"FLOAT","value":0.25}})")) == OK);
  Guid mainTrack = trackOf(e, kMainRect, VariableField::OPACITY);
  REQUIRE(mainTrack != kNoGuid);
  e.setMotion(motion::State{});
  e.setSelection({kInstance});
  REQUIRE(e.command(CommandId::DETACH_INSTANCE) == OK);
  REQUIRE(e.document().children(kInstance).size() == 1);
  Guid detached = e.document().children(kInstance)[0];
  Guid own = trackOf(e, detached, VariableField::OPACITY);
  REQUIRE(own != kNoGuid);
  CHECK(own != mainTrack);
  CHECK(countType(e.document(), NodeType::KEYFRAME_TRACK) == 2);
  CHECK(e.motionIndex().node(detached)->bindings[0].params[0].timelineDef == kRoot);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(countType(e.document(), NodeType::KEYFRAME_TRACK) == 1);
}

TEST_CASE("motion edit: Move anchor point keeps the layer in place at the playhead") {
  Editor e;
  load(e);
  const Document& doc = e.document();
  const Node* r = doc.get(kRect);
  e.setSelection({kRect});
  e.setMotion(on(0));
  // Turned 90° about its centre: the anchor moved to the top-left would swing it.
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"field":{"type":"PROPERTY","name":"ROTATION"},"value":{"type":"FLOAT","value":90}})")) == OK);
  Mat2x3 before = r->props.transform;
  REQUIRE(e.command(CommandId::MOTION_SET_ANCHOR, args(R"({"x":0,"y":0})")) == OK);
  CHECK(r->props.transform.m02 == doctest::Approx(before.m02));
  CHECK(r->props.transform.m12 == doctest::Approx(before.m12));
  CHECK(r->props.transform.m01 == doctest::Approx(before.m01));
  // No position track: the base motionTransform takes the compensation, (I − L)(o − o') with o − o' = (50, 25).
  REQUIRE(e.motionLayer().baseOf(kRect));
  motion::LayerBase b = motion::decodeLayerBase(*e.motionLayer().baseOf(kRect));
  CHECK(b.originX.value == 0);
  Mat2x3 L = Mat2x3::rotate(-std::acos(-1.0) / 2);
  Vec2 keep = Vec2{50, 25} - L.applyLinear({50, 25});
  CHECK(b.translation.x == doctest::Approx(keep.x));
  CHECK(b.translation.y == doctest::Approx(keep.y));
  // With a position track, its keyframes take it.
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"field":{"type":"PROPERTY","name":"TRANSLATION_XY"},"value":{"type":"VECTOR","value":{"x":10,"y":0}}})")) == OK);
  before = r->props.transform;
  REQUIRE(e.command(CommandId::MOTION_SET_ANCHOR, args(R"({"x":100,"y":100})")) == OK);
  CHECK(r->props.transform.m02 == doctest::Approx(before.m02));
  CHECK(r->props.transform.m12 == doctest::Approx(before.m12));
  Guid track = trackOf(e, kRect, VariableField::MOTION_TRANSLATION_XY);
  CHECK(e.motionIndex().track(track)->keyframes[0].value.v.x != doctest::Approx(10));
  // One undo step: the anchor and its compensation together.
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(e.motionIndex().track(track)->keyframes[0].value.v.x == doctest::Approx(10));
  CHECK(r->props.transform.m02 == doctest::Approx(before.m02));
}
