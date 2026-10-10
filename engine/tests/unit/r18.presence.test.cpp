// Round 18 — multiplayer presence (docs/engine.md §9.6): other people's selections outlined in their colour under the
// local selection's chrome, their cursors (an arrow in their colour, a white rim, a name chip) over everything — in the
// editor's overlay only, never in exports or thumbnails; and the camera helpers following needs (screenToWorld,
// centerOn, viewCenter), which honour the viewport's insets.
#include <algorithm>
#include <cmath>
#include <string>

#include "base/Json.h"
#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "gfx/null/NullDevice.h"
#include "render/Renderer.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

using Ptr = uintptr_t;
using Handle = uintptr_t;

extern "C" {
Ptr engine_result_ptr();
uint32_t engine_result_len();
Handle engine_create(const char* selector, Ptr optsPtr, uint32_t optsLen);
void engine_destroy(Handle h);
int32_t engine_load(Handle h, Ptr ptr, uint32_t len);
void engine_set_viewport(Handle h, double cssW, double cssH, double dpr, uint32_t pxW, uint32_t pxH);
void engine_set_viewport_insets(Handle h, double left, double top, double right, double bottom);
void engine_set_camera(Handle h, double x, double y, double zoom);
int32_t engine_take_events(Handle h);
int32_t engine_screen_to_world(Handle h, double x, double y);
void engine_center_on(Handle h, double x, double y, double zoom);
int32_t engine_view_center(Handle h);
int32_t engine_set_presence(Handle h, Ptr ptr, uint32_t len);
}

namespace {

const Guid F{1, 1}, R{1, 2}, T{1, 3};
const double kCos = std::cos(3.14159265358979 / 6), kSin = std::sin(3.14159265358979 / 6);

std::vector<NodeChange> nodes() {
  auto out = baseChanges();
  out.push_back(make(F, NodeType::FRAME, kPage, "!", {0, 0, 200, 200}, "Frame"));
  out.push_back(make(R, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {300, 0, 120, 80}, "Rect"));
  NodeChange t = make(T, NodeType::ROUNDED_RECTANGLE, kPage, "#", {600, 0, 100, 100}, "Turned");
  t.props.transform = Mat2x3{kCos, -kSin, 600, kSin, kCos, 0};
  out.push_back(t);
  return out;
}

const Color kAlice = Color::hex(0xF24822);  // red: white name text
const Color kBob = Color::hex(0xFFCD29);    // yellow: near-black name text

PresencePeer peer(uint32_t id, const char* name, Color c, bool cursor, Vec2 at, std::vector<Guid> sel) {
  PresencePeer p;
  p.id = id;
  p.name = name;
  p.color = c;
  p.hasCursor = cursor;
  p.cursor = at;
  p.selection = std::move(sel);
  return p;
}

// The page origin at (100, 100) on screen, zoom 1.
struct Scene {
  Editor e;
  gfx::NullDevice device;
  Renderer r{device};
  OverlayStyle style = OverlayStyle::of(Theme::Light);
  Scene() {
    e.setSessionID(1);
    e.setViewport(1400, 900, 1, 1400, 900);
    e.loadDocument(nodes(), kNoGuid);
    e.setCamera({100, 100, 1});
    e.takeEvents();
  }
  std::vector<DrawInstance> collect() {
    std::vector<DrawInstance> all;
    for (size_t i = 0; i < device.draws.size(); i++)
      for (const DrawInstance& q : device.instancesOf<DrawInstance>(i)) all.push_back(q);
    return all;
  }
  std::vector<DrawInstance> draw() {
    device.draws.clear();
    r.render(e.document(), e.page(), e.camera(), e.viewport(), e.overlay(), style);
    return collect();
  }
};

bool inColor(const DrawInstance& q, const Color& c) {
  return std::fabs(q.color[0] - c.r) < 0.01 && std::fabs(q.color[1] - c.g) < 0.01 && std::fabs(q.color[2] - c.b) < 0.01;
}
size_t countColor(const std::vector<DrawInstance>& all, const Color& c) {
  return static_cast<size_t>(std::count_if(all.begin(), all.end(), [&](const DrawInstance& q) { return inColor(q, c); }));
}
// The stroked outline boxes `w` × `h` (screen px) in colour `c`, `width` across.
size_t boxes(const std::vector<DrawInstance>& all, const Color& c, double w, double h, double width) {
  return static_cast<size_t>(std::count_if(all.begin(), all.end(), [&](const DrawInstance& q) {
    return inColor(q, c) && std::fabs(q.origin[2] - w) < 0.6 && std::fabs(q.origin[3] - h) < 0.6 && std::fabs(q.geom[0] - width) < 1e-6;
  }));
}

std::string result() { return std::string(reinterpret_cast<const char*>(engine_result_ptr()), engine_result_len()); }
json::Value resultJson() {
  json::Value v;
  REQUIRE(json::parse(result(), v));
  return v;
}

}  // namespace

TEST_CASE("r18 presence: setPresence stores and replaces the set, [] clears; unknown GUIDs are ignored") {
  Scene s;
  CHECK(s.e.overlay().presence.empty());
  s.e.setPresence({peer(7, "Alice", kAlice, true, {50, 60}, {R, Guid{9, 99}}), peer(8, "Bob", kBob, false, {}, {F})});
  CHECK(s.e.needsFrame());
  REQUIRE(s.e.presence().size() == 2);
  Overlay o = s.e.overlay();
  REQUIRE(o.presence.size() == 2);
  CHECK(o.presence[0].name == "Alice");
  CHECK(o.presence[0].hasCursor);
  CHECK(o.presence[0].cursor.x == 50);
  REQUIRE(o.presence[0].selection.size() == 1);  // 9:99 isn't in the document
  CHECK(o.presence[0].selection[0] == R);
  CHECK(o.presence[1].selection == std::vector<Guid>{F});
  // A peer with neither a cursor nor anything on this page draws nothing.
  s.e.setPresence({peer(9, "Carol", kAlice, false, {}, {Guid{9, 99}})});
  CHECK(s.e.overlay().presence.empty());
  // Replaced, then cleared.
  s.e.setPresence({peer(8, "Bob", kBob, true, {0, 0}, {})});
  CHECK(s.e.overlay().presence.size() == 1);
  s.e.setPresence({});
  CHECK(s.e.presence().empty());
  CHECK(s.e.overlay().presence.empty());
  // Presence is chrome: no document change, nothing to undo.
  CHECK(s.e.takeEvents().documents.empty());
  CHECK(!s.e.canUndo());
}

TEST_CASE("r18 presence: a peer's selection outlined 1.5 px in their colour along the hover's rules, under the local chrome") {
  Scene s;
  s.e.setSelection({R});
  s.e.setPresence({peer(7, "Alice", kAlice, false, {}, {F, R, T})});
  auto all = s.draw();
  // The frame and the rectangle: their boxes, 1.5 px, in Alice's red — whatever the zoom.
  CHECK(boxes(all, kAlice, 200, 200, 1.5) == 1);
  CHECK(boxes(all, kAlice, 120, 80, 1.5) == 1);
  // The turned rectangle: a turned box (unit axes along its sides).
  bool turned = false;
  for (const DrawInstance& q : all)
    if (inColor(q, kAlice) && std::fabs(q.origin[2] - 100) < 0.6 && std::fabs(q.geom[0] - 1.5) < 1e-6) turned = true;
  CHECK(turned);
  // Under the local selection's box (same rectangle, the selection colour, 1 px): drawn after Alice's.
  size_t alice = all.size(), local = 0;
  for (size_t i = 0; i < all.size(); i++) {
    if (alice == all.size() && inColor(all[i], kAlice) && std::fabs(all[i].origin[2] - 120) < 0.6) alice = i;
    if (inColor(all[i], s.style.selection) && std::fabs(all[i].origin[2] - 120) < 0.6 && std::fabs(all[i].geom[0] - 1) < 1e-6) local = i;
  }
  REQUIRE(alice < all.size());
  CHECK(local > alice);
  // At 400 % the outline is still 1.5 px across, the box 4× as big.
  s.e.setCamera({0, 0, 4});
  all = s.draw();
  CHECK(boxes(all, kAlice, 800, 800, 1.5) == 1);
}

TEST_CASE("r18 presence: cursors over everything — the arrow in the peer's colour on a white rim, the name chip by it") {
  Scene s;
  s.e.setSelection({R});
  s.e.setPresence({peer(7, "Alice", kAlice, true, {350, 40}, {}), peer(8, "Bob", kBob, true, {10, 10}, {})});
  auto all = s.draw();
  // Alice: her arrow (a path) and her chip — a rounded rect, corners 4, its top left (+12, +18) from the tip (450, 140).
  bool chip = false;
  for (const DrawInstance& q : all)
    if (inColor(q, kAlice) && std::fabs(q.box[0] - s.style.presenceChipRadius) < 1e-6) {
      chip = true;
      CHECK(q.origin[0] == doctest::Approx(450 + s.style.presenceChipX));
      CHECK(q.origin[1] == doctest::Approx(140 + s.style.presenceChipY));
    }
  CHECK(chip);
  CHECK(countColor(all, kAlice) >= 2);
  CHECK(countColor(all, kBob) >= 2);
  // After every local chrome instance (the selection colour): cursors are the overlay's last.
  size_t lastLocal = 0, firstPeer = all.size();
  for (size_t i = 0; i < all.size(); i++) {
    if (inColor(all[i], s.style.selection)) lastLocal = i;
    if (firstPeer == all.size() && (inColor(all[i], kAlice) || inColor(all[i], kBob))) firstPeer = i;
  }
  CHECK(firstPeer > lastLocal);
  // A cursor never hovers or hit-tests: the pointer over Alice's cursor still hovers the rectangle under it.
  s.e.pointer(PointerEvent::MOVE, 452, 142, 0, 0, 0);
  CHECK(s.e.hover() == R);
}

TEST_CASE("r18 presence: never in an export, a thumbnail or a region render (an empty Overlay)") {
  Scene s;
  s.e.setPresence({peer(7, "Alice", kAlice, true, {50, 50}, {F, R})});
  CHECK(countColor(s.draw(), kAlice) > 0);
  // What export / thumbnails / render_region draw: the page with `Overlay none` (ExportApi.inc, Api.cpp).
  s.device.draws.clear();
  Overlay none;
  none.frameTitles = false;
  s.r.render(s.e.document(), s.e.page(), s.e.camera(), s.e.viewport(), none, s.style);
  CHECK(countColor(s.collect(), kAlice) == 0);
}

TEST_CASE("r18 camera: screenToWorld, centerOn and viewCenter round-trip with insets and zoom") {
  Scene s;
  s.e.setViewportInsets(299, 48, 241, 0);
  s.e.setCamera({100, 100, 1});
  Vec2 w = s.e.screenToWorld({300, 250});
  CHECK(w.x == doctest::Approx(200));
  CHECK(w.y == doctest::Approx(150));
  s.e.takeEvents();
  s.e.centerOn({500, -40}, 2.5);
  CHECK(s.e.takeEvents().camera);
  CHECK(s.e.camera().zoom == doctest::Approx(2.5));
  // The point is at the visible part's centre (between the panels), not the canvas's.
  Vec2 centre{299 + (1400 - 299 - 241) / 2.0, 48 + (900 - 48) / 2.0};
  Vec2 on = s.e.camera().toScreen({500, -40});
  CHECK(on.x == doctest::Approx(centre.x));
  CHECK(on.y == doctest::Approx(centre.y));
  Camera c = s.e.viewCenter();
  CHECK(c.x == doctest::Approx(500));
  CHECK(c.y == doctest::Approx(-40));
  CHECK(c.zoom == doctest::Approx(2.5));
  Vec2 back = s.e.screenToWorld(centre);
  CHECK(back.x == doctest::Approx(500));
  CHECK(back.y == doctest::Approx(-40));
  // The zoom clamps; the same place again changes nothing (no event).
  s.e.centerOn({500, -40}, 1000);
  CHECK(s.e.camera().zoom == doctest::Approx(kMaxZoom));
  s.e.takeEvents();
  s.e.centerOn({500, -40}, kMaxZoom);
  CHECK(!s.e.takeEvents().camera);
  // viewCenter → centerOn elsewhere → centerOn back: the same camera.
  s.e.setCamera({-37, 12, 0.75});
  Camera saved = s.e.viewCenter();
  s.e.centerOn({0, 0}, 3);
  s.e.centerOn({saved.x, saved.y}, saved.zoom);
  CHECK(s.e.camera().x == doctest::Approx(-37));
  CHECK(s.e.camera().y == doctest::Approx(12));
  CHECK(s.e.camera().zoom == doctest::Approx(0.75));
}

TEST_CASE("r18 presence and camera through the C ABI") {
  Handle h = engine_create(nullptr, 0, 0);
  REQUIRE(h != 0);
  std::string doc = codec::writeMessage(0, nodes());
  REQUIRE(engine_load(h, reinterpret_cast<Ptr>(doc.data()), static_cast<uint32_t>(doc.size())) == 0);
  engine_set_viewport(h, 1000, 800, 2, 2000, 1600);
  engine_set_viewport_insets(h, 200, 0, 200, 0);
  engine_set_camera(h, 100, 100, 2);
  engine_take_events(h);

  REQUIRE(engine_screen_to_world(h, 300, 500) == 0);
  json::Value v = resultJson();
  CHECK(v.get("x")->number == doctest::Approx(100));
  CHECK(v.get("y")->number == doctest::Approx(200));

  engine_center_on(h, 50, 75, 0.5);
  REQUIRE(engine_view_center(h) == 0);
  v = resultJson();
  CHECK(v.get("x")->number == doctest::Approx(50));
  CHECK(v.get("y")->number == doctest::Approx(75));
  CHECK(v.get("zoom")->number == doctest::Approx(0.5));
  REQUIRE(engine_screen_to_world(h, 500, 400) == 0);  // the visible part's centre (insets 200 / 200)
  v = resultJson();
  CHECK(v.get("x")->number == doctest::Approx(50));
  CHECK(v.get("y")->number == doctest::Approx(75));

  std::string peers = R"([{"id":7,"name":"Alice","color":"#f24822","cursor":{"x":10,"y":20},"selection":["1:2","9:99","nonsense"]},
                          {"id":8,"name":"Bob","color":"#FFCD29","cursor":null,"selection":[]}])";
  CHECK(engine_set_presence(h, reinterpret_cast<Ptr>(peers.data()), static_cast<uint32_t>(peers.size())) == 0);
  std::string bad = "{\"peers\": 3}";
  CHECK(engine_set_presence(h, reinterpret_cast<Ptr>(bad.data()), static_cast<uint32_t>(bad.size())) != 0);
  std::string none = "[]";
  CHECK(engine_set_presence(h, reinterpret_cast<Ptr>(none.data()), static_cast<uint32_t>(none.size())) == 0);
  engine_destroy(h);
}
