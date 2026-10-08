// Dev Mode in the engine (docs/research/figma/R9-dev-mode.md "Round 6"): annotation labels and dots, saved
// measurements and the Measurement tool, the Annotation tool's click, statuses on frame titles ("Ready for dev",
// "Completed", the automatic "Changed" from editInfo), focus view, and editInfo stamped on user edits.
//
// Notes and categories are written by the panels (setProps on `annotations` / `annotationCategories`); the engine
// draws them and reports clicks. Measurements are written here (the tool, a drag off the design, Delete) and by the
// MEASUREMENT_* commands.

#include <algorithm>
#include <cmath>
#include <ctime>

#include "editor/Editor.h"
#include "hit/HitTest.h"
#include "hit/Picking.h"
#include "scene/CodecKiwi.h"

namespace eng {

namespace {

constexpr double kEdgeSnap = 12;
constexpr double kDragThreshold = 3;  // CSS px before a press becomes a drag (tools/Gestures.cpp)  // CSS px: how near an edge the measurement tool picks it

bool devField(const std::string& k) {
  return k == "annotations" || k == "measurements" || k == "annotationCategories" || k == "sectionStatusInfo" || k == "editInfo";
}

json::Value extraJson(const NodeProps& p, const char* field) {
  json::Value v;
  auto it = p.extra.find(field);
  if (it == p.extra.end() || it->second.empty()) return v;
  json::parse(codec::extraValueToJson("NodeChange", it->second), v);
  return v;
}

double distToSegment(Vec2 p, Vec2 a, Vec2 b) {
  Vec2 d = b - a;
  double len2 = d.x * d.x + d.y * d.y;
  double t = len2 > 0 ? std::clamp(((p.x - a.x) * d.x + (p.y - a.y) * d.y) / len2, 0.0, 1.0) : 0;
  return (p - (a + d * t)).length();
}

GuideLine edgeLine(const Rect& r, annot::Side s) {
  switch (s) {
    case annot::Side::LEFT: return {{r.x, r.y}, {r.x, r.bottom()}};
    case annot::Side::RIGHT: return {{r.right(), r.y}, {r.right(), r.bottom()}};
    case annot::Side::TOP: return {{r.x, r.y}, {r.right(), r.y}};
    case annot::Side::BOTTOM: return {{r.x, r.bottom()}, {r.right(), r.bottom()}};
  }
  return {};
}

Guid argGuid(const json::Value& raw, const char* key) {
  const json::Value* v = raw.isObject() ? raw.get(key) : nullptr;
  return annot::guidOf(v);
}

}  // namespace

double Editor::wallClock() const { return wallClock_ ? wallClock_() : static_cast<double>(std::time(nullptr)); }

void Editor::setDevEdits(bool on) {
  devEdits_ = on;
  if (!on && viewer_ && (tool_ == Tool::ANNOTATION || tool_ == Tool::MEASUREMENT)) setTool(Tool::MOVE);
  needsRender_ = true;
}

void Editor::setAnnotationView(bool show, bool dots) {
  if (dev_.show == show && dev_.dots == dots) return;
  dev_.show = show;
  dev_.dots = dots;
  if (!dots) dev_.openNode = kNoGuid;
  if (!show && dev_.selectedMeasurement != kNoGuid) {
    dev_.selectedMeasurement = kNoGuid;
    events_.measurementSelection = true;
  }
  needsRender_ = true;
}

Status Editor::setFocus(Guid id) {
  if (id != kNoGuid && !doc_.has(id)) return E_NOT_FOUND;
  if (dev_.focus == id) return OK;
  dev_.focus = id;
  if (id != kNoGuid) {
    // What is selected outside the design leaves the selection.
    std::vector<Guid> keep;
    for (Guid s : selection_)
      if (s == id || doc_.isAncestor(id, s)) keep.push_back(s);
    if (keep.size() != selection_.size()) changeSelection(std::move(keep));
  }
  if (hover_ != kNoGuid) {
    hover_ = kNoGuid;
    events_.hover = true;
  }
  needsRender_ = true;
  return OK;
}

void Editor::focusFilter(std::vector<Guid>& path) const {
  if (dev_.focus == kNoGuid || path.empty()) return;
  if (std::find(path.begin(), path.end(), dev_.focus) == path.end()) path.clear();
}

int Editor::devStatus(Guid id) const {
  const Node* n = doc_.get(id);
  if (!n || n->props.extra.find("sectionStatusInfo") == n->props.extra.end()) return 0;
  json::Value info = extraJson(n->props, "sectionStatusInfo");
  const json::Value* st = info.isObject() ? info.get("status") : nullptr;
  if (!st || !st->isString() || st->string == "NONE" || st->string.empty()) return 0;
  double since = info.get("lastUpdateUnixTimestamp") ? info.get("lastUpdateUnixTimestamp")->numberOr(0) : 0;
  json::Value edit = extraJson(n->props, "editInfo");
  double edited = edit.isObject() && edit.get("lastEditedAt") ? edit.get("lastEditedAt")->numberOr(0) : 0;
  if (edited > since) return 3;
  return st->string == "COMPLETED" ? 2 : 1;
}

std::vector<annot::Measurement> Editor::measurements(Guid page) const {
  const Node* p = doc_.get(page == kNoGuid ? page_ : page);
  return p ? annot::measurementsOf(p->props) : std::vector<annot::Measurement>{};
}

Status Editor::selectMeasurement(Guid id) {
  if (id != kNoGuid) {
    bool found = false;
    for (const auto& m : measurements()) found |= m.id == id;
    if (!found) return E_NOT_FOUND;
  }
  if (dev_.selectedMeasurement != id) {
    dev_.selectedMeasurement = id;
    events_.measurementSelection = true;
    needsRender_ = true;
  }
  return OK;
}

bool Editor::measurementLine(const annot::Measurement& m, Vec2& a, Vec2& b, std::vector<GuideLine>* ext) const {
  if (!doc_.has(m.from) || !doc_.has(m.to)) return false;
  Rect A = doc_.worldBounds(m.from), B = doc_.worldBounds(m.to);
  annot::Side ts = m.toSameSide ? m.side : annot::oppositeSide(m.side);
  if (annot::horizontalSide(m.side) != annot::horizontalSide(ts)) return false;
  if (annot::horizontalSide(m.side)) {
    double xa = m.side == annot::Side::LEFT ? A.x : A.right(), xb = ts == annot::Side::LEFT ? B.x : B.right();
    double y = A.y + A.h / 2 + m.inner * A.h / 2;
    if (m.outer != 0) y = m.outer > 0 ? std::max(A.bottom(), B.bottom()) + m.outer : std::min(A.y, B.y) + m.outer;
    a = {xa, y};
    b = {xb, y};
    if (ext) {
      auto e = [&](double x, const Rect& r) {
        if (y < r.y) ext->push_back({{x, r.y}, {x, y}});
        else if (y > r.bottom()) ext->push_back({{x, r.bottom()}, {x, y}});
      };
      e(xa, A);
      e(xb, B);
    }
  } else {
    double ya = m.side == annot::Side::TOP ? A.y : A.bottom(), yb = ts == annot::Side::TOP ? B.y : B.bottom();
    double x = A.x + A.w / 2 + m.inner * A.w / 2;
    if (m.outer != 0) x = m.outer > 0 ? std::max(A.right(), B.right()) + m.outer : std::min(A.x, B.x) + m.outer;
    a = {x, ya};
    b = {x, yb};
    if (ext) {
      auto e = [&](double y, const Rect& r) {
        if (x < r.x) ext->push_back({{r.x, y}, {x, y}});
        else if (x > r.right()) ext->push_back({{r.right(), y}, {x, y}});
      };
      e(ya, A);
      e(yb, B);
    }
  }
  return true;
}

void Editor::devOverlay(Overlay& o) const {
  DevOverlay& d = o.dev;
  d.annotations = dev_.show;
  d.dots = dev_.dots;
  d.focus = dev_.focus;
  if (page_ == kNoGuid || !doc_.has(page_)) return;
  // The design a layer is in (the page's child holding it).
  auto topOf = [&](Guid id) {
    for (int guard = 0; guard < 4096 && id != kNoGuid; guard++) {
      Guid p = doc_.parentOf(id);
      if (p == page_) return id;
      if (p == kNoGuid) return kNoGuid;
      id = p;
    }
    return kNoGuid;
  };

  // Statuses after the designs' names; "Mark as ready for dev" on a selected frame or component under the pointer.
  Guid hoveredTop = hover_ != kNoGuid ? topOf(hover_.isDerived() ? instanceOfDerived(hover_) : hover_) : kNoGuid;
  for (Guid c : doc_.children(page_)) {
    const Node* n = doc_.get(c);
    if (!n || !n->props.visible || !n->props.isFrameLike() || n->props.type == NodeType::SECTION) continue;
    if (dev_.focus != kNoGuid && c != dev_.focus) continue;
    int st = devStatus(c);
    if (st) {
      d.statuses.push_back({c, st == 1 ? DevStatusMark::Kind::Ready : st == 2 ? DevStatusMark::Kind::Completed : DevStatusMark::Kind::Changed});
    } else if (canEditDev() && n->props.type != NodeType::INSTANCE && c == hoveredTop && selected(c)) {
      d.statuses.push_back({c, DevStatusMark::Kind::MarkButton});
    }
  }

  // Saved measurements.
  for (annot::Measurement m : measurements()) {
    if (gesture_ == Gesture::MeasureDrag && m.id == dev_.dragged.id) m = dev_.dragged;
    if (dev_.focus != kNoGuid && !(m.from == dev_.focus || doc_.isAncestor(dev_.focus, m.from))) continue;
    MeasurementMark mark;
    mark.id = m.id;
    if (!measurementLine(m, mark.a, mark.b, &mark.extensions)) continue;
    mark.text = !m.freeText.empty() ? m.freeText : annot::formatNumber((mark.b - mark.a).length());
    mark.selected = m.id == dev_.selectedMeasurement;
    d.measurements.push_back(std::move(mark));
  }

  // The measurement tool: the edge it would start from, or the measurement being dragged out.
  if (tool_ == Tool::MEASUREMENT) {
    if (gesture_ == Gesture::Measure && doc_.has(dev_.fromNode)) {
      d.edges.push_back(edgeLine(doc_.worldBounds(dev_.fromNode), dev_.fromSide));
      annot::Measurement m;
      m.from = dev_.fromNode;
      m.side = dev_.fromSide;
      if (dev_.hasTo && doc_.has(dev_.toNode)) {
        d.edges.push_back(edgeLine(doc_.worldBounds(dev_.toNode), dev_.toSide));
        m.to = dev_.toNode;
        m.toSameSide = dev_.toSide == dev_.fromSide;
        Rect A = doc_.worldBounds(m.from);
        // The draft runs where the pointer is, along the start edge.
        if (annot::horizontalSide(m.side)) m.inner = A.h > 0 ? std::clamp((dev_.point.y - (A.y + A.h / 2)) / (A.h / 2), -1.0, 1.0) : 0;
        else m.inner = A.w > 0 ? std::clamp((dev_.point.x - (A.x + A.w / 2)) / (A.w / 2), -1.0, 1.0) : 0;
        if (measurementLine(m, d.draft.a, d.draft.b, &d.draft.extensions)) {
          d.hasDraft = true;
          d.draft.text = annot::formatNumber((d.draft.b - d.draft.a).length());
        }
      } else {
        Rect A = doc_.worldBounds(m.from);
        GuideLine e = edgeLine(A, m.side);
        if (annot::horizontalSide(m.side)) {
          double y = std::clamp(dev_.point.y, A.y, A.bottom());
          d.draft.a = {e.a.x, y};
          d.draft.b = {dev_.point.x, y};
        } else {
          double x = std::clamp(dev_.point.x, A.x, A.right());
          d.draft.a = {x, e.a.y};
          d.draft.b = {x, dev_.point.y};
        }
        d.hasDraft = true;
      }
    } else if (gesture_ == Gesture::None && dev_.hasEdge && doc_.has(dev_.edgeNode)) {
      d.edges.push_back(edgeLine(doc_.worldBounds(dev_.edgeNode), dev_.edgeSide));
    }
  }

  // Annotation labels (or dots).
  if (!dev_.show || annotated_.empty()) return;
  const Node* docNode = doc_.get(docNode_);
  std::vector<annot::Category> categories = annot::categoriesOf(docNode ? &docNode->props : nullptr);
  std::vector<Guid> ids(annotated_.begin(), annotated_.end());
  std::sort(ids.begin(), ids.end());
  for (Guid id : ids) {
    const Node* n = doc_.get(id);
    if (!n || doc_.pageOf(id) != page_ || !doc_.visibleInTree(id)) continue;
    if (dev_.focus != kNoGuid && !(id == dev_.focus || doc_.isAncestor(dev_.focus, id))) continue;
    Guid top = topOf(id);
    if (top == kNoGuid) continue;
    std::vector<annot::Note> notes = annot::notesOf(n->props);
    for (size_t i = 0; i < notes.size(); i++) {
      const annot::Note& note = notes[i];
      AnnotationCard c;
      c.node = id;
      c.index = static_cast<uint32_t>(i);
      c.target = doc_.worldBounds(id);
      c.frame = top;
      c.frameBounds = doc_.worldBounds(top);
      if (const annot::Category* cat = annot::findCategory(categories, note.category)) {
        c.title = cat->label;
        c.color = cat->color;
      } else {
        c.color = annot::defaultNoteColor();
      }
      for (const annot::Line& l : annot::markdownLines(note.markdown)) {
        std::string text = l.bullet ? "• " + l.text : l.number ? std::to_string(l.number) + ". " + l.text : l.text;
        c.lines.push_back({text, l.heading});
      }
      for (const std::string& t : note.properties) c.properties.emplace_back(annot::propertyLabel(t), annot::propertyValue(doc_, id, t));
      c.selected = selected(id);
      c.open = !dev_.dots || (dev_.openNode == id && dev_.openIndex == static_cast<int>(i));
      d.cards.push_back(std::move(c));
    }
  }
}

bool Editor::edgeAt(Vec2 s, int axis, Guid& node, annot::Side& side) const {
  if (page_ == kNoGuid) return false;
  auto path = hitPath(doc_, page_, camera_.toWorld(s), pixel());
  focusFilter(path);
  if (path.empty()) return false;
  // The innermost layer under the pointer (a sublayer of an instance: the instance, whose GUID lasts).
  Guid id = path.back();
  if (id.isDerived()) id = instanceOfDerived(id);
  if (id == kNoGuid || !doc_.has(id)) return false;
  Rect r = transformedBounds(camera_.matrix() * Mat2x3::translate(doc_.worldBounds(id).x, doc_.worldBounds(id).y), doc_.worldBounds(id).w,
                             doc_.worldBounds(id).h);
  struct Cand {
    annot::Side side;
    double dist;
  };
  Cand c[4] = {{annot::Side::LEFT, std::fabs(s.x - r.x)},
               {annot::Side::RIGHT, std::fabs(s.x - r.right())},
               {annot::Side::TOP, std::fabs(s.y - r.y)},
               {annot::Side::BOTTOM, std::fabs(s.y - r.bottom())}};
  double best = 1e18;
  bool found = false;
  for (const Cand& k : c) {
    bool h = annot::horizontalSide(k.side);
    if ((axis == 1 && !h) || (axis == 2 && h)) continue;
    if (k.dist < best) {
      best = k.dist;
      side = k.side;
      found = true;
    }
  }
  // Any edge of the layer under the pointer when starting; the nearest one within reach while dragging to it.
  if (!found || (axis == 0 && best > std::max(kEdgeSnap, std::min(r.w, r.h) / 2))) return false;
  node = id;
  return true;
}

void Editor::devHover(Vec2 s) {
  bool had = dev_.hasEdge;
  Guid node = dev_.edgeNode;
  annot::Side side = dev_.edgeSide;
  dev_.hasEdge = tool_ == Tool::MEASUREMENT && gesture_ == Gesture::None && canEditDev() && edgeAt(s, 0, dev_.edgeNode, dev_.edgeSide);
  if (had != dev_.hasEdge || node != dev_.edgeNode || side != dev_.edgeSide) needsRender_ = true;
}

uint32_t Editor::devPointerDown(Vec2 s, uint32_t mods) {
  // A design's status chip, or "Mark as ready for dev".
  for (const CanvasHits::Status& h : hits_.statuses) {
    if (!h.rect.contains(s)) continue;
    if (h.kind == DevStatusMark::Kind::MarkButton && !canEditDev()) continue;
    events_.statusClicks.push_back({h.frame, h.kind == DevStatusMark::Kind::MarkButton ? "mark" : "menu", h.rect});
    needsRender_ = true;
    return P_HANDLED;
  }
  if (dev_.show) {
    // An annotation's label or dot (the topmost drawn last).
    for (auto it = hits_.annotations.rbegin(); it != hits_.annotations.rend(); ++it) {
      if (!it->rect.contains(s) || !doc_.has(it->node)) continue;
      if (dev_.dots) {
        bool open = dev_.openNode == it->node && dev_.openIndex == static_cast<int>(it->index);
        if (it->dot || open) {
          dev_.openNode = open && it->dot ? kNoGuid : it->node;
          dev_.openIndex = open && it->dot ? -1 : static_cast<int>(it->index);
        }
      }
      changeSelection({it->node});
      events_.annotationOpens.push_back({it->node, static_cast<int>(it->index), it->rect});
      needsRender_ = true;
      return P_HANDLED;
    }
    // A saved measurement: selects it; a drag moves it off the design, a double-click edits its text.
    for (const CanvasHits::Measure& h : hits_.measurements) {
      if (!h.pill.contains(s) && distToSegment(s, h.a, h.b) > 4) continue;
      if (dev_.selectedMeasurement != h.id) {
        dev_.selectedMeasurement = h.id;
        events_.measurementSelection = true;
      }
      needsRender_ = true;
      if (!canEditDev()) return P_HANDLED;
      for (const annot::Measurement& m : measurements())
        if (m.id == h.id) dev_.dragged = m;
      if (clickCount_ >= 2) {
        Vec2 a, b;
        std::string text = dev_.dragged.freeText;
        if (text.empty() && measurementLine(dev_.dragged, a, b)) text = annot::formatNumber((b - a).length());
        events_.measurementEdits.push_back({h.id, h.pill, text});
        return P_HANDLED;
      }
      dev_.draggedMoved = false;
      gesture_ = Gesture::MeasureDrag;
      return P_HANDLED | P_CAPTURE;
    }
  }
  if (dev_.selectedMeasurement != kNoGuid) {
    dev_.selectedMeasurement = kNoGuid;
    events_.measurementSelection = true;
    needsRender_ = true;
  }
  if (tool_ == Tool::ANNOTATION && canEditDev()) {
    // The layer to annotate: the one a click would select; the editor opens its note.
    auto path = hitPath(doc_, page_, downWorld_, pixel());
    focusFilter(path);
    Guid hit = pick(doc_, path, selection_, (mods & MOD_PRIMARY) != 0);
    if (hit != kNoGuid) {
      changeSelection({hit});
      Rect wb = doc_.worldBounds(hit);
      Rect r = transformedBounds(camera_.matrix() * Mat2x3::translate(wb.x, wb.y), wb.w, wb.h);
      events_.annotationOpens.push_back({hit, -1, r});
    }
    needsRender_ = true;
    return P_HANDLED;
  }
  if (tool_ == Tool::MEASUREMENT && canEditDev()) {
    Guid node;
    annot::Side side;
    if (edgeAt(s, 0, node, side)) {
      dev_.fromNode = node;
      dev_.fromSide = side;
      dev_.point = downWorld_;
      dev_.hasTo = false;
      dev_.hasEdge = false;
      gesture_ = Gesture::Measure;
      needsRender_ = true;
      return P_HANDLED | P_CAPTURE;
    }
    return P_HANDLED;
  }
  return 0;
}

bool Editor::devPointerMove(Vec2 s) {
  Vec2 world = camera_.toWorld(s);
  if (gesture_ == Gesture::Measure) {
    dev_.point = world;
    Guid node;
    annot::Side side;
    dev_.hasTo = (s - downScreen_).length() >= kDragThreshold &&
                 edgeAt(s, annot::horizontalSide(dev_.fromSide) ? 1 : 2, node, side) && !(node == dev_.fromNode && side == dev_.fromSide);
    if (dev_.hasTo) {
      dev_.toNode = node;
      dev_.toSide = side;
    }
    needsRender_ = true;
    return true;
  }
  if (gesture_ == Gesture::MeasureDrag) {
    if ((s - downScreen_).length() < kDragThreshold && !dev_.draggedMoved) return true;
    dev_.draggedMoved = true;
    annot::Measurement& m = dev_.dragged;
    if (!doc_.has(m.from) || !doc_.has(m.to)) return true;
    Rect A = doc_.worldBounds(m.from), B = doc_.worldBounds(m.to);
    bool h = annot::horizontalSide(m.side);
    double v = h ? world.y : world.x;
    double lo = h ? A.y : A.x, hi = h ? A.bottom() : A.right();
    double mn = std::min(lo, h ? B.y : B.x), mx = std::max(hi, h ? B.bottom() : B.right());
    m.inner = 0;
    m.outer = 0;
    if (v >= lo && v <= hi) {
      double half = (hi - lo) / 2;
      m.inner = half > 0 ? std::clamp((v - (lo + half)) / half, -1.0, 1.0) : 0;
    } else if (v > mx) {
      m.outer = std::round(v - mx);
    } else if (v < mn) {
      m.outer = std::round(v - mn);
    } else {
      m.inner = v > hi ? 1 : -1;
    }
    if (m.outer == 0 && (v > mx || v < mn)) m.outer = v > mx ? 1 : -1;
    needsRender_ = true;
    return true;
  }
  return false;
}

bool Editor::devPointerUp(Vec2 s) {
  if (gesture_ == Gesture::Measure) {
    gesture_ = Gesture::None;
    bool drag = (s - downScreen_).length() >= kDragThreshold;
    annot::Measurement m;
    m.from = dev_.fromNode;
    m.side = dev_.fromSide;
    if (drag && dev_.hasTo) {
      m.to = dev_.toNode;
      m.toSameSide = dev_.toSide == dev_.fromSide;
      Rect A = doc_.worldBounds(m.from);
      if (annot::horizontalSide(m.side)) m.inner = A.h > 0 ? std::clamp((dev_.point.y - (A.y + A.h / 2)) / (A.h / 2), -1.0, 1.0) : 0;
      else m.inner = A.w > 0 ? std::clamp((dev_.point.x - (A.x + A.w / 2)) / (A.w / 2), -1.0, 1.0) : 0;
      m.inner = std::round(m.inner * 100) / 100;
    } else if (!drag) {
      // A click on an edge: the layer's own width (or height).
      m.to = m.from;
      m.toSameSide = false;
    } else {
      needsRender_ = true;
      return true;
    }
    m.id = newGuid();
    auto list = measurements();
    list.push_back(m);
    writeMeasurements(page_, list, "Add measurement");
    dev_.selectedMeasurement = m.id;
    events_.measurementSelection = true;
    setTool(Tool::MOVE);
    needsRender_ = true;
    return true;
  }
  if (gesture_ == Gesture::MeasureDrag) {
    gesture_ = Gesture::None;
    if (dev_.draggedMoved) {
      auto list = measurements();
      for (auto& m : list)
        if (m.id == dev_.dragged.id) m = dev_.dragged;
      writeMeasurements(page_, list, "Move measurement");
    }
    needsRender_ = true;
    return true;
  }
  return false;
}

uint32_t Editor::devKey(KeyCode code, uint32_t /*mods*/) {
  if (dev_.selectedMeasurement == kNoGuid || gesture_ != Gesture::None) return 0;
  if (code == KeyCode::Escape) {
    dev_.selectedMeasurement = kNoGuid;
    events_.measurementSelection = true;
    needsRender_ = true;
    return K_HANDLED;
  }
  if ((code == KeyCode::Backspace || code == KeyCode::Delete) && canEditDev()) {
    auto list = measurements();
    auto before = list.size();
    list.erase(std::remove_if(list.begin(), list.end(), [&](const annot::Measurement& m) { return m.id == dev_.selectedMeasurement; }), list.end());
    if (list.size() != before) writeMeasurements(page_, list, "Delete measurement");
    dev_.selectedMeasurement = kNoGuid;
    events_.measurementSelection = true;
    needsRender_ = true;
    return K_HANDLED;
  }
  return 0;
}

void Editor::writeMeasurements(Guid page, const std::vector<annot::Measurement>& list, const char* label) {
  begin(TxnKind::USER, label);
  NodeChange c = NodeChange::changed(page);
  c.mask = F_EXTRA;
  c.props.extra["measurements"] = annot::encodeMeasurements(list);
  write(c);
  commit();
}

Status Editor::measurementCommand(CommandId id, const CommandArgs& args) {
  const json::Value& raw = args.raw;
  Guid page = args.page != kNoGuid ? args.page : page_;
  if (!doc_.has(page)) return E_NOT_FOUND;
  auto list = measurements(page);
  if (id == CommandId::MEASUREMENT_ADD) {
    annot::Measurement m;
    m.from = argGuid(raw, "from");
    m.to = argGuid(raw, "to");
    if (m.to == kNoGuid) m.to = m.from;
    const json::Value* side = raw.isObject() ? raw.get("side") : nullptr;
    if (!doc_.has(m.from) || !doc_.has(m.to) || !side || !side->isString() || !annot::sideFromName(side->string, m.side)) return E_INVALID;
    if (const json::Value* v = raw.get("toSameSide"); v && v->isBool()) m.toSameSide = v->boolean;
    if (const json::Value* v = raw.get("inner")) m.inner = std::clamp(v->numberOr(0), -1.0, 1.0);
    if (const json::Value* v = raw.get("outer")) m.outer = v->numberOr(0);
    if (const json::Value* v = raw.get("freeText"); v && v->isString()) m.freeText = v->string;
    m.id = newGuid();
    list.push_back(m);
    writeMeasurements(page, list, "Add measurement");
    created_ = {m.id};
    return OK;
  }
  Guid target = argGuid(raw, "id");
  auto it = std::find_if(list.begin(), list.end(), [&](const annot::Measurement& m) { return m.id == target; });
  if (it == list.end()) return E_NOT_FOUND;
  if (id == CommandId::MEASUREMENT_DELETE) {
    list.erase(it);
    writeMeasurements(page, list, "Delete measurement");
    if (dev_.selectedMeasurement == target) {
      dev_.selectedMeasurement = kNoGuid;
      events_.measurementSelection = true;
    }
    return OK;
  }
  if (const json::Value* v = raw.get("freeText"); v && v->isString()) it->freeText = v->string;
  if (const json::Value* v = raw.get("inner")) it->inner = std::clamp(v->numberOr(0), -1.0, 1.0);
  if (const json::Value* v = raw.get("outer")) it->outer = v->numberOr(0);
  writeMeasurements(page, list, "Edit measurement");
  return OK;
}

// ---- editInfo -------------------------------------------------------------------------------------------------------

void Editor::noteEdited(const NodeChange& c) {
  if (c.guid.isDerived()) return;
  if (c.phase == Phase::CHANGED && !(c.mask & ~static_cast<FieldMask>(F_EXTRA))) {
    bool devOnly = true;
    for (auto& [k, v] : c.props.extra) devOnly &= devField(k);
    if (devOnly) return;
  }
  if (c.phase == Phase::REMOVED) {
    // The parent the layer left was edited.
    if (const Node* n = doc_.get(c.guid)) edited_.insert(n->props.parentIndex.guid);
    return;
  }
  edited_.insert(c.guid);
}

void Editor::stampEdited() {
  if (edited_.empty()) return;
  std::unordered_set<Guid, GuidHash> targets;
  for (Guid g : edited_) {
    for (int guard = 0; guard < 4096 && g != kNoGuid; guard++) {
      const Node* n = doc_.get(g);
      if (!n || n->props.type == NodeType::DOCUMENT) break;
      if (!targets.insert(g).second) break;  // its ancestors are in already
      g = n->props.parentIndex.guid;
    }
  }
  edited_.clear();
  double now = std::floor(wallClock());
  std::vector<Guid> order(targets.begin(), targets.end());
  std::sort(order.begin(), order.end());
  // Bookkeeping, not a user edit: no instance overrides (an instance's editInfo is its own), no detaching.
  bool libraryWriteBefore = libraryWrite_;
  libraryWrite_ = true;
  for (Guid g : order) {
    const Node* n = doc_.get(g);
    if (!n) continue;
    json::Value info = extraJson(n->props, "editInfo");
    double created = info.isObject() && info.get("createdAt") ? info.get("createdAt")->numberOr(0) : 0;
    double last = info.isObject() && info.get("lastEditedAt") ? info.get("lastEditedAt")->numberOr(0) : 0;
    if (info.isObject() && last >= now) continue;
    json::Value v;
    v.kind = json::Value::Kind::Object;
    json::Value t;
    t.kind = json::Value::Kind::Number;
    t.number = now;
    v.object.emplace_back("lastEditedAt", t);
    t.number = info.isObject() ? created : now;
    v.object.emplace_back("createdAt", t);
    if (info.isObject())
      if (const json::Value* u = info.get("userId")) v.object.emplace_back("userId", *u);
    NodeChange c = NodeChange::changed(g);
    c.mask = F_EXTRA;
    c.props.extra["editInfo"] = codec::extraFromJson("NodeChange", "editInfo", v);
    write(c);
  }
  libraryWrite_ = libraryWriteBefore;
}

void Editor::noteAnnotated(const NodeChange& c) {
  if (c.guid.isDerived()) return;
  if (c.phase == Phase::REMOVED) {
    annotated_.erase(c.guid);
    return;
  }
  if (c.phase == Phase::CHANGED && !(c.mask & F_EXTRA)) return;
  const Node* n = doc_.get(c.guid);
  if (n && annot::hasNotes(n->props)) annotated_.insert(c.guid);
  else annotated_.erase(c.guid);
}

}  // namespace eng
