// Figma Motion, round 8a increment 2 (docs/motion.md §4.3, §4.5, §4.13, §6.4, §7.2): an animated component's instances
// playing their main's timeline placed in their container's (`timelineAssignments`, nested offsets, the purple bar's
// command), layout run again for sizes, paddings and gaps at the playhead (siblings move, as previews), path trim cutting
// the stroke's centre line, static exports and thumbnails drawing the base values (or the timeline at `motionTimeUs`),
// and the canvas's motion path and anchor point tool.
#include <cmath>

#include "Helpers.h"
#include "base/DerivedIds.h"
#include "doctest.h"
#include "editor/Editor.h"
#include "geometry/NodeGeometry.h"
#include "geometry/Path.h"
#include "motion/Evaluate.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

CommandArgs args(const std::string& json) {
  CommandArgs a;
  REQUIRE(json::parse(json, a.raw));
  return a;
}

json::Value parsed(const std::string& text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  return v;
}

motion::State on(Guid root, int64_t timeUs) {
  motion::State s;
  s.on = true;
  s.root = root;
  s.timeUs = timeUs;
  return s;
}

void load(Editor& e, const std::vector<NodeChange>& nodes) {
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kPage);
  e.takeEvents();
}

// Two keyframes of a FLOAT field on `node` (public units), made through MOTION_ADD_KEYFRAME, linear between them.
void key2(Editor& e, Guid node, const char* field, double t0, double v0, double t1, double v1) {
  for (auto [t, v] : {std::pair{t0, v0}, std::pair{t1, v1}}) {
    std::string a = std::string(R"({"nodes":[")") + node.toString() + R"("],"field":{"type":"PROPERTY","name":")" + field +
                    R"("},"timeUs":)" + std::to_string(static_cast<int64_t>(t)) + R"(,"value":{"type":"FLOAT","value":)" + std::to_string(v) +
                    R"(},"easing":{"type":"LINEAR"}})";
    REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(a)) == OK);
  }
}

double lengthOf(const geom::Path& p) {
  double L = 0;
  for (const geom::Polyline& pl : geom::flatten(p, 0.01)) {
    for (size_t i = 1; i < pl.points.size(); i++) L += (pl.points[i] - pl.points[i - 1]).length();
    if (pl.closed && pl.points.size() > 1) L += (pl.points.front() - pl.points.back()).length();
  }
  return L;
}

// ---- Instances ------------------------------------------------------------------------------------------------------

// A main "Pulse" (2:1, a component: its own timeline, 1 s LOOP) whose dot (2:2) fades 1 → 0 over its second; a "Row"
// main (3:1) holding an instance of Pulse (3:2); a top-level frame "Screen" (1:1) holding an instance of Pulse (1:2) and
// an instance of Row (1:3).
const Guid kScreen{1, 1}, kPulseI{1, 2}, kRowI{1, 3}, kPulse{2, 1}, kDot{2, 2}, kRow{3, 1}, kNested{3, 2};

std::vector<NodeChange> instanceDoc() {
  auto nodes = baseChanges();
  nodes.push_back(make(kScreen, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "Screen"));
  NodeChange pulse = make(kPulse, NodeType::SYMBOL, kPage, "\"", {500, 0, 40, 40}, "Pulse");
  nodes.push_back(pulse);
  nodes.push_back(make(kDot, NodeType::ELLIPSE, kPulse, "!", {0, 0, 40, 40}, "Dot"));
  nodes.push_back(make(kRow, NodeType::SYMBOL, kPage, "#", {600, 0, 100, 40}, "Row"));
  NodeChange nested = make(kNested, NodeType::INSTANCE, kRow, "!", {0, 0, 40, 40}, "Pulse");
  nested.props.comp().symbolData.symbolID = kPulse;
  nodes.push_back(nested);
  NodeChange pi = make(kPulseI, NodeType::INSTANCE, kScreen, "!", {10, 10, 40, 40}, "Pulse");
  pi.props.comp().symbolData.symbolID = kPulse;
  nodes.push_back(pi);
  NodeChange ri = make(kRowI, NodeType::INSTANCE, kScreen, "\"", {10, 100, 100, 40}, "Row");
  ri.props.comp().symbolData.symbolID = kRow;
  nodes.push_back(ri);
  return nodes;
}

void animatePulse(Editor& e) {
  e.setMotion(on(kPulse, 0));
  REQUIRE(e.command(CommandId::MOTION_SET_TIMELINE, args(R"({"root":"2:1","durationUs":1000000,"playback":"LOOP"})")) == OK);
  key2(e, kDot, "OPACITY", 0, 1, 1000000, 0);
}

}  // namespace

TEST_CASE("motion layer: an animated component's instances play its timeline, offset where they sit, nested offsets composed") {
  Editor e;
  load(e, instanceDoc());
  animatePulse(e);
  const motion::MotionIndex& ix = e.motionIndex();
  CHECK(ix.plays(kPulse));
  CHECK(ix.plays(kRow));     // through its instance of Pulse
  CHECK(ix.plays(kScreen));  // through both instances
  Guid dotRow = derived::intern(kPulseI, {kDot});
  Guid nestedDot = derived::intern(kRowI, {kNested, kDot});
  const Document& doc = e.document();
  REQUIRE(doc.has(dotRow));
  REQUIRE(doc.has(nestedDot));
  // The Screen at 250 ms: both play Pulse's time — the dot 3/4 opaque — and the main's own dot rests (another root).
  e.setMotion(on(kScreen, 250000));
  CHECK(doc.get(dotRow)->props.opacity == doctest::Approx(0.75));
  CHECK(doc.get(nestedDot)->props.opacity == doctest::Approx(0.75));
  CHECK(doc.get(kDot)->props.opacity == 1);
  // The Pulse instance moved 500 ms later in the Screen's time (its purple bar dragged): one undo step.
  REQUIRE(e.command(CommandId::MOTION_SET_INSTANCE_OFFSET, args(R"({"instance":"1:2","offsetUs":500000})")) == OK);
  motion::Assignment a = motion::decodeAssignment(doc.get(kPulseI)->props, kPulse, kScreen);
  CHECK(a.found);
  CHECK(a.offsetUs == 500000);
  CHECK(e.undoStack().undoLabel() == "Move animation");
  // 250 ms in the Screen is −250 ms for it: LOOP wraps it to 750 ms.
  CHECK(doc.get(dotRow)->props.opacity == doctest::Approx(0.25));
  CHECK(doc.get(nestedDot)->props.opacity == doctest::Approx(0.75));
  // The nested one inside Row, 200 ms later in Row's time (its assignment says Row is its container): at 450 ms in
  // the Screen it is at 250 ms.
  NodeChange nested = NodeChange::changed(kNested);
  nested.mask = F_EXTRA;
  nested.props.extra["timelineAssignments"] = codec::extraFromJson(
      "NodeChange", "timelineAssignments",
      parsed(R"({"entries":[{"key":{"assignedTimelineId":"2:1","containingTimelineId":"3:1"},"value":{"offsetUs":200000}}]})"));
  REQUIRE(e.setProps({kNested}, nested, 0) == OK);
  e.setMotion(on(kScreen, 450000));
  CHECK(doc.get(nestedDot)->props.opacity == doctest::Approx(0.75));
  // Disabled: the instance's sublayers rest.
  nested.props.extra["timelineAssignments"] = codec::extraFromJson(
      "NodeChange", "timelineAssignments",
      parsed(R"({"entries":[{"key":{"assignedTimelineId":"2:1","containingTimelineId":"3:1"},"value":{"offsetUs":200000,"disabled":true}}]})"));
  REQUIRE(e.setProps({kNested}, nested, 0) == OK);
  CHECK(doc.get(nestedDot)->props.opacity == 1);
  // The timeline model: each instance whose main plays is one layer with its bar (offset, the main's duration).
  json::Writer w;
  e.writeMotionTimeline(w, kScreen);
  json::Value tl = parsed(w.take());
  const json::Value* layers = tl.get("layers");
  REQUIRE(layers);
  REQUIRE(layers->array.size() == 2);
  const json::Value& top = layers->array[0];  // Row is above Pulse in Layers
  CHECK(top.get("node")->string == "1:3");
  REQUIRE(top.get("instance"));
  CHECK(top.get("instance")->get("durationUs")->number == 2000000);  // Row's own timeline (the default 2 s)
  const json::Value& pulseLayer = layers->array[1];
  CHECK(pulseLayer.get("instance")->get("offsetUs")->number == 500000);
  CHECK(pulseLayer.get("instance")->get("mainTimeline")->string == "2:1");
  CHECK(pulseLayer.get("startUs")->number == 500000);
  CHECK(pulseLayer.get("endUs")->number == 1500000);
  // The resolved model lists the sublayers in the Screen's time (the disabled one rests: not listed).
  json::Writer r;
  e.writeMotionResolved(r, kScreen);
  json::Value res = parsed(r.take());
  REQUIRE(res.get("layers")->array.size() == 1);
  const json::Value& first = res.get("layers")->array[0];
  CHECK(first.get("node")->string == dotRow.toString());
  CHECK(first.get("properties")->array[0].get("keyframes")->array[0].get("timeUs")->number == 500000);
  // Restored bit-identically when Motion ends; the derived rows rest.
  e.setMotion(motion::State{});
  CHECK(doc.get(dotRow)->props.opacity == 1);
  CHECK(doc.get(nestedDot)->props.opacity == 1);
  // Errors: a layer that isn't an instance, a derived row.
  e.setMotion(on(kScreen, 0));
  CHECK(e.command(CommandId::MOTION_SET_INSTANCE_OFFSET, args(R"({"instance":"1:1","offsetUs":0})")) == E_INVALID);
  CHECK(e.command(CommandId::MOTION_SET_INSTANCE_OFFSET, args(R"({"offsetUs":0})")) == E_INVALID);
}

// ---- Layout ---------------------------------------------------------------------------------------------------------

TEST_CASE("motion layer: WIDTH and paddings at the playhead lay the auto-layout frame out again — as previews, never journaled") {
  // A hugging horizontal row (1:1, a top-level frame: the root) of A (1:2) and B (1:3), 10 apart.
  const Guid H{1, 1}, A{1, 2}, B{1, 3};
  auto nodes = baseChanges();
  NodeChange h = make(H, NodeType::FRAME, kPage, "!", {0, 0, 110, 20}, "Row");
  h.props.stack().stackMode = StackMode::HORIZONTAL;
  h.props.stack().stackSpacing = 10;
  h.props.stack().stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  h.props.stack().stackCounterSizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  nodes.push_back(h);
  nodes.push_back(make(A, NodeType::ROUNDED_RECTANGLE, H, "!", {0, 0, 50, 20}, "A"));
  nodes.push_back(make(B, NodeType::ROUNDED_RECTANGLE, H, "\"", {60, 0, 50, 20}, "B"));
  Editor e;
  load(e, nodes);
  e.setMotion(on(H, 0));
  key2(e, A, "WIDTH", 0, 50, 1000000, 150);
  const Document& doc = e.document();
  size_t undo = e.undoStack().undoCount();
  e.takeEvents();
  // Halfway: A is 100 wide, B moves to 110, the row hugs them (220).
  e.setMotion(on(H, 500000));
  CHECK(doc.get(A)->props.size.x == doctest::Approx(100));
  CHECK(doc.get(B)->props.transform.m02 == doctest::Approx(110));
  CHECK(doc.get(H)->props.size.x == doctest::Approx(160));
  auto ev = e.takeEvents();
  CHECK(ev.documents.empty());  // preview writes: no DOCUMENT_CHANGED
  CHECK(e.undoStack().undoCount() == undo);
  {
    // What storage, exports and transactions read: the base values (B back at 60, the row 110 wide).
    auto base = e.motionSuspended();
    CHECK(doc.get(A)->props.size.x == 50);
    CHECK(doc.get(B)->props.transform.m02 == doctest::Approx(60));
    CHECK(doc.get(H)->props.size.x == doctest::Approx(110));
  }
  CHECK(doc.get(B)->props.transform.m02 == doctest::Approx(110));
  // An edit commits on the base and the layout at the playhead comes back after it.
  NodeChange rename = NodeChange::changed(A);
  rename.mask = F_NAME;
  rename.props.name = "Wide";
  REQUIRE(e.setProps({A}, rename, 0) == OK);
  CHECK(doc.get(B)->props.transform.m02 == doctest::Approx(110));
  e.setMotion(motion::State{});
  CHECK(doc.get(A)->props.size.x == 50);
  CHECK(doc.get(B)->props.transform.m02 == 60);
  CHECK(doc.get(H)->props.size.x == 110);
}

TEST_CASE("motion layer: a gap on a nested auto-layout frame moves its children at the playhead") {
  // A root (1:1) holding a vertical stack (1:2, fixed size) of two rows (1:3, 1:4); the stack's gap goes 0 → 20.
  const Guid R{1, 1}, S{1, 2}, X{1, 3}, Y{1, 4};
  auto nodes = baseChanges();
  nodes.push_back(make(R, NodeType::FRAME, kPage, "!", {0, 0, 300, 300}, "Root"));
  NodeChange s = make(S, NodeType::FRAME, R, "!", {10, 10, 100, 200}, "Stack");
  s.props.stack().stackMode = StackMode::VERTICAL;
  nodes.push_back(s);
  nodes.push_back(make(X, NodeType::ROUNDED_RECTANGLE, S, "!", {0, 0, 100, 30}, "X"));
  nodes.push_back(make(Y, NodeType::ROUNDED_RECTANGLE, S, "\"", {0, 30, 100, 30}, "Y"));
  Editor e;
  load(e, nodes);
  e.setMotion(on(R, 0));
  key2(e, S, "STACK_SPACING", 0, 0, 1000000, 20);
  e.setMotion(on(R, 1000000));
  const Document& doc = e.document();
  CHECK(doc.get(S)->props.stack().stackSpacing == doctest::Approx(20));
  CHECK(doc.get(Y)->props.transform.m12 == doctest::Approx(50));
  e.setMotion(on(R, 0));
  CHECK(doc.get(Y)->props.transform.m12 == doctest::Approx(30));
}

// ---- Path trim ------------------------------------------------------------------------------------------------------

TEST_CASE("motion layer: path trim — open, closed, wrapping; the caps; the geometry's stroke and the motion layer's track") {
  // An open line: [0.25, 0.75] of its length, the ends cut there; start > end on an open path: [end, start].
  geom::Path line;
  line.moveTo({0, 0});
  line.lineTo({100, 0});
  std::vector<geom::TrimmedContour> kept;
  geom::Path t = geom::trimPath(line, 0.25, 0.75, &kept);
  CHECK(lengthOf(t) == doctest::Approx(50));
  CHECK(t.points.front().x == doctest::Approx(25));
  CHECK(t.points.back().x == doctest::Approx(75));
  REQUIRE(kept.size() == 1);
  CHECK_FALSE(kept[0].ownStart);
  CHECK_FALSE(kept[0].ownEnd);
  t = geom::trimPath(line, 0.6, 0, &kept);
  CHECK(lengthOf(t) == doctest::Approx(60));
  CHECK(kept[0].ownStart);
  // A cubic: the piece is a cubic, and its length the share of the arc.
  geom::Path curve;
  curve.moveTo({0, 0});
  curve.cubicTo({0, 100}, {100, 100}, {100, 0});
  double whole = lengthOf(curve);
  CHECK(lengthOf(geom::trimPath(curve, 0, 0.5)) == doctest::Approx(whole / 2).epsilon(0.01));
  // A closed square (400 around): whole at [0, 1] (still closed), 200 for [0.75, 0.25] through its start, nothing
  // when start = end.
  geom::Path square;
  square.moveTo({0, 0});
  square.lineTo({100, 0});
  square.lineTo({100, 100});
  square.lineTo({0, 100});
  square.close();
  t = geom::trimPath(square, 0, 1, &kept);
  CHECK(kept[0].closed);
  CHECK(lengthOf(t) == doctest::Approx(400));
  t = geom::trimPath(square, 0.75, 0.25, &kept);
  REQUIRE(kept.size() == 1);
  CHECK_FALSE(kept[0].closed);
  CHECK(lengthOf(t) == doctest::Approx(200));
  CHECK(t.points.front().x == doctest::Approx(0));  // starts at 300 along: (0, 100)
  CHECK(t.points.front().y == doctest::Approx(100));
  CHECK(t.points.back().x == doctest::Approx(100));  // ends at 100 along: (100, 0)
  CHECK(geom::trimPath(square, 0.4, 0.4).empty());

  // The geometry: a rectangle's centre stroke cut to its first half; an inside stroke is never trimmed (Figma: center
  // strokes only). The motion layer animates PATH_TRIM_END on a line.
  const Guid R{1, 1}, Box{1, 2}, L{1, 3};
  auto nodes = baseChanges();
  nodes.push_back(make(R, NodeType::FRAME, kPage, "!", {0, 0, 300, 300}, "Root"));
  NodeChange box = make(Box, NodeType::ROUNDED_RECTANGLE, R, "!", {10, 10, 100, 100}, "Box");
  box.props.strokeWeight = 2;
  box.props.strokeAlign = StrokeAlign::CENTER;
  box.props.strokePaints = {Paint::solid(Color{0, 0, 0, 1})};
  box.props.extra["pathTrim"] = codec::extraFromJson("NodeChange", "pathTrim", parsed(R"({"value":{"x":0,"y":0.5}})"));
  nodes.push_back(box);
  NodeChange ln = make(L, NodeType::LINE, R, "\"", {10, 200, 100, 0}, "Line");
  ln.props.strokeWeight = 2;
  ln.props.strokePaints = {Paint::solid(Color{0, 0, 0, 1})};
  nodes.push_back(ln);
  Editor e;
  load(e, nodes);
  const Document& doc = e.document();
  double s0 = 0, s1 = 1;
  CHECK(pathTrimOf(doc.get(Box)->props, s0, s1));
  CHECK(s1 == doctest::Approx(0.5));
  const NodeGeometry* g = doc.geometry(Box);
  REQUIRE(g);
  CHECK(lengthOf(g->stroke.path) == doctest::Approx(200));
  CHECK(g->hasOpenEnds);
  REQUIRE(g->stroke.caps.size() == 1);
  CHECK(lengthOf(g->fills[0].path) == doctest::Approx(400));  // the fill stays whole
  NodeChange inside = NodeChange::changed(Box);
  inside.mask = F_STROKE_ALIGN;
  inside.props.strokeAlign = StrokeAlign::INSIDE;
  REQUIRE(e.setProps({Box}, inside, 0) == OK);
  CHECK(lengthOf(doc.geometry(Box)->stroke.path) == doctest::Approx(400));
  e.setMotion(on(R, 0));
  key2(e, L, "PATH_TRIM_END", 0, 0, 1000000, 1);
  e.setMotion(on(R, 250000));
  CHECK(pathTrimOf(doc.get(L)->props, s0, s1));
  CHECK(s1 == doctest::Approx(0.25));
  CHECK(lengthOf(doc.geometry(L)->stroke.path) == doctest::Approx(25));
  e.setMotion(on(R, 1000000));
  CHECK_FALSE(pathTrimOf(doc.get(L)->props, s0, s1));  // [0, 1]: nothing cut
  CHECK(lengthOf(doc.geometry(L)->stroke.path) == doctest::Approx(100));
  // The panel's write at 500 ms (pathTrim whole, as the Path trim section sends it): the end has a track — a keyframe
  // there; the start, unchanged, stays the base's.
  e.setMotion(on(R, 500000));
  auto trimWrite = [&](double start, double end) {
    NodeChange c = NodeChange::changed(L);
    c.mask = F_EXTRA;
    c.props.extra["pathTrim"] = codec::extraFromJson("NodeChange", "pathTrim", parsed("{\"value\":{\"x\":" + std::to_string(start) + ",\"y\":" + std::to_string(end) + "}}"));
    REQUIRE(e.setProps({L}, c, 0) == OK);
  };
  trimWrite(0, 0.8);
  CHECK(pathTrimOf(doc.get(L)->props, s0, s1));
  CHECK(s1 == doctest::Approx(0.8));
  CHECK(e.undoStack().undoLabel() != "");
  {
    auto base = e.motionSuspended();
    CHECK(doc.get(L)->props.extra.count("pathTrim") == 0);  // the base untouched
  }
  // The base: the track's base value (no trim yet: 0 / 1) — Design draws the whole line.
  e.setMotion(motion::State{});
  CHECK(doc.get(L)->props.extra.count("pathTrim") == 0);  // restored bit-identically: the key the layer added goes
  CHECK(lengthOf(doc.geometry(L)->stroke.path) == doctest::Approx(100));
  // The start has no track and auto-keyframe is off: the base takes it (and keeps the end's base).
  e.setMotion(on(R, 500000));
  trimWrite(0.3, 0.8);
  e.setMotion(motion::State{});
  CHECK(pathTrimOf(doc.get(L)->props, s0, s1));
  CHECK(s0 == doctest::Approx(0.3));
  CHECK(s1 == doctest::Approx(1));
  CHECK(lengthOf(doc.geometry(L)->stroke.path) == doctest::Approx(70));
}

// ---- The canvas ---------------------------------------------------------------------------------------------------

TEST_CASE("motion layer: the motion path's dots and squares, and the anchor point tool keeping the layer in place") {
  const Guid R{1, 1}, Rect{1, 2};
  auto nodes = baseChanges();
  nodes.push_back(make(R, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "Root"));
  nodes.push_back(make(Rect, NodeType::ROUNDED_RECTANGLE, R, "!", {20, 30, 100, 50}, "Rect"));
  Editor e;
  load(e, nodes);
  e.setMotion(on(R, 0));
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"nodes":["1:2"],"field":{"type":"PROPERTY","name":"TRANSLATION_XY"},"timeUs":0,"value":{"type":"VECTOR","value":{"x":0,"y":0}},"easing":{"type":"LINEAR"}})")) == OK);
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"nodes":["1:2"],"field":{"type":"PROPERTY","name":"TRANSLATION_XY"},"timeUs":1000000,"value":{"type":"VECTOR","value":{"x":200,"y":0}},"easing":{"type":"LINEAR"}})")) == OK);
  e.setSelection({Rect});
  // The path: a dot per 60 fps frame from 0 to 1 s (61), the anchor's way — the box's centre (70, 55) to (270, 55);
  // a square per keyframe, the one at the playhead filled.
  Overlay o = e.overlay();
  CHECK(o.motionDots.size() == 61);
  CHECK(o.motionDots.front().x == doctest::Approx(70));
  CHECK(o.motionDots.back().x == doctest::Approx(270));
  CHECK(o.motionDots[30].x == doctest::Approx(170));  // linear: even spacing
  REQUIRE(o.motionKeys.size() == 2);
  CHECK(o.motionKeys[0].current);
  CHECK_FALSE(o.motionKeys[1].current);
  CHECK_FALSE(o.hasAnchorPoint);
  // Motion off: no path, and the anchor tool shows no target (leaving Motion puts Move back).
  e.setMotion(motion::State{});
  CHECK(e.overlay().motionDots.empty());
  REQUIRE(e.setTool(Tool::ANCHOR_POINT) == OK);
  CHECK_FALSE(e.overlay().hasAnchorPoint);
  e.setMotion(on(R, 0));
  e.setMotion(motion::State{});
  CHECK(e.tool() == Tool::MOVE);
  // ⌥R at 500 ms: the target at the anchor (the centre, moved 100 px); dragged to the box's top-left corner (snapped),
  // the anchor is 0 % / 0 % and the layer stays where it is.
  e.setMotion(on(R, 500000));
  REQUIRE(e.setTool(Tool::ANCHOR_POINT) == OK);
  o = e.overlay();
  REQUIRE(o.hasAnchorPoint);
  CHECK(o.anchorPoint.x == doctest::Approx(170));
  CHECK(o.anchorPoint.y == doctest::Approx(55));
  Mat2x3 shown = e.document().worldTransform(Rect);
  e.pointer(PointerEvent::DOWN, 170, 55, 0, 1, 0);
  e.pointer(PointerEvent::MOVE, 150, 40, 0, 1, 0);
  e.pointer(PointerEvent::MOVE, 122, 32, 0, 1, 0);
  CHECK(e.overlay().anchorPoint.x == doctest::Approx(120));  // snapped to the corner (120, 30)
  e.pointer(PointerEvent::UP, 122, 32, 0, 0, 0);
  CHECK(e.undoStack().undoLabel() == "Move anchor point");
  motion::LayerBase b = motion::decodeLayerBase(e.document().get(Rect)->props);
  CHECK(b.originX.value == doctest::Approx(0));
  CHECK(b.originY.value == doctest::Approx(0));
  Mat2x3 now = e.document().worldTransform(Rect);
  CHECK(now.m02 == doctest::Approx(shown.m02));
  CHECK(now.m12 == doctest::Approx(shown.m12));
  // A press off the target: back to Move, the press selects as Move's does.
  e.pointer(PointerEvent::DOWN, 380, 280, 0, 1, 0);
  e.pointer(PointerEvent::UP, 380, 280, 0, 0, 0);
  CHECK(e.tool() == Tool::MOVE);
}

// ---- Exports (the C ABI) --------------------------------------------------------------------------------------------

using Ptr = uintptr_t;
using Handle = uintptr_t;
extern "C" {
Ptr engine_result_ptr();
uint32_t engine_result_len();
Handle engine_create(const char* selector, Ptr optsPtr, uint32_t optsLen);
void engine_destroy(Handle h);
int32_t engine_load(Handle h, Ptr ptr, uint32_t len);
int32_t engine_command(Handle h, uint32_t commandId, Ptr argsPtr, uint32_t argsLen);
int32_t engine_set_motion(Handle h, Ptr ptr, uint32_t len);
int32_t engine_export_info(Handle h, Ptr refsPtr, uint32_t refsLen, Ptr settingsPtr, uint32_t settingsLen);
int32_t engine_read_nodes(Handle h, Ptr ptr, uint32_t len, uint32_t flags);
}

namespace {
std::string abiResult() { return std::string(reinterpret_cast<const char*>(engine_result_ptr()), engine_result_len()); }
Ptr ptrOf(const std::string& s) { return reinterpret_cast<Ptr>(s.data()); }
uint32_t lenOf(const std::string& s) { return static_cast<uint32_t>(s.size()); }
double exportX(Handle h, const std::string& settings) {
  std::string refs = R"(["1:2"])";
  REQUIRE(engine_export_info(h, ptrOf(refs), lenOf(refs), ptrOf(settings), lenOf(settings)) == 0);
  json::Value v = parsed(abiResult());
  return v.get("targets")->array[0].get("bounds")->get("x")->number;
}
}  // namespace

TEST_CASE("motion layer: static exports draw the base values while Motion plays — or the timeline at motionTimeUs") {
  const char* doc = R"({"type":"NODE_CHANGES","sessionID":0,"nodeChanges":[
    {"guid":"0:0","phase":"CREATED","type":"DOCUMENT","name":"Document"},
    {"guid":"0:1","phase":"CREATED","type":"CANVAS","name":"Page 1","parentIndex":{"guid":"0:0","position":"!"}},
    {"guid":"0:2","phase":"CREATED","type":"CANVAS","name":"Internal Only Canvas","parentIndex":{"guid":"0:0","position":"~"},"internalOnly":true,"visible":false},
    {"guid":"1:1","phase":"CREATED","type":"FRAME","name":"Root","parentIndex":{"guid":"0:1","position":"!"},"size":{"x":400,"y":300}},
    {"guid":"1:2","phase":"CREATED","type":"ROUNDED_RECTANGLE","name":"Rect","parentIndex":{"guid":"1:1","position":"!"},
     "size":{"x":100,"y":50},"transform":{"m00":1,"m01":0,"m02":20,"m10":0,"m11":1,"m12":30},
     "fillPaints":[{"type":"SOLID","color":{"r":1,"g":0,"b":0,"a":1}}]}
  ]})";
  std::string opts = R"({"sessionID":1})";
  Handle h = engine_create(nullptr, ptrOf(opts), lenOf(opts));
  REQUIRE(h != 0);
  const std::string kiwiDoc = codec::writeMessage(0, codec::readMessage(parsed(doc)));
  REQUIRE(engine_load(h, ptrOf(kiwiDoc), lenOf(kiwiDoc)) == 0);
  std::string k0 = R"({"nodes":["1:2"],"field":{"type":"PROPERTY","name":"TRANSLATION_XY"},"timeUs":0,"value":{"type":"VECTOR","value":{"x":0,"y":0}},"easing":{"type":"LINEAR"}})";
  std::string k1 = R"({"nodes":["1:2"],"field":{"type":"PROPERTY","name":"TRANSLATION_XY"},"timeUs":1000000,"value":{"type":"VECTOR","value":{"x":200,"y":0}},"easing":{"type":"LINEAR"}})";
  REQUIRE(engine_command(h, 330, ptrOf(k0), lenOf(k0)) == 0);
  REQUIRE(engine_command(h, 330, ptrOf(k1), lenOf(k1)) == 0);
  std::string at = R"({"on":true,"root":"1:1","timeUs":500000})";
  REQUIRE(engine_set_motion(h, ptrOf(at), lenOf(at)) == 0);
  // Motion plays at 500 ms (the canvas shows the rectangle 100 px along); a PNG export is of the design: x 20.
  CHECK(exportX(h, R"({"imageType":"PNG"})") == doctest::Approx(20));
  // At a time asked for: 1 s, 200 px along.
  CHECK(exportX(h, R"({"imageType":"PNG","motionTimeUs":1000000})") == doctest::Approx(220));
  // The canvas still plays at 500 ms afterwards.
  std::string read = R"({"refs":["1:2"],"fields":["transform"]})";
  REQUIRE(engine_read_nodes(h, ptrOf(read), lenOf(read), 0) == 0);
  json::Value nodes = parsed(abiResult());
  CHECK(nodes.get("nodeChanges")->array[0].get("transform")->get("m02")->number == doctest::Approx(120));
  engine_destroy(h);
}
