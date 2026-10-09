// Round 14 — deep select (⌘-click, ⌘-double-click, ⌘-marquee) on frames that have layers in them. Figma:
// help.figma.com "Select layers and objects" — "Hold down the modifier key to select the top-level frame or a nested
// layer or object by clicking it on the canvas"; "To select nested layers, hold down the modifier key and drag the
// marquee across the objects". Live Figma (docs/research/figma/live/behaviour/canvas.md): a click on a top-level
// frame's empty background with children selects nothing, its title selects it, a nested frame's background selects
// the nested frame. Frames with no fill or stroke aren't hit by their box below the top level (Figma's deep select
// skips layers without a fill — forum "Improve Deep Select of Objects Without Fill", 2023).
#include "doctest.h"
#include "editor/Editor.h"
#include "hit/HitTest.h"
#include "hit/Marquee.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid TOPF{1, 1}, A{1, 2}, B{1, 3}, C{1, 4}, R{1, 5}, AL{1, 6}, AL1{1, 7}, AL2{1, 8}, AL3{1, 9}, ALN{1, 10},
    ALN1{1, 11}, ALN2{1, 12}, HID{1, 13}, HIDR{1, 14}, LCK{1, 15}, LCKR{1, 16}, OTHER{1, 17};

NodeChange autoLayout(Guid id, Guid parent, const std::string& pos, Rect r, bool fill) {
  NodeChange f = make(id, NodeType::FRAME, parent, pos, r, fill ? "Row" : "Row (no fill)");
  f.props.stack().stackMode = StackMode::HORIZONTAL;
  f.props.stack().stackSpacing = 20;
  f.props.stack().stackPaddingLeft = f.props.stack().stackPaddingTop = f.props.stack().stackPaddingRight =
      f.props.stack().stackPaddingBottom = 10;
  f.props.stack().stackPrimarySizing = StackSize::FIXED;
  if (!fill) f.props.fillPaints.clear();
  return f;
}

// TOPF (800×500, top-level) holds A ⊃ B ⊃ C ⊃ R (each frame filled, 20 px in), an auto-layout row AL (filled,
// padding 10, gap 20, three 40 px squares), the same row ALN without a fill, a hidden frame and a locked one. OTHER is
// a second top-level frame beside it. The camera puts the page origin at (100, 100) on screen.
Editor makeEditor() {
  auto nodes = baseChanges();
  nodes.push_back(make(TOPF, NodeType::FRAME, kPage, "!", {0, 0, 800, 500}, "Page frame"));
  nodes.push_back(make(A, NodeType::FRAME, TOPF, "!", {20, 20, 400, 300}, "A"));
  nodes.push_back(make(B, NodeType::FRAME, A, "!", {20, 20, 300, 200}, "B"));
  nodes.push_back(make(C, NodeType::FRAME, B, "!", {20, 20, 200, 120}, "C"));
  nodes.push_back(make(R, NodeType::ROUNDED_RECTANGLE, C, "!", {20, 20, 50, 50}, "R"));
  nodes.push_back(autoLayout(AL, TOPF, "\"", {450, 20, 200, 60}, true));
  nodes.push_back(make(AL1, NodeType::ROUNDED_RECTANGLE, AL, "!", {10, 10, 40, 40}, "S1"));
  nodes.push_back(make(AL2, NodeType::ROUNDED_RECTANGLE, AL, "\"", {70, 10, 40, 40}, "S2"));
  nodes.push_back(make(AL3, NodeType::ROUNDED_RECTANGLE, AL, "#", {130, 10, 40, 40}, "S3"));
  nodes.push_back(autoLayout(ALN, TOPF, "#", {450, 120, 200, 60}, false));
  nodes.push_back(make(ALN1, NodeType::ROUNDED_RECTANGLE, ALN, "!", {10, 10, 40, 40}, "T1"));
  nodes.push_back(make(ALN2, NodeType::ROUNDED_RECTANGLE, ALN, "\"", {70, 10, 40, 40}, "T2"));
  NodeChange hid = make(HID, NodeType::FRAME, TOPF, "$", {450, 220, 100, 100}, "Hidden");
  hid.props.visible = false;
  nodes.push_back(hid);
  nodes.push_back(make(HIDR, NodeType::ROUNDED_RECTANGLE, HID, "!", {10, 10, 40, 40}));
  NodeChange lck = make(LCK, NodeType::FRAME, TOPF, "%", {600, 220, 100, 100}, "Locked");
  lck.props.locked = true;
  nodes.push_back(lck);
  nodes.push_back(make(LCKR, NodeType::ROUNDED_RECTANGLE, LCK, "!", {10, 10, 40, 40}));
  nodes.push_back(make(OTHER, NodeType::FRAME, kPage, "\"", {900, 0, 200, 200}, "Empty"));
  Editor e;
  e.setSessionID(1);
  e.setViewport(1400, 900, 1, 1400, 900);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({100, 100, 1});
  e.takeEvents();
  return e;
}

void down(Editor& e, Vec2 w, uint32_t mods = 0, int clicks = 1) { e.pointer(PointerEvent::DOWN, w.x + 100, w.y + 100, 0, 1, mods, clicks); }
void move(Editor& e, Vec2 w, uint32_t mods = 0) { e.pointer(PointerEvent::MOVE, w.x + 100, w.y + 100, 0, 1, mods); }
void up(Editor& e, Vec2 w, uint32_t mods = 0) { e.pointer(PointerEvent::UP, w.x + 100, w.y + 100, 0, 0, mods); }
// A click at a world point.
void click(Editor& e, Vec2 w, uint32_t mods = 0, int clicks = 1) {
  down(e, w, mods, clicks);
  up(e, w, mods);
}
void drag(Editor& e, Vec2 from, Vec2 to, uint32_t mods = 0) {
  down(e, from, mods);
  for (int i = 1; i <= 4; i++) {
    double t = i / 4.0;
    move(e, {from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t}, mods);
  }
  up(e, to, mods);
}
using Sel = std::vector<Guid>;

}  // namespace

TEST_CASE("r14 deep select: ⌘-click a nested frame's own fill selects it, a child selects the child, at any depth") {
  Editor e = makeEditor();
  click(e, {100, 100}, MOD_PRIMARY);  // on R (inside C ⊂ B ⊂ A)
  CHECK(e.selection() == Sel{R});
  click(e, {200, 150}, MOD_PRIMARY);  // C's padding, beside R
  CHECK(e.selection() == Sel{C});
  click(e, {300, 200}, MOD_PRIMARY);  // B's padding (outside C)
  CHECK(e.selection() == Sel{B});
  click(e, {400, 300}, MOD_PRIMARY);  // A's padding (outside B)
  CHECK(e.selection() == Sel{A});
  // From a selection elsewhere and from nothing, the same.
  e.setSelection({OTHER});
  click(e, {200, 150}, MOD_PRIMARY);
  CHECK(e.selection() == Sel{C});
  e.setSelection({});
  click(e, {300, 200}, MOD_PRIMARY);
  CHECK(e.selection() == Sel{B});
  // ⇧⌘ adds the deep pick to the selection.
  click(e, {200, 150}, MOD_PRIMARY | MOD_SHIFT);
  CHECK(e.selection() == Sel{B, C});
  // Without ⌘ a click picks by level: the top-level frame's direct child, whatever is under it.
  e.setSelection({});
  click(e, {100, 100});
  CHECK(e.selection() == Sel{A});
}

TEST_CASE("r14 deep select: ⌘-click on a top-level frame's background selects the frame (a plain click doesn't)") {
  Editor e = makeEditor();
  // Live Figma: a click on the empty background of a top-level frame with layers in it selects nothing…
  click(e, {750, 450});
  CHECK(e.selection().empty());
  // …help.figma.com: ⌘ selects the top-level frame.
  click(e, {750, 450}, MOD_PRIMARY);
  CHECK(e.selection() == Sel{TOPF});
  // ⇧⌘ adds it (and removes it again), as ⇧ on its title.
  e.setSelection({OTHER});
  click(e, {750, 450}, MOD_PRIMARY | MOD_SHIFT);
  CHECK(e.selection() == Sel{OTHER, TOPF});
  click(e, {750, 450}, MOD_PRIMARY | MOD_SHIFT);
  CHECK(e.selection() == Sel{OTHER});
  // Its title selects it with no modifier (baseline 10 px above its top-left).
  e.setSelection({});
  click(e, {10, -16});
  CHECK(e.selection() == Sel{TOPF});
  // A top-level frame with nothing in it: a click on it selects it.
  e.setSelection({});
  click(e, {1000, 100});
  CHECK(e.selection() == Sel{OTHER});
}

TEST_CASE("r14 deep select: auto layout — the gap and padding pick the row, a square picks the square") {
  Editor e = makeEditor();
  click(e, {510, 50}, MOD_PRIMARY);  // between S1 and S2
  CHECK(e.selection() == Sel{AL});
  click(e, {455, 50}, MOD_PRIMARY);  // left padding
  CHECK(e.selection() == Sel{AL});
  click(e, {540, 50}, MOD_PRIMARY);  // on S2
  CHECK(e.selection() == Sel{AL2});
  // A row with no fill isn't hit by its box (Figma's deep select skips unfilled layers): the gap is the top-level
  // frame's background, a square is still the square.
  click(e, {510, 150}, MOD_PRIMARY);
  CHECK(e.selection() == Sel{TOPF});
  click(e, {480, 150}, MOD_PRIMARY);
  CHECK(e.selection() == Sel{ALN1});
}

TEST_CASE("r14 deep select: hidden and locked layers are skipped") {
  Editor e = makeEditor();
  // A hidden frame and its layer: as if they weren't there.
  click(e, {480, 260}, MOD_PRIMARY);
  CHECK(e.selection() == Sel{TOPF});
  // A locked frame and what's in it take no click: the path stops at the unlocked parent.
  click(e, {630, 260}, MOD_PRIMARY);
  CHECK(e.selection() == Sel{TOPF});
  CHECK(hitPath(e.document(), kPage, {630, 260}, 1) == Sel{TOPF});
  CHECK(hitPath(e.document(), kPage, {480, 260}, 1) == Sel{TOPF});
}

TEST_CASE("r14 deep select: ⌘-double-click picks like ⌘-click (no vector edit on a frame)") {
  Editor e = makeEditor();
  click(e, {200, 150}, MOD_PRIMARY);
  click(e, {200, 150}, MOD_PRIMARY, 2);
  CHECK(e.selection() == Sel{C});
  click(e, {750, 450}, MOD_PRIMARY);
  click(e, {750, 450}, MOD_PRIMARY, 2);
  CHECK(e.selection() == Sel{TOPF});
  // A plain double-click goes one level down from the selection: A → B.
  e.setSelection({A});
  click(e, {300, 200}, 0, 1);
  click(e, {300, 200}, 0, 2);
  CHECK(e.selection() == Sel{B});
}

TEST_CASE("r14 deep select: ⌘-marquee takes the deepest layers it touches") {
  Editor e = makeEditor();
  // Over R: R (not the frames around it).
  drag(e, {-50, 90}, {95, 95}, MOD_PRIMARY);
  CHECK(e.selection() == Sel{R});
  // Only C's padding (nothing in C touched): C.
  drag(e, {-50, 160}, {200, 170}, MOD_PRIMARY);
  CHECK(e.selection() == Sel{C});
  // Over the auto-layout row's squares: the squares; only its gap: the row.
  drag(e, {460, -50}, {600, 40}, MOD_PRIMARY);
  CHECK(e.selection() == Sel{AL1, AL2, AL3});
  drag(e, {505, -50}, {515, 25}, MOD_PRIMARY);
  CHECK(e.selection() == Sel{AL});
  // Hidden and locked layers aren't taken.
  drag(e, {440, 210}, {720, 330}, MOD_PRIMARY);
  CHECK(e.selection().empty());
  // The pure function: the same rules.
  CHECK(marqueeDeepHits(e.document(), kPage, {505, 22, 10, 3}) == Sel{AL});
  CHECK(marqueeDeepHits(e.document(), kPage, {505, 122, 10, 3}).empty());  // the unfilled row's gap
}
