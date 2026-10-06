#include "doctest.h"
#include "editor/Selection.h"
#include "Helpers.h"
#include "hit/HitTest.h"
#include "hit/Marquee.h"
#include "hit/Picking.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid F{1, 1}, R1{1, 2}, E{1, 3}, F2{1, 4}, R3{1, 5}, RR{1, 6}, L{1, 7}, H{1, 8}, G{1, 9}, GR{1, 10}, SR{1, 11},
    ROT{1, 12}, EMPTY{1, 13}, G2{1, 14}, G2R{1, 15};

Document scene() {
  Document d;
  base(d);
  d.apply(make(F, NodeType::FRAME, kPage, "A", {0, 0, 200, 200}));
  d.apply(make(R1, NodeType::ROUNDED_RECTANGLE, F, "A", {10, 10, 50, 50}));
  d.apply(make(E, NodeType::ELLIPSE, F, "B", {100, 100, 80, 80}));
  d.apply(make(F2, NodeType::FRAME, F, "C", {20, 120, 60, 60}));
  d.apply(make(R3, NodeType::ROUNDED_RECTANGLE, F2, "A", {50, 0, 40, 40}));
  NodeChange empty = make(EMPTY, NodeType::FRAME, F, "D", {140, 10, 50, 50});  // a nested frame with nothing to show
  empty.props.fillPaints.clear();
  d.apply(empty);
  NodeChange rr = make(RR, NodeType::ROUNDED_RECTANGLE, kPage, "B", {300, 0, 100, 100});
  rr.props.cornerRadii = {40, 0, 0, 0};
  d.apply(rr);
  NodeChange l = make(L, NodeType::ROUNDED_RECTANGLE, kPage, "C", {500, 0, 50, 50});
  l.props.locked = true;
  d.apply(l);
  NodeChange h = make(H, NodeType::ROUNDED_RECTANGLE, kPage, "D", {300, 0, 100, 100});
  h.props.visible = false;
  d.apply(h);
  d.apply(make(G, NodeType::GROUP, kPage, "E", {0, 300, 0, 0}));  // an imported GROUP
  d.apply(make(GR, NodeType::ROUNDED_RECTANGLE, G, "A", {10, 10, 40, 40}));
  NodeChange sr = make(SR, NodeType::ROUNDED_RECTANGLE, kPage, "F", {600, 0, 100, 100});
  sr.props.fillPaints.clear();
  sr.props.strokePaints = {Paint{}};
  d.apply(sr);
  NodeChange rot = make(ROT, NodeType::ROUNDED_RECTANGLE, kPage, "G", {0, 0, 100, 10});
  rot.props.transform = Mat2x3::translate(0, 600) * Mat2x3::rotate(3.14159265358979 / 4);
  d.apply(rot);
  NodeChange g2 = make(G2, NodeType::FRAME, F, "E", {150, 150, 0, 0}, "Group 1");  // DesignerV2's group: FRAME + resizeToFit
  g2.props.resizeToFit = true;
  g2.props.fillPaints.clear();
  d.apply(g2);
  d.apply(make(G2R, NodeType::ROUNDED_RECTANGLE, G2, "A", {0, 0, 20, 20}));
  return d;
}

std::vector<Guid> at(const Document& d, double x, double y) { return hitPath(d, kPage, {x, y}, 1); }

}  // namespace

TEST_CASE("hit: rectangles, frames, ellipses") {
  Document d = scene();
  CHECK(at(d, 20, 20) == std::vector<Guid>{F, R1});
  CHECK(at(d, 5, 5) == std::vector<Guid>{F});
  CHECK(at(d, 102, 102) == std::vector<Guid>{F});  // in the ellipse's box, outside the ellipse
  CHECK(at(d, 140, 140) == std::vector<Guid>{F, E});
  CHECK(at(d, 250, 250).empty());
  // A nested frame with no fill or stroke isn't hit by its box: its parent is.
  CHECK(at(d, 165, 35) == std::vector<Guid>{F});
}

TEST_CASE("hit: rounded corners") {
  Document d = scene();
  CHECK(at(d, 303, 3).empty());
  CHECK(at(d, 350, 50) == std::vector<Guid>{RR});
  CHECK(at(d, 397, 3) == std::vector<Guid>{RR});  // the square corner
}

TEST_CASE("hit: frames clip their children") {
  Document d = scene();
  CHECK(at(d, 75, 125) == std::vector<Guid>{F, F2, R3});
  CHECK(at(d, 90, 125) == std::vector<Guid>{F});  // R3 beyond F2's edge
}

TEST_CASE("hit: locked and hidden") {
  Document d = scene();
  CHECK(at(d, 520, 20).empty());
  CHECK(at(d, 350, 50) == std::vector<Guid>{RR});  // hidden H covers RR: the click reaches RR
  NodeChange lock = NodeChange::changed(R1);
  lock.mask = F_LOCKED;
  lock.props.locked = true;
  d.apply(lock);
  CHECK(at(d, 20, 20) == std::vector<Guid>{F});  // the path stops above a locked layer
}

TEST_CASE("hit: stroke-only shapes are hit on the stroke, within the slop") {
  Document d = scene();
  CHECK(at(d, 650, 50).empty());
  CHECK(at(d, 600.5, 50) == std::vector<Guid>{SR});
  CHECK(at(d, 603, 50) == std::vector<Guid>{SR});    // 4 px slop
  CHECK(at(d, 597, 50) == std::vector<Guid>{SR});
  CHECK(at(d, 610, 50).empty());
  CHECK(hitPath(d, kPage, {606, 50}, 2) == std::vector<Guid>{SR});  // the slop is in CSS px: zoomed out it is wider
}

TEST_CASE("hit: rotated shapes and groups") {
  Document d = scene();
  CHECK(at(d, 50, 652) == std::vector<Guid>{ROT});
  CHECK(at(d, 50, 600).empty());
  CHECK(at(d, 20, 320) == std::vector<Guid>{G, GR});
  CHECK(at(d, 5, 305).empty());  // a group is hit only through its children
  CHECK(at(d, 155, 155) == std::vector<Guid>{F, G2, G2R});
}

TEST_CASE("pick: Figma's selection depth (picking.ts)") {
  Document d = scene();
  CHECK(pick(d, at(d, 75, 125), {}, false) == F2);   // nothing selected: a top-level frame's child
  CHECK(pick(d, at(d, 20, 20), {}, false) == R1);
  CHECK(pick(d, at(d, 75, 125), {F2}, false) == R3); // inside a selected layer: the next level down
  CHECK(pick(d, at(d, 20, 20), {R3}, false) == R1);  // beside one: its siblings
  CHECK(pick(d, at(d, 75, 125), {}, true) == R3);    // ⌘: the innermost
  CHECK(pick(d, at(d, 5, 5), {}, false) == F);       // a top-level frame's own area: the frame
  CHECK(pick(d, at(d, 20, 320), {}, false) == G);    // a top-level group: the group…
  CHECK(pick(d, at(d, 20, 320), {G}, false) == GR);  // …then its child once it's selected
  CHECK(pick(d, at(d, 155, 155), {}, false) == G2);  // a group inside a frame: the outermost unopened group
  CHECK(pick(d, {}, {}, false) == kNoGuid);
}

TEST_CASE("marquee") {
  Document d = scene();
  CHECK(marqueeHits(d, kPage, {0, 0, 30, 30}, kNoGuid) == std::vector<Guid>{R1});  // partly over F: its touched children
  CHECK(marqueeHits(d, kPage, {-10, -10, 220, 220}, kNoGuid) == std::vector<Guid>{F});  // all of F: F
  CHECK(marqueeHits(d, kPage, {90, 90, 50, 50}, F) == std::vector<Guid>{E});  // started inside F: F's children only
  CHECK(marqueeHits(d, kPage, {290, -10, 270, 120}, kNoGuid) == std::vector<Guid>{RR});  // locked and hidden skipped
}

TEST_CASE("selection box and top-level selection") {
  Document d = scene();
  SelectionBox one = selectionBox(d, {R1});
  CHECK(one.valid);
  CHECK(one.toWorld.apply({0, 0}) == Vec2{10, 10});
  CHECK(one.size == Vec2{50, 50});
  SelectionBox two = selectionBox(d, {R1, RR});
  CHECK(two.toWorld.apply({0, 0}) == Vec2{10, 0});
  CHECK(two.size == Vec2{390, 100});
  CHECK(topLevelSelection(d, {R1, F, RR}) == std::vector<Guid>{F, RR});
  CHECK_FALSE(selectionBox(d, {}).valid);
}

TEST_CASE("selection box: several layers sharing a rotation get the rotated box") {
  Document d;
  base(d);
  const double a = 3.14159265358979 / 6;
  NodeChange r1 = make({1, 1}, NodeType::ROUNDED_RECTANGLE, kPage, "A", {0, 0, 10, 10});
  r1.props.transform = Mat2x3::rotate(a);
  NodeChange r2 = make({1, 2}, NodeType::ROUNDED_RECTANGLE, kPage, "B", {0, 0, 10, 10});
  r2.props.transform = Mat2x3::rotate(a) * Mat2x3::translate(20, 0);
  d.apply(r1);
  d.apply(r2);
  SelectionBox box = selectionBox(d, {{1, 1}, {1, 2}});
  CHECK(box.size.x == doctest::Approx(30));
  CHECK(box.size.y == doctest::Approx(10));
}
