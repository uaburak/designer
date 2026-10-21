// The prototype's website behaviours (Wecra, 2026-10-21; docs/research/prototype-web-behaviours.md §2 items 6–9, 12;
// docs/engine.md §3.4 "Website behaviours"): a Manual overlay follows its hotspot and stays in the window (Keep in
// window, NodeChange.overlayEdgeBehavior), Stack overlays queue like toasts (NodeChange.overlayStack), screens switch to
// their other breakpoint on resize, Change to and screen transitions are interruptible, and the runtime state is kept
// for a reload. Each with the switch off: Figma's behaviour.
#include <algorithm>
#include <cmath>

#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "proto/Player.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

std::string extra(const char* key, const std::string& text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  std::string bytes = codec::extraFromJson("NodeChange", key, v);
  REQUIRE(!bytes.empty());
  return bytes;
}

std::string q(Guid g) { return "\"" + g.toString() + "\""; }

std::string click(const std::string& action) { return R"([{"stateManagementVersion":1,"event":{"interactionType":"ON_CLICK"},"actions":[)" + action + "]}]"; }

std::string overlayAction(Guid dest, const char* offset = nullptr) {
  std::string a = R"({"connectionType":"INTERNAL_NODE","navigationType":"OVERLAY","transitionNodeID":)" + q(dest) + R"(,"transitionType":"INSTANT_TRANSITION")";
  if (offset) a += std::string(R"(,"overlayRelativePosition":)") + offset;
  return a + "}";
}

std::string navigateAction(Guid dest, const char* transition = "INSTANT_TRANSITION") {
  return R"({"connectionType":"INTERNAL_NODE","navigationType":"NAVIGATE","transitionNodeID":)" + q(dest) + R"(,"transitionType":")" + transition +
         R"(","transitionDuration":0.3,"easingType":"LINEAR"})";
}

std::string changeToAction(Guid dest, const char* transition = "INSTANT_TRANSITION") {
  return R"({"connectionType":"INTERNAL_NODE","navigationType":"SWAP_STATE","transitionNodeID":)" + q(dest) + R"(,"transitionType":")" + transition +
         R"(","transitionDuration":0.3,"easingType":"LINEAR"})";
}

struct Fixture {
  Editor ed;
  proto::Player player{ed};
  double t = 0;
  explicit Fixture(const std::vector<NodeChange>& nodes, double w = 1200, double h = 900) {
    ed.setSessionID(1);
    ed.setViewport(w, h, 1, static_cast<int>(w), static_cast<int>(h));
    ed.loadDocument(nodes, kNoGuid);
    ed.takeEvents();
    player.setScale(proto::ScaleMode::ACTUAL);
  }
  const NodeProps& at(Guid id) { return ed.document().get(id)->props; }
  void move(double x, double y) { player.pointer(PointerEvent::MOVE, x, y, 0, 0); }
  void click(double x, double y) {
    player.pointer(PointerEvent::MOVE, x, y, 0, 0);
    player.pointer(PointerEvent::DOWN, x, y, 1, 0);
    player.pointer(PointerEvent::UP, x, y, 0, 0);
  }
  void advance(double ms) {
    while (ms > 0) {
      double step = std::min(10.0, ms);
      t += step;
      ms -= step;
      player.tick(t);
    }
  }
  void resize(double w, double h) {
    ed.setViewport(w, h, 1, static_cast<int>(w), static_cast<int>(h));
    player.scene();
  }
  const PresentItem* itemOf(Guid id) {
    for (auto& item : player.scene().items)
      if (item.kind == PresentItem::Kind::Node && item.node == id) return &item;
    return nullptr;
  }
  Vec2 overlayAt(Guid frame) {
    player.scene();
    for (auto& o : player.overlays())
      if (o.frame == frame) return o.pos;
    FAIL("not open");
    return {};
  }
  // The layer named `name` under `root` (ids inside instances change with their variants: found anew).
  Guid child(Guid root, const char* name) {
    for (Guid c : ed.document().children(root))
      if (ed.document().get(c)->props.name == name) return c;
    FAIL("no such layer");
    return kNoGuid;
  }
};

// ---- 6. Anchored popovers ---------------------------------------------------------------------------------

const Guid PAGE_SCREEN{1, 1}, BTN{1, 2}, BTN2{1, 3}, MENU{2, 1}, WIDE{2, 2};

// A 1200 × 3000 page (it scrolls as a whole) in a 1200 × 900 window; a button low on it opens a 200 × 300 menu 44 below
// its top (Manual), another a 1180-wide one near the left edge.
std::vector<NodeChange> popoverDoc(const char* edge) {
  auto nodes = baseChanges();
  NodeChange s = make(PAGE_SCREEN, NodeType::FRAME, kPage, "!", {0, 0, 1200, 3000}, "Page");
  nodes.push_back(s);
  NodeChange b = make(BTN, NodeType::RECTANGLE, PAGE_SCREEN, "!", {100, 700, 120, 40}, "Account");
  b.props.extra["prototypeInteractions"] = extra("prototypeInteractions", click(overlayAction(MENU, R"({"x":0,"y":44})")));
  nodes.push_back(b);
  NodeChange b2 = make(BTN2, NodeType::RECTANGLE, PAGE_SCREEN, "\"", {50, 100, 120, 40}, "Wide");
  b2.props.extra["prototypeInteractions"] = extra("prototypeInteractions", click(overlayAction(WIDE, R"({"x":0,"y":44})")));
  nodes.push_back(b2);
  for (auto [id, pos, size, name] : {std::tuple{MENU, "\"", Vec2{200, 300}, "Menu"}, std::tuple{WIDE, "#", Vec2{1180, 100}, "Mega menu"}}) {
    NodeChange m = make(id, NodeType::FRAME, kPage, pos, {2000, 0, size.x, size.y}, name);
    m.props.extra["overlayPositionType"] = extra("overlayPositionType", R"("MANUAL")");
    if (edge) m.props.extra["overlayEdgeBehavior"] = extra("overlayEdgeBehavior", std::string("\"") + edge + "\"");
    nodes.push_back(m);
  }
  return nodes;
}

}  // namespace

TEST_CASE("proto.web: a Manual overlay flips above its hotspot at the window's bottom and follows it as the page scrolls") {
  Fixture f(popoverDoc(nullptr));
  REQUIRE(f.player.start(kPage, PAGE_SCREEN));
  f.click(150, 720);
  // Below the button it would end at 1044 in a 900 window: above it, with the same 4 px gap.
  Vec2 at = f.overlayAt(MENU);
  CHECK(at.x == doctest::Approx(100));
  CHECK(at.y == doctest::Approx(700 - 4 - 300));
  // The page scrolls 200 under it (no background): the menu goes with its button, and fits below it now.
  f.player.wheel(800, 100, 0, 200);
  CHECK(f.player.scrollOf(PAGE_SCREEN).y == doctest::Approx(200));
  at = f.overlayAt(MENU);
  CHECK(at.y == doctest::Approx(500 + 44));
  // Drawn there too.
  const PresentItem* item = f.itemOf(MENU);
  REQUIRE(item);
  CHECK(item->parentCss.m12 == doctest::Approx(544));
}

TEST_CASE("proto.web: shifted inside the window when neither side fits") {
  Fixture f(popoverDoc(nullptr));
  REQUIRE(f.player.start(kPage, PAGE_SCREEN));
  f.click(100, 120);
  Vec2 at = f.overlayAt(WIDE);
  CHECK(at.x == doctest::Approx(1200 - 8 - 1180));  // 8 px from the right edge
  CHECK(at.y == doctest::Approx(144));
}

TEST_CASE("proto.web: Keep in window off, or Website behaviours off, is Figma's (placed once, never moved)") {
  for (bool fieldOff : {true, false}) {
    CAPTURE(fieldOff);
    Fixture f(popoverDoc(fieldOff ? "NONE" : nullptr));
    if (!fieldOff) f.player.setWebBehaviours(false);
    REQUIRE(f.player.start(kPage, PAGE_SCREEN));
    f.click(150, 720);
    CHECK(f.overlayAt(MENU).y == doctest::Approx(744));
    f.player.wheel(800, 100, 0, 200);
    CHECK(f.overlayAt(MENU).y == doctest::Approx(744));
  }
}

TEST_CASE("proto.web: Follow only moves with the hotspot, never flipped") {
  Fixture f(popoverDoc("FOLLOW_ONLY"));
  REQUIRE(f.player.start(kPage, PAGE_SCREEN));
  f.click(150, 720);
  CHECK(f.overlayAt(MENU).y == doctest::Approx(744));
  f.player.wheel(800, 100, 0, 200);
  CHECK(f.overlayAt(MENU).y == doctest::Approx(544));
}

// ---- 9. Toast stacks --------------------------------------------------------------------------------------

namespace {

const Guid TOAST_SCREEN{3, 1}, B1{3, 2}, B2{3, 3}, B3{3, 4}, T1{4, 1}, T2{4, 2}, T3{4, 3};

std::vector<NodeChange> toastDoc(bool stack) {
  auto nodes = baseChanges();
  nodes.push_back(make(TOAST_SCREEN, NodeType::FRAME, kPage, "!", {0, 0, 1200, 900}, "Screen"));
  const Guid buttons[] = {B1, B2, B3}, toasts[] = {T1, T2, T3};
  const char* pos[] = {"!", "\"", "#"};
  for (int i = 0; i < 3; i++) {
    NodeChange b = make(buttons[i], NodeType::RECTANGLE, TOAST_SCREEN, pos[i], {10 + 140.0 * i, 10, 100, 40}, "Button");
    b.props.extra["prototypeInteractions"] = extra("prototypeInteractions", click(overlayAction(toasts[i])));
    nodes.push_back(b);
    NodeChange t = make(toasts[i], NodeType::FRAME, kPage, std::string(1, static_cast<char>('$' + i)), {2000 + 400.0 * i, 0, 300, 60}, "Toast");
    t.props.extra["overlayPositionType"] = extra("overlayPositionType", R"("BOTTOM_CENTER")");
    if (stack) t.props.extra["overlayStack"] = extra("overlayStack", R"({"gap":8,"max":2})");
    // A click on a toast closes it.
    t.props.extra["prototypeInteractions"] = extra("prototypeInteractions", click(R"({"connectionType":"CLOSE"})"));
    nodes.push_back(t);
  }
  return nodes;
}

}  // namespace

TEST_CASE("proto.web: Stack overlays queue at their edge, the oldest goes past Max, the rest slide into place") {
  Fixture f(toastDoc(true));
  REQUIRE(f.player.start(kPage, TOAST_SCREEN));
  f.click(60, 30);
  CHECK(f.overlayAt(T1).y == doctest::Approx(840));
  CHECK(f.overlayAt(T1).x == doctest::Approx(450));
  f.click(200, 30);
  CHECK(f.overlayAt(T2).y == doctest::Approx(840));  // the newest at the edge
  CHECK(f.overlayAt(T1).y == doctest::Approx(840 - 60 - 8));
  // A third with Max 2: the oldest closes.
  f.click(340, 30);
  REQUIRE(f.player.overlays().size() == 2);
  CHECK(f.player.overlays()[0].frame == T2);
  CHECK(f.overlayAt(T3).y == doctest::Approx(840));
  CHECK(f.overlayAt(T2).y == doctest::Approx(772));
  f.advance(500);
  // The newest closes (a click on it): the other slides down to the edge.
  f.click(600, 870);
  REQUIRE(f.player.overlays().size() == 1);
  CHECK(f.overlayAt(T2).y == doctest::Approx(840));  // its place
  const PresentItem* item = f.itemOf(T2);
  REQUIRE(item);
  CHECK(item->parentCss.m12 == doctest::Approx(772));  // drawn where it was, sliding
  f.advance(120);
  item = f.itemOf(T2);
  REQUIRE(item);
  CHECK(item->parentCss.m12 > 772.5);
  CHECK(item->parentCss.m12 < 839.5);
  f.advance(300);
  item = f.itemOf(T2);
  REQUIRE(item);
  CHECK(item->parentCss.m12 == doctest::Approx(840));
  CHECK(!f.player.animating());
}

TEST_CASE("proto.web: without Stack (or Website behaviours off) toasts overlap at their position, as Figma's") {
  for (bool fieldOn : {false, true}) {
    CAPTURE(fieldOn);
    Fixture f(toastDoc(fieldOn));
    if (fieldOn) f.player.setWebBehaviours(false);
    REQUIRE(f.player.start(kPage, TOAST_SCREEN));
    f.click(60, 30);
    f.click(200, 30);
    f.click(340, 30);
    CHECK(f.player.overlays().size() == 3);
    CHECK(f.overlayAt(T1).y == doctest::Approx(840));
    CHECK(f.overlayAt(T2).y == doctest::Approx(840));
  }
}

// ---- 7. Breakpoints ---------------------------------------------------------------------------------------

namespace {

const Guid HD{5, 1}, HM{5, 2}, AD{5, 3}, AM{5, 4}, CK1{5, 5}, CK2{5, 6}, TABS{6, 1}, TAB_A{6, 2}, TAB_B{6, 3};

std::vector<NodeChange> breakpointDoc() {
  auto nodes = baseChanges();
  NodeChange set = make(TABS, NodeType::FRAME, kPage, "~", {0, 5000, 300, 100}, "Tab");
  set.props.comp().isStateGroup = true;
  nodes.push_back(set);
  NodeChange a = make(TAB_A, NodeType::SYMBOL, TABS, "!", {0, 0, 100, 40}, "State=A");
  a.props.extra["prototypeInteractions"] = extra("prototypeInteractions", click(changeToAction(TAB_B)));
  nodes.push_back(a);
  nodes.push_back(make(TAB_B, NodeType::SYMBOL, TABS, "\"", {150, 0, 100, 40}, "State=B"));
  uint32_t next = 100;
  auto screen = [&](Guid id, const std::string& pos, Rect r, const char* name, Guid link) {
    NodeChange s = make(id, NodeType::FRAME, kPage, pos, r, name);
    s.props.extra["scrollDirection"] = extra("scrollDirection", R"("VERTICAL")");
    nodes.push_back(s);
    nodes.push_back(make(Guid{7, next++}, NodeType::RECTANGLE, id, "!", {0, 0, r.w, 2500}, "Long"));
    NodeChange tab = make(Guid{7, next++}, NodeType::INSTANCE, id, "\"", {10, 100, 100, 40}, "Tab");
    tab.props.comp().symbolData.symbolID = TAB_A;
    tab.props.fillPaints.clear();
    nodes.push_back(tab);
    if (link != kNoGuid) {
      NodeChange b = make(Guid{7, next++}, NodeType::RECTANGLE, id, "#", {10, 10, 100, 40}, "About");
      b.props.extra["prototypeInteractions"] = extra("prototypeInteractions", click(navigateAction(link)));
      nodes.push_back(b);
    }
  };
  screen(HD, "!", {0, 0, 1440, 900}, "Home / Desktop", AD);
  screen(HM, "\"", {1500, 0, 390, 800}, "Home / Mobile", AD);
  screen(AD, "#", {0, 1000, 1440, 900}, "About / Desktop", kNoGuid);
  screen(AM, "$", {1500, 1000, 390, 800}, "About / Mobile", kNoGuid);
  screen(CK1, "%", {0, 2000, 1440, 900}, "Checkout / 1", kNoGuid);
  screen(CK2, "&", {1500, 2000, 390, 800}, "Checkout / 2", kNoGuid);
  return nodes;
}

}  // namespace

TEST_CASE("proto.web: under Responsive the screen switches to its other size as the window crosses half way") {
  Fixture f(breakpointDoc());
  f.player.setScale(proto::ScaleMode::RESPONSIVE);
  REQUIRE(f.player.start(kPage, HD));
  f.player.scene();
  CHECK(f.player.screen() == HD);  // 1200 ≥ (390 + 1440) / 2: the desktop design, squeezed
  CHECK(f.at(HD).size.x == doctest::Approx(1200));
  // Its tab changed and the page scrolled.
  f.click(60, 120);
  CHECK(f.ed.mainOf(f.child(HD, "Tab")) == TAB_B);
  f.player.wheel(600, 400, 0, 300);
  CHECK(f.player.scrollOf(HD).y == doctest::Approx(300));
  size_t history = f.player.historySize();
  // Narrower than 915: the mobile design, the state carried, nothing recorded.
  f.resize(600, 900);
  CHECK(f.player.screen() == HM);
  CHECK(f.at(HM).size.x == doctest::Approx(600));
  CHECK(f.ed.mainOf(f.child(HM, "Tab")) == TAB_B);
  CHECK(f.player.scrollOf(HM).y == doctest::Approx(300));
  CHECK(f.player.historySize() == history);
  // A link to the desktop About lands on its mobile size.
  f.player.wheel(300, 400, 0, -300);
  f.click(50, 30);
  CHECK(f.player.screen() == AM);
  // Wide again: back to the desktop size.
  f.resize(1300, 900);
  CHECK(f.player.screen() == AD);
}

TEST_CASE("proto.web: a flow's steps are not breakpoints; Website behaviours off keeps the screen") {
  SUBCASE("steps") {
    Fixture f(breakpointDoc());
    f.player.setScale(proto::ScaleMode::RESPONSIVE);
    REQUIRE(f.player.start(kPage, CK1));
    f.resize(600, 900);
    CHECK(f.player.screen() == CK1);
  }
  SUBCASE("off") {
    Fixture f(breakpointDoc());
    f.player.setWebBehaviours(false);
    f.player.setScale(proto::ScaleMode::RESPONSIVE);
    REQUIRE(f.player.start(kPage, HD));
    f.resize(600, 900);
    CHECK(f.player.screen() == HD);
  }
  SUBCASE("started narrow: the mobile size first") {
    Fixture f(breakpointDoc(), 500, 900);
    f.player.setScale(proto::ScaleMode::RESPONSIVE);
    REQUIRE(f.player.start(kPage, HD));
    CHECK(f.player.screen() == HM);
  }
}

// ---- 8. Interruptible transitions -------------------------------------------------------------------------

namespace {

const Guid KS{8, 1}, REST{8, 2}, HOVERED{8, 3}, CARD_SCREEN{8, 4}, CARD{8, 5}, SA{8, 6}, SB{8, 7}, GO{8, 8};

std::vector<NodeChange> hoverDoc() {
  auto nodes = baseChanges();
  NodeChange set = make(KS, NodeType::FRAME, kPage, "~", {0, 5000, 600, 100}, "Card");
  set.props.comp().isStateGroup = true;
  nodes.push_back(set);
  NodeChange rest = make(REST, NodeType::SYMBOL, KS, "!", {0, 0, 200, 50}, "State=Rest");
  rest.props.extra["prototypeInteractions"] =
      extra("prototypeInteractions", R"([{"stateManagementVersion":1,"event":{"interactionType":"ON_HOVER"},"actions":[)" + changeToAction(HOVERED, "SMART_ANIMATE") + "]}]");
  nodes.push_back(rest);
  nodes.push_back(make(Guid{9, 1}, NodeType::RECTANGLE, REST, "!", {0, 0, 20, 20}, "Dot"));
  nodes.push_back(make(HOVERED, NodeType::SYMBOL, KS, "\"", {300, 0, 200, 50}, "State=Hover"));
  nodes.push_back(make(Guid{9, 2}, NodeType::RECTANGLE, HOVERED, "!", {100, 0, 20, 20}, "Dot"));
  nodes.push_back(make(CARD_SCREEN, NodeType::FRAME, kPage, "!", {0, 0, 400, 200}, "Screen"));
  NodeChange card = make(CARD, NodeType::INSTANCE, CARD_SCREEN, "!", {0, 0, 200, 50}, "Card");
  card.props.comp().symbolData.symbolID = REST;
  card.props.fillPaints.clear();
  nodes.push_back(card);
  // Two screens for a screen transition: A's button moves B in from the right.
  nodes.push_back(make(SA, NodeType::FRAME, kPage, "\"", {0, 1000, 400, 200}, "A"));
  NodeChange go = make(GO, NodeType::RECTANGLE, SA, "!", {10, 10, 100, 40}, "Go");
  go.props.extra["prototypeInteractions"] = extra("prototypeInteractions", click(navigateAction(SB, "MOVE_FROM_RIGHT")));
  nodes.push_back(go);
  nodes.push_back(make(SB, NodeType::FRAME, kPage, "#", {1000, 1000, 400, 200}, "B"));
  return nodes;
}

}  // namespace

TEST_CASE("proto.web: a hover left half way goes back from where it is drawn, in the time it took") {
  for (bool web : {true, false}) {
    CAPTURE(web);
    Fixture f(hoverDoc(), 400, 200);
    f.player.setWebBehaviours(web);
    REQUIRE(f.player.start(kPage, CARD_SCREEN));
    f.advance(16);
    f.move(10, 10);
    CHECK(f.ed.mainOf(CARD) == HOVERED);
    f.advance(150);
    f.player.scene();
    const NodeProps* dot = f.player.drawnProps(f.child(CARD, "Dot"));
    REQUIRE(dot);
    double reached = dot->transform.m02;
    CHECK(reached > 30);
    CHECK(reached < 70);
    // Left: back to Rest.
    f.move(300, 150);
    CHECK(f.ed.mainOf(CARD) == REST);
    f.player.scene();
    dot = f.player.drawnProps(f.child(CARD, "Dot"));
    REQUIRE(dot);
    if (web) {
      CHECK(dot->transform.m02 == doctest::Approx(reached).epsilon(0.02));  // no jump
      f.advance(reached / 100 * 300 + 15);                                  // the time it took
      CHECK(!f.player.animating());
    } else {
      CHECK(dot->transform.m02 == doctest::Approx(100));  // Figma's: from the hovered state's end
      f.advance(200);
      CHECK(f.player.animating());
    }
  }
}

TEST_CASE("proto.web: Back during a screen transition plays it back from where it is") {
  for (bool web : {true, false}) {
    CAPTURE(web);
    Fixture f(hoverDoc(), 400, 200);
    f.player.setWebBehaviours(web);
    REQUIRE(f.player.start(kPage, SA));
    f.advance(16);
    f.click(50, 30);
    REQUIRE(f.player.screen() == SB);
    f.advance(150);
    const PresentItem* b = f.itemOf(SB);
    REQUIRE(b);
    double x = b->parentCss.m02 + 1000;  // B's left edge on screen
    CHECK(x > 100);
    CHECK(x < 300);
    REQUIRE(f.player.back());
    CHECK(f.player.screen() == SA);
    b = f.itemOf(SB);
    REQUIRE(b);
    if (web) {
      CHECK(b->parentCss.m02 + 1000 == doctest::Approx(x).epsilon(0.03));
      f.advance((1 - x / 400) * 300 + 20);
      CHECK(!f.player.animating());
    } else {
      CHECK(b->parentCss.m02 + 1000 == doctest::Approx(0));  // the forward step finished first, then played back
    }
  }
}

// ---- 12. Keep state on reload ------------------------------------------------------------------------------

TEST_CASE("proto.web: the runtime state saved and put back on a fresh start; Restart says so") {
  Fixture f(breakpointDoc());
  auto run = [&](CommandId id, const std::string& j) {
    CommandArgs a;
    REQUIRE(json::parse(j, a.raw));
    REQUIRE(f.ed.command(id, a) == OK);
  };
  run(CommandId::CREATE_VARIABLE_COLLECTION, R"({"name":"State"})");
  Guid set = f.ed.lastCreated()[0], mode = f.ed.lastCreated()[1];
  run(CommandId::CREATE_VARIABLE, "{\"collection\":" + q(set) + ",\"type\":\"FLOAT\",\"name\":\"count\",\"value\":1}");
  Guid var = f.ed.lastCreated()[0];
  // Home / Desktop's long rectangle sets count = 42.
  NodeChange c = NodeChange::changed(f.child(HD, "Long"));
  c.mask = F_EXTRA;
  c.props.extra["prototypeInteractions"] = extra("prototypeInteractions",
      click("{\"connectionType\":\"SET_VARIABLE\",\"targetVariable\":{\"id\":{\"guid\":" + q(var) + "}},\"targetVariableData\":{\"value\":{\"floatValue\":42},\"dataType\":\"FLOAT\"}}"));
  f.ed.applyChanges({c}, APPLY_REMOTE);
  REQUIRE(f.player.start(kPage, HD));
  f.click(600, 500);  // count = 42
  f.click(60, 120);   // the tab → B
  f.click(50, 30);    // → About / Desktop (its tab carried)
  REQUIRE(f.player.screen() == AD);
  f.player.wheel(600, 400, 0, 250);
  std::string saved = f.player.saveState();
  Editor::Resolved r;
  REQUIRE(f.ed.resolveVariableInMode(var, mode, r));
  CHECK(r.f == doctest::Approx(42));

  // A reload: the player starts again from the flow's start, the document as the file has it.
  f.player.stop();
  REQUIRE(f.ed.resolveVariableInMode(var, mode, r));
  CHECK(r.f == doctest::Approx(1));
  REQUIRE(f.player.start(kPage, HD));
  REQUIRE(f.player.restoreState(saved));
  CHECK(f.player.screen() == AD);
  CHECK(f.ed.mainOf(f.child(AD, "Tab")) == TAB_B);
  CHECK(f.player.scrollOf(AD).y == doctest::Approx(250));
  REQUIRE(f.ed.resolveVariableInMode(var, mode, r));
  CHECK(r.f == doctest::Approx(42));
  CHECK(!f.player.restoreState("{\"v\":1,\"page\":\"9:9\"}"));  // another page

  // Restart: as the file has it, and the page hears it.
  f.player.takeEvents();
  f.player.restart();
  bool restarted = false;
  for (auto& e : f.player.takeEvents()) restarted |= e.restarted;
  CHECK(restarted);
  CHECK(f.player.screen() == HD);
  REQUIRE(f.ed.resolveVariableInMode(var, mode, r));
  CHECK(r.f == doctest::Approx(1));
}
