// Round 10 — the Figma menu's commands live Figma has enabled (docs/engine-build.md "Round 10 — Menus, commands, left
// side and toolbar"; live menus/main-object.txt, main-arrange.txt, main-vector.txt, context-frame.txt): Convert to
// section / frame, Distribute edges, Pack, Round to pixel, Join / Smooth join, Split / Simplify / Offset vector, the
// frame title's context menu, View › Frame outlines / Mask outlines.
#include <cmath>

#include "doctest.h"
#include "editor/Editor.h"
#include "geometry/VectorNetwork.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid F{1, 1}, K{1, 2}, A{1, 3}, B{1, 4}, C{1, 5}, S{1, 6}, V{1, 7};

NodeChange vectorNode(Guid id, const std::string& pos, Rect r, const geom::VectorNetwork& net) {
  NodeChange c = make(id, NodeType::VECTOR, kPage, pos, r, "Vector");
  VectorData d;
  d.present = true;
  d.normalizedSize = {r.w, r.h};
  d.network = std::make_shared<std::vector<uint8_t>>(net.encode());
  c.props.shape().vectorData = d;
  c.props.fillPaints.clear();
  c.props.strokePaints = {Paint::solid(Color::hex(0x000000))};
  c.props.strokeWeight = 1;
  return c;
}

// A frame F (with K in it), three rectangles A, B, C in a row, a section S, a vector V.
Editor makeEditor(std::vector<NodeChange> extra = {}) {
  auto nodes = baseChanges();
  nodes.push_back(make(F, NodeType::FRAME, kPage, "!", {0, 0, 200, 200}, "Frame"));
  nodes.push_back(make(K, NodeType::ROUNDED_RECTANGLE, F, "!", {20, 20, 40, 40}, "Kid"));
  nodes.push_back(make(A, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {0, 400, 100, 50}, "A"));
  nodes.push_back(make(B, NodeType::ROUNDED_RECTANGLE, kPage, "#", {150, 400, 20, 50}, "B"));
  nodes.push_back(make(C, NodeType::ROUNDED_RECTANGLE, kPage, "$", {400, 400, 50, 50}, "C"));
  nodes.push_back(make(S, NodeType::SECTION, kPage, "%", {600, 0, 300, 300}, "Section"));
  for (auto& c : extra) nodes.push_back(c);
  Editor e;
  e.setSessionID(1);
  e.setViewport(1200, 900, 1, 1200, 900);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({100, 100, 1});
  e.takeEvents();
  return e;
}

const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }
CommandArgs args(const char* text) {
  CommandArgs a;
  json::parse(text, a.raw);
  return a;
}
bool enabled(const Editor& e, CommandId id) { return (e.commandState(id) & CMD_ENABLED) != 0; }

geom::VectorNetwork networkOf(const Editor& e, Guid id) {
  const NodeProps& p = props(e, id);
  geom::VectorNetwork n;
  REQUIRE(p.shape().vectorData.network);
  REQUIRE(geom::VectorNetwork::decode(p.shape().vectorData.network->data(), p.shape().vectorData.network->size(), n));
  return n;
}

}  // namespace

TEST_CASE("r10 Convert to section / frame: in place, same GUID and layers, one undo step") {
  Editor e = makeEditor();
  e.setSelection({A});
  CHECK_FALSE(enabled(e, CommandId::CONVERT_TO_SECTION));
  e.setSelection({F});
  REQUIRE(enabled(e, CommandId::CONVERT_TO_SECTION));
  CHECK_FALSE(enabled(e, CommandId::CONVERT_TO_FRAME));
  REQUIRE(e.command(CommandId::CONVERT_TO_SECTION) == OK);
  CHECK(props(e, F).type == NodeType::SECTION);
  CHECK(props(e, K).parentIndex.guid == F);
  CHECK(props(e, F).size == Vec2{200, 200});
  CHECK(props(e, F).name == "Frame");
  CHECK(e.selection() == std::vector<Guid>{F});
  REQUIRE(enabled(e, CommandId::CONVERT_TO_FRAME));
  e.command(CommandId::UNDO);
  CHECK(props(e, F).type == NodeType::FRAME);
  e.setSelection({S});
  REQUIRE(e.command(CommandId::CONVERT_TO_FRAME) == OK);
  CHECK(props(e, S).type == NodeType::FRAME);
  CHECK_FALSE(props(e, S).frameMaskDisabled);
}

TEST_CASE("r10 Distribute left / horizontal centers / right: the first and last stay, the edges evenly spaced") {
  Editor e = makeEditor();
  e.setSelection({A, B});
  CHECK_FALSE(enabled(e, CommandId::DISTRIBUTE_LEFT));
  e.setSelection({A, B, C});
  REQUIRE(e.command(CommandId::DISTRIBUTE_LEFT) == OK);
  CHECK(props(e, A).transform.m02 == 0);
  CHECK(props(e, B).transform.m02 == doctest::Approx(200));
  CHECK(props(e, C).transform.m02 == 400);
  REQUIRE(e.command(CommandId::DISTRIBUTE_RIGHT) == OK);
  // Rights 100 … 450: B's right at 275.
  CHECK(props(e, B).transform.m02 + 20 == doctest::Approx(275));
  REQUIRE(e.command(CommandId::DISTRIBUTE_HORIZONTAL_CENTERS) == OK);
  // Centres 50 … 425: B's centre at 237.5.
  CHECK(props(e, B).transform.m02 + 10 == doctest::Approx(237.5));
  REQUIRE(e.command(CommandId::DISTRIBUTE_TOP) == OK);
  CHECK(props(e, B).transform.m12 == doctest::Approx(400));
}

TEST_CASE("r10 Pack horizontal / vertical: side by side without space, the first staying") {
  Editor e = makeEditor();
  e.setSelection({C, A, B});
  REQUIRE(enabled(e, CommandId::PACK_HORIZONTAL));
  REQUIRE(e.command(CommandId::PACK_HORIZONTAL) == OK);
  CHECK(props(e, A).transform.m02 == 0);
  CHECK(props(e, B).transform.m02 == doctest::Approx(100));
  CHECK(props(e, C).transform.m02 == doctest::Approx(120));
  e.command(CommandId::UNDO);
  CHECK(props(e, C).transform.m02 == 400);
  REQUIRE(e.command(CommandId::PACK_VERTICAL) == OK);
  // All at y 400: stacked in their order (A, B, C), each under the last.
  CHECK(props(e, B).transform.m12 == doctest::Approx(450));
  CHECK(props(e, C).transform.m12 == doctest::Approx(500));
}

TEST_CASE("r10 Round to pixel: position and size on whole pixels") {
  auto odd = make(V, NodeType::ROUNDED_RECTANGLE, kPage, "&", {10.4, 20.6, 99.6, 40.2}, "Odd");
  Editor e = makeEditor({odd});
  e.setSelection({V});
  REQUIRE(enabled(e, CommandId::ROUND_TO_PIXEL));
  REQUIRE(e.command(CommandId::ROUND_TO_PIXEL) == OK);
  CHECK(props(e, V).transform.m02 == doctest::Approx(10));
  CHECK(props(e, V).transform.m12 == doctest::Approx(21));
  CHECK(props(e, V).size == Vec2{100, 40});
}

TEST_CASE("r10 Join / Smooth join: vector edit mode's selected ends joined; points on each other merged") {
  geom::VectorNetwork net;
  net.vertices = {{{0, 0}, 0}, {{50, 50}, 0}, {{100, 0}, 0}};
  net.segments = {geom::VNSegment{0, 1, {}, {}, 0}, geom::VNSegment{1, 2, {}, {}, 0}};
  Editor e = makeEditor({vectorNode(V, "&", {100, 600, 100, 50}, net)});
  e.setSelection({V});
  CHECK_FALSE(enabled(e, CommandId::VECTOR_JOIN));
  REQUIRE(e.startVectorEdit(V) == OK);
  // The two ends (screen: camera 100,100 + node 100,600).
  e.pointer(PointerEvent::DOWN, 200, 700, 0, 1, 0, 1);
  e.pointer(PointerEvent::UP, 200, 700, 0, 0, 0, 1);
  e.pointer(PointerEvent::DOWN, 300, 700, 0, 1, MOD_SHIFT, 1);
  e.pointer(PointerEvent::UP, 300, 700, 0, 0, MOD_SHIFT, 1);
  REQUIRE(e.vectorSelectedVertices().size() == 2);
  REQUIRE(enabled(e, CommandId::VECTOR_JOIN));
  REQUIRE(e.command(CommandId::VECTOR_JOIN, args("{\"smooth\":true}")) == OK);
  geom::VectorNetwork n = networkOf(e, V);
  CHECK(n.segments.size() == 3);
  CHECK_FALSE(n.segments[2].isLine());
  e.command(CommandId::UNDO);
  CHECK(networkOf(e, V).segments.size() == 2);
}

TEST_CASE("r10 Split vector: a layer's separate parts become layers; in edit mode the path splits at a point") {
  geom::VectorNetwork net;
  net.vertices = {{{0, 0}, 0}, {{40, 0}, 0}, {{60, 40}, 0}, {{100, 40}, 0}};
  net.segments = {geom::VNSegment{0, 1, {}, {}, 0}, geom::VNSegment{2, 3, {}, {}, 0}};
  Editor e = makeEditor({vectorNode(V, "&", {100, 600, 100, 40}, net)});
  e.setSelection({V});
  REQUIRE(enabled(e, CommandId::VECTOR_SPLIT));
  REQUIRE(e.command(CommandId::VECTOR_SPLIT) == OK);
  REQUIRE(e.selection().size() == 2);
  CHECK(e.selection()[0] == V);
  CHECK(networkOf(e, V).segments.size() == 1);
  CHECK(networkOf(e, e.selection()[1]).segments.size() == 1);
  CHECK(props(e, e.selection()[1]).transform.m02 == doctest::Approx(160));
}

TEST_CASE("r10 Simplify vector: points along a line go; a curve keeps its ends") {
  geom::VectorNetwork net;
  for (int i = 0; i <= 4; i++) net.vertices.push_back({{i * 25.0, i % 2 ? 0.2 : 0.0}, 0});
  for (uint32_t i = 0; i < 4; i++) net.segments.push_back(geom::VNSegment{i, i + 1, {}, {}, 0});
  Editor e = makeEditor({vectorNode(V, "&", {100, 600, 100, 0.2}, net)});
  e.setSelection({V});
  REQUIRE(enabled(e, CommandId::VECTOR_SIMPLIFY));
  CommandArgs a = args("{\"amount\":0.5}");
  REQUIRE(e.command(CommandId::VECTOR_SIMPLIFY, a) == OK);
  geom::VectorNetwork n = networkOf(e, V);
  CHECK(n.vertices.size() == 2);
  CHECK(n.segments.size() == 1);
  // A rectangle has nothing to lose: no change.
  e.setSelection({A});
  CHECK(e.command(CommandId::VECTOR_SIMPLIFY, a) == E_INVALID);
}

TEST_CASE("r10 Offset vector: a rectangle grown by 10 on each side, shrunk by 10") {
  Editor e = makeEditor();
  e.setSelection({A});
  REQUIRE(enabled(e, CommandId::VECTOR_OFFSET));
  REQUIRE(e.command(CommandId::VECTOR_OFFSET, args("{\"amount\":10,\"join\":\"MITER\"}")) == OK);
  CHECK(props(e, A).type == NodeType::VECTOR);
  CHECK(props(e, A).size.x == doctest::Approx(120).epsilon(0.01));
  CHECK(props(e, A).size.y == doctest::Approx(70).epsilon(0.01));
  CHECK(props(e, A).transform.m02 == doctest::Approx(-10).epsilon(0.01));
  e.command(CommandId::UNDO);
  REQUIRE(e.command(CommandId::VECTOR_OFFSET, args("{\"amount\":-10}")) == OK);
  CHECK(props(e, A).size.x == doctest::Approx(80).epsilon(0.01));
  CHECK(props(e, A).size.y == doctest::Approx(30).epsilon(0.01));
}

TEST_CASE("r10 a right-click on a frame's title opens the frame's menu") {
  Editor e = makeEditor();
  auto titles = e.titles();
  const FrameTitle* t = nullptr;
  for (auto& x : titles)
    if (x.id == F) t = &x;
  REQUIRE(t);
  Vec2 at{t->hit.x + 4, t->hit.y + t->hit.h / 2};
  e.pointer(PointerEvent::DOWN, at.x, at.y, 2, 2, 0, 1);
  e.pointer(PointerEvent::UP, at.x, at.y, 2, 0, 0, 1);
  auto ev = e.takeEvents();
  REQUIRE(ev.contextMenus.size() == 1);
  CHECK(ev.contextMenus[0].selection);
  CHECK(e.selection() == std::vector<Guid>{F});
}

TEST_CASE("r10 View › Frame outlines / Mask outlines draw thin boxes") {
  Editor e = makeEditor();
  size_t before = e.overlay().curves.size();
  e.setViewOptions(e.viewOptions() | Editor::VIEW_FRAME_OUTLINES);
  CHECK(e.overlay().curves.size() == before + 4);
  e.setViewOptions(e.viewOptions() & ~Editor::VIEW_FRAME_OUTLINES);
  CHECK(e.overlay().curves.size() == before);
}

TEST_CASE("r10 Set default properties: a new rectangle starts with the set look") {
  Editor e = makeEditor();
  e.setSelection({F});
  CHECK_FALSE(enabled(e, CommandId::SET_DEFAULT_PROPERTIES));
  e.setSelection({A});
  NodeChange look;
  look.mask = F_FILLS | F_OPACITY;
  look.props.fillPaints = {Paint::solid(Color::hex(0xFF0000))};
  look.props.opacity = 0.5;
  REQUIRE(e.setProps({A}, look, 0) == OK);
  REQUIRE(e.command(CommandId::SET_DEFAULT_PROPERTIES) == OK);
  REQUIRE(e.setTool(Tool::RECTANGLE) == OK);
  e.pointer(PointerEvent::DOWN, 700, 800, 0, 1, 0, 1);
  e.pointer(PointerEvent::MOVE, 750, 850, 0, 1, 0);
  e.pointer(PointerEvent::UP, 750, 850, 0, 0, 0, 1);
  REQUIRE(e.selection().size() == 1);
  const NodeProps& made = props(e, e.selection()[0]);
  CHECK(made.opacity == doctest::Approx(0.5));
  REQUIRE(made.fillPaints.size() == 1);
  CHECK(made.fillPaints[0].color == Color::hex(0xFF0000));
}
