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
