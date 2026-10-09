// Round 9 — canvas chrome and overlays as live Figma draws them (docs/engine-build.md "Round 9 — Canvas chrome and
// overlays"): an ellipse's arc handles, a polygon's and a star's radius / ratio / count handles (each drag one undo
// step), the selection's path outline, the `</>` at a selected design's top right, auto layout's padding badge by the
// pointer, a selected grid's cells, pills and track outline.
#include <cmath>

#include "doctest.h"
#include "Helpers.h"
#include "TextHelpers.h"
#include "editor/Editor.h"
#include "gfx/null/NullDevice.h"
#include "render/Renderer.h"
#include "text/Fonts.h"

using namespace eng;
using namespace eng::test;

namespace {

constexpr double kPi = 3.14159265358979323846;
const Guid E{1, 1}, P{1, 2}, S{1, 3}, F{1, 4}, C{1, 5};

// An ellipse, a triangle and a 5-point star, 100 × 100 each, at x 0, 200, 400; a frame below. Zoom 2, the page
// origin at (100, 100) on screen.
Editor makeEditor(std::vector<NodeChange> extra = {}) {
  auto nodes = baseChanges();
  nodes.push_back(make(E, NodeType::ELLIPSE, kPage, "!", {0, 0, 100, 100}, "Ellipse"));
  NodeChange poly = make(P, NodeType::REGULAR_POLYGON, kPage, "\"", {200, 0, 100, 100}, "Polygon");
  poly.props.shape().count = 3;
  nodes.push_back(poly);
  NodeChange star = make(S, NodeType::STAR, kPage, "#", {400, 0, 100, 100}, "Star");
  star.props.shape().count = 5;
  star.props.shape().starInnerScale = 0.382;
  nodes.push_back(star);
  nodes.push_back(make(F, NodeType::FRAME, kPage, "$", {0, 200, 300, 150}, "Card"));
  for (auto& c : extra) nodes.push_back(c);
  Editor e;
  e.setSessionID(1);
  e.setViewport(1400, 900, 1, 1400, 900);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({100, 100, 2});
  e.takeEvents();
  return e;
}

void down(Editor& e, double x, double y, uint32_t mods = 0, int clicks = 1) { e.pointer(PointerEvent::DOWN, x, y, 0, 1, mods, clicks); }
void move(Editor& e, double x, double y, uint32_t mods = 0) { e.pointer(PointerEvent::MOVE, x, y, 0, 1, mods); }
void up(Editor& e, double x, double y, uint32_t mods = 0) { e.pointer(PointerEvent::UP, x, y, 0, 0, mods); }
// A press at `from`, moves in `steps` steps along a straight line to `to`, a release.
void drag(Editor& e, Vec2 from, Vec2 to, int steps = 8) {
  move(e, from.x, from.y);
  down(e, from.x, from.y);
  for (int i = 1; i <= steps; i++) {
    double t = static_cast<double>(i) / steps;
    move(e, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
  }
  up(e, to.x, to.y);
}
const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }
Vec2 screen(const Editor& e, Vec2 world) { return e.camera().toScreen(world); }

// The shape handles the overlay shows (screen), with the pointer over the layer.
std::vector<Vec2> handles(Editor& e, Vec2 pointer) {
  move(e, pointer.x, pointer.y);
  std::vector<Vec2> out;
  for (Vec2 w : e.overlay().shapeHandles) out.push_back(screen(e, w));
  return out;
}

}  // namespace

// ---- 1. Shape handles ---------------------------------------------------------------------------------------------

TEST_CASE("r9 shape handles: a whole ellipse shows one ring on its right, 9 px inside the edge, only under the pointer") {
  Editor e = makeEditor();
  e.setSelection({E});
  // Not under the pointer: none (as a rectangle's radius handles).
  move(e, 700, 700);
  CHECK(e.overlay().shapeHandles.empty());
  std::vector<Vec2> hs = handles(e, {200, 200});
  REQUIRE(hs.size() == 1);
  // The ellipse is (100, 100)–(300, 300) on screen: the ring at (291, 200).
  CHECK(hs[0].x == doctest::Approx(291));
  CHECK(hs[0].y == doctest::Approx(200));
  // Too small on screen: none.
  e.setCamera({100, 100, 0.5});
  CHECK(handles(e, {125, 125}).empty());
}

TEST_CASE("r9 shape handles: dragging the arc handle sweeps the ellipse; start, end and ratio then; one undo step each") {
  Editor e = makeEditor();
  e.setSelection({E});
  std::vector<Vec2> hs = handles(e, {200, 200});
  REQUIRE(hs.size() == 1);
  // A quarter turn counter-clockwise (up, round the centre (200, 200)): the end goes back from 2π to 3π/2.
  move(e, hs[0].x, hs[0].y);
  down(e, hs[0].x, hs[0].y);
  for (int i = 1; i <= 18; i++) {
    double a = -kPi / 2 * i / 18;
    move(e, 200 + std::cos(a) * 91, 200 + std::sin(a) * 91);
  }
  up(e, 200, 109);
  ArcData arc = props(e, E).shape().arcData;
  CHECK(arc.startingAngle == doctest::Approx(0));
  CHECK(arc.endingAngle == doctest::Approx(1.5 * kPi).epsilon(0.01));
  CHECK(arc.innerRadius == 0);
  // An arc: its end, its start and the ratio (at the centre while there is no hole).
  hs = handles(e, {180, 220});
  REQUIRE(hs.size() == 3);
  CHECK(hs[0].x == doctest::Approx(200).epsilon(0.001));  // the end, at the top, 9 px down
  CHECK(hs[0].y == doctest::Approx(109));
  CHECK(hs[1].x == doctest::Approx(291));  // the start, on the right
  CHECK(hs[2].x == doctest::Approx(200));  // the ratio, in the centre
  CHECK(hs[2].y == doctest::Approx(200));
  // The ratio dragged half way out: a donut.
  drag(e, hs[2], {200 + 50 * std::cos(0.75 * kPi), 200 + 50 * std::sin(0.75 * kPi)});
  CHECK(props(e, E).shape().arcData.innerRadius == doctest::Approx(0.5).epsilon(0.02));
  e.command(CommandId::UNDO);
  CHECK(props(e, E).shape().arcData.innerRadius == 0);
  CHECK(props(e, E).shape().arcData.endingAngle == doctest::Approx(1.5 * kPi).epsilon(0.01));
  e.command(CommandId::UNDO);
  CHECK(props(e, E).shape().arcData.isFull());
}

TEST_CASE("r9 shape handles: a triangle's radius (the top corner, 16 px in) and count (the next corner)") {
  Editor e = makeEditor();
  e.setSelection({P});
  // The triangle's corners on its box's ellipse: (250, 0), (293.3, 75), (206.7, 75) → screen ×2 + 100.
  std::vector<Vec2> hs = handles(e, {600, 200});
  REQUIRE(hs.size() == 2);
  CHECK(hs[0].x == doctest::Approx(600));
  CHECK(hs[0].y == doctest::Approx(116));
  CHECK(hs[1].x == doctest::Approx(100 + 2 * 293.30127));
  CHECK(hs[1].y == doctest::Approx(250));
  // The count handle turned up towards the top: 72° from it → five corners.
  Vec2 c{600, 200};
  double r = (hs[1] - c).length();
  move(e, hs[1].x, hs[1].y);
  down(e, hs[1].x, hs[1].y);
  for (int i = 1; i <= 12; i++) {
    double from = 2 * kPi / 3 + (2 * kPi / 5 - 2 * kPi / 3) * i / 12;  // clockwise from straight up
    move(e, c.x + std::sin(from) * r, c.y - std::cos(from) * r);
  }
  up(e, c.x + std::sin(2 * kPi / 5) * r, c.y - std::cos(2 * kPi / 5) * r);
  CHECK(props(e, P).shape().count == 5);
  // The radius handle pulled down along the corner's bisector: rounded, whole numbers.
  hs = handles(e, {600, 200});
  REQUIRE(hs.size() == 2);
  drag(e, hs[0], {hs[0].x, hs[0].y + 20});
  double radius = props(e, P).cornerRadii[0];
  CHECK(radius > 4);
  CHECK(radius == std::round(radius));
  e.command(CommandId::UNDO);
  CHECK(props(e, P).cornerRadii[0] == 0);
  e.command(CommandId::UNDO);
  CHECK(props(e, P).shape().count == 3);
}

TEST_CASE("r9 shape handles: a star's radius, ratio (its first inner corner) and count (its right tip)") {
  Editor e = makeEditor();
  e.setSelection({S});
  std::vector<Vec2> hs = handles(e, {1000, 200});
  REQUIRE(hs.size() == 3);
  // Live Figma (canvas-star-selected-handles): the top tip's ring 16 px down, the ratio on the inner corner, the count
  // on the right tip (x 97.55 of 100).
  CHECK(hs[0].x == doctest::Approx(1000));
  CHECK(hs[0].y == doctest::Approx(116));
  CHECK(hs[1].x == doctest::Approx(100 + 2 * (450 + 50 * 0.382 * std::cos(-0.3 * kPi))));
  CHECK(hs[1].y == doctest::Approx(100 + 2 * (50 + 50 * 0.382 * std::sin(-0.3 * kPi))));
  CHECK(hs[2].x == doctest::Approx(100 + 2 * (450 + 50 * std::cos(-0.1 * kPi))));
  // The ratio dragged out from the centre: a fatter star.
  Vec2 c{1000, 200};
  Vec2 dir = (hs[1] - c) * (1 / (hs[1] - c).length());
  drag(e, hs[1], hs[1] + dir * 30);
  CHECK(props(e, S).shape().starInnerScale == doctest::Approx(0.382 + 30.0 / 100).epsilon(0.02));
  e.command(CommandId::UNDO);
  CHECK(props(e, S).shape().starInnerScale == doctest::Approx(0.382));
  // Hover state: the ring under the pointer is the hovered one.
  hs = handles(e, {1000, 200});
  move(e, hs[2].x, hs[2].y);
  CHECK(e.overlay().shapeHovered == 2);
  CHECK(e.cursor() == CursorKind::DEFAULT);
}

TEST_CASE("r9 shape handles: locked layers, other tools and a multi-selection show none") {
  NodeChange locked = make(C, NodeType::STAR, kPage, "%", {600, 0, 100, 100}, "Locked");
  locked.props.locked = true;
  Editor e = makeEditor({locked});
  e.setSelection({C});
  CHECK(handles(e, {1300, 200}).empty());
  e.setSelection({S, E});
  CHECK(handles(e, {1000, 200}).empty());
  e.setSelection({S});
  e.setTool(Tool::RECTANGLE);
  CHECK(handles(e, {1000, 200}).empty());
}

// ---- 2. The selection's outline, the `</>` ------------------------------------------------------------------------

namespace {

struct Fonts {
  Fonts() {
    auto& fonts = text::FontRegistry::get();
    int32_t upright = addFontFile(std::string(ENG_FONTS_DIR) + "/InterVariable.ttf");
    for (const char* style : {"Regular", "Medium", "Semi Bold", "Bold"}) fonts.bind("Inter", style, upright);
    fonts.takeRequests();
  }
  ~Fonts() { text::FontRegistry::get().reset(); }
};

struct Frame {
  Fonts fonts;
  Editor e = makeEditor();
  gfx::NullDevice device;
  Renderer r{device};
  Frame() { r.setTextLayouts(&e); }
  RenderStats draw() {
    RenderStats s = r.render(e.document(), e.page(), e.camera(), e.viewport(), e.overlay(), OverlayStyle::of(Theme::Dark));
    e.setCanvasHits(r.canvasHits());
    return s;
  }
};

}  // namespace

TEST_CASE("r9 overlay: a selected star is outlined along its path at rest (live Figma)") {
  Frame f;
  move(f.e, 1300, 850);
  f.e.setSelection({E});
  uint32_t ellipseShapes = f.draw().shapes;
  f.e.setSelection({S});
  uint32_t starShapes = f.draw().shapes;
  // The box, four handles and the same badge for both; the ellipse's outline is one shape, the star's ten segments.
  CHECK(starShapes >= ellipseShapes + 10);
  // A multi-selection: each shape along its own outline too (more than two boxes).
  f.e.setSelection({S, P});
  CHECK(f.draw().shapes >= starShapes + 3);
}

TEST_CASE("r9 overlay: the `</>` at a selected frame's top right; a click marks it ready for dev") {
  Frame f;
  f.e.setSelection({F});
  move(f.e, 1300, 850);  // not over it: shown all the same
  f.draw();
  const CanvasHits& hits = f.r.canvasHits();
  REQUIRE(hits.statuses.size() == 1);
  CHECK(hits.statuses[0].kind == DevStatusMark::Kind::MarkButton);
  // The frame is (100, 500)–(700, 800) on screen: the icon's box ends by its right edge, above it.
  Rect icon = hits.statuses[0].rect;
  CHECK(icon.right() == doctest::Approx(702));
  CHECK(icon.x == doctest::Approx(686));
  CHECK(icon.bottom() <= 500);
  CHECK(icon.y >= 476);
  f.e.takeEvents();
  move(f.e, icon.x + icon.w / 2, icon.y + icon.h / 2);
  down(f.e, icon.x + icon.w / 2, icon.y + icon.h / 2);
  up(f.e, icon.x + icon.w / 2, icon.y + icon.h / 2);
  auto ev = f.e.takeEvents();
  REQUIRE(ev.statusClicks.size() == 1);
  CHECK(ev.statusClicks[0].frame == F);
  CHECK(ev.statusClicks[0].action == "mark");
  CHECK(f.e.selection() == std::vector<Guid>{F});
  // Nothing selected: no icon.
  f.e.setSelection({});
  f.draw();
  CHECK(f.r.canvasHits().statuses.empty());
}

// ---- 3. Auto layout's padding badge, a grid's bars --------------------------------------------------------------

TEST_CASE("r9 auto layout: the hovered padding's value sits outside its edge where the pointer is") {
  const Guid AL{1, 20}, A{1, 21}, B{1, 22};
  NodeChange al = make(AL, NodeType::FRAME, kPage, "%", {0, 400, 232, 72}, "AL_horizontal");
  StackFacet& st = al.props.stack();
  st.stackMode = StackMode::HORIZONTAL;
  st.stackSpacing = 10;
  st.stackPaddingLeft = st.stackPaddingTop = st.stackPaddingRight = st.stackPaddingBottom = 16;
  Editor e = makeEditor({al, make(A, NodeType::ROUNDED_RECTANGLE, AL, "!", {16, 16, 60, 40}, "A"),
                         make(B, NodeType::ROUNDED_RECTANGLE, AL, "\"", {86, 16, 60, 40}, "B")});
  e.setSelection({AL});
  // The top padding (y 400..416) at x 150: its bar is the frame's middle, its badge's anchor the pointer's x.
  Vec2 p = screen(e, {150, 407});
  move(e, p.x, p.y);
  Overlay o = e.overlay();
  const Overlay::LayoutBar* top = nullptr;
  for (const auto& b : o.layoutBars)
    if (!b.gap && b.side == 1) top = &b;
  REQUIRE(top);
  CHECK(top->hovered);
  CHECK(top->at.x == doctest::Approx(81));  // the frame hugs its two children: 162 wide
  CHECK(top->edge.x == doctest::Approx(150));
  CHECK(top->edge.y == doctest::Approx(400));
  // The left padding at y 430: the anchor on the left edge at the pointer's y.
  p = screen(e, {8, 430});
  move(e, p.x, p.y);
  o = e.overlay();
  for (const auto& b : o.layoutBars)
    if (!b.gap && b.side == 0) {
      CHECK(b.hovered);
      CHECK(b.edge.x == doctest::Approx(0));
      CHECK(b.edge.y == doctest::Approx(430));
    }
}

TEST_CASE("r9 grid: a selected grid's padding bars (no gap bars), cells, and its pills band keeps them") {
  const Guid G{1, 30};
  NodeChange grid = make(G, NodeType::FRAME, kPage, "%", {0, 400, 320, 200}, "AL_grid");
  StackFacet& st = grid.props.stack();
  st.stackMode = StackMode::GRID;
  st.stackPaddingLeft = st.stackPaddingTop = st.stackPaddingRight = st.stackPaddingBottom = 12;
  Editor e = makeEditor({grid});
  e.setSelection({G});
  Vec2 p = screen(e, {160, 500});
  move(e, p.x, p.y);
  Overlay o = e.overlay();
  CHECK(o.layoutBars.size() == 4);
  for (const auto& b : o.layoutBars) CHECK(!b.gap);
  CHECK(!o.gridCells.empty());
  REQUIRE(!o.gridPills.empty());
  CHECK(!o.gridPills[0].expanded);
  // Above the frame, on the column pills' line: the bars stay, the column's pill expands and outlines its track.
  Vec2 top = screen(e, {160, 400});
  move(e, top.x, top.y - 31.5);
  o = e.overlay();
  CHECK(o.layoutBars.size() == 4);
  REQUIRE(o.gridPills.size() == 1);
  CHECK(o.gridPills[0].expanded);
  CHECK(o.gridPills[0].rect.y + o.gridPills[0].rect.h / 2 == doctest::Approx(top.y - 31.5));
  CHECK(o.gridTrackBoxes.size() == 1);
  CHECK(e.cursor() == CursorKind::DEFAULT);
}
