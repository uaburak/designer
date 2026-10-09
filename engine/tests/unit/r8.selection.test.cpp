// Round 8 — the selection and canvas audit's open items (docs/engine-build.md "Round 8 — selection"): smart selection
// reorder, the ⌥R rotation origin, the angle while rotating, Space while drawing, nudge amounts, Snap to pixel grid,
// the Scale / Slice / Comment / eyedropper tools, ruler guides and snapping to them and to layout grids, an
// auto-layout bar's value edited in place, paste placement and the view following it, pixel preview, marquees in
// sections.
#include <cmath>

#include "doctest.h"
#include "editor/Editor.h"
#include "gfx/null/NullDevice.h"
#include "render/Renderer.h"
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
Rect world(const Editor& e, Guid id) { return e.document().worldBounds(id); }

}  // namespace

// ---- 13. Smart selection: reorder by the centre rings ------------------------------------------------------------

TEST_CASE("r8 smart selection: dragging a centre ring reorders the layers, the gaps kept") {
  const Guid A{2, 1}, B{2, 2}, C{2, 3};
  // Live Figma's case: 60-wide layers 20 apart at x 500 / 580 / 660.
  NodeChange a = make(A, NodeType::ROUNDED_RECTANGLE, kPage, "$", {500, 400, 60, 60}, "S1");
  NodeChange b = make(B, NodeType::ROUNDED_RECTANGLE, kPage, "%", {580, 400, 60, 80}, "S2");
  NodeChange c = make(C, NodeType::ROUNDED_RECTANGLE, kPage, "&", {660, 400, 60, 60}, "S3");
  Editor e = makeEditor({a, b, c});
  e.setSelection({A, B, C});
  // Over S1's ring (its centre 530, 430 → screen 630, 530): lit.
  move(e, 630, 530);
  Overlay o = e.overlay();
  REQUIRE(o.centreDots.size() == 3);
  CHECK(o.centreDotHovered == 0);
  CHECK(e.cursor() == CursorKind::DEFAULT);
  // Dragged past S3's centre: S2 and S3 move left one place each, S1 lands last; the gaps stay 20.
  down(e, 630, 530);
  move(e, 680, 530);
  move(e, 740, 530);
  o = e.overlay();
  CHECK(o.centreDotHovered >= 0);
  CHECK(o.handles == false);
  move(e, 820, 530);  // its centre (720) past S3's (690)
  up(e, 820, 530);
  CHECK(world(e, B).x == 500);
  CHECK(world(e, C).x == 580);
  CHECK(world(e, A).x == 660);
  CHECK(world(e, A).y == 400);  // the cross axis kept
  CHECK(e.undoStack().undoCount() == 1);
  CHECK(e.undoStack().undoLabel() == "Reorder");
  CHECK(e.selection().size() == 3);
  e.command(CommandId::UNDO);
  CHECK(world(e, A).x == 500);
  CHECK(world(e, C).x == 660);
  // Esc mid-drag puts everything back.
  down(e, 630, 530);
  move(e, 700, 530);
  move(e, 760, 530);
  press(e, KeyCode::Escape);
  up(e, 760, 530);
  CHECK(world(e, A).x == 500);
  CHECK(world(e, B).x == 580);
}

// ---- 15. ⌥R rotation origin; the angle while rotating ------------------------------------------------------------

TEST_CASE("r8 rotation origin (236): shown at the centre, dragged (snapping to a corner), rotation turns about it") {
  Editor e = makeEditor();
  e.setSelection({TOP});  // 400..500 × 0..100 → screen 500..600 × 100..200
  CHECK((e.commandState(CommandId::SHOW_ROTATION_ORIGIN) & CMD_ENABLED) != 0);
  REQUIRE(e.command(CommandId::SHOW_ROTATION_ORIGIN) == OK);
  CHECK((e.commandState(CommandId::SHOW_ROTATION_ORIGIN) & CMD_CHECKED) != 0);
  Overlay o = e.overlay();
  REQUIRE(o.hasRotationOrigin);
  CHECK(o.rotationOrigin == Vec2{450, 50});
  // Dragged near the top-left corner: it snaps there; no undo step (a view state).
  drag(e, {550, 150}, {503, 104});
  CHECK(e.overlay().rotationOrigin == Vec2{400, 0});
  CHECK(e.undoStack().undoCount() == 0);
  CHECK(e.selection() == std::vector<Guid>{TOP});
  // Rotating from the bottom-right rotation zone: the top-left corner (the origin) stays put.
  Vec2 corner = props(e, TOP).transform.apply({0, 0});
  down(e, 606, 206);
  move(e, 590, 230);
  move(e, 560, 250);
  o = e.overlay();
  CHECK(!o.badgeText.empty());
  CHECK(o.badgeText.find("°") != std::string::npos);
  up(e, 560, 250);
  const Mat2x3& t = props(e, TOP).transform;
  CHECK(std::fabs(t.apply({0, 0}).x - corner.x) < 1e-6);
  CHECK(std::fabs(t.apply({0, 0}).y - corner.y) < 1e-6);
  CHECK(std::fabs(t.m10) > 0.1);  // it turned
  // Another selection: the origin is that one's centre again; ⌥R again hides it.
  e.setSelection({R1});
  CHECK(e.overlay().rotationOrigin == Vec2{35, 35});
  e.command(CommandId::SHOW_ROTATION_ORIGIN);
  CHECK_FALSE(e.overlay().hasRotationOrigin);
}

// ---- 25. Space while drawing ------------------------------------------------------------------------------------

TEST_CASE("r8 draw: Space held while drawing moves the shape being drawn") {
  Editor e = makeEditor();
  e.setTool(Tool::RECTANGLE);
  down(e, 700, 500);  // world 600, 400
  move(e, 720, 520);
  move(e, 750, 550);  // 50 × 50 so far
  e.key(KeyEvent::DOWN, KeyCode::Space, 0, 0, false);
  move(e, 780, 560);  // the shape follows (+30, +10)
  e.key(KeyEvent::UP, KeyCode::Space, 0, 0, false);
  move(e, 800, 580);  // then it grows again
  up(e, 800, 580);
  Guid id = e.selection().at(0);
  CHECK(world(e, id) == Rect{630, 410, 70, 70});
}

// ---- 24. Nudge amounts -------------------------------------------------------------------------------------------

TEST_CASE("r8 nudge: Preferences › Nudge amount sets the arrows' and ⇧ arrows' steps") {
  Editor e = makeEditor();
  e.setSelection({TOP});
  e.setNudge(2, 25);
  press(e, KeyCode::ArrowRight);
  CHECK(world(e, TOP).x == 402);
  press(e, KeyCode::ArrowDown, MOD_SHIFT);
  CHECK(world(e, TOP).y == 25);
  e.setNudge(0, -3);  // refused: the steps stay
  CHECK(e.nudgeSmall() == 2);
  CHECK(e.nudgeBig() == 25);
}

// ---- 16. Snap to pixel grid ---------------------------------------------------------------------------------------

TEST_CASE("r8 snap to pixel grid: on, moves land on whole px; off, they follow the pointer") {
  Editor e = makeEditor();
  e.setCamera({-1500, 100, 4});  // TOP (400..500 × 0..100) at screen 100..500 × 100..500
  e.setSelection({TOP});
  // 1.25 units right, ⌃ held once dragging (no layer snapping; at the press ⌃ would be a right-click on a Mac).
  auto nudgeDrag = [&] {
    down(e, 300, 300);
    move(e, 302, 300, MOD_CTRL);
    move(e, 305, 300, MOD_CTRL);
    up(e, 305, 300, MOD_CTRL);
  };
  nudgeDrag();
  CHECK(props(e, TOP).transform.m02 == 401);
  e.command(CommandId::UNDO);
  e.setViewOptions(e.viewOptions() & ~Editor::VIEW_SNAP_PIXELS);
  nudgeDrag();
  CHECK(props(e, TOP).transform.m02 == doctest::Approx(401.25));
}

// ---- 14. Tools -----------------------------------------------------------------------------------------------------

TEST_CASE("r8 scale tool (K): the handles scale the layer and what it holds, its properties too") {
  const Guid S{3, 1}, K1{3, 2}, T{3, 3}, AL{3, 4};
  NodeChange s = make(S, NodeType::FRAME, kPage, "$", {600, 0, 100, 100}, "Card");
  s.props.cornerRadii = {8, 8, 8, 8};
  NodeChange k = make(K1, NodeType::ROUNDED_RECTANGLE, S, "!", {10, 20, 40, 30}, "Box");
  k.props.strokeWeight = 2;
  k.props.strokePaints = {Paint::solid(Color::hex(0x000000))};
  Effect shadow;
  shadow.type = EffectType::DROP_SHADOW;
  shadow.radius = 4;
  shadow.offset = {0, 2};
  k.props.effects = {shadow};
  NodeChange t = make(T, NodeType::TEXT, S, "\"", {10, 60, 50, 14}, "Label");
  t.props.text().fontSize = 12;
  t.props.text().textAutoResize = TextAutoResize::NONE;
  t.props.text().lineHeight = {16, NumberUnits::PIXELS};
  NodeChange al = make(AL, NodeType::FRAME, S, "#", {60, 60, 30, 30}, "Stack");
  al.props.stack().stackMode = StackMode::VERTICAL;
  al.props.stack().stackSpacing = 4;
  al.props.stack().stackPaddingLeft = 5;
  Editor e = makeEditor({s, k, t, al});
  REQUIRE(e.setTool(Tool::SCALE) == OK);
  e.setSelection({S});
  // The bottom-right handle (world 700, 100 → screen 800, 200) dragged to double the size.
  drag(e, {800, 200}, {900, 300});
  CHECK(world(e, S) == Rect{600, 0, 200, 200});
  CHECK(props(e, S).cornerRadii[0] == 16);
  CHECK(world(e, K1) == Rect{620, 40, 80, 60});
  CHECK(props(e, K1).strokeWeight == 4);
  CHECK(props(e, K1).effects[0].radius == 8);
  CHECK(props(e, K1).effects[0].offset == Vec2{0, 4});
  CHECK(props(e, T).text().fontSize == 24);
  CHECK(props(e, T).text().lineHeight.value == 32);
  CHECK(props(e, AL).stack().stackSpacing == 8);
  CHECK(props(e, AL).stack().stackPaddingLeft == 10);
  CHECK(e.undoStack().undoCount() == 1);
  e.command(CommandId::UNDO);
  CHECK(world(e, K1) == Rect{610, 20, 40, 30});
  CHECK(props(e, T).text().fontSize == 12);
  // An edge handle keeps the proportions too (the Scale tool).
  drag(e, {800, 150}, {850, 150});
  CHECK(world(e, S).w == 150);
  CHECK(world(e, S).h == 150);
  // The Move tool's resize leaves the stroke alone.
  e.command(CommandId::UNDO);
  e.setTool(Tool::MOVE);
  drag(e, {800, 200}, {900, 300});
  CHECK(props(e, K1).strokeWeight == 2);
  CHECK(e.tool() == Tool::MOVE);
}

TEST_CASE("r8 slice tool (S): draws a slice with an export setting; it is hit on its edge only") {
  Editor e = makeEditor();
  REQUIRE(e.setTool(Tool::SLICE) == OK);
  drag(e, {700, 500}, {800, 600});  // world 600..700 × 400..500
  REQUIRE(e.selection().size() == 1);
  Guid sl = e.selection()[0];
  const NodeProps& p = props(e, sl);
  CHECK(p.type == NodeType::SLICE);
  CHECK(p.name == "Slice 1");
  CHECK(p.fillPaints.empty());
  CHECK(p.extra.count("exportSettings") == 1);
  CHECK(e.tool() == Tool::MOVE);
  CHECK(e.overlay().slices.size() == 1);  // View › Show slices (on)
  e.setViewOptions(e.viewOptions() & ~Editor::VIEW_SLICES);
  CHECK(e.overlay().slices.empty());
  // A click inside selects nothing (it paints nothing); on its edge, the slice.
  e.setSelection({});
  click(e, 750, 550);
  CHECK(e.selection().empty());
  click(e, 700, 550);
  CHECK(e.selection() == std::vector<Guid>{sl});
}

TEST_CASE("r8 comment and eyedropper tools: Comment is inert, the eyedropper reports the point and goes back to Move") {
  Editor e = makeEditor();
  e.setSelection({TOP});
  REQUIRE(e.setTool(Tool::COMMENT) == OK);
  move(e, 550, 150);
  CHECK(e.cursor() == CursorKind::COMMENT);
  click(e, 550, 150);
  CHECK(e.selection() == std::vector<Guid>{TOP});
  CHECK(e.undoStack().undoCount() == 0);
  press(e, KeyCode::Escape);
  CHECK(e.tool() == Tool::MOVE);
  REQUIRE(e.setTool(Tool::EYEDROPPER) == OK);
  move(e, 150, 150);
  CHECK(e.cursor() == CursorKind::EYEDROPPER);
  e.takeEvents();
  click(e, 150, 150);
  auto ev = e.takeEvents();
  REQUIRE(ev.colorPicks.size() == 1);
  CHECK(ev.colorPicks[0] == Vec2{150, 150});
  CHECK(e.tool() == Tool::MOVE);
  CHECK(e.selection() == std::vector<Guid>{TOP});  // the press picked a colour, not a layer
}

// ---- 16. Ruler guides ----------------------------------------------------------------------------------------------

TEST_CASE("r8 guides: dragged out of a ruler onto the page, moved, selected, removed; frame guides with a frame selected") {
  Editor e = makeEditor();
  // Rulers off: no guides.
  CHECK(e.startGuideDrag(1, {600, 10}, 20) == E_INVALID);
  e.setViewOptions(e.viewOptions() | Editor::VIEW_RULERS);
  // Out of the top ruler: a horizontal guide at the pointer (screen y 500 → world 400).
  REQUIRE(e.startGuideDrag(1, {600, 10}, 20) == OK);
  move(e, 600, 200);
  move(e, 600, 500);
  Overlay o = e.overlay();
  REQUIRE(o.rulerGuides.size() == 1);
  CHECK(o.rulerGuides[0].label);
  up(e, 600, 500);
  auto guides = e.guidesOf(kPage);
  REQUIRE(guides.size() == 1);
  CHECK(guides[0].axis == 1);
  CHECK(guides[0].offset == 400);
  CHECK(e.undoStack().undoCount() == 1);
  CHECK(e.undoStack().undoLabel() == "Add guide");
  // Hovering it: a resize cursor across it; a click selects it (the layers let go), ⌫ removes it.
  e.setSelection({TOP});
  move(e, 900, 501);
  CHECK(e.cursor() == CursorKind::RESIZE);
  click(e, 900, 501);
  CHECK(e.hasSelectedGuide());
  CHECK(e.selection().empty());
  CHECK(e.overlay().rulerGuides[0].active);
  // A drag moves it (another undo step).
  drag(e, {900, 501}, {900, 541});
  REQUIRE(e.guidesOf(kPage).size() == 1);
  CHECK(e.guidesOf(kPage)[0].offset == 441);
  CHECK(press(e, KeyCode::Backspace) == K_HANDLED);
  CHECK(e.guidesOf(kPage).empty());
  e.command(CommandId::UNDO);
  CHECK(e.guidesOf(kPage).size() == 1);
  // Dragged back onto its ruler: gone.
  drag(e, {900, 541}, {900, 8});
  CHECK(e.guidesOf(kPage).empty());
  // With a top-level frame selected, a vertical guide from the left ruler is the frame's, in its own space.
  e.setSelection({F});
  REQUIRE(e.startGuideDrag(0, {10, 300}, 20) == OK);
  move(e, 100, 300);
  move(e, 250, 300);
  up(e, 250, 300);
  auto fg = e.guidesOf(F);
  REQUIRE(fg.size() == 1);
  CHECK(fg[0].axis == 0);
  CHECK(fg[0].offset == 150);
  // Rulers off: hidden, not snapped to.
  e.setViewOptions(e.viewOptions() & ~Editor::VIEW_RULERS);
  CHECK(e.overlay().rulerGuides.empty());
}

TEST_CASE("r8 snapping: a moving layer snaps to a ruler guide and to its frame's layout grid") {
  Editor e = makeEditor();
  e.setViewOptions(e.viewOptions() | Editor::VIEW_RULERS);
  REQUIRE(e.startGuideDrag(0, {10, 600}, 20) == OK);
  move(e, 300, 600);
  move(e, 803, 600);  // world x 703
  up(e, 803, 600);
  REQUIRE(e.guidesOf(kPage).size() == 1);
  // TOP (400..500) dragged right by 201: its right edge 701 → 703, the guide.
  e.setSelection({TOP});
  drag(e, {550, 150}, {751, 150});
  CHECK(world(e, TOP).x == 603);
  // A frame's columns: R1 moved near a column's edge snaps to it.
  NodeChange grid = NodeChange::changed(F);
  grid.mask = F_LAYOUT_GRIDS;
  LayoutGrid cols;
  cols.type = LayoutGridType::STRETCH;
  cols.axis = Axis::X;
  cols.numSections = 3;
  cols.offset = 0;
  cols.gutterSize = 30;
  cols.visible = true;
  cols.color = Color{1, 0, 0, 0.1f};
  grid.props.rare().layoutGrids = {cols};
  e.applyChanges({grid}, APPLY_REMOTE);
  // Columns 80 wide (300 − 2 × 30) / 3, 30 apart: edges at 80, 110, 190, 220.
  e.setSelection({R1});
  drag(e, {135, 135}, {157, 135}, 0);  // R1 10..60 → 32..82: its right edge snaps to 80
  CHECK(world(e, R1).x == 30);
}

// ---- 17. Auto layout: a click on a bar edits its value ------------------------------------------------------------

TEST_CASE("r8 auto layout: a click on a padding or gap bar asks to edit its value in place") {
  const Guid AL{4, 1}, X{4, 2}, Y{4, 3};
  NodeChange f = make(AL, NodeType::FRAME, kPage, "$", {600, 400, 150, 70}, "Auto");
  f.props.stack().stackMode = StackMode::HORIZONTAL;
  f.props.stack().stackPrimarySizing = StackSize::FIXED;
  f.props.stack().stackSpacing = 30;
  f.props.stack().stackPaddingLeft = f.props.stack().stackPaddingTop = f.props.stack().stackPaddingRight = f.props.stack().stackPaddingBottom = 10;
  NodeChange x = make(X, NodeType::ROUNDED_RECTANGLE, AL, "!", {10, 10, 50, 50});
  NodeChange y = make(Y, NodeType::ROUNDED_RECTANGLE, AL, "\"", {90, 10, 50, 50});
  Editor e = makeEditor({f, x, y});
  e.setSelection({AL});
  move(e, 775, 535);  // over the gap
  e.takeEvents();
  click(e, 775, 535);
  auto ev = e.takeEvents();
  REQUIRE(ev.inlineEdits.size() == 1);
  CHECK(ev.inlineEdits[0].node == AL);
  CHECK(ev.inlineEdits[0].field == "GAP");
  CHECK(ev.inlineEdits[0].value == 30);
  CHECK(ev.inlineEdits[0].rect.w > 0);
  CHECK(e.undoStack().undoCount() == 0);
  CHECK(e.selection() == std::vector<Guid>{AL});
  move(e, 705, 535);  // the left padding
  click(e, 705, 535);
  ev = e.takeEvents();
  REQUIRE(ev.inlineEdits.size() == 1);
  CHECK(ev.inlineEdits[0].field == "PADDING_LEFT");
  CHECK(ev.inlineEdits[0].value == 10);
}

// ---- 18. Paste placement ---------------------------------------------------------------------------------------------

TEST_CASE("r8 paste: a frame far from the view → the view's middle; just outside → into it, the view follows; larger → zoomed out") {
  const Guid FAR{5, 1}, NEAR{5, 2}, BIG{5, 3};
  NodeChange far = make(FAR, NodeType::FRAME, kPage, "$", {5000, 5000, 300, 300}, "Far");
  NodeChange near = make(NEAR, NodeType::FRAME, kPage, "%", {950, 0, 300, 300}, "Near");
  NodeChange big = make(BIG, NodeType::ROUNDED_RECTANGLE, kPage, "&", {0, 1000, 3000, 2000}, "Big");
  Editor e = makeEditor({far, near, big});
  // The view: world −100..900 × −100..700.
  e.setSelection({R1});
  Clipboard clip;
  REQUIRE(e.copySelection(clip));
  e.setSelection({FAR});
  REQUIRE(e.paste(clip, false) == 1);
  Guid p1 = e.selection()[0];
  CHECK(e.document().parentOf(p1) == kPage);
  CHECK(world(e, p1) == Rect{375, 275, 50, 50});
  // Just outside the view (950 > 900): into it at R1's place there, and the view moves to show it.
  e.setSelection({NEAR});
  REQUIRE(e.paste(clip, false) == 1);
  Guid p2 = e.selection()[0];
  CHECK(e.document().parentOf(p2) == NEAR);
  CHECK(world(e, p2) == Rect{960, 10, 50, 50});
  Vec2 a = e.camera().toWorld({0, 0}), b = e.camera().toWorld({1000, 800});
  CHECK(Rect::fromPoints(a, b).containsRect(world(e, p2)));
  CHECK(e.camera().zoom == 1);
  // Larger than the view: zoomed out to show all of it.
  e.setCamera({100, 100, 1});
  e.setSelection({BIG});
  Clipboard bigClip;
  REQUIRE(e.copySelection(bigClip));
  e.setSelection({});
  e.setCamera({-1000, -1500, 1});  // the original (0..3000 × 1000..3000) in view, partly
  REQUIRE(e.paste(bigClip, false) == 1);
  CHECK(e.camera().zoom < 1);
  a = e.camera().toWorld({0, 0}), b = e.camera().toWorld({1000, 800});
  Rect shown = Rect::fromPoints(a, b), pasted = world(e, e.selection()[0]);
  CHECK(shown.x <= pasted.x + 1);
  CHECK(shown.right() >= pasted.right() - 1);
  CHECK(shown.y <= pasted.y + 1);
  CHECK(shown.bottom() >= pasted.bottom() - 1);
}

TEST_CASE("r8 paste over selection (⇧⌘V): on top of the selection at its position, not into it") {
  Editor e = makeEditor();
  e.setSelection({R1});
  Clipboard clip;
  REQUIRE(e.copySelection(clip));
  e.setSelection({TOP});
  REQUIRE(e.pasteWith(clip, PASTE_OVER) == 1);
  Guid p = e.selection()[0];
  CHECK(e.document().parentOf(p) == kPage);
  CHECK(world(e, p).x == 400);
  CHECK(world(e, p).y == 0);
  const auto& kids = e.document().children(kPage);
  CHECK(std::find(kids.begin(), kids.end(), p) - std::find(kids.begin(), kids.end(), TOP) == 1);
}

// ---- Pixel preview ------------------------------------------------------------------------------------------------

TEST_CASE("r8 pixel preview: the view option reaches the overlay; the renderer draws through its 1x target when zoomed in") {
  Editor e = makeEditor();
  CHECK(e.overlay().pixelPreview == 0);
  e.setViewOptions(e.viewOptions() | Editor::VIEW_PIXEL_PREVIEW);
  CHECK(e.overlay().pixelPreview == 1);
  e.setViewOptions((e.viewOptions() & ~Editor::VIEW_PIXEL_PREVIEW) | Editor::VIEW_PIXEL_PREVIEW_2X);
  CHECK(e.overlay().pixelPreview == 2);
  gfx::NullDevice device;
  Renderer r(device);
  r.setTextLayouts(&e);
  e.setCamera({0, 0, 4});
  RenderStats s = r.render(e.document(), e.page(), e.camera(), e.viewport(), e.overlay(), OverlayStyle::of(Theme::Dark));
  CHECK(s.shapes > 0);
  // At 100 % on a 2x screen with 2x preview there is nothing to scale: drawn as usual.
  e.setCamera({0, 0, 1});
  s = r.render(e.document(), e.page(), e.camera(), e.viewport(), e.overlay(), OverlayStyle::of(Theme::Dark));
  CHECK(s.shapes > 0);
}

// ---- 19. Marquee in sections ---------------------------------------------------------------------------------------

TEST_CASE("r8 marquee: over part of a frame inside a section, that frame's children") {
  const Guid S{6, 1}, SF{6, 2}, A{6, 3}, B{6, 4};
  NodeChange sec = make(S, NodeType::SECTION, kPage, "$", {0, 400, 800, 400}, "Section");
  NodeChange sf = make(SF, NodeType::FRAME, S, "!", {50, 50, 300, 300}, "Card");
  NodeChange a = make(A, NodeType::ROUNDED_RECTANGLE, SF, "!", {10, 10, 40, 40}, "A");
  NodeChange b = make(B, NodeType::ROUNDED_RECTANGLE, SF, "\"", {200, 200, 40, 40}, "B");
  Editor e = makeEditor({sec, sf, a, b});
  // From empty canvas left of the section over A only (world −50..120 × 430..520).
  drag(e, {50, 530}, {220, 620});
  CHECK(e.selection() == std::vector<Guid>{A});
}

// ---- 20. Locked layers -----------------------------------------------------------------------------------------------

TEST_CASE("r8 locked: a locked top-level layer takes no click — it reaches the layer under it; Select layer ▸ lists both") {
  const Guid U{7, 1}, O{7, 2};
  NodeChange under = make(U, NodeType::ROUNDED_RECTANGLE, kPage, "$", {600, 400, 120, 80}, "Under");
  NodeChange over = make(O, NodeType::ROUNDED_RECTANGLE, kPage, "%", {640, 420, 120, 80}, "Over");
  over.props.locked = true;
  Editor e = makeEditor({under, over});
  click(e, 760, 540);  // world (660, 440): both
  CHECK(e.selection() == std::vector<Guid>{U});
  e.setSelection({});
  e.takeEvents();
  e.pointer(PointerEvent::DOWN, 760, 540, 2, 2, 0);
  e.pointer(PointerEvent::UP, 760, 540, 2, 0, 0);  // the menu opens on the release (round 9: Right-click and drag to pan)
  auto ev = e.takeEvents();
  REQUIRE(ev.contextMenus.size() == 1);
  CHECK(ev.contextMenus[0].hits.size() == 2);
  CHECK(e.selection() == std::vector<Guid>{U});
}
