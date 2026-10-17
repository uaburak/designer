// Atlas wave 1, "canvas and shapes" (docs/research/atlas/04-canvas-selection.md §11, 05-shapes-vector.md §14): Figma
// Design's zoom steps, range and fit paddings, the pan bound, implied frame-margin snapping, a ruler's guide removal,
// outline mode's options.
#include <cmath>

#include "doctest.h"
#include "editor/Editor.h"
#include "editor/Snapping.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid F{1, 1}, R1{1, 2}, R2{1, 3}, TOP{1, 4};

// F 300×300 at (0,0) holding R1 and R2; TOP beside it; the camera puts the page origin at (100, 100) on screen.
Editor makeEditor(std::vector<NodeChange> extra = {}) {
  auto nodes = baseChanges();
  nodes.push_back(make(F, NodeType::FRAME, kPage, "!", {0, 0, 300, 300}, "Frame 3"));
  nodes.push_back(make(R1, NodeType::ROUNDED_RECTANGLE, F, "!", {10, 10, 50, 50}, "Rectangle 1"));
  nodes.push_back(make(R2, NodeType::ROUNDED_RECTANGLE, F, "\"", {100, 10, 50, 50}, "Rectangle 2"));
  nodes.push_back(make(TOP, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {400, 0, 100, 100}, "Rectangle 7"));
  for (auto& c : extra) nodes.push_back(c);
  Editor e;
  e.setSessionID(1);
  e.setViewport(1000, 800, 2, 2000, 1600);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({100, 100, 1});
  e.takeEvents();
  return e;
}

void down(Editor& e, double x, double y, uint32_t mods = 0, int clicks = 1) { e.pointer(PointerEvent::DOWN, x, y, 0, 1, mods, clicks); }
void move(Editor& e, double x, double y, uint32_t mods = 0) { e.pointer(PointerEvent::MOVE, x, y, 0, 1, mods); }
void up(Editor& e, double x, double y, uint32_t mods = 0) { e.pointer(PointerEvent::UP, x, y, 0, 0, mods); }
void guide(Editor& e, int axis, Vec2 to) {
  REQUIRE(e.startGuideDrag(axis, axis == 1 ? Vec2{to.x, 10} : Vec2{10, to.y}, 20) == OK);
  move(e, (axis == 1 ? to.x : 100), (axis == 1 ? 100 : to.y));
  move(e, to.x, to.y);
  up(e, to.x, to.y);
}

}  // namespace

// ---- Zoom ------------------------------------------------------------------------------------------------------------

TEST_CASE("atlas zoom: ⌘= / ⌘− step to the next / previous power of two, down to 1/64") {
  Editor e = makeEditor();
  e.setCamera({0, 0, 1.5});
  e.command(CommandId::ZOOM_IN);
  CHECK(e.camera().zoom == 2);
  e.setCamera({0, 0, 1.5});
  e.command(CommandId::ZOOM_OUT);
  CHECK(e.camera().zoom == 1);
  for (int i = 0; i < 12; i++) e.command(CommandId::ZOOM_OUT);
  CHECK(e.camera().zoom == kMinZoom);
  CHECK(e.camera().zoom == doctest::Approx(0.015625));
}

TEST_CASE("atlas zoom: zoom to selection with 40 px a side; nothing selected, zoom to fit (25 px a side, past 100 %)") {
  Editor e = makeEditor();
  e.setSelection({R1});
  e.command(CommandId::ZOOM_TO_SELECTION);
  CHECK(e.camera().zoom == doctest::Approx((800 - 80) / 50.0));
  e.setSelection({});
  e.command(CommandId::ZOOM_TO_SELECTION);
  Camera fromSelection = e.camera();
  e.setCamera({0, 0, 1});
  e.command(CommandId::ZOOM_TO_FIT);
  CHECK(e.camera().zoom == fromSelection.zoom);
  CHECK(e.camera().x == fromSelection.x);
  // Everything (0,0 → 500,300) in 1000 × 800 with 25 px a side: 190 %, no 100 % cap.
  CHECK(e.camera().zoom == doctest::Approx((1000 - 50) / 500.0));
}

TEST_CASE("atlas zoom: the zoom tool's click (Z held) steps as ⌘= does; ⌥-click as ⌘−") {
  Editor e = makeEditor();
  e.setCamera({0, 0, 1.5});
  REQUIRE(e.key(KeyEvent::DOWN, KeyCode::KeyZ, 0, 0, false) == K_HANDLED);
  down(e, 400, 300);
  up(e, 400, 300);
  CHECK(e.camera().zoom == 2);
  e.setCamera({0, 0, 1.5});
  down(e, 400, 300, MOD_ALT);
  up(e, 400, 300, MOD_ALT);
  CHECK(e.camera().zoom == 1);
}

// ---- Pan bound ---------------------------------------------------------------------------------------------------------

TEST_CASE("atlas pan: the view's centre stops 131,072 from the origin") {
  Editor e = makeEditor();
  e.setCamera({-500000, 300000, 1});
  Vec2 centre = e.camera().toWorld({500, 400});
  CHECK(centre.x == doctest::Approx(kCanvasBound));
  CHECK(centre.y == doctest::Approx(-kCanvasBound));
  // Panels over the canvas: the visible part's centre
  e.setViewportInsets(300, 0, 200, 0);
  e.setCamera({-500000, 0, 2});
  CHECK(e.camera().toWorld({300 + 250, 400}).x == doctest::Approx(kCanvasBound));
}

// ---- Implied frame margins ------------------------------------------------------------------------------------------------

TEST_CASE("atlas snapping: a sibling's margin from one side of the parent frame is offered at the other") {
  Snapper s;
  const Rect frame{0, 0, 400, 300};
  s.reset({{20, 50, 100, 100}}, frame);  // 20 from the left, 280 from the right; 50 from the top
  // Moving near the right side: its right edge snaps 20 from the frame's right (380), both margins measured.
  SnapResult r = s.snapBox({276, 180, 100, 50}, 6);
  CHECK(r.snappedX);
  CHECK(r.offset.x == doctest::Approx(4));
  CHECK_FALSE(r.snappedY);
  REQUIRE(r.spacings.size() == 2);
  CHECK(r.spacings[0].a.x == 0);
  CHECK(r.spacings[0].b.x == 20);
  CHECK(r.spacings[1].a.x == doctest::Approx(380));
  CHECK(r.spacings[1].b.x == 400);
  // The top margin kept at the bottom: its bottom edge to 250.
  r = s.snapBox({200, 197, 50, 50}, 6);
  CHECK(r.snappedY);
  CHECK(r.offset.y == doctest::Approx(3));
  // An edge line wins a tie (it is considered first): its left edge 2 from the sibling's right edge, its right 2 from 380.
  s.reset({{20, 50, 100, 100}, {150, 0, 100, 20}}, frame);
  r = s.snapBox({118, 190, 260, 50}, 6);
  CHECK(r.offset.x == doctest::Approx(2));
  CHECK(r.spacings.empty());
  // No parent frame (the page): nothing implied.
  s.reset({{20, 50, 100, 100}}, std::nullopt);
  CHECK_FALSE(s.snapBox({276, 180, 100, 50}, 6).snappedX);
}

TEST_CASE("atlas snapping: moving a layer in a frame snaps to a sibling's mirrored margin") {
  Editor e = makeEditor();
  // R1 is 10 from F's left; R2 dragged so its right edge nears 290 (10 from F's right).
  e.setSelection({R2});
  down(e, 225, 135);
  move(e, 260, 135);
  move(e, 330, 135);  // R2's right edge at 150 + 105 = 255 … then
  move(e, 361, 135);  // 286: snaps to 290
  CHECK(e.document().get(R2)->props.transform.m02 == doctest::Approx(240));
  up(e, 361, 135);
}

// ---- Guides -----------------------------------------------------------------------------------------------------------

TEST_CASE("atlas guides: a ruler's menu removes all its guides (the top ruler's horizontal ones, the left one's vertical)") {
  Editor e = makeEditor();
  e.setViewOptions(e.viewOptions() | Editor::VIEW_RULERS);
  CHECK(e.commandState(CommandId::REMOVE_HORIZONTAL_GUIDES) == 0);
  guide(e, 1, {600, 500});
  guide(e, 1, {600, 600});
  guide(e, 0, {700, 400});
  REQUIRE(e.guidesOf(kPage).size() == 3);
  CHECK(e.commandState(CommandId::REMOVE_HORIZONTAL_GUIDES) == CMD_ENABLED);
  REQUIRE(e.command(CommandId::REMOVE_HORIZONTAL_GUIDES) == OK);
  auto left = e.guidesOf(kPage);
  REQUIRE(left.size() == 1);
  CHECK(left[0].axis == 0);
  CHECK(e.undoStack().undoLabel() == "Remove horizontal guides");
  CHECK(e.command(CommandId::REMOVE_HORIZONTAL_GUIDES) == E_NOT_FOUND);
  e.command(CommandId::UNDO);
  CHECK(e.guidesOf(kPage).size() == 3);
  // With a top-level frame selected, the frame's guides (the ones its rulers add to); the page's stay.
  e.setSelection({F});
  CHECK(e.commandState(CommandId::REMOVE_VERTICAL_GUIDES) == 0);
  guide(e, 0, {250, 300});
  REQUIRE(e.guidesOf(F).size() == 1);
  REQUIRE(e.command(CommandId::REMOVE_VERTICAL_GUIDES) == OK);
  CHECK(e.guidesOf(F).empty());
  CHECK(e.guidesOf(kPage).size() == 3);
}

// ---- Outline mode's options -------------------------------------------------------------------------------------------

TEST_CASE("atlas outlines: Show hidden layers / Show object bounds reach the overlay") {
  Editor e = makeEditor();
  e.setViewOptions(e.viewOptions() | Editor::VIEW_OUTLINES | Editor::VIEW_OUTLINE_HIDDEN);
  Overlay o = e.overlay();
  CHECK(o.outlines);
  CHECK(o.outlineHidden);
  CHECK_FALSE(o.outlineBounds);
  e.setViewOptions((e.viewOptions() & ~Editor::VIEW_OUTLINE_HIDDEN) | Editor::VIEW_OUTLINE_BOUNDS);
  o = e.overlay();
  CHECK_FALSE(o.outlineHidden);
  CHECK(o.outlineBounds);
}

// ---- Boolean operations' version ------------------------------------------------------------------------------------------

TEST_CASE("atlas booleans: new ones carry vectorOperationVersion 1; older ones (none) offer Update, one undo step") {
  NodeChange old = make({2, 1}, NodeType::BOOLEAN_OPERATION, kPage, "#", {600, 0, 100, 100}, "Union");
  NodeChange inside = make({2, 2}, NodeType::ROUNDED_RECTANGLE, {2, 1}, "!", {0, 0, 100, 100}, "Rectangle 9");
  Editor e = makeEditor({old, inside});
  auto version = [&](Guid id) {
    const auto& extra = e.document().get(id)->props.extra;
    auto it = extra.find("vectorOperationVersion");
    return it == extra.end() ? std::string() : it->second;
  };
  // 425 then 1, as varuints.
  const std::string one{static_cast<char>(0xa9), static_cast<char>(0x03), static_cast<char>(0x01)};
  e.setSelection({R1, R2});
  REQUIRE(e.command(CommandId::BOOLEAN_UNION) == OK);
  REQUIRE(e.selection().size() == 1);
  CHECK(version(e.selection()[0]) == one);
  CHECK(e.commandState(CommandId::UPGRADE_VECTOR_OPERATION) == 0);
  // A boolean from before: Update stamps it.
  e.setSelection({{2, 1}});
  CHECK(e.commandState(CommandId::UPGRADE_VECTOR_OPERATION) == CMD_ENABLED);
  REQUIRE(e.command(CommandId::UPGRADE_VECTOR_OPERATION) == OK);
  CHECK(version({2, 1}) == one);
  CHECK(e.undoStack().undoLabel() == "Update boolean");
  CHECK(e.commandState(CommandId::UPGRADE_VECTOR_OPERATION) == 0);
  e.command(CommandId::UNDO);
  CHECK(version({2, 1}).empty());
  // Not a boolean: nothing to update.
  e.setSelection({TOP});
  CHECK(e.command(CommandId::UPGRADE_VECTOR_OPERATION) == E_INVALID);
}
