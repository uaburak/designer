// Round 17 — canvas feedback (the owner's requests, live Figma 68–71.png):
// - haptics from canvas drags: a HAPTIC tick when a drag changes its value by a whole step (corner radius, padding,
//   gap, W / H, a whole degree), one per auto-layout swap, one on snapping to a new guide; none for sub-unit moves,
//   at most one per pointer move;
// - a frame's name turns the selection's blue while the frame is hovered (its name or its body), components purple.
#include <cmath>
#include <functional>

#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid R{17, 1}, X{17, 2}, Y{17, 3}, AL{17, 4}, K0{17, 5}, K1{17, 6}, K2{17, 7};

Editor load(std::vector<NodeChange> nodes) {
  Editor e;
  e.setSessionID(1);
  e.setViewport(1000, 800, 1, 1000, 800);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({100, 100, 1});  // the page origin at (100, 100) on screen
  e.takeEvents();
  return e;
}

// A rectangle R 200 × 100 at the page origin (screen 100..300 × 100..200).
Editor rectScene() {
  auto nodes = baseChanges();
  NodeChange r = make(R, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 200, 100}, "R");
  r.props.fillPaints = {Paint::solid(Color{0.85f, 0.85f, 0.85f, 1})};
  nodes.push_back(r);
  return load(nodes);
}

void down(Editor& e, Vec2 s, uint32_t mods = 0) { e.pointer(PointerEvent::DOWN, s.x, s.y, 0, 1, mods, 1); }
void move(Editor& e, Vec2 s, uint32_t mods = 0) { e.pointer(PointerEvent::MOVE, s.x, s.y, 0, 1, mods); }
void up(Editor& e, Vec2 s, uint32_t mods = 0) { e.pointer(PointerEvent::UP, s.x, s.y, 0, 0, mods); }
const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }

// Drags from `from` through `n` equal steps to `to`, reading `value` after each move: every move that changed it by
// a whole step ticks once, every other move none. Returns the ticks.
uint32_t dragCounting(Editor& e, Vec2 from, Vec2 to, int n, const std::function<double()>& value, uint32_t mods = 0) {
  move(e, from, mods);
  down(e, from, mods);
  e.takeEvents();
  uint32_t ticks = 0;
  double last = value();
  for (int i = 1; i <= n; i++) {
    double t = i / static_cast<double>(n);
    move(e, {from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t}, mods);
    uint32_t got = e.takeEvents().haptics;
    double now = value();
    CHECK(got == (std::round(now) != std::round(last) ? 1u : 0u));
    ticks += got;
    last = now;
  }
  up(e, to, mods);
  return ticks;
}

}  // namespace

TEST_CASE("r17 haptics: a corner radius drag ticks once per whole step, none between, one for a jump") {
  Editor e = rectScene();
  e.setSelection({R});
  move(e, {200, 150});
  REQUIRE(e.overlay().radiusHandles.size() == 4);
  // Along the diagonal by quarter pixels: the radius goes 0 → 10 by whole numbers, 40 moves, 10 ticks.
  uint32_t ticks = dragCounting(e, {112, 112}, {122, 122}, 40, [&] { return props(e, R).cornerRadii[0]; });
  CHECK(props(e, R).cornerRadii[0] == 10);
  CHECK(ticks == 10);
  // A jump of several steps in one move: one tick.
  move(e, {200, 150});
  Overlay o = e.overlay();
  REQUIRE(o.radiusHandles.size() == 4);
  const Vec2 h{o.radiusHandles[0].x + 100, o.radiusHandles[0].y + 100};  // world → screen
  ticks = dragCounting(e, h, {h.x + 10, h.y + 10}, 1, [&] { return props(e, R).cornerRadii[0]; });
  CHECK(props(e, R).cornerRadii[0] == 20);
  CHECK(ticks == 1);
}

TEST_CASE("r17 haptics: resize ticks per whole unit of W or H; rotate per whole degree") {
  Editor e = rectScene();
  e.setSelection({R});
  // The right edge by quarter pixels: W 200 → 210.
  uint32_t ticks = dragCounting(e, {300, 150}, {310, 150}, 40, [&] { return props(e, R).size.x; });
  CHECK(props(e, R).size.x == 210);
  CHECK(ticks == 10);
  CHECK(e.undoStack().undoCount() == 1);
  // Rotation from just outside the bottom-right corner (310, 200), turning about the centre (205, 150) by 0.25° steps
  // to 10°: ten whole degrees, ten ticks.
  const Vec2 c{205, 150}, p0{318, 208};
  const Vec2 a = p0 - c;
  double r = a.length(), a0 = std::atan2(a.y, a.x);
  move(e, p0);
  down(e, p0);
  e.takeEvents();
  uint32_t turned = 0;
  for (int i = 1; i <= 40; i++) {
    double ang = a0 + (i * 0.25) * 3.14159265358979323846 / 180;
    move(e, {c.x + r * std::cos(ang), c.y + r * std::sin(ang)});
    turned += e.takeEvents().haptics;
  }
  up(e, {c.x + r * std::cos(a0 + 10 * 3.14159265358979323846 / 180), c.y + r * std::sin(a0 + 10 * 3.14159265358979323846 / 180)});
  const Mat2x3& m = props(e, R).transform;
  CHECK(std::atan2(m.m10, m.m00) * 180 / 3.14159265358979323846 == doctest::Approx(10).epsilon(0.001));
  CHECK(turned == 10);
}

namespace {

// A horizontal auto-layout frame 320 × 100 at the page origin, padding 20 / 10, gap 20, three 80 × 80 layers.
Editor flowScene() {
  auto nodes = baseChanges();
  NodeChange f = make(AL, NodeType::FRAME, kPage, "!", {0, 0, 320, 100}, "Auto");
  StackFacet& st = f.props.stack();
  st.stackMode = StackMode::HORIZONTAL;
  st.stackPrimarySizing = StackSize::FIXED;
  st.stackCounterSizing = StackSize::FIXED;
  st.stackSpacing = 20;
  st.stackPaddingLeft = st.stackPaddingRight = 20;
  st.stackPaddingTop = st.stackPaddingBottom = 10;
  nodes.push_back(f);
  nodes.push_back(make(K0, NodeType::ROUNDED_RECTANGLE, AL, "!", {20, 10, 80, 80}, "A"));
  nodes.push_back(make(K1, NodeType::ROUNDED_RECTANGLE, AL, "\"", {120, 10, 80, 80}, "B"));
  nodes.push_back(make(K2, NodeType::ROUNDED_RECTANGLE, AL, "#", {220, 10, 80, 80}, "C"));
  Editor e = load(nodes);
  NodeChange touch;  // laid out once, as a panel edit would
  touch.mask = F_STACK_SPACING;
  touch.props.stack().stackSpacing = 20;
  e.setProps({AL}, touch, 0);
  e.takeEvents();
  return e;
}

}  // namespace

TEST_CASE("r17 haptics: padding and gap drags tick per whole step") {
  Editor e = flowScene();
  e.setSelection({AL});
  // The left padding's bar (10, 50) → screen (110, 150), dragged right by quarter pixels: 20 → 30.
  uint32_t ticks = dragCounting(e, {110, 150}, {120, 150}, 40, [&] { return props(e, AL).stack().stackPaddingLeft; });
  CHECK(props(e, AL).stack().stackPaddingLeft == 30);
  CHECK(ticks > 0);
  CHECK(ticks <= 10);
  // The first gap's bar (now 110..130 → its middle 120, 50 → screen 220, 150), by quarter pixels: every gap alike.
  e.setSelection({AL});
  move(e, {220, 150});
  REQUIRE(e.overlay().layoutBars.size() > 0);
  ticks = dragCounting(e, {220, 150}, {225, 150}, 40, [&] { return props(e, AL).stack().stackSpacing; });
  CHECK(props(e, AL).stack().stackSpacing != 20);
  CHECK(ticks > 0);
}

TEST_CASE("r17 haptics: one tick per auto-layout swap during a flow drag") {
  Editor e = flowScene();
  e.tick(1000);
  e.setSelection({K0});
  auto order = [&] {
    std::vector<Guid> o = e.document().children(AL);
    return o;
  };
  move(e, {160, 150});
  down(e, {160, 150});
  e.takeEvents();
  uint32_t ticks = 0, swaps = 0;
  std::vector<Guid> last = order();
  // Right across both neighbours by single pixels, then back.
  for (int i = 1; i <= 400; i++) {
    double x = 160 + (i <= 200 ? i : 400 - i);
    move(e, {x, 150});
    uint32_t got = e.takeEvents().haptics;
    std::vector<Guid> now = order();
    INFO("move ", i);
    CHECK(got == (now != last ? 1u : 0u));
    swaps += now != last;
    ticks += got;
    last = now;
  }
  up(e, {160, 150});
  CHECK(swaps == 4);  // past B, past C, back past C, back past B
  CHECK(ticks == 4);
}

TEST_CASE("r17 haptics: a move ticks once on snapping to a guide, not while it stays snapped or leaves") {
  auto nodes = baseChanges();
  nodes.push_back(make(X, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 100, 100}, "X"));
  nodes.push_back(make(Y, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {300, 37, 100, 100}, "Y"));
  Editor e = load(nodes);
  e.setSelection({X});
  move(e, {150, 150});
  down(e, {150, 150});
  e.takeEvents();
  uint32_t ticks = 0;
  bool snapped = false;
  // X's right edge passes Y's left one (300) at dx 200, within reach from 194 to 206.
  for (int dx = 1; dx <= 230; dx++) {
    move(e, {150.0 + dx, 150});
    ticks += e.takeEvents().haptics;
    if (dx == 197) snapped = props(e, X).transform.m02 == 200;
  }
  up(e, {380, 150});
  CHECK(snapped);
  CHECK(ticks == 1);
}

TEST_CASE("r17 haptics: the HAPTIC event reaches JS through takeEvents' count") {
  Editor e = rectScene();
  e.setSelection({R});
  move(e, {200, 150});
  move(e, {112, 112});
  down(e, {112, 112});
  move(e, {117, 117});
  Editor::Events ev = e.takeEvents();
  CHECK(ev.haptics == 1);
  CHECK(!e.hasEvents());
  up(e, {117, 117});
}
