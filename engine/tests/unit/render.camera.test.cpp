#include "doctest.h"
#include "render/Camera.h"

using namespace eng;

TEST_CASE("camera: screen and world") {
  Camera c{100, 50, 2};
  Vec2 w = c.toWorld({300, 250});
  CHECK(w == Vec2{100, 100});
  CHECK(c.toScreen(w) == Vec2{300, 250});
  CHECK(c.matrix().apply(w) == Vec2{300, 250});
}

TEST_CASE("camera: zoom around a point keeps it still") {
  Camera c{37, -12, 0.75};
  Vec2 at{412, 233};
  Vec2 before = c.toWorld(at);
  Camera z = c.zoomedAround(3.2, at);
  CHECK(z.zoom == doctest::Approx(3.2));
  Vec2 after = z.toWorld(at);
  CHECK(after.x == doctest::Approx(before.x));
  CHECK(after.y == doctest::Approx(before.y));
}

TEST_CASE("camera: zoom limits") {
  Camera c;
  CHECK(c.zoomedAround(1000, {0, 0}).zoom == kMaxZoom);
  CHECK(c.zoomedAround(0.0001, {0, 0}).zoom == kMinZoom);
}

TEST_CASE("camera: fit like view.ts fitView") {
  // A 200×100 rect in an 800×600 viewport: 64px of room, capped at 100%.
  Camera c = Camera::fit({0, 0, 200, 100}, 800, 600, true);
  CHECK(c.zoom == 1);
  CHECK(c.x == 300);
  CHECK(c.y == 250);
  Camera big = Camera::fit({0, 0, 200, 100}, 800, 600, false);
  CHECK(big.zoom == doctest::Approx((800 - 128) / 200.0));
  // Huge content zooms out.
  Camera out = Camera::fit({-5000, 0, 10000, 100}, 800, 600, true);
  CHECK(out.zoom == doctest::Approx(672 / 10000.0));
  Vec2 centre = out.toScreen({0, 50});
  CHECK(centre.x == doctest::Approx(400));
  CHECK(centre.y == doctest::Approx(300));
}

TEST_CASE("camera: the view stops at the canvas's edge (±130,000, as Figma's)") {
  const Rect view{0, 0, 1000, 800};
  // Panned past the right / bottom edge: held so the view's far side is on the edge
  Camera far{-200000, -200000, 1};
  Camera kept = far.keptOnCanvas(view);
  CHECK(kept.toWorld({1000, 800}).x == doctest::Approx(kCanvasBound));
  CHECK(kept.toWorld({1000, 800}).y == doctest::Approx(kCanvasBound));
  // Past the left / top edge at 50%
  Camera left{200000, 100000, 0.5};
  CHECK(left.keptOnCanvas(view).toWorld({0, 0}).x == doctest::Approx(-kCanvasBound));
  CHECK(left.keptOnCanvas(view).toWorld({0, 0}).y == doctest::Approx(-kCanvasBound));
  // Inside: untouched; zoom never changes
  Camera in{37, -12, 0.75};
  CHECK(in.keptOnCanvas(view).x == in.x);
  CHECK(in.keptOnCanvas(view).y == in.y);
  CHECK(far.keptOnCanvas(view).zoom == 1);
  // No viewport yet: untouched
  CHECK(far.keptOnCanvas({}).x == far.x);
}
