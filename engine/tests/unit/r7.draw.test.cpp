// Round 7, Figma Draw — model and render (docs/draw.md §4.2–4.4, §4.8; roadmap "Round 7" 7a): transform groups
// (TRANSFORM, its repeats evaluated, bounded, drawn, hit and exported as their copies), dynamic strokes (the seeded
// wandering centre line), text on a path (TEXT_PATH: glyphs placed and turned along their path), pattern strokes.
#include <cmath>
#include <string>

#include "base/Json.h"
#include "doctest.h"
#include "editor/Editor.h"
#include "export/Export.h"
#include "export/PdfWriter.h"
#include "export/Scene.h"
#include "export/SvgWriter.h"
#include "geometry/DynamicStroke.h"
#include "geometry/Repeat.h"
#include "geometry/Shapes.h"
#include "geometry/VectorNetwork.h"
#include "gfx/null/NullDevice.h"
#include "Helpers.h"
#include "hit/HitTest.h"
#include "hit/Picking.h"
#include "render/RenderTree.h"
#include "render/Renderer.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"
#include "text/DerivedText.h"
#include "text/TextPathLayout.h"
#include "TextHelpers.h"

using namespace eng;
using namespace eng::test;

namespace {

constexpr double kPi = 3.14159265358979323846;

std::string extra(const char* key, const std::string& jsonValue) {
  json::Value v;
  REQUIRE(json::parse(jsonValue, v));
  std::string bytes = codec::extraFromJson("NodeChange", key, v);
  REQUIRE(!bytes.empty());
  return bytes;
}

std::string repeatJson(const char* kind, int count, double offset, const char* axis = "X", const char* unit = "PIXELS",
                       const char* order = "FORWARD", double offsetY = 0) {
  return std::string("{\"type\":\"REPEAT\",\"offset\":{\"x\":") + std::to_string(offset) + ",\"y\":" + std::to_string(offsetY) +
         "},\"visible\":true,\"count\":" + std::to_string(count) + ",\"repeatType\":\"" + kind + "\",\"axis\":\"" + axis +
         "\",\"unitType\":\"" + unit + "\",\"order\":\"" + order + "\"}";
}

geom::TransformModifier linear(uint32_t count, double gap, geom::TransformModifier::Axis axis = geom::TransformModifier::Axis::X) {
  geom::TransformModifier m;
  m.repeatType = geom::TransformModifier::Repeat::LINEAR;
  m.count = count;
  m.offset = {gap, 0};
  m.axis = axis;
  return m;
}

geom::TransformModifier radial(uint32_t count, double r) {
  geom::TransformModifier m;
  m.repeatType = geom::TransformModifier::Repeat::RADIAL;
  m.count = count;
  m.offset = {r, 0};
  return m;
}

bool near(double a, double b, double eps = 1e-6) { return std::fabs(a - b) <= eps; }

VectorData vectorOf(const geom::Path& path, Vec2 size) {
  geom::VectorNetwork net = geom::networkFromPath(path, WindingRule::NONZERO);
  VectorData d;
  d.present = true;
  d.normalizedSize = size;
  d.network = std::make_shared<const std::vector<uint8_t>>(net.encode());
  return d;
}

const Guid TG{1, 10}, A{1, 11}, B2{1, 12}, OTHER{1, 13};

// A transform group at (100, 100) holding a 20 × 10 red rectangle, repeated by `modifiers` (a JSON array).
std::vector<NodeChange> repeatScene(const std::string& modifiers) {
  auto nodes = baseChanges();
  NodeChange g = make(TG, NodeType::TRANSFORM, kPage, "!", {100, 100, 20, 10}, "Repeat group 1");
  g.props.fillPaints.clear();
  g.props.extra["transformModifiers"] = extra("transformModifiers", modifiers);
  nodes.push_back(g);
  NodeChange r = make(A, NodeType::ROUNDED_RECTANGLE, TG, "!", {0, 0, 20, 10}, "Tile");
  r.props.fillPaints = {Paint::solid(Color{1, 0, 0, 1})};
  nodes.push_back(r);
  return nodes;
}

struct Frame {
  size_t paths = 0, shapes = 0, composites = 0;
  std::vector<DrawInstance> instances;
};

Frame record(Renderer& r, gfx::NullDevice& dev, const Document& d) {
  dev.draws.clear();
  r.render(d, kPage, Camera{}, {800, 600, 1, 800, 600}, Overlay{}, OverlayStyle::of(Theme::Dark));
  Frame f;
  for (size_t i = 0; i < dev.draws.size(); i++) {
    const auto& c = dev.draws[i];
    if (c.pipeline.shader == gfx::ShaderId::Shape) {
      for (auto& q : dev.instancesOf<DrawInstance>(i)) {
        if (q.geom[2] == static_cast<float>(ShapeKind::Path)) f.paths++;
        else f.shapes++;
        f.instances.push_back(q);
      }
    } else if (c.pipeline.shader == gfx::ShaderId::Composite) {
      f.composites++;
    }
  }
  return f;
}

size_t count(const std::string& s, const std::string& what) {
  size_t n = 0;
  for (size_t at = s.find(what); at != std::string::npos; at = s.find(what, at + what.size())) n++;
  return n;
}

}  // namespace

// ---- Transform groups (§4.2) ----

TEST_CASE("r7 repeat: linear X / Y / X_AND_Y, in px and relative to the content") {
  const Rect B{0, 0, 20, 10};
  geom::RepeatResult r = geom::evaluateRepeat({linear(3, 10)}, B);
  REQUIRE(r.instances.size() == 3);
  CHECK(r.instances[0] == Mat2x3{});  // copy 0 is the source
  CHECK(near(r.instances[1].m02, 30));
  CHECK(near(r.instances[2].m02, 60));
  CHECK(near(r.bounds.w, 80));
  CHECK(near(r.bounds.h, 10));
  // Y, relative: the gap is half the content's height.
  geom::TransformModifier y = linear(4, 0.5, geom::TransformModifier::Axis::Y);
  y.unitType = geom::TransformModifier::Unit::RELATIVE;
  r = geom::evaluateRepeat({y}, B);
  REQUIRE(r.instances.size() == 4);
  CHECK(near(r.instances[1].m12, 15));
  CHECK(near(r.instances[3].m12, 45));
  CHECK(near(r.instances[3].m02, 0));
  CHECK(near(r.bounds.h, 55));
  // X_AND_Y: a diagonal (offset.y the second gap).
  geom::TransformModifier xy = linear(3, 5, geom::TransformModifier::Axis::X_AND_Y);
  xy.offset.y = 2;
  r = geom::evaluateRepeat({xy}, B);
  CHECK(near(r.instances[2].m02, 50));
  CHECK(near(r.instances[2].m12, 24));
  // A hidden modifier, count 1, SYMMETRY / SKEW: nothing repeats.
  geom::TransformModifier hidden = linear(5, 0);
  hidden.visible = false;
  geom::TransformModifier skew = linear(5, 0);
  skew.type = geom::TransformModifier::Type::SKEW;
  CHECK(geom::evaluateRepeat({hidden, linear(1, 0), skew}, B).instances.size() == 1);
}

TEST_CASE("r7 repeat: radial — count 1 / 2 / 8, clockwise about a pivot below the content") {
  const Rect B{0, 0, 20, 10};
  CHECK(geom::evaluateRepeat({radial(1, 0)}, B).instances.size() == 1);
  geom::RepeatResult two = geom::evaluateRepeat({radial(2, 5)}, B);
  REQUIRE(two.instances.size() == 2);
  // Pivot (10, 15): the content's top centre (10, 0) turned half a turn lands at (10, 30).
  Vec2 top = two.instances[1].apply({10, 0});
  CHECK(near(top.x, 10, 1e-9));
  CHECK(near(top.y, 30, 1e-9));
  geom::RepeatResult four = geom::evaluateRepeat({radial(4, 5)}, B);
  // Clockwise on screen: a quarter turn takes the point above the pivot to its right.
  Vec2 q = four.instances[1].apply({10, 0});
  CHECK(near(q.x, 25, 1e-9));
  CHECK(near(q.y, 15, 1e-9));
  geom::RepeatResult eight = geom::evaluateRepeat({radial(8, 0)}, B);
  CHECK(eight.instances.size() == 8);
  // Symmetric about the pivot (10, 10).
  CHECK(near(eight.bounds.x + eight.bounds.w / 2, 10, 1e-9));
  CHECK(near(eight.bounds.y + eight.bounds.h / 2, 10, 1e-9));
  // RELATIVE: the radius is a share of the content's height.
  geom::TransformModifier rel = radial(2, 1);
  rel.unitType = geom::TransformModifier::Unit::RELATIVE;
  CHECK(near(geom::evaluateRepeat({rel}, B).instances[1].apply({10, 0}).y, 40, 1e-9));
}

TEST_CASE("r7 repeat: order, nesting, the instance cap, modifiers read from the node") {
  const Rect B{0, 0, 10, 10};
  geom::TransformModifier rev = linear(3, 0);
  rev.order = geom::TransformModifier::Order::REVERSE;
  geom::RepeatResult r = geom::evaluateRepeat({rev}, B);
  REQUIRE(r.instances.size() == 3);
  CHECK(near(r.instances[0].m02, 20));  // the last copy lowest
  CHECK(r.instances[2] == Mat2x3{});    // the source on top
  // Two modifiers multiply: 3 across, then 4 down (the second repeats the first's whole row).
  r = geom::evaluateRepeat({linear(3, 0), linear(4, 0, geom::TransformModifier::Axis::Y)}, B);
  CHECK(r.instances.size() == 12);
  CHECK(near(r.bounds.w, 30));
  CHECK(near(r.bounds.h, 40));
  // The cap: 1000 × 1000 asked, the first 10 000 kept; counts clamp to 1000.
  r = geom::evaluateRepeat({linear(5000, 0), linear(1000, 0, geom::TransformModifier::Axis::Y)}, B);
  CHECK(r.instances.size() == geom::kMaxRepeatInstances);
  CHECK(r.capped);
  CHECK(near(r.bounds.w, 10000));  // 1000 across (5000 clamped)
  // From the node's transformModifiers (Figma's names).
  NodeProps p = defaultProps(NodeType::TRANSFORM);
  p.extra["transformModifiers"] = extra("transformModifiers", "[" + repeatJson("RADIAL", 6, 2, "X", "RELATIVE", "REVERSE") + "]");
  const auto& mods = transformModifiersOf(p);
  REQUIRE(mods.size() == 1);
  CHECK(mods[0].repeatType == geom::TransformModifier::Repeat::RADIAL);
  CHECK(mods[0].count == 6);
  CHECK(mods[0].unitType == geom::TransformModifier::Unit::RELATIVE);
  CHECK(mods[0].order == geom::TransformModifier::Order::REVERSE);
  CHECK(near(mods[0].offset.x, 2));
  CHECK(mods[0].visible);
  CHECK(std::string(nodeTypeName(NodeType::TRANSFORM)) == "TRANSFORM");
  CHECK(nodeTypeFromName("TEXT_PATH") == NodeType::TEXT_PATH);
  CHECK(p.isGroupLike());
}

TEST_CASE("r7 repeat: the group's box is its instances' bounds, a system write in the edit that changed them") {
  Editor e;
  e.setSessionID(1);
  auto nodes = repeatScene("[" + repeatJson("LINEAR", 3, 10) + "]");
  e.loadDocument(baseChanges(), kNoGuid);
  std::vector<NodeChange> created(nodes.begin() + 3, nodes.end());
  REQUIRE(e.applyChanges(created, APPLY_USER) == OK);
  const Document& doc = e.document();
  CHECK(near(doc.get(TG)->props.size.x, 80));
  CHECK(near(doc.get(TG)->props.size.y, 10));
  CHECK(near(doc.worldBounds(TG).x, 100));
  // The child keeps its place on the page.
  CHECK(near(doc.worldBounds(A).x, 100));
  // A new count: the box follows in the same step.
  NodeChange c = NodeChange::changed(TG);
  c.mask = F_EXTRA;
  c.props.extra["transformModifiers"] = extra("transformModifiers", "[" + repeatJson("LINEAR", 5, 10) + "]");
  REQUIRE(e.applyChanges({c}, APPLY_USER) == OK);
  CHECK(near(doc.get(TG)->props.size.x, 140));
  // Radial: the box grows on every side; nothing moves on the page.
  c.props.extra["transformModifiers"] = extra("transformModifiers", "[" + repeatJson("RADIAL", 4, 0) + "]");
  REQUIRE(e.applyChanges({c}, APPLY_USER) == OK);
  CHECK(near(doc.get(TG)->props.size.x, 20));
  CHECK(near(doc.get(TG)->props.size.y, 20));
  CHECK(near(doc.worldBounds(A).x, 100));
  CHECK(near(doc.worldBounds(A).y, 100));
  CHECK(near(doc.worldBounds(TG).y, 100));
}

TEST_CASE("r7 repeat: drawn once per copy, culled per copy, the tree's bounds and damage cover every copy") {
  Editor e;
  e.setSessionID(1);
  e.loadDocument(repeatScene("[" + repeatJson("LINEAR", 3, 10) + "]"), kNoGuid);
  const Document& doc = e.document();
  gfx::NullDevice dev;
  Renderer r(dev);
  r.setTextLayouts(&e);
  Frame f = record(r, dev, doc);
  CHECK(f.shapes == 3);  // the rectangle, three times
  std::vector<double> xs;
  for (const DrawInstance& q : f.instances) xs.push_back(q.origin[0]);
  std::sort(xs.begin(), xs.end());
  REQUIRE(xs.size() == 3);
  CHECK(near(xs[1] - xs[0], 30, 1e-3));
  CHECK(near(xs[2] - xs[1], 30, 1e-3));
  // The render tree: the group's visual bounds hold every copy (its stored box is still the source's here).
  RenderTree t;
  t.sync(doc, kPage);
  int gi = t.indexOf(TG);
  REQUIRE(gi >= 0);
  CHECK(t.nodes()[static_cast<size_t>(gi)].visual.right() >= 180 - 1e-6);
  t.takeDamage();
  // A change to the source damages every copy.
  NodeChange c = NodeChange::changed(A);
  c.mask = F_FILLS;
  c.props.fillPaints = {Paint::solid(Color{0, 0, 1, 1})};
  e.applyChanges({c}, APPLY_USER);
  t.sync(doc, kPage);
  RenderTree::Damage d = t.takeDamage();
  bool covers = d.all;
  for (const Rect& rr : d.rects) covers |= rr.x <= 100 + 1e-6 && rr.right() >= 180 - 1e-6;
  CHECK(covers);
  CHECK(t.consistent(doc));
  // Off screen copies are culled: a camera that shows only the third copy draws one rectangle.
  Camera cam;
  cam.x = -165;
  cam.y = -95;
  dev.draws.clear();
  r.render(doc, kPage, cam, {10, 10, 1, 10, 10}, Overlay{}, OverlayStyle::of(Theme::Dark));
  size_t drawn = 0;
  for (size_t i = 0; i < dev.draws.size(); i++)
    if (dev.draws[i].pipeline.shader == gfx::ShaderId::Shape) drawn += dev.instancesOf<DrawInstance>(i).size();
  CHECK(drawn == 1);
}

TEST_CASE("r7 repeat: a click on any copy hits the source layer; picking selects the group") {
  Editor e;
  e.setSessionID(1);
  auto nodes = repeatScene("[" + repeatJson("LINEAR", 3, 10) + "]");
  e.loadDocument(baseChanges(), kNoGuid);
  REQUIRE(e.applyChanges(std::vector<NodeChange>(nodes.begin() + 3, nodes.end()), APPLY_USER) == OK);
  const Document& doc = e.document();
  using Sel = std::vector<Guid>;
  CHECK(hitPath(doc, kPage, {105, 105}, 1) == Sel{TG, A});  // the source
  CHECK(hitPath(doc, kPage, {165, 105}, 1) == Sel{TG, A});  // the third copy
  CHECK(hitPath(doc, kPage, {125, 105}, 1).empty());        // the gap between copies
  CHECK(pick(doc, hitPath(doc, kPage, {165, 105}, 1), {}, false) == TG);
  CHECK(pick(doc, hitPath(doc, kPage, {165, 105}, 1), {}, true) == A);  // ⌘: deep-selects the source
  // Radial: a copy turned half a turn below the pivot.
  NodeChange c = NodeChange::changed(TG);
  c.mask = F_EXTRA;
  c.props.extra["transformModifiers"] = extra("transformModifiers", "[" + repeatJson("RADIAL", 2, 0) + "]");
  REQUIRE(e.applyChanges({c}, APPLY_USER) == OK);
  Rect wb = doc.worldBounds(TG);
  CHECK(near(wb.h, 20));
  CHECK(hitPath(doc, kPage, {wb.x + 10, wb.y + 15}, 1) == Sel{TG, A});
}

TEST_CASE("r7 repeat: SVG and PDF write every copy (not only the source); booleans read the copies") {
  Editor e;
  e.setSessionID(1);
  auto nodes = repeatScene("[" + repeatJson("LINEAR", 3, 10) + "]");
  e.loadDocument(baseChanges(), kNoGuid);
  REQUIRE(e.applyChanges(std::vector<NodeChange>(nodes.begin() + 3, nodes.end()), APPLY_USER) == OK);
  const Document& doc = e.document();
  exporter::Settings s;
  s.format = exporter::Format::SVG;
  exporter::Target t;
  REQUIRE(exporter::resolveTarget(doc, &e, kNoGuid, TG, s, t));
  CHECK(near(t.bounds.w, 80));
  std::string svg = exporter::writeSvg(doc, &e, t, s);
  INFO(svg);
  CHECK(count(svg, "fill=\"#FF0000\"") == 3);
  CHECK(count(svg, "<g transform=\"matrix(1 0 0 1 30 0)\">") == 1);
  CHECK(count(svg, "<g transform=\"matrix(1 0 0 1 60 0)\">") == 1);
  CHECK(svg.find("<use") == std::string::npos);
  std::string pdf = exporter::writePdf(doc, &e, {t}, s, exporter::Rasterize{});
  CHECK(pdf.rfind("%PDF", 0) == 0);
  // A boolean over a transform group: the copies are its operand.
  Editor b;
  b.setSessionID(1);
  auto bn = baseChanges();
  NodeChange op = make({1, 20}, NodeType::BOOLEAN_OPERATION, kPage, "!", {0, 0, 80, 10}, "Union");
  bn.push_back(op);
  NodeChange g = make(TG, NodeType::TRANSFORM, {1, 20}, "!", {0, 0, 80, 10});
  g.props.extra["transformModifiers"] = extra("transformModifiers", "[" + repeatJson("LINEAR", 3, 10) + "]");
  bn.push_back(g);
  bn.push_back(make(A, NodeType::ROUNDED_RECTANGLE, TG, "!", {0, 0, 20, 10}));
  b.loadDocument(bn, kNoGuid);
  const NodeGeometry* geo = b.document().geometry({1, 20});
  REQUIRE(geo);
  REQUIRE(!geo->fills.empty());
  CHECK(near(geo->fills[0].path.bounds().w, 80, 1e-6));
}

// ---- Dynamic strokes (§4.3) ----

TEST_CASE("r7 dynamic: deterministic by seed; wiggle 0 is the basic stroke; frequency sets the wave count") {
  geom::Path line;
  line.moveTo({0, 0});
  line.lineTo({1000, 0});
  geom::DynamicSettings s{1, 1, 0};
  geom::Path a = geom::dynamicCenterline(line, 10, s, 42, 0.1);
  geom::Path b = geom::dynamicCenterline(line, 10, s, 42, 0.1);
  geom::Path c = geom::dynamicCenterline(line, 10, s, 43, 0.1);
  CHECK(a == b);
  CHECK(!(a == c));
  // Displaced across, within the amplitude (0.5 × wiggle × weight, Catmull-Rom off here).
  double maxY = 0;
  for (Vec2 p : a.points) maxY = std::max(maxY, std::fabs(p.y));
  CHECK(maxY > 0.5);
  CHECK(maxY <= geom::kDynAmplitude * 1 * 10 + 1e-9);
  // Wiggle 0: the centre line itself.
  CHECK(geom::dynamicCenterline(line, 10, geom::DynamicSettings{3, 0, 0.5}, 42, 0.1) == line);
  // Knots every λ/2 = 50 / frequency px: four times the frequency, about four times the turns of the wave.
  auto turns = [&](double freq) {
    int n = 0;
    double prev = 0, prevD = 0;
    for (double x = 0; x <= 1000; x += 0.5) {
      double w = geom::dynamicWave(x, 1000, false, freq, 0, 7, 0);
      double d = w - prev;
      if (x > 0.5 && d * prevD < 0) n++;
      prevD = d != 0 ? d : prevD;
      prev = w;
    }
    return n;
  };
  int t1 = turns(1), t4 = turns(4);
  CHECK(t1 >= 10);
  CHECK(t1 <= 21);
  CHECK(t4 >= 3 * t1);
}

TEST_CASE("r7 dynamic: smoothen 1 is C¹ at the knots; closed contours meet") {
  // The wave's slope just before and after each knot (λ/2 = 50 px at frequency 1).
  for (double knot = 50; knot < 500; knot += 50) {
    double h = 1e-4;
    double left = (geom::dynamicWave(knot, 1000, false, 1, 1, 9, 0) - geom::dynamicWave(knot - h, 1000, false, 1, 1, 9, 0)) / h;
    double right = (geom::dynamicWave(knot + h, 1000, false, 1, 1, 9, 0) - geom::dynamicWave(knot, 1000, false, 1, 1, 9, 0)) / h;
    CHECK(near(left, right, 1e-3));
  }
  // At smoothen 0 the slope jumps at a knot (linear pieces).
  bool kink = false;
  for (double knot = 50; knot < 500; knot += 50) {
    double h = 1e-4;
    double left = (geom::dynamicWave(knot, 1000, false, 1, 0, 9, 0) - geom::dynamicWave(knot - h, 1000, false, 1, 0, 9, 0)) / h;
    double right = (geom::dynamicWave(knot + h, 1000, false, 1, 0, 9, 0) - geom::dynamicWave(knot, 1000, false, 1, 0, 9, 0)) / h;
    kink |= !near(left, right, 1e-3);
  }
  CHECK(kink);
  // A closed contour: the wave wraps (its end is its start) and the result is closed.
  CHECK(near(geom::dynamicWave(0, 400, true, 2, 0.7, 5, 0), geom::dynamicWave(400, 400, true, 2, 0.7, 5, 0), 1e-9));
  geom::Path square = geom::rectPath({100, 100}, {0, 0, 0, 0});
  geom::Path out = geom::dynamicCenterline(square, 4, geom::DynamicSettings{2, 1, 0.5}, 3, 0.1);
  REQUIRE(!out.empty());
  CHECK(out.verbs.back() == geom::Verb::Close);
  size_t moves = 0;
  for (geom::Verb v : out.verbs) moves += v == geom::Verb::Move;
  CHECK(moves == 1);
}

TEST_CASE("r7 dynamic: a node's dynamic stroke — bounds, hit-testing, the renderer and the exporters use it") {
  Editor e;
  e.setSessionID(1);
  auto nodes = baseChanges();
  NodeChange v = make({1, 30}, NodeType::VECTOR, kPage, "!", {100, 100, 400, 0}, "Line");
  geom::Path line;
  line.moveTo({0, 0});
  line.lineTo({400, 0});
  v.props.shape().vectorData = vectorOf(line, {400, 0});
  v.props.strokePaints = {Paint::solid(Color{0, 0, 0, 1})};
  v.props.strokeWeight = 10;
  v.props.strokeAlign = StrokeAlign::CENTER;
  NodeChange plain = v;
  v.props.extra["dynamicStrokeSettings"] = extra("dynamicStrokeSettings", R"({"frequency": 1, "wiggle": 4, "smoothen": 0})");
  v.props.extra["strokeSeed"] = extra("strokeSeed", "1234");
  nodes.push_back(v);
  e.loadDocument(nodes, kNoGuid);
  const Document& doc = e.document();
  const NodeProps& p = doc.get({1, 30})->props;
  geom::DynamicSettings ds;
  REQUIRE(dynamicSettingsOf(p, ds));
  CHECK(near(ds.wiggle, 4));
  CHECK(strokeSeedOf(p) == 1234);
  // Bounds: the wave's reach (0.5 × 4 × 10 = 20, with Catmull-Rom's margin) past the half weight.
  Rect rb = doc.renderBounds({1, 30});
  CHECK(rb.y <= 100 - 25);
  // The displaced centre line, and a hit where it went (not on the original line).
  geom::Path center;
  REQUIRE(dynamicCenter(p, *doc.geometry({1, 30}), 0.1, center));
  Vec2 far{0, 0};
  for (Vec2 q : center.points)
    if (std::fabs(q.y) > std::fabs(far.y)) far = q;
  REQUIRE(std::fabs(far.y) > 8);
  CHECK(hitsNode(doc, {1, 30}, far, 0.5, false));
  CHECK_FALSE(hitsNode(doc, {1, 30}, {far.x, -far.y * 1.6}, 0.5, false));
  // The exporters read the wandering line (its outline), not the straight one.
  exporter::Stroke st = exporter::strokeOf(doc, {1, 30}, p);
  REQUIRE(st.present());
  CHECK(st.outlineOnly);
  CHECK(st.center.bounds().h > 8);
  // The renderer draws it as a path (the plain line of the same node would be flat).
  gfx::NullDevice dev;
  Renderer r(dev);
  Frame f = record(r, dev, doc);
  CHECK(f.paths >= 1);
}

// ---- Text on a path (§4.4) ----

namespace {

const Guid TP{1, 40};

// Inter for a test, and the module-wide font registry reset afterwards (as export.test.cpp): loadInter() would mark it
// loaded for good, and a later test's reset would leave the text tests without fonts.
struct Fonts {
  Fonts() {
    auto& fonts = text::FontRegistry::get();
    int32_t upright = addFontFile(interPath());
    for (const char* style : {"Regular", "Medium", "Bold"}) fonts.bind("Inter", style, upright);
    fonts.takeRequests();
  }
  ~Fonts() { text::FontRegistry::get().reset(); }
};

// A TEXT_PATH on `path` (node space; its box `size`) at (x, y).
std::vector<NodeChange> textPathScene(const geom::Path& path, Vec2 size, const std::string& chars, const std::string& start = "",
                                      TextAlignHorizontal align = TextAlignHorizontal::LEFT) {
  auto nodes = baseChanges();
  NodeChange t = make(TP, NodeType::TEXT_PATH, kPage, "!", {50, 50, size.x, size.y}, chars);
  t.props.shape().vectorData = vectorOf(path, size);
  t.props.text().textData.characters = chars;
  t.props.text().fontSize = 20;
  t.props.text().textAlignHorizontal = align;
  if (!start.empty()) t.props.extra["textPathStart"] = extra("textPathStart", start);
  nodes.push_back(t);
  return nodes;
}

geom::Path straight(double length) {
  geom::Path p;
  p.moveTo({0, 0});
  p.lineTo({length, 0});
  return p;
}

}  // namespace

TEST_CASE("r7 text path: on a straight line the glyphs sit as TEXT's do, the baseline on the path") {
  Fonts fonts;
  Editor e;
  e.setSessionID(1);
  e.loadDocument(textPathScene(straight(400), {400, 0}, "Hello"), kNoGuid);
  const text::TextLayout* L = e.textLayout(TP);
  REQUIRE(L);
  REQUIRE(L->path);
  NodeProps plain = textProps("Hello", 20);
  plain.text().textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
  auto T = text::layoutText(plain, text::LayoutOptions{});
  REQUIRE(L->glyphs.size() == T->glyphs.size());
  for (size_t i = 0; i < L->glyphs.size(); i++) {
    CHECK(near(L->glyphs[i].x, T->glyphs[i].x, 1e-3));
    CHECK(near(L->glyphs[i].y, 0, 1e-3));  // BOTTOM: the baseline on the path
    CHECK(near(L->glyphs[i].rotation, 0, 1e-6));
  }
  // Line breaks become spaces; the characters stay.
  e.loadDocument(textPathScene(straight(400), {400, 0}, "Hi\nyou"), kNoGuid);
  L = e.textLayout(TP);
  REQUIRE(L);
  CHECK(L->lines.size() == 1);
  CHECK(L->text.size() == 6);
  // The node's geometry is its placed glyphs (Flatten's input), the path itself is not painted.
  const NodeGeometry* g = e.document().geometry(TP);
  REQUIRE(g);
  REQUIRE(!g->fills.empty());
  CHECK(g->fills[0].path.bounds().y < 0);  // the glyphs stand above the path
}

TEST_CASE("r7 text path: on a circle the glyphs turn with the tangent; start, flip, alignment, overflow") {
  Fonts fonts;
  Editor e;
  e.setSessionID(1);
  geom::Path circle = geom::ellipsePath({200, 200}, ArcData{});
  e.loadDocument(textPathScene(circle, {200, 200}, "ABCDEFGH"), kNoGuid);
  const text::TextLayout* L = e.textLayout(TP);
  REQUIRE(L);
  REQUIRE(L->glyphs.size() == 8);
  for (const text::LaidGlyph& g : L->glyphs) {
    // The glyph's centre on the baseline, and the tangent of the circle there (about its centre (100, 100)).
    double c = std::cos(g.rotation), s = std::sin(g.rotation);
    Vec2 mid{g.x + c * g.advance / 2, g.y + s * g.advance / 2};
    Vec2 radius = mid - Vec2{100, 100};
    CHECK(near(radius.length(), 100, 0.5));
    // The tangent is perpendicular to the radius.
    CHECK(near(c * radius.x + s * radius.y, 0, 0.02 * radius.length()));
  }
  // Rotations change glyph to glyph (the text bends).
  CHECK(!near(L->glyphs.front().rotation, L->glyphs.back().rotation, 0.05));
  double turnL = L->glyphs[1].rotation - L->glyphs[0].rotation;
  // Flip: the text runs the other way round.
  e.loadDocument(textPathScene(circle, {200, 200}, "ABCDEFGH", R"({"tValue": 0, "forward": false})"), kNoGuid);
  const text::TextLayout* F = e.textLayout(TP);
  REQUIRE(F);
  REQUIRE(F->glyphs.size() == 8);
  double turnF = F->glyphs[1].rotation - F->glyphs[0].rotation;
  CHECK(turnL * turnF < 0);
  // Open path, centred on a start halfway: the line's middle at the start point.
  e.loadDocument(textPathScene(straight(400), {400, 0}, "ABCD", R"({"tValue": 0.5, "forward": true})", TextAlignHorizontal::CENTER), kNoGuid);
  const text::TextLayout* C = e.textLayout(TP);
  REQUIRE(C);
  REQUIRE(C->glyphs.size() == 4);
  double left = C->glyphs.front().x, right = C->glyphs.back().x + C->glyphs.back().advance;
  CHECK(near((left + right) / 2, 200, 0.5));
  // RIGHT ends at the start.
  e.loadDocument(textPathScene(straight(400), {400, 0}, "ABCD", R"({"tValue": 0.5, "forward": true})", TextAlignHorizontal::RIGHT), kNoGuid);
  const text::TextLayout* R = e.textLayout(TP);
  REQUIRE(R);
  CHECK(near(R->glyphs.back().x + R->glyphs.back().advance, 200, 0.5));
  // Overflow on an open path: what falls off the end isn't drawn (the characters stay).
  e.loadDocument(textPathScene(straight(60), {60, 0}, "ABCDEFGHIJ"), kNoGuid);
  const text::TextLayout* O = e.textLayout(TP);
  REQUIRE(O);
  CHECK(O->glyphs.size() < 10);
  CHECK(O->glyphs.size() >= 3);
  CHECK(O->text.size() == 10);
  // Backwards from the start of an open path: everything falls off.
  e.loadDocument(textPathScene(straight(60), {60, 0}, "ABC", R"({"tValue": 0, "forward": false})"), kNoGuid);
  CHECK(e.textLayout(TP)->glyphs.empty());
}

TEST_CASE("r7 text path: the start's encoding, projection, the straight → path map; stored rotations") {
  geom::Path two;
  two.moveTo({0, 0});
  two.lineTo({100, 0});
  two.lineTo({100, 100});
  geom::VectorNetwork net = geom::networkFromPath(two, WindingRule::NONZERO);
  VectorData d = vectorOf(two, {100, 100});
  std::vector<Vec2> pts;
  bool closed = true;
  double s = 0;
  int dir = 0;
  REQUIRE(text::textPathContour(net, d, {100, 100}, 1.5, pts, closed, s, dir));
  CHECK_FALSE(closed);
  CHECK(near(s, 150, 1e-6));  // halfway along segment 1
  double t = 0;
  REQUIRE(text::textPathProject(net, d, {100, 100}, {104, 25}, t));
  CHECK(near(t, 1.25, 1e-6));
  REQUIRE(text::textPathProject(net, d, {100, 100}, {40, -3}, t));
  CHECK(near(t, 0.4, 1e-6));
  // Glyph.rotation survives derivedTextData.
  Fonts fonts;
  Editor e;
  e.setSessionID(1);
  e.loadDocument(textPathScene(geom::ellipsePath({200, 200}, ArcData{}), {200, 200}, "Round"), kNoGuid);
  const text::TextLayout* L = e.textLayout(TP);
  REQUIRE(L);
  auto stored = text::storedFromLayout(*L);
  REQUIRE(stored);
  auto back = text::layoutFromStored(stored, e.document().get(TP)->props);
  REQUIRE(back->glyphs.size() == L->glyphs.size());
  for (size_t i = 0; i < L->glyphs.size(); i++) CHECK(near(back->glyphs[i].rotation, L->glyphs[i].rotation, 1e-6));
  // The map: a straight point at the baseline lands on the path.
  Vec2 on = L->path->toNode({L->glyphs[0].x, L->path->baseline});
  (void)on;
  Vec2 mid = L->path->toNode({L->path->lineX + 1, L->path->baseline});
  CHECK(near((mid - Vec2{100, 100}).length(), 100, 0.5));
}

TEST_CASE("r7 text path: hit by its turned glyph boxes; bounds hold the glyphs; SVG and PDF write them placed") {
  Fonts fonts;
  Editor e;
  e.setSessionID(1);
  e.loadDocument(textPathScene(straight(400), {400, 0}, "Hello"), kNoGuid);
  const Document& doc = e.document();
  CHECK(hitsNode(doc, TP, {5, -7}, 0.1, false));      // inside "H", above the path
  CHECK_FALSE(hitsNode(doc, TP, {300, -7}, 0.1, false));  // past the text
  CHECK(hitPath(doc, kPage, {55, 43}, 1) == std::vector<Guid>{TP});
  CHECK(doc.renderBounds(TP).y < 50 - 14);
  exporter::Settings s;
  s.format = exporter::Format::SVG;
  s.svgOutlineText = false;
  exporter::Target t;
  REQUIRE(exporter::resolveTarget(doc, &e, kNoGuid, TP, s, t));
  std::string svg = exporter::writeSvg(doc, &e, t, s);
  INFO(svg);
  CHECK(count(svg, "rotate=\"") == 5);
  CHECK(svg.find("<textPath") == std::string::npos);
  s.svgOutlineText = true;
  svg = exporter::writeSvg(doc, &e, t, s);
  CHECK(svg.find("<path") != std::string::npos);
  CHECK(svg.find("<text") == std::string::npos);
  s.format = exporter::Format::PDF;
  std::string pdf = exporter::writePdf(doc, &e, {t}, s, exporter::Rasterize{});
  CHECK(pdf.rfind("%PDF", 0) == 0);
  // On a circle, the outlined glyphs follow it: their bounds are the ring's, not a line's.
  e.loadDocument(textPathScene(geom::ellipsePath({200, 200}, ArcData{}), {200, 200}, "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJ"), kNoGuid);
  const NodeGeometry* g = e.document().geometry(TP);
  REQUIRE(g);
  Rect gb = g->fills[0].path.bounds();
  CHECK(gb.w > 180);
  CHECK(gb.h > 180);
}

// ---- Pattern strokes (§4.8) ----

TEST_CASE("r7 pattern stroke: the source's tiles drawn through the stroke (it wasn't drawn before)") {
  Editor e;
  e.setSessionID(1);
  auto nodes = baseChanges();
  NodeChange src = make({1, 50}, NodeType::ELLIPSE, kPage, "!", {600, 0, 10, 10}, "Dot");
  nodes.push_back(src);
  NodeChange v = make({1, 51}, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {50, 50, 200, 100}, "Box");
  v.props.fillPaints.clear();
  json::Value pv;
  REQUIRE(json::parse(R"([{"type": "PATTERN", "opacity": 1, "visible": true, "sourceNodeId": {"sessionID": 1, "localID": 50},
    "scalingFactor": 1, "patternSpacing": {"x": 0, "y": 0}}])", pv));
  v.props.strokePaints = codec::readPaints(pv);
  REQUIRE(v.props.strokePaints.size() == 1);
  REQUIRE(v.props.strokePaints[0].type == PaintType::PATTERN);
  v.props.strokeWeight = 8;
  nodes.push_back(v);
  e.loadDocument(nodes, kNoGuid);
  gfx::NullDevice dev;
  Renderer r(dev);
  r.setTextLayouts(&e);
  Frame with = record(r, dev, e.document());
  CHECK(with.composites >= 1);  // the tiles through the stroke's mask
  // Without the pattern stroke: no composite at all.
  NodeChange c = NodeChange::changed({1, 51});
  c.mask = F_STROKES;
  c.props.strokePaints = {};
  e.applyChanges({c}, APPLY_USER);
  Frame without = record(r, dev, e.document());
  CHECK(without.composites < with.composites);
}

TEST_CASE("r7 repeat: nested groups multiply out under the 10 000 cap; an edge hit for the Text on path tool") {
  Editor e;
  e.setSessionID(1);
  auto nodes = baseChanges();
  NodeChange outer = make(TG, NodeType::TRANSFORM, kPage, "!", {0, 0, 2, 2});
  outer.props.extra["transformModifiers"] = extra("transformModifiers", "[" + repeatJson("LINEAR", 200, 0, "Y") + "]");
  nodes.push_back(outer);
  NodeChange inner = make(B2, NodeType::TRANSFORM, TG, "!", {0, 0, 2, 2});
  inner.props.extra["transformModifiers"] = extra("transformModifiers", "[" + repeatJson("LINEAR", 200, 0) + "]");
  nodes.push_back(inner);
  nodes.push_back(make(A, NodeType::ROUNDED_RECTANGLE, B2, "!", {0, 0, 2, 2}));
  e.loadDocument(nodes, kNoGuid);
  gfx::NullDevice dev;
  Renderer r(dev);
  Frame f = record(r, dev, e.document());
  CHECK(f.shapes > 0);
  CHECK(f.shapes <= geom::kMaxRepeatInstances);
  // hitsEdge: near a shape's outline, not inside it.
  Editor s;
  s.setSessionID(1);
  auto sn = baseChanges();
  sn.push_back(make(OTHER, NodeType::ELLIPSE, kPage, "!", {0, 0, 100, 100}));
  s.loadDocument(sn, kNoGuid);
  CHECK(hitsEdge(s.document(), OTHER, {100, 50}, 2));
  CHECK(hitsEdge(s.document(), OTHER, {98.5, 50}, 2));
  CHECK_FALSE(hitsEdge(s.document(), OTHER, {50, 50}, 2));
}
