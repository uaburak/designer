// Prototype timing as Figma reads and plays it (docs/research/rea/motion.md §2.2): a zero duration reads 0.3 s, a
// zero After delay 0.8 s; mouse enter / leave / down / up keep their delay in interactionMaintained +
// interactionDuration (Wecra's earlier transitionTimeout placement still read), and the player waits it out,
// cancelling when the pointer undoes the trigger first; new interactions carry stateManagementVersion 1.
#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "proto/Player.h"
#include "proto/Prototype.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid HOME{1, 1}, NEXT{1, 2}, BUTTON{1, 11};

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

// Home with a 100 × 40 button at (20, 20) whose `event` navigates to Next.
struct Fixture {
  Editor ed;
  proto::Player player{ed};
  double t = 0;
  explicit Fixture(const std::string& event) {
    auto nodes = baseChanges();
    nodes.push_back(make(HOME, NodeType::FRAME, kPage, "!", {0, 0, 375, 812}, "Home"));
    nodes.push_back(make(NEXT, NodeType::FRAME, kPage, "\"", {500, 0, 375, 812}, "Next"));
    NodeChange b = make(BUTTON, NodeType::RECTANGLE, HOME, "!", {20, 20, 100, 40}, "Button");
    b.props.extra["prototypeInteractions"] = extra("prototypeInteractions",
        "[{\"event\":" + event +
            ",\"actions\":[{\"connectionType\":\"INTERNAL_NODE\",\"navigationType\":\"NAVIGATE\",\"transitionNodeID\":\"1:2\","
            "\"transitionType\":\"INSTANT_TRANSITION\"}]}]");
    nodes.push_back(b);
    ed.setSessionID(1);
    ed.setViewport(375, 812, 1, 375, 812);
    ed.loadDocument(nodes, kNoGuid);
    ed.takeEvents();
    REQUIRE(player.start(kPage, HOME));
    advance(16);
  }
  void advance(double ms) {
    t += ms;
    player.tick(t);
  }
  void move(double x, double y) { player.pointer(PointerEvent::MOVE, x, y, 0, 0); }
};

}  // namespace

TEST_CASE("proto.delay: a zero duration reads 0.3 s and a zero After delay 0.8 s (Figma's `|| .3` / `|| .8`)") {
  auto list = read(R"([{"event":{"interactionType":"AFTER_TIMEOUT","transitionTimeout":0},"actions":[{"connectionType":"BACK","transitionType":"DISSOLVE","transitionDuration":0}]},
                       {"event":{"interactionType":"AFTER_TIMEOUT"},"actions":[{"connectionType":"BACK","transitionType":"DISSOLVE"}]},
                       {"event":{"interactionType":"AFTER_TIMEOUT","transitionTimeout":1.5},"actions":[{"connectionType":"BACK","transitionType":"DISSOLVE","transitionDuration":0.45}]}])");
  REQUIRE(list.size() == 3);
  CHECK(list[0].timeout == doctest::Approx(0.8));
  CHECK(list[0].actions[0].duration == doctest::Approx(0.3));
  CHECK(list[1].timeout == doctest::Approx(0.8));
  CHECK(list[1].actions[0].duration == doctest::Approx(0.3));
  CHECK(list[2].timeout == doctest::Approx(1.5));
  CHECK(list[2].actions[0].duration == doctest::Approx(0.45));
}

TEST_CASE("proto.delay: mouse delays live in interactionMaintained + interactionDuration") {
  auto list = read(R"([{"event":{"interactionType":"MOUSE_ENTER","interactionMaintained":true,"interactionDuration":0.5},"actions":[]},
                       {"event":{"interactionType":"MOUSE_LEAVE","interactionMaintained":true},"actions":[]},
                       {"event":{"interactionType":"MOUSE_DOWN"},"actions":[]},
                       {"event":{"interactionType":"MOUSE_UP","transitionTimeout":0.25},"actions":[]},
                       {"event":{"interactionType":"ON_CLICK","interactionMaintained":true,"interactionDuration":2},"actions":[]}])");
  REQUIRE(list.size() == 5);
  CHECK(list[0].delay == doctest::Approx(0.5));
  CHECK(list[1].delay == doctest::Approx(0.3));   // maintained with no duration: Figma's 0.3
  CHECK(list[2].delay == 0);
  CHECK(list[3].delay == doctest::Approx(0.25));  // Wecra's earlier placement, read once
  CHECK(list[4].delay == 0);                      // only the mouse triggers wait

  // Written in Figma's placement, not in transitionTimeout.
  json::Value v = proto::toJson(list[3]);
  const json::Value* e = v.get("event");
  REQUIRE(e);
  REQUIRE(e->get("interactionMaintained"));
  CHECK(e->get("interactionMaintained")->boolean);
  CHECK(e->get("interactionDuration")->number == doctest::Approx(0.25));
  CHECK(!e->get("transitionTimeout"));
  NodeProps q;
  q.extra["prototypeInteractions"] = proto::encodeInteractions({list[3]});
  CHECK(proto::interactions(q)[0].delay == doctest::Approx(0.25));
  // No delay: neither field.
  json::Value none = proto::toJson(list[2]);
  CHECK(!none.get("event")->get("interactionMaintained"));
}

TEST_CASE("proto.delay: new connections carry stateManagementVersion 1 and keep it through a round trip") {
  proto::Interaction i = proto::newConnection(Guid{5, 1}, NEXT);
  CHECK(i.stateManagementVersion == 1);
  json::Value v = proto::toJson(i);
  REQUIRE(v.get("stateManagementVersion"));
  CHECK(v.get("stateManagementVersion")->number == 1);
  NodeProps p;
  p.extra["prototypeInteractions"] = proto::encodeInteractions({i});
  CHECK(proto::interactions(p)[0].stateManagementVersion == 1);
}

TEST_CASE("proto.delay: the player waits out a Mouse enter delay, and drops it when the pointer leaves first") {
  SUBCASE("stays: runs after the delay") {
    Fixture f(R"({"interactionType":"MOUSE_ENTER","interactionMaintained":true,"interactionDuration":0.5})");
    f.move(50, 40);
    f.advance(16);
    CHECK(f.player.screen() == HOME);
    CHECK(f.player.nextFrameDelay() >= 0);  // a frame is asked for when the delay ends
    f.advance(300);
    CHECK(f.player.screen() == HOME);
    f.advance(250);
    CHECK(f.player.screen() == NEXT);
  }
  SUBCASE("leaves before the delay ends: nothing runs") {
    Fixture f(R"({"interactionType":"MOUSE_ENTER","interactionMaintained":true,"interactionDuration":0.5})");
    f.move(50, 40);
    f.advance(16);
    f.advance(200);
    f.move(300, 400);
    f.advance(1000);
    CHECK(f.player.screen() == HOME);
  }
  SUBCASE("no delay: at once") {
    Fixture f(R"({"interactionType":"MOUSE_ENTER"})");
    f.move(50, 40);
    CHECK(f.player.screen() == NEXT);
  }
}

TEST_CASE("proto.delay: Mouse leave waits for the pointer to stay away; Mouse down is dropped on release") {
  SUBCASE("mouse leave") {
    Fixture f(R"({"interactionType":"MOUSE_LEAVE","interactionMaintained":true,"interactionDuration":0.4})");
    f.move(50, 40);
    f.move(300, 400);
    f.advance(16);
    f.advance(200);
    f.move(50, 40);  // back before 400 ms
    f.advance(1000);
    CHECK(f.player.screen() == HOME);
    f.move(300, 400);
    f.advance(16);
    f.advance(450);
    CHECK(f.player.screen() == NEXT);
  }
  SUBCASE("mouse down held, then released early") {
    Fixture f(R"({"interactionType":"MOUSE_DOWN","interactionMaintained":true,"interactionDuration":0.3})");
    f.move(50, 40);
    f.player.pointer(PointerEvent::DOWN, 50, 40, 1, 0);
    f.advance(16);
    f.advance(100);
    f.player.pointer(PointerEvent::UP, 50, 40, 0, 0);
    f.advance(1000);
    CHECK(f.player.screen() == HOME);
    f.player.pointer(PointerEvent::DOWN, 50, 40, 1, 0);
    f.advance(16);
    f.advance(350);
    CHECK(f.player.screen() == NEXT);
  }
}

TEST_CASE("proto.delay: the legacy Mouse in plays as Mouse enter") {
  Fixture f(R"({"interactionType":"MOUSE_IN"})");
  f.move(50, 40);
  CHECK(f.player.screen() == NEXT);
}
