// Round 7 — the selection engine and canvas interaction as live Figma does them (docs/engine-build.md "Round 7 —
// selection"): frame titles, ⌘-marquee, line endpoints, move and resize modifiers, sections, corner radius handles,
// Esc, paste to replace, select matching, overlay styling.
#include <cmath>

#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid F{1, 1}, R1{1, 2}, R2{1, 3}, TOP{1, 4}, G{1, 5}, S{1, 6}, SF{1, 7}, SR{1, 8};

// F 300×300 at (0,0) holding R1 and R2; TOP beside it; the camera puts the page origin at (100, 100) on screen.
Editor makeEditor(std::vector<NodeChange> extra = {}) {
  auto nodes = baseChanges();
  nodes.push_back(make(F, NodeType::FRAME, kPage, "!", {0, 0, 300, 300}, "Frame 3"));
  nodes.push_back(make(R1, NodeType::ROUNDED_RECTANGLE, F, "!", {10, 10, 50, 50}, "Rectangle 1"));
  nodes.push_back(make(R2, NodeType::ROUNDED_RECTANGLE, F, "\"", {100, 10, 50, 50}, "Rectangle 2"));
  nodes.push_back(make(TOP, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {400, 0, 100, 100}, "Rectangle 7"));
  for (auto& c : extra) nodes.push_back(c);
  Editor e;
  e.setViewport(1000, 800, 2, 2000, 1600);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({100, 100, 1});
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
  for (int i = 1; i <= 4; i++) {
    double t = i / 4.0;
    move(e, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, mods);
  }
  up(e, to.x, to.y, mods);
}
uint32_t press(Editor& e, KeyCode k, uint32_t mods = 0) { return e.key(KeyEvent::DOWN, k, 0, mods, false); }
const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }

}  // namespace

// ---- 1. Frame titles ----------------------------------------------------------------------------------------------

TEST_CASE("r7 titles: a click on a frame's title selects it, ⇧ adds, a drag moves it") {
  Editor e = makeEditor();
  // The title's line: baseline 10 px above the frame (screen y 90), from its left edge.
  click(e, 110, 84);
  CHECK(e.selection() == std::vector<Guid>{F});
  e.setSelection({TOP});
  click(e, 110, 84, MOD_SHIFT);
  CHECK(e.selection() == std::vector<Guid>{TOP, F});
  click(e, 110, 84, MOD_SHIFT);
  CHECK(e.selection() == std::vector<Guid>{TOP});
  // Dragging the title of an unselected frame selects and moves it (a background drag would be a marquee).
  e.setSelection({});
  drag(e, {110, 84}, {160, 124});
  CHECK(e.selection() == std::vector<Guid>{F});
  CHECK(props(e, F).transform == Mat2x3::translate(50, 40));
  CHECK(props(e, R1).transform == Mat2x3::translate(10, 10));  // its children ride along
}

TEST_CASE("r7 titles: hover outlines the frame; a double-click asks to rename it in place") {
  Editor e = makeEditor();
  move(e, 112, 85);
  CHECK(e.hover() == F);
  CHECK(e.cursor() == CursorKind::DEFAULT);
  click(e, 112, 85);
  e.takeEvents();
  click(e, 112, 85, 0, 2);
  auto ev = e.takeEvents();
  REQUIRE(ev.renames.size() == 1);
  CHECK(ev.renames[0].node == F);
  CHECK(ev.renames[0].rect.x <= 100);
  CHECK(ev.renames[0].rect.w >= 300);
  CHECK(e.selection() == std::vector<Guid>{F});
  // Off the title (just above it, and the frame's own background) nothing changes there.
  e.setSelection({});
  click(e, 110, 70);
  CHECK(e.selection().empty());
}

TEST_CASE("r7 titles: frames inside sections have titles; nested frames and groups don't") {
  NodeChange sec = make(S, NodeType::SECTION, kPage, "#", {0, 400, 600, 400}, "Section 1");
  NodeChange inner = make(SF, NodeType::FRAME, S, "!", {50, 100, 200, 200}, "Card");
  NodeChange rect = make(SR, NodeType::ROUNDED_RECTANGLE, SF, "!", {10, 10, 40, 40}, "Dot");
  Editor e = makeEditor({sec, inner, rect});
  std::vector<Guid> titled;
  for (const FrameTitle& t : e.titles()) titled.push_back(t.id);
  CHECK(std::find(titled.begin(), titled.end(), F) != titled.end());
  CHECK(std::find(titled.begin(), titled.end(), S) != titled.end());
  CHECK(std::find(titled.begin(), titled.end(), SF) != titled.end());
  CHECK(std::find(titled.begin(), titled.end(), R1) == titled.end());
  // The card's title: baseline 10 px above it (world y 500 → screen 600).
  click(e, 152, 594);
  CHECK(e.selection() == std::vector<Guid>{SF});
  // The section's pill: inside its top-left corner.
  click(e, 104, 508);
  CHECK(e.selection() == std::vector<Guid>{S});
}

// ---- 2. ⌘-marquee -------------------------------------------------------------------------------------------------

TEST_CASE("r7 marquee: ⌘ selects the nested layers the rect touches, at any depth") {
  const Guid inner{2, 1}, deep{2, 2}, hidden{2, 3};
  NodeChange f2 = make(inner, NodeType::FRAME, F, "#", {10, 100, 150, 150}, "Inner");
  NodeChange r3 = make(deep, NodeType::ROUNDED_RECTANGLE, inner, "!", {10, 10, 30, 30}, "Deep");
  NodeChange r4 = make(hidden, NodeType::ROUNDED_RECTANGLE, inner, "\"", {50, 10, 30, 30}, "Hidden");
  r4.props.visible = false;
  Editor e = makeEditor({f2, r3, r4});
  // From empty canvas over everything: without ⌘ the frame's touched children (F is only partly covered)…
  drag(e, {90, 1000}, {300, 120});
  CHECK(e.selection() == std::vector<Guid>{R1, R2, inner});
  // …with ⌘ the innermost layers: the nested rectangle instead of its frame; the hidden one is skipped.
  drag(e, {90, 1000}, {300, 120}, MOD_PRIMARY);
  CHECK(e.selection() == std::vector<Guid>{R1, R2, deep});
  // ⌘ from a top-level frame's background: a deep marquee too (not a press on the frame).
  e.setSelection({});
  drag(e, {390, 390}, {115, 115}, MOD_PRIMARY);
  CHECK(e.selection() == std::vector<Guid>{R1, R2, deep});
}

// ---- 3. Line endpoint handles -------------------------------------------------------------------------------------

TEST_CASE("r7 lines: two endpoint handles; dragging one turns the line about the other; ⇧ 45°") {
  const Guid L{3, 1};
  NodeChange line = make(L, NodeType::LINE, kPage, "$", {500, 300, 100, 0}, "Line 1");
  Editor e = makeEditor({line});
  e.setSelection({L});
  Overlay o = e.overlay();
  REQUIRE(o.lineEnds.size() == 2);
  CHECK(o.lineEnds[1] == Vec2{600, 300});
  // The end (screen 700,400) dragged down 100: the line now runs from (500,300) to (600,400).
  drag(e, {700, 400}, {700, 500});
  const NodeProps& p = props(e, L);
  CHECK(p.size.x == doctest::Approx(std::sqrt(2.0) * 100));
  CHECK(p.size.y == 0);
  CHECK(p.transform.m02 == 500);
  CHECK(p.transform.m12 == 300);
  Vec2 end = p.transform.apply({p.size.x, 0});
  CHECK(end.x == doctest::Approx(600));
  CHECK(end.y == doctest::Approx(400));
  CHECK(e.undoStack().undoCount() == 1);
  e.command(CommandId::UNDO);
  // The start dragged with ⇧: 45° steps about the end (600,300).
  drag(e, {600, 400}, {640, 390}, MOD_SHIFT);
  Vec2 start = props(e, L).transform.apply({0, 0});
  Vec2 stillEnd = props(e, L).transform.apply({props(e, L).size.x, 0});
  CHECK(stillEnd.x == doctest::Approx(600));
  CHECK(stillEnd.y == doctest::Approx(300));
  CHECK(start.y == doctest::Approx(300).epsilon(0.01));  // snapped to the horizontal
  // No corner handles, no rotation zone around a line.
  move(e, 760, 470);
  CHECK(e.cursor() == CursorKind::DEFAULT);
}

// ---- 6. Move modifiers --------------------------------------------------------------------------------------------

TEST_CASE("r7 move: a frame smaller than the layer doesn't take it; ⌘ nests it anyway; ⌃ turns snapping off") {
  const Guid small{6, 1};
  NodeChange f = make(small, NodeType::FRAME, kPage, "$", {700, 0, 60, 60}, "Small");
  Editor e = makeEditor({f});
  // TOP (100×100) over the 60×60 frame: stays on the page.
  e.setSelection({TOP});
  drag(e, {550, 150}, {830, 150});
  CHECK(e.document().parentOf(TOP) == kPage);
  e.command(CommandId::UNDO);
  // ⌘: into it.
  drag(e, {550, 150}, {830, 150}, MOD_PRIMARY);
  CHECK(e.document().parentOf(TOP) == small);
  e.command(CommandId::UNDO);
  // R1 (50×50) fits: it goes in without ⌘.
  e.setSelection({R1});
  drag(e, {120, 120}, {830, 120});
  CHECK(e.document().parentOf(R1) == small);
  e.command(CommandId::UNDO);
  // Snapping: R1's left edge 2 px from R2's (x 100) snaps without ⌃, not with it; ⌘ no longer turns it off.
  drag(e, {120, 120}, {208, 120});
  CHECK(props(e, R1).transform.m02 == 100);
  e.command(CommandId::UNDO);
  drag(e, {120, 120}, {208, 120}, MOD_PRIMARY);
  CHECK(props(e, R1).transform.m02 == 100);
  e.command(CommandId::UNDO);
  down(e, 120, 120);  // ⌃ at the press would be a right-click (a Mac)
  for (int i = 1; i <= 4; i++) move(e, 120 + 22 * i, 120, MOD_CTRL);
  up(e, 208, 120, MOD_CTRL);
  CHECK(props(e, R1).transform.m02 == 98);
}

// ---- 5 / 7. Resize modifiers --------------------------------------------------------------------------------------

TEST_CASE("r7 resize: Lock aspect ratio keeps the ratio on the canvas, ⌃ lets it go; ⇧ otherwise") {
  Editor e = makeEditor();
  NodeChange lock = NodeChange::changed(R1);
  lock.mask = F_PROPORTIONS_CONSTRAINED;
  lock.props.proportionsConstrained = true;
  e.applyChanges({lock}, APPLY_REMOTE);
  e.setSelection({R1});  // 10,10 50×50 → screen 110..160
  drag(e, {160, 160}, {210, 170});
  CHECK(props(e, R1).size == Vec2{100, 100});
  e.command(CommandId::UNDO);
  down(e, 160, 160);
  for (int i = 1; i <= 4; i++) move(e, 160 + 12.5 * i, 160 + 2.5 * i, MOD_CTRL);
  up(e, 210, 170, MOD_CTRL);
  CHECK(props(e, R1).size == Vec2{100, 60});
  e.command(CommandId::UNDO);
  // Unlocked R2: free, ⇧ keeps the ratio.
  e.setSelection({R2});  // 100,10 50×50 → screen 200..250
  drag(e, {250, 160}, {300, 170});
  CHECK(props(e, R2).size == Vec2{100, 60});
  e.command(CommandId::UNDO);
  drag(e, {250, 160}, {300, 170}, MOD_SHIFT);
  CHECK(props(e, R2).size == Vec2{100, 100});
}

TEST_CASE("r7 resize: ⌘ ignores constraints — the frame's children stay where they are on the page") {
  Editor e = makeEditor();
  e.setSelection({F});
  // The left edge (screen x 100) to 150: the frame now starts at x 50.
  drag(e, {100, 250}, {150, 250});
  CHECK(props(e, F).transform.m02 == 50);
  CHECK(e.document().worldBounds(R1).x == 60);  // left constraint: it moved with the edge
  e.command(CommandId::UNDO);
  drag(e, {100, 250}, {150, 250}, MOD_PRIMARY);
  CHECK(props(e, F).transform.m02 == 50);
  CHECK(props(e, F).size.x == 250);
  CHECK(e.document().worldBounds(R1).x == 10);  // stayed
  CHECK(e.document().worldBounds(R2).x == 100);
  e.command(CommandId::UNDO);
  CHECK(props(e, R1).transform == Mat2x3::translate(10, 10));
}
