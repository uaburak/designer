// A node of the scene graph and a change to one (Figma's NodeChange): the
// node's id plus only the fields it touches. Field names and enum values are
// schema/document.kiwi's (Figma's), so the wire encoding moves to kiwi without
// renaming anything. Interim: a fixed struct of the fields the engine uses so
// far, with a 64-bit mask of touched fields; docs/engine.md §2.2's NodeTable +
// facets replace it.
#pragma once

#include <array>
#include <memory>
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
// schema/document.kiwi's PaintType; OTHER: a paint type the schema doesn't know, kept as it came (Paint::extra).
enum class PaintType : uint8_t {
  SOLID = 0, GRADIENT_LINEAR = 1, GRADIENT_RADIAL = 2, GRADIENT_ANGULAR = 3, GRADIENT_DIAMOND = 4, IMAGE = 5, OTHER = 255
};
enum class BlendMode : uint8_t {
  PASS_THROUGH = 0, NORMAL, DARKEN, MULTIPLY, LINEAR_BURN, COLOR_BURN, LIGHTEN, SCREEN, LINEAR_DODGE, COLOR_DODGE,
  OVERLAY, SOFT_LIGHT, HARD_LIGHT, DIFFERENCE, EXCLUSION, HUE, SATURATION, COLOR, LUMINOSITY
};
enum class ImageScaleMode : uint8_t { STRETCH = 0, FIT = 1, FILL = 2, TILE = 3 };  // STRETCH = "Crop" in the UI
enum class StrokeCap : uint8_t {
  NONE = 0, ROUND = 1, SQUARE = 2, ARROW_LINES = 3, ARROW_EQUILATERAL = 4, DIAMOND_FILLED = 5, TRIANGLE_FILLED = 6,
  CIRCLE_FILLED = 14
};
enum class StrokeJoin : uint8_t { MITER = 0, BEVEL = 1, ROUND = 2 };
enum class MaskType : uint8_t { ALPHA = 0, OUTLINE = 1, LUMINANCE = 2 };  // OUTLINE = Figma's "Vector" mask
enum class EffectType : uint8_t {
  INNER_SHADOW = 0, DROP_SHADOW = 1, FOREGROUND_BLUR = 2, BACKGROUND_BLUR = 3, GRAIN = 6, NOISE = 7, GLASS = 8
};
enum class VectorMirror : uint8_t { NONE = 0, ANGLE = 1, ANGLE_AND_LENGTH = 2 };
enum class BooleanOperation : uint8_t { UNION = 0, INTERSECT = 1, SUBTRACT = 2, XOR = 3 };
enum class WindingRule : uint8_t { NONZERO = 0, ODD = 1 };
enum class LayoutGridType : uint8_t { MIN = 0, CENTER = 1, STRETCH = 2, MAX = 3 };
enum class LayoutGridPattern : uint8_t { STRIPES = 0, GRID = 1 };
enum class Axis : uint8_t { X = 0, Y = 1 };

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

// Components (docs/schema.md §5.5).
enum class ComponentPropType : uint8_t { BOOL = 0, TEXT = 1, INSTANCE_SWAP = 3, VARIANT = 4, SLOT = 7 };
// schema VariableField: which node field a parameterConsumptionMap entry binds.
enum class VariableField : uint8_t {
  MISSING = 0, CORNER_RADIUS = 1, PARAGRAPH_SPACING = 2, PARAGRAPH_INDENT = 3, STROKE_WEIGHT = 4, STACK_SPACING = 5,
  STACK_PADDING_LEFT = 6, STACK_PADDING_TOP = 7, STACK_PADDING_RIGHT = 8, STACK_PADDING_BOTTOM = 9, VISIBLE = 10, TEXT_DATA = 11,
  WIDTH = 12, HEIGHT = 13, RECTANGLE_TOP_LEFT_CORNER_RADIUS = 14, RECTANGLE_TOP_RIGHT_CORNER_RADIUS = 15,
  RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS = 16, RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS = 17, BORDER_TOP_WEIGHT = 18,
  BORDER_BOTTOM_WEIGHT = 19, BORDER_LEFT_WEIGHT = 20, BORDER_RIGHT_WEIGHT = 21, VARIANT_PROPERTIES = 22, STACK_COUNTER_SPACING = 23,
  MIN_WIDTH = 24, MAX_WIDTH = 25, MIN_HEIGHT = 26, MAX_HEIGHT = 27, FONT_FAMILY = 28, FONT_STYLE = 29, FONT_VARIATIONS = 30,
  OPACITY = 31, FONT_SIZE = 32, LETTER_SPACING = 34, LINE_HEIGHT = 36, OVERRIDDEN_SYMBOL_ID = 37, HYPERLINK = 38,
  SLOT_CONTENT_ID = 40, GRID_ROW_GAP = 41, GRID_COLUMN_GAP = 42
};

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
ENG_ENUM_NAMES(BlendMode, "PASS_THROUGH", "NORMAL", "DARKEN", "MULTIPLY", "LINEAR_BURN", "COLOR_BURN", "LIGHTEN", "SCREEN",
               "LINEAR_DODGE", "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE",
               "SATURATION", "COLOR", "LUMINOSITY")
ENG_ENUM_NAMES(ImageScaleMode, "STRETCH", "FIT", "FILL", "TILE")
ENG_ENUM_NAMES(StrokeCap, "NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL", "DIAMOND_FILLED", "TRIANGLE_FILLED",
               "", "", "", "", "", "", "", "CIRCLE_FILLED")
ENG_ENUM_NAMES(StrokeJoin, "MITER", "BEVEL", "ROUND")
ENG_ENUM_NAMES(MaskType, "ALPHA", "OUTLINE", "LUMINANCE")
ENG_ENUM_NAMES(EffectType, "INNER_SHADOW", "DROP_SHADOW", "FOREGROUND_BLUR", "BACKGROUND_BLUR", "", "", "GRAIN", "NOISE", "GLASS")
ENG_ENUM_NAMES(VectorMirror, "NONE", "ANGLE", "ANGLE_AND_LENGTH")
ENG_ENUM_NAMES(BooleanOperation, "UNION", "INTERSECT", "SUBTRACT", "XOR")
ENG_ENUM_NAMES(WindingRule, "NONZERO", "ODD")
ENG_ENUM_NAMES(LayoutGridType, "MIN", "CENTER", "STRETCH", "MAX")
ENG_ENUM_NAMES(LayoutGridPattern, "STRIPES", "GRID")
ENG_ENUM_NAMES(Axis, "X", "Y")
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
ENG_ENUM_NAMES(ComponentPropType, "BOOL", "TEXT", "", "INSTANCE_SWAP", "VARIANT", "", "", "SLOT")
ENG_ENUM_NAMES(VariableField, "MISSING", "CORNER_RADIUS", "PARAGRAPH_SPACING", "PARAGRAPH_INDENT", "STROKE_WEIGHT", "STACK_SPACING",
               "STACK_PADDING_LEFT", "STACK_PADDING_TOP", "STACK_PADDING_RIGHT", "STACK_PADDING_BOTTOM", "VISIBLE", "TEXT_DATA",
               "WIDTH", "HEIGHT", "RECTANGLE_TOP_LEFT_CORNER_RADIUS", "RECTANGLE_TOP_RIGHT_CORNER_RADIUS",
               "RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS", "RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS", "BORDER_TOP_WEIGHT",
               "BORDER_BOTTOM_WEIGHT", "BORDER_LEFT_WEIGHT", "BORDER_RIGHT_WEIGHT", "VARIANT_PROPERTIES", "STACK_COUNTER_SPACING",
               "MIN_WIDTH", "MAX_WIDTH", "MIN_HEIGHT", "MAX_HEIGHT", "FONT_FAMILY", "FONT_STYLE", "FONT_VARIATIONS", "OPACITY",
               "FONT_SIZE", "", "LETTER_SPACING", "", "LINE_HEIGHT", "OVERRIDDEN_SYMBOL_ID", "HYPERLINK", "", "SLOT_CONTENT_ID",
               "GRID_ROW_GAP", "GRID_COLUMN_GAP")
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

struct ColorStop {
  Color color;
  double position = 0;
  bool operator==(const ColorStop& o) const { return color == o.color && position == o.position; }
};

// Image adjustments (schema PaintFilterMessage), each −1…1, 0 = unchanged.
struct PaintFilter {
  float tint = 0, shadows = 0, highlights = 0, detail = 0, exposure = 0, vignette = 0, temperature = 0, vibrance = 0,
        contrast = 0, brightness = 0;
  bool operator==(const PaintFilter& o) const {
    return tint == o.tint && shadows == o.shadows && highlights == o.highlights && detail == o.detail && exposure == o.exposure &&
           vignette == o.vignette && temperature == o.temperature && vibrance == o.vibrance && contrast == o.contrast &&
           brightness == o.brightness;
  }
  bool any() const { return !(*this == PaintFilter{}); }
};

// An image's id: the SHA-1 of its file's bytes (schema Image.hash).
struct ImageHash {
  std::array<uint8_t, 20> bytes{};
  bool present = false;
  bool operator==(const ImageHash& o) const { return present == o.present && bytes == o.bytes; }
  std::string hex() const;
  static ImageHash fromHex(std::string_view hex, bool* ok = nullptr);
};

// A fill or stroke (schema Paint). The fields the renderer uses are typed; every
// other member (colorVar, stopsVar, imageThumbnail, thumbHash, …) is kept
// encoded in `extra` ("key":value,…) so it round-trips.
struct Paint {
  PaintType type = PaintType::SOLID;
  Color color;
  float opacity = 1;
  bool visible = true;
  BlendMode blendMode = BlendMode::NORMAL;
  std::vector<ColorStop> stops;
  Mat2x3 transform;  // gradients and images: the node's unit square → paint space
  ImageHash image;
  std::string imageName;
  ImageScaleMode imageScaleMode = ImageScaleMode::STRETCH;
  float rotation = 0;  // images, degrees
  float scale = 1;     // TILE
  PaintFilter paintFilter;
  uint32_t originalImageWidth = 0, originalImageHeight = 0;
  std::string extra;  // other members, encoded; OTHER: the whole paint, encoded
  bool operator==(const Paint& o) const {
    return type == o.type && color == o.color && opacity == o.opacity && visible == o.visible && blendMode == o.blendMode &&
           stops == o.stops && transform == o.transform && image == o.image && imageName == o.imageName &&
           imageScaleMode == o.imageScaleMode && rotation == o.rotation && scale == o.scale && paintFilter == o.paintFilter &&
           originalImageWidth == o.originalImageWidth && originalImageHeight == o.originalImageHeight && extra == o.extra;
  }
  bool isGradient() const { return type >= PaintType::GRADIENT_LINEAR && type <= PaintType::GRADIENT_DIAMOND; }
  static Paint solid(Color c, float opacity = 1) {
    Paint p;
    p.color = c;
    p.opacity = opacity;
    return p;
  }
};

// schema Effect: the fields drawn are typed, the rest kept encoded.
struct Effect {
  EffectType type = EffectType::INNER_SHADOW;
  Color color{0, 0, 0, 0.25f};
  Vec2 offset;
  double radius = 0;
  bool visible = true;
  BlendMode blendMode = BlendMode::NORMAL;
  double spread = 0;
  bool showShadowBehindNode = false;
  std::string extra;
  bool operator==(const Effect& o) const {
    return type == o.type && color == o.color && offset == o.offset && radius == o.radius && visible == o.visible &&
           blendMode == o.blendMode && spread == o.spread && showShadowBehindNode == o.showShadowBehindNode && extra == o.extra;
  }
  bool isShadow() const { return type == EffectType::DROP_SHADOW || type == EffectType::INNER_SHADOW; }
};

// A layout guide on a frame (schema LayoutGrid): columns (X), rows (Y) or a square grid.
struct LayoutGrid {
  LayoutGridType type = LayoutGridType::MIN;
  Axis axis = Axis::X;
  bool visible = true;
  int32_t numSections = 0;
  double offset = 0, sectionSize = 0, gutterSize = 0;
  Color color{1, 0, 0, 0.1f};
  LayoutGridPattern pattern = LayoutGridPattern::STRIPES;
  std::string extra;
  bool operator==(const LayoutGrid& o) const {
    return type == o.type && axis == o.axis && visible == o.visible && numSections == o.numSections && offset == o.offset &&
           sectionSize == o.sectionSize && gutterSize == o.gutterSize && color == o.color && pattern == o.pattern && extra == o.extra;
  }
};

// ELLIPSE arcs (radians; innerRadius 0..1 of the radius).
struct ArcData {
  double startingAngle = 0, endingAngle = 0, innerRadius = 0;
  bool operator==(const ArcData& o) const {
    return startingAngle == o.startingAngle && endingAngle == o.endingAngle && innerRadius == o.innerRadius;
  }
  // A full ellipse (no arc, no hole): the absent value, or a sweep of 2π and no inner radius.
  bool isFull() const;
};

// Per-element styles of a vector network (VectorData.styleOverrideTable, keyed by styleID ≥ 1).
enum VectorStyleField : uint32_t { VS_FILLS = 1, VS_STROKE_CAP = 2, VS_STROKE_JOIN = 4, VS_MIRRORING = 8, VS_CORNER_RADIUS = 16 };
struct VectorStyle {
  uint32_t styleID = 0;
  uint32_t mask = 0;
  std::vector<Paint> fillPaints;
  StrokeCap strokeCap = StrokeCap::NONE;
  StrokeJoin strokeJoin = StrokeJoin::MITER;
  VectorMirror handleMirroring = VectorMirror::NONE;
  double cornerRadius = 0;
  std::string extra;
  bool operator==(const VectorStyle& o) const {
    return styleID == o.styleID && mask == o.mask && fillPaints == o.fillPaints && strokeCap == o.strokeCap &&
           strokeJoin == o.strokeJoin && handleMirroring == o.handleMirroring && cornerRadius == o.cornerRadius && extra == o.extra;
  }
};

// Immutable bytes shared between copies of a node (blobs).
using Bytes = std::shared_ptr<const std::vector<uint8_t>>;

// A VECTOR's network (schema VectorData): the blob (docs/schema.md §11.3), the size its coordinates are in, the
// per-element styles.
struct VectorData {
  Bytes network;  // vectorNetworkBlob's bytes (null: no network)
  Vec2 normalizedSize;
  std::vector<VectorStyle> styleOverrideTable;
  bool present = false;
  bool operator==(const VectorData& o) const;
  const VectorStyle* style(uint32_t styleID) const {
    for (auto& s : styleOverrideTable)
      if (s.styleID == styleID) return &s;
    return nullptr;
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

// ---- Components (docs/schema.md §5) ----

// schema ComponentPropValue: a BOOL, TEXT (TextData), or GUID (INSTANCE_SWAP: a SYMBOL; SLOT: a content FRAME) value.
struct ComponentPropValue {
  bool hasBool = false, boolValue = false;
  bool hasText = false;
  TextData textValue;
  Guid guidValue = kNoGuid;
  std::string extra;  // other members, encoded
  bool operator==(const ComponentPropValue& o) const {
    return hasBool == o.hasBool && boolValue == o.boolValue && hasText == o.hasText && textValue == o.textValue &&
           guidValue == o.guidValue && extra == o.extra;
  }
  bool empty() const { return !hasBool && !hasText && guidValue == kNoGuid && extra.empty(); }
};
// schema InstanceSwapPreferredValue.
struct PreferredValue {
  bool stateGroup = false;  // type STATE_GROUP (else COMPONENT)
  std::string key;          // component key; local components: their GUID "s:l"
  bool operator==(const PreferredValue& o) const { return stateGroup == o.stateGroup && key == o.key; }
};
struct ComponentPropDef {
  Guid id = kNoGuid;
  std::string name;
  ComponentPropValue initialValue;
  std::string sortPosition;
  ComponentPropType type = ComponentPropType::BOOL;
  std::vector<PreferredValue> preferredValues;  // preferredValues.instanceSwapValues
  std::string description;
  std::string extra;  // varValue, slotPropConfig, preferredValues.stringValues…, encoded
  bool operator==(const ComponentPropDef& o) const {
    return id == o.id && name == o.name && initialValue == o.initialValue && sortPosition == o.sortPosition && type == o.type &&
           preferredValues == o.preferredValues && description == o.description && extra == o.extra;
  }
};
struct ComponentPropAssignment {
  Guid defID = kNoGuid;
  ComponentPropValue value;
  std::string extra;  // varValue, encoded
  bool operator==(const ComponentPropAssignment& o) const { return defID == o.defID && value == o.value && extra == o.extra; }
};
// One parameterConsumptionMap entry: a field bound to a component property (PROP_REF, `propRef`) or to a
// variable (kept encoded in `variableData` until the variables round).
struct ParamBinding {
  VariableField field = VariableField::MISSING;
  Guid propRef = kNoGuid;    // PROP_REF: the ComponentPropDef id
  std::string variableData;  // anything else: the whole VariableData, encoded
  bool operator==(const ParamBinding& o) const { return field == o.field && propRef == o.propRef && variableData == o.variableData; }
};
struct VariantPropSpec {
  Guid propDefId = kNoGuid;
  std::string value;
  bool operator==(const VariantPropSpec& o) const { return propDefId == o.propDefId && value == o.value; }
};
struct StateGroupOrder {
  std::string property;
  std::vector<std::string> values;
  bool operator==(const StateGroupOrder& o) const { return property == o.property && values == o.values; }
};
struct SymbolOverride;  // below NodeProps
// An instance's link to its main (schema SymbolData; one property, rewritten whole).
struct SymbolData {
  Guid symbolID = kNoGuid;
  std::vector<SymbolOverride> overrides;  // symbolOverrides: one sparse entry per guidPath (empty path = the root)
  double uniformScaleFactor = 1;
  bool operator==(const SymbolData& o) const;
  bool present() const;
};

struct ParentIndex {
  Guid guid = kNoGuid;
  std::string position;
  bool operator==(const ParentIndex& o) const { return guid == o.guid && position == o.position; }
};

// One bit per property. A change carries only the bits it touches.
// (128 bits: the engine models more than 64 properties.)
using FieldMask = unsigned __int128;
#define ENG_FIELD_BIT(n) (static_cast<FieldMask>(1) << (n))
enum Field : FieldMask {
  F_TYPE = ENG_FIELD_BIT(0),
  F_NAME = ENG_FIELD_BIT(1),
  F_VISIBLE = ENG_FIELD_BIT(2),
  F_LOCKED = ENG_FIELD_BIT(3),
  F_OPACITY = ENG_FIELD_BIT(4),
  F_TRANSFORM = ENG_FIELD_BIT(5),
  F_SIZE = ENG_FIELD_BIT(6),
  F_FILLS = ENG_FIELD_BIT(7),
  F_STROKES = ENG_FIELD_BIT(8),
  F_STROKE_WEIGHT = ENG_FIELD_BIT(9),
  F_STROKE_ALIGN = ENG_FIELD_BIT(10),
  F_CORNER_RADII = ENG_FIELD_BIT(11),
  F_FRAME_MASK_DISABLED = ENG_FIELD_BIT(12),
  F_PARENT_INDEX = ENG_FIELD_BIT(13),
  F_RESIZE_TO_FIT = ENG_FIELD_BIT(14),
  F_BACKGROUND_COLOR = ENG_FIELD_BIT(15),
  F_BACKGROUND_ENABLED = ENG_FIELD_BIT(16),
  F_INTERNAL_ONLY = ENG_FIELD_BIT(17),
  // Auto layout, container.
  F_STACK_MODE = ENG_FIELD_BIT(18),
  F_STACK_SPACING = ENG_FIELD_BIT(19),
  F_STACK_PADDING_LEFT = ENG_FIELD_BIT(20),    // stackHorizontalPadding
  F_STACK_PADDING_TOP = ENG_FIELD_BIT(21),     // stackVerticalPadding
  F_STACK_PADDING_RIGHT = ENG_FIELD_BIT(22),   // stackPaddingRight
  F_STACK_PADDING_BOTTOM = ENG_FIELD_BIT(23),  // stackPaddingBottom
  F_STACK_PRIMARY_SIZING = ENG_FIELD_BIT(24),
  F_STACK_COUNTER_SIZING = ENG_FIELD_BIT(25),
  F_STACK_PRIMARY_ALIGN = ENG_FIELD_BIT(26),         // stackPrimaryAlignItems
  F_STACK_COUNTER_ALIGN = ENG_FIELD_BIT(27),         // stackCounterAlignItems
  F_STACK_COUNTER_ALIGN_CONTENT = ENG_FIELD_BIT(28),  // stackCounterAlignContent
  F_STACK_WRAP = ENG_FIELD_BIT(29),
  F_STACK_COUNTER_SPACING = ENG_FIELD_BIT(30),
  F_STACK_REVERSE_Z = ENG_FIELD_BIT(31),  // stackReverseZIndex
  F_BORDERS_TAKE_SPACE = ENG_FIELD_BIT(32),
  // Auto layout, child.
  F_STACK_CHILD_GROW = ENG_FIELD_BIT(33),        // stackChildPrimaryGrow
  F_STACK_CHILD_ALIGN_SELF = ENG_FIELD_BIT(34),  // stackChildAlignSelf
  F_STACK_POSITIONING = ENG_FIELD_BIT(35),
  F_MIN_SIZE = ENG_FIELD_BIT(36),
  F_MAX_SIZE = ENG_FIELD_BIT(37),
  // Constraints.
  F_H_CONSTRAINT = ENG_FIELD_BIT(38),  // horizontalConstraint
  F_V_CONSTRAINT = ENG_FIELD_BIT(39),  // verticalConstraint
  F_PROPORTIONS_CONSTRAINED = ENG_FIELD_BIT(40),
  // Text.
  F_TEXT_DATA = ENG_FIELD_BIT(41),
  F_FONT_NAME = ENG_FIELD_BIT(42),
  F_FONT_SIZE = ENG_FIELD_BIT(43),
  F_LINE_HEIGHT = ENG_FIELD_BIT(44),
  F_LETTER_SPACING = ENG_FIELD_BIT(45),
  F_PARAGRAPH_SPACING = ENG_FIELD_BIT(46),
  F_PARAGRAPH_INDENT = ENG_FIELD_BIT(47),
  F_TEXT_ALIGN_H = ENG_FIELD_BIT(48),  // textAlignHorizontal
  F_TEXT_ALIGN_V = ENG_FIELD_BIT(49),  // textAlignVertical
  F_TEXT_AUTO_RESIZE = ENG_FIELD_BIT(50),
  F_TEXT_TRUNCATION = ENG_FIELD_BIT(51),
  F_MAX_LINES = ENG_FIELD_BIT(52),
  F_TEXT_CASE = ENG_FIELD_BIT(53),
  F_TEXT_DECORATION = ENG_FIELD_BIT(54),
  F_AUTO_RENAME = ENG_FIELD_BIT(55),
  // Paint, stroke, effects, masks (E4/E5).
  F_BLEND_MODE = ENG_FIELD_BIT(56),
  F_MASK = ENG_FIELD_BIT(57),
  F_MASK_TYPE = ENG_FIELD_BIT(58),
  F_STROKE_CAP = ENG_FIELD_BIT(59),
  F_STROKE_JOIN = ENG_FIELD_BIT(60),
  F_MITER_LIMIT = ENG_FIELD_BIT(61),
  F_DASH_PATTERN = ENG_FIELD_BIT(62),
  F_BORDER_WEIGHTS = ENG_FIELD_BIT(63),  // borderTop/Right/Bottom/LeftWeight + borderStrokeWeightsIndependent
  F_CORNER_SMOOTHING = ENG_FIELD_BIT(64),
  F_EFFECTS = ENG_FIELD_BIT(65),
  // Shapes and vectors.
  F_COUNT = ENG_FIELD_BIT(66),
  F_STAR_INNER_SCALE = ENG_FIELD_BIT(67),
  F_ARC_DATA = ENG_FIELD_BIT(68),
  F_VECTOR_DATA = ENG_FIELD_BIT(69),
  F_HANDLE_MIRRORING = ENG_FIELD_BIT(70),
  F_BOOLEAN_OPERATION = ENG_FIELD_BIT(71),
  F_LAYOUT_GRIDS = ENG_FIELD_BIT(72),
  // Every NodeChange field the engine doesn't model, kept as encoded JSON.
  F_EXTRA = ENG_FIELD_BIT(73),
  // Components (E6).
  F_OVERRIDE_KEY = ENG_FIELD_BIT(74),
  F_SYMBOL_DATA = ENG_FIELD_BIT(75),
  F_OVERRIDDEN_SYMBOL_ID = ENG_FIELD_BIT(76),
  F_COMPONENT_PROP_DEFS = ENG_FIELD_BIT(77),
  F_COMPONENT_PROP_ASSIGNMENTS = ENG_FIELD_BIT(78),
  F_PARAM_MAP = ENG_FIELD_BIT(79),  // parameterConsumptionMap
  F_IS_STATE_GROUP = ENG_FIELD_BIT(80),
  F_VARIANT_PROP_SPECS = ENG_FIELD_BIT(81),
  F_STATE_GROUP_ORDERS = ENG_FIELD_BIT(82),  // stateGroupPropertyValueOrders
  F_PROPS_ARE_BUBBLED = ENG_FIELD_BIT(83),
  F_IS_SLOT = ENG_FIELD_BIT(84),
  F_IS_SLOT_CONTENT = ENG_FIELD_BIT(85),
  F_DETACHED_SYMBOL_ID = ENG_FIELD_BIT(86),
  F_IS_SOFT_DELETED = ENG_FIELD_BIT(87),
  F_ANCESTOR_PATH = ENG_FIELD_BIT(88),  // ancestorPathBeforeDeletion
  F_ALL = ENG_FIELD_BIT(89) - 1,
};

inline constexpr FieldMask kComponentFields = F_OVERRIDE_KEY | F_SYMBOL_DATA | F_OVERRIDDEN_SYMBOL_ID | F_COMPONENT_PROP_DEFS |
                                              F_COMPONENT_PROP_ASSIGNMENTS | F_PARAM_MAP | F_IS_STATE_GROUP | F_VARIANT_PROP_SPECS |
                                              F_STATE_GROUP_ORDERS | F_PROPS_ARE_BUBBLED | F_IS_SLOT | F_IS_SLOT_CONTENT |
                                              F_DETACHED_SYMBOL_ID | F_IS_SOFT_DELETED | F_ANCESTOR_PATH;

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

// Fields that change a node's own geometry (its fill / stroke outlines).
inline constexpr FieldMask kShapeGeometryFields = F_SIZE | F_TYPE | F_CORNER_RADII | F_CORNER_SMOOTHING | F_COUNT |
                                                  F_STAR_INNER_SCALE | F_ARC_DATA | F_VECTOR_DATA | F_STROKE_WEIGHT |
                                                  F_STROKE_ALIGN | F_STROKE_CAP | F_STROKE_JOIN | F_MITER_LIMIT |
                                                  F_DASH_PATTERN | F_BORDER_WEIGHTS | F_BOOLEAN_OPERATION | F_TEXT_DATA;

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

  // Paint, stroke, effects, masks.
  BlendMode blendMode = BlendMode::PASS_THROUGH;
  bool mask = false;  // "Use as mask": masks the siblings above it
  MaskType maskType = MaskType::ALPHA;
  StrokeCap strokeCap = StrokeCap::NONE;
  StrokeJoin strokeJoin = StrokeJoin::MITER;
  double miterLimit = 4;
  std::vector<double> dashPattern;
  // Per-side stroke weights (rect-like frames and rectangles), top, right, bottom, left.
  std::array<double, 4> borderWeights{0, 0, 0, 0};
  bool borderStrokeWeightsIndependent = false;
  double cornerSmoothing = 0;
  std::vector<Effect> effects;
  // Shapes and vectors.
  uint32_t count = 0;            // REGULAR_POLYGON / STAR points
  double starInnerScale = 0;     // STAR "Ratio"
  ArcData arcData;               // ELLIPSE
  VectorData vectorData;         // VECTOR (and LINE arrows)
  VectorMirror handleMirroring = VectorMirror::NONE;
  BooleanOperation booleanOperation = BooleanOperation::UNION;
  std::vector<LayoutGrid> layoutGrids;  // frames

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
  // Components and instances (docs/schema.md §5).
  Guid overrideKey = kNoGuid;          // a node inside a component: its stable key (absent = its own GUID)
  SymbolData symbolData;               // INSTANCE: its main and its overrides
  Guid overriddenSymbolID = kNoGuid;   // override entries: a nested instance swapped to another main
  std::vector<ComponentPropDef> componentPropDefs;           // a SYMBOL, or a component set (all its properties)
  std::vector<ComponentPropAssignment> componentPropAssignments;  // an instance's property values
  std::vector<ParamBinding> parameterConsumptionMap;         // fields bound to properties (and variables)
  bool isStateGroup = false;           // FRAME: a component set
  std::vector<VariantPropSpec> variantPropSpecs;             // a variant: its value for each VARIANT property
  std::vector<StateGroupOrder> stateGroupPropertyValueOrders;
  bool propsAreBubbled = false;        // a nested instance exposed to its component's instances
  bool isSlot = false;                 // FRAME inside a component: a slot
  bool isSlotContent = false;          // FRAME under an instance: its slot content
  Guid detachedSymbolId = kNoGuid;     // a frame detached from this main
  bool isSoftDeleted = false;          // a deleted main kept for its instances (on the internal canvas)
  std::vector<Guid> ancestorPathBeforeDeletion;
  // The fields the engine doesn't model (vectorData, blendMode, effects…): name →
  // encoded JSON value. A CHANGED change's `extra` merges into the node's (an
  // empty value removes that field); CREATED replaces it.
  std::map<std::string, std::string> extra;

  bool isGroupLike() const { return type == NodeType::GROUP || (type == NodeType::FRAME && resizeToFit); }
  bool isBoolean() const { return type == NodeType::BOOLEAN_OPERATION; }
  // Fitted to its children's bounds (groups and boolean operations, docs/engine.md §4.5).
  bool fitsChildren() const { return isGroupLike() || isBoolean(); }
  // Drawn from a path (not the SDF fast path): vectors, stars, polygons, lines, booleans, smoothed corners, arcs.
  bool isPathShape() const;
  bool isFrameLike() const {
    return (type == NodeType::FRAME && !resizeToFit) || type == NodeType::SYMBOL || type == NodeType::INSTANCE ||
           type == NodeType::SECTION;
  }
  // Can hold children (pages and the document hold theirs too).
  bool isContainer() const {
    return isFrameLike() || isGroupLike() || isBoolean() || type == NodeType::CANVAS || type == NodeType::DOCUMENT;
  }
  bool isRectLike() const { return type == NodeType::ROUNDED_RECTANGLE || type == NodeType::RECTANGLE; }
  bool clipsContent() const { return isFrameLike() && !frameMaskDisabled; }
  bool isAutoLayout() const {
    return isFrameLike() && (stackMode == StackMode::HORIZONTAL || stackMode == StackMode::VERTICAL);
  }
  bool hugsPrimary() const { return stackPrimarySizing != StackSize::FIXED; }
  bool hugsCounter() const { return stackCounterSizing != StackSize::FIXED; }
  // Whether this node is laid out by its auto-layout parent (absolute ones aren't).
  bool inFlow() const { return visible && stackPositioning != StackPositioning::ABSOLUTE; }
  bool isComponentSet() const { return type == NodeType::FRAME && isStateGroup; }
  // A component, a component set or an instance: drawn selected / hovered in the component purple.
  bool isComponentish() const { return type == NodeType::SYMBOL || type == NodeType::INSTANCE || isComponentSet(); }
  // The stable key of a node inside a component (docs/schema.md §5.1).
  Guid keyOf(Guid guid) const { return overrideKey != kNoGuid ? overrideKey : guid; }
};

// One symbolOverrides entry: the overridden fields (`mask`) of the sublayer at `path` (empty = the root).
struct SymbolOverride {
  std::vector<Guid> path;
  FieldMask mask = 0;
  NodeProps props;
  bool operator==(const SymbolOverride& o) const;
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
