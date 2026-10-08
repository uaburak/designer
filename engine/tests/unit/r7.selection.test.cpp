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
  // The section's pill: above its top-left corner (screen y 473..495).
  click(e, 104, 484);
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

TEST_CASE("r7 move: ⌘ nests too; ⌃ turns snapping off") {
  const Guid small{6, 1};
  NodeChange f = make(small, NodeType::FRAME, kPage, "$", {700, 0, 60, 60}, "Small");
  Editor e = makeEditor({f});
  // ⌘: into the frame under the pointer.
  e.setSelection({TOP});
  drag(e, {550, 150}, {830, 150}, MOD_PRIMARY);
  CHECK(e.document().parentOf(TOP) == small);
  e.command(CommandId::UNDO);
  // R1 too (pressed in its middle: its corner radius handles sit 12 px in from its corners).
  e.setSelection({R1});
  drag(e, {135, 135}, {845, 135});
  CHECK(e.document().parentOf(R1) == small);
  e.command(CommandId::UNDO);
  // Snapping: R1's left edge 2 px from R2's (x 100) snaps without ⌃, not with it; ⌘ no longer turns it off.
  drag(e, {135, 135}, {223, 135});
  CHECK(props(e, R1).transform.m02 == 100);
  e.command(CommandId::UNDO);
  drag(e, {135, 135}, {223, 135}, MOD_PRIMARY);
  CHECK(props(e, R1).transform.m02 == 100);
  e.command(CommandId::UNDO);
  down(e, 135, 135);  // ⌃ at the press would be a right-click (a Mac)
  for (int i = 1; i <= 4; i++) move(e, 135 + 22 * i, 135, MOD_CTRL);
  up(e, 223, 135, MOD_CTRL);
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

// ---- 6 (live). Drop by the cursor --------------------------------------------------------------------------------

TEST_CASE("r7 move: a layer bigger than a frame dropped with the cursor over it nests (live Figma)") {
  const Guid small{6, 2};
  NodeChange f = make(small, NodeType::FRAME, kPage, "$", {700, 0, 60, 60}, "Small");
  Editor e = makeEditor({f});
  e.setSelection({TOP});  // 100×100: bigger than the 60×60 frame
  drag(e, {550, 150}, {830, 130});
  CHECK(e.document().parentOf(TOP) == small);
  e.command(CommandId::UNDO);
  CHECK(e.document().parentOf(TOP) == kPage);
  // Space held keeps it out.
  e.setSelection({TOP});
  down(e, 550, 150);
  move(e, 600, 150);
  e.key(KeyEvent::DOWN, KeyCode::Space, 0, 0, false);
  for (int i = 1; i <= 4; i++) move(e, 600 + 57.5 * i, 150 - 5 * i);
  up(e, 830, 130);
  e.key(KeyEvent::UP, KeyCode::Space, 0, 0, false);
  CHECK(e.document().parentOf(TOP) == kPage);
}

// ---- 8. Sections ----------------------------------------------------------------------------------------------------

TEST_CASE("r7 sections: ⇧S draws a section in Figma's defaults for the theme; drawn around layers it takes them") {
  Editor e = makeEditor();
  REQUIRE(e.setTool(Tool::SECTION) == OK);
  // Around TOP (world 400,0 100×100 → screen 500..600, 100..200).
  drag(e, {480, 80}, {640, 240});
  REQUIRE(e.selection().size() == 1);
  Guid s = e.selection()[0];
  const NodeProps& p = props(e, s);
  CHECK(p.type == NodeType::SECTION);
  CHECK(p.name == "Section 1");
  CHECK(e.tool() == Tool::MOVE);
  // Dark UI (the editor's default theme): #444444, a white 10 % inside stroke, radius 2, no clipping.
  REQUIRE(p.fillPaints.size() == 1);
  CHECK(p.fillPaints[0].color == Color::hex(0x444444));
  REQUIRE(p.strokePaints.size() == 1);
  CHECK(p.strokePaints[0].color == Color::hex(0xFFFFFF));
  CHECK(p.strokePaints[0].opacity == doctest::Approx(0.1));
  CHECK(p.strokeAlign == StrokeAlign::INSIDE);
  CHECK(p.cornerRadii[0] == 2);
  CHECK(!p.clipsContent());
  // TOP is in it now, where it was on the page; F (only partly covered) stays out.
  CHECK(e.document().parentOf(TOP) == s);
  CHECK(e.document().worldBounds(TOP) == Rect{400, 0, 100, 100});
  CHECK(e.document().parentOf(F) == kPage);
  // One undo step takes both back.
  e.command(CommandId::UNDO);
  CHECK(!e.document().has(s));
  CHECK(e.document().parentOf(TOP) == kPage);
  // The light UI: white, a black 10 % stroke.
  e.setTheme(Theme::Light);
  e.setTool(Tool::SECTION);
  drag(e, {700, 500}, {800, 600});
  REQUIRE(e.selection().size() == 1);
  const NodeProps& q = props(e, e.selection()[0]);
  CHECK(q.fillPaints[0].color == Color::hex(0xFFFFFF));
  CHECK(q.strokePaints[0].color == Color::hex(0x000000));
}

TEST_CASE("r7 sections: what is in a section picks as on the page; its background acts like empty canvas") {
  NodeChange sec = make(S, NodeType::SECTION, kPage, "#", {0, 400, 600, 400}, "Section 1");
  NodeChange inner = make(SF, NodeType::FRAME, S, "!", {50, 100, 200, 200}, "Card");
  NodeChange rect = make(SR, NodeType::ROUNDED_RECTANGLE, SF, "!", {10, 10, 40, 40}, "Dot");
  Editor e = makeEditor({sec, inner, rect});
  // A click on the card's child: the child (the card is a top-level frame in its section). World (60,510) → (160,610).
  click(e, 165, 615);
  CHECK(e.selection() == std::vector<Guid>{SR});
  // On the card's own background (it has a child): nothing, like empty canvas.
  click(e, 300, 750);
  CHECK(e.selection().empty());
  // The section's background: nothing either; a drag there is a marquee among its layers.
  click(e, 600, 1100);
  CHECK(e.selection().empty());
  drag(e, {500, 1150}, {200, 700});
  CHECK(e.selection() == std::vector<Guid>{SF});
  CHECK(props(e, S).transform == Mat2x3::translate(0, 400));
  // A top-level frame's background (F has children): a click selects nothing (live Figma).
  e.setSelection({TOP});
  click(e, 300, 300);
  CHECK(e.selection().empty());
  // ⇧ keeps the selection.
  e.setSelection({TOP});
  click(e, 300, 300, MOD_SHIFT);
  CHECK(e.selection() == std::vector<Guid>{TOP});
}

TEST_CASE("r7 sections: Wrap in new section (230) around canvas-level layers; Remove keeping contents (231)") {
  Editor e = makeEditor();
  e.setSelection({R1});
  CHECK((e.commandState(CommandId::WRAP_IN_SECTION) & CMD_ENABLED) == 0);  // inside a frame: no
  e.setSelection({F, TOP});
  CHECK((e.commandState(CommandId::WRAP_IN_SECTION) & CMD_ENABLED) != 0);
  REQUIRE(e.command(CommandId::WRAP_IN_SECTION) == OK);
  REQUIRE(e.selection().size() == 1);
  Guid s = e.selection()[0];
  const NodeProps& p = props(e, s);
  CHECK(p.type == NodeType::SECTION);
  CHECK(e.document().parentOf(F) == s);
  CHECK(e.document().parentOf(TOP) == s);
  // Their order and their place on the page kept; the section around them with room.
  CHECK(e.document().children(s) == std::vector<Guid>{F, TOP});
  CHECK(e.document().worldBounds(F) == Rect{0, 0, 300, 300});
  CHECK(e.document().worldBounds(TOP) == Rect{400, 0, 100, 100});
  Rect sb = e.document().worldBounds(s);
  CHECK(sb.containsRect(Rect{0, 0, 500, 300}));
  CHECK(e.undoStack().undoCount() == 1);
  // Remove the section keeping its contents: they go back on the page, where they are, selected.
  CHECK((e.commandState(CommandId::REMOVE_KEEP_CONTENTS) & CMD_ENABLED) != 0);
  REQUIRE(e.command(CommandId::REMOVE_KEEP_CONTENTS) == OK);
  CHECK(!e.document().has(s));
  CHECK(e.document().parentOf(F) == kPage);
  CHECK(e.document().parentOf(TOP) == kPage);
  CHECK(e.document().worldBounds(F) == Rect{0, 0, 300, 300});
  CHECK(e.selection() == std::vector<Guid>{F, TOP});
  e.command(CommandId::UNDO);
  CHECK(e.document().has(s));
  CHECK(e.document().parentOf(F) == s);
  // A frame removed keeping its layers: R1 and R2 on the page at their place.
  e.command(CommandId::UNDO);
  e.setSelection({F});
  REQUIRE(e.command(CommandId::REMOVE_KEEP_CONTENTS) == OK);
  CHECK(!e.document().has(F));
  CHECK(e.document().parentOf(R1) == kPage);
  CHECK(e.document().worldBounds(R2) == Rect{100, 10, 50, 50});
  // Nothing to remove for a plain shape.
  e.setSelection({TOP});
  CHECK((e.commandState(CommandId::REMOVE_KEEP_CONTENTS) & CMD_ENABLED) == 0);
}

// ---- 10. Select matching --------------------------------------------------------------------------------------------

TEST_CASE("r7 select matching (232): like layers in the frame; Select all with same fill / stroke / font") {
  const Guid R3{7, 1}, R4{7, 2}, T1{7, 3}, T2{7, 4};
  NodeChange r3 = make(R3, NodeType::ROUNDED_RECTANGLE, F, "#", {200, 10, 50, 50}, "Other name");
  NodeChange r4 = make(R4, NodeType::ROUNDED_RECTANGLE, F, "$", {10, 100, 80, 20}, "Wide");
  NodeChange t1 = make(T1, NodeType::TEXT, kPage, "$", {600, 0, 50, 20}, "A");
  NodeChange t2 = make(T2, NodeType::TEXT, kPage, "%", {600, 50, 50, 20}, "B");
  t2.props.text().fontSize = 30;
  Editor e = makeEditor({r3, r4, t1, t2});
  e.setSelection({R1});
  CHECK((e.commandState(CommandId::SELECT_MATCHING) & CMD_ENABLED) != 0);
  REQUIRE(e.command(CommandId::SELECT_MATCHING) == OK);
  // Same type, size and paints, within F: R1, R2, R3 (not R4: another size; not TOP: outside F).
  CHECK(e.selection() == std::vector<Guid>{R1, R2, R3});
  // Select all with same fill: every rectangle with the default fill, TOP included.
  CommandArgs a;
  json::parse(R"({"mode":"FILL"})", a.raw);
  e.setSelection({R1});
  REQUIRE(e.command(CommandId::SELECT_MATCHING, a) == OK);
  CHECK(e.selection().size() == 5);
  // Same font: both texts; same text properties: only the one at the same size.
  json::parse(R"({"mode":"FONT"})", a.raw);
  e.setSelection({T1});
  REQUIRE(e.command(CommandId::SELECT_MATCHING, a) == OK);
  CHECK(e.selection() == std::vector<Guid>{T1, T2});
  json::parse(R"({"mode":"TEXT"})", a.raw);
  e.setSelection({T1});
  REQUIRE(e.command(CommandId::SELECT_MATCHING, a) == OK);
  CHECK(e.selection() == std::vector<Guid>{T1});
  // Nothing selected: disabled.
  e.setSelection({});
  CHECK((e.commandState(CommandId::SELECT_MATCHING) & CMD_ENABLED) == 0);
}

// ---- 13. Tidy up ----------------------------------------------------------------------------------------------------

TEST_CASE("r7 tidy up (233): a rough row and grid laid out evenly at their mean gap") {
  const Guid A{8, 1}, B{8, 2}, C{8, 3};
  NodeChange a = make(A, NodeType::ROUNDED_RECTANGLE, kPage, "$", {600, 0, 40, 40}, "A");
  NodeChange b = make(B, NodeType::ROUNDED_RECTANGLE, kPage, "%", {652, 6, 40, 40}, "B");
  NodeChange c = make(C, NodeType::ROUNDED_RECTANGLE, kPage, "&", {720, -4, 40, 40}, "C");
  Editor e = makeEditor({a, b, c});
  e.setSelection({A, B, C});
  CHECK((e.commandState(CommandId::TIDY_UP) & CMD_ENABLED) != 0);
  REQUIRE(e.command(CommandId::TIDY_UP) == OK);
  // Gaps 12 and 28 → 20; one row along the top (y −4), from the leftmost x.
  CHECK(e.document().worldBounds(A) == Rect{600, -4, 40, 40});
  CHECK(e.document().worldBounds(B) == Rect{660, -4, 40, 40});
  CHECK(e.document().worldBounds(C) == Rect{720, -4, 40, 40});
  CHECK(e.undoStack().undoCount() == 1);
  e.setSelection({A});
  CHECK((e.commandState(CommandId::TIDY_UP) & CMD_ENABLED) == 0);
}

// ---- 15. N / ⇧N -----------------------------------------------------------------------------------------------------

TEST_CASE("r7 zoom to next / previous frame (234/235): Layers order from the bottom, wraps, the selection stays") {
  const Guid F2{9, 1}, F3{9, 2};
  NodeChange f2 = make(F2, NodeType::FRAME, kPage, "$", {600, 400, 200, 100}, "Second");
  NodeChange f3 = make(F3, NodeType::FRAME, kPage, "%", {-500, 800, 100, 100}, "Third");
  Editor e = makeEditor({f2, f3});
  auto centre = [&] {
    Vec2 c = e.camera().toWorld({500, 400});
    return Vec2{std::round(c.x), std::round(c.y)};
  };
  REQUIRE(e.command(CommandId::ZOOM_TO_NEXT_FRAME) == OK);
  CHECK(centre() == Vec2{150, 150});  // F (the page's first child)
  CHECK(e.selection().empty());
  e.command(CommandId::ZOOM_TO_NEXT_FRAME);
  CHECK(centre() == Vec2{700, 450});  // Second
  e.command(CommandId::ZOOM_TO_NEXT_FRAME);
  CHECK(centre() == Vec2{-450, 850});  // Third
  e.command(CommandId::ZOOM_TO_NEXT_FRAME);
  CHECK(centre() == Vec2{150, 150});  // wraps
  e.command(CommandId::ZOOM_TO_PREVIOUS_FRAME);
  CHECK(centre() == Vec2{-450, 850});
  CHECK(e.selection().empty());
  // From a selected layer: its frame's next one; the selection stays.
  e.setSelection({R1});
  e.command(CommandId::ZOOM_TO_NEXT_FRAME);
  CHECK(centre() == Vec2{700, 450});
  CHECK(e.selection() == std::vector<Guid>{R1});
}

// ---- 9. Esc, \, Enter, Tab --------------------------------------------------------------------------------------------

TEST_CASE("r7 keys: Esc clears the selection; ⇧Enter and \\ select the parent; Enter takes hidden and locked children") {
  const Guid H{10, 1}, L{10, 2};
  NodeChange h = make(H, NodeType::ROUNDED_RECTANGLE, F, "#", {10, 100, 20, 20}, "Hidden");
  h.props.visible = false;
  NodeChange l = make(L, NodeType::ROUNDED_RECTANGLE, F, "$", {40, 100, 20, 20}, "Locked");
  l.props.locked = true;
  Editor e = makeEditor({h, l});
  e.setSelection({R1});
  press(e, KeyCode::Escape);
  CHECK(e.selection().empty());
  CHECK(press(e, KeyCode::Escape) == K_HANDLED);  // a second Esc: nothing more
  e.setSelection({R1});
  press(e, KeyCode::Backslash);
  CHECK(e.selection() == std::vector<Guid>{F});
  press(e, KeyCode::Enter);
  CHECK(e.selection() == std::vector<Guid>{R1, R2, H, L});
  e.setSelection({R2});
  press(e, KeyCode::Enter, MOD_SHIFT);
  CHECK(e.selection() == std::vector<Guid>{F});
  // Tab: down the Layers list (the sibling below), wrapping, hidden and locked included; ⇧Tab up.
  e.setSelection({R1});
  press(e, KeyCode::Tab);
  CHECK(e.selection() == std::vector<Guid>{L});
  press(e, KeyCode::Tab);
  CHECK(e.selection() == std::vector<Guid>{H});
  press(e, KeyCode::Tab, MOD_SHIFT);
  CHECK(e.selection() == std::vector<Guid>{L});
  press(e, KeyCode::Tab, MOD_SHIFT);
  CHECK(e.selection() == std::vector<Guid>{R1});
}

// ---- ⌘D repeats the last offset ----------------------------------------------------------------------------------

TEST_CASE("r7 duplicate: ⌘D in place with the same name; moved, the next ⌘D repeats the offset") {
  Editor e = makeEditor();
  e.setSelection({TOP});
  e.command(CommandId::DUPLICATE);
  REQUIRE(e.selection().size() == 1);
  Guid c1 = e.selection()[0];
  CHECK(props(e, c1).name == "Rectangle 7");
  CHECK(props(e, c1).transform == Mat2x3::translate(400, 0));
  for (int i = 0; i < 3; i++) press(e, KeyCode::ArrowDown, MOD_SHIFT);
  CHECK(props(e, c1).transform == Mat2x3::translate(400, 30));
  e.command(CommandId::DUPLICATE);
  Guid c2 = e.selection()[0];
  CHECK(props(e, c2).transform == Mat2x3::translate(400, 60));
  e.command(CommandId::DUPLICATE);
  Guid c3 = e.selection()[0];
  CHECK(props(e, c3).transform == Mat2x3::translate(400, 90));
  // Another selection: in place again.
  e.setSelection({R1});
  e.command(CommandId::DUPLICATE);
  CHECK(props(e, e.selection()[0]).transform == Mat2x3::translate(10, 10));
}

// ---- 11. Paste over selection, paste to replace ------------------------------------------------------------------

TEST_CASE("r7 paste: ⇧⌘V over the selection (in place, above it, not into it); ⇧⌘R in each replaced layer's place") {
  Editor e = makeEditor();
  e.setSelection({TOP});
  Clipboard clip;
  REQUIRE(e.copySelection(clip));
  // Over the selected frame F: where TOP was copied from, a sibling just above F (not inside it).
  e.setSelection({F});
  REQUIRE(e.pasteWith(clip, PASTE_IN_PLACE | PASTE_OVER) == 1);
  Guid over = e.selection()[0];
  CHECK(e.document().parentOf(over) == kPage);
  CHECK(e.document().worldBounds(over) == Rect{400, 0, 100, 100});
  CHECK(e.document().children(kPage)[1] == over);  // right above F
  e.command(CommandId::UNDO);
  // Paste to replace R2 (inside F): the copy takes R2's place and order, R2 goes; one undo step.
  NodeChange c = NodeChange::changed(R2);
  c.mask = F_H_CONSTRAINT;
  c.props.horizontalConstraint = ConstraintType::MAX;
  e.applyChanges({c}, APPLY_REMOTE);
  e.setSelection({R2});
  REQUIRE(e.pasteWith(clip, PASTE_REPLACE) == 1);
  Guid rep = e.selection()[0];
  CHECK(!e.document().has(R2));
  CHECK(e.document().parentOf(rep) == F);
  CHECK(e.document().children(F) == std::vector<Guid>{R1, rep});
  CHECK(e.document().worldBounds(rep) == Rect{100, 10, 100, 100});
  CHECK(props(e, rep).horizontalConstraint == ConstraintType::MAX);
  auto ev = e.takeEvents();
  CHECK(ev.documents.back().label == "Paste to replace");
  e.command(CommandId::UNDO);
  CHECK(e.document().has(R2));
  CHECK(!e.document().has(rep));
  // Two layers replaced: a copy in each place.
  e.setSelection({R1, R2});
  REQUIRE(e.pasteWith(clip, PASTE_REPLACE) == 2);
  CHECK(e.document().children(F).size() == 2);
  CHECK(e.document().worldBounds(e.selection()[0]) == Rect{10, 10, 100, 100});
  CHECK(e.document().worldBounds(e.selection()[1]) == Rect{100, 10, 100, 100});
}

// ---- 4. Corner radius handles ---------------------------------------------------------------------------------------

TEST_CASE("r7 radius: a selected rectangle under the pointer shows four handles; a drag sets the radius, ⌥ one corner") {
  Editor e = makeEditor();
  e.setSelection({TOP});  // world 400,0 100×100 → screen 500..600, 100..200
  move(e, 800, 600);      // the pointer elsewhere: none
  CHECK(e.overlay().radiusHandles.empty());
  move(e, 550, 150);
  Overlay o = e.overlay();
  REQUIRE(o.radiusHandles.size() == 4);
  CHECK(o.radiusHandles[0] == Vec2{412, 12});  // 12 px in from the top-left (radius 0)
  CHECK(o.radiusHandles[2] == Vec2{488, 88});
  // The top-left handle dragged 10 px along its diagonal: radius 10 on every corner, one undo step.
  drag(e, {512, 112}, {522, 122});
  CHECK(props(e, TOP).cornerRadii == CornerRadii{10, 10, 10, 10});
  CHECK(e.undoStack().undoCount() == 1);
  CHECK(props(e, TOP).transform == Mat2x3::translate(400, 0));  // not moved
  // The handle now sits on the radius (still 12 px in: the radius is smaller).
  move(e, 550, 150);
  CHECK(e.overlay().radiusHandles[0] == Vec2{412, 12});
  // ⌥: the bottom-right corner only, up to half the shorter side.
  drag(e, {588, 188}, {500, 100}, MOD_ALT);
  CHECK(props(e, TOP).cornerRadii == CornerRadii{10, 10, 50, 10});
  e.command(CommandId::UNDO);
  CHECK(props(e, TOP).cornerRadii == CornerRadii{10, 10, 10, 10});
  // A small rectangle on screen: no handles (R1 is 50×50 at 100 %: 50 px; zoomed out to 50 %: 25 px).
  e.setCamera({100, 100, 0.5});
  e.setSelection({R1});
  move(e, 117, 117);
  CHECK(e.overlay().radiusHandles.empty());
}

// ---- 13. Smart selection --------------------------------------------------------------------------------------------

TEST_CASE("r7 smart selection: equally spaced layers get dots and gap handles; dragging one gap sets them all") {
  const Guid A{11, 1}, B{11, 2}, C{11, 3};
  // Live Figma's case: three 60-wide layers 20 apart at x 500 / 580 / 660.
  NodeChange a = make(A, NodeType::ROUNDED_RECTANGLE, kPage, "$", {500, 400, 60, 60}, "S1");
  NodeChange b = make(B, NodeType::ROUNDED_RECTANGLE, kPage, "%", {580, 400, 60, 60}, "S2");
  NodeChange c = make(C, NodeType::ROUNDED_RECTANGLE, kPage, "&", {660, 400, 60, 60}, "S3");
  Editor e = makeEditor({a, b, c});
  e.setSelection({C, A, B});
  move(e, 50, 50);  // away
  Overlay o = e.overlay();
  CHECK(o.centreDots.size() == 3);
  CHECK(o.gapHandles.empty());
  // Over the selection: a handle in each gap (its middle: x 570 and 650 → screen 670, 750).
  move(e, 700, 530);
  o = e.overlay();
  REQUIRE(o.gapHandles.size() == 2);
  CHECK(o.gapHandles[0].at == Vec2{570, 430});
  CHECK(o.gapHandles[0].value == 20);
  // Dragging the first gap's handle 11 units right: the handle follows the pointer, every gap 42; S1 stays.
  drag(e, {670, 530}, {681, 530});
  CHECK(props(e, A).transform.m02 == 500);
  CHECK(props(e, B).transform.m02 == 602);
  CHECK(props(e, C).transform.m02 == 704);
  CHECK(e.undoStack().undoCount() == 1);
  CHECK(e.selection().size() == 3);
  // Unequal gaps: no smart selection.
  e.command(CommandId::UNDO);
  e.setSelection({A, C});
  CHECK(e.overlay().centreDots.size() == 2);  // two layers: one gap, equal to itself
  NodeChange off = NodeChange::changed(C);
  off.mask = F_TRANSFORM;
  off.props.transform = Mat2x3::translate(700, 400);
  e.applyChanges({off}, APPLY_REMOTE);
  e.setSelection({A, B, C});
  CHECK(e.overlay().centreDots.empty());
}

// ---- View options -------------------------------------------------------------------------------------------------------

TEST_CASE("r7 view: the pixel grid and outline mode reach the overlay; hover outlines a selected layer too") {
  Editor e = makeEditor();
  CHECK(e.overlay().pixelGrid);
  CHECK(!e.overlay().outlines);
  e.setViewOptions(Editor::VIEW_OUTLINES);
  CHECK(!e.overlay().pixelGrid);
  CHECK(e.overlay().outlines);
  e.setSelection({TOP});
  move(e, 550, 150);
  CHECK(e.overlay().hover == std::vector<Guid>{TOP});
}

// ---- 19. Marquee levels -------------------------------------------------------------------------------------------------

TEST_CASE("r7 marquee: a top-level frame taken whole keeps the marquee to top-level layers") {
  const Guid F2{12, 1}, K{12, 2};
  NodeChange f2 = make(F2, NodeType::FRAME, kPage, "$", {0, 400, 200, 200}, "Frame 4");
  NodeChange k = make(K, NodeType::ROUNDED_RECTANGLE, F2, "!", {10, 10, 50, 50}, "Kid");
  Editor e = makeEditor({f2, k});
  // Over all of F2 (world 0..200, 400..600) and part of F (its R1 and R2): F2 whole, not them.
  drag(e, {90, 710}, {320, 130});
  CHECK(e.selection() == std::vector<Guid>{F2});
  // Over part of F only: its children, as before.
  drag(e, {90, 380}, {300, 120});
  CHECK(e.selection() == std::vector<Guid>{R1, R2});
}

// ---- 17. Auto layout's padding and gap handles on the canvas ----------------------------------------------------------

TEST_CASE("r7 auto layout: padding and gap bars under the pointer; dragging one changes it") {
  const Guid AL{13, 1}, X{13, 2}, Y{13, 3};
  NodeChange f = make(AL, NodeType::FRAME, kPage, "$", {600, 400, 150, 70}, "Auto");
  f.props.stack().stackMode = StackMode::HORIZONTAL;
  f.props.stack().stackPrimarySizing = StackSize::FIXED;
  f.props.stack().stackSpacing = 30;
  f.props.stack().stackPaddingLeft = f.props.stack().stackPaddingTop = f.props.stack().stackPaddingRight = f.props.stack().stackPaddingBottom = 10;
  NodeChange x = make(X, NodeType::ROUNDED_RECTANGLE, AL, "!", {10, 10, 50, 50});
  NodeChange y = make(Y, NodeType::ROUNDED_RECTANGLE, AL, "\"", {90, 10, 50, 50});
  Editor e = makeEditor({f, x, y});
  e.setSelection({AL});
  move(e, 50, 50);
  CHECK(e.overlay().layoutBars.empty());
  // Over the gap (world 660..690 → screen 760..790): four padding bars and the gap's, the gap's hovered.
  move(e, 775, 535);
  Overlay o = e.overlay();
  REQUIRE(o.layoutBars.size() == 5);
  const Overlay::LayoutBar& gap = o.layoutBars[4];
  CHECK(gap.gap);
  CHECK(gap.hovered);
  CHECK(gap.at == Vec2{675, 435});
  CHECK(gap.value == 30);
  CHECK(o.layoutBars[0].at == Vec2{605, 435});  // the left padding's middle
  // Its bar follows the pointer: 10 units right → the gap 30 + 10 / 0.5 = 50.
  drag(e, {775, 535}, {785, 535});
  CHECK(props(e, AL).stack().stackSpacing == 50);
  CHECK(e.undoStack().undoCount() == 1);
  CHECK(e.selection() == std::vector<Guid>{AL});
  // The left padding dragged 6 right: 16; ⌥ the right one too.
  move(e, 705, 535);
  REQUIRE(e.overlay().layoutBars[0].hovered);
  drag(e, {705, 535}, {711, 535});
  CHECK(props(e, AL).stack().stackPaddingLeft == 16);
  CHECK(props(e, AL).stack().stackPaddingRight == 10);
  e.command(CommandId::UNDO);
  move(e, 705, 535);
  drag(e, {705, 535}, {711, 535}, MOD_ALT);
  CHECK(props(e, AL).stack().stackPaddingLeft == 16);
  CHECK(props(e, AL).stack().stackPaddingRight == 16);
  // Another selection (from the Layers panel, the pointer still): no bars, and a press there doesn't drag them.
  move(e, 775, 535);
  REQUIRE(!e.overlay().layoutBars.empty());
  e.setSelection({X});
  CHECK(e.overlay().layoutBars.empty());
  double spacing = props(e, AL).stack().stackSpacing;
  drag(e, {775, 535}, {785, 535});
  CHECK(props(e, AL).stack().stackSpacing == spacing);
}

// ---- 14. Z: the zoom tool while held ------------------------------------------------------------------------------------

TEST_CASE("r7 zoom tool: Z held — a click zooms in about the point, ⌥ out, a drag to the area; let go, back") {
  Editor e = makeEditor();
  e.setSelection({TOP});
  CHECK(e.key(KeyEvent::DOWN, KeyCode::KeyZ, 0, 0, false) == K_HANDLED);
  CHECK(e.cursor() == CursorKind::ZOOM_IN);
  click(e, 500, 400);
  CHECK(e.camera().zoom == doctest::Approx(2));
  CHECK(e.camera().toScreen({400, 300}).x == doctest::Approx(500));  // about the point
  CHECK(e.selection() == std::vector<Guid>{TOP});                    // nothing selected or moved
  click(e, 500, 400, MOD_ALT);
  CHECK(e.camera().zoom == doctest::Approx(1));
  // A drag: that area fills the view.
  drag(e, {100, 100}, {400, 400});
  CHECK(e.camera().zoom > 1.5);
  Vec2 c = e.camera().toWorld({500, 400});
  CHECK(c.x == doctest::Approx(150).epsilon(0.02));
  e.key(KeyEvent::UP, KeyCode::KeyZ, 0, 0, false);
  move(e, 10, 10);
  CHECK(e.cursor() == CursorKind::DEFAULT);
  // ⌘Z is still Undo (TS's): the engine leaves it.
  CHECK(e.key(KeyEvent::DOWN, KeyCode::KeyZ, 0, MOD_PRIMARY, false) == 0);
}

TEST_CASE("r7 view: View › Layout guides reaches the overlay (on by default)") {
  Editor e = makeEditor();
  CHECK(e.overlay().layoutGuides);
  e.setViewOptions(Editor::VIEW_PIXEL_GRID);
  CHECK(!e.overlay().layoutGuides);
}

TEST_CASE("align (round 8): ⇧-click's toParent aligns each layer within its own parent frame") {
  // R1 in F; TOP on the page (stays put); a second frame G with SR inside.
  Editor e = makeEditor({make(G, NodeType::FRAME, kPage, "#", {600, 0, 200, 100}, "Frame 4"), make(SR, NodeType::ROUNDED_RECTANGLE, G, "!", {40, 30, 20, 20}, "Rectangle 9")});
  e.setSelection({R1, SR, TOP});
  CommandArgs a;
  json::parse(R"({"toParent":true})", a.raw);
  REQUIRE(e.command(CommandId::ALIGN_RIGHT, a) == OK);
  CHECK(e.document().worldBounds(R1).right() == doctest::Approx(300));
  CHECK(e.document().worldBounds(SR).right() == doctest::Approx(800));
  CHECK(e.document().worldBounds(TOP).x == doctest::Approx(400));
  // Without it, several layers align to their selection's bounds (right edge 800).
  e.setSelection({R1, TOP});
  REQUIRE(e.command(CommandId::ALIGN_LEFT) == OK);
  CHECK(e.document().worldBounds(TOP).x == doctest::Approx(250));
}
