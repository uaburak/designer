// Round 15 — auto layout's padding and gap handles as live Figma's (the owner's recording and 48 / 49.png, read frame by
// frame in docs/research/figma/live/behaviour/spacing-handles.md; help.figma.com "Explore auto layout properties"):
// the padding or gap under the pointer hatched, the value by the pointer only over its bar (the spacing cursor), a drag
// on the bar changing it 1:1 (a gap ½ per gap before it) with the other bars gone and the dragged one outlined, ⌥ the
// opposite padding, ⌥⇧ all four, ⇧ steps of the big nudge, negative gaps, one undo step; a click or ⌥-click editing
// in place; Auto gaps; turned frames; no handles on a tiny frame. And the `</>` button: hover, tooltip, click.
#include <algorithm>
#include <cmath>
#include <optional>

#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "gfx/null/NullDevice.h"
#include "render/Renderer.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid AL{1, 1}, A{1, 2}, B{1, 3};
const double kPi = 3.14159265358979323846;

// A horizontal auto-layout frame 300 × 100 at the page origin (fixed size), padding 20 / 10 / 20 / 10, gap 20, two
// 120 × 80 layers; the page origin at (100, 100) on screen, zoom 1. Its bars on screen: left (110, 150), top (250, 105),
// right (390, 150), bottom (250, 195), the gap's (250, 150).
Editor makeEditor(const Mat2x3& at = {}, StackJustify justify = StackJustify::MIN) {
  auto nodes = baseChanges();
  NodeChange f = make(AL, NodeType::FRAME, kPage, "!", {0, 0, 300, 100}, "Auto");
  f.props.transform = at;
  StackFacet& st = f.props.stack();
  st.stackMode = StackMode::HORIZONTAL;
  st.stackPrimarySizing = StackSize::FIXED;
  st.stackCounterSizing = StackSize::FIXED;
  st.stackSpacing = 20;
  st.stackPrimaryAlignItems = justify;
  st.stackPaddingLeft = st.stackPaddingRight = 20;
  st.stackPaddingTop = st.stackPaddingBottom = 10;
  nodes.push_back(f);
  nodes.push_back(make(A, NodeType::ROUNDED_RECTANGLE, AL, "!", {20, 10, 120, 80}, "A"));
  nodes.push_back(make(B, NodeType::ROUNDED_RECTANGLE, AL, "\"", {160, 10, 120, 80}, "B"));
  Editor e;
  e.setViewport(1000, 800, 1, 1000, 800);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({100, 100, 1});
  e.setSelection({AL});
  e.takeEvents();
  return e;
}

void down(Editor& e, Vec2 s, uint32_t mods = 0) { e.pointer(PointerEvent::DOWN, s.x, s.y, 0, 1, mods, 1); }
void move(Editor& e, Vec2 s, uint32_t mods = 0) { e.pointer(PointerEvent::MOVE, s.x, s.y, 0, 1, mods); }
void up(Editor& e, Vec2 s, uint32_t mods = 0) { e.pointer(PointerEvent::UP, s.x, s.y, 0, 0, mods); }
void click(Editor& e, Vec2 s, uint32_t mods = 0) {
  move(e, s, mods);
  down(e, s, mods);
  up(e, s, mods);
}
void drag(Editor& e, Vec2 from, Vec2 to, uint32_t mods = 0) {
  move(e, from, mods);
  down(e, from, mods);
  for (int i = 1; i <= 4; i++) {
    double t = i / 4.0;
    move(e, {from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t}, mods);
  }
  up(e, to, mods);
}
const StackFacet& stack(const Editor& e) { return e.document().get(AL)->props.stack(); }
std::optional<Overlay::LayoutBar> hoveredBar(const Overlay& o) {
  for (const auto& b : o.layoutBars)
    if (b.hovered) return b;
  return std::nullopt;
}

}  // namespace

TEST_CASE("r15 spacing: the padding or gap under the pointer is hatched; its value and the spacing cursor only over its bar") {
  Editor e = makeEditor();
  // The left padding, 30 px above its bar: hatched, no value, the arrow.
  move(e, {110, 120});
  Overlay o = e.overlay();
  CHECK(o.layoutBars.size() == 5);
  CHECK(!hoveredBar(o));
  REQUIRE(o.spacingAreas.size() == 1);
  CHECK(!o.spacingAreas[0].gap);
  CHECK(!o.spacingAreas[0].outline);
  CHECK(o.spacingAreas[0].quad[0] == Vec2{0, 0});
  CHECK(o.spacingAreas[0].quad[2] == Vec2{20, 100});
  CHECK(e.cursor() == CursorKind::DEFAULT);
  // On its bar (2 px off its middle): its value by the pointer, the spacing cursor across.
  move(e, {111, 152});
  o = e.overlay();
  auto bar = hoveredBar(o);
  REQUIRE(bar);
  CHECK(bar->side == 0);
  CHECK(bar->value == 20);
  CHECK(bar->edge == Vec2{11, 52});
  CHECK(o.spacingAreas.size() == 1);
  CHECK(e.cursor() == CursorKind::SPACING);
  CHECK(e.cursorAngle() == 0);
  // The top padding's bar: up and down.
  move(e, {255, 105});
  REQUIRE(hoveredBar(e.overlay()));
  CHECK(hoveredBar(e.overlay())->side == 1);
  CHECK(e.cursorAngle() == 90);
  // 17 px off a bar's end: not on it.
  move(e, {250 + 6 + 17, 105});
  CHECK(!hoveredBar(e.overlay()));
  CHECK(e.cursor() == CursorKind::DEFAULT);
  // The gap off its bar: pink hatch; on it: its value.
  move(e, {250, 120});
  o = e.overlay();
  REQUIRE(o.spacingAreas.size() == 1);
  CHECK(o.spacingAreas[0].gap);
  CHECK(!hoveredBar(o));
  move(e, {250, 150});
  bar = hoveredBar(e.overlay());
  REQUIRE(bar);
  CHECK(bar->gap);
  CHECK(bar->value == 20);
  CHECK(!bar->autoGap);
  CHECK(e.cursor() == CursorKind::SPACING);
  CHECK(e.cursorAngle() == 0);
  // On a layer: nothing hatched; off the frame: no bars.
  move(e, {180, 150});
  CHECK(e.overlay().spacingAreas.empty());
  CHECK(e.overlay().layoutBars.size() == 5);
  move(e, {600, 600});
  CHECK(e.overlay().layoutBars.empty());
  CHECK(e.overlay().spacingAreas.empty());
}

TEST_CASE("r15 spacing: dragging a gap — 2 px a px for the first gap, negative allowed, the others gone, one undo step") {
  Editor e = makeEditor();
  move(e, {250, 150});
  down(e, {250, 150});
  move(e, {245, 150});
  move(e, {235, 150});
  // Mid-drag: only the dragged gap's value by the pointer, its gap outlined.
  Overlay o = e.overlay();
  REQUIRE(o.layoutBars.size() == 1);
  CHECK(o.layoutBars[0].box);
  CHECK(o.layoutBars[0].hovered);
  CHECK(o.layoutBars[0].edge == Vec2{135, 50});
  REQUIRE(o.spacingAreas.size() == 1);
  CHECK(o.spacingAreas[0].outline);
  CHECK(o.spacingAreas[0].gap);
  CHECK(stack(e).stackSpacing == -10);  // 20 − 15 / 0.5
  CHECK(e.cursor() == CursorKind::SPACING);
  // The layers overlap: the outline is where they do (10 wide).
  CHECK(o.spacingAreas[0].quad[1].x - o.spacingAreas[0].quad[0].x == doctest::Approx(10));
  move(e, {220, 150});
  up(e, {220, 150});
  CHECK(stack(e).stackSpacing == -40);
  CHECK(e.document().get(B)->props.transform.m02 == doctest::Approx(100));
  CHECK(e.undoStack().undoCount() == 1);
  e.command(CommandId::UNDO);
  CHECK(stack(e).stackSpacing == 20);
  // ⇧: steps of the big nudge (10): 20 + 2 × 7 = 34 → 30.
  drag(e, {250, 150}, {257, 150}, MOD_SHIFT);
  CHECK(stack(e).stackSpacing == 30);
}

TEST_CASE("r15 spacing: dragging a padding — 1:1, ⌥ its opposite, ⌥⇧ all four, ⇧ steps of 10, never below 0") {
  Editor e = makeEditor();
  drag(e, {110, 150}, {117, 150});
  CHECK(stack(e).stackPaddingLeft == 27);
  CHECK(stack(e).stackPaddingRight == 20);
  e.command(CommandId::UNDO);
  drag(e, {110, 150}, {117, 150}, MOD_ALT);
  CHECK(stack(e).stackPaddingLeft == 27);
  CHECK(stack(e).stackPaddingRight == 27);
  CHECK(stack(e).stackPaddingTop == 10);
  e.command(CommandId::UNDO);
  drag(e, {110, 150}, {117, 150}, MOD_ALT | MOD_SHIFT);
  CHECK(stack(e).stackPaddingLeft == 27);
  CHECK(stack(e).stackPaddingRight == 27);
  CHECK(stack(e).stackPaddingTop == 27);
  CHECK(stack(e).stackPaddingBottom == 27);
  e.command(CommandId::UNDO);
  drag(e, {110, 150}, {117, 150}, MOD_SHIFT);
  CHECK(stack(e).stackPaddingLeft == 30);
  CHECK(stack(e).stackPaddingRight == 20);
  e.command(CommandId::UNDO);
  // The bottom padding dragged up past the frame's edge… stops at 0.
  drag(e, {250, 195}, {250, 230});
  CHECK(stack(e).stackPaddingBottom == 0);
  CHECK(e.undoStack().undoCount() == 1);
}

TEST_CASE("r15 spacing: a click on a bar edits it by the pointer; ⌥-click on a padding its pair, ⌥⇧ all four") {
  Editor e = makeEditor();
  click(e, {111, 152});
  auto ev = e.takeEvents();
  REQUIRE(ev.inlineEdits.size() == 1);
  CHECK(ev.inlineEdits[0].field == "PADDING_LEFT");
  CHECK(ev.inlineEdits[0].rect.x == doctest::Approx(121));
  CHECK(ev.inlineEdits[0].rect.bottom() == doctest::Approx(142));
  CHECK(e.undoStack().undoCount() == 0);
  // ⌥ on the left padding off its bar: left and right.
  click(e, {110, 120}, MOD_ALT);
  ev = e.takeEvents();
  REQUIRE(ev.inlineEdits.size() == 1);
  CHECK(ev.inlineEdits[0].field == "PADDING_HORIZONTAL");
  CHECK(ev.inlineEdits[0].value == 20);
  CHECK(e.selection() == std::vector<Guid>{AL});
  // ⌥ on the top padding (clear of its edge's resize zone): top and bottom; ⌥⇧: all four.
  click(e, {200, 107}, MOD_ALT);
  ev = e.takeEvents();
  REQUIRE(ev.inlineEdits.size() == 1);
  CHECK(ev.inlineEdits[0].field == "PADDING_VERTICAL");
  CHECK(ev.inlineEdits[0].value == 10);
  click(e, {200, 107}, MOD_ALT | MOD_SHIFT);
  ev = e.takeEvents();
  REQUIRE(ev.inlineEdits.size() == 1);
  CHECK(ev.inlineEdits[0].field == "PADDING_ALL");
  CHECK(e.undoStack().undoCount() == 0);
  // A plain click off the bars edits nothing.
  click(e, {110, 120});
  CHECK(e.takeEvents().inlineEdits.empty());
}

TEST_CASE("r15 spacing: an Auto gap reads Auto; dragged, it becomes a number") {
  Editor e = makeEditor({}, StackJustify::SPACE_BETWEEN);
  move(e, {250, 150});
  auto bar = hoveredBar(e.overlay());
  REQUIRE(bar);
  CHECK(bar->autoGap);
  CHECK(bar->value == 20);  // as laid out
  drag(e, {250, 150}, {255, 150});
  CHECK(stack(e).stackPrimaryAlignItems == StackJustify::MIN);
  CHECK(stack(e).stackSpacing == 30);
}

TEST_CASE("r15 spacing: a turned frame's handles turn with it; a drag follows its own axes") {
  const double a = 30 * kPi / 180;
  Mat2x3 W = Mat2x3::translate(400, 300) * Mat2x3::rotate(a);
  Editor e = makeEditor(W);
  Vec2 left = e.camera().toScreen(W.apply({10, 50}));
  move(e, left);
  auto bar = hoveredBar(e.overlay());
  REQUIRE(bar);
  CHECK(bar->side == 0);
  CHECK(bar->axis.x == doctest::Approx(-std::sin(a)));
  CHECK(bar->axis.y == doctest::Approx(std::cos(a)));
  CHECK(e.cursor() == CursorKind::SPACING);
  CHECK(e.cursorAngle() == 30);
  // Off the bar in the left padding: hatched, its quad turned.
  Vec2 off = e.camera().toScreen(W.apply({10, 15}));
  move(e, off);
  REQUIRE(e.overlay().spacingAreas.size() == 1);
  Vec2 q1 = e.overlay().spacingAreas[0].quad[1];
  CHECK(q1.x == doctest::Approx(W.apply({20, 0}).x));
  CHECK(q1.y == doctest::Approx(W.apply({20, 0}).y));
  // 8 units along the frame's own x axis: the left padding 28.
  Vec2 to = e.camera().toScreen(W.apply({18, 50}));
  drag(e, left, to);
  CHECK(stack(e).stackPaddingLeft == 28);
}

TEST_CASE("r15 spacing: no handles on a frame tiny on screen") {
  Editor e = makeEditor();
  e.setCamera({100, 100, 0.05});  // 15 × 5 px
  move(e, {101, 101});
  CHECK(e.overlay().layoutBars.empty());
}

TEST_CASE("r15 spacing: the hatch's stripes and wash in the handle's colour; the dragged one outlined") {
  Editor e = makeEditor();
  gfx::NullDevice dev;
  Renderer r(dev);
  const OverlayStyle style = OverlayStyle::of(Theme::Light);
  auto shapes = [&]() {
    dev.draws.clear();
    r.render(e.document(), e.page(), e.camera(), e.viewport(), e.overlay(), style);
    std::vector<DrawInstance> all;
    for (size_t i = 0; i < dev.draws.size(); i++)
      for (const DrawInstance& q : dev.instancesOf<DrawInstance>(i)) all.push_back(q);
    return all;
  };
  auto count = [&](const std::vector<DrawInstance>& all, const Color& c, double alpha, float h) {
    int n = 0;
    for (const DrawInstance& q : all)
      if (std::fabs(q.color[3] - alpha) < 1e-3 && std::fabs(q.color[0] - c.r * alpha) < 1e-3 && (h < 0 || q.origin[3] == h)) n++;
    return n;
  };
  move(e, {250, 120});  // the gap, off its bar: 20 × 80 px hatched pink
  auto all = shapes();
  // Stripes 1 px across every 6.5 px along a row: (20 + 80) / 6.5 ≈ 15 of them.
  int stripes = count(all, style.spacing, style.hatchInk, 1);
  CHECK(stripes >= 14);
  CHECK(stripes <= 17);
  CHECK(count(all, style.spacing, style.hatchWash, 80) == 1);
  // The left padding: blue.
  move(e, {110, 120});
  all = shapes();
  CHECK(count(all, style.selection, style.hatchInk, 1) >= 14);
  CHECK(count(all, style.spacing, style.hatchInk, 1) == 0);
  // Dragging the gap: no stripes, a 1 px outline.
  move(e, {250, 150});
  down(e, {250, 150});
  move(e, {255, 150});
  move(e, {260, 150});
  all = shapes();
  CHECK(count(all, style.spacing, style.hatchInk, 1) == 0);
  bool outline = false;
  for (const DrawInstance& q : all)
    outline |= (static_cast<uint32_t>(q.geom[3]) & DF_STROKE) && q.geom[0] == 1 && std::fabs(q.color[0] - style.spacing.r) < 1e-3;
  CHECK(outline);
  up(e, {260, 150});
}

TEST_CASE("r15 dev: the `</>` button fills on hover, its tooltip after 500 ms, a click marks the frame") {
  Editor e = makeEditor();
  gfx::NullDevice dev;
  Renderer r(dev);
  auto frame = [&]() {
    dev.draws.clear();
    r.render(e.document(), e.page(), e.camera(), e.viewport(), e.overlay(), OverlayStyle::of(Theme::Light));
    e.setCanvasHits(r.canvasHits());
  };
  frame();
  std::optional<CanvasHits::Status> icon;
  for (const auto& h : r.canvasHits().statuses)
    if (h.kind == DevStatusMark::Kind::MarkButton) icon = h;
  REQUIRE(icon);
  // 16 × 16, its right edge 2 px past the frame's (screen 400), centred 13.2 px above its top (screen 100).
  CHECK(icon->rect.w == 16);
  CHECK(icon->rect.right() == doctest::Approx(402));
  CHECK(icon->rect.y + 8 == doctest::Approx(86.8).epsilon(0.01));
  Vec2 c{icon->rect.x + 8, icon->rect.y + 8};
  move(e, c);
  CHECK(e.overlay().dev.iconHover == AL);
  CHECK(!e.overlay().dev.tooltip);
  e.tick(1000);
  CHECK(e.chromeDelay() == 500);
  e.tick(1400);
  CHECK(!e.overlay().dev.tooltip);
  e.tick(1501);
  CHECK(e.overlay().dev.tooltip);
  CHECK(e.chromeDelay() == -1);
  frame();
  // The tooltip box: 24 high in the tooltip colour, under the button.
  const Color tip = OverlayStyle::of(Theme::Light).tooltipFill;
  bool drawn = false;
  for (size_t i = 0; i < dev.draws.size(); i++)
    for (const DrawInstance& q : dev.instancesOf<DrawInstance>(i))
      drawn |= q.origin[3] == 24 && std::fabs(q.color[0] - tip.r) < 1e-3 && q.origin[1] > icon->rect.bottom();
  CHECK(drawn);
  // Off it: no hover, no tooltip.
  move(e, {600, 600});
  CHECK(e.overlay().dev.iconHover == kNoGuid);
  CHECK(!e.overlay().dev.tooltip);
  e.takeEvents();
  click(e, c);
  auto ev = e.takeEvents();
  REQUIRE(ev.statusClicks.size() == 1);
  CHECK(ev.statusClicks[0].frame == AL);
  CHECK(ev.statusClicks[0].action == "mark");
}
