// Round 19b: Illustrator's Pathfinders (geometry/Pathfinder.h, editor/PathfinderCommands.cpp) — Divide, Trim, Merge,
// Crop, Outline, Minus Back as Illustrator documents them: piece counts, areas, the paint each piece takes, the
// options, and the commands (one undo step, the result selected, ordinary layers).
#include <cmath>

#include "doctest.h"
#include "editor/Editor.h"
#include "geometry/Pathfinder.h"
#include "geometry/Shapes.h"
#include "GeometryHelpers.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::geom;
using namespace eng::test;

namespace {

Path square(double x, double y, double s) { return rectPath({s, s}, {0, 0, 0, 0}).transformed(Mat2x3::translate(x, y)); }

PathfinderInput shape(Path p, bool filled = true, uint64_t fill = 1) {
  PathfinderInput in;
  in.path = std::move(p);
  in.filled = filled;
  in.fillKey = fill;
  return in;
}

double area(const Path& p) { return sampledArea(p, false, 0.5); }

double length(const Path& p) {
  double l = 0;
  for (auto& line : flatten(p, 0.01)) {
    for (size_t i = 1; i < line.points.size(); i++) l += (line.points[i] - line.points[i - 1]).length();
    if (line.closed && line.points.size() > 1) l += (line.points.front() - line.points.back()).length();
  }
  return l;
}

// A red square under a blue one, overlapping by a quarter.
std::vector<PathfinderInput> two(uint64_t bottomFill = 1, uint64_t topFill = 2) { return {shape(square(0, 0, 100), true, bottomFill), shape(square(50, 50, 100), true, topFill)}; }

}  // namespace

TEST_CASE("r19b: Divide — every face its own piece, painted by the shape on top there") {
  auto pieces = pathfinder(two(), PathfinderOp::DIVIDE, {});
  REQUIRE(pieces.size() == 3);
  double red = 0, blue = 0;
  for (auto& p : pieces) (p.source == 0 ? red : blue) += area(p.path);
  CHECK(red == doctest::Approx(7500).epsilon(0.01));    // the bottom square's visible part
  CHECK(blue == doctest::Approx(10000).epsilon(0.01));  // the overlap takes the top's paint
  // Bottom first: the bottom square's piece paints first.
  CHECK(pieces.front().source == 0);
  // An open path cuts: a square and a line across it → two halves.
  Path line;
  line.moveTo({-10, 50});
  line.lineTo({110, 50});
  auto halves = pathfinder({shape(square(0, 0, 100)), shape(line, false)}, PathfinderOp::DIVIDE, {});
  REQUIRE(halves.size() == 2);
  CHECK(area(halves[0].path) == doctest::Approx(5000).epsilon(0.01));
  CHECK(area(halves[1].path) == doctest::Approx(5000).epsilon(0.01));
  CHECK(halves[0].source == 0);
  // Curves stay curves (a circle cut by a square: its arcs are the circle's own cubics).
  Path circle = ellipsePath({100, 100}, {}).transformed(Mat2x3::translate(60, 0));
  auto cut = pathfinder({shape(square(0, 0, 100)), shape(circle, true, 2)}, PathfinderOp::DIVIDE, {});
  CHECK(cut.size() == 3);
  size_t cubics = 0;
  for (auto& p : cut) cubics += countVerb(p.path, Verb::Cubic);
  CHECK(cubics >= 4);
  CHECK(cubics < 40);
}

TEST_CASE("r19b: Trim and Merge — hidden parts removed; Merge joins touching pieces of one fill") {
  auto trim = pathfinder(two(), PathfinderOp::TRIM, {});
  REQUIRE(trim.size() == 2);
  CHECK(trim[0].source == 0);
  CHECK(area(trim[0].path) == doctest::Approx(7500).epsilon(0.01));
  CHECK(trim[1].source == 1);
  CHECK(area(trim[1].path) == doctest::Approx(10000).epsilon(0.01));
  // Merge, different fills: as Trim.
  CHECK(pathfinder(two(1, 2), PathfinderOp::MERGE, {}).size() == 2);
  // The same fill: one piece, the union.
  auto merged = pathfinder(two(7, 7), PathfinderOp::MERGE, {});
  REQUIRE(merged.size() == 1);
  CHECK(area(merged[0].path) == doctest::Approx(17500).epsilon(0.01));
  CHECK(merged[0].source == 1);  // the topmost's look
  // The same fill but apart: two pieces.
  auto apart = pathfinder({shape(square(0, 0, 50), true, 7), shape(square(100, 0, 50), true, 7)}, PathfinderOp::MERGE, {});
  CHECK(apart.size() == 2);
  // A red square, a blue one over it, a red one over that touching the first only through the blue: three pieces.
  auto chain = pathfinder({shape(square(0, 0, 100), true, 1), shape(square(80, 0, 100), true, 2), shape(square(160, 0, 100), true, 1)}, PathfinderOp::MERGE, {});
  CHECK(chain.size() == 3);
  // An unfilled shape on top hides nothing and goes (Trim's pieces are filled).
  auto hollow = pathfinder({shape(square(0, 0, 100)), shape(square(50, 50, 100), false)}, PathfinderOp::TRIM, {});
  REQUIRE(hollow.size() == 1);
  CHECK(area(hollow[0].path) == doctest::Approx(10000).epsilon(0.01));
}

TEST_CASE("r19b: Crop — the top shape cuts what is below it, and goes") {
  auto crop = pathfinder(two(), PathfinderOp::CROP, {});
  REQUIRE(crop.size() == 1);
  CHECK(crop[0].source == 0);
  CHECK(area(crop[0].path) == doctest::Approx(2500).epsilon(0.01));
  // Two shapes under the crop: each keeps what shows of it inside.
  auto two_ = pathfinder({shape(square(0, 0, 100), true, 1), shape(square(40, 0, 100), true, 2), shape(square(20, 20, 100), true, 3)}, PathfinderOp::CROP, {});
  REQUIRE(two_.size() == 2);
  CHECK(area(two_[0].path) == doctest::Approx(20 * 80).epsilon(0.02));  // the first's strip left of the second
  CHECK(area(two_[1].path) == doctest::Approx(80 * 80).epsilon(0.02));
}

TEST_CASE("r19b: Outline — every edge split where they cross, as open paths of its shape") {
  auto edges = pathfinder(two(), PathfinderOp::OUTLINE, {});
  REQUIRE(edges.size() == 4);  // each square's outline in two, at the two crossings
  double total = 0;
  for (auto& e : edges) {
    CHECK(e.open);
    total += length(e.path);
  }
  CHECK(total == doctest::Approx(800).epsilon(0.001));
  CHECK(edges[0].source == 0);
  CHECK(edges.back().source == 1);
  // One shape alone: its whole outline, one closed run.
  auto lone = pathfinder({shape(square(0, 0, 100))}, PathfinderOp::OUTLINE, {});
  REQUIRE(lone.size() == 1);
  CHECK(length(lone[0].path) == doctest::Approx(400).epsilon(0.001));
  // "Divide and Outline will remove unpainted artwork": an unfilled shape's edges go.
  PathfinderOptions o;
  o.removeUnpainted = true;
  auto painted = pathfinder({shape(square(0, 0, 100)), shape(square(50, 50, 100), false)}, PathfinderOp::OUTLINE, o);
  CHECK(painted.size() == 1);
}

TEST_CASE("r19b: Minus Back — the front shape without what is behind it") {
  auto m = pathfinder(two(), PathfinderOp::MINUS_BACK, {});
  REQUIRE(m.size() == 1);
  CHECK(m[0].source == 1);
  CHECK(area(m[0].path) == doctest::Approx(7500).epsilon(0.01));
  // Several behind.
  auto many = pathfinder({shape(square(0, 0, 50)), shape(square(100, 100, 50)), shape(square(0, 0, 150))}, PathfinderOp::MINUS_BACK, {});
  REQUIRE(many.size() == 1);
  CHECK(area(many[0].path) == doctest::Approx(22500 - 5000).epsilon(0.01));
}

TEST_CASE("r19b: Pathfinder Options — unpainted artwork, redundant points") {
  // Divide with an unfilled square on top: kept, its faces cut (the overlap red — the filled shape there), the rest
  // an unpainted piece; with the option, the unfilled square is dropped first.
  std::vector<PathfinderInput> in{shape(square(0, 0, 100)), shape(square(50, 50, 100), false)};
  auto kept = pathfinder(in, PathfinderOp::DIVIDE, {});
  REQUIRE(kept.size() == 3);
  size_t unpainted = 0;
  for (auto& p : kept) unpainted += p.source == 1;
  CHECK(unpainted == 1);
  PathfinderOptions o;
  o.removeUnpainted = true;
  auto dropped = pathfinder(in, PathfinderOp::DIVIDE, o);
  REQUIRE(dropped.size() == 1);
  CHECK(area(dropped[0].path) == doctest::Approx(10000).epsilon(0.01));
  // Remove redundant points: a square's face comes back with four corners only (the crossings on its edges merged).
  auto trim = pathfinder(two(), PathfinderOp::TRIM, {});
  CHECK(countVerb(trim[1].path, Verb::Line) <= 4);
  PathfinderOptions keep;
  keep.removeRedundantPoints = false;
  auto raw = pathfinder(two(), PathfinderOp::TRIM, keep);
  CHECK(countVerb(raw[1].path, Verb::Line) > countVerb(trim[1].path, Verb::Line));
}

TEST_CASE("r19b: the commands — ordinary layers, one undo step, the result selected") {
  auto nodes = baseChanges();
  NodeChange a = make({1, 1}, NodeType::ROUNDED_RECTANGLE, kPage, "!", {100, 100, 100, 100}, "Red");
  a.props.fillPaints = {Paint::solid(Color::hex(0xFF0000))};
  NodeChange b = make({1, 2}, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {150, 150, 100, 100}, "Blue");
  b.props.fillPaints = {Paint::solid(Color::hex(0x0000FF))};
  b.props.strokePaints = {Paint::solid(Color::hex(0x000000))};
  b.props.strokeWeight = 2;
  nodes.push_back(a);
  nodes.push_back(b);
  Editor e;
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kNoGuid);
  e.setSelection({{1, 1}, {1, 2}});
  for (CommandId id : {CommandId::PATHFINDER_DIVIDE, CommandId::PATHFINDER_TRIM, CommandId::PATHFINDER_MERGE, CommandId::PATHFINDER_CROP,
                       CommandId::PATHFINDER_OUTLINE, CommandId::PATHFINDER_MINUS_BACK})
    CHECK((e.commandState(id) & CMD_ENABLED) != 0);
  // Divide: a group of three vectors where the two rectangles were, painted as they showed.
  REQUIRE(e.command(CommandId::PATHFINDER_DIVIDE) == OK);
  CHECK(e.undoStack().undoLabel() == "Divide");
  REQUIRE(e.selection().size() == 1);
  Guid g = e.selection()[0];
  const NodeProps& gp = e.document().get(g)->props;
  CHECK(gp.isGroupLike());
  CHECK(e.document().parentOf(g) == kPage);
  CHECK(!e.document().has({1, 1}));
  CHECK(!e.document().has({1, 2}));
  const auto& kids = e.document().children(g);
  REQUIRE(kids.size() == 3);
  int red = 0, blue = 0;
  for (Guid k : kids) {
    const NodeProps& kp = e.document().get(k)->props;
    CHECK(kp.type == NodeType::VECTOR);
    if (kp.fillPaints[0].color == Color::hex(0xFF0000)) red++;
    else {
      blue++;
      CHECK(kp.strokePaints.size() == 1);  // Divide keeps the strokes
    }
  }
  CHECK(red == 1);
  CHECK(blue == 2);
  // The pieces sit where the shapes were (world bounds of the group: 100…250).
  Rect wb = transformedBounds(e.document().worldTransform(g), gp.size.x, gp.size.y);
  CHECK(wb.x == doctest::Approx(100));
  CHECK(wb.w == doctest::Approx(150));
  e.command(CommandId::UNDO);
  CHECK(e.document().has({1, 1}));
  CHECK(e.document().has({1, 2}));
  CHECK(!e.document().has(g));
  // Trim drops the strokes.
  e.setSelection({{1, 1}, {1, 2}});
  REQUIRE(e.command(CommandId::PATHFINDER_TRIM) == OK);
  for (Guid k : e.document().children(e.selection()[0])) CHECK(e.document().get(k)->props.strokePaints.empty());
  e.command(CommandId::UNDO);
  // Outline: open vectors stroked with the fill colour, no fill.
  e.setSelection({{1, 1}, {1, 2}});
  REQUIRE(e.command(CommandId::PATHFINDER_OUTLINE) == OK);
  CHECK(e.undoStack().undoLabel() == "Outline");
  for (Guid k : e.document().children(e.selection()[0])) {
    const NodeProps& kp = e.document().get(k)->props;
    CHECK(kp.fillPaints.empty());
    REQUIRE(kp.strokePaints.size() == 1);
  }
  e.command(CommandId::UNDO);
  // Minus Back: one vector at the front shape's place, its look.
  e.setSelection({{1, 1}, {1, 2}});
  REQUIRE(e.command(CommandId::PATHFINDER_MINUS_BACK) == OK);
  CHECK(e.undoStack().undoLabel() == "Minus Back");
  REQUIRE(e.selection().size() == 1);
  const NodeProps& mp = e.document().get(e.selection()[0])->props;
  CHECK(mp.type == NodeType::VECTOR);
  CHECK(mp.name == "Blue");
  CHECK(mp.fillPaints[0].color == Color::hex(0x0000FF));
  CHECK(e.document().parentOf(e.selection()[0]) == kPage);
  e.command(CommandId::UNDO);
  // Options through the args: Crop at another precision.
  e.setSelection({{1, 1}, {1, 2}});
  CommandArgs args;
  json::parse("{\"precision\": 0.5, \"removeRedundantPoints\": false}", args.raw);
  REQUIRE(e.command(CommandId::PATHFINDER_CROP, args) == OK);
  CHECK(e.document().children(e.selection()[0]).size() == 1);
  // One layer: Trim has nothing to trim it against.
  e.command(CommandId::UNDO);
  e.setSelection({{1, 1}});
  CHECK((e.commandState(CommandId::PATHFINDER_TRIM) & CMD_ENABLED) == 0);
  CHECK((e.commandState(CommandId::PATHFINDER_DIVIDE) & CMD_ENABLED) != 0);
}
