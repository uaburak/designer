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
