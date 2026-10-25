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

TEST_CASE("grid on canvas: a click on a track's pill selects it, its chevron opens the sizing menu; ⌘ adds, ⇧ a range, Esc clears") {
  Editor e = load(gridScene(false));
  e.setSelection({GRID});
  e.takeEvents();
  // Columns' pills ride 31.5 px above the top edge (live Figma); the label of column 1's.
  move(e, 20, -31.5);
  click(e, 20, -31.5);
  Editor::GridTracksEvent ev;
  REQUIRE(lastGridEvent(e, ev));
  CHECK(ev.frame == GRID);
  CHECK(ev.column);
  CHECK(ev.tracks == std::vector<size_t>{0});
  CHECK(!ev.edit);  // round 12 (live grid/row-track-menu.txt): a click on the pill only selects the track
  Overlay o = e.overlay();
  REQUIRE(o.gridPills.size() == 1);
  CHECK(o.gridPills[0].selected);
  CHECK(o.gridPills[0].expanded);
  CHECK(o.selectionDashed);
  CHECK(o.hideTitle == GRID);
  // Its chevron: the label's field and the sizing menu (GRID_TRACKS {edit} at the pill's label).
  const Overlay::GridPill pill = o.gridPills[0];
  double chevron = pill.rect.x + pill.segment + pill.labelWidth + pill.segment / 2;
  move(e, chevron, -31.5);
  click(e, chevron, -31.5);
  REQUIRE(lastGridEvent(e, ev));
  CHECK(ev.edit);
  CHECK(ev.tracks == std::vector<size_t>{0});
  CHECK(ev.label.x == doctest::Approx(pill.rect.x + pill.segment));
  CHECK(ev.label.y == doctest::Approx(pill.rect.y));
  CHECK(ev.label.w == doctest::Approx(pill.labelWidth));
  CHECK(ev.label.h == doctest::Approx(pill.rect.h));
  // The grabber clicked (no drag): selected, no menu either.
  click(e, pill.rect.x + pill.segment / 2, -31.5);
  CHECK(!lastGridEvent(e, ev));  // the same selection: nothing to report
  click(e, 80, -31.5, MOD_PRIMARY);
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
  // Rows: the pills left of the frame (an expanded one ends 24.75 px off it — round 12, live Figma): -31.5 is its
  // chevron, the sizing menu at its label.
  move(e, -31.5, 75);
  o = e.overlay();
  REQUIRE(o.gridPills.size() == 1);
  CHECK(!o.gridPills[0].column);
  CHECK(o.gridPills[0].rect.right() == doctest::Approx(-24.75));
  CHECK(o.gridPills[0].hovered == 2);
  click(e, -31.5, 75);
  REQUIRE(lastGridEvent(e, ev));
  CHECK(!ev.column);
  CHECK(ev.tracks == std::vector<size_t>{1});
  CHECK(ev.edit);
  CHECK(ev.label.x == doctest::Approx(o.gridPills[0].rect.x + o.gridPills[0].segment));
  CHECK(o.gridPills[0].segment == 18);  // round 12: live's 18 px grabber and chevron
  // Two rows selected: a chevron keeps them both, the menu at the clicked one's label.
  click(e, -60, 25, MOD_PRIMARY);
  REQUIRE(lastGridEvent(e, ev));
  CHECK(ev.tracks == (std::vector<size_t>{0, 1}));
  move(e, -31.5, 25);
  click(e, -31.5, 25);
  REQUIRE(lastGridEvent(e, ev));
  CHECK(ev.tracks == (std::vector<size_t>{0, 1}));
  CHECK(ev.edit);
  CHECK(ev.label.y + ev.label.h / 2 == doctest::Approx(25));
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
  drag(e, {50, -31.5}, {70, -31.5});
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
  move(e, 57, -31.5);
  Overlay o = e.overlay();
  REQUIRE(o.gridPills.size() == 1);
  CHECK(o.gridPills[0].hovered == 0);
  // Column 2's grabber: the expanded pill's first 16 px (its label "50" centred at 75).
  down(e, 57, -31.5);
  for (int i = 1; i <= 8; i++) move(e, 57 - i * 7.0, -31.5);
  o = e.overlay();
  CHECK(o.hasGridDrop);
  CHECK(o.gridDrop.a.x == 0);
  up(e, 1, -31.5);
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
  move(e, 75, -31.5);
  click(e, 75, -31.5);  // column 2 (holds I1)
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
  move(e, 20, -31.5);
  click(e, 20, -31.5);
  move(e, 80, -31.5);
  click(e, 80, -31.5, MOD_PRIMARY);
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

// ---- Round 12: a grid's gaps on the canvas ----

namespace {

// AL_grid of the live capture (the editor's fixture 7:40): 320 × 200 at the origin, padding 12, 3 × 2 Fill (1fr)
// tracks, gaps of 8 — columns 12..105.33, 113.33..206.67, 214.67..308; rows 12..96, 104..188 — one item in the first
// cell.
const Guid AL{1, 40}, AL_ITEM{1, 41};
std::vector<NodeChange> alGrid() {
  auto nodes = baseChanges();
  auto list = [](int first, int n, bool sizing) {
    std::string out;
    for (int i = 0; i < n; i++) {
      std::string id = R"({"sessionID":9,"localID":)" + std::to_string(first + i) + "}";
      out += (i ? "," : "") + (sizing ? R"({"id":)" + id + R"(,"trackSize":{"minSizing":{"type":"FLEX","value":1},"maxSizing":{"type":"FLEX","value":1}}})"
                                      : R"({"id":)" + id + R"(,"position":")" + std::string(1, "!#$"[i]) + R"("})");
    }
    return out;
  };
  nodes.push_back(fromJson(R"({"guid":"1:40","type":"FRAME","name":"AL_grid","parentIndex":{"guid":"0:1","position":"!"},"size":{"x":320,"y":200},)"
                           R"("stackMode":"GRID","stackPrimarySizing":"FIXED","stackCounterSizing":"FIXED","gridReflowEnabled":true,)"
                           R"("stackHorizontalPadding":12,"stackVerticalPadding":12,"stackPaddingRight":12,"stackPaddingBottom":12,)"
                           R"("gridColumnGap":8,"gridRowGap":8,"gridColumns":{"entries":[)" + list(1, 3, false) + R"(]},"gridColumnsSizing":{"entries":[)" +
                           list(1, 3, true) + R"(]},"gridRows":{"entries":[)" + list(11, 2, false) + R"(]},"gridRowsSizing":{"entries":[)" + list(11, 2, true) + "]}}"));
  nodes.push_back(fromJson(R"({"guid":"1:41","type":"ROUNDED_RECTANGLE","parentIndex":{"guid":"1:40","position":"!"},"size":{"x":60,"y":40}})"));
  return nodes;
}

double gap(const Editor& e, bool column) { return Layout::gridGap(e.document().get(AL)->props, column); }

}  // namespace

TEST_CASE("r12 grid: the pointer in a gap outlines every gap of that axis, the padding bars give way (live Figma)") {
  Editor e = load(alGrid());
  e.setSelection({AL});
  CHECK(gap(e, true) == 8);
  CHECK(gap(e, false) == 8);
  // In a cell: the padding bars (no gap bars, no gap boxes).
  move(e, 160, 150);
  Overlay o = e.overlay();
  CHECK(o.layoutBars.size() == 4);
  CHECK(o.gapBoxes.empty());
  // Between columns 1 and 2, in row 2 (live grid-selected-hover-gap-1440): a box in every column gap of every row —
  // the gap wide, the row high — and nothing else.
  move(e, 109, 150);
  o = e.overlay();
  CHECK(o.layoutBars.empty());
  REQUIRE(o.gapBoxes.size() == 4);
  std::vector<Rect> boxes;
  for (const auto& b : o.gapBoxes) boxes.push_back(transformedBounds(b.world * Mat2x3::translate(b.rect.x, b.rect.y), b.rect.w, b.rect.h));
  std::sort(boxes.begin(), boxes.end(), [](const Rect& a, const Rect& b) { return a.y != b.y ? a.y < b.y : a.x < b.x; });
  CHECK(boxes[0].x == doctest::Approx(105.333).epsilon(1e-3));
  CHECK(boxes[0].w == doctest::Approx(8));
  CHECK(boxes[0].y == doctest::Approx(12));
  CHECK(boxes[0].h == doctest::Approx(84));
  CHECK(boxes[1].x == doctest::Approx(206.667).epsilon(1e-3));
  CHECK(boxes[2].y == doctest::Approx(104));
  CHECK(boxes[3].x == doctest::Approx(206.667).epsilon(1e-3));
  CHECK(boxes[3].y == doctest::Approx(104));
  // The cells and the hovered column's and row's compact pills stay (live: the pills above and left of the frame).
  CHECK(o.gridCells.size() == 6);
  CHECK(o.gridPills.size() == 2);
  // Between the rows: a box per column, the column wide and the gap high.
  move(e, 160, 100);
  o = e.overlay();
  REQUIRE(o.gapBoxes.size() == 3);
  for (const auto& b : o.gapBoxes) {
    CHECK(b.rect.y == doctest::Approx(96));
    CHECK(b.rect.h == doctest::Approx(8));
    CHECK(b.rect.w == doctest::Approx(93.333).epsilon(1e-3));
  }
  // Where the gaps cross: neither (no gap box holds it); the padding bars come back.
  move(e, 109, 100);
  o = e.overlay();
  CHECK(o.gapBoxes.empty());
  CHECK(o.layoutBars.size() == 4);
  // Not selected: nothing.
  e.setSelection({});
  move(e, 109, 150);
  CHECK(e.overlay().gapBoxes.empty());
}

TEST_CASE("r12 grid: dragging a gap changes that axis's gap (every gap alike), one undo step; a click changes nothing") {
  Editor e = load(alGrid());
  e.setSelection({AL});
  // The first column gap, in row 2: the box under the pointer follows it (½ a gap before its middle: 2 units per unit).
  move(e, 109, 150);
  down(e, 109, 150);
  for (int i = 1; i <= 6; i++) move(e, 109 + i, 150);
  Overlay o = e.overlay();
  // While dragging: the boxes, and the gap's value by the dragged one (as auto layout's badge).
  REQUIRE(o.layoutBars.size() == 1);
  CHECK(o.layoutBars[0].gap);
  CHECK(o.layoutBars[0].box);
  CHECK(o.layoutBars[0].hovered);
  CHECK(o.layoutBars[0].value == 20);
  CHECK(o.gapBoxes.size() == 4);
  CHECK(!o.gridCells.empty());  // the cells stay
  up(e, 115, 150);
  CHECK(gap(e, true) == 20);
  CHECK(gap(e, false) == 8);  // the rows' gap stays
  auto g = e.gridCellsOf(AL);
  REQUIRE(g.colX.size() == 3);
  CHECK(g.colX[1] - (g.colX[0] + g.colW[0]) == doctest::Approx(20));
  CHECK(g.colX[2] - (g.colX[1] + g.colW[1]) == doctest::Approx(20));
  e.command(CommandId::UNDO);
  CHECK(gap(e, true) == 8);
  // A row gap dragged up past 0: 0.
  move(e, 160, 100);
  drag(e, {160, 100}, {160, 80});
  CHECK(gap(e, false) == 0);
  e.command(CommandId::UNDO);
  CHECK(gap(e, false) == 8);
  // A click on a gap: no change; the grid stays selected.
  move(e, 109, 150);
  click(e, 109, 150);
  CHECK(gap(e, true) == 8);
  CHECK(e.selection() == std::vector<Guid>{AL});
  CHECK(e.overlay().gapBoxes.size() == 4);
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

TEST_CASE("slots: an instance's own slot content shows only while the slot does (an accordion's closed variant)") {
  // The owner's Layer item: Open=False hides the slot, and what was put in the instance's slot showed anyway, over the
  // rows under it.
  Editor e = load(cardDoc());
  e.setSelection({CONTENT});
  REQUIRE(e.command(CommandId::CONVERT_TO_SLOT) == OK);
  Guid row = derived::intern(I, {CONTENT});
  REQUIRE(e.command(CommandId::CLEAR_SLOT, args(R"({"ref":")" + row.toString() + "\"}")) == OK);
  Guid content = kNoGuid;
  for (Guid c : e.document().children(I))
    if (!c.isDerived() && e.document().get(c)->props.comp().isSlotContent) content = c;
  REQUIRE(content != kNoGuid);
  CHECK(e.document().get(content)->props.visible);
  NodeChange hide = NodeChange::changed(Guid{0, 0});
  hide.mask = F_VISIBLE;
  hide.props.visible = false;
  REQUIRE(e.setProps({CONTENT}, hide, 0) == OK);
  CHECK(!e.document().get(content)->props.visible);
  hide.props.visible = true;
  REQUIRE(e.setProps({CONTENT}, hide, 0) == OK);
  CHECK(e.document().get(content)->props.visible);
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

// ---- Slots on instances: one Layers row, drops into the slot, its auto layout, nested slots ----

namespace {

// A vertical auto-layout card (a title, then a vertical auto-layout slot: 8 apart, 10 in, a default dot) and a small
// chip component with its own slot; an instance of the card on the page, three rectangles beside it.
const Guid CARD{3, 1}, TITLE{3, 2}, SLOT{3, 3}, DOT{3, 4}, SLOTDEF{3, 0x7ffffffd};
const Guid CHIP{3, 20}, CHIPSLOT{3, 21}, CHIPDEF{3, 0x7ffffffc};
const Guid CI{3, 40}, RA{3, 41}, RB{3, 42}, RC{3, 43};

NodeChange slotFrame(Guid id, Guid parent, const std::string& pos, Rect r, Guid def) {
  NodeChange s = make(id, NodeType::FRAME, parent, pos, r, "Slot");
  s.props.comp().isSlot = true;
  s.props.fillPaints.clear();
  s.props.stack().stackMode = StackMode::VERTICAL;
  s.props.stack().stackSpacing = 8;
  s.props.stack().stackPaddingLeft = s.props.stack().stackPaddingTop = 10;
  s.props.stack().stackPaddingRight = s.props.stack().stackPaddingBottom = 10;
  s.props.stack().stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  ParamBinding b;
  b.field = VariableField::SLOT_CONTENT_ID;
  b.propRef = def;
  s.props.parameterConsumptionMap = {b};
  return s;
}

std::vector<NodeChange> slotCardDoc() {
  auto nodes = baseChanges();
  NodeChange card = make(CARD, NodeType::SYMBOL, kPage, "!", {0, 0, 200, 100}, "Card");
  card.props.stack().stackMode = StackMode::VERTICAL;
  card.props.stack().stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  ComponentPropDef d;
  d.id = SLOTDEF;
  d.name = "Content";
  d.type = ComponentPropType::SLOT;
  card.props.comp().componentPropDefs = {d};
  nodes.push_back(card);
  nodes.push_back(make(TITLE, NodeType::ROUNDED_RECTANGLE, CARD, "!", {0, 0, 200, 20}, "Title"));
  nodes.push_back(slotFrame(SLOT, CARD, "\"", {0, 20, 200, 30}, SLOTDEF));
  nodes.push_back(make(DOT, NodeType::ELLIPSE, SLOT, "!", {10, 10, 10, 10}, "Dot"));
  NodeChange chip = make(CHIP, NodeType::SYMBOL, kPage, "\"", {400, 0, 100, 40}, "Chip");
  ComponentPropDef cd;
  cd.id = CHIPDEF;
  cd.name = "Inner";
  cd.type = ComponentPropType::SLOT;
  chip.props.comp().componentPropDefs = {cd};
  nodes.push_back(chip);
  nodes.push_back(slotFrame(CHIPSLOT, CHIP, "!", {0, 0, 100, 40}, CHIPDEF));
  NodeChange inst = make(CI, NodeType::INSTANCE, kPage, "#", {0, 300, 200, 100}, "Card");
  inst.props.comp().symbolData.symbolID = CARD;
  inst.props.fillPaints.clear();
  nodes.push_back(inst);
  nodes.push_back(make(RA, NodeType::ROUNDED_RECTANGLE, kPage, "$", {600, 0, 50, 20}, "A"));
  nodes.push_back(make(RB, NodeType::ROUNDED_RECTANGLE, kPage, "%", {600, 100, 60, 30}, "B"));
  nodes.push_back(make(RC, NodeType::ROUNDED_RECTANGLE, kPage, "&", {600, 200, 20, 20}, "C"));
  return nodes;
}

Guid contentOf(const Editor& e, Guid instance) {
  for (Guid c : e.document().children(instance))
    if (!c.isDerived() && e.document().get(c)->props.comp().isSlotContent) return c;
  return kNoGuid;
}

}  // namespace

TEST_CASE("slots: layers moved into an instance's slot go into its content frame at the index, laid out by the slot's auto layout") {
  Editor e = load(slotCardDoc());
  Guid row = derived::intern(CI, {SLOT});
  REQUIRE(e.document().has(row));
  REQUIRE(e.acceptsChildren(row));
  // Into the slot, on top of its default (index 1 of one child): the content frame takes the default's copy, then A, B.
  REQUIRE(e.moveNodes({RA, RB}, row, 1) == 2);
  Guid content = contentOf(e, CI);
  REQUIRE(content != kNoGuid);
  const NodeProps& cp = e.document().get(content)->props;
  CHECK(cp.stack().stackMode == StackMode::VERTICAL);
  CHECK(cp.stack().stackSpacing == 8);
  CHECK(cp.stack().stackPaddingTop == 10);
  const auto& kids = e.document().children(content);
  REQUIRE(kids.size() == 3);
  CHECK(kids[1] == RA);
  CHECK(kids[2] == RB);
  // Laid out in the flow: the dot at the padding, A 8 under it, B 8 under A; the slot hugs them, the card too.
  Rect slotBox = e.document().worldBounds(row);
  Rect contentBox = e.document().worldBounds(content);
  CHECK(contentBox == slotBox);
  CHECK(e.document().worldBounds(kids[0]) == Rect{10, 300 + 20 + 10, 10, 10});
  CHECK(e.document().worldBounds(RA) == Rect{10, 300 + 20 + 28, 50, 20});
  CHECK(e.document().worldBounds(RB) == Rect{10, 300 + 20 + 56, 60, 30});
  CHECK(contentBox.h == doctest::Approx(10 + 10 + 8 + 20 + 8 + 30 + 10));
  CHECK(e.document().worldBounds(CI).h == doctest::Approx(20 + contentBox.h));
  // Reorder inside it as in any frame: B to the start of the flow.
  REQUIRE(e.moveNodes({RB}, content, 0) == 1);
  CHECK(e.document().children(content)[0] == RB);
  CHECK(e.document().worldBounds(RB).y == doctest::Approx(300 + 20 + 10));
  // A layer dropped on the slot row again goes into the same content frame, at that index.
  REQUIRE(e.moveNodes({RC}, row, 1) == 1);
  CHECK(contentOf(e, CI) == content);
  CHECK(e.document().children(content)[1] == RC);
  CHECK(e.document().worldBounds(RC).y == doctest::Approx(300 + 20 + 10 + 30 + 8));
  // One undo step each: back to the main's default.
  e.command(CommandId::UNDO);
  e.command(CommandId::UNDO);
  e.command(CommandId::UNDO);
  CHECK(!e.document().has(content));
  CHECK(e.document().parentOf(RA) == kPage);
  CHECK(e.document().has(derived::intern(CI, {SLOT, DOT})));
}

TEST_CASE("slots: an instance's diverged slot is one Layers row — its content frame in the slot's place, with the slot glyph") {
  Editor e = load(slotCardDoc());
  Guid row = derived::intern(CI, {SLOT});
  Guid title = derived::intern(CI, {TITLE});
  // Not diverged: the slot row itself (it takes layers).
  CHECK(e.layerChildren(CI) == std::vector<Guid>{title, row});
  CHECK(e.layerSlot(row));
  CHECK(!e.layerSlot(title));
  REQUIRE(e.moveNodes({RA}, row, 1) == 1);
  Guid content = contentOf(e, CI);
  REQUIRE(content != kNoGuid);
  // Diverged: the content frame where the slot row was (and not again at the end), its layers under it.
  CHECK(e.layerChildren(CI) == std::vector<Guid>{title, content});
  CHECK(e.layerParent(content) == CI);
  CHECK(e.layerSlot(content));
  CHECK(e.layerHidden(row));
  CHECK(e.layerChildren(content) == e.document().children(content));
  CHECK(e.layerParent(RA) == content);
  // Selecting the slot row selects what it shows.
  REQUIRE(e.setSelection({row}) == OK);
  CHECK(e.selection() == std::vector<Guid>{content});
  // Delete contents and Reset slot on the row as shown.
  REQUIRE(e.command(CommandId::CLEAR_SLOT) == OK);
  CHECK(e.document().children(content).empty());
  CHECK(e.layerChildren(CI) == std::vector<Guid>{title, content});
  e.setSelection({content});
  REQUIRE(e.command(CommandId::RESET_SLOT) == OK);
  CHECK(!e.document().has(content));
  CHECK(e.layerChildren(CI) == std::vector<Guid>{title, row});
  CHECK(!e.layerHidden(row));
}

TEST_CASE("slots: a paste beside a layer of an instance's slot lands in the slot (its content frame), after that layer") {
  Editor e = load(slotCardDoc());
  e.setSelection({RA});
  Clipboard clip;
  REQUIRE(e.copySelection(clip, false));
  e.setSelection({derived::intern(CI, {SLOT, DOT})});
  REQUIRE(e.paste(clip, false) == 1);
  Guid content = contentOf(e, CI);
  REQUIRE(content != kNoGuid);
  const auto& kids = e.document().children(content);
  REQUIRE(kids.size() == 2);
  CHECK(e.document().get(kids[1])->props.name == "A");
  CHECK(e.document().worldBounds(kids[1]).y == doctest::Approx(300 + 20 + 28));  // in the slot's flow
  // Selected, the slot's own content frame takes a paste too (into it, on top).
  e.setSelection({content});
  REQUIRE(e.paste(clip, false) == 1);
  CHECK(e.document().children(content).size() == 3);
}

TEST_CASE("slots: an instance inside another instance's slot content takes layers in its own slot (nested slot content)") {
  auto nodes = slotCardDoc();
  const Guid CHIPI{3, 50};
  NodeChange chipInst = make(CHIPI, NodeType::INSTANCE, kPage, "'", {800, 0, 100, 40}, "Chip");
  chipInst.props.comp().symbolData.symbolID = CHIP;
  chipInst.props.fillPaints.clear();
  nodes.push_back(chipInst);
  Editor e = load(nodes);
  Guid row = derived::intern(CI, {SLOT});
  REQUIRE(e.moveNodes({CHIPI}, row, 1) == 1);
  Guid content = contentOf(e, CI);
  REQUIRE(content != kNoGuid);
  REQUIRE(e.document().parentOf(CHIPI) == content);
  // The chip's own slot, inside the card's slot content: a layer goes into the chip's content frame.
  Guid inner = derived::intern(CHIPI, {CHIPSLOT});
  REQUIRE(e.document().has(inner));
  CHECK(e.acceptsChildren(inner));
  REQUIRE(e.moveNodes({RA}, inner, 0) == 1);
  Guid chipContent = contentOf(e, CHIPI);
  REQUIRE(chipContent != kNoGuid);
  CHECK(e.document().parentOf(RA) == chipContent);
  CHECK(e.document().worldBounds(RA).x == doctest::Approx(e.document().worldBounds(chipContent).x + 10));
  CHECK(e.layerChildren(CHIPI) == std::vector<Guid>{chipContent});
  // And straight into the content frame shown in the slot's place.
  REQUIRE(e.moveNodes({RB}, chipContent, 0) == 1);
  CHECK(e.document().parentOf(RB) == chipContent);
}

TEST_CASE("slots: a chip the card's slot shows by default (an instance in the main's slot) takes layers in its own slot") {
  auto nodes = slotCardDoc();
  const Guid CHIPD{3, 60};
  NodeChange chipDefault = make(CHIPD, NodeType::INSTANCE, SLOT, "\"", {10, 30, 100, 40}, "Chip");
  chipDefault.props.comp().symbolData.symbolID = CHIP;
  chipDefault.props.fillPaints.clear();
  nodes.push_back(chipDefault);
  Editor e = load(nodes);
  Guid inner = derived::intern(CI, {SLOT, CHIPD, CHIPSLOT});
  REQUIRE(e.document().has(inner));
  CHECK(e.acceptsChildren(inner));
  CHECK(e.layerSlot(inner));
  REQUIRE(e.moveNodes({RA}, inner, 0) == 1);
  Guid content = e.document().parentOf(RA);
  REQUIRE(content != kNoGuid);
  CHECK(e.document().get(content)->props.comp().isSlotContent);
  CHECK(e.document().parentOf(content) == CI);
  CHECK(e.shownSlotRow(content) == inner);
  CHECK(e.layerParent(content) == derived::intern(CI, {SLOT, CHIPD}));
  // In the chip's slot, at its padding.
  Rect slot = e.document().worldBounds(inner);
  CHECK(e.document().worldBounds(content) == slot);
  CHECK(e.document().worldBounds(RA).x == doctest::Approx(slot.x + 10));
  CHECK(e.document().worldBounds(RA).y == doctest::Approx(slot.y + 10));
}
