// Figma Motion, round 8i (docs/motion.md §4.7, §4.9, §4.10, §6.7): easings bound to EASING variables (a keyframe's
// EASING_DATA alias; a clip's Easing) and a clip's Delay / Duration bound to TIMING ones, played at the variables'
// values in the animated layer's modes; a text's own stagger (344); keyframes pasted by the engine (349); X / Y tracks
// combined into XY and split back (350–351); the Motion icon before an animated top-level frame's name.
#include <algorithm>
#include <array>
#include <cmath>

#include "Helpers.h"
#include "TextHelpers.h"
#include "doctest.h"
#include "editor/Editor.h"
#include "motion/Evaluate.h"
#include "text/Fonts.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid kRoot{1, 1}, kRect{1, 2}, kOther{1, 3}, kStill{1, 4};

void load(Editor& e) {
  std::vector<NodeChange> nodes = baseChanges();
  nodes.push_back(make(kRoot, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "Root"));
  nodes.push_back(make(kRect, NodeType::ROUNDED_RECTANGLE, kRoot, "!", {20, 30, 100, 50}, "Rect"));
  nodes.push_back(make(kOther, NodeType::ROUNDED_RECTANGLE, kRoot, "\"", {200, 30, 50, 50}, "Other"));
  nodes.push_back(make(kStill, NodeType::FRAME, kPage, "\"", {600, 0, 200, 200}, "Still"));
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

// A collection "Motion" with modes Calm / Lively and one variable of `type` holding `calm` / `lively`; {variable, set, lively}.
std::array<Guid, 3> variable(Editor& e, const std::string& type, const std::string& calm, const std::string& lively) {
  REQUIRE(e.command(CommandId::CREATE_VARIABLE_COLLECTION, args(R"({"name":"Motion"})")) == OK);
  Guid set = e.lastCreated()[0], first = e.lastCreated()[1];
  REQUIRE(e.command(CommandId::ADD_VARIABLE_MODE, args("{\"collection\":" + q(set) + ",\"name\":\"Lively\"}")) == OK);
  Guid second = e.lastCreated()[0];
  REQUIRE(e.command(CommandId::CREATE_VARIABLE, args("{\"collection\":" + q(set) + ",\"type\":\"" + type + "\",\"name\":\"V\",\"value\":" + calm + "}")) == OK);
  Guid v = e.lastCreated()[0];
  REQUIRE(e.command(CommandId::SET_VARIABLE_VALUE, args("{\"variable\":" + q(v) + ",\"mode\":" + q(second) + ",\"value\":" + lively + "}")) == OK);
  (void)first;
  return {v, set, second};
}

const motion::Keyframe* keyframe(Editor& e, Guid node, VariableField f, size_t i) {
  const motion::AnimatedNode* an = e.motionIndex().node(node);
  if (!an) return nullptr;
  for (const motion::Binding& b : an->bindings)
    if (b.slot.kind == motion::Slot::Kind::NODE && b.slot.field == f)
      for (const motion::Param& p : b.params)
        if (const motion::Track* t = e.motionIndex().track(p.track); t && i < t->keyframes.size()) return &t->keyframes[i];
  return nullptr;
}

// Inter for the text case, unloaded after (as the other text suites do).
struct Fonts {
  Fonts() {
    auto& fonts = text::FontRegistry::get();
    int32_t upright = addFontFile(interPath());
    for (const char* style : {"Regular", "Medium", "Semi Bold", "Bold"}) fonts.bind("Inter", style, upright);
    fonts.takeRequests();
  }
  ~Fonts() { text::FontRegistry::get().reset(); }
};

}  // namespace

TEST_CASE("motion variables: a keyframe eased by an EASING variable plays its value in the layer's mode; unbound by a value") {
  Editor e;
  load(e);
  const Document& doc = e.document();
  auto [easing, set, lively] = variable(e, "EASING", R"({"type":"LINEAR"})", R"({"type":"EASE_IN"})");
  CHECK(doc.get(easing)->props.asset().variableResolvedType == VariableResolvedType::EASING);
  e.setSelection({kRect});
  e.setMotion(on(0));
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"field":{"type":"PROPERTY","name":"OPACITY"},"value":{"type":"FLOAT","value":0}})")) == OK);
  e.setMotion(on(1000000));
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"field":{"type":"PROPERTY","name":"OPACITY"},"value":{"type":"FLOAT","value":1}})")) == OK);
  Guid k1 = e.lastCreated()[0];
  REQUIRE(e.command(CommandId::MOTION_SET_EASING, args("{\"ids\":[" + q(k1) + "],\"easing\":{\"variable\":" + q(easing) + "}}")) == OK);
  CHECK(e.undoStack().undoLabel() == "Change easing");
  // The KEYFRAME holds the alias in its own consumption map (EASING_DATA).
  const NodeProps& kp = doc.get(k1)->props;
  REQUIRE(kp.parameterConsumptionMap.size() == 1);
  CHECK(kp.parameterConsumptionMap[0].field == VariableField::EASING_DATA);
  CHECK(kp.parameterConsumptionMap[0].data.kind == VariableData::Kind::ALIAS);
  // Calm (the default mode): linear — halfway is half.
  const Node* r = doc.get(kRect);
  e.setMotion(on(500000));
  CHECK(r->props.opacity == doctest::Approx(0.5));
  // The page switched to Lively: the same keyframe eases in.
  REQUIRE(e.command(CommandId::SET_VARIABLE_MODE, args("{\"page\":\"0:1\",\"collection\":" + q(set) + ",\"mode\":" + q(lively) + "}")) == OK);
  e.setMotion(on(500000));
  CHECK(r->props.opacity == doctest::Approx(motion::cubicBezier(0.42, 0, 1, 1, 0.5)));
  // The timeline names the variable beside the resolved easing.
  json::Writer w;
  e.writeMotionTimeline(w, kNoGuid);
  json::Value tl = parsed(w.take());
  const json::Value& k = tl.get("layers")->array[0].get("tracks")->array[0].get("keyframes")->array[1];
  CHECK(k.get("easingVariable")->string == easing.toString());
  CHECK(k.get("easing")->get("type")->string == "EASE_IN");
  // A value unbinds it.
  REQUIRE(e.command(CommandId::MOTION_SET_EASING, args("{\"ids\":[" + q(k1) + "],\"easing\":{\"type\":\"LINEAR\"}}")) == OK);
  CHECK(doc.get(k1)->props.parameterConsumptionMap.empty());
  e.setMotion(on(500000));
  CHECK(r->props.opacity == doctest::Approx(0.5));
  CHECK(keyframe(e, kRect, VariableField::OPACITY, 1)->easingVar.kind == VariableData::Kind::NONE);
}

TEST_CASE("motion variables: a clip's Delay and Duration bound to TIMING variables, its Easing to an EASING one") {
  Editor e;
  load(e);
  const Document& doc = e.document();
  auto [delay, set, lively] = variable(e, "TIMING", "200", "400");
  REQUIRE(e.command(CommandId::CREATE_VARIABLE, args("{\"collection\":" + q(set) + R"(,"type":"TIMING","name":"D","value":1000})")) == OK);
  Guid duration = e.lastCreated()[0];
  REQUIRE(e.command(CommandId::CREATE_VARIABLE, args("{\"collection\":" + q(set) + R"(,"type":"EASING","name":"E","value":{"type":"LINEAR"}})")) == OK);
  Guid easing = e.lastCreated()[0];
  e.setSelection({kRect});
  e.setMotion(on(0));
  // An Opacity clip: 0 → 1 over its 500 ms (the runtime's output), eased out.
  std::string add = R"({"preset":"opacity","startUs":0,"durationUs":500000,"easing":{"type":"EASE_OUT"},"output":{"tracks":[{"field":{"type":"PROPERTY","name":"OPACITY"},"operation":"SET","keyframes":[)"
                    R"({"timeUs":0,"value":{"type":"FLOAT","value":0},"easing":{"type":"EASE_OUT"}},{"timeUs":500000,"value":{"type":"FLOAT","value":1},"easing":{"type":"EASE_OUT"}}]}]}})";
  REQUIRE(e.command(CommandId::MOTION_ADD_ANIMATION, args(add)) == OK);
  Guid clip = e.lastCreated()[0];
  REQUIRE(e.command(CommandId::MOTION_SET_ANIMATION, args("{\"id\":" + q(clip) + ",\"variables\":{\"delay\":" + q(delay) + ",\"duration\":" + q(duration) +
                                                            ",\"easing\":" + q(easing) + "}}")) == OK);
  // Calm: starts at 200 ms, lasts 1000 ms, linear — the stored clip unchanged.
  const motion::Preset* pr = e.motionIndex().preset(clip);
  REQUIRE(pr);
  CHECK(pr->offsetUs == 200000);
  CHECK(pr->durationUs == 1000000);
  CHECK(pr->storedDurationUs == 500000);
  CHECK(pr->easing.type == motion::EasingType::LINEAR);
  const Node* r = doc.get(kRect);
  e.setMotion(on(700000));
  CHECK(r->props.opacity == doctest::Approx(0.5));
  // Lively: the delay is 400 ms.
  REQUIRE(e.command(CommandId::SET_VARIABLE_MODE, args("{\"page\":\"0:1\",\"collection\":" + q(set) + ",\"mode\":" + q(lively) + "}")) == OK);
  e.setMotion(on(900000));
  CHECK(r->props.opacity == doctest::Approx(0.5));
  // The timeline lists the bindings as the clip's `variables`, not as props.
  json::Writer w;
  e.writeMotionTimeline(w, kNoGuid);
  json::Value tl = parsed(w.take());
  const json::Value& c = tl.get("layers")->array[0].get("clips")->array[0];
  CHECK(c.get("variables")->get("delay")->string == delay.toString());
  CHECK(c.get("variables")->get("easing")->string == easing.toString());
  CHECK(c.get("props")->object.empty());
  CHECK(c.get("startUs")->number == 400000);
  // Props replaced keep the bindings; null unbinds one.
  REQUIRE(e.command(CommandId::MOTION_SET_ANIMATION, args("{\"id\":" + q(clip) + R"(,"props":{"0:7":1}})")) == OK);
  CHECK(e.motionIndex().preset(clip)->durationVar.kind == VariableData::Kind::ALIAS);
  REQUIRE(e.command(CommandId::MOTION_SET_ANIMATION, args("{\"id\":" + q(clip) + R"(,"variables":{"duration":null}})")) == OK);
  CHECK(e.motionIndex().preset(clip)->durationUs == 500000);
  CHECK(e.motionIndex().preset(clip)->delayVar.kind == VariableData::Kind::ALIAS);
}

TEST_CASE("motion edit: Paste keyframes puts a copy at the playhead on each layer's same fields, one undo step") {
  Editor e;
  load(e);
  const Document& doc = e.document();
  e.setMotion(on(1000000));
  std::string clip = R"({"nodes":["1:2","1:3"],"atUs":1000000,"clipboard":{"tracks":[{"field":{"type":"PROPERTY","name":"OPACITY"},"keyframes":[)"
                     R"({"dtUs":0,"value":{"type":"FLOAT","value":0},"easing":{"type":"LINEAR"}},{"dtUs":500000,"value":{"type":"FLOAT","value":1},"easing":{"type":"EASE_IN"}}]}]}})";
  REQUIRE(e.command(CommandId::MOTION_PASTE_KEYFRAMES, args(clip)) == OK);
  CHECK(e.undoStack().undoLabel() == "Paste keyframes");
  CHECK(e.lastCreated().size() == 4);
  for (Guid n : {kRect, kOther}) {
    const motion::Keyframe* a = keyframe(e, n, VariableField::OPACITY, 0);
    const motion::Keyframe* b = keyframe(e, n, VariableField::OPACITY, 1);
    REQUIRE(a);
    REQUIRE(b);
    CHECK(a->timeUs == 1000000);
    CHECK(b->timeUs == 1500000);
    CHECK(b->easing.type == motion::EasingType::EASE_IN);
  }
  e.setMotion(on(1250000));
  CHECK(doc.get(kOther)->props.opacity == doctest::Approx(motion::cubicBezier(0.42, 0, 1, 1, 0.5)));
  // One step: undo takes both layers' keyframes.
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(!e.motionIndex().node(kRect));
  CHECK(!e.motionIndex().node(kOther));
  // Nothing to paste onto: refused.
  CHECK(e.command(CommandId::MOTION_PASTE_KEYFRAMES, args(R"({"nodes":["1:1"],"clipboard":{"tracks":[]}})")) == E_INVALID);
}

TEST_CASE("motion edit: Combine tracks makes X and Y one XY track (times merged); Split tracks takes it apart again") {
  Editor e;
  load(e);
  const Document& doc = e.document();
  e.setSelection({kRect});
  e.setMotion(on(0));
  auto key = [&](const char* field, int64_t at, double value) {
    REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(std::string(R"({"field":{"type":"PROPERTY","name":")") + field + R"("},"timeUs":)" + std::to_string(at) +
                                                           R"(,"value":{"type":"FLOAT","value":)" + std::to_string(value) + R"(},"easing":{"type":"LINEAR"}})")) == OK);
  };
  key("TRANSLATION_X", 0, 0);
  key("TRANSLATION_X", 1000000, 100);
  key("TRANSLATION_Y", 500000, 40);
  e.setMotion(on(750000));
  Mat2x3 before = doc.get(kRect)->props.transform;
  REQUIRE(e.command(CommandId::MOTION_COMBINE_TRACKS, args(R"({"node":"1:2","kind":"POSITION"})")) == OK);
  CHECK(e.undoStack().undoLabel() == "Combine tracks");
  CHECK(!keyframe(e, kRect, VariableField::MOTION_TRANSLATION_X, 0));
  CHECK(!keyframe(e, kRect, VariableField::MOTION_TRANSLATION_Y, 0));
  // Keyframes at 0, 500 and 1000 ms, each the two tracks' values there.
  const motion::Keyframe* mid = keyframe(e, kRect, VariableField::MOTION_TRANSLATION_XY, 1);
  REQUIRE(mid);
  CHECK(mid->timeUs == 500000);
  CHECK(mid->value.v.x == doctest::Approx(50));
  CHECK(mid->value.v.y == doctest::Approx(40));
  CHECK(keyframe(e, kRect, VariableField::MOTION_TRANSLATION_XY, 2)->value.v.y == doctest::Approx(40));  // Y held after its one keyframe
  // The layer plays where it did at the keyframes (and linearly between them).
  e.setMotion(on(1000000));
  CHECK(doc.get(kRect)->props.transform.m02 == doctest::Approx(20 + 100));
  e.setMotion(on(750000));
  CHECK(doc.get(kRect)->props.transform.m02 == doctest::Approx(before.m02));
  // Split: X and Y tracks with the XY track's times.
  REQUIRE(e.command(CommandId::MOTION_SPLIT_TRACKS, args(R"({"node":"1:2","kind":"POSITION"})")) == OK);
  CHECK(e.undoStack().undoLabel() == "Split tracks");
  CHECK(!keyframe(e, kRect, VariableField::MOTION_TRANSLATION_XY, 0));
  REQUIRE(keyframe(e, kRect, VariableField::MOTION_TRANSLATION_Y, 2));
  CHECK(keyframe(e, kRect, VariableField::MOTION_TRANSLATION_X, 1)->value.f == doctest::Approx(50));
  CHECK(keyframe(e, kRect, VariableField::MOTION_TRANSLATION_Y, 0)->value.f == doctest::Approx(40));
  // Nothing to split or combine: refused.
  CHECK(e.command(CommandId::MOTION_SPLIT_TRACKS, args(R"({"node":"1:2","kind":"SCALE"})")) == E_INVALID);
  CHECK(e.command(CommandId::MOTION_COMBINE_TRACKS, args(R"({"node":"1:2","kind":"ROTATION"})")) == E_INVALID);
}

TEST_CASE("motion text: a text's own stagger plays its manual tracks per word; the frame titles wear the Motion icon") {
  Fonts fonts;
  const Guid kText{1, 9};
  std::vector<NodeChange> nodes = baseChanges();
  nodes.push_back(make(kRoot, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "Root"));
  nodes.push_back(make(kStill, NodeType::FRAME, kPage, "\"", {600, 0, 200, 200}, "Still"));
  NodeChange t = make(kText, NodeType::TEXT, kRoot, "!", {20, 100, 200, 30}, "Words");
  t.props.text().textData.characters = "Hi there you";
  t.props.text().fontSize = 24;
  t.props.text().textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
  nodes.push_back(t);
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kPage);
  e.setSelection({kText});
  e.setMotion(on(0));
  // Fade in by hand over 400 ms, then stagger by word, 200 ms apart.
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"field":{"type":"PROPERTY","name":"OPACITY"},"timeUs":0,"value":{"type":"FLOAT","value":0},"easing":{"type":"LINEAR"}})")) == OK);
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"field":{"type":"PROPERTY","name":"OPACITY"},"timeUs":400000,"value":{"type":"FLOAT","value":1},"easing":{"type":"LINEAR"}})")) == OK);
  REQUIRE(e.command(CommandId::MOTION_SET_TEXT_STAGGER, args(R"({"node":"1:9","enabled":true,"grouping":"WORD","delayMs":200,"order":"LEFT_RIGHT"})")) == OK);
  CHECK(e.undoStack().undoLabel() == "Edit text animation");
  const motion::AnimatedNode* an = e.motionIndex().node(kText);
  REQUIRE(an);
  CHECK(an->stagger.enabled);
  CHECK(an->stagger.stepUs == 200000);
  // At 300 ms: the first word three quarters in, the second a quarter, the third not yet; the text itself whole.
  e.setMotion(on(300000));
  const motion::TextElementPoses* poses = e.textElements(kText);
  REQUIRE(poses);
  REQUIRE(poses->alpha.size() == 3);
  CHECK(poses->alpha[0] == doctest::Approx(0.75));
  CHECK(poses->alpha[1] == doctest::Approx(0.25));
  CHECK(poses->alpha[2] == doctest::Approx(0));
  CHECK(e.document().get(kText)->props.opacity == doctest::Approx(1));
  // Turned off: the whole text fades together again.
  REQUIRE(e.command(CommandId::MOTION_SET_TEXT_STAGGER, args(R"({"node":"1:9","enabled":false})")) == OK);
  e.setMotion(on(300000));
  CHECK(!e.textElements(kText));
  CHECK(e.document().get(kText)->props.opacity == doctest::Approx(0.75));
  CHECK(e.command(CommandId::MOTION_SET_TEXT_STAGGER, args(R"({"node":"1:9","enabled":true,"grouping":"SYLLABLE"})")) == E_INVALID);
  CHECK(e.command(CommandId::MOTION_SET_TEXT_STAGGER, args(R"({"node":"1:1","enabled":true})")) == E_INVALID);
  // The animated frame's title wears the Motion icon, outside Motion mode too (the index follows the document); the
  // still one's doesn't.
  e.setMotion(motion::State{});
  e.tick(16);
  FrameTitle root, still;
  for (const FrameTitle& ft : e.titles()) (ft.id == kRoot ? root : still) = ft;
  REQUIRE(root.id == kRoot);
  REQUIRE(still.id == kStill);
  CHECK(root.icon == TitleIcon::Motion);
  CHECK(still.icon == TitleIcon::None);
  CHECK(e.overlay().motionTitles == std::vector<Guid>{kRoot});
}

TEST_CASE("motion styles: a custom animation style made from a layer's clips, updated, applied by its GUID") {
  Editor e;
  load(e);
  const Document& doc = e.document();
  e.setSelection({kRect});
  e.setMotion(on(0));
  auto clip = [&](const char* preset, int64_t start, int64_t length) {
    REQUIRE(e.command(CommandId::MOTION_ADD_ANIMATION, args(std::string(R"({"nodes":["1:2"],"preset":")") + preset + R"(","props":{"0:7":40},"startUs":)" +
                                                            std::to_string(start) + R"(,"durationUs":)" + std::to_string(length) + "}")) == OK);
    return e.lastCreated()[0];
  };
  clip("opacity", 300000, 500000);
  clip("scale", 500000, 400000);
  REQUIRE(e.command(CommandId::MOTION_APPLY_STYLE, args(R"({"create":{"name":"Pop","from":"1:2"}})")) == OK);
  CHECK(e.undoStack().undoLabel() == "Create animation style");
  Guid style = e.lastCreated()[0];
  const Node* sn = doc.get(style);
  REQUIRE(sn);
  CHECK(sn->props.asset().styleType == StyleType::ANIMATION);
  CHECK(sn->props.name == "Pop");
  // Its content: a template per clip, timed from the earliest one, its props kept, no tracks.
  REQUIRE(doc.children(style).size() == 2);
  motion::Preset a, b;
  REQUIRE(motion::decodePreset(doc.get(doc.children(style)[0])->props, doc.children(style)[0], a));
  REQUIRE(motion::decodePreset(doc.get(doc.children(style)[1])->props, doc.children(style)[1], b));
  CHECK(a.key == "opacity");
  CHECK(a.offsetUs == 0);
  CHECK(b.offsetUs == 200000);
  CHECK(b.durationUs == 400000);
  CHECK(doc.children(doc.children(style)[0]).empty());
  CHECK(doc.get(doc.children(style)[0])->props.comp().componentPropAssignments.size() == 1);
  json::Value content = motion::extraJson(sn->props, "styleAnimations");
  REQUIRE(content.isArray());
  CHECK(content.array.size() == 2);
  // Updated from a layer with one clip: its content replaced.
  REQUIRE(e.command(CommandId::MOTION_REMOVE_ANIMATIONS, args("{\"ids\":[" + q(e.motionIndex().node(kRect)->presets[1]) + "]}")) == OK);
  REQUIRE(e.command(CommandId::MOTION_APPLY_STYLE, args("{\"create\":{\"from\":\"1:2\",\"style\":" + q(style) + "}}")) == OK);
  CHECK(e.undoStack().undoLabel() == "Update animation style");
  CHECK(doc.children(style).size() == 1);
  // Applied by its GUID on another layer: the entry names the style node, the timeline's clip its GUID.
  std::string out = R"({"tracks":[]})";
  REQUIRE(e.command(CommandId::MOTION_APPLY_STYLE, args("{\"nodes\":[\"1:3\"],\"style\":" + q(style) + R"(,"startUs":100000,"presets":[{"preset":"opacity","name":"Opacity","offsetUs":0,"durationUs":500000,"output":)" + out + "}]}")) == OK);
  json::Value entries = motion::extraJson(doc.get(kOther)->props, "styleIdsForAnimation");
  REQUIRE(entries.isArray());
  CHECK(entries.array[0].get("animationStyleId")->get("guid"));
  json::Writer w;
  e.writeMotionTimeline(w, kNoGuid);
  json::Value tl = parsed(w.take());
  bool found = false;
  for (const json::Value& l : tl.get("layers")->array)
    if (l.get("node")->string == "1:3") found = l.get("clips")->array[0].get("style")->get("key")->string == style.toString();
  CHECK(found);
  // Not a custom style's node: refused; a layer whose clips came from a style makes one too.
  CHECK(e.command(CommandId::MOTION_APPLY_STYLE, args(R"({"create":{"from":"1:2","style":"1:1"}})")) == E_INVALID);
  CHECK(e.command(CommandId::MOTION_APPLY_STYLE, args(R"({"create":{"from":"1:3"}})")) == OK);
}
