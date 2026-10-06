#include "base/Json.h"
#include "doctest.h"
#include "Helpers.h"
#include "scene/CodecJson.h"

using namespace eng;
using namespace eng::test;

TEST_CASE("json: parse and write") {
  json::Value v;
  REQUIRE(json::parse(R"({"a":[1,2.5,-3e2],"b":"x\"é\n","c":true,"d":null,"e":{}})", v));
  CHECK(v.get("a")->array[2].number == -300);
  CHECK(v.get("b")->string == "x\"\xC3\xA9\n");
  CHECK(v.get("c")->boolean);
  CHECK(v.get("d")->isNull());
  json::Writer w;
  w.beginObject().key("s").string("a\"b").key("n").number(1.5).key("arr").beginArray().number(1).number(2).endArray().endObject();
  CHECK(w.str() == R"({"s":"a\"b","n":1.5,"arr":[1,2]})");
  CHECK_FALSE(json::parse("{", v));
  CHECK_FALSE(json::parse("[1,]", v));
  CHECK_FALSE(json::parse("{} x", v));
}

TEST_CASE("codec: an update carries only its fields") {
  NodeChange c = NodeChange::changed({1, 2});
  c.mask = F_NAME | F_CORNER_RADII;
  c.props.name = "Card";
  c.props.cornerRadii = {1, 2, 3, 4};
  json::Writer w;
  codec::writeChange(w, c);
  CHECK(w.str() ==
        R"({"guid":"1:2","name":"Card","cornerRadius":1,"rectangleCornerRadiiIndependent":true,"rectangleTopLeftCornerRadius":1,"rectangleTopRightCornerRadius":2,"rectangleBottomRightCornerRadius":3,"rectangleBottomLeftCornerRadius":4})");
  json::Value v;
  REQUIRE(json::parse(w.str(), v));
  NodeChange back;
  REQUIRE(codec::readChange(v, back));
  CHECK(back.guid == Guid{1, 2});
  CHECK(back.phase == Phase::CHANGED);
  CHECK(back.mask == (F_NAME | F_CORNER_RADII));
  CHECK(back.props.cornerRadii == CornerRadii{1, 2, 3, 4});
}

TEST_CASE("codec: CREATED carries what differs from absence, and round-trips") {
  NodeChange c = make({4, 5}, NodeType::FRAME, kPage, "Qd&", {10.5, -20, 300, 200}, "Frame 1");
  c.props.strokePaints = {Paint::solid(Color{0.1f, 0.2f, 0.3f, 1}, 0.5f)};
  c.props.strokeWeight = 2;
  c.props.strokeAlign = StrokeAlign::OUTSIDE;
  c.props.frameMaskDisabled = true;
  c.props.locked = true;
  json::Writer w;
  codec::writeChange(w, c);
  json::Value v;
  REQUIRE(json::parse(w.str(), v));
  CHECK(v.get("visible") == nullptr);  // true is the absence value
  CHECK(v.get("opacity") == nullptr);
  CHECK(v.get("locked")->boolean);
  NodeChange back;
  REQUIRE(codec::readChange(v, back));
  CHECK(back.phase == Phase::CREATED);
  CHECK(differingFields(back.props, c.props) == 0);
}

TEST_CASE("codec: removed, clearedFields, uniform radius, bad input") {
  json::Value v;
  REQUIRE(json::parse(R"([{"guid":"1:1","phase":"REMOVED"},{"guid":"nope"},{"name":"x"},
    {"guid":"2:3","cornerRadius":8,"rectangleCornerRadiiIndependent":false,"rectangleTopLeftCornerRadius":3},
    {"guid":"2:4","clearedFields":[38,8,4],"name":"n"}])", v));
  auto changes = codec::readChanges(v);
  REQUIRE(changes.size() == 3);
  CHECK(changes[0].phase == Phase::REMOVED);
  CHECK(changes[1].props.cornerRadii == CornerRadii{8, 8, 8, 8});
  // fillPaints and opacity reset to absent; type can't be cleared.
  CHECK(changes[2].mask == (F_NAME | F_FILLS | F_OPACITY));
  CHECK(changes[2].props.opacity == 1);
  CHECK(changes[2].props.fillPaints.empty());
  CHECK(Guid::parse("12:34") == Guid{12, 34});
  bool ok = true;
  Guid::parse("12:", &ok);
  CHECK_FALSE(ok);
}

TEST_CASE("codec: Figma's types and names") {
  json::Value v;
  REQUIRE(json::parse(R"({"guid":"1:1","phase":"CREATED","type":"RECTANGLE","strokeAlign":"INSIDE"})", v));
  NodeChange c;
  REQUIRE(codec::readChange(v, c));
  CHECK(c.props.type == NodeType::RECTANGLE);
  CHECK(c.props.isRectLike());
  CHECK(c.props.strokeAlign == StrokeAlign::INSIDE);
  // Absent stroke fields mean kiwi zero values.
  REQUIRE(json::parse(R"({"guid":"1:1","phase":"CREATED","type":"ELLIPSE"})", v));
  REQUIRE(codec::readChange(v, c));
  CHECK(c.props.strokeWeight == 0);
  CHECK(c.props.strokeAlign == StrokeAlign::CENTER);
  CHECK(c.props.visible);
  CHECK(c.props.opacity == 1);
}
