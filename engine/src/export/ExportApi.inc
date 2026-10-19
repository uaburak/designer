// The export ABI (docs/engine-build.md "E7 export"), included at the end of api/Api.cpp (it needs that file's Engine,
// Call and result slot; kept apart so the binding's own file changes by one line).
//
// engine_export(refs, settings, flags): one export of one layer (PNG / JPEG / SVG) or of every listed layer as the
// pages of one PDF; refs [] = the current page's canvas. settings: an ExportSettings with the schema's names
// ({"imageType":"PNG","constraint":{"type":"CONTENT_SCALE","value":2},"contentsOnly":true,…}). Result: PNG / JPEG:
// u32 width, u32 height (little endian), then width × height straight RGBA8 rows top to bottom (JPEG: on white,
// opaque) for TypeScript to encode; SVG / PDF: the file. E_BUSY: fonts or images the export draws are still loading
// (they are requested; try again once they arrive, or pass EXPORT_ALLOW_PENDING to draw what there is).

#include <functional>
#include <unordered_set>

namespace {

enum ExportFlags : uint32_t { EXPORT_ALLOW_PENDING = 1 };

void unpremultiply(uint8_t* px, size_t bytes) {
  for (size_t i = 0; i + 3 < bytes; i += 4) {
    uint8_t a = px[i + 3];
    if (a == 0 || a == 255) continue;
    for (int c = 0; c < 3; c++) px[i + c] = static_cast<uint8_t>(std::min(255, (px[i + c] * 255 + a / 2) / a));
  }
}

// `only`'s subtree (kNoGuid: every layer of `page`) as `r` says, straight RGBA8, drawn in tiles the device can hold.
bool renderExport(Engine* e, Guid page, Guid only, const exporter::Raster& r, std::string& rgba) {
  if (!e->renderer || !e->device) return false;
  Editor& ed = e->editor;
  const Document& doc = ed.document();
  const int W = r.width, H = r.height;
  rgba.assign(static_cast<size_t>(W) * H * 4, '\0');
  const int tile = std::max(64, std::min<int>(4096, static_cast<int>(e->device->caps().maxTextureSize)));
  Overlay none;
  none.handles = false;
  none.sizeBadge = false;
  none.frameTitles = false;
  none.selectionBox = false;
  std::vector<uint8_t> buf;
  bool ok = true;
  e->renderer->setExporting(true);
  for (int ty = 0; ty < H && ok; ty += tile) {
    for (int tx = 0; tx < W && ok; tx += tile) {
      int tw = std::min(tile, W - tx), th = std::min(tile, H - ty);
      gfx::TargetId target = e->device->createTarget(static_cast<uint32_t>(tw), static_cast<uint32_t>(th));
      if (!target) {
        ok = false;
        break;
      }
      Camera camera{-r.origin.x * r.scale - tx, -r.origin.y * r.scale - ty, r.scale};
      Viewport viewport{static_cast<double>(tw), static_cast<double>(th), 1, tw, th};
      e->renderer->render(doc, page, camera, viewport, none, OverlayStyle::of(ed.theme()), target, only);
      buf.assign(static_cast<size_t>(tw) * th * 4, 0);
      ok = e->device->readPixels(target, {0, 0, tw, th}, {buf.data(), buf.size()});
      e->device->destroyTarget(target);
      for (int y = 0; ok && y < th; y++)
        std::copy_n(buf.data() + static_cast<size_t>(y) * tw * 4, static_cast<size_t>(tw) * 4,
                    reinterpret_cast<uint8_t*>(rgba.data()) + (static_cast<size_t>(ty + y) * W + tx) * 4);
    }
  }
  e->renderer->setExporting(false);
  if (!ok) return false;
  unpremultiply(reinterpret_cast<uint8_t*>(rgba.data()), rgba.size());
  return true;
}

// Straight RGBA over an opaque colour.
void flatten(std::string& rgba, const Color& under) {
  auto* px = reinterpret_cast<uint8_t*>(rgba.data());
  double bg[3] = {under.r * 255.0, under.g * 255.0, under.b * 255.0};
  for (size_t i = 0; i + 3 < rgba.size(); i += 4) {
    double a = px[i + 3] / 255.0;
    for (int c = 0; c < 3; c++) px[i + c] = static_cast<uint8_t>(std::lround(px[i + c] * a + bg[c] * (1 - a)));
    px[i + 3] = 255;
  }
}

struct ExportJob {
  exporter::Settings settings;
  std::vector<exporter::Target> targets;
};

// Static exports draw the base values while Motion is on (docs/motion.md §3.4, the owner's answer of 2026-10-12): the
// caller holds the editor's motionSuspended() for the call. With `motionTimeUs` in the settings [ours] they draw the
// timeline at that time instead (§7.2's exports at time t, for any layer): the first ref's timeline root is applied at
// it, as engine_motion_render_frame does, and the view state is put back after.
class ExportAtTime {
 public:
  ExportAtTime(Editor& ed, Ptr refsPtr, uint32_t refsLen, Ptr settingsPtr, uint32_t settingsLen) : ed_(ed), prev_(ed.motion()) {
    json::Value settings, refs;
    if (!settingsLen || !parse(settingsPtr, settingsLen, settings) || !settings.isObject()) return;
    const json::Value* t = settings.get("motionTimeUs");
    if (!t || !t->isNumber() || !refsLen || !parse(refsPtr, refsLen, refs)) return;
    Guid root = kNoGuid;
    for (Guid id : readRefs(refs))
      if (root == kNoGuid) root = ed.motionIndex().rootOf(ed.document(), id);
    if (root == kNoGuid) return;
    motion::State at = prev_;
    at.on = true;
    at.root = root;
    at.timeUs = static_cast<int64_t>(std::llround(std::max(0.0, t->number)));
    ed.setMotion(at);
    timed_ = true;
  }
  ~ExportAtTime() {
    if (timed_) ed_.setMotion(prev_);
  }
  ExportAtTime(const ExportAtTime&) = delete;
  ExportAtTime& operator=(const ExportAtTime&) = delete;

 private:
  Editor& ed_;
  motion::State prev_;
  bool timed_ = false;
};

// The targets of refs (none: the current page's canvas); E_NOT_FOUND (with the error set) when one shows nothing.
int32_t exportJob(Engine* e, Ptr refsPtr, uint32_t refsLen, Ptr settingsPtr, uint32_t settingsLen, ExportJob& job) {
  Editor& ed = e->editor;
  const Document& doc = ed.document();
  json::Value refs, settings;
  if (refsLen && !parse(refsPtr, refsLen, refs)) return E_DECODE;
  if (settingsLen && !parse(settingsPtr, settingsLen, settings)) return E_DECODE;
  job.settings = exporter::parseSettings(settings);
  std::vector<Guid> ids = readRefs(refs);
  if (ids.empty()) {
    exporter::Target t;
    ed.derivePage(ed.page());
    if (!exporter::resolveTarget(doc, &ed, ed.page(), kNoGuid, job.settings, t)) {
      setError("nothing on the page to export");
      return E_NOT_FOUND;
    }
    job.targets.push_back(t);
    return OK;
  }
  if (ids.size() > 1 && job.settings.format != exporter::Format::PDF) {
    // Several layers in one image or SVG (Copy as PNG / SVG of a selection).
    for (Guid id : ids) ed.derivePageOf(id);
    exporter::Target t;
    if (!exporter::resolveTargets(doc, &ed, ids, job.settings, t)) {
      setError("nothing to export");
      return E_NOT_FOUND;
    }
    job.targets.push_back(t);
    return OK;
  }
  for (Guid id : ids) {
    ed.derivePageOf(id);
    exporter::Target t;
    if (!exporter::resolveTarget(doc, &ed, kNoGuid, id, job.settings, t)) {
      setError("nothing to export: " + id.toString());
      return E_NOT_FOUND;
    }
    job.targets.push_back(t);
  }
  return OK;
}

double exportScale(const ExportJob& job, const exporter::Target& t) {
  if (job.settings.format == exporter::Format::SVG || job.settings.format == exporter::Format::PDF) return 1;
  return exporter::rasterOf(t.bounds, job.settings).scale;
}

}  // namespace

ENG_EXPORT int32_t engine_export(Handle h, Ptr refsPtr, uint32_t refsLen, Ptr settingsPtr, uint32_t settingsLen, uint32_t flags) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  Editor& ed = e->editor;
  const Document& doc = ed.document();
  auto motionGuard = ed.motionSuspended();  // the base values, or the timeline at `motionTimeUs` (ExportAtTime)
  ExportAtTime timed(ed, refsPtr, refsLen, settingsPtr, settingsLen);
  ExportJob job;
  if (int32_t s = exportJob(e, refsPtr, refsLen, settingsPtr, settingsLen, job); s != OK) return s;
  if (!(flags & EXPORT_ALLOW_PENDING)) {
    bool ready = true;
    for (auto& t : job.targets) ready &= exporter::ready(doc, &ed, t, exportScale(job, t));
    if (!ready) return E_BUSY;
  }
  using exporter::Format;
  Format f = job.settings.format;
  if (f == Format::PDF) {
    exporter::Rasterize raster = [e](Guid id, const Rect& world, double scale, int& w, int& h, std::string& rgba) {
      exporter::Raster r;
      r.scale = scale;
      r.origin = {world.x, world.y};
      r.width = w = std::max(1, static_cast<int>(std::ceil(world.w * scale)));
      r.height = h = std::max(1, static_cast<int>(std::ceil(world.h * scale)));
      return renderExport(e, e->editor.document().pageOf(id), id, r, rgba);
    };
    return setResult(exporter::writePdf(doc, &ed, job.targets, job.settings, raster));
  }
  const exporter::Target& t = job.targets[0];
  if (f == Format::SVG) return setResult(exporter::writeSvg(doc, &ed, t, job.settings));
  exporter::Raster r = exporter::rasterOf(t.bounds, job.settings);
  std::string rgba;
  if (!t.region && !t.nodes.empty()) {
    // A selection: each layer drawn on its own, then over the ones below it.
    for (Guid id : t.nodes) {
      std::string one;
      if (!renderExport(e, t.page, id, r, one)) return E_UNSUPPORTED;
      if (rgba.empty()) {
        rgba = std::move(one);
        continue;
      }
      auto* dst = reinterpret_cast<uint8_t*>(rgba.data());
      const auto* src = reinterpret_cast<const uint8_t*>(one.data());
      for (size_t i = 0; i + 3 < rgba.size(); i += 4) {
        double sa = src[i + 3] / 255.0, da = dst[i + 3] / 255.0;
        double oa = sa + da * (1 - sa);
        if (oa <= 0) continue;
        for (int c = 0; c < 3; c++) dst[i + c] = static_cast<uint8_t>(std::lround((src[i + c] * sa + dst[i + c] * da * (1 - sa)) / oa));
        dst[i + 3] = static_cast<uint8_t>(std::lround(oa * 255));
      }
    }
  } else {
    Guid only = !t.region ? t.node : (t.scope != t.page ? t.scope : kNoGuid);
    if (!renderExport(e, t.page, only, r, rgba)) return E_UNSUPPORTED;
  }
  if (t.background) flatten(rgba, t.backgroundColor);
  if (f == Format::JPEG) flatten(rgba, Color{1, 1, 1, 1});
  std::string out(8, '\0');
  for (int i = 0; i < 4; i++) {
    out[static_cast<size_t>(i)] = static_cast<char>((static_cast<uint32_t>(r.width) >> (8 * i)) & 0xff);
    out[static_cast<size_t>(4 + i)] = static_cast<char>((static_cast<uint32_t>(r.height) >> (8 * i)) & 0xff);
  }
  out += rgba;
  return setResult(std::move(out));
}

// What an export would make, without making it: {"targets":[{"ref","width","height","bounds":{x,y,w,h}}],
// "images":["<sha1>",…] (what an SVG / PDF needs handed in), "ready": bool (fonts and images arrived; asks for them)}.
// width / height: the pixels (PNG, JPEG) or the file's size in px (SVG, PDF).
ENG_EXPORT int32_t engine_export_info(Handle h, Ptr refsPtr, uint32_t refsLen, Ptr settingsPtr, uint32_t settingsLen) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  Editor& ed = e->editor;
  const Document& doc = ed.document();
  auto motionGuard = ed.motionSuspended();  // as engine_export draws it
  ExportAtTime timed(ed, refsPtr, refsLen, settingsPtr, settingsLen);
  ExportJob job;
  if (int32_t s = exportJob(e, refsPtr, refsLen, settingsPtr, settingsLen, job); s != OK) return s;
  bool vector = job.settings.format == exporter::Format::SVG || job.settings.format == exporter::Format::PDF;
  json::Writer w;
  w.beginObject().key("targets").beginArray();
  bool ready = true;
  std::vector<std::string> images;
  std::unordered_set<std::string> seen;
  for (auto& t : job.targets) {
    exporter::Raster r = exporter::rasterOf(t.bounds, job.settings);
    w.beginObject().key("ref");
    if (t.node == kNoGuid) w.null();
    else w.string(t.node.toString());
    w.key("width").number(vector ? t.bounds.w : r.width).key("height").number(vector ? t.bounds.h : r.height);
    w.key("bounds").beginObject().key("x").number(t.bounds.x).key("y").number(t.bounds.y).key("w").number(t.bounds.w).key("h").number(t.bounds.h);
    w.endObject().endObject();
    ready &= exporter::ready(doc, &ed, t, exportScale(job, t));
    for (const ImageHash& hash : exporter::imagesOf(doc, &ed, t))
      if (seen.insert(hash.hex()).second) images.push_back(hash.hex());
  }
  w.endArray().key("images").beginArray();
  for (auto& s : images) w.string(s);
  w.endArray().key("ready").boolean(ready).endObject();
  return setResult(w.take());
}

// An image for the vector exports, by its SHA-1 (40 hex): kind 0 the file itself (SVG inlines it), 1 a JPEG of its
// colour, 2 raw RGB8 (PDF), with `alpha` (width × height bytes; empty: opaque). Kept until engine_export_clear_images.
ENG_EXPORT int32_t engine_export_image(Handle h, Ptr hashPtr, uint32_t hashLen, uint32_t kind, uint32_t width, uint32_t height, Ptr dataPtr,
                                       uint32_t dataLen, Ptr alphaPtr, uint32_t alphaLen) {
  Call call(false);
  if (!engineOf(h)) return E_HANDLE;
  bool ok = false;
  ImageHash hash = ImageHash::fromHex(bytes(hashPtr, hashLen), &ok);
  if (!ok || kind > 2) return E_INVALID;
  exporter::ImageStore::get().put(hash, kind, width, height, std::string(bytes(dataPtr, dataLen)), std::string(bytes(alphaPtr, alphaLen)));
  return OK;
}

ENG_EXPORT void engine_export_clear_images() { exporter::ImageStore::get().clear(); }

// The layers of a page with export settings (the Export dialog, ⇧⌘E), in layer order (depth first, back to front):
// [{"guid","name","type","exportSettings":[…]}]. Page (0xffffffff, 0xffffffff): the current one.
ENG_EXPORT int32_t engine_export_list(Handle h, uint32_t pageSessionID, uint32_t pageLocalID) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  Editor& ed = e->editor;
  const Document& doc = ed.document();
  Guid page{pageSessionID, pageLocalID};
  if (page == kNoGuid) page = ed.page();
  const Node* pn = doc.get(page);
  if (!pn || pn->props.type != NodeType::CANVAS) return E_NOT_FOUND;
  ed.derivePage(page);
  json::Writer w;
  w.beginArray();
  std::function<void(Guid, int)> walk = [&](Guid id, int depth) {
    if (depth > 256) return;
    const Node* n = doc.get(id);
    if (!n) return;
    if (id != page) {
      auto it = n->props.extra.find("exportSettings");
      if (it != n->props.extra.end() && !it->second.empty()) {
        std::string settings = codec::extraValueToJson("NodeChange", it->second);
        if (settings.size() > 2) {
          w.beginObject().key("guid").string(id.toString()).key("name").string(n->props.name).key("type").string(nodeTypeName(n->props.type));
          w.key("exportSettings").raw(settings).endObject();
        }
      }
    }
    for (Guid c : doc.children(id)) walk(c, depth + 1);
  };
  walk(page, 0);
  w.endArray();
  return setResult(w.take());
}

// ---- Motion (docs/motion.md §7.2, round 8e) ----------------------------------------------------------------------

// engine_motion_render_frame(h, json {root, timeUs, scale, allowPending}): one frame of a timeline root at a time —
// the root's own box (so every frame has the same size) at `scale`, drawn with the motion layer at `timeUs`, as
// engine_export's PNG pixels (u32 width, u32 height, straight RGBA8). The view state is put back afterwards (a Design
// mode export leaves Motion off; a Motion mode one keeps its playhead). E_BUSY as engine_export unless allowPending.
ENG_EXPORT int32_t engine_motion_render_frame(Handle h, Ptr ptr, uint32_t len) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Value v;
  if (!parse(ptr, len, v) || !v.isObject()) return E_DECODE;
  const json::Value* rootV = v.get("root");
  if (!rootV || !rootV->isString()) return E_INVALID;
  bool ok = false;
  Guid root = Guid::parse(rootV->string, &ok);
  if (!ok) return E_INVALID;
  Editor& ed = e->editor;
  const Document& doc = ed.document();
  if (!doc.has(root)) return E_NOT_FOUND;
  int64_t timeUs = 0;
  if (const json::Value* t = v.get("timeUs"); t && t->isNumber()) timeUs = static_cast<int64_t>(std::llround(std::max(0.0, t->number)));
  double scale = 1;
  if (const json::Value* s = v.get("scale"); s && s->isNumber() && s->number > 0) scale = s->number;
  bool allowPending = false;
  if (const json::Value* a = v.get("allowPending"); a && a->isBool()) allowPending = a->boolean;
  exporter::Settings st;
  st.format = exporter::Format::PNG;
  st.constraint = exporter::Constraint::SCALE;
  st.value = scale;
  st.useAbsoluteBounds = true;  // the frame's box, the same every frame
  st.contentsOnly = true;
  // The frame at the time: the motion layer's preview writes, the previous view state put back on every way out.
  struct Restore {
    Editor& ed;
    motion::State prev;
    ~Restore() { ed.setMotion(prev); }
  } restore{ed, ed.motion()};
  motion::State at = restore.prev;
  at.on = true;
  at.root = root;
  at.timeUs = timeUs;
  ed.setMotion(at);
  ed.derivePageOf(root);
  exporter::Target t;
  if (!exporter::resolveTarget(doc, &ed, kNoGuid, root, st, t)) {
    setError("nothing to export: " + root.toString());
    return E_NOT_FOUND;
  }
  exporter::Raster r = exporter::rasterOf(t.bounds, st);
  if (!allowPending && !exporter::ready(doc, &ed, t, r.scale)) return E_BUSY;
  std::string rgba;
  if (!renderExport(e, t.page, root, r, rgba)) return E_UNSUPPORTED;
  if (t.background) flatten(rgba, t.backgroundColor);
  std::string out(8, '\0');
  for (int i = 0; i < 4; i++) {
    out[static_cast<size_t>(i)] = static_cast<char>((static_cast<uint32_t>(r.width) >> (8 * i)) & 0xff);
    out[static_cast<size_t>(4 + i)] = static_cast<char>((static_cast<uint32_t>(r.height) >> (8 * i)) & 0xff);
  }
  out += rgba;
  return setResult(std::move(out));
}
