#include "editor/Editor.h"
#include "editor/Refusals.h"

#include "scene/CodecKiwi.h"
#include "schema/SchemaTable.h"
#include "text/TextEdit.h"

#include <algorithm>
#include <cmath>

namespace eng {

namespace {

// Figma keeps a colour as it was picked in another space (Paint.authoredColor 44 / authoredStops 45,
// Effect.authoredColor 56: HSL, OKLCH…) next to the colour that draws. A colour edited here makes it stale: it goes.
constexpr uint32_t kPaintAuthoredColor = 44, kPaintAuthoredStops = 45, kEffectAuthoredColor = 56;

void dropStalePaints(std::vector<Paint>& now, const std::vector<Paint>& was) {
  static const schema::Def* def = schema::SchemaTable::get().def("Paint");
  if (!def) return;
  for (size_t i = 0; i < now.size(); i++) {
    Paint& p = now[i];
    if (p.extra.empty() || p.type == PaintType::OTHER) continue;
    const Paint* w = i < was.size() && was[i].type == p.type ? &was[i] : nullptr;
    if (!w || !(w->color == p.color)) schema::eraseField(*def, p.extra, kPaintAuthoredColor);
    if (!w || !(w->stops == p.stops)) schema::eraseField(*def, p.extra, kPaintAuthoredStops);
  }
}

void dropStaleAuthoredColors(const NodeProps& before, NodeChange& c) {
  if (c.mask & F_FILLS) dropStalePaints(c.props.fillPaints, before.fillPaints);
  if (c.mask & F_STROKES) dropStalePaints(c.props.strokePaints, before.strokePaints);
  if (c.mask & F_EFFECTS) {
    static const schema::Def* def = schema::SchemaTable::get().def("Effect");
    for (size_t i = 0; def && i < c.props.effects.size(); i++) {
      Effect& e = c.props.effects[i];
      if (e.extra.empty()) continue;
      if (i >= before.effects.size() || !(before.effects[i].color == e.color)) schema::eraseField(*def, e.extra, kEffectAuthoredColor);
    }
  }
}

}  // namespace

const char* toolName(Tool t) {
  static constexpr const char* kNames[] = {"MOVE", "SCALE", "HAND", "FRAME", "SECTION", "SLICE", "RECTANGLE", "LINE", "ARROW",
                                           "ELLIPSE", "POLYGON", "STAR", "IMAGE", "PEN", "PENCIL", "TEXT", "COMMENT",
                                           "ANNOTATION", "MEASUREMENT", "EYEDROPPER", "BRUSH", "TEXT_PATH", "ANCHOR_POINT"};
  auto i = static_cast<size_t>(t);
  return i < sizeof kNames / sizeof kNames[0] ? kNames[i] : "MOVE";
}

bool toolImplemented(Tool t) {
  return t == Tool::MOVE || t == Tool::HAND || t == Tool::FRAME || t == Tool::SECTION || t == Tool::RECTANGLE || t == Tool::ELLIPSE || t == Tool::TEXT ||
         t == Tool::LINE || t == Tool::ARROW || t == Tool::POLYGON || t == Tool::STAR || t == Tool::PEN || t == Tool::PENCIL ||
         t == Tool::ANNOTATION || t == Tool::MEASUREMENT || t == Tool::SCALE || t == Tool::SLICE || t == Tool::COMMENT || t == Tool::EYEDROPPER ||
         t == Tool::BRUSH || t == Tool::TEXT_PATH || t == Tool::ANCHOR_POINT;
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
                                           "NOT_ALLOWED", "COMMENT", "SCALE", "PENCIL", "BEND", "PAINT_BUCKET",
                                           "CUT", "LASSO", "SPACING", "BRUSH", "TEXT_PATH"};
  return kNames[static_cast<size_t>(k)];
}

Editor::Editor() {
  // Figma Draw's text on a path: its geometry (Flatten, hit-testing, strokes) is its placed glyphs (docs/draw.md §4.4).
  doc_.geometryCache().setTextPathSource([this](Guid id) { return textLayout(id); });
}

// ---- Transactions -----------------------------------------------------------

void Editor::begin(TxnKind kind, const std::string& label) {
  if (txn_.open) {
    // A preview evaluated inside the transaction (motionInTxn_) goes before anything more is written in it.
    if (motionInTxn_ && motionLayer_.active()) motionLayer_.restore(doc_);
    txn_.depth++;
    return;
  }
  // Motion (docs/motion.md §5): every transaction reads and writes base values; the layer applies again after the commit.
  if (motionLayer_.active()) motionLayer_.restore(doc_);
  txn_.open = true;
  txn_.depth = 1;
  txn_.kind = kind;
  txn_.label = label;
  txn_.run = false;
  txn_.join = false;
  txn_.peer = false;
  txn_.changes.clear();
  layoutDirty_.clear();
  groupsTouched_.clear();
  edited_.clear();
  userGeometry_.clear();
  renamedVariants_.clear();
  replayWrites_.clear();
  replayPushed_ = false;
  if (kind == TxnKind::USER || kind == TxnKind::GESTURE) recording().begin(selection_, label);
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
    if (n && n->props.type == NodeType::SLICE) slices_.insert(c.guid);
    else slices_.erase(c.guid);
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
  slices_.clear();
  doc_.forEach([&](const Node& n) {
    if (n.guid.isDerived()) return;
    if (n.props.type == NodeType::SLICE) slices_.insert(n.guid);
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
  // A text's layout stays through a move, a resize (the cache compares its box), a rename… — layout writing the size
  // it measured, a drag, a reorder no longer shape the text again; anything else on a text starts it over.
  constexpr FieldMask kTextLayoutInert = F_NAME | F_VISIBLE | F_LOCKED | F_OPACITY | F_TRANSFORM | F_SIZE | F_PARENT_INDEX |
                                         F_H_CONSTRAINT | F_V_CONSTRAINT | F_STACK_CHILD_GROW | F_STACK_CHILD_ALIGN_SELF |
                                         F_STACK_POSITIONING | F_BLEND_MODE | F_EFFECTS;
  if (c.phase != Phase::CHANGED) textCache_.erase(c.guid);
  else if (typeBefore == NodeType::TEXT) {
    if (mask & ~kTextLayoutInert) textCache_.erase(c.guid);
  } else if (mask & (kTextLayoutFields | F_SIZE | F_FILLS | F_TYPE | F_EXTRA | F_VECTOR_DATA)) {
    textCache_.erase(c.guid);
  }
  if (c.phase != Phase::CHANGED || (mask & (kTextLayoutFields | F_FILLS | F_TYPE | F_EXTRA))) measured_.erase(c.guid);
  if (text_.node == c.guid) events_.textEdit = true;
  // Round 12: the edited vector's stroke (dashes, width points) decides Variable width; the panels show its points.
  if (vector_.node != kNoGuid && vector_.node == c.guid && (mask & (F_EXTRA | F_DASH_PATTERN | F_STROKE_WEIGHT))) events_.vectorEdit = true;
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
    // A component can't contain an instance of itself (round 17 B, Figma's visual bell): an instance created (paste,
    // insert, a plugin's), a layer moved, or an instance swapped where it would show a main it is inside of.
    if (change.phase == Phase::CREATED && change.props.type == NodeType::INSTANCE) {
      std::vector<Guid> mains;
      mainsOfInstance(change.props, mains);
      if (wouldContainItself(change.props.parentIndex.guid, mains)) {
        refuse(refusal::kSelfInstance);
        return;
      }
    }
    if (c->phase == Phase::CHANGED && (c->mask & F_PARENT_INDEX) && existing && existing->props.parentIndex.guid != c->props.parentIndex.guid &&
        !enclosingMains(c->props.parentIndex.guid).empty()) {
      std::vector<Guid> mains;
      mainsShownIn(change.guid, mains);
      if (wouldContainItself(c->props.parentIndex.guid, mains)) {
        bool set = existing->props.isComponentSet();
        for (std::vector<Guid> stack{change.guid}; !set && !stack.empty();) {
          Guid id = stack.back();
          stack.pop_back();
          for (Guid k : doc_.children(id))
            if (!k.isDerived()) set |= doc_.get(k)->props.isComponentSet(), stack.push_back(k);
        }
        refuse(set ? refusal::kReparentSetCycle : refusal::kReparentCycle);
        own().mask &= ~static_cast<FieldMask>(F_PARENT_INDEX | F_TRANSFORM);
        if (!c->mask) return;
      }
    }
    if (c->phase == Phase::CHANGED && (c->mask & F_SYMBOL_DATA) && existing && existing->props.type == NodeType::INSTANCE &&
        c->props.comp().symbolData.symbolID != existing->props.comp().symbolData.symbolID) {
      std::vector<Guid> mains;
      NodeProps probe;
      probe.comp().symbolData.symbolID = c->props.comp().symbolData.symbolID;
      mainsOfInstance(probe, mains);
      if (wouldContainItself(existing->props.parentIndex.guid, mains)) {
        refuse(refusal::kSelfInstance);
        own().mask &= ~static_cast<FieldMask>(F_SYMBOL_DATA | F_COMPONENT_PROP_ASSIGNMENTS);
        if (!c->mask) return;
      }
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
  // Geometry the user (a panel field, the API) wrote in this step is where constraints start from (base).
  if (userEdit && txn_.kind == TxnKind::USER && c->phase == Phase::CHANGED && (c->mask & (F_SIZE | F_TRANSFORM))) userGeometry_.insert(c->guid);
  NodeType typeBefore = existing ? existing->props.type : NodeType::NONE;
  Guid parentBefore = existing ? existing->props.parentIndex.guid : kNoGuid;
  // An ignore-undo scope keeps the write out of every history (openIgnoreUndo).
  bool record = txn_.open && (txn_.kind == TxnKind::USER || txn_.kind == TxnKind::GESTURE) && ignoreUndo_ == 0;
  // An undo / redo's own writes (layout, groups, bindings after the replay) keep their inverses for its batch.
  bool replayWrite = txn_.open && (txn_.kind == TxnKind::UNDO || txn_.kind == TxnKind::REDO) && ignoreUndo_ == 0;
  // An instance's bindings as they were (its root override records only what changed).
  std::vector<ParamBinding> mapBefore;
  bool rootOverride = userEdit && c->phase == Phase::CHANGED && typeBefore == NodeType::INSTANCE;
  if (rootOverride && (c->mask & F_PARAM_MAP)) mapBefore = existing->props.parameterConsumptionMap;
  if (txn_.open) txn_.changes.touch(doc_, *c);
  if (record || replayWrite) {
    NodeChange inverse;
    if (!doc_.apply(*c, &inverse)) return;
    if (record) recording().record(std::move(inverse));
    else replayWrites_.push_back(std::move(inverse));
  } else if (!doc_.apply(*c)) {
    return;
  }
  markLayout(*c, parentBefore);
  noteChange(*c, typeBefore);
  // A component renamed by the user: a variant's name says its values (backfillVariantNames, at the step's end).
  if (userEdit && c->phase == Phase::CHANGED && (c->mask & F_NAME) && typeBefore == NodeType::SYMBOL) renamedVariants_.push_back(c->guid);
  // An edit of an instance's own fields that are its root's is kept as its root override (docs/schema.md §5.2).
  if (rootOverride) recordRootOverride(c->guid, *c, &mapBefore);
}

void Editor::markLayout(const NodeChange& c, Guid parentBefore) {
  if (inLayout_ || !txn_.open || !laysOut(txn_.kind)) return;
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
  // A layer dragged inside its auto-layout flow keeps its slot whatever its transform (pinned): moving it lays
  // nothing out (round 15: a drag lays out only on a swap, docs/engine.md §8.6).
  bool pinnedMove = (m & ~static_cast<FieldMask>(F_TRANSFORM)) == 0 && pinned_.count(c.guid) != 0;
  if (pinnedMove)
    if (const Node* pn = doc_.get(p.parentIndex.guid); !pn || !pn->props.isAutoLayout()) pinnedMove = false;
  if ((m & (F_SIZE | F_TRANSFORM | F_VISIBLE | kStackChildFields)) && !pinnedMove) markParent(p.parentIndex.guid);
  if (p.isAutoLayout() && (m & (kStackContainerFields | F_SIZE | F_STROKES | F_STROKE_WEIGHT | F_STROKE_ALIGN))) layoutDirty_.insert(c.guid);
  if (m & (F_STACK_MODE | F_RESIZE_TO_FIT)) layoutDirty_.insert(c.guid);
  if (m & F_EXTRA) {
    // Grid fields are kept as unmodelled bytes (GridLayout.cpp): a grid's tracks and gaps, an item's place and span.
    if (p.stack().stackMode == StackMode::GRID && p.isAutoLayout()) layoutDirty_.insert(c.guid);
    if (const Node* parent = doc_.get(p.parentIndex.guid); parent && parent->props.stack().stackMode == StackMode::GRID) markParent(p.parentIndex.guid);
  }
  if (p.isFrameLike() && (m & F_SIZE)) layoutDirty_.insert(c.guid);  // its children's constraints
  // A transform group's modifiers decide its box (docs/draw.md §4.2: the bounds of its instances, a system write).
  if (p.type == NodeType::TRANSFORM && (m & (F_EXTRA | F_TYPE))) layoutDirty_.insert(c.guid);
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
      if (txn_.open && laysOut(txn_.kind)) {
        // Undo, redo and remote changes lay out only pages already derived: another page is laid out whole when it
        // is first shown (derivePage), with its fonts.
        bool user = txn_.kind == TxnKind::USER || txn_.kind == TxnKind::GESTURE;
        std::vector<Guid> dirty;
        dirty.reserve(layoutDirty_.size());
        for (Guid g : layoutDirty_)
          if (user || onDerivedPage(g)) dirty.push_back(g);
        layoutDirty_.clear();
        if (!dirty.empty()) {
          inLayout_ = true;
          Layout(*this).run(dirty);
          inLayout_ = false;
          layoutRuns_++;
        }
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
    // A preview evaluated inside the transaction (motionInTxn_) shows again once the nested step is done.
    if (txn_.open && txn_.depth == 1 && motionInTxn_ && motion_.on) motionApply();
    return;
  }
  if (txn_.kind == TxnKind::USER || txn_.kind == TxnKind::GESTURE) {
    backfillVariantNames();
    flushLayout();
    removeEmptyGroups();
    flushLayout();
    if (editTracking_) stampEdited();  // editInfo on what was edited and its ancestors (Dev Mode's "Changed")
  } else {
    // Instances re-derive after undo, redo, remote changes and loads; undo, redo and remote changes are laid out
    // again too (laysOut). An undo's layout writes join the batch it put on the redo stack (a redo's: the undo stack).
    flushLayout();
    if ((txn_.kind == TxnKind::UNDO || txn_.kind == TxnKind::REDO) && replayPushed_)
      recording().extendTop(txn_.kind == TxnKind::UNDO, std::move(replayWrites_));
    replayWrites_.clear();
  }
  txn_.depth = 0;
  txn_.open = false;
  motionInTxn_ = false;
  motionDirty_ = true;
  if (motion_.on) motionApply();
  bool emits = txn_.kind != TxnKind::REMOTE && txn_.kind != TxnKind::LOAD;
  if (emits && !txn_.changes.empty()) {
    auto changes = txn_.changes.build(doc_);
    if (!changes.empty()) events_.documents.push_back({txn_.kind, txn_.label, std::move(changes), actor_});
  }
  if (txn_.kind == TxnKind::USER || txn_.kind == TxnKind::GESTURE) {
    // A plugin run's later slice joins the run's step while nothing else entered the user's history since (the
    // count moves with every other step; the label guards the history's cap, where it stops moving).
    UndoStack& stack = recording();
    bool userStack = undoTo_ == 0;
    size_t before = stack.undoCount();
    bool join = txn_.run && txn_.join && userStack && runMark_ != SIZE_MAX && runMark_ == before && !stack.canRedo() && stack.undoLabel() == txn_.label;
    // The user's step remembers the vector edit mode it was made in (undo goes back into it).
    if (userStack) stack.noteEditVector(vector_.node);
    stack.commit(selection_, mergeWithLast || join, &doc_);
    if (userStack && txn_.run) {
      bool made = stack.undoCount() != before || join;
      if (made) runMark_ = stack.undoCount();
      else if (!txn_.join) runMark_ = SIZE_MAX;  // a run's first slice that wrote nothing: nothing to join yet
    }
    events_.undo = true;
  }
  if (txn_.kind == TxnKind::USER || txn_.kind == TxnKind::GESTURE || txn_.kind == TxnKind::UNDO || txn_.kind == TxnKind::REDO) yieldOthers();
  else if (txn_.peer) yieldAll();
  txn_.peer = false;
  txn_.changes.clear();
  layoutDirty_.clear();
}

void Editor::rollback() {
  if (!txn_.open) return;
  // A preview's values go first: the rollback puts back what the transaction read.
  if (motionInTxn_ && motionLayer_.active()) motionLayer_.restore(doc_);
  motionInTxn_ = false;
  txn_.open = false;
  txn_.depth = 0;
  if (txn_.kind == TxnKind::USER || txn_.kind == TxnKind::GESTURE) {
    for (const NodeChange& c : recording().rollback(doc_)) noteChange(c, NodeType::NONE);
    events_.pages = true;
  }
  txn_.changes.clear();
  layoutDirty_.clear();
  groupsTouched_.clear();
  edited_.clear();
  userGeometry_.clear();
  renamedVariants_.clear();
  if (!instanceDirty_.empty() || !bindingsDirty_.empty()) {
    // The instances the cancelled edit reached show their restored mains again.
    begin(TxnKind::SYSTEM, "Instances");
    commit();
  }
  pruneSelection();
  // Motion (docs/motion.md §5): the transaction began with the base values back; the layer applies again.
  motionDirty_ = true;
  if (motion_.on) motionApply();
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
  // Conflicting override keys (two layers of one main sharing a key) repaired, as Figma's load does (round 17 B).
  std::vector<Guid> keyRepairs = conflictingOverrideKeys();
  if (dirty.empty() && instanceDirty_.empty() && unusedDeleted.empty() && bindingsDirty_.empty() && keyRepairs.empty()) return;
  std::sort(dirty.begin(), dirty.end());
  std::sort(unusedDeleted.begin(), unusedDeleted.end());
  begin(TxnKind::SYSTEM, "Layout");
  for (Guid g : keyRepairs) {
    NodeChange c = NodeChange::changed(g);
    c.mask = F_OVERRIDE_KEY;
    c.props.overrideKey = kNoGuid;
    write(c);
  }
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
  const NodeChange* inv = recording().openInverse(frame);
  if (!inv && txn_.open && (txn_.kind == TxnKind::UNDO || txn_.kind == TxnKind::REDO)) {
    // Resized by layout after an undo / redo's replay: its first write's inverse holds the size the replay left (a
    // size the replay itself restored came with its children's places: nothing to constrain).
    const NodeChange* w = replayInverse(frame, F_SIZE);
    if (!w) return false;
    oldSize = w->props.size;
    return true;
  }
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
  // Resized or moved by the user in this step (setProps): constraints start from that, not from before the step —
  // a child made absolute and resized while its hugging parent shrinks keeps the size it was given.
  if (txn_.open && txn_.kind == TxnKind::USER && userGeometry_.count(id)) return;
  if (const NodeChange* inv = recording().openInverse(id)) {
    // Moved to another parent in this transaction: its old transform was in the old parent's space.
    if ((inv->mask & F_PARENT_INDEX) && inv->props.parentIndex.guid != n->props.parentIndex.guid) return;
    if (inv->mask & F_TRANSFORM) transform = inv->props.transform;
    if (inv->mask & F_SIZE) size = inv->props.size;
  } else if (txn_.open && (txn_.kind == TxnKind::UNDO || txn_.kind == TxnKind::REDO)) {
    // After an undo / redo's replay: where the replay left it, before layout moved it (constraints run every pass).
    if (const NodeChange* w = replayInverse(id, F_TRANSFORM)) transform = w->props.transform;
    if (const NodeChange* w = replayInverse(id, F_SIZE)) size = w->props.size;
  }
}

const NodeChange* Editor::replayInverse(Guid id, FieldMask field) const {
  for (const NodeChange& w : replayWrites_)
    if (w.guid == id && w.phase == Phase::CHANGED && (w.mask & field)) return &w;
  return nullptr;
}

// ---- Bookkeeping ------------------------------------------------------------

void Editor::changeSelection(std::vector<Guid> ids) {
  bool motionFollows = motion_.on && motion_.root == kNoGuid;
  if (ids == selection_) return;
  selection_ = std::move(ids);
  // Layers selected: a selected ruler guide lets go; nothing selected: the ⌥R origin goes too.
  if (!selection_.empty()) selectedGuide_ = {};
  else rotationOriginOn_ = false;
  // Gradient handles belong to a selected layer.
  if (paint_.node != kNoGuid && std::find(selection_.begin(), selection_.end(), paint_.node) == selection_.end()) endPaintEdit();
  events_.selection = true;
  if (motionFollows) motionApply();  // a new selection may be in another root (docs/motion.md §4.9: root null = the selection's)
  needsRender_ = true;
}

void Editor::changeCamera(const Camera& requested) {
  // Every move of the view goes through here: it stops at the canvas's edge (kCanvasBound)
  const Camera c = requested.keptOnCanvas(viewport_.visible());
  if (c.x == camera_.x && c.y == camera_.y && c.zoom == camera_.zoom) return;
  camera_ = c;
  events_.camera = true;
  needsRender_ = true;
  scroll_.pendingShow = true;  // round 16: the scrollbars show while the view moves
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
  if (scope_.on) {
    // An actor is writing: its selection, page and view are its own, not the user's (actorEnd puts theirs back).
    events_.selection = events_.currentPage = events_.camera = false;
    events_.textEdit = events_.vectorEdit = events_.paintEdit = false;
    events_.prototypeSelected.clear();
    events_.gridTracks.clear();
    events_.notices.clear();  // an actor hears its refusals from the call's result
  }
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
  o.handles = !viewer_ && gesture_ != Gesture::Move && gesture_ != Gesture::Marquee && gesture_ != Gesture::Rotate && gesture_ != Gesture::Reorder;
  o.sizeBadge = true;
  // Round 15, a layer dragged inside its own auto-layout flow (live Figma, autolayout-drag.md): drawn above its
  // siblings; its outline, handles and size label (and its frame's dashes) stay until the first swap, then go until
  // the drop.
  if (gesture_ == Gesture::Move && flowDragLive()) {
    o.lifted = flowDrag_.ids;
    if (flowDrag_.chromeHidden) {
      o.selection.clear();
      o.sizeBadge = false;
    } else {
      o.handles = !viewer_;
    }
  } else if (gesture_ == Gesture::Move && !flowDrag_.ids.empty()) {
    // Round 2 (the owner's second recording): out of its frame, or ⌥-copied, a layer from an auto-layout flow moves
    // without its chrome.
    o.selection.clear();
    o.sizeBadge = false;
  }
  // Round 2: dragged into an auto-layout flow from elsewhere (or an ⌥-copy over one): a 30 % ghost over everything,
  // the frame outlined and its layers faintly, the insertion line; no chrome.
  if (gesture_ == Gesture::Move && hasInsertion_ && dropParent_ != kNoGuid) {
    for (const Target& t : targets_)
      if (doc_.has(t.id) && doc_.parentOf(t.id) == dropParent_) o.ghosts.push_back(t.id);
    if (!o.ghosts.empty()) {
      o.dropFrame = dropParent_;
      o.selection.clear();
      o.sizeBadge = false;
    }
  }
  o.hasMarquee = gesture_ == Gesture::Marquee || (gesture_ == Gesture::ZoomArea && (lastScreen_ - downScreen_).length() >= 3) ||
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
  if ((gesture_ == Gesture::None || gesture_ == Gesture::LayoutBar) && selection_.size() == 1 && selection_[0] == layoutBarsFrame_) {
    o.layoutBars = layoutBars_;
    o.spacingAreas = spacingAreas_;
  }
  if (gesture_ == Gesture::None && panelSpacing_) panelSpacingAreas(o.spacingAreas);
  if (o.handles && gesture_ != Gesture::Move) {
    Guid line;
    Vec2 a, b;
    if (selectedLine(line, a, b)) o.lineEnds = {a, b};
    Vec2 rh[4];
    if (radiusHandles(line, rh)) {
      o.radiusHandles.assign(rh, rh + 4);
      o.radiusHovered = gesture_ == Gesture::Radius ? radiusCorner_ : radiusHover_;
    }
    std::vector<ShapeHandlePos> sh;
    if (shapeHandles(line, sh)) {
      for (const ShapeHandlePos& h : sh) o.shapeHandles.push_back(h.world);
      o.shapeHovered = gesture_ == Gesture::Shape ? shapeDrag_.index : shapeHover_;
    }
  }
  // Smart selection: a dot on each equally spaced layer; the gap handles while the pointer is over the selection.
  SmartSelection smart;
  if (gesture_ == Gesture::Reorder) {
    // Reordering: the rings where the layers are now, the dragged one's lit.
    Guid dragged = reorderIndex_ >= 0 && static_cast<size_t>(reorderIndex_) < reorderFrom_.order.size() ? reorderFrom_.order[static_cast<size_t>(reorderIndex_)] : kNoGuid;
    for (Guid id : reorderOrder_) {
      if (!doc_.has(id)) continue;
      Rect b = doc_.worldBounds(id);
      if (id == dragged) o.centreDotHovered = static_cast<int>(o.centreDots.size());
      o.centreDots.push_back({b.x + b.w / 2, b.y + b.h / 2});
    }
  } else if ((gesture_ == Gesture::None || gesture_ == Gesture::Gap) && !viewer_ && smartSelection(smart)) {
    for (Guid id : smart.order) {
      Rect b = doc_.worldBounds(id);
      o.centreDots.push_back({b.x + b.w / 2, b.y + b.h / 2});
    }
    if (gesture_ == Gesture::None) o.centreDotHovered = reorderHover_;
    // Round 11: off the selection, dots; on it, the rings (live Figma).
    o.centreDotsIdle = gesture_ == Gesture::None && !pointerInSelection_;
    if (pointerInSelection_ || gesture_ == Gesture::Gap)
      for (size_t i = 1; i < smart.order.size(); i++) {
        Rect a = doc_.worldBounds(smart.order[i - 1]), b = doc_.worldBounds(smart.order[i]);
        Overlay::GapHandle g;
        g.vertical = smart.axis == 1;
        g.at = smart.axis == 0 ? Vec2{(a.right() + b.x) / 2, (std::max(a.y, b.y) + std::min(a.bottom(), b.bottom())) / 2}
                               : Vec2{(std::max(a.x, b.x) + std::min(a.right(), b.right())) / 2, (a.bottom() + b.y) / 2};
        g.length = smart.axis == 0 ? std::min(a.h, b.h) : std::min(a.w, b.w);
        g.hovered = gesture_ == Gesture::Gap ? static_cast<int>(i - 1) == gapIndex_ : static_cast<int>(i - 1) == gapHover_;
        g.value = smart.spacing;
        o.gapHandles.push_back(g);
      }
  } else if (gesture_ == Gesture::None) {
    groupDotsOverlay(o);
  }
  // Round 11: a selected auto-layout component's, set's or instance's gaps (with the handles: not while moving).
  if (o.handles && gesture_ != Gesture::Move && text_.node == kNoGuid && vector_.node == kNoGuid) gapBoxesOverlay(o);
  // Round 12: a selected grid's gaps of one axis, the pointer in one of them or dragging it (tools/GridGestures.cpp).
  if (text_.node == kNoGuid && vector_.node == kNoGuid) gridGapOverlay(o);
  o.pixelGrid = (viewOptions_ & VIEW_PIXEL_GRID) != 0;
  o.outlines = (viewOptions_ & VIEW_OUTLINES) != 0;
  o.outlineHidden = (viewOptions_ & VIEW_OUTLINE_HIDDEN) != 0;
  o.outlineBounds = (viewOptions_ & VIEW_OUTLINE_BOUNDS) != 0;
  o.layoutGuides = (viewOptions_ & VIEW_LAYOUT_GUIDES) != 0;
  o.pixelPreview = (viewOptions_ & VIEW_PIXEL_PREVIEW_2X) ? 2 : (viewOptions_ & VIEW_PIXEL_PREVIEW) ? 1 : 0;
  // Preferences › Show dimensions on objects (round 9): no W × H badge (the angle while rotating stays).
  if (!(viewOptions_ & VIEW_SHOW_DIMENSIONS) && gesture_ != Gesture::Rotate) o.sizeBadge = false;
  // Round 8: the ⌥R rotation origin, the angle while rotating, ruler guides, slices.
  if (rotationOriginShown() || (gesture_ == Gesture::Rotate && rotationOriginOn_)) {
    o.hasRotationOrigin = true;
    o.rotationOrigin = gesture_ == Gesture::Rotate ? rotateCentre_ : rotationOrigin();
  }
  if (gesture_ == Gesture::Rotate) o.badgeText = rotateBadgeText();
  // Motion (docs/motion.md §6.4): the selected layer's motion path, the anchor point's target; the Motion icon's frames.
  motionOverlay(o);
  o.motionTitles = motionTitleRoots_;
  guideOverlay(o);
  // Round 10, View › Frame outlines / Mask outlines: every frame's / mask's box on the page as a thin quiet line
  // (help.figma.com lists the toggles; the look is unverified).
  if ((viewOptions_ & (VIEW_FRAME_OUTLINES | VIEW_MASK_OUTLINES)) && page_ != kNoGuid && !viewer_) {
    std::function<void(Guid)> visit = [&](Guid parent) {
      for (Guid c : doc_.children(parent)) {
        const Node* n = doc_.get(c);
        if (!n || !n->props.visible) continue;
        const NodeProps& p = n->props;
        bool frame = (viewOptions_ & VIEW_FRAME_OUTLINES) && p.isFrameLike() && !p.isGroupLike() && p.type != NodeType::SECTION;
        bool mask = (viewOptions_ & VIEW_MASK_OUTLINES) && p.mask;
        if (frame || mask) {
          Mat2x3 m = doc_.worldTransform(c);
          Vec2 q[4] = {m.apply({0, 0}), m.apply({p.size.x, 0}), m.apply({p.size.x, p.size.y}), m.apply({0, p.size.y})};
          for (int i = 0; i < 4; i++) o.curves.push_back({q[i], q[i], q[(i + 1) % 4], q[(i + 1) % 4], 1, false});
        }
        if (p.type != NodeType::INSTANCE) visit(c);
      }
    };
    visit(page_);
  }
  if ((viewOptions_ & VIEW_SLICES) && !viewer_)
    for (Guid id : slices_) {
      const Node* n = doc_.get(id);
      if (!n || doc_.pageOf(id) != page_ || !doc_.visibleInTree(id)) continue;
      o.slices.push_back({doc_.worldTransform(id), n->props.size});
    }
  o.hasInsertion = gesture_ == Gesture::Move && hasInsertion_;
  o.insertion = insertion_;
  // (Its cells stay while its padding or a gap is dragged.)
  if ((gesture_ == Gesture::None || gesture_ == Gesture::Grid || gesture_ == Gesture::LayoutBar) && selection_.size() == 1 && text_.node == kNoGuid) {
    gridTrackOverlay(o);
    gridSpanOverlay(o);
  }
  if (text_.node != kNoGuid) {
    // Editing text: the text's own box stays outlined (no handles, no badge), plus the selection and caret.
    o.textNode = text_.node;
    o.selection = {text_.node};
    o.handles = false;
    o.sizeBadge = false;
    const text::TextLayout* PL = const_cast<Editor*>(this)->textLayout(text_.node);
    if (PL && PL->path) {
      textPathEditOverlay(o, *PL);  // text on a path: the caret and the selection turned along it (DrawTools.cpp)
    } else if (const text::TextLayout* L = PL) {
      o.textSelection = L->selectionRects(textSelStart(), textSelEnd());
      // Text › Spell check (round 10): the misspelled words' lines.
      if (spellingNode_ == text_.node) {
        uint32_t len = static_cast<uint32_t>(L->text.size());
        for (auto [a, b] : spelling_)
          if (a < len)
            for (const Rect& r : L->selectionRects(a, std::min(b, len))) o.misspelled.push_back(r);
      }
      if (text_.anchor == text_.focus) {
        size_t line = L->lineOf(text_.focus, text_.upstream);
        const text::LaidLine& l = L->lines[line];
        o.caret = {L->caretX(text_.focus, line), l.top, 0, l.height};
        o.caretVisible = text_.caretOn;
      }
    }
  }
  if (vector_.node != kNoGuid) vectorOverlay(o);
  textPathOverlay(o);  // Draw: a text path's start handle, the Text on path tool's edge
  if (paint_.node != kNoGuid) paintOverlay(o);
  if (proto_.on) protoOverlay(o);
  scrollbarOverlay(o);  // round 16
  devOverlay(o);
  if (devInspect()) devInspectOverlay(o);
  // Round 18: other people — their selected layers that exist on this page (others ignored), their cursors.
  o.localChat = localChat_;
  o.presence.reserve(presence_.size());
  for (const PresencePeer& peer : presence_) {
    PresencePeer p = peer;
    p.selection.clear();
    for (Guid id : peer.selection)
      if (doc_.has(id) && doc_.pageOf(id) == page_ && id != page_) p.selection.push_back(id);
    if (p.hasCursor || !p.selection.empty()) o.presence.push_back(std::move(p));
  }
  if (gesture_ == Gesture::Pencil && pencilPoints_.size() > 1)
    for (size_t i = 1; i < pencilPoints_.size(); i++)
      o.curves.push_back({pencilPoints_[i - 1], pencilPoints_[i - 1], pencilPoints_[i], pencilPoints_[i], 1, true});
  return o;
}

// ---- Document ---------------------------------------------------------------

void Editor::loadDocument(std::vector<NodeChange>&& nodes, Guid page, StoredDerived* derived) {
  cancelGesture();
  motionLayer_ = motion::MotionLayer();  // the old document's base values are gone with it
  motion_ = motion::State();
  motionDirty_ = true;
  pathToolCancel();
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
  renamedVariants_.clear();
  doc_.clear();
  undo_.clear();
  actorUndo_.clear();
  scope_ = ActorScope{};
  actor_ = undoTo_ = 0;
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
  navMain_ = kNoGuid;
  returnTo_.clear();
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
  // Another session's change waits for the user's step, gesture or an actor's write to end (the caller tries again):
  // inside it, it would become part of the user's undo step and be emitted as theirs.
  bool peer = (flags & APPLY_PEER) && !(flags & (APPLY_USER | APPLY_SYSTEM | APPLY_LOAD));
  if (peer && !idle()) return E_BUSY;
  TxnKind kind = (flags & APPLY_USER)     ? TxnKind::USER
                 : (flags & APPLY_SYSTEM) ? TxnKind::SYSTEM
                 : (flags & APPLY_LOAD)   ? TxnKind::LOAD
                                          : TxnKind::REMOTE;
  // A system change inside an open user step would become part of that undo step.
  if (kind == TxnKind::SYSTEM && txn_.open && txn_.kind != TxnKind::SYSTEM) return E_BUSY;
  begin(kind, "Edit");
  txn_.peer = peer;
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
  std::vector<Guid> touched;
  if (peer) touched = txn_.changes.touched();
  commit();
  // The user's edit sessions follow what the other session changed under them (a caret kept inside a rewritten text).
  if (peer) followForeign(touched);
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
  if (n->props.isTextLike()) {  // TEXT, and a text on a path (its glyphs placed and turned: Glyph.rotation)
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
  pathToolCancel();  // (Simplify vector / Offset path: the layer as it was)
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
  gridGap_ = {};
  events_.currentPage = events_.structure = events_.structureAll = true;
  needsRender_ = true;
  return OK;
}

// ---- View -------------------------------------------------------------------

void Editor::setViewport(double cssWidth, double cssHeight, double dpr, int pixelWidth, int pixelHeight) {
  viewport_.width = std::max(0.0, cssWidth);
  viewport_.height = std::max(0.0, cssHeight);
  viewport_.dpr = dpr > 0 ? dpr : 1;
  viewport_.pixelWidth = pixelWidth;
  viewport_.pixelHeight = pixelHeight;
  needsRender_ = true;
}

void Editor::setViewportInsets(double left, double top, double right, double bottom) {
  viewport_.insetLeft = std::max(0.0, left);
  viewport_.insetTop = std::max(0.0, top);
  viewport_.insetRight = std::max(0.0, right);
  viewport_.insetBottom = std::max(0.0, bottom);
}

Camera Editor::fitVisible(const Rect& r, double padding) const {
  // Camera::fit in the part of the canvas the panels leave visible, then moved to where that part is.
  Rect v = viewport_.visible();
  if (v.w <= padding * 2 || v.h <= padding * 2) return camera_;
  Camera c = Camera::fit(r, v.w, v.h, padding);
  return {c.x + v.x, c.y + v.y, c.zoom};
}

Vec2 Editor::visibleCentre() const {
  Rect v = viewport_.visible();
  return {v.x + v.w / 2, v.y + v.h / 2};
}

Rect Editor::visibleWorld() const {
  Rect v = viewport_.visible();
  return Rect::fromPoints(camera_.toWorld({v.x, v.y}), camera_.toWorld({v.right(), v.bottom()}));
}

void Editor::setCamera(const Camera& c) {
  stopCameraAnimation();
  zooming_ = false;
  bool shown = scroll_.pendingShow;
  changeCamera({c.x, c.y, Camera::clampZoom(c.zoom)});
  scroll_.pendingShow = shown;  // round 16: a view set from outside (a file's saved view) doesn't flash the scrollbars
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
  stopCameraAnimation();
  zooming_ = false;
  Vec2 about = visibleCentre();
  // Preferences › Keyboard zooms into selection (round 9): about the selection's centre, as it is on screen.
  if (viewOptions_ & VIEW_KEYBOARD_ZOOM_SELECTION) {
    bool any = false;
    Rect r;
    for (Guid id : selection_) {
      if (!doc_.has(id) || doc_.pageOf(id) != page_) continue;
      Rect b = doc_.worldBounds(id);
      r = any ? r.united(b) : b;
      any = true;
    }
    if (any) about = camera_.toScreen({r.x + r.w / 2, r.y + r.h / 2});
  }
  changeCamera(snapped(camera_.zoomedAround(zoom, about)));
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
  stopCameraAnimation();
  zooming_ = false;
  if (any) changeCamera(snapped(fitVisible(r, kFitPadding)));
}

void Editor::zoomToSelection(double animateMs) {
  bool any = false;
  Rect r;
  for (Guid id : selection_) {
    if (!doc_.has(id)) continue;
    Rect b = doc_.worldBounds(id);
    r = any ? r.united(b) : b;
    any = true;
  }
  // Nothing selected: zoom to fit (Figma, Atlas 04 §2.3).
  if (!any) {
    zoomToFit();
    return;
  }
  if (animateMs > 0) {
    animateCamera(snapped(fitVisible(r, kSelectionPadding)), animateMs);
    return;
  }
  stopCameraAnimation();
  zooming_ = false;
  changeCamera(snapped(fitVisible(r, kSelectionPadding)));
}

bool Editor::tick(double timeMs) {
  timeMs_ = timeMs;
  // The frame's one move of a gesture (the latest the pointer sent since the last frame); without one, the replay of a
  // move that reflowed the page (a newer move stands in for it).
  if (queuedMove_.on) {
    replayWanted_ = false;
    flushQueuedMove();
  } else {
    replayDrag();
  }
  // Round 16: the camera gliding, the scrollbars showing / fading.
  cameraTick(timeMs);
  // Round 8i: the Motion icon follows the document outside Motion mode too — the index rebuilt between gestures.
  if (motionDirty_ && !txn_.open && gesture_ == Gesture::None && page_ != kNoGuid) motionIndex();
  scrollbarTick(timeMs);
  // The `</>` button's tooltip: after the tooltip delay under the pointer (DevMode.cpp devIconHoverAt).
  if (devIconHover_ != kNoGuid && !devTooltip_ && !devIconPressed_) {
    if (devIconSince_ < 0) devIconSince_ = timeMs;
    else if (timeMs - devIconSince_ >= kTooltipDelayMs) {
      devTooltip_ = true;
      needsRender_ = true;
    }
  }
  if (!slides_.empty()) {
    // Round 15: siblings sliding to their new places in a dragged layer's flow (the gesture's transaction).
    if (txn_.open && gesture_ == Gesture::Move) {
      for (auto& [id, s] : slides_)
        if (s.start < 0) s.start = timeMs;  // a slide starts with the first frame after its swap
      applySlides(timeMs);
    } else {
      slides_.clear();
    }
  }
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
  // Simplify vector / Offset path open: selecting anything else cancels it (the layer as it was).
  if (pathTool_.kind != PathTool::NONE && !(ids.size() == 1 && ids[0] == pathTool_.node)) pathToolCancel();
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

void Editor::setPresence(std::vector<PresencePeer> peers) {
  if (peers.empty() && presence_.empty()) return;
  presence_ = std::move(peers);
  needsRender_ = true;
}

void Editor::setLocalChat(const LocalChat& chat) {
  if (!chat.on && !localChat_.on) return;
  localChat_ = chat;
  needsRender_ = true;
}

void Editor::centerOn(Vec2 world, double zoom) {
  stopCameraAnimation();
  zooming_ = false;
  double z = Camera::clampZoom(std::isfinite(zoom) && zoom > 0 ? zoom : camera_.zoom);
  Vec2 c = visibleCentre();
  changeCamera({c.x - world.x * z, c.y - world.y * z, z});
}

Camera Editor::viewCenter() const {
  Vec2 w = camera_.toWorld(visibleCentre());
  return {w.x, w.y, camera_.zoom};
}

void Editor::setHover(const std::vector<Guid>& ids) {
  if (ids == layersHover_) return;
  layersHover_ = ids;
  needsRender_ = true;
}

Status Editor::setProps(const std::vector<Guid>& ids, const NodeChange& props, uint32_t /*flags*/) {
  if (busy() || pathTool_.kind != PathTool::NONE) return E_BUSY;  // (a path tool's open step isn't joined)
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
    // Motion on (docs/motion.md §4.9): a keyframable field with a track (or any, with auto-keyframe) becomes a keyframe.
    if (motion_.on && c.mask) c.mask &= ~motionRouteWrite(id, c);
    if (!c.mask) continue;
    if (before.type == NodeType::TEXT && (c.mask & F_SIZE) && !(mask & F_TEXT_AUTO_RESIZE) &&
        before.text().textAutoResize != TextAutoResize::NONE) {
      // A size typed for an auto-resizing text: a width makes it auto height, a height a fixed box (Figma).
      bool h = c.props.size.y != before.size.y, w = c.props.size.x != before.size.x;
      if (h) c.props.text().textAutoResize = TextAutoResize::NONE;
      else if (w && before.text().textAutoResize == TextAutoResize::WIDTH_AND_HEIGHT) c.props.text().textAutoResize = TextAutoResize::HEIGHT;
      if (h || (w && before.text().textAutoResize == TextAutoResize::WIDTH_AND_HEIGHT)) c.mask |= F_TEXT_AUTO_RESIZE;
    }
    if (c.mask & F_PROPORTIONS_CONSTRAINED) {
      // "Lock aspect ratio" on records the layer's width : height as Figma's targetAspectRatio (what auto layout and
      // constraints keep, docs/engine.md §4); off clears it.
      bool has = Layout::aspectRatio(before) > 0 || before.extra.count("targetAspectRatio");
      if (c.props.proportionsConstrained && !has && before.size.x > 0 && before.size.y > 0 &&
          !(before.type == NodeType::TEXT && before.text().textAutoResize != TextAutoResize::NONE)) {
        c.props.extra["targetAspectRatio"] = Layout::aspectRatioBytes(before.size);
        c.mask |= F_EXTRA;
      } else if (!c.props.proportionsConstrained && has) {
        c.props.extra["targetAspectRatio"] = std::string();
        c.mask |= F_EXTRA;
      }
    }
    dropStaleAuthoredColors(before, c);
    stampNewStack(before, c);  // auto layout given now: the Updated layout (Atlas 09 §3.2)
    if (c.mask) write(c);
  }
  flushLayout();  // live, also inside a panel scrub
  commit();
  return OK;
}

Status Editor::txnBegin(const std::string& label) {
  if (busy() || pathTool_.kind != PathTool::NONE) return E_BUSY;
  begin(TxnKind::USER, label);
  return OK;
}

Status Editor::txnBeginRun(const std::string& label, bool join) {
  if (busy() || pathTool_.kind != PathTool::NONE) return E_BUSY;
  if (txn_.open) return E_BUSY;  // a panel scrub or an actor's step is open: the run waits
  begin(TxnKind::USER, label);
  txn_.run = true;
  txn_.join = join;
  return OK;
}

Status Editor::txnCommit() {
  if (!txn_.open) return E_INVALID;
  commit();
  return OK;
}

void Editor::txnCancel() { rollback(); }

bool Editor::onDerivedPage(Guid id) const {
  Guid page = doc_.pageOf(id);
  const Node* pn = doc_.get(page);
  if (!pn) return false;
  return pn->props.rare().internalOnly || derivedPages_.count(page) != 0;
}

bool Editor::undoStep(bool redo) {
  if (busy() || txn_.open || scope_.on) return false;
  undo_.dropEmpty(redo);  // steps whose every change others overwrote since
  if (redo ? !undo_.canRedo() : !undo_.canUndo()) return false;
  runMark_ = SIZE_MAX;  // a plugin run's next slice starts a new step
  begin(redo ? TxnKind::REDO : TxnKind::UNDO, redo ? undo_.redoLabel() : undo_.undoLabel());
  std::vector<Guid> sel = selection_;
  // The pages the replayed changes were on, first first (Figma's undoBatchPageIds): the batch that did something
  // visible decides (a skipped one's page shows nothing new).
  std::vector<Guid> touchedPages, batchPages;
  auto notePage = [&](Guid at) {
    Guid page = doc_.pageOf(at);
    const Node* pn = doc_.get(page);
    if (!pn || pn->props.rare().internalOnly) return;
    if (std::find(batchPages.begin(), batchPages.end(), page) == batchPages.end()) batchPages.push_back(page);
  };
  // One press always does something the user can see (Figma: "%d batch(es) would be skipped before applying one"):
  // a batch with no visible effect — only hidden layers' values, values equal to the current ones, or nothing left
  // after the dangling-reference filter — is applied, and the next one follows in the same press.
  // The vector edit mode the step that did something was made in (Figma's update-edit-mode-for-undo).
  Guid editIn = kNoGuid;
  for (;;) {
    std::string label = redo ? undo_.redoLabel() : undo_.undoLabel();
    // The batch's own pages, as it noted them when made (Message.undoBatchPageIds 46), win over the replay's.
    std::vector<Guid> stored = redo ? undo_.redoBatches().back().pageIds : undo_.undoBatches().back().pageIds;
    Guid batchEdit = redo ? undo_.redoBatches().back().editVector : undo_.undoBatches().back().editVector;
    ReplayInfo info;
    batchPages.clear();
    auto applied = redo ? undo_.redo(doc_, sel, &txn_.changes, &info) : undo_.undo(doc_, sel, &txn_.changes, &info);
    replayPushed_ = replayPushed_ || info.pushed;
    for (size_t i = 0; i < applied.size(); i++) {
      const NodeChange& c = applied[i];
      noteChange(c, NodeType::NONE);
      markLayout(c, info.parentsBefore[i]);  // restored sizes aren't trusted: layout runs again (§3.3)
      const Node* n = doc_.get(c.guid);
      bool pageItself = n && (n->props.type == NodeType::CANVAS || n->props.type == NodeType::DOCUMENT);
      if (!pageItself) notePage(c.phase == Phase::REMOVED ? info.parentsBefore[i] : c.guid);
    }
    if (!stored.empty()) {
      batchPages.clear();
      for (Guid p : stored) {
        const Node* pn = doc_.get(p);
        if (pn && pn->props.type == NodeType::CANVAS && !pn->props.rare().internalOnly) batchPages.push_back(p);
      }
    }
    if (info.visible) {
      txn_.label = label;  // the step is named by the batch that did something
      touchedPages = batchPages;
      editIn = batchEdit;
      break;
    }
    for (Guid page : batchPages)
      if (std::find(touchedPages.begin(), touchedPages.end(), page) == touchedPages.end()) touchedPages.push_back(page);
    undo_.dropEmpty(redo);
    if (redo ? !undo_.canRedo() : !undo_.canUndo()) break;
  }
  events_.pages = true;
  commit();
  events_.undo = true;
  // The selection was on a page that may not be the current one; with no selection, the page the changes were on.
  if (!sel.empty() && doc_.has(sel[0]) && doc_.pageOf(sel[0]) != page_) setCurrentPage(doc_.pageOf(sel[0]));
  else if (sel.empty() && !touchedPages.empty() && std::find(touchedPages.begin(), touchedPages.end(), page_) == touchedPages.end() && doc_.has(touchedPages[0]))
    setCurrentPage(touchedPages[0]);
  if (!doc_.has(page_)) {
    auto all = pages();
    if (!all.empty()) setCurrentPage(all[0]);
  }
  changeSelection(sel);
  pruneSelection();
  if (vector_.node != kNoGuid) reloadVector();
  // A step made in vector edit mode takes the editor back into it on its layer (left since, or another layer's).
  if (editIn != kNoGuid && vector_.node != editIn && text_.node == kNoGuid && doc_.has(editIn) && doc_.pageOf(editIn) == page_) startVectorEdit(editIn);
  if (paint_.node != kNoGuid && !paintSessionLive()) endPaintEdit();
  return true;
}

// ---- Actors (docs/engine.md §9.5) -------------------------------------------

UndoStack& Editor::stackOf(uint32_t actor) {
  if (actor == 0) return undo_;
  auto it = actorUndo_.find(actor);
  if (it != actorUndo_.end()) return it->second;
  // Past the budget the oldest actors' histories go (the ids grow: an agent turn's step stays among the last ones).
  while (actorUndo_.size() >= kMaxActors) {
    auto oldest = actorUndo_.begin();
    if (oldest->first == undoTo_ || oldest->first == actor_) break;
    actorUndo_.erase(oldest);
  }
  return actorUndo_[actor];
}

void Editor::yieldOthers() {
  if (txn_.changes.empty()) return;
  if (undoTo_ != 0) undo_.yield(txn_.changes);
  for (auto& [id, stack] : actorUndo_)
    if (id != undoTo_) stack.yield(txn_.changes);
}

void Editor::yieldAll() {
  if (txn_.changes.empty()) return;
  undo_.yield(txn_.changes);
  for (auto& [id, stack] : actorUndo_) stack.yield(txn_.changes);
}

void Editor::followForeign(const std::vector<Guid>& touched) {
  auto hit = [&](Guid id) { return id != kNoGuid && std::find(touched.begin(), touched.end(), id) != touched.end(); };
  if (hit(text_.node)) {
    if (!doc_.has(text_.node)) {
      text_ = TextSession{};
      events_.textEdit = true;
    } else {
      // The text changed under the caret: keep it inside; typing on starts a new step.
      uint32_t len = static_cast<uint32_t>(editedText().size());
      if (text_.anchor > len || text_.focus > len) setTextSelection(std::min(text_.anchor, len), std::min(text_.focus, len));
      text_.undoCount = 0;
      events_.textEdit = true;
    }
  }
  if (hit(vector_.node)) {
    if (doc_.has(vector_.node)) {
      reloadVector();
    } else {
      vector_ = VectorSession{};
      events_.vectorEdit = true;
    }
  }
  if (paint_.node != kNoGuid && hit(paint_.node) && (!doc_.has(paint_.node) || !paintSessionLive())) endPaintEdit();
  pruneSelection();
  needsRender_ = true;
}

Status Editor::actorBegin(uint32_t actor, const std::vector<Guid>& selection, Guid page, const std::string& label, bool merge, uint32_t undoTo) {
  if (actor == 0) return E_INVALID;
  if (scope_.on || busy() || txn_.open || pathTool_.kind != PathTool::NONE) return E_BUSY;
  // The actor's page: given, else its first selected layer's, else the user's.
  auto isPage = [&](Guid p) {
    const Node* n = doc_.get(p);
    return n && n->props.type == NodeType::CANVAS && !n->props.rare().internalOnly;
  };
  Guid p = page;
  if (!isPage(p) && !selection.empty() && doc_.has(selection[0])) p = doc_.pageOf(selection[0]);
  if (!isPage(p)) p = page_;
  // Shown for the actor before its step opens: a page's derivation is a load, not part of anyone's step.
  derivePage(p);
  for (Guid id : selection)
    if (doc_.has(id) || id.isDerived()) derivePageOf(id);
  scope_.on = true;
  scope_.merge = merge;
  scope_.selection = std::move(selection_);
  scope_.page = page_;
  scope_.pageSelections = pageSelections_;
  scope_.camera = camera_;
  scope_.camAnim = camAnim_;
  scope_.text = std::move(text_);
  scope_.vector = std::move(vector_);
  scope_.paint = std::move(paint_);
  scope_.protoNode = proto_.selNode;
  scope_.protoIndex = proto_.selIndex;
  scope_.guide = selectedGuide_;
  scope_.gridSel = gridSel_;
  scope_.lastNudged = lastNudged_;
  scope_.zoomFrame = zoomFrame_;
  scope_.zoomSelection = zoomSelection_;
  scope_.rotationOriginOn = rotationOriginOn_;
  scope_.evSelection = events_.selection;
  scope_.evCurrentPage = events_.currentPage;
  scope_.evCamera = events_.camera;
  scope_.evTextEdit = events_.textEdit;
  scope_.evVectorEdit = events_.vectorEdit;
  scope_.evPaintEdit = events_.paintEdit;
  text_ = TextSession{};
  vector_ = VectorSession{};
  paint_ = PaintSession{};
  proto_.selNode = kNoGuid;
  proto_.selIndex = -1;
  selectedGuide_ = {};
  gridSel_ = {};
  lastNudged_.clear();
  rotationOriginOn_ = false;
  page_ = p;
  selection_.clear();
  for (Guid id : selection)
    if (doc_.has(id) && doc_.pageOf(id) == p && std::find(selection_.begin(), selection_.end(), id) == selection_.end()) selection_.push_back(id);
  actor_ = actor;
  undoTo_ = undoTo;
  stackOf(undoTo_);
  begin(TxnKind::USER, label);
  return OK;
}

Status Editor::actorEnd(bool cancel) {
  if (!scope_.on) return E_INVALID;
  std::vector<Guid> touched;
  if (txn_.open) {
    if (cancel) {
      rollback();
    } else {
      touched = txn_.changes.touched();
      txn_.depth = 1;  // whatever the writes left open is part of this step
      commit(scope_.merge && recording().canUndo() && !recording().canRedo());
    }
  }
  actor_ = 0;
  undoTo_ = 0;
  selection_ = std::move(scope_.selection);
  page_ = scope_.page;
  pageSelections_ = std::move(scope_.pageSelections);
  camera_ = scope_.camera;
  camAnim_ = scope_.camAnim;
  text_ = std::move(scope_.text);
  vector_ = std::move(scope_.vector);
  paint_ = std::move(scope_.paint);
  proto_.selNode = scope_.protoNode;
  proto_.selIndex = scope_.protoIndex;
  selectedGuide_ = scope_.guide;
  gridSel_ = scope_.gridSel;
  lastNudged_ = std::move(scope_.lastNudged);
  zoomFrame_ = scope_.zoomFrame;
  zoomSelection_ = std::move(scope_.zoomSelection);
  rotationOriginOn_ = scope_.rotationOriginOn;
  events_.selection = scope_.evSelection;
  events_.currentPage = scope_.evCurrentPage;
  events_.camera = scope_.evCamera;
  events_.textEdit = scope_.evTextEdit;
  events_.vectorEdit = scope_.evVectorEdit;
  events_.paintEdit = scope_.evPaintEdit;
  scope_ = ActorScope{};
  if (!doc_.has(page_)) {
    auto all = pages();
    if (!all.empty()) setCurrentPage(all[0]);
  }
  followForeign(touched);
  events_.structure = events_.structureAll = true;  // the Layers rows: the actor's page may have been another
  needsRender_ = true;
  return OK;
}

bool Editor::actorUndo(uint32_t actor, bool redo) {
  if (actor == 0 || busy() || txn_.open || scope_.on) return false;
  auto it = actorUndo_.find(actor);
  if (it == actorUndo_.end()) return false;
  UndoStack& stack = it->second;
  stack.dropEmpty(redo);
  if (redo ? !stack.canRedo() : !stack.canUndo()) return false;
  actor_ = undoTo_ = actor;
  begin(redo ? TxnKind::REDO : TxnKind::UNDO, redo ? stack.redoLabel() : stack.undoLabel());
  std::vector<Guid> sel;  // the actor's selection then: not the user's
  ReplayInfo info;
  auto applied = redo ? stack.redo(doc_, sel, &txn_.changes, &info) : stack.undo(doc_, sel, &txn_.changes, &info);
  replayPushed_ = info.pushed;
  for (size_t i = 0; i < applied.size(); i++) {
    noteChange(applied[i], NodeType::NONE);
    markLayout(applied[i], info.parentsBefore[i]);
  }
  events_.pages = true;
  std::vector<Guid> touched = txn_.changes.touched();
  commit();
  actor_ = undoTo_ = 0;
  events_.undo = true;
  if (!doc_.has(page_)) {
    auto all = pages();
    if (!all.empty()) setCurrentPage(all[0]);
  }
  followForeign(touched);
  return true;
}

Editor::ActorInfo Editor::actorInfo(uint32_t actor) const {
  ActorInfo info;
  const UndoStack* s = actor == 0 ? &undo_ : nullptr;
  if (!s) {
    auto it = actorUndo_.find(actor);
    if (it == actorUndo_.end()) return info;
    s = &it->second;
  }
  info.canUndo = s->canUndo();
  info.canRedo = s->canRedo();
  info.undoLabel = s->undoLabel();
  info.redoLabel = s->redoLabel();
  info.overwritten.assign(s->overwritten().begin(), s->overwritten().end());
  std::sort(info.overwritten.begin(), info.overwritten.end(), [](Guid a, Guid b) { return a.sessionID != b.sessionID ? a.sessionID < b.sessionID : a.localID < b.localID; });
  return info;
}

void Editor::forgetActor(uint32_t actor) {
  if (actor != 0 && !(scope_.on && (actor == actor_ || actor == undoTo_))) actorUndo_.erase(actor);
}

// ---- Keys -------------------------------------------------------------------

uint32_t Editor::key(KeyEvent type, KeyCode code, uint32_t /*codepoint*/, uint32_t mods, bool repeat) {
  flushQueuedMove();  // a coalesced move comes before the key
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
  // Simplify vector / Offset path open (editor/PathTools.cpp): Enter applies, Esc and ⌘Z cancel; the zoom keys are the
  // chrome's (its ZOOM_* commands run while the tool is open); other keys wait.
  if (pathTool_.kind != PathTool::NONE && !isModifierKey(code)) {
    mods_ = mods;
    const bool zoomKey = code == KeyCode::Equal || code == KeyCode::Minus || code == KeyCode::NumpadAdd || code == KeyCode::NumpadSubtract ||
                         (code == KeyCode::Digit0 && (primary || shift)) || ((code == KeyCode::Digit1 || code == KeyCode::Digit2) && shift && !primary);
    if (zoomKey) return 0;
    if (type == KeyEvent::DOWN && !repeat) {
      if (code == KeyCode::Enter || code == KeyCode::NumpadEnter) pathToolApply();
      else if (code == KeyCode::Escape) pathToolCancel();
      else if (code == KeyCode::KeyZ && primary && !shift) pathToolCancel();  // (the chrome never sees it: handled here)
    }
    return K_HANDLED;
  }
  // Z held (no modifiers): the zoom tool until it is let go (Figma).
  if (code == KeyCode::KeyZ && !(mods & (MOD_PRIMARY | MOD_CTRL | MOD_META | MOD_SHIFT)) && !viewer_) {
    mods_ = mods;
    if (type == KeyEvent::DOWN && !zoomHeld_ && gesture_ == Gesture::None) {
      zoomHeld_ = true;
      changeCursor((mods & MOD_ALT) ? CursorKind::ZOOM_OUT : CursorKind::ZOOM_IN);
    } else if (type == KeyEvent::UP && zoomHeld_) {
      zoomHeld_ = false;
      if (gesture_ == Gesture::None) updateCursor(lastScreen_);
    }
    return K_HANDLED;
  }
  if (isModifierKey(code)) {
    modifiers(mods);
    if (zoomHeld_ && gesture_ == Gesture::None) changeCursor((mods & MOD_ALT) ? CursorKind::ZOOM_OUT : CursorKind::ZOOM_IN);
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
      // The selected stop goes (one stays at least, as the picker's GradientControl minStops).
      const Paint* p = editedPaint();
      if (p && p->stops.size() > 1 && paint_.stop >= 0 && static_cast<size_t>(paint_.stop) < p->stops.size()) {
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
  // A selected ruler guide: ⌫ removes it, Esc lets it go (help.figma.com: "Select the guide and press delete").
  if (hasSelectedGuide() && gesture_ == Gesture::None) {
    if (code == KeyCode::Escape) {
      selectedGuide_ = {};
      needsRender_ = true;
      return K_HANDLED;
    }
    if ((code == KeyCode::Backspace || code == KeyCode::Delete) && !viewer_) return command(CommandId::REMOVE_GUIDE) == OK ? K_HANDLED : 0;
  }
  if (code == KeyCode::Escape) {
    if (gesture_ != Gesture::None) cancelGesture();
    else if (tool_ != Tool::MOVE) setTool(Tool::MOVE);
    else if (!selection_.empty()) changeSelection({});  // live Figma: Esc clears the selection (⇧Enter / \ go up)
    return K_HANDLED;
  }
  if (busy() || primary || (mods & MOD_ALT)) return 0;
  switch (code) {
    // Preferences › Nudge amount… (Small nudge 1, Big nudge 10 by default).
    case KeyCode::ArrowLeft: nudge(shift ? -nudgeBig_ : -nudgeSmall_, 0, repeat); return K_HANDLED;
    case KeyCode::ArrowRight: nudge(shift ? nudgeBig_ : nudgeSmall_, 0, repeat); return K_HANDLED;
    case KeyCode::ArrowUp: nudge(0, shift ? -nudgeBig_ : -nudgeSmall_, repeat); return K_HANDLED;
    case KeyCode::ArrowDown: nudge(0, shift ? nudgeBig_ : nudgeSmall_, repeat); return K_HANDLED;
    case KeyCode::Enter:
    case KeyCode::NumpadEnter:
      if (selection_.empty()) return 0;
      // Enter on one text layer edits it, all its text selected (Figma).
      if (!viewer_ && !shift && selection_.size() == 1 && doc_.get(selection_[0])->props.isTextLike() &&
          !doc_.get(selection_[0])->props.locked) {
        startTextEdit(selection_[0], true);
        return K_HANDLED;
      }
      // Enter on a vector or a shape: vector edit mode; on several of them (help.figma.com "Select one or more vector
      // layers and press Enter", round 12): all of them, for the Shape builder.
      if (!viewer_ && !shift && selection_.size() == 1 && startVectorEdit(selection_[0]) == OK) return K_HANDLED;
      if (!viewer_ && !shift && selection_.size() > 1) {
        bool shapes = true;
        for (Guid id : selection_) {
          const Node* n = doc_.get(id);
          shapes = shapes && n && (n->props.type == NodeType::VECTOR || n->props.type == NodeType::LINE || n->props.isRectLike() ||
                                   n->props.type == NodeType::ELLIPSE || n->props.type == NodeType::STAR ||
                                   n->props.type == NodeType::REGULAR_POLYGON);
        }
        if (shapes && startVectorEditMany(topSelectionInPaintOrder()) == OK) return K_HANDLED;
      }
      selectRelative(shift ? 1 : 0);
      return K_HANDLED;
    case KeyCode::Tab:
      if (selection_.empty()) return 0;
      selectRelative(shift ? 3 : 2);
      return K_HANDLED;
    case KeyCode::Backslash:
      // \ selects the parent, as ⇧Enter (live Figma).
      if (selection_.empty() || shift) return 0;
      selectRelative(1);
      return K_HANDLED;
    default: return 0;
  }
}

void Editor::modifiers(uint32_t mods) {
  flushQueuedMove();
  if (mods == mods_ && gesture_ == Gesture::None) return;
  uint32_t before = mods_;
  mods_ = mods;
  if (gesture_ == Gesture::Move || gesture_ == Gesture::Resize || gesture_ == Gesture::Rotate || gesture_ == Gesture::Draw ||
      gesture_ == Gesture::Marquee || gesture_ == Gesture::Vector || gesture_ == Gesture::Radius ||
      (gesture_ == Gesture::LayoutBar && layoutBarMoved_)) {
    if (before != mods) redrag(mods);
  } else if (gesture_ == Gesture::None) {
    updateHover(lastScreen_, mods);
  }
}

void Editor::blur() {
  queuedMove_.on = false;  // the gesture is cancelled: its last move with it
  cancelGesture();
  spaceHeld_ = false;
  zoomHeld_ = false;
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

void Editor::setViewOptions(uint32_t options) {
  if (options == viewOptions_) return;
  viewOptions_ = options;
  if (!rulersOn()) selectedGuide_ = hoverGuide_ = {};
  needsRender_ = true;
}

Status Editor::setTool(Tool t) {
  if (!toolImplemented(t)) return E_UNSUPPORTED;
  // "can view" people comment too (Figma: viewers' toolbar is Move, Hand, Comment; the comment UI is the editor's DOM).
  if (viewer_ && t != Tool::MOVE && t != Tool::HAND && t != Tool::COMMENT && !(devEdits_ && (t == Tool::ANNOTATION || t == Tool::MEASUREMENT))) return E_READONLY;
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

// ---- Undo history export / import (Message.localUndoStack 22 / localRedoStack 23) ----

std::string Editor::exportUndoHistory(size_t maxSteps, size_t maxBytes) const {
  // The newest steps first until the caps, then oldest first as the stacks keep them.
  auto take = [&](const std::vector<UndoBatch>& stack, size_t& budget) {
    std::vector<codec::UndoHistoryStep> out;
    for (auto it = stack.rbegin(); it != stack.rend() && out.size() < maxSteps; ++it) {
      codec::UndoHistoryStep step{std::vector<NodeChange>(it->inverse.begin(), it->inverse.end()), it->pageIds};
      size_t size = codec::writeMessage(sessionID_, step.changes).size();
      if (size > budget) break;
      budget -= size;
      out.push_back(std::move(step));
    }
    std::reverse(out.begin(), out.end());
    return out;
  };
  size_t budget = maxBytes;
  auto undo = take(undo_.undoBatches(), budget);
  auto redo = take(undo_.redoBatches(), budget);
  return codec::writeUndoHistory(sessionID_, undo, redo);
}

bool Editor::importUndoHistory(std::string_view bytes) {
  std::vector<codec::KiwiMessage> undo, redo;
  if (!codec::readUndoHistory(bytes, undo, redo)) return false;
  auto batches = [](std::vector<codec::KiwiMessage>& list) {
    std::vector<UndoBatch> out;
    for (codec::KiwiMessage& m : list) {
      UndoBatch b;
      for (NodeChange& c : m.changes) b.inverse.push_back(std::move(c));
      b.pageIds = std::move(m.undoBatchPageIds);
      if (!b.inverse.empty()) out.push_back(std::move(b));
    }
    return out;
  };
  if (!undo_.restore(batches(undo), batches(redo))) return false;
  events_.undo = true;
  return true;
}

}  // namespace eng

namespace eng {

// ---- Figma Motion (docs/motion.md §4.9, §5; round 8a) -----------------------------------------------------------------

Guid Editor::motionRoot() const {
  if (motion_.root != kNoGuid) return doc_.has(motion_.root) ? motion_.root : kNoGuid;
  for (Guid id : selection_) {
    Guid r = motionIndex_.rootOf(doc_, id);
    if (r != kNoGuid) return r;
  }
  return kNoGuid;
}

const motion::MotionIndex& Editor::motionIndex() {
  if (motionDirty_) {
    // The index reads base values: never while the layer's writes are in the nodes.
    bool was = motionLayer_.active();
    if (was) motionLayer_.restore(doc_);
    motionRebuild();
    if (was && motion_.on) motionApply();
  }
  return motionIndex_;
}

void Editor::motionRebuild() {
  motion::Resolver r;
  r.easing = [&](const VariableData& alias, Guid consumer, motion::EasingSpec& out) {
    Resolved v;
    if (!resolveValue(alias, consumer, v) || v.kind != Resolved::Kind::OTHER) return false;
    // The literal EASING VariableData's members (Variables.cpp): its value's easingValue is an EasingData.
    json::Value d;
    if (!json::parse("{" + v.raw + "}", d)) return false;
    const json::Value* val = d.get("value");
    const json::Value* e = val ? val->get("easingValue") : nullptr;
    return e && motion::decodeEasing(*e, out);
  };
  r.timing = [&](const VariableData& alias, Guid consumer, double& ms) {
    Resolved v;
    if (!resolveValue(alias, consumer, v) || v.kind != Resolved::Kind::FLOAT) return false;
    ms = v.f;
    return true;
  };
  motionIndex_.rebuild(doc_, &r);
  motionDirty_ = false;
  // The Motion icon's frames: the page's (and its sections') top-level frames whose timeline plays.
  std::vector<Guid> titled;
  doc_.forEach([&](const Node& n) {
    if (!n.guid.isDerived() && motionIndex_.plays(n.guid) && showsTitle(doc_, n.guid)) titled.push_back(n.guid);
  });
  if (titled != motionTitleRoots_) {
    motionTitleRoots_ = std::move(titled);
    needsRender_ = true;
  }
}

void Editor::motionApply() {
  if (txn_.open && !motionInTxn_) return;  // applied when the transaction commits
  if (motionDirty_) {
    if (motionLayer_.active()) motionLayer_.restore(doc_);
    motionRebuild();
  }
  Guid root = motionRoot();
  if (!motion_.on || root == kNoGuid) {
    if (motionLayer_.active()) motionLayer_.restore(doc_);
    needsRender_ = true;
    return;
  }
  // A root other than the one applied: its layers go back first.
  motionLayer_.restore(doc_);
  motion::MotionLayer::Hooks hooks;
  hooks.resolve = [&](Guid node, const VariableData& base, motion::KeyframeValue& out) {
    Resolved r;
    if (!resolveValue(base, node, r)) return false;
    if (r.kind == Resolved::Kind::FLOAT) out = motion::KeyframeValue::number(r.f);
    else if (r.kind == Resolved::Kind::COLOR) out = motion::KeyframeValue::color(r.c);
    else return false;
    return true;
  };
  // Round 8a, increment 2: instance sublayers play their main's tracks (docs/motion.md §4.3); layout-changing fields
  // lay out again as previews (§4.5, editor/MotionCommands.cpp).
  hooks.mainOf = [&](Guid id) { return mainOf(id); };
  hooks.sourceOf = [&](Guid id) {
    auto it = derivedInfo_.find(id);
    return it != derivedInfo_.end() ? it->second.source : kNoGuid;
  };
  hooks.relayout = [&](const std::vector<Guid>& dirty) { motionRelayout(dirty); };
  hooks.textLayout = [&](Guid id) { return textLayout(id); };  // round 8h: text stagger's elements
  motionLayer_.apply(doc_, motionIndex_, root, motion_.timeUs, hooks);
  needsRender_ = true;
}

void Editor::setMotion(const motion::State& s) {
  bool rootChanged = s.on != motion_.on || s.root != motion_.root;
  motion_ = s;
  if (rootChanged) events_.motion = true;
  if (!s.on && tool_ == Tool::ANCHOR_POINT) setTool(Tool::MOVE);  // Motion's own tool goes with it
  motionApply();
}

Status Editor::setMotionJson(const json::Value& v) {
  if (!v.isObject()) return E_INVALID;
  motion::State s = motion_;
  if (const json::Value* on = v.get("on"); on && on->isBool()) s.on = on->boolean;
  if (const json::Value* root = v.get("root")) {
    if (root->isNull()) s.root = kNoGuid;
    else if (root->isString()) {
      bool ok = false;
      Guid g = Guid::parse(root->string, &ok);
      if (!ok) return E_INVALID;
      s.root = g;
    }
  }
  if (const json::Value* t = v.get("timeUs"); t && t->isNumber()) s.timeUs = static_cast<int64_t>(std::llround(std::max(0.0, t->number)));
  if (const json::Value* a = v.get("autoKeyframe"); a && a->isBool()) s.autoKeyframe = a->boolean;
  if (const json::Value* p = v.get("showMotionPath"); p && p->isBool()) s.showMotionPath = p->boolean;
  if (const json::Value* in = v.get("inTransaction"); in && in->isBool()) motionInTxn_ = in->boolean && txn_.open;
  setMotion(s);
  return OK;
}

motion::Suspend Editor::motionSuspended() {
  return motion::Suspend(motionLayer_, doc_, [this] {
    if (motion_.on) motionApply();
  });
}

}  // namespace eng
