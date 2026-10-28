// Group 1 of the 2026-10-18 comparison (docs/research/compare-2026-10-18/STATUS-2026-10-19.md "As built (Group 1)"):
// the canvas chrome's behaviour changes — a layer dragged out of its auto-layout flow stays in it while it overlaps
// the frame, an ⌥-copy off the frame measures to its original, a grid child shows its grid's cells, a selected section
// has no `</>`, the context menu keeps the smart selection's handles, a pressed layer keeps its hover outline, the AI
// sparkle by the selection, a quarter-turned frame's name level, a hovered parent dots its other layers.
#include <algorithm>
#include <cmath>

#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "gfx/null/NullDevice.h"
#include "render/FrameTitles.h"
#include "render/Renderer.h"

using namespace eng;
using namespace eng::test;

namespace {

constexpr double kPi = 3.14159265358979323846;

Editor load(std::vector<NodeChange> nodes, double zoom = 1) {
  Editor e;
  e.setSessionID(1);
  e.setViewport(1000, 800, 1, 1000, 800);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({0, 0, zoom});
  e.takeEvents();
  return e;
}
void down(Editor& e, double x, double y, uint32_t mods = 0, int button = 0) { e.pointer(PointerEvent::DOWN, x, y, button, 1, mods); }
void move(Editor& e, double x, double y, uint32_t mods = 0) { e.pointer(PointerEvent::MOVE, x, y, 0, 1, mods); }
void up(Editor& e, double x, double y, uint32_t mods = 0) { e.pointer(PointerEvent::UP, x, y, 0, 0, mods); }
void steps(Editor& e, Vec2 from, Vec2 to, uint32_t mods = 0, int n = 8) {
  for (int i = 1; i <= n; i++) {
    double t = i / static_cast<double>(n);
    move(e, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, mods);
  }
}

// A vertical auto-layout frame at (200, 0): padding 10, gap 20, three 100 × 40 layers (hugging: 120 × 180).
const Guid V{1, 70};
const Guid VK[3] = {{1, 71}, {1, 72}, {1, 73}};
std::vector<NodeChange> flow() {
  auto nodes = baseChanges();
  NodeChange f = make(V, NodeType::FRAME, kPage, "!", {200, 0, 0, 0}, "Flow");
  StackFacet& s = f.props.stack();
  s.stackMode = StackMode::VERTICAL;
  s.stackPaddingLeft = s.stackPaddingTop = s.stackPaddingRight = s.stackPaddingBottom = 10;
  s.stackSpacing = 20;
  s.stackPrimarySizing = s.stackCounterSizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  nodes.push_back(f);
  const char* pos[3] = {"a", "b", "c"};
  for (int i = 0; i < 3; i++) nodes.push_back(make(VK[i], NodeType::ROUNDED_RECTANGLE, V, pos[i], {10, 10 + 60.0 * i, 100, 40}, "k"));
  return nodes;
}
Editor flowScene() {
  Editor e = load(flow());
  NodeChange touch;
  touch.mask = F_STACK_SPACING;
  touch.props.stack().stackSpacing = 20;
  e.setProps({V}, touch, 0);
  return e;
}

}  // namespace

TEST_CASE("g1 drag-out: a layer stays in its auto-layout frame (its slot kept) while its box overlaps the frame") {
  Editor e = flowScene();
  REQUIRE(e.document().worldBounds(V) == Rect{200, 0, 120, 180});
  e.setSelection({VK[0]});
  // Grabbed at its middle (260, 30), dragged left: the pointer leaves the frame at x 200 — the layer (210..310 at the
  // start) still overlaps it until the pointer is past x 150.
  move(e, 260, 30);
  down(e, 260, 30);
  steps(e, {260, 30}, {185, 32});
  CHECK(e.document().parentOf(VK[0]) == V);
  CHECK(e.document().worldBounds(VK[1]).y == 70);  // the others keep their places
  Overlay o = e.overlay();
  CHECK(o.selection == std::vector<Guid>{VK[0]});  // its chrome stays
  CHECK(o.sizeBadge);
  // Clear of the frame: the page's, the others close up.
  steps(e, {185, 32}, {140, 32});
  CHECK(e.document().parentOf(VK[0]) == kPage);
  CHECK(e.document().worldBounds(VK[1]).y == 10);
  up(e, 140, 32);
}

TEST_CASE("g1 alt-copy: off the auto-layout frame, the copy measures to the layer it was copied from") {
  Editor e = flowScene();
  e.setSelection({VK[0]});
  move(e, 260, 30, MOD_ALT);
  down(e, 260, 30, MOD_ALT);
  steps(e, {260, 30}, {60, 34}, MOD_ALT);
  REQUIRE(e.document().parentOf(e.selection().empty() ? kNoGuid : e.selection()[0]) == kPage);
  Overlay o = e.overlay();
  CHECK(o.measureTarget == VK[0]);
  CHECK(!o.measures.empty());
  up(e, 60, 34, MOD_ALT);
  // Dropped: the distances go with the gesture.
  move(e, 600, 600);
  CHECK(e.overlay().measureTarget == kNoGuid);
}

TEST_CASE("g1 grid: a selected grid child shows its grid's cells (nothing else of the grid's chrome)") {
  const Guid G{1, 30}, K{1, 31};
  auto nodes = baseChanges();
  NodeChange grid = make(G, NodeType::FRAME, kPage, "!", {0, 0, 320, 200}, "AL_grid");
  grid.props.stack().stackMode = StackMode::GRID;
  nodes.push_back(grid);
  nodes.push_back(make(K, NodeType::ROUNDED_RECTANGLE, G, "a", {0, 0, 60, 40}, "item"));
  Editor e = load(nodes);
  e.setSelection({K});
  move(e, 30, 20);
  Overlay o = e.overlay();
  CHECK(!o.gridCells.empty());
  CHECK(o.gridPills.empty());
}

TEST_CASE("g1 section: a selected section shows no `</>`; a frame does") {
  const Guid S{1, 20}, F{1, 21};
  auto nodes = baseChanges();
  nodes.push_back(make(S, NodeType::SECTION, kPage, "a", {0, 300, 500, 300}, "Section"));
  nodes.push_back(make(F, NodeType::FRAME, kPage, "b", {0, 0, 300, 200}, "Frame"));
  Editor e = load(nodes);
  auto buttonOn = [&](Guid id) {
    for (const DevStatusMark& m : e.overlay().dev.statuses)
      if (m.frame == id && m.kind == DevStatusMark::Kind::MarkButton) return true;
    return false;
  };
  e.setSelection({S});
  CHECK(!buttonOn(S));
  e.setSelection({F});
  CHECK(buttonOn(F));
}

TEST_CASE("g1 smart selection: a context menu opened on it keeps the rings and gap handles past the pointer's leave") {
  const Guid A{1, 1}, B{1, 2}, C{1, 3};
  auto nodes = baseChanges();
  nodes.push_back(make(A, NodeType::ROUNDED_RECTANGLE, kPage, "a", {0, 0, 60, 60}, "S1"));
  nodes.push_back(make(B, NodeType::ROUNDED_RECTANGLE, kPage, "b", {80, 0, 60, 60}, "S2"));
  nodes.push_back(make(C, NodeType::ROUNDED_RECTANGLE, kPage, "c", {160, 0, 60, 60}, "S3"));
  Editor e = load(nodes);
  e.setSelection({A, B, C});
  move(e, 30, 30);
  REQUIRE(!e.overlay().gapHandles.empty());
  REQUIRE(!e.overlay().centreDotsIdle);
  down(e, 30, 30, 0, 2);  // the right button: the context menu (on its release when a right drag pans)
  e.pointer(PointerEvent::UP, 30, 30, 2, 0, 0);
  REQUIRE(!e.takeEvents().contextMenus.empty());
  e.pointer(PointerEvent::LEAVE, 30, 30, 0, 0, 0);
  CHECK(!e.overlay().gapHandles.empty());
  CHECK(!e.overlay().centreDotsIdle);
  // Without the menu, a leave takes them away.
  move(e, 30, 30);
  e.pointer(PointerEvent::LEAVE, 30, 30, 0, 0, 0);
  CHECK(e.overlay().gapHandles.empty());
}

TEST_CASE("g1 press: a pressed layer keeps its hover outline until it moves") {
  Editor e = flowScene();
  move(e, 260, 30);
  down(e, 260, 30);
  Overlay o = e.overlay();
  CHECK(std::find(o.hover.begin(), o.hover.end(), VK[0]) != o.hover.end());
  up(e, 260, 30);
}

TEST_CASE("g1 AI sparkle: none by the selection (the owner, 2026-10-28), whatever the pointer does") {
  const Guid R{1, 5};
  auto nodes = baseChanges();
  nodes.push_back(make(R, NodeType::ROUNDED_RECTANGLE, kPage, "a", {100, 100, 120, 90}, "Rect"));
  Editor e = load(nodes);
  gfx::NullDevice device;
  Renderer r{device};
  e.setSelection({R});
  move(e, 150, 150);
  CHECK(!e.overlay().aiButton);
  r.render(e.document(), e.page(), e.camera(), e.viewport(), e.overlay(), OverlayStyle::of(Theme::Dark));
  e.setCanvasHits(r.canvasHits());
  CHECK(r.canvasHits().aiButton.w == 0);
  move(e, 236.5, 116.5);
  e.takeEvents();
  down(e, 236.5, 116.5);
  CHECK(e.takeEvents().aiButtons.empty());
}

TEST_CASE("g1 a quarter-turned frame's name stays level above its on-screen top-left corner") {
  const Guid F{1, 1};
  auto nodes = baseChanges();
  NodeChange f = make(F, NodeType::FRAME, kPage, "a", {0, 0, 300, 100}, "Frame 406");
  f.props.transform = Mat2x3::translate(100, 400) * Mat2x3::rotate(-kPi / 2);  // Figma's 90°: its top edge on the left
  nodes.push_back(f);
  Editor e = load(nodes);
  for (const FrameTitle& t : e.titles()) {
    if (t.id != F) continue;
    CHECK(t.upright);
    Rect aabb = transformedBounds(f.props.transform, 300, 100);
    CHECK(t.frame.x == doctest::Approx(aabb.x));
    CHECK(t.text.x == doctest::Approx(aabb.x));
    CHECK(t.baseline < aabb.y);
  }
}

TEST_CASE("g1 a hovered auto-layout frame whose layer is selected: its other layers dotted") {
  Editor e = flowScene();
  e.setSelection({VK[2]});
  move(e, 205, 90);  // the frame's left padding
  Overlay o = e.overlay();
  REQUIRE(o.hover == std::vector<Guid>{V});
}

namespace {

// The owner's report (live Figma docs/research/figma/live/2026-10-18/autolayout-drag-frames.txt, scaled down): a
// wrapping horizontal auto-layout frame, 320 wide, gap 10, holding nine 100 × 120 children — frames, each a vertical
// auto-layout frame with a 50 × 50 rectangle (or rectangles) — and a loose rectangle on the page.
const Guid GRIDF{1, 100}, LOOSE{1, 199};
Guid cell(int i) { return Guid{1, static_cast<uint32_t>(101 + i)}; }
Guid inner(int i) { return Guid{1, static_cast<uint32_t>(151 + i)}; }
Editor wrapScene(bool frames) {
  auto nodes = baseChanges();
  NodeChange g = make(GRIDF, NodeType::FRAME, kPage, "!", {0, 0, 320, 0}, "test-Frame");
  StackFacet& s = g.props.stack();
  s.stackMode = StackMode::HORIZONTAL;
  s.stackWrap = StackWrap::WRAP;
  s.stackSpacing = 10;
  s.stackCounterSpacing = 10;
  s.stackPrimarySizing = StackSize::FIXED;
  s.stackCounterSizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  nodes.push_back(g);
  for (int i = 0; i < 9; i++) {
    std::string pos(1, static_cast<char>('a' + i));
    NodeChange c = make(cell(i), frames ? NodeType::FRAME : NodeType::ROUNDED_RECTANGLE, GRIDF, pos, {0, 0, 100, 120}, "c" + std::to_string(i));
    if (frames) {
      c.props.stack().stackMode = StackMode::VERTICAL;
      c.props.stack().stackPrimarySizing = c.props.stack().stackCounterSizing = StackSize::FIXED;
    }
    nodes.push_back(c);
    if (frames) nodes.push_back(make(inner(i), NodeType::ROUNDED_RECTANGLE, cell(i), "a", {0, 0, 50, 50}, "r" + std::to_string(i)));
  }
  nodes.push_back(make(LOOSE, NodeType::ROUNDED_RECTANGLE, kPage, "~", {600, 0, 40, 40}, "loose"));
  Editor e = load(nodes);
  NodeChange touch;
  touch.mask = F_STACK_SPACING;
  touch.props.stack().stackSpacing = 10;
  e.setProps({GRIDF}, touch, 0);
  return e;
}
std::vector<Guid> cells(const Editor& e) {
  std::vector<Guid> out;
  for (Guid c : e.document().children(GRIDF)) out.push_back(c);
  return out;
}

}  // namespace

TEST_CASE("g1 a frame dragged inside its wrapping auto-layout parent reorders and never goes into a sibling frame") {
  for (bool frames : {true, false}) {
    CAPTURE(frames);
    Editor e = wrapScene(frames);
    REQUIRE(e.document().worldBounds(cell(4)) == Rect{110, 130, 100, 120});
    e.setSelection({cell(0)});
    // From its middle (50, 60) to the middle of the fifth (160, 190), over its rectangle when it is a frame.
    move(e, 50, 60);
    down(e, 50, 60);
    steps(e, {50, 60}, {160, 190}, 0, 16);
    CHECK(e.document().parentOf(cell(0)) == GRIDF);
    up(e, 160, 190);
    CHECK(e.document().parentOf(cell(0)) == GRIDF);
    std::vector<Guid> order = cells(e);
    REQUIRE(order.size() == 9);
    CHECK(order[0] == cell(1));
    CHECK(std::find(order.begin(), order.end(), cell(0)) - order.begin() >= 3);
    if (frames) CHECK(e.document().children(cell(4)).size() == 1);  // nothing went into the sibling
  }
}

TEST_CASE("g1 a layer from outside the auto-layout flow still drops into a frame under the pointer") {
  Editor e = wrapScene(true);
  e.setSelection({LOOSE});
  move(e, 620, 20);
  down(e, 620, 20);
  steps(e, {620, 20}, {160, 190}, 0, 16);
  up(e, 160, 190);
  CHECK(e.document().parentOf(LOOSE) == cell(4));
}

TEST_CASE("g1 a section or frame with an empty name shows no label (no pill, nothing to press); its children keep theirs") {
  const Guid S{1, 30}, F{1, 31}, B{1, 32}, C{1, 33};
  auto nodes = baseChanges();
  auto unnamed = [](NodeChange c) {  // make() names a nameless layer after its type
    c.props.name.clear();
    return c;
  };
  nodes.push_back(unnamed(make(S, NodeType::SECTION, kPage, "a", {0, 300, 500, 300})));
  nodes.push_back(make(C, NodeType::FRAME, S, "a", {20, 40, 200, 100}, "Inside"));
  nodes.push_back(unnamed(make(F, NodeType::FRAME, kPage, "b", {0, 0, 300, 200})));
  nodes.push_back(make(B, NodeType::SECTION, kPage, "c", {600, 0, 300, 200}, "  "));
  Editor e = load(nodes);
  bool inside = false;
  for (const FrameTitle& t : e.titles()) {
    CHECK(t.id != S);
    CHECK(t.id != F);
    CHECK(t.id != B);
    inside |= t.id == C;
  }
  CHECK(inside);
}
