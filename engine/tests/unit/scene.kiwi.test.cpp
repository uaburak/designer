// The generated kiwi codecs compile and work (docs/schema.md §2.2): a Message
// through the tree codec and back, the visitor codec re-encoding it byte for
// byte, and the engine's field ids agreeing with the generated registry.
#include <cstring>
#include <string_view>

#include "doctest.h"
#include "kiwi.h"
#include "scene/Node.h"
#include "schema/document.stream.h"
#include "schema/node_fields.h"

using namespace eng;

TEST_CASE("kiwi: a Message round-trips through the tree codec and the stream codec") {
  kiwi::MemoryPool pool;
  schema::Message m;
  m.set_type(schema::MessageType::NODE_CHANGES);
  m.set_sessionID(7);
  schema::NodeChange& n = m.set_nodeChanges(pool, 1)[0];
  schema::GUID guid;
  guid.set_sessionID(1);
  guid.set_localID(2);
  n.set_guid(&guid);
  n.set_phase(schema::NodePhase::CREATED);
  n.set_type(schema::NodeType::FRAME);
  n.set_name(kiwi::String("Frame 1"));
  schema::Vector size;
  size.set_x(100);
  size.set_y(50.5f);
  n.set_size(&size);
  n.set_stackMode(schema::StackMode::HORIZONTAL);
  n.set_stackSpacing(8);

  kiwi::ByteBuffer bb;
  REQUIRE(m.encode(bb));
  CHECK(bb.size() > 0);

  kiwi::ByteBuffer in(bb.data(), bb.size());
  kiwi::MemoryPool pool2;
  schema::Message back;
  REQUIRE(back.decode(in, pool2));
  REQUIRE(back.sessionID());
  CHECK(*back.sessionID() == 7);
  REQUIRE(back.nodeChanges());
  REQUIRE(back.nodeChanges()->size() == 1);
  schema::NodeChange& b = (*back.nodeChanges())[0];
  CHECK(*b.guid()->localID() == 2);
  CHECK(*b.type() == schema::NodeType::FRAME);
  CHECK(std::string_view(b.name()->c_str()) == "Frame 1");
  CHECK(*b.size()->y() == doctest::Approx(50.5));
  CHECK(*b.stackMode() == schema::StackMode::HORIZONTAL);
  CHECK(b.opacity() == nullptr);  // absent stays absent

  // The visitor codec: parse the bytes into its Writer, which writes them again.
  kiwi::ByteBuffer again(bb.data(), bb.size());
  kiwi::ByteBuffer copy;
  schema_stream::Writer writer(copy);
  REQUIRE(schema_stream::parseMessage(again, writer));
  REQUIRE(copy.size() == bb.size());
  CHECK(std::memcmp(copy.data(), bb.data(), bb.size()) == 0);
}

TEST_CASE("kiwi: the engine's kiwi field ids are the generated registry's") {
  auto nameOf = [](uint32_t id) -> std::string_view {
    for (const auto& f : schema::kNodeFields)
      if (f.id == id) return f.name;
    return {};
  };
  struct {
    Field field;
    const char* name;
  } expected[] = {
      {F_NAME, "name"}, {F_VISIBLE, "visible"}, {F_LOCKED, "locked"}, {F_OPACITY, "opacity"}, {F_TRANSFORM, "transform"},
      {F_SIZE, "size"}, {F_FILLS, "fillPaints"}, {F_STROKES, "strokePaints"}, {F_STROKE_WEIGHT, "strokeWeight"},
      {F_STROKE_ALIGN, "strokeAlign"}, {F_FRAME_MASK_DISABLED, "frameMaskDisabled"}, {F_RESIZE_TO_FIT, "resizeToFit"},
      {F_BACKGROUND_COLOR, "backgroundColor"}, {F_BACKGROUND_ENABLED, "backgroundEnabled"}, {F_INTERNAL_ONLY, "internalOnly"},
      {F_STACK_MODE, "stackMode"}, {F_STACK_SPACING, "stackSpacing"}, {F_STACK_PADDING_LEFT, "stackHorizontalPadding"},
      {F_STACK_PADDING_TOP, "stackVerticalPadding"}, {F_STACK_PADDING_RIGHT, "stackPaddingRight"},
      {F_STACK_PADDING_BOTTOM, "stackPaddingBottom"}, {F_STACK_PRIMARY_SIZING, "stackPrimarySizing"},
      {F_STACK_COUNTER_SIZING, "stackCounterSizing"}, {F_STACK_PRIMARY_ALIGN, "stackPrimaryAlignItems"},
      {F_STACK_COUNTER_ALIGN, "stackCounterAlignItems"}, {F_STACK_COUNTER_ALIGN_CONTENT, "stackCounterAlignContent"},
      {F_STACK_WRAP, "stackWrap"}, {F_STACK_COUNTER_SPACING, "stackCounterSpacing"}, {F_STACK_REVERSE_Z, "stackReverseZIndex"},
      {F_BORDERS_TAKE_SPACE, "bordersTakeSpace"}, {F_STACK_CHILD_GROW, "stackChildPrimaryGrow"},
      {F_STACK_CHILD_ALIGN_SELF, "stackChildAlignSelf"}, {F_STACK_POSITIONING, "stackPositioning"}, {F_MIN_SIZE, "minSize"},
      {F_MAX_SIZE, "maxSize"}, {F_H_CONSTRAINT, "horizontalConstraint"}, {F_V_CONSTRAINT, "verticalConstraint"},
      {F_PROPORTIONS_CONSTRAINED, "proportionsConstrained"},
  };
  for (auto& e : expected) {
    INFO(e.name);
    CHECK(nameOf(kiwiFieldId(e.field)) == e.name);
  }
  CHECK(nameOf(static_cast<uint32_t>(schema::NodeField::stackMode)) == "stackMode");
}
