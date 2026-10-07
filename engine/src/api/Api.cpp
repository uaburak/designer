// The engine's binding: a flat C ABI (no embind), numbers and pointers in and
// out, every structured payload through memory (docs/engine.md §10).
//
// Interim (E1): payloads are JSON with the kiwi schema's names — the
// NodeChange/Message shapes of schema/document.kiwi and the event shapes of
// §10.4 — through scene/CodecJson (and src/renderer/src/engine/codec.ts on the
// TS side). When schemagen's codecs exist, only those two files change.
//
// Memory (§10.2): inputs are borrowed for the call; results go to the module's
// result slot (engine_result_ptr/len), valid until the next call that writes
// one; the events flag (engine_events_flag_ptr) is a u32 that is non-zero while
// any engine has events queued, updated at the end of every call.

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "base/DerivedIds.h"
#include "base/Json.h"
#include "editor/Editor.h"
#include "gfx/null/NullDevice.h"
#include "hit/HitTest.h"
#include "render/ImageCache.h"
#include "render/Renderer.h"
#include "scene/CodecJson.h"
#include "text/Fonts.h"
#include "text/TextLayout.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#include <emscripten/html5.h>

#include "gfx/gl/GLDevice.h"
#define ENG_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define ENG_EXPORT extern "C" __attribute__((visibility("default")))
#endif

using namespace eng;

// Pointers and handles: 32-bit in wasm32 (what JS sees), full width natively so
// the native tests can call the same functions.
using Ptr = uintptr_t;
using Handle = uintptr_t;

namespace {

constexpr uint32_t kAbiVersion = 1;
enum TickFlags : uint32_t { TICK_NEEDS_RENDER = 1 };
enum ReadFlags : uint32_t { INCLUDE_CHILD_IDS = 1 };

struct Engine {
  std::string selector;  // empty: headless
  std::unique_ptr<gfx::Device> device;
  std::unique_ptr<Renderer> renderer;
  Editor editor;
  RenderStats stats;
};

// Module state. Trivially constructed (no work before main).
std::vector<Engine*>* gEngines = nullptr;
std::string* gResult = nullptr;
std::string* gError = nullptr;
uint32_t gEventsFlag = 0;

std::vector<Engine*>& engines() {
  if (!gEngines) gEngines = new std::vector<Engine*>();
  return *gEngines;
}
std::string& result() {
  if (!gResult) gResult = new std::string();
  return *gResult;
}
void setError(std::string text) {
  if (!gError) gError = new std::string();
  *gError = std::move(text);
}

// Refreshes the events flag when an export returns.
struct Call {
  ~Call() {
    uint32_t any = (text::FontRegistry::get().hasRequests() || ImageRegistry::get().hasRequests()) && !engines().empty() ? 1u : 0u;
    for (Engine* e : engines()) any |= e->editor.hasEvents() ? 1u : 0u;
    gEventsFlag = any;
  }
};

// A font arrived or went missing: every engine lays its text out again.
void fontsChanged() {
  for (Engine* e : engines()) e->editor.fontsChanged();
}

Engine* engineOf(Handle h) {
  for (Engine* e : engines())
    if (reinterpret_cast<Handle>(e) == h) return e;
  setError("no engine with that handle");
  return nullptr;
}

std::string_view bytes(Ptr ptr, uint32_t len) {
  return ptr && len ? std::string_view(reinterpret_cast<const char*>(ptr), len) : std::string_view();
}

int32_t setResult(std::string s) {
  result() = std::move(s);
  return OK;
}

bool parse(Ptr ptr, uint32_t len, json::Value& v) {
  if (json::parse(bytes(ptr, len), v)) return true;
  setError("the payload is not valid JSON");
  return false;
}

// NodeRefList: {"refs": ["1:2", …]} or a bare array.
std::vector<Guid> readRefs(const json::Value& v) {
  const json::Value* list = v.isArray() ? &v : v.get("refs");
  std::vector<Guid> ids;
  if (!list || !list->isArray()) return ids;
  for (auto& e : list->array) {
    bool ok = false;
    Guid g = e.isString() ? Guid::parse(e.string, &ok) : Guid{};
    if (ok) ids.push_back(g);
  }
  return ids;
}

void writeIds(json::Writer& w, const std::vector<Guid>& ids) {
  w.beginArray();
  for (Guid id : ids) w.string(id.toString());
  w.endArray();
}

void writeMessage(json::Writer& w, uint32_t sessionID, const std::vector<NodeChange>& changes) {
  codec::writeMessage(w, sessionID, changes);
}

std::vector<NodeChange> readMessage(const json::Value& v) { return codec::readMessage(v); }

void writeEvents(json::Writer& w, Engine& e) {
  Editor& ed = e.editor;
  Editor::Events ev = ed.takeEvents();
  std::string page = ed.page() == kNoGuid ? std::string() : ed.page().toString();
  w.beginObject().key("events").beginArray();
  for (auto& d : ev.documents) {
    w.beginObject().key("type").string("DOCUMENT_CHANGED");
    w.key("kind").string(txnKindName(d.kind)).key("label").string(d.label);
    w.key("message");
    writeMessage(w, ed.sessionID(), d.changes);
    w.endObject();
  }
  if (!ev.nodes.empty()) {
    w.beginObject().key("type").string("NODES_CHANGED");
    w.key("refs").beginArray();
    for (auto& [id, g] : ev.nodes) w.string(id.toString());
    w.endArray();
    w.key("fieldGroupMask").beginArray();
    for (auto& [id, g] : ev.nodes) w.number(g);
    w.endArray();
    w.endObject();
  }
  if (ev.structure) w.beginObject().key("type").string("STRUCTURE_CHANGED").key("pageId").string(page).endObject();
  if (ev.pages) w.beginObject().key("type").string("PAGES_CHANGED").key("pageId").string(page).endObject();
  if (ev.currentPage) w.beginObject().key("type").string("CURRENT_PAGE_CHANGED").key("pageId").string(page).endObject();
  if (ev.selection) {
    w.beginObject().key("type").string("SELECTION_CHANGED").key("pageId").string(page).key("refs");
    writeIds(w, ed.selection());
    w.endObject();
  }
  if (ev.camera) {
    const Camera& c = ed.camera();
    w.beginObject().key("type").string("CAMERA_CHANGED");
    w.key("x").number(c.x).key("y").number(c.y).key("zoom").number(c.zoom).endObject();
  }
  if (ev.tool) w.beginObject().key("type").string("TOOL_CHANGED").key("tool").string(toolName(ed.tool())).endObject();
  if (ev.cursor) {
    w.beginObject().key("type").string("CURSOR").key("kind").string(cursorName(ed.cursor()));
    w.key("angleDeg").number(ed.cursorAngle()).endObject();
  }
  if (ev.hover) {
    w.beginObject().key("type").string("HOVER_CHANGED").key("ref");
    if (ed.hover() == kNoGuid) w.null();
    else w.string(ed.hover().toString());
    w.endObject();
  }
  if (ev.undo) {
    const UndoStack& u = ed.undoStack();
    w.beginObject().key("type").string("UNDO_STATE");
    w.key("canUndo").boolean(u.canUndo()).key("canRedo").boolean(u.canRedo());
    w.key("undoLabel").string(u.undoLabel()).key("redoLabel").string(u.redoLabel());
    w.endObject();
  }
  // Fonts the documents asked for (module-wide: whichever engine drains first carries them).
  for (const FontName& f : text::FontRegistry::get().takeRequests())
    w.beginObject().key("type").string("REQUEST_FONT").key("family").string(f.family).key("style").string(f.style).endObject();
  // Images the documents draw that nobody has supplied yet (module-wide, like fonts).
  for (const ImageHash& h : ImageRegistry::get().takeRequests())
    w.beginObject().key("type").string("REQUEST_IMAGE").key("hash").string(h.hex()).endObject();
  if (ev.textEdit) {
    w.beginObject().key("type").string("TEXT_EDIT").key("active").boolean(ed.textEditing()).key("ref");
    if (ed.textEditing()) w.string(ed.textNode().toString());
    else w.null();
    Rect c = ed.caretRectCss();
    w.key("caretRectCss").beginObject().key("x").number(c.x).key("y").number(c.y).key("width").number(c.w).key("height").number(c.h).endObject();
    w.key("selStart").number(ed.textSelStart()).key("selEnd").number(ed.textSelEnd());
    w.endObject();
  }
  if (ev.vectorEdit) {
    static const char* kTools[] = {"MOVE", "PEN", "BEND", "LASSO", "PAINT_BUCKET"};
    w.beginObject().key("type").string("VECTOR_EDIT").key("active").boolean(ed.vectorEditing()).key("ref");
    if (ed.vectorEditing()) w.string(ed.vectorNode().toString());
    else w.null();
    w.key("tool").string(kTools[static_cast<int>(ed.vectorTool())]);
    w.key("selectedVertices").beginArray();
    for (uint32_t v : ed.vectorSelectedVertices()) w.number(v);
    w.endArray().key("selectedSegments").beginArray();
    for (uint32_t s : ed.vectorSelectedSegments()) w.number(s);
    w.endArray();
    w.key("vertexCount").number(static_cast<double>(ed.vectorNetwork().vertices.size()));
    w.key("segmentCount").number(static_cast<double>(ed.vectorNetwork().segments.size()));
    VectorMirror m = VectorMirror::NONE;
    int mirroring = ed.vectorMirroring(m);
    w.key("mirroring");
    if (mirroring == 0) w.null();
    else w.string(mirroring == 2 ? "MIXED" : enumName(m));
    w.key("points").beginArray();
    for (const auto& p : ed.vectorPoints())
      w.beginObject().key("index").number(p.index).key("x").number(p.parent.x).key("y").number(p.parent.y)
          .key("cornerRadius").number(p.cornerRadius).key("mirroring").string(enumName(p.mirroring)).endObject();
    w.endArray();
    w.endObject();
  }
  if (ev.paintEdit) {
    w.beginObject().key("type").string("PAINT_EDIT").key("active").boolean(ed.paintEditing()).key("ref");
    if (ed.paintEditing()) w.string(ed.paintNode().toString());
    else w.null();
    w.key("paints").string(ed.paintStrokes() ? "STROKE" : "FILL").key("index").number(ed.paintIndex());
    w.key("stop").number(ed.paintStop()).endObject();
  }
  if (!ev.components.empty()) {
    std::vector<Guid> refs;
    for (Guid g : ev.components)
      if (std::find(refs.begin(), refs.end(), g) == refs.end()) refs.push_back(g);
    w.beginObject().key("type").string("COMPONENTS_CHANGED").key("refs");
    writeIds(w, refs);
    w.endObject();
  }
  if (ev.navigation) {
    w.beginObject().key("type").string("INSTANCE_NAVIGATION").key("main");
    if (ed.navigationMain() == kNoGuid) w.null();
    else w.string(ed.navigationMain().toString());
    w.key("returnTo");
    if (ed.returnToInstance() == kNoGuid) w.null();
    else w.string(ed.returnToInstance().toString());
    w.endObject();
  }
  // Last: by then the selection the right-click made has been reported.
  for (auto& m : ev.contextMenus) {
    w.beginObject().key("type").string("CONTEXT_MENU");
    w.key("targetKind").string(m.selection ? "SELECTION" : "CANVAS");
    w.key("x").number(m.x).key("y").number(m.y).key("hits").beginArray();
    for (auto& path : m.hits) writeIds(w, path);
    w.endArray().endObject();
  }
  w.endArray().endObject();
}

}  // namespace

// ---- Module -----------------------------------------------------------------

ENG_EXPORT uint32_t engine_abi_version() { return kAbiVersion; }
ENG_EXPORT Ptr engine_alloc(uint32_t len) { return reinterpret_cast<Ptr>(std::malloc(len ? len : 1)); }
ENG_EXPORT void engine_free(Ptr ptr) { std::free(reinterpret_cast<void*>(ptr)); }
ENG_EXPORT Ptr engine_result_ptr() { return reinterpret_cast<Ptr>(result().data()); }
ENG_EXPORT uint32_t engine_result_len() { return static_cast<uint32_t>(result().size()); }
ENG_EXPORT Ptr engine_events_flag_ptr() { return reinterpret_cast<Ptr>(&gEventsFlag); }
ENG_EXPORT int32_t engine_last_error() { return setResult(gError ? *gError : std::string()); }

// ---- Lifecycle and document --------------------------------------------------

// `selector` names the canvas ("#engine-canvas"); 0 = headless (no GPU).
// `opts`: {"sessionID":1,"theme":"DARK"|"LIGHT","devicePixelRatio":2}. Returns 0 on failure.
ENG_EXPORT Handle engine_create(const char* selector, Ptr optsPtr, uint32_t optsLen) {
  Call call;
  auto e = std::make_unique<Engine>();
  if (selector && *selector) {
    e->selector = selector;
#ifdef __EMSCRIPTEN__
    e->device = gfx::createWebGL2Device(selector);
#endif
    if (!e->device) {
      setError("WebGL2 is not available");
      return 0;
    }
  } else {
    e->device = std::make_unique<gfx::NullDevice>();
  }
  e->renderer = std::make_unique<Renderer>(*e->device);
  e->renderer->setTextLayouts(&e->editor);
  json::Value opts;
  if (optsLen && json::parse(bytes(optsPtr, optsLen), opts)) {
    if (auto* s = opts.get("sessionID"); s && s->isNumber()) e->editor.setSessionID(static_cast<uint32_t>(s->number));
    if (auto* t = opts.get("theme"); t && t->isString()) e->editor.setTheme(t->string == "LIGHT" ? Theme::Light : Theme::Dark);
    if (auto* d = opts.get("devicePixelRatio"); d && d->isNumber()) e->editor.setViewport(0, 0, d->number, 0, 0);
  }
  Engine* raw = e.release();
  engines().push_back(raw);
  return reinterpret_cast<Handle>(raw);
}

ENG_EXPORT void engine_destroy(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return;
  auto& all = engines();
  all.erase(std::remove(all.begin(), all.end(), e), all.end());
  delete e;
}

// A Message: {"type":"NODE_CHANGES","sessionID":…,"nodeChanges":[…]} — the whole document.
ENG_EXPORT int32_t engine_load(Handle h, Ptr ptr, uint32_t len) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Value v;
  if (!parse(ptr, len, v)) return E_DECODE;
  Guid page = kNoGuid;
  if (auto* p = v.get("currentPage"); p && p->isString()) page = Guid::parse(p->string);
  e->editor.loadDocument(readMessage(v), page);
  return OK;
}

// flags: APPLY_USER (1, undoable and emitted) | APPLY_REMOTE (2) | APPLY_LOAD (4).
ENG_EXPORT int32_t engine_apply_changes(Handle h, Ptr ptr, uint32_t len, uint32_t flags) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Value v;
  if (!parse(ptr, len, v)) return E_DECODE;
  return e->editor.applyChanges(readMessage(v), flags);
}

ENG_EXPORT int32_t engine_encode_document(Handle h, uint32_t /*flags*/) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Writer w;
  writeMessage(w, e->editor.sessionID(), e->editor.encodeDocument());
  return setResult(w.take());
}

ENG_EXPORT int32_t engine_set_current_page(Handle h, uint32_t sessionID, uint32_t localID) {
  Call call;
  Engine* e = engineOf(h);
  return e ? e->editor.setCurrentPage({sessionID, localID}) : E_HANDLE;
}

// {"pages":[{"guid","name"}…]} (the internal canvas excluded).
ENG_EXPORT int32_t engine_pages(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Writer w;
  w.beginObject().key("pages").beginArray();
  for (Guid p : e->editor.pages()) {
    const Node* n = e->editor.document().get(p);
    w.beginObject().key("guid").string(p.toString()).key("name").string(n->props.name).endObject();
  }
  w.endArray().endObject();
  return setResult(w.take());
}

// ---- View, input, frames -----------------------------------------------------

ENG_EXPORT void engine_set_viewport(Handle h, double cssW, double cssH, double dpr, uint32_t pxW, uint32_t pxH) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return;
  e->editor.setViewport(cssW, cssH, dpr, static_cast<int>(pxW), static_cast<int>(pxH));
#ifdef __EMSCRIPTEN__
  if (!e->selector.empty()) emscripten_set_canvas_element_size(e->selector.c_str(), static_cast<int>(pxW), static_cast<int>(pxH));
#endif
}

ENG_EXPORT void engine_set_camera(Handle h, double x, double y, double zoom) {
  Call call;
  if (Engine* e = engineOf(h)) e->editor.setCamera({x, y, zoom});
}

// {"x","y","zoom"} — the camera now (CAMERA_CHANGED carries the same).
ENG_EXPORT int32_t engine_get_camera(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  const Camera& c = e->editor.camera();
  json::Writer w;
  w.beginObject().key("x").number(c.x).key("y").number(c.y).key("zoom").number(c.zoom).endObject();
  return setResult(w.take());
}

// 0 light, 1 dark.
ENG_EXPORT void engine_set_theme(Handle h, uint32_t theme) {
  Call call;
  if (Engine* e = engineOf(h)) e->editor.setTheme(theme == 0 ? Theme::Light : Theme::Dark);
}

// type DOWN 0 / MOVE 1 / UP 2 / CANCEL 3 / ENTER 4 / LEAVE 5; x,y CSS px in the canvas.
// Returns HANDLED (1) | CAPTURE (2: call setPointerCapture).
ENG_EXPORT uint32_t engine_pointer(Handle h, uint32_t type, double x, double y, uint32_t button, uint32_t buttons, uint32_t mods,
                                   double /*pressure*/, uint32_t clickCount, uint32_t /*pointerType*/, double /*timeMs*/) {
  Call call;
  Engine* e = engineOf(h);
  if (!e || type > 5) return 0;
  return e->editor.pointer(static_cast<PointerEvent>(type), x, y, static_cast<int>(button), buttons, mods, static_cast<int>(clickCount));
}

// deltaMode as WheelEvent's; flags PINCH (1) = ctrlKey from a trackpad.
ENG_EXPORT uint32_t engine_wheel(Handle h, double x, double y, double dx, double dy, uint32_t deltaMode, uint32_t mods, uint32_t flags) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return 0;
  return e->editor.wheel(x, y, dx, dy, static_cast<DeltaMode>(deltaMode > 2 ? 0 : deltaMode), mods, flags);
}

// type DOWN 0 / UP 1; keyCode from editor/Keys.h (keyCodes.ts). Returns HANDLED (1).
ENG_EXPORT uint32_t engine_key(Handle h, uint32_t type, uint32_t keyCode, uint32_t codepoint, uint32_t mods, uint32_t repeat) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return 0;
  KeyCode code = keyCode < static_cast<uint32_t>(KeyCode::Count) ? static_cast<KeyCode>(keyCode) : KeyCode::Unidentified;
  return e->editor.key(type == 1 ? KeyEvent::UP : KeyEvent::DOWN, code, codepoint, mods, repeat != 0);
}

ENG_EXPORT void engine_modifiers(Handle h, uint32_t mods) {
  Call call;
  if (Engine* e = engineOf(h)) e->editor.modifiers(mods);
}

ENG_EXPORT void engine_blur(Handle h) {
  Call call;
  if (Engine* e = engineOf(h)) e->editor.blur();
}

ENG_EXPORT int32_t engine_set_tool(Handle h, uint32_t tool) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  if (tool >= static_cast<uint32_t>(Tool::Count)) return E_INVALID;
  return e->editor.setTool(static_cast<Tool>(tool));
}

ENG_EXPORT void engine_set_hover(Handle h, Ptr ptr, uint32_t len) {
  Call call;
  Engine* e = engineOf(h);
  json::Value v;
  if (e && parse(ptr, len, v)) e->editor.setHover(readRefs(v));
}

ENG_EXPORT uint32_t engine_tick(Handle h, double timeMs) {
  Call call;
  Engine* e = engineOf(h);
  return e && e->editor.tick(timeMs) ? TICK_NEEDS_RENDER : 0;
}

ENG_EXPORT void engine_render(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return;
  Editor& ed = e->editor;
  e->stats = e->renderer->render(ed.document(), ed.page(), ed.camera(), ed.viewport(), ed.overlay(), OverlayStyle::of(ed.theme()));
  ed.rendered();
}

ENG_EXPORT int32_t engine_next_frame_delay(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return -1;
  if (e->editor.needsFrame()) return 0;
  return e->editor.textEditing() ? 265 : -1;  // the caret blinks (530 ms phases)
}

ENG_EXPORT uint32_t engine_needs_frame(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  return e && e->editor.needsFrame() ? 1 : 0;
}

ENG_EXPORT void engine_gl_context_lost(Handle h) {
  Call call;
  (void)engineOf(h);  // nothing to free yet: the device reports lost and draws nothing
}

ENG_EXPORT void engine_gl_context_restored(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  if (!e || e->selector.empty()) return;
#ifdef __EMSCRIPTEN__
  // Every GPU resource is a cache: a new device and renderer rebuild them.
  e->renderer.reset();
  e->device = gfx::createWebGL2Device(e->selector.c_str());
  if (!e->device) e->device = std::make_unique<gfx::NullDevice>();
  e->renderer = std::make_unique<Renderer>(*e->device);
  e->renderer->setTextLayouts(&e->editor);
  e->editor.setViewport(e->editor.viewport().width, e->editor.viewport().height, e->editor.viewport().dpr,
                        e->editor.viewport().pixelWidth, e->editor.viewport().pixelHeight);
#endif
}

// ---- Selection and reads -------------------------------------------------------

// {"pageId":"0:1","refs":[…]}
ENG_EXPORT int32_t engine_get_selection(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Writer w;
  w.beginObject().key("pageId").string(e->editor.page() == kNoGuid ? std::string() : e->editor.page().toString()).key("refs");
  writeIds(w, e->editor.selection());
  w.endObject();
  return setResult(w.take());
}

ENG_EXPORT int32_t engine_set_selection(Handle h, Ptr ptr, uint32_t len) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Value v;
  if (!parse(ptr, len, v)) return E_DECODE;
  return e->editor.setSelection(readRefs(v));
}

// The generic getter: a Message with one NodeChange (every field) per ref that
// exists; INCLUDE_CHILD_IDS (1) adds "childIds" (back to front).
ENG_EXPORT int32_t engine_read_nodes(Handle h, Ptr ptr, uint32_t len, uint32_t flags) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Value v;
  if (!parse(ptr, len, v)) return E_DECODE;
  const Document& doc = e->editor.document();
  json::Writer w;
  codec::BlobsOut blobs;
  w.beginObject().key("type").string("NODE_CHANGES").key("sessionID").number(e->editor.sessionID());
  w.key("nodeChanges").beginArray();
  for (Guid id : readRefs(v)) {
    const Node* n = doc.get(id);
    if (!n) continue;
    if (flags & INCLUDE_CHILD_IDS) {
      // writeNode closes the object; build it by hand to add childIds.
      json::Writer one;
      codec::writeNode(one, *n, &blobs);
      std::string s = one.take();
      s.pop_back();
      json::Writer kids;
      writeIds(kids, doc.children(id));
      s += ",\"childIds\":" + kids.take() + "}";
      w.raw(s);
    } else {
      codec::writeNode(w, *n, &blobs);
    }
  }
  w.endArray();
  blobs.writeMember(w);
  w.endObject();
  return setResult(w.take());
}

// {"refs":[…]}: what is under (x, y) in CSS px, innermost first (locked and hidden left out).
ENG_EXPORT int32_t engine_hit_test(Handle h, double x, double y, uint32_t /*flags*/) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  Editor& ed = e->editor;
  auto path = hitPath(ed.document(), ed.page(), ed.camera().toWorld({x, y}), 1 / ed.camera().zoom);
  std::reverse(path.begin(), path.end());
  json::Writer w;
  w.beginObject().key("refs");
  writeIds(w, path);
  w.endObject();
  return setResult(w.take());
}

// ---- Writes and commands -------------------------------------------------------

// The generic setter: the fields present in `change` (a NodeChange, guid ignored) on each ref.
ENG_EXPORT int32_t engine_set_props(Handle h, Ptr refsPtr, uint32_t refsLen, Ptr changePtr, uint32_t changeLen, uint32_t flags) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Value refs, change;
  if (!parse(refsPtr, refsLen, refs) || !parse(changePtr, changeLen, change)) return E_DECODE;
  if (change.isObject() && !change.get("guid")) {
    json::Value guid;
    guid.kind = json::Value::Kind::String;
    guid.string = "0:0";
    change.object.emplace_back("guid", std::move(guid));
  }
  NodeChange c;
  codec::BlobsIn blobs = codec::readBlobs(change);
  if (!codec::readChange(change, c, &blobs)) return E_DECODE;
  return e->editor.setProps(readRefs(refs), c, flags);
}

ENG_EXPORT int32_t engine_txn_begin(Handle h, Ptr ptr, uint32_t len) {
  Call call;
  Engine* e = engineOf(h);
  return e ? e->editor.txnBegin(std::string(bytes(ptr, len))) : E_HANDLE;
}

ENG_EXPORT int32_t engine_txn_commit(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  return e ? e->editor.txnCommit() : E_HANDLE;
}

ENG_EXPORT void engine_txn_cancel(Handle h) {
  Call call;
  if (Engine* e = engineOf(h)) e->editor.txnCancel();
}

// commandId from editor/Commands.h (commands.ts); args JSON or empty:
// {"dx","dy"} for NUDGE; {"page":"0:3"} for DELETE_PAGE / DUPLICATE_PAGE (also
// {"page":<localID>,"pageSession":<sessionID>} or {"sessionID","localID"}).
ENG_EXPORT int32_t engine_command(Handle h, uint32_t commandId, Ptr argsPtr, uint32_t argsLen) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  CommandArgs a;
  json::Value args;
  if (argsLen && json::parse(bytes(argsPtr, argsLen), args)) {
    if (auto* x = args.get("dx")) a.dx = x->numberOr(0);
    if (auto* y = args.get("dy")) a.dy = y->numberOr(0);
    auto* session = args.get("pageSession");
    if (!session) session = args.get("sessionID");
    if (auto* page = args.get("page")) {
      bool ok = false;
      if (page->isString()) {
        Guid g = Guid::parse(page->string, &ok);
        if (!ok) return E_INVALID;
        a.page = g;
      } else if (page->isNumber()) {
        a.page = {static_cast<uint32_t>(session ? session->numberOr(0) : 0), static_cast<uint32_t>(page->number)};
      } else if (page->isObject()) {
        if (!codec::readGuid(*page, a.page)) return E_INVALID;
      }
    } else if (auto* local = args.get("localID"); local && local->isNumber() && session) {
      a.page = {static_cast<uint32_t>(session->numberOr(0)), static_cast<uint32_t>(local->number)};
    }
    if (auto* m = args.get("mirroring"); m && m->isString()) a.mirroring = m->string;
    if (auto* m = args.get("start"); m && m->isString()) a.start = m->string;
    if (auto* m = args.get("end"); m && m->isString()) a.end = m->string;
    if (auto* m = args.get("x"); m && m->isNumber()) a.x = m->number, a.hasX = true;
    if (auto* m = args.get("y"); m && m->isNumber()) a.y = m->number, a.hasY = true;
    if (auto* m = args.get("cornerRadius"); m && m->isNumber()) a.cornerRadius = m->number, a.hasCornerRadius = true;
    if (auto* m = args.get("width"); m && m->isNumber()) a.width = m->number;
    if (auto* m = args.get("height"); m && m->isNumber()) a.height = m->number;
    if (auto* m = args.get("name"); m && m->isString()) a.name = m->string;
    if (auto* m = args.get("hash"); m && m->isString()) a.hash = ImageHash::fromHex(m->string);
    a.raw = std::move(args);
  }
  return e->editor.command(static_cast<CommandId>(commandId), a);
}

ENG_EXPORT uint32_t engine_command_state(Handle h, uint32_t commandId) {
  Call call;
  Engine* e = engineOf(h);
  return e ? e->editor.commandState(static_cast<CommandId>(commandId)) : 0;
}

// The Layers panel's drag: `refs` to `parent` at `index` in its paint order
// (0 = bottom), counted without them; pages when `parent` is the document.
// Returns how many moved (0 = refused).
ENG_EXPORT int32_t engine_move_nodes(Handle h, Ptr refsPtr, uint32_t refsLen, uint32_t parentSessionID, uint32_t parentLocalID,
                                     uint32_t index) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Value v;
  if (!parse(refsPtr, refsLen, v)) return E_DECODE;
  return static_cast<int32_t>(e->editor.moveNodes(readRefs(v), {parentSessionID, parentLocalID}, index));
}

// The selection as a clipboard Message (docs/schema.md §4.1): the copied nodes
// as CREATED with their source GUIDs, parents first, plus "pastePageId" and
// "clipboardSelectionRegions" [{parent, nodes, enclosingFrameOffset}]. E_NOT_FOUND
// when nothing is selected.
ENG_EXPORT int32_t engine_encode_selection(Handle h, uint32_t /*flags*/) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  Clipboard clip;
  if (!e->editor.copySelection(clip)) return E_NOT_FOUND;
  json::Writer w;
  codec::BlobsOut blobs;
  w.beginObject();
  w.key("type").string("NODE_CHANGES");
  w.key("sessionID").number(e->editor.sessionID());
  w.key("nodeChanges");
  codec::writeChanges(w, clip.nodes, &blobs);
  blobs.writeMember(w);
  w.key("pastePageId").string(clip.page.toString());
  w.key("clipboardSelectionRegions").beginArray();
  for (auto& r : clip.regions) {
    w.beginObject().key("parent").string(r.parent.toString()).key("nodes");
    writeIds(w, r.nodes);
    w.key("enclosingFrameOffset").beginObject().key("x").number(r.offset.x).key("y").number(r.offset.y).endObject();
    w.endObject();
  }
  w.endArray();
  w.endObject();
  return setResult(w.take());
}

// Pastes a clipboard Message with fresh GUIDs. flags: PASTE_IN_PLACE (1) keeps the
// page position. Returns how many top-level layers were pasted (they are selected).
ENG_EXPORT int32_t engine_paste(Handle h, Ptr ptr, uint32_t len, uint32_t flags) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Value v;
  if (!parse(ptr, len, v)) return E_DECODE;
  if (e->editor.busy()) return E_BUSY;
  Clipboard clip;
  clip.nodes = readMessage(v);
  if (auto* p = v.get("pastePageId")) codec::readGuid(*p, clip.page);
  if (auto* regions = v.get("clipboardSelectionRegions"); regions && regions->isArray()) {
    for (auto& r : regions->array) {
      Clipboard::Region region;
      if (auto* parent = r.get("parent"); !parent || !codec::readGuid(*parent, region.parent)) continue;
      if (auto* nodes = r.get("nodes")) region.nodes = readRefs(*nodes);
      if (auto* o = r.get("enclosingFrameOffset"); o && o->isObject()) {
        if (auto* x = o->get("x")) region.offset.x = x->numberOr(0);
        if (auto* y = o->get("y")) region.offset.y = y->numberOr(0);
      }
      clip.regions.push_back(std::move(region));
    }
  }
  return static_cast<int32_t>(e->editor.paste(clip, (flags & PASTE_IN_PLACE) != 0));
}

// A thumbnail of a page: its content (the union of its visible layers' render
// bounds) fitted into maxSize × maxSize device px — the content's own aspect, not
// the canvas's — drawn without overlays into an offscreen target and read back.
// Page (sessionID, localID) = (0xffffffff, 0xffffffff): the current page.
// Result: u32 width, u32 height (little endian), then width × height × 4 bytes of
// straight RGBA8, rows top to bottom. E_NOT_FOUND: no such page, or nothing on it;
// E_UNSUPPORTED: the device can't make the target (context lost).
ENG_EXPORT int32_t engine_render_thumbnail(Handle h, uint32_t pageSessionID, uint32_t pageLocalID, uint32_t maxSize, uint32_t /*flags*/) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  Editor& ed = e->editor;
  const Document& doc = ed.document();
  Guid page{pageSessionID, pageLocalID};
  if (page == kNoGuid) page = ed.page();
  const Node* pn = doc.get(page);
  if (!pn || pn->props.type != NodeType::CANVAS || maxSize == 0) return E_NOT_FOUND;
  bool any = false;
  Rect bounds;
  for (Guid c : doc.children(page)) {
    const Node* n = doc.get(c);
    if (!n || !n->props.visible) continue;
    Rect b = doc.renderBounds(c);
    bounds = any ? bounds.united(b) : b;
    any = true;
  }
  if (!any || !(bounds.w > 0) || !(bounds.h > 0)) return E_NOT_FOUND;
  double limit = std::min<double>(maxSize, e->device->caps().maxTextureSize);
  double zoom = Camera::clampZoom(std::min(limit / bounds.w, limit / bounds.h));
  int width = std::clamp(static_cast<int>(std::lround(bounds.w * zoom)), 1, static_cast<int>(limit));
  int height = std::clamp(static_cast<int>(std::lround(bounds.h * zoom)), 1, static_cast<int>(limit));
  Camera camera{-bounds.x * zoom, -bounds.y * zoom, zoom};
  Viewport viewport{static_cast<double>(width), static_cast<double>(height), 1, width, height};
  Overlay none;
  none.handles = false;
  none.sizeBadge = false;
  gfx::TargetId target = e->device->createTarget(static_cast<uint32_t>(width), static_cast<uint32_t>(height));
  if (!target) return E_UNSUPPORTED;
  e->renderer->render(doc, page, camera, viewport, none, OverlayStyle::of(ed.theme()), target);
  std::string out(8 + static_cast<size_t>(width) * height * 4, '\0');
  for (int i = 0; i < 4; i++) {
    out[static_cast<size_t>(i)] = static_cast<char>((static_cast<uint32_t>(width) >> (8 * i)) & 0xff);
    out[static_cast<size_t>(4 + i)] = static_cast<char>((static_cast<uint32_t>(height) >> (8 * i)) & 0xff);
  }
  auto* px = reinterpret_cast<uint8_t*>(out.data() + 8);
  bool read = e->device->readPixels(target, {0, 0, width, height}, {px, out.size() - 8});
  e->device->destroyTarget(target);
  if (!read) return E_UNSUPPORTED;
  // Premultiplied → straight (the page colour is opaque, so this only matters at transparent edges).
  for (size_t i = 0; i + 3 < out.size() - 8; i += 4) {
    uint8_t a = px[i + 3];
    if (a == 0 || a == 255) continue;
    for (int c = 0; c < 3; c++) px[i + c] = static_cast<uint8_t>(std::min(255, (px[i + c] * 255 + a / 2) / a));
  }
  return setResult(std::move(out));
}

// ---- Events and diagnostics ------------------------------------------------------

ENG_EXPORT uint32_t engine_has_events(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  return e && (e->editor.hasEvents() || text::FontRegistry::get().hasRequests() || ImageRegistry::get().hasRequests()) ? 1 : 0;
}

// {"events":[{"type":"SELECTION_CHANGED",…}, …]} (docs/engine.md §10.4), draining the queue.
ENG_EXPORT int32_t engine_take_events(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Writer w;
  writeEvents(w, *e);
  return setResult(w.take());
}

// {"nodes","shapes","drawCalls","viewport":{…}}: the last frame and the view it was drawn for.
ENG_EXPORT int32_t engine_stats(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  const Viewport& v = e->editor.viewport();
  json::Writer w;
  w.beginObject().key("nodes").number(static_cast<double>(e->editor.document().size()));
  w.key("shapes").number(e->stats.shapes).key("drawCalls").number(e->stats.drawCalls);
  w.key("glyphs").number(e->stats.glyphs).key("paths").number(e->stats.paths).key("layers").number(e->stats.layers);
  w.key("curveTexels").number(e->renderer->curveCache().texelCount());
  w.key("images").number(static_cast<double>(e->renderer->imageCache().count()));
  w.key("imageBytes").number(static_cast<double>(e->renderer->imageCache().bytes()));
  w.key("viewport").beginObject().key("width").number(v.width).key("height").number(v.height).key("dpr").number(v.dpr);
  w.key("pixelWidth").number(v.pixelWidth).key("pixelHeight").number(v.pixelHeight).endObject();
  w.endObject();
  return setResult(w.take());
}

// ---- Fonts (docs/engine.md §7.1) ------------------------------------------------------

// Takes an engine_alloc'd font file (TTF/OTF; TTC/OTC with `faceIndex`): the engine frees it.
// Returns the face id (≥ 0), or E_DECODE when it isn't a font.
ENG_EXPORT int32_t engine_font_add_take(Ptr ptr, uint32_t len, uint32_t faceIndex) {
  Call call;
  int32_t id = text::FontRegistry::get().addFace(reinterpret_cast<uint8_t*>(ptr), len, faceIndex);
  if (id < 0) setError("not a font file");
  return id < 0 ? E_DECODE : id;
}

// `faceId` answers the FontName {family, style} (UTF-8 strings): its named instance (or the
// weight/italic axes) for that style. Text using it is laid out again.
ENG_EXPORT int32_t engine_font_bind(Ptr familyPtr, uint32_t familyLen, Ptr stylePtr, uint32_t styleLen, int32_t faceId) {
  Call call;
  if (!text::FontRegistry::get().bind(std::string(bytes(familyPtr, familyLen)), std::string(bytes(stylePtr, styleLen)), faceId))
    return E_NOT_FOUND;
  fontsChanged();
  return OK;
}

// Nobody has {family, style}: its text draws with Inter and is marked missing.
ENG_EXPORT void engine_font_missing(Ptr familyPtr, uint32_t familyLen, Ptr stylePtr, uint32_t styleLen) {
  Call call;
  text::FontRegistry::get().markMissing(std::string(bytes(familyPtr, familyLen)), std::string(bytes(stylePtr, styleLen)));
  fontsChanged();
}

// ["Apple Color Emoji", "PingFang SC", …]: tried in order for characters a text's font lacks.
ENG_EXPORT int32_t engine_set_fallback_fonts(Ptr ptr, uint32_t len) {
  Call call;
  json::Value v;
  if (!parse(ptr, len, v) || !v.isArray()) return E_DECODE;
  std::vector<std::string> families;
  for (auto& f : v.array)
    if (f.isString()) families.push_back(f.string);
  text::FontRegistry::get().setFallbacks(std::move(families));
  fontsChanged();
  return OK;
}

// ---- Vector edit mode, gradient handles (docs/engine-build.md "E4 + E5 API") ---------------------

// Edits a node's vector network (VECTOR, LINE, rectangles, ellipses, stars, polygons). E_UNSUPPORTED for others.
ENG_EXPORT int32_t engine_vector_edit(Handle h, uint32_t sessionID, uint32_t localID) {
  Call call;
  Engine* e = engineOf(h);
  return e ? e->editor.startVectorEdit({sessionID, localID}) : E_HANDLE;
}

ENG_EXPORT void engine_vector_edit_end(Handle h) {
  Call call;
  if (Engine* e = engineOf(h)) e->editor.endVectorEdit();
}

// tool: MOVE 0, PEN 1, BEND 2, LASSO 3, PAINT_BUCKET 4.
ENG_EXPORT int32_t engine_vector_edit_tool(Handle h, uint32_t tool) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  if (tool > 4) return E_INVALID;
  return e->editor.setVectorTool(static_cast<Editor::VectorTool>(tool));
}

// {"start":"NONE","end":"ARROW_LINES"} for a node with an open path; E_NOT_FOUND otherwise.
ENG_EXPORT int32_t engine_end_caps(Handle h, uint32_t sessionID, uint32_t localID) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  StrokeCap a = StrokeCap::NONE, b = StrokeCap::NONE;
  if (!e->editor.endCaps({sessionID, localID}, a, b)) return E_NOT_FOUND;
  json::Writer w;
  w.beginObject().key("start").string(enumName(a)).key("end").string(enumName(b)).endObject();
  return setResult(w.take());
}

// paints: 0 fills, 1 strokes; the paint at `index` must be a gradient.
ENG_EXPORT int32_t engine_paint_edit(Handle h, uint32_t sessionID, uint32_t localID, uint32_t paints, uint32_t index) {
  Call call;
  Engine* e = engineOf(h);
  return e ? e->editor.startPaintEdit({sessionID, localID}, paints == 1, index) : E_HANDLE;
}

ENG_EXPORT void engine_paint_edit_end(Handle h) {
  Call call;
  if (Engine* e = engineOf(h)) e->editor.endPaintEdit();
}

ENG_EXPORT int32_t engine_paint_edit_stop(Handle h, uint32_t index) {
  Call call;
  Engine* e = engineOf(h);
  return e ? e->editor.setPaintStop(static_cast<int>(index)) : E_HANDLE;
}

// ---- Images (docs/engine.md §6.6) ----------------------------------------------------------

namespace {

bool readHash(Ptr ptr, ImageHash& out) {
  bool ok = false;
  out = ImageHash::fromHex(bytes(ptr, 40), &ok);
  if (!ok) setError("not an image hash (40 hex digits)");
  return ok;
}

// An image arrived or failed: every engine draws again.
void imagesChanged() {
  for (Engine* e : engines()) e->editor.invalidateCanvas();
}

}  // namespace

// The image `hash` (40 hex digits, UTF-8) is the JavaScript ImageBitmap Module.engineBitmaps[bitmapId]
// (decoded premultiplied, width × height): the GL backend uploads it with texImage2D.
ENG_EXPORT int32_t engine_image_add_bitmap(Ptr hashPtr, uint32_t bitmapId, uint32_t width, uint32_t height) {
  Call call;
  ImageHash h;
  if (!readHash(hashPtr, h)) return E_INVALID;
  if (!width || !height || !bitmapId) return E_INVALID;
  ImageRegistry::get().addBitmap(h, bitmapId, width, height);
  imagesChanged();
  return OK;
}

// The image `hash` as premultiplied RGBA8 pixels (width × height × 4 bytes, copied): headless and Node.
ENG_EXPORT int32_t engine_image_add_rgba(Ptr hashPtr, uint32_t width, uint32_t height, Ptr ptr, uint32_t len) {
  Call call;
  ImageHash h;
  if (!readHash(hashPtr, h)) return E_INVALID;
  if (!width || !height || static_cast<uint64_t>(len) < static_cast<uint64_t>(width) * height * 4) return E_INVALID;
  const auto* p = reinterpret_cast<const uint8_t*>(ptr);
  ImageRegistry::get().addRgba(h, width, height, std::make_shared<std::vector<uint8_t>>(p, p + static_cast<size_t>(width) * height * 4));
  imagesChanged();
  return OK;
}

// Nobody has the image `hash`: its paints draw Figma's grey placeholder.
ENG_EXPORT int32_t engine_image_failed(Ptr hashPtr) {
  Call call;
  ImageHash h;
  if (!readHash(hashPtr, h)) return E_INVALID;
  ImageRegistry::get().fail(h);
  imagesChanged();
  return OK;
}

// ---- Text (docs/engine.md §7.6) ----------------------------------------------------------

// Starts editing a TEXT node. flags: 1 = select all its text (else the caret at the end).
// E_INVALID for anything else or a locked layer; E_UNSUPPORTED when its font is missing.
ENG_EXPORT int32_t engine_text_edit(Handle h, uint32_t sessionID, uint32_t localID, uint32_t flags) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  if (e->editor.busy()) return E_BUSY;
  return e->editor.startTextEdit({sessionID, localID}, (flags & 1) != 0);
}

// Leaves text editing (Esc / a click away do the same); an empty text is deleted.
ENG_EXPORT void engine_text_edit_end(Handle h) {
  Call call;
  if (Engine* e = engineOf(h)) e->editor.endTextEdit();
}

// Typed text (UTF-8) replacing the selection (and ending a composition).
ENG_EXPORT int32_t engine_text_input(Handle h, Ptr ptr, uint32_t len) {
  Call call;
  Engine* e = engineOf(h);
  return e ? e->editor.textInput(bytes(ptr, len)) : E_HANDLE;
}

// IME: the composition so far (drawn in the text, not final) and its selection in UTF-16 units.
ENG_EXPORT int32_t engine_text_composition(Handle h, Ptr ptr, uint32_t len, uint32_t selStart, uint32_t selEnd) {
  Call call;
  Engine* e = engineOf(h);
  return e ? e->editor.textComposition(bytes(ptr, len), selStart, selEnd) : E_HANDLE;
}

ENG_EXPORT int32_t engine_text_composition_end(Handle h, Ptr ptr, uint32_t len) {
  Call call;
  Engine* e = engineOf(h);
  return e ? e->editor.textCompositionEnd(bytes(ptr, len)) : E_HANDLE;
}

// Result: the selected text (UTF-8) of the text being edited (empty when none).
ENG_EXPORT int32_t engine_text_selection(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  return setResult(e->editor.textSelection());
}

// Result: a TEXT node's layout as DerivedTextData (schema/document.kiwi): layoutSize,
// baselines, glyphs (position, fontSize, firstCharacter, advance in em), decorations,
// truncationStartIndex / truncatedHeight, plus "missingFont" / "pendingFont" and the
// characters' UTF-16 caret x positions ("logicalIndexToCharacterOffsetMap").
ENG_EXPORT int32_t engine_text_layout(Handle h, uint32_t sessionID, uint32_t localID) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  const text::TextLayout* L = e->editor.textLayout({sessionID, localID});
  if (!L) return E_NOT_FOUND;
  json::Writer w;
  w.beginObject();
  w.key("layoutSize").beginObject().key("x").number(L->size.x).key("y").number(L->size.y).endObject();
  w.key("baselines").beginArray();
  for (const text::LaidLine& l : L->lines) {
    w.beginObject();
    w.key("position").beginObject().key("x").number(l.x).key("y").number(l.baseline).endObject();
    w.key("width").number(l.width).key("lineY").number(l.top).key("lineHeight").number(l.height);
    w.key("lineAscent").number(l.ascent).key("firstCharacter").number(l.start).key("endCharacter").number(l.end);
    w.endObject();
  }
  w.endArray();
  w.key("glyphs").beginArray();
  for (const text::LaidGlyph& g : L->glyphs) {
    w.beginObject();
    w.key("position").beginObject().key("x").number(g.x).key("y").number(g.y).endObject();
    w.key("fontSize").number(g.size).key("firstCharacter").number(g.cluster).key("advance").number(g.size > 0 ? g.advance / g.size : 0);
    w.key("glyphID").number(g.glyph);
    if (L->styles[g.style].styleID) w.key("styleID").number(L->styles[g.style].styleID);
    w.endObject();
  }
  w.endArray();
  w.key("decorations").beginArray();
  for (const text::Decoration& d : L->decorations) {
    w.beginObject().key("rects").beginArray().beginObject();
    w.key("x").number(d.rect.x).key("y").number(d.rect.y).key("w").number(d.rect.w).key("h").number(d.rect.h);
    w.endObject().endArray().key("styleID").number(L->styles[d.style].styleID).endObject();
  }
  w.endArray();
  w.key("truncationStartIndex").number(L->truncated ? static_cast<double>(L->truncationStart) : -1);
  w.key("truncatedHeight").number(L->truncated ? L->size.y : -1);
  w.key("logicalIndexToCharacterOffsetMap").beginArray();
  for (double x : L->caretXs) w.number(x);
  w.endArray();
  w.key("missingFont").boolean(L->missingFont).key("pendingFont").boolean(L->pendingFont);
  w.endObject();
  return setResult(w.take());
}

// ---- Components and instances (docs/engine-build.md "E6") ----------------------------------------

namespace {

void writePropValue(json::Writer& w, ComponentPropType type, const ComponentPropValue& v, const std::string& variant) {
  switch (type) {
    case ComponentPropType::BOOL:
      if (v.hasBool) w.boolean(v.boolValue);
      else w.null();
      return;
    case ComponentPropType::TEXT:
      if (v.hasText) w.string(v.textValue.characters);
      else w.null();
      return;
    case ComponentPropType::VARIANT: w.string(variant); return;
    default:
      if (v.guidValue != kNoGuid) w.string(v.guidValue.toString());
      else w.null();
  }
}

void writeProperties(json::Writer& w, const std::vector<ComponentProperty>& props) {
  w.beginArray();
  for (const ComponentProperty& p : props) {
    w.beginObject();
    w.key("id").string(p.id.toString()).key("name").string(p.name);
    w.key("apiName").string(p.type == ComponentPropType::VARIANT ? p.name : p.name + "#" + p.id.toString());
    w.key("type").string(enumName(p.type));
    w.key("defaultValue");
    writePropValue(w, p.type, p.defaultValue, p.defaultVariant);
    w.key("value");
    writePropValue(w, p.type, p.value, p.variantValue);
    w.key("overridden").boolean(p.overridden);
    w.key("preferredValues");
    writeIds(w, p.preferredValues);
    w.key("variantOptions").beginArray();
    for (auto& o : p.variantOptions) w.string(o);
    w.endArray();
    w.key("boundLayers");
    writeIds(w, p.boundLayers);
    w.endObject();
  }
  w.endArray();
}

const char* kindName(ComponentInfo::Kind k) {
  switch (k) {
    case ComponentInfo::Kind::COMPONENT: return "COMPONENT";
    case ComponentInfo::Kind::VARIANT: return "VARIANT";
    case ComponentInfo::Kind::COMPONENT_SET: return "COMPONENT_SET";
    case ComponentInfo::Kind::INSTANCE: return "INSTANCE";
    case ComponentInfo::Kind::NESTED_INSTANCE: return "NESTED_INSTANCE";
    case ComponentInfo::Kind::INSTANCE_SUBLAYER: return "INSTANCE_SUBLAYER";
    case ComponentInfo::Kind::COMPONENT_SUBLAYER: return "COMPONENT_SUBLAYER";
    default: return "NONE";
  }
}

}  // namespace

// A ref string ("s:l" or a derived "I…;…") → the local id of its Guid in the derived session
// (0xFFFFFFFE), for the calls that take (sessionID, localID). 0 when it isn't a derived ref.
ENG_EXPORT uint32_t engine_ref_id(Ptr ptr, uint32_t len) {
  Call call;
  bool ok = false;
  Guid g = Guid::parse(bytes(ptr, len), &ok);
  return ok && g.isDerived() ? g.localID : 0;
}

// Result: ComponentInfo JSON for a ref (UTF-8 string); E_NOT_FOUND when there is no such node.
ENG_EXPORT int32_t engine_component_info(Handle h, Ptr refPtr, uint32_t refLen) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  bool ok = false;
  Guid id = Guid::parse(bytes(refPtr, refLen), &ok);
  ComponentInfo info;
  if (!ok || !e->editor.componentInfo(id, info)) return E_NOT_FOUND;
  json::Writer w;
  w.beginObject();
  w.key("ref").string(info.ref.toString()).key("kind").string(kindName(info.kind));
  w.key("main");
  if (info.main == kNoGuid) {
    w.null();
  } else {
    w.beginObject().key("ref").string(info.main.toString()).key("name").string(info.mainName).key("page");
    if (info.mainPage == kNoGuid) w.null();
    else w.string(info.mainPage.toString());
    w.key("set");
    if (info.mainSet == kNoGuid) w.null();
    else w.string(info.mainSet.toString());
    w.key("softDeleted").boolean(info.mainSoftDeleted).endObject();
  }
  w.key("instance");
  if (info.instance == kNoGuid) w.null();
  else w.string(info.instance.toString());
  w.key("path");
  writeIds(w, info.path);
  w.key("overrides").beginArray();
  for (auto& o : info.overrides) {
    w.beginObject().key("ref").string(o.ref.toString()).key("fields").beginArray();
    for (auto& f : o.fields) w.string(f);
    w.endArray().endObject();
  }
  w.endArray();
  w.key("properties");
  writeProperties(w, info.properties);
  w.key("exposedInstances").beginArray();
  for (auto& x : info.exposedInstances) {
    w.beginObject().key("ref").string(x.ref.toString()).key("name").string(x.name).key("properties");
    writeProperties(w, x.properties);
    w.endObject();
  }
  w.endArray();
  w.key("variantProperties");
  if (!info.hasVariantProperties) {
    w.null();
  } else {
    w.beginObject();
    for (auto& [k, v] : info.variantProperties) w.key(k).string(v);
    w.endObject();
  }
  w.key("canPush").boolean(info.canPush).key("canReset").boolean(info.canReset).key("canDetach").boolean(info.canDetach);
  w.key("isExposed").boolean(info.isExposed).key("mainDeleted").boolean(info.mainDeleted);
  w.key("instanceCount").number(info.instanceCount);
  w.endObject();
  return setResult(w.take());
}

// A thumbnail of one node (its subtree alone, transparent around it) fitted into maxSize × maxSize device px; the
// same result layout as engine_render_thumbnail. For the Assets panel's grid.
ENG_EXPORT int32_t engine_render_node_thumbnail(Handle h, Ptr refPtr, uint32_t refLen, uint32_t maxSize, uint32_t /*flags*/) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  Editor& ed = e->editor;
  const Document& doc = ed.document();
  bool ok = false;
  Guid id = Guid::parse(bytes(refPtr, refLen), &ok);
  const Node* n = ok ? doc.get(id) : nullptr;
  Guid page = n ? doc.pageOf(id) : kNoGuid;
  if (!n || page == kNoGuid || maxSize == 0) return E_NOT_FOUND;
  Rect bounds = doc.renderBounds(id);
  if (!(bounds.w > 0) || !(bounds.h > 0)) return E_NOT_FOUND;
  double limit = std::min<double>(maxSize, e->device->caps().maxTextureSize);
  double zoom = Camera::clampZoom(std::min(limit / bounds.w, limit / bounds.h));
  int width = std::clamp(static_cast<int>(std::lround(bounds.w * zoom)), 1, static_cast<int>(limit));
  int height = std::clamp(static_cast<int>(std::lround(bounds.h * zoom)), 1, static_cast<int>(limit));
  Camera camera{-bounds.x * zoom, -bounds.y * zoom, zoom};
  Viewport viewport{static_cast<double>(width), static_cast<double>(height), 1, width, height};
  Overlay none;
  none.handles = false;
  none.sizeBadge = false;
  none.frameTitles = false;
  gfx::TargetId target = e->device->createTarget(static_cast<uint32_t>(width), static_cast<uint32_t>(height));
  if (!target) return E_UNSUPPORTED;
  e->renderer->render(doc, page, camera, viewport, none, OverlayStyle::of(ed.theme()), target, id);
  std::string out(8 + static_cast<size_t>(width) * height * 4, '\0');
  for (int i = 0; i < 4; i++) {
    out[static_cast<size_t>(i)] = static_cast<char>((static_cast<uint32_t>(width) >> (8 * i)) & 0xff);
    out[static_cast<size_t>(4 + i)] = static_cast<char>((static_cast<uint32_t>(height) >> (8 * i)) & 0xff);
  }
  auto* px = reinterpret_cast<uint8_t*>(out.data() + 8);
  bool read = e->device->readPixels(target, {0, 0, width, height}, {px, out.size() - 8});
  e->device->destroyTarget(target);
  if (!read) return E_UNSUPPORTED;
  for (size_t i = 0; i + 3 < out.size() - 8; i += 4) {
    uint8_t a = px[i + 3];
    if (a == 0 || a == 255) continue;
    for (int c = 0; c < 3; c++) px[i + c] = static_cast<uint8_t>(std::min(255, (px[i + c] * 255 + a / 2) / a));
  }
  return setResult(std::move(out));
}
