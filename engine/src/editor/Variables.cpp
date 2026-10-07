// Variables, modes and styles (docs/engine.md §3.3 step 3, docs/schema.md §6): the resolver.
//
// A node's references are the truth; its own fields hold the resolved values (schema.md §3.5). After every
// change, the nodes whose bindings it reached are resolved again, in this order: their styles are copied in
// (fills, strokes, effects, layout guides, text-style fields and the style's own bindings), then every variable
// binding is resolved for the node's modes — an alias chain in the consumer's mode of each collection it crosses
// (Figma's resolveForConsumer), depth ≤ 16 — and written into the bound field as a system write of the same
// transaction (so it joins its message and its undo step). Instance sublayers are resolved while they are
// materialized, in their own modes (the instance chain counts as their ancestors).
//
// Dependencies are recorded while resolving (Materializer spirit): every variable, collection and style a
// consumer read points back to it, so a value, a mode list or a style edit re-resolves exactly what used it; an
// explicit mode or a move re-resolves the node's subtree.

#include <algorithm>
#include <cmath>

#include "base/DerivedIds.h"
#include "editor/Editor.h"

namespace eng {

namespace {

constexpr int kMaxAliasDepth = 16;

double clamp01(double v) { return std::isfinite(v) ? std::clamp(v, 0.0, 1.0) : 0.0; }
double nonNegative(double v) { return std::isfinite(v) ? std::max(0.0, v) : 0.0; }

// A weight (FONT_STYLE bound to a FLOAT) as a style name (Figma's named weights).
std::string styleForWeight(double w, bool italic) {
  static const std::pair<int, const char*> kNames[] = {{100, "Thin"},     {200, "Extra Light"}, {300, "Light"},
                                                        {400, "Regular"},  {500, "Medium"},      {600, "Semi Bold"},
                                                        {700, "Bold"},     {800, "Extra Bold"},  {900, "Black"}};
  const char* best = "Regular";
  double bestD = 1e9;
  for (auto& [weight, name] : kNames)
    if (std::fabs(weight - w) < bestD) bestD = std::fabs(weight - w), best = name;
  std::string s = best;
  if (italic) s = s == "Regular" ? "Italic" : s + " Italic";
  return s;
}

bool isItalicStyle(const std::string& style) { return style.find("Italic") != std::string::npos; }

// The FLOAT a node field binding takes, written into `p`.
void setFloatField(NodeProps& p, VariableField f, double v) {
  switch (f) {
    case VariableField::WIDTH: p.size.x = nonNegative(v); break;
    case VariableField::HEIGHT: p.size.y = nonNegative(v); break;
    case VariableField::MIN_WIDTH: p.minSize.x = nonNegative(v); break;
    case VariableField::MAX_WIDTH: p.maxSize.x = nonNegative(v); break;
    case VariableField::MIN_HEIGHT: p.minSize.y = nonNegative(v); break;
    case VariableField::MAX_HEIGHT: p.maxSize.y = nonNegative(v); break;
    case VariableField::OPACITY: p.opacity = clamp01(v / 100); break;  // a number bound to opacity is a percentage (R3-49)
    case VariableField::CORNER_RADIUS: p.cornerRadii = {nonNegative(v), nonNegative(v), nonNegative(v), nonNegative(v)}; break;
    case VariableField::RECTANGLE_TOP_LEFT_CORNER_RADIUS: p.cornerRadii[0] = nonNegative(v); break;
    case VariableField::RECTANGLE_TOP_RIGHT_CORNER_RADIUS: p.cornerRadii[1] = nonNegative(v); break;
    case VariableField::RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: p.cornerRadii[2] = nonNegative(v); break;
    case VariableField::RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: p.cornerRadii[3] = nonNegative(v); break;
    case VariableField::STROKE_WEIGHT: p.strokeWeight = nonNegative(v); break;
    case VariableField::BORDER_TOP_WEIGHT: p.borderWeights[0] = nonNegative(v); break;
    case VariableField::BORDER_RIGHT_WEIGHT: p.borderWeights[1] = nonNegative(v); break;
    case VariableField::BORDER_BOTTOM_WEIGHT: p.borderWeights[2] = nonNegative(v); break;
    case VariableField::BORDER_LEFT_WEIGHT: p.borderWeights[3] = nonNegative(v); break;
    case VariableField::STACK_SPACING: p.stackSpacing = std::isfinite(v) ? v : 0; break;
    case VariableField::STACK_COUNTER_SPACING: p.stackCounterSpacing = std::isfinite(v) ? v : 0; break;
    case VariableField::STACK_PADDING_LEFT: p.stackPaddingLeft = nonNegative(v); break;
    case VariableField::STACK_PADDING_TOP: p.stackPaddingTop = nonNegative(v); break;
    case VariableField::STACK_PADDING_RIGHT: p.stackPaddingRight = nonNegative(v); break;
    case VariableField::STACK_PADDING_BOTTOM: p.stackPaddingBottom = nonNegative(v); break;
    case VariableField::FONT_SIZE:
      if (std::isfinite(v) && v >= 1) p.fontSize = v;
      break;
    case VariableField::LINE_HEIGHT:
      // The node's units: RAW is the UI's percentage; Auto becomes pixels.
      if (!std::isfinite(v)) break;
      if (p.lineHeight.units == NumberUnits::RAW) p.lineHeight.value = v / 100;
      else p.lineHeight = {v, NumberUnits::PIXELS};
      break;
    case VariableField::LETTER_SPACING:
      if (std::isfinite(v)) p.letterSpacing.value = v;
      break;
    case VariableField::PARAGRAPH_SPACING: p.paragraphSpacing = nonNegative(v); break;
    case VariableField::PARAGRAPH_INDENT: p.paragraphIndent = nonNegative(v); break;
    default: break;  // GRID_ROW_GAP / GRID_COLUMN_GAP / FONT_VARIATIONS: kept as data (not modelled yet)
  }
}

constexpr VariableField kTextStyleFields[] = {VariableField::FONT_FAMILY,      VariableField::FONT_STYLE,
                                              VariableField::FONT_SIZE,        VariableField::LINE_HEIGHT,
                                              VariableField::LETTER_SPACING,   VariableField::PARAGRAPH_SPACING,
                                              VariableField::PARAGRAPH_INDENT, VariableField::FONT_VARIATIONS};
bool isTextStyleField(VariableField f) {
  return std::find(std::begin(kTextStyleFields), std::end(kTextStyleFields), f) != std::end(kTextStyleFields);
}

// The text-style fields a text style gives its users (docs/schema.md §6.5).
constexpr FieldMask kTextStyleNodeFields = F_FONT_NAME | F_FONT_SIZE | F_LINE_HEIGHT | F_LETTER_SPACING | F_PARAGRAPH_SPACING |
                                           F_PARAGRAPH_INDENT | F_TEXT_CASE | F_TEXT_DECORATION;

}  // namespace

// ---- Lookups ------------------------------------------------------------------------------------

void Editor::rebuildAssetKeys() const {
  assetKeys_.clear();
  doc_.forEach([&](const Node& n) {
    if (n.guid.isDerived() || n.props.key.empty()) return;
    const NodeProps& p = n.props;
    if (p.type != NodeType::VARIABLE && p.type != NodeType::VARIABLE_SET && !p.isStyle()) return;
    auto it = assetKeys_.find(p.key);
    // Prefer a live asset over a deleted one with the same key.
    if (it == assetKeys_.end() || (doc_.get(it->second)->props.isSoftDeleted && !p.isSoftDeleted)) assetKeys_[p.key] = n.guid;
  });
  assetKeysDirty_ = false;
}

namespace {
template <typename Pred>
Guid findAsset(const Document& doc, const AssetId& id, const std::unordered_map<std::string, Guid>& keys, Pred ok) {
  if (id.guid != kNoGuid) {
    const Node* n = doc.get(id.guid);
    if (n && ok(n->props)) return id.guid;
  }
  if (!id.key.empty()) {
    auto it = keys.find(id.key);
    if (it != keys.end()) {
      const Node* n = doc.get(it->second);
      if (n && ok(n->props)) return it->second;
    }
  }
  return kNoGuid;
}
}  // namespace

Guid Editor::findVariable(const AssetId& id) const {
  if (!id.key.empty() && assetKeysDirty_) rebuildAssetKeys();
  return findAsset(doc_, id, assetKeys_, [](const NodeProps& p) { return p.type == NodeType::VARIABLE; });
}

Guid Editor::findCollection(const AssetId& id) const {
  if (!id.key.empty() && assetKeysDirty_) rebuildAssetKeys();
  return findAsset(doc_, id, assetKeys_, [](const NodeProps& p) { return p.type == NodeType::VARIABLE_SET; });
}

Guid Editor::findStyle(const AssetId& id) const {
  if (!id.key.empty() && assetKeysDirty_) rebuildAssetKeys();
  return findAsset(doc_, id, assetKeys_, [](const NodeProps& p) { return p.isStyle(); });
}

const NodeProps* Editor::styleNode(const AssetId& id, StyleType type) const {
  Guid g = findStyle(id);
  const Node* n = g != kNoGuid ? doc_.get(g) : nullptr;
  if (!n) return nullptr;
  // A FILL style is any paint style; the others must match.
  if (n->props.styleType != type) return nullptr;
  return &n->props;
}

namespace {
// Assets in the panels' order: sortPosition, then their place under the internal canvas, then id (one sort, shared).
__attribute__((noinline)) void sortAssets(const Document& doc, std::vector<Guid>& ids) {
  std::sort(ids.begin(), ids.end(), [&](Guid ga, Guid gb) {
    const NodeProps& a = doc.get(ga)->props;
    const NodeProps& b = doc.get(gb)->props;
    if (a.sortPosition != b.sortPosition) return a.sortPosition < b.sortPosition;
    if (a.parentIndex.position != b.parentIndex.position) return a.parentIndex.position < b.parentIndex.position;
    return ga < gb;
  });
}
}  // namespace

std::vector<Guid> Editor::collections(bool includeRemote) const {
  std::vector<Guid> out;
  doc_.forEach([&](const Node& n) {
    if (n.props.type == NodeType::VARIABLE_SET && !n.props.isSoftDeleted && !n.guid.isDerived() &&
        (includeRemote || !isLibraryCopy(n.guid)))
      out.push_back(n.guid);
  });
  sortAssets(doc_, out);
  return out;
}

std::vector<Guid> Editor::variablesOf(Guid collection, bool includeDeleted) const {
  std::vector<Guid> out;
  const Node* set = doc_.get(collection);
  doc_.forEach([&](const Node& n) {
    if (n.props.type != NodeType::VARIABLE || n.guid.isDerived() || (n.props.isSoftDeleted && !includeDeleted)) return;
    const AssetId& s = n.props.variableSetID;
    bool mine = collection == kNoGuid || s.guid == collection || (set && !s.key.empty() && s.key == set->props.key);
    if (mine) out.push_back(n.guid);
  });
  sortAssets(doc_, out);
  return out;
}

std::vector<Guid> Editor::stylesOf(StyleType type, bool includeRemote) const {
  std::vector<Guid> out;
  doc_.forEach([&](const Node& n) {
    if (!n.props.isStyle() || n.guid.isDerived() || n.props.isSoftDeleted) return;
    if (!includeRemote && isLibraryCopy(n.guid)) return;
    if (type == StyleType::NONE || n.props.styleType == type) out.push_back(n.guid);
  });
  sortAssets(doc_, out);
  return out;
}

uint32_t Editor::styleUsage(Guid style) const {
  // Layers that reference it (real ones: an instance's sublayers come with their main; library copies' layers are
  // the copies' own, not uses in this file).
  const Node* s = doc_.get(style);
  if (!s) return 0;
  uint32_t count = 0;
  doc_.forEach([&](const Node& n) {
    if (n.guid.isDerived() || n.props.isStyle() || isLibraryCopy(n.guid)) return;
    const NodeProps& p = n.props;
    for (const AssetId* id : {&p.styleIdForFill, &p.styleIdForStrokeFill, &p.styleIdForText, &p.styleIdForEffect, &p.styleIdForGrid})
      if (id->present() && (id->guid == style || (!id->key.empty() && id->key == s->props.key))) {
        count++;
        break;
      }
  });
  return count;
}

// ---- Resolution ---------------------------------------------------------------------------------

Guid Editor::modeFor(const ModeContext& ctx, Guid set) const {
  const Node* sn = doc_.get(set);
  if (!sn) return kNoGuid;
  const NodeProps& sp = sn->props;
  auto valid = [&](Guid mode) {
    for (auto& m : sp.variableSetModes)
      if (m.id == mode) return true;
    return false;
  };
  if (ctx.forcedSet == set && valid(ctx.forcedMode)) return ctx.forcedMode;
  // The nearest explicit mode for this collection: the node, then its ancestors (pages included; an instance's
  // sublayers go through the instance). A mode the collection no longer has counts as Auto.
  const NodeProps* p = ctx.self;
  Guid cur = ctx.consumer;
  if (!p && cur != kNoGuid) {
    const Node* n = doc_.get(cur);
    p = n ? &n->props : nullptr;
  }
  for (int guard = 0; p && guard < 4096; guard++) {
    Guid m = p->explicitMode(set, sp.key);
    if (m != kNoGuid && valid(m)) return m;
    const Node* parent = doc_.get(p->parentIndex.guid);
    if (!parent || p->parentIndex.guid == cur) break;
    cur = p->parentIndex.guid;
    p = &parent->props;
  }
  return sp.defaultMode();
}

bool Editor::resolveVar(Guid variable, const ModeContext& ctx, Resolved& out, BindingDeps* deps, int depth) const {
  if (depth > kMaxAliasDepth) return false;
  const Node* vn = doc_.get(variable);
  if (!vn || vn->props.type != NodeType::VARIABLE) return false;
  const NodeProps& vp = vn->props;
  Guid set = findCollection(vp.variableSetID);
  if (deps) deps->sets.push_back(set != kNoGuid ? set : vp.variableSetID.guid);
  const VariableModeValue* value = nullptr;
  if (set != kNoGuid) {
    Guid mode = modeFor(ctx, set);
    for (auto& v : vp.variableDataValues)
      if (v.modeID == mode) value = &v;
    if (!value) {
      // A missing entry falls back to the default mode's value (docs/schema.md §4.6).
      Guid def = doc_.get(set)->props.defaultMode();
      for (auto& v : vp.variableDataValues)
        if (v.modeID == def) value = &v;
    }
  }
  if (!value && !vp.variableDataValues.empty()) value = &vp.variableDataValues.front();
  if (!value) return false;
  if (!resolveData(value->data, ctx, out, deps, depth + 1)) return false;
  // The value must be of the variable's type.
  switch (vp.variableResolvedType) {
    case VariableResolvedType::BOOLEAN: return out.kind == Resolved::Kind::BOOL;
    case VariableResolvedType::FLOAT:
    case VariableResolvedType::TIMING: return out.kind == Resolved::Kind::FLOAT;
    case VariableResolvedType::STRING: return out.kind == Resolved::Kind::STRING;
    case VariableResolvedType::COLOR: return out.kind == Resolved::Kind::COLOR;
    default: return true;
  }
}

bool Editor::resolveData(const VariableData& d, const ModeContext& ctx, Resolved& out, BindingDeps* deps, int depth) const {
  using K = VariableData::Kind;
  out = Resolved{};
  if (depth > kMaxAliasDepth) return false;
  switch (d.kind) {
    case K::BOOL:
      out.kind = Resolved::Kind::BOOL;
      out.b = d.boolValue;
      return true;
    case K::FLOAT:
      out.kind = Resolved::Kind::FLOAT;
      out.f = d.floatValue;
      return true;
    case K::TEXT:
      out.kind = Resolved::Kind::STRING;
      out.s = d.textValue;
      return true;
    case K::COLOR:
      out.kind = Resolved::Kind::COLOR;
      out.c = d.colorValue;
      return true;
    case K::ALIAS: {
      Guid v = findVariable(d.alias);
      if (deps) deps->vars.push_back(v != kNoGuid ? v : d.alias.guid);
      if (v == kNoGuid) return false;
      return resolveVar(v, ctx, out, deps, depth + 1);
    }
    case K::EXPRESSION: {
      if (d.function != ExpressionFunction::COMPOSE_COLOR || d.args.size() < 2) return false;
      // "Control opacity at scale": the colour (literal or alias) with the opacity (a percentage, literal or alias).
      Resolved color, opacity;
      if (!resolveData(d.args[0], ctx, color, deps, depth + 1) || color.kind != Resolved::Kind::COLOR) return false;
      if (!resolveData(d.args[1], ctx, opacity, deps, depth + 1) || opacity.kind != Resolved::Kind::FLOAT) return false;
      out = color;
      out.c.a = static_cast<float>(clamp01(opacity.f / 100));
      return true;
    }
    case K::FONT_STYLE: {
      // A style name (STRING), else a weight (FLOAT) → the style name.
      for (size_t i = 0; i < d.args.size() && i < 2; i++) {
        if (!d.args[i].present()) continue;
        Resolved r;
        if (!resolveData(d.args[i], ctx, r, deps, depth + 1)) continue;
        if (r.kind == Resolved::Kind::STRING || r.kind == Resolved::Kind::FLOAT) {
          out = r;
          return true;
        }
      }
      return false;
    }
    default: {
      if (d.hasDataType && (d.dataType == VariableDataType::EASING)) {
        out.kind = Resolved::Kind::OTHER;
        out.raw = d.extra + d.valueExtra;
        return true;
      }
      return false;
    }
  }
}

bool Editor::resolveVariable(Guid variable, Guid consumer, Resolved& out) const {
  ModeContext ctx;
  ctx.consumer = consumer;
  return resolveVar(variable, ctx, out, nullptr, 0);
}

bool Editor::resolveVariableInMode(Guid variable, Guid mode, Resolved& out) const {
  const Node* vn = doc_.get(variable);
  if (!vn) return false;
  ModeContext ctx;
  ctx.forcedSet = findCollection(vn->props.variableSetID);
  ctx.forcedMode = mode;
  return resolveVar(variable, ctx, out, nullptr, 0);
}

Guid Editor::resolvedMode(Guid node, Guid set) const {
  ModeContext ctx;
  ctx.consumer = node;
  return modeFor(ctx, set);
}

void Editor::resolveBindings(Guid id, NodeProps& p, BindingDeps* deps) const {
  // 1. Styles: their values (with their own bindings) replace the consumer's.
  auto useStyle = [&](const AssetId& ref, StyleType type) -> const NodeProps* {
    if (!ref.present()) return nullptr;
    Guid g = findStyle(ref);
    if (deps) deps->styles.push_back(g != kNoGuid ? g : ref.guid);
    return styleNode(ref, type);
  };
  if (const NodeProps* s = useStyle(p.styleIdForFill, StyleType::FILL)) p.fillPaints = s->fillPaints;
  if (const NodeProps* s = useStyle(p.styleIdForStrokeFill, StyleType::FILL)) p.strokePaints = s->fillPaints;
  if (const NodeProps* s = useStyle(p.styleIdForEffect, StyleType::EFFECT)) p.effects = s->effects;
  if (const NodeProps* s = useStyle(p.styleIdForGrid, StyleType::GRID)) p.layoutGrids = s->layoutGrids;
  if (const NodeProps* s = useStyle(p.styleIdForText, StyleType::TEXT); s && p.type == NodeType::TEXT) {
    copyFields(p, *s, kTextStyleNodeFields);
    // The style's typography bindings become the layer's (they stay when the style is detached, as in Figma).
    auto& map = p.parameterConsumptionMap;
    map.erase(std::remove_if(map.begin(), map.end(), [](const ParamBinding& b) { return isTextStyleField(b.field); }), map.end());
    for (const ParamBinding& b : s->parameterConsumptionMap)
      if (b.isVariable() && isTextStyleField(b.field)) map.push_back(b);
  }

  // 2. Variables, in the node's modes.
  ModeContext ctx;
  ctx.consumer = id;
  ctx.self = &p;
  auto resolve = [&](const VariableData& d, Resolved& r) { return d.present() && resolveData(d, ctx, r, deps, 0); };
  Resolved r;
  // Node fields: the uniform corner radius first, so per-corner bindings win.
  std::vector<const ParamBinding*> bindings;
  for (const ParamBinding& b : p.parameterConsumptionMap)
    if (b.isVariable()) bindings.push_back(&b);
  std::stable_sort(bindings.begin(), bindings.end(), [](const ParamBinding* a, const ParamBinding* b) {
    return (a->field == VariableField::CORNER_RADIUS) > (b->field == VariableField::CORNER_RADIUS);
  });
  std::vector<std::pair<VariableField, Resolved>> values;
  for (const ParamBinding* b : bindings)
    if (resolve(b->data, r)) values.push_back({b->field, r});
  for (auto& [field, v] : values) {
    switch (field) {
      case VariableField::VISIBLE:
        if (v.kind == Resolved::Kind::BOOL) p.visible = v.b;
        break;
      case VariableField::TEXT_DATA:
        if (v.kind == Resolved::Kind::STRING && p.type == NodeType::TEXT && p.textData.characters != v.s) {
          p.textData.characters = v.s;
          p.textData.characterStyleIDs.clear();  // one style: the layer's own
          p.textData.lines.clear();
        }
        break;
      case VariableField::FONT_FAMILY:
        if (v.kind == Resolved::Kind::STRING && !v.s.empty() && p.fontName.family != v.s) {
          p.fontName.family = v.s;
          p.fontName.postscript.clear();
        }
        break;
      case VariableField::FONT_STYLE: {
        std::string style = v.kind == Resolved::Kind::STRING ? v.s
                            : v.kind == Resolved::Kind::FLOAT ? styleForWeight(v.f, isItalicStyle(p.fontName.style))
                                                             : std::string();
        if (!style.empty() && p.fontName.style != style) {
          p.fontName.style = style;
          p.fontName.postscript.clear();
        }
        break;
      }
      default:
        if (v.kind == Resolved::Kind::FLOAT) setFloatField(p, field, v.f);
        break;
    }
  }
  // Paints, effects, layout guides.
  auto paints = [&](std::vector<Paint>& list) {
    for (Paint& pt : list) {
      if (resolve(pt.colorVar, r) && r.kind == Resolved::Kind::COLOR) pt.color = r.c;
      if (resolve(pt.opacityVar, r) && r.kind == Resolved::Kind::FLOAT) pt.opacity = static_cast<float>(clamp01(r.f / 100));
      for (size_t i = 0; i < pt.stopVars.size() && i < pt.stops.size(); i++)
        if (resolve(pt.stopVars[i], r) && r.kind == Resolved::Kind::COLOR) pt.stops[i].color = r.c;
    }
  };
  paints(p.fillPaints);
  paints(p.strokePaints);
  for (TextStyle& run : p.textData.styleOverrideTable) paints(run.fillPaints);
  for (Effect& e : p.effects) {
    if (resolve(e.colorVar, r) && r.kind == Resolved::Kind::COLOR) e.color = r.c;
    if (resolve(e.radiusVar, r) && r.kind == Resolved::Kind::FLOAT) e.radius = nonNegative(r.f);
    if (resolve(e.spreadVar, r) && r.kind == Resolved::Kind::FLOAT) e.spread = r.f;
    if (resolve(e.xVar, r) && r.kind == Resolved::Kind::FLOAT) e.offset.x = r.f;
    if (resolve(e.yVar, r) && r.kind == Resolved::Kind::FLOAT) e.offset.y = r.f;
  }
  for (LayoutGrid& g : p.layoutGrids) {
    if (resolve(g.numSectionsVar, r) && r.kind == Resolved::Kind::FLOAT)
      g.numSections = static_cast<int32_t>(std::max(0.0, std::round(r.f)));  // counts are whole (R3-49)
    if (resolve(g.offsetVar, r) && r.kind == Resolved::Kind::FLOAT) g.offset = r.f;
    if (resolve(g.sectionSizeVar, r) && r.kind == Resolved::Kind::FLOAT) g.sectionSize = nonNegative(r.f);
    if (resolve(g.gutterSizeVar, r) && r.kind == Resolved::Kind::FLOAT) g.gutterSize = nonNegative(r.f);
  }
}

// What resolveBindings writes, reset: a style's values in its user, every variable-bound field. The binding is the
// content; the value depends on where the node sits (its modes) and on the variable / style (their own content).
void Editor::clearBoundValues(NodeProps& p) {
  const NodeProps none;
  if (p.styleIdForFill.present()) p.fillPaints.clear();
  if (p.styleIdForStrokeFill.present()) p.strokePaints.clear();
  if (p.styleIdForEffect.present()) p.effects.clear();
  if (p.styleIdForGrid.present()) p.layoutGrids.clear();
  if (p.styleIdForText.present() && p.type == NodeType::TEXT) {
    copyFields(p, none, kTextStyleNodeFields);
    // The style's typography bindings, copied into the layer, are the style's.
    auto& map = p.parameterConsumptionMap;
    map.erase(std::remove_if(map.begin(), map.end(), [](const ParamBinding& b) { return b.isVariable() && isTextStyleField(b.field); }),
              map.end());
  }
  for (const ParamBinding& b : p.parameterConsumptionMap) {
    if (!b.isVariable()) continue;
    switch (b.field) {
      case VariableField::VISIBLE: p.visible = none.visible; break;
      case VariableField::TEXT_DATA:
        if (p.type == NodeType::TEXT) {
          p.textData.characters.clear();
          p.textData.characterStyleIDs.clear();
          p.textData.lines.clear();
        }
        break;
      case VariableField::FONT_FAMILY: p.fontName.family.clear(), p.fontName.postscript.clear(); break;
      case VariableField::FONT_STYLE: p.fontName.style.clear(), p.fontName.postscript.clear(); break;
      case VariableField::FONT_SIZE: p.fontSize = none.fontSize; break;
      case VariableField::LINE_HEIGHT: p.lineHeight = none.lineHeight; break;
      case VariableField::LETTER_SPACING: p.letterSpacing = none.letterSpacing; break;
      default: setFloatField(p, b.field, 0); break;
    }
  }
  auto paints = [](std::vector<Paint>& list) {
    for (Paint& pt : list) {
      if (pt.colorVar.present()) pt.color = Color{};
      if (pt.opacityVar.present()) pt.opacity = 1;
      for (size_t i = 0; i < pt.stopVars.size() && i < pt.stops.size(); i++)
        if (pt.stopVars[i].present()) pt.stops[i].color = Color{};
    }
  };
  paints(p.fillPaints);
  paints(p.strokePaints);
  for (TextStyle& run : p.textData.styleOverrideTable) paints(run.fillPaints);
  for (Effect& e : p.effects) {
    if (e.colorVar.present()) e.color = Color{};
    if (e.radiusVar.present()) e.radius = 0;
    if (e.spreadVar.present()) e.spread = 0;
    if (e.xVar.present()) e.offset.x = 0;
    if (e.yVar.present()) e.offset.y = 0;
  }
  for (LayoutGrid& g : p.layoutGrids) {
    if (g.numSectionsVar.present()) g.numSections = 0;
    if (g.offsetVar.present()) g.offset = 0;
    if (g.sectionSizeVar.present()) g.sectionSize = 0;
    if (g.gutterSizeVar.present()) g.gutterSize = 0;
  }
}

// ---- Dependencies ---------------------------------------------------------------------------------

void Editor::dropDeps(Guid id) {
  auto it = deps_.find(id);
  if (it == deps_.end()) return;
  auto unlink = [&](std::unordered_map<Guid, GuidSet, GuidHash>& map, const std::vector<Guid>& keys) {
    for (Guid k : keys) {
      auto m = map.find(k);
      if (m == map.end()) continue;
      m->second.erase(id);
      if (m->second.empty()) map.erase(m);
    }
  };
  unlink(varConsumers_, it->second.vars);
  unlink(setConsumers_, it->second.sets);
  unlink(styleConsumers_, it->second.styles);
  deps_.erase(it);
}

void Editor::setDeps(Guid id, BindingDeps&& deps) {
  // The styles whose usage changed are an event (real layers only).
  std::vector<Guid> before;
  if (auto it = deps_.find(id); it != deps_.end()) before = it->second.styles;
  dropDeps(id);
  auto clean = [](std::vector<Guid>& v) {
    v.erase(std::remove(v.begin(), v.end(), kNoGuid), v.end());
    std::sort(v.begin(), v.end());
    v.erase(std::unique(v.begin(), v.end()), v.end());
  };
  clean(deps.vars);
  clean(deps.sets);
  clean(deps.styles);
  if (!id.isDerived())
    for (Guid s : deps.styles)
      if (std::find(before.begin(), before.end(), s) == before.end()) events_.styles.push_back(s);
  if (!id.isDerived())
    for (Guid s : before)
      if (std::find(deps.styles.begin(), deps.styles.end(), s) == deps.styles.end()) events_.styles.push_back(s);
  if (deps.vars.empty() && deps.sets.empty() && deps.styles.empty()) return;
  for (Guid v : deps.vars) varConsumers_[v].insert(id);
  for (Guid s : deps.sets) setConsumers_[s].insert(id);
  for (Guid s : deps.styles) styleConsumers_[s].insert(id);
  deps_[id] = std::move(deps);
}

void Editor::markBindingsSubtree(Guid id) {
  std::vector<Guid> stack{id};
  while (!stack.empty()) {
    Guid g = stack.back();
    stack.pop_back();
    const Node* n = doc_.get(g);
    if (!n) continue;
    if (n->props.hasBindings() || deps_.count(g)) bindingsDirty_.insert(g);
    if (n->props.type == NodeType::INSTANCE) {
      // Its sublayers resolve while it is materialized: again, when one of them is bound.
      if (instanceBindings_.count(g)) instanceDirty_.insert(g);
      for (Guid c : doc_.children(g))
        if (!c.isDerived()) stack.push_back(c);  // slot content
      continue;
    }
    for (Guid c : doc_.children(g)) stack.push_back(c);
  }
}

void Editor::noteBindings(const NodeChange& c, NodeType typeBefore) {
  if (c.guid.isDerived()) return;
  const Node* n = doc_.get(c.guid);
  FieldMask m = c.phase == Phase::CHANGED ? c.mask : F_ALL;
  auto markAll = [&](std::unordered_map<Guid, GuidSet, GuidHash>& map) {
    auto it = map.find(c.guid);
    if (it == map.end()) return;
    for (Guid g : it->second) bindingsDirty_.insert(g);
  };
  // Assets: whatever used them resolves again; the panels hear about it (also when an undo removes one).
  NodeType type = n ? n->props.type : typeBefore;
  if (!n && variableSets_.count(c.guid)) type = NodeType::VARIABLE;
  if (!n && collectionIds_.count(c.guid)) type = NodeType::VARIABLE_SET;
  if (type == NodeType::VARIABLE) {
    markAll(varConsumers_);
    events_.variables.push_back(c.guid);
    if (auto it = variableSets_.find(c.guid); it != variableSets_.end()) events_.collections.push_back(it->second);
    if (n) {
      Guid set = findCollection(n->props.variableSetID);
      events_.collections.push_back(set);
      variableSets_[c.guid] = set;
    } else {
      variableSets_.erase(c.guid);
    }
    if (c.phase != Phase::CHANGED || (m & F_KEY)) assetKeysDirty_ = true;
  } else if (type == NodeType::VARIABLE_SET) {
    markAll(setConsumers_);
    events_.collections.push_back(c.guid);
    if (n) collectionIds_.insert(c.guid);
    else collectionIds_.erase(c.guid);
    if (c.phase != Phase::CHANGED || (m & F_KEY)) assetKeysDirty_ = true;
  }
  bool style = n ? n->props.isStyle() : styleIds_.count(c.guid) != 0;
  if (style || styleIds_.count(c.guid)) {
    markAll(styleConsumers_);
    events_.styles.push_back(c.guid);
    if (c.phase != Phase::CHANGED || (m & (F_KEY | F_STYLE_TYPE))) assetKeysDirty_ = true;
    if (n && n->props.isStyle()) styleIds_.insert(c.guid);
    else styleIds_.erase(c.guid);
  }
  if (c.phase == Phase::REMOVED || !n) {
    if (deps_.count(c.guid)) {
      // A layer that used styles: their usage changed.
      for (Guid s : deps_[c.guid].styles) events_.styles.push_back(s);
      dropDeps(c.guid);
    }
    return;
  }
  if (resolving_) return;  // the resolver's own writes
  if (c.phase == Phase::CREATED || (m & (F_VARIABLE_MODES | F_PARENT_INDEX))) {
    markBindingsSubtree(c.guid);
  } else if (m & kBindingInputFields) {
    if (n->props.hasBindings() || deps_.count(c.guid)) bindingsDirty_.insert(c.guid);
  }
}

void Editor::flushBindings() {
  for (int pass = 0; pass < 8 && !bindingsDirty_.empty(); pass++) {
    std::vector<Guid> list(bindingsDirty_.begin(), bindingsDirty_.end());
    bindingsDirty_.clear();
    std::sort(list.begin(), list.end());
    for (Guid id : list) {
      if (id.isDerived()) {
        // An instance's sublayer: resolved again with its instance.
        Guid inst = instanceOfDerived(id);
        if (inst != kNoGuid && doc_.has(inst)) instanceDirty_.insert(inst);
        else dropDeps(id);
        continue;
      }
      const Node* n = doc_.get(id);
      if (!n) {
        dropDeps(id);
        continue;
      }
      NodeProps p = n->props;
      BindingDeps deps;
      resolveBindings(id, p, &deps);
      setDeps(id, std::move(deps));
      FieldMask d = differingFields(n->props, p, F_ALL & ~static_cast<FieldMask>(F_TYPE | F_PARENT_INDEX));
      if (!d) continue;
      NodeChange c = NodeChange::changed(id);
      c.mask = d;
      copyFields(c.props, p, d);
      bool prev = resolving_;
      resolving_ = true;
      write(c);
      resolving_ = prev;
    }
  }
}

// ---- Detaching on edit -------------------------------------------------------------------------------

void Editor::detachEdited(const NodeProps& before, NodeChange& c) const {
  if (c.phase != Phase::CHANGED) return;
  const NodeProps& now = c.props;
  FieldMask m = c.mask;
  // Node fields: a typed / dragged value replaces the variable (Figma).
  if (!(m & F_PARAM_MAP)) {
    auto changed = [&](VariableField f) -> bool {
      switch (f) {
        case VariableField::WIDTH: return (m & F_SIZE) && now.size.x != before.size.x;
        case VariableField::HEIGHT: return (m & F_SIZE) && now.size.y != before.size.y;
        case VariableField::MIN_WIDTH: return (m & F_MIN_SIZE) && now.minSize.x != before.minSize.x;
        case VariableField::MAX_WIDTH: return (m & F_MAX_SIZE) && now.maxSize.x != before.maxSize.x;
        case VariableField::MIN_HEIGHT: return (m & F_MIN_SIZE) && now.minSize.y != before.minSize.y;
        case VariableField::MAX_HEIGHT: return (m & F_MAX_SIZE) && now.maxSize.y != before.maxSize.y;
        case VariableField::OPACITY: return (m & F_OPACITY) != 0;
        case VariableField::VISIBLE: return (m & F_VISIBLE) != 0;
        case VariableField::CORNER_RADIUS: return (m & F_CORNER_RADII) != 0;
        case VariableField::RECTANGLE_TOP_LEFT_CORNER_RADIUS: return (m & F_CORNER_RADII) && now.cornerRadii[0] != before.cornerRadii[0];
        case VariableField::RECTANGLE_TOP_RIGHT_CORNER_RADIUS: return (m & F_CORNER_RADII) && now.cornerRadii[1] != before.cornerRadii[1];
        case VariableField::RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS:
          return (m & F_CORNER_RADII) && now.cornerRadii[2] != before.cornerRadii[2];
        case VariableField::RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS:
          return (m & F_CORNER_RADII) && now.cornerRadii[3] != before.cornerRadii[3];
        case VariableField::STROKE_WEIGHT: return (m & F_STROKE_WEIGHT) != 0;
        case VariableField::BORDER_TOP_WEIGHT: return (m & F_BORDER_WEIGHTS) && now.borderWeights[0] != before.borderWeights[0];
        case VariableField::BORDER_RIGHT_WEIGHT: return (m & F_BORDER_WEIGHTS) && now.borderWeights[1] != before.borderWeights[1];
        case VariableField::BORDER_BOTTOM_WEIGHT: return (m & F_BORDER_WEIGHTS) && now.borderWeights[2] != before.borderWeights[2];
        case VariableField::BORDER_LEFT_WEIGHT: return (m & F_BORDER_WEIGHTS) && now.borderWeights[3] != before.borderWeights[3];
        case VariableField::STACK_SPACING: return (m & F_STACK_SPACING) != 0;
        case VariableField::STACK_COUNTER_SPACING: return (m & F_STACK_COUNTER_SPACING) != 0;
        case VariableField::STACK_PADDING_LEFT: return (m & F_STACK_PADDING_LEFT) != 0;
        case VariableField::STACK_PADDING_TOP: return (m & F_STACK_PADDING_TOP) != 0;
        case VariableField::STACK_PADDING_RIGHT: return (m & F_STACK_PADDING_RIGHT) != 0;
        case VariableField::STACK_PADDING_BOTTOM: return (m & F_STACK_PADDING_BOTTOM) != 0;
        case VariableField::TEXT_DATA: return (m & F_TEXT_DATA) && now.textData.characters != before.textData.characters;
        case VariableField::FONT_FAMILY: return (m & F_FONT_NAME) && now.fontName.family != before.fontName.family;
        case VariableField::FONT_STYLE: return (m & F_FONT_NAME) && now.fontName.style != before.fontName.style;
        case VariableField::FONT_SIZE: return (m & F_FONT_SIZE) != 0;
        case VariableField::LINE_HEIGHT: return (m & F_LINE_HEIGHT) != 0;
        case VariableField::LETTER_SPACING: return (m & F_LETTER_SPACING) != 0;
        case VariableField::PARAGRAPH_SPACING: return (m & F_PARAGRAPH_SPACING) != 0;
        case VariableField::PARAGRAPH_INDENT: return (m & F_PARAGRAPH_INDENT) != 0;
        default: return false;
      }
    };
    std::vector<ParamBinding> kept;
    bool dropped = false;
    for (const ParamBinding& b : before.parameterConsumptionMap) {
      if (b.isVariable() && changed(b.field)) dropped = true;
      else kept.push_back(b);
    }
    if (dropped) {
      c.mask |= F_PARAM_MAP;
      c.props.parameterConsumptionMap = std::move(kept);
    }
  }
  // Paints: a changed colour / opacity drops its binding.
  auto paints = [&](std::vector<Paint>& list, const std::vector<Paint>& old) {
    for (size_t i = 0; i < list.size() && i < old.size(); i++) {
      Paint& p = list[i];
      const Paint& o = old[i];
      if (p.colorVar.present() && p.colorVar == o.colorVar && !(p.color == o.color)) p.colorVar = {};
      if (p.opacityVar.present() && p.opacityVar == o.opacityVar && p.opacity != o.opacity) p.opacityVar = {};
      for (size_t s = 0; s < p.stopVars.size() && s < p.stops.size() && s < o.stops.size() && s < o.stopVars.size(); s++)
        if (p.stopVars[s].present() && p.stopVars[s] == o.stopVars[s] && !(p.stops[s].color == o.stops[s].color)) p.stopVars[s] = {};
    }
  };
  if (m & F_FILLS) paints(c.props.fillPaints, before.fillPaints);
  if (m & F_STROKES) paints(c.props.strokePaints, before.strokePaints);
  if (m & F_EFFECTS)
    for (size_t i = 0; i < c.props.effects.size() && i < before.effects.size(); i++) {
      Effect& e = c.props.effects[i];
      const Effect& o = before.effects[i];
      if (e.colorVar.present() && e.colorVar == o.colorVar && !(e.color == o.color)) e.colorVar = {};
      if (e.radiusVar.present() && e.radiusVar == o.radiusVar && e.radius != o.radius) e.radiusVar = {};
      if (e.spreadVar.present() && e.spreadVar == o.spreadVar && e.spread != o.spread) e.spreadVar = {};
      if (e.xVar.present() && e.xVar == o.xVar && e.offset.x != o.offset.x) e.xVar = {};
      if (e.yVar.present() && e.yVar == o.yVar && e.offset.y != o.offset.y) e.yVar = {};
    }
  if (m & F_LAYOUT_GRIDS)
    for (size_t i = 0; i < c.props.layoutGrids.size() && i < before.layoutGrids.size(); i++) {
      LayoutGrid& g = c.props.layoutGrids[i];
      const LayoutGrid& o = before.layoutGrids[i];
      if (g.numSectionsVar.present() && g.numSectionsVar == o.numSectionsVar && g.numSections != o.numSections) g.numSectionsVar = {};
      if (g.offsetVar.present() && g.offsetVar == o.offsetVar && g.offset != o.offset) g.offsetVar = {};
      if (g.sectionSizeVar.present() && g.sectionSizeVar == o.sectionSizeVar && g.sectionSize != o.sectionSize) g.sectionSizeVar = {};
      if (g.gutterSizeVar.present() && g.gutterSizeVar == o.gutterSizeVar && g.gutterSize != o.gutterSize) g.gutterSizeVar = {};
    }
  // Styles: values that no longer match detach the style.
  auto detach = [&](FieldMask valueBits, FieldMask styleBit, AssetId& out, const AssetId& was) {
    if ((m & valueBits) && was.present() && !(m & styleBit)) {
      out = AssetId{};
      c.mask |= styleBit;
    }
  };
  detach(F_FILLS, F_STYLE_ID_FILL, c.props.styleIdForFill, before.styleIdForFill);
  detach(F_STROKES, F_STYLE_ID_STROKE, c.props.styleIdForStrokeFill, before.styleIdForStrokeFill);
  detach(F_EFFECTS, F_STYLE_ID_EFFECT, c.props.styleIdForEffect, before.styleIdForEffect);
  detach(F_LAYOUT_GRIDS, F_STYLE_ID_GRID, c.props.styleIdForGrid, before.styleIdForGrid);
  if (before.type == NodeType::TEXT) detach(kTextStyleNodeFields, F_STYLE_ID_TEXT, c.props.styleIdForText, before.styleIdForText);
}

// ---- Reads ----------------------------------------------------------------------------------------

namespace {
const char* fieldTarget(VariableField f) { return enumName(f); }
}  // namespace

std::vector<Editor::BoundVariable> Editor::boundVariables(Guid node) const {
  std::vector<BoundVariable> out;
  const Node* n = doc_.get(node);
  if (!n) return out;
  const NodeProps& p = n->props;
  ModeContext ctx;
  ctx.consumer = node;
  auto add = [&](std::string target, const VariableData& d) {
    if (!d.present()) return;
    BoundVariable b;
    b.target = std::move(target);
    b.value = d;
    const VariableData* alias = &d;
    if (d.kind == VariableData::Kind::EXPRESSION && !d.args.empty()) alias = &d.args[0];
    if (d.kind == VariableData::Kind::FONT_STYLE)
      for (auto& a : d.args)
        if (a.kind == VariableData::Kind::ALIAS) {
          alias = &a;
          break;
        }
    if (alias->kind == VariableData::Kind::ALIAS) {
      b.variable = findVariable(alias->alias);
      if (b.variable == kNoGuid) b.variable = alias->alias.guid;
    }
    b.ok = resolveData(d, ctx, b.resolved, nullptr, 0);
    if (b.ok && b.target == "FONT_STYLE" && b.resolved.kind == Resolved::Kind::FLOAT) {
      b.resolved.kind = Resolved::Kind::STRING;
      b.resolved.s = styleForWeight(b.resolved.f, isItalicStyle(p.fontName.style));
    }
    out.push_back(std::move(b));
  };
  for (const ParamBinding& b : p.parameterConsumptionMap)
    if (b.isVariable()) add(fieldTarget(b.field), b.data);
  auto paints = [&](const char* list, const std::vector<Paint>& ps) {
    for (size_t i = 0; i < ps.size(); i++) {
      std::string base = std::string(list) + "[" + std::to_string(i) + "]";
      add(base + ".color", ps[i].colorVar);
      add(base + ".opacity", ps[i].opacityVar);
      for (size_t s = 0; s < ps[i].stopVars.size(); s++) add(base + ".stops[" + std::to_string(s) + "].color", ps[i].stopVars[s]);
    }
  };
  paints("fillPaints", p.fillPaints);
  paints("strokePaints", p.strokePaints);
  for (size_t i = 0; i < p.effects.size(); i++) {
    std::string base = "effects[" + std::to_string(i) + "]";
    const Effect& e = p.effects[i];
    add(base + ".color", e.colorVar);
    add(base + ".radius", e.radiusVar);
    add(base + ".spread", e.spreadVar);
    add(base + ".x", e.xVar);
    add(base + ".y", e.yVar);
  }
  for (size_t i = 0; i < p.layoutGrids.size(); i++) {
    std::string base = "layoutGrids[" + std::to_string(i) + "]";
    const LayoutGrid& g = p.layoutGrids[i];
    add(base + ".numSections", g.numSectionsVar);
    add(base + ".offset", g.offsetVar);
    add(base + ".sectionSize", g.sectionSizeVar);
    add(base + ".gutterSize", g.gutterSizeVar);
  }
  return out;
}

bool Editor::resolvedValue(Guid node, const std::string& target, Resolved& out) const {
  for (auto& b : boundVariables(node))
    if (b.target == target) {
      if (!b.ok) return false;
      out = b.resolved;
      return true;
    }
  return false;
}

}  // namespace eng
