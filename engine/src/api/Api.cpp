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

#include "base/Json.h"
#include "editor/Editor.h"
#include "gfx/null/NullDevice.h"
#include "hit/HitTest.h"
#include "render/Renderer.h"
#include "scene/CodecJson.h"

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
    uint32_t any = 0;
    for (Engine* e : engines()) any |= e->editor.hasEvents() ? 1u : 0u;
    gEventsFlag = any;
  }
};

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
  w.beginObject();
  w.key("type").string("NODE_CHANGES");
  w.key("sessionID").number(sessionID);
  w.key("nodeChanges");
  codec::writeChanges(w, changes);
  w.endObject();
}

std::vector<NodeChange> readMessage(const json::Value& v) {
  const json::Value* changes = v.isArray() ? &v : v.get("nodeChanges");
  return changes ? codec::readChanges(*changes) : std::vector<NodeChange>{};
}

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
  return e && e->editor.needsFrame() ? 0 : -1;
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
  w.beginObject().key("type").string("NODE_CHANGES").key("sessionID").number(e->editor.sessionID());
  w.key("nodeChanges").beginArray();
  for (Guid id : readRefs(v)) {
    const Node* n = doc.get(id);
    if (!n) continue;
    if (flags & INCLUDE_CHILD_IDS) {
      // writeNode closes the object; build it by hand to add childIds.
      json::Writer one;
      codec::writeNode(one, *n);
      std::string s = one.take();
      s.pop_back();
      json::Writer kids;
      writeIds(kids, doc.children(id));
      s += ",\"childIds\":" + kids.take() + "}";
      w.raw(s);
    } else {
      codec::writeNode(w, *n);
    }
  }
  w.endArray().endObject();
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
  if (!codec::readChange(change, c)) return E_DECODE;
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

// commandId from editor/Commands.h (commands.ts); args JSON ({"dx","dy"} for NUDGE) or empty.
ENG_EXPORT int32_t engine_command(Handle h, uint32_t commandId, Ptr argsPtr, uint32_t argsLen) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  double a = 0, b = 0;
  json::Value args;
  if (argsLen && json::parse(bytes(argsPtr, argsLen), args)) {
    if (auto* x = args.get("dx")) a = x->numberOr(0);
    if (auto* y = args.get("dy")) b = y->numberOr(0);
  }
  return e->editor.command(static_cast<CommandId>(commandId), a, b);
}

ENG_EXPORT uint32_t engine_command_state(Handle h, uint32_t commandId) {
  Call call;
  Engine* e = engineOf(h);
  return e ? e->editor.commandState(static_cast<CommandId>(commandId)) : 0;
}

// ---- Events and diagnostics ------------------------------------------------------

ENG_EXPORT uint32_t engine_has_events(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  return e && e->editor.hasEvents() ? 1 : 0;
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
  w.key("viewport").beginObject().key("width").number(v.width).key("height").number(v.height).key("dpr").number(v.dpr);
  w.key("pixelWidth").number(v.pixelWidth).key("pixelHeight").number(v.pixelHeight).endObject();
  w.endObject();
  return setResult(w.take());
}
