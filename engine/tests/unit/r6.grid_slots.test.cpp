// Round 6: grid auto layout on the canvas (track pills: select, edit, resize by an edge, reorder by the grabber,
// delete; span handles; Auto rows) and slots (Convert to slot, Wrap in new slot, Delete contents).
#include <algorithm>
#include <cmath>

#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"
#include "base/DerivedIds.h"
#include "base/Json.h"
#include "layout/Layout.h"
#include "scene/CodecJson.h"

using namespace eng;
using namespace eng::test;

namespace {

NodeChange fromJson(const std::string& text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  NodeChange c;
  REQUIRE(codec::readChange(v, c));
  c.phase = Phase::CREATED;
  c.mask = F_ALL;
  return c;
}

// A 2 × 2 grid of 50 px fixed tracks at the origin (columns 9:1, 9:2; rows 9:11, 9:12), three 40 × 40 items.
std::vector<NodeChange> gridScene(bool reflow, const std::string& extra = "") {
  auto nodes = baseChanges();
  auto track = [](int id, const char* pos) { return R"({"id":{"sessionID":9,"localID":)" + std::to_string(id) + R"(},"position":")" + pos + R"("})"; };
  auto fixed = [](int id) {
    return R"({"id":{"sessionID":9,"localID":)" + std::to_string(id) + R"(},"trackSize":{"minSizing":{"type":"FIXED","value":50},"maxSizing":{"type":"FIXED","value":50}}})";
  };
  nodes.push_back(fromJson(R"({"guid":"1:30","type":"FRAME","name":"Grid","parentIndex":{"guid":"0:1","position":"!"},"size":{"x":100,"y":100},)"
                           R"("stackMode":"GRID","stackPrimarySizing":"FIXED","stackCounterSizing":"FIXED","gridReflowEnabled":)" +
                           std::string(reflow ? "true" : "false") + extra + R"(,"gridColumns":{"entries":[)" + track(1, "!") + "," + track(2, "#") +
                           R"(]},"gridColumnsSizing":{"entries":[)" + fixed(1) + "," + fixed(2) + R"(]},"gridRows":{"entries":[)" + track(11, "!") +
                           "," + track(12, "#") + R"(]},"gridRowsSizing":{"entries":[)" + fixed(11) + "," + fixed(12) + "]}}"));
  const char* anchors[3][2] = {{"1", "11"}, {"2", "11"}, {"1", "12"}};
  const char* keys[3] = {"!", "#", "$"};
  for (int i = 0; i < 3; i++) {
    std::string a = reflow ? "" : std::string(R"(,"gridColumnAnchor":{"sessionID":9,"localID":)") + anchors[i][0] + R"(},"gridRowAnchor":{"sessionID":9,"localID":)" + anchors[i][1] + "}";
    nodes.push_back(fromJson(R"({"guid":"1:)" + std::to_string(31 + i) + R"(","type":"ROUNDED_RECTANGLE","parentIndex":{"guid":"1:30","position":")" + keys[i] +
                             R"("},"size":{"x":40,"y":40})" + a + "}"));
  }
  return nodes;
}

Editor load(const std::vector<NodeChange>& nodes) {
  Editor e;
  e.setSessionID(1);
  e.setViewport(1000, 800, 1, 1000, 800);
  e.loadDocument(nodes, kNoGuid);
  e.takeEvents();
  return e;
}

void down(Editor& e, double x, double y, uint32_t mods = 0) { e.pointer(PointerEvent::DOWN, x, y, 0, 1, mods); }
void move(Editor& e, double x, double y, uint32_t mods = 0) { e.pointer(PointerEvent::MOVE, x, y, 0, 1, mods); }
void up(Editor& e, double x, double y, uint32_t mods = 0) { e.pointer(PointerEvent::UP, x, y, 0, 0, mods); }
void drag(Editor& e, Vec2 from, Vec2 to, uint32_t mods = 0) {
  down(e, from.x, from.y, mods);
  for (int i = 1; i <= 8; i++) move(e, from.x + (to.x - from.x) * i / 8.0, from.y + (to.y - from.y) * i / 8.0, mods);
  up(e, to.x, to.y, mods);
}
void click(Editor& e, double x, double y, uint32_t mods = 0) {
  down(e, x, y, mods);
  up(e, x, y, mods);
}
void key(Editor& e, KeyCode k, uint32_t mods = 0) { e.key(KeyEvent::DOWN, k, 0, mods, false); }

const Guid GRID{1, 30}, I0{1, 31}, I1{1, 32}, I2{1, 33};
Rect world(const Editor& e, Guid id) { return e.document().worldBounds(id); }
std::vector<Layout::GridTrackDef> cols(const Editor& e) { return Layout::gridTrackDefs(e.document().get(GRID)->props, true); }

// The last GRID_TRACKS event of what the editor queued.
bool lastGridEvent(Editor& e, Editor::GridTracksEvent& out) {
  auto ev = e.takeEvents();
  if (ev.gridTracks.empty()) return false;
  out = ev.gridTracks.back();
  return true;
}

CommandArgs args(const std::string& jsonText) {
  CommandArgs a;
  json::parse(jsonText, a.raw);
  return a;
}

}  // namespace

TEST_CASE("grid on canvas: the track codec round-trips; Auto rows follow the items") {
  Editor e = load(gridScene(true));
  auto c = cols(e);
  REQUIRE(c.size() == 2);
  CHECK(c[0].id == Guid{9, 1});
  CHECK(c[0].sizing == 1);
  CHECK(c[0].value == 50);
  NodeProps p = e.document().get(GRID)->props;
  c[1].sizing = 0;
  c[1].value = 2;
  Layout::setGridTrackDefs(p, true, c);
  auto back = Layout::gridTrackDefs(p, true);
  REQUIRE(back.size() == 2);
  CHECK(back[1].sizing == 0);
  CHECK(back[1].value == 2);
  CHECK(back[1].position == "#");
  // Two rows defined, two items in two columns (one row's worth): Auto rows lay out one (empty ones go); else two.
  auto two = [](bool autoRows) {
    auto nodes = gridScene(true, autoRows ? R"(,"gridAutoTracks":"ROWS")" : "");
    nodes.pop_back();
    return nodes;
  };
  {
    Editor a = load(two(true));
    CHECK(Layout::gridAutoRows(a.document().get(GRID)->props));
    Layout::GridCells G = a.gridCellsOf(GRID);
    CHECK(G.rowY.size() == 1);
  }
  {
    Editor a = load(two(false));
    CHECK(!Layout::gridAutoRows(a.document().get(GRID)->props));
    Layout::GridCells G = a.gridCellsOf(GRID);
    CHECK(G.rowY.size() == 2);
  }
}

TEST_CASE("grid on canvas: a click on a track's pill selects it and asks to edit its label; ⌘ adds, ⇧ a range, Esc clears") {
  Editor e = load(gridScene(false));
  e.setSelection({GRID});
  e.takeEvents();
  // Columns' pills ride 10 px above the top edge.
  click(e, 20, -10);
  Editor::GridTracksEvent ev;
  REQUIRE(lastGridEvent(e, ev));
  CHECK(ev.frame == GRID);
  CHECK(ev.column);
  CHECK(ev.tracks == std::vector<size_t>{0});
  CHECK(ev.edit);
  CHECK(ev.label.w > 0);
  Overlay o = e.overlay();
  REQUIRE(o.gridTracks.size() == 4);
  CHECK(o.gridTracks[0].selected);
  CHECK(!o.gridTracks[1].selected);
  click(e, 80, -10, MOD_PRIMARY);
  REQUIRE(lastGridEvent(e, ev));
  CHECK(ev.tracks == std::vector<size_t>{0, 1});
  CHECK(!ev.edit);  // ⌘: adds, no editor
  key(e, KeyCode::Enter);
  REQUIRE(lastGridEvent(e, ev));
  CHECK(ev.edit);
  key(e, KeyCode::Escape);
  REQUIRE(lastGridEvent(e, ev));
  CHECK(ev.tracks.empty());
  CHECK(e.selection() == std::vector<Guid>{GRID});  // Esc let the tracks go, not the grid
  // Rows: the pills left of the frame.
  click(e, -10, 75);
  REQUIRE(lastGridEvent(e, ev));
  CHECK(!ev.column);
  CHECK(ev.tracks == std::vector<size_t>{1});
}

TEST_CASE("grid panel (round 8): SELECT_GRID_TRACKS selects a selected grid's tracks as a pill click does; [] clears") {
  Editor e = load(gridScene(false));
  e.setSelection({GRID});
  e.takeEvents();
  CHECK(e.commandState(CommandId::SELECT_GRID_TRACKS) == CMD_ENABLED);
  auto args = [](const char* text) {
    CommandArgs a;
    json::parse(text, a.raw);
    return a;
  };
  CHECK(e.command(CommandId::SELECT_GRID_TRACKS, args(R"({"axis":"ROWS","tracks":[1]})")) == OK);
  Editor::GridTracksEvent ev;
  REQUIRE(lastGridEvent(e, ev));
  CHECK(ev.frame == GRID);
  CHECK(!ev.column);
  CHECK(ev.tracks == std::vector<size_t>{1});
  CHECK(!ev.edit);
  // Out-of-range indices are dropped; another frame's id is refused.
  CHECK(e.command(CommandId::SELECT_GRID_TRACKS, args(R"({"axis":"COLUMNS","tracks":[0,7]})")) == OK);
  REQUIRE(lastGridEvent(e, ev));
  CHECK(ev.column);
  CHECK(ev.tracks == std::vector<size_t>{0});
  CHECK(e.command(CommandId::SELECT_GRID_TRACKS, args(R"({"frame":"99:99","tracks":[0]})")) == E_INVALID);
  CHECK(e.command(CommandId::SELECT_GRID_TRACKS, args(R"({"tracks":[]})")) == OK);
  REQUIRE(lastGridEvent(e, ev));
  CHECK(ev.tracks.empty());
  e.setSelection({});
  CHECK(e.commandState(CommandId::SELECT_GRID_TRACKS) == 0);
}

TEST_CASE("grid on canvas: dragging a track's edge resizes it (Fixed), one undo step") {
  Editor e = load(gridScene(false));
  e.setSelection({GRID});
  drag(e, {50, -10}, {70, -10});
  auto c = cols(e);
  CHECK(c[0].sizing == 1);
  CHECK(c[0].value == 70);
  CHECK(world(e, I1).x == 70);
  e.command(CommandId::UNDO);
  CHECK(cols(e)[0].value == 50);
  CHECK(world(e, I1).x == 50);
  // A Hug / Fill track dragged becomes Fixed at the dragged size.
}

TEST_CASE("grid on canvas: dragging a grabber reorders the tracks; anchored items move with their tracks") {
  Editor e = load(gridScene(false));
  e.setSelection({GRID});
  move(e, 75, -10);
  Overlay o = e.overlay();
  REQUIRE(o.gridTracks.size() == 4);
  CHECK(o.gridTracks[1].grabber);
  // Column 2's grabber: just left of its label ("50", centred at 75).
  down(e, 57, -10);
  for (int i = 1; i <= 8; i++) move(e, 57 - i * 7.0, -10);
  o = e.overlay();
  CHECK(o.hasGridDrop);
  CHECK(o.gridDrop.a.x == 0);
  up(e, 1, -10);
  auto c = cols(e);
  REQUIRE(c.size() == 2);
  CHECK(c[0].id == Guid{9, 2});
  CHECK(c[1].id == Guid{9, 1});
  CHECK(c[0].position < c[1].position);
  CHECK(world(e, I1).x == 0);   // anchored on column 9:2, now first
  CHECK(world(e, I0).x == 50);
  e.command(CommandId::UNDO);
  CHECK(cols(e)[0].id == Guid{9, 1});
}

TEST_CASE("grid on canvas: ⌫ deletes the selected tracks with their items; spanning items shrink") {
  Editor e = load(gridScene(false));
  e.setSelection({GRID});
  click(e, 75, -10);  // column 2 (holds I1)
  e.takeEvents();
  key(e, KeyCode::Backspace);
  CHECK(cols(e).size() == 1);
  CHECK(!e.document().has(I1));
  CHECK(e.document().has(I0));
  CHECK(e.document().has(I2));
  e.command(CommandId::UNDO);
  CHECK(cols(e).size() == 2);
  CHECK(e.document().has(I1));
  // The last track of an axis stays.
  e.setSelection({GRID});
  click(e, 20, -10);
  click(e, 80, -10, MOD_PRIMARY);
  key(e, KeyCode::Backspace);
  CHECK(cols(e).size() == 2);
}

TEST_CASE("grid on canvas: an item's span handles drag its span to a cell edge (Fill on that axis)") {
  Editor e = load(gridScene(false));
  e.setSelection({I2});  // column 1, row 2 — column 2 of row 2 is free
  Overlay o = e.overlay();
  REQUIRE(o.gridSpanHandles.size() == 4);
  // The right handle at the middle of its right side (40, 70) → the grid's right edge.
  drag(e, {40, 70}, {98, 70});
  auto g = e.gridCellsOf(GRID);
  bool found = false;
  for (auto& it : g.items)
    if (it.id == I2) {
      found = true;
      CHECK(it.colSpan == 2);
      CHECK(it.col == 0);
    }
  CHECK(found);
  CHECK(e.document().get(I2)->props.stackChildPrimaryGrow > 0);
  CHECK(world(e, I2).w == 100);
  e.command(CommandId::UNDO);
  CHECK(world(e, I2).w == 40);
}

// ---- Slots ----

namespace {

const Guid M{1, 1}, CONTENT{1, 2}, LABEL{1, 3}, OTHER{1, 4}, I{1, 10};

std::vector<NodeChange> cardDoc() {
  auto nodes = baseChanges();
  NodeChange m = make(M, NodeType::SYMBOL, kPage, "!", {0, 0, 200, 100}, "Card");
  nodes.push_back(m);
  NodeChange content = make(CONTENT, NodeType::FRAME, M, "!", {10, 10, 180, 50}, "Content");
  nodes.push_back(content);
  nodes.push_back(make({1, 5}, NodeType::ELLIPSE, CONTENT, "!", {0, 0, 10, 10}, "Dot"));
  NodeChange label = make(LABEL, NodeType::TEXT, M, "\"", {10, 70, 80, 20}, "Label");
  label.props.text().textData.characters = "Label";
  nodes.push_back(label);
  nodes.push_back(make(OTHER, NodeType::FRAME, M, "#", {100, 70, 80, 20}, "Other"));
  NodeChange inst = make(I, NodeType::INSTANCE, kPage, "\"", {0, 200, 200, 100}, "Card");
  inst.props.comp().symbolData.symbolID = M;
  nodes.push_back(inst);
  return nodes;
}

const ComponentPropDef* defNamed(const Editor& e, const std::string& name) {
  for (const auto& d : e.document().get(M)->props.comp().componentPropDefs)
    if (d.name == name) return &d;
  return nullptr;
}

}  // namespace

TEST_CASE("slots: Convert to slot makes a nested frame a slot (a SLOT property bound to it), one undo step") {
  Editor e = load(cardDoc());
  e.setSelection({M});
  CHECK(e.commandState(CommandId::CONVERT_TO_SLOT) == 0);  // not the component itself
  e.setSelection({LABEL});
  CHECK(e.commandState(CommandId::CONVERT_TO_SLOT) == 0);  // not a text (Wrap in new slot is)
  CHECK(e.commandState(CommandId::WRAP_IN_NEW_SLOT) == CMD_ENABLED);
  e.setSelection({CONTENT});
  REQUIRE(e.commandState(CommandId::CONVERT_TO_SLOT) == CMD_ENABLED);
  REQUIRE(e.command(CommandId::CONVERT_TO_SLOT) == OK);
  const ComponentPropDef* d = defNamed(e, "Slot");
  REQUIRE(d);
  CHECK(d->type == ComponentPropType::SLOT);
  CHECK(e.document().get(CONTENT)->props.comp().isSlot);
  bool bound = false;
  for (const ParamBinding& b : e.document().get(CONTENT)->props.parameterConsumptionMap) bound |= b.field == VariableField::SLOT_CONTENT_ID && b.propRef == d->id;
  CHECK(bound);
  CHECK(e.commandState(CommandId::CONVERT_TO_SLOT) == 0);  // a slot already
  // A second one is "Slot 2".
  e.setSelection({OTHER});
  REQUIRE(e.command(CommandId::CONVERT_TO_SLOT) == OK);
  CHECK(defNamed(e, "Slot 2"));
  e.command(CommandId::UNDO);
  CHECK(!defNamed(e, "Slot 2"));
  CHECK(!e.document().get(OTHER)->props.comp().isSlot);
  e.command(CommandId::UNDO);
  CHECK(!defNamed(e, "Slot"));
  CHECK(!e.document().get(CONTENT)->props.comp().isSlot);
}

TEST_CASE("slots: Wrap in new slot frames the selection and makes the frame a slot") {
  Editor e = load(cardDoc());
  e.setSelection({LABEL});
  REQUIRE(e.command(CommandId::WRAP_IN_NEW_SLOT) == OK);
  Guid frame = e.document().parentOf(LABEL);
  REQUIRE(frame != M);
  const NodeProps& f = e.document().get(frame)->props;
  CHECK(f.type == NodeType::FRAME);
  CHECK(f.comp().isSlot);
  CHECK(f.fillPaints.empty());
  CHECK(e.document().parentOf(frame) == M);
  CHECK(defNamed(e, "Slot"));
  CHECK(e.selection() == std::vector<Guid>{frame});
  e.command(CommandId::UNDO);
  CHECK(e.document().parentOf(LABEL) == M);
  CHECK(!defNamed(e, "Slot"));
}

TEST_CASE("slots: Delete contents empties an instance's slot (diverged) and a main's slot frame") {
  Editor e = load(cardDoc());
  e.setSelection({CONTENT});
  REQUIRE(e.command(CommandId::CONVERT_TO_SLOT) == OK);
  Guid row = derived::intern(I, {CONTENT});
  REQUIRE(e.document().has(row));
  REQUIRE(e.document().children(row).size() == 1);
  REQUIRE(e.command(CommandId::CLEAR_SLOT, args(R"({"ref":")" + row.toString() + "\"}")) == OK);
  // The instance's slot now shows its own (empty) content frame.
  Guid content = kNoGuid;
  for (Guid c : e.document().children(I))
    if (!c.isDerived() && e.document().get(c)->props.comp().isSlotContent) content = c;
  REQUIRE(content != kNoGuid);
  CHECK(e.document().children(content).empty());
  CHECK(e.document().children(CONTENT).size() == 1);  // the main keeps its default
  e.command(CommandId::UNDO);
  CHECK(!e.document().has(content));
  // The main's slot frame itself.
  REQUIRE(e.command(CommandId::CLEAR_SLOT, args(R"({"ref":")" + CONTENT.toString() + "\"}")) == OK);
  CHECK(e.document().children(CONTENT).empty());
}
