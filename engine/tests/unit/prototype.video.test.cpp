// Video in prototypes (help.figma.com 8878274530455 "Use videos in prototypes", 360040035874 "Prototype actions",
// 14397859494295 "State management"): the schema's video fields, Prototype › Video (autoplay, loop, sound), the video
// actions (UPDATE_MEDIA_RUNTIME) and triggers (ON_MEDIA_HIT / ON_MEDIA_END), state memorised, shared and reset, and a
// playing video's frames drawn in place of its poster.
#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "gfx/null/NullDevice.h"
#include "proto/Player.h"
#include "proto/Prototype.h"
#include "render/ImageCache.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

// Three screens: "Player / 1" (A) and "Player / 2" (B), each with a video "Clip" (1:50, 1:60) of the same file, and
// "Done" (C). On A the buttons Toggle (1:51: Toggle play/pause), Skip (1:52: Jump forward 5 s), Next (1:53: to B).
const Guid A{1, 1}, B{1, 2}, C{1, 3}, VID{1, 50}, TOGGLE{1, 51}, SKIP{1, 52}, VNEXT{1, 53}, VID_B{1, 60};
const char* kVideoHash = "00112233445566778899aabbccddeeff00112233";
const char* kPosterHash = "ffeeddccbbaa99887766554433221100ffeeddcc";

std::string extra(const char* key, const std::string& json) {
  json::Value v;
  REQUIRE(json::parse(json, v));
  std::string bytes = codec::extraFromJson("NodeChange", key, v);
  REQUIRE(!bytes.empty());
  return bytes;
}

Paint videoPaint() {
  Paint p;
  p.type = PaintType::VIDEO;
  p.image = ImageHash::fromHex(kPosterHash);
  json::Value v;
  REQUIRE(json::parse(std::string("{\"hash\":\"") + kVideoHash + "\"}", v));
  p.extra = codec::extraFromJson("Paint", "video", v);
  REQUIRE(!p.extra.empty());
  return p;
}

std::string mediaIx(Guid dest, const char* action, const std::string& more = "") {
  return std::string("[{\"event\":{\"interactionType\":\"ON_CLICK\"},\"actions\":[{\"connectionType\":\"UPDATE_MEDIA_RUNTIME\",\"transitionNodeID\":\"") +
         dest.toString() + "\",\"mediaAction\":\"" + action + "\"" + more + "}]}]";
}

std::vector<NodeChange> videoScreens(const std::string& clipIx = "", bool resetOnNext = false) {
  auto nodes = baseChanges();
  nodes.push_back(make(A, NodeType::FRAME, kPage, "!", {0, 0, 375, 812}, "Player / 1"));
  nodes.push_back(make(B, NodeType::FRAME, kPage, "\"", {500, 0, 375, 812}, "Player / 2"));
  nodes.push_back(make(C, NodeType::FRAME, kPage, "#", {1000, 0, 375, 812}, "Done"));
  for (auto [id, parent] : {std::pair{VID, A}, std::pair{VID_B, B}}) {
    NodeChange v = make(id, NodeType::RECTANGLE, parent, "!", {0, 0, 375, 200}, "Clip");
    v.props.fillPaints = {videoPaint()};
    v.props.extra["videoPlayback"] = extra("videoPlayback", R"({"autoplay":true,"mediaLoop":false,"muted":true})");
    if (id == VID && !clipIx.empty()) v.props.extra["prototypeInteractions"] = extra("prototypeInteractions", clipIx);
    nodes.push_back(v);
  }
  NodeChange t = make(TOGGLE, NodeType::RECTANGLE, A, "\"", {20, 300, 100, 40}, "Toggle");
  t.props.extra["prototypeInteractions"] = extra("prototypeInteractions", mediaIx(VID, "TOGGLE_PLAY_PAUSE"));
  nodes.push_back(t);
  NodeChange s = make(SKIP, NodeType::RECTANGLE, A, "#", {20, 400, 100, 40}, "Skip");
  s.props.extra["prototypeInteractions"] = extra("prototypeInteractions", mediaIx(VID, "SKIP_FORWARD", ",\"mediaSkipByAmount\":5"));
  nodes.push_back(s);
  NodeChange n = make(VNEXT, NodeType::RECTANGLE, A, "$", {20, 500, 100, 40}, "Next");
  n.props.extra["prototypeInteractions"] = extra(
      "prototypeInteractions",
      std::string("[{\"event\":{\"interactionType\":\"ON_CLICK\"},\"actions\":[{\"connectionType\":\"INTERNAL_NODE\",\"navigationType\":\"NAVIGATE\","
                  "\"transitionNodeID\":\"1:2\",\"transitionType\":\"INSTANT_TRANSITION\"") +
          (resetOnNext ? ",\"transitionResetVideoPosition\":true" : "") + "}]}]");
  nodes.push_back(n);
  return nodes;
}

struct Fixture {
  Editor ed;
  proto::Player player{ed};
  explicit Fixture(const std::vector<NodeChange>& nodes) {
    ed.setSessionID(1);
    ed.setViewport(375, 812, 1, 375, 812);
    ed.loadDocument(nodes, kNoGuid);
    ed.takeEvents();
    player.setScale(proto::ScaleMode::FIT);
    REQUIRE(player.start(kPage, A));
  }
  void click(double x, double y) {
    player.pointer(PointerEvent::MOVE, x, y, 0, 0);
    player.pointer(PointerEvent::DOWN, x, y, 1, 0);
    player.pointer(PointerEvent::UP, x, y, 0, 0);
  }
  json::Value media(Guid id) {
    json::Value v;
    REQUIRE(json::parse(player.mediaJson(), v));
    for (auto& x : v.get("videos")->array)
      if (x.get("id")->string == id.toString()) return x;
    return json::Value{};
  }
};

}  // namespace

TEST_CASE("prototype.video: the schema's video fields read and written back") {
  NodeProps p;
  p.extra["prototypeInteractions"] = extra("prototypeInteractions",
      R"([{"event":{"interactionType":"ON_MEDIA_HIT","mediaHitTime":2.5},"actions":[{"connectionType":"UPDATE_MEDIA_RUNTIME","transitionNodeID":"1:50","mediaAction":"SKIP_TO","mediaSkipToTime":7,"transitionResetVideoPosition":true}]}])");
  auto list = proto::interactions(p);
  REQUIRE(list.size() == 1);
  CHECK(list[0].trigger == proto::Trigger::ON_MEDIA_HIT);
  CHECK(list[0].mediaHitTime == doctest::Approx(2.5));
  REQUIRE(list[0].actions.size() == 1);
  CHECK(list[0].actions[0].connection == proto::Connection::UPDATE_MEDIA_RUNTIME);
  CHECK(list[0].actions[0].media == proto::MediaAction::SKIP_TO);
  CHECK(list[0].actions[0].mediaSkipTo == doctest::Approx(7));
  CHECK(list[0].actions[0].resetVideo);
  NodeProps q;
  q.extra["prototypeInteractions"] = proto::encodeInteractions(list);
  auto again = proto::interactions(q);
  REQUIRE(again.size() == 1);
  CHECK(again[0].mediaHitTime == doctest::Approx(2.5));
  CHECK(again[0].actions[0].media == proto::MediaAction::SKIP_TO);
  CHECK(again[0].actions[0].dest == Guid{1, 50});
  CHECK(again[0].actions[0].resetVideo);
  std::vector<Guid> targets;
  proto::mediaTargets(again[0].actions[0], targets);
  CHECK(targets == std::vector<Guid>{Guid{1, 50}});

  NodeProps v;
  v.fillPaints = {videoPaint()};
  v.extra["videoPlayback"] = extra("videoPlayback", R"({"autoplay":true,"mediaLoop":true})");
  CHECK(proto::videoFill(v) == 0);
  CHECK(paintVideoHash(v.fillPaints[0]).hex() == kVideoHash);
  auto s = proto::videoSettings(v);
  CHECK(s.autoplay);
  CHECK(s.loop);
  CHECK(!s.muted);
  CHECK(!proto::videoSettings(NodeProps{}).autoplay);  // absent: the schema's defaults
}

TEST_CASE("prototype.video: autoplay, Play/pause, Jump forward and the end") {
  Fixture f(videoScreens());
  json::Value m = f.media(VID);
  REQUIRE(m.isObject());
  CHECK(m.get("hash")->string == kVideoHash);
  CHECK(m.get("playing")->boolean);  // autoplay
  CHECK(m.get("muted")->boolean);
  CHECK(f.media(VID_B).isNull());  // not shown

  f.click(50, 320);  // Toggle play/pause
  CHECK(!f.player.media(VID)->playing);
  f.click(50, 320);
  CHECK(f.player.media(VID)->playing);
  f.player.mediaFrame(VID, 0, 0, 0, 1.0, 10, false, 0);
  f.click(50, 420);  // Jump forward 5 s
  m = f.media(VID);
  CHECK(m.get("seek")->number == doctest::Approx(6));
  CHECK(m.get("seekSerial")->number == 1);
  // A report from before the seek is ignored; then the page makes the seek.
  f.player.mediaFrame(VID, 0, 0, 0, 1.1, 10, false, 0);
  CHECK(f.player.media(VID)->time == doctest::Approx(6));
  f.player.mediaFrame(VID, 0, 0, 0, 6.02, 10, false, 1);
  CHECK(f.media(VID).get("seek")->isNull());
  // Past the end: to the end (not looping).
  f.click(50, 420);
  CHECK(f.player.media(VID)->time == doctest::Approx(10));
  CHECK(f.player.media(VID)->ended);
  CHECK(!f.player.media(VID)->playing);
  // Played again: from the beginning.
  f.click(50, 320);
  CHECK(f.player.media(VID)->playing);
  CHECK(f.player.media(VID)->time == doctest::Approx(0));
}

TEST_CASE("prototype.video: When video hits, When video ends") {
  {
    Fixture f(videoScreens(
        R"([{"event":{"interactionType":"ON_MEDIA_HIT","mediaHitTime":3},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"NAVIGATE","transitionNodeID":"1:3","transitionType":"INSTANT_TRANSITION"}]}])"));
    f.player.mediaJson();
    f.player.mediaFrame(VID, 0, 0, 0, 2.0, 8, false, 0);
    CHECK(f.player.screen() == A);
    f.player.mediaFrame(VID, 0, 0, 0, 3.05, 8, false, 0);
    CHECK(f.player.screen() == C);
  }
  {
    // A time past the video's length fires when it ends.
    Fixture f(videoScreens(
        R"([{"event":{"interactionType":"ON_MEDIA_HIT","mediaHitTime":30},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"NAVIGATE","transitionNodeID":"1:3","transitionType":"INSTANT_TRANSITION"}]}])"));
    f.player.mediaJson();
    f.player.mediaFrame(VID, 0, 0, 0, 7.9, 8, false, 0);
    CHECK(f.player.screen() == A);
    f.player.mediaFrame(VID, 0, 0, 0, 8, 8, true, 0);
    CHECK(f.player.screen() == C);
  }
  {
    Fixture f(videoScreens(
        R"([{"event":{"interactionType":"ON_MEDIA_END"},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"NAVIGATE","transitionNodeID":"1:3","transitionType":"INSTANT_TRANSITION"}]}])"));
    f.player.mediaJson();
    f.player.mediaFrame(VID, 0, 0, 0, 7.9, 8, false, 0);
    CHECK(f.player.screen() == A);
    f.player.mediaFrame(VID, 0, 0, 0, 8, 8, true, 0);
    CHECK(f.player.screen() == C);
    CHECK(!f.player.media(VID)->playing);
  }
}

TEST_CASE("prototype.video: state shared with a matching video, memorised, reset by Reset video state") {
  {
    // "Player / 1" › Clip and "Player / 2" › Clip match: B's clip goes on from A's time, paused as A's was.
    Fixture f(videoScreens());
    f.player.mediaJson();
    f.player.mediaFrame(VID, 0, 0, 0, 4.5, 8, false, 0);
    f.click(50, 320);  // paused
    f.click(50, 520);  // Next
    CHECK(f.player.screen() == B);
    json::Value m = f.media(VID_B);
    REQUIRE(m.isObject());
    CHECK(!m.get("playing")->boolean);
    CHECK(m.get("seek")->number == doctest::Approx(4.5));
    CHECK(f.media(VID).isNull());  // off screen, its state kept
    CHECK(f.player.media(VID)->time == doctest::Approx(4.5));
    // Back on A: as it was left.
    f.player.back();
    m = f.media(VID);
    REQUIRE(m.isObject());
    CHECK(!m.get("playing")->boolean);
    CHECK(m.get("time")->number == doctest::Approx(4.5));
  }
  {
    // Reset video state: B's clip from the beginning, as set on the canvas (autoplay).
    Fixture f(videoScreens("", true));
    f.player.mediaJson();
    f.player.mediaFrame(VID, 0, 0, 0, 4.5, 8, false, 0);
    f.click(50, 320);
    f.click(50, 520);
    json::Value m = f.media(VID_B);
    REQUIRE(m.isObject());
    CHECK(m.get("playing")->boolean);
    CHECK(m.get("time")->number == doctest::Approx(0));
  }
}

TEST_CASE("prototype.video: a frame of the video is drawn in place of the poster") {
  Fixture f(videoScreens());
  f.player.scene();
  const NodeProps* drawn = f.player.drawnProps(VID);
  CHECK((!drawn || drawn->fillPaints[0].image.hex() == kPosterHash));  // the poster
  auto rgba = std::make_shared<std::vector<uint8_t>>(4 * 4 * 4, 200);
  f.player.mediaFrame(VID, 0, 4, 4, 0.5, 8, false, 0, rgba);
  CHECK(f.player.needsFrame());
  f.player.scene();
  drawn = f.player.drawnProps(VID);
  REQUIRE(drawn);
  CHECK(drawn->fillPaints[0].image == f.player.frameHash(VID));
  CHECK(drawn->fillPaints[0].type == PaintType::VIDEO);
  const ImageRegistry::Source* src = ImageRegistry::get().find(f.player.frameHash(VID));
  REQUIRE(src);
  CHECK(src->live);
  uint32_t serial = src->serial;
  f.player.mediaFrame(VID, 0, 4, 4, 0.6, 8, false, 0, rgba);
  CHECK(ImageRegistry::get().find(f.player.frameHash(VID))->serial == serial + 1);
  // The renderer writes each frame into the same texture.
  gfx::NullDevice dev;
  ImageCache cache(dev);
  auto t1 = cache.texture(f.player.frameHash(VID));
  CHECK(t1.id != 0);
  f.player.mediaFrame(VID, 0, 4, 4, 0.7, 8, false, 0, rgba);
  auto t2 = cache.texture(f.player.frameHash(VID));
  CHECK(t2.id == t1.id);
  f.player.stop();
  // The live source is gone (find() would ask for it again: the registry is the module's, shared by every test).
  CHECK(ImageRegistry::get().find(f.player.frameHash(VID)) == nullptr);
  ImageRegistry::get().takeRequests();
}

TEST_CASE("prototype.video: a noodle dropped on a video makes a video action; its connection is drawn") {
  Editor ed;
  ed.setSessionID(1);
  ed.setViewport(1600, 1000, 1, 1600, 1000);
  auto nodes = videoScreens();
  for (auto& n : nodes)
    if (n.guid == TOGGLE) n.props.extra.erase("prototypeInteractions");
  ed.loadDocument(nodes, kNoGuid);
  Camera cam;
  cam.zoom = 1;
  ed.setCamera(cam);
  ed.setPrototypeMode(true);
  size_t links = ed.overlay().prototype.links.size();
  ed.setSelection({TOGGLE});
  // Toggle's handle: its right edge's middle (120, 320); the clip is at (0, 0, 375, 200) in A.
  CHECK(ed.pointer(PointerEvent::DOWN, 120, 320, 0, 1, 0) != 0);
  ed.pointer(PointerEvent::MOVE, 200, 200, 0, 1, 0);
  ed.pointer(PointerEvent::MOVE, 200, 100, 0, 1, 0);
  ed.pointer(PointerEvent::UP, 200, 100, 0, 0, 0);
  auto list = proto::interactions(ed.document().get(TOGGLE)->props);
  REQUIRE(list.size() == 1);
  REQUIRE(list[0].actions.size() == 1);
  CHECK(list[0].actions[0].connection == proto::Connection::UPDATE_MEDIA_RUNTIME);
  CHECK(list[0].actions[0].media == proto::MediaAction::PLAY);
  CHECK(list[0].actions[0].dest == VID);
  ed.setSelection({});
  // Every video action's connection is drawn (Skip → Clip, Next → B, and now Toggle → Clip).
  CHECK(ed.overlay().prototype.links.size() == links + 1);
}
