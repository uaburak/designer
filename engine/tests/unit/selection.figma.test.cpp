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
