// Dev Mode in the engine (docs/research/figma/R9-dev-mode.md "Round 6"): annotation labels and dots, saved
// measurements and the Measurement tool, the Annotation tool's click, statuses on frame titles ("Ready for dev",
// "Completed", the automatic "Changed" from editInfo), focus view, and editInfo stamped on user edits.
//
// Notes and categories are written by the panels (setProps on `annotations` / `annotationCategories`); the engine
// draws them and reports clicks. Measurements are written here (the tool, a drag off the design, Delete) and by the
// MEASUREMENT_* commands.

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <ctime>
#include <functional>
#include <iterator>

#include "editor/Editor.h"
#include "hit/HitTest.h"
#include "hit/Picking.h"
#include "layout/Layout.h"
#include "scene/CodecKiwi.h"

namespace eng {

namespace {

constexpr double kEdgeSnap = 12;
constexpr double kDragThreshold = 3;  // CSS px before a press becomes a drag (tools/Gestures.cpp)  // CSS px: how near an edge the measurement tool picks it

bool devField(const std::string& k) {
  return k == "annotations" || k == "measurements" || k == "annotationCategories" || k == "sectionStatusInfo" || k == "editInfo" || k == "pluginData";
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
  if (!on && viewer_ && (tool_ == Tool::ANNOTATION || tool_ == Tool::MEASUREMENT || tool_ == Tool::EYEDROPPER)) setTool(Tool::MOVE);
  needsRender_ = true;
}

void Editor::setDevInspect(bool on) {
  if (devInspect_ == on) return;
  devInspect_ = on;
  needsRender_ = true;
}

// Dev Mode's inspect chrome (the owner's captures docs/research/figma/live/owner-2026-10-18/figma-devmode-inspect and
// owner-2026-10-19/figma-devmode-{gap,padding}-hatch; Figma's DevHandoffStackMouseBehavior,
// DevHandoffTLFCanvasHighlightBehavior). One layer selected:
// - its design (the page's child holding it, a frame or component) highlighted — Renderer draws the box; a layer inside
//   the design gets its name tag above its top-left corner;
// - the spacing of an auto-layout frame — the one hovered (a Layers row or the canvas) when it is one, else the
//   selection (devInspectSpacing);
// - the size badge as two lines, "W Fixed 678px" / "H Hug 120px" (Fill inside an auto layout — "100%" when it
//   stretches across its parent's flow —, Hug when it hugs; values to 5 decimals, as Figma's "410.66669px").
void Editor::devInspectOverlay(Overlay& o) const {
  Overlay::DevInspect& d = o.devInspect;
  d.on = true;
  if (selection_.size() != 1 || gesture_ != Gesture::None) return;
  const Guid id = selection_[0];
  const Node* n = doc_.get(id);
  if (!n || id == page_) return;
  for (Guid at = id; at != kNoGuid; at = doc_.parentOf(at))
    if (doc_.parentOf(at) == page_) {
      const Node* top = doc_.get(at);
      if (top && top->props.isFrameLike() && top->props.type != NodeType::SECTION) d.frame = at;
      break;
    }
  if (d.frame != kNoGuid && d.frame != id) d.tag = id;
  const NodeProps& p = n->props;
  const Mat2x3 W = doc_.worldTransform(id);

  // The badge's lines.
  auto number = [](double v) {
    char buf[48];
    std::snprintf(buf, sizeof buf, "%.5f", std::round(v * 1e5) / 1e5);
    std::string s = buf;
    while (!s.empty() && s.back() == '0') s.pop_back();
    if (!s.empty() && s.back() == '.') s.pop_back();
    return s == "-0" ? std::string("0") : s;
  };
  const Node* parent = doc_.get(p.parentIndex.guid);
  for (int axis = 0; axis < 2; axis++) {
    std::string how = "Fixed";
    if (parent && parent->props.isAutoLayout() && p.inFlow() && parent->props.stack().stackMode != StackMode::GRID) {
      bool along = (parent->props.stack().stackMode == StackMode::VERTICAL) == (axis == 1);
      if (along ? p.stackChildPrimaryGrow > 0 : p.stackChildAlignSelf == StackCounterAlign::STRETCH) how = along ? "Fill" : "100%";
    }
    if (how == "Fixed" && p.isAutoLayout() && p.stack().stackMode != StackMode::GRID) {
      bool primary = (p.stack().stackMode == StackMode::VERTICAL) == (axis == 1);
      if (primary ? p.hugsPrimary() : p.hugsCounter()) how = "Hug";
    }
    double v = axis == 0 ? p.size.x * std::hypot(W.m00, W.m10) : p.size.y * std::hypot(W.m01, W.m11);
    (axis == 0 ? d.width : d.height) = std::string(axis == 0 ? "W " : "H ") + how + " " + number(v) + "px";
  }

  Guid target = id;
  const Guid hovered = layersHover_.size() == 1 ? layersHover_[0] : layersHover_.empty() ? hover_ : kNoGuid;
  if (hovered != kNoGuid && hovered != id)
    if (const Node* h = doc_.get(hovered); h && h->props.isAutoLayout()) target = hovered;
  devInspectSpacing(target, o);
}

// An auto-layout frame's spacing in Dev Mode: each padding hatched blue ("/") and each gap pink ("\"), a blue pill with
// each value and a line through it across the gap or padding, its flow layers' boxes dotted.
// - Paddings: top and bottom across the frame, left and right between them; a vertical padding's pill on the frame's
//   middle, a horizontal padding's level with the content's middle.
// - A row or column (no wrap): each gap across the content box, its pill at the content's middle.
// - Wrap: the gaps between the layers of each line across that line, the gaps between lines across the content box —
//   their pills level with each line's middle and at the first layer's middle.
// - Grid: the column gaps along the whole grid, the row gaps across it (owner-2026-10-19/figma-devmode-gap-hatch: the
//   bands run the grid's length), a column gap's pill on each row's middle, a row gap's at the first column's middle.
void Editor::devInspectSpacing(Guid frame, Overlay& o) const {
  Overlay::DevInspect& d = o.devInspect;
  const Node* n = doc_.get(frame);
  if (!n || !n->props.isAutoLayout()) return;
  const NodeProps& p = n->props;
  const Mat2x3 W = doc_.worldTransform(frame);
  d.origin = W.apply({0, 0});
  const double w = p.size.x, h = p.size.y;
  double pad[4];  // left, top, right, bottom
  Layout::padding(p, pad);
  const double own[4] = {p.stack().stackPaddingLeft, p.stack().stackPaddingTop, p.stack().stackPaddingRight, p.stack().stackPaddingBottom};
  const bool grid = p.stack().stackMode == StackMode::GRID;
  const bool horizontal = p.stack().stackMode == StackMode::HORIZONTAL;
  const bool wrap = !grid && horizontal && p.stack().stackWrap == StackWrap::WRAP;
  Layout L(const_cast<Editor&>(*this));
  std::vector<Rect> boxes;
  for (Guid c : L.flowChildren(frame)) {
    const Node* cn = doc_.get(c);
    if (!cn || !cn->props.visible) continue;
    boxes.push_back(layoutBox(cn->props.transform, cn->props.size));
  }
  auto quad = [&](const Rect& r, bool gap) {
    Overlay::SpacingArea a;
    a.quad[0] = W.apply({r.x, r.y});
    a.quad[1] = W.apply({r.right(), r.y});
    a.quad[2] = W.apply({r.right(), r.bottom()});
    a.quad[3] = W.apply({r.x, r.bottom()});
    a.gap = gap;
    return a;
  };
  for (const Rect& b : boxes) d.dotted.push_back(quad(b, false));
  // A gap's band, its line across it through `at` and its pill there.
  auto gapAt = [&](const Rect& g, Vec2 at, bool acrossX, double value) {
    if (g.w <= 0 || g.h <= 0) return;
    d.areas.push_back(quad(g, true));
    if (acrossX) d.lines.push_back({W.apply({g.x, at.y}), W.apply({g.right(), at.y})});
    else d.lines.push_back({W.apply({at.x, g.y}), W.apply({at.x, g.bottom()})});
    d.pills.push_back({W.apply(at), annot::formatNumber(value)});
  };
  // The content's middle across the flow (the pills of the side paddings and the gaps' lines sit on it).
  double c0 = 1e300, c1 = -1e300;
  for (const Rect& b : boxes) {
    c0 = std::min(c0, horizontal ? b.y : b.x);
    c1 = std::max(c1, horizontal ? b.bottom() : b.right());
  }
  if (boxes.empty() || grid) c0 = horizontal ? pad[1] : pad[0], c1 = horizontal ? h - pad[3] : w - pad[2];
  const double mid = (c0 + c1) / 2;
  // The paddings, not overlapping: top and bottom across the frame, left and right between them.
  const Rect sides[4] = {{0, pad[1], pad[0], h - pad[1] - pad[3]}, {0, 0, w, pad[1]}, {w - pad[2], pad[1], pad[2], h - pad[1] - pad[3]}, {0, h - pad[3], w, pad[3]}};
  for (int k = 0; k < 4; k++) {
    if (pad[k] <= 0) continue;
    const Rect& r = sides[k];
    if (r.w > 0 && r.h > 0) d.areas.push_back(quad(r, false));
    const bool vertical = k == 1 || k == 3;
    Vec2 at = vertical ? Vec2{w / 2, r.y + r.h / 2} : Vec2{r.x + r.w / 2, horizontal ? mid : h / 2};
    if (vertical) d.lines.push_back({W.apply({w / 2, r.y}), W.apply({w / 2, r.bottom()})});
    else d.lines.push_back({W.apply({r.x, at.y}), W.apply({r.right(), at.y})});
    d.pills.push_back({W.apply(at), annot::formatNumber(own[k])});
  }

  if (grid) {
    Layout::GridCells g = L.gridCells(frame);
    if (g.colX.empty() || g.rowY.empty()) return;
    const double left = g.colX.front(), right = g.colX.back() + g.colW.back();
    const double top = g.rowY.front(), bottom = g.rowY.back() + g.rowH.back();
    // The row gaps across the grid; the column gaps in pieces between them (the bands never overlap).
    for (size_t r = 1; r < g.rowY.size(); r++) {
      double y0 = g.rowY[r - 1] + g.rowH[r - 1], y1 = g.rowY[r];
      gapAt({left, y0, right - left, y1 - y0}, {g.colX[0] + g.colW[0] / 2, (y0 + y1) / 2}, false, y1 - y0);
    }
    for (size_t c = 1; c < g.colX.size(); c++) {
      double x0 = g.colX[c - 1] + g.colW[c - 1], x1 = g.colX[c];
      for (size_t r = 0; r < g.rowY.size(); r++) {
        double y0 = r == 0 ? top : g.rowY[r], y1 = r + 1 == g.rowY.size() ? bottom : g.rowY[r] + g.rowH[r];
        gapAt({x0, y0, x1 - x0, y1 - y0}, {(x0 + x1) / 2, g.rowY[r] + g.rowH[r] / 2}, true, x1 - x0);
      }
    }
    return;
  }

  const bool between = p.stack().stackPrimaryAlignItems == StackJustify::SPACE_BETWEEN;
  if (wrap) {
    // The lines: a layer starting left of the one before it starts a line.
    std::vector<std::vector<Rect>> lines;
    for (const Rect& b : boxes) {
      if (lines.empty() || b.x <= lines.back().back().x) lines.emplace_back();
      lines.back().push_back(b);
    }
    std::vector<std::pair<double, double>> spans;  // each line's top and bottom
    for (const auto& line : lines) {
      double t = 1e300, b = -1e300;
      for (const Rect& r : line) t = std::min(t, r.y), b = std::max(b, r.bottom());
      spans.push_back({t, b});
    }
    for (size_t l = 0; l < lines.size(); l++) {
      const double lineMid = (spans[l].first + spans[l].second) / 2;
      for (size_t i = 1; i < lines[l].size(); i++) {
        const Rect& a = lines[l][i - 1];
        const Rect& b = lines[l][i];
        Rect g{std::min(a.right(), b.x), spans[l].first, std::fabs(b.x - a.right()), spans[l].second - spans[l].first};
        gapAt(g, {g.x + g.w / 2, lineMid}, true, between ? g.w : p.stack().stackSpacing);
      }
      if (l == 0) continue;
      const double y0 = spans[l - 1].second, y1 = spans[l].first;
      const bool auto_ = p.stack().stackCounterAlignContent == StackCounterAlignContent::SPACE_BETWEEN;
      const Rect& first = lines[0][0];
      gapAt({pad[0], y0, w - pad[0] - pad[2], y1 - y0}, {first.x + first.w / 2, (y0 + y1) / 2}, false,
            auto_ ? y1 - y0 : p.stack().stackCounterSpacing.value_or(p.stack().stackSpacing));
    }
    return;
  }
  for (size_t i = 1; i < boxes.size(); i++) {
    const Rect& a = boxes[i - 1];
    const Rect& b = boxes[i];
    Rect g = horizontal ? Rect{std::min(a.right(), b.x), pad[1], std::fabs(b.x - a.right()), h - pad[1] - pad[3]}
                        : Rect{pad[0], std::min(a.bottom(), b.y), w - pad[0] - pad[2], std::fabs(b.y - a.bottom())};
    double value = between ? (horizontal ? g.w : g.h) : p.stack().stackSpacing;
    gapAt(g, horizontal ? Vec2{g.x + g.w / 2, mid} : Vec2{mid, g.y + g.h / 2}, horizontal, value);
  }
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

void Editor::setAnnotationFilter(Guid category) {
  if (dev_.category == category) return;
  dev_.category = category;
  dev_.openNode = kNoGuid;
  needsRender_ = true;
}

Status Editor::setFocus(Guid id) {
  if (id != kNoGuid && !doc_.has(id)) return E_NOT_FOUND;
  if (dev_.focus == id) return OK;
  dev_.focus = id;
  // The design in focus is its own canvas: what lies off its box is hit (and drawn) there (docs/social.md §32)
  setOpenFrame(id);
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

int Editor::workflowStatus(Guid id) const {
  static constexpr const char* kIds[] = {"", "done", "r-to-merge", "ready-to-dev", "to-be-done", "process", "revised", "cancelled"};
  const Node* n = doc_.get(id);
  if (!n) return 0;
  if (n->props.extra.find("pluginData") != n->props.extra.end()) {
    json::Value entries = extraJson(n->props, "pluginData");
    for (const json::Value& e : entries.isArray() ? entries.array : std::vector<json::Value>{}) {
      const json::Value* plugin = e.isObject() ? e.get("pluginID") : nullptr;
      const json::Value* key = e.isObject() ? e.get("key") : nullptr;
      const json::Value* value = e.isObject() ? e.get("value") : nullptr;
      if (!plugin || !key || !value || !plugin->isString() || !key->isString() || !value->isString()) continue;
      if (plugin->string != "designer.workflow" || key->string != "status") continue;
      for (int i = 1; i <= kWorkflowCount; i++)
        if (value->string == kIds[i]) return i;
      return 0;
    }
  }
  // A file with only Figma's status (an imported .fig): Ready for dev is Ready to Dev, Completed is Done.
  if (n->props.extra.find("sectionStatusInfo") == n->props.extra.end()) return 0;
  json::Value info = extraJson(n->props, "sectionStatusInfo");
  const json::Value* st = info.isObject() ? info.get("status") : nullptr;
  if (!st || !st->isString()) return 0;
  return st->string == "BUILD" ? kWorkflowReadyToDev : st->string == "COMPLETED" ? kWorkflowDone : 0;
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
  d.iconHover = devIconHover_;
  d.tooltip = devTooltip_;
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

  // Statuses in the designs' titles (docs/editor.md "Frame status (ours)": the owner's statuses replace Ready for
  // dev's indicator) — top-level frames, sections and the frames directly in them. Design mode: the chip where Ready
  // for dev's `</>` button is, at the top right (round 15, the owner's recording at 20–22 s), in Dev Mode too (the owner,
  // 2026-10-28); sections: after the name. A Ready to Dev design edited since it was marked: Figma's "Changed" after its name. On a selected
  // frame or component without one, the `</>` at its top right, which opens the status menu (live Figma,
  // canvas-autolayout-selected-hover-gap / canvas-grid-frame-selected).
  std::function<void(Guid, int)> walk = [&](Guid parent, int depth) {
    for (Guid c : doc_.children(parent)) {
      const Node* n = doc_.get(c);
      if (!n || !n->props.visible || !n->props.isFrameLike()) continue;
      const bool section = n->props.type == NodeType::SECTION;
      if (dev_.focus == kNoGuid || c == dev_.focus) {
        int wf = workflowStatus(c);
        DevStatusMark mark;
        mark.frame = c;
        if (wf == kWorkflowReadyToDev && devStatus(c) == 3) {
          mark.kind = DevStatusMark::Kind::Changed;
          mark.workflow = static_cast<uint8_t>(wf);
          mark.trailing = true;
          d.statuses.push_back(mark);
        } else if (wf) {
          mark.workflow = static_cast<uint8_t>(wf);
          // Dev Mode too (the owner, 2026-10-28): its square at the top right, as in Design mode; a section's after its pill.
          mark.trailing = section;
          d.statuses.push_back(mark);
        } else if (canEditDev() && n->props.type != NodeType::INSTANCE && !section && selected(c)) {
          // (A selected section shows no `</>`: live Figma, canvas-section-selected — Group 1. Its status is set from
          // the Design panel's header.)
          mark.kind = DevStatusMark::Kind::MarkButton;
          d.statuses.push_back(mark);
        }
      }
      if (section && depth == 0) walk(c, depth + 1);
    }
  };
  walk(page_, 0);

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
      if (dev_.category != kNoGuid && note.category != dev_.category) continue;
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

void Editor::devIconHoverAt(Vec2 s) {
  // The `</>` button or a status's square under the pointer: filled / its "…" while hovered; its tooltip after the
  // tooltip delay (tick). Its hit boxes are where the last frame drew them.
  Guid over = kNoGuid;
  if (gesture_ == Gesture::None && !spaceHeld_)
    for (const CanvasHits::Status& h : hits_.statuses)
      if ((h.kind == DevStatusMark::Kind::MarkButton || h.kind == DevStatusMark::Kind::Workflow) && h.contains(s)) over = h.frame;
  if (over == devIconHover_) return;
  devIconHover_ = over;
  devIconSince_ = -1;
  devTooltip_ = false;
  devIconPressed_ = false;
  needsRender_ = true;
}

int32_t Editor::chromeDelay() const {
  int32_t bars = scrollbarDelay();  // round 16: the scrollbars fading
  if (devIconHover_ == kNoGuid || devTooltip_ || devIconPressed_) return bars;
  int32_t tip = devIconSince_ < 0 ? 16 : static_cast<int32_t>(std::max(1.0, std::ceil(devIconSince_ + kTooltipDelayMs - timeMs_)));
  return bars < 0 ? tip : std::min(bars, tip);
}

void Editor::devHover(Vec2 s) {
  devIconHoverAt(s);
  bool had = dev_.hasEdge;
  Guid node = dev_.edgeNode;
  annot::Side side = dev_.edgeSide;
  dev_.hasEdge = tool_ == Tool::MEASUREMENT && gesture_ == Gesture::None && canEditDev() && edgeAt(s, 0, dev_.edgeNode, dev_.edgeSide);
  if (had != dev_.hasEdge || node != dev_.edgeNode || side != dev_.edgeSide) needsRender_ = true;
}

uint32_t Editor::devPointerDown(Vec2 s, uint32_t mods) {
  // A design's status chip, or "Mark as ready for dev".
  for (const CanvasHits::Status& h : hits_.statuses) {
    if (!h.contains(s)) continue;
    if (h.kind == DevStatusMark::Kind::MarkButton && !canEditDev()) continue;
    devTooltip_ = false;
    devIconSince_ = -1;
    devIconPressed_ = devIconHover_ != kNoGuid;
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
  scoped_.insert(c.guid);
}

// ---- editScopeInfo (Figma's NodeChange 365, canvas.md §2.9) ----------------------------------------------------------

namespace {

const char* scopeTypeName(Editor::EditScopeType t) {
  static const char* const kNames[] = {"INVALID", "TEST_SETUP", "USER", "PLUGIN", "SYSTEM", "REST_API", "ONBOARDING", "AUTOSAVE", "AI"};
  size_t i = static_cast<size_t>(t);
  return i < std::size(kNames) ? kNames[i] : "INVALID";
}

}  // namespace

Status Editor::editScopePush(EditScopeType type, std::string label) {
  using T = EditScopeType;
  auto fail = [&](Status st, std::string message) {
    editScopeError_ = std::move(message);
    return st;
  };
  if (type == T::INVALID || static_cast<uint8_t>(type) > static_cast<uint8_t>(T::AI)) return fail(E_INVALID, "Invalid edit scope type");
  auto inside = [&](std::initializer_list<T> outer) {
    for (const auto& [t, l] : editScopes_)
      for (T o : outer)
        if (t == o) return t;
    return T::INVALID;
  };
  for (const auto& [t, l] : editScopes_)
    if (t == type) return fail(E_INVALID, std::string("Cannot push a ") + scopeTypeName(type) + " edit scope: one is already on the stack");
  T bad = T::INVALID;
  switch (type) {
    case T::TEST_SETUP:
      if (!editScopes_.empty()) return fail(E_INVALID, "A TEST_SETUP edit scope must be the first scope");
      break;
    case T::AUTOSAVE:
      if (!editScopes_.empty()) return fail(E_INVALID, "An AUTOSAVE edit scope is not allowed inside another scope");
      break;
    case T::USER: bad = inside({T::PLUGIN, T::SYSTEM, T::REST_API, T::ONBOARDING, T::AI}); break;
    case T::PLUGIN: bad = inside({T::SYSTEM, T::REST_API, T::AI}); break;
    case T::REST_API: bad = inside({T::USER, T::PLUGIN, T::SYSTEM, T::ONBOARDING, T::AI}); break;
    case T::ONBOARDING: bad = inside({T::USER, T::PLUGIN, T::SYSTEM, T::REST_API, T::AI}); break;
    case T::AI: bad = inside({T::SYSTEM, T::REST_API, T::ONBOARDING}); break;
    default: break;
  }
  if (bad != T::INVALID) return fail(E_INVALID, std::string(scopeTypeName(type)) + " edit scope is not allowed inside " + scopeTypeName(bad) + " edit scope");
  editScopes_.emplace_back(type, std::move(label));
  return OK;
}

Status Editor::editScopePop() {
  if (editScopes_.empty()) {
    editScopeError_ = "No edit scope to pop";
    return E_INVALID;
  }
  editScopes_.pop_back();
  return OK;
}

void Editor::stampScopes() {
  if (scoped_.empty()) return;
  // The stack the step was made in: the pushed scopes, else the transaction's own.
  std::vector<std::pair<EditScopeType, std::string>> stack = editScopes_;
  if (stack.empty()) stack.emplace_back(txn_.run ? EditScopeType::PLUGIN : actor_ != 0 ? EditScopeType::AI : EditScopeType::USER, txn_.label);
  json::Value frames;
  frames.kind = json::Value::Kind::Array;
  for (const auto& [t, label] : stack) {
    json::Value f;
    f.kind = json::Value::Kind::Object;
    json::Value s;
    s.kind = json::Value::Kind::String;
    s.string = scopeTypeName(t);
    f.object.emplace_back("type", s);
    if (!label.empty()) {
      s.string = label;
      f.object.emplace_back("label", s);
    }
    s.string = "DESIGN";
    f.object.emplace_back("editorType", s);
    frames.array.push_back(std::move(f));
  }
  json::Value stackMsg;
  stackMsg.kind = json::Value::Kind::Object;
  stackMsg.object.emplace_back("stack", std::move(frames));
  json::Value stacks;
  stacks.kind = json::Value::Kind::Array;
  stacks.array.push_back(std::move(stackMsg));
  json::Value info;
  info.kind = json::Value::Kind::Object;
  info.object.emplace_back("editScopeStacks", std::move(stacks));
  std::string bytes = codec::extraFromJson("NodeChange", "editScopeInfo", info);
  std::vector<Guid> order(scoped_.begin(), scoped_.end());
  scoped_.clear();
  if (bytes.empty()) return;
  std::sort(order.begin(), order.end());
  // Bookkeeping, as editInfo: no instance overrides, no detaching.
  bool libraryWriteBefore = libraryWrite_;
  libraryWrite_ = true;
  for (Guid g : order) {
    const Node* n = doc_.get(g);
    if (!n || n->props.type == NodeType::DOCUMENT) continue;
    auto it = n->props.extra.find("editScopeInfo");
    if (it != n->props.extra.end() && it->second == bytes) continue;
    NodeChange c = NodeChange::changed(g);
    c.mask = F_EXTRA;
    c.props.extra["editScopeInfo"] = bytes;
    write(c);
  }
  libraryWrite_ = libraryWriteBefore;
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
