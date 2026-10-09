// Round 8 — the canvas tools and views Figma has beyond round 7 (docs/engine-build.md "Round 8 — selection"):
// reordering a smart selection by its centre rings, the ⌥R rotation origin, the Scale tool (K), ruler guides (Figma's
// `guides` on pages and frames: dragged out of the rulers, moved, removed, snapped to), snapping to layout grids, an
// auto-layout bar's value edited in place, and the view following a paste.

#include <algorithm>
#include <cmath>
#include <unordered_set>

#include "editor/Editor.h"
#include "kiwi.h"

namespace eng {

namespace {

constexpr double kGuideReach = 4;   // CSS px either side of a ruler guide
constexpr double kOriginSnap = 6;   // CSS px: the origin snaps to the box's corners, edges' middles and centre
constexpr uint32_t kGuidesField = 138;  // NodeChange.guides (schema/document.kiwi)

using GuidSet = std::unordered_set<Guid, GuidHash>;

double lo(const Rect& r, int a) { return a == 0 ? r.x : r.y; }
double extent(const Rect& r, int a) { return a == 0 ? r.w : r.h; }

bool axisAligned(const Mat2x3& m) { return std::fabs(m.m01) < 1e-9 && std::fabs(m.m10) < 1e-9; }

// The edges of a layout grid's bands along its axis (its own space, 0..len).
void layoutGridEdges(const LayoutGrid& g, double len, std::vector<double>& out) {
  if (!g.visible) return;
  if (g.pattern == LayoutGridPattern::GRID) {
    double step = std::max(g.sectionSize, 1.0);
    for (double a = step; a < len && out.size() < 4096; a += step) out.push_back(a);
    return;
  }
  double gutter = g.gutterSize, size = g.sectionSize;
  int n = g.numSections;
  if (g.type == LayoutGridType::STRETCH) {
    if (n <= 0) n = 1;
    double w = (len - 2 * g.offset - gutter * (n - 1)) / n;
    for (int i = 0; i < n && i < 2048; i++) {
      out.push_back(g.offset + i * (w + gutter));
      out.push_back(g.offset + i * (w + gutter) + w);
    }
    return;
  }
  if (n <= 0) n = std::max(1, static_cast<int>(std::floor((len - 2 * g.offset + gutter) / std::max(size + gutter, 1e-9))));
  double total = n * size + (n - 1) * gutter;
  double start = g.type == LayoutGridType::MIN ? g.offset : g.type == LayoutGridType::MAX ? len - g.offset - total : (len - total) / 2;
  for (int i = 0; i < n && i < 2048; i++) {
    out.push_back(start + i * (size + gutter));
    out.push_back(start + i * (size + gutter) + size);
  }
}

// Figma's rotation as the Design panel shows it (counter-clockwise positive), in (−180, 180].
double panelRotation(const Mat2x3& world) {
  double deg = -std::atan2(world.m10, world.m00) * 180 / 3.14159265358979323846;
  deg = std::round(deg * 100) / 100;
  if (deg <= -180) deg += 360;
  return deg == 0 ? 0 : deg;
}

std::string formatAngle(double v) {
  char buf[32];
  std::snprintf(buf, sizeof buf, "%.2f", v);
  std::string s = buf;
  while (!s.empty() && s.back() == '0') s.pop_back();
  if (!s.empty() && s.back() == '.') s.pop_back();
  if (s == "-0") s = "0";
  return s + "°";
}

}  // namespace

std::string Editor::rotateBadgeText() const {
  if (targets_.empty()) return {};
  const Node* n = doc_.get(targets_[0].id);
  return n ? formatAngle(panelRotation(doc_.worldTransform(targets_[0].id))) : std::string();
}

NodeProps Editor::sliceProps() const {
  NodeProps p = defaultProps(NodeType::SLICE);
  p.strokeWeight = 0;
  // exportSettings (45): [{imageType PNG, constraint {CONTENT_SCALE, 1}}] — the Export section's default row.
  kiwi::ByteBuffer bb;
  bb.writeVarUint(45);
  bb.writeVarUint(1);
  bb.writeVarUint(1);  // suffix
  bb.writeString("");
  bb.writeVarUint(2);  // imageType PNG
  bb.writeVarUint(0);
  bb.writeVarUint(3);  // constraint (a struct: type, value)
  bb.writeVarUint(0);
  bb.writeVarFloat(1);
  bb.writeVarUint(0);
  p.extra["exportSettings"] = std::string(reinterpret_cast<const char*>(bb.data()), bb.size());
  return p;
}

// ---- Nudge amounts ------------------------------------------------------------------------------------------------

void Editor::setNudge(double small, double big) {
  // Preferences › Nudge amount…: positive amounts only (Figma's dialog refuses others).
  if (std::isfinite(small) && small > 0) nudgeSmall_ = small;
  if (std::isfinite(big) && big > 0) nudgeBig_ = big;
}

// ---- Smart selection: reorder by the centre rings ------------------------------------------------------------------

void Editor::startReorder(int index) {
  begin(TxnKind::GESTURE, "Reorder");
  smartSelection(reorderFrom_);
  targets_ = targetsOf(reorderFrom_.order);
  reorderIndex_ = index;
  reorderOrder_ = reorderFrom_.order;
}

void Editor::dragReorder(Vec2 /*world*/, uint32_t /*mods*/) { placeReorder(false); }

void Editor::placeReorder(bool final) {
  // The dragged layer follows the pointer; the others take the places in the order its centre makes (the same gaps,
  // from where the first one was); let go, it takes its own place (Figma: "drag the pink circle to swap positions").
  if (reorderIndex_ < 0 || targets_.size() != reorderFrom_.order.size()) return;
  const int axis = reorderFrom_.axis;
  const size_t dragged = static_cast<size_t>(reorderIndex_);
  Vec2 d = camera_.toWorld(lastScreen_) - downWorld_;
  auto boundsOf = [&](size_t i) { return transformedBounds(targets_[i].world, targets_[i].size.x, targets_[i].size.y); };
  Rect db = boundsOf(dragged);
  double centre = lo(db, axis) + extent(db, axis) / 2 + (axis == 0 ? d.x : d.y);
  std::vector<size_t> order;
  for (size_t i = 0; i < targets_.size(); i++)
    if (i != dragged) order.push_back(i);
  size_t at = order.size();
  for (size_t k = 0; k < order.size(); k++) {
    Rect ob = boundsOf(order[k]);
    if (centre < lo(ob, axis) + extent(ob, axis) / 2) {
      at = k;
      break;
    }
  }
  order.insert(order.begin() + static_cast<long>(at), dragged);
  reorderOrder_.clear();
  double pos = lo(boundsOf(0), axis);  // targets_ start sorted along the axis
  for (size_t i : order) {
    const Target& t = targets_[i];
    reorderOrder_.push_back(t.id);
    Rect b = boundsOf(i);
    Mat2x3 moved;
    if (i == dragged && !final) {
      moved = Mat2x3::translate(px(d.x), px(d.y)) * t.world;
    } else {
      double shift = pos - lo(b, axis);
      moved = Mat2x3::translate(axis == 0 ? shift : 0, axis == 1 ? shift : 0) * t.world;
    }
    pos += extent(b, axis) + reorderFrom_.spacing;
    NodeChange c = NodeChange::changed(t.id);
    c.mask = F_TRANSFORM;
    c.props.transform = doc_.worldTransform(t.parent).inverse() * moved;
    for (double* v : {&c.props.transform.m02, &c.props.transform.m12}) {
      double r = std::round(*v);
      if (std::fabs(*v - r) < 1e-9) *v = r == 0 ? 0 : r;
    }
    if (doc_.get(t.id) && doc_.get(t.id)->props.transform == c.props.transform) continue;
    write(c);
  }
  flushLayout();
  needsRender_ = true;
}

// ---- ⌥R: the rotation origin ----------------------------------------------------------------------------------

bool Editor::rotationOriginShown() const {
  return rotationOriginOn_ && !selection_.empty() && selectingTool() && !viewer_ && text_.node == kNoGuid && vector_.node == kNoGuid &&
         paint_.node == kNoGuid && !proto_.on;
}

Vec2 Editor::rotationOrigin() const {
  // Kept in the selection box's own space (it moves and turns with the selection), the box's centre until dragged.
  SelectionBox box = selectionBox(doc_, selection_);
  if (!box.valid) return {};
  if (rotationOriginSet_ && rotationOriginFor_ == selection_) return box.toWorld.apply({rotationOrigin_.x * box.size.x, rotationOrigin_.y * box.size.y});
  return box.toWorld.apply({box.size.x / 2, box.size.y / 2});
}

void Editor::dragRotationOrigin(Vec2 world, uint32_t mods) {
  SelectionBox box = selectionBox(doc_, selection_);
  if (!box.valid || !(box.size.x > 0) || !(box.size.y > 0)) return;
  Vec2 q = box.toWorld.inverse().apply(world);
  // Snaps to the box's corners, the middles of its edges and its centre (⌃: no snapping).
  if (!(mods & MOD_CTRL)) {
    Mat2x3 S = camera_.matrix() * box.toWorld;
    Vec2 s = S.apply(q);
    double best = kOriginSnap + 1e-9;
    for (double u : {0.0, 0.5, 1.0})
      for (double v : {0.0, 0.5, 1.0}) {
        Vec2 p{u * box.size.x, v * box.size.y};
        double dist = (S.apply(p) - s).length();
        if (dist < best) best = dist, q = p;
      }
  }
  rotationOrigin_ = {q.x / box.size.x, q.y / box.size.y};
  rotationOriginSet_ = true;
  rotationOriginFor_ = selection_;
  needsRender_ = true;
}

// ---- The Scale tool (K) -----------------------------------------------------------------------------------------

void Editor::startScale() {
  // The layers the handles scale and everything in them, as they are at the press (each drag frame scales from these).
  scaleFrom_.clear();
  auto collect = [&](auto&& self, Guid id) -> void {
    const Node* n = doc_.get(id);
    if (!n || id.isDerived()) return;
    scaleFrom_[id] = n->props;
    if (n->props.type == NodeType::INSTANCE) return;  // its layers are its main's (they follow its size)
    for (Guid c : doc_.children(id)) self(self, c);
  };
  for (const Target& t : targets_) collect(collect, t.id);
}

void Editor::applyScale(double s) {
  // Everything that has a size scales with the layer (Figma's Scale tool): the descendants' places and sizes, corner
  // radii, strokes and dashes, effects, text sizes and pixel line heights / letter spacing, auto layout's padding and
  // gaps, layout grids and size limits. The scaled layers' own boxes are dragResize's.
  if (!(s > 0) || !std::isfinite(s)) return;
  GuidSet roots;
  for (const Target& t : targets_) roots.insert(t.id);
  for (auto& [id, from] : scaleFrom_) {
    const Node* n = doc_.get(id);
    if (!n) continue;
    NodeChange c = NodeChange::changed(id);
    NodeProps& p = c.props;
    if (!roots.count(id)) {
      c.mask |= F_TRANSFORM | F_SIZE;
      p.transform = from.transform;
      p.transform.m02 *= s;
      p.transform.m12 *= s;
      p.size = {from.size.x * s, from.size.y * s};
    }
    if (from.cornerRadii[0] || from.cornerRadii[1] || from.cornerRadii[2] || from.cornerRadii[3]) {
      c.mask |= F_CORNER_RADII;
      for (size_t k = 0; k < 4; k++) p.cornerRadii[k] = from.cornerRadii[k] * s;
    }
    if (from.strokeWeight > 0) {
      c.mask |= F_STROKE_WEIGHT;
      p.strokeWeight = from.strokeWeight * s;
    }
    if (from.stroke().borderStrokeWeightsIndependent) {
      c.mask |= F_BORDER_WEIGHTS;
      p.stroke().borderStrokeWeightsIndependent = true;
      for (size_t k = 0; k < 4; k++) p.stroke().borderWeights[k] = from.stroke().borderWeights[k] * s;
    }
    if (!from.stroke().dashPattern.empty()) {
      c.mask |= F_DASH_PATTERN;
      p.stroke().dashPattern = from.stroke().dashPattern;
      for (double& v : p.stroke().dashPattern) v *= s;
    }
    if (!from.effects.empty()) {
      c.mask |= F_EFFECTS;
      p.effects = from.effects;
      for (Effect& e : p.effects) {
        e.radius *= s;
        e.spread *= s;
        e.offset = {e.offset.x * s, e.offset.y * s};
      }
    }
    if (from.type == NodeType::TEXT) {
      const auto& t = from.text();
      c.mask |= F_FONT_SIZE | F_PARAGRAPH_SPACING | F_PARAGRAPH_INDENT;
      p.text().fontSize = t.fontSize * s;
      p.text().paragraphSpacing = t.paragraphSpacing * s;
      p.text().paragraphIndent = t.paragraphIndent * s;
      if (t.lineHeight.units == NumberUnits::PIXELS) {
        c.mask |= F_LINE_HEIGHT;
        p.text().lineHeight = {t.lineHeight.value * s, NumberUnits::PIXELS};
      }
      if (t.letterSpacing.units == NumberUnits::PIXELS) {
        c.mask |= F_LETTER_SPACING;
        p.text().letterSpacing = {t.letterSpacing.value * s, NumberUnits::PIXELS};
      }
      // Per-range sizes too.
      bool runs = false;
      TextData data = t.textData;
      for (TextStyle& r : data.styleOverrideTable) {
        if (r.mask & R_FONT_SIZE) r.fontSize *= s, runs = true;
        if ((r.mask & R_LINE_HEIGHT) && r.lineHeight.units == NumberUnits::PIXELS) r.lineHeight.value *= s, runs = true;
        if ((r.mask & R_LETTER_SPACING) && r.letterSpacing.units == NumberUnits::PIXELS) r.letterSpacing.value *= s, runs = true;
      }
      if (runs) {
        c.mask |= F_TEXT_DATA;
        p.text().textData = std::move(data);
      }
    }
    if (from.isAutoLayout()) {
      const StackFacet& st = from.stack();
      c.mask |= F_STACK_SPACING | F_STACK_PADDING_LEFT | F_STACK_PADDING_TOP | F_STACK_PADDING_RIGHT | F_STACK_PADDING_BOTTOM;
      p.stack().stackSpacing = st.stackSpacing * s;
      p.stack().stackPaddingLeft = st.stackPaddingLeft * s;
      p.stack().stackPaddingTop = st.stackPaddingTop * s;
      p.stack().stackPaddingRight = st.stackPaddingRight * s;
      p.stack().stackPaddingBottom = st.stackPaddingBottom * s;
      if (st.stackCounterSpacing) {
        c.mask |= F_STACK_COUNTER_SPACING;
        p.stack().stackCounterSpacing = *st.stackCounterSpacing * s;
      }
    }
    if (from.rare().minSize.x > 0 || from.rare().minSize.y > 0) {
      c.mask |= F_MIN_SIZE;
      p.rare().minSize = {from.rare().minSize.x * s, from.rare().minSize.y * s};
    }
    if (from.rare().maxSize.x > 0 || from.rare().maxSize.y > 0) {
      c.mask |= F_MAX_SIZE;
      p.rare().maxSize = {from.rare().maxSize.x * s, from.rare().maxSize.y * s};
    }
    if (!from.rare().layoutGrids.empty()) {
      c.mask |= F_LAYOUT_GRIDS;
      p.rare().layoutGrids = from.rare().layoutGrids;
      for (LayoutGrid& g : p.rare().layoutGrids) {
        g.offset *= s;
        g.sectionSize *= s;
        g.gutterSize *= s;
      }
    }
    if (c.mask) write(c);
  }
}

// ---- Ruler guides ---------------------------------------------------------------------------------------------

std::vector<Editor::RulerGuide> Editor::guidesOf(Guid owner) const {
  std::vector<RulerGuide> out;
  const Node* n = doc_.get(owner);
  if (!n) return out;
  auto it = n->props.extra.find("guides");
  if (it == n->props.extra.end() || it->second.empty()) return out;
  kiwi::ByteBuffer bb(reinterpret_cast<const uint8_t*>(it->second.data()), it->second.size());
  uint32_t field = 0, count = 0;
  if (!bb.readVarUint(field) || field != kGuidesField || !bb.readVarUint(count)) return out;
  for (uint32_t i = 0; i < count && i < 100000; i++) {
    RulerGuide g;
    g.owner = owner;
    for (;;) {
      uint32_t f = 0;
      if (!bb.readVarUint(f)) return out;
      if (f == 0) break;
      if (f == 1) {
        uint32_t axis = 0;
        if (!bb.readVarUint(axis)) return out;
        g.axis = axis == 1 ? 1 : 0;
      } else if (f == 2) {
        float v = 0;
        if (!bb.readVarFloat(v)) return out;
        g.offset = std::isfinite(v) ? v : 0;
      } else if (f == 3) {
        if (!bb.readVarUint(g.id.sessionID) || !bb.readVarUint(g.id.localID)) return out;
      } else {
        return out;
      }
    }
    out.push_back(g);
  }
  return out;
}

void Editor::writeGuides(Guid owner, const std::vector<RulerGuide>& guides) {
  const Node* n = doc_.get(owner);
  if (!n) return;
  NodeChange c = NodeChange::changed(owner);
  c.mask = F_EXTRA;
  c.props.extra = n->props.extra;
  if (guides.empty()) {
    c.props.extra["guides"] = "";  // the field goes
  } else {
    kiwi::ByteBuffer bb;
    bb.writeVarUint(kGuidesField);
    bb.writeVarUint(static_cast<uint32_t>(guides.size()));
    for (const RulerGuide& g : guides) {
      bb.writeVarUint(1);
      bb.writeVarUint(static_cast<uint32_t>(g.axis));
      bb.writeVarUint(2);
      bb.writeVarFloat(static_cast<float>(g.offset));
      if (g.id != kNoGuid) {
        bb.writeVarUint(3);
        bb.writeVarUint(g.id.sessionID);
        bb.writeVarUint(g.id.localID);
      }
      bb.writeVarUint(0);
    }
    c.props.extra["guides"] = std::string(reinterpret_cast<const char*>(bb.data()), bb.size());
  }
  write(c);
}

namespace {

// The frames whose guides show: a page's top-level frames (those in sections too).
template <typename F>
void forEachGuideFrame(const Document& doc, Guid page, F&& f) {
  auto visit = [&](auto&& self, Guid parent) -> void {
    for (Guid c : doc.children(parent)) {
      const Node* n = doc.get(c);
      if (!n || !n->props.visible || c.isDerived()) continue;
      if (n->props.type == NodeType::SECTION) self(self, c);
      else if (n->props.isFrameLike() && n->props.extra.count("guides")) f(c, *n);
    }
  };
  visit(visit, page);
}

}  // namespace

bool Editor::guideAt(Vec2 s, RulerGuide& out) const {
  if (!rulersOn() || viewer_ || page_ == kNoGuid) return false;
  double best = kGuideReach + 1e-9;
  bool found = false;
  auto consider = [&](const RulerGuide& g, double dist) {
    if (dist < best) best = dist, out = g, found = true;
  };
  // Frame guides: across their frame only; over the page's own.
  forEachGuideFrame(doc_, page_, [&](Guid frame, const Node& n) {
    Mat2x3 S = camera_.matrix() * doc_.worldTransform(frame);
    Vec2 q = S.inverse().apply(s);
    if (q.x < 0 || q.y < 0 || q.x > n.props.size.x || q.y > n.props.size.y) return;
    for (const RulerGuide& g : guidesOf(frame)) {
      Vec2 a = S.apply(g.axis == 0 ? Vec2{g.offset, 0} : Vec2{0, g.offset});
      Vec2 b = S.apply(g.axis == 0 ? Vec2{g.offset, n.props.size.y} : Vec2{n.props.size.x, g.offset});
      Vec2 ab = b - a;
      double len = ab.length();
      if (len <= 0) continue;
      double dist = std::fabs((s.x - a.x) * ab.y - (s.y - a.y) * ab.x) / len;
      consider(g, dist);
    }
  });
  if (found) return true;
  for (const RulerGuide& g : guidesOf(page_)) {
    Vec2 at = camera_.toScreen(g.axis == 0 ? Vec2{g.offset, 0} : Vec2{0, g.offset});
    consider(g, g.axis == 0 ? std::fabs(s.x - at.x) : std::fabs(s.y - at.y));
  }
  return found;
}

Status Editor::startGuideDrag(int axis, Vec2 s, double rulerSize) {
  if (!rulersOn() || viewer_ || page_ == kNoGuid || gesture_ != Gesture::None || txn_.open) return E_INVALID;
  // On the one selected top-level frame (it takes the guide, in its own space; the rulers count from its corner),
  // else on the page (unverified: help.figma.com has canvas and frame guides, not which a drag makes).
  Guid owner = page_;
  if (selection_.size() == 1) {
    const Node* n = doc_.get(selection_[0]);
    const Node* p = n ? doc_.get(n->props.parentIndex.guid) : nullptr;
    if (n && !selection_[0].isDerived() && n->props.isFrameLike() && n->props.type != NodeType::SECTION && p &&
        (p->props.type == NodeType::CANVAS || p->props.type == NodeType::SECTION) && axisAligned(doc_.worldTransform(selection_[0])))
      owner = selection_[0];
  }
  guideDrag_ = {owner, axis == 1 ? 1 : 0, 0, newGuid()};
  guideFrom_ = {};
  guideNew_ = true;
  guideMoved_ = false;
  guideRuler_ = rulerSize > 0 ? rulerSize : 20;
  selectedGuide_ = {};
  downScreen_ = lastScreen_ = s;
  downWorld_ = camera_.toWorld(s);
  downMods_ = 0;
  gesture_ = Gesture::Guide;
  changeCursor(CursorKind::RESIZE, guideDrag_.axis == 0 ? 0 : 90);
  needsRender_ = true;
  return OK;
}

bool Editor::pressGuide(Vec2 s, uint32_t mods) {
  RulerGuide g;
  if (!guideAt(s, g)) return false;
  // A press selects the guide (the layers let go); a drag moves it — ⌥: a new guide from it (help.figma.com).
  selectedGuide_ = g;
  if (!selection_.empty()) changeSelection({});
  guideFrom_ = g;
  guideDrag_ = g;
  guideNew_ = false;
  if (mods & MOD_ALT) {
    guideDrag_.id = newGuid();
    guideNew_ = true;
  }
  guideMoved_ = false;
  guideRuler_ = 20;
  gesture_ = Gesture::Guide;
  needsRender_ = true;
  return true;
}

void Editor::dragGuide(Vec2 s, uint32_t /*mods*/) {
  if (!guideMoved_) {
    // An existing guide moves past the drag threshold (a click only selects it); a new one at once.
    if (guideFrom_.owner != kNoGuid && (s - downScreen_).length() < 3) return;
    begin(TxnKind::GESTURE, guideNew_ ? "Add guide" : "Move guide");
    guideMoved_ = true;
  }
  Vec2 world = camera_.toWorld(s);
  Vec2 local = guideDrag_.owner == page_ ? world : doc_.worldTransform(guideDrag_.owner).inverse().apply(world);
  guideDrag_.offset = px(guideDrag_.axis == 0 ? local.x : local.y);
  std::vector<RulerGuide> list = guidesOf(guideDrag_.owner);
  bool replaced = false;
  for (RulerGuide& g : list)
    if (g.id == guideDrag_.id && g.axis == guideDrag_.axis) {
      g.offset = guideDrag_.offset;
      replaced = true;
      break;
    }
  if (!replaced) list.push_back(guideDrag_);
  writeGuides(guideDrag_.owner, list);
  if (!guideNew_) selectedGuide_ = guideDrag_;
  needsRender_ = true;
}

void Editor::finishGuide(Vec2 s) {
  // Let go over its ruler (or off the canvas): the guide goes (help.figma.com "drag the guide back to the rulers").
  bool gone = guideDrag_.axis == 0 ? s.x < guideRuler_ || s.x > viewport_.width : s.y < guideRuler_ || s.y > viewport_.height;
  if (guideMoved_) {
    if (gone) {
      std::vector<RulerGuide> list = guidesOf(guideDrag_.owner);
      list.erase(std::remove_if(list.begin(), list.end(), [&](const RulerGuide& g) { return g.id == guideDrag_.id && g.axis == guideDrag_.axis; }),
                 list.end());
      writeGuides(guideDrag_.owner, list);
      selectedGuide_ = {};
    }
    commit();
  }
  guideMoved_ = false;
  guideNew_ = false;
  guideFrom_ = {};
  guideDrag_ = {};
  needsRender_ = true;
}

void Editor::guideOverlay(Overlay& o) const {
  if (!rulersOn() || page_ == kNoGuid) return;
  bool dragging = gesture_ == Gesture::Guide && guideMoved_;
  auto active = [&](const RulerGuide& g) {
    return (dragging && g.id == guideDrag_.id && g.owner == guideDrag_.owner && g.axis == guideDrag_.axis) ||
           (selectedGuide_.owner == g.owner && selectedGuide_.id == g.id && selectedGuide_.axis == g.axis);
  };
  Vec2 a = camera_.toWorld({0, 0}), b = camera_.toWorld({viewport_.width, viewport_.height});
  for (const RulerGuide& g : guidesOf(page_)) {
    Overlay::RulerGuide m;
    m.vertical = g.axis == 0;
    m.a = m.vertical ? Vec2{g.offset, a.y} : Vec2{a.x, g.offset};
    m.b = m.vertical ? Vec2{g.offset, b.y} : Vec2{b.x, g.offset};
    m.active = active(g);
    m.label = dragging && m.active;
    m.value = g.offset;
    o.rulerGuides.push_back(m);
  }
  forEachGuideFrame(doc_, page_, [&](Guid frame, const Node& n) {
    Mat2x3 W = doc_.worldTransform(frame);
    for (const RulerGuide& g : guidesOf(frame)) {
      Overlay::RulerGuide m;
      m.vertical = g.axis == 0;
      m.a = W.apply(m.vertical ? Vec2{g.offset, 0} : Vec2{0, g.offset});
      m.b = W.apply(m.vertical ? Vec2{g.offset, n.props.size.y} : Vec2{n.props.size.x, g.offset});
      m.active = active(g);
      m.label = dragging && m.active;
      m.value = g.offset;
      o.rulerGuides.push_back(m);
    }
  });
}

void Editor::snapLines(Guid parent, std::vector<double>& xs, std::vector<double>& ys) const {
  if (page_ == kNoGuid) return;
  // Guides: the page's, and those of the top-level frame the layers are in.
  if (rulersOn()) {
    for (const RulerGuide& g : guidesOf(page_)) (g.axis == 0 ? xs : ys).push_back(g.offset);
    Guid top = kNoGuid;
    for (Guid cur = parent; cur != kNoGuid && doc_.has(cur) && cur != page_; cur = doc_.parentOf(cur)) {
      const Node* n = doc_.get(cur);
      const Node* p = doc_.get(n->props.parentIndex.guid);
      if (n->props.isFrameLike() && n->props.type != NodeType::SECTION && p &&
          (p->props.type == NodeType::CANVAS || p->props.type == NodeType::SECTION))
        top = cur;
    }
    if (top != kNoGuid) {
      Mat2x3 W = doc_.worldTransform(top);
      if (axisAligned(W))
        for (const RulerGuide& g : guidesOf(top)) {
          Vec2 w = W.apply(g.axis == 0 ? Vec2{g.offset, 0} : Vec2{0, g.offset});
          (g.axis == 0 ? xs : ys).push_back(g.axis == 0 ? w.x : w.y);
        }
    }
  }
  // Layout grids: the frame the layers are in (its columns', rows' and grid cells' edges).
  if (viewOptions_ & VIEW_LAYOUT_GUIDES) {
    const Node* p = doc_.get(parent);
    if (p && p->props.isFrameLike() && !p->props.rare().layoutGrids.empty()) {
      Mat2x3 W = doc_.worldTransform(parent);
      if (axisAligned(W)) {
        for (const LayoutGrid& g : p->props.rare().layoutGrids) {
          for (int axis = 0; axis < 2; axis++) {
            bool along = g.pattern == LayoutGridPattern::GRID || (g.axis == Axis::X) == (axis == 0);
            if (!along) continue;
            std::vector<double> edges;
            layoutGridEdges(g, axis == 0 ? p->props.size.x : p->props.size.y, edges);
            for (double e : edges) {
              Vec2 w = W.apply(axis == 0 ? Vec2{e, 0} : Vec2{0, e});
              (axis == 0 ? xs : ys).push_back(axis == 0 ? w.x : w.y);
            }
          }
        }
      }
    }
  }
}

// ---- Auto layout: a bar's value edited in place ---------------------------------------------------------------

void Editor::requestInlineEdit(int bar) {
  if (selection_.size() != 1 || layoutBarsFrame_ != selection_[0]) return;
  for (const Overlay::LayoutBar& b : layoutBars_) {
    int band = b.gap ? 4 + b.index : b.side;
    if (band != bar) continue;
    InlineEdit e;
    e.node = selection_[0];
    static const char* kSides[4] = {"PADDING_LEFT", "PADDING_TOP", "PADDING_RIGHT", "PADDING_BOTTOM"};
    e.field = b.gap ? "GAP" : kSides[b.side];
    e.value = b.value;
    // Over the value's pill, as the overlay draws it (render/Overlay.cpp's auto-layout bars).
    const OverlayStyle style = OverlayStyle::of(theme_);
    Vec2 c = camera_.toScreen(b.at), edge = camera_.toScreen(b.edge);
    double w = std::max(40.0, labelWidth("0000", false) + 2 * style.badgePadding), h = std::max(style.badgeHeight, 20.0), len = 12;
    double x, y;
    if (b.gap) {
      x = b.vertical ? c.x + 9 : c.x + len / 2 + 5;
      y = b.vertical ? c.y - len / 2 - 5 - h : c.y - h - 5;
    } else if (b.side == 0) {
      x = edge.x - 2 - w, y = edge.y - h / 2;
    } else if (b.side == 2) {
      x = edge.x + 2, y = edge.y - h / 2;
    } else if (b.side == 1) {
      x = edge.x - w / 2, y = edge.y - 2 - h;
    } else {
      x = edge.x - w / 2, y = edge.y + 2;
    }
    e.rect = {x, y, w, h};
    events_.inlineEdits.push_back(e);
    return;
  }
}

// ---- Paste: the view follows ------------------------------------------------------------------------------------

void Editor::revealPasted(const Rect& r) {
  // help.figma.com (Copy and paste objects): larger than the view, the zoom changes so all of it shows; just out of
  // view, the view moves a little to show it.
  if (!(r.w > 0) || !(r.h > 0) || viewport_.width <= 0 || viewport_.height <= 0) return;
  Vec2 a = camera_.toWorld({0, 0}), b = camera_.toWorld({viewport_.width, viewport_.height});
  Rect view = Rect::fromPoints(a, b);
  if (view.containsRect(r)) return;
  zooming_ = false;
  if (r.w > view.w || r.h > view.h) {
    changeCamera(snapped(Camera::fit(r, viewport_.width, viewport_.height, false)));
    return;
  }
  double dx = 0, dy = 0;
  const double margin = 40 / camera_.zoom;
  if (r.x < view.x) dx = r.x - view.x - margin;
  else if (r.right() > view.right()) dx = r.right() - view.right() + margin;
  if (r.y < view.y) dy = r.y - view.y - margin;
  else if (r.bottom() > view.bottom()) dy = r.bottom() - view.bottom() + margin;
  changeCamera(snapped(camera_.panned(-dx * camera_.zoom, -dy * camera_.zoom)));
}

}  // namespace eng
