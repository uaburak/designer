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
