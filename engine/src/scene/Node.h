// A node of the scene graph and a change to one (Figma's NodeChange): the
// node's id plus only the fields it touches. Field names and enum values are
// schema/document.kiwi's (Figma's), so the wire encoding moves to kiwi without
// renaming anything. Interim: a fixed struct of the fields the engine uses so
// far, with a 64-bit mask of touched fields; docs/engine.md §2.2's NodeTable +
// facets replace it.
#pragma once

#include <array>
#include <map>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/Guid.h"
#include "math/Math.h"

namespace eng {

// schema/document.kiwi's NodeType values. DesignerV2 writes rectangles as
// ROUNDED_RECTANGLE and groups as FRAME + resizeToFit (as Figma's files do);
// RECTANGLE and GROUP are read on import and treated the same. SYMBOL
// (component), INSTANCE and SECTION are frame-like containers here; an
// instance's sublayers come with E6. Types the engine doesn't draw yet
// (VECTOR, BOOLEAN_OPERATION, STAR, …) keep their type and their fields
// (NodeProps::extra) so they round-trip.
enum class NodeType : uint8_t {
  NONE = 0,
  DOCUMENT = 1,
  CANVAS = 2,
  GROUP = 3,
  FRAME = 4,
  BOOLEAN_OPERATION = 5,
  VECTOR = 6,
  STAR = 7,
  LINE = 8,
  ELLIPSE = 9,
  RECTANGLE = 10,
  REGULAR_POLYGON = 11,
  ROUNDED_RECTANGLE = 12,
  TEXT = 13,
  SLICE = 14,
  SYMBOL = 15,
  INSTANCE = 16,
  SECTION = 25,
  VARIABLE = 28,
  VARIABLE_SET = 31,
};

enum class StrokeAlign : uint8_t { CENTER = 0, INSIDE = 1, OUTSIDE = 2 };
// SOLID is drawn; any other paint (gradients, images: E5) is kept as it came (Paint::raw).
enum class PaintType : uint8_t { SOLID = 0, OTHER = 255 };

// Auto layout (schema/document.kiwi StackMode … StackCounterAlignContent).
enum class StackMode : uint8_t { NONE = 0, HORIZONTAL = 1, VERTICAL = 2, GRID = 3 };
enum class StackAlign : uint8_t { MIN = 0, CENTER = 1, MAX = 2, BASELINE = 3 };  // counter axis, the container's
enum class StackCounterAlign : uint8_t { MIN = 0, CENTER = 1, MAX = 2, STRETCH = 3, AUTO = 4, BASELINE = 5 };  // a child's own
enum class StackJustify : uint8_t { MIN = 0, CENTER = 1, MAX = 2, SPACE_EVENLY = 3, SPACE_BETWEEN = 4, SPACE_AROUND = 5, SPACE_EVENLY_CSS = 6 };
enum class StackSize : uint8_t { FIXED = 0, RESIZE_TO_FIT = 1, RESIZE_TO_FIT_WITH_IMPLICIT_SIZE = 2 };
enum class StackPositioning : uint8_t { AUTO = 0, ABSOLUTE = 1 };
enum class StackWrap : uint8_t { NO_WRAP = 0, WRAP = 1 };
enum class StackCounterAlignContent : uint8_t { AUTO = 0, SPACE_BETWEEN = 1 };
enum class ConstraintType : uint8_t { MIN = 0, CENTER = 1, MAX = 2, STRETCH = 3, SCALE = 4, FIXED_MIN = 5, FIXED_MAX = 6 };

// Text (schema/document.kiwi's Text section).
enum class NumberUnits : uint8_t { RAW = 0, PIXELS = 1, PERCENT = 2 };
enum class TextAlignHorizontal : uint8_t { LEFT = 0, CENTER = 1, RIGHT = 2, JUSTIFIED = 3 };
enum class TextAlignVertical : uint8_t { TOP = 0, CENTER = 1, BOTTOM = 2 };
enum class TextAutoResize : uint8_t { NONE = 0, WIDTH_AND_HEIGHT = 1, HEIGHT = 2 };
enum class TextTruncation : uint8_t { DISABLED = 0, ENDING = 1 };
enum class TextCase : uint8_t { ORIGINAL = 0, UPPER = 1, LOWER = 2, TITLE = 3, SMALL_CAPS = 4, SMALL_CAPS_FORCED = 5 };
enum class TextDecoration : uint8_t { NONE = 0, UNDERLINE = 1, STRIKETHROUGH = 2 };

const char* nodeTypeName(NodeType t);
NodeType nodeTypeFromName(std::string_view s);

// Enum ⇄ schema name, for every enum above (index = value; "" = unused).
template <typename E>
struct EnumNames;
template <typename E>
const char* enumName(E value) {
  auto i = static_cast<size_t>(value);
  return i < EnumNames<E>::count ? EnumNames<E>::names[i] : "";
}
template <typename E>
bool enumFromName(std::string_view s, E& out) {
  for (size_t i = 0; i < EnumNames<E>::count; i++)
    if (EnumNames<E>::names[i][0] && s == EnumNames<E>::names[i]) {
      out = static_cast<E>(i);
      return true;
    }
  return false;
}
#define ENG_ENUM_NAMES(E, ...)                                  \
  template <>                                                   \
  struct EnumNames<E> {                                         \
    static constexpr const char* names[] = {__VA_ARGS__};       \
    static constexpr size_t count = sizeof(names) / sizeof(names[0]); \
  };
ENG_ENUM_NAMES(StrokeAlign, "CENTER", "INSIDE", "OUTSIDE")
ENG_ENUM_NAMES(StackMode, "NONE", "HORIZONTAL", "VERTICAL", "GRID")
ENG_ENUM_NAMES(StackAlign, "MIN", "CENTER", "MAX", "BASELINE")
ENG_ENUM_NAMES(StackCounterAlign, "MIN", "CENTER", "MAX", "STRETCH", "AUTO", "BASELINE")
ENG_ENUM_NAMES(StackJustify, "MIN", "CENTER", "MAX", "SPACE_EVENLY", "SPACE_BETWEEN", "SPACE_AROUND", "SPACE_EVENLY_CSS")
ENG_ENUM_NAMES(StackSize, "FIXED", "RESIZE_TO_FIT", "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE")
ENG_ENUM_NAMES(StackPositioning, "AUTO", "ABSOLUTE")
ENG_ENUM_NAMES(StackWrap, "NO_WRAP", "WRAP")
ENG_ENUM_NAMES(StackCounterAlignContent, "AUTO", "SPACE_BETWEEN")
ENG_ENUM_NAMES(ConstraintType, "MIN", "CENTER", "MAX", "STRETCH", "SCALE", "FIXED_MIN", "FIXED_MAX")
ENG_ENUM_NAMES(NumberUnits, "RAW", "PIXELS", "PERCENT")
ENG_ENUM_NAMES(TextAlignHorizontal, "LEFT", "CENTER", "RIGHT", "JUSTIFIED")
ENG_ENUM_NAMES(TextAlignVertical, "TOP", "CENTER", "BOTTOM")
ENG_ENUM_NAMES(TextAutoResize, "NONE", "WIDTH_AND_HEIGHT", "HEIGHT")
ENG_ENUM_NAMES(TextTruncation, "DISABLED", "ENDING")
ENG_ENUM_NAMES(TextCase, "ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED")
ENG_ENUM_NAMES(TextDecoration, "NONE", "UNDERLINE", "STRIKETHROUGH")
#undef ENG_ENUM_NAMES

inline const char* strokeAlignName(StrokeAlign a) { return enumName(a); }
inline StrokeAlign strokeAlignFromName(std::string_view s) {
  StrokeAlign a = StrokeAlign::CENTER;
  enumFromName(s, a);
  return a;
}

struct Color {
  float r = 0, g = 0, b = 0, a = 1;
  bool operator==(const Color& o) const { return r == o.r && g == o.g && b == o.b && a == o.a; }
  // 0xRRGGBB, alpha 1.
  static Color hex(uint32_t rgb, float alpha = 1) {
    return {((rgb >> 16) & 0xff) / 255.f, ((rgb >> 8) & 0xff) / 255.f, (rgb & 0xff) / 255.f, alpha};
  }
};

struct Paint {
  PaintType type = PaintType::SOLID;
  Color color;
  float opacity = 1;
  bool visible = true;
  std::string raw;  // OTHER: the paint, encoded
  bool operator==(const Paint& o) const {
    return type == o.type && color == o.color && opacity == o.opacity && visible == o.visible && raw == o.raw;
  }
};

// schema Number: lineHeight {100, PERCENT} = Auto (the font's own line height),
// {k, RAW} = k × font size (the UI's "140%"), {v, PIXELS}; letterSpacing in
// PERCENT of the font size or PIXELS.
struct Number {
  double value = 0;
  NumberUnits units = NumberUnits::RAW;
  bool operator==(const Number& o) const { return value == o.value && units == o.units; }
};

struct FontName {
  std::string family, style, postscript;
  bool operator==(const FontName& o) const { return family == o.family && style == o.style && postscript == o.postscript; }
};

// A run style of TextData.styleOverrideTable (a sparse NodeChange keyed by
// styleID ≥ 1): the run fields the engine uses, in `mask`, and every other
// field of the entry kept as encoded JSON members ("key":value,…) so they
// survive edits.
enum TextRunField : uint32_t {
  R_FONT_NAME = 1,
  R_FONT_SIZE = 2,
  R_LINE_HEIGHT = 4,
  R_LETTER_SPACING = 8,
  R_TEXT_CASE = 16,
  R_TEXT_DECORATION = 32,
  R_FILLS = 64,
};
struct TextStyle {
  uint32_t styleID = 0;
  uint32_t mask = 0;
  FontName fontName;
  double fontSize = 12;
  Number lineHeight{100, NumberUnits::PERCENT};
  Number letterSpacing{0, NumberUnits::PERCENT};
  TextCase textCase = TextCase::ORIGINAL;
  TextDecoration textDecoration = TextDecoration::NONE;
  std::vector<Paint> fillPaints;
  std::string extra;  // other members, already encoded
  bool operator==(const TextStyle& o) const;
};

// A TEXT node's source (one property; edits replace it whole). Offsets are
// UTF-16 code units, as Figma's characterStyleIDs.
struct TextData {
  std::string characters;                    // UTF-8; paragraphs split by "\n", U+2028 a line break inside one
  std::vector<uint32_t> characterStyleIDs;   // per UTF-16 unit; a missing tail = 0 (the node's own style)
  std::vector<TextStyle> styleOverrideTable;
  std::vector<std::string> lines;            // TextLineData per paragraph, kept as encoded JSON (lists come with E3.2)
  bool operator==(const TextData& o) const {
    return characters == o.characters && characterStyleIDs == o.characterStyleIDs && styleOverrideTable == o.styleOverrideTable &&
           lines == o.lines;
  }
};

struct ParentIndex {
  Guid guid = kNoGuid;
  std::string position;
  bool operator==(const ParentIndex& o) const { return guid == o.guid && position == o.position; }
};

// One bit per property. A change carries only the bits it touches.
using FieldMask = uint64_t;
enum Field : FieldMask {
  F_TYPE = 1ull << 0,
  F_NAME = 1ull << 1,
  F_VISIBLE = 1ull << 2,
  F_LOCKED = 1ull << 3,
  F_OPACITY = 1ull << 4,
  F_TRANSFORM = 1ull << 5,
  F_SIZE = 1ull << 6,
  F_FILLS = 1ull << 7,
  F_STROKES = 1ull << 8,
  F_STROKE_WEIGHT = 1ull << 9,
  F_STROKE_ALIGN = 1ull << 10,
  F_CORNER_RADII = 1ull << 11,
  F_FRAME_MASK_DISABLED = 1ull << 12,
  F_PARENT_INDEX = 1ull << 13,
  F_RESIZE_TO_FIT = 1ull << 14,
  F_BACKGROUND_COLOR = 1ull << 15,
  F_BACKGROUND_ENABLED = 1ull << 16,
  F_INTERNAL_ONLY = 1ull << 17,
  // Auto layout, container.
  F_STACK_MODE = 1ull << 18,
  F_STACK_SPACING = 1ull << 19,
  F_STACK_PADDING_LEFT = 1ull << 20,    // stackHorizontalPadding
  F_STACK_PADDING_TOP = 1ull << 21,     // stackVerticalPadding
  F_STACK_PADDING_RIGHT = 1ull << 22,   // stackPaddingRight
  F_STACK_PADDING_BOTTOM = 1ull << 23,  // stackPaddingBottom
  F_STACK_PRIMARY_SIZING = 1ull << 24,
  F_STACK_COUNTER_SIZING = 1ull << 25,
  F_STACK_PRIMARY_ALIGN = 1ull << 26,         // stackPrimaryAlignItems
  F_STACK_COUNTER_ALIGN = 1ull << 27,         // stackCounterAlignItems
  F_STACK_COUNTER_ALIGN_CONTENT = 1ull << 28,  // stackCounterAlignContent
  F_STACK_WRAP = 1ull << 29,
  F_STACK_COUNTER_SPACING = 1ull << 30,
  F_STACK_REVERSE_Z = 1ull << 31,  // stackReverseZIndex
  F_BORDERS_TAKE_SPACE = 1ull << 32,
  // Auto layout, child.
  F_STACK_CHILD_GROW = 1ull << 33,        // stackChildPrimaryGrow
  F_STACK_CHILD_ALIGN_SELF = 1ull << 34,  // stackChildAlignSelf
  F_STACK_POSITIONING = 1ull << 35,
  F_MIN_SIZE = 1ull << 36,
  F_MAX_SIZE = 1ull << 37,
  // Constraints.
  F_H_CONSTRAINT = 1ull << 38,  // horizontalConstraint
  F_V_CONSTRAINT = 1ull << 39,  // verticalConstraint
  F_PROPORTIONS_CONSTRAINED = 1ull << 40,
  // Text.
  F_TEXT_DATA = 1ull << 41,
  F_FONT_NAME = 1ull << 42,
  F_FONT_SIZE = 1ull << 43,
  F_LINE_HEIGHT = 1ull << 44,
  F_LETTER_SPACING = 1ull << 45,
  F_PARAGRAPH_SPACING = 1ull << 46,
  F_PARAGRAPH_INDENT = 1ull << 47,
  F_TEXT_ALIGN_H = 1ull << 48,  // textAlignHorizontal
  F_TEXT_ALIGN_V = 1ull << 49,  // textAlignVertical
  F_TEXT_AUTO_RESIZE = 1ull << 50,
  F_TEXT_TRUNCATION = 1ull << 51,
  F_MAX_LINES = 1ull << 52,
  F_TEXT_CASE = 1ull << 53,
  F_TEXT_DECORATION = 1ull << 54,
  F_AUTO_RENAME = 1ull << 55,
  // Every NodeChange field the engine doesn't model, kept as encoded JSON.
  F_EXTRA = 1ull << 56,
  F_ALL = (1ull << 57) - 1,
};

// Fields that feed auto layout (a write marks the layout dirty).
inline constexpr FieldMask kStackContainerFields = F_STACK_MODE | F_STACK_SPACING | F_STACK_PADDING_LEFT | F_STACK_PADDING_TOP |
                                                   F_STACK_PADDING_RIGHT | F_STACK_PADDING_BOTTOM | F_STACK_PRIMARY_SIZING |
                                                   F_STACK_COUNTER_SIZING | F_STACK_PRIMARY_ALIGN | F_STACK_COUNTER_ALIGN |
                                                   F_STACK_COUNTER_ALIGN_CONTENT | F_STACK_WRAP | F_STACK_COUNTER_SPACING |
                                                   F_BORDERS_TAKE_SPACE;
inline constexpr FieldMask kStackChildFields = F_STACK_CHILD_GROW | F_STACK_CHILD_ALIGN_SELF | F_STACK_POSITIONING | F_MIN_SIZE | F_MAX_SIZE;
// Fields that change a text node's layout (glyphs, lines, its auto-resized size).
inline constexpr FieldMask kTextLayoutFields = F_TEXT_DATA | F_FONT_NAME | F_FONT_SIZE | F_LINE_HEIGHT | F_LETTER_SPACING |
                                               F_PARAGRAPH_SPACING | F_PARAGRAPH_INDENT | F_TEXT_ALIGN_H | F_TEXT_ALIGN_V |
                                               F_TEXT_AUTO_RESIZE | F_TEXT_TRUNCATION | F_MAX_LINES | F_TEXT_CASE |
                                               F_TEXT_DECORATION;

// The kiwi field id (schema/document.kiwi NodeChange) of each Field bit, for
// clearedFields; 0 for fields that can't be cleared (type, parentIndex).
uint32_t kiwiFieldId(Field f);
// The Field bits a kiwi field id stands for (0 when the engine doesn't keep it).
FieldMask fieldsOfKiwiId(uint32_t id);

// The field groups of NODES_CHANGED (docs/engine.md §10.4).
enum FieldGroup : uint32_t {
  G_GEOMETRY = 1,
  G_LAYOUT = 2,
  G_PAINT = 4,
  G_TEXT = 8,
  G_NAME = 16,
  G_VISIBILITY = 32,
  G_COMPONENT = 64,
  G_BINDINGS = 128,
};
uint32_t fieldGroups(FieldMask fieldMask);

// Corner order: top-left, top-right, bottom-right, bottom-left (Figma's
// rectangleTopLeftCornerRadius … rectangleBottomLeftCornerRadius).
using CornerRadii = std::array<double, 4>;

// Every field's default is what its absence means in schema/document.kiwi
// (docs/schema.md §3.4): kiwi zero values, except visible = true, opacity = 1,
// transform = identity, stackPrimarySizing = Hug, stackChildAlignSelf = AUTO.
// Tools write Figma's per-tool defaults explicitly (defaultProps).
struct NodeProps {
  NodeType type = NodeType::NONE;
  std::string name;
  bool visible = true;
  bool locked = false;
  double opacity = 1;
  Mat2x3 transform;  // node space → parent space
  Vec2 size;
  std::vector<Paint> fillPaints;
  std::vector<Paint> strokePaints;
  double strokeWeight = 0;
  StrokeAlign strokeAlign = StrokeAlign::CENTER;
  CornerRadii cornerRadii{0, 0, 0, 0};
  bool frameMaskDisabled = false;  // a frame clips its content unless this is set
  bool resizeToFit = false;        // a FRAME that is a group
  Color backgroundColor{0, 0, 0, 0};  // CANVAS: the page colour
  bool backgroundEnabled = false;     // CANVAS
  bool internalOnly = false;          // CANVAS: the hidden Internal Only Canvas
  ParentIndex parentIndex;

  // Auto layout, as a container.
  StackMode stackMode = StackMode::NONE;
  double stackSpacing = 0;
  double stackPaddingLeft = 0, stackPaddingTop = 0, stackPaddingRight = 0, stackPaddingBottom = 0;
  StackSize stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;  // absent = Hug (Figma's files)
  StackSize stackCounterSizing = StackSize::FIXED;
  StackJustify stackPrimaryAlignItems = StackJustify::MIN;
  StackAlign stackCounterAlignItems = StackAlign::MIN;
  StackCounterAlignContent stackCounterAlignContent = StackCounterAlignContent::AUTO;
  StackWrap stackWrap = StackWrap::NO_WRAP;
  // Absent = the same as stackSpacing (what Figma's own layout does: stacks_wrap.fig).
  std::optional<double> stackCounterSpacing;
  bool stackReverseZIndex = false;
  bool bordersTakeSpace = false;
  // Auto layout, as a child.
  double stackChildPrimaryGrow = 0;
  StackCounterAlign stackChildAlignSelf = StackCounterAlign::AUTO;
  StackPositioning stackPositioning = StackPositioning::AUTO;
  Vec2 minSize, maxSize;  // an axis value of 0 = no limit
  // Constraints.
  ConstraintType horizontalConstraint = ConstraintType::MIN;
  ConstraintType verticalConstraint = ConstraintType::MIN;
  bool proportionsConstrained = false;
  // Text (TEXT nodes; absent = the schema's @default: Inter Regular 12, Auto line height, 0% letter spacing).
  TextData textData;
  FontName fontName{"Inter", "Regular", ""};
  double fontSize = 12;
  Number lineHeight{100, NumberUnits::PERCENT};
  Number letterSpacing{0, NumberUnits::PERCENT};
  double paragraphSpacing = 0;
  double paragraphIndent = 0;
  TextAlignHorizontal textAlignHorizontal = TextAlignHorizontal::LEFT;
  TextAlignVertical textAlignVertical = TextAlignVertical::TOP;
  TextAutoResize textAutoResize = TextAutoResize::NONE;
  TextTruncation textTruncation = TextTruncation::DISABLED;
  int32_t maxLines = 0;  // with ENDING truncation; 0 = no limit
  TextCase textCase = TextCase::ORIGINAL;
  TextDecoration textDecoration = TextDecoration::NONE;
  bool autoRename = false;
  // The fields the engine doesn't model (vectorData, blendMode, effects…): name →
  // encoded JSON value. A CHANGED change's `extra` merges into the node's (an
  // empty value removes that field); CREATED replaces it.
  std::map<std::string, std::string> extra;

  bool isGroupLike() const { return type == NodeType::GROUP || (type == NodeType::FRAME && resizeToFit); }
  bool isFrameLike() const {
    return (type == NodeType::FRAME && !resizeToFit) || type == NodeType::SYMBOL || type == NodeType::INSTANCE ||
           type == NodeType::SECTION;
  }
  // Can hold children (pages and the document hold theirs too).
  bool isContainer() const { return isFrameLike() || isGroupLike() || type == NodeType::CANVAS || type == NodeType::DOCUMENT; }
  bool isRectLike() const { return type == NodeType::ROUNDED_RECTANGLE || type == NodeType::RECTANGLE; }
  bool clipsContent() const { return isFrameLike() && !frameMaskDisabled; }
  bool isAutoLayout() const {
    return isFrameLike() && (stackMode == StackMode::HORIZONTAL || stackMode == StackMode::VERTICAL);
  }
  bool hugsPrimary() const { return stackPrimarySizing != StackSize::FIXED; }
  bool hugsCounter() const { return stackCounterSizing != StackSize::FIXED; }
  // Whether this node is laid out by its auto-layout parent (absolute ones aren't).
  bool inFlow() const { return visible && stackPositioning != StackPositioning::ABSOLUTE; }
};

// Copies the fields in `mask` from `from` to `to`.
void copyFields(NodeProps& to, const NodeProps& from, FieldMask mask);
// The fields in `mask` where a and b differ.
FieldMask differingFields(const NodeProps& a, const NodeProps& b, FieldMask mask = F_ALL);

struct Node {
  Guid guid;
  NodeProps props;
};

enum class Phase : uint8_t {
  CHANGED,  // kiwi: no phase
  CREATED,
  REMOVED,
};

struct NodeChange {
  Guid guid;
  Phase phase = Phase::CHANGED;
  FieldMask mask = 0;  // which of `props` this change carries (CREATED: all; REMOVED: none)
  NodeProps props;

  static NodeChange created(Guid g, const NodeProps& p) { return {g, Phase::CREATED, F_ALL, p}; }
  static NodeChange removed(Guid g) { return {g, Phase::REMOVED, 0, {}}; }
  static NodeChange changed(Guid g) { return {g, Phase::CHANGED, 0, {}}; }
};

// Figma's defaults for a newly drawn node of `type`.
NodeProps defaultProps(NodeType type);

}  // namespace eng
