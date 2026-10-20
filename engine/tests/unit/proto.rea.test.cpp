// Prototype playback pinned to Figma's viewer as read and measured in the REA prototype round (2026-10-20,
// docs/research/rea/prototype.md): live Figma's presentation sampled every 10 ms with a held clock — a 40 × 40 box
// Smart-animated from x 100 to x 260 over 1 s (After delay → Navigate) — and the viewer bundle's own reads.
#include <algorithm>
#include <cmath>

#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "proto/Player.h"
#include "proto/Prototype.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid A{3, 1}, B{3, 2}, BOXA{3, 3}, BOXB{3, 4};

std::string extra(const char* key, const std::string& text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  std::string bytes = codec::extraFromJson("NodeChange", key, v);
  REQUIRE(!bytes.empty());
  return bytes;
}

std::vector<proto::Interaction> read(const std::string& text) {
  NodeProps p;
  p.extra["prototypeInteractions"] = extra("prototypeInteractions", text);
  return proto::interactions(p);
}

// Screen A (box at x 100, opacity 1) navigates to B (box at x 260, opacity `toOpacity`) after 0.5 s, Smart animate
// over 1 s with `easing` (an easingType, and `fn` its easingFunction when not empty).
struct Fixture {
  Editor ed;
  proto::Player player{ed};
  double t = 0;
  Fixture(const char* easing, const char* fn = "", double toOpacity = 1) {
    auto nodes = baseChanges();
    NodeChange a = make(A, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "A");
    a.props.extra["prototypeInteractions"] = extra("prototypeInteractions",
        std::string(R"([{"id":"9:1","event":{"interactionType":"AFTER_TIMEOUT","transitionTimeout":0.5},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"NAVIGATE","transitionNodeID":"3:2","transitionType":"SMART_ANIMATE","transitionDuration":1,"easingType":")") +
            easing + "\"" + (*fn ? std::string(",\"easingFunction\":") + fn : std::string()) + "}]}]");
    nodes.push_back(a);
    nodes.push_back(make(B, NodeType::FRAME, kPage, "\"", {500, 0, 400, 300}, "B"));
    nodes.push_back(make(BOXA, NodeType::RECTANGLE, A, "!", {100, 130, 40, 40}, "Box"));
    NodeChange bb = make(BOXB, NodeType::RECTANGLE, B, "!", {260, 130, 40, 40}, "Box");
    bb.props.opacity = static_cast<float>(toOpacity);
    nodes.push_back(bb);
    ed.setSessionID(1);
    ed.setViewport(400, 300, 1, 400, 300);
    ed.loadDocument(nodes, kNoGuid);
    ed.takeEvents();
    REQUIRE(player.start(kPage, A));
    advance(16);
  }
  void advance(double ms) {
    while (ms > 0) {
      double step = std::min(10.0, ms);
      t += step;
      ms -= step;
      player.tick(t);
    }
  }
  // The box's x and opacity over the transition, every 10 ms until it has ended.
  std::vector<std::pair<double, double>> run() {
    std::vector<std::pair<double, double>> out;
    for (int i = 0; i < 200; i++) {
      advance(10);
      player.scene();
      if (const NodeProps* p = player.drawnProps(BOXB)) out.emplace_back(p->transform.m02, p->opacity);
    }
    return out;
  }
};

double maxX(const std::vector<std::pair<double, double>>& v) {
  double m = -1e9;
  for (auto& [x, o] : v) m = std::max(m, x);
  return m;
}
double minX(const std::vector<std::pair<double, double>>& v) {
  double m = 1e9;
  for (auto& [x, o] : v) m = std::min(m, x);
  return m;
}

}  // namespace

TEST_CASE("proto.rea: durations and delays as Figma's viewer reads them — missing → default, an explicit 0 stays 0") {
  auto list = read(R"([{"event":{"interactionType":"AFTER_TIMEOUT","transitionTimeout":0},"actions":[{"connectionType":"BACK","transitionType":"DISSOLVE","transitionDuration":0}]},
                       {"event":{"interactionType":"AFTER_TIMEOUT"},"actions":[{"connectionType":"BACK","transitionType":"DISSOLVE"}]},
                       {"event":{"interactionType":"MOUSE_ENTER","interactionMaintained":true,"interactionDuration":0},"actions":[]}])");
  REQUIRE(list.size() == 3);
  CHECK(list[0].timeout == 0);
  CHECK(list[0].actions[0].duration == 0);
  CHECK(list[1].timeout == doctest::Approx(0.8));
  CHECK(list[1].actions[0].duration == doctest::Approx(0.3));
  CHECK(list[2].delay == 0);
}

TEST_CASE("proto.rea: Smart animate follows an overshooting easing past the end (live Figma's peaks)") {
  // Measured in Figma (box travel 160 px, 10 ms samples): Ease out back peaks at +10.5 px, Gentle at +4.5, Quick at
  // +17, Bouncy at +58, Ease in back dips to −16 before it starts, Ease in and out back −9.5 / +9.5 — the curves'
  // own extremes (checked here: 270.56, 264.54, 277.35, 318.25, 83.74, 90.65 / 269.35).
  SUBCASE("Ease out back") {
    Fixture f("OUT_BACK_CUBIC");
    auto r = f.run();
    CHECK(maxX(r) == doctest::Approx(270.56).epsilon(0.003));
  }
  SUBCASE("Ease in back") {
    Fixture f("IN_BACK_CUBIC");
    auto r = f.run();
    CHECK(minX(r) == doctest::Approx(83.74).epsilon(0.01));
  }
  SUBCASE("Ease in and out back") {
    Fixture f("INOUT_BACK_CUBIC");
    auto r = f.run();
    CHECK(minX(r) == doctest::Approx(90.65).epsilon(0.01));
    CHECK(maxX(r) == doctest::Approx(269.35).epsilon(0.003));
  }
  SUBCASE("Gentle (1 / 100 / 15), Quick (1 / 300 / 20), Bouncy (1 / 600 / 15) over 1 s") {
    Fixture g("GENTLE_SPRING"), q("SPRING_PRESET_ONE"), b("SPRING_PRESET_TWO");
    CHECK(maxX(g.run()) == doctest::Approx(264.54).epsilon(0.003));
    CHECK(maxX(q.run()) == doctest::Approx(277.35).epsilon(0.003));
    CHECK(maxX(b.run()) == doctest::Approx(318.25).epsilon(0.003));
  }
}

TEST_CASE("proto.rea: opacity follows the overshoot but stays in [0, 1] (Figma: clamp(lerp(from, to, t), 0, 1))") {
  // Bouncy from opacity 1 to 0.1: the eased progress reaches ~1.36, the lerp −0.23 — drawn clear, never below.
  Fixture f("SPRING_PRESET_TWO", "", 0.1);
  auto r = f.run();
  CHECK(maxX(r) > 300);
  double lo = 1;
  for (auto& [x, o] : r) {
    CHECK(o >= 0);
    CHECK(o <= 1);
    lo = std::min(lo, o);
  }
  CHECK(lo == 0);
}

TEST_CASE("proto.rea: an interacted component's state follows to the same path on the next screen (stateManagementVersion 1)") {
  // Live Figma 2026-10-20: a Toggle (Off red / On green, On click Change to the other) on P1 clicked On, then Next →
  // P2's Toggle (same name) shows On; Back → P1's still On. "Reset component state" on the Next: P2's stays Off.
  const Guid SET{5, 1}, OFF{5, 2}, ON{5, 3}, P1{5, 10}, P2{5, 11}, T1{5, 12}, T2{5, 13}, NX{5, 14};
  auto build = [&](bool reset) {
    auto nodes = baseChanges();
    NodeChange set = make(SET, NodeType::FRAME, kPage, "~", {0, 1000, 300, 100}, "Toggle");
    set.props.comp().isStateGroup = true;
    nodes.push_back(set);
    NodeChange off = make(OFF, NodeType::SYMBOL, SET, "!", {20, 20, 100, 40}, "State=Off");
    off.props.extra["prototypeInteractions"] = extra("prototypeInteractions",
        R"([{"id":"9:3","stateManagementVersion":1,"event":{"interactionType":"ON_CLICK"},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"SWAP_STATE","transitionNodeID":"5:3","transitionType":"INSTANT_TRANSITION"}]}])");
    nodes.push_back(off);
    NodeChange on = make(ON, NodeType::SYMBOL, SET, "\"", {150, 20, 100, 40}, "State=On");
    on.props.extra["prototypeInteractions"] = extra("prototypeInteractions",
        R"([{"id":"9:4","stateManagementVersion":1,"event":{"interactionType":"ON_CLICK"},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"SWAP_STATE","transitionNodeID":"5:2","transitionType":"INSTANT_TRANSITION"}]}])");
    nodes.push_back(on);
    nodes.push_back(make(P1, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "P1"));
    nodes.push_back(make(P2, NodeType::FRAME, kPage, "\"", {500, 0, 400, 300}, "P2"));
    for (auto [id, parent] : {std::pair{T1, P1}, std::pair{T2, P2}}) {
      NodeChange t = make(id, NodeType::INSTANCE, parent, "!", {20, 20, 100, 40}, "Toggle");
      t.props.comp().symbolData.symbolID = OFF;
      nodes.push_back(t);
    }
    NodeChange nx = make(NX, NodeType::RECTANGLE, P1, "\"", {20, 200, 100, 40}, "Next");
    nx.props.extra["prototypeInteractions"] = extra("prototypeInteractions",
        std::string(R"([{"id":"9:5","stateManagementVersion":1,"event":{"interactionType":"ON_CLICK"},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"NAVIGATE","transitionNodeID":"5:11","transitionType":"INSTANT_TRANSITION","transitionResetInteractiveComponents":)") +
            (reset ? "true" : "false") + "}]}]");
    nodes.push_back(nx);
    return nodes;
  };
  for (bool reset : {false, true}) {
    CAPTURE(reset);
    Editor ed;
    proto::Player player{ed};
    ed.setSessionID(1);
    ed.setViewport(400, 300, 1, 400, 300);
    ed.loadDocument(build(reset), kNoGuid);
    ed.takeEvents();
    REQUIRE(player.start(kPage, P1));
    auto click = [&](double x, double y) {
      player.pointer(PointerEvent::MOVE, x, y, 0, 0);
      player.pointer(PointerEvent::DOWN, x, y, 1, 0);
      player.pointer(PointerEvent::UP, x, y, 0, 0);
    };
    click(70, 40);
    REQUIRE(ed.mainOf(T1) == ON);
    click(70, 220);
    REQUIRE(player.screen() == P2);
    CHECK(ed.mainOf(T2) == (reset ? OFF : ON));
    player.restart();
    CHECK(ed.mainOf(T1) == OFF);
    CHECK(ed.mainOf(T2) == OFF);
  }
}

TEST_CASE("proto.rea: a scrolled list keeps its offset on the next screen's same-named list (stateManagementVersion 1)") {
  // Live Figma 2026-10-20: "List" (400 × 250, vertical overflow, 800 tall content) scrolled 200 on A, Next → B's List
  // shows offset 200; with "Reset scroll position", 0.
  const Guid A1{6, 1}, B1{6, 2}, LA{6, 3}, LB{6, 4}, CA{6, 5}, CB{6, 6}, NX{6, 7};
  auto build = [&](bool reset) {
    auto nodes = baseChanges();
    nodes.push_back(make(A1, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "SC A"));
    nodes.push_back(make(B1, NodeType::FRAME, kPage, "\"", {500, 0, 400, 300}, "SC B"));
    for (auto [l, c, parent] : {std::tuple{LA, CA, A1}, std::tuple{LB, CB, B1}}) {
      NodeChange list = make(l, NodeType::FRAME, parent, "!", {0, 0, 400, 250}, "List");
      list.props.extra["scrollDirection"] = extra("scrollDirection", R"("VERTICAL")");
      list.props.frameMaskDisabled = false;
      nodes.push_back(list);
      nodes.push_back(make(c, NodeType::RECTANGLE, l, "!", {0, 0, 400, 800}, "Band"));
    }
    NodeChange nx = make(NX, NodeType::RECTANGLE, A1, "\"", {20, 255, 100, 40}, "Next");
    nx.props.extra["prototypeInteractions"] = extra("prototypeInteractions",
        std::string(R"([{"id":"9:6","stateManagementVersion":1,"event":{"interactionType":"ON_CLICK"},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"NAVIGATE","transitionNodeID":"6:2","transitionType":"INSTANT_TRANSITION","transitionResetScrollPosition":)") +
            (reset ? "true" : "false") + "}]}]");
    nodes.push_back(nx);
    return nodes;
  };
  for (bool reset : {false, true}) {
    CAPTURE(reset);
    Editor ed;
    proto::Player player{ed};
    ed.setSessionID(1);
    ed.setViewport(400, 300, 1, 400, 300);
    ed.loadDocument(build(reset), kNoGuid);
    ed.takeEvents();
    REQUIRE(player.start(kPage, A1));
    double t = 0;
    for (int i = 0; i < 3; i++) player.tick(t += 16);
    for (int i = 0; i < 4; i++) {
      player.wheel(200, 120, 0, 50);
      player.tick(t += 16);
    }
    for (int i = 0; i < 60; i++) player.tick(t += 16);
    REQUIRE(player.scrollOf(LA).y == doctest::Approx(200).epsilon(0.01));
    player.pointer(PointerEvent::MOVE, 70, 275, 0, 0);
    player.pointer(PointerEvent::DOWN, 70, 275, 1, 0);
    player.pointer(PointerEvent::UP, 70, 275, 0, 0);
    REQUIRE(player.screen() == B1);
    CHECK(player.scrollOf(LB).y == doctest::Approx(reset ? 0 : 200).epsilon(0.01));
  }
}

TEST_CASE("proto.rea: Mouse enter fires outer to inner and the first that acts ends the round; While hovering only then") {
  // Figma's viewer (`mP` @~1575000): leaves inner → outer, enters outer → inner, stop at the first state change; While
  // hovering only when no enter / leave did anything, on the deepest hover hotspot. A NONE trigger plays as On click.
  const Guid S1{7, 1}, S2{7, 2}, S3{7, 3}, OUTER{7, 4}, INNER{7, 5};
  auto navTo = [](const char* trigger, const char* dest) {
    return std::string(R"([{"event":{"interactionType":")") + trigger +
           R"("},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"NAVIGATE","transitionNodeID":")" + dest +
           R"(","transitionType":"INSTANT_TRANSITION"}]}])";
  };
  auto nodes = baseChanges();
  nodes.push_back(make(S1, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "S1"));
  nodes.push_back(make(S2, NodeType::FRAME, kPage, "\"", {500, 0, 400, 300}, "S2"));
  nodes.push_back(make(S3, NodeType::FRAME, kPage, "#", {1000, 0, 400, 300}, "S3"));
  NodeChange outer = make(OUTER, NodeType::FRAME, S1, "!", {50, 50, 300, 200}, "Outer");
  outer.props.extra["prototypeInteractions"] = extra("prototypeInteractions", navTo("MOUSE_ENTER", "7:2"));
  nodes.push_back(outer);
  NodeChange inner = make(INNER, NodeType::RECTANGLE, OUTER, "!", {50, 50, 100, 50}, "Inner");
  inner.props.extra["prototypeInteractions"] = extra("prototypeInteractions", navTo("MOUSE_ENTER", "7:3"));
  nodes.push_back(inner);
  Editor ed;
  proto::Player player{ed};
  ed.setSessionID(1);
  ed.setViewport(400, 300, 1, 400, 300);
  ed.loadDocument(nodes, kNoGuid);
  ed.takeEvents();
  REQUIRE(player.start(kPage, S1));
  // Straight onto Inner: Outer's Mouse enter runs first and ends the round.
  player.pointer(PointerEvent::MOVE, 150, 120, 0, 0);
  CHECK(player.screen() == S2);

  // NONE reads as On click.
  auto none = read(navTo("NONE", "7:2"));
  REQUIRE(none.size() == 1);
  CHECK(none[0].trigger == proto::Trigger::NONE);  // stored as it came
}

TEST_CASE("proto.rea: an overlay opened with Push, Slide in or Fade appears at once; Move in animates") {
  const Guid S1{8, 1}, OV{8, 2}, BTN{8, 3};
  for (auto [type, animates] : {std::pair{"PUSH_FROM_LEFT", false}, std::pair{"SLIDE_FROM_RIGHT", false}, std::pair{"FADE", false},
                                std::pair{"MOVE_FROM_BOTTOM", true}, std::pair{"DISSOLVE", true}}) {
    CAPTURE(type);
    auto nodes = baseChanges();
    nodes.push_back(make(S1, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "S1"));
    nodes.push_back(make(OV, NodeType::FRAME, kPage, "\"", {500, 0, 200, 100}, "Sheet"));
    NodeChange b = make(BTN, NodeType::RECTANGLE, S1, "!", {20, 20, 100, 40}, "Open");
    b.props.extra["prototypeInteractions"] = extra("prototypeInteractions",
        std::string(R"([{"event":{"interactionType":"ON_CLICK"},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"OVERLAY","transitionNodeID":"8:2","transitionType":")") +
            type + R"(","transitionDuration":0.5}]}])");
    nodes.push_back(b);
    Editor ed;
    proto::Player player{ed};
    ed.setSessionID(1);
    ed.setViewport(400, 300, 1, 400, 300);
    ed.loadDocument(nodes, kNoGuid);
    ed.takeEvents();
    REQUIRE(player.start(kPage, S1));
    player.tick(16);
    player.pointer(PointerEvent::MOVE, 50, 40, 0, 0);
    player.pointer(PointerEvent::DOWN, 50, 40, 1, 0);
    player.pointer(PointerEvent::UP, 50, 40, 0, 0);
    REQUIRE(player.overlays().size() == 1);
    CHECK(player.animating() == animates);
  }
}

TEST_CASE("proto.rea: a matched layer whose shape kind changed dissolves while it moves (rectangle → ellipse)") {
  // Live Figma: "Shape", a rectangle at (20, 60), and "Shape", an ellipse at (300, 60), Smart animate Linear 1 s — half
  // way both are at x 160, the rectangle's corners half faded; not a fade in place.
  const Guid SA{4, 1}, SB{4, 2}, RECT{4, 3}, ELL{4, 4};
  Editor ed;
  proto::Player player{ed};
  auto nodes = baseChanges();
  NodeChange a = make(SA, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "A");
  a.props.extra["prototypeInteractions"] = extra("prototypeInteractions",
      R"([{"id":"9:2","event":{"interactionType":"AFTER_TIMEOUT","transitionTimeout":0.5},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"NAVIGATE","transitionNodeID":"4:2","transitionType":"SMART_ANIMATE","transitionDuration":1,"easingType":"LINEAR"}]}])");
  nodes.push_back(a);
  nodes.push_back(make(SB, NodeType::FRAME, kPage, "\"", {500, 0, 400, 300}, "B"));
  nodes.push_back(make(RECT, NodeType::RECTANGLE, SA, "!", {20, 60, 40, 40}, "Shape"));
  nodes.push_back(make(ELL, NodeType::ELLIPSE, SB, "!", {300, 60, 40, 40}, "Shape"));
  ed.setSessionID(1);
  ed.setViewport(400, 300, 1, 400, 300);
  ed.loadDocument(nodes, kNoGuid);
  ed.takeEvents();
  REQUIRE(player.start(kPage, SA));
  double t = 0;
  auto advance = [&](double ms) {
    for (; ms > 0; ms -= 10) player.tick(t += std::min(10.0, ms));
  };
  advance(16);
  // The transition's start: the first frame the ellipse is drawn.
  int i = 0;
  for (; i < 200; i++) {
    advance(10);
    player.scene();
    if (player.drawnProps(ELL)) break;
  }
  REQUIRE(i < 200);
  advance(490);
  player.scene();
  const NodeProps* e = player.drawnProps(ELL);
  const NodeProps* r = player.drawnProps(RECT);
  REQUIRE(e);
  REQUIRE(r);
  // Half way (one frame either side): both on the same path, one fading in as the other fades out.
  CHECK(e->transform.m02 == doctest::Approx(r->transform.m02));
  CHECK(e->transform.m02 == doctest::Approx(160).epsilon(0.06));
  CHECK(e->opacity + r->opacity == doctest::Approx(1).epsilon(0.01));
  CHECK(e->opacity == doctest::Approx(0.5).epsilon(0.08));
}
