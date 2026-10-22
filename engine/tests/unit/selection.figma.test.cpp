// Canvas selection against Figma (2026-10-22 audit): clicks, right-clicks, keys and marquees on components,
// instances, groups and frames. Figma's rules and their sources are in docs/engine.md §8.2.
#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

// A main component M (0,0 100×40: background BG, label LB) and its instance I at (0,100); a top-level frame F at
// (300,0) 200×200 holding a group G (FRAME + resizeToFit) of GA and GB, and a rectangle R. Screen = world.
const Guid M{1, 1}, BG{1, 2}, LB{1, 3}, I{1, 10}, F{1, 20}, G{1, 21}, GA{1, 22}, GB{1, 23}, R{1, 24};

std::vector<NodeChange> scene() {
  auto nodes = baseChanges();
  NodeChange m = make(M, NodeType::SYMBOL, kPage, "!", {0, 0, 100, 40}, "Button");
  m.props.fillPaints.clear();
  nodes.push_back(m);
  nodes.push_back(make(BG, NodeType::ROUNDED_RECTANGLE, M, "!", {0, 0, 100, 40}, "Background"));
  nodes.push_back(make(LB, NodeType::ROUNDED_RECTANGLE, M, "\"", {10, 10, 80, 20}, "Label"));
  NodeChange i = make(I, NodeType::INSTANCE, kPage, "\"", {0, 100, 100, 40}, "Button");
  i.props.comp().symbolData.symbolID = M;
  i.props.fillPaints.clear();
  nodes.push_back(i);
  nodes.push_back(make(F, NodeType::FRAME, kPage, "#", {300, 0, 200, 200}, "Frame"));
  NodeChange g = make(G, NodeType::FRAME, F, "!", {10, 10, 100, 50}, "Group");
  g.props.resizeToFit = true;
  g.props.fillPaints.clear();
  nodes.push_back(g);
  nodes.push_back(make(GA, NodeType::ROUNDED_RECTANGLE, G, "!", {0, 0, 40, 50}, "A"));
  nodes.push_back(make(GB, NodeType::ROUNDED_RECTANGLE, G, "\"", {60, 0, 40, 50}, "B"));
  nodes.push_back(make(R, NodeType::ROUNDED_RECTANGLE, F, "\"", {10, 120, 50, 50}, "R"));
  return nodes;
}

Editor load() {
  Editor e;
  e.setSessionID(1);
  e.setViewport(1000, 800, 1, 1000, 800);
  e.loadDocument(scene(), kNoGuid);
  e.setCamera({0, 0, 1});
  e.takeEvents();
  return e;
}

void click(Editor& e, double x, double y, uint32_t mods = 0, int clicks = 1) {
  e.pointer(PointerEvent::DOWN, x, y, 0, 1, mods, clicks);
  e.pointer(PointerEvent::UP, x, y, 0, 0, mods);
}
// A right click (the menu opens on the release with Right-click and drag to pan on, the default).
Editor::Events rightClick(Editor& e, double x, double y, uint32_t mods = 0) {
  e.takeEvents();
  e.pointer(PointerEvent::DOWN, x, y, 2, 2, mods);
  e.pointer(PointerEvent::UP, x, y, 2, 0, mods);
  return e.takeEvents();
}
using Sel = std::vector<Guid>;

}  // namespace

TEST_CASE("selection: a right-click on a selected component keeps it selected, the menu is the component's") {
  Editor e = load();
  e.setSelection({M});
  auto ev = rightClick(e, 50, 20);  // over the label, inside the selected main component
  REQUIRE(ev.contextMenus.size() == 1);
  CHECK(ev.contextMenus[0].selection);
  CHECK(e.selection() == Sel{M});
}

TEST_CASE("selection: a right-click on a selected instance keeps the instance, not its sublayer") {
  Editor e = load();
  e.setSelection({I});
  rightClick(e, 50, 120);
  CHECK(e.selection() == Sel{I});
}

TEST_CASE("selection: a right-click inside a selected group keeps the group") {
  Editor e = load();
  e.setSelection({G});
  rightClick(e, 320, 30);  // on GA
  CHECK(e.selection() == Sel{G});
  // A multi-selection stays whole when one of its layers is right-clicked (live context-multi.txt).
  e.setSelection({GA, R});
  rightClick(e, 320, 130);
  CHECK(e.selection() == (Sel{GA, R}));
}

TEST_CASE("selection: a right-click on an unselected layer selects what a left press would") {
  Editor e = load();
  rightClick(e, 50, 120);  // an instance: whole
  CHECK(e.selection() == Sel{I});
  rightClick(e, 320, 30);  // in a group inside a top-level frame: the group
  CHECK(e.selection() == Sel{G});
  rightClick(e, 320, 130);  // a top-level frame's child
  CHECK(e.selection() == Sel{R});
  rightClick(e, 50, 20, MOD_PRIMARY);  // ⌘: the deepest
  CHECK(e.selection() == Sel{LB});
  rightClick(e, 700, 500);  // empty canvas: the selection stays
  CHECK(e.selection() == Sel{LB});
}

TEST_CASE("selection: a left click inside a selected component still goes one level down (unchanged)") {
  Editor e = load();
  e.setSelection({M});
  click(e, 50, 20);
  CHECK(e.selection() == Sel{LB});
}

// ---- The rest of the audit: Figma's rules as Wecra already had them, kept by these cases -------------------------

namespace {
uint32_t key(Editor& e, KeyCode k, uint32_t mods = 0) { return e.key(KeyEvent::DOWN, k, 0, mods, false); }
void drag(Editor& e, Vec2 a, Vec2 b, uint32_t mods = 0) {
  e.pointer(PointerEvent::DOWN, a.x, a.y, 0, 1, mods, 1);
  for (int i = 1; i <= 4; i++) e.pointer(PointerEvent::MOVE, a.x + (b.x - a.x) * i / 4, a.y + (b.y - a.y) * i / 4, 0, 1, mods);
  e.pointer(PointerEvent::UP, b.x, b.y, 0, 0, mods);
}
}  // namespace

TEST_CASE("selection: clicks — instance whole, double-click one level down, siblings direct, ⇧ toggles, ⌘ deep") {
  Editor e = load();
  click(e, 50, 120);
  CHECK(e.selection() == Sel{I});  // an instance picks whole
  click(e, 50, 120, 0, 2);
  CHECK(e.selection().size() == 1);
  CHECK(e.selection()[0] != I);  // double-click: one level down
  click(e, 320, 30);
  CHECK(e.selection() == Sel{G});
  click(e, 320, 30, 0, 2);
  CHECK(e.selection() == Sel{GA});
  click(e, 380, 30);  // a sibling of the selected layer: picked directly
  CHECK(e.selection() == Sel{GB});
  click(e, 330, 130, MOD_SHIFT);
  CHECK(e.selection() == (Sel{GB, R}));
  click(e, 330, 130, MOD_SHIFT);
  CHECK(e.selection() == Sel{GB});
  click(e, 320, 30, MOD_PRIMARY);
  CHECK(e.selection() == Sel{GA});
  click(e, 700, 500);
  CHECK(e.selection().empty());
}

TEST_CASE("selection: ⇧Enter parent (not the page), Enter children, Tab wraps, Esc clears") {
  Editor e = load();
  e.setSelection({GA});
  key(e, KeyCode::Enter, MOD_SHIFT);
  CHECK(e.selection() == Sel{G});
  key(e, KeyCode::Enter, MOD_SHIFT);
  CHECK(e.selection() == Sel{F});
  key(e, KeyCode::Enter, MOD_SHIFT);
  CHECK(e.selection() == Sel{F});
  key(e, KeyCode::Enter);
  CHECK(e.selection() == (Sel{G, R}));
  e.setSelection({G});
  key(e, KeyCode::Tab);
  CHECK(e.selection() == Sel{R});
  key(e, KeyCode::Tab);
  CHECK(e.selection() == Sel{G});
  key(e, KeyCode::Escape);
  CHECK(e.selection().empty());
  e.setSelection({I});
  key(e, KeyCode::Enter);
  CHECK(e.selection().size() == 2);
}

TEST_CASE("selection: a marquee over part of a top-level instance takes the instance, not its sublayers") {
  Editor e = load();
  drag(e, {-20, 90}, {50, 160});  // over part of the instance
  CHECK(e.selection() == Sel{I});
  drag(e, {-20, -20}, {120, 160});  // the main and the instance whole
  CHECK(e.selection() == (Sel{M, I}));
  drag(e, {280, 100}, {340, 180});  // part of the frame: its child R
  CHECK(e.selection() == Sel{R});
  drag(e, {200, -20}, {600, 300});  // the frame whole
  CHECK(e.selection() == Sel{F});
}

TEST_CASE("selection: hover outlines what a click would pick") {
  Editor e = load();
  e.pointer(PointerEvent::MOVE, 320, 30, 0, 0, 0);
  CHECK(e.hover() == G);
  e.setSelection({M});
  e.pointer(PointerEvent::MOVE, 50, 20, 0, 0, 0);
  CHECK(e.hover() == LB);
  e.pointer(PointerEvent::MOVE, 50, 120, 0, 0, MOD_PRIMARY);
  CHECK(e.hover() != I);
}

TEST_CASE("selection: after duplicate, undo, redo and paste") {
  Editor e = load();
  e.setSelection({R});
  REQUIRE(e.command(CommandId::DUPLICATE) == OK);
  REQUIRE(e.selection().size() == 1);
  Guid copy = e.selection()[0];
  CHECK(copy != R);
  e.command(CommandId::UNDO);
  CHECK(e.selection() == Sel{R});
  e.command(CommandId::REDO);
  CHECK(e.selection() == Sel{copy});
  Clipboard clip;
  e.setSelection({R});
  REQUIRE(e.copySelection(clip));
  e.setSelection({});
  CHECK(e.paste(clip, false) == 1);
  CHECK(e.selection().size() == 1);
}

// ---- The live measurement (docs/research/figma/live/behaviour/selection.md, 2026-10-22): its scene, every row -------

namespace {

// Page children back to front: FrameA (0,0 600×400: R1, G1 = group(R2, E1), F2 = frame(R3), T1, L1 locked, H1 hidden,
// IA = instance of Button), Button (main: Label text, Icon rect), IT (top-level instance), Chip (set: Default, Hover),
// CI (Chip inst), Section1 (F3(R4)), AL (auto layout: A0..A2). Screen = world.
const Guid FA{2, 1}, R1{2, 2}, G1{2, 3}, R2{2, 4}, E1{2, 5}, F2{2, 6}, R3{2, 7}, T1{2, 8}, L1{2, 9}, H1{2, 10}, IA{2, 11},
    BTN{2, 20}, LBL{2, 21}, ICO{2, 22}, IT{2, 23}, CHIP{2, 30}, CD{2, 31}, CH{2, 32}, CI{2, 33}, S1{2, 40}, F3{2, 41}, R4{2, 42},
    AL{2, 50}, A0{2, 51}, A1{2, 52}, A2{2, 53}, STATE{2, 99};

NodeChange specInstance(Guid id, Guid main, Guid parent, const std::string& pos, Rect r, const char* name) {
  NodeChange c = make(id, NodeType::INSTANCE, parent, pos, r, name);
  c.props.comp().symbolData.symbolID = main;
  c.props.fillPaints.clear();
  return c;
}

NodeChange specText(Guid id, Guid parent, const std::string& pos, Rect r, const char* chars) {
  NodeChange t = make(id, NodeType::TEXT, parent, pos, r, chars);
  t.props.text().textData.characters = chars;
  t.props.text().textAutoResize = TextAutoResize::NONE;
  return t;
}

std::vector<NodeChange> specScene() {
  auto nodes = baseChanges();
  nodes.push_back(make(FA, NodeType::FRAME, kPage, "!", {0, 0, 600, 400}, "FrameA"));
  nodes.push_back(make(R1, NodeType::ROUNDED_RECTANGLE, FA, "!", {20, 20, 80, 80}, "R1"));
  NodeChange g = make(G1, NodeType::FRAME, FA, "\"", {150, 20, 140, 60}, "G1");
  g.props.resizeToFit = true;
  g.props.fillPaints.clear();
  nodes.push_back(g);
  nodes.push_back(make(R2, NodeType::ROUNDED_RECTANGLE, G1, "!", {0, 0, 60, 60}, "R2"));
  nodes.push_back(make(E1, NodeType::ELLIPSE, G1, "\"", {80, 0, 60, 60}, "E1"));
  nodes.push_back(make(F2, NodeType::FRAME, FA, "#", {320, 20, 200, 150}, "F2"));
  nodes.push_back(make(R3, NodeType::ROUNDED_RECTANGLE, F2, "!", {20, 20, 60, 60}, "R3"));
  nodes.push_back(specText(T1, FA, "$", {20, 200, 100, 30}, "T1"));
  NodeChange l = make(L1, NodeType::ROUNDED_RECTANGLE, FA, "%", {150, 200, 60, 60}, "L1");
  l.props.locked = true;
  nodes.push_back(l);
  NodeChange h = make(H1, NodeType::ROUNDED_RECTANGLE, FA, "&", {250, 200, 60, 60}, "H1");
  h.props.visible = false;
  nodes.push_back(h);
  nodes.push_back(specInstance(IA, BTN, FA, "'", {350, 250, 100, 40}, "Button inst A"));
  nodes.push_back(make(BTN, NodeType::SYMBOL, kPage, "\"", {700, 0, 100, 40}, "Button"));
  nodes.push_back(specText(LBL, BTN, "!", {10, 10, 50, 20}, "Label"));
  nodes.push_back(make(ICO, NodeType::ROUNDED_RECTANGLE, BTN, "\"", {70, 10, 20, 20}, "Icon"));
  nodes.push_back(specInstance(IT, BTN, kPage, "#", {700, 100, 100, 40}, "Button inst top"));
  NodeChange set = make(CHIP, NodeType::FRAME, kPage, "$", {700, 200, 300, 60}, "Chip");
  set.props.comp().isStateGroup = true;
  ComponentPropDef def;
  def.id = STATE;
  def.name = "State";
  def.type = ComponentPropType::VARIANT;
  set.props.comp().componentPropDefs = {def};
  nodes.push_back(set);
  NodeChange cd = make(CD, NodeType::SYMBOL, CHIP, "!", {10, 10, 130, 40}, "State=Default");
  cd.props.comp().variantPropSpecs = {{STATE, "Default"}};
  cd.props.fillPaints = {Paint::solid(Color::hex(0xFFFFFF))};
  nodes.push_back(cd);
  NodeChange ch = make(CH, NodeType::SYMBOL, CHIP, "\"", {160, 10, 130, 40}, "State=Hover");
  ch.props.comp().variantPropSpecs = {{STATE, "Hover"}};
  ch.props.fillPaints = {Paint::solid(Color::hex(0xFFFFFF))};
  nodes.push_back(ch);
  nodes.push_back(specInstance(CI, CD, kPage, "%", {700, 300, 130, 40}, "Chip inst"));
  nodes.push_back(make(S1, NodeType::SECTION, kPage, "&", {0, 500, 500, 300}, "Section1"));
  nodes.push_back(make(F3, NodeType::FRAME, S1, "!", {50, 50, 200, 150}, "F3"));
  nodes.push_back(make(R4, NodeType::ROUNDED_RECTANGLE, F3, "!", {20, 20, 60, 60}, "R4"));
  NodeChange al = make(AL, NodeType::FRAME, kPage, "'", {700, 500, 180, 60}, "AL");
  al.props.stack().stackMode = StackMode::HORIZONTAL;
  nodes.push_back(al);
  nodes.push_back(make(A0, NodeType::ROUNDED_RECTANGLE, AL, "!", {0, 0, 60, 60}, "A0"));
  nodes.push_back(make(A1, NodeType::ROUNDED_RECTANGLE, AL, "\"", {60, 0, 60, 60}, "A1"));
  nodes.push_back(make(A2, NodeType::ROUNDED_RECTANGLE, AL, "#", {120, 0, 60, 60}, "A2"));
  return nodes;
}

Editor specLoad() {
  Editor e;
  e.setSessionID(1);
  e.setViewport(1400, 1000, 1, 1400, 1000);
  e.loadDocument(specScene(), kNoGuid);
  e.setCamera({0, 0, 1});
  e.takeEvents();
  return e;
}

Guid sub(Editor& e, Guid parent, const char* name) {
  for (Guid c : e.document().children(parent))
    if (e.document().get(c)->props.name == name) return c;
  return kNoGuid;
}

Sel sorted(Sel s) {
  std::sort(s.begin(), s.end(), [](Guid a, Guid b) { return a.sessionID != b.sessionID ? a.sessionID < b.sessionID : a.localID < b.localID; });
  return s;
}

// The selection by layer names, for failure messages.
std::string names(Editor& e, const Sel& s) {
  std::string out;
  for (Guid id : s) out += (out.empty() ? "" : ", ") + (e.document().get(id) ? e.document().get(id)->props.name : "?");
  return "[" + out + "]";
}

// Two presses on one spot, the second a double-click's (the first selects, as in Figma).
void dbl(Editor& e, Vec2 at) {
  click(e, at.x, at.y, 0, 1);
  click(e, at.x, at.y, 0, 2);
}

// On R1, R2, E1, R3, L1, H1, IA's Label, FrameA's background, IT's Label and Icon, the Default variant, Section1's
// background, R4, F3's background, A0.
constexpr Vec2 pR1{50, 50}, pR2{180, 50}, pE1{260, 50}, pR3{370, 70}, pL1{180, 230}, pH1{280, 230}, pIALabel{365, 265},
    pFABg{300, 350}, pITLabel{715, 115}, pITIcon{785, 120}, pCD{730, 220}, pS1Bg{400, 700}, pR4{100, 600}, pF3Bg{200, 680},
    pA0{730, 530};

}  // namespace

TEST_CASE("selection spec: click (left)") {
  Editor e = specLoad();
  Guid itLabel = sub(e, IT, "Label"), itIcon = sub(e, IT, "Icon");
  REQUIRE(sub(e, IA, "Label") != kNoGuid);
  REQUIRE(itIcon != kNoGuid);
  auto row = [&](const char* name, Sel before, Vec2 at, Sel after) {
    e.setSelection(before);
    click(e, at.x, at.y);
    INFO(std::string(name), " got ", names(e, e.selection()), " want ", names(e, after));
    CHECK(sorted(e.selection()) == sorted(after));
  };
  row("#1", {}, pR1, {R1});
  row("#2", {}, pR2, {G1});
  row("#3", {G1}, pR2, {G1});
  row("#4", {}, pR3, {F2});
  row("#5", {}, pIALabel, {IA});
  row("#6", {IA}, pIALabel, {IA});
  row("#7", {}, pITLabel, {IT});
  row("#8", {IT}, pITLabel, {IT});
  row("#9", {FA}, pR1, {R1});
  row("#10", {F2}, pR3, {F2});
  row("#11", {}, pFABg, {});
  row("#12", {}, pL1, {});
  row("#13", {}, pH1, {});
  row("K7", {}, pS1Bg, {S1});
  row("K8", {}, pR4, {R4});
  row("K11", {}, pF3Bg, {});
  row("K9", {}, pA0, {A0});
  row("K10", {}, pCD, {CD});
  row("S1", {R2}, pE1, {E1});
  row("S2", {itLabel}, pITIcon, {itIcon});
  row("S3", {R2}, pR1, {R1});
}

TEST_CASE("selection spec: a double-click goes one level down") {
  Editor e = specLoad();
  dbl(e, pR2);
  CHECK(e.selection() == Sel{R2});  // K5
  e.setSelection({});
  dbl(e, pR3);
  CHECK(e.selection() == Sel{R3});  // K12
  e.setSelection({});
  dbl(e, pITLabel);
  CHECK(e.selection() == Sel{sub(e, IT, "Label")});  // K6
}

TEST_CASE("selection spec: modifiers") {
  Editor e = specLoad();
  click(e, pR2.x, pR2.y, MOD_PRIMARY);
  CHECK(e.selection() == Sel{R2});  // K1
  e.setSelection({});
  click(e, pIALabel.x, pIALabel.y, MOD_PRIMARY);
  CHECK(e.selection() == Sel{sub(e, IA, "Label")});  // K2
  e.setSelection({G1});
  click(e, pR2.x, pR2.y, MOD_SHIFT);
  CHECK(e.selection() == Sel{G1});  // K3
  e.setSelection({R1});
  click(e, pR3.x, pR3.y, MOD_SHIFT);
  CHECK(sorted(e.selection()) == sorted({R1, F2}));  // K4
}

TEST_CASE("selection spec: right-click") {
  Editor e = specLoad();
  auto row = [&](const char* name, Sel before, Vec2 at, Sel after) {
    e.setSelection(before);
    auto ev = rightClick(e, at.x, at.y);
    INFO(std::string(name), " got ", names(e, e.selection()), " want ", names(e, after));
    CHECK(ev.contextMenus.size() == 1);
    CHECK(sorted(e.selection()) == sorted(after));
  };
  row("R1", {}, pR2, {G1});
  row("R2", {IT}, pITLabel, {IT});
  row("R3", {FA}, pR1, {FA});
  row("R4", {}, pFABg, {FA});
  row("R5", {G1}, pR2, {G1});
  row("R6", {R1, F2}, pR3, {R1, F2});
}

TEST_CASE("selection spec: marquee") {
  Editor e = specLoad();
  drag(e, {-30, 30}, {60, 60});  // M1: from outside over part of FrameA, crossing R1
  CHECK(e.selection() == Sel{R1});
  e.setSelection({});
  drag(e, {60, 110}, {170, 60});  // M2: from FrameA's background over R1 and part of G1
  CHECK(sorted(e.selection()) == sorted({R1, G1}));
  e.setSelection({});
  drag(e, {680, 90}, {720, 120});  // M3: part of the top-level instance
  CHECK(e.selection() == Sel{IT});
  e.setSelection({});
  drag(e, {-30, 480}, {90, 590});  // M5: part of Section1, F3 and R4
  CHECK(e.selection() == Sel{R4});
  e.setSelection({});
  drag(e, {680, -20}, {720, 15});  // M6: part of the main component
  CHECK(e.selection() == Sel{BTN});
}

TEST_CASE("selection spec: a press on empty space inside a multi-selection's box drags the selection") {
  Editor e = specLoad();
  e.setSelection({R1, F2});
  Rect r1 = e.document().worldBounds(R1), f2 = e.document().worldBounds(F2);
  drag(e, {300, 150}, {320, 170});  // FrameA's background, inside the box of R1 + F2
  CHECK(sorted(e.selection()) == sorted({R1, F2}));  // MS
  CHECK(e.document().worldBounds(R1).x == doctest::Approx(r1.x + 20));
  CHECK(e.document().worldBounds(F2).y == doctest::Approx(f2.y + 20));
}

TEST_CASE("selection spec: keyboard") {
  Editor e = specLoad();
  e.setSelection({FA});
  key(e, KeyCode::Enter);
  CHECK(sorted(e.selection()) == sorted({R1, G1, F2, T1, L1, H1, IA}));  // E1
  e.setSelection({G1});
  key(e, KeyCode::Enter);
  CHECK(sorted(e.selection()) == sorted({R2, E1}));  // E11
  e.setSelection({IT});
  key(e, KeyCode::Enter);
  CHECK(sorted(e.selection()) == sorted({sub(e, IT, "Label"), sub(e, IT, "Icon")}));  // E5
  e.setSelection({R1});
  key(e, KeyCode::Enter, MOD_SHIFT);
  CHECK(e.selection() == Sel{FA});  // E2
  for (Sel s : {Sel{R1}, Sel{sub(e, IA, "Label")}, Sel{G1}, Sel{FA}}) {  // E3, E6, E7, E8
    e.setSelection(s);
    key(e, KeyCode::Escape);
    CHECK(e.selection().empty());
  }
  e.setSelection({R1});
  key(e, KeyCode::Tab);
  CHECK(e.selection() == Sel{IA});  // E4
  for (Guid want : {H1, L1, T1, F2, G1}) {  // E9
    key(e, KeyCode::Tab);
    CHECK(e.selection() == Sel{want});
  }
  e.setSelection({R1});
  key(e, KeyCode::Tab, MOD_SHIFT);
  CHECK(e.selection() == Sel{G1});  // E10
}
