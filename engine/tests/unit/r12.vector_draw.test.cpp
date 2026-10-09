// Round 12 — vector edit's More menu tools (docs/engine-build.md "Round 12 — Vector edit More menu tools"; live
// toolbar/vector-edit-more-menu.txt): the Shape builder (planar faces of the held layers; click extracts, drag merges,
// ⌥ removes), Variable width (width points drawn by the stroker; the tool adds and drags them), Stroke settings'
// Width profile presets and Flip width points.
#include <cmath>

#include "doctest.h"
#include "editor/Editor.h"
#include "export/Scene.h"
#include "geometry/Boolean.h"
#include "geometry/PlanarFaces.h"
#include "geometry/Stroker.h"
#include "geometry/VariableWidth.h"
#include "hit/HitTest.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid X{1, 1}, Y{1, 2}, L{1, 3}, BR{1, 4}, D{1, 5};

double signedArea(const std::vector<geom::Polyline>& polys) {
  double a = 0;
  for (const auto& pl : polys)
    for (size_t i = 0; i < pl.points.size(); i++) {
      Vec2 p = pl.points[i], q = pl.points[(i + 1) % pl.points.size()];
      a += p.x * q.y - q.x * p.y;
    }
  return a / 2;
}

// The area a path covers under its rule.
double area(const geom::Path& path, WindingRule rule = WindingRule::NONZERO) {
  return std::fabs(signedArea(geom::flatten(geom::simplify(path, rule, 0.01), 0.01)));
}

geom::Path rect(double x, double y, double w, double h) {
  geom::Path p;
  p.moveTo({x, y});
  p.lineTo({x + w, y});
  p.lineTo({x + w, y + h});
  p.lineTo({x, y + h});
  p.close();
  return p;
}

geom::Path line(double length) {
  geom::Path p;
  p.moveTo({0, 0});
  p.lineTo({length, 0});
  return p;
}

NodeChange vectorNode(Guid id, const std::string& pos, Rect r, const geom::VectorNetwork& net, double weight) {
  NodeChange c = make(id, NodeType::VECTOR, kPage, pos, r, "Vector");
  VectorData d;
  d.present = true;
  d.normalizedSize = {r.w, r.h};
  d.network = std::make_shared<std::vector<uint8_t>>(net.encode());
  c.props.shape().vectorData = d;
  c.props.fillPaints.clear();
  c.props.strokePaints = {Paint::solid(Color::hex(0x000000))};
  c.props.strokeWeight = weight;
  return c;
}

geom::VectorNetwork lineNet(double length) {
  geom::VectorNetwork net;
  net.vertices = {{{0, 0}, 0}, {{length, 0}, 0}};
  net.segments = {geom::VNSegment{0, 1, {}, {}, 0}};
  return net;
}

// Two overlapping squares X (0, 0, 100) and Y (50, 50, 100), a line L (0, 300 → 100, 300, weight 10), a branching
// vector BR; the camera puts world (0, 0) at screen (100, 100).
Editor makeEditor() {
  auto nodes = baseChanges();
  nodes.push_back(make(X, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 100, 100}, "X"));
  NodeChange y = make(Y, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {50, 50, 100, 100}, "Y");
  y.props.fillPaints = {Paint::solid(Color::hex(0xFF0000))};
  nodes.push_back(y);
  nodes.push_back(vectorNode(L, "#", {0, 300, 100, 0}, lineNet(100), 10));
  geom::VectorNetwork br;
  br.vertices = {{{0, 0}, 0}, {{50, 50}, 0}, {{100, 0}, 0}, {{50, 100}, 0}};
  br.segments = {geom::VNSegment{0, 1, {}, {}, 0}, geom::VNSegment{1, 2, {}, {}, 0}, geom::VNSegment{1, 3, {}, {}, 0}};
  nodes.push_back(vectorNode(BR, "$", {300, 300, 100, 100}, br, 2));
  Editor e;
  e.setSessionID(1);
  e.setViewport(1200, 900, 1, 1200, 900);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({100, 100, 1});
  e.takeEvents();
  return e;
}

const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }

// A layer's fill area in world space.
double fillArea(const Editor& e, Guid id) {
  const NodeGeometry* g = e.document().geometry(id);
  REQUIRE(g);
  geom::Path all;
  for (const auto& f : g->fills) all.append(f.path.transformed(e.document().worldTransform(id)));
  return area(all);
}

CommandArgs args(const char* text) {
  CommandArgs a;
  json::parse(text, a.raw);
  return a;
}

void click(Editor& e, double x, double y, uint32_t mods = 0) {
  e.pointer(PointerEvent::DOWN, x, y, 0, 1, mods, 1);
  e.pointer(PointerEvent::UP, x, y, 0, 0, mods, 1);
}

}  // namespace

// ---- Geometry -------------------------------------------------------------------------------------------------------

TEST_CASE("r12 width profiles: the API's six presets, matched back; flipped along the path") {
  using geom::WidthProfile;
  for (int i = 0; i < static_cast<int>(WidthProfile::CUSTOM); i++) {
    auto p = static_cast<WidthProfile>(i);
    CHECK(geom::matchPreset(geom::presetPoints(p)) == p);
  }
  // WEDGE: full width → a point; TAPER: → a quarter; EYE: points at both ends, full in the middle.
  double a = 0, d = 0;
  auto wedge = geom::presetPoints(WidthProfile::WEDGE);
  geom::profileAt(wedge, 0, a, d);
  CHECK(a + d == doctest::Approx(1));
  geom::profileAt(wedge, 1, a, d);
  CHECK(a + d == doctest::Approx(0));
  geom::profileAt(wedge, 0.5, a, d);
  CHECK(a + d == doctest::Approx(0.5));
  geom::profileAt(geom::presetPoints(WidthProfile::TAPER), 1, a, d);
  CHECK(a + d == doctest::Approx(0.25));
  auto eye = geom::presetPoints(WidthProfile::EYE);
  geom::profileAt(eye, 0.5, a, d);
  CHECK(a + d == doctest::Approx(1));
  geom::profileAt(eye, 0.25, a, d);
  CHECK(a + d > 0.5);  // a lens, not a diamond
  auto flipped = geom::flipped(wedge);
  geom::profileAt(flipped, 0, a, d);
  CHECK(a + d == doctest::Approx(0));
  CHECK(geom::matchPreset(geom::flipped(geom::presetPoints(WidthProfile::EYE))) == WidthProfile::EYE);
}

TEST_CASE("r12 the variable-width stroker: a wedge is a triangle, the eye a lens; uniform without points") {
  geom::StrokeStyle s;
  s.width = 10;
  CHECK(area(geom::strokePath(line(100), s, 0.01)) == doctest::Approx(1000).epsilon(0.01));
  auto wedge = geom::presetPoints(geom::WidthProfile::WEDGE);
  s.profile = &wedge;
  CHECK(area(geom::strokePath(line(100), s, 0.01)) == doctest::Approx(500).epsilon(0.01));
  auto eye = geom::presetPoints(geom::WidthProfile::EYE);
  s.profile = &eye;
  // ∫ of the monotone cubic through (0, 0), (½, 1), (1, 0) = 7/12.
  CHECK(area(geom::strokePath(line(100), s, 0.01)) == doctest::Approx(1000 * 7.0 / 12).epsilon(0.01));
  // One-sided: the left (ascent) only.
  std::vector<geom::WidthPoint> left{{0, 1, 0}, {1, 1, 0}};
  s.profile = &left;
  Rect b = geom::strokePath(line(100), s, 0.01).bounds();
  CHECK(b.y == doctest::Approx(-10));
  CHECK(b.y + b.h == doctest::Approx(0));
  // One point in the middle: a bulge — the ends keep the stroke's weight.
  std::vector<geom::WidthPoint> bulge{{0.5, 1.5, 1.5}};
  s.profile = &bulge;
  geom::Path bulged = geom::strokePath(line(100), s, 0.01);
  CHECK(bulged.bounds().h == doctest::Approx(30));
  CHECK(area(bulged) > 1000);
  CHECK(area(bulged) < 3000);
  double a0 = 0, d0 = 0;
  geom::profileAt(bulge, 0, a0, d0);
  CHECK(a0 + d0 == doctest::Approx(1));
  // Dashes win (Figma: no width profile on a dashed stroke).
  s.profile = &wedge;
  s.dashes = {10, 10};
  CHECK(area(geom::strokePath(line(100), s, 0.01)) == doctest::Approx(500).epsilon(0.02));
}

TEST_CASE("r12 width points round-trip through the node (variableWidthPoints, schema 447)") {
  NodeProps p;
  auto eye = geom::presetPoints(geom::WidthProfile::EYE);
  p.extra["variableWidthPoints"] = encodeWidthPoints(eye);
  CHECK(hasWidthPoints(p));
  auto back = widthPointsOf(p);
  REQUIRE(back.size() == 3);
  for (size_t i = 0; i < 3; i++) {
    CHECK(back[i].position == doctest::Approx(eye[i].position));
    CHECK(back[i].ascent == doctest::Approx(eye[i].ascent));
    CHECK(back[i].descent == doctest::Approx(eye[i].descent));
  }
  CHECK(encodeWidthPoints({}).empty());
  // Not on dashes or a dynamic stroke.
  CHECK(widthProfileAllowed(p));
  p.stroke().dashPattern = {4, 4};
  CHECK_FALSE(widthProfileAllowed(p));
}

TEST_CASE("r12 planar faces: overlaps, nesting, self-intersections; curves kept") {
  // Two overlapping squares: three regions.
  auto faces = geom::planarFaces({{rect(0, 0, 100, 100)}, {rect(50, 50, 100, 100)}}, 0.05);
  REQUIRE(faces.size() == 3);
  std::vector<double> areas;
  for (auto& f : faces) areas.push_back(f.area);
  std::sort(areas.begin(), areas.end());
  CHECK(areas[0] == doctest::Approx(2500));
  CHECK(areas[1] == doctest::Approx(7500));
  CHECK(areas[2] == doctest::Approx(7500));
  for (auto& f : faces) CHECK(area(f.path) == doctest::Approx(f.area).epsilon(0.001));
  int both = 0;
  for (auto& f : faces) both += f.covers.size() == 2;
  CHECK(both == 1);
  // A square inside another, touching nothing: the outer one's region has it as a hole.
  faces = geom::planarFaces({{rect(0, 0, 100, 100)}, {rect(25, 25, 50, 50)}}, 0.05);
  REQUIRE(faces.size() == 2);
  for (auto& f : faces) {
    if (f.covers.size() == 2) CHECK(f.area == doctest::Approx(2500));
    else CHECK(f.area == doctest::Approx(7500));
    CHECK(area(f.path) == doctest::Approx(f.area).epsilon(0.001));
  }
  // A bow tie (one contour crossing itself): two triangles.
  geom::Path tie;
  tie.moveTo({0, 0});
  tie.lineTo({100, 100});
  tie.lineTo({100, 0});
  tie.lineTo({0, 100});
  tie.close();
  faces = geom::planarFaces({{tie}}, 0.05);
  REQUIRE(faces.size() == 2);
  CHECK(faces[0].area == doctest::Approx(2500));
  CHECK(faces[1].area == doctest::Approx(2500));
  // A pentagram: five tips and the centre.
  geom::Path star;
  for (int i = 0; i < 5; i++) {
    double a = -M_PI / 2 + i * 4 * M_PI / 5;
    Vec2 p{100 + 100 * std::cos(a), 100 + 100 * std::sin(a)};
    if (i == 0) star.moveTo(p);
    else star.lineTo(p);
  }
  star.close();
  CHECK(geom::planarFaces({{star}}, 0.05).size() == 6);
  // Two circles: three regions bounded by the circles' own curves.
  geom::Path c1, c2;
  auto circle = [](geom::Path& p, Vec2 c, double r) {
    const double k = 0.5522847498 * r;
    p.moveTo({c.x + r, c.y});
    p.cubicTo({c.x + r, c.y + k}, {c.x + k, c.y + r}, {c.x, c.y + r});
    p.cubicTo({c.x - k, c.y + r}, {c.x - r, c.y + k}, {c.x - r, c.y});
    p.cubicTo({c.x - r, c.y - k}, {c.x - k, c.y - r}, {c.x, c.y - r});
    p.cubicTo({c.x + k, c.y - r}, {c.x + r, c.y - k}, {c.x + r, c.y});
    p.close();
  };
  circle(c1, {50, 50}, 50);
  circle(c2, {100, 50}, 50);
  geom::PlanarMap map = geom::planarMap({{c1}, {c2}}, 0.05);
  REQUIRE(map.faces.size() == 3);
  for (auto& f : map.faces) {
    bool cubic = false;
    for (auto v : f.path.verbs) cubic |= v == geom::Verb::Cubic;
    CHECK(cubic);
  }
  // Unions come from the graph: all three faces are the two circles' union, one contour; any split of the faces
  // into two unions adds up exactly.
  geom::Path all = map.unionOf({0, 1, 2});
  int contours = 0;
  for (auto v : all.verbs) contours += v == geom::Verb::Move;
  CHECK(contours == 1);
  double total = area(all);
  CHECK(total == doctest::Approx(area(c1) + area(c2) - [&] {
          for (auto& f : map.faces)
            if (f.covers.size() == 2) return f.area;
          return 0.0;
        }()).epsilon(0.002));
  for (int f = 0; f < 3; f++) {
    std::vector<int> rest;
    for (int g = 0; g < 3; g++)
      if (g != f) rest.push_back(g);
    CHECK(area(map.unionOf({f})) + area(map.unionOf(rest)) == doctest::Approx(total).epsilon(0.002));
  }
}

// ---- Variable width in the editor ------------------------------------------------------------------------------------

TEST_CASE("r12 Variable width (⇧W): click on the stroke adds a width point, a drag sets its width, Delete removes it") {
  Editor e = makeEditor();
  e.setSelection({L});
  REQUIRE(e.startVectorEdit(L) == OK);
  CHECK(e.variableWidthAvailable());
  // ⇧W picks the tool.
  e.key(KeyEvent::DOWN, KeyCode::KeyW, 'W', MOD_SHIFT, false);
  REQUIRE(e.vectorTool() == Editor::VectorTool::VARIABLE_WIDTH);
  // The line runs (100, 400) → (200, 400) on screen: press at its middle, drag 20 px up.
  e.pointer(PointerEvent::DOWN, 150, 400, 0, 1, 0, 1);
  e.pointer(PointerEvent::MOVE, 150, 390, 0, 1, 0);
  e.pointer(PointerEvent::MOVE, 150, 380, 0, 1, 0);
  e.pointer(PointerEvent::UP, 150, 380, 0, 0, 0, 1);
  auto points = widthPointsOf(props(e, L));
  REQUIRE(points.size() == 1);
  CHECK(points[0].position == doctest::Approx(0.5));
  CHECK(points[0].ascent == doctest::Approx(2));  // 20 px off a 10 px stroke
  CHECK(points[0].descent == doctest::Approx(2));
  CHECK(e.vectorWidthSelected() == 0);
  // Drawn: the layer's box grows to the widened stroke.
  CHECK(e.document().renderBounds(L).h >= 40);
  // Hit where only the widened stroke reaches.
  CHECK(hitsNode(e.document(), L, {50, -15}, 0.5, true));
  CHECK_FALSE(hitsNode(e.document(), L, {50, -45}, 0.5, true));
  // The export draws its outline.
  CHECK(exporter::strokeOf(e.document(), L, props(e, L)).outlineOnly);
  // One undo step.
  e.command(CommandId::UNDO);
  CHECK(widthPointsOf(props(e, L)).empty());
  e.command(CommandId::REDO);
  REQUIRE(widthPointsOf(props(e, L)).size() == 1);
  // The point's centre moves it along the path.
  e.pointer(PointerEvent::DOWN, 150, 400, 0, 1, 0, 1);
  e.pointer(PointerEvent::MOVE, 160, 400, 0, 1, 0);
  e.pointer(PointerEvent::MOVE, 175, 401, 0, 1, 0);
  e.pointer(PointerEvent::UP, 175, 401, 0, 0, 0, 1);
  points = widthPointsOf(props(e, L));
  REQUIRE(points.size() == 1);
  CHECK(points[0].position == doctest::Approx(0.75));
  // Delete removes the selected one.
  e.key(KeyEvent::DOWN, KeyCode::Delete, 0, 0, false);
  CHECK(widthPointsOf(props(e, L)).empty());
}

TEST_CASE("r12 Variable width is not available on a dashed stroke or a branching network") {
  Editor e = makeEditor();
  REQUIRE(e.startVectorEdit(BR) == OK);
  CHECK_FALSE(e.variableWidthAvailable());
  CHECK(e.setVectorTool(Editor::VectorTool::VARIABLE_WIDTH) == E_UNSUPPORTED);
  e.key(KeyEvent::DOWN, KeyCode::KeyW, 'W', MOD_SHIFT, false);
  CHECK(e.vectorTool() == Editor::VectorTool::MOVE);
  e.endVectorEdit();
  NodeChange dashed = NodeChange::changed(Guid{0, 0});
  dashed.mask = F_DASH_PATTERN;
  dashed.props.stroke().dashPattern = {4, 4};
  e.setProps({L}, dashed, 0);
  REQUIRE(e.startVectorEdit(L) == OK);
  CHECK(e.setVectorTool(Editor::VectorTool::VARIABLE_WIDTH) == E_UNSUPPORTED);
}

TEST_CASE("r12 Width profile and Flip width points (Stroke settings): presets on the selection, one undo step each") {
  Editor e = makeEditor();
  e.setSelection({X, L});
  CHECK((e.commandState(CommandId::SET_WIDTH_PROFILE) & CMD_ENABLED) != 0);
  CHECK((e.commandState(CommandId::FLIP_WIDTH_POINTS) & CMD_ENABLED) == 0);
  REQUIRE(e.command(CommandId::SET_WIDTH_PROFILE, args("{\"profile\":\"WEDGE\"}")) == OK);
  CHECK(geom::matchPreset(widthPointsOf(props(e, X))) == geom::WidthProfile::WEDGE);
  CHECK(geom::matchPreset(widthPointsOf(props(e, L))) == geom::WidthProfile::WEDGE);
  CHECK((e.commandState(CommandId::FLIP_WIDTH_POINTS) & CMD_ENABLED) != 0);
  REQUIRE(e.command(CommandId::FLIP_WIDTH_POINTS) == OK);
  auto flipped = widthPointsOf(props(e, L));
  REQUIRE(flipped.size() == 2);
  CHECK(flipped[0].width() == doctest::Approx(0));
  CHECK(flipped[1].width() == doctest::Approx(1));
  // Refs win over the selection; UNIFORM clears the points.
  REQUIRE(e.command(CommandId::SET_WIDTH_PROFILE, args("{\"profile\":\"UNIFORM\",\"refs\":[\"1:3\"]}")) == OK);
  CHECK_FALSE(hasWidthPoints(props(e, L)));
  CHECK(hasWidthPoints(props(e, X)));
  e.command(CommandId::UNDO);
  CHECK(hasWidthPoints(props(e, L)));
  CHECK(e.command(CommandId::SET_WIDTH_PROFILE, args("{\"profile\":\"NOPE\"}")) == E_INVALID);
  // A rectangle with a profile is drawn by the stroker, not the box shader: its bounds hold the widest point.
  REQUIRE(e.command(CommandId::SET_WIDTH_PROFILE, args("{\"profile\":\"EYE\",\"refs\":[\"1:1\"]}")) == OK);
  CHECK(hitsNode(e.document(), X, {50, 0.4}, 0.1, true));
}

// ---- The Shape builder ---------------------------------------------------------------------------------------------

TEST_CASE("r12 Shape builder (M): Enter on two layers, a click extracts the overlap to its own layer") {
  Editor e = makeEditor();
  e.setSelection({X, Y});
  e.key(KeyEvent::DOWN, KeyCode::Enter, 0, 0, false);
  REQUIRE(e.vectorEditing());
  CHECK(e.vectorLayers().size() == 2);
  e.key(KeyEvent::DOWN, KeyCode::KeyM, 'm', 0, false);
  REQUIRE(e.vectorTool() == Editor::VectorTool::SHAPE_BUILDER);
  REQUIRE(e.shapeBuilderFaces().size() == 3);
  // Hover over the overlap (world 75, 75 → screen 175, 175) shows it.
  e.pointer(PointerEvent::MOVE, 175, 175, 0, 0, 0);
  REQUIRE(e.shapeBuilderHover() >= 0);
  CHECK(e.shapeBuilderFaces()[static_cast<size_t>(e.shapeBuilderHover())].area == doctest::Approx(2500));
  click(e, 175, 175);
  // A new layer above Y with Y's look; X and Y lost the overlap (destructive: they are vectors now).
  auto top = e.document().children(kPage);
  REQUIRE(top.size() == 5);
  Guid made = kNoGuid;
  for (Guid g : top)
    if (g != X && g != Y && g != L && g != BR) made = g;
  REQUIRE(made != kNoGuid);
  CHECK(props(e, made).type == NodeType::VECTOR);
  CHECK(props(e, made).name == "Y");
  CHECK(props(e, made).fillPaints[0].color == Color::hex(0xFF0000));
  CHECK(fillArea(e, made) == doctest::Approx(2500).epsilon(0.01));
  CHECK(props(e, X).type == NodeType::VECTOR);
  CHECK(fillArea(e, X) == doctest::Approx(7500).epsilon(0.01));
  CHECK(fillArea(e, Y) == doctest::Approx(7500).epsilon(0.01));
  CHECK(e.document().paintsBefore(Y, made));
  CHECK(e.vectorEditing());
  CHECK(e.vectorLayers().size() == 3);
  // One undo step restores the shapes.
  e.command(CommandId::UNDO);
  CHECK_FALSE(e.document().has(made));
  CHECK(props(e, X).type == NodeType::ROUNDED_RECTANGLE);
  CHECK(props(e, Y).type == NodeType::ROUNDED_RECTANGLE);
  CHECK(fillArea(e, X) == doctest::Approx(10000).epsilon(0.01));
}

TEST_CASE("r12 Shape builder: ⌥-click removes a region; a drag across regions merges them into one layer") {
  Editor e = makeEditor();
  e.setSelection({X, Y});
  e.key(KeyEvent::DOWN, KeyCode::Enter, 0, 0, false);
  REQUIRE(e.setVectorTool(Editor::VectorTool::SHAPE_BUILDER) == OK);
  click(e, 175, 175, MOD_ALT);
  CHECK(e.document().children(kPage).size() == 4);
  CHECK(fillArea(e, X) == doctest::Approx(7500).epsilon(0.01));
  CHECK(fillArea(e, Y) == doctest::Approx(7500).epsilon(0.01));
  e.command(CommandId::UNDO);
  REQUIRE(fillArea(e, X) == doctest::Approx(10000).epsilon(0.01));
  // A drag from X's own part across the overlap into Y's: everything merges; X and Y are left with nothing.
  e.pointer(PointerEvent::MOVE, 125, 125, 0, 0, 0);
  e.pointer(PointerEvent::DOWN, 125, 125, 0, 1, 0, 1);
  e.pointer(PointerEvent::MOVE, 175, 175, 0, 1, 0);
  e.pointer(PointerEvent::MOVE, 225, 225, 0, 1, 0);
  e.pointer(PointerEvent::UP, 225, 225, 0, 0, 0, 1);
  CHECK_FALSE(e.document().has(X));
  CHECK_FALSE(e.document().has(Y));
  auto top = e.document().children(kPage);
  REQUIRE(top.size() == 3);
  Guid made = top.front();  // where Y was
  CHECK(fillArea(e, made) == doctest::Approx(17500).epsilon(0.01));
  CHECK(e.vectorEditing());
  CHECK(e.vectorNode() == made);
  e.command(CommandId::UNDO);
  CHECK(e.document().has(X));
  CHECK(e.document().has(Y));
}

TEST_CASE("r12 Shape builder on curves: a drag over everything leaves no slivers behind") {
  auto nodes = baseChanges();
  nodes.push_back(make(X, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 100, 100}, "X"));
  nodes.push_back(make(Y, NodeType::ELLIPSE, kPage, "\"", {50, 50, 100, 100}, "E"));
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({100, 100, 1});
  REQUIRE(e.startVectorEditMany({X, Y}) == OK);
  REQUIRE(e.setVectorTool(Editor::VectorTool::SHAPE_BUILDER) == OK);
  REQUIRE(e.shapeBuilderFaces().size() == 3);
  // Extract the overlap: X and E keep their own parts, exactly (one contour each).
  click(e, 180, 180);
  auto contours = [&](Guid id) {
    int n = 0;
    for (auto& f : e.document().geometry(id)->fills)
      for (auto v : f.path.verbs) n += v == geom::Verb::Move;
    return n;
  };
  CHECK(contours(X) == 1);
  CHECK(contours(Y) == 1);
  // Everything merged: X, E and the extracted part all go into one layer.
  e.pointer(PointerEvent::MOVE, 120, 120, 0, 0, 0);
  e.pointer(PointerEvent::DOWN, 120, 120, 0, 1, 0, 1);
  e.pointer(PointerEvent::MOVE, 180, 180, 0, 1, 0);
  e.pointer(PointerEvent::MOVE, 230, 230, 0, 1, 0);
  e.pointer(PointerEvent::UP, 230, 230, 0, 0, 0, 1);
  CHECK_FALSE(e.document().has(X));
  CHECK_FALSE(e.document().has(Y));
  // (the extracted part was crossed too: it is in the merge)
  auto top = e.document().children(kPage);
  REQUIRE(top.size() == 1);
  CHECK(contours(top[0]) == 1);
  CHECK(e.vectorNode() == top[0]);
}

TEST_CASE("r12 Shape builder on one self-crossing layer; the tool's state in the vector edit event") {
  auto nodes = baseChanges();
  geom::VectorNetwork tie;
  tie.vertices = {{{0, 0}, 0}, {{100, 100}, 0}, {{100, 0}, 0}, {{0, 100}, 0}};
  tie.segments = {geom::VNSegment{0, 1, {}, {}, 0}, geom::VNSegment{1, 2, {}, {}, 0}, geom::VNSegment{2, 3, {}, {}, 0},
                  geom::VNSegment{3, 0, {}, {}, 0}};
  geom::VNRegion r;
  r.loops = {{0, 1, 2, 3}};
  tie.regions = {r};
  NodeChange v = vectorNode(D, "!", {0, 0, 100, 100}, tie, 1);
  v.props.fillPaints = {Paint::solid(Color::hex(0x00FF00))};
  nodes.push_back(v);
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({100, 100, 1});
  REQUIRE(e.startVectorEdit(D) == OK);
  REQUIRE(e.setVectorTool(Editor::VectorTool::SHAPE_BUILDER) == OK);
  REQUIRE(e.shapeBuilderFaces().size() == 2);
  // The left triangle (world 20, 50).
  click(e, 120, 150);
  CHECK(e.document().children(kPage).size() == 2);
  CHECK(fillArea(e, D) == doctest::Approx(2500).epsilon(0.01));
  // Escape goes back to Move first.
  e.key(KeyEvent::DOWN, KeyCode::Escape, 0, 0, false);
  CHECK(e.vectorTool() == Editor::VectorTool::MOVE);
  CHECK(e.vectorEditing());
}

TEST_CASE("r12 Shape builder: regions cut from each other stay exact — no slivers between them after an extract") {
  // As on the capture: a rect and an ellipse over its corner; the overlap extracted, then a drag over everything.
  auto nodes = baseChanges();
  nodes.push_back(make(X, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 300, 120, 90}, "Rect"));
  nodes.push_back(make(Y, NodeType::ELLIPSE, kPage, "\"", {60, 320, 100, 100}, "Ellipse"));
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({100, -200, 1});
  REQUIRE(e.startVectorEditMany({X, Y}) == OK);
  REQUIRE(e.setVectorTool(Editor::VectorTool::SHAPE_BUILDER) == OK);
  click(e, 200, 160);
  REQUIRE(e.document().children(kPage).size() == 3);
  double total = 0;
  for (Guid g : e.document().children(kPage)) total += fillArea(e, g);
  e.pointer(PointerEvent::MOVE, 120, 140, 0, 0, 0);
  // Three regions again (rect's part, the extracted overlap, ellipse's part): the outlines they share are one.
  CHECK(e.shapeBuilderFaces().size() == 3);
  e.pointer(PointerEvent::DOWN, 120, 140, 0, 1, 0, 1);
  e.pointer(PointerEvent::MOVE, 180, 170, 0, 1, 0);
  e.pointer(PointerEvent::MOVE, 240, 200, 0, 1, 0);
  e.pointer(PointerEvent::UP, 240, 200, 0, 0, 0, 1);
  REQUIRE(e.document().children(kPage).size() == 1);
  CHECK(fillArea(e, e.document().children(kPage)[0]) == doctest::Approx(total).epsilon(0.002));
}
