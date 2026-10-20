#include "proto/Prototype.h"

#include <algorithm>
#include <cmath>
#include <functional>
#include <memory>
#include <string_view>
#include <unordered_map>

#include "motion/Easing.h"
#include "render/ImageCache.h"
#include "scene/CodecKiwi.h"

namespace eng::proto {

namespace {

// What was read from an extra field's bytes, by those bytes (a read is a pure function of them). Reading kiwi bytes
// as JSON text and parsing it back costs ~20–100 µs a field; the player reads the same interactions over and over
// (every screen's hotspots for the next / previous order, each instance's main and variants, after every Change to),
// and a file's instances carry the same copies of their main's: the owner's B2C page (17k interactions) spent 0.6–2.4 s
// a click or an opening in these reads. Bounded: emptied when it holds too many (what a caller holds stays alive).
template <typename T>
class ByBytes {
 public:
  template <typename Read>
  std::shared_ptr<const T> get(const std::string& bytes, Read&& read) {
    if (auto it = map_.find(std::string_view(bytes)); it != map_.end()) return it->second;
    if (map_.size() >= kMaxEntries || bytes_ >= kMaxBytes) {
      map_.clear();
      bytes_ = 0;
    }
    auto value = std::make_shared<const T>(read());
    map_.emplace(bytes, value);
    bytes_ += bytes.size();
    return value;
  }

 private:
  // A heavy file's distinct interaction lists (its instances share their main's): B2C's 17k interactions fit.
  static constexpr size_t kMaxEntries = 32768, kMaxBytes = 16u << 20;
  struct Hash {
    using is_transparent = void;
    size_t operator()(std::string_view s) const { return std::hash<std::string_view>{}(s); }
  };
  std::unordered_map<std::string, std::shared_ptr<const T>, Hash, std::equal_to<>> map_;
  size_t bytes_ = 0;
};

struct ParsedField {
  bool ok = false;
  json::Value value;
};

// A field of NodeProps::extra as the schema's JSON (null when absent or unreadable).
bool extraJson(const NodeProps& p, const char* key, json::Value& out) {
  auto it = p.extra.find(key);
  if (it == p.extra.end() || it->second.empty()) return false;
  static std::unordered_map<std::string, ByBytes<ParsedField>> memo;  // by field
  auto parsed = memo[key].get(it->second, [&] {
    ParsedField r;
    std::string text = codec::extraValueToJson("NodeChange", it->second);
    r.ok = text != "null" && json::parse(text, r.value);
    return r;
  });
  if (parsed->ok) out = parsed->value;
  return parsed->ok;
}

std::string str(const json::Value* v) { return v && v->isString() ? v->string : std::string(); }
double num(const json::Value* v, double fallback) { return v && v->isNumber() ? v->number : fallback; }
bool flag(const json::Value* v) { return v && ((v->isBool() && v->boolean) || (v->isNumber() && v->number != 0)); }

Guid guidOf(const json::Value* v) {
  if (!v) return kNoGuid;
  if (v->isString()) return Guid::parse(v->string);
  if (v->isObject()) {
    const json::Value* s = v->get("sessionID");
    const json::Value* l = v->get("localID");
    if (s && l && s->isNumber() && l->isNumber()) return Guid{static_cast<uint32_t>(s->number), static_cast<uint32_t>(l->number)};
  }
  return kNoGuid;
}

template <typename E, size_t N>
E enumOf(const json::Value* v, const char* const (&names)[N], E fallback) {
  if (!v) return fallback;
  if (v->isNumber()) return static_cast<E>(static_cast<int>(v->number));
  if (!v->isString()) return fallback;
  for (size_t i = 0; i < N; i++)
    if (names[i] && v->string == names[i]) return static_cast<E>(i);
  return fallback;
}

const char* const kTriggers[] = {"ON_CLICK", "AFTER_TIMEOUT", "MOUSE_IN", "MOUSE_OUT", "ON_HOVER", "MOUSE_DOWN", "MOUSE_UP", "ON_PRESS",
                                 "NONE", "DRAG", "ON_KEY_DOWN", "ON_VOICE", "ON_MEDIA_HIT", "ON_MEDIA_END", "MOUSE_ENTER", "MOUSE_LEAVE"};
const char* const kConnections[] = {"NONE", "INTERNAL_NODE", "URL", "BACK", "CLOSE", "SET_VARIABLE", "UPDATE_MEDIA_RUNTIME", "CONDITIONAL", "SET_VARIABLE_MODE",
                                    nullptr, "UPDATE_ANIMATION_TIMELINE_STATE"};
const char* const kTimelineActions[] = {"PLAY", "PAUSE", "TOGGLE_PLAY_PAUSE", "SET_PLAYHEAD"};
const char* const kNavigations[] = {"NAVIGATE", "OVERLAY", "SWAP", "SWAP_STATE", "SCROLL_TO"};
const char* const kTransitions[] = {
    "INSTANT_TRANSITION", "DISSOLVE", "FADE", "SLIDE_FROM_LEFT", "SLIDE_FROM_RIGHT", "SLIDE_FROM_TOP", "SLIDE_FROM_BOTTOM",
    "PUSH_FROM_LEFT", "PUSH_FROM_RIGHT", "PUSH_FROM_TOP", "PUSH_FROM_BOTTOM", "MOVE_FROM_LEFT", "MOVE_FROM_RIGHT", "MOVE_FROM_TOP",
    "MOVE_FROM_BOTTOM", "SLIDE_OUT_TO_LEFT", "SLIDE_OUT_TO_RIGHT", "SLIDE_OUT_TO_TOP", "SLIDE_OUT_TO_BOTTOM", "MOVE_OUT_TO_LEFT",
    "MOVE_OUT_TO_RIGHT", "MOVE_OUT_TO_TOP", "MOVE_OUT_TO_BOTTOM", "MAGIC_MOVE", "SMART_ANIMATE", "SCROLL_ANIMATE"};
const char* const kEasings[] = {"IN_CUBIC", "OUT_CUBIC", "INOUT_CUBIC", "LINEAR", "IN_BACK_CUBIC", "OUT_BACK_CUBIC", "INOUT_BACK_CUBIC",
                                "CUSTOM_CUBIC", "SPRING", "GENTLE_SPRING", "CUSTOM_SPRING", "SPRING_PRESET_ONE", "SPRING_PRESET_TWO",
                                "SPRING_PRESET_THREE", "HOLD", "EASE_IN"};
const char* const kOverlayPositions[] = {"CENTER", "TOP_LEFT", "TOP_CENTER", "TOP_RIGHT", "BOTTOM_LEFT", "BOTTOM_CENTER", "BOTTOM_RIGHT", "MANUAL"};
const char* const kMediaActions[] = {"PLAY", "PAUSE", "TOGGLE_PLAY_PAUSE", "MUTE", "UNMUTE", "TOGGLE_MUTE_UNMUTE", "SKIP_FORWARD", "SKIP_BACKWARD", "SKIP_TO"};
const char* const kOverflows[] = {"NONE", "HORIZONTAL", "VERTICAL", "BOTH"};
const char* const kScrollBehaviors[] = {"SCROLLS", "FIXED_WHEN_CHILD_OF_SCROLLING_FRAME", "STICKY_SCROLLS"};

Action readAction(const json::Value& v);

void readActions(const json::Value* list, std::vector<Action>& out) {
  if (!list || !list->isArray()) return;
  for (const json::Value& a : list->array)
    if (a.isObject()) out.push_back(readAction(a));
}

Action readAction(const json::Value& v) {
  Action a;
  a.connection = enumOf(v.get("connectionType"), kConnections, Connection::NONE);
  a.navigation = enumOf(v.get("navigationType"), kNavigations, Navigation::NAVIGATE);
  a.dest = guidOf(v.get("transitionNodeID"));
  a.transition = enumOf(v.get("transitionType"), kTransitions, Transition::INSTANT);
  // Seconds; Figma reads a missing or zero duration as 0.3 (`transitionDuration || .3`).
  a.duration = num(v.get("transitionDuration"), 0);
  if (!(a.duration != 0)) a.duration = 0.3;
  if (const json::Value* d = v.get("transitionDurationVar"); d && d->isObject()) a.durationVar = *d;
  a.easing = enumOf(v.get("easingType"), kEasings, Easing::OUT_CUBIC);
  if (const json::Value* f = v.get("easingFunction"); f && f->isArray())
    for (auto& x : f->array) a.easingFunction.push_back(x.numberOr(0));
  a.smartAnimate = flag(v.get("transitionShouldSmartAnimate")) || a.transition == Transition::SMART_ANIMATE || a.transition == Transition::MAGIC_MOVE;
  a.preserveScroll = flag(v.get("transitionPreserveScroll"));
  a.resetScroll = flag(v.get("transitionResetScrollPosition"));
  a.resetComponents = flag(v.get("transitionResetInteractiveComponents"));
  a.resetVideo = flag(v.get("transitionResetVideoPosition"));
  a.media = enumOf(v.get("mediaAction"), kMediaActions, MediaAction::PLAY);
  a.mediaSkipTo = num(v.get("mediaSkipToTime"), 0);
  a.mediaSkipBy = num(v.get("mediaSkipByAmount"), 0);
  a.timeline = enumOf(v.get("animationTimelineAction"), kTimelineActions, TimelineAction::PLAY);
  a.timelineSkipTo = num(v.get("animationSkipToTime"), 0);
  a.timelineDef = guidOf(v.get("animationTimelineDefId"));
  a.url = str(v.get("connectionURL"));
  if (const json::Value* t = v.get("openUrlInNewTab")) a.newTab = flag(t);
  if (const json::Value* o = v.get("overlayRelativePosition"); o && o->isObject()) {
    a.hasOverlayOffset = true;
    a.overlayOffset = {num(o->get("x"), 0), num(o->get("y"), 0)};
  }
  if (const json::Value* o = v.get("extraScrollOffset"); o && o->isObject()) a.scrollOffset = {num(o->get("x"), 0), num(o->get("y"), 0)};
  if (const json::Value* t = v.get("targetVariable"); t && t->isObject())
    if (const json::Value* id = t->get("id")) a.targetVariable = *id;
  if (const json::Value* d = v.get("targetVariableData")) a.targetVariableData = *d;
  if (const json::Value* s = v.get("targetVariableSetID")) a.targetVariableSet = *s;
  a.targetMode = guidOf(v.get("targetVariableModeID"));
  if (const json::Value* c = v.get("conditionalActions"); c && c->isArray()) {
    for (const json::Value& b : c->array) {
      if (!b.isObject()) continue;
      Branch br;
      if (const json::Value* cond = b.get("condition"); cond && cond->isObject()) {
        br.hasCondition = true;
        br.condition = *cond;
      }
      readActions(b.get("actions"), br.actions);
      a.branches.push_back(std::move(br));
    }
  }
  return a;
}

json::Value object() {
  json::Value v;
  v.kind = json::Value::Kind::Object;
  return v;
}
json::Value numberValue(double n) {
  json::Value v;
  v.kind = json::Value::Kind::Number;
  v.number = n;
  return v;
}
json::Value stringValue(std::string s) {
  json::Value v;
  v.kind = json::Value::Kind::String;
  v.string = std::move(s);
  return v;
}
json::Value boolValue(bool b) {
  json::Value v;
  v.kind = json::Value::Kind::Bool;
  v.boolean = b;
  return v;
}
json::Value guidValue(Guid g) {
  json::Value v = object();
  v.object.emplace_back("sessionID", numberValue(g.sessionID));
  v.object.emplace_back("localID", numberValue(g.localID));
  return v;
}
json::Value vecValue(Vec2 p) {
  json::Value v = object();
  v.object.emplace_back("x", numberValue(p.x));
  v.object.emplace_back("y", numberValue(p.y));
  return v;
}

json::Value actionJson(const Action& a) {
  json::Value v = object();
  auto put = [&](const char* k, json::Value x) { v.object.emplace_back(k, std::move(x)); };
  put("connectionType", stringValue(connectionName(a.connection)));
  if (a.connection == Connection::INTERNAL_NODE) {
    put("navigationType", stringValue(navigationName(a.navigation)));
    if (a.dest != kNoGuid) put("transitionNodeID", guidValue(a.dest));
  }
  if (a.connection == Connection::UPDATE_MEDIA_RUNTIME) {
    if (a.dest != kNoGuid) put("transitionNodeID", guidValue(a.dest));
    put("mediaAction", stringValue(mediaActionName(a.media)));
    if (a.media == MediaAction::SKIP_TO) put("mediaSkipToTime", numberValue(a.mediaSkipTo));
    if (a.media == MediaAction::SKIP_FORWARD || a.media == MediaAction::SKIP_BACKWARD) put("mediaSkipByAmount", numberValue(a.mediaSkipBy));
  }
  if (a.connection == Connection::UPDATE_ANIMATION_TIMELINE_STATE) {
    put("animationTimelineAction", stringValue(kTimelineActions[static_cast<size_t>(a.timeline) & 3]));
    if (a.timeline == TimelineAction::SET_PLAYHEAD) put("animationSkipToTime", numberValue(a.timelineSkipTo));
    if (a.timelineDef != kNoGuid) put("animationTimelineDefId", guidValue(a.timelineDef));
  }
  put("transitionType", stringValue(transitionName(a.transition)));
  put("transitionDuration", numberValue(a.duration));
  if (!a.durationVar.isNull()) put("transitionDurationVar", a.durationVar);
  put("easingType", stringValue(easingName(a.easing)));
  if (!a.easingFunction.empty()) {
    json::Value f;
    f.kind = json::Value::Kind::Array;
    for (double x : a.easingFunction) f.array.push_back(numberValue(x));
    put("easingFunction", std::move(f));
  }
  if (a.smartAnimate) put("transitionShouldSmartAnimate", boolValue(true));
  if (a.preserveScroll) put("transitionPreserveScroll", boolValue(true));
  if (a.resetScroll) put("transitionResetScrollPosition", boolValue(true));
  if (a.resetComponents) put("transitionResetInteractiveComponents", boolValue(true));
  if (a.resetVideo) put("transitionResetVideoPosition", boolValue(true));
  if (a.connection == Connection::URL) {
    put("connectionURL", stringValue(a.url));
    put("openUrlInNewTab", boolValue(a.newTab));
  }
  if (a.hasOverlayOffset) put("overlayRelativePosition", vecValue(a.overlayOffset));
  if (a.scrollOffset.x != 0 || a.scrollOffset.y != 0) put("extraScrollOffset", vecValue(a.scrollOffset));
  if (!a.targetVariable.isNull()) {
    json::Value t = object();
    t.object.emplace_back("id", a.targetVariable);
    put("targetVariable", std::move(t));
  }
  if (!a.targetVariableData.isNull()) put("targetVariableData", a.targetVariableData);
  if (!a.targetVariableSet.isNull()) put("targetVariableSetID", a.targetVariableSet);
  if (a.targetMode != kNoGuid) put("targetVariableModeID", guidValue(a.targetMode));
  if (!a.branches.empty()) {
    json::Value list;
    list.kind = json::Value::Kind::Array;
    for (const Branch& b : a.branches) {
      json::Value bv = object();
      json::Value acts;
      acts.kind = json::Value::Kind::Array;
      for (const Action& x : b.actions) acts.array.push_back(actionJson(x));
      bv.object.emplace_back("actions", std::move(acts));
      if (b.hasCondition) bv.object.emplace_back("condition", b.condition);
      list.array.push_back(std::move(bv));
    }
    put("conditionalActions", std::move(list));
  }
  return v;
}

// A spring easing's physical spring (Figma's presets; CUSTOM_SPRING: easingFunction [mass, stiffness, damping, v0],
// at least three finite values with a positive mass and stiffness, else Figma's fallback {1, 100, 10}).
motion::Spring springOf(const Action& a) {
  switch (a.easing) {
    case Easing::SPRING:
    case Easing::GENTLE_SPRING: return motion::kGentle;
    case Easing::SPRING_PRESET_ONE: return motion::kQuick;
    case Easing::SPRING_PRESET_TWO: return motion::kBouncy;
    case Easing::SPRING_PRESET_THREE: return motion::kSlow;
    default: break;
  }
  const std::vector<double>& f = a.easingFunction;
  if (f.size() < 3 || !std::isfinite(f[0]) || !std::isfinite(f[1]) || !std::isfinite(f[2]) || f[0] <= 0 || f[1] <= 0 || f[2] < 0)
    return motion::kInvalidSpring;
  motion::Spring s{f[0], f[1], f[2], 0};
  if (f.size() >= 4 && std::isfinite(f[3])) s.initialVelocity = f[3];
  return s;
}

bool isSpring(Easing e) {
  return e == Easing::SPRING || e == Easing::GENTLE_SPRING || e == Easing::CUSTOM_SPRING || e == Easing::SPRING_PRESET_ONE ||
         e == Easing::SPRING_PRESET_TWO || e == Easing::SPRING_PRESET_THREE;
}

double bezier(const motion::Bezier& b, double t) { return motion::cubicBezier(b.x1, b.y1, b.x2, b.y2, t); }

}  // namespace

const char* triggerName(Trigger t) {
  size_t i = static_cast<size_t>(t);
  return i < std::size(kTriggers) ? kTriggers[i] : "ON_CLICK";
}
const char* connectionName(Connection c) {
  size_t i = static_cast<size_t>(c);
  return i < std::size(kConnections) && kConnections[i] ? kConnections[i] : "NONE";
}
const char* navigationName(Navigation n) {
  size_t i = static_cast<size_t>(n);
  return i < std::size(kNavigations) ? kNavigations[i] : "NAVIGATE";
}
const char* transitionName(Transition t) {
  size_t i = static_cast<size_t>(t);
  return i < std::size(kTransitions) ? kTransitions[i] : "INSTANT_TRANSITION";
}
const char* mediaActionName(MediaAction m) {
  size_t i = static_cast<size_t>(m);
  return i < std::size(kMediaActions) ? kMediaActions[i] : "PLAY";
}
const char* easingName(Easing e) {
  size_t i = static_cast<size_t>(e);
  return i < std::size(kEasings) ? kEasings[i] : "OUT_CUBIC";
}

bool hasInteractions(const NodeProps& p) {
  auto it = p.extra.find("prototypeInteractions");
  return it != p.extra.end() && !it->second.empty();
}

namespace {

std::vector<Interaction> readInteractions(const NodeProps& p) {
  std::vector<Interaction> out;
  json::Value v;
  if (!extraJson(p, "prototypeInteractions", v) || !v.isArray()) return out;
  for (const json::Value& x : v.array) {
    if (!x.isObject() || flag(x.get("isDeleted"))) continue;
    Interaction i;
    i.id = guidOf(x.get("id"));
    i.stateManagementVersion = static_cast<int>(num(x.get("stateManagementVersion"), 0));
    if (const json::Value* e = x.get("event"); e && e->isObject()) {
      i.trigger = enumOf(e->get("interactionType"), kTriggers, Trigger::ON_CLICK);
      // After delay: a missing or zero timeout reads as 0.8 s, as Figma's (`transitionTimeout || .8`).
      i.timeout = num(e->get("transitionTimeout"), 0);
      if (!(i.timeout != 0)) i.timeout = 0.8;
      // Mouse enter / leave / down / up: the delay is Figma's interactionMaintained + interactionDuration (seconds; a
      // maintained interaction without a duration waits 0.3 s). Files Wecra wrote before kept it in transitionTimeout.
      if (hasDelay(i.trigger)) {
        if (flag(e->get("interactionMaintained"))) {
          double d = num(e->get("interactionDuration"), 0);
          i.delay = d > 0 ? d : 0.3;
        } else {
          i.delay = std::max(0.0, num(e->get("transitionTimeout"), 0));
        }
      }
      if (const json::Value* d = e->get("transitionTimeoutVar"); d && d->isObject()) i.timeoutVar = *d;
      i.mediaHitTime = num(e->get("mediaHitTime"), 0);
      if (const json::Value* k = e->get("keyTrigger"); k && k->isObject())
        if (const json::Value* codes = k->get("keyCodes"); codes && codes->isArray())
          for (auto& c : codes->array) i.keyCodes.push_back(static_cast<int>(c.numberOr(0)));
    }
    readActions(x.get("actions"), i.actions);
    out.push_back(std::move(i));
  }
  return out;
}

}  // namespace

std::shared_ptr<const std::vector<Interaction>> sharedInteractions(const NodeProps& p) {
  static const auto none = std::make_shared<const std::vector<Interaction>>();
  auto it = p.extra.find("prototypeInteractions");
  if (it == p.extra.end() || it->second.empty()) return none;
  static ByBytes<std::vector<Interaction>> memo;
  return memo.get(it->second, [&] { return readInteractions(p); });
}

std::vector<Interaction> interactions(const NodeProps& p) { return *sharedInteractions(p); }

Overflow overflow(const NodeProps& p) {
  json::Value v;
  if (!extraJson(p, "scrollDirection", v)) return Overflow::NONE;
  return enumOf(&v, kOverflows, Overflow::NONE);
}

ScrollBehavior scrollBehavior(const NodeProps& p) {
  json::Value v;
  if (!extraJson(p, "scrollBehavior", v)) return ScrollBehavior::SCROLLS;
  return enumOf(&v, kScrollBehaviors, ScrollBehavior::SCROLLS);
}

OverlaySettings overlaySettings(const NodeProps& p) {
  OverlaySettings s;
  json::Value v;
  if (extraJson(p, "overlayPositionType", v)) s.position = enumOf(&v, kOverlayPositions, OverlayPosition::CENTER);
  if (extraJson(p, "overlayBackgroundInteraction", v)) s.closeOnClickOutside = v.isString() ? v.string == "CLOSE_ON_CLICK_OUTSIDE" : v.numberOr(0) == 1;
  if (extraJson(p, "overlayBackgroundAppearance", v) && v.isObject()) {
    const json::Value* t = v.get("backgroundType");
    s.background = t && ((t->isString() && t->string == "SOLID_COLOR") || (t->isNumber() && t->number == 1));
    if (const json::Value* c = v.get("backgroundColor"); c && c->isObject())
      s.backgroundColor = {static_cast<float>(num(c->get("r"), 0)), static_cast<float>(num(c->get("g"), 0)),
                           static_cast<float>(num(c->get("b"), 0)), static_cast<float>(num(c->get("a"), 0.25))};
  }
  return s;
}

bool flowStart(const NodeProps& p, Flow& out) {
  json::Value v;
  if (!extraJson(p, "prototypeStartingPoint", v) || !v.isObject()) return false;
  out.name = str(v.get("name"));
  out.description = str(v.get("description"));
  out.position = str(v.get("position"));
  return true;
}

Device device(const NodeProps& page) {
  Device d;
  json::Value v;
  if (!extraJson(page, "prototypeDevice", v) || !v.isObject()) return d;
  const json::Value* t = v.get("type");
  std::string type = t && t->isString() ? t->string : (t && t->isNumber() ? (t->number == 1 ? "PRESET" : t->number == 2 ? "CUSTOM" : t->number == 3 ? "PRESENTATION" : "NONE") : "NONE");
  d.type = type == "PRESET" ? Device::Type::PRESET : type == "CUSTOM" ? Device::Type::CUSTOM : type == "PRESENTATION" ? Device::Type::PRESENTATION : Device::Type::NONE;
  if (type == "PRESET" || type == "CUSTOM") {
    if (const json::Value* s = v.get("size"); s && s->isObject()) d.size = {num(s->get("x"), 0), num(s->get("y"), 0)};
    d.none = !(d.size.x > 0 && d.size.y > 0);
  }
  d.preset = str(v.get("presetIdentifier"));
  const json::Value* r = v.get("rotation");
  d.rotated = r && ((r->isString() && r->string == "CCW_90") || (r->isNumber() && r->number == 1));
  if (d.rotated) std::swap(d.size.x, d.size.y);
  return d;
}

Color background(const NodeProps& page) {
  json::Value v;
  // Figma's pages hold a transparent black (live 2026-10-20: prototypeBackgrounds opacity 0), shown as black (viewer
  // `u3`: a transparent background is drawn black).
  if (!extraJson(page, "prototypeBackgroundColor", v) || !v.isObject()) return Color::hex(0x000000);
  Color c{static_cast<float>(num(v.get("r"), 0)), static_cast<float>(num(v.get("g"), 0)), static_cast<float>(num(v.get("b"), 0)),
          static_cast<float>(num(v.get("a"), 1))};
  if (c.a <= 0) return Color::hex(0x000000);
  return c;
}

VideoSettings videoSettings(const NodeProps& p) {
  VideoSettings s;
  json::Value v;
  if (!extraJson(p, "videoPlayback", v) || !v.isObject()) return s;
  s.autoplay = flag(v.get("autoplay"));
  s.loop = flag(v.get("mediaLoop"));
  s.muted = flag(v.get("muted"));
  return s;
}

int videoFill(const NodeProps& p) {
  for (size_t i = 0; i < p.fillPaints.size(); i++)
    if (p.fillPaints[i].type == PaintType::VIDEO && p.fillPaints[i].visible) return static_cast<int>(i);
  return -1;
}

int gifFill(const NodeProps& p) {
  for (size_t i = 0; i < p.fillPaints.size(); i++)
    if (p.fillPaints[i].visible && paintGifHash(p.fillPaints[i]).present) return static_cast<int>(i);
  return -1;
}

std::vector<Guid> screens(const Document& doc, Guid page) {
  std::vector<Guid> out;
  std::function<void(Guid)> walk = [&](Guid parent) {
    for (Guid c : doc.children(parent)) {
      const Node* n = doc.get(c);
      if (!n) continue;
      if (n->props.type == NodeType::SECTION) walk(c);
      else out.push_back(c);
    }
  };
  walk(page);
  return out;
}

Guid screenOf(const Document& doc, Guid id) {
  // The chain up to the page; the screen is the first layer under the page and its sections.
  std::vector<Guid> chain;
  for (Guid cur = id; cur != kNoGuid && chain.size() < 4096; cur = doc.parentOf(cur)) {
    const Node* n = doc.get(cur);
    if (!n) return kNoGuid;
    if (n->props.type == NodeType::CANVAS) {
      for (auto it = chain.rbegin(); it != chain.rend(); ++it) {
        const Node* c = doc.get(*it);
        if (c && c->props.type != NodeType::SECTION) return *it;
      }
      return kNoGuid;
    }
    chain.push_back(cur);
  }
  return kNoGuid;
}

std::vector<Flow> flows(const Document& doc, Guid page) {
  std::vector<Flow> out;
  for (Guid c : screens(doc, page)) {
    const Node* n = doc.get(c);
    if (!n) continue;
    Flow f;
    if (!flowStart(n->props, f)) continue;
    f.node = c;
    out.push_back(std::move(f));
  }
  std::stable_sort(out.begin(), out.end(), [](const Flow& a, const Flow& b) { return a.position < b.position; });
  return out;
}

json::Value toJson(const Interaction& i) {
  json::Value v = object();
  if (i.id != kNoGuid) v.object.emplace_back("id", guidValue(i.id));
  json::Value e = object();
  e.object.emplace_back("interactionType", stringValue(triggerName(i.trigger)));
  if (i.trigger == Trigger::AFTER_TIMEOUT) e.object.emplace_back("transitionTimeout", numberValue(i.timeout));
  if (i.trigger == Trigger::AFTER_TIMEOUT && !i.timeoutVar.isNull()) e.object.emplace_back("transitionTimeoutVar", i.timeoutVar);
  if (hasDelay(i.trigger) && i.delay > 0) {
    e.object.emplace_back("interactionMaintained", boolValue(true));
    e.object.emplace_back("interactionDuration", numberValue(i.delay));
  }
  if (i.trigger == Trigger::ON_MEDIA_HIT) e.object.emplace_back("mediaHitTime", numberValue(i.mediaHitTime));
  if (i.trigger == Trigger::ON_KEY_DOWN) {
    json::Value k = object();
    json::Value codes;
    codes.kind = json::Value::Kind::Array;
    for (int c : i.keyCodes) codes.array.push_back(numberValue(c));
    k.object.emplace_back("keyCodes", std::move(codes));
    k.object.emplace_back("triggerDevice", stringValue("KEYBOARD"));
    e.object.emplace_back("keyTrigger", std::move(k));
  }
  v.object.emplace_back("event", std::move(e));
  json::Value acts;
  acts.kind = json::Value::Kind::Array;
  for (const Action& a : i.actions) acts.array.push_back(actionJson(a));
  v.object.emplace_back("actions", std::move(acts));
  if (i.stateManagementVersion != 0) v.object.emplace_back("stateManagementVersion", numberValue(i.stateManagementVersion));
  return v;
}

namespace {

// Each live entry of prototypeInteractions (the ones interactions() lists, in its order): its id and its JSON without
// the bookkeeping fields Figma adds to copies (isDeleted, stateManagementVersion).
std::vector<std::pair<Guid, std::string>> readLiveEntries(const NodeProps& p) {
  std::vector<std::pair<Guid, std::string>> out;
  json::Value v;
  if (!extraJson(p, "prototypeInteractions", v) || !v.isArray()) return out;
  for (const json::Value& x : v.array) {
    if (!x.isObject() || flag(x.get("isDeleted"))) continue;
    json::Value c = x;
    c.object.erase(std::remove_if(c.object.begin(), c.object.end(),
                                  [](const auto& kv) { return kv.first == "isDeleted" || kv.first == "stateManagementVersion"; }),
                   c.object.end());
    out.emplace_back(guidOf(x.get("id")), json::encode(c));
  }
  return out;
}

using Entries = std::vector<std::pair<Guid, std::string>>;
std::shared_ptr<const Entries> liveEntries(const NodeProps& p) {
  auto it = p.extra.find("prototypeInteractions");
  if (it == p.extra.end() || it->second.empty()) return std::make_shared<const Entries>();
  static ByBytes<Entries> memo;
  return memo.get(it->second, [&] { return readLiveEntries(p); });
}

}  // namespace

std::vector<Interaction> instanceInteractions(const NodeProps& own, const NodeProps* main, const std::vector<const NodeProps*>& variants,
                                              std::vector<int>* ownIndex) {
  std::vector<Interaction> ownList = hasInteractions(own) ? interactions(own) : std::vector<Interaction>{};
  if (!main) {
    if (ownIndex) {
      ownIndex->clear();
      for (size_t i = 0; i < ownList.size(); i++) ownIndex->push_back(static_cast<int>(i));
    }
    return ownList;
  }
  std::vector<Interaction> mainList = hasInteractions(*main) ? interactions(*main) : std::vector<Interaction>{};
  std::vector<Interaction> out = mainList;
  std::vector<int> index(mainList.size(), -1);
  if (!ownList.empty()) {
    auto ownEntries = liveEntries(own);
    std::vector<std::shared_ptr<const Entries>> variantEntries;
    for (const NodeProps* v : variants)
      if (v) variantEntries.push_back(liveEntries(*v));
    auto copyOf = [&](Guid id, const std::string& body) {
      for (const auto& list : variantEntries)
        for (const auto& [vid, vbody] : *list)
          if (vid == id && vbody == body) return true;
      return false;
    };
    auto otherVariants = [&](Guid id) {
      for (const auto& list : variantEntries)
        for (const auto& e : *list)
          if (e.first == id) return true;
      return false;
    };
    for (size_t k = 0; k < ownList.size() && k < ownEntries->size(); k++) {
      Guid id = ownList[k].id;
      const std::string& body = (*ownEntries)[k].second;
      size_t at = mainList.size();
      if (id != kNoGuid)
        for (size_t m = 0; m < mainList.size(); m++)
          if (mainList[m].id == id) at = m;
      if (at < mainList.size()) {
        if (copyOf(id, body)) continue;  // the main's, copied: the main's as it is now
        out[at] = ownList[k];            // changed on the instance
        index[at] = static_cast<int>(k);
        continue;
      }
      if (id != kNoGuid && otherVariants(id)) continue;  // another variant's, from before a variant switch
      out.push_back(ownList[k]);
      index.push_back(static_cast<int>(k));
    }
  }
  if (ownIndex) *ownIndex = std::move(index);
  return out;
}

std::vector<bool> instanceOwnEntries(const NodeProps& own, const NodeProps* main, const std::vector<const NodeProps*>& variants) {
  auto ownList = sharedInteractions(own);
  std::vector<bool> mine(ownList->size(), main == nullptr);
  if (!main || ownList->empty()) return mine;
  auto mainList = sharedInteractions(*main);
  auto ownEntries = liveEntries(own);
  std::vector<std::shared_ptr<const Entries>> variantEntries;
  for (const NodeProps* v : variants)
    if (v) variantEntries.push_back(liveEntries(*v));
  for (size_t k = 0; k < ownList->size() && k < ownEntries->size(); k++) {
    Guid id = (*ownList)[k].id;
    const std::string& body = (*ownEntries)[k].second;
    bool inMain = id != kNoGuid && std::any_of(mainList->begin(), mainList->end(), [&](const Interaction& m) { return m.id == id; });
    bool copy = false, elsewhere = false;
    for (const auto& list : variantEntries)
      for (const auto& [vid, vbody] : *list)
        if (vid == id) {
          elsewhere = true;
          copy |= vbody == body;
        }
    // As instanceInteractions: the main's entry changed on the instance, or an entry no variant has.
    mine[k] = inMain ? !copy : !(id != kNoGuid && elsewhere);
  }
  return mine;
}

std::string encodeField(const char* key, const json::Value& v) { return codec::extraFromJson("NodeChange", key, v); }

std::string encodeInteractions(const std::vector<Interaction>& list) {
  if (list.empty()) return std::string();
  json::Value arr;
  arr.kind = json::Value::Kind::Array;
  for (const Interaction& i : list) arr.array.push_back(toJson(i));
  return encodeField("prototypeInteractions", arr);
}

Interaction newConnection(Guid id, Guid dest) {
  Interaction i;
  i.id = id;
  i.trigger = Trigger::ON_CLICK;
  i.stateManagementVersion = 1;  // what Figma writes on every new interaction
  Action a;
  a.connection = Connection::INTERNAL_NODE;
  a.navigation = Navigation::NAVIGATE;
  a.dest = dest;
  a.transition = Transition::INSTANT;
  a.duration = 0.3;
  a.easing = Easing::OUT_CUBIC;
  i.actions.push_back(std::move(a));
  return i;
}

double ease(const Action& a, double t) {
  t = std::clamp(t, 0.0, 1.0);
  if (isSpring(a.easing)) return t >= 1 ? 1 : motion::springValue(springOf(a), t * durationOf(a));
  switch (a.easing) {
    case Easing::LINEAR: return t;
    case Easing::IN_CUBIC:
    case Easing::EASE_IN: return bezier(motion::kEaseIn, t);
    case Easing::OUT_CUBIC: return bezier(motion::kEaseOut, t);
    case Easing::INOUT_CUBIC: return bezier(motion::kEaseInOut, t);
    case Easing::IN_BACK_CUBIC: return bezier(motion::kEaseInBack, t);
    case Easing::OUT_BACK_CUBIC: return bezier(motion::kEaseOutBack, t);
    case Easing::INOUT_BACK_CUBIC: return bezier(motion::kEaseInOutBack, t);
    case Easing::CUSTOM_CUBIC:
      if (a.easingFunction.size() >= 4)
        return motion::cubicBezier(a.easingFunction[0], a.easingFunction[1], a.easingFunction[2], a.easingFunction[3], t);
      return bezier(motion::kEaseOut, t);
    case Easing::HOLD: return t >= 1 ? 1 : 0;
    default: return t;
  }
}

double durationOf(const Action& a) {
  if (isSpring(a.easing)) return motion::springSettleTime(springOf(a));
  return std::max(0.0, a.duration);
}

namespace {

Vec2 sideOf(int side) {
  static const Vec2 sides[] = {{-1, 0}, {1, 0}, {0, -1}, {0, 1}};  // LEFT, RIGHT, TOP, BOTTOM
  return sides[side];
}

// `reversed()`: the screens swap roles, each runs its path backwards, the other one is on top.
Geometry reversed(const Geometry& g) {
  Geometry r = g;
  r.inFrom = g.outTo, r.inTo = g.outFrom, r.outFrom = g.inTo, r.outTo = g.inFrom;
  r.inAlphaFrom = g.outAlphaTo, r.inAlphaTo = g.outAlphaFrom, r.outAlphaFrom = g.inAlphaTo, r.outAlphaTo = g.inAlphaFrom;
  r.enteringOnTop = !g.enteringOnTop;
  return r;
}

Geometry slideFrom(int side) {
  Geometry g;
  g.moves = true;
  Vec2 s = sideOf(side);
  g.inFrom = s;
  g.outTo = {-s.x / 4, -s.y / 4};
  g.outAlphaTo = 0.5;
  return g;
}

Geometry moveFrom(int side) {
  Geometry g;
  g.moves = true;
  g.inFrom = sideOf(side);
  return g;
}

Geometry pushFrom(int side) {
  // PUSH_FROM_LEFT and _TOP are built; _RIGHT and _BOTTOM are their reverses (the exiting screen on top).
  if (side == 1 || side == 3) return reversed(pushFrom(side - 1));
  Geometry g;
  g.moves = true;
  Vec2 s = sideOf(side);
  g.inFrom = s;
  g.outTo = {-s.x, -s.y};
  return g;
}

}  // namespace

Geometry geometryOf(Transition t) {
  int k = static_cast<int>(t);
  auto in = [&](Transition first) { return k - static_cast<int>(first); };
  if (t >= Transition::SLIDE_FROM_LEFT && t <= Transition::SLIDE_FROM_BOTTOM) return slideFrom(in(Transition::SLIDE_FROM_LEFT));
  if (t >= Transition::PUSH_FROM_LEFT && t <= Transition::PUSH_FROM_BOTTOM) return pushFrom(in(Transition::PUSH_FROM_LEFT));
  if (t >= Transition::MOVE_FROM_LEFT && t <= Transition::MOVE_FROM_BOTTOM) return moveFrom(in(Transition::MOVE_FROM_LEFT));
  // LEFT ↔ RIGHT, TOP ↔ BOTTOM: the side index with its last bit flipped.
  if (t >= Transition::SLIDE_OUT_TO_LEFT && t <= Transition::SLIDE_OUT_TO_BOTTOM) return reversed(slideFrom(in(Transition::SLIDE_OUT_TO_LEFT) ^ 1));
  if (t >= Transition::MOVE_OUT_TO_LEFT && t <= Transition::MOVE_OUT_TO_BOTTOM) return reversed(moveFrom(in(Transition::MOVE_OUT_TO_LEFT) ^ 1));
  return Geometry{};
}

bool hasDelay(Trigger t) {
  return t == Trigger::MOUSE_ENTER || t == Trigger::MOUSE_LEAVE || t == Trigger::MOUSE_DOWN || t == Trigger::MOUSE_UP ||
         t == Trigger::MOUSE_IN || t == Trigger::MOUSE_OUT;
}

void destinations(const Action& a, std::vector<std::pair<Navigation, Guid>>& out) {
  if (a.connection == Connection::INTERNAL_NODE && a.dest != kNoGuid) out.emplace_back(a.navigation, a.dest);
  for (const Branch& b : a.branches)
    for (const Action& x : b.actions) destinations(x, out);
}

void mediaTargets(const Action& a, std::vector<Guid>& out) {
  if (a.connection == Connection::UPDATE_MEDIA_RUNTIME && a.dest != kNoGuid) out.push_back(a.dest);
  for (const Branch& b : a.branches)
    for (const Action& x : b.actions) mediaTargets(x, out);
}

}  // namespace eng::proto
