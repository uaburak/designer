// Figma Motion, round 8a (docs/motion.md §4.3–§4.8, §5): the decoded model, keyframe easing, interpolation, track
// evaluation and the motion layer's preview writes — applied, restored bit-identically, put back before a transaction.
#include <cmath>
#include <cstdio>
#include <cstdlib>

#include "Helpers.h"
#include "doctest.h"
#include "editor/Editor.h"
#include "motion/Evaluate.h"
#include "motion/MotionLayer.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

// A page with a 2 s root frame (1:1) holding a rectangle (1:2) whose opacity, position and fill colour are keyframed:
// OPACITY stored ×100 (100 → 0 over 0–500 ms, Ease out), TRANSLATION_XY over 0–1000 ms with a curved motion path, the
// fill's colour red → blue over 0–1000 ms in OKLCH. The tracks are KEYFRAME_TRACK nodes on the internal canvas (7:1,
// 7:2, 7:3) with KEYFRAME children, bound through KEYFRAME expressions (docs/motion.md §4.2).
const char* kFile = R"([
  {"guid":"0:0","phase":"CREATED","type":"DOCUMENT","name":"Document"},
  {"guid":"0:1","phase":"CREATED","type":"CANVAS","name":"Page 1","parentIndex":{"guid":"0:0","position":"!"}},
  {"guid":"0:2","phase":"CREATED","type":"CANVAS","name":"Internal Only Canvas","internalOnly":true,"visible":false,"parentIndex":{"guid":"0:0","position":"~"}},
  {"guid":"1:1","phase":"CREATED","type":"FRAME","name":"Root","parentIndex":{"guid":"0:1","position":"!"},
   "size":{"x":400,"y":300},"transform":{"m00":1,"m01":0,"m02":0,"m10":0,"m11":1,"m12":0},
   "timelineDuration":2000000,"playbackStyle":"LOOP","timelineKeyframeSnappingFps":{"numerator":60,"denominator":1}},
  {"guid":"1:2","phase":"CREATED","type":"ROUNDED_RECTANGLE","name":"Rect","parentIndex":{"guid":"1:1","position":"!"},
   "size":{"x":100,"y":50},"transform":{"m00":1,"m01":0,"m02":20,"m10":0,"m11":1,"m12":30},"opacity":1,
   "fillPaints":[{"type":"SOLID","color":{"r":1,"g":0,"b":0,"a":1},"opacity":1,"visible":true,
     "colorVar":{"dataType":"EXPRESSION","resolvedDataType":"COLOR","value":{"expressionValue":{"expressionFunction":"KEYFRAME","expressionArguments":[
       {"dataType":"COLOR","resolvedDataType":"COLOR","value":{"colorValue":{"r":1,"g":0,"b":0,"a":1}}},
       {"dataType":"KEYFRAME_TRACK_PARAMETER_DATA","resolvedDataType":"KEYFRAME_TRACK_PARAMETER_DATA","value":{"keyframeTrackParameterValue":{"parameters":[
         {"type":"MANUAL","value":{"manual":{"keyframeTrackId":{"guid":"7:3"},"timelineDefId":"1:1"}}}]}}}]}}}}],
   "parameterConsumptionMap":{"entries":[
     {"variableField":"OPACITY","variableData":{"dataType":"EXPRESSION","resolvedDataType":"FLOAT","value":{"expressionValue":{"expressionFunction":"KEYFRAME","expressionArguments":[
       {"dataType":"FLOAT","resolvedDataType":"FLOAT","value":{"floatValue":100}},
       {"dataType":"KEYFRAME_TRACK_PARAMETER_DATA","resolvedDataType":"KEYFRAME_TRACK_PARAMETER_DATA","value":{"keyframeTrackParameterValue":{"parameters":[
         {"type":"MANUAL","value":{"manual":{"keyframeTrackId":{"guid":"7:1"},"timelineDefId":"1:1"}}}]}}}]}}}},
     {"variableField":"MOTION_TRANSLATION_XY","variableData":{"dataType":"EXPRESSION","resolvedDataType":"FLOAT","value":{"expressionValue":{"expressionFunction":"KEYFRAME","expressionArguments":[
       {"dataType":"FLOAT","resolvedDataType":"FLOAT","value":{"floatValue":0}},
       {"dataType":"KEYFRAME_TRACK_PARAMETER_DATA","resolvedDataType":"KEYFRAME_TRACK_PARAMETER_DATA","value":{"keyframeTrackParameterValue":{"parameters":[
         {"type":"MANUAL","value":{"manual":{"keyframeTrackId":{"guid":"7:2"},"timelineDefId":"1:1"}}}]}}}]}}}}]}},
  {"guid":"7:1","phase":"CREATED","type":"KEYFRAME_TRACK","name":"OPACITY","parentIndex":{"guid":"0:2","position":"!"},"keyframeOperation":"SET"},
  {"guid":"7:4","phase":"CREATED","type":"KEYFRAME","parentIndex":{"guid":"7:1","position":"!"},"timelinePosition":0,
   "keyframeValue":{"value":{"floatValue":100},"valueType":"FLOAT"}},
  {"guid":"7:5","phase":"CREATED","type":"KEYFRAME","parentIndex":{"guid":"7:1","position":"\""},"timelinePosition":500000,
   "keyframeValue":{"value":{"floatValue":0},"valueType":"FLOAT"},"easingData":{"easingType":"OUT_CUBIC"}},
  {"guid":"7:2","phase":"CREATED","type":"KEYFRAME_TRACK","name":"MOTION_TRANSLATION_XY","parentIndex":{"guid":"0:2","position":"\""},"keyframeOperation":"OFFSET"},
  {"guid":"7:6","phase":"CREATED","type":"KEYFRAME","parentIndex":{"guid":"7:2","position":"!"},"timelinePosition":0,
   "keyframeValue":{"value":{"vectorValue":{"x":0,"y":0}},"valueType":"VECTOR"},"motionPathBezierHandles":{"p1x":0,"p1y":0,"p2x":0,"p2y":-100}},
  {"guid":"7:7","phase":"CREATED","type":"KEYFRAME","parentIndex":{"guid":"7:2","position":"\""},"timelinePosition":1000000,
   "keyframeValue":{"value":{"vectorValue":{"x":200,"y":0}},"valueType":"VECTOR"},"easingData":{"easingType":"LINEAR"},"motionPathBezierHandles":{"p1x":0,"p1y":-100,"p2x":0,"p2y":0}},
  {"guid":"7:3","phase":"CREATED","type":"KEYFRAME_TRACK","name":"fills[0]","parentIndex":{"guid":"0:2","position":"#"},"keyframeOperation":"SET"},
  {"guid":"7:8","phase":"CREATED","type":"KEYFRAME","parentIndex":{"guid":"7:3","position":"!"},"timelinePosition":0,
   "keyframeValue":{"value":{"colorValue":{"r":1,"g":0,"b":0,"a":1}},"valueType":"COLOR"}},
  {"guid":"7:9","phase":"CREATED","type":"KEYFRAME","parentIndex":{"guid":"7:3","position":"\""},"timelinePosition":1000000,
   "keyframeValue":{"value":{"colorValue":{"r":0,"g":0,"b":1,"a":1}},"valueType":"COLOR"},"easingData":{"easingType":"LINEAR"},
   "interpolationColorSpace":"OKLCH","interpolationHueMethod":"SHORTER"}
])";

const Guid kRoot{1, 1}, kRect{1, 2};

std::vector<NodeChange> file() {
  json::Value v;
  REQUIRE(json::parse(kFile, v));
  return codec::readChanges(v);
}

Editor& editorWith(Editor& e) {
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(file(), Guid{0, 1});
  e.takeEvents();
  return e;
}

motion::State on(int64_t timeUs, Guid root = kRoot) {
  motion::State s;
  s.on = true;
  s.root = root;
  s.timeUs = timeUs;
  return s;
}

}  // namespace

TEST_CASE("motion: the model is decoded from the document (tracks, keyframes, bindings, the timeline)") {
  Editor e;
  editorWith(e);
  const motion::MotionIndex& ix = e.motionIndex();
  CHECK(ix.trackCount() == 3);
  CHECK(ix.nodeCount() == 1);
  const motion::Track* op = ix.track({7, 1});
  REQUIRE(op);
  CHECK(op->operation == motion::Operation::SET);
  REQUIRE(op->keyframes.size() == 2);
  CHECK(op->keyframes[0].timeUs == 0);
  CHECK(op->keyframes[0].value.f == 100);
  CHECK(op->keyframes[1].timeUs == 500000);
  CHECK(op->keyframes[1].easing.present);
  CHECK(op->keyframes[1].easing.type == motion::EasingType::OUT_CUBIC);
  CHECK_FALSE(op->keyframes[0].easing.present);  // no easing: plays as CUSTOM_CUBIC (0.5, 0, 0.5, 1)
  const motion::Track* xy = ix.track({7, 2});
  REQUIRE(xy);
  CHECK(xy->operation == motion::Operation::OFFSET);
  CHECK(xy->keyframes[0].hasPathHandles);
  CHECK(xy->keyframes[0].pathOut.y == -100);
  const motion::Track* color = ix.track({7, 3});
  REQUIRE(color);
  CHECK(color->keyframes[1].colorSpace == motion::ColorSpace::OKLCH);
  const motion::AnimatedNode* an = ix.node(kRect);
  REQUIRE(an);
  REQUIRE(an->bindings.size() == 3);
  // Paints first in the file's order? The node fields come first (parameterConsumptionMap), then the paints.
  CHECK(an->bindings[0].slot.kind == motion::Slot::Kind::NODE);
  CHECK(an->bindings[0].slot.field == VariableField::OPACITY);
  CHECK(an->bindings[0].base.kind == VariableData::Kind::FLOAT);
  CHECK(an->bindings[0].base.floatValue == 100);
  REQUIRE(an->bindings[0].params.size() == 1);
  CHECK(an->bindings[0].params[0].track == Guid{7, 1});
  CHECK(an->bindings[0].params[0].timelineDef == kRoot);
  CHECK(an->bindings[1].slot.field == VariableField::MOTION_TRANSLATION_XY);
  CHECK(an->bindings[2].slot.kind == motion::Slot::Kind::FILL_COLOR);
  CHECK(an->bindings[2].params[0].track == Guid{7, 3});
  // The timeline: the root's own fields.
  CHECK(ix.rootOf(e.document(), kRect) == kRoot);
  CHECK(ix.rootOf(e.document(), kRoot) == kRoot);
  motion::Timeline tl = ix.timeline(e.document(), kRoot);
  CHECK(tl.durationUs == 2000000);
  CHECK(tl.playback == motion::Playback::LOOP);
  CHECK(tl.fpsNumerator == 60);
  CHECK(ix.animatedUnder(e.document(), kRoot) == std::vector<Guid>{kRect});
}

TEST_CASE("motion: keyframe easing — the default curve, Figma's presets, HOLD, normalised springs") {
  motion::EasingSpec none;
  CHECK(motion::easeKeyframe(none, 0.5) == doctest::Approx(motion::cubicBezier(0.5, 0, 0.5, 1, 0.5)));
  motion::EasingSpec inCubic;
  inCubic.present = true;
  inCubic.type = motion::EasingType::IN_CUBIC;  // the kiwi default: "no easing"
  CHECK(motion::easeKeyframe(inCubic, 0.25) == doctest::Approx(motion::cubicBezier(0.5, 0, 0.5, 1, 0.25)));
  motion::EasingSpec easeIn;
  easeIn.present = true;
  easeIn.type = motion::EasingType::EASE_IN;
  CHECK(motion::easeKeyframe(easeIn, 0.5) == doctest::Approx(motion::cubicBezier(0.42, 0, 1, 1, 0.5)));
  motion::EasingSpec hold;
  hold.present = true;
  hold.type = motion::EasingType::HOLD;
  CHECK(motion::easeKeyframe(hold, 0.999) == 0);
  CHECK(motion::easeKeyframe(hold, 1) == 1);
  motion::EasingSpec gentle;
  gentle.present = true;
  gentle.type = motion::EasingType::GENTLE_SPRING;
  CHECK(motion::easeKeyframe(gentle, 0) == 0);
  CHECK(motion::easeKeyframe(gentle, 1) == 1);  // normalised: settles exactly at the segment's end
  bool overshoot = false;
  for (double p = 0; p <= 1; p += 0.01) overshoot |= motion::easeKeyframe(gentle, p) > 1.0001;
  CHECK(overshoot);  // GENTLE (ζ 0.75) overshoots a little
  // Bounce 0 (ζ = 1): no overshoot. Bounce ↔ physical round trip.
  motion::Spring noBounce = motion::springFromBounce(0);
  CHECK(motion::bounceOf(noBounce) == doctest::Approx(0).epsilon(1e-3));
  CHECK(noBounce.damping == doctest::Approx(20).epsilon(1e-3));  // {1, 100, 20(1 − 0)}
  motion::Spring half = motion::springFromBounce(0.5);
  CHECK(motion::bounceOf(half) == doctest::Approx(0.5));
  CHECK(half.damping == doctest::Approx(10));
  CHECK(motion::bounceOf(motion::kGentle) == doctest::Approx(0.25));
  motion::EasingSpec custom;
  custom.present = true;
  custom.type = motion::EasingType::CUSTOM_SPRING;
  custom.spring = noBounce;
  for (double p = 0; p <= 1; p += 0.01) CHECK(motion::easeKeyframe(custom, p) <= 1 + 1e-9);
}

TEST_CASE("motion: interpolation — floats, colour spaces, the motion path by arc length; playback styles") {
  CHECK(motion::lerp(10, 20, 0.25) == 12.5);
  Color red{1, 0, 0, 1}, blue{0, 0, 1, 1};
  Color mid = motion::lerpColor(red, blue, 0.5, motion::ColorSpace::DEFAULT, motion::HueMethod::SHORTER);
  CHECK(mid.r == doctest::Approx(0.5));
  CHECK(mid.b == doctest::Approx(0.5));
  // OKLCH keeps chroma through the middle (sRGB's midpoint is a dull purple; OKLCH's is a saturated one).
  Color ok = motion::lerpColor(red, blue, 0.5, motion::ColorSpace::OKLCH, motion::HueMethod::SHORTER);
  CHECK(ok.r + ok.b > mid.r + mid.b);
  // LONGER goes the other way round the hue circle: red → blue through green.
  Color lng = motion::lerpColor(red, blue, 0.5, motion::ColorSpace::HSL, motion::HueMethod::LONGER);
  CHECK(lng.g > 0.9);
  Color shorter = motion::lerpColor(red, blue, 0.5, motion::ColorSpace::HSL, motion::HueMethod::SHORTER);
  CHECK(shorter.g < 0.1);
  // Alpha linear.
  CHECK(motion::lerpColor({0, 0, 0, 0}, {0, 0, 0, 1}, 0.25, motion::ColorSpace::OKLAB, motion::HueMethod::SHORTER).a == doctest::Approx(0.25));
  // A straight segment: linear in e. A curved one: e by arc length, so the midpoint is on the curve's middle.
  CHECK(motion::motionPathPoint({0, 0}, {0, 0}, {0, 0}, {200, 0}, 0.25) == Vec2{50, 0});
  Vec2 curved = motion::motionPathPoint({0, 0}, {0, -100}, {0, -100}, {200, 0}, 0.5);
  CHECK(curved.x == doctest::Approx(100).epsilon(0.01));
  CHECK(curved.y == doctest::Approx(-75).epsilon(0.01));  // the cubic's apex: 3/4 of the handles' height
  // Equal-time spacing is ∝ speed: with LINEAR easing arc-length steps are equal.
  double d1 = (motion::motionPathPoint({0, 0}, {0, -100}, {0, -100}, {200, 0}, 0.1) - motion::motionPathPoint({0, 0}, {0, -100}, {0, -100}, {200, 0}, 0.0)).length();
  double d2 = (motion::motionPathPoint({0, 0}, {0, -100}, {0, -100}, {200, 0}, 0.5) - motion::motionPathPoint({0, 0}, {0, -100}, {0, -100}, {200, 0}, 0.4)).length();
  CHECK(d1 == doctest::Approx(d2).epsilon(0.03));
  // Playback styles.
  CHECK(motion::localTime(2500000, 2000000, motion::Playback::ONCE) == 2000000);
  CHECK(motion::localTime(2500000, 2000000, motion::Playback::LOOP) == 500000);
  CHECK(motion::localTime(2500000, 2000000, motion::Playback::BOOMERANG) == 1500000);
  CHECK(motion::localTime(4500000, 2000000, motion::Playback::BOOMERANG) == 500000);
  CHECK(motion::localTime(-500000, 2000000, motion::Playback::LOOP) == 1500000);
}

TEST_CASE("motion: a track's value before, between and after its keyframes; SET / OFFSET / SCALE folds") {
  motion::Track t;
  motion::Keyframe a, b;
  a.timeUs = 200000;
  a.value = motion::KeyframeValue::number(10);
  b.timeUs = 600000;
  b.value = motion::KeyframeValue::number(30);
  b.easing.present = true;
  b.easing.type = motion::EasingType::LINEAR;
  t.keyframes = {a, b};
  motion::KeyframeValue v;
  REQUIRE(motion::trackValue(t, 0, v));
  CHECK(v.f == 10);  // the first value holds back to 0
  REQUIRE(motion::trackValue(t, 400000, v));
  CHECK(v.f == doctest::Approx(20));
  REQUIRE(motion::trackValue(t, 900000, v));
  CHECK(v.f == 30);
  // HOLD: the previous value until the keyframe.
  t.keyframes[1].easing.type = motion::EasingType::HOLD;
  REQUIRE(motion::trackValue(t, 599999, v));
  CHECK(v.f == 10);
  REQUIRE(motion::trackValue(t, 600000, v));
  CHECK(v.f == 30);
  // Folds over a base.
  t.keyframes[1].easing.type = motion::EasingType::LINEAR;
  auto lookup = [&](Guid) { return &t; };
  motion::Param p;
  motion::KeyframeValue out;
  t.operation = motion::Operation::SET;
  REQUIRE(motion::foldValue(motion::KeyframeValue::number(5), {p}, 400000, lookup, out));
  CHECK(out.f == doctest::Approx(20));
  t.operation = motion::Operation::OFFSET;
  REQUIRE(motion::foldValue(motion::KeyframeValue::number(5), {p}, 400000, lookup, out));
  CHECK(out.f == doctest::Approx(25));
  t.operation = motion::Operation::SCALE;
  REQUIRE(motion::foldValue(motion::KeyframeValue::number(5), {p}, 400000, lookup, out));
  CHECK(out.f == doctest::Approx(100));
  // An empty track applies nothing.
  motion::Track empty;
  auto none = [&](Guid) { return &empty; };
  CHECK_FALSE(motion::foldValue(motion::KeyframeValue::number(5), {p}, 400000, none, out));
  CHECK(out.f == 5);
}

TEST_CASE("motion: the layer writes the evaluated values at the playhead and restores the base bit-identically") {
  Editor e;
  editorWith(e);
  const Document& doc = e.document();
  std::string before = codec::writeMessage(1, e.encodeDocument());
  // t = 250 ms: opacity half-way through Ease out (above 0.5), the rect on its path, the fill between red and blue.
  e.setMotion(on(250000));
  const Node* r = doc.get(kRect);
  REQUIRE(r);
  double eased = motion::cubicBezier(0, 0, 0.58, 1, 0.5);
  CHECK(r->props.opacity == doctest::Approx(1 - eased));
  CHECK(r->props.opacity < 0.5);
  CHECK(r->props.transform.m02 > 20);  // moved along +x
  CHECK(r->props.transform.m12 < 30);  // and up along the curved path
  CHECK(r->props.fillPaints[0].color.r < 1);
  CHECK(r->props.fillPaints[0].color.b > 0);
  CHECK(e.motionLayer().active());
  CHECK(e.motionLayer().baseOf(kRect)->opacity == 1);
  // The world transform (hit-testing, bounds) follows the preview write.
  CHECK(doc.worldTransform(kRect).m02 == r->props.transform.m02);
  // t = 1 s: opacity 0 (after its last keyframe), translation (200, 0): x = 220.
  e.setMotion(on(1000000));
  CHECK(r->props.opacity == 0);
  CHECK(r->props.transform.m02 == doctest::Approx(220));
  CHECK(r->props.transform.m12 == doctest::Approx(30));
  CHECK(r->props.fillPaints[0].color.b == doctest::Approx(1));
  // Past the duration the LOOP wraps: t = 2.25 s plays as 250 ms.
  e.setMotion(on(2250000));
  CHECK(r->props.opacity == doctest::Approx(1 - eased));
  // Nothing of this is in the document: storage reads base values (the suspend), and off restores them.
  {
    auto guard = e.motionSuspended();
    CHECK(r->props.opacity == 1);
    CHECK(codec::writeMessage(1, e.encodeDocument()) == before);
  }
  CHECK(r->props.opacity == doctest::Approx(1 - eased));  // applied again after the scope
  motion::State off;
  e.setMotion(off);
  CHECK_FALSE(e.motionLayer().active());
  CHECK(r->props.opacity == 1);
  CHECK(r->props.transform.m02 == 20);
  CHECK(codec::writeMessage(1, e.encodeDocument()) == before);
  // No DOCUMENT_CHANGED came from any of it.
  Editor::Events ev = e.takeEvents();
  CHECK(ev.documents.empty());
  CHECK(ev.motion);
}

TEST_CASE("motion: a transaction reads and writes base values; the layer applies again after the commit") {
  Editor e;
  editorWith(e);
  const Document& doc = e.document();
  e.setMotion(on(1000000));
  const Node* r = doc.get(kRect);
  REQUIRE(r->props.opacity == 0);
  // A panel write of the rectangle's name: the step's message carries only the name, and the preview is back after.
  NodeChange c = NodeChange::changed(kRect);
  c.mask = F_NAME;
  c.props.name = "Renamed";
  REQUIRE(e.setProps({kRect}, c, 0) == OK);
  CHECK(r->props.opacity == 0);  // applied again
  CHECK(r->props.name == "Renamed");
  Editor::Events ev = e.takeEvents();
  REQUIRE(ev.documents.size() == 1);
  REQUIRE(ev.documents[0].changes.size() == 1);
  CHECK((ev.documents[0].changes[0].mask & F_OPACITY) == 0);
  CHECK((ev.documents[0].changes[0].mask & F_TRANSFORM) == 0);
  // The undo step holds base values too: undo, then the base is still 1 under the preview.
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(r->props.name == "Rect");
  CHECK(r->props.opacity == 0);
  motion::State off;
  e.setMotion(off);
  CHECK(r->props.opacity == 1);
  CHECK(r->props.transform.m02 == 20);
  // The resolver reads a KEYFRAME expression as its base argument (Motion off: the static design).
  Editor::Resolved res;
  REQUIRE(e.resolveValue(r->props.parameterConsumptionMap[0].data, kRect, res));
  CHECK(res.kind == Editor::Resolved::Kind::FLOAT);
  CHECK(res.f == 100);
}

TEST_CASE("motion: the motion transform pivots on the anchor; rotation stored −radians is counter-clockwise degrees") {
  motion::LayerBase anchor;  // 50 % / 50 %
  Mat2x3 layout = Mat2x3::translate(20, 30);
  // A 100 × 50 layer scaled ×2 about its centre keeps its centre: the centre (70, 55) stays.
  Mat2x3 m = motion::MotionLayer::motionTransform(layout, {100, 50}, anchor, {0, 0}, 0, {2, 2}, 0);
  Vec2 c = m.apply({50, 25});
  CHECK(c.x == doctest::Approx(70));
  CHECK(c.y == doctest::Approx(55));
  CHECK(m.apply({0, 0}).x == doctest::Approx(20 - 50));
  // A translation moves it as is.
  m = motion::MotionLayer::motionTransform(layout, {100, 50}, anchor, {10, -5}, 0, {1, 1}, 0);
  CHECK(m.m02 == doctest::Approx(30));
  CHECK(m.m12 == doctest::Approx(25));
  // Stored −π/2 is 90° counter-clockwise: the point right of the centre goes up (y down on the canvas).
  const motion::FieldInfo* rot = motion::fieldInfo(VariableField::MOTION_ROTATION);
  REQUIRE(rot);
  CHECK(motion::storedToNode(*rot, -3.14159265358979323846 / 2) == doctest::Approx(90));
  CHECK(motion::nodeToStored(*rot, 90) == doctest::Approx(-3.14159265358979323846 / 2));
  m = motion::MotionLayer::motionTransform(Mat2x3{}, {100, 50}, anchor, {0, 0}, -3.14159265358979323846 / 2, {1, 1}, 0);
  Vec2 right = m.apply({100, 25});  // the centre is (50, 25); this point is 50 to its right
  CHECK(right.x == doctest::Approx(50));
  CHECK(right.y == doctest::Approx(-25));
  // Units: OPACITY stored ×100.
  const motion::FieldInfo* op = motion::fieldInfo(VariableField::OPACITY);
  REQUIRE(op);
  CHECK(motion::storedToNode(*op, 50) == 0.5);
  CHECK(motion::clampWrite(*op, 1.5) == 1);
  CHECK(motion::fieldByPublicName("TRANSLATION_XY")->field == VariableField::MOTION_TRANSLATION_XY);
  CHECK(motion::fieldInfo(VariableField::X_POSITION) == nullptr);
}

// MOTION_SHOT_DIR=<dir>: writes the fixture's evaluated frames (every 100 ms of the 2 s loop) as JSON for a contact sheet
// (scripts/motion-frames.mjs draws them); skipped otherwise — a look at the evaluator's output, not a check.
TEST_CASE("motion: frames of the fixture as JSON (MOTION_SHOT_DIR)") {
  const char* dir = std::getenv("MOTION_SHOT_DIR");
  if (!dir) return;
  Editor e;
  editorWith(e);
  const Document& doc = e.document();
  std::string out = "[";
  for (int64_t t = 0; t <= 2000000; t += 100000) {
    e.setMotion(on(t));
    const Node* r = doc.get(kRect);
    const Node* root = doc.get(kRoot);
    const Paint& fill = r->props.fillPaints[0];
    char buf[512];
    std::snprintf(buf, sizeof buf,
                  "%s{\"t\":%lld,\"root\":{\"w\":%g,\"h\":%g},\"rect\":{\"x\":%g,\"y\":%g,\"w\":%g,\"h\":%g,\"opacity\":%g,\"fill\":[%g,%g,%g,%g]}}",
                  t ? "," : "", static_cast<long long>(t), root->props.size.x, root->props.size.y, r->props.transform.m02, r->props.transform.m12,
                  r->props.size.x, r->props.size.y, r->props.opacity, fill.color.r, fill.color.g, fill.color.b, fill.color.a);
    out += buf;
  }
  out += "]";
  std::string path = std::string(dir) + "/motion-frames.json";
  FILE* f = std::fopen(path.c_str(), "wb");
  REQUIRE(f);
  std::fwrite(out.data(), 1, out.size(), f);
  std::fclose(f);
  MESSAGE("wrote " << path);
}
