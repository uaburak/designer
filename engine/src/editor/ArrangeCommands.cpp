// Round 10 — the Figma menu's Object, Arrange and Vector commands live Figma has (docs/engine-build.md "Round 10 —
// Menus, commands, left side and toolbar"; live menus/main-object.txt, main-arrange.txt, main-vector.txt,
// context-frame.txt): Convert to section / Convert to frame (in place: same GUID, layers and look), Distribute left /
// horizontal centers / right / top / vertical centers / bottom, Pack horizontal / vertical, Round to pixel, and vector
// edit mode's Join / Smooth join selection, Split / Simplify / Offset vector (help.figma.com "Simplify a vector path",
// "Offset a vector path"; what the live app does beyond those pages is unverified). Each is one undo step.

#include <algorithm>
#include <cmath>
#include <functional>
#include <set>

#include "editor/Editor.h"
#include "geometry/Boolean.h"
#include "geometry/Stroker.h"
#include "geometry/VectorNetwork.h"

namespace eng {

namespace {

using geom::VectorNetwork;
using geom::VNSegment;

bool canvasLevelParent(const Document& doc, Guid id) {
  const Node* p = doc.get(doc.parentOf(id));
  return p && (p->props.type == NodeType::CANVAS || p->props.type == NodeType::SECTION);
}

std::vector<uint32_t> incidentSegments(const VectorNetwork& n, uint32_t v, const std::vector<bool>* alive = nullptr) {
  std::vector<uint32_t> out;
  for (uint32_t i = 0; i < n.segments.size(); i++)
    if ((!alive || (*alive)[i]) && (n.segments[i].start == v || n.segments[i].end == v)) out.push_back(i);
  return out;
}

// The network without the dropped vertices and segments (indices re-numbered; loops through a dropped segment go).
VectorNetwork compacted(const VectorNetwork& n, const std::set<uint32_t>& dropVerts, const std::set<uint32_t>& dropSegs) {
  VectorNetwork out;
  std::vector<int> vmap(n.vertices.size(), -1), smap(n.segments.size(), -1);
  for (uint32_t i = 0; i < n.vertices.size(); i++)
    if (!dropVerts.count(i)) {
      vmap[i] = static_cast<int>(out.vertices.size());
      out.vertices.push_back(n.vertices[i]);
    }
  for (uint32_t i = 0; i < n.segments.size(); i++) {
    const VNSegment& s = n.segments[i];
    if (dropSegs.count(i) || vmap[s.start] < 0 || vmap[s.end] < 0) continue;
    smap[i] = static_cast<int>(out.segments.size());
    VNSegment c = s;
    c.start = static_cast<uint32_t>(vmap[s.start]);
    c.end = static_cast<uint32_t>(vmap[s.end]);
    out.segments.push_back(c);
  }
  for (const geom::VNRegion& r : n.regions) {
    geom::VNRegion nr = r;
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

Vec2 unit(Vec2 v) {
  double l = v.length();
  return l > 1e-12 ? v * (1 / l) : Vec2{0, 0};
}
double dot(Vec2 a, Vec2 b) { return a.x * b.x + a.y * b.y; }

// The segment's points from `from` (its start or end) on: the four control points in that direction.
void controls(const VectorNetwork& n, uint32_t s, uint32_t from, Vec2 out[4]) {
  const VNSegment& g = n.segments[s];
  Vec2 a = n.vertices[g.start].p, b = n.vertices[g.end].p;
  Vec2 c[4] = {a, a + g.tangentStart, b + g.tangentEnd, b};
  if (g.start == from)
    for (int i = 0; i < 4; i++) out[i] = c[i];
  else
    for (int i = 0; i < 4; i++) out[i] = c[3 - i];
}

// Samples along a cubic (excluding its start).
void sampleCubic(const Vec2 c[4], std::vector<Vec2>& out, int steps = 12) {
  for (int i = 1; i <= steps; i++) out.push_back(geom::cubicAt(c[0], c[1], c[2], c[3], static_cast<double>(i) / steps));
}

// One cubic from p0 to p3 leaving along t1 and arriving along −t2 (unit tangents), fitted to `pts` (p0 … p3) by least
// squares on the handle lengths (Schneider's method); the largest distance from a sample to it in `error`.
void fitCubic(const std::vector<Vec2>& pts, Vec2 t1, Vec2 t2, Vec2 out[4], double& error) {
  Vec2 p0 = pts.front(), p3 = pts.back();
  std::vector<double> u(pts.size(), 0);
  for (size_t i = 1; i < pts.size(); i++) u[i] = u[i - 1] + (pts[i] - pts[i - 1]).length();
  double total = u.back();
  if (total > 0)
    for (double& x : u) x /= total;
  double c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (size_t i = 0; i < pts.size(); i++) {
    double t = u[i], s = 1 - t;
    double b0 = s * s * s, b1 = 3 * t * s * s, b2 = 3 * t * t * s, b3 = t * t * t;
    Vec2 a1 = t1 * b1, a2 = t2 * b2;
    c00 += dot(a1, a1), c01 += dot(a1, a2), c11 += dot(a2, a2);
    Vec2 tmp = pts[i] - (p0 * (b0 + b1) + p3 * (b2 + b3));
    x0 += dot(a1, tmp), x1 += dot(a2, tmp);
  }
  double det = c00 * c11 - c01 * c01;
  double chord = (p3 - p0).length();
  double alpha1 = std::fabs(det) > 1e-12 ? (x0 * c11 - x1 * c01) / det : chord / 3;
  double alpha2 = std::fabs(det) > 1e-12 ? (c00 * x1 - c01 * x0) / det : chord / 3;
  if (alpha1 < 1e-6 * chord || alpha2 < 1e-6 * chord) alpha1 = alpha2 = chord / 3;
  out[0] = p0, out[1] = p0 + t1 * alpha1, out[2] = p3 + t2 * alpha2, out[3] = p3;
  error = 0;
  for (size_t i = 0; i < pts.size(); i++) error = std::max(error, (geom::cubicAt(out[0], out[1], out[2], out[3], u[i]) - pts[i]).length());
}

// The direction a segment leaves `from` in (its handle, else towards its other end).
Vec2 leaving(const Vec2 c[4]) {
  Vec2 d = c[1] - c[0];
  if (d.length() < 1e-9) d = c[2] - c[0];
  if (d.length() < 1e-9) d = c[3] - c[0];
  return unit(d);
}

}  // namespace

// ---- Convert to section / frame ------------------------------------------------------------------------------------

std::vector<Guid> Editor::convertibleToSection() const {
  // Live (context-frame.txt): a top-level frame — not a component, an instance, a group or a section.
  std::vector<Guid> out;
  for (Guid id : topSelectionInPaintOrder()) {
    const Node* n = doc_.get(id);
    if (!n || id.isDerived() || n->props.locked) continue;
    const NodeProps& p = n->props;
    if (p.type == NodeType::FRAME && !p.isGroupLike() && !p.isComponentish() && canvasLevelParent(doc_, id)) out.push_back(id);
  }
  return out;
}

std::vector<Guid> Editor::convertibleToFrame() const {
  // A section without sections in it (a frame can't hold one).
  std::vector<Guid> out;
  for (Guid id : topSelectionInPaintOrder()) {
    const Node* n = doc_.get(id);
    if (!n || id.isDerived() || n->props.locked || n->props.type != NodeType::SECTION) continue;
    bool nested = false;
    for (Guid c : doc_.children(id))
      if (const Node* k = doc_.get(c); k && k->props.type == NodeType::SECTION) nested = true;
    if (!nested) out.push_back(id);
  }
  return out;
}

Status Editor::convertKind(bool toSection) {
  std::vector<Guid> ids = toSection ? convertibleToSection() : convertibleToFrame();
  if (ids.empty()) return E_INVALID;
  begin(TxnKind::USER, toSection ? "Convert to section" : "Convert to frame");
  for (Guid id : ids) {
    NodeChange c = NodeChange::changed(id);
    c.mask = F_TYPE | F_FRAME_MASK_DISABLED;
    if (toSection) {
      // A section keeps the frame's place, size, name, fills, strokes and layers; it has no auto layout, effects or
      // clipping, and Figma's section corners (radius 2).
      c.props.type = NodeType::SECTION;
      c.props.frameMaskDisabled = true;
      c.mask |= F_STACK_MODE | F_EFFECTS | F_CORNER_RADII;
      c.props.stack().stackMode = StackMode::NONE;
      c.props.effects.clear();
      c.props.cornerRadii = {2, 2, 2, 2};
    } else {
      // A frame from a section: its look and layers; it clips like a new frame.
      c.props.type = NodeType::FRAME;
      c.props.frameMaskDisabled = false;
    }
    write(c);
  }
  changeSelection(ids);
  commit();
  return OK;
}

// ---- Distribute edges, pack, round to pixel ------------------------------------------------------------------------

Status Editor::distributeEdges(CommandId id) {
  std::vector<Guid> ids = arrangeable();
  if (ids.size() < 3) return E_INVALID;
  bool horizontal = id == CommandId::DISTRIBUTE_LEFT || id == CommandId::DISTRIBUTE_HORIZONTAL_CENTERS || id == CommandId::DISTRIBUTE_RIGHT;
  // Which edge: 0 the low one (left / top), 1 the centre, 2 the high one (right / bottom).
  int which = (id == CommandId::DISTRIBUTE_LEFT || id == CommandId::DISTRIBUTE_TOP) ? 0
              : (id == CommandId::DISTRIBUTE_HORIZONTAL_CENTERS || id == CommandId::DISTRIBUTE_VERTICAL_CENTERS) ? 1
                                                                                                                    : 2;
  auto edge = [&](const Rect& r) {
    double lo = horizontal ? r.x : r.y, len = horizontal ? r.w : r.h;
    return lo + len * which / 2.0;
  };
  std::vector<std::pair<Guid, Rect>> items;
  for (Guid g : ids) items.push_back({g, doc_.worldBounds(g)});
  std::stable_sort(items.begin(), items.end(), [&](auto& a, auto& b) { return edge(a.second) < edge(b.second); });
  double first = edge(items.front().second), last = edge(items.back().second);
  double step = (last - first) / static_cast<double>(items.size() - 1);
  static const char* kLabels[] = {"Distribute left", "Distribute horizontal centers", "Distribute right", "Distribute top", "Distribute vertical centers", "Distribute bottom"};
  begin(TxnKind::USER, kLabels[static_cast<uint32_t>(id) - static_cast<uint32_t>(CommandId::DISTRIBUTE_LEFT)]);
  for (size_t i = 1; i + 1 < items.size(); i++) {
    double d = first + step * static_cast<double>(i) - edge(items[i].second);
    shiftWorld(items[i].first, horizontal ? Vec2{d, 0} : Vec2{0, d});
  }
  commit();
  return OK;
}

Status Editor::pack(bool horizontal) {
  // Side by side in the order they lie, no space between them; the first stays (unverified beyond the label).
  std::vector<Guid> ids = arrangeable();
  if (ids.size() < 2) return E_INVALID;
  std::vector<std::pair<Guid, Rect>> items;
  for (Guid g : ids) items.push_back({g, doc_.worldBounds(g)});
  // In the order they lie (ties: across the other axis).
  std::stable_sort(items.begin(), items.end(), [&](auto& a, auto& b) {
    double pa = horizontal ? a.second.x : a.second.y, pb = horizontal ? b.second.x : b.second.y;
    if (pa != pb) return pa < pb;
    return horizontal ? a.second.y < b.second.y : a.second.x < b.second.x;
  });
  begin(TxnKind::USER, horizontal ? "Pack horizontal" : "Pack vertical");
  double at = horizontal ? items[0].second.right() : items[0].second.bottom();
  for (size_t i = 1; i < items.size(); i++) {
    const Rect& r = items[i].second;
    double d = at - (horizontal ? r.x : r.y);
    shiftWorld(items[i].first, horizontal ? Vec2{d, 0} : Vec2{0, d});
    at += horizontal ? r.w : r.h;
  }
  commit();
  return OK;
}

Status Editor::roundToPixel() {
  std::vector<Guid> ids;
  for (Guid id : topLevelSelection(doc_, selection_)) {
    const Node* n = doc_.get(id);
    if (n && !id.isDerived() && !n->props.locked) ids.push_back(id);
  }
  if (ids.empty()) return E_INVALID;
  begin(TxnKind::USER, "Round to pixel");
  for (Guid id : ids) {
    const NodeProps& p = doc_.get(id)->props;
    // The size first (a text that sizes itself keeps its own), then the box's corner on a whole pixel.
    bool autoSized = p.type == NodeType::TEXT && p.text().textAutoResize != TextAutoResize::NONE;
    Vec2 size{std::round(p.size.x), std::round(p.size.y)};
    if (!autoSized && (size.x != p.size.x || size.y != p.size.y) && size.x >= (p.size.x > 0 ? 1 : 0) && size.y >= (p.size.y > 0 ? 1 : 0)) {
      NodeChange c = NodeChange::changed(id);
      c.mask = F_SIZE;
      c.props.size = size;
      write(c);
    }
    Rect b = doc_.worldBounds(id);
    shiftWorld(id, {std::round(b.x) - b.x, std::round(b.y) - b.y});
  }
  commit();
  return OK;
}

// ---- Vector ---------------------------------------------------------------------------------------------------------

void Editor::writeAsVector(Guid id, const VectorNetwork& net) {
  const Node* n = doc_.get(id);
  if (!n) return;
  if (n->props.type != NodeType::VECTOR) {
    NodeChange c = NodeChange::changed(id);
    c.mask = F_TYPE | F_CORNER_RADII | F_CORNER_SMOOTHING | F_INVERTED_CORNERS | F_ARC_DATA;
    c.props.type = NodeType::VECTOR;
    c.props.cornerRadii = {0, 0, 0, 0};
    c.props.stroke().cornerSmoothing = 0;
    c.props.shape().arcData = {};
    write(c);
  }
  writeVector(id, net, doc_.get(id)->props.transform);
}

std::vector<Guid> Editor::vectorTargets() const {
  // The edited layer, else the selected layers with a path (vectors, lines, shapes).
  if (vector_.node != kNoGuid) return {vector_.node};
  std::vector<Guid> out;
  for (Guid id : topSelectionInPaintOrder()) {
    const Node* n = doc_.get(id);
    if (!n || id.isDerived() || n->props.locked) continue;
    const NodeProps& p = n->props;
    if (p.type == NodeType::VECTOR || p.type == NodeType::LINE || p.isRectLike() || p.type == NodeType::ELLIPSE || p.type == NodeType::STAR ||
        p.type == NodeType::REGULAR_POLYGON)
      out.push_back(id);
  }
  return out;
}

bool Editor::vectorJoinable() const {
  return vector_.node != kNoGuid && vector_.selVerts.size() >= 2 && !busy();
}

Status Editor::vectorJoin(bool smooth) {
  // ⌘J / ⇧⌘J (help.figma.com "Edit vector layers"): the selected points joined in the order they were picked — a
  // straight segment, or one leaving each end along its path (smooth); points on top of each other become one.
  if (!vectorJoinable()) return E_INVALID;
  VectorNetwork net = vector_.net;
  std::vector<uint32_t> sel = vector_.selVerts;
  std::set<uint32_t> dropVerts;
  bool changed = false;
  auto outward = [&](uint32_t v) {
    auto segs = incidentSegments(net, v);
    if (segs.size() != 1) return Vec2{0, 0};
    Vec2 c[4];
    controls(net, segs[0], v, c);
    return leaving(c) * -1;
  };
  for (size_t i = 1; i < sel.size(); i++) {
    uint32_t a = sel[i - 1], b = sel[i];
    if (a == b || dropVerts.count(a) || dropVerts.count(b)) continue;
    Vec2 pa = net.vertices[a].p, pb = net.vertices[b].p;
    if ((pa - pb).length() < 0.01) {
      // On top of each other: b's segments move to a.
      for (auto& s : net.segments) {
        if (s.start == b) s.start = a;
        if (s.end == b) s.end = a;
      }
      dropVerts.insert(b);
      sel[i] = a;
      changed = true;
      continue;
    }
    bool exists = false;
    for (auto& s : net.segments) exists |= (s.start == a && s.end == b) || (s.start == b && s.end == a);
    if (exists) continue;
    VNSegment seg{a, b, {}, {}, 0};
    if (smooth) {
      double len = (pb - pa).length() / 3;
      seg.tangentStart = outward(a) * len;
      seg.tangentEnd = outward(b) * len;
    }
    net.segments.push_back(seg);
    changed = true;
  }
  if (!changed) return E_INVALID;
  if (!dropVerts.empty()) net = compacted(net, dropVerts, {});
  begin(TxnKind::USER, smooth ? "Smooth join selection" : "Join selection");
  vector_.selVerts.clear();
  vector_.selSegs.clear();
  vector_.penFrom = -1;
  vector_.net = writeVector(vector_.node, net, doc_.get(vector_.node)->props.transform);
  commit();
  vectorChanged();
  return OK;
}

Status Editor::vectorSplit() {
  // Unverified (no help page): in vector edit mode the path splits at the selected points — each segment meeting there
  // gets its own end; otherwise each selected vector's separate parts become layers of their own.
  if (vector_.node != kNoGuid) {
    if (vector_.selVerts.empty() || busy()) return E_INVALID;
    VectorNetwork net = vector_.net;
    bool changed = false;
    for (uint32_t v : vector_.selVerts) {
      auto segs = incidentSegments(net, v);
      for (size_t i = 1; i < segs.size(); i++) {
        net.vertices.push_back(net.vertices[v]);
        uint32_t copy = static_cast<uint32_t>(net.vertices.size() - 1);
        VNSegment& s = net.segments[segs[i]];
        if (s.start == v) s.start = copy;
        if (s.end == v) s.end = copy;
        changed = true;
      }
    }
    if (!changed) return E_INVALID;
    // Loops through a split point no longer close: their regions go (open paths don't fill).
    net.regions.clear();
    begin(TxnKind::USER, "Split vector");
    vector_.selVerts.clear();
    vector_.net = writeVector(vector_.node, net, doc_.get(vector_.node)->props.transform);
    commit();
    vectorChanged();
    return OK;
  }
  struct Part {
    Guid id;
    std::vector<VectorNetwork> pieces;
  };
  std::vector<Part> parts;
  for (Guid id : vectorTargets()) {
    VectorNetwork net;
    bool convert = false;
    if (!networkOf(id, net, convert) || net.vertices.empty()) continue;
    // Connected parts (by segments).
    std::vector<int> comp(net.vertices.size(), -1);
    int count = 0;
    for (uint32_t v = 0; v < net.vertices.size(); v++) {
      if (comp[v] >= 0) continue;
      std::vector<uint32_t> stack{v};
      comp[v] = count;
      while (!stack.empty()) {
        uint32_t x = stack.back();
        stack.pop_back();
        for (const VNSegment& s : net.segments) {
          uint32_t y = s.start == x ? s.end : s.end == x ? s.start : UINT32_MAX;
          if (y != UINT32_MAX && comp[y] < 0) comp[y] = count, stack.push_back(y);
        }
      }
      count++;
    }
    if (count < 2) continue;
    Part part{id, {}};
    for (int k = 0; k < count; k++) {
      std::set<uint32_t> drop;
      for (uint32_t v = 0; v < net.vertices.size(); v++)
        if (comp[v] != k) drop.insert(v);
      part.pieces.push_back(compacted(net, drop, {}));
    }
    parts.push_back(std::move(part));
  }
  if (parts.empty()) return E_INVALID;
  begin(TxnKind::USER, "Split vector");
  std::vector<Guid> made;
  for (Part& part : parts) {
    const NodeProps base = doc_.get(part.id)->props;
    Guid parent = doc_.parentOf(part.id);
    const auto& siblings = doc_.children(parent);
    size_t index = static_cast<size_t>(std::find(siblings.begin(), siblings.end(), part.id) - siblings.begin());
    // The first part stays the layer; the others go just above it, the layer's look and name kept.
    writeAsVector(part.id, part.pieces[0]);
    made.push_back(part.id);
    for (size_t k = 1; k < part.pieces.size(); k++) {
      NodeProps v = doc_.get(part.id)->props;
      v.parentIndex = {parent, placeAt(parent, index + k, kNoGuid)};
      v.name = base.name;
      Guid id = newGuid();
      write(NodeChange::created(id, v));
      writeVector(id, part.pieces[k], base.transform);
      made.push_back(id);
    }
  }
  changeSelection(made);
  commit();
  return OK;
}

Status Editor::vectorSimplify(double amount) {
  // help.figma.com "Simplify a vector path": fewer points, the shape kept; `amount` (0…1) how far a merged curve may
  // stray from the path — up to 5 % of the layer's longer side (the slider's scale is unverified).
  std::vector<Guid> ids = vectorTargets();
  if (ids.empty() || busy()) return E_INVALID;
  amount = std::clamp(amount, 0.0, 1.0);
  bool editing = vector_.node != kNoGuid;
  struct Result {
    Guid id;
    VectorNetwork net;
  };
  std::vector<Result> results;
  for (Guid id : ids) {
    VectorNetwork net;
    bool convert = false;
    if (editing && id == vector_.node) net = vector_.net;
    else if (!networkOf(id, net, convert)) continue;
    if (net.segments.size() < 2) continue;
    Rect b = net.bounds();
    double tol = amount * 0.05 * std::max({b.w, b.h, 1.0});
    // Each segment's samples of the original path (from its start to its end).
    std::vector<std::vector<Vec2>> samples(net.segments.size());
    for (uint32_t s = 0; s < net.segments.size(); s++) {
      Vec2 c[4];
      controls(net, s, net.segments[s].start, c);
      samples[s].push_back(c[0]);
      sampleCubic(c, samples[s]);
    }
    std::vector<bool> alive(net.segments.size(), true);
    std::set<uint32_t> dropVerts;
    bool merged = true;
    while (merged) {
      merged = false;
      for (uint32_t v = 0; v < net.vertices.size(); v++) {
        if (dropVerts.count(v)) continue;
        auto segs = incidentSegments(net, v, &alive);
        if (segs.size() != 2 || segs[0] == segs[1]) continue;
        const VNSegment sa = net.segments[segs[0]], sb = net.segments[segs[1]];
        uint32_t u = sa.start == v ? sa.end : sa.start, w = sb.start == v ? sb.end : sb.start;
        if (u == v || w == v || u == w) continue;
        // The run u → v → w, and its samples in that order.
        std::vector<Vec2> pts;
        auto add = [&](uint32_t s, bool forwards) {
          std::vector<Vec2> p = samples[s];
          if (!forwards) std::reverse(p.begin(), p.end());
          pts.insert(pts.end(), pts.empty() ? p.begin() : p.begin() + 1, p.end());
        };
        add(segs[0], sa.end == v);
        add(segs[1], sb.start == v);
        Vec2 ca[4], cb[4];
        controls(net, segs[0], u, ca);
        controls(net, segs[1], w, cb);
        Vec2 fit[4];
        double err = 0;
        bool lines = sa.isLine() && sb.isLine();
        if (lines) {
          fit[0] = fit[1] = net.vertices[u].p;
          fit[2] = fit[3] = net.vertices[w].p;
          err = 0;
          for (const Vec2& p : pts) {
            Vec2 ab = fit[3] - fit[0];
            double len = ab.length();
            double d = len > 1e-12 ? std::fabs((p.x - fit[0].x) * ab.y - (p.y - fit[0].y) * ab.x) / len : (p - fit[0]).length();
            err = std::max(err, d);
          }
        } else {
          fitCubic(pts, leaving(ca), leaving(cb), fit, err);
        }
        if (err > tol) continue;
        VNSegment seg{u, w, lines ? Vec2{} : fit[1] - fit[0], lines ? Vec2{} : fit[2] - fit[3], sa.styleID};
        net.segments.push_back(seg);
        alive.push_back(true);
        samples.push_back(pts);
        uint32_t added = static_cast<uint32_t>(net.segments.size() - 1);
        alive[segs[0]] = alive[segs[1]] = false;
        for (auto& r : net.regions)
          for (auto& loop : r.loops)
            for (size_t i = 0; i < loop.size(); i++)
              if (loop[i] == segs[0] || loop[i] == segs[1]) {
                size_t j = (i + 1) % loop.size();
                if (loop[j] == segs[0] || loop[j] == segs[1]) {
                  loop[i] = added;
                  loop.erase(loop.begin() + static_cast<long>(j));
                } else if (i == 0 && (loop.back() == segs[0] || loop.back() == segs[1])) {
                  loop[0] = added;
                  loop.pop_back();
                }
                break;
              }
        dropVerts.insert(v);
        merged = true;
      }
    }
    if (dropVerts.empty()) continue;
    std::set<uint32_t> dropSegs;
    for (uint32_t s = 0; s < alive.size(); s++)
      if (!alive[s]) dropSegs.insert(s);
    results.push_back({id, compacted(net, dropVerts, dropSegs)});
  }
  if (results.empty()) return E_INVALID;
  begin(TxnKind::USER, "Simplify vector");
  for (Result& r : results) {
    if (editing && r.id == vector_.node) {
      vector_.selVerts.clear();
      vector_.selSegs.clear();
      vector_.penFrom = -1;
      vector_.net = writeVector(r.id, r.net, doc_.get(r.id)->props.transform);
      vector_.pendingType = false;
    } else {
      writeAsVector(r.id, r.net);
    }
  }
  commit();
  if (editing) vectorChanged();
  return OK;
}

Status Editor::vectorOffset(double amount, StrokeJoin join) {
  // help.figma.com "Offset a vector path": the outline grown by `amount` (positive) or shrunk (negative), with square
  // (miter) or round joins; an open path becomes its outline at that distance (unverified).
  std::vector<Guid> ids = vectorTargets();
  if (ids.empty() || busy() || amount == 0) return E_INVALID;
  if (vector_.node != kNoGuid) endVectorEdit();
  begin(TxnKind::USER, "Offset vector");
  const double tol = 0.02;
  std::vector<Guid> done;
  for (Guid id : ids) {
    const NodeGeometry* g = doc_.geometry(id);
    if (!g) continue;
    const NodeProps p = doc_.get(id)->props;
    geom::StrokeStyle style;
    style.width = 2 * std::fabs(amount);
    style.join = join;
    style.miterLimit = 4;
    style.cap = join == StrokeJoin::ROUND ? StrokeCap::ROUND : StrokeCap::SQUARE;
    geom::Path fill;
    for (auto& f : g->fills) fill.append(f.path);
    geom::Path shape;
    bool closed = !fill.empty() && !g->hasOpenEnds;
    if (closed) {
      geom::Path ring = geom::strokePath(fill, style, tol);
      std::vector<geom::Operand> ops{{fill, g->fills.empty() ? WindingRule::NONZERO : g->fills[0].windingRule}, {ring, WindingRule::NONZERO}};
      shape = geom::booleanOp(ops, amount > 0 ? BooleanOperation::UNION : BooleanOperation::SUBTRACT, tol);
    } else if (!g->stroke.path.empty()) {
      shape = geom::simplify(geom::strokePath(g->stroke.path, style, tol), WindingRule::NONZERO, tol);
    }
    if (shape.empty()) continue;
    VectorNetwork net = geom::networkFromPath(shape, WindingRule::NONZERO);
    if (!closed) {
      // The outline of an open path is filled with its stroke's paint.
      NodeChange c = NodeChange::changed(id);
      c.mask = F_FILLS | F_STROKES;
      c.props.fillPaints = p.strokePaints;
      c.props.strokePaints.clear();
      write(c);
    }
    writeAsVector(id, net);
    done.push_back(id);
  }
  if (done.empty()) {
    commit();
    return E_INVALID;
  }
  changeSelection(done);
  commit();
  return OK;
}

// ---- Set default properties ---------------------------------------------------------------------------------------

namespace {

// What "Set default properties" carries (the forum's reports: fills, strokes, a text's font and alignment).
constexpr FieldMask kDefaultFields = F_OPACITY | F_FILLS | F_STROKES | F_STROKE_WEIGHT | F_STROKE_ALIGN | F_STROKE_JOIN | F_STROKE_CAP |
                                     F_DASH_PATTERN | F_EFFECTS | F_BLEND_MODE | F_CORNER_RADII | F_CORNER_SMOOTHING | F_INVERTED_CORNERS | F_FONT_NAME |
                                     F_FONT_SIZE | F_LINE_HEIGHT | F_LETTER_SPACING | F_TEXT_ALIGN_H | F_TEXT_CASE | F_TEXT_DECORATION;

bool takesDefaults(NodeType t) {
  switch (t) {
    case NodeType::RECTANGLE:
    case NodeType::ROUNDED_RECTANGLE:
    case NodeType::ELLIPSE:
    case NodeType::REGULAR_POLYGON:
    case NodeType::STAR:
    case NodeType::LINE:
    case NodeType::VECTOR:
    case NodeType::TEXT: return true;
    default: return false;
  }
}

}  // namespace

bool Editor::canSetDefaultProperties() const {
  if (selection_.size() != 1 || selection_[0].isDerived()) return false;
  const Node* n = doc_.get(selection_[0]);
  return n && takesDefaults(n->props.type);
}

Status Editor::setDefaultProperties() {
  if (!canSetDefaultProperties()) return E_INVALID;
  const NodeProps& p = doc_.get(selection_[0])->props;
  NodeType t = p.type == NodeType::RECTANGLE ? NodeType::ROUNDED_RECTANGLE : p.type;
  NodeProps d = defaultProps(t);
  copyFields(d, p, kDefaultFields);
  userDefaults_[t] = d;
  return OK;
}

NodeProps Editor::toolProps(NodeType type) const {
  NodeProps p = defaultProps(type);
  auto it = userDefaults_.find(type == NodeType::RECTANGLE ? NodeType::ROUNDED_RECTANGLE : type);
  if (it != userDefaults_.end()) copyFields(p, it->second, kDefaultFields);
  return p;
}

// ---- Dispatch -------------------------------------------------------------------------------------------------------

Status Editor::arrangeCommand(CommandId id, const CommandArgs& args) {
  bool derived = false;
  for (Guid s : selection_) derived |= s.isDerived();
  auto number = [&](const char* key, double fallback) {
    const json::Value* v = args.raw.isObject() ? args.raw.get(key) : nullptr;
    return v && v->isNumber() ? v->number : fallback;
  };
  switch (id) {
    case CommandId::CONVERT_TO_SECTION: return convertKind(true);
    case CommandId::CONVERT_TO_FRAME: return convertKind(false);
    case CommandId::DISTRIBUTE_LEFT:
    case CommandId::DISTRIBUTE_HORIZONTAL_CENTERS:
    case CommandId::DISTRIBUTE_RIGHT:
    case CommandId::DISTRIBUTE_TOP:
    case CommandId::DISTRIBUTE_VERTICAL_CENTERS:
    case CommandId::DISTRIBUTE_BOTTOM: return derived ? E_INVALID : distributeEdges(id);
    case CommandId::PACK_HORIZONTAL: return derived ? E_INVALID : pack(true);
    case CommandId::PACK_VERTICAL: return derived ? E_INVALID : pack(false);
    case CommandId::ROUND_TO_PIXEL: return roundToPixel();
    case CommandId::VECTOR_JOIN: {
      const json::Value* v = args.raw.isObject() ? args.raw.get("smooth") : nullptr;
      return vectorJoin(v && v->isBool() && v->boolean);
    }
    case CommandId::VECTOR_SPLIT: return vectorSplit();
    case CommandId::VECTOR_SIMPLIFY: return vectorSimplify(number("amount", 0.5));
    case CommandId::VECTOR_OFFSET: {
      StrokeJoin join = StrokeJoin::MITER;
      if (const json::Value* v = args.raw.isObject() ? args.raw.get("join") : nullptr; v && v->isString() && v->string == "ROUND") join = StrokeJoin::ROUND;
      return vectorOffset(number("amount", 0), join);
    }
    case CommandId::SET_DEFAULT_PROPERTIES: return setDefaultProperties();
    case CommandId::SET_SPELLING_MARKS: {
      if (text_.node == kNoGuid) return E_INVALID;
      spelling_.clear();
      if (const json::Value* list = args.raw.isObject() ? args.raw.get("ranges") : nullptr; list && list->isArray())
        for (const json::Value& r : list->array)
          if (r.isArray() && r.array.size() == 2 && r.array[0].isNumber() && r.array[1].isNumber() && r.array[1].number > r.array[0].number)
            spelling_.push_back({static_cast<uint32_t>(r.array[0].number), static_cast<uint32_t>(r.array[1].number)});
      spellingNode_ = text_.node;
      needsRender_ = true;
      return OK;
    }
    default: return E_UNSUPPORTED;
  }
}

uint32_t Editor::arrangeCommandState(CommandId id) const {
  bool derived = false;
  for (Guid s : selection_) derived |= s.isDerived();
  switch (id) {
    case CommandId::CONVERT_TO_SECTION: return convertibleToSection().empty() ? 0 : CMD_ENABLED;
    case CommandId::CONVERT_TO_FRAME: return convertibleToFrame().empty() ? 0 : CMD_ENABLED;
    case CommandId::DISTRIBUTE_LEFT:
    case CommandId::DISTRIBUTE_HORIZONTAL_CENTERS:
    case CommandId::DISTRIBUTE_RIGHT:
    case CommandId::DISTRIBUTE_TOP:
    case CommandId::DISTRIBUTE_VERTICAL_CENTERS:
    case CommandId::DISTRIBUTE_BOTTOM: return !derived && arrangeable().size() >= 3 ? CMD_ENABLED : 0;
    case CommandId::PACK_HORIZONTAL:
    case CommandId::PACK_VERTICAL: return !derived && arrangeable().size() >= 2 ? CMD_ENABLED : 0;
    case CommandId::ROUND_TO_PIXEL: {
      for (Guid s : selection_)
        if (!s.isDerived()) return CMD_ENABLED;
      return 0;
    }
    case CommandId::VECTOR_JOIN: return vectorJoinable() ? CMD_ENABLED : 0;
    case CommandId::VECTOR_SPLIT: {
      if (vector_.node != kNoGuid) return vector_.selVerts.empty() ? 0 : CMD_ENABLED;
      for (Guid id2 : vectorTargets()) {
        const Node* n = doc_.get(id2);
        if (n && n->props.type == NodeType::VECTOR) return CMD_ENABLED;
      }
      return 0;
    }
    case CommandId::VECTOR_SIMPLIFY:
    case CommandId::VECTOR_OFFSET: return vectorTargets().empty() ? 0 : CMD_ENABLED;
    case CommandId::SET_DEFAULT_PROPERTIES: return canSetDefaultProperties() ? CMD_ENABLED : 0;
    case CommandId::SET_SPELLING_MARKS: return text_.node != kNoGuid ? CMD_ENABLED : 0;
    default: return 0;
  }
}

}  // namespace eng
