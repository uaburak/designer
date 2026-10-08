// Dev Mode in the engine (editor/DevMode.cpp, editor/Annotations.cpp, render/AnnotationOverlay.cpp): annotations read
// and drawn as labels with leader lines (or dots), saved measurements (the tool, commands, kiwi round trip), statuses on
// frame titles with the automatic "Changed" from editInfo, focus view.

#include "doctest.h"

#include "Helpers.h"
#include "TextHelpers.h"
#include "editor/Editor.h"
#include "gfx/null/NullDevice.h"
#include "render/Renderer.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid A{1, 10}, B{1, 11}, CHILD{1, 12}, TEXT_NODE{1, 13};

json::Value parse(const std::string& s) {
  json::Value v;
  REQUIRE(json::parse(s, v));
  return v;
}

std::string extraOf(const char* key, const std::string& jsonValue) { return codec::extraFromJson("NodeChange", key, parse(jsonValue)); }

// Two 200 × 100 frames side by side, a child in A.
std::vector<NodeChange> designs() {
  auto nodes = baseChanges();
  nodes.push_back(make(A, NodeType::FRAME, kPage, "a", {0, 0, 200, 100}, "Design A"));
  nodes.push_back(make(B, NodeType::FRAME, kPage, "b", {400, 0, 200, 100}, "Design B"));
  nodes.push_back(make(CHILD, NodeType::ROUNDED_RECTANGLE, A, "a", {20, 20, 60, 40}, "Card"));
  return nodes;
}

// Inter for the labels, and the module-wide font registry reset afterwards (like export.test.cpp): loadInter() loads
// once per run, and export.test.cpp (after this file) resets the registry.
struct Fonts {
  Fonts() {
    auto& fonts = text::FontRegistry::get();
    int32_t upright = addFontFile(std::string(ENG_FONTS_DIR) + "/InterVariable.ttf");
    for (const char* style : {"Regular", "Medium", "Semi Bold", "Bold"}) fonts.bind("Inter", style, upright);
    fonts.takeRequests();
  }
  ~Fonts() { text::FontRegistry::get().reset(); }
};

struct Fixture {
  Fonts fonts;
  Editor ed;
  gfx::NullDevice device;
  Renderer r{device};
  double now = 1000;
  explicit Fixture(std::vector<NodeChange> nodes) {
    ed.setViewport(1200, 800, 1, 1200, 800);
    ed.loadDocument(nodes, kNoGuid);
    Camera cam;
    cam.zoom = 1;
    ed.setCamera(cam);
    ed.setWallClock([this] { return now; });
    r.setTextLayouts(&ed);
  }
  void frame() {
    r.render(ed.document(), ed.page(), ed.camera(), ed.viewport(), ed.overlay(), OverlayStyle::of(Theme::Dark));
    ed.setCanvasHits(r.canvasHits());
  }
  void click(double x, double y, uint32_t mods = 0, int clicks = 1) {
    ed.pointer(PointerEvent::MOVE, x, y, 0, 0, mods);
    ed.pointer(PointerEvent::DOWN, x, y, 0, 1, mods, clicks);
    ed.pointer(PointerEvent::UP, x, y, 0, 0, mods);
  }
  void setExtra(Guid id, const char* key, const std::string& jsonValue) {
    NodeChange c = NodeChange::changed(id);
    c.mask = F_EXTRA;
    c.props.extra[key] = extraOf(key, jsonValue);
    REQUIRE(ed.setProps({id}, c, 0) == OK);
  }
  json::Value extraJson(Guid id, const char* key) {
    const Node* n = ed.document().get(id);
    REQUIRE(n);
    auto it = n->props.extra.find(key);
    if (it == n->props.extra.end()) return {};
    return parse(codec::extraValueToJson("NodeChange", it->second));
  }
};

}  // namespace

TEST_CASE("devmode: markdown notes as the canvas shows them") {
  auto lines = annot::markdownLines("## Header\nUse **bold** and _italic_ with [a link](https://x.y)\n- one\n* two\n1. first\n\n```\ncode **kept**\n```");
  REQUIRE(lines.size() == 6);
  CHECK(lines[0].heading);
  CHECK(lines[0].text == "Header");
  CHECK(lines[1].text == "Use bold and italic with a link");
  CHECK(lines[2].bullet);
  CHECK(lines[2].text == "one");
  CHECK(lines[3].bullet);
  CHECK(lines[4].number == 1);
  CHECK(lines[4].text == "first");
  CHECK(lines[5].text == "code **kept**");
  CHECK(annot::markdownPlain("- a\n2. b") == "• a\n2. b");
  // snake_case stays.
  CHECK(annot::markdownLines("my_var_name")[0].text == "my_var_name");
}

TEST_CASE("devmode: annotations stored in Figma's fields, drawn as labels beside the design with a leader line") {
  Fixture f(designs());
  // The file's categories (Figma's presets, as its files keep them) and a custom one.
  f.setExtra(kDoc, "annotationCategories",
             R"({"version":3,"items":[{"id":{"sessionID":2,"localID":0},"preset":"DEVELOPMENT"},{"id":{"sessionID":2,"localID":1},"preset":"INTERACTION"},)"
             R"({"id":{"sessionID":2,"localID":5},"custom":{"color":"PINK","label":"Motion"}}]})");
  f.setExtra(CHILD, "annotations",
             R"([{"label":"Use the brand card","labelV2":"Use the **brand** card","properties":[{"type":"WIDTH"},{"type":"FILL"}],"categoryId":{"sessionID":2,"localID":5}}])");
  auto cats = annot::categoriesOf(&f.ed.document().get(kDoc)->props);
  REQUIRE(cats.size() == 3);
  CHECK(cats[0].label == "Development");
  CHECK(cats[2].label == "Motion");
  CHECK(cats[2].colorName == "PINK");
  auto notes = annot::notesOf(f.ed.document().get(CHILD)->props);
  REQUIRE(notes.size() == 1);
  CHECK(notes[0].markdown == "Use the **brand** card");
  CHECK(notes[0].properties == std::vector<std::string>{"WIDTH", "FILL"});
  CHECK(annot::propertyValue(f.ed.document(), CHILD, "WIDTH") == "60");
  // The overlay: one card, its category, its pinned values live.
  Overlay o = f.ed.overlay();
  REQUIRE(o.dev.cards.size() == 1);
  CHECK(o.dev.cards[0].title == "Motion");
  CHECK(o.dev.cards[0].lines[0].text == "Use the brand card");
  REQUIRE(o.dev.cards[0].properties.size() == 2);
  CHECK(o.dev.cards[0].properties[0] == std::pair<std::string, std::string>{"Width", "60"});
  // Drawn beside design A (the layer is in A's left half: on its left), recorded for clicks.
  f.frame();
  REQUIRE(f.r.canvasHits().annotations.size() == 1);
  Rect card = f.r.canvasHits().annotations[0].rect;
  CHECK(card.right() <= 0 - 31);
  CHECK(!f.r.canvasHits().annotations[0].dot);
  // A kiwi round trip keeps every field.
  std::string bytes = codec::writeMessage(1, f.ed.encodeDocument());
  codec::KiwiMessage back;
  REQUIRE(codec::readMessage(bytes, back));
  bool found = false;
  for (auto& c : back.changes)
    if (c.guid == CHILD) {
      auto n = annot::notesOf(c.props);
      REQUIRE(n.size() == 1);
      CHECK(n[0].markdown == "Use the **brand** card");
      CHECK(n[0].category == Guid{2, 5});
      found = true;
    }
  CHECK(found);
  // A click on the label selects the layer and asks the panels to open the note.
  f.ed.takeEvents();
  // Pan so the label is on the canvas.
  Camera cam;
  cam.zoom = 1;
  cam.x = 400;
  f.ed.setCamera(cam);
  f.frame();
  card = f.r.canvasHits().annotations[0].rect;
  CHECK(card.x >= 0);
  f.click(card.x + 20, card.y + 10);
  auto ev = f.ed.takeEvents();
  REQUIRE(ev.annotationOpens.size() == 1);
  CHECK(ev.annotationOpens[0].node == CHILD);
  CHECK(ev.annotationOpens[0].index == 0);
  CHECK(f.ed.selection() == std::vector<Guid>{CHILD});
  // View › Annotations off: nothing drawn, nothing to click.
  f.ed.setAnnotationView(false, false);
  f.frame();
  CHECK(f.r.canvasHits().annotations.empty());
  // Dev Mode's dots: a dot at the layer's corner, a click opens its label.
  f.ed.setAnnotationView(true, true);
  f.frame();
  REQUIRE(f.r.canvasHits().annotations.size() == 1);
  REQUIRE(f.r.canvasHits().annotations[0].dot);
  Rect dot = f.r.canvasHits().annotations[0].rect;
  f.click(dot.x + dot.w / 2, dot.y + dot.h / 2);
  f.frame();
  REQUIRE(f.r.canvasHits().annotations.size() == 1);
  CHECK(!f.r.canvasHits().annotations[0].dot);
}

TEST_CASE("devmode: the Annotation tool's click opens a new note on the layer") {
  Fixture f(designs());
  REQUIRE(f.ed.setTool(Tool::ANNOTATION) == OK);
  f.frame();
  f.ed.takeEvents();
  f.click(50, 40);  // on the card inside A: what a click would select (a top-level frame's child)
  auto ev = f.ed.takeEvents();
  REQUIRE(ev.annotationOpens.size() == 1);
  CHECK(ev.annotationOpens[0].index == -1);
  CHECK(ev.annotationOpens[0].node == CHILD);
  CHECK(ev.annotationOpens[0].rect.w == doctest::Approx(60));
  CHECK(f.ed.selection() == std::vector<Guid>{CHILD});
  // On A's own background: A.
  f.click(150, 80);
  ev = f.ed.takeEvents();
  REQUIRE(ev.annotationOpens.size() == 1);
  CHECK(ev.annotationOpens[0].node == A);
  // Viewer mode refuses the tool unless Dev Mode's edits are on.
  f.ed.setViewerMode(true);
  CHECK(f.ed.setTool(Tool::ANNOTATION) == E_READONLY);
  f.ed.setDevEdits(true);
  CHECK(f.ed.setTool(Tool::ANNOTATION) == OK);
}

TEST_CASE("devmode: measurements — the tool, the commands, drawing, kiwi, delete and undo") {
  Fixture f(designs());
  REQUIRE(f.ed.setTool(Tool::MEASUREMENT) == OK);
  // From A's right edge (x 200) to B's left edge (x 400): 200.
  f.ed.pointer(PointerEvent::MOVE, 198, 50, 0, 0, 0);
  Overlay hover = f.ed.overlay();
  REQUIRE(hover.dev.edges.size() == 1);
  CHECK(hover.dev.edges[0].a.x == doctest::Approx(200));
  CHECK(f.ed.pointer(PointerEvent::DOWN, 198, 50, 0, 1, 0) != 0);
  f.ed.pointer(PointerEvent::MOVE, 300, 50, 0, 1, 0);
  f.ed.pointer(PointerEvent::MOVE, 403, 50, 0, 1, 0);
  Overlay during = f.ed.overlay();
  CHECK(during.dev.hasDraft);
  CHECK(during.dev.draft.text == "200");
  f.ed.pointer(PointerEvent::UP, 403, 50, 0, 0, 0);
  auto list = f.ed.measurements();
  REQUIRE(list.size() == 1);
  CHECK(list[0].from == A);
  CHECK(list[0].to == B);
  CHECK(list[0].side == annot::Side::RIGHT);
  CHECK(!list[0].toSameSide);  // RIGHT → LEFT
  CHECK(f.ed.selectedMeasurement() == list[0].id);
  CHECK(f.ed.tool() == Tool::MOVE);
  Vec2 a, b;
  REQUIRE(f.ed.measurementLine(list[0], a, b));
  CHECK((b - a).length() == doctest::Approx(200));
  CHECK(a.y == doctest::Approx(50));
  // Stored on the page, Figma's AnnotationMeasurement.
  f.frame();
  REQUIRE(f.r.canvasHits().measurements.size() == 1);
  // A click on the edge: the layer's own width.
  REQUIRE(f.ed.setTool(Tool::MEASUREMENT) == OK);
  f.click(401, 80);
  list = f.ed.measurements();
  REQUIRE(list.size() == 2);
  CHECK(list[1].from == B);
  CHECK(list[1].to == B);
  REQUIRE(f.ed.measurementLine(list[1], a, b));
  CHECK((b - a).length() == doctest::Approx(200));
  // Commands: add a height measurement below the designs with custom text, edit and delete.
  std::string args = R"({"from":")" + CHILD.toString() + R"(","side":"TOP","outer":30,"freeText":"Card height"})";
  CommandArgs ca;
  ca.raw = parse(args);
  REQUIRE(f.ed.command(CommandId::MEASUREMENT_ADD, ca) == OK);
  REQUIRE(f.ed.lastCreated().size() == 1);
  Guid made = f.ed.lastCreated()[0];
  list = f.ed.measurements();
  REQUIRE(list.size() == 3);
  REQUIRE(f.ed.measurementLine(list[2], a, b));
  CHECK((b - a).length() == doctest::Approx(40));
  CHECK(a.x == doctest::Approx(80 + 30));  // past the layer's right edge
  CommandArgs edit;
  edit.raw = parse(R"({"id":")" + made.toString() + R"(","freeText":""})");
  REQUIRE(f.ed.command(CommandId::MEASUREMENT_UPDATE, edit) == OK);
  CHECK(f.ed.measurements()[2].freeText.empty());
  // Round trip through kiwi.
  std::string bytes = codec::writeMessage(1, f.ed.encodeDocument());
  codec::KiwiMessage back;
  REQUIRE(codec::readMessage(bytes, back));
  for (auto& c : back.changes)
    if (c.guid == kPage) {
      auto m = annot::measurementsOf(c.props);
      REQUIRE(m.size() == 3);
      CHECK(m[2].outer == doctest::Approx(30));
      CHECK(m[0].side == annot::Side::RIGHT);
    }
  // Drag the first one off the design: an outer offset.
  f.frame();
  CanvasHits::Measure h = f.r.canvasHits().measurements[0];
  Vec2 mid = (h.a + h.b) * 0.5;
  f.ed.pointer(PointerEvent::MOVE, mid.x + 20, mid.y, 0, 0, 0);
  REQUIRE(f.ed.pointer(PointerEvent::DOWN, mid.x + 20, mid.y, 0, 1, 0) != 0);
  f.ed.pointer(PointerEvent::MOVE, mid.x + 20, 140, 0, 1, 0);
  f.ed.pointer(PointerEvent::UP, mid.x + 20, 140, 0, 0, 0);
  CHECK(f.ed.measurements()[0].outer == doctest::Approx(40));
  // Delete removes the selected one; undo brings it back.
  f.ed.takeEvents();
  CHECK(f.ed.key(KeyEvent::DOWN, KeyCode::Delete, 0, 0, false) != 0);
  CHECK(f.ed.measurements().size() == 2);
  f.ed.command(CommandId::UNDO);
  CHECK(f.ed.measurements().size() == 3);
  // A double-click asks the panels for its custom text.
  f.frame();
  h = f.r.canvasHits().measurements[0];
  f.ed.takeEvents();
  f.click(h.pill.x + 2, h.pill.y + 2, 0, 2);
  auto ev = f.ed.takeEvents();
  REQUIRE(ev.measurementEdits.size() == 1);
  CHECK(ev.measurementEdits[0].text == "200");
}

TEST_CASE("devmode: statuses on titles; editInfo stamped on edits makes a ready design \"Changed\"") {
  Fixture f(designs());
  f.ed.setEditTracking(true);
  f.now = 2000;
  f.setExtra(A, "sectionStatusInfo", R"({"status":"BUILD","lastUpdateUnixTimestamp":2000})");
  // A status write is no edit.
  CHECK(f.extraJson(A, "editInfo").isNull());
  CHECK(f.ed.devStatus(A) == 1);
  f.frame();
  REQUIRE(f.r.canvasHits().statuses.size() == 1);
  CHECK(f.r.canvasHits().statuses[0].kind == DevStatusMark::Kind::Ready);
  // An edit inside A a little later: A (and the page) get editInfo; A shows Changed.
  f.now = 2060;
  NodeChange c = NodeChange::changed(CHILD);
  c.mask = F_SIZE;
  c.props.size = {80, 40};
  REQUIRE(f.ed.setProps({CHILD}, c, 0) == OK);
  json::Value info = f.extraJson(A, "editInfo");
  REQUIRE(info.isObject());
  CHECK(info.get("lastEditedAt")->number == 2060);
  CHECK(f.extraJson(CHILD, "editInfo").get("lastEditedAt")->number == 2060);
  CHECK(f.extraJson(kPage, "editInfo").get("lastEditedAt")->number == 2060);
  CHECK(f.extraJson(B, "editInfo").isNull());
  CHECK(f.ed.devStatus(A) == 3);
  f.frame();
  REQUIRE(f.r.canvasHits().statuses.size() == 1);
  CHECK(f.r.canvasHits().statuses[0].kind == DevStatusMark::Kind::Changed);
  // Undo takes the edit and its editInfo back.
  f.ed.command(CommandId::UNDO);
  CHECK(f.ed.devStatus(A) == 1);
  // "Done with changes": the status again, now.
  REQUIRE(f.ed.setProps({CHILD}, c, 0) == OK);
  f.now = 2100;
  f.setExtra(A, "sectionStatusInfo", R"({"status":"BUILD","lastUpdateUnixTimestamp":2100,"prevStatus":"BUILD"})");
  CHECK(f.ed.devStatus(A) == 1);
  // Clicking the chip asks for its menu.
  f.frame();
  Rect chip = f.r.canvasHits().statuses[0].rect;
  f.ed.takeEvents();
  f.click(chip.x + 4, chip.y + 4);
  auto ev = f.ed.takeEvents();
  REQUIRE(ev.statusClicks.size() == 1);
  CHECK(ev.statusClicks[0].frame == A);
  CHECK(ev.statusClicks[0].action == "menu");
  // B selected and under the pointer: "Mark as ready for dev".
  f.ed.setSelection({B});
  f.ed.pointer(PointerEvent::MOVE, 500, 50, 0, 0, 0);
  f.frame();
  bool mark = false;
  for (auto& s : f.r.canvasHits().statuses) mark |= s.frame == B && s.kind == DevStatusMark::Kind::MarkButton;
  CHECK(mark);
  // Annotations aren't edits either.
  f.now = 3000;
  f.setExtra(A, "annotations", R"([{"labelV2":"note"}])");
  CHECK(f.ed.devStatus(A) == 1);
  // Without tracking nothing is stamped.
  f.ed.setEditTracking(false);
  NodeChange d = NodeChange::changed(B);
  d.mask = F_NAME;
  d.props.name = "Renamed";
  REQUIRE(f.ed.setProps({B}, d, 0) == OK);
  CHECK(f.extraJson(B, "editInfo").isNull());
}

TEST_CASE("devmode: editInfo on an instance is its own field, not an override") {
  const Guid MAIN{1, 30}, MAIN_RECT{1, 31}, INST{1, 32};
  auto nodes = designs();
  nodes.push_back(make(MAIN, NodeType::SYMBOL, kPage, "c", {0, 300, 100, 100}, "Main"));
  nodes.push_back(make(MAIN_RECT, NodeType::ROUNDED_RECTANGLE, MAIN, "a", {10, 10, 40, 40}, "Dot"));
  NodeChange inst = make(INST, NodeType::INSTANCE, A, "b", {100, 10, 100, 100}, "Instance");
  inst.props.comp().symbolData.symbolID = MAIN;
  nodes.push_back(inst);
  Fixture f(nodes);
  f.ed.setEditTracking(true);
  f.now = 5000;
  NodeChange c = NodeChange::changed(INST);
  c.mask = F_OPACITY;
  c.props.opacity = 0.5;
  REQUIRE(f.ed.setProps({INST}, c, 0) == OK);
  CHECK(f.extraJson(INST, "editInfo").get("lastEditedAt")->number == 5000);
  CHECK(f.extraJson(A, "editInfo").get("lastEditedAt")->number == 5000);
  for (const SymbolOverride& o : f.ed.document().get(INST)->props.comp().symbolData.overrides) CHECK(!(o.path.empty() && o.mask == F_EXTRA));
  // An edit inside the main stamps the main, not its instances.
  f.now = 6000;
  NodeChange r = NodeChange::changed(MAIN_RECT);
  r.mask = F_OPACITY;
  r.props.opacity = 0.5;
  REQUIRE(f.ed.setProps({MAIN_RECT}, r, 0) == OK);
  CHECK(f.extraJson(MAIN, "editInfo").get("lastEditedAt")->number == 6000);
  CHECK(f.extraJson(INST, "editInfo").get("lastEditedAt")->number == 5000);
}

TEST_CASE("devmode: focus view draws and picks one design") {
  Fixture f(designs());
  REQUIRE(f.ed.setFocus(B) == OK);
  f.ed.setSelection({A});
  CHECK(f.ed.selection().empty() == false);  // setSelection itself isn't filtered
  REQUIRE(f.ed.setFocus(kNoGuid) == OK);
  f.ed.setSelection({A});
  REQUIRE(f.ed.setFocus(B) == OK);
  CHECK(f.ed.selection().empty());  // A left the selection
  f.click(50, 50);  // on A: not in focus
  CHECK(f.ed.selection().empty());
  f.click(500, 50);  // on B
  CHECK(f.ed.selection() == std::vector<Guid>{B});
  Overlay o = f.ed.overlay();
  CHECK(o.dev.focus == B);
  RenderStats s = f.r.render(f.ed.document(), f.ed.page(), f.ed.camera(), f.ed.viewport(), o, OverlayStyle::of(Theme::Dark));
  CHECK(s.shapes > 0);
  CHECK(f.ed.setFocus(Guid{9, 9}) == E_NOT_FOUND);
}
