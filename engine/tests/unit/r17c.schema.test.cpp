// Round 17 batch C, the schema round (docs/schema.md §15.2): Figma's override entries keyed by (guidPath,
// overrideLevel 321), the nested swap's override stash (248), gradients blended in their interpolation space (Paint 41
// / 42), and the undo history exported and imported (Message 22 / 23).
#include <cmath>
#include <array>
#include <functional>
#include <tuple>

#include "doctest.h"
#include "Helpers.h"
#include "base/DerivedIds.h"
#include "editor/Editor.h"
#include "scene/CodecJson.h"
#include "render/GradientRamp.h"
#include "scene/CodecKiwi.h"
#include "scene/Extras.h"
#include "schema/SchemaTable.h"
#include "base/Json.h"
#include "motion/Model.h"

using namespace eng;
using namespace eng::test;

namespace {

// A main "Button" (1:1) with a background (1:2), and its instance (1:10) on the page.
const Guid M{1, 1}, BG{1, 2}, I{1, 10};

std::vector<NodeChange> buttonDoc(const std::vector<SymbolOverride>& overrides) {
  auto nodes = baseChanges();
  NodeChange m = make(M, NodeType::SYMBOL, kPage, "!", {0, 0, 100, 40}, "Button");
  m.props.fillPaints.clear();
  nodes.push_back(m);
  nodes.push_back(make(BG, NodeType::ROUNDED_RECTANGLE, M, "!", {0, 0, 100, 40}, "Background"));
  NodeChange i = make(I, NodeType::INSTANCE, kPage, "\"", {0, 100, 100, 40}, "Button");
  i.props.fillPaints.clear();
  i.props.comp().symbolData.symbolID = M;
  i.props.comp().symbolData.overrides = overrides;
  nodes.push_back(i);
  return nodes;
}

Editor load(const std::vector<NodeChange>& nodes) {
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kNoGuid);
  e.takeEvents();
  return e;
}

SymbolOverride opacityAt(std::vector<Guid> path, double opacity, int32_t level) {
  SymbolOverride o;
  o.path = std::move(path);
  o.mask = F_OPACITY;
  o.props.opacity = opacity;
  o.level = level;
  return o;
}

const std::vector<SymbolOverride>& overridesOf(const Editor& e, Guid id) { return e.document().get(id)->props.comp().symbolData.overrides; }

}  // namespace

TEST_CASE("r17c overrideLevel: entries at one path with different levels stay apart, level 0 wins") {
  // Figma's file order: the deeper level first.
  Editor e = load(buttonDoc({opacityAt({BG}, 0.5, 1), opacityAt({BG}, 0.25, 0)}));
  CHECK(overridesOf(e, I).size() == 2);
  CHECK(e.document().get(derived::intern(I, {BG}))->props.opacity == doctest::Approx(0.25));
  // Only a level-1 entry: it applies.
  Editor only = load(buttonDoc({opacityAt({BG}, 0.5, 1)}));
  CHECK(only.document().get(derived::intern(I, {BG}))->props.opacity == doctest::Approx(0.5));
}

TEST_CASE("r17c overrideLevel: kept by the kiwi and JSON codecs (field 321 on the entry)") {
  NodeChange inst = buttonDoc({opacityAt({BG}, 0.5, 1), opacityAt({BG}, 0.25, 0)}).back();
  std::string bytes = codec::writeMessage(0, {inst});
  codec::KiwiMessage back;
  REQUIRE(codec::readMessage(bytes, back));
  REQUIRE(back.changes.size() == 1);
  const auto& ov = back.changes[0].props.comp().symbolData.overrides;
  REQUIRE(ov.size() == 2);
  CHECK(ov[0].level == 1);
  CHECK(ov[0].props.opacity == doctest::Approx(0.5));
  CHECK(ov[1].level == 0);
  CHECK(ov[0].props.extra.empty());  // the level is not left in `extra`
  CHECK(codec::writeMessage(0, back.changes) == bytes);

  json::Writer w;
  codec::writeChanges(w, {inst});
  CHECK(w.str().find("\"overrideLevel\":1") != std::string::npos);
  json::Value v;
  REQUIRE(json::parse(w.str(), v));
  std::vector<NodeChange> fromJson = codec::readChanges(v);
  REQUIRE(fromJson.size() == 1);
  const auto& jv = fromJson[0].props.comp().symbolData.overrides;
  REQUIRE(jv.size() == 2);
  CHECK(jv[0].level == 1);
  CHECK(jv[1].level == 0);
}

TEST_CASE("r17c overrideLevel: an edit here writes the level-0 entry and leaves the deeper one as it came") {
  Editor e = load(buttonDoc({opacityAt({BG}, 0.5, 1)}));
  NodeChange c = NodeChange::changed(Guid{0, 0});
  c.mask = F_OPACITY;
  c.props.opacity = 0.75;
  REQUIRE(e.setProps({derived::intern(I, {BG})}, c, 0) == OK);
  const auto& ov = overridesOf(e, I);
  REQUIRE(ov.size() == 2);
  CHECK(ov[0].level == 1);
  CHECK(ov[0].props.opacity == doctest::Approx(0.5));
  CHECK(ov[1].level == 0);
  CHECK(ov[1].props.opacity == doctest::Approx(0.75));
  CHECK(e.document().get(derived::intern(I, {BG}))->props.opacity == doctest::Approx(0.75));
}

// ---- overrideStash 248: nested swaps (components.md task 10) ------------------------------------------------------

namespace {

// X (5:1) with "Shape" (5:2) and "Only in X" (5:3); Y (6:1) with "Shape" (6:2); a card (7:1) holding an instance of X
// (7:2); the card's instance (8:1) on the page.
const Guid X{5, 1}, XR{5, 2}, XQ{5, 3}, Y{6, 1}, YR{6, 2}, CARD{7, 1}, N{7, 2}, CI{8, 1};

Editor swapDoc() {
  auto nodes = baseChanges();
  nodes.push_back(make(X, NodeType::SYMBOL, kPage, "!", {0, 0, 100, 40}, "X"));
  nodes.push_back(make(XR, NodeType::ROUNDED_RECTANGLE, X, "!", {0, 0, 50, 40}, "Shape"));
  nodes.push_back(make(XQ, NodeType::ROUNDED_RECTANGLE, X, "\"", {50, 0, 50, 40}, "Only in X"));
  nodes.push_back(make(Y, NodeType::SYMBOL, kPage, "\"", {200, 0, 100, 40}, "Y"));
  nodes.push_back(make(YR, NodeType::ROUNDED_RECTANGLE, Y, "!", {0, 0, 100, 40}, "Shape"));
  nodes.push_back(make(CARD, NodeType::SYMBOL, kPage, "#", {400, 0, 100, 40}, "Card"));
  NodeChange n = make(N, NodeType::INSTANCE, CARD, "!", {0, 0, 100, 40}, "X");
  n.props.comp().symbolData.symbolID = X;
  nodes.push_back(n);
  NodeChange ci = make(CI, NodeType::INSTANCE, kPage, "$", {0, 200, 100, 40}, "Card");
  ci.props.comp().symbolData.symbolID = CARD;
  nodes.push_back(ci);
  return load(nodes);
}

void setOpacity(Editor& e, Guid ref, double v) {
  NodeChange c = NodeChange::changed(Guid{0, 0});
  c.mask = F_OPACITY;
  c.props.opacity = v;
  REQUIRE(e.setProps({ref}, c, 0) == OK);
}

Status swapTo(Editor& e, Guid ref, Guid main) {
  e.setSelection({ref});
  CommandArgs a;
  json::parse("{\"main\":\"" + main.toString() + "\"}", a.raw);
  return e.command(CommandId::SWAP_INSTANCE, a);
}

const SymbolOverride* entryAt(const Editor& e, const std::vector<Guid>& path) {
  for (const SymbolOverride& o : overridesOf(e, CI))
    if (o.path == path && o.level == 0) return &o;
  return nullptr;
}

std::vector<OverrideStash> stashOf(const Editor& e) {
  std::vector<OverrideStash> out;
  const auto& extra = e.document().get(CI)->props.extra;
  auto it = extra.find("overrideStash");
  if (it != extra.end()) REQUIRE(codec::readOverrideStash(it->second, out));
  return out;
}

}  // namespace

TEST_CASE("r17c overrideStash: a nested swap rewrites the stored paths and stashes what doesn't carry; a swap back restores it") {
  Editor e = swapDoc();
  const Guid nested = derived::intern(CI, {N});
  setOpacity(e, derived::intern(CI, {N, XR}), 0.3);
  setOpacity(e, derived::intern(CI, {N, XQ}), 0.6);

  REQUIRE(swapTo(e, nested, Y) == OK);
  // "Shape" carried by name: stored under Y's layer now, not under X's.
  REQUIRE(entryAt(e, {N, YR}));
  CHECK(entryAt(e, {N, YR})->props.opacity == doctest::Approx(0.3));
  CHECK(!entryAt(e, {N, XR}));
  CHECK(!entryAt(e, {N, XQ}));
  CHECK(e.document().get(derived::intern(CI, {N, YR}))->props.opacity == doctest::Approx(0.3));
  // "Only in X" has nowhere to go: stashed under (the nested instance's path, X's key).
  std::vector<OverrideStash> stash = stashOf(e);
  REQUIRE(stash.size() == 1);
  CHECK(stash[0].path == std::vector<Guid>{N});
  CHECK(stash[0].componentKey == X.toString());
  REQUIRE(stash[0].overrides.size() == 1);
  CHECK(stash[0].overrides[0].path == std::vector<Guid>{XQ});
  CHECK(stash[0].overrides[0].props.opacity == doctest::Approx(0.6));

  // Back to X: both overrides where they were, the stash spent.
  REQUIRE(swapTo(e, nested, X) == OK);
  REQUIRE(entryAt(e, {N, XR}));
  CHECK(entryAt(e, {N, XR})->props.opacity == doctest::Approx(0.3));
  REQUIRE(entryAt(e, {N, XQ}));
  CHECK(entryAt(e, {N, XQ})->props.opacity == doctest::Approx(0.6));
  CHECK(!entryAt(e, {N, YR}));
  CHECK(stashOf(e).empty());
  CHECK(e.document().get(derived::intern(CI, {N, XQ}))->props.opacity == doctest::Approx(0.6));

  // Each swap is one undo step.
  e.command(CommandId::UNDO);
  CHECK(stashOf(e).size() == 1);
  CHECK(entryAt(e, {N, YR}));
}

TEST_CASE("r17c overrideStash: kept by the kiwi codec as Figma's InstanceOverrideStash") {
  std::vector<OverrideStash> stash(1);
  stash[0].path = {N};
  stash[0].componentKey = "0123456789abcdef0123456789abcdef01234567";
  stash[0].overrides.push_back(opacityAt({XQ}, 0.6, 0));
  stash[0].overrides.push_back(opacityAt({XR}, 0.2, 2));
  std::string field = codec::writeOverrideStash(stash);
  std::vector<OverrideStash> back;
  REQUIRE(codec::readOverrideStash(field, back));
  REQUIRE(back.size() == 1);
  CHECK(back[0].path == stash[0].path);
  CHECK(back[0].componentKey == stash[0].componentKey);
  REQUIRE(back[0].overrides.size() == 2);
  CHECK(back[0].overrides[1].level == 2);
  CHECK(back[0].overrides[1].props.opacity == doctest::Approx(0.2));
  CHECK(codec::writeOverrideStash(back) == field);
  CHECK(codec::writeOverrideStash({}).empty());

  // On an instance, through a whole Message.
  NodeChange inst = NodeChange::created(CI, {});
  inst.props.type = NodeType::INSTANCE;
  inst.mask |= F_TYPE | F_EXTRA;
  inst.props.extra["overrideStash"] = field;
  codec::KiwiMessage m;
  REQUIRE(codec::readMessage(codec::writeMessage(0, {inst}), m));
  REQUIRE(m.changes.size() == 1);
  CHECK(m.changes[0].props.extra["overrideStash"] == field);
}

// ---- Gradient interpolation: Paint 41 / 42 (effects.md §2.22) ----------------------------------------------------

namespace {

ColorStop stop(double pos, uint32_t hex) {
  ColorStop s;
  s.position = pos;
  s.color = Color::hex(hex);
  return s;
}

// The middle texel of a white → black (or `a` → `b`) ramp, t = 127.5 / 255 between texels 127 and 128: their mean.
std::array<double, 4> middle(uint32_t a, uint32_t b, InterpolationColorSpace space, InterpolationHueMethod hue = InterpolationHueMethod::SHORTER) {
  std::vector<uint8_t> row;
  bakeGradientRamp({stop(0, a), stop(1, b)}, space, hue, 256, row);
  REQUIRE(row.size() == 256 * 4);
  std::array<double, 4> m{};
  for (int j = 0; j < 4; j++) m[j] = (row[127 * 4 + j] + row[128 * 4 + j]) / 2.0;
  return m;
}

}  // namespace

TEST_CASE("r17c gradient interpolation: the ramp blended in OKLab, OKLCH, HSL and linear sRGB as CSS Color 4 does") {
  using S = InterpolationColorSpace;
  using H = InterpolationHueMethod;
  // White → black: the document's space gives 50 % grey; OKLab's middle is oklab(0.5 0 0) = #636363 (CSS
  // color-mix(in oklab, white, black)); linear sRGB's is 0.5 linear = #bcbcbc.
  CHECK(middle(0xFFFFFF, 0x000000, S::OKLAB)[0] == doctest::Approx(99).epsilon(0.02));
  CHECK(middle(0xFFFFFF, 0x000000, S::OKLCH)[0] == doctest::Approx(99).epsilon(0.02));
  CHECK(middle(0xFFFFFF, 0x000000, S::SRGB_LINEAR)[0] == doctest::Approx(188).epsilon(0.02));
  // Red → blue in HSL: hue 0 → 240 the shorter way passes 300 (magenta), increasing passes 120 (green).
  auto shorter = middle(0xFF0000, 0x0000FF, S::HSL, H::SHORTER);
  CHECK(shorter[0] > 250);
  CHECK(shorter[1] < 5);
  CHECK(shorter[2] > 250);
  auto increasing = middle(0xFF0000, 0x0000FF, S::HSL, H::INCREASING);
  CHECK(increasing[0] < 5);
  CHECK(increasing[1] > 250);
  CHECK(increasing[2] < 5);
  // A grey stop has no hue: it takes the other stop's (red → white in OKLCH keeps red's hue — the straight OKLab
  // line, no detour round the hue circle).
  auto toWhite = middle(0xFF0000, 0xFFFFFF, S::OKLCH), straight = middle(0xFF0000, 0xFFFFFF, S::OKLAB);
  for (int j = 0; j < 4; j++) CHECK(toWhite[j] == doctest::Approx(straight[j]).epsilon(0.01));
}

TEST_CASE("r17c gradient interpolation: OKLCH's midpoint is CSS Color 4's (red / blue as the spec gives them)") {
  // CSS Color 4: red = oklch(62.8 % 0.2577 29.23), blue = oklch(45.2 % 0.3132 264.05). Red → blue the shorter way:
  // L and C halfway, hue 29.23 + 360 → 264.05, i.e. 326.64.
  const double red[3] = {1, 0, 0}, blue[3] = {0, 0, 1};
  double lr[3], lb[3];
  srgbToOklab(red, lr);
  srgbToOklab(blue, lb);
  CHECK(lr[0] == doctest::Approx(0.628).epsilon(0.002));
  CHECK(std::hypot(lr[1], lr[2]) == doctest::Approx(0.2577).epsilon(0.002));
  CHECK(lb[0] == doctest::Approx(0.452).epsilon(0.002));
  RampColor mid = interpolateColor(Color::hex(0xFF0000), Color::hex(0x0000FF), 0.5, InterpolationColorSpace::OKLCH, InterpolationHueMethod::SHORTER);
  const double rgb[3] = {mid.r, mid.g, mid.b};
  double lab[3];
  srgbToOklab(rgb, lab);
  CHECK(lab[0] == doctest::Approx((0.62796 + 0.45201) / 2).epsilon(0.002));
  CHECK(std::hypot(lab[1], lab[2]) == doctest::Approx((0.25768 + 0.31321) / 2).epsilon(0.002));
  double h = std::atan2(lab[2], lab[1]) * 180 / M_PI;
  if (h < 0) h += 360;
  CHECK(h == doctest::Approx(326.64).epsilon(0.002));
  CHECK(mid.a == doctest::Approx(1));
  // Alpha is premultiplied into L and C: half-transparent red → opaque blue weighs blue's lightness more.
  Color clearRed = Color::hex(0xFF0000);
  clearRed.a = 0;
  RampColor fade = interpolateColor(clearRed, Color::hex(0x0000FF), 0.5, InterpolationColorSpace::OKLAB, InterpolationHueMethod::SHORTER);
  CHECK(fade.a == doctest::Approx(0.5));
  CHECK(fade.b == doctest::Approx(1).epsilon(0.01));
  CHECK(fade.r == doctest::Approx(0).epsilon(0.01));
}

TEST_CASE("r17c gradient interpolation: Paint 41 / 42 read from a paint's kept fields") {
  Paint p;
  p.type = PaintType::GRADIENT_LINEAR;
  schema::Out o;
  o.varuint(41);
  o.varuint(2);  // OKLCH
  o.varuint(42);
  o.varuint(1);  // LONGER
  p.extra = o.s;
  CHECK(paintExtras(p).interpolationColorSpace == InterpolationColorSpace::OKLCH);
  CHECK(paintExtras(p).interpolationHueMethod == InterpolationHueMethod::LONGER);
  Paint plain;
  CHECK(paintExtras(plain).interpolationColorSpace == InterpolationColorSpace::DEFAULT);
}

// ---- Undo history: Message.localUndoStack 22 / localRedoStack 23 (canvas.md §2.18) ---------------------------------

TEST_CASE("r17c undo history: exported and imported into a fresh editor of the same document, it undoes and redoes the same") {
  const Guid R1{9, 1}, R2{9, 2};
  auto nodes = baseChanges();
  nodes.push_back(make(R1, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 10, 10}, "A"));
  nodes.push_back(make(R2, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {20, 0, 10, 10}, "B"));
  Editor a = load(nodes);
  auto edit = [](Editor& e, Guid id, double opacity, const std::string& name) {
    NodeChange c = NodeChange::changed(Guid{0, 0});
    c.mask = F_OPACITY | F_NAME;
    c.props.opacity = opacity;
    c.props.name = name;
    REQUIRE(e.setProps({id}, c, 0) == OK);
  };
  edit(a, R1, 0.5, "A1");
  edit(a, R2, 0.25, "B1");
  edit(a, R1, 0.75, "A2");
  REQUIRE(a.command(CommandId::UNDO) == OK);  // one step on the redo stack
  std::string history = a.exportUndoHistory();
  REQUIRE(!history.empty());

  // The same document in a fresh editor (as a reopened file), then the history.
  Editor b = load(a.encodeDocument());
  CHECK_FALSE(b.canUndo());
  REQUIRE(b.importUndoHistory(history));
  CHECK(b.undoStack().undoCount() == 2);
  CHECK(b.undoStack().redoCount() == 1);
  auto state = [&](const Editor& e) {
    const NodeProps& p1 = e.document().get(R1)->props;
    const NodeProps& p2 = e.document().get(R2)->props;
    return std::make_tuple(p1.opacity, p1.name, p2.opacity, p2.name);
  };
  CHECK(state(b) == state(a));
  REQUIRE(a.command(CommandId::REDO) == OK);
  REQUIRE(b.command(CommandId::REDO) == OK);
  CHECK(state(b) == state(a));
  CHECK(std::get<1>(state(b)) == "A2");
  for (int i = 0; i < 3; i++) {
    REQUIRE(a.command(CommandId::UNDO) == OK);
    REQUIRE(b.command(CommandId::UNDO) == OK);
    CHECK(state(b) == state(a));
  }
  CHECK(std::get<1>(state(b)) == "A");
  CHECK(std::get<0>(state(b)) == doctest::Approx(1));

  // Caps: the last step only; bad bytes leave the history as it was.
  Editor c = load(a.encodeDocument());
  REQUIRE(c.importUndoHistory(a.exportUndoHistory(1)));
  CHECK(c.undoStack().undoCount() == 0);
  CHECK(c.undoStack().redoCount() == 1);
  CHECK_FALSE(c.importUndoHistory(std::string("\x16\x05", 2)));
  CHECK(c.undoStack().redoCount() == 1);
}

TEST_CASE("w6 undo history: each step keeps the pages it was on (Message.undoBatchPageIds 46), through export and import") {
  const Guid P2{9, 50}, R1{9, 1}, R2{9, 2};
  auto nodes = baseChanges();
  NodeProps page2 = defaultProps(NodeType::CANVAS);
  page2.name = "Page 2";
  page2.parentIndex = {kDoc, "\""};
  nodes.push_back(NodeChange::created(P2, page2));
  nodes.push_back(make(R1, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 10, 10}, "A"));
  nodes.push_back(make(R2, NodeType::ROUNDED_RECTANGLE, P2, "!", {0, 0, 10, 10}, "B"));
  Editor a = load(nodes);
  auto rename = [](Editor& e, Guid id, const std::string& name) {
    NodeChange c = NodeChange::changed(Guid{0, 0});
    c.mask = F_NAME;
    c.props.name = name;
    REQUIRE(e.setProps({id}, c, 0) == OK);
  };
  rename(a, R2, "B1");  // on Page 2
  rename(a, R1, "A1");  // on Page 1
  REQUIRE(a.undoStack().undoBatches().size() == 2);
  CHECK(a.undoStack().undoBatches()[0].pageIds == std::vector<Guid>{P2});
  CHECK(a.undoStack().undoBatches()[1].pageIds == std::vector<Guid>{kPage});
  // A removal notes its parent's page; a page's own change none.
  a.setSelection({R2});
  REQUIRE(a.command(CommandId::DELETE) == OK);
  CHECK(a.undoStack().undoBatches().back().pageIds == std::vector<Guid>{P2});

  // Through export / import (a reopened file), and an undo with nothing selected goes to the batch's page.
  Editor b = load(a.encodeDocument());
  REQUIRE(b.importUndoHistory(a.exportUndoHistory()));
  REQUIRE(b.undoStack().undoBatches().size() == 3);
  CHECK(b.undoStack().undoBatches()[0].pageIds == std::vector<Guid>{P2});
  CHECK(b.undoStack().undoBatches()[1].pageIds == std::vector<Guid>{kPage});
  REQUIRE(b.setCurrentPage(kPage) == OK);
  REQUIRE(b.command(CommandId::UNDO) == OK);  // the deletion, back on Page 2
  CHECK(b.page() == P2);
  REQUIRE(b.command(CommandId::UNDO) == OK);  // A1 on Page 1
  CHECK(b.page() == kPage);
  // The redo side keeps them too.
  CHECK(b.undoStack().redoBatches().back().pageIds == std::vector<Guid>{kPage});
  // A history written before them still loads (its pages then come from the replayed changes).
  NodeChange back = NodeChange::changed(R1);
  back.mask = F_NAME;
  back.props.name = "A";
  Editor c = load(a.encodeDocument());
  REQUIRE(c.importUndoHistory(codec::writeUndoHistory(1, {codec::UndoHistoryStep{{back}, {}}}, {})));
  CHECK(c.undoStack().undoBatches().back().pageIds.empty());
  REQUIRE(c.command(CommandId::UNDO) == OK);
  CHECK(c.document().get(R1)->props.name == "A");
}

// ---- editScopeInfo 365: kept through load and save (canvas.md §2.9) -------------------------------------------------

TEST_CASE("r17c editScopeInfo: a node's edit scopes survive load, an edit and the snapshot") {
  // EditScopeInfo {editScopeStacks [{stack [{type PLUGIN, label "Rename"}]}]}, as NodeChange field 365's bytes.
  schema::Out o;
  o.varuint(365);
  o.varuint(1);  // editScopeStacks
  o.varuint(1);
  o.varuint(1);  // EditScopeStack.stack
  o.varuint(1);
  o.varuint(1);  // EditScope.type
  o.varuint(3);  // PLUGIN
  o.varuint(2);  // EditScope.label
  o.raw(std::string("Rename", 7));  // kiwi strings end with a zero byte
  o.byte(0);     // EditScope
  o.byte(0);     // EditScopeStack
  o.byte(0);     // EditScopeInfo
  const Guid R{9, 5};
  auto nodes = baseChanges();
  NodeChange r = make(R, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 10, 10}, "R");
  r.props.extra["editScopeInfo"] = o.s;
  nodes.push_back(r);
  Editor e = load(nodes);
  NodeChange c = NodeChange::changed(Guid{0, 0});
  c.mask = F_OPACITY;
  c.props.opacity = 0.5;
  REQUIRE(e.setProps({R}, c, 0) == OK);
  codec::KiwiMessage m;
  REQUIRE(codec::readMessage(codec::writeMessage(0, e.encodeDocument()), m));
  const NodeChange* back = nullptr;
  for (const NodeChange& n : m.changes)
    if (n.guid == R) back = &n;
  REQUIRE(back);
  CHECK(back->props.extra.at("editScopeInfo") == o.s);
  CHECK(back->props.opacity == doctest::Approx(0.5));
}

// ---- Motion fields from Figma's current embedded schema (motion.md §2.6) ---------------------------------------------

namespace {

json::Value parsedJson(const std::string& text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  return v;
}

const char* kClipJson =
    R"([{"id":"1:7","mediaHash":"0123456789abcdef0123456789abcdef01234567","timelineOffsetUs":0,"startTimeUs":0,"durationUs":4000000,)"
    R"("volume":0.5,"mute":false,"displayName":"Beat.mp3","loopEnabled":false,"playbackDurationUs":4000000,"trackId":"1:8","loopPhaseOffsetUs":0,)"
    R"("sourceDurationUs":9000000,"bpm":120,"beatOffsetUs":40000,"timeSignatureNumerator":3,"timeSignatureDenominator":4,"beatConfidence":0.5,)"
    R"("volumeVar":{"dataType":"FLOAT","resolvedDataType":"FLOAT","value":{"floatValue":0.5}},)"
    R"("timelineOffsetVar":{"dataType":"TIMING","resolvedDataType":"TIMING","value":{"floatValue":1500}}}])";

std::vector<NodeChange> motionDoc() {
  auto nodes = baseChanges();
  NodeChange root = make(Guid{1, 1}, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "Root");
  root.props.extra["audioFills"] = codec::extraFromJson("NodeChange", "audioFills", parsedJson(kClipJson));
  root.props.extra["audioTracks"] = codec::extraFromJson("NodeChange", "audioTracks", parsedJson(R"([{"id":"1:8","name":"Beat.mp3","gain":1,"mute":false}])"));
  root.props.extra["audioBeatAnalyses"] = codec::extraFromJson(
      "NodeChange", "audioBeatAnalyses", parsedJson(R"([{"mediaHash":"0123456789abcdef0123456789abcdef01234567","bpm":120,"beatOffsetUs":40000,"beatConfidence":0.5,"timeSignatureNumerator":3,"timeSignatureDenominator":4}])"));
  Paint video;
  video.type = PaintType::VIDEO;
  video.extra = codec::extraFromJson("Paint", "videoFillPlayback", parsedJson(R"({"startTimeMs":100,"endTimeMs":900,"timelineOffsetUs":250000,"playbackDurationUs":800000,"volume":0.25,"mute":true})"));
  root.props.fillPaints = {video};
  nodes.push_back(root);
  NodeChange text = make(Guid{1, 2}, NodeType::TEXT, Guid{1, 1}, "!", {0, 0, 100, 20}, "Hi");
  text.props.extra["textElementDelayBehaviour"] = codec::extraFromJson(
      "NodeChange", "textElementDelayBehaviour", parsedJson(R"({"enabled":true,"grouping":"WORD","delayMs":50,"order":"LEFT_RIGHT","clipContent":true,"transformOriginMode":"WORD","transformOrigin":{"x":0.5,"y":1}})"));
  nodes.push_back(text);
  return nodes;
}

}  // namespace

TEST_CASE("r17c motion fields of Figma's current schema: the schema knows them, and they survive load, an edit and the snapshot") {
  for (const char* k : {"audioFills", "audioBeatAnalyses", "textElementDelayBehaviour"}) CHECK(codec::fieldIdOf("NodeChange", k) != 0);
  CHECK(codec::fieldIdOf("NodeChange", "audioBeatAnalyses") == 613);
  CHECK(codec::fieldIdOf("Paint", "videoFillPlayback") == 47);
  CHECK(codec::fieldIdOf("AudioFill", "timelineOffsetVar") == 20);
  CHECK(codec::fieldIdOf("TimelineData", "durationUsVar") == 8);
  CHECK(codec::fieldIdOf("StyleIdForAnimation", "timelineOffsetVar") == 7);
  CHECK(codec::fieldIdOf("KeyframeAnyValue", "rotation3DValue") == 12);
  CHECK(codec::fieldIdOf("NodeContentsKeyframeBindingLocation", "audioParametrizedField") == 5);
  auto nodes = motionDoc();
  for (const NodeChange& n : nodes)
    if (n.guid == Guid{1, 1}) {
      REQUIRE_FALSE(n.props.extra.at("audioBeatAnalyses").empty());
      REQUIRE_FALSE(n.props.fillPaints[0].extra.empty());
    }
  Editor e = load(nodes);
  NodeChange c = NodeChange::changed(Guid{0, 0});
  c.mask = F_OPACITY;
  c.props.opacity = 0.5;
  REQUIRE(e.setProps({Guid{1, 1}, Guid{1, 2}}, c, 0) == OK);
  codec::KiwiMessage m;
  REQUIRE(codec::readMessage(codec::writeMessage(0, e.encodeDocument()), m));
  const NodeChange *root = nullptr, *text = nullptr;
  for (const NodeChange& n : m.changes) {
    if (n.guid == Guid{1, 1}) root = &n;
    if (n.guid == Guid{1, 2}) text = &n;
  }
  REQUIRE(root);
  REQUIRE(text);
  for (const NodeChange& n : nodes) {
    if (n.guid == Guid{1, 1}) {
      CHECK(root->props.extra.at("audioBeatAnalyses") == n.props.extra.at("audioBeatAnalyses"));
      CHECK(root->props.extra.at("audioFills") == n.props.extra.at("audioFills"));
      REQUIRE(root->props.fillPaints.size() == 1);
      CHECK(root->props.fillPaints[0].extra == n.props.fillPaints[0].extra);
    }
    if (n.guid == Guid{1, 2}) CHECK(text->props.extra.at("textElementDelayBehaviour") == n.props.extra.at("textElementDelayBehaviour"));
  }
  std::string stagger = codec::extraValueToJson("NodeChange", text->props.extra.at("textElementDelayBehaviour"));
  CHECK(stagger.find("\"clipContent\":true") != std::string::npos);
  CHECK(stagger.find("\"transformOriginMode\":\"WORD\"") != std::string::npos);
}

TEST_CASE("r17c motion audio: an edit keeps the clip's beat grid; a typed volume or offset detaches its variable") {
  Editor e = load(motionDoc());
  motion::State s;
  s.on = true;
  s.root = Guid{1, 1};
  e.setMotion(s);
  CommandArgs a;
  REQUIRE(json::parse(R"({"root":"1:1","edits":[{"id":"1:7","mute":true}]})", a.raw));
  REQUIRE(e.command(CommandId::MOTION_SET_AUDIO, a) == OK);
  auto clipJson = [&] { return codec::extraValueToJson("NodeChange", e.document().get(Guid{1, 1})->props.extra.at("audioFills")); };
  std::string j = clipJson();
  CHECK(j.find("\"mute\":true") != std::string::npos);
  CHECK(j.find("\"bpm\":120") != std::string::npos);
  CHECK(j.find("\"sourceDurationUs\"") != std::string::npos);  // int64: its JSON form may be a string
  CHECK(j.find("\"timeSignatureNumerator\":3") != std::string::npos);
  CHECK(j.find("\"volumeVar\"") != std::string::npos);
  CHECK(j.find("\"timelineOffsetVar\"") != std::string::npos);
  REQUIRE(json::parse(R"({"root":"1:1","edits":[{"id":"1:7","volume":0.2,"offsetUs":100000}]})", a.raw));
  REQUIRE(e.command(CommandId::MOTION_SET_AUDIO, a) == OK);
  j = clipJson();
  CHECK(j.find("\"volumeVar\"") == std::string::npos);
  CHECK(j.find("\"timelineOffsetVar\"") == std::string::npos);
  CHECK(j.find("\"bpm\":120") != std::string::npos);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(clipJson().find("\"volumeVar\"") != std::string::npos);
}

// ---- editScopeInfo 365: Figma's scope stack and the changes stamped with it (canvas.md §2.9) -----------------------

TEST_CASE("r17c edit scopes: Figma's nesting rules") {
  using T = Editor::EditScopeType;
  Editor e = load(baseChanges());
  CHECK(e.editScopePop() == E_INVALID);
  CHECK(e.editScopePush(T::INVALID, "") == E_INVALID);
  REQUIRE(e.editScopePush(T::PLUGIN, "Rename") == OK);
  CHECK(e.editScopePush(T::USER, "") == E_INVALID);  // USER not inside PLUGIN
  CHECK(e.editScopeError() == "USER edit scope is not allowed inside PLUGIN edit scope");
  CHECK(e.editScopePush(T::PLUGIN, "") == E_INVALID);  // never two of one type
  CHECK(e.editScopePush(T::REST_API, "") == E_INVALID);
  CHECK(e.editScopePush(T::AUTOSAVE, "") == E_INVALID);
  CHECK(e.editScopePush(T::TEST_SETUP, "") == E_INVALID);
  REQUIRE(e.editScopePush(T::SYSTEM, "Layout") == OK);  // SYSTEM goes anywhere
  CHECK(e.editScopePush(T::AI, "") == E_INVALID);       // AI not inside SYSTEM
  CHECK(e.editScopeDepth() == 2);
  REQUIRE(e.editScopePop() == OK);
  REQUIRE(e.editScopePush(T::AI, "") == OK);  // AI inside PLUGIN is allowed
  REQUIRE(e.editScopePop() == OK);
  REQUIRE(e.editScopePop() == OK);
  REQUIRE(e.editScopePush(T::USER, "") == OK);
  CHECK(e.editScopePush(T::REST_API, "") == E_INVALID);    // REST_API not inside USER
  CHECK(e.editScopePush(T::ONBOARDING, "") == E_INVALID);  // ONBOARDING not inside USER
  REQUIRE(e.editScopePush(T::PLUGIN, "") == OK);           // PLUGIN inside USER is allowed
  REQUIRE(e.editScopePop() == OK);
  REQUIRE(e.editScopePop() == OK);
  REQUIRE(e.editScopePush(T::TEST_SETUP, "") == OK);
  REQUIRE(e.editScopePop() == OK);
}

namespace {

std::string scopeJsonOf(const Editor& e, Guid id) {
  const Node* n = e.document().get(id);
  REQUIRE(n);
  auto it = n->props.extra.find("editScopeInfo");
  return it == n->props.extra.end() ? std::string() : codec::extraValueToJson("NodeChange", it->second);
}

}  // namespace

TEST_CASE("r17c edit scopes: a user edit, a pushed plugin scope and an agent's write stamp the changes they make") {
  const Guid R{9, 1}, S{9, 2};
  auto nodes = baseChanges();
  nodes.push_back(make(R, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 10, 10}, "R"));
  nodes.push_back(make(S, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {20, 0, 10, 10}, "S"));
  Editor e = load(nodes);
  NodeChange c = NodeChange::changed(Guid{0, 0});
  c.mask = F_OPACITY;
  c.props.opacity = 0.5;
  // Off (the engine's default): nothing stamped.
  REQUIRE(e.setProps({R}, c, 0) == OK);
  CHECK(scopeJsonOf(e, R).empty());
  e.setEditTracking(true);
  e.takeEvents();
  c.props.opacity = 0.4;
  REQUIRE(e.setProps({R}, c, 0) == OK);
  std::string user = scopeJsonOf(e, R);
  CHECK(user.find("\"type\":\"USER\"") != std::string::npos);
  CHECK(user.find("\"editorType\":\"DESIGN\"") != std::string::npos);
  CHECK(scopeJsonOf(e, S).empty());  // only what was written
  // The stamp travels in the step's change message.
  Editor::Events ev = e.takeEvents();
  bool carried = false;
  for (const auto& d : ev.documents)
    for (const NodeChange& n : d.changes)
      if (n.guid == R && n.props.extra.count("editScopeInfo")) carried = true;
  CHECK(carried);
  // A plugin's scope pushed around the edit.
  REQUIRE(e.editScopePush(Editor::EditScopeType::PLUGIN, "Rename it") == OK);
  c.props.opacity = 0.3;
  REQUIRE(e.setProps({S}, c, 0) == OK);
  REQUIRE(e.editScopePop() == OK);
  std::string plugin = scopeJsonOf(e, S);
  CHECK(plugin.find("\"type\":\"PLUGIN\"") != std::string::npos);
  CHECK(plugin.find("\"label\":\"Rename it\"") != std::string::npos);
  // An agent's write (an actor) is AI.
  REQUIRE(e.actorBegin(7, {R}, kNoGuid, "Agent edit", false, 7) == OK);
  c.props.opacity = 0.2;
  REQUIRE(e.setProps({R}, c, 0) == OK);
  REQUIRE(e.actorEnd(false) == OK);
  CHECK(scopeJsonOf(e, R).find("\"type\":\"AI\"") != std::string::npos);
  // Undo puts the earlier stamp back with the value.
  REQUIRE(e.actorUndo(7, false));
  CHECK(e.document().get(R)->props.opacity == doctest::Approx(0.4));
  CHECK(scopeJsonOf(e, R).find("\"type\":\"USER\"") != std::string::npos);
}
