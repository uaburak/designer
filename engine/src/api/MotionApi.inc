// Figma Motion's flat API (docs/motion.md §4.9, §5; round 8a — round 8b adds the reads and the commands). Included by
// Api.cpp after its helpers (engineOf, Call, setResult, parse()).
//
//   engine_set_motion(h, json): the view state {on, root ("s:l" | null), timeUs, autoKeyframe, showMotionPath} — omitted
//   keys keep their value. On: the root's layers draw at the playhead (the motion layer's preview writes); off: the
//   base values. MOTION_CHANGED follows a change of root or of on / off.

ENG_EXPORT int32_t engine_set_motion(Handle h, Ptr ptr, uint32_t len) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Value v;
  if (!parse(ptr, len, v)) return E_DECODE;
  return e->editor.setMotionJson(v);
}

// ---- Reads (round 8b; the JSON shapes are src/shared/motion/types.ts's TimelineModel, FieldStates, ResolvedMotion) ----

// engine_motion_timeline(h, ref): the timeline model of the root holding `ref` (an empty ref: the selection's root);
// null when there is none.
ENG_EXPORT int32_t engine_motion_timeline(Handle h, Ptr refPtr, uint32_t refLen) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  Guid root = kNoGuid;
  if (refLen) {
    bool ok = false;
    root = Guid::parse(bytes(refPtr, refLen), &ok);
    if (!ok) return E_INVALID;
  }
  json::Writer w;
  e->editor.writeMotionTimeline(w, root);
  return setResult(w.take());
}

// engine_motion_field_states(h, refs): per node, per field key, the right panel's diamond (none / track / keyframe).
// `refs`: a JSON array of "s:l", or {"refs": [...]}.
ENG_EXPORT int32_t engine_motion_field_states(Handle h, Ptr ptr, uint32_t len) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Value v;
  if (!parse(ptr, len, v)) return E_DECODE;
  const json::Value* list = v.isArray() ? &v : v.get("refs");
  std::vector<Guid> ids;
  if (list && list->isArray())
    for (const json::Value& r : list->array)
      if (r.isString()) {
        bool ok = false;
        Guid g = Guid::parse(r.string, &ok);
        if (ok) ids.push_back(g);
      }
  json::Writer w;
  e->editor.writeMotionFieldStates(w, ids);
  return setResult(w.take());
}

// engine_motion_resolved(h, ref): the resolved model of a root (every animated layer under it) or of one layer.
ENG_EXPORT int32_t engine_motion_resolved(Handle h, Ptr refPtr, uint32_t refLen) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  bool ok = false;
  Guid id = Guid::parse(bytes(refPtr, refLen), &ok);
  if (!ok) return E_INVALID;
  json::Writer w;
  e->editor.writeMotionResolved(w, id);
  return setResult(w.take());
}
