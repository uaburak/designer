#include "scene/Node.h"

#include <cmath>

namespace eng {

namespace {
constexpr double kTwoPi = 6.283185307179586;
}

std::string ImageHash::hex() const {
  static const char* digits = "0123456789abcdef";
  std::string out;
  if (!present) return out;
  out.reserve(40);
  for (uint8_t b : bytes) {
    out += digits[b >> 4];
    out += digits[b & 15];
  }
  return out;
}

ImageHash ImageHash::fromHex(std::string_view hex, bool* ok) {
  ImageHash h;
  auto nibble = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  bool good = hex.size() == 40;
  for (size_t i = 0; good && i < 20; i++) {
    int a = nibble(hex[2 * i]), b = nibble(hex[2 * i + 1]);
    if (a < 0 || b < 0) good = false;
    else h.bytes[i] = static_cast<uint8_t>(a * 16 + b);
  }
  h.present = good;
  if (!good) h.bytes = {};
  if (ok) *ok = good;
  return h;
}

bool ArcData::isFull() const {
  if (innerRadius > 0) return false;
  double sweep = endingAngle - startingAngle;
  return (startingAngle == 0 && endingAngle == 0) || std::fabs(std::fabs(sweep) - kTwoPi) < 1e-6 || std::fabs(sweep) > kTwoPi;
}

bool VectorData::operator==(const VectorData& o) const {
  if (present != o.present || !(normalizedSize == o.normalizedSize) || !(styleOverrideTable == o.styleOverrideTable)) return false;
  if (network == o.network) return true;
  if (!network || !o.network) return (!network || network->empty()) && (!o.network || o.network->empty());
  return *network == *o.network;
}

bool NodeProps::isPathShape() const {
  switch (type) {
    case NodeType::VECTOR:
    case NodeType::STAR:
    case NodeType::LINE:
    case NodeType::REGULAR_POLYGON:
    case NodeType::BOOLEAN_OPERATION: return true;
    case NodeType::ELLIPSE: return !arcData.isFull() || !dashPattern.empty();
    case NodeType::RECTANGLE:
    case NodeType::ROUNDED_RECTANGLE: return cornerSmoothing > 0 || !dashPattern.empty();
    default: return false;
  }
}

bool TextStyle::operator==(const TextStyle& o) const {
  return styleID == o.styleID && mask == o.mask && fontName == o.fontName && fontSize == o.fontSize && lineHeight == o.lineHeight &&
         letterSpacing == o.letterSpacing && textCase == o.textCase && textDecoration == o.textDecoration &&
         fillPaints == o.fillPaints && extra == o.extra;
}

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
  X(F_PROPORTIONS_CONSTRAINED, proportionsConstrained, 151) \
  X(F_TEXT_DATA, textData, 42)                               \
  X(F_FONT_NAME, fontName, 41)                               \
  X(F_FONT_SIZE, fontSize, 21)                               \
  X(F_LINE_HEIGHT, lineHeight, 40)                           \
  X(F_LETTER_SPACING, letterSpacing, 165)                    \
  X(F_PARAGRAPH_SPACING, paragraphSpacing, 23)               \
  X(F_PARAGRAPH_INDENT, paragraphIndent, 22)                 \
  X(F_TEXT_ALIGN_H, textAlignHorizontal, 32)                 \
  X(F_TEXT_ALIGN_V, textAlignVertical, 33)                   \
  X(F_TEXT_AUTO_RESIZE, textAutoResize, 46)                  \
  X(F_TEXT_TRUNCATION, textTruncation, 280)                  \
  X(F_MAX_LINES, maxLines, 351)                              \
  X(F_TEXT_CASE, textCase, 34)                               \
  X(F_TEXT_DECORATION, textDecoration, 35)                   \
  X(F_AUTO_RENAME, autoRename, 14)                          \
  X(F_BLEND_MODE, blendMode, 9)                              \
  X(F_MASK, mask, 16)                                        \
  X(F_MASK_TYPE, maskType, 317)                              \
  X(F_STROKE_CAP, strokeCap, 30)                             \
  X(F_STROKE_JOIN, strokeJoin, 31)                           \
  X(F_MITER_LIMIT, miterLimit, 25)                           \
  X(F_DASH_PATTERN, dashPattern, 13)                         \
  X(F_BORDER_WEIGHTS, borderWeights, 295)                    \
  X(F_BORDER_WEIGHTS, borderStrokeWeightsIndependent, 299)   \
  X(F_CORNER_SMOOTHING, cornerSmoothing, 160)                \
  X(F_EFFECTS, effects, 43)                                  \
  X(F_COUNT, count, 10)                                      \
  X(F_STAR_INNER_SCALE, starInnerScale, 24)                  \
  X(F_ARC_DATA, arcData, 195)                                \
  X(F_VECTOR_DATA, vectorData, 48)                           \
  X(F_HANDLE_MIRRORING, handleMirroring, 44)                 \
  X(F_BOOLEAN_OPERATION, booleanOperation, 36)               \
  X(F_LAYOUT_GRIDS, layoutGrids, 47)                         \
  X(F_EXTRA, extra, 0)

const char* nodeTypeName(NodeType t) {
  switch (t) {
    case NodeType::DOCUMENT: return "DOCUMENT";
    case NodeType::CANVAS: return "CANVAS";
    case NodeType::GROUP: return "GROUP";
    case NodeType::FRAME: return "FRAME";
    case NodeType::ELLIPSE: return "ELLIPSE";
    case NodeType::RECTANGLE: return "RECTANGLE";
    case NodeType::ROUNDED_RECTANGLE: return "ROUNDED_RECTANGLE";
    case NodeType::TEXT: return "TEXT";
    case NodeType::BOOLEAN_OPERATION: return "BOOLEAN_OPERATION";
    case NodeType::VECTOR: return "VECTOR";
    case NodeType::STAR: return "STAR";
    case NodeType::LINE: return "LINE";
    case NodeType::REGULAR_POLYGON: return "REGULAR_POLYGON";
    case NodeType::SLICE: return "SLICE";
    case NodeType::VARIABLE: return "VARIABLE";
    case NodeType::VARIABLE_SET: return "VARIABLE_SET";
    case NodeType::SYMBOL: return "SYMBOL";
    case NodeType::INSTANCE: return "INSTANCE";
    case NodeType::SECTION: return "SECTION";
    default: return "NONE";
  }
}

NodeType nodeTypeFromName(std::string_view s) {
  static constexpr NodeType kAll[] = {NodeType::DOCUMENT, NodeType::CANVAS, NodeType::GROUP, NodeType::FRAME,
                                      NodeType::ELLIPSE, NodeType::RECTANGLE, NodeType::ROUNDED_RECTANGLE,
                                      NodeType::TEXT, NodeType::SYMBOL, NodeType::INSTANCE, NodeType::SECTION,
                                      NodeType::BOOLEAN_OPERATION, NodeType::VECTOR, NodeType::STAR, NodeType::LINE,
                                      NodeType::REGULAR_POLYGON, NodeType::SLICE, NodeType::VARIABLE, NodeType::VARIABLE_SET};
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
  if (f == F_TYPE || f == F_PARENT_INDEX || f == F_EXTRA) return 0;
#define ENG_ID(bit, member, id) \
  if (f == bit) return id;
  ENG_NODE_FIELDS(ENG_ID)
#undef ENG_ID
  return 0;
}

FieldMask fieldsOfKiwiId(uint32_t id) {
  // The four rectangle*CornerRadius fields and rectangleCornerRadiiIndependent travel with cornerRadius.
  if (id >= 145 && id <= 149) return F_CORNER_RADII;
  // borderTop/Bottom/Left/RightWeight and borderStrokeWeightsIndependent travel together.
  if (id >= 295 && id <= 299) return F_BORDER_WEIGHTS;
  if (id == 0) return 0;
#define ENG_BIT(bit, member, kid) \
  if (id == kid) return bit;
  ENG_NODE_FIELDS(ENG_BIT)
#undef ENG_BIT
  return 0;
}

uint32_t fieldGroups(FieldMask m) {
  uint32_t g = 0;
  if (m & (F_TRANSFORM | F_SIZE | F_CORNER_RADII | F_TYPE | F_CORNER_SMOOTHING | F_COUNT | F_STAR_INNER_SCALE | F_ARC_DATA |
           F_VECTOR_DATA | F_HANDLE_MIRRORING | F_BOOLEAN_OPERATION))
    g |= G_GEOMETRY;
  if (m & (F_PARENT_INDEX | F_RESIZE_TO_FIT | kStackContainerFields | kStackChildFields | F_H_CONSTRAINT | F_V_CONSTRAINT |
           F_PROPORTIONS_CONSTRAINED | F_STACK_REVERSE_Z))
    g |= G_LAYOUT;
  if (m & (F_FILLS | F_STROKES | F_STROKE_WEIGHT | F_STROKE_ALIGN | F_OPACITY | F_FRAME_MASK_DISABLED | F_BACKGROUND_COLOR |
           F_BACKGROUND_ENABLED | F_BLEND_MODE | F_MASK | F_MASK_TYPE | F_STROKE_CAP | F_STROKE_JOIN | F_MITER_LIMIT |
           F_DASH_PATTERN | F_BORDER_WEIGHTS | F_EFFECTS | F_LAYOUT_GRIDS))
    g |= G_PAINT;
  if (m & (kTextLayoutFields | F_AUTO_RENAME)) g |= G_TEXT;
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
      p.fillPaints = {Paint::solid(Color::hex(0xFFFFFF))};
      break;
    case NodeType::RECTANGLE:
    case NodeType::ROUNDED_RECTANGLE:
    case NodeType::ELLIPSE:
      p.fillPaints = {Paint::solid(Color::hex(0xD9D9D9))};
      break;
    case NodeType::REGULAR_POLYGON:
      p.fillPaints = {Paint::solid(Color::hex(0xD9D9D9))};
      p.count = 3;
      break;
    case NodeType::STAR:
      p.fillPaints = {Paint::solid(Color::hex(0xD9D9D9))};
      p.count = 5;
      p.starInnerScale = 0.382;
      break;
    case NodeType::LINE:
    case NodeType::VECTOR:
      // Lines and pen paths: a black 1 px centre stroke, no fill.
      p.strokePaints = {Paint::solid(Color::hex(0x000000))};
      p.strokeAlign = StrokeAlign::CENTER;
      break;
    case NodeType::TEXT:
      // Figma's new text: Inter Regular 12, Auto line height, 0% letter spacing, black, an outside stroke weight of 1.
      p.fillPaints = {Paint::solid(Color::hex(0x000000))};
      p.strokeAlign = StrokeAlign::OUTSIDE;
      p.textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
      p.autoRename = true;
      break;
    default: break;
  }
  return p;
}

}  // namespace eng
