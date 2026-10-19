// Round 19b [ours]: Illustrator's Pathfinders as commands (docs/roadmap.md Round 19, docs/engine.md §5 "Pathfinder";
// the geometry is geometry/Pathfinder.h). Destructive, as in Illustrator: the selected shapes are replaced by ordinary
// vectors — grouped as Illustrator groups them, Minus Back's one shape at the front one's place — so a file stays a
// plain Figma file (no schema change). One undo step named as Illustrator names the button; the result selected.

#include <algorithm>
#include <functional>
#include <unordered_set>

#include "base/FractionalIndex.h"
#include "editor/Editor.h"
#include "geometry/Pathfinder.h"
#include "kiwi.h"
#include "scene/CodecKiwi.h"

namespace eng {

namespace {

using GuidSet = std::unordered_set<Guid, GuidHash>;

bool anyVisibleFill(const std::vector<Paint>& paints) {
  for (const Paint& p : paints)
    if (p.visible && p.opacity > 0) return true;
  return false;
}

// The visible fills' identity (Merge: shapes of the same fill merge).
uint64_t fillKeyOf(const std::vector<Paint>& paints) {
  kiwi::ByteBuffer bb;
  for (const Paint& p : paints)
    if (p.visible) codec::writePaint(bb, p, nullptr);
  uint64_t h = 1469598103934665603ull;
  for (size_t i = 0; i < bb.size(); i++) h = (h ^ bb.data()[i]) * 1099511628211ull;
  return h;
}

// A frame (not a group) is a shape of its own — its box — under its layers.
bool boxFrame(const NodeProps& p) { return (p.type == NodeType::FRAME && !p.isGroupLike()) || p.type == NodeType::INSTANCE || p.type == NodeType::SYMBOL; }

}  // namespace

void Editor::pathfinderInputs(const Mat2x3& toSpace, std::vector<geom::PathfinderInput>& inputs, std::vector<Guid>& sources) const {
  std::function<void(Guid)> add = [&](Guid id) {
    const Node* n = doc_.get(id);
    if (!n || !n->props.visible) return;
    const NodeProps& p = n->props;
    Mat2x3 m = toSpace * doc_.worldTransform(id);
    auto leaf = [&](bool own) {
      const NodeGeometry* g = doc_.geometry(id);
      if (!g) return;
      geom::PathfinderInput in;
      for (auto& f : g->fills) {
        in.path.append(f.path.transformed(m));
        if (f.windingRule == WindingRule::ODD) in.rule = WindingRule::ODD;
      }
      // A line (no area): its centre line cuts.
      if (in.path.empty() && !own) in.path = g->stroke.path.transformed(m);
      if (in.path.empty()) return;
      in.filled = anyVisibleFill(p.fillPaints);
      in.fillKey = fillKeyOf(p.fillPaints);
      inputs.push_back(std::move(in));
      sources.push_back(id);
    };
    if (p.isGroupLike()) {
      for (Guid c : doc_.children(id)) add(c);
      return;
    }
    if (boxFrame(p)) {
      if (anyVisibleFill(p.fillPaints)) leaf(true);
      for (Guid c : doc_.children(id)) add(c);
      return;
    }
    leaf(false);  // shapes, texts, booleans (their result)
  };
  for (Guid t : topSelectionInPaintOrder()) add(t);
}

bool Editor::pathfinderEnabled(geom::PathfinderOp op) const {
  std::vector<Guid> top = topSelectionInPaintOrder();
  if (top.empty()) return false;
  for (Guid t : top) {
    const Node* n = doc_.get(t);
    if (!n || n->props.locked || instanceSublayer(t, false) || n->props.isComponentSet()) return false;
  }
  std::vector<geom::PathfinderInput> inputs;
  std::vector<Guid> sources;
  pathfinderInputs(Mat2x3{}, inputs, sources);
  // Divide and Outline take one shape too (its own crossings); the others need something to work against.
  return inputs.size() >= (op == geom::PathfinderOp::DIVIDE || op == geom::PathfinderOp::OUTLINE ? 1u : 2u);
}

Status Editor::pathfinderSelection(geom::PathfinderOp op, const geom::PathfinderOptions& options) {
  if (!pathfinderEnabled(op)) return E_INVALID;
  std::vector<Guid> top = topSelectionInPaintOrder();
  Guid topmost = top.back();
  Guid parent = doc_.parentOf(topmost);
  Mat2x3 toParent = doc_.worldTransform(parent).inverse();
  std::vector<geom::PathfinderInput> inputs;
  std::vector<Guid> sources;
  pathfinderInputs(toParent, inputs, sources);
  std::vector<geom::PathfinderPiece> pieces = geom::pathfinder(inputs, op, options);
  if (pieces.empty()) return E_INVALID;
  if (vector_.node != kNoGuid) endVectorEdit();

  // Where the result goes: at the topmost layer's place once they are all gone (as a group goes).
  GuidSet going(top.begin(), top.end());
  size_t index = 0;
  for (Guid c : doc_.children(parent)) {
    if (c == topmost) break;
    if (!going.count(c)) index++;
  }
  Rect all;
  bool any = false;
  for (const auto& piece : pieces) {
    Rect b = piece.path.bounds();
    all = any ? all.united(b) : b;
    any = true;
  }
  begin(TxnKind::USER, geom::pathfinderName(op));
  const bool grouped = op != geom::PathfinderOp::MINUS_BACK;
  Guid holder = parent;
  Mat2x3 toHolder;
  if (grouped) {
    NodeProps g = defaultProps(NodeType::FRAME);
    g.name = nextName("Group");
    g.resizeToFit = true;
    g.fillPaints.clear();
    g.frameMaskDisabled = true;
    g.transform = Mat2x3::translate(all.x, all.y);
    g.size = {all.w, all.h};
    g.parentIndex = {parent, placeManyAt(parent, index, 1, going)[0]};
    holder = newGuid();
    write(NodeChange::created(holder, g));
    toHolder = Mat2x3::translate(-all.x, -all.y);
  }
  auto keys = grouped ? fractional::keysBetween("", std::nullopt, static_cast<int>(pieces.size())) : placeManyAt(parent, index, 1, going);
  std::vector<Guid> made;
  for (size_t i = 0; i < pieces.size(); i++) {
    const geom::PathfinderPiece& piece = pieces[i];
    const NodeProps& sp = doc_.get(sources[piece.source])->props;
    NodeProps v = defaultProps(NodeType::VECTOR);
    v.name = sp.name;
    v.opacity = sp.opacity;
    v.blendMode = sp.blendMode;
    v.strokeJoin = sp.strokeJoin;
    if (op == geom::PathfinderOp::OUTLINE) {
      // Illustrator: each edge stroked with its shape's fill colour (its stroke, for a shape without a fill), no fill.
      v.fillPaints.clear();
      v.strokePaints = anyVisibleFill(sp.fillPaints) ? sp.fillPaints : sp.strokePaints;
      v.strokeWeight = 1;
      v.strokeAlign = StrokeAlign::CENTER;
    } else {
      v.fillPaints = sp.fillPaints;
      // Divide and Minus Back keep the strokes; Trim, Merge and Crop remove them (Illustrator).
      bool strokes = op == geom::PathfinderOp::DIVIDE || op == geom::PathfinderOp::MINUS_BACK;
      v.strokePaints = strokes ? sp.strokePaints : std::vector<Paint>{};
      v.strokeWeight = strokes ? sp.strokeWeight : v.strokeWeight;
      v.strokeAlign = strokes ? sp.strokeAlign : v.strokeAlign;
    }
    v.parentIndex = {holder, keys[i]};
    Guid id = newGuid();
    write(NodeChange::created(id, v));
    writeVector(id, geom::networkFromPath(piece.path.transformed(toHolder), WindingRule::NONZERO), Mat2x3{});
    made.push_back(id);
  }
  // The originals go (a main component as Delete deletes it: kept for its instances).
  std::function<void(Guid)> removeTree = [&](Guid id) {
    std::vector<Guid> kids = doc_.children(id);
    for (Guid k : kids) removeTree(k);
    write(NodeChange::removed(id));
  };
  for (Guid t : top) {
    if (!doc_.has(t)) continue;
    if (doc_.get(t)->props.type == NodeType::SYMBOL && softDeleteMain(t)) continue;
    removeTree(t);
  }
  changeSelection(grouped ? std::vector<Guid>{holder} : made);
  commit();
  return OK;
}

}  // namespace eng
