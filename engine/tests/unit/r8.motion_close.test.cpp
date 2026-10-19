// Figma Motion, round 8j (docs/motion.md §4.5, §4.6, §6.12): position and scale as one XY track or an X / Y pair, never
// both, enforced where tracks are made; custom animation styles made from preset runs (the Plugin API's entries), an
// update reaching the layers the style is bound to in the same step, a binding applied again in place, and a style
// previewed inside an open transaction (the Animations menu's hover preview).
#include <algorithm>
#include <string>

#include "Helpers.h"
#include "doctest.h"
#include "editor/Editor.h"
#include "motion/Evaluate.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid kRoot{1, 1}, kRect{1, 2}, kOther{1, 3};

void load(Editor& e) {
  std::vector<NodeChange> nodes = baseChanges();
  nodes.push_back(make(kRoot, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "Root"));
  nodes.push_back(make(kRect, NodeType::ROUNDED_RECTANGLE, kRoot, "!", {20, 30, 100, 50}, "Rect"));
  nodes.push_back(make(kOther, NodeType::ROUNDED_RECTANGLE, kRoot, "\"", {200, 30, 50, 50}, "Other"));
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kPage);
  e.takeEvents();
}

CommandArgs args(const std::string& json) {
  CommandArgs a;
  REQUIRE(json::parse(json, a.raw));
  return a;
}

json::Value parsed(const std::string& text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  return v;
}

motion::State on(int64_t timeUs) {
  motion::State s;
  s.on = true;
  s.root = kRoot;
  s.timeUs = timeUs;
  return s;
}

std::string q(Guid g) { return "\"" + g.toString() + "\""; }

Status key(Editor& e, const char* field, int64_t at, const std::string& value) {
  return e.command(CommandId::MOTION_ADD_KEYFRAME, args(std::string(R"({"nodes":["1:2"],"field":{"type":"PROPERTY","name":")") + field + R"("},"timeUs":)" +
                                                        std::to_string(at) + R"(,"value":)" + value + "}"));
}

// A GUID as the decoded field holds it ("1:2", or {sessionID, localID}) → "1:2"; "" when there is none.
std::string idOf(const json::Value* v) {
  if (!v) return "";
  if (v->isString()) return v->string;
  const json::Value* s = v->get("sessionID");
  const json::Value* l = v->get("localID");
  return s && l ? Guid{static_cast<uint32_t>(s->number), static_cast<uint32_t>(l->number)}.toString() : "";
}

// The style entries of a layer naming `style` by GUID: {entry id, its clips}.
std::vector<std::pair<std::string, size_t>> bound(const Document& doc, Guid node, Guid style) {
  std::vector<std::pair<std::string, size_t>> out;
  json::Value list = motion::extraJson(doc.get(node)->props, "styleIdsForAnimation");
  for (size_t i = 0; list.isArray() && i < list.array.size(); i++) {
    const json::Value* s = list.array[i].get("animationStyleId");
    if (s && idOf(s->get("guid")) == style.toString()) out.push_back({idOf(list.array[i].get("id")), list.array[i].get("generatedAnimationPresets")->array.size()});
  }
  return out;
}

}  // namespace

TEST_CASE("motion edit: an X track beside an XY one, or XY beside X / Y, is refused; Combine and Split still switch") {
  Editor e;
  load(e);
  e.setSelection({kRect});
  e.setMotion(on(0));
  REQUIRE(key(e, "TRANSLATION_XY", 0, R"({"type":"VECTOR","value":{"x":0,"y":0}})") == OK);
  CHECK(key(e, "TRANSLATION_X", 500000, R"({"type":"FLOAT","value":10})") == E_INVALID);
  CHECK(key(e, "TRANSLATION_Y", 500000, R"({"type":"FLOAT","value":10})") == E_INVALID);
  // The XY track itself takes more keyframes.
  CHECK(key(e, "TRANSLATION_XY", 500000, R"({"type":"VECTOR","value":{"x":10,"y":0}})") == OK);
  REQUIRE(e.command(CommandId::MOTION_SPLIT_TRACKS, args(R"({"node":"1:2","kind":"POSITION"})")) == OK);
  CHECK(key(e, "TRANSLATION_XY", 750000, R"({"type":"VECTOR","value":{"x":0,"y":0}})") == E_INVALID);
  CHECK(key(e, "TRANSLATION_X", 750000, R"({"type":"FLOAT","value":5})") == OK);
  // Scale the same way; other fields are free.
  REQUIRE(key(e, "SCALE_X", 0, R"({"type":"FLOAT","value":1})") == OK);
  CHECK(key(e, "SCALE_XY", 0, R"({"type":"VECTOR","value":{"x":1,"y":1}})") == E_INVALID);
  CHECK(key(e, "OPACITY", 0, R"({"type":"FLOAT","value":50})") == OK);
  REQUIRE(e.command(CommandId::MOTION_COMBINE_TRACKS, args(R"({"node":"1:2","kind":"SCALE"})")) == OK);
  CHECK(key(e, "SCALE_Y", 0, R"({"type":"FLOAT","value":1})") == E_INVALID);
}

TEST_CASE("motion styles: a custom style from preset runs; its update reaches the layers bound to it in the same step") {
  Editor e;
  load(e);
  const Document& doc = e.document();
  e.setMotion(on(0));
  // createCustomAnimationStyle(): an empty style.
  REQUIRE(e.command(CommandId::MOTION_APPLY_STYLE, args(R"({"create":{"name":"Motion/Pop","templates":[]}})")) == OK);
  Guid style = e.lastCreated()[0];
  CHECK(doc.get(style)->props.asset().styleType == StyleType::ANIMATION);
  CHECK(doc.get(style)->props.name == "Motion/Pop");
  CHECK(doc.children(style).empty());
  CHECK(!doc.get(style)->props.extra.count("styleAnimations"));
  // addAnimationEntryAsync: the content written again with the entry appended.
  std::string opacity = R"({"preset":"opacity","name":"Opacity","props":{"0:7":40},"offsetUs":0,"durationUs":400000,"easing":{"type":"LINEAR"}})";
  REQUIRE(e.command(CommandId::MOTION_APPLY_STYLE, args("{\"create\":{\"style\":" + q(style) + ",\"templates\":[" + opacity + "]}}")) == OK);
  CHECK(e.undoStack().undoLabel() == "Update animation style");
  REQUIRE(doc.children(style).size() == 1);
  motion::Preset t;
  REQUIRE(motion::decodePreset(doc.get(doc.children(style)[0])->props, doc.children(style)[0], t));
  CHECK(t.key == "opacity");
  CHECK(t.durationUs == 400000);
  CHECK(doc.get(doc.children(style)[0])->props.comp().componentPropAssignments.size() == 1);
  // Applied to two layers (one at 200 ms), then updated with two runs: both layers' bindings now generate two clips each,
  // keeping their ids and starts.
  std::string out = R"({"tracks":[]})";
  auto apply = [&](const char* node, int64_t at) {
    REQUIRE(e.command(CommandId::MOTION_APPLY_STYLE, args(std::string("{\"nodes\":[\"") + node + "\"],\"style\":" + q(style) + ",\"startUs\":" + std::to_string(at) +
                                                          R"(,"presets":[{"preset":"opacity","name":"Opacity","offsetUs":0,"durationUs":400000,"output":)" + out + "}]}")) == OK);
  };
  apply("1:2", 0);
  apply("1:3", 200000);
  std::string rect = bound(doc, kRect, style)[0].first, other = bound(doc, kOther, style)[0].first;
  std::string scale = R"({"preset":"scale","name":"Scale","offsetUs":100000,"durationUs":300000,"output":)" + out + "}";
  std::string runs = "[" + opacity.substr(0, opacity.size() - 1) + ",\"output\":" + out + "}," + scale + "]";
  // The first template named by its id is kept as it is (the Plugin API's entry ids hold); the second is new.
  Guid first = doc.children(style)[0];
  std::string kept = "{\"id\":" + q(first) + "," + opacity.substr(1);
  REQUIRE(e.command(CommandId::MOTION_APPLY_STYLE, args("{\"create\":{\"style\":" + q(style) + ",\"templates\":[" + kept + "," + scale + "],\"presets\":" + runs + "}}")) == OK);
  REQUIRE(doc.children(style).size() == 2);
  CHECK(doc.children(style)[0] == first);
  CHECK(bound(doc, kRect, style) == std::vector<std::pair<std::string, size_t>>{{rect, 2}});
  CHECK(bound(doc, kOther, style) == std::vector<std::pair<std::string, size_t>>{{other, 2}});
  const motion::AnimatedNode* an = e.motionIndex().node(kOther);
  REQUIRE(an);
  REQUIRE(an->presets.size() == 2);
  motion::Preset second;
  REQUIRE(motion::decodePreset(doc.get(an->presets[1])->props, an->presets[1], second));
  CHECK(second.key == "scale");
  CHECK(second.offsetUs == 300000);  // the binding's 200 ms + the run's 100 ms
  // One step: undone, the layers have their one clip again and the style its one template.
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(doc.children(style).size() == 1);
  CHECK(bound(doc, kOther, style) == std::vector<std::pair<std::string, size_t>>{{other, 1}});
  // Templates without a preset: refused.
  CHECK(e.command(CommandId::MOTION_APPLY_STYLE, args(R"({"create":{"name":"Bad","templates":[{"name":"x"}]}})")) == E_INVALID);
}

TEST_CASE("motion styles: a style previewed inside an open transaction plays on the canvas; cancelled, nothing of it stays") {
  Editor e;
  load(e);
  const Document& doc = e.document();
  e.setMotion(on(0));
  size_t undos = e.undoStack().undoCount();
  REQUIRE(e.txnBegin("Preview animation style") == OK);
  std::string fade = R"({"tracks":[{"field":{"type":"PROPERTY","name":"OPACITY"},"operation":"SCALE","keyframes":[)"
                     R"({"timeUs":0,"value":{"type":"FLOAT","value":0},"easing":{"type":"LINEAR"}},)"
                     R"({"timeUs":500000,"value":{"type":"FLOAT","value":1},"easing":{"type":"LINEAR"}}]}]})";
  REQUIRE(e.command(CommandId::MOTION_APPLY_STYLE, args(R"({"nodes":["1:2"],"style":"fadeIn","startUs":0,"presets":[{"preset":"opacity","name":"Opacity","offsetUs":0,"durationUs":500000,"output":)" + fade + "}]}")) == OK);
  // Without `inTransaction` the layer waits for the commit; with it, it plays at once.
  REQUIRE(e.setMotionJson(parsed(R"({"on":true,"root":"1:1","timeUs":250000})")) == OK);
  CHECK(doc.get(kRect)->props.opacity == doctest::Approx(1));
  REQUIRE(e.setMotionJson(parsed(R"({"on":true,"root":"1:1","timeUs":250000,"inTransaction":true})")) == OK);
  CHECK(doc.get(kRect)->props.opacity == doctest::Approx(0.5));
  e.txnCancel();
  CHECK(doc.get(kRect)->props.opacity == doctest::Approx(1));
  CHECK(motion::decodePresetList(doc.get(kRect)->props).empty());
  CHECK(e.undoStack().undoCount() == undos);
  // The flag went with the transaction: the next one waits for its commit again.
  REQUIRE(e.txnBegin("Next") == OK);
  REQUIRE(e.command(CommandId::MOTION_APPLY_STYLE, args(R"({"nodes":["1:2"],"style":"fadeIn","startUs":0,"presets":[{"preset":"opacity","name":"Opacity","offsetUs":0,"durationUs":500000,"output":)" + fade + "}]}")) == OK);
  REQUIRE(e.setMotionJson(parsed(R"({"timeUs":200000})")) == OK);
  CHECK(doc.get(kRect)->props.opacity == doctest::Approx(1));
  REQUIRE(e.txnCommit() == OK);
  CHECK(doc.get(kRect)->props.opacity == doctest::Approx(0.4));
}

TEST_CASE("motion styles: a binding applied again in place keeps its id and place; another layer's binding is refused") {
  Editor e;
  load(e);
  const Document& doc = e.document();
  e.setMotion(on(0));
  std::string out = R"({"tracks":[]})";
  auto apply = [&](const std::string& extra, const char* style) {
    return e.command(CommandId::MOTION_APPLY_STYLE, args(std::string(R"({"nodes":["1:2"],"style":")") + style + "\"" + extra +
                                                         R"(,"presets":[{"preset":"opacity","name":"Opacity","offsetUs":0,"durationUs":500000,"output":)" + out + "}]}"));
  };
  REQUIRE(apply(",\"startUs\":0", "fadeIn") == OK);
  REQUIRE(apply(",\"startUs\":0", "popIn") == OK);
  json::Value list = motion::extraJson(doc.get(kRect)->props, "styleIdsForAnimation");
  REQUIRE(list.array.size() == 2);
  std::string first = idOf(list.array[0].get("id"));
  REQUIRE(apply(",\"startUs\":250000,\"binding\":\"" + first + "\"", "slideIn") == OK);
  list = motion::extraJson(doc.get(kRect)->props, "styleIdsForAnimation");
  REQUIRE(list.array.size() == 2);
  CHECK(idOf(list.array[0].get("id")) == first);
  CHECK(list.array[0].get("animationStyleId")->get("assetRef")->get("key")->string == "slideIn");
  CHECK(list.array[0].get("timelineOffset")->number == doctest::Approx(250000));
  CHECK(e.motionIndex().node(kRect)->presets.size() == 2);  // the old clip replaced, not added to
  CHECK(e.command(CommandId::MOTION_APPLY_STYLE, args("{\"nodes\":[\"1:3\"],\"style\":\"fadeIn\",\"binding\":\"" + first +
                                                      R"(","presets":[{"preset":"opacity","durationUs":500000,"output":)" + out + "}]}")) == E_INVALID);
}
