// Batch D — performance (docs/research/rea/README.md, docs/engine.md "Batch D"): the mechanisms that keep a heavy
// file's frames short, each checked for doing less work while giving the same document and the same pixels.
#include "Helpers.h"
#include "base/DerivedIds.h"
#include "doctest.h"
#include "editor/Editor.h"
#include "motion/Model.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid kRoot{1, 1}, kRect{1, 2}, kOther{1, 3};

void loadPlain(Editor& e) {
  std::vector<NodeChange> nodes = baseChanges();
  nodes.push_back(make(kRoot, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "Root"));
  nodes.push_back(make(kRect, NodeType::ROUNDED_RECTANGLE, kRoot, "!", {20, 30, 100, 50}, "Rect"));
  nodes.push_back(make(kOther, NodeType::ROUNDED_RECTANGLE, kRoot, "\"", {200, 30, 50, 50}, "Other"));
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kPage);
  e.takeEvents();
}

CommandArgs args(const char* text) {
  CommandArgs a;
  REQUIRE(json::parse(text, a.raw));
  return a;
}

}  // namespace

TEST_CASE("batch D: a commit that brings no motion data keeps the motion index (no whole-document rebuild)") {
  Editor e;
  loadPlain(e);
  e.tick(0);  // the load's rebuild
  uint64_t base = e.motionRebuilds();
  CHECK(e.motionIndex().empty());
  // A click (a gesture that writes nothing) and a move (a write without motion data): the index stays.
  e.pointer(PointerEvent::DOWN, 50, 50, 0, 1, 0);
  e.pointer(PointerEvent::UP, 50, 50, 0, 0, 0);
  e.tick(16);
  e.pointer(PointerEvent::DOWN, 50, 50, 0, 1, 0);
  for (int i = 1; i <= 4; i++) e.pointer(PointerEvent::MOVE, 50 + 10 * i, 50, 0, 1, 0);
  e.pointer(PointerEvent::UP, 90, 50, 0, 0, 0);
  e.tick(32);
  CHECK(e.document().get(kRect)->props.transform.m02 != doctest::Approx(20));
  CHECK(e.motionRebuilds() == base);
  // A keyframe (motion data) rebuilds; with the index no longer empty, any later write rebuilds too.
  motion::State s;
  s.on = true;
  s.root = kRoot;
  e.setMotion(s);
  e.setSelection({kRect});
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"field":{"type":"PROPERTY","name":"OPACITY"}})")) == OK);
  e.setMotion(motion::State{});
  e.tick(48);
  CHECK(e.motionIndex().node(kRect) != nullptr);
  uint64_t withMotion = e.motionRebuilds();
  CHECK(withMotion > base);
  e.setSelection({kOther});
  REQUIRE(e.command(CommandId::DELETE) == OK);
  e.tick(64);
  CHECK(e.motionRebuilds() > withMotion);
  // Undo back to no motion, then redo: the redo brings the keyframe binding back, and the index has it again.
  for (int i = 0; i < 8 && e.motionIndex().node(kRect) && e.canUndo(); i++) {
    REQUIRE(e.command(CommandId::UNDO) == OK);
    e.tick(80);
  }
  CHECK(e.motionIndex().node(kRect) == nullptr);
  REQUIRE(e.command(CommandId::REDO) == OK);
  e.tick(96);
  CHECK(e.motionIndex().node(kRect) != nullptr);
}

namespace {

const Guid kMain{2, 1}, kBg{2, 2}, kDot{2, 3}, kFlow{2, 10}, kI1{2, 11}, kI2{2, 12};

// A main (100 × 40: a background stretching both ways, a dot pinned right) and two instances stretched across a
// vertical auto-layout frame `width` wide.
std::vector<NodeChange> refitDoc(double width) {
  std::vector<NodeChange> nodes = baseChanges();
  NodeChange m = make(kMain, NodeType::SYMBOL, kPage, "!", {0, 400, 100, 40}, "Row");
  m.props.fillPaints.clear();
  nodes.push_back(m);
  NodeChange bg = make(kBg, NodeType::ROUNDED_RECTANGLE, kMain, "!", {0, 0, 100, 40}, "Background");
  bg.props.horizontalConstraint = ConstraintType::STRETCH;
  bg.props.verticalConstraint = ConstraintType::STRETCH;
  nodes.push_back(bg);
  NodeChange dot = make(kDot, NodeType::ELLIPSE, kMain, "\"", {80, 10, 10, 10}, "Dot");
  dot.props.horizontalConstraint = ConstraintType::MAX;
  nodes.push_back(dot);
  NodeChange f = make(kFlow, NodeType::FRAME, kPage, "\"", {0, 0, width, 0}, "Flow");
  StackFacet& s = f.props.stack();
  s.stackMode = StackMode::VERTICAL;
  s.stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  s.stackCounterSizing = StackSize::FIXED;
  nodes.push_back(f);
  for (Guid id : {kI1, kI2}) {
    NodeChange i = make(id, NodeType::INSTANCE, kFlow, id == kI1 ? "a" : "b", {0, 0, 100, 40}, "Row");
    i.props.comp().symbolData.symbolID = kMain;
    i.props.fillPaints.clear();
    i.props.stackChildAlignSelf = StackCounterAlign::STRETCH;
    nodes.push_back(i);
  }
  return nodes;
}

Editor loadRefit(double width) {
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(refitDoc(width), kPage);
  e.takeEvents();
  return e;
}

}  // namespace

TEST_CASE("batch D: an instance resized by its auto-layout parent refits its rows instead of deriving them again") {
  Editor e = loadRefit(200);
  const Document& d = e.document();
  REQUIRE(d.get(kI1)->props.size.x == doctest::Approx(200));
  Guid bg1 = derived::intern(kI1, {kBg}), dot1 = derived::intern(kI1, {kDot});
  REQUIRE(d.get(bg1));
  CHECK(d.get(bg1)->props.size.x == doctest::Approx(200));
  uint64_t before = e.materializations();
  // The parent wider: layout stretches both instances (their size alone changes) — refitted, not derived again.
  NodeChange w = NodeChange::changed(kFlow);
  w.mask = F_SIZE;
  w.props.size = {300, d.get(kFlow)->props.size.y};
  REQUIRE(e.setProps({kFlow}, w, 0) == OK);
  CHECK(e.materializations() == before);
  CHECK(d.get(kI1)->props.size.x == doctest::Approx(300));
  CHECK(d.get(kI2)->props.size.x == doctest::Approx(300));
  // The same rows as deriving them at that width: the background stretched, the dot pinned right.
  Editor fresh = loadRefit(300);
  for (Guid row : {bg1, dot1, derived::intern(kI2, {kBg}), derived::intern(kI2, {kDot})}) {
    REQUIRE(fresh.document().get(row));
    CHECK(d.get(row)->props.size == fresh.document().get(row)->props.size);
    CHECK(d.get(row)->props.transform == fresh.document().get(row)->props.transform);
  }
  CHECK(d.get(dot1)->props.transform.m02 == doctest::Approx(280));
  // A change to the main still derives its instances again.
  NodeChange c = NodeChange::changed(kDot);
  c.mask = F_OPACITY;
  c.props.opacity = 0.5;
  REQUIRE(e.setProps({kDot}, c, 0) == OK);
  CHECK(e.materializations() > before);
  CHECK(d.get(dot1)->props.opacity == doctest::Approx(0.5));
  CHECK(d.get(dot1)->props.transform.m02 == doctest::Approx(280));
  // Undo puts the narrower parent back: the instances follow it.
  REQUIRE(e.command(CommandId::UNDO) == OK);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(d.get(kI1)->props.size.x == doctest::Approx(200));
  CHECK(d.get(bg1)->props.size.x == doctest::Approx(200));
  CHECK(d.get(dot1)->props.transform.m02 == doctest::Approx(180));
}
