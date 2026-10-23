// Two Wecra-only prototype features (docs/engine.md §3.4, not Figma's; a .fig export drops both):
// - On double click (InteractionType ON_DOUBLE_CLICK = 100, @ours): a second click within 500 ms and 5 px of the first
//   runs the deepest layer under the pointer with that trigger — after the second click's own On click, as a browser's
//   dblclick; a third click starts a new pair; an instance plays its main's.
// - Scrollbar (NodeChange.prototypeScrollbar, @ours): a scrolling frame with it on gets thumbs in the scene
//   (PresentScene::scrollbars, drawn by the renderer after its children) that follow its scroll; dragging one scrolls
//   the frame, and the press is no click.
#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "proto/Player.h"
#include "proto/Prototype.h"
#include "render/FrameScrollbar.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid HOME{1, 1}, NEXT{1, 2}, OVER{1, 3}, CARD{1, 10}, BUTTON{1, 11}, TILE{1, 20}, TILE_HIT{1, 21}, INST{1, 22}, LIST{1, 30},
    CONTENT{1, 31}, SHORT{1, 32}, SHORT_CONTENT{1, 33};

std::string extra(const char* key, const std::string& text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  std::string bytes = codec::extraFromJson("NodeChange", key, v);
  REQUIRE(!bytes.empty());
  return bytes;
}

std::string ix(const char* trigger, const std::string& action) {
  return std::string(R"([{"event":{"interactionType":")") + trigger + R"("},"actions":[)" + action + "]}]";
}
std::string node(const char* navigation, Guid dest) {
  return std::string(R"({"connectionType":"INTERNAL_NODE","navigationType":")") + navigation +
         R"(","transitionType":"INSTANT_TRANSITION","transitionNodeID":")" + dest.toString() + "\"}";
}

// Home (375 × 812): a Card (On click → open the overlay "Over") holding a Button (On double click → Next); an instance
// of the component "Tile" whose "Hit" has On double click → Next; a List (0, 400, 200 × 300, overflow Vertical,
// Scrollbar on) holding 900 px of Content (On click → Next), and a Short list whose content fits.
std::vector<NodeChange> scene(bool scrollbar = true) {
  auto nodes = baseChanges();
  nodes.push_back(make(HOME, NodeType::FRAME, kPage, "!", {0, 0, 375, 812}, "Home"));
  nodes.push_back(make(NEXT, NodeType::FRAME, kPage, "\"", {500, 0, 375, 812}, "Next"));
  nodes.push_back(make(OVER, NodeType::FRAME, kPage, "#", {1000, 0, 100, 100}, "Over"));
  NodeChange card = make(CARD, NodeType::FRAME, HOME, "!", {20, 20, 200, 100}, "Card");
  card.props.extra["prototypeInteractions"] = extra("prototypeInteractions", ix("ON_CLICK", node("OVERLAY", OVER)));
  nodes.push_back(card);
  NodeChange button = make(BUTTON, NodeType::RECTANGLE, CARD, "!", {10, 10, 100, 40}, "Button");
  button.props.extra["prototypeInteractions"] = extra("prototypeInteractions", ix("ON_DOUBLE_CLICK", node("NAVIGATE", NEXT)));
  nodes.push_back(button);
  nodes.push_back(make(TILE, NodeType::SYMBOL, kPage, "$", {1200, 0, 100, 100}, "Tile"));
  NodeChange hit = make(TILE_HIT, NodeType::RECTANGLE, TILE, "!", {0, 0, 100, 100}, "Hit");
  hit.props.extra["prototypeInteractions"] = extra("prototypeInteractions", ix("ON_DOUBLE_CLICK", node("NAVIGATE", NEXT)));
  nodes.push_back(hit);
  NodeChange inst = make(INST, NodeType::INSTANCE, HOME, "\"", {250, 20, 100, 100}, "Tile");
  inst.props.comp().symbolData.symbolID = TILE;
  inst.props.fillPaints.clear();
  nodes.push_back(inst);
  NodeChange list = make(LIST, NodeType::FRAME, HOME, "#", {0, 400, 200, 300}, "List");
  list.props.extra["scrollDirection"] = extra("scrollDirection", R"("VERTICAL")");
  if (scrollbar) list.props.extra["prototypeScrollbar"] = extra("prototypeScrollbar", "true");
  nodes.push_back(list);
  NodeChange content = make(CONTENT, NodeType::RECTANGLE, LIST, "!", {0, 0, 200, 900}, "Content");
  content.props.extra["prototypeInteractions"] = extra("prototypeInteractions", ix("ON_CLICK", node("NAVIGATE", NEXT)));
  nodes.push_back(content);
  NodeChange shortList = make(SHORT, NodeType::FRAME, HOME, "$", {250, 400, 100, 300}, "Short");
  shortList.props.extra["scrollDirection"] = extra("scrollDirection", R"("BOTH")");
  shortList.props.extra["prototypeScrollbar"] = extra("prototypeScrollbar", "true");
  nodes.push_back(shortList);
  nodes.push_back(make(SHORT_CONTENT, NodeType::RECTANGLE, SHORT, "!", {0, 0, 100, 200}, "Fits"));
  return nodes;
}

struct Fixture {
  Editor ed;
  proto::Player player{ed};
  double t = 0;
  explicit Fixture(bool scrollbar = true) {
    ed.setSessionID(1);
    ed.setViewport(375, 812, 1, 375, 812);
    ed.loadDocument(scene(scrollbar), kNoGuid);
    ed.takeEvents();
    REQUIRE(player.start(kPage, HOME));
    wait(16);
  }
  void wait(double ms) {
    while (ms > 0) {
      double step = std::min(16.0, ms);
      t += step;
      ms -= step;
      player.tick(t);
    }
  }
  void click(double x, double y) {
    player.pointer(PointerEvent::MOVE, x, y, 0, 0, t);
    player.pointer(PointerEvent::DOWN, x, y, 1, 0, t);
    wait(32);
    player.pointer(PointerEvent::UP, x, y, 0, 0, t);
  }
};

}  // namespace

TEST_CASE("proto.double_click: the trigger reads and writes as ON_DOUBLE_CLICK (100), by name or number") {
  NodeProps p;
  p.extra["prototypeInteractions"] = extra("prototypeInteractions", ix("ON_DOUBLE_CLICK", node("NAVIGATE", NEXT)));
  auto list = proto::interactions(p);
  REQUIRE(list.size() == 1);
  CHECK(list[0].trigger == proto::Trigger::ON_DOUBLE_CLICK);
  CHECK(std::string(proto::triggerName(proto::Trigger::ON_DOUBLE_CLICK)) == "ON_DOUBLE_CLICK");
  json::Value v = proto::toJson(list[0]);
  CHECK(v.get("event")->get("interactionType")->string == "ON_DOUBLE_CLICK");
  NodeProps q;
  q.extra["prototypeInteractions"] = proto::encodeInteractions(list);
  CHECK(proto::interactions(q)[0].trigger == proto::Trigger::ON_DOUBLE_CLICK);
  NodeProps n;
  n.extra["prototypeInteractions"] = extra("prototypeInteractions", R"([{"event":{"interactionType":100},"actions":[]}])");
  CHECK(proto::interactions(n)[0].trigger == proto::Trigger::ON_DOUBLE_CLICK);
}

TEST_CASE("proto.double_click: click, click, then the double click — only a quick second click near the first") {
  Fixture f;
  // A single click: the Card's On click (the Button has no On click), no double click.
  f.click(60, 50);
  CHECK(f.player.overlays().size() == 1);
  CHECK(f.player.screen() == HOME);
  // Too late for a pair (600 ms): a click again, still no double click.
  f.wait(600);
  f.click(60, 50);
  CHECK(f.player.screen() == HOME);
  // Too far from the first (8 px): a new first click.
  f.wait(100);
  f.click(68, 50);
  CHECK(f.player.screen() == HOME);
  // Quick and near: the second click's On click runs, then the double click (the Button's: deepest first).
  f.wait(100);
  f.click(69, 51);
  CHECK(f.player.screen() == NEXT);
}

TEST_CASE("proto.double_click: a third click starts a new pair") {
  Fixture f;
  f.click(60, 50);
  f.wait(100);
  f.click(60, 50);
  CHECK(f.player.screen() == NEXT);
  CHECK(f.player.back());
  f.wait(16);
  REQUIRE(f.player.screen() == HOME);
  // The second click of the pair above is no first click of another: one more quick click alone does nothing.
  f.wait(100);
  f.click(60, 50);
  CHECK(f.player.screen() == HOME);
}

TEST_CASE("proto.double_click: an instance plays its main's On double click") {
  Fixture f;
  f.click(300, 70);
  CHECK(f.player.screen() == HOME);
  f.wait(120);
  f.click(300, 70);
  CHECK(f.player.screen() == NEXT);
}

TEST_CASE("proto.scrollbar: thumbs follow the scroll, a drag on one scrolls its frame (no click)") {
  CHECK(proto::scrollbar(Fixture().ed.document().get(LIST)->props));
  Fixture f;
  const PresentScene& s0 = f.player.scene();
  REQUIRE(s0.scrollbars.count(LIST));
  FrameScrollbarState st = s0.scrollbars.at(LIST);
  CHECK(st.vertical);
  CHECK(!st.horizontal);
  CHECK(st.range.y == doctest::Approx(600));
  FrameScrollbarThumbs t = frameScrollbarThumbs(st);
  REQUIRE(t.v);
  CHECK(!t.h);
  // 6 thick, 4 in from the right edge and from the track's ends, as long as the part shown (300 of 900).
  CHECK(t.vTrack.x == doctest::Approx(190));
  CHECK(t.vTrack.y == doctest::Approx(4));
  CHECK(t.vTrack.w == doctest::Approx(6));
  CHECK(t.vTrack.h == doctest::Approx(292));
  CHECK(t.vThumb.h == doctest::Approx(292.0 / 3));
  CHECK(t.vThumb.y == doctest::Approx(4));
  // The short list's content fits: no thumbs (it is in the map, nothing to draw).
  REQUIRE(s0.scrollbars.count(SHORT));
  FrameScrollbarThumbs none = frameScrollbarThumbs(s0.scrollbars.at(SHORT));
  CHECK(!none.v);
  CHECK(!none.h);

  // The wheel scrolls the list half way: the thumb half way down its track.
  f.player.wheel(100, 500, 0, 300);
  f.wait(16);
  st = f.player.scene().scrollbars.at(LIST);
  CHECK(st.scroll.y == doctest::Approx(300));
  t = frameScrollbarThumbs(st);
  CHECK(t.vThumb.y == doctest::Approx(4 + (292 - 292.0 / 3) / 2));

  // Drag the thumb 50 px down (List at y 400 on the screen): the list scrolls 50 × 600 / (292 − 97.3).
  f.wait(1000);
  double y = 400 + t.vThumb.y + 10;
  f.player.pointer(PointerEvent::MOVE, 193, y, 0, 0, f.t);
  f.player.pointer(PointerEvent::DOWN, 193, y, 1, 0, f.t);
  f.player.pointer(PointerEvent::MOVE, 193, y + 25, 1, 0, f.t);
  f.player.pointer(PointerEvent::MOVE, 193, y + 50, 1, 0, f.t);
  double per = 600 / (292 - 292.0 / 3);
  CHECK(f.player.scrollOf(LIST).y == doctest::Approx(300 + 50 * per));
  // Past the end it stops at the end.
  f.player.pointer(PointerEvent::MOVE, 193, y + 400, 1, 0, f.t);
  CHECK(f.player.scrollOf(LIST).y == doctest::Approx(600));
  f.player.pointer(PointerEvent::UP, 193, y + 400, 0, 0, f.t);
  f.wait(100);
  // The press on the thumb (over the Content's On click) was no click.
  CHECK(f.player.screen() == HOME);
  t = frameScrollbarThumbs(f.player.scene().scrollbars.at(LIST));
  CHECK(t.vThumb.bottom() == doctest::Approx(296));
  // A click on the content beside the thumb is a click.
  f.wait(600);
  f.click(100, 500);
  CHECK(f.player.screen() == NEXT);
}

TEST_CASE("proto.scrollbar: off, no thumbs and a press there is the content's") {
  Fixture f(false);
  CHECK(!f.player.scene().scrollbars.count(LIST));
  f.click(193, 420);
  CHECK(f.player.screen() == NEXT);
}
