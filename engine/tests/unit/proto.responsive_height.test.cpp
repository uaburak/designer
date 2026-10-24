// Responsive as a web page's viewport (Wecra, 2026-10-21; docs/engine.md §3.4): without a device the shown frame takes
// the window's width as before, and its height by the web rule — a frame that scrolls inside itself (overflow Vertical
// or Both: the app shell) is `height: 100vh`, any other `min-height: 100vh`. And the overlay "Fit to window" setting
// (NodeChange.overlayFitWindow, @ours): a drawer taller than the window takes its height, a sheet its width, or both.
#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "proto/Player.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid SCREEN{1, 1}, SIDEBAR{1, 2}, CONTENT{1, 3}, NAV{1, 4}, STICKY{1, 5}, FOOTER{1, 6}, OPEN{1, 7}, DRAWER{2, 1}, MENU{2, 2},
    DRAWER_FOOT{2, 3};

std::string extra(const char* key, const std::string& text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  std::string bytes = codec::extraFromJson("NodeChange", key, v);
  REQUIRE(!bytes.empty());
  return bytes;
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
    player.setScale(proto::ScaleMode::RESPONSIVE);
  }
  const NodeProps& at(Guid id) { return ed.document().get(id)->props; }
  void click(double x, double y) {
    player.pointer(PointerEvent::MOVE, x, y, 0, 0);
    player.pointer(PointerEvent::DOWN, x, y, 1, 0);
    player.pointer(PointerEvent::UP, x, y, 0, 0);
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
  double drawnTop(Guid id) {
    player.scene();
    double y = 0;
    for (Guid cur = id; cur != SCREEN; cur = ed.document().parentOf(cur)) {
      const NodeProps* p = player.drawnProps(cur);
      if (!p) p = &ed.document().get(cur)->props;
      y += p->transform.m12;
    }
    const PresentItem* root = itemOf(SCREEN);
    REQUIRE(root);
    return y + root->parentCss.m12;
  }
};

// The app shell: a 1440 × h frame (overflow Vertical) with a sidebar pinned Top & Bottom the frame's height, the main
// content (2000 tall) beside it, a Fixed header and a Sticky title.
std::vector<NodeChange> appShell(double h, const char* overflow = "VERTICAL") {
  auto nodes = baseChanges();
  NodeChange s = make(SCREEN, NodeType::FRAME, kPage, "!", {0, 0, 1440, h}, "01 Home");
  if (overflow) s.props.extra["scrollDirection"] = extra("scrollDirection", std::string("\"") + overflow + "\"");
  nodes.push_back(s);
  NodeChange side = make(SIDEBAR, NodeType::FRAME, SCREEN, "!", {0, 0, 240, h}, "Sidebar");
  side.props.verticalConstraint = ConstraintType::STRETCH;
  nodes.push_back(side);
  nodes.push_back(make(CONTENT, NodeType::FRAME, SCREEN, "\"", {240, 0, 1200, 2000}, "Content"));
  NodeChange st = make(STICKY, NodeType::RECTANGLE, SCREEN, "#", {240, 300, 1200, 60}, "Sticky title");
  st.props.extra["scrollBehavior"] = extra("scrollBehavior", R"("STICKY_SCROLLS")");
  nodes.push_back(st);
  NodeChange nav = make(NAV, NodeType::FRAME, SCREEN, "$", {240, 0, 1200, 60}, "Header");
  nav.props.extra["scrollBehavior"] = extra("scrollBehavior", R"("FIXED_WHEN_CHILD_OF_SCROLLING_FRAME")");
  nodes.push_back(nav);
  return nodes;
}

}  // namespace

TEST_CASE("proto.responsive_height: an app shell (overflow Vertical) takes the window's height; its sidebar follows, the rest scrolls inside") {
  for (double h : {1024.0, 1280.0}) {
    CAPTURE(h);
    Fixture f(appShell(h));
    REQUIRE(f.player.start(kPage, SCREEN));
    f.player.scene();
    CHECK(f.at(SCREEN).size.x == doctest::Approx(1200));
    CHECK(f.at(SCREEN).size.y == doctest::Approx(900));
    CHECK(f.at(SIDEBAR).size.y == doctest::Approx(900));
    CHECK(f.player.screenSize().y == doctest::Approx(900));
    // The content past the window scrolls inside the frame: 2000 − 900.
    f.player.wheel(700, 500, 0, 5000);
    CHECK(f.player.scrollOf(SCREEN).y == doctest::Approx(1100));
    const PresentItem* root = f.itemOf(SCREEN);
    REQUIRE(root);
    CHECK(root->parentCss.m12 == doctest::Approx(0));  // the frame stays; its layers move
    CHECK(f.drawnTop(CONTENT) == doctest::Approx(-1100));
    const PresentItem* nav = f.itemOf(NAV);
    REQUIRE(nav);
    CHECK(nav->parentCss.m12 == doctest::Approx(0));       // Fixed
    CHECK(f.drawnTop(STICKY) == doctest::Approx(0));       // Sticky pinned
    // Live window resize: laid out again.
    f.resize(1000, 700);
    CHECK(f.at(SCREEN).size.x == doctest::Approx(1000));
    CHECK(f.at(SCREEN).size.y == doctest::Approx(700));
    CHECK(f.at(SIDEBAR).size.y == doctest::Approx(700));
    // Off Responsive and at the end everything is as it was.
    f.player.setScale(proto::ScaleMode::ACTUAL);
    f.player.scene();
    CHECK(f.at(SCREEN).size.y == doctest::Approx(h));
    CHECK(f.at(SIDEBAR).size.y == doctest::Approx(h));
    f.player.setScale(proto::ScaleMode::RESPONSIVE);
    f.player.scene();
    CHECK(f.at(SCREEN).size.y == doctest::Approx(700));
    f.player.stop();
    CHECK(f.at(SCREEN).size.x == doctest::Approx(1440));
    CHECK(f.at(SCREEN).size.y == doctest::Approx(h));
  }
}

TEST_CASE("proto.responsive_height: a page with No scrolling is min-height 100vh") {
  SUBCASE("a short page fills the window; a Bottom-constrained footer goes to the bottom") {
    auto nodes = baseChanges();
    nodes.push_back(make(SCREEN, NodeType::FRAME, kPage, "!", {0, 0, 1440, 600}, "Short"));
    NodeChange foot = make(FOOTER, NodeType::RECTANGLE, SCREEN, "!", {0, 520, 1440, 80}, "Footer");
    foot.props.verticalConstraint = ConstraintType::MAX;
    nodes.push_back(foot);
    Fixture f(nodes);
    REQUIRE(f.player.start(kPage, SCREEN));
    f.player.scene();
    CHECK(f.at(SCREEN).size.x == doctest::Approx(1200));
    CHECK(f.at(SCREEN).size.y == doctest::Approx(900));
    CHECK(f.at(FOOTER).transform.m12 == doctest::Approx(820));
    f.player.wheel(700, 500, 0, 500);
    CHECK(f.player.scrollOf(SCREEN).y == doctest::Approx(0));
  }
  SUBCASE("a long page keeps its height and scrolls as a whole") {
    auto nodes = baseChanges();
    nodes.push_back(make(SCREEN, NodeType::FRAME, kPage, "!", {0, 0, 1440, 3000}, "Long"));
    Fixture f(nodes);
    REQUIRE(f.player.start(kPage, SCREEN));
    f.player.scene();
    CHECK(f.at(SCREEN).size.x == doctest::Approx(1200));
    CHECK(f.at(SCREEN).size.y == doctest::Approx(3000));
    f.player.wheel(700, 500, 0, 5000);
    CHECK(f.player.scrollOf(SCREEN).y == doctest::Approx(2100));
    const PresentItem* root = f.itemOf(SCREEN);
    REQUIRE(root);
    CHECK(root->parentCss.m12 == doctest::Approx(-2100));  // the frame itself moves
  }
  SUBCASE("the 1440 × 1024 frame without overflow keeps its height (as Figma)") {
    Fixture f(appShell(1024, nullptr));
    REQUIRE(f.player.start(kPage, SCREEN));
    f.player.scene();
    CHECK(f.at(SCREEN).size.y == doctest::Approx(1024));
    CHECK(f.at(SIDEBAR).size.y == doctest::Approx(1024));
  }
}

TEST_CASE("proto.responsive_height: an auto-layout shell's Fill-height sidebar takes the window's height") {
  auto nodes = baseChanges();
  NodeChange s = make(SCREEN, NodeType::FRAME, kPage, "!", {0, 0, 1440, 1024}, "Shell");
  s.props.stack().stackMode = StackMode::HORIZONTAL;
  s.props.stack().stackPrimarySizing = StackSize::FIXED;
  s.props.stack().stackCounterSizing = StackSize::FIXED;
  s.props.extra["scrollDirection"] = extra("scrollDirection", R"("VERTICAL")");
  nodes.push_back(s);
  NodeChange side = make(SIDEBAR, NodeType::FRAME, SCREEN, "!", {0, 0, 240, 1024}, "Sidebar");
  side.props.stackChildAlignSelf = StackCounterAlign::STRETCH;
  nodes.push_back(side);
  nodes.push_back(make(CONTENT, NodeType::FRAME, SCREEN, "\"", {240, 0, 960, 2000}, "Content"));
  Fixture f(nodes);
  REQUIRE(f.player.start(kPage, SCREEN));
  f.player.scene();
  CHECK(f.at(SCREEN).size.y == doctest::Approx(900));
  CHECK(f.at(SIDEBAR).size.y == doctest::Approx(900));
  f.player.wheel(700, 500, 0, 5000);
  CHECK(f.player.scrollOf(SCREEN).y == doctest::Approx(1100));
}

TEST_CASE("proto.responsive_height: with a device Responsive keeps Figma's rule (a taller frame keeps its height)") {
  auto nodes = appShell(1024);
  for (auto& n : nodes)
    if (n.guid == kPage) n.props.extra["prototypeDevice"] = extra("prototypeDevice", R"({"type":"CUSTOM","size":{"x":800,"y":600}})");
  Fixture f(nodes);
  f.player.setResponsive(true);
  REQUIRE(f.player.start(kPage, SCREEN));
  f.player.scene();
  CHECK(f.at(SCREEN).size.x == doctest::Approx(800));
  CHECK(f.at(SCREEN).size.y == doctest::Approx(1024));
}

namespace {

// A 1200 × 900 screen whose button opens a 360 × 1280 drawer (overflow Vertical; a menu 1280 tall pinned Top, a foot
// pinned Bottom) at `position`, with Fit to window `fit` (nullptr: absent).
std::vector<NodeChange> drawerDoc(const char* fit, const char* position = "TOP_LEFT", const char* offset = nullptr) {
  auto nodes = baseChanges();
  nodes.push_back(make(SCREEN, NodeType::FRAME, kPage, "!", {0, 0, 1200, 900}, "Screen"));
  NodeChange open = make(OPEN, NodeType::RECTANGLE, SCREEN, "!", {20, 20, 100, 40}, "Menu button");
  std::string action = std::string(R"({"connectionType":"INTERNAL_NODE","navigationType":"OVERLAY","transitionNodeID":")") + DRAWER.toString() +
                       R"(","transitionType":"INSTANT_TRANSITION")";
  if (offset) action += std::string(R"(,"overlayRelativePosition":)") + offset;
  open.props.extra["prototypeInteractions"] = extra("prototypeInteractions", R"([{"event":{"interactionType":"ON_CLICK"},"actions":[)" + action + "}]}]");
  nodes.push_back(open);
  NodeChange d = make(DRAWER, NodeType::FRAME, kPage, "\"", {2000, 0, 360, 1280}, "Drawer");
  d.props.extra["overlayPositionType"] = extra("overlayPositionType", std::string("\"") + position + "\"");
  d.props.extra["scrollDirection"] = extra("scrollDirection", R"("VERTICAL")");
  if (fit) d.props.extra["overlayFitWindow"] = extra("overlayFitWindow", std::string("\"") + fit + "\"");
  nodes.push_back(d);
  nodes.push_back(make(MENU, NodeType::FRAME, DRAWER, "!", {0, 0, 360, 1200}, "Menu"));
  NodeChange foot = make(DRAWER_FOOT, NodeType::RECTANGLE, DRAWER, "\"", {0, 1200, 360, 80}, "Foot");
  foot.props.verticalConstraint = ConstraintType::MAX;
  nodes.push_back(foot);
  return nodes;
}

}  // namespace

TEST_CASE("proto.responsive_height: overlay Fit to window") {
  SUBCASE("None (the default): the drawer keeps its size") {
    Fixture f(drawerDoc(nullptr));
    f.player.setScale(proto::ScaleMode::ACTUAL);
    REQUIRE(f.player.start(kPage, SCREEN));
    f.click(50, 40);
    f.player.scene();
    REQUIRE(f.player.overlays().size() == 1);
    CHECK(f.at(DRAWER).size.y == doctest::Approx(1280));
  }
  SUBCASE("Height: the drawer takes the window's height; its foot follows, the menu scrolls inside; live resize; restored") {
    Fixture f(drawerDoc("HEIGHT"));
    f.player.setScale(proto::ScaleMode::ACTUAL);
    REQUIRE(f.player.start(kPage, SCREEN));
    f.click(50, 40);
    f.player.scene();
    REQUIRE(f.player.overlays().size() == 1);
    CHECK(f.at(DRAWER).size.x == doctest::Approx(360));
    CHECK(f.at(DRAWER).size.y == doctest::Approx(900));
    CHECK(f.at(DRAWER_FOOT).transform.m12 == doctest::Approx(820));
    CHECK(f.player.overlays()[0].pos.x == doctest::Approx(0));
    CHECK(f.player.overlays()[0].pos.y == doctest::Approx(0));
    // The menu (1200) runs past the drawer (900): it scrolls inside (overflow Vertical).
    f.player.wheel(100, 400, 0, 5000);
    CHECK(f.player.scrollOf(DRAWER).y == doctest::Approx(300));
    // The window shrinks (Actual size: the screen is the frame cut to the window).
    f.resize(1200, 700);
    CHECK(f.at(DRAWER).size.y == doctest::Approx(700));
    f.player.stop();
    CHECK(f.at(DRAWER).size.y == doctest::Approx(1280));
    CHECK(f.at(DRAWER_FOOT).transform.m12 == doctest::Approx(1200));
  }
  SUBCASE("Height, right-hand drawer under Responsive") {
    Fixture f(drawerDoc("HEIGHT", "TOP_RIGHT"));
    REQUIRE(f.player.start(kPage, SCREEN));
    f.click(50, 40);
    f.player.scene();
    REQUIRE(f.player.overlays().size() == 1);
    CHECK(f.at(DRAWER).size.y == doctest::Approx(900));
    CHECK(f.player.overlays()[0].pos.x == doctest::Approx(1200 - 360));
    CHECK(f.player.overlays()[0].pos.y == doctest::Approx(0));
    f.resize(1000, 800);
    CHECK(f.at(DRAWER).size.y == doctest::Approx(800));
    CHECK(f.player.overlays()[0].pos.x == doctest::Approx(1000 - 360));
  }
  SUBCASE("Both: the overlay covers the window") {
    Fixture f(drawerDoc("BOTH", "CENTER"));
    f.player.setScale(proto::ScaleMode::ACTUAL);
    REQUIRE(f.player.start(kPage, SCREEN));
    f.click(50, 40);
    f.player.scene();
    REQUIRE(f.player.overlays().size() == 1);
    CHECK(f.at(DRAWER).size.x == doctest::Approx(1200));
    CHECK(f.at(DRAWER).size.y == doctest::Approx(900));
    CHECK(f.at(MENU).size.x == doctest::Approx(360));  // Left constraint: keeps its width
    CHECK(f.player.overlays()[0].pos.x == doctest::Approx(0));
    CHECK(f.player.overlays()[0].pos.y == doctest::Approx(0));
  }
  SUBCASE("Height with a manual position: the horizontal offset is kept, the drawer starts at the top") {
    Fixture f(drawerDoc("HEIGHT", "MANUAL", R"({"x":100,"y":50})"));
    f.player.setScale(proto::ScaleMode::ACTUAL);
    REQUIRE(f.player.start(kPage, SCREEN));
    f.click(50, 40);
    f.player.scene();
    REQUIRE(f.player.overlays().size() == 1);
    CHECK(f.at(DRAWER).size.y == doctest::Approx(900));
    CHECK(f.player.overlays()[0].pos.x == doctest::Approx(20 + 100));
    CHECK(f.player.overlays()[0].pos.y == doctest::Approx(0));
  }
}

TEST_CASE("proto.responsive: an auto layout screen's Fill child grows with the window and its centred layers stay centred") {
  // The owner's "Figma screen": a horizontal auto layout 1440 × 767 — Left panel 289, Canvas (Fill, no layout) with a
  // row of shapes pinned Center / Center, Right panel 260. Presented Responsive in a 1840 window the shapes stayed
  // where they were (left of the middle) in the app — not reproduced here: the engine lays it out right.
  const Guid LEFT{3, 1}, CANVAS{3, 2}, RIGHT{3, 3}, SHAPES{3, 4};
  auto nodes = baseChanges();
  NodeChange s = make(SCREEN, NodeType::FRAME, kPage, "!", {0, 0, 1440, 767}, "Figma screen");
  s.props.stack().stackMode = StackMode::HORIZONTAL;
  s.props.stack().stackPrimarySizing = StackSize::FIXED;
  s.props.stack().stackCounterSizing = StackSize::FIXED;
  nodes.push_back(s);
  nodes.push_back(make(LEFT, NodeType::FRAME, SCREEN, "!", {0, 0, 289, 767}, "Left panel"));
  NodeChange c = make(CANVAS, NodeType::FRAME, SCREEN, "\"", {289, 0, 891, 767}, "Canvas");
  c.props.stackChildPrimaryGrow = 1;
  c.props.extra["scrollDirection"] = extra("scrollDirection", "\"BOTH\"");  // the owner's Canvas scrolls both ways
  nodes.push_back(c);
  nodes.push_back(make(RIGHT, NodeType::FRAME, SCREEN, "#", {1180, 0, 260, 767}, "Right panel"));
  NodeChange sh = make(SHAPES, NodeType::FRAME, CANVAS, "!", {77.5, 253.5, 736, 260}, "Content");
  sh.props.horizontalConstraint = ConstraintType::CENTER;
  sh.props.verticalConstraint = ConstraintType::CENTER;
  sh.props.stack().stackMode = StackMode::HORIZONTAL;  // a hugging row of shapes, as the owner's
  sh.props.stack().stackSpacing = 48;
  sh.props.stack().stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  sh.props.stack().stackCounterSizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  nodes.push_back(sh);
  nodes.push_back(make(Guid{3, 5}, NodeType::FRAME, SHAPES, "!", {0, 0, 320, 260}, "Frame 1"));
  nodes.push_back(make(Guid{3, 6}, NodeType::ELLIPSE, SHAPES, "\"", {368, 50, 160, 160}, "Ellipse 1"));
  nodes.push_back(make(Guid{3, 7}, NodeType::RECTANGLE, SHAPES, "#", {576, 50, 160, 160}, "Rectangle 1"));
  Fixture f(nodes, 1840, 1000);
  REQUIRE(f.player.start(kPage, SCREEN));
  f.player.scene();
  CHECK(f.at(SCREEN).size.x == doctest::Approx(1840));
  CHECK(f.at(CANVAS).size.x == doctest::Approx(1291));
  CHECK(f.at(RIGHT).transform.m02 == doctest::Approx(1580));
  CHECK(f.at(SHAPES).transform.m02 == doctest::Approx((1291 - 736) / 2.0));
}
