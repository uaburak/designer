// Figma Motion's keyframable fields (docs/motion.md §4.5): one table — the `VariableField` a KEYFRAME expression binds,
// its value type, how a track's value composes with the base (absolute / additive / multiplicative), whether a change
// re-lays out the node, Figma's stored unit (opacity ×100, rotation −radians) and its write clamp. The TypeScript twin is
// `KEYFRAME_FIELDS` in src/shared/motion/types.ts (a test compares the two).
#pragma once

#include <cstdint>

#include "scene/Node.h"

namespace eng::motion {

enum class ValueKind : uint8_t { FLOAT, VECTOR, COLOR, BOOL, TEXT, OTHER };
enum class Compose : uint8_t { ABSOLUTE, ADDITIVE, MULTIPLICATIVE };
// Figma's stored units (docs/research/rea/motion.md §2.12): the keyframe's number as it sits in the file.
enum class StoredUnit : uint8_t { AS_IS, X100, NEG_RADIANS };

struct FieldInfo {
  VariableField field;
  const char* publicName;  // the plugin API's KeyframePropertyFieldName ("" when not public: evaluated only)
  ValueKind value;
  Compose compose;
  StoredUnit stored;
  bool layout;          // changes layout: the motion layer re-lays out the node (round 8a: noted, not run)
  bool hasClamp;
  double clampLo, clampHi;  // in node units
};

// The field's row, or nullptr when the field is not keyframable (X_POSITION, the 3D fields…: round trip only).
const FieldInfo* fieldInfo(VariableField f);
// The row by its public name ("OPACITY", "TRANSLATION_XY"…); nullptr when unknown.
const FieldInfo* fieldByPublicName(const char* name);

// Stored → node units and back, by the field's unit (OPACITY 50 ↔ 0.5; ROTATION −π/2 ↔ 90°).
double storedToNode(const FieldInfo& f, double stored);
double nodeToStored(const FieldInfo& f, double node);
// The clamp applied on write (node units); a field without one returns `v`.
double clampWrite(const FieldInfo& f, double v);

// The motion transform's components (MOTION_TRANSLATION_X … MOTION_SHEAR, the XY pairs and the transform origin).
bool isMotionTransformField(VariableField f);
// A FLOAT field written into the node (node units; the field's clamp applied). False for fields this round doesn't
// write (the motion transform's: MotionLayer composes them; the arc / polygon / star fields; TEXT_ELEMENT_DELAY).
bool writeNodeFloat(NodeProps& p, VariableField f, double v);
// The node's current (base) value of a FLOAT field, false when the field isn't one of the node's.
bool readNodeFloat(const NodeProps& p, VariableField f, double& out);

}  // namespace eng::motion
