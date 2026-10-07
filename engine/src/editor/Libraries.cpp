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
#include <functional>
#include <set>

#include "base/Sha1.h"
#include "editor/Editor.h"
#include "scene/CodecJson.h"

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

void visitPaints(std::vector<Paint>& paints, const Refs& r) {
  for (Paint& p : paints) {
    visitData(p.colorVar, r);
    visitData(p.opacityVar, r);
    for (VariableData& s : p.stopVars) visitData(s, r);
  }
}

void visitProps(NodeProps& p, const Refs& r) {
  if (p.symbolData.symbolID != kNoGuid) r.symbol(p.symbolData.symbolID);
  if (p.overriddenSymbolID != kNoGuid) r.symbol(p.overriddenSymbolID);
  for (SymbolOverride& o : p.symbolData.overrides) visitProps(o.props, r);
  for (ComponentPropAssignment& a : p.componentPropAssignments)
    if (a.value.guidValue != kNoGuid) r.symbol(a.value.guidValue);
  for (ComponentPropDef& d : p.componentPropDefs)
    if (d.initialValue.guidValue != kNoGuid) r.symbol(d.initialValue.guidValue);
  for (AssetId* a : {&p.styleIdForFill, &p.styleIdForStrokeFill, &p.styleIdForText, &p.styleIdForEffect, &p.styleIdForGrid})
    if (a->present()) r.asset(*a, Kind::STYLE);
  for (VariableModeEntry& e : p.variableModeBySetMap)
    if (e.set.present()) r.asset(e.set, Kind::VARIABLE_COLLECTION);
  if (p.variableSetID.present()) r.asset(p.variableSetID, Kind::VARIABLE_COLLECTION);
  for (VariableModeValue& v : p.variableDataValues) visitData(v.data, r);
  for (ParamBinding& b : p.parameterConsumptionMap) visitData(b.data, r);
  visitPaints(p.fillPaints, r);
  visitPaints(p.strokePaints, r);
  for (TextStyle& t : p.textData.styleOverrideTable) visitPaints(t.fillPaints, r);
  for (VectorStyle& v : p.vectorData.styleOverrideTable) visitPaints(v.fillPaints, r);
  for (Effect& e : p.effects) {
    visitData(e.colorVar, r);
    visitData(e.radiusVar, r);
    visitData(e.spreadVar, r);
    visitData(e.xVar, r);
    visitData(e.yVar, r);
  }
  for (LayoutGrid& g : p.layoutGrids) {
    visitData(g.numSectionsVar, r);
    visitData(g.offsetVar, r);
    visitData(g.sectionSizeVar, r);
    visitData(g.gutterSizeVar, r);
  }
}

void collectImages(const std::vector<Paint>& paints, std::set<std::string>& out) {
  for (const Paint& p : paints)
    if (p.type == PaintType::IMAGE && p.image.present) out.insert(p.image.hex());
}

void collectImages(const NodeProps& p, std::set<std::string>& out) {
  collectImages(p.fillPaints, out);
  collectImages(p.strokePaints, out);
  for (const TextStyle& t : p.textData.styleOverrideTable) collectImages(t.fillPaints, out);
  for (const VectorStyle& v : p.vectorData.styleOverrideTable) collectImages(v.fillPaints, out);
  for (const SymbolOverride& o : p.symbolData.overrides) collectImages(o.props, out);
}

bool isComponentNode(const NodeProps& p) { return p.type == NodeType::SYMBOL || p.isComponentSet(); }

// Of several copies of one asset (Update selected instance leaves two), the one a reference or a reuse takes: the one
// at `version`, else the first by GUID (sorted lists).
Guid pickCopy(const Document& doc, const std::vector<Guid>& copies, const std::string& version) {
  if (!version.empty())
    for (Guid g : copies)
      if (doc.get(g)->props.version == version) return g;
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
    if (n.guid.isDerived() || n.props.key.empty() || ed.assetKindOf(n.guid) == Kind::NONE) return;
    if (!n.props.sourceLibraryKey.empty()) {
      ix.copies[KeyIndex::id(n.props.sourceLibraryKey, n.props.key)].push_back(n.guid);
      ix.anyLibrary[n.props.key].push_back(n.guid);
      return;
    }
    if (ed.isLibraryCopy(n.guid)) return;
    auto [it, fresh] = ix.locals.emplace(n.props.key, n.guid);
    if (fresh) return;
    // A live asset over a deleted one; else the first by GUID (deterministic).
    const NodeProps& was = doc.get(it->second)->props;
    if (was.isSoftDeleted != n.props.isSoftDeleted ? was.isSoftDeleted : n.guid < it->second) it->second = n.guid;
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
  p.key.clear();
  p.version.clear();
  p.publishedVersion.clear();
  p.sourceLibraryKey.clear();
  p.publishID = kNoGuid;
  p.libraryMoveInfo = {};
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
    if (!n->props.sourceLibraryKey.empty()) return cur;
    cur = n->props.parentIndex.guid;
  }
}

bool Editor::isCopiedMain(Guid id) const {
  const Node* n = doc_.get(id);
  if (!n || id.isDerived() || !(n->props.type == NodeType::SYMBOL || n->props.isComponentSet())) return false;
  Guid page = doc_.pageOf(id);
  const Node* pn = doc_.get(page);
  if (!pn || !pn->props.internalOnly) return false;
  Guid set = setOf(id);
  bool deleted = n->props.isSoftDeleted || (set != kNoGuid && doc_.get(set)->props.isSoftDeleted);
  return !deleted && !isLibraryCopy(id);
}

Guid Editor::copyRootByKey(const std::string& libraryKey, const std::string& key, const std::string& version) const {
  if (key.empty() || libraryKey.empty() || !hasLibraryCopies_) return kNoGuid;
  std::vector<Guid> found;
  doc_.forEach([&](const Node& n) {
    if (!n.guid.isDerived() && n.props.key == key && n.props.sourceLibraryKey == libraryKey && assetKindOf(n.guid) != AssetKind::NONE)
      found.push_back(n.guid);
  });
  std::sort(found.begin(), found.end());
  return pickCopy(doc_, found, version);
}

Guid Editor::localAssetByKey(const std::string& key) const {
  if (key.empty()) return kNoGuid;
  Guid found = kNoGuid;
  doc_.forEach([&](const Node& n) {
    if (n.guid.isDerived() || n.props.key != key || assetKindOf(n.guid) == AssetKind::NONE || isLibraryCopy(n.guid)) return;
    // A live asset over a deleted one with the same key.
    if (found == kNoGuid || (doc_.get(found)->props.isSoftDeleted && !n.props.isSoftDeleted)) found = n.guid;
  });
  return found;
}

Guid Editor::copyByPublishID(const std::string& libraryKey, Guid publishID) const {
  if (publishID == kNoGuid || !hasLibraryCopies_) return kNoGuid;
  Guid found = kNoGuid;
  doc_.forEach([&](const Node& n) {
    if (n.guid.isDerived() || n.props.publishID != publishID || (found != kNoGuid && found < n.guid)) return;
    if (!(n.props.type == NodeType::SYMBOL || n.props.isComponentSet())) return;
    Guid root = libraryRootOf(n.guid);
    if (root != kNoGuid && (libraryKey.empty() || doc_.get(root)->props.sourceLibraryKey == libraryKey)) found = n.guid;
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
      add(needRoot(findCollection(vp.variableSetID)));
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
      auto it = p.extra.find("isSymbolPublishable");
      if ((it != p.extra.end() && it->second == "false") || !p.isPublishable || hiddenName(p.name)) return true;
      Guid set = setOf(id);
      if (set != kNoGuid && assetHidden(set)) return true;
      return isCopiedMain(id);  // shipped only as a dependency
    }
    case AssetKind::COMPONENT_SET: return !p.isPublishable || hiddenName(p.name) || isCopiedMain(id);
    case AssetKind::STYLE: return !p.isPublishable || hiddenName(p.name);
    case AssetKind::VARIABLE_COLLECTION: return !p.isPublishable || hiddenName(p.name);
    case AssetKind::VARIABLE: {
      if (!p.isPublishable) return true;
      Guid set = findCollection(p.variableSetID);
      return set != kNoGuid && assetHidden(set);
    }
    default: return true;
  }
}

void Editor::fillAssetInfo(Guid id, AssetInfo& info) const {
  const NodeProps& p = doc_.get(id)->props;
  info.id = id;
  info.key = p.key;
  info.kind = assetKindOf(id);
  info.name = p.name;
  info.description = p.description;
  info.styleType = p.styleType;
  info.softDeleted = p.isSoftDeleted;
  info.publishedVersion = p.publishedVersion;
  info.libraryKey = p.sourceLibraryKey;
  info.version = p.version;
  info.publishID = p.publishID;
  if (info.kind == AssetKind::VARIABLE) {
    info.hasResolvedType = true;
    info.resolvedType = p.variableResolvedType;
    info.owner = findCollection(p.variableSetID);
  }
  if (info.kind == AssetKind::COMPONENT) {
    info.owner = setOf(id);
    if (info.owner != kNoGuid && doc_.get(info.owner)->props.isSoftDeleted) info.softDeleted = true;
  }
  if (info.owner != kNoGuid) info.ownerKey = doc_.get(info.owner)->props.key;
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
    if (assetKindOf(id) != AssetKind::NONE && !isLibraryCopy(id) && doc_.get(id)->props.key.empty()) missing.push_back(id);
  if (!missing.empty() && !txn_.open && !busy()) {
    // An ordinary journaled edit of the file, not an undo step (docs/data.md §9.1).
    begin(TxnKind::SYSTEM, "Asset keys");
    for (Guid id : missing) {
      NodeChange c = NodeChange::changed(id);
      c.mask = F_KEY;
      c.props.key = newAssetKey();
      write(c);
    }
    commit();
  }
  std::vector<std::pair<Guid, std::string>> out;
  for (Guid id : ids)
    if (assetKindOf(id) != AssetKind::NONE && !isLibraryCopy(id)) out.push_back({id, doc_.get(id)->props.key});
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
  };
  Refs refs;
  refs.symbol = symbol;
  refs.asset = [&](AssetId& a, Kind k) {
    std::string key = v.assetKey(a, k);
    if (!key.empty()) a.guid = kNoGuid, a.key = key;
    a.version.clear();
  };
  Sha1 h;
  for (size_t i = 0; i < order.size(); i++) {
    NodeProps q = *v.get(order[i]);
    clearBoundValues(q);
    clearIdentity(q);
    q.overrideKey = kNoGuid;
    q.isPublishable = true;
    q.extra.erase("isSymbolPublishable");
    q.sortPosition.clear();
    q.isSoftDeleted = false;
    q.ancestorPathBeforeDeletion.clear();
    if (i == 0) {
      q.parentIndex = {};
      q.transform.m02 = q.transform.m12 = 0;
    } else {
      Guid parent;
      if (!inner(q.parentIndex.guid, parent)) parent = kNoGuid;
      q.parentIndex = {parent, std::string()};
    }
    visitProps(q, refs);
    if (q.detachedSymbolId != kNoGuid) symbol(q.detachedSymbolId);
    for (ComponentPropDef& d : q.componentPropDefs)
      for (PreferredValue& pv : d.preferredValues) {
        bool ok = false;
        Guid m = Guid::parse(pv.key, &ok);
        if (!ok) continue;
        symbol(m);
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

std::string Editor::assetVersionHash(Guid id) const {
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
    return n ? n->props.key : std::string();
  };
  v.assetKey = [&](const AssetId& a, Kind k) {
    Guid t = k == Kind::STYLE ? findStyle(a) : k == Kind::VARIABLE ? findVariable(a) : findCollection(a);
    return t != kNoGuid && !doc_.get(t)->props.key.empty() ? doc_.get(t)->props.key : a.key;
  };
  return hashAsset(id, v);
}

std::vector<Editor::AssetInfo> Editor::localAssets() const {
  std::vector<Guid> ids;
  doc_.forEach([&](const Node& n) {
    if (assetKindOf(n.guid) != AssetKind::NONE && !isLibraryCopy(n.guid)) ids.push_back(n.guid);
  });
  std::sort(ids.begin(), ids.end());
  std::vector<AssetInfo> out;
  std::unordered_map<Guid, std::vector<std::string>, GuidHash> depsByRoot;
  for (Guid id : ids) {
    AssetInfo info;
    fillAssetInfo(id, info);
    info.hidden = assetHidden(id);
    info.versionHash = assetVersionHash(id);
    Guid root = payloadRoot(id);
    auto it = depsByRoot.find(root);
    if (it == depsByRoot.end()) {
      std::vector<std::string> keys;
      for (Guid d : dependencyRoots({root})) {
        if (isLibraryCopy(d)) continue;  // another library's asset: travels in the payload, not in this manifest
        if (!doc_.get(d)->props.key.empty()) keys.push_back(doc_.get(d)->props.key);
        // A variable's collection is its own asset; a set's variants come with it.
      }
      it = depsByRoot.emplace(root, std::move(keys)).first;
    }
    info.dependencies = it->second;
    Guid page = doc_.pageOf(id);
    const Node* pn = doc_.get(page);
    if (pn && !pn->props.internalOnly) {
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

  std::unordered_map<Guid, std::string, GuidHash> hashes;
  auto hashOf = [&](Guid g) -> const std::string& {
    auto it = hashes.find(g);
    if (it == hashes.end()) it = hashes.emplace(g, assetVersionHash(g)).first;
    return it->second;
  };
  // A node as the payload carries it: references by GUID with the target's key beside it, local bookkeeping out,
  // each asset root's versionHash in `version`.
  auto payloadNode = [&](Guid g) {
    NodeProps q = doc_.get(g)->props;
    bool copy = isLibraryCopy(g);
    if (!copy) {
      q.publishID = kNoGuid;
      q.publishedVersion.clear();
      q.libraryMoveInfo = {};
      q.sourceLibraryKey.clear();
      q.version = assetKindOf(g) != AssetKind::NONE ? hashOf(g) : std::string();
    }
    q.isSoftDeleted = false;
    q.ancestorPathBeforeDeletion.clear();
    Refs refs;
    refs.symbol = [](Guid&) {};
    refs.asset = [&](AssetId& a, Kind k) {
      Guid t = k == Kind::STYLE ? findStyle(a) : k == Kind::VARIABLE ? findVariable(a) : findCollection(a);
      if (t != kNoGuid) {
        a.guid = t;
        a.key = doc_.get(t)->props.key;
        a.version.clear();
      }
    };
    visitProps(q, refs);
    // Preferred instances name local mains by GUID; in a payload, by key.
    for (ComponentPropDef& d : q.componentPropDefs)
      for (PreferredValue& v : d.preferredValues) {
        bool ok = false;
        Guid m = Guid::parse(v.key, &ok);
        if (ok && doc_.has(m) && !doc_.get(m)->props.key.empty()) v.key = doc_.get(m)->props.key;
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
      if (!isLibraryCopy(d) && !doc_.get(d)->props.key.empty()) e.info.dependencies.push_back(doc_.get(d)->props.key);
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
    if (pn && !pn->props.internalOnly) {
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
    c.props.publishedVersion = e.versionHash;  // "": the version removed it (no longer published)
    // A moved main, published here: the move is done (docs/data.md §9.5).
    AssetKind k = assetKindOf(id);
    if (!e.versionHash.empty() && (k == AssetKind::COMPONENT || k == AssetKind::COMPONENT_SET) && p.libraryMoveInfo.present()) {
      c.mask |= F_LIBRARY_MOVE_INFO;
      c.props.libraryMoveInfo = {};
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
  if (byPublishID) {
    std::unordered_map<Guid, Guid, GuidHash> byPub;
    for (Guid g : have) {
      const NodeProps& p = doc_.get(g)->props;
      if (g != target && isComponentNode(p) && p.publishID != kNoGuid) byPub.emplace(p.publishID, g);
    }
    for (size_t i = 1; i < nodes.size(); i++) {
      if (!isComponentNode(*nodes[i].props)) continue;
      auto it = byPub.find(nodes[i].id);
      if (it != byPub.end() && reservedTargets.insert(it->second).second) reserved[nodes[i].id] = it->second;
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
    auto free = [&](Guid k) { return !k.isDerived() && !used.count(k) && !reservedTargets.count(k) && isComponentNode(doc_.get(k)->props) == comp; };
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

void Editor::remapRefs(NodeProps& p, const GuidMap* own, const GuidMap& map, const std::string& libraryKey) const {
  auto mapped = [&](Guid g, Guid& out) {
    if (own) {
      auto it = own->find(g);
      if (it != own->end()) return out = it->second, true;
    }
    auto it = map.find(g);
    if (it != map.end()) return out = it->second, true;
    return false;
  };
  Refs refs;
  refs.symbol = [&](Guid& g) {
    if (mapped(g, g)) return;
    // A main the payload didn't bring: a copy of it already here; else none (never a local node that happens to share
    // the GUID).
    g = copyByPublishID(libraryKey, g);
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
  if (p.detachedSymbolId != kNoGuid) {
    Guid g;
    p.detachedSymbolId = mapped(p.detachedSymbolId, g) ? g : kNoGuid;
  }
}

void Editor::writeImports(const SourceNodes& src, std::vector<ImportPlan>& plans, GuidMap& map) {
  const size_t n = plans.size();
  std::vector<std::vector<const NodeChange*>> trees(n);
  std::vector<GuidMap> own(n);
  // A source with several plans (several copies of one asset): references from the other plans go to its first.
  std::unordered_map<Guid, size_t, GuidHash> primary;
  for (size_t i = 0; i < n; i++) primary.emplace(plans[i].src, i);
  auto written = [&](size_t i) { return plans[i].target == kNoGuid || plans[i].replace; };
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
    std::vector<MatchNode> nodes;
    for (const NodeChange* c : trees[i]) nodes.push_back({c->guid, c->props.parentIndex.guid, &c->props});
    matchTree(nodes, plan.target, plan.mode == ImportPlan::Mode::COPY, own[i]);
    if (plan.replace)
      for (const NodeChange* c : trees[i])
        if (!own[i].count(c->guid)) own[i][c->guid] = newGuid();
  }
  for (auto& [root, i] : primary) publish(i);
  // A copy kept as it is that lacks a node a written plan refers to (a variant added since): that asset comes in as a
  // new copy (the old one keeps its users), so no reference is left pointing at nothing.
  std::unordered_map<Guid, Guid, GuidHash> rootOf;
  for (size_t i = 0; i < n; i++)
    for (const NodeChange* c : trees[i]) rootOf.emplace(c->guid, plans[i].src);
  for (bool again = true; again;) {
    again = false;
    for (size_t i = 0; i < n; i++) {
      if (!written(i)) continue;
      Refs refs;
      refs.symbol = [&](Guid& g) {
        if (own[i].count(g) || map.count(g)) return;
        auto r = rootOf.find(g);
        if (r == rootOf.end()) return;
        size_t j = primary.at(r->second);
        if (written(j) || plans[j].mode != ImportPlan::Mode::COPY) return;
        plans[j].target = kNoGuid;
        fresh(j);
        publish(j);
        again = true;
      };
      refs.asset = [](AssetId&, Kind) {};
      for (const NodeChange* c : trees[i]) {
        NodeProps p = c->props;
        visitProps(p, refs);
      }
    }
  }

  Guid canvas = internalCanvas(true);
  bool libraryWriteBefore = libraryWrite_;
  libraryWrite_ = true;
  for (size_t i = 0; i < n; i++) {
    ImportPlan& plan = plans[i];
    auto r = own[i].find(plan.src);
    plan.result = r != own[i].end() ? r->second : plan.target;
    if (!written(i)) continue;
    GuidSet done;
    bool copy = plan.mode == ImportPlan::Mode::COPY;
    for (const NodeChange* c : trees[i]) {
      Guid id = own[i][c->guid];
      NodeProps q = c->props;
      remapRefs(q, &own[i], map, plan.libraryKey);
      bool root = c->guid == plan.src;
      bool component = q.type == NodeType::SYMBOL || q.isComponentSet();
      bool assetNode = component || q.isStyle() || q.type == NodeType::VARIABLE || q.type == NodeType::VARIABLE_SET;
      // Every node keeps the library node's key (instances' overrides find their layers by it).
      if (component || !assetNode) q.overrideKey = c->props.keyOf(c->guid);
      q.isSoftDeleted = false;
      q.ancestorPathBeforeDeletion.clear();
      q.publishedVersion.clear();
      q.libraryMoveInfo = {};
      if (copy) {
        q.sourceLibraryKey = root ? plan.libraryKey : std::string();
        if (root) {
          q.key = plan.key;
          q.version = plan.version;
          q.publishID = plan.publishID;
        } else if (component) {
          if (q.publishID == kNoGuid || c->props.sourceLibraryKey.empty()) q.publishID = c->guid;
        } else {
          q.publishID = kNoGuid;
          if (!assetNode) q.key.clear(), q.version.clear();
        }
      } else {
        // Copied in as this file's own: a key of its own (styles and variables have one from birth; mains on request).
        clearIdentity(q);
        if (assetNode && !component) q.key = newAssetKey();
        if (root) q.publishID = plan.publishID;  // the source, so a later paste finds it again
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
      for (auto it = have.rbegin(); it != have.rend(); ++it)
        if (!done.count(*it) && doc_.has(*it)) write(NodeChange::removed(*it));
    }
  }
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
    if (auto it = relink.find(p.detachedSymbolId); p.detachedSymbolId != kNoGuid && it != relink.end())
      p.detachedSymbolId = it->second, changed = true;
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
  SourceNodes src;
  src.addMessages(messages);
  src.link();
  auto listed = [](const auto& list, const auto& x) { return std::find(list.begin(), list.end(), x) != list.end(); };
  auto wanted = [&](const std::string& key) { return !opts.hasKeys || listed(opts.keys, key); };
  auto inCopies = [&](Guid g) { return !opts.hasCopies || listed(opts.copies, g); };
  // asNew: the assets asked for (`keys`; default the first message's own asset) get new copies.
  std::string firstKey;
  if (!src.own.empty() && src.byId.count(src.own[0])) firstKey = src.byId.at(src.own[0])->props.key;
  auto asNew = [&](const std::string& key) { return opts.asNew && !opts.update && (opts.hasKeys ? listed(opts.keys, key) : key == firstKey); };
  KeyIndex ix = indexKeys(*this);
  std::set<std::string> rootKeys;
  for (Guid r : src.roots) rootKeys.insert(src.byId.at(r)->props.key);
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
    if (!asset || rp.key.empty()) continue;
    ImportPlan plan;
    plan.src = r;
    plan.key = rp.key;
    plan.libraryKey = rp.sourceLibraryKey.empty() ? opts.libraryKey : rp.sourceLibraryKey;
    plan.publishID = !rp.sourceLibraryKey.empty() && rp.publishID != kNoGuid ? rp.publishID : r;
    plan.version = rp.version;
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
      p.replace = redirected || tp.version != plan.version || tp.sourceLibraryKey != plan.libraryKey;
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
      a.key = q.key;
      a.id = g;
      a.kind = k;
      a.libraryKey = p.mode == ImportPlan::Mode::LOCAL ? fileKey_ : p.libraryKey;
      a.version = q.version;
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
    if (!n.guid.isDerived() && !n.props.sourceLibraryKey.empty() && assetKindOf(n.guid) != AssetKind::NONE) roots.push_back(n.guid);
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
    if (p.type != NodeType::INSTANCE) p.symbolData.symbolID = kNoGuid;
    visitProps(p, refs);
  });
  // A collection is used through its variables.
  std::unordered_map<Guid, uint32_t, GuidHash> byCollection;
  doc_.forEach([&](const Node& n) {
    if (n.props.type != NodeType::VARIABLE || n.guid.isDerived()) return;
    auto it = uses.find(n.guid);
    if (it != uses.end()) byCollection[findCollection(n.props.variableSetID)] += it->second;
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
