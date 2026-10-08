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
#include <cstdio>

#include "base/DerivedIds.h"
#include "base/FractionalIndex.h"
#include "editor/Editor.h"
#include "kiwi.h"
#include "text/TextEdit.h"
#include "scene/CodecKiwi.h"
#include "schema/SchemaTable.h"

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

// A number as Figma prints it in a string context (variant values, concatenation): no trailing zeros.
std::string numberText(double v) {
  if (!std::isfinite(v)) return "0";
  if (std::fabs(v - std::round(v)) < 1e-9 && std::fabs(v) < 1e15) return std::to_string(static_cast<long long>(std::llround(v)));
  char buf[32];
  std::snprintf(buf, sizeof buf, "%.6g", v);
  return buf;
}

bool isItalicStyle(const std::string& style) { return style.find("Italic") != std::string::npos; }

// Grid gaps (gridRowGap / gridColumnGap) are unmodelled fields (layout/GridLayout.cpp reads them from NodeProps::extra):
// a bound one is written there, as the kiwi bytes of its field.
constexpr uint32_t kGridRowGapId = 437, kGridColumnGapId = 438;
void setExtraFloat(NodeProps& p, const char* key, uint32_t id, double v) {
  schema::Out o;
  o.varuint(id);
  o.varfloat(static_cast<float>(v));
  p.extra[key] = o.s;
}
double extraFloat(const NodeProps& p, const char* key, uint32_t id) {
  auto it = p.extra.find(key);
  if (it == p.extra.end() || it->second.empty()) return 0;
  kiwi::ByteBuffer bb(reinterpret_cast<const uint8_t*>(it->second.data()), it->second.size());
  uint32_t f = 0;
  float v = 0;
  if (!bb.readVarUint(f) || f != id || !bb.readVarFloat(v) || !std::isfinite(v)) return 0;
  return v;
}

// The FLOAT a node field binding takes, written into `p`.
void setFloatField(NodeProps& p, VariableField f, double v) {
  switch (f) {
    case VariableField::WIDTH: p.size.x = nonNegative(v); break;
    case VariableField::HEIGHT: p.size.y = nonNegative(v); break;
    case VariableField::MIN_WIDTH: p.rare().minSize.x = nonNegative(v); break;
    case VariableField::MAX_WIDTH: p.rare().maxSize.x = nonNegative(v); break;
    case VariableField::MIN_HEIGHT: p.rare().minSize.y = nonNegative(v); break;
    case VariableField::MAX_HEIGHT: p.rare().maxSize.y = nonNegative(v); break;
    case VariableField::OPACITY: p.opacity = clamp01(v / 100); break;  // a number bound to opacity is a percentage (R3-49)
    case VariableField::CORNER_RADIUS: p.cornerRadii = {nonNegative(v), nonNegative(v), nonNegative(v), nonNegative(v)}; break;
    case VariableField::RECTANGLE_TOP_LEFT_CORNER_RADIUS: p.cornerRadii[0] = nonNegative(v); break;
    case VariableField::RECTANGLE_TOP_RIGHT_CORNER_RADIUS: p.cornerRadii[1] = nonNegative(v); break;
    case VariableField::RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: p.cornerRadii[2] = nonNegative(v); break;
    case VariableField::RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: p.cornerRadii[3] = nonNegative(v); break;
    case VariableField::STROKE_WEIGHT: p.strokeWeight = nonNegative(v); break;
    case VariableField::BORDER_TOP_WEIGHT: p.stroke().borderWeights[0] = nonNegative(v); break;
    case VariableField::BORDER_RIGHT_WEIGHT: p.stroke().borderWeights[1] = nonNegative(v); break;
    case VariableField::BORDER_BOTTOM_WEIGHT: p.stroke().borderWeights[2] = nonNegative(v); break;
    case VariableField::BORDER_LEFT_WEIGHT: p.stroke().borderWeights[3] = nonNegative(v); break;
    case VariableField::STACK_SPACING: p.stack().stackSpacing = std::isfinite(v) ? v : 0; break;
    case VariableField::STACK_COUNTER_SPACING: p.stack().stackCounterSpacing = std::isfinite(v) ? v : 0; break;
    case VariableField::STACK_PADDING_LEFT: p.stack().stackPaddingLeft = nonNegative(v); break;
    case VariableField::STACK_PADDING_TOP: p.stack().stackPaddingTop = nonNegative(v); break;
    case VariableField::STACK_PADDING_RIGHT: p.stack().stackPaddingRight = nonNegative(v); break;
    case VariableField::STACK_PADDING_BOTTOM: p.stack().stackPaddingBottom = nonNegative(v); break;
    case VariableField::FONT_SIZE:
      if (std::isfinite(v) && v >= 1) p.text().fontSize = v;
      break;
    case VariableField::LINE_HEIGHT:
      // The node's units: RAW is the UI's percentage; Auto becomes pixels.
      if (!std::isfinite(v)) break;
      if (p.text().lineHeight.units == NumberUnits::RAW) p.text().lineHeight.value = v / 100;
      else p.text().lineHeight = {v, NumberUnits::PIXELS};
      break;
    case VariableField::LETTER_SPACING:
      if (std::isfinite(v)) p.text().letterSpacing.value = v;
      break;
    case VariableField::PARAGRAPH_SPACING: p.text().paragraphSpacing = nonNegative(v); break;
    case VariableField::PARAGRAPH_INDENT: p.text().paragraphIndent = nonNegative(v); break;
    case VariableField::GRID_ROW_GAP: setExtraFloat(p, "gridRowGap", kGridRowGapId, nonNegative(v)); break;
    case VariableField::GRID_COLUMN_GAP: setExtraFloat(p, "gridColumnGap", kGridColumnGapId, nonNegative(v)); break;
    default: break;  // FONT_VARIATIONS: kept as data (not modelled)
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
    if (n.guid.isDerived() || n.props.asset().key.empty()) return;
    const NodeProps& p = n.props;
    if (p.type != NodeType::VARIABLE && p.type != NodeType::VARIABLE_SET && !p.isStyle()) return;
    auto it = assetKeys_.find(p.asset().key);
    // Prefer a live asset over a deleted one with the same key.
    if (it == assetKeys_.end() || (doc_.get(it->second)->props.comp().isSoftDeleted && !p.comp().isSoftDeleted)) assetKeys_[p.asset().key] = n.guid;
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
  if (n->props.asset().styleType != type) return nullptr;
  return &n->props;
}

namespace {
// Assets in the panels' order: sortPosition, then their place under the internal canvas, then id (one sort, shared).
__attribute__((noinline)) void sortAssets(const Document& doc, std::vector<Guid>& ids) {
  std::sort(ids.begin(), ids.end(), [&](Guid ga, Guid gb) {
    const NodeProps& a = doc.get(ga)->props;
    const NodeProps& b = doc.get(gb)->props;
    if (a.asset().sortPosition != b.asset().sortPosition) return a.asset().sortPosition < b.asset().sortPosition;
    if (a.parentIndex.position != b.parentIndex.position) return a.parentIndex.position < b.parentIndex.position;
    return ga < gb;
  });
}
}  // namespace

// Collections, variables and styles come from the ids kept as they are written (noteBindings), not from a walk
// over the whole document: the panels ask for them on every selection change and every frame of a drag.
std::vector<Guid> Editor::collections(bool includeRemote) const {
  std::vector<Guid> out;
  for (Guid g : collectionIds_) {
    const Node* n = doc_.get(g);
    if (n && n->props.type == NodeType::VARIABLE_SET && !n->props.comp().isSoftDeleted && !g.isDerived() && (includeRemote || !isLibraryCopy(g)))
      out.push_back(g);
  }
  sortAssets(doc_, out);
  return out;
}

std::vector<Guid> Editor::variablesOf(Guid collection, bool includeDeleted) const {
  std::vector<Guid> out;
  const Node* set = doc_.get(collection);
  for (const auto& [g, s0] : variableSets_) {
    const Node* n = doc_.get(g);
    if (!n || n->props.type != NodeType::VARIABLE || g.isDerived() || (n->props.comp().isSoftDeleted && !includeDeleted)) continue;
    const AssetId& s = n->props.asset().variableSetID;
    bool mine = collection == kNoGuid || s.guid == collection || (set && !s.key.empty() && s.key == set->props.asset().key);
    if (mine) out.push_back(g);
  }
  sortAssets(doc_, out);
  return out;
}

std::vector<Guid> Editor::stylesOf(StyleType type, bool includeRemote) const {
  std::vector<Guid> out;
  for (Guid g : styleIds_) {
    const Node* np = doc_.get(g);
    if (!np) continue;
    const Node& n = *np;
    if (!n.props.isStyle() || n.guid.isDerived() || n.props.comp().isSoftDeleted) continue;
    if (!includeRemote && isLibraryCopy(n.guid)) continue;
    if (type == StyleType::NONE || n.props.asset().styleType == type) out.push_back(n.guid);
  }
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
    for (const AssetId* id : {&p.refs().styleIdForFill, &p.refs().styleIdForStrokeFill, &p.refs().styleIdForText, &p.refs().styleIdForEffect, &p.refs().styleIdForGrid})
      if (id->present() && (id->guid == style || (!id->key.empty() && id->key == s->props.asset().key))) {
        count++;
        break;
      }
  });
  return count;
}

// ---- Extended collections ------------------------------------------------------------------------
//
// Figma's extended collections (docs/research/figma/R3-variables.md R3-32/33): a VARIABLE_SET whose modes each name
// the collection they extend and its mode (VariableSetMode.parentVariableSetId / parentModeId). It inherits the
// parent's variables, names, scopes and order; only values are overridden — per variable, a VARIABLE_OVERRIDE node
// (a child of the extended collection; overriddenVariableId = the root collection's variable) holding values for the
// extension's modes. A layer uses one by its mode: the explicit-mode entry of the root collection naming the
// extension (variableSetExtensionID) and one of its modes ("one mode value per collection", Figma).

Guid Editor::extensionParent(Guid set) const {
  const Node* n = doc_.get(set);
  if (!n || n->props.type != NodeType::VARIABLE_SET) return kNoGuid;
  for (const VariableSetMode& m : n->props.asset().variableSetModes)
    if (m.parentSet.present()) {
      Guid p = findCollection(m.parentSet);
      if (p != kNoGuid && p != set) return p;
    }
  return kNoGuid;
}

Guid Editor::rootCollection(Guid set) const {
  Guid cur = set;
  for (int guard = 0; guard < 16; guard++) {
    Guid up = extensionParent(cur);
    if (up == kNoGuid) return cur;
    cur = up;
  }
  return cur;
}

Guid Editor::overrideNode(Guid extension, Guid variable) const {
  auto s = overridesBySet_.find(extension);
  if (s == overridesBySet_.end()) return kNoGuid;
  auto v = s->second.find(variable);
  return v == s->second.end() || !doc_.has(v->second) ? kNoGuid : v->second;
}

std::vector<Guid> Editor::extensionsOf(Guid set) const {
  std::vector<Guid> out;
  for (Guid c : collectionIds_)
    if (c != set && doc_.has(c) && extensionParent(c) == set) out.push_back(c);
  std::sort(out.begin(), out.end());
  return out;
}

Guid Editor::collectionOfMode(Guid set, Guid mode) const {
  auto has = [&](Guid c) {
    const Node* n = doc_.get(c);
    if (!n) return false;
    for (const VariableSetMode& m : n->props.asset().variableSetModes)
      if (m.id == mode) return true;
    return false;
  };
  if (has(set)) return set;
  // Extensions of the root, breadth first (a chain C → B → A).
  std::vector<Guid> queue{rootCollection(set)};
  for (size_t i = 0; i < queue.size() && i < 256; i++) {
    if (has(queue[i])) return queue[i];
    for (Guid e : extensionsOf(queue[i])) queue.push_back(e);
  }
  return kNoGuid;
}

void Editor::indexOverride(Guid node) {
  if (auto old = overrideIndex_.find(node); old != overrideIndex_.end()) {
    auto s = overridesBySet_.find(old->second.first);
    if (s != overridesBySet_.end()) {
      auto v = s->second.find(old->second.second);
      if (v != s->second.end() && v->second == node) s->second.erase(v);
      if (s->second.empty()) overridesBySet_.erase(s);
    }
    overrideIndex_.erase(old);
  }
  const Node* n = doc_.get(node);
  if (!n || n->props.type != NodeType::VARIABLE_OVERRIDE) return;
  Guid ext = findCollection(n->props.asset().variableSetID);
  if (ext == kNoGuid) ext = n->props.asset().variableSetID.guid;
  if (ext == kNoGuid) ext = n->props.parentIndex.guid;
  Guid var = findVariable(n->props.asset().overriddenVariableId);
  if (var == kNoGuid) var = n->props.asset().overriddenVariableId.guid;
  if (ext == kNoGuid || var == kNoGuid) return;
  overridesBySet_[ext][var] = node;
  overrideIndex_[node] = {ext, var};
}

void Editor::syncExtensions() {
  // An extended collection inherits its parent's modes: one per parent mode (its name and order), new ones added; a
  // mode whose parent mode is gone stays (Figma: removable only then) after the others. Local extensions only (a
  // library's come with its updates).
  for (int pass = 0; pass < 8 && !extensionSyncDirty_.empty(); pass++) {
    std::vector<Guid> parents(extensionSyncDirty_.begin(), extensionSyncDirty_.end());
    extensionSyncDirty_.clear();
    std::sort(parents.begin(), parents.end());
    for (Guid parent : parents) {
      const Node* pn = doc_.get(parent);
      if (!pn || pn->props.type != NodeType::VARIABLE_SET) continue;
      std::vector<VariableSetMode> parentModes = pn->props.orderedModes();
      for (Guid ext : extensionsOf(parent)) {
        if (isLibraryCopy(ext)) continue;
        const NodeProps& ep = doc_.get(ext)->props;
        std::vector<VariableSetMode> next;
        AssetId parentRef = AssetId::of(parent);
        for (const VariableSetMode& m : ep.asset().variableSetModes)
          if (m.parentSet.present() && findCollection(m.parentSet) == parent) parentRef = m.parentSet;
        for (const VariableSetMode& pm : parentModes) {
          VariableSetMode mine;
          bool found = false;
          for (const VariableSetMode& m : ep.asset().variableSetModes)
            if (m.parentMode == pm.id) mine = m, found = true;
          if (!found) {
            mine.id = newGuid();
            mine.parentSet = parentRef;
            mine.parentMode = pm.id;
          }
          mine.name = pm.name;
          mine.sortPosition = pm.sortPosition;
          next.push_back(std::move(mine));
        }
        std::string last = next.empty() ? std::string() : next.back().sortPosition;
        for (const VariableSetMode& m : ep.orderedModes()) {
          bool live = false;
          for (const VariableSetMode& pm : parentModes) live |= pm.id == m.parentMode;
          if (live) continue;
          VariableSetMode orphan = m;
          std::string k = fractional::keyBetween(last, std::nullopt, fractional::Bias::Low);
          if (!k.empty()) orphan.sortPosition = last = k;
          next.push_back(std::move(orphan));
        }
        if (next == ep.asset().variableSetModes) continue;
        NodeChange c = NodeChange::changed(ext);
        c.mask = F_VARIABLE_SET_MODES;
        c.props.asset().variableSetModes = std::move(next);
        bool prev = resolving_;
        resolving_ = false;  // its own extensions follow in turn (noteBindings)
        write(c);
        resolving_ = prev;
      }
    }
  }
}

// ---- Resolution ---------------------------------------------------------------------------------

Guid Editor::modeFor(const ModeContext& ctx, Guid set, Guid* extension) const {
  if (extension) *extension = kNoGuid;
  const Node* sn = doc_.get(set);
  if (!sn) return kNoGuid;
  const NodeProps& sp = sn->props;
  auto valid = [&](const NodeProps& c, Guid mode) {
    for (auto& m : c.asset().variableSetModes)
      if (m.id == mode) return true;
    return false;
  };
  // An extended collection of `set` and one of its modes.
  auto extensionMode = [&](Guid ext, Guid mode) {
    if (ext == kNoGuid || ext == set || rootCollection(ext) != set) return false;
    const Node* en = doc_.get(ext);
    if (!en || !valid(en->props, mode)) return false;
    if (extension) *extension = ext;
    return true;
  };
  if (ctx.forcedSet != kNoGuid && ctx.forcedMode != kNoGuid) {
    if (ctx.forcedSet == set && valid(sp, ctx.forcedMode)) return ctx.forcedMode;
    if (extensionMode(ctx.forcedSet, ctx.forcedMode)) return ctx.forcedMode;
  }
  // The nearest explicit mode for this collection: the node, then its ancestors (pages included; an instance's
  // sublayers go through the instance). A mode the collection no longer has counts as Auto.
  const NodeProps* p = ctx.self;
  Guid cur = ctx.consumer;
  auto lookup = [&](Guid g) -> const NodeProps* {
    if (ctx.pending)
      if (const NodeProps* q = ctx.pending(g)) return q;
    const Node* n = doc_.get(g);
    return n ? &n->props : nullptr;
  };
  if (!p && cur != kNoGuid) p = lookup(cur);
  const std::string& key = sp.asset().key;
  for (int guard = 0; p && guard < 4096; guard++) {
    for (const VariableModeEntry& e : p->refs().variableModeBySetMap) {
      if (!((e.set.guid != kNoGuid && e.set.guid == set) || (!key.empty() && e.set.key == key))) continue;
      if (e.extension.present()) {
        if (extensionMode(findCollection(e.extension), e.mode)) return e.mode;
      } else if (e.mode != kNoGuid && valid(sp, e.mode)) {
        return e.mode;
      }
      break;  // one mode value per collection: a stale one is Auto
    }
    Guid up = p->parentIndex.guid;
    // Slot content (Figma's form, under the Internal Only Canvas): on through the slot that shows it.
    if (p->comp().isSlotContent)
      if (auto h = slotHosts_.find(cur); h != slotHosts_.end() && doc_.has(h->second)) up = h->second;
    const NodeProps* parent = up != kNoGuid && up != cur ? lookup(up) : nullptr;
    if (!parent) break;
    cur = up;
    p = parent;
  }
  return sp.defaultMode();
}

const VariableModeValue* Editor::valueInMode(Guid variable, const NodeProps& vp, Guid set, Guid mode, Guid extension,
                                             BindingDeps* deps) const {
  // Up the extension chain: each extension's override for its mode, else its parent's mode.
  Guid ext = extension;
  for (int guard = 0; ext != kNoGuid && ext != set && guard < 16; guard++) {
    if (deps) deps->sets.push_back(ext);
    if (Guid o = overrideNode(ext, variable); o != kNoGuid)
      for (const VariableModeValue& v : doc_.get(o)->props.asset().variableDataValues)
        if (v.modeID == mode) return &v;
    const Node* en = doc_.get(ext);
    Guid parentMode = kNoGuid, parent = kNoGuid;
    if (en)
      for (const VariableSetMode& m : en->props.asset().variableSetModes)
        if (m.id == mode) parentMode = m.parentMode, parent = findCollection(m.parentSet);
    if (parent == kNoGuid || parentMode == kNoGuid) {
      mode = kNoGuid;  // its parent mode is gone: the default
      break;
    }
    mode = parentMode;
    ext = parent;
  }
  const VariableModeValue* value = nullptr;
  for (auto& v : vp.asset().variableDataValues)
    if (v.modeID == mode && mode != kNoGuid) value = &v;
  if (!value && set != kNoGuid) {
    // A missing entry falls back to the default mode's value (docs/schema.md §4.6).
    Guid def = doc_.get(set)->props.defaultMode();
    for (auto& v : vp.asset().variableDataValues)
      if (v.modeID == def) value = &v;
  }
  if (!value && !vp.asset().variableDataValues.empty()) value = &vp.asset().variableDataValues.front();
  return value;
}

bool Editor::resolveVar(Guid variable, const ModeContext& ctx, Resolved& out, BindingDeps* deps, int depth) const {
  if (depth > kMaxAliasDepth) return false;
  const Node* vn = doc_.get(variable);
  if (!vn || vn->props.type != NodeType::VARIABLE) return false;
  const NodeProps& vp = vn->props;
  Guid set = findCollection(vp.asset().variableSetID);
  if (deps) deps->sets.push_back(set != kNoGuid ? set : vp.asset().variableSetID.guid);
  Guid mode = kNoGuid, extension = kNoGuid;
  if (set != kNoGuid) mode = modeFor(ctx, set, &extension);
  const VariableModeValue* value = valueInMode(variable, vp, set, mode, extension, deps);
  if (!value) return false;
  if (!resolveData(value->data, ctx, out, deps, depth + 1)) return false;
  // The value must be of the variable's type.
  switch (vp.asset().variableResolvedType) {
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
      if (d.function == ExpressionFunction::COMPOSE_COLOR) {
        if (d.args.size() < 2) return false;
        // "Control opacity at scale": the colour (literal or alias) with the opacity (a percentage, literal or alias).
        Resolved color, opacity;
        if (!resolveData(d.args[0], ctx, color, deps, depth + 1) || color.kind != Resolved::Kind::COLOR) return false;
        if (!resolveData(d.args[1], ctx, opacity, deps, depth + 1) || opacity.kind != Resolved::Kind::FLOAT) return false;
        out = color;
        out.c.a = static_cast<float>(clamp01(opacity.f / 100));
        return true;
      }
      if (d.function == ExpressionFunction::RESOLVE_VARIANT) return false;  // a variant (variantFor), not a value
      if (d.function == ExpressionFunction::VAR_MODE_LOOKUP) {
        // A variable's value in a mode named explicitly (help.figma.com 15253268379799: "variableName:modeName"):
        // [ALIAS variable, STRING the mode's id "s:l"] — the argument encoding is ours (Figma's isn't published).
        if (d.args.size() < 2 || d.args[0].kind != K::ALIAS) return false;
        Guid v = findVariable(d.args[0].alias);
        if (deps) deps->vars.push_back(v != kNoGuid ? v : d.args[0].alias.guid);
        const Node* vn = v != kNoGuid ? doc_.get(v) : nullptr;
        if (!vn) return false;
        bool ok = false;
        Guid mode = d.args[1].kind == K::TEXT ? Guid::parse(d.args[1].textValue, &ok) : kNoGuid;
        if (!ok || mode == kNoGuid) return resolveVar(v, ctx, out, deps, depth + 1);
        ModeContext forced = ctx;
        forced.forcedSet = findCollection(vn->props.asset().variableSetID);
        forced.forcedMode = mode;
        return resolveVar(v, forced, out, deps, depth + 1);
      }
      // Figma's expressions (R3-34; a boolean bound to visibility is IS_TRUTHY(alias) in Figma's files).
      std::vector<Resolved> a(d.args.size());
      for (size_t i = 0; i < d.args.size(); i++)
        if (!resolveData(d.args[i], ctx, a[i], deps, depth + 1)) return false;
      auto truthy = [](const Resolved& r) {
        switch (r.kind) {
          case Resolved::Kind::BOOL: return r.b;
          case Resolved::Kind::FLOAT: return r.f != 0;
          case Resolved::Kind::STRING: return !r.s.empty();
          case Resolved::Kind::COLOR: return true;
          default: return false;
        }
      };
      auto text = [](const Resolved& r) {
        if (r.kind == Resolved::Kind::STRING) return r.s;
        if (r.kind == Resolved::Kind::BOOL) return std::string(r.b ? "true" : "false");
        if (r.kind == Resolved::Kind::FLOAT) return numberText(r.f);
        return std::string();
      };
      auto boolean = [&](bool v) {
        out.kind = Resolved::Kind::BOOL;
        out.b = v;
        return true;
      };
      auto number = [&](double v) {
        out.kind = Resolved::Kind::FLOAT;
        out.f = v;
        return std::isfinite(v);
      };
      auto floats = [&](size_t n) {
        if (a.size() < n) return false;
        for (size_t i = 0; i < n; i++)
          if (a[i].kind != Resolved::Kind::FLOAT) return false;
        return true;
      };
      auto same = [&]() {
        if (a.size() < 2) return false;
        if (a[0].kind != a[1].kind) {
          // A string against a number or boolean: their text (the prototype's `count == "3"`); a boolean against a
          // number: as 1 / 0.
          if (a[0].kind == Resolved::Kind::STRING || a[1].kind == Resolved::Kind::STRING) return text(a[0]) == text(a[1]);
          auto num = [](const Resolved& r, double& v) {
            if (r.kind == Resolved::Kind::FLOAT) v = r.f;
            else if (r.kind == Resolved::Kind::BOOL) v = r.b ? 1 : 0;
            else return false;
            return true;
          };
          double x, y;
          return num(a[0], x) && num(a[1], y) && x == y;
        }
        switch (a[0].kind) {
          case Resolved::Kind::BOOL: return a[0].b == a[1].b;
          case Resolved::Kind::FLOAT: return a[0].f == a[1].f;
          case Resolved::Kind::STRING: return a[0].s == a[1].s;
          case Resolved::Kind::COLOR: return a[0].c == a[1].c;
          default: return false;
        }
      };
      using F = ExpressionFunction;
      switch (d.function) {
        case F::IS_TRUTHY: return !a.empty() && boolean(truthy(a[0]));
        case F::NOT: return !a.empty() && boolean(!truthy(a[0]));
        // AND / OR / ADDITION / MULTIPLY take any number of arguments (Figma stores `a and b and c` as one call).
        case F::AND: {
          if (a.size() < 2) return false;
          bool v = true;
          for (const Resolved& x : a) v = v && truthy(x);
          return boolean(v);
        }
        case F::OR: {
          if (a.size() < 2) return false;
          bool v = false;
          for (const Resolved& x : a) v = v || truthy(x);
          return boolean(v);
        }
        case F::EQUALS: return a.size() >= 2 && boolean(same());
        case F::NOT_EQUAL: return a.size() >= 2 && boolean(!same());
        case F::LESS_THAN: return floats(2) && boolean(a[0].f < a[1].f);
        case F::LESS_THAN_OR_EQUAL: return floats(2) && boolean(a[0].f <= a[1].f);
        case F::GREATER_THAN: return floats(2) && boolean(a[0].f > a[1].f);
        case F::GREATER_THAN_OR_EQUAL: return floats(2) && boolean(a[0].f >= a[1].f);
        case F::ADDITION: {
          if (a.size() < 2) return false;
          if (floats(a.size())) {
            double sum = 0;
            for (const Resolved& x : a) sum += x.f;
            return number(sum);
          }
          std::string joined;  // string concatenation
          for (const Resolved& x : a) joined += text(x);
          out.kind = Resolved::Kind::STRING;
          out.s = std::move(joined);
          return true;
        }
        case F::SUBTRACTION: return floats(2) && number(a[0].f - a[1].f);
        case F::MULTIPLY: {
          if (a.size() < 2 || !floats(a.size())) return false;
          double product = 1;
          for (const Resolved& x : a) product *= x.f;
          return number(product);
        }
        case F::DIVIDE: return floats(2) && a[1].f != 0 && number(a[0].f / a[1].f);
        case F::NEGATE: return floats(1) && number(-a[0].f);
        case F::STRINGIFY:
          if (a.empty()) return false;
          out.kind = Resolved::Kind::STRING;
          out.s = text(a[0]);
          return true;
        case F::TERNARY:
          if (a.size() < 3) return false;
          out = truthy(a[0]) ? a[1] : a[2];
          return true;
        default: return false;
      }
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
        // The literal VariableData as JSON members (its unmodelled fields, and its value's).
        out.raw = codec::extraToJsonMembers("VariableData", d.extra);
        if (!d.valueExtra.empty()) {
          if (!out.raw.empty()) out.raw += ",";
          out.raw += "\"value\":{" + codec::extraToJsonMembers("VariableAnyValue", d.valueExtra) + "}";
        }
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

bool Editor::resolveValue(const VariableData& d, Guid consumer, Resolved& out) const {
  ModeContext ctx;
  ctx.consumer = consumer;
  return resolveData(d, ctx, out, nullptr, 0);
}

bool Editor::resolveVariableInMode(Guid variable, Guid mode, Resolved& out) const {
  const Node* vn = doc_.get(variable);
  if (!vn) return false;
  ModeContext ctx;
  Guid set = findCollection(vn->props.asset().variableSetID);
  // A mode of an extended collection of it: the extension's value there.
  Guid owner = set != kNoGuid ? collectionOfMode(set, mode) : kNoGuid;
  ctx.forcedSet = owner != kNoGuid ? owner : set;
  ctx.forcedMode = mode;
  return resolveVar(variable, ctx, out, nullptr, 0);
}

Guid Editor::variantFor(Guid main, const VariableData& binding, const ModeContext& ctx, BindingDeps* deps) const {
  // RESOLVE_VARIANT(MAP {property name / def id → value}) (Figma's files; "Assign variable" on a variant property): the
  // variant whose values for the bound properties are the variables' values in the consumer's modes — a string, a
  // number as text, a boolean as true / false (Figma: "the variable's value must match the variant property's
  // values"; compared case-insensitively when no variant matches exactly) — keeping the most of the other values.
  if (binding.kind != VariableData::Kind::EXPRESSION || binding.function != ExpressionFunction::RESOLVE_VARIANT || binding.args.empty())
    return kNoGuid;
  const VariableData& map = binding.args[0];
  if (map.kind != VariableData::Kind::MAP) return kNoGuid;
  Guid set = setOf(main);
  const Node* setNode = doc_.get(set);
  if (!setNode) return kNoGuid;
  const auto& defs = setNode->props.comp().componentPropDefs;
  std::map<Guid, std::string> want;
  for (size_t i = 0; i < map.args.size(); i++) {
    Guid def = i < map.mapGuidKeys.size() ? map.mapGuidKeys[i] : kNoGuid;
    bool known = false;
    for (const ComponentPropDef& d : defs) known |= d.id == def && d.type == ComponentPropType::VARIANT;
    if (!known && i < map.mapKeys.size())
      for (const ComponentPropDef& d : defs)
        if (d.type == ComponentPropType::VARIANT && d.name == map.mapKeys[i]) def = d.id, known = true;
    if (!known) continue;
    Resolved r;
    if (!resolveData(map.args[i], ctx, r, deps, 0)) continue;
    if (r.kind == Resolved::Kind::STRING) want[def] = r.s;
    else if (r.kind == Resolved::Kind::FLOAT) want[def] = numberText(r.f);
    else if (r.kind == Resolved::Kind::BOOL) want[def] = r.b ? "true" : "false";
  }
  if (want.empty()) return kNoGuid;
  auto lower = [](std::string s) {
    for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
  };
  std::map<Guid, std::string> now;
  if (const Node* mn = doc_.get(main))
    for (const VariantPropSpec& s : mn->props.comp().variantPropSpecs) now[s.propDefId] = s.value;
  Guid best = kNoGuid;
  int bestScore = -1;
  for (int pass = 0; pass < 2 && best == kNoGuid; pass++) {
    for (Guid v : doc_.children(set)) {
      const Node* vn = doc_.get(v);
      if (!vn || vn->props.type != NodeType::SYMBOL) continue;
      std::map<Guid, std::string> vals;
      for (const VariantPropSpec& s : vn->props.comp().variantPropSpecs) vals[s.propDefId] = s.value;
      bool ok = true;
      for (auto& [k, val] : want) ok &= pass == 0 ? vals[k] == val : lower(vals[k]) == lower(val);
      if (!ok) continue;
      int score = 0;
      for (auto& [k, val] : now)
        if (!want.count(k) && vals[k] == val) score++;
      if (v == main) score++;  // ties keep the current one
      if (score > bestScore) best = v, bestScore = score;
    }
  }
  return best;
}

Guid Editor::resolvedMode(Guid node, Guid set) const {
  ModeContext ctx;
  ctx.consumer = node;
  // An extended collection: its mode when the node uses it, else its mode inheriting the root's resolved one.
  Guid root = rootCollection(set);
  Guid ext = kNoGuid;
  Guid mode = modeFor(ctx, root, &ext);
  if (ext == set) return mode;
  if (root == set) {
    // The extension's mode → its parent's, down to the root's.
    for (Guid cur = ext; cur != kNoGuid && cur != root;) {
      Guid next = kNoGuid, up = kNoGuid;
      if (const Node* en = doc_.get(cur))
        for (const VariableSetMode& m : en->props.asset().variableSetModes)
          if (m.id == mode) next = m.parentMode, up = findCollection(m.parentSet);
      if (next == kNoGuid) return doc_.get(root)->props.defaultMode();
      mode = next;
      cur = up;
    }
    return mode;
  }
  // The extension's mode whose parent chain leads to `mode` of the root.
  std::vector<Guid> chain;
  for (Guid cur = set; cur != kNoGuid && cur != root && chain.size() < 16; cur = extensionParent(cur)) chain.push_back(cur);
  Guid want = mode;
  for (size_t i = chain.size(); i-- > 0;) {
    Guid next = kNoGuid;
    if (const Node* en = doc_.get(chain[i]))
      for (const VariableSetMode& m : en->props.asset().variableSetModes)
        if (m.parentMode == want) next = m.id;
    if (next == kNoGuid) return doc_.has(set) ? doc_.get(set)->props.defaultMode() : kNoGuid;
    want = next;
  }
  return want;
}

Guid Editor::explicitModeOf(Guid node, Guid set) const {
  const Node* n = doc_.get(node);
  if (!n) return kNoGuid;
  Guid root = rootCollection(set);
  const Node* rn = doc_.get(root);
  const std::string key = rn ? rn->props.asset().key : std::string();
  for (const VariableModeEntry& e : n->props.refs().variableModeBySetMap) {
    if (!((e.set.guid != kNoGuid && e.set.guid == root) || (!key.empty() && e.set.key == key))) continue;
    Guid ext = e.extension.present() ? findCollection(e.extension) : kNoGuid;
    if ((ext == kNoGuid ? root : ext) != set) return kNoGuid;
    const Node* sn = doc_.get(set);
    if (!sn) return kNoGuid;
    for (const VariableSetMode& m : sn->props.asset().variableSetModes)
      if (m.id == e.mode) return e.mode;
    return kNoGuid;
  }
  return kNoGuid;
}

const VariableData* Editor::valueForMode(Guid variable, Guid mode, bool* overridden) const {
  if (overridden) *overridden = false;
  const Node* vn = doc_.get(variable);
  if (!vn || vn->props.type != NodeType::VARIABLE) return nullptr;
  Guid set = findCollection(vn->props.asset().variableSetID);
  Guid owner = set != kNoGuid ? collectionOfMode(set, mode) : kNoGuid;
  if (owner != kNoGuid && owner != set && overridden)
    if (Guid o = overrideNode(owner, variable); o != kNoGuid)
      for (const VariableModeValue& v : doc_.get(o)->props.asset().variableDataValues) *overridden |= v.modeID == mode;
  const VariableModeValue* v = valueInMode(variable, vn->props, set, mode, owner != set ? owner : kNoGuid, nullptr);
  return v ? &v->data : nullptr;
}

FieldMask Editor::boundFieldMask(const NodeProps& p) {
  FieldMask m = 0;
  if (p.refs().styleIdForFill.present()) m |= F_FILLS;
  if (p.refs().styleIdForStrokeFill.present()) m |= F_STROKES;
  if (p.refs().styleIdForEffect.present()) m |= F_EFFECTS;
  if (p.refs().styleIdForGrid.present()) m |= F_LAYOUT_GRIDS;
  if (p.refs().styleIdForText.present() && p.type == NodeType::TEXT) m |= kTextStyleNodeFields;
  for (const ParamBinding& b : p.parameterConsumptionMap) {
    if (!b.isVariable()) continue;
    switch (b.field) {
      case VariableField::WIDTH: case VariableField::HEIGHT: m |= F_SIZE; break;
      case VariableField::MIN_WIDTH: case VariableField::MIN_HEIGHT: m |= F_MIN_SIZE; break;
      case VariableField::MAX_WIDTH: case VariableField::MAX_HEIGHT: m |= F_MAX_SIZE; break;
      case VariableField::OPACITY: m |= F_OPACITY; break;
      case VariableField::CORNER_RADIUS: m |= F_CORNER_RADII; break;
      case VariableField::RECTANGLE_TOP_LEFT_CORNER_RADIUS: m |= F_CORNER_TL; break;
      case VariableField::RECTANGLE_TOP_RIGHT_CORNER_RADIUS: m |= F_CORNER_TR; break;
      case VariableField::RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: m |= F_CORNER_BR; break;
      case VariableField::RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: m |= F_CORNER_BL; break;
      case VariableField::STROKE_WEIGHT: m |= F_STROKE_WEIGHT; break;
      case VariableField::BORDER_TOP_WEIGHT: case VariableField::BORDER_RIGHT_WEIGHT: case VariableField::BORDER_BOTTOM_WEIGHT:
      case VariableField::BORDER_LEFT_WEIGHT: m |= F_BORDER_WEIGHTS; break;
      case VariableField::STACK_SPACING: m |= F_STACK_SPACING; break;
      case VariableField::STACK_COUNTER_SPACING: m |= F_STACK_COUNTER_SPACING; break;
      case VariableField::STACK_PADDING_LEFT: m |= F_STACK_PADDING_LEFT; break;
      case VariableField::STACK_PADDING_TOP: m |= F_STACK_PADDING_TOP; break;
      case VariableField::STACK_PADDING_RIGHT: m |= F_STACK_PADDING_RIGHT; break;
      case VariableField::STACK_PADDING_BOTTOM: m |= F_STACK_PADDING_BOTTOM; break;
      case VariableField::FONT_FAMILY: case VariableField::FONT_STYLE: m |= F_FONT_NAME; break;
      case VariableField::FONT_SIZE: m |= F_FONT_SIZE; break;
      case VariableField::LINE_HEIGHT: m |= F_LINE_HEIGHT; break;
      case VariableField::LETTER_SPACING: m |= F_LETTER_SPACING; break;
      case VariableField::PARAGRAPH_SPACING: m |= F_PARAGRAPH_SPACING; break;
      case VariableField::PARAGRAPH_INDENT: m |= F_PARAGRAPH_INDENT; break;
      case VariableField::VISIBLE: m |= F_VISIBLE; break;
      case VariableField::TEXT_DATA: m |= F_TEXT_DATA; break;
      case VariableField::GRID_ROW_GAP: case VariableField::GRID_COLUMN_GAP: m |= F_EXTRA; break;
      case VariableField::VARIANT_PROPERTIES: m |= F_SYMBOL_DATA; break;
      default: break;
    }
  }
  auto paints = [](const std::vector<Paint>& list) {
    for (const Paint& pt : list)
      if (pt.hasVariables()) return true;
    return false;
  };
  if (paints(p.fillPaints)) m |= F_FILLS;
  if (paints(p.strokePaints)) m |= F_STROKES;
  for (const TextStyle& run : p.text().textData.styleOverrideTable)
    if (paints(run.fillPaints) || text::runHasBindings(run)) m |= F_TEXT_DATA;
  for (const Effect& e : p.effects)
    if (e.hasVariables()) m |= F_EFFECTS;
  for (const LayoutGrid& g : p.rare().layoutGrids)
    if (g.hasVariables()) m |= F_LAYOUT_GRIDS;
  return m;
}

Guid Editor::unhostedSlotContent(Guid id, const NodeProps& p) const {
  const NodeProps* q = &p;
  Guid cur = id;
  for (int guard = 0; q && guard < 4096; guard++) {
    if (q->type == NodeType::CANVAS || q->type == NodeType::DOCUMENT) return kNoGuid;
    if (q->comp().isSlotContent) {
      const Node* parent = doc_.get(q->parentIndex.guid);
      if (parent && parent->props.type == NodeType::INSTANCE) return kNoGuid;  // ours: the instance's own child
      auto h = slotHosts_.find(cur);
      return h != slotHosts_.end() && doc_.has(h->second) ? kNoGuid : cur;
    }
    cur = q->parentIndex.guid;
    const Node* n = doc_.get(cur);
    q = n ? &n->props : nullptr;
  }
  return kNoGuid;
}

void Editor::resolveBindings(Guid id, NodeProps& p, BindingDeps* deps) const {
  // Slot content whose slot isn't derived yet keeps the values its file stored (Figma resolved them there): the
  // content is resolved again when its instance is derived.
  if (unhostedSlotContent(id, p) != kNoGuid) return;
  // 1. Styles: their values (with their own bindings) replace the consumer's.
  auto useStyle = [&](const AssetId& ref, StyleType type) -> const NodeProps* {
    if (!ref.present()) return nullptr;
    Guid g = findStyle(ref);
    if (deps) deps->styles.push_back(g != kNoGuid ? g : ref.guid);
    return styleNode(ref, type);
  };
  if (const NodeProps* s = useStyle(p.refs().styleIdForFill, StyleType::FILL)) p.fillPaints = s->fillPaints;
  if (const NodeProps* s = useStyle(p.refs().styleIdForStrokeFill, StyleType::FILL)) p.strokePaints = s->fillPaints;
  if (const NodeProps* s = useStyle(p.refs().styleIdForEffect, StyleType::EFFECT)) p.effects = s->effects;
  if (const NodeProps* s = useStyle(p.refs().styleIdForGrid, StyleType::GRID)) p.rare().layoutGrids = s->rare().layoutGrids;
  if (const NodeProps* s = useStyle(p.refs().styleIdForText, StyleType::TEXT); s && p.type == NodeType::TEXT) {
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
  // Runs with their own text style or variable bindings (a style or variable applied to part of a text): their
  // typography from the style, then from their variables.
  if (p.type == NodeType::TEXT)
    for (TextStyle& run : p.text().textData.styleOverrideTable) {
      if (!text::runHasBindings(run)) continue;
      NodeProps rp = text::runProps(run);
      std::vector<ParamBinding> map = rp.parameterConsumptionMap;
      if (const NodeProps* st = useStyle(rp.refs().styleIdForText, StyleType::TEXT)) {
        run.fontName = st->text().fontName;
        run.fontSize = st->text().fontSize;
        run.lineHeight = st->text().lineHeight;
        run.letterSpacing = st->text().letterSpacing;
        run.textCase = st->text().textCase;
        run.textDecoration = st->text().textDecoration;
        run.mask |= R_FONT_NAME | R_FONT_SIZE | R_LINE_HEIGHT | R_LETTER_SPACING | R_TEXT_CASE | R_TEXT_DECORATION;
        for (const ParamBinding& b : st->parameterConsumptionMap)
          if (b.isVariable() && isTextStyleField(b.field)) map.push_back(b);
      }
      for (const ParamBinding& b : map) {
        if (!b.isVariable() || !resolve(b.data, r)) continue;
        switch (b.field) {
          case VariableField::FONT_FAMILY:
            if (r.kind == Resolved::Kind::STRING && !r.s.empty()) run.fontName.family = r.s, run.fontName.postscript.clear(), run.mask |= R_FONT_NAME;
            break;
          case VariableField::FONT_STYLE: {
            std::string style = r.kind == Resolved::Kind::STRING ? r.s
                                : r.kind == Resolved::Kind::FLOAT ? styleForWeight(r.f, isItalicStyle(run.fontName.style))
                                                                 : std::string();
            if (!style.empty()) {
              if (!(run.mask & R_FONT_NAME)) run.fontName = p.text().fontName;
              run.fontName.style = style, run.fontName.postscript.clear(), run.mask |= R_FONT_NAME;
            }
            break;
          }
          case VariableField::FONT_SIZE:
            if (r.kind == Resolved::Kind::FLOAT) run.fontSize = std::max(1.0, r.f), run.mask |= R_FONT_SIZE;
            break;
          case VariableField::LINE_HEIGHT: {
            // As on a node: RAW stays a percentage, Auto becomes pixels.
            if (r.kind != Resolved::Kind::FLOAT || !std::isfinite(r.f)) break;
            Number lh = (run.mask & R_LINE_HEIGHT) ? run.lineHeight : p.text().lineHeight;
            run.lineHeight = lh.units == NumberUnits::RAW ? Number{r.f / 100, NumberUnits::RAW} : Number{r.f, NumberUnits::PIXELS};
            run.mask |= R_LINE_HEIGHT;
            break;
          }
          case VariableField::LETTER_SPACING:
            if (r.kind == Resolved::Kind::FLOAT && std::isfinite(r.f)) {
              if (!(run.mask & R_LETTER_SPACING)) run.letterSpacing = p.text().letterSpacing;
              run.letterSpacing.value = r.f, run.mask |= R_LETTER_SPACING;
            }
            break;
          default: break;
        }
      }
    }
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
        if (v.kind == Resolved::Kind::STRING && p.type == NodeType::TEXT && p.text().textData.characters != v.s) {
          p.text().textData.characters = v.s;
          p.text().textData.characterStyleIDs.clear();  // one style: the layer's own
          p.text().textData.lines.clear();
        }
        break;
      case VariableField::FONT_FAMILY:
        if (v.kind == Resolved::Kind::STRING && !v.s.empty() && p.text().fontName.family != v.s) {
          p.text().fontName.family = v.s;
          p.text().fontName.postscript.clear();
        }
        break;
      case VariableField::FONT_STYLE: {
        std::string style = v.kind == Resolved::Kind::STRING ? v.s
                            : v.kind == Resolved::Kind::FLOAT ? styleForWeight(v.f, isItalicStyle(p.text().fontName.style))
                                                             : std::string();
        if (!style.empty() && p.text().fontName.style != style) {
          p.text().fontName.style = style;
          p.text().fontName.postscript.clear();
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
      // A colour variable's alpha is the paint's opacity, the colour itself opaque — as Figma's files store it (all
      // 11,007 bound solid paints of a private test file: color.a = 1, opacity = the variable's alpha).
      if (resolve(pt.colorVar, r) && r.kind == Resolved::Kind::COLOR) {
        pt.color = r.c;
        pt.opacity = static_cast<float>(clamp01(r.c.a));
        pt.color.a = 1;
      }
      if (resolve(pt.opacityVar, r) && r.kind == Resolved::Kind::FLOAT) pt.opacity = static_cast<float>(clamp01(r.f / 100));
      for (size_t i = 0; i < pt.stopVars.size() && i < pt.stops.size(); i++)
        if (resolve(pt.stopVars[i], r) && r.kind == Resolved::Kind::COLOR) pt.stops[i].color = r.c;
    }
  };
  paints(p.fillPaints);
  paints(p.strokePaints);
  for (TextStyle& run : p.text().textData.styleOverrideTable) paints(run.fillPaints);
  for (Effect& e : p.effects) {
    if (resolve(e.colorVar, r) && r.kind == Resolved::Kind::COLOR) e.color = r.c;
    if (resolve(e.radiusVar, r) && r.kind == Resolved::Kind::FLOAT) e.radius = nonNegative(r.f);
    if (resolve(e.spreadVar, r) && r.kind == Resolved::Kind::FLOAT) e.spread = r.f;
    if (resolve(e.xVar, r) && r.kind == Resolved::Kind::FLOAT) e.offset.x = r.f;
    if (resolve(e.yVar, r) && r.kind == Resolved::Kind::FLOAT) e.offset.y = r.f;
  }
  for (LayoutGrid& g : p.rare().layoutGrids) {
    if (resolve(g.numSectionsVar, r) && r.kind == Resolved::Kind::FLOAT)
      g.numSections = static_cast<int32_t>(std::max(0.0, std::round(r.f)));  // counts are whole (R3-49)
    if (resolve(g.offsetVar, r) && r.kind == Resolved::Kind::FLOAT) g.offset = r.f;
    if (resolve(g.sectionSizeVar, r) && r.kind == Resolved::Kind::FLOAT) g.sectionSize = nonNegative(r.f);
    if (resolve(g.gutterSizeVar, r) && r.kind == Resolved::Kind::FLOAT) g.gutterSize = nonNegative(r.f);
  }
  // 3. A variant bound to variables: the instance switches variant with the mode (R3-13). A real instance writes the
  // variant it shows (its symbolID, as Figma's files hold it; its changes remapped as a variant switch does); a derived
  // one chooses its own while its instance is derived (expandChildren).
  if (p.type == NodeType::INSTANCE && !id.isDerived())
    for (const ParamBinding& b : p.parameterConsumptionMap)
      if (b.field == VariableField::VARIANT_PROPERTIES && b.isVariable()) {
        Guid cur = p.comp().symbolData.symbolID;
        Guid v = variantFor(cur, b.data, ctx, deps);
        if (v != kNoGuid && v != cur) {
          p.comp().symbolData.overrides = remapOverrides(p.comp().symbolData.overrides, cur, v, true);
          p.comp().symbolData.symbolID = v;
        }
      }
}

// What resolveBindings writes, reset: a style's values in its user, every variable-bound field. The binding is the
// content; the value depends on where the node sits (its modes) and on the variable / style (their own content).
void Editor::clearBoundValues(NodeProps& p) {
  const NodeProps none;
  if (p.refs().styleIdForFill.present()) p.fillPaints.clear();
  if (p.refs().styleIdForStrokeFill.present()) p.strokePaints.clear();
  if (p.refs().styleIdForEffect.present()) p.effects.clear();
  if (p.refs().styleIdForGrid.present()) p.rare().layoutGrids.clear();
  if (p.refs().styleIdForText.present() && p.type == NodeType::TEXT) {
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
          p.text().textData.characters.clear();
          p.text().textData.characterStyleIDs.clear();
          p.text().textData.lines.clear();
        }
        break;
      case VariableField::FONT_FAMILY: p.text().fontName.family.clear(), p.text().fontName.postscript.clear(); break;
      case VariableField::FONT_STYLE: p.text().fontName.style.clear(), p.text().fontName.postscript.clear(); break;
      case VariableField::FONT_SIZE: p.text().fontSize = none.text().fontSize; break;
      case VariableField::LINE_HEIGHT: p.text().lineHeight = none.text().lineHeight; break;
      case VariableField::LETTER_SPACING: p.text().letterSpacing = none.text().letterSpacing; break;
      case VariableField::GRID_ROW_GAP: p.extra.erase("gridRowGap"); break;
      case VariableField::GRID_COLUMN_GAP: p.extra.erase("gridColumnGap"); break;
      case VariableField::VARIANT_PROPERTIES: break;  // the variant is what the instance is (hashed by its main)
      default: setFloatField(p, b.field, 0); break;
    }
  }
  auto paints = [](std::vector<Paint>& list) {
    for (Paint& pt : list) {
      if (pt.colorVar.present()) pt.color = Color{}, pt.opacity = 1;
      if (pt.opacityVar.present()) pt.opacity = 1;
      for (size_t i = 0; i < pt.stopVars.size() && i < pt.stops.size(); i++)
        if (pt.stopVars[i].present()) pt.stops[i].color = Color{};
    }
  };
  paints(p.fillPaints);
  paints(p.strokePaints);
  for (TextStyle& run : p.text().textData.styleOverrideTable) paints(run.fillPaints);
  for (Effect& e : p.effects) {
    if (e.colorVar.present()) e.color = Color{};
    if (e.radiusVar.present()) e.radius = 0;
    if (e.spreadVar.present()) e.spread = 0;
    if (e.xVar.present()) e.offset.x = 0;
    if (e.yVar.present()) e.offset.y = 0;
  }
  for (LayoutGrid& g : p.rare().layoutGrids) {
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
      if (auto s = slotContentsOf_.find(g); s != slotContentsOf_.end())
        for (Guid c : s->second) stack.push_back(c);  // slot content it hosts (Figma's form)
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
      Guid set = findCollection(n->props.asset().variableSetID);
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
    // Its extended collections follow its modes (and theirs follow them).
    if (n && (c.phase != Phase::CHANGED || (m & F_VARIABLE_SET_MODES))) extensionSyncDirty_.insert(c.guid);
  } else if (type == NodeType::VARIABLE_OVERRIDE || overrideIndex_.count(c.guid)) {
    // An extended collection's values for a variable: what resolved through that collection resolves again.
    Guid before = overrideIndex_.count(c.guid) ? overrideIndex_[c.guid].first : kNoGuid;
    Guid var = overrideIndex_.count(c.guid) ? overrideIndex_[c.guid].second : kNoGuid;
    indexOverride(c.guid);
    for (Guid ext : {before, overrideIndex_.count(c.guid) ? overrideIndex_[c.guid].first : kNoGuid}) {
      if (ext == kNoGuid) continue;
      if (auto it = setConsumers_.find(ext); it != setConsumers_.end())
        for (Guid g : it->second) bindingsDirty_.insert(g);
      events_.collections.push_back(ext);
    }
    if (overrideIndex_.count(c.guid)) var = overrideIndex_[c.guid].second;
    if (var != kNoGuid) events_.variables.push_back(var);
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
  if (!extensionSyncDirty_.empty()) syncExtensions();
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
      // An instance whose derivation read variables (a bound variant inside it, a bound property value) is derived again.
      if (n->props.type == NodeType::INSTANCE && instanceVarDeps_.count(id)) instanceDirty_.insert(id);
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
        case VariableField::MIN_WIDTH: return (m & F_MIN_SIZE) && now.rare().minSize.x != before.rare().minSize.x;
        case VariableField::MAX_WIDTH: return (m & F_MAX_SIZE) && now.rare().maxSize.x != before.rare().maxSize.x;
        case VariableField::MIN_HEIGHT: return (m & F_MIN_SIZE) && now.rare().minSize.y != before.rare().minSize.y;
        case VariableField::MAX_HEIGHT: return (m & F_MAX_SIZE) && now.rare().maxSize.y != before.rare().maxSize.y;
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
        case VariableField::BORDER_TOP_WEIGHT: return (m & F_BORDER_WEIGHTS) && now.stroke().borderWeights[0] != before.stroke().borderWeights[0];
        case VariableField::BORDER_RIGHT_WEIGHT: return (m & F_BORDER_WEIGHTS) && now.stroke().borderWeights[1] != before.stroke().borderWeights[1];
        case VariableField::BORDER_BOTTOM_WEIGHT: return (m & F_BORDER_WEIGHTS) && now.stroke().borderWeights[2] != before.stroke().borderWeights[2];
        case VariableField::BORDER_LEFT_WEIGHT: return (m & F_BORDER_WEIGHTS) && now.stroke().borderWeights[3] != before.stroke().borderWeights[3];
        case VariableField::STACK_SPACING: return (m & F_STACK_SPACING) != 0;
        case VariableField::STACK_COUNTER_SPACING: return (m & F_STACK_COUNTER_SPACING) != 0;
        case VariableField::STACK_PADDING_LEFT: return (m & F_STACK_PADDING_LEFT) != 0;
        case VariableField::STACK_PADDING_TOP: return (m & F_STACK_PADDING_TOP) != 0;
        case VariableField::STACK_PADDING_RIGHT: return (m & F_STACK_PADDING_RIGHT) != 0;
        case VariableField::STACK_PADDING_BOTTOM: return (m & F_STACK_PADDING_BOTTOM) != 0;
        case VariableField::TEXT_DATA: return (m & F_TEXT_DATA) && now.text().textData.characters != before.text().textData.characters;
        case VariableField::FONT_FAMILY: return (m & F_FONT_NAME) && now.text().fontName.family != before.text().fontName.family;
        case VariableField::FONT_STYLE: return (m & F_FONT_NAME) && now.text().fontName.style != before.text().fontName.style;
        case VariableField::FONT_SIZE: return (m & F_FONT_SIZE) != 0;
        case VariableField::LINE_HEIGHT: return (m & F_LINE_HEIGHT) != 0;
        case VariableField::LETTER_SPACING: return (m & F_LETTER_SPACING) != 0;
        case VariableField::PARAGRAPH_SPACING: return (m & F_PARAGRAPH_SPACING) != 0;
        case VariableField::PARAGRAPH_INDENT: return (m & F_PARAGRAPH_INDENT) != 0;
        case VariableField::GRID_ROW_GAP:
          return (m & F_EXTRA) && now.extra.count("gridRowGap") &&
                 (!before.extra.count("gridRowGap") || extraFloat(now, "gridRowGap", kGridRowGapId) != extraFloat(before, "gridRowGap", kGridRowGapId));
        case VariableField::GRID_COLUMN_GAP:
          return (m & F_EXTRA) && now.extra.count("gridColumnGap") &&
                 (!before.extra.count("gridColumnGap") ||
                  extraFloat(now, "gridColumnGap", kGridColumnGapId) != extraFloat(before, "gridColumnGap", kGridColumnGapId));
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
      if (p.colorVar.present() && p.colorVar == o.colorVar && !(p.color == o.color)) p.colorVar = VarBox();
      if (p.opacityVar.present() && p.opacityVar == o.opacityVar && p.opacity != o.opacity) p.opacityVar = VarBox();
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
      if (e.colorVar.present() && e.colorVar == o.colorVar && !(e.color == o.color)) e.colorVar = VarBox();
      if (e.radiusVar.present() && e.radiusVar == o.radiusVar && e.radius != o.radius) e.radiusVar = VarBox();
      if (e.spreadVar.present() && e.spreadVar == o.spreadVar && e.spread != o.spread) e.spreadVar = VarBox();
      if (e.xVar.present() && e.xVar == o.xVar && e.offset.x != o.offset.x) e.xVar = VarBox();
      if (e.yVar.present() && e.yVar == o.yVar && e.offset.y != o.offset.y) e.yVar = VarBox();
    }
  if (m & F_LAYOUT_GRIDS)
    for (size_t i = 0; i < c.props.rare().layoutGrids.size() && i < before.rare().layoutGrids.size(); i++) {
      LayoutGrid& g = c.props.rare().layoutGrids[i];
      const LayoutGrid& o = before.rare().layoutGrids[i];
      if (g.numSectionsVar.present() && g.numSectionsVar == o.numSectionsVar && g.numSections != o.numSections) g.numSectionsVar = VarBox();
      if (g.offsetVar.present() && g.offsetVar == o.offsetVar && g.offset != o.offset) g.offsetVar = VarBox();
      if (g.sectionSizeVar.present() && g.sectionSizeVar == o.sectionSizeVar && g.sectionSize != o.sectionSize) g.sectionSizeVar = VarBox();
      if (g.gutterSizeVar.present() && g.gutterSizeVar == o.gutterSizeVar && g.gutterSize != o.gutterSize) g.gutterSizeVar = VarBox();
    }
  // Styles: values that no longer match detach the style.
  auto detach = [&](FieldMask valueBits, FieldMask styleBit, AssetId& out, const AssetId& was) {
    if ((m & valueBits) && was.present() && !(m & styleBit)) {
      out = AssetId{};
      c.mask |= styleBit;
    }
  };
  detach(F_FILLS, F_STYLE_ID_FILL, c.props.refs().styleIdForFill, before.refs().styleIdForFill);
  detach(F_STROKES, F_STYLE_ID_STROKE, c.props.refs().styleIdForStrokeFill, before.refs().styleIdForStrokeFill);
  detach(F_EFFECTS, F_STYLE_ID_EFFECT, c.props.refs().styleIdForEffect, before.refs().styleIdForEffect);
  detach(F_LAYOUT_GRIDS, F_STYLE_ID_GRID, c.props.refs().styleIdForGrid, before.refs().styleIdForGrid);
  if (before.type == NodeType::TEXT) detach(kTextStyleNodeFields, F_STYLE_ID_TEXT, c.props.refs().styleIdForText, before.refs().styleIdForText);
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
      b.resolved.s = styleForWeight(b.resolved.f, isItalicStyle(p.text().fontName.style));
    }
    out.push_back(std::move(b));
  };
  for (const ParamBinding& b : p.parameterConsumptionMap) {
    if (!b.isVariable()) continue;
    // A variant bound to variables: one target per property ("componentProperties.<name>").
    if (b.field == VariableField::VARIANT_PROPERTIES && b.data.kind == VariableData::Kind::EXPRESSION && !b.data.args.empty() &&
        b.data.args[0].kind == VariableData::Kind::MAP) {
      const VariableData& map = b.data.args[0];
      for (size_t i = 0; i < map.args.size(); i++) add("componentProperties." + (i < map.mapKeys.size() ? map.mapKeys[i] : std::string()), map.args[i]);
      continue;
    }
    add(fieldTarget(b.field), b.data);
  }
  // Component properties bound to variables: a main's defaults, an instance's values.
  for (const ComponentPropDef& d : p.comp().componentPropDefs)
    if (d.boundValue.present()) add("componentProperties." + d.name, d.boundValue);
  if (!p.comp().componentPropAssignments.empty()) {
    Guid main = mainOf(node);
    const std::vector<ComponentPropDef>* defs = main != kNoGuid ? defsOf(main) : nullptr;
    for (const ComponentPropAssignment& a : p.comp().componentPropAssignments) {
      if (!a.boundValue.present() || !defs) continue;
      for (const ComponentPropDef& d : *defs)
        if (d.id == a.defID) add("componentProperties." + d.name, a.boundValue);
    }
  }
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
  for (size_t i = 0; i < p.rare().layoutGrids.size(); i++) {
    std::string base = "layoutGrids[" + std::to_string(i) + "]";
    const LayoutGrid& g = p.rare().layoutGrids[i];
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
