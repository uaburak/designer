// E4 / E5 commands (docs/engine.md §10.6): boolean groups (Union, Subtract,
// Intersect, Exclude), Flatten, Outline stroke, Use as mask, Place image. Each
// is one undo step with Figma's label.

#include <algorithm>
#include <cmath>
#include <unordered_set>

#include "base/FractionalIndex.h"
#include "editor/Editor.h"
#include "geometry/Boolean.h"
#include "geometry/Stroker.h"
#include "geometry/VariableWidth.h"

namespace eng {

namespace {

using GuidSet = std::unordered_set<Guid, GuidHash>;

const char* booleanName(BooleanOperation op) {
  switch (op) {
    case BooleanOperation::UNION: return "Union";
    case BooleanOperation::SUBTRACT: return "Subtract";
    case BooleanOperation::INTERSECT: return "Intersect";
    case BooleanOperation::XOR: return "Exclude";
  }
  return "Union";
}

bool anyVisible(const std::vector<Paint>& paints) {
  for (auto& p : paints)
    if (p.visible) return true;
  return false;
}

}  // namespace

// A frame flattens with its layers (live Figma: an instance's More actions › Flatten, which detaches it first): its own
// filled box, then what it holds. A main component too (round 12, live context-component Flatten enabled): it is
// replaced by the vector (help.figma.com has nothing on it; what happens to its instances is unverified — here the
// component is deleted the way Delete deletes it, so they keep it as a deleted main and Restore component works).
static bool flatFrame(const NodeProps& p) {
  return (p.type == NodeType::FRAME && !p.isGroupLike() && !p.isComponentish()) || p.type == NodeType::SYMBOL;
}

static bool anyVisibleFill(const std::vector<Paint>& paints) {
  for (const Paint& p : paints)
    if (p.visible && p.opacity > 0) return true;
  return false;
}

// An instance flattens too (live: its menu's Flatten is enabled): it is detached first, then flattened as the frame it is.
bool Editor::flattenable(const NodeProps& p) const {
  return p.isPathShape() || p.isRectLike() || p.type == NodeType::ELLIPSE || p.type == NodeType::TEXT || p.isGroupLike() || flatFrame(p) ||
         p.type == NodeType::INSTANCE;  // (flatFrame: a main component too)
}

void Editor::fillPathsOf(Guid id, const Mat2x3& toSpace, geom::Path& out, WindingRule& rule) const {
  const Node* n = doc_.get(id);
  if (!n || !n->props.visible) return;
  if (flatFrame(n->props)) {
    if (const NodeGeometry* g = doc_.geometry(id); g && anyVisibleFill(n->props.fillPaints))
      for (auto& f : g->fills) out.append(f.path.transformed(toSpace));
    for (Guid c : doc_.children(id)) {
      const Node* cn = doc_.get(c);
      if (cn) fillPathsOf(c, toSpace * cn->props.transform, out, rule);
    }
    return;
  }
  if (n->props.isGroupLike()) {
    for (Guid c : doc_.children(id)) {
      const Node* cn = doc_.get(c);
      if (cn) fillPathsOf(c, toSpace * cn->props.transform, out, rule);
    }
    return;
  }
  const NodeGeometry* g = doc_.geometry(id);
  if (!g) return;
  for (auto& f : g->fills) {
    out.append(f.path.transformed(toSpace));
    if (f.windingRule == WindingRule::ODD) rule = WindingRule::ODD;
  }
}

Status Editor::booleanSelection(BooleanOperation op) {
  std::vector<Guid> top = topSelectionInPaintOrder();
  if (top.empty()) return E_INVALID;
  bool allBooleans = true;
  for (Guid t : top) allBooleans &= doc_.get(t)->props.isBoolean();
  std::string label = std::string(booleanName(op)) + " selection";
  if (allBooleans) {
    // Boolean groups selected: they change their operation.
    begin(TxnKind::USER, label);
    for (Guid t : top) {
      NodeChange c = NodeChange::changed(t);
      c.mask = F_BOOLEAN_OPERATION | F_NAME;
      c.props.shape().booleanOperation = op;
      c.props.name = booleanName(op);
      write(c);
    }
    commit();
    return OK;
  }
  // One layer makes a boolean group around it (live Figma).
  for (Guid t : top)
    if (t.isDerived()) return E_INVALID;
  // Wrapped like a group, at the topmost layer's place; the style comes from the topmost layer
  // (the bottom one for Subtract: what is cut from keeps its look).
  Guid topmost = top.back();
  Guid styleFrom = op == BooleanOperation::SUBTRACT ? top.front() : topmost;
  Guid parent = doc_.parentOf(topmost);
  GuidSet moving(top.begin(), top.end());
  size_t index = 0;
  for (Guid c : doc_.children(parent)) {
    if (c == topmost) break;
    if (!moving.count(c)) index++;
  }
  Mat2x3 toParent = doc_.worldTransform(parent).inverse();
  Rect u;
  bool any = false;
  for (Guid id : top) {
    const Node* n = doc_.get(id);
    Rect b = transformedBounds(toParent * doc_.worldTransform(id), n->props.size.x, n->props.size.y);
    u = any ? u.united(b) : b;
    any = true;
  }
  begin(TxnKind::USER, label);
  const NodeProps& sp = doc_.get(styleFrom)->props;
  NodeProps p = defaultProps(NodeType::BOOLEAN_OPERATION);
  p.name = booleanName(op);
  p.shape().booleanOperation = op;
  p.fillPaints = sp.fillPaints;
  p.strokePaints = sp.strokePaints;
  p.strokeWeight = sp.strokeWeight;
  p.strokeAlign = sp.strokeAlign;
  p.strokeJoin = sp.strokeJoin;
  p.transform = Mat2x3::translate(u.x, u.y);
  p.size = {u.w, u.h};
  p.parentIndex = {parent, placeManyAt(parent, index, 1, moving)[0]};
  Guid wrapper = newGuid();
  write(NodeChange::created(wrapper, p));
  auto keys = fractional::keysBetween("", std::nullopt, static_cast<int>(top.size()));
  for (size_t i = 0; i < top.size(); i++) reparent(top[i], wrapper, keys[i]);
  changeSelection({wrapper});
  commit();
  return OK;
}

Status Editor::flattenSelection() {
  std::vector<Guid> top = topSelectionInPaintOrder();
  std::vector<Guid> targets;
  for (Guid t : top) {
    const Node* n = doc_.get(t);
    // (an instance inside another is detached with its outer one: not taken alone)
    if (n && !n->props.locked && flattenable(n->props) && !(n->props.type == NodeType::INSTANCE && t.isDerived())) targets.push_back(t);
  }
  if (targets.empty()) return E_INVALID;
  if (vector_.node != kNoGuid) endVectorEdit();
  begin(TxnKind::USER, "Flatten selection");
  // Instances are detached first (one undo step with the flatten): what is flattened is the frame they become.
  for (Guid t : targets) {
    const Node* n = doc_.get(t);
    if (n && n->props.type == NodeType::INSTANCE) detachOne(t);
  }
  // Into the topmost one: its own space holds everyone's outlines.
  Guid into = targets.back();
  Mat2x3 toInto = doc_.worldTransform(into).inverse();
  geom::Path all;
  WindingRule rule = WindingRule::NONZERO;
  for (Guid t : targets) fillPathsOf(t, toInto * doc_.worldTransform(t), all, rule);
  geom::VectorNetwork net = geom::networkFromPath(all, rule);
  // A main component (round 12): a new vector takes its place, look and name; the component itself is deleted as
  // Delete deletes it (kept for its instances, soft-deleted, when it has any).
  auto removeTree = [&](Guid id) {
    std::function<void(Guid)> rec = [&](Guid n) {
      std::vector<Guid> kids = doc_.children(n);
      for (Guid k : kids) rec(k);
      write(NodeChange::removed(n));
    };
    rec(id);
  };
  auto dropComponent = [&](Guid id) {
    if (!softDeleteMain(id)) removeTree(id);
  };
  if (doc_.get(into)->props.type == NodeType::SYMBOL) {
    const NodeProps cp = doc_.get(into)->props;
    NodeProps v = defaultProps(NodeType::VECTOR);
    v.name = cp.name;
    v.visible = cp.visible;
    v.opacity = cp.opacity;
    v.blendMode = cp.blendMode;
    v.effects = cp.effects;
    v.transform = cp.transform;
    v.size = cp.size;
    v.strokeWeight = cp.strokeWeight;
    v.strokeAlign = cp.strokeAlign;
    v.strokeJoin = cp.strokeJoin;
    if (anyVisibleFill(cp.fillPaints)) {
      v.fillPaints = cp.fillPaints;
      v.strokePaints = cp.strokePaints;
    } else {
      // Without a fill of its own it takes its topmost layer's look (as a frame does).
      Guid styleFrom = doc_.children(into).empty() ? into : doc_.children(into).back();
      v.fillPaints = doc_.get(styleFrom)->props.fillPaints;
      v.strokePaints = doc_.get(styleFrom)->props.strokePaints;
    }
    Guid parent = doc_.parentOf(into);
    const auto& siblings = doc_.children(parent);
    size_t index = static_cast<size_t>(std::find(siblings.begin(), siblings.end(), into) - siblings.begin()) + 1;
    v.parentIndex = {parent, placeAt(parent, index, kNoGuid)};
    Guid made = newGuid();
    write(NodeChange::created(made, v));
    dropComponent(into);
    into = made;
  }
  const Node* keep = doc_.get(into);
  NodeProps kp = keep->props;
  // The kept layer becomes a VECTOR (same GUID); its children (a boolean's operands, a group's layers) go.
  NodeChange c = NodeChange::changed(into);
  c.mask = F_TYPE | F_CORNER_RADII | F_CORNER_SMOOTHING | F_INVERTED_CORNERS | F_ARC_DATA | F_RESIZE_TO_FIT | F_FRAME_MASK_DISABLED;
  c.props.type = NodeType::VECTOR;
  if (flatFrame(kp)) {
    // A frame drops its layout; it keeps its own look when it has a fill, else takes its topmost layer's.
    c.mask |= F_STACK_MODE;
    c.props.stack().stackMode = StackMode::NONE;
  }
  if (kp.isGroupLike() || kp.type == NodeType::TEXT || (flatFrame(kp) && !anyVisibleFill(kp.fillPaints))) {
    // A group or a text takes the look of what it held.
    c.mask |= F_FILLS | F_STROKES;
    Guid styleFrom = (kp.isGroupLike() || flatFrame(kp)) && !doc_.children(into).empty() ? doc_.children(into).back() : into;
    c.props.fillPaints = doc_.get(styleFrom)->props.fillPaints;
    c.props.strokePaints = doc_.get(styleFrom)->props.strokePaints;
  }
  write(c);
  for (Guid k : std::vector<Guid>(doc_.children(into))) removeTree(k);
  for (Guid t : targets) {
    if (t == into || !doc_.has(t) || doc_.get(t)->props.comp().isSoftDeleted) continue;
    if (doc_.get(t)->props.type == NodeType::SYMBOL) dropComponent(t);
    else removeTree(t);
  }
  writeVector(into, net, doc_.get(into)->props.transform);
  changeSelection({into});
  commit();
  return OK;
}

Status Editor::outlineStroke() {
  std::vector<Guid> targets;
  for (Guid t : topSelectionInPaintOrder()) {
    const Node* n = doc_.get(t);
    if (n && !n->props.locked && n->props.strokeWeight > 0 && anyVisible(n->props.strokePaints) && !n->props.isGroupLike()) targets.push_back(t);
  }
  if (targets.empty()) return E_INVALID;
  if (vector_.node != kNoGuid) endVectorEdit();
  begin(TxnKind::USER, "Outline stroke");
  std::vector<Guid> result;
  for (Guid t : targets) {
    const NodeProps p = doc_.get(t)->props;
    const NodeGeometry* g = doc_.geometry(t);
    if (!g || g->stroke.path.empty()) continue;
    bool closedArea = !g->fills.empty() && !g->hasOpenEnds;
    bool aligned = closedArea && p.strokeAlign != StrokeAlign::CENTER;
    geom::StrokeStyle style;
    style.width = p.strokeWeight * (aligned ? 2 : 1);
    style.join = p.strokeJoin;
    style.miterLimit = p.miterLimit;
    style.cap = p.strokeCap;
    style.dashes = p.stroke().dashPattern;
    style.fitDashes = p.isRectLike() || p.isFrameLike();
    style.caps = g->stroke.caps.empty() ? nullptr : &g->stroke.caps;
    // A variable width (round 12): the outline follows it.
    std::vector<geom::WidthPoint> profile = widthProfileAllowed(p) ? widthPointsOf(p) : std::vector<geom::WidthPoint>{};
    if (!profile.empty()) style.profile = &profile;
    const double tol = 0.02;
    geom::Path outline = geom::strokePath(g->stroke.path, style, tol);
    geom::Path shape;
    if (aligned) {
      geom::Path fill;
      for (auto& f : g->fills) fill.append(f.path);
      std::vector<geom::Operand> ops{{outline, WindingRule::NONZERO}, {fill, WindingRule::NONZERO}};
      shape = geom::booleanOp(ops, p.strokeAlign == StrokeAlign::INSIDE ? BooleanOperation::INTERSECT : BooleanOperation::SUBTRACT, tol);
    } else {
      shape = geom::simplify(outline, WindingRule::NONZERO, tol);
    }
    geom::VectorNetwork net = geom::networkFromPath(shape, WindingRule::NONZERO);
    bool keepFill = anyVisible(p.fillPaints) && closedArea;
    Guid id = t;
    if (keepFill) {
      // The fill stays as it was; the stroke becomes a vector of its own just above it.
      NodeChange noStroke = NodeChange::changed(t);
      noStroke.mask = F_STROKES;
      write(noStroke);
      NodeProps v = defaultProps(NodeType::VECTOR);
      v.name = p.name;
      v.strokePaints.clear();
      v.fillPaints = p.strokePaints;
      v.transform = p.transform;
      v.size = p.size;
      Guid parent = doc_.parentOf(t);
      const auto& siblings = doc_.children(parent);
      size_t index = static_cast<size_t>(std::find(siblings.begin(), siblings.end(), t) - siblings.begin()) + 1;
      v.parentIndex = {parent, placeAt(parent, index, kNoGuid)};
      id = newGuid();
      write(NodeChange::created(id, v));
    } else {
      NodeChange c = NodeChange::changed(t);
      c.mask = F_TYPE | F_FILLS | F_STROKES | F_CORNER_RADII | F_CORNER_SMOOTHING | F_INVERTED_CORNERS | F_ARC_DATA | F_DASH_PATTERN;
      c.props.type = NodeType::VECTOR;
      c.props.fillPaints = p.strokePaints;
      c.props.strokePaints.clear();
      if (hasWidthPoints(p)) {
        c.mask |= F_EXTRA;
        c.props.extra["variableWidthPoints"] = "";  // the stroke it shaped is gone
      }
      write(c);
    }
    writeVector(id, net, doc_.get(id)->props.transform);
    result.push_back(id);
  }
  changeSelection(result);
  commit();
  return OK;
}

bool Editor::selectionIsMask() const {
  if (selection_.empty()) return false;
  for (Guid id : selection_) {
    const Node* n = doc_.get(id);
    if (!n || !n->props.mask) return false;
  }
  return true;
}

Status Editor::useAsMask() {
  std::vector<Guid> top = topSelectionInPaintOrder();
  if (top.empty()) return E_INVALID;
  if (selectionIsMask()) {
    begin(TxnKind::USER, "Remove mask");
    for (Guid id : selection_) {
      NodeChange c = NodeChange::changed(id);
      c.mask = F_MASK;
      c.props.mask = false;
      write(c);
    }
    commit();
    return OK;
  }
  if (top.size() == 1) {
    begin(TxnKind::USER, "Use as mask");
    NodeChange c = NodeChange::changed(top[0]);
    c.mask = F_MASK;
    c.props.mask = true;
    write(c);
    commit();
    return OK;
  }
  // Several: grouped, the bottom one masking the others (Figma).
  begin(TxnKind::USER, "Use as mask");
  Guid group = wrapSelection("Group");
  if (group != kNoGuid) {
    const auto& kids = doc_.children(group);
    if (!kids.empty()) {
      NodeChange c = NodeChange::changed(kids.front());
      c.mask = F_MASK;
      c.props.mask = true;
      write(c);
    }
  }
  commit();
  return OK;
}

Status Editor::placeImage(const CommandArgs& a) {
  if (!a.hash.present || !(a.width > 0) || !(a.height > 0) || !doc_.has(page_)) return E_INVALID;
  // Into the selected frame, else the page; at the point given (page px), else the middle of the view.
  Guid parent = page_;
  if (selection_.size() == 1) {
    const Node* s = doc_.get(selection_[0]);
    if (s && acceptsChildren(selection_[0])) parent = selection_[0];
  }
  Vec2 at;
  if (a.hasX && a.hasY) {
    at = {a.x, a.y};
  } else {
    Vec2 centre = camera_.toWorld(visibleCentre());
    at = {centre.x - a.width / 2, centre.y - a.height / 2};
  }
  begin(TxnKind::USER, "Place image");
  NodeProps p = defaultProps(NodeType::ROUNDED_RECTANGLE);
  p.name = a.name.empty() ? "Image" : a.name;
  Paint img;
  img.type = PaintType::IMAGE;
  img.image = a.hash;
  img.imageName = a.name;
  img.imageScaleMode = ImageScaleMode::FILL;
  img.originalImageWidth = static_cast<uint32_t>(a.width);
  img.originalImageHeight = static_cast<uint32_t>(a.height);
  p.fillPaints = {img};
  p.size = {a.width, a.height};
  p.transform = doc_.worldTransform(parent).inverse() * Mat2x3::translate(std::round(at.x), std::round(at.y));
  p.parentIndex = {parent, placeAt(parent, doc_.children(parent).size(), kNoGuid)};
  Guid id = newGuid();
  write(NodeChange::created(id, p));
  changeSelection({id});
  commit();
  return OK;
}

}  // namespace eng
