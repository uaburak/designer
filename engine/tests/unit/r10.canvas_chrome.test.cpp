// Round 10 — canvas chrome as live Figma draws it (docs/engine-build.md "Round 10 — Canvas chrome, capture fixture and
// vector edit canvas"): the size badge and auto layout's gap and padding badges 17 high with the text 4 px in from each
// end (the gap badge "10" 20 × 17, 10 px right of its bar); a grid's track under its expanded pill outlined 2 px on its
// edges (half inside, half outside) across the whole frame.
#include <algorithm>
#include <array>
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

const Guid AL{1, 20}, A{1, 21}, B{1, 22}, G{1, 30};

struct Fonts {
  Fonts() {
    auto& fonts = text::FontRegistry::get();
    int32_t upright = addFontFile(std::string(ENG_FONTS_DIR) + "/InterVariable.ttf");
    for (const char* style : {"Regular", "Medium", "Semi Bold", "Bold"}) fonts.bind("Inter", style, upright);
    fonts.takeRequests();
  }
  ~Fonts() { text::FontRegistry::get().reset(); }
};

// The capture's AL_horizontal (232 × 72 Hug, gap 10, padding 16; three 60 × 40 items) at (0, 0) and its AL_grid
// (320 × 200, padding 12) at (400, 0); zoom 1.5 with the page origin at (100, 100) on screen.
struct Scene {
  Fonts fonts;
  Editor e;
  gfx::NullDevice device;
  Renderer r{device};
  Scene() {
    auto nodes = baseChanges();
    NodeChange al = make(AL, NodeType::FRAME, kPage, "!", {0, 0, 232, 72}, "AL_horizontal");
    StackFacet& st = al.props.stack();
    st.stackMode = StackMode::HORIZONTAL;
    st.stackSpacing = 10;
    st.stackPaddingLeft = st.stackPaddingTop = st.stackPaddingRight = st.stackPaddingBottom = 16;
    nodes.push_back(al);
    nodes.push_back(make(A, NodeType::ROUNDED_RECTANGLE, AL, "!", {16, 16, 60, 40}, "AL_horizontal_item1"));
    nodes.push_back(make(B, NodeType::ROUNDED_RECTANGLE, AL, "\"", {86, 16, 60, 40}, "AL_horizontal_item2"));
    nodes.push_back(make({1, 23}, NodeType::ROUNDED_RECTANGLE, AL, "#", {156, 16, 60, 40}, "AL_horizontal_item3"));
    NodeChange grid = make(G, NodeType::FRAME, kPage, "\"", {400, 0, 320, 200}, "AL_grid");
    StackFacet& gs = grid.props.stack();
    gs.stackMode = StackMode::GRID;
    gs.stackPaddingLeft = gs.stackPaddingTop = gs.stackPaddingRight = gs.stackPaddingBottom = 12;
    nodes.push_back(grid);
    e.setSessionID(1);
    e.setViewport(1400, 900, 1, 1400, 900);
    e.loadDocument(nodes, kNoGuid);
    e.setCamera({100, 100, 1.5});
    e.takeEvents();
    r.setTextLayouts(&e);
  }
  Vec2 screen(Vec2 world) const { return e.camera().toScreen(world); }
  void move(Vec2 s) { e.pointer(PointerEvent::MOVE, s.x, s.y, 0, 0, 0); }
  std::vector<DrawInstance> draw(const OverlayStyle& style = OverlayStyle::of(Theme::Dark)) {
    device.draws.clear();
    r.render(e.document(), e.page(), e.camera(), e.viewport(), e.overlay(), style);
    std::vector<DrawInstance> all;
    for (size_t i = 0; i < device.draws.size(); i++)
      for (const DrawInstance& q : device.instancesOf<DrawInstance>(i)) all.push_back(q);
    return all;
  }
};

bool sameColor(const DrawInstance& q, const Color& c) {
  return std::fabs(q.color[0] - c.r) < 0.01 && std::fabs(q.color[1] - c.g) < 0.01 && std::fabs(q.color[2] - c.b) < 0.01 && q.color[3] > 0.99;
}
bool isFill(const DrawInstance& q) {
  return q.geom[2] == static_cast<float>(ShapeKind::Rect) && (static_cast<uint32_t>(q.geom[3]) & (DF_STROKE | DF_FILL_AND_STROKE)) == 0;
}

}  // namespace

// The badges (fill rectangles `h` high in `color`) as {x, y, w}, sorted by width.
static std::vector<std::array<float, 3>> badges(Scene& s, const Color& color, double h = 17) {
  std::vector<std::array<float, 3>> out;
  for (const DrawInstance& q : s.draw())
    if (isFill(q) && sameColor(q, color) && q.origin[3] == h) out.push_back({q.origin[0], q.origin[1], q.origin[2]});
  std::sort(out.begin(), out.end(), [](const auto& a, const auto& b) { return a[2] < b[2]; });
  return out;
}

TEST_CASE("r10 badges: 17 high, the text 4 px in from each end (the design system's metrics, both themes)") {
  // tokens.ts canvasChromeMetrics.sizeBadge → ChromePalette.generated.h → OverlayStyle.
  for (Theme t : {Theme::Dark, Theme::Light}) {
    CHECK(OverlayStyle::of(t).badgeHeight == 17);
    CHECK(OverlayStyle::of(t).badgePadding == 4);
    CHECK(OverlayStyle::of(t).badgeRadius == 2);
    CHECK(OverlayStyle::of(t).badgeGap == 6);
  }
  CHECK(OverlayStyle{}.badgeHeight == 17);
  CHECK(OverlayStyle{}.badgePadding == 4);
}

TEST_CASE("r10 auto layout: the hovered gap's badge is 20 x 17 for \"10\", 10 px right of its bar, 5 above it") {
  Scene s;
  s.e.setSelection({AL});
  s.move(s.screen({81, 36}));  // the gap between the first two items
  const Overlay& o = s.e.overlay();
  const Overlay::LayoutBar* gap = nullptr;
  for (const auto& b : o.layoutBars)
    if (b.gap && b.hovered) gap = &b;
  REQUIRE(gap);
  CHECK(gap->vertical);
  CHECK(gap->value == doctest::Approx(10));
  const Color pink = OverlayStyle::of(Theme::Dark).spacing;
  auto pinks = badges(s, pink);
  REQUIRE(pinks.size() == 1);
  // Live (title-scaled): 20.8 x 17.4; ours: Inter Medium 11 "10" (11.7) + 2 x 4, rounded.
  CHECK(pinks[0][2] == doctest::Approx(20));
  Vec2 bar = s.screen(gap->at);
  CHECK(pinks[0][0] == doctest::Approx(std::round(bar.x + 10)));
  // Its bottom 5 px above the 12 px bar's top.
  CHECK(pinks[0][1] + 17 == doctest::Approx(std::round(bar.y - 6 - 5)).epsilon(0.02));
  // Nothing 16 high in pink any more.
  CHECK(badges(s, pink, 16).empty());
}

TEST_CASE("r10 auto layout: the hovered padding's badge and the size badge are 17 high too") {
  Scene s;
  s.e.setSelection({AL});
  s.move(s.screen({150, 7}));  // the top padding
  const Color blue = OverlayStyle::of(Theme::Dark).selection;
  auto blues = badges(s, blue);
  // The padding's "16" (live 20.6 x 17.3) and the size badge "232 × 72" under the frame, 6 px below it.
  REQUIRE(blues.size() == 2);
  CHECK(blues[0][2] == doctest::Approx(20));
  CHECK(blues[1][2] > blues[0][2] + 20);
  CHECK(blues[1][1] == doctest::Approx(s.screen({0, 72}).y + 6));
  // The padding's badge: above the frame's top edge, 2 px off it.
  CHECK(blues[0][1] + 17 == doctest::Approx(s.screen({0, 0}).y - 2));
  CHECK(badges(s, blue, 16).empty());
}

TEST_CASE("r10 grid: the track under an expanded pill is outlined 2 px, centred on its edges, the frame's height") {
  Scene s;
  s.e.setSelection({G});
  // Over the frame, then on the column pills' line above it: the column's pill expands.
  Vec2 mid = s.screen({560, 100});
  s.move(mid);
  Vec2 top = s.screen({560, 0});
  s.move({top.x, top.y - 31.5});
  const Overlay& o = s.e.overlay();
  REQUIRE(o.gridTrackBoxes.size() == 1);
  Vec2 a = s.screen(o.gridTrackBoxes[0].a), b = s.screen(o.gridTrackBoxes[0].b);
  const Color blue = OverlayStyle::of(Theme::Dark).selection;
  int found = 0;
  for (const DrawInstance& q : s.draw()) {
    if (!(static_cast<uint32_t>(q.geom[3]) & DF_STROKE) || q.geom[2] != static_cast<float>(ShapeKind::Rect)) continue;
    if (std::fabs(q.origin[0] - a.x) > 0.5 || std::fabs(q.origin[3] - (b.y - a.y)) > 0.5) continue;
    found++;
    CHECK(q.geom[0] == 1);  // 1 px inside
    CHECK(q.geom[1] == 1);  // 1 px outside
    CHECK(sameColor(q, blue));  // the selection colour, opaque
    CHECK(q.origin[2] == doctest::Approx(b.x - a.x).epsilon(0.01));
  }
  CHECK(found == 1);
  // The box spans the frame from top to bottom (live: across its padding too).
  CHECK(a.y == doctest::Approx(s.screen({400, 0}).y));
  CHECK(b.y == doctest::Approx(s.screen({400, 200}).y));
}
