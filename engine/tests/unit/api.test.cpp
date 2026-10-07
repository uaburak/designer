// The C ABI natively (headless engine): the same calls the TS wrapper makes.
#include <cstring>
#include <string>

#include "base/Json.h"
#include "doctest.h"
#include "editor/Keys.h"

using Ptr = uintptr_t;
using Handle = uintptr_t;

extern "C" {
uint32_t engine_abi_version();
Ptr engine_result_ptr();
uint32_t engine_result_len();
Ptr engine_events_flag_ptr();
Handle engine_create(const char* selector, Ptr optsPtr, uint32_t optsLen);
void engine_destroy(Handle h);
int32_t engine_load(Handle h, Ptr ptr, uint32_t len);
int32_t engine_apply_changes(Handle h, Ptr ptr, uint32_t len, uint32_t flags);
int32_t engine_encode_document(Handle h, uint32_t flags);
int32_t engine_pages(Handle h);
void engine_set_viewport(Handle h, double cssW, double cssH, double dpr, uint32_t pxW, uint32_t pxH);
uint32_t engine_pointer(Handle h, uint32_t type, double x, double y, uint32_t button, uint32_t buttons, uint32_t mods,
                        double pressure, uint32_t clickCount, uint32_t pointerType, double timeMs);
uint32_t engine_key(Handle h, uint32_t type, uint32_t keyCode, uint32_t codepoint, uint32_t mods, uint32_t repeat);
uint32_t engine_tick(Handle h, double timeMs);
void engine_render(Handle h);
uint32_t engine_needs_frame(Handle h);
int32_t engine_get_selection(Handle h);
int32_t engine_read_nodes(Handle h, Ptr ptr, uint32_t len, uint32_t flags);
int32_t engine_hit_test(Handle h, double x, double y, uint32_t flags);
int32_t engine_set_props(Handle h, Ptr refsPtr, uint32_t refsLen, Ptr changePtr, uint32_t changeLen, uint32_t flags);
int32_t engine_command(Handle h, uint32_t commandId, Ptr argsPtr, uint32_t argsLen);
int32_t engine_take_events(Handle h);
int32_t engine_stats(Handle h);
int32_t engine_set_tool(Handle h, uint32_t tool);
int32_t engine_set_selection(Handle h, Ptr ptr, uint32_t len);
int32_t engine_command_state(Handle h, uint32_t commandId);
int32_t engine_move_nodes(Handle h, Ptr refsPtr, uint32_t refsLen, uint32_t parentSessionID, uint32_t parentLocalID, uint32_t index);
int32_t engine_encode_selection(Handle h, uint32_t flags);
int32_t engine_paste(Handle h, Ptr ptr, uint32_t len, uint32_t flags);
int32_t engine_render_thumbnail(Handle h, uint32_t pageSessionID, uint32_t pageLocalID, uint32_t maxSize, uint32_t flags);
int32_t engine_layer_tree(Handle h, uint32_t pageSessionID, uint32_t pageLocalID);
int32_t engine_font_bind(Ptr familyPtr, uint32_t familyLen, Ptr stylePtr, uint32_t styleLen, int32_t faceId);
void engine_font_missing(Ptr familyPtr, uint32_t familyLen, Ptr stylePtr, uint32_t styleLen);
int32_t engine_next_frame_delay(Handle h);
}

namespace {

struct Payload {
  std::string text;
  Ptr ptr() const { return reinterpret_cast<Ptr>(text.data()); }
  uint32_t len() const { return static_cast<uint32_t>(text.size()); }
};

std::string result() { return std::string(reinterpret_cast<const char*>(engine_result_ptr()), engine_result_len()); }

eng::json::Value resultJson() {
  eng::json::Value v;
  REQUIRE(eng::json::parse(result(), v));
  return v;
}

const char* kDoc = R"({"type":"NODE_CHANGES","sessionID":0,"nodeChanges":[
  {"guid":"0:0","phase":"CREATED","type":"DOCUMENT","name":"Document"},
  {"guid":"0:1","phase":"CREATED","type":"CANVAS","name":"Page 1","parentIndex":{"guid":"0:0","position":"!"}},
  {"guid":"0:2","phase":"CREATED","type":"CANVAS","name":"Internal Only Canvas","internalOnly":true,"visible":false,"parentIndex":{"guid":"0:0","position":"~"}},
  {"guid":"1:1","phase":"CREATED","type":"FRAME","name":"Frame 1","parentIndex":{"guid":"0:1","position":"!"},
   "size":{"x":200,"y":200},"fillPaints":[{"type":"SOLID","color":{"r":1,"g":1,"b":1,"a":1}}]},
  {"guid":"1:2","phase":"CREATED","type":"ROUNDED_RECTANGLE","name":"Rectangle 1","parentIndex":{"guid":"1:1","position":"!"},
   "size":{"x":50,"y":50},"transform":{"m00":1,"m01":0,"m02":10,"m10":0,"m11":1,"m12":10},
   "fillPaints":[{"type":"SOLID","color":{"r":0.85,"g":0.85,"b":0.85,"a":1}}]}
]})";

}  // namespace

TEST_CASE("api: the headless engine end to end") {
  CHECK(engine_abi_version() == 1);
  Payload opts{R"({"sessionID":7,"theme":"DARK"})"};
  Handle h = engine_create(nullptr, opts.ptr(), opts.len());
  REQUIRE(h != 0);
  Payload doc{kDoc};
  REQUIRE(engine_load(h, doc.ptr(), doc.len()) == 0);
  engine_set_viewport(h, 800, 600, 2, 1600, 1200);
  auto* flag = reinterpret_cast<const uint32_t*>(engine_events_flag_ptr());
  CHECK(*flag != 0);
  REQUIRE(engine_take_events(h) == 0);
  {
    auto v = resultJson();
    bool sawPages = false;
    for (auto& e : v.get("events")->array) sawPages |= e.get("type")->string == "PAGES_CHANGED";
    CHECK(sawPages);
  }
  CHECK(*flag == 0);

  REQUIRE(engine_pages(h) == 0);
  CHECK(result() == R"({"pages":[{"guid":"0:1","name":"Page 1"}]})");

  // Click the rectangle: selection, then a drag: one DOCUMENT_CHANGED.
  uint32_t r = engine_pointer(h, 0, 20, 20, 0, 1, 0, 0.5, 1, 0, 0);
  CHECK(r == 3);  // HANDLED | CAPTURE
  engine_pointer(h, 1, 40, 20, 0, 1, 0, 0.5, 1, 0, 1);
  engine_pointer(h, 1, 60, 30, 0, 1, 0, 0.5, 1, 0, 2);
  engine_pointer(h, 2, 60, 30, 0, 0, 0, 0, 1, 0, 3);
  REQUIRE(engine_take_events(h) == 0);
  auto v = resultJson();
  std::string types;
  for (auto& e : v.get("events")->array) types += e.get("type")->string + " ";
  CHECK(types.find("DOCUMENT_CHANGED") != std::string::npos);
  CHECK(types.find("SELECTION_CHANGED") != std::string::npos);
  CHECK(types.find("NODES_CHANGED") != std::string::npos);
  CHECK(types.find("UNDO_STATE") != std::string::npos);
  for (auto& e : v.get("events")->array)
    if (e.get("type")->string == "DOCUMENT_CHANGED") {
      CHECK(e.get("kind")->string == "USER");
      CHECK(e.get("label")->string == "Move");
      auto& changes = e.get("message")->get("nodeChanges")->array;
      REQUIRE(changes.size() == 1);
      CHECK(changes[0].get("guid")->string == "1:2");
      CHECK(changes[0].get("transform")->get("m02")->number == 50);
      CHECK(changes[0].get("name") == nullptr);
    }

  REQUIRE(engine_get_selection(h) == 0);
  CHECK(result() == R"({"pageId":"0:1","refs":["1:2"]})");

  // Reads for panels.
  Payload refs{R"({"refs":["1:1"]})"};
  REQUIRE(engine_read_nodes(h, refs.ptr(), refs.len(), 1) == 0);
  auto read = resultJson();
  auto& node = read.get("nodeChanges")->array.at(0);
  CHECK(node.get("name")->string == "Frame 1");
  CHECK(node.get("childIds")->array.at(0).string == "1:2");

  // The generic setter, then undo through a command.
  Payload sel{R"({"refs":["1:2"]})"};
  Payload change{R"({"name":"Hero","opacity":0.5})"};
  REQUIRE(engine_set_props(h, sel.ptr(), sel.len(), change.ptr(), change.len(), 0) == 0);
  engine_read_nodes(h, sel.ptr(), sel.len(), 0);
  CHECK(resultJson().get("nodeChanges")->array.at(0).get("name")->string == "Hero");
  REQUIRE(engine_command(h, 1, 0, 0) == 0);  // UNDO
  engine_read_nodes(h, sel.ptr(), sel.len(), 0);
  CHECK(resultJson().get("nodeChanges")->array.at(0).get("name")->string == "Rectangle 1");

  // Hit test: innermost first.
  REQUIRE(engine_hit_test(h, 55, 25, 0) == 0);
  CHECK(result() == R"({"refs":["1:2","1:1"]})");

  // Keys: arrows are the engine's; letters are not.
  CHECK(engine_key(h, 0, static_cast<uint32_t>(eng::KeyCode::ArrowRight), 0, 0, 0) == 1);
  CHECK(engine_key(h, 0, static_cast<uint32_t>(eng::KeyCode::KeyR), 'r', 0, 0) == 0);
  CHECK(engine_set_tool(h, 6) == 0);  // RECTANGLE

  // Frames: render on demand.
  CHECK(engine_tick(h, 16) == 1);
  engine_render(h);
  CHECK(engine_needs_frame(h) == 0);
  REQUIRE(engine_stats(h) == 0);
  auto stats = resultJson();
  CHECK(stats.get("drawCalls")->number >= 1);

  // The snapshot: DOCUMENT first, parents before children.
  REQUIRE(engine_encode_document(h, 0) == 0);
  auto snap = resultJson();
  auto& all = snap.get("nodeChanges")->array;
  REQUIRE(all.size() == 5);
  CHECK(all[0].get("guid")->string == "0:0");
  CHECK(all[1].get("guid")->string == "0:1");

  // Apply a remote change, a bad payload, a bad handle.
  Payload remote{R"({"nodeChanges":[{"guid":"1:2","phase":"REMOVED"}]})"};
  CHECK(engine_apply_changes(h, remote.ptr(), remote.len(), 2) == 0);
  Payload bad{"{nope"};
  CHECK(engine_apply_changes(h, bad.ptr(), bad.len(), 1) == -2);
  CHECK(engine_load(12345, doc.ptr(), doc.len()) == -1);
  engine_destroy(h);
}

TEST_CASE("api: editor support — page args, moveNodes, encodeSelection, paste") {
  Payload opts{R"({"sessionID":7})"};
  Handle h = engine_create(nullptr, opts.ptr(), opts.len());
  REQUIRE(h != 0);
  Payload doc{kDoc};
  REQUIRE(engine_load(h, doc.ptr(), doc.len()) == 0);
  engine_set_viewport(h, 800, 600, 1, 800, 600);

  // Pages: CREATE_PAGE, DUPLICATE_PAGE {"page":"0:1"}, DELETE_PAGE with the numeric form.
  CHECK(engine_command(h, 90, 0, 0) == 0);
  Payload dup{R"({"page":"0:1"})"};
  CHECK(engine_command(h, 92, dup.ptr(), dup.len()) == 0);
  REQUIRE(engine_pages(h) == 0);
  auto pages = resultJson().get("pages")->array;
  REQUIRE(pages.size() == 3);
  CHECK(pages[1].get("name")->string == "Page 1 copy");
  std::string copy = pages[1].get("guid")->string;
  auto colon = copy.find(':');
  std::string numeric = R"({"page":)" + copy.substr(colon + 1) + R"(,"pageSession":)" + copy.substr(0, colon) + "}";
  Payload del{numeric};
  CHECK(engine_command(h, 91, del.ptr(), del.len()) == 0);
  REQUIRE(engine_pages(h) == 0);
  CHECK(resultJson().get("pages")->array.size() == 2);
  Payload bad{R"({"page":"nope"})"};
  CHECK(engine_command(h, 91, bad.ptr(), bad.len()) == -3);
  CHECK(engine_command_state(h, 91) == 1);

  // Back on page 1: move the rectangle out of the frame onto the page.
  Payload moving{R"({"refs":["1:2"]})"};
  CHECK(engine_move_nodes(h, moving.ptr(), moving.len(), 0, 1, 1) == 1);
  Payload rect{R"({"refs":["1:2"]})"};
  engine_read_nodes(h, rect.ptr(), rect.len(), 0);
  auto node = resultJson().get("nodeChanges")->array.at(0);
  CHECK(node.get("parentIndex")->get("guid")->string == "0:1");
  CHECK(node.get("transform")->get("m02")->number == 10);
  CHECK(engine_move_nodes(h, moving.ptr(), moving.len(), 1, 2, 0) == 0);  // into itself

  // Copy: nothing selected, then the frame.
  CHECK(engine_encode_selection(h, 0) == -5);
  Payload frame{R"({"refs":["1:1"]})"};
  REQUIRE(engine_set_selection(h, frame.ptr(), frame.len()) == 0);
  REQUIRE(engine_encode_selection(h, 0) == 0);
  std::string clip = result();
  {
    eng::json::Value v;
    REQUIRE(eng::json::parse(clip, v));
    CHECK(v.get("nodeChanges")->array.size() == 1);
    CHECK(v.get("pastePageId")->string == "0:1");
    auto& region = v.get("clipboardSelectionRegions")->array.at(0);
    CHECK(region.get("parent")->string == "0:1");
    CHECK(region.get("nodes")->array.at(0).string == "1:1");
    CHECK(region.get("enclosingFrameOffset")->get("x")->number == 0);
  }
  // Paste in place: a fresh id from session 7, selected.
  Payload message{clip};
  CHECK(engine_paste(h, message.ptr(), message.len(), 1) == 1);
  REQUIRE(engine_get_selection(h) == 0);
  auto sel = resultJson().get("refs")->array;
  REQUIRE(sel.size() == 1);
  CHECK(sel[0].string.rfind("7:", 0) == 0);
  Payload junk{"{"};
  CHECK(engine_paste(h, junk.ptr(), junk.len(), 0) == -2);
  engine_destroy(h);
}

TEST_CASE("api: a page thumbnail fits its content, offscreen, without touching the canvas") {
  Payload opts{R"({"sessionID":1,"theme":"DARK"})"};
  Handle h = engine_create(nullptr, opts.ptr(), opts.len());
  REQUIRE(h != 0);
  Payload doc{kDoc};
  REQUIRE(engine_load(h, doc.ptr(), doc.len()) == 0);
  // Content: Frame 1, 200×200 at the origin → 64×64.
  REQUIRE(engine_render_thumbnail(h, 0xffffffffu, 0xffffffffu, 64, 0) == 0);
  std::string r = result();
  REQUIRE(r.size() == 8 + 64 * 64 * 4);
  auto u32 = [&](size_t at) {
    return static_cast<uint32_t>(static_cast<uint8_t>(r[at])) | static_cast<uint32_t>(static_cast<uint8_t>(r[at + 1])) << 8 |
           static_cast<uint32_t>(static_cast<uint8_t>(r[at + 2])) << 16 | static_cast<uint32_t>(static_cast<uint8_t>(r[at + 3])) << 24;
  };
  CHECK(u32(0) == 64);
  CHECK(u32(4) == 64);
  // The recording device returns the pass's clear colour: the dark theme's page colour, opaque.
  CHECK(static_cast<uint8_t>(r[8]) == 0x1e);
  CHECK(static_cast<uint8_t>(r[11]) == 255);
  // A wide page keeps its aspect: add a layer far to the right.
  Payload wide{R"({"nodeChanges":[{"guid":"1:9","phase":"CREATED","type":"ROUNDED_RECTANGLE","parentIndex":{"guid":"0:1","position":"~"},
    "size":{"x":100,"y":100},"transform":{"m00":1,"m01":0,"m02":700,"m10":0,"m11":1,"m12":0}}]})"};
  REQUIRE(engine_apply_changes(h, wide.ptr(), wide.len(), 2) == 0);
  REQUIRE(engine_render_thumbnail(h, 0, 1, 400, 0) == 0);
  r = result();
  CHECK(u32(0) == 400);
  CHECK(u32(4) == 100);
  // No such page; an empty page.
  CHECK(engine_render_thumbnail(h, 5, 5, 64, 0) == -5);
  CHECK(engine_command(h, 90, 0, 0) == 0);  // CREATE_PAGE: empty, and current
  CHECK(engine_render_thumbnail(h, 0xffffffffu, 0xffffffffu, 64, 0) == -5);
  engine_destroy(h);
}

TEST_CASE("api: the Layers tree of a page in one read") {
  Payload opts{R"({"sessionID":7})"};
  Handle h = engine_create(nullptr, opts.ptr(), opts.len());
  REQUIRE(h != 0);
  Payload doc{kDoc};
  REQUIRE(engine_load(h, doc.ptr(), doc.len()) == 0);
  REQUIRE(engine_layer_tree(h, 0, 1) == 0);
  auto v = resultJson();
  auto& nodes = v.get("nodes")->array;
  REQUIRE(nodes.size() == 3);  // the page, the frame, the rectangle: parents first
  CHECK(nodes[0].get("guid")->string == "0:1");
  CHECK(nodes[0].get("childIds")->array.at(0).string == "1:1");
  CHECK(nodes[1].get("type")->string == "FRAME");
  CHECK(nodes[1].get("name")->string == "Frame 1");
  CHECK(nodes[1].get("parentIndex")->get("guid")->string == "0:1");
  CHECK(nodes[2].get("visible")->boolean);
  CHECK(nodes[2].get("childIds")->array.empty());
  CHECK(nodes[2].get("fillPaints") == nullptr);  // only what a row shows
  CHECK(engine_layer_tree(h, 9, 9) == -5);  // E_NOT_FOUND: no such page
  engine_destroy(h);
}

TEST_CASE("api: fonts arriving in a burst are laid out once, at the next call that looks") {
  Payload opts{R"({"sessionID":7})"};
  Handle h = engine_create(nullptr, opts.ptr(), opts.len());
  REQUIRE(h != 0);
  Payload doc{kDoc};
  REQUIRE(engine_load(h, doc.ptr(), doc.len()) == 0);
  engine_tick(h, 0);
  engine_render(h);
  CHECK(engine_needs_frame(h) == 0);
  Payload family{"Nowhere Sans"}, style{"Regular"};
  engine_font_missing(family.ptr(), family.len(), style.ptr(), style.len());
  engine_font_missing(family.ptr(), family.len(), style.ptr(), style.len());
  // The relayout waits: a frame is wanted (it happens in engine_tick, or any call that reads the document).
  CHECK(engine_needs_frame(h) == 1);
  CHECK(engine_next_frame_delay(h) == 0);
  CHECK(engine_tick(h, 16) == 1);
  engine_render(h);
  CHECK(engine_needs_frame(h) == 0);
  engine_destroy(h);
}
