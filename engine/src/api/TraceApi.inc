// The Vectorize ABI (docs/ai.md §5), included at the end of api/Api.cpp (it needs that file's Engine, Call and result
// slot; kept apart so the binding's own file changes by one line).
//
// engine_trace(rgba, w, h, opts): pure — straight RGBA8 (w × h) to a TraceResult JSON ({width, height, layers:
// [{color "#RRGGBB", area, d}]}, bottom layer first, `d` SVG path data in the input's pixels, fill rule evenodd).
//
// The live preview, a transaction like a panel scrub's:
//   engine_vectorize_begin(h, refs, rgba, w, h): one image layer (refs = [id]) and its pixels — its contents as
//     drawn, from engine_export (crop, scale mode and filters applied). Opens the user step "Vectorize" and puts an
//     empty FRAME (the layer's name, transform and size; no fill, no clip) just above the layer. E_BUSY while a
//     gesture or a step is open.
//   engine_vectorize_update(h, opts): traces again with `opts` (TraceOptions) into the frame — one VECTOR per colour,
//     bottom to top, named by its hex and filled with it. Result: {layers, segments, ms, width, height, exceeded};
//     over the budget ({exceeded: true}) the preview stays as it was.
//   engine_vectorize_end(h, commit): commit = 1 keeps the frame — named "<layer name> [Vectorized]", back in the flow
//     at the layer's place, selected — and hides the image layer (Figma's vectorize-image, atlas 18 §7.7: the original
//     is hidden, not deleted) as one undo step; 0 cancels (the document as it was).
// Budget: the pixels are brought to ≤ 1024 px on the long side at begin; an update stops past 1.5 s or 200,000 curve
// segments (docs/ai.md §5 "As built").

#include <optional>

#include "base/FractionalIndex.h"
#include "geometry/VectorNetwork.h"
#include "trace/Trace.h"

namespace {

struct VectorizeSession {
  Engine* engine = nullptr;
  Guid source = kNoGuid;
  Guid frame = kNoGuid;
  std::vector<Guid> vectors;  // bottom to top
  trace::Image pixels;        // the layer's pixels, within the tracer's budget
  Vec2 size;                  // the layer's size
  StackPositioning positioning = StackPositioning::AUTO;  // the layer's own (the frame takes it at commit)
  bool traced = false;
};

std::vector<VectorizeSession>* gVectorize = nullptr;

VectorizeSession* vectorizeOf(Engine* e) {
  if (!gVectorize) gVectorize = new std::vector<VectorizeSession>();
  for (auto& s : *gVectorize)
    if (s.engine == e) return &s;
  return nullptr;
}

void dropVectorize(Engine* e) {
  if (!gVectorize) return;
  gVectorize->erase(std::remove_if(gVectorize->begin(), gVectorize->end(), [&](const VectorizeSession& s) { return s.engine == e; }),
                    gVectorize->end());
}

// A GUID of this session's that no node has.
Guid freshGuid(const Editor& ed, uint32_t& next) {
  while (ed.document().has({ed.sessionID(), next})) next++;
  return {ed.sessionID(), next++};
}

void writeTraceResult(json::Writer& w, const trace::Result& r) {
  w.beginObject().key("width").number(r.width).key("height").number(r.height).key("layers").beginArray();
  for (const trace::Layer& l : r.layers)
    w.beginObject().key("color").string(trace::hexOf(l.color)).key("area").number(static_cast<double>(l.area)).key("d").string(trace::svgPathData(l.path)).endObject();
  w.endArray().endObject();
}

// The session's trace with `opts` written into its frame (inside the open step).
int32_t vectorizeTrace(VectorizeSession& s, const trace::Options& opts) {
  Editor& ed = s.engine->editor;
  if (!ed.document().has(s.frame)) return E_INVALID;
  trace::Budget budget;
  budget.timeLimitMs = 1500;
  trace::Result r = trace::trace(s.pixels.rgba.data(), s.pixels.w, s.pixels.h, opts, budget);
  json::Writer w;
  w.beginObject().key("layers").number(static_cast<double>(r.layers.size())).key("segments").number(static_cast<double>(r.segments));
  w.key("ms").number(std::round(r.ms * 10) / 10).key("width").number(r.tracedWidth).key("height").number(r.tracedHeight);
  w.key("exceeded").boolean(r.exceeded).endObject();
  if (r.exceeded) return setResult(w.take());
  // Pixels → the frame's space.
  const Mat2x3 toFrame{s.size.x / s.pixels.w, 0, 0, 0, s.size.y / s.pixels.h, 0};
  std::vector<std::string> keys = fractional::keysBetween("", std::nullopt, static_cast<int>(std::max<size_t>(r.layers.size(), 1)));
  std::vector<NodeChange> changes;
  uint32_t next = 1;
  std::vector<Guid> vectors;
  for (size_t i = 0; i < r.layers.size(); i++) {
    const trace::Layer& layer = r.layers[i];
    geom::VectorNetwork net = geom::networkFromPath(layer.path.transformed(toFrame), WindingRule::ODD);
    Rect b = net.vertices.empty() ? Rect{} : net.bounds();
    for (auto& v : net.vertices) v.p = v.p - Vec2{b.x, b.y};
    NodeProps p = defaultProps(NodeType::VECTOR);
    std::string hex = trace::hexOf(layer.color);
    p.name = hex.substr(1);
    p.strokePaints.clear();
    p.fillPaints = {Paint::solid(Color::hex((static_cast<uint32_t>(layer.color[0]) << 16) | (static_cast<uint32_t>(layer.color[1]) << 8) | layer.color[2]))};
    p.transform = Mat2x3::translate(b.x, b.y);
    p.size = {b.w, b.h};
    VectorData d;
    d.present = true;
    d.normalizedSize = p.size;
    d.network = std::make_shared<std::vector<uint8_t>>(net.encode());
    p.shape().vectorData = d;
    p.parentIndex = {s.frame, keys[i]};
    if (i < s.vectors.size() && ed.document().has(s.vectors[i])) {
      NodeChange c = NodeChange::changed(s.vectors[i]);
      c.mask = F_NAME | F_FILLS | F_STROKES | F_TRANSFORM | F_SIZE | F_VECTOR_DATA | F_PARENT_INDEX;
      c.props = std::move(p);
      changes.push_back(std::move(c));
      vectors.push_back(s.vectors[i]);
    } else {
      Guid id = freshGuid(ed, next);
      // (several new ones in one batch: none of them is in the document yet)
      while (std::find(vectors.begin(), vectors.end(), id) != vectors.end()) id = freshGuid(ed, ++next);
      changes.push_back(NodeChange::created(id, p));
      vectors.push_back(id);
    }
  }
  for (size_t i = r.layers.size(); i < s.vectors.size(); i++)
    if (ed.document().has(s.vectors[i])) changes.push_back(NodeChange::removed(s.vectors[i]));
  int32_t st = ed.applyChanges(changes, APPLY_USER);
  if (st != OK) return st;
  s.vectors = std::move(vectors);
  s.traced = true;
  return setResult(w.take());
}

}  // namespace

ENG_EXPORT int32_t engine_trace(Ptr rgbaPtr, uint32_t len, uint32_t w, uint32_t h, Ptr optsPtr, uint32_t optsLen) {
  Call call(false);
  if (!w || !h || static_cast<uint64_t>(w) * h * 4 != len || !rgbaPtr) {
    setError("engine_trace: the pixels are not width × height × 4 bytes");
    return E_INVALID;
  }
  trace::Options opts;
  json::Value v;
  if (optsLen && !parse(optsPtr, optsLen, v)) return E_DECODE;
  if (!trace::readOptions(v, opts)) {
    setError("engine_trace: unknown mode");
    return E_DECODE;
  }
  trace::Result r = trace::trace(reinterpret_cast<const uint8_t*>(rgbaPtr), static_cast<int>(w), static_cast<int>(h), opts);
  if (r.exceeded) {
    setError("engine_trace: the image is too detailed for these settings");
    return E_INVALID;
  }
  json::Writer out;
  writeTraceResult(out, r);
  return setResult(out.take());
}

ENG_EXPORT int32_t engine_vectorize_begin(Handle h, Ptr refsPtr, uint32_t refsLen, Ptr rgbaPtr, uint32_t len, uint32_t width, uint32_t height) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  Editor& ed = e->editor;
  if (ed.viewerMode()) return E_READONLY;
  json::Value v;
  if (!parse(refsPtr, refsLen, v)) return E_DECODE;
  std::vector<Guid> refs = readRefs(v);
  if (refs.size() != 1 || !width || !height || static_cast<uint64_t>(width) * height * 4 != len || !rgbaPtr) return E_INVALID;
  const Node* src = ed.document().get(refs[0]);
  if (!src || src->props.type == NodeType::CANVAS || src->props.type == NodeType::DOCUMENT || refs[0].isDerived()) return E_INVALID;
  if (VectorizeSession* old = vectorizeOf(e)) {
    if (!ed.idle()) return E_BUSY;
    dropVectorize(e);  // a session whose step is gone (the engine was reloaded)
    (void)old;
  }
  if (!ed.idle()) return E_BUSY;
  const NodeProps sp = src->props;
  Guid parent = sp.parentIndex.guid;
  const Node* parentNode = ed.document().get(parent);
  if (!parentNode) return E_INVALID;
  if (int32_t st = ed.txnBegin("Vectorize"); st != OK) return st;
  VectorizeSession s;
  s.engine = e;
  s.source = refs[0];
  s.size = sp.size;
  s.positioning = sp.stackPositioning;
  s.pixels = trace::fitToBudget(reinterpret_cast<const uint8_t*>(rgbaPtr), static_cast<int>(width), static_cast<int>(height));
  // The frame, just above the layer (out of an auto layout's flow while it previews).
  NodeProps f = defaultProps(NodeType::FRAME);
  f.name = sp.name;
  f.transform = sp.transform;
  f.size = sp.size;
  f.fillPaints.clear();
  f.frameMaskDisabled = true;
  f.horizontalConstraint = sp.horizontalConstraint;
  f.verticalConstraint = sp.verticalConstraint;
  f.stackChildAlignSelf = sp.stackChildAlignSelf;
  f.stackChildPrimaryGrow = sp.stackChildPrimaryGrow;
  f.stackPositioning = parentNode->props.stack().stackMode != StackMode::NONE ? StackPositioning::ABSOLUTE : sp.stackPositioning;
  const auto& siblings = ed.document().children(parent);
  auto at = std::find(siblings.begin(), siblings.end(), refs[0]);
  std::optional<std::string_view> above;
  if (at != siblings.end() && at + 1 != siblings.end()) above = ed.document().get(*(at + 1))->props.parentIndex.position;
  std::string key = fractional::keyBetween(sp.parentIndex.position, above, above ? fractional::Bias::Mid : fractional::Bias::Low);
  if (key.empty()) {
    ed.txnCancel();
    return E_INVALID;
  }
  f.parentIndex = {parent, key};
  uint32_t next = 1;
  s.frame = freshGuid(ed, next);
  if (int32_t st = ed.applyChanges({NodeChange::created(s.frame, f)}, APPLY_USER); st != OK) {
    ed.txnCancel();
    return st;
  }
  vectorizeOf(e);  // (the list exists)
  gVectorize->push_back(std::move(s));
  json::Writer w;
  w.beginObject().key("frame").string(gVectorize->back().frame.toString()).endObject();
  return setResult(w.take());
}

ENG_EXPORT int32_t engine_vectorize_update(Handle h, Ptr optsPtr, uint32_t optsLen) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  VectorizeSession* s = vectorizeOf(e);
  if (!s) return E_INVALID;
  trace::Options opts;
  json::Value v;
  if (optsLen && !parse(optsPtr, optsLen, v)) return E_DECODE;
  if (!trace::readOptions(v, opts)) return E_DECODE;
  return vectorizeTrace(*s, opts);
}

ENG_EXPORT int32_t engine_vectorize_end(Handle h, uint32_t commit) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  VectorizeSession* s = vectorizeOf(e);
  if (!s) return E_INVALID;
  Editor& ed = e->editor;
  if (!commit || !ed.document().has(s->frame)) {
    ed.txnCancel();
    dropVectorize(e);
    return commit ? E_INVALID : OK;
  }
  if (!s->traced) {
    trace::Options defaults;
    if (int32_t st = vectorizeTrace(*s, defaults); st != OK) {
      ed.txnCancel();
      dropVectorize(e);
      return st;
    }
  }
  // The frame takes the layer's place, back in the flow and named as Figma's; the layer stays, hidden.
  std::vector<NodeChange> changes;
  if (const Node* src = ed.document().get(s->source)) {
    NodeChange hide = NodeChange::changed(s->source);
    hide.mask = F_VISIBLE;
    hide.props.visible = false;
    changes.push_back(hide);
    NodeChange flow = NodeChange::changed(s->frame);
    flow.mask = F_STACK_POSITIONING | F_NAME;
    flow.props.stackPositioning = s->positioning;
    flow.props.name = src->props.name + " [Vectorized]";
    changes.push_back(flow);
  } else {
    NodeChange flow = NodeChange::changed(s->frame);
    flow.mask = F_STACK_POSITIONING;
    flow.props.stackPositioning = s->positioning;
    changes.push_back(flow);
  }
  int32_t st = ed.applyChanges(changes, APPLY_USER);
  if (st != OK) {
    ed.txnCancel();
    dropVectorize(e);
    return st;
  }
  Guid frame = s->frame;
  dropVectorize(e);
  ed.setSelection({frame});
  st = ed.txnCommit();
  if (st != OK) return st;
  json::Writer w;
  w.beginObject().key("frame").string(frame.toString()).endObject();
  return setResult(w.take());
}
