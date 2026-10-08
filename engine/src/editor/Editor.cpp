#include "editor/Editor.h"

#include "text/TextEdit.h"

#include <algorithm>
#include <cmath>

namespace eng {

const char* toolName(Tool t) {
  static constexpr const char* kNames[] = {"MOVE", "SCALE", "HAND", "FRAME", "SECTION", "SLICE", "RECTANGLE", "LINE", "ARROW",
                                           "ELLIPSE", "POLYGON", "STAR", "IMAGE", "PEN", "PENCIL", "TEXT", "COMMENT",
                                           "ANNOTATION", "MEASUREMENT"};
  auto i = static_cast<size_t>(t);
  return i < sizeof kNames / sizeof kNames[0] ? kNames[i] : "MOVE";
}

bool toolImplemented(Tool t) {
  return t == Tool::MOVE || t == Tool::HAND || t == Tool::FRAME || t == Tool::SECTION || t == Tool::RECTANGLE || t == Tool::ELLIPSE || t == Tool::TEXT ||
         t == Tool::LINE || t == Tool::ARROW || t == Tool::POLYGON || t == Tool::STAR || t == Tool::PEN || t == Tool::PENCIL ||
         t == Tool::ANNOTATION || t == Tool::MEASUREMENT;
}

const char* txnKindName(TxnKind k) {
  switch (k) {
    case TxnKind::UNDO: return "UNDO";
    case TxnKind::REDO: return "REDO";
    case TxnKind::SYSTEM: return "SYSTEM";
    default: return "USER";
  }
}

const char* cursorName(CursorKind k) {
  static constexpr const char* kNames[] = {"DEFAULT", "HAND", "GRABBING", "CROSSHAIR", "PEN", "PEN_ADD", "PEN_REMOVE", "PEN_CLOSE",
                                           "IBEAM", "RESIZE", "ROTATE", "MOVE_DUPLICATE", "ZOOM_IN", "ZOOM_OUT", "EYEDROPPER",
                                           "NOT_ALLOWED"};
  return kNames[static_cast<size_t>(k)];
}

Editor::Editor() = default;

// ---- Transactions -----------------------------------------------------------

void Editor::begin(TxnKind kind, const std::string& label) {
  if (txn_.open) {
    txn_.depth++;
    return;
  }
  txn_.open = true;
  txn_.depth = 1;
  txn_.kind = kind;
  txn_.label = label;
  txn_.changes.clear();
  layoutDirty_.clear();
  groupsTouched_.clear();
  edited_.clear();
  if (kind == TxnKind::USER || kind == TxnKind::GESTURE) undo_.begin(selection_, label);
}

void Editor::noteNode(Guid id, uint32_t groups) {
  auto it = nodeEventIndex_.find(id);
  if (it == nodeEventIndex_.end()) {
    nodeEventIndex_[id] = events_.nodes.size();
    events_.nodes.push_back({id, groups});
  } else {
    events_.nodes[it->second].second |= groups;
  }
}

void Editor::indexChange(const NodeChange& c) {
  if (c.guid.isDerived()) return;
  const Node* n = c.phase == Phase::REMOVED ? nullptr : doc_.get(c.guid);
  FieldMask m = c.phase == Phase::CHANGED ? c.mask : F_ALL;
  if (m & F_KEY) {
    auto old = keyOf_.find(c.guid);
    const std::string* now = n && !n->props.asset().key.empty() ? &n->props.asset().key : nullptr;
    if (old != keyOf_.end() && (!now || old->second != *now)) {
      auto bucket = keyIndex_.find(old->second);
      if (bucket != keyIndex_.end()) {
        auto& list = bucket->second;
        list.erase(std::remove(list.begin(), list.end(), c.guid), list.end());
        if (list.empty()) keyIndex_.erase(bucket);
      }
      keyOf_.erase(old);
      old = keyOf_.end();
    }
    if (now && old == keyOf_.end()) {
      keyIndex_[*now].push_back(c.guid);
      keyOf_[c.guid] = *now;
    }
  }
  if (m & (F_SYMBOL_DATA | F_TYPE)) {
    auto old = instanceMain_.find(c.guid);
    Guid now = n && n->props.type == NodeType::INSTANCE ? n->props.comp().symbolData.symbolID : kNoGuid;
    if (old != instanceMain_.end() && old->second != now) {
      auto count = instanceCounts_.find(old->second);
      if (count != instanceCounts_.end() && --count->second == 0) instanceCounts_.erase(count);
      instanceMain_.erase(old);
      old = instanceMain_.end();
    }
    if (now != kNoGuid && old == instanceMain_.end()) {
      instanceCounts_[now]++;
      instanceMain_[c.guid] = now;
    }
  }
  if (m & F_TYPE) {
    if (n && n->props.type == NodeType::DOCUMENT) docNode_ = c.guid;
    else if (c.guid == docNode_) docNode_ = kNoGuid;
  }
}

void Editor::rebuildIndexes() {
  keyIndex_.clear();
  keyOf_.clear();
  instanceCounts_.clear();
  instanceMain_.clear();
  docNode_ = kNoGuid;
  infoCache_.clear();
  annotated_.clear();
  doc_.forEach([&](const Node& n) {
    if (n.guid.isDerived()) return;
    if (annot::hasNotes(n.props)) annotated_.insert(n.guid);
    if (!n.props.asset().key.empty()) {
      keyIndex_[n.props.asset().key].push_back(n.guid);
      keyOf_[n.guid] = n.props.asset().key;
    }
    if (n.props.type == NodeType::INSTANCE && n.props.comp().symbolData.symbolID != kNoGuid) {
      instanceCounts_[n.props.comp().symbolData.symbolID]++;
      instanceMain_[n.guid] = n.props.comp().symbolData.symbolID;
    }
    if (n.props.type == NodeType::DOCUMENT) docNode_ = n.guid;
  });
  // Deterministic buckets (a lookup that ties picks the smallest GUID).
  for (auto& [key, list] : keyIndex_) std::sort(list.begin(), list.end());
}

const std::vector<Guid>* Editor::nodesWithKey(const std::string& key) const {
  auto it = keyIndex_.find(key);
  return it == keyIndex_.end() ? nullptr : &it->second;
}

void Editor::noteChange(const NodeChange& c, NodeType typeBefore) {
  if (c.phase != Phase::REMOVED && (c.phase == Phase::CREATED || (c.mask & F_SOURCE_LIBRARY_KEY)) && !c.props.asset().sourceLibraryKey.empty())
    hasLibraryCopies_ = true;
  if (!applyingStored_ && (!storedText_.empty() || !storedSymbols_.empty())) invalidateStored(c, typeBefore);
  indexChange(c);
  noteAnnotated(c);
  markInstanceDirty(c);
  noteBindings(c, typeBefore);
  FieldMask mask = c.phase == Phase::CHANGED ? c.mask : F_ALL;
  if (typeBefore == NodeType::TEXT || c.phase != Phase::CHANGED) textCache_.erase(c.guid);
  else if (mask & (kTextLayoutFields | F_SIZE | F_FILLS | F_TYPE | F_EXTRA)) textCache_.erase(c.guid);
  if (c.phase != Phase::CHANGED || (mask & (kTextLayoutFields | F_FILLS | F_TYPE | F_EXTRA))) measured_.erase(c.guid);
  if (text_.node == c.guid) events_.textEdit = true;
  noteNode(c.guid, fieldGroups(mask));
  if (c.phase != Phase::CHANGED || (c.mask & (F_PARENT_INDEX | F_NAME | F_VISIBLE | F_LOCKED | F_TYPE | F_STACK_MODE)))
    events_.structure = true;
  if (c.phase != Phase::CHANGED || (c.mask & F_PARENT_INDEX)) {
    // Whose child lists changed: the parent it left and the one it joined (the change log knows the former).
    const Document::ChangeRecord* rec = doc_.lastChange();
    Guid before = rec && rec->id == c.guid ? rec->parentBefore : kNoGuid;
    const Node* now = c.phase == Phase::REMOVED ? nullptr : doc_.get(c.guid);
    Guid after = now ? now->props.parentIndex.guid : kNoGuid;
    auto note = [&](Guid parent) {
      if (parent == kNoGuid || events_.structureAll) return;
      auto& list = events_.structureParents;
      if (std::find(list.begin(), list.end(), parent) != list.end()) return;
      if (list.size() >= 256) {
        events_.structureAll = true;
        list.clear();
        return;
      }
      list.push_back(parent);
    };
    note(before);
    if (after != before) note(after);
  }
  bool canvas = typeBefore == NodeType::CANVAS || (c.phase == Phase::CREATED && c.props.type == NodeType::CANVAS);
  if (canvas && (c.phase != Phase::CHANGED || (c.mask & (F_NAME | F_PARENT_INDEX | F_INTERNAL_ONLY)))) events_.pages = true;
  needsRender_ = true;
}

void Editor::write(const NodeChange& change) {
  // An instance's sublayers: the materializer and layout write them directly; edits become overrides.
  if (change.guid.isDerived()) {
    if (deriving_ || inLayout_) applyDerivedDirect(change);
    else writeDerived(change);
    return;
  }
  const NodeChange* c = &change;
  // A reduced copy of the change, made only when needed (a NodeChange is large: writes are hot).
  std::unique_ptr<NodeChange> reduced;
  auto own = [&]() -> NodeChange& {
    if (!reduced) {
      reduced = std::make_unique<NodeChange>(*c);
      c = reduced.get();
    }
    return *reduced;
  };
  const Node* existing = doc_.get(change.guid);
  // The library code's own writes (copies replaced, assets brought in) are the payload's values as they are: not user
  // edits (no detaching, no instance overrides), though undoable.
  bool userEdit = !deriving_ && !inLayout_ && !resolving_ && !libraryWrite_ && txn_.open &&
                  (txn_.kind == TxnKind::USER || txn_.kind == TxnKind::GESTURE);
  if (userEdit && change.phase != Phase::REMOVED && (change.phase == Phase::CREATED || (change.mask & F_PARENT_INDEX)) &&
      change.props.parentIndex.guid.isDerived()) {
    // Into a slot of an instance: into its content frame (the slot diverges from the main on its first edit).
    Guid content = slotContentFor(change.props.parentIndex.guid, true);
    if (content != kNoGuid) {
      NodeChange redirected = change;
      redirected.props.parentIndex.guid = content;
      return write(redirected);
    }
  }
  if (hasLibraryCopies_ && (userEdit || (applyGuard_ && !libraryWrite_ && !deriving_ && !inLayout_ && !resolving_))) {
    // Library copies are read-only (docs/schema.md §8.2) for user edits and system changes from outside: nothing in
    // them is written, removed or added to — except a copy's root made local (its sourceLibraryKey cleared: Restore
    // component of a removed library component).
    if (isLibraryCopy(change.guid)) {
      bool makeLocal = change.phase == Phase::CHANGED && (change.mask & F_SOURCE_LIBRARY_KEY) && change.props.asset().sourceLibraryKey.empty() &&
                       existing && !existing->props.asset().sourceLibraryKey.empty();
      if (!makeLocal) return;
    }
    if (change.phase != Phase::REMOVED && (change.phase == Phase::CREATED || (change.mask & F_PARENT_INDEX)) &&
        isLibraryCopy(change.props.parentIndex.guid))
      return;
  }
  if (userEdit) {
    // Layers can't be added to or moved into an instance (slot content frames aside).
    if (change.phase == Phase::CREATED && isStructuralTarget(change.props.parentIndex.guid) && !change.props.comp().isSlotContent) return;
    if (change.phase == Phase::CHANGED && (change.mask & F_PARENT_INDEX) && isStructuralTarget(change.props.parentIndex.guid) &&
        !(existing && existing->props.parentIndex.guid == change.props.parentIndex.guid)) {
      own().mask &= ~static_cast<FieldMask>(F_PARENT_INDEX | F_TRANSFORM);
      if (!c->mask) return;
    }
    // An instance takes overridable fields and its own; the rest comes from its main.
    if (c->phase == Phase::CHANGED && existing && existing->props.type == NodeType::INSTANCE) {
      constexpr FieldMask kInstanceWritable =
          ~(F_TYPE | F_STACK_MODE | F_STACK_WRAP | F_STACK_REVERSE_Z | F_BORDERS_TAKE_SPACE | F_VECTOR_DATA | F_BOOLEAN_OPERATION |
            F_MASK | F_RESIZE_TO_FIT | F_COUNT | F_STAR_INNER_SCALE | F_ARC_DATA | F_HANDLE_MIRRORING | F_COMPONENT_PROP_DEFS |
            F_IS_STATE_GROUP | F_VARIANT_PROP_SPECS | F_STATE_GROUP_ORDERS | F_IS_SLOT | F_IS_SLOT_CONTENT | F_IS_SOFT_DELETED |
            F_ANCESTOR_PATH | F_BACKGROUND_COLOR | F_BACKGROUND_ENABLED | F_INTERNAL_ONLY | kAssetFields);
      if (c->mask & ~kInstanceWritable) {
        own().mask &= kInstanceWritable;
        if (!c->mask) return;
      }
    }
  }
  if (c->phase == Phase::CHANGED) {
    // Equal values are no-ops (docs/engine.md §9.1).
    if (!existing) return;
    FieldMask mask = differingFields(existing->props, c->props, c->mask);
    if (!mask) return;
    if (mask != c->mask) own().mask = mask;
    // A user's edit of a bound value detaches the variable or the style it came from (Figma).
    if (userEdit && existing->props.hasBindings()) {
      NodeChange& r = own();
      detachEdited(existing->props, r);
      r.mask = differingFields(existing->props, r.props, r.mask);
      if (!r.mask) return;
    }
  }
  if (userEdit && editTracking_) noteEdited(*c);
  NodeType typeBefore = existing ? existing->props.type : NodeType::NONE;
  Guid parentBefore = existing ? existing->props.parentIndex.guid : kNoGuid;
  bool record = txn_.open && (txn_.kind == TxnKind::USER || txn_.kind == TxnKind::GESTURE);
  // An instance's bindings as they were (its root override records only what changed).
  std::vector<ParamBinding> mapBefore;
  bool rootOverride = userEdit && c->phase == Phase::CHANGED && typeBefore == NodeType::INSTANCE;
  if (rootOverride && (c->mask & F_PARAM_MAP)) mapBefore = existing->props.parameterConsumptionMap;
  if (txn_.open) txn_.changes.touch(doc_, *c);
  if (record) {
    NodeChange inverse;
    if (!doc_.apply(*c, &inverse)) return;
    undo_.record(std::move(inverse));
  } else if (!doc_.apply(*c)) {
    return;
  }
  markLayout(*c, parentBefore);
  noteChange(*c, typeBefore);
  // An edit of an instance's own fields that are its root's is kept as its root override (docs/schema.md §5.2).
  if (rootOverride) recordRootOverride(c->guid, *c, &mapBefore);
}

void Editor::markLayout(const NodeChange& c, Guid parentBefore) {
  if (inLayout_ || !txn_.open || !(txn_.kind == TxnKind::USER || txn_.kind == TxnKind::GESTURE)) return;
  auto markParent = [&](Guid parent) {
    const Node* p = doc_.get(parent);
    if (!p) return;
    if (p->props.isAutoLayout() || p->props.fitsChildren()) layoutDirty_.insert(parent);
    if (p->props.fitsChildren()) groupsTouched_.insert(parent);
  };
  if (c.phase == Phase::REMOVED) {
    markParent(parentBefore);
    return;
  }
  const Node* now = doc_.get(c.guid);
  if (!now) return;
  const NodeProps& p = now->props;
  if (c.phase == Phase::CREATED) {
    markParent(p.parentIndex.guid);
    if (p.isAutoLayout() || p.fitsChildren()) layoutDirty_.insert(c.guid);
    if (p.type == NodeType::TEXT && p.text().textAutoResize != TextAutoResize::NONE) layoutDirty_.insert(c.guid);
    if (p.fitsChildren()) groupsTouched_.insert(c.guid);
    return;
  }
  FieldMask m = c.mask;
  if (m & F_PARENT_INDEX) {
    markParent(parentBefore);
    markParent(p.parentIndex.guid);
  }
  if (m & (F_SIZE | F_TRANSFORM | F_VISIBLE | kStackChildFields)) markParent(p.parentIndex.guid);
  if (p.isAutoLayout() && (m & (kStackContainerFields | F_SIZE | F_STROKES | F_STROKE_WEIGHT | F_STROKE_ALIGN))) layoutDirty_.insert(c.guid);
  if (m & (F_STACK_MODE | F_RESIZE_TO_FIT)) layoutDirty_.insert(c.guid);
  if (m & F_EXTRA) {
    // Grid fields are kept as unmodelled bytes (GridLayout.cpp): a grid's tracks and gaps, an item's place and span.
    if (p.stack().stackMode == StackMode::GRID && p.isAutoLayout()) layoutDirty_.insert(c.guid);
    if (const Node* parent = doc_.get(p.parentIndex.guid); parent && parent->props.stack().stackMode == StackMode::GRID) markParent(p.parentIndex.guid);
  }
  if (p.isFrameLike() && (m & F_SIZE)) layoutDirty_.insert(c.guid);  // its children's constraints
  if (m & (F_MIN_SIZE | F_MAX_SIZE)) layoutDirty_.insert(c.guid);   // its own size may break a new limit
  if (p.type == NodeType::TEXT && p.text().textAutoResize != TextAutoResize::NONE &&
      ((m & (kTextLayoutFields | F_SIZE | F_TYPE)) || ((m & F_EXTRA) && text::changesTextLayout(c.props.extra))))
    layoutDirty_.insert(c.guid);  // auto width / auto height: its size follows its text
}

void Editor::flushLayout() {
  if (inLayout_ || deriving_) return;
  // Layout, then the instances its results (and the transaction's edits) reach, then layout again for what
  // re-derived instances moved (docs/engine.md §3.3).
  for (int pass = 0; pass < 8; pass++) {
    flushBindings();  // styles and variables first: their values feed layout (docs/engine.md §3.3)
    if (!layoutDirty_.empty()) {
      if (txn_.open && (txn_.kind == TxnKind::USER || txn_.kind == TxnKind::GESTURE)) {
        std::vector<Guid> dirty(layoutDirty_.begin(), layoutDirty_.end());
        layoutDirty_.clear();
        inLayout_ = true;
        Layout(*this).run(dirty);
        inLayout_ = false;
      } else {
        layoutDirty_.clear();
      }
    }
    if (instanceDirty_.empty() && bindingsDirty_.empty()) break;
    flushInstances();
    if (layoutDirty_.empty() && bindingsDirty_.empty() && instanceDirty_.empty()) break;
  }
}

void Editor::removeEmptyGroups() {
  // An empty group is deleted when the transaction commits (Figma).
  std::vector<Guid> empty;
  for (Guid g : groupsTouched_) {
    const Node* n = doc_.get(g);
    if (n && n->props.fitsChildren() && doc_.children(g).empty()) empty.push_back(g);
  }
  groupsTouched_.clear();
  std::sort(empty.begin(), empty.end());
  for (Guid g : empty) write(NodeChange::removed(g));
  if (!empty.empty()) pruneSelection();
}

void Editor::commit(bool mergeWithLast) {
  if (!txn_.open || txn_.depth > 1) {
    if (txn_.open) txn_.depth--;
    return;
  }
  if (txn_.kind == TxnKind::USER || txn_.kind == TxnKind::GESTURE) {
    flushLayout();
    removeEmptyGroups();
    flushLayout();
    if (editTracking_) stampEdited();  // editInfo on what was edited and its ancestors (Dev Mode's "Changed")
  } else {
    flushLayout();  // instances re-derive after undo, redo, remote changes and loads
  }
  txn_.depth = 0;
  txn_.open = false;
  bool emits = txn_.kind != TxnKind::REMOTE && txn_.kind != TxnKind::LOAD;
  if (emits && !txn_.changes.empty()) {
    auto changes = txn_.changes.build(doc_);
    if (!changes.empty()) events_.documents.push_back({txn_.kind, txn_.label, std::move(changes)});
  }
  if (txn_.kind == TxnKind::USER || txn_.kind == TxnKind::GESTURE) {
    undo_.commit(selection_, mergeWithLast);
    events_.undo = true;
  }
  txn_.changes.clear();
  layoutDirty_.clear();
}

void Editor::rollback() {
  if (!txn_.open) return;
  txn_.open = false;
  txn_.depth = 0;
  if (txn_.kind == TxnKind::USER || txn_.kind == TxnKind::GESTURE) {
    for (const NodeChange& c : undo_.rollback(doc_)) noteChange(c, NodeType::NONE);
    events_.pages = true;
  }
  txn_.changes.clear();
  layoutDirty_.clear();
  groupsTouched_.clear();
  edited_.clear();
  if (!instanceDirty_.empty() || !bindingsDirty_.empty()) {
    // The instances the cancelled edit reached show their restored mains again.
    begin(TxnKind::SYSTEM, "Instances");
    commit();
  }
  pruneSelection();
}

void Editor::relayoutAll() {
  std::vector<Guid> dirty;  // kept empty: pages lay out when first shown (derivePage)
  std::vector<Guid> unusedDeleted;
  std::unordered_set<Guid, GuidHash> used;
  std::unordered_set<Guid, GuidHash> bound;
  std::vector<Guid> overrides;
  doc_.forEach([&](const Node& n) {
    if (n.guid.isDerived()) return;
    if (n.props.type == NodeType::INSTANCE) {
      used.insert(n.props.comp().symbolData.symbolID);
      for (const SymbolOverride& o : n.props.comp().symbolData.overrides)
        if (o.mask & F_OVERRIDDEN_SYMBOL_ID) used.insert(o.props.comp().overriddenSymbolID);
    }
    for (const ComponentPropAssignment& a : n.props.comp().componentPropAssignments) used.insert(a.value.guidValue);
    // Bound values as the variables and styles say they are now (stored copies can be stale).
    if (n.props.hasBindings()) bound.insert(n.guid);
    if (n.props.isStyle()) styleIds_.insert(n.guid);
    if (n.props.type == NodeType::VARIABLE_SET) collectionIds_.insert(n.guid);
    if (n.props.type == NodeType::VARIABLE) variableSets_[n.guid] = n.props.asset().variableSetID.guid;
    if (n.props.type == NodeType::VARIABLE_OVERRIDE) overrides.push_back(n.guid);
  });
  for (Guid o : overrides) indexOverride(o);
  // Bound values: the shown page's and the internal canvas's (styles, collections, mains, slot content) now; another
  // page's when it is first shown (derivePage), with its instances — Figma loads a page with its dependencies, and
  // resolving a page nobody looks at would derive its instances and ask for its fonts.
  if (!bound.empty() && doc_.has(docNode_)) {
    for (Guid canvas : doc_.children(docNode_)) {
      const Node* cn = doc_.get(canvas);
      if (!cn) continue;
      bool now = canvas == page_ || cn->props.type != NodeType::CANVAS || cn->props.rare().internalOnly;
      std::vector<Guid>* later = now ? nullptr : &pageBindings_[canvas];
      std::vector<Guid> stack{canvas};
      while (!stack.empty()) {
        Guid id = stack.back();
        stack.pop_back();
        if (auto it = bound.find(id); it != bound.end()) {
          if (later) later->push_back(id);
          else bindingsDirty_.insert(id);
          bound.erase(it);
        }
        for (Guid c : doc_.children(id))
          if (!c.isDerived()) stack.push_back(c);
      }
    }
  }
  for (Guid g : bound) bindingsDirty_.insert(g);  // under no page
  // Deleted mains kept for their instances go once nothing uses them (docs/schema.md §5.7). Only components: a
  // soft-deleted variable, collection or style stays (Figma's deletedButReferenced: aliases, bindings and explicit
  // modes still name it), and so does a deleted main that was published (the next publish lists it as Removed).
  doc_.forEach([&](const Node& n) {
    const NodeProps& p = n.props;
    if (p.comp().isSoftDeleted && (p.type == NodeType::SYMBOL || p.isComponentSet()) && p.asset().publishedVersion.empty() &&
        !used.count(n.guid)) {
      bool anyUsed = false;
      for (Guid c : doc_.children(n.guid)) anyUsed |= used.count(c) != 0;
      if (!anyUsed) unusedDeleted.push_back(n.guid);
    }
  });
  if (dirty.empty() && instanceDirty_.empty() && unusedDeleted.empty() && bindingsDirty_.empty()) return;
  std::sort(dirty.begin(), dirty.end());
  std::sort(unusedDeleted.begin(), unusedDeleted.end());
  begin(TxnKind::SYSTEM, "Layout");
  for (Guid g : unusedDeleted) {
    std::vector<Guid> order;
    auto collect = [&](auto&& self, Guid id) -> void {
      for (Guid c : std::vector<Guid>(doc_.children(id)))
        if (!c.isDerived()) self(self, c);
      order.push_back(id);
    };
    collect(collect, g);
    for (Guid id : order) write(NodeChange::removed(id));
  }
  flushBindings();
  inLayout_ = true;
  Layout(*this).run(dirty);
  inLayout_ = false;
  commit();
}

void Editor::derivePageOf(Guid id, bool subtree) {
  Guid real = id.isDerived() ? instanceOfDerived(id) : id;
  if (Guid top = internalRootOf(real); top != kNoGuid) {
    const Node* n = doc_.get(real);
    if (id.isDerived() || subtree || (n && n->props.type == NodeType::INSTANCE)) deriveInternal(top);
  } else {
    derivePage(doc_.pageOf(real));
  }
}

void Editor::deriveInternal(Guid top) {
  if (derivedInternal_.count(top) || txn_.open || !doc_.has(top)) return;
  derivedInternal_.insert(top);
  std::vector<Guid> stack{top};
  while (!stack.empty()) {
    Guid id = stack.back();
    stack.pop_back();
    const Node* n = doc_.get(id);
    if (!n) continue;
    if (n->props.type == NodeType::INSTANCE && !derivedRows_.count(id)) instanceDirty_.insert(id);
    for (Guid c : doc_.children(id))
      if (!c.isDerived()) stack.push_back(c);
  }
  if (instanceDirty_.empty()) return;
  begin(TxnKind::LOAD, "Page");
  commit();
}

void Editor::derivePage(Guid page) {
  const Node* pn = doc_.get(page);
  if (!pn || pn->props.type != NodeType::CANVAS || pn->props.rare().internalOnly || derivedPages_.count(page)) return;
  // Not inside an open step (a gesture, a panel scrub): its writes would join that undo step. The next call derives.
  if (txn_.open) return;
  derivedPages_.insert(page);
  // Its instances (their sublayers were never stored) and its auto-layout frames and groups (stored geometry can be
  // stale), as Figma loads a page with its dependencies on first show.
  std::vector<Guid> dirty;
  std::vector<Guid> stack{page};
  while (!stack.empty()) {
    Guid id = stack.back();
    stack.pop_back();
    for (Guid c : doc_.children(id)) {
      if (c.isDerived()) continue;
      const Node* n = doc_.get(c);
      if (!n) continue;
      if (n->props.type == NodeType::INSTANCE && !derivedRows_.count(c)) instanceDirty_.insert(c);
      // Geometry this engine stored (the snapshot carries its stamp) is what layout would give: not verified again.
      if (!trustLayout_ && (n->props.isAutoLayout() || n->props.fitsChildren())) dirty.push_back(c);
      stack.push_back(c);
    }
  }
  // Its bound values, not resolved at load (relayoutAll).
  if (auto pb = pageBindings_.find(page); pb != pageBindings_.end()) {
    for (Guid g : pb->second) bindingsDirty_.insert(g);
    pageBindings_.erase(pb);
  }
  if (dirty.empty() && instanceDirty_.empty() && bindingsDirty_.empty()) return;
  std::sort(dirty.begin(), dirty.end());
  // Page loading (docs/engine.md §9.2, kind LOAD): derived data, nothing emitted, not an undo step — a read that
  // derives a page is still a read. Stale stored geometry of the page is corrected in memory and reaches the file
  // with the next edit of those nodes (and is re-derived the same way at the next load).
  begin(TxnKind::LOAD, "Page");
  flushBindings();
  inLayout_ = true;
  Layout(*this).run(dirty);
  inLayout_ = false;
  commit();
}

// ---- LayoutHost -------------------------------------------------------------

void Editor::writeGeometry(Guid id, const Mat2x3& transform, Vec2 size) {
  // Equal values are no-ops (write() would find so too): skip building a NodeChange, layout writes are hot.
  if (!id.isDerived() || deriving_ || inLayout_)
    if (const Node* n = doc_.get(id); n && n->props.transform == transform && n->props.size == size) return;
  NodeChange c = NodeChange::changed(id);
  c.mask = F_TRANSFORM | F_SIZE;
  c.props.transform = transform;
  c.props.size = size;
  write(c);
}

bool Editor::resizedInTxn(Guid frame, Vec2& oldSize) const {
  // An instance and its sublayers: their children were laid out for the main's sizes.
  if (blueprintSourceSize(frame, oldSize)) return !intrinsicLayout_;
  if (frame.isDerived()) return false;
  const NodeChange* inv = undo_.openInverse(frame);
  if (!inv || !(inv->mask & F_SIZE)) return false;
  oldSize = inv->props.size;
  return true;
}

void Editor::base(Guid id, Mat2x3& transform, Vec2& size) const {
  const Node* n = doc_.get(id);
  if (!n) return;
  if (blueprintBase(id, transform, size)) return;
  transform = n->props.transform;
  size = n->props.size;
  if (const NodeChange* inv = undo_.openInverse(id)) {
    // Moved to another parent in this transaction: its old transform was in the old parent's space.
    if ((inv->mask & F_PARENT_INDEX) && inv->props.parentIndex.guid != n->props.parentIndex.guid) return;
    if (inv->mask & F_TRANSFORM) transform = inv->props.transform;
    if (inv->mask & F_SIZE) size = inv->props.size;
  }
}

// ---- Bookkeeping ------------------------------------------------------------

void Editor::changeSelection(std::vector<Guid> ids) {
  if (ids == selection_) return;
  selection_ = std::move(ids);
  // Gradient handles belong to a selected layer.
  if (paint_.node != kNoGuid && std::find(selection_.begin(), selection_.end(), paint_.node) == selection_.end()) endPaintEdit();
  events_.selection = true;
  needsRender_ = true;
}

void Editor::changeCamera(const Camera& c) {
  if (c.x == camera_.x && c.y == camera_.y && c.zoom == camera_.zoom) return;
  camera_ = c;
  events_.camera = true;
  needsRender_ = true;
}

void Editor::changeCursor(CursorKind c, double angle) {
  if (c == cursor_ && angle == cursorAngle_) return;
  cursor_ = c;
  cursorAngle_ = angle;
  events_.cursor = true;
}

void Editor::pruneSelection() {
  std::vector<Guid> live;
  for (Guid id : selection_)
    if (doc_.has(id) && doc_.pageOf(id) == page_) live.push_back(id);
  if (live.size() != selection_.size()) changeSelection(std::move(live));
  if (hover_ != kNoGuid && !doc_.has(hover_)) {
    hover_ = kNoGuid;
    events_.hover = true;
  }
}

bool Editor::selected(Guid id) const { return std::find(selection_.begin(), selection_.end(), id) != selection_.end(); }

Guid Editor::newGuid() {
  while (doc_.has({sessionID_, nextLocalID_})) nextLocalID_++;
  return {sessionID_, nextLocalID_++};
}

std::string Editor::nextName(const char* base) const {
  std::string prefix = std::string(base) + " ";
  unsigned long highest = 0;
  doc_.forEach([&](const Node& n) {
    if (n.guid.isDerived()) return;
    const std::string& name = n.props.name;
    if (name.size() <= prefix.size() || name.compare(0, prefix.size(), prefix) != 0) return;
    unsigned long v = 0;
    for (size_t i = prefix.size(); i < name.size(); i++) {
      if (name[i] < '0' || name[i] > '9' || v > 100000000) return;
      v = v * 10 + static_cast<unsigned long>(name[i] - '0');
    }
    highest = std::max(highest, v);
  });
  return prefix + std::to_string(highest + 1);
}

Editor::Events Editor::takeEvents() {
  Events e = std::move(events_);
  events_ = Events{};
  nodeEventIndex_.clear();
  return e;
}

Overlay Editor::overlay() const {
  Overlay o;
  o.zooming = zooming_;
  if (gesture_ == Gesture::None && hover_ != kNoGuid && measureTarget_ == kNoGuid) o.hover.push_back(hover_);
  for (Guid h : layersHover_) o.hover.push_back(h);
  o.selection = selection_;
  o.handles = !viewer_ && gesture_ != Gesture::Move && gesture_ != Gesture::Marquee && gesture_ != Gesture::Rotate;
  o.sizeBadge = true;
  o.hasMarquee = gesture_ == Gesture::Marquee ||
                 (gesture_ == Gesture::Draw && drawType_ == NodeType::TEXT && (lastScreen_ - downScreen_).length() >= 3);
  o.marquee = marquee_;
  o.guides = guides_;
  o.spacings = spacings_;
  if (gesture_ == Gesture::None) {
    o.measureTarget = measureTarget_;
    o.measures = measures_;
    o.measureGuides = measureGuides_;
    o.bands = bands_;
  }
  if (o.handles) {
    Guid line;
    Vec2 a, b;
    if (selectedLine(line, a, b)) o.lineEnds = {a, b};
  }
  o.hasInsertion = gesture_ == Gesture::Move && hasInsertion_;
  o.insertion = insertion_;
  if ((gesture_ == Gesture::None || gesture_ == Gesture::Grid) && selection_.size() == 1 && text_.node == kNoGuid) {
    gridTrackOverlay(o);
    gridSpanOverlay(o);
  }
  if (text_.node != kNoGuid) {
    // Editing text: the text's own box stays outlined (no handles, no badge), plus the selection and caret.
    o.textNode = text_.node;
    o.selection = {text_.node};
    o.handles = false;
    o.sizeBadge = false;
    if (const text::TextLayout* L = const_cast<Editor*>(this)->textLayout(text_.node)) {
      o.textSelection = L->selectionRects(textSelStart(), textSelEnd());
      if (text_.anchor == text_.focus) {
        size_t line = L->lineOf(text_.focus, text_.upstream);
        const text::LaidLine& l = L->lines[line];
        o.caret = {L->caretX(text_.focus, line), l.top, 0, l.height};
        o.caretVisible = text_.caretOn;
      }
    }
  }
  if (vector_.node != kNoGuid) vectorOverlay(o);
  if (paint_.node != kNoGuid) paintOverlay(o);
  if (proto_.on) protoOverlay(o);
  devOverlay(o);
  if (gesture_ == Gesture::Pencil && pencilPoints_.size() > 1)
    for (size_t i = 1; i < pencilPoints_.size(); i++)
      o.curves.push_back({pencilPoints_[i - 1], pencilPoints_[i - 1], pencilPoints_[i], pencilPoints_[i], 1, true});
  return o;
}

// ---- Document ---------------------------------------------------------------

void Editor::loadDocument(std::vector<NodeChange>&& nodes, Guid page, StoredDerived* derived) {
  cancelGesture();
  storedText_.clear();
  storedSymbols_.clear();
  storedLayouts_.clear();
  derivedUsed_ = derivedStale_ = 0;
  trustLayout_ = derived != nullptr;
  storedSparse_ = derived && derived->sparse;
  if (derived) {
    storedText_ = std::move(derived->texts);
    storedSymbols_ = std::move(derived->symbols);
  }
  txn_ = Txn{};
  doc_.clear();
  undo_.clear();
  pageSelections_.clear();
  layoutDirty_.clear();
  groupsTouched_.clear();
  excluded_.clear();
  pinned_.clear();
  textCache_.clear();
  measured_.clear();
  unmeasured_.clear();
  instanceDirty_.clear();
  sourceDeps_.clear();
  instanceSources_.clear();
  derivedRows_.clear();
  derivedInfo_.clear();
  blueprint_.clear();
  bindingsDirty_.clear();
  deps_.clear();
  varConsumers_.clear();
  setConsumers_.clear();
  styleConsumers_.clear();
  styleIds_.clear();
  collectionIds_.clear();
  variableSets_.clear();
  instanceBindings_.clear();
  instanceVarDeps_.clear();
  overridesBySet_.clear();
  overrideIndex_.clear();
  extensionSyncDirty_.clear();
  assetKeysDirty_ = true;
  navMain_ = returnTo_ = kNoGuid;
  if (text_.node != kNoGuid) events_.textEdit = true;
  text_ = TextSession{};
  hasLibraryCopies_ = false;
  derivedPages_.clear();
  derivedInternal_.clear();
  pageBindings_.clear();
  keyIndex_.clear();
  keyOf_.clear();
  instanceCounts_.clear();
  instanceMain_.clear();
  infoCache_.clear();
  docNode_ = kNoGuid;
  normalizeOverridePaths(nodes);
  adoptSlotContent(nodes);
  doc_.reserve(nodes.size());
  for (NodeChange& c : nodes) {
    if (c.guid.isDerived()) continue;
    c.phase = Phase::CREATED;
    c.mask = F_ALL;
    if (!c.props.asset().sourceLibraryKey.empty()) hasLibraryCopies_ = true;
    doc_.adopt(std::move(c));
    c.props = NodeProps{};  // what was moved out of, freed now (the peak stays one copy of the document)
  }
  nodes.clear();
  nodes.shrink_to_fit();
  rebuildIndexes();
  page_ = kNoGuid;
  auto all = pages();
  if (std::find(all.begin(), all.end(), page) != all.end()) page_ = page;
  else if (!all.empty()) page_ = all[0];
  nextLocalID_ = doc_.maxLocalID(sessionID_) + 1;
  selection_.clear();
  hover_ = kNoGuid;
  events_.selection = events_.undo = events_.structure = events_.pages = events_.currentPage = true;
  events_.structureAll = true;
  needsRender_ = true;
  // The file's global bookkeeping, then the opened page's instances and auto layout (other pages on their first
  // show: docs/engine.md §3.4 as built); neither is an undo step. The bookkeeping (a deleted main nobody uses going,
  // bound values brought up to date) doesn't make the stored derived data stale.
  applyingStored_ = derived != nullptr;
  relayoutAll();
  applyingStored_ = false;
  derivePage(page_);
  events_.undo = true;
}

void Editor::setSessionID(uint32_t sessionID) {
  sessionID_ = sessionID;
  nextLocalID_ = doc_.maxLocalID(sessionID_) + 1;
}

Status Editor::applyChanges(const std::vector<NodeChange>& changes, uint32_t flags) {
  if (busy()) return E_BUSY;
  TxnKind kind = (flags & APPLY_USER)     ? TxnKind::USER
                 : (flags & APPLY_SYSTEM) ? TxnKind::SYSTEM
                 : (flags & APPLY_LOAD)   ? TxnKind::LOAD
                                          : TxnKind::REMOTE;
  // A system change inside an open user step would become part of that undo step.
  if (kind == TxnKind::SYSTEM && txn_.open && txn_.kind != TxnKind::SYSTEM) return E_BUSY;
  begin(kind, "Edit");
  // APPLY_EXACT (Restore version): a whole document state computed elsewhere — written as it is, library copies too.
  bool exact = (flags & APPLY_EXACT) != 0;
  bool libraryWriteBefore = libraryWrite_, guardBefore = applyGuard_;
  if (exact) libraryWrite_ = true;
  else if (kind == TxnKind::SYSTEM) applyGuard_ = true;
  for (const NodeChange& c : changes) {
    // CANVAS only under DOCUMENT (docs/engine.md §2.4).
    if (c.phase != Phase::REMOVED && (c.mask & F_PARENT_INDEX) && c.props.type == NodeType::CANVAS) {
      const Node* parent = doc_.get(c.props.parentIndex.guid);
      if (parent && parent->props.type != NodeType::DOCUMENT) continue;
    }
    write(c);
  }
  libraryWrite_ = libraryWriteBefore;
  applyGuard_ = guardBefore;
  commit();
  pruneSelection();
  if (!doc_.has(page_)) {
    auto all = pages();
    page_ = all.empty() ? kNoGuid : all[0];
    events_.currentPage = true;
  }
  return OK;
}

std::vector<NodeChange> Editor::encodeDocument() const {
  std::vector<NodeChange> out;
  std::vector<Guid> roots;
  doc_.forEach([&](const Node& n) {
    if (!n.guid.isDerived() && !doc_.has(n.props.parentIndex.guid)) roots.push_back(n.guid);
  });
  std::sort(roots.begin(), roots.end());
  auto visit = [&](auto&& self, Guid id) -> void {
    out.push_back(NodeChange::created(id, doc_.get(id)->props));
    for (Guid c : doc_.children(id))
      if (!c.isDerived()) self(self, c);  // an instance's sublayers are derived, never stored
  };
  for (Guid r : roots) visit(visit, r);
  return out;
}

// ---- Derived data (docs/engine-build.md "Figma parity round 3" §2) -------------------

void Editor::invalidateStored(const NodeChange& c, NodeType typeBefore) {
  FieldMask mask = c.phase == Phase::CHANGED ? c.mask : F_ALL;
  // A text's stored layout stands for one set of text fields and one box: any change of them makes it stale (the
  // creation of an instance sublayer by its first materialization is not a change of it).
  if ((mask & (kTextLayoutFields | F_SIZE | F_TYPE)) || (c.phase == Phase::CHANGED && (mask & F_EXTRA) && text::changesTextLayout(c.props.extra)))
    if (!(c.guid.isDerived() && c.phase == Phase::CREATED)) {
      storedText_.erase(c.guid);
      storedLayouts_.erase(c.guid);
    }
  if (storedSymbols_.empty() || deriving_ || inLayout_ || (txn_.open && txn_.kind == TxnKind::LOAD)) return;
  // Instances not derived yet keep their stored sublayers until something they may depend on changes: their own
  // fields, a component (anything inside a SYMBOL), variables, collections, styles, explicit modes.
  if (!c.guid.isDerived()) storedSymbols_.erase(c.guid);
  NodeType type = c.phase == Phase::REMOVED ? typeBefore : c.props.type;
  if (const Node* n = doc_.get(c.guid)) type = n->props.type;
  bool global = type == NodeType::VARIABLE || type == NodeType::VARIABLE_SET || type == NodeType::VARIABLE_OVERRIDE || type == NodeType::SYMBOL ||
                typeBefore == NodeType::SYMBOL || (mask & (F_VARIABLE_MODES | F_STYLE_TYPE));
  if (!global)
    if (const Node* n = doc_.get(c.guid)) global = n->props.isStyle();
  for (Guid a = doc_.parentOf(c.guid); !global && a != kNoGuid; a = doc_.parentOf(a))
    if (const Node* an = doc_.get(a)) global = an->props.type == NodeType::SYMBOL || (an->props.type == NodeType::FRAME && an->props.comp().isStateGroup);
  if (global) storedSymbols_.clear();
}

void Editor::encodeDerivedFields(Guid id, std::string& fields, codec::BlobsOut& blobs) {
  const Node* n = doc_.get(id);
  if (!n) return;
  schema::Out o;
  if (n->props.type == NodeType::TEXT) {
    std::shared_ptr<const text::StoredText> s;
    Guid page = doc_.pageOf(id);
    if (derivedPages_.count(page) || !storedText_.count(id)) {
      if (derivedPages_.count(page))
        if (const text::TextLayout* L = textLayout(id)) s = text::storedFromLayout(*L);
    } else {
      s = storedText_[id];
    }
    if (s) {
      o.varuint(359);
      text::writeStoredText(o, *s, blobs);
    }
  } else if (n->props.type == NodeType::INSTANCE) {
    // One entry per sublayer, keyed by its guidPath (the root excluded): its size, its transform, a text's layout.
    std::vector<StoredRow> rows;
    auto live = derivedRows_.find(id);
    if (live != derivedRows_.end()) {
      for (Guid r : live->second) {
        const Node* rn = doc_.get(r);
        auto info = derivedInfo_.find(r);
        if (!rn || info == derivedInfo_.end()) continue;
        StoredRow row;
        row.path = info->second.path;
        row.hasSize = row.hasTransform = true;
        row.size = rn->props.size;
        row.transform = rn->props.transform;
        if (rn->props.type == NodeType::TEXT)
          if (const text::TextLayout* L = textLayout(r)) row.text = text::storedFromLayout(*L);
        rows.push_back(std::move(row));
      }
    } else if (auto stored = storedSymbols_.find(id); stored != storedSymbols_.end()) {
      rows = stored->second;
    } else {
      return;
    }
    o.varuint(125);
    o.varuint(static_cast<uint32_t>(rows.size()));
    for (const StoredRow& row : rows) {
      o.varuint(111);  // guidPath
      o.varuint(1);
      o.varuint(static_cast<uint32_t>(row.path.size()));
      for (Guid g : row.path) o.varuint(g.sessionID), o.varuint(g.localID);
      o.byte(0);
      if (row.hasSize) {
        o.varuint(11);
        o.varfloat(static_cast<float>(row.size.x));
        o.varfloat(static_cast<float>(row.size.y));
      }
      if (row.hasTransform) {
        const Mat2x3& m = row.transform;
        o.varuint(12);
        for (double v : {m.m00, m.m01, m.m02, m.m10, m.m11, m.m12}) o.varfloat(static_cast<float>(v));
      }
      if (row.text) {
        o.varuint(359);
        text::writeStoredText(o, *row.text, blobs);
      }
      o.byte(0);
    }
  } else {
    return;
  }
  fields += o.s;
}

std::vector<Guid> Editor::pages() const {
  std::vector<Guid> out;
  if (!doc_.has(docNode_)) return out;
  for (Guid c : doc_.children(docNode_)) {
    const Node* p = doc_.get(c);
    if (p && p->props.type == NodeType::CANVAS && !p->props.rare().internalOnly) out.push_back(c);
  }
  return out;
}

Status Editor::setCurrentPage(Guid page) {
  const Node* n = doc_.get(page);
  if (!n || n->props.type != NodeType::CANVAS || n->props.rare().internalOnly) return E_NOT_FOUND;
  if (page == page_) return OK;
  cancelGesture();
  endTextEdit();
  derivePage(page);
  pageSelections_[page_] = selection_;
  page_ = page;
  std::vector<Guid> kept;
  for (Guid id : pageSelections_[page])
    if (doc_.has(id) && doc_.pageOf(id) == page) kept.push_back(id);
  changeSelection(kept);
  hover_ = kNoGuid;
  measureTarget_ = kNoGuid;
  measures_.clear();
  bands_.clear();
  events_.currentPage = events_.structure = events_.structureAll = true;
  needsRender_ = true;
  return OK;
}

// ---- View -------------------------------------------------------------------

void Editor::setViewport(double cssWidth, double cssHeight, double dpr, int pixelWidth, int pixelHeight) {
  viewport_ = {std::max(0.0, cssWidth), std::max(0.0, cssHeight), dpr > 0 ? dpr : 1, pixelWidth, pixelHeight};
  needsRender_ = true;
}

void Editor::setCamera(const Camera& c) {
  zooming_ = false;
  changeCamera({c.x, c.y, Camera::clampZoom(c.zoom)});
}

void Editor::setTheme(Theme t) {
  theme_ = t;
  needsRender_ = true;
}

Camera Editor::snapped(Camera c) const {
  // Zoom commands land the page on whole device pixels, so pixel-aligned layers stay crisp.
  double sx = viewport_.scaleX(), sy = viewport_.scaleY();
  if (sx > 0) c.x = std::round(c.x * sx) / sx;
  if (sy > 0) c.y = std::round(c.y * sy) / sy;
  return c;
}

void Editor::zoomTo(double zoom) {
  zooming_ = false;
  changeCamera(snapped(camera_.zoomedAround(zoom, {viewport_.width / 2, viewport_.height / 2})));
}

void Editor::zoomToFit() {
  bool any = false;
  Rect r;
  for (Guid c : doc_.children(page_)) {
    const Node* n = doc_.get(c);
    if (!n || !n->props.visible) continue;
    Rect b = doc_.worldBounds(c);
    r = any ? r.united(b) : b;
    any = true;
  }
  zooming_ = false;
  if (any) changeCamera(snapped(Camera::fit(r, viewport_.width, viewport_.height, true)));
}

void Editor::zoomToSelection() {
  bool any = false;
  Rect r;
  for (Guid id : selection_) {
    if (!doc_.has(id)) continue;
    Rect b = doc_.worldBounds(id);
    r = any ? r.united(b) : b;
    any = true;
  }
  zooming_ = false;
  if (any) changeCamera(snapped(Camera::fit(r, viewport_.width, viewport_.height, false)));
}

bool Editor::tick(double timeMs) {
  timeMs_ = timeMs;
  if (text_.node != kNoGuid) {
    // The caret blinks every 530 ms, solid for a moment after each move.
    if (text_.blinkStart <= 0) text_.blinkStart = timeMs;
    bool on = static_cast<long long>((timeMs - text_.blinkStart) / 530) % 2 == 0;
    if (on != text_.caretOn) {
      text_.caretOn = on;
      needsRender_ = true;
    }
  }
  return needsRender_;
}

// ---- Selection and panel writes ---------------------------------------------

Status Editor::setSelection(const std::vector<Guid>& ids) {
  std::vector<Guid> live;
  for (Guid id : ids) {
    if (!doc_.has(id) || std::find(live.begin(), live.end(), id) != live.end()) continue;
    const Node* n = doc_.get(id);
    if (n->props.type == NodeType::CANVAS || n->props.type == NodeType::DOCUMENT) continue;
    live.push_back(id);
  }
  if (!live.empty() && doc_.pageOf(live[0]) != page_) setCurrentPage(doc_.pageOf(live[0]));
  changeSelection(std::move(live));
  return OK;
}

void Editor::setHover(const std::vector<Guid>& ids) {
  if (ids == layersHover_) return;
  layersHover_ = ids;
  needsRender_ = true;
}

Status Editor::setProps(const std::vector<Guid>& ids, const NodeChange& props, uint32_t /*flags*/) {
  if (busy()) return E_BUSY;
  FieldMask mask = props.mask & ~static_cast<FieldMask>(F_TYPE);
  if (!mask) return E_INVALID;
  for (Guid id : ids) {
    if (!doc_.has(id)) return E_NOT_FOUND;
    if (isLibraryCopy(id)) return E_READONLY;
  }
  begin(TxnKind::USER, "Edit");
  for (Guid id : ids) {
    const NodeProps& before = doc_.get(id)->props;
    bool runExtra = false;
    if (before.type == NodeType::TEXT && (mask & F_EXTRA))
      for (auto& [k, v] : props.props.extra) runExtra |= text::isRunExtraKey(k);
    if (before.type == NodeType::TEXT && (text::runFieldsOf(mask) || runExtra)) {
      // Run fields go to the edited range, or to the whole text over its runs.
      applyTextStyle(id, props);
      continue;
    }
    NodeChange c = NodeChange::changed(id);
    c.mask = differingFields(before, props.props, mask);  // equal values are no-ops
    copyFields(c.props, props.props, c.mask);
    if (before.type == NodeType::TEXT && (c.mask & F_SIZE) && !(mask & F_TEXT_AUTO_RESIZE) &&
        before.text().textAutoResize != TextAutoResize::NONE) {
      // A size typed for an auto-resizing text: a width makes it auto height, a height a fixed box (Figma).
      bool h = c.props.size.y != before.size.y, w = c.props.size.x != before.size.x;
      if (h) c.props.text().textAutoResize = TextAutoResize::NONE;
      else if (w && before.text().textAutoResize == TextAutoResize::WIDTH_AND_HEIGHT) c.props.text().textAutoResize = TextAutoResize::HEIGHT;
      if (h || (w && before.text().textAutoResize == TextAutoResize::WIDTH_AND_HEIGHT)) c.mask |= F_TEXT_AUTO_RESIZE;
    }
    if (c.mask) write(c);
  }
  flushLayout();  // live, also inside a panel scrub
  commit();
  return OK;
}

Status Editor::txnBegin(const std::string& label) {
  if (busy()) return E_BUSY;
  begin(TxnKind::USER, label);
  return OK;
}

Status Editor::txnCommit() {
  if (!txn_.open) return E_INVALID;
  commit();
  return OK;
}

void Editor::txnCancel() { rollback(); }

bool Editor::undoStep(bool redo) {
  if (busy() || txn_.open) return false;
  if (redo ? !undo_.canRedo() : !undo_.canUndo()) return false;
  begin(redo ? TxnKind::REDO : TxnKind::UNDO, redo ? undo_.redoLabel() : undo_.undoLabel());
  std::vector<Guid> sel = selection_;
  auto applied = redo ? undo_.redo(doc_, sel, &txn_.changes) : undo_.undo(doc_, sel, &txn_.changes);
  for (const NodeChange& c : applied) noteChange(c, NodeType::NONE);
  events_.pages = true;
  commit();
  events_.undo = true;
  // The selection was on a page that may not be the current one.
  if (!sel.empty() && doc_.has(sel[0]) && doc_.pageOf(sel[0]) != page_) setCurrentPage(doc_.pageOf(sel[0]));
  if (!doc_.has(page_)) {
    auto all = pages();
    if (!all.empty()) setCurrentPage(all[0]);
  }
  changeSelection(sel);
  pruneSelection();
  if (vector_.node != kNoGuid) reloadVector();
  if (paint_.node != kNoGuid && !editedPaint()) endPaintEdit();
  return true;
}

// ---- Keys -------------------------------------------------------------------

uint32_t Editor::key(KeyEvent type, KeyCode code, uint32_t /*codepoint*/, uint32_t mods, bool repeat) {
  bool shift = (mods & MOD_SHIFT) != 0;
  bool primary = (mods & MOD_PRIMARY) != 0;
  if (text_.node != kNoGuid && !isModifierKey(code)) {
    mods_ = mods;
    return type == KeyEvent::DOWN ? textKey(code, mods) : 0u;
  }
  // ⇧Space is Preview (the inline preview, TS), not the hand.
  if (code == KeyCode::Space && shift && !spaceHeld_) return 0;
  if (code == KeyCode::Space) {
    mods_ = mods;
    if (type == KeyEvent::DOWN && !spaceHeld_ && !primary) {
      spaceHeld_ = true;
      if (gesture_ == Gesture::None) {
        if (hover_ != kNoGuid) events_.hover = true;
        hover_ = kNoGuid;
        needsRender_ = true;
        changeCursor(CursorKind::HAND);
      }
      // Moving: Space keeps the layers out of frames (Figma) — the drag runs again without nesting.
      if (gesture_ == Gesture::Move) redrag(mods_);
    } else if (type == KeyEvent::UP && spaceHeld_) {
      spaceHeld_ = false;
      if (gesture_ == Gesture::None) updateHover(lastScreen_, mods);
      else if (gesture_ == Gesture::Move) redrag(mods_);
    }
    return K_HANDLED;
  }
  if (isModifierKey(code)) {
    modifiers(mods);
    return 0;  // modifier keys are TS's too
  }
  mods_ = mods;
  if (type == KeyEvent::UP) return 0;
  if (vector_.node != kNoGuid)
    if (uint32_t r = vectorKey(code, mods)) return r;
  if (paint_.node != kNoGuid) {
    if (code == KeyCode::Escape && gesture_ == Gesture::None) {
      endPaintEdit();
      return K_HANDLED;
    }
    if ((code == KeyCode::Backspace || code == KeyCode::Delete) && gesture_ == Gesture::None) {
      // The selected stop goes (two stay at least).
      const Paint* p = editedPaint();
      if (p && p->stops.size() > 2 && paint_.stop >= 0 && static_cast<size_t>(paint_.stop) < p->stops.size()) {
        Paint q = *p;
        q.stops.erase(q.stops.begin() + paint_.stop);
        begin(TxnKind::USER, "Delete color stop");
        writePaint(q);
        commit();
        paint_.stop = std::max(0, paint_.stop - 1);
        paintChanged();
      }
      return K_HANDLED;
    }
  }
  if (uint32_t r = devKey(code, mods)) return r;
  if (viewer_ && code != KeyCode::Escape && code != KeyCode::Tab && code != KeyCode::Enter && code != KeyCode::NumpadEnter) return 0;
  // Selected grid tracks: ⌫ deletes them, Enter edits them, Esc lets them go (tools/GridGestures.cpp).
  if (!viewer_)
    if (uint32_t r = gridKey(code, mods)) return r;
  if (code == KeyCode::Escape) {
    if (gesture_ != Gesture::None) cancelGesture();
    else if (tool_ != Tool::MOVE) setTool(Tool::MOVE);
    else if (!selection_.empty()) {
      // The parent, else nothing.
      Guid parent = doc_.parentOf(selection_[0]);
      const Node* p = doc_.get(parent);
      if (p && p->props.type != NodeType::CANVAS) changeSelection({parent});
      else changeSelection({});
    }
    return K_HANDLED;
  }
  if (busy() || primary || (mods & MOD_ALT)) return 0;
  switch (code) {
    case KeyCode::ArrowLeft: nudge(shift ? -10 : -1, 0, repeat); return K_HANDLED;
    case KeyCode::ArrowRight: nudge(shift ? 10 : 1, 0, repeat); return K_HANDLED;
    case KeyCode::ArrowUp: nudge(0, shift ? -10 : -1, repeat); return K_HANDLED;
    case KeyCode::ArrowDown: nudge(0, shift ? 10 : 1, repeat); return K_HANDLED;
    case KeyCode::Enter:
    case KeyCode::NumpadEnter:
      if (selection_.empty()) return 0;
      // Enter on one text layer edits it, all its text selected (Figma).
      if (!viewer_ && !shift && selection_.size() == 1 && doc_.get(selection_[0])->props.type == NodeType::TEXT &&
          !doc_.get(selection_[0])->props.locked) {
        startTextEdit(selection_[0], true);
        return K_HANDLED;
      }
      // Enter on a vector or a shape: vector edit mode.
      if (!viewer_ && !shift && selection_.size() == 1 && startVectorEdit(selection_[0]) == OK) return K_HANDLED;
      selectRelative(shift ? 1 : 0);
      return K_HANDLED;
    case KeyCode::Tab:
      if (selection_.empty()) return 0;
      selectRelative(shift ? 3 : 2);
      return K_HANDLED;
    default: return 0;
  }
}

void Editor::modifiers(uint32_t mods) {
  if (mods == mods_ && gesture_ == Gesture::None) return;
  uint32_t before = mods_;
  mods_ = mods;
  if (gesture_ == Gesture::Move || gesture_ == Gesture::Resize || gesture_ == Gesture::Rotate || gesture_ == Gesture::Draw ||
      gesture_ == Gesture::Marquee || gesture_ == Gesture::Vector) {
    if (before != mods) redrag(mods);
  } else if (gesture_ == Gesture::None) {
    updateHover(lastScreen_, mods);
  }
}

void Editor::blur() {
  cancelGesture();
  spaceHeld_ = false;
  mods_ = 0;
  measureTarget_ = kNoGuid;
  measures_.clear();
  measureGuides_.clear();
  needsRender_ = true;
}

void Editor::setViewerMode(bool on) {
  if (viewer_ == on) return;
  cancelGesture();
  if (on) {
    if (text_.node != kNoGuid) endTextEdit();
    if (vector_.node != kNoGuid) endVectorEdit();
    if (paint_.node != kNoGuid) endPaintEdit();
    setPrototypeMode(false);
    setTool(Tool::MOVE);
  }
  viewer_ = on;
  needsRender_ = true;
}

Status Editor::setTool(Tool t) {
  if (!toolImplemented(t)) return E_UNSUPPORTED;
  if (viewer_ && t != Tool::MOVE && t != Tool::HAND && !(devEdits_ && (t == Tool::ANNOTATION || t == Tool::MEASUREMENT))) return E_READONLY;
  if (t != tool_ && text_.node != kNoGuid) endTextEdit();
  // In vector edit mode the Pen and Move switch its own tool; any other tool leaves it.
  if (vector_.node != kNoGuid) {
    if (t == Tool::PEN) return setVectorTool(VectorTool::PEN);
    if (t == Tool::MOVE) return setVectorTool(VectorTool::MOVE);
    endVectorEdit();
  }
  if (t != tool_) {
    tool_ = t;
    events_.tool = true;
    if (hover_ != kNoGuid) events_.hover = true;
    hover_ = kNoGuid;
    needsRender_ = true;
  }
  updateCursor(lastScreen_);
  return OK;
}

}  // namespace eng
