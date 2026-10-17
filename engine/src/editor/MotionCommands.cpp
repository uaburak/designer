// Figma Motion's editing commands and reads (docs/motion.md §4.2, §4.9, §10; round 8b, increment 1): keyframes added,
// moved, re-valued, eased and deleted on KEYFRAME_TRACK nodes bound through KEYFRAME expressions; the root's timeline;
// the anchor; the motion path's handles; the layer bar's retime; the timeline model, the right panel's diamonds and the
// resolved model as JSON; panel writes routed into keyframes while Motion is on; tracks removed with their last layer.
//
// Not yet (the contract's later increments): presets and styles (336–339, 352; round 8h's code), audio (345–348), paste
// (349), combine / split (350–351), instance offsets (341), text stagger (344), keyframe values or easings bound to
// variables, the anchor's keep-in-place compensation, gestures routed into keyframes (a move → TRANSLATION_XY), and the
// deep copy of tracks on duplicate / paste / detach.
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

bool guidOf(const json::Value* v, Guid& out) {
  if (!v || !v->isString()) return false;
  bool ok = false;
  out = Guid::parse(v->string, &ok);
  return ok;
}

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
    case Slot::Kind::NODE: {
      c.mask = F_PARAM_MAP;
      c.props.parameterConsumptionMap = n->props.parameterConsumptionMap;
      auto& map = c.props.parameterConsumptionMap;
      map.erase(std::remove_if(map.begin(), map.end(), [&](const ParamBinding& b) { return b.field == s.field; }), map.end());
      if (data.present()) {
        ParamBinding b;
        b.field = s.field;
        b.data = data;
        map.push_back(std::move(b));
      }
      break;
    }
    case Slot::Kind::FILL_COLOR:
    case Slot::Kind::FILL_OPACITY:
    case Slot::Kind::STROKE_COLOR:
    case Slot::Kind::STROKE_OPACITY: {
      bool fill = s.kind == Slot::Kind::FILL_COLOR || s.kind == Slot::Kind::FILL_OPACITY;
      c.mask = fill ? F_FILLS : F_STROKES;
      std::vector<Paint>& list = fill ? c.props.fillPaints : c.props.strokePaints;
      list = fill ? n->props.fillPaints : n->props.strokePaints;
      if (s.index >= list.size()) return;
      if (s.kind == Slot::Kind::FILL_COLOR || s.kind == Slot::Kind::STROKE_COLOR) list[s.index].colorVar = data;
      else list[s.index].opacityVar = data;
      break;
    }
    case Slot::Kind::EFFECT: {
      c.mask = F_EFFECTS;
      c.props.effects = n->props.effects;
      if (s.index >= c.props.effects.size()) return;
      Effect& e = c.props.effects[s.index];
      switch (s.effect) {
        case Slot::EffectField::RADIUS: e.radiusVar = data; break;
        case Slot::EffectField::COLOR: e.colorVar = data; break;
        case Slot::EffectField::SPREAD: e.spreadVar = data; break;
        case Slot::EffectField::OFFSET_X: e.xVar = data; break;
        case Slot::EffectField::OFFSET_Y: e.yVar = data; break;
      }
      break;
    }
  }
  write(c);
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

// The slot's manual track, made when there is none: a KEYFRAME_TRACK on the internal canvas, bound through the slot's
// KEYFRAME expression (the existing expression gains a MANUAL parameter; a plain or alias-bound slot becomes the
// expression's base argument). A transaction is open.
Guid Editor::motionEnsureTrack(Guid id, const motion::Slot& s, Guid root) {
  const Node* n = doc_.get(id);
  if (!n) return kNoGuid;
  if (Guid t = motionTrackOf(n->props, s); t != kNoGuid) return t;
  Guid internal = internalCanvas();
  if (internal == kNoGuid) return kNoGuid;
  const VariableData* existing = motionSlotData(n->props, s);
  VariableData base;
  std::vector<motion::Param> params;
  if (existing && isKeyframeExpression(*existing)) {
    base = existing->args[0];
    if (existing->args.size() >= 2) motion::decodeParams(existing->args[1], params);
  } else if (existing && existing->present()) {
    base = *existing;  // an alias (or another expression): kept as the base argument (docs/motion.md §4.2)
  } else {
    KeyframeValue v;
    if (!motionBaseValue(n->props, s, v)) return kNoGuid;
    base = v.kind == ValueKind::COLOR ? VariableData::color(v.c) : v.kind == ValueKind::VECTOR ? VariableData::number(v.v.x) : VariableData::number(v.f);
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
  }
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
  if (easing) {
    json::Value ed;
    EasingSpec spec;
    if (easingFromPublic(*easing, ed, &spec)) {
      putExtra(c, "easingData", encodeExtra("easingData", ed));
      putExtra(c, "interpolationType", encodeExtra("interpolationType", jstr(interpolationTypeOf(spec.type))));
    }
  }
  write(c);
  motionDirty_ = true;
  return id;
}

// Removes a track with its keyframes and its MANUAL parameter from every slot that names it (children first).
void Editor::motionRemoveTrack(Guid track) {
  if (!doc_.has(track)) return;
  std::vector<std::pair<Guid, Slot>> users;
  doc_.forEach([&](const Node& n) {
    if (n.guid.isDerived()) return;
    auto check = [&](const VariableData& d, Slot s) {
      if (!isKeyframeExpression(d) || d.args.size() < 2) return;
      std::vector<motion::Param> params;
      motion::decodeParams(d.args[1], params);
      for (const motion::Param& q : params)
        if (q.track == track) users.push_back({n.guid, s});
    };
    for (const ParamBinding& b : n.props.parameterConsumptionMap)
      if (b.isVariable()) {
        Slot s;
        s.kind = Slot::Kind::NODE;
        s.field = b.field;
        check(b.data, s);
      }
    auto paints = [&](const std::vector<Paint>& list, Slot::Kind colorKind, Slot::Kind opacityKind) {
      for (size_t i = 0; i < list.size(); i++) {
        Slot s;
        s.index = static_cast<uint32_t>(i);
        s.kind = colorKind;
        if (list[i].colorVar.present()) check(list[i].colorVar, s);
        s.kind = opacityKind;
        if (list[i].opacityVar.present()) check(list[i].opacityVar, s);
      }
    };
    paints(n.props.fillPaints, Slot::Kind::FILL_COLOR, Slot::Kind::FILL_OPACITY);
    paints(n.props.strokePaints, Slot::Kind::STROKE_COLOR, Slot::Kind::STROKE_OPACITY);
    for (size_t i = 0; i < n.props.effects.size(); i++) {
      const Effect& e = n.props.effects[i];
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
          check(*q.box, s);
        }
    }
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

// The tracks only the given nodes (and their descendants) bind: removed with them (docs/motion.md §4.2 ownership).
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
    case CommandId::MOTION_DELETE_TRACKS: return motion_.on && !selection_.empty() ? CMD_ENABLED : 0;
    case CommandId::MOTION_SET_KEYFRAMES:
    case CommandId::MOTION_DELETE_KEYFRAMES:
    case CommandId::MOTION_SET_EASING:
    case CommandId::MOTION_SET_TIMELINE:
    case CommandId::MOTION_SET_PATH_HANDLES: return motion_.on ? CMD_ENABLED : 0;
    default: return 0;  // presets, audio, paste, combine / split, instance offsets, text stagger: later increments
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
        if (const json::Value* es = member(e, "easing")) {
          json::Value ed;
          EasingSpec spec;
          if (easingFromPublic(*es, ed, &spec)) {
            putExtra(c, "easingData", encodeExtra("easingData", ed));
            putExtra(c, "interpolationType", encodeExtra("interpolationType", jstr(interpolationTypeOf(spec.type))));
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
        if (c.mask) {
          write(c);
          done++;
        }
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
      if (!easingFromPublic(*easing, ed, &spec)) return E_INVALID;
      begin(TxnKind::USER, "Change easing");
      size_t done = 0;
      for (const json::Value& v : ids->array) {
        Guid g;
        if (!guidOf(&v, g) || !doc_.has(g)) continue;
        NodeType t = doc_.get(g)->props.type;
        if (t != NodeType::KEYFRAME && t != NodeType::ANIMATION_PRESET_INSTANCE) continue;
        NodeChange c = NodeChange::changed(g);
        putExtra(c, "easingData", encodeExtra("easingData", ed));
        if (t == NodeType::KEYFRAME) putExtra(c, "interpolationType", encodeExtra("interpolationType", jstr(interpolationTypeOf(spec.type))));
        write(c);
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
      if (tracks.empty()) return E_INVALID;
      begin(TxnKind::USER, delta ? "Move animation" : "Change animation duration");
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
    default: return E_UNSUPPORTED;  // the later increments (docs/motion.md §4.9's table)
  }
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
// fields taken; the caller writes the rest as in Design.
FieldMask Editor::motionRouteWrite(Guid id, const NodeChange& props) {
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
  if (writes.empty()) return 0;
  for (auto& [s, v] : writes) {
    const motion::FieldInfo* info = motion::fieldInfo(s.field);
    if (!info) continue;
    // With auto-keyframe on and no track yet, the first keyframe at t = 0 keeps the value as it was (docs/motion.md §4.9).
    bool had = motionTrackOf(n->props, s) != kNoGuid;
    Guid track = motionEnsureTrack(id, s, root);
    if (track == kNoGuid) continue;
    if (!had && motion_.timeUs > 0) {
      KeyframeValue was;
      if (motionBaseValue(n->props, s, was)) motionUpsertKeyframe(track, 0, was, nullptr);
    }
    motionUpsertKeyframe(track, motion_.timeUs, KeyframeValue::number(motion::nodeToStored(*info, v)), nullptr);
  }
  return taken;
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
  // The Layers panel's order: top first (the last child first), depth from the root.
  std::vector<std::pair<Guid, int>> order;
  auto visit = [&](auto&& self, Guid id, int depth) -> void {
    const std::vector<Guid>& kids = doc_.children(id);
    for (size_t i = kids.size(); i-- > 0;) {
      Guid c = kids[i];
      if (c.isDerived()) continue;
      if (ix.animated(c)) order.push_back({c, depth});
      self(self, c, depth + 1);
    }
  };
  visit(visit, root, 1);
  for (auto& [id, depth] : order) {
    const motion::AnimatedNode* an = ix.node(id);
    const Node* n = doc_.get(id);
    if (!an || !n) continue;
    int64_t start = INT64_MAX, end = INT64_MIN;
    w.beginObject();
    w.key("node").string(id.toString()).key("name").string(n->props.name).key("icon").string(nodeTypeName(n->props.type)).key("depth").number(depth);
    w.key("tracks").beginArray();
    for (const motion::Binding& b : an->bindings) {
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
          if (k.hasPathHandles)
            w.key("pathHandles").beginObject().key("in").beginObject().key("x").number(k.pathIn.x).key("y").number(k.pathIn.y).endObject().key("out").beginObject().key("x").number(k.pathOut.x).key("y").number(k.pathOut.y).endObject().endObject();
          w.endObject();
        }
        w.endArray().endObject();
      }
    }
    w.endArray();
    w.key("clips").beginArray().endArray();  // presets: round 8h
    w.key("startUs").number(start == INT64_MAX ? 0 : static_cast<double>(start)).key("endUs").number(end == INT64_MIN ? 0 : static_cast<double>(end));
    w.endObject();
  }
  w.endArray();
  w.key("audioTracks").beginArray().endArray();  // audio: a later increment (docs/motion.md §4.11)
  w.key("audio").beginArray().endArray();
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
          if (!t) continue;
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
  std::vector<Guid> layers = node == root ? ix.animatedUnder(doc_, root) : std::vector<Guid>{node};
  if (node != root && !ix.animated(node)) layers.clear();
  for (Guid id : layers) {
    const motion::AnimatedNode* an = ix.node(id);
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
      // Manual tracks as they are, in root time (instance offsets: a later increment).
      for (const motion::Param& q : b.params) {
        const motion::Track* t = ix.track(q.track);
        if (!t) continue;
        w.beginObject().key("field");
        writePublicField(w, b.slot);
        w.key("kind").string(kind).key("keyframes").beginArray();
        for (const motion::Keyframe& k : t->keyframes) {
          w.beginObject().key("timeUs").number(static_cast<double>(k.timeUs)).key("value");
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
