// Figma Draw's ABI (docs/draw.md §4.5, §4.7; Phase 7 round 7b), included at the end of api/Api.cpp (it needs that
// file's Engine, Call and result slot; kept apart so the binding's own file changes by one line). The commands 310–321
// go through engine_command with their DrawCommandArgs (src/shared/draw/types.ts).
//
//   engine_install_brush(h, json): InstallBrushInput {name, type "STRETCH" | "SCATTER", artwork {width, height, d,
//     windingRule}, settings? (a scatter brush's own ScatterStrokeSettings)} → {"guid"}: the file's BRUSH node with that name and type, else a new one on the Internal Only Canvas.
//   engine_list_brushes(h) → [{guid, name, type}]: the file's BRUSH nodes.
//   engine_brush_preview(h, json, w, h, weight): {brush: guid} or {artwork, type, settings?} drawn along a fixed S-curve
//     (a scatter brush with its node's settings, or `settings`, over Figma's base) → pixels
//     (u32 width, u32 height, straight RGBA: black, the coverage in alpha).
//   engine_set_draw_tool_settings(h, json): DrawToolSettings — what the Pencil and the Brush make.

namespace {

bool artworkOf(const json::Value& a, geom::Path& path, Vec2& box, WindingRule& rule) {
  if (!a.isObject()) return false;
  const json::Value* w = a.get("width");
  const json::Value* hh = a.get("height");
  const json::Value* d = a.get("d");
  if (!w || !hh || !d || !d->isString()) return false;
  box = {w->numberOr(0), hh->numberOr(0)};
  if (!(box.x > 0) || !(box.y > 0)) return false;
  const json::Value* r = a.get("windingRule");
  rule = r && r->isString() && (r->string == "ODD" || r->string == "EVENODD") ? WindingRule::ODD : WindingRule::NONZERO;
  return parseSvgPath(d->string, path);
}

bool brushTypeOf(const json::Value* t, bool& scatter) {
  if (!t || !t->isString() || (t->string != "STRETCH" && t->string != "SCATTER")) return false;
  scatter = t->string == "SCATTER";
  return true;
}

}  // namespace

ENG_EXPORT int32_t engine_install_brush(Handle h, Ptr ptr, uint32_t len) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  if (e->editor.viewerMode()) return E_READONLY;
  json::Value v;
  if (!parse(ptr, len, v) || !v.isObject()) return E_DECODE;
  const json::Value* name = v.get("name");
  bool scatter = false;
  geom::Path art;
  Vec2 box;
  WindingRule rule = WindingRule::NONZERO;
  if (!name || !name->isString() || name->string.empty() || !brushTypeOf(v.get("type"), scatter) || !v.get("artwork") ||
      !artworkOf(*v.get("artwork"), art, box, rule))
    return E_INVALID;
  Guid g = e->editor.installBrush(name->string, scatter, box, art, rule, v.get("settings"));
  if (g == kNoGuid) return E_BUSY;
  json::Writer w;
  w.beginObject().key("guid").string(g.toString()).endObject();
  return setResult(w.take());
}

ENG_EXPORT int32_t engine_list_brushes(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Writer w;
  w.beginArray();
  for (const Editor::BrushInfo& b : e->editor.listBrushes())
    w.beginObject().key("guid").string(b.guid.toString()).key("name").string(b.name).key("type").string(b.scatter ? "SCATTER" : "STRETCH").endObject();
  w.endArray();
  return setResult(w.take());
}

ENG_EXPORT int32_t engine_brush_preview(Handle h, Ptr ptr, uint32_t len, uint32_t width, uint32_t height, double weight) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Value v;
  if (!parse(ptr, len, v) || !v.isObject()) return E_DECODE;
  geom::Path art;
  Vec2 box;
  bool scatter = false;
  geom::ScatterSettings settings;
  if (const json::Value* b = v.get("brush")) {
    bool ok = false;
    Guid g = b->isString() ? Guid::parse(b->string, &ok) : kNoGuid;
    if (!ok || !e->editor.brushArtwork(g, art, box, scatter, &settings)) return E_NOT_FOUND;
  } else {
    WindingRule rule = WindingRule::NONZERO;
    if (!v.get("artwork") || !artworkOf(*v.get("artwork"), art, box, rule) || !brushTypeOf(v.get("type"), scatter)) return E_INVALID;
    if (const json::Value* s = v.get("settings")) scatterSettingsOver(settings, *s);
  }
  std::string rgba;
  if (!brushPreview(art, box, scatter, static_cast<int>(width), static_cast<int>(height), weight, rgba, &settings)) return E_INVALID;
  std::string out(8, '\0');
  for (int i = 0; i < 4; i++) {
    out[static_cast<size_t>(i)] = static_cast<char>((width >> (8 * i)) & 0xff);
    out[static_cast<size_t>(4 + i)] = static_cast<char>((height >> (8 * i)) & 0xff);
  }
  out += rgba;
  return setResult(std::move(out));
}

ENG_EXPORT int32_t engine_set_draw_tool_settings(Handle h, Ptr ptr, uint32_t len) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Value v;
  if (!parse(ptr, len, v)) return E_DECODE;
  return e->editor.setDrawToolSettings(v);
}
