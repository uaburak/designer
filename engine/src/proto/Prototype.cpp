#include "proto/Prototype.h"

#include <algorithm>
#include <cmath>

#include "scene/CodecKiwi.h"

namespace eng::proto {

namespace {

// A field of NodeProps::extra as the schema's JSON (null when absent or unreadable).
bool extraJson(const NodeProps& p, const char* key, json::Value& out) {
  auto it = p.extra.find(key);
  if (it == p.extra.end() || it->second.empty()) return false;
  std::string text = codec::extraValueToJson("NodeChange", it->second);
  if (text == "null") return false;
  return json::parse(text, out);
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
const char* const kConnections[] = {"NONE", "INTERNAL_NODE", "URL", "BACK", "CLOSE", "SET_VARIABLE", "UPDATE_MEDIA_RUNTIME", "CONDITIONAL", "SET_VARIABLE_MODE"};
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
  a.duration = num(v.get("transitionDuration"), 0.3);
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
  a.url = str(v.get("connectionURL"));
  a.newTab = flag(v.get("openUrlInNewTab"));
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
  put("transitionType", stringValue(transitionName(a.transition)));
  put("transitionDuration", numberValue(a.duration));
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
    if (a.newTab) put("openUrlInNewTab", boolValue(true));
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

// cubic-bezier(x1, y1, x2, y2) at t (CSS's: x is time, solved for y).
double bezier(double x1, double y1, double x2, double y2, double x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  auto sample = [](double a1, double a2, double t) {
    double u = 1 - t;
    return 3 * u * u * t * a1 + 3 * u * t * t * a2 + t * t * t;
  };
  auto slope = [](double a1, double a2, double t) {
    double u = 1 - t;
    return 3 * u * u * a1 + 6 * u * t * (a2 - a1) + 3 * t * t * (1 - a2);
  };
  double t = x;
  for (int i = 0; i < 8; i++) {
    double err = sample(x1, x2, t) - x;
    if (std::fabs(err) < 1e-7) break;
    double d = slope(x1, x2, t);
    if (std::fabs(d) < 1e-6) break;
    t -= err / d;
  }
  if (t < 0 || t > 1 || std::fabs(sample(x1, x2, t) - x) > 1e-4) {
    // Bisection when Newton wanders off.
    double lo = 0, hi = 1;
    t = x;
    for (int i = 0; i < 40; i++) {
      double s = sample(x1, x2, t);
      if (std::fabs(s - x) < 1e-7) break;
      if (s < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
  }
  return sample(y1, y2, t);
}

struct Spring {
  double mass = 1, stiffness = 100, damping = 15;
};

Spring springOf(const Action& a) {
  switch (a.easing) {
    case Easing::GENTLE_SPRING: return {1, 100, 15};
    case Easing::SPRING_PRESET_ONE: return {1, 300, 20};    // Quick
    case Easing::SPRING_PRESET_TWO: return {1, 600, 15};    // Bouncy
    case Easing::SPRING_PRESET_THREE: return {1, 80, 20};   // Slow
    case Easing::SPRING: return {1, 100, 15};
    default: break;
  }
  Spring s{1, 100, 10};
  if (a.easingFunction.size() >= 3) {
    s.mass = std::max(0.01, a.easingFunction[0]);
    s.stiffness = std::max(0.01, a.easingFunction[1]);
    s.damping = std::max(0.0, a.easingFunction[2]);
  }
  return s;
}

// A damped spring from 0 to 1 at time `t` seconds (no initial velocity).
double springAt(const Spring& s, double t) {
  double w0 = std::sqrt(s.stiffness / s.mass);
  double zeta = s.damping / (2 * std::sqrt(s.stiffness * s.mass));
  if (zeta < 1) {
    double wd = w0 * std::sqrt(1 - zeta * zeta);
    return 1 - std::exp(-zeta * w0 * t) * (std::cos(wd * t) + (zeta * w0 / wd) * std::sin(wd * t));
  }
  if (zeta == 1) return 1 - std::exp(-w0 * t) * (1 + w0 * t);
  double r = w0 * std::sqrt(zeta * zeta - 1);
  double a = -zeta * w0 + r, b = -zeta * w0 - r;
  // x(t) = 1 + c1 e^{a t} + c2 e^{b t}, x(0) = 0, x'(0) = 0.
  double c2 = a / (b - a), c1 = -1 - c2;
  return 1 + c1 * std::exp(a * t) + c2 * std::exp(b * t);
}

bool isSpring(Easing e) {
  return e == Easing::SPRING || e == Easing::GENTLE_SPRING || e == Easing::CUSTOM_SPRING || e == Easing::SPRING_PRESET_ONE ||
         e == Easing::SPRING_PRESET_TWO || e == Easing::SPRING_PRESET_THREE;
}

double springDuration(const Spring& s) {
  // Settled: within 0.1 % of the end for good (sampled every 1/120 s, at most 10 s).
  double last = 0;
  for (double t = 0; t < 10; t += 1.0 / 120)
    if (std::fabs(springAt(s, t) - 1) > 0.001) last = t;
  return std::max(0.05, last + 1.0 / 120);
}

}  // namespace

const char* triggerName(Trigger t) {
  size_t i = static_cast<size_t>(t);
  return i < std::size(kTriggers) ? kTriggers[i] : "ON_CLICK";
}
const char* connectionName(Connection c) {
  size_t i = static_cast<size_t>(c);
  return i < std::size(kConnections) ? kConnections[i] : "NONE";
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

std::vector<Interaction> interactions(const NodeProps& p) {
  std::vector<Interaction> out;
  json::Value v;
  if (!extraJson(p, "prototypeInteractions", v) || !v.isArray()) return out;
  for (const json::Value& x : v.array) {
    if (!x.isObject() || flag(x.get("isDeleted"))) continue;
    Interaction i;
    i.id = guidOf(x.get("id"));
    if (const json::Value* e = x.get("event"); e && e->isObject()) {
      i.trigger = enumOf(e->get("interactionType"), kTriggers, Trigger::ON_CLICK);
      i.timeout = num(e->get("transitionTimeout"), 0.8);
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
  if (!extraJson(page, "prototypeBackgroundColor", v) || !v.isObject()) return Color::hex(0x1E1E1E);
  return {static_cast<float>(num(v.get("r"), 0)), static_cast<float>(num(v.get("g"), 0)), static_cast<float>(num(v.get("b"), 0)),
          static_cast<float>(num(v.get("a"), 1))};
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

std::vector<Flow> flows(const Document& doc, Guid page) {
  std::vector<Flow> out;
  for (Guid c : doc.children(page)) {
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
  return v;
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
  if (isSpring(a.easing)) return springAt(springOf(a), t * durationOf(a));
  switch (a.easing) {
    case Easing::LINEAR: return t;
    case Easing::IN_CUBIC:
    case Easing::EASE_IN: return bezier(0.42, 0, 1, 1, t);
    case Easing::OUT_CUBIC: return bezier(0, 0, 0.58, 1, t);
    case Easing::INOUT_CUBIC: return bezier(0.42, 0, 0.58, 1, t);
    case Easing::IN_BACK_CUBIC: return bezier(0.3, -0.05, 0.7, -0.5, t);
    case Easing::OUT_BACK_CUBIC: return bezier(0.45, 1.45, 0.8, 1, t);
    case Easing::INOUT_BACK_CUBIC: return bezier(0.7, -0.4, 0.4, 1.4, t);
    case Easing::CUSTOM_CUBIC:
      if (a.easingFunction.size() >= 4)
        return bezier(a.easingFunction[0], a.easingFunction[1], a.easingFunction[2], a.easingFunction[3], t);
      return bezier(0, 0, 0.58, 1, t);
    case Easing::HOLD: return t >= 1 ? 1 : 0;
    default: return t;
  }
}

double durationOf(const Action& a) {
  if (isSpring(a.easing)) return springDuration(springOf(a));
  return std::max(0.0, a.duration);
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
