// The render tree (docs/engine.md §6.2), culling and LOD (§6.8), and the content
// cache (§6.9 as built): what a frame draws again after a pan, an edit, a hover,
// a zoom — recorded on the NullDevice.
#include <string>

#include "base/FractionalIndex.h"
#include "doctest.h"
#include "editor/Editor.h"
#include "gfx/null/NullDevice.h"
#include "Helpers.h"
#include "render/Renderer.h"
#include "render/RenderTree.h"
#include "TextHelpers.h"

using namespace eng;
using namespace eng::test;

namespace {

const OverlayStyle kDark = OverlayStyle::of(Theme::Dark);
const Viewport kView{800, 600, 2, 1600, 1200};

// A grid of `n` frames (100 × 100, 20 apart, 10 per row), each with a rectangle inside.
void grid(Document& d, uint32_t n) {
  std::string key;
  for (uint32_t i = 1; i <= n; i++) {
    key = fractional::keyBetween(key, std::nullopt, fractional::Bias::Low);
    d.apply(make({1, i}, NodeType::FRAME, kPage, key, {(i - 1) % 10 * 120.0, (i - 1) / 10 * 120.0, 100, 100}));
    d.apply(make({2, i}, NodeType::ROUNDED_RECTANGLE, {1, i}, "!", {10, 10, 40, 40}));
  }
}

// Instances drawn into the cache's target this frame (the canvas pass is the blit and the overlays).
size_t contentInstances(const gfx::NullDevice& dev) {
  size_t n = 0;
  for (size_t i = 0; i < dev.draws.size(); i++) {
    const auto& c = dev.draws[i];
    if (c.pipeline.shader == gfx::ShaderId::Shape) n += c.call.instanceCount;
  }
  return n;
}

}  // namespace

TEST_CASE("render tree: paint order, subtrees, visual bounds") {
  Document d;
  base(d);
  d.apply(make({1, 1}, NodeType::FRAME, kPage, "A", {0, 0, 100, 100}));  // clips: its own box
  d.apply(make({1, 2}, NodeType::ROUNDED_RECTANGLE, {1, 1}, "A", {50, 50, 200, 200}));
  NodeChange open = make({1, 3}, NodeType::FRAME, kPage, "B", {300, 0, 100, 100});
  open.props.frameMaskDisabled = true;  // doesn't clip: its children's bounds too
  d.apply(open);
  d.apply(make({1, 4}, NodeType::ELLIPSE, {1, 3}, "A", {80, 80, 100, 100}));
  NodeChange hidden = make({1, 5}, NodeType::ROUNDED_RECTANGLE, kPage, "C", {0, 0, 10, 10});
  hidden.props.visible = false;
  d.apply(hidden);
  RenderTree t;
  t.sync(d, kPage);
  REQUIRE(t.size() == 4);  // the hidden one has no render node
  CHECK(t.nodes()[0].id == Guid{1, 1});
  CHECK(t.nodes()[0].end == 2);
  CHECK(t.nodes()[1].parent == 0);
  CHECK(t.indexOf({1, 5}) == -1);
  CHECK(t.nodes()[0].visual.right() == doctest::Approx(100));  // clipped
  CHECK(t.nodes()[2].visual.right() == doctest::Approx(480));  // with its ellipse
  CHECK(t.takeDamage().all);

  // A move: bounds again for the node and its ancestors, no rebuild; damage where it was and is.
  uint32_t rebuilds = t.rebuilds();
  NodeChange move = NodeChange::changed({1, 4});
  move.mask = F_TRANSFORM;
  move.props.transform = Mat2x3::translate(10, 10);
  d.apply(move);
  t.sync(d, kPage);
  CHECK(t.rebuilds() == rebuilds);
  CHECK(t.nodes()[2].visual.right() == doctest::Approx(410));
  auto damage = t.takeDamage();
  REQUIRE(damage.rects.size() == 2);
  CHECK(damage.rects[0].x == doctest::Approx(380));  // before
  CHECK(damage.rects[1].x == doctest::Approx(310));  // after

  // Showing a node rebuilds; a change on another page doesn't touch this one.
  NodeChange show = NodeChange::changed({1, 5});
  show.mask = F_VISIBLE;
  show.props.visible = true;
  d.apply(show);
  t.sync(d, kPage);
  CHECK(t.rebuilds() == rebuilds + 1);
  CHECK(t.indexOf({1, 5}) == 4);
  t.takeDamage();
  NodeProps other;
  other.type = NodeType::CANVAS;
  other.parentIndex = {kDoc, "#"};
  d.apply(NodeChange::created({9, 1}, other));
  d.apply(make({9, 2}, NodeType::ELLIPSE, {9, 1}, "!", {0, 0, 10, 10}));
  t.sync(d, kPage);
  CHECK(t.rebuilds() == rebuilds + 1);
  CHECK(t.takeDamage().rects.empty());
}

TEST_CASE("renderer: off-screen subtrees are culled whole, sub-pixel ones skipped, tiny text greeked") {
  loadInter();
  auto nodes = baseChanges();
  std::string key;
  for (uint32_t i = 1; i <= 50; i++) {
    key = fractional::keyBetween(key, std::nullopt, fractional::Bias::Low);
    nodes.push_back(make({1, i}, NodeType::FRAME, kPage, key, {i * 1000.0, 0, 100, 100}));
    nodes.push_back(make({2, i}, NodeType::ROUNDED_RECTANGLE, {1, i}, "!", {10, 10, 20, 20}));
  }
  NodeChange t = make({3, 1}, NodeType::TEXT, kPage, "~", {0, 200, 200, 20});
  t.props.textData.characters = "Some words to greek";
  nodes.push_back(t);
  Editor e;
  e.setViewport(800, 600, 2, 1600, 1200);
  e.loadDocument(nodes, kNoGuid);
  gfx::NullDevice dev;
  Renderer r(dev);
  r.setTextLayouts(&e);
  Overlay none;
  none.frameTitles = false;
  // 100%: the first frame alone is on screen; the 49 others go at their top level, their children never visited.
  RenderStats s = r.render(e.document(), kPage, Camera{-900, 0, 1}, kView, none, kDark);
  CHECK(s.culled >= 49);
  CHECK(s.nodes < 60);  // of 101: the culled frames' children were never visited
  CHECK(s.greeked == 0);
  // 1 %: frames under half a device pixel (100 × 0.01 × 2 = 2 px: drawn; their 20 px children: 0.4 px, skipped),
  // the text's 12 px em is 0.24 device px: bars.
  s = r.render(e.document(), kPage, Camera{0, 0, 0.01}, kView, none, kDark);
  CHECK(s.tiny >= 1);
  CHECK(s.greeked == 1);
  CHECK(s.glyphs == 0);
}

TEST_CASE("content cache: a frame with nothing new composites; an edit draws its damage only") {
  Document d;
  base(d);
  grid(d, 40);
  gfx::NullDevice dev;
  Renderer r(dev);
  r.setContentCache(true);
  Overlay o;
  o.frameTitles = false;
  RenderStats s = r.render(d, kPage, Camera{}, kView, o, kDark);
  CHECK(s.cachedRegions == 1);  // the whole page, once
  size_t full = contentInstances(dev);
  CHECK(full >= 50);  // the 28 frames on screen and their rectangles
  // Nothing changed (a hover, the caret): no content is drawn, the cache is composited.
  o.hover = {{1, 3}};
  s = r.render(d, kPage, Camera{}, kView, o, kDark);
  CHECK(s.cachedRegions == 0);
  CHECK(contentInstances(dev) <= 4);  // the hover outline
  // One rectangle moves: only where it was and is gets drawn again (its frame's and neighbours' pixels there).
  NodeChange move = NodeChange::changed({2, 15});
  move.mask = F_TRANSFORM;
  move.props.transform = Mat2x3::translate(20, 20);
  d.apply(move);
  o.hover.clear();
  s = r.render(d, kPage, Camera{}, kView, o, kDark);
  CHECK(s.cachedRegions >= 1);
  CHECK(contentInstances(dev) < full / 4);
  // Every instance drawn into the cache is clipped to the damage (canvas device px, around x 500–650 at dpr 2).
  for (size_t i = 0; i < dev.draws.size(); i++) {
    const auto& c = dev.draws[i];
    if (c.pipeline.shader != gfx::ShaderId::Shape || c.call.instanceCount == 0) continue;
    for (auto& q : dev.instancesOf<DrawInstance>(i))
      if (q.clip[0] > -1e8f) CHECK(q.clip[2] - q.clip[0] < 200);
  }
}

TEST_CASE("content cache: a pan by whole device pixels shifts the cache and draws the strips that came in") {
  Document d;
  base(d);
  grid(d, 100);
  gfx::NullDevice dev;
  Renderer r(dev);
  r.setContentCache(true);
  Overlay o;
  o.frameTitles = false;
  r.render(d, kPage, Camera{}, kView, o, kDark);
  size_t full = contentInstances(dev);
  // 10 CSS px left = 20 device px: one strip on the right.
  RenderStats s = r.render(d, kPage, Camera{-10, 0, 1}, kView, o, kDark);
  CHECK(s.cachedRegions == 1);
  CHECK(contentInstances(dev) < full / 2);
  // A pan by half a device pixel can't shift pixels: everything again.
  s = r.render(d, kPage, Camera{-10.25, 0, 1}, kView, o, kDark);
  CHECK(s.cachedRegions == 1);
  CHECK(contentInstances(dev) >= full / 2);
  // The cache is two canvas-sized targets, whatever happens.
  CHECK(dev.memory().targets <= 2 + r.poolTargets());
}

TEST_CASE("content cache: a continuous zoom on a slow page shows the cache scaled, then draws it sharp") {
  Document d;
  base(d);
  grid(d, 40);
  gfx::NullDevice dev;
  Renderer r(dev);
  r.setContentCache(true);
  double now = 1000;
  bool slow = true;
  // A clock where every full raster takes 20 ms (slower than the zoom budget).
  r.setClock([&] {
    if (slow) now += 10;
    return now;
  });
  Overlay o;
  o.frameTitles = false;
  r.render(d, kPage, Camera{}, kView, o, kDark);
  slow = false;
  o.zooming = true;
  RenderStats s = r.render(d, kPage, Camera{0, 0, 1.1}, kView, o, kDark);
  CHECK(s.stale == 1);
  CHECK(s.cachedRegions == 0);
  CHECK(r.wantsFrameAt() > now);
  // An edit while zooming isn't lost: the settle frame draws everything.
  NodeChange move = NodeChange::changed({2, 3});
  move.mask = F_TRANSFORM;
  move.props.transform = Mat2x3::translate(30, 30);
  d.apply(move);
  s = r.render(d, kPage, Camera{0, 0, 1.2}, kView, o, kDark);
  CHECK(s.stale == 1);
  now += Renderer::kZoomSettleMs + 1;
  s = r.render(d, kPage, Camera{0, 0, 1.2}, kView, o, kDark);
  CHECK(s.stale == 0);
  CHECK(s.cachedRegions == 1);
  CHECK(r.wantsFrameAt() == 0);
  // A fast page zooms sharp every frame.
  s = r.render(d, kPage, Camera{0, 0, 1.3}, kView, o, kDark);
  CHECK(s.stale == 0);
  CHECK(s.cachedRegions == 1);
}
