// Moving on world transforms (docs/engine.md §8.4–§8.5): reparenting on drop,
// ⌥-drag duplicate, groups following live, auto-layout reorder with the
// insertion indicator, snapping and smart guides, ⌥ measurement, auto-layout
// bands, and the resize → Fixed sizing rule.
#include <cmath>

#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"
#include "base/FractionalIndex.h"
#include "base/Json.h"
#include "scene/CodecJson.h"

using namespace eng;
using namespace eng::test;

namespace {

// Page: frame F (0,0 300×300) holding A; B on the page at 400,0; frame G at 0,400 (300×200).
const Guid F{1, 1}, A{1, 2}, B{1, 3}, G{1, 4};

std::vector<NodeChange> baseScene() {
  auto nodes = baseChanges();
  nodes.push_back(make(F, NodeType::FRAME, kPage, "!", {0, 0, 300, 300}, "Frame 1"));
  nodes.push_back(make(A, NodeType::ROUNDED_RECTANGLE, F, "!", {20, 20, 50, 50}, "A"));
  nodes.push_back(make(B, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {400, 0, 50, 50}, "B"));
  nodes.push_back(make(G, NodeType::FRAME, kPage, "#", {0, 400, 300, 200}, "Frame 2"));
  return nodes;
}

Editor load(std::vector<NodeChange> nodes) {
  Editor e;
  e.setSessionID(1);
  e.setViewport(1000, 800, 1, 1000, 800);
  e.loadDocument(nodes, kNoGuid);
  e.takeEvents();
  return e;
}

void down(Editor& e, double x, double y, uint32_t mods = 0) { e.pointer(PointerEvent::DOWN, x, y, 0, 1, mods); }
void move(Editor& e, double x, double y, uint32_t mods = 0) { e.pointer(PointerEvent::MOVE, x, y, 0, 1, mods); }
void up(Editor& e, double x, double y, uint32_t mods = 0) { e.pointer(PointerEvent::UP, x, y, 0, 0, mods); }
void steps(Editor& e, Vec2 from, Vec2 to, uint32_t mods = 0, int n = 8) {
  for (int i = 1; i <= n; i++) {
    double t = i / static_cast<double>(n);
    move(e, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, mods);
  }
}
void drag(Editor& e, Vec2 from, Vec2 to, uint32_t mods = 0) {
  down(e, from.x, from.y, mods);
  steps(e, from, to, mods);
  up(e, to.x, to.y, mods);
}

const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }
Rect world(const Editor& e, Guid id) { return e.document().worldBounds(id); }

}  // namespace

TEST_CASE("move: dropping on a frame reparents, keeping the place on the page; out again restores the parent") {
  Editor e = load(baseScene());
  e.setSelection({B});
  drag(e, {425, 25}, {125, 455});  // B over Frame 2
  CHECK(e.document().parentOf(B) == G);
  CHECK(world(e, B) == Rect{100, 430, 50, 50});
  CHECK(props(e, B).transform == Mat2x3::translate(100, 30));
  auto ev = e.takeEvents();
  REQUIRE(ev.documents.size() == 1);
  CHECK(ev.documents[0].label == "Move");
  e.command(CommandId::UNDO);
  CHECK(e.document().parentOf(B) == kPage);
  CHECK(props(e, B).transform == Mat2x3::translate(400, 0));

  // Into a frame and back out within one drag: where it started, same key.
  std::string key = props(e, A).parentIndex.position;
  down(e, 45, 45);
  steps(e, {45, 45}, {600, 45});
  CHECK(e.document().parentOf(A) == kPage);  // live
  steps(e, {600, 45}, {60, 60});
  up(e, 60, 60);
  CHECK(e.document().parentOf(A) == F);
  CHECK(props(e, A).parentIndex.position == key);
  CHECK(world(e, A) == Rect{35, 35, 50, 50});
}

TEST_CASE("move: Space held keeps the parent (Figma: no nesting); the layer itself is never a drop target") {
  Editor e = load(baseScene());
  e.setSelection({A});
  down(e, 45, 45);
  steps(e, {45, 45}, {300, 45});
  e.key(KeyEvent::DOWN, KeyCode::Space, 0, 0, false);
  steps(e, {300, 45}, {645, 45});
  up(e, 645, 45);
  e.key(KeyEvent::UP, KeyCode::Space, 0, 0, false);
  CHECK(e.document().parentOf(A) == F);
  CHECK(world(e, A).x == 620);
  // A frame dragged over itself stays on the page.
  e.setSelection({G});
  drag(e, {150, 590}, {160, 600});
  CHECK(e.document().parentOf(G) == kPage);
}

TEST_CASE("move: ⌥-drag duplicates (one undo step); letting go of ⌥ mid-drag drops the copy") {
  Editor e = load(baseScene());
  e.setSelection({B});
  drag(e, {425, 25}, {625, 25}, MOD_ALT);
  REQUIRE(e.selection().size() == 1);
  Guid copy = e.selection()[0];
  CHECK(copy != B);
  CHECK(props(e, copy).name == "B");
  CHECK(world(e, copy).x == 600);
  CHECK(world(e, B).x == 400);
  auto ev = e.takeEvents();
  REQUIRE(ev.documents.size() == 1);
  REQUIRE(ev.documents[0].changes.size() == 1);
  CHECK(ev.documents[0].changes[0].phase == Phase::CREATED);
  e.command(CommandId::UNDO);
  CHECK(!e.document().has(copy));
  CHECK(e.selection() == std::vector<Guid>{B});

  // ⌥ at the start, let go halfway: the original moves, no copy is left.
  size_t before = e.document().size();
  down(e, 425, 25, MOD_ALT);
  steps(e, {425, 25}, {500, 25}, MOD_ALT);
  CHECK(e.document().size() == before + 1);
  CHECK(e.cursor() == CursorKind::MOVE_DUPLICATE);
  steps(e, {500, 25}, {525, 25}, 0);
  up(e, 525, 25);
  CHECK(e.document().size() == before);
  CHECK(world(e, B).x == 500);
  CHECK(e.selection() == std::vector<Guid>{B});

  // Esc mid-duplicate: nothing happened.
  down(e, 525, 25, MOD_ALT);
  steps(e, {525, 25}, {700, 25}, MOD_ALT);
  e.key(KeyEvent::DOWN, KeyCode::Escape, 0, MOD_ALT, false);
  CHECK(e.document().size() == before);
  CHECK(world(e, B).x == 500);
}

TEST_CASE("move: a group follows its layer while it moves") {
  auto nodes = baseChanges();
  const Guid Grp{1, 10}, L{1, 11}, R{1, 12};
  NodeChange g = make(Grp, NodeType::FRAME, kPage, "!", {100, 100, 150, 50}, "Group 1");
  g.props.resizeToFit = true;
  g.props.fillPaints.clear();
  nodes.push_back(g);
  nodes.push_back(make(L, NodeType::ROUNDED_RECTANGLE, Grp, "!", {0, 0, 50, 50}));
  nodes.push_back(make(R, NodeType::ROUNDED_RECTANGLE, Grp, "\"", {100, 0, 50, 50}));
  Editor e = load(nodes);
  e.setSelection({R});
  down(e, 225, 125);
  steps(e, {225, 125}, {325, 225});
  // Mid-drag: the group's box already holds R at its new place, L hasn't moved.
  CHECK(world(e, Grp) == Rect{100, 100, 250, 150});
  CHECK(world(e, L) == Rect{100, 100, 50, 50});
  CHECK(world(e, R) == Rect{300, 200, 50, 50});
  up(e, 325, 225);
  CHECK(e.document().parentOf(R) == Grp);  // a group's layer stays in its group
  CHECK(world(e, R) == Rect{300, 200, 50, 50});
  e.command(CommandId::UNDO);
  CHECK(world(e, Grp) == Rect{100, 100, 150, 50});
}

TEST_CASE("move: auto layout — reorder by drag with the insertion indicator; drag out of the flow") {
  auto nodes = baseChanges();
  const Guid AL{1, 20};
  NodeChange f = make(AL, NodeType::FRAME, kPage, "!", {0, 0, 0, 0}, "Auto");
  f.props.stack().stackMode = StackMode::HORIZONTAL;
  f.props.stack().stackPaddingLeft = f.props.stack().stackPaddingTop = f.props.stack().stackPaddingRight = f.props.stack().stackPaddingBottom = 10;
  f.props.stack().stackCounterSizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  nodes.push_back(f);
  Guid kids[3] = {{1, 21}, {1, 22}, {1, 23}};
  std::string key;
  for (int i = 0; i < 3; i++) {
    key = fractional::keyBetween(key, std::nullopt, fractional::Bias::Low);
    nodes.push_back(make(kids[i], NodeType::ROUNDED_RECTANGLE, AL, key, {10 + 60.0 * i, 10, 50, 50}));
  }
  Editor e = load(nodes);
  // Lay it out once (as a panel edit would).
  NodeChange touch;
  touch.mask = F_STACK_SPACING;
  touch.props.stack().stackSpacing = 10;
  e.setProps({AL}, touch, 0);
  REQUIRE(world(e, AL) == Rect{0, 0, 190, 70});

  e.setSelection({kids[0]});
  down(e, 35, 35);
  steps(e, {35, 35}, {165, 35});
  // Round 15 (live Figma): inside its own frame it is reordered as it goes — the others slide over to make room, the
  // frame keeps its size, no insertion line (the open slot shows where it lands).
  CHECK(e.document().children(AL) == std::vector<Guid>{kids[1], kids[2], kids[0]});
  e.tick(1000);
  e.tick(1500);
  CHECK(world(e, kids[1]).x == 10);
  CHECK(world(e, kids[2]).x == 70);
  CHECK(world(e, AL).w == 190);
  Overlay o = e.overlay();
  CHECK(!o.hasInsertion);
  CHECK(o.lifted == std::vector<Guid>{kids[0]});
  CHECK(o.guides.empty());
  up(e, 165, 35);
  CHECK(e.document().children(AL) == std::vector<Guid>{kids[1], kids[2], kids[0]});
  CHECK(world(e, kids[0]).x == 130);
  CHECK(world(e, AL).w == 190);
  CHECK(!e.overlay().hasInsertion);

  // Between the two others.
  e.setSelection({kids[0]});
  down(e, 155, 35);
  steps(e, {155, 35}, {65, 35});
  up(e, 65, 35);
  CHECK(e.document().children(AL) == std::vector<Guid>{kids[1], kids[0], kids[2]});

  // Out onto the page: the frame hugs what is left.
  e.setSelection({kids[2]});
  down(e, 155, 35);
  steps(e, {155, 35}, {455, 335});
  up(e, 455, 335);
  CHECK(e.document().parentOf(kids[2]) == kPage);
  CHECK(world(e, kids[2]) == Rect{430, 310, 50, 50});
  CHECK(world(e, AL).w == 130);
}

TEST_CASE("move: snaps to a sibling's edges and centre with guides; ⌃ turns it off") {
  Editor e = load(baseScene());
  e.setSelection({B});
  // B (400–450) dragged left by 77: its left edge at 323 snaps to G's/F's right edge 300? Too far; to 300 + 0…
  // Put it 4 px short of lining up its top with G's top (400).
  down(e, 425, 25);
  steps(e, {425, 25}, {425 + 104, 25 + 396});  // top 396 → snaps to 400
  CHECK(world(e, B).y == 400);
  Overlay o = e.overlay();
  CHECK(!o.guides.empty());
  bool horizontal = false;
  for (auto& g : o.guides) horizontal |= g.a.y == 400 && g.b.y == 400;
  CHECK(horizontal);
  up(e, 529, 421);
  CHECK(e.overlay().guides.empty());
  e.command(CommandId::UNDO);
  // ⌃ held while dragging (⌃-click itself is the context menu): no snapping, whole pixels.
  down(e, 425, 25);
  steps(e, {425, 25}, {529, 421}, MOD_CTRL);
  up(e, 529, 421, MOD_CTRL);
  CHECK(world(e, B).y == 396);
}

TEST_CASE("move: equal spacing between two layers") {
  auto nodes = baseChanges();
  const Guid L{1, 30}, R{1, 31}, M{1, 32};
  nodes.push_back(make(L, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 50, 50}));
  nodes.push_back(make(R, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {200, 0, 50, 50}));
  nodes.push_back(make(M, NodeType::ROUNDED_RECTANGLE, kPage, "#", {0, 300, 50, 50}));
  Editor e = load(nodes);
  e.setSelection({M});
  // M to x 98 (centre would be 100), y 3 (top 0 snaps).
  drag(e, {25, 325}, {123, 28});
  CHECK(world(e, M) == Rect{100, 0, 50, 50});
  // The marks: 50→100 and 150→200 (at the end of the gesture they are cleared; check mid-drag).
  e.command(CommandId::UNDO);
  down(e, 25, 325);
  steps(e, {25, 325}, {123, 28});
  Overlay o = e.overlay();
  CHECK(o.spacings.size() == 2);
  up(e, 123, 28);
}

TEST_CASE("resize snaps the dragged edge; drawing snaps both corners") {
  Editor e = load(baseScene());
  e.setSelection({B});
  // B's right edge (450) dragged to 497 → no snap (nothing near); then near G? use page siblings: F right edge 300.
  // Drag B's left edge (400) to 303: snaps to F's and G's right edge, 300.
  down(e, 400, 25);
  steps(e, {400, 25}, {303, 25});
  CHECK(world(e, B).x == 300);
  CHECK(!e.overlay().guides.empty());
  up(e, 303, 25);
  CHECK(world(e, B) == Rect{300, 0, 150, 50});

  // Draw a rectangle on the page from (503, 403) to (548, 448): its corner snaps to B's right/bottom? B is 300–450.
  e.setTool(Tool::RECTANGLE);
  down(e, 454, 3);
  steps(e, {454, 3}, {600, 47});
  up(e, 600, 47);
  Guid drawn = e.selection()[0];
  CHECK(world(e, drawn) == Rect{450, 0, 150, 50});
}

TEST_CASE("resize: an auto-layout child's Fill becomes Fixed, a Hug frame becomes Fixed") {
  auto nodes = baseChanges();
  const Guid AL{1, 40}, C{1, 41};
  NodeChange f = make(AL, NodeType::FRAME, kPage, "!", {0, 0, 300, 100}, "Auto");
  f.props.stack().stackMode = StackMode::HORIZONTAL;
  f.props.stack().stackPrimarySizing = StackSize::FIXED;
  nodes.push_back(f);
  NodeChange c = make(C, NodeType::ROUNDED_RECTANGLE, AL, "!", {0, 0, 300, 100});
  c.props.stackChildPrimaryGrow = 1;
  c.props.stackChildAlignSelf = StackCounterAlign::STRETCH;
  nodes.push_back(c);
  Editor e = load(nodes);
  e.setSelection({C});
  // The right edge, inwards by 100.
  drag(e, {300, 50}, {200, 50});
  CHECK(props(e, C).stackChildPrimaryGrow == 0);
  CHECK(props(e, C).stackChildAlignSelf == StackCounterAlign::STRETCH);  // only the width changed
  CHECK(props(e, C).size.x == 200);

  // A hugging auto-layout frame resized by hand: Fixed on that axis.
  e.setSelection({AL});
  NodeChange hug;
  hug.mask = F_STACK_PRIMARY_SIZING;
  hug.props.stack().stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  e.setProps({AL}, hug, 0);
  CHECK(world(e, AL).w == 200);
  drag(e, {200, 50}, {260, 50});
  CHECK(props(e, AL).stack().stackPrimarySizing == StackSize::FIXED);
  CHECK(world(e, AL).w == 260);
}

TEST_CASE("⌥ measurement to the hovered layer, or to the parent frame") {
  Editor e = load(baseScene());
  e.setSelection({A});
  move(e, 425, 25);
  e.modifiers(MOD_ALT);
  Overlay o = e.overlay();
  CHECK(o.measureTarget == B);
  REQUIRE(!o.measures.empty());
  // A ends at 70, B starts at 400.
  CHECK(o.measures[0].a.x == 70);
  CHECK(o.measures[0].b.x == 400);
  CHECK(o.hover.empty());
  // Over the selection itself: the distances to its frame's edges.
  move(e, 45, 45, MOD_ALT);
  o = e.overlay();
  CHECK(o.measureTarget == F);
  CHECK(o.measures.size() == 4);
  e.modifiers(0);
  CHECK(e.overlay().measureTarget == kNoGuid);
}

TEST_CASE("auto layout: padding and gap bands under the pointer") {
  auto nodes = baseChanges();
  const Guid AL{1, 50}, X{1, 51}, Y{1, 52};
  NodeChange f = make(AL, NodeType::FRAME, kPage, "!", {0, 0, 150, 70}, "Auto");
  f.props.stack().stackMode = StackMode::HORIZONTAL;
  f.props.stack().stackSpacing = 30;
  f.props.stack().stackPaddingLeft = f.props.stack().stackPaddingTop = f.props.stack().stackPaddingRight = f.props.stack().stackPaddingBottom = 10;
  nodes.push_back(f);
  nodes.push_back(make(X, NodeType::ROUNDED_RECTANGLE, AL, "!", {10, 10, 50, 50}));
  nodes.push_back(make(Y, NodeType::ROUNDED_RECTANGLE, AL, "\"", {90, 10, 50, 50}));
  Editor e = load(nodes);
  e.setSelection({AL});
  move(e, 75, 35);  // the gap
  REQUIRE(e.overlay().bands.size() == 1);
  CHECK(e.overlay().bands[0] == Rect{60, 10, 30, 50});
  move(e, 5, 35);  // the left padding
  REQUIRE(e.overlay().bands.size() == 1);
  CHECK(e.overlay().bands[0] == Rect{0, 0, 10, 70});
  move(e, 35, 35);  // on a child
  CHECK(e.overlay().bands.empty());
}

TEST_CASE("arrows reorder auto-layout children along the flow") {
  auto nodes = baseChanges();
  const Guid AL{1, 60};
  NodeChange f = make(AL, NodeType::FRAME, kPage, "!", {0, 0, 200, 70}, "Auto");
  f.props.stack().stackMode = StackMode::HORIZONTAL;
  nodes.push_back(f);
  Guid k[3] = {{1, 61}, {1, 62}, {1, 63}};
  nodes.push_back(make(k[0], NodeType::ROUNDED_RECTANGLE, AL, "!", {0, 0, 50, 50}));
  nodes.push_back(make(k[1], NodeType::ROUNDED_RECTANGLE, AL, "\"", {50, 0, 50, 50}));
  nodes.push_back(make(k[2], NodeType::ROUNDED_RECTANGLE, AL, "#", {100, 0, 50, 50}));
  Editor e = load(nodes);
  e.setSelection({k[0]});
  e.key(KeyEvent::DOWN, KeyCode::ArrowRight, 0, 0, false);
  CHECK(e.document().children(AL) == std::vector<Guid>{k[1], k[0], k[2]});
  CHECK(world(e, k[0]).x == 50);
  e.key(KeyEvent::DOWN, KeyCode::ArrowDown, 0, 0, false);  // across the flow: nothing
  CHECK(world(e, k[0]) == Rect{50, 0, 50, 50});
  e.key(KeyEvent::DOWN, KeyCode::ArrowRight, 0, 0, false);
  e.key(KeyEvent::DOWN, KeyCode::ArrowRight, 0, 0, false);  // already last
  CHECK(e.document().children(AL) == std::vector<Guid>{k[1], k[2], k[0]});
  e.key(KeyEvent::DOWN, KeyCode::ArrowLeft, 0, 0, false);
  CHECK(e.document().children(AL) == std::vector<Guid>{k[1], k[0], k[2]});
}

TEST_CASE("right-click selects the layer under the pointer and reports every layer there") {
  auto nodes = baseScene();
  const Guid Over{1, 70};
  nodes.push_back(make(Over, NodeType::ROUNDED_RECTANGLE, kPage, "$", {30, 30, 100, 100}, "Over"));  // over A, on the page
  Editor e = load(nodes);
  CHECK((e.pointer(PointerEvent::DOWN, 45, 45, 2, 2, 0) & P_HANDLED) != 0);  // captured: a drag would pan (round 9)
  e.pointer(PointerEvent::UP, 45, 45, 2, 0, 0);
  CHECK(e.selection() == std::vector<Guid>{Over});
  auto ev = e.takeEvents();
  REQUIRE(ev.contextMenus.size() == 1);
  const auto& m = ev.contextMenus[0];
  CHECK(m.selection);
  CHECK(m.x == 45);
  // Topmost first, each innermost first: Over; A in Frame 1. (Frame 1 alone isn't repeated.)
  REQUIRE(m.hits.size() == 2);
  CHECK(m.hits[0] == std::vector<Guid>{Over});
  CHECK(m.hits[1] == std::vector<Guid>{A, F});
  // On a layer that is part of the selection: the selection stays.
  e.setSelection({Over, B});
  e.pointer(PointerEvent::DOWN, 100, 100, 2, 2, 0);
  e.pointer(PointerEvent::UP, 100, 100, 2, 0, 0);  // the menu opens on the release (Right-click and drag to pan)
  CHECK(e.selection() == std::vector<Guid>{Over, B});
  // ⌃-click (⌃ not the command key) is a right-click; empty canvas keeps the selection.
  e.pointer(PointerEvent::DOWN, 900, 700, 0, 1, MOD_CTRL);
  e.pointer(PointerEvent::UP, 900, 700, 0, 0, MOD_CTRL);
  CHECK(e.selection() == std::vector<Guid>{Over, B});
  ev = e.takeEvents();
  REQUIRE(ev.contextMenus.size() == 2);
  CHECK(ev.contextMenus[1].hits.empty());
  CHECK(e.document().get(B)->props.transform == Mat2x3::translate(400, 0));  // nothing moved
}

TEST_CASE("select inverse: the selection's siblings instead of it") {
  Editor e = load(baseScene());
  e.setSelection({B});
  e.command(CommandId::SELECT_INVERSE);
  CHECK(e.selection() == std::vector<Guid>{F, G});
  e.setSelection({});
  e.command(CommandId::SELECT_INVERSE);
  CHECK(e.selection() == std::vector<Guid>{F, B, G});
  e.setSelection({A});
  e.command(CommandId::SELECT_INVERSE);
  CHECK(e.selection().empty());  // A is Frame 1's only child
  CHECK(e.commandState(CommandId::SELECT_INVERSE) == CMD_ENABLED);
}

namespace {

// A 2 × 2 grid of 50 px fixed tracks (100 × 100 at the origin), its items 40 × 40, from the JSON wire.
NodeChange fromJson(const std::string& text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  NodeChange c;
  REQUIRE(codec::readChange(v, c));
  c.phase = Phase::CREATED;
  c.mask = F_ALL;
  return c;
}

std::vector<NodeChange> gridScene(bool reflow) {
  auto nodes = baseChanges();
  auto track = [](int id, const char* pos) { return R"({"id":{"sessionID":9,"localID":)" + std::to_string(id) + R"(},"position":")" + pos + R"("})"; };
  auto fixed = [](int id) {
    return R"({"id":{"sessionID":9,"localID":)" + std::to_string(id) + R"(},"trackSize":{"minSizing":{"type":"FIXED","value":50},"maxSizing":{"type":"FIXED","value":50}}})";
  };
  nodes.push_back(fromJson(R"({"guid":"1:30","type":"FRAME","name":"Grid","parentIndex":{"guid":"0:1","position":"!"},"size":{"x":100,"y":100},)"
                           R"("stackMode":"GRID","stackPrimarySizing":"FIXED","stackCounterSizing":"FIXED","gridReflowEnabled":)" +
                           std::string(reflow ? "true" : "false") + R"(,"gridColumns":{"entries":[)" + track(1, "!") + "," + track(2, "#") +
                           R"(]},"gridColumnsSizing":{"entries":[)" + fixed(1) + "," + fixed(2) + R"(]},"gridRows":{"entries":[)" + track(11, "!") +
                           "," + track(12, "#") + R"(]},"gridRowsSizing":{"entries":[)" + fixed(11) + "," + fixed(12) + "]}}"));
  const char* anchors[3][2] = {{"1", "11"}, {"2", "11"}, {"1", "12"}};
  const char* keys[3] = {"!", "#", "$"};
  for (int i = 0; i < 3; i++) {
    std::string a = reflow ? "" : std::string(R"(,"gridColumnAnchor":{"sessionID":9,"localID":)") + anchors[i][0] + R"(},"gridRowAnchor":{"sessionID":9,"localID":)" + anchors[i][1] + "}";
    nodes.push_back(fromJson(R"({"guid":"1:)" + std::to_string(31 + i) + R"(","type":"ROUNDED_RECTANGLE","parentIndex":{"guid":"1:30","position":")" + keys[i] +
                             R"("},"size":{"x":40,"y":40})" + a + "}"));
  }
  return nodes;
}

}  // namespace

TEST_CASE("move: grid — a drag places the item in the cell under the pointer") {
  const Guid GRID{1, 30}, I0{1, 31}, I1{1, 32}, I2{1, 33};
  {
    // Automatic placement: the item joins the flow at the cell — dropped on the empty last cell, it goes last.
    Editor e = load(gridScene(true));
    NodeChange touch;
    touch.mask = F_STACK_SPACING;
    e.setProps({GRID}, touch, 0);
    REQUIRE(world(e, I2).y == 50);
    e.setSelection({I0});
    down(e, 20, 20);
    steps(e, {20, 20}, {75, 75});
    Overlay o = e.overlay();
    REQUIRE(o.hasInsertion);
    CHECK(o.insertion.a.x == 50);
    CHECK(o.insertion.a.y == 50);
    up(e, 75, 75);
    CHECK(e.document().children(GRID) == std::vector<Guid>{I1, I2, I0});
    CHECK(world(e, I1).x == 0);
    CHECK(world(e, I2).x == 50);  // automatic placement leaves no gap: I0 takes the third cell
    CHECK(world(e, I0).x == 0);
    CHECK(world(e, I0).y == 50);
  }
  {
    // Placed by hand: the item takes the empty cell; dropped on a taken one, the two swap.
    Editor e = load(gridScene(false));
    NodeChange touch;
    touch.mask = F_STACK_SPACING;
    e.setProps({GRID}, touch, 0);
    e.setSelection({I0});
    drag(e, {20, 20}, {75, 75});
    CHECK(world(e, I0).x == 50);
    CHECK(world(e, I0).y == 50);
    CHECK(world(e, I1).x == 50);  // untouched
    e.setSelection({I0});
    drag(e, {75, 75}, {75, 25});
    CHECK(world(e, I0).y == 0);
    CHECK(world(e, I1).x == 50);
    CHECK(world(e, I1).y == 50);  // took I0's cell
    // The selected grid outlines its cells; the column under the pointer shows its compact pill above the frame, and
    // expanded (with its size) under the pointer.
    e.setSelection({GRID});
    move(e, 75, 10);
    Overlay o = e.overlay();
    CHECK(o.gridCells.size() == 4);
    REQUIRE(o.gridPills.size() == 2);  // column 2 and row 1 (inside the frame: both)
    CHECK(o.gridPills[0].column);
    CHECK(!o.gridPills[0].expanded);
    CHECK(o.gridPills[0].rect.x + o.gridPills[0].rect.w / 2 == doctest::Approx(75));
    CHECK(!o.gridPills[1].column);
    move(e, 75, -31.5);
    o = e.overlay();
    REQUIRE(o.gridPills.size() == 1);
    CHECK(o.gridPills[0].expanded);
    CHECK(o.gridPills[0].label == "50");
    CHECK(o.gridPills[0].hovered == 1);
    REQUIRE(o.gridTrackBoxes.size() == 1);
    CHECK(o.gridTrackBoxes[0].a.x == 50);
  }
}
