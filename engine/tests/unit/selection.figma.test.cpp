// Canvas selection against Figma (2026-10-22 audit): clicks, right-clicks, keys and marquees on components,
// instances, groups and frames. Figma's rules and their sources are in docs/engine.md §8.2.
#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

// A main component M (0,0 100×40: background BG, label LB) and its instance I at (0,100); a top-level frame F at
// (300,0) 200×200 holding a group G (FRAME + resizeToFit) of GA and GB, and a rectangle R. Screen = world.
const Guid M{1, 1}, BG{1, 2}, LB{1, 3}, I{1, 10}, F{1, 20}, G{1, 21}, GA{1, 22}, GB{1, 23}, R{1, 24};

std::vector<NodeChange> scene() {
  auto nodes = baseChanges();
  NodeChange m = make(M, NodeType::SYMBOL, kPage, "!", {0, 0, 100, 40}, "Button");
  m.props.fillPaints.clear();
  nodes.push_back(m);
  nodes.push_back(make(BG, NodeType::ROUNDED_RECTANGLE, M, "!", {0, 0, 100, 40}, "Background"));
  nodes.push_back(make(LB, NodeType::ROUNDED_RECTANGLE, M, "\"", {10, 10, 80, 20}, "Label"));
  NodeChange i = make(I, NodeType::INSTANCE, kPage, "\"", {0, 100, 100, 40}, "Button");
  i.props.comp().symbolData.symbolID = M;
  i.props.fillPaints.clear();
  nodes.push_back(i);
  nodes.push_back(make(F, NodeType::FRAME, kPage, "#", {300, 0, 200, 200}, "Frame"));
  NodeChange g = make(G, NodeType::FRAME, F, "!", {10, 10, 100, 50}, "Group");
  g.props.resizeToFit = true;
  g.props.fillPaints.clear();
  nodes.push_back(g);
  nodes.push_back(make(GA, NodeType::ROUNDED_RECTANGLE, G, "!", {0, 0, 40, 50}, "A"));
  nodes.push_back(make(GB, NodeType::ROUNDED_RECTANGLE, G, "\"", {60, 0, 40, 50}, "B"));
  nodes.push_back(make(R, NodeType::ROUNDED_RECTANGLE, F, "\"", {10, 120, 50, 50}, "R"));
  return nodes;
}

Editor load() {
  Editor e;
  e.setSessionID(1);
  e.setViewport(1000, 800, 1, 1000, 800);
  e.loadDocument(scene(), kNoGuid);
  e.setCamera({0, 0, 1});
  e.takeEvents();
  return e;
}

void click(Editor& e, double x, double y, uint32_t mods = 0, int clicks = 1) {
  e.pointer(PointerEvent::DOWN, x, y, 0, 1, mods, clicks);
  e.pointer(PointerEvent::UP, x, y, 0, 0, mods);
}
// A right click (the menu opens on the release with Right-click and drag to pan on, the default).
Editor::Events rightClick(Editor& e, double x, double y, uint32_t mods = 0) {
  e.takeEvents();
  e.pointer(PointerEvent::DOWN, x, y, 2, 2, mods);
  e.pointer(PointerEvent::UP, x, y, 2, 0, mods);
  return e.takeEvents();
}
using Sel = std::vector<Guid>;

}  // namespace

TEST_CASE("selection: a right-click on a selected component keeps it selected, the menu is the component's") {
  Editor e = load();
  e.setSelection({M});
  auto ev = rightClick(e, 50, 20);  // over the label, inside the selected main component
  REQUIRE(ev.contextMenus.size() == 1);
  CHECK(ev.contextMenus[0].selection);
  CHECK(e.selection() == Sel{M});
}

TEST_CASE("selection: a right-click on a selected instance keeps the instance, not its sublayer") {
  Editor e = load();
  e.setSelection({I});
  rightClick(e, 50, 120);
  CHECK(e.selection() == Sel{I});
}

TEST_CASE("selection: a right-click inside a selected group keeps the group") {
  Editor e = load();
  e.setSelection({G});
  rightClick(e, 320, 30);  // on GA
  CHECK(e.selection() == Sel{G});
  // A multi-selection stays whole when one of its layers is right-clicked (live context-multi.txt).
  e.setSelection({GA, R});
  rightClick(e, 320, 130);
  CHECK(e.selection() == (Sel{GA, R}));
}

TEST_CASE("selection: a right-click on an unselected layer selects what a left press would") {
  Editor e = load();
  rightClick(e, 50, 120);  // an instance: whole
  CHECK(e.selection() == Sel{I});
  rightClick(e, 320, 30);  // in a group inside a top-level frame: the group
  CHECK(e.selection() == Sel{G});
  rightClick(e, 320, 130);  // a top-level frame's child
  CHECK(e.selection() == Sel{R});
  rightClick(e, 50, 20, MOD_PRIMARY);  // ⌘: the deepest
  CHECK(e.selection() == Sel{LB});
  rightClick(e, 700, 500);  // empty canvas: the selection stays
  CHECK(e.selection() == Sel{LB});
}

TEST_CASE("selection: a left click inside a selected component still goes one level down (unchanged)") {
  Editor e = load();
  e.setSelection({M});
  click(e, 50, 20);
  CHECK(e.selection() == Sel{LB});
}

// ---- The rest of the audit: Figma's rules as Wecra already had them, kept by these cases -------------------------

namespace {
uint32_t key(Editor& e, KeyCode k, uint32_t mods = 0) { return e.key(KeyEvent::DOWN, k, 0, mods, false); }
void drag(Editor& e, Vec2 a, Vec2 b, uint32_t mods = 0) {
  e.pointer(PointerEvent::DOWN, a.x, a.y, 0, 1, mods, 1);
  for (int i = 1; i <= 4; i++) e.pointer(PointerEvent::MOVE, a.x + (b.x - a.x) * i / 4, a.y + (b.y - a.y) * i / 4, 0, 1, mods);
  e.pointer(PointerEvent::UP, b.x, b.y, 0, 0, mods);
}
}  // namespace

TEST_CASE("selection: clicks — instance whole, double-click one level down, siblings direct, ⇧ toggles, ⌘ deep") {
  Editor e = load();
  click(e, 50, 120);
  CHECK(e.selection() == Sel{I});  // an instance picks whole
  click(e, 50, 120, 0, 2);
  CHECK(e.selection().size() == 1);
  CHECK(e.selection()[0] != I);  // double-click: one level down
  click(e, 320, 30);
  CHECK(e.selection() == Sel{G});
  click(e, 320, 30, 0, 2);
  CHECK(e.selection() == Sel{GA});
  click(e, 380, 30);  // a sibling of the selected layer: picked directly
  CHECK(e.selection() == Sel{GB});
  click(e, 330, 130, MOD_SHIFT);
  CHECK(e.selection() == (Sel{GB, R}));
  click(e, 330, 130, MOD_SHIFT);
  CHECK(e.selection() == Sel{GB});
  click(e, 320, 30, MOD_PRIMARY);
  CHECK(e.selection() == Sel{GA});
  click(e, 700, 500);
  CHECK(e.selection().empty());
}

TEST_CASE("selection: ⇧Enter parent (not the page), Enter children, Tab wraps, Esc clears") {
  Editor e = load();
  e.setSelection({GA});
  key(e, KeyCode::Enter, MOD_SHIFT);
  CHECK(e.selection() == Sel{G});
  key(e, KeyCode::Enter, MOD_SHIFT);
  CHECK(e.selection() == Sel{F});
  key(e, KeyCode::Enter, MOD_SHIFT);
  CHECK(e.selection() == Sel{F});
  key(e, KeyCode::Enter);
  CHECK(e.selection() == (Sel{G, R}));
  e.setSelection({G});
  key(e, KeyCode::Tab);
  CHECK(e.selection() == Sel{R});
  key(e, KeyCode::Tab);
  CHECK(e.selection() == Sel{G});
  key(e, KeyCode::Escape);
  CHECK(e.selection().empty());
  e.setSelection({I});
  key(e, KeyCode::Enter);
  CHECK(e.selection().size() == 2);
}

TEST_CASE("selection: a marquee over part of a top-level instance takes the instance, not its sublayers") {
  Editor e = load();
  drag(e, {-20, 90}, {50, 160});  // over part of the instance
  CHECK(e.selection() == Sel{I});
  drag(e, {-20, -20}, {120, 160});  // the main and the instance whole
  CHECK(e.selection() == (Sel{M, I}));
  drag(e, {280, 100}, {340, 180});  // part of the frame: its child R
  CHECK(e.selection() == Sel{R});
  drag(e, {200, -20}, {600, 300});  // the frame whole
  CHECK(e.selection() == Sel{F});
}

TEST_CASE("selection: hover outlines what a click would pick") {
  Editor e = load();
  e.pointer(PointerEvent::MOVE, 320, 30, 0, 0, 0);
  CHECK(e.hover() == G);
  e.setSelection({M});
  e.pointer(PointerEvent::MOVE, 50, 20, 0, 0, 0);
  CHECK(e.hover() == LB);
  e.pointer(PointerEvent::MOVE, 50, 120, 0, 0, MOD_PRIMARY);
  CHECK(e.hover() != I);
}

TEST_CASE("selection: after duplicate, undo, redo and paste") {
  Editor e = load();
  e.setSelection({R});
  REQUIRE(e.command(CommandId::DUPLICATE) == OK);
  REQUIRE(e.selection().size() == 1);
  Guid copy = e.selection()[0];
  CHECK(copy != R);
  e.command(CommandId::UNDO);
  CHECK(e.selection() == Sel{R});
  e.command(CommandId::REDO);
  CHECK(e.selection() == Sel{copy});
  Clipboard clip;
  e.setSelection({R});
  REQUIRE(e.copySelection(clip));
  e.setSelection({});
  CHECK(e.paste(clip, false) == 1);
  CHECK(e.selection().size() == 1);
}
