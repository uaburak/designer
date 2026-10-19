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

TEST_CASE("camera: zoom in / out step to the next / previous power of two (Figma Design)") {
  CHECK(Camera::zoomedIn(1) == 2);
  CHECK(Camera::zoomedIn(1.5) == 2);  // not 300 %
  CHECK(Camera::zoomedIn(0.75) == 1);
  CHECK(Camera::zoomedIn(0.3) == 0.5);
  CHECK(Camera::zoomedOut(1) == 0.5);
  CHECK(Camera::zoomedOut(1.5) == 1);
  CHECK(Camera::zoomedOut(3) == 2);
  CHECK(Camera::zoomedIn(200) == kMaxZoom);
  CHECK(Camera::zoomedOut(0.02) == kMinZoom);
  CHECK(kMinZoom == 0.015625);
}

TEST_CASE("camera: fit — padding on each side, no 100 % cap (Figma's zoom to rect)") {
  // A 200×100 rect in an 800×600 viewport with 25 px a side: zoomed in past 100 %, centred.
  Camera c = Camera::fit({0, 0, 200, 100}, 800, 600, kFitPadding);
  CHECK(c.zoom == doctest::Approx((800 - 50) / 200.0));
  Vec2 mid = c.toScreen({100, 50});
  CHECK(mid.x == doctest::Approx(400));
  CHECK(mid.y == doctest::Approx(300));
  Camera sel = Camera::fit({0, 0, 200, 100}, 800, 600, kSelectionPadding);
  CHECK(sel.zoom == doctest::Approx((800 - 80) / 200.0));
  // Huge content zooms out.
  Camera out = Camera::fit({-5000, 0, 10000, 100}, 800, 600, kFitPadding);
  CHECK(out.zoom == doctest::Approx(750 / 10000.0));
  Vec2 centre = out.toScreen({0, 50});
  CHECK(centre.x == doctest::Approx(400));
  CHECK(centre.y == doctest::Approx(300));
  // No width or no height (a straight line): 100 %, centred on it.
  Camera line = Camera::fit({0, 40, 300, 0}, 800, 600, kSelectionPadding);
  CHECK(line.zoom == 1);
  CHECK(line.toScreen({150, 40}).x == doctest::Approx(400));
  CHECK(line.toScreen({150, 40}).y == doctest::Approx(300));
}

TEST_CASE("camera: the view's centre stops at ±131,072 (Figma's 2^17)") {
  const Rect view{0, 0, 1000, 800};
  // Panned past the right / bottom edge: held with the view's middle on the bound
  Camera far{-200000, -200000, 1};
  Camera kept = far.keptOnCanvas(view);
  CHECK(kept.toWorld({500, 400}).x == doctest::Approx(kCanvasBound));
  CHECK(kept.toWorld({500, 400}).y == doctest::Approx(kCanvasBound));
  CHECK(kCanvasBound == 131072);
  // Past the left / top edge at 50 %
  Camera left{200000, 100000, 0.5};
  CHECK(left.keptOnCanvas(view).toWorld({500, 400}).x == doctest::Approx(-kCanvasBound));
  CHECK(left.keptOnCanvas(view).toWorld({500, 400}).y == doctest::Approx(-kCanvasBound));
  // The middle of the visible part (panels over the canvas), not of the canvas
  const Rect inset{300, 0, 400, 800};
  CHECK(far.keptOnCanvas(inset).toWorld({500, 400}).x == doctest::Approx(kCanvasBound));
  // Zoomed far out the whole canvas fits: the centre still stops there
  Camera wide{-100000, 0, kMinZoom};
  CHECK(wide.keptOnCanvas(view).toWorld({500, 400}).x == doctest::Approx(kCanvasBound));
  // Inside: untouched; zoom never changes
  Camera in{37, -12, 0.75};
  CHECK(in.keptOnCanvas(view).x == in.x);
  CHECK(in.keptOnCanvas(view).y == in.y);
  CHECK(far.keptOnCanvas(view).zoom == 1);
  // No viewport yet: untouched
  CHECK(far.keptOnCanvas({}).x == far.x);
}
