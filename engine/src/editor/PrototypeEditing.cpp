// Prototype mode on the canvas (docs/research/figma/R8-prototyping.md §6): connections drawn from hotspots to their
// destinations (round 16: from / to the middle of any side), the connection nub on each selected layer's side nearest
// the pointer, flow starting point labels; dragging a nub to a frame adds an interaction (On click → Navigate to,
// Instant: Figma's defaults for a new connection — one per selected hotspot), dragging a noodle's end to another frame retargets it, to empty canvas removes it. The
// first connection out of a frame no flow reaches gives that frame a flow starting point ("Flow 1", …).
//
// The interactions stay the schema's JSON while they are edited, so every field the engine doesn't read survives.

#include <algorithm>
#include <cmath>
#include <functional>
#include <unordered_set>

#include "base/FractionalIndex.h"
#include "editor/Editor.h"
#include "hit/HitTest.h"
#include "proto/Prototype.h"
#include "scene/CodecKiwi.h"

namespace eng {

namespace {

constexpr double kHandleHit = 8;  // CSS px around a handle / a noodle's end
constexpr double kNoodleDrag = 3;
constexpr double kLineHit = 4;  // CSS px either side of a connection's line (round 17)

json::Value interactionsJson(const NodeProps& p) {
  json::Value v;
  v.kind = json::Value::Kind::Array;
  auto it = p.extra.find("prototypeInteractions");
  if (it == p.extra.end() || it->second.empty()) return v;
  json::Value parsed;
  if (json::parse(codec::extraValueToJson("NodeChange", it->second), parsed) && parsed.isArray()) return parsed;
  return v;
}

json::Value* member(json::Value& v, const char* key) {
  for (auto& [k, x] : v.object)
    if (k == key) return &x;
  return nullptr;
}

json::Value guidJson(Guid g) {
  json::Value v;
  v.kind = json::Value::Kind::Object;
  json::Value s, l;
  s.kind = l.kind = json::Value::Kind::Number;
  s.number = g.sessionID;
  l.number = g.localID;
  v.object.emplace_back("sessionID", s);
  v.object.emplace_back("localID", l);
  return v;
}

// The action at `path` (action, branch, action, …) of an interaction's JSON.
json::Value* actionAt(json::Value& interaction, const std::vector<size_t>& path) {
  json::Value* list = member(interaction, "actions");
  json::Value* a = nullptr;
  for (size_t i = 0; i < path.size(); i++) {
    if (!list || !list->isArray() || path[i] >= list->array.size()) return nullptr;
    a = &list->array[path[i]];
    if (i + 1 == path.size()) return a;
    json::Value* branches = member(*a, "conditionalActions");
    if (!branches || !branches->isArray() || ++i >= path.size() || path[i] >= branches->array.size()) return nullptr;
    list = member(branches->array[path[i]], "actions");
  }
  return a;
}

}  // namespace

void Editor::setPrototypeMode(bool on) {
  if (proto_.on == on) return;
  proto_.on = on;
  proto_.drag = ProtoSession::Drag::None;
  proto_.target = kNoGuid;
  proto_.handleHovered = false;
  proto_.hoveredNub = kNoGuid;
  proto_.version = ~0ull;
  needsRender_ = true;
}

const std::vector<Editor::ProtoLink>& Editor::protoLinks() {
  if (proto_.version == doc_.version() && proto_.page == page_) return proto_.links;
  proto_.version = doc_.version();
  proto_.page = page_;
  proto_.links.clear();
  std::function<void(Guid)> walk = [&](Guid id) {
    const Node* n = doc_.get(id);
    if (!n) return;
    if (n->props.type != NodeType::CANVAS && proto::hasInteractions(n->props)) {
      auto list = proto::interactions(n->props);
      for (size_t i = 0; i < list.size(); i++) {
        std::function<void(const std::vector<proto::Action>&, std::vector<size_t>)> actions = [&](const std::vector<proto::Action>& acts,
                                                                                                  std::vector<size_t> prefix) {
          for (size_t k = 0; k < acts.size(); k++) {
            std::vector<size_t> path = prefix;
            path.push_back(k);
            const proto::Action& a = acts[k];
            if (a.connection == proto::Connection::INTERNAL_NODE && a.dest != kNoGuid && doc_.has(a.dest))
              proto_.links.push_back({id, list[i].id, i, path, a.dest, false});
            if (a.connection == proto::Connection::UPDATE_MEDIA_RUNTIME && a.dest != kNoGuid && doc_.has(a.dest))
              proto_.links.push_back({id, list[i].id, i, path, a.dest, true});
            for (size_t b = 0; b < a.branches.size(); b++) {
              std::vector<size_t> sub = path;
              sub.push_back(b);
              actions(a.branches[b].actions, sub);
            }
          }
        };
        actions(list[i].actions, {});
      }
    }
    // Instances' sublayers carry their main's interactions: the main's connections stand for them.
    if (n->props.type == NodeType::INSTANCE) return;
    for (Guid c : doc_.children(id)) walk(c);
  };
  if (page_ != kNoGuid) walk(page_);
  return proto_.links;
}

std::vector<Guid> Editor::protoHandleNodes() const {
  std::vector<Guid> out;
  if (selection_.size() > 64) return out;
  for (Guid id : selection_) {
    const Node* n = doc_.get(id);
    if (!n || n->props.type == NodeType::CANVAS || n->props.type == NodeType::SECTION || !doc_.visibleInTree(id)) continue;
    out.push_back(id);
  }
  return out;
}

bool Editor::protoHandleAt(Vec2 s, std::vector<Guid>* nodes, Guid* hit, NoodleSide* side) const {
  // Round 16: each hotspot's nub sits on its side nearest the pointer — the side nearest `s` itself.
  Vec2 w = camera_.toWorld(s);
  for (Guid id : protoHandleNodes()) {
    Rect b = doc_.worldBounds(id);
    NoodleSide sd = nearestSide(b, w);
    Vec2 c = camera_.toScreen(sideCentre(b, sd));
    if ((c - s).length() <= kHandleHit) {
      if (nodes) *nodes = protoHandleNodes();
      if (hit) *hit = id;
      if (side) *side = sd;
      return true;
    }
  }
  return false;
}

bool Editor::protoEndAt(Vec2 s, ProtoLink& out) {
  for (const ProtoLink& l : protoLinks()) {
    bool sel = protoSelected(l);
    for (Guid g : selection_) sel |= g == l.source || doc_.isAncestor(g, l.source);
    if (!sel) continue;
    if ((protoCurve(l).b - s).length() <= kHandleHit) {
      out = l;
      return true;
    }
  }
  return false;
}

bool Editor::protoStartAt(Vec2 s, ProtoLink& out) {
  for (const ProtoLink& l : protoLinks())
    if (proto_.selClicked && protoSelected(l) && (protoCurve(l).a - s).length() <= kHandleHit) {
      out = l;
      return true;
    }
  return false;
}

NoodleCurve Editor::protoCurve(const ProtoLink& l) const {
  const Mat2x3 view = camera_.matrix();
  auto screen = [&](const Rect& r) { return transformedBounds(view * Mat2x3::translate(r.x, r.y), r.w, r.h); };
  return prototypeNoodle(screen(doc_.worldBounds(l.source)), screen(doc_.worldBounds(l.dest)), false, {});
}

std::string Editor::protoLabel(const ProtoLink& l) const {
  const Node* n = doc_.get(l.source);
  if (!n) return {};
  auto list = proto::interactions(n->props);
  if (l.index >= list.size()) return {};
  // The panel's trigger names (model/prototype.ts TRIGGERS); On click has no label on the canvas (61.png).
  switch (list[l.index].trigger) {
    case proto::Trigger::ON_CLICK: return {};
    case proto::Trigger::DRAG: return "On drag";
    case proto::Trigger::ON_HOVER: return "While hovering";
    case proto::Trigger::ON_PRESS: return "While pressing";
    case proto::Trigger::ON_KEY_DOWN: return "Key/Gamepad";
    case proto::Trigger::MOUSE_IN:
    case proto::Trigger::MOUSE_ENTER: return "Mouse enter";
    case proto::Trigger::MOUSE_OUT:
    case proto::Trigger::MOUSE_LEAVE: return "Mouse leave";
    case proto::Trigger::MOUSE_DOWN: return "Mouse down";
    case proto::Trigger::MOUSE_UP: return "Mouse up";
    case proto::Trigger::AFTER_TIMEOUT: return "After delay";
    case proto::Trigger::ON_MEDIA_HIT: return "When video hits";
    case proto::Trigger::ON_MEDIA_END: return "When video ends";
    default: return {};
  }
}

bool Editor::protoSelected(const ProtoLink& l) const {
  if (proto_.selNode == kNoGuid || l.source != proto_.selNode || proto_.selIndex != static_cast<int>(l.index)) return false;
  return std::find(selection_.begin(), selection_.end(), l.source) != selection_.end();
}

void Editor::setPrototypeSelection(Guid node, int index) {
  if (index < 0) node = kNoGuid;
  if (node == kNoGuid) index = -1;
  if (proto_.selNode == node && proto_.selIndex == index) return;
  proto_.selNode = node;
  proto_.selIndex = index;
  proto_.selClicked = false;
  needsRender_ = true;
}

bool Editor::protoLineAt(Vec2 s, ProtoLink& out, Rect* label) {
  const OverlayStyle style = OverlayStyle::of(theme_);
  const auto& links = protoLinks();
  // The labels first (drawn over the lines), the selected connection's before the others; then the nearest line.
  for (int pass = 0; pass < 2; pass++)
    for (auto it = links.rbegin(); it != links.rend(); ++it) {
      if (protoSelected(*it) != (pass == 0)) continue;
      std::string text = protoLabel(*it);
      if (text.empty()) continue;
      Rect box = noodleLabelBox(noodlePoint(protoCurve(*it), 0.5), labelWidth(text, false), style.noodleLabelHeight, style.noodleLabelPadding);
      if (box.contains(s)) {
        out = *it;
        if (label) *label = box;
        return true;
      }
    }
  double best = kLineHit;
  bool found = false;
  for (auto it = links.rbegin(); it != links.rend(); ++it) {
    double d = noodleDistance(protoCurve(*it), s);
    if (d < best || (!found && d <= best)) {
      best = d;
      out = *it;
      found = true;
    }
  }
  // On the line: the details open under the press (live Figma 2026-10-10: the popover's arrow at the clicked point).
  if (found && label) *label = Rect{s.x, s.y, 0, 0};
  return found;
}

namespace {
// The page's top-level frames (and those in sections) — where Navigate to goes.
Guid topFrameIn(const Document& doc, Guid parent, Vec2 world) {
  const auto& kids = doc.children(parent);
  for (auto it = kids.rbegin(); it != kids.rend(); ++it) {
    const Node* n = doc.get(*it);
    if (!n || !n->props.visible || !doc.worldBounds(*it).contains(world)) continue;
    if (n->props.type == NodeType::SECTION) return topFrameIn(doc, *it, world);  // in a section, or its own area
    if (n->props.isFrameLike() || n->props.isComponentSet()) return *it;
  }
  return kNoGuid;
}
}  // namespace

Guid Editor::protoTargetAt(Vec2 world, const std::vector<Guid>& sources, bool videos, bool frames, proto::Navigation* nav) const {
  if (nav) *nav = proto::Navigation::NAVIGATE;
  Guid top = topFrameIn(doc_, page_, world);
  if (top == kNoGuid) return kNoGuid;
  if (videos) {
    // The topmost video layer under the point, inside this frame.
    Guid found = kNoGuid;
    std::function<void(Guid)> walk = [&](Guid id) {
      const Node* x = doc_.get(id);
      if (!x || !x->props.visible || found != kNoGuid) return;
      const auto& ch = doc_.children(id);
      for (auto c = ch.rbegin(); c != ch.rend() && found == kNoGuid; ++c) walk(*c);
      if (found == kNoGuid && proto::videoFill(x->props) >= 0 && doc_.worldBounds(id).contains(world)) found = id;
    };
    walk(top);
    bool self = false;
    for (Guid s : sources) self |= s == found;
    if (found != kNoGuid && !self) return found;
  }
  if (!frames) return kNoGuid;
  // Round 17 — interactive components (help "Create interactive components": "drag it to the destination variant";
  // "You can only create interactive components using variants from the same component set"): from a variant, or a
  // layer in one, the hovered variant of the same set is the destination (Change to), never the set itself; its own
  // variant or the set's background: nothing.
  for (Guid s : sources) {
    Guid variant = kNoGuid, set = kNoGuid;
    for (Guid a = s; a != kNoGuid && a != page_; a = doc_.parentOf(a)) {
      const Node* pn = doc_.get(doc_.parentOf(a));
      if (pn && pn->props.isComponentSet()) {
        variant = a;
        set = doc_.parentOf(a);
        break;
      }
    }
    if (set == kNoGuid || !doc_.worldBounds(set).contains(world)) continue;
    const auto& kids = doc_.children(set);
    for (auto it = kids.rbegin(); it != kids.rend(); ++it) {
      const Node* v = doc_.get(*it);
      if (!v || !v->props.visible || !doc_.worldBounds(*it).contains(world)) continue;
      if (*it == variant || v->props.type != NodeType::SYMBOL) return kNoGuid;
      if (nav) *nav = proto::Navigation::SWAP_STATE;
      return *it;
    }
    return kNoGuid;
  }
  // A layer in the hotspot's own top-level frame (R8 §4: Scroll to — "drag a noodle for any object"): the innermost
  // under the point that isn't the hotspot, one of its layers or one holding it.
  auto topOf = [&](Guid id) {
    while (doc_.parentOf(id) != kNoGuid && doc_.parentOf(id) != page_) {
      const Node* p = doc_.get(doc_.parentOf(id));
      if (p && p->props.type == NodeType::SECTION) break;
      id = doc_.parentOf(id);
    }
    return id;
  };
  bool inside = false;
  for (Guid s : sources) inside |= s != top && topOf(s) == top;
  if (inside) {
    std::vector<Guid> path = hitPath(doc_, page_, world, pixel());
    if (std::find(path.begin(), path.end(), top) != path.end())
      for (auto it = path.rbegin(); it != path.rend() && *it != top; ++it) {
        bool related = false;
        for (Guid s : sources) related |= *it == s || doc_.isAncestor(*it, s) || doc_.isAncestor(s, *it);
        if (related) continue;
        if (nav) *nav = proto::Navigation::SCROLL_TO;
        return *it;
      }
  }
  for (Guid s : sources)
    if (s == top) return kNoGuid;  // not onto itself
  return top;
}

Guid Editor::protoSourceAt(Vec2 world, Guid dest) const {
  std::vector<Guid> path = hitPath(doc_, page_, world, pixel());
  for (auto it = path.rbegin(); it != path.rend(); ++it) {
    const Node* n = doc_.get(*it);
    if (!n || *it == dest || n->props.type == NodeType::SECTION || isLibraryCopy(*it)) continue;
    return *it;
  }
  return kNoGuid;
}

uint32_t Editor::protoPointerDown(Vec2 s, uint32_t /*mods*/) {
  std::vector<Guid> sources;
  ProtoLink link;
  Rect label;
  if (viewer_) return 0;
  if (protoStartAt(s, link)) {
    // Round 17: the selected connection's start dot — dragged to another layer, the interaction moves there.
    proto_.drag = ProtoSession::Drag::MoveStart;
    proto_.link = link;
    proto_.sources = {link.source};
  } else if (protoEndAt(s, link)) {
    proto_.drag = ProtoSession::Drag::Retarget;
    proto_.link = link;
    proto_.sources = {link.source};
  } else if (protoHandleAt(s, &sources)) {
    proto_.drag = ProtoSession::Drag::New;
    proto_.sources = sources;
    // Each new connection leaves from the side its nub is on (the side nearest the press).
    proto_.sourceSides.clear();
    for (Guid src : sources) proto_.sourceSides.push_back(nearestSide(doc_.worldBounds(src), camera_.toWorld(s)));
  } else if (protoLineAt(s, link, &label)) {
    // Round 17: on a connection's line or label — a click selects it (Interaction details), a drag moves its end.
    proto_.drag = ProtoSession::Drag::Line;
    proto_.link = link;
    proto_.sources = {link.source};
    proto_.labelAt = {label.x, label.y};
    proto_.labelW = label.w;
    proto_.labelH = label.h;
  } else {
    return 0;
  }
  proto_.point = camera_.toWorld(s);
  switch (proto_.drag) {
    case ProtoSession::Drag::Retarget: proto_.target = link.dest; break;
    case ProtoSession::Drag::MoveStart: proto_.target = link.source; break;
    default: proto_.target = kNoGuid;
  }
  proto_.targetNav = proto::Navigation::NAVIGATE;
  gesture_ = Gesture::Noodle;
  changeCursor(CursorKind::DEFAULT);
  needsRender_ = true;
  return P_HANDLED | P_CAPTURE;
}

void Editor::protoPointerMove(Vec2 s) {
  proto_.point = camera_.toWorld(s);
  bool moved = (s - downScreen_).length() >= kNoodleDrag;
  if (proto_.drag == ProtoSession::Drag::Line) {
    if (!moved) return;
    proto_.drag = ProtoSession::Drag::Retarget;  // a drag on the line moves its end
  }
  if (proto_.drag == ProtoSession::Drag::MoveStart) {
    if (moved) proto_.target = protoSourceAt(proto_.point, proto_.link.dest);
    needsRender_ = true;
    return;
  }
  bool media = proto_.drag == ProtoSession::Drag::Retarget && proto_.link.media;
  if (moved || proto_.drag == ProtoSession::Drag::New)
    proto_.target = protoTargetAt(proto_.point, proto_.sources, proto_.drag == ProtoSession::Drag::New || media, !media, &proto_.targetNav);
  needsRender_ = true;
}

void Editor::protoHover(Vec2 s) {
  Guid hit = kNoGuid;
  bool on = protoHandleAt(s, nullptr, &hit);
  ProtoLink l;
  bool end = !on && protoEndAt(s, l);
  if (on != proto_.handleHovered || hit != proto_.hoveredNub) {
    proto_.handleHovered = on;
    proto_.hoveredNub = hit;
    needsRender_ = true;
  }
  // The nubs follow the pointer from side to side (round 16): a frame when one changes sides.
  std::vector<Guid> nodes = protoHandleNodes();
  if (!nodes.empty()) {
    Vec2 w = camera_.toWorld(s), was = camera_.toWorld(proto_.pointer);
    for (Guid id : nodes) {
      Rect b = doc_.worldBounds(id);
      if (!proto_.hasPointer || nearestSide(b, w) != nearestSide(b, was)) {
        needsRender_ = true;
        break;
      }
    }
  }
  proto_.hasPointer = true;
  proto_.pointer = s;
  if (on || end) changeCursor(CursorKind::DEFAULT);
}

namespace {
bool deleted(const json::Value& v) {
  const json::Value* d = v.get("isDeleted");
  return d && d->kind == json::Value::Kind::Bool && d->boolean;
}

// The interaction's place in the field's JSON: by its id, else its index among the live (not deleted) ones.
size_t rawIndex(const json::Value& list, Guid id, size_t live) {
  if (id != kNoGuid)
    for (size_t i = 0; i < list.array.size(); i++) {
      const json::Value* v = list.array[i].get("id");
      if (!v) continue;
      Guid g{static_cast<uint32_t>(v->get("sessionID") ? v->get("sessionID")->numberOr(0) : 0),
             static_cast<uint32_t>(v->get("localID") ? v->get("localID")->numberOr(0) : 0)};
      if (g == id) return i;
    }
  size_t k = 0;
  for (size_t i = 0; i < list.array.size(); i++) {
    if (deleted(list.array[i])) continue;
    if (k++ == live) return i;
  }
  return list.array.size();
}

size_t liveCount(const json::Value& list) {
  size_t k = 0;
  for (const json::Value& v : list.array) k += deleted(v) ? 0 : 1;
  return k;
}

json::Value stringJson(const char* s) {
  json::Value v;
  v.kind = json::Value::Kind::String;
  v.string = s;
  return v;
}
}  // namespace

void Editor::protoSelectLink(const ProtoLink& l, const Rect* label) {
  setSelection({l.source});
  proto_.selNode = l.source;
  proto_.selIndex = static_cast<int>(l.index);
  proto_.selClicked = true;
  PrototypeSelected e;
  e.node = l.source;
  e.index = static_cast<int>(l.index);
  Rect box;
  if (label) {
    box = *label;
  } else {
    const OverlayStyle style = OverlayStyle::of(theme_);
    Vec2 mid = noodlePoint(protoCurve(l), 0.5);
    std::string text = protoLabel(l);
    box = text.empty() ? Rect{mid.x, mid.y, 0, 0} : noodleLabelBox(mid, labelWidth(text, false), style.noodleLabelHeight, style.noodleLabelPadding);
  }
  e.x = box.x, e.y = box.y, e.w = box.w, e.h = box.h;
  events_.prototypeSelected.push_back(e);
  needsRender_ = true;
}

void Editor::protoPointerUp(Vec2 s) {
  proto_.point = camera_.toWorld(s);
  bool moved = (s - downScreen_).length() >= kNoodleDrag;
  ProtoSession::Drag drag = proto_.drag;
  bool media = drag == ProtoSession::Drag::Retarget && proto_.link.media;
  proto::Navigation nav = proto::Navigation::NAVIGATE;
  Guid target = drag == ProtoSession::Drag::MoveStart ? protoSourceAt(proto_.point, proto_.link.dest)
                                                      : protoTargetAt(proto_.point, proto_.sources, drag == ProtoSession::Drag::New || media, !media, &nav);
  proto_.drag = ProtoSession::Drag::None;
  proto_.target = kNoGuid;
  needsRender_ = true;
  if (drag == ProtoSession::Drag::Line) {
    // A click on the line or its label: the connection is selected — its hotspot too — and its details open.
    Rect box{proto_.labelAt.x, proto_.labelAt.y, proto_.labelW, proto_.labelH};
    protoSelectLink(proto_.link, &box);
    return;
  }
  if (drag == ProtoSession::Drag::Retarget || drag == ProtoSession::Drag::MoveStart) {
    if (!moved) return;
    const Node* n = doc_.get(proto_.link.source);
    if (!n) return;
    json::Value list = interactionsJson(n->props);
    size_t index = rawIndex(list, proto_.link.interaction, proto_.link.index);
    if (index >= list.array.size()) return;
    bool wasSelected = protoSelected(proto_.link);
    json::Value& interaction = list.array[index];
    if (drag == ProtoSession::Drag::MoveStart && target != kNoGuid) {
      // The start onto another layer: the interaction moves there (all of it).
      if (target == proto_.link.source) return;
      const Node* tn = doc_.get(target);
      if (!tn || isLibraryCopy(proto_.link.source)) return;
      json::Value moving = interaction;
      list.array.erase(list.array.begin() + static_cast<long>(index));
      json::Value into = interactionsJson(tn->props);
      size_t live = liveCount(into);
      into.array.push_back(std::move(moving));
      begin(TxnKind::USER, "Edit interaction");
      NodeChange c = NodeChange::changed(proto_.link.source);
      c.mask = F_EXTRA;
      c.props.extra["prototypeInteractions"] = list.array.empty() ? std::string() : proto::encodeField("prototypeInteractions", list);
      write(c);
      NodeChange t = NodeChange::changed(target);
      t.mask = F_EXTRA;
      t.props.extra["prototypeInteractions"] = proto::encodeField("prototypeInteractions", into);
      write(t);
      commit();
      if (wasSelected) {
        ProtoLink now = proto_.link;
        now.source = target;
        now.index = live;
        protoSelectLink(now, nullptr);
      }
      return;
    }
    if (target != kNoGuid) {
      if (target == proto_.link.dest) return;
      json::Value* a = actionAt(interaction, proto_.link.action);
      if (!a) return;
      if (json::Value* d = member(*a, "transitionNodeID")) *d = guidJson(target);
      else a->object.emplace_back("transitionNodeID", guidJson(target));
      // Onto another variant: Change to; a layer in its own frame: Scroll to; a frame: Navigate to (an overlay or a
      // swap stays one).
      if (!media) {
        json::Value* type = member(*a, "navigationType");
        std::string was = type && type->kind == json::Value::Kind::String ? type->string : "NAVIGATE";
        bool keep = nav == proto::Navigation::NAVIGATE && (was == "OVERLAY" || was == "SWAP");
        const char* name = nav == proto::Navigation::SWAP_STATE ? "SWAP_STATE" : nav == proto::Navigation::SCROLL_TO ? "SCROLL_TO" : "NAVIGATE";
        if (!keep) {
          if (type) *type = stringJson(name);
          else a->object.emplace_back("navigationType", stringJson(name));
        }
      }
      begin(TxnKind::USER, "Edit interaction");
    } else {
      // Dropped on empty canvas (help: "To delete a connection, click and drag on either end"): the connection goes
      // (its interaction too, when it was its only action).
      json::Value* actions = member(interaction, "actions");
      if (proto_.link.action.size() == 1 && actions && actions->isArray() && proto_.link.action[0] < actions->array.size()) {
        actions->array.erase(actions->array.begin() + static_cast<long>(proto_.link.action[0]));
        if (actions->array.empty()) list.array.erase(list.array.begin() + static_cast<long>(index));
      } else if (json::Value* a = actionAt(interaction, proto_.link.action)) {
        // Inside a Conditional: the action stays, without a destination.
        a->object.erase(std::remove_if(a->object.begin(), a->object.end(), [](auto& kv) { return kv.first == "transitionNodeID"; }),
                        a->object.end());
      }
      begin(TxnKind::USER, "Remove interaction");
      if (wasSelected) {
        proto_.selNode = kNoGuid;
        proto_.selIndex = -1;
        PrototypeSelected e;
        e.node = proto_.link.source;  // index −1: nothing open
        events_.prototypeSelected.push_back(e);
      }
    }
    NodeChange c = NodeChange::changed(proto_.link.source);
    c.mask = F_EXTRA;
    c.props.extra["prototypeInteractions"] = list.array.empty() ? std::string() : proto::encodeField("prototypeInteractions", list);
    write(c);
    commit();
    return;
  }
  if (drag != ProtoSession::Drag::New || target == kNoGuid) return;
  begin(TxnKind::USER, "Add interaction");
  PrototypeConnected made;
  for (Guid src : proto_.sources) {
    const Node* n = doc_.get(src);
    if (!n || isLibraryCopy(src)) continue;
    json::Value list = interactionsJson(n->props);
    Guid id = newGuid();
    proto::Interaction ix = proto::newConnection(id, target);
    ix.actions[0].navigation = nav;  // Change to between variants, Scroll to inside its frame (round 17)
    // The trigger: the first the hotspot doesn't use yet (round 17, live Figma 2026-10-10: a layer's connections
    // made one after another came out On click, On drag, While hovering; the order past that is unverified).
    {
      const proto::Trigger order[] = {proto::Trigger::ON_CLICK,    proto::Trigger::DRAG,        proto::Trigger::ON_HOVER,
                                      proto::Trigger::ON_PRESS,    proto::Trigger::MOUSE_ENTER, proto::Trigger::MOUSE_LEAVE,
                                      proto::Trigger::MOUSE_DOWN,  proto::Trigger::MOUSE_UP};
      auto existing = proto::interactions(n->props);
      for (proto::Trigger t : order) {
        bool used = false;
        for (const proto::Interaction& x : existing) used |= x.trigger == t;
        if (!used) {
          ix.trigger = t;
          break;
        }
      }
    }
    if (const Node* tn = doc_.get(target); tn && proto::videoFill(tn->props) >= 0 && doc_.parentOf(target) != page_) {
      // Onto a video: On click → Play/pause video › Play video (unverified: the action Figma picks first).
      proto::Action& a = ix.actions[0];
      a.connection = proto::Connection::UPDATE_MEDIA_RUNTIME;
      a.media = proto::MediaAction::PLAY;
    }
    list.array.push_back(proto::toJson(ix));
    NodeChange c = NodeChange::changed(src);
    c.mask = F_EXTRA;
    c.props.extra["prototypeInteractions"] = proto::encodeField("prototypeInteractions", list);
    write(c);
    made.nodes.push_back(src);
    made.interaction = id;
  }
  // A flow starting point for the frame the connection leaves, when no flow reaches it yet (R8 §6) — not for Change
  // to or Scroll to, which stay inside their set / frame.
  if (!made.nodes.empty() && nav == proto::Navigation::NAVIGATE) {
    Guid top = made.nodes[0];
    while (doc_.parentOf(top) != kNoGuid && doc_.parentOf(top) != page_) top = doc_.parentOf(top);
    const Node* tn = doc_.get(top);
    auto flows = proto::flows(doc_, page_);
    bool reached = false;
    for (auto& f : flows) reached |= f.node == top;
    if (!reached && tn && tn->props.isFrameLike()) {
      // Reachable from a flow's start through its navigations?
      std::unordered_set<Guid, GuidHash> seen;
      std::vector<Guid> queue;
      for (auto& f : flows) queue.push_back(f.node), seen.insert(f.node);
      std::function<void(Guid, std::vector<Guid>&)> dests = [&](Guid id, std::vector<Guid>& out) {
        const Node* x = doc_.get(id);
        if (!x) return;
        if (proto::hasInteractions(x->props))
          for (auto& i : proto::interactions(x->props))
            for (auto& a : i.actions) {
              std::vector<std::pair<proto::Navigation, Guid>> d;
              proto::destinations(a, d);
              for (auto& [nav, g] : d) out.push_back(g);
            }
        for (Guid ch : doc_.children(id)) dests(ch, out);
      };
      for (size_t i = 0; i < queue.size() && !reached; i++) {
        std::vector<Guid> out;
        dests(queue[i], out);
        for (Guid g : out) {
          Guid t = g;
          while (doc_.parentOf(t) != kNoGuid && doc_.parentOf(t) != page_) t = doc_.parentOf(t);
          if (t == top) reached = true;
          if (seen.insert(t).second) queue.push_back(t);
        }
      }
    }
    if (!reached && tn && tn->props.isFrameLike()) {
      std::string last;
      std::unordered_set<std::string> names;
      for (auto& f : flows) {
        names.insert(f.name);
        if (f.position > last) last = f.position;
      }
      int k = static_cast<int>(flows.size()) + 1;
      std::string name = "Flow " + std::to_string(k);
      while (names.count(name)) name = "Flow " + std::to_string(++k);
      json::Value sp;
      sp.kind = json::Value::Kind::Object;
      json::Value nm, pos;
      nm.kind = pos.kind = json::Value::Kind::String;
      nm.string = name;
      pos.string = fractional::keyBetween(last, std::nullopt, fractional::Bias::Low);
      sp.object.emplace_back("name", nm);
      sp.object.emplace_back("position", pos);
      NodeChange c = NodeChange::changed(top);
      c.mask = F_EXTRA;
      c.props.extra["prototypeStartingPoint"] = proto::encodeField("prototypeStartingPoint", sp);
      write(c);
    }
  }
  commit();
  if (!made.nodes.empty()) {
    // The new connection is the selected one (its details open, PrototypePanel).
    if (const Node* n = doc_.get(made.nodes[0])) {
      proto_.selNode = made.nodes[0];
      proto_.selIndex = static_cast<int>(proto::interactions(n->props).size()) - 1;
      proto_.selClicked = false;
    }
    events_.prototypeConnected.push_back(std::move(made));
  }
}

void Editor::protoOverlay(Overlay& o) const {
  Editor* self = const_cast<Editor*>(this);
  PrototypeOverlay& po = o.prototype;
  po.on = true;
  for (const ProtoLink& l : self->protoLinks()) {
    bool same = l.source == proto_.link.source && l.interaction == proto_.link.interaction && l.index == proto_.link.index &&
                l.action == proto_.link.action;
    bool retargeting = proto_.drag == ProtoSession::Drag::Retarget && same;
    bool moving = proto_.drag == ProtoSession::Drag::MoveStart && same;
    PrototypeLink pl;
    pl.source = doc_.worldBounds(l.source);
    pl.dest = doc_.worldBounds(l.dest);
    // Round 17 (the owner's live 61–65.png): only the selected connection — the one open in Interaction details — and
    // one being dragged are in the selection colour; the others, a selected hotspot's too, are light.
    pl.highlighted = protoSelected(l) || retargeting || moving || (proto_.drag == ProtoSession::Drag::Line && same);
    pl.label = protoLabel(l);
    if (moving) {
      // Its start follows the pointer, onto the layer it would move to.
      pl.label.clear();
      pl.source = proto_.target != kNoGuid ? doc_.worldBounds(proto_.target) : Rect{proto_.point.x, proto_.point.y, 0, 0};
    }
    if (retargeting) {
      pl.label.clear();
      // Its start stays on the side it leaves from while its end is dragged.
      pl.startSide = static_cast<int>(prototypeNoodle(pl.source, pl.dest, false, {}).start);
      if (proto_.target != kNoGuid) pl.dest = doc_.worldBounds(proto_.target);
      else {
        pl.toPoint = true;
        pl.point = proto_.point;
      }
    }
    po.links.push_back(pl);
  }
  // A selected instance's inherited connections (its main component's, and those of the layers inside it): help
  // "View prototype connections" — "Figma won't display the inherited connections on the canvas by default. Select
  // the instance to view its inherited connections."
  if (selection_.size() <= 64) {
    std::unordered_set<Guid, GuidHash> drawn;
    std::function<void(Guid, bool)> inherited = [&](Guid id, bool root) {
      const Node* n = doc_.get(id);
      if (!n || !n->props.visible || !drawn.insert(id).second) return;
      std::vector<proto::Interaction> list;
      // Its own (a real instance's own are among the page's connections already), else its main's.
      if (proto::hasInteractions(n->props)) {
        if (!root || id.isDerived()) list = proto::interactions(n->props);
      } else if (n->props.type == NodeType::INSTANCE) {
        if (const Node* m = doc_.get(mainOf(id)); m && proto::hasInteractions(m->props)) list = proto::interactions(m->props);
      }
      for (const proto::Interaction& i : list)
        for (const proto::Action& a : i.actions) {
          std::vector<std::pair<proto::Navigation, Guid>> dests;
          proto::destinations(a, dests);
          std::vector<Guid> videos;
          proto::mediaTargets(a, videos);
          for (Guid v : videos) dests.emplace_back(proto::Navigation::NAVIGATE, v);
          for (auto& [nav, d] : dests) {
            if (d == kNoGuid || !doc_.has(d)) continue;
            PrototypeLink pl;
            pl.source = doc_.worldBounds(id);
            pl.dest = doc_.worldBounds(d);
            pl.highlighted = false;  // quiet, as every connection not selected (round 17)
            po.links.push_back(pl);
          }
        }
      for (Guid c : doc_.children(id)) inherited(c, false);
    };
    for (Guid g : selection_) {
      const Node* n = doc_.get(g);
      if (n && n->props.type == NodeType::INSTANCE) inherited(g, true);
    }
  }
  if (proto_.drag == ProtoSession::Drag::New)
    for (size_t i = 0; i < proto_.sources.size(); i++) {
      Guid src = proto_.sources[i];
      PrototypeLink pl;
      pl.source = doc_.worldBounds(src);
      if (i < proto_.sourceSides.size()) pl.startSide = static_cast<int>(proto_.sourceSides[i]);
      if (proto_.target != kNoGuid) pl.dest = doc_.worldBounds(proto_.target);
      else {
        pl.toPoint = true;
        pl.point = proto_.point;
      }
      po.links.push_back(pl);
    }
  if (proto_.target != kNoGuid && proto_.drag != ProtoSession::Drag::None) {
    po.hasTarget = true;
    po.target = doc_.worldBounds(proto_.target);
  }
  if (gesture_ == Gesture::None || gesture_ == Gesture::Noodle) {
    // Round 16: each nub on its hotspot's side nearest the pointer (right before the pointer is known); while a new
    // connection is dragged, the plain nub where it leaves.
    bool dragging = proto_.drag == ProtoSession::Drag::New;
    Vec2 w = camera_.toWorld(proto_.pointer);
    for (Guid id : protoHandleNodes()) {
      PrototypeHandle h;
      h.box = doc_.worldBounds(id);
      h.side = proto_.hasPointer ? nearestSide(h.box, w) : NoodleSide::RIGHT;
      if (dragging) {
        for (size_t i = 0; i < proto_.sources.size() && i < proto_.sourceSides.size(); i++)
          if (proto_.sources[i] == id) h.side = proto_.sourceSides[i];
      } else {
        h.hovered = proto_.handleHovered && proto_.hoveredNub == id;
      }
      po.handles.push_back(h);
    }
  }
  for (const proto::Flow& f : proto::flows(doc_, page_)) po.flows.push_back({f.node, doc_.worldBounds(f.node), f.name});
  // Moving or resizing: the noodles follow, the handles wait.
  if (gesture_ == Gesture::Move || gesture_ == Gesture::Resize || gesture_ == Gesture::Rotate) po.handles.clear();
}

}  // namespace eng
