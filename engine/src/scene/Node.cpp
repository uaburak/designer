#include "scene/Node.h"

namespace eng {

// Every field: its bit, its member, its kiwi field id (schema/document.kiwi NodeChange).
#define ENG_NODE_FIELDS(X)                                   \
  X(F_TYPE, type, 4)                                         \
  X(F_NAME, name, 5)                                         \
  X(F_VISIBLE, visible, 6)                                   \
  X(F_LOCKED, locked, 7)                                     \
  X(F_OPACITY, opacity, 8)                                   \
  X(F_TRANSFORM, transform, 12)                              \
  X(F_SIZE, size, 11)                                        \
  X(F_FILLS, fillPaints, 38)                                 \
  X(F_STROKES, strokePaints, 39)                             \
  X(F_STROKE_WEIGHT, strokeWeight, 26)                       \
  X(F_STROKE_ALIGN, strokeAlign, 29)                         \
  X(F_CORNER_RADII, cornerRadii, 20)                         \
  X(F_FRAME_MASK_DISABLED, frameMaskDisabled, 115)           \
  X(F_PARENT_INDEX, parentIndex, 3)                          \
  X(F_RESIZE_TO_FIT, resizeToFit, 117)                       \
  X(F_BACKGROUND_COLOR, backgroundColor, 50)                 \
  X(F_BACKGROUND_ENABLED, backgroundEnabled, 15)             \
  X(F_INTERNAL_ONLY, internalOnly, 142)                      \
  X(F_STACK_MODE, stackMode, 105)                            \
  X(F_STACK_SPACING, stackSpacing, 107)                      \
  X(F_STACK_PADDING_LEFT, stackPaddingLeft, 209)             \
  X(F_STACK_PADDING_TOP, stackPaddingTop, 210)               \
  X(F_STACK_PADDING_RIGHT, stackPaddingRight, 233)           \
  X(F_STACK_PADDING_BOTTOM, stackPaddingBottom, 234)         \
  X(F_STACK_PRIMARY_SIZING, stackPrimarySizing, 229)         \
  X(F_STACK_COUNTER_SIZING, stackCounterSizing, 221)         \
  X(F_STACK_PRIMARY_ALIGN, stackPrimaryAlignItems, 230)      \
  X(F_STACK_COUNTER_ALIGN, stackCounterAlignItems, 231)      \
  X(F_STACK_COUNTER_ALIGN_CONTENT, stackCounterAlignContent, 343) \
  X(F_STACK_WRAP, stackWrap, 323)                            \
  X(F_STACK_COUNTER_SPACING, stackCounterSpacing, 324)       \
  X(F_STACK_REVERSE_Z, stackReverseZIndex, 271)              \
  X(F_BORDERS_TAKE_SPACE, bordersTakeSpace, 294)             \
  X(F_STACK_CHILD_GROW, stackChildPrimaryGrow, 232)          \
  X(F_STACK_CHILD_ALIGN_SELF, stackChildAlignSelf, 236)      \
  X(F_STACK_POSITIONING, stackPositioning, 269)              \
  X(F_MIN_SIZE, minSize, 325)                                \
  X(F_MAX_SIZE, maxSize, 326)                                \
  X(F_H_CONSTRAINT, horizontalConstraint, 28)                \
  X(F_V_CONSTRAINT, verticalConstraint, 37)                  \
  X(F_PROPORTIONS_CONSTRAINED, proportionsConstrained, 151)

const char* nodeTypeName(NodeType t) {
  switch (t) {
    case NodeType::DOCUMENT: return "DOCUMENT";
    case NodeType::CANVAS: return "CANVAS";
    case NodeType::GROUP: return "GROUP";
    case NodeType::FRAME: return "FRAME";
    case NodeType::ELLIPSE: return "ELLIPSE";
    case NodeType::RECTANGLE: return "RECTANGLE";
    case NodeType::ROUNDED_RECTANGLE: return "ROUNDED_RECTANGLE";
    case NodeType::SYMBOL: return "SYMBOL";
    case NodeType::INSTANCE: return "INSTANCE";
    case NodeType::SECTION: return "SECTION";
    default: return "NONE";
  }
}

NodeType nodeTypeFromName(std::string_view s) {
  static constexpr NodeType kAll[] = {NodeType::DOCUMENT, NodeType::CANVAS, NodeType::GROUP, NodeType::FRAME,
                                      NodeType::ELLIPSE, NodeType::RECTANGLE, NodeType::ROUNDED_RECTANGLE,
                                      NodeType::SYMBOL, NodeType::INSTANCE, NodeType::SECTION};
  for (NodeType t : kAll)
    if (s == nodeTypeName(t)) return t;
  return NodeType::NONE;
}

void copyFields(NodeProps& to, const NodeProps& from, FieldMask mask) {
#define ENG_COPY(bit, member, id) \
  if (mask & bit) to.member = from.member;
  ENG_NODE_FIELDS(ENG_COPY)
#undef ENG_COPY
}

FieldMask differingFields(const NodeProps& a, const NodeProps& b, FieldMask mask) {
  FieldMask d = 0;
#define ENG_DIFF(bit, member, id) \
  if ((mask & bit) && !(a.member == b.member)) d |= bit;
  ENG_NODE_FIELDS(ENG_DIFF)
#undef ENG_DIFF
  return d;
}

uint32_t kiwiFieldId(Field f) {
  if (f == F_TYPE || f == F_PARENT_INDEX) return 0;
#define ENG_ID(bit, member, id) \
  if (f == bit) return id;
  ENG_NODE_FIELDS(ENG_ID)
#undef ENG_ID
  return 0;
}

FieldMask fieldsOfKiwiId(uint32_t id) {
  // The four rectangle*CornerRadius fields and rectangleCornerRadiiIndependent travel with cornerRadius.
  if (id >= 145 && id <= 149) return F_CORNER_RADII;
#define ENG_BIT(bit, member, kid) \
  if (id == kid) return bit;
  ENG_NODE_FIELDS(ENG_BIT)
#undef ENG_BIT
  return 0;
}

uint32_t fieldGroups(FieldMask m) {
  uint32_t g = 0;
  if (m & (F_TRANSFORM | F_SIZE | F_CORNER_RADII | F_TYPE)) g |= G_GEOMETRY;
  if (m & (F_PARENT_INDEX | F_RESIZE_TO_FIT | kStackContainerFields | kStackChildFields | F_H_CONSTRAINT | F_V_CONSTRAINT |
           F_PROPORTIONS_CONSTRAINED | F_STACK_REVERSE_Z))
    g |= G_LAYOUT;
  if (m & (F_FILLS | F_STROKES | F_STROKE_WEIGHT | F_STROKE_ALIGN | F_OPACITY | F_FRAME_MASK_DISABLED | F_BACKGROUND_COLOR |
           F_BACKGROUND_ENABLED))
    g |= G_PAINT;
  if (m & F_NAME) g |= G_NAME;
  if (m & (F_VISIBLE | F_LOCKED | F_INTERNAL_ONLY)) g |= G_VISIBILITY;
  return g;
}

NodeProps defaultProps(NodeType type) {
  NodeProps p;
  p.type = type;
  // What Figma writes for a newly drawn shape: a 1 px inside stroke weight (no stroke paint yet) and its fill.
  p.strokeWeight = 1;
  p.strokeAlign = StrokeAlign::INSIDE;
  switch (type) {
    case NodeType::FRAME:
      p.fillPaints = {Paint{PaintType::SOLID, Color::hex(0xFFFFFF), 1, true}};
      break;
    case NodeType::RECTANGLE:
    case NodeType::ROUNDED_RECTANGLE:
    case NodeType::ELLIPSE:
      p.fillPaints = {Paint{PaintType::SOLID, Color::hex(0xD9D9D9), 1, true}};
      break;
    default: break;
  }
  return p;
}

}  // namespace eng
