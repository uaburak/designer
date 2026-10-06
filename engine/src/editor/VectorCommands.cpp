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

void Editor::fillPathsOf(Guid id, const Mat2x3& toSpace, geom::Path& out, WindingRule& rule) const {
  const Node* n = doc_.get(id);
  if (!n || !n->props.visible) return;
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
      c.props.booleanOperation = op;
      c.props.name = booleanName(op);
      write(c);
    }
    commit();
    return OK;
  }
  if (top.size() < 2) return E_INVALID;
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
  p.booleanOperation = op;
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
    if (n && !n->props.locked &&
        (n->props.isPathShape() || n->props.isRectLike() || n->props.type == NodeType::ELLIPSE || n->props.type == NodeType::TEXT ||
         n->props.isGroupLike()))
      targets.push_back(t);
  }
  if (targets.empty()) return E_INVALID;
  if (vector_.node != kNoGuid) endVectorEdit();
  begin(TxnKind::USER, "Flatten selection");
  // Into the topmost one: its own space holds everyone's outlines.
  Guid into = targets.back();
  const Node* keep = doc_.get(into);
  Mat2x3 toInto = doc_.worldTransform(into).inverse();
  geom::Path all;
  WindingRule rule = WindingRule::NONZERO;
  for (Guid t : targets) fillPathsOf(t, toInto * doc_.worldTransform(t), all, rule);
  geom::VectorNetwork net = geom::networkFromPath(all, rule);
  NodeProps kp = keep->props;
  // The kept layer becomes a VECTOR (same GUID); its children (a boolean's operands, a group's layers) go.
  NodeChange c = NodeChange::changed(into);
  c.mask = F_TYPE | F_CORNER_RADII | F_CORNER_SMOOTHING | F_ARC_DATA | F_RESIZE_TO_FIT | F_FRAME_MASK_DISABLED;
  c.props.type = NodeType::VECTOR;
  if (kp.isGroupLike() || kp.type == NodeType::TEXT) {
    // A group or a text takes the look of what it held.
    c.mask |= F_FILLS | F_STROKES;
    Guid styleFrom = kp.isGroupLike() && !doc_.children(into).empty() ? doc_.children(into).back() : into;
    c.props.fillPaints = doc_.get(styleFrom)->props.fillPaints;
    c.props.strokePaints = doc_.get(styleFrom)->props.strokePaints;
  }
  write(c);
  std::vector<Guid> gone;
  std::function<void(Guid)> removeTree = [&](Guid id) {
    std::vector<Guid> kids = doc_.children(id);
    for (Guid k : kids) removeTree(k);
    write(NodeChange::removed(id));
  };
  for (Guid k : std::vector<Guid>(doc_.children(into))) removeTree(k);
  for (Guid t : targets)
    if (t != into) removeTree(t);
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
    style.dashes = p.dashPattern;
    style.caps = g->stroke.caps.empty() ? nullptr : &g->stroke.caps;
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
      c.mask = F_TYPE | F_FILLS | F_STROKES | F_CORNER_RADII | F_CORNER_SMOOTHING | F_ARC_DATA | F_DASH_PATTERN;
      c.props.type = NodeType::VECTOR;
      c.props.fillPaints = p.strokePaints;
      c.props.strokePaints.clear();
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
    if (s && s->props.isFrameLike()) parent = selection_[0];
  }
  Vec2 at;
  if (a.hasX && a.hasY) {
    at = {a.x, a.y};
  } else {
    Vec2 centre = camera_.toWorld({viewport_.width / 2, viewport_.height / 2});
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
