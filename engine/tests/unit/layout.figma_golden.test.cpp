// docs/engine.md §4.7: Figma's own files carry Figma's layout results. Each
// fixture (engine/tools/fixtures.mjs, from docs/research/figma/samples) is
// loaded, its auto-layout frames and groups are scrambled (flow children moved
// to the origin, hugging axes collapsed, groups' boxes moved off their contents), layout runs
// again, and every node's size and transform must come back to Figma's
// numbers within 0.01.
#include <cmath>
#include <fstream>
#include <sstream>
#include <string>
#include <unordered_map>

#include "doctest.h"
#include "base/Json.h"
#include "layout/Layout.h"
#include "scene/CodecJson.h"

using namespace eng;

namespace {

struct Host : LayoutHost {
  Document doc;
  const Document& document() const override { return doc; }
  void writeGeometry(Guid id, const Mat2x3& transform, Vec2 size) override {
    NodeChange c = NodeChange::changed(id);
    c.mask = F_TRANSFORM | F_SIZE;
    c.props.transform = transform;
    c.props.size = size;
    doc.apply(c);
  }
  bool resizedInTxn(Guid, Vec2&) const override { return false; }
  void base(Guid id, Mat2x3& transform, Vec2& size) const override {
    transform = doc.get(id)->props.transform;
    size = doc.get(id)->props.size;
  }
  bool excludedFromFlow(Guid) const override { return false; }
  bool placedByGesture(Guid) const override { return false; }
  bool ignoreConstraints(Guid) const override { return false; }
};

void set(Document& d, Guid id, const Mat2x3& t, Vec2 s) {
  NodeChange c = NodeChange::changed(id);
  c.mask = F_TRANSFORM | F_SIZE;
  c.props.transform = t;
  c.props.size = s;
  d.apply(c);
}

bool near(double a, double b) { return std::fabs(a - b) <= 0.01; }

// Returns how many laid-out nodes were compared.
int golden(const char* name) {
  std::ifstream in(std::string(ENG_TEST_DATA "/figma/") + name + ".json");
  REQUIRE(in.good());
  std::stringstream text;
  text << in.rdbuf();
  json::Value v;
  REQUIRE(json::parse(text.str(), v));
  Host host;
  for (NodeChange& c : codec::readChanges(*v.get("nodeChanges"))) {
    c.phase = Phase::CREATED;
    c.mask = F_ALL;
    host.doc.apply(c);
  }
  struct Stored {
    Mat2x3 transform;
    Vec2 size;
  };
  std::unordered_map<Guid, Stored, GuidHash> stored;
  std::vector<Guid> roots;
  host.doc.forEach([&](const Node& n) {
    stored[n.guid] = {n.props.transform, n.props.size};
    if (n.props.isAutoLayout() || n.props.isGroupLike()) roots.push_back(n.guid);
  });
  std::sort(roots.begin(), roots.end());
  // Scramble what layout decides.
  Layout probe(host);
  for (Guid id : roots) {
    const NodeProps p = host.doc.get(id)->props;
    if (p.isAutoLayout()) {
      for (Guid c : probe.flowChildren(id)) {
        Mat2x3 t = host.doc.get(c)->props.transform;
        t.m02 = t.m12 = 0;
        set(host.doc, c, t, host.doc.get(c)->props.size);
      }
      bool horizontal = p.stack().stackMode == StackMode::HORIZONTAL;
      Vec2 s = p.size;
      if (p.hugsPrimary()) (horizontal ? s.x : s.y) = 1;
      if (p.hugsCounter()) (horizontal ? s.y : s.x) = 1;
      set(host.doc, id, p.transform, s);
    } else {
      // The group's box moves, its contents stay where they are on the page.
      Mat2x3 g = p.transform;
      Vec2 back = g.applyLinear({7, 5});
      g.m02 -= back.x;
      g.m12 -= back.y;
      set(host.doc, id, g, {1, 1});
      for (Guid c : host.doc.children(id)) {
        Mat2x3 t = host.doc.get(c)->props.transform;
        t.m02 += 7;
        t.m12 += 5;
        set(host.doc, c, t, host.doc.get(c)->props.size);
      }
    }
  }
  Layout(host).run(roots);
  int compared = 0;
  host.doc.forEach([&](const Node& n) {
    const Stored& s = stored[n.guid];
    const NodeProps& p = n.props;
    bool ok = near(p.size.x, s.size.x) && near(p.size.y, s.size.y) && near(p.transform.m02, s.transform.m02) &&
              near(p.transform.m12, s.transform.m12) && near(p.transform.m00, s.transform.m00) && near(p.transform.m11, s.transform.m11);
    INFO(name, ": ", p.name, " (", n.guid.toString(), ") size ", p.size.x, "×", p.size.y, " vs ", s.size.x, "×", s.size.y,
         ", at ", p.transform.m02, ",", p.transform.m12, " vs ", s.transform.m02, ",", s.transform.m12);
    CHECK(ok);
    compared++;
  });
  return compared;
}

}  // namespace

TEST_CASE("layout: Figma golden — stacks_wrap.fig (wrap, vertical, alignment, hug)") { CHECK(golden("stacks_wrap") == 57); }

TEST_CASE("layout: Figma golden — structure.fig (groups fit their children)") { CHECK(golden("structure") == 26); }

TEST_CASE("layout: Figma golden — sections.fig (sections, components, nothing moves)") { CHECK(golden("sections") == 21); }
