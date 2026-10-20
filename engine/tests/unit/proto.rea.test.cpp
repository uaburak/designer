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
