// E4 editing: the shape tools, the Pen and the Pencil, vector edit mode
// (vertices, handles and their mirroring, the bend tool, delete and heal), end
// caps, and vectors under the pointer.
#include <cmath>

#include "doctest.h"
#include "editor/Editor.h"
#include "geometry/VectorNetwork.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid R{1, 1}, S{1, 2};

Editor makeEditor() {
  auto nodes = baseChanges();
  nodes.push_back(make(R, NodeType::ROUNDED_RECTANGLE, kPage, "!", {100, 100, 100, 100}, "Rectangle 1"));
  NodeChange star = make(S, NodeType::STAR, kPage, "\"", {400, 100, 100, 100}, "Star 1");
  star.props.shape().starInnerScale = 0.4;
  nodes.push_back(star);
  Editor e;
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kNoGuid);
  e.takeEvents();
  return e;
}

void down(Editor& e, double x, double y, uint32_t mods = 0, int clicks = 1) { e.pointer(PointerEvent::DOWN, x, y, 0, 1, mods, clicks); }
void move(Editor& e, double x, double y, uint32_t mods = 0) { e.pointer(PointerEvent::MOVE, x, y, 0, 1, mods); }
void up(Editor& e, double x, double y, uint32_t mods = 0) { e.pointer(PointerEvent::UP, x, y, 0, 0, mods); }
void click(Editor& e, double x, double y, uint32_t mods = 0, int clicks = 1) {
  down(e, x, y, mods, clicks);
  up(e, x, y, mods);
}
void drag(Editor& e, Vec2 from, Vec2 to, uint32_t mods = 0) {
  down(e, from.x, from.y, mods);
  for (int i = 1; i <= 4; i++) move(e, from.x + (to.x - from.x) * i / 4, from.y + (to.y - from.y) * i / 4, mods);
  up(e, to.x, to.y, mods);
}
const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }

geom::VectorNetwork networkOf(const Editor& e, Guid id) {
  const NodeProps& p = props(e, id);
  geom::VectorNetwork n;
  REQUIRE(p.shape().vectorData.network);
  REQUIRE(geom::VectorNetwork::decode(p.shape().vectorData.network->data(), p.shape().vectorData.network->size(), n));
  return n;
}

}  // namespace

TEST_CASE("shape tools: line, arrow, polygon, star") {
  Editor e = makeEditor();
  REQUIRE(e.setTool(Tool::LINE) == OK);
  drag(e, {100, 400}, {200, 300});
  REQUIRE(e.selection().size() == 1);
  Guid line = e.selection()[0];
  const NodeProps& l = props(e, line);
  CHECK(l.type == NodeType::LINE);
  CHECK(l.name == "Line 1");
  CHECK(l.size.x == doctest::Approx(std::sqrt(20000.0)));
  CHECK(l.size.y == 0);
  CHECK(std::atan2(l.transform.m10, l.transform.m00) == doctest::Approx(-3.14159265358979 / 4));
  CHECK(l.strokeAlign == StrokeAlign::CENTER);
  CHECK(e.tool() == Tool::MOVE);
  // ⇧: 45° steps.
  e.setTool(Tool::LINE);
  drag(e, {100, 500}, {300, 510}, MOD_SHIFT);
  CHECK(props(e, e.selection()[0]).transform.m10 == doctest::Approx(0).epsilon(1e-9));
  // An arrow: a line whose end vertex has an arrowhead.
  e.setTool(Tool::ARROW);
  drag(e, {300, 400}, {500, 400});
  Guid arrow = e.selection()[0];
  CHECK(props(e, arrow).type == NodeType::LINE);
  CHECK(props(e, arrow).name == "Arrow 1");
  StrokeCap a = StrokeCap::NONE, b = StrokeCap::NONE;
  REQUIRE(e.endCaps(arrow, a, b));
  CHECK(a == StrokeCap::NONE);
  CHECK(b == StrokeCap::ARROW_LINES);
  // Start point / End point.
  StrokeCap round = StrokeCap::ROUND;
  REQUIRE(e.setEndCaps({line}, &round, nullptr) == OK);
  REQUIRE(e.endCaps(line, a, b));
  CHECK(a == StrokeCap::ROUND);
  CHECK(b == StrokeCap::NONE);
  // A polygon and a star with a click: 100 × 100, Figma's counts.
  e.setTool(Tool::POLYGON);
  click(e, 600, 400);
  CHECK(props(e, e.selection()[0]).type == NodeType::REGULAR_POLYGON);
  CHECK(props(e, e.selection()[0]).shape().count == 3);
  CHECK(props(e, e.selection()[0]).size == Vec2{100, 100});
  e.setTool(Tool::STAR);
  click(e, 600, 520);
  CHECK(props(e, e.selection()[0]).shape().count == 5);
  CHECK(props(e, e.selection()[0]).shape().starInnerScale == doctest::Approx(0.382));
  CHECK(props(e, e.selection()[0]).name == "Star 2");
}

TEST_CASE("pen: points, a closed loop becomes a filled area, one undo step per point") {
  Editor e = makeEditor();
  REQUIRE(e.setTool(Tool::PEN) == OK);
  click(e, 100, 300);
  REQUIRE(e.vectorEditing());
  Guid v = e.vectorNode();
  CHECK(props(e, v).type == NodeType::VECTOR);
  CHECK(props(e, v).name == "Vector");
  click(e, 200, 300);
  click(e, 200, 400);
  CHECK(e.vectorNetwork().segments.size() == 2);
  CHECK(e.tool() == Tool::PEN);
  // Back on the first point: the loop closes into a region.
  click(e, 100, 300);
  geom::VectorNetwork n = networkOf(e, v);
  CHECK(n.vertices.size() == 3);
  CHECK(n.segments.size() == 3);
  REQUIRE(n.regions.size() == 1);
  CHECK(n.regions[0].loops[0].size() == 3);
  // The box fits the network.
  CHECK(props(e, v).size == Vec2{100, 100});
  CHECK(props(e, v).transform.m02 == 100);
  CHECK(props(e, v).transform.m12 == 300);
  // A drag pulls out mirrored handles.
  click(e, 600, 300);
  drag(e, {700, 300}, {700, 350});
  geom::VectorNetwork m = networkOf(e, v);
  const auto& last = m.segments.back();
  CHECK(last.tangentEnd.y == doctest::Approx(-50));
  // Esc ends the path, Esc again the pen, then the mode.
  e.key(KeyEvent::DOWN, KeyCode::Escape, 0, 0, false);
  e.key(KeyEvent::DOWN, KeyCode::Escape, 0, 0, false);
  CHECK(e.vectorTool() == Editor::VectorTool::MOVE);
  CHECK(e.tool() == Tool::MOVE);
  e.key(KeyEvent::DOWN, KeyCode::Escape, 0, 0, false);
  CHECK_FALSE(e.vectorEditing());
  CHECK(e.selection() == std::vector<Guid>{v});
  // Undo walks the points back one by one (a point dragged out is one step), then the vector goes.
  size_t before = networkOf(e, v).vertices.size();
  e.command(CommandId::UNDO);
  CHECK(networkOf(e, v).vertices.size() == before - 1);
  e.command(CommandId::UNDO);
  CHECK(networkOf(e, v).vertices.size() == before - 2);
  for (int i = 0; i < 10; i++) e.command(CommandId::UNDO);
  CHECK_FALSE(e.document().has(v));
}

TEST_CASE("vector edit mode: a shape becomes a VECTOR at its first edit; drag, mirroring, delete and heal") {
  Editor e = makeEditor();
  click(e, 150, 150);
  REQUIRE(e.selection() == std::vector<Guid>{R});
  click(e, 150, 150, 0, 2);
  REQUIRE(e.vectorEditing());
  CHECK(props(e, R).type == NodeType::ROUNDED_RECTANGLE);  // not yet: nothing changed
  CHECK(e.vectorNetwork().vertices.size() == 4);
  // Drag the top-left corner out: now a VECTOR, the box refitted, one undo step.
  drag(e, {100, 100}, {80, 90});
  CHECK(props(e, R).type == NodeType::VECTOR);
  CHECK(props(e, R).transform.m02 == 80);
  CHECK(props(e, R).transform.m12 == 90);
  CHECK(props(e, R).size == Vec2{120, 110});
  e.command(CommandId::UNDO);
  CHECK(props(e, R).type == NodeType::ROUNDED_RECTANGLE);
  CHECK(props(e, R).size == Vec2{100, 100});
  REQUIRE(e.vectorEditing());
  CHECK(e.vectorNetwork().vertices.size() == 4);
  // Select a corner, delete and heal: a triangle.
  click(e, 200, 100);
  REQUIRE(e.vectorSelectedVertices().size() == 1);
  e.key(KeyEvent::DOWN, KeyCode::Backspace, 0, 0, false);
  geom::VectorNetwork n = networkOf(e, R);
  CHECK(n.vertices.size() == 3);
  CHECK(n.segments.size() == 3);
  REQUIRE(n.regions.size() == 1);
  CHECK(n.regions[0].loops[0].size() == 3);
  // The bend tool (⌘) on a point makes it smooth with mirrored handles; mirroring is a per-vertex style.
  click(e, 100, 100, MOD_PRIMARY);
  geom::VectorNetwork b = networkOf(e, R);
  bool curved = false;
  for (auto& s : b.segments) curved |= !s.isLine();
  CHECK(curved);
  click(e, 100, 100);
  REQUIRE(e.setVectorMirroring(VectorMirror::ANGLE_AND_LENGTH) == OK);
  VectorMirror m = VectorMirror::NONE;
  CHECK(e.vectorMirroring(m) == 1);
  CHECK(m == VectorMirror::ANGLE_AND_LENGTH);
  // Points: X / Y in the parent's space, corner radius per vertex.
  auto pts = e.vectorPoints();
  REQUIRE(pts.size() == 1);
  CHECK(pts[0].parent.x == doctest::Approx(100));
  double x = 90, r = 8;
  REQUIRE(e.setVectorPoints(&x, nullptr, &r) == OK);
  pts = e.vectorPoints();
  CHECK(pts[0].parent.x == doctest::Approx(90));
  CHECK(pts[0].cornerRadius == 8);
  e.key(KeyEvent::DOWN, KeyCode::Enter, 0, 0, false);
  CHECK_FALSE(e.vectorEditing());
}

TEST_CASE("pencil: a freehand stroke becomes a smooth vector") {
  Editor e = makeEditor();
  REQUIRE(e.setTool(Tool::PENCIL) == OK);
  down(e, 100, 400);
  for (int i = 1; i <= 40; i++) move(e, 100 + i * 5, 400 + 30 * std::sin(i * 0.3));
  up(e, 300, 400);
  REQUIRE(e.selection().size() == 1);
  Guid v = e.selection()[0];
  CHECK(props(e, v).type == NodeType::VECTOR);
  geom::VectorNetwork n = networkOf(e, v);
  CHECK(n.vertices.size() >= 4);
  CHECK(n.vertices.size() < 41);
  CHECK(props(e, v).strokeCap == StrokeCap::ROUND);
}

TEST_CASE("vectors are hit by their shape") {
  Editor e = makeEditor();
  click(e, 450, 150);  // the star's middle
  CHECK(e.selection() == std::vector<Guid>{S});
  click(e, 700, 500);
  CHECK(e.selection().empty());
  click(e, 405, 105);  // the star's box corner: outside the star
  CHECK(e.selection().empty());
}

TEST_CASE("booleans, Flatten, Outline stroke, Use as mask, Place image") {
  Editor e = makeEditor();
  // A second rectangle overlapping the first.
  NodeChange r2 = make({1, 3}, NodeType::ROUNDED_RECTANGLE, kPage, "#", {150, 150, 100, 100}, "Rectangle 2");
  r2.props.fillPaints = {Paint::solid(Color::hex(0xFF0000))};
  e.applyChanges({r2}, APPLY_LOAD);
  e.setSelection({R, {1, 3}});
  CHECK((e.commandState(CommandId::BOOLEAN_UNION) & CMD_ENABLED) != 0);
  REQUIRE(e.command(CommandId::BOOLEAN_SUBTRACT) == OK);
  REQUIRE(e.selection().size() == 1);
  Guid b = e.selection()[0];
  const NodeProps& bp = props(e, b);
  CHECK(bp.type == NodeType::BOOLEAN_OPERATION);
  CHECK(bp.shape().booleanOperation == BooleanOperation::SUBTRACT);
  CHECK(bp.name == "Subtract");
  CHECK(bp.fillPaints[0].color == Color::hex(0xD9D9D9));  // the bottom layer's look
  CHECK(e.document().children(b).size() == 2);
  CHECK(bp.size == Vec2{150, 150});  // fitted to its operands
  const NodeGeometry* g = e.document().geometry(b);
  REQUIRE(g);
  REQUIRE(g->fills.size() == 1);
  CHECK(e.undoStack().undoLabel() == "Subtract selection");
  // Clicking inside the result hits the boolean; inside the cut-out part doesn't.
  e.setSelection({});
  click(e, 120, 120);
  CHECK(e.selection() == std::vector<Guid>{b});
  e.setSelection({});
  click(e, 190, 190);
  CHECK(e.selection().empty());
  // Switching the operation of a selected boolean.
  e.setSelection({b});
  REQUIRE(e.command(CommandId::BOOLEAN_UNION) == OK);
  CHECK(props(e, b).shape().booleanOperation == BooleanOperation::UNION);
  // Flatten: the same GUID, now a VECTOR, its operands gone.
  REQUIRE(e.command(CommandId::FLATTEN) == OK);
  CHECK(props(e, b).type == NodeType::VECTOR);
  CHECK(e.document().children(b).empty());
  CHECK(props(e, b).size == Vec2{150, 150});
  e.command(CommandId::UNDO);
  CHECK(props(e, b).type == NodeType::BOOLEAN_OPERATION);
  CHECK(e.document().children(b).size() == 2);
  // One layer (live Figma's Boolean operations menu on a rectangle): a boolean group around it, one undo step.
  e.setSelection({{1, 3}});
  CHECK((e.commandState(CommandId::BOOLEAN_UNION) & CMD_ENABLED) != 0);
  e.command(CommandId::UNDO);
  e.command(CommandId::UNDO);
  e.setSelection({{1, 3}});
  REQUIRE(e.command(CommandId::BOOLEAN_UNION) == OK);
  Guid single = e.selection()[0];
  CHECK(props(e, single).type == NodeType::BOOLEAN_OPERATION);
  CHECK(e.document().children(single) == std::vector<Guid>{{1, 3}});
  CHECK(props(e, single).size == Vec2{100, 100});
  e.command(CommandId::UNDO);
  CHECK(!e.document().has(single));
  CHECK(e.document().parentOf({1, 3}) == kPage);
  // Flatten a frame (live: an instance's More actions › Flatten, after detaching it): its filled box and its layers in
  // one vector, its layout dropped, one undo step.
  NodeChange fr = make({1, 9}, NodeType::FRAME, kPage, "~", {600, 400, 100, 60}, "Frame 9");
  fr.props.fillPaints = {Paint::solid(Color::hex(0x00FF00))};
  NodeChange kid = make({1, 10}, NodeType::ROUNDED_RECTANGLE, {1, 9}, "!", {20, 20, 40, 60}, "Kid");
  e.applyChanges({fr, kid}, APPLY_LOAD);
  e.setSelection({{1, 9}});
  CHECK((e.commandState(CommandId::FLATTEN) & CMD_ENABLED) != 0);
  REQUIRE(e.command(CommandId::FLATTEN) == OK);
  CHECK(props(e, {1, 9}).type == NodeType::VECTOR);
  CHECK(e.document().children({1, 9}).empty());
  CHECK(props(e, {1, 9}).fillPaints[0].color == Color::hex(0x00FF00));
  CHECK(props(e, {1, 9}).size == Vec2{100, 80});  // the box and the layer below it
  e.command(CommandId::UNDO);
  CHECK(props(e, {1, 9}).type == NodeType::FRAME);
  CHECK(e.document().children({1, 9}).size() == 1);
  // Outline stroke: a stroked line becomes a filled vector.
  e.setTool(Tool::LINE);
  drag(e, {100, 500}, {300, 500});
  Guid line = e.selection()[0];
  REQUIRE(e.command(CommandId::OUTLINE_STROKE) == OK);
  CHECK(props(e, line).type == NodeType::VECTOR);
  CHECK(props(e, line).strokePaints.empty());
  REQUIRE(props(e, line).fillPaints.size() == 1);
  CHECK(props(e, line).size.y == doctest::Approx(1).epsilon(0.01));
  // Use as mask: one layer; then toggled off.
  e.setSelection({S});
  REQUIRE(e.command(CommandId::USE_AS_MASK) == OK);
  CHECK(props(e, S).mask);
  CHECK((e.commandState(CommandId::USE_AS_MASK) & CMD_CHECKED) != 0);
  e.command(CommandId::USE_AS_MASK);
  CHECK_FALSE(props(e, S).mask);
  // Place image: a rectangle of the image's size with an image fill.
  CommandArgs a;
  a.hash = ImageHash::fromHex("93e8eeb27e934c4b9ae9e7929c7df9e96a6ec90c");
  a.width = 300;
  a.height = 150;
  a.name = "social";
  REQUIRE(e.command(CommandId::PLACE_IMAGES, a) == OK);
  const NodeProps& img = props(e, e.selection()[0]);
  CHECK(img.size == Vec2{300, 150});
  CHECK(img.name == "social");
  REQUIRE(img.fillPaints.size() == 1);
  CHECK(img.fillPaints[0].type == PaintType::IMAGE);
  CHECK(img.fillPaints[0].imageScaleMode == ImageScaleMode::FILL);
}

TEST_CASE("gradient handles: drag the end, add and delete a stop, one undo step each") {
  Editor e = makeEditor();
  Paint g;
  g.type = PaintType::GRADIENT_LINEAR;
  g.stops = {{Color::hex(0xFF0000), 0}, {Color::hex(0x0000FF), 1}};
  NodeChange c = NodeChange::changed(R);
  c.mask = F_FILLS;
  c.props.fillPaints = {g};
  e.applyChanges({c}, APPLY_LOAD);
  REQUIRE(e.startPaintEdit(R, false, 0) == OK);
  CHECK(e.paintEditing());
  CHECK(e.selection() == std::vector<Guid>{R});
  // Linear handles: (0, .5) and (1, .5) of the 100 × 100 box at (100, 100) → (100, 150) and (200, 150).
  drag(e, {200, 150}, {150, 200});
  const Paint& p = props(e, R).fillPaints[0];
  // The end is now at the box's (0.5, 1): the transform maps it to gradient (1, 0.5).
  Vec2 end = p.transform.apply({0.5, 1});
  CHECK(end.x == doctest::Approx(1).epsilon(1e-6));
  CHECK(end.y == doctest::Approx(0.5).epsilon(1e-6));
  CHECK(e.undoStack().undoLabel() == "Edit gradient");
  // A click on the line adds a stop there.
  click(e, 125, 175);
  CHECK(props(e, R).fillPaints[0].stops.size() == 3);
  CHECK(e.paintStop() == 1);
  e.key(KeyEvent::DOWN, KeyCode::Backspace, 0, 0, false);
  CHECK(props(e, R).fillPaints[0].stops.size() == 2);
  // Esc closes it; selecting something else does too.
  e.key(KeyEvent::DOWN, KeyCode::Escape, 0, 0, false);
  CHECK_FALSE(e.paintEditing());
  e.command(CommandId::UNDO);
  e.command(CommandId::UNDO);
  CHECK(props(e, R).fillPaints[0].stops.size() == 2);
  CHECK(props(e, R).fillPaints[0].transform.apply({1, 0.5}).x == doctest::Approx(1));
}
