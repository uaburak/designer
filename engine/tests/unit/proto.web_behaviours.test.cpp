// Website behaviours in the player (docs/engine.md §3.4 "Website behaviours"; docs/research/prototype-web-behaviours.md
// §2 items 1–5, 10, 11): Tab order and the focus ring, Enter / Space, Esc, a modal's focus trap and focus return, arrow
// keys in auto-layout groups, the Focus variant and hover-while-focused, disabled instances, cursors, text inputs
// (typed text, placeholder, password, Number, Max length, carried across screens, written into a bound variable).
//
// The screen "Home":
//   Menu (vertical auto layout, 20,20): Item 1 (→ Next), Item 2 (→ the modal), Item 3 (→ the popover)
//   Toggle (200,300: Change to on its own set? no — a plain click that opens the popover), Link (400,300: → Next)
//   Disabled (20,400: Btn State=Disabled), Focusable (300,400: Btn State=Default — has a Focus variant),
//   Chip (550,400: State=Default, hover → Hover, no Focus variant), Off (20,450: Btn with its "Disabled" property on)
//   Help (600,20: Prototype › Cursor Help, holding a plain Icon), Drag (600,100: On drag → Next)
//   Field (20,500) holding the text input "Email"
// "Next": Field holding "Email" (same path: carries the text), Password (a Password field, Max length 4), Amount (Number).
#include <functional>
#include <string>

#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "proto/Player.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid HOME{60, 1}, MENU{60, 2}, R1{60, 3}, R2{60, 4}, R3{60, 5}, TOGGLE{60, 6}, LINK{60, 7}, DISABLED{60, 8}, FOCUSI{60, 9},
    CHIP{60, 10}, OFF{60, 11}, HELPF{60, 12}, ICON{60, 13}, DRAGR{60, 14}, FIELD{60, 15}, EMAIL{60, 16};
const Guid NEXT{61, 1}, FIELD2{61, 2}, EMAIL2{61, 3}, PWF{61, 4}, PW{61, 5}, AMF{61, 6}, AMOUNT{61, 7};
const Guid MODAL{62, 1}, ACTIONS{62, 2}, CANCEL{62, 3}, OK_{62, 4}, POPOVER{62, 5}, PA{62, 6}, PB{62, 7};
const Guid BSET{63, 1}, BDEF{63, 2}, BHOV{63, 3}, BFOC{63, 4}, BDIS{63, 5}, DISABLED_PROP{63, 9};
const Guid CSET{64, 1}, CDEF{64, 2}, CHOV{64, 3};

constexpr int kTab = 9, kEnter = 13, kEsc = 27, kSpace = 32, kEnd = 35, kHome = 36, kLeft = 37, kUp = 38, kRight = 39, kDown = 40;

std::string extra(const char* key, const std::string& text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  std::string bytes = codec::extraFromJson("NodeChange", key, v);
  REQUIRE(!bytes.empty());
  return bytes;
}

uint32_t nextId = 1;
std::string entry(const char* trigger, const std::string& action) {
  return std::string(R"({"id":{"sessionID":65,"localID":)") + std::to_string(nextId++) + R"(},"stateManagementVersion":1,"event":{"interactionType":")" +
         trigger + R"("},"actions":[)" + action + "]}";
}
std::string nav(const char* type, Guid dest) {
  return std::string(R"({"connectionType":"INTERNAL_NODE","navigationType":")") + type + R"(","transitionType":"INSTANT_TRANSITION","transitionNodeID":")" +
         dest.toString() + "\"}";
}
const char* kClose = R"({"connectionType":"CLOSE"})";
std::string ixs(std::initializer_list<std::string> entries) {
  std::string s = "[";
  for (const std::string& e : entries) s += (s.size() > 1 ? "," : "") + e;
  return s + "]";
}

struct Fixture {
  Editor ed;
  proto::Player player{ed};
  double t = 0;
  std::vector<NodeChange> nodes = baseChanges();

  NodeChange& add(Guid id, NodeType type, Guid parent, const std::string& pos, Rect r, const std::string& name, const std::string& ix = "") {
    NodeChange c = make(id, type, parent, pos, r, name);
    if (!ix.empty()) c.props.extra["prototypeInteractions"] = extra("prototypeInteractions", ix);
    nodes.push_back(c);
    return nodes.back();
  }
  NodeChange& instance(Guid id, Guid parent, const std::string& pos, Rect r, const std::string& name, Guid main) {
    NodeChange& c = add(id, NodeType::INSTANCE, parent, pos, r, name);
    c.props.comp().symbolData.symbolID = main;
    c.props.fillPaints.clear();
    return c;
  }
  NodeChange& text(Guid id, Guid parent, const std::string& pos, Rect r, const std::string& name, const std::string& chars, const char* input) {
    NodeChange& c = add(id, NodeType::TEXT, parent, pos, r, name);
    c.props.text().textData.characters = chars;
    c.props.text().fontSize = 16;
    if (input) c.props.extra["prototypeTextInput"] = extra("prototypeTextInput", input);
    return c;
  }

  Fixture() {
    // Components: Btn (Default / Hover / Focus / Disabled, a boolean property "Disabled"), Chip (Default / Hover).
    NodeChange& bs = add(BSET, NodeType::FRAME, kPage, "~", {0, 2000, 800, 100}, "Btn");
    bs.props.comp().isStateGroup = true;
    ComponentPropDef dis;
    dis.id = DISABLED_PROP;
    dis.name = "Disabled";
    dis.type = ComponentPropType::BOOL;
    dis.initialValue.hasBool = true;
    dis.initialValue.boolValue = false;
    bs.props.comp().componentPropDefs.push_back(dis);
    add(BDEF, NodeType::SYMBOL, BSET, "!", {0, 0, 100, 40}, "State=Default", ixs({entry("ON_HOVER", nav("SWAP_STATE", BHOV)), entry("ON_CLICK", nav("NAVIGATE", NEXT))}));
    add(BHOV, NodeType::SYMBOL, BSET, "\"", {150, 0, 100, 40}, "State=Hover", ixs({entry("ON_CLICK", nav("NAVIGATE", NEXT))}));
    add(BFOC, NodeType::SYMBOL, BSET, "#", {300, 0, 100, 40}, "State=Focus");
    add(BDIS, NodeType::SYMBOL, BSET, "$", {450, 0, 100, 40}, "State=Disabled", ixs({entry("ON_CLICK", nav("NAVIGATE", NEXT))}));
    NodeChange& cs = add(CSET, NodeType::FRAME, kPage, "~~", {0, 2200, 400, 100}, "Chip");
    cs.props.comp().isStateGroup = true;
    add(CDEF, NodeType::SYMBOL, CSET, "!", {0, 0, 100, 40}, "State=Default", ixs({entry("ON_HOVER", nav("SWAP_STATE", CHOV)), entry("ON_CLICK", nav("OVERLAY", POPOVER))}));
    // (Chip: a click hotspot, so focusable.)
    add(CHOV, NodeType::SYMBOL, CSET, "\"", {150, 0, 100, 40}, "State=Hover");

    // Home.
    add(HOME, NodeType::FRAME, kPage, "!", {0, 0, 800, 600}, "Home");
    NodeChange& menu = add(MENU, NodeType::FRAME, HOME, "!", {20, 20, 100, 90}, "Menu");
    menu.props.stack().stackMode = StackMode::VERTICAL;
    add(R1, NodeType::RECTANGLE, MENU, "!", {0, 0, 100, 30}, "Item 1", ixs({entry("ON_CLICK", nav("NAVIGATE", NEXT))}));
    add(R2, NodeType::RECTANGLE, MENU, "\"", {0, 30, 100, 30}, "Item 2", ixs({entry("ON_CLICK", nav("OVERLAY", MODAL))}));
    add(R3, NodeType::RECTANGLE, MENU, "#", {0, 60, 100, 30}, "Item 3", ixs({entry("ON_CLICK", nav("OVERLAY", POPOVER))}));
    // Free layers, in an order unlike reading order (Link before Toggle in the list).
    add(LINK, NodeType::RECTANGLE, HOME, "\"", {400, 300, 80, 30}, "Link", ixs({entry("ON_CLICK", nav("NAVIGATE", NEXT))}));
    add(TOGGLE, NodeType::RECTANGLE, HOME, "#", {200, 300, 80, 30}, "Toggle", ixs({entry("ON_CLICK", nav("OVERLAY", POPOVER))}));
    instance(DISABLED, HOME, "$", {20, 400, 100, 40}, "Disabled", BDIS);
    instance(FOCUSI, HOME, "%", {300, 400, 100, 40}, "Focusable", BDEF);
    instance(CHIP, HOME, "&", {550, 400, 100, 40}, "Chip", CDEF);
    NodeChange& off = instance(OFF, HOME, "'", {20, 450, 100, 40}, "Off", BDEF);
    ComponentPropAssignment on;
    on.defID = DISABLED_PROP;
    on.value.hasBool = true;
    on.value.boolValue = true;
    off.props.comp().componentPropAssignments.push_back(on);
    NodeChange& help = add(HELPF, NodeType::FRAME, HOME, "(", {600, 20, 100, 60}, "Help");
    help.props.extra["prototypeCursor"] = extra("prototypeCursor", "\"HELP\"");
    add(ICON, NodeType::RECTANGLE, HELPF, "!", {10, 10, 20, 20}, "Icon");
    add(DRAGR, NodeType::RECTANGLE, HOME, ")", {600, 100, 100, 60}, "Drag", ixs({entry("DRAG", nav("NAVIGATE", NEXT))}));
    add(FIELD, NodeType::FRAME, HOME, "*", {20, 500, 300, 40}, "Field");
    text(EMAIL, FIELD, "!", {10, 10, 200, 20}, "Email", "Email", R"({"type":"TEXT"})");

    // Next.
    add(NEXT, NodeType::FRAME, kPage, "\"", {1000, 0, 800, 600}, "Next");
    add(FIELD2, NodeType::FRAME, NEXT, "!", {20, 20, 300, 40}, "Field");
    text(EMAIL2, FIELD2, "!", {10, 10, 200, 20}, "Email", "Email", R"({"type":"TEXT"})");
    add(PWF, NodeType::FRAME, NEXT, "\"", {20, 100, 300, 40}, "PasswordField");
    text(PW, PWF, "!", {10, 10, 200, 20}, "Password", "Password", R"({"type":"PASSWORD","maxLength":4})");
    add(AMF, NodeType::FRAME, NEXT, "#", {20, 200, 300, 40}, "AmountField");
    text(AMOUNT, AMF, "!", {10, 10, 200, 20}, "Amount", "0", R"({"type":"NUMBER"})");

    // The modal (a background, not dismissible) and the popover (no background, closes on a click outside).
    NodeChange& modal = add(MODAL, NodeType::FRAME, kPage, "#", {2000, 0, 300, 200}, "Modal");
    modal.props.extra["overlayBackgroundAppearance"] =
        extra("overlayBackgroundAppearance", R"({"backgroundType":"SOLID_COLOR","backgroundColor":{"r":0,"g":0,"b":0,"a":0.4}})");
    NodeChange& actions = add(ACTIONS, NodeType::FRAME, MODAL, "!", {20, 140, 220, 40}, "Actions");
    actions.props.stack().stackMode = StackMode::HORIZONTAL;
    add(CANCEL, NodeType::RECTANGLE, ACTIONS, "!", {0, 0, 100, 40}, "Cancel", ixs({entry("ON_CLICK", kClose)}));
    add(OK_, NodeType::RECTANGLE, ACTIONS, "\"", {120, 0, 100, 40}, "OK", ixs({entry("ON_CLICK", kClose)}));
    NodeChange& pop = add(POPOVER, NodeType::FRAME, kPage, "$", {2400, 0, 120, 80}, "Popover");
    pop.props.extra["overlayBackgroundInteraction"] = extra("overlayBackgroundInteraction", "\"CLOSE_ON_CLICK_OUTSIDE\"");
    pop.props.extra["overlayPositionType"] = extra("overlayPositionType", "\"TOP_RIGHT\"");
    NodeChange& list = add(Guid{62, 8}, NodeType::FRAME, POPOVER, "!", {0, 0, 120, 80}, "List");
    list.props.stack().stackMode = StackMode::VERTICAL;
    add(PA, NodeType::RECTANGLE, Guid{62, 8}, "!", {0, 0, 120, 40}, "A", ixs({entry("ON_CLICK", kClose)}));
    add(PB, NodeType::RECTANGLE, Guid{62, 8}, "\"", {0, 40, 120, 40}, "B", ixs({entry("ON_CLICK", kClose)}));
  }
  void load() {
    ed.setSessionID(1);
    ed.setViewport(800, 600, 1, 800, 600);
    ed.loadDocument(nodes, kNoGuid);
    ed.takeEvents();
    player.setScale(proto::ScaleMode::ACTUAL);
    REQUIRE(player.start(kPage, HOME));
    advance(16);
  }
  void advance(double ms) {
    while (ms > 0) {
      double step = std::min(10.0, ms);
      t += step;
      ms -= step;
      player.tick(t);
    }
  }
  uint32_t key(int code, uint32_t mods = 0) {
    uint32_t r = player.key(true, code, mods);
    player.key(false, code, mods);
    advance(16);
    return r;
  }
  void click(Guid id) {
    Rect r = box(id);
    double x = r.x + r.w / 2, y = r.y + r.h / 2;
    player.pointer(PointerEvent::MOVE, x, y, 0, 0);
    player.pointer(PointerEvent::DOWN, x, y, 1, 0);
    player.pointer(PointerEvent::UP, x, y, 0, 0);
    advance(16);
  }
  void hover(Guid id) {
    Rect r = box(id);
    player.pointer(PointerEvent::MOVE, r.x + r.w / 2, r.y + r.h / 2, 0, 0);
  }
  // Where the layer is drawn (CSS px): Actual size puts the screen at the canvas's top-left.
  Rect box(Guid id) {
    player.scene();
    Rect screen = player.screenRect();
    Mat2x3 m = ed.document().worldTransform(id);
    Guid top = id;
    while (ed.document().parentOf(top) != kPage) top = ed.document().parentOf(top);
    Mat2x3 tm = ed.document().worldTransform(top);
    const NodeProps& p = ed.document().get(id)->props;
    return {screen.x + m.m02 - tm.m02, screen.y + m.m12 - tm.m12, p.size.x, p.size.y};
  }
  const std::string& chars(Guid id) { return ed.document().get(id)->props.text().textData.characters; }
  int rings() {
    int n = 0;
    for (auto& it : player.scene().items)
      if (it.kind == PresentItem::Kind::Rect && it.border == 2 && it.alpha == 0) n++;
    return n;
  }
};

}  // namespace

TEST_CASE("website behaviours: Tab goes through the focusable layers in order, keyboard focus shows a ring, a click's doesn't") {
  Fixture f;
  f.load();
  // Auto layout in its direction, free layers in reading order (Toggle before Link); the disabled ones left out.
  std::vector<Guid> order = f.player.focusOrder();
  std::string names;
  for (Guid g : order) names += f.ed.document().get(g)->props.name + " ";
  INFO(names);
  CHECK(order == std::vector<Guid>{R1, R2, R3, TOGGLE, LINK, FOCUSI, CHIP, EMAIL});
  CHECK(f.player.focused() == kNoGuid);
  CHECK(f.key(kTab) == 1);
  CHECK(f.player.focused() == R1);
  CHECK(f.player.focusVisible());
  CHECK(f.rings() == 1);
  CHECK(f.key(kTab) == 1);
  CHECK(f.player.focused() == R2);
  CHECK(f.key(kTab, MOD_SHIFT) == 1);
  CHECK(f.key(kTab, MOD_SHIFT) == 1);
  CHECK(f.player.focused() == EMAIL);  // wraps round
  CHECK(f.player.focusedField() == EMAIL);
  CHECK(f.key(kTab) == 1);
  CHECK(f.player.focused() == R1);
  // A click focuses without a ring (:focus-visible).
  f.click(TOGGLE);
  CHECK(f.player.focused() == TOGGLE);
  CHECK(!f.player.focusVisible());
  // (The popover it opened closes on a click outside.)
  f.click(Guid{60, 13});
  CHECK(f.player.overlays().empty());
  // Off: Tab is a key like any other (Figma's).
  f.player.setWebBehaviours(false);
  CHECK(f.player.focused() == kNoGuid);
  f.player.setShortcuts(false);
  CHECK(f.key(kTab) == 0);
  CHECK(f.player.focused() == kNoGuid);
  CHECK(f.player.focusOrder().empty());
}

TEST_CASE("website behaviours: Enter activates, Space activates buttons but not links") {
  Fixture f;
  f.load();
  f.player.setShortcuts(false);
  f.key(kTab);
  f.key(kTab);
  f.key(kTab);
  f.key(kTab);
  f.key(kTab);
  REQUIRE(f.player.focused() == LINK);
  CHECK(f.key(kSpace) == 0);  // a link takes Enter only
  CHECK(f.player.screen() == HOME);
  CHECK(f.key(kEnter) == 1);
  CHECK(f.player.screen() == NEXT);
  CHECK(f.player.focused() == kNoGuid);  // a new screen: nothing focused
  // Space on a button.
  f.player.restart();
  f.advance(16);
  f.key(kTab);
  f.key(kTab);
  f.key(kTab);
  f.key(kTab);
  REQUIRE(f.player.focused() == TOGGLE);
  CHECK(f.key(kSpace) == 1);
  CHECK(f.player.overlays().size() == 1);
}

TEST_CASE("website behaviours: the Focus variant while keyboard-focused, hover interactions on a focused instance without one") {
  Fixture f;
  f.load();
  for (int i = 0; i < 6; i++) f.key(kTab);
  REQUIRE(f.player.focused() == FOCUSI);
  CHECK(f.ed.mainOf(FOCUSI) == BFOC);
  CHECK(f.rings() == 0);  // the component draws its focus
  f.key(kTab);
  CHECK(f.player.focused() == CHIP);
  CHECK(f.ed.mainOf(FOCUSI) == BDEF);
  CHECK(f.ed.mainOf(CHIP) == CHOV);  // While hovering runs while focused (Figma's accessible mode)
  CHECK(f.rings() == 1);
  f.key(kTab);
  CHECK(f.ed.mainOf(CHIP) == CDEF);
  // Enter on the focused instance runs its Default state's click (the Focus variant has none).
  f.key(kTab, MOD_SHIFT);
  f.key(kTab, MOD_SHIFT);
  REQUIRE(f.player.focused() == FOCUSI);
  CHECK(f.key(kEnter) == 1);
  CHECK(f.player.screen() == NEXT);
}

TEST_CASE("website behaviours: disabled instances run nothing, aren't focusable, show not-allowed; cursors per hotspot") {
  Fixture f;
  f.load();
  CHECK(f.player.disabled(DISABLED));
  CHECK(f.player.disabled(OFF));  // the boolean property "Disabled" on
  CHECK(!f.player.disabled(FOCUSI));
  f.hover(DISABLED);
  CHECK(f.player.cursorNow() == proto::Cursor::NOT_ALLOWED);
  f.click(DISABLED);
  CHECK(f.player.screen() == HOME);
  f.click(OFF);
  CHECK(f.player.screen() == HOME);
  f.hover(R1);
  CHECK(f.player.cursorNow() == proto::Cursor::POINTER);
  f.hover(EMAIL);
  CHECK(f.player.cursorNow() == proto::Cursor::TEXT);
  f.hover(ICON);
  CHECK(f.player.cursorNow() == proto::Cursor::HELP);  // Prototype › Cursor, inherited
  f.hover(DRAGR);
  CHECK(f.player.cursorNow() == proto::Cursor::GRAB);
  f.hover(MENU);
  // Off: Figma's — a hand over hotspots, and a disabled instance plays its interactions.
  f.player.setWebBehaviours(false);
  f.hover(EMAIL);
  CHECK(f.player.cursorNow() == proto::Cursor::DEFAULT);
  f.hover(ICON);
  CHECK(f.player.cursorNow() == proto::Cursor::DEFAULT);
  f.click(DISABLED);
  CHECK(f.player.screen() == NEXT);
}

TEST_CASE("website behaviours: a modal traps the focus and gives it back; Esc closes only a dismissible overlay") {
  Fixture f;
  f.load();
  f.key(kTab);
  f.key(kTab);
  REQUIRE(f.player.focused() == R2);
  f.key(kEnter);
  REQUIRE(f.player.overlays().size() == 1);
  CHECK(f.player.focused() == CANCEL);  // the dialog takes the focus
  CHECK(f.player.focusVisible());
  CHECK(f.player.focusOrder() == std::vector<Guid>{CANCEL, OK_});
  f.key(kTab);
  CHECK(f.player.focused() == OK_);
  f.key(kTab);
  CHECK(f.player.focused() == CANCEL);  // trapped
  f.key(kRight);
  CHECK(f.player.focused() == OK_);  // arrows along the horizontal Actions row
  f.player.setShortcuts(false);
  CHECK(f.key(kEsc) == 0);  // not dismissible
  CHECK(f.player.overlays().size() == 1);
  f.key(kEnter);
  CHECK(f.player.overlays().empty());
  CHECK(f.player.focused() == R2);  // back to its opener
  CHECK(f.player.focusVisible());
  // The popover (no background, closes on a click outside): opened by a key, it takes the focus; Esc closes it.
  f.key(kTab);
  REQUIRE(f.player.focused() == R3);
  f.key(kEnter);
  REQUIRE(f.player.overlays().size() == 1);
  CHECK(f.player.focused() == PA);
  CHECK(f.key(kEsc) == 1);
  CHECK(f.player.overlays().empty());
  CHECK(f.player.focused() == R3);
}

TEST_CASE("website behaviours: arrow keys, Home and End in an auto-layout group; ↓ from a menu's opener goes into it") {
  Fixture f;
  f.load();
  f.player.setShortcuts(false);
  f.key(kTab);
  REQUIRE(f.player.focused() == R1);
  f.key(kDown);
  CHECK(f.player.focused() == R2);
  f.key(kDown);
  f.key(kDown);
  CHECK(f.player.focused() == R1);  // wraps
  f.key(kEnd);
  CHECK(f.player.focused() == R3);
  f.key(kHome);
  CHECK(f.player.focused() == R1);
  f.key(kUp);
  CHECK(f.player.focused() == R3);
  CHECK(f.key(kRight) == 0);  // not along a vertical menu
  CHECK(f.key(kLeft) == 0);
  // A mouse opens the popover: focus stays on its opener; ↓ goes into it.
  f.click(R3);
  REQUIRE(f.player.overlays().size() == 1);
  CHECK(f.player.focused() == R3);
  f.key(kDown);
  CHECK(f.player.focused() == PA);
  f.key(kDown);
  CHECK(f.player.focused() == PB);
}

TEST_CASE("website behaviours: text inputs take typing — placeholder, carried by path, password, Max length, Number, Esc") {
  Fixture f;
  f.load();
  f.click(EMAIL);
  REQUIRE(f.player.focusedField() == EMAIL);
  CHECK(f.player.fieldValue().empty());
  f.player.textInput("me@x.io", 7, 7);
  CHECK(f.chars(EMAIL) == "me@x.io");
  CHECK(f.player.fieldStart() == 7);
  // Empty: the layer's own text, the placeholder.
  f.player.textInput("", 0, 0);
  CHECK(f.chars(EMAIL) == "Email");
  f.player.textInput("abc", 3, 3);
  f.player.setShortcuts(false);
  CHECK(f.key(kEnter) == 1);  // one line: Enter is no character
  CHECK(f.chars(EMAIL) == "abc");
  CHECK(f.key(kEsc) == 1);
  CHECK(f.player.focusedField() == kNoGuid);
  // The same field on the next screen shows it (semantic path, like component states).
  f.click(R1);
  REQUIRE(f.player.screen() == NEXT);
  CHECK(f.chars(EMAIL2) == "abc");
  // Password: bullets, cut at its Max length.
  f.click(PW);
  REQUIRE(f.player.focusedField() == PW);
  f.player.textInput("secret", 6, 6);
  CHECK(f.player.fieldValue() == "secr");
  CHECK(f.chars(PW) == "••••");
  // Number: digits and signs only.
  f.click(AMOUNT);
  f.player.textInput("12ab3", 5, 5);
  CHECK(f.player.fieldValue() == "123");
  CHECK(f.chars(AMOUNT) == "123");
  // Restart: everything as designed.
  f.player.restart();
  f.advance(16);
  CHECK(f.chars(EMAIL) == "Email");
  CHECK(f.chars(EMAIL2) == "Email");
  CHECK(f.chars(PW) == "Password");
  f.player.stop();
  CHECK(f.chars(AMOUNT) == "0");
}

TEST_CASE("website behaviours: a text input bound to a string variable writes it (two-way binding)") {
  Fixture f;
  // An "Echo" text on Home shows the same variable.
  f.text(Guid{60, 30}, HOME, "+", {400, 500, 200, 20}, "Echo", "", nullptr);
  f.load();
  auto run = [&](CommandId id, const std::string& json) {
    CommandArgs a;
    REQUIRE(json::parse(json, a.raw));
    return f.ed.command(id, a);
  };
  REQUIRE(run(CommandId::CREATE_VARIABLE_COLLECTION, R"({"name":"Form"})") == OK);
  Guid set = f.ed.lastCreated()[0];
  REQUIRE(run(CommandId::CREATE_VARIABLE, "{\"collection\":\"" + set.toString() + "\",\"type\":\"STRING\",\"name\":\"email\",\"value\":\"\"}") == OK);
  Guid var = f.ed.lastCreated()[0];
  for (Guid t : {EMAIL, Guid{60, 30}})
    REQUIRE(run(CommandId::BIND_VARIABLE, "{\"refs\":[\"" + t.toString() + "\"],\"target\":\"TEXT_DATA\",\"variable\":\"" + var.toString() + "\"}") == OK);
  REQUIRE(f.player.start(kPage, HOME));
  f.advance(16);
  f.click(EMAIL);
  REQUIRE(f.player.focusedField() == EMAIL);
  f.player.textInput("hi", 2, 2);
  f.advance(16);
  CHECK(f.chars(Guid{60, 30}) == "hi");
  CHECK(f.chars(EMAIL) == "hi");
  f.player.restart();
  f.advance(16);
  CHECK(f.chars(Guid{60, 30}).empty());
}
