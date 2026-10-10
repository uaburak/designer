// Round 16, canvas navigation (the owner's live Figma 58–67.png): the canvas scrollbars (extent = the page's content
// ∪ the view; shown while the view moves or the pointer is on a bar, fading after; a thumb drags, the track pages),
// the camera gliding to a Layers row's layer (ZOOM_TO_SELECTION {animate}), and prototype connection nubs on the side
// nearest the pointer with connections leaving / arriving at any side's middle.
#include <cmath>

#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"
#include "proto/Prototype.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid F{1, 1}, R{1, 2};

// A frame in view and a rectangle far to its right (past a 1440 × 900 view at 100 %).
Editor makeEditor() {
  auto nodes = baseChanges();
  nodes.push_back(make(F, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "Frame"));
  nodes.push_back(make(R, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {1600, 1200, 100, 100}, "Rectangle"));
  Editor e;
  e.setSessionID(1);
  e.setViewport(1440, 900, 1, 1440, 900);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({100, 100, 1});
  e.takeEvents();
  return e;
}

CommandArgs argsOf(const char* text) {
  CommandArgs a;
  REQUIRE(json::parse(text, a.raw));
  return a;
}

}  // namespace

TEST_CASE("scrollbars: the extent is the content united with the view; thumb ∶ track = view ∶ extent") {
  const double T = Scrollbars::kThickness, I = Scrollbars::kInset;
  // Content past the view's left and top (58.png's case): both bars, each thumb at its track's end.
  Scrollbars s = scrollbarGeometry({0, 0, 1000, 600}, {-100, -50, 400, 300}, true);
  REQUIRE(s.h.show);
  REQUIRE(s.v.show);
  CHECK(s.h.extentStart == doctest::Approx(-100));
  CHECK(s.h.extentLength == doctest::Approx(1100));
  double trackH = 1000 - I - (I + T);
  CHECK(s.h.track.w == doctest::Approx(trackH));
  CHECK(s.h.thumb.w == doctest::Approx(trackH * 1000 / 1100));
  CHECK(s.h.thumb.right() == doctest::Approx(s.h.track.right()));  // the view is the extent's end
  CHECK(s.h.track.y == doctest::Approx(600 - I - T));               // along the bottom, 2 px in
  CHECK(s.v.track.x == doctest::Approx(1000 - I - T));              // along the right
  CHECK(s.v.thumb.h == doctest::Approx((600 - I - (I + T)) * 600 / 650));
  // Content past the right and bottom (59.png): the thumbs at their tracks' starts.
  s = scrollbarGeometry({0, 0, 1000, 600}, {900, 500, 300, 300}, true);
  CHECK(s.h.thumb.x == doctest::Approx(I));
  CHECK(s.v.thumb.y == doctest::Approx(I));
  // Content past one axis only (61.png): one bar. Content inside the view (63.png), or none: no bars.
  s = scrollbarGeometry({0, 0, 1000, 600}, {-40, 100, 400, 300}, true);
  CHECK(s.h.show);
  CHECK(!s.v.show);
  CHECK(!scrollbarGeometry({0, 0, 1000, 600}, {10, 10, 400, 300}, true).h.show);
  CHECK(!scrollbarGeometry({0, 0, 1000, 600}, {-500, -500, 4000, 4000}, false).v.show);
  // Inside the panels' insets: the bars sit in the visible part.
  s = scrollbarGeometry({300, 0, 900, 600}, {-100, 0, 400, 300}, true);
  CHECK(s.h.track.x == doctest::Approx(300 + I));
  CHECK(s.v.show == false);
  // Dragging: the view moves (extent − view) ∶ (track − thumb) per thumb px.
  s = scrollbarGeometry({0, 0, 1000, 600}, {-1000, 0, 400, 300}, true);
  CHECK(s.h.panPerThumbPx() == doctest::Approx((2000 - 1000) / (s.h.track.w - s.h.thumb.w)));
}

TEST_CASE("scrollbars: shown while the view moves, then fading out; hidden when nothing passes the view") {
  Editor e = makeEditor();
  e.tick(0);
  CHECK(e.overlay().scrollbars.alpha == 0);  // a view set from outside doesn't flash them
  e.wheel(700, 400, 0, 20, DeltaMode::PIXEL, 0, 0);  // a pan
  e.tick(1000);
  Overlay o = e.overlay();
  CHECK(o.scrollbars.alpha == 1);
  CHECK(o.scrollbars.bars.h.show);  // the rectangle is past the view's right…
  CHECK(o.scrollbars.bars.v.show);  // …and bottom
  CHECK(e.chromeDelay() == 1000);   // shown for a second
  e.tick(2000);
  CHECK(e.overlay().scrollbars.alpha == 1);
  e.tick(2150);
  CHECK(e.overlay().scrollbars.alpha == doctest::Approx(0.5));
  CHECK(e.chromeDelay() == 16);  // fading: frame by frame
  e.tick(2300);
  CHECK(e.overlay().scrollbars.alpha == 0);
  CHECK(e.chromeDelay() == -1);
}

TEST_CASE("scrollbars: content added after the pointer moved, panels over the canvas (the app's order)") {
  Editor e;
  e.setSessionID(1);
  e.setViewport(1440, 900, 1, 1440, 900);
  e.loadDocument(baseChanges(), kNoGuid);
  e.setViewportInsets(298, 0, 241, 0);
  e.tick(16);
  e.pointer(PointerEvent::MOVE, 600, 200, 0, 0, 0);
  e.tick(32);
  e.applyChanges({make(F, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "Frame"),
                  make(R, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {3000, 2400, 200, 200}, "Far")},
                 APPLY_USER);
  e.setCamera({418, 120, 1});
  e.tick(48);
  e.pointer(PointerEvent::MOVE, 600, 200, 0, 0, 0);
  e.wheel(600, 200, 0, 30, DeltaMode::PIXEL, 0, 0);
  e.tick(64);
  Overlay o = e.overlay();
  CHECK(o.scrollbars.alpha == 1);
  CHECK(o.scrollbars.bars.h.show);
  CHECK(o.scrollbars.bars.v.show);
  CHECK(o.scrollbars.bars.v.track.x == doctest::Approx(1440 - 241 - 6 - Scrollbars::kInset - Scrollbars::kThickness));
}

TEST_CASE("scrollbars: the pointer on a bar shows it; its thumb drags the view, its track pages it") {
  Editor e = makeEditor();
  e.tick(0);
  Scrollbars b = e.scrollbars();
  REQUIRE(b.h.show);
  // Hovered: shown (and kept) — nothing under it hovered.
  Vec2 onThumb{b.h.thumb.x + b.h.thumb.w / 2, b.h.thumb.y + b.h.thumb.h / 2};
  e.pointer(PointerEvent::MOVE, onThumb.x, onThumb.y, 0, 0, 0);
  e.tick(100);
  e.tick(5000);
  Overlay o = e.overlay();
  CHECK(o.scrollbars.alpha == 1);
  CHECK(o.scrollbars.hotH);
  // The thumb dragged 10 px right: the view goes right by 10 × (extent − view) ∶ (track − thumb).
  double ratio = b.h.panPerThumbPx();
  Camera before = e.camera();
  CHECK(e.pointer(PointerEvent::DOWN, onThumb.x, onThumb.y, 0, 1, 0) == (P_HANDLED | P_CAPTURE));
  e.pointer(PointerEvent::MOVE, onThumb.x + 10, onThumb.y, 0, 1, 0);
  CHECK(e.camera().x == doctest::Approx(before.x - std::round(10 * ratio)));
  CHECK(e.camera().y == before.y);
  e.pointer(PointerEvent::UP, onThumb.x + 10, onThumb.y, 0, 0, 0);
  CHECK(e.selection().empty());  // nothing selected or moved under the bar
  // A press on the vertical track past its thumb: a page (the view's height) down.
  b = e.scrollbars();
  REQUIRE(b.v.show);
  double below = b.v.thumb.bottom() + 4;
  REQUIRE(below < b.v.track.bottom());
  before = e.camera();
  e.pointer(PointerEvent::DOWN, b.v.track.x + 3, below, 0, 1, 0);
  e.pointer(PointerEvent::UP, b.v.track.x + 3, below, 0, 0, 0);
  CHECK(e.camera().y == doctest::Approx(before.y - 900));
  // Off the bars and the canvas: they fade.
  e.pointer(PointerEvent::LEAVE, -1, -1, 0, 0, 0);
  e.tick(10000);
  e.tick(20000);
  CHECK(e.overlay().scrollbars.alpha == 0);
}

TEST_CASE("camera: ZOOM_TO_SELECTION {animate} glides there in 300 ms; a wheel stops it") {
  Editor e = makeEditor();
  REQUIRE(e.setSelection({R}) == OK);
  Camera start = e.camera();
  // Where ⇧2 would land, instantly.
  e.command(CommandId::ZOOM_TO_SELECTION);
  Camera target = e.camera();
  e.setCamera(start);
  REQUIRE(e.command(CommandId::ZOOM_TO_SELECTION, argsOf(R"({"animate":300})")) == OK);
  CHECK(e.cameraAnimating());
  CHECK(e.needsFrame());
  CHECK(e.camera().x == start.x);  // nothing moves before the first frame
  e.tick(1000);                     // the first frame: t = 0
  CHECK(e.camera().zoom == doctest::Approx(start.zoom));
  e.tick(1150);
  double mid = e.camera().zoom;
  CHECK(mid > std::min(start.zoom, target.zoom));
  CHECK(mid < std::max(start.zoom, target.zoom));
  // Half-way in time: the zoom half-way geometrically (ease in-out is ½ at ½).
  CHECK(mid == doctest::Approx(start.zoom * std::sqrt(target.zoom / start.zoom)));
  e.tick(1300);
  CHECK(!e.cameraAnimating());
  CHECK(e.camera().x == doctest::Approx(target.x));
  CHECK(e.camera().y == doctest::Approx(target.y));
  CHECK(e.camera().zoom == doctest::Approx(target.zoom));
  // Again from the start, stopped by a wheel half-way.
  e.setCamera(start);
  e.command(CommandId::ZOOM_TO_SELECTION, argsOf(R"({"animate":true})"));
  e.tick(2000);
  e.tick(2100);
  e.wheel(700, 400, 0, 5, DeltaMode::PIXEL, 0, 0);
  CHECK(!e.cameraAnimating());
  Camera stopped = e.camera();
  e.tick(2400);
  CHECK(e.camera().x == stopped.x);
  CHECK(e.camera().zoom == stopped.zoom);
}

TEST_CASE("camera: a glide that is a zoom about a point keeps that point still") {
  Editor e = makeEditor();
  e.setCamera({0, 0, 1});
  Vec2 c{720, 450};  // the visible centre (no insets)
  Camera to = e.camera().zoomedAround(4, c);
  e.animateCamera(to, 300);
  e.tick(0);
  e.tick(90);
  Vec2 w = e.camera().toWorld(c);
  CHECK(w.x == doctest::Approx(c.x).epsilon(1e-6));
  CHECK(w.y == doctest::Approx(c.y).epsilon(1e-6));
}

TEST_CASE("noodles: Figma's sides (61–63.png) — across when apart across, else up / down; arrive facing the hotspot") {
  // 61.png's frames (screen px): 1 and 2 on top, 4 and 3 in the middle, 6 and 5 at the bottom.
  const Rect f1{749, 229, 300, 254}, f2{1223, 229, 300, 254}, f4{749, 583, 300, 254}, f3{1223, 583, 300, 254}, f5{749, 936, 300, 254},
      f6{411, 936, 260, 254};
  NoodleCurve n = prototypeNoodle(f4, f2, false, {});
  CHECK(n.start == NoodleSide::RIGHT);
  CHECK(n.end == NoodleSide::BOTTOM);
  CHECK(n.a.x == doctest::Approx(1049));
  CHECK(n.a.y == doctest::Approx(710));
  CHECK(n.b.x == doctest::Approx(1373));
  CHECK(n.b.y == doctest::Approx(483));
  CHECK(n.dir.y == doctest::Approx(-1));  // the arrow points up into 2's bottom
  n = prototypeNoodle(f3, f1, false, {});
  CHECK(n.start == NoodleSide::LEFT);
  CHECK(n.end == NoodleSide::BOTTOM);
  n = prototypeNoodle(f5, f1, false, {});  // straight up
  CHECK(n.start == NoodleSide::TOP);
  CHECK(n.end == NoodleSide::BOTTOM);
  CHECK(n.a.x == doctest::Approx(n.b.x));
  n = prototypeNoodle(f2, f1, false, {});  // level: left into 1's right
  CHECK(n.start == NoodleSide::LEFT);
  CHECK(n.end == NoodleSide::RIGHT);
  n = prototypeNoodle(f6, f3, false, {});
  CHECK(n.start == NoodleSide::RIGHT);
  CHECK(n.end == NoodleSide::BOTTOM);
  // Each control point half the distance along its side's normal (fitted: 6 → 3 at 0.47 / 0.58).
  CHECK(n.c1.x - n.a.x == doctest::Approx((n.b.x - n.a.x) / 2));
  CHECK(n.c2.y - n.b.y == doctest::Approx((n.a.y - n.b.y) / 2));
  // A connection dragged from a nub leaves its side, perpendicular.
  n = prototypeNoodle(f5, f1, true, {500, 100}, static_cast<int>(NoodleSide::BOTTOM));
  CHECK(n.start == NoodleSide::BOTTOM);
  CHECK(n.a.y == doctest::Approx(f5.bottom()));
  CHECK(n.c1.x == doctest::Approx(n.a.x));
  CHECK(n.c1.y > n.a.y);
}

TEST_CASE("noodles: the nearest side of a box") {
  Rect r{0, 0, 400, 300};
  CHECK(nearestSide(r, {200, -50}) == NoodleSide::TOP);
  CHECK(nearestSide(r, {200, 20}) == NoodleSide::TOP);
  CHECK(nearestSide(r, {390, 150}) == NoodleSide::RIGHT);
  CHECK(nearestSide(r, {200, 290}) == NoodleSide::BOTTOM);
  CHECK(nearestSide(r, {-80, 150}) == NoodleSide::LEFT);
  CHECK(nearestSide(r, {200, 150}) == NoodleSide::BOTTOM);  // the middle: a tie between the long sides goes down
  CHECK(nearestSide(r, {500, 400}) == NoodleSide::RIGHT); // a corner's tie goes right
  Vec2 c = sideCentre(r, NoodleSide::LEFT);
  CHECK(c.x == 0);
  CHECK(c.y == 150);
}

TEST_CASE("prototype nubs: on the side nearest the pointer, '+' when hovered; a drag from one leaves that side") {
  auto nodes = baseChanges();
  const Guid A{1, 10}, B{1, 11};
  nodes.push_back(make(A, NodeType::FRAME, kPage, "!", {100, 100, 400, 300}, "A"));
  nodes.push_back(make(B, NodeType::FRAME, kPage, "\"", {100, 700, 400, 300}, "B"));
  Editor e;
  e.setSessionID(1);
  e.setViewport(1600, 1200, 1, 1600, 1200);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({0, 0, 1});
  e.setPrototypeMode(true);
  REQUIRE(e.setSelection({A}) == OK);
  // Before the pointer is known: on the right.
  Overlay o = e.overlay();
  REQUIRE(o.prototype.handles.size() == 1);
  CHECK(o.prototype.handles[0].side == NoodleSide::RIGHT);
  CHECK(!o.prototype.handles[0].hovered);
  // The pointer near the bottom edge: the nub moves there; on it, hovered.
  e.pointer(PointerEvent::MOVE, 250, 380, 0, 0, 0);
  o = e.overlay();
  CHECK(o.prototype.handles[0].side == NoodleSide::BOTTOM);
  CHECK(!o.prototype.handles[0].hovered);
  e.pointer(PointerEvent::MOVE, 300, 402, 0, 0, 0);
  o = e.overlay();
  CHECK(o.prototype.handles[0].side == NoodleSide::BOTTOM);
  CHECK(o.prototype.handles[0].hovered);
  e.pointer(PointerEvent::MOVE, 110, 250, 0, 0, 0);
  CHECK(e.overlay().prototype.handles[0].side == NoodleSide::LEFT);
  // A press on the bottom nub and a drag to B: the new noodle leaves A's bottom; the nub stays there, plain.
  e.pointer(PointerEvent::MOVE, 300, 400, 0, 0, 0);
  CHECK(e.pointer(PointerEvent::DOWN, 300, 400, 0, 1, 0) != 0);
  e.pointer(PointerEvent::MOVE, 600, 300, 0, 1, 0);  // the pointer off to the right…
  e.pointer(PointerEvent::MOVE, 300, 850, 0, 1, 0);  // …then over B
  o = e.overlay();
  REQUIRE(!o.prototype.links.empty());
  CHECK(o.prototype.links.back().startSide == static_cast<int>(NoodleSide::BOTTOM));
  REQUIRE(o.prototype.handles.size() == 1);
  CHECK(o.prototype.handles[0].side == NoodleSide::BOTTOM);
  CHECK(!o.prototype.handles[0].hovered);
  e.pointer(PointerEvent::UP, 300, 850, 0, 0, 0);
  auto list = proto::interactions(e.document().get(A)->props);
  REQUIRE(list.size() == 1);
  CHECK(list[0].actions[0].dest == B);
  // Drawn by Figma's rule after: B is below A (apart down, overlapping across) — out of A's bottom into B's top.
  NoodleCurve n = prototypeNoodle(e.document().worldBounds(A), e.document().worldBounds(B), false, {});
  CHECK(n.start == NoodleSide::BOTTOM);
  CHECK(n.end == NoodleSide::TOP);
  // Selected, its connection is the selection colour's; with nothing selected, every one is quiet (61.png).
  CHECK(e.overlay().prototype.links[0].highlighted);
  e.setSelection({});
  CHECK(!e.overlay().prototype.links[0].highlighted);
}
