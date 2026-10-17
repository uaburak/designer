// Figma Motion, round 8h (docs/motion.md §4.6): animation presets — ANIMATION_PRESET_INSTANCE clips listed in their
// layer's `animationPresets`, their materialised tracks (the TypeScript runtime's output) bound through ANIMATION_PRESET
// parameters and played in the clip's own time, folded with the manual tracks — the commands that add, edit and
// remove them and apply or detach a composite style, each one undo step, their place in the reads, their copies with
// a duplicated or pasted layer, and text stagger (§4.10): a text preset's tracks played by the text's elements in turn.
#include <algorithm>
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

size_t countType(const Document& d, NodeType t) {
  size_t n = 0;
  d.forEach([&](const Node& node) { n += node.props.type == t ? 1 : 0; });
  return n;
}

// The runtime's Fade in (src/shared/motion/presets): OPACITY × 0 → 1 over the clip, Ease out on both keyframes.
const char* kFadeIn = R"({"tracks":[{"field":{"type":"PROPERTY","name":"OPACITY"},"operation":"SCALE","keyframes":[)"
                      R"({"timeUs":0,"value":{"type":"FLOAT","value":0},"easing":{"type":"EASE_OUT"}},)"
                      R"({"timeUs":500000,"value":{"type":"FLOAT","value":1},"easing":{"type":"EASE_OUT"}}]}]})";
// Slide in from 200 px to the right (OFFSET on TRANSLATION_XY), linear.
const char* kSlideIn = R"({"tracks":[{"field":{"type":"PROPERTY","name":"TRANSLATION_XY"},"operation":"OFFSET","keyframes":[)"
                       R"({"timeUs":0,"value":{"type":"VECTOR","value":{"x":200,"y":0}},"easing":{"type":"LINEAR"}},)"
                       R"({"timeUs":500000,"value":{"type":"VECTOR","value":{"x":0,"y":0}},"easing":{"type":"LINEAR"}}]}]})";

std::string addOpacity(int64_t startUs) {
  return R"({"nodes":["1:2"],"preset":"opacity","name":"Opacity","props":{"0:7":0,"0:8":"fadeIn"},"startUs":)" + std::to_string(startUs) +
         R"(,"durationUs":500000,"easing":{"type":"EASE_OUT"},"output":)" + kFadeIn + "}";
}

// Inter for the text cases, unloaded after (as the other text suites do).
struct Fonts {
  Fonts() {
    auto& fonts = text::FontRegistry::get();
    int32_t upright = addFontFile(interPath());
    for (const char* style : {"Regular", "Medium", "Semi Bold", "Bold"}) fonts.bind("Inter", style, upright);
    fonts.takeRequests();
  }
  ~Fonts() { text::FontRegistry::get().reset(); }
};

// The layer's KEYFRAME expression parameters on a field.
std::vector<motion::Param> paramsOf(Editor& e, Guid node, VariableField f) {
  const motion::AnimatedNode* an = e.motionIndex().node(node);
  if (an)
    for (const motion::Binding& b : an->bindings)
      if (b.slot.kind == motion::Slot::Kind::NODE && b.slot.field == f) return b.params;
  return {};
}

}  // namespace

TEST_CASE("motion presets: Add animation makes the clip and its tracks; they play in the clip's time; one undo step") {
  Editor e;
  load(e);
  const Document& doc = e.document();
  e.setSelection({kRect});
  e.setMotion(on(200000));
  REQUIRE(e.command(CommandId::MOTION_ADD_ANIMATION, args(addOpacity(200000))) == OK);
  CHECK(e.undoStack().undoLabel() == "Add animation");
  REQUIRE(e.lastCreated().size() == 1);
  Guid clip = e.lastCreated()[0];
  const Node* inst = doc.get(clip);
  REQUIRE(inst);
  CHECK(inst->props.type == NodeType::ANIMATION_PRESET_INSTANCE);
  CHECK(inst->props.name == "Opacity");
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 1);
  CHECK(doc.children(clip).size() == 1);  // the track is the clip's
  const motion::Preset* pr = e.motionIndex().preset(clip);
  REQUIRE(pr);
  CHECK(pr->key == "opacity");
  CHECK(pr->offsetUs == 200000);
  CHECK(pr->durationUs == 500000);
  CHECK(pr->easing.type == motion::EasingType::OUT_CUBIC);
  // The layer lists it and binds OPACITY through an ANIMATION_PRESET parameter.
  REQUIRE(motion::decodePresetList(doc.get(kRect)->props) == std::vector<Guid>{clip});
  std::vector<motion::Param> params = paramsOf(e, kRect, VariableField::OPACITY);
  REQUIRE(params.size() == 1);
  CHECK(params[0].kind == motion::Param::Kind::ANIMATION_PRESET);
  CHECK(params[0].preset == clip);
  CHECK(params[0].timelineDef == kRoot);
  CHECK(params[0].offsetUs == 200000);
  // Played in the clip's time: invisible before it (the first value holds back), eased out within, whole after.
  const Node* r = doc.get(kRect);
  e.setMotion(on(0));
  CHECK(r->props.opacity == doctest::Approx(0));
  e.setMotion(on(450000));
  CHECK(r->props.opacity == doctest::Approx(motion::cubicBezier(0, 0, 0.58, 1, 0.5)));
  e.setMotion(on(900000));
  CHECK(r->props.opacity == doctest::Approx(1));
  // The timeline lists the clip (not as a track) with its props; no diamond for the field.
  json::Writer w;
  e.writeMotionTimeline(w, kNoGuid);
  json::Value tl = parsed(w.take());
  REQUIRE(tl.get("layers")->array.size() == 1);
  const json::Value& layer = tl.get("layers")->array[0];
  CHECK(layer.get("tracks")->array.empty());
  REQUIRE(layer.get("clips")->array.size() == 1);
  const json::Value& c = layer.get("clips")->array[0];
  CHECK(c.get("id")->string == clip.toString());
  CHECK(c.get("preset")->string == "opacity");
  CHECK(c.get("startUs")->number == 200000);
  CHECK(c.get("durationUs")->number == 500000);
  CHECK(c.get("easing")->get("type")->string == "EASE_OUT");
  CHECK(c.get("props")->get("0:8")->string == "fadeIn");
  CHECK(c.get("props")->get("0:7")->number == 0);
  CHECK(layer.get("startUs")->number == 200000);
  CHECK(layer.get("endUs")->number == 700000);
  json::Writer fs;
  e.writeMotionFieldStates(fs, {kRect});
  CHECK(parsed(fs.take()).get("1:2")->object.empty());
  // One step: undo takes the clip, its track and the binding.
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(countType(doc, NodeType::ANIMATION_PRESET_INSTANCE) == 0);
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 0);
  CHECK(doc.get(kRect)->props.parameterConsumptionMap.empty());
  CHECK(doc.get(kRect)->props.opacity == doctest::Approx(1));
}

TEST_CASE("motion presets: preset tracks fold with the manual track over the base (OFFSET, SCALE, the manual SET last)") {
  Editor e;
  load(e);
  const Document& doc = e.document();
  const Node* r = doc.get(kRect);
  e.setSelection({kRect});
  e.setMotion(on(0));
  // Slide in on TRANSLATION_XY: at 250 ms the layer is 100 px right of where it rests.
  REQUIRE(e.command(CommandId::MOTION_ADD_ANIMATION, args(std::string(R"({"preset":"position","startUs":0,"output":)") + kSlideIn + "}")) == OK);
  Vec2 rest{20, 30};
  e.setMotion(on(250000));
  CHECK(r->props.transform.m02 == doctest::Approx(rest.x + 100));
  CHECK(r->props.transform.m12 == doctest::Approx(rest.y));
  // A Scale preset (SCALE on SCALE_XY, 0.5 → 1) composes about the anchor (the centre).
  const char* scaleOut = R"({"preset":"scale","startUs":0,"output":{"tracks":[{"field":{"type":"PROPERTY","name":"SCALE_XY"},"operation":"SCALE","keyframes":[)"
                         R"({"timeUs":0,"value":{"type":"FLOAT","value":0.5},"easing":{"type":"LINEAR"}},{"timeUs":500000,"value":{"type":"FLOAT","value":1},"easing":{"type":"LINEAR"}}]}]}})";
  REQUIRE(e.command(CommandId::MOTION_ADD_ANIMATION, args(scaleOut)) == OK);
  e.setMotion(on(0));
  CHECK(r->props.transform.m00 == doctest::Approx(0.5));
  CHECK(r->props.transform.m02 == doctest::Approx(rest.x + 200 + 25));  // 200 px away, shrunk about its centre
  // A manual keyframe on the position comes after the preset's parameter and sets the value outright.
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"field":{"type":"PROPERTY","name":"TRANSLATION_XY"},"value":{"type":"VECTOR","value":{"x":-10,"y":5}}})")) == OK);
  std::vector<motion::Param> params = paramsOf(e, kRect, VariableField::MOTION_TRANSLATION_XY);
  REQUIRE(params.size() == 2);
  CHECK(params[0].kind == motion::Param::Kind::ANIMATION_PRESET);
  CHECK(params[1].kind == motion::Param::Kind::MANUAL);
  e.setMotion(on(250000));
  CHECK(r->props.transform.m02 == doctest::Approx(rest.x - 10 + 50 * (1 - 0.75)));
  CHECK(r->props.transform.m12 == doctest::Approx(rest.y + 5 + 25 * (1 - 0.75)));
  // The resolved model gives the preset's keyframes in root time, the manual track's as they are.
  json::Writer w;
  e.writeMotionResolved(w, kRoot);
  json::Value res = parsed(w.take());
  REQUIRE(res.get("layers")->array.size() == 1);
  CHECK(res.get("layers")->array[0].get("properties")->array.size() == 3);
}

TEST_CASE("motion presets: Edit animation moves, stretches, re-eases, turns off and re-runs a clip; Remove animation takes it all") {
  Editor e;
  load(e);
  const Document& doc = e.document();
  const Node* r = doc.get(kRect);
  e.setSelection({kRect});
  e.setMotion(on(0));
  REQUIRE(e.command(CommandId::MOTION_ADD_ANIMATION, args(addOpacity(0))) == OK);
  Guid clip = e.lastCreated()[0];
  std::string id = clip.toString();
  // Dragged on the timeline: "Move animation"; the fade now starts at 1 s.
  REQUIRE(e.command(CommandId::MOTION_SET_ANIMATION, args(R"({"id":")" + id + R"(","startUs":1000000})")) == OK);
  CHECK(e.undoStack().undoLabel() == "Move animation");
  e.setMotion(on(900000));
  CHECK(r->props.opacity == doctest::Approx(0));
  e.setMotion(on(1500000));
  CHECK(r->props.opacity == doctest::Approx(1));
  // Its handle: "Change animation duration"; the tracks stretch with it (the tween spans the clip).
  REQUIRE(e.command(CommandId::MOTION_SET_ANIMATION, args(R"({"id":")" + id + R"(","durationUs":1000000})")) == OK);
  CHECK(e.undoStack().undoLabel() == "Change animation duration");
  const motion::Track* t = e.motionIndex().track(doc.children(clip)[0]);
  REQUIRE(t);
  CHECK(t->keyframes.back().timeUs == 1000000);
  e.setMotion(on(1500000));
  CHECK(r->props.opacity == doctest::Approx(motion::cubicBezier(0, 0, 0.58, 1, 0.5)));
  // A new easing goes on its keyframes too.
  REQUIRE(e.command(CommandId::MOTION_SET_EASING, args(R"({"ids":[")" + id + R"("],"easing":{"type":"LINEAR"}})")) == OK);
  CHECK(r->props.opacity == doctest::Approx(0.5));
  CHECK(e.motionIndex().preset(clip)->easing.type == motion::EasingType::LINEAR);
  // Turned off: the layer rests.
  REQUIRE(e.command(CommandId::MOTION_SET_ANIMATION, args(R"({"id":")" + id + R"(","disabled":true})")) == OK);
  CHECK(e.undoStack().undoLabel() == "Edit animation");
  CHECK(r->props.opacity == doctest::Approx(1));
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(r->props.opacity == doctest::Approx(0.5));
  // Re-run (a prop changed: Fade out): the old track goes, the new output takes its place, props replaced.
  const char* fadeOut = R"({"tracks":[{"field":{"type":"PROPERTY","name":"OPACITY"},"operation":"SCALE","keyframes":[)"
                        R"({"timeUs":0,"value":{"type":"FLOAT","value":1},"easing":{"type":"LINEAR"}},{"timeUs":1000000,"value":{"type":"FLOAT","value":0},"easing":{"type":"LINEAR"}}]}]})";
  Guid oldTrack = doc.children(clip)[0];
  REQUIRE(e.command(CommandId::MOTION_SET_ANIMATION, args(R"({"id":")" + id + R"(","props":{"0:8":"fadeOut"},"output":)" + fadeOut + "}")) == OK);
  CHECK(!doc.has(oldTrack));
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 1);
  CHECK(paramsOf(e, kRect, VariableField::OPACITY).size() == 1);
  e.setMotion(on(1750000));
  CHECK(r->props.opacity == doctest::Approx(0.25));
  REQUIRE(doc.get(clip)->props.comp().componentPropAssignments.size() == 1);
  CHECK(doc.get(clip)->props.comp().componentPropAssignments[0].value.textValue.characters == "fadeOut");
  // Remove animation: the clip, its track, the binding and the list entry go in one step; the base is back.
  REQUIRE(e.command(CommandId::MOTION_REMOVE_ANIMATIONS, args(R"({"ids":[")" + id + R"("]})")) == OK);
  CHECK(e.undoStack().undoLabel() == "Remove animation");
  CHECK(countType(doc, NodeType::ANIMATION_PRESET_INSTANCE) == 0);
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 0);
  CHECK(r->props.parameterConsumptionMap.empty());
  CHECK(!r->props.extra.count("animationPresets"));
  CHECK(r->props.opacity == doctest::Approx(1));
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(countType(doc, NodeType::ANIMATION_PRESET_INSTANCE) == 1);
  CHECK(r->props.opacity == doctest::Approx(0.25));
}

TEST_CASE("motion presets: a preset's output collapses duplicate positions to the last one") {
  Editor e;
  load(e);
  e.setSelection({kRect});
  e.setMotion(on(0));
  const char* dup = R"({"preset":"opacity","startUs":0,"output":{"tracks":[{"field":{"type":"PROPERTY","name":"OPACITY"},"operation":"SCALE","keyframes":[)"
                    R"({"timeUs":0,"value":{"type":"FLOAT","value":0.2}},{"timeUs":0,"value":{"type":"FLOAT","value":0.4}},{"timeUs":500000,"value":{"type":"FLOAT","value":1}}]}]}})";
  REQUIRE(e.command(CommandId::MOTION_ADD_ANIMATION, args(dup)) == OK);
  Guid clip = e.lastCreated()[0];
  const motion::Track* t = e.motionIndex().track(e.document().children(clip)[0]);
  REQUIRE(t);
  REQUIRE(t->keyframes.size() == 2);
  CHECK(t->keyframes[0].value.f == doctest::Approx(0.4));  // a multiplier: never converted
  CHECK(e.document().get(kRect)->props.opacity == doctest::Approx(0.4));
}

TEST_CASE("motion presets: Apply animation style stacks its presets under one style entry; detach and remove keep it honest") {
  Editor e;
  load(e);
  const Document& doc = e.document();
  e.setSelection({kRect, kOther});
  e.setMotion(on(100000));
  std::string style = std::string(R"({"style":"slideIn","presets":[)") +
                      R"({"preset":"position","name":"Position","props":{},"offsetUs":0,"durationUs":500000,"easing":{"type":"EASE_OUT"},"output":)" + kSlideIn + "}," +
                      R"({"preset":"opacity","name":"Opacity","props":{},"offsetUs":100000,"durationUs":500000,"easing":{"type":"EASE_OUT"},"output":)" + kFadeIn + "}]}";
  REQUIRE(e.command(CommandId::MOTION_APPLY_STYLE, args(style)) == OK);
  CHECK(e.undoStack().undoLabel() == "Apply animation style");
  CHECK(e.lastCreated().size() == 4);  // two presets on each layer
  CHECK(countType(doc, NodeType::ANIMATION_PRESET_INSTANCE) == 4);
  json::Value styles = motion::extraJson(doc.get(kRect)->props, "styleIdsForAnimation");
  REQUIRE(styles.isArray());
  REQUIRE(styles.array.size() == 1);
  CHECK(styles.array[0].get("animationStyleId")->get("assetRef")->get("key")->string == "slideIn");
  CHECK(styles.array[0].get("timelineOffset")->number == 100000);
  CHECK(styles.array[0].get("generatedAnimationPresets")->array.size() == 2);
  // The second preset starts at the style's start + its offset.
  std::vector<Guid> presets = motion::decodePresetList(doc.get(kRect)->props);
  REQUIRE(presets.size() == 2);
  CHECK(e.motionIndex().preset(presets[0])->offsetUs == 100000);
  CHECK(e.motionIndex().preset(presets[1])->offsetUs == 200000);
  // The timeline's clips name the style (the rectangle's row: the other layer is above it).
  json::Writer w;
  e.writeMotionTimeline(w, kRoot);
  json::Value tl = parsed(w.take());
  REQUIRE(tl.get("layers")->array.size() == 2);
  CHECK(tl.get("layers")->array[1].get("node")->string == "1:2");
  const json::Value& clip0 = tl.get("layers")->array[1].get("clips")->array[0];
  CHECK(clip0.get("style")->get("key")->string == "slideIn");
  std::string binding = clip0.get("style")->get("id")->string;
  // Removing one preset leaves the entry with the other; removing it too drops the entry.
  REQUIRE(e.command(CommandId::MOTION_REMOVE_ANIMATIONS, args(R"({"ids":[")" + presets[0].toString() + R"("]})")) == OK);
  styles = motion::extraJson(doc.get(kRect)->props, "styleIdsForAnimation");
  REQUIRE(styles.array.size() == 1);
  CHECK(styles.array[0].get("generatedAnimationPresets")->array.size() == 1);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  // Detach: the entry goes (on that layer), the presets stay.
  REQUIRE(e.command(CommandId::MOTION_APPLY_STYLE, args(R"({"detach":")" + binding + R"("})")) == OK);
  CHECK(e.undoStack().undoLabel() == "Detach animation style");
  CHECK(!doc.get(kRect)->props.extra.count("styleIdsForAnimation"));
  CHECK(doc.get(kOther)->props.extra.count("styleIdsForAnimation"));
  CHECK(countType(doc, NodeType::ANIMATION_PRESET_INSTANCE) == 4);
}

TEST_CASE("motion presets: the layer bar moves and stretches its clips; duplicate and paste copy them; delete removes them") {
  Editor e;
  load(e);
  const Document& doc = e.document();
  e.setSelection({kRect});
  e.setMotion(on(0));
  REQUIRE(e.command(CommandId::MOTION_ADD_ANIMATION, args(addOpacity(0))) == OK);
  Guid clip = e.lastCreated()[0];
  // The layer bar dragged by 300 ms, then scaled ×2 about 0.
  REQUIRE(e.command(CommandId::MOTION_RETIME_LAYER, args(R"({"node":"1:2","deltaUs":300000})")) == OK);
  CHECK(e.motionIndex().preset(clip)->offsetUs == 300000);
  REQUIRE(e.command(CommandId::MOTION_RETIME_LAYER, args(R"({"node":"1:2","scale":{"factor":2,"pivotUs":0}})")) == OK);
  CHECK(e.motionIndex().preset(clip)->offsetUs == 600000);
  CHECK(e.motionIndex().preset(clip)->durationUs == 1000000);
  CHECK(e.motionIndex().track(doc.children(clip)[0])->keyframes.back().timeUs == 1000000);
  // Duplicate: the copy has a clip of its own, with its own track, bound to it.
  REQUIRE(e.command(CommandId::DUPLICATE) == OK);
  Guid copy = e.selection()[0];
  std::vector<Guid> copied = motion::decodePresetList(doc.get(copy)->props);
  REQUIRE(copied.size() == 1);
  CHECK(copied[0] != clip);
  CHECK(countType(doc, NodeType::ANIMATION_PRESET_INSTANCE) == 2);
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 2);
  std::vector<motion::Param> params = paramsOf(e, copy, VariableField::OPACITY);
  REQUIRE(params.size() == 1);
  CHECK(params[0].preset == copied[0]);
  CHECK(params[0].track == doc.children(copied[0])[0]);
  CHECK(params[0].offsetUs == 600000);
  // Deleting the copy takes its clip and track (the original's stay).
  REQUIRE(e.command(CommandId::DELETE) == OK);
  CHECK(countType(doc, NodeType::ANIMATION_PRESET_INSTANCE) == 1);
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 1);
  CHECK(doc.has(clip));
  // Cut and paste: the clip comes back from the clipboard.
  e.setSelection({kRect});
  Clipboard cb;
  REQUIRE(e.copySelection(cb, true));
  REQUIRE(e.command(CommandId::DELETE) == OK);
  CHECK(countType(doc, NodeType::ANIMATION_PRESET_INSTANCE) == 0);
  e.setSelection({kRoot});
  REQUIRE(e.paste(cb, true) == 1);
  Guid pasted = e.selection()[0];
  std::vector<Guid> back = motion::decodePresetList(doc.get(pasted)->props);
  REQUIRE(back.size() == 1);
  CHECK(e.motionIndex().preset(back[0])->durationUs == 1000000);
  CHECK(paramsOf(e, pasted, VariableField::OPACITY).size() == 1);
  e.setMotion(on(1100000));
  CHECK(doc.get(pasted)->props.opacity == doctest::Approx(motion::cubicBezier(0, 0, 0.58, 1, 0.5)));
}

TEST_CASE("motion presets: text stagger groups a text's glyphs and ranks its elements by the order") {
  Fonts fonts;
  const Guid kText{1, 9};
  std::vector<NodeChange> nodes = baseChanges();
  nodes.push_back(make(kRoot, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "Root"));
  NodeChange t = make(kText, NodeType::TEXT, kRoot, "!", {20, 100, 200, 30}, "Words");
  t.props.text().textData.characters = "Hi there you";
  t.props.text().fontSize = 24;
  t.props.text().textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
  nodes.push_back(t);
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kPage);
  const text::TextLayout* L = e.textLayout(kText);
  REQUIRE(L);
  CHECK(motion::groupElements(*L, motion::Grouping::CHARACTER).boxes.size() == 12);
  CHECK(motion::groupElements(*L, motion::Grouping::CHARACTER_NO_WHITESPACE).boxes.size() == 10);
  motion::TextElements words = motion::groupElements(*L, motion::Grouping::WORD);
  REQUIRE(words.boxes.size() == 3);
  CHECK(words.boxes[0].x < words.boxes[1].x);
  CHECK(words.elementOf[2] == -1);  // the space between "Hi" and "there"
  CHECK(motion::groupElements(*L, motion::Grouping::LINE).boxes.size() == 1);
  CHECK(motion::staggerRanks(5, motion::StaggerOrder::CENTER_OUT, kText) == std::vector<uint32_t>{2, 1, 0, 1, 2});
  CHECK(motion::staggerRanks(3, motion::StaggerOrder::RIGHT_LEFT, kText) == std::vector<uint32_t>{2, 1, 0});
  std::vector<uint32_t> shuffled = motion::staggerRanks(6, motion::StaggerOrder::RANDOM, kText);
  std::vector<uint32_t> sorted = shuffled;
  std::sort(sorted.begin(), sorted.end());
  CHECK(sorted == std::vector<uint32_t>{0, 1, 2, 3, 4, 5});
  CHECK(shuffled == motion::staggerRanks(6, motion::StaggerOrder::RANDOM, kText));  // the same text, the same shuffle
  int64_t g = 0, step = 0;
  motion::staggerTiming(900000, 3, 0.5, g, step);
  CHECK(g == 450000);
  CHECK(step == 225000);
}

TEST_CASE("motion presets: a Text stagger clip plays its tracks per word, one after another; the text's own box stays") {
  Fonts fonts;
  const Guid kText{1, 9};
  std::vector<NodeChange> nodes = baseChanges();
  nodes.push_back(make(kRoot, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "Root"));
  NodeChange t = make(kText, NodeType::TEXT, kRoot, "!", {20, 100, 200, 30}, "Words");
  t.props.text().textData.characters = "Hi there you";
  t.props.text().fontSize = 24;
  t.props.text().textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
  nodes.push_back(t);
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kPage);
  const Document& doc = e.document();
  e.setSelection({kText});
  e.setMotion(on(0));
  // Rise 40 px and fade in, per word, half overlapping, over 900 ms: each word 450 ms, 225 ms apart.
  std::string add = R"({"preset":"textStagger","durationUs":900000,"output":{"tracks":[)"
                    R"({"field":{"type":"PROPERTY","name":"TRANSLATION_XY"},"operation":"OFFSET","keyframes":[{"timeUs":0,"value":{"type":"VECTOR","value":{"x":0,"y":40}},"easing":{"type":"LINEAR"}},{"timeUs":900000,"value":{"type":"VECTOR","value":{"x":0,"y":0}},"easing":{"type":"LINEAR"}}]},)"
                    R"({"field":{"type":"PROPERTY","name":"OPACITY"},"operation":"SCALE","keyframes":[{"timeUs":0,"value":{"type":"FLOAT","value":0},"easing":{"type":"LINEAR"}},{"timeUs":900000,"value":{"type":"FLOAT","value":1},"easing":{"type":"LINEAR"}}]}],)"
                    R"("textStagger":{"grouping":"WORD","order":"LEFT_RIGHT","overlap":50}}})";
  REQUIRE(e.command(CommandId::MOTION_ADD_ANIMATION, args(add)) == OK);
  Guid clip = e.lastCreated()[0];
  const motion::Preset* pr = e.motionIndex().preset(clip);
  REQUIRE(pr);
  CHECK(pr->stagger.enabled);
  CHECK(pr->stagger.grouping == motion::Grouping::WORD);
  CHECK(pr->stagger.stepUs == 225000);
  CHECK(e.motionIndex().track(doc.children(clip)[0])->keyframes.back().timeUs == 450000);
  Mat2x3 rest = doc.get(kText)->props.transform;
  // At 225 ms the first word is halfway (20 px low, half faded in); the others haven't started.
  e.setMotion(on(225000));
  const motion::TextElementPoses* poses = e.textElements(kText);
  REQUIRE(poses);
  REQUIRE(poses->alpha.size() == 3);
  CHECK(poses->alpha[0] == doctest::Approx(0.5));
  CHECK(poses->transform[0].m12 == doctest::Approx(20));
  CHECK(poses->alpha[1] == doctest::Approx(0));
  CHECK(poses->transform[1].m12 == doctest::Approx(40));
  CHECK(poses->alpha[2] == doctest::Approx(0));
  CHECK(doc.get(kText)->props.opacity == doctest::Approx(1));  // the text itself neither fades
  CHECK(doc.get(kText)->props.transform.m12 == doctest::Approx(rest.m12));  // nor moves
  CHECK(poses->reach.bottom() > e.textLayout(kText)->inkBounds.bottom());  // where the low words reach
  // At 450 ms the second word is halfway; at 900 ms every word is home.
  e.setMotion(on(450000));
  poses = e.textElements(kText);
  CHECK(poses->alpha[0] == doctest::Approx(1));
  CHECK(poses->alpha[1] == doctest::Approx(0.5));
  e.setMotion(on(900000));
  poses = e.textElements(kText);
  for (size_t i = 0; i < 3; i++) {
    CHECK(poses->alpha[i] == doctest::Approx(1));
    CHECK(poses->transform[i].m12 == doctest::Approx(0));
  }
  // The clip stretched to 1.8 s: its tracks and its step with it.
  REQUIRE(e.command(CommandId::MOTION_SET_ANIMATION, args(R"({"id":")" + clip.toString() + R"(","durationUs":1800000})")) == OK);
  CHECK(e.motionIndex().preset(clip)->stagger.stepUs == 450000);
  // Motion off: no poses, the text as laid out.
  e.setMotion(motion::State{});
  CHECK(!e.textElements(kText));
}
