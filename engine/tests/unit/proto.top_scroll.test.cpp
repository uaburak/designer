// The shown top-level frame scrolling its own overflowing content (the owner's "04 Scroll" screen, 2026-10-21): a frame
// the screen's size whose content runs past its bottom, overflow Vertical, scrolls that content inside it as Figma's
// viewer does (`NodeScrollingLogic`: the base screen scrolls BOTH ways, its box the frame cut to the screen, its content
// that box plus its non-Fixed children along the overflow's axis) — Fixed layers stay, Sticky ones stick, Scroll to
// lands, a horizontal carousel inside scrolls on its own; a frame taller than the screen still scrolls as a whole.
#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "proto/Player.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid SCREEN{1, 1}, CONTENT{1, 2}, STICKY{1, 3}, NAV{1, 4}, CAROUSEL{1, 5}, STRIP{1, 6}, SECTION_C{1, 7}, BUTTON{1, 8},
    BELOW{1, 9}, TALL{1, 10};

std::string extra(const char* key, const std::string& text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  std::string bytes = codec::extraFromJson("NodeChange", key, v);
  REQUIRE(!bytes.empty());
  return bytes;
}

// 04 Scroll: 1440 × 1024, overflow Vertical; Content (0, 67, 1440 × 2484) holding a Carousel (overflow Horizontal, a
// 3000-wide strip) and Section C at 1800; a Sticky title (y 300); a Fixed Nav bar (0, 0, 1440 × 67) whose button
// scrolls to Section C; a layer at 1200 (past the frame's bottom) to hit once scrolled.
std::vector<NodeChange> scrollLab(const char* overflow = "VERTICAL") {
  auto nodes = baseChanges();
  NodeChange s = make(SCREEN, NodeType::FRAME, kPage, "!", {0, 0, 1440, 1024}, "04 Scroll");
  if (overflow) s.props.extra["scrollDirection"] = extra("scrollDirection", std::string("\"") + overflow + "\"");
  nodes.push_back(s);
  nodes.push_back(make(CONTENT, NodeType::FRAME, SCREEN, "!", {0, 67, 1440, 2484}, "Content"));
  NodeChange car = make(CAROUSEL, NodeType::FRAME, CONTENT, "!", {0, 500, 1440, 300}, "Carousel");
  car.props.extra["scrollDirection"] = extra("scrollDirection", R"("HORIZONTAL")");
  nodes.push_back(car);
  nodes.push_back(make(STRIP, NodeType::RECTANGLE, CAROUSEL, "!", {0, 0, 3000, 300}, "Strip"));
  nodes.push_back(make(SECTION_C, NodeType::FRAME, CONTENT, "\"", {0, 1800, 1440, 400}, "Section C"));
  NodeChange below = make(BELOW, NodeType::RECTANGLE, CONTENT, "#", {100, 1133, 200, 100}, "Below");
  below.props.extra["prototypeInteractions"] = extra("prototypeInteractions",
      std::string(R"([{"event":{"interactionType":"ON_CLICK"},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"NAVIGATE","transitionNodeID":")") +
          TALL.toString() + R"(","transitionType":"INSTANT_TRANSITION"}]}])");
  nodes.push_back(below);
  NodeChange st = make(STICKY, NodeType::RECTANGLE, SCREEN, "\"", {0, 300, 1440, 60}, "Sticky title");
  st.props.extra["scrollBehavior"] = extra("scrollBehavior", R"("STICKY_SCROLLS")");
  nodes.push_back(st);
  NodeChange nav = make(NAV, NodeType::FRAME, SCREEN, "#", {0, 0, 1440, 67}, "Nav bar");
  nav.props.extra["scrollBehavior"] = extra("scrollBehavior", R"("FIXED_WHEN_CHILD_OF_SCROLLING_FRAME")");
  nodes.push_back(nav);
  NodeChange b = make(BUTTON, NodeType::RECTANGLE, NAV, "!", {20, 10, 100, 40}, "Go to C");
  b.props.extra["prototypeInteractions"] = extra("prototypeInteractions",
      std::string(R"([{"event":{"interactionType":"ON_CLICK"},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"SCROLL_TO","transitionNodeID":")") +
          SECTION_C.toString() + R"(","transitionType":"INSTANT_TRANSITION"}]}])");
  nodes.push_back(b);
  // A frame taller than the screen with no overflow (as before: it scrolls as a whole).
  nodes.push_back(make(TALL, NodeType::FRAME, kPage, "\"", {2000, 0, 1440, 2000}, "Tall"));
  return nodes;
}

struct Fixture {
  Editor ed;
  proto::Player player{ed};
  double t = 0;
  explicit Fixture(const std::vector<NodeChange>& nodes) {
    ed.setSessionID(1);
    ed.setViewport(1440, 1024, 1, 1440, 1024);
    ed.loadDocument(nodes, kNoGuid);
    ed.takeEvents();
  }
  // Past the wheel's 0.2 s latch.
  void later() { player.tick(t += 1000); }
  void click(double x, double y) {
    player.pointer(PointerEvent::MOVE, x, y, 0, 0);
    player.pointer(PointerEvent::DOWN, x, y, 1, 0);
    player.pointer(PointerEvent::UP, x, y, 0, 0);
  }
  const PresentItem* itemOf(Guid id) {
    for (auto& item : player.scene().items)
      if (item.kind == PresentItem::Kind::Node && item.node == id) return &item;
    return nullptr;
  }
  // Where the scene draws a layer of the screen (its top in screen units): the root's matrix and the drawn transforms.
  double drawnTop(Guid id) {
    player.scene();
    double y = 0;
    for (Guid cur = id; cur != SCREEN; cur = ed.document().parentOf(cur)) {
      const NodeProps* p = player.drawnProps(cur);
      if (!p) p = &ed.document().get(cur)->props;
      y += p->transform.m12;
    }
    const PresentItem* root = itemOf(SCREEN);
    REQUIRE(root);
    return y + root->parentCss.m12;  // the root item's matrix places the frame (its own transform is identity here)
  }
};

}  // namespace

TEST_CASE("proto.top_scroll: a screen-sized frame whose content overflows scrolls it (04 Scroll)") {
  Fixture f(scrollLab());
  REQUIRE(f.player.start(kPage, SCREEN));
  CHECK(f.player.screenSize().y == doctest::Approx(1024));
  // The range: the content's bottom (67 + 2484) − the screen's.
  f.player.wheel(700, 600, 0, 5000);
  CHECK(f.player.scrollOf(SCREEN).y == doctest::Approx(2484 + 67 - 1024));
  CHECK(f.player.scrollOf(SCREEN).x == 0);
  double s = 2484 + 67 - 1024;
  // The frame stays (it fills the screen); its layers move up inside it.
  const PresentItem* root = f.itemOf(SCREEN);
  REQUIRE(root);
  CHECK(root->parentCss.m12 == doctest::Approx(0));
  CHECK(f.drawnTop(CONTENT) == doctest::Approx(67 - s));
  // Fixed: the Nav bar is drawn on its own, unscrolled.
  const PresentItem* nav = f.itemOf(NAV);
  REQUIRE(nav);
  CHECK(nav->parentCss.m12 == doctest::Approx(0));
  // Sticky: pinned at the screen's top.
  CHECK(f.drawnTop(STICKY) == doctest::Approx(0));
  // Back up a little: the sticky title (top 300) scrolls with the rest until it meets the top.
  f.player.wheel(700, 600, 0, -(s - 200));
  CHECK(f.player.scrollOf(SCREEN).y == doctest::Approx(200));
  CHECK(f.drawnTop(STICKY) == doctest::Approx(100));
  CHECK(f.drawnTop(CONTENT) == doctest::Approx(67 - 200));
}

TEST_CASE("proto.top_scroll: hit testing follows the scrolled content; the Fixed nav stays hit where it is") {
  Fixture f(scrollLab());
  REQUIRE(f.player.start(kPage, SCREEN));
  // "Below" at 67 + 1133 = 1200 (past the frame's bottom); scrolled by 400 it shows at 800.
  f.player.wheel(700, 600, 0, 400);
  f.later();
  f.click(50, 30);  // the Nav bar's button, where it always is: Scroll to Section C
  CHECK(f.player.scrollOf(SCREEN).y == doctest::Approx(1527));
  // Back to 400: "Below" (its interaction goes to Tall) shows at 800.
  f.player.wheel(700, 600, 0, 400 - 1527);
  CHECK(f.player.scrollOf(SCREEN).y == doctest::Approx(400));
  f.later();
  f.click(150, 1100 - 400 + 300);  // under its document place, scrolled: Content's empty part
  CHECK(f.player.screen() == SCREEN);
  f.click(150, 850);
  CHECK(f.player.screen() == TALL);
}

TEST_CASE("proto.top_scroll: Scroll to Section C lands it at the screen's top") {
  Fixture f(scrollLab());
  REQUIRE(f.player.start(kPage, SCREEN));
  f.click(50, 30);  // the Nav bar's button
  // Section C's top in the frame: 67 + 1800 = 1867, clamped to the range 1527.
  CHECK(f.player.scrollOf(SCREEN).y == doctest::Approx(std::min(1867.0, 2484 + 67 - 1024.0)));
  CHECK(f.player.scrollOf(SCREEN).y == doctest::Approx(1527));
}

TEST_CASE("proto.top_scroll: the horizontal carousel inside scrolls on its own") {
  Fixture f(scrollLab());
  REQUIRE(f.player.start(kPage, SCREEN));
  // The carousel at 67 + 500 = 567 .. 867; a sideways wheel over it scrolls it, not the screen.
  f.later();
  f.player.wheel(700, 700, 300, 0);
  CHECK(f.player.scrollOf(CAROUSEL).x == doctest::Approx(300));
  CHECK(f.player.scrollOf(SCREEN).x == 0);
  CHECK(f.player.scrollOf(SCREEN).y == 0);
  // Scrolled down, it is still found where it is drawn.
  f.later();
  f.player.wheel(700, 100, 0, 300);
  CHECK(f.player.scrollOf(SCREEN).y == doctest::Approx(300));
  f.later();
  f.player.wheel(700, 400, 200, 0);  // 567 − 300 = 267 .. 567
  CHECK(f.player.scrollOf(CAROUSEL).x == doctest::Approx(500));
}

TEST_CASE("proto.top_scroll: No scrolling — the frame's own content doesn't scroll; a taller frame still does, as a whole") {
  SUBCASE("screen-sized, No scrolling") {
    Fixture f(scrollLab(nullptr));
    REQUIRE(f.player.start(kPage, SCREEN));
    f.player.wheel(700, 100, 0, 500);
    CHECK(f.player.scrollOf(SCREEN).y == 0);
  }
  SUBCASE("taller than the screen") {
    Fixture f(scrollLab());
    REQUIRE(f.player.start(kPage, TALL));
    f.player.wheel(700, 600, 0, 5000);
    CHECK(f.player.scrollOf(TALL).y == doctest::Approx(2000 - 1024));
    const PresentItem* root = f.itemOf(TALL);
    REQUIRE(root);
    // The frame itself moves under the screen (its matrix; −2000 its x on the page).
    CHECK(root->parentCss.m12 == doctest::Approx(-(2000 - 1024)));
  }
}
