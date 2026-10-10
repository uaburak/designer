// Round 15: dragging a layer inside its own auto-layout flow, as live Figma does it (the owner's recording,
// docs/research/figma/live/behaviour/autolayout-drag.md; docs/engine.md §8.6): the reorder rule (layout/Reorder.h —
// the leading edge past a neighbour's centre; horizontal, vertical, wrapping rows), the siblings' 120 ms slides, the
// chrome, the paint lift, the drop, Esc, undo as one step, hidden and absolute children left alone.
#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"
#include "layout/Reorder.h"

using namespace eng;
using namespace eng::test;

namespace {

// ---- The rule, pure --------------------------------------------------------------------------------------------

TEST_CASE("reorder rule: vertical — the bottom edge past the next one's centre, the top edge past the previous one's") {
  reorder::Flow f;
  f.axis = 1;
  // Others laid out with the slot at 1: a at 10, slot 70 (40 high), b at 130, c at 190 (gap 20, padding 10).
  f.others = {{10, 10, 100, 40}, {10, 130, 100, 40}, {10, 190, 100, 40}};
  CHECK(reorder::step(f, 1, {10, 100, 100, 40}, 1) == 1);  // bottom 140 < b's centre 150
  CHECK(reorder::step(f, 1, {10, 110, 100, 40}, 1) == 1);  // 150: not past
  CHECK(reorder::step(f, 1, {10, 111, 100, 40}, 1) == 2);  // 151: past
  CHECK(reorder::step(f, 1, {10, 31, 100, 40}, -1) == 1);  // top 31 > a's centre 30
  CHECK(reorder::step(f, 1, {10, 29, 100, 40}, -1) == 0);
  // The pointer's direction doesn't matter when only one edge is past.
  CHECK(reorder::step(f, 1, {10, 29, 100, 40}, 1) == 0);
  // The ends: nothing before the first, nothing after the last.
  CHECK(reorder::step(f, 0, {10, -50, 100, 40}, -1) == 0);
  CHECK(reorder::step(f, 3, {10, 400, 100, 40}, 1) == 3);
}

TEST_CASE("reorder rule: horizontal; a layer larger than both neighbours goes the way it moves") {
  reorder::Flow f;
  f.axis = 0;
  // Small others (20 wide) around a 200 wide slot at x 40: a 10..30, b 250..270.
  f.others = {{10, 0, 20, 20}, {250, 0, 20, 20}};
  Rect wide{15, 0, 250, 20};  // past both centres (20 and 260)
  CHECK(reorder::step(f, 1, wide, 1) == 2);
  CHECK(reorder::step(f, 1, wide, -1) == 0);
  CHECK(reorder::step(f, 1, wide, 0) == 1);
  // Gaps and padding are in the boxes: only the centres count.
  f.others = {{100, 0, 40, 40}};
  CHECK(reorder::step(f, 0, {80, 0, 40, 40}, 1) == 0);  // right edge 120 = centre
  CHECK(reorder::step(f, 0, {81, 0, 40, 40}, 1) == 1);
}

TEST_CASE("reorder rule: wrapping rows — the row under the layer's centre, then the edge rule along it") {
  reorder::Flow f;
  f.axis = 0;
  f.wrap = true;
  // Slot at (10,10); others: k1 (70,10) / k2 (10,70) k3 (70,70), 50 square.
  f.others = {{70, 10, 50, 50}, {10, 70, 50, 50}, {70, 70, 50, 50}};
  f.slot = {10, 10, 50, 50};
  CHECK(reorder::step(f, 0, {10, 30, 50, 50}, 0) == 0);   // centre y 55: still the first row (boundary 65)
  CHECK(reorder::step(f, 0, {10, 41, 50, 50}, 0) == 2);   // centre (35, 66): second row, before k3 (centre 95)
  CHECK(reorder::step(f, 0, {80, 41, 50, 50}, 0) == 3);   // centre 105: after k3
  CHECK(reorder::step(f, 0, {50, 10, 50, 50}, 1) == 1);   // along its row: right edge 100 past k1's centre 95
  // A row's last neighbour isn't the next row's first: at the end of the first row, moving right swaps nothing.
  f.others = {{10, 10, 50, 50}, {10, 70, 50, 50}};
  f.slot = {70, 10, 50, 50};
  CHECK(reorder::step(f, 1, {100, 10, 50, 50}, 1) == 1);
  // The slot alone on a row of its own (after the others').
  f.others = {{10, 10, 50, 50}, {70, 10, 50, 50}};
  f.slot = {10, 70, 50, 50};
  CHECK(reorder::step(f, 2, {10, 70, 50, 50}, 0) == 2);
  CHECK(reorder::step(f, 2, {50, 15, 50, 50}, 0) == 1);  // up into the first row: centre 75 between 35 and 95
}

// ---- The gesture -----------------------------------------------------------------------------------------------

Editor load(std::vector<NodeChange> nodes) {
  Editor e;
  e.setSessionID(1);
  e.setViewport(1000, 800, 1, 1000, 800);
  e.loadDocument(nodes, kNoGuid);
  e.takeEvents();
  return e;
}
void down(Editor& e, double x, double y) { e.pointer(PointerEvent::DOWN, x, y, 0, 1, 0); }
void move(Editor& e, double x, double y) { e.pointer(PointerEvent::MOVE, x, y, 0, 1, 0); }
void up(Editor& e, double x, double y) { e.pointer(PointerEvent::UP, x, y, 0, 0, 0); }
void steps(Editor& e, Vec2 from, Vec2 to, int n = 8) {
  for (int i = 1; i <= n; i++) {
    double t = i / static_cast<double>(n);
    move(e, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
  }
}
Rect world(const Editor& e, Guid id) { return e.document().worldBounds(id); }

// A frame (padding 10, hugging) with four layers — 100 × 40, gap 20 (or, wrapping, 50 × 50, gap 10, 130 wide) — a
// hidden one between the second and the third and an absolute one between the third and the fourth.
const Guid V{1, 70}, HID{1, 75}, ABS{1, 76};
const Guid VK[4] = {{1, 71}, {1, 72}, {1, 73}, {1, 74}};

Editor flowScene(StackMode mode = StackMode::VERTICAL, bool wrap = false) {
  auto nodes = baseChanges();
  NodeChange f = make(V, NodeType::FRAME, kPage, "!", {0, 0, wrap ? 130.0 : 0, 0}, "Flow");
  StackFacet& s = f.props.stack();
  s.stackMode = mode;
  s.stackPaddingLeft = s.stackPaddingTop = s.stackPaddingRight = s.stackPaddingBottom = 10;
  s.stackPrimarySizing = wrap ? StackSize::FIXED : StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  s.stackCounterSizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  if (wrap) s.stackWrap = StackWrap::WRAP;
  nodes.push_back(f);
  Vec2 sz = wrap ? Vec2{50, 50} : Vec2{100, 40};
  nodes.push_back(make(VK[0], NodeType::ROUNDED_RECTANGLE, V, "a", {0, 0, sz.x, sz.y}, "k0"));
  nodes.push_back(make(VK[1], NodeType::ROUNDED_RECTANGLE, V, "b", {0, 0, sz.x, sz.y}, "k1"));
  NodeChange h = make(HID, NodeType::ROUNDED_RECTANGLE, V, "c", {5, 5, 30, 30}, "hidden");
  h.props.visible = false;
  nodes.push_back(h);
  nodes.push_back(make(VK[2], NodeType::ROUNDED_RECTANGLE, V, "d", {0, 0, sz.x, sz.y}, "k2"));
  NodeChange a = make(ABS, NodeType::ROUNDED_RECTANGLE, V, "e", {300, 300, 20, 20}, "absolute");
  a.props.stackPositioning = StackPositioning::ABSOLUTE;
  nodes.push_back(a);
  nodes.push_back(make(VK[3], NodeType::ROUNDED_RECTANGLE, V, "f", {0, 0, sz.x, sz.y}, "k3"));
  Editor e = load(nodes);
  NodeChange touch;  // laid out once, as a panel edit would
  touch.mask = F_STACK_SPACING;
  touch.props.stack().stackSpacing = wrap ? 10 : 20;
  e.setProps({V}, touch, 0);
  return e;
}

std::vector<Guid> flowOrder(const Editor& e) {
  std::vector<Guid> out;
  for (Guid c : e.document().children(V))
    if (c != HID && c != ABS) out.push_back(c);
  return out;
}

const std::vector<Guid> kStart{VK[0], VK[1], VK[2], VK[3]};

TEST_CASE("auto-layout drag: swaps at the neighbours' centres, siblings slide 120 ms, chrome, drop, one undo step") {
  Editor e = flowScene();
  REQUIRE(world(e, V) == Rect{0, 0, 120, 240});
  for (int i = 0; i < 4; i++) REQUIRE(world(e, VK[i]).y == 10 + 60 * i);
  const auto before = e.document().children(V);
  e.tick(1000);
  e.setSelection({VK[0]});
  down(e, 60, 30);
  // Its bottom edge (50 + 35) short of k1's centre (90): it moves alone (across the flow too), its chrome kept,
  // drawn above the others, no insertion line.
  steps(e, {60, 30}, {64, 65});
  CHECK(flowOrder(e) == kStart);
  CHECK(world(e, VK[0]) == Rect{14, 45, 100, 40});
  CHECK(world(e, VK[1]).y == 70);
  Overlay o = e.overlay();
  CHECK(o.lifted == std::vector<Guid>{VK[0]});
  CHECK(o.selection == std::vector<Guid>{VK[0]});
  CHECK(o.handles);
  CHECK(o.sizeBadge);
  CHECK(!o.hasInsertion);
  // Past it (95 > 90): k1 takes its place, sliding up from where it was.
  move(e, 64, 75);
  CHECK(flowOrder(e) == std::vector<Guid>{VK[1], VK[0], VK[2], VK[3]});
  CHECK(world(e, VK[1]).y == 70);  // the slide starts with the next frame
  CHECK(e.needsFrame());
  e.tick(2000);
  CHECK(world(e, VK[1]).y == 70);
  e.tick(2060);
  double mid = world(e, VK[1]).y;
  CHECK(mid < 40);  // eased out: more than half-way at half the time
  CHECK(mid > 10);
  e.tick(2120);
  CHECK(world(e, VK[1]).y == 10);
  e.rendered();
  CHECK(!e.needsFrame());
  // The chrome went at the swap; the hidden and absolute layers didn't move; the frame keeps its size.
  o = e.overlay();
  CHECK(o.selection.empty());
  CHECK(!o.sizeBadge);
  CHECK(o.lifted == std::vector<Guid>{VK[0]});
  CHECK(world(e, HID) == Rect{5, 5, 30, 30});
  CHECK(world(e, ABS) == Rect{300, 300, 20, 20});
  CHECK(world(e, V) == Rect{0, 0, 120, 240});
  // On past k2's centre (150): its bottom at 155.
  move(e, 64, 135);
  CHECK(flowOrder(e) == std::vector<Guid>{VK[1], VK[2], VK[0], VK[3]});
  // Back up to its first place: still no chrome (Figma: gone until the drop).
  steps(e, {64, 135}, {64, 30});
  CHECK(flowOrder(e) == kStart);
  CHECK(e.overlay().selection.empty());
  // Down again past k1 and k2 and dropped: in its slot at once, selected again; the others in their places.
  steps(e, {64, 30}, {60, 140});
  up(e, 60, 140);
  CHECK(flowOrder(e) == std::vector<Guid>{VK[1], VK[2], VK[0], VK[3]});
  CHECK(world(e, VK[1]).y == 10);
  CHECK(world(e, VK[2]).y == 70);
  CHECK(world(e, VK[0]) == Rect{10, 130, 100, 40});
  CHECK(world(e, VK[3]).y == 190);
  CHECK(world(e, V) == Rect{0, 0, 120, 240});
  CHECK(world(e, HID) == Rect{5, 5, 30, 30});
  CHECK(world(e, ABS) == Rect{300, 300, 20, 20});
  o = e.overlay();
  CHECK(o.selection == std::vector<Guid>{VK[0]});
  CHECK(o.lifted.empty());
  // One undo step brings everything back.
  e.command(CommandId::UNDO);
  CHECK(e.document().children(V) == before);
  for (int i = 0; i < 4; i++) CHECK(world(e, VK[i]).y == 10 + 60 * i);
}

TEST_CASE("auto-layout drag: horizontal — the last child loses its chrome on the first move; Esc puts all back") {
  Editor e = flowScene(StackMode::HORIZONTAL);
  REQUIRE(world(e, V) == Rect{0, 0, 480, 60});  // 10 + 4 × 100 + 3 × 20 + 10
  for (int i = 0; i < 4; i++) REQUIRE(world(e, VK[i]).x == 10 + 120 * i);
  // The first child keeps its chrome while it hasn't swapped.
  e.setSelection({VK[0]});
  down(e, 60, 30);
  steps(e, {60, 30}, {90, 30});
  CHECK(e.overlay().selection == std::vector<Guid>{VK[0]});
  up(e, 90, 30);
  CHECK(world(e, VK[0]).x == 10);
  // The last: gone on the first move (Figma's).
  e.setSelection({VK[3]});
  down(e, 420, 30);
  steps(e, {420, 30}, {410, 30});
  CHECK(flowOrder(e) == kStart);
  CHECK(e.overlay().selection.empty());
  // Leftwards, its left edge (259) past k2's centre (300).
  steps(e, {410, 30}, {309, 30});
  CHECK(flowOrder(e) == std::vector<Guid>{VK[0], VK[1], VK[3], VK[2]});
  e.tick(5000);
  e.tick(5050);
  // Esc: everything where it was.
  e.key(KeyEvent::DOWN, KeyCode::Escape, 0, 0, false);
  CHECK(flowOrder(e) == kStart);
  for (int i = 0; i < 4; i++) CHECK(world(e, VK[i]).x == 10 + 120 * i);
  e.tick(5200);
  CHECK(world(e, VK[2]).x == 250);
}

TEST_CASE("auto-layout drag: a wrapping flow — the row under the layer's centre, then the edge rule along it") {
  Editor e = flowScene(StackMode::HORIZONTAL, true);
  // 130 wide: two a row → k0 (10,10) k1 (70,10) / k2 (10,70) k3 (70,70).
  REQUIRE(world(e, VK[2]) == Rect{10, 70, 50, 50});
  REQUIRE(world(e, VK[3]) == Rect{70, 70, 50, 50});
  e.setSelection({VK[0]});
  down(e, 35, 35);
  steps(e, {35, 35}, {35, 97});  // its centre on the second row, left of k3's centre
  CHECK(flowOrder(e) == std::vector<Guid>{VK[1], VK[2], VK[0], VK[3]});
  e.tick(100);
  e.tick(300);
  CHECK(world(e, VK[1]) == Rect{10, 10, 50, 50});
  CHECK(world(e, VK[2]) == Rect{70, 10, 50, 50});
  CHECK(world(e, VK[3]) == Rect{70, 70, 50, 50});
  // Along its row, its right edge past k3's centre (95).
  steps(e, {35, 97}, {72, 97});
  CHECK(flowOrder(e) == std::vector<Guid>{VK[1], VK[2], VK[3], VK[0]});
  up(e, 72, 97);
  CHECK(world(e, VK[0]) == Rect{70, 70, 50, 50});
}

TEST_CASE("auto-layout drag: moving lays nothing out until a swap; dragged out, the others close up at once") {
  Editor e = flowScene();
  // Its width fills the frame ("100 Fill × 40").
  NodeChange fill;
  fill.mask = F_STACK_CHILD_ALIGN_SELF;
  fill.props.stackChildAlignSelf = StackCounterAlign::STRETCH;
  e.setProps({VK[0]}, fill, 0);
  e.setSelection({VK[0]});
  down(e, 60, 30);
  steps(e, {60, 30}, {62, 32});
  // Its own moves write only its transform: the frame isn't laid out (nothing else changes).
  e.takeEvents();
  uint64_t v = e.document().version();
  move(e, 63, 33);
  CHECK(e.document().version() == v + 1);
  CHECK(world(e, VK[1]).y == 70);
  // Out onto the page, right of the frame (round 2, live Figma): the others close up and the frame hugs them at
  // once — no slide —, the layer is the page's, without its chrome.
  steps(e, {63, 33}, {400, 33});
  CHECK(e.document().parentOf(VK[0]) == kPage);
  CHECK(world(e, VK[1]).y == 10);
  CHECK(world(e, VK[3]).y == 130);
  CHECK(world(e, V).h == 180);
  e.rendered();
  CHECK(!e.needsFrame());
  Overlay o = e.overlay();
  CHECK(o.selection.empty());
  CHECK(!o.sizeBadge);
  CHECK(o.lifted.empty());
  CHECK(o.ghosts.empty());
  CHECK(!o.hasInsertion);
  up(e, 400, 33);
  CHECK(world(e, V).h == 180);
  CHECK(world(e, VK[0]).x == 350);
  // Out of auto layout it keeps its size, fixed: no Fill to take back in.
  CHECK(e.document().get(VK[0])->props.stackChildAlignSelf != StackCounterAlign::STRETCH);
  CHECK(e.overlay().selection == std::vector<Guid>{VK[0]});
  e.command(CommandId::UNDO);
  CHECK(flowOrder(e) == kStart);
  CHECK(e.document().get(VK[0])->props.stackChildAlignSelf == StackCounterAlign::STRETCH);
}

TEST_CASE("auto-layout drag: out and back in — the line and a 30 % ghost, no space taken until the drop") {
  Editor e = flowScene();
  e.setSelection({VK[0]});
  down(e, 60, 30);
  steps(e, {60, 30}, {400, 30});
  REQUIRE(e.document().parentOf(VK[0]) == kPage);
  // Back over the frame between k2 (centre 90) and k3 (150): the frame is elsewhere now — the others stay where they
  // are, the line shows where it goes, the layer a ghost over everything, the frame and its layers outlined.
  steps(e, {400, 30}, {60, 100});
  CHECK(e.document().parentOf(VK[0]) == V);
  CHECK(world(e, VK[1]).y == 10);
  CHECK(world(e, VK[2]).y == 70);
  CHECK(world(e, VK[3]).y == 130);
  CHECK(world(e, V).h == 180);
  Overlay o = e.overlay();
  CHECK(o.hasInsertion);
  CHECK(o.insertion.a.y == 120);  // half-way between k2's bottom (110) and k3's top (130)
  CHECK(o.ghosts == std::vector<Guid>{VK[0]});
  CHECK(o.ghostOpacity == doctest::Approx(0.3));
  CHECK(o.dropFrame == V);
  CHECK(o.selection.empty());
  CHECK(o.lifted.empty());
  // Dropped: in at the line at once, the frame hugs it, selected.
  up(e, 60, 100);
  CHECK(flowOrder(e) == std::vector<Guid>{VK[1], VK[2], VK[0], VK[3]});
  CHECK(world(e, VK[0]) == Rect{10, 130, 100, 40});
  CHECK(world(e, V).h == 240);
  o = e.overlay();
  CHECK(o.ghosts.empty());
  CHECK(o.dropFrame == kNoGuid);
  CHECK(o.selection == std::vector<Guid>{VK[0]});
}

TEST_CASE("auto-layout drag: a layer from the page — ghost, line, the others still; dropped in at the line") {
  Editor e = flowScene();
  const Guid R{1, 90};
  NodeChange r = make(R, NodeType::ROUNDED_RECTANGLE, kPage, "z", {300, 300, 80, 30}, "outside");
  e.applyChanges({r}, APPLY_REMOTE);
  e.setSelection({R});
  down(e, 340, 315);
  steps(e, {340, 315}, {60, 160});
  CHECK(e.document().parentOf(R) == V);
  for (int i = 0; i < 4; i++) CHECK(world(e, VK[i]).y == 10 + 60 * i);
  Overlay o = e.overlay();
  CHECK(o.ghosts == std::vector<Guid>{R});
  CHECK(o.dropFrame == V);
  CHECK(o.hasInsertion);
  CHECK(o.insertion.a.y == 180);  // between k2 (centre 150) and k3 (210)
  up(e, 60, 160);
  std::vector<Guid> kids;
  for (Guid c : e.document().children(V))
    if (c != HID && c != ABS) kids.push_back(c);
  CHECK(kids == std::vector<Guid>{VK[0], VK[1], VK[2], R, VK[3]});
  CHECK(world(e, R) == Rect{10, 190, 80, 30});
  CHECK(world(e, VK[3]).y == 240);
}

TEST_CASE("auto-layout drag: ⌥ copies — the original stays, the copy a ghost at the line; Esc takes it back") {
  Editor e = flowScene();
  const auto before = e.document().children(V);
  e.setSelection({VK[0]});
  down(e, 60, 30);
  for (int i = 1; i <= 8; i++) e.pointer(PointerEvent::MOVE, 60, 30 + 110 * i / 8.0, 0, 1, MOD_ALT);
  REQUIRE(e.selection().size() == 1);
  const Guid copy = e.selection()[0];
  CHECK(copy != VK[0]);
  // The original and the others stay put (no slot travels); the copy is a ghost, the line between k1 and k2.
  CHECK(world(e, VK[0]).y == 10);
  for (int i = 1; i < 4; i++) CHECK(world(e, VK[i]).y == 10 + 60 * i);
  Overlay o = e.overlay();
  CHECK(o.ghosts == std::vector<Guid>{copy});
  CHECK(o.dropFrame == V);
  CHECK(o.hasInsertion);
  CHECK(o.insertion.a.y == 120);
  CHECK(o.lifted.empty());
  // Esc: no copy, nothing moved.
  e.key(KeyEvent::DOWN, KeyCode::Escape, 0, 0, false);
  CHECK(!e.document().has(copy));
  CHECK(e.document().children(V) == before);
  // Again, dropped: the copy joins at the line, the frame grows.
  e.setSelection({VK[0]});
  down(e, 60, 30);
  for (int i = 1; i <= 8; i++) e.pointer(PointerEvent::MOVE, 60, 30 + 110 * i / 8.0, 0, 1, MOD_ALT);
  const Guid copy2 = e.selection()[0];
  e.pointer(PointerEvent::UP, 60, 140, 0, 0, MOD_ALT);
  std::vector<Guid> kids;
  for (Guid c : e.document().children(V))
    if (c != HID && c != ABS) kids.push_back(c);
  CHECK(kids == std::vector<Guid>{VK[0], VK[1], copy2, VK[2], VK[3]});
  CHECK(world(e, copy2).y == 130);
  CHECK(world(e, V).h == 300);
}

TEST_CASE("auto-layout drag: several layers move as one block — together, in their order, by the block's edge") {
  Editor e = flowScene();
  e.setSelection({VK[0], VK[1]});
  e.tick(1000);
  down(e, 60, 30);
  // The block (10…110) moves down: its bottom (110 + 35) short of k2's centre (150) — nothing swaps, the chrome
  // stays, both drawn above the others.
  steps(e, {60, 30}, {60, 65});
  CHECK(flowOrder(e) == kStart);
  Overlay o = e.overlay();
  CHECK(o.lifted == std::vector<Guid>{VK[0], VK[1]});
  CHECK(o.selection.size() == 2);
  // Past it: k2 takes the block's place, sliding up; the block keeps its order.
  move(e, 60, 75);
  CHECK(flowOrder(e) == std::vector<Guid>{VK[2], VK[0], VK[1], VK[3]});
  CHECK(e.overlay().selection.empty());
  e.tick(1100);
  e.tick(1300);
  CHECK(world(e, VK[2]).y == 10);
  CHECK(world(e, VK[3]).y == 190);
  up(e, 60, 75);
  CHECK(world(e, VK[0]).y == 70);
  CHECK(world(e, VK[1]).y == 130);
  CHECK(world(e, V) == Rect{0, 0, 120, 240});
  e.command(CommandId::UNDO);
  CHECK(flowOrder(e) == kStart);
}

TEST_CASE("auto-layout drag: a selection with others between comes together at its first swap") {
  Editor e = flowScene();
  e.setSelection({VK[1], VK[3]});
  down(e, 60, 90);
  // The block spans k1…k3 (70…230) with k2 inside: up, its top edge past k0's centre (30) — both go before k0,
  // together, k2 after them.
  steps(e, {60, 90}, {60, 60});
  CHECK(flowOrder(e) == kStart);
  steps(e, {60, 60}, {60, 45});
  CHECK(flowOrder(e) == std::vector<Guid>{VK[1], VK[3], VK[0], VK[2]});
  up(e, 60, 45);
  CHECK(world(e, VK[1]).y == 10);
  CHECK(world(e, VK[3]).y == 70);
  CHECK(world(e, VK[0]).y == 130);
  CHECK(world(e, VK[2]).y == 190);
}

TEST_CASE("reorder rule: a block with others inside it — its next neighbour is the first after it") {
  reorder::Flow f;
  f.axis = 1;
  // Others a (10), b (130, inside the block), c (250); the block from 70 to 210.
  f.others = {{10, 10, 100, 40}, {10, 130, 100, 40}, {10, 250, 100, 40}};
  f.span = 1;
  CHECK(reorder::step(f, 1, {10, 70, 100, 140}, 1) == 1);   // bottom 210 < c's centre 270
  CHECK(reorder::step(f, 1, {10, 131, 100, 140}, 1) == 3);  // 271: past c — after it
  CHECK(reorder::step(f, 1, {10, 29, 100, 140}, -1) == 0);  // top past a's centre (30)
}

}  // namespace
