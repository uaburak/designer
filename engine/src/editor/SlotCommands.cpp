// Slots (help "Create and use slots", docs/research/figma/R4-components.md §15): Convert to slot (⌘⇧S) — a nested
// frame of a main becomes a slot (a new SLOT property bound to it); Wrap in new slot — the selection (texts, groups,
// instances, several layers) framed first, the frame converted; Delete contents — a slot of an instance emptied (its
// content diverges from the main's), or a main's slot frame emptied.

#include <algorithm>
#include <map>

#include "editor/Editor.h"

namespace eng {

bool Editor::canBecomeSlot(Guid id) const {
  if (id.isDerived()) return false;
  const Node* n = doc_.get(id);
  // A frame (not a group, a set or the component itself) inside a main, not a grid (the plugin API refuses those),
  // not a slot already.
  if (!n || n->props.type != NodeType::FRAME || n->props.resizeToFit || n->props.comp().isStateGroup || n->props.comp().isSlot) return false;
  if (n->props.comp().isSlotContent || n->props.stack().stackMode == StackMode::GRID) return false;
  return propOwner(id) != kNoGuid && !isLibraryCopy(id);
}

bool Editor::canWrapInSlot() const {
  if (selection_.empty()) return false;
  Guid parent = kNoGuid;
  for (Guid s : selection_) {
    if (s.isDerived() || isLibraryCopy(s)) return false;
    const Node* n = doc_.get(s);
    if (!n || n->props.type == NodeType::SYMBOL || n->props.isComponentSet() || propOwner(s) == kNoGuid) return false;
    Guid p = doc_.parentOf(s);
    if (parent != kNoGuid && p != parent) return false;
    parent = p;
  }
  return true;
}

Status Editor::convertToSlot(std::vector<Guid> ids) {
  ids.erase(std::remove_if(ids.begin(), ids.end(), [&](Guid g) { return !canBecomeSlot(g); }), ids.end());
  if (ids.empty()) return E_INVALID;
  // One SLOT property per component (or set: the same frame in several variants is one slot, multi-edit).
  std::map<Guid, std::vector<Guid>> byOwner;
  for (Guid g : ids) byOwner[propOwner(g)].push_back(g);
  begin(TxnKind::USER, "Convert to slot");
  for (auto& [owner, frames] : byOwner) {
    std::string name = "Slot";
    for (int i = 2; findDef(owner, name); i++) name = "Slot " + std::to_string(i);
    json::Writer w;
    w.beginObject().key("type").string("SLOT").key("name").string(name).endObject();
    CommandArgs a;
    json::parse(w.str(), a.raw);
    if (addComponentProperty(frames[0], a) != OK) continue;
    const ComponentPropDef* d = findDef(owner, name);
    if (d) bindComponentProperty(frames, "SLOT_CONTENT_ID", d->id.toString());
  }
  commit();
  return OK;
}

Status Editor::wrapInNewSlot() {
  if (!canWrapInSlot()) return E_INVALID;
  begin(TxnKind::USER, "Wrap in new slot");
  Guid frame = wrapSelection("Frame");
  if (frame != kNoGuid) {
    // The wrapper shows no fill of its own (a slot is a content area).
    NodeChange c = NodeChange::changed(frame);
    c.mask = F_FILLS | F_NAME;
    c.props.fillPaints.clear();
    c.props.name = "Slot";
    write(c);
    convertToSlot({frame});
    changeSelection({frame});
  }
  commit();
  return frame != kNoGuid ? OK : E_INVALID;
}

Status Editor::clearSlot(Guid ref) {
  if (ref == kNoGuid) return E_INVALID;
  Guid content = kNoGuid;
  const Node* n = doc_.get(ref);
  if (!n) return E_INVALID;
  if (ref.isDerived()) {
    if (!acceptsChildren(ref)) return E_INVALID;
  } else {
    if (!(n->props.comp().isSlot || n->props.comp().isSlotContent)) return E_INVALID;
    content = ref;
  }
  begin(TxnKind::USER, "Delete contents");
  if (content == kNoGuid) content = slotContentFor(ref, true);
  if (content == kNoGuid) {
    commit();
    return E_INVALID;
  }
  std::vector<Guid> order;
  auto collect = [&](auto&& self, Guid id) -> void {
    for (Guid c : std::vector<Guid>(doc_.children(id)))
      if (!c.isDerived()) self(self, c);
    order.push_back(id);
  };
  for (Guid c : std::vector<Guid>(doc_.children(content)))
    if (!c.isDerived()) collect(collect, c);
  for (Guid id : order) write(NodeChange::removed(id));
  commit();
  return OK;
}

uint32_t Editor::slotCommandState(CommandId id) const {
  switch (id) {
    case CommandId::CONVERT_TO_SLOT: {
      bool any = false;
      for (Guid s : selection_) {
        if (!canBecomeSlot(s)) return 0;
        any = true;
      }
      return any ? CMD_ENABLED : 0;
    }
    case CommandId::WRAP_IN_NEW_SLOT: return canWrapInSlot() ? CMD_ENABLED : 0;
    case CommandId::CLEAR_SLOT: return !selection_.empty() ? CMD_ENABLED : 0;
    default: return 0;
  }
}

Status Editor::slotCommand(CommandId id, const CommandArgs& args) {
  std::vector<Guid> refs;
  if (const json::Value* r = args.raw.isObject() ? args.raw.get("ref") : nullptr) {
    auto take = [&](const json::Value& e) {
      bool ok = false;
      Guid g = e.isString() ? Guid::parse(e.string, &ok) : Guid{};
      if (ok) refs.push_back(g);
    };
    if (r->isArray())
      for (auto& e : r->array) take(e);
    else
      take(*r);
  }
  switch (id) {
    case CommandId::CONVERT_TO_SLOT: return convertToSlot(refs.empty() ? selection_ : refs);
    case CommandId::WRAP_IN_NEW_SLOT: return wrapInNewSlot();
    case CommandId::CLEAR_SLOT: return clearSlot(refs.empty() ? (selection_.empty() ? kNoGuid : selection_[0]) : refs[0]);
    default: return E_UNSUPPORTED;
  }
}

}  // namespace eng
