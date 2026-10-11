// .fig import polish (roadmap Phase 5, docs/data-impl.md "Import fidelity"): Figma fields the import now keeps and the
// engine uses — "Lock aspect ratio" (targetAspectRatio 423: kept by auto layout and constraints, recorded when the
// lock is turned on, plugin API "targetAspectRatio"), Figma's authored colours (Paint.authoredColor 44 /
// authoredStops 45, Effect.authoredColor 56) dropped when the colour is edited here, kept otherwise.
#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "schema/SchemaTable.h"

using namespace eng;
using namespace eng::test;

namespace {

Editor load(std::vector<NodeChange> nodes) {
  auto all = baseChanges();
  all.insert(all.end(), nodes.begin(), nodes.end());
  Editor e;
  e.loadDocument(all, kNoGuid);
  e.takeEvents();
  return e;
}

NodeChange frame(Guid id, StackMode mode, Rect r) {
  NodeChange f = make(id, NodeType::FRAME, kPage, "!", r, "Auto");
  f.props.stack().stackMode = mode;
  f.props.stack().stackPrimarySizing = StackSize::FIXED;
  f.props.stack().stackCounterSizing = StackSize::FIXED;
  return f;
}

void lockRatio(NodeChange& n, double w, double h) {
  n.props.proportionsConstrained = true;
  n.props.extra["targetAspectRatio"] = Layout::aspectRatioBytes({w, h});
}

Vec2 sizeOf(const Editor& e, Guid id) { return e.document().get(id)->props.size; }

void resize(Editor& e, Guid id, Vec2 s) {
  NodeChange c;
  c.mask = F_SIZE;
  c.props.size = s;
  REQUIRE(e.setProps({id}, c, 0) == OK);
}

// AuthoredColor {space OKLCH, c0 0.7}: Paint field 44 / Effect field 56's bytes.
std::string authored(uint32_t field) {
  schema::Out o;
  o.varuint(field);
  o.varuint(1);
  o.varuint(6);
  o.varuint(2);
  o.varfloat(0.7f);
  o.varuint(0);
  return o.s;
}

}  // namespace

TEST_CASE("r18 aspect ratio: Fill on the primary axis sets the other axis from the locked ratio") {
  const Guid F{1, 1}, A{1, 2}, B{1, 3};
  NodeChange a = make(A, NodeType::ROUNDED_RECTANGLE, F, "!", {0, 0, 50, 25});
  a.props.stackChildPrimaryGrow = 1;
  lockRatio(a, 2, 1);
  NodeChange b = make(B, NodeType::ROUNDED_RECTANGLE, F, "\"", {50, 0, 100, 40});
  Editor e = load({frame(F, StackMode::HORIZONTAL, {0, 0, 300, 200}), a, b});
  CHECK(Layout::aspectRatio(e.document().get(A)->props) == doctest::Approx(2));
  resize(e, F, {400, 200});
  CHECK(sizeOf(e, A).x == doctest::Approx(300));
  CHECK(sizeOf(e, A).y == doctest::Approx(150));
  // Without the lock, Fill changes the width only.
  NodeChange off;
  off.mask = F_PROPORTIONS_CONSTRAINED;
  off.props.proportionsConstrained = false;
  REQUIRE(e.setProps({A}, off, 0) == OK);
  CHECK(Layout::aspectRatio(e.document().get(A)->props) == 0);
  resize(e, F, {500, 200});
  CHECK(sizeOf(e, A).x == doctest::Approx(400));
  CHECK(sizeOf(e, A).y == doctest::Approx(150));
}

TEST_CASE("r18 aspect ratio: Fill across the counter axis (stretch) sets the primary length; the frame's hug follows") {
  const Guid F{2, 1}, A{2, 2}, B{2, 3};
  NodeChange f = frame(F, StackMode::VERTICAL, {0, 0, 300, 100});
  f.props.stack().stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;  // Hug height
  f.props.stack().stackPaddingLeft = f.props.stack().stackPaddingRight = 10;
  NodeChange a = make(A, NodeType::ROUNDED_RECTANGLE, F, "!", {10, 0, 40, 40});
  a.props.stackChildAlignSelf = StackCounterAlign::STRETCH;
  lockRatio(a, 16, 9);
  NodeChange b = make(B, NodeType::ROUNDED_RECTANGLE, F, "\"", {10, 40, 50, 20});
  Editor e = load({f, a, b});
  resize(e, F, {330, 100});
  CHECK(sizeOf(e, A).x == doctest::Approx(310));
  CHECK(sizeOf(e, A).y == doctest::Approx(310 * 9.0 / 16));
  CHECK(sizeOf(e, F).y == doctest::Approx(310 * 9.0 / 16 + 20));
  CHECK(e.document().get(B)->props.transform.m12 == doctest::Approx(310 * 9.0 / 16));
}

TEST_CASE("r18 aspect ratio: a constraint resizing one axis resizes the other") {
  const Guid F{3, 1}, A{3, 2};
  NodeChange a = make(A, NodeType::ROUNDED_RECTANGLE, F, "!", {10, 10, 80, 40});
  a.props.horizontalConstraint = ConstraintType::STRETCH;
  lockRatio(a, 2, 1);
  Editor e = load({make(F, NodeType::FRAME, kPage, "!", {0, 0, 100, 100}), a});
  resize(e, F, {200, 100});
  CHECK(sizeOf(e, A).x == doctest::Approx(180));
  CHECK(sizeOf(e, A).y == doctest::Approx(90));
}

TEST_CASE("r18 aspect ratio: turning the lock on records the layer's width : height, off clears it (undoable)") {
  const Guid A{4, 1}, T{4, 2};
  NodeChange t = make(T, NodeType::TEXT, kPage, "\"", {0, 100, 40, 16});
  t.props.text().textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
  Editor e = load({make(A, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 120, 80}), t});
  NodeChange on;
  on.mask = F_PROPORTIONS_CONSTRAINED;
  on.props.proportionsConstrained = true;
  REQUIRE(e.setProps({A, T}, on, 0) == OK);
  CHECK(Layout::aspectRatio(e.document().get(A)->props) == doctest::Approx(1.5));
  // An auto-resizing text isn't locked to a ratio (plugin API: not with textAutoResize other than NONE).
  CHECK(e.document().get(T)->props.extra.count("targetAspectRatio") == 0);
  e.command(CommandId::UNDO);
  CHECK(e.document().get(A)->props.extra.count("targetAspectRatio") == 0);
  CHECK_FALSE(e.document().get(A)->props.proportionsConstrained);
}

TEST_CASE("r18 authored colours: kept through other edits, dropped when the colour changes here") {
  const Guid A{5, 1};
  NodeChange a = make(A, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 50, 50});
  Paint p = Paint::solid(Color::hex(0x3366ee));
  p.extra = authored(44);
  a.props.fillPaints = {p};
  Effect fx;
  fx.type = EffectType::DROP_SHADOW;
  fx.extra = authored(56);
  a.props.effects = {fx};
  Editor e = load({a});
  const schema::Def* paintDef = schema::SchemaTable::get().def("Paint");
  const schema::Def* effectDef = schema::SchemaTable::get().def("Effect");
  REQUIRE(paintDef);
  REQUIRE(effectDef);
  auto paintAuthored = [&] { return !schema::fieldBytes(*paintDef, e.document().get(A)->props.fillPaints[0].extra, 44).empty(); };
  auto effectAuthored = [&] { return !schema::fieldBytes(*effectDef, e.document().get(A)->props.effects[0].extra, 56).empty(); };
  CHECK(paintAuthored());
  CHECK(effectAuthored());

  // Opacity only: the authored colour still describes the colour.
  NodeChange op;
  op.mask = F_FILLS;
  op.props.fillPaints = e.document().get(A)->props.fillPaints;
  op.props.fillPaints[0].opacity = 0.5f;
  REQUIRE(e.setProps({A}, op, 0) == OK);
  CHECK(paintAuthored());

  // A new colour: stale, it goes.
  NodeChange col;
  col.mask = F_FILLS | F_EFFECTS;
  col.props.fillPaints = e.document().get(A)->props.fillPaints;
  col.props.fillPaints[0].color = Color::hex(0xff0000);
  col.props.effects = e.document().get(A)->props.effects;
  col.props.effects[0].color = Color::hex(0x00ff00, 0.5f);
  REQUIRE(e.setProps({A}, col, 0) == OK);
  CHECK_FALSE(paintAuthored());
  CHECK_FALSE(effectAuthored());
  e.command(CommandId::UNDO);
  CHECK(paintAuthored());
  CHECK(effectAuthored());
}
