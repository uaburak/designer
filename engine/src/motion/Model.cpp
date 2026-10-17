#include "motion/Model.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "scene/CodecKiwi.h"

namespace eng::motion {

namespace {

Guid guidOf(const json::Value* v) {
  if (!v) return kNoGuid;
  if (v->isString()) {
    bool ok = false;
    Guid g = Guid::parse(v->string, &ok);
    return ok ? g : kNoGuid;
  }
  if (v->isObject()) {
    const json::Value* s = v->get("sessionID");
    const json::Value* l = v->get("localID");
    if (s && l && s->isNumber() && l->isNumber()) return Guid{static_cast<uint32_t>(s->number), static_cast<uint32_t>(l->number)};
    // KeyframeTrackId / AnimationPresetId {guid, assetRef}
    if (const json::Value* g = v->get("guid")) return guidOf(g);
  }
  return kNoGuid;
}

Vec2 vecOf(const json::Value* v, Vec2 fallback) {
  if (!v || !v->isObject()) return fallback;
  const json::Value* x = v->get("x");
  const json::Value* y = v->get("y");
  return {x ? x->numberOr(fallback.x) : fallback.x, y ? y->numberOr(fallback.y) : fallback.y};
}

Color colorOf(const json::Value* v, Color fallback) {
  if (!v || !v->isObject()) return fallback;
  auto ch = [&](const char* k, float f) {
    const json::Value* c = v->get(k);
    return c ? static_cast<float>(c->numberOr(f)) : f;
  };
  return {ch("r", fallback.r), ch("g", fallback.g), ch("b", fallback.b), ch("a", fallback.a)};
}

Number numberOf(const json::Value* v, Number fallback) {
  if (!v || !v->isObject()) return fallback;
  Number n = fallback;
  if (const json::Value* x = v->get("value")) n.value = x->numberOr(fallback.value);
  if (const json::Value* u = v->get("units"); u && u->isString()) {
    if (u->string == "PIXELS") n.units = NumberUnits::PIXELS;
    else if (u->string == "PERCENT") n.units = NumberUnits::PERCENT;
    else n.units = NumberUnits::RAW;
  }
  return n;
}

template <typename E>
E enumOf(const json::Value* v, const char* const* names, size_t count, E fallback) {
  if (!v) return fallback;
  if (v->isNumber()) return static_cast<E>(static_cast<int>(v->number));
  if (!v->isString()) return fallback;
  for (size_t i = 0; i < count; i++)
    if (names[i] && std::strcmp(names[i], v->string.c_str()) == 0) return static_cast<E>(i);
  return fallback;
}

constexpr const char* kEasingNames[] = {"IN_CUBIC", "OUT_CUBIC", "INOUT_CUBIC", "LINEAR", "IN_BACK_CUBIC", "OUT_BACK_CUBIC",
                                        "INOUT_BACK_CUBIC", "CUSTOM_CUBIC", "SPRING", "GENTLE_SPRING", "CUSTOM_SPRING",
                                        "SPRING_PRESET_ONE", "SPRING_PRESET_TWO", "SPRING_PRESET_THREE", "HOLD", "EASE_IN"};
constexpr const char* kColorSpaces[] = {"DEFAULT", "OKLAB", "OKLCH", "HSL", "SRGB_LINEAR"};
constexpr const char* kHueMethods[] = {"SHORTER", "LONGER", "INCREASING", "DECREASING"};
constexpr const char* kOperations[] = {"SET", "SCALE", "OFFSET"};
constexpr const char* kPlaybacks[] = {"ONCE", "LOOP", "BOOMERANG"};

}  // namespace

json::Value extraJson(const NodeProps& p, const char* key) {
  json::Value v;
  auto it = p.extra.find(key);
  if (it == p.extra.end() || it->second.empty()) return v;
  if (!json::parse(codec::extraValueToJson("NodeChange", it->second), v)) v = json::Value();
  return v;
}

bool decodeEasing(const json::Value& e, EasingSpec& out) {
  out = EasingSpec{};
  if (!e.isObject()) return false;
  out.present = true;
  out.type = enumOf(e.get("easingType"), kEasingNames, 16, EasingType::IN_CUBIC);
  if (const json::Value* v = e.get("easingValue"); v && v->isObject()) {
    if (const json::Value* b = v->get("bezierEasing"); b && b->isObject()) {
      auto n = [&](const char* k, double f) {
        const json::Value* x = b->get(k);
        return x ? x->numberOr(f) : f;
      };
      out.bezier = {n("p1x", 0.5), n("p1y", 0), n("p2x", 0.5), n("p2y", 1)};
    }
    if (const json::Value* s = v->get("springEasing"); s && s->isObject()) {
      auto n = [&](const char* k, double f) {
        const json::Value* x = s->get(k);
        return x ? x->numberOr(f) : f;
      };
      Spring sp{n("mass", 1), n("stiffness", 100), n("damping", 15), 0};
      out.springValid = std::isfinite(sp.mass) && sp.mass > 0 && std::isfinite(sp.stiffness) && sp.stiffness > 0 &&
                        std::isfinite(sp.damping) && sp.damping >= 0;
      out.spring = out.springValid ? sp : kInvalidSpring;
    }
  }
  return true;
}

bool decodeKeyframeValue(const json::Value& kv, KeyframeValue& out) {
  out = KeyframeValue{};
  if (!kv.isObject()) return false;
  const json::Value* v = kv.get("value");
  if (!v || !v->isObject()) return false;
  if (const json::Value* f = v->get("floatValue")) {
    out.kind = ValueKind::FLOAT;
    out.f = f->numberOr(0);
  } else if (const json::Value* vec = v->get("vectorValue")) {
    out.kind = ValueKind::VECTOR;
    out.v = vecOf(vec, {0, 0});
  } else if (const json::Value* c = v->get("colorValue")) {
    out.kind = ValueKind::COLOR;
    out.c = colorOf(c, Color{0, 0, 0, 1});
  } else if (const json::Value* b = v->get("boolValue")) {
    out.kind = ValueKind::BOOL;
    out.b = b->isBool() && b->boolean;
  } else if (const json::Value* t = v->get("textDataValue")) {
    out.kind = ValueKind::TEXT;
    if (const json::Value* ch = t->get("characters"); ch && ch->isString()) out.text = ch->string;
  } else {
    out.kind = ValueKind::OTHER;
  }
  return true;
}

bool decodeKeyframe(const NodeProps& p, Guid id, Keyframe& out) {
  if (p.type != NodeType::KEYFRAME) return false;
  out = Keyframe{};
  out.id = id;
  json::Value pos = extraJson(p, "timelinePosition");
  out.timeUs = static_cast<int64_t>(std::llround(pos.numberOr(0)));
  if (out.timeUs < 0) out.timeUs = 0;
  decodeKeyframeValue(extraJson(p, "keyframeValue"), out.value);
  decodeEasing(extraJson(p, "easingData"), out.easing);
  json::Value cs = extraJson(p, "interpolationColorSpace");
  out.colorSpace = enumOf(&cs, kColorSpaces, 5, ColorSpace::DEFAULT);
  json::Value hm = extraJson(p, "interpolationHueMethod");
  out.hueMethod = enumOf(&hm, kHueMethods, 4, HueMethod::SHORTER);
  json::Value h = extraJson(p, "motionPathBezierHandles");
  if (h.isObject()) {
    auto n = [&](const char* k) {
      const json::Value* x = h.get(k);
      return x ? x->numberOr(0) : 0;
    };
    out.pathIn = {n("p1x"), n("p1y")};
    out.pathOut = {n("p2x"), n("p2y")};
    out.hasPathHandles = out.pathIn.x != 0 || out.pathIn.y != 0 || out.pathOut.x != 0 || out.pathOut.y != 0;
  }
  return true;
}

bool decodeTrack(const NodeProps& p, Guid id, Track& out) {
  if (p.type != NodeType::KEYFRAME_TRACK) return false;
  out = Track{};
  out.id = id;
  json::Value op = extraJson(p, "keyframeOperation");
  out.operation = enumOf(&op, kOperations, 3, Operation::SET);
  json::Value loop = extraJson(p, "trackLoopMode");
  out.loop = (loop.isString() && loop.string == "LOOP") || (loop.isNumber() && loop.number == 1);
  return true;
}

bool decodeParams(const VariableData& arg, std::vector<Param>& out) {
  out.clear();
  // The argument is a VariableData the engine doesn't model (dataType KEYFRAME_TRACK_PARAMETER_DATA): kept whole in
  // `extra`, read here as JSON.
  if (arg.kind != VariableData::Kind::OTHER || arg.extra.empty()) return false;
  std::string members = codec::extraToJsonMembers("VariableData", arg.extra);
  json::Value v;
  if (members.empty() || !json::parse("{" + members + "}", v)) return false;
  const json::Value* dt = v.get("dataType");
  if (!dt || !((dt->isString() && dt->string == "KEYFRAME_TRACK_PARAMETER_DATA") || (dt->isNumber() && dt->number == 21))) return false;
  const json::Value* val = v.get("value");
  const json::Value* ktp = val ? val->get("keyframeTrackParameterValue") : nullptr;
  const json::Value* params = ktp ? ktp->get("parameters") : nullptr;
  if (!params || !params->isArray()) return true;  // an empty list
  for (const json::Value& e : params->array) {
    Param p;
    const json::Value* type = e.get("type");
    const json::Value* value = e.get("value");
    bool preset = type && ((type->isString() && type->string == "ANIMATION_PRESET") || (type->isNumber() && type->number == 2));
    if (value) {
      if (const json::Value* m = value->get("manual"); m && !preset) {
        p.kind = Param::Kind::MANUAL;
        p.track = guidOf(m->get("keyframeTrackId"));
        p.timelineDef = guidOf(m->get("timelineDefId"));
      } else if (const json::Value* a = value->get("animationPreset")) {
        p.kind = Param::Kind::ANIMATION_PRESET;
        p.preset = guidOf(a->get("animationPresetId"));
        p.track = guidOf(a->get("keyframeTrackId"));
        p.timelineDef = guidOf(a->get("timelineDefId"));
      } else if (const json::Value* s = value->get("animationStyleBindingId")) {
        p.kind = Param::Kind::STYLE;
        p.styleBinding = guidOf(s);
      } else {
        continue;
      }
    } else {
      continue;
    }
    out.push_back(p);
  }
  return true;
}

LayerBase decodeLayerBase(const NodeProps& p) {
  LayerBase b;
  json::Value mt = extraJson(p, "motionTransform");
  if (mt.isObject()) {
    b.translation = vecOf(mt.get("translation"), {0, 0});
    if (const json::Value* r = mt.get("rotation")) b.rotation = r->numberOr(0);
    // kiwi's zero scale must not be read as 0: an absent scale is 1, 1 (docs/motion.md §4.1 defaults).
    if (const json::Value* s = mt.get("scale")) b.scale = vecOf(s, {1, 1});
    if (const json::Value* k = mt.get("shearX")) b.shear = k->numberOr(0);
  }
  json::Value to = extraJson(p, "transformOrigin");
  if (to.isObject()) {
    b.originX = numberOf(to.get("x"), b.originX);
    b.originY = numberOf(to.get("y"), b.originY);
  }
  json::Value link = extraJson(p, "linkMotionScaleAspectRatio");
  b.linkScale = link.isBool() && link.boolean;
  return b;
}

Assignment decodeAssignment(const NodeProps& instance, Guid assigned, Guid containing) {
  Assignment a;
  json::Value m = extraJson(instance, "timelineAssignments");
  const json::Value* entries = m.isObject() ? m.get("entries") : nullptr;
  if (!entries || !entries->isArray()) return a;
  for (const json::Value& e : entries->array) {
    const json::Value* key = e.get("key");
    if (!key || guidOf(key->get("assignedTimelineId")) != assigned || guidOf(key->get("containingTimelineId")) != containing) continue;
    a.found = true;
    if (const json::Value* v = e.get("value"); v && v->isObject()) {
      if (const json::Value* o = v->get("offsetUs")) a.offsetUs = static_cast<int64_t>(std::llround(o->numberOr(0)));
      if (const json::Value* d = v->get("disabled")) a.disabled = d->isBool() && d->boolean;
    }
    break;
  }
  return a;
}

bool isTimelineRoot(const Document& doc, Guid id) {
  const Node* n = doc.get(id);
  if (!n) return false;
  const NodeProps& p = n->props;
  if (p.type == NodeType::SYMBOL) return true;
  if (!(p.type == NodeType::FRAME || p.type == NodeType::INSTANCE)) return false;
  const Node* parent = doc.get(p.parentIndex.guid);
  if (!parent) return false;
  if (parent->props.type == NodeType::CANVAS) return true;
  // A section's direct child frame is top-level too.
  if (parent->props.type == NodeType::SECTION) {
    const Node* gp = doc.get(parent->props.parentIndex.guid);
    return gp && gp->props.type == NodeType::CANVAS;
  }
  return false;
}

void MotionIndex::clear() {
  tracks_.clear();
  nodes_.clear();
  playing_.clear();
}

void MotionIndex::rebuild(const Document& doc) {
  clear();
  // 1. Tracks and their keyframes.
  doc.forEach([&](const Node& n) {
    if (n.props.type != NodeType::KEYFRAME_TRACK || n.guid.isDerived()) return;
    Track t;
    if (!decodeTrack(n.props, n.guid, t)) return;
    for (Guid c : doc.children(n.guid)) {
      const Node* k = doc.get(c);
      Keyframe kf;
      if (k && decodeKeyframe(k->props, c, kf)) t.keyframes.push_back(std::move(kf));
    }
    // Positions are unique per track (writes upsert by µs); a duplicate from a file keeps the later child.
    std::stable_sort(t.keyframes.begin(), t.keyframes.end(), [](const Keyframe& a, const Keyframe& b) { return a.timeUs < b.timeUs; });
    for (size_t i = 1; i < t.keyframes.size();) {
      if (t.keyframes[i].timeUs == t.keyframes[i - 1].timeUs) t.keyframes.erase(t.keyframes.begin() + static_cast<long>(i - 1));
      else i++;
    }
    tracks_[n.guid] = std::move(t);
  });
  // 2. Bindings: the KEYFRAME expressions on node fields, paints and effects.
  auto keyframeExpr = [&](const VariableData& d, Binding& b) {
    if (d.kind != VariableData::Kind::EXPRESSION || d.function != ExpressionFunction::KEYFRAME || d.args.empty()) return false;
    b.base = d.args[0];
    if (d.args.size() >= 2) decodeParams(d.args[1], b.params);
    return true;
  };
  doc.forEach([&](const Node& n) {
    const NodeProps& p = n.props;
    if (n.guid.isDerived()) return;  // instance sublayers: round 8a's next increment (their main's tracks, offset)
    if (p.type == NodeType::KEYFRAME || p.type == NodeType::KEYFRAME_TRACK || p.type == NodeType::ANIMATION_PRESET_INSTANCE) return;
    AnimatedNode an;
    for (const ParamBinding& pb : p.parameterConsumptionMap) {
      if (!pb.isVariable()) continue;
      Binding b;
      if (!keyframeExpr(pb.data, b)) continue;
      b.slot.kind = Slot::Kind::NODE;
      b.slot.field = pb.field;
      if (!fieldInfo(pb.field)) continue;  // X_POSITION and the like: round trip only
      an.bindings.push_back(std::move(b));
    }
    auto paints = [&](const std::vector<Paint>& list, Slot::Kind colorKind, Slot::Kind opacityKind) {
      for (size_t i = 0; i < list.size(); i++) {
        Binding b;
        if (list[i].colorVar.present() && keyframeExpr(list[i].colorVar, b)) {
          b.slot.kind = colorKind;
          b.slot.index = static_cast<uint32_t>(i);
          an.bindings.push_back(std::move(b));
        }
        Binding o;
        if (list[i].opacityVar.present() && keyframeExpr(list[i].opacityVar, o)) {
          o.slot.kind = opacityKind;
          o.slot.index = static_cast<uint32_t>(i);
          an.bindings.push_back(std::move(o));
        }
      }
    };
    paints(p.fillPaints, Slot::Kind::FILL_COLOR, Slot::Kind::FILL_OPACITY);
    paints(p.strokePaints, Slot::Kind::STROKE_COLOR, Slot::Kind::STROKE_OPACITY);
    for (size_t i = 0; i < p.effects.size(); i++) {
      const Effect& e = p.effects[i];
      struct Pair {
        const VarBox* box;
        Slot::EffectField field;
      } slots[] = {{&e.radiusVar, Slot::EffectField::RADIUS}, {&e.colorVar, Slot::EffectField::COLOR}, {&e.spreadVar, Slot::EffectField::SPREAD},
                   {&e.xVar, Slot::EffectField::OFFSET_X}, {&e.yVar, Slot::EffectField::OFFSET_Y}};
      for (const Pair& s : slots) {
        Binding b;
        if (!s.box->present() || !keyframeExpr(*s.box, b)) continue;
        b.slot.kind = Slot::Kind::EFFECT;
        b.slot.index = static_cast<uint32_t>(i);
        b.slot.effect = s.field;
        an.bindings.push_back(std::move(b));
      }
    }
    if (an.bindings.empty()) return;
    an.id = n.guid;
    an.base = decodeLayerBase(p);
    nodes_[n.guid] = std::move(an);
  });
  // 3. The roots that play: those with animated layers, then those holding an instance of one (a main nested in
  // another main's timeline plays there too), until nothing more is reached.
  std::vector<std::pair<Guid, Guid>> instances;  // (instance, its main)
  doc.forEach([&](const Node& n) {
    if (n.guid.isDerived()) return;
    if (n.props.type == NodeType::INSTANCE) instances.push_back({n.guid, n.props.comp().symbolData.symbolID});
  });
  for (const auto& entry : nodes_)
    if (Guid r = rootOf(doc, entry.first); r != kNoGuid && r != entry.first) playing_.insert(r);
  for (bool grew = true; grew;) {
    grew = false;
    for (auto& [inst, main] : instances) {
      if (!playing_.count(main)) continue;
      Guid r = rootOf(doc, inst);
      if (r != kNoGuid && playing_.insert(r).second) grew = true;
    }
  }
}

const Track* MotionIndex::track(Guid id) const {
  auto it = tracks_.find(id);
  return it == tracks_.end() ? nullptr : &it->second;
}

const AnimatedNode* MotionIndex::node(Guid id) const {
  auto it = nodes_.find(id);
  return it == nodes_.end() ? nullptr : &it->second;
}

Guid MotionIndex::rootOf(const Document& doc, Guid id) const {
  for (Guid cur = id; cur != kNoGuid; cur = doc.parentOf(cur)) {
    if (isTimelineRoot(doc, cur)) return cur;
    const Node* n = doc.get(cur);
    if (!n || n->props.type == NodeType::CANVAS || n->props.type == NodeType::DOCUMENT) break;
  }
  return kNoGuid;
}

Timeline MotionIndex::timeline(const Document& doc, Guid root) const {
  Timeline t;
  t.root = root;
  const Node* n = doc.get(root);
  if (!n) return t;
  const NodeProps& p = n->props;
  json::Value d = extraJson(p, "timelineDuration");
  if (d.isNumber() && d.number > 0) t.durationUs = static_cast<int64_t>(std::llround(d.number));
  json::Value pb = extraJson(p, "playbackStyle");
  t.playback = enumOf(&pb, kPlaybacks, 3, Playback::LOOP);
  json::Value fps = extraJson(p, "timelineKeyframeSnappingFps");
  if (fps.isObject()) {
    if (const json::Value* num = fps.get("numerator"); num && num->numberOr(0) > 0) t.fpsNumerator = static_cast<uint32_t>(num->number);
    if (const json::Value* den = fps.get("denominator"); den && den->numberOr(0) > 0) t.fpsDenominator = static_cast<uint32_t>(den->number);
  }
  json::Value dis = extraJson(p, "timelineDisabled");
  t.disabled = dis.isBool() && dis.boolean;
  json::Value off = extraJson(p, "timelineOffset");
  if (off.isNumber()) t.offsetUs = static_cast<int64_t>(std::llround(off.number));
  return t;
}

std::vector<Guid> MotionIndex::animatedUnder(const Document& doc, Guid root) const {
  std::vector<Guid> out;
  if (!doc.has(root)) return out;
  auto visit = [&](auto&& self, Guid id) -> void {
    for (Guid c : doc.children(id)) {
      if (c.isDerived()) continue;
      if (nodes_.count(c)) out.push_back(c);
      self(self, c);
    }
  };
  visit(visit, root);
  return out;
}

}  // namespace eng::motion
