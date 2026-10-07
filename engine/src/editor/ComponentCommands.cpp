// Component commands (docs/engine-build.md "E6", R4): Create component, Combine
// as variants, Add variant, Detach instance, Reset (all changes or one
// property), Push changes to main component, Go to main component / Return to
// instance, Swap instance, component properties (values on instances,
// definitions and bindings on mains), Restore component, exposed nested
// instances, slots; and componentInfo, what the panels read.

#include <algorithm>
#include <cmath>
#include <map>
#include <unordered_set>

#include "base/DerivedIds.h"
#include "base/FractionalIndex.h"
#include "editor/Editor.h"
#include "hit/HitTest.h"
#include "scene/CodecJson.h"

namespace eng {

namespace {

using GuidSet = std::unordered_set<Guid, GuidHash>;

// Property definition ids come from the top of the session's range (the editor's nextDefId does the same).
constexpr uint32_t kDefIdBase = 0x7ff00000u, kDefIdTop = 0x7fffffffu;
// Component sets: Figma's dashed purple stroke, 20 px around their variants.
constexpr double kSetPadding = 20;
const Color kComponentPurple = Color::hex(0x9747FF);

const json::Value* arg(const CommandArgs& a, const char* key) { return a.raw.isObject() ? a.raw.get(key) : nullptr; }

std::string argString(const CommandArgs& a, const char* key) {
  const json::Value* v = arg(a, key);
  return v && v->isString() ? v->string : std::string();
}

std::string trim(const std::string& s) {
  size_t b = s.find_first_not_of(" \t"), e = s.find_last_not_of(" \t");
  return b == std::string::npos ? std::string() : s.substr(b, e - b + 1);
}

std::vector<std::string> split(const std::string& s, char sep) {
  std::vector<std::string> out;
  size_t start = 0;
  while (true) {
    size_t at = s.find(sep, start);
    out.push_back(s.substr(start, at == std::string::npos ? std::string::npos : at - start));
    if (at == std::string::npos) break;
    start = at + 1;
  }
  return out;
}

// "Size=Large, State=Hover" → pairs; false when the name isn't a variant name.
bool parseVariantName(const std::string& name, std::vector<std::pair<std::string, std::string>>& out) {
  out.clear();
  for (const std::string& part : split(name, ',')) {
    std::string p = trim(part);
    if (p.empty()) continue;
    size_t eq = p.find('=');
    if (eq == std::string::npos || eq == 0) return false;
    out.push_back({trim(p.substr(0, eq)), trim(p.substr(eq + 1))});
  }
  return !out.empty();
}

ComponentPropValue textValue(const std::string& s) {
  ComponentPropValue v;
  v.hasText = true;
  v.textValue.characters = s;
  return v;
}

std::string valueText(const ComponentPropValue& v) { return v.hasText ? v.textValue.characters : std::string(); }

ParamBinding propBinding(VariableField field, Guid def) {
  ParamBinding b;
  b.field = field;
  b.propRef = def;
  return b;
}

VariableField bindingFieldOf(ComponentPropType t) {
  switch (t) {
    case ComponentPropType::BOOL: return VariableField::VISIBLE;
    case ComponentPropType::TEXT: return VariableField::TEXT_DATA;
    case ComponentPropType::INSTANCE_SWAP: return VariableField::OVERRIDDEN_SYMBOL_ID;
    case ComponentPropType::SLOT: return VariableField::SLOT_CONTENT_ID;
    default: return VariableField::MISSING;
  }
}

bool propTypeFromName(const std::string& s, ComponentPropType& t) {
  if (s == "BOOLEAN" || s == "BOOL") return t = ComponentPropType::BOOL, true;
  if (s == "TEXT") return t = ComponentPropType::TEXT, true;
  if (s == "INSTANCE_SWAP") return t = ComponentPropType::INSTANCE_SWAP, true;
  if (s == "VARIANT") return t = ComponentPropType::VARIANT, true;
  if (s == "SLOT") return t = ComponentPropType::SLOT, true;
  return false;
}

}  // namespace

// ---- Helpers ------------------------------------------------------------------------------

std::vector<Guid> Editor::refsArg(const CommandArgs& args, const char* key) const {
  const json::Value* v = arg(args, key);
  std::vector<Guid> out;
  if (v && v->isString()) {
    bool ok = false;
    Guid g = Guid::parse(v->string, &ok);
    if (ok) out.push_back(g);
    return out;
  }
  if (v && v->isArray()) {
    for (auto& e : v->array) {
      bool ok = false;
      Guid g = e.isString() ? Guid::parse(e.string, &ok) : Guid{};
      if (ok) out.push_back(g);
    }
    return out;
  }
  return selection_;
}

Guid Editor::propOwner(Guid ref) const {
  for (Guid cur = ref; doc_.has(cur) && !cur.isDerived(); cur = doc_.parentOf(cur)) {
    const Node* n = doc_.get(cur);
    if (n->props.isComponentSet()) return cur;
    if (n->props.type == NodeType::SYMBOL) {
      Guid set = setOf(cur);
      return set != kNoGuid ? set : cur;
    }
    if (n->props.type == NodeType::CANVAS) break;
  }
  return kNoGuid;
}

const ComponentPropDef* Editor::findDef(Guid owner, const std::string& prop) const {
  const Node* n = doc_.get(owner);
  if (!n) return nullptr;
  bool ok = false;
  Guid id = Guid::parse(prop, &ok);
  for (const ComponentPropDef& d : n->props.componentPropDefs) {
    if (ok && d.id == id) return &d;
    if (d.name == prop || d.name + "#" + d.id.toString() == prop) return &d;
  }
  return nullptr;
}

uint32_t Editor::instanceCount(Guid symbol) const {
  const Node* sn = doc_.get(symbol);
  if (!sn) return 0;
  GuidSet mains{symbol};
  if (sn->props.isComponentSet())
    for (Guid c : doc_.children(symbol)) mains.insert(c);
  uint32_t count = 0;
  doc_.forEach([&](const Node& n) {
    if (!n.guid.isDerived() && n.props.type == NodeType::INSTANCE && mains.count(n.props.symbolData.symbolID)) count++;
  });
  return count;
}

Guid Editor::internalCanvas(bool create) {
  Guid found = kNoGuid;
  doc_.forEach([&](const Node& n) {
    if (n.props.type == NodeType::CANVAS && n.props.internalOnly) found = n.guid;
  });
  if (found != kNoGuid || !create) return found;
  Guid docId = documentNode();
  if (!doc_.has(docId)) return kNoGuid;
  NodeProps p;
  p.type = NodeType::CANVAS;
  p.name = "Internal Only Canvas";
  p.internalOnly = true;
  p.parentIndex = {docId, doc_.positionAtEnd(docId)};
  Guid id = newGuid();
  write(NodeChange::created(id, p));
  return id;
}

void Editor::keepKeys(Guid src, NodeProps& p) const {
  const Node* n = doc_.get(src);
  if (n) p.overrideKey = n->props.keyOf(src);
}

Guid Editor::createInstance(Guid symbol, Guid parent, const std::string& position, const Mat2x3& transform) {
  const Node* mn = doc_.get(symbol);
  if (!mn || mn->props.type != NodeType::SYMBOL) return kNoGuid;
  NodeProps own;
  own.type = NodeType::INSTANCE;
  own.symbolData.symbolID = symbol;
  own.parentIndex = {parent, position};
  own.transform = transform;
  own.horizontalConstraint = mn->props.horizontalConstraint;
  own.verticalConstraint = mn->props.verticalConstraint;
  NodeProps p = instanceRoot(own, mn->props, symbol);
  Guid id = newGuid();
  write(NodeChange::created(id, p));
  return id;
}

void Editor::renameVariants(Guid set) {
  const Node* sn = doc_.get(set);
  if (!sn) return;
  std::vector<ComponentPropDef> defs = sn->props.componentPropDefs;
  for (Guid v : std::vector<Guid>(doc_.children(set))) {
    const Node* vn = doc_.get(v);
    if (!vn || vn->props.type != NodeType::SYMBOL) continue;
    std::string name;
    for (const ComponentPropDef& d : defs) {
      if (d.type != ComponentPropType::VARIANT) continue;
      std::string value;
      for (const VariantPropSpec& s : vn->props.variantPropSpecs)
        if (s.propDefId == d.id) value = s.value;
      if (!name.empty()) name += ", ";
      name += d.name + "=" + value;
    }
    if (name.empty()) continue;
    NodeChange c = NodeChange::changed(v);
    c.mask = F_NAME;
    c.props.name = name;
    write(c);
  }
}

// The default variant of a set: its top-left one (R4 §5).
static Guid defaultVariantOf(const Document& doc, Guid set) {
  Guid best = kNoGuid;
  double bx = 0, by = 0;
  for (Guid v : doc.children(set)) {
    const Node* n = doc.get(v);
    if (!n || n->props.type != NodeType::SYMBOL) continue;
    double x = n->props.transform.m02, y = n->props.transform.m12;
    if (best == kNoGuid || y < by - 0.5 || (std::fabs(y - by) <= 0.5 && x < bx)) best = v, bx = x, by = y;
  }
  return best;
}

std::vector<ComponentProperty> Editor::propertiesOf(Guid level, Guid symbol) const {
  std::vector<ComponentProperty> out;
  const std::vector<ComponentPropDef>* defs = defsOf(symbol);
  const Node* sn = doc_.get(symbol);
  if (!defs || !sn) return out;
  Guid set = setOf(symbol);
  std::vector<ComponentPropAssignment> assigns;
  if (level != kNoGuid) assigns = assignmentsOf(level);
  // Which assignments the usage site set itself (for "overridden").
  GuidSet usage;
  if (level != kNoGuid) {
    if (!level.isDerived()) {
      for (auto& a : assigns) usage.insert(a.defID);
    } else if (auto info = derivedInfo_.find(level); info != derivedInfo_.end()) {
      if (const Node* top = doc_.get(info->second.instance))
        for (const SymbolOverride& o : top->props.symbolData.overrides)
          if (o.path == info->second.path && (o.mask & F_COMPONENT_PROP_ASSIGNMENTS))
            for (auto& a : o.props.componentPropAssignments) usage.insert(a.defID);
    }
  }
  // The layers bound to each property: in the main, or (for an instance) as its derived ids.
  std::map<Guid, std::vector<Guid>> bound;
  std::vector<Guid> levelPath;
  Guid top = level;
  if (level.isDerived())
    if (auto info = derivedInfo_.find(level); info != derivedInfo_.end()) levelPath = info->second.path, top = info->second.instance;
  auto visit = [&](auto&& self, Guid node, std::vector<Guid> rel) -> void {
    for (Guid c : doc_.children(node)) {
      if (c.isDerived()) continue;
      const Node* cn = doc_.get(c);
      if (!cn) continue;
      std::vector<Guid> path = rel;
      path.push_back(cn->props.keyOf(c));
      for (const ParamBinding& b : cn->props.parameterConsumptionMap) {
        if (b.propRef == kNoGuid) continue;
        if (level == kNoGuid) {
          bound[b.propRef].push_back(c);
        } else {
          std::vector<Guid> full = levelPath;
          full.insert(full.end(), path.begin(), path.end());
          bound[b.propRef].push_back(derived::intern(top, full));
        }
      }
      if (cn->props.type != NodeType::INSTANCE) self(self, c, path);
    }
  };
  if (set != kNoGuid && level == kNoGuid) {
    for (Guid v : doc_.children(set)) visit(visit, v, {});
  } else {
    visit(visit, symbol, {});
  }
  std::vector<const ComponentPropDef*> sorted;
  for (const auto& d : *defs) sorted.push_back(&d);
  std::stable_sort(sorted.begin(), sorted.end(), [](const ComponentPropDef* a, const ComponentPropDef* b) {
    bool va = a->type == ComponentPropType::VARIANT, vb = b->type == ComponentPropType::VARIANT;
    if (va != vb) return va;
    if (!a->sortPosition.empty() && !b->sortPosition.empty() && a->sortPosition != b->sortPosition) return a->sortPosition < b->sortPosition;
    return false;
  });
  Guid defaultVariant = set != kNoGuid ? defaultVariantOf(doc_, set) : kNoGuid;
  // Preferred values that name mains by asset key (a library copy's, a .fig's) resolve within the main's own library:
  // its library's copies; for a local main, this file's own asset, else a copy (first by GUID).
  Guid copyRoot = libraryRootOf(symbol);
  std::string library = copyRoot != kNoGuid ? doc_.get(copyRoot)->props.sourceLibraryKey : std::string();
  auto isMain = [](const NodeProps& p) { return (p.type == NodeType::SYMBOL || p.isComponentSet()) && !p.isSoftDeleted; };
  auto mainByKey = [&](const std::string& key) {
    if (!library.empty()) return copyMainByKey(library, key);
    Guid local = localAssetByKey(key);
    if (local != kNoGuid && isMain(doc_.get(local)->props)) return local;
    Guid any = kNoGuid;
    doc_.forEach([&](const Node& n) {
      if (!n.guid.isDerived() && n.props.key == key && isMain(n.props) && isLibraryCopy(n.guid) && (any == kNoGuid || n.guid < any)) any = n.guid;
    });
    return any;
  };
  for (const ComponentPropDef* d : sorted) {
    ComponentProperty p;
    p.id = d->id;
    p.name = d->name;
    p.type = d->type;
    p.defaultValue = d->initialValue;
    p.value = d->initialValue;
    for (const PreferredValue& pv : d->preferredValues) {
      bool ok = false;
      Guid g = Guid::parse(pv.key, &ok);
      // A library copy's (and a .fig's) preferred values name mains by asset key.
      if (!ok && pv.key.size() == 40) {
        g = mainByKey(pv.key);
        ok = g != kNoGuid;
      }
      if (ok) p.preferredValues.push_back(g);
    }
    if (d->type == ComponentPropType::VARIANT) {
      // Values in the set's order, then as the variants have them.
      if (const Node* setNode = doc_.get(set)) {
        for (const StateGroupOrder& o : setNode->props.stateGroupPropertyValueOrders)
          if (o.property == d->name) p.variantOptions = o.values;
        for (Guid v : doc_.children(set)) {
          const Node* vn = doc_.get(v);
          if (!vn) continue;
          for (const VariantPropSpec& s : vn->props.variantPropSpecs)
            if (s.propDefId == d->id && std::find(p.variantOptions.begin(), p.variantOptions.end(), s.value) == p.variantOptions.end())
              p.variantOptions.push_back(s.value);
        }
      }
      auto specOf = [&](Guid v) {
        const Node* vn = doc_.get(v);
        if (vn)
          for (const VariantPropSpec& s : vn->props.variantPropSpecs)
            if (s.propDefId == d->id) return s.value;
        return std::string();
      };
      p.defaultVariant = specOf(defaultVariant);
      p.variantValue = specOf(symbol);
      p.defaultValue = textValue(p.defaultVariant);
      p.value = textValue(level != kNoGuid ? p.variantValue : p.defaultVariant);
    } else {
      for (const auto& a : assigns)
        if (a.defID == d->id && !a.value.empty()) p.value = a.value;
      p.overridden = usage.count(d->id) != 0;
      p.boundLayers = bound[d->id];
    }
    out.push_back(std::move(p));
  }
  return out;
}

bool Editor::componentInfo(Guid id, ComponentInfo& out) const {
  out = ComponentInfo{};
  const Node* n = doc_.get(id);
  if (!n) return false;
  out.ref = id;
  auto setMain = [&](Guid main) {
    const Node* mn = doc_.get(main);
    if (!mn) return;
    out.main = main;
    out.mainName = mn->props.name;
    out.mainPage = doc_.pageOf(main);
    out.mainSet = setOf(main);
    out.mainSoftDeleted = mn->props.isSoftDeleted || (out.mainSet != kNoGuid && doc_.get(out.mainSet)->props.isSoftDeleted);
    out.mainDeleted = out.mainSoftDeleted;
    Guid copyRoot = libraryRootOf(main);
    if (copyRoot != kNoGuid) {
      const NodeProps& rp = doc_.get(copyRoot)->props;
      out.mainRemote = true;
      out.mainLibraryKey = rp.sourceLibraryKey;
      out.mainKey = mn->props.key.empty() ? rp.key : mn->props.key;
      out.mainVersion = rp.version;
    }
    out.mainCopied = !out.mainRemote && isCopiedMain(main);
  };
  auto overridesOf = [&](Guid top, const std::vector<Guid>& under, bool exact) {
    const Node* tn = doc_.get(top);
    if (!tn) return;
    for (const SymbolOverride& o : tn->props.symbolData.overrides) {
      bool match = exact ? o.path == under
                         : o.path.size() >= under.size() && std::equal(under.begin(), under.end(), o.path.begin());
      if (!match) continue;
      ComponentInfo::Override e;
      e.ref = derived::intern(top, o.path);
      e.fields = codec::fieldKeys(o.mask & ~static_cast<FieldMask>(F_EXTRA));
      if (o.mask & F_EXTRA)
        for (auto& [k, v] : o.props.extra) e.fields.push_back(k);
      out.overrides.push_back(std::move(e));
    }
  };
  auto exposedOf = [&](Guid level) {
    auto rows = derivedRows_.find(derived::instanceOf(level));
    if (rows == derivedRows_.end()) return;
    for (Guid r : rows->second) {
      auto ri = derivedInfo_.find(r);
      if (ri == derivedInfo_.end() || ri->second.level != level) continue;
      const Node* rn = doc_.get(r);
      const Node* src = doc_.get(ri->second.source);
      if (!rn || !src || rn->props.type != NodeType::INSTANCE || !src->props.propsAreBubbled) continue;
      out.exposedInstances.push_back({r, rn->props.name, propertiesOf(r, ri->second.symbol)});
    }
  };
  auto variantPropsOf = [&](Guid symbol) {
    Guid set = setOf(symbol);
    const Node* sn = doc_.get(set);
    const Node* vn = doc_.get(symbol);
    if (!sn || !vn) return;
    out.hasVariantProperties = true;
    for (const ComponentPropDef& d : sn->props.componentPropDefs) {
      if (d.type != ComponentPropType::VARIANT) continue;
      std::string value;
      for (const VariantPropSpec& s : vn->props.variantPropSpecs)
        if (s.propDefId == d.id) value = s.value;
      out.variantProperties.push_back({d.name, value});
    }
  };

  if (id.isDerived()) {
    auto info = derivedInfo_.find(id);
    if (info == derivedInfo_.end()) return true;
    out.instance = info->second.instance;
    out.path = info->second.path;
    if (n->props.type == NodeType::INSTANCE) {
      out.kind = ComponentInfo::Kind::NESTED_INSTANCE;
      setMain(info->second.symbol);
      out.properties = propertiesOf(id, info->second.symbol);
      variantPropsOf(info->second.symbol);
      overridesOf(info->second.instance, info->second.path, false);
      const Node* src = doc_.get(info->second.source);
      out.isExposed = src && src->props.propsAreBubbled;
      exposedOf(id);
      out.canDetach = true;
    } else {
      out.kind = ComponentInfo::Kind::INSTANCE_SUBLAYER;
      setMain(mainOf(info->second.level));
      overridesOf(info->second.instance, info->second.path, true);
    }
    out.canReset = !out.overrides.empty();
    return true;
  }
  const NodeProps& p = n->props;
  if (p.type == NodeType::INSTANCE) {
    out.kind = ComponentInfo::Kind::INSTANCE;
    Guid main = symbolOf(p);
    setMain(main);
    if (main == kNoGuid) out.mainDeleted = true;
    out.properties = propertiesOf(id, main);
    variantPropsOf(main);
    overridesOf(id, {}, false);
    exposedOf(id);
    bool insideMain = false;
    for (Guid cur = doc_.parentOf(id); doc_.has(cur); cur = doc_.parentOf(cur)) insideMain |= doc_.get(cur)->props.type == NodeType::SYMBOL;
    out.canPush = main != kNoGuid && !out.mainSoftDeleted && !out.mainRemote && !out.mainCopied && !insideMain &&
                  !p.symbolData.overrides.empty();
    out.canReset = !p.symbolData.overrides.empty() || !p.componentPropAssignments.empty();
    out.canDetach = true;
    return true;
  }
  if (p.type == NodeType::SYMBOL) {
    out.kind = setOf(id) != kNoGuid ? ComponentInfo::Kind::VARIANT : ComponentInfo::Kind::COMPONENT;
    setMain(id);
    out.properties = propertiesOf(kNoGuid, id);
    variantPropsOf(id);
    out.instanceCount = instanceCount(id);
    return true;
  }
  if (p.isComponentSet()) {
    out.kind = ComponentInfo::Kind::COMPONENT_SET;
    Guid def = defaultVariantOf(doc_, id);
    if (def != kNoGuid) out.properties = propertiesOf(kNoGuid, def);
    out.instanceCount = instanceCount(id);
    out.mainSoftDeleted = p.isSoftDeleted;
    return true;
  }
  for (Guid cur = doc_.parentOf(id); doc_.has(cur); cur = doc_.parentOf(cur)) {
    if (doc_.get(cur)->props.type == NodeType::SYMBOL) {
      out.kind = ComponentInfo::Kind::COMPONENT_SUBLAYER;
      setMain(cur);
      break;
    }
  }
  return true;
}

// ---- Dispatch -------------------------------------------------------------------------------

uint32_t Editor::componentCommandState(CommandId id) const {
  auto anyOf = [&](auto pred) {
    for (Guid s : selection_) {
      const Node* n = doc_.get(s);
      if (n && pred(s, n->props)) return true;
    }
    return false;
  };
  switch (id) {
    case CommandId::CREATE_COMPONENT:
      return !selection_.empty() && !anyOf([](Guid g, const NodeProps& p) { return g.isDerived() || p.type == NodeType::SYMBOL || p.isComponentSet(); })
                 ? CMD_ENABLED
                 : 0;
    case CommandId::COMBINE_AS_VARIANTS:
      return !selection_.empty() &&
                     !anyOf([&](Guid g, const NodeProps& p) { return g.isDerived() || p.type != NodeType::SYMBOL || setOf(g) != kNoGuid; })
                 ? CMD_ENABLED
                 : 0;
    case CommandId::ADD_VARIANT:
      return selection_.size() == 1 && !selection_[0].isDerived() && propOwner(selection_[0]) != kNoGuid &&
                     (doc_.get(selection_[0])->props.type == NodeType::SYMBOL || doc_.get(selection_[0])->props.isComponentSet())
                 ? CMD_ENABLED
                 : 0;
    case CommandId::DETACH_INSTANCE:
      return anyOf([](Guid, const NodeProps& p) { return p.type == NodeType::INSTANCE; }) ? CMD_ENABLED : 0;
    case CommandId::RESET_OVERRIDES:
      for (Guid s : selection_) {
        ComponentInfo info;
        if (componentInfo(s, info) && info.canReset) return CMD_ENABLED;
      }
      return 0;
    case CommandId::PUSH_CHANGES_TO_MAIN: {
      ComponentInfo info;
      return selection_.size() == 1 && componentInfo(selection_[0], info) && info.canPush ? CMD_ENABLED : 0;
    }
    case CommandId::GO_TO_MAIN_COMPONENT: {
      Guid main = selection_.size() == 1 ? mainOf(selection_[0]) : kNoGuid;
      return main != kNoGuid && !isLibraryCopy(main) && !isCopiedMain(main) ? CMD_ENABLED : 0;
    }
    case CommandId::RETURN_TO_INSTANCE: return doc_.has(returnTo_) ? CMD_ENABLED : 0;
    case CommandId::SWAP_INSTANCE:
    case CommandId::SET_COMPONENT_PROPERTY:
      return anyOf([](Guid, const NodeProps& p) { return p.type == NodeType::INSTANCE; }) ? CMD_ENABLED : 0;
    case CommandId::ADD_COMPONENT_PROPERTY:
    case CommandId::EDIT_COMPONENT_PROPERTY:
    case CommandId::DELETE_COMPONENT_PROPERTY:
      return selection_.size() == 1 && !selection_[0].isDerived() && propOwner(selection_[0]) != kNoGuid ? CMD_ENABLED : 0;
    case CommandId::BIND_COMPONENT_PROPERTY:
      return !selection_.empty() && !anyOf([&](Guid g, const NodeProps&) { return g.isDerived() || propOwner(g) == kNoGuid; }) ? CMD_ENABLED : 0;
    case CommandId::RESTORE_COMPONENT:
      for (Guid s : selection_) {
        ComponentInfo info;
        if (componentInfo(s, info) && info.mainSoftDeleted) return CMD_ENABLED;
      }
      return 0;
    case CommandId::SET_EXPOSED_INSTANCE:
      return selection_.size() == 1 && !selection_[0].isDerived() && doc_.get(selection_[0])->props.type == NodeType::INSTANCE &&
                     propOwner(doc_.parentOf(selection_[0])) != kNoGuid
                 ? CMD_ENABLED
                 : 0;
    case CommandId::RESET_SLOT: return !selection_.empty() ? CMD_ENABLED : 0;
    case CommandId::INSERT_INSTANCE: return doc_.has(page_) ? CMD_ENABLED : 0;
    case CommandId::SET_VARIANT_PROPERTIES:
      return selection_.size() == 1 && !selection_[0].isDerived() && setOf(selection_[0]) != kNoGuid ? CMD_ENABLED : 0;
    default: return 0;
  }
}

Status Editor::componentCommand(CommandId id, const CommandArgs& args) {
  auto oneRef = [&]() {
    std::vector<Guid> r = refsArg(args, "ref");
    return r.empty() ? kNoGuid : r[0];
  };
  switch (id) {
    case CommandId::CREATE_COMPONENT: return createComponent(argString(args, "mode"));
    case CommandId::COMBINE_AS_VARIANTS: {
      std::vector<Guid> top;
      for (Guid g : topSelectionInPaintOrder())
        if (!g.isDerived() && doc_.get(g)->props.type == NodeType::SYMBOL && setOf(g) == kNoGuid) top.push_back(g);
      if (top.empty()) return E_INVALID;
      begin(TxnKind::USER, "Combine as variants");
      Guid set = kNoGuid;
      Status st = combineAsVariants(top, &set);
      if (set != kNoGuid) changeSelection({set});
      commit();
      return st;
    }
    case CommandId::ADD_VARIANT: return addVariant();
    case CommandId::DETACH_INSTANCE: return detachInstance(refsArg(args, "ref"));
    case CommandId::RESET_OVERRIDES: {
      std::vector<std::string> fields;
      if (!argString(args, "field").empty()) fields.push_back(argString(args, "field"));
      if (const json::Value* list = arg(args, "fields"); list && list->isArray())
        for (auto& f : list->array)
          if (f.isString()) fields.push_back(f.string);
      return resetOverrides(refsArg(args, "ref"), fields);
    }
    case CommandId::INSERT_INSTANCE: {
      bool ok = false;
      Guid main = Guid::parse(argString(args, "main"), &ok);
      if (!ok) return E_INVALID;
      return insertInstance(main, args);
    }
    case CommandId::SET_VARIANT_PROPERTIES: return setVariantProperties(oneRef(), args);
    case CommandId::PUSH_CHANGES_TO_MAIN: return pushChangesToMain(oneRef());
    case CommandId::GO_TO_MAIN_COMPONENT: return goToMainComponent(oneRef());
    case CommandId::RETURN_TO_INSTANCE: return returnToInstanceCmd();
    case CommandId::SWAP_INSTANCE: {
      bool ok = false;
      Guid main = Guid::parse(argString(args, "main"), &ok);
      if (!ok) return E_INVALID;
      return swapInstance(refsArg(args, "ref"), main);
    }
    case CommandId::SET_COMPONENT_PROPERTY: {
      const json::Value* v = arg(args, "value");
      if (!v) return E_INVALID;
      return setComponentProperty(oneRef(), argString(args, "prop"), *v);
    }
    case CommandId::ADD_COMPONENT_PROPERTY: return addComponentProperty(oneRef(), args);
    case CommandId::EDIT_COMPONENT_PROPERTY: return editComponentProperty(oneRef(), args);
    case CommandId::DELETE_COMPONENT_PROPERTY: return deleteComponentProperty(oneRef(), argString(args, "prop"));
    case CommandId::BIND_COMPONENT_PROPERTY: return bindComponentProperty(refsArg(args, "refs"), argString(args, "field"), argString(args, "prop"));
    case CommandId::RESTORE_COMPONENT: return restoreComponent(oneRef());
    case CommandId::SET_EXPOSED_INSTANCE: {
      const json::Value* v = arg(args, "exposed");
      return setExposedInstance(oneRef(), !v || (v->isBool() ? v->boolean : v->numberOr(1) != 0));
    }
    case CommandId::RESET_SLOT: return resetSlot(oneRef());
    default: return E_UNSUPPORTED;
  }
}

// ---- Create component, combine as variants, add variant ----------------------------------------

Guid Editor::makeComponentFrom(Guid node) {
  const Node* n = doc_.get(node);
  if (!n || node.isDerived()) return kNoGuid;
  const NodeProps& p = n->props;
  if (p.type == NodeType::SYMBOL) return node;
  if (p.type == NodeType::FRAME && !p.resizeToFit && !p.isStateGroup) {
    // A frame becomes the component itself (same GUID).
    NodeChange c = NodeChange::changed(node);
    c.mask = F_TYPE;
    c.props.type = NodeType::SYMBOL;
    write(c);
    return node;
  }
  // Anything else is nested in a new component frame at its bounds (a group gives its layers to it).
  std::vector<Guid> saved = selection_;
  bool group = p.isGroupLike();
  std::string name = p.name;
  std::vector<Guid> kids = group ? std::vector<Guid>(doc_.children(node)) : std::vector<Guid>{node};
  Guid parent = doc_.parentOf(node);
  const auto& siblings = doc_.children(parent);
  size_t index = static_cast<size_t>(std::find(siblings.begin(), siblings.end(), node) - siblings.begin());
  Mat2x3 toParent = doc_.worldTransform(parent).inverse();
  Rect u;
  bool any = false;
  for (Guid k : kids) {
    const Node* kn = doc_.get(k);
    Rect b = transformedBounds(toParent * doc_.worldTransform(k), kn->props.size.x, kn->props.size.y);
    u = any ? u.united(b) : b;
    any = true;
  }
  NodeProps c = defaultProps(NodeType::SYMBOL);
  c.name = name.empty() ? nextName("Component") : name;
  c.fillPaints.clear();
  c.frameMaskDisabled = true;
  c.transform = Mat2x3::translate(u.x, u.y);
  c.size = {u.w, u.h};
  c.parentIndex = {parent, placeManyAt(parent, index + 1, 1, GuidSet{node})[0]};
  Guid comp = newGuid();
  write(NodeChange::created(comp, c));
  auto keys = fractional::keysBetween("", std::nullopt, static_cast<int>(kids.size()));
  for (size_t i = 0; i < kids.size(); i++) reparent(kids[i], comp, keys[i]);
  if (group) write(NodeChange::removed(node));
  selection_ = saved;
  return comp;
}

Status Editor::createComponent(const std::string& modeArg) {
  std::vector<Guid> top;
  for (Guid g : topSelectionInPaintOrder()) {
    const Node* n = doc_.get(g);
    if (g.isDerived() || n->props.isComponentSet()) continue;
    top.push_back(g);
  }
  if (top.empty()) return E_INVALID;
  std::string mode = modeArg.empty() ? (top.size() == 1 ? "SINGLE" : "MULTIPLE") : modeArg;
  const char* label = mode == "SET" ? "Create component set" : mode == "MULTIPLE" ? "Create multiple components" : "Create component";
  begin(TxnKind::USER, label);
  std::vector<Guid> made;
  if (mode == "SINGLE" && top.size() > 1) {
    // Several layers: one component around them all.
    std::vector<Guid> saved = selection_;
    selection_ = top;
    Guid comp = wrapSelection("Component");
    selection_ = saved;
    if (comp != kNoGuid) made.push_back(comp);
  } else {
    for (Guid g : top) {
      Guid c = makeComponentFrom(g);
      if (c != kNoGuid) made.push_back(c);
    }
  }
  if (mode == "SET" && !made.empty()) {
    Guid set = kNoGuid;
    combineAsVariants(made, &set);
    if (set != kNoGuid) made = {set};
  }
  changeSelection(made);
  commit();
  return made.empty() ? E_INVALID : OK;
}

Status Editor::combineAsVariants(std::vector<Guid> symbols, Guid* setOut) {
  symbols.erase(std::remove_if(symbols.begin(), symbols.end(), [&](Guid g) {
    const Node* n = doc_.get(g);
    return !n || g.isDerived() || n->props.type != NodeType::SYMBOL || setOf(g) != kNoGuid;
  }), symbols.end());
  if (symbols.empty()) return E_INVALID;
  std::stable_sort(symbols.begin(), symbols.end(), [&](Guid a, Guid b) { return doc_.paintsBefore(a, b); });
  // Properties from the names (R4 §5): "Prop=Value, …" as they are; slash names give Variant, Property 2, ….
  std::vector<std::string> props;
  std::vector<std::vector<std::string>> values;
  std::vector<std::vector<std::pair<std::string, std::string>>> parsed(symbols.size());
  bool allParsed = true;
  for (size_t i = 0; i < symbols.size(); i++) allParsed &= parseVariantName(doc_.get(symbols[i])->props.name, parsed[i]);
  if (allParsed) {
    for (auto& ps : parsed)
      for (auto& [k, v] : ps)
        if (std::find(props.begin(), props.end(), k) == props.end()) props.push_back(k);
    for (auto& ps : parsed) {
      std::vector<std::string> row;
      for (auto& k : props) {
        std::string val = "Default";
        for (auto& [pk, pv] : ps)
          if (pk == k) val = pv;
        row.push_back(val);
      }
      values.push_back(row);
    }
  } else {
    std::vector<std::vector<std::string>> parts;
    size_t width = 1;
    for (Guid s : symbols) {
      std::vector<std::string> segs;
      for (auto& seg : split(doc_.get(s)->props.name, '/'))
        if (!trim(seg).empty()) segs.push_back(trim(seg));
      width = std::max(width, segs.size());
      parts.push_back(segs);
    }
    for (size_t i = 0; i < width; i++) props.push_back(i == 0 ? "Variant" : "Property " + std::to_string(i + 1));
    for (auto& segs : parts) {
      std::vector<std::string> row;
      for (size_t i = 0; i < width; i++) row.push_back(i < segs.size() ? segs[i] : "Default");
      values.push_back(row);
    }
  }
  // Unique combinations (Figma numbers a repeat).
  std::vector<std::string> seen;
  for (auto& row : values) {
    std::vector<std::string> r = row;
    for (int n = 2;; n++) {
      std::string key;
      for (auto& v : r) key += v + '\x1f';
      if (std::find(seen.begin(), seen.end(), key) == seen.end()) {
        seen.push_back(key);
        break;
      }
      r = row;
      r.back() += " " + std::to_string(n);
    }
    row = r;
  }
  // The set: around them, at the topmost one's place.
  Guid topmost = symbols.back();
  Guid parent = doc_.parentOf(topmost);
  GuidSet moving(symbols.begin(), symbols.end());
  size_t index = 0;
  for (Guid c : doc_.children(parent)) {
    if (c == topmost) break;
    if (!moving.count(c)) index++;
  }
  Mat2x3 toParent = doc_.worldTransform(parent).inverse();
  Rect u;
  for (size_t i = 0; i < symbols.size(); i++) {
    const Node* n = doc_.get(symbols[i]);
    Rect b = transformedBounds(toParent * doc_.worldTransform(symbols[i]), n->props.size.x, n->props.size.y);
    u = i ? u.united(b) : b;
  }
  NodeProps sp = defaultProps(NodeType::FRAME);
  std::string common;
  {
    auto first = split(doc_.get(symbols[0])->props.name, '/');
    bool shared = first.size() > 1 && !allParsed;
    for (Guid s : symbols) {
      auto segs = split(doc_.get(s)->props.name, '/');
      shared &= segs.size() > 1 && trim(segs[0]) == trim(first[0]);
    }
    if (shared) common = trim(first[0]);
  }
  sp.name = !common.empty() ? common : symbols.size() == 1 ? doc_.get(symbols[0])->props.name : nextName("Component");
  sp.isStateGroup = true;
  sp.fillPaints.clear();
  sp.strokePaints = {Paint::solid(kComponentPurple)};
  sp.strokeWeight = 1;
  sp.strokeAlign = StrokeAlign::INSIDE;
  sp.dashPattern = {10, 5};
  sp.cornerRadii = {5, 5, 5, 5};
  sp.frameMaskDisabled = true;
  sp.transform = Mat2x3::translate(u.x - kSetPadding, u.y - kSetPadding);
  sp.size = {u.w + 2 * kSetPadding, u.h + 2 * kSetPadding};
  sp.parentIndex = {parent, placeManyAt(parent, index, 1, moving)[0]};
  // Definitions: the variant properties, then every property the components had of their own.
  std::vector<Guid> used;
  doc_.forEach([&](const Node& n) {
    for (auto& d : n.props.componentPropDefs) used.push_back(d.id);
  });
  auto newId = [&]() {
    uint32_t low = kDefIdTop;
    for (Guid g : used)
      if (g.sessionID == sessionID_ && g.localID >= kDefIdBase && g.localID <= low) low = g.localID - 1;
    Guid id{sessionID_, low};
    used.push_back(id);
    return id;
  };
  std::vector<Guid> propIds;
  for (size_t i = 0; i < props.size(); i++) {
    ComponentPropDef d;
    d.id = newId();
    d.name = props[i];
    d.type = ComponentPropType::VARIANT;
    d.initialValue = textValue(values[0][i]);
    d.sortPosition = fractional::keysBetween("", std::nullopt, static_cast<int>(props.size()))[i];
    sp.componentPropDefs.push_back(d);
    propIds.push_back(d.id);
    StateGroupOrder order;
    order.property = props[i];
    for (auto& row : values)
      if (std::find(order.values.begin(), order.values.end(), row[i]) == order.values.end()) order.values.push_back(row[i]);
    sp.stateGroupPropertyValueOrders.push_back(order);
  }
  for (Guid s : symbols)
    for (const ComponentPropDef& d : doc_.get(s)->props.componentPropDefs) sp.componentPropDefs.push_back(d);
  Guid set = newGuid();
  write(NodeChange::created(set, sp));
  auto keys = fractional::keysBetween("", std::nullopt, static_cast<int>(symbols.size()));
  for (size_t i = 0; i < symbols.size(); i++) {
    reparent(symbols[i], set, keys[i]);
    NodeChange c = NodeChange::changed(symbols[i]);
    c.mask = F_VARIANT_PROP_SPECS | F_COMPONENT_PROP_DEFS | F_NAME;
    for (size_t k = 0; k < props.size(); k++) c.props.variantPropSpecs.push_back({propIds[k], values[i][k]});
    std::string name;
    for (size_t k = 0; k < props.size(); k++) name += (k ? ", " : "") + props[k] + "=" + values[i][k];
    c.props.name = name;
    write(c);
  }
  if (setOut) *setOut = set;
  return OK;
}

Status Editor::addVariant() {
  if (selection_.size() != 1 || selection_[0].isDerived()) return E_INVALID;
  Guid sel = selection_[0];
  const Node* sn = doc_.get(sel);
  if (!sn || !(sn->props.type == NodeType::SYMBOL || sn->props.isComponentSet())) return E_INVALID;
  begin(TxnKind::USER, "Add variant");
  Guid set = sn->props.isComponentSet() ? sel : setOf(sel);
  Guid base = sn->props.type == NodeType::SYMBOL ? sel : kNoGuid;
  if (set == kNoGuid) {
    // A lone component becomes a set: "Property 1=Default", then the new one.
    NodeChange rename = NodeChange::changed(sel);
    rename.mask = F_NAME;
    rename.props.name = "Property 1=Default";
    std::string original = sn->props.name;
    write(rename);
    combineAsVariants({sel}, &set);
    if (set != kNoGuid) {
      NodeChange setName = NodeChange::changed(set);
      setName.mask = F_NAME;
      setName.props.name = original;
      write(setName);
    }
  }
  if (set == kNoGuid) {
    commit();
    return E_INVALID;
  }
  if (base == kNoGuid) {
    // The set's last variant.
    for (Guid v : doc_.children(set))
      if (doc_.get(v)->props.type == NodeType::SYMBOL) base = v;
  }
  if (base == kNoGuid) {
    commit();
    return E_INVALID;
  }
  const NodeProps bp = doc_.get(base)->props;
  // Below the base variant, clear of the others.
  Mat2x3 t = bp.transform;
  double y = t.m12 + bp.size.y + kSetPadding;
  for (Guid v : doc_.children(set)) {
    const NodeProps& vp = doc_.get(v)->props;
    if (v == base) continue;
    bool overlapsX = vp.transform.m02 < t.m02 + bp.size.x && t.m02 < vp.transform.m02 + vp.size.x;
    if (overlapsX && vp.transform.m12 + vp.size.y > y - kSetPadding && vp.transform.m12 < y + bp.size.y)
      y = vp.transform.m12 + vp.size.y + kSetPadding;
  }
  t.m12 = y;
  const auto& kids = doc_.children(set);
  size_t index = static_cast<size_t>(std::find(kids.begin(), kids.end(), base) - kids.begin()) + 1;
  Guid copy = cloneSubtree(base, set, placeAt(set, index, kNoGuid), t);
  // The first variant property gets a new value: "Variant2", "Variant3"…
  const NodeProps setProps = doc_.get(set)->props;
  NodeChange c = NodeChange::changed(copy);
  c.mask = F_VARIANT_PROP_SPECS;
  c.props.variantPropSpecs = bp.variantPropSpecs;
  for (const ComponentPropDef& d : setProps.componentPropDefs) {
    if (d.type != ComponentPropType::VARIANT) continue;
    std::vector<std::string> taken;
    for (Guid v : doc_.children(set))
      for (const VariantPropSpec& s : doc_.get(v)->props.variantPropSpecs)
        if (s.propDefId == d.id) taken.push_back(s.value);
    std::string value;
    for (int n = 2;; n++) {
      value = "Variant" + std::to_string(n);
      if (std::find(taken.begin(), taken.end(), value) == taken.end()) break;
    }
    bool found = false;
    for (VariantPropSpec& s : c.props.variantPropSpecs)
      if (s.propDefId == d.id) s.value = value, found = true;
    if (!found) c.props.variantPropSpecs.push_back({d.id, value});
    NodeChange order = NodeChange::changed(set);
    order.mask = F_STATE_GROUP_ORDERS;
    order.props.stateGroupPropertyValueOrders = setProps.stateGroupPropertyValueOrders;
    for (auto& o : order.props.stateGroupPropertyValueOrders)
      if (o.property == d.name) o.values.push_back(value);
    write(order);
    break;
  }
  write(c);
  renameVariants(set);
  // The set grows to keep its padding around the new variant.
  const NodeProps& nowSet = doc_.get(set)->props;
  const NodeProps& np = doc_.get(copy)->props;
  double needW = np.transform.m02 + np.size.x + kSetPadding, needH = np.transform.m12 + np.size.y + kSetPadding;
  if (needW > nowSet.size.x || needH > nowSet.size.y) {
    NodeChange g = NodeChange::changed(set);
    g.mask = F_SIZE;
    g.props.size = {std::max(nowSet.size.x, needW), std::max(nowSet.size.y, needH)};
    write(g);
  }
  changeSelection({copy});
  commit();
  return OK;
}

// ---- Detach -----------------------------------------------------------------------------------

Guid Editor::detachOne(Guid R) {
  const Node* rn = doc_.get(R);
  if (!rn || R.isDerived() || rn->props.type != NodeType::INSTANCE) return kNoGuid;
  // The derived subtree as it is now.
  struct Item {
    Guid id;
    Guid parent;
    NodeProps props;
    std::vector<SymbolOverride> overrides;
    std::vector<ComponentPropAssignment> assigns;
    bool instance = false;
  };
  std::vector<Item> items;
  auto collect = [&](auto&& self, Guid parent) -> void {
    for (Guid c : doc_.children(parent)) {
      if (!c.isDerived()) continue;
      const Node* cn = doc_.get(c);
      if (!cn) continue;
      Item it{c, parent, cn->props, {}, {}, cn->props.type == NodeType::INSTANCE};
      if (it.instance) composedOverrides(c, it.overrides, it.assigns);
      items.push_back(std::move(it));
      if (cn->props.type != NodeType::INSTANCE) self(self, c);
    }
  };
  collect(collect, R);
  NodeProps fp = rn->props;
  Guid main = fp.symbolData.symbolID;
  fp.type = NodeType::FRAME;
  fp.symbolData = SymbolData{};
  fp.componentPropAssignments.clear();
  fp.detachedSymbolId = main;
  removeDerived(R);
  write(NodeChange::created(R, fp));
  std::unordered_map<Guid, Guid, GuidHash> ids{{R, R}};
  for (Item& it : items) {
    auto parent = ids.find(it.parent);
    if (parent == ids.end()) continue;
    NodeProps p = it.props;
    p.parentIndex.guid = parent->second;
    p.overrideKey = kNoGuid;
    p.parameterConsumptionMap.erase(std::remove_if(p.parameterConsumptionMap.begin(), p.parameterConsumptionMap.end(),
                                                   [](const ParamBinding& b) { return b.propRef != kNoGuid; }),
                                    p.parameterConsumptionMap.end());
    if (it.instance) {
      p.symbolData.overrides = it.overrides;
      p.componentPropAssignments = it.assigns;
      p.overriddenSymbolID = kNoGuid;
    }
    Guid id = newGuid();
    write(NodeChange::created(id, p));
    ids[it.id] = id;
  }
  // Slot content frames are plain frames now.
  for (Guid c : std::vector<Guid>(doc_.children(R))) {
    const Node* cn = doc_.get(c);
    if (cn && !c.isDerived() && cn->props.isSlotContent) {
      NodeChange ch = NodeChange::changed(c);
      ch.mask = F_IS_SLOT_CONTENT;
      ch.props.isSlotContent = false;
      write(ch);
    }
  }
  // Where the selection's derived ids went.
  for (auto& [from, to] : ids)
    if (from != to) derivedInfo_.erase(from);
  detachMap_ = std::move(ids);
  return R;
}

Status Editor::detachInstance(const std::vector<Guid>& refs) {
  std::vector<Guid> targets;
  for (Guid r : refs) {
    const Node* n = doc_.get(r);
    if (n && n->props.type == NodeType::INSTANCE) targets.push_back(r);
  }
  if (targets.empty()) return E_INVALID;
  begin(TxnKind::USER, "Detach instance");
  std::vector<Guid> result;
  for (Guid target : targets) {
    // A nested instance: its ancestors are detached first (Figma), outermost first.
    for (int guard = 0; guard < 32 && target.isDerived(); guard++) {
      Guid instance;
      std::vector<Guid> path;
      if (!derived::path(target, instance, path)) break;
      flushInstances();
      // The outermost nested instance on the way (or the target itself).
      size_t cut = path.size();
      for (size_t len = 1; len <= path.size(); len++) {
        const Node* rn = doc_.get(derived::intern(instance, std::vector<Guid>(path.begin(), path.begin() + static_cast<long>(len))));
        if (rn && rn->props.type == NodeType::INSTANCE) {
          cut = len;
          break;
        }
      }
      Guid nestedRow = derived::intern(instance, std::vector<Guid>(path.begin(), path.begin() + static_cast<long>(cut)));
      if (detachOne(instance) == kNoGuid) break;
      auto it = detachMap_.find(nestedRow);
      if (it == detachMap_.end()) {
        target = kNoGuid;
        break;
      }
      std::vector<Guid> rest(path.begin() + static_cast<long>(cut), path.end());
      target = rest.empty() ? it->second : derived::intern(it->second, rest);
      flushInstances();
    }
    if (target == kNoGuid || target.isDerived()) continue;
    if (detachOne(target) != kNoGuid) result.push_back(target);
  }
  changeSelection(result);
  commit();
  return result.empty() ? E_INVALID : OK;
}

// ---- Reset, push ------------------------------------------------------------------------------

Status Editor::resetOverrides(const std::vector<Guid>& refs, const std::vector<std::string>& fieldList) {
  FieldMask bits = 0;
  bool assignments = false;
  std::vector<std::string> extraKeys;
  for (const std::string& f : fieldList) {
    if (f == "componentPropAssignments") assignments = true;
    FieldMask b = codec::fieldOfKey(f);
    if (b) bits |= b;
    else extraKeys.push_back(f);
  }
  const bool all = fieldList.empty();
  begin(TxnKind::USER, all ? "Reset all changes" : "Reset");
  bool any = false;
  for (Guid ref : refs) {
    Guid top = ref.isDerived() ? instanceOfDerived(ref) : ref;
    const Node* tn = doc_.get(top);
    if (!tn || tn->props.type != NodeType::INSTANCE) continue;
    std::vector<Guid> under;
    if (ref.isDerived())
      if (auto info = derivedInfo_.find(ref); info != derivedInfo_.end()) under = info->second.path;
    bool exact = ref.isDerived() && doc_.get(ref) && doc_.get(ref)->props.type != NodeType::INSTANCE;
    SymbolData sd = tn->props.symbolData;
    for (SymbolOverride& o : sd.overrides) {
      bool match = exact ? o.path == under : o.path.size() >= under.size() && std::equal(under.begin(), under.end(), o.path.begin());
      if (!match) continue;
      if (all) {
        o.mask = 0;
        continue;
      }
      o.mask &= ~bits;
      for (const std::string& k : extraKeys) o.props.extra.erase(k);
      if (o.props.extra.empty()) o.mask &= ~static_cast<FieldMask>(F_EXTRA);
    }
    sd.overrides.erase(std::remove_if(sd.overrides.begin(), sd.overrides.end(), [](const SymbolOverride& o) { return o.mask == 0; }),
                       sd.overrides.end());
    NodeChange c = NodeChange::changed(top);
    c.mask = F_SYMBOL_DATA;
    c.props.symbolData = sd;
    if (!ref.isDerived() && (all || assignments)) {
      c.mask |= F_COMPONENT_PROP_ASSIGNMENTS;  // the instance's property values go back to the defaults too
    }
    write(c);
    any = true;
  }
  commit();
  return any ? OK : E_INVALID;
}

// The real node in `symbol`'s tree at `path` (keys), following nested instances' mains; `rest` gets the keys left
// when the walk stops at a nested instance.
static Guid resolvePath(const Document& doc, Guid symbol, const std::vector<Guid>& path, std::vector<Guid>* rest, Guid* stopAt) {
  Guid cur = symbol;
  for (size_t i = 0; i < path.size(); i++) {
    const Node* cn = doc.get(cur);
    if (!cn) return kNoGuid;
    if (i > 0 && cn->props.type == NodeType::INSTANCE) {
      if (rest) {
        *rest = std::vector<Guid>(path.begin() + static_cast<long>(i), path.end());
        if (stopAt) *stopAt = cur;
        return cur;
      }
      cur = cn->props.symbolData.symbolID;
    }
    Guid next = kNoGuid;
    for (Guid c : doc.children(cur)) {
      const Node* n = doc.get(c);
      if (!c.isDerived() && n && n->props.keyOf(c) == path[i]) next = c;
    }
    if (next == kNoGuid) return kNoGuid;
    cur = next;
  }
  return cur;
}

Status Editor::pushChangesToMain(Guid R) {
  ComponentInfo info;
  if (!componentInfo(R, info) || !info.canPush || R.isDerived()) return E_INVALID;
  const Node* rn = doc_.get(R);
  Guid main = symbolOf(rn->props);
  std::vector<SymbolOverride> overrides = rn->props.symbolData.overrides;
  begin(TxnKind::USER, "Push changes to main component");
  for (const SymbolOverride& o : overrides) {
    std::vector<Guid> rest;
    Guid nested = kNoGuid;
    Guid target = o.path.empty() ? main : resolvePath(doc_, main, o.path, &rest, &nested);
    if (target == kNoGuid) continue;
    if (!rest.empty()) {
      // Inside a nested instance of the main: an override of that nested instance.
      writeOverride(nested, rest, o.mask & ~static_cast<FieldMask>(F_COMPONENT_PROP_ASSIGNMENTS), o.props);
      continue;
    }
    NodeChange c = NodeChange::changed(target);
    c.mask = o.mask & ~static_cast<FieldMask>(F_OVERRIDDEN_SYMBOL_ID | F_COMPONENT_PROP_ASSIGNMENTS | F_EXTRA);
    copyFields(c.props, o.props, c.mask);
    const Node* tn = doc_.get(target);
    if ((o.mask & F_PARAM_MAP) && tn) {
      // Bindings are sparse in an override: merged per field into the main's.
      c.props.parameterConsumptionMap = tn->props.parameterConsumptionMap;
      mergeParams(c.props.parameterConsumptionMap, o.props.parameterConsumptionMap);
    }
    if (tn && tn->props.type == NodeType::INSTANCE) {
      if (o.mask & F_OVERRIDDEN_SYMBOL_ID) {
        c.mask |= F_SYMBOL_DATA;
        c.props.symbolData = tn->props.symbolData;
        c.props.symbolData.symbolID = o.props.overriddenSymbolID;
      }
      if (o.mask & F_COMPONENT_PROP_ASSIGNMENTS) {
        c.mask |= F_COMPONENT_PROP_ASSIGNMENTS;
        c.props.componentPropAssignments = tn->props.componentPropAssignments;
        for (auto& a : o.props.componentPropAssignments) {
          bool set = false;
          for (auto& b : c.props.componentPropAssignments)
            if (b.defID == a.defID) b = a, set = true;
          if (!set) c.props.componentPropAssignments.push_back(a);
        }
      }
    }
    if (o.mask & F_EXTRA) {
      c.mask |= F_EXTRA;
      c.props.extra = o.props.extra;
    }
    if (c.mask) write(c);
  }
  NodeChange clear = NodeChange::changed(R);
  clear.mask = F_SYMBOL_DATA;
  clear.props.symbolData = doc_.get(R)->props.symbolData;
  clear.props.symbolData.overrides.clear();
  write(clear);
  commit();
  return OK;
}

// ---- Navigation -------------------------------------------------------------------------------

Status Editor::goToMainComponent(Guid ref) {
  Guid inst = ref;
  if (ref.isDerived() && doc_.get(ref) && doc_.get(ref)->props.type != NodeType::INSTANCE)
    if (auto info = derivedInfo_.find(ref); info != derivedInfo_.end()) inst = info->second.level;
  Guid main = mainOf(inst);
  if (main == kNoGuid) return E_NOT_FOUND;
  const Node* mn = doc_.get(main);
  Guid set = setOf(main);
  if (mn->props.isSoftDeleted || (set != kNoGuid && doc_.get(set)->props.isSoftDeleted)) return E_INVALID;  // Restore component first
  // A library copy or a main copied from another file lives on the internal canvas: nothing to go to here.
  if (isLibraryCopy(main) || isCopiedMain(main)) return E_INVALID;
  setSelection({main});
  zoomToSelection();
  navMain_ = main;
  returnTo_ = ref;
  events_.navigation = true;
  return OK;
}

Status Editor::returnToInstanceCmd() {
  if (!doc_.has(returnTo_)) return E_NOT_FOUND;
  Guid back = returnTo_;
  setSelection({back});
  zoomToSelection();
  navMain_ = returnTo_ = kNoGuid;
  events_.navigation = true;
  return OK;
}

// ---- Swap, variants, property values ---------------------------------------------------------

std::vector<SymbolOverride> Editor::remapOverrides(const std::vector<SymbolOverride>& overrides, Guid from, Guid to, bool variant) const {
  std::vector<SymbolOverride> out;
  const Node* fromNode = doc_.get(from);
  const Node* toNode = doc_.get(to);
  if (!toNode) return out;
  // The names along a path in a main (for Figma's name-and-hierarchy match).
  auto namesOf = [&](Guid symbol, const std::vector<Guid>& path) {
    std::vector<std::string> names;
    Guid cur = symbol;
    for (Guid key : path) {
      const Node* cn = doc_.get(cur);
      if (cn && cn->props.type == NodeType::INSTANCE && cur != symbol) cur = cn->props.symbolData.symbolID;
      Guid next = kNoGuid;
      for (Guid c : doc_.children(cur))
        if (!c.isDerived() && doc_.get(c)->props.keyOf(c) == key) next = c;
      if (next == kNoGuid) return std::vector<std::string>{};
      names.push_back(doc_.get(next)->props.name);
      cur = next;
    }
    return names;
  };
  auto byNames = [&](Guid symbol, const std::vector<std::string>& names, std::vector<Guid>& path) {
    path.clear();
    Guid cur = symbol;
    for (const std::string& name : names) {
      const Node* cn = doc_.get(cur);
      if (cn && cn->props.type == NodeType::INSTANCE && cur != symbol) cur = cn->props.symbolData.symbolID;
      Guid next = kNoGuid;
      for (Guid c : doc_.children(cur))
        if (!c.isDerived() && doc_.get(c)->props.name == name) {
          next = c;
          break;
        }
      if (next == kNoGuid) return kNoGuid;
      path.push_back(doc_.get(next)->props.keyOf(next));
      cur = next;
    }
    return cur;
  };
  for (const SymbolOverride& o : overrides) {
    SymbolOverride r = o;
    Guid src = kNoGuid, dst = kNoGuid;
    if (o.path.empty()) {
      src = from;
      dst = to;
    } else {
      src = fromNode ? resolvePath(doc_, from, o.path, nullptr, nullptr) : kNoGuid;
      dst = resolvePath(doc_, to, o.path, nullptr, nullptr);
      bool sameName = dst != kNoGuid && src != kNoGuid && doc_.get(dst)->props.name == doc_.get(src)->props.name;
      if (dst == kNoGuid || !sameName) {
        // Not the same layer by key: a layer with the same names along the way (R4 §3).
        std::vector<std::string> names = fromNode ? namesOf(from, o.path) : std::vector<std::string>{};
        if (names.empty()) continue;
        dst = byNames(to, names, r.path);
        if (dst == kNoGuid) continue;
      }
    }
    if (variant && src != kNoGuid && dst != kNoGuid) {
      // A variant switch keeps a changed property only where both variants started the same (R4 §3); text and
      // names travel by layer name.
      const NodeProps& a = doc_.get(src)->props;
      const NodeProps& b = doc_.get(dst)->props;
      FieldMask keep = F_TEXT_DATA | F_NAME | F_COMPONENT_PROP_ASSIGNMENTS | F_OVERRIDDEN_SYMBOL_ID | F_EXTRA;
      FieldMask differing = differingFields(a, b, r.mask & ~keep);
      r.mask &= ~differing;
    }
    if (r.mask) out.push_back(std::move(r));
  }
  return out;
}

Status Editor::swapInstance(const std::vector<Guid>& refs, Guid main) {
  const Node* mn = doc_.get(main);
  if (mn && mn->props.isComponentSet()) main = defaultVariantOf(doc_, main), mn = doc_.get(main);
  if (!mn || mn->props.type != NodeType::SYMBOL) return E_INVALID;
  begin(TxnKind::USER, "Swap instance");
  bool any = false;
  for (Guid ref : refs) {
    const Node* n = doc_.get(ref);
    if (!n || n->props.type != NodeType::INSTANCE) continue;
    if (ref.isDerived()) {
      NodeChange c = NodeChange::changed(ref);
      c.mask = F_OVERRIDDEN_SYMBOL_ID;
      c.props.overriddenSymbolID = main;
      write(c);
    } else {
      Guid old = symbolOf(n->props);
      NodeChange c = NodeChange::changed(ref);
      c.mask = F_SYMBOL_DATA | F_COMPONENT_PROP_ASSIGNMENTS;
      c.props.symbolData = n->props.symbolData;
      c.props.symbolData.symbolID = main;
      c.props.symbolData.overrides = remapOverrides(n->props.symbolData.overrides, old, main, setOf(old) != kNoGuid && setOf(old) == setOf(main));
      const auto* defs = defsOf(main);
      for (const auto& a : n->props.componentPropAssignments) {
        bool known = false;
        if (defs)
          for (const auto& d : *defs) known |= d.id == a.defID;
        if (known) c.props.componentPropAssignments.push_back(a);
      }
      write(c);
    }
    any = true;
  }
  commit();
  return any ? OK : E_INVALID;
}

Status Editor::setComponentProperty(Guid ref, const std::string& prop, const json::Value& value) {
  const Node* n = doc_.get(ref);
  if (!n || n->props.type != NodeType::INSTANCE) return E_INVALID;
  Guid symbol = mainOf(ref);
  if (symbol == kNoGuid) return E_NOT_FOUND;
  Guid owner = setOf(symbol) != kNoGuid ? setOf(symbol) : symbol;
  const ComponentPropDef* def = findDef(owner, prop);
  if (!def) return E_NOT_FOUND;
  const ComponentPropDef d = *def;
  if (d.type == ComponentPropType::VARIANT) {
    if (!value.isString()) return E_INVALID;
    Guid set = setOf(symbol);
    // The variant with this value that keeps the most of the others (an exact match first).
    std::map<Guid, std::string> now;
    for (const VariantPropSpec& s : doc_.get(symbol)->props.variantPropSpecs) now[s.propDefId] = s.value;
    Guid best = kNoGuid;
    int bestScore = -1;
    for (Guid v : doc_.children(set)) {
      const Node* vn = doc_.get(v);
      if (!vn || vn->props.type != NodeType::SYMBOL) continue;
      std::map<Guid, std::string> vals;
      for (const VariantPropSpec& s : vn->props.variantPropSpecs) vals[s.propDefId] = s.value;
      if (vals[d.id] != value.string) continue;
      int score = 0;
      for (auto& [k, val] : now)
        if (k != d.id && vals[k] == val) score++;
      if (score > bestScore) best = v, bestScore = score;
    }
    if (best == kNoGuid) return E_NOT_FOUND;
    if (best == symbol) return OK;
    begin(TxnKind::USER, "Change variant");
    if (ref.isDerived()) {
      NodeChange c = NodeChange::changed(ref);
      c.mask = F_OVERRIDDEN_SYMBOL_ID;
      c.props.overriddenSymbolID = best;
      write(c);
    } else {
      NodeChange c = NodeChange::changed(ref);
      c.mask = F_SYMBOL_DATA;
      c.props.symbolData = n->props.symbolData;
      c.props.symbolData.symbolID = best;
      c.props.symbolData.overrides = remapOverrides(n->props.symbolData.overrides, symbol, best, true);
      write(c);
    }
    commit();
    return OK;
  }
  ComponentPropValue v;
  switch (d.type) {
    case ComponentPropType::BOOL:
      if (!value.isBool()) return E_INVALID;
      v.hasBool = true;
      v.boolValue = value.boolean;
      break;
    case ComponentPropType::TEXT:
      if (!value.isString()) return E_INVALID;
      v = textValue(value.string);
      break;
    case ComponentPropType::INSTANCE_SWAP: {
      bool ok = false;
      Guid g = value.isString() ? Guid::parse(value.string, &ok) : Guid{};
      const Node* gn = ok ? doc_.get(g) : nullptr;
      if (gn && gn->props.isComponentSet()) g = defaultVariantOf(doc_, g), gn = doc_.get(g);
      if (!gn || gn->props.type != NodeType::SYMBOL) return E_INVALID;
      v.guidValue = g;
      break;
    }
    default: return E_UNSUPPORTED;
  }
  begin(TxnKind::USER, "Change property");
  writeAssignment(ref, d.id, v);
  commit();
  return OK;
}

// ---- Property definitions on mains ----------------------------------------------------------

Status Editor::addComponentProperty(Guid ref, const CommandArgs& args) {
  Guid owner = propOwner(ref);
  if (owner == kNoGuid) return E_INVALID;
  ComponentPropType type = ComponentPropType::BOOL;
  if (!propTypeFromName(argString(args, "type"), type)) return E_INVALID;
  begin(TxnKind::USER, "Create property");
  const Node* on = doc_.get(owner);
  if (type == ComponentPropType::VARIANT && on->props.type == NodeType::SYMBOL) {
    // A variant property on a lone component makes it a set.
    NodeChange rename = NodeChange::changed(owner);
    rename.mask = F_NAME;
    std::string original = on->props.name;
    rename.props.name = "Property 1=Default";
    write(rename);
    Guid set = kNoGuid;
    combineAsVariants({owner}, &set);
    if (set == kNoGuid) {
      commit();
      return E_INVALID;
    }
    NodeChange setName = NodeChange::changed(set);
    setName.mask = F_NAME;
    setName.props.name = original;
    write(setName);
    changeSelection({set});
    owner = set;
    on = doc_.get(owner);
    if (argString(args, "name").empty()) {
      commit();
      return OK;
    }
  }
  std::vector<ComponentPropDef> defs = on->props.componentPropDefs;
  std::vector<Guid> used;
  doc_.forEach([&](const Node& n) {
    for (auto& d : n.props.componentPropDefs) used.push_back(d.id);
  });
  uint32_t low = kDefIdTop;
  for (Guid g : used)
    if (g.sessionID == sessionID_ && g.localID >= kDefIdBase && g.localID <= low) low = g.localID - 1;
  ComponentPropDef d;
  d.id = {sessionID_, low};
  d.type = type;
  d.name = argString(args, "name");
  if (d.name.empty())
    for (int i = 1;; i++) {
      std::string candidate = "Property " + std::to_string(i);
      bool taken = false;
      for (auto& e : defs) taken |= e.name == candidate;
      if (!taken) {
        d.name = candidate;
        break;
      }
    }
  const json::Value* dv = arg(args, "defaultValue");
  switch (type) {
    case ComponentPropType::BOOL:
      d.initialValue.hasBool = true;
      d.initialValue.boolValue = dv && dv->isBool() ? dv->boolean : true;
      break;
    case ComponentPropType::TEXT: d.initialValue = textValue(dv && dv->isString() ? dv->string : "Text"); break;
    case ComponentPropType::VARIANT: d.initialValue = textValue(dv && dv->isString() ? dv->string : "Default"); break;
    case ComponentPropType::INSTANCE_SWAP:
    case ComponentPropType::SLOT: {
      bool ok = false;
      Guid g = dv && dv->isString() ? Guid::parse(dv->string, &ok) : Guid{};
      if (ok) d.initialValue.guidValue = g;
      break;
    }
  }
  for (Guid g : refsArg(args, "preferredValues"))
    if (arg(args, "preferredValues")) d.preferredValues.push_back({doc_.get(g) && doc_.get(g)->props.isComponentSet(), g.toString()});
  std::string last;
  for (auto& e : defs)
    if (e.sortPosition > last) last = e.sortPosition;
  d.sortPosition = fractional::keyBetween(last, std::nullopt, fractional::Bias::Low);
  defs.push_back(d);
  NodeChange c = NodeChange::changed(owner);
  c.mask = F_COMPONENT_PROP_DEFS;
  c.props.componentPropDefs = defs;
  write(c);
  if (type == ComponentPropType::VARIANT) {
    // Every variant takes the default value.
    for (Guid v : doc_.children(owner)) {
      const Node* vn = doc_.get(v);
      if (!vn || vn->props.type != NodeType::SYMBOL) continue;
      NodeChange s = NodeChange::changed(v);
      s.mask = F_VARIANT_PROP_SPECS;
      s.props.variantPropSpecs = vn->props.variantPropSpecs;
      s.props.variantPropSpecs.push_back({d.id, valueText(d.initialValue)});
      write(s);
    }
    renameVariants(owner);
  } else if (arg(args, "bind")) {
    std::vector<Guid> layers = refsArg(args, "bind");
    commit();
    bindComponentProperty(layers, enumName(bindingFieldOf(type)), d.id.toString());
    return OK;
  }
  commit();
  return OK;
}

Status Editor::editComponentProperty(Guid ref, const CommandArgs& args) {
  Guid owner = propOwner(ref);
  const ComponentPropDef* found = owner != kNoGuid ? findDef(owner, argString(args, "prop")) : nullptr;
  if (!found) return E_NOT_FOUND;
  Guid defId = found->id;
  std::vector<ComponentPropDef> defs = doc_.get(owner)->props.componentPropDefs;
  auto it = std::find_if(defs.begin(), defs.end(), [&](const ComponentPropDef& d) { return d.id == defId; });
  begin(TxnKind::USER, "Edit property");
  std::string oldName = it->name;
  if (const json::Value* name = arg(args, "name"); name && name->isString() && !name->string.empty()) it->name = name->string;
  if (const json::Value* dv = arg(args, "defaultValue")) {
    if (it->type == ComponentPropType::BOOL && dv->isBool()) it->initialValue.hasBool = true, it->initialValue.boolValue = dv->boolean;
    else if ((it->type == ComponentPropType::TEXT || it->type == ComponentPropType::VARIANT) && dv->isString()) it->initialValue = textValue(dv->string);
    else if (dv->isString()) {
      bool ok = false;
      Guid g = Guid::parse(dv->string, &ok);
      if (ok) it->initialValue.guidValue = g;
    }
  }
  if (arg(args, "preferredValues")) {
    it->preferredValues.clear();
    for (Guid g : refsArg(args, "preferredValues")) it->preferredValues.push_back({doc_.get(g) && doc_.get(g)->props.isComponentSet(), g.toString()});
  }
  NodeChange c = NodeChange::changed(owner);
  c.mask = F_COMPONENT_PROP_DEFS;
  c.props.componentPropDefs = defs;
  if (it->type == ComponentPropType::VARIANT) {
    std::string oldValue = argString(args, "oldValue"), newValue = argString(args, "newValue");
    c.mask |= F_STATE_GROUP_ORDERS;
    c.props.stateGroupPropertyValueOrders = doc_.get(owner)->props.stateGroupPropertyValueOrders;
    for (auto& o : c.props.stateGroupPropertyValueOrders) {
      if (o.property != oldName) continue;
      o.property = it->name;
      if (!oldValue.empty())
        for (auto& v : o.values)
          if (v == oldValue) v = newValue;
    }
    write(c);
    if (!oldValue.empty() && !newValue.empty())
      for (Guid v : doc_.children(owner)) {
        const Node* vn = doc_.get(v);
        if (!vn) continue;
        NodeChange s = NodeChange::changed(v);
        s.mask = F_VARIANT_PROP_SPECS;
        s.props.variantPropSpecs = vn->props.variantPropSpecs;
        for (auto& spec : s.props.variantPropSpecs)
          if (spec.propDefId == defId && spec.value == oldValue) spec.value = newValue;
        write(s);
      }
    renameVariants(owner);
  } else {
    write(c);
  }
  commit();
  return OK;
}

Status Editor::deleteComponentProperty(Guid ref, const std::string& prop) {
  Guid owner = propOwner(ref);
  const ComponentPropDef* found = owner != kNoGuid ? findDef(owner, prop) : nullptr;
  if (!found) return E_NOT_FOUND;
  Guid defId = found->id;
  bool variant = found->type == ComponentPropType::VARIANT;
  begin(TxnKind::USER, "Delete property");
  std::vector<ComponentPropDef> defs = doc_.get(owner)->props.componentPropDefs;
  defs.erase(std::remove_if(defs.begin(), defs.end(), [&](const ComponentPropDef& d) { return d.id == defId; }), defs.end());
  NodeChange c = NodeChange::changed(owner);
  c.mask = F_COMPONENT_PROP_DEFS;
  c.props.componentPropDefs = defs;
  write(c);
  // Layers bound to it lose the binding.
  auto unbind = [&](auto&& self, Guid id) -> void {
    for (Guid k : std::vector<Guid>(doc_.children(id))) {
      if (k.isDerived()) continue;
      const Node* kn = doc_.get(k);
      if (!kn) continue;
      auto map = kn->props.parameterConsumptionMap;
      size_t before = map.size();
      map.erase(std::remove_if(map.begin(), map.end(), [&](const ParamBinding& b) { return b.propRef == defId; }), map.end());
      if (map.size() != before) {
        NodeChange u = NodeChange::changed(k);
        u.mask = F_PARAM_MAP;
        u.props.parameterConsumptionMap = map;
        write(u);
      }
      self(self, k);
    }
  };
  unbind(unbind, owner);
  if (variant) {
    for (Guid v : doc_.children(owner)) {
      const Node* vn = doc_.get(v);
      if (!vn) continue;
      NodeChange s = NodeChange::changed(v);
      s.mask = F_VARIANT_PROP_SPECS;
      s.props.variantPropSpecs = vn->props.variantPropSpecs;
      s.props.variantPropSpecs.erase(std::remove_if(s.props.variantPropSpecs.begin(), s.props.variantPropSpecs.end(),
                                                    [&](const VariantPropSpec& sp) { return sp.propDefId == defId; }),
                                     s.props.variantPropSpecs.end());
      write(s);
    }
    bool anyVariant = false;
    for (auto& d : defs) anyVariant |= d.type == ComponentPropType::VARIANT;
    if (!anyVariant) {
      // The last variant property: the set dissolves, its components stay where they are.
      Guid parent = doc_.parentOf(owner);
      std::vector<Guid> kids(doc_.children(owner));
      const auto& siblings = doc_.children(parent);
      size_t index = static_cast<size_t>(std::find(siblings.begin(), siblings.end(), owner) - siblings.begin());
      auto keys = placeManyAt(parent, index, kids.size(), GuidSet{owner});
      for (size_t i = 0; i < kids.size(); i++) {
        reparent(kids[i], parent, keys[i]);
        NodeChange s = NodeChange::changed(kids[i]);
        s.mask = F_VARIANT_PROP_SPECS | F_COMPONENT_PROP_DEFS;
        s.props.componentPropDefs = defs;  // the set's other properties go back to each component
        write(s);
      }
      write(NodeChange::removed(owner));
      changeSelection(kids);
    } else {
      renameVariants(owner);
    }
  }
  commit();
  return OK;
}

Status Editor::bindComponentProperty(const std::vector<Guid>& ids, const std::string& field, const std::string& prop) {
  VariableField f = VariableField::MISSING;
  if (!enumFromName(field, f) || (f != VariableField::VISIBLE && f != VariableField::TEXT_DATA && f != VariableField::OVERRIDDEN_SYMBOL_ID &&
                                  f != VariableField::SLOT_CONTENT_ID))
    return E_INVALID;
  begin(TxnKind::USER, prop.empty() ? "Detach property" : "Apply property");
  bool any = false;
  for (Guid id : ids) {
    if (id.isDerived()) continue;
    Guid owner = propOwner(id);
    const Node* n = doc_.get(id);
    if (owner == kNoGuid || !n || n->props.type == NodeType::SYMBOL || n->props.isComponentSet()) continue;
    const ComponentPropDef* def = prop.empty() ? nullptr : findDef(owner, prop);
    if (!prop.empty() && (!def || bindingFieldOf(def->type) != f)) continue;
    if (f == VariableField::TEXT_DATA && n->props.type != NodeType::TEXT) continue;
    if (f == VariableField::OVERRIDDEN_SYMBOL_ID && n->props.type != NodeType::INSTANCE) continue;
    NodeChange c = NodeChange::changed(id);
    c.mask = F_PARAM_MAP;
    c.props.parameterConsumptionMap = n->props.parameterConsumptionMap;
    auto& map = c.props.parameterConsumptionMap;
    map.erase(std::remove_if(map.begin(), map.end(), [&](const ParamBinding& b) { return b.field == f; }), map.end());
    if (def) map.push_back(propBinding(f, def->id));
    if (f == VariableField::SLOT_CONTENT_ID) {
      c.mask |= F_IS_SLOT;
      c.props.isSlot = def != nullptr;
    }
    write(c);
    any = true;
  }
  commit();
  return any ? OK : E_INVALID;
}

// ---- Insert instance, a variant's own values ----------------------------------------------------

Status Editor::insertInstance(Guid main, const CommandArgs& args) {
  const Node* mn = doc_.get(main);
  if (mn && mn->props.isComponentSet()) main = defaultVariantOf(doc_, main), mn = doc_.get(main);
  if (!mn || mn->props.type != NodeType::SYMBOL || page_ == kNoGuid) return E_INVALID;
  // Into `parent` (or the frame at the point, else the page), its centre at (x, y) on the page (else the view's centre).
  Vec2 at;
  const json::Value* x = arg(args, "x");
  const json::Value* y = arg(args, "y");
  if (x && y && x->isNumber() && y->isNumber()) at = {x->number, y->number};
  else at = camera_.toWorld({viewport_.width / 2, viewport_.height / 2});
  Guid parent = kNoGuid;
  for (Guid g : refsArg(args, "parent"))
    if (arg(args, "parent") && acceptsChildren(g)) parent = g;
  if (parent == kNoGuid) {
    parent = page_;
    auto path = hitPath(doc_, page_, at, pixel());
    for (auto it = path.rbegin(); it != path.rend(); ++it)
      if (acceptsChildren(*it)) {
        parent = *it;
        break;
      }
  }
  Vec2 size = mn->props.size;
  Mat2x3 world = Mat2x3::translate(std::round(at.x - size.x / 2), std::round(at.y - size.y / 2));
  begin(TxnKind::USER, "Insert instance");
  Guid id = createInstance(main, parent, doc_.positionAtEnd(parent), localFor(parent, world));
  if (id != kNoGuid) changeSelection({id});
  commit();
  return id != kNoGuid ? OK : E_INVALID;
}

Status Editor::setVariantProperties(Guid variant, const CommandArgs& args) {
  Guid set = setOf(variant);
  const json::Value* values = arg(args, "values");
  if (set == kNoGuid || !values || !values->isObject()) return E_INVALID;
  const NodeProps& sp = doc_.get(set)->props;
  NodeChange c = NodeChange::changed(variant);
  c.mask = F_VARIANT_PROP_SPECS;
  c.props.variantPropSpecs = doc_.get(variant)->props.variantPropSpecs;
  NodeChange order = NodeChange::changed(set);
  order.mask = F_STATE_GROUP_ORDERS;
  order.props.stateGroupPropertyValueOrders = sp.stateGroupPropertyValueOrders;
  for (auto& [prop, v] : values->object) {
    if (!v.isString()) continue;
    const ComponentPropDef* d = findDef(set, prop);
    if (!d || d->type != ComponentPropType::VARIANT) continue;
    bool found = false;
    for (auto& spec : c.props.variantPropSpecs)
      if (spec.propDefId == d->id) spec.value = v.string, found = true;
    if (!found) c.props.variantPropSpecs.push_back({d->id, v.string});
    bool listed = false;
    for (auto& o : order.props.stateGroupPropertyValueOrders)
      if (o.property == d->name) {
        listed = true;
        if (std::find(o.values.begin(), o.values.end(), v.string) == o.values.end()) o.values.push_back(v.string);
      }
    if (!listed) order.props.stateGroupPropertyValueOrders.push_back({d->name, {v.string}});
  }
  begin(TxnKind::USER, "Edit variant");
  write(c);
  write(order);
  renameVariants(set);
  commit();
  return OK;
}

// ---- Delete / restore, exposed instances, slots ------------------------------------------------

bool Editor::softDeleteMain(Guid main) {
  const Node* n = doc_.get(main);
  if (!n || main.isDerived() || !(n->props.type == NodeType::SYMBOL || n->props.isComponentSet()) || n->props.isSoftDeleted) return false;
  if (instanceCount(main) == 0) return false;
  Guid canvas = internalCanvas(true);
  if (canvas == kNoGuid) return false;
  std::vector<Guid> ancestors;
  for (Guid cur = doc_.parentOf(main); doc_.has(cur); cur = doc_.parentOf(cur)) {
    if (doc_.get(cur)->props.type == NodeType::DOCUMENT) break;
    ancestors.insert(ancestors.begin(), cur);
  }
  NodeChange c = NodeChange::changed(main);
  c.mask = F_PARENT_INDEX | F_TRANSFORM | F_IS_SOFT_DELETED | F_ANCESTOR_PATH;
  c.props.parentIndex = {canvas, doc_.positionAtEnd(canvas)};
  c.props.transform = doc_.worldTransform(main);
  c.props.isSoftDeleted = true;
  c.props.ancestorPathBeforeDeletion = ancestors;
  write(c);
  return true;
}

Status Editor::restoreComponent(Guid ref) {
  Guid main = ref;
  const Node* n = doc_.get(ref);
  if (n && n->props.type == NodeType::INSTANCE) {
    main = ref.isDerived() ? mainOf(ref) : n->props.symbolData.symbolID;
    Guid set = setOf(main);
    if (set != kNoGuid && doc_.get(set)->props.isSoftDeleted) main = set;
  }
  const Node* mn = doc_.get(main);
  if (!mn) return E_INVALID;
  // A library copy (its asset removed from the library) or a main copied in from another file: made this file's own,
  // on the current page in the middle of the view; instances stay linked. A new local asset (a key on request).
  Guid copyRoot = libraryRootOf(main);
  if ((copyRoot != kNoGuid || isCopiedMain(main)) && page_ != kNoGuid && (mn->props.type == NodeType::SYMBOL || mn->props.isComponentSet())) {
    Guid root = copyRoot != kNoGuid ? copyRoot : payloadRoot(main);
    const Node* rn = doc_.get(root);
    Vec2 at = camera_.toWorld({viewport_.width / 2, viewport_.height / 2});
    Mat2x3 world = Mat2x3::translate(std::round(at.x - rn->props.size.x / 2), std::round(at.y - rn->props.size.y / 2));
    std::vector<Guid> nodes;
    realSubtree(root, nodes);
    begin(TxnKind::USER, "Restore component");
    libraryWrite_ = true;
    NodeChange c = NodeChange::changed(root);
    c.mask = F_PARENT_INDEX | F_TRANSFORM | kAssetIdentityFields;
    c.props.parentIndex = {page_, doc_.positionAtEnd(page_)};
    c.props.transform = localFor(page_, world);
    write(c);
    for (Guid g : nodes) {
      const NodeProps& p = doc_.get(g)->props;
      if (g == root || !(p.type == NodeType::SYMBOL || p.isComponentSet())) continue;
      NodeChange inner = NodeChange::changed(g);
      inner.mask = kAssetIdentityFields;
      write(inner);
    }
    libraryWrite_ = false;
    changeSelection({root});
    commit();
    return OK;
  }
  if (!mn->props.isSoftDeleted) return E_INVALID;
  Guid parent = kNoGuid;
  for (auto it = mn->props.ancestorPathBeforeDeletion.rbegin(); it != mn->props.ancestorPathBeforeDeletion.rend(); ++it) {
    const Node* a = doc_.get(*it);
    if (a && !(a->props.type == NodeType::CANVAS && a->props.internalOnly) && doc_.pageOf(*it) != internalCanvas(false)) {
      parent = *it;
      break;
    }
  }
  if (parent == kNoGuid) parent = page_;
  begin(TxnKind::USER, "Restore component");
  NodeChange c = NodeChange::changed(main);
  c.mask = F_PARENT_INDEX | F_TRANSFORM | F_IS_SOFT_DELETED | F_ANCESTOR_PATH;
  c.props.parentIndex = {parent, doc_.positionAtEnd(parent)};
  c.props.transform = localFor(parent, mn->props.transform);
  c.props.isSoftDeleted = false;
  write(c);
  commit();
  return OK;
}

Status Editor::setExposedInstance(Guid ref, bool exposed) {
  const Node* n = doc_.get(ref);
  if (!n || ref.isDerived() || n->props.type != NodeType::INSTANCE || propOwner(doc_.parentOf(ref)) == kNoGuid) return E_INVALID;
  begin(TxnKind::USER, exposed ? "Expose properties" : "Hide properties");
  NodeChange c = NodeChange::changed(ref);
  c.mask = F_PROPS_ARE_BUBBLED;
  c.props.propsAreBubbled = exposed;
  write(c);
  commit();
  return OK;
}

Status Editor::resetSlot(Guid ref) {
  // The slot (a derived slot frame, or its content frame): its SLOT property goes back to the main's content.
  Guid top = kNoGuid, level = kNoGuid, def = kNoGuid, content = kNoGuid;
  const Node* n = doc_.get(ref);
  if (!n) return E_INVALID;
  if (!ref.isDerived() && n->props.isSlotContent) {
    content = ref;
    top = doc_.parentOf(ref);
  }
  auto findSlot = [&](Guid row) {
    auto info = derivedInfo_.find(row);
    if (info == derivedInfo_.end()) return;
    const Node* src = doc_.get(info->second.source);
    if (!src || !src->props.isSlot) return;
    for (const ParamBinding& b : src->props.parameterConsumptionMap)
      if (b.field == VariableField::SLOT_CONTENT_ID && b.propRef != kNoGuid) {
        def = b.propRef;
        level = info->second.level;
        top = info->second.instance;
      }
  };
  if (ref.isDerived()) findSlot(ref);
  if (content != kNoGuid && def == kNoGuid) {
    // Which slot shows this content.
    auto rows = derivedRows_.find(top);
    if (rows != derivedRows_.end())
      for (Guid r : rows->second) {
        Guid d0 = def;
        findSlot(r);
        if (def == d0) continue;
        std::vector<ComponentPropAssignment> assigns = assignmentsOf(level);
        bool match = false;
        for (auto& a : assigns) match |= a.defID == def && a.value.guidValue == content;
        if (match) break;
        def = kNoGuid;
      }
  }
  if (def == kNoGuid) return E_INVALID;
  for (auto& a : assignmentsOf(level))
    if (a.defID == def) content = a.value.guidValue;
  begin(TxnKind::USER, "Reset slot");
  if (!level.isDerived()) {
    NodeChange c = NodeChange::changed(level);
    c.mask = F_COMPONENT_PROP_ASSIGNMENTS;
    c.props.componentPropAssignments = doc_.get(level)->props.componentPropAssignments;
    auto& list = c.props.componentPropAssignments;
    list.erase(std::remove_if(list.begin(), list.end(), [&](const ComponentPropAssignment& a) { return a.defID == def; }), list.end());
    write(c);
  } else {
    writeAssignment(level, def, ComponentPropValue{});
  }
  if (doc_.has(content)) {
    std::vector<Guid> order;
    auto collect = [&](auto&& self, Guid id) -> void {
      for (Guid k : std::vector<Guid>(doc_.children(id)))
        if (!k.isDerived()) self(self, k);
      order.push_back(id);
    };
    collect(collect, content);
    for (Guid id : order) write(NodeChange::removed(id));
  }
  commit();
  pruneSelection();
  return OK;
}

}  // namespace eng
