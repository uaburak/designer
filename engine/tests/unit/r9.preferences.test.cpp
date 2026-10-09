// Round 9 — the Figma menu › Preferences the canvas acts on (docs/engine-build.md "Round 9 — Menus, toolbar and left
// side"; live menus/main-preferences.txt): engine_set_view_options' bits 256…65536 and live Figma's defaults.
#include <cmath>

#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid A{1, 1}, B{1, 2};

// A 100×100 at (0,0) and B 100×100 at (300,0) on the page; the camera puts the page origin at (100, 100) on screen.
Editor makeEditor() {
  auto nodes = baseChanges();
  nodes.push_back(make(A, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 100, 100}, "A"));
  nodes.push_back(make(B, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {300, 0, 100, 100}, "B"));
  Editor e;
  e.setSessionID(1);
  e.setViewport(1000, 800, 1, 1000, 800);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({100, 100, 1});
  e.takeEvents();
  return e;
}

void down(Editor& e, double x, double y, uint32_t mods = 0, int clicks = 1, int button = 0) {
  e.pointer(PointerEvent::DOWN, x, y, button, button == 2 ? 2 : 1, mods, clicks);
}
void move(Editor& e, double x, double y, uint32_t mods = 0) { e.pointer(PointerEvent::MOVE, x, y, 0, 1, mods); }
void up(Editor& e, double x, double y, uint32_t mods = 0, int button = 0) { e.pointer(PointerEvent::UP, x, y, button, 0, mods); }
void drag(Editor& e, Vec2 from, Vec2 to, uint32_t mods = 0) {
  down(e, from.x, from.y, mods);
  for (int i = 1; i <= 4; i++) move(e, from.x + (to.x - from.x) * i / 4, from.y + (to.y - from.y) * i / 4, mods);
  up(e, to.x, to.y, mods);
}
const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }
void without(Editor& e, uint32_t bit) { e.setViewOptions(e.viewOptions() & ~bit); }
void with(Editor& e, uint32_t bit) { e.setViewOptions(e.viewOptions() | bit); }

}  // namespace

TEST_CASE("r9 preferences: live Figma's defaults") {
  Editor e = makeEditor();
  uint32_t o = e.viewOptions();
  CHECK((o & Editor::VIEW_SNAP_GEOMETRY) != 0);
  CHECK((o & Editor::VIEW_SNAP_OBJECTS) != 0);
  CHECK((o & Editor::VIEW_SHOW_DIMENSIONS) != 0);
  CHECK((o & Editor::VIEW_FLIP_RESIZE) != 0);
  CHECK((o & Editor::VIEW_RIGHT_DRAG_PAN) != 0);
  CHECK((o & (Editor::VIEW_KEEP_TOOL | Editor::VIEW_KEYBOARD_ZOOM_SELECTION | Editor::VIEW_INVERT_ZOOM | Editor::VIEW_SCROLL_WHEEL_ZOOM)) == 0);
}

TEST_CASE("r9 Snap to objects: a move snaps to the other layer's edge; off, it follows the pointer") {
  Editor e = makeEditor();
  e.setSelection({A});
  // A's right edge (100) dragged to 197: within 6 of B's left edge (300 − 100 = 200 for A's x) → x 200.
  drag(e, {150, 150}, {347, 150});
  CHECK(props(e, A).transform.m02 == 200);
  e.command(CommandId::UNDO);
  without(e, Editor::VIEW_SNAP_OBJECTS);
  drag(e, {150, 150}, {347, 150});
  CHECK(props(e, A).transform.m02 == 197);
}

TEST_CASE("r9 Keep tool selected after use: the shape tool stays after a draw") {
  Editor e = makeEditor();
  REQUIRE(e.setTool(Tool::RECTANGLE) == OK);
  drag(e, {100, 400}, {200, 500});
  CHECK(e.tool() == Tool::MOVE);
  with(e, Editor::VIEW_KEEP_TOOL);
  REQUIRE(e.setTool(Tool::RECTANGLE) == OK);
  drag(e, {300, 400}, {400, 500});
  CHECK(e.tool() == Tool::RECTANGLE);
  drag(e, {500, 400}, {600, 500});
  CHECK(e.tool() == Tool::RECTANGLE);
}

TEST_CASE("r9 Show dimensions on objects: the W × H badge under the selection") {
  Editor e = makeEditor();
  e.setSelection({A});
  CHECK(e.overlay().sizeBadge);
  without(e, Editor::VIEW_SHOW_DIMENSIONS);
  CHECK_FALSE(e.overlay().sizeBadge);
}

TEST_CASE("r9 Flip objects while resizing: past the opposite edge the layer mirrors; off, it grows the other way") {
  Editor e = makeEditor();
  e.setSelection({A});
  // The right edge's handle (screen 200, 150) dragged to 50: 50 units left of the left edge.
  drag(e, {200, 150}, {50, 150});
  CHECK(props(e, A).transform.m00 == doctest::Approx(-1));
  e.command(CommandId::UNDO);
  without(e, Editor::VIEW_FLIP_RESIZE);
  drag(e, {200, 150}, {50, 150});
  CHECK(props(e, A).transform.m00 == doctest::Approx(1));
  CHECK(props(e, A).transform.m02 == doctest::Approx(-50));
  CHECK(props(e, A).size.x == doctest::Approx(50));
}

TEST_CASE("r9 Keyboard zooms into selection: Zoom in keeps the selection where it is on screen") {
  Editor e = makeEditor();
  e.setSelection({B});
  e.command(CommandId::ZOOM_IN);
  Camera c = e.camera();
  CHECK(c.zoom == 2);
  CHECK(c.x == doctest::Approx(500 - 2 * 400));  // about the viewport's centre (500, 400): world (400, 300)
  e.setCamera({100, 100, 1});
  with(e, Editor::VIEW_KEYBOARD_ZOOM_SELECTION);
  e.command(CommandId::ZOOM_IN);
  c = e.camera();
  // B's centre (world 350, 50) stays at screen (450, 150).
  CHECK(350 * c.zoom + c.x == doctest::Approx(450));
  CHECK(50 * c.zoom + c.y == doctest::Approx(150));
}

TEST_CASE("r9 Invert zoom direction and Use scroll wheel zoom") {
  Editor e = makeEditor();
  // ⌘ + wheel down zooms out; inverted, in.
  e.wheel(500, 400, 0, 100, DeltaMode::PIXEL, MOD_META | MOD_PRIMARY, 0);
  CHECK(e.camera().zoom < 1);
  e.setCamera({100, 100, 1});
  with(e, Editor::VIEW_INVERT_ZOOM);
  e.wheel(500, 400, 0, 100, DeltaMode::PIXEL, MOD_META | MOD_PRIMARY, 0);
  CHECK(e.camera().zoom > 1);
  without(e, Editor::VIEW_INVERT_ZOOM);
  // A plain wheel pans; with scroll wheel zoom it zooms, and ⌘ + wheel pans.
  e.setCamera({100, 100, 1});
  e.wheel(500, 400, 0, 100, DeltaMode::PIXEL, 0, 0);
  CHECK(e.camera().zoom == 1);
  CHECK(e.camera().y == 0);
  e.setCamera({100, 100, 1});
  with(e, Editor::VIEW_SCROLL_WHEEL_ZOOM);
  e.wheel(500, 400, 0, 100, DeltaMode::PIXEL, 0, 0);
  CHECK(e.camera().zoom < 1);
  e.setCamera({100, 100, 1});
  e.wheel(500, 400, 0, 100, DeltaMode::PIXEL, MOD_META | MOD_PRIMARY, 0);
  CHECK(e.camera().zoom == 1);
  CHECK(e.camera().y == 0);
}

TEST_CASE("r9 Right-click and drag to pan: a right drag pans; a right click opens the menu on release") {
  Editor e = makeEditor();
  // A drag: the view moves, no menu, the selection stays.
  down(e, 150, 150, 0, 1, 2);
  e.pointer(PointerEvent::MOVE, 170, 160, 2, 2, 0);
  e.pointer(PointerEvent::MOVE, 190, 170, 2, 2, 0);
  up(e, 190, 170, 0, 2);
  CHECK(e.camera().x == 140);
  CHECK(e.camera().y == 120);
  CHECK(e.selection().empty());
  CHECK(e.takeEvents().contextMenus.empty());
  // A click: nothing on the press, the menu (and what it picks) on the release.
  e.setCamera({100, 100, 1});
  down(e, 150, 150, 0, 1, 2);
  CHECK(e.takeEvents().contextMenus.empty());
  up(e, 150, 150, 0, 2);
  auto ev = e.takeEvents();
  REQUIRE(ev.contextMenus.size() == 1);
  CHECK(ev.contextMenus[0].x == 150);
  CHECK(e.selection() == std::vector<Guid>{A});
  // Off: the menu on the press (as before round 9).
  without(e, Editor::VIEW_RIGHT_DRAG_PAN);
  down(e, 450, 150, 0, 1, 2);
  CHECK(e.takeEvents().contextMenus.size() == 1);
  up(e, 450, 150, 0, 2);
}

TEST_CASE("r9 Snap to geometry: in vector edit mode a dragged point snaps onto another point") {
  Editor e = makeEditor();
  e.setSelection({A});
  // Double-click A (screen 150, 150): vector edit mode.
  down(e, 150, 150);
  up(e, 150, 150);
  down(e, 150, 150, 0, 2);
  up(e, 150, 150);
  REQUIRE(e.vectorEditing());
  // The bottom-left corner (world 0, 100 → screen 100, 200) dragged to 3 off the bottom-right one (100, 100).
  drag(e, {100, 200}, {203, 203});
  CHECK(props(e, A).size == Vec2{100, 100});  // onto (100, 100): the box stays
  e.command(CommandId::UNDO);
  REQUIRE(e.vectorEditing());
  without(e, Editor::VIEW_SNAP_GEOMETRY);
  drag(e, {100, 200}, {203, 203});
  CHECK(props(e, A).size == Vec2{103, 103});
}
