// Libraries (docs/data.md §9, docs/schema.md §8, R5): the engine's side.
//
// - Keys: every local asset (component, component set, style, collection, variable) gets a stable 40-hex `key` when
//   asked (ensureAssetKeys, before a publish); it never changes after that, and duplicates don't inherit it.
// - Publish: encodeAssets turns assets into payloads — a NODE_CHANGES Message per asset holding its nodes and every
//   node it depends on (nested mains, styles, variables, collections, library copies it uses), with the library's
//   GUIDs — and a content versionHash per asset (SHA-1 of its own nodes, canonical: GUIDs, bound values, its place on
//   the page, publishing flags and library bookkeeping left out; references by key), which changes only when the
//   asset does.
// - Consume: importLibrary puts read-only copies on the internal canvas (docs/schema.md §8.2): fresh GUIDs, every
//   node's overrideKey = the library node's effective key, roots marked sourceLibraryKey / key / publishID / version.
//   A copy is one library's: (sourceLibraryKey, key). Instances, aliases and style references then point at the
//   copies by GUID, so everything that works for local assets works for them. An update (one undo step) rewrites
//   every copy of a key in place, its nodes matched top-down (components by publishID, layers by overrideKey among
//   their parent's children), so GUIDs — and every instance's link and overrides — stay. asNew writes a second copy
//   (Update selected instance).
// - Cross-file paste (paste() in Commands.cpp) brings referenced assets in through the same writer.

#include <algorithm>
#include <cstdio>
#include <functional>
#include <set>

#include "base/Sha1.h"
#include "editor/Editor.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"

namespace eng {

namespace {

using GuidSet = std::unordered_set<Guid, GuidHash>;
using Kind = Editor::AssetKind;

bool hiddenName(const std::string& n) { return !n.empty() && (n[0] == '.' || n[0] == '_'); }

// Every reference a node holds to a main or an asset. `symbol` gets GUIDs in main positions (symbolID,
// overriddenSymbolID, a property's GUID value or default: callers check what they point at); `asset` gets style,
// variable and collection references.
struct Refs {
  std::function<void(Guid&)> symbol;
  std::function<void(AssetId&, Kind)> asset;
};

void visitData(VariableData& d, const Refs& r) {
  if (d.kind == VariableData::Kind::ALIAS) r.asset(d.alias, Kind::VARIABLE);
  for (VariableData& a : d.args) visitData(a, r);
}

void visitData(VarBox& b, const Refs& r) {
  if (b.present()) visitData(b.edit(), r);
}

void visitPaints(std::vector<Paint>& paints, const Refs& r) {
  for (Paint& p : paints) {
    visitData(p.colorVar, r);
    visitData(p.opacityVar, r);
    for (VariableData& s : p.stopVars) visitData(s, r);
  }
}

void visitProps(NodeProps& p, const Refs& r) {
  if (p.comp().symbolData.symbolID != kNoGuid) r.symbol(p.comp().symbolData.symbolID);
  if (p.comp().overriddenSymbolID != kNoGuid) r.symbol(p.comp().overriddenSymbolID);
  for (SymbolOverride& o : p.comp().symbolData.overrides) visitProps(o.props, r);
  for (ComponentPropAssignment& a : p.comp().componentPropAssignments) {
    if (a.value.guidValue != kNoGuid) r.symbol(a.value.guidValue);
    visitData(a.boundValue, r);
  }
  for (ComponentPropDef& d : p.comp().componentPropDefs) {
    if (d.initialValue.guidValue != kNoGuid) r.symbol(d.initialValue.guidValue);
    visitData(d.boundValue, r);
  }
  for (AssetId* a : {&p.refs().styleIdForFill, &p.refs().styleIdForStrokeFill, &p.refs().styleIdForText, &p.refs().styleIdForEffect, &p.refs().styleIdForGrid})
    if (a->present()) r.asset(*a, Kind::STYLE);
  for (VariableModeEntry& e : p.refs().variableModeBySetMap) {
    if (e.set.present()) r.asset(e.set, Kind::VARIABLE_COLLECTION);
    if (e.extension.present()) r.asset(e.extension, Kind::VARIABLE_COLLECTION);
  }
  if (p.asset().variableSetID.present()) r.asset(p.asset().variableSetID, Kind::VARIABLE_COLLECTION);
  // An extended collection: the collection it extends; its overrides: the variable they override.
  for (VariableSetMode& m : p.asset().variableSetModes)
    if (m.parentSet.present()) r.asset(m.parentSet, Kind::VARIABLE_COLLECTION);
  if (p.asset().overriddenVariableId.present()) r.asset(p.asset().overriddenVariableId, Kind::VARIABLE);
  for (VariableModeValue& v : p.asset().variableDataValues) visitData(v.data, r);
  for (ParamBinding& b : p.parameterConsumptionMap) visitData(b.data, r);
  visitPaints(p.fillPaints, r);
  visitPaints(p.strokePaints, r);
  for (TextStyle& t : p.text().textData.styleOverrideTable) visitPaints(t.fillPaints, r);
  for (VectorStyle& v : p.shape().vectorData.styleOverrideTable) visitPaints(v.fillPaints, r);
  for (Effect& e : p.effects) {
    visitData(e.colorVar, r);
    visitData(e.radiusVar, r);
    visitData(e.spreadVar, r);
    visitData(e.xVar, r);
    visitData(e.yVar, r);
  }
  for (LayoutGrid& g : p.rare().layoutGrids) {
    visitData(g.numSectionsVar, r);
    visitData(g.offsetVar, r);
    visitData(g.sectionSizeVar, r);
    visitData(g.gutterSizeVar, r);
  }
}

void collectImages(const std::vector<Paint>& paints, std::set<std::string>& out) {
  for (const Paint& p : paints)
    if (isImageLike(p.type) && p.image.present) out.insert(p.image.hex());
}

void collectImages(const NodeProps& p, std::set<std::string>& out) {
  collectImages(p.fillPaints, out);
  collectImages(p.strokePaints, out);
  for (const TextStyle& t : p.text().textData.styleOverrideTable) collectImages(t.fillPaints, out);
  for (const VectorStyle& v : p.shape().vectorData.styleOverrideTable) collectImages(v.fillPaints, out);
  for (const SymbolOverride& o : p.comp().symbolData.overrides) collectImages(o.props, out);
}

bool isComponentNode(const NodeProps& p) { return p.type == NodeType::SYMBOL || p.isComponentSet(); }

// Of several copies of one asset (Update selected instance leaves two), the one a reference or a reuse takes: the one
// at `version`, else the first by GUID (sorted lists).
Guid pickCopy(const Document& doc, const std::vector<Guid>& copies, const std::string& version) {
  if (!version.empty())
    for (Guid g : copies)
      if (doc.get(g)->props.asset().version == version) return g;
  return copies.empty() ? kNoGuid : copies[0];
}

// Assets by key, for calls that look many up: library copy roots by (library, key) (docs/schema.md §8.2: a key is one
// library's; a duplicated library has the same keys under another FileKey), and local assets (a live one over a
// deleted one).
struct KeyIndex {
  std::unordered_map<std::string, std::vector<Guid>> copies;    // library + "\n" + key → copy roots, by GUID
  std::unordered_map<std::string, std::vector<Guid>> anyLibrary;  // key → copy roots of every library, by GUID
  std::unordered_map<std::string, Guid> locals;
  static std::string id(const std::string& library, const std::string& key) { return library + '\n' + key; }
  // "" library: the copies of the key from any library.
  const std::vector<Guid>& copiesOf(const std::string& library, const std::string& key) const {
    static const std::vector<Guid> kNone;
    const auto& map = library.empty() ? anyLibrary : copies;
    auto it = map.find(library.empty() ? key : id(library, key));
    return it == map.end() ? kNone : it->second;
  }
  Guid local(const std::string& key) const {
    auto it = locals.find(key);
    return it == locals.end() ? kNoGuid : it->second;
  }
};

KeyIndex indexKeys(const Editor& ed) {
  KeyIndex ix;
  const Document& doc = ed.document();
  doc.forEach([&](const Node& n) {
    if (n.guid.isDerived() || n.props.asset().key.empty() || ed.assetKindOf(n.guid) == Kind::NONE) return;
    if (!n.props.asset().sourceLibraryKey.empty()) {
      ix.copies[KeyIndex::id(n.props.asset().sourceLibraryKey, n.props.asset().key)].push_back(n.guid);
      ix.anyLibrary[n.props.asset().key].push_back(n.guid);
      return;
    }
    if (ed.isLibraryCopy(n.guid)) return;
    auto [it, fresh] = ix.locals.emplace(n.props.asset().key, n.guid);
    if (fresh) return;
    // A live asset over a deleted one; else the first by GUID (deterministic).
    const NodeProps& was = doc.get(it->second)->props;
    if (was.comp().isSoftDeleted != n.props.comp().isSoftDeleted ? was.comp().isSoftDeleted : n.guid < it->second) it->second = n.guid;
  });
  for (auto* m : {&ix.copies, &ix.anyLibrary})
    for (auto& [k, list] : *m) std::sort(list.begin(), list.end());
  return ix;
}

// A key as a GUID-shaped value (a reference outside an asset, in its content hash).
Guid keyAsGuid(const std::string& key) {
  Sha1 h;
  h.update(key);
  auto d = h.digest();
  auto word = [&](size_t i) { return uint32_t{d[i]} << 24 | uint32_t{d[i + 1]} << 16 | uint32_t{d[i + 2]} << 8 | uint32_t{d[i + 3]}; };
  Guid g{word(0), word(4)};
  if (g.isDerived() || g == kNoGuid) g.sessionID ^= 1;
  return g;
}

}  // namespace

const char* Editor::assetKindName(AssetKind k) {
  switch (k) {
    case AssetKind::COMPONENT: return "COMPONENT";
    case AssetKind::COMPONENT_SET: return "COMPONENT_SET";
    case AssetKind::STYLE: return "STYLE";
    case AssetKind::VARIABLE_COLLECTION: return "VARIABLE_COLLECTION";
    case AssetKind::VARIABLE: return "VARIABLE";
    default: return "NONE";
  }
}

void Editor::clearIdentity(NodeProps& p) {
  p.asset().key.clear();
  p.asset().version.clear();
  p.asset().publishedVersion.clear();
  p.asset().sourceLibraryKey.clear();
  p.asset().publishID = kNoGuid;
  p.asset().libraryMoveInfo = {};
}

// ---- Lookups ------------------------------------------------------------------------------------

Editor::AssetKind Editor::assetKindOf(Guid id) const {
  const Node* n = id.isDerived() ? nullptr : doc_.get(id);
  if (!n) return AssetKind::NONE;
  const NodeProps& p = n->props;
  if (p.type == NodeType::SYMBOL) return AssetKind::COMPONENT;
  if (p.isComponentSet()) return AssetKind::COMPONENT_SET;
  if (p.isStyle()) return AssetKind::STYLE;
  if (p.type == NodeType::VARIABLE_SET) return AssetKind::VARIABLE_COLLECTION;
  if (p.type == NodeType::VARIABLE) return AssetKind::VARIABLE;
  return AssetKind::NONE;
}

Guid Editor::libraryRootOf(Guid id) const {
  if (id.isDerived()) return kNoGuid;
  for (Guid cur = id; ; ) {
    const Node* n = doc_.get(cur);
    if (!n || n->props.type == NodeType::CANVAS || n->props.type == NodeType::DOCUMENT) return kNoGuid;
    if (!n->props.asset().sourceLibraryKey.empty()) return cur;
    cur = n->props.parentIndex.guid;
  }
}

bool Editor::isCopiedMain(Guid id) const {
  const Node* n = doc_.get(id);
  if (!n || id.isDerived() || !(n->props.type == NodeType::SYMBOL || n->props.isComponentSet())) return false;
  Guid page = doc_.pageOf(id);
  const Node* pn = doc_.get(page);
  if (!pn || !pn->props.rare().internalOnly) return false;
  Guid set = setOf(id);
  bool deleted = n->props.comp().isSoftDeleted || (set != kNoGuid && doc_.get(set)->props.comp().isSoftDeleted);
  return !deleted && !isLibraryCopy(id);
}

// The key lookups go through the key index (Editor::indexChange): a bucket holds the few real nodes carrying a key,
// never a walk over the document (componentInfo asks for a preferred value's main on every panel render).
Guid Editor::copyRootByKey(const std::string& libraryKey, const std::string& key, const std::string& version) const {
  if (key.empty() || libraryKey.empty() || !hasLibraryCopies_) return kNoGuid;
  const std::vector<Guid>* bucket = nodesWithKey(key);
  if (!bucket) return kNoGuid;
  std::vector<Guid> found;
  for (Guid g : *bucket) {
    const Node* n = doc_.get(g);
    if (n && n->props.asset().sourceLibraryKey == libraryKey && assetKindOf(g) != AssetKind::NONE) found.push_back(g);
  }
  std::sort(found.begin(), found.end());
  return pickCopy(doc_, found, version);
}

Guid Editor::localAssetByKey(const std::string& key) const {
  if (key.empty()) return kNoGuid;
  const std::vector<Guid>* bucket = nodesWithKey(key);
  if (!bucket) return kNoGuid;
  Guid found = kNoGuid;
  for (Guid g : *bucket) {
    const Node* n = doc_.get(g);
    if (!n || assetKindOf(g) == AssetKind::NONE || isLibraryCopy(g)) continue;
    // A live asset over a deleted one with the same key; of equals, the smallest GUID.
    bool better = found == kNoGuid || (doc_.get(found)->props.comp().isSoftDeleted && !n->props.comp().isSoftDeleted) ||
                  (doc_.get(found)->props.comp().isSoftDeleted == n->props.comp().isSoftDeleted && g < found);
    if (better) found = g;
  }
  return found;
}

Guid Editor::copyMainByKey(const std::string& libraryKey, const std::string& key) const {
  if (key.empty() || libraryKey.empty() || !hasLibraryCopies_) return kNoGuid;
  const std::vector<Guid>* bucket = nodesWithKey(key);
  if (!bucket) return kNoGuid;
  Guid found = kNoGuid;
  for (Guid g : *bucket) {
    const Node* n = doc_.get(g);
    if (!n || !isComponentNode(n->props) || (found != kNoGuid && found < g)) continue;
    Guid root = libraryRootOf(g);
    if (root != kNoGuid && doc_.get(root)->props.asset().sourceLibraryKey == libraryKey) found = g;
  }
  return found;
}

Guid Editor::copyByPublishID(const std::string& libraryKey, Guid publishID) const {
  if (publishID == kNoGuid || !hasLibraryCopies_) return kNoGuid;
  Guid found = kNoGuid;
  doc_.forEach([&](const Node& n) {
    if (n.guid.isDerived() || n.props.asset().publishID != publishID || (found != kNoGuid && found < n.guid)) return;
    if (!(n.props.type == NodeType::SYMBOL || n.props.isComponentSet())) return;
    Guid root = libraryRootOf(n.guid);
    if (root != kNoGuid && (libraryKey.empty() || doc_.get(root)->props.asset().sourceLibraryKey == libraryKey)) found = n.guid;
  });
  return found;
}

Guid Editor::payloadRoot(Guid asset) const {
  const Node* n = doc_.get(asset);
  if (n && n->props.type == NodeType::SYMBOL) {
    Guid set = setOf(asset);
    if (set != kNoGuid) return set;
  }
  return asset;
}

void Editor::realSubtree(Guid root, std::vector<Guid>& out) const {
  if (!doc_.has(root) || root.isDerived()) return;
  out.push_back(root);
  for (Guid c : doc_.children(root))
    if (!c.isDerived()) realSubtree(c, out);
}

std::vector<Guid> Editor::dependencyRoots(const std::vector<Guid>& roots, const std::vector<const NodeProps*>* extra) const {
  GuidSet seen(roots.begin(), roots.end());
  std::vector<Guid> out, queue = roots;
  // The payload root a reference needs (a variant: its set; a library copy's inner main: the copy's root).
  auto needRoot = [&](Guid g) -> Guid {
    const Node* n = doc_.get(g);
    if (!n || g.isDerived()) return kNoGuid;
    if (n->props.type != NodeType::SYMBOL && !n->props.isComponentSet() && assetKindOf(g) == AssetKind::NONE) return kNoGuid;
    Guid copy = libraryRootOf(g);
    if (copy != kNoGuid) return copy;
    return payloadRoot(g);
  };
  auto add = [&](Guid r) {
    if (r == kNoGuid || seen.count(r)) return;
    seen.insert(r);
    out.push_back(r);
    queue.push_back(r);
  };
  Refs refs;
  refs.symbol = [&](Guid& g) {
    const Node* n = doc_.get(g);
    if (n && (n->props.type == NodeType::SYMBOL || n->props.isComponentSet())) add(needRoot(g));
  };
  refs.asset = [&](AssetId& a, Kind k) {
    Guid g = k == Kind::STYLE ? findStyle(a) : k == Kind::VARIABLE ? findVariable(a) : findCollection(a);
    if (g == kNoGuid) return;
    add(needRoot(g));
    // A variable needs its collection.
    if (k == Kind::VARIABLE) {
      const NodeProps& vp = doc_.get(g)->props;
      add(needRoot(findCollection(vp.asset().variableSetID)));
    }
  };
  if (extra)
    for (const NodeProps* e : *extra) {
      NodeProps p = *e;
      visitProps(p, refs);
    }
  for (size_t i = 0; i < queue.size(); i++) {
    std::vector<Guid> nodes;
    realSubtree(queue[i], nodes);
    for (Guid id : nodes) {
      NodeProps p = doc_.get(id)->props;
      visitProps(p, refs);
    }
  }
  return out;
}

bool Editor::assetHidden(Guid id) const {
  const Node* n = doc_.get(id);
  if (!n) return true;
  const NodeProps& p = n->props;
  switch (assetKindOf(id)) {
    case AssetKind::COMPONENT: {
      if (!codec::extraBool(p.extra, "isSymbolPublishable", true) || !p.asset().isPublishable || hiddenName(p.name)) return true;
      Guid set = setOf(id);
      if (set != kNoGuid && assetHidden(set)) return true;
      return isCopiedMain(id);  // shipped only as a dependency
    }
    case AssetKind::COMPONENT_SET: return !p.asset().isPublishable || hiddenName(p.name) || isCopiedMain(id);
    case AssetKind::STYLE: return !p.asset().isPublishable || hiddenName(p.name);
    case AssetKind::VARIABLE_COLLECTION: return !p.asset().isPublishable || hiddenName(p.name);
    case AssetKind::VARIABLE: {
      if (!p.asset().isPublishable) return true;
      Guid set = findCollection(p.asset().variableSetID);
      return set != kNoGuid && assetHidden(set);
    }
    default: return true;
  }
}

void Editor::fillAssetInfo(Guid id, AssetInfo& info) const {
  const NodeProps& p = doc_.get(id)->props;
  info.id = id;
  info.key = p.asset().key;
  info.kind = assetKindOf(id);
  info.name = p.name;
  info.description = p.asset().description;
  info.styleType = p.asset().styleType;
  info.softDeleted = p.comp().isSoftDeleted;
  info.publishedVersion = p.asset().publishedVersion;
  info.libraryKey = p.asset().sourceLibraryKey;
  info.version = p.asset().version;
  info.publishID = p.asset().publishID;
  if (info.kind == AssetKind::VARIABLE) {
    info.hasResolvedType = true;
    info.resolvedType = p.asset().variableResolvedType;
    info.owner = findCollection(p.asset().variableSetID);
  }
  if (info.kind == AssetKind::COMPONENT) {
    info.owner = setOf(id);
    if (info.owner != kNoGuid && doc_.get(info.owner)->props.comp().isSoftDeleted) info.softDeleted = true;
  }
  if (info.owner != kNoGuid) info.ownerKey = doc_.get(info.owner)->props.asset().key;
}

// ---- Keys -----------------------------------------------------------------------------------------

std::vector<std::pair<Guid, std::string>> Editor::ensureAssetKeys(const std::vector<Guid>& refs) {
  std::vector<Guid> ids = refs;
  if (ids.empty()) {
    doc_.forEach([&](const Node& n) {
      if (assetKindOf(n.guid) != AssetKind::NONE && !isLibraryCopy(n.guid)) ids.push_back(n.guid);
    });
    std::sort(ids.begin(), ids.end());
  }
  std::vector<Guid> missing;
  for (Guid id : ids)
    if (assetKindOf(id) != AssetKind::NONE && !isLibraryCopy(id) && doc_.get(id)->props.asset().key.empty()) missing.push_back(id);
  if (!missing.empty() && !txn_.open && !busy()) {
    // An ordinary journaled edit of the file, not an undo step (docs/data.md §9.1).
    begin(TxnKind::SYSTEM, "Asset keys");
    for (Guid id : missing) {
      NodeChange c = NodeChange::changed(id);
      c.mask = F_KEY;
      c.props.asset().key = newAssetKey();
      write(c);
    }
    commit();
  }
  std::vector<std::pair<Guid, std::string>> out;
  for (Guid id : ids)
    if (assetKindOf(id) != AssetKind::NONE && !isLibraryCopy(id)) out.push_back({id, doc_.get(id)->props.asset().key});
  return out;
}

// ---- Publish --------------------------------------------------------------------------------------

// Visible content only (docs/data.md §9.1: "if the content is unchanged, the hash is unchanged"): the asset's nodes in
// tree order (children by position) with their own GUIDs, parents' GUIDs and overrideKeys left out; references to its
// own nodes by their place in it, to anything else by the target's key (its GUID while it has none); values a variable
// or a style sets left out (the binding counts: the value depends on the modes where the asset sits and on the
// variable's or style's own content, hashed with them); publishing flags, library bookkeeping, the panels' order and
// where it sits on its page left out. Each node is the engine's canonical JSON, blobs by content.
std::string Editor::hashAsset(Guid root, const HashView& v) const {
  constexpr uint32_t kInner = 0xFFFFFFF0u;  // a node of the asset, by its place in it
  const Guid kMissing{0xFFFFFFEFu, 0};      // a reference to a node that isn't there (never its GUID)
  std::vector<Guid> order;
  std::unordered_map<Guid, uint32_t, GuidHash> index;
  auto walk = [&](auto&& self, Guid g) -> void {
    if (index.count(g) || !v.get(g)) return;
    index.emplace(g, static_cast<uint32_t>(order.size()));
    order.push_back(g);
    std::vector<Guid> list;
    v.kids(g, list);
    for (Guid k : list) self(self, k);
  };
  walk(walk, root);
  auto inner = [&](Guid g, Guid& out) {
    auto it = index.find(g);
    if (it == index.end()) return false;
    out = Guid{kInner, it->second};
    return true;
  };
  auto symbol = [&](Guid& g) {
    if (inner(g, g)) return;
    std::string k = v.mainKey(g);
    if (!k.empty()) g = keyAsGuid(k);
    else if (v.exists && !v.exists(g)) g = kMissing;
  };
  Refs refs;
  refs.symbol = symbol;
  refs.asset = [&](AssetId& a, Kind k) {
    std::string key = v.assetKey(a, k);
    if (!key.empty()) a.guid = kNoGuid, a.key = key;
    else if (a.guid != kNoGuid && v.exists && !v.exists(a.guid)) a.guid = kMissing;
    a.version.clear();
  };
  Sha1 h;
  for (size_t i = 0; i < order.size(); i++) {
    NodeProps q = *v.get(order[i]);
    clearBoundValues(q);
    clearIdentity(q);
    q.overrideKey = kNoGuid;
    q.asset().isPublishable = true;
    q.extra.erase("isSymbolPublishable");
    q.asset().sortPosition.clear();
    q.comp().isSoftDeleted = false;
    q.comp().ancestorPathBeforeDeletion.clear();
    if (i == 0) {
      q.parentIndex = {};
      q.transform.m02 = q.transform.m12 = 0;
    } else {
      Guid parent;
      if (!inner(q.parentIndex.guid, parent)) parent = kNoGuid;
      q.parentIndex = {parent, std::string()};
    }
    visitProps(q, refs);
    if (q.comp().detachedSymbolId.guid != kNoGuid) symbol(q.comp().detachedSymbolId.guid);
    // Preferred instances name mains by GUID (local) or by key (a copy's, a .fig's, a clipboard's): hashed alike.
    for (ComponentPropDef& d : q.comp().componentPropDefs)
      for (PreferredValue& pv : d.preferredValues) {
        bool ok = false;
        Guid m = Guid::parse(pv.key, &ok);
        if (ok) symbol(m);
        else if (pv.key.size() == 40) m = keyAsGuid(pv.key);
        else continue;
        pv.key = m.toString();
      }
    json::Writer w;
    codec::BlobsOut blobs;
    codec::writeChange(w, NodeChange::created(Guid{kInner, static_cast<uint32_t>(i)}, q), &blobs);
    h.update(w.take());
    for (const Bytes& b : blobs.list())
      if (b) h.update(b->data(), b->size());
    h.update("\n", 1);
  }
  return h.hexDigest();
}

std::vector<Guid> Editor::hiddenDependencies(Guid id) const {
  std::vector<Guid> out;
  Guid self = payloadRoot(id);
  GuidSet seen;
  auto add = [&](Guid g) {
    if (g == kNoGuid || g.isDerived() || !doc_.has(g) || isLibraryCopy(g)) return;
    Guid r = payloadRoot(g);
    if (r == self || !seen.insert(r).second) return;
    // Hidden (Hide when publishing, a "_" / "." name, a copied-in main) or deleted but kept: shipped only as a
    // dependency, never listed, so a change to it has to show in what uses it.
    const NodeProps& p = doc_.get(r)->props;
    if (assetHidden(r) || p.comp().isSoftDeleted) out.push_back(r);
  };
  Refs refs;
  refs.symbol = [&](Guid& g) {
    const Node* n = g.isDerived() ? nullptr : doc_.get(g);
    if (n && isComponentNode(n->props)) add(g);
  };
  refs.asset = [&](AssetId& a, Kind k) { add(k == Kind::STYLE ? findStyle(a) : k == Kind::VARIABLE ? findVariable(a) : findCollection(a)); };
  std::vector<Guid> nodes;
  realSubtree(id, nodes);
  for (Guid g : nodes) {
    NodeProps p = doc_.get(g)->props;
    visitProps(p, refs);
  }
  std::sort(out.begin(), out.end());
  return out;
}

std::string Editor::versionHashOf(Guid id, HashMemo& memo) const {
  if (auto it = memo.find(id); it != memo.end()) return it->second;
  memo[id] = std::string();  // a dependency cycle adds nothing
  HashView v;
  v.get = [&](Guid g) -> const NodeProps* {
    const Node* n = g.isDerived() ? nullptr : doc_.get(g);
    return n ? &n->props : nullptr;
  };
  v.kids = [&](Guid g, std::vector<Guid>& out) {
    for (Guid c : doc_.children(g))
      if (!c.isDerived()) out.push_back(c);
  };
  v.mainKey = [&](Guid g) {
    const Node* n = doc_.get(g);
    return n ? n->props.asset().key : std::string();
  };
  v.assetKey = [&](const AssetId& a, Kind k) {
    Guid t = k == Kind::STYLE ? findStyle(a) : k == Kind::VARIABLE ? findVariable(a) : findCollection(a);
    return t != kNoGuid && !doc_.get(t)->props.asset().key.empty() ? doc_.get(t)->props.asset().key : a.key;
  };
  v.exists = [&](Guid g) { return !g.isDerived() && doc_.has(g); };
  std::string own = hashAsset(id, v);
  // The hidden assets it uses (through any chain of hidden ones: theirs fold in theirs): their content is part of
  // what consumers get with this asset. Listed assets are published on their own and stay out.
  std::set<std::string> deps;
  for (Guid d : hiddenDependencies(id)) {
    std::string h = versionHashOf(d, memo);
    if (!h.empty()) deps.insert(h);
  }
  std::string out = own;
  if (!deps.empty()) {
    Sha1 h;
    h.update(own);
    for (const std::string& d : deps) h.update("\n" + d);
    out = h.hexDigest();
  }
  memo[id] = out;
  return out;
}

std::string Editor::assetVersionHash(Guid id) const {
  HashMemo memo;
  return versionHashOf(id, memo);
}

std::vector<Editor::AssetInfo> Editor::localAssets() const {
  std::vector<Guid> ids;
  doc_.forEach([&](const Node& n) {
    if (assetKindOf(n.guid) != AssetKind::NONE && !isLibraryCopy(n.guid)) ids.push_back(n.guid);
  });
  std::sort(ids.begin(), ids.end());
  std::vector<AssetInfo> out;
  std::unordered_map<Guid, std::vector<std::string>, GuidHash> depsByRoot;
  HashMemo memo;
  for (Guid id : ids) {
    AssetInfo info;
    fillAssetInfo(id, info);
    info.hidden = assetHidden(id);
    info.versionHash = versionHashOf(id, memo);
    Guid root = payloadRoot(id);
    auto it = depsByRoot.find(root);
    if (it == depsByRoot.end()) {
      std::vector<std::string> keys;
      for (Guid d : dependencyRoots({root})) {
        if (isLibraryCopy(d)) continue;  // another library's asset: travels in the payload, not in this manifest
        if (!doc_.get(d)->props.asset().key.empty()) keys.push_back(doc_.get(d)->props.asset().key);
        // A variable's collection is its own asset; a set's variants come with it.
      }
      it = depsByRoot.emplace(root, std::move(keys)).first;
    }
    info.dependencies = it->second;
    Guid page = doc_.pageOf(id);
    const Node* pn = doc_.get(page);
    if (pn && !pn->props.rare().internalOnly) {
      info.pageId = page;
      info.pageName = pn->props.name;
      std::vector<Guid> path = doc_.pathFromPage(id);
      if (path.size() > 1) {
        info.frameId = path[0];
        info.frameName = doc_.get(path[0])->props.name;
      }
    }
    out.push_back(std::move(info));
  }
  return out;
}

void Editor::encodeAssets(const std::vector<std::string>& keys, std::vector<EncodedAsset>& out, std::vector<ImageHash>& images) {
  out.clear();
  images.clear();
  // The assets asked for, then their dependencies (with keys of their own: the store files payloads by key).
  std::vector<Guid> asked;
  KeyIndex ix = indexKeys(*this);
  for (const std::string& k : keys) {
    Guid id = ix.local(k);
    if (id != kNoGuid && std::find(asked.begin(), asked.end(), id) == asked.end()) asked.push_back(id);
  }
  std::vector<Guid> roots;
  for (Guid id : asked) roots.push_back(payloadRoot(id));
  std::vector<Guid> deps = dependencyRoots(roots);
  std::vector<Guid> keyed;
  for (Guid d : deps)
    if (!isLibraryCopy(d)) {
      keyed.push_back(d);
      std::vector<Guid> inner;
      realSubtree(d, inner);
      for (Guid g : inner)
        if (g != d && assetKindOf(g) != AssetKind::NONE) keyed.push_back(g);
    }
  for (Guid id : asked) {
    std::vector<Guid> inner;
    realSubtree(payloadRoot(id), inner);
    for (Guid g : inner)
      if (assetKindOf(g) != AssetKind::NONE) keyed.push_back(g);
  }
  ensureAssetKeys(keyed);

  std::vector<std::pair<Guid, bool>> entries;  // asset, dependencyOnly
  for (Guid id : asked) entries.push_back({id, false});
  for (Guid d : deps)
    if (!isLibraryCopy(d) && std::find(asked.begin(), asked.end(), d) == asked.end()) entries.push_back({d, true});

  HashMemo hashes;
  auto hashOf = [&](Guid g) { return versionHashOf(g, hashes); };
  // A node as the payload carries it: references by GUID with the target's key beside it, local bookkeeping out,
  // each asset root's versionHash in `version`.
  auto payloadNode = [&](Guid g) {
    NodeProps q = doc_.get(g)->props;
    bool copy = isLibraryCopy(g);
    if (!copy) {
      q.asset().publishID = kNoGuid;
      q.asset().publishedVersion.clear();
      q.asset().libraryMoveInfo = {};
      q.asset().sourceLibraryKey.clear();
      q.asset().version = assetKindOf(g) != AssetKind::NONE ? hashOf(g) : std::string();
    }
    q.comp().isSoftDeleted = false;
    q.comp().ancestorPathBeforeDeletion.clear();
    Refs refs;
    refs.symbol = [](Guid&) {};
    refs.asset = [&](AssetId& a, Kind k) {
      Guid t = k == Kind::STYLE ? findStyle(a) : k == Kind::VARIABLE ? findVariable(a) : findCollection(a);
      if (t != kNoGuid) {
        a.guid = t;
        a.key = doc_.get(t)->props.asset().key;
        a.version.clear();
      }
    };
    visitProps(q, refs);
    // Preferred instances name local mains by GUID; in a payload, by key.
    for (ComponentPropDef& d : q.comp().componentPropDefs)
      for (PreferredValue& v : d.preferredValues) {
        bool ok = false;
        Guid m = Guid::parse(v.key, &ok);
        if (ok && doc_.has(m) && !doc_.get(m)->props.asset().key.empty()) v.key = doc_.get(m)->props.asset().key;
      }
    return NodeChange::created(g, q);
  };

  std::set<std::string> imageSet;
  struct Payload {
    std::vector<NodeChange> nodes;
    std::vector<ImageHash> images;
  };
  std::unordered_map<Guid, Payload, GuidHash> payloads;  // by payload root
  for (auto& [id, depOnly] : entries) {
    EncodedAsset e;
    fillAssetInfo(id, e.info);
    e.info.hidden = assetHidden(id);
    e.info.versionHash = hashOf(id);
    e.dependencyOnly = depOnly;
    Guid root = payloadRoot(id);
    std::vector<Guid> closure = dependencyRoots({root});
    for (Guid d : closure)
      if (!isLibraryCopy(d) && !doc_.get(d)->props.asset().key.empty()) e.info.dependencies.push_back(doc_.get(d)->props.asset().key);
    auto it = payloads.find(root);
    if (it == payloads.end()) {
      Payload pl;
      std::vector<Guid> order;
      realSubtree(root, order);
      for (Guid d : closure) realSubtree(d, order);
      std::set<std::string> mine;
      for (Guid g : order) {
        pl.nodes.push_back(payloadNode(g));
        collectImages(pl.nodes.back().props, mine);
      }
      for (const std::string& hx : mine) pl.images.push_back(ImageHash::fromHex(hx)), imageSet.insert(hx);
      it = payloads.emplace(root, std::move(pl)).first;
    }
    e.nodes = it->second.nodes;
    e.images = it->second.images;
    Guid page = doc_.pageOf(id);
    const Node* pn = doc_.get(page);
    if (pn && !pn->props.rare().internalOnly) {
      e.info.pageId = page;
      e.info.pageName = pn->props.name;
      std::vector<Guid> path = doc_.pathFromPage(id);
      if (path.size() > 1) e.info.frameId = path[0], e.info.frameName = doc_.get(path[0])->props.name;
    }
    out.push_back(std::move(e));
  }
  for (const std::string& h : imageSet) images.push_back(ImageHash::fromHex(h));
}

Status Editor::markPublished(const std::vector<PublishedEntry>& entries) {
  if (busy() || txn_.open) return E_BUSY;
  std::vector<NodeChange> changes;
  KeyIndex ix = indexKeys(*this);
  for (const PublishedEntry& e : entries) {
    Guid id = ix.local(e.key);
    if (id == kNoGuid) continue;
    const NodeProps& p = doc_.get(id)->props;
    NodeChange c = NodeChange::changed(id);
    c.mask = F_PUBLISHED_VERSION;
    c.props.asset().publishedVersion = e.versionHash;  // "": the version removed it (no longer published)
    // A moved main, published here: the move is done (docs/data.md §9.5).
    AssetKind k = assetKindOf(id);
    if (!e.versionHash.empty() && (k == AssetKind::COMPONENT || k == AssetKind::COMPONENT_SET) && p.asset().libraryMoveInfo.present()) {
      c.mask |= F_LIBRARY_MOVE_INFO;
      c.props.asset().libraryMoveInfo = {};
    }
    changes.push_back(std::move(c));
  }
  if (changes.empty()) return OK;
  begin(TxnKind::SYSTEM, "Publish");
  for (const NodeChange& c : changes) write(c);
  commit();
  return OK;
}

// ---- Import -------------------------------------------------------------------------------------

namespace {
bool acceptedSource(const NodeChange& c) {
  if (c.phase == Phase::REMOVED || c.guid.isDerived()) return false;
  NodeType t = c.props.type;
  return !(t == NodeType::NONE || t == NodeType::CANVAS || t == NodeType::DOCUMENT);
}
}  // namespace

void Editor::SourceNodes::add(const NodeChange& c) {
  if (acceptedSource(c)) byId.emplace(c.guid, &c);  // the first copy of a node wins
}

void Editor::SourceNodes::addMessages(const std::vector<std::vector<NodeChange>>& messages) {
  // Each message's nodes, grouped by their root in that message (a payload: its asset's subtree first, then the
  // subtrees of the assets it depends on, each as it was when that payload was published).
  struct Group {
    Guid root;
    std::vector<const NodeChange*> nodes;
  };
  std::vector<std::vector<Group>> groups(messages.size());
  own.assign(messages.size(), kNoGuid);
  for (size_t m = 0; m < messages.size(); m++) {
    std::unordered_map<Guid, const NodeChange*, GuidHash> ids;
    for (const NodeChange& c : messages[m])
      if (acceptedSource(c)) ids.emplace(c.guid, &c);
    std::unordered_map<Guid, size_t, GuidHash> groupOf;
    for (const NodeChange& c : messages[m]) {
      auto it = ids.find(c.guid);
      if (it == ids.end() || it->second != &c) continue;
      Guid r = c.guid;
      for (size_t steps = 0; steps < ids.size(); steps++) {
        auto parent = ids.find(ids.at(r)->props.parentIndex.guid);
        if (parent == ids.end() || parent->first == r) break;
        r = parent->first;
      }
      auto [g, fresh] = groupOf.emplace(r, groups[m].size());
      if (fresh) groups[m].push_back({r, {}});
      groups[m][g->second].nodes.push_back(&c);
      if (own[m] == kNoGuid) own[m] = r;
    }
  }
  // Every message's own asset first; an embedded one only when no message of its own came, whole, from the first
  // message that has it.
  GuidSet claimed;
  auto take = [&](const Group& g) {
    if (!claimed.insert(g.root).second) return;
    for (const NodeChange* c : g.nodes) byId.emplace(c->guid, c);
  };
  for (size_t m = 0; m < messages.size(); m++)
    for (const Group& g : groups[m])
      if (g.root == own[m]) take(g);
  for (size_t m = 0; m < messages.size(); m++)
    for (const Group& g : groups[m])
      if (g.root != own[m]) take(g);
}

void Editor::SourceNodes::link() {
  kids.clear();
  roots.clear();
  for (auto& [id, c] : byId) {
    Guid parent = c->props.parentIndex.guid;
    if (parent != id && byId.count(parent)) kids[parent].push_back(c);
    else roots.push_back(id);
  }
  for (auto& [parent, list] : kids)
    std::sort(list.begin(), list.end(), [](const NodeChange* a, const NodeChange* b) {
      return a->props.parentIndex.position != b->props.parentIndex.position ? a->props.parentIndex.position < b->props.parentIndex.position
                                                                            : a->guid < b->guid;
    });
  std::sort(roots.begin(), roots.end());
}

void Editor::SourceNodes::subtree(Guid root, std::vector<const NodeChange*>& out) const {
  auto it = byId.find(root);
  if (it == byId.end()) return;
  out.push_back(it->second);
  auto k = kids.find(root);
  if (k == kids.end()) return;
  for (const NodeChange* c : k->second) subtree(c->guid, out);
}

void Editor::matchTree(const std::vector<MatchNode>& nodes, Guid target, bool byPublishID, GuidMap& out) const {
  if (nodes.empty() || !doc_.has(target)) return;
  GuidSet used{target};
  out[nodes[0].id] = target;
  std::vector<Guid> have;
  realSubtree(target, have);
  // Components by the library GUID they carry, wherever they are (a copy's publishID); reserved for them.
  std::unordered_map<Guid, Guid, GuidHash> reserved;
  GuidSet reservedTargets;
  // Components that copy a library node the source no longer has (a deleted variant): never taken by key or name for
  // another one (a variant added since with the same key) — they keep their content for what uses them.
  GuidSet orphans;
  if (byPublishID) {
    std::unordered_map<Guid, Guid, GuidHash> byPub;
    for (Guid g : have) {
      const NodeProps& p = doc_.get(g)->props;
      if (g != target && isComponentNode(p) && p.asset().publishID != kNoGuid) byPub.emplace(p.asset().publishID, g);
    }
    GuidSet pubs;
    for (size_t i = 1; i < nodes.size(); i++) {
      if (!isComponentNode(*nodes[i].props)) continue;
      Guid pub = nodes[i].pub != kNoGuid ? nodes[i].pub : nodes[i].id;
      pubs.insert(pub);
      auto it = byPub.find(pub);
      if (it != byPub.end() && reservedTargets.insert(it->second).second) reserved[nodes[i].id] = it->second;
    }
    for (Guid g : have) {
      const NodeProps& p = doc_.get(g)->props;
      if (g != target && isComponentNode(p) && p.asset().publishID != kNoGuid && !pubs.count(p.asset().publishID)) orphans.insert(g);
    }
  }
  // Keys that occur once in the existing tree: a layer moved to another parent is still found.
  std::unordered_map<Guid, std::vector<Guid>, GuidHash> byKey;
  for (Guid g : have) byKey[doc_.get(g)->props.keyOf(g)].push_back(g);
  for (size_t i = 1; i < nodes.size(); i++) {
    const MatchNode& c = nodes[i];
    Guid found = kNoGuid;
    if (auto r = reserved.find(c.id); r != reserved.end()) found = r->second;
    Guid key = c.props->keyOf(c.id);
    bool comp = isComponentNode(*c.props);
    auto free = [&](Guid k) {
      return !k.isDerived() && !used.count(k) && !reservedTargets.count(k) && !orphans.count(k) && isComponentNode(doc_.get(k)->props) == comp;
    };
    auto parent = out.find(c.parent);
    if (found == kNoGuid && parent != out.end() && doc_.has(parent->second)) {
      const std::vector<Guid>& kids = doc_.children(parent->second);
      auto pass = [&](const std::function<bool(Guid, const NodeProps&)>& ok) {
        for (Guid k : kids)
          if (free(k) && ok(k, doc_.get(k)->props)) return k;
        return kNoGuid;
      };
      if (comp) found = pass([&](Guid k, const NodeProps& kp) { return kp.keyOf(k) == key && kp.name == c.props->name; });
      if (found == kNoGuid) found = pass([&](Guid k, const NodeProps& kp) { return kp.keyOf(k) == key; });
    }
    if (found == kNoGuid) {
      auto it = byKey.find(key);
      if (it != byKey.end() && it->second.size() == 1 && free(it->second[0])) found = it->second[0];
    }
    if (found == kNoGuid) continue;
    out[c.id] = found;
    used.insert(found);
  }
}

size_t Editor::remapRefs(NodeProps& p, const GuidMap* own, const GuidMap& map, const std::string& libraryKey) const {
  auto mapped = [&](Guid g, Guid& out) {
    if (own) {
      auto it = own->find(g);
      if (it != own->end()) return out = it->second, true;
    }
    auto it = map.find(g);
    if (it != map.end()) return out = it->second, true;
    return false;
  };
  size_t unresolved = 0;
  Refs refs;
  refs.symbol = [&](Guid& g) {
    if (mapped(g, g)) return;
    // A main the payload didn't bring: a copy of it already here; else none (never a local node that happens to share
    // the GUID) — counted: the callers bring every main a reference needs, so this is a payload that lacks one.
    g = copyByPublishID(libraryKey, g);
    if (g == kNoGuid) unresolved++;
  };
  refs.asset = [&](AssetId& a, Kind k) {
    if (a.guid != kNoGuid && mapped(a.guid, a.guid)) {
      a.key.clear();
      a.version.clear();
      return;
    }
    a.guid = kNoGuid;
    if (a.key.empty()) return;
    auto find = [&](const AssetId& id) { return k == Kind::STYLE ? findStyle(id) : k == Kind::VARIABLE ? findVariable(id) : findCollection(id); };
    // This library's copy of it, else any asset with the key.
    AssetId byCopy;
    byCopy.guid = copyRootByKey(libraryKey, a.key);
    Guid t = byCopy.guid != kNoGuid ? find(byCopy) : kNoGuid;
    if (t == kNoGuid) {
      AssetId byKey;
      byKey.key = a.key;
      t = find(byKey);
    }
    if (t != kNoGuid) {
      a.guid = t;
      a.key.clear();
      a.version.clear();
    }
  };
  visitProps(p, refs);
  if (p.comp().detachedSymbolId.guid != kNoGuid) {
    Guid g;
    p.comp().detachedSymbolId.guid = mapped(p.comp().detachedSymbolId.guid, g) ? g : kNoGuid;  // only a note of where it came from
  }
  // Preferred instances by GUID: the main that came along; one that didn't is the other file's and goes (never a
  // node here that happens to share the GUID). By key: kept (resolved within the main's library when read).
  for (ComponentPropDef& d : p.comp().componentPropDefs) {
    std::vector<PreferredValue> kept;
    for (PreferredValue& v : d.preferredValues) {
      bool ok = false;
      Guid g = Guid::parse(v.key, &ok);
      if (ok && !mapped(g, g)) continue;
      if (ok) v.key = g.toString();
      kept.push_back(v);
    }
    d.preferredValues = std::move(kept);
  }
  return unresolved;
}

void Editor::writeImports(const SourceNodes& src, std::vector<ImportPlan>& plans, GuidMap& map,
                          const std::vector<const NodeProps*>* extra) {
  const size_t n = plans.size();
  std::vector<std::vector<const NodeChange*>> trees(n);
  std::vector<GuidMap> own(n);
  // A source with several plans (several copies of one asset): references from the other plans go to its first.
  std::unordered_map<Guid, size_t, GuidHash> primary;
  for (size_t i = 0; i < n; i++) primary.emplace(plans[i].src, i);
  auto written = [&](size_t i) { return plans[i].target == kNoGuid || plans[i].replace; };
  // A source that is itself a library copy (a library using another one, a paste from a file that has the copy): its
  // components carry the library's GUIDs (publishID), kept; else the source's own GUIDs are the library's.
  auto sourceIsCopy = [&](size_t i) {
    auto it = src.byId.find(plans[i].src);
    return it != src.byId.end() && !it->second->props.asset().sourceLibraryKey.empty();
  };
  auto fresh = [&](size_t i) {
    own[i].clear();
    for (const NodeChange* c : trees[i]) own[i][c->guid] = newGuid();
  };
  auto publish = [&](size_t i) {
    for (auto& [from, to] : own[i]) map[from] = to;
  };
  // Node ids first (references between assets need them all): new ones, or an existing copy's, matched top-down.
  for (size_t i = 0; i < n; i++) {
    ImportPlan& plan = plans[i];
    src.subtree(plan.src, trees[i]);
    if (plan.target == kNoGuid) {
      fresh(i);
      continue;
    }
    bool keepPub = sourceIsCopy(i);
    std::vector<MatchNode> nodes;
    for (const NodeChange* c : trees[i])
      nodes.push_back({c->guid, c->props.parentIndex.guid, &c->props, keepPub && c->props.asset().publishID != kNoGuid ? c->props.asset().publishID : c->guid});
    matchTree(nodes, plan.target, plan.mode == ImportPlan::Mode::COPY, own[i]);
    if (plan.replace)
      for (const NodeChange* c : trees[i])
        if (!own[i].count(c->guid)) own[i][c->guid] = newGuid();
  }
  for (auto& [root, i] : primary) publish(i);
  // A copy kept as it is that lacks a node a written plan — or the paste's own nodes — refers to (a variant added
  // since): that asset comes in as a new copy (the old one keeps its users), so no reference is left pointing at
  // nothing.
  std::unordered_map<Guid, Guid, GuidHash> rootOf;
  for (size_t i = 0; i < n; i++)
    for (const NodeChange* c : trees[i]) rootOf.emplace(c->guid, plans[i].src);
  for (bool again = true; again;) {
    again = false;
    const GuidMap* mine = nullptr;
    Refs refs;
    refs.symbol = [&](Guid& g) {
      if ((mine && mine->count(g)) || map.count(g)) return;
      auto r = rootOf.find(g);
      if (r == rootOf.end()) return;
      size_t j = primary.at(r->second);
      if (written(j) || (plans[j].mode != ImportPlan::Mode::COPY && !plans[j].copiedIn)) return;
      plans[j].target = kNoGuid;
      fresh(j);
      publish(j);
      again = true;
    };
    refs.asset = [](AssetId&, Kind) {};
    for (size_t i = 0; i < n; i++) {
      if (!written(i)) continue;
      mine = &own[i];
      for (const NodeChange* c : trees[i]) {
        NodeProps p = c->props;
        visitProps(p, refs);
      }
    }
    mine = nullptr;
    if (extra)
      for (const NodeProps* e : *extra) {
        NodeProps p = *e;
        visitProps(p, refs);
      }
  }

  Guid canvas = internalCanvas(true);
  bool libraryWriteBefore = libraryWrite_;
  libraryWrite_ = true;
  // What replaced copies no longer have, removed once every plan is written (what uses it is known then).
  std::vector<Guid> leftovers;
  std::unordered_map<Guid, std::string, GuidHash> leftoverMains;  // a component left over → its copy's library
  for (size_t i = 0; i < n; i++) {
    ImportPlan& plan = plans[i];
    auto r = own[i].find(plan.src);
    plan.result = r != own[i].end() ? r->second : plan.target;
    if (!written(i)) continue;
    GuidSet done;
    bool copy = plan.mode == ImportPlan::Mode::COPY;
    bool keepPub = sourceIsCopy(i);
    std::string oldLibrary = plan.target != kNoGuid ? doc_.get(plan.target)->props.asset().sourceLibraryKey : std::string();
    for (const NodeChange* c : trees[i]) {
      Guid id = own[i][c->guid];
      NodeProps q = c->props;
      unresolved_ += remapRefs(q, &own[i], map, plan.libraryKey);
      bool root = c->guid == plan.src;
      bool component = q.type == NodeType::SYMBOL || q.isComponentSet();
      bool assetNode = component || q.isStyle() || q.type == NodeType::VARIABLE || q.type == NodeType::VARIABLE_SET;
      // Every node keeps the library node's key (instances' overrides find their layers by it).
      if (component || !assetNode) q.overrideKey = c->props.keyOf(c->guid);
      q.comp().isSoftDeleted = false;
      q.comp().ancestorPathBeforeDeletion.clear();
      q.asset().publishedVersion.clear();
      q.asset().libraryMoveInfo = {};
      if (copy) {
        q.asset().sourceLibraryKey = root ? plan.libraryKey : std::string();
        if (root) {
          q.asset().key = plan.key;
          q.asset().version = plan.version;
          q.asset().publishID = plan.publishID;
        } else if (component) {
          // The library's GUID: the source's own, or (a source that is a copy) the one it carries.
          if (!keepPub || q.asset().publishID == kNoGuid) q.asset().publishID = c->guid;
        } else {
          q.asset().publishID = kNoGuid;
          if (!assetNode) q.asset().key.clear(), q.asset().version.clear();
        }
      } else {
        // Copied in as this file's own: a key of its own (styles and variables have one from birth; mains on request).
        clearIdentity(q);
        if (assetNode && !component) q.asset().key = newAssetKey();
        if (root) q.asset().publishID = plan.publishID;  // the source, so a later paste finds it again
      }
      if (root) {
        if (plan.target != kNoGuid) q.parentIndex = doc_.get(plan.target)->props.parentIndex;
        else q.parentIndex = {canvas, doc_.positionAtEnd(canvas)};
      } else {
        q.parentIndex = {own[i][c->props.parentIndex.guid], c->props.parentIndex.position};
      }
      done.insert(id);
      const Node* existing = doc_.get(id);
      if (!existing) {
        write(NodeChange::created(id, q));
        continue;
      }
      NodeChange ch = NodeChange::changed(id);
      ch.mask = F_ALL & ~static_cast<FieldMask>(F_EXTRA);
      ch.props = q;
      // Unmodelled fields: replaced too (an empty value removes one).
      for (auto& [k, v] : existing->props.extra)
        if (!q.extra.count(k)) ch.props.extra[k] = "";
      if (!(ch.props.extra == existing->props.extra)) ch.mask |= F_EXTRA;
      write(ch);
    }
    if (plan.target != kNoGuid) {
      // What the new version no longer has.
      std::vector<Guid> have;
      realSubtree(plan.target, have);
      for (Guid g : have) {
        if (done.count(g)) continue;
        leftovers.push_back(g);
        if (copy && !oldLibrary.empty() && isComponentNode(doc_.get(g)->props)) leftoverMains.emplace(g, oldLibrary);
      }
    }
  }
  // A component the new version no longer has (a deleted variant) stays while something uses it — an instance, a
  // copy that wasn't updated — as a copy of its own, still the removed asset's (docs/data.md §9.6: instances keep
  // rendering; the editor offers Detach and Restore component).
  GuidSet kept;
  if (!leftoverMains.empty()) {
    GuidSet left(leftovers.begin(), leftovers.end());
    std::vector<Guid> queue;
    Refs refs;
    refs.symbol = [&](Guid& g) {
      if (leftoverMains.count(g) && kept.insert(g).second) queue.push_back(g);
    };
    refs.asset = [](AssetId&, Kind) {};
    doc_.forEach([&](const Node& node) {
      if (node.guid.isDerived() || left.count(node.guid)) return;
      NodeProps p = node.props;
      visitProps(p, refs);
    });
    for (size_t k = 0; k < queue.size(); k++) {
      std::vector<Guid> inner;
      realSubtree(queue[k], inner);
      for (Guid g : inner) {
        NodeProps p = doc_.get(g)->props;
        visitProps(p, refs);
      }
    }
    std::vector<Guid> roots(kept.begin(), kept.end());
    std::sort(roots.begin(), roots.end());
    for (Guid g : roots) {
      NodeChange c = NodeChange::changed(g);
      c.mask = F_PARENT_INDEX | F_TRANSFORM | F_SOURCE_LIBRARY_KEY;
      c.props.parentIndex = {canvas, doc_.positionAtEnd(canvas)};
      c.props.transform = doc_.worldTransform(g);
      c.props.asset().sourceLibraryKey = leftoverMains.at(g);
      write(c);
    }
  }
  GuidSet keptNodes;
  for (Guid g : kept) {
    std::vector<Guid> inner;
    realSubtree(g, inner);
    keptNodes.insert(inner.begin(), inner.end());
  }
  for (auto it = leftovers.rbegin(); it != leftovers.rend(); ++it)
    if (!keptNodes.count(*it) && doc_.has(*it)) write(NodeChange::removed(*it));
  libraryWrite_ = libraryWriteBefore;
}

void Editor::relinkCopies(const std::vector<std::pair<Guid, Guid>>& copyToLocal) {
  GuidMap relink;
  GuidSet gone;
  for (auto& [copy, local] : copyToLocal) {
    // The copy's nodes matched to the local asset's top-down (a main pasted from the library kept the library's keys,
    // as the copy did).
    std::vector<Guid> theirs;
    realSubtree(copy, theirs);
    std::vector<MatchNode> nodes;
    for (Guid g : theirs) {
      gone.insert(g);
      nodes.push_back({g, doc_.get(g)->props.parentIndex.guid, &doc_.get(g)->props});
    }
    GuidMap m;
    matchTree(nodes, local, false, m);
    for (auto& [from, to] : m) relink[from] = to;
    relink[copy] = local;
  }
  constexpr FieldMask kRefFields = F_SYMBOL_DATA | F_OVERRIDDEN_SYMBOL_ID | F_COMPONENT_PROP_DEFS | F_COMPONENT_PROP_ASSIGNMENTS |
                                   F_PARAM_MAP | F_FILLS | F_STROKES | F_EFFECTS | F_LAYOUT_GRIDS | F_TEXT_DATA | F_VECTOR_DATA |
                                   kStyleIdFields | F_VARIABLE_MODES | F_VARIABLE_SET_ID | F_VARIABLE_DATA_VALUES |
                                   F_DETACHED_SYMBOL_ID;
  std::vector<Guid> ids;
  doc_.forEach([&](const Node& n) {
    if (!n.guid.isDerived() && !gone.count(n.guid)) ids.push_back(n.guid);
  });
  std::sort(ids.begin(), ids.end());
  bool libraryWriteBefore = libraryWrite_;
  libraryWrite_ = true;
  for (Guid id : ids) {
    NodeProps p = doc_.get(id)->props;
    bool changed = false;
    Refs refs;
    refs.symbol = [&](Guid& g) {
      auto it = relink.find(g);
      if (it != relink.end()) g = it->second, changed = true;
    };
    refs.asset = [&](AssetId& a, Kind) {
      auto it = a.guid != kNoGuid ? relink.find(a.guid) : relink.end();
      if (it != relink.end()) a.guid = it->second, a.key.clear(), a.version.clear(), changed = true;
    };
    visitProps(p, refs);
    if (auto it = relink.find(p.comp().detachedSymbolId.guid); p.comp().detachedSymbolId.guid != kNoGuid && it != relink.end())
      p.comp().detachedSymbolId.guid = it->second, changed = true;
    if (!changed) continue;
    NodeChange c = NodeChange::changed(id);
    c.mask = kRefFields;
    c.props = std::move(p);
    write(c);
  }
  for (auto& [copy, local] : copyToLocal) {
    std::vector<Guid> nodes;
    realSubtree(copy, nodes);
    for (auto it = nodes.rbegin(); it != nodes.rend(); ++it)
      if (doc_.has(*it)) write(NodeChange::removed(*it));
  }
  libraryWrite_ = libraryWriteBefore;
}

Status Editor::importLibrary(const std::vector<std::vector<NodeChange>>& messages, const LibraryOptions& opts,
                             std::vector<ImportedAsset>& out, std::vector<ImageHash>* images) {
  out.clear();
  if (images) images->clear();
  if (busy()) return E_BUSY;
  if (opts.libraryKey.empty()) return E_INVALID;
  unresolved_ = 0;
  SourceNodes src;
  src.addMessages(messages);
  src.link();
  auto listed = [](const auto& list, const auto& x) { return std::find(list.begin(), list.end(), x) != list.end(); };
  auto wanted = [&](const std::string& key) { return !opts.hasKeys || listed(opts.keys, key); };
  auto inCopies = [&](Guid g) { return !opts.hasCopies || listed(opts.copies, g); };
  // asNew: the assets asked for (`keys`; default the first message's own asset) get new copies.
  std::string firstKey;
  if (!src.own.empty() && src.byId.count(src.own[0])) firstKey = src.byId.at(src.own[0])->props.asset().key;
  auto asNew = [&](const std::string& key) { return opts.asNew && !opts.update && (opts.hasKeys ? listed(opts.keys, key) : key == firstKey); };
  KeyIndex ix = indexKeys(*this);
  std::set<std::string> rootKeys;
  for (Guid r : src.roots) rootKeys.insert(src.byId.at(r)->props.asset().key);
  // Copies a redirect re-points (Move to this file): replaced by the new asset's payload, not their own.
  GuidSet redirectedCopies;
  if (opts.update)
    for (const Redirect& rd : opts.redirects)
      if (rootKeys.count(rd.toKey) && wanted(rd.toKey))
        for (Guid g : ix.copiesOf(rd.fromLibraryKey, rd.fromKey)) redirectedCopies.insert(g);
  std::vector<ImportPlan> plans;
  GuidMap map;
  for (Guid r : src.roots) {
    const NodeProps& rp = src.byId.at(r)->props;
    bool asset = rp.type == NodeType::SYMBOL || rp.isComponentSet() || rp.isStyle() || rp.type == NodeType::VARIABLE ||
                 rp.type == NodeType::VARIABLE_SET;
    if (!asset || rp.asset().key.empty()) continue;
    ImportPlan plan;
    plan.src = r;
    plan.key = rp.asset().key;
    plan.libraryKey = rp.asset().sourceLibraryKey.empty() ? opts.libraryKey : rp.asset().sourceLibraryKey;
    plan.publishID = !rp.asset().sourceLibraryKey.empty() && rp.asset().publishID != kNoGuid ? rp.asset().publishID : r;
    plan.version = rp.asset().version;
    if (!fileKey_.empty() && plan.libraryKey == fileKey_) {
      // One of this file's own assets (a library that uses this one): the local asset itself.
      Guid local = ix.local(plan.key);
      if (local != kNoGuid) {
        plan.mode = ImportPlan::Mode::LOCAL;
        plan.target = local;
        plans.push_back(plan);
        continue;
      }
    }
    if (asNew(plan.key)) {
      plans.push_back(plan);  // a new copy
      continue;
    }
    const std::vector<Guid>& have = ix.copiesOf(plan.libraryKey, plan.key);
    // Update: every copy of the key here (or those of `copies`), and the copies redirected to it.
    std::vector<std::pair<Guid, bool>> targets;  // copy, redirected
    if (opts.update && wanted(plan.key)) {
      for (Guid g : have)
        if (inCopies(g) && !redirectedCopies.count(g)) targets.push_back({g, false});
      for (const Redirect& rd : opts.redirects)
        if (rd.toKey == plan.key)
          for (Guid g : ix.copiesOf(rd.fromLibraryKey, rd.fromKey))
            if (inCopies(g) && std::none_of(targets.begin(), targets.end(), [&](const auto& t) { return t.first == g; }))
              targets.push_back({g, true});
      std::sort(targets.begin(), targets.end());
    }
    if (targets.empty()) {
      // Reused (the copy at the payload's version, else the first), or created when there is none.
      plan.target = pickCopy(doc_, have, plan.version);
      plans.push_back(plan);
      continue;
    }
    for (auto& [g, redirected] : targets) {
      ImportPlan p = plan;
      p.target = g;
      p.redirected = redirected;
      const NodeProps& tp = doc_.get(g)->props;
      p.replace = redirected || tp.asset().version != plan.version || tp.asset().sourceLibraryKey != plan.libraryKey;
      plans.push_back(p);
    }
  }
  // Redirects to this file's own assets (it is where they moved): their copies' users are relinked to them.
  std::vector<std::pair<Guid, Guid>> toLocal;
  if (opts.update)
    for (const Redirect& rd : opts.redirects) {
      Guid local = ix.local(rd.toKey);
      if (local == kNoGuid) continue;
      for (Guid old : ix.copiesOf(rd.fromLibraryKey, rd.fromKey))
        if (inCopies(old) && assetKindOf(old) == assetKindOf(local)) toLocal.push_back({old, local});
    }
  bool writes = !toLocal.empty() ||
                std::any_of(plans.begin(), plans.end(), [](const ImportPlan& p) { return p.target == kNoGuid || p.replace; });
  if (writes) {
    // Inside an open step (txnBegin): part of it.
    begin(opts.update ? TxnKind::USER : TxnKind::SYSTEM, opts.update ? "Update library assets" : "Library");
    writeImports(src, plans, map);
    if (!toLocal.empty()) relinkCopies(toLocal);
    commit();
#ifndef NDEBUG
    if (unresolved_) std::fprintf(stderr, "engine: a library import left %zu main reference(s) pointing at nothing\n", unresolved_);
#endif
  } else {
    // Nothing to write; the ids are still answered.
    for (ImportPlan& p : plans) p.result = p.target;
  }
  std::set<std::string> imageSet;
  GuidSet listedCopies;
  for (const ImportPlan& p : plans) {
    Guid root = p.result;
    if (root == kNoGuid || !doc_.has(root) || !listedCopies.insert(root).second) continue;
    std::vector<Guid> nodes;
    realSubtree(root, nodes);
    for (Guid g : nodes) {
      const NodeProps& q = doc_.get(g)->props;
      collectImages(q, imageSet);
      AssetKind k = assetKindOf(g);
      if (k == AssetKind::NONE) continue;
      ImportedAsset a;
      a.key = q.asset().key;
      a.id = g;
      a.kind = k;
      a.libraryKey = p.mode == ImportPlan::Mode::LOCAL ? fileKey_ : p.libraryKey;
      a.version = q.asset().version;
      a.created = p.target == kNoGuid;
      a.updated = p.replace;
      out.push_back(std::move(a));
    }
  }
  if (images)
    for (const std::string& h : imageSet) images->push_back(ImageHash::fromHex(h));
  return OK;
}

std::vector<Editor::AssetInfo> Editor::libraryUsage() const {
  std::vector<AssetInfo> out;
  if (!hasLibraryCopies_) return out;
  std::vector<Guid> roots;
  doc_.forEach([&](const Node& n) {
    if (!n.guid.isDerived() && !n.props.asset().sourceLibraryKey.empty() && assetKindOf(n.guid) != AssetKind::NONE) roots.push_back(n.guid);
  });
  std::sort(roots.begin(), roots.end());
  // Users: layers outside library copies (copies use each other as dependencies, not as uses).
  std::unordered_map<Guid, uint32_t, GuidHash> uses;
  Refs refs;
  refs.symbol = [&](Guid& g) {
    const Node* n = doc_.get(g);
    if (n && n->props.type == NodeType::SYMBOL) uses[g]++;
  };
  refs.asset = [&](AssetId& a, Kind k) {
    Guid t = k == Kind::STYLE ? findStyle(a) : k == Kind::VARIABLE ? findVariable(a) : findCollection(a);
    if (t != kNoGuid) uses[t]++;
  };
  doc_.forEach([&](const Node& n) {
    if (n.guid.isDerived() || isLibraryCopy(n.guid)) return;
    NodeProps p = n.props;
    if (p.type != NodeType::INSTANCE) p.comp().symbolData.symbolID = kNoGuid;
    visitProps(p, refs);
  });
  // A collection is used through its variables.
  std::unordered_map<Guid, uint32_t, GuidHash> byCollection;
  doc_.forEach([&](const Node& n) {
    if (n.props.type != NodeType::VARIABLE || n.guid.isDerived()) return;
    auto it = uses.find(n.guid);
    if (it != uses.end()) byCollection[findCollection(n.props.asset().variableSetID)] += it->second;
  });
  for (Guid r : roots) {
    AssetInfo info;
    fillAssetInfo(r, info);
    uint32_t count = uses[r];
    if (info.kind == AssetKind::COMPONENT_SET)
      for (Guid c : doc_.children(r)) count += uses[c];
    if (info.kind == AssetKind::VARIABLE_COLLECTION) count += byCollection[r];
    info.usage = count;
    out.push_back(std::move(info));
  }
  return out;
}

}  // namespace eng
