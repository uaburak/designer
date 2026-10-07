// Libraries (docs/data.md §9, docs/schema.md §8, R5): the engine's side.
//
// - Keys: every local asset (component, component set, style, collection, variable) gets a stable 40-hex `key` when
//   asked (ensureAssetKeys, before a publish); it never changes after that, and duplicates don't inherit it.
// - Publish: encodeAssets turns assets into payloads — a NODE_CHANGES Message per asset holding its nodes and every
//   node it depends on (nested mains, styles, variables, collections, library copies it uses), with the library's
//   GUIDs — and a content versionHash per asset (SHA-1 of its own nodes, canonical; its place on the page, publishing
//   flags and library bookkeeping left out), which changes only when the asset does.
// - Consume: importLibrary puts read-only copies on the internal canvas (docs/schema.md §8.2): fresh GUIDs, every
//   node's overrideKey = the library node's effective key, roots marked sourceLibraryKey / key / publishID / version.
//   Instances, aliases and style references then point at the copies by GUID, so everything that works for local
//   assets works for them. An update (one undo step) rewrites a copy in place, its nodes matched by overrideKey, so
//   GUIDs — and every instance's link and overrides — stay.
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

// Assets by key, for calls that look many up: library copy roots, and local assets (a live one over a deleted one).
struct KeyIndex {
  std::unordered_map<std::string, Guid> copies, locals;
  Guid copy(const std::string& key) const {
    auto it = copies.find(key);
    return it == copies.end() ? kNoGuid : it->second;
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
      ix.copies.emplace(n.props.key, n.guid);
      return;
    }
    if (ed.isLibraryCopy(n.guid)) return;
    auto [it, fresh] = ix.locals.emplace(n.props.key, n.guid);
    if (!fresh && doc.get(it->second)->props.isSoftDeleted && !n.props.isSoftDeleted) it->second = n.guid;
  });
  return ix;
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

Guid Editor::copyRootByKey(const std::string& key) const {
  if (key.empty() || !hasLibraryCopies_) return kNoGuid;
  Guid found = kNoGuid;
  doc_.forEach([&](const Node& n) {
    if (found == kNoGuid && !n.guid.isDerived() && n.props.key == key && !n.props.sourceLibraryKey.empty()) found = n.guid;
  });
  return found;
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
    if (found != kNoGuid || n.guid.isDerived() || n.props.publishID != publishID) return;
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

std::string Editor::assetVersionHash(Guid id) const {
  std::vector<Guid> nodes;
  realSubtree(id, nodes);
  std::sort(nodes.begin(), nodes.end());
  Sha1 h;
  for (Guid g : nodes) {
    NodeProps q = doc_.get(g)->props;
    // Not content: library bookkeeping, publishing flags, the panels' order, where the asset sits on its page.
    clearIdentity(q);
    q.isPublishable = true;
    q.extra.erase("isSymbolPublishable");
    q.sortPosition.clear();
    q.isSoftDeleted = false;
    q.ancestorPathBeforeDeletion.clear();
    if (g == id) {
      q.parentIndex = {};
      q.transform.m02 = q.transform.m12 = 0;
    }
    json::Writer w;
    codec::BlobsOut blobs;
    codec::writeChange(w, NodeChange::created(g, q), &blobs);
    std::string s = w.take();
    h.update(s);
    for (const Bytes& b : blobs.list())
      if (b) h.update(b->data(), b->size());
    h.update("\n", 1);
  }
  return h.hexDigest();
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
  std::unordered_map<Guid, std::vector<NodeChange>, GuidHash> payloads;  // by payload root
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
      std::vector<NodeChange> nodes;
      std::vector<Guid> order;
      realSubtree(root, order);
      for (Guid d : closure) realSubtree(d, order);
      for (Guid g : order) {
        nodes.push_back(payloadNode(g));
        collectImages(nodes.back().props, imageSet);
      }
      it = payloads.emplace(root, std::move(nodes)).first;
    }
    e.nodes = it->second;
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

Status Editor::markPublished(const std::vector<std::pair<std::string, std::string>>& entries) {
  if (busy() || txn_.open) return E_BUSY;
  std::vector<NodeChange> changes;
  KeyIndex ix = indexKeys(*this);
  for (auto& [key, hash] : entries) {
    Guid id = ix.local(key);
    if (id == kNoGuid) continue;
    NodeChange c = NodeChange::changed(id);
    c.mask = F_PUBLISHED_VERSION;
    c.props.publishedVersion = hash;
    changes.push_back(std::move(c));
  }
  if (changes.empty()) return OK;
  begin(TxnKind::SYSTEM, "Publish");
  for (const NodeChange& c : changes) write(c);
  commit();
  return OK;
}

// ---- Import -------------------------------------------------------------------------------------

void Editor::SourceNodes::add(const NodeChange& c) {
  if (c.phase == Phase::REMOVED || c.guid.isDerived()) return;
  NodeType t = c.props.type;
  if (t == NodeType::NONE || t == NodeType::CANVAS || t == NodeType::DOCUMENT) return;
  byId.emplace(c.guid, &c);  // the first copy of a node wins
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

void Editor::remapRefs(NodeProps& p, const GuidMap& map, const std::string& libraryKey) const {
  Refs refs;
  refs.symbol = [&](Guid& g) {
    auto it = map.find(g);
    if (it != map.end()) {
      g = it->second;
      return;
    }
    // A main the payload didn't bring: a copy of it already here; else none (never a local node that happens to share
    // the GUID).
    g = copyByPublishID(libraryKey, g);
  };
  refs.asset = [&](AssetId& a, Kind k) {
    if (a.guid != kNoGuid) {
      auto it = map.find(a.guid);
      if (it != map.end()) {
        a.guid = it->second;
        a.key.clear();
        a.version.clear();
        return;
      }
    }
    a.guid = kNoGuid;
    if (!a.key.empty()) {
      AssetId byKey;
      byKey.key = a.key;
      Guid t = k == Kind::STYLE ? findStyle(byKey) : k == Kind::VARIABLE ? findVariable(byKey) : findCollection(byKey);
      if (t != kNoGuid) {
        a.guid = t;
        a.key.clear();
        a.version.clear();
      }
    }
  };
  visitProps(p, refs);
  if (p.detachedSymbolId != kNoGuid) {
    auto it = map.find(p.detachedSymbolId);
    p.detachedSymbolId = it != map.end() ? it->second : kNoGuid;
  }
}

void Editor::writeImports(const SourceNodes& src, std::vector<ImportPlan>& plans, GuidMap& map) {
  // Node ids first (references between assets need them all).
  std::vector<std::vector<const NodeChange*>> trees(plans.size());
  std::vector<std::unordered_map<Guid, Guid, GuidHash>> existingByKey(plans.size());
  for (size_t i = 0; i < plans.size(); i++) {
    ImportPlan& plan = plans[i];
    src.subtree(plan.src, trees[i]);
    if (plan.target == kNoGuid) {
      for (const NodeChange* c : trees[i]) map[c->guid] = newGuid();
      continue;
    }
    // An existing node: its nodes by key (copies keep the library's keys).
    std::vector<Guid> have;
    realSubtree(plan.target, have);
    for (Guid g : have) existingByKey[i][doc_.get(g)->props.keyOf(g)] = g;
    map[plan.src] = plan.target;
    for (const NodeChange* c : trees[i]) {
      if (c->guid == plan.src) continue;
      auto it = existingByKey[i].find(c->props.keyOf(c->guid));
      if (it != existingByKey[i].end()) map[c->guid] = it->second;
      else if (plan.replace) map[c->guid] = newGuid();
    }
  }
  Guid canvas = internalCanvas(true);
  libraryWrite_ = true;
  for (size_t i = 0; i < plans.size(); i++) {
    ImportPlan& plan = plans[i];
    if (plan.target != kNoGuid && !plan.replace) continue;
    GuidSet written;
    bool copy = plan.mode == ImportPlan::Mode::COPY;
    for (const NodeChange* c : trees[i]) {
      Guid id = map[c->guid];
      NodeProps q = c->props;
      remapRefs(q, map, plan.libraryKey);
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
        q.parentIndex = {map[c->props.parentIndex.guid], c->props.parentIndex.position};
      }
      written.insert(id);
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
        if (!written.count(*it) && doc_.has(*it)) write(NodeChange::removed(*it));
    }
  }
  libraryWrite_ = false;
}

void Editor::relinkCopies(const std::vector<std::pair<Guid, Guid>>& copyToLocal) {
  GuidMap relink;
  GuidSet gone;
  for (auto& [copy, local] : copyToLocal) {
    // The local asset's nodes by key (a main pasted from the library kept the library's keys, as the copy did).
    std::unordered_map<Guid, Guid, GuidHash> byKey;
    std::vector<Guid> mine, theirs;
    realSubtree(local, mine);
    for (Guid g : mine) byKey.emplace(doc_.get(g)->props.keyOf(g), g);
    realSubtree(copy, theirs);
    for (Guid g : theirs) {
      gone.insert(g);
      auto it = byKey.find(doc_.get(g)->props.keyOf(g));
      if (it != byKey.end()) relink[g] = it->second;
    }
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
    for (auto it = nodes.rbegin(); it != nodes.rend(); ++it) write(NodeChange::removed(*it));
  }
  libraryWrite_ = false;
}

Status Editor::importLibrary(const std::vector<std::vector<NodeChange>>& messages, const LibraryOptions& opts,
                             std::vector<ImportedAsset>& out) {
  out.clear();
  if (busy() || txn_.open) return E_BUSY;
  if (opts.libraryKey.empty()) return E_INVALID;
  SourceNodes src;
  for (const auto& m : messages)
    for (const NodeChange& c : m) src.add(c);
  src.link();
  auto wanted = [&](const std::string& key) {
    return !opts.hasKeys || std::find(opts.keys.begin(), opts.keys.end(), key) != opts.keys.end();
  };
  std::vector<ImportPlan> plans;
  GuidMap map;
  KeyIndex ix = indexKeys(*this);
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
    plan.target = ix.copy(plan.key);
    if (plan.target == kNoGuid && opts.update)
      for (auto& [from, to] : opts.redirects)
        if (to == plan.key) {
          Guid old = ix.copy(from);
          if (old != kNoGuid) plan.target = old, plan.redirected = true;
        }
    if (plan.target != kNoGuid) {
      const NodeProps& tp = doc_.get(plan.target)->props;
      plan.replace = opts.update && wanted(plan.key) && (plan.redirected || tp.version != plan.version || tp.sourceLibraryKey != plan.libraryKey);
    }
    plans.push_back(plan);
  }
  // Redirects to this file's own assets (it is where they moved): their copies' users are relinked to them.
  std::vector<std::pair<Guid, Guid>> toLocal;
  if (opts.update)
    for (auto& [from, to] : opts.redirects) {
      Guid old = ix.copy(from), local = ix.local(to);
      if (old != kNoGuid && local != kNoGuid && assetKindOf(old) == assetKindOf(local)) toLocal.push_back({old, local});
    }
  bool writes = !toLocal.empty() ||
                std::any_of(plans.begin(), plans.end(), [](const ImportPlan& p) { return p.target == kNoGuid || p.replace; });
  if (writes) {
    begin(opts.update ? TxnKind::USER : TxnKind::SYSTEM, opts.update ? "Update library assets" : "Library");
    writeImports(src, plans, map);
    if (!toLocal.empty()) relinkCopies(toLocal);
    commit();
  } else {
    // Nothing to write; the ids are still answered.
    for (ImportPlan& p : plans) map[p.src] = p.target;
  }
  for (const ImportPlan& p : plans) {
    auto it = map.find(p.src);
    if (it == map.end() || !doc_.has(it->second)) continue;
    std::vector<Guid> nodes;
    realSubtree(it->second, nodes);
    for (Guid g : nodes) {
      AssetKind k = assetKindOf(g);
      if (k == AssetKind::NONE) continue;
      const NodeProps& q = doc_.get(g)->props;
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
