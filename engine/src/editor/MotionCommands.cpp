// Figma Motion's editing commands and reads (docs/motion.md §4.2, §4.9, §10; round 8b, increments 1–2): keyframes
// added, moved, re-valued, eased and deleted on KEYFRAME_TRACK nodes bound through KEYFRAME expressions; the root's
// timeline; the anchor (kept in place); the motion path's handles; the layer bar's retime; the timeline model, the right
// panel's diamonds and the resolved model as JSON; panel writes and canvas gestures (move, resize, rotate, nudge)
// routed into keyframes while Motion is on; tracks removed with their last layer, and copied with a duplicated, pasted
// or detached one. Round 8a increment 2: an animated instance's offset (341) and its bar and sublayers in the reads,
// path trim's panel write routed, the layout of what the motion layer resized (its previews), the motion path and the
// anchor point tool on the canvas. Round 8h: animation presets (336–338, 352) and composite styles (339) — clips whose
// materialised tracks (the TypeScript runtime's output) are their own children, bound through ANIMATION_PRESET
// parameters — copied and removed with their layers, a text preset's stagger timed to the text's elements. Round 8e:
// audio clips and their rows on a timeline root (345–348) and in the timeline model. Round 8i: easings bound to EASING
// variables (a keyframe's EASING_DATA alias; a clip's Easing) and a clip's Delay / Duration to TIMING ones, a text's
// own stagger (344), keyframes pasted (349), X / Y tracks combined into XY and split back (350–351).
//
// Not yet: keyframe values bound to variables, the corner radius / shape handles and the Scale tool routed, the
// motion path's squares and handles dragged on the canvas.
#include <algorithm>
#include <cmath>

#include "editor/Editor.h"
#include "motion/Evaluate.h"
#include "scene/CodecKiwi.h"

namespace eng {

namespace {

using motion::EasingSpec;
using motion::EasingType;
using motion::KeyframeValue;
using motion::Slot;
using motion::ValueKind;

const json::Value* member(const json::Value& o, const char* k) { return o.isObject() ? o.get(k) : nullptr; }
const json::Value* member(const json::Value* o, const char* k) { return o ? member(*o, k) : nullptr; }

// A GUID as the args give it ("s:l"), or as a field read back from `extra` gives it ({sessionID, localID}).
bool guidOf(const json::Value* v, Guid& out) {
  if (v && v->isObject()) {
    const json::Value* s = v->get("sessionID");
    const json::Value* l = v->get("localID");
    if (!s || !l || !s->isNumber() || !l->isNumber()) return false;
    out = Guid{static_cast<uint32_t>(s->number), static_cast<uint32_t>(l->number)};
    return true;
  }
  if (!v || !v->isString()) return false;
  bool ok = false;
  out = Guid::parse(v->string, &ok);
  return ok;
}

// An easing bound to a variable ({"variable": "s:l"}, src/shared/motion/types.ts EasingRef; round 8i): its GUID.
bool easingVariableOf(const json::Value* v, Guid& out) { return guidOf(member(v, "variable"), out); }

std::string encodeExtra(const char* key, const json::Value& v) { return codec::extraFromJson("NodeChange", key, v); }

json::Value jnum(double v) {
  json::Value x;
  x.kind = json::Value::Kind::Number;
  x.number = v;
  return x;
}
json::Value jstr(std::string s) {
  json::Value x;
  x.kind = json::Value::Kind::String;
  x.string = std::move(s);
  return x;
}
json::Value jbool(bool b) {
  json::Value x;
  x.kind = json::Value::Kind::Bool;
  x.boolean = b;
  return x;
}
json::Value jobj() {
  json::Value x;
  x.kind = json::Value::Kind::Object;
  return x;
}
json::Value& put(json::Value& o, const char* k, json::Value v) {
  for (auto& [key, val] : o.object)
    if (key == k) {
      val = std::move(v);
      return val;
    }
  o.object.emplace_back(k, std::move(v));
  return o.object.back().second;
}
json::Value jvec(Vec2 v) {
  json::Value o = jobj();
  put(o, "x", jnum(v.x));
  put(o, "y", jnum(v.y));
  return o;
}
json::Value jcolor(Color c) {
  json::Value o = jobj();
  put(o, "r", jnum(c.r));
  put(o, "g", jnum(c.g));
  put(o, "b", jnum(c.b));
  put(o, "a", jnum(c.a));
  return o;
}

void putExtra(NodeChange& c, const char* key, std::string value) {
  c.mask |= F_EXTRA;
  c.props.extra[key] = std::move(value);
}

// ---- Public names ↔ the model (src/shared/motion/types.ts) ----

constexpr struct {
  const char* publicName;
  EasingType type;
} kEasingNames[] = {{"HOLD", EasingType::HOLD},
                    {"LINEAR", EasingType::LINEAR},
                    {"EASE_IN", EasingType::EASE_IN},
                    {"EASE_OUT", EasingType::OUT_CUBIC},
                    {"EASE_IN_AND_OUT", EasingType::INOUT_CUBIC},
                    {"EASE_IN_BACK", EasingType::IN_BACK_CUBIC},
                    {"EASE_OUT_BACK", EasingType::OUT_BACK_CUBIC},
                    {"EASE_IN_AND_OUT_BACK", EasingType::INOUT_BACK_CUBIC},
                    {"GENTLE", EasingType::GENTLE_SPRING},
                    {"QUICK", EasingType::SPRING_PRESET_ONE},
                    {"BOUNCY", EasingType::SPRING_PRESET_TWO},
                    {"SLOW", EasingType::SPRING_PRESET_THREE},
                    {"CUSTOM_CUBIC_BEZIER", EasingType::CUSTOM_CUBIC},
                    {"CUSTOM_SPRING", EasingType::CUSTOM_SPRING}};
constexpr const char* kSchemaEasingNames[] = {"IN_CUBIC", "OUT_CUBIC", "INOUT_CUBIC", "LINEAR", "IN_BACK_CUBIC", "OUT_BACK_CUBIC",
                                              "INOUT_BACK_CUBIC", "CUSTOM_CUBIC", "SPRING", "GENTLE_SPRING", "CUSTOM_SPRING",
                                              "SPRING_PRESET_ONE", "SPRING_PRESET_TWO", "SPRING_PRESET_THREE", "HOLD", "EASE_IN"};

const char* publicEasingName(EasingType t) {
  if (t == EasingType::IN_CUBIC) return "EASE_IN";
  if (t == EasingType::SPRING) return "GENTLE";
  for (auto& e : kEasingNames)
    if (e.type == t) return e.publicName;
  return "CUSTOM_CUBIC_BEZIER";
}

// A public MotionEasing → EasingData as JSON (for the node's `easingData` extra); false on a bad input. A variable
// binding ({"variable": …}) is not taken yet.
bool easingFromPublic(const json::Value& v, json::Value& out, EasingSpec* spec = nullptr) {
  const json::Value* type = member(v, "type");
  if (!type || !type->isString()) return false;
  EasingType t = EasingType::IN_CUBIC;
  bool found = false;
  for (auto& e : kEasingNames)
    if (type->string == e.publicName) t = e.type, found = true;
  if (!found) return false;
  out = jobj();
  put(out, "easingType", jstr(kSchemaEasingNames[static_cast<int>(t)]));
  EasingSpec s;
  s.present = true;
  s.type = t;
  if (t == EasingType::CUSTOM_CUBIC) {
    const json::Value* b = member(v, "easingFunctionCubicBezier");
    double x1 = 0.5, y1 = 0, x2 = 0.5, y2 = 1;
    if (b && b->isObject()) {
      if (auto* a = b->get("x1")) x1 = std::clamp(a->numberOr(0.5), 0.0, 1.0);
      if (auto* a = b->get("y1")) y1 = a->numberOr(0);
      if (auto* a = b->get("x2")) x2 = std::clamp(a->numberOr(0.5), 0.0, 1.0);
      if (auto* a = b->get("y2")) y2 = a->numberOr(1);
    }
    json::Value val = jobj(), bez = jobj();
    put(bez, "p1x", jnum(x1));
    put(bez, "p1y", jnum(y1));
    put(bez, "p2x", jnum(x2));
    put(bez, "p2y", jnum(y2));
    put(val, "bezierEasing", bez);
    put(out, "easingValue", val);
    s.bezier = {x1, y1, x2, y2};
  } else if (t == EasingType::CUSTOM_SPRING) {
    const json::Value* sp = member(v, "easingFunctionSpring");
    double bounce = 0.25;
    if (auto* b = member(sp, "bounce")) bounce = std::clamp(b->numberOr(0.25), 0.0, 1.0);
    motion::Spring phys = motion::springFromBounce(bounce);
    json::Value val = jobj(), spring = jobj();
    put(spring, "mass", jnum(phys.mass));
    put(spring, "stiffness", jnum(phys.stiffness));
    put(spring, "damping", jnum(phys.damping));
    put(spring, "springType", jstr("NORMALIZED"));
    put(val, "springEasing", spring);
    put(out, "easingValue", val);
    s.spring = phys;
  }
  if (spec) *spec = s;
  return true;
}

void writePublicEasing(json::Writer& w, const EasingSpec& e) {
  w.beginObject();
  if (!e.present || e.type == EasingType::IN_CUBIC) {
    // The default keyframe easing (docs/motion.md §4.7): CUSTOM_CUBIC (0.5, 0, 0.5, 1).
    w.key("type").string("CUSTOM_CUBIC_BEZIER");
    w.key("easingFunctionCubicBezier").beginObject().key("x1").number(0.5).key("y1").number(0).key("x2").number(0.5).key("y2").number(1).endObject();
  } else {
    w.key("type").string(publicEasingName(e.type));
    if (e.type == EasingType::CUSTOM_CUBIC)
      w.key("easingFunctionCubicBezier").beginObject().key("x1").number(e.bezier.x1).key("y1").number(e.bezier.y1).key("x2").number(e.bezier.x2).key("y2").number(e.bezier.y2).endObject();
    else if (e.type == EasingType::CUSTOM_SPRING)
      w.key("easingFunctionSpring").beginObject().key("bounce").number(motion::bounceOf(e.springValid ? e.spring : motion::kInvalidSpring)).endObject();
  }
  w.endObject();
}

// The InterpolationType mirror of an easing (docs/motion.md §4.7): HOLD → HOLD, springs → SPRING, the rest BEZIER.
const char* interpolationTypeOf(EasingType t) {
  if (t == EasingType::HOLD) return "HOLD";
  if (t == EasingType::CUSTOM_SPRING || t == EasingType::SPRING || t == EasingType::GENTLE_SPRING || t == EasingType::SPRING_PRESET_ONE ||
      t == EasingType::SPRING_PRESET_TWO || t == EasingType::SPRING_PRESET_THREE)
    return "SPRING";
  return "BEZIER";
}

// A public KeyframeField ({type: "PROPERTY", name} | {type: "INDEXED_ITEM", collection, index, opacity? | field?}) → Slot.
bool slotFromPublic(const json::Value* f, Slot& out) {
  const json::Value* type = member(f, "type");
  if (!type || !type->isString()) return false;
  out = Slot{};
  if (type->string == "PROPERTY") {
    const json::Value* name = member(f, "name");
    if (!name || !name->isString()) return false;
    const motion::FieldInfo* info = motion::fieldByPublicName(name->string.c_str());
    if (!info) return false;
    out.kind = Slot::Kind::NODE;
    out.field = info->field;
    return true;
  }
  if (type->string != "INDEXED_ITEM") return false;
  const json::Value* coll = member(f, "collection");
  const json::Value* index = member(f, "index");
  if (!coll || !coll->isString() || !index || !index->isNumber() || index->number < 0) return false;
  out.index = static_cast<uint32_t>(index->number);
  if (coll->string == "fills" || coll->string == "strokes") {
    bool fill = coll->string == "fills";
    const json::Value* op = member(f, "opacity");
    bool opacity = op && op->isBool() && op->boolean;
    out.kind = fill ? (opacity ? Slot::Kind::FILL_OPACITY : Slot::Kind::FILL_COLOR) : (opacity ? Slot::Kind::STROKE_OPACITY : Slot::Kind::STROKE_COLOR);
    return true;
  }
  if (coll->string == "effects") {
    const json::Value* field = member(f, "field");
    if (!field || !field->isString()) return false;
    out.kind = Slot::Kind::EFFECT;
    if (field->string == "RADIUS") out.effect = Slot::EffectField::RADIUS;
    else if (field->string == "COLOR") out.effect = Slot::EffectField::COLOR;
    else if (field->string == "SPREAD") out.effect = Slot::EffectField::SPREAD;
    else if (field->string == "OFFSET_X") out.effect = Slot::EffectField::OFFSET_X;
    else if (field->string == "OFFSET_Y") out.effect = Slot::EffectField::OFFSET_Y;
    else return false;
    return true;
  }
  return false;
}

const char* effectFieldName(Slot::EffectField f) {
  switch (f) {
    case Slot::EffectField::RADIUS: return "RADIUS";
    case Slot::EffectField::COLOR: return "COLOR";
    case Slot::EffectField::SPREAD: return "SPREAD";
    case Slot::EffectField::OFFSET_X: return "OFFSET_X";
    case Slot::EffectField::OFFSET_Y: return "OFFSET_Y";
  }
  return "RADIUS";
}

// The slot's stable key (src/shared/motion/types.ts fieldKey): "OPACITY", "fills[0]", "fills[0].opacity", "effects[1].RADIUS".
std::string keyOf(const Slot& s) {
  switch (s.kind) {
    case Slot::Kind::NODE: {
      const motion::FieldInfo* info = motion::fieldInfo(s.field);
      return info && info->publicName[0] ? info->publicName : enumName(s.field);
    }
    case Slot::Kind::FILL_COLOR: return "fills[" + std::to_string(s.index) + "]";
    case Slot::Kind::FILL_OPACITY: return "fills[" + std::to_string(s.index) + "].opacity";
    case Slot::Kind::STROKE_COLOR: return "strokes[" + std::to_string(s.index) + "]";
    case Slot::Kind::STROKE_OPACITY: return "strokes[" + std::to_string(s.index) + "].opacity";
    case Slot::Kind::EFFECT: return "effects[" + std::to_string(s.index) + "]." + effectFieldName(s.effect);
  }
  return "";
}

void writePublicField(json::Writer& w, const Slot& s) {
  w.beginObject();
  switch (s.kind) {
    case Slot::Kind::NODE: {
      const motion::FieldInfo* info = motion::fieldInfo(s.field);
      w.key("type").string("PROPERTY").key("name").string(info && info->publicName[0] ? info->publicName : enumName(s.field));
      break;
    }
    case Slot::Kind::FILL_COLOR:
    case Slot::Kind::FILL_OPACITY:
    case Slot::Kind::STROKE_COLOR:
    case Slot::Kind::STROKE_OPACITY:
      w.key("type").string("INDEXED_ITEM").key("collection").string(s.kind == Slot::Kind::FILL_COLOR || s.kind == Slot::Kind::FILL_OPACITY ? "fills" : "strokes");
      w.key("index").number(s.index);
      if (s.kind == Slot::Kind::FILL_OPACITY || s.kind == Slot::Kind::STROKE_OPACITY) w.key("opacity").boolean(true);
      break;
    case Slot::Kind::EFFECT:
      w.key("type").string("INDEXED_ITEM").key("collection").string("effects").key("index").number(s.index).key("field").string(effectFieldName(s.effect));
      break;
  }
  w.endObject();
}

// The track's row name in the timeline (docs/motion.md §6.2 [unverified]).
std::string labelOf(const Slot& s) {
  switch (s.kind) {
    case Slot::Kind::NODE:
      switch (s.field) {
        case VariableField::OPACITY: return "Opacity";
        case VariableField::CORNER_RADIUS: return "Corner radius";
        case VariableField::STROKE_WEIGHT: return "Stroke weight";
        case VariableField::WIDTH: return "Width";
        case VariableField::HEIGHT: return "Height";
        case VariableField::MOTION_TRANSLATION_X: return "Position X";
        case VariableField::MOTION_TRANSLATION_Y: return "Position Y";
        case VariableField::MOTION_TRANSLATION_XY: return "Position";
        case VariableField::MOTION_ROTATION: return "Rotation";
        case VariableField::MOTION_SCALE_X: return "Scale X";
        case VariableField::MOTION_SCALE_Y: return "Scale Y";
        case VariableField::MOTION_SCALE_XY: return "Scale";
        case VariableField::PATH_TRIM_START: return "Path trim start";
        case VariableField::PATH_TRIM_END: return "Path trim end";
        default: return keyOf(s);
      }
    case Slot::Kind::FILL_COLOR: return "Fill " + std::to_string(s.index + 1);
    case Slot::Kind::FILL_OPACITY: return "Fill " + std::to_string(s.index + 1) + " opacity";
    case Slot::Kind::STROKE_COLOR: return "Stroke " + std::to_string(s.index + 1);
    case Slot::Kind::STROKE_OPACITY: return "Stroke " + std::to_string(s.index + 1) + " opacity";
    case Slot::Kind::EFFECT: return "Effect " + std::to_string(s.index + 1) + " · " + effectFieldName(s.effect);
  }
  return "";
}

ValueKind slotKind(const Slot& s) {
  switch (s.kind) {
    case Slot::Kind::NODE: {
      const motion::FieldInfo* info = motion::fieldInfo(s.field);
      return info ? info->value : ValueKind::FLOAT;
    }
    case Slot::Kind::FILL_COLOR:
    case Slot::Kind::STROKE_COLOR: return ValueKind::COLOR;
    case Slot::Kind::EFFECT: return s.effect == Slot::EffectField::COLOR ? ValueKind::COLOR : ValueKind::FLOAT;
    default: return ValueKind::FLOAT;
  }
}

// Public units ↔ stored (docs/motion.md §4.5): node fields through the table; paints and effects as they are.
double toStored(const Slot& s, double v) {
  if (s.kind != Slot::Kind::NODE) return v;
  const motion::FieldInfo* info = motion::fieldInfo(s.field);
  return info ? motion::nodeToStored(*info, v) : v;
}
double toPublic(const Slot& s, double v) {
  if (s.kind != Slot::Kind::NODE) return v;
  const motion::FieldInfo* info = motion::fieldInfo(s.field);
  return info ? motion::storedToNode(*info, v) : v;
}

// A public KeyframeValue ({type, value}) → the stored value; false on a bad input or a kind the slot doesn't take.
bool valueFromPublic(const json::Value* v, const Slot& slot, KeyframeValue& out) {
  const json::Value* type = member(v, "type");
  const json::Value* val = member(v, "value");
  if (!type || !type->isString() || !val) return false;
  ValueKind want = slotKind(slot);
  if (type->string == "FLOAT" && val->isNumber()) {
    if (want == ValueKind::VECTOR) {
      out = KeyframeValue::vector({val->number, val->number});  // a FLOAT on an XY track is uniform
      return true;
    }
    if (want != ValueKind::FLOAT) return false;
    out = KeyframeValue::number(toStored(slot, val->number));
    return true;
  }
  if (type->string == "VECTOR" && val->isObject() && want == ValueKind::VECTOR) {
    out = KeyframeValue::vector({member(val, "x") ? member(val, "x")->numberOr(0) : 0, member(val, "y") ? member(val, "y")->numberOr(0) : 0});
    return true;
  }
  if (type->string == "COLOR" && val->isObject() && want == ValueKind::COLOR) {
    auto ch = [&](const char* k, float f) {
      const json::Value* c = val->get(k);
      return c ? static_cast<float>(std::clamp(c->numberOr(f), 0.0, 1.0)) : f;
    };
    out = KeyframeValue::color({ch("r", 0), ch("g", 0), ch("b", 0), ch("a", 1)});
    return true;
  }
  return false;
}

void writePublicValue(json::Writer& w, const Slot& slot, const KeyframeValue& v) {
  w.beginObject();
  switch (v.kind) {
    case ValueKind::VECTOR: w.key("type").string("VECTOR").key("value").beginObject().key("x").number(v.v.x).key("y").number(v.v.y).endObject(); break;
    case ValueKind::COLOR:
      w.key("type").string("COLOR").key("value").beginObject().key("r").number(v.c.r).key("g").number(v.c.g).key("b").number(v.c.b).key("a").number(v.c.a).endObject();
      break;
    case ValueKind::BOOL: w.key("type").string("BOOL").key("value").boolean(v.b); break;
    case ValueKind::TEXT: w.key("type").string("TEXT_DATA").key("value").string(v.text); break;
    default: w.key("type").string("FLOAT").key("value").number(toPublic(slot, v.f)); break;
  }
  w.endObject();
}

// The stored value as the node's `keyframeValue` extra (KeyframeValueData {value, valueType}).
json::Value keyframeValueJson(const KeyframeValue& v) {
  json::Value kv = jobj(), val = jobj();
  switch (v.kind) {
    case ValueKind::VECTOR:
      put(val, "vectorValue", jvec(v.v));
      put(kv, "valueType", jstr("VECTOR"));
      break;
    case ValueKind::COLOR:
      put(val, "colorValue", jcolor(v.c));
      put(kv, "valueType", jstr("COLOR"));
      break;
    case ValueKind::BOOL:
      put(val, "boolValue", jbool(v.b));
      put(kv, "valueType", jstr("BOOL"));
      break;
    default:
      put(val, "floatValue", jnum(v.f));
      put(kv, "valueType", jstr("FLOAT"));
      break;
  }
  put(kv, "value", val);
  return kv;
}

// The KEYFRAME expression's second argument: a VariableData the engine keeps whole (kind OTHER), encoded from JSON.
VariableData paramsArg(const std::vector<motion::Param>& params) {
  json::Value list;
  list.kind = json::Value::Kind::Array;
  for (const motion::Param& p : params) {
    json::Value e = jobj(), value = jobj();
    if (p.kind == motion::Param::Kind::MANUAL) {
      json::Value m = jobj(), tid = jobj();
      put(tid, "guid", jstr(p.track.toString()));
      put(m, "keyframeTrackId", tid);
      put(m, "timelineDefId", jstr(p.timelineDef.toString()));
      put(value, "manual", m);
      put(e, "type", jstr("MANUAL"));
    } else if (p.kind == motion::Param::Kind::ANIMATION_PRESET) {
      json::Value a = jobj(), pid = jobj(), tid = jobj();
      put(pid, "guid", jstr(p.preset.toString()));
      put(tid, "guid", jstr(p.track.toString()));
      put(a, "animationPresetId", pid);
      put(a, "keyframeTrackId", tid);
      put(a, "timelineDefId", jstr(p.timelineDef.toString()));
      put(value, "animationPreset", a);
      put(e, "type", jstr("ANIMATION_PRESET"));
    } else {
      put(value, "animationStyleBindingId", jstr(p.styleBinding.toString()));
      put(e, "type", jstr("MANUAL"));
    }
    put(e, "value", value);
    list.array.push_back(e);
  }
  json::Value ktp = jobj(), val = jobj();
  put(ktp, "parameters", list);
  put(val, "keyframeTrackParameterValue", ktp);
  VariableData d;
  d.kind = VariableData::Kind::OTHER;
  d.extra = codec::extraFromJson("VariableData", "dataType", jstr("KEYFRAME_TRACK_PARAMETER_DATA")) +
            codec::extraFromJson("VariableData", "resolvedDataType", jstr("KEYFRAME_TRACK_PARAMETER_DATA")) +
            codec::extraFromJson("VariableData", "value", val);
  return d;
}

VariableData keyframeExpression(VariableData base, const std::vector<motion::Param>& params) {
  VariableData d;
  d.kind = VariableData::Kind::EXPRESSION;
  d.function = ExpressionFunction::KEYFRAME;
  d.hasDataType = d.hasResolvedType = true;
  d.dataType = VariableDataType::EXPRESSION;
  d.resolvedDataType = base.hasResolvedType ? base.resolvedDataType : (base.kind == VariableData::Kind::COLOR ? VariableResolvedType::COLOR : VariableResolvedType::FLOAT);
  d.args.push_back(std::move(base));
  d.args.push_back(paramsArg(params));
  return d;
}

bool isKeyframeExpression(const VariableData& d) { return d.kind == VariableData::Kind::EXPRESSION && d.function == ExpressionFunction::KEYFRAME && !d.args.empty(); }

int64_t roundUs(double us) { return static_cast<int64_t>(std::llround(std::max(0.0, us))); }

Slot nodeSlot(VariableField f) {
  Slot s;
  s.kind = Slot::Kind::NODE;
  s.field = f;
  return s;
}

// Calls `f(slot, data)` for each slot of a node holding a KEYFRAME expression with its parameters: its fields, its
// paints' colour and opacity, its effects' fields.
template <class F>
void forEachKeyframeSlot(const NodeProps& p, F&& f) {
  auto visit = [&](const VariableData& d, const Slot& s) {
    if (isKeyframeExpression(d) && d.args.size() >= 2) f(s, d);
  };
  for (const ParamBinding& b : p.parameterConsumptionMap)
    if (b.isVariable()) visit(b.data, nodeSlot(b.field));
  auto paints = [&](const std::vector<Paint>& list, Slot::Kind colorKind, Slot::Kind opacityKind) {
    for (size_t i = 0; i < list.size(); i++) {
      Slot s;
      s.index = static_cast<uint32_t>(i);
      s.kind = colorKind;
      if (list[i].colorVar.present()) visit(list[i].colorVar, s);
      s.kind = opacityKind;
      if (list[i].opacityVar.present()) visit(list[i].opacityVar, s);
    }
  };
  paints(p.fillPaints, Slot::Kind::FILL_COLOR, Slot::Kind::FILL_OPACITY);
  paints(p.strokePaints, Slot::Kind::STROKE_COLOR, Slot::Kind::STROKE_OPACITY);
  for (size_t i = 0; i < p.effects.size(); i++) {
    const Effect& e = p.effects[i];
    Slot s;
    s.kind = Slot::Kind::EFFECT;
    s.index = static_cast<uint32_t>(i);
    struct Pair {
      const VarBox* box;
      Slot::EffectField f;
    } slots[] = {{&e.radiusVar, Slot::EffectField::RADIUS}, {&e.colorVar, Slot::EffectField::COLOR}, {&e.spreadVar, Slot::EffectField::SPREAD},
                 {&e.xVar, Slot::EffectField::OFFSET_X}, {&e.yVar, Slot::EffectField::OFFSET_Y}};
    for (const Pair& q : slots)
      if (q.box->present()) {
        s.effect = q.f;
        visit(*q.box, s);
      }
  }
}

// Writes `data` into the slot on `p` (its list must be in `p`); an absent `data` (kind NONE) unbinds it. False when the
// node has no such slot.
bool putSlot(NodeProps& p, const Slot& s, const VariableData& data) {
  switch (s.kind) {
    case Slot::Kind::NODE: {
      auto& map = p.parameterConsumptionMap;
      map.erase(std::remove_if(map.begin(), map.end(), [&](const ParamBinding& b) { return b.field == s.field; }), map.end());
      if (data.present()) {
        ParamBinding b;
        b.field = s.field;
        b.data = data;
        map.push_back(std::move(b));
      }
      return true;
    }
    case Slot::Kind::FILL_COLOR:
    case Slot::Kind::FILL_OPACITY:
    case Slot::Kind::STROKE_COLOR:
    case Slot::Kind::STROKE_OPACITY: {
      bool fill = s.kind == Slot::Kind::FILL_COLOR || s.kind == Slot::Kind::FILL_OPACITY;
      std::vector<Paint>& list = fill ? p.fillPaints : p.strokePaints;
      if (s.index >= list.size()) return false;
      if (s.kind == Slot::Kind::FILL_COLOR || s.kind == Slot::Kind::STROKE_COLOR) list[s.index].colorVar = data;
      else list[s.index].opacityVar = data;
      return true;
    }
    case Slot::Kind::EFFECT: {
      if (s.index >= p.effects.size()) return false;
      Effect& e = p.effects[s.index];
      switch (s.effect) {
        case Slot::EffectField::RADIUS: e.radiusVar = data; break;
        case Slot::EffectField::COLOR: e.colorVar = data; break;
        case Slot::EffectField::SPREAD: e.spreadVar = data; break;
        case Slot::EffectField::OFFSET_X: e.xVar = data; break;
        case Slot::EffectField::OFFSET_Y: e.yVar = data; break;
      }
      return true;
    }
  }
  return false;
}

// The motion transform's linear part L = R(r) · Shear(k) · S(s), r stored (−radians), as MotionLayer::motionTransform.
Mat2x3 motionLinear(double rotation, double shear, Vec2 scale) {
  return Mat2x3::rotate(rotation) * Mat2x3{1, shear, 0, 0, 1, 0} * Mat2x3{scale.x, 0, 0, 0, scale.y, 0};
}

Mat2x3 linearPart(Mat2x3 m) {
  m.m02 = m.m12 = 0;
  return m;
}

// An AnimationPresetId / KeyframeTrackId as JSON ({guid}).
json::Value idJson(Guid g) {
  json::Value o = jobj();
  put(o, "guid", jstr(g.toString()));
  return o;
}

// A preset's props (round 8h) as the instance's `componentPropAssignments`: each key a prop's defID (the TypeScript
// side names them, src/shared/motion/presets), its value a NUMBER, BOOL or TEXT ComponentPropValue. The engine reads
// none of them: Delay, Duration and Easing are the clip's own fields.
std::vector<ComponentPropAssignment> propAssignments(const json::Value* props) {
  std::vector<ComponentPropAssignment> out;
  if (!props || !props->isObject()) return out;
  for (const auto& [key, v] : props->object) {
    bool ok = false;
    Guid def = Guid::parse(key, &ok);
    if (!ok) continue;
    ComponentPropAssignment a;
    a.defID = def;
    if (v.isNumber()) a.value.hasFloat = true, a.value.floatValue = static_cast<float>(v.number);
    else if (v.isBool()) a.value.hasBool = true, a.value.boolValue = v.boolean;
    else if (v.isString()) a.value.hasText = true, a.value.textValue.characters = v.string;
    else continue;
    out.push_back(std::move(a));
  }
  return out;
}

void writePropAssignments(json::Writer& w, const std::vector<ComponentPropAssignment>& list) {
  w.beginObject();
  for (const ComponentPropAssignment& a : list) {
    // A prop bound to a variable without a value of its own (Delay / Duration / Easing, round 8i) is the clip's
    // `variables`, not a prop.
    if (!a.value.hasFloat && !a.value.hasBool && !a.value.hasText) continue;
    w.key(a.defID.toString());
    if (a.value.hasFloat) w.number(a.value.floatValue);
    else if (a.value.hasBool) w.boolean(a.value.boolValue);
    else w.string(a.value.textValue.characters);
  }
  w.endObject();
}

// The clip's Delay / Duration / Easing bindings (round 8i) as its `variables` ({delay, duration, easing}: GUIDs).
void writePresetVariables(json::Writer& w, const motion::Preset& p) {
  w.beginObject();
  auto one = [&](const char* key, const VariableData& d) {
    if (d.kind == VariableData::Kind::ALIAS && d.alias.guid != kNoGuid) w.key(key).string(d.alias.guid.toString());
  };
  one("delay", p.delayVar);
  one("duration", p.durationVar);
  one("easing", p.easingVar);
  w.endObject();
}

bool nearlyEqual(const Mat2x3& a, const Mat2x3& b, double eps) {
  return std::fabs(a.m00 - b.m00) < eps && std::fabs(a.m01 - b.m01) < eps && std::fabs(a.m02 - b.m02) < eps && std::fabs(a.m10 - b.m10) < eps &&
         std::fabs(a.m11 - b.m11) < eps && std::fabs(a.m12 - b.m12) < eps;
}

}  // namespace

// ---- The slot's binding on a node ----------------------------------------------------------------------------------

// The VariableData slot a binding lives in (nullptr when the slot doesn't exist on the node).
const VariableData* Editor::motionSlotData(const NodeProps& p, const motion::Slot& s) const {
  switch (s.kind) {
    case Slot::Kind::NODE:
      for (const ParamBinding& b : p.parameterConsumptionMap)
        if (b.field == s.field && b.isVariable()) return &b.data;
      return nullptr;
    case Slot::Kind::FILL_COLOR:
    case Slot::Kind::FILL_OPACITY:
      if (s.index >= p.fillPaints.size()) return nullptr;
      return s.kind == Slot::Kind::FILL_COLOR ? &static_cast<const VariableData&>(p.fillPaints[s.index].colorVar) : &static_cast<const VariableData&>(p.fillPaints[s.index].opacityVar);
    case Slot::Kind::STROKE_COLOR:
    case Slot::Kind::STROKE_OPACITY:
      if (s.index >= p.strokePaints.size()) return nullptr;
      return s.kind == Slot::Kind::STROKE_COLOR ? &static_cast<const VariableData&>(p.strokePaints[s.index].colorVar) : &static_cast<const VariableData&>(p.strokePaints[s.index].opacityVar);
    case Slot::Kind::EFFECT: {
      if (s.index >= p.effects.size()) return nullptr;
      const Effect& e = p.effects[s.index];
      switch (s.effect) {
        case Slot::EffectField::RADIUS: return &static_cast<const VariableData&>(e.radiusVar);
        case Slot::EffectField::COLOR: return &static_cast<const VariableData&>(e.colorVar);
        case Slot::EffectField::SPREAD: return &static_cast<const VariableData&>(e.spreadVar);
        case Slot::EffectField::OFFSET_X: return &static_cast<const VariableData&>(e.xVar);
        case Slot::EffectField::OFFSET_Y: return &static_cast<const VariableData&>(e.yVar);
      }
      return nullptr;
    }
  }
  return nullptr;
}

// The node's current (base) value of a slot, in stored units (the literal the expression's base takes).
bool Editor::motionBaseValue(const NodeProps& p, const motion::Slot& s, motion::KeyframeValue& out) const {
  switch (s.kind) {
    case Slot::Kind::NODE: {
      const motion::FieldInfo* info = motion::fieldInfo(s.field);
      if (!info) return false;
      if (motion::isMotionTransformField(s.field)) {
        motion::LayerBase b = motion::decodeLayerBase(p);
        switch (s.field) {
          case VariableField::MOTION_TRANSLATION_X: out = KeyframeValue::number(b.translation.x); return true;
          case VariableField::MOTION_TRANSLATION_Y: out = KeyframeValue::number(b.translation.y); return true;
          case VariableField::MOTION_TRANSLATION_XY: out = KeyframeValue::vector(b.translation); return true;
          case VariableField::MOTION_ROTATION: out = KeyframeValue::number(b.rotation); return true;
          case VariableField::MOTION_SCALE_X: out = KeyframeValue::number(b.scale.x); return true;
          case VariableField::MOTION_SCALE_Y: out = KeyframeValue::number(b.scale.y); return true;
          case VariableField::MOTION_SCALE_XY: out = KeyframeValue::vector(b.scale); return true;
          case VariableField::MOTION_SHEAR: out = KeyframeValue::number(b.shear); return true;
          default: return false;
        }
      }
      double v = 0;
      if (!motion::readNodeFloat(p, s.field, v)) return false;
      out = KeyframeValue::number(motion::nodeToStored(*info, v));
      return true;
    }
    case Slot::Kind::FILL_COLOR:
    case Slot::Kind::FILL_OPACITY: {
      if (s.index >= p.fillPaints.size()) return false;
      const Paint& pt = p.fillPaints[s.index];
      out = s.kind == Slot::Kind::FILL_COLOR ? KeyframeValue::color(pt.color) : KeyframeValue::number(pt.opacity);
      return true;
    }
    case Slot::Kind::STROKE_COLOR:
    case Slot::Kind::STROKE_OPACITY: {
      if (s.index >= p.strokePaints.size()) return false;
      const Paint& pt = p.strokePaints[s.index];
      out = s.kind == Slot::Kind::STROKE_COLOR ? KeyframeValue::color(pt.color) : KeyframeValue::number(pt.opacity);
      return true;
    }
    case Slot::Kind::EFFECT: {
      if (s.index >= p.effects.size()) return false;
      const Effect& e = p.effects[s.index];
      switch (s.effect) {
        case Slot::EffectField::RADIUS: out = KeyframeValue::number(e.radius); return true;
        case Slot::EffectField::COLOR: out = KeyframeValue::color(e.color); return true;
        case Slot::EffectField::SPREAD: out = KeyframeValue::number(e.spread); return true;
        case Slot::EffectField::OFFSET_X: out = KeyframeValue::number(e.offset.x); return true;
        case Slot::EffectField::OFFSET_Y: out = KeyframeValue::number(e.offset.y); return true;
      }
      return false;
    }
  }
  return false;
}

// Writes `data` into the slot of node `id` (a transaction is open); an absent `data` (kind NONE) unbinds the slot.
void Editor::motionWriteSlot(Guid id, const motion::Slot& s, const VariableData& data) {
  const Node* n = doc_.get(id);
  if (!n) return;
  NodeChange c = NodeChange::changed(id);
  switch (s.kind) {
    case Slot::Kind::NODE:
      c.mask = F_PARAM_MAP;
      c.props.parameterConsumptionMap = n->props.parameterConsumptionMap;
      break;
    case Slot::Kind::FILL_COLOR:
    case Slot::Kind::FILL_OPACITY:
      c.mask = F_FILLS;
      c.props.fillPaints = n->props.fillPaints;
      break;
    case Slot::Kind::STROKE_COLOR:
    case Slot::Kind::STROKE_OPACITY:
      c.mask = F_STROKES;
      c.props.strokePaints = n->props.strokePaints;
      break;
    case Slot::Kind::EFFECT:
      c.mask = F_EFFECTS;
      c.props.effects = n->props.effects;
      break;
  }
  if (putSlot(c.props, s, data)) write(c);
}

// The Internal Only Canvas (docs/schema.md §3.1), where tracks live.
Guid Editor::internalCanvas() const {
  Guid found = kNoGuid;
  doc_.forEach([&](const Node& n) {
    if (found == kNoGuid && n.props.type == NodeType::CANVAS && n.props.rare().internalOnly) found = n.guid;
  });
  return found;
}

// The manual track of a slot on a node (the MANUAL parameter of its KEYFRAME expression), kNoGuid when none.
Guid Editor::motionTrackOf(const NodeProps& p, const motion::Slot& s) const {
  const VariableData* d = motionSlotData(p, s);
  if (!d || !isKeyframeExpression(*d) || d->args.size() < 2) return kNoGuid;
  std::vector<motion::Param> params;
  motion::decodeParams(d->args[1], params);
  for (const motion::Param& q : params)
    if (q.kind == motion::Param::Kind::MANUAL && q.track != kNoGuid && doc_.has(q.track)) return q.track;
  return kNoGuid;
}

// The slot's KEYFRAME expression as it stands — its base argument and its parameters — or, when it has none, the base
// it would take: an alias (or another expression) kept whole as the base argument, else the field's literal (docs/
// motion.md §4.2). False when the node has no such slot.
bool Editor::motionBindingOf(const NodeProps& p, const motion::Slot& s, VariableData& base, std::vector<motion::Param>& params) const {
  params.clear();
  const VariableData* existing = motionSlotData(p, s);
  if (existing && isKeyframeExpression(*existing)) {
    base = existing->args[0];
    if (existing->args.size() >= 2) motion::decodeParams(existing->args[1], params);
    return true;
  }
  if (existing && existing->present()) {
    base = *existing;
    return true;
  }
  KeyframeValue v;
  if (!motionBaseValue(p, s, v)) return false;
  base = v.kind == ValueKind::COLOR ? VariableData::color(v.c) : VariableData::number(v.f);
  if (v.kind == ValueKind::VECTOR) {
    // A VECTOR base: a literal the schema has no VariableData for; the motion layer takes the component of
    // motionTransform instead, so the argument carries no value.
    base = VariableData{};
    base.hasDataType = base.hasResolvedType = true;
    base.dataType = VariableDataType::FLOAT;
    base.resolvedDataType = VariableResolvedType::FLOAT;
    base.kind = VariableData::Kind::FLOAT;
    base.floatValue = 0;
  }
  return true;
}

// The slot's manual track, made when there is none: a KEYFRAME_TRACK on the internal canvas, bound through the slot's
// KEYFRAME expression (the existing expression gains a MANUAL parameter after its presets'; a plain or alias-bound
// slot becomes the expression's base argument). A transaction is open.
Guid Editor::motionEnsureTrack(Guid id, const motion::Slot& s, Guid root) {
  const Node* n = doc_.get(id);
  if (!n) return kNoGuid;
  if (Guid t = motionTrackOf(n->props, s); t != kNoGuid) return t;
  Guid internal = internalCanvas();
  if (internal == kNoGuid) return kNoGuid;
  VariableData base;
  std::vector<motion::Param> params;
  if (!motionBindingOf(n->props, s, base, params)) return kNoGuid;
  NodeProps tp = defaultProps(NodeType::KEYFRAME_TRACK);
  tp.type = NodeType::KEYFRAME_TRACK;
  tp.name = keyOf(s);
  tp.parentIndex = {internal, doc_.positionAtEnd(internal)};
  tp.extra["keyframeOperation"] = encodeExtra("keyframeOperation", jstr("SET"));
  Guid track = newGuid();
  write(NodeChange::created(track, tp));
  motion::Param m;
  m.kind = motion::Param::Kind::MANUAL;
  m.track = track;
  m.timelineDef = root;
  params.push_back(m);
  motionWriteSlot(id, s, keyframeExpression(std::move(base), params));
  motionDirty_ = true;
  return track;
}

// The KEYFRAME child of `track` at `timeUs`, kNoGuid when none.
Guid Editor::motionKeyframeAt(Guid track, int64_t timeUs) const {
  for (Guid c : doc_.children(track)) {
    const Node* k = doc_.get(c);
    if (!k || k->props.type != NodeType::KEYFRAME) continue;
    motion::Keyframe kf;
    if (motion::decodeKeyframe(k->props, c, kf) && kf.timeUs == timeUs) return c;
  }
  return kNoGuid;
}

// Upserts a keyframe by integer µs position (Figma's addOrUpdateKeyframe, docs/motion.md §4.2); `easing` null keeps the
// keyframe's (a new one has none: Figma's default curve). Returns the keyframe.
Guid Editor::motionUpsertKeyframe(Guid track, int64_t timeUs, const motion::KeyframeValue& value, const json::Value* easing) {
  Guid id = motionKeyframeAt(track, timeUs);
  NodeChange c;
  if (id == kNoGuid) {
    id = newGuid();
    NodeProps kp = defaultProps(NodeType::KEYFRAME);
    kp.type = NodeType::KEYFRAME;
    kp.name = "Keyframe";
    kp.parentIndex = {track, doc_.positionAtEnd(track)};
    c = NodeChange::created(id, kp);
  } else {
    c = NodeChange::changed(id);
  }
  putExtra(c, "timelinePosition", encodeExtra("timelinePosition", jnum(static_cast<double>(timeUs))));
  putExtra(c, "keyframeValue", encodeExtra("keyframeValue", keyframeValueJson(value)));
  Guid var;
  bool variable = easing && easingVariableOf(easing, var);
  if (easing && !variable) {
    json::Value ed;
    EasingSpec spec;
    if (easingFromPublic(*easing, ed, &spec)) {
      putExtra(c, "easingData", encodeExtra("easingData", ed));
      putExtra(c, "interpolationType", encodeExtra("interpolationType", jstr(interpolationTypeOf(spec.type))));
    }
  }
  write(c);
  if (easing) motionBindEasing(id, variable ? var : kNoGuid);
  motionDirty_ = true;
  return id;
}

// Removes a track with its keyframes and its parameter from every slot that names it (children first); a preset's
// instance goes whole (round 8h, motionRemovePreset).
void Editor::motionRemoveTrack(Guid track) {
  if (!doc_.has(track)) return;
  if (doc_.get(track)->props.type == NodeType::ANIMATION_PRESET_INSTANCE) return motionRemovePreset(track);
  std::vector<std::pair<Guid, Slot>> users;
  doc_.forEach([&](const Node& n) {
    if (n.guid.isDerived()) return;
    forEachKeyframeSlot(n.props, [&](const Slot& s, const VariableData& d) {
      std::vector<motion::Param> params;
      motion::decodeParams(d.args[1], params);
      for (const motion::Param& q : params)
        if (q.track == track) users.push_back({n.guid, s});
    });
  });
  for (auto& [id, s] : users) {
    const Node* n = doc_.get(id);
    if (!n) continue;
    const VariableData* d = motionSlotData(n->props, s);
    if (!d || !isKeyframeExpression(*d)) continue;
    std::vector<motion::Param> params;
    if (d->args.size() >= 2) motion::decodeParams(d->args[1], params);
    params.erase(std::remove_if(params.begin(), params.end(), [&](const motion::Param& q) { return q.track == track; }), params.end());
    if (params.empty()) {
      // The last track gone: the base argument is the slot's binding again (an alias), or nothing (a literal lives in
      // the field itself).
      const VariableData& base = d->args[0];
      motionWriteSlot(id, s, base.kind == VariableData::Kind::ALIAS || base.kind == VariableData::Kind::EXPRESSION ? base : VariableData{});
    } else {
      motionWriteSlot(id, s, keyframeExpression(d->args[0], params));
    }
  }
  std::vector<Guid> kids = doc_.children(track);
  for (Guid k : kids) write(NodeChange::removed(k));
  write(NodeChange::removed(track));
  motionDirty_ = true;
}

// The tracks only the given nodes (and their descendants) bind, and their presets' instances: removed with them
// (docs/motion.md §4.2 ownership; motionRemoveTrack takes both).
std::vector<Guid> Editor::motionTracksOwnedBy(const std::vector<Guid>& ids) {
  const motion::MotionIndex& ix = motionIndex();
  std::unordered_set<Guid, GuidHash> going;
  auto collect = [&](auto&& self, Guid id) -> void {
    going.insert(id);
    for (Guid c : doc_.children(id))
      if (!c.isDerived()) self(self, c);
  };
  for (Guid id : ids)
    if (doc_.has(id)) collect(collect, id);
  std::unordered_map<Guid, bool, GuidHash> onlyOurs;  // track → every user is going
  doc_.forEach([&](const Node& n) {
    if (n.guid.isDerived()) return;
    const motion::AnimatedNode* an = ix.node(n.guid);
    if (!an) return;
    bool ours = going.count(n.guid) != 0;
    for (const motion::Binding& b : an->bindings)
      for (const motion::Param& q : b.params) {
        auto it = onlyOurs.find(q.track);
        if (it == onlyOurs.end()) onlyOurs[q.track] = ours;
        else it->second = it->second && ours;
      }
    for (Guid preset : an->presets)
      if (ours) onlyOurs[preset] = true;
  });
  std::vector<Guid> out;
  for (auto& [t, only] : onlyOurs)
    if (only && doc_.has(t)) out.push_back(t);
  std::sort(out.begin(), out.end());
  return out;
}

// ---- Commands -------------------------------------------------------------------------------------------------------

uint32_t Editor::motionCommandState(CommandId id) const {
  switch (id) {
    case CommandId::MOTION_ADD_KEYFRAME:
    case CommandId::MOTION_SET_ANCHOR:
    case CommandId::MOTION_RETIME_LAYER:
    case CommandId::MOTION_DELETE_TRACKS:
    case CommandId::MOTION_ADD_ANIMATION:
    case CommandId::MOTION_APPLY_STYLE: return motion_.on && !selection_.empty() ? CMD_ENABLED : 0;
    case CommandId::MOTION_SET_ANIMATION:
    case CommandId::MOTION_REMOVE_ANIMATIONS:
    case CommandId::MOTION_SET_PRESET_TRACKS:
    case CommandId::MOTION_SET_TEXT_STAGGER:
    case CommandId::MOTION_PASTE_KEYFRAMES:
    case CommandId::MOTION_COMBINE_TRACKS:
    case CommandId::MOTION_SPLIT_TRACKS:
    case CommandId::MOTION_SET_KEYFRAMES:
    case CommandId::MOTION_DELETE_KEYFRAMES:
    case CommandId::MOTION_SET_EASING:
    case CommandId::MOTION_SET_TIMELINE:
    case CommandId::MOTION_SET_PATH_HANDLES:
    case CommandId::MOTION_SET_INSTANCE_OFFSET:
    case CommandId::MOTION_ADD_AUDIO:
    case CommandId::MOTION_SET_AUDIO:
    case CommandId::MOTION_SPLIT_AUDIO:
    case CommandId::MOTION_REMOVE_AUDIO: return motion_.on ? CMD_ENABLED : 0;
    default: return 0;
  }
}

Status Editor::motionCommand(CommandId id, const CommandArgs& args) {
  const json::Value& raw = args.raw;
  // The nodes a command works on: `nodes` (refs), else the selection.
  auto nodesOf = [&]() {
    std::vector<Guid> out;
    if (const json::Value* list = member(raw, "nodes"); list && list->isArray()) {
      for (const json::Value& v : list->array) {
        Guid g;
        if (guidOf(&v, g) && doc_.has(g) && !g.isDerived() && !isLibraryCopy(g)) out.push_back(g);
      }
    } else {
      for (Guid g : selection_)
        if (!g.isDerived() && !isLibraryCopy(g)) out.push_back(g);
    }
    return out;
  };
  auto rootFor = [&](Guid node) {
    const motion::MotionIndex& ix = motionIndex();
    Guid r = ix.rootOf(doc_, node);
    return r == node ? kNoGuid : r;  // the root itself is never animated (docs/motion.md §4.3)
  };
  auto timeArg = [&](const char* key, int64_t fallback) {
    const json::Value* t = member(raw, key);
    return t && t->isNumber() ? roundUs(t->number) : fallback;
  };
  switch (id) {
    case CommandId::MOTION_ADD_KEYFRAME: {
      Slot slot;
      if (!slotFromPublic(member(raw, "field"), slot)) return E_INVALID;
      std::vector<Guid> nodes = nodesOf();
      if (nodes.empty()) return E_INVALID;
      int64_t timeUs = timeArg("timeUs", motion_.timeUs);
      begin(TxnKind::USER, "Add keyframe");
      size_t made = 0;
      for (Guid n : nodes) {
        Guid root = rootFor(n);
        if (root == kNoGuid) continue;
        const Node* node = doc_.get(n);
        if (!node) continue;
        KeyframeValue probe;
        if (!motionSlotData(node->props, slot) && !motionBaseValue(node->props, slot, probe)) continue;  // no such slot on the node
        KeyframeValue value;
        if (!valueFromPublic(member(raw, "value"), slot, value)) {
          // The current value at the playhead: the folded tracks over the base, else the base itself.
          if (!motionCurrentValue(n, slot, timeUs, value)) continue;
        }
        Guid track = motionEnsureTrack(n, slot, root);
        if (track == kNoGuid) continue;
        created_.push_back(motionUpsertKeyframe(track, timeUs, value, member(raw, "easing")));
        made++;
      }
      commit();
      return made ? OK : E_INVALID;
    }
    case CommandId::MOTION_SET_KEYFRAMES: {
      const json::Value* edits = member(raw, "edits");
      if (!edits || !edits->isArray() || edits->array.empty()) return E_INVALID;
      bool moves = false;
      for (const json::Value& e : edits->array) moves |= member(e, "timeUs") != nullptr;
      begin(TxnKind::USER, moves ? "Move keyframes" : "Edit keyframe");
      size_t done = 0;
      for (const json::Value& e : edits->array) {
        Guid kid;
        if (!guidOf(member(e, "id"), kid)) continue;
        const Node* k = doc_.get(kid);
        if (!k || k->props.type != NodeType::KEYFRAME) continue;
        Guid track = k->props.parentIndex.guid;
        motion::Keyframe kf;
        motion::decodeKeyframe(k->props, kid, kf);
        NodeChange c = NodeChange::changed(kid);
        if (const json::Value* t = member(e, "timeUs"); t && t->isNumber()) {
          int64_t at = roundUs(t->number);
          if (at != kf.timeUs) {
            // Unique positions per track: a keyframe already there goes (Figma's upsert).
            Guid other = motionKeyframeAt(track, at);
            if (other != kNoGuid && other != kid) write(NodeChange::removed(other));
            putExtra(c, "timelinePosition", encodeExtra("timelinePosition", jnum(static_cast<double>(at))));
          }
        }
        if (const json::Value* v = member(e, "value")) {
          // The slot's kind decides the value's: the track's own keyframes say what it holds.
          Slot slot;
          slot.kind = Slot::Kind::NODE;
          slot.field = VariableField::MISSING;
          KeyframeValue value;
          ValueKind want = kf.value.kind;
          const json::Value* type = member(v, "type");
          const json::Value* val = member(v, "value");
          bool ok = type && type->isString() && val;
          if (ok && type->string == "FLOAT" && val->isNumber()) value = want == ValueKind::VECTOR ? KeyframeValue::vector({val->number, val->number}) : KeyframeValue::number(val->number);
          else if (ok && type->string == "VECTOR" && val->isObject()) value = KeyframeValue::vector({member(val, "x") ? member(val, "x")->numberOr(0) : 0, member(val, "y") ? member(val, "y")->numberOr(0) : 0});
          else if (ok && type->string == "COLOR" && val->isObject()) {
            auto ch = [&](const char* key, float f) {
              const json::Value* x = val->get(key);
              return x ? static_cast<float>(std::clamp(x->numberOr(f), 0.0, 1.0)) : f;
            };
            value = KeyframeValue::color({ch("r", 0), ch("g", 0), ch("b", 0), ch("a", 1)});
          } else {
            ok = false;
          }
          // A FLOAT keyframe of a node field arrives in public units: find the slot for the conversion.
          if (ok && value.kind == ValueKind::FLOAT) {
            Guid owner;
            Slot s;
            if (motionSlotOfTrack(track, owner, s)) value.f = toStored(s, value.f);
          }
          if (ok) putExtra(c, "keyframeValue", encodeExtra("keyframeValue", keyframeValueJson(value)));
        }
        bool bound = false;
        if (const json::Value* es = member(e, "easing")) {
          json::Value ed;
          EasingSpec spec;
          Guid var;
          if (easingVariableOf(es, var)) {
            motionBindEasing(kid, var);
            bound = true;
          } else if (easingFromPublic(*es, ed, &spec)) {
            putExtra(c, "easingData", encodeExtra("easingData", ed));
            putExtra(c, "interpolationType", encodeExtra("interpolationType", jstr(interpolationTypeOf(spec.type))));
            motionBindEasing(kid, kNoGuid);
          }
        }
        if (const json::Value* h = member(e, "pathHandles"); h && h->isObject()) {
          json::Value handles = jobj();
          const json::Value* in = member(h, "in");
          const json::Value* out = member(h, "out");
          put(handles, "p1x", jnum(member(in, "x") ? member(in, "x")->numberOr(0) : 0));
          put(handles, "p1y", jnum(member(in, "y") ? member(in, "y")->numberOr(0) : 0));
          put(handles, "p2x", jnum(member(out, "x") ? member(out, "x")->numberOr(0) : 0));
          put(handles, "p2y", jnum(member(out, "y") ? member(out, "y")->numberOr(0) : 0));
          putExtra(c, "motionPathBezierHandles", encodeExtra("motionPathBezierHandles", handles));
        }
        if (c.mask) write(c);
        if (c.mask || bound) done++;
      }
      motionDirty_ = true;
      commit();
      return done ? OK : E_INVALID;
    }
    case CommandId::MOTION_DELETE_KEYFRAMES: {
      const json::Value* ids = member(raw, "ids");
      if (!ids || !ids->isArray()) return E_INVALID;
      std::vector<Guid> keys;
      for (const json::Value& v : ids->array) {
        Guid g;
        if (guidOf(&v, g) && doc_.has(g) && doc_.get(g)->props.type == NodeType::KEYFRAME) keys.push_back(g);
      }
      if (keys.empty()) return E_INVALID;
      begin(TxnKind::USER, "Delete keyframes");
      std::unordered_set<Guid, GuidHash> tracks;
      for (Guid k : keys) {
        tracks.insert(doc_.parentOf(k));
        write(NodeChange::removed(k));
      }
      // A track left empty goes with its binding.
      for (Guid t : tracks)
        if (doc_.has(t) && doc_.children(t).empty()) motionRemoveTrack(t);
      motionDirty_ = true;
      commit();
      return OK;
    }
    case CommandId::MOTION_DELETE_TRACKS: {
      Guid node;
      if (!guidOf(member(raw, "node"), node) || !doc_.has(node)) return E_INVALID;
      const json::Value* fields = member(raw, "fields");
      std::vector<Guid> tracks;
      const Node* n = doc_.get(node);
      if (fields && fields->isArray()) {
        for (const json::Value& f : fields->array) {
          Slot s;
          if (slotFromPublic(&f, s))
            if (Guid t = motionTrackOf(n->props, s); t != kNoGuid) tracks.push_back(t);
        }
      } else if (const motion::AnimatedNode* an = motionIndex().node(node)) {
        for (const motion::Binding& b : an->bindings)
          for (const motion::Param& q : b.params)
            if (q.kind == motion::Param::Kind::MANUAL) tracks.push_back(q.track);
      }
      if (tracks.empty()) return E_INVALID;
      begin(TxnKind::USER, "Delete animation");
      for (Guid t : tracks) motionRemoveTrack(t);
      commit();
      return OK;
    }
    case CommandId::MOTION_SET_EASING: {
      const json::Value* ids = member(raw, "ids");
      const json::Value* easing = member(raw, "easing");
      if (!ids || !ids->isArray() || !easing) return E_INVALID;
      json::Value ed;
      EasingSpec spec;
      // An EASING variable (round 8i, docs/motion.md §4.7): the keyframe's EASING_DATA alias, a clip's Easing prop.
      Guid var;
      bool variable = easingVariableOf(easing, var);
      if (!variable && !easingFromPublic(*easing, ed, &spec)) return E_INVALID;
      begin(TxnKind::USER, "Change easing");
      size_t done = 0;
      for (const json::Value& v : ids->array) {
        Guid g;
        if (!guidOf(&v, g) || !doc_.has(g)) continue;
        NodeType t = doc_.get(g)->props.type;
        if (t != NodeType::KEYFRAME && t != NodeType::ANIMATION_PRESET_INSTANCE) continue;
        if (t == NodeType::ANIMATION_PRESET_INSTANCE) {
          // A clip's easing is its tweens' (round 8h): its keyframes take it too; a variable binds its Easing prop.
          if (variable) {
            json::Value vars = jobj();
            put(vars, "easing", jstr(var.toString()));
            motionBindPresetVariables(g, vars);
          } else {
            motionEditPreset(g, raw);
            json::Value vars = jobj();
            put(vars, "easing", json::Value());
            motionBindPresetVariables(g, vars);
          }
          done++;
          continue;
        }
        motionBindEasing(g, variable ? var : kNoGuid);
        if (!variable) {
          NodeChange c = NodeChange::changed(g);
          putExtra(c, "easingData", encodeExtra("easingData", ed));
          putExtra(c, "interpolationType", encodeExtra("interpolationType", jstr(interpolationTypeOf(spec.type))));
          write(c);
        }
        done++;
      }
      motionDirty_ = true;
      commit();
      return done ? OK : E_INVALID;
    }
    case CommandId::MOTION_SET_TIMELINE: {
      Guid root;
      if (!guidOf(member(raw, "root"), root) || !motion::isTimelineRoot(doc_, root)) return E_INVALID;
      NodeChange c = NodeChange::changed(root);
      std::string label = "Change duration";
      if (const json::Value* d = member(raw, "durationUs"); d && d->isNumber() && d->number > 0)
        putExtra(c, "timelineDuration", encodeExtra("timelineDuration", jnum(std::round(d->number))));
      if (const json::Value* p = member(raw, "playback"); p && p->isString()) {
        const char* style = p->string == "ONCE" ? "ONCE" : p->string == "PING_PONG" ? "BOOMERANG" : p->string == "LOOP" ? "LOOP" : nullptr;
        if (!style) return E_INVALID;
        putExtra(c, "playbackStyle", encodeExtra("playbackStyle", jstr(style)));
        if (!member(raw, "durationUs")) label = "Change playback";
      }
      if (const json::Value* f = member(raw, "snappingFps"); f && f->isNumber() && f->number > 0) {
        json::Value fr = jobj();
        // 29.97 / 23.976 are 30000/1001 and 24000/1001 (docs/motion.md §6.2 SNAPPING_GRIDS).
        double fps = f->number;
        bool ntsc = std::fabs(fps - 29.97) < 0.01 || std::fabs(fps - 23.976) < 0.01;
        put(fr, "numerator", jnum(ntsc ? std::round(fps) * 1000 : std::round(fps)));
        put(fr, "denominator", jnum(ntsc ? 1001 : 1));
        putExtra(c, "timelineKeyframeSnappingFps", encodeExtra("timelineKeyframeSnappingFps", fr));
      }
      if (!c.mask) return E_INVALID;
      begin(TxnKind::USER, label);
      write(c);
      motionDirty_ = true;
      commit();
      return OK;
    }
    case CommandId::MOTION_RETIME_LAYER: {
      Guid node;
      if (!guidOf(member(raw, "node"), node) || !doc_.has(node)) return E_INVALID;
      const motion::AnimatedNode* an = motionIndex().node(node);
      if (!an) return E_INVALID;
      const json::Value* delta = member(raw, "deltaUs");
      const json::Value* scale = member(raw, "scale");
      double factor = 1, pivot = 0;
      if (scale && scale->isObject()) {
        factor = member(scale, "factor") ? member(scale, "factor")->numberOr(1) : 1;
        pivot = member(scale, "pivotUs") ? member(scale, "pivotUs")->numberOr(0) : 0;
        if (!(factor > 0)) return E_INVALID;
      } else if (!delta || !delta->isNumber()) {
        return E_INVALID;
      }
      std::vector<Guid> tracks;
      for (const motion::Binding& b : an->bindings)
        for (const motion::Param& q : b.params)
          if (q.kind == motion::Param::Kind::MANUAL && doc_.has(q.track)) tracks.push_back(q.track);
      if (tracks.empty() && an->presets.empty()) return E_INVALID;
      begin(TxnKind::USER, delta ? "Move animation" : "Change animation duration");
      // The clips (round 8h) move with the keyframes; scaled, a clip's start and length scale about the pivot and its
      // tracks with it.
      for (Guid preset : an->presets) {
        const motion::Preset* pr = motionIndex_.preset(preset);
        if (!pr) continue;
        NodeChange c = NodeChange::changed(preset);
        double start = delta ? static_cast<double>(pr->offsetUs) + delta->number : pivot + (static_cast<double>(pr->offsetUs) - pivot) * factor;
        putExtra(c, "timelineOffset", encodeExtra("timelineOffset", jnum(static_cast<double>(roundUs(start)))));
        if (!delta) putExtra(c, "timelineDuration", encodeExtra("timelineDuration", jnum(std::max(1.0, std::round(static_cast<double>(pr->durationUs) * factor)))));
        write(c);
        if (!delta) motionScalePreset(preset, factor);
      }
      for (Guid t : tracks) {
        // Every keyframe moves; the new positions are written in one pass (no upsert collisions: a scale keeps order
        // and a delta is uniform).
        for (Guid k : doc_.children(t)) {
          const Node* kn = doc_.get(k);
          motion::Keyframe kf;
          if (!kn || !motion::decodeKeyframe(kn->props, k, kf)) continue;
          double at = delta ? static_cast<double>(kf.timeUs) + delta->number : pivot + (static_cast<double>(kf.timeUs) - pivot) * factor;
          NodeChange c = NodeChange::changed(k);
          putExtra(c, "timelinePosition", encodeExtra("timelinePosition", jnum(static_cast<double>(roundUs(at)))));
          write(c);
        }
      }
      motionDirty_ = true;
      commit();
      return OK;
    }
    case CommandId::MOTION_SET_ANCHOR: {
      std::vector<Guid> nodes = nodesOf();
      const json::Value* x = member(raw, "x");
      const json::Value* y = member(raw, "y");
      if (nodes.empty() || !x || !x->isNumber() || !y || !y->isNumber()) return E_INVALID;
      begin(TxnKind::USER, "Move anchor point");
      for (Guid n : nodes) {
        // Kept in place (docs/motion.md §4.9): with the anchor o → o', T(o) · T(t) · L · T(−o) stays put at the playhead
        // when t takes (I − L)(o − o'), L the motion rotation, shear and scale there.
        const Node* node = doc_.get(n);
        if (!node) continue;
        motion::LayerBase pose = motionPoseAt(n, motion_.timeUs);
        motion::LayerBase moved = pose;
        moved.originX = {x->number, NumberUnits::PERCENT};
        moved.originY = {y->number, NumberUnits::PERCENT};
        Vec2 dO = motion::MotionLayer::anchorPoint(pose, node->props.size) - motion::MotionLayer::anchorPoint(moved, node->props.size);
        Vec2 keep = dO - motionLinear(pose.rotation, pose.shear, pose.scale).applyLinear(dO);
        json::Value to = jobj(), px = jobj(), py = jobj();
        put(px, "value", jnum(x->number));
        put(px, "units", jstr("PERCENT"));
        put(py, "value", jnum(y->number));
        put(py, "units", jstr("PERCENT"));
        put(to, "x", px);
        put(to, "y", py);
        NodeChange c = NodeChange::changed(n);
        putExtra(c, "transformOrigin", encodeExtra("transformOrigin", to));
        write(c);
        if (std::fabs(keep.x) > 1e-9 || std::fabs(keep.y) > 1e-9) motionShiftTranslation(n, keep);
      }
      motionDirty_ = true;
      commit();
      return OK;
    }
    case CommandId::MOTION_SET_PATH_HANDLES: {
      Guid k;
      if (!guidOf(member(raw, "keyframe"), k) || !doc_.has(k) || doc_.get(k)->props.type != NodeType::KEYFRAME) return E_INVALID;
      const json::Value* in = member(raw, "in");
      const json::Value* out = member(raw, "out");
      if (!in || !out) return E_INVALID;
      json::Value handles = jobj();
      put(handles, "p1x", jnum(member(in, "x") ? member(in, "x")->numberOr(0) : 0));
      put(handles, "p1y", jnum(member(in, "y") ? member(in, "y")->numberOr(0) : 0));
      put(handles, "p2x", jnum(member(out, "x") ? member(out, "x")->numberOr(0) : 0));
      put(handles, "p2y", jnum(member(out, "y") ? member(out, "y")->numberOr(0) : 0));
      begin(TxnKind::USER, "Edit motion path");
      NodeChange c = NodeChange::changed(k);
      putExtra(c, "motionPathBezierHandles", encodeExtra("motionPathBezierHandles", handles));
      write(c);
      motionDirty_ = true;
      commit();
      return OK;
    }
    case CommandId::MOTION_SET_INSTANCE_OFFSET: {
      // An animated instance dragged in time (docs/motion.md §4.3; its purple bar): its `timelineAssignments` entry for
      // (its main's timeline, the timeline it sits in) takes the offset; the other entries stay.
      Guid inst;
      const json::Value* off = member(raw, "offsetUs");
      if (!guidOf(member(raw, "instance"), inst) || inst.isDerived() || !off || !off->isNumber() || isLibraryCopy(inst)) return E_INVALID;
      const Node* n = doc_.get(inst);
      if (!n || n->props.type != NodeType::INSTANCE) return E_INVALID;
      Guid main = mainOf(inst);
      Guid containing = rootFor(inst);
      if (main == kNoGuid || containing == kNoGuid) return E_INVALID;
      json::Value map = motion::extraJson(n->props, "timelineAssignments");
      json::Value entries;
      entries.kind = json::Value::Kind::Array;
      if (const json::Value* list = member(map, "entries"); list && list->isArray())
        for (const json::Value& e : list->array) {
          const json::Value* key = member(e, "key");
          Guid a, c;
          if (guidOf(member(key, "assignedTimelineId"), a) && guidOf(member(key, "containingTimelineId"), c) && a == main && c == containing) continue;
          entries.array.push_back(e);
        }
      json::Value entry = jobj(), key = jobj(), value = jobj();
      put(key, "assignedTimelineId", jstr(main.toString()));
      put(key, "containingTimelineId", jstr(containing.toString()));
      put(value, "offsetUs", jnum(static_cast<double>(std::llround(off->number))));
      put(value, "disabled", jbool(false));
      put(value, "autoplay", jbool(true));
      put(entry, "key", key);
      put(entry, "value", value);
      entries.array.push_back(entry);
      json::Value out = jobj();
      put(out, "entries", entries);
      begin(TxnKind::USER, "Move animation");
      NodeChange c = NodeChange::changed(inst);
      putExtra(c, "timelineAssignments", encodeExtra("timelineAssignments", out));
      write(c);
      motionDirty_ = true;
      commit();
      return OK;
    }
    case CommandId::MOTION_ADD_ANIMATION: {
      // A preset on each layer at the playhead (or `startUs`), its tracks the runtime's `output` (docs/motion.md §4.6).
      const json::Value* preset = member(raw, "preset");
      if (!preset || !preset->isString() || preset->string.empty()) return E_INVALID;
      std::vector<Guid> nodes = nodesOf();
      int64_t startUs = timeArg("startUs", motion_.timeUs);
      begin(TxnKind::USER, "Add animation");
      for (Guid n : nodes) {
        Guid root = rootFor(n);
        if (root == kNoGuid) continue;
        if (Guid id = motionAddPreset(n, root, raw, startUs); id != kNoGuid) created_.push_back(id);
      }
      bool made = !created_.empty();
      commit();
      return made ? OK : E_INVALID;
    }
    case CommandId::MOTION_SET_ANIMATION: {
      Guid id;
      if (!guidOf(member(raw, "id"), id) || !doc_.has(id) || doc_.get(id)->props.type != NodeType::ANIMATION_PRESET_INSTANCE) return E_INVALID;
      // Figma's names: a clip dragged is "Move animation", its handles "Change animation duration", the rest "Edit animation".
      bool start = member(raw, "startUs") != nullptr, duration = member(raw, "durationUs") != nullptr;
      size_t keys = raw.isObject() ? raw.object.size() : 0;
      const char* label = start && keys == 2 ? "Move animation" : duration && keys <= 3 && !member(raw, "output") && !member(raw, "props") ? "Change animation duration" : "Edit animation";
      begin(TxnKind::USER, label);
      bool ok = motionEditPreset(id, raw);
      commit();
      return ok ? OK : E_INVALID;
    }
    case CommandId::MOTION_REMOVE_ANIMATIONS: {
      const json::Value* ids = member(raw, "ids");
      if (!ids || !ids->isArray()) return E_INVALID;
      std::vector<Guid> presets;
      for (const json::Value& v : ids->array) {
        Guid g;
        if (guidOf(&v, g) && doc_.has(g) && doc_.get(g)->props.type == NodeType::ANIMATION_PRESET_INSTANCE) presets.push_back(g);
      }
      if (presets.empty()) return E_INVALID;
      begin(TxnKind::USER, "Remove animation");
      for (Guid g : presets) motionRemovePreset(g);
      commit();
      return OK;
    }
    case CommandId::MOTION_APPLY_STYLE: {
      // A composite style (docs/motion.md §4.6): its presets — expanded by the TypeScript side, each with its offset from
      // the style's start and its output — on each layer, and one `styleIdsForAnimation` entry naming what it generated.
      // `detach` instead forgets a style entry wherever it is; its presets stay as they are. Round 8i: `create` makes a
      // custom (user) animation style from a layer's clips, or (with its `style`) replaces a custom style's content;
      // `style` naming a custom style's node binds it by GUID instead of a first-party key.
      if (const json::Value* create = member(raw, "create"); create && create->isObject()) return motionCreateStyle(*create);
      if (Guid binding; guidOf(member(raw, "detach"), binding)) {
        std::vector<Guid> holders;
        doc_.forEach([&](const Node& n) {
          if (!n.guid.isDerived() && n.props.extra.count("styleIdsForAnimation")) holders.push_back(n.guid);
        });
        begin(TxnKind::USER, "Detach animation style");
        size_t done = 0;
        for (Guid n : holders) {
          json::Value list = motion::extraJson(doc_.get(n)->props, "styleIdsForAnimation");
          if (!list.isArray()) continue;
          json::Value kept;
          kept.kind = json::Value::Kind::Array;
          for (const json::Value& e : list.array) {
            Guid g;
            if (guidOf(member(e, "id"), g) && g == binding) continue;
            kept.array.push_back(e);
          }
          if (kept.array.size() == list.array.size()) continue;
          NodeChange c = NodeChange::changed(n);
          putExtra(c, "styleIdsForAnimation", kept.array.empty() ? std::string() : encodeExtra("styleIdsForAnimation", kept));
          write(c);
          done++;
        }
        motionDirty_ = true;
        commit();
        return done ? OK : E_INVALID;
      }
      const json::Value* style = member(raw, "style");
      const json::Value* presets = member(raw, "presets");
      if (!style || !style->isString() || !presets || !presets->isArray() || presets->array.empty()) return E_INVALID;
      std::vector<Guid> nodes = nodesOf();
      int64_t startUs = timeArg("startUs", motion_.timeUs);
      begin(TxnKind::USER, "Apply animation style");
      for (Guid n : nodes) {
        Guid root = rootFor(n);
        if (root == kNoGuid) continue;
        json::Value generated;
        generated.kind = json::Value::Kind::Array;
        for (const json::Value& spec : presets->array) {
          const json::Value* off = member(spec, "offsetUs");
          Guid id = motionAddPreset(n, root, spec, startUs + (off && off->isNumber() ? roundUs(off->number) : 0));
          if (id == kNoGuid) continue;
          created_.push_back(id);
          json::Value g = jobj();
          put(g, "animationPresetId", idJson(id));
          generated.array.push_back(g);
        }
        if (generated.array.empty()) continue;
        json::Value list = motion::extraJson(doc_.get(n)->props, "styleIdsForAnimation");
        if (!list.isArray()) list.kind = json::Value::Kind::Array;
        json::Value entry = jobj(), styleId = jobj(), ref = jobj();
        Guid custom;
        bool ok = false;
        custom = Guid::parse(style->string, &ok);
        if (ok && doc_.has(custom) && doc_.get(custom)->props.asset().styleType == StyleType::ANIMATION) {
          put(styleId, "guid", jstr(custom.toString()));
        } else {
          put(ref, "key", jstr(style->string));
          put(styleId, "assetRef", ref);
        }
        put(entry, "id", jstr(newGuid().toString()));
        put(entry, "timelineDefId", jstr(root.toString()));
        put(entry, "animationStyleId", styleId);
        put(entry, "timelineOffset", jnum(static_cast<double>(startUs)));
        put(entry, "generatedAnimationPresets", generated);
        list.array.push_back(entry);
        NodeChange c = NodeChange::changed(n);
        putExtra(c, "styleIdsForAnimation", encodeExtra("styleIdsForAnimation", list));
        write(c);
      }
      bool made = !created_.empty();
      motionDirty_ = true;
      commit();
      return made ? OK : E_INVALID;
    }
    case CommandId::MOTION_SET_PRESET_TRACKS: {
      // A preset's code run again (its props changed): its tracks replaced by the output (docs/motion.md §4.6) — inside
      // the step that changed the props when the chrome opened one, else a step of its own.
      Guid id;
      const json::Value* output = member(raw, "output");
      if (!guidOf(member(raw, "id"), id) || !output || !doc_.has(id) || doc_.get(id)->props.type != NodeType::ANIMATION_PRESET_INSTANCE) return E_INVALID;
      begin(TxnKind::USER, "Edit animation");
      motionSetPresetTracks(id, *output);
      commit();
      return OK;
    }
    case CommandId::MOTION_SET_TEXT_STAGGER: {
      // A text animated by hand per element (round 8i, docs/motion.md §4.10): the TEXT layer's own
      // `textElementDelayBehaviour` — its manual tracks then play per character / word / line / paragraph, `delayMs`
      // apart in `order` — or a text preset's clip's (its step edited by hand). Grouping, order and delay keep what
      // isn't given.
      Guid node;
      if (!guidOf(member(raw, "node"), node) || !doc_.has(node) || node.isDerived() || isLibraryCopy(node)) return E_INVALID;
      const NodeProps& p = doc_.get(node)->props;
      if (p.type != NodeType::TEXT && p.type != NodeType::ANIMATION_PRESET_INSTANCE) return E_INVALID;
      json::Value b = motion::extraJson(p, "textElementDelayBehaviour");
      if (!b.isObject()) b = jobj();
      const json::Value* enabled = member(raw, "enabled");
      if (!enabled || !enabled->isBool()) return E_INVALID;
      put(b, "enabled", jbool(enabled->boolean));
      if (const json::Value* g = member(raw, "grouping"); g && g->isString()) {
        constexpr const char* kGroupings[] = {"CHARACTER", "CHARACTER_NO_WHITESPACE", "WORD", "LINE", "PARAGRAPH"};
        if (std::none_of(std::begin(kGroupings), std::end(kGroupings), [&](const char* k) { return g->string == k; })) return E_INVALID;
        put(b, "grouping", jstr(g->string));
      }
      if (const json::Value* o = member(raw, "order"); o && o->isString()) {
        constexpr const char* kOrders[] = {"LEFT_RIGHT", "RIGHT_LEFT", "CENTER_OUT", "RANDOM"};
        if (std::none_of(std::begin(kOrders), std::end(kOrders), [&](const char* k) { return o->string == k; })) return E_INVALID;
        put(b, "order", jstr(o->string));
      }
      if (const json::Value* d = member(raw, "delayMs"); d && d->isNumber()) put(b, "delayMs", jnum(std::max(0.0, d->number)));  // ≥ 0 (Figma's)
      begin(TxnKind::USER, "Edit text animation");
      NodeChange c = NodeChange::changed(node);
      putExtra(c, "textElementDelayBehaviour", encodeExtra("textElementDelayBehaviour", b));
      write(c);
      motionDirty_ = true;
      commit();
      return OK;
    }
    case CommandId::MOTION_PASTE_KEYFRAMES: {
      // Keyframes copied from the timeline (docs/motion.md §6.2) at `atUs` on each layer's same fields: per track of the
      // copy, its keyframes at atUs + their distance from the earliest copied, with their values and easings (upserted
      // by position, so a paste over keyframes replaces them). One "Paste keyframes" step.
      std::vector<Guid> nodes = nodesOf();
      const json::Value* tracks = member(member(raw, "clipboard"), "tracks");
      if (nodes.empty() || !tracks || !tracks->isArray()) return E_INVALID;
      int64_t at = timeArg("atUs", motion_.timeUs);
      begin(TxnKind::USER, "Paste keyframes");
      size_t made = 0;
      for (Guid n : nodes) {
        Guid root = rootFor(n);
        const Node* node = doc_.get(n);
        if (root == kNoGuid || !node) continue;
        for (const json::Value& tr : tracks->array) {
          Slot slot;
          const json::Value* keys = member(tr, "keyframes");
          if (!slotFromPublic(member(tr, "field"), slot) || !keys || !keys->isArray()) continue;
          KeyframeValue probe;
          if (!motionSlotData(doc_.get(n)->props, slot) && !motionBaseValue(doc_.get(n)->props, slot, probe)) continue;
          Guid track = kNoGuid;
          for (const json::Value& k : keys->array) {
            KeyframeValue value;
            const json::Value* dt = member(k, "dtUs");
            if (!valueFromPublic(member(k, "value"), slot, value)) continue;
            if (track == kNoGuid) track = motionEnsureTrack(n, slot, root);
            if (track == kNoGuid) break;
            created_.push_back(motionUpsertKeyframe(track, at + (dt && dt->isNumber() ? roundUs(dt->number) : 0), value, member(k, "easing")));
            made++;
          }
        }
      }
      commit();
      return made ? OK : E_INVALID;
    }
    case CommandId::MOTION_COMBINE_TRACKS:
    case CommandId::MOTION_SPLIT_TRACKS: {
      // Position or scale as one XY track or as an X and a Y track (Figma's switchVectorKeyframesToCombined / ToSplit;
      // "keyframe tracks must be either combined or separated", docs/motion.md §4.5).
      Guid node;
      const json::Value* kind = member(raw, "kind");
      if (!guidOf(member(raw, "node"), node) || !doc_.has(node) || !kind || !kind->isString()) return E_INVALID;
      if (kind->string != "POSITION" && kind->string != "SCALE") return E_INVALID;
      return motionCombineTracks(node, kind->string == "SCALE", id == CommandId::MOTION_COMBINE_TRACKS);
    }
    case CommandId::MOTION_ADD_AUDIO:
    case CommandId::MOTION_SET_AUDIO:
    case CommandId::MOTION_SPLIT_AUDIO:
    case CommandId::MOTION_REMOVE_AUDIO: return motionAudioCommand(id, raw);
    default: return E_UNSUPPORTED;
  }
}

// A custom (user) animation style (round 8i; docs/motion.md §4.6: "custom (user) animation styles need only the style
// node"): a STYLE node of StyleType ANIMATION on the internal canvas (a FRAME [ours: Figma's node type for it unseen]),
// its content `styleAnimations 580` — template ANIMATION_PRESET_INSTANCE children, each a copy of one of `from`'s clips
// without its tracks (type, name, props, easing, length, and its start less the earliest clip's: the style plays from
// its own start). With `style`, that custom style's content is replaced ("Update animation style"); else a new style
// named `name` ("Create animation style"). The TypeScript side runs the templates' code when the style is applied.
Status Editor::motionCreateStyle(const json::Value& spec) {
  Guid from;
  if (!guidOf(member(spec, "from"), from) || !doc_.has(from)) return E_INVALID;
  std::vector<Guid> presets = motion::decodePresetList(doc_.get(from)->props);
  if (presets.empty()) return E_INVALID;
  Guid style;
  bool update = guidOf(member(spec, "style"), style) && doc_.has(style) && doc_.get(style)->props.asset().styleType == StyleType::ANIMATION;
  if (member(spec, "style") && !update) return E_INVALID;
  int64_t earliest = INT64_MAX;
  for (Guid p : presets)
    if (const Node* n = doc_.get(p)) {
      motion::Preset pr;
      if (motion::decodePreset(n->props, p, pr)) earliest = std::min(earliest, pr.offsetUs);
    }
  if (earliest == INT64_MAX) return E_INVALID;
  begin(TxnKind::USER, update ? "Update animation style" : "Create animation style");
  if (update) {
    for (Guid c : std::vector<Guid>(doc_.children(style))) write(NodeChange::removed(c));
  } else {
    Guid internal = internalCanvas(true);
    if (internal == kNoGuid) {
      rollback();
      return E_INVALID;
    }
    NodeProps sp = defaultProps(NodeType::FRAME);
    sp.type = NodeType::FRAME;
    const json::Value* name = member(spec, "name");
    sp.name = name && name->isString() && !name->string.empty() ? name->string : "Animation style";
    sp.parentIndex = {internal, doc_.positionAtEnd(internal)};
    sp.visible = false;
    sp.asset().styleType = StyleType::ANIMATION;
    style = newGuid();
    write(NodeChange::created(style, sp));
  }
  json::Value list;
  list.kind = json::Value::Kind::Array;
  for (Guid p : presets) {
    const Node* n = doc_.get(p);
    motion::Preset pr;
    if (!n || !motion::decodePreset(n->props, p, pr)) continue;
    NodeProps tp = n->props;
    tp.parentIndex = {style, doc_.positionAtEnd(style)};
    tp.extra["timelineOffset"] = encodeExtra("timelineOffset", jnum(static_cast<double>(pr.offsetUs - earliest)));
    tp.extra.erase("textElementDelayBehaviour");  // the stagger is the code's output, made again when applied
    Guid id = newGuid();
    write(NodeChange::created(id, tp));
    json::Value e = jobj();
    put(e, "animationPresetId", idJson(id));
    list.array.push_back(e);
  }
  NodeChange c = NodeChange::changed(style);
  putExtra(c, "styleAnimations", encodeExtra("styleAnimations", list));
  write(c);
  created_.push_back(style);
  motionDirty_ = true;
  commit();
  return OK;
}

// X / Y ↔ XY (MOTION_COMBINE_TRACKS / MOTION_SPLIT_TRACKS; round 8i). Combined: one keyframe at every time either track
// has one, its x and y the two tracks' values there (a missing track: the layer's motionTransform), its easing the X
// keyframe's there, else the Y's. Split: each XY keyframe as an X and a Y keyframe at its time with its easing (motion
// path handles have no place on a split pair: they go). Manual tracks only; one step.
Status Editor::motionCombineTracks(Guid node, bool scale, bool combine) {
  const motion::MotionIndex& ix = motionIndex();
  const motion::AnimatedNode* an = ix.node(node);
  Guid root = ix.rootOf(doc_, node);
  if (!an || root == kNoGuid || root == node) return E_INVALID;
  VariableField fx = scale ? VariableField::MOTION_SCALE_X : VariableField::MOTION_TRANSLATION_X;
  VariableField fy = scale ? VariableField::MOTION_SCALE_Y : VariableField::MOTION_TRANSLATION_Y;
  VariableField fxy = scale ? VariableField::MOTION_SCALE_XY : VariableField::MOTION_TRANSLATION_XY;
  auto manual = [&](VariableField f) -> const motion::Track* {
    for (const motion::Binding& b : an->bindings) {
      if (b.slot.kind != Slot::Kind::NODE || b.slot.field != f) continue;
      for (const motion::Param& q : b.params)
        if (q.kind == motion::Param::Kind::MANUAL) return ix.track(q.track);
    }
    return nullptr;
  };
  motion::LayerBase base = an->base;
  Vec2 rest = scale ? base.scale : base.translation;
  // Copies: the index is rebuilt by the writes below.
  struct Key {
    int64_t timeUs;
    KeyframeValue value;
    motion::EasingSpec easing;
    VariableData easingVar;
  };
  auto keysOf = [](const motion::Track* t) {
    std::vector<Key> out;
    if (t)
      for (const motion::Keyframe& k : t->keyframes) out.push_back({k.timeUs, k.value, k.easing, k.easingVar});
    return out;
  };
  auto easingJson = [](const Key& k) {
    // The keyframe's easing as the public shape motionUpsertKeyframe takes (a variable's alias, else its value).
    json::Writer w;
    if (k.easingVar.kind == VariableData::Kind::ALIAS && k.easingVar.alias.guid != kNoGuid)
      w.beginObject().key("variable").string(k.easingVar.alias.guid.toString()).endObject();
    else
      writePublicEasing(w, k.easing);
    json::Value v;
    json::parse(w.str(), v);
    return v;
  };
  Slot sx = nodeSlot(fx), sy = nodeSlot(fy), sxy = nodeSlot(fxy);
  const motion::Track* tx = manual(fx);
  const motion::Track* ty = manual(fy);
  const motion::Track* txy = manual(fxy);
  if (combine) {
    if (!tx && !ty) return E_INVALID;
    std::vector<Key> xs = keysOf(tx), ys = keysOf(ty);
    motion::Track cx, cy;
    if (tx) cx = *tx;
    if (ty) cy = *ty;
    std::vector<int64_t> times;
    for (const Key& k : xs) times.push_back(k.timeUs);
    for (const Key& k : ys) times.push_back(k.timeUs);
    std::sort(times.begin(), times.end());
    times.erase(std::unique(times.begin(), times.end()), times.end());
    Guid txId = tx ? tx->id : kNoGuid, tyId = ty ? ty->id : kNoGuid, txyId = txy ? txy->id : kNoGuid;
    begin(TxnKind::USER, "Combine tracks");
    if (txId != kNoGuid) motionRemoveTrack(txId);
    if (tyId != kNoGuid) motionRemoveTrack(tyId);
    if (txyId != kNoGuid) motionRemoveTrack(txyId);
    Guid track = motionEnsureTrack(node, sxy, root);
    for (int64_t t : times) {
      KeyframeValue vx = KeyframeValue::number(rest.x), vy = KeyframeValue::number(rest.y);
      if (!xs.empty()) motion::trackValue(cx, t, vx);
      if (!ys.empty()) motion::trackValue(cy, t, vy);
      const Key* from = nullptr;
      for (const Key& k : xs)
        if (k.timeUs == t) from = &k;
      if (!from)
        for (const Key& k : ys)
          if (k.timeUs == t) from = &k;
      json::Value e = easingJson(*from);
      if (track != kNoGuid) motionUpsertKeyframe(track, t, KeyframeValue::vector({vx.f, vy.f}), &e);
    }
    motionDirty_ = true;
    commit();
    return OK;
  }
  if (!txy) return E_INVALID;
  std::vector<Key> keys = keysOf(txy);
  Guid txyId = txy->id;
  begin(TxnKind::USER, "Split tracks");
  motionRemoveTrack(txyId);
  if (tx) motionRemoveTrack(tx->id);
  if (ty) motionRemoveTrack(ty->id);
  Guid gx = motionEnsureTrack(node, sx, root);
  Guid gy = motionEnsureTrack(node, sy, root);
  for (const Key& k : keys) {
    Vec2 v = k.value.kind == ValueKind::VECTOR ? k.value.v : Vec2{k.value.f, k.value.f};
    json::Value e = easingJson(k);
    if (gx != kNoGuid) motionUpsertKeyframe(gx, k.timeUs, KeyframeValue::number(v.x), &e);
    if (gy != kNoGuid) motionUpsertKeyframe(gy, k.timeUs, KeyframeValue::number(v.y), &e);
  }
  motionDirty_ = true;
  commit();
  return OK;
}

// ---- Audio (round 8e; docs/motion.md §4.11, §6.6) --------------------------------------------------------------------

namespace {

// A clip and a row as the schema's AudioFill / AudioTrack JSON (GUIDs as "s:l", times in µs).
json::Value audioClipJson(const motion::AudioClip& c) {
  json::Value o = jobj();
  put(o, "id", jstr(c.id.toString()));
  put(o, "mediaHash", jstr(c.mediaHash));
  put(o, "timelineOffsetUs", jnum(static_cast<double>(c.offsetUs)));
  put(o, "startTimeUs", jnum(static_cast<double>(c.startUs)));
  put(o, "durationUs", jnum(static_cast<double>(c.durationUs)));
  put(o, "volume", jnum(c.volume));
  put(o, "mute", jbool(c.mute));
  put(o, "displayName", jstr(c.name));
  put(o, "loopEnabled", jbool(c.loop));
  put(o, "playbackDurationUs", jnum(static_cast<double>(c.playbackDurationUs)));
  put(o, "trackId", jstr(c.track.toString()));
  put(o, "loopPhaseOffsetUs", jnum(static_cast<double>(c.loopPhaseUs)));
  return o;
}

json::Value audioRowJson(const motion::AudioRow& r) {
  json::Value o = jobj();
  put(o, "id", jstr(r.id.toString()));
  put(o, "name", jstr(r.name));
  put(o, "gain", jnum(r.gain));
  put(o, "mute", jbool(r.mute));
  return o;
}

}  // namespace

// MOTION_ADD_AUDIO / SET_AUDIO / SPLIT_AUDIO / REMOVE_AUDIO on a timeline root's `audioFills` and `audioTracks`: each
// one undo step with §4.9's name. A new clip gets a row of its own (one row per dropped file) unless it names one; a
// row left without clips goes with its last one. Volume is 0–1 (§4.11), a region at least 1 µs long.
Status Editor::motionAudioCommand(CommandId id, const json::Value& raw) {
  Guid root;
  if (!guidOf(member(raw, "root"), root)) root = motionRoot();
  if (root == kNoGuid || root.isDerived() || isLibraryCopy(root) || !motion::isTimelineRoot(doc_, root)) return E_INVALID;
  const NodeProps& rp = doc_.get(root)->props;
  std::vector<motion::AudioClip> clips = motion::decodeAudioClips(rp);
  std::vector<motion::AudioRow> rows = motion::decodeAudioRows(rp);
  auto clipAt = [&](Guid g) {
    for (size_t i = 0; i < clips.size(); i++)
      if (clips[i].id == g) return static_cast<int>(i);
    return -1;
  };
  auto hasRow = [&](Guid g) { return std::any_of(rows.begin(), rows.end(), [&](const motion::AudioRow& r) { return r.id == g; }); };
  auto num = [&](const json::Value* o, const char* k, double& out) {
    const json::Value* v = member(o, k);
    if (!v || !v->isNumber() || !std::isfinite(v->number)) return false;
    out = v->number;
    return true;
  };
  // The rows that still hold a clip stay (in their order); the clips and the rows written in one change.
  auto store = [&](const char* label) {
    rows.erase(std::remove_if(rows.begin(), rows.end(), [&](const motion::AudioRow& r) {
      return std::none_of(clips.begin(), clips.end(), [&](const motion::AudioClip& c) { return c.track == r.id; });
    }), rows.end());
    json::Value fills, tracks;
    fills.kind = tracks.kind = json::Value::Kind::Array;
    for (const motion::AudioClip& c : clips) fills.array.push_back(audioClipJson(c));
    for (const motion::AudioRow& r : rows) tracks.array.push_back(audioRowJson(r));
    begin(TxnKind::USER, label);
    NodeChange c = NodeChange::changed(root);
    putExtra(c, "audioFills", encodeExtra("audioFills", fills));
    putExtra(c, "audioTracks", encodeExtra("audioTracks", tracks));
    write(c);
    motionDirty_ = true;
    commit();
    return OK;
  };
  switch (id) {
    case CommandId::MOTION_ADD_AUDIO: {
      const json::Value* hash = member(raw, "mediaHash");
      double offset = 0, duration = 0;
      if (!hash || !hash->isString() || hash->string.empty() || !num(&raw, "durationUs", duration) || duration < 1) return E_INVALID;
      num(&raw, "offsetUs", offset);
      const json::Value* name = member(raw, "name");
      motion::AudioClip c;
      c.id = newGuid();
      c.mediaHash = hash->string;
      c.offsetUs = roundUs(offset);
      c.durationUs = c.playbackDurationUs = roundUs(duration);
      c.name = name && name->isString() ? name->string : "";
      if (Guid t; guidOf(member(raw, "trackId"), t) && hasRow(t)) c.track = t;
      else {
        motion::AudioRow r;
        r.id = newGuid();
        r.name = c.name;
        rows.push_back(r);
        c.track = r.id;
      }
      clips.push_back(c);
      Status st = store("Add audio");
      created_.push_back(c.id);
      return st;
    }
    case CommandId::MOTION_SET_AUDIO: {
      // Clip edits (offset, trim, length, volume, mute, row) and row edits (`tracks`: name, gain, mute — the row's eye; ours).
      size_t done = 0;
      if (const json::Value* edits = member(raw, "edits"); edits && edits->isArray())
        for (const json::Value& e : edits->array) {
          Guid g;
          int i = guidOf(member(e, "id"), g) ? clipAt(g) : -1;
          if (i < 0) continue;
          motion::AudioClip& c = clips[i];
          double v;
          if (num(&e, "offsetUs", v)) c.offsetUs = roundUs(v);
          if (num(&e, "startUs", v)) c.startUs = roundUs(v);
          if (num(&e, "durationUs", v)) c.durationUs = c.playbackDurationUs = std::max<int64_t>(1, roundUs(v));
          if (num(&e, "volume", v)) c.volume = std::clamp(v, 0.0, 1.0);
          if (const json::Value* m = member(e, "mute"); m && m->isBool()) c.mute = m->boolean;
          if (Guid t; guidOf(member(e, "trackId"), t) && hasRow(t)) c.track = t;
          done++;
        }
      if (const json::Value* list = member(raw, "tracks"); list && list->isArray())
        for (const json::Value& e : list->array) {
          Guid g;
          if (!guidOf(member(e, "id"), g)) continue;
          for (motion::AudioRow& r : rows) {
            if (r.id != g) continue;
            double v;
            if (num(&e, "gain", v)) r.gain = std::clamp(v, 0.0, 1.0);
            if (const json::Value* m = member(e, "mute"); m && m->isBool()) r.mute = m->boolean;
            if (const json::Value* n = member(e, "name"); n && n->isString()) r.name = n->string;
            done++;
          }
        }
      return done ? store("Edit audio") : E_INVALID;
    }
    case CommandId::MOTION_SPLIT_AUDIO: {
      // ⌥K: the clip under the playhead becomes two regions of the same file on the same row, the second one new.
      Guid g;
      double at = 0;
      int i = guidOf(member(raw, "id"), g) ? clipAt(g) : -1;
      if (i < 0 || !num(&raw, "atUs", at)) return E_INVALID;
      int64_t cut = roundUs(at);
      const motion::AudioClip first = clips[i];
      if (cut <= first.offsetUs || cut >= first.offsetUs + first.durationUs) return E_INVALID;
      motion::AudioClip second = first;
      second.id = newGuid();
      second.offsetUs = cut;
      second.startUs = first.startUs + (cut - first.offsetUs);
      second.durationUs = second.playbackDurationUs = first.offsetUs + first.durationUs - cut;
      clips[i].durationUs = clips[i].playbackDurationUs = cut - first.offsetUs;
      clips.insert(clips.begin() + i + 1, second);
      Status st = store("Split audio");
      created_.push_back(second.id);
      return st;
    }
    case CommandId::MOTION_REMOVE_AUDIO: {
      const json::Value* ids = member(raw, "ids");
      if (!ids || !ids->isArray()) return E_INVALID;
      size_t before = clips.size();
      for (const json::Value& v : ids->array)
        if (Guid g; guidOf(&v, g))
          if (int i = clipAt(g); i >= 0) clips.erase(clips.begin() + i);
      return clips.size() < before ? store("Delete audio") : E_INVALID;
    }
    default: return E_UNSUPPORTED;
  }
}

// ---- Presets (docs/motion.md §4.6; round 8h) ----------------------------------------------------------------------------

// The layer whose `animationPresets` lists `preset`, kNoGuid when none.
Guid Editor::motionPresetOwner(Guid preset) const {
  Guid found = kNoGuid;
  doc_.forEach([&](const Node& n) {
    if (found != kNoGuid || n.guid.isDerived() || !n.props.extra.count("animationPresets")) return;
    for (Guid g : motion::decodePresetList(n.props))
      if (g == preset) found = n.guid;
  });
  return found;
}

// A layer's `animationPresets` (521) written: the instances in stacking order on the timeline of the root it is under
// (an empty list removes the field).
void Editor::motionWritePresetList(Guid node, const std::vector<Guid>& presets) {
  NodeChange c = NodeChange::changed(node);
  if (presets.empty()) {
    putExtra(c, "animationPresets", std::string());
  } else {
    Guid root = motionIndex_.rootOf(doc_, node);
    json::Value list, out = jobj();
    list.kind = json::Value::Kind::Array;
    for (Guid g : presets) {
      json::Value e = jobj();
      put(e, "animationPresetId", idJson(g));
      put(e, "timelineDefId", jstr(root.toString()));
      list.array.push_back(e);
    }
    put(out, "presets", list);
    putExtra(c, "animationPresets", encodeExtra("animationPresets", out));
  }
  write(c);
  motionDirty_ = true;
}

// A preset's clip on `node` (docs/motion.md §4.6): an ANIMATION_PRESET_INSTANCE on the internal canvas —
// `backingAnimationPresetId` names the preset type (its assetRef key), `timelineOffset` its start (the Delay),
// `timelineDuration` its length (Figma's 0.5 s when not given), `easingData` its easing (Figma's Ease out), its other
// props its `componentPropAssignments` — appended to the layer's `animationPresets`, and the runtime's `output`
// materialised. A transaction is open.
Guid Editor::motionAddPreset(Guid node, Guid root, const json::Value& spec, int64_t startUs) {
  const json::Value* key = member(spec, "preset");
  if (!doc_.has(node) || !key || !key->isString() || key->string.empty()) return kNoGuid;
  Guid internal = internalCanvas(true);
  if (internal == kNoGuid) return kNoGuid;
  NodeProps pp = defaultProps(NodeType::ANIMATION_PRESET_INSTANCE);
  pp.type = NodeType::ANIMATION_PRESET_INSTANCE;
  const json::Value* name = member(spec, "name");
  pp.name = name && name->isString() && !name->string.empty() ? name->string : key->string;
  pp.parentIndex = {internal, doc_.positionAtEnd(internal)};
  json::Value backing = jobj(), ref = jobj();
  put(ref, "key", jstr(key->string));
  put(backing, "assetRef", ref);
  pp.extra["backingAnimationPresetId"] = encodeExtra("backingAnimationPresetId", backing);
  pp.extra["timelineOffset"] = encodeExtra("timelineOffset", jnum(static_cast<double>(startUs)));
  const json::Value* d = member(spec, "durationUs");
  pp.extra["timelineDuration"] = encodeExtra("timelineDuration", jnum(d && d->isNumber() && d->number >= 1 ? std::round(d->number) : 500000));
  json::Value ed, easeOut = jobj();
  put(easeOut, "type", jstr("EASE_OUT"));
  const json::Value* e = member(spec, "easing");
  if (!e || !easingFromPublic(*e, ed)) easingFromPublic(easeOut, ed);
  pp.extra["easingData"] = encodeExtra("easingData", ed);
  pp.comp().componentPropAssignments = propAssignments(member(spec, "props"));
  Guid id = newGuid();
  write(NodeChange::created(id, pp));
  std::vector<Guid> list = motion::decodePresetList(doc_.get(node)->props);
  list.push_back(id);
  motionWritePresetList(node, list);
  if (const json::Value* out = member(spec, "output")) motionSetPresetTracks(id, *out);
  motionDirty_ = true;
  return id;
}

// A clip's settings changed (MOTION_SET_ANIMATION): its type, props, start, length, easing, off switch. Without a new
// `output`, a new length scales the clip's tracks (the runtime's tweens span the clip, so that is the code run again)
// and a new easing goes on its keyframes (the tweens carry the clip's easing). A transaction is open.
bool Editor::motionEditPreset(Guid preset, const json::Value& edit) {
  const Node* n = doc_.get(preset);
  if (!n) return false;
  motion::Preset was;
  motion::decodePreset(n->props, preset, was);
  NodeChange c = NodeChange::changed(preset);
  if (const json::Value* key = member(edit, "preset"); key && key->isString() && !key->string.empty()) {
    json::Value backing = jobj(), ref = jobj();
    put(ref, "key", jstr(key->string));
    put(backing, "assetRef", ref);
    putExtra(c, "backingAnimationPresetId", encodeExtra("backingAnimationPresetId", backing));
  }
  if (const json::Value* name = member(edit, "name"); name && name->isString()) {
    c.mask |= F_NAME;
    c.props.name = name->string;
  }
  if (const json::Value* s = member(edit, "startUs"); s && s->isNumber())
    putExtra(c, "timelineOffset", encodeExtra("timelineOffset", jnum(static_cast<double>(roundUs(s->number)))));
  double factor = 1;
  if (const json::Value* d = member(edit, "durationUs"); d && d->isNumber() && d->number >= 1) {
    double us = std::round(d->number);
    putExtra(c, "timelineDuration", encodeExtra("timelineDuration", jnum(us)));
    if (was.durationUs > 0) factor = us / static_cast<double>(was.durationUs);
  }
  if (const json::Value* dis = member(edit, "disabled"); dis && dis->isBool()) putExtra(c, "timelineDisabled", encodeExtra("timelineDisabled", jbool(dis->boolean)));
  const json::Value* easing = member(edit, "easing");
  json::Value ed;
  EasingSpec spec;
  bool eased = easing && easingFromPublic(*easing, ed, &spec);
  if (eased) putExtra(c, "easingData", encodeExtra("easingData", ed));
  if (const json::Value* props = member(edit, "props"); props && props->isObject()) {
    c.mask |= F_COMPONENT_PROP_ASSIGNMENTS;
    c.props.comp().componentPropAssignments = propAssignments(props);
    // Delay / Duration / Easing bound to variables (round 8i) aren't props: they stay.
    for (const ComponentPropAssignment& a : n->props.comp().componentPropAssignments)
      if (a.boundValue.kind == VariableData::Kind::ALIAS && !a.value.hasFloat && !a.value.hasBool && !a.value.hasText)
        c.props.comp().componentPropAssignments.push_back(a);
  }
  const json::Value* output = member(edit, "output");
  const json::Value* variables = member(edit, "variables");
  if (!c.mask && !output && !(variables && variables->isObject())) return false;
  if (c.mask) write(c);
  if (variables && variables->isObject()) motionBindPresetVariables(preset, *variables);
  if (output) {
    motionSetPresetTracks(preset, *output);
  } else {
    if (factor != 1) motionScalePreset(preset, factor);
    if (eased)
      for (Guid t : doc_.children(preset))
        for (Guid k : doc_.children(t)) {
          NodeChange kc = NodeChange::changed(k);
          putExtra(kc, "easingData", encodeExtra("easingData", ed));
          putExtra(kc, "interpolationType", encodeExtra("interpolationType", jstr(interpolationTypeOf(spec.type))));
          write(kc);
        }
  }
  motionDirty_ = true;
  return true;
}

bool Editor::motionEasingData(const json::Value& pub, json::Value& out) { return easingFromPublic(pub, out); }

// A keyframe's easing bound to an EASING variable — its own `parameterConsumptionMap` EASING_DATA alias (Figma's, docs/
// research/rea/motion.md §2.9) — or unbound (kNoGuid); its easingData stays what it was written (round 8i). A
// transaction is open.
void Editor::motionBindEasing(Guid keyframe, Guid variable) {
  const Node* n = doc_.get(keyframe);
  if (!n) return;
  std::vector<ParamBinding> map;
  bool had = false;
  for (const ParamBinding& b : n->props.parameterConsumptionMap)
    if (b.field == VariableField::EASING_DATA) had = true;
    else map.push_back(b);
  if (variable == kNoGuid && !had) return;
  if (variable != kNoGuid) {
    ParamBinding b;
    b.field = VariableField::EASING_DATA;
    b.data = VariableData::aliasOf(variable, VariableResolvedType::EASING);
    map.push_back(b);
  }
  NodeChange c = NodeChange::changed(keyframe);
  c.mask = F_PARAM_MAP;
  c.props.parameterConsumptionMap = std::move(map);
  write(c);
  motionDirty_ = true;
}

// A clip's Delay, Duration and Easing bound to TIMING / EASING variables (round 8i; docs/motion.md §4.6: "values in
// ComponentPropValue or bound in varValue"): `variables` {delay, duration, easing} each a variable's GUID, or null to
// unbind — the assignment on that prop's defID (presetPropId) holding only the alias. A transaction is open.
void Editor::motionBindPresetVariables(Guid preset, const json::Value& variables) {
  const Node* n = doc_.get(preset);
  if (!n || !variables.isObject()) return;
  std::vector<ComponentPropAssignment> list = n->props.comp().componentPropAssignments;
  bool changed = false;
  for (const char* key : {"delay", "duration", "easing"}) {
    const json::Value* v = variables.get(key);
    if (!v) continue;
    Guid def = motion::presetPropId(key);
    size_t before = list.size();
    list.erase(std::remove_if(list.begin(), list.end(), [&](const ComponentPropAssignment& a) { return a.defID == def; }), list.end());
    changed |= list.size() != before;
    Guid var;
    if (!guidOf(v, var)) continue;
    ComponentPropAssignment a;
    a.defID = def;
    a.boundValue = VariableData::aliasOf(var, std::string(key) == "easing" ? VariableResolvedType::EASING : VariableResolvedType::TIMING);
    list.push_back(std::move(a));
    changed = true;
  }
  if (!changed) return;
  NodeChange c = NodeChange::changed(preset);
  c.mask = F_COMPONENT_PROP_ASSIGNMENTS;
  c.props.comp().componentPropAssignments = std::move(list);
  write(c);
  motionDirty_ = true;
}

// A clip's tracks stretched by `factor` about its start (its keyframes' positions in the clip's own time), and a text
// stagger's step with them (both are parts of the clip's length).
void Editor::motionScalePreset(Guid preset, double factor) {
  if (const Node* n = doc_.get(preset)) {
    json::Value b = motion::extraJson(n->props, "textElementDelayBehaviour");
    if (const json::Value* d = member(b, "delayMs"); d && d->isNumber()) {
      put(b, "delayMs", jnum(d->number * factor));
      NodeChange c = NodeChange::changed(preset);
      putExtra(c, "textElementDelayBehaviour", encodeExtra("textElementDelayBehaviour", b));
      write(c);
    }
  }
  for (Guid t : doc_.children(preset))
    for (Guid k : doc_.children(t)) {
      const Node* kn = doc_.get(k);
      motion::Keyframe kf;
      if (!kn || !motion::decodeKeyframe(kn->props, k, kf)) continue;
      NodeChange c = NodeChange::changed(k);
      putExtra(c, "timelinePosition", encodeExtra("timelinePosition", jnum(static_cast<double>(roundUs(static_cast<double>(kf.timeUs) * factor)))));
      write(c);
    }
  motionDirty_ = true;
}

// A preset's materialised output (docs/motion.md §4.6: the `figma:motion` runtime's AnimationPreset, in public units and
// µs from the clip's start) replaces its tracks: each one a KEYFRAME_TRACK child of the instance with the track's
// operation, its keyframes upserted by position (a duplicate position in the output collapses to the last one, as
// Figma's), bound to the layer's field by an ANIMATION_PRESET parameter placed after the other presets' and before the
// manual track. A SCALE track's values are multipliers (never converted). A text stagger (§4.10) on a text: the
// tracks span one element's part of the clip — g = D / (1 + (m − 1)(1 − overlap)) of the clip's D, m the order's slots
// for the text as laid out now — and the step between elements goes in the instance's own
// `textElementDelayBehaviour` (TextStagger.h). A transaction is open.
void Editor::motionSetPresetTracks(Guid preset, const json::Value& output) {
  std::vector<Guid> old;
  for (Guid t : doc_.children(preset))
    if (const Node* tn = doc_.get(t); tn && tn->props.type == NodeType::KEYFRAME_TRACK) old.push_back(t);
  for (Guid t : old) motionRemoveTrack(t);
  Guid owner = motionPresetOwner(preset);
  if (owner == kNoGuid) return;
  Guid root = motionIndex_.rootOf(doc_, owner);
  double timeScale = 1;
  {
    motion::Preset clip;
    motion::decodePreset(doc_.get(preset)->props, preset, clip);
    const json::Value* ts = member(output, "textStagger");
    NodeChange c = NodeChange::changed(preset);
    if (ts && ts->isObject() && doc_.get(owner)->props.type == NodeType::TEXT) {
      constexpr const char* kGroupings[] = {"CHARACTER", "CHARACTER_NO_WHITESPACE", "WORD", "LINE", "PARAGRAPH"};
      constexpr const char* kOrders[] = {"LEFT_RIGHT", "RIGHT_LEFT", "CENTER_OUT", "RANDOM"};
      auto pick = [&](const char* key, const char* const* names, int count) {
        const json::Value* v = member(ts, key);
        for (int i = 0; v && v->isString() && i < count; i++)
          if (v->string == names[i]) return i;
        return 0;
      };
      int grouping = pick("grouping", kGroupings, 5), order = pick("order", kOrders, 4);
      const json::Value* ov = member(ts, "overlap");
      double overlap = ov && ov->isNumber() ? ov->number / 100 : 0.5;
      const text::TextLayout* L = textLayout(owner);
      size_t n = L ? motion::groupElements(*L, static_cast<motion::Grouping>(grouping)).boxes.size() : 1;
      uint32_t slots = motion::slotsOf(motion::staggerRanks(n, static_cast<motion::StaggerOrder>(order), owner));
      int64_t elementUs = clip.durationUs, stepUs = 0;
      motion::staggerTiming(clip.durationUs, slots, overlap, elementUs, stepUs);
      timeScale = clip.durationUs > 0 ? static_cast<double>(elementUs) / static_cast<double>(clip.durationUs) : 1;
      json::Value b = jobj();
      put(b, "enabled", jbool(true));
      put(b, "grouping", jstr(kGroupings[grouping]));
      put(b, "delayMs", jnum(static_cast<double>(stepUs) / 1000));
      put(b, "order", jstr(kOrders[order]));
      putExtra(c, "textElementDelayBehaviour", encodeExtra("textElementDelayBehaviour", b));
    } else if (doc_.get(preset)->props.extra.count("textElementDelayBehaviour")) {
      putExtra(c, "textElementDelayBehaviour", std::string());
    }
    if (c.mask) write(c);
  }
  const json::Value* tracks = member(output, "tracks");
  if (!tracks || !tracks->isArray()) return;
  for (const json::Value& tr : tracks->array) {
    if (const json::Value* en = member(tr, "enabled"); en && en->isBool() && !en->boolean) continue;
    Slot slot;
    if (!slotFromPublic(member(tr, "field"), slot)) continue;
    VariableData base;
    std::vector<motion::Param> params;
    if (!motionBindingOf(doc_.get(owner)->props, slot, base, params)) continue;  // the layer has no such field
    const json::Value* op = member(tr, "operation");
    std::string operation = op && op->isString() && (op->string == "OFFSET" || op->string == "SCALE") ? op->string : "SET";
    NodeProps tp = defaultProps(NodeType::KEYFRAME_TRACK);
    tp.type = NodeType::KEYFRAME_TRACK;
    tp.name = keyOf(slot);
    tp.parentIndex = {preset, doc_.positionAtEnd(preset)};
    tp.extra["keyframeOperation"] = encodeExtra("keyframeOperation", jstr(operation));
    Guid track = newGuid();
    write(NodeChange::created(track, tp));
    if (const json::Value* keys = member(tr, "keyframes"); keys && keys->isArray())
      for (const json::Value& k : keys->array) {
        const json::Value* t = member(k, "timeUs");
        if (!t || !t->isNumber()) continue;
        KeyframeValue value;
        const json::Value* v = member(k, "value");
        if (operation == "SCALE") {
          // A multiplier: a FLOAT (uniform on an XY field) or a VECTOR, as it is.
          const json::Value* type = member(v, "type");
          const json::Value* val = member(v, "value");
          if (!type || !type->isString() || !val) continue;
          if (type->string == "FLOAT" && val->isNumber()) value = slotKind(slot) == ValueKind::VECTOR ? KeyframeValue::vector({val->number, val->number}) : KeyframeValue::number(val->number);
          else if (type->string == "VECTOR" && val->isObject()) value = KeyframeValue::vector({member(val, "x") ? member(val, "x")->numberOr(1) : 1, member(val, "y") ? member(val, "y")->numberOr(1) : 1});
          else continue;
        } else if (!valueFromPublic(v, slot, value)) {
          continue;
        }
        motionUpsertKeyframe(track, roundUs(t->number * timeScale), value, member(k, "easing"));
      }
    motion::Param q;
    q.kind = motion::Param::Kind::ANIMATION_PRESET;
    q.preset = preset;
    q.track = track;
    q.timelineDef = root;
    auto at = std::find_if(params.begin(), params.end(), [](const motion::Param& x) { return x.kind == motion::Param::Kind::MANUAL; });
    params.insert(at, q);
    motionWriteSlot(owner, slot, keyframeExpression(std::move(base), params));
  }
  motionDirty_ = true;
}

// A clip removed: its tracks (and their parameters), its place in its layer's `animationPresets` and in the composite
// styles that generated it (a style entry left with nothing goes), then the instance. A transaction is open.
void Editor::motionRemovePreset(Guid preset) {
  if (!doc_.has(preset)) return;
  std::vector<Guid> tracks = doc_.children(preset);
  for (Guid t : tracks) motionRemoveTrack(t);
  if (Guid owner = motionPresetOwner(preset); owner != kNoGuid) {
    std::vector<Guid> list = motion::decodePresetList(doc_.get(owner)->props);
    list.erase(std::remove(list.begin(), list.end(), preset), list.end());
    motionWritePresetList(owner, list);
    json::Value styles = motion::extraJson(doc_.get(owner)->props, "styleIdsForAnimation");
    if (styles.isArray()) {
      json::Value kept;
      kept.kind = json::Value::Kind::Array;
      for (json::Value e : styles.array) {
        json::Value gen;
        gen.kind = json::Value::Kind::Array;
        if (const json::Value* g = member(e, "generatedAnimationPresets"); g && g->isArray())
          for (const json::Value& x : g->array) {
            Guid id;
            if (!(guidOf(member(member(x, "animationPresetId"), "guid"), id) && id == preset)) gen.array.push_back(x);
          }
        if (gen.array.empty()) continue;
        put(e, "generatedAnimationPresets", gen);
        kept.array.push_back(e);
      }
      NodeChange c = NodeChange::changed(owner);
      putExtra(c, "styleIdsForAnimation", kept.array.empty() ? std::string() : encodeExtra("styleIdsForAnimation", kept));
      write(c);
    }
  }
  write(NodeChange::removed(preset));
  motionDirty_ = true;
}

// The slot a track belongs to (the first node binding it), false when none.
bool Editor::motionSlotOfTrack(Guid track, Guid& owner, motion::Slot& slot) {
  const motion::MotionIndex& ix = motionIndex();
  bool found = false;
  doc_.forEach([&](const Node& n) {
    if (found || n.guid.isDerived()) return;
    const motion::AnimatedNode* an = ix.node(n.guid);
    if (!an) return;
    for (const motion::Binding& b : an->bindings)
      for (const motion::Param& q : b.params)
        if (q.track == track) {
          owner = n.guid;
          slot = b.slot;
          found = true;
          return;
        }
  });
  return found;
}

// The slot's value at root time `timeUs` (its tracks folded over the base), else its base; stored units.
bool Editor::motionCurrentValue(Guid id, const motion::Slot& slot, int64_t timeUs, motion::KeyframeValue& out) {
  const Node* n = doc_.get(id);
  if (!n) return false;
  const motion::MotionIndex& ix = motionIndex();
  KeyframeValue base;
  const motion::AnimatedNode* an = ix.node(id);
  const motion::Binding* binding = nullptr;
  if (an)
    for (const motion::Binding& b : an->bindings)
      if (b.slot == slot) binding = &b;
  if (binding && binding->base.kind == VariableData::Kind::FLOAT) base = KeyframeValue::number(binding->base.floatValue);
  else if (binding && binding->base.kind == VariableData::Kind::COLOR) base = KeyframeValue::color(binding->base.colorValue);
  else if (binding && binding->base.present()) {
    Resolved r;
    if (resolveValue(binding->base, id, r) && r.kind == Resolved::Kind::FLOAT) base = KeyframeValue::number(r.f);
    else if (resolveValue(binding->base, id, r) && r.kind == Resolved::Kind::COLOR) base = KeyframeValue::color(r.c);
    else if (!motionBaseValue(n->props, slot, base)) return false;
  } else if (!motionBaseValue(n->props, slot, base)) {
    return false;
  }
  if (!binding) {
    out = base;
    return true;
  }
  Guid root = ix.rootOf(doc_, id);
  motion::Timeline tl = ix.timeline(doc_, root);
  int64_t tau = motion::localTime(timeUs - tl.offsetUs, tl.durationUs, tl.playback);
  if (!motion::foldValue(base, binding->params, tau, [&](Guid t) { return ix.track(t); }, out)) out = base;
  return true;
}

// Panel writes while Motion is on (docs/motion.md §4.9): a keyframable FLOAT field of a layer under the root with a
// track — or any such field with auto-keyframe on — becomes a keyframe at the playhead; the base stays. Returns the
// fields taken; the caller writes the rest as in Design (a path trim's keyed end is taken out of `props`' extra).
FieldMask Editor::motionRouteWrite(Guid id, NodeChange& props) {
  if (!motion_.on || id.isDerived()) return 0;
  Guid root = motionRoot();
  if (root == kNoGuid || root == id) return 0;
  const motion::MotionIndex& ix = motionIndex();
  if (ix.rootOf(doc_, id) != root) return 0;
  const Node* n = doc_.get(id);
  if (!n) return 0;
  struct Route {
    FieldMask mask;
    VariableField field;
  };
  // The one-field masks a panel writes (the corner radii travel as one group: the uniform radius, or each corner).
  const Route routes[] = {{F_OPACITY, VariableField::OPACITY}, {F_STROKE_WEIGHT, VariableField::STROKE_WEIGHT},
                          {F_STACK_SPACING, VariableField::STACK_SPACING}, {F_STACK_COUNTER_SPACING, VariableField::STACK_COUNTER_SPACING},
                          {F_STACK_PADDING_LEFT, VariableField::STACK_PADDING_LEFT}, {F_STACK_PADDING_TOP, VariableField::STACK_PADDING_TOP},
                          {F_STACK_PADDING_RIGHT, VariableField::STACK_PADDING_RIGHT}, {F_STACK_PADDING_BOTTOM, VariableField::STACK_PADDING_BOTTOM}};
  FieldMask taken = 0;
  std::vector<std::pair<Slot, double>> writes;
  for (const Route& r : routes) {
    if (!(props.mask & r.mask)) continue;
    Slot s;
    s.kind = Slot::Kind::NODE;
    s.field = r.field;
    bool tracked = motionTrackOf(n->props, s) != kNoGuid;
    if (!tracked && !motion_.autoKeyframe) continue;
    double v = 0;
    if (!motion::readNodeFloat(props.props, r.field, v)) continue;
    writes.push_back({s, v});
    taken |= r.mask;
  }
  if (props.mask & F_SIZE) {
    for (VariableField f : {VariableField::WIDTH, VariableField::HEIGHT}) {
      Slot s;
      s.kind = Slot::Kind::NODE;
      s.field = f;
      bool tracked = motionTrackOf(n->props, s) != kNoGuid;
      if (!tracked && !motion_.autoKeyframe) continue;
      double v = f == VariableField::WIDTH ? props.props.size.x : props.props.size.y;
      double cur = f == VariableField::WIDTH ? n->props.size.x : n->props.size.y;
      if (v == cur && !tracked) continue;
      writes.push_back({s, v});
      taken |= F_SIZE;
    }
  }
  if (props.mask & F_CORNER_RADII) {
    const CornerRadii& r = props.props.cornerRadii;
    bool uniform = r[0] == r[1] && r[1] == r[2] && r[2] == r[3];
    Slot s;
    s.kind = Slot::Kind::NODE;
    s.field = VariableField::CORNER_RADIUS;
    bool tracked = motionTrackOf(n->props, s) != kNoGuid;
    if (uniform && (tracked || motion_.autoKeyframe)) {
      writes.push_back({s, r[0]});
      taken |= F_CORNER_RADII;
    }
  }
  // Path trim (docs/motion.md §4.13): the panel writes pathTrim whole; each end moved from what the canvas shows takes a
  // keyframe when it has a track (or with auto-keyframe on), the other keeps the base's — and the base write is left
  // only for an end that isn't keyed.
  if (auto pt = props.props.extra.find("pathTrim"); (props.mask & F_EXTRA) && pt != props.props.extra.end() && !pt->second.empty()) {
    const VariableField ends[2] = {VariableField::PATH_TRIM_START, VariableField::PATH_TRIM_END};
    double want[2] = {0, 1}, base[2] = {0, 1};
    pathTrimOf(props.props, want[0], want[1]);
    pathTrimOf(n->props, base[0], base[1]);
    bool rest = false;
    for (int i = 0; i < 2; i++) {
      Slot s = nodeSlot(ends[i]);
      KeyframeValue shown;
      double cur = motionCurrentValue(id, s, motion_.timeUs, shown) ? shown.f : base[i];
      if (std::fabs(want[i] - cur) < 1e-9) {
        want[i] = base[i];  // unchanged here: the base keeps its own
        continue;
      }
      if (motionTrackOf(n->props, s) == kNoGuid && !motion_.autoKeyframe) {
        rest = true;
        continue;
      }
      writes.push_back({s, want[i]});
      want[i] = base[i];
    }
    if (rest) {
      NodeProps trimmed;
      motion::writeNodeFloat(trimmed, ends[0], want[0]);
      motion::writeNodeFloat(trimmed, ends[1], want[1]);
      pt->second = trimmed.extra["pathTrim"];
    } else {
      props.props.extra.erase(pt);  // nothing for the base: the shown values are the playhead's, not the design's
      if (props.props.extra.empty()) taken |= F_EXTRA;
    }
  }
  if (writes.empty()) return taken;
  for (auto& [s, v] : writes)
    if (const motion::FieldInfo* info = motion::fieldInfo(s.field)) motionKeyAtPlayhead(id, s, root, KeyframeValue::number(motion::nodeToStored(*info, v)));
  return taken;
}

// The keyframe at the playhead takes `value` (stored units), the slot's track made when there is none; a new track's
// first keyframe at t = 0 keeps the value as it was when the playhead is past 0 (docs/motion.md §4.9). A transaction
// is open.
void Editor::motionKeyAtPlayhead(Guid id, const motion::Slot& s, Guid root, const motion::KeyframeValue& value) {
  const Node* n = doc_.get(id);
  if (!n) return;
  KeyframeValue was;
  bool first = motionTrackOf(n->props, s) == kNoGuid && motion_.timeUs > 0 && motionBaseValue(n->props, s, was);
  Guid track = motionEnsureTrack(id, s, root);
  if (track == kNoGuid) return;
  if (first) motionUpsertKeyframe(track, 0, was, nullptr);
  motionUpsertKeyframe(track, motion_.timeUs, value, nullptr);
}

// ---- Gestures (docs/motion.md §4.9; round 8b, increment 2) -------------------------------------------------------------

// Whether a move, resize, rotate or nudge of `ids` is Motion's: Motion is on, each layer is under the timeline's root
// (never the root itself), and auto-keyframe is on or one of them — or a layer above it under the root — is animated
// (the canvas shows it moved by the motion layer). Otherwise the gesture edits the design as in Design.
bool Editor::motionGestureFor(const std::vector<Guid>& ids) {
  if (!motion_.on || ids.empty()) return false;
  Guid root = motionRoot();
  if (root == kNoGuid) return false;
  const motion::MotionIndex& ix = motionIndex();
  bool animated = motion_.autoKeyframe;
  for (Guid id : ids) {
    if (id.isDerived() || id == root || ix.rootOf(doc_, id) != root) return false;
    for (Guid cur = id; !animated && cur != root && doc_.has(cur); cur = doc_.parentOf(cur)) animated = ix.animated(cur);
  }
  return animated;
}

// Opens Motion's gesture for `targets` (read where the canvas shows them: the motion layer's values in); false when
// the gesture is Design's. No transaction: the drag writes previews, pointer-up keys them.
bool Editor::motionStartGesture(const std::vector<Target>& targets, bool rotating) {
  std::vector<Guid> ids;
  for (const Target& t : targets) ids.push_back(t.id);
  if (!motionGestureFor(ids)) return false;
  motionDrag_ = MotionDrag{};
  motionDrag_.on = true;
  motionDrag_.rotating = rotating;
  for (const Target& t : targets) motionDrag_.items.push_back({t.id, t.transform, t.size, t.transform, t.size});
  return true;
}

// One step of the drag: the layer drawn at `transform` / `size` (its parent's space) as a preview write.
void Editor::motionPreview(Guid id, const Mat2x3& transform, Vec2 size) {
  const Node* n = doc_.get(id);
  if (!n) return;
  NodeChange c = NodeChange::changed(id);
  c.mask = F_TRANSFORM | F_SIZE;
  c.props = n->props;
  c.props.transform = transform;
  c.props.size = size;
  motionLayer_.preview(doc_, c);
  for (MotionDrag::Item& it : motionDrag_.items)
    if (it.id == id) it.to = transform, it.toSize = size;
  motionDrag_.moved = true;
  needsRender_ = true;
}

// Pointer-up: the gesture keyed in one step (its undo name `label`).
void Editor::motionFinishGesture(const char* label) {
  MotionDrag drag = std::move(motionDrag_);
  motionDrag_ = MotionDrag{};
  if (!drag.moved) return;  // a press on a handle that never dragged: nothing shown, nothing to key
  begin(TxnKind::GESTURE, label);  // the layer puts the base values back, the previews with them
  for (const MotionDrag::Item& it : drag.items) motionKeyPose(it.id, it.shown, it.shownSize, it.to, it.toSize, drag.rotating);
  commit();  // and applies again: the layers show the keyed values, where the drag left them
}

// Esc, blur, pointer-cancel: the previews go (nothing was written).
void Editor::motionCancelGesture() {
  motionDrag_ = MotionDrag{};
  motionApply();
}

// A layer's motion transform at root time `timeUs` (docs/motion.md §4.5): its translation, rotation, scale and shear
// tracks folded over their bases, with its anchor. Reads base values (the layer restored).
motion::LayerBase Editor::motionPoseAt(Guid id, int64_t timeUs) {
  const Node* n = doc_.get(id);
  if (!n) return motion::LayerBase{};
  motion::LayerBase pose = motion::decodeLayerBase(n->props);
  const motion::AnimatedNode* an = motionIndex().node(id);
  if (!an) return pose;
  for (const motion::Binding& b : an->bindings) {
    if (b.slot.kind != Slot::Kind::NODE || !motion::isMotionTransformField(b.slot.field)) continue;
    KeyframeValue v;
    if (!motionCurrentValue(id, b.slot, timeUs, v)) continue;
    Vec2 xy = v.kind == ValueKind::VECTOR ? v.v : Vec2{v.f, v.f};  // a FLOAT on an XY track is uniform
    switch (b.slot.field) {
      case VariableField::MOTION_TRANSLATION_X: pose.translation.x = v.f; break;
      case VariableField::MOTION_TRANSLATION_Y: pose.translation.y = v.f; break;
      case VariableField::MOTION_TRANSLATION_XY: pose.translation = xy; break;
      case VariableField::MOTION_ROTATION: pose.rotation = v.f; break;
      case VariableField::MOTION_SCALE_X: pose.scale.x = v.f; break;
      case VariableField::MOTION_SCALE_Y: pose.scale.y = v.f; break;
      case VariableField::MOTION_SCALE_XY: pose.scale = xy; break;
      case VariableField::MOTION_SHEAR: pose.shear = v.f; break;
      default: break;
    }
  }
  return pose;
}

// One layer's gesture keyed (docs/motion.md §4.9). `shown` / `shownSize`: where the canvas showed it when the gesture
// began; `to` / `toSize`: where the gesture leaves it (its parent's space, the motion layer's values in). Each part
// goes to its motion field at the playhead when the field has a track or auto-keyframe is on — the position to
// TRANSLATION_XY (or the X / Y pair a layer has instead), a turn to ROTATION when `rotating`, a new size to WIDTH /
// HEIGHT — and to the base (x / y, rotation, size, as in Design) otherwise, so the layer ends where the gesture left
// it. With the motion transform M · T(o) · T(t) · L · T(−o) (L = R(r) · Shear(k) · S(s)), the translation that puts it
// at `to` is t = M⁻¹(to − M's origin) − o + L·o (linear parts). A transaction is open (base values).
void Editor::motionKeyPose(Guid id, const Mat2x3& shown, Vec2 shownSize, const Mat2x3& to, Vec2 toSize, bool rotating) {
  const Node* n = doc_.get(id);
  Guid root = motionRoot();
  if (!n || root == kNoGuid) return;
  const NodeProps base = n->props;
  auto routed = [&](VariableField f) { return motion_.autoKeyframe || motionTrackOf(base, nodeSlot(f)) != kNoGuid; };
  const double eps = 1e-6;
  motion::LayerBase pose = motionPoseAt(id, motion_.timeUs);
  std::vector<std::pair<Slot, KeyframeValue>> keys;
  // The size: WIDTH / HEIGHT keyframes, else the base's.
  Vec2 size = base.size;
  for (VariableField f : {VariableField::WIDTH, VariableField::HEIGHT}) {
    bool w = f == VariableField::WIDTH;
    double from = w ? shownSize.x : shownSize.y, want = w ? toSize.x : toSize.y;
    if (std::fabs(want - from) < eps) continue;
    if (routed(f)) keys.push_back({nodeSlot(f), KeyframeValue::number(motion::nodeToStored(*motion::fieldInfo(f), want))});
    else (w ? size.x : size.y) = want;
  }
  // The turn: ROTATION, else the base's linear part takes it (a flip of a resize too).
  Vec2 o = motion::MotionLayer::anchorPoint(pose, size);
  Mat2x3 ml = linearPart(base.transform);
  Mat2x3 toL = linearPart(to), shownL = linearPart(shown);
  double r = pose.rotation;
  if (rotating && routed(VariableField::MOTION_ROTATION)) {
    Mat2x3 q = ml.inverse() * toL * shownL.inverse() * ml;  // the turn in the layer's own space
    double turn = std::atan2(q.m10, q.m00);
    if (std::fabs(turn) > eps) {
      r += turn;
      keys.push_back({nodeSlot(VariableField::MOTION_ROTATION), KeyframeValue::number(r)});
    }
  } else if (!nearlyEqual(toL, shownL, eps)) {
    Mat2x3 l = motionLinear(r, pose.shear, pose.scale);
    if (std::fabs(l.determinant()) > eps) ml = toL * l.inverse();
  }
  // The position: TRANSLATION_XY (or X / Y), else the base's origin takes what the keys don't.
  Vec2 need = ml.inverse().applyLinear(to.translation() - base.transform.translation()) - o + motionLinear(r, pose.shear, pose.scale).applyLinear(o);
  Vec2 delta = need - pose.translation, rest = delta;
  bool split = motionTrackOf(base, nodeSlot(VariableField::MOTION_TRANSLATION_X)) != kNoGuid ||
               motionTrackOf(base, nodeSlot(VariableField::MOTION_TRANSLATION_Y)) != kNoGuid;
  if (split) {
    if (std::fabs(delta.x) > eps && routed(VariableField::MOTION_TRANSLATION_X)) {
      keys.push_back({nodeSlot(VariableField::MOTION_TRANSLATION_X), KeyframeValue::number(need.x)});
      rest.x = 0;
    }
    if (std::fabs(delta.y) > eps && routed(VariableField::MOTION_TRANSLATION_Y)) {
      keys.push_back({nodeSlot(VariableField::MOTION_TRANSLATION_Y), KeyframeValue::number(need.y)});
      rest.y = 0;
    }
  } else if ((std::fabs(delta.x) > eps || std::fabs(delta.y) > eps) && routed(VariableField::MOTION_TRANSLATION_XY)) {
    keys.push_back({nodeSlot(VariableField::MOTION_TRANSLATION_XY), KeyframeValue::vector(need)});
    rest = {0, 0};
  }
  Mat2x3 m = ml;
  Vec2 shift = ml.applyLinear(rest);
  m.m02 = base.transform.m02 + shift.x;
  m.m12 = base.transform.m12 + shift.y;
  NodeChange c = NodeChange::changed(id);
  if (!nearlyEqual(m, base.transform, 1e-9)) c.mask |= F_TRANSFORM, c.props.transform = m;
  if (!(size == base.size)) c.mask |= F_SIZE, c.props.size = size;
  if (c.mask) write(c);
  if (c.mask & F_SIZE) keepResizedSize(id, size.x != base.size.x, size.y != base.size.y);
  for (auto& [s, v] : keys) motionKeyAtPlayhead(id, s, root, v);
}

// Shifts a layer's motion translation by `by` (its own space) at every time: the keyframes of its manual position
// tracks, else the base motionTransform's translation (the anchor kept in place).
void Editor::motionShiftTranslation(Guid id, Vec2 by) {
  const Node* n = doc_.get(id);
  if (!n) return;
  const NodeProps p = n->props;
  auto shift = [&](Guid track, Vec2 d) {
    for (Guid k : doc_.children(track)) {
      const Node* kn = doc_.get(k);
      motion::Keyframe kf;
      if (!kn || !motion::decodeKeyframe(kn->props, k, kf)) continue;
      if (kf.value.kind == ValueKind::VECTOR) kf.value.v = kf.value.v + d;
      else kf.value.f += d.x;
      NodeChange c = NodeChange::changed(k);
      putExtra(c, "keyframeValue", encodeExtra("keyframeValue", keyframeValueJson(kf.value)));
      write(c);
    }
    motionDirty_ = true;
  };
  bool baseX = true, baseY = true;
  if (Guid t = motionTrackOf(p, nodeSlot(VariableField::MOTION_TRANSLATION_XY)); t != kNoGuid) shift(t, by), baseX = baseY = false;
  if (Guid t = motionTrackOf(p, nodeSlot(VariableField::MOTION_TRANSLATION_X)); t != kNoGuid) shift(t, {by.x, 0}), baseX = false;
  if (Guid t = motionTrackOf(p, nodeSlot(VariableField::MOTION_TRANSLATION_Y)); t != kNoGuid) shift(t, {by.y, 0}), baseY = false;
  if (!baseX && !baseY) return;
  motion::LayerBase b = motion::decodeLayerBase(p);
  b.translation = b.translation + Vec2{baseX ? by.x : 0, baseY ? by.y : 0};
  json::Value mt = jobj();
  put(mt, "translation", jvec(b.translation));
  put(mt, "rotation", jnum(b.rotation));
  put(mt, "scale", jvec(b.scale));
  put(mt, "shearX", jnum(b.shear));
  NodeChange c = NodeChange::changed(id);
  putExtra(c, "motionTransform", encodeExtra("motionTransform", mt));
  write(c);
  motionDirty_ = true;
}

// ---- Ownership: copies animate on tracks of their own (docs/motion.md §4.2; round 8b, increment 2) -------------------

// A copied layer's props (a duplicate, a paste, a detached instance's layer) before it is written: each manual track
// its KEYFRAME expressions name is copied with its keyframes — from `clip` when the clipboard carries it, else from the
// document — and the parameter re-pointed at the copy and at the timeline of the root `parent` is under; a track found
// nowhere drops its parameter (the last one gone, the base is the slot's binding again). Round 8h: each preset's
// instance is copied with its tracks, the layer's `animationPresets` and its styles' generated lists re-pointed at the
// copies, and the ANIMATION_PRESET parameters with them. A transaction is open.
void Editor::motionCopyTracks(NodeProps& p, Guid parent, const std::vector<NodeChange>* clip) {
  std::vector<std::pair<Slot, VariableData>> found;
  forEachKeyframeSlot(p, [&](const Slot& s, const VariableData& d) { found.push_back({s, d}); });
  std::vector<Guid> presets = motion::decodePresetList(p);
  if (found.empty() && presets.empty()) return;
  Guid root = motionIndex_.rootOf(doc_, parent);
  std::unordered_map<Guid, Guid, GuidHash> presetCopies, trackCopies;
  if (!presets.empty()) {
    json::Value list, out = jobj();
    list.kind = json::Value::Kind::Array;
    for (Guid g : presets) {
      Guid copy = motionCopyPreset(g, clip, trackCopies);
      if (copy == kNoGuid) continue;
      presetCopies[g] = copy;
      json::Value e = jobj();
      put(e, "animationPresetId", idJson(copy));
      put(e, "timelineDefId", jstr(root.toString()));
      list.array.push_back(e);
    }
    put(out, "presets", list);
    if (list.array.empty()) p.extra.erase("animationPresets");
    else p.extra["animationPresets"] = encodeExtra("animationPresets", out);
    json::Value styles = motion::extraJson(p, "styleIdsForAnimation");
    if (styles.isArray()) {
      json::Value kept;
      kept.kind = json::Value::Kind::Array;
      for (json::Value e : styles.array) {
        json::Value gen;
        gen.kind = json::Value::Kind::Array;
        if (const json::Value* g = member(e, "generatedAnimationPresets"); g && g->isArray())
          for (const json::Value& x : g->array) {
            Guid id;
            if (!guidOf(member(member(x, "animationPresetId"), "guid"), id) || !presetCopies.count(id)) continue;
            json::Value y = jobj();
            put(y, "animationPresetId", idJson(presetCopies[id]));
            gen.array.push_back(y);
          }
        if (gen.array.empty()) continue;
        put(e, "id", jstr(newGuid().toString()));
        put(e, "timelineDefId", jstr(root.toString()));
        put(e, "generatedAnimationPresets", gen);
        kept.array.push_back(e);
      }
      if (kept.array.empty()) p.extra.erase("styleIdsForAnimation");
      else p.extra["styleIdsForAnimation"] = encodeExtra("styleIdsForAnimation", kept);
    }
  }
  for (auto& [s, d] : found) {
    std::vector<motion::Param> params, kept;
    motion::decodeParams(d.args[1], params);
    for (motion::Param q : params) {
      if (q.kind == motion::Param::Kind::MANUAL) {
        q.track = motionCopyTrack(q.track, clip);
        if (q.track == kNoGuid) continue;
      } else if (q.kind == motion::Param::Kind::ANIMATION_PRESET) {
        auto pc = presetCopies.find(q.preset);
        auto tc = trackCopies.find(q.track);
        if (pc == presetCopies.end() || tc == trackCopies.end()) continue;
        q.preset = pc->second;
        q.track = tc->second;
      }
      if (root != kNoGuid && q.kind != motion::Param::Kind::STYLE) q.timelineDef = root;
      kept.push_back(q);
    }
    const VariableData& base = d.args[0];
    if (!kept.empty()) putSlot(p, s, keyframeExpression(base, kept));
    else putSlot(p, s, base.kind == VariableData::Kind::ALIAS || base.kind == VariableData::Kind::EXPRESSION ? base : VariableData{});
  }
  motionDirty_ = true;
}

// A copy of a track and its keyframes on the internal canvas under new GUIDs; kNoGuid when neither the clipboard nor
// the document has it.
Guid Editor::motionCopyTrack(Guid track, const std::vector<NodeChange>* clip) {
  NodeProps tp;
  std::vector<NodeProps> keys;
  bool found = false;
  if (clip) {
    for (const NodeChange& c : *clip)
      if (c.phase != Phase::REMOVED && c.guid == track && c.props.type == NodeType::KEYFRAME_TRACK) tp = c.props, found = true;
    if (found)
      for (const NodeChange& c : *clip)
        if (c.phase != Phase::REMOVED && c.props.type == NodeType::KEYFRAME && c.props.parentIndex.guid == track) keys.push_back(c.props);
  }
  if (!found) {
    const Node* t = doc_.get(track);
    if (!t || t->props.type != NodeType::KEYFRAME_TRACK) return kNoGuid;
    tp = t->props;
    for (Guid k : doc_.children(track))
      if (const Node* kn = doc_.get(k); kn && kn->props.type == NodeType::KEYFRAME) keys.push_back(kn->props);
  }
  Guid internal = internalCanvas(true);
  if (internal == kNoGuid) return kNoGuid;
  tp.parentIndex = {internal, doc_.positionAtEnd(internal)};
  Guid id = newGuid();
  write(NodeChange::created(id, tp));
  for (NodeProps& kp : keys) {
    kp.parentIndex.guid = id;
    write(NodeChange::created(newGuid(), kp));
  }
  motionDirty_ = true;
  return id;
}

// A copy of a preset's instance, its tracks and their keyframes on the internal canvas under new GUIDs (round 8h), from
// the clipboard when it carries them, else from the document; `tracks` maps each track to its copy. kNoGuid when
// neither has it.
Guid Editor::motionCopyPreset(Guid preset, const std::vector<NodeChange>* clip, std::unordered_map<Guid, Guid, GuidHash>& tracks) {
  NodeProps pp;
  std::vector<std::pair<Guid, NodeProps>> trackProps, keyProps;
  bool found = false;
  if (clip) {
    for (const NodeChange& c : *clip)
      if (c.phase != Phase::REMOVED && c.guid == preset && c.props.type == NodeType::ANIMATION_PRESET_INSTANCE) pp = c.props, found = true;
    if (found)
      for (const NodeChange& c : *clip)
        if (c.phase != Phase::REMOVED && c.props.type == NodeType::KEYFRAME_TRACK && c.props.parentIndex.guid == preset) trackProps.push_back({c.guid, c.props});
    if (found)
      for (const NodeChange& c : *clip)
        for (auto& [t, tp] : trackProps)
          if (c.phase != Phase::REMOVED && c.props.type == NodeType::KEYFRAME && c.props.parentIndex.guid == t) keyProps.push_back({t, c.props});
  }
  if (!found) {
    const Node* n = doc_.get(preset);
    if (!n || n->props.type != NodeType::ANIMATION_PRESET_INSTANCE) return kNoGuid;
    pp = n->props;
    for (Guid t : doc_.children(preset)) {
      const Node* tn = doc_.get(t);
      if (!tn || tn->props.type != NodeType::KEYFRAME_TRACK) continue;
      trackProps.push_back({t, tn->props});
      for (Guid k : doc_.children(t))
        if (const Node* kn = doc_.get(k); kn && kn->props.type == NodeType::KEYFRAME) keyProps.push_back({t, kn->props});
    }
  }
  Guid internal = internalCanvas(true);
  if (internal == kNoGuid) return kNoGuid;
  pp.parentIndex = {internal, doc_.positionAtEnd(internal)};
  Guid id = newGuid();
  write(NodeChange::created(id, pp));
  for (auto& [t, tp] : trackProps) {
    Guid copy = newGuid();
    tracks[t] = copy;
    tp.parentIndex = {id, tp.parentIndex.position};
    write(NodeChange::created(copy, tp));
  }
  for (auto& [t, kp] : keyProps) {
    kp.parentIndex.guid = tracks[t];
    write(NodeChange::created(newGuid(), kp));
  }
  motionDirty_ = true;
  return id;
}

// The clipboard carries the tracks its layers animate on, with their keyframes, outside its regions (as it carries
// brushes), and their presets' instances with theirs (round 8h): a cut, or a paste in another file, keeps the animation.
void Editor::motionClipboard(std::vector<NodeChange>& nodes, const std::vector<const NodeProps*>& copied) const {
  std::unordered_set<Guid, GuidHash> have;
  for (const NodeChange& c : nodes) have.insert(c.guid);
  std::vector<Guid> tracks;
  for (const NodeProps* p : copied)
    forEachKeyframeSlot(*p, [&](const Slot&, const VariableData& d) {
      std::vector<motion::Param> params;
      motion::decodeParams(d.args[1], params);
      for (const motion::Param& q : params) {
        const Node* t = q.kind == motion::Param::Kind::MANUAL ? doc_.get(q.track) : nullptr;
        if (t && t->props.type == NodeType::KEYFRAME_TRACK && have.insert(q.track).second) tracks.push_back(q.track);
      }
    });
  std::vector<Guid> presets;  // read before `nodes` grows (`copied` may point into it)
  for (const NodeProps* p : copied)
    for (Guid preset : motion::decodePresetList(*p)) presets.push_back(preset);
  for (Guid t : tracks) {
    nodes.push_back(NodeChange::created(t, doc_.get(t)->props));
    for (Guid k : doc_.children(t)) nodes.push_back(NodeChange::created(k, doc_.get(k)->props));
  }
  for (Guid preset : presets) {
    const Node* pn = doc_.get(preset);
    if (!pn || !have.insert(preset).second) continue;
    nodes.push_back(NodeChange::created(preset, pn->props));
    for (Guid t : doc_.children(preset)) {
      nodes.push_back(NodeChange::created(t, doc_.get(t)->props));
      for (Guid k : doc_.children(t)) nodes.push_back(NodeChange::created(k, doc_.get(k)->props));
    }
  }
}

// ---- Layout under the motion layer (docs/motion.md §4.5; round 8a, increment 2) ----------------------------------------

// The layers whose size, padding or gap the motion layer wrote, laid out again as Figma lays them out at that time: the
// layout reads the live nodes (the evaluated values in) and its results are the layer's previews too, so restore()
// takes them back with the rest — the document's base, the journal and undo never see them. Constraints act on a frame
// the layer resized, from its base size.
void Editor::motionRelayout(const std::vector<Guid>& dirty) {
  struct Host : LayoutHost {
    Editor& ed;
    explicit Host(Editor& e) : ed(e) {}
    const Document& document() const override { return ed.doc_; }
    void writeGeometry(Guid id, const Mat2x3& transform, Vec2 size) override {
      const Node* n = ed.doc_.get(id);
      if (!n || (n->props.transform == transform && n->props.size == size)) return;
      NodeChange c = NodeChange::changed(id);
      c.mask = F_TRANSFORM | F_SIZE;
      c.props = n->props;
      c.props.transform = transform;
      c.props.size = size;
      ed.motionLayer_.preview(ed.doc_, c);
    }
    bool resizedInTxn(Guid frame, Vec2& oldSize) const override {
      const NodeProps* b = ed.motionLayer_.baseOf(frame);
      const Node* n = ed.doc_.get(frame);
      if (!b || !n || b->size == n->props.size) return false;
      oldSize = b->size;
      return true;
    }
    void base(Guid id, Mat2x3& transform, Vec2& size) const override {
      const NodeProps* b = ed.motionLayer_.baseOf(id);
      const Node* n = ed.doc_.get(id);
      const NodeProps* p = b ? b : n ? &n->props : nullptr;
      if (!p) return;
      transform = p->transform;
      size = p->size;
    }
    bool excludedFromFlow(Guid) const override { return false; }
    bool placedByGesture(Guid) const override { return false; }
    bool ignoreConstraints(Guid) const override { return false; }
    bool measureText(Guid id, double width, Vec2& size) override { return ed.measureText(id, width, size); }
    double firstBaseline(Guid id, Vec2 size) override { return ed.firstBaseline(id, size); }
    Guid slotContentOf(Guid id) override { return ed.slotContentOf(id); }
  } host(*this);
  Layout(host).run(dirty);
}

// ---- The canvas: the motion path and the anchor point (docs/motion.md §4.9, §6.4; round 8a, increment 2) ------------

namespace {

constexpr double kAnchorReach = 8;  // CSS px around the anchor point's target
constexpr double kAnchorSnap = 6;   // CSS px: the target snaps to the layer's corners, edges' middles and centre
constexpr size_t kMaxPathDots = 4000;

}  // namespace

// The anchor point's target: the one selected layer under the timeline's root (never the root), where its anchor is on
// the canvas now (the motion layer's values in). False when there is none.
bool Editor::motionAnchorTarget(Guid& id, Vec2& world) const {
  if (!motion_.on || viewer_ || selection_.size() != 1 || motionDirty_) return false;
  id = selection_[0];
  Guid root = motionRoot();
  const Node* n = doc_.get(id);
  if (!n || id.isDerived() || root == kNoGuid || id == root || motionIndex_.rootOf(doc_, id) != root) return false;
  const motion::AnimatedNode* an = motionIndex_.node(id);
  motion::Timeline tl = motionIndex_.timeline(doc_, root);
  int64_t tau = motion::localTime(motion_.timeUs - tl.offsetUs, tl.durationUs, tl.playback);
  motion::LayerBase pose = an ? motion::MotionLayer::poseAt(motionIndex_, *an, tau) : motion::decodeLayerBase(n->props);
  // The live transform holds the motion transform: the anchor is where it maps the anchor of the box.
  world = doc_.worldTransform(id).apply(motion::MotionLayer::anchorPoint(pose, n->props.size));
  return true;
}

void Editor::motionOverlay(Overlay& o) const {
  Guid id;
  Vec2 anchor;
  if (!motionAnchorTarget(id, anchor)) return;
  if (tool_ == Tool::ANCHOR_POINT || gesture_ == Gesture::MotionAnchor) {
    o.hasAnchorPoint = true;
    o.anchorPoint = gesture_ == Gesture::MotionAnchor ? motionAnchor_.world : anchor;
  }
  const motion::AnimatedNode* an = motionIndex_.node(id);
  if (!an || !motion_.showMotionPath || gesture_ == Gesture::Move) return;
  // The position keyframes: the TRANSLATION_XY track, or the X / Y pair's times merged.
  std::vector<int64_t> times;
  const motion::Track* xy = nullptr;
  for (const motion::Binding& b : an->bindings) {
    if (b.slot.kind != Slot::Kind::NODE) continue;
    VariableField f = b.slot.field;
    if (f != VariableField::MOTION_TRANSLATION_XY && f != VariableField::MOTION_TRANSLATION_X && f != VariableField::MOTION_TRANSLATION_Y) continue;
    for (const motion::Param& q : b.params) {
      const motion::Track* t = motionIndex_.track(q.track);
      if (!t) continue;
      if (f == VariableField::MOTION_TRANSLATION_XY) xy = t;
      for (const motion::Keyframe& k : t->keyframes) times.push_back(k.timeUs);
    }
  }
  if (times.empty()) return;
  std::sort(times.begin(), times.end());
  times.erase(std::unique(times.begin(), times.end()), times.end());
  // Where the anchor goes at local time τ: the layout transform of the base (the motion layer's values out) taking the
  // anchor plus the translation — the path a position animation draws, in the parent's space, then the world's.
  const Node* n = doc_.get(id);
  const NodeProps* base = motionLayer_.baseOf(id);
  const NodeProps& p = base ? *base : n->props;
  Mat2x3 toWorld = doc_.worldTransform(doc_.parentOf(id)) * p.transform;
  auto at = [&](int64_t tau, motion::LayerBase* out = nullptr) {
    motion::LayerBase pose = motion::MotionLayer::poseAt(motionIndex_, *an, tau);
    if (out) *out = pose;
    return toWorld.apply(motion::MotionLayer::anchorPoint(pose, p.size) + pose.translation);
  };
  Guid root = motionRoot();
  motion::Timeline tl = motionIndex_.timeline(doc_, root);
  double frame = tl.fpsNumerator ? std::max(1000.0, 1e6 * tl.fpsDenominator / tl.fpsNumerator) : 1e6 / 60;
  int64_t tau = motion::localTime(motion_.timeUs - tl.offsetUs, tl.durationUs, tl.playback);
  // A dot per frame between the first and the last keyframe (their spacing shows the easing).
  for (size_t k = 0; o.motionDots.size() < kMaxPathDots; k++) {
    int64_t t = times.front() + static_cast<int64_t>(std::llround(static_cast<double>(k) * frame));
    if (t > times.back()) break;
    o.motionDots.push_back(at(t));
  }
  for (int64_t t : times) o.motionKeys.push_back({at(t), static_cast<double>(std::llabs(t - tau)) <= frame / 2});
  // A curved keyframe's handles, from its square (relative to its value).
  if (xy)
    for (const motion::Keyframe& k : xy->keyframes) {
      if (!k.hasPathHandles) continue;
      motion::LayerBase pose;
      Vec2 a = at(k.timeUs, &pose);
      Vec2 o0 = motion::MotionLayer::anchorPoint(pose, p.size) + pose.translation;
      for (Vec2 h : {k.pathIn, k.pathOut})
        if (h.x != 0 || h.y != 0) o.motionHandles.push_back({a, toWorld.apply(o0 + h)});
    }
}

// A press with the anchor point tool: on the target, its drag begins (no transaction: a view state until let go).
bool Editor::motionAnchorPress(Vec2 screen) {
  Guid id;
  Vec2 world;
  if (!motionAnchorTarget(id, world) || (camera_.toScreen(world) - screen).length() > kAnchorReach) return false;
  gesture_ = Gesture::MotionAnchor;
  motionAnchor_ = {id, world};
  needsRender_ = true;
  return true;
}

// The target follows the pointer, snapped to the layer's corners, the middles of its edges and its centre (⌃: free).
void Editor::motionAnchorDrag(Vec2 world, uint32_t mods) {
  const Node* n = doc_.get(motionAnchor_.id);
  if (!n) return;
  Mat2x3 m = doc_.worldTransform(motionAnchor_.id);
  Vec2 to = world;
  if (!(mods & MOD_CTRL)) {
    double best = kAnchorSnap + 1e-9;
    for (double u : {0.0, 0.5, 1.0})
      for (double v : {0.0, 0.5, 1.0}) {
        Vec2 q = m.apply({u * n->props.size.x, v * n->props.size.y});
        double d = (camera_.toScreen(q) - camera_.toScreen(world)).length();
        if (d < best) best = d, to = q;
      }
  }
  motionAnchor_.world = to;
  needsRender_ = true;
}

// Let go: MOTION_SET_ANCHOR with the target's place in the layer's box (as it is drawn), in percent.
void Editor::motionAnchorDrop() {
  MotionAnchorDrag drag = motionAnchor_;
  motionAnchor_ = MotionAnchorDrag{};
  const Node* n = doc_.get(drag.id);
  Guid id;
  Vec2 was;
  if (!n || !(n->props.size.x > 0) || !(n->props.size.y > 0)) return;
  if (motionAnchorTarget(id, was) && id == drag.id && (was - drag.world).length() < 1e-9) return;  // a click: nothing moved
  Vec2 q = doc_.worldTransform(drag.id).inverse().apply(drag.world);
  json::Writer w;
  w.beginObject().key("nodes").beginArray().string(drag.id.toString()).endArray();
  w.key("x").number(q.x / n->props.size.x * 100).key("y").number(q.y / n->props.size.y * 100).endObject();
  CommandArgs a;
  if (json::parse(w.take(), a.raw)) motionCommand(CommandId::MOTION_SET_ANCHOR, a);
  needsRender_ = true;
}

// ---- Reads ----------------------------------------------------------------------------------------------------------

void Editor::writeMotionTimeline(json::Writer& w, Guid rootIn) {
  const motion::MotionIndex& ix = motionIndex();
  Guid root = rootIn != kNoGuid ? ix.rootOf(doc_, rootIn) : motionRoot();
  if (root == kNoGuid || !doc_.has(root)) {
    w.null();
    return;
  }
  motion::Timeline tl = ix.timeline(doc_, root);
  w.beginObject();
  w.key("root").string(root.toString()).key("rootName").string(doc_.get(root)->props.name).key("timelineId").string(root.toString());
  w.key("durationUs").number(static_cast<double>(tl.durationUs));
  w.key("playback").string(tl.playback == motion::Playback::ONCE ? "ONCE" : tl.playback == motion::Playback::BOOMERANG ? "PING_PONG" : "LOOP");
  w.key("snappingFps").number(tl.fpsDenominator ? static_cast<double>(tl.fpsNumerator) / tl.fpsDenominator : 60);
  w.key("layers").beginArray();
  // The Layers panel's order: top first (the last child first), depth from the root. An instance whose main plays is
  // one layer (its purple bar; docs/motion.md §4.3), its sublayers not listed.
  std::vector<std::pair<Guid, int>> order;
  auto playingMain = [&](Guid id) {
    const Node* n = doc_.get(id);
    if (!n || n->props.type != NodeType::INSTANCE) return kNoGuid;
    Guid main = mainOf(id);
    return main != kNoGuid && ix.plays(main) ? main : kNoGuid;
  };
  auto visit = [&](auto&& self, Guid id, int depth) -> void {
    const std::vector<Guid>& kids = doc_.children(id);
    for (size_t i = kids.size(); i-- > 0;) {
      Guid c = kids[i];
      if (c.isDerived()) continue;
      if (ix.animated(c) || playingMain(c) != kNoGuid) order.push_back({c, depth});
      self(self, c, depth + 1);
    }
  };
  visit(visit, root, 1);
  for (auto& [id, depth] : order) {
    const motion::AnimatedNode* an = ix.node(id);
    const Node* n = doc_.get(id);
    if (!n) continue;
    int64_t start = INT64_MAX, end = INT64_MIN;
    w.beginObject();
    w.key("node").string(id.toString()).key("name").string(n->props.name).key("icon").string(nodeTypeName(n->props.type)).key("depth").number(depth);
    if (Guid main = playingMain(id); main != kNoGuid) {
      motion::Assignment a = motion::decodeAssignment(n->props, main, root);
      motion::Timeline mt = ix.timeline(doc_, main);
      w.key("instance").beginObject().key("offsetUs").number(static_cast<double>(a.offsetUs)).key("durationUs").number(static_cast<double>(mt.durationUs));
      w.key("mainTimeline").string(main.toString()).endObject();
      start = a.offsetUs;
      end = a.offsetUs + mt.durationUs;
    }
    static const std::vector<motion::Binding> kNone;
    w.key("tracks").beginArray();
    for (const motion::Binding& b : an ? an->bindings : kNone) {
      for (const motion::Param& q : b.params) {
        const motion::Track* t = ix.track(q.track);
        if (!t || q.kind != motion::Param::Kind::MANUAL) continue;
        w.beginObject();
        w.key("id").string(t->id.toString()).key("field");
        writePublicField(w, b.slot);
        w.key("label").string(labelOf(b.slot));
        w.key("keyframes").beginArray();
        for (const motion::Keyframe& k : t->keyframes) {
          start = std::min(start, k.timeUs);
          end = std::max(end, k.timeUs);
          w.beginObject().key("id").string(k.id.toString()).key("timeUs").number(static_cast<double>(k.timeUs)).key("value");
          writePublicValue(w, b.slot, k.value);
          w.key("easing");
          writePublicEasing(w, k.easing);
          if (k.easingVar.kind == VariableData::Kind::ALIAS && k.easingVar.alias.guid != kNoGuid) w.key("easingVariable").string(k.easingVar.alias.guid.toString());
          if (k.hasPathHandles)
            w.key("pathHandles").beginObject().key("in").beginObject().key("x").number(k.pathIn.x).key("y").number(k.pathIn.y).endObject().key("out").beginObject().key("x").number(k.pathOut.x).key("y").number(k.pathOut.y).endObject().endObject();
          w.endObject();
        }
        w.endArray().endObject();
      }
    }
    w.endArray();
    // The presets' clips (round 8h), in stacking order, each with the composite style that generated it.
    w.key("clips").beginArray();
    std::unordered_map<Guid, std::pair<Guid, std::string>, GuidHash> styleOf;
    json::Value styles = motion::extraJson(n->props, "styleIdsForAnimation");
    if (styles.isArray())
      for (const json::Value& e : styles.array) {
        Guid binding, custom;
        const json::Value* key = member(member(member(e, "animationStyleId"), "assetRef"), "key");
        if (!guidOf(member(e, "id"), binding)) continue;
        // A first-party style by its key; a custom one (round 8i) by its node's GUID.
        std::string name = key && key->isString() ? key->string : guidOf(member(member(e, "animationStyleId"), "guid"), custom) ? custom.toString() : "";
        if (const json::Value* g = member(e, "generatedAnimationPresets"); g && g->isArray())
          for (const json::Value& x : g->array)
            if (Guid id; guidOf(member(member(x, "animationPresetId"), "guid"), id)) styleOf[id] = {binding, name};
      }
    for (Guid preset : an ? an->presets : std::vector<Guid>{}) {
      const motion::Preset* pr = ix.preset(preset);
      const Node* pn = doc_.get(preset);
      if (!pr || !pn) continue;
      start = std::min(start, pr->offsetUs);
      end = std::max(end, pr->offsetUs + pr->durationUs);
      w.beginObject().key("id").string(preset.toString()).key("preset").string(pr->key).key("name").string(pr->name);
      w.key("startUs").number(static_cast<double>(pr->offsetUs)).key("durationUs").number(static_cast<double>(pr->durationUs)).key("disabled").boolean(pr->disabled);
      w.key("easing");
      writePublicEasing(w, pr->easing);
      w.key("props");
      writePropAssignments(w, pn->props.comp().componentPropAssignments);
      w.key("variables");
      writePresetVariables(w, *pr);
      if (auto it = styleOf.find(preset); it != styleOf.end()) w.key("style").beginObject().key("id").string(it->second.first.toString()).key("key").string(it->second.second).endObject();
      w.endObject();
    }
    w.endArray();
    w.key("startUs").number(start == INT64_MAX ? 0 : static_cast<double>(start)).key("endUs").number(end == INT64_MIN ? 0 : static_cast<double>(end));
    w.endObject();
  }
  w.endArray();
  // Audio (round 8e): the rows in their order, then the clips in theirs (docs/motion.md §4.11).
  const NodeProps& rp = doc_.get(root)->props;
  w.key("audioTracks").beginArray();
  for (const motion::AudioRow& r : motion::decodeAudioRows(rp))
    w.beginObject().key("id").string(r.id.toString()).key("name").string(r.name).key("gain").number(r.gain).key("mute").boolean(r.mute).endObject();
  w.endArray();
  w.key("audio").beginArray();
  for (const motion::AudioClip& c : motion::decodeAudioClips(rp)) {
    w.beginObject().key("id").string(c.id.toString()).key("trackId").string(c.track.toString()).key("name").string(c.name).key("mediaHash").string(c.mediaHash);
    w.key("offsetUs").number(static_cast<double>(c.offsetUs)).key("startUs").number(static_cast<double>(c.startUs)).key("durationUs").number(static_cast<double>(c.durationUs));
    w.key("volume").number(c.volume).key("mute").boolean(c.mute).endObject();
  }
  w.endArray();
  w.endObject();
}

void Editor::writeMotionFieldStates(json::Writer& w, const std::vector<Guid>& ids) {
  const motion::MotionIndex& ix = motionIndex();
  w.beginObject();
  for (Guid id : ids) {
    const motion::AnimatedNode* an = ix.node(id);
    w.key(id.toString()).beginObject();
    if (an) {
      Guid root = ix.rootOf(doc_, id);
      motion::Timeline tl = ix.timeline(doc_, root);
      // The playhead within half a snapping frame of a keyframe: that keyframe (docs/motion.md §4.9).
      int64_t tau = motion::localTime(motion_.timeUs - tl.offsetUs, tl.durationUs, tl.playback);
      int64_t half = tl.fpsNumerator ? static_cast<int64_t>(500000.0 * tl.fpsDenominator / tl.fpsNumerator) : 8333;
      for (const motion::Binding& b : an->bindings) {
        Guid at = kNoGuid;
        bool tracked = false;
        for (const motion::Param& q : b.params) {
          const motion::Track* t = ix.track(q.track);
          if (!t || q.kind != motion::Param::Kind::MANUAL) continue;  // a preset's tracks are its clip's, not a diamond's
          tracked = true;
          for (const motion::Keyframe& k : t->keyframes)
            if (std::llabs(k.timeUs - tau) <= half) at = k.id;
        }
        if (!tracked) continue;
        w.key(keyOf(b.slot)).beginObject().key("state").string(at != kNoGuid ? "keyframe" : "track");
        if (at != kNoGuid) w.key("keyframe").string(at.toString());
        w.endObject();
      }
    }
    w.endObject();
  }
  w.endObject();
}

void Editor::writeMotionResolved(json::Writer& w, Guid node) {
  const motion::MotionIndex& ix = motionIndex();
  Guid root = ix.rootOf(doc_, node);
  if (root == kNoGuid) {
    w.null();
    return;
  }
  motion::Timeline tl = ix.timeline(doc_, root);
  w.beginObject();
  w.key("root").string(root.toString()).key("durationUs").number(static_cast<double>(tl.durationUs));
  w.key("playback").string(tl.playback == motion::Playback::ONCE ? "ONCE" : tl.playback == motion::Playback::BOOMERANG ? "PING_PONG" : "LOOP");
  w.key("layers").beginArray();
  // Every animated layer under the root in document order — an instance's sublayers too (its main's tracks, docs/motion.md
  // §4.3), their keyframes moved by the offsets of the instances above them (the main's playback style not unrolled).
  struct Layer {
    Guid row, layer;
    int64_t offsetUs;
  };
  std::vector<Layer> layers;
  auto visit = [&](auto&& self, Guid parent, Guid containing, int64_t offset) -> void {
    for (Guid c : doc_.children(parent)) {
      const Node* n = doc_.get(c);
      if (!n) continue;
      Guid layer = c;
      if (c.isDerived()) {
        auto it = derivedInfo_.find(c);
        layer = it != derivedInfo_.end() ? it->second.source : kNoGuid;
      }
      if (layer != kNoGuid && ix.animated(layer) && (node == root || node == c)) layers.push_back({c, layer, offset});
      if (n->props.type != NodeType::INSTANCE) {
        self(self, c, containing, offset);
        continue;
      }
      Guid main = mainOf(c);
      if (main == kNoGuid || !ix.plays(main)) continue;
      motion::Assignment a = motion::decodeAssignment(n->props, main, containing);
      if (!a.disabled) self(self, c, main, offset + a.offsetUs);
    }
  };
  visit(visit, root, root, 0);
  for (const Layer& l : layers) {
    Guid id = l.row;
    const motion::AnimatedNode* an = ix.node(l.layer);
    const Node* n = doc_.get(id);
    if (!an || !n) continue;
    Vec2 size = n->props.size;
    Vec2 anchor = motion::MotionLayer::anchorPoint(an->base, size);
    w.beginObject();
    w.key("node").string(id.toString()).key("path").string(id.toString()).key("name").string(n->props.name);
    w.key("anchor").beginObject().key("x").number(size.x > 0 ? anchor.x / size.x * 100 : 50).key("y").number(size.y > 0 ? anchor.y / size.y * 100 : 50).endObject();
    w.key("size").beginObject().key("width").number(size.x).key("height").number(size.y).endObject();
    w.key("properties").beginArray();
    for (const motion::Binding& b : an->bindings) {
      const motion::FieldInfo* info = b.slot.kind == Slot::Kind::NODE ? motion::fieldInfo(b.slot.field) : nullptr;
      const char* kind = info ? (info->compose == motion::Compose::ADDITIVE ? "additive" : info->compose == motion::Compose::MULTIPLICATIVE ? "multiplicative" : "absolute") : "absolute";
      // Manual tracks in root time (an instance sublayer's moved by its instances' offsets); a preset's moved by its
      // clip's start too (round 8h), a disabled clip left out.
      for (const motion::Param& q : b.params) {
        const motion::Track* t = ix.track(q.track);
        if (!t || q.disabled) continue;
        int64_t shift = l.offsetUs + (q.kind == motion::Param::Kind::ANIMATION_PRESET ? q.offsetUs : 0);
        w.beginObject().key("field");
        writePublicField(w, b.slot);
        w.key("kind").string(kind).key("keyframes").beginArray();
        for (const motion::Keyframe& k : t->keyframes) {
          w.beginObject().key("timeUs").number(static_cast<double>(k.timeUs + shift)).key("value");
          writePublicValue(w, b.slot, k.value);
          w.key("easing");
          writePublicEasing(w, k.easing);
          w.endObject();
        }
        w.endArray().endObject();
      }
    }
    w.endArray().endObject();
  }
  w.endArray().endObject();
}

}  // namespace eng
