// Grid auto layout on the canvas (docs/research/figma/R9-grid-auto-layout.md "Round 6"): a selected grid's track
// pills along its top (columns) and left (rows) edges — hover shows a pill's label and its grabber; a click selects
// the track (⌘ adds one, ⇧ a range) and asks TS to edit its label (GRID_TRACKS {edit}); dragging a pill's edge
// resizes that track (it becomes Fixed); dragging the grabber reorders the selected tracks (with the tracks the items
// spanning them cover; a blue line marks the drop); ⌫ deletes the selected tracks (their items go, spanning items
// shrink); Enter edits them; Esc lets them go. A grid item's span handles (small circles on its four sides) drag its
// span to a cell edge (the axis becomes Fill container).

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <set>
#include <string>

#include "base/FractionalIndex.h"
#include "editor/Editor.h"
#include "layout/Layout.h"
#include "render/OverlayStyle.h"

namespace eng {

namespace {

constexpr double kBand = 16;       // CSS px outside the edge: the pills' band
constexpr double kPillGap = 8;     // the pill's distance from the edge (Overlay.cpp)
constexpr double kPillThick = 4;
constexpr double kEdgeReach = 4;   // CSS px around a track's edge
constexpr double kGrabberW = 10, kGrabberH = 14;
constexpr double kSpanReach = 6;   // CSS px around a span handle

bool axisAligned(const Mat2x3& m) { return std::fabs(m.m01) < 1e-9 && std::fabs(m.m10) < 1e-9 && m.m00 > 0 && m.m11 > 0; }

}  // namespace

// The label badge's width for a track label (Overlay.cpp draws the badge this wide, so hit tests agree).
double gridBadgeWidth(const std::string& label, double padding) {
  return std::round(6.2 * static_cast<double>(label.size()) + 2 * padding + 2);
}

Guid Editor::gridFrameSelected() const {
  if (selection_.size() != 1 || text_.node != kNoGuid || viewer_ || tool_ != Tool::MOVE) return kNoGuid;
  const Node* n = doc_.get(selection_[0]);
  if (!n || n->props.stack().stackMode != StackMode::GRID || !n->props.isAutoLayout() || selection_[0].isDerived()) return kNoGuid;
  if (!axisAligned(doc_.worldTransform(selection_[0]))) return kNoGuid;
  return selection_[0];
}

// Screen geometry of a grid's tracks: [start, end) along the axis, the pill's centre line across it.
void Editor::gridTrackSpans(Guid frame, bool column, std::vector<std::pair<double, double>>& spans, double& across) const {
  spans.clear();
  Layout L(*const_cast<Editor*>(this));
  Layout::GridCells g = L.gridCells(frame);
  Mat2x3 W = doc_.worldTransform(frame);
  auto scr = [&](Vec2 local) { return camera_.toScreen(W.apply(local)); };
  if (column) {
    for (size_t i = 0; i < g.colX.size(); i++) spans.push_back({scr({g.colX[i], 0}).x, scr({g.colX[i] + g.colW[i], 0}).x});
    across = scr({0, 0}).y - kPillGap - kPillThick / 2;
  } else {
    for (size_t i = 0; i < g.rowY.size(); i++) spans.push_back({scr({0, g.rowY[i]}).y, scr({0, g.rowY[i] + g.rowH[i]}).y});
    across = scr({0, 0}).x - kPillGap - kPillThick / 2;
  }
}

Editor::GridHit Editor::gridHitAt(Vec2 s) const {
  GridHit h;
  Guid frame = gridFrameSelected();
  if (frame == kNoGuid) return h;
  const OverlayStyle& style = OverlayStyle::of(theme_);
  Layout L(*const_cast<Editor*>(this));
  Layout::GridCells cells = L.gridCells(frame);
  for (bool column : {true, false}) {
    std::vector<std::pair<double, double>> spans;
    double across = 0;
    gridTrackSpans(frame, column, spans, across);
    double along = column ? s.x : s.y, off = column ? s.y : s.x;
    if (off < across - kBand / 2 - 2 || off > across + kBand / 2) continue;
    if (spans.empty() || along < spans.front().first - kEdgeReach || along > spans.back().second + kEdgeReach) continue;
    // A track's edge: between two tracks (the middle of the gap), or the last one's end.
    for (size_t i = 0; i < spans.size(); i++) {
      double edge = i + 1 < spans.size() ? (spans[i].second + spans[i + 1].first) / 2 : spans[i].second;
      if (std::fabs(along - edge) <= kEdgeReach) {
        h.kind = GridHit::Kind::Edge;
        h.column = column;
        h.track = i;
        return h;
      }
    }
    for (size_t i = 0; i < spans.size(); i++) {
      if (along < spans[i].first - 1 || along > spans[i].second + 1) continue;
      h.column = column;
      h.track = i;
      // The grabber, just before the label (shown on the hovered / selected track).
      const std::string& label = column ? cells.colLabels[i] : cells.rowLabels[i];
      double mid = (spans[i].first + spans[i].second) / 2;
      double half = (column ? gridBadgeWidth(label, style.badgePadding) : style.badgeHeight) / 2;
      double g0 = mid - half - 2 - (column ? kGrabberW : kGrabberH), g1 = mid - half - 2;
      h.kind = along >= g0 - 1 && along <= g1 + 1 ? GridHit::Kind::Grabber : GridHit::Kind::Track;
      return h;
    }
  }
  return h;
}

// A selected grid item's span handles: the midpoints of its four sides (screen), in the order left, top, right, bottom.
bool Editor::gridSpanHandles(Guid& item, Vec2 out[4]) const {
  if (selection_.size() != 1 || viewer_ || tool_ != Tool::MOVE || text_.node != kNoGuid) return false;
  item = selection_[0];
  if (item.isDerived()) return false;
  const Node* n = doc_.get(item);
  const Node* parent = doc_.get(doc_.parentOf(item));
  if (!n || !parent || parent->props.stack().stackMode != StackMode::GRID || !parent->props.isAutoLayout()) return false;
  if (n->props.stackPositioning == StackPositioning::ABSOLUTE || !n->props.visible) return false;
  Mat2x3 W = doc_.worldTransform(item);
  if (!axisAligned(W)) return false;
  Vec2 a = camera_.toScreen(W.apply({0, 0})), b = camera_.toScreen(W.apply(n->props.size));
  if (b.x - a.x < 24 || b.y - a.y < 24) return false;  // too small on screen to hold them apart from the resize handles
  out[0] = {a.x, (a.y + b.y) / 2};
  out[1] = {(a.x + b.x) / 2, a.y};
  out[2] = {b.x, (a.y + b.y) / 2};
  out[3] = {(a.x + b.x) / 2, b.y};
  return true;
}

int Editor::gridSpanHandleAt(Vec2 s) const {
  Guid item;
  Vec2 hs[4];
  if (!gridSpanHandles(item, hs)) return -1;
  for (int i = 0; i < 4; i++)
    if ((s - hs[i]).length() <= kSpanReach) return i;
  return -1;
}

void Editor::setGridTrackSelection(Guid frame, bool column, std::vector<size_t> tracks, bool edit) {
  std::sort(tracks.begin(), tracks.end());
  tracks.erase(std::unique(tracks.begin(), tracks.end()), tracks.end());
  bool changed = gridSel_.frame != frame || gridSel_.column != column || gridSel_.tracks != tracks;
  gridSel_.frame = tracks.empty() ? kNoGuid : frame;
  gridSel_.column = column;
  gridSel_.tracks = std::move(tracks);
  if (!changed && !edit) return;
  GridTracksEvent ev;
  ev.frame = gridSel_.frame;
  ev.column = column;
  ev.tracks = gridSel_.tracks;
  ev.edit = edit && !gridSel_.tracks.empty();
  if (ev.edit) {
    // The label of the first selected track, where TS opens its editor (screen).
    std::vector<std::pair<double, double>> spans;
    double across = 0;
    gridTrackSpans(frame, column, spans, across);
    size_t i = gridSel_.tracks.front();
    if (i < spans.size()) {
      const OverlayStyle& style = OverlayStyle::of(theme_);
      double mid = (spans[i].first + spans[i].second) / 2;
      double h = style.badgeHeight;
      ev.label = column ? Rect{mid - 30, across - h / 2, 60, h} : Rect{across - 30, mid - h / 2, 60, h};
    }
  }
  events_.gridTracks.push_back(std::move(ev));
  needsRender_ = true;
}

void Editor::clearGridTrackSelection() {
  if (gridSel_.frame != kNoGuid || !gridSel_.tracks.empty()) setGridTrackSelection(kNoGuid, true, {}, false);
}

// The Grid panel's rows (round 8): the selected grid's tracks along an axis, as a pill click selects them ([] clears).
Status Editor::selectGridTracksCommand(const CommandArgs& args) {
  const json::Value& raw = args.raw;
  Guid frame = gridFrameSelected();
  if (frame == kNoGuid || !raw.isObject()) return E_INVALID;
  if (const json::Value* f = raw.get("frame"); f && f->isString()) {
    size_t colon = f->string.find(':');
    if (colon == std::string::npos) return E_INVALID;
    Guid want{static_cast<uint32_t>(std::strtoul(f->string.substr(0, colon).c_str(), nullptr, 10)),
              static_cast<uint32_t>(std::strtoul(f->string.substr(colon + 1).c_str(), nullptr, 10))};
    if (want != frame) return E_INVALID;
  }
  const json::Value* axis = raw.get("axis");
  bool column = !(axis && axis->isString() && axis->string == "ROWS");
  std::vector<std::pair<double, double>> spans;
  double across = 0;
  gridTrackSpans(frame, column, spans, across);
  std::vector<size_t> tracks;
  if (const json::Value* t = raw.get("tracks"); t && t->isArray())
    for (const auto& v : t->array)
      if (v.isNumber() && v.number >= 0 && static_cast<size_t>(v.number) < spans.size()) tracks.push_back(static_cast<size_t>(v.number));
  if (tracks.empty()) clearGridTrackSelection();
  else setGridTrackSelection(frame, column, std::move(tracks), false);
  return OK;
}

uint32_t Editor::gridPointerDown(Vec2 s, uint32_t mods) {
  // The span handles of a selected grid item.
  if (int edge = gridSpanHandleAt(s); edge >= 0) {
    Guid item = selection_[0];
    Guid frame = doc_.parentOf(item);
    Layout L(*this);
    Layout::GridCells g = L.gridCells(frame);
    for (const auto& it : g.items)
      if (it.id == item) {
        gridDrag_ = {};
        gridDrag_.kind = GridDrag::Kind::Span;
        gridDrag_.item = item;
        gridDrag_.frame = frame;
        gridDrag_.edge = edge;
        gridDrag_.column = edge == 0 || edge == 2;
        gridDrag_.start = gridDrag_.column ? it.col : it.row;
        gridDrag_.span = gridDrag_.column ? it.colSpan : it.rowSpan;
        gesture_ = Gesture::Grid;
        return P_HANDLED | P_CAPTURE;
      }
    return 0;
  }
  GridHit h = gridHitAt(s);
  Guid frame = gridFrameSelected();
  if (h.kind == GridHit::Kind::None) {
    clearGridTrackSelection();
    return 0;
  }
  gridDrag_ = {};
  gridDrag_.frame = frame;
  gridDrag_.column = h.column;
  gridDrag_.track = h.track;
  if (h.kind == GridHit::Kind::Edge) {
    Layout L(*this);
    Layout::GridCells g = L.gridCells(frame);
    gridDrag_.kind = GridDrag::Kind::Resize;
    gridDrag_.startSize = h.column ? g.colW[h.track] : g.rowH[h.track];
    gesture_ = Gesture::Grid;
    return P_HANDLED | P_CAPTURE;
  }
  // A track: selected now (⌘ adds or removes it, ⇧ a range from the last one), its label edited on release.
  bool same = gridSel_.frame == frame && gridSel_.column == h.column;
  std::vector<size_t> next;
  if ((mods & MOD_PRIMARY) && same) {
    next = gridSel_.tracks;
    auto it = std::find(next.begin(), next.end(), h.track);
    if (it != next.end()) next.erase(it);
    else next.push_back(h.track);
  } else if ((mods & MOD_SHIFT) && same && !gridSel_.tracks.empty()) {
    size_t a = std::min(gridSel_.tracks.front(), h.track), b = std::max(gridSel_.tracks.back(), h.track);
    for (size_t i = a; i <= b; i++) next.push_back(i);
  } else if (same && h.kind == GridHit::Kind::Grabber &&
             std::find(gridSel_.tracks.begin(), gridSel_.tracks.end(), h.track) != gridSel_.tracks.end()) {
    next = gridSel_.tracks;  // dragging a selection by one of its grabbers
  } else {
    next = {h.track};
  }
  setGridTrackSelection(frame, h.column, next, false);
  gridDrag_.kind = h.kind == GridHit::Kind::Grabber ? GridDrag::Kind::Reorder : GridDrag::Kind::Select;
  gridDrag_.edit = !(mods & (MOD_PRIMARY | MOD_SHIFT));
  gesture_ = Gesture::Grid;
  changeCursor(h.kind == GridHit::Kind::Grabber ? CursorKind::GRABBING : CursorKind::DEFAULT);
  return P_HANDLED | P_CAPTURE;
}

void Editor::writeGridTracks(Guid frame, bool column, const std::vector<Layout::GridTrackDef>& tracks) {
  NodeChange c = NodeChange::changed(frame);
  c.mask = F_EXTRA;
  c.props.extra = doc_.get(frame)->props.extra;
  Layout::setGridTrackDefs(c.props, column, tracks);
  write(c);
  layoutDirty_.insert(frame);
}

void Editor::gridPointerMove(Vec2 s, uint32_t /*mods*/) {
  const Node* fn = doc_.get(gridDrag_.frame);
  if (!fn) return;
  double zoom = std::max(1e-6, camera_.zoom);
  double delta = (gridDrag_.column ? s.x - downScreen_.x : s.y - downScreen_.y) / zoom;
  switch (gridDrag_.kind) {
    case GridDrag::Kind::Resize: {
      if (!gridDrag_.moved && (s - downScreen_).length() < 1) return;
      if (!gridDrag_.moved) begin(TxnKind::GESTURE, "Resize track");
      gridDrag_.moved = true;
      std::vector<Layout::GridTrackDef> tracks = Layout::gridTrackDefs(fn->props, gridDrag_.column);
      if (gridDrag_.track >= tracks.size()) return;
      tracks[gridDrag_.track].sizing = 1;  // FIXED (Figma: dragging an edge makes the track fixed)
      tracks[gridDrag_.track].value = std::max(1.0, std::round(gridDrag_.startSize + delta));
      writeGridTracks(gridDrag_.frame, gridDrag_.column, tracks);
      flushLayout();
      changeCursor(CursorKind::RESIZE, gridDrag_.column ? 0 : 90);
      needsRender_ = true;
      return;
    }
    case GridDrag::Kind::Reorder: {
      if (!gridDrag_.moved && (s - downScreen_).length() < 3) return;
      gridDrag_.moved = true;
      std::vector<std::pair<double, double>> spans;
      double across = 0;
      gridTrackSpans(gridDrag_.frame, gridDrag_.column, spans, across);
      double along = gridDrag_.column ? s.x : s.y;
      // The boundary nearest the pointer: before track i (i = count: after the last).
      size_t best = 0;
      double bestD = 1e300;
      for (size_t i = 0; i <= spans.size(); i++) {
        double at = i == 0 ? spans.front().first : i == spans.size() ? spans.back().second : (spans[i - 1].second + spans[i].first) / 2;
        if (std::fabs(along - at) < bestD) bestD = std::fabs(along - at), best = i;
      }
      gridDrag_.dropAt = best;
      changeCursor(CursorKind::GRABBING);
      needsRender_ = true;
      return;
    }
    case GridDrag::Kind::Span: {
      if (!gridDrag_.moved && (s - downScreen_).length() < 1) return;
      Layout L(*this);
      Layout::GridCells g = L.gridCells(gridDrag_.frame);
      Mat2x3 W = doc_.worldTransform(gridDrag_.frame);
      Vec2 q = W.inverse().apply(camera_.toWorld(s));
      const std::vector<double>& at = gridDrag_.column ? g.colX : g.rowY;
      const std::vector<double>& sz = gridDrag_.column ? g.colW : g.rowH;
      size_t n = at.size();
      if (!n) return;
      double v = gridDrag_.column ? q.x : q.y;
      // The cell edge nearest the pointer: boundary k = the start of track k (k = n: the end of the last).
      size_t k = 0;
      double bestD = 1e300;
      for (size_t i = 0; i <= n; i++) {
        double b = i < n ? at[i] : at[n - 1] + sz[n - 1];
        if (std::fabs(v - b) < bestD) bestD = std::fabs(v - b), k = i;
      }
      size_t start = gridDrag_.start, end = gridDrag_.start + gridDrag_.span;
      bool leading = gridDrag_.edge == 0 || gridDrag_.edge == 1;
      if (leading) start = std::min(k, end - 1);
      else end = std::max(k, start + 1);
      if (!gridDrag_.moved) begin(TxnKind::GESTURE, "Change span");
      gridDrag_.moved = true;
      const Node* item = doc_.get(gridDrag_.item);
      if (!item) return;
      NodeChange c = NodeChange::changed(gridDrag_.item);
      c.mask = F_EXTRA;
      c.props.extra = item->props.extra;
      c.props.extra[gridDrag_.column ? "gridColumnSpan" : "gridRowSpan"] = Layout::gridSpanBytes(gridDrag_.column, static_cast<uint32_t>(end - start));
      const std::vector<Guid>& ids = gridDrag_.column ? g.colIds : g.rowIds;
      if (!g.reflow && start < ids.size() && ids[start] != kNoGuid) {
        c.props.extra[gridDrag_.column ? "gridColumnAnchor" : "gridRowAnchor"] = Layout::gridAnchorBytes(gridDrag_.column, ids[start]);
        // The other axis keeps its cell (anchored from where the layout put it).
        const std::vector<Guid>& other = gridDrag_.column ? g.rowIds : g.colIds;
        for (const auto& it : g.items)
          if (it.id == gridDrag_.item) {
            size_t o = gridDrag_.column ? it.row : it.col;
            if (o < other.size() && other[o] != kNoGuid)
              c.props.extra[gridDrag_.column ? "gridRowAnchor" : "gridColumnAnchor"] = Layout::gridAnchorBytes(!gridDrag_.column, other[o]);
          }
      }
      write(c);
      // Spanning needs Fill container on that axis (Figma: snapping to a cell edge sets it).
      if (gridDrag_.column && item->props.stackChildPrimaryGrow <= 0) {
        NodeChange f = NodeChange::changed(gridDrag_.item);
        f.mask = F_STACK_CHILD_GROW;
        f.props.stackChildPrimaryGrow = 1;
        write(f);
      } else if (!gridDrag_.column && item->props.stackChildAlignSelf != StackCounterAlign::STRETCH) {
        NodeChange f = NodeChange::changed(gridDrag_.item);
        f.mask = F_STACK_CHILD_ALIGN_SELF;
        f.props.stackChildAlignSelf = StackCounterAlign::STRETCH;
        write(f);
      }
      layoutDirty_.insert(gridDrag_.frame);
      flushLayout();
      needsRender_ = true;
      return;
    }
    default: return;
  }
}

std::vector<size_t> Editor::gridMovingTracks(Guid frame, bool column, std::vector<size_t> tracks) {
  // Tracks an item spans move together: the set grows until no item straddles its border.
  Layout L(*this);
  Layout::GridCells g = L.gridCells(frame);
  std::set<size_t> set(tracks.begin(), tracks.end());
  for (bool grew = true; grew;) {
    grew = false;
    for (const auto& it : g.items) {
      size_t a = column ? it.col : it.row, n = column ? it.colSpan : it.rowSpan;
      if (n < 2) continue;
      bool any = false, all = true;
      for (size_t k = a; k < a + n; k++) {
        bool in = set.count(k) != 0;
        any |= in;
        all &= in;
      }
      if (any && !all)
        for (size_t k = a; k < a + n; k++) grew |= set.insert(k).second;
    }
  }
  return {set.begin(), set.end()};
}

void Editor::gridPointerUp(Vec2 /*s*/, uint32_t /*mods*/) {
  GridDrag d = gridDrag_;
  gridDrag_ = {};
  switch (d.kind) {
    case GridDrag::Kind::Resize:
    case GridDrag::Kind::Span:
      if (d.moved) commit();
      break;
    case GridDrag::Kind::Select:
      if (d.edit) setGridTrackSelection(d.frame, d.column, gridSel_.tracks, true);
      break;
    case GridDrag::Kind::Reorder: {
      if (!d.moved) {
        setGridTrackSelection(d.frame, d.column, gridSel_.tracks, true);
        break;
      }
      const Node* fn = doc_.get(d.frame);
      if (!fn) break;
      std::vector<Layout::GridTrackDef> tracks = Layout::gridTrackDefs(fn->props, d.column);
      std::vector<size_t> moving = gridMovingTracks(d.frame, d.column, gridSel_.tracks);
      moving.erase(std::remove_if(moving.begin(), moving.end(), [&](size_t i) { return i >= tracks.size(); }), moving.end());
      if (moving.empty()) break;
      std::vector<Layout::GridTrackDef> rest, moved;
      size_t before = 0;
      for (size_t i = 0; i < tracks.size(); i++) {
        if (std::find(moving.begin(), moving.end(), i) != moving.end()) moved.push_back(tracks[i]);
        else rest.push_back(tracks[i]);
        if (i < d.dropAt && std::find(moving.begin(), moving.end(), i) == moving.end()) before++;
      }
      std::vector<Layout::GridTrackDef> order(rest.begin(), rest.begin() + static_cast<long>(before));
      order.insert(order.end(), moved.begin(), moved.end());
      order.insert(order.end(), rest.begin() + static_cast<long>(before), rest.end());
      bool same = true;
      for (size_t i = 0; i < order.size(); i++) same &= order[i].id == tracks[i].id;
      if (same) break;
      std::string key;
      for (auto& t : order) key = t.position = fractional::keyBetween(key, std::nullopt, fractional::Bias::High);
      begin(TxnKind::USER, d.column ? "Reorder columns" : "Reorder rows");
      writeGridTracks(d.frame, d.column, order);
      commit();
      std::vector<size_t> sel;
      for (size_t i = 0; i < order.size(); i++)
        for (const auto& m : moved)
          if (order[i].id == m.id) sel.push_back(i);
      setGridTrackSelection(d.frame, d.column, sel, false);
      break;
    }
    default: break;
  }
  needsRender_ = true;
}

void Editor::gridCancel() {
  if (gridDrag_.moved && (gridDrag_.kind == GridDrag::Kind::Resize || gridDrag_.kind == GridDrag::Kind::Span) && txn_.open) rollback();
  gridDrag_ = {};
  needsRender_ = true;
}

bool Editor::gridCursor(Vec2 s) {
  if (gridSpanHandleAt(s) >= 0) {
    changeCursor(CursorKind::DEFAULT);
    return true;
  }
  GridHit h = gridHitAt(s);
  switch (h.kind) {
    case GridHit::Kind::Edge: changeCursor(CursorKind::RESIZE, h.column ? 0 : 90); return true;
    case GridHit::Kind::Grabber: changeCursor(CursorKind::HAND); return true;
    case GridHit::Kind::Track: changeCursor(CursorKind::DEFAULT); return true;
    default: return false;
  }
}

Status Editor::deleteGridTracks() {
  Guid frame = gridSel_.frame;
  const Node* fn = doc_.get(frame);
  if (!fn || gridSel_.tracks.empty()) return E_INVALID;
  bool column = gridSel_.column;
  std::vector<Layout::GridTrackDef> tracks = Layout::gridTrackDefs(fn->props, column);
  std::vector<size_t> del;
  for (size_t i : gridSel_.tracks)
    if (i < tracks.size()) del.push_back(i);
  if (del.empty() || del.size() >= tracks.size()) return E_INVALID;  // a grid keeps one track on each axis
  Layout L(*this);
  Layout::GridCells g = L.gridCells(frame);
  auto deleted = [&](size_t i) { return std::find(del.begin(), del.end(), i) != del.end(); };
  begin(TxnKind::USER, column ? (del.size() > 1 ? "Delete columns" : "Delete column") : (del.size() > 1 ? "Delete rows" : "Delete row"));
  std::vector<Layout::GridTrackDef> keep;
  for (size_t i = 0; i < tracks.size(); i++)
    if (!deleted(i)) keep.push_back(tracks[i]);
  // Items: inside deleted tracks only → removed; spanning into kept ones → shrunk to them (anchored on the first).
  std::vector<Guid> removed;
  for (const auto& it : g.items) {
    size_t a = column ? it.col : it.row, n = column ? it.colSpan : it.rowSpan;
    size_t left = 0, first = SIZE_MAX;
    for (size_t k = a; k < a + n; k++)
      if (!deleted(k)) left++, first = std::min(first, k);
    if (left == n) continue;
    if (left == 0) {
      removed.push_back(it.id);
      continue;
    }
    NodeChange c = NodeChange::changed(it.id);
    c.mask = F_EXTRA;
    c.props.extra = doc_.get(it.id)->props.extra;
    c.props.extra[column ? "gridColumnSpan" : "gridRowSpan"] = Layout::gridSpanBytes(column, static_cast<uint32_t>(left));
    if (!g.reflow && first < tracks.size()) c.props.extra[column ? "gridColumnAnchor" : "gridRowAnchor"] = Layout::gridAnchorBytes(column, tracks[first].id);
    write(c);
  }
  for (Guid r : removed) {
    std::vector<Guid> order;
    auto collect = [&](auto&& self, Guid id) -> void {
      for (Guid c : std::vector<Guid>(doc_.children(id)))
        if (!c.isDerived()) self(self, c);
      order.push_back(id);
    };
    collect(collect, r);
    for (Guid id : order) write(NodeChange::removed(id));
  }
  writeGridTracks(frame, column, keep);
  commit();
  setGridTrackSelection(kNoGuid, column, {}, false);
  return OK;
}

uint32_t Editor::gridKey(KeyCode code, uint32_t mods) {
  if (gridSel_.tracks.empty() || gesture_ != Gesture::None) return 0;
  if (gridFrameSelected() != gridSel_.frame) {
    clearGridTrackSelection();
    return 0;
  }
  if (mods & (MOD_PRIMARY | MOD_ALT)) return 0;
  switch (code) {
    case KeyCode::Backspace:
    case KeyCode::Delete: deleteGridTracks(); return K_HANDLED;
    case KeyCode::Enter:
    case KeyCode::NumpadEnter: setGridTrackSelection(gridSel_.frame, gridSel_.column, gridSel_.tracks, true); return K_HANDLED;
    case KeyCode::Escape: clearGridTrackSelection(); return K_HANDLED;
    default: return 0;
  }
}

void Editor::gridTrackOverlay(Overlay& o) const {
  Guid frame = gridFrameSelected();
  if (frame == kNoGuid) return;
  Layout L(*const_cast<Editor*>(this));
  Layout::GridCells g = L.gridCells(frame);
  Mat2x3 W = doc_.worldTransform(frame);
  GridHit hover = gesture_ == Gesture::None ? gridHitAt(lastScreen_) : GridHit{};
  // The pointer in the band but not on a pill (between pills) still shows them; on a pill: that one is hovered.
  bool sameSel = gridSel_.frame == frame;
  auto selected = [&](bool column, size_t i) {
    return sameSel && gridSel_.column == column && std::find(gridSel_.tracks.begin(), gridSel_.tracks.end(), i) != gridSel_.tracks.end();
  };
  for (size_t i = 0; i < g.colX.size(); i++) {
    Overlay::GridTrack t;
    t.a = W.apply({g.colX[i], 0});
    t.b = W.apply({g.colX[i] + g.colW[i], 0});
    t.column = true;
    t.selected = selected(true, i);
    t.hovered = (hover.kind != GridHit::Kind::None && hover.column && hover.track == i) || t.selected ||
                (gridDrag_.kind == GridDrag::Kind::Resize && gridDrag_.column && gridDrag_.track == i);
    t.grabber = t.hovered && hover.kind != GridHit::Kind::Edge;
    t.label = g.colLabels[i];
    o.gridTracks.push_back(std::move(t));
  }
  for (size_t i = 0; i < g.rowY.size(); i++) {
    Overlay::GridTrack t;
    t.a = W.apply({0, g.rowY[i]});
    t.b = W.apply({0, g.rowY[i] + g.rowH[i]});
    t.column = false;
    t.selected = selected(false, i);
    t.hovered = (hover.kind != GridHit::Kind::None && !hover.column && hover.track == i) || t.selected ||
                (gridDrag_.kind == GridDrag::Kind::Resize && !gridDrag_.column && gridDrag_.track == i);
    t.grabber = t.hovered && hover.kind != GridHit::Kind::Edge;
    t.label = g.rowLabels[i];
    o.gridTracks.push_back(std::move(t));
  }
  // Reordering: the blue line where the tracks will land, across the frame.
  if (gridDrag_.kind == GridDrag::Kind::Reorder && gridDrag_.moved) {
    const std::vector<double>& at = gridDrag_.column ? g.colX : g.rowY;
    const std::vector<double>& sz = gridDrag_.column ? g.colW : g.rowH;
    if (!at.empty()) {
      size_t k = std::min(gridDrag_.dropAt, at.size());
      double v = k == 0 ? at[0] : k == at.size() ? at.back() + sz.back() : (at[k - 1] + sz[k - 1] + at[k]) / 2;
      Vec2 size = doc_.get(frame)->props.size;
      o.hasGridDrop = true;
      o.gridDrop = gridDrag_.column ? GuideLine{W.apply({v, 0}), W.apply({v, size.y})} : GuideLine{W.apply({0, v}), W.apply({size.x, v})};
    }
  }
}

void Editor::gridSpanOverlay(Overlay& o) const {
  Guid item;
  Vec2 hs[4];
  if (!gridSpanHandles(item, hs)) return;
  for (const Vec2& h : hs) o.gridSpanHandles.push_back(camera_.toWorld(h));
}

}  // namespace eng
