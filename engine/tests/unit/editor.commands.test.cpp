// The editor's structural commands (docs/engine.md §10.6): group, frame
// selection, ungroup, duplicate, flip, align, distribute, auto layout, pages,
// the Layers panel's moveNodes, and copy / paste.
#include <cmath>

#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid F{1, 1}, R1{1, 2}, R2{1, 3}, R3{1, 5}, TOP{1, 4};

Editor makeEditor() {
  auto nodes = baseChanges();
  nodes.push_back(make(F, NodeType::FRAME, kPage, "!", {0, 0, 300, 300}, "Frame 1"));
  nodes.push_back(make(R1, NodeType::ROUNDED_RECTANGLE, F, "!", {10, 10, 50, 50}, "Rectangle 1"));
  nodes.push_back(make(R2, NodeType::ROUNDED_RECTANGLE, F, "\"", {100, 20, 50, 50}, "Rectangle 2"));
  nodes.push_back(make(R3, NodeType::ROUNDED_RECTANGLE, F, "#", {200, 40, 30, 30}, "Rectangle 3"));
  nodes.push_back(make(TOP, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {400, 0, 100, 100}, "Rectangle 4"));
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 2, 1600, 1200);
  e.loadDocument(nodes, kNoGuid);
  e.takeEvents();
  return e;
}

const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }
Rect world(const Editor& e, Guid id) { return e.document().worldBounds(id); }

}  // namespace

TEST_CASE("commands: group wraps at the topmost layer's place, keeps every layer where it was, undoes") {
  Editor e = makeEditor();
  e.setSelection({R2, R1});
  Rect r1 = world(e, R1), r2 = world(e, R2);
  REQUIRE(e.command(CommandId::GROUP) == OK);
  REQUIRE(e.selection().size() == 1);
  Guid g = e.selection()[0];
  const NodeProps& gp = props(e, g);
  CHECK(gp.isGroupLike());
  CHECK(gp.fillPaints.empty());
  CHECK(gp.name == "Group 1");
  CHECK(e.document().parentOf(g) == F);
  CHECK(gp.transform == Mat2x3::translate(10, 10));
  CHECK(gp.size == Vec2{140, 60});
  CHECK(e.document().children(g) == std::vector<Guid>{R1, R2});
  CHECK(world(e, R1) == r1);
  CHECK(world(e, R2) == r2);
  // At R2's place: below R3.
  CHECK(e.document().children(F) == std::vector<Guid>{g, R3});
  auto ev = e.takeEvents();
  REQUIRE(ev.documents.size() == 1);
  CHECK(ev.documents[0].label == "Group selection");
  e.command(CommandId::UNDO);
  CHECK(!e.document().has(g));
  CHECK(e.document().children(F) == std::vector<Guid>{R1, R2, R3});
  CHECK(world(e, R1) == r1);
}

TEST_CASE("commands: frame selection is a white frame without clipping; ungroup takes it apart") {
  Editor e = makeEditor();
  e.setSelection({R1, R2});
  e.command(CommandId::FRAME_SELECTION);
  Guid f = e.selection()[0];
  CHECK(props(e, f).type == NodeType::FRAME);
  CHECK(!props(e, f).resizeToFit);
  CHECK(props(e, f).frameMaskDisabled);
  REQUIRE(props(e, f).fillPaints.size() == 1);
  CHECK(props(e, f).fillPaints[0].color == Color::hex(0xFFFFFF));
  CHECK(e.commandState(CommandId::UNGROUP) == CMD_ENABLED);
  e.command(CommandId::UNGROUP);
  CHECK(!e.document().has(f));
  CHECK(e.selection() == std::vector<Guid>{R1, R2});
  CHECK(e.document().children(F) == std::vector<Guid>{R1, R2, R3});
  CHECK(props(e, R1).transform == Mat2x3::translate(10, 10));
  CHECK(props(e, R2).transform == Mat2x3::translate(100, 20));
  // A layer selected alone that isn't a container: nothing to ungroup.
  e.setSelection({R1});
  CHECK(e.commandState(CommandId::UNGROUP) == 0);
}

TEST_CASE("commands: grouping layers from different parents puts the group at the topmost one's place") {
  Editor e = makeEditor();
  e.setSelection({R1, TOP});
  Rect r1 = world(e, R1), top = world(e, TOP);
  e.command(CommandId::GROUP);
  Guid g = e.selection()[0];
  CHECK(e.document().parentOf(g) == kPage);
  CHECK(world(e, R1) == r1);
  CHECK(world(e, TOP) == top);
  CHECK(world(e, g) == Rect{10, 0, 490, 100});
}

TEST_CASE("commands: duplicate in place above the original; top-level frames go to the right") {
  Editor e = makeEditor();
  e.setSelection({R1});
  e.command(CommandId::DUPLICATE);
  Guid copy = e.selection()[0];
  CHECK(copy != R1);
  CHECK(props(e, copy).name == "Rectangle 1");
  CHECK(props(e, copy).transform == props(e, R1).transform);
  CHECK(e.document().children(F) == std::vector<Guid>{R1, copy, R2, R3});

  e.setSelection({F});
  e.command(CommandId::DUPLICATE);
  Guid frame = e.selection()[0];
  // TOP sits at x 400–500: the copy skips past it.
  CHECK(world(e, frame).x == 800);
  CHECK(e.document().children(frame).size() == 4);
  for (Guid c : e.document().children(frame)) CHECK(c.sessionID == 1);
  CHECK(e.document().children(frame) != e.document().children(F));
}

TEST_CASE("commands: flip mirrors about the selection box and keeps it in place") {
  Editor e = makeEditor();
  e.setSelection({R1});
  Rect before = world(e, R1);
  e.command(CommandId::FLIP_HORIZONTAL);
  CHECK(props(e, R1).transform.m00 == -1);
  CHECK(world(e, R1) == before);
  e.command(CommandId::FLIP_HORIZONTAL);
  CHECK(props(e, R1).transform == Mat2x3::translate(10, 10));
  e.setSelection({R1, R2});
  e.command(CommandId::FLIP_VERTICAL);
  // The pair's box is y 10–70: R1 (10–60) goes to 20–70.
  CHECK(world(e, R1) == Rect{10, 20, 50, 50});
  CHECK(world(e, R2) == Rect{100, 10, 50, 50});
}

TEST_CASE("commands: align and distribute") {
  Editor e = makeEditor();
  e.setSelection({R1, R2, R3});
  e.command(CommandId::ALIGN_TOP);
  CHECK(world(e, R1).y == 10);
  CHECK(world(e, R2).y == 10);
  CHECK(world(e, R3).y == 10);
  e.command(CommandId::ALIGN_BOTTOM);
  CHECK(world(e, R3).bottom() == 60);
  e.command(CommandId::ALIGN_RIGHT);
  CHECK(world(e, R1).right() == 230);
  CHECK(world(e, R2).right() == 230);
  e.command(CommandId::UNDO);
  e.command(CommandId::ALIGN_HORIZONTAL_CENTER);
  CHECK(world(e, R1).x + 25 == 120);
  e.command(CommandId::UNDO);
  // Distribute: R1 10–60, R2 100–150, R3 200–230 → gaps (220 − 130) / 2 = 45.
  CHECK(e.commandState(CommandId::DISTRIBUTE_HORIZONTAL) == CMD_ENABLED);
  e.command(CommandId::DISTRIBUTE_HORIZONTAL);
  CHECK(world(e, R1).x == 10);
  CHECK(world(e, R2).x == 105);
  CHECK(world(e, R3).x == 200);
  // One layer aligns within its frame; on the page it can't.
  e.setSelection({R1});
  e.command(CommandId::ALIGN_RIGHT);
  CHECK(world(e, R1).right() == 300);
  e.setSelection({TOP});
  CHECK(e.commandState(CommandId::ALIGN_LEFT) == 0);
  CHECK(e.commandState(CommandId::DISTRIBUTE_VERTICAL) == 0);
}

TEST_CASE("commands: add auto layout to a frame infers direction, gap, padding; remove keeps the places") {
  auto nodes = baseChanges();
  const Guid A{1, 10}, B{1, 11}, C{1, 12}, G{1, 13};
  nodes.push_back(make(G, NodeType::FRAME, kPage, "!", {0, 0, 200, 300}, "Frame 1"));
  // Stacked vertically, 10 apart, starting 20 in.
  nodes.push_back(make(A, NodeType::ROUNDED_RECTANGLE, G, "#", {20, 20, 100, 30}));
  nodes.push_back(make(B, NodeType::ROUNDED_RECTANGLE, G, "!", {20, 60, 100, 30}));
  nodes.push_back(make(C, NodeType::ROUNDED_RECTANGLE, G, "\"", {20, 100, 100, 30}));
  Editor e;
  e.loadDocument(nodes, kNoGuid);
  e.setSelection({G});
  e.command(CommandId::ADD_AUTO_LAYOUT);
  const NodeProps& p = props(e, G);
  CHECK(p.stack().stackMode == StackMode::VERTICAL);
  CHECK(p.stack().stackSpacing == 10);
  CHECK(p.stack().stackPaddingLeft == 20);
  CHECK(p.stack().stackPaddingTop == 20);
  CHECK(p.stack().stackPaddingRight == 80);
  CHECK(p.stack().stackPaddingBottom == 170);
  // The flow follows where they sat: A, B, C top to bottom.
  CHECK(e.document().children(G) == std::vector<Guid>{A, B, C});
  CHECK(world(e, A).y == 20);
  CHECK(world(e, B).y == 60);
  CHECK(world(e, C).y == 100);
  CHECK(p.size == Vec2{200, 300});
  CHECK(e.commandState(CommandId::REMOVE_AUTO_LAYOUT) == CMD_ENABLED);
  e.command(CommandId::REMOVE_AUTO_LAYOUT);
  CHECK(props(e, G).stack().stackMode == StackMode::NONE);
  CHECK(world(e, C).y == 100);
  CHECK(e.commandState(CommandId::REMOVE_AUTO_LAYOUT) == 0);
}

TEST_CASE("commands: add auto layout wraps several layers in a hugging auto-layout frame") {
  Editor e = makeEditor();
  e.setSelection({R1, R2, R3});
  e.command(CommandId::ADD_AUTO_LAYOUT);
  Guid w = e.selection()[0];
  const NodeProps& p = props(e, w);
  CHECK(p.isAutoLayout());
  CHECK(p.stack().stackMode == StackMode::HORIZONTAL);
  CHECK(p.fillPaints.empty());
  // Gaps 40 and 50: 45.
  CHECK(p.stack().stackSpacing == 45);
  CHECK(p.hugsPrimary());
  CHECK(p.hugsCounter());
  CHECK(p.size == Vec2{50 + 45 + 50 + 45 + 30, 50});
  CHECK(e.document().parentOf(w) == F);
  auto ev = e.takeEvents();
  REQUIRE(ev.documents.size() == 1);
  CHECK(ev.documents[0].label == "Add auto layout");
  e.command(CommandId::UNDO);
  CHECK(!e.document().has(w));
  CHECK(props(e, R2).transform == Mat2x3::translate(100, 20));
}

TEST_CASE("commands: pages — create, duplicate, delete (never the last)") {
  Editor e = makeEditor();
  CHECK(e.command(CommandId::DELETE_PAGE) == E_INVALID);
  CHECK(e.commandState(CommandId::DELETE_PAGE) == 0);
  REQUIRE(e.command(CommandId::CREATE_PAGE) == OK);
  auto all = e.pages();
  REQUIRE(all.size() == 2);
  CHECK(e.page() == all[1]);
  CHECK(props(e, all[1]).name == "Page 2");
  CHECK(props(e, all[1]).type == NodeType::CANVAS);
  e.setCurrentPage(kPage);
  CommandArgs args;
  args.page = kPage;
  REQUIRE(e.command(CommandId::DUPLICATE_PAGE, args) == OK);
  all = e.pages();
  REQUIRE(all.size() == 3);
  CHECK(all[0] == kPage);
  Guid copy = all[1];
  CHECK(e.page() == copy);
  CHECK(props(e, copy).name == "Page 1 copy");
  CHECK(e.document().children(copy).size() == 2);  // the frame and the rectangle
  Guid copiedFrame = e.document().children(copy)[0];
  CHECK(e.document().children(copiedFrame).size() == 3);
  // Delete the page in view: the next one shows.
  REQUIRE(e.command(CommandId::DELETE_PAGE) == OK);
  CHECK(!e.document().has(copy));
  CHECK(!e.document().has(copiedFrame));
  CHECK(e.pages().size() == 2);
  CHECK(e.page() == e.pages()[1]);
  args.page = {9, 9};
  CHECK(e.command(CommandId::DELETE_PAGE, args) == E_NOT_FOUND);
  e.command(CommandId::UNDO);
  CHECK(e.pages().size() == 3);
}

TEST_CASE("commands: moveNodes reorders, reparents keeping the page position, refuses cycles, moves pages") {
  Editor e = makeEditor();
  // R3 to the bottom of F.
  CHECK(e.moveNodes({R3}, F, 0) == 1);
  CHECK(e.document().children(F) == std::vector<Guid>{R3, R1, R2});
  // TOP into F, between R1 and R2 (index counted without it).
  Rect top = world(e, TOP);
  CHECK(e.moveNodes({TOP}, F, 2) == 1);
  CHECK(e.document().children(F) == std::vector<Guid>{R3, R1, TOP, R2});
  CHECK(world(e, TOP) == top);
  // Two layers keep their relative order.
  CHECK(e.moveNodes({R2, R3}, kPage, 1) == 2);
  CHECK(e.document().children(kPage) == std::vector<Guid>{F, R3, R2});
  // Into itself, or a page under a frame: refused.
  CHECK(e.moveNodes({F}, F, 0) == 0);
  CHECK(e.moveNodes({kPage}, F, 0) == 0);
  CHECK(e.moveNodes({R1}, {0, 0}, 0) == 0);
  // Pages reorder under the document.
  e.command(CommandId::CREATE_PAGE);
  Guid second = e.pages()[1];
  CHECK(e.moveNodes({second}, {0, 0}, 0) == 1);
  CHECK(e.pages() == std::vector<Guid>{second, kPage});
  e.command(CommandId::UNDO);
  CHECK(e.pages() == std::vector<Guid>{kPage, second});
}

TEST_CASE("commands: copy and paste — fresh ids, beside the original, in place, into a frame, in view") {
  Editor e = makeEditor();
  e.setSelection({R1, R2});
  Clipboard clip;
  REQUIRE(e.copySelection(clip));
  CHECK(clip.nodes.size() == 2);
  REQUIRE(clip.regions.size() == 1);
  CHECK(clip.regions[0].parent == F);
  CHECK(clip.page == kPage);

  // With the originals selected: beside them, where they were.
  CHECK(e.paste(clip, false) == 2);
  auto pasted = e.selection();
  REQUIRE(pasted.size() == 2);
  for (Guid id : pasted) CHECK(e.document().parentOf(id) == F);
  CHECK(world(e, pasted[0]) == world(e, R1));
  CHECK(world(e, pasted[1]) == world(e, R2));
  CHECK(e.document().children(F) == std::vector<Guid>{R1, R2, pasted[0], pasted[1], R3});

  // Into a selected frame elsewhere: where it sat in its own frame.
  const Guid G{1, 30};
  NodeChange frame = make(G, NodeType::FRAME, kPage, "#", {1000, 1000, 400, 400}, "Frame 2");
  e.applyChanges({frame}, APPLY_USER);
  e.setSelection({G});
  CHECK(e.paste(clip, false) == 2);
  CHECK(e.document().parentOf(e.selection()[0]) == G);
  CHECK(world(e, e.selection()[0]) == Rect{1010, 1010, 50, 50});

  // A frame too small: centred in it.
  NodeChange small = make({1, 31}, NodeType::FRAME, kPage, "$", {2000, 0, 100, 100}, "Frame 3");
  e.applyChanges({small}, APPLY_USER);
  e.setSelection({{1, 31}});
  e.paste(clip, false);
  CHECK(world(e, e.selection()[0]).x == 2000 + std::round(50 - 140 / 2.0));

  // Nothing selected and the original out of view: the middle of the view.
  e.setCamera({-5000, -5000, 1});
  e.setSelection({});
  e.paste(clip, false);
  Rect u = world(e, e.selection()[0]).united(world(e, e.selection()[1]));
  CHECK(e.document().parentOf(e.selection()[0]) == kPage);
  CHECK(u.x == 5400 - 70);
  CHECK(u.y == 5300 - 30);
  // In place: exactly where it was.
  e.setSelection({});
  e.paste(clip, true);
  CHECK(world(e, e.selection()[0]) == world(e, R1));
  auto ev = e.takeEvents();
  CHECK(ev.documents.back().label == "Paste");
}

TEST_CASE("commands: a group keeps a nested frame's children and a pasted subtree") {
  Editor e = makeEditor();
  e.setSelection({F});
  Clipboard clip;
  REQUIRE(e.copySelection(clip));
  CHECK(clip.nodes.size() == 4);
  e.setSelection({});
  e.paste(clip, true);
  Guid copy = e.selection()[0];
  CHECK(e.document().children(copy).size() == 3);
  CHECK(props(e, e.document().children(copy)[1]).name == "Rectangle 2");
}
