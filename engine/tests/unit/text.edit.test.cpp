// Text editing in the engine: the Text tool, typing, caret motion, deleting,
// mouse selection, IME, one undo step per session, empty texts deleted, run
// styles on a range, auto-resize in and out of auto layout.
#include <cmath>

#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"
#include "TextHelpers.h"
#include "text/TextEdit.h"
#include "text/Unicode.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid F{1, 1}, T{1, 2};

Editor makeEditor(std::vector<NodeChange> extra = {}) {
  loadInter();
  auto nodes = baseChanges();
  nodes.push_back(make(F, NodeType::FRAME, kPage, "!", {300, 0, 200, 200}, "Frame 1"));
  for (auto& n : extra) nodes.push_back(n);
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 2, 1600, 1200);
  e.loadDocument(nodes, kNoGuid);
  e.takeEvents();
  return e;
}

NodeChange textNode(Guid id, Guid parent, const std::string& chars, Rect r, TextAutoResize resize = TextAutoResize::WIDTH_AND_HEIGHT) {
  NodeChange c = make(id, NodeType::TEXT, parent, "#", r, chars);
  c.props.text().textData.characters = chars;
  c.props.text().textAutoResize = resize;
  loadInter();
  if (resize == TextAutoResize::WIDTH_AND_HEIGHT) c.props.size = text::layoutText(c.props, {})->size;  // as a saved file has it
  return c;
}

void down(Editor& e, double x, double y, uint32_t mods = 0, int clicks = 1) { e.pointer(PointerEvent::DOWN, x, y, 0, 1, mods, clicks); }
void move(Editor& e, double x, double y) { e.pointer(PointerEvent::MOVE, x, y, 0, 1, 0); }
void up(Editor& e, double x, double y, uint32_t mods = 0) { e.pointer(PointerEvent::UP, x, y, 0, 0, mods); }
void click(Editor& e, double x, double y, uint32_t mods = 0, int clicks = 1) {
  down(e, x, y, mods, clicks);
  up(e, x, y, mods);
}
void key(Editor& e, KeyCode k, uint32_t mods = 0) { e.key(KeyEvent::DOWN, k, 0, mods, false); }

const NodeProps& props(Editor& e, Guid id) { return e.document().get(id)->props; }

Guid onlySelected(Editor& e) {
  REQUIRE(e.selection().size() == 1);
  return e.selection()[0];
}

}  // namespace

TEST_CASE("text tool: a click makes auto-width Inter Regular 12 text, typing fills it, Esc keeps it, one undo step") {
  Editor e = makeEditor();
  REQUIRE(e.setTool(Tool::TEXT) == OK);
  click(e, 40, 50);
  REQUIRE(e.textEditing());
  CHECK(e.tool() == Tool::MOVE);
  Guid t = onlySelected(e);
  const NodeProps& p = props(e, t);
  CHECK(p.type == NodeType::TEXT);
  CHECK(p.text().fontName.family == "Inter");
  CHECK(p.text().fontName.style == "Regular");
  CHECK(p.text().fontSize == 12);
  CHECK(p.text().textAutoResize == TextAutoResize::WIDTH_AND_HEIGHT);
  CHECK(p.fillPaints.size() == 1);
  size_t steps = e.undoStack().undoCount();
  e.takeEvents();

  e.textInput("Hello");
  e.textInput(" world");
  CHECK(props(e, t).text().textData.characters == "Hello world");
  CHECK(props(e, t).name == "Hello world");  // autoRename
  CHECK(props(e, t).size.y == 15);
  CHECK(props(e, t).size.x > 50);
  CHECK(e.undoStack().undoCount() == steps);  // merged into "Create text"
  auto ev = e.takeEvents();
  CHECK(ev.textEdit);
  CHECK_FALSE(ev.documents.empty());  // every edit reaches storage at once

  key(e, KeyCode::Escape);
  CHECK_FALSE(e.textEditing());
  CHECK(onlySelected(e) == t);
  CHECK(e.command(CommandId::UNDO) == OK);
  CHECK_FALSE(e.document().has(t));  // the whole session (created + typed) is one step
  e.command(CommandId::REDO);
  CHECK(props(e, t).text().textData.characters == "Hello world");
}

TEST_CASE("text tool: leaving an empty new text deletes it and leaves no undo step") {
  Editor e = makeEditor();
  size_t before = e.undoStack().undoCount();
  e.setTool(Tool::TEXT);
  click(e, 40, 50);
  Guid t = onlySelected(e);
  REQUIRE(e.document().has(t));
  key(e, KeyCode::Escape);
  CHECK_FALSE(e.document().has(t));
  CHECK(e.undoStack().undoCount() == before);
  CHECK(e.selection().empty());
}

TEST_CASE("text tool: a drag makes a box of that width (auto height) inside the frame under it") {
  Editor e = makeEditor();
  e.setTool(Tool::TEXT);
  down(e, 320, 20);
  move(e, 360, 40);
  move(e, 420, 60);
  up(e, 420, 60);
  REQUIRE(e.textEditing());
  Guid t = onlySelected(e);
  CHECK(props(e, t).text().textAutoResize == TextAutoResize::HEIGHT);
  CHECK(props(e, t).size.x == 100);
  CHECK(e.document().parentOf(t) == F);
  e.textInput("one two three four five six seven");
  CHECK(props(e, t).size.x == 100);
  CHECK(props(e, t).size.y > 15);  // wrapped onto more lines
}

TEST_CASE("text editing: caret motion, word and line jumps, deleting") {
  Editor e = makeEditor({textNode(T, kPage, "hello big world", {10, 10, 0, 0})});
  REQUIRE(e.startTextEdit(T, false) == OK);
  CHECK(e.textSelStart() == 15);
  key(e, KeyCode::ArrowLeft, MOD_ALT);
  CHECK(e.textSelStart() == 10);
  key(e, KeyCode::ArrowLeft, MOD_ALT);
  CHECK(e.textSelStart() == 6);
  key(e, KeyCode::ArrowRight);
  CHECK(e.textSelStart() == 7);
  key(e, KeyCode::ArrowRight, MOD_SHIFT | MOD_ALT);
  CHECK(e.textSelStart() == 7);
  CHECK(e.textSelEnd() == 9);
  key(e, KeyCode::Backspace);
  CHECK(props(e, T).text().textData.characters == "hello b world");
  key(e, KeyCode::ArrowLeft, MOD_PRIMARY);
  CHECK(e.textSelStart() == 0);
  key(e, KeyCode::ArrowRight, MOD_PRIMARY);
  CHECK(e.textSelStart() == 13);
  key(e, KeyCode::Backspace, MOD_ALT);
  CHECK(props(e, T).text().textData.characters == "hello b ");
  key(e, KeyCode::KeyA, MOD_PRIMARY);
  CHECK(e.textSelStart() == 0);
  CHECK(e.textSelEnd() == 8);
  CHECK(e.textSelection() == "hello b ");
  e.textInput("new");
  CHECK(props(e, T).text().textData.characters == "new");
  key(e, KeyCode::Enter);
  e.textInput("line");
  CHECK(props(e, T).text().textData.characters == "new\nline");
  key(e, KeyCode::ArrowUp);
  CHECK(e.textSelStart() == 3);  // straight up, at most the line's end
  key(e, KeyCode::ArrowDown, MOD_PRIMARY);
  CHECK(e.textSelStart() == 8);
  key(e, KeyCode::Delete);  // at the end: nothing
  CHECK(props(e, T).text().textData.characters == "new\nline");
  // A whole editing session is one undo step back to where it began.
  key(e, KeyCode::Escape);
  e.command(CommandId::UNDO);
  CHECK(props(e, T).text().textData.characters == "hello big world");
}

TEST_CASE("text editing: Enter on a selected text edits it with all selected; double-click selects a word") {
  Editor e = makeEditor({textNode(T, kPage, "alpha beta gamma", {10, 10, 0, 0})});
  e.setSelection({T});
  key(e, KeyCode::Enter);
  REQUIRE(e.textEditing());
  CHECK(e.textSelStart() == 0);
  CHECK(e.textSelEnd() == 16);
  key(e, KeyCode::Escape);
  CHECK_FALSE(e.textEditing());
  // Double-click on "beta": its screen x is inside the text (camera at identity).
  const text::TextLayout* L = e.textLayout(T);
  REQUIRE(L);
  double x = 10 + (L->caretXs[6] + L->caretXs[10]) / 2;
  click(e, x, 17);
  click(e, x, 17, 0, 2);
  REQUIRE(e.textEditing());
  CHECK(e.textSelStart() == 6);
  CHECK(e.textSelEnd() == 10);
  // Drag-select from "alpha" to "gamma".
  double x0 = 10 + L->caretXs[1], x1 = 10 + L->caretXs[13];
  down(e, x0, 17);
  move(e, x1, 17);
  up(e, x1, 17);
  CHECK(e.textSelStart() == 1);
  CHECK(e.textSelEnd() == 13);
  // A click outside the text ends the editing.
  click(e, 700, 500);
  CHECK_FALSE(e.textEditing());
}

TEST_CASE("text editing: IME composition, then its commit") {
  Editor e = makeEditor({textNode(T, kPage, "ab", {10, 10, 0, 0})});
  e.startTextEdit(T, false);
  e.textComposition("k", 1, 1);
  CHECK(props(e, T).text().textData.characters == "abk");
  e.textComposition("\xE3\x81\x8B", 1, 1);  // か
  CHECK(props(e, T).text().textData.characters == "ab\xE3\x81\x8B");
  e.textCompositionEnd("\xE6\xBC\xA2");  // 漢
  CHECK(props(e, T).text().textData.characters == "ab\xE6\xBC\xA2");
  CHECK(e.textSelStart() == 3);
}

TEST_CASE("text editing: a style on the selected range goes to styleOverrideTable; on the whole layer to the node") {
  Editor e = makeEditor({textNode(T, kPage, "Hello world", {10, 10, 0, 0})});
  e.startTextEdit(T, false);
  key(e, KeyCode::ArrowLeft, MOD_ALT | MOD_SHIFT);  // "world"
  NodeChange c = NodeChange::changed(T);
  c.mask = F_FONT_SIZE;
  c.props.text().fontSize = 24;
  REQUIRE(e.setProps({T}, c, 0) == OK);
  const TextData& t = props(e, T).text().textData;
  REQUIRE(t.styleOverrideTable.size() == 1);
  CHECK(t.styleOverrideTable[0].fontSize == 24);
  CHECK(t.characterStyleIDs.size() == 11);
  CHECK(t.characterStyleIDs[5] == 0);
  CHECK(t.characterStyleIDs[6] != 0);
  CHECK(props(e, T).text().fontSize == 12);
  CHECK(props(e, T).size.y == 29);  // auto height follows the big run
  // Typing after it continues its style.
  key(e, KeyCode::ArrowRight);
  e.textInput("!");
  CHECK(props(e, T).text().textData.characterStyleIDs.back() != 0);
  key(e, KeyCode::Escape);
  // The whole layer: the node's own size, the runs' sizes go.
  c.props.text().fontSize = 16;
  e.setProps({T}, c, 0);
  CHECK(props(e, T).text().fontSize == 16);
  CHECK(props(e, T).text().textData.styleOverrideTable.empty());
  CHECK(props(e, T).text().textData.characterStyleIDs.empty());
  CHECK(props(e, T).size.y == 19);
  // ⌘U underlines the selection.
  e.startTextEdit(T, true);
  key(e, KeyCode::KeyU, MOD_PRIMARY);
  CHECK(props(e, T).text().textDecoration == TextDecoration::UNDERLINE);
}

TEST_CASE("text: auto width grows from its alignment's side; Fill in auto layout wraps it") {
  NodeChange centred = textNode(T, kPage, "Hi", {100, 10, 0, 0});
  centred.props.text().textAlignHorizontal = TextAlignHorizontal::CENTER;
  Editor e = makeEditor({centred});
  e.startTextEdit(T, false);
  double before = props(e, T).size.x, x0 = props(e, T).transform.m02;
  e.textInput(" there");
  double grow = props(e, T).size.x - before;
  CHECK(grow > 10);
  CHECK(props(e, T).transform.m02 == doctest::Approx(x0 - grow / 2));
  key(e, KeyCode::Escape);

  // A vertical auto-layout frame with a text stretched across it: the text wraps at the frame's width.
  NodeChange frame = make({1, 10}, NodeType::FRAME, kPage, "%", {0, 300, 120, 100}, "Auto");
  frame.props.stack().stackMode = StackMode::VERTICAL;
  frame.props.stack().stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  frame.props.stack().stackPaddingLeft = frame.props.stack().stackPaddingRight = 10;
  NodeChange child = textNode({1, 11}, {1, 10}, "short", {10, 0, 30, 15}, TextAutoResize::HEIGHT);
  child.props.stackChildAlignSelf = StackCounterAlign::STRETCH;
  Editor a = makeEditor({frame, child});
  a.startTextEdit({1, 11}, true);
  a.textInput("a much longer sentence that has to wrap");
  CHECK(props(a, {1, 11}).size.x == doctest::Approx(100));
  CHECK(props(a, {1, 11}).size.y > 15);
  CHECK(props(a, {1, 10}).size.y == doctest::Approx(props(a, {1, 11}).size.y));  // the frame hugs it
}

TEST_CASE("text: TextData edits keep characterStyleIDs and lines in step") {
  TextData t;
  t.characters = "ab\ncd";
  t.lines = {"{\"lineType\":\"PLAIN\"}", "{\"lineType\":\"ORDERED_LIST\"}"};
  t.characterStyleIDs = {0, 0, 0, 2, 2};
  TextStyle s;
  s.styleID = 2;
  s.mask = R_FONT_SIZE;
  s.fontSize = 20;
  t.styleOverrideTable = {s};
  text::replaceRange(t, 1, 1, u"X\nY", 0);
  CHECK(t.characters == "aX\nYb\ncd");
  CHECK(t.lines.size() == 3);
  CHECK(t.characterStyleIDs == std::vector<uint32_t>{0, 0, 0, 0, 0, 0, 2, 2});
  text::replaceRange(t, 0, 8, u"", 0);
  CHECK(t.characters.empty());
  CHECK(t.lines.size() == 1);
  CHECK(t.characterStyleIDs.empty());
  CHECK(t.styleOverrideTable.empty());
  CHECK(text::layerNameFor("a\nb") == "a b");
}

TEST_CASE("nodes the engine doesn't model keep their type and fields through duplicate, paste and undo") {
  NodeChange v = make({1, 20}, NodeType::VECTOR, kPage, "&", {0, 0, 10, 10}, "Vector");
  v.props.extra["vectorData"] = "{\"vectorNetworkBlob\":3}";
  v.props.extra["blendMode"] = "\"MULTIPLY\"";
  Editor e = makeEditor({v});
  e.setSelection({{1, 20}});
  e.command(CommandId::DUPLICATE);
  Guid copy = onlySelected(e);
  CHECK(copy != Guid{1, 20});
  CHECK(props(e, copy).type == NodeType::VECTOR);
  CHECK(props(e, copy).extra.at("vectorData") == "{\"vectorNetworkBlob\":3}");
  e.command(CommandId::DELETE);
  e.command(CommandId::UNDO);
  CHECK(props(e, copy).type == NodeType::VECTOR);
  CHECK(props(e, copy).extra.size() == 2);
  // A change to one unmodelled field merges into the rest.
  NodeChange c = NodeChange::changed(copy);
  c.mask = F_EXTRA;
  c.props.extra["blendMode"] = "\"SCREEN\"";
  e.applyChanges({c}, APPLY_USER);
  CHECK(props(e, copy).extra.at("blendMode") == "\"SCREEN\"");
  CHECK(props(e, copy).extra.count("vectorData") == 1);
  e.command(CommandId::UNDO);
  CHECK(props(e, copy).extra.at("blendMode") == "\"MULTIPLY\"");
}

TEST_CASE("layout: a min/max limit alone relayouts; a stale auto-layout frame relayouts on load") {
  NodeChange frame = make({1, 30}, NodeType::FRAME, kPage, "'", {0, 0, 999, 999}, "Stale");
  frame.props.stack().stackMode = StackMode::HORIZONTAL;
  frame.props.stack().stackCounterSizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  NodeChange kid = make({1, 31}, NodeType::ROUNDED_RECTANGLE, {1, 30}, "!", {500, 500, 40, 20}, "Kid");
  Editor e = makeEditor({frame, kid});
  CHECK(props(e, {1, 30}).size.x == doctest::Approx(40));  // hugs, relaid on load
  CHECK(props(e, {1, 31}).transform.m02 == doctest::Approx(0));
  NodeChange c = NodeChange::changed({1, 30});
  c.mask = F_MAX_SIZE;
  c.props.rare().maxSize = {30, 0};
  e.setProps({{1, 30}}, c, 0);
  CHECK(props(e, {1, 30}).size.x == doctest::Approx(30));
}

TEST_CASE("layout: Align text baseline lines up texts of different sizes in a horizontal flow") {
  NodeChange frame = make({1, 40}, NodeType::FRAME, kPage, "(", {0, 400, 10, 10}, "Row");
  frame.props.stack().stackMode = StackMode::HORIZONTAL;
  frame.props.stack().stackCounterSizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  frame.props.stack().stackCounterAlignItems = StackAlign::BASELINE;
  NodeChange big = textNode({1, 41}, {1, 40}, "Big", {0, 0, 0, 0});
  big.props.text().fontSize = 32;
  big.props.size = text::layoutText(big.props, {})->size;
  NodeChange small = textNode({1, 42}, {1, 40}, "small", {0, 0, 0, 0});
  small.props.parentIndex.position = "$";
  Editor e = makeEditor({frame, big, small});
  auto baselineY = [&](Guid id) { return props(e, id).transform.m12 + e.textLayout(id)->lines[0].baseline; };
  CHECK(baselineY({1, 41}) == doctest::Approx(baselineY({1, 42})));
  CHECK(props(e, {1, 42}).transform.m12 > 5);
}

TEST_CASE("text: a typed width makes auto width auto height; a typed height makes a fixed box") {
  Editor e = makeEditor({textNode(T, kPage, "resize me please", {10, 10, 0, 0})});
  NodeChange c = NodeChange::changed(T);
  c.mask = F_SIZE;
  c.props.size = {40, props(e, T).size.y};
  e.setProps({T}, c, 0);
  CHECK(props(e, T).text().textAutoResize == TextAutoResize::HEIGHT);
  CHECK(props(e, T).size.x == 40);
  CHECK(props(e, T).size.y > 15);  // wrapped
  c.props.size = {40, 100};
  e.setProps({T}, c, 0);
  CHECK(props(e, T).text().textAutoResize == TextAutoResize::NONE);
  CHECK(props(e, T).size.y == 100);
}
