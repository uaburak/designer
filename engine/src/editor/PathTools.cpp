// Simplify vector and Offset path as Figma's tools (docs/research/rea/vector.md §8, §10): Figma's SIMPLIFY_VECTOR and
// OFFSET_PATH tools with their secondary toolbar (SimplifyVectorTsApi setThreshold / apply / cancel; OffsetPath
// setOffset / setJoinType / apply / cancel). One vector-editable layer, not in multi-edit. Every change previews live:
// the step stays open and is written again from the layer as it was (rolled back first), so the preview never
// compounds; Apply commits it as one undo step ("Simplify vector" / "Offset vector"), Cancel rolls it back.
//
// Simplify: threshold −2…3 (the slider starts at 3), tolerance 10^−threshold node px — 0.001 at the start (practically
// no change), 100 at the simple end. Offset: the slider's range comes from the engine (minSliderOffset /
// maxSliderOffset: −min(w, h) / 2 … a cap of ours until a live check), join Miter ("Square") or Round, starting at 0.

#include <algorithm>
#include <cmath>

#include "editor/Editor.h"

namespace eng {

namespace {

const char* pathToolLabel(Editor::PathTool k) { return k == Editor::PathTool::SIMPLIFY ? "Simplify vector" : "Offset vector"; }

// The Offset slider's upper end [ours]: Figma's maxSliderOffset is the engine's and wasn't read.
constexpr double kOffsetCap = 100;

}  // namespace

bool Editor::pathToolEnabled(PathTool kind) const {
  if (kind == PathTool::NONE || busy() || viewer_) return false;
  if (pathTool_.kind != PathTool::NONE) return false;
  if (vector_.node != kNoGuid && vector_.group.size() > 1) return false;  // not in multi-edit
  return vectorTargets().size() == 1;
}

Status Editor::pathToolBegin(PathTool kind) {
  if (!pathToolEnabled(kind) || txn_.open) return E_INVALID;
  Guid id = vectorTargets()[0];
  // Offset path writes a new outline: vector edit mode ends first (as Offset vector always did).
  if (kind == PathTool::OFFSET && vector_.node != kNoGuid) endVectorEdit();
  pathTool_ = PathToolState{};
  pathTool_.kind = kind;
  pathTool_.node = id;
  pathTool_.editing = vector_.node == id;
  if (pathTool_.editing) {
    pathTool_.net = vector_.net;
    pathTool_.selVerts = vector_.selVerts;
    pathTool_.selSegs = vector_.selSegs;
    pathTool_.penFrom = vector_.penFrom;
    pathTool_.pendingType = vector_.pendingType;
  }
  const Vec2 size = doc_.get(id)->props.size;
  pathTool_.minOffset = -std::floor(std::min(size.x, size.y) / 2);
  pathTool_.maxOffset = std::max(kOffsetCap, std::ceil(std::max(size.x, size.y)));
  events_.pathTool = true;
  needsRender_ = true;
  return OK;
}

Status Editor::pathToolSet(const json::Value& v) {
  if (pathTool_.kind == PathTool::NONE) return E_INVALID;
  if (!v.isObject()) return E_INVALID;
  if (pathTool_.kind == PathTool::SIMPLIFY) {
    const json::Value* t = v.get("threshold");
    if (!t || !t->isNumber() || !std::isfinite(t->number)) return E_INVALID;
    pathTool_.threshold = std::clamp(t->number, -2.0, 3.0);
  } else {
    const json::Value* o = v.get("offset");
    const json::Value* j = v.get("join");
    if ((!o || !o->isNumber() || !std::isfinite(o->number)) && (!j || !j->isString())) return E_INVALID;
    if (o && o->isNumber() && std::isfinite(o->number)) pathTool_.offset = std::clamp(o->number, pathTool_.minOffset, pathTool_.maxOffset);
    if (j && j->isString()) pathTool_.join = j->string == "ROUND" ? StrokeJoin::ROUND : StrokeJoin::MITER;
  }
  return pathToolPreview();
}

Status Editor::pathToolPreview() {
  // From the layer as it was: the previous preview rolled back (and, in vector edit mode, the edit's state restored).
  if (txn_.open) rollback();
  if (pathTool_.editing) {
    vector_.net = pathTool_.net;
    vector_.selVerts = pathTool_.selVerts;
    vector_.selSegs = pathTool_.selSegs;
    vector_.penFrom = pathTool_.penFrom;
    vector_.pendingType = pathTool_.pendingType;
    vector_.hoverVertex = vector_.hoverSegment = -1;
  }
  events_.pathTool = true;
  needsRender_ = true;
  const Guid id = pathTool_.node;
  if (!doc_.has(id)) {
    pathToolCancel();
    return E_INVALID;
  }
  begin(TxnKind::USER, pathToolLabel(pathTool_.kind));
  bool wrote = false;
  if (pathTool_.kind == PathTool::SIMPLIFY) {
    geom::VectorNetwork net;
    bool convert = false;
    if (pathTool_.editing) net = vector_.net;
    else if (!networkOf(id, net, convert)) net = {};
    if (simplifyNetwork(net, simplifyTolerance(pathTool_.threshold))) {
      writeSimplified(id, net);
      wrote = true;
    }
  } else if (pathTool_.offset != 0) {
    wrote = writeOffset(id, pathTool_.offset, pathTool_.join);
  }
  if (!wrote) rollback();  // nothing to preview: the layer as it was, no open step
  if (pathTool_.editing) vectorChanged();
  return OK;
}

Status Editor::pathToolApply() {
  if (pathTool_.kind == PathTool::NONE) return E_INVALID;
  const bool editing = pathTool_.editing;
  if (txn_.open) commit();
  pathTool_ = PathToolState{};
  events_.pathTool = true;
  needsRender_ = true;
  if (editing && vector_.node != kNoGuid) vectorChanged();
  return OK;
}

void Editor::pathToolCancel() {
  if (pathTool_.kind == PathTool::NONE) return;
  if (txn_.open) rollback();
  if (pathTool_.editing && vector_.node == pathTool_.node) {
    vector_.net = pathTool_.net;
    vector_.selVerts = pathTool_.selVerts;
    vector_.selSegs = pathTool_.selSegs;
    vector_.penFrom = pathTool_.penFrom;
    vector_.pendingType = pathTool_.pendingType;
    vector_.hoverVertex = vector_.hoverSegment = -1;
    vectorChanged();
  }
  pathTool_ = PathToolState{};
  events_.pathTool = true;
  needsRender_ = true;
}

void Editor::writePathToolState(json::Writer& w) const {
  const PathToolState& t = pathTool_;
  w.beginObject().key("active").boolean(t.kind != PathTool::NONE).key("kind");
  if (t.kind == PathTool::NONE) w.null();
  else w.string(t.kind == PathTool::SIMPLIFY ? "SIMPLIFY" : "OFFSET");
  w.key("node");
  if (t.node == kNoGuid) w.null();
  else w.string(t.node.toString());
  w.key("threshold").number(t.threshold).key("offset").number(t.offset).key("join").string(t.join == StrokeJoin::ROUND ? "ROUND" : "MITER");
  w.key("minOffset").number(t.minOffset).key("maxOffset").number(t.maxOffset).endObject();
}

}  // namespace eng
