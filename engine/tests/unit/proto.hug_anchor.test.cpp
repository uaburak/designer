// A Hug auto-layout frame or instance resized by its content keeps the side its constraints hold (Figma, measured
// live 2026-10-20 — docs/research/figma/live/2026-10-20/prototype-playback.txt "Hug anchors"): a variant switch in the
// editor, Change to in a prototype (Instant and Smart animate, every frame of the animation), a content edit.
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

const Guid SET{2, 1}, VA{2, 2}, VB{2, 3}, BOXA{2, 4}, BOXB{2, 5}, SCREEN{2, 10}, INST{2, 11}, HOLDER{2, 12}, LEFT{2, 13},
    RIGHT{2, 14};

std::string extra(const char* key, const std::string& json) {
  json::Value v;
  REQUIRE(json::parse(json, v));
  std::string bytes = codec::extraFromJson("NodeChange", key, v);
  REQUIRE(!bytes.empty());
  return bytes;
}

std::string changeTo(Guid dest, const char* transition, double duration) {
  return std::string(R"([{"id":"9:1","event":{"interactionType":"ON_CLICK"},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"SWAP_STATE","transitionNodeID":")") +
         dest.toString() + "\",\"transitionType\":\"" + transition + "\",\"transitionDuration\":" + std::to_string(duration) +
         ",\"easingType\":\"LINEAR\"}]}]";
}

void hug(NodeChange& c) {
  c.props.stack().stackMode = StackMode::HORIZONTAL;
  c.props.stack().stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  c.props.stack().stackCounterSizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
}

// A set of two Hug variants (a 100 × 40 box, a 200 × 80 box; A changes to B on click) and a 400 × 300 screen with an
// instance of A at (150, 130) — constrained h / v — or, `inAutoLayout`, in a vertical auto-layout frame centring it.
std::vector<NodeChange> doc(ConstraintType h, ConstraintType v, const char* transition = "INSTANT_TRANSITION", double duration = 0,
                            bool inAutoLayout = false) {
  auto nodes = baseChanges();
  NodeChange set = make(SET, NodeType::FRAME, kPage, "~", {0, 1000, 400, 200}, "Btn");
  set.props.comp().isStateGroup = true;
  nodes.push_back(set);
  NodeChange a = make(VA, NodeType::SYMBOL, SET, "!", {20, 20, 100, 40}, "State=a");
  hug(a);
  a.props.extra["prototypeInteractions"] = extra("prototypeInteractions", changeTo(VB, transition, duration));
  nodes.push_back(a);
  nodes.push_back(make(BOXA, NodeType::RECTANGLE, VA, "!", {0, 0, 100, 40}, "box"));
  NodeChange b = make(VB, NodeType::SYMBOL, SET, "\"", {150, 20, 200, 80}, "State=b");
  hug(b);
  nodes.push_back(b);
  nodes.push_back(make(BOXB, NodeType::RECTANGLE, VB, "!", {0, 0, 200, 80}, "box"));
  NodeChange screen = make(SCREEN, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "Screen");
  Guid parent = SCREEN;
  if (inAutoLayout) {
    screen.props.stack().stackMode = StackMode::VERTICAL;
    screen.props.stack().stackPrimarySizing = StackSize::FIXED;
    screen.props.stack().stackCounterSizing = StackSize::FIXED;
    screen.props.stack().stackPrimaryAlignItems = StackJustify::CENTER;
    screen.props.stack().stackCounterAlignItems = StackAlign::CENTER;
  }
  nodes.push_back(screen);
  NodeChange inst = make(INST, NodeType::INSTANCE, parent, "!", {150, 130, 100, 40}, "Btn");
  inst.props.comp().symbolData.symbolID = VA;
  hug(inst);
  inst.props.horizontalConstraint = h;
  inst.props.verticalConstraint = v;
  nodes.push_back(inst);
  return nodes;
}

struct Fixture {
  Editor ed;
  proto::Player player{ed};
  double t = 0;
  explicit Fixture(const std::vector<NodeChange>& nodes) {
    ed.setSessionID(1);
    ed.setViewport(400, 300, 1, 400, 300);
    ed.loadDocument(nodes, kNoGuid);
    ed.takeEvents();
  }
  void click(double x, double y) {
    player.pointer(PointerEvent::MOVE, x, y, 0, 0);
    player.pointer(PointerEvent::DOWN, x, y, 1, 0);
    player.pointer(PointerEvent::UP, x, y, 0, 0);
  }
  void advance(double ms) {
    while (ms > 0) {
      double step = std::min(16.0, ms);
      t += step;
      ms -= step;
      player.tick(t);
    }
  }
  Rect box(Guid id) const {
    const NodeProps& p = ed.document().get(id)->props;
    return {p.transform.m02, p.transform.m12, p.size.x, p.size.y};
  }
};

CommandArgs args(const std::string& jsonText) {
  CommandArgs a;
  json::parse(jsonText, a.raw);
  return a;
}

void swapInEditor(Fixture& f, Guid main) {
  REQUIRE(f.ed.command(CommandId::SWAP_INSTANCE, args("{\"main\":\"" + main.toString() + "\",\"ref\":\"" + INST.toString() + "\"}")) == OK);
}

}  // namespace

TEST_CASE("hug anchors: a variant switch in the editor keeps the side the instance's constraints hold") {
  struct Case {
    ConstraintType h, v;
    Rect after;
  };
  // Live Figma (setProperties on the same set): Left/Top keeps (150, 130); Right/Bottom keeps the right / bottom edge;
  // Center, Left & Right and Scale keep the centre (200, 150).
  const Case cases[] = {
      {ConstraintType::MIN, ConstraintType::MIN, {150, 130, 200, 80}},
      {ConstraintType::MAX, ConstraintType::MAX, {50, 90, 200, 80}},
      {ConstraintType::CENTER, ConstraintType::CENTER, {100, 110, 200, 80}},
      {ConstraintType::STRETCH, ConstraintType::STRETCH, {100, 110, 200, 80}},
      {ConstraintType::SCALE, ConstraintType::SCALE, {100, 110, 200, 80}},
      {ConstraintType::CENTER, ConstraintType::MIN, {100, 130, 200, 80}},
  };
  for (const Case& c : cases) {
    Fixture f(doc(c.h, c.v));
    CHECK(f.box(INST) == Rect{150, 130, 100, 40});
    swapInEditor(f, VB);
    CHECK(f.box(INST) == c.after);
    // Back: where it was.
    swapInEditor(f, VA);
    CHECK(f.box(INST) == Rect{150, 130, 100, 40});
    // One undo step back to B's place, another to A's.
    REQUIRE(f.ed.command(CommandId::UNDO) == OK);
    CHECK(f.box(INST) == c.after);
    REQUIRE(f.ed.command(CommandId::UNDO) == OK);
    CHECK(f.box(INST) == Rect{150, 130, 100, 40});
  }
}

TEST_CASE("hug anchors: a Hug frame whose content grows keeps the side its constraints hold") {
  auto nodes = baseChanges();
  const Guid FR{3, 1}, H{3, 2}, R{3, 3};
  nodes.push_back(make(FR, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "Frame"));
  NodeChange h = make(H, NodeType::FRAME, FR, "!", {100, 100, 100, 40}, "Hug");
  hug(h);
  h.props.horizontalConstraint = ConstraintType::MAX;
  h.props.verticalConstraint = ConstraintType::CENTER;
  nodes.push_back(h);
  nodes.push_back(make(R, NodeType::RECTANGLE, H, "!", {0, 0, 100, 40}, "box"));
  Fixture f(nodes);
  f.ed.setProps({R}, [&] {
    NodeChange c = NodeChange::changed(R);
    c.mask = F_SIZE;
    c.props.size = {200, 80};
    return c;
  }(), 0);
  // Live Figma (MAX / CENTER): (0, 80) — the right edge and the vertical centre stay.
  CHECK(f.box(H) == Rect{0, 80, 200, 80});
}

TEST_CASE("hug anchors: Change to in a prototype — Instant, and Smart animate holding the centre every frame") {
  SUBCASE("Instant, Center / Center") {
    Fixture f(doc(ConstraintType::CENTER, ConstraintType::CENTER));
    REQUIRE(f.player.start(kPage, SCREEN));
    f.click(200, 150);
    CHECK(f.ed.mainOf(INST) == VB);
    CHECK(f.box(INST) == Rect{100, 110, 200, 80});
  }
  SUBCASE("Instant, Right / Bottom") {
    Fixture f(doc(ConstraintType::MAX, ConstraintType::MAX));
    REQUIRE(f.player.start(kPage, SCREEN));
    f.click(200, 150);
    CHECK(f.box(INST) == Rect{50, 90, 200, 80});
  }
  SUBCASE("Smart animate, Center / Center: the midpoint is centred, the end too; Restart puts it back") {
    Fixture f(doc(ConstraintType::CENTER, ConstraintType::CENTER, "SMART_ANIMATE", 1.0));
    REQUIRE(f.player.start(kPage, SCREEN));
    f.click(200, 150);
    f.advance(16);
    f.advance(484);
    f.player.scene();
    const NodeProps* mid = f.player.drawnProps(INST);
    REQUIRE(mid);
    double cx = mid->transform.m02 + mid->size.x / 2, cy = mid->transform.m12 + mid->size.y / 2;
    CHECK(cx == doctest::Approx(200).epsilon(0.001));
    CHECK(cy == doctest::Approx(150).epsilon(0.001));
    CHECK(mid->size.x > 120);
    CHECK(mid->size.x < 180);
    f.advance(800);
    f.player.scene();
    CHECK(f.box(INST) == Rect{100, 110, 200, 80});
    f.player.restart();
    CHECK(f.box(INST) == Rect{150, 130, 100, 40});
  }
  SUBCASE("inside auto layout: the parent's alignment places it (centred)") {
    Fixture f(doc(ConstraintType::MIN, ConstraintType::MIN, "INSTANT_TRANSITION", 0, true));
    CHECK(f.box(INST) == Rect{150, 130, 100, 40});
    REQUIRE(f.player.start(kPage, SCREEN));
    f.click(200, 150);
    CHECK(f.box(INST) == Rect{100, 110, 200, 80});
  }
}
