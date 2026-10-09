// Round 11 — canvas chrome and engine overlays as live Figma draws them (docs/engine-build.md "Round 11 — Canvas
// chrome and engine overlays"): a selected component set's "3 Variants" pill with the "+" (Add variant) under it and a
// pink box in each gap; no title over a top-level instance; a hovered text's baseline underline; smart selection's
// dots off the selection (and on a selected group's layers), rings on it.
#include <algorithm>
#include <array>
#include <cmath>

#include "doctest.h"
#include "Helpers.h"
#include "TextHelpers.h"
#include "editor/Editor.h"
#include "gfx/null/NullDevice.h"
#include "render/Renderer.h"
#include "text/Fonts.h"

using namespace eng;
using namespace eng::test;

namespace {

// The live capture's set "Chip" (364 × 40 Hug, gap 16, padding 16; three 100 × 40 variants), "Button" (an auto-layout
// component, 95 × 44, gap 8) and its instance, a text, three equally spaced rectangles and a group of two.
const Guid SET{1, 1}, V1{1, 2}, V2{1, 3}, V3{1, 4}, BTN{1, 10}, ICON{1, 11}, LABEL{1, 12}, INST{1, 20}, TEXT{1, 30};
const Guid R1{1, 40}, R2{1, 41}, R3{1, 42}, GRP{1, 50}, GA{1, 51}, GB{1, 52}, PLAIN{1, 60};
const Guid STATE{1, 0x7fffff00};

struct Fonts {
  Fonts() {
    auto& fonts = text::FontRegistry::get();
    int32_t upright = addFontFile(std::string(ENG_FONTS_DIR) + "/InterVariable.ttf");
    for (const char* style : {"Regular", "Medium", "Semi Bold", "Bold"}) fonts.bind("Inter", style, upright);
    fonts.takeRequests();
  }
  ~Fonts() { text::FontRegistry::get().reset(); }
};

void stack(NodeChange& c, StackMode mode, double gap, double padX, double padY) {
  StackFacet& st = c.props.stack();
  st.stackMode = mode;
  st.stackSpacing = gap;
  st.stackPaddingLeft = st.stackPaddingRight = padX;
  st.stackPaddingTop = st.stackPaddingBottom = padY;
}

std::vector<NodeChange> nodes() {
  auto out = baseChanges();
  NodeChange set = make(SET, NodeType::FRAME, kPage, "!", {0, 0, 364, 40}, "Chip");
  set.props.comp().isStateGroup = true;
  stack(set, StackMode::HORIZONTAL, 16, 16, 16);
  set.props.stack().stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  ComponentPropDef state;
  state.id = STATE;
  state.name = "State";
  state.type = ComponentPropType::VARIANT;
  state.initialValue.hasText = true;
  state.initialValue.textValue.characters = "Default";
  set.props.comp().componentPropDefs = {state};
  set.props.comp().stateGroupPropertyValueOrders = {{"State", {"Default", "Hover", "Pressed"}}};
  out.push_back(set);
  const char* values[3] = {"Default", "Hover", "Pressed"};
  const Guid vs[3] = {V1, V2, V3};
  for (int i = 0; i < 3; i++) {
    NodeChange v = make(vs[i], NodeType::SYMBOL, SET, std::string(1, static_cast<char>('!' + i)), {16.0 + 116 * i, 16, 100, 40}, std::string("State=") + values[i]);
    v.props.comp().variantPropSpecs = {{STATE, values[i]}};
    out.push_back(v);
  }
  NodeChange btn = make(BTN, NodeType::SYMBOL, kPage, "\"", {0, 200, 95, 44}, "Button");
  stack(btn, StackMode::HORIZONTAL, 8, 16, 10);
  btn.props.stack().stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  btn.props.stack().stackCounterSizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  out.push_back(btn);
  out.push_back(make(ICON, NodeType::ROUNDED_RECTANGLE, BTN, "!", {16, 10, 24, 24}, "Icon"));
  out.push_back(make(LABEL, NodeType::ROUNDED_RECTANGLE, BTN, "\"", {48, 10, 31, 24}, "Label"));
  NodeChange inst = make(INST, NodeType::INSTANCE, kPage, "#", {0, 300, 95, 44}, "Button instance");
  inst.props.comp().symbolData.symbolID = BTN;
  inst.props.fillPaints.clear();
  out.push_back(inst);
  NodeChange text = make(TEXT, NodeType::TEXT, kPage, "$", {0, 400, 200, 20}, "Hello Figma text");
  text.props.text().textData.characters = "Hello Figma text";
  text.props.text().textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
  out.push_back(text);
  out.push_back(make(R1, NodeType::ROUNDED_RECTANGLE, kPage, "%", {500, 0, 60, 60}, "S1"));
  out.push_back(make(R2, NodeType::ROUNDED_RECTANGLE, kPage, "&", {580, 0, 60, 60}, "S2"));
  out.push_back(make(R3, NodeType::ROUNDED_RECTANGLE, kPage, "'", {660, 0, 60, 60}, "S3"));
  NodeChange grp = make(GRP, NodeType::FRAME, kPage, "(", {500, 200, 140, 80}, "Group");
  grp.props.resizeToFit = true;
  grp.props.fillPaints.clear();
  out.push_back(grp);
  out.push_back(make(GA, NodeType::ROUNDED_RECTANGLE, GRP, "!", {0, 0, 60, 80}, "g_a"));
  out.push_back(make(GB, NodeType::ROUNDED_RECTANGLE, GRP, "\"", {80, 0, 60, 80}, "g_b"));
  NodeChange plain = make(PLAIN, NodeType::FRAME, kPage, ")", {0, 600, 232, 72}, "AL_horizontal");
  stack(plain, StackMode::HORIZONTAL, 10, 16, 16);
  out.push_back(plain);
  out.push_back(make({1, 61}, NodeType::ROUNDED_RECTANGLE, PLAIN, "!", {16, 16, 60, 40}, "item1"));
  out.push_back(make({1, 62}, NodeType::ROUNDED_RECTANGLE, PLAIN, "\"", {86, 16, 60, 40}, "item2"));
  return out;
}

// Zoom 1.5, the page origin at (100, 100) on screen.
struct Scene {
  Fonts fonts;
  Editor e;
  gfx::NullDevice device;
  Renderer r{device};
  Scene() {
    e.setSessionID(1);
    e.setViewport(1400, 900, 1, 1400, 900);
    e.loadDocument(nodes(), kNoGuid);
    e.setCamera({100, 100, 1.5});
    e.takeEvents();
    r.setTextLayouts(&e);
  }
  Vec2 screen(Vec2 world) const { return e.camera().toScreen(world); }
  void move(Vec2 s) { e.pointer(PointerEvent::MOVE, s.x, s.y, 0, 0, 0); }
  void click(Vec2 s) {
    e.pointer(PointerEvent::MOVE, s.x, s.y, 0, 0, 0);
    e.pointer(PointerEvent::DOWN, s.x, s.y, 0, 1, 0, 1);
    e.pointer(PointerEvent::UP, s.x, s.y, 0, 0, 0);
  }
  std::vector<DrawInstance> draw(const OverlayStyle& style = OverlayStyle::of(Theme::Dark)) {
    device.draws.clear();
    r.render(e.document(), e.page(), e.camera(), e.viewport(), e.overlay(), style);
    e.setCanvasHits(r.canvasHits());
    std::vector<DrawInstance> all;
    for (size_t i = 0; i < device.draws.size(); i++)
      for (const DrawInstance& q : device.instancesOf<DrawInstance>(i)) all.push_back(q);
    return all;
  }
};

bool sameColor(const DrawInstance& q, const Color& c) {
  return std::fabs(q.color[0] - c.r) < 0.01 && std::fabs(q.color[1] - c.g) < 0.01 && std::fabs(q.color[2] - c.b) < 0.01 && q.color[3] > 0.99;
}
uint32_t flags(const DrawInstance& q) { return static_cast<uint32_t>(q.geom[3]); }
bool isFill(const DrawInstance& q) { return (flags(q) & (DF_STROKE | DF_FILL_AND_STROKE)) == 0; }
bool isStroke(const DrawInstance& q) { return (flags(q) & DF_STROKE) != 0 && (flags(q) & DF_FILL_AND_STROKE) == 0; }
bool kind(const DrawInstance& q, ShapeKind k) { return q.geom[2] == static_cast<float>(k); }

// {x, y, w, h} of the shapes `pred` keeps.
template <class Pred>
std::vector<std::array<float, 4>> boxes(const std::vector<DrawInstance>& all, Pred pred) {
  std::vector<std::array<float, 4>> out;
  for (const DrawInstance& q : all)
    if (pred(q)) out.push_back({q.origin[0], q.origin[1], q.origin[2], q.origin[3]});
  std::sort(out.begin(), out.end());
  return out;
}

}  // namespace

TEST_CASE("r11 component set: \"3 Variants\" in the pill, the \"+\" 4 px under it adds a variant into the flow") {
  Scene s;
  s.e.setSelection({SET});
  const OverlayStyle style = OverlayStyle::of(Theme::Dark);
  auto all = s.draw();
  // The pill: 17 high in the component purple, 6 px under the set, centred; "3 Variants" (live 67 px at 1.07 px per
  // CSS px: 62.6), not "364 Hug × 40" (~84).
  auto pills = boxes(all, [&](const DrawInstance& q) { return isFill(q) && kind(q, ShapeKind::Rect) && sameColor(q, style.component) && q.origin[3] == 17; });
  REQUIRE(pills.size() == 1);
  Vec2 bottom = s.screen({182, 40});
  CHECK(pills[0][1] == doctest::Approx(bottom.y + 6));
  CHECK(pills[0][0] + pills[0][2] / 2 == doctest::Approx(bottom.x).epsilon(0.01));
  CHECK(pills[0][2] > 58);
  CHECK(pills[0][2] < 66);
  // The "+": a 16 × 16 purple square 4 px under the pill, centred, with a white plus 10 across.
  const CanvasHits::AddVariant& plus = s.e.canvasHits().addVariant;
  REQUIRE(plus.set == SET);
  CHECK(plus.rect.w == 16);
  CHECK(plus.rect.h == 16);
  CHECK(plus.rect.y == doctest::Approx(pills[0][1] + 17 + 4));
  CHECK(plus.rect.x + 8 == doctest::Approx(bottom.x).epsilon(0.01));
  auto squares = boxes(all, [&](const DrawInstance& q) { return isFill(q) && sameColor(q, style.component) && q.origin[2] == 16 && q.origin[3] == 16; });
  CHECK(squares.size() == 1);
  auto bars = boxes(all, [&](const DrawInstance& q) {
    return isFill(q) && sameColor(q, Color{1, 1, 1, 1}) && ((q.origin[2] == 10 && q.origin[3] == 1.5f) || (q.origin[2] == 1.5f && q.origin[3] == 10));
  });
  CHECK(bars.size() == 2);
  // A pink box in each gap, across the content box: x 116 / 232, y 16 to 24, 1 px inside.
  const Overlay o = s.e.overlay();
  REQUIRE(o.gapBoxes.size() == 2);
  CHECK(o.gapBoxes[0].rect == Rect{116, 16, 16, 8});
  CHECK(o.gapBoxes[1].rect == Rect{232, 16, 16, 8});
  auto gaps = boxes(all, [&](const DrawInstance& q) { return isStroke(q) && kind(q, ShapeKind::Rect) && sameColor(q, style.spacing) && q.geom[0] == 1; });
  REQUIRE(gaps.size() == 2);
  CHECK(gaps[0][0] == doctest::Approx(s.screen({116, 0}).x));
  CHECK(gaps[0][1] == doctest::Approx(s.screen({0, 16}).y));
  CHECK(gaps[0][2] == doctest::Approx(16 * 1.5));
  CHECK(gaps[0][3] == doctest::Approx(8 * 1.5));
  // A press on the "+": a fourth variant after the last, in the flow; the set hugs it, its height stays; one step.
  s.click({plus.rect.x + 8, plus.rect.y + 8});
  REQUIRE(s.e.document().children(SET).size() == 4);
  Guid added = s.e.document().children(SET)[3];
  CHECK(s.e.selection() == std::vector<Guid>{added});
  CHECK(s.e.document().get(added)->props.transform.m02 == doctest::Approx(364));
  CHECK(s.e.document().get(added)->props.transform.m12 == doctest::Approx(16));
  CHECK(s.e.document().get(SET)->props.size == Vec2{480, 40});
  CHECK(s.e.undoStack().undoLabel() == "Add variant");
  s.e.command(CommandId::UNDO);
  CHECK(s.e.document().children(SET).size() == 3);
  CHECK(s.e.document().get(SET)->props.size == Vec2{364, 40});
}

TEST_CASE("r11 component set: the + only with the handles, none for a plain frame or a variant; gap boxes only on components") {
  Scene s;
  // A variant selected: its own size in the pill, no "+".
  s.e.setSelection({V2});
  s.draw();
  CHECK(s.e.canvasHits().addVariant.set == kNoGuid);
  CHECK(s.e.overlay().gapBoxes.empty());  // no auto layout
  // The Button component and its instance: the gap between their two layers, across the 24-high content box.
  s.e.setSelection({BTN});
  REQUIRE(s.e.overlay().gapBoxes.size() == 1);
  CHECK(s.e.overlay().gapBoxes[0].rect == Rect{40, 10, 8, 24});
  s.e.setSelection({INST});
  REQUIRE(s.e.overlay().gapBoxes.size() == 1);
  CHECK(s.e.overlay().gapBoxes[0].rect == Rect{40, 10, 8, 24});
  // A plain auto-layout frame: none (live: its gaps show only as the hover bars).
  s.e.setSelection({PLAIN});
  CHECK(s.e.overlay().gapBoxes.empty());
  // Moving the set: no "+", no gap boxes (the handles are off).
  s.e.setSelection({SET});
  Vec2 in = s.screen({60, 30});
  s.e.pointer(PointerEvent::MOVE, in.x, in.y, 0, 0, 0);
  s.e.pointer(PointerEvent::DOWN, in.x, in.y, 0, 1, 0, 1);
  s.e.pointer(PointerEvent::MOVE, in.x + 30, in.y + 30, 0, 1, 0);
  CHECK(s.e.overlay().gapBoxes.empty());
  s.draw();
  CHECK(s.e.canvasHits().addVariant.set == kNoGuid);
  s.e.pointer(PointerEvent::UP, in.x + 30, in.y + 30, 0, 0, 0);
}

TEST_CASE("r11 titles: none over a top-level instance, selected or not; the component keeps its own") {
  Scene s;
  auto titled = [&](Guid id) {
    for (const FrameTitle& t : s.e.titles())
      if (t.id == id) return true;
    return false;
  };
  CHECK(titled(BTN));
  CHECK(titled(SET));
  CHECK_FALSE(titled(INST));
  s.e.setSelection({INST});
  CHECK_FALSE(titled(INST));
  // A press where a title would be selects nothing there.
  Vec2 above = s.screen({20, 300});
  s.click({above.x, above.y - 12});
  CHECK(s.e.selection().empty());
}

TEST_CASE("r11 text hover: the lines' baseline underlined (2 px; 1 px when selected), no box") {
  Scene s;
  const OverlayStyle style = OverlayStyle::of(Theme::Dark);
  const text::TextLayout* L = s.e.textLayout(TEXT);
  REQUIRE(L);
  REQUIRE(L->lines.size() == 1);
  const text::LaidLine line = L->lines[0];
  s.move(s.screen({line.x + line.width / 2, 400 + line.baseline - 4}));
  REQUIRE(s.e.overlay().hover == std::vector<Guid>{TEXT});
  auto all = s.draw();
  auto lines = boxes(all, [&](const DrawInstance& q) { return isFill(q) && kind(q, ShapeKind::Rect) && sameColor(q, style.selection); });
  REQUIRE(lines.size() == 1);
  Vec2 a = s.screen({line.x, 400 + line.baseline}), b = s.screen({line.x + line.width, 400 + line.baseline});
  CHECK(lines[0][0] == doctest::Approx(std::round(a.x)));
  CHECK(lines[0][1] == doctest::Approx(std::round(a.y)));  // from the baseline down
  CHECK(lines[0][2] == doctest::Approx(std::round(b.x) - std::round(a.x)));
  CHECK(lines[0][3] == 2);
  // No 2 px outline box.
  CHECK(boxes(all, [&](const DrawInstance& q) { return isStroke(q) && sameColor(q, style.selection) && q.geom[0] == 2; }).empty());
  // Selected and hovered: 1 px.
  s.e.setSelection({TEXT});
  s.move(s.screen({line.x + line.width / 2, 400 + line.baseline - 4}));
  all = s.draw();
  lines = boxes(all, [&](const DrawInstance& q) { return isFill(q) && kind(q, ShapeKind::Rect) && sameColor(q, style.selection) && q.origin[2] > 20 && q.origin[3] <= 2; });  // not the size badge
  REQUIRE(lines.size() == 1);
  CHECK(lines[0][3] == 1);
}

TEST_CASE("r11 smart selection: tiny dots off the selection, rings on it; a selected group's layers dotted") {
  Scene s;
  const OverlayStyle style = OverlayStyle::of(Theme::Dark);
  const Color white{1, 1, 1, 1};
  s.e.setSelection({R1, R2, R3});
  s.move({20, 800});  // away
  Overlay o = s.e.overlay();
  REQUIRE(o.centreDots.size() == 3);
  CHECK(o.centreDotsIdle);
  auto all = s.draw();
  auto ellipses = [&](const Color& c, bool fill, float d) {
    return boxes(all, [&](const DrawInstance& q) { return kind(q, ShapeKind::Ellipse) && sameColor(q, c) && (fill ? isFill(q) : isStroke(q)) && q.origin[2] == d; });
  };
  // A white dot 3.5 across with a pink core 1.5 across, on each centre.
  CHECK(ellipses(white, true, 3.5f).size() == 3);
  auto cores = ellipses(style.spacing, true, 1.5f);
  REQUIRE(cores.size() == 3);
  Vec2 c1 = s.screen({530, 30});
  CHECK(cores[0][0] + 0.75f == doctest::Approx(std::round(c1.x)));
  CHECK(cores[0][1] + 0.75f == doctest::Approx(std::round(c1.y)));
  // The pointer on the selection: rings — pink 9 across (1 px inside) between white ones 11 and 7 across.
  s.move(s.screen({610, 30}));
  CHECK_FALSE(s.e.overlay().centreDotsIdle);
  all = s.draw();
  CHECK(ellipses(style.spacing, false, 9).size() == 2);  // the one under the pointer is lit
  CHECK(ellipses(white, false, 11).size() == 2);
  CHECK(ellipses(white, false, 7).size() == 2);
  CHECK(ellipses(style.spacing, true, 9).size() == 1);
  // A selected group of two layers 20 apart: their centres dotted.
  s.e.setSelection({GRP});
  s.move({20, 800});
  o = s.e.overlay();
  REQUIRE(o.centreDots.size() == 2);
  CHECK(o.centreDotsIdle);
  CHECK(o.centreDots[0] == Vec2{530, 240});
  CHECK(o.centreDots[1] == Vec2{610, 240});
  CHECK(o.gapHandles.empty());
}
