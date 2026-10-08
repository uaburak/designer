// Prototype mode on the canvas (docs/research/figma/R8-prototyping.md §6): connections drawn from hotspots to their
// destinations, the "+" connection handle on the selected layers' right edges, flow starting point labels; dragging
// the handle to a frame adds an interaction (On click → Navigate to, Instant: Figma's defaults for a new connection —
// one per selected hotspot), dragging a noodle's end to another frame retargets it, to empty canvas removes it. The
// first connection out of a frame no flow reaches gives that frame a flow starting point ("Flow 1", …).
//
// The interactions stay the schema's JSON while they are edited, so every field the engine doesn't read survives.

#include <algorithm>
#include <cmath>
#include <functional>
#include <unordered_set>

#include "base/FractionalIndex.h"
#include "editor/Editor.h"
#include "proto/Prototype.h"
#include "scene/CodecKiwi.h"

namespace eng {

namespace {

constexpr double kHandleHit = 8;  // CSS px around a handle / a noodle's end
constexpr double kNoodleDrag = 3;

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
              proto_.links.push_back({id, list[i].id, i, path, a.dest});
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

bool Editor::protoHandleAt(Vec2 s, std::vector<Guid>* nodes) const {
  for (Guid id : protoHandleNodes()) {
    Rect b = doc_.worldBounds(id);
    Vec2 c = camera_.toScreen({b.right(), b.y + b.h / 2});
    if ((c - s).length() <= kHandleHit) {
      if (nodes) *nodes = protoHandleNodes();
      return true;
    }
  }
  return false;
}

bool Editor::protoEndAt(Vec2 s, ProtoLink& out) {
  const Mat2x3 view = camera_.matrix();
  auto screen = [&](const Rect& r) { return transformedBounds(view * Mat2x3::translate(r.x, r.y), r.w, r.h); };
  for (const ProtoLink& l : protoLinks()) {
    bool sel = false;
    for (Guid g : selection_) sel |= g == l.source || doc_.isAncestor(g, l.source);
    if (!sel) continue;
    NoodleCurve n = prototypeNoodle(screen(doc_.worldBounds(l.source)), screen(doc_.worldBounds(l.dest)), false, {});
    if ((n.b - s).length() <= kHandleHit) {
      out = l;
      return true;
    }
  }
  return false;
}

Guid Editor::protoTargetAt(Vec2 world, const std::vector<Guid>& sources) const {
  const auto& kids = doc_.children(page_);
  for (auto it = kids.rbegin(); it != kids.rend(); ++it) {
    const Node* n = doc_.get(*it);
    if (!n || !n->props.visible || !n->props.isFrameLike() || n->props.type == NodeType::SECTION) continue;
    if (!doc_.worldBounds(*it).contains(world)) continue;
    for (Guid s : sources)
      if (s == *it) return kNoGuid;  // not onto itself
    return *it;
  }
  return kNoGuid;
}

uint32_t Editor::protoPointerDown(Vec2 s, uint32_t /*mods*/) {
  std::vector<Guid> sources;
  ProtoLink link;
  if (protoEndAt(s, link)) {
    proto_.drag = ProtoSession::Drag::Retarget;
    proto_.link = link;
    proto_.sources = {link.source};
  } else if (protoHandleAt(s, &sources)) {
    proto_.drag = ProtoSession::Drag::New;
    proto_.sources = sources;
  } else {
    return 0;
  }
  proto_.point = camera_.toWorld(s);
  proto_.target = proto_.drag == ProtoSession::Drag::Retarget ? link.dest : kNoGuid;
  gesture_ = Gesture::Noodle;
  changeCursor(CursorKind::DEFAULT);
  needsRender_ = true;
  return P_HANDLED | P_CAPTURE;
}

void Editor::protoPointerMove(Vec2 s) {
  proto_.point = camera_.toWorld(s);
  if ((s - downScreen_).length() >= kNoodleDrag || proto_.drag == ProtoSession::Drag::New)
    proto_.target = protoTargetAt(proto_.point, proto_.sources);
  needsRender_ = true;
}

void Editor::protoHover(Vec2 s) {
  bool on = protoHandleAt(s);
  ProtoLink l;
  bool end = !on && protoEndAt(s, l);
  if (on != proto_.handleHovered) {
    proto_.handleHovered = on;
    needsRender_ = true;
  }
  if (on || end) changeCursor(CursorKind::DEFAULT);
}

void Editor::protoPointerUp(Vec2 s) {
  proto_.point = camera_.toWorld(s);
  Guid target = protoTargetAt(proto_.point, proto_.sources);
  bool moved = (s - downScreen_).length() >= kNoodleDrag;
  ProtoSession::Drag drag = proto_.drag;
  proto_.drag = ProtoSession::Drag::None;
  proto_.target = kNoGuid;
  needsRender_ = true;
  if (drag == ProtoSession::Drag::Retarget) {
    if (!moved) return;
    const Node* n = doc_.get(proto_.link.source);
    if (!n) return;
    json::Value list = interactionsJson(n->props);
    // The interaction by its id (else its index), then the action by its path.
    size_t index = proto_.link.index;
    for (size_t i = 0; i < list.array.size(); i++) {
      json::Value* id = member(list.array[i], "id");
      if (id && proto_.link.interaction != kNoGuid) {
        Guid g{static_cast<uint32_t>(id->get("sessionID") ? id->get("sessionID")->numberOr(0) : 0),
               static_cast<uint32_t>(id->get("localID") ? id->get("localID")->numberOr(0) : 0)};
        if (g == proto_.link.interaction) index = i;
      }
    }
    if (index >= list.array.size()) return;
    json::Value& interaction = list.array[index];
    if (target != kNoGuid) {
      if (target == proto_.link.dest) return;
      json::Value* a = actionAt(interaction, proto_.link.action);
      if (!a) return;
      if (json::Value* d = member(*a, "transitionNodeID")) *d = guidJson(target);
      else a->object.emplace_back("transitionNodeID", guidJson(target));
      begin(TxnKind::USER, "Edit interaction");
    } else {
      // Dropped on empty canvas: the connection goes (its interaction too, when it was its only action).
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
    list.array.push_back(proto::toJson(proto::newConnection(id, target)));
    NodeChange c = NodeChange::changed(src);
    c.mask = F_EXTRA;
    c.props.extra["prototypeInteractions"] = proto::encodeField("prototypeInteractions", list);
    write(c);
    made.nodes.push_back(src);
    made.interaction = id;
  }
  // A flow starting point for the frame the connection leaves, when no flow reaches it yet (R8 §6).
  if (!made.nodes.empty()) {
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
  if (!made.nodes.empty()) events_.prototypeConnected.push_back(std::move(made));
}

void Editor::protoOverlay(Overlay& o) const {
  Editor* self = const_cast<Editor*>(this);
  PrototypeOverlay& po = o.prototype;
  po.on = true;
  for (const ProtoLink& l : self->protoLinks()) {
    bool retargeting = proto_.drag == ProtoSession::Drag::Retarget && l.source == proto_.link.source &&
                       l.interaction == proto_.link.interaction && l.action == proto_.link.action;
    PrototypeLink pl;
    pl.source = doc_.worldBounds(l.source);
    pl.dest = doc_.worldBounds(l.dest);
    bool sel = selection_.empty();
    for (Guid g : selection_) sel |= g == l.source || doc_.isAncestor(g, l.source);
    pl.highlighted = sel;
    if (retargeting) {
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
          for (auto& [nav, d] : dests) {
            if (d == kNoGuid || !doc_.has(d)) continue;
            PrototypeLink pl;
            pl.source = doc_.worldBounds(id);
            pl.dest = doc_.worldBounds(d);
            pl.highlighted = true;
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
    for (Guid src : proto_.sources) {
      PrototypeLink pl;
      pl.source = doc_.worldBounds(src);
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
  if (gesture_ == Gesture::None || gesture_ == Gesture::Noodle)
    for (Guid id : protoHandleNodes()) po.handles.push_back(doc_.worldBounds(id));
  po.handleHovered = proto_.handleHovered || proto_.drag == ProtoSession::Drag::New;
  for (const proto::Flow& f : proto::flows(doc_, page_)) po.flows.push_back({f.node, doc_.worldBounds(f.node), f.name});
  // Moving or resizing: the noodles follow, the handles wait.
  if (gesture_ == Gesture::Move || gesture_ == Gesture::Resize || gesture_ == Gesture::Rotate) po.handles.clear();
}

}  // namespace eng
