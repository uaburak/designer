// Vector edit mode, the Pen and the Pencil (docs/engine.md §8.4, R7 P1): a
// session edits one node's vector network in place — vertices, segments,
// Bézier handles with their mirroring, the bend tool, adding and deleting
// points, filling areas — and writes the network back after each operation
// (one undo step each), the node's box refitted to the network as Figma does.
// Shapes (rectangles, ellipses, stars, polygons, lines) become VECTORs at their
// first edit, keeping their GUID.

#include <algorithm>
#include <cmath>
#include <set>

#include "editor/Editor.h"
#include "geometry/Shapes.h"
#include "hit/HitTest.h"

namespace eng {

namespace {

constexpr double kVertexReach = 6;   // CSS px
constexpr double kHandleReach = 6;
constexpr double kSegmentReach = 5;
constexpr double kDragThreshold = 3;

using geom::VectorNetwork;
using geom::VNRegion;
using geom::VNSegment;
using geom::VNVertex;

bool has(const std::vector<uint32_t>& v, uint32_t x) { return std::find(v.begin(), v.end(), x) != v.end(); }
void toggle(std::vector<uint32_t>& v, uint32_t x) {
  auto it = std::find(v.begin(), v.end(), x);
  if (it == v.end()) v.push_back(x);
  else v.erase(it);
}

Vec2 segmentAt(const VectorNetwork& n, uint32_t s, double t) {
  const VNSegment& g = n.segments[s];
  Vec2 a = n.vertices[g.start].p, b = n.vertices[g.end].p;
  return geom::cubicAt(a, a + g.tangentStart, b + g.tangentEnd, b, t);
}

std::vector<uint32_t> incident(const VectorNetwork& n, uint32_t v) {
  std::vector<uint32_t> out;
  for (uint32_t i = 0; i < n.segments.size(); i++)
    if (n.segments[i].start == v || n.segments[i].end == v) out.push_back(i);
  return out;
}

// The tangent of segment `s` at vertex `v` (its start or end).
Vec2& tangentAt(VectorNetwork& n, uint32_t s, uint32_t v) {
  VNSegment& g = n.segments[s];
  return g.start == v ? g.tangentStart : g.tangentEnd;
}

uint32_t nextStyleID(const VectorNetwork& n, const std::vector<VectorStyle>& table) {
  uint32_t id = 0;
  for (auto& v : n.vertices) id = std::max(id, v.styleID);
  for (auto& s : n.segments) id = std::max(id, s.styleID);
  for (auto& r : n.regions) id = std::max(id, r.styleID);
  for (auto& t : table) id = std::max(id, t.styleID);
  return id + 1;
}

// Gives vertex `v` a style of its own changed by `fn` (a copy of its old one).
template <typename F>
void restyleVertex(VectorNetwork& n, std::vector<VectorStyle>& table, uint32_t v, F&& fn) {
  VectorStyle st;
  for (auto& t : table)
    if (t.styleID == n.vertices[v].styleID && n.vertices[v].styleID) st = t;
  fn(st);
  st.styleID = nextStyleID(n, table);
  table.push_back(st);
  n.vertices[v].styleID = st.styleID;
}

// The table without the styles nothing uses.
std::vector<VectorStyle> pruned(const VectorNetwork& n, const std::vector<VectorStyle>& table) {
  std::set<uint32_t> used;
  for (auto& v : n.vertices) used.insert(v.styleID);
  for (auto& s : n.segments) used.insert(s.styleID);
  for (auto& r : n.regions) used.insert(r.styleID);
  std::vector<VectorStyle> out;
  for (auto& t : table)
    if (used.count(t.styleID)) out.push_back(t);
  return out;
}

// Removes vertices and segments (indices) and re-indexes everything; loops through a removed segment go.
VectorNetwork compact(const VectorNetwork& n, const std::set<uint32_t>& dropVerts, const std::set<uint32_t>& dropSegs) {
  VectorNetwork out;
  std::vector<int> vmap(n.vertices.size(), -1), smap(n.segments.size(), -1);
  std::set<uint32_t> segsGone = dropSegs;
  for (uint32_t i = 0; i < n.segments.size(); i++)
    if (dropVerts.count(n.segments[i].start) || dropVerts.count(n.segments[i].end)) segsGone.insert(i);
  for (uint32_t i = 0; i < n.vertices.size(); i++)
    if (!dropVerts.count(i)) {
      vmap[i] = static_cast<int>(out.vertices.size());
      out.vertices.push_back(n.vertices[i]);
    }
  for (uint32_t i = 0; i < n.segments.size(); i++)
    if (!segsGone.count(i)) {
      smap[i] = static_cast<int>(out.segments.size());
      VNSegment s = n.segments[i];
      s.start = static_cast<uint32_t>(vmap[s.start]);
      s.end = static_cast<uint32_t>(vmap[s.end]);
      out.segments.push_back(s);
    }
  for (const VNRegion& r : n.regions) {
    VNRegion nr = r;
    nr.loops.clear();
    for (auto& loop : r.loops) {
      std::vector<uint32_t> l;
      bool ok = true;
      for (uint32_t s : loop) {
        if (smap[s] < 0) ok = false;
        else l.push_back(static_cast<uint32_t>(smap[s]));
      }
      if (ok && !l.empty()) nr.loops.push_back(l);
    }
    if (!nr.loops.empty()) out.regions.push_back(nr);
  }
  return out;
}

// The segments of a shortest path from `a` to `b` (not using `avoid`), or empty.
std::vector<uint32_t> pathBetween(const VectorNetwork& n, uint32_t a, uint32_t b, uint32_t avoid) {
  std::vector<int> via(n.vertices.size(), -1);
  std::vector<bool> seen(n.vertices.size(), false);
  std::vector<uint32_t> queue{a};
  seen[a] = true;
  for (size_t q = 0; q < queue.size(); q++) {
    uint32_t v = queue[q];
    if (v == b) break;
    for (uint32_t s = 0; s < n.segments.size(); s++) {
      if (s == avoid) continue;
      const VNSegment& g = n.segments[s];
      uint32_t w = g.start == v ? g.end : g.end == v ? g.start : UINT32_MAX;
      if (w == UINT32_MAX || seen[w]) continue;
      seen[w] = true;
      via[w] = static_cast<int>(s);
      queue.push_back(w);
    }
  }
  if (!seen[b] || a == b) return {};
  std::vector<uint32_t> out;
  for (uint32_t v = b; v != a;) {
    uint32_t s = static_cast<uint32_t>(via[v]);
    out.push_back(s);
    v = n.segments[s].start == v ? n.segments[s].end : n.segments[s].start;
  }
  std::reverse(out.begin(), out.end());
  return out;
}

double ramerDistance(Vec2 p, Vec2 a, Vec2 b) {
  Vec2 ab = b - a;
  double len = ab.length();
  if (len < 1e-12) return (p - a).length();
  return std::fabs((p.x - a.x) * ab.y - (p.y - a.y) * ab.x) / len;
}

void simplify(const std::vector<Vec2>& pts, size_t i, size_t j, double tol, std::vector<bool>& keep) {
  if (j <= i + 1) return;
  double best = -1;
  size_t at = i;
  for (size_t k = i + 1; k < j; k++) {
    double d = ramerDistance(pts[k], pts[i], pts[j]);
    if (d > best) best = d, at = k;
  }
  if (best > tol) {
    keep[at] = true;
    simplify(pts, i, at, tol, keep);
    simplify(pts, at, j, tol, keep);
  }
}

bool insidePolygon(const std::vector<Vec2>& poly, Vec2 p) {
  bool in = false;
  for (size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++)
    if ((poly[i].y > p.y) != (poly[j].y > p.y) && p.x < (poly[j].x - poly[i].x) * (p.y - poly[i].y) / (poly[j].y - poly[i].y) + poly[i].x)
      in = !in;
  return in;
}

}  // namespace

// ---- The network of a node ------------------------------------------------------------------

VectorData Editor::lineNetwork(double length, StrokeCap start, StrokeCap end) {
  VectorNetwork n;
  n.vertices = {{{0, 0}, 0}, {{length, 0}, 0}};
  n.segments = {VNSegment{0, 1, {}, {}, 0}};
  VectorData d;
  d.present = true;
  d.normalizedSize = {length, 0};
  uint32_t id = 1;
  if (start != StrokeCap::NONE) {
    VectorStyle st;
    st.styleID = id;
    st.mask = VS_STROKE_CAP;
    st.strokeCap = start;
    d.styleOverrideTable.push_back(st);
    n.vertices[0].styleID = id++;
  }
  if (end != StrokeCap::NONE) {
    VectorStyle st;
    st.styleID = id;
    st.mask = VS_STROKE_CAP;
    st.strokeCap = end;
    d.styleOverrideTable.push_back(st);
    n.vertices[1].styleID = id;
  }
  d.network = std::make_shared<std::vector<uint8_t>>(n.encode());
  return d;
}

bool Editor::networkOf(Guid id, VectorNetwork& out, bool& convert) const {
  const Node* node = doc_.get(id);
  if (!node) return false;
  const NodeProps& p = node->props;
  convert = false;
  out = VectorNetwork{};
  if (p.type == NodeType::VECTOR || (p.type == NodeType::LINE && p.shape().vectorData.network)) {
    if (p.shape().vectorData.network && !p.shape().vectorData.network->empty())
      VectorNetwork::decode(p.shape().vectorData.network->data(), p.shape().vectorData.network->size(), out);
    double sx = p.shape().vectorData.normalizedSize.x != 0 ? p.size.x / p.shape().vectorData.normalizedSize.x : 1;
    double sy = p.shape().vectorData.normalizedSize.y != 0 ? p.size.y / p.shape().vectorData.normalizedSize.y : 1;
    if (sx != 1 || sy != 1) out.scale(sx, sy);
    return true;
  }
  if (p.type == NodeType::LINE) {
    out.vertices = {{{0, 0}, 0}, {{p.size.x, 0}, 0}};
    out.segments = {VNSegment{0, 1, {}, {}, 0}};
    return true;
  }
  if (p.isRectLike() || p.type == NodeType::ELLIPSE || p.type == NodeType::STAR || p.type == NodeType::REGULAR_POLYGON) {
    const NodeGeometry* g = doc_.geometry(id);
    if (!g || g->fills.empty()) return false;
    out = geom::networkFromPath(g->fills[0].path, g->fills[0].windingRule);
    convert = true;
    return true;
  }
  return false;
}

VectorNetwork Editor::writeVector(Guid id, VectorNetwork net, const Mat2x3& local, const std::vector<VectorStyle>* styles) {
  const Node* node = doc_.get(id);
  if (!node) return net;
  const NodeProps& p = node->props;
  Rect b = net.vertices.empty() ? Rect{} : net.bounds();
  if (!net.vertices.empty() && !net.segments.empty()) b = net.bounds();
  // Shift the network into its new box.
  for (auto& v : net.vertices) v.p = v.p - Vec2{b.x, b.y};
  NodeChange c = NodeChange::changed(id);
  c.mask = F_VECTOR_DATA | F_SIZE | F_TRANSFORM;
  c.props.transform = local * Mat2x3::translate(b.x, b.y);
  c.props.size = {b.w, b.h};
  VectorData d;
  d.present = true;
  d.normalizedSize = c.props.size;
  d.styleOverrideTable = pruned(net, styles ? *styles : p.shape().vectorData.styleOverrideTable);
  d.network = std::make_shared<std::vector<uint8_t>>(net.encode());
  c.props.shape().vectorData = d;
  if (id == vector_.node && vector_.pendingType && p.type != NodeType::VECTOR) {
    // A shape's first edit: it becomes a VECTOR (same GUID), its outline now the network.
    c.mask |= F_TYPE | F_CORNER_RADII | F_CORNER_SMOOTHING | F_ARC_DATA;
    c.props.type = NodeType::VECTOR;
    c.props.cornerRadii = {0, 0, 0, 0};
    c.props.stroke().cornerSmoothing = 0;
    c.props.shape().arcData = {};
    vector_.pendingType = false;
  }
  write(c);
  return net;
}

void Editor::reloadVector() {
  if (vector_.node == kNoGuid) return;
  const Node* n = doc_.get(vector_.node);
  bool convert = false;
  if (!n || !networkOf(vector_.node, vector_.net, convert)) {
    endVectorEdit();
    return;
  }
  vector_.pendingType = convert;
  auto prune = [&](std::vector<uint32_t>& v, size_t size) { v.erase(std::remove_if(v.begin(), v.end(), [&](uint32_t i) { return i >= size; }), v.end()); };
  prune(vector_.selVerts, vector_.net.vertices.size());
  prune(vector_.selSegs, vector_.net.segments.size());
  if (vector_.penFrom >= static_cast<int>(vector_.net.vertices.size())) vector_.penFrom = -1;
  vectorChanged();
}

// ---- The session ------------------------------------------------------------------------------

Status Editor::startVectorEdit(Guid id) {
  const Node* n = doc_.get(id);
  if (!n || n->props.locked) return E_INVALID;
  if (id.isDerived()) return E_UNSUPPORTED;  // a layer inside an instance: its geometry is its main's
  VectorNetwork net;
  bool convert = false;
  if (!networkOf(id, net, convert)) return E_UNSUPPORTED;
  if (text_.node != kNoGuid) endTextEdit();
  if (vector_.node != kNoGuid && vector_.node != id) endVectorEdit();
  VectorTool tool = tool_ == Tool::PEN ? VectorTool::PEN : VectorTool::MOVE;
  vector_ = VectorSession{};
  vector_.node = id;
  vector_.net = std::move(net);
  vector_.pendingType = convert;
  vector_.tool = tool;
  changeSelection({id});
  if (hover_ != kNoGuid) events_.hover = true;
  hover_ = kNoGuid;
  vectorChanged();
  return OK;
}

void Editor::endVectorEdit() {
  if (vector_.node == kNoGuid) return;
  if (gesture_ == Gesture::Vector) {
    if (txn_.open) commit();
    gesture_ = Gesture::None;
  }
  Guid node = vector_.node;
  vector_ = VectorSession{};
  if (tool_ == Tool::PEN) {
    tool_ = Tool::MOVE;
    events_.tool = true;
  }
  if (doc_.has(node)) changeSelection({node});
  vectorChanged();
  updateCursor(lastScreen_);
}

Status Editor::setVectorTool(VectorTool t) {
  if (vector_.node == kNoGuid) return E_INVALID;
  if (t != VectorTool::PEN) vector_.penFrom = -1;
  vector_.tool = t;
  Tool shown = t == VectorTool::PEN ? Tool::PEN : Tool::MOVE;
  if (shown != tool_) {
    tool_ = shown;
    events_.tool = true;
  }
  vectorChanged();
  return OK;
}

void Editor::vectorChanged() {
  events_.vectorEdit = true;
  needsRender_ = true;
}

Mat2x3 Editor::vectorToScreen() const { return camera_.matrix() * doc_.worldTransform(vector_.node); }

// ---- Hit-testing (screen px) ------------------------------------------------------------------

int Editor::vectorVertexAt(Vec2 screen) const {
  Mat2x3 m = vectorToScreen();
  int best = -1;
  double bestD = kVertexReach;
  for (uint32_t i = 0; i < vector_.net.vertices.size(); i++) {
    double d = (m.apply(vector_.net.vertices[i].p) - screen).length();
    if (d <= bestD) bestD = d, best = static_cast<int>(i);
  }
  return best;
}

namespace {

// The handles shown: the tangents at selected vertices and at the ends of selected segments.
template <typename F>
void forEachHandle(const VectorNetwork& n, const std::vector<uint32_t>& verts, const std::vector<uint32_t>& segs, F&& f) {
  std::set<uint32_t> shown(verts.begin(), verts.end());
  for (uint32_t s : segs)
    if (s < n.segments.size()) shown.insert(n.segments[s].start), shown.insert(n.segments[s].end);
  for (uint32_t s = 0; s < n.segments.size(); s++) {
    const VNSegment& g = n.segments[s];
    if (shown.count(g.start) && (g.tangentStart.x != 0 || g.tangentStart.y != 0)) f(s, true, n.vertices[g.start].p, n.vertices[g.start].p + g.tangentStart);
    if (shown.count(g.end) && (g.tangentEnd.x != 0 || g.tangentEnd.y != 0)) f(s, false, n.vertices[g.end].p, n.vertices[g.end].p + g.tangentEnd);
  }
}

}  // namespace

bool Editor::vectorHandleAt(Vec2 screen, int& segment, bool& atStart) const {
  Mat2x3 m = vectorToScreen();
  double bestD = kHandleReach;
  bool found = false;
  forEachHandle(vector_.net, vector_.selVerts, vector_.selSegs, [&](uint32_t s, bool start, Vec2, Vec2 handle) {
    double d = (m.apply(handle) - screen).length();
    if (d <= bestD) bestD = d, segment = static_cast<int>(s), atStart = start, found = true;
  });
  return found;
}

int Editor::vectorSegmentAt(Vec2 screen, double& t) const {
  Mat2x3 m = vectorToScreen();
  int best = -1;
  double bestD = kSegmentReach;
  for (uint32_t s = 0; s < vector_.net.segments.size(); s++) {
    const int steps = 48;
    Vec2 prev = m.apply(segmentAt(vector_.net, s, 0));
    for (int k = 1; k <= steps; k++) {
      double tk = static_cast<double>(k) / steps;
      Vec2 cur = m.apply(segmentAt(vector_.net, s, tk));
      Vec2 ab = cur - prev;
      double len2 = ab.x * ab.x + ab.y * ab.y;
      double u = len2 > 0 ? std::clamp(((screen.x - prev.x) * ab.x + (screen.y - prev.y) * ab.y) / len2, 0.0, 1.0) : 0;
      double d = (screen - (prev + ab * u)).length();
      if (d <= bestD) bestD = d, best = static_cast<int>(s), t = (k - 1 + u) / steps;
      prev = cur;
    }
  }
  return best;
}

// ---- Pointer ------------------------------------------------------------------------------------

uint32_t Editor::vectorPointerDown(Vec2 s, uint32_t mods, int clickCount) {
  Vec2 world = camera_.toWorld(s);
  auto innermostFrame = [&]() {
    Guid parent = page_;
    auto path = hitPath(doc_, page_, world, pixel());
    for (auto it = path.rbegin(); it != path.rend(); ++it)
      if (acceptsChildren(*it)) {
        parent = *it;
        break;
      }
    return parent;
  };
  if (vector_.node == kNoGuid && tool_ == Tool::PENCIL) {
    drawParent_ = innermostFrame();
    pencilPoints_ = {world};
    gesture_ = Gesture::Pencil;
    return P_HANDLED | P_CAPTURE;
  }
  if (vector_.node == kNoGuid) {
    if (tool_ != Tool::PEN) return 0;
    // The Pen on the canvas: a new vector, its first point here.
    drawParent_ = innermostFrame();
    Vec2 at{std::round(world.x), std::round(world.y)};
    begin(TxnKind::GESTURE, "Create vector");
    Guid id = newGuid();
    NodeChange c = NodeChange::created(id, defaultProps(NodeType::VECTOR));
    c.props.name = "Vector";
    c.props.parentIndex = {drawParent_, placeAt(drawParent_, doc_.children(drawParent_).size(), kNoGuid)};
    c.props.transform = doc_.worldTransform(drawParent_).inverse() * Mat2x3::translate(at.x, at.y);
    c.props.size = {0, 0};
    VectorNetwork net;
    net.vertices.push_back({{0, 0}, 0});
    VectorData d;
    d.present = true;
    d.network = std::make_shared<std::vector<uint8_t>>(net.encode());
    c.props.shape().vectorData = d;
    write(c);
    startVectorEdit(id);
    setVectorTool(VectorTool::PEN);
    vector_.penFrom = 0;
    vector_.penOut = {};
    vector_.selVerts = {0};
    vector_.newVertex = 0;
    vector_.drag = VectorSession::Drag::PenHandle;
    vector_.startNet = vector_.net;
    vector_.startWorld = doc_.worldTransform(id);
    vector_.startLocal = doc_.get(id)->props.transform;
    vector_.dragged = false;
    gesture_ = Gesture::Vector;
    vectorChanged();
    return P_HANDLED | P_CAPTURE;
  }

  const Node* node = doc_.get(vector_.node);
  if (!node) {
    endVectorEdit();
    return 0;
  }
  vector_.startNet = vector_.net;
  vector_.startWorld = doc_.worldTransform(vector_.node);
  vector_.startLocal = node->props.transform;
  vector_.dragged = false;
  vector_.drag = VectorSession::Drag::None;
  Vec2 local = vector_.startWorld.inverse().apply(world);
  bool shift = (mods & MOD_SHIFT) != 0;
  bool bend = vector_.tool == VectorTool::BEND || (mods & MOD_PRIMARY);
  VectorNetwork net = vector_.net;

  if (vector_.tool == VectorTool::PEN) {
    int v = vectorVertexAt(s);
    double t = 0;
    int seg = v < 0 ? vectorSegmentAt(s, t) : -1;
    begin(TxnKind::GESTURE, "Edit vector");
    if (v >= 0) {
      uint32_t vv = static_cast<uint32_t>(v);
      if (vector_.penFrom >= 0 && v != vector_.penFrom) {
        // Connect the path to this point; a closed loop becomes a filled area.
        uint32_t from = static_cast<uint32_t>(vector_.penFrom);
        net.segments.push_back(VNSegment{from, vv, vector_.penOut, {}, 0});
        uint32_t added = static_cast<uint32_t>(net.segments.size() - 1);
        std::vector<uint32_t> loop = pathBetween(net, vv, from, added);
        if (!loop.empty()) {
          loop.push_back(added);
          VNRegion r;
          r.windingRule = WindingRule::NONZERO;
          r.loops.push_back(loop);
          net.regions.push_back(r);
        }
        vector_.net = writeVector(vector_.node, net, vector_.startLocal);
        vector_.penFrom = loop.empty() ? v : -1;
      } else if (vector_.penFrom == v) {
        vector_.penFrom = -1;  // a click on the last point ends the path
      } else {
        vector_.penFrom = v;  // continue from an existing point
      }
      vector_.penOut = {};
      vector_.selVerts = {vv};
      vector_.selSegs.clear();
    } else if (seg >= 0 && vector_.penFrom < 0) {
      // A point on a segment: the segment is split there (its shape kept).
      const VNSegment g = net.segments[static_cast<size_t>(seg)];
      Vec2 a = net.vertices[g.start].p, b = net.vertices[g.end].p;
      Vec2 in[4] = {a, a + g.tangentStart, b + g.tangentEnd, b}, left[4], right[4];
      geom::cubicSection(in, 0, t, left);
      geom::cubicSection(in, t, 1, right);
      uint32_t nv = static_cast<uint32_t>(net.vertices.size());
      net.vertices.push_back({left[3], 0});
      bool line = g.isLine();
      net.segments[static_cast<size_t>(seg)] = VNSegment{g.start, nv, line ? Vec2{} : left[1] - left[0], line ? Vec2{} : left[2] - left[3], g.styleID};
      net.segments.push_back(VNSegment{nv, g.end, line ? Vec2{} : right[1] - right[0], line ? Vec2{} : right[2] - right[3], g.styleID});
      uint32_t added = static_cast<uint32_t>(net.segments.size() - 1);
      for (auto& r : net.regions)
        for (auto& loop : r.loops)
          for (size_t i = 0; i < loop.size(); i++)
            if (loop[i] == static_cast<uint32_t>(seg)) {
              // Keep the loop's order: the half that continues towards the next segment comes second.
              const VNSegment& next = net.segments[loop[(i + 1) % loop.size()]];
              bool forward = next.start == g.end || next.end == g.end;
              loop.insert(loop.begin() + static_cast<long>(forward ? i + 1 : i), added);
              break;
            }
      vector_.net = writeVector(vector_.node, net, vector_.startLocal);
      vector_.selVerts = {nv};
      vector_.selSegs.clear();
    } else {
      // A new point, joined to the path being drawn; a drag pulls out its handles.
      Vec2 at = vector_.startWorld.inverse().apply(Vec2{std::round(world.x), std::round(world.y)});
      uint32_t nv = static_cast<uint32_t>(net.vertices.size());
      net.vertices.push_back({at, 0});
      if (vector_.penFrom >= 0) net.segments.push_back(VNSegment{static_cast<uint32_t>(vector_.penFrom), nv, vector_.penOut, {}, 0});
      vector_.net = writeVector(vector_.node, net, vector_.startLocal);
      vector_.penFrom = static_cast<int>(nv);
      vector_.penOut = {};
      vector_.newVertex = static_cast<int>(nv);
      vector_.selVerts = {nv};
      vector_.selSegs.clear();
      vector_.drag = VectorSession::Drag::PenNew;
    }
    // The drag continues from what was just written.
    vector_.startNet = vector_.net;
    vector_.startLocal = doc_.get(vector_.node)->props.transform;
    vector_.startWorld = doc_.worldTransform(vector_.node);
    gesture_ = Gesture::Vector;
    vectorChanged();
    return P_HANDLED | P_CAPTURE;
  }

  if (vector_.tool == VectorTool::CUT || vector_.tool == VectorTool::ERASE) {
    vector_.drag = vector_.tool == VectorTool::CUT ? VectorSession::Drag::Cut : VectorSession::Drag::Erase;
    vector_.trail = {world};
    gesture_ = Gesture::Vector;
    needsRender_ = true;
    return P_HANDLED | P_CAPTURE;
  }

  if (vector_.tool == VectorTool::LASSO) {
    vector_.drag = VectorSession::Drag::Lasso;
    vector_.lasso = {world};
    vector_.baseSel = shift ? vector_.selVerts : std::vector<uint32_t>{};
    gesture_ = Gesture::Vector;
    return P_HANDLED | P_CAPTURE;
  }

  if (vector_.tool == VectorTool::PAINT_BUCKET) {
    // Toggles the fill of the closed area under the point.
    bool removed = false;
    for (size_t r = 0; r < net.regions.size(); r++) {
      auto polys = geom::flatten(net.regionPath(net.regions[r]), 0.1);
      if (geom::contains(polys, local, net.regions[r].windingRule == WindingRule::ODD)) {
        net.regions.erase(net.regions.begin() + static_cast<long>(r));
        removed = true;
        break;
      }
    }
    if (!removed) {
      double bestArea = 1e300;
      std::vector<uint32_t> best;
      for (const geom::VNChain& c : net.chains()) {
        if (!c.closed) continue;
        geom::Path p = net.chainPath(c);
        auto polys = geom::flatten(p, 0.1);
        if (!geom::contains(polys, local, false)) continue;
        Rect b = p.bounds();
        if (b.w * b.h < bestArea) bestArea = b.w * b.h, best = c.segments;
      }
      if (best.empty()) return P_HANDLED;
      VNRegion r;
      r.windingRule = WindingRule::NONZERO;
      r.loops.push_back(best);
      net.regions.push_back(r);
    }
    begin(TxnKind::USER, removed ? "Remove fill" : "Fill area");
    vector_.net = writeVector(vector_.node, net, vector_.startLocal);
    commit();
    vectorChanged();
    return P_HANDLED;
  }

  // MOVE / BEND.
  int hs = -1;
  bool atStart = false;
  if (!bend && vectorHandleAt(s, hs, atStart)) {
    vector_.drag = VectorSession::Drag::Handle;
    vector_.handleSegment = hs;
    vector_.handleAtStart = atStart;
    begin(TxnKind::GESTURE, "Edit vector");
    gesture_ = Gesture::Vector;
    return P_HANDLED | P_CAPTURE;
  }
  int v = vectorVertexAt(s);
  if (v >= 0) {
    uint32_t vv = static_cast<uint32_t>(v);
    if (bend) {
      // The bend tool on a point: sharp ↔ smooth.
      auto segs = incident(net, vv);
      bool smooth = false;
      for (uint32_t sg : segs) {
        Vec2 tg = tangentAt(net, sg, vv);
        smooth |= tg.x != 0 || tg.y != 0;
      }
      if (smooth) {
        for (uint32_t sg : segs) tangentAt(net, sg, vv) = {};
      } else if (segs.size() == 2) {
        auto other = [&](uint32_t sg) { const VNSegment& g = net.segments[sg]; return net.vertices[g.start == vv ? g.end : g.start].p; };
        Vec2 a = other(segs[0]), b = other(segs[1]), p = net.vertices[vv].p;
        Vec2 dir = b - a;
        double len = dir.length();
        if (len > 0) {
          dir = dir * (1 / len);
          tangentAt(net, segs[1], vv) = dir * ((b - p).length() / 3);
          tangentAt(net, segs[0], vv) = dir * (-(a - p).length() / 3);
        }
      }
      begin(TxnKind::USER, "Edit vector");
      vector_.net = writeVector(vector_.node, net, vector_.startLocal);
      commit();
      vector_.selVerts = {vv};
      vectorChanged();
      return P_HANDLED;
    }
    if (shift) eng::toggle(vector_.selVerts, vv);
    else if (!has(vector_.selVerts, vv)) vector_.selVerts = {vv}, vector_.selSegs.clear();
    vector_.drag = VectorSession::Drag::Vertices;
    begin(TxnKind::GESTURE, "Edit vector");
    gesture_ = Gesture::Vector;
    vectorChanged();
    return P_HANDLED | P_CAPTURE;
  }
  double t = 0;
  int seg = vectorSegmentAt(s, t);
  if (seg >= 0) {
    uint32_t sg = static_cast<uint32_t>(seg);
    if (bend) {
      vector_.drag = VectorSession::Drag::Bend;
      vector_.handleSegment = seg;
      vector_.bendT = std::clamp(t, 0.05, 0.95);
    } else {
      if (shift) eng::toggle(vector_.selSegs, sg);
      else if (!has(vector_.selSegs, sg)) vector_.selSegs = {sg}, vector_.selVerts.clear();
      vector_.drag = VectorSession::Drag::Vertices;
    }
    begin(TxnKind::GESTURE, "Edit vector");
    gesture_ = Gesture::Vector;
    vectorChanged();
    return P_HANDLED | P_CAPTURE;
  }
  // Nothing of the network: a click on another layer leaves the mode; a double-click anywhere too.
  auto path = hitPath(doc_, page_, world, pixel());
  if (clickCount >= 2 || (!path.empty() && path.back() != vector_.node && !doc_.isAncestor(path.back(), vector_.node))) {
    endVectorEdit();
    return clickCount >= 2 ? P_HANDLED : 0;
  }
  vector_.drag = VectorSession::Drag::Marquee;
  vector_.baseSel = shift ? vector_.selVerts : std::vector<uint32_t>{};
  vector_.marquee = {world.x, world.y, 0, 0};
  if (!shift) vector_.selVerts.clear(), vector_.selSegs.clear();
  gesture_ = Gesture::Vector;
  vectorChanged();
  return P_HANDLED | P_CAPTURE;
}

void Editor::vectorPointerMove(Vec2 s, uint32_t mods) {
  Vec2 world = camera_.toWorld(s);
  vector_.pointer = world;
  vector_.pointerKnown = true;
  if (vector_.node == kNoGuid) {
    if (tool_ == Tool::PEN) changeCursor(CursorKind::PEN);
    return;
  }
  if (gesture_ != Gesture::Vector) {
    int hv = vectorVertexAt(s);
    double t = 0;
    int hs = hv < 0 ? vectorSegmentAt(s, t) : -1;
    if (hv != vector_.hoverVertex || hs != vector_.hoverSegment) needsRender_ = true;
    vector_.hoverVertex = hv;
    vector_.hoverSegment = hs;
    if (vector_.tool == VectorTool::PEN) {
      changeCursor(hv >= 0 && vector_.penFrom >= 0 && hv != vector_.penFrom ? CursorKind::PEN_CLOSE
                   : hs >= 0 && vector_.penFrom < 0                         ? CursorKind::PEN_ADD
                                                                            : CursorKind::PEN);
      if (vector_.penFrom >= 0) needsRender_ = true;  // the preview follows the pointer
    } else if (vector_.tool == VectorTool::LASSO || vector_.tool == VectorTool::PAINT_BUCKET || vector_.tool == VectorTool::CUT ||
               vector_.tool == VectorTool::ERASE) {
      changeCursor(CursorKind::CROSSHAIR);
    } else {
      changeCursor(CursorKind::DEFAULT);
    }
    return;
  }
  if (!vector_.dragged && (s - downScreen_).length() < kDragThreshold) return;
  vector_.dragged = true;
  const Mat2x3 inv = vector_.startWorld.inverse();
  Vec2 l = inv.apply(world), l0 = inv.apply(downWorld_);
  VectorNetwork net = vector_.startNet;
  auto snapLocal = [&](Vec2 p) {
    if (mods & (MOD_CTRL | MOD_PRIMARY)) return p;
    Vec2 w = vector_.startWorld.apply(p);
    return inv.apply(Vec2{std::round(w.x), std::round(w.y)});
  };
  auto mirror = [&](uint32_t vertex, uint32_t seg, Vec2 tangent) {
    if (mods & MOD_ALT) return;  // ⌥ breaks the mirroring
    const NodeProps& p = doc_.get(vector_.node)->props;
    VectorMirror m = p.shape().handleMirroring;
    if (const VectorStyle* st = p.shape().vectorData.style(net.vertices[vertex].styleID); st && (st->mask & VS_MIRRORING)) m = st->handleMirroring;
    auto segs = incident(net, vertex);
    if (segs.size() != 2) return;
    uint32_t other = segs[0] == seg ? segs[1] : segs[0];
    Vec2& o = tangentAt(net, other, vertex);
    double len = tangent.length();
    if (m == VectorMirror::ANGLE_AND_LENGTH) o = tangent * -1;
    else if (m == VectorMirror::ANGLE && len > 0) o = tangent * (-o.length() / len);
  };
  switch (vector_.drag) {
    case VectorSession::Drag::Vertices: {
      std::set<uint32_t> moving(vector_.selVerts.begin(), vector_.selVerts.end());
      for (uint32_t sg : vector_.selSegs)
        if (sg < net.segments.size()) moving.insert(net.segments[sg].start), moving.insert(net.segments[sg].end);
      if (moving.empty()) return;
      // The first moving point snaps to the pixel grid; the others follow it.
      uint32_t lead = *moving.begin();
      Vec2 target = snapLocal(vector_.startNet.vertices[lead].p + (l - l0));
      // Preferences › Snap to geometry (round 9, help.figma.com "Snap to geometry": vector edit mode only): onto the
      // nearest other point within reach (⌃ / ⌘: no snapping).
      if ((viewOptions_ & VIEW_SNAP_GEOMETRY) && !(mods & (MOD_CTRL | MOD_PRIMARY))) {
        Vec2 at = vector_.startWorld.apply(vector_.startNet.vertices[lead].p + (l - l0));
        double best = kVertexReach / camera_.zoom;
        for (uint32_t v = 0; v < vector_.startNet.vertices.size(); v++) {
          if (moving.count(v)) continue;
          Vec2 p = vector_.startNet.vertices[v].p;
          double d = (vector_.startWorld.apply(p) - at).length();
          if (d <= best) best = d, target = p;
        }
      }
      Vec2 d = target - vector_.startNet.vertices[lead].p;
      if (mods & MOD_SHIFT) {
        Vec2 wd = vector_.startWorld.applyLinear(d);
        if (std::fabs(wd.x) > std::fabs(wd.y)) wd.y = 0;
        else wd.x = 0;
        Mat2x3 lin = inv;
        lin.m02 = lin.m12 = 0;
        d = lin.apply(wd);
      }
      for (uint32_t v : moving) net.vertices[v].p = vector_.startNet.vertices[v].p + d;
      break;
    }
    case VectorSession::Drag::Handle: {
      uint32_t sg = static_cast<uint32_t>(vector_.handleSegment);
      VNSegment& g = net.segments[sg];
      uint32_t vertex = vector_.handleAtStart ? g.start : g.end;
      Vec2 tangent = snapLocal(l) - net.vertices[vertex].p;
      (vector_.handleAtStart ? g.tangentStart : g.tangentEnd) = tangent;
      mirror(vertex, sg, tangent);
      break;
    }
    case VectorSession::Drag::Bend: {
      uint32_t sg = static_cast<uint32_t>(vector_.handleSegment);
      VNSegment& g = net.segments[sg];
      Vec2 a = net.vertices[g.start].p, b = net.vertices[g.end].p;
      if (g.isLine()) g.tangentStart = (b - a) * (1.0 / 3), g.tangentEnd = (a - b) * (1.0 / 3);
      double t = vector_.bendT;
      Vec2 now = geom::cubicAt(a, a + g.tangentStart, b + g.tangentEnd, b, t);
      double w = 3 * t * (1 - t);
      Vec2 delta = (l - now) * (1 / std::max(w, 1e-6));
      g.tangentStart = g.tangentStart + delta;
      g.tangentEnd = g.tangentEnd + delta;
      break;
    }
    case VectorSession::Drag::PenNew:
    case VectorSession::Drag::PenHandle: {
      uint32_t nv = static_cast<uint32_t>(vector_.newVertex);
      Vec2 out = l - net.vertices[nv].p;
      vector_.penOut = out;
      // The segment arriving at the new point takes the mirrored handle.
      for (auto& g : net.segments)
        if (g.end == nv) g.tangentEnd = out * -1;
      break;
    }
    case VectorSession::Drag::Marquee: {
      vector_.marquee = Rect::fromPoints(downWorld_, world);
      std::vector<uint32_t> sel = vector_.baseSel;
      for (uint32_t i = 0; i < net.vertices.size(); i++)
        if (vector_.marquee.contains(vector_.startWorld.apply(net.vertices[i].p)) && !has(sel, i)) sel.push_back(i);
      vector_.selVerts = sel;
      vectorChanged();
      return;
    }
    case VectorSession::Drag::Cut:
      vector_.trail = {vector_.trail.front(), world};
      needsRender_ = true;
      return;
    case VectorSession::Drag::Erase:
      vector_.trail.push_back(world);
      needsRender_ = true;
      return;
    case VectorSession::Drag::Lasso: {
      vector_.lasso.push_back(world);
      std::vector<uint32_t> sel = vector_.baseSel;
      if (vector_.lasso.size() > 2)
        for (uint32_t i = 0; i < net.vertices.size(); i++)
          if (insidePolygon(vector_.lasso, vector_.startWorld.apply(net.vertices[i].p)) && !has(sel, i)) sel.push_back(i);
      vector_.selVerts = sel;
      vectorChanged();
      return;
    }
    case VectorSession::Drag::None: return;
  }
  vector_.net = writeVector(vector_.node, net, vector_.startLocal);
  flushLayout();
  vectorChanged();
}

void Editor::vectorPointerUp(Vec2 s, uint32_t mods) {
  (void)mods;
  switch (vector_.drag) {
    case VectorSession::Drag::Marquee:
    case VectorSession::Drag::Lasso: break;
    case VectorSession::Drag::Cut: vectorCut(s); break;
    case VectorSession::Drag::Erase: vectorErase(); break;
    default:
      if (txn_.open) commit();
      break;
  }
  vector_.drag = VectorSession::Drag::None;
  vector_.lasso.clear();
  vector_.trail.clear();
  vectorChanged();
}

// ---- Cut and Erase (round 10; live toolbar/vector-edit-toolbar.txt lists them — what they do is help.figma.com's
// "Edit vector layers", unverified beyond it) ----------------------------------------------------------------------

namespace {

// The segment cut at `t`: it ends at a new point there and a new segment starts from another new point at the same
// place (the path comes apart); a loop through it no longer closes, so its region goes. Returns the second half.
uint32_t cutSegment(VectorNetwork& net, uint32_t seg, double t) {
  const VNSegment g = net.segments[seg];
  Vec2 a = net.vertices[g.start].p, b = net.vertices[g.end].p;
  Vec2 in[4] = {a, a + g.tangentStart, b + g.tangentEnd, b}, left[4], right[4];
  geom::cubicSection(in, 0, t, left);
  geom::cubicSection(in, t, 1, right);
  bool line = g.isLine();
  uint32_t va = static_cast<uint32_t>(net.vertices.size());
  net.vertices.push_back({left[3], 0});
  uint32_t vb = static_cast<uint32_t>(net.vertices.size());
  net.vertices.push_back({left[3], 0});
  net.segments[seg] = VNSegment{g.start, va, line ? Vec2{} : left[1] - left[0], line ? Vec2{} : left[2] - left[3], g.styleID};
  net.segments.push_back(VNSegment{vb, g.end, line ? Vec2{} : right[1] - right[0], line ? Vec2{} : right[2] - right[3], g.styleID});
  for (size_t r = net.regions.size(); r-- > 0;) {
    auto& loops = net.regions[r].loops;
    loops.erase(std::remove_if(loops.begin(), loops.end(), [&](const std::vector<uint32_t>& l) { return has(l, seg); }), loops.end());
    if (loops.empty()) net.regions.erase(net.regions.begin() + static_cast<long>(r));
  }
  return static_cast<uint32_t>(net.segments.size() - 1);
}

// The point taken apart: every segment meeting it after the first gets a point of its own there.
bool cutVertex(VectorNetwork& net, uint32_t v) {
  std::vector<uint32_t> segs;
  for (uint32_t i = 0; i < net.segments.size(); i++)
    if (net.segments[i].start == v || net.segments[i].end == v) segs.push_back(i);
  if (segs.size() < 2) return false;
  std::set<uint32_t> cut;
  for (size_t k = 1; k < segs.size(); k++) {
    uint32_t copy = static_cast<uint32_t>(net.vertices.size());
    net.vertices.push_back(net.vertices[v]);
    VNSegment& g = net.segments[segs[k]];
    if (g.start == v) g.start = copy;
    else g.end = copy;
    cut.insert(segs[k]);
  }
  for (size_t r = net.regions.size(); r-- > 0;) {
    auto& loops = net.regions[r].loops;
    loops.erase(std::remove_if(loops.begin(), loops.end(),
                               [&](const std::vector<uint32_t>& l) { return std::any_of(l.begin(), l.end(), [&](uint32_t x) { return cut.count(x) > 0; }); }),
                loops.end());
    if (loops.empty()) net.regions.erase(net.regions.begin() + static_cast<long>(r));
  }
  return true;
}

// Where segments a–b and c–d cross: the parameter along a–b, or -1.
double crossing(Vec2 a, Vec2 b, Vec2 c, Vec2 d) {
  Vec2 r = b - a, q = d - c;
  double den = r.x * q.y - r.y * q.x;
  if (std::fabs(den) < 1e-12) return -1;
  Vec2 ac = c - a;
  double t = (ac.x * q.y - ac.y * q.x) / den, u = (ac.x * r.y - ac.y * r.x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

}  // namespace

void Editor::vectorCut(Vec2 s) {
  if (vector_.node == kNoGuid || !doc_.get(vector_.node)) return;
  VectorNetwork net = vector_.net;
  bool changed = false;
  Vec2 a = vector_.trail.empty() ? camera_.toWorld(s) : vector_.trail.front();
  Vec2 b = camera_.toWorld(s);
  if ((camera_.toScreen(b) - camera_.toScreen(a)).length() < kDragThreshold) {
    // A click: the point under it taken apart, else the segment cut there.
    int v = vectorVertexAt(s);
    double t = 0;
    int seg = v < 0 ? vectorSegmentAt(s, t) : -1;
    if (v >= 0) changed = cutVertex(net, static_cast<uint32_t>(v));
    else if (seg >= 0 && t > 1e-6 && t < 1 - 1e-6) {
      cutSegment(net, static_cast<uint32_t>(seg), t);
      changed = true;
    }
  } else {
    // A line across the path: every segment it crosses is cut there.
    const Mat2x3 W = doc_.worldTransform(vector_.node);
    const size_t count = net.segments.size();
    for (uint32_t sg = 0; sg < count; sg++) {
      std::vector<double> ts;
      const int steps = 64;
      Vec2 prev = W.apply(segmentAt(net, sg, 0));
      for (int k = 1; k <= steps; k++) {
        Vec2 cur = W.apply(segmentAt(net, sg, static_cast<double>(k) / steps));
        double u = crossing(prev, cur, a, b);
        if (u >= 0) {
          double t = (k - 1 + u) / steps;
          if (t > 1e-6 && t < 1 - 1e-6 && (ts.empty() || t - ts.back() > 1e-6)) ts.push_back(t);
        }
        prev = cur;
      }
      // Cut from the start on: each later cut falls on the remaining half.
      uint32_t piece = sg;
      double done = 0;
      for (double t : ts) {
        piece = cutSegment(net, piece, (t - done) / (1 - done));
        done = t;
        changed = true;
      }
    }
  }
  if (!changed) return;
  begin(TxnKind::USER, "Cut");
  vector_.selVerts.clear();
  vector_.selSegs.clear();
  vector_.penFrom = -1;
  vector_.net = writeVector(vector_.node, net, doc_.get(vector_.node)->props.transform);
  commit();
}

void Editor::vectorErase() {
  if (vector_.node == kNoGuid || !doc_.get(vector_.node) || vector_.trail.empty()) return;
  // Every segment the path passes over (within the eraser's reach on screen) goes, and the points left alone with it.
  const Mat2x3 m = vectorToScreen();
  std::vector<Vec2> path;
  for (Vec2 w : vector_.trail) path.push_back(camera_.toScreen(w));
  VectorNetwork net = vector_.net;
  std::set<uint32_t> dropSegs;
  for (uint32_t sg = 0; sg < net.segments.size(); sg++) {
    const int steps = 48;
    Vec2 prev = m.apply(segmentAt(net, sg, 0));
    bool hit = false;
    for (int k = 1; k <= steps && !hit; k++) {
      Vec2 cur = m.apply(segmentAt(net, sg, static_cast<double>(k) / steps));
      Vec2 ab = cur - prev;
      double len2 = ab.x * ab.x + ab.y * ab.y;
      for (size_t i = 0; i < path.size() && !hit; i++) {
        Vec2 p = path[i];
        double u = len2 > 0 ? std::clamp(((p.x - prev.x) * ab.x + (p.y - prev.y) * ab.y) / len2, 0.0, 1.0) : 0;
        if ((p - (prev + ab * u)).length() <= kSegmentReach) hit = true;
        if (i > 0 && crossing(prev, cur, path[i - 1], p) >= 0) hit = true;
      }
      prev = cur;
    }
    if (hit) dropSegs.insert(sg);
  }
  if (dropSegs.empty()) return;
  std::set<uint32_t> used, dropVerts;
  for (uint32_t sg = 0; sg < net.segments.size(); sg++)
    if (!dropSegs.count(sg)) used.insert(net.segments[sg].start), used.insert(net.segments[sg].end);
  for (uint32_t sg : dropSegs)
    for (uint32_t v : {net.segments[sg].start, net.segments[sg].end})
      if (!used.count(v)) dropVerts.insert(v);
  VectorNetwork out;
  std::vector<int> vmap(net.vertices.size(), -1), smap(net.segments.size(), -1);
  for (uint32_t i = 0; i < net.vertices.size(); i++)
    if (!dropVerts.count(i)) vmap[i] = static_cast<int>(out.vertices.size()), out.vertices.push_back(net.vertices[i]);
  for (uint32_t i = 0; i < net.segments.size(); i++) {
    if (dropSegs.count(i)) continue;
    VNSegment g = net.segments[i];
    g.start = static_cast<uint32_t>(vmap[g.start]);
    g.end = static_cast<uint32_t>(vmap[g.end]);
    smap[i] = static_cast<int>(out.segments.size());
    out.segments.push_back(g);
  }
  for (const VNRegion& r : net.regions) {
    VNRegion nr = r;
    nr.loops.clear();
    for (const auto& loop : r.loops) {
      std::vector<uint32_t> l;
      bool whole = true;
      for (uint32_t x : loop) {
        if (smap[x] < 0) whole = false;
        else l.push_back(static_cast<uint32_t>(smap[x]));
      }
      if (whole && !l.empty()) nr.loops.push_back(l);
    }
    if (!nr.loops.empty()) out.regions.push_back(nr);
  }
  begin(TxnKind::USER, "Erase");
  vector_.selVerts.clear();
  vector_.selSegs.clear();
  vector_.penFrom = -1;
  vector_.net = writeVector(vector_.node, out, doc_.get(vector_.node)->props.transform);
  commit();
}

// ---- Keys -----------------------------------------------------------------------------------------

uint32_t Editor::vectorKey(KeyCode code, uint32_t mods) {
  bool primary = (mods & MOD_PRIMARY) != 0, shift = (mods & MOD_SHIFT) != 0;
  switch (code) {
    case KeyCode::Escape:
      if (gesture_ != Gesture::None) cancelGesture();
      else if (vector_.penFrom >= 0) vector_.penFrom = -1, vectorChanged();
      else if (vector_.tool != VectorTool::MOVE) setVectorTool(VectorTool::MOVE);
      else endVectorEdit();
      return K_HANDLED;
    case KeyCode::Enter:
    case KeyCode::NumpadEnter: endVectorEdit(); return K_HANDLED;
    case KeyCode::Backspace:
    case KeyCode::Delete:
      if (vector_.selVerts.empty() && vector_.selSegs.empty()) return K_HANDLED;
      vectorDeleteAndHeal();
      return K_HANDLED;
    case KeyCode::ArrowLeft:
    case KeyCode::ArrowRight:
    case KeyCode::ArrowUp:
    case KeyCode::ArrowDown: {
      if (primary || gesture_ != Gesture::None || (vector_.selVerts.empty() && vector_.selSegs.empty())) return K_HANDLED;
      double step = shift ? 10 : 1;
      Vec2 wd{code == KeyCode::ArrowLeft ? -step : code == KeyCode::ArrowRight ? step : 0,
              code == KeyCode::ArrowUp ? -step : code == KeyCode::ArrowDown ? step : 0};
      Mat2x3 lin = doc_.worldTransform(vector_.node).inverse();
      lin.m02 = lin.m12 = 0;
      Vec2 d = lin.apply(wd);
      VectorNetwork net = vector_.net;
      std::set<uint32_t> moving(vector_.selVerts.begin(), vector_.selVerts.end());
      for (uint32_t sg : vector_.selSegs) moving.insert(net.segments[sg].start), moving.insert(net.segments[sg].end);
      for (uint32_t v : moving) net.vertices[v].p = net.vertices[v].p + d;
      begin(TxnKind::USER, "Nudge");
      vector_.net = writeVector(vector_.node, net, doc_.get(vector_.node)->props.transform);
      commit();
      vectorChanged();
      return K_HANDLED;
    }
    case KeyCode::KeyA:
      if (!primary) return 0;
      vector_.selVerts.clear();
      for (uint32_t i = 0; i < vector_.net.vertices.size(); i++) vector_.selVerts.push_back(i);
      vectorChanged();
      return K_HANDLED;
    default: return 0;
  }
}

// ---- Edits from panels and menus -------------------------------------------------------------

Status Editor::vectorDeleteAndHeal() {
  if (vector_.node == kNoGuid || busy()) return E_INVALID;
  VectorNetwork net = vector_.net;
  std::set<uint32_t> dropVerts, dropSegs(vector_.selSegs.begin(), vector_.selSegs.end());
  for (uint32_t v : vector_.selVerts) {
    auto segs = incident(net, v);
    bool healable = segs.size() == 2 && !dropSegs.count(segs[0]) && !dropSegs.count(segs[1]);
    if (healable) {
      // Between two segments: they become one, from the neighbour before to the neighbour after.
      uint32_t a = segs[0], b = segs[1];
      const VNSegment sa = net.segments[a], sb = net.segments[b];
      uint32_t u = sa.start == v ? sa.end : sa.start, w = sb.start == v ? sb.end : sb.start;
      if (u != w && !dropVerts.count(u) && !dropVerts.count(w)) {
        Vec2 tu = sa.start == u ? sa.tangentStart : sa.tangentEnd;
        Vec2 tw = sb.start == w ? sb.tangentStart : sb.tangentEnd;
        net.segments.push_back(VNSegment{u, w, tu, tw, sa.styleID});
        uint32_t added = static_cast<uint32_t>(net.segments.size() - 1);
        for (auto& r : net.regions)
          for (auto& loop : r.loops)
            for (size_t i = 0; i < loop.size(); i++)
              if (loop[i] == a || loop[i] == b) {
                size_t j = (i + 1) % loop.size();
                if (loop[j] == a || loop[j] == b) {
                  loop[i] = added;
                  loop.erase(loop.begin() + static_cast<long>(j));
                }
                break;
              }
        dropSegs.insert(a);
        dropSegs.insert(b);
      }
    }
    dropVerts.insert(v);
  }
  net = compact(net, dropVerts, dropSegs);
  // Points no segment uses any more go too (unless that leaves nothing).
  std::set<uint32_t> lonely;
  for (uint32_t i = 0; i < net.vertices.size(); i++)
    if (incident(net, i).empty() && !dropSegs.empty()) lonely.insert(i);
  if (lonely.size() < net.vertices.size()) net = compact(net, lonely, {});
  begin(TxnKind::USER, "Delete");
  vector_.selVerts.clear();
  vector_.selSegs.clear();
  vector_.penFrom = -1;
  if (net.vertices.empty()) {
    // Nothing left: the layer goes.
    Guid id = vector_.node;
    vector_ = VectorSession{};
    write(NodeChange::removed(id));
    commit();
    changeSelection({});
    vectorChanged();
    return OK;
  }
  vector_.net = writeVector(vector_.node, net, doc_.get(vector_.node)->props.transform);
  commit();
  vectorChanged();
  return OK;
}

int Editor::vectorMirroring(VectorMirror& out) const {
  const Node* n = vector_.node != kNoGuid ? doc_.get(vector_.node) : nullptr;
  if (!n || vector_.selVerts.empty()) return 0;
  int state = 0;
  for (uint32_t v : vector_.selVerts) {
    VectorMirror m = n->props.shape().handleMirroring;
    if (v < vector_.net.vertices.size())
      if (const VectorStyle* st = n->props.shape().vectorData.style(vector_.net.vertices[v].styleID); st && (st->mask & VS_MIRRORING)) m = st->handleMirroring;
    if (state == 0) out = m, state = 1;
    else if (m != out) return 2;
  }
  return state;
}

std::vector<Editor::VectorPoint> Editor::vectorPoints() const {
  std::vector<VectorPoint> out;
  const Node* n = vector_.node != kNoGuid ? doc_.get(vector_.node) : nullptr;
  if (!n) return out;
  for (uint32_t v : vector_.selVerts) {
    if (v >= vector_.net.vertices.size()) continue;
    VectorPoint p{v, n->props.transform.apply(vector_.net.vertices[v].p), n->props.cornerRadii[0], n->props.shape().handleMirroring};
    if (const VectorStyle* st = n->props.shape().vectorData.style(vector_.net.vertices[v].styleID)) {
      if (st->mask & VS_CORNER_RADIUS) p.cornerRadius = st->cornerRadius;
      if (st->mask & VS_MIRRORING) p.mirroring = st->handleMirroring;
    }
    out.push_back(p);
  }
  return out;
}

Status Editor::setVectorMirroring(VectorMirror m) {
  if (vector_.node == kNoGuid || vector_.selVerts.empty() || busy()) return E_INVALID;
  const Node* n = doc_.get(vector_.node);
  VectorNetwork net = vector_.net;
  std::vector<VectorStyle> table = n->props.shape().vectorData.styleOverrideTable;
  for (uint32_t v : vector_.selVerts) {
    restyleVertex(net, table, v, [&](VectorStyle& st) {
      st.mask |= VS_MIRRORING;
      st.handleMirroring = m;
    });
    // Mirrored now: the second handle follows the first.
    auto segs = incident(net, v);
    if (segs.size() == 2 && m != VectorMirror::NONE) {
      Vec2 a = tangentAt(net, segs[0], v);
      Vec2& b = tangentAt(net, segs[1], v);
      double la = a.length();
      if (la > 0) b = m == VectorMirror::ANGLE_AND_LENGTH ? a * -1 : a * (-std::max(b.length(), la * 0.0) / la);
      if (m == VectorMirror::ANGLE && b.length() == 0 && la > 0) b = a * -1;
    }
  }
  begin(TxnKind::USER, "Change handle mirroring");
  vector_.net = writeVector(vector_.node, net, n->props.transform, &table);
  commit();
  vectorChanged();
  return OK;
}

Status Editor::setVectorPoints(const double* x, const double* y, const double* cornerRadius) {
  if (vector_.node == kNoGuid || vector_.selVerts.empty() || busy()) return E_INVALID;
  const Node* n = doc_.get(vector_.node);
  const NodeProps& p = n->props;
  VectorNetwork net = vector_.net;
  std::vector<VectorStyle> table = p.shape().vectorData.styleOverrideTable;
  if (x || y) {
    double minX = 1e300, minY = 1e300;
    for (uint32_t v : vector_.selVerts) {
      Vec2 q = p.transform.apply(net.vertices[v].p);
      minX = std::min(minX, q.x), minY = std::min(minY, q.y);
    }
    Vec2 d{x ? *x - minX : 0, y ? *y - minY : 0};
    Mat2x3 lin = p.transform.inverse();
    lin.m02 = lin.m12 = 0;
    Vec2 ld = lin.apply(d);
    for (uint32_t v : vector_.selVerts) net.vertices[v].p = net.vertices[v].p + ld;
  }
  if (cornerRadius)
    for (uint32_t v : vector_.selVerts)
      restyleVertex(net, table, v, [&](VectorStyle& st) {
        st.mask |= VS_CORNER_RADIUS;
        st.cornerRadius = std::max(0.0, *cornerRadius);
      });
  begin(TxnKind::USER, "Edit vector");
  vector_.net = writeVector(vector_.node, net, p.transform, &table);
  commit();
  vectorChanged();
  return OK;
}

bool Editor::endCaps(Guid id, StrokeCap& start, StrokeCap& end) const {
  const Node* n = doc_.get(id);
  if (!n || (n->props.type != NodeType::VECTOR && n->props.type != NodeType::LINE)) return false;
  const NodeProps& p = n->props;
  VectorNetwork net;
  bool convert = false;
  if (!networkOf(id, net, convert)) return false;
  auto capOf = [&](uint32_t v) {
    if (const VectorStyle* st = p.shape().vectorData.style(net.vertices[v].styleID); st && (st->mask & VS_STROKE_CAP)) return st->strokeCap;
    return p.strokeCap;
  };
  for (const geom::VNChain& c : net.chains())
    if (!c.closed) {
      start = capOf(c.firstVertex);
      end = capOf(c.lastVertex);
      return true;
    }
  return false;
}

Status Editor::setEndCaps(const std::vector<Guid>& ids, const StrokeCap* start, const StrokeCap* end) {
  if (busy()) return E_BUSY;
  begin(TxnKind::USER, "Change stroke caps");
  for (Guid id : ids) {
    const Node* n = doc_.get(id);
    if (!n || (n->props.type != NodeType::VECTOR && n->props.type != NodeType::LINE)) continue;
    const NodeProps& p = n->props;
    VectorNetwork net;
    bool convert = false;
    if (!networkOf(id, net, convert)) continue;
    std::vector<VectorStyle> table = p.shape().vectorData.styleOverrideTable;
    for (const geom::VNChain& c : net.chains()) {
      if (c.closed) continue;
      if (start) restyleVertex(net, table, c.firstVertex, [&](VectorStyle& st) { st.mask |= VS_STROKE_CAP, st.strokeCap = *start; });
      if (end) restyleVertex(net, table, c.lastVertex, [&](VectorStyle& st) { st.mask |= VS_STROKE_CAP, st.strokeCap = *end; });
    }
    VectorNetwork stored = writeVector(id, net, p.transform, &table);
    if (id == vector_.node) vector_.net = stored;
  }
  commit();
  if (vector_.node != kNoGuid) vectorChanged();
  return OK;
}

// ---- The overlay ---------------------------------------------------------------------------------

void Editor::vectorOverlay(Overlay& o) const {
  const Node* n = doc_.get(vector_.node);
  if (!n) return;
  Mat2x3 W = doc_.worldTransform(vector_.node);
  const VectorNetwork& net = vector_.net;
  o.selection = {};
  o.selectionBox = false;
  o.handles = false;
  o.sizeBadge = false;
  o.hover.clear();
  for (uint32_t sg = 0; sg < net.segments.size(); sg++) {
    const VNSegment& g = net.segments[sg];
    Vec2 a = net.vertices[g.start].p, b = net.vertices[g.end].p;
    bool hot = has(vector_.selSegs, sg) || static_cast<int>(sg) == vector_.hoverSegment;
    o.curves.push_back({W.apply(a), W.apply(a + g.tangentStart), W.apply(b + g.tangentEnd), W.apply(b), hot ? 2.0 : 1.0, hot});
  }
  forEachHandle(net, vector_.selVerts, vector_.selSegs, [&](uint32_t, bool, Vec2 vertex, Vec2 handle) {
    o.lines.push_back({W.apply(vertex), W.apply(handle), false, false});
    OverlayMark m;
    m.shape = OverlayMark::Shape::Handle;
    m.world = W.apply(handle);
    o.marks.push_back(m);
  });
  for (uint32_t v = 0; v < net.vertices.size(); v++) {
    OverlayMark m;
    m.shape = OverlayMark::Shape::Vertex;
    m.world = W.apply(net.vertices[v].p);
    m.selected = has(vector_.selVerts, v);
    m.hovered = static_cast<int>(v) == vector_.hoverVertex;
    o.marks.push_back(m);
  }
  // The pen's next segment, following the pointer.
  if (vector_.tool == VectorTool::PEN && vector_.penFrom >= 0 && vector_.pointerKnown && gesture_ == Gesture::None &&
      static_cast<size_t>(vector_.penFrom) < net.vertices.size()) {
    Vec2 a = net.vertices[static_cast<size_t>(vector_.penFrom)].p;
    Vec2 b = W.inverse().apply(vector_.pointer);
    o.curves.push_back({W.apply(a), W.apply(a + vector_.penOut), W.apply(b), W.apply(b), 1, true});
  }
  if (vector_.drag == VectorSession::Drag::Marquee && gesture_ == Gesture::Vector) {
    o.hasMarquee = true;
    o.marquee = vector_.marquee;
  }
  if (vector_.drag == VectorSession::Drag::Lasso) o.lasso = vector_.lasso;
  if (vector_.drag == VectorSession::Drag::Cut || vector_.drag == VectorSession::Drag::Erase) {
    o.trail = vector_.trail;
    o.trailWidth = vector_.drag == VectorSession::Drag::Erase ? 2 * kSegmentReach : 1;
  }
}

// ---- The Pencil ----------------------------------------------------------------------------------

void Editor::pencilFinish() {
  std::vector<Vec2> pts = pencilPoints_;
  pencilPoints_.clear();
  needsRender_ = true;
  if (pts.size() < 2) return;
  // Fewer points (within a screen pixel), then a smooth curve through them (Catmull-Rom as Béziers).
  std::vector<bool> keep(pts.size(), false);
  keep.front() = keep.back() = true;
  simplify(pts, 0, pts.size() - 1, 1.0 / camera_.zoom, keep);
  std::vector<Vec2> p;
  for (size_t i = 0; i < pts.size(); i++)
    if (keep[i]) p.push_back(pts[i]);
  if (p.size() < 2 || (p.front() - p.back()).length() * camera_.zoom < 2) {
    if (p.size() < 3) return;
  }
  Rect b = Rect::fromPoints(p[0], p[0]);
  for (Vec2 q : p) b = b.united(Rect::fromPoints(q, q));
  VectorNetwork net;
  for (Vec2 q : p) net.vertices.push_back({q - Vec2{b.x, b.y}, 0});
  for (size_t i = 0; i + 1 < p.size(); i++) {
    Vec2 p0 = net.vertices[i == 0 ? 0 : i - 1].p, p1 = net.vertices[i].p, p2 = net.vertices[i + 1].p;
    Vec2 p3 = net.vertices[std::min(i + 2, p.size() - 1)].p;
    net.segments.push_back(VNSegment{static_cast<uint32_t>(i), static_cast<uint32_t>(i + 1), (p2 - p0) * (1.0 / 6), (p1 - p3) * (1.0 / 6), 0});
  }
  begin(TxnKind::USER, "Pencil");
  Guid id = newGuid();
  NodeChange c = NodeChange::created(id, defaultProps(NodeType::VECTOR));
  c.props.name = "Vector";
  c.props.strokeCap = StrokeCap::ROUND;
  c.props.strokeJoin = StrokeJoin::ROUND;
  c.props.strokeWeight = 2;
  c.props.parentIndex = {drawParent_, placeAt(drawParent_, doc_.children(drawParent_).size(), kNoGuid)};
  c.props.transform = doc_.worldTransform(drawParent_).inverse() * Mat2x3::translate(b.x, b.y);
  write(c);
  writeVector(id, net, doc_.get(id)->props.transform);
  commit();
  changeSelection({id});
}

}  // namespace eng
