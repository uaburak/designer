// The prototype player as Figma's viewer plays it (atlas wave 4, docs/research/atlas/13-prototyping.md §14): the
// transitions' geometry (Slide's quarter and fade, the mirrored _OUT_TO_ types), hotspot hints, the drag's start, vector
// and release speed, the 1/30 s frame clock, the ordered action queue, Swap overlay with none open, After delay's start
// and cancelling, key triggers on the topmost screen, drag scrolling with iOS / Android physics, nested sticky layers,
// Open link's new tab, the scale options' order, and Motion timelines on the shown screen.
#include <cmath>

#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "motion/Easing.h"
#include "proto/Player.h"
#include "proto/Prototype.h"
#include "proto/Scroll.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid A{1, 1}, B{1, 2}, C{1, 3}, OVL{1, 4}, BUTTON{1, 11}, CARD{1, 12}, LIST{1, 13}, ITEM{1, 14}, GROUP{1, 15}, HEADER{1, 16},
    BOX{1, 17}, CARD_B{1, 22};

std::string extra(const char* key, const std::string& text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  std::string bytes = codec::extraFromJson("NodeChange", key, v);
  REQUIRE(!bytes.empty());
  return bytes;
}

std::string navTo(Guid dest, const char* transition = "INSTANT_TRANSITION", double duration = 0.3, const char* trigger = "ON_CLICK",
                  const char* navigation = "NAVIGATE") {
  return std::string("{\"connectionType\":\"INTERNAL_NODE\",\"navigationType\":\"") + navigation + "\",\"transitionNodeID\":\"" +
         dest.toString() + "\",\"transitionType\":\"" + transition + "\",\"transitionDuration\":" + std::to_string(duration) +
         ",\"easingType\":\"LINEAR\"}";
}

std::string interaction(const std::string& actions, const char* trigger = "ON_CLICK", const std::string& more = "") {
  return std::string("[{\"event\":{\"interactionType\":\"") + trigger + "\"" + more + "},\"actions\":[" + actions + "]}]";
}

// Three screens 375 × 812 side by side (A, B, C), an overlay frame (OVL, 200 × 100); on A a button (20, 700, 100 × 40)
// whose interaction is `button`, and a card (20, 100, 200 × 100) with a matching card on B.
std::vector<NodeChange> screens(const std::string& button) {
  auto nodes = baseChanges();
  nodes.push_back(make(A, NodeType::FRAME, kPage, "!", {0, 0, 375, 812}, "Home"));
  nodes.push_back(make(B, NodeType::FRAME, kPage, "\"", {500, 0, 375, 812}, "Details"));
  nodes.push_back(make(C, NodeType::FRAME, kPage, "#", {1000, 0, 375, 812}, "Settings"));
  nodes.push_back(make(OVL, NodeType::FRAME, kPage, "$", {1500, 0, 200, 100}, "Menu"));
  NodeChange b = make(BUTTON, NodeType::RECTANGLE, A, "#", {20, 700, 100, 40}, "Button");
  if (!button.empty()) b.props.extra["prototypeInteractions"] = extra("prototypeInteractions", button);
  nodes.push_back(b);
  nodes.push_back(make(CARD, NodeType::FRAME, A, "!", {20, 100, 200, 100}, "Card"));
  nodes.push_back(make(CARD_B, NodeType::FRAME, B, "!", {20, 300, 200, 100}, "Card"));
  return nodes;
}

struct Fixture {
  Editor ed;
  proto::Player player{ed};
  double t = 0;
  explicit Fixture(const std::vector<NodeChange>& nodes, double w = 375, double h = 812, double dpr = 1) {
    ed.setSessionID(1);
    ed.setViewport(w, h, dpr, static_cast<int>(w * dpr), static_cast<int>(h * dpr));
    ed.loadDocument(nodes, kNoGuid);
    ed.takeEvents();
  }
  // Frames of at most 16 ms (the frame clock caps a longer one at 1/30 s).
  void advance(double ms) {
    while (ms > 0) {
      double step = std::min(16.0, ms);
      t += step;
      ms -= step;
      player.tick(t);
    }
  }
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
};

}  // namespace

TEST_CASE("proto.wave4: Figma's transition geometry — Slide's quarter and fade, the _OUT_TO_ types mirrored, who is on top") {
  using proto::Transition;
  proto::Geometry slide = proto::geometryOf(Transition::SLIDE_FROM_RIGHT);
  CHECK(slide.moves);
  CHECK(slide.inFrom.x == 1);
  CHECK(slide.inTo.x == 0);
  CHECK(slide.outTo.x == doctest::Approx(-0.25));
  CHECK(slide.outAlphaTo == doctest::Approx(0.5));
  CHECK(slide.enteringOnTop);
  // MOVE_OUT_TO_RIGHT = MOVE_FROM_LEFT reversed: the old screen leaves to the left, drawn on top.
  proto::Geometry out = proto::geometryOf(Transition::MOVE_OUT_TO_RIGHT);
  CHECK(out.outTo.x == -1);
  CHECK(out.inFrom.x == 0);
  CHECK_FALSE(out.enteringOnTop);
  // SLIDE_OUT_TO_LEFT = SLIDE_FROM_RIGHT reversed: the new screen comes from a quarter to the left at half opacity.
  proto::Geometry so = proto::geometryOf(Transition::SLIDE_OUT_TO_LEFT);
  CHECK(so.outTo.x == 1);
  CHECK(so.inFrom.x == doctest::Approx(-0.25));
  CHECK(so.inAlphaFrom == doctest::Approx(0.5));
  CHECK(so.inAlphaTo == 1);
  // PUSH_FROM_RIGHT = PUSH_FROM_LEFT reversed; PUSH_FROM_TOP built.
  proto::Geometry push = proto::geometryOf(Transition::PUSH_FROM_RIGHT);
  CHECK(push.inFrom.x == 1);
  CHECK(push.outTo.x == -1);
  CHECK_FALSE(push.enteringOnTop);
  CHECK(proto::geometryOf(Transition::PUSH_FROM_TOP).enteringOnTop);
  CHECK(proto::geometryOf(Transition::MOVE_OUT_TO_TOP).outTo.y == 1);  // MOVE_FROM_BOTTOM reversed: leaves downwards
  CHECK_FALSE(proto::geometryOf(Transition::DISSOLVE).moves);
}

TEST_CASE("proto.wave4: Slide in moves the old screen a quarter and fades it to half") {
  Fixture f(screens(interaction(navTo(B, "SLIDE_FROM_RIGHT", 0.4))));
  REQUIRE(f.player.start(kPage, A));
  f.advance(16);
  f.click(50, 720);
  f.advance(16);   // the clock starts
  f.advance(192);  // 12 frames of 16 ms: 48 %, linear
  double p = 192.0 / 400;
  const PresentItem* a = f.itemOf(A);
  const PresentItem* b = f.itemOf(B);
  REQUIRE(a);
  REQUIRE(b);
  // A: −¼ of the screen × p; B: from the right edge, p of the way in.
  CHECK(a->parentCss.m02 == doctest::Approx(-375 * 0.25 * p).epsilon(0.01));
  CHECK(b->parentCss.m02 + 500 == doctest::Approx(375 * (1 - p)).epsilon(0.01));
  const NodeProps* drawnA = f.player.drawnProps(A);
  REQUIRE(drawnA);
  CHECK(drawnA->opacity == doctest::Approx(1 - 0.5 * p).epsilon(0.01));
}

TEST_CASE("proto.wave4: hotspot hints — #30C2FF, half-opacity fill, a 2-device-pixel border, one 0.7 s ease-out fade") {
  Fixture f(screens(interaction(navTo(B))), 375, 812, 2);
  REQUIRE(f.player.start(kPage, A));
  f.advance(16);
  f.click(300, 400);  // nothing there
  f.advance(16);
  auto hint = [&]() -> const PresentItem* {
    for (auto& item : f.player.scene().items)
      if (item.kind == PresentItem::Kind::Rect && item.border > 0) return &item;
    return nullptr;
  };
  const PresentItem* h = hint();
  REQUIRE(h);
  CHECK(h->color.r == doctest::Approx(48 / 255.0).epsilon(0.01));
  CHECK(h->color.g == doctest::Approx(194 / 255.0).epsilon(0.01));
  CHECK(h->color.b == doctest::Approx(1));
  CHECK(h->border == doctest::Approx(1));  // 2 device px at dpr 2
  CHECK(h->alpha == doctest::Approx(0.5).epsilon(0.01));
  CHECK(h->borderAlpha == doctest::Approx(1).epsilon(0.01));
  CHECK(h->rect.x == doctest::Approx(20));
  f.advance(336);  // 0.35 s after the click
  h = hint();
  REQUIRE(h);
  double fade = 1 - motion::cubicBezier(0, 0, 0.58, 1, 0.5);
  CHECK(h->borderAlpha == doctest::Approx(fade).epsilon(0.03));
  CHECK(h->alpha == doctest::Approx(fade * 0.5).epsilon(0.03));
  f.advance(400);
  CHECK(hint() == nullptr);
}

TEST_CASE("proto.wave4: a press is a drag past 5 px; let go, its speed decides (0.15 per duration)") {
  Fixture f(screens(interaction(navTo(B, "PUSH_FROM_RIGHT", 0.4), "DRAG")));
  REQUIRE(f.player.start(kPage, A));
  f.advance(16);
  double t0 = f.t;
  f.player.pointer(PointerEvent::DOWN, 100, 720, 1, 0, t0);
  f.player.pointer(PointerEvent::MOVE, 95, 720, 1, 0, t0 + 5);
  CHECK(f.player.screen() == A);  // 5 px: not yet
  f.player.pointer(PointerEvent::MOVE, 94, 720, 1, 0, t0 + 10);
  CHECK(f.player.screen() == B);
  SUBCASE("a flick before half way completes") {
    // 60 px in 20 ms leftwards = 3000 px/s = 8 progress / s; r = 0.15 / 0.4 = 0.375.
    f.player.pointer(PointerEvent::MOVE, 64, 720, 1, 0, t0 + 20);
    f.player.pointer(PointerEvent::MOVE, 34, 720, 1, 0, t0 + 30);
    f.player.pointer(PointerEvent::UP, 34, 720, 0, 0, t0 + 31);
    f.advance(600);
    CHECK(f.player.screen() == B);
    CHECK(f.player.historySize() == 1);
  }
  SUBCASE("past half way, flicked back: it goes back") {
    f.player.pointer(PointerEvent::MOVE, -150, 720, 1, 0, t0 + 200);
    f.player.pointer(PointerEvent::MOVE, -120, 720, 1, 0, t0 + 210);
    f.player.pointer(PointerEvent::MOVE, -90, 720, 1, 0, t0 + 220);
    f.player.pointer(PointerEvent::UP, -90, 720, 0, 0, t0 + 221);
    f.advance(600);
    CHECK(f.player.screen() == A);
    CHECK(f.player.historySize() == 0);
  }
  SUBCASE("held still before letting go: the half-way rule") {
    f.player.pointer(PointerEvent::MOVE, -150, 720, 1, 0, t0 + 200);
    f.player.pointer(PointerEvent::UP, -150, 720, 0, 0, t0 + 400);
    f.advance(600);
    CHECK(f.player.screen() == B);
  }
}

TEST_CASE("proto.wave4: a long frame advances a transition by 1/30 s at most") {
  Fixture f(screens(interaction(navTo(B, "DISSOLVE", 0.3))));
  REQUIRE(f.player.start(kPage, A));
  f.advance(16);
  f.click(50, 720);
  f.advance(16);
  f.t += 500;
  f.player.tick(f.t);  // one 500 ms frame
  CHECK(f.player.animating());
  f.player.scene();
  const NodeProps* b = f.player.drawnProps(B);
  REQUIRE(b);
  CHECK(b->opacity == doctest::Approx(1000.0 / 30 / 300).epsilon(0.02));
  f.advance(300);
  CHECK_FALSE(f.player.animating());
}

TEST_CASE("proto.wave4: the action queue — a screen change holds the next action until its animation ends") {
  SUBCASE("Navigate (Dissolve) then Navigate (Instant)") {
    Fixture f(screens(interaction(navTo(B, "DISSOLVE", 0.3) + "," + navTo(C))));
    REQUIRE(f.player.start(kPage, A));
    f.advance(16);
    f.click(50, 720);
    CHECK(f.player.screen() == B);
    f.advance(160);
    CHECK(f.player.screen() == B);
    f.advance(200);
    CHECK(f.player.screen() == C);
    CHECK(f.player.historySize() == 2);
  }
  SUBCASE("instant ones run at once; a Conditional puts its block in place") {
    std::string cond =
        R"({"connectionType":"CONDITIONAL","conditionalActions":[{"condition":{"dataType":"BOOLEAN","resolvedDataType":"BOOLEAN","value":{"boolValue":true}},"actions":[)" +
        navTo(B) + "]},{\"actions\":[" + navTo(C) + "]}]}";
    Fixture f(screens(interaction(cond + "," + navTo(C))));
    REQUIRE(f.player.start(kPage, A));
    f.advance(16);
    f.click(50, 720);
    CHECK(f.player.screen() == C);
    CHECK(f.player.history() == std::vector<Guid>{A, B});
  }
}

TEST_CASE("proto.wave4: Swap overlay with no overlay open navigates") {
  Fixture f(screens(interaction(navTo(C, "INSTANT_TRANSITION", 0.3, "ON_CLICK", "SWAP"))));
  REQUIRE(f.player.start(kPage, A));
  f.advance(16);
  f.click(50, 720);
  CHECK(f.player.screen() == C);
  CHECK(f.player.overlays().empty());
}

TEST_CASE("proto.wave4: After delay starts when the transition ends, is dropped by another action, waits 500 ms after ← / →") {
  auto nodes = screens(interaction(navTo(B, "DISSOLVE", 0.3)));
  NodeChange timer = make(BOX, NodeType::RECTANGLE, B, "$", {0, 0, 10, 10}, "Timer");
  timer.props.extra["prototypeInteractions"] =
      extra("prototypeInteractions", interaction(navTo(C), "AFTER_TIMEOUT", ",\"transitionTimeout\":0.1"));
  nodes.push_back(timer);
  SUBCASE("after the transition") {
    Fixture f(nodes);
    REQUIRE(f.player.start(kPage, A));
    f.advance(16);
    f.click(50, 720);
    f.advance(304);  // the transition (300 ms) ends; the 100 ms delay starts then
    CHECK(f.player.screen() == B);
    f.advance(64);
    CHECK(f.player.screen() == B);
    f.advance(80);
    CHECK(f.player.screen() == C);
  }
  SUBCASE("reached with →: at least 500 ms") {
    Fixture f(nodes);
    REQUIRE(f.player.start(kPage, A));
    f.advance(16);
    f.player.key(true, 39, 0);
    CHECK(f.player.screen() == B);
    f.advance(400);
    CHECK(f.player.screen() == B);
    f.advance(150);
    CHECK(f.player.screen() == C);
  }
  SUBCASE("another action meanwhile drops it") {
    auto more = nodes;
    NodeChange other = make(HEADER, NodeType::RECTANGLE, B, "%", {100, 100, 50, 50}, "Other");
    other.props.extra["prototypeInteractions"] =
        extra("prototypeInteractions", R"([{"event":{"interactionType":"ON_CLICK"},"actions":[{"connectionType":"SET_VARIABLE"}]}])");
    more.push_back(other);
    Fixture f(more);
    REQUIRE(f.player.start(kPage, A));
    f.advance(16);
    f.click(50, 720);
    f.advance(320);
    f.click(120, 120);  // Set variable
    f.advance(200);
    CHECK(f.player.screen() == B);
  }
}

TEST_CASE("proto.wave4: key triggers — the topmost screen only, exactly the keys held, ⌘ as Ctrl off the Mac") {
  auto nodes = screens("");
  NodeChange key = make(BOX, NodeType::RECTANGLE, A, "$", {0, 0, 10, 10}, "Key");
  key.props.extra["prototypeInteractions"] =
      extra("prototypeInteractions", interaction(navTo(B), "ON_KEY_DOWN", R"(,"keyTrigger":{"keyCodes":[91,75],"triggerDevice":"KEYBOARD"})"));
  nodes.push_back(key);
  NodeChange open = make(HEADER, NodeType::RECTANGLE, A, "%", {0, 20, 10, 10}, "Open");
  open.props.extra["prototypeInteractions"] =
      extra("prototypeInteractions", interaction(navTo(OVL, "INSTANT_TRANSITION", 0.3, "ON_KEY_DOWN", "OVERLAY"), "ON_KEY_DOWN",
                                                 R"(,"keyTrigger":{"keyCodes":[79],"triggerDevice":"KEYBOARD"})"));
  nodes.push_back(open);
  Fixture f(nodes);
  REQUIRE(f.player.start(kPage, A));
  f.advance(16);
  CHECK(f.player.key(true, 75, 0) == 0);  // K alone: not ⌘K
  CHECK(f.player.screen() == A);
  SUBCASE("⌘K on the Mac") {
    f.player.key(true, 75, MOD_META);
    CHECK(f.player.screen() == B);
  }
  SUBCASE("Ctrl+K elsewhere") {
    f.player.setHost(proto::Player::Host::WINDOWS);
    f.player.key(true, 75, MOD_CTRL);
    CHECK(f.player.screen() == B);
  }
  SUBCASE("with an overlay open the screen's keys don't play") {
    f.player.key(true, 79, 0);
    REQUIRE(f.player.overlays().size() == 1);
    f.player.key(true, 75, MOD_META);
    CHECK(f.player.screen() == A);
  }
}

TEST_CASE("proto.wave4: scroll simulations — Flutter's friction, spring and Android's fling curve") {
  using proto::scroll::Simulation;
  proto::scroll::Tolerance tol = proto::scroll::toleranceFor(1);
  CHECK(tol.distance == 1);
  CHECK(tol.velocity == doctest::Approx(20));
  // Friction: comes to rest at p − v / ln 0.135.
  Simulation s = Simulation::bouncing(0, 1000, 0, 10000, tol);
  CHECK(s.x(10) == doctest::Approx(-1000 / std::log(0.135)).epsilon(0.001));
  CHECK(s.done(10));
  // Past the end: it carries into the spring and comes back to the end.
  Simulation b = Simulation::bouncing(0, 3000, 0, 500, tol);
  bool over = false;
  for (double t = 0; t < 1.5; t += 0.01) over |= b.x(t) > 500;
  CHECK(over);
  CHECK(b.x(3) == doctest::Approx(500));
  CHECK(b.done(3));
  // Pulled past the start and let go: springs back.
  Simulation back = Simulation::bouncing(-80, 0, 0, 500, tol);
  CHECK(back.x(0) == doctest::Approx(-80));
  CHECK(back.x(2) == doctest::Approx(0));
  // Clamping: Android's duration exp(ln(0.35·|v| / (0.015 · 61774.04968 · 0.84)) / (ln 0.78 / ln 0.9 − 1)), positions
  // kept in range.
  double rate = std::log(0.78) / std::log(0.9);
  double l = std::log(0.35 * 2000 / (0.015 * 61774.04968 * 0.84));
  CHECK(Simulation::clampingDuration(2000) == doctest::Approx(std::exp(l / (rate - 1))));
  Simulation c = Simulation::clamping(100, 2000, 0, 300, tol);
  CHECK(c.x(10) == doctest::Approx(300));
  CHECK(c.done(10));
  // Bouncing drags resist past an end: 0.52 · (1 − overscroll / viewport)².
  CHECK(proto::scroll::applyDrag(250, 10, 0, 500, 800) == 10);
  CHECK(proto::scroll::applyDrag(-100, -10, 0, 500, 800) == doctest::Approx(-10 * 0.52 * std::pow(1 - 100.0 / 800, 2)));
}

TEST_CASE("proto.wave4: a drag that triggers nothing scrolls the screen; let go it flings by the host's physics") {
  auto nodes = screens("");
  for (auto& n : nodes)
    if (n.guid == A) n.props.size = {375, 2000};
  SUBCASE("clamping (Windows)") {
    Fixture f(nodes);
    f.player.setHost(proto::Player::Host::WINDOWS);
    REQUIRE(f.player.start(kPage, A));
    f.advance(16);
    double t0 = f.t;
    f.player.pointer(PointerEvent::DOWN, 200, 600, 1, 0, t0);
    f.player.pointer(PointerEvent::MOVE, 200, 560, 1, 0, t0 + 10);
    f.player.pointer(PointerEvent::MOVE, 200, 500, 1, 0, t0 + 20);
    CHECK(f.player.scrollOf(A).y == doctest::Approx(100));
    f.player.pointer(PointerEvent::UP, 200, 500, 0, 0, t0 + 21);
    CHECK(f.player.animating());
    f.advance(3000);
    CHECK_FALSE(f.player.animating());
    double y = f.player.scrollOf(A).y;
    CHECK(y > 200);
    CHECK(y <= 2000 - 812);
  }
  SUBCASE("bouncing (Mac): past the top it resists, then springs back") {
    Fixture f(nodes);
    REQUIRE(f.player.start(kPage, A));
    f.advance(16);
    double t0 = f.t;
    f.player.pointer(PointerEvent::DOWN, 200, 300, 1, 0, t0);
    for (int i = 1; i <= 10; i++) f.player.pointer(PointerEvent::MOVE, 200, 300 + i * 10, 1, 0, t0 + i * 10);
    double y = f.player.scrollOf(A).y;
    CHECK(y < 0);
    CHECK(y > -100);  // 100 px of drag moved it less
    f.player.pointer(PointerEvent::UP, 200, 400, 0, 0, t0 + 300);
    f.advance(2000);
    CHECK(f.player.scrollOf(A).y == doctest::Approx(0));
  }
}

TEST_CASE("proto.wave4: a sticky layer inside a non-scrolling group is released at its group's bottom") {
  auto nodes = screens("");
  for (auto& n : nodes)
    if (n.guid == A) n.props.size = {375, 3000};
  nodes.push_back(make(GROUP, NodeType::FRAME, A, "%", {0, 400, 375, 600}, "Section"));
  NodeChange header = make(HEADER, NodeType::RECTANGLE, GROUP, "!", {0, 0, 375, 50}, "Header");
  header.props.extra["scrollBehavior"] = extra("scrollBehavior", "\"STICKY_SCROLLS\"");
  nodes.push_back(header);
  NodeChange top = make(LIST, NodeType::RECTANGLE, A, "&", {0, 1200, 375, 40}, "Top");
  top.props.extra["scrollBehavior"] = extra("scrollBehavior", "\"STICKY_SCROLLS\"");
  nodes.push_back(top);
  Fixture f(nodes);
  REQUIRE(f.player.start(kPage, A));
  f.advance(16);
  // How far the scene moves a layer down from where the document has it.
  auto pushed = [&](Guid id) {
    f.player.scene();
    const NodeProps* p = f.player.drawnProps(id);
    return p ? p->transform.m12 - f.ed.document().get(id)->props.transform.m12 : 0.0;
  };
  f.player.wheel(200, 300, 0, 300);  // scrollY 300: the header (top 400) not reached
  CHECK(pushed(HEADER) == doctest::Approx(0));
  f.player.wheel(200, 300, 0, 200);  // 500: pinned, pushed 100 within the group
  CHECK(pushed(HEADER) == doctest::Approx(100));
  f.player.wheel(200, 300, 0, 800);  // 1300: at most 600 − 50 = 550
  CHECK(pushed(HEADER) == doctest::Approx(550));
  // A direct child of the screen: pinned from its top on (1300 − 1200).
  CHECK(pushed(LIST) == doctest::Approx(1300 - 1200));
}

TEST_CASE("proto.wave4: Open link opens a new tab unless the file says otherwise; timeline actions round-trip") {
  NodeProps p;
  p.extra["prototypeInteractions"] = extra("prototypeInteractions",
      R"([{"event":{"interactionType":"ON_CLICK"},"actions":[{"connectionType":"URL","connectionURL":"https://a.b"},
          {"connectionType":"URL","connectionURL":"https://c.d","openUrlInNewTab":false},
          {"connectionType":"UPDATE_ANIMATION_TIMELINE_STATE","animationTimelineAction":"SET_PLAYHEAD","animationSkipToTime":1.5,"animationTimelineDefId":{"sessionID":1,"localID":1}}]}])");
  auto list = proto::interactions(p);
  REQUIRE(list.size() == 1);
  REQUIRE(list[0].actions.size() == 3);
  CHECK(list[0].actions[0].newTab);
  CHECK_FALSE(list[0].actions[1].newTab);
  CHECK(list[0].actions[2].connection == proto::Connection::UPDATE_ANIMATION_TIMELINE_STATE);
  CHECK(list[0].actions[2].timeline == proto::TimelineAction::SET_PLAYHEAD);
  CHECK(list[0].actions[2].timelineSkipTo == doctest::Approx(1.5));
  CHECK(list[0].actions[2].timelineDef == Guid{1, 1});
  NodeProps q;
  q.extra["prototypeInteractions"] = proto::encodeInteractions(list);
  auto again = proto::interactions(q);
  REQUIRE(again[0].actions.size() == 3);
  CHECK_FALSE(again[0].actions[1].newTab);
  CHECK(again[0].actions[2].timeline == proto::TimelineAction::SET_PLAYHEAD);
  CHECK(again[0].actions[2].timelineDef == Guid{1, 1});
}

TEST_CASE("proto.wave4: the scale options in the file's order; Z goes to the next") {
  using S = proto::ScaleMode;
  SUBCASE("small frames: Actual size, Fit width and height, Fit width, Responsive, Fill screen") {
    Fixture f(screens(""));
    REQUIRE(f.player.start(kPage, A));
    CHECK(f.player.scaleOrder() == std::vector<S>{S::ACTUAL, S::FIT, S::FIT_WIDTH, S::RESPONSIVE, S::FILL});
    CHECK(f.player.scale() == S::ACTUAL);
    f.player.cycleScale();
    CHECK(f.player.scale() == S::FIT);
    CHECK(f.player.stateJson().find(R"("scaleOrder":["ACTUAL","FIT","FIT_WIDTH","RESPONSIVE","FILL"])") != std::string::npos);
  }
  SUBCASE("a first frame wider than 1024: Actual size, Responsive, Fit width, Fit width and height, Fill screen") {
    auto nodes = screens("");
    for (auto& n : nodes)
      if (n.guid == A) n.props.size = {1440, 900};
    Fixture f(nodes);
    REQUIRE(f.player.start(kPage, A));
    CHECK(f.player.scaleOrder() == std::vector<S>{S::ACTUAL, S::RESPONSIVE, S::FIT_WIDTH, S::FIT, S::FILL});
  }
  SUBCASE("16:9 frames: Fill screen first") {
    auto nodes = baseChanges();
    nodes.push_back(make(A, NodeType::FRAME, kPage, "!", {0, 0, 1920, 1080}, "Slide 1"));
    nodes.push_back(make(B, NodeType::FRAME, kPage, "\"", {2000, 0, 1920, 1080}, "Slide 2"));
    Fixture f(nodes);
    REQUIRE(f.player.start(kPage, A));
    CHECK(f.player.scaleOrder() == std::vector<S>{S::FILL, S::ACTUAL, S::FIT, S::FIT_WIDTH, S::RESPONSIVE});
    CHECK(f.player.scale() == S::FILL);
  }
}

namespace {

// A root frame (1:1) whose rectangle (1:2) fades 100 → 0 over its timeline's first 500 ms (LINEAR; ONCE, 1 s), the
// track (7:1) on the internal canvas (docs/motion.md §4.2), and a second screen (1:3).
const char* kMotionFile = R"([
  {"guid":"0:0","phase":"CREATED","type":"DOCUMENT","name":"Document"},
  {"guid":"0:1","phase":"CREATED","type":"CANVAS","name":"Page 1","parentIndex":{"guid":"0:0","position":"!"}},
  {"guid":"0:2","phase":"CREATED","type":"CANVAS","name":"Internal Only Canvas","internalOnly":true,"visible":false,"parentIndex":{"guid":"0:0","position":"~"}},
  {"guid":"1:1","phase":"CREATED","type":"FRAME","name":"Root","parentIndex":{"guid":"0:1","position":"!"},
   "size":{"x":400,"y":300},"transform":{"m00":1,"m01":0,"m02":0,"m10":0,"m11":1,"m12":0},
   "timelineDuration":1000000,"playbackStyle":"ONCE","timelineKeyframeSnappingFps":{"numerator":60,"denominator":1}},
  {"guid":"1:2","phase":"CREATED","type":"ROUNDED_RECTANGLE","name":"Rect","parentIndex":{"guid":"1:1","position":"!"},
   "size":{"x":100,"y":50},"transform":{"m00":1,"m01":0,"m02":20,"m10":0,"m11":1,"m12":30},"opacity":1,
   "parameterConsumptionMap":{"entries":[
     {"variableField":"OPACITY","variableData":{"dataType":"EXPRESSION","resolvedDataType":"FLOAT","value":{"expressionValue":{"expressionFunction":"KEYFRAME","expressionArguments":[
       {"dataType":"FLOAT","resolvedDataType":"FLOAT","value":{"floatValue":100}},
       {"dataType":"KEYFRAME_TRACK_PARAMETER_DATA","resolvedDataType":"KEYFRAME_TRACK_PARAMETER_DATA","value":{"keyframeTrackParameterValue":{"parameters":[
         {"type":"MANUAL","value":{"manual":{"keyframeTrackId":{"guid":"7:1"},"timelineDefId":"1:1"}}}]}}}]}}}}]}},
  {"guid":"1:3","phase":"CREATED","type":"FRAME","name":"Other","parentIndex":{"guid":"0:1","position":"\""},
   "size":{"x":400,"y":300},"transform":{"m00":1,"m01":0,"m02":500,"m10":0,"m11":1,"m12":0}},
  {"guid":"7:1","phase":"CREATED","type":"KEYFRAME_TRACK","name":"OPACITY","parentIndex":{"guid":"0:2","position":"!"},"keyframeOperation":"SET"},
  {"guid":"7:4","phase":"CREATED","type":"KEYFRAME","parentIndex":{"guid":"7:1","position":"!"},"timelinePosition":0,
   "keyframeValue":{"value":{"floatValue":100},"valueType":"FLOAT"}},
  {"guid":"7:5","phase":"CREATED","type":"KEYFRAME","parentIndex":{"guid":"7:1","position":"\""},"timelinePosition":500000,
   "keyframeValue":{"value":{"floatValue":0},"valueType":"FLOAT"},"easingData":{"easingType":"LINEAR"}}
])";

}  // namespace

TEST_CASE("proto.wave4: the shown screen's Motion timeline plays; timeline actions pause it and set its playhead") {
  json::Value v;
  REQUIRE(json::parse(kMotionFile, v));
  Editor ed;
  ed.setSessionID(1);
  ed.setViewport(400, 300, 1, 400, 300);
  ed.loadDocument(codec::readChanges(v), Guid{0, 1});
  ed.takeEvents();
  proto::Player player{ed};
  const Guid root{1, 1}, rect{1, 2}, other{1, 3};
  REQUIRE(player.start(Guid{0, 1}, root));
  double t = 0;
  auto advance = [&](double ms) {
    for (; ms > 0; ms -= 16) player.tick(t += std::min(16.0, ms));
  };
  advance(16);
  CHECK(player.animating());
  advance(256);  // ~250 ms into it: half faded
  const Node* r = ed.document().get(rect);
  REQUIRE(r);
  CHECK(r->props.opacity == doctest::Approx(0.5).epsilon(0.1));
  advance(1200);  // Once: it stops at its end
  CHECK(r->props.opacity == doctest::Approx(0));
  CHECK_FALSE(player.animating());
  // Another screen: the timeline goes back to its base values.
  player.next();
  CHECK(player.screen() == other);
  CHECK(r->props.opacity == 1);
  player.stop();
  CHECK(r->props.opacity == 1);
}

TEST_CASE("proto.wave4: a phone's browser leaves the device out; the bare screen fills the width in its own colour") {
  auto nodes = screens("");
  for (auto& n : nodes) {
    if (n.guid == kPage) n.props.extra["prototypeDevice"] = extra("prototypeDevice", R"({"type":"PRESET","presetIdentifier":"SURFACE_PRO_8","size":{"x":1440,"y":960}})");
    if (n.guid == A) {
      Paint fill;
      fill.color = Color::hex(0x336699);
      n.props.fillPaints = {fill};
    }
  }
  Fixture f(nodes, 402, 780);
  REQUIRE(f.player.start(kPage, A));
  f.player.setDeviceFrame(false);  // as a phone's browser has it
  // The page's device: its 1440 × 960 screen, fitted to the width
  CHECK(f.player.screenRect().w == doctest::Approx(402));
  CHECK(f.player.screenRect().h == doctest::Approx(268));
  f.player.setIgnoreDevice(true);
  f.player.setScale(proto::ScaleMode::FIT_WIDTH);
  // The frame itself at 100 % (Fit width never grows it), in the middle
  CHECK(f.player.screenRect().x == doctest::Approx(14));
  CHECK(f.player.screenRect().w == doctest::Approx(375));
  CHECK(f.player.stateJson().find(R"("device":false)") != std::string::npos);
  f.player.setBare(true);
  // Bare: grown to the width, the window's height of it shown, the window around it the screen's colour
  CHECK(f.player.screenRect().x == doctest::Approx(0));
  CHECK(f.player.screenRect().w == doctest::Approx(402));
  CHECK(f.player.screenRect().h == doctest::Approx(780));
  CHECK(f.player.stateJson().find(R"("screenColor":"#336699")") != std::string::npos);
  f.player.setBare(false);
  f.player.setIgnoreDevice(false);
  CHECK(f.player.screenRect().w == doctest::Approx(402));
  CHECK(f.player.screenRect().h == doctest::Approx(268));
}
