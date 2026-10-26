// A sticky layer is clicked where it shows (2026-10-26, B2C Project's booking pages): the player drew stuck layers
// pushed down by the scroll (Player::stick) but hit-tested them where they sit unscrolled, so a stuck header's icons or
// a stuck sidebar's "Next Step" took no click once the page had scrolled. hitWalk now takes the same offsets (stuckOf).
#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "proto/Player.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid HOME{1, 1}, NEXT{1, 2}, BAR{1, 10}, BAR_BUTTON{1, 11}, BODY{1, 20}, SIDE{1, 21}, SIDE_BUTTON{1, 22}, OTHER{1, 3};

std::string extra(const char* key, const std::string& text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  std::string bytes = codec::extraFromJson("NodeChange", key, v);
  REQUIRE(!bytes.empty());
  return bytes;
}

std::string navigate(Guid dest) {
  return std::string(R"([{"event":{"interactionType":"ON_CLICK"},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"NAVIGATE","transitionType":"INSTANT_TRANSITION","transitionNodeID":")") +
         dest.toString() + "\"}]}]";
}

// Home (1440 × 3000, no scrolling of its own: the page scrolls): a sticky Bar at y 1000 with a button, and a Body
// (y 200, 2600 tall) holding a sticky Side (y 0, 400 tall) with a button at its bottom — B2C's sidebarWrapper › Sidebar.
std::vector<NodeChange> page() {
  auto nodes = baseChanges();
  nodes.push_back(make(HOME, NodeType::FRAME, kPage, "!", {0, 0, 1440, 3000}, "Home"));
  nodes.push_back(make(NEXT, NodeType::FRAME, kPage, "\"", {2000, 0, 1440, 900}, "Next"));
  nodes.push_back(make(OTHER, NodeType::FRAME, kPage, "#", {4000, 0, 1440, 900}, "Other"));
  NodeChange bar = make(BAR, NodeType::FRAME, HOME, "!", {0, 1000, 1440, 60}, "Bar");
  bar.props.extra["scrollBehavior"] = extra("scrollBehavior", R"("STICKY_SCROLLS")");
  nodes.push_back(bar);
  NodeChange barButton = make(BAR_BUTTON, NodeType::RECTANGLE, BAR, "!", {0, 0, 200, 60}, "Bar button");
  barButton.props.extra["prototypeInteractions"] = extra("prototypeInteractions", navigate(NEXT));
  nodes.push_back(barButton);
  nodes.push_back(make(BODY, NodeType::FRAME, HOME, "\"", {1000, 200, 400, 2600}, "Body"));
  NodeChange side = make(SIDE, NodeType::FRAME, BODY, "!", {0, 0, 400, 400}, "Side");
  side.props.extra["scrollBehavior"] = extra("scrollBehavior", R"("STICKY_SCROLLS")");
  nodes.push_back(side);
  NodeChange sideButton = make(SIDE_BUTTON, NodeType::RECTANGLE, SIDE, "!", {0, 340, 400, 60}, "Next step");
  sideButton.props.extra["prototypeInteractions"] = extra("prototypeInteractions", navigate(OTHER));
  nodes.push_back(sideButton);
  return nodes;
}

struct Fixture {
  Editor ed;
  proto::Player player{ed};
  Fixture() {
    ed.setSessionID(1);
    ed.setViewport(1440, 900, 1, 1440, 900);
    ed.loadDocument(page(), kNoGuid);
    ed.takeEvents();
    player.setScale(proto::ScaleMode::ACTUAL);
  }
  void click(double x, double y) {
    player.pointer(PointerEvent::MOVE, x, y, 0, 0);
    player.pointer(PointerEvent::DOWN, x, y, 1, 0);
    player.pointer(PointerEvent::UP, x, y, 0, 0);
  }
};

}  // namespace

TEST_CASE("proto.sticky_hit: a stuck bar is clicked where it shows") {
  Fixture f;
  REQUIRE(f.player.start(kPage, HOME));
  f.player.scene();
  f.player.wheel(700, 500, 0, 1500);  // the bar (top 1000) is stuck at the window's top
  f.player.scene();
  REQUIRE(f.player.scrollOf(HOME).y == doctest::Approx(1500));
  f.click(100, 30);
  CHECK(f.player.screen() == NEXT);
}

TEST_CASE("proto.sticky_hit: a stuck sidebar inside a body is clicked where it shows") {
  Fixture f;
  REQUIRE(f.player.start(kPage, HOME));
  f.player.scene();
  f.player.wheel(700, 500, 0, 1000);  // the side (top 200) is stuck at the top: its button at 340..400 in the window
  f.player.scene();
  f.click(1200, 370);
  CHECK(f.player.screen() == OTHER);
}

TEST_CASE("proto.sticky_hit: unscrolled, the layers are hit where they sit") {
  Fixture f;
  REQUIRE(f.player.start(kPage, HOME));
  f.player.scene();
  f.click(1200, 570);  // the side's button at 200 + 340
  CHECK(f.player.screen() == OTHER);
}
