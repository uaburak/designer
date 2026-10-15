// Round 7b, Figma Draw — tools and editing (docs/draw.md §4.2–4.7): the Draw commands 310–321 (repeats, Apply
// transforms, stroke kinds, brushes, text on a path), INSTALL_BRUSH / list / preview, the Brush tool, the Pencil's
// Dynamic mode and Shift line, ⌘-click sampling, the Text on path tool and the start handle, the clipboard carrying
// brushes, and multi-edit in vector edit mode. Each command is one undo step.
#include <cmath>
#include <string>

#include "base/Json.h"
#include "doctest.h"
#include "editor/Editor.h"
#include "export/Scene.h"
#include "geometry/Brush.h"
#include "geometry/DynamicStroke.h"
#include "geometry/Repeat.h"
#include "geometry/Shapes.h"
#include "geometry/VariableWidth.h"
#include "geometry/VectorNetwork.h"
#include "Helpers.h"
#include "scene/CodecKiwi.h"
#include "text/TextPathLayout.h"
#include "TextHelpers.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid R1{1, 1}, R2{1, 2}, V{1, 3}, LN{1, 4}, EL{1, 5}, TPN{1, 6};

bool near(double a, double b, double eps = 1e-6) { return std::fabs(a - b) <= eps; }

CommandArgs args(const std::string& text) {
  CommandArgs a;
  REQUIRE(json::parse(text, a.raw));
  return a;
}

json::Value extraOf(const Editor& e, Guid id, const char* key) {
  json::Value v;
  const Node* n = e.document().get(id);
  if (!n) return v;
  auto it = n->props.extra.find(key);
  if (it == n->props.extra.end() || it->second.empty()) return v;
  json::parse(codec::extraValueToJson("NodeChange", it->second), v);
  return v;
}

const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }

geom::VectorNetwork lineNet(double length) {
  geom::VectorNetwork net;
  net.vertices = {{{0, 0}, 0}, {{length, 0}, 0}};
  net.segments = {geom::VNSegment{0, 1, {}, {}, 0}};
  return net;
}

NodeChange vectorNode(Guid id, const std::string& pos, Rect r, const geom::VectorNetwork& net, double weight) {
  NodeChange c = make(id, NodeType::VECTOR, kPage, pos, r, "Vector");
  VectorData d;
  d.present = true;
  d.normalizedSize = {r.w, r.h};
  d.network = std::make_shared<std::vector<uint8_t>>(net.encode());
  c.props.shape().vectorData = d;
  c.props.fillPaints.clear();
  c.props.strokePaints = {Paint::solid(Color::hex(0xFF0000))};
  c.props.strokeWeight = weight;
  return c;
}

// Two 20 × 20 rectangles (0, 0) and (100, 0), a stroked line V (0, 200 → 200, 200, weight 3), a line LN, an ellipse EL
// (300, 0, 100 × 100); the camera puts world (0, 0) at screen (100, 100).
Editor makeEditor() {
  auto nodes = baseChanges();
  nodes.push_back(make(R1, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 20, 20}, "A"));
  nodes.push_back(make(R2, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {100, 0, 20, 20}, "B"));
  nodes.push_back(vectorNode(V, "#", {0, 200, 200, 0}, lineNet(200), 3));
  nodes.push_back(make(LN, NodeType::LINE, kPage, "$", {0, 400, 100, 0}, "Line"));
  nodes.push_back(make(EL, NodeType::ELLIPSE, kPage, "%", {300, 0, 100, 100}, "Ellipse"));
  Editor e;
  e.setSessionID(1);
  e.setViewport(1200, 900, 1, 1200, 900);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({100, 100, 1});
  e.takeEvents();
  return e;
}

std::string lastLabel(Editor& e) {
  auto ev = e.takeEvents();
  return ev.documents.empty() ? std::string() : ev.documents.back().label;
}

Guid installSquare(Editor& e, const char* name, bool scatter) {
  geom::Path sq;
  sq.moveTo({0, 0});
  sq.lineTo({16, 0});
  sq.lineTo({16, 16});
  sq.lineTo({0, 16});
  sq.close();
  return e.installBrush(name, scatter, {16, 16}, sq, WindingRule::NONZERO);
}

void drag(Editor& e, Vec2 from, Vec2 to, uint32_t mods = 0, int steps = 8) {
  e.pointer(PointerEvent::DOWN, from.x, from.y, 0, 1, mods, 1);
  for (int i = 1; i <= steps; i++) {
    double t = static_cast<double>(i) / steps;
    // A wavy line: Shift should still give a straight one.
    Vec2 p = from + (to - from) * t + Vec2{0, (i % 2 ? 6.0 : -6.0)};
    e.pointer(PointerEvent::MOVE, p.x, p.y, 0, 1, mods, 1);
  }
  e.pointer(PointerEvent::UP, to.x, to.y, 0, 0, mods, 1);
}

struct Fonts {
  Fonts() {
    auto& fonts = text::FontRegistry::get();
    int32_t upright = addFontFile(interPath());
    for (const char* style : {"Regular", "Medium", "Bold"}) fonts.bind("Inter", style, upright);
    fonts.takeRequests();
  }
  ~Fonts() { text::FontRegistry::get().reset(); }
};

}  // namespace

TEST_CASE("r7b repeats: Add repeat wraps the selection in a transform group; change, move, remove; one undo step each") {
  Editor e = makeEditor();
  e.setSelection({R1, R2});
  REQUIRE((e.commandState(CommandId::ADD_TRANSFORM_MODIFIER) & CMD_ENABLED) != 0);
  REQUIRE(e.command(CommandId::ADD_TRANSFORM_MODIFIER,
                    args(R"({"modifier":{"repeatType":"LINEAR","count":3,"offset":10,"unitType":"PIXELS","axis":"X","order":"FORWARD","visible":true}})")) == OK);
  CHECK(lastLabel(e) == "Add repeat");
  REQUIRE(e.selection().size() == 1);
  Guid g = e.selection()[0];
  CHECK(props(e, g).type == NodeType::TRANSFORM);
  CHECK(props(e, g).name == "Repeat group 1");
  CHECK(e.document().parentOf(R1) == g);
  CHECK(e.document().parentOf(R2) == g);
  auto mods = transformModifiersOf(props(e, g));
  REQUIRE(mods.size() == 1);
  CHECK(mods[0].count == 3);
  CHECK(mods[0].offset.x == 10);
  // The group's box covers every copy: content 120 wide, 3 copies 130 apart.
  CHECK(near(props(e, g).size.x, 120 * 3 + 2 * 10, 1e-6));
  CHECK(near(props(e, g).size.y, 20, 1e-6));
  CHECK((e.commandState(CommandId::APPLY_TRANSFORMS) & CMD_ENABLED) != 0);

  // Another modifier on the selected group is appended.
  REQUIRE(e.command(CommandId::ADD_TRANSFORM_MODIFIER, args(R"({"modifier":{"repeatType":"RADIAL","count":4,"offset":5,"unitType":"PIXELS","axis":"X","order":"FORWARD","visible":true}})")) == OK);
  REQUIRE(transformModifiersOf(props(e, g)).size() == 2);
  std::string ref = "\"" + g.toString() + "\"";
  REQUIRE(e.command(CommandId::SET_TRANSFORM_MODIFIER, args("{\"ref\":" + ref + ",\"index\":0,\"modifier\":{\"count\":5,\"axis\":\"Y\"}}")) == OK);
  CHECK(lastLabel(e) == "Change repeat");
  mods = transformModifiersOf(props(e, g));
  CHECK(mods[0].count == 5);
  CHECK(mods[0].axis == geom::TransformModifier::Axis::Y);
  CHECK(mods[0].offset.x == 10);  // untouched
  REQUIRE(e.command(CommandId::MOVE_TRANSFORM_MODIFIER, args("{\"ref\":" + ref + ",\"from\":1,\"to\":0}")) == OK);
  mods = transformModifiersOf(props(e, g));
  CHECK(mods[0].repeatType == geom::TransformModifier::Repeat::RADIAL);
  REQUIRE(e.command(CommandId::REMOVE_TRANSFORM_MODIFIER, args("{\"ref\":" + ref + ",\"index\":0}")) == OK);
  CHECK(lastLabel(e) == "Remove repeat");
  REQUIRE(transformModifiersOf(props(e, g)).size() == 1);
  // Each was one step: three undos bring the radial one back in front, then its place, then the count.
  e.command(CommandId::UNDO);
  CHECK(transformModifiersOf(props(e, g)).size() == 2);
  e.command(CommandId::UNDO);
  CHECK(transformModifiersOf(props(e, g))[0].repeatType == geom::TransformModifier::Repeat::LINEAR);
  e.command(CommandId::UNDO);
  CHECK(transformModifiersOf(props(e, g))[0].count == 3);
  e.command(CommandId::UNDO);
  e.command(CommandId::UNDO);
  CHECK_FALSE(e.document().has(g));
  CHECK(e.document().parentOf(R1) == kPage);
  // Out of range: refused, nothing written.
  CHECK(e.command(CommandId::REMOVE_TRANSFORM_MODIFIER, args("{\"ref\":" + ref + ",\"index\":0}")) == E_INVALID);
}

TEST_CASE("r17a repeats: authoring writes Figma's count 2…40; a file's count is read leniently") {
  Editor e = makeEditor();
  e.setSelection({R1});
  REQUIRE(e.command(CommandId::ADD_TRANSFORM_MODIFIER,
                    args(R"({"modifier":{"repeatType":"LINEAR","count":1,"offset":10,"unitType":"PIXELS","axis":"X","order":"FORWARD","visible":true}})")) == OK);
  Guid g = e.selection()[0];
  CHECK(transformModifiersOf(props(e, g))[0].count == 2);
  std::string ref = "\"" + g.toString() + "\"";
  REQUIRE(e.command(CommandId::SET_TRANSFORM_MODIFIER, args("{\"ref\":" + ref + ",\"index\":0,\"modifier\":{\"count\":41}}")) == OK);
  CHECK(transformModifiersOf(props(e, g))[0].count == 40);
  REQUIRE(e.command(CommandId::SET_TRANSFORM_MODIFIER, args("{\"ref\":" + ref + ",\"index\":0,\"modifier\":{\"count\":0}}")) == OK);
  CHECK(transformModifiersOf(props(e, g))[0].count == 2);
  // A count past 40 from a file still evaluates (clamped to 1…1000 on read).
  geom::TransformModifier m;
  m.count = 60;
  m.offset = {10, 0};
  auto r = geom::evaluateRepeat({m}, Rect{0, 0, 20, 20}, geom::kMaxRepeatInstances);
  CHECK(r.instances.size() == 60);
}

TEST_CASE("r7b Apply transforms: the group becomes a group of real layers, the source kept, copies at each instance") {
  Editor e = makeEditor();
  e.setSelection({R1});
  REQUIRE(e.command(CommandId::ADD_TRANSFORM_MODIFIER,
                    args(R"({"modifier":{"repeatType":"LINEAR","count":3,"offset":10,"unitType":"PIXELS","axis":"X","order":"FORWARD","visible":true}})")) == OK);
  Guid g = e.selection()[0];
  // A nested one inside: applied inside out.
  e.setSelection({R1});
  REQUIRE(e.command(CommandId::ADD_TRANSFORM_MODIFIER,
                    args(R"({"modifier":{"repeatType":"LINEAR","count":2,"offset":0,"unitType":"PIXELS","axis":"Y","order":"FORWARD","visible":true}})")) == OK);
  Guid inner = e.selection()[0];
  REQUIRE(e.document().parentOf(inner) == g);
  e.setSelection({g});
  e.takeEvents();
  REQUIRE(e.command(CommandId::APPLY_TRANSFORMS) == OK);
  CHECK(lastLabel(e) == "Apply transforms");
  CHECK_FALSE(e.document().has(g));
  CHECK_FALSE(e.document().has(inner));
  REQUIRE(e.selection().size() == 1);
  Guid made = e.selection()[0];
  CHECK(props(e, made).type == NodeType::FRAME);
  CHECK(props(e, made).resizeToFit);
  CHECK(props(e, made).name == "Repeat group 1");
  CHECK(extraOf(e, made, "transformModifiers").isNull());
  // 3 copies of the inner group (each a group of 2 rectangles), the first holding R1 itself.
  auto kids = e.document().children(made);
  REQUIRE(kids.size() == 3);
  size_t rects = 0;
  for (Guid k : kids) {
    CHECK(props(e, k).type == NodeType::FRAME);
    REQUIRE(e.document().children(k).size() == 2);
    rects += e.document().children(k).size();
  }
  CHECK(rects == 6);
  CHECK(e.document().has(R1));
  // The copies sit where the repeat drew them: 30 apart along x (20 wide + 10).
  std::vector<double> xs;
  for (Guid k : kids) xs.push_back(e.document().worldBounds(k).x);
  std::sort(xs.begin(), xs.end());
  CHECK(near(xs[1] - xs[0], 30, 1e-6));
  CHECK(near(xs[2] - xs[1], 30, 1e-6));
  // One step back.
  e.command(CommandId::UNDO);
  CHECK(e.document().has(g));
  CHECK(e.document().has(inner));
  CHECK(e.document().parentOf(R1) == inner);
}

TEST_CASE("r7b stroke kinds: Dynamic writes its settings and a seed, keeps width points and dashes; Basic writes neutral") {
  Editor e = makeEditor();
  {
    // Width points and a dash on V first.
    NodeChange c = NodeChange::changed(V);
    c.mask = F_EXTRA | F_DASH_PATTERN;
    json::Value pts;
    json::parse(R"([{"position":0,"ascent":1,"descent":1},{"position":1,"ascent":3,"descent":3}])", pts);
    c.props.extra["variableWidthPoints"] = codec::extraFromJson("NodeChange", "variableWidthPoints", pts);
    c.props.stroke().dashPattern = {4, 2};
    REQUIRE(e.applyChanges({c}, APPLY_USER) == OK);
  }
  e.setSelection({V});
  e.takeEvents();
  REQUIRE(e.command(CommandId::SET_STROKE_KIND, args(R"({"kind":"DYNAMIC","dynamic":{"wiggle":2}})")) == OK);
  CHECK(lastLabel(e) == "Change stroke");
  geom::DynamicSettings s;
  REQUIRE(dynamicSettingsOf(props(e, V), s));
  CHECK(s.wiggle == 2);
  CHECK(s.frequency == doctest::Approx(0.75));  // Figma's default
  CHECK(s.smoothen == doctest::Approx(0.5));
  CHECK(strokeSeedOf(props(e, V)) != 0);
  // Figma keeps width points and dashes across a kind change (rea/vector.md §4); they are not drawn on Dynamic.
  CHECK(extraOf(e, V, "variableWidthPoints").isArray());
  CHECK(props(e, V).stroke().dashPattern.size() == 2);
  // Kept, not drawn: the exporters (and the renderer) stroke a dynamic centre line without the dashes.
  CHECK(exporter::strokeOf(e.document(), V, props(e, V)).dashes.empty());
  // Figma's -1:-1: no brush.
  json::Value bg = extraOf(e, V, "strokeBrushGuid");
  REQUIRE(bg.isObject());
  CHECK(bg.get("sessionID")->numberOr(0) == 4294967295.0);
  CHECK(strokeBrushOf(props(e, V)) == kNoGuid);
  uint64_t seed = strokeSeedOf(props(e, V));
  // A later change keeps the seed (the look stays).
  REQUIRE(e.command(CommandId::SET_STROKE_KIND, args(R"({"refs":["1:3"],"kind":"DYNAMIC","dynamic":{"frequency":5}})")) == OK);
  CHECK(strokeSeedOf(props(e, V)) == seed);
  REQUIRE(dynamicSettingsOf(props(e, V), s));
  CHECK(s.frequency == 5);
  CHECK(s.wiggle == 2);
  REQUIRE(e.command(CommandId::SET_STROKE_KIND, args(R"({"kind":"BASIC"})")) == OK);
  CHECK_FALSE(dynamicSettingsOf(props(e, V), s));
  CHECK(exporter::strokeOf(e.document(), V, props(e, V)).dashes.size() == 2);  // Basic draws its dashes again
  // Basic keeps the field at Figma's neutral {1, 0, 0}, which reads as Basic.
  json::Value neutral = extraOf(e, V, "dynamicStrokeSettings");
  REQUIRE(neutral.isObject());
  CHECK(neutral.get("frequency")->numberOr(0) == 1);
  CHECK(neutral.get("wiggle")->numberOr(-1) == 0);
  CHECK(neutral.get("smoothen")->numberOr(-1) == 0);
  CHECK(extraOf(e, V, "variableWidthPoints").isArray());
  // Dynamic again starts from Figma's defaults, not from the neutral value.
  REQUIRE(e.command(CommandId::SET_STROKE_KIND, args(R"({"kind":"DYNAMIC"})")) == OK);
  REQUIRE(dynamicSettingsOf(props(e, V), s));
  CHECK(s.frequency == doctest::Approx(0.75));
  CHECK(s.wiggle == doctest::Approx(0.3));
  CHECK(s.smoothen == doctest::Approx(0.5));
  // Wiggle has no upper bound in the document (the plugin's); geometry caps it.
  REQUIRE(e.command(CommandId::SET_STROKE_KIND, args(R"({"kind":"DYNAMIC","dynamic":{"wiggle":250}})")) == OK);
  CHECK(extraOf(e, V, "dynamicStrokeSettings").get("wiggle")->numberOr(0) == 250);
  REQUIRE(dynamicSettingsOf(props(e, V), s));
  CHECK(s.wiggle == geom::kDynWiggleCap);
  e.command(CommandId::UNDO);
  e.command(CommandId::UNDO);
  e.command(CommandId::UNDO);
  e.command(CommandId::UNDO);
  e.command(CommandId::UNDO);
  CHECK_FALSE(dynamicSettingsOf(props(e, V), s));
  CHECK(extraOf(e, V, "dynamicStrokeSettings").isNull());
  CHECK(props(e, V).stroke().dashPattern.size() == 2);
  CHECK(e.command(CommandId::SET_STROKE_KIND, args(R"({"kind":"FANCY"})")) == E_INVALID);
}

TEST_CASE("r17a stroke kind detection: Figma's -1:-1 is no brush; the neutral Dynamic {1, 0, 0} is Basic") {
  NodeProps p;
  p.strokeWeight = 2;
  auto put = [&](const char* key, const char* json) {
    json::Value v;
    REQUIRE(json::parse(json, v));
    p.extra[key] = codec::extraFromJson("NodeChange", key, v);
  };
  // A Dynamic stroke as Figma writes it: settings plus strokeBrushGuid -1:-1.
  put("strokeBrushGuid", R"({"sessionID":4294967295,"localID":4294967295})");
  put("dynamicStrokeSettings", R"({"frequency":0.75,"wiggle":0.30000001192092896,"smoothen":0.5})");
  CHECK(strokeBrushOf(p) == kNoGuid);
  geom::DynamicSettings s;
  REQUIRE(dynamicSettingsOf(p, s));
  CHECK(s.wiggle == doctest::Approx(0.3));
  CHECK(hasDynamicStroke(p));
  CHECK_FALSE(widthProfileAllowed(p));
  // Basic as Figma leaves it: the neutral value — not dynamic, variable width allowed.
  put("dynamicStrokeSettings", R"({"frequency":1,"wiggle":0,"smoothen":0})");
  CHECK_FALSE(dynamicSettingsOf(p, s));
  CHECK_FALSE(hasDynamicStroke(p));
  CHECK(widthProfileAllowed(p));
  // A real brush GUID still names a brush.
  put("strokeBrushGuid", R"({"sessionID":1,"localID":40})");
  CHECK(strokeBrushOf(p) == Guid{1, 40});
}

TEST_CASE("r17a a neutral Dynamic stroke draws, hits and bounds as Basic") {
  Editor e = makeEditor();
  NodeChange c = NodeChange::changed(V);
  c.mask = F_EXTRA;
  json::Value v;
  REQUIRE(json::parse(R"({"frequency":1,"wiggle":0,"smoothen":0})", v));
  c.props.extra["dynamicStrokeSettings"] = codec::extraFromJson("NodeChange", "dynamicStrokeSettings", v);
  REQUIRE(e.applyChanges({c}, APPLY_USER) == OK);
  geom::Path center;
  CHECK_FALSE(dynamicCenter(props(e, V), *e.document().geometry(V), 0.25, center));
  // The Width profile is available on it (it was refused while any dynamicStrokeSettings was present).
  e.setSelection({V});
  CHECK((e.commandState(CommandId::SET_WIDTH_PROFILE) & CMD_ENABLED) != 0);
}

TEST_CASE("r7b brushes: install is idempotent by name and type; Brush stroke clears Dynamic; settings; Create brush") {
  Editor e = makeEditor();
  Guid heist = installSquare(e, "Heist", false);
  REQUIRE(heist != kNoGuid);
  CHECK(installSquare(e, "Heist", false) == heist);
  Guid bubble = installSquare(e, "Heist", true);  // same name, the other type: another brush
  CHECK(bubble != heist);
  auto list = e.listBrushes();
  REQUIRE(list.size() == 2);
  // On the Internal Only Canvas, as Figma keeps them; installing outside a step is no undo step.
  CHECK(e.document().get(e.document().parentOf(heist))->props.rare().internalOnly);
  CHECK_FALSE(e.canUndo());

  e.setSelection({V});
  REQUIRE(e.command(CommandId::SET_STROKE_KIND, args(R"({"kind":"DYNAMIC"})")) == OK);
  REQUIRE(e.command(CommandId::SET_STROKE_BRUSH, args("{\"brush\":\"" + bubble.toString() + "\"}")) == OK);
  CHECK(strokeBrushOf(props(e, V)) == bubble);
  geom::DynamicSettings s;
  CHECK_FALSE(dynamicSettingsOf(props(e, V), s));
  CHECK(extraOf(e, V, "dynamicStrokeSettings").isNull());
  json::Value sc = extraOf(e, V, "scatterStrokeSettings");
  REQUIRE(sc.isObject());
  CHECK(sc.get("gap")->numberOr(0) == 1);  // the defaults
  // Scatter settings, clamped to the ranges.
  REQUIRE(e.command(CommandId::SET_BRUSH_SETTINGS, args(R"({"scatter":{"gap":0.1,"rotation":45}})")) == OK);
  sc = extraOf(e, V, "scatterStrokeSettings");
  CHECK(sc.get("gap")->numberOr(0) == doctest::Approx(0.25));
  CHECK(sc.get("rotation")->numberOr(0) == 45);
  REQUIRE(e.command(CommandId::SET_BRUSH_SETTINGS, args(R"({"stretch":{"direction":"BACKWARD"}})")) == OK);
  json::Value st = extraOf(e, V, "stretchStrokeSettings");
  REQUIRE(st.isObject());
  CHECK(st.get("orientation")->string == "REVERSE");
  // The brush stroke draws: an outline from the brush.
  geom::Path out;
  CHECK(brushStroke(e.document(), props(e, V), *e.document().geometry(V), 0.25, out));
  // Not a brush: refused.
  CHECK(e.command(CommandId::SET_STROKE_BRUSH, args("{\"brush\":\"1:1\"}")) == E_INVALID);

  // Create brush: an open path can't be a brush; a closed shape can, and stays.
  e.setSelection({V});
  CHECK_FALSE((e.commandState(CommandId::CREATE_BRUSH) & CMD_ENABLED) != 0);
  CHECK(e.command(CommandId::CREATE_BRUSH, args(R"({"ref":"1:3","brushType":"STRETCH"})")) == E_INVALID);
  e.setSelection({EL});
  CHECK((e.commandState(CommandId::CREATE_BRUSH) & CMD_ENABLED) != 0);
  e.takeEvents();
  REQUIRE(e.command(CommandId::CREATE_BRUSH, args(R"({"ref":"1:5","brushType":"SCATTER"})")) == OK);
  CHECK(lastLabel(e) == "Create brush");
  REQUIRE(e.lastCreated().size() == 1);
  Guid made = e.lastCreated()[0];
  CHECK(props(e, made).type == NodeType::BRUSH);
  CHECK(props(e, made).name == "Ellipse");
  CHECK(near(props(e, made).size.x, 100, 1e-6));
  CHECK(e.document().has(EL));
  geom::Path art;
  Vec2 box;
  bool scatter = false;
  REQUIRE(e.brushArtwork(made, art, box, scatter));
  CHECK(scatter);
  CHECK(e.listBrushes().size() == 3);
  e.command(CommandId::UNDO);
  CHECK_FALSE(e.document().has(made));
}

TEST_CASE("r17a a brush keeps width points and dashes; Basic after a brush writes -1:-1") {
  Editor e = makeEditor();
  Guid heist = installSquare(e, "Heist", false);
  {
    NodeChange c = NodeChange::changed(V);
    c.mask = F_EXTRA | F_DASH_PATTERN;
    c.props.extra["variableWidthPoints"] = encodeWidthPoints(geom::presetPoints(geom::WidthProfile::WEDGE));
    c.props.stroke().dashPattern = {4, 4};
    REQUIRE(e.applyChanges({c}, APPLY_USER) == OK);
  }
  e.setSelection({V});
  REQUIRE(e.command(CommandId::SET_STROKE_BRUSH, args("{\"brush\":\"" + heist.toString() + "\"}")) == OK);
  CHECK(strokeBrushOf(props(e, V)) == heist);
  CHECK(geom::matchPreset(widthPointsOf(props(e, V))) == geom::WidthProfile::WEDGE);
  CHECK(props(e, V).stroke().dashPattern.size() == 2);
  REQUIRE(e.command(CommandId::SET_STROKE_KIND, args(R"({"kind":"BASIC"})")) == OK);
  CHECK(strokeBrushOf(props(e, V)) == kNoGuid);
  CHECK(extraOf(e, V, "strokeBrushGuid").isObject());
  CHECK(extraOf(e, V, "dynamicStrokeSettings").isNull());  // none was there: none written
  CHECK(geom::matchPreset(widthPointsOf(props(e, V))) == geom::WidthProfile::WEDGE);
}

TEST_CASE("r17a SET_WIDTH_PROFILE for the Plugin API: custom points, any stroke kind, branching networks refused") {
  Editor e = makeEditor();
  REQUIRE(e.command(CommandId::SET_STROKE_KIND, args(R"({"refs":["1:3"],"kind":"DYNAMIC"})")) == OK);
  // The panel's form refuses a dynamic stroke; the plugin's writes it (Figma keeps it, and doesn't draw it).
  CHECK(e.command(CommandId::SET_WIDTH_PROFILE, args(R"({"refs":["1:3"],"profile":"WEDGE"})")) == E_INVALID);
  REQUIRE(e.command(CommandId::SET_WIDTH_PROFILE,
                    args(R"({"refs":["1:3"],"profile":"CUSTOM","plugin":true,"points":[{"position":1,"ascent":0.25,"descent":0.25},{"position":0,"ascent":0.5,"descent":0.5}]})")) == OK);
  auto points = widthPointsOf(props(e, V));
  REQUIRE(points.size() == 2);
  CHECK(points[0].position == 0);
  CHECK(points[1].ascent == doctest::Approx(0.25));
  CHECK(e.command(CommandId::SET_WIDTH_PROFILE, args(R"({"refs":["1:3"],"profile":"CUSTOM","plugin":true,"points":[]})")) == E_INVALID);
  // A branching network: refused.
  geom::VectorNetwork star;
  star.vertices = {{{0, 0}, 0}, {{50, 0}, 0}, {{0, 50}, 0}, {{-50, 0}, 0}};
  star.segments = {geom::VNSegment{0, 1, {}, {}, 0}, geom::VNSegment{0, 2, {}, {}, 0}, geom::VNSegment{0, 3, {}, {}, 0}};
  const Guid B{1, 9};
  REQUIRE(e.applyChanges({vectorNode(B, "&", {500, 500, 100, 50}, star, 2)}, APPLY_USER) == OK);
  CHECK(e.command(CommandId::SET_WIDTH_PROFILE, args(R"({"refs":["1:9"],"profile":"WEDGE","plugin":true})")) == E_INVALID);
}

TEST_CASE("r7b brush artwork: SVG path data, and the preview along the S-curve has ink") {
  geom::Path p;
  REQUIRE(parseSvgPath("M0 0 L10 0 Q12 5 10 10 C5 12 2 12 0 10 Z m 20 0 h 5 v 5 h -5 z", p));
  Rect b = p.bounds();
  CHECK(near(b.x, 0));
  CHECK(near(b.right(), 25));
  geom::Path bad;
  CHECK_FALSE(parseSvgPath("L 1 2", bad));
  CHECK_FALSE(parseSvgPath("M 1", bad));
  geom::Path lens = geom::ellipsePath({256, 16}, ArcData{});
  std::string rgba;
  REQUIRE(brushPreview(lens, {256, 16}, false, 96, 24, 6, rgba));
  REQUIRE(rgba.size() == 96u * 24 * 4);
  size_t inked = 0;
  for (size_t i = 3; i < rgba.size(); i += 4) inked += static_cast<uint8_t>(rgba[i]) > 128;
  CHECK(inked > 100);
  CHECK(inked < 96u * 24 / 2);
  geom::Path dot = geom::ellipsePath({64, 64}, ArcData{});
  REQUIRE(brushPreview(dot, {64, 64}, true, 96, 24, 6, rgba));
  inked = 0;
  for (size_t i = 3; i < rgba.size(); i += 4) inked += static_cast<uint8_t>(rgba[i]) > 128;
  CHECK(inked > 20);
}

TEST_CASE("r7b the Brush tool: a stroke with the tool's brush, colour and weight; Shift draws a straight line") {
  Editor e = makeEditor();
  Guid heist = installSquare(e, "Heist", false);
  json::Value settings;
  REQUIRE(json::parse("{\"pencil\":{\"color\":\"#00FF00\",\"opacity\":1,\"weight\":2,\"kind\":\"DYNAMIC\",\"dynamic\":{\"frequency\":3,\"wiggle\":1,\"smoothen\":0.5}},"
                      "\"brush\":{\"color\":\"#0000FF\",\"opacity\":0.5,\"weight\":8,\"brush\":\"" + heist.toString() + "\"}}",
                      settings));
  REQUIRE(e.setDrawToolSettings(settings) == OK);
  REQUIRE(e.setTool(Tool::BRUSH) == OK);
  e.takeEvents();
  drag(e, {200, 600}, {500, 650});
  CHECK(lastLabel(e) == "Brush");
  REQUIRE(e.selection().size() == 1);
  Guid b = e.selection()[0];
  const NodeProps& p = props(e, b);
  CHECK(p.type == NodeType::VECTOR);
  CHECK(strokeBrushOf(p) == heist);
  CHECK(p.strokeWeight == 8);
  REQUIRE(p.strokePaints.size() == 1);
  CHECK(p.strokePaints[0].color == Color::hex(0x0000FF));
  CHECK(p.strokePaints[0].opacity == doctest::Approx(0.5));
  CHECK(strokeSeedOf(p) != 0);
  CHECK(p.strokeCap == StrokeCap::ROUND);

  // The Pencil, Dynamic, with Shift: a straight line of two points.
  REQUIRE(e.setTool(Tool::PENCIL) == OK);
  drag(e, {200, 700}, {500, 760}, MOD_SHIFT);
  CHECK(lastLabel(e) == "Pencil");
  Guid pl = e.selection()[0];
  geom::DynamicSettings s;
  CHECK(dynamicSettingsOf(props(e, pl), s));
  CHECK(s.frequency == 3);
  CHECK(props(e, pl).strokePaints[0].color == Color::hex(0x00FF00));
  geom::VectorNetwork net;
  REQUIRE(geom::VectorNetwork::decode(props(e, pl).shape().vectorData.network->data(), props(e, pl).shape().vectorData.network->size(), net));
  CHECK(net.vertices.size() == 2);
  e.command(CommandId::UNDO);
  CHECK_FALSE(e.document().has(pl));
}

TEST_CASE("r7b ⌘-click with the Pencil or the Brush samples a stroke: DRAW_TOOL_SAMPLED, and no stroke is drawn") {
  Editor e = makeEditor();
  e.setSelection({V});
  REQUIRE(e.command(CommandId::SET_STROKE_KIND, args(R"({"kind":"DYNAMIC","dynamic":{"wiggle":0}})")) == OK);
  e.setSelection({});
  REQUIRE(e.setTool(Tool::PENCIL) == OK);
  e.takeEvents();
  size_t before = e.document().children(kPage).size();
  e.pointer(PointerEvent::DOWN, 200, 300, 0, 1, MOD_PRIMARY | MOD_META, 1);
  e.pointer(PointerEvent::UP, 200, 300, 0, 0, MOD_PRIMARY | MOD_META, 1);
  auto ev = e.takeEvents();
  REQUIRE(ev.drawSampled.size() == 1);
  json::Value v;
  REQUIRE(json::parse(ev.drawSampled[0], v));
  CHECK(v.get("tool")->string == "PENCIL");
  CHECK(v.get("color")->string == "#FF0000");
  CHECK(v.get("weight")->numberOr(0) == 3);
  CHECK(v.get("kind")->string == "DYNAMIC");
  CHECK(e.drawTools().pencil.dynamic);
  CHECK(e.drawTools().pencil.weight == 3);
  CHECK(e.document().children(kPage).size() == before);
}

TEST_CASE("r7b Text on path: CREATE_TEXT_PATH above the shape or in its place; Flip; the start; one step each") {
  Fonts fonts;
  Editor e = makeEditor();
  e.takeEvents();
  REQUIRE(e.command(CommandId::CREATE_TEXT_PATH, args(R"({"ref":"1:5","segment":1,"position":0.5,"replace":false})")) == OK);
  CHECK(lastLabel(e) == "Text on path");
  REQUIRE(e.lastCreated().size() == 1);
  Guid t = e.lastCreated()[0];
  CHECK(props(e, t).type == NodeType::TEXT_PATH);
  CHECK(e.document().has(EL));
  CHECK(e.document().parentOf(t) == kPage);
  CHECK(e.document().paintsBefore(EL, t));  // above the shape
  CHECK(props(e, t).size == props(e, EL).size);
  CHECK(props(e, t).transform == props(e, EL).transform);
  double tv = 0;
  bool forward = false;
  text::textPathStartOf(props(e, t), tv, forward);
  CHECK(near(tv, 1.5));
  CHECK(forward);
  CHECK(props(e, t).text().textAlignVertical == TextAlignVertical::BOTTOM);

  std::string ref = "\"" + t.toString() + "\"";
  REQUIRE(e.command(CommandId::FLIP_TEXT_PATH, args("{\"refs\":[" + ref + "]}")) == OK);
  CHECK(lastLabel(e) == "Flip text path");
  text::textPathStartOf(props(e, t), tv, forward);
  CHECK_FALSE(forward);
  REQUIRE(e.command(CommandId::SET_TEXT_PATH_START, args("{\"ref\":" + ref + ",\"segment\":2,\"position\":0.25}")) == OK);
  CHECK(lastLabel(e) == "Move text start");
  text::textPathStartOf(props(e, t), tv, forward);
  CHECK(near(tv, 2.25));
  CHECK_FALSE(forward);  // kept
  e.command(CommandId::UNDO);
  e.command(CommandId::UNDO);
  text::textPathStartOf(props(e, t), tv, forward);
  CHECK(forward);
  CHECK(near(tv, 1.5));

  // Each shape type has a path to write on; the plugin's form replaces the source in its place.
  for (Guid src : {R1, LN, V}) {
    REQUIRE(e.command(CommandId::CREATE_TEXT_PATH, args("{\"ref\":\"" + src.toString() + "\",\"segment\":0,\"position\":0,\"replace\":false}")) == OK);
    Guid made = e.lastCreated()[0];
    CHECK(props(e, made).type == NodeType::TEXT_PATH);
    CHECK(e.document().has(src));
  }
  std::string pos = props(e, R2).parentIndex.position;
  REQUIRE(e.command(CommandId::CREATE_TEXT_PATH, args(R"({"ref":"1:2","segment":0,"position":0,"replace":true})")) == OK);
  Guid replaced = e.lastCreated()[0];
  CHECK_FALSE(e.document().has(R2));
  CHECK(props(e, replaced).name == "B");
  CHECK(props(e, replaced).parentIndex.position == pos);
  e.command(CommandId::UNDO);
  CHECK(e.document().has(R2));
  CHECK_FALSE(e.document().has(replaced));
  // A text has no path to write on.
  CHECK(e.command(CommandId::CREATE_TEXT_PATH, args("{\"ref\":" + ref + ",\"segment\":0,\"position\":0,\"replace\":false}")) == E_INVALID);
}

TEST_CASE("r7b the Text on path tool: hover an edge, click to write along it; the start handle drags; caret on the path") {
  Fonts fonts;
  Editor e = makeEditor();
  REQUIRE(e.setTool(Tool::TEXT_PATH) == OK);
  // Nowhere near a path: nothing.
  e.pointer(PointerEvent::MOVE, 900, 800, 0, 0, 0);
  CHECK(e.textPathTargetAt({800, 700}) == kNoGuid);
  // The ellipse's top edge (world 350, 0 → screen 450, 100).
  CHECK(e.textPathTargetAt({350, 1}) == EL);
  e.pointer(PointerEvent::MOVE, 450, 101, 0, 0, 0);
  e.takeEvents();
  CHECK(e.cursor() == CursorKind::TEXT_PATH);
  e.pointer(PointerEvent::DOWN, 450, 101, 0, 1, 0, 1);
  e.pointer(PointerEvent::UP, 450, 101, 0, 0, 0, 1);
  REQUIRE(e.textEditing());
  Guid t = e.textNode();
  CHECK(props(e, t).type == NodeType::TEXT_PATH);
  CHECK(e.tool() == Tool::MOVE);
  REQUIRE(e.textInput("Around") == OK);
  const text::TextLayout* L = e.textLayout(t);
  REQUIRE(L);
  REQUIRE(L->path);
  CHECK(L->glyphs.size() == 6);
  // The text starts at the click: its first glyph near the top of the circle.
  Vec2 g0 = e.document().worldTransform(t).apply({L->glyphs[0].x, L->glyphs[0].y});
  CHECK(std::fabs(g0.x - 350) < 3);
  CHECK(std::fabs(g0.y - 0) < 3);
  // The caret is on the path, at the end of the text (screen CSS px).
  Rect caret = e.caretRectCss();
  CHECK(caret.h > 5);
  CHECK(caret.x > 450);
  e.endTextEdit();
  REQUIRE(e.document().has(t));
  // The start handle: selected, not editing; a drag moves the start along the path, one step.
  e.setSelection({t});
  Guid hn;
  Vec2 hw;
  REQUIRE(e.textPathHandle(hn, hw));
  CHECK(hn == t);
  CHECK(std::fabs(hw.x - 350) < 1);
  CHECK(std::fabs(hw.y - 0) < 1);
  double before = 0, after = 0;
  bool fwd = true;
  text::textPathStartOf(props(e, t), before, fwd);
  e.takeEvents();
  // Drag it to the circle's right (world 400, 50 → screen 500, 150).
  e.pointer(PointerEvent::DOWN, 450, 100, 0, 1, 0, 1);
  e.pointer(PointerEvent::MOVE, 480, 120, 0, 1, 0, 1);
  e.pointer(PointerEvent::MOVE, 500, 150, 0, 1, 0, 1);
  e.pointer(PointerEvent::UP, 500, 150, 0, 0, 0, 1);
  CHECK(lastLabel(e) == "Move text start");
  text::textPathStartOf(props(e, t), after, fwd);
  CHECK(after != before);
  REQUIRE(e.textPathHandle(hn, hw));
  CHECK(std::fabs(hw.x - 400) < 1.5);
  CHECK(std::fabs(hw.y - 50) < 1.5);
  e.command(CommandId::UNDO);
  text::textPathStartOf(props(e, t), after, fwd);
  CHECK(near(after, before, 1e-6));

  // Left empty, a new text path goes, leaving no step (as a text).
  REQUIRE(e.setTool(Tool::TEXT_PATH) == OK);
  e.pointer(PointerEvent::DOWN, 100, 501, 0, 1, 0, 1);  // the line LN (world 0…100, 400)
  e.pointer(PointerEvent::UP, 100, 501, 0, 0, 0, 1);
  REQUIRE(e.textEditing());
  Guid empty = e.textNode();
  e.endTextEdit();
  CHECK_FALSE(e.document().has(empty));
}

TEST_CASE("r7b clipboard: brushes come along with the strokes that use them; a paste reuses a matching brush") {
  Editor a = makeEditor();
  a.setFileKey("fileA");
  Guid heist = installSquare(a, "Heist", false);
  a.setSelection({V});
  REQUIRE(a.command(CommandId::SET_STROKE_BRUSH, args("{\"brush\":\"" + heist.toString() + "\"}")) == OK);
  Clipboard clip;
  REQUIRE(a.copySelection(clip));
  bool carried = false;
  for (const NodeChange& c : clip.nodes) carried |= c.guid == heist && c.props.type == NodeType::BRUSH;
  CHECK(carried);

  Editor b;
  b.setSessionID(7);
  b.setViewport(1200, 900, 1, 1200, 900);
  b.loadDocument(baseChanges(), kNoGuid);
  b.setFileKey("fileB");
  REQUIRE(b.paste(clip, true) == 1);
  REQUIRE(b.listBrushes().size() == 1);
  Guid installed = b.listBrushes()[0].guid;
  CHECK(installed != heist);
  Guid pasted = b.selection()[0];
  CHECK(strokeBrushOf(b.document().get(pasted)->props) == installed);
  // Again: the same brush, not a second copy.
  REQUIRE(b.paste(clip, true) == 1);
  CHECK(b.listBrushes().size() == 1);
  CHECK(strokeBrushOf(b.document().get(b.selection()[0])->props) == installed);
  // Undo takes the first paste's brush away with it.
  b.command(CommandId::UNDO);
  b.command(CommandId::UNDO);
  CHECK(b.listBrushes().empty());
}

TEST_CASE("r7b multi-edit: every held layer shows its points; a marquee across two layers selects and moves both, one step") {
  Editor e = makeEditor();
  // Two lines: V (0, 200 → 200, 200) and a second at y 250.
  NodeChange w = vectorNode({1, 9}, "&", {0, 250, 200, 0}, lineNet(200), 2);
  REQUIRE(e.applyChanges({w}, APPLY_USER) == OK);
  Guid W{1, 9};
  e.setSelection({V, W});
  e.key(KeyEvent::DOWN, KeyCode::Enter, 0, 0, false);
  REQUIRE(e.vectorEditing());
  REQUIRE(e.vectorLayers().size() == 2);
  // Both layers' points are drawn.
  Overlay o = e.overlay();
  size_t vertices = 0;
  for (const OverlayMark& m : o.marks) vertices += m.shape == OverlayMark::Shape::Vertex;
  CHECK(vertices == 4);
  // A marquee around both lines' left ends (world -10…10, 190…260 → screen 90…110, 290…360).
  e.pointer(PointerEvent::DOWN, 85, 280, 0, 1, 0, 1);
  e.pointer(PointerEvent::MOVE, 100, 320, 0, 1, 0, 1);
  e.pointer(PointerEvent::MOVE, 112, 365, 0, 1, 0, 1);
  e.pointer(PointerEvent::UP, 112, 365, 0, 0, 0, 1);
  auto sel = e.vectorSelections();
  REQUIRE(sel.size() == 2);
  CHECK(sel[0].vertices.size() == 1);
  CHECK(sel[1].vertices.size() == 1);
  // Drag the edited layer's selected point: both move by 30 down.
  double y0 = e.document().worldBounds(W).y;
  Rect vb = e.document().worldBounds(V);
  e.takeEvents();
  e.pointer(PointerEvent::DOWN, 100, 300, 0, 1, 0, 1);
  e.pointer(PointerEvent::MOVE, 100, 315, 0, 1, 0, 1);
  e.pointer(PointerEvent::MOVE, 100, 330, 0, 1, 0, 1);
  e.pointer(PointerEvent::UP, 100, 330, 0, 0, 0, 1);
  auto ev = e.takeEvents();
  REQUIRE(ev.documents.size() == 1);  // one step over both layers
  CHECK(near(e.document().worldBounds(V).h, 30, 1e-6));
  CHECK(near(e.document().worldBounds(W).h, 30, 1e-6));
  CHECK(near(e.document().worldBounds(W).y, y0, 1e-6));  // the right end stayed
  e.command(CommandId::UNDO);
  CHECK(e.document().worldBounds(V) == vb);
  CHECK(near(e.document().worldBounds(W).h, 0, 1e-6));
  // Delete acts in each layer.
  e.vectorDeleteAndHeal();
}
