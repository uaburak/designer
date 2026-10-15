// Round 17 batch C, the schema round (docs/schema.md §15.2): Figma's override entries keyed by (guidPath,
// overrideLevel 321), the nested swap's override stash (248), gradients blended in their interpolation space (Paint 41
// / 42), and the undo history exported and imported (Message 22 / 23).
#include <cmath>
#include <functional>

#include "doctest.h"
#include "Helpers.h"
#include "base/DerivedIds.h"
#include "editor/Editor.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"

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
