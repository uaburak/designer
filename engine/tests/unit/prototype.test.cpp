// Prototyping (E8, docs/engine-build.md "E8"): the schema's prototype fields read and written, easing, the player's
// navigation stack, overlays, triggers, Smart animate's layer matching and interpolation, Change to, scrolling,
// After delay, and prototype mode's connections on the canvas (noodle drags).
#include <cmath>
#include <functional>

#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "gfx/null/NullDevice.h"
#include "proto/Player.h"
#include "proto/Prototype.h"
#include "render/Renderer.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

// Three screens 375 × 812 side by side: A (1:1), B (1:2), C (1:3); on A a button "Next" (1:11) and a box "Card"
// (1:12) with a "Title" (1:13); on B the same Card further down and bigger, and a "Back" button (1:21).
const Guid A{1, 1}, B{1, 2}, C{1, 3}, NEXT{1, 11}, CARD{1, 12}, TITLE{1, 13}, CARD_B{1, 22}, TITLE_B{1, 23}, BACK{1, 21}, OVL{1, 4},
    OVL_CLOSE{1, 41};

std::string extra(const char* key, const std::string& json) {
  json::Value v;
  REQUIRE(json::parse(json, v));
  std::string bytes = codec::extraFromJson("NodeChange", key, v);
  REQUIRE(!bytes.empty());
  return bytes;
}

std::string nav(Guid dest, const char* trigger = "ON_CLICK", const char* nav = "NAVIGATE", const char* transition = "INSTANT_TRANSITION",
                double duration = 0.3, const std::string& more = "") {
  return std::string("[{\"id\":\"9:") + std::to_string(dest.localID) + "\",\"event\":{\"interactionType\":\"" + trigger +
         "\"},\"actions\":[{\"connectionType\":\"INTERNAL_NODE\",\"navigationType\":\"" + nav + "\",\"transitionNodeID\":\"" +
         dest.toString() + "\",\"transitionType\":\"" + transition + "\",\"transitionDuration\":" + std::to_string(duration) +
         ",\"easingType\":\"LINEAR\"" + more + "}]}]";
}

std::vector<NodeChange> screens() {
  auto nodes = baseChanges();
  nodes.push_back(make(A, NodeType::FRAME, kPage, "!", {0, 0, 375, 812}, "Home"));
  nodes.push_back(make(B, NodeType::FRAME, kPage, "\"", {500, 0, 375, 812}, "Details"));
  nodes.push_back(make(C, NodeType::FRAME, kPage, "#", {1000, 0, 375, 812}, "Settings"));
  NodeChange next = make(NEXT, NodeType::RECTANGLE, A, "#", {20, 700, 100, 40}, "Next");
  next.props.extra["prototypeInteractions"] = extra("prototypeInteractions", nav(B));
  nodes.push_back(next);
  nodes.push_back(make(CARD, NodeType::FRAME, A, "!", {20, 100, 200, 100}, "Card"));
  nodes.push_back(make(TITLE, NodeType::RECTANGLE, CARD, "!", {10, 10, 50, 20}, "Title"));
  nodes.push_back(make(CARD_B, NodeType::FRAME, B, "!", {20, 300, 300, 200}, "Card"));
  nodes.push_back(make(TITLE_B, NodeType::RECTANGLE, CARD_B, "!", {30, 30, 50, 20}, "Title"));
  NodeChange back = make(BACK, NodeType::RECTANGLE, B, "\"", {20, 20, 60, 30}, "Back");
  back.props.extra["prototypeInteractions"] =
      extra("prototypeInteractions", R"([{"event":{"interactionType":"ON_CLICK"},"actions":[{"connectionType":"BACK"}]}])");
  nodes.push_back(back);
  return nodes;
}

struct Fixture {
  Editor ed;
  proto::Player player{ed};
  double t = 0;
  explicit Fixture(const std::vector<NodeChange>& nodes, double w = 375, double h = 812) {
    ed.setSessionID(1);
    ed.setViewport(w, h, 1, static_cast<int>(w), static_cast<int>(h));
    ed.loadDocument(nodes, kNoGuid);
    ed.takeEvents();
  }
  // A click at a point of the screen (scale FIT with the window the frame's size: 1 CSS px = 1 unit).
  void click(double x, double y) {
    player.pointer(PointerEvent::MOVE, x, y, 0, 0);
    player.pointer(PointerEvent::DOWN, x, y, 1, 0);
    player.pointer(PointerEvent::UP, x, y, 0, 0);
  }
  void advance(double ms) {
    t += ms;
    player.tick(t);
  }
};

}  // namespace

TEST_CASE("prototype.model: interactions, overlay settings, flows and device read from the schema's fields") {
  NodeProps p;
  p.extra["prototypeInteractions"] = extra("prototypeInteractions",
      R"([{"id":"5:6","event":{"interactionType":"AFTER_TIMEOUT","transitionTimeout":1.5},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"OVERLAY","transitionNodeID":"1:2","transitionType":"MOVE_FROM_BOTTOM","transitionDuration":0.45,"easingType":"INOUT_BACK_CUBIC","transitionShouldSmartAnimate":true}]},
          {"event":{"interactionType":"ON_KEY_DOWN","keyTrigger":{"keyCodes":[16,75],"triggerDevice":"KEYBOARD"}},"actions":[{"connectionType":"URL","connectionURL":"https://figma.com","openUrlInNewTab":true}]}])");
  auto list = proto::interactions(p);
  REQUIRE(list.size() == 2);
  CHECK(list[0].id == Guid{5, 6});
  CHECK(list[0].trigger == proto::Trigger::AFTER_TIMEOUT);
  CHECK(list[0].timeout == doctest::Approx(1.5));
  REQUIRE(list[0].actions.size() == 1);
  const proto::Action& a = list[0].actions[0];
  CHECK(a.connection == proto::Connection::INTERNAL_NODE);
  CHECK(a.navigation == proto::Navigation::OVERLAY);
  CHECK(a.dest == Guid{1, 2});
  CHECK(a.transition == proto::Transition::MOVE_FROM_BOTTOM);
  CHECK(a.duration == doctest::Approx(0.45));
  CHECK(a.easing == proto::Easing::INOUT_BACK_CUBIC);
  CHECK(a.smartAnimate);
  CHECK(list[1].trigger == proto::Trigger::ON_KEY_DOWN);
  CHECK(list[1].keyCodes == std::vector<int>{16, 75});
  CHECK(list[1].actions[0].url == "https://figma.com");
  CHECK(list[1].actions[0].newTab);

  // Written back through the same field: equal after a round trip.
  std::string bytes = proto::encodeInteractions(list);
  NodeProps q;
  q.extra["prototypeInteractions"] = bytes;
  auto again = proto::interactions(q);
  REQUIRE(again.size() == 2);
  CHECK(again[0].actions[0].dest == Guid{1, 2});
  CHECK(again[0].actions[0].transition == proto::Transition::MOVE_FROM_BOTTOM);
  CHECK(again[1].keyCodes == std::vector<int>{16, 75});

  NodeProps f;
  f.extra["overlayPositionType"] = extra("overlayPositionType", R"("BOTTOM_CENTER")");
  f.extra["overlayBackgroundInteraction"] = extra("overlayBackgroundInteraction", R"("CLOSE_ON_CLICK_OUTSIDE")");
  f.extra["overlayBackgroundAppearance"] =
      extra("overlayBackgroundAppearance", R"({"backgroundType":"SOLID_COLOR","backgroundColor":{"r":0,"g":0,"b":0,"a":0.25}})");
  f.extra["scrollDirection"] = extra("scrollDirection", R"("VERTICAL")");
  auto o = proto::overlaySettings(f);
  CHECK(o.position == proto::OverlayPosition::BOTTOM_CENTER);
  CHECK(o.closeOnClickOutside);
  CHECK(o.background);
  CHECK(o.backgroundColor.a == doctest::Approx(0.25));
  CHECK(proto::overflow(f) == proto::Overflow::VERTICAL);
  CHECK(proto::scrollBehavior(f) == proto::ScrollBehavior::SCROLLS);

  NodeProps page;
  page.extra["prototypeDevice"] =
      extra("prototypeDevice", R"({"type":"PRESET","size":{"x":393,"y":852},"presetIdentifier":"IPHONE_15","rotation":"CCW_90"})");
  auto d = proto::device(page);
  CHECK(!d.none);
  CHECK(d.rotated);
  CHECK(d.size.x == 852);  // landscape
  CHECK(proto::background(page) == Color::hex(0x1E1E1E));
}

TEST_CASE("prototype.easing: Figma's curves and springs") {
  proto::Action a;
  for (auto e : {proto::Easing::LINEAR, proto::Easing::IN_CUBIC, proto::Easing::OUT_CUBIC, proto::Easing::INOUT_CUBIC,
                 proto::Easing::GENTLE_SPRING, proto::Easing::SPRING_PRESET_TWO}) {
    a.easing = e;
    CHECK(proto::ease(a, 0) == doctest::Approx(0).epsilon(0.01));
    CHECK(proto::ease(a, 1) == doctest::Approx(1).epsilon(0.01));
  }
  a.easing = proto::Easing::LINEAR;
  CHECK(proto::ease(a, 0.25) == doctest::Approx(0.25));
  a.easing = proto::Easing::OUT_CUBIC;
  CHECK(proto::ease(a, 0.5) > 0.5);  // ease out: ahead at the middle
  a.easing = proto::Easing::IN_CUBIC;
  CHECK(proto::ease(a, 0.5) < 0.5);
  a.easing = proto::Easing::OUT_BACK_CUBIC;
  double peak = 0;
  for (int i = 0; i <= 100; i++) peak = std::max(peak, proto::ease(a, i / 100.0));
  CHECK(peak > 1);  // overshoots
  a.easing = proto::Easing::CUSTOM_CUBIC;
  a.easingFunction = {0, 0, 1, 1};
  CHECK(proto::ease(a, 0.3) == doctest::Approx(0.3).epsilon(0.01));
  // Springs: their own duration (settled), Bouncy overshoots, Gentle less.
  a.easing = proto::Easing::SPRING_PRESET_TWO;
  double bouncy = 0;
  for (int i = 0; i <= 200; i++) bouncy = std::max(bouncy, proto::ease(a, i / 200.0));
  CHECK(bouncy > 1.05);
  CHECK(proto::durationOf(a) > 0.2);
  CHECK(proto::durationOf(a) < 3);
}

TEST_CASE("prototype.player: navigate, back, history, next / previous, restart") {
  Fixture f(screens());
  REQUIRE(f.player.start(kPage, kNoGuid));
  f.advance(16);
  CHECK(f.player.screen() == A);  // no flows: the first frame
  CHECK(f.player.historySize() == 0);
  // The Next button (20, 700, 100 × 40).
  f.click(50, 720);
  CHECK(f.player.screen() == B);
  CHECK(f.player.historySize() == 1);
  // A click where nothing reacts changes nothing (hotspot hints).
  f.click(200, 780);
  CHECK(f.player.screen() == B);
  // Back.
  f.click(30, 30);
  CHECK(f.player.screen() == A);
  CHECK(f.player.historySize() == 0);
  // → and ← go through the connected frames (A → B), R restarts.
  CHECK(f.player.sequence() == std::vector<Guid>{A, B});
  f.player.key(true, 39, 0);
  CHECK(f.player.screen() == B);
  f.player.key(true, 37, 0);
  CHECK(f.player.screen() == A);
  f.click(50, 720);
  f.player.key(true, 82, 0);
  CHECK(f.player.screen() == A);
  CHECK(f.player.historySize() == 0);
  // A flow's start wins over the first frame.
  NodeChange flow = NodeChange::changed(C);
  flow.mask = F_EXTRA;
  flow.props.extra["prototypeStartingPoint"] = extra("prototypeStartingPoint", R"({"name":"Flow 1","position":"!"})");
  f.ed.applyChanges({flow}, APPLY_REMOTE);
  REQUIRE(f.player.start(kPage, kNoGuid));
  CHECK(f.player.screen() == C);
  CHECK(f.player.flow() == C);
  CHECK(f.player.stateJson().find("\"flowName\":\"Flow 1\"") != std::string::npos);
}

TEST_CASE("prototype.player: transitions draw both screens, then the new one") {
  auto nodes = screens();
  for (auto& n : nodes)
    if (n.guid == NEXT) n.props.extra["prototypeInteractions"] = extra("prototypeInteractions", nav(B, "ON_CLICK", "NAVIGATE", "PUSH_FROM_RIGHT", 0.4));
  Fixture f(nodes);
  REQUIRE(f.player.start(kPage, A));
  f.advance(16);
  f.click(50, 720);
  CHECK(f.player.screen() == B);
  f.advance(16);  // the transition's clock starts
  CHECK(f.player.animating());
  f.advance(200);  // half way, linear
  const PresentScene& s = f.player.scene();
  // A and B both drawn: A pushed left by half the screen, B coming from the right.
  std::vector<std::pair<Guid, double>> placed;
  for (auto& item : s.items)
    if (item.kind == PresentItem::Kind::Node && (item.node == A || item.node == B)) placed.emplace_back(item.node, item.parentCss.m02);
  REQUIRE(placed.size() == 2);
  CHECK(placed[0].first == A);
  CHECK(placed[1].first == B);
  // parentCss maps the page to CSS: A's origin lands at −187.5 and B's at +187.5.
  CHECK(placed[0].second + 0 == doctest::Approx(-187.5).epsilon(0.02));
  CHECK(placed[1].second + 500 == doctest::Approx(187.5).epsilon(0.02));
  f.advance(300);
  CHECK(!f.player.animating());
  const PresentScene& end = f.player.scene();
  size_t frames = 0;
  for (auto& item : end.items) frames += item.kind == PresentItem::Kind::Node && (item.node == A || item.node == B);
  CHECK(frames == 1);
  // Back plays it backwards.
  f.click(30, 30);
  CHECK(f.player.screen() == A);
  f.advance(16);
  CHECK(f.player.animating());
}

TEST_CASE("prototype.player: overlays open, close outside, close, swap; Back closes them") {
  auto nodes = screens();
  NodeChange ovl = make(OVL, NodeType::FRAME, kPage, "$", {0, 1000, 200, 100}, "Menu");
  ovl.props.extra["overlayPositionType"] = extra("overlayPositionType", R"("CENTER")");
  ovl.props.extra["overlayBackgroundInteraction"] = extra("overlayBackgroundInteraction", R"("CLOSE_ON_CLICK_OUTSIDE")");
  ovl.props.extra["overlayBackgroundAppearance"] =
      extra("overlayBackgroundAppearance", R"({"backgroundType":"SOLID_COLOR","backgroundColor":{"r":0,"g":0,"b":0,"a":0.25}})");
  nodes.push_back(ovl);
  NodeChange close = make(OVL_CLOSE, NodeType::RECTANGLE, OVL, "!", {170, 0, 30, 30}, "Close");
  close.props.extra["prototypeInteractions"] =
      extra("prototypeInteractions", R"([{"event":{"interactionType":"ON_CLICK"},"actions":[{"connectionType":"CLOSE"}]}])");
  nodes.push_back(close);
  for (auto& n : nodes)
    if (n.guid == NEXT) n.props.extra["prototypeInteractions"] = extra("prototypeInteractions", nav(OVL, "ON_CLICK", "OVERLAY"));
  Fixture f(nodes);
  REQUIRE(f.player.start(kPage, A));
  f.click(50, 720);
  REQUIRE(f.player.overlays().size() == 1);
  CHECK(f.player.overlays()[0].frame == OVL);
  // Centred on the 375 × 812 screen.
  CHECK(f.player.overlays()[0].pos.x == doctest::Approx(87.5));
  CHECK(f.player.overlays()[0].pos.y == doctest::Approx(356));
  // Its background is drawn under it.
  bool dim = false;
  for (auto& item : f.player.scene().items) dim |= item.kind == PresentItem::Kind::Rect && item.alpha == doctest::Approx(0.25);
  CHECK(dim);
  // A click outside it closes it.
  f.click(10, 10);
  CHECK(f.player.overlays().empty());
  // Its Close button.
  f.click(50, 720);
  REQUIRE(f.player.overlays().size() == 1);
  f.click(87.5 + 180, 356 + 10);
  CHECK(f.player.overlays().empty());
  // Back closes the overlay the last step opened.
  f.click(50, 720);
  REQUIRE(f.player.overlays().size() == 1);
  CHECK(f.player.back());
  CHECK(f.player.overlays().empty());
  CHECK(f.player.screen() == A);
}

TEST_CASE("prototype.smart: layers match by name and place; Smart animate interpolates them") {
  auto nodes = screens();
  for (auto& n : nodes)
    if (n.guid == NEXT) n.props.extra["prototypeInteractions"] = extra("prototypeInteractions", nav(B, "ON_CLICK", "NAVIGATE", "SMART_ANIMATE", 1.0));
  Fixture f(nodes);
  auto m = f.player.matches(A, B);
  // The roots, Card and Card/Title match; Next and Back don't.
  bool card = false, title = false, next = false;
  for (auto& [x, y] : m) {
    card |= x == CARD && y == CARD_B;
    title |= x == TITLE && y == TITLE_B;
    next |= x == NEXT;
  }
  CHECK(card);
  CHECK(title);
  CHECK(!next);
  CHECK(proto::Player::matchKey(f.ed.document(), A, TITLE) == "/Card#0/Title#0");

  REQUIRE(f.player.start(kPage, A));
  f.click(50, 720);
  f.advance(16);
  f.advance(500);  // half way (linear)
  f.player.scene();
  const NodeProps* cardB = f.player.drawnProps(CARD_B);
  REQUIRE(cardB);
  // Card: (20, 100) 200 × 100 → (20, 300) 300 × 200; half way: (20, 200) 250 × 150.
  CHECK(cardB->transform.m12 == doctest::Approx(200));
  CHECK(cardB->size.x == doctest::Approx(250));
  CHECK(cardB->size.y == doctest::Approx(150));
  // Its title, inside: (10, 10) → (30, 30) relative to the card.
  const NodeProps* titleB = f.player.drawnProps(TITLE_B);
  REQUIRE(titleB);
  CHECK(titleB->transform.m02 == doctest::Approx(20));
  CHECK(titleB->transform.m12 == doctest::Approx(20));
  // The unmatched Back button fades in; the source's Next fades out.
  const NodeProps* back = f.player.drawnProps(BACK);
  REQUIRE(back);
  CHECK(back->opacity == doctest::Approx(0.5));
  const NodeProps* next2 = f.player.drawnProps(NEXT);
  REQUIRE(next2);
  CHECK(next2->opacity == doctest::Approx(0.5));
  // The source's matched card isn't drawn twice: its paints are gone.
  const NodeProps* cardA = f.player.drawnProps(CARD);
  REQUIRE(cardA);
  CHECK(cardA->fillPaints.empty());
  f.advance(600);
  CHECK(!f.player.animating());
}

TEST_CASE("prototype.player: Change to on While hovering swaps the instance's variant and back") {
  auto nodes = baseChanges();
  const Guid SET{2, 1}, DEF{2, 2}, HOV{2, 3}, BG1{2, 4}, BG2{2, 5}, SCREEN{2, 10}, INST{2, 11};
  NodeChange set = make(SET, NodeType::FRAME, kPage, "~", {0, 1000, 300, 200}, "Button");
  set.props.comp().isStateGroup = true;
  nodes.push_back(set);
  NodeChange def = make(DEF, NodeType::SYMBOL, SET, "!", {20, 20, 100, 40}, "State=Default");
  def.props.extra["prototypeInteractions"] = extra("prototypeInteractions", nav(HOV, "ON_HOVER", "SWAP_STATE", "SMART_ANIMATE", 0.3));
  nodes.push_back(def);
  nodes.push_back(make(BG1, NodeType::RECTANGLE, DEF, "!", {0, 0, 100, 40}, "Bg"));
  nodes.push_back(make(HOV, NodeType::SYMBOL, SET, "\"", {150, 20, 120, 40}, "State=Hover"));
  nodes.push_back(make(BG2, NodeType::RECTANGLE, HOV, "!", {0, 0, 120, 40}, "Bg"));
  nodes.push_back(make(SCREEN, NodeType::FRAME, kPage, "!", {0, 0, 375, 812}, "Screen"));
  NodeChange inst = make(INST, NodeType::INSTANCE, SCREEN, "!", {100, 100, 100, 40}, "Button");
  inst.props.comp().symbolData.symbolID = DEF;
  inst.props.fillPaints.clear();
  nodes.push_back(inst);
  Fixture f(nodes);
  REQUIRE(f.player.start(kPage, SCREEN));
  CHECK(f.ed.mainOf(INST) == DEF);
  f.player.pointer(PointerEvent::MOVE, 120, 110, 0, 0);
  CHECK(f.ed.mainOf(INST) == HOV);
  f.advance(16);
  CHECK(f.player.animating());  // Smart animate between the states
  f.advance(400);
  // Leaving reverts it.
  f.player.pointer(PointerEvent::MOVE, 10, 500, 0, 0);
  CHECK(f.ed.mainOf(INST) == DEF);
  // Restart puts what the player wrote back.
  f.player.pointer(PointerEvent::MOVE, 120, 110, 0, 0);
  CHECK(f.ed.mainOf(INST) == HOV);
  f.player.restart();
  CHECK(f.ed.mainOf(INST) == DEF);
}

TEST_CASE("prototype.player: overflow scrolling, fixed layers, Scroll to, After delay") {
  auto nodes = baseChanges();
  const Guid TALL{3, 1}, HEADER{3, 2}, LIST{3, 3}, ITEM1{3, 4}, ITEM2{3, 5}, TARGET{3, 6}, LINK{3, 7}, NEXTSCREEN{3, 8};
  NodeChange tall = make(TALL, NodeType::FRAME, kPage, "!", {0, 0, 375, 2000}, "Long page");
  nodes.push_back(tall);
  NodeChange header = make(HEADER, NodeType::RECTANGLE, TALL, "~", {0, 0, 375, 60}, "Header");
  header.props.extra["scrollBehavior"] = extra("scrollBehavior", R"("FIXED_WHEN_CHILD_OF_SCROLLING_FRAME")");
  nodes.push_back(header);
  NodeChange list = make(LIST, NodeType::FRAME, TALL, "!", {0, 100, 375, 200}, "List");
  list.props.extra["scrollDirection"] = extra("scrollDirection", R"("HORIZONTAL")");
  nodes.push_back(list);
  nodes.push_back(make(ITEM1, NodeType::RECTANGLE, LIST, "!", {0, 0, 300, 200}, "Item"));
  nodes.push_back(make(ITEM2, NodeType::RECTANGLE, LIST, "\"", {320, 0, 300, 200}, "Item"));
  nodes.push_back(make(TARGET, NodeType::RECTANGLE, TALL, "\"", {0, 1500, 375, 100}, "Footer"));
  NodeChange link = make(LINK, NodeType::RECTANGLE, TALL, "#", {0, 400, 100, 40}, "Go to footer");
  link.props.extra["prototypeInteractions"] = extra("prototypeInteractions", nav(TARGET, "ON_CLICK", "SCROLL_TO"));
  nodes.push_back(link);
  NodeChange other = make(NEXTSCREEN, NodeType::FRAME, kPage, "\"", {500, 0, 375, 812}, "Later");
  nodes.push_back(other);
  // After delay on the long page: to "Later" after 2 s.
  for (auto& n : nodes)
    if (n.guid == TALL) n.props.extra["prototypeInteractions"] = extra("prototypeInteractions", R"([{"event":{"interactionType":"AFTER_TIMEOUT","transitionTimeout":2},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"NAVIGATE","transitionNodeID":"3:8","transitionType":"INSTANT_TRANSITION"}]}])");
  // Fit width: a 375 px wide window, 812 tall — the 2000 tall frame scrolls.
  Fixture f(nodes, 375, 812);
  f.player.setScale(proto::ScaleMode::FIT_WIDTH);
  REQUIRE(f.player.start(kPage, TALL));
  f.advance(16);
  CHECK(f.player.screenSize().y == doctest::Approx(812));
  f.player.wheel(200, 500, 0, 300);
  CHECK(f.player.scrollOf(TALL).y == doctest::Approx(300));
  f.player.wheel(200, 500, 0, 5000);
  CHECK(f.player.scrollOf(TALL).y == doctest::Approx(2000 - 812));
  f.player.wheel(200, 500, 0, -5000);
  CHECK(f.player.scrollOf(TALL).y == 0);
  // The horizontal list scrolls on its own, within its content (620 − 375).
  f.player.wheel(100, 200, 1000, 0);
  CHECK(f.player.scrollOf(LIST).x == doctest::Approx(245));
  CHECK(f.player.scrollOf(TALL).y == 0);
  // Its items are drawn shifted; the fixed header is drawn on its own, above.
  f.player.scene();
  const NodeProps* item = f.player.drawnProps(ITEM2);
  REQUIRE(item);
  CHECK(item->transform.m02 == doctest::Approx(320 - 245));
  bool headerItem = false;
  for (auto& it : f.player.scene().items) headerItem |= it.node == HEADER;
  CHECK(headerItem);
  // Scroll to the footer.
  f.click(50, 420);
  CHECK(f.player.scrollOf(TALL).y == doctest::Approx(1188));
  // After delay: 2 s after the page was shown.
  CHECK(f.player.screen() == TALL);
  f.advance(1500);
  CHECK(f.player.screen() == TALL);
  f.advance(600);
  CHECK(f.player.screen() == NEXTSCREEN);
}

TEST_CASE("prototype.player: key triggers, conditional and set variable") {
  auto nodes = screens();
  for (auto& n : nodes)
    if (n.guid == A)
      n.props.extra["prototypeInteractions"] = extra("prototypeInteractions",
          R"([{"event":{"interactionType":"ON_KEY_DOWN","keyTrigger":{"keyCodes":[16,75]}},"actions":[{"connectionType":"CONDITIONAL","conditionalActions":[{"condition":{"value":{"boolValue":false},"dataType":"BOOLEAN"},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"NAVIGATE","transitionNodeID":"1:2"}]},{"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"NAVIGATE","transitionNodeID":"1:3"}]}]}]}])");
  Fixture f(nodes);
  REQUIRE(f.player.start(kPage, A));
  f.player.key(true, 75, 0);  // K alone: no match (and not a shortcut)
  CHECK(f.player.screen() == A);
  f.player.key(true, 75, MOD_SHIFT);  // ⇧K: the Else branch
  CHECK(f.player.screen() == C);
}

TEST_CASE("prototype.render: the scene draws through the renderer") {
  Fixture f(screens());
  REQUIRE(f.player.start(kPage, A));
  gfx::NullDevice dev;
  Renderer r(dev);
  r.setTextLayouts(&f.ed);
  const PresentScene& s = f.player.scene();
  RenderStats st = r.renderScene(f.ed.document(), kPage, f.ed.viewport(), s);
  CHECK(st.nodes >= 4);  // A, Card, Title, Next
  CHECK(st.culled == 0);
}

TEST_CASE("prototype.editor: dragging the + handle to a frame connects it; dragging the end away removes it") {
  Editor ed;
  ed.setSessionID(1);
  ed.setViewport(1600, 1000, 1, 1600, 1000);
  auto nodes = screens();
  for (auto& n : nodes)
    if (n.guid == NEXT) n.props.extra.erase("prototypeInteractions");
  ed.loadDocument(nodes, kNoGuid);
  Camera cam;
  cam.zoom = 1;
  cam.x = 0;
  cam.y = 0;
  ed.setCamera(cam);
  ed.setPrototypeMode(true);
  ed.setSelection({NEXT});
  ed.takeEvents();
  // The handle sits on the Next button's right edge, at its middle: (120, 720).
  Overlay o = ed.overlay();
  REQUIRE(o.prototype.on);
  REQUIRE(o.prototype.handles.size() == 1);
  CHECK(ed.pointer(PointerEvent::DOWN, 120, 720, 0, 1, 0) != 0);
  ed.pointer(PointerEvent::MOVE, 300, 600, 0, 1, 0);
  ed.pointer(PointerEvent::MOVE, 700, 400, 0, 1, 0);  // over B
  Overlay during = ed.overlay();
  CHECK(during.prototype.hasTarget);
  ed.pointer(PointerEvent::UP, 700, 400, 0, 0, 0);
  auto list = proto::interactions(ed.document().get(NEXT)->props);
  REQUIRE(list.size() == 1);
  CHECK(list[0].trigger == proto::Trigger::ON_CLICK);
  REQUIRE(list[0].actions.size() == 1);
  CHECK(list[0].actions[0].navigation == proto::Navigation::NAVIGATE);
  CHECK(list[0].actions[0].dest == B);
  CHECK(list[0].actions[0].transition == proto::Transition::INSTANT);
  // A's first connection gave it a flow starting point.
  auto flows = proto::flows(ed.document(), kPage);
  REQUIRE(flows.size() == 1);
  CHECK(flows[0].node == A);
  CHECK(flows[0].name == "Flow 1");
  auto ev = ed.takeEvents();
  REQUIRE(ev.prototypeConnected.size() == 1);
  CHECK(ev.prototypeConnected[0].nodes == std::vector<Guid>{NEXT});
  // One undo step takes both back.
  CHECK(ed.canUndo());
  // The noodle: drawn from Next to B.
  Overlay after = ed.overlay();
  REQUIRE(after.prototype.links.size() == 1);
  CHECK(after.prototype.flows.size() == 1);
  // Its end, on B's left edge: drag it onto C → retargeted.
  NoodleCurve n = prototypeNoodle({20, 700, 100, 40}, {500, 0, 375, 812}, false, {});
  CHECK(n.b.x == doctest::Approx(500));
  ed.pointer(PointerEvent::MOVE, n.b.x, n.b.y, 0, 0, 0);
  CHECK(ed.pointer(PointerEvent::DOWN, n.b.x, n.b.y, 0, 1, 0) != 0);
  ed.pointer(PointerEvent::MOVE, 1100, 400, 0, 1, 0);
  ed.pointer(PointerEvent::UP, 1100, 400, 0, 0, 0);
  list = proto::interactions(ed.document().get(NEXT)->props);
  REQUIRE(list.size() == 1);
  CHECK(list[0].actions[0].dest == C);
  // Now onto empty canvas: removed.
  NoodleCurve n2 = prototypeNoodle({20, 700, 100, 40}, {1000, 0, 375, 812}, false, {});
  CHECK(ed.pointer(PointerEvent::DOWN, n2.b.x, n2.b.y, 0, 1, 0) != 0);
  ed.pointer(PointerEvent::MOVE, 450, 950, 0, 1, 0);
  ed.pointer(PointerEvent::UP, 450, 950, 0, 0, 0);
  CHECK(proto::interactions(ed.document().get(NEXT)->props).empty());
  CHECK(ed.document().get(NEXT)->props.extra.count("prototypeInteractions") == 0);
  // Undo brings it back.
  ed.command(CommandId::UNDO);
  CHECK(proto::interactions(ed.document().get(NEXT)->props).size() == 1);
  // Out of prototype mode: no handles, no noodles.
  ed.setPrototypeMode(false);
  CHECK(!ed.overlay().prototype.on);
}
