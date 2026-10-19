// 2026-10-20 (the owner): a layer that ignores auto layout (stackPositioning ABSOLUTE) drags like any layer in a
// plain frame — freely with the pointer, snapped with guides, Shift-constrained, ⌥-copied, its chrome kept; it stays
// its auto-layout parent's child, the flow and the sibling order untouched, no reorder (no lift, ghost or line). Out
// of the parent it goes by the ordinary reparent rule (and no longer ignores auto layout); flow children still
// reorder. docs/engine.md §8.6 "Absolute children".
#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

Editor load(std::vector<NodeChange> nodes) {
  Editor e;
  e.setSessionID(1);
  e.setViewport(1000, 800, 1, 1000, 800);
  e.loadDocument(nodes, kNoGuid);
  e.takeEvents();
  return e;
}
void down(Editor& e, double x, double y, uint32_t mods = 0) { e.pointer(PointerEvent::DOWN, x, y, 0, 1, mods); }
void up(Editor& e, double x, double y, uint32_t mods = 0) { e.pointer(PointerEvent::UP, x, y, 0, 0, mods); }
void steps(Editor& e, Vec2 from, Vec2 to, uint32_t mods = 0, int n = 8) {
  for (int i = 1; i <= n; i++) {
    double t = i / static_cast<double>(n);
    e.pointer(PointerEvent::MOVE, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, 0, 1, mods);
  }
}
Rect world(const Editor& e, Guid id) { return e.document().worldBounds(id); }

// A fixed 400 × 300 vertical auto-layout frame (padding 10, gap 20): k0, k1 (100 × 40) in the flow, and an absolute
// 20 × 20 badge at (300, 200).
const Guid F{1, 80}, B{1, 83};
const Guid K0{1, 81}, K1{1, 82};

Editor scene() {
  auto nodes = baseChanges();
  NodeChange f = make(F, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "Flow");
  StackFacet& s = f.props.stack();
  s.stackMode = StackMode::VERTICAL;
  s.stackPaddingLeft = s.stackPaddingTop = s.stackPaddingRight = s.stackPaddingBottom = 10;
  s.stackSpacing = 20;
  s.stackPrimarySizing = StackSize::FIXED;
  s.stackCounterSizing = StackSize::FIXED;
  nodes.push_back(f);
  nodes.push_back(make(K0, NodeType::ROUNDED_RECTANGLE, F, "a", {10, 10, 100, 40}, "k0"));
  nodes.push_back(make(K1, NodeType::ROUNDED_RECTANGLE, F, "b", {10, 70, 100, 40}, "k1"));
  NodeChange b = make(B, NodeType::ROUNDED_RECTANGLE, F, "c", {300, 200, 20, 20}, "badge");
  b.props.stackPositioning = StackPositioning::ABSOLUTE;
  nodes.push_back(b);
  Editor e = load(nodes);
  NodeChange touch;  // laid out once, as a panel edit would
  touch.mask = F_STACK_SPACING;
  touch.props.stack().stackSpacing = 20;
  e.setProps({F}, touch, 0);
  return e;
}

const std::vector<Guid> kOrder{K0, K1, B};

TEST_CASE("absolute drag: moves freely in its auto-layout parent, chrome kept, no reorder, flow untouched") {
  Editor e = scene();
  REQUIRE(world(e, K0) == Rect{10, 10, 100, 40});
  REQUIRE(world(e, K1) == Rect{10, 70, 100, 40});
  REQUIRE(world(e, B) == Rect{300, 200, 20, 20});
  e.setSelection({B});
  down(e, 310, 210);
  steps(e, {310, 210}, {273, 181});
  CHECK(e.document().parentOf(B) == F);
  CHECK(world(e, B) == Rect{263, 171, 20, 20});
  CHECK(e.document().children(F) == kOrder);
  CHECK(world(e, K0) == Rect{10, 10, 100, 40});
  CHECK(world(e, K1) == Rect{10, 70, 100, 40});
  Overlay o = e.overlay();
  CHECK(o.selection == std::vector<Guid>{B});
  CHECK(o.sizeBadge);
  CHECK(!o.handles);  // as any move (the handles come back at the drop)
  CHECK(o.lifted.empty());
  CHECK(o.ghosts.empty());
  CHECK(!o.hasInsertion);
  CHECK(o.dropFrame == kNoGuid);
  up(e, 273, 181);
  CHECK(e.document().parentOf(B) == F);
  CHECK(world(e, B) == Rect{263, 171, 20, 20});
  CHECK(e.document().children(F) == kOrder);
  CHECK(e.document().get(B)->props.stackPositioning == StackPositioning::ABSOLUTE);
  CHECK(e.overlay().selection == std::vector<Guid>{B});
  e.command(CommandId::UNDO);
  CHECK(world(e, B) == Rect{300, 200, 20, 20});
}

TEST_CASE("absolute drag: snaps to its siblings with guides; ⌃ off; Shift constrains") {
  Editor e = scene();
  e.setSelection({B});
  down(e, 310, 210);
  // Its left edge to 112.5: snaps to k0's right edge (110), a guide shows.
  steps(e, {310, 210}, {122.5, 210});
  CHECK(world(e, B).x == 110);
  CHECK(!e.overlay().guides.empty());
  CHECK(!e.overlay().hasInsertion);
  up(e, 122.5, 210);
  CHECK(world(e, B).x == 110);
  // ⌃: no snapping, whole pixels.
  e.setSelection({B});
  down(e, 120, 210);
  steps(e, {120, 210}, {125.4, 210}, MOD_CTRL);
  CHECK(world(e, B).x == 115);
  CHECK(e.overlay().guides.empty());
  up(e, 125.4, 210, MOD_CTRL);
  // Shift: along the larger move only.
  e.setSelection({B});
  down(e, 122, 210);
  steps(e, {122, 210}, {222, 230}, MOD_SHIFT);
  CHECK(world(e, B).y == 200);
  CHECK(world(e, B).x == 215);
  up(e, 222, 230, MOD_SHIFT);
  CHECK(e.document().children(F) == kOrder);
}

TEST_CASE("absolute drag: over a sibling frame in its parent it stays the parent's child; ⌘ nests it") {
  Editor e = scene();
  const Guid S{1, 84};
  NodeChange s = make(S, NodeType::FRAME, F, "b", {10, 130, 200, 80}, "card");
  e.applyChanges({s}, APPLY_REMOTE);
  e.setSelection({B});
  down(e, 310, 210);
  steps(e, {310, 210}, {100, 160});
  CHECK(e.document().parentOf(B) == F);
  CHECK(world(e, B) == Rect{90, 150, 20, 20});
  CHECK(!e.overlay().hasInsertion);
  up(e, 100, 160);
  CHECK(e.document().parentOf(B) == F);
  CHECK(e.document().get(B)->props.stackPositioning == StackPositioning::ABSOLUTE);
  // ⌘ held: nested into the frame under the pointer, as any layer.
  e.setSelection({B});
  down(e, 100, 160);
  steps(e, {100, 160}, {120, 170}, MOD_PRIMARY);
  CHECK(e.document().parentOf(B) == S);
  up(e, 120, 170, MOD_PRIMARY);
}

TEST_CASE("absolute drag: ⌥ copies it in place in its parent — the copy moves freely, still absolute") {
  Editor e = scene();
  e.setSelection({B});
  down(e, 310, 210, MOD_ALT);
  steps(e, {310, 210}, {350, 250}, MOD_ALT);
  REQUIRE(e.selection().size() == 1);
  const Guid copy = e.selection()[0];
  CHECK(copy != B);
  CHECK(world(e, B) == Rect{300, 200, 20, 20});
  CHECK(world(e, copy) == Rect{340, 240, 20, 20});
  Overlay o = e.overlay();
  CHECK(o.ghosts.empty());
  CHECK(!o.hasInsertion);
  up(e, 350, 250, MOD_ALT);
  CHECK(e.document().parentOf(copy) == F);
  CHECK(e.document().get(copy)->props.stackPositioning == StackPositioning::ABSOLUTE);
  CHECK(world(e, copy) == Rect{340, 240, 20, 20});
  CHECK(world(e, K0) == Rect{10, 10, 100, 40});
  CHECK(world(e, K1) == Rect{10, 70, 100, 40});
}

TEST_CASE("absolute drag: out of the parent it is the page's, an ordinary layer; a flow child still reorders") {
  Editor e = scene();
  e.setSelection({B});
  down(e, 310, 210);
  steps(e, {310, 210}, {610, 510});
  CHECK(e.document().parentOf(B) == kPage);
  up(e, 610, 510);
  CHECK(e.document().parentOf(B) == kPage);
  CHECK(world(e, B) == Rect{600, 500, 20, 20});
  CHECK(e.document().get(B)->props.stackPositioning == StackPositioning::AUTO);
  e.command(CommandId::UNDO);
  CHECK(e.document().parentOf(B) == F);
  CHECK(e.document().get(B)->props.stackPositioning == StackPositioning::ABSOLUTE);
  // Back over its parent in the same drag it still moves freely there (it still ignores auto layout).
  e.setSelection({B});
  down(e, 310, 210);
  steps(e, {310, 210}, {610, 510});
  steps(e, {610, 510}, {273, 181});
  CHECK(e.document().parentOf(B) == F);
  CHECK(!e.overlay().hasInsertion);
  CHECK(world(e, B) == Rect{263, 171, 20, 20});
  // Dropped on the page, then dragged into the frame: an ordinary layer, it joins the flow at the line.
  steps(e, {273, 181}, {610, 510});
  up(e, 610, 510);
  REQUIRE(e.document().get(B)->props.stackPositioning == StackPositioning::AUTO);
  down(e, 610, 510);
  steps(e, {610, 510}, {60, 60});
  CHECK(e.document().parentOf(B) == F);
  CHECK(e.overlay().hasInsertion);
  up(e, 60, 60);
  CHECK(e.document().get(B)->props.stackPositioning == StackPositioning::AUTO);
  CHECK(world(e, B).x == 10);
  // A flow child dragged along its flow still reorders.
  Editor g = scene();
  g.setSelection({K0});
  down(g, 60, 30);
  steps(g, {60, 30}, {60, 100});
  CHECK(!g.overlay().lifted.empty());
  up(g, 60, 100);
  CHECK(g.document().children(F) == std::vector<Guid>{K1, K0, B});
  CHECK(world(g, B) == Rect{300, 200, 20, 20});
}

}  // namespace

// The owner's absolute-multi-drag captures (2026-10-20): absolute layers in different auto-layout parents, selected
// together, move together freely — each keeps its parent, its ABSOLUTE and its offset; one undo step.
namespace {
NodeChange alFrame(Guid id, Guid parent, const char* pos, Rect r, const char* name) {
  NodeChange f = make(id, NodeType::FRAME, parent, pos, r, name);
  StackFacet& s = f.props.stack();
  s.stackMode = StackMode::VERTICAL;
  s.stackPaddingLeft = s.stackPaddingTop = s.stackPaddingRight = s.stackPaddingBottom = 10;
  s.stackSpacing = 20;
  s.stackPrimarySizing = StackSize::FIXED;
  s.stackCounterSizing = StackSize::FIXED;
  return f;
}
NodeChange absRect(Guid id, Guid parent, const char* pos, Rect r, const char* name) {
  NodeChange b = make(id, NodeType::ROUNDED_RECTANGLE, parent, pos, r, name);
  b.props.stackPositioning = StackPositioning::ABSOLUTE;
  return b;
}
}  // namespace

TEST_CASE("absolute drag: absolute layers in different auto-layout parents move together freely, keep parents") {
  // Two sibling auto-layout frames, each with a flow child and an absolute badge.
  const Guid A{1, 90}, A0{1, 91}, AB{1, 92}, C{1, 93}, C0{1, 94}, CB{1, 95};
  auto nodes = baseChanges();
  nodes.push_back(alFrame(A, kPage, "!", {0, 0, 300, 300}, "left"));
  nodes.push_back(make(A0, NodeType::ROUNDED_RECTANGLE, A, "a", {10, 10, 100, 40}, "a0"));
  nodes.push_back(absRect(AB, A, "b", {200, 200, 20, 20}, "badge"));
  nodes.push_back(alFrame(C, kPage, "\"", {400, 0, 300, 300}, "right"));
  nodes.push_back(make(C0, NodeType::ROUNDED_RECTANGLE, C, "a", {10, 10, 100, 40}, "c0"));
  nodes.push_back(absRect(CB, C, "b", {200, 200, 20, 20}, "deals"));
  Editor e = load(nodes);
  REQUIRE(world(e, AB) == Rect{200, 200, 20, 20});
  REQUIRE(world(e, CB) == Rect{600, 200, 20, 20});
  e.setSelection({AB, CB});
  down(e, 210, 210);
  steps(e, {210, 210}, {183, 171}, MOD_CTRL);
  CHECK(e.document().parentOf(AB) == A);
  CHECK(e.document().parentOf(CB) == C);
  CHECK(world(e, AB) == Rect{173, 161, 20, 20});
  CHECK(world(e, CB) == Rect{573, 161, 20, 20});
  Overlay o = e.overlay();
  CHECK(o.sizeBadge);
  CHECK(o.lifted.empty());
  CHECK(o.ghosts.empty());
  CHECK(!o.hasInsertion);
  up(e, 183, 171, MOD_CTRL);
  CHECK(e.document().parentOf(AB) == A);
  CHECK(e.document().parentOf(CB) == C);
  CHECK(e.document().get(AB)->props.stackPositioning == StackPositioning::ABSOLUTE);
  CHECK(e.document().get(CB)->props.stackPositioning == StackPositioning::ABSOLUTE);
  CHECK(world(e, AB) == Rect{173, 161, 20, 20});
  CHECK(world(e, CB) == Rect{573, 161, 20, 20});
  CHECK(world(e, A0) == Rect{10, 10, 100, 40});
  CHECK(world(e, C0) == Rect{410, 10, 100, 40});
  e.command(CommandId::UNDO);
  CHECK(world(e, AB) == Rect{200, 200, 20, 20});
  CHECK(world(e, CB) == Rect{600, 200, 20, 20});
}

TEST_CASE("absolute drag: nested auto-layout parents (badges in the card, deals in its image) move together") {
  // card (auto layout) › image (auto layout, a flow child) › deals (absolute); card › badges (absolute).
  const Guid CARD{1, 100}, IMG{1, 101}, IMG0{1, 102}, DEALS{1, 103}, BADGES{1, 104}, TXT{1, 105};
  auto nodes = baseChanges();
  nodes.push_back(alFrame(CARD, kPage, "!", {0, 0, 400, 400}, "resorts-card"));
  nodes.push_back(alFrame(IMG, CARD, "a", {10, 10, 380, 200}, "image"));
  nodes.push_back(make(IMG0, NodeType::ROUNDED_RECTANGLE, IMG, "a", {10, 10, 100, 40}, "photo"));
  nodes.push_back(absRect(DEALS, IMG, "b", {290, 140, 40, 20}, "deals"));
  nodes.push_back(make(TXT, NodeType::ROUNDED_RECTANGLE, CARD, "b", {10, 230, 100, 40}, "title"));
  nodes.push_back(absRect(BADGES, CARD, "c", {20, 300, 60, 20}, "badges"));
  Editor e = load(nodes);
  REQUIRE(world(e, DEALS) == Rect{300, 150, 40, 20});
  REQUIRE(world(e, BADGES) == Rect{20, 300, 60, 20});
  for (Vec2 to : {Vec2{70, 280}, Vec2{80, 130}}) {  // pointer over the card, then over the image
    Editor g = load(nodes);
    g.setSelection({BADGES, DEALS});
    down(g, 50, 310);
    steps(g, {50, 310}, to, MOD_CTRL);
    const double dx = to.x - 50, dy = to.y - 310;
    CHECK(g.document().parentOf(BADGES) == CARD);
    CHECK(g.document().parentOf(DEALS) == IMG);
    CHECK(world(g, BADGES) == Rect{20 + dx, 300 + dy, 60, 20});
    CHECK(world(g, DEALS) == Rect{300 + dx, 150 + dy, 40, 20});
    CHECK(g.overlay().lifted.empty());
    CHECK(!g.overlay().hasInsertion);
    up(g, to.x, to.y, MOD_CTRL);
    CHECK(g.document().parentOf(BADGES) == CARD);
    CHECK(g.document().parentOf(DEALS) == IMG);
    CHECK(g.document().get(BADGES)->props.stackPositioning == StackPositioning::ABSOLUTE);
    CHECK(g.document().get(DEALS)->props.stackPositioning == StackPositioning::ABSOLUTE);
    CHECK(world(g, BADGES) == Rect{20 + dx, 300 + dy, 60, 20});
    CHECK(world(g, DEALS) == Rect{300 + dx, 150 + dy, 40, 20});
    CHECK(world(g, IMG0) == Rect{20, 20, 100, 40});
    CHECK(world(g, TXT) == Rect{10, 230, 100, 40});
    g.command(CommandId::UNDO);
    CHECK(g.document().parentOf(DEALS) == IMG);
    CHECK(world(g, BADGES) == Rect{20, 300, 60, 20});
    CHECK(world(g, DEALS) == Rect{300, 150, 40, 20});
  }
}
