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
#include <unordered_set>
#include <vector>

#include "base/DerivedIds.h"
#include "base/Json.h"
#include "editor/Editor.h"
#include "export/Export.h"
#include "export/PdfWriter.h"
#include "export/SvgWriter.h"
#include "gfx/null/NullDevice.h"
#include "hit/HitTest.h"
#include "proto/Player.h"
#include "render/ImageCache.h"
#include "render/Renderer.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"
#include "schema/facet_readers.h"
#include "text/DerivedText.h"
#include "text/Fonts.h"
#include "text/TextLayout.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#include <emscripten/html5.h>

#include "gfx/Backend.h"
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
// engine_read_nodes: INCLUDE_CHILD_IDS adds "childIds"; READ_SUBTREE follows each ref with its descendants (pre-order,
// children back to front); READ_VISIBLE_ONLY leaves hidden layers and what is under them out of those subtrees.
enum ReadFlags : uint32_t { INCLUDE_CHILD_IDS = 1, READ_SUBTREE = 2, READ_VISIBLE_ONLY = 4 };

// What the engine's structured outputs are encoded as (docs/engine-build.md "Figma parity round 3"): the interim JSON
// (the default during the transition) or kiwi Messages. Inputs are detected by their first byte either way.
enum WireFormat : uint32_t { WIRE_JSON = 0, WIRE_KIWI = 1 };
// engine_encode_document flags.
enum EncodeFlags : uint32_t { ENCODE_DERIVED = 1 };

struct Engine {
  std::string selector;  // empty: headless
  std::unique_ptr<gfx::Device> device;
  bool webgpu = false;  // the canvas's backend: WebGPU (else WebGL2), gfx/Backend.h
  std::unique_ptr<Renderer> renderer;
  Editor editor;
  RenderStats stats;
  WireFormat wire = WIRE_JSON;
  // Binary payloads a JSON result refers to by index (engine_attachment): the Messages of DOCUMENT_CHANGED events,
  // library payloads. Replaced by the next call that produces attachments.
  std::vector<std::string> attachments;
  // The presentation view (engine_present_*): while it runs, frames are its scene and input goes to it.
  std::unique_ptr<proto::Player> player;
  bool presenting() const { return player && player->active(); }
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

// Fonts arrived or went missing since the last relayout (engine_font_bind / _missing / set_fallback_fonts). The
// relayout they cause waits for the next call that can observe it (any export but the font ones and the frame
// queries), so a burst of fonts — the dozens a file asks for at open — costs one relayout, not one each.
bool gFontsDirty = false;

// A font arrived or went missing: every engine lays its text out again.
void fontsChanged() {
  gFontsDirty = false;
  for (Engine* e : engines()) e->editor.fontsChanged();
}

// Every export: catches up with fonts first (unless `observes` is false), refreshes the events flag on return.
struct Call {
  explicit Call(bool observes = true) {
    if (observes && gFontsDirty) fontsChanged();
  }
  ~Call() {
    uint32_t any = (text::FontRegistry::get().hasRequests() || ImageRegistry::get().hasRequests()) && !engines().empty() ? 1u : 0u;
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
  codec::writeMessage(w, sessionID, changes);
}

// A Message payload in either encoding: kiwi (the store's bytes) or the interim JSON. False (E_DECODE) when it is
// neither; `v` holds the parsed JSON when it was JSON (the clipboard and load read their extras from it).
bool readAnyMessage(Ptr ptr, uint32_t len, codec::KiwiMessage& out, json::Value* v = nullptr, codec::DerivedSink* derived = nullptr) {
  std::string_view in = bytes(ptr, len);
  if (codec::looksKiwi(in)) {
    if (codec::readMessage(in, out, derived)) return true;
    setError("the payload is not a valid kiwi Message");
    return false;
  }
  json::Value local;
  json::Value& j = v ? *v : local;
  if (!parse(ptr, len, j)) return false;
  out = codec::KiwiMessage{};
  out.changes = codec::readMessage(j);
  if (auto* s = j.get("sessionID"); s && s->isNumber()) out.sessionID = static_cast<uint32_t>(s->number);
  return true;
}

void writeEvents(json::Writer& w, Engine& e) {
  Editor& ed = e.editor;
  Editor::Events ev = ed.takeEvents();
  std::string page = ed.page() == kNoGuid ? std::string() : ed.page().toString();
  w.beginObject().key("events").beginArray();
  e.attachments.clear();
  for (auto& d : ev.documents) {
    w.beginObject().key("type").string("DOCUMENT_CHANGED");
    w.key("kind").string(txnKindName(d.kind)).key("label").string(d.label);
    // The Message as kiwi bytes (what the store journals as it is), fetched with engine_attachment(payload) —
    // whatever the wire format; the JSON wire also carries it as JSON (`message`).
    w.key("payload").number(static_cast<double>(e.attachments.size()));
    e.attachments.push_back(codec::writeMessage(ed.sessionID(), d.changes));
    if (e.wire == WIRE_JSON) {
      w.key("message");
      writeMessage(w, ed.sessionID(), d.changes);
    }
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
  if (ev.structure) {
    // `parents`: whose child lists changed (a Layers tree patches those); null when the engine can't say.
    w.beginObject().key("type").string("STRUCTURE_CHANGED").key("pageId").string(page).key("parents");
    if (ev.structureAll) w.null();
    else writeIds(w, ev.structureParents);
    w.endObject();
  }
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
  // maxDevicePx: the largest the image has been drawn at (0 unknown); thumbnailHash: the low-res tier the file carries.
  for (const ImageRegistry::Request& r : ImageRegistry::get().takeRequests()) {
    w.beginObject().key("type").string("REQUEST_IMAGE").key("hash").string(r.hash.hex()).key("maxDevicePx").number(r.maxDevicePx);
    if (r.thumbnail.present) w.key("thumbnailHash").string(r.thumbnail.hex());
    w.endObject();
  }
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
  auto unique = [](const std::vector<Guid>& list) {
    std::vector<Guid> out;
    for (Guid g : list)
      if (g != kNoGuid && std::find(out.begin(), out.end(), g) == out.end()) out.push_back(g);
    return out;
  };
  if (!ev.collections.empty() || !ev.variables.empty()) {
    w.beginObject().key("type").string("VARIABLES_CHANGED").key("collections");
    writeIds(w, unique(ev.collections));
    w.key("variables");
    writeIds(w, unique(ev.variables));
    w.endObject();
  }
  if (!ev.styles.empty()) {
    w.beginObject().key("type").string("STYLES_CHANGED").key("styles");
    writeIds(w, unique(ev.styles));
    w.endObject();
  }
  for (auto& pc : ev.prototypeConnected) {
    w.beginObject().key("type").string("PROTOTYPE_CONNECTED").key("refs");
    writeIds(w, pc.nodes);
    w.key("interaction");
    if (pc.interaction == kNoGuid) w.null();
    else w.string(pc.interaction.toString());
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
// `opts`: {"sessionID":1,"theme":"DARK"|"LIGHT","devicePixelRatio":2,"gfx":"webgpu"|"webgl2"}. Returns 0 on failure.
// "gfx": the backend TypeScript chose (src/renderer/src/engine/gfx.ts); WebGPU needs Module.engineGpuDevice.
ENG_EXPORT Handle engine_create(const char* selector, Ptr optsPtr, uint32_t optsLen) {
  Call call;
  auto e = std::make_unique<Engine>();
  json::Value opts;
  bool hasOpts = optsLen && json::parse(bytes(optsPtr, optsLen), opts);
  if (selector && *selector) {
    e->selector = selector;
#ifdef __EMSCRIPTEN__
    const json::Value* gfxOpt = hasOpts ? opts.get("gfx") : nullptr;
    bool webgpu = gfxOpt && gfxOpt->isString() && gfxOpt->string == "webgpu";
    e->device = gfx::createCanvasDevice(selector, webgpu ? gfx::Backend::WebGPU : gfx::Backend::WebGL2);
    e->webgpu = e->device && std::string_view(e->device->backend()) == "webgpu";
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
  // A canvas keeps its page's pixels between frames (the content cache, docs/engine.md §6.9).
  e->renderer->setContentCache(!e->selector.empty());
  if (hasOpts) {
    if (auto* s = opts.get("sessionID"); s && s->isNumber()) e->editor.setSessionID(static_cast<uint32_t>(s->number));
    if (auto* t = opts.get("theme"); t && t->isString()) e->editor.setTheme(t->string == "LIGHT" ? Theme::Light : Theme::Dark);
    if (auto* d = opts.get("devicePixelRatio"); d && d->isNumber()) e->editor.setViewport(0, 0, d->number, 0, 0);
    if (auto* wire = opts.get("wire"); wire && wire->isString() && wire->string == "kiwi") e->wire = WIRE_KIWI;
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

// The whole document as a Message — the store's snapshot bytes (kiwi), or the interim JSON
// {"type":"NODE_CHANGES","sessionID":…,"nodeChanges":[…]} — and the page to show first ((0xffffffff, 0xffffffff): the
// first page; JSON may name it as "currentPage"). Only that page is derived (docs/engine.md §3.4).
// What a snapshot stores as derived data, as it is read (blob indices resolve once the Message is read).
struct DerivedCollector : codec::DerivedSink {
  std::vector<std::pair<Guid, std::vector<codec::DerivedSymbolEntry>>> symbols;
  std::vector<std::pair<Guid, std::string>> texts;
  void symbolData(Guid instance, std::vector<codec::DerivedSymbolEntry>&& entries) override {
    symbols.emplace_back(instance, std::move(entries));
  }
  void textData(Guid node, codec::DerivedTextEntry&& entry) override { texts.emplace_back(node, std::move(entry.bytes)); }
  // Into the editor's form, outlines interned (text/DerivedText).
  Editor::StoredDerived take(const std::vector<Bytes>& blobs) {
    Editor::StoredDerived out;
    auto text = [&](const std::string& fields) -> std::shared_ptr<const text::StoredText> {
      auto s = std::make_shared<text::StoredText>();
      if (!text::readStoredText(fields, blobs, *s)) return nullptr;
      return s;
    };
    for (auto& [id, fields] : texts)
      if (auto s = text(fields)) out.texts[id] = std::move(s);
    for (auto& [id, entries] : symbols) {
      std::vector<Editor::StoredRow> rows;
      rows.reserve(entries.size());
      for (auto& e : entries) {
        Editor::StoredRow r;
        r.path = std::move(e.path);
        r.hasSize = e.hasSize;
        r.hasTransform = e.hasTransform;
        r.size = e.size;
        r.transform = e.transform;
        if (!e.text.empty()) r.text = text(e.text);
        rows.push_back(std::move(r));
      }
      out.symbols[id] = std::move(rows);
    }
    return out;
  }
};

ENG_EXPORT int32_t engine_load_at(Handle h, Ptr ptr, uint32_t len, uint32_t pageSessionID, uint32_t pageLocalID) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  codec::KiwiMessage m;
  DerivedCollector derived;
  std::string_view in = bytes(ptr, len);
  // Documents come as kiwi only (the store's snapshot bytes; TS encodes anything else with the shared codec).
  if (!codec::looksKiwi(in)) {
    setError("engine_load takes a kiwi Message (schema/document.kiwi), not JSON");
    return E_DECODE;
  }
  if (!codec::readMessage(in, m, &derived)) {
    setError("the payload is not a valid kiwi Message");
    return E_DECODE;
  }
  Guid page{pageSessionID, pageLocalID};
  // Derived data is trusted only when this engine wrote it (docs/schema.md §1.3: a reader ignores another stamp's), or
  // when it is Figma's own, kept by a .fig import (Figma's layout is the one to match).
  if (m.derivedDataVersion == Editor::kDerivedDataVersion || m.derivedDataVersion == Editor::kFigmaDerivedDataVersion) {
    Editor::StoredDerived stored = derived.take(m.blobs);
    stored.sparse = m.derivedDataVersion == Editor::kFigmaDerivedDataVersion;
    e->editor.loadDocument(std::move(m.changes), page, &stored);
  } else {
    e->editor.loadDocument(std::move(m.changes), page);
  }
  return OK;
}

// The stamp of the derived data this engine writes and trusts (Message.derivedDataVersion).
ENG_EXPORT uint32_t engine_derived_data_version() { return Editor::kDerivedDataVersion; }

ENG_EXPORT int32_t engine_load(Handle h, Ptr ptr, uint32_t len) { return engine_load_at(h, ptr, len, 0xffffffffu, 0xffffffffu); }

// flags: APPLY_USER (1, undoable and emitted) | APPLY_REMOTE (2) | APPLY_LOAD (4) | APPLY_SYSTEM (8, emitted, not
// undoable) | APPLY_EXACT (16, a store-computed state: library copies written too, no user-edit rules). The Message
// in either encoding.
ENG_EXPORT int32_t engine_apply_changes(Handle h, Ptr ptr, uint32_t len, uint32_t flags) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  codec::KiwiMessage m;
  // Viewer mode: user edits refused (loads and remote changes — a live preview — still apply).
  if (e->editor.viewerMode() && (flags & APPLY_USER)) return E_READONLY;
  if (!readAnyMessage(ptr, len, m)) return E_DECODE;
  return e->editor.applyChanges(m.changes, flags);
}

// The full snapshot (DOCUMENT first, parents before children) in the engine's wire format. flags: ENCODE_DERIVED (1)
// adds the derived data (derivedSymbolData, derivedTextData, Message.derivedDataVersion) — kiwi only.
ENG_EXPORT int32_t engine_encode_document(Handle h, uint32_t flags) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  if (e->wire == WIRE_KIWI) {
    codec::KiwiWriteOptions opts;
    if (flags & ENCODE_DERIVED) {
      // Figma's files: derivedSymbolData per instance, derivedTextData per text, stamped.
      opts.derivedDataVersion = Editor::kDerivedDataVersion;
      Editor& ed = e->editor;
      opts.extraFields = [&ed](const NodeChange& c, std::string& fields, codec::BlobsOut& blobs) { ed.encodeDerivedFields(c.guid, fields, blobs); };
    }
    return setResult(codec::writeMessage(e->editor.sessionID(), e->editor.encodeDocument(), opts));
  }
  json::Writer w;
  writeMessage(w, e->editor.sessionID(), e->editor.encodeDocument());
  return setResult(w.take());
}

// The wire format of the engine's outputs: 0 = the interim JSON, 1 = kiwi (docs/engine-build.md "Figma parity round 3").
ENG_EXPORT int32_t engine_set_wire_format(Handle h, uint32_t format) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  if (format > WIRE_KIWI) return E_INVALID;
  e->wire = static_cast<WireFormat>(format);
  return OK;
}

ENG_EXPORT int32_t engine_wire_format(Handle h) {
  Call call(false);
  Engine* e = engineOf(h);
  return e ? static_cast<int32_t>(e->wire) : E_HANDLE;
}

// A binary payload a JSON result referred to by index (`payload`): the result slot gets its bytes.
ENG_EXPORT int32_t engine_attachment(Handle h, uint32_t index) {
  Call call(false);
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  if (index >= e->attachments.size()) return E_NOT_FOUND;
  return setResult(e->attachments[index]);
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
  // Presenting: the pointer plays the prototype (as engine_present_pointer).
  if (e->presenting()) return e->player->pointer(static_cast<PointerEvent>(type), x, y, buttons, mods);
  return e->editor.pointer(static_cast<PointerEvent>(type), x, y, static_cast<int>(button), buttons, mods, static_cast<int>(clickCount));
}

// deltaMode as WheelEvent's; flags PINCH (1) = ctrlKey from a trackpad.
ENG_EXPORT uint32_t engine_wheel(Handle h, double x, double y, double dx, double dy, uint32_t deltaMode, uint32_t mods, uint32_t flags) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return 0;
  if (e->presenting()) {
    double unit = deltaMode == 1 ? 16 : deltaMode == 2 ? std::max(1.0, e->editor.viewport().height) : 1;
    return e->player->wheel(x, y, dx * unit, dy * unit);
  }
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
  if (!e) return 0;
  bool render = e->editor.tick(timeMs);
  if (e->presenting()) render = e->player->tick(timeMs) || render;
  // A zoom that settled: the page is drawn sharp again (render/Renderer.h wantsFrameAt).
  double at = e->renderer->wantsFrameAt();
  if (at > 0 && e->renderer->nowMs() >= at) render = true;
  return render ? TICK_NEEDS_RENDER : 0;
}

ENG_EXPORT void engine_render(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return;
  Editor& ed = e->editor;
  if (e->presenting()) {
    e->stats = e->renderer->renderScene(ed.document(), e->player->page(), ed.viewport(), e->player->scene());
    e->player->rendered();
    ed.rendered();
    return;
  }
  e->stats = e->renderer->render(ed.document(), ed.page(), ed.camera(), ed.viewport(), ed.overlay(), OverlayStyle::of(ed.theme()));
  ed.rendered();
}

ENG_EXPORT int32_t engine_next_frame_delay(Handle h) {
  Call call(false);
  Engine* e = engineOf(h);
  if (!e) return -1;
  if (e->editor.needsFrame() || gFontsDirty) return 0;
  if (e->presenting()) return e->player->nextFrameDelay();
  int32_t delay = e->editor.textEditing() ? 265 : -1;  // the caret blinks (530 ms phases)
  if (double at = e->renderer->wantsFrameAt(); at > 0) {
    int32_t settle = static_cast<int32_t>(std::max(1.0, std::ceil(at - e->renderer->nowMs())));
    delay = delay < 0 ? settle : std::min(delay, settle);
  }
  return delay;
}

ENG_EXPORT uint32_t engine_needs_frame(Handle h) {
  Call call(false);  // a pending font relayout is a frame's work (engine_tick catches up)
  Engine* e = engineOf(h);
  return e && (e->editor.needsFrame() || gFontsDirty || (e->presenting() && e->player->needsFrame())) ? 1 : 0;
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
  e->device.reset();
  e->device = gfx::createCanvasDevice(e->selector.c_str(), e->webgpu ? gfx::Backend::WebGPU : gfx::Backend::WebGL2);
  if (!e->device) e->device = std::make_unique<gfx::NullDevice>();
  e->renderer = std::make_unique<Renderer>(*e->device);
  e->renderer->setTextLayouts(&e->editor);
  e->renderer->setContentCache(true);
  e->editor.setViewport(e->editor.viewport().width, e->editor.viewport().height, e->editor.viewport().dpr,
                        e->editor.viewport().pixelWidth, e->editor.viewport().pixelHeight);
#endif
}

// The canvas's backend changes (Figma's dynamic fallback: a WebGPU device lost or failing its self test moves the
// session to WebGL2). `selector` names the canvas to draw into from now on — a fresh one, as a canvas keeps the
// context type it was first given. `backend`: 0 WebGL2, 1 WebGPU. Returns the backend in use (−1: none, the
// engine draws nothing until a restore).
ENG_EXPORT int32_t engine_gfx_switch(Handle h, const char* selector, int32_t backend) {
  Call call;
  Engine* e = engineOf(h);
  if (!e || e->selector.empty()) return -1;
#ifdef __EMSCRIPTEN__
  if (selector && *selector) e->selector = selector;
  const Viewport& v = e->editor.viewport();
  if (v.pixelWidth > 0 && v.pixelHeight > 0) emscripten_set_canvas_element_size(e->selector.c_str(), v.pixelWidth, v.pixelHeight);
  e->renderer.reset();
  e->device.reset();
  e->device = gfx::createCanvasDevice(e->selector.c_str(), backend == 1 ? gfx::Backend::WebGPU : gfx::Backend::WebGL2);
  int32_t got = -1;
  if (e->device) {
    e->webgpu = std::string_view(e->device->backend()) == "webgpu";
    got = e->webgpu ? 1 : 0;
  } else {
    e->device = std::make_unique<gfx::NullDevice>();
  }
  e->renderer = std::make_unique<Renderer>(*e->device);
  e->renderer->setTextLayouts(&e->editor);
  e->renderer->setContentCache(true);
  e->editor.setViewport(v.width, v.height, v.dpr, v.pixelWidth, v.pixelHeight);
  return got;
#else
  (void)selector;
  (void)backend;
  return -1;
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

// One Layers row: {"guid","parentIndex":{"guid"},"type","name","visible","locked","childIds"[, "resizeToFit",
// "stackMode", "stackWrap", "booleanOperation", "isStateGroup"]} (the last ones only when set).
void writeLayerRow(json::Writer& w, const Document& doc, Guid id, const NodeProps& p) {
  w.beginObject().key("guid").string(id.toString());
  if (p.parentIndex.guid != kNoGuid) w.key("parentIndex").beginObject().key("guid").string(p.parentIndex.guid.toString()).endObject();
  w.key("type").string(nodeTypeName(p.type)).key("name").string(p.name).key("visible").boolean(p.visible).key("locked").boolean(p.locked);
  if (p.resizeToFit) w.key("resizeToFit").boolean(true);
  if (p.stack().stackMode != StackMode::NONE) w.key("stackMode").string(enumName(p.stack().stackMode));
  if (p.stack().stackWrap != StackWrap::NO_WRAP) w.key("stackWrap").string(enumName(p.stack().stackWrap));
  if (p.type == NodeType::BOOLEAN_OPERATION) w.key("booleanOperation").string(enumName(p.shape().booleanOperation));
  if (p.comp().isStateGroup) w.key("isStateGroup").boolean(true);
  w.key("childIds");
  writeIds(w, doc.children(id));
  w.endObject();
}

// The page and every layer under it, parents before children (hidden ones and instance sublayers included).
void writeLayerRows(json::Writer& w, const Document& doc, Guid page) {
  std::vector<Guid> stack{page};
  while (!stack.empty()) {
    Guid id = stack.back();
    stack.pop_back();
    const Node* n = doc.get(id);
    if (!n) continue;
    writeLayerRow(w, doc, id, n->props);
    const std::vector<Guid>& kids = doc.children(id);
    // Pre-order with the first child read first.
    for (size_t i = kids.size(); i-- > 0;) stack.push_back(kids[i]);
  }
}

// What a Layers row shows, or where it is: a change of these changes the row.
constexpr FieldMask kLayerRowFields = F_PARENT_INDEX | F_NAME | F_VISIBLE | F_LOCKED | F_TYPE | F_RESIZE_TO_FIT | F_STACK_MODE |
                                      F_STACK_WRAP | F_BOOLEAN_OPERATION | F_IS_STATE_GROUP;
// Past this many changed rows a delta is not worth it: the whole tree is given.
constexpr size_t kMaxLayerDelta = 4096;

// The Layers panel's tree of a page in one read: {"version", "nodes": [rows…]} (writeLayerRows). A page of tens of
// thousands of layers reads in milliseconds, where engine_read_nodes writes every field of each. `version` is the
// document version the read is of — what engine_layer_changes takes. Derives the page first (its instance
// sublayers are rows).
ENG_EXPORT int32_t engine_layer_tree(Handle h, uint32_t pageSessionID, uint32_t pageLocalID) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  const Document& doc = e->editor.document();
  Guid page{pageSessionID, pageLocalID};
  if (!doc.has(page)) return E_NOT_FOUND;
  e->editor.derivePage(page);
  json::Writer w;
  w.beginObject().key("version").number(static_cast<double>(doc.version())).key("nodes").beginArray();
  writeLayerRows(w, doc, page);
  w.endArray().endObject();
  return setResult(w.take());
}

// Pass 1 of Figma's two-pass Layers panel: only the outline of `page` — every row's place and kind, no names —
// {"version", "ids": [guid…], "parents": [row index, -1 for the page], "kinds": [typeCode | flags << 8],
// "types": [type name by code]}; rows in pre-order, each node followed by its children bottom first (as
// engine_layer_tree), hidden layers and instance sublayers included. Flags: 1 instance sublayer, 2 isStateGroup,
// 4 resizeToFit. Derives the page first.
ENG_EXPORT int32_t engine_layer_outline(Handle h, uint32_t pageSessionID, uint32_t pageLocalID) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  const Document& doc = e->editor.document();
  Guid page{pageSessionID, pageLocalID};
  if (!doc.has(page)) return E_NOT_FOUND;
  e->editor.derivePage(page);
  std::vector<Guid> ids;
  std::vector<int64_t> parents;
  std::vector<uint32_t> kinds;
  std::vector<std::pair<Guid, int64_t>> stack{{page, -1}};
  while (!stack.empty()) {
    auto [id, parent] = stack.back();
    stack.pop_back();
    const Node* n = doc.get(id);
    if (!n) continue;
    int64_t index = static_cast<int64_t>(ids.size());
    ids.push_back(id);
    parents.push_back(parent);
    uint32_t flags = (id.isDerived() ? 1u : 0u) | (n->props.comp().isStateGroup ? 2u : 0u) | (n->props.resizeToFit ? 4u : 0u);
    kinds.push_back(static_cast<uint32_t>(n->props.type) | flags << 8);
    const std::vector<Guid>& kids = doc.children(id);
    for (size_t i = kids.size(); i-- > 0;) stack.push_back({kids[i], index});
  }
  std::string out;
  out.reserve(ids.size() * 24 + 256);
  out += "{\"version\":" + std::to_string(doc.version()) + ",\"ids\":[";
  for (size_t i = 0; i < ids.size(); i++) {
    if (i) out += ',';
    out += '"';
    out += ids[i].toString();
    out += '"';
  }
  out += "],\"parents\":[";
  for (size_t i = 0; i < parents.size(); i++) {
    if (i) out += ',';
    out += std::to_string(parents[i]);
  }
  out += "],\"kinds\":[";
  for (size_t i = 0; i < kinds.size(); i++) {
    if (i) out += ',';
    out += std::to_string(kinds[i]);
  }
  out += "],\"types\":[";
  for (uint32_t t = 0; t < 32; t++) {
    if (t) out += ',';
    const char* name = nodeTypeName(static_cast<NodeType>(t));
    out += '"';
    out += std::string_view(name) == "NONE" && t != 0 ? "" : name;
    out += '"';
  }
  out += "]}";
  return setResult(std::move(out));
}

// The Layers rows of `page` changed since document version `since`: {"version", "full": false, "nodes": [rows of the
// nodes whose row or place changed, and of their current and previous parents (their childIds complete)],
// "removed": [ids no longer in the document]}; or {"version", "full": true, "nodes": [the whole tree], "removed": []}
// when `since` is outside what the change log keeps or more than kMaxLayerDelta rows changed. The editor drops
// `removed`, upserts `nodes` by guid.
ENG_EXPORT int32_t engine_layer_changes(Handle h, uint32_t pageSessionID, uint32_t pageLocalID, double since) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  const Document& doc = e->editor.document();
  Guid page{pageSessionID, pageLocalID};
  if (!doc.has(page)) return E_NOT_FOUND;
  e->editor.derivePage(page);
  std::vector<Document::ChangeRecord> changes;
  bool delta = since >= 0 && since <= static_cast<double>(doc.version()) && doc.changesSince(static_cast<uint64_t>(since), changes);
  std::vector<Guid> rows, removed;
  std::unordered_set<Guid, GuidHash> seen;
  auto row = [&](Guid id) {
    if (id == kNoGuid || !seen.insert(id).second) return;
    const Node* n = doc.get(id);
    if (!n) {
      removed.push_back(id);
      return;
    }
    if (id != page && doc.pageOf(id) != page) return;  // another page's: not this tree's
    rows.push_back(id);
  };
  if (delta) {
    for (const Document::ChangeRecord& c : changes) {
      if (rows.size() > kMaxLayerDelta) {
        delta = false;
        break;
      }
      bool structural = c.fields == F_ALL || (c.fields & F_PARENT_INDEX);
      if (!structural && !(c.fields & kLayerRowFields)) continue;
      row(c.id);
      if (!structural) continue;
      row(c.parentBefore);
      if (const Node* n = doc.get(c.id)) row(n->props.parentIndex.guid);
    }
  }
  json::Writer w;
  w.beginObject().key("version").number(static_cast<double>(doc.version())).key("full").boolean(!delta).key("nodes").beginArray();
  if (delta) {
    for (Guid id : rows) writeLayerRow(w, doc, id, doc.get(id)->props);
  } else {
    writeLayerRows(w, doc, page);
    removed.clear();
  }
  w.endArray().key("removed");
  writeIds(w, removed);
  w.endObject();
  return setResult(w.take());
}

// The typed per-facet getter (Figma's generated facet bindings; facet_readers.h from fieldmeta.ts): `count` nodes as
// (sessionID, localID) u32 pairs at `idsPtr` (a derived ref: 0xfffffffe and its engine_ref_id), the facets in `mask`
// (bit 1 << facet id). Result: f64s — per node a presence slot (1 / 0), then each requested facet's record in id
// order (NaN for a node that isn't there). No JSON; nothing is derived (a read of what a panel already shows).
ENG_EXPORT int32_t engine_read_facets(Handle h, Ptr idsPtr, uint32_t count, uint32_t mask) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  uint32_t per = 1;
  for (uint32_t f = 0; f < facets::kCount; f++)
    if (mask & (1u << f)) per += facets::kSlots[f];
  std::string out(static_cast<size_t>(count) * per * sizeof(double), '\0');
  auto* o = reinterpret_cast<double*>(out.data());
  const auto* ids = reinterpret_cast<const uint32_t*>(idsPtr);
  const Document& doc = e->editor.document();
  for (uint32_t i = 0; i < count; i++, o += per) {
    const Node* n = doc.get(Guid{ids[2 * i], ids[2 * i + 1]});
    o[0] = n ? 1 : 0;
    double* at = o + 1;
    for (uint32_t f = 0; f < facets::kCount; f++) {
      if (!(mask & (1u << f))) continue;
      if (n) facets::write(f, n->props, at);
      else std::fill(at, at + facets::kSlots[f], std::nan(""));
      at += facets::kSlots[f];
    }
  }
  return setResult(std::move(out));
}

// The generic getter: a Message with one NodeChange per ref that exists — every field, or only the schema keys in
// the payload's "fields" (`{"refs": […], "fields": ["fillPaints", …]}`; unknown keys ignored; guid and type always);
// flags: ReadFlags. Derives the pages of the refs first (an instance's sublayers are nodes).
ENG_EXPORT int32_t engine_read_nodes(Handle h, Ptr ptr, uint32_t len, uint32_t flags) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Value v;
  if (!parse(ptr, len, v)) return E_DECODE;
  Editor& ed = e->editor;
  const Document& doc = ed.document();
  FieldMask mask = F_ALL;
  if (const json::Value* fields = v.isArray() ? nullptr : v.get("fields"); fields && fields->isArray()) {
    mask = 0;
    for (auto& f : fields->array)
      if (f.isString()) {
        FieldMask m = codec::fieldOfKey(f.string);
        // A key the engine doesn't model (prototypeStartingPoint, exportSettings…): the unmodelled fields it keeps.
        mask |= m ? m : (codec::fieldIdOf("NodeChange", f.string) ? static_cast<FieldMask>(F_EXTRA) : 0);
      }
  }
  std::vector<Guid> refs = readRefs(v);
  for (Guid id : refs) ed.derivePageOf(id, (flags & READ_SUBTREE) != 0);
  json::Writer w;
  codec::BlobsOut blobs;
  w.beginObject().key("type").string("NODE_CHANGES").key("sessionID").number(ed.sessionID());
  w.key("nodeChanges").beginArray();
  std::unordered_set<Guid, GuidHash> written;
  auto one = [&](Guid id, const Node& n) {
    if (!written.insert(id).second) return;
    if (flags & INCLUDE_CHILD_IDS) {
      // writeNode closes the object; build it by hand to add childIds.
      json::Writer single;
      codec::writeNode(single, n, mask, &blobs);
      std::string s = single.take();
      s.pop_back();
      json::Writer kids;
      writeIds(kids, doc.children(id));
      s += ",\"childIds\":" + kids.take() + "}";
      w.raw(s);
    } else {
      codec::writeNode(w, n, mask, &blobs);
    }
  };
  std::vector<Guid> stack;
  for (Guid id : refs) {
    const Node* n = doc.get(id);
    if (!n) continue;
    one(id, *n);
    if (!(flags & READ_SUBTREE)) continue;
    // Its descendants, pre-order, children back to front (paint order); hidden subtrees left out when asked.
    if ((flags & READ_VISIBLE_ONLY) && !n->props.visible) continue;
    stack.clear();
    const std::vector<Guid>& kids = doc.children(id);
    for (size_t i = kids.size(); i-- > 0;) stack.push_back(kids[i]);
    while (!stack.empty()) {
      Guid c = stack.back();
      stack.pop_back();
      const Node* cn = doc.get(c);
      if (!cn || ((flags & READ_VISIBLE_ONLY) && !cn->props.visible)) continue;
      one(c, *cn);
      const std::vector<Guid>& more = doc.children(c);
      for (size_t i = more.size(); i-- > 0;) stack.push_back(more[i]);
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
  if (e->editor.viewerMode()) return E_READONLY;  // viewer mode: read-only
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
  if (e && e->editor.viewerMode()) return E_READONLY;  // viewer mode: read-only
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
// The commands viewer mode allows: selection and zoom (CommandId 10–16, 50–54).
static bool viewerCommand(uint32_t id) { return (id >= 10 && id <= 16) || (id >= 50 && id <= 54); }

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
  // Viewer mode: selecting and zooming only.
  if (e->editor.viewerMode() && !viewerCommand(commandId)) return E_READONLY;
  int32_t status = e->editor.command(static_cast<CommandId>(commandId), a);
  // What the command created (variables, collections, modes, styles): {"created": [...]}.
  json::Writer w;
  w.beginObject().key("created");
  writeIds(w, e->editor.lastCreated());
  w.endObject();
  setResult(w.take());
  return status;
}

ENG_EXPORT uint32_t engine_command_state(Handle h, uint32_t commandId) {
  Call call;
  Engine* e = engineOf(h);
  if (e && e->editor.viewerMode() && !viewerCommand(commandId)) return 0;
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
  if (e->editor.viewerMode()) return E_READONLY;  // viewer mode: read-only
  json::Value v;
  if (!parse(refsPtr, refsLen, v)) return E_DECODE;
  return static_cast<int32_t>(e->editor.moveNodes(readRefs(v), {parentSessionID, parentLocalID}, index));
}

// The selection as a clipboard Message (docs/schema.md §4.1): the copied nodes
// as CREATED with their source GUIDs, parents first, plus "pastePageId" and
// "clipboardSelectionRegions" [{parent, nodes, enclosingFrameOffset}]. E_NOT_FOUND
// when nothing is selected.
ENG_EXPORT int32_t engine_encode_selection(Handle h, uint32_t flags) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  Clipboard clip;
  if (!e->editor.copySelection(clip, (flags & 1) != 0)) return E_NOT_FOUND;
  if (e->wire == WIRE_KIWI) {
    std::vector<codec::KiwiRegion> regions;
    for (auto& r : clip.regions) regions.push_back({r.parent, r.nodes, r.offset});
    codec::KiwiWriteOptions opts;
    opts.pastePageId = &clip.page;
    opts.pasteFileKey = clip.fileKey;
    opts.isCut = clip.isCut;
    opts.regions = &regions;
    return setResult(codec::writeMessage(e->editor.sessionID(), clip.nodes, opts));
  }
  json::Writer w;
  codec::BlobsOut blobs;
  w.beginObject();
  w.key("type").string("NODE_CHANGES");
  w.key("sessionID").number(e->editor.sessionID());
  w.key("nodeChanges");
  codec::writeChanges(w, clip.nodes, &blobs);
  blobs.writeMember(w);
  w.key("pastePageId").string(clip.page.toString());
  if (!clip.fileKey.empty()) w.key("pasteFileKey").string(clip.fileKey);
  if (clip.isCut) w.key("isCut").boolean(true);
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
  if (e->editor.viewerMode()) return E_READONLY;  // viewer mode: read-only
  codec::KiwiMessage m;
  json::Value v;
  if (!readAnyMessage(ptr, len, m, &v)) return E_DECODE;
  if (e->editor.busy()) return E_BUSY;
  Clipboard clip;
  clip.nodes = std::move(m.changes);
  if (m.hasPastePage) clip.page = m.pastePageId;
  clip.fileKey = m.pasteFileKey;
  clip.isCut = m.isCut;
  for (auto& r : m.regions) clip.regions.push_back({r.parent, r.nodes, r.offset});
  if (auto* p = v.get("pastePageId")) codec::readGuid(*p, clip.page);
  if (auto* k = v.get("pasteFileKey"); k && k->isString()) clip.fileKey = k->string;
  if (auto* c = v.get("isCut"); c && c->isBool()) clip.isCut = c->boolean;
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

namespace {

// Draws `page` through `camera` into an offscreen width × height target and sets the result: u32 width, u32 height
// (little endian), then straight RGBA8, rows top to bottom. `only`: one node's subtree (transparent around it).
int32_t renderOffscreen(Engine* e, Guid page, const Camera& camera, int width, int height, const Overlay& overlay, Guid only = kNoGuid) {
  Editor& ed = e->editor;
  Viewport viewport{static_cast<double>(width), static_cast<double>(height), 1, width, height};
  gfx::TargetId target = e->device->createTarget(static_cast<uint32_t>(width), static_cast<uint32_t>(height));
  if (!target) return E_UNSUPPORTED;
  e->renderer->render(ed.document(), page, camera, viewport, overlay, OverlayStyle::of(ed.theme()), target, only);
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

}  // namespace

// A region of a page, world (x, y, w, h), drawn into width × height device px, the page colour behind it, no
// overlays or frame titles: what Figma's file thumbnail shows (meta.json's render_coordinates drawn at its
// thumbnail_size), for scripts/fig-fidelity.mjs. One zoom, width / w (the two aspects differ only by rounding).
// Same result layout as engine_render_thumbnail. E_NOT_FOUND: no such page or an empty region; E_INVALID: larger
// than the device's largest texture.
ENG_EXPORT int32_t engine_render_region(Handle h, uint32_t pageSessionID, uint32_t pageLocalID, double x, double y, double w, double hgt, uint32_t width, uint32_t height, uint32_t /*flags*/) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  Editor& ed = e->editor;
  Guid page{pageSessionID, pageLocalID};
  if (page == kNoGuid) page = ed.page();
  const Node* pn = ed.document().get(page);
  if (!pn || pn->props.type != NodeType::CANVAS || !(w > 0) || !(hgt > 0) || width == 0 || height == 0) return E_NOT_FOUND;
  uint32_t limit = static_cast<uint32_t>(e->device->caps().maxTextureSize);
  if (width > limit || height > limit) return E_INVALID;
  ed.derivePage(page);  // its instances' sublayers draw
  double zoom = width / w;
  Camera camera{-x * zoom, -y * zoom, zoom};
  Overlay none;
  none.handles = false;
  none.sizeBadge = false;
  none.frameTitles = false;
  return renderOffscreen(e, page, camera, static_cast<int>(width), static_cast<int>(height), none);
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
  ed.derivePage(page);  // its instances' sublayers draw
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
  Call call(false);
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
  w.key("visited").number(e->stats.nodes).key("culled").number(e->stats.culled).key("tiny").number(e->stats.tiny);
  w.key("greeked").number(e->stats.greeked).key("cachedRegions").number(e->stats.cachedRegions).key("stale").number(e->stats.stale);
  w.key("tiles").number(static_cast<double>(e->renderer->tileCount())).key("tileBytes").number(static_cast<double>(e->renderer->tileBytes()));
  w.key("tilesRastered").number(e->stats.tilesRastered).key("tilesStale").number(e->stats.tilesStale).key("tilesShown").number(e->stats.tilesShown);
  // What the engine holds on the GPU (estimated): budgets are checked against it (scripts/engine-bench.mjs).
  gfx::MemoryStats gm = e->device->memory();
  w.key("gpuBytes").number(static_cast<double>(gm.bytes)).key("gpuTextures").number(gm.textures).key("gpuTargets").number(gm.targets);
  w.key("gfx").string(e->device->backend());
  w.key("gpuBuffers").number(gm.buffers).key("layerPoolBytes").number(static_cast<double>(e->renderer->poolTargetBytes()));
  w.key("curveTexels").number(e->renderer->curveCache().texelCount());
  w.key("derivedUsed").number(e->editor.derivedUsed()).key("derivedStale").number(e->editor.derivedStale());
#ifdef __EMSCRIPTEN__
  w.key("heapBytes").number(static_cast<double>(__builtin_wasm_memory_size(0)) * 65536.0);
#else
  w.key("heapBytes").number(0);
#endif
  w.key("nodeBytes").number(static_cast<double>(e->editor.document().approxBytes()));
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
  Call call(false);
  int32_t id = text::FontRegistry::get().addFace(reinterpret_cast<uint8_t*>(ptr), len, faceIndex);
  if (id < 0) setError("not a font file");
  return id < 0 ? E_DECODE : id;
}

// `faceId` answers the FontName {family, style} (UTF-8 strings): its named instance (or the
// weight/italic axes) for that style. Text using it is laid out again.
ENG_EXPORT int32_t engine_font_bind(Ptr familyPtr, uint32_t familyLen, Ptr stylePtr, uint32_t styleLen, int32_t faceId) {
  Call call(false);
  if (!text::FontRegistry::get().bind(std::string(bytes(familyPtr, familyLen)), std::string(bytes(stylePtr, styleLen)), faceId))
    return E_NOT_FOUND;
  gFontsDirty = true;
  return OK;
}

// Nobody has {family, style}: its text draws with Inter and is marked missing.
ENG_EXPORT void engine_font_missing(Ptr familyPtr, uint32_t familyLen, Ptr stylePtr, uint32_t styleLen) {
  Call call(false);
  text::FontRegistry::get().markMissing(std::string(bytes(familyPtr, familyLen)), std::string(bytes(stylePtr, styleLen)));
  gFontsDirty = true;
}

// ["Apple Color Emoji", "PingFang SC", …]: tried in order for characters a text's font lacks.
ENG_EXPORT int32_t engine_set_fallback_fonts(Ptr ptr, uint32_t len) {
  Call call(false);
  json::Value v;
  if (!parse(ptr, len, v) || !v.isArray()) return E_DECODE;
  std::vector<std::string> families;
  for (auto& f : v.array)
    if (f.isString()) families.push_back(f.string);
  text::FontRegistry::get().setFallbacks(std::move(families));
  gFontsDirty = true;
  return OK;
}

// ---- Vector edit mode, gradient handles (docs/engine-build.md "E4 + E5 API") ---------------------

// Edits a node's vector network (VECTOR, LINE, rectangles, ellipses, stars, polygons). E_UNSUPPORTED for others.
ENG_EXPORT int32_t engine_vector_edit(Handle h, uint32_t sessionID, uint32_t localID) {
  Call call;
  Engine* e = engineOf(h);
  if (e && e->editor.viewerMode()) return E_READONLY;  // viewer mode: read-only
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
  if (e && e->editor.viewerMode()) return E_READONLY;  // viewer mode: read-only
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
  if (e->editor.viewerMode()) return E_READONLY;  // viewer mode: read-only
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
  w.key("hyperlinkBoxes").beginArray();
  for (const text::LinkBox& b : L->links) {
    w.beginObject().key("bounds").beginObject();
    w.key("x").number(b.rect.x).key("y").number(b.rect.y).key("w").number(b.rect.w).key("h").number(b.rect.h).endObject();
    if (!b.link.url.empty()) w.key("url").string(b.link.url);
    if (b.link.guid != kNoGuid) w.key("guid").string(b.link.guid.toString());
    w.key("hyperlinkID").number(b.id).key("openInNewTab").boolean(b.link.openInNewTab);
    w.key("firstCharacter").number(b.start).key("endCharacter").number(b.end);
    w.endObject();
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

// Result: the style of a text range as the Typography section shows it (Editor::textRangeStyle): {from, to,
// values, mixed}. flags 1: the edited selection (or the whole text when it isn't being edited); else [from, to).
ENG_EXPORT int32_t engine_text_range_style(Handle h, uint32_t sessionID, uint32_t localID, uint32_t from, uint32_t to, uint32_t flags) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  std::string out = e->editor.textRangeStyle({sessionID, localID}, from, to, (flags & 1) != 0);
  if (out.empty()) return E_NOT_FOUND;
  return setResult(std::move(out));
}

// Paragraph edits (Editor::textParagraphs): op 0 = list type (value 0 none, 1 numbered, 2 bulleted; a toggle), op 1 =
// indentation by `value` levels; on the edited selection's paragraphs, or the whole text.
ENG_EXPORT int32_t engine_text_paragraphs(Handle h, uint32_t sessionID, uint32_t localID, int32_t op, int32_t value) {
  Call call;
  Engine* e = engineOf(h);
  return e ? e->editor.textParagraphs({sessionID, localID}, op, value) : E_HANDLE;
}

// Result: a font's variable axes and OpenType features, for the Type settings' Variable and Details tabs:
// {axes: [{tag, name, min, default, max, value, hidden}], features: [{tag, name}]}. E_NOT_FOUND while the font isn't
// loaded (it is requested: REQUEST_FONT) or when it's missing.
ENG_EXPORT int32_t engine_font_info(Ptr familyPtr, uint32_t familyLen, Ptr stylePtr, uint32_t styleLen) {
  Call call(false);
  text::Font* f = text::FontRegistry::get().find(FontName{std::string(bytes(familyPtr, familyLen)), std::string(bytes(stylePtr, styleLen)), ""});
  if (!f) return E_NOT_FOUND;
  json::Writer w;
  w.beginObject().key("axes").beginArray();
  for (const text::AxisInfo& a : f->axes()) {
    w.beginObject().key("tag").string(text::tagString(a.tag)).key("name").string(a.name);
    w.key("min").number(a.min).key("default").number(a.def).key("max").number(a.max).key("value").number(a.value);
    w.key("hidden").boolean(a.hidden).endObject();
  }
  w.endArray().key("features").beginArray();
  for (const text::FeatureInfo& ft : f->features()) {
    w.beginObject().key("tag").string(text::tagString(ft.tag));
    if (!ft.name.empty()) w.key("name").string(ft.name);
    w.endObject();
  }
  w.endArray().endObject();
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
    w.key("boundVariable");
    if (p.boundVariable == kNoGuid) w.null();
    else w.string(p.boundVariable.toString());
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
  if (ok) e->editor.derivePageOf(id);
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
    w.key("softDeleted").boolean(info.mainSoftDeleted);
    w.key("remote");
    if (!info.mainRemote) {
      w.null();
    } else {
      w.beginObject().key("libraryKey").string(info.mainLibraryKey).key("key").string(info.mainKey);
      w.key("version").string(info.mainVersion).endObject();
    }
    w.key("copied").boolean(info.mainCopied).endObject();
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

// ---- Variables, modes, styles (docs/engine-build.md "E6 variables") ----

namespace {

Guid parseRef(Ptr ptr, uint32_t len) {
  bool ok = false;
  Guid g = Guid::parse(bytes(ptr, len), &ok);
  return ok ? g : kNoGuid;
}

// "remote" and "libraryKey" members of an asset's info (a library copy: its library).
void writeRemote(json::Writer& w, const Editor& ed, Guid id) {
  Guid root = ed.libraryRootOf(id);
  w.key("remote").boolean(root != kNoGuid).key("libraryKey");
  if (root == kNoGuid) w.null();
  else w.string(ed.document().get(root)->props.asset().sourceLibraryKey);
}

void writeColorValue(json::Writer& w, const Color& c) {
  w.beginObject().key("r").number(c.r).key("g").number(c.g).key("b").number(c.b).key("a").number(c.a).endObject();
}

void writeResolved(json::Writer& w, const Editor::Resolved& r, bool ok) {
  using K = Editor::Resolved::Kind;
  if (!ok) {
    w.null();
    return;
  }
  switch (r.kind) {
    case K::BOOL: w.boolean(r.b); break;
    case K::FLOAT: w.number(r.f); break;
    case K::STRING: w.string(r.s); break;
    case K::COLOR: writeColorValue(w, r.c); break;
    case K::OTHER: w.raw(r.raw.empty() ? std::string("null") : "{" + r.raw + "}"); break;
    default: w.null(); break;
  }
}

// A VariableValue in Figma's plugin shapes (docs/engine-build.md "Values").
void writeVariableValue(json::Writer& w, const VariableData& d, const Editor& ed) {
  using K = VariableData::Kind;
  switch (d.kind) {
    case K::BOOL: w.boolean(d.boolValue); break;
    case K::FLOAT: w.number(d.floatValue); break;
    case K::TEXT: w.string(d.textValue); break;
    case K::COLOR: writeColorValue(w, d.colorValue); break;
    case K::ALIAS: {
      Guid v = ed.findVariable(d.alias);
      if (v == kNoGuid) v = d.alias.guid;
      w.beginObject().key("type").string("VARIABLE_ALIAS").key("id");
      if (v == kNoGuid) w.null();
      else w.string(v.toString());
      w.endObject();
      break;
    }
    case K::EXPRESSION:
      if (d.function == ExpressionFunction::COMPOSE_COLOR && d.args.size() >= 2) {
        w.beginObject().key("color");
        writeVariableValue(w, d.args[0], ed);
        w.key("opacity");
        writeVariableValue(w, d.args[1], ed);
        w.endObject();
      } else {
        codec::writeVariable(w, d);
      }
      break;
    case K::FONT_STYLE:
      for (auto& a : d.args)
        if (a.present()) {
          writeVariableValue(w, a, ed);
          return;
        }
      w.null();
      break;
    case K::NONE: w.null(); break;
    default: codec::writeVariable(w, d); break;
  }
}

void writeVariableInfo(json::Writer& w, const Editor& ed, Guid v) {
  const Document& doc = ed.document();
  const NodeProps& p = doc.get(v)->props;
  Guid set = ed.findCollection(p.asset().variableSetID);
  const Node* sn = doc.get(set);
  w.beginObject().key("id").string(v.toString()).key("name").string(p.name).key("collectionId");
  if (set == kNoGuid) w.null();
  else w.string(set.toString());
  w.key("resolvedType").string(enumName(p.asset().variableResolvedType));
  std::vector<VariableSetMode> modes = sn ? sn->props.orderedModes() : std::vector<VariableSetMode>{};
  Guid def = sn ? sn->props.defaultMode() : kNoGuid;
  auto valueFor = [&](Guid mode) -> const VariableData* {
    const VariableData* fallback = nullptr;
    for (auto& mv : p.asset().variableDataValues) {
      if (mv.modeID == mode) return &mv.data;
      if (mv.modeID == def) fallback = &mv.data;
    }
    return fallback;
  };
  // Extended collections of its collection: their modes too (an override, else the inherited value), and which of
  // them they override ("overriddenModes").
  std::vector<VariableSetMode> extModes;
  if (set != kNoGuid) {
    std::vector<Guid> queue{set};
    for (size_t i = 0; i < queue.size() && i < 256; i++)
      for (Guid x : ed.extensionsOf(queue[i])) {
        queue.push_back(x);
        for (auto& m : doc.get(x)->props.orderedModes()) extModes.push_back(m);
      }
  }
  w.key("valuesByMode").beginObject();
  for (auto& m : modes) {
    w.key(m.id.toString());
    if (const VariableData* d = valueFor(m.id)) writeVariableValue(w, *d, ed);
    else w.null();
  }
  std::vector<Guid> overridden;
  for (auto& m : extModes) {
    bool own = false;
    w.key(m.id.toString());
    if (const VariableData* d = ed.valueForMode(v, m.id, &own)) writeVariableValue(w, *d, ed);
    else w.null();
    if (own) overridden.push_back(m.id);
  }
  w.endObject();
  w.key("overriddenModes");
  writeIds(w, overridden);
  modes.insert(modes.end(), extModes.begin(), extModes.end());
  w.key("resolvedValuesByMode").beginObject();
  for (auto& m : modes) {
    Editor::Resolved r;
    bool ok = ed.resolveVariableInMode(v, m.id, r);
    w.key(m.id.toString());
    writeResolved(w, r, ok);
  }
  w.endObject();
  w.key("scopes").beginArray();
  if (!p.asset().variableScopes) w.string("ALL_SCOPES");
  else
    for (VariableScope sc : *p.asset().variableScopes) w.string(enumName(sc));
  w.endArray();
  w.key("codeSyntax").beginObject();
  for (auto& cs : p.asset().codeSyntax) w.key(enumName(cs.platform)).string(cs.value);
  w.endObject();
  w.key("description").string(p.asset().description).key("hiddenFromPublishing").boolean(!p.asset().isPublishable);
  w.key("key").string(p.asset().key).key("deletedButReferenced").boolean(p.comp().isSoftDeleted);
  writeRemote(w, ed, v);
  w.endObject();
}

}  // namespace

// flags: INCLUDE_REMOTE (1) adds library copies.
ENG_EXPORT int32_t engine_variable_collections(Handle h, uint32_t flags) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  Editor& ed = e->editor;
  json::Writer w;
  w.beginArray();
  for (Guid c : ed.collections((flags & 1) != 0)) {
    const NodeProps& p = ed.document().get(c)->props;
    std::vector<VariableSetMode> modes = p.orderedModes();
    w.beginObject().key("id").string(c.toString()).key("name").string(p.name).key("modes").beginArray();
    for (auto& m : modes) {
      w.beginObject().key("modeId").string(m.id.toString()).key("name").string(m.name);
      if (m.parentMode != kNoGuid) w.key("parentModeId").string(m.parentMode.toString());
      w.endObject();
    }
    w.endArray().key("defaultModeId");
    if (modes.empty()) w.null();
    else w.string(modes[0].id.toString());
    // An extended collection (R3-33): its parent, its chain's root; its variables are the root's (inherited).
    Guid parent = ed.extensionParent(c);
    Guid root = ed.rootCollection(c);
    w.key("isExtension").boolean(parent != kNoGuid).key("parentCollectionId");
    if (parent == kNoGuid) w.null();
    else w.string(parent.toString());
    w.key("rootCollectionId").string(root.toString());
    w.key("variableIds");
    writeIds(w, ed.variablesOf(root));
    bool hidden = !p.asset().isPublishable || (!p.name.empty() && (p.name[0] == '_' || p.name[0] == '.'));
    w.key("hiddenFromPublishing").boolean(hidden).key("key").string(p.asset().key).key("description").string(p.asset().description);
    writeRemote(w, ed, c);
    w.endObject();
  }
  w.endArray();
  return setResult(w.take());
}

// collPtr/collLen: a collection's ref ("s:l"); empty = every collection's (flags INCLUDE_REMOTE (1): library copies' too).
ENG_EXPORT int32_t engine_variables(Handle h, Ptr collPtr, uint32_t collLen, uint32_t flags) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  Editor& ed = e->editor;
  std::vector<Guid> vars;
  if (collLen) {
    Guid c = parseRef(collPtr, collLen);
    const Node* n = ed.document().get(c);
    if (!n || n->props.type != NodeType::VARIABLE_SET) return E_NOT_FOUND;
    vars = ed.variablesOf(ed.rootCollection(c));  // an extended collection: its root's variables
  } else {
    for (Guid c : ed.collections((flags & 1) != 0))
      for (Guid v : ed.variablesOf(c)) vars.push_back(v);
  }
  json::Writer w;
  w.beginArray();
  for (Guid v : vars) writeVariableInfo(w, ed, v);
  w.endArray();
  return setResult(w.take());
}

ENG_EXPORT int32_t engine_variable(Handle h, Ptr idPtr, uint32_t idLen) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  Guid v = parseRef(idPtr, idLen);
  const Node* n = e->editor.document().get(v);
  if (!n || n->props.type != NodeType::VARIABLE) return E_NOT_FOUND;
  json::Writer w;
  writeVariableInfo(w, e->editor, v);
  return setResult(w.take());
}

// Figma's resolveForConsumer; consumer empty = the default modes. Result: the value, or null.
ENG_EXPORT int32_t engine_resolve_variable(Handle h, Ptr varPtr, uint32_t varLen, Ptr consumerPtr, uint32_t consumerLen) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  Guid v = parseRef(varPtr, varLen);
  Guid consumer = consumerLen ? parseRef(consumerPtr, consumerLen) : kNoGuid;
  Editor::Resolved r;
  bool ok = e->editor.resolveVariable(v, consumer, r);
  json::Writer w;
  writeResolved(w, r, ok);
  return setResult(w.take());
}

ENG_EXPORT int32_t engine_bound_variables(Handle h, Ptr refPtr, uint32_t refLen) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  Guid id = parseRef(refPtr, refLen);
  if (!e->editor.document().has(id)) return E_NOT_FOUND;
  json::Writer w;
  w.beginArray();
  for (auto& b : e->editor.boundVariables(id)) {
    w.beginObject().key("target").string(b.target).key("variable");
    if (b.variable == kNoGuid) w.null();
    else w.string(b.variable.toString());
    w.key("value");
    writeVariableValue(w, b.value, e->editor);
    w.key("resolved");
    writeResolved(w, b.resolved, b.ok);
    w.endObject();
  }
  w.endArray();
  return setResult(w.take());
}

ENG_EXPORT int32_t engine_resolved_value(Handle h, Ptr refPtr, uint32_t refLen, Ptr targetPtr, uint32_t targetLen) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  Guid id = parseRef(refPtr, refLen);
  if (!e->editor.document().has(id)) return E_NOT_FOUND;
  Editor::Resolved r;
  bool ok = e->editor.resolvedValue(id, std::string(bytes(targetPtr, targetLen)), r);
  json::Writer w;
  writeResolved(w, r, ok);
  return setResult(w.take());
}

// Every collection's mode for a layer or a page: [{collectionId, explicitModeId, resolvedModeId}].
ENG_EXPORT int32_t engine_variable_modes(Handle h, Ptr refPtr, uint32_t refLen) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  Editor& ed = e->editor;
  Guid id = parseRef(refPtr, refLen);
  const Node* n = ed.document().get(id);
  if (!n) return E_NOT_FOUND;
  json::Writer w;
  w.beginArray();
  for (Guid c : ed.collections(true)) {
    Guid explicitMode = ed.explicitModeOf(id, c);
    bool valid = explicitMode != kNoGuid;
    w.beginObject().key("collectionId").string(c.toString()).key("explicitModeId");
    if (!valid) w.null();
    else w.string(explicitMode.toString());
    Guid resolved = ed.resolvedMode(id, c);
    w.key("resolvedModeId");
    if (resolved == kNoGuid) w.null();
    else w.string(resolved.toString());
    w.endObject();
  }
  w.endArray();
  return setResult(w.take());
}

// type: a StyleType value (FILL 1, TEXT 3, EFFECT 4, GRID 6); 0 = every style. flags: INCLUDE_REMOTE (1).
ENG_EXPORT int32_t engine_styles(Handle h, uint32_t type, uint32_t flags) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  Editor& ed = e->editor;
  json::Writer w;
  w.beginArray();
  for (Guid s : ed.stylesOf(static_cast<StyleType>(type), (flags & 1) != 0)) {
    const NodeProps& p = ed.document().get(s)->props;
    w.beginObject().key("id").string(s.toString()).key("name").string(p.name).key("styleType").string(enumName(p.asset().styleType));
    w.key("description").string(p.asset().description).key("key").string(p.asset().key);
    w.key("hiddenFromPublishing").boolean(!p.asset().isPublishable || (!p.name.empty() && (p.name[0] == '_' || p.name[0] == '.')));
    w.key("usageCount").number(ed.styleUsage(s));
    writeRemote(w, ed, s);
    switch (p.asset().styleType) {
      case StyleType::FILL:
        w.key("fillPaints");
        codec::writePaints(w, p.fillPaints);
        break;
      case StyleType::EFFECT:
        w.key("effects");
        codec::writeEffects(w, p.effects);
        break;
      case StyleType::GRID:
        w.key("layoutGrids");
        codec::writeLayoutGrids(w, p.rare().layoutGrids);
        break;
      case StyleType::TEXT:
        w.key("text").beginObject().key("fontName").beginObject();
        w.key("family").string(p.text().fontName.family).key("style").string(p.text().fontName.style).key("postscript").string(p.text().fontName.postscript);
        w.endObject().key("fontSize").number(p.text().fontSize);
        w.key("lineHeight").beginObject().key("value").number(p.text().lineHeight.value).key("units").string(enumName(p.text().lineHeight.units)).endObject();
        w.key("letterSpacing").beginObject().key("value").number(p.text().letterSpacing.value).key("units").string(enumName(p.text().letterSpacing.units)).endObject();
        w.key("paragraphSpacing").number(p.text().paragraphSpacing).key("paragraphIndent").number(p.text().paragraphIndent);
        w.key("textCase").string(enumName(p.text().textCase)).key("textDecoration").string(enumName(p.text().textDecoration));
        w.endObject();
        break;
      default: break;
    }
    w.key("boundVariables").beginArray();
    for (auto& b : ed.boundVariables(s)) {
      w.beginObject().key("target").string(b.target).key("variable");
      if (b.variable == kNoGuid) w.null();
      else w.string(b.variable.toString());
      w.key("value");
      writeVariableValue(w, b.value, ed);
      w.key("resolved");
      writeResolved(w, b.resolved, b.ok);
      w.endObject();
    }
    w.endArray();
    w.endObject();
  }
  w.endArray();
  return setResult(w.take());
}

// How many layers use a style (≥ 0), or a status.
ENG_EXPORT int32_t engine_style_usage(Handle h, Ptr idPtr, uint32_t idLen) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  Guid s = parseRef(idPtr, idLen);
  const Node* n = e->editor.document().get(s);
  if (!n || !n->props.isStyle()) return E_NOT_FOUND;
  return static_cast<int32_t>(e->editor.styleUsage(s));
}

// The fonts the document names (text, its runs, instance overrides; text styles too), each with its number of
// uses: [{family, style, uses}] sorted by family and style. The Missing fonts dialog and the font picker's
// "In this file" read it (docs/engine-build.md "Fonts").
ENG_EXPORT int32_t engine_document_fonts(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Writer w;
  w.beginArray();
  for (const Editor::DocumentFont& f : e->editor.documentFonts())
    w.beginObject().key("family").string(f.font.family).key("style").string(f.font.style).key("uses").number(f.uses).endObject();
  w.endArray();
  return setResult(w.take());
}

// ---- Libraries (docs/data.md §9, docs/engine-build.md "E6 libraries") ---------------------------

namespace {

void writeAssetCommon(json::Writer& w, const Editor& ed, const Editor::AssetInfo& a) {
  w.key("id").string(a.id.toString()).key("key").string(a.key).key("kind").string(Editor::assetKindName(a.kind));
  w.key("name").string(a.name).key("description").string(a.description);
  if (a.kind == Editor::AssetKind::STYLE) w.key("styleType").string(enumName(a.styleType));
  if (a.hasResolvedType) w.key("resolvedType").string(enumName(a.resolvedType));
  if (a.owner != kNoGuid) {
    bool set = a.kind == Editor::AssetKind::COMPONENT;
    w.key(set ? "componentSetKey" : "collectionKey").string(a.ownerKey);
    w.key(set ? "componentSetId" : "collectionId").string(a.owner.toString());
  }
  (void)ed;
}

void writeLocalAsset(json::Writer& w, const Editor& ed, const Editor::AssetInfo& a) {
  writeAssetCommon(w, ed, a);
  w.key("hiddenFromPublishing").boolean(a.hidden).key("softDeleted").boolean(a.softDeleted);
  w.key("versionHash").string(a.versionHash).key("publishedVersion");
  if (a.publishedVersion.empty()) w.null();
  else w.string(a.publishedVersion);
  w.key("dependencies").beginArray();
  for (const std::string& k : a.dependencies) w.string(k);
  w.endArray().key("containingFrame");
  if (a.pageId == kNoGuid) {
    w.null();
  } else {
    w.beginObject().key("pageId").string(a.pageId.toString()).key("pageName").string(a.pageName);
    if (a.frameId != kNoGuid) w.key("frameId").string(a.frameId.toString()).key("frameName").string(a.frameName);
    w.endObject();
  }
}

std::vector<std::string> readStrings(const json::Value& v, const char* member) {
  const json::Value* list = v.isArray() ? &v : v.get(member);
  std::vector<std::string> out;
  if (list && list->isArray())
    for (auto& e : list->array)
      if (e.isString()) out.push_back(e.string);
  return out;
}

// A Message, an array of Messages, or {"messages": [...]}: each Message's changes (blobs resolved).
std::vector<std::vector<NodeChange>> readMessages(const json::Value& v) {
  std::vector<std::vector<NodeChange>> out;
  const json::Value* list = v.isArray() ? &v : v.get("messages");
  if (list && list->isArray()) {
    for (auto& m : list->array) out.push_back(codec::readMessage(m));
  } else {
    out.push_back(codec::readMessage(v));
  }
  return out;
}

// Library payloads: a kiwi message list (0x00, varuint count, count × (varuint length, Message)), one kiwi Message,
// or the interim JSON ({"messages": […]}, an array, or one Message).
bool readLibraryMessages(Ptr ptr, uint32_t len, std::vector<std::vector<NodeChange>>& out) {
  std::string_view in = bytes(ptr, len);
  if (codec::isMessageList(in)) {
    std::vector<codec::KiwiMessage> list;
    if (!codec::readMessageList(in, list)) {
      setError("the payload is not a valid kiwi message list");
      return false;
    }
    for (auto& m : list) out.push_back(std::move(m.changes));
    return true;
  }
  if (codec::looksKiwi(in)) {
    codec::KiwiMessage m;
    if (!codec::readMessage(in, m)) {
      setError("the payload is not a valid kiwi Message");
      return false;
    }
    out.push_back(std::move(m.changes));
    return true;
  }
  json::Value msg;
  if (!parse(ptr, len, msg)) return false;
  out = readMessages(msg);
  return true;
}

int32_t libraryImport(Handle h, Ptr msgPtr, uint32_t msgLen, Ptr optsPtr, uint32_t optsLen, bool update) {
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  std::vector<std::vector<NodeChange>> messages;
  json::Value opts;
  if (!readLibraryMessages(msgPtr, msgLen, messages) || !parse(optsPtr, optsLen, opts)) return E_DECODE;
  Editor::LibraryOptions o;
  o.update = update;
  if (auto* k = opts.get("libraryKey"); k && k->isString()) o.libraryKey = k->string;
  if (auto* keys = opts.get("keys"); keys && keys->isArray()) {
    o.hasKeys = true;
    o.keys = readStrings(*keys, "keys");
  }
  if (auto* r = opts.get("redirects"); r && r->isArray())
    for (auto& x : r->array) {
      auto* from = x.get("fromKey");
      auto* to = x.get("toKey");
      auto* fromLib = x.get("fromLibraryKey");
      if (from && to && from->isString() && to->isString())
        o.redirects.push_back({from->string, to->string, fromLib && fromLib->isString() ? fromLib->string : std::string()});
    }
  if (auto* n = opts.get("asNew"); n && n->isBool()) o.asNew = n->boolean;
  if (auto* c = opts.get("copies"); c && c->isArray()) {
    o.hasCopies = true;
    o.copies = readRefs(*c);
  }
  std::vector<Editor::ImportedAsset> imported;
  std::vector<ImageHash> images;
  int32_t status = e->editor.importLibrary(messages, o, imported, &images);
  json::Writer w;
  w.beginObject().key("status").number(status).key("assets").beginArray();
  for (auto& a : imported) {
    w.beginObject().key("key").string(a.key).key("id").string(a.id.toString()).key("kind").string(Editor::assetKindName(a.kind));
    w.key("libraryKey").string(a.libraryKey).key("version").string(a.version);
    w.key("created").boolean(a.created).key("updated").boolean(a.updated).endObject();
  }
  w.endArray().key("images").beginArray();
  for (const ImageHash& i : images) w.string(i.hex());
  w.endArray().endObject();
  setResult(w.take());
  return status;
}

}  // namespace

ENG_EXPORT int32_t engine_set_file_key(Handle h, Ptr ptr, uint32_t len) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  e->editor.setFileKey(std::string(bytes(ptr, len)));
  return OK;
}

// refs: a NodeRefList (empty = every local asset). Result: [{id, key}].
ENG_EXPORT int32_t engine_ensure_asset_keys(Handle h, Ptr refsPtr, uint32_t refsLen) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  std::vector<Guid> refs;
  if (refsLen) {
    json::Value v;
    if (!parse(refsPtr, refsLen, v)) return E_DECODE;
    refs = readRefs(v);
  }
  if (e->editor.busy()) return E_BUSY;
  json::Writer w;
  w.beginArray();
  for (auto& [id, key] : e->editor.ensureAssetKeys(refs)) w.beginObject().key("id").string(id.toString()).key("key").string(key).endObject();
  w.endArray();
  return setResult(w.take());
}

ENG_EXPORT int32_t engine_local_assets(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Writer w;
  w.beginArray();
  for (auto& a : e->editor.localAssets()) {
    w.beginObject();
    writeLocalAsset(w, e->editor, a);
    w.endObject();
  }
  w.endArray();
  return setResult(w.take());
}

// keys: a JSON array of asset keys (or {"keys": [...]}). Result: {assets: EncodedAsset[], images: hash[]}.
ENG_EXPORT int32_t engine_encode_assets(Handle h, Ptr keysPtr, uint32_t keysLen) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Value v;
  if (!parse(keysPtr, keysLen, v)) return E_DECODE;
  if (e->editor.busy()) return E_BUSY;
  std::vector<Editor::EncodedAsset> assets;
  std::vector<ImageHash> images;
  e->editor.encodeAssets(readStrings(v, "keys"), assets, images);
  json::Writer w;
  e->attachments.clear();
  w.beginObject().key("assets").beginArray();
  for (auto& a : assets) {
    w.beginObject();
    writeLocalAsset(w, e->editor, a.info);
    w.key("dependencyOnly").boolean(a.dependencyOnly).key("images").beginArray();
    for (const ImageHash& i : a.images) w.string(i.hex());
    w.endArray();
    if (e->wire == WIRE_KIWI) {
      // The payload as kiwi bytes (sessionID 0, as a library payload is), fetched with engine_attachment(payload).
      w.key("payload").number(static_cast<double>(e->attachments.size()));
      e->attachments.push_back(codec::writeMessage(0, a.nodes));
    } else {
      w.key("message").beginObject().key("type").string("NODE_CHANGES").key("sessionID").number(0).key("nodeChanges");
      codec::BlobsOut blobs;
      codec::writeChanges(w, a.nodes, &blobs);
      blobs.writeMember(w);
      w.endObject();
    }
    w.endObject();
  }
  w.endArray().key("images").beginArray();
  for (const ImageHash& i : images) w.string(i.hex());
  w.endArray().endObject();
  return setResult(w.take());
}

// [{key, versionHash}] (or {"entries": [...]}); versionHash null (or ""): the version removed that asset.
ENG_EXPORT int32_t engine_mark_published(Handle h, Ptr ptr, uint32_t len) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Value v;
  if (!parse(ptr, len, v)) return E_DECODE;
  const json::Value* list = v.isArray() ? &v : v.get("entries");
  std::vector<Editor::PublishedEntry> entries;
  if (list && list->isArray())
    for (auto& x : list->array) {
      auto* k = x.get("key");
      auto* hash = x.get("versionHash");
      if (!k || !k->isString() || k->string.empty()) continue;
      if (hash && hash->isString()) entries.push_back({k->string, hash->string});
      else if (!hash || hash->isNull()) entries.push_back({k->string, std::string()});
    }
  return e->editor.markPublished(entries);
}

// msg: a Message, an array of them or {"messages": [...]}; opts: {libraryKey, asNew?, keys?}. Result: LibraryImportResult.
ENG_EXPORT int32_t engine_import_library_assets(Handle h, Ptr msgPtr, uint32_t msgLen, Ptr optsPtr, uint32_t optsLen) {
  Call call;
  return libraryImport(h, msgPtr, msgLen, optsPtr, optsLen, false);
}

// The same, opts {libraryKey, keys?, copies?: Guid[], redirects?: [{fromKey, toKey, fromLibraryKey?}]}: one undo step.
ENG_EXPORT int32_t engine_apply_library_update(Handle h, Ptr msgPtr, uint32_t msgLen, Ptr optsPtr, uint32_t optsLen) {
  Call call;
  return libraryImport(h, msgPtr, msgLen, optsPtr, optsLen, true);
}

ENG_EXPORT int32_t engine_library_usage(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  json::Writer w;
  w.beginArray();
  for (auto& a : e->editor.libraryUsage()) {
    w.beginObject();
    writeAssetCommon(w, e->editor, a);
    w.key("libraryKey").string(a.libraryKey).key("version").string(a.version).key("publishID");
    if (a.publishID == kNoGuid) w.null();
    else w.string(a.publishID.toString());
    w.key("usageCount").number(a.usage).endObject();
  }
  w.endArray();
  return setResult(w.take());
}

// ---- Export (E7) ----
#include "export/ExportApi.inc"

// ---- Prototyping (docs/engine-build.md "E8") ------------------------------------------------------------------

// The editor's Prototype tab: connections, "+" handles and flow labels on the canvas (on = 1).
// Viewer mode (developer previews): read-only, no resize handles (on = 1).
ENG_EXPORT void engine_set_viewer_mode(Handle h, uint32_t on) {
  Call call;
  Engine* e = engineOf(h);
  if (e) e->editor.setViewerMode(on != 0);
}

ENG_EXPORT void engine_set_prototype_mode(Handle h, uint32_t on) {
  Call call;
  Engine* e = engineOf(h);
  if (e) e->editor.setPrototypeMode(on != 0);
}

// Starts the presentation view on page (pageSess, pageLocal) at node (nodeSess, nodeLocal) — a top-level frame or a
// layer in one; (0xffffffff, 0xffffffff): the first flow's start, else the first frame.
ENG_EXPORT int32_t engine_present_start(Handle h, uint32_t pageSessionID, uint32_t pageLocalID, uint32_t nodeSessionID, uint32_t nodeLocalID) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  if (!e->player) e->player = std::make_unique<proto::Player>(e->editor);
  Guid page{pageSessionID, pageLocalID};
  if (page == kNoGuid) page = e->editor.page();
  // No content cache: the presentation's frames are drawn whole.
  e->renderer->setContentCache(false);
  if (!e->player->start(page, Guid{nodeSessionID, nodeLocalID})) return E_NOT_FOUND;
  return OK;
}

ENG_EXPORT void engine_present_stop(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  if (!e || !e->player) return;
  e->player->stop();
  e->renderer->setContentCache(!e->selector.empty());
  e->editor.invalidateCanvas();
}

// type: PointerEvent (0 down, 1 move, 2 up, 3 cancel, 4 enter, 5 leave); CSS px in the canvas. 1: handled.
ENG_EXPORT uint32_t engine_present_pointer(Handle h, uint32_t type, double x, double y, uint32_t buttons, uint32_t mods) {
  Call call;
  Engine* e = engineOf(h);
  if (!e || !e->presenting()) return 0;
  return e->player->pointer(static_cast<PointerEvent>(type), x, y, buttons, mods);
}

ENG_EXPORT uint32_t engine_present_wheel(Handle h, double x, double y, double dx, double dy, uint32_t deltaMode) {
  Call call;
  Engine* e = engineOf(h);
  if (!e || !e->presenting()) return 0;
  double unit = deltaMode == 1 ? 16 : deltaMode == 2 ? std::max(1.0, e->editor.viewport().height) : 1;
  return e->player->wheel(x, y, dx * unit, dy * unit);
}

// type 0 down, 1 up; keyCode: the JS keyCode (Figma's keyTrigger codes). 1: handled.
ENG_EXPORT uint32_t engine_present_key(Handle h, uint32_t type, uint32_t keyCode, uint32_t mods) {
  Call call;
  Engine* e = engineOf(h);
  if (!e || !e->presenting()) return 0;
  return e->player->key(type == 0, static_cast<int>(keyCode), mods);
}

// 0 restart, 1 next frame, 2 previous frame, 3 back, 4 cycle the scale option. 0: done, E_INVALID: nothing to do.
ENG_EXPORT int32_t engine_present_command(Handle h, uint32_t command) {
  Call call;
  Engine* e = engineOf(h);
  if (!e || !e->presenting()) return E_HANDLE;
  proto::Player& p = *e->player;
  switch (command) {
    case 0: p.restart(); return OK;
    case 1: return p.next() ? OK : E_INVALID;
    case 2: return p.previous() ? OK : E_INVALID;
    case 3: return p.back() ? OK : E_INVALID;
    case 4: p.cycleScale(); return OK;
    default: return E_INVALID;
  }
}

// {"scale": "ACTUAL" | "FIT_WIDTH" | "FIT" | "FILL", "hints": bool}
ENG_EXPORT int32_t engine_present_set_options(Handle h, Ptr ptr, uint32_t len) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  if (!e->player) e->player = std::make_unique<proto::Player>(e->editor);
  json::Value v;
  if (!json::parse(bytes(ptr, len), v) || !v.isObject()) return E_DECODE;
  if (auto* s = v.get("scale"); s && s->isString()) {
    const char* names[] = {"ACTUAL", "FIT_WIDTH", "FIT", "FILL", "RESPONSIVE"};
    for (int i = 0; i < 5; i++)
      if (s->string == names[i]) e->player->setScale(static_cast<proto::ScaleMode>(i));
  }
  if (auto* hints = v.get("hints"); hints && hints->isBool()) e->player->setHints(hints->boolean);
  // With a device: Responsive / Fixed size, Show device frame.
  if (auto* r = v.get("responsive"); r && r->isBool()) e->player->setResponsive(r->boolean);
  if (auto* f = v.get("deviceFrame"); f && f->isBool()) e->player->setDeviceFrame(f->boolean);
  e->editor.invalidateCanvas();
  return OK;
}

// The videos the presentation shows and what each should do (Player::mediaJson): {"videos": [{id, hash, playing,
// muted, loop, time, duration, ended, seek, seekSerial}]}. The page plays them (a <video> per id) and reports back with
// engine_present_media_frame.
ENG_EXPORT int32_t engine_present_media(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  if (!e->player) return setResult("{\"videos\":[]}");
  return setResult(e->player->mediaJson());
}

// A video's report: its time and length (seconds), flags 1 = ended, the last seek it made (`seekSerial`), and a new
// frame — Module.engineBitmaps[bitmapId] is its <video> (0: no new frame), width × height its size. The frame is drawn
// in place of the poster; the time fires "When video hits" / "When video ends".
ENG_EXPORT int32_t engine_present_media_frame(Handle h, uint32_t sessionID, uint32_t localID, uint32_t bitmapId, uint32_t width, uint32_t height,
                                              double time, double duration, uint32_t flags, uint32_t seekSerial) {
  Call call;
  Engine* e = engineOf(h);
  if (!e || !e->presenting()) return E_HANDLE;
  e->player->mediaFrame(Guid{sessionID, localID}, bitmapId, width, height, time, duration, (flags & 1) != 0, seekSerial);
  return OK;
}

// The presentation's state (stateJson) and the events since the last call: {…, "events": [{"type": "CHANGED"} |
// {"type": "OPEN_URL", "url", "newTab"}]}.
ENG_EXPORT int32_t engine_present_state(Handle h) {
  Call call;
  Engine* e = engineOf(h);
  if (!e) return E_HANDLE;
  if (!e->player) return setResult("{\"active\":false,\"events\":[]}");
  std::string state = e->player->stateJson();
  json::Writer w;
  w.beginArray();
  for (auto& ev : e->player->takeEvents()) {
    w.beginObject();
    if (ev.kind == proto::Player::Event::Kind::OPEN_URL) w.key("type").string("OPEN_URL").key("url").string(ev.url).key("newTab").boolean(ev.newTab);
    else w.key("type").string("CHANGED");
    w.endObject();
  }
  w.endArray();
  state.pop_back();  // the closing brace
  state += ",\"events\":" + w.take() + "}";
  return setResult(std::move(state));
}
