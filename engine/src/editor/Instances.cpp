// Instances (docs/engine.md §3.3 step 2, docs/schema.md §5): every real INSTANCE
// is materialized into derived rows — its main's subtree with the overrides,
// property values and nested instances applied — kept in the document like any
// node (so drawing, hit-testing, layout and text work on them unchanged) but
// never stored, emitted or undone. Their ids are Figma's "I<instance>;<key>…"
// paths (base/DerivedIds.h), stable however often they are re-derived.
//
// Dependencies are recorded while deriving (Materializer spirit): every real
// node an instance read points back to it, so any change to a main, a nested
// main, a component set's definitions or the instance itself re-derives exactly
// the instances that used it, in the same transaction.
//
// Edits to derived rows become overrides on the top-level instance (or property
// values when the field is bound to a component property); structural edits
// inside instances are refused.

#include <algorithm>
#include <cmath>
#include <map>
#include <unordered_set>

#include "base/DerivedIds.h"
#include "editor/Editor.h"

namespace eng {

namespace {

using GuidSet = std::unordered_set<Guid, GuidHash>;

// An instance's own fields: never taken from its main's root, never in its root override.
constexpr FieldMask kOwnFields = F_PARENT_INDEX | F_TRANSFORM | F_LOCKED | F_H_CONSTRAINT | F_V_CONSTRAINT | F_STACK_CHILD_GROW |
                                 F_STACK_CHILD_ALIGN_SELF | F_STACK_POSITIONING;
// What an instance root doesn't inherit from its main's root: its own fields, identity, component-only fields,
// page-only fields and unmodelled ones.
constexpr FieldMask kNotInherited = kOwnFields | F_TYPE | kComponentFields | F_BACKGROUND_COLOR | F_BACKGROUND_ENABLED |
                                    F_INTERNAL_ONLY | F_EXTRA | kAssetFields;
// Figma's overridable fields (docs/schema.md §5.4, R4 §3).
constexpr FieldMask kOverridable =
    F_NAME | F_VISIBLE | F_LOCKED | F_OPACITY | F_SIZE | F_FILLS | F_STROKES | F_STROKE_WEIGHT | F_STROKE_ALIGN | F_CORNER_RADII |
    F_FRAME_MASK_DISABLED | F_STACK_SPACING | F_STACK_PADDING_LEFT | F_STACK_PADDING_TOP | F_STACK_PADDING_RIGHT |
    F_STACK_PADDING_BOTTOM | F_STACK_PRIMARY_SIZING | F_STACK_COUNTER_SIZING | F_STACK_PRIMARY_ALIGN | F_STACK_COUNTER_ALIGN |
    F_STACK_COUNTER_ALIGN_CONTENT | F_STACK_COUNTER_SPACING | F_STACK_CHILD_GROW | F_STACK_CHILD_ALIGN_SELF | F_STACK_POSITIONING |
    F_MIN_SIZE | F_MAX_SIZE | F_PROPORTIONS_CONSTRAINED | kTextLayoutFields | F_AUTO_RENAME | F_BLEND_MODE | F_STROKE_CAP |
    F_STROKE_JOIN | F_MITER_LIMIT | F_DASH_PATTERN | F_BORDER_WEIGHTS | F_CORNER_SMOOTHING | F_EFFECTS | F_LAYOUT_GRIDS |
    F_OVERRIDDEN_SYMBOL_ID | F_COMPONENT_PROP_ASSIGNMENTS | F_EXTRA | F_PARAM_MAP | F_VARIABLE_MODES | kStyleIdFields;
// Unmodelled fields an override may carry.
bool overridableExtra(const std::string& key) {
  return key == "exportSettings" || key == "prototypeInteractions" || key == "annotations" || key == "styleIdForFill" ||
         key == "styleIdForStrokeFill" || key == "styleIdForText" || key == "styleIdForEffect" || key == "styleIdForGrid";
}

void mergeInto(NodeProps& to, const NodeProps& from, FieldMask mask) {
  copyFields(to, from, mask & ~static_cast<FieldMask>(F_EXTRA | F_PARAM_MAP));
  // Bindings merge per field (override entries hold them sparsely, as Figma's files do).
  if (mask & F_PARAM_MAP) mergeParams(to.parameterConsumptionMap, from.parameterConsumptionMap);
  if (mask & F_EXTRA)
    for (auto& [k, v] : from.extra) {
      if (v.empty()) to.extra.erase(k);
      else to.extra[k] = v;
    }
}

const ComponentPropAssignment* findAssign(const std::vector<ComponentPropAssignment>& list, Guid def) {
  for (const auto& a : list)
    if (a.defID == def) return &a;
  return nullptr;
}

void setAssign(std::vector<ComponentPropAssignment>& list, const ComponentPropAssignment& a) {
  for (auto& b : list)
    if (b.defID == a.defID) {
      b = a;
      return;
    }
  list.push_back(a);
}

void applyTextValue(TextData& t, const TextData& v) {
  if (v.characters == t.characters && v.characterStyleIDs.empty() && v.styleOverrideTable.empty()) return;
  t.characters = v.characters;
  if (!v.characterStyleIDs.empty() || !v.styleOverrideTable.empty()) {
    t.characterStyleIDs = v.characterStyleIDs;
    t.styleOverrideTable = v.styleOverrideTable;
  } else {
    t.characterStyleIDs.clear();  // one style: the layer's own
  }
  t.lines.clear();
}

bool sameSize(Vec2 a, Vec2 b) { return std::fabs(a.x - b.x) < 1e-6 && std::fabs(a.y - b.y) < 1e-6; }

}  // namespace

// Override entries by their path from the top-level instance, highest priority first: the usage site's,
// then each nested instance's own (docs/schema.md §5.3).
struct Editor::OverrideStack {
  std::map<std::vector<Guid>, std::vector<const SymbolOverride*>> byPath;
  void add(const std::vector<SymbolOverride>& list, const std::vector<Guid>& prefix) {
    for (const SymbolOverride& o : list) {
      std::vector<Guid> p = prefix;
      p.insert(p.end(), o.path.begin(), o.path.end());
      byPath[p].push_back(&o);
    }
  }
  void apply(const std::vector<Guid>& path, NodeProps& props) const {
    auto it = byPath.find(path);
    if (it == byPath.end()) return;
    for (auto e = it->second.rbegin(); e != it->second.rend(); ++e)
      mergeInto(props, (*e)->props, (*e)->mask & kOverridable & ~static_cast<FieldMask>(F_COMPONENT_PROP_ASSIGNMENTS));
  }
  // The highest-priority entry at `path` carrying `bit`.
  const SymbolOverride* highest(const std::vector<Guid>& path, FieldMask bit) const {
    auto it = byPath.find(path);
    if (it == byPath.end()) return nullptr;
    for (const SymbolOverride* e : it->second)
      if (e->mask & bit) return e;
    return nullptr;
  }
  // Assignments at `path` (a nested instance) merged over `base`, lowest priority first.
  void assignments(const std::vector<Guid>& path, std::vector<ComponentPropAssignment>& base) const {
    auto it = byPath.find(path);
    if (it == byPath.end()) return;
    for (auto e = it->second.rbegin(); e != it->second.rend(); ++e)
      if ((*e)->mask & F_COMPONENT_PROP_ASSIGNMENTS)
        for (const auto& a : (*e)->props.componentPropAssignments) setAssign(base, a);
  }
};

struct Editor::Expansion {
  Guid top = kNoGuid;
  OverrideStack stack;
  std::vector<DerivedRow> rows;
  std::vector<DerivedInfo> infos;
  std::vector<Guid> sources;
  std::vector<Guid> symbols;                        // the mains being expanded (cycle guard)
  std::vector<std::pair<Guid, Guid>> slots;         // a slot row, its content frame
  std::unordered_map<Guid, Vec2, GuidHash> sourceSizes;
};

// ---- Lookups ------------------------------------------------------------------------

Guid Editor::symbolOf(const NodeProps& instance) const {
  const Node* m = doc_.get(instance.symbolData.symbolID);
  return m && m->props.type == NodeType::SYMBOL ? instance.symbolData.symbolID : kNoGuid;
}

Guid Editor::setOf(Guid symbol) const {
  Guid p = doc_.parentOf(symbol);
  const Node* pn = doc_.get(p);
  return pn && pn->props.isComponentSet() ? p : kNoGuid;
}

const std::vector<ComponentPropDef>* Editor::defsOf(Guid symbol) const {
  Guid set = setOf(symbol);
  const Node* n = doc_.get(set != kNoGuid ? set : symbol);
  return n ? &n->props.componentPropDefs : nullptr;
}

NodeProps Editor::instanceRoot(const NodeProps& own, const NodeProps& main, Guid mainId) const {
  NodeProps r = main;
  copyFields(r, own, kNotInherited);
  // Bindings: the main root's (its variables), with the instance's own component-property bindings on top (a
  // nested instance's, where it sits in its main); the root override entry adds the instance's own changes.
  r.parameterConsumptionMap = main.parameterConsumptionMap;
  std::vector<ParamBinding> ownRefs;
  for (const ParamBinding& b : own.parameterConsumptionMap)
    if (b.propRef != kNoGuid) ownRefs.push_back(b);
  mergeParams(r.parameterConsumptionMap, ownRefs);
  r.type = NodeType::INSTANCE;
  // An instance of a variant is named after its set (Figma).
  if (Guid set = mainId != kNoGuid ? setOf(mainId) : kNoGuid; set != kNoGuid) r.name = doc_.get(set)->props.name;
  return r;
}

Guid Editor::instanceOfDerived(Guid id) const {
  if (!id.isDerived()) return kNoGuid;
  auto it = derivedInfo_.find(id);
  return it != derivedInfo_.end() ? it->second.instance : derived::instanceOf(id);
}

bool Editor::acceptsChildren(Guid id) const {
  const Node* n = doc_.get(id);
  if (n && id.isDerived()) {
    // A slot takes layers (its content diverges on the first one).
    auto info = derivedInfo_.find(id);
    const Node* src = info != derivedInfo_.end() ? doc_.get(info->second.source) : nullptr;
    return src && src->props.isSlot;
  }
  if (!n) return false;
  if (n->props.type == NodeType::CANVAS) return true;
  return n->props.isFrameLike() && n->props.type != NodeType::INSTANCE;
}

bool Editor::isStructuralTarget(Guid parent) const {
  if (parent.isDerived()) return true;
  const Node* n = doc_.get(parent);
  return n && n->props.type == NodeType::INSTANCE;
}

Guid Editor::mainOf(Guid instance) const {
  const Node* n = doc_.get(instance);
  if (!n || n->props.type != NodeType::INSTANCE) return kNoGuid;
  if (instance.isDerived()) {
    auto it = derivedInfo_.find(instance);
    if (it != derivedInfo_.end() && it->second.symbol != kNoGuid) return doc_.has(it->second.symbol) ? it->second.symbol : kNoGuid;
  }
  return symbolOf(n->props);
}

bool Editor::blueprintBase(Guid id, Mat2x3& transform, Vec2& size) const {
  if (!id.isDerived()) return false;
  auto it = blueprint_.find(id);
  if (it == blueprint_.end() || !it->second.geometry) return false;
  transform = it->second.transform;
  size = it->second.size;
  return true;
}

bool Editor::blueprintSourceSize(Guid id, Vec2& size) const {
  auto it = blueprint_.find(id);
  if (it == blueprint_.end() || !it->second.frame) return false;
  size = it->second.sourceSize;
  return true;
}

std::vector<ComponentPropAssignment> Editor::assignmentsOf(Guid level) const {
  if (level.isDerived()) {
    auto it = derivedInfo_.find(level);
    if (it == derivedInfo_.end()) return {};
    const Node* n = doc_.get(level);
    return n ? n->props.componentPropAssignments : std::vector<ComponentPropAssignment>{};
  }
  const Node* n = doc_.get(level);
  return n ? n->props.componentPropAssignments : std::vector<ComponentPropAssignment>{};
}

// ---- Dirty tracking -----------------------------------------------------------------

void Editor::markInstanceDirty(const NodeChange& c) {
  if (c.guid.isDerived() || c.guid == materializing_) return;
  const Node* n = doc_.get(c.guid);
  FieldMask m = c.phase == Phase::CHANGED ? c.mask : F_ALL;
  if (c.phase == Phase::REMOVED) {
    if (derivedRows_.count(c.guid)) instanceDirty_.insert(c.guid);
  } else if (n && n->props.type == NodeType::INSTANCE) {
    if (m & ~kOwnFields) instanceDirty_.insert(c.guid);
  } else if (derivedRows_.count(c.guid)) {
    instanceDirty_.insert(c.guid);  // no longer an instance (detached)
  }
  auto mark = [&](Guid source) {
    auto it = sourceDeps_.find(source);
    if (it == sourceDeps_.end()) return;
    for (Guid inst : it->second) instanceDirty_.insert(inst);
  };
  mark(c.guid);
  if (n && (c.phase == Phase::CREATED || (m & F_PARENT_INDEX))) mark(n->props.parentIndex.guid);
}

void Editor::flushInstances() {
  for (int pass = 0; pass < 16 && !instanceDirty_.empty(); pass++) {
    std::vector<Guid> list(instanceDirty_.begin(), instanceDirty_.end());
    instanceDirty_.clear();
    std::sort(list.begin(), list.end());
    for (Guid r : list) materialize(r);
  }
  instanceDirty_.clear();
}

// ---- Derived rows -------------------------------------------------------------------

void Editor::applyDerivedDirect(const NodeChange& change) {
  const Node* existing = doc_.get(change.guid);
  NodeChange c = change;
  if (c.phase == Phase::CHANGED) {
    if (!existing) return;
    c.mask = differingFields(existing->props, change.props, change.mask);
    if (!c.mask) return;
  }
  NodeType before = existing ? existing->props.type : NodeType::NONE;
  if (!doc_.apply(c)) return;
  noteChange(c, before);
}

void Editor::removeDerived(Guid instance) {
  auto it = derivedRows_.find(instance);
  if (it != derivedRows_.end()) {
    std::vector<Guid> rows = std::move(it->second);
    derivedRows_.erase(it);
    for (auto r = rows.rbegin(); r != rows.rend(); ++r) {
      if (doc_.has(*r)) {
        NodeChange c = NodeChange::removed(*r);
        NodeType before = doc_.get(*r)->props.type;
        doc_.apply(c);
        noteChange(c, before);
      }
      derivedInfo_.erase(*r);
      blueprint_.erase(*r);
      dropDeps(*r);
    }
    events_.components.push_back(instance);
  }
  instanceBindings_.erase(instance);
  blueprint_.erase(instance);
  if (auto s = instanceSources_.find(instance); s != instanceSources_.end()) {
    for (Guid src : s->second) {
      auto d = sourceDeps_.find(src);
      if (d == sourceDeps_.end()) continue;
      d->second.erase(std::remove(d->second.begin(), d->second.end(), instance), d->second.end());
      if (d->second.empty()) sourceDeps_.erase(d);
    }
    instanceSources_.erase(s);
  }
}

void Editor::applyBindings(const NodeProps& source, NodeProps& p, Guid symbol, const std::vector<ComponentPropAssignment>& assigns,
                           Guid* swap, Guid* slotContent) const {
  if (source.parameterConsumptionMap.empty()) return;
  const std::vector<ComponentPropDef>* defs = defsOf(symbol);
  if (!defs) return;
  for (const ParamBinding& b : source.parameterConsumptionMap) {
    if (b.propRef == kNoGuid) continue;
    const ComponentPropDef* def = nullptr;
    for (const auto& d : *defs)
      if (d.id == b.propRef) def = &d;
    if (!def) continue;  // a stale binding (its property was deleted)
    const ComponentPropAssignment* a = findAssign(assigns, def->id);
    const ComponentPropValue& v = a && !a->value.empty() ? a->value : def->initialValue;
    switch (b.field) {
      case VariableField::VISIBLE:
        if (v.hasBool) p.visible = v.boolValue;
        break;
      case VariableField::TEXT_DATA:
        if (v.hasText && p.type == NodeType::TEXT) applyTextValue(p.textData, v.textValue);
        break;
      case VariableField::OVERRIDDEN_SYMBOL_ID:
        if (swap && v.guidValue != kNoGuid) *swap = v.guidValue;
        break;
      case VariableField::SLOT_CONTENT_ID:
        if (slotContent && v.guidValue != kNoGuid) *slotContent = v.guidValue;
        break;
      default: break;
    }
  }
}

void Editor::expandChildren(Expansion& ex, Guid symbol, Guid sourceParent, Guid parentRow, const std::vector<Guid>& prefix, Guid level,
                            const std::vector<Guid>& levelPath, const std::vector<ComponentPropAssignment>& assigns, int depth) {
  for (Guid x : std::vector<Guid>(doc_.children(sourceParent))) {
    if (x.isDerived()) continue;
    const Node* xn = doc_.get(x);
    if (!xn || xn->props.isSlotContent) continue;
    ex.sources.push_back(x);
    Guid key = xn->props.keyOf(x);
    std::vector<Guid> path = prefix;
    path.push_back(key);
    Guid id = derived::child(parentRow, key);
    if (id == kNoGuid) continue;
    DerivedInfo info;
    info.instance = ex.top;
    info.path = path;
    info.source = x;
    info.level = level;
    info.levelPath = levelPath;
    NodeProps p;
    if (xn->props.type == NodeType::INSTANCE) {
      // A nested instance: its main (swapped by the usage site or a property), its own overrides under the usage site's.
      Guid main = xn->props.symbolData.symbolID;
      if (const SymbolOverride* swap = ex.stack.highest(path, F_OVERRIDDEN_SYMBOL_ID)) main = swap->props.overriddenSymbolID;
      Guid bound = kNoGuid;
      NodeProps scratch = xn->props;
      applyBindings(xn->props, scratch, symbol, assigns, &bound, nullptr);
      if (bound != kNoGuid) main = bound;
      const Node* mn = doc_.get(main);
      if (!mn || mn->props.type != NodeType::SYMBOL) {
        if (main != xn->props.symbolData.symbolID) ex.sources.push_back(main);
        main = xn->props.symbolData.symbolID;
        mn = doc_.get(main);
        if (mn && mn->props.type != NodeType::SYMBOL) mn = nullptr;
      }
      ex.sources.push_back(main);
      ex.sources.push_back(setOf(main));  // its set's properties and name
      bool swapped = main != xn->props.symbolData.symbolID;
      if (!swapped) ex.stack.add(xn->props.symbolData.overrides, path);
      p = mn ? instanceRoot(xn->props, mn->props, main) : xn->props;
      ex.stack.apply(path, p);
      applyBindings(xn->props, p, symbol, assigns, nullptr, nullptr);
      p.type = NodeType::INSTANCE;
      p.symbolData = SymbolData{};
      p.symbolData.symbolID = main;
      std::vector<ComponentPropAssignment> nested = swapped ? std::vector<ComponentPropAssignment>{} : xn->props.componentPropAssignments;
      ex.stack.assignments(path, nested);
      p.componentPropAssignments = nested;
      p.parentIndex = {parentRow, xn->props.parentIndex.position};
      p.transform = xn->props.transform;
      info.symbol = main;
      if (mn) ex.sourceSizes[id] = mn->props.size;
      ex.rows.push_back({id, p, x, level, path});
      ex.infos.push_back(info);
      bool cycle = std::find(ex.symbols.begin(), ex.symbols.end(), main) != ex.symbols.end();
      if (mn && !cycle && depth < 16) {
        ex.symbols.push_back(main);
        expandChildren(ex, main, main, id, path, id, path, nested, depth + 1);
        ex.symbols.pop_back();
      }
      continue;
    }
    p = xn->props;
    ex.stack.apply(path, p);
    Guid slotContent = kNoGuid;
    applyBindings(xn->props, p, symbol, assigns, nullptr, &slotContent);
    p.parentIndex = {parentRow, xn->props.parentIndex.position};
    p.transform = xn->props.transform;
    if (p.isFrameLike()) ex.sourceSizes[id] = xn->props.size;
    ex.rows.push_back({id, p, x, level, path});
    ex.infos.push_back(info);
    const Node* content = doc_.get(slotContent);
    if (xn->props.isSlot && content && content->props.isSlotContent) {
      ex.slots.push_back({id, slotContent});  // a diverged slot shows its content frame instead of the main's
      continue;
    }
    expandChildren(ex, symbol, x, id, path, level, levelPath, assigns, depth);
  }
}

void Editor::materialize(Guid R) {
  // Its old dependency edges go; deriving records new ones.
  if (auto s = instanceSources_.find(R); s != instanceSources_.end()) {
    for (Guid src : s->second) {
      auto d = sourceDeps_.find(src);
      if (d == sourceDeps_.end()) continue;
      d->second.erase(std::remove(d->second.begin(), d->second.end(), R), d->second.end());
      if (d->second.empty()) sourceDeps_.erase(d);
    }
    instanceSources_.erase(s);
  }
  const Node* rn = doc_.get(R);
  if (R.isDerived() || !rn || rn->props.type != NodeType::INSTANCE) {
    removeDerived(R);
    return;
  }
  Guid prevMaterializing = materializing_;
  bool prevDeriving = deriving_;
  materializing_ = R;
  deriving_ = true;

  Expansion ex;
  ex.top = R;
  ex.sources.push_back(rn->props.symbolData.symbolID);
  Guid main = symbolOf(rn->props);
  Vec2 mainSize;
  if (main != kNoGuid) {
    const NodeProps& mp = doc_.get(main)->props;
    mainSize = mp.size;
    ex.stack.add(rn->props.symbolData.overrides, {});
    // The root: the main's root fields, the instance's own fields, its root override.
    NodeProps root = instanceRoot(rn->props, mp, main);
    ex.stack.apply({}, root);
    // Its variables and styles in its own modes (the main's root holds the main's).
    if (root.hasBindings()) {
      BindingDeps deps;
      resolveBindings(R, root, &deps);
      setDeps(R, std::move(deps));
    }
    FieldMask rootMask = F_ALL & ~kNotInherited;
    NodeChange c = NodeChange::changed(R);
    c.mask = differingFields(rn->props, root, rootMask);
    if (c.mask) {
      copyFields(c.props, root, c.mask);
      bool prevResolving = resolving_;
      resolving_ = true;
      write(c);
      resolving_ = prevResolving;
    }
    rn = doc_.get(R);
    ex.sources.push_back(setOf(main));
    ex.symbols.push_back(main);
    expandChildren(ex, main, main, R, {}, R, {}, rn->props.componentPropAssignments, 0);
  }

  // The rows into the document: what's gone first (children before parents), then each row, parents first.
  GuidSet want;
  for (const DerivedRow& row : ex.rows) want.insert(row.id);
  std::vector<Guid> old = std::move(derivedRows_[R]);
  for (auto it = old.rbegin(); it != old.rend(); ++it) {
    if (want.count(*it)) continue;
    if (doc_.has(*it)) {
      NodeChange c = NodeChange::removed(*it);
      NodeType before = doc_.get(*it)->props.type;
      doc_.apply(c);
      noteChange(c, before);
    }
    derivedInfo_.erase(*it);
    blueprint_.erase(*it);
    dropDeps(*it);
  }
  std::vector<Guid> ids;
  ids.reserve(ex.rows.size());
  bool boundRows = false;
  for (size_t i = 0; i < ex.rows.size(); i++) {
    DerivedRow& row = ex.rows[i];
    // Its variables and styles in its own modes (parents are in place: rows go parents first).
    if (row.props.hasBindings()) {
      boundRows = true;
      BindingDeps deps;
      resolveBindings(row.id, row.props, &deps);
      setDeps(row.id, std::move(deps));
    } else if (deps_.count(row.id)) {
      dropDeps(row.id);
    }
    const Node* n = doc_.get(row.id);
    if (!n) {
      NodeChange c = NodeChange::created(row.id, row.props);
      if (doc_.apply(c)) noteChange(c, NodeType::NONE);
    } else {
      FieldMask d = differingFields(n->props, row.props, F_ALL);
      NodeType before = n->props.type;
      if (d & F_EXTRA) {
        NodeChange c = NodeChange::created(row.id, row.props);
        if (doc_.apply(c)) noteChange(c, before);
      } else if (d) {
        NodeChange c = NodeChange::changed(row.id);
        c.mask = d;
        copyFields(c.props, row.props, d);
        if (doc_.apply(c)) noteChange(c, before);
      }
    }
    derivedInfo_[row.id] = ex.infos[i];
    ids.push_back(row.id);
  }
  derivedRows_[R] = ids;
  if (boundRows) instanceBindings_.insert(R);
  else instanceBindings_.erase(R);

  // Dependencies.
  std::sort(ex.sources.begin(), ex.sources.end());
  ex.sources.erase(std::unique(ex.sources.begin(), ex.sources.end()), ex.sources.end());
  ex.sources.erase(std::remove(ex.sources.begin(), ex.sources.end(), kNoGuid), ex.sources.end());
  for (Guid s : ex.sources) sourceDeps_[s].push_back(R);
  instanceSources_[R] = ex.sources;

  // Layout (docs/engine.md §3.3: one ordered pass). Frames remember the size their children were laid out for in
  // the main; stage A lays the subtree out on its own (hug sizes, texts measured, groups fitted) without
  // constraints; that is the blueprint constraints start from; stage B fits it to the instance's size.
  Blueprint& rb = blueprint_[R];
  rb = Blueprint{};
  rb.frame = main != kNoGuid;
  rb.sourceSize = mainSize;
  for (const DerivedRow& row : ex.rows) {
    Blueprint& b = blueprint_[row.id];
    b = Blueprint{};
    auto ss = ex.sourceSizes.find(row.id);
    if (ss != ex.sourceSizes.end()) {
      b.frame = true;
      b.sourceSize = ss->second;
    }
  }
  bool prevInLayout = inLayout_;
  inLayout_ = true;
  {
    Layout L(*this);
    intrinsicLayout_ = true;
    for (size_t i = ex.rows.size(); i-- > 0;) {
      const Node* n = doc_.get(ex.rows[i].id);
      const Node* parent = n ? doc_.get(n->props.parentIndex.guid) : nullptr;
      if (!n || !parent) continue;
      const NodeProps& p = n->props;
      bool parentLays = parent->props.isAutoLayout();
      bool root = p.type == NodeType::TEXT ? p.textAutoResize != TextAutoResize::NONE && !parentLays
                                           : (p.isAutoLayout() || p.fitsChildren()) && !parentLays && !parent->props.fitsChildren();
      if (root) L.settle(ex.rows[i].id);
    }
    intrinsicLayout_ = false;
    for (const DerivedRow& row : ex.rows) {
      const Node* n = doc_.get(row.id);
      if (!n) continue;
      Blueprint& b = blueprint_[row.id];
      b.transform = n->props.transform;
      b.size = n->props.size;
      b.geometry = true;
    }
    if (main != kNoGuid) L.run({R});
    for (const DerivedRow& row : ex.rows) {
      const Node* n = doc_.get(row.id);
      const Blueprint& b = blueprint_[row.id];
      if (n && b.frame && !n->props.isAutoLayout() && n->props.isFrameLike() && !sameSize(n->props.size, b.sourceSize))
        L.constrainChildren(row.id);
    }
  }
  inLayout_ = prevInLayout;

  // Diverged slots: their content frame (a real child of the instance) sits where the slot is.
  for (auto& [slot, content] : ex.slots) {
    const Node* sn = doc_.get(slot);
    const Node* cn = doc_.get(content);
    if (!sn || !cn) continue;
    NodeChange c = NodeChange::changed(content);
    c.mask = F_TRANSFORM | F_SIZE;
    c.props.transform = doc_.worldTransform(R).inverse() * doc_.worldTransform(slot);
    c.props.size = sn->props.size;
    write(c);
  }

  events_.components.push_back(R);
  if (main != kNoGuid) events_.components.push_back(main);
  deriving_ = prevDeriving;
  materializing_ = prevMaterializing;
}

Guid Editor::slotContentFor(Guid row, bool create) {
  auto info = derivedInfo_.find(row);
  if (info == derivedInfo_.end()) return kNoGuid;
  const DerivedInfo d = info->second;
  const Node* src = doc_.get(d.source);
  if (!src || !src->props.isSlot) return kNoGuid;
  Guid def = kNoGuid;
  for (const ParamBinding& b : src->props.parameterConsumptionMap)
    if (b.field == VariableField::SLOT_CONTENT_ID) def = b.propRef;
  if (def == kNoGuid) return kNoGuid;
  for (const ComponentPropAssignment& a : assignmentsOf(d.level))
    if (a.defID == def && doc_.has(a.value.guidValue)) return a.value.guidValue;
  if (!create) return kNoGuid;
  // The content frame: where the slot is, holding copies of what it shows now.
  const NodeProps slot = doc_.get(row)->props;
  NodeProps f = defaultProps(NodeType::FRAME);
  f.name = slot.name;
  f.fillPaints.clear();
  f.isSlotContent = true;
  f.frameMaskDisabled = slot.frameMaskDisabled;
  f.stackMode = slot.stackMode;
  copyFields(f, slot, kStackContainerFields);
  f.size = slot.size;
  f.transform = doc_.worldTransform(d.instance).inverse() * doc_.worldTransform(row);
  f.parentIndex = {d.instance, doc_.positionAtEnd(d.instance)};
  Guid content = newGuid();
  bool prev = deriving_;
  deriving_ = false;
  write(NodeChange::created(content, f));
  std::unordered_map<Guid, Guid, GuidHash> ids{{row, content}};
  auto copy = [&](auto&& self, Guid parent) -> void {
    for (Guid c : std::vector<Guid>(doc_.children(parent))) {
      if (!c.isDerived()) continue;
      const Node* cn = doc_.get(c);
      if (!cn) continue;
      NodeProps p = cn->props;
      p.parentIndex.guid = ids[parent];
      p.overrideKey = kNoGuid;
      p.parameterConsumptionMap.clear();
      if (p.type == NodeType::INSTANCE) composedOverrides(c, p.symbolData.overrides, p.componentPropAssignments);
      Guid id = newGuid();
      write(NodeChange::created(id, p));
      ids[c] = id;
      if (p.type != NodeType::INSTANCE) self(self, c);
    }
  };
  copy(copy, row);
  ComponentPropValue v;
  v.guidValue = content;
  writeAssignment(d.level, def, v);
  deriving_ = prev;
  return content;
}

// ---- Edits that reach instances --------------------------------------------------------------------

void Editor::writeOverride(Guid instance, const std::vector<Guid>& path, FieldMask fields, const NodeProps& values) {
  const Node* rn = doc_.get(instance);
  if (!rn || rn->props.type != NodeType::INSTANCE || !fields) return;
  SymbolData sd = rn->props.symbolData;
  auto it = std::find_if(sd.overrides.begin(), sd.overrides.end(), [&](const SymbolOverride& o) { return o.path == path; });
  if (it == sd.overrides.end()) {
    sd.overrides.push_back({path, 0, {}});
    it = sd.overrides.end() - 1;
  }
  NodeProps filtered = values;
  if (fields & F_EXTRA) {
    filtered.extra.clear();
    for (auto& [k, v] : values.extra)
      if (overridableExtra(k)) filtered.extra[k] = v;
    if (filtered.extra.empty()) fields &= ~static_cast<FieldMask>(F_EXTRA);
  }
  mergeInto(it->props, filtered, fields);
  it->mask |= fields;
  NodeChange c = NodeChange::changed(instance);
  c.mask = F_SYMBOL_DATA;
  c.props.symbolData = sd;
  write(c);
}

void Editor::writeAssignment(Guid level, Guid def, const ComponentPropValue& value) {
  ComponentPropAssignment a;
  a.defID = def;
  a.value = value;
  if (!level.isDerived()) {
    const Node* n = doc_.get(level);
    if (!n) return;
    NodeChange c = NodeChange::changed(level);
    c.mask = F_COMPONENT_PROP_ASSIGNMENTS;
    c.props.componentPropAssignments = n->props.componentPropAssignments;
    setAssign(c.props.componentPropAssignments, a);
    write(c);
    return;
  }
  auto info = derivedInfo_.find(level);
  if (info == derivedInfo_.end()) return;
  const DerivedInfo d = info->second;
  const Node* rn = doc_.get(d.instance);
  if (!rn) return;
  NodeProps values;
  for (const SymbolOverride& o : rn->props.symbolData.overrides)
    if (o.path == d.path && (o.mask & F_COMPONENT_PROP_ASSIGNMENTS)) values.componentPropAssignments = o.props.componentPropAssignments;
  setAssign(values.componentPropAssignments, a);
  writeOverride(d.instance, d.path, F_COMPONENT_PROP_ASSIGNMENTS, values);
}

void Editor::recordRootOverride(Guid instance, const NodeChange& change, const std::vector<ParamBinding>* mapBefore) {
  FieldMask mask = change.mask & kOverridable & ~(kOwnFields | static_cast<FieldMask>(F_COMPONENT_PROP_ASSIGNMENTS));
  if (!mask) return;
  if ((mask & F_PARAM_MAP) && mapBefore) {
    // Only the bindings that changed (sparse, per field).
    NodeProps values = change.props;
    values.parameterConsumptionMap = paramDiff(*mapBefore, change.props.parameterConsumptionMap);
    writeOverride(instance, {}, mask, values);
    return;
  }
  writeOverride(instance, {}, mask, change.props);
}

void Editor::writeDerived(const NodeChange& change) {
  if (change.phase != Phase::CHANGED) return;  // layers can't be added to or removed from an instance
  const Node* n = doc_.get(change.guid);
  auto info = derivedInfo_.find(change.guid);
  if (!n || info == derivedInfo_.end()) return;
  NodeChange edit = change;
  edit.mask = differingFields(n->props, change.props, change.mask & kOverridable);
  // A user's edit of a bound value detaches the variable or style (an override of the binding).
  if (!resolving_ && edit.mask && n->props.hasBindings()) detachEdited(n->props, edit);
  FieldMask mask = differingFields(n->props, edit.props, edit.mask & kOverridable);
  if (mask & F_TEXT_DATA) mask &= ~static_cast<FieldMask>(F_NAME | F_AUTO_RENAME);  // a text in an instance keeps its layer name
  if (!mask) return;
  const DerivedInfo d = info->second;
  NodeChange shown = NodeChange::changed(change.guid);
  shown.mask = mask;
  copyFields(shown.props, edit.props, mask);
  // A field bound to a component property sets that property's value where it is defined (docs/schema.md §5.3).
  if (const Node* src = doc_.get(d.source)) {
    for (const ParamBinding& b : src->props.parameterConsumptionMap) {
      if (b.propRef == kNoGuid) continue;
      ComponentPropValue v;
      FieldMask bit = 0;
      if (b.field == VariableField::VISIBLE && (mask & F_VISIBLE)) {
        bit = F_VISIBLE;
        v.hasBool = true;
        v.boolValue = edit.props.visible;
      } else if (b.field == VariableField::TEXT_DATA && (mask & F_TEXT_DATA)) {
        bit = F_TEXT_DATA;
        v.hasText = true;
        v.textValue = edit.props.textData;
      } else if (b.field == VariableField::OVERRIDDEN_SYMBOL_ID && (mask & F_OVERRIDDEN_SYMBOL_ID)) {
        bit = F_OVERRIDDEN_SYMBOL_ID;
        v.guidValue = edit.props.overriddenSymbolID;
      }
      if (!bit) continue;
      writeAssignment(d.level, b.propRef, v);
      mask &= ~bit;
    }
  }
  // Bindings go into the override entry sparsely (only the fields that changed).
  if (mask & F_PARAM_MAP) edit.props.parameterConsumptionMap = paramDiff(n->props.parameterConsumptionMap, edit.props.parameterConsumptionMap);
  if (mask) writeOverride(d.instance, d.path, mask, edit.props);
  shown.mask &= ~static_cast<FieldMask>(F_OVERRIDDEN_SYMBOL_ID | F_COMPONENT_PROP_ASSIGNMENTS);
  if (shown.mask) applyDerivedDirect(shown);
  instanceDirty_.insert(d.instance);
}

void Editor::composedOverrides(Guid nested, std::vector<SymbolOverride>& out, std::vector<ComponentPropAssignment>& assigns) const {
  // A derived nested instance's overrides relative to it: the usage site's (every level above) over its own.
  out.clear();
  auto info = derivedInfo_.find(nested);
  if (info == derivedInfo_.end()) return;
  const DerivedInfo& d = info->second;
  const Node* nn = doc_.get(nested);
  if (nn) assigns = nn->props.componentPropAssignments;
  auto addRelative = [&](const std::vector<SymbolOverride>& list, const std::vector<Guid>& base, bool over) {
    // `base`: where `list`'s paths start, from the top-level instance.
    for (const SymbolOverride& o : list) {
      std::vector<Guid> full = base;
      full.insert(full.end(), o.path.begin(), o.path.end());
      if (full.size() < d.path.size() || !std::equal(d.path.begin(), d.path.end(), full.begin())) continue;
      std::vector<Guid> rel(full.begin() + static_cast<long>(d.path.size()), full.end());
      auto it = std::find_if(out.begin(), out.end(), [&](const SymbolOverride& q) { return q.path == rel; });
      if (it == out.end()) {
        out.push_back({rel, o.mask, o.props});
      } else if (over) {
        mergeInto(it->props, o.props, o.mask);
        it->mask |= o.mask;
      } else {
        FieldMask fresh = o.mask & ~it->mask;
        mergeInto(it->props, o.props, fresh);
        it->mask |= fresh;
      }
    }
  };
  // Highest priority first: the top-level instance, then each nested real instance down to this one.
  const Node* top = doc_.get(d.instance);
  if (top) addRelative(top->props.symbolData.overrides, {}, false);
  for (size_t len = 1; len <= d.path.size(); len++) {
    std::vector<Guid> prefix(d.path.begin(), d.path.begin() + static_cast<long>(len));
    Guid row = derived::intern(d.instance, prefix);
    auto ri = derivedInfo_.find(row);
    if (ri == derivedInfo_.end()) continue;
    const Node* src = doc_.get(ri->second.source);
    if (!src || src->props.type != NodeType::INSTANCE || src->props.symbolData.symbolID != ri->second.symbol) continue;
    addRelative(src->props.symbolData.overrides, prefix, false);
  }
  // The root entry's fields are the nested instance's own now; overridden-symbol entries describe the swap itself.
  for (auto& o : out)
    if (o.path.empty()) o.mask &= ~static_cast<FieldMask>(F_OVERRIDDEN_SYMBOL_ID | F_COMPONENT_PROP_ASSIGNMENTS);
  out.erase(std::remove_if(out.begin(), out.end(), [](const SymbolOverride& o) { return o.mask == 0; }), out.end());
}

}  // namespace eng
