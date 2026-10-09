// The Variable width tool and Stroke settings' Width profile (round 12; live toolbar/vector-edit-more-menu.txt:
// "Variable width" ⇧W; live popovers/stroke-advanced-settings.txt: "Width profile", "Flip width points"). What they
// do is help.figma.com's ("Apply and adjust stroke properties", "Edit vector layers"): the tool changes the stroke's
// thickness at any point along the path — hover the stroke, click to add a width point, drag it to adjust; not on
// dynamic or dashed strokes, nor on vector networks with branching paths (Split vector first). The width points are
// the layer's variableWidthPoints (geometry/VariableWidth.h), written as one NODE_CHANGES field with undo.
//
// Unverified (ours): the handles' look (a line across the stroke at the point, a ring at each side, the point on the
// path), dragging a side handle sets the width on both sides (⌥: that side only), dragging the point moves it along
// the path, Delete removes the selected point, the undo labels ("Variable width", "Delete width point",
// "Width profile", "Flip width points").

#include <algorithm>
#include <cmath>

#include "editor/Editor.h"
#include "geometry/Stroker.h"
#include "hit/HitTest.h"

namespace eng {

namespace {

constexpr double kPointReach = 6;   // CSS px (as vector edit's points)
constexpr double kStrokeReach = 5;  // CSS px off the path still on it
constexpr double kWidthTolerance = 0.05;

Vec2 upOf(Vec2 d) { return {d.y, -d.x}; }  // the path's left (the stroker's "ascent" side)

// The stroke's weight as drawn on one side of the path: twice the weight when it is kept inside / outside a closed area.
double drawnWeight(const NodeProps& p, const NodeGeometry& g) {
  bool aligned = !g.fills.empty() && !g.hasOpenEnds && p.strokeAlign != StrokeAlign::CENTER;
  return p.strokeWeight * (aligned ? 2 : 1);
}

}  // namespace

std::vector<geom::WidthPoint> Editor::vectorWidthPoints() const {
  const Node* n = doc_.get(vector_.node);
  return n ? widthPointsOf(n->props) : std::vector<geom::WidthPoint>{};
}

bool Editor::widthCenter(geom::Path& center, Mat2x3& toWorld) const {
  const NodeGeometry* g = doc_.geometry(vector_.node);
  if (!g || g->stroke.path.empty()) return false;
  center = g->stroke.path;
  toWorld = doc_.worldTransform(vector_.node);
  return true;
}

int Editor::widthPointAt(Vec2 screen, int& part) const {
  geom::Path center;
  Mat2x3 W;
  const Node* n = doc_.get(vector_.node);
  const NodeGeometry* g = doc_.geometry(vector_.node);
  if (!n || !g || !widthCenter(center, W)) return -1;
  Mat2x3 S = camera_.matrix() * W;
  double w = drawnWeight(n->props, *g);
  auto points = widthPointsOf(n->props);
  int best = -1;
  double bestD = kPointReach;
  for (size_t k = 0; k < points.size(); k++) {
    Vec2 at, dir;
    if (!geom::pointAlong(center, 0, points[k].position, kWidthTolerance, at, dir)) continue;
    Vec2 up = upOf(dir);
    Vec2 c = S.apply(at), l = S.apply(at + up * (points[k].ascent * w)), r = S.apply(at - up * (points[k].descent * w));
    const std::pair<Vec2, int> spots[] = {{l, 1}, {r, 2}, {c, 0}};
    for (const auto& [p, which] : spots) {
      double d = (p - screen).length();
      if (d <= bestD) bestD = d, best = static_cast<int>(k), part = which;
    }
  }
  return best;
}

void Editor::widthWrite(const std::vector<geom::WidthPoint>& points) {
  NodeChange c = NodeChange::changed(vector_.node);
  c.mask = F_EXTRA;
  c.props.extra["variableWidthPoints"] = encodeWidthPoints(points);
  write(c);
  vectorChanged();
}

uint32_t Editor::widthPointerDown(Vec2 s, uint32_t mods) {
  (void)mods;
  Vec2 world = camera_.toWorld(s);
  const Node* n = doc_.get(vector_.node);
  const NodeGeometry* g = doc_.geometry(vector_.node);
  geom::Path center;
  Mat2x3 W;
  if (!n || !g || !variableWidthAvailable() || !widthCenter(center, W)) return P_HANDLED;
  int part = 0;
  int k = widthPointAt(s, part);
  std::vector<geom::WidthPoint> points = widthPointsOf(n->props);
  if (k < 0) {
    // On the stroke: a new point there at the width the stroke has there (a drag sets its width).
    Vec2 local = W.inverse().apply(world);
    size_t contour = 0;
    double pos = 0, dist = 0;
    double scale = std::sqrt(std::fabs((camera_.matrix() * W).determinant()));
    double w = drawnWeight(n->props, *g);
    double reach = std::max(kStrokeReach, w * geom::maxShare(points) * scale);
    if (!geom::nearestAlong(center, local, kWidthTolerance, contour, pos, dist) || dist * scale > reach) {
      // Off the stroke: a click on another layer leaves the mode; elsewhere the point is let go.
      auto path = hitPath(doc_, page_, world, pixel());
      if (!path.empty() && path.back() != vector_.node && !doc_.isAncestor(path.back(), vector_.node) &&
          std::find(vector_.group.begin(), vector_.group.end(), path.back()) == vector_.group.end()) {
        endVectorEdit();
        return 0;
      }
      vector_.widthSelected = -1;
      vectorChanged();
      return P_HANDLED;
    }
    geom::WidthPoint added;
    added.position = pos;
    geom::profileAt(points, pos, added.ascent, added.descent);
    points.push_back(added);
    points = geom::normalized(std::move(points));
    k = static_cast<int>(std::find(points.begin(), points.end(), added) - points.begin());
    Vec2 at, dir;
    part = geom::pointAlong(center, contour, pos, kWidthTolerance, at, dir) && ((local - at).x * upOf(dir).x + (local - at).y * upOf(dir).y) < 0 ? 2 : 1;
    begin(TxnKind::GESTURE, "Variable width");
    widthWrite(points);
  } else {
    begin(TxnKind::GESTURE, "Variable width");
  }
  vector_.widthSelected = k;
  vector_.widthDragPart = part;
  vector_.widthStart = points;
  vector_.drag = VectorSession::Drag::Width;
  vector_.dragged = false;
  vector_.widthPreview = false;
  gesture_ = Gesture::Vector;
  vectorChanged();
  return P_HANDLED | P_CAPTURE;
}

void Editor::widthPointerMove(Vec2 s, uint32_t mods) {
  Vec2 world = camera_.toWorld(s);
  vector_.pointer = world;
  vector_.pointerKnown = true;
  const Node* n = doc_.get(vector_.node);
  const NodeGeometry* g = doc_.geometry(vector_.node);
  geom::Path center;
  Mat2x3 W;
  if (!n || !g || !widthCenter(center, W)) return;
  Vec2 local = W.inverse().apply(world);
  if (gesture_ != Gesture::Vector || vector_.drag != VectorSession::Drag::Width) {
    int part = 0;
    int k = variableWidthAvailable() ? widthPointAt(s, part) : -1;
    bool preview = false;
    size_t contour = 0;
    double pos = 0, dist = 0;
    if (k < 0 && variableWidthAvailable()) {
      double scale = std::sqrt(std::fabs((camera_.matrix() * W).determinant()));
      double reach = std::max(kStrokeReach, drawnWeight(n->props, *g) * geom::maxShare(widthPointsOf(n->props)) * scale);
      preview = geom::nearestAlong(center, local, kWidthTolerance, contour, pos, dist) && dist * scale <= reach;
    }
    if (k != vector_.widthHover || part != vector_.widthHoverPart || preview != vector_.widthPreview || (preview && pos != vector_.widthPreviewPos))
      needsRender_ = true;
    vector_.widthHover = k;
    vector_.widthHoverPart = part;
    vector_.widthPreview = preview;
    vector_.widthPreviewPos = pos;
    vector_.widthPreviewContour = contour;
    changeCursor(variableWidthAvailable() ? CursorKind::CROSSHAIR : CursorKind::NOT_ALLOWED);
    return;
  }
  if (!vector_.dragged && (s - downScreen_).length() < 3) return;
  vector_.dragged = true;
  std::vector<geom::WidthPoint> points = vector_.widthStart;
  int k = vector_.widthSelected;
  if (k < 0 || static_cast<size_t>(k) >= points.size()) return;
  geom::WidthPoint& p = points[static_cast<size_t>(k)];
  if (vector_.widthDragPart == 0) {
    // The point along the path.
    size_t contour = 0;
    double pos = p.position, dist = 0;
    if (geom::nearestAlong(center, local, kWidthTolerance, contour, pos, dist)) p.position = pos;
  } else {
    // A side: its distance from the path is that side's width (both sides alike unless ⌥ is held).
    Vec2 at, dir;
    if (!geom::pointAlong(center, 0, p.position, kWidthTolerance, at, dir)) return;
    Vec2 up = upOf(dir);
    double w = drawnWeight(n->props, *g);
    if (!(w > 0)) return;
    double d = (local - at).x * up.x + (local - at).y * up.y;
    // Both sides alike: the distance off the path, whichever side the pointer is on (a new point is grabbed on the
    // path itself); ⌥: the grabbed side only, up to the path.
    if (mods & MOD_ALT) (vector_.widthDragPart == 1 ? p.ascent : p.descent) = std::max(0.0, (vector_.widthDragPart == 1 ? d : -d) / w);
    else p.ascent = p.descent = std::fabs(d) / w;
  }
  geom::WidthPoint moved = p;
  points = geom::normalized(std::move(points));
  vector_.widthSelected = static_cast<int>(std::find(points.begin(), points.end(), moved) - points.begin());
  widthWrite(points);
  flushLayout();
}

void Editor::widthPointerUp() {
  if (txn_.open) commit();
  vectorChanged();
}

Status Editor::widthDeleteSelected() {
  const Node* n = doc_.get(vector_.node);
  if (!n) return E_INVALID;
  std::vector<geom::WidthPoint> points = widthPointsOf(n->props);
  if (vector_.widthSelected < 0 || static_cast<size_t>(vector_.widthSelected) >= points.size()) return E_INVALID;
  points.erase(points.begin() + vector_.widthSelected);
  begin(TxnKind::USER, "Delete width point");
  widthWrite(points);
  commit();
  vector_.widthSelected = -1;
  vectorChanged();
  return OK;
}

void Editor::widthOverlay(Overlay& o) const {
  const Node* n = doc_.get(vector_.node);
  const NodeGeometry* g = doc_.geometry(vector_.node);
  geom::Path center;
  Mat2x3 W;
  if (!n || !g || !widthCenter(center, W)) return;
  // The path itself, thin (the stroke's width shows around it).
  const auto& net = vector_.net;
  for (const auto& sg : net.segments) {
    Vec2 a = net.vertices[sg.start].p, b = net.vertices[sg.end].p;
    o.curves.push_back({W.apply(a), W.apply(a + sg.tangentStart), W.apply(b + sg.tangentEnd), W.apply(b), 1.0, true});
  }
  double w = drawnWeight(n->props, *g);
  auto across = [&](Vec2 at, Vec2 dir, double ascent, double descent, bool dashed, int index) {
    Vec2 up = upOf(dir);
    Vec2 l = at + up * (ascent * w), r = at - up * (descent * w);
    o.lines.push_back({W.apply(l), W.apply(r), dashed, false});
    if (index < 0) return;
    for (int side : {1, 2}) {
      OverlayMark m;
      m.shape = OverlayMark::Shape::Handle;
      m.world = W.apply(side == 1 ? l : r);
      m.hovered = index == vector_.widthHover && vector_.widthHoverPart == side;
      m.selected = index == vector_.widthSelected;
      o.marks.push_back(m);
    }
    OverlayMark c;
    c.shape = OverlayMark::Shape::Vertex;
    c.world = W.apply(at);
    c.selected = index == vector_.widthSelected;
    c.hovered = index == vector_.widthHover && vector_.widthHoverPart == 0;
    o.marks.push_back(c);
  };
  auto points = widthPointsOf(n->props);
  for (size_t k = 0; k < points.size(); k++) {
    Vec2 at, dir;
    if (geom::pointAlong(center, 0, points[k].position, kWidthTolerance, at, dir)) across(at, dir, points[k].ascent, points[k].descent, false, static_cast<int>(k));
  }
  if (vector_.widthPreview && gesture_ == Gesture::None) {
    Vec2 at, dir;
    double a = 0.5, d = 0.5;
    geom::profileAt(points, vector_.widthPreviewPos, a, d);
    if (geom::pointAlong(center, vector_.widthPreviewContour, vector_.widthPreviewPos, kWidthTolerance, at, dir)) across(at, dir, a, d, true, -1);
  }
}

// ---- Stroke settings › Width profile, Flip width points ------------------------------------------------------------

namespace {

bool branching(const geom::VectorNetwork& net) {
  for (uint32_t d : net.degrees())
    if (d > 2) return true;
  return false;
}

}  // namespace

Status Editor::widthCommand(CommandId id, const CommandArgs& args) {
  std::vector<Guid> targets;
  if (const json::Value* refs = args.raw.isObject() ? args.raw.get("refs") : nullptr; refs && refs->isArray()) {
    for (const json::Value& r : refs->array) {
      bool ok = false;
      Guid g = r.isString() ? Guid::parse(r.string, &ok) : Guid{};
      if (ok) targets.push_back(g);
    }
  } else {
    targets = vector_.node != kNoGuid ? std::vector<Guid>{vector_.node} : selection_;
  }
  geom::WidthProfile profile = geom::WidthProfile::UNIFORM;
  if (id == CommandId::SET_WIDTH_PROFILE) {
    const json::Value* v = args.raw.isObject() ? args.raw.get("profile") : nullptr;
    if (!v || !v->isString()) return E_INVALID;
    bool known = false;
    for (int i = 0; i < static_cast<int>(geom::WidthProfile::CUSTOM); i++)
      if (v->string == geom::kWidthProfileNames[i]) profile = static_cast<geom::WidthProfile>(i), known = true;
    if (!known) return E_INVALID;
  }
  std::vector<std::pair<Guid, std::vector<geom::WidthPoint>>> writes;
  for (Guid t : targets) {
    const Node* n = doc_.get(t);
    if (!n || t.isDerived() || n->props.locked || !widthProfileAllowed(n->props)) continue;
    geom::VectorNetwork net;
    bool convert = false;
    if (networkOf(t, net, convert) && branching(net)) continue;
    if (id == CommandId::SET_WIDTH_PROFILE) {
      writes.push_back({t, geom::presetPoints(profile)});
    } else {
      auto points = widthPointsOf(n->props);
      if (!points.empty()) writes.push_back({t, geom::flipped(points)});
    }
  }
  if (writes.empty()) return E_INVALID;
  begin(TxnKind::USER, id == CommandId::SET_WIDTH_PROFILE ? "Width profile" : "Flip width points");
  for (auto& [t, points] : writes) {
    NodeChange c = NodeChange::changed(t);
    c.mask = F_EXTRA;
    c.props.extra["variableWidthPoints"] = encodeWidthPoints(points);
    write(c);
  }
  commit();
  if (vector_.node != kNoGuid) vectorChanged();
  return OK;
}

uint32_t Editor::widthCommandState(CommandId id) const {
  std::vector<Guid> targets = vector_.node != kNoGuid ? std::vector<Guid>{vector_.node} : selection_;
  for (Guid t : targets) {
    const Node* n = doc_.get(t);
    if (!n || t.isDerived() || !widthProfileAllowed(n->props)) continue;
    if (id == CommandId::FLIP_WIDTH_POINTS && !hasWidthPoints(n->props)) continue;
    geom::VectorNetwork net;
    bool convert = false;
    if (networkOf(t, net, convert) && branching(net)) continue;
    return CMD_ENABLED;
  }
  return 0;
}

}  // namespace eng
