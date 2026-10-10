// The Shape builder (round 12; live toolbar/vector-edit-more-menu.txt: "Vector editing tools" › "Shape builder" M).
// What it does is help.figma.com's "Create custom shapes with the shape builder tool" (live has no capture beyond
// the menu row): select one or more vector layers, Enter (vector edit mode), the Shape builder; hovering shows the
// individual regions of the selected layers (the planar faces of their outlines, geometry/PlanarFaces.h); a click
// extracts a region to its own layer, a drag across regions merges them into one layer, ⌥-click removes a region from
// the canvas. "Unlike boolean operations", it is destructive: the layers the regions come from are changed for good
// (one undo step restores them).
//
// Unverified (ours): the hover / drag look (the region filled in the selection blue, outlined), the cursor, that the
// new layer takes the look and name of the topmost layer the regions came from and sits just above it, that what is
// left of each source layer stays in it (a layer left with nothing is deleted), that a drag with ⌥ removes every region
// it crosses, the undo label "Shape builder".

#include <algorithm>
#include <cmath>
#include <cstring>
#include <set>

#include "editor/Editor.h"
#include "hit/HitTest.h"

namespace eng {

namespace {

uint64_t mix(uint64_t h, uint64_t v) {
  h ^= v + 0x9e3779b97f4a7c15ull + (h << 6) + (h >> 2);
  return h;
}
uint64_t bits(double d) {
  uint64_t u = 0;
  std::memcpy(&u, &d, sizeof u);
  return u;
}

}  // namespace

void Editor::builderUpdate() {
  if (vector_.node == kNoGuid) return;
  std::vector<Guid> layers = vectorLayers();
  // Curves flattened to a quarter of a screen pixel (a power of two of world units, so a zoom within it keeps them).
  double tol = std::ldexp(1.0, static_cast<int>(std::floor(std::log2(std::clamp(0.25 / std::max(camera_.zoom, 1e-6), 1e-3, 4.0)))));
  uint64_t key = bits(tol);
  for (Guid g : layers) {
    const NodeGeometry* geo = doc_.geometry(g);
    key = mix(key, (static_cast<uint64_t>(g.sessionID) << 32) | g.localID);
    key = mix(key, geo ? geo->fillKey : 0);
    Mat2x3 W = doc_.worldTransform(g);
    for (double d : {W.m00, W.m01, W.m02, W.m10, W.m11, W.m12}) key = mix(key, bits(d));
  }
  if (key == vector_.builderKey && vector_.builderKey != 0) return;
  std::vector<geom::FaceInput> inputs;
  std::vector<Guid> used;
  for (Guid g : layers) {
    const NodeGeometry* geo = doc_.geometry(g);
    if (!geo || geo->fills.empty()) continue;
    geom::FaceInput in;
    Mat2x3 W = doc_.worldTransform(g);
    for (const auto& f : geo->fills) {
      in.path.append(f.path.transformed(W));
      if (f.windingRule == WindingRule::ODD) in.rule = WindingRule::ODD;
    }
    if (in.path.empty()) continue;
    inputs.push_back(std::move(in));
    used.push_back(g);
  }
  vector_.builderMap = geom::planarMap(inputs, tol);
  vector_.builderLayers = std::move(used);
  vector_.builderKey = key == 0 ? 1 : key;
  vector_.builderHover = -1;
  vector_.builderTaken.clear();
}

const std::vector<geom::PlanarFace>& Editor::shapeBuilderFaces() {
  builderUpdate();
  return vector_.builderMap.faces;
}

int Editor::builderFaceAt(Vec2 world) {
  for (size_t i = 0; i < vector_.builderMap.faces.size(); i++)
    if (vector_.builderMap.faces[i].contains(world)) return static_cast<int>(i);
  return -1;
}

uint32_t Editor::builderPointerDown(Vec2 s, uint32_t mods) {
  builderUpdate();
  Vec2 world = camera_.toWorld(s);
  int f = builderFaceAt(world);
  if (f < 0) {
    // Off the regions: a click on a layer that isn't held leaves the mode (as the other tools do).
    auto path = hitPath(doc_, page_, world, pixel());
    if (!path.empty() && std::find(vector_.group.begin(), vector_.group.end(), path.back()) == vector_.group.end() &&
        !doc_.isAncestor(path.back(), vector_.node)) {
      endVectorEdit();
      return 0;
    }
  }
  vector_.drag = VectorSession::Drag::Builder;
  vector_.builderTaken.clear();
  if (f >= 0) vector_.builderTaken.push_back(f);
  vector_.builderRemove = (mods & MOD_ALT) != 0;
  vector_.builderLast = world;
  vector_.builderHover = f;
  gesture_ = Gesture::Vector;
  needsRender_ = true;
  return P_HANDLED | P_CAPTURE;
}

void Editor::builderPointerMove(Vec2 s, uint32_t mods) {
  (void)mods;
  Vec2 world = camera_.toWorld(s);
  vector_.pointer = world;
  vector_.pointerKnown = true;
  if (gesture_ != Gesture::Vector || vector_.drag != VectorSession::Drag::Builder) {
    builderUpdate();
    int f = builderFaceAt(world);
    if (f != vector_.builderHover) {
      vector_.builderHover = f;
      needsRender_ = true;
    }
    changeCursor(CursorKind::CROSSHAIR);
    return;
  }
  // Every region the pointer crossed since the last move (sampled every 2 screen px).
  Vec2 a = vector_.builderLast;
  double len = (world - a).length() * camera_.zoom;
  int steps = std::clamp(static_cast<int>(std::ceil(len / 2)), 1, 512);
  for (int k = 1; k <= steps; k++) {
    int f = builderFaceAt(a + (world - a) * (static_cast<double>(k) / steps));
    if (f >= 0 && std::find(vector_.builderTaken.begin(), vector_.builderTaken.end(), f) == vector_.builderTaken.end()) {
      vector_.builderTaken.push_back(f);
      needsRender_ = true;
    }
  }
  vector_.builderLast = world;
  vector_.builderHover = builderFaceAt(world);
  vector_.dragged = vector_.dragged || (s - downScreen_).length() >= 3;
  needsRender_ = true;
}

void Editor::builderPointerUp() {
  std::vector<int> taken = std::move(vector_.builderTaken);
  vector_.builderTaken.clear();
  bool remove = vector_.builderRemove;
  vector_.builderRemove = false;
  if (!taken.empty()) builderApply(taken, remove);
}

Status Editor::builderApply(const std::vector<int>& taken, bool remove) {
  if (vector_.node == kNoGuid) return E_INVALID;
  const geom::PlanarMap& map = vector_.builderMap;
  std::vector<int> picked;
  std::set<uint32_t> covered;
  for (int f : taken) {
    if (f < 0 || static_cast<size_t>(f) >= map.faces.size()) continue;
    picked.push_back(f);
    covered.insert(map.faces[static_cast<size_t>(f)].covers.begin(), map.faces[static_cast<size_t>(f)].covers.end());
  }
  if (picked.empty()) return E_INVALID;
  // The regions as one path, drawn from the arrangement itself: what is left of each layer below is drawn from the
  // same edges, so the two share their boundary exactly.
  geom::Path region = map.unionOf(picked);
  if (region.empty()) return E_INVALID;
  std::vector<std::pair<Guid, uint32_t>> sources;
  for (uint32_t i : covered)
    if (i < vector_.builderLayers.size() && doc_.has(vector_.builderLayers[i])) sources.push_back({vector_.builderLayers[i], i});
  if (sources.empty()) return E_INVALID;
  std::stable_sort(sources.begin(), sources.end(), [&](const auto& a, const auto& b) { return doc_.paintsBefore(a.first, b.first); });
  Guid top = sources.back().first;

  begin(TxnKind::USER, "Shape builder");
  Guid created = kNoGuid;
  if (!remove) {
    // The regions as one new layer, just above the topmost layer they came from, with its look.
    const NodeProps tp = doc_.get(top)->props;
    NodeProps v = defaultProps(NodeType::VECTOR);
    v.name = tp.name;
    v.fillPaints = tp.fillPaints;
    v.strokePaints = tp.strokePaints;
    v.strokeWeight = tp.strokeWeight;
    v.strokeAlign = tp.strokeAlign;
    v.strokeJoin = tp.strokeJoin;
    v.strokeCap = tp.strokeCap;
    v.miterLimit = tp.miterLimit;
    v.effects = tp.effects;
    v.opacity = tp.opacity;
    v.blendMode = tp.blendMode;
    v.transform = tp.transform;
    v.size = tp.size;
    Guid parent = doc_.parentOf(top);
    const auto& siblings = doc_.children(parent);
    size_t index = static_cast<size_t>(std::find(siblings.begin(), siblings.end(), top) - siblings.begin()) + 1;
    v.parentIndex = {parent, placeAt(parent, index, kNoGuid)};
    created = newGuid();
    write(NodeChange::created(created, v));
    Mat2x3 toLocal = doc_.worldTransform(created).inverse();
    writeVector(created, geom::networkFromPath(region.transformed(toLocal), WindingRule::NONZERO), doc_.get(created)->props.transform);
  }
  // What is left of each source layer stays in it (destructive): its other regions; a layer left with none goes.
  for (const auto& [L, input] : sources) {
    std::vector<int> kept;
    for (size_t f = 0; f < map.faces.size(); f++) {
      const auto& cv = map.faces[f].covers;
      if (std::find(cv.begin(), cv.end(), input) != cv.end() && std::find(picked.begin(), picked.end(), static_cast<int>(f)) == picked.end())
        kept.push_back(static_cast<int>(f));
    }
    geom::Path rest = map.unionOf(kept);
    if (rest.empty()) {
      write(NodeChange::removed(L));
      continue;
    }
    Mat2x3 W = doc_.worldTransform(L);
    const NodeProps& p = doc_.get(L)->props;
    if (p.type != NodeType::VECTOR) {
      // A shape becomes a VECTOR (same GUID), its outline now the network.
      NodeChange c = NodeChange::changed(L);
      c.mask = F_TYPE | F_CORNER_RADII | F_CORNER_SMOOTHING | F_INVERTED_CORNERS | F_ARC_DATA;
      c.props.type = NodeType::VECTOR;
      c.props.cornerRadii = {0, 0, 0, 0};
      c.props.stroke().cornerSmoothing = 0;
      c.props.shape().arcData = {};
      write(c);
      if (L == vector_.node) vector_.pendingType = false;
    }
    writeVector(L, geom::networkFromPath(rest.transformed(W.inverse()), WindingRule::NONZERO), doc_.get(L)->props.transform);
  }
  if (created != kNoGuid) vector_.group.push_back(created);
  // The edited layer gone: the next held one (the new layer first) shows its points.
  if (!doc_.has(vector_.node)) {
    Guid next = created;
    if (next == kNoGuid)
      for (Guid g : vector_.group)
        if (doc_.has(g)) {
          next = g;
          break;
        }
    if (next == kNoGuid) {
      commit();
      endVectorEdit();
      return OK;
    }
    vector_.node = next;
    vector_.selVerts.clear();
    vector_.selSegs.clear();
  }
  changeSelection({vector_.node});
  commit();
  vector_.builderKey = 0;
  vector_.builderHover = -1;
  reloadVector();
  return OK;
}

void Editor::builderOverlay(Overlay& o) const {
  // The region under the pointer, and the ones a drag took, filled in the selection colour and outlined.
  auto add = [&](int f, double alpha) {
    if (f < 0 || static_cast<size_t>(f) >= vector_.builderMap.faces.size()) return;
    Overlay::Region r;
    r.path = vector_.builderMap.faces[static_cast<size_t>(f)].path;
    r.alpha = alpha;
    o.regions.push_back(std::move(r));
  };
  bool dragging = gesture_ == Gesture::Vector && vector_.drag == VectorSession::Drag::Builder;
  for (int f : vector_.builderTaken) add(f, 0.3);
  if (!dragging || std::find(vector_.builderTaken.begin(), vector_.builderTaken.end(), vector_.builderHover) == vector_.builderTaken.end())
    add(vector_.builderHover, 0.15);
  // Every held layer outlined (the edited one too: its points don't show with this tool).
  if (std::find(o.hover.begin(), o.hover.end(), vector_.node) == o.hover.end()) o.hover.push_back(vector_.node);
}

}  // namespace eng
