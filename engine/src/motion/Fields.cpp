#include "motion/Fields.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "base/Json.h"
#include "geometry/NodeGeometry.h"
#include "scene/CodecKiwi.h"

namespace eng::motion {

namespace {

constexpr double kPi = 3.14159265358979323846;

// docs/motion.md §4.5, in the table's order; the clamps are Figma's write clamps (§4.5 "Clamps on write").
constexpr FieldInfo kFields[] = {
    {VariableField::OPACITY, "OPACITY", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::X100, false, true, 0, 1},
    {VariableField::CORNER_RADIUS, "CORNER_RADIUS", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, false, true, 0, 1e9},
    {VariableField::RECTANGLE_TOP_LEFT_CORNER_RADIUS, "RECTANGLE_TOP_LEFT_CORNER_RADIUS", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, false, true, 0, 1e9},
    {VariableField::RECTANGLE_TOP_RIGHT_CORNER_RADIUS, "RECTANGLE_TOP_RIGHT_CORNER_RADIUS", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, false, true, 0, 1e9},
    {VariableField::RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS, "RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, false, true, 0, 1e9},
    {VariableField::RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS, "RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, false, true, 0, 1e9},
    {VariableField::STROKE_WEIGHT, "STROKE_WEIGHT", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, false, true, 0, 1e9},
    {VariableField::BORDER_TOP_WEIGHT, "BORDER_TOP_WEIGHT", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, false, true, 0, 1e9},
    {VariableField::BORDER_BOTTOM_WEIGHT, "BORDER_BOTTOM_WEIGHT", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, false, true, 0, 1e9},
    {VariableField::BORDER_LEFT_WEIGHT, "BORDER_LEFT_WEIGHT", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, false, true, 0, 1e9},
    {VariableField::BORDER_RIGHT_WEIGHT, "BORDER_RIGHT_WEIGHT", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, false, true, 0, 1e9},
    {VariableField::STACK_SPACING, "STACK_SPACING", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, true, false, 0, 0},
    {VariableField::STACK_COUNTER_SPACING, "STACK_COUNTER_SPACING", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, true, true, 0, 1e9},
    {VariableField::STACK_PADDING_LEFT, "STACK_PADDING_LEFT", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, true, true, 0, 1e9},
    {VariableField::STACK_PADDING_TOP, "STACK_PADDING_TOP", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, true, true, 0, 1e9},
    {VariableField::STACK_PADDING_RIGHT, "STACK_PADDING_RIGHT", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, true, true, 0, 1e9},
    {VariableField::STACK_PADDING_BOTTOM, "STACK_PADDING_BOTTOM", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, true, true, 0, 1e9},
    {VariableField::GRID_ROW_GAP, "GRID_ROW_GAP", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, true, true, 0, 1e9},
    {VariableField::GRID_COLUMN_GAP, "GRID_COLUMN_GAP", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, true, true, 0, 1e9},
    {VariableField::WIDTH, "WIDTH", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, true, true, 0.01, 1e9},
    {VariableField::HEIGHT, "HEIGHT", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, true, true, 0.01, 1e9},
    {VariableField::MOTION_TRANSLATION_X, "TRANSLATION_X", ValueKind::FLOAT, Compose::ADDITIVE, StoredUnit::AS_IS, false, false, 0, 0},
    {VariableField::MOTION_TRANSLATION_Y, "TRANSLATION_Y", ValueKind::FLOAT, Compose::ADDITIVE, StoredUnit::AS_IS, false, false, 0, 0},
    {VariableField::MOTION_TRANSLATION_XY, "TRANSLATION_XY", ValueKind::VECTOR, Compose::ADDITIVE, StoredUnit::AS_IS, false, false, 0, 0},
    {VariableField::MOTION_ROTATION, "ROTATION", ValueKind::FLOAT, Compose::ADDITIVE, StoredUnit::NEG_RADIANS, false, false, 0, 0},
    {VariableField::MOTION_SCALE_X, "SCALE_X", ValueKind::FLOAT, Compose::MULTIPLICATIVE, StoredUnit::AS_IS, false, false, 0, 0},
    {VariableField::MOTION_SCALE_Y, "SCALE_Y", ValueKind::FLOAT, Compose::MULTIPLICATIVE, StoredUnit::AS_IS, false, false, 0, 0},
    {VariableField::MOTION_SCALE_XY, "SCALE_XY", ValueKind::VECTOR, Compose::MULTIPLICATIVE, StoredUnit::AS_IS, false, false, 0, 0},
    {VariableField::PATH_TRIM_START, "PATH_TRIM_START", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, false, true, 0, 1},
    {VariableField::PATH_TRIM_END, "PATH_TRIM_END", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, false, true, 0, 1},
    // Not public: evaluated when a file has them (§4.5).
    {VariableField::MOTION_SHEAR, "", ValueKind::FLOAT, Compose::ADDITIVE, StoredUnit::AS_IS, false, false, 0, 0},
    {VariableField::MOTION_TRANSFORM_ORIGIN_X, "", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, false, false, 0, 0},
    {VariableField::MOTION_TRANSFORM_ORIGIN_Y, "", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, false, false, 0, 0},
    {VariableField::MOTION_TRANSFORM_ORIGIN_XY, "", ValueKind::VECTOR, Compose::ABSOLUTE, StoredUnit::AS_IS, false, false, 0, 0},
    {VariableField::ARC_DATA_STARTING_ANGLE, "", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, false, false, 0, 0},
    {VariableField::ARC_DATA_ENDING_ANGLE, "", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, false, false, 0, 0},
    {VariableField::ARC_DATA_INNER_RADIUS, "", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, false, true, 0, 1},
    {VariableField::STAR_INNER_SCALE, "", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, false, true, 0, 1},
    {VariableField::POLYGON_COUNT, "", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, false, true, 3, 60},
    {VariableField::TEXT_ELEMENT_DELAY, "", ValueKind::FLOAT, Compose::ABSOLUTE, StoredUnit::AS_IS, false, true, 0, 1e9},
};

double extraFloat(const NodeProps& p, const char* key, double fallback) {
  auto it = p.extra.find(key);
  if (it == p.extra.end() || it->second.empty()) return fallback;
  json::Value v;
  if (!json::parse(codec::extraValueToJson("NodeChange", it->second), v)) return fallback;
  return v.numberOr(fallback);
}

void setExtraFloat(NodeProps& p, const char* key, double v) {
  json::Value jv;
  jv.kind = json::Value::Kind::Number;
  jv.number = v;
  p.extra[key] = codec::extraFromJson("NodeChange", key, jv);
}

}  // namespace

const FieldInfo* fieldInfo(VariableField f) {
  for (const FieldInfo& i : kFields)
    if (i.field == f) return &i;
  return nullptr;
}

const FieldInfo* fieldByPublicName(const char* name) {
  if (!name || !*name) return nullptr;
  for (const FieldInfo& i : kFields)
    if (i.publicName[0] && std::strcmp(i.publicName, name) == 0) return &i;
  // Wecra's agents (docs/research/motion-for-agents.md §3b): the fields evaluated but not in Figma's public list (skew,
  // arcs, star, polygon …) by their schema names — the name the timeline model already reports them by.
  for (const FieldInfo& i : kFields)
    if (!i.publicName[0] && std::strcmp(enumName(i.field), name) == 0) return &i;
  return nullptr;
}

double storedToNode(const FieldInfo& f, double stored) {
  switch (f.stored) {
    case StoredUnit::X100: return stored / 100;
    case StoredUnit::NEG_RADIANS: return -stored * 180 / kPi;
    default: return stored;
  }
}

double nodeToStored(const FieldInfo& f, double node) {
  switch (f.stored) {
    case StoredUnit::X100: return node * 100;
    case StoredUnit::NEG_RADIANS: return -node * kPi / 180;
    default: return node;
  }
}

double clampWrite(const FieldInfo& f, double v) {
  if (!std::isfinite(v)) return f.hasClamp ? f.clampLo : 0;
  return f.hasClamp ? std::clamp(v, f.clampLo, f.clampHi) : v;
}

bool isMotionTransformField(VariableField f) {
  switch (f) {
    case VariableField::MOTION_TRANSLATION_X:
    case VariableField::MOTION_TRANSLATION_Y:
    case VariableField::MOTION_TRANSLATION_XY:
    case VariableField::MOTION_ROTATION:
    case VariableField::MOTION_SCALE_X:
    case VariableField::MOTION_SCALE_Y:
    case VariableField::MOTION_SCALE_XY:
    case VariableField::MOTION_SHEAR:
    case VariableField::MOTION_TRANSFORM_ORIGIN_X:
    case VariableField::MOTION_TRANSFORM_ORIGIN_Y:
    case VariableField::MOTION_TRANSFORM_ORIGIN_XY: return true;
    default: return false;
  }
}

bool writeNodeFloat(NodeProps& p, VariableField f, double v) {
  const FieldInfo* info = fieldInfo(f);
  if (!info || isMotionTransformField(f)) return false;
  v = clampWrite(*info, v);
  switch (f) {
    case VariableField::OPACITY: p.opacity = v; return true;
    case VariableField::CORNER_RADIUS: p.cornerRadii = {v, v, v, v}; return true;
    case VariableField::RECTANGLE_TOP_LEFT_CORNER_RADIUS: p.cornerRadii[0] = v; return true;
    case VariableField::RECTANGLE_TOP_RIGHT_CORNER_RADIUS: p.cornerRadii[1] = v; return true;
    case VariableField::RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: p.cornerRadii[2] = v; return true;
    case VariableField::RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: p.cornerRadii[3] = v; return true;
    case VariableField::STROKE_WEIGHT: p.strokeWeight = v; return true;
    case VariableField::BORDER_TOP_WEIGHT: p.stroke().borderWeights[0] = v; return true;
    case VariableField::BORDER_RIGHT_WEIGHT: p.stroke().borderWeights[1] = v; return true;
    case VariableField::BORDER_BOTTOM_WEIGHT: p.stroke().borderWeights[2] = v; return true;
    case VariableField::BORDER_LEFT_WEIGHT: p.stroke().borderWeights[3] = v; return true;
    case VariableField::STACK_SPACING: p.stack().stackSpacing = v; return true;
    case VariableField::STACK_COUNTER_SPACING: p.stack().stackCounterSpacing = v; return true;
    case VariableField::STACK_PADDING_LEFT: p.stack().stackPaddingLeft = v; return true;
    case VariableField::STACK_PADDING_TOP: p.stack().stackPaddingTop = v; return true;
    case VariableField::STACK_PADDING_RIGHT: p.stack().stackPaddingRight = v; return true;
    case VariableField::STACK_PADDING_BOTTOM: p.stack().stackPaddingBottom = v; return true;
    case VariableField::GRID_ROW_GAP: setExtraFloat(p, "gridRowGap", v); return true;
    case VariableField::GRID_COLUMN_GAP: setExtraFloat(p, "gridColumnGap", v); return true;
    case VariableField::WIDTH: p.size.x = v; return true;
    case VariableField::HEIGHT: p.size.y = v; return true;
    case VariableField::PATH_TRIM_START:
    case VariableField::PATH_TRIM_END: {
      // pathTrim (OptionalVector {value {x start, y end}}; absent = 0 / 1), kept in `extra` (docs/motion.md §4.13).
      double start = 0, end = 1;
      pathTrimOf(p, start, end);
      if (f == VariableField::PATH_TRIM_START) start = v;
      else end = v;
      json::Value out;
      out.kind = json::Value::Kind::Object;
      json::Value vec;
      vec.kind = json::Value::Kind::Object;
      json::Value jx, jy;
      jx.kind = jy.kind = json::Value::Kind::Number;
      jx.number = start;
      jy.number = end;
      vec.object.emplace_back("x", jx);
      vec.object.emplace_back("y", jy);
      out.object.emplace_back("value", vec);
      p.extra["pathTrim"] = codec::extraFromJson("NodeChange", "pathTrim", out);
      return true;
    }
    case VariableField::ARC_DATA_STARTING_ANGLE: p.shape().arcData.startingAngle = v; return true;
    case VariableField::ARC_DATA_ENDING_ANGLE: p.shape().arcData.endingAngle = v; return true;
    case VariableField::ARC_DATA_INNER_RADIUS: p.shape().arcData.innerRadius = v; return true;
    case VariableField::STAR_INNER_SCALE: p.shape().starInnerScale = v; return true;
    case VariableField::POLYGON_COUNT: p.shape().count = static_cast<uint32_t>(std::lround(v)); return true;
    default: return false;
  }
}

bool readNodeFloat(const NodeProps& p, VariableField f, double& out) {
  switch (f) {
    case VariableField::OPACITY: out = p.opacity; return true;
    case VariableField::CORNER_RADIUS: out = p.cornerRadii[0]; return true;
    case VariableField::RECTANGLE_TOP_LEFT_CORNER_RADIUS: out = p.cornerRadii[0]; return true;
    case VariableField::RECTANGLE_TOP_RIGHT_CORNER_RADIUS: out = p.cornerRadii[1]; return true;
    case VariableField::RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: out = p.cornerRadii[2]; return true;
    case VariableField::RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: out = p.cornerRadii[3]; return true;
    case VariableField::STROKE_WEIGHT: out = p.strokeWeight; return true;
    case VariableField::BORDER_TOP_WEIGHT: out = p.stroke().borderWeights[0]; return true;
    case VariableField::BORDER_RIGHT_WEIGHT: out = p.stroke().borderWeights[1]; return true;
    case VariableField::BORDER_BOTTOM_WEIGHT: out = p.stroke().borderWeights[2]; return true;
    case VariableField::BORDER_LEFT_WEIGHT: out = p.stroke().borderWeights[3]; return true;
    case VariableField::STACK_SPACING: out = p.stack().stackSpacing; return true;
    case VariableField::STACK_COUNTER_SPACING: out = p.stack().stackCounterSpacing.value_or(p.stack().stackSpacing); return true;
    case VariableField::STACK_PADDING_LEFT: out = p.stack().stackPaddingLeft; return true;
    case VariableField::STACK_PADDING_TOP: out = p.stack().stackPaddingTop; return true;
    case VariableField::STACK_PADDING_RIGHT: out = p.stack().stackPaddingRight; return true;
    case VariableField::STACK_PADDING_BOTTOM: out = p.stack().stackPaddingBottom; return true;
    case VariableField::GRID_ROW_GAP: out = extraFloat(p, "gridRowGap", 0); return true;
    case VariableField::GRID_COLUMN_GAP: out = extraFloat(p, "gridColumnGap", 0); return true;
    case VariableField::WIDTH: out = p.size.x; return true;
    case VariableField::HEIGHT: out = p.size.y; return true;
    case VariableField::ARC_DATA_STARTING_ANGLE: out = p.shape().arcData.startingAngle; return true;
    case VariableField::ARC_DATA_ENDING_ANGLE: out = p.shape().arcData.endingAngle; return true;
    case VariableField::ARC_DATA_INNER_RADIUS: out = p.shape().arcData.innerRadius; return true;
    case VariableField::STAR_INNER_SCALE: out = p.shape().starInnerScale; return true;
    case VariableField::POLYGON_COUNT: out = p.shape().count; return true;
    case VariableField::PATH_TRIM_START:
    case VariableField::PATH_TRIM_END: {
      double start = 0, end = 1;  // absent: the whole path
      pathTrimOf(p, start, end);
      out = f == VariableField::PATH_TRIM_START ? start : end;
      return true;
    }
    default: return false;
  }
}

}  // namespace eng::motion
