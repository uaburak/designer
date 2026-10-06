#include <cmath>

#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid F{1, 1}, R1{1, 2}, R2{1, 3}, TOP{1, 4};

Editor makeEditor() {
  auto nodes = baseChanges();
  nodes.push_back(make(F, NodeType::FRAME, kPage, "!", {0, 0, 300, 300}, "Frame 3"));
  nodes.push_back(make(R1, NodeType::ROUNDED_RECTANGLE, F, "!", {10, 10, 50, 50}, "Rectangle 1"));
  nodes.push_back(make(R2, NodeType::ROUNDED_RECTANGLE, F, "\"", {100, 10, 50, 50}, "Rectangle 2"));
  nodes.push_back(make(TOP, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {400, 0, 100, 100}, "Rectangle 7"));
  Editor e;
  e.setViewport(800, 600, 2, 1600, 1200);
  e.loadDocument(nodes, kNoGuid);
  e.takeEvents();
  return e;
}

void down(Editor& e, double x, double y, uint32_t mods = 0, int button = 0) { e.pointer(PointerEvent::DOWN, x, y, button, 1, mods); }
void move(Editor& e, double x, double y, uint32_t mods = 0) { e.pointer(PointerEvent::MOVE, x, y, 0, 1, mods); }
void up(Editor& e, double x, double y, uint32_t mods = 0, int button = 0) { e.pointer(PointerEvent::UP, x, y, button, 0, mods); }
void click(Editor& e, double x, double y, uint32_t mods = 0) {
  down(e, x, y, mods);
  up(e, x, y, mods);
}
void drag(Editor& e, Vec2 from, Vec2 to, uint32_t mods = 0, int button = 0) {
  down(e, from.x, from.y, mods, button);
  for (int i = 1; i <= 4; i++) {
    double t = i / 4.0;
    move(e, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, mods);
  }
  up(e, to.x, to.y, mods, button);
}
uint32_t press(Editor& e, KeyCode k, uint32_t mods = 0, bool repeat = false) { return e.key(KeyEvent::DOWN, k, 0, mods, repeat); }

const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }

}  // namespace

TEST_CASE("editor: loads and finds its page (not the internal canvas)") {
  Editor e = makeEditor();
  CHECK(e.page() == kPage);
  CHECK(e.pages() == std::vector<Guid>{kPage});
  CHECK(e.selection().empty());
}

TEST_CASE("editor: click, shift-click, empty click, the frame's own background") {
  Editor e = makeEditor();
  uint32_t r = e.pointer(PointerEvent::DOWN, 20, 20, 0, 1, 0);
  CHECK((r & P_CAPTURE));
  up(e, 20, 20);
  CHECK(e.selection() == std::vector<Guid>{R1});
  CHECK(e.takeEvents().selection);
  click(e, 120, 20, MOD_SHIFT);
  CHECK(e.selection() == std::vector<Guid>{R1, R2});
  click(e, 120, 20, MOD_SHIFT);
  CHECK(e.selection() == std::vector<Guid>{R1});
  click(e, 700, 500);
  CHECK(e.selection().empty());
  click(e, 200, 200);
  CHECK(e.selection() == std::vector<Guid>{F});
}

TEST_CASE("editor: drag-move is one undo step; ⇧ locks the axis") {
  Editor e = makeEditor();
  drag(e, {20, 20}, {50, 60});
  CHECK(e.selection() == std::vector<Guid>{R1});
  CHECK(props(e, R1).transform.m02 == 40);
  CHECK(props(e, R1).transform.m12 == 50);
  CHECK(e.canUndo());
  e.command(CommandId::UNDO);
  CHECK(props(e, R1).transform == Mat2x3::translate(10, 10));
  CHECK_FALSE(e.canUndo());
  e.command(CommandId::REDO);
  CHECK(props(e, R1).transform.m02 == 40);
  e.command(CommandId::UNDO);
  drag(e, {20, 20}, {60, 25}, MOD_SHIFT);
  CHECK(props(e, R1).transform == Mat2x3::translate(50, 10));
}

TEST_CASE("editor: pressing ⇧ during a drag re-runs it") {
  Editor e = makeEditor();
  down(e, 20, 20);
  move(e, 60, 30);
  CHECK(props(e, R1).transform.m12 == 20);
  e.modifiers(MOD_SHIFT);
  CHECK(props(e, R1).transform.m12 == 10);
  up(e, 60, 30, MOD_SHIFT);
}

TEST_CASE("editor: marquee") {
  Editor e = makeEditor();
  drag(e, {450, -50}, {140, 40});  // from empty canvas over R2's corner and into TOP
  CHECK(e.selection() == std::vector<Guid>{R2, TOP});
  drag(e, {5, 5}, {200, 200});  // started on the frame's background: its children
  CHECK(e.selection() == std::vector<Guid>{R1, R2});
  drag(e, {700, 500}, {450, 50}, MOD_SHIFT);  // ⇧ adds
  CHECK(e.selection() == std::vector<Guid>{R1, R2, TOP});
}

TEST_CASE("editor: draw a rectangle with Figma's defaults, then back to Move") {
  Editor e = makeEditor();
  CHECK(e.setTool(Tool::RECTANGLE) == OK);
  drag(e, {600, 300}, {650, 380});
  CHECK(e.tool() == Tool::MOVE);
  REQUIRE(e.selection().size() == 1);
  Guid id = e.selection()[0];
  const NodeProps& p = props(e, id);
  CHECK(p.type == NodeType::ROUNDED_RECTANGLE);
  CHECK(p.name == "Rectangle 8");
  CHECK(p.size == Vec2{50, 80});
  CHECK(p.transform.m02 == 600);
  REQUIRE(p.fillPaints.size() == 1);
  CHECK(p.fillPaints[0].color == Color::hex(0xD9D9D9));
  CHECK(p.strokeWeight == 1);
  CHECK(p.strokeAlign == StrokeAlign::INSIDE);
  CHECK(e.document().parentOf(id) == kPage);
  e.command(CommandId::UNDO);
  CHECK_FALSE(e.document().has(id));
  CHECK(e.setTool(Tool::PEN) == E_UNSUPPORTED);
}

TEST_CASE("editor: draw with ⇧ (square) and ⌥ (from the centre)") {
  Editor e = makeEditor();
  e.setTool(Tool::ELLIPSE);
  drag(e, {600, 300}, {640, 380}, MOD_SHIFT | MOD_ALT);
  const NodeProps& p = props(e, e.selection()[0]);
  CHECK(p.type == NodeType::ELLIPSE);
  CHECK(p.size == Vec2{160, 160});
  CHECK(p.transform.m02 == 520);
  CHECK(p.transform.m12 == 220);
}

TEST_CASE("editor: a click with the frame tool makes a 100×100 frame inside the frame under it") {
  Editor e = makeEditor();
  e.setTool(Tool::FRAME);
  click(e, 200, 150);
  Guid id = e.selection()[0];
  const NodeProps& p = props(e, id);
  CHECK(p.type == NodeType::FRAME);
  CHECK(p.name == "Frame 4");
  CHECK(p.size == Vec2{100, 100});
  CHECK(p.fillPaints[0].color == Color::hex(0xFFFFFF));
  CHECK(e.document().parentOf(id) == F);
  CHECK(e.document().children(F).back() == id);  // on top of its siblings
  CHECK(p.transform.m02 == 200);
}

TEST_CASE("editor: resize by handles — corner, ⌥ centre, ⇧ ratio, edge, past zero flips") {
  Editor e = makeEditor();
  click(e, 20, 20);  // R1: 10,10 50×50
  drag(e, {60, 60}, {80, 90});
  CHECK(props(e, R1).size == Vec2{70, 80});
  CHECK(props(e, R1).transform.m02 == 10);
  e.command(CommandId::UNDO);
  CHECK(props(e, R1).size == Vec2{50, 50});
  drag(e, {60, 60}, {70, 70}, MOD_ALT);
  CHECK(props(e, R1).size == Vec2{70, 70});
  CHECK(props(e, R1).transform.m02 == 0);
  e.command(CommandId::UNDO);
  drag(e, {60, 60}, {110, 70}, MOD_SHIFT);
  CHECK(props(e, R1).size == Vec2{100, 100});
  e.command(CommandId::UNDO);
  drag(e, {10, 35}, {0, 35});  // the left edge
  CHECK(props(e, R1).size == Vec2{60, 50});
  CHECK(props(e, R1).transform.m02 == 0);
  e.command(CommandId::UNDO);
  drag(e, {60, 35}, {0, 35});  // the right edge past the left one: a flip
  CHECK(props(e, R1).size == Vec2{10, 50});
  CHECK(props(e, R1).transform.m00 == -1);
  CHECK(props(e, R1).transform.m02 == 10);
}

TEST_CASE("editor: resize several scales their boxes") {
  Editor e = makeEditor();
  e.setSelection({R1, R2});  // box 10,10 → 150,60
  drag(e, {150, 60}, {290, 110});
  CHECK(props(e, R1).size == Vec2{100, 100});
  CHECK(props(e, R2).transform.m02 == 190);
  CHECK(props(e, R2).size == Vec2{100, 100});
}

TEST_CASE("editor: rotate from just outside a corner; ⇧ snaps to 15°") {
  Editor e = makeEditor();
  e.setSelection({TOP});  // 400,0 100×100, centre 450,50
  e.pointer(PointerEvent::MOVE, 510, 110, 0, 0, 0);
  CHECK(e.cursor() == CursorKind::ROTATE);
  drag(e, {510, 110}, {390, 110});  // a quarter turn around the centre
  Mat2x3 m = props(e, TOP).transform;
  CHECK(std::atan2(m.m10, m.m00) == doctest::Approx(3.14159265358979 / 2).epsilon(0.001));
  CHECK(props(e, TOP).size == Vec2{100, 100});
  Vec2 centre = m.apply({50, 50});
  CHECK(centre.x == doctest::Approx(450));
  CHECK(centre.y == doctest::Approx(50));
  e.command(CommandId::UNDO);
  drag(e, {510, 110}, {480, 125}, MOD_SHIFT);  // 23° → 30°
  m = props(e, TOP).transform;
  double degrees = std::atan2(m.m10, m.m00) * 180 / 3.14159265358979;
  CHECK(degrees == doctest::Approx(30));
}

TEST_CASE("editor: keys the engine handles — arrows, Esc, Enter, Tab, Space") {
  Editor e = makeEditor();
  e.setSelection({R1});
  CHECK(press(e, KeyCode::ArrowRight) == K_HANDLED);
  press(e, KeyCode::ArrowDown, MOD_SHIFT);
  CHECK(props(e, R1).transform == Mat2x3::translate(11, 20));
  // Key repeat joins one undo step.
  e.command(CommandId::UNDO);
  e.command(CommandId::UNDO);
  for (int i = 0; i < 5; i++) press(e, KeyCode::ArrowLeft, 0, i > 0);
  CHECK(props(e, R1).transform.m02 == 5);
  CHECK(e.undoStack().undoCount() == 1);
  e.command(CommandId::UNDO);
  CHECK(props(e, R1).transform.m02 == 10);
  // Tab / ⇧Tab walk siblings; ⇧Enter the parent; Enter the children; Esc the parent, then nothing.
  e.setSelection({R2});
  press(e, KeyCode::Tab);
  CHECK(e.selection() == std::vector<Guid>{R1});
  press(e, KeyCode::Tab, MOD_SHIFT);
  CHECK(e.selection() == std::vector<Guid>{R2});
  press(e, KeyCode::Enter, MOD_SHIFT);
  CHECK(e.selection() == std::vector<Guid>{F});
  press(e, KeyCode::Enter);
  CHECK(e.selection() == std::vector<Guid>{R1, R2});
  press(e, KeyCode::Escape);
  CHECK(e.selection() == std::vector<Guid>{F});
  press(e, KeyCode::Escape);
  CHECK(e.selection().empty());
  // Everything else is TS's (its shortcut registry).
  CHECK(press(e, KeyCode::KeyV) == 0);
  CHECK(press(e, KeyCode::KeyZ, MOD_PRIMARY) == 0);
  CHECK(press(e, KeyCode::Space) == K_HANDLED);
  CHECK(e.cursor() == CursorKind::HAND);
}

TEST_CASE("editor: commands — delete, select all, order, lock, visibility") {
  Editor e = makeEditor();
  e.setSelection({F});
  e.command(CommandId::DELETE);
  CHECK_FALSE(e.document().has(F));
  CHECK_FALSE(e.document().has(R1));
  e.command(CommandId::UNDO);
  CHECK(e.document().children(F).size() == 2);
  e.command(CommandId::SELECT_ALL);
  CHECK(e.selection() == std::vector<Guid>{F, TOP});
  e.setSelection({R1});
  e.command(CommandId::SELECT_ALL);
  CHECK(e.selection() == std::vector<Guid>{R1, R2});
  e.setSelection({R1});
  e.command(CommandId::BRING_FORWARD);
  CHECK(e.document().children(F) == std::vector<Guid>{R2, R1});
  e.command(CommandId::SEND_TO_BACK);
  CHECK(e.document().children(F) == std::vector<Guid>{R1, R2});
  e.command(CommandId::TOGGLE_LOCK);
  CHECK(props(e, R1).locked);
  CHECK((e.commandState(CommandId::TOGGLE_LOCK) & CMD_CHECKED));
  e.command(CommandId::TOGGLE_VISIBLE);
  CHECK_FALSE(props(e, R1).visible);
  CHECK((e.commandState(CommandId::UNDO) & CMD_ENABLED));
}

TEST_CASE("editor: camera — wheel pans, pinch and ⌘ zoom around the pointer, zoom commands") {
  Editor e = makeEditor();
  e.wheel(100, 100, 30, 40, DeltaMode::PIXEL, 0, 0);
  CHECK(e.camera().x == -30);
  CHECK(e.camera().y == -40);
  e.wheel(100, 100, 0, 3, DeltaMode::LINE, 0, 0);
  CHECK(e.camera().y == -88);
  e.wheel(100, 100, 0, 10, DeltaMode::PIXEL, MOD_SHIFT, 0);  // ⇧: sideways
  CHECK(e.camera().x == -40);
  Vec2 before = e.camera().toWorld({200, 150});
  e.wheel(200, 150, 0, -100, DeltaMode::PIXEL, 0, WHEEL_PINCH);
  CHECK(e.camera().zoom == doctest::Approx(std::exp(1.0)));
  Vec2 after = e.camera().toWorld({200, 150});
  CHECK(after.x == doctest::Approx(before.x));
  CHECK(after.y == doctest::Approx(before.y));
  e.wheel(200, 150, 0, 100, DeltaMode::PIXEL, MOD_META, 0);
  CHECK(e.camera().zoom == doctest::Approx(1));
  e.command(CommandId::ZOOM_IN);
  CHECK(e.camera().zoom == doctest::Approx(2));
  e.command(CommandId::ZOOM_TO_100);
  CHECK(e.camera().zoom == 1);
  e.command(CommandId::ZOOM_TO_FIT);  // everything (0,0 → 500,300) fits at ≤ 100%, centred
  CHECK(e.camera().zoom == doctest::Approx(1));
  CHECK(e.camera().toScreen({250, 150}).x == doctest::Approx(400));
  e.setSelection({R1});
  e.command(CommandId::ZOOM_TO_SELECTION);
  CHECK(e.camera().zoom == doctest::Approx((600 - 128) / 50.0));
  for (int i = 0; i < 30; i++) e.command(CommandId::ZOOM_IN);
  CHECK(e.camera().zoom == kMaxZoom);
  CHECK(e.takeEvents().camera);
}

TEST_CASE("editor: space+drag, middle drag and the hand tool pan") {
  Editor e = makeEditor();
  press(e, KeyCode::Space);
  drag(e, {100, 100}, {150, 120});
  CHECK(e.camera().x == 50);
  CHECK(e.camera().y == 20);
  CHECK(e.selection().empty());
  e.key(KeyEvent::UP, KeyCode::Space, 0, 0, false);
  drag(e, {100, 100}, {90, 100}, 0, 1);
  CHECK(e.camera().x == 40);
  e.setTool(Tool::HAND);
  drag(e, {100, 100}, {100, 130});
  CHECK(e.camera().y == 50);
  CHECK(e.cursor() == CursorKind::HAND);
}

TEST_CASE("editor: hover, cursors, Layers hover, blur cancels") {
  Editor e = makeEditor();
  move(e, 20, 20);
  CHECK(e.hover() == R1);
  CHECK(e.overlay().hover == std::vector<Guid>{R1});
  CHECK(e.takeEvents().hover);
  e.setSelection({R1});
  move(e, 60, 60);
  CHECK(e.cursor() == CursorKind::RESIZE);
  CHECK(e.cursorAngle() == 45);
  move(e, 35, 10);
  CHECK(e.cursor() == CursorKind::RESIZE);
  CHECK(e.cursorAngle() == -90);
  e.pointer(PointerEvent::LEAVE, 0, 0, 0, 0, 0);
  CHECK(e.overlay().hover.empty());
  e.setHover({TOP});
  CHECK(e.overlay().hover == std::vector<Guid>{TOP});
  down(e, 20, 20);
  move(e, 80, 80);
  e.blur();
  CHECK(props(e, R1).transform == Mat2x3::translate(10, 10));
  CHECK(e.takeEvents().documents.empty());
}

TEST_CASE("editor: panel writes and remote removals keep the selection valid") {
  Editor e = makeEditor();
  NodeChange c;
  c.mask = F_NAME;
  c.props.name = "Hero";
  e.setProps({R1}, c, 0);
  CHECK(props(e, R1).name == "Hero");
  e.command(CommandId::UNDO);
  CHECK(props(e, R1).name == "Rectangle 1");
  e.setSelection({R2});
  e.applyChanges({NodeChange::removed(R2)}, APPLY_REMOTE);
  CHECK(e.selection().empty());
  CHECK(e.setProps({R2}, c, 0) == E_NOT_FOUND);
}

TEST_CASE("editor: pages keep their own selection") {
  auto nodes = baseChanges();
  NodeProps page2;
  page2.type = NodeType::CANVAS;
  page2.name = "Page 2";
  page2.parentIndex = {kDoc, "\""};
  nodes.push_back(NodeChange::created({0, 3}, page2));
  nodes.push_back(make({1, 1}, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 10, 10}));
  nodes.push_back(make({1, 2}, NodeType::ROUNDED_RECTANGLE, {0, 3}, "!", {0, 0, 10, 10}));
  Editor e;
  e.loadDocument(nodes, kNoGuid);
  CHECK(e.pages() == std::vector<Guid>{kPage, {0, 3}});
  e.setSelection({{1, 1}});
  e.setCurrentPage({0, 3});
  CHECK(e.selection().empty());
  e.setSelection({{1, 2}});
  e.setCurrentPage(kPage);
  CHECK(e.selection() == std::vector<Guid>{{1, 1}});
  e.setSelection({{1, 2}});  // a node on another page switches to it
  CHECK(e.page() == Guid{0, 3});
}
