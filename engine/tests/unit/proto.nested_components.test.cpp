// Interactive components inside interactive components, three levels deep (docs/engine.md §3.4 "Nested interactive
// components"; the owner's "finder": homesearch → finder-segmented → Segment-control-finder / search-input, 2026-10-21).
// A Card (Rest / Hover, While hovering) holds a Panel (P1 / P2, its "Next" / "Back" change the Panel) holding a Toggle
// (Off / On, its own click), a Badge (Grey / Red / Blue: P1 designs Grey, P2 Red) and a Chip (Idle / Hot, While
// hovering). Two Cards side by side.
#include <algorithm>
#include <cmath>
#include <functional>

#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "proto/Player.h"
#include "proto/Prototype.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid TSET{8, 1}, OFF{8, 2}, ON{8, 3}, BSET{8, 10}, GREY{8, 11}, RED{8, 12}, BLUE{8, 13}, CSET{8, 20}, IDLE{8, 21}, HOT{8, 22},
    PSET{8, 30}, P1{8, 31}, P2{8, 32}, KSET{8, 40}, REST{8, 41}, HOVER{8, 42}, SCREEN{8, 50}, CARD1{8, 51}, CARD2{8, 52};

std::string extra(const char* key, const std::string& text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  std::string bytes = codec::extraFromJson("NodeChange", key, v);
  REQUIRE(!bytes.empty());
  return bytes;
}

std::string changeTo(Guid dest, const char* trigger = "ON_CLICK", const char* transition = "INSTANT_TRANSITION", double duration = 0.3) {
  return std::string(R"([{"id":"9:)") + std::to_string(dest.localID) + R"(","stateManagementVersion":1,"event":{"interactionType":")" + trigger +
         R"("},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"SWAP_STATE","transitionNodeID":")" + dest.toString() +
         R"(","transitionType":")" + transition + R"(","transitionDuration":)" + std::to_string(duration) + R"(,"easingType":"LINEAR"}]}])";
}

struct Nested {
  Editor ed;
  proto::Player player{ed};
  double t = 0;
  uint32_t next = 100;

  Nested() {
    auto nodes = baseChanges();
    auto set = [&](Guid id, double y, const char* name) {
      NodeChange s = make(id, NodeType::FRAME, kPage, "~" + std::to_string(id.localID), {0, y, 400, 100}, name);
      s.props.comp().isStateGroup = true;
      nodes.push_back(s);
    };
    auto variant = [&](Guid id, Guid parent, const std::string& pos, Rect r, const char* name, const std::string& ix = "") {
      NodeChange v = make(id, NodeType::SYMBOL, parent, pos, r, name);
      if (!ix.empty()) v.props.extra["prototypeInteractions"] = extra("prototypeInteractions", ix);
      nodes.push_back(v);
    };
    auto rect = [&](Guid parent, const std::string& pos, Rect r, const char* name, const std::string& ix = "", double opacity = 1) {
      NodeChange c = make(Guid{9, next++}, NodeType::RECTANGLE, parent, pos, r, name);
      c.props.opacity = static_cast<float>(opacity);
      if (!ix.empty()) c.props.extra["prototypeInteractions"] = extra("prototypeInteractions", ix);
      nodes.push_back(c);
    };
    auto instance = [&](Guid id, Guid parent, const std::string& pos, Rect r, const char* name, Guid main) {
      NodeChange c = make(id == kNoGuid ? Guid{9, next++} : id, NodeType::INSTANCE, parent, pos, r, name);
      c.props.comp().symbolData.symbolID = main;
      c.props.fillPaints.clear();
      nodes.push_back(c);
    };
    // Level 3: Toggle (its own click), Badge (a click → Blue), Chip (While hovering → Hot, Smart animate).
    set(TSET, 2000, "Toggle");
    variant(OFF, TSET, "!", {0, 0, 40, 20}, "State=Off", changeTo(ON));
    rect(OFF, "!", {0, 0, 20, 20}, "Knob");
    variant(ON, TSET, "\"", {60, 0, 40, 20}, "State=On", changeTo(OFF));
    rect(ON, "!", {20, 0, 20, 20}, "Knob");
    set(BSET, 2100, "Badge");
    for (auto [id, pos, x, name] : {std::tuple{GREY, "!", 0.0, "Color=Grey"}, std::tuple{RED, "\"", 40.0, "Color=Red"}, std::tuple{BLUE, "#", 80.0, "Color=Blue"}}) {
      variant(id, BSET, pos, {x, 0, 20, 20}, name, id == BLUE ? "" : changeTo(BLUE));
      rect(id, "!", {0, 0, 20, 20}, "Dot");
    }
    set(CSET, 2200, "Chip");
    variant(IDLE, CSET, "!", {0, 0, 40, 20}, "State=Idle", changeTo(HOT, "ON_HOVER", "SMART_ANIMATE", 0.4));
    rect(IDLE, "!", {0, 0, 10, 20}, "Dot");
    variant(HOT, CSET, "\"", {60, 0, 40, 20}, "State=Hot");
    rect(HOT, "!", {30, 0, 10, 20}, "Dot");
    // Level 2: Panel — P1 / P2, each with the three, and a button that changes the Panel (a layer inside it).
    set(PSET, 2300, "Panel");
    for (auto [id, pos, x, badge, button, dest] : {std::tuple{P1, "!", 0.0, GREY, "Next", P2}, std::tuple{P2, "\"", 220.0, RED, "Back", P1}}) {
      variant(id, PSET, pos, {x, 0, 200, 100}, id == P1 ? "Page=1" : "Page=2");
      instance(kNoGuid, id, "!", {10, 10, 40, 20}, "Toggle", OFF);
      instance(kNoGuid, id, "\"", {60, 10, 20, 20}, "Badge", badge);
      instance(kNoGuid, id, "#", {100, 10, 40, 20}, "Chip", IDLE);
      rect(id, "$", {10, 60, 40, 20}, button, changeTo(dest));
    }
    // Level 1: Card — Rest / Hover (While hovering, Smart animate: the background fades to 0.5).
    set(KSET, 2500, "Card");
    for (auto [id, pos, x] : {std::tuple{REST, "!", 0.0}, std::tuple{HOVER, "\"", 320.0}}) {
      variant(id, KSET, pos, {x, 0, 300, 150}, id == REST ? "State=Rest" : "State=Hover", id == REST ? changeTo(HOVER, "ON_HOVER", "SMART_ANIMATE", 0.4) : "");
      rect(id, "!", {0, 0, 300, 150}, "Bg", "", id == REST ? 1 : 0.5);
      instance(kNoGuid, id, "\"", {50, 25, 200, 100}, "Panel", P1);
    }
    nodes.push_back(make(SCREEN, NodeType::FRAME, kPage, "!", {0, 0, 800, 400}, "Screen"));
    instance(CARD1, SCREEN, "!", {20, 20, 300, 150}, "Card", REST);
    instance(CARD2, SCREEN, "\"", {400, 20, 300, 150}, "Card", REST);
    ed.setSessionID(1);
    ed.setViewport(800, 400, 1, 800, 400);
    ed.loadDocument(nodes, kNoGuid);
    ed.takeEvents();
    REQUIRE(player.start(kPage, SCREEN));
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
  // The layer at a name path under `root` (ids inside instances change with their parents' variants: found anew).
  Guid at(Guid root, std::initializer_list<const char*> names) {
    Guid cur = root;
    for (const char* name : names) {
      Guid found = kNoGuid;
      for (Guid c : ed.document().children(cur))
        if (ed.document().get(c)->props.name == name) {
          found = c;
          break;
        }
      REQUIRE(found != kNoGuid);
      cur = found;
    }
    return cur;
  }
  Guid shows(Guid root, std::initializer_list<const char*> names) { return ed.mainOf(at(root, names)); }
  // The screen is at the page's origin, shown 1:1.
  Vec2 centre(Guid id) {
    Mat2x3 m = ed.document().worldTransform(id);
    const NodeProps& p = ed.document().get(id)->props;
    return {m.m02 + p.size.x / 2, m.m12 + p.size.y / 2};
  }
  void move(Vec2 p) { player.pointer(PointerEvent::MOVE, p.x, p.y, 0, 0); }
  void click(Guid id) {
    Vec2 p = centre(id);
    move(p);
    advance(500);
    player.pointer(PointerEvent::DOWN, p.x, p.y, 1, 0);
    player.pointer(PointerEvent::UP, p.x, p.y, 0, 0);
    advance(500);
  }
};

}  // namespace

TEST_CASE("proto.nested: a click acts on the deepest reaction at every level; inner states survive outer changes") {
  Nested f;
  // Level 3: the Toggle's own click (the Card hovers meanwhile: an outer change while the pointer is over it).
  f.click(f.at(CARD1, {"Panel", "Toggle"}));
  CHECK(f.ed.mainOf(CARD1) == HOVER);
  CHECK(f.shows(CARD1, {"Panel", "Toggle"}) == ON);
  // Level 2: "Next", a layer inside the Panel, changes the Panel (the closest instance of its set) — the Toggle's On
  // stays (P2 designs it as P1 does) and the Card stays hovered.
  f.click(f.at(CARD1, {"Panel", "Next"}));
  CHECK(f.shows(CARD1, {"Panel"}) == P2);
  CHECK(f.shows(CARD1, {"Panel", "Toggle"}) == ON);
  CHECK(f.ed.mainOf(CARD1) == HOVER);
  f.click(f.at(CARD1, {"Panel", "Back"}));
  CHECK(f.shows(CARD1, {"Panel"}) == P1);
  CHECK(f.shows(CARD1, {"Panel", "Toggle"}) == ON);
  // Level 3 again after the Panel came back: toggles off, the Panel stays.
  f.click(f.at(CARD1, {"Panel", "Toggle"}));
  CHECK(f.shows(CARD1, {"Panel", "Toggle"}) == OFF);
  CHECK(f.shows(CARD1, {"Panel"}) == P1);
  // Leaving the Card: Rest again, the states inside it kept.
  f.click(f.at(CARD1, {"Panel", "Toggle"}));
  f.move({790, 390});
  f.advance(500);
  CHECK(f.ed.mainOf(CARD1) == REST);
  CHECK(f.shows(CARD1, {"Panel", "Toggle"}) == ON);
  CHECK(f.shows(CARD1, {"Panel"}) == P1);
}

TEST_CASE("proto.nested: two instances of the same component side by side keep separate states") {
  Nested f;
  f.click(f.at(CARD1, {"Panel", "Toggle"}));
  f.click(f.at(CARD2, {"Panel", "Next"}));
  CHECK(f.shows(CARD1, {"Panel"}) == P1);
  CHECK(f.shows(CARD1, {"Panel", "Toggle"}) == ON);
  CHECK(f.shows(CARD2, {"Panel"}) == P2);
  CHECK(f.shows(CARD2, {"Panel", "Toggle"}) == OFF);
  f.move({790, 390});
  f.advance(500);
  CHECK(f.ed.mainOf(CARD1) == REST);
  CHECK(f.ed.mainOf(CARD2) == REST);
}

TEST_CASE("proto.nested: a nested layer the outer variants design differently follows the outer state") {
  // P1 designs the Badge Grey, P2 Red: a Badge clicked Blue on P1 shows Red on P2 (the Panel's state drives it, as a
  // prop would), and Grey back on P1 — the Toggle, designed alike in both, keeps its own state.
  Nested f;
  f.click(f.at(CARD1, {"Panel", "Badge"}));
  CHECK(f.shows(CARD1, {"Panel", "Badge"}) == BLUE);
  f.click(f.at(CARD1, {"Panel", "Toggle"}));
  f.click(f.at(CARD1, {"Panel", "Next"}));
  CHECK(f.shows(CARD1, {"Panel", "Badge"}) == RED);
  CHECK(f.shows(CARD1, {"Panel", "Toggle"}) == ON);
  f.click(f.at(CARD1, {"Panel", "Back"}));
  CHECK(f.shows(CARD1, {"Panel", "Badge"}) == GREY);
  CHECK(f.shows(CARD1, {"Panel", "Toggle"}) == ON);
}

TEST_CASE("proto.nested: While hovering applies at every level under the pointer, like CSS :hover") {
  Nested f;
  f.click(f.at(CARD1, {"Panel", "Toggle"}));  // a state of its own, to see it kept through the hovers
  // Onto the Chip: the Card and the Chip both hover (Figma: the deepest only).
  f.move(f.centre(f.at(CARD1, {"Panel", "Chip"})));
  f.advance(500);
  CHECK(f.ed.mainOf(CARD1) == HOVER);
  CHECK(f.shows(CARD1, {"Panel", "Chip"}) == HOT);
  // Off the Chip, still on the Card: the Chip goes back, the Card stays hovered.
  f.move({30, 30});
  f.advance(500);
  CHECK(f.shows(CARD1, {"Panel", "Chip"}) == IDLE);
  CHECK(f.ed.mainOf(CARD1) == HOVER);
  // Back onto the Chip, then straight out: both go back.
  f.move(f.centre(f.at(CARD1, {"Panel", "Chip"})));
  f.advance(500);
  CHECK(f.shows(CARD1, {"Panel", "Chip"}) == HOT);
  f.move({790, 390});
  f.advance(500);
  CHECK(f.ed.mainOf(CARD1) == REST);
  CHECK(f.shows(CARD1, {"Panel", "Chip"}) == IDLE);
  CHECK(f.shows(CARD1, {"Panel", "Toggle"}) == ON);
  CHECK(f.ed.mainOf(CARD2) == REST);
}

TEST_CASE("proto.nested: Smart animate runs at each level at once") {
  Nested f;
  // From outside straight onto the Chip: the Card's background fades to 0.5 and the Chip's dot slides 0 → 30, both over
  // 0.4 s, together.
  Vec2 chip = f.centre(f.at(CARD1, {"Panel", "Chip"}));
  f.move(chip);
  f.advance(200);
  f.player.scene();
  const NodeProps* bg = f.player.drawnProps(f.at(CARD1, {"Bg"}));
  const NodeProps* dot = f.player.drawnProps(f.at(CARD1, {"Panel", "Chip", "Dot"}));
  REQUIRE(bg);
  REQUIRE(dot);
  CHECK(bg->opacity == doctest::Approx(0.75).epsilon(0.1));
  CHECK(dot->transform.m02 == doctest::Approx(15).epsilon(0.15));
  f.advance(400);
  f.player.scene();
  CHECK(f.ed.document().get(f.at(CARD1, {"Bg"}))->props.opacity == doctest::Approx(0.5));
  CHECK(f.ed.document().get(f.at(CARD1, {"Panel", "Chip", "Dot"}))->props.transform.m02 == doctest::Approx(30));
}

TEST_CASE("proto.nested: hits follow Canvas stacking \"First on top\"") {
  // The owner's "homesearch": an auto-layout frame stacking first on top, its first child ("finder-segmented", absolute)
  // over the second ("adv-banner"). The player read children last-first: every click on the segments went to the banner.
  const Guid S{10, 1}, X{10, 2}, Y{10, 3}, F{10, 4}, TOP{10, 5}, BELOW{10, 6};
  auto nodes = baseChanges();
  nodes.push_back(make(S, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "S"));
  nodes.push_back(make(X, NodeType::FRAME, kPage, "\"", {500, 0, 400, 300}, "X"));
  nodes.push_back(make(Y, NodeType::FRAME, kPage, "#", {1000, 0, 400, 300}, "Y"));
  NodeChange frame = make(F, NodeType::FRAME, S, "!", {0, 0, 200, 200}, "homesearch");
  frame.props.stack().stackMode = StackMode::VERTICAL;
  frame.props.stack().stackReverseZIndex = true;
  nodes.push_back(frame);
  auto go = [](Guid dest) {
    return std::string(R"([{"event":{"interactionType":"ON_CLICK"},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"NAVIGATE","transitionNodeID":")") +
           dest.toString() + R"(","transitionType":"INSTANT_TRANSITION"}]}])";
  };
  NodeChange top = make(TOP, NodeType::RECTANGLE, F, "!", {0, 100, 200, 50}, "finder-segmented");
  top.props.stackPositioning = StackPositioning::ABSOLUTE;
  top.props.extra["prototypeInteractions"] = extra("prototypeInteractions", go(X));
  nodes.push_back(top);
  NodeChange below = make(BELOW, NodeType::RECTANGLE, F, "\"", {0, 0, 200, 200}, "adv-banner");
  below.props.extra["prototypeInteractions"] = extra("prototypeInteractions", go(Y));
  nodes.push_back(below);
  Editor ed;
  proto::Player player{ed};
  ed.setSessionID(1);
  ed.setViewport(400, 300, 1, 400, 300);
  ed.loadDocument(nodes, kNoGuid);
  ed.takeEvents();
  REQUIRE(player.start(kPage, S));
  REQUIRE(ed.document().paintsBefore(BELOW, TOP));
  player.pointer(PointerEvent::MOVE, 100, 125, 0, 0);
  player.pointer(PointerEvent::DOWN, 100, 125, 1, 0);
  player.pointer(PointerEvent::UP, 100, 125, 0, 0);
  CHECK(player.screen() == X);
}

TEST_CASE("proto.nested: a segmented control's indicator slides between its variants (Smart animate)") {
  // The Wecra Design System's Segmented (2026-10-23): a 160 × 24 row of two 80-wide items with an absolute
  // "indicator" under them (constraints Scale), at x 0 in Selected=1 and 80 in Selected=2; Item 2's click Changes to
  // Selected=2 with Smart animate: the indicator slides 0 → 80 (one layer, matched by name), not swapped at once.
  const Guid SEG{7, 1}, S1{7, 2}, S2{7, 3}, SCR{7, 10}, INST{7, 11};
  auto nodes = baseChanges();
  uint32_t next = 100;
  NodeChange set = make(SEG, NodeType::FRAME, kPage, "~", {0, 1000, 400, 100}, "Segmented");
  set.props.comp().isStateGroup = true;
  nodes.push_back(set);
  for (auto [id, pos, x, sel] : {std::tuple{S1, "!", 0.0, 1}, std::tuple{S2, "\"", 200.0, 2}}) {
    NodeChange v = make(id, NodeType::SYMBOL, SEG, pos, {x, 0, 160, 24}, sel == 1 ? "Selected=1" : "Selected=2");
    v.props.stack().stackMode = StackMode::HORIZONTAL;
    nodes.push_back(v);
    NodeChange ind = make(Guid{9, next++}, NodeType::FRAME, id, "!", {sel == 1 ? 0.0 : 80.0, 0, 80, 24}, "indicator");
    ind.props.stackPositioning = StackPositioning::ABSOLUTE;
    ind.props.horizontalConstraint = ConstraintType::SCALE;
    nodes.push_back(ind);
    for (int i = 1; i <= 2; i++) {
      NodeChange item = make(Guid{9, next++}, NodeType::FRAME, id, i == 1 ? "\"" : "#", {(i - 1) * 80.0, 0, 80, 24}, i == 1 ? "Item 1" : "Item 2");
      item.props.stackChildPrimaryGrow = 1;
      Guid other = sel == 1 ? S2 : S1;
      if (i != sel) item.props.extra["prototypeInteractions"] = extra("prototypeInteractions", changeTo(other, "ON_CLICK", "SMART_ANIMATE", 0.2));
      nodes.push_back(item);
    }
  }
  nodes.push_back(make(SCR, NodeType::FRAME, kPage, "!", {0, 0, 400, 100}, "Screen"));
  NodeChange inst = make(INST, NodeType::INSTANCE, SCR, "!", {10, 10, 160, 24}, "Segmented");
  inst.props.comp().symbolData.symbolID = S1;
  inst.props.fillPaints.clear();
  nodes.push_back(inst);
  Editor ed;
  proto::Player player{ed};
  ed.setSessionID(1);
  ed.setViewport(400, 100, 1, 400, 100);
  ed.loadDocument(nodes, kNoGuid);
  ed.takeEvents();
  auto child = [&](const char* name) {
    for (Guid c : ed.document().children(INST))
      if (ed.document().get(c)->props.name == name) return c;
    FAIL("no " << name);
    return kNoGuid;
  };
  Guid ind = child("indicator");
  CHECK(ed.document().get(ind)->props.size.x == doctest::Approx(80));
  CHECK(ed.document().get(ind)->props.transform.m02 == doctest::Approx(0));
  REQUIRE(player.start(kPage, SCR));
  double t = 0;
  auto advance = [&](double ms) {
    while (ms > 0) {
      double step = std::min(10.0, ms);
      t += step;
      ms -= step;
      player.tick(t);
    }
  };
  advance(16);
  // Item 2's middle: 10 + 80 + 40, 10 + 12
  player.pointer(PointerEvent::MOVE, 130, 22, 0, 0);
  player.pointer(PointerEvent::DOWN, 130, 22, 1, 0);
  player.pointer(PointerEvent::UP, 130, 22, 0, 0);
  REQUIRE(ed.mainOf(INST) == S2);
  advance(100);  // half way (linear, 0.2 s)
  player.scene();
  ind = child("indicator");
  const NodeProps* mid = player.drawnProps(ind);
  REQUIRE(mid);
  CHECK(mid->transform.m02 > 20);
  CHECK(mid->transform.m02 < 60);
  advance(300);
  player.scene();
  CHECK(ed.document().get(child("indicator"))->props.transform.m02 == doctest::Approx(80));
}
