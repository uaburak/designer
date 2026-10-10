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

  // Showing a node re-places its subtree (no rebuild); a change on another page doesn't touch this one.
  NodeChange show = NodeChange::changed({1, 5});
  show.mask = F_VISIBLE;
  show.props.visible = true;
  d.apply(show);
  t.sync(d, kPage);
  CHECK(t.rebuilds() == rebuilds);
  CHECK(t.relocations() == 1);
  CHECK(t.indexOf({1, 5}) == 4);
  CHECK(t.consistent(d));
  damage = t.takeDamage();
  REQUIRE(damage.rects.size() == 1);  // where it is now (it drew nowhere before)
  CHECK(damage.rects[0].w == doctest::Approx(10));
  NodeProps other;
  other.type = NodeType::CANVAS;
  other.parentIndex = {kDoc, "#"};
  d.apply(NodeChange::created({9, 1}, other));
  d.apply(make({9, 2}, NodeType::ELLIPSE, {9, 1}, "!", {0, 0, 10, 10}));
  t.sync(d, kPage);
  CHECK(t.rebuilds() == rebuilds);
  CHECK(t.relocations() == 1);
  CHECK(t.takeDamage().rects.empty());
}

TEST_CASE("render tree: structural changes re-place subtrees and leave the array as a fresh build would") {
  Document d;
  base(d);
  grid(d, 30);  // 30 frames with a rectangle each, in a 10 × 3 grid
  // A frame with a nested frame and two leaves inside, and a group, to move things into and out of.
  d.apply(make({3, 1}, NodeType::FRAME, kPage, "~", {0, 500, 300, 300}, "Holder"));
  d.apply(make({3, 2}, NodeType::FRAME, {3, 1}, "!", {10, 10, 100, 100}, "Inner"));
  d.apply(make({3, 3}, NodeType::ROUNDED_RECTANGLE, {3, 2}, "!", {5, 5, 20, 20}));
  d.apply(make({3, 4}, NodeType::ELLIPSE, {3, 1}, "\"", {150, 150, 40, 40}));
  RenderTree t;
  t.sync(d, kPage);
  REQUIRE(t.consistent(d));
  uint32_t rebuilds = t.rebuilds();
  auto reparent = [&](Guid id, Guid parent, const std::string& position) {
    NodeChange c = NodeChange::changed(id);
    c.mask = F_PARENT_INDEX;
    c.props.parentIndex = {parent, position};
    REQUIRE(d.apply(c));
  };
  auto step = [&](const char* what) {
    INFO(what);
    t.sync(d, kPage);
    CHECK(t.rebuilds() == rebuilds);
    CHECK(t.consistent(d));
  };
  // Into a deeper frame, to the end; then back to the page's top (first in paint order); then reordered among
  // siblings; into a frame it was never in; out to the page's last place.
  reparent({2, 5}, {3, 2}, "~");
  step("a leaf into a nested frame");
  CHECK(t.indexOf({2, 5}) == t.indexOf({3, 2}) + 2);
  reparent({2, 5}, kPage, " ");
  step("the leaf to the page's first place");
  CHECK(t.indexOf({2, 5}) == 0);
  reparent({1, 7}, kPage, "~~");
  step("a frame to the page's last place");
  CHECK(t.indexOf({1, 7}) == static_cast<int>(t.size()) - 2);
  reparent({3, 2}, {1, 7}, "~");
  step("a frame with children into another frame");
  reparent({3, 4}, {3, 2}, "!");
  step("a leaf into the moved frame, first among its children");
  // Hidden, shown, removed, created (with a child), the type changed, clipping changed; a CREATED replace.
  NodeChange hide = NodeChange::changed({1, 3});
  hide.mask = F_VISIBLE;
  hide.props.visible = false;
  d.apply(hide);
  step("a frame hidden");
  CHECK(t.indexOf({1, 3}) == -1);
  CHECK(t.indexOf({2, 3}) == -1);
  hide.props.visible = true;
  d.apply(hide);
  step("shown again");
  CHECK(t.indexOf({2, 3}) == t.indexOf({1, 3}) + 1);
  d.apply(NodeChange::removed({2, 9}));
  d.apply(NodeChange::removed({1, 9}));
  step("a frame and its child removed");
  d.apply(make({4, 1}, NodeType::FRAME, {1, 4}, "~", {50, 50, 30, 30}));
  d.apply(make({4, 2}, NodeType::ELLIPSE, {4, 1}, "!", {0, 0, 10, 10}));
  step("a frame with a child created inside a frame");
  NodeChange clip = NodeChange::changed({3, 1});
  clip.mask = F_FRAME_MASK_DISABLED;
  clip.props.frameMaskDisabled = true;
  d.apply(clip);
  step("a frame stops clipping (its visual bounds grow to its children)");
  NodeChange retype = NodeChange::changed({2, 1});
  retype.mask = F_TYPE;
  retype.props.type = NodeType::ELLIPSE;
  d.apply(retype);
  step("a leaf's type changed");
  d.apply(make({3, 1}, NodeType::FRAME, kPage, "~", {0, 500, 300, 300}, "Holder again"));
  step("a CREATED for a live id (a replace)");
  // Several at once, in one sync: a hide, a reparent, a creation and a removal.
  d.apply(hide);
  reparent({1, 12}, {3, 1}, "!");
  d.apply(make({5, 1}, NodeType::ROUNDED_RECTANGLE, kPage, "~~~", {1, 1, 5, 5}));
  d.apply(NodeChange::removed({2, 14}));
  step("four structural changes in one sync");
  CHECK(t.relocations() >= 14);
  // A batch below the rebuild limit: reorders among stale siblings, moves into the same new parent in both orders,
  // a node moved twice. Re-placed, and still as a fresh build would make it.
  for (uint32_t i = 15; i <= 20; i++) reparent({1, i}, {3, 1}, "~");
  reparent({1, 16}, {3, 1}, "!");
  reparent({1, 1}, {3, 1}, "~");
  reparent({1, 2}, {3, 1}, "~");
  reparent({1, 19}, {3, 1}, " ");
  reparent({1, 15}, {3, 1}, "~~");
  t.sync(d, kPage);
  CHECK(t.rebuilds() == rebuilds);
  CHECK(t.consistent(d));
  // Reorders only, in one sync: the first child to the end, the last to the front, the middle one swapped.
  reparent({1, 21}, kPage, "~~~~");
  reparent({1, 28}, kPage, "  ");
  reparent({1, 24}, kPage, "   ");
  reparent({1, 25}, kPage, "    ");
  t.sync(d, kPage);
  CHECK(t.rebuilds() == rebuilds);
  CHECK(t.consistent(d));
  // Many at once rebuild instead (and stay consistent).
  for (uint32_t i = 21; i <= 28; i++) reparent({1, i}, {3, 1}, "~");
  reparent({1, 4}, {3, 1}, "~");
  reparent({1, 5}, {3, 1}, "~");
  reparent({1, 6}, {3, 1}, "~");
  reparent({1, 8}, {3, 1}, "~");
  reparent({1, 10}, {3, 1}, "~");
  reparent({1, 11}, {3, 1}, "~");
  reparent({1, 13}, {3, 1}, "~");
  reparent({1, 14}, {3, 1}, "~");
  reparent({1, 15}, {3, 1}, "!");
  reparent({1, 17}, {3, 1}, "!");
  reparent({1, 18}, {3, 1}, "!");
  reparent({1, 19}, {3, 1}, "!");
  reparent({1, 20}, {3, 1}, "!");
  reparent({1, 21}, {3, 1}, "!");
  reparent({1, 22}, {3, 1}, "!");
  reparent({1, 23}, {3, 1}, "!");
  reparent({1, 24}, {3, 1}, "!");
  t.sync(d, kPage);
  CHECK(t.rebuilds() == rebuilds + 1);
  CHECK(t.consistent(d));
  // The page's own change rebuilds too.
  NodeChange pg = NodeChange::changed(kPage);
  pg.mask = F_VISIBLE;
  pg.props.visible = true;
  d.apply(pg);
  t.sync(d, kPage);
  CHECK(t.rebuilds() == rebuilds + 2);
}

TEST_CASE("render tree: a relocation's damage is where the subtree was and where it is") {
  Document d;
  base(d);
  d.apply(make({1, 1}, NodeType::FRAME, kPage, "A", {0, 0, 100, 100}));
  d.apply(make({1, 2}, NodeType::ROUNDED_RECTANGLE, {1, 1}, "A", {10, 10, 20, 20}));
  d.apply(make({1, 3}, NodeType::FRAME, kPage, "B", {500, 0, 100, 100}));
  RenderTree t;
  t.sync(d, kPage);
  t.takeDamage();
  NodeChange c = NodeChange::changed({1, 2});
  c.mask = F_PARENT_INDEX | F_TRANSFORM;
  c.props.parentIndex = {{1, 3}, "A"};
  c.props.transform = Mat2x3::translate(30, 30);
  d.apply(c);
  t.sync(d, kPage);
  CHECK(t.consistent(d));
  auto damage = t.takeDamage();
  CHECK_FALSE(damage.all);
  REQUIRE(damage.rects.size() >= 2);
  CHECK(damage.rects.front().x == doctest::Approx(10));   // where it was
  CHECK(damage.rects.back().x == doctest::Approx(530));   // where it is
}

TEST_CASE("render tree: a frame that shrinks as a layer leaves it damages where it was") {
  // Round 15 (auto-layout drag, round 2): a layer dragged out of a hugging frame, the frame laid out smaller in the
  // same step — the frame's bounds are new by the time its own change is seen, so the move itself damages where it was.
  Document d;
  base(d);
  d.apply(make({1, 1}, NodeType::FRAME, kPage, "A", {0, 0, 100, 200}));
  d.apply(make({1, 2}, NodeType::ROUNDED_RECTANGLE, {1, 1}, "A", {10, 10, 80, 80}));
  d.apply(make({1, 3}, NodeType::ROUNDED_RECTANGLE, {1, 1}, "B", {10, 110, 80, 80}));
  RenderTree t;
  t.sync(d, kPage);
  t.takeDamage();
  NodeChange out = NodeChange::changed({1, 3});
  out.mask = F_PARENT_INDEX | F_TRANSFORM;
  out.props.parentIndex = {kPage, "B"};
  out.props.transform = Mat2x3::translate(400, 0);
  d.apply(out);
  NodeChange shrink = NodeChange::changed({1, 1});
  shrink.mask = F_SIZE;
  shrink.props.size = {100, 100};
  d.apply(shrink);
  t.sync(d, kPage);
  CHECK(t.consistent(d));
  auto damage = t.takeDamage();
  CHECK_FALSE(damage.all);
  bool old = false;
  for (const Rect& r : damage.rects) old |= r.y <= 100 && r.bottom() >= 200 && r.x <= 0 && r.right() >= 100;
  CHECK(old);  // the frame's lower half, where it no longer is
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
  t.props.text().textData.characters = "Some words to greek";
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
  // 0.5 %: layers under a quarter of a device pixel are skipped (100 × 0.005 × 2 = 1 px: drawn; their 20 px
  // children: 0.2 px, skipped), the text's 12 px em is 0.12 device px: a bar holding the line's ink.
  s = r.render(e.document(), kPage, Camera{0, 0, 0.005}, kView, none, kDark);
  CHECK(s.tiny >= 1);
  CHECK(s.greeked == 1);
  CHECK(s.glyphs == 0);
  // 6 %: a 1.44 device px em is still glyphs (Figma draws small text as glyphs).
  s = r.render(e.document(), kPage, Camera{0, 0, 0.06}, kView, none, kDark);
  CHECK(s.greeked == 0);
  CHECK(s.glyphs > 10);
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

TEST_CASE("tiles: zooming out on a slow page composites tiles instead of drawing every frame; budget, invalidation") {
  Document d;
  base(d);
  grid(d, 100);
  gfx::NullDevice dev;
  Renderer r(dev);
  r.setContentCache(true);
  double now = 1000;
  double rasterCost = 10;  // each raster (a full one or a tile) advances the clock this much
  bool slow = true;
  r.setClock([&] {
    if (slow) now += rasterCost;
    return now;
  });
  Overlay o;
  o.frameTitles = false;
  Camera cam{0, 0, 1};
  r.render(d, kPage, cam, kView, o, kDark);  // a slow full raster: 20 ms
  // At rest, quiet frames draw the coarser level's tiles ahead, within the idle budget, a frame asked for meanwhile.
  RenderStats s = r.render(d, kPage, cam, kView, o, kDark);
  CHECK(s.cachedRegions == 0);
  CHECK(s.tilesRastered >= 1);
  CHECK(s.tilesRastered <= 2);  // 10 ms each, a 12 ms budget: one, and the one that crossed it
  CHECK(r.wantsFrameAt() > 0);
  for (int i = 0; i < 64 && r.wantsFrameAt() > 0; i++) r.render(d, kPage, cam, kView, o, kDark);
  CHECK(r.wantsFrameAt() == 0);
  size_t ahead = r.tileCount();
  CHECK(ahead > 0);
  CHECK(r.tileBytes() <= Renderer::kTileBudgetBytes);

  // A continuous zoom out: nothing is drawn whole; the tiles (and the scaled cache where it lands) show, the
  // missing ones of the zoom's own level drawn within the interacting budget.
  o.zooming = true;
  for (double z : {0.9, 0.8, 0.7, 0.6}) {
    s = r.render(d, kPage, Camera{0, 0, z}, kView, o, kDark);
    CHECK(s.cachedRegions == 0);
    CHECK(s.stale == 1);
    CHECK(s.tilesShown > 0);
    CHECK(s.tilesRastered <= 1);  // 10 ms tiles, a 6 ms budget: one per frame
  }
  // The zoom settles: drawn sharp, whole, once.
  now += Renderer::kZoomSettleMs + 1;
  s = r.render(d, kPage, Camera{0, 0, 0.6}, kView, o, kDark);
  CHECK(s.stale == 0);
  CHECK(s.cachedRegions == 1);

  // An edit drops the tiles under it (where it was and where it is), keeps the others.
  o.zooming = false;
  size_t before = r.tileCount();
  NodeChange move = NodeChange::changed({2, 1});
  move.mask = F_TRANSFORM;
  move.props.transform = Mat2x3::translate(30, 30);
  d.apply(move);
  r.render(d, kPage, Camera{0, 0, 0.6}, kView, o, kDark);
  CHECK(r.tileCount() < before);
  CHECK(r.tileCount() > 0);
  // Another page, or the fonts: all of them.
  slow = false;
  Document other;
  base(other);
  r.render(other, kPage, Camera{0, 0, 0.6}, kView, o, kDark);
  CHECK(r.tileCount() == 0);
}

TEST_CASE("tiles: the budget holds while the zoom roams; least recently shown go first") {
  Document d;
  base(d);
  grid(d, 100);
  gfx::NullDevice dev;
  Renderer r(dev);
  r.setContentCache(true);
  double now = 1000;
  r.setClock([&] { return now += 10; });
  Overlay o;
  o.frameTitles = false;
  r.render(d, kPage, Camera{}, kView, o, kDark);
  o.zooming = true;
  // A long zoom over many levels and places: every frame zooms out (tiled), the budget is never passed.
  for (int i = 0; i < 300; i++) {
    double z = 0.9 * std::pow(0.97, i % 120);
    r.render(d, kPage, Camera{-(i % 37) * 400.0, -(i % 23) * 300.0, z}, kView, o, kDark);
    CHECK(r.tileBytes() <= Renderer::kTileBudgetBytes);
  }
  CHECK(r.tileCount() > 0);
  CHECK(dev.memory().bytes < (512ull << 20));
}
