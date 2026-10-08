#include "scene/Node.h"

#include <algorithm>
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
    case NodeType::BRUSH:
    case NodeType::STAR:
    case NodeType::LINE:
    case NodeType::REGULAR_POLYGON:
    case NodeType::BOOLEAN_OPERATION: return true;
    case NodeType::ELLIPSE: return !shape().arcData.isFull() || !stroke().dashPattern.empty();
    case NodeType::RECTANGLE:
    case NodeType::ROUNDED_RECTANGLE: return stroke().cornerSmoothing > 0 || !stroke().dashPattern.empty();
    default: return false;
  }
}

// Never inlined (LTO would): see Node.h.
#define ENG_OUTLINE __attribute__((noinline))
ENG_OUTLINE NodeProps::NodeProps() = default;
ENG_OUTLINE NodeProps::NodeProps(const NodeProps&) = default;
ENG_OUTLINE NodeProps::NodeProps(NodeProps&&) noexcept = default;
ENG_OUTLINE NodeProps& NodeProps::operator=(const NodeProps&) = default;
ENG_OUTLINE NodeProps& NodeProps::operator=(NodeProps&&) noexcept = default;
ENG_OUTLINE NodeProps::~NodeProps() = default;

uint32_t NodeProps::facets() const {
  return (text_.has() ? 1u : 0u) | (stack_.has() ? 2u : 0u) | (shape_.has() ? 4u : 0u) | (stroke_.has() ? 8u : 0u) |
         (comp_.has() ? 16u : 0u) | (refs_.has() ? 32u : 0u) | (asset_.has() ? 64u : 0u) | (rare_.has() ? 128u : 0u);
}

void NodeProps::compact() {
  text_.compact();
  stack_.compact();
  shape_.compact();
  stroke_.compact();
  comp_.compact();
  refs_.compact();
  asset_.compact();
  rare_.compact();
}

size_t NodeProps::facetBytes() const {
  return (text_.has() ? sizeof(TextFacet) : 0) + (stack_.has() ? sizeof(StackFacet) : 0) + (shape_.has() ? sizeof(ShapeFacet) : 0) +
         (stroke_.has() ? sizeof(StrokeFacet) : 0) + (comp_.has() ? sizeof(ComponentFacet) : 0) + (refs_.has() ? sizeof(RefsFacet) : 0) +
         (asset_.has() ? sizeof(AssetFacet) : 0) + (rare_.has() ? sizeof(RareFacet) : 0);
}

ENG_OUTLINE Paint::Paint() = default;
ENG_OUTLINE Paint::Paint(const Paint&) = default;
ENG_OUTLINE Paint::Paint(Paint&&) noexcept = default;
ENG_OUTLINE Paint& Paint::operator=(const Paint&) = default;
ENG_OUTLINE Paint& Paint::operator=(Paint&&) noexcept = default;
ENG_OUTLINE Paint::~Paint() = default;
#undef ENG_OUTLINE

VariableData VariableData::boolean(bool v) {
  VariableData d;
  d.kind = Kind::BOOL;
  d.boolValue = v;
  d.hasDataType = d.hasResolvedType = true;
  d.dataType = VariableDataType::BOOLEAN;
  d.resolvedDataType = VariableResolvedType::BOOLEAN;
  return d;
}

VariableData VariableData::number(double v) {
  VariableData d;
  d.kind = Kind::FLOAT;
  d.floatValue = v;
  d.hasDataType = d.hasResolvedType = true;
  d.dataType = VariableDataType::FLOAT;
  d.resolvedDataType = VariableResolvedType::FLOAT;
  return d;
}

VariableData VariableData::string(std::string v) {
  VariableData d;
  d.kind = Kind::TEXT;
  d.textValue = std::move(v);
  d.hasDataType = d.hasResolvedType = true;
  d.dataType = VariableDataType::STRING;
  d.resolvedDataType = VariableResolvedType::STRING;
  return d;
}

VariableData VariableData::color(Color c) {
  VariableData d;
  d.kind = Kind::COLOR;
  d.colorValue = c;
  d.hasDataType = d.hasResolvedType = true;
  d.dataType = VariableDataType::COLOR;
  d.resolvedDataType = VariableResolvedType::COLOR;
  return d;
}

VariableData VariableData::aliasOf(Guid variable, VariableResolvedType resolved) {
  VariableData d;
  d.kind = Kind::ALIAS;
  d.alias = AssetId::of(variable);
  d.hasDataType = d.hasResolvedType = true;
  d.dataType = VariableDataType::ALIAS;
  d.resolvedDataType = resolved;
  return d;
}

VariableData VariableData::composeColor(VariableData color, VariableData opacity) {
  VariableData d;
  d.kind = Kind::EXPRESSION;
  d.function = ExpressionFunction::COMPOSE_COLOR;
  d.args = {std::move(color), std::move(opacity)};
  d.hasDataType = d.hasResolvedType = true;
  d.dataType = VariableDataType::EXPRESSION;
  d.resolvedDataType = VariableResolvedType::COLOR;
  return d;
}

VariableData VariableData::isTruthy(VariableData arg) {
  VariableData d;
  d.kind = Kind::EXPRESSION;
  d.function = ExpressionFunction::IS_TRUTHY;
  d.args = {std::move(arg)};
  d.hasDataType = d.hasResolvedType = true;
  d.dataType = VariableDataType::EXPRESSION;
  d.resolvedDataType = VariableResolvedType::BOOLEAN;
  return d;
}

VariableData VariableData::resolveVariant(const std::vector<std::pair<std::string, Guid>>& keys, std::vector<VariableData> values) {
  VariableData map;
  map.kind = Kind::MAP;
  map.hasDataType = map.hasResolvedType = true;
  map.dataType = VariableDataType::MAP;
  map.resolvedDataType = VariableResolvedType::MAP;
  for (auto& [name, def] : keys) {
    map.mapKeys.push_back(name);
    map.mapGuidKeys.push_back(def);
  }
  map.args = std::move(values);
  VariableData d;
  d.kind = Kind::EXPRESSION;
  d.function = ExpressionFunction::RESOLVE_VARIANT;
  d.args = {std::move(map)};
  d.hasDataType = d.hasResolvedType = true;
  d.dataType = VariableDataType::EXPRESSION;
  d.resolvedDataType = VariableResolvedType::SYMBOL_ID;
  return d;
}

bool NodeProps::hasBindings() const {
  if (refs().styleIdForFill.present() || refs().styleIdForStrokeFill.present() || refs().styleIdForText.present() || refs().styleIdForEffect.present() ||
      refs().styleIdForGrid.present())
    return true;
  for (auto& b : parameterConsumptionMap)
    if (b.isVariable()) return true;
  for (auto& p : fillPaints)
    if (p.hasVariables()) return true;
  for (auto& p : strokePaints)
    if (p.hasVariables()) return true;
  for (auto& e : effects)
    if (e.hasVariables()) return true;
  for (auto& g : rare().layoutGrids)
    if (g.hasVariables()) return true;
  for (auto& run : text().textData.styleOverrideTable)
    for (auto& p : run.fillPaints)
      if (p.hasVariables()) return true;
  // An instance's property values bound to variables (resolved in its modes when it is derived).
  for (auto& a : comp().componentPropAssignments)
    if (a.boundValue.present()) return true;
  return false;
}

Guid NodeProps::defaultMode() const {
  const VariableSetMode* best = nullptr;
  for (auto& m : asset().variableSetModes)
    if (!best || m.sortPosition < best->sortPosition) best = &m;
  return best ? best->id : kNoGuid;
}

std::vector<VariableSetMode> NodeProps::orderedModes() const {
  std::vector<VariableSetMode> modes = asset().variableSetModes;
  std::stable_sort(modes.begin(), modes.end(), [](const VariableSetMode& a, const VariableSetMode& b) { return a.sortPosition < b.sortPosition; });
  return modes;
}

void mergeParams(std::vector<ParamBinding>& base, const std::vector<ParamBinding>& over) {
  for (const ParamBinding& o : over) {
    auto it = std::find_if(base.begin(), base.end(), [&](const ParamBinding& b) { return b.field == o.field; });
    if (o.isUnbind()) {
      if (it != base.end()) base.erase(it);
    } else if (it != base.end()) {
      *it = o;
    } else {
      base.push_back(o);
    }
  }
}

std::vector<ParamBinding> paramDiff(const std::vector<ParamBinding>& before, const std::vector<ParamBinding>& after) {
  std::vector<ParamBinding> out;
  for (const ParamBinding& a : after) {
    auto it = std::find_if(before.begin(), before.end(), [&](const ParamBinding& b) { return b.field == a.field; });
    if (it == before.end() || !(*it == a)) out.push_back(a);
  }
  for (const ParamBinding& b : before)
    if (std::none_of(after.begin(), after.end(), [&](const ParamBinding& a) { return a.field == b.field; })) {
      ParamBinding unbind;
      unbind.field = b.field;
      out.push_back(unbind);
    }
  return out;
}

bool SymbolData::operator==(const SymbolData& o) const {
  return symbolID == o.symbolID && uniformScaleFactor == o.uniformScaleFactor && overrides == o.overrides;
}

bool SymbolData::present() const { return symbolID != kNoGuid || !overrides.empty(); }

bool SymbolOverride::operator==(const SymbolOverride& o) const {
  return path == o.path && mask == o.mask && differingFields(props, o.props, mask) == 0;
}

bool TextStyle::operator==(const TextStyle& o) const {
  return styleID == o.styleID && mask == o.mask && fontName == o.fontName && fontSize == o.fontSize && lineHeight == o.lineHeight &&
         letterSpacing == o.letterSpacing && textCase == o.textCase && textDecoration == o.textDecoration &&
         fillPaints == o.fillPaints && extra == o.extra;
}

// Every field: its bit, its member, its kiwi field id (schema/document.kiwi NodeChange).
#define ENG_NODE_FIELDS(X)                                 \
  X(F_TYPE, core, type, 4)                                 \
  X(F_NAME, core, name, 5)                                 \
  X(F_VISIBLE, core, visible, 6)                           \
  X(F_LOCKED, core, locked, 7)                             \
  X(F_OPACITY, core, opacity, 8)                           \
  X(F_TRANSFORM, core, transform, 12)                      \
  X(F_SIZE, core, size, 11)                                \
  X(F_FILLS, core, fillPaints, 38)                         \
  X(F_STROKES, core, strokePaints, 39)                     \
  X(F_STROKE_WEIGHT, core, strokeWeight, 26)               \
  X(F_STROKE_ALIGN, core, strokeAlign, 29)                 \
  X(F_FRAME_MASK_DISABLED, core, frameMaskDisabled, 115)   \
  X(F_PARENT_INDEX, core, parentIndex, 3)                  \
  X(F_RESIZE_TO_FIT, core, resizeToFit, 117)               \
  X(F_BACKGROUND_COLOR, rare, backgroundColor, 50)         \
  X(F_BACKGROUND_ENABLED, rare, backgroundEnabled, 15)     \
  X(F_INTERNAL_ONLY, rare, internalOnly, 142)              \
  X(F_STACK_MODE, stack, stackMode, 105)                   \
  X(F_STACK_SPACING, stack, stackSpacing, 107)             \
  X(F_STACK_PADDING_LEFT, stack, stackPaddingLeft, 209)    \
  X(F_STACK_PADDING_TOP, stack, stackPaddingTop, 210)      \
  X(F_STACK_PADDING_RIGHT, stack, stackPaddingRight, 233)  \
  X(F_STACK_PADDING_BOTTOM, stack, stackPaddingBottom, 234)\
  X(F_STACK_PRIMARY_SIZING, stack, stackPrimarySizing, 229)\
  X(F_STACK_COUNTER_SIZING, stack, stackCounterSizing, 221)\
  X(F_STACK_PRIMARY_ALIGN, stack, stackPrimaryAlignItems, 230)\
  X(F_STACK_COUNTER_ALIGN, stack, stackCounterAlignItems, 231)\
  X(F_STACK_COUNTER_ALIGN_CONTENT, stack, stackCounterAlignContent, 343)\
  X(F_STACK_WRAP, stack, stackWrap, 323)                   \
  X(F_STACK_COUNTER_SPACING, stack, stackCounterSpacing, 324)\
  X(F_STACK_REVERSE_Z, stack, stackReverseZIndex, 271)     \
  X(F_BORDERS_TAKE_SPACE, stack, bordersTakeSpace, 294)    \
  X(F_STACK_CHILD_GROW, core, stackChildPrimaryGrow, 232)  \
  X(F_STACK_CHILD_ALIGN_SELF, core, stackChildAlignSelf, 236)\
  X(F_STACK_POSITIONING, core, stackPositioning, 269)      \
  X(F_MIN_SIZE, rare, minSize, 325)                        \
  X(F_MAX_SIZE, rare, maxSize, 326)                        \
  X(F_H_CONSTRAINT, core, horizontalConstraint, 28)        \
  X(F_V_CONSTRAINT, core, verticalConstraint, 37)          \
  X(F_PROPORTIONS_CONSTRAINED, core, proportionsConstrained, 151)\
  X(F_TEXT_DATA, text, textData, 42)                       \
  X(F_FONT_NAME, text, fontName, 41)                       \
  X(F_FONT_SIZE, text, fontSize, 21)                       \
  X(F_LINE_HEIGHT, text, lineHeight, 40)                   \
  X(F_LETTER_SPACING, text, letterSpacing, 165)            \
  X(F_PARAGRAPH_SPACING, text, paragraphSpacing, 23)       \
  X(F_PARAGRAPH_INDENT, text, paragraphIndent, 22)         \
  X(F_TEXT_ALIGN_H, text, textAlignHorizontal, 32)         \
  X(F_TEXT_ALIGN_V, text, textAlignVertical, 33)           \
  X(F_TEXT_AUTO_RESIZE, text, textAutoResize, 46)          \
  X(F_TEXT_TRUNCATION, text, textTruncation, 280)          \
  X(F_MAX_LINES, text, maxLines, 351)                      \
  X(F_TEXT_CASE, text, textCase, 34)                       \
  X(F_TEXT_DECORATION, text, textDecoration, 35)           \
  X(F_AUTO_RENAME, text, autoRename, 14)                   \
  X(F_BLEND_MODE, core, blendMode, 9)                      \
  X(F_MASK, core, mask, 16)                                \
  X(F_MASK_TYPE, core, maskType, 317)                      \
  X(F_STROKE_CAP, core, strokeCap, 30)                     \
  X(F_STROKE_JOIN, core, strokeJoin, 31)                   \
  X(F_MITER_LIMIT, core, miterLimit, 25)                   \
  X(F_DASH_PATTERN, stroke, dashPattern, 13)               \
  X(F_BORDER_WEIGHTS, stroke, borderWeights, 295)          \
  X(F_BORDER_WEIGHTS, stroke, borderStrokeWeightsIndependent, 299)\
  X(F_CORNER_SMOOTHING, stroke, cornerSmoothing, 160)      \
  X(F_EFFECTS, core, effects, 43)                          \
  X(F_COUNT, shape, count, 10)                             \
  X(F_STAR_INNER_SCALE, shape, starInnerScale, 24)         \
  X(F_ARC_DATA, shape, arcData, 195)                       \
  X(F_VECTOR_DATA, shape, vectorData, 48)                  \
  X(F_HANDLE_MIRRORING, shape, handleMirroring, 44)        \
  X(F_BOOLEAN_OPERATION, shape, booleanOperation, 36)      \
  X(F_LAYOUT_GRIDS, rare, layoutGrids, 47)                 \
  X(F_OVERRIDE_KEY, core, overrideKey, 213)                \
  X(F_SYMBOL_DATA, comp, symbolData, 113)                  \
  X(F_OVERRIDDEN_SYMBOL_ID, comp, overriddenSymbolID, 143) \
  X(F_COMPONENT_PROP_DEFS, comp, componentPropDefs, 266)   \
  X(F_COMPONENT_PROP_ASSIGNMENTS, comp, componentPropAssignments, 268)\
  X(F_PARAM_MAP, core, parameterConsumptionMap, 445)       \
  X(F_IS_STATE_GROUP, comp, isStateGroup, 225)             \
  X(F_VARIANT_PROP_SPECS, comp, variantPropSpecs, 483)     \
  X(F_STATE_GROUP_ORDERS, comp, stateGroupPropertyValueOrders, 238)\
  X(F_PROPS_ARE_BUBBLED, comp, propsAreBubbled, 305)       \
  X(F_IS_SLOT, comp, isSlot, 463)                          \
  X(F_IS_SLOT_CONTENT, comp, isSlotContent, 495)           \
  X(F_DETACHED_SYMBOL_ID, comp, detachedSymbolId, 342)     \
  X(F_IS_SOFT_DELETED, comp, isSoftDeleted, 330)           \
  X(F_ANCESTOR_PATH, comp, ancestorPathBeforeDeletion, 235)\
  X(F_VARIABLE_MODES, refs, variableModeBySetMap, 316)     \
  X(F_STYLE_ID_FILL, refs, styleIdForFill, 332)            \
  X(F_STYLE_ID_STROKE, refs, styleIdForStrokeFill, 333)    \
  X(F_STYLE_ID_TEXT, refs, styleIdForText, 334)            \
  X(F_STYLE_ID_EFFECT, refs, styleIdForEffect, 335)        \
  X(F_STYLE_ID_GRID, refs, styleIdForGrid, 336)            \
  X(F_STYLE_TYPE, asset, styleType, 163)                   \
  X(F_SORT_POSITION, asset, sortPosition, 320)             \
  X(F_DESCRIPTION, asset, description, 318)                \
  X(F_KEY, asset, key, 319)                                \
  X(F_IS_PUBLISHABLE, asset, isPublishable, 174)           \
  X(F_VARIABLE_SET_MODES, asset, variableSetModes, 312)    \
  X(F_VARIABLE_SET_ID, asset, variableSetID, 313)          \
  X(F_VARIABLE_RESOLVED_TYPE, asset, variableResolvedType, 314)\
  X(F_VARIABLE_DATA_VALUES, asset, variableDataValues, 315)\
  X(F_VARIABLE_SCOPES, asset, variableScopes, 353)         \
  X(F_CODE_SYNTAX, asset, codeSyntax, 358)                 \
  X(F_VERSION, asset, version, 171)                        \
  X(F_PUBLISHED_VERSION, asset, publishedVersion, 218)     \
  X(F_SOURCE_LIBRARY_KEY, asset, sourceLibraryKey, 395)    \
  X(F_PUBLISH_ID, asset, publishID, 215)                   \
  X(F_LIBRARY_MOVE_INFO, asset, libraryMoveInfo, 256)        X(F_OVERRIDDEN_VARIABLE, asset, overriddenVariableId, 464)\
  X(F_EXTRA, core, extra, 0)

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
    case NodeType::VARIABLE_OVERRIDE: return "VARIABLE_OVERRIDE";
    case NodeType::BRUSH: return "BRUSH";
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
                                      NodeType::REGULAR_POLYGON, NodeType::SLICE, NodeType::VARIABLE, NodeType::VARIABLE_SET,
                                      NodeType::VARIABLE_OVERRIDE, NodeType::BRUSH};
  for (NodeType t : kAll)
    if (s == nodeTypeName(t)) return t;
  return NodeType::NONE;
}

// The corner bits in cornerRadii's order (top-left, top-right, bottom-right, bottom-left).
static constexpr Field kCornerBits[4] = {F_CORNER_TL, F_CORNER_TR, F_CORNER_BR, F_CORNER_BL};

// A core field is a member; a facet's field is copied only when either side has the facet (both absent: equal).
void copyFields(NodeProps& to, const NodeProps& from, FieldMask mask) {
#define ENG_COPY(bit, facet, member, id) ENG_COPY_##facet(bit, facet, member)
#define ENG_COPY_core(bit, facet, member) \
  if (mask & bit) to.member = from.member;
#define ENG_COPY_F(bit, f, member) \
  if ((mask & bit) && (from.f##_.has() || to.f##_.has())) to.f##_.edit().member = from.f##_.get().member;
#define ENG_COPY_text ENG_COPY_F
#define ENG_COPY_stack ENG_COPY_F
#define ENG_COPY_shape ENG_COPY_F
#define ENG_COPY_stroke ENG_COPY_F
#define ENG_COPY_comp ENG_COPY_F
#define ENG_COPY_refs ENG_COPY_F
#define ENG_COPY_asset ENG_COPY_F
#define ENG_COPY_rare ENG_COPY_F
  ENG_NODE_FIELDS(ENG_COPY)
#undef ENG_COPY
  if (mask & F_CORNER_RADII)
    for (size_t i = 0; i < 4; i++)
      if (mask & kCornerBits[i]) to.cornerRadii[i] = from.cornerRadii[i];
}

FieldMask differingFields(const NodeProps& a, const NodeProps& b, FieldMask mask) {
  FieldMask d = 0;
#define ENG_DIFF(bit, facet, member, id) ENG_DIFF_##facet(bit, facet, member)
#define ENG_DIFF_core(bit, facet, member) \
  if ((mask & bit) && !(a.member == b.member)) d |= bit;
#define ENG_DIFF_F(bit, f, member) \
  if ((mask & bit) && (a.f##_.has() || b.f##_.has()) && !(a.f##_.get().member == b.f##_.get().member)) d |= bit;
#define ENG_DIFF_text ENG_DIFF_F
#define ENG_DIFF_stack ENG_DIFF_F
#define ENG_DIFF_shape ENG_DIFF_F
#define ENG_DIFF_stroke ENG_DIFF_F
#define ENG_DIFF_comp ENG_DIFF_F
#define ENG_DIFF_refs ENG_DIFF_F
#define ENG_DIFF_asset ENG_DIFF_F
#define ENG_DIFF_rare ENG_DIFF_F
  ENG_NODE_FIELDS(ENG_DIFF)
#undef ENG_DIFF
  if (mask & F_CORNER_RADII)
    for (size_t i = 0; i < 4; i++)
      if ((mask & kCornerBits[i]) && a.cornerRadii[i] != b.cornerRadii[i]) d |= kCornerBits[i];
  return d;
}

uint32_t kiwiFieldId(Field f) {
  if (f == F_TYPE || f == F_PARENT_INDEX || f == F_EXTRA) return 0;
  if (f == F_CORNER_RADII) return 20;
  if (f == F_CORNER_TL) return 145;
  if (f == F_CORNER_TR) return 146;
  if (f == F_CORNER_BL) return 147;
  if (f == F_CORNER_BR) return 148;
#define ENG_ID(bit, facet, member, id) \
  if (f == bit) return id;
  ENG_NODE_FIELDS(ENG_ID)
#undef ENG_ID
  return 0;
}

FieldMask fieldsOfKiwiId(uint32_t id) {
  // cornerRadius and rectangleCornerRadiiIndependent stand for all four corners; each rectangle*CornerRadius for its own.
  if (id == 20 || id == 149) return F_CORNER_RADII;
  if (id == 145) return F_CORNER_TL;
  if (id == 146) return F_CORNER_TR;
  if (id == 147) return F_CORNER_BL;
  if (id == 148) return F_CORNER_BR;
  // borderTop/Bottom/Left/RightWeight and borderStrokeWeightsIndependent travel together.
  if (id >= 295 && id <= 299) return F_BORDER_WEIGHTS;
  if (id == 0) return 0;
#define ENG_BIT(bit, facet, member, kid) \
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
  if (m & kComponentFields) g |= G_COMPONENT;
  if (m & (F_PARAM_MAP | F_VARIABLE_MODES | kStyleIdFields | kAssetFields)) g |= G_BINDINGS;
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
      p.shape().count = 3;
      break;
    case NodeType::STAR:
      p.fillPaints = {Paint::solid(Color::hex(0xD9D9D9))};
      p.shape().count = 5;
      p.shape().starInnerScale = 0.382;
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
      p.text().textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
      p.text().autoRename = true;
      break;
    default: break;
  }
  return p;
}

}  // namespace eng
