// Libraries (E6, docs/data.md §9, docs/schema.md §8, docs/engine-build.md "E6 libraries"): stable asset keys, publish
// payloads and content hashes, read-only library copies that instances, styles and variables use like local assets,
// updates (one undo step, overrides kept), usage, redirects (Move to this file), removed assets, and the cross-file
// clipboard (R4 §8: published → library copy, unpublished → copied in as this file's own).
#include <algorithm>
#include <cctype>
#include <functional>
#include <map>
#include <set>
#include <unordered_set>
#include <string>

#include "doctest.h"
#include "Helpers.h"
#include "base/DerivedIds.h"
#include "editor/Editor.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

// The library file: a main "Icon" (Glyph), a main "Button" (Background, Label, a nested Icon instance), a hidden
// main "_Private", a frame "Card" with a swatch, and an instance of Button on the page.
const Guid ICON{1, 1}, GLYPH{1, 2}, BUTTON{1, 10}, BG{1, 11}, LABEL{1, 12}, NESTED{1, 13}, PRIVATE{1, 20}, CARD{1, 30},
    SWATCH{1, 31}, IB{1, 40};
// The consumer file: a frame "Screen" with a rectangle.
const Guid SCREEN{1, 1}, RECT{1, 2};

const char* const kLibKey = "LibraryFileKey000001";
const char* const kConsumerKey = "ConsumerFileKey00002";

NodeChange textNode(Guid id, Guid parent, const std::string& position, Rect r, const std::string& chars) {
  NodeChange c = make(id, NodeType::TEXT, parent, position, r, chars);
  c.props.text().textData.characters = chars;
  c.props.text().textAutoResize = TextAutoResize::NONE;
  return c;
}

std::vector<NodeChange> libDoc() {
  auto nodes = baseChanges();
  NodeChange icon = make(ICON, NodeType::SYMBOL, kPage, "!", {0, 0, 24, 24}, "Icon");
  icon.props.fillPaints.clear();
  nodes.push_back(icon);
  nodes.push_back(make(GLYPH, NodeType::ROUNDED_RECTANGLE, ICON, "!", {4, 4, 16, 16}, "Glyph"));
  NodeChange button = make(BUTTON, NodeType::SYMBOL, kPage, "\"", {100, 0, 120, 40}, "Button");
  button.props.fillPaints.clear();
  nodes.push_back(button);
  nodes.push_back(make(BG, NodeType::ROUNDED_RECTANGLE, BUTTON, "!", {0, 0, 120, 40}, "Background"));
  nodes.push_back(textNode(LABEL, BUTTON, "\"", {40, 10, 70, 20}, "Label"));
  NodeChange nested = make(NESTED, NodeType::INSTANCE, BUTTON, "#", {8, 8, 24, 24}, "Icon");
  nested.props.comp().symbolData.symbolID = ICON;
  nested.props.fillPaints.clear();
  nodes.push_back(nested);
  nodes.push_back(make(PRIVATE, NodeType::SYMBOL, kPage, "#", {300, 0, 10, 10}, "_Private"));
  nodes.push_back(make(CARD, NodeType::FRAME, kPage, "$", {0, 200, 200, 200}, "Card"));
  nodes.push_back(make(SWATCH, NodeType::ROUNDED_RECTANGLE, CARD, "!", {10, 10, 50, 50}, "Swatch"));
  NodeChange ib = make(IB, NodeType::INSTANCE, kPage, "%", {100, 100, 120, 40}, "Button");
  ib.props.comp().symbolData.symbolID = BUTTON;
  ib.props.fillPaints.clear();
  nodes.push_back(ib);
  return nodes;
}

std::vector<NodeChange> consumerDoc() {
  auto nodes = baseChanges();
  nodes.push_back(make(SCREEN, NodeType::FRAME, kPage, "!", {0, 0, 400, 400}, "Screen"));
  nodes.push_back(make(RECT, NodeType::ROUNDED_RECTANGLE, SCREEN, "!", {300, 300, 50, 50}, "Rect"));
  return nodes;
}

Editor load(const std::vector<NodeChange>& nodes, const std::string& fileKey) {
  Editor e;
  e.setSessionID(1);  // every file in the same session: GUIDs collide across files on purpose
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kNoGuid);
  e.setFileKey(fileKey);
  e.takeEvents();
  return e;
}

const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }
std::string q(Guid g) { return "\"" + g.toString() + "\""; }
Guid sub(Guid instance, std::vector<Guid> keys) { return derived::intern(instance, keys); }

CommandArgs args(const std::string& jsonText) {
  CommandArgs a;
  REQUIRE(json::parse(jsonText, a.raw));
  return a;
}
Status run(Editor& e, CommandId id, const std::string& json) { return e.command(id, args(json)); }

NodeChange change(FieldMask mask, const std::function<void(NodeProps&)>& f) {
  NodeChange c = NodeChange::changed(Guid{0, 0});
  c.mask = mask;
  f(c.props);
  return c;
}

bool isKey(const std::string& k) {
  return k.size() == 40 && std::all_of(k.begin(), k.end(), [](char c) { return std::isdigit(static_cast<unsigned char>(c)) || (c >= 'a' && c <= 'f'); });
}

// The library's assets made with commands: a collection Theme (Light / Dark) with Brand (red / blue) and Radius (6),
// a colour style Primary taken from Background and bound to Brand, Background's corner radius bound to Radius.
struct Lib {
  Guid set, light, dark, brand, radius, style;
};

Lib makeAssets(Editor& e) {
  Lib l;
  REQUIRE(run(e, CommandId::CREATE_VARIABLE_COLLECTION, R"({"name":"Theme"})") == OK);
  l.set = e.lastCreated()[0];
  l.light = e.lastCreated()[1];
  REQUIRE(run(e, CommandId::RENAME_VARIABLE_MODE, "{\"collection\":" + q(l.set) + ",\"mode\":" + q(l.light) + ",\"name\":\"Light\"}") == OK);
  REQUIRE(run(e, CommandId::ADD_VARIABLE_MODE, "{\"collection\":" + q(l.set) + ",\"name\":\"Dark\"}") == OK);
  l.dark = e.lastCreated()[0];
  REQUIRE(run(e, CommandId::CREATE_VARIABLE, "{\"collection\":" + q(l.set) + R"(,"type":"COLOR","name":"Brand","value":{"r":1,"g":0,"b":0,"a":1}})") == OK);
  l.brand = e.lastCreated()[0];
  REQUIRE(run(e, CommandId::SET_VARIABLE_VALUE, "{\"variable\":" + q(l.brand) + ",\"mode\":" + q(l.dark) + R"(,"value":{"r":0,"g":0,"b":1,"a":1}})") == OK);
  REQUIRE(run(e, CommandId::CREATE_VARIABLE, "{\"collection\":" + q(l.set) + R"(,"type":"FLOAT","name":"Radius","value":6})") == OK);
  l.radius = e.lastCreated()[0];
  REQUIRE(run(e, CommandId::CREATE_STYLE, "{\"type\":\"FILL\",\"name\":\"Primary\",\"from\":" + q(BG) + ",\"apply\":true}") == OK);
  l.style = e.lastCreated()[0];
  REQUIRE(run(e, CommandId::BIND_VARIABLE, "{\"refs\":[" + q(l.style) + "],\"target\":\"fillPaints[0].color\",\"variable\":" + q(l.brand) + "}") == OK);
  REQUIRE(run(e, CommandId::BIND_VARIABLE, "{\"refs\":[" + q(BG) + "],\"target\":\"CORNER_RADIUS\",\"variable\":" + q(l.radius) + "}") == OK);
  e.takeEvents();
  return l;
}

std::string keyOf(const Editor& e, Guid id) { return props(e, id).asset().key; }

// A payload as the store keeps it: through the wire format (JSON) and back.
std::vector<NodeChange> wire(const std::vector<NodeChange>& nodes) {
  json::Writer w;
  codec::writeMessage(w, 0, nodes);
  json::Value v;
  REQUIRE(json::parse(w.take(), v));
  return codec::readMessage(v);
}

// Publishes `keys` from the library: their payloads (through the wire) and, as the store would, publishedVersion.
std::vector<std::vector<NodeChange>> publish(Editor& lib, const std::vector<std::string>& keys,
                                             std::vector<Editor::EncodedAsset>* out = nullptr) {
  std::vector<Editor::EncodedAsset> assets;
  std::vector<ImageHash> images;
  lib.encodeAssets(keys, assets, images);
  std::vector<std::vector<NodeChange>> messages;
  std::vector<Editor::PublishedEntry> published;
  for (auto& a : assets) {
    messages.push_back(wire(a.nodes));
    published.push_back({a.info.key, a.info.versionHash});
  }
  REQUIRE(lib.markPublished(published) == OK);
  if (out) *out = assets;
  return messages;
}

Editor::LibraryOptions opts(const std::string& libraryKey, bool update = false) {
  Editor::LibraryOptions o;
  o.libraryKey = libraryKey;
  o.update = update;
  return o;
}

// The library copy root with this key (kNoGuid: none).
Guid copyOf(const Editor& e, const std::string& key) {
  Guid found = kNoGuid;
  e.document().forEach([&](const Node& n) {
    if (!n.guid.isDerived() && n.props.asset().key == key && !n.props.asset().sourceLibraryKey.empty()) found = n.guid;
  });
  return found;
}

size_t countWhere(const Editor& e, const std::function<bool(const Node&)>& f) {
  size_t n = 0;
  e.document().forEach([&](const Node& node) {
    if (!node.guid.isDerived() && f(node)) n++;
  });
  return n;
}

const Editor::AssetInfo* findAsset(const std::vector<Editor::AssetInfo>& list, Guid id) {
  for (auto& a : list)
    if (a.id == id) return &a;
  return nullptr;
}

bool has(const std::vector<std::string>& list, const std::string& s) { return std::find(list.begin(), list.end(), s) != list.end(); }

Color fillOf(const Editor& e, Guid id) {
  const auto& fills = props(e, id).fillPaints;
  REQUIRE(!fills.empty());
  return fills[0].color;
}

}  // namespace

TEST_CASE("libraries: every asset gets a stable 40-hex key on request; edits, undo and moves keep it; duplicates don't") {
  Editor e = load(libDoc(), kLibKey);
  // Mains imported without keys get them on request — a journaled SYSTEM edit, not an undo step.
  CHECK(keyOf(e, BUTTON).empty());
  CHECK(!e.canUndo());
  auto keys = e.ensureAssetKeys({});
  CHECK(!e.canUndo());
  REQUIRE(keys.size() == 3);  // Icon, Button, _Private
  for (auto& [id, key] : keys) {
    CHECK(isKey(key));
    CHECK(keyOf(e, id) == key);
  }
  auto ev = e.takeEvents();
  REQUIRE(ev.documents.size() == 1);
  CHECK(ev.documents[0].kind == TxnKind::SYSTEM);
  CHECK(ev.documents[0].changes.size() == 3);
  std::string button = keyOf(e, BUTTON);
  CHECK(button != keyOf(e, ICON));
  // Asked again: the same keys, nothing written.
  CHECK(e.ensureAssetKeys({BUTTON})[0].second == button);
  CHECK(e.takeEvents().documents.empty());
  // Styles, collections and variables have one from birth.
  Lib l = makeAssets(e);
  for (Guid g : {l.set, l.brand, l.radius, l.style}) CHECK(isKey(keyOf(e, g)));
  // Rename, move, undo: the key stays.
  REQUIRE(e.setProps({BUTTON}, change(F_NAME, [](NodeProps& p) { p.name = "Button / Primary"; }), 0) == OK);
  REQUIRE(e.setProps({BUTTON}, change(F_TRANSFORM, [](NodeProps& p) { p.transform = Mat2x3::translate(500, 0); }), 0) == OK);
  CHECK(keyOf(e, BUTTON) == button);
  e.command(CommandId::UNDO);
  e.command(CommandId::UNDO);
  CHECK(keyOf(e, BUTTON) == button);
  CHECK(props(e, BUTTON).name == "Button");
  // Duplicates are new assets: Duplicate variable / collection give new keys.
  REQUIRE(run(e, CommandId::DUPLICATE_VARIABLES, "{\"variables\":[" + q(l.brand) + "]}") == OK);
  Guid copy = e.lastCreated()[0];
  CHECK(isKey(keyOf(e, copy)));
  CHECK(keyOf(e, copy) != keyOf(e, l.brand));
  // Combined as variants and the set duplicated: the duplicate set and its variants have no key (one on request).
  e.setSelection({ICON, PRIVATE});
  REQUIRE(e.command(CommandId::COMBINE_AS_VARIANTS) == OK);
  Guid set = e.selection()[0];
  REQUIRE(props(e, set).isComponentSet());
  e.ensureAssetKeys({set});
  REQUIRE(isKey(keyOf(e, set)));
  CHECK(keyOf(e, ICON) == keys[0].second);  // a variant keeps its key
  e.setSelection({set});
  REQUIRE(e.command(CommandId::DUPLICATE) == OK);
  Guid dup = e.selection()[0];
  REQUIRE(dup != set);
  CHECK(props(e, dup).isComponentSet());
  CHECK(keyOf(e, dup).empty());
  for (Guid v : e.document().children(dup)) CHECK(keyOf(e, v).empty());
  e.ensureAssetKeys({dup});
  CHECK(isKey(keyOf(e, dup)));
  CHECK(keyOf(e, dup) != keyOf(e, set));
}

TEST_CASE("libraries: a main cut and pasted in its own file keeps its key; with instances it moves back with its GUID") {
  Editor e = load(libDoc(), kLibKey);
  e.ensureAssetKeys({});
  std::string privateKey = keyOf(e, PRIVATE), button = keyOf(e, BUTTON);
  // No instances: removed by the cut, pasted as a new node with the same key.
  e.setSelection({PRIVATE});
  Clipboard clip;
  REQUIRE(e.copySelection(clip, true));
  CHECK(clip.isCut);
  CHECK(clip.fileKey == kLibKey);
  REQUIRE(e.command(CommandId::DELETE) == OK);
  CHECK(!e.document().has(PRIVATE));
  e.setSelection({});
  REQUIRE(e.paste(clip, true) == 1);
  Guid pasted = e.selection()[0];
  CHECK(props(e, pasted).type == NodeType::SYMBOL);
  CHECK(keyOf(e, pasted) == privateKey);
  // Pasted again: that main is here now — an instance of it (no second main with the key).
  REQUIRE(e.paste(clip, false) == 1);
  CHECK(props(e, e.selection()[0]).type == NodeType::INSTANCE);
  CHECK(props(e, e.selection()[0]).comp().symbolData.symbolID == pasted);
  // With instances: soft-deleted by the cut (its instances keep rendering), moved back by the paste — GUID, key and
  // instances kept.
  e.setSelection({BUTTON});
  REQUIRE(e.copySelection(clip, true));
  REQUIRE(e.command(CommandId::DELETE) == OK);
  REQUIRE(props(e, BUTTON).comp().isSoftDeleted);
  e.setSelection({CARD});
  REQUIRE(e.paste(clip, false) == 1);
  CHECK(e.selection()[0] == BUTTON);
  CHECK(!props(e, BUTTON).comp().isSoftDeleted);
  CHECK(e.document().parentOf(BUTTON) == CARD);
  CHECK(keyOf(e, BUTTON) == button);
  CHECK(props(e, IB).comp().symbolData.symbolID == BUTTON);
  // A copy (not a cut) of a main still pastes as an instance in its own file; nothing else comes in.
  size_t internalBefore = e.document().children(kInternal).size();
  e.setSelection({IB});
  REQUIRE(e.copySelection(clip));
  CHECK(clip.nodes.size() > 1);  // the instance, then Button and what it references
  e.setSelection({});
  REQUIRE(e.paste(clip, false) == 1);
  CHECK(props(e, e.selection()[0]).comp().symbolData.symbolID == BUTTON);
  CHECK(e.document().children(kInternal).size() == internalBefore);
}

TEST_CASE("libraries: localAssets — kinds, hidden assets, dependencies, containing frame, publishedVersion") {
  Editor e = load(libDoc(), kLibKey);
  Lib l = makeAssets(e);
  // Hide when publishing on Icon (it is still shipped as a dependency of Button).
  REQUIRE(e.setProps({ICON}, change(F_IS_PUBLISHABLE, [](NodeProps& p) { p.asset().isPublishable = false; }), 0) == OK);
  // A main inside a frame.
  REQUIRE(e.moveNodes({PRIVATE}, CARD, 1) == 1);
  e.ensureAssetKeys({});
  auto assets = e.localAssets();
  CHECK(assets.size() == 7);  // Icon, Button, _Private, Theme, Brand, Radius, Primary
  const Editor::AssetInfo* b = findAsset(assets, BUTTON);
  REQUIRE(b);
  CHECK(b->kind == Editor::AssetKind::COMPONENT);
  CHECK(!b->hidden);
  CHECK(isKey(b->versionHash));
  const std::string buttonHash = b->versionHash;
  CHECK(b->publishedVersion.empty());
  CHECK(b->pageId == kPage);
  CHECK(b->pageName == "Page 1");
  CHECK(b->frameId == kNoGuid);
  // Button needs Icon (nested instance), Primary (Background's style), Brand (the style's colour), Radius (Background's
  // corner radius) and their collection.
  for (Guid g : {ICON, l.style, l.brand, l.radius, l.set}) CHECK(has(b->dependencies, keyOf(e, g)));
  CHECK(b->dependencies.size() == 5);
  const Editor::AssetInfo* icon = findAsset(assets, ICON);
  REQUIRE(icon);
  CHECK(icon->hidden);
  const Editor::AssetInfo* priv = findAsset(assets, PRIVATE);
  REQUIRE(priv);
  CHECK(priv->hidden);  // a name starting with "_"
  CHECK(priv->frameId == CARD);
  CHECK(priv->frameName == "Card");
  const Editor::AssetInfo* brand = findAsset(assets, l.brand);
  REQUIRE(brand);
  CHECK(brand->kind == Editor::AssetKind::VARIABLE);
  CHECK(brand->hasResolvedType);
  CHECK(brand->resolvedType == VariableResolvedType::COLOR);
  CHECK(brand->owner == l.set);
  CHECK(brand->ownerKey == keyOf(e, l.set));
  CHECK(brand->pageId == kNoGuid);  // on the internal canvas
  CHECK(brand->dependencies == std::vector<std::string>{keyOf(e, l.set)});
  const Editor::AssetInfo* style = findAsset(assets, l.style);
  REQUIRE(style);
  CHECK(style->kind == Editor::AssetKind::STYLE);
  CHECK(style->styleType == StyleType::FILL);
  // Hide from publishing on a variable; a collection whose name starts with "_" hides its variables.
  REQUIRE(run(e, CommandId::SET_VARIABLE_HIDDEN, "{\"variables\":[" + q(l.radius) + "],\"hidden\":true}") == OK);
  CHECK(findAsset(e.localAssets(), l.radius)->hidden);
  REQUIRE(run(e, CommandId::RENAME_VARIABLE_COLLECTION, "{\"collection\":" + q(l.set) + ",\"name\":\"_Theme\"}") == OK);
  assets = e.localAssets();
  CHECK(findAsset(assets, l.set)->hidden);
  CHECK(findAsset(assets, l.brand)->hidden);
  // markPublished: a SYSTEM change, reported by localAssets.
  bool couldUndo = e.canUndo();
  std::string label = e.undoStack().undoLabel();
  REQUIRE(e.markPublished({{keyOf(e, BUTTON), buttonHash}}) == OK);
  CHECK(e.canUndo() == couldUndo);
  CHECK(e.undoStack().undoLabel() == label);
  CHECK(findAsset(e.localAssets(), BUTTON)->publishedVersion == buttonHash);
  // A deleted published main is kept (soft-deleted) while its instance uses it: "Removed" at the next publish.
  e.setSelection({BUTTON});
  REQUIRE(e.command(CommandId::DELETE) == OK);
  assets = e.localAssets();
  const Editor::AssetInfo* gone = findAsset(assets, BUTTON);
  REQUIRE(gone);
  CHECK(gone->softDeleted);
  CHECK(gone->publishedVersion == buttonHash);
}

TEST_CASE("libraries: versionHash changes only when the asset's content changes") {
  Editor e = load(libDoc(), kLibKey);
  Lib l = makeAssets(e);
  // References outside the asset count by the target's key (the publish flow gives every asset one first).
  e.ensureAssetKeys({});
  std::string h0 = e.assetVersionHash(BUTTON);
  CHECK(isKey(h0));
  CHECK(h0 != e.assetVersionHash(ICON));
  // Not content: publishing, where it sits on the page, its order, Hide when publishing.
  REQUIRE(e.markPublished({{keyOf(e, BUTTON), h0}}) == OK);
  REQUIRE(e.setProps({BUTTON}, change(F_TRANSFORM, [](NodeProps& p) { p.transform = Mat2x3::translate(700, 300); }), 0) == OK);
  REQUIRE(e.moveNodes({BUTTON}, CARD, 0) == 1);
  REQUIRE(e.setProps({BUTTON}, change(F_IS_PUBLISHABLE, [](NodeProps& p) { p.asset().isPublishable = false; }), 0) == OK);
  CHECK(e.assetVersionHash(BUTTON) == h0);
  // Content: a sublayer's text, its name.
  REQUIRE(e.setProps({LABEL}, change(F_TEXT_DATA, [](NodeProps& p) { p.text().textData.characters = "Buy"; }), 0) == OK);
  std::string h1 = e.assetVersionHash(BUTTON);
  CHECK(h1 != h0);
  e.command(CommandId::UNDO);
  CHECK(e.assetVersionHash(BUTTON) == h0);
  REQUIRE(e.setProps({BUTTON}, change(F_NAME, [](NodeProps& p) { p.name = "Button 2"; }), 0) == OK);
  CHECK(e.assetVersionHash(BUTTON) != h0);
  e.command(CommandId::UNDO);
  // A variable's value is its content; its collection's hash is the collection's own (modes, name).
  std::string brand0 = e.assetVersionHash(l.brand), set0 = e.assetVersionHash(l.set), radius0 = e.assetVersionHash(l.radius);
  REQUIRE(run(e, CommandId::SET_VARIABLE_VALUE, "{\"variable\":" + q(l.brand) + ",\"mode\":" + q(l.light) + R"(,"value":{"r":0,"g":1,"b":0,"a":1}})") == OK);
  CHECK(e.assetVersionHash(l.brand) != brand0);
  CHECK(e.assetVersionHash(l.set) == set0);
  CHECK(e.assetVersionHash(l.radius) == radius0);
  // Deterministic: the same document loaded elsewhere hashes the same.
  Editor other = load(e.encodeDocument(), kLibKey);
  for (Guid g : {BUTTON, ICON, l.brand, l.set, l.style}) CHECK(other.assetVersionHash(g) == e.assetVersionHash(g));
}

TEST_CASE("libraries: encodeAssets ships each asset with its dependency closure, library GUIDs and versions") {
  Editor e = load(libDoc(), kLibKey);
  Lib l = makeAssets(e);
  // Button's key isn't there yet: encodeAssets is given keys, so ask for them first.
  e.ensureAssetKeys({BUTTON});
  std::string button = keyOf(e, BUTTON);
  std::vector<Editor::EncodedAsset> assets;
  std::vector<ImageHash> images;
  e.encodeAssets({button}, assets, images);
  REQUIRE(assets.size() == 6);  // Button + Icon, Primary, Brand, Theme, Radius
  CHECK(assets[0].info.id == BUTTON);
  CHECK(!assets[0].dependencyOnly);
  std::set<Guid> deps;
  for (size_t i = 1; i < assets.size(); i++) {
    CHECK(assets[i].dependencyOnly);
    CHECK(isKey(assets[i].info.key));  // dependencies get keys too
    deps.insert(assets[i].info.id);
  }
  CHECK(deps == std::set<Guid>{ICON, l.style, l.brand, l.set, l.radius});
  // Button's payload: its nodes, then everything it depends on, with the library's GUIDs.
  std::set<Guid> nodes;
  for (const NodeChange& c : assets[0].nodes) {
    CHECK(c.phase == Phase::CREATED);
    nodes.insert(c.guid);
  }
  CHECK(nodes == std::set<Guid>{BUTTON, BG, LABEL, NESTED, ICON, GLYPH, l.style, l.brand, l.set, l.radius});
  const NodeChange& root = assets[0].nodes[0];
  CHECK(root.guid == BUTTON);
  CHECK(root.props.asset().key == button);
  CHECK(root.props.asset().version == assets[0].info.versionHash);
  CHECK(assets[0].info.versionHash == e.assetVersionHash(BUTTON));
  // References carry the target's key beside its GUID (styles, variables).
  for (const NodeChange& c : assets[0].nodes)
    if (c.guid == BG) {
      CHECK(c.props.refs().styleIdForFill.guid == l.style);
      CHECK(c.props.refs().styleIdForFill.key == keyOf(e, l.style));
    }
  // Brand's payload is itself and its collection.
  for (auto& a : assets)
    if (a.info.id == l.brand) {
      CHECK(a.nodes.size() == 2);
      CHECK(a.info.dependencies == std::vector<std::string>{keyOf(e, l.set)});
    }
  CHECK(images.empty());
  // A variant's key encodes its whole set.
  e.setSelection({ICON, PRIVATE});
  REQUIRE(e.command(CommandId::COMBINE_AS_VARIANTS) == OK);
  Guid set = e.selection()[0];
  e.encodeAssets({keyOf(e, ICON)}, assets, images);
  REQUIRE(!assets.empty());
  CHECK(assets[0].info.id == ICON);
  CHECK(assets[0].info.owner == set);
  CHECK(isKey(assets[0].info.ownerKey));
  CHECK(assets[0].nodes[0].guid == set);
  CHECK(assets[0].nodes.size() == 4);  // the set, Icon, Glyph, _Private
  // Unknown keys: nothing.
  e.encodeAssets({"0000000000000000000000000000000000000000"}, assets, images);
  CHECK(assets.empty());
}

TEST_CASE("libraries: imported library copies are read-only, on the internal canvas, and used like local assets") {
  Editor lib = load(libDoc(), kLibKey);
  Lib l = makeAssets(lib);
  lib.ensureAssetKeys({});
  std::string button = keyOf(lib, BUTTON), style = keyOf(lib, l.style), brand = keyOf(lib, l.brand);
  std::vector<Editor::EncodedAsset> encoded;
  auto messages = publish(lib, {button, style, brand}, &encoded);

  Editor c = load(consumerDoc(), kConsumerKey);
  std::vector<Editor::ImportedAsset> out;
  REQUIRE(c.importLibrary(messages, opts(kLibKey), out) == OK);
  CHECK(!c.canUndo());  // SYSTEM
  auto importEvents = c.takeEvents();
  REQUIRE(importEvents.documents.size() == 1);
  CHECK(importEvents.documents[0].kind == TxnKind::SYSTEM);
  CHECK(!importEvents.collections.empty());  // VARIABLES_CHANGED, STYLES_CHANGED: the panels refresh
  CHECK(!importEvents.variables.empty());
  CHECK(!importEvents.styles.empty());
  Guid copy = copyOf(c, button);
  REQUIRE(copy != kNoGuid);
  // Fresh GUIDs on the internal canvas, marked with where they came from.
  CHECK(copy != BUTTON);
  CHECK(c.document().parentOf(copy) == kInternal);
  const NodeProps& cp = props(c, copy);
  CHECK(cp.type == NodeType::SYMBOL);
  CHECK(cp.asset().sourceLibraryKey == kLibKey);
  CHECK(cp.asset().publishID == BUTTON);
  CHECK(cp.asset().version == encoded[0].info.versionHash);
  CHECK(cp.overrideKey == BUTTON);
  auto kids = c.document().children(copy);
  REQUIRE(kids.size() == 3);
  CHECK(props(c, kids[0]).overrideKey == BG);
  CHECK(props(c, kids[1]).overrideKey == LABEL);
  CHECK(props(c, kids[2]).overrideKey == NESTED);
  // Its dependencies came too, each its own copy: Icon (the nested instance points at its copy), Primary, Brand, Theme, Radius.
  Guid iconCopy = copyOf(c, keyOf(lib, ICON)), styleCopy = copyOf(c, style), brandCopy = copyOf(c, brand);
  Guid setCopy = copyOf(c, keyOf(lib, l.set)), radiusCopy = copyOf(c, keyOf(lib, l.radius));
  REQUIRE(iconCopy != kNoGuid);
  REQUIRE(styleCopy != kNoGuid);
  REQUIRE(brandCopy != kNoGuid);
  REQUIRE(setCopy != kNoGuid);
  REQUIRE(radiusCopy != kNoGuid);
  CHECK(props(c, kids[2]).comp().symbolData.symbolID == iconCopy);
  CHECK(c.findStyle(props(c, kids[0]).refs().styleIdForFill) == styleCopy);
  CHECK(c.findCollection(props(c, brandCopy).asset().variableSetID) == setCopy);
  CHECK(out.size() == 6);
  for (auto& a : out) {
    CHECK(a.created);
    CHECK(a.libraryKey == kLibKey);
  }
  CHECK(c.isLibraryCopy(copy));
  CHECK(c.isLibraryCopy(kids[1]));
  CHECK(!c.isLibraryCopy(RECT));
  CHECK(c.libraryRootOf(kids[1]) == copy);
  // Not this file's own: lists of local assets leave them out unless asked.
  CHECK(c.collections().empty());
  CHECK(c.collections(true) == std::vector<Guid>{setCopy});
  CHECK(c.stylesOf(StyleType::NONE).empty());
  CHECK(c.stylesOf(StyleType::NONE, true) == std::vector<Guid>{styleCopy});
  CHECK(c.localAssets().empty());
  // Imported again: reused, nothing written.
  c.takeEvents();
  REQUIRE(c.importLibrary(messages, opts(kLibKey), out) == OK);
  CHECK(c.takeEvents().documents.empty());
  CHECK(copyOf(c, button) == copy);
  for (auto& a : out) CHECK(!a.created);

  // An instance of the copy: everything resolves through the copies (style → variable → value; radius variable).
  REQUIRE(run(c, CommandId::INSERT_INSTANCE, "{\"main\":" + q(copy) + ",\"x\":100,\"y\":100}") == OK);
  Guid inst = c.selection()[0];
  CHECK(props(c, inst).comp().symbolData.symbolID == copy);
  CHECK(c.document().pageOf(inst) == kPage);
  Guid bg = sub(inst, {BG}), label = sub(inst, {LABEL}), icon = sub(inst, {NESTED});
  REQUIRE(c.document().has(bg));
  CHECK(fillOf(c, bg) == Color{1, 0, 0, 1});
  CHECK(props(c, bg).cornerRadii[0] == 6);
  CHECK(props(c, label).text().textData.characters == "Label");
  CHECK(c.document().children(icon).size() == 1);
  ComponentInfo info;
  REQUIRE(c.componentInfo(inst, info));
  CHECK(info.mainRemote);
  CHECK(info.mainLibraryKey == kLibKey);
  CHECK(info.mainKey == button);
  CHECK(info.mainVersion == cp.asset().version);
  CHECK(!info.mainCopied);
  CHECK(!info.canPush);
  c.setSelection({inst});
  CHECK(c.commandState(CommandId::GO_TO_MAIN_COMPONENT) == 0);
  // Overrides on the instance work as for local mains.
  REQUIRE(c.setProps({label}, change(F_TEXT_DATA, [](NodeProps& p) { p.text().textData.characters = "Buy"; }), 0) == OK);
  CHECK(props(c, label).text().textData.characters == "Buy");
  // A remote mode on the frame: the instance resolves Dark.
  REQUIRE(c.moveNodes({inst}, SCREEN, 0) == 1);
  REQUIRE(run(c, CommandId::SET_VARIABLE_MODE, "{\"refs\":[" + q(SCREEN) + "],\"collection\":" + q(setCopy) + ",\"mode\":" + q(l.dark) + "}") == OK);
  CHECK(fillOf(c, bg) == Color{0, 0, 1, 1});
  // Remote styles and variables apply and bind like local ones.
  REQUIRE(run(c, CommandId::APPLY_STYLE, "{\"refs\":[" + q(RECT) + "],\"style\":" + q(styleCopy) + "}") == OK);
  CHECK(fillOf(c, RECT) == Color{0, 0, 1, 1});  // in the Dark frame
  REQUIRE(run(c, CommandId::BIND_VARIABLE, "{\"refs\":[" + q(RECT) + "],\"target\":\"CORNER_RADIUS\",\"variable\":" + q(radiusCopy) + "}") == OK);
  CHECK(props(c, RECT).cornerRadii[0] == 6);
  CHECK(c.styleUsage(styleCopy) == 1);

  // Read-only: nothing in a copy is changed by the generic setter, commands or structural edits.
  c.takeEvents();
  CHECK(c.setProps({copy}, change(F_NAME, [](NodeProps& p) { p.name = "Mine"; }), 0) == E_READONLY);
  CHECK(c.setProps({kids[1]}, change(F_TEXT_DATA, [](NodeProps& p) { p.text().textData.characters = "X"; }), 0) == E_READONLY);
  CHECK(c.setProps({styleCopy}, change(F_NAME, [](NodeProps& p) { p.name = "Mine"; }), 0) == E_READONLY);
  CHECK(run(c, CommandId::RENAME_VARIABLE, "{\"variable\":" + q(brandCopy) + ",\"name\":\"Mine\"}") == E_READONLY);
  CHECK(run(c, CommandId::SET_VARIABLE_VALUE, "{\"variable\":" + q(brandCopy) + R"(,"value":{"r":0,"g":1,"b":0,"a":1}})") == E_READONLY);
  CHECK(run(c, CommandId::DELETE_VARIABLES, "{\"variables\":[" + q(brandCopy) + "]}") == E_READONLY);
  CHECK(run(c, CommandId::ADD_VARIABLE_MODE, "{\"collection\":" + q(setCopy) + "}") == E_READONLY);
  CHECK(run(c, CommandId::CREATE_VARIABLE, "{\"collection\":" + q(setCopy) + ",\"type\":\"FLOAT\"}") == E_READONLY);
  CHECK(run(c, CommandId::DELETE_STYLE, "{\"style\":" + q(styleCopy) + "}") == E_READONLY);
  CHECK(run(c, CommandId::INSERT_INSTANCE, "{\"main\":" + q(iconCopy) + ",\"parent\":" + q(copy) + "}") == E_READONLY);
  CHECK(c.moveNodes({RECT}, copy, 0) == 0);
  c.applyChanges({NodeChange::removed(kids[0])}, APPLY_USER);
  CHECK(c.document().has(kids[0]));
  CHECK(props(c, copy).name == "Button");
  CHECK(props(c, brandCopy).name == "Brand");
  for (auto& d : c.takeEvents().documents) CHECK(d.changes.empty());
  // They round-trip through the document (encodeDocument → load).
  Editor again = load(c.encodeDocument(), kConsumerKey);
  CHECK(again.isLibraryCopy(copy));
  CHECK(again.setProps({copy}, change(F_NAME, [](NodeProps& p) { p.name = "Mine"; }), 0) == E_READONLY);
  CHECK(fillOf(again, bg) == Color{0, 0, 1, 1});
}

TEST_CASE("libraries: applyLibraryUpdate rewrites copies in place as one undo step; instances keep their overrides") {
  Editor lib = load(libDoc(), kLibKey);
  Lib l = makeAssets(lib);
  lib.ensureAssetKeys({});
  std::string button = keyOf(lib, BUTTON), brand = keyOf(lib, l.brand);
  std::vector<Editor::EncodedAsset> v1;
  auto messages = publish(lib, {button}, &v1);

  Editor c = load(consumerDoc(), kConsumerKey);
  std::vector<Editor::ImportedAsset> out;
  REQUIRE(c.importLibrary(messages, opts(kLibKey), out) == OK);
  Guid copy = copyOf(c, button), brandCopy = copyOf(c, brand);
  auto kidsBefore = c.document().children(copy);
  REQUIRE(run(c, CommandId::INSERT_INSTANCE, "{\"main\":" + q(copy) + ",\"x\":100,\"y\":100}") == OK);
  Guid inst = c.selection()[0];
  Guid bg = sub(inst, {BG}), label = sub(inst, {LABEL});
  REQUIRE(c.setProps({label}, change(F_TEXT_DATA, [](NodeProps& p) { p.text().textData.characters = "Buy"; }), 0) == OK);
  REQUIRE(run(c, CommandId::BIND_VARIABLE, "{\"refs\":[" + q(RECT) + "],\"target\":\"fillPaints[0].color\",\"variable\":" + q(brandCopy) + "}") == OK);
  CHECK(fillOf(c, RECT) == Color{1, 0, 0, 1});

  // The library changes: Background's opacity, Label's text, a new Badge layer, Brand's Light value; Glyph is removed.
  REQUIRE(lib.setProps({BG}, change(F_OPACITY, [](NodeProps& p) { p.opacity = 0.5f; }), 0) == OK);
  REQUIRE(lib.setProps({LABEL}, change(F_TEXT_DATA, [](NodeProps& p) { p.text().textData.characters = "Label v2"; }), 0) == OK);
  const Guid BADGE{1, 50};
  REQUIRE(lib.applyChanges({make(BADGE, NodeType::ELLIPSE, BUTTON, "$", {110, 0, 10, 10}, "Badge")}, APPLY_USER) == OK);
  REQUIRE(run(lib, CommandId::SET_VARIABLE_VALUE, "{\"variable\":" + q(l.brand) + ",\"mode\":" + q(l.light) + R"(,"value":{"r":0,"g":1,"b":0,"a":1}})") == OK);
  REQUIRE(run(lib, CommandId::SET_VARIABLE_VALUE, "{\"variable\":" + q(l.radius) + ",\"value\":8}") == OK);
  lib.setSelection({GLYPH});
  REQUIRE(lib.command(CommandId::DELETE) == OK);
  std::vector<Editor::EncodedAsset> v2;
  auto messages2 = publish(lib, {button}, &v2);
  CHECK(v2[0].info.versionHash != v1[0].info.versionHash);

  // Import (not update) never replaces a copy.
  REQUIRE(c.importLibrary(messages2, opts(kLibKey), out) == OK);
  CHECK(props(c, copy).asset().version == v1[0].info.versionHash);

  // The update: one undo step; same GUIDs; the instance shows the new content and keeps "Buy".
  c.takeEvents();
  REQUIRE(c.importLibrary(messages2, opts(kLibKey, true), out) == OK);
  auto ev = c.takeEvents();
  REQUIRE(ev.documents.size() == 1);
  CHECK(ev.documents[0].kind == TxnKind::USER);
  CHECK(c.undoStack().undoLabel() == "Update library assets");
  CHECK(copyOf(c, button) == copy);
  CHECK(props(c, copy).asset().version == v2[0].info.versionHash);
  auto kidsAfter = c.document().children(copy);
  REQUIRE(kidsAfter.size() == 4);
  for (size_t i = 0; i < 3; i++) CHECK(kidsAfter[i] == kidsBefore[i]);
  CHECK(props(c, kidsAfter[3]).overrideKey == BADGE);
  CHECK(props(c, bg).opacity == doctest::Approx(0.5));
  CHECK(props(c, label).text().textData.characters == "Buy");
  CHECK(c.document().has(sub(inst, {BADGE})));
  CHECK(fillOf(c, bg) == Color{0, 1, 0, 1});      // Brand's new value through the style copy
  CHECK(fillOf(c, RECT) == Color{0, 1, 0, 1});    // and on a layer bound to the remote variable
  CHECK(props(c, bg).cornerRadii[0] == 8);
  // The copies' own bindings survive the rewrite (their values changed with the payload, not by an edit).
  Guid styleCopy = copyOf(c, keyOf(lib, l.style));
  CHECK(props(c, styleCopy).fillPaints[0].colorVar->kind == VariableData::Kind::ALIAS);
  CHECK(props(c, kidsAfter[0]).parameterConsumptionMap.size() == 1);
  CHECK(props(c, inst).comp().symbolData.overrides.size() == 1);  // only the label's text
  REQUIRE(run(c, CommandId::SET_VARIABLE_MODE, "{\"refs\":[" + q(inst) + "],\"collection\":" + q(copyOf(c, keyOf(lib, l.set))) + ",\"mode\":" + q(l.dark) + "}") == OK);
  CHECK(fillOf(c, bg) == Color{0, 0, 1, 1});
  c.command(CommandId::UNDO);
  CHECK(copyOf(c, brand) == brandCopy);
  Guid iconCopy = copyOf(c, keyOf(lib, ICON));
  CHECK(c.document().children(iconCopy).empty());  // Glyph removed
  bool updatedButton = false;
  for (auto& a : out)
    if (a.key == button) updatedButton = a.updated;
  CHECK(updatedButton);
  // Undo puts the old copies (and what they derive) back; redo the new ones.
  REQUIRE(c.command(CommandId::UNDO) == OK);
  CHECK(props(c, copy).asset().version == v1[0].info.versionHash);
  CHECK(c.document().children(copy).size() == 3);
  CHECK(props(c, bg).opacity == doctest::Approx(1));
  CHECK(fillOf(c, bg) == Color{1, 0, 0, 1});
  CHECK(props(c, label).text().textData.characters == "Buy");
  CHECK(c.document().children(iconCopy).size() == 1);
  REQUIRE(c.command(CommandId::REDO) == OK);
  CHECK(props(c, copy).asset().version == v2[0].info.versionHash);
  CHECK(fillOf(c, bg) == Color{0, 1, 0, 1});
  // Same version again: nothing to do.
  c.takeEvents();
  REQUIRE(c.importLibrary(messages2, opts(kLibKey, true), out) == OK);
  CHECK(c.takeEvents().documents.empty());

  // libraryUsage: every copy, its version and how many layers use it.
  auto usage = c.libraryUsage();
  CHECK(usage.size() == 6);
  for (auto& u : usage) {
    CHECK(u.libraryKey == kLibKey);
    if (u.key == button) {
      CHECK(u.usage == 1);
      CHECK(u.version == v2[0].info.versionHash);
      CHECK(u.publishID == BUTTON);
    }
    if (u.key == brand) CHECK(u.usage == 1);  // the rectangle (the style copy's own binding doesn't count)
    if (u.key == keyOf(lib, ICON)) CHECK(u.usage == 0);
  }
}

TEST_CASE("libraries: an update limited to some keys; a removed asset's copy stays and keeps rendering") {
  Editor lib = load(libDoc(), kLibKey);
  Lib l = makeAssets(lib);
  lib.ensureAssetKeys({});
  std::string button = keyOf(lib, BUTTON), icon = keyOf(lib, ICON);
  auto messages = publish(lib, {button});
  Editor c = load(consumerDoc(), kConsumerKey);
  std::vector<Editor::ImportedAsset> out;
  REQUIRE(c.importLibrary(messages, opts(kLibKey), out) == OK);
  Guid copy = copyOf(c, button), iconCopy = copyOf(c, icon);
  REQUIRE(run(c, CommandId::INSERT_INSTANCE, "{\"main\":" + q(copy) + "}") == OK);
  Guid inst = c.selection()[0];
  std::string iconV1 = props(c, iconCopy).asset().version, buttonV1 = props(c, copy).asset().version;
  // Both change in the library; the consumer accepts only Icon's update.
  REQUIRE(lib.setProps({GLYPH}, change(F_OPACITY, [](NodeProps& p) { p.opacity = 0.25f; }), 0) == OK);
  REQUIRE(lib.setProps({LABEL}, change(F_TEXT_DATA, [](NodeProps& p) { p.text().textData.characters = "v2"; }), 0) == OK);
  auto messages2 = publish(lib, {button});
  Editor::LibraryOptions o = opts(kLibKey, true);
  o.hasKeys = true;
  o.keys = {icon};
  REQUIRE(c.importLibrary(messages2, o, out) == OK);
  CHECK(props(c, iconCopy).asset().version != iconV1);
  CHECK(props(c, copy).asset().version == buttonV1);
  CHECK(props(c, sub(inst, {LABEL})).text().textData.characters == "Label");
  CHECK(props(c, sub(inst, {NESTED, GLYPH})).opacity == doctest::Approx(0.25));
  // Button removed from the library (deleted, published): the consumer's copy stays and its instance renders.
  lib.setSelection({BUTTON});
  REQUIRE(lib.command(CommandId::DELETE) == OK);
  REQUIRE(c.importLibrary({}, opts(kLibKey, true), out) == OK);
  CHECK(c.document().has(copy));
  CHECK(c.document().has(sub(inst, {BG})));
  ComponentInfo info;
  REQUIRE(c.componentInfo(inst, info));
  CHECK(info.mainRemote);
  CHECK(!info.mainSoftDeleted);
  // Restore component: the copy becomes this file's own main, on the page; the instance stays linked. One undo step.
  REQUIRE(run(c, CommandId::RESTORE_COMPONENT, "{\"ref\":" + q(inst) + "}") == OK);
  CHECK(c.document().pageOf(copy) == kPage);
  CHECK(c.selection() == std::vector<Guid>{copy});
  CHECK(props(c, copy).asset().sourceLibraryKey.empty());
  CHECK(props(c, copy).asset().key.empty());
  CHECK(!c.isLibraryCopy(copy));
  CHECK(props(c, inst).comp().symbolData.symbolID == copy);
  REQUIRE(c.componentInfo(inst, info));
  CHECK(!info.mainRemote);
  CHECK(info.canPush == false);  // no changes to push
  CHECK(c.setProps({copy}, change(F_NAME, [](NodeProps& p) { p.name = "Mine"; }), 0) == OK);
  c.command(CommandId::UNDO);
  CHECK(c.isLibraryCopy(iconCopy));  // its nested Icon is still the library's
  CHECK(c.undoStack().undoLabel() == "Restore component");
  REQUIRE(c.command(CommandId::UNDO) == OK);
  CHECK(c.isLibraryCopy(copy));
  CHECK(c.document().pageOf(copy) == kInternal);
  // The generic path takes it too: a copy's root whose sourceLibraryKey is cleared (nothing else in a copy is written).
  NodeChange local = NodeChange::changed(copy);
  local.mask = F_SOURCE_LIBRARY_KEY | F_PARENT_INDEX;
  local.props.parentIndex = {kPage, "~"};
  REQUIRE(c.applyChanges({local}, APPLY_USER) == OK);
  CHECK(!c.isLibraryCopy(copy));
  CHECK(c.document().pageOf(copy) == kPage);
}

TEST_CASE("libraries: Move to this file — a redirect re-points a copy at the new library and key; instances stay linked") {
  Editor lib = load(libDoc(), kLibKey);
  makeAssets(lib);
  lib.ensureAssetKeys({});
  std::string oldKey = keyOf(lib, BUTTON);
  auto messages = publish(lib, {oldKey});
  Editor c = load(consumerDoc(), kConsumerKey);
  std::vector<Editor::ImportedAsset> out;
  REQUIRE(c.importLibrary(messages, opts(kLibKey), out) == OK);
  Guid copy = copyOf(c, oldKey);
  REQUIRE(run(c, CommandId::INSERT_INSTANCE, "{\"main\":" + q(copy) + "}") == OK);
  Guid inst = c.selection()[0];
  REQUIRE(c.setProps({sub(inst, {LABEL})}, change(F_TEXT_DATA, [](NodeProps& p) { p.text().textData.characters = "Buy"; }), 0) == OK);

  // Button is cut from the library and pasted into another file, which publishes it with a new key.
  const char* newLibKey = "NewLibraryFileKey003";
  lib.setSelection({BUTTON});
  Clipboard clip;
  REQUIRE(lib.copySelection(clip, true));
  REQUIRE(lib.command(CommandId::DELETE) == OK);
  Editor moved = load(consumerDoc(), newLibKey);
  moved.setSelection({});
  REQUIRE(moved.paste(clip, true) == 1);
  Guid main = moved.selection()[0];
  REQUIRE(props(moved, main).type == NodeType::SYMBOL);
  CHECK(props(moved, main).asset().key.empty());
  CHECK(props(moved, main).asset().libraryMoveInfo.oldKey == oldKey);
  CHECK(props(moved, main).asset().libraryMoveInfo.pasteFileKey == kLibKey);
  moved.ensureAssetKeys({main});
  std::string newKey = keyOf(moved, main);
  CHECK(newKey != oldKey);
  auto movedMessages = publish(moved, {newKey});

  // The consumer accepts the move: the same copy (GUID) now comes from the new library under the new key.
  Editor::LibraryOptions o = opts(newLibKey, true);
  o.redirects = {{oldKey, newKey}};
  REQUIRE(c.importLibrary(movedMessages, o, out) == OK);
  CHECK(copyOf(c, newKey) == copy);
  CHECK(copyOf(c, oldKey) == kNoGuid);
  CHECK(props(c, copy).asset().sourceLibraryKey == newLibKey);
  CHECK(props(c, copy).asset().publishID == main);
  CHECK(props(c, inst).comp().symbolData.symbolID == copy);
  CHECK(props(c, sub(inst, {LABEL})).text().textData.characters == "Buy");
  CHECK(c.undoStack().undoLabel() == "Update library assets");
}

TEST_CASE("libraries: Move to this file, into a file that used the copy — its instances are relinked to the local main") {
  Editor lib = load(libDoc(), kLibKey);
  makeAssets(lib);
  lib.ensureAssetKeys({});
  std::string oldKey = keyOf(lib, BUTTON);
  auto messages = publish(lib, {oldKey});
  Editor c = load(consumerDoc(), kConsumerKey);
  std::vector<Editor::ImportedAsset> out;
  REQUIRE(c.importLibrary(messages, opts(kLibKey), out) == OK);
  Guid copy = copyOf(c, oldKey);
  REQUIRE(run(c, CommandId::INSERT_INSTANCE, "{\"main\":" + q(copy) + "}") == OK);
  Guid inst = c.selection()[0];
  REQUIRE(c.setProps({sub(inst, {LABEL})}, change(F_TEXT_DATA, [](NodeProps& p) { p.text().textData.characters = "Buy"; }), 0) == OK);
  // Button is cut from the library and pasted here: a local main (its dependencies stay library copies).
  lib.setSelection({BUTTON});
  Clipboard clip;
  REQUIRE(lib.copySelection(clip, true));
  c.setSelection({});
  REQUIRE(c.paste(clip, true) == 1);
  Guid main = c.selection()[0];
  REQUIRE(props(c, main).asset().libraryMoveInfo.oldKey == oldKey);
  CHECK(c.isLibraryCopy(props(c, c.document().children(main)[2]).comp().symbolData.symbolID));  // Icon: still the library's
  c.ensureAssetKeys({main});
  std::string newKey = keyOf(c, main);
  // This file publishes it with Move to this file, then accepts its own redirect.
  Editor::LibraryOptions o = opts(kConsumerKey, true);
  o.redirects = {{oldKey, newKey}};
  REQUIRE(c.importLibrary({}, o, out) == OK);
  CHECK(props(c, inst).comp().symbolData.symbolID == main);
  CHECK(props(c, sub(inst, {LABEL})).text().textData.characters == "Buy");
  CHECK(!c.document().has(copy));
  CHECK(copyOf(c, oldKey) == kNoGuid);
  CHECK(c.undoStack().undoLabel() == "Update library assets");
  REQUIRE(c.command(CommandId::UNDO) == OK);
  CHECK(props(c, inst).comp().symbolData.symbolID == copy);
  CHECK(props(c, sub(inst, {LABEL})).text().textData.characters == "Buy");
}

TEST_CASE("libraries: cross-file paste — published assets become library copies, unpublished ones are copied in") {
  Editor lib = load(libDoc(), kLibKey);
  Lib l = makeAssets(lib);
  lib.ensureAssetKeys({});
  std::string button = keyOf(lib, BUTTON);

  SUBCASE("an instance of an unpublished main: the main is copied in as a local component, once") {
    lib.setSelection({IB});
    Clipboard clip;
    REQUIRE(lib.copySelection(clip));
    Editor c = load(consumerDoc(), kConsumerKey);
    c.setSelection({});
    REQUIRE(c.paste(clip, true) == 1);
    Guid inst = c.selection()[0];
    REQUIRE(props(c, inst).type == NodeType::INSTANCE);
    Guid main = props(c, inst).comp().symbolData.symbolID;
    REQUIRE(c.document().has(main));
    CHECK(main != BUTTON);
    CHECK(c.document().pageOf(main) == kInternal);
    CHECK(!c.isLibraryCopy(main));
    CHECK(c.isCopiedMain(main));
    CHECK(props(c, main).asset().key.empty());
    ComponentInfo info;
    REQUIRE(c.componentInfo(inst, info));
    CHECK(info.mainCopied);
    CHECK(!info.mainRemote);
    CHECK(!info.canPush);
    // Its style and variables came in as this file's own (new keys).
    auto styles = c.stylesOf(StyleType::NONE);
    REQUIRE(styles.size() == 1);
    CHECK(props(c, styles[0]).name == "Primary");
    CHECK(isKey(props(c, styles[0]).asset().key));
    CHECK(props(c, styles[0]).asset().key != keyOf(lib, l.style));
    CHECK(c.collections().size() == 1);
    CHECK(fillOf(c, sub(inst, {BG})) == Color{1, 0, 0, 1});
    CHECK(props(c, sub(inst, {BG})).cornerRadii[0] == 6);
    // It is this file's own: editable (not read-only).
    CHECK(c.setProps({main}, change(F_NAME, [](NodeProps& p) { p.name = "Button (copy)"; }), 0) == OK);
    c.command(CommandId::UNDO);
    // Pasted again: the same main, style and collection.
    size_t symbols = countWhere(c, [](const Node& n) { return n.props.type == NodeType::SYMBOL; });
    REQUIRE(c.paste(clip, false) == 1);
    CHECK(props(c, c.selection()[0]).comp().symbolData.symbolID == main);
    CHECK(countWhere(c, [](const Node& n) { return n.props.type == NodeType::SYMBOL; }) == symbols);
    CHECK(c.stylesOf(StyleType::NONE).size() == 1);
    CHECK(c.collections().size() == 1);
    // Undo removes the paste (the first paste's copies stay with it).
    c.command(CommandId::UNDO);
    CHECK(c.document().has(main));
    c.command(CommandId::UNDO);
    CHECK(!c.document().has(main));
    CHECK(c.stylesOf(StyleType::NONE).empty());
  }

  SUBCASE("an instance of a published main: an instance of a library copy") {
    publish(lib, {button});
    lib.setSelection({IB});
    Clipboard clip;
    REQUIRE(lib.copySelection(clip));
    Editor c = load(consumerDoc(), kConsumerKey);
    c.setSelection({});
    REQUIRE(c.paste(clip, true) == 1);
    Guid inst = c.selection()[0];
    Guid copy = copyOf(c, button);
    REQUIRE(copy != kNoGuid);
    CHECK(props(c, inst).comp().symbolData.symbolID == copy);
    CHECK(props(c, copy).asset().sourceLibraryKey == kLibKey);
    CHECK(props(c, copy).asset().version == props(lib, BUTTON).asset().publishedVersion);
    CHECK(props(c, copy).asset().publishID == BUTTON);
    // Its published dependencies are library copies too; nothing local came in.
    CHECK(c.stylesOf(StyleType::NONE).empty());
    CHECK(c.stylesOf(StyleType::NONE, true).size() == 1);
    CHECK(c.collections().empty());
    CHECK(fillOf(c, sub(inst, {BG})) == Color{1, 0, 0, 1});
    auto usage = c.libraryUsage();
    bool found = false;
    for (auto& u : usage)
      if (u.key == button) {
        found = true;
        CHECK(u.usage == 1);
      }
    CHECK(found);
    // Pasted again: the same copy.
    REQUIRE(c.paste(clip, false) == 1);
    CHECK(props(c, c.selection()[0]).comp().symbolData.symbolID == copy);
    CHECK(countWhere(c, [&](const Node& n) { return n.props.asset().key == button; }) == 1);
    // From this file into a third: still the library's copy (sourceLibraryKey kept, not this file).
    c.setSelection({inst});
    Clipboard clip2;
    REQUIRE(c.copySelection(clip2));
    CHECK(clip2.fileKey == kConsumerKey);
    Editor d = load(consumerDoc(), "ThirdFileKey00000004");
    REQUIRE(d.paste(clip2, true) == 1);
    Guid dcopy = copyOf(d, button);
    REQUIRE(dcopy != kNoGuid);
    CHECK(props(d, dcopy).asset().sourceLibraryKey == kLibKey);
    CHECK(props(d, d.selection()[0]).comp().symbolData.symbolID == dcopy);
    // And back into the library itself: an instance of its own main.
    lib.setSelection({});
    REQUIRE(lib.paste(clip2, true) == 1);
    CHECK(props(lib, lib.selection()[0]).comp().symbolData.symbolID == BUTTON);
    CHECK(copyOf(lib, button) == kNoGuid);
  }

  SUBCASE("a published main itself: an instance of its copy; cut: a new main marked for Move to this file") {
    publish(lib, {button});
    lib.setSelection({BUTTON});
    Clipboard clip;
    REQUIRE(lib.copySelection(clip));
    Editor c = load(consumerDoc(), kConsumerKey);
    c.setSelection({});
    REQUIRE(c.paste(clip, true) == 1);
    Guid inst = c.selection()[0];
    CHECK(props(c, inst).type == NodeType::INSTANCE);
    CHECK(props(c, inst).comp().symbolData.symbolID == copyOf(c, button));
    // Cut: a new main with no key, remembering the old one.
    REQUIRE(lib.copySelection(clip, true));
    Editor m = load(consumerDoc(), kConsumerKey);
    m.setSelection({});
    REQUIRE(m.paste(clip, true) == 1);
    Guid main = m.selection()[0];
    CHECK(props(m, main).type == NodeType::SYMBOL);
    CHECK(m.document().pageOf(main) == kPage);
    CHECK(props(m, main).asset().key.empty());
    CHECK(props(m, main).asset().publishedVersion.empty());
    CHECK(props(m, main).asset().libraryMoveInfo.oldKey == button);
    CHECK(props(m, main).asset().libraryMoveInfo.pasteFileKey == kLibKey);
    CHECK(m.document().children(main).size() == 3);
    // Its nested Icon instance points at a copy of Icon (published with Button as its dependency).
    Guid nested = m.document().children(main)[2];
    Guid iconMain = props(m, nested).comp().symbolData.symbolID;
    REQUIRE(m.document().has(iconMain));
    CHECK(m.isLibraryCopy(iconMain));
  }

  SUBCASE("an unpublished main itself: a new main") {
    lib.setSelection({BUTTON});
    Clipboard clip;
    REQUIRE(lib.copySelection(clip));
    Editor c = load(consumerDoc(), kConsumerKey);
    c.setSelection({});
    REQUIRE(c.paste(clip, true) == 1);
    Guid main = c.selection()[0];
    CHECK(props(c, main).type == NodeType::SYMBOL);
    CHECK(c.document().pageOf(main) == kPage);
    CHECK(props(c, main).asset().key.empty());
    CHECK(!props(c, main).asset().libraryMoveInfo.present());
    CHECK(!c.isLibraryCopy(main));
    // Its references came in as this file's own.
    Guid bg = c.document().children(main)[0];
    Guid style = c.findStyle(props(c, bg).refs().styleIdForFill);
    REQUIRE(style != kNoGuid);
    CHECK(!c.isLibraryCopy(style));
    CHECK(fillOf(c, bg) == Color{1, 0, 0, 1});
  }

  SUBCASE("a layer using an unpublished style and variable; then the same with them published") {
    REQUIRE(run(lib, CommandId::APPLY_STYLE, "{\"refs\":[" + q(SWATCH) + "],\"style\":" + q(l.style) + "}") == OK);
    lib.setSelection({SWATCH});
    Clipboard clip;
    REQUIRE(lib.copySelection(clip));
    Editor c = load(consumerDoc(), kConsumerKey);
    c.setSelection({});
    REQUIRE(c.paste(clip, true) == 1);
    Guid swatch = c.selection()[0];
    Guid style = c.findStyle(props(c, swatch).refs().styleIdForFill);
    REQUIRE(style != kNoGuid);
    CHECK(!c.isLibraryCopy(style));
    CHECK(c.stylesOf(StyleType::NONE) == std::vector<Guid>{style});
    REQUIRE(c.collections().size() == 1);
    CHECK(c.variablesOf(c.collections()[0]).size() == 1);  // Brand (what the style uses), not Radius
    CHECK(fillOf(c, swatch) == Color{1, 0, 0, 1});
    // Published: library copies.
    publish(lib, {keyOf(lib, l.style)});
    REQUIRE(lib.copySelection(clip));
    Editor p = load(consumerDoc(), kConsumerKey);
    REQUIRE(p.paste(clip, true) == 1);
    Guid pstyle = p.findStyle(props(p, p.selection()[0]).refs().styleIdForFill);
    CHECK(p.isLibraryCopy(pstyle));
    CHECK(props(p, pstyle).asset().key == keyOf(lib, l.style));
    CHECK(p.stylesOf(StyleType::NONE).empty());
  }
}

// ---- Review fixes (docs/engine-build.md "Libraries — review fixes") ----

namespace {
// The variant copies of a set copy, by the library variant they copy (publishID).
std::map<Guid, Guid> variantsByPublishID(const Editor& c, Guid setCopy) {
  std::map<Guid, Guid> out;
  for (Guid v : c.document().children(setCopy)) out[props(c, v).asset().publishID] = v;
  return out;
}

// The changes that turn `e`'s document into `version` (what the store's restore diff is).
std::vector<NodeChange> diffTo(const Editor& e, const std::vector<NodeChange>& version) {
  std::vector<NodeChange> out;
  std::unordered_set<Guid, GuidHash> there;
  for (const NodeChange& v : version) {
    there.insert(v.guid);
    const Node* n = e.document().get(v.guid);
    if (!n) {
      out.push_back(v);
      continue;
    }
    FieldMask m = differingFields(n->props, v.props, F_ALL);
    if (!m) continue;
    NodeChange c = NodeChange::changed(v.guid);
    c.mask = m;
    c.props = v.props;
    out.push_back(c);
  }
  std::vector<std::pair<int, Guid>> gone;  // deepest first
  e.document().forEach([&](const Node& n) {
    if (n.guid.isDerived() || there.count(n.guid)) return;
    int depth = 0;
    for (Guid g = n.guid; e.document().has(g); g = e.document().parentOf(g)) depth++;
    gone.push_back({-depth, n.guid});
  });
  std::sort(gone.begin(), gone.end());
  for (auto& [d, g] : gone) out.push_back(NodeChange::removed(g));
  return out;
}

std::string messageJson(const std::vector<NodeChange>& nodes) {
  json::Writer w;
  codec::writeMessage(w, 0, nodes);
  return w.take();
}
}  // namespace

TEST_CASE("libraries (review #1): an update of a set whose variants share keys (Add variant, Duplicate) keeps every variant") {
  Editor lib = load(libDoc(), kLibKey);
  lib.setSelection({ICON});
  REQUIRE(lib.command(CommandId::ADD_VARIANT) == OK);
  Guid set = lib.document().parentOf(ICON);
  REQUIRE(props(lib, set).isComponentSet());
  // A third variant duplicated from the first (⌘D keeps the keys of a whole component, docs/schema.md §5.1).
  lib.setSelection({ICON});
  REQUIRE(lib.command(CommandId::DUPLICATE) == OK);
  auto variants = lib.document().children(set);
  REQUIRE(variants.size() == 3);
  // The variants and their glyphs share keys; each glyph a different opacity.
  float opacity = 1;
  std::map<Guid, float> glyphOpacity;
  for (Guid v : variants) {
    CHECK(props(lib, v).keyOf(v) == ICON);
    Guid glyph = lib.document().children(v)[0];
    CHECK(props(lib, glyph).keyOf(glyph) == GLYPH);
    float o = opacity;
    REQUIRE(lib.setProps({glyph}, change(F_OPACITY, [&](NodeProps& p) { p.opacity = o; }), 0) == OK);
    glyphOpacity[v] = o;
    opacity -= 0.25f;
  }
  lib.ensureAssetKeys({});
  std::string setKey = keyOf(lib, set);
  auto m1 = publish(lib, {setKey});

  Editor c = load(consumerDoc(), kConsumerKey);
  std::vector<Editor::ImportedAsset> out;
  REQUIRE(c.importLibrary(m1, opts(kLibKey), out) == OK);
  Guid setCopy = copyOf(c, setKey);
  auto before = variantsByPublishID(c, setCopy);
  REQUIRE(before.size() == 3);
  std::map<Guid, Guid> instanceOf;  // library variant → an instance of its copy
  for (auto& [libVariant, copy] : before) {
    REQUIRE(run(c, CommandId::INSERT_INSTANCE, "{\"main\":" + q(copy) + ",\"x\":10,\"y\":10}") == OK);
    instanceOf[libVariant] = c.selection()[0];
  }
  // The library renames the first variant's glyph; publish; the consumer updates.
  REQUIRE(lib.setProps({GLYPH}, change(F_NAME, [](NodeProps& p) { p.name = "Glyph 2"; }), 0) == OK);
  auto m2 = publish(lib, {setKey});
  REQUIRE(c.importLibrary(m2, opts(kLibKey, true), out) == OK);
  auto after = variantsByPublishID(c, setCopy);
  CHECK(after == before);  // every variant, at its own GUID
  for (auto& [libVariant, inst] : instanceOf) {
    CAPTURE(libVariant.toString());
    Guid main = props(c, inst).comp().symbolData.symbolID;
    CHECK(main == before[libVariant]);
    REQUIRE(c.document().has(main));
    // Each variant keeps its own glyph (not another variant's content).
    Guid glyph = c.document().children(main)[0];
    CHECK(props(c, glyph).opacity == doctest::Approx(glyphOpacity[libVariant]));
    CHECK(props(c, sub(inst, {GLYPH})).opacity == doctest::Approx(glyphOpacity[libVariant]));
  }
  CHECK(props(c, c.document().children(before[ICON])[0]).name == "Glyph 2");
}

TEST_CASE("libraries (review #1): Move to this file relinks each variant's users to the same variant (shared keys)") {
  Editor lib = load(libDoc(), kLibKey);
  lib.setSelection({ICON});
  REQUIRE(lib.command(CommandId::ADD_VARIANT) == OK);
  Guid set = lib.document().parentOf(ICON);
  lib.ensureAssetKeys({});
  std::string setKey = keyOf(lib, set);
  auto m1 = publish(lib, {setKey});
  Editor c = load(consumerDoc(), kConsumerKey);
  std::vector<Editor::ImportedAsset> out;
  REQUIRE(c.importLibrary(m1, opts(kLibKey), out) == OK);
  Guid setCopy = copyOf(c, setKey);
  std::map<std::string, Guid> instanceOf;  // variant name → an instance of its copy
  for (Guid v : c.document().children(setCopy)) {
    REQUIRE(run(c, CommandId::INSERT_INSTANCE, "{\"main\":" + q(v) + ",\"x\":10,\"y\":10}") == OK);
    instanceOf[props(c, v).name] = c.selection()[0];
  }
  REQUIRE(instanceOf.size() == 2);
  // The set is cut from the library and pasted here; this file takes its own redirect.
  lib.setSelection({set});
  Clipboard clip;
  REQUIRE(lib.copySelection(clip, true));
  c.setSelection({});
  REQUIRE(c.paste(clip, true) == 1);
  Guid localSet = c.selection()[0];
  REQUIRE(props(c, localSet).isComponentSet());
  c.ensureAssetKeys({});
  Editor::LibraryOptions o = opts(kConsumerKey, true);
  o.redirects = {{setKey, keyOf(c, localSet)}};
  REQUIRE(c.importLibrary({}, o, out) == OK);
  CHECK(!c.document().has(setCopy));
  for (auto& [name, inst] : instanceOf) {
    CAPTURE(name);
    Guid main = props(c, inst).comp().symbolData.symbolID;
    REQUIRE(c.document().has(main));
    CHECK(c.document().parentOf(main) == localSet);
    CHECK(props(c, main).name == name);
  }
}

TEST_CASE("libraries (review #2, contract a): asNew writes a new, complete copy beside the old one (in an open step too)") {
  Editor lib = load(libDoc(), kLibKey);
  makeAssets(lib);
  lib.setSelection({ICON, PRIVATE});
  REQUIRE(lib.command(CommandId::COMBINE_AS_VARIANTS) == OK);
  Guid set = lib.selection()[0];
  lib.ensureAssetKeys({});
  std::string button = keyOf(lib, BUTTON), setKey = keyOf(lib, set);
  std::vector<Editor::EncodedAsset> v1;
  auto m1 = publish(lib, {button}, &v1);
  Editor c = load(consumerDoc(), kConsumerKey);
  std::vector<Editor::ImportedAsset> out;
  REQUIRE(c.importLibrary(m1, opts(kLibKey), out) == OK);
  Guid oldCopy = copyOf(c, button), oldSet = copyOf(c, setKey);
  REQUIRE(run(c, CommandId::INSERT_INSTANCE, "{\"main\":" + q(oldCopy) + ",\"x\":0,\"y\":0}") == OK);
  Guid a = c.selection()[0];
  REQUIRE(run(c, CommandId::INSERT_INSTANCE, "{\"main\":" + q(oldCopy) + ",\"x\":0,\"y\":100}") == OK);
  Guid b = c.selection()[0];
  REQUIRE(lib.setProps({LABEL}, change(F_TEXT_DATA, [](NodeProps& p) { p.text().textData.characters = "v2"; }), 0) == OK);
  std::vector<Editor::EncodedAsset> v2;
  auto m2 = publish(lib, {button}, &v2);

  // Update selected instance: inside the editor's step, a new copy of Button (the first message's asset), then a swap.
  REQUIRE(c.txnBegin("Update instance") == OK);
  Editor::LibraryOptions o = opts(kLibKey);
  o.asNew = true;
  std::vector<ImageHash> images;
  REQUIRE(c.importLibrary(m2, o, out, &images) == OK);
  Guid fresh = kNoGuid;
  bool created = false;
  for (auto& x : out)
    if (x.key == button) fresh = x.id, created = x.created;
  REQUIRE(fresh != kNoGuid);
  CHECK(created);
  CHECK(fresh != oldCopy);
  CHECK(c.isLibraryCopy(fresh));
  CHECK(props(c, fresh).asset().version == v2[0].info.versionHash);
  CHECK(props(c, oldCopy).asset().version == v1[0].info.versionHash);
  REQUIRE(c.document().children(fresh).size() == c.document().children(oldCopy).size());  // every layer
  CHECK(copyOf(c, setKey) == oldSet);  // its dependencies are reused (same version)
  REQUIRE(run(c, CommandId::SWAP_INSTANCE, "{\"main\":" + q(fresh) + ",\"ref\":" + q(a) + "}") == OK);
  REQUIRE(c.txnCommit() == OK);
  CHECK(c.undoStack().undoLabel() == "Update instance");
  CHECK(props(c, sub(a, {LABEL})).text().textData.characters == "v2");
  CHECK(props(c, sub(b, {LABEL})).text().textData.characters == "Label");
  CHECK(c.document().children(sub(a, {NESTED})).size() == 1);
  // One step: undo takes the copy and the swap back.
  REQUIRE(c.command(CommandId::UNDO) == OK);
  CHECK(!c.document().has(fresh));
  CHECK(props(c, a).comp().symbolData.symbolID == oldCopy);
  REQUIRE(c.command(CommandId::REDO) == OK);
  CHECK(props(c, a).comp().symbolData.symbolID == fresh);

  // A set: a new copy with every variant and its layers; asNew with keys names the asset.
  lib.setSelection({ICON});
  REQUIRE(lib.setProps({GLYPH}, change(F_OPACITY, [](NodeProps& p) { p.opacity = 0.5f; }), 0) == OK);
  auto m3 = publish(lib, {setKey});
  Editor::LibraryOptions os = opts(kLibKey);
  os.asNew = true;
  os.hasKeys = true;
  os.keys = {setKey};
  REQUIRE(c.importLibrary(m3, os, out) == OK);
  Guid freshSet = kNoGuid;
  for (auto& x : out)
    if (x.key == setKey) freshSet = x.id;
  REQUIRE(freshSet != kNoGuid);
  CHECK(freshSet != oldSet);
  auto kids = c.document().children(freshSet);
  REQUIRE(kids.size() == 2);
  for (Guid v : kids) CHECK(props(c, v).type == NodeType::SYMBOL);
  CHECK(c.document().children(variantsByPublishID(c, freshSet)[ICON]).size() == 1);
  // libraryUsage lists both copies of each key, each with its own id (the editor groups them).
  size_t buttons = 0, sets = 0;
  for (auto& u : c.libraryUsage()) buttons += u.key == button, sets += u.key == setKey;
  CHECK(buttons == 2);
  CHECK(sets == 2);
  // A user change still can't write into a copy.
  REQUIRE(c.applyChanges({make({7, 2}, NodeType::RECTANGLE, fresh, "~", {0, 0, 4, 4}, "Extra")}, APPLY_USER) == OK);
  CHECK(!c.document().has(Guid{7, 2}));
}

TEST_CASE("libraries (review #3): a copy kept as it is that lacks a variant a new asset needs comes in as a new copy") {
  Editor lib = load(libDoc(), kLibKey);
  makeAssets(lib);
  lib.setSelection({ICON, PRIVATE});
  REQUIRE(lib.command(CommandId::COMBINE_AS_VARIANTS) == OK);
  Guid set = lib.selection()[0];
  lib.ensureAssetKeys({});
  std::string setKey = keyOf(lib, set), button = keyOf(lib, BUTTON);
  auto m1 = publish(lib, {button});
  // A new variant (a fresh main moved into the set): a key of its own.
  const Guid NV{1, 70}, NVK{1, 71}, CARD2{1, 60}, NEST2{1, 61};
  REQUIRE(lib.applyChanges({make(NV, NodeType::SYMBOL, kPage, "~", {800, 0, 24, 24}, "Variant=Star"),
                            make(NVK, NodeType::ELLIPSE, NV, "!", {0, 0, 24, 24}, "Dot")},
                           APPLY_USER) == OK);
  REQUIRE(lib.moveNodes({NV}, set, 2) == 1);

  SUBCASE("inserting an asset that uses it") {
    Editor c = load(consumerDoc(), kConsumerKey);
    std::vector<Editor::ImportedAsset> out;
    REQUIRE(c.importLibrary(m1, opts(kLibKey), out) == OK);
    Guid setCopy = copyOf(c, setKey);
    NodeChange nest2 = make(NEST2, NodeType::INSTANCE, CARD2, "!", {0, 0, 24, 24}, "Star");
    nest2.props.comp().symbolData.symbolID = NV;
    nest2.props.fillPaints.clear();
    REQUIRE(lib.applyChanges({make(CARD2, NodeType::SYMBOL, kPage, "~~", {600, 0, 50, 50}, "Card2"), nest2}, APPLY_USER) == OK);
    lib.ensureAssetKeys({});
    std::string card2 = keyOf(lib, CARD2);
    auto m2 = publish(lib, {card2});
    REQUIRE(c.importLibrary(m2, opts(kLibKey), out) == OK);
    Guid card2Copy = copyOf(c, card2);
    REQUIRE(card2Copy != kNoGuid);
    Guid nested = c.document().children(card2Copy)[0];
    Guid main = props(c, nested).comp().symbolData.symbolID;
    REQUIRE(c.document().has(main));
    CHECK(props(c, main).asset().publishID == NV);
    // Library copies live on the Internal Only Canvas, derived when something reads them (as the C ABI's reads do).
    c.derivePageOf(nested);
    CHECK(c.document().children(nested).size() == 1);  // the Dot
    // The old set copy (its users) is as it was; the new one has the new variant.
    CHECK(c.document().children(setCopy).size() == 2);
    Guid newSet = c.document().parentOf(main);
    CHECK(newSet != setCopy);
    CHECK(c.document().children(newSet).size() == 3);
    CHECK(c.isLibraryCopy(newSet));
  }

  SUBCASE("an update limited to the asset that uses it") {
    Editor c = load(consumerDoc(), kConsumerKey);
    std::vector<Editor::ImportedAsset> out;
    REQUIRE(c.importLibrary(m1, opts(kLibKey), out) == OK);
    Guid setCopy = copyOf(c, setKey), buttonCopy = copyOf(c, button);
    REQUIRE(run(c, CommandId::INSERT_INSTANCE, "{\"main\":" + q(buttonCopy) + ",\"x\":100,\"y\":100}") == OK);
    Guid inst = c.selection()[0];
    REQUIRE(run(lib, CommandId::SWAP_INSTANCE, "{\"main\":" + q(NV) + ",\"ref\":" + q(NESTED) + "}") == OK);
    auto m2 = publish(lib, {button});
    Editor::LibraryOptions o = opts(kLibKey, true);
    o.hasKeys = true;
    o.keys = {button};
    REQUIRE(c.importLibrary(m2, o, out) == OK);
    Guid nestedCopy = kNoGuid;
    for (Guid k : c.document().children(buttonCopy))
      if (props(c, k).overrideKey == NESTED) nestedCopy = k;
    REQUIRE(nestedCopy != kNoGuid);
    Guid main = props(c, nestedCopy).comp().symbolData.symbolID;
    REQUIRE(c.document().has(main));
    CHECK(props(c, main).asset().publishID == NV);
    CHECK(c.document().children(sub(inst, {NESTED})).size() == 1);
    CHECK(c.document().children(setCopy).size() == 2);  // not updated: not asked for
    // Then the set's update too: the old copy catches up; nothing points at nothing.
    Editor::LibraryOptions o2 = opts(kLibKey, true);
    o2.hasKeys = true;
    o2.keys = {setKey};
    REQUIRE(c.importLibrary(m2, o2, out) == OK);
    CHECK(c.document().children(setCopy).size() == 3);
    CHECK(c.document().has(props(c, nestedCopy).comp().symbolData.symbolID));
  }
}

TEST_CASE("libraries (review #4): versionHash is content only — no GUIDs, no values that depend on where the asset sits") {
  Editor e = load(libDoc(), kLibKey);
  Lib l = makeAssets(e);
  // _Private with a child.
  const Guid PK{1, 21};
  REQUIRE(e.applyChanges({make(PK, NodeType::ELLIPSE, PRIVATE, "!", {0, 0, 10, 10}, "Dot")}, APPLY_USER) == OK);
  e.ensureAssetKeys({});
  std::string priv0 = e.assetVersionHash(PRIVATE), button0 = e.assetVersionHash(BUTTON), style0 = e.assetVersionHash(l.style);
  // A cut + paste in its own file (no instances): new GUIDs, the same key, the same content.
  std::string key = keyOf(e, PRIVATE);
  e.setSelection({PRIVATE});
  Clipboard clip;
  REQUIRE(e.copySelection(clip, true));
  REQUIRE(e.command(CommandId::DELETE) == OK);
  e.setSelection({});
  REQUIRE(e.paste(clip, true) == 1);
  Guid pasted = e.selection()[0];
  REQUIRE(pasted != PRIVATE);
  CHECK(keyOf(e, pasted) == key);
  CHECK(e.assetVersionHash(pasted) == priv0);
  // Into a frame with another variable mode: Background's bound fill re-resolves (blue); the asset is the same.
  REQUIRE(run(e, CommandId::SET_VARIABLE_MODE, "{\"refs\":[" + q(CARD) + "],\"collection\":" + q(l.set) + ",\"mode\":" + q(l.dark) + "}") == OK);
  REQUIRE(e.moveNodes({BUTTON}, CARD, 0) == 1);
  CHECK(fillOf(e, BG) == Color{0, 0, 1, 1});
  CHECK(e.assetVersionHash(BUTTON) == button0);
  // A variable's value changes the variable, not what is bound to it (nor the style using it).
  std::string brand0 = e.assetVersionHash(l.brand);
  REQUIRE(run(e, CommandId::SET_VARIABLE_VALUE, "{\"variable\":" + q(l.brand) + ",\"mode\":" + q(l.light) + R"(,"value":{"r":0,"g":1,"b":0,"a":1}})") == OK);
  CHECK(e.assetVersionHash(l.brand) != brand0);
  CHECK(e.assetVersionHash(BUTTON) == button0);
  CHECK(e.assetVersionHash(l.style) == style0);
  // The binding is content: Background bound elsewhere changes Button.
  REQUIRE(run(e, CommandId::BIND_VARIABLE, "{\"refs\":[" + q(BG) + "],\"target\":\"CORNER_RADIUS\",\"variable\":null}") == OK);
  CHECK(e.assetVersionHash(BUTTON) != button0);
  e.command(CommandId::UNDO);
  CHECK(e.assetVersionHash(BUTTON) == button0);
  // The same content in another session's file (other GUIDs for every node): the same hash.
  std::vector<NodeChange> doc = e.encodeDocument();
  std::unordered_map<Guid, Guid, GuidHash> moveTo;
  for (const NodeChange& n : doc)
    if (n.guid.sessionID == 1) moveTo[n.guid] = Guid{9, n.guid.localID + 1000};
  auto remap = [&](Guid& g) {
    auto it = moveTo.find(g);
    if (it != moveTo.end()) g = it->second;
  };
  for (NodeChange& n : doc) {
    remap(n.guid);
    remap(n.props.parentIndex.guid);
    remap(n.props.comp().symbolData.symbolID);
    for (Paint& pt : n.props.fillPaints)
      if (pt.colorVar.present()) remap(pt.colorVar.edit().alias.guid);
    for (ParamBinding& b : n.props.parameterConsumptionMap) remap(b.data.alias.guid);
    remap(n.props.refs().styleIdForFill.guid);
    remap(n.props.asset().variableSetID.guid);
    for (VariableModeEntry& m : n.props.refs().variableModeBySetMap) remap(m.set.guid);
  }
  Editor other = load(doc, "OtherFileKey00000009");
  Guid otherButton = moveTo.at(BUTTON);
  REQUIRE(other.document().has(otherButton));
  CHECK(other.assetVersionHash(otherButton) == e.assetVersionHash(BUTTON));
}

TEST_CASE("libraries (review #5): a copy pasted from a main edited since its publish doesn't claim the published version") {
  Editor lib = load(libDoc(), kLibKey);
  makeAssets(lib);
  lib.ensureAssetKeys({});
  std::string button = keyOf(lib, BUTTON);
  std::string original = props(lib, LABEL).text().textData.characters;
  std::vector<Editor::EncodedAsset> v1;
  publish(lib, {button}, &v1);
  REQUIRE(lib.setProps({LABEL}, change(F_TEXT_DATA, [](NodeProps& p) { p.text().textData.characters = "WIP"; }), 0) == OK);
  lib.setSelection({IB});
  Clipboard clip;
  REQUIRE(lib.copySelection(clip));
  Editor c = load(consumerDoc(), kConsumerKey);
  c.setSelection({});
  REQUIRE(c.paste(clip, true) == 1);
  Guid inst = c.selection()[0];
  Guid copy = copyOf(c, button);
  REQUIRE(copy != kNoGuid);
  CHECK(props(c, sub(inst, {LABEL})).text().textData.characters == "WIP");
  // Its version is the hash of what it holds — the library's current, unpublished content — never the published one.
  CHECK(props(c, copy).asset().version != v1[0].info.versionHash);
  CHECK(props(c, copy).asset().version == lib.assetVersionHash(BUTTON));
  // The library reverts and publishes (the same hash as before): the update brings the published content.
  REQUIRE(lib.setProps({LABEL}, change(F_TEXT_DATA, [&](NodeProps& p) { p.text().textData.characters = original; }), 0) == OK);
  std::vector<Editor::EncodedAsset> v2;
  auto m2 = publish(lib, {button}, &v2);
  CHECK(v2[0].info.versionHash == v1[0].info.versionHash);
  std::vector<Editor::ImportedAsset> out;
  REQUIRE(c.importLibrary(m2, opts(kLibKey, true), out) == OK);
  CHECK(props(c, copy).asset().version == v1[0].info.versionHash);
  CHECK(props(c, sub(inst, {LABEL})).text().textData.characters == original);
  // Pasted again (unchanged since the publish): the same copy, its version the published one.
  lib.setSelection({IB});
  REQUIRE(lib.copySelection(clip));
  Editor d = load(consumerDoc(), kConsumerKey);
  REQUIRE(d.paste(clip, true) == 1);
  CHECK(props(d, copyOf(d, button)).asset().version == v1[0].info.versionHash);
}

TEST_CASE("libraries (review #15, contract e): a removed asset is no longer published; a published move is done") {
  Editor lib = load(libDoc(), kLibKey);
  makeAssets(lib);
  lib.ensureAssetKeys({});
  std::string button = keyOf(lib, BUTTON);
  publish(lib, {button});
  REQUIRE(!props(lib, BUTTON).asset().publishedVersion.empty());
  // Hide when publishing, then a publish that removes it: markPublished with no version (null).
  REQUIRE(lib.setProps({BUTTON}, change(F_IS_PUBLISHABLE, [](NodeProps& p) { p.asset().isPublishable = false; }), 0) == OK);
  lib.takeEvents();
  REQUIRE(lib.markPublished({{button, ""}}) == OK);
  auto ev = lib.takeEvents();
  REQUIRE(ev.documents.size() == 1);
  CHECK(ev.documents[0].kind == TxnKind::SYSTEM);
  CHECK(props(lib, BUTTON).asset().publishedVersion.empty());
  CHECK(lib.undoStack().undoLabel() != "Publish");
  // Its main pasted elsewhere: a new main (R4 §8), not an instance of a library copy.
  lib.setSelection({BUTTON});
  Clipboard clip;
  REQUIRE(lib.copySelection(clip));
  Editor c = load(consumerDoc(), kConsumerKey);
  REQUIRE(c.paste(clip, true) == 1);
  Guid main = c.selection()[0];
  CHECK(props(c, main).type == NodeType::SYMBOL);
  CHECK(props(c, main).asset().sourceLibraryKey.empty());
  CHECK(copyOf(c, button) == kNoGuid);
  // An instance of it: a copied-in main.
  lib.setSelection({IB});
  REQUIRE(lib.copySelection(clip));
  Editor d = load(consumerDoc(), kConsumerKey);
  REQUIRE(d.paste(clip, true) == 1);
  Guid dm = props(d, d.selection()[0]).comp().symbolData.symbolID;
  CHECK(d.isCopiedMain(dm));
  CHECK(!d.isLibraryCopy(dm));
  // Cut: no Move to this file for it.
  lib.setSelection({BUTTON});
  REQUIRE(lib.copySelection(clip, true));
  Editor m = load(consumerDoc(), "MovedHereFileKey0005");
  REQUIRE(m.paste(clip, true) == 1);
  CHECK(!props(m, m.selection()[0]).asset().libraryMoveInfo.present());

  // A moved main published in its new file: libraryMoveInfo cleared by markPublished (SYSTEM, not an undo step).
  REQUIRE(lib.setProps({BUTTON}, change(F_IS_PUBLISHABLE, [](NodeProps& p) { p.asset().isPublishable = true; }), 0) == OK);
  publish(lib, {button});
  lib.setSelection({BUTTON});
  REQUIRE(lib.copySelection(clip, true));
  Editor n = load(consumerDoc(), "MovedHereFileKey0006");
  REQUIRE(n.paste(clip, true) == 1);
  Guid moved = n.selection()[0];
  REQUIRE(props(n, moved).asset().libraryMoveInfo.oldKey == button);
  n.ensureAssetKeys({moved});
  std::string label = n.undoStack().undoLabel();
  REQUIRE(n.markPublished({{keyOf(n, moved), n.assetVersionHash(moved)}}) == OK);
  CHECK(!props(n, moved).asset().libraryMoveInfo.present());
  CHECK(props(n, moved).asset().publishedVersion == n.assetVersionHash(moved));
  CHECK(n.undoStack().undoLabel() == label);
  // Inside an open step: refused.
  REQUIRE(n.txnBegin("x") == OK);
  CHECK(n.markPublished({{keyOf(n, moved), ""}}) == E_BUSY);
  n.txnCancel();
}

TEST_CASE("libraries (review #18, contract b): every copy of a key is updated, deterministically; `copies` restricts it") {
  Editor lib = load(libDoc(), kLibKey);
  makeAssets(lib);
  lib.ensureAssetKeys({});
  std::string button = keyOf(lib, BUTTON);
  auto m1 = publish(lib, {button});
  Editor c = load(consumerDoc(), kConsumerKey);
  std::vector<Editor::ImportedAsset> out;
  REQUIRE(c.importLibrary(m1, opts(kLibKey), out) == OK);
  Guid oldCopy = copyOf(c, button);
  REQUIRE(run(c, CommandId::INSERT_INSTANCE, "{\"main\":" + q(oldCopy) + ",\"x\":0,\"y\":0}") == OK);
  Guid a = c.selection()[0];
  REQUIRE(run(c, CommandId::INSERT_INSTANCE, "{\"main\":" + q(oldCopy) + ",\"x\":0,\"y\":100}") == OK);
  Guid b = c.selection()[0];
  REQUIRE(lib.setProps({LABEL}, change(F_TEXT_DATA, [](NodeProps& p) { p.text().textData.characters = "v2"; }), 0) == OK);
  std::vector<Editor::EncodedAsset> v2;
  auto m2 = publish(lib, {button}, &v2);
  // Update selected instance on `a`: a second copy at v2.
  Editor::LibraryOptions fresh = opts(kLibKey);
  fresh.asNew = true;
  REQUIRE(c.importLibrary(m2, fresh, out) == OK);
  Guid newCopy = kNoGuid;
  for (auto& x : out)
    if (x.key == button) newCopy = x.id;
  REQUIRE(run(c, CommandId::SWAP_INSTANCE, "{\"main\":" + q(newCopy) + ",\"ref\":" + q(a) + "}") == OK);
  // Update (the key): the old copy too, whichever the document lists first.
  Editor::LibraryOptions upd = opts(kLibKey, true);
  upd.hasKeys = true;
  upd.keys = {button};
  REQUIRE(c.importLibrary(m2, upd, out) == OK);
  CHECK(props(c, oldCopy).asset().version == v2[0].info.versionHash);
  CHECK(props(c, sub(b, {LABEL})).text().textData.characters == "v2");
  size_t updated = 0, listed = 0;
  for (auto& x : out)
    if (x.key == button) listed++, updated += x.updated;
  CHECK(listed == 2);
  CHECK(updated == 1);  // the new copy was already at v2
  CHECK(c.undoStack().undoLabel() == "Update library assets");
  // v3, only for the new copy.
  REQUIRE(lib.setProps({LABEL}, change(F_TEXT_DATA, [](NodeProps& p) { p.text().textData.characters = "v3"; }), 0) == OK);
  std::vector<Editor::EncodedAsset> v3;
  auto m3 = publish(lib, {button}, &v3);
  Editor::LibraryOptions only = opts(kLibKey, true);
  only.hasCopies = true;
  only.copies = {newCopy};
  REQUIRE(c.importLibrary(m3, only, out) == OK);
  CHECK(props(c, newCopy).asset().version == v3[0].info.versionHash);
  CHECK(props(c, oldCopy).asset().version == v2[0].info.versionHash);
  CHECK(props(c, sub(a, {LABEL})).text().textData.characters == "v3");
  CHECK(props(c, sub(b, {LABEL})).text().textData.characters == "v2");
  // One undo step put both back.
  REQUIRE(c.command(CommandId::UNDO) == OK);
  CHECK(props(c, newCopy).asset().version == v2[0].info.versionHash);
  REQUIRE(c.command(CommandId::UNDO) == OK);
  CHECK(props(c, oldCopy).asset().version != v2[0].info.versionHash);
  CHECK(props(c, newCopy).asset().version == v2[0].info.versionHash);
}

TEST_CASE("libraries (review #22, contract d): Restore version writes library copies; system changes aren't undo steps") {
  Editor lib = load(libDoc(), kLibKey);
  makeAssets(lib);
  lib.ensureAssetKeys({});
  std::string button = keyOf(lib, BUTTON);
  auto m1 = publish(lib, {button});
  Editor c = load(consumerDoc(), kConsumerKey);
  std::vector<Editor::ImportedAsset> out;
  REQUIRE(c.importLibrary(m1, opts(kLibKey), out) == OK);
  Guid copy = copyOf(c, button);
  REQUIRE(run(c, CommandId::INSERT_INSTANCE, "{\"main\":" + q(copy) + ",\"x\":0,\"y\":0}") == OK);
  Guid inst = c.selection()[0];
  std::vector<NodeChange> version = c.encodeDocument();  // "Save version"
  // The library changes Background and adds a layer; the consumer updates.
  REQUIRE(lib.setProps({BG}, change(F_OPACITY, [](NodeProps& p) { p.opacity = 0.5f; }), 0) == OK);
  const Guid BADGE{1, 50};
  REQUIRE(lib.applyChanges({make(BADGE, NodeType::ELLIPSE, BUTTON, "$", {110, 0, 10, 10}, "Badge")}, APPLY_USER) == OK);
  auto m2 = publish(lib, {button});
  REQUIRE(c.importLibrary(m2, opts(kLibKey, true), out) == OK);
  REQUIRE(props(c, sub(inst, {BG})).opacity == doctest::Approx(0.5));
  std::vector<NodeChange> diff = diffTo(c, version);
  REQUIRE(!diff.empty());

  SUBCASE("a user change can't (copies are read-only)") {
    std::string savedVersion;
    for (const NodeChange& n : version)
      if (n.guid == copy) savedVersion = n.props.asset().version;
    REQUIRE(c.applyChanges(diff, APPLY_USER) == OK);
    CHECK(props(c, copy).asset().version != savedVersion);
    CHECK(!diffTo(c, version).empty());
  }
  SUBCASE("Restore version (APPLY_EXACT): the copies too, one undo step, no instance overrides") {
    c.takeEvents();
    REQUIRE(c.applyChanges(diff, APPLY_USER | APPLY_EXACT) == OK);
    CHECK(diffTo(c, version).empty());
    CHECK(props(c, sub(inst, {BG})).opacity == doctest::Approx(1));
    CHECK(!c.document().has(sub(inst, {BADGE})));
    CHECK(props(c, inst).comp().symbolData.overrides.empty());
    auto ev = c.takeEvents();
    REQUIRE(ev.documents.size() == 1);
    CHECK(ev.documents[0].kind == TxnKind::USER);
    REQUIRE(c.command(CommandId::UNDO) == OK);
    CHECK(props(c, sub(inst, {BG})).opacity == doctest::Approx(0.5));
    // And the copies stay read-only for user edits afterwards.
    REQUIRE(c.command(CommandId::REDO) == OK);
    CHECK(c.setProps({copy}, change(F_NAME, [](NodeProps& p) { p.name = "x"; }), 0) == E_READONLY);
  }
  SUBCASE("APPLY_SYSTEM: journaled and emitted, not an undo step; refused in copies; E_BUSY in an open user step") {
    std::string label = c.undoStack().undoLabel();
    NodeChange pub = NodeChange::changed(RECT);
    pub.mask = F_NAME;
    pub.props.name = "Renamed by the system";
    NodeChange intoCopy = NodeChange::changed(copy);
    intoCopy.mask = F_NAME;
    intoCopy.props.name = "x";
    c.takeEvents();
    REQUIRE(c.applyChanges({pub, intoCopy}, APPLY_SYSTEM) == OK);
    CHECK(props(c, RECT).name == "Renamed by the system");
    CHECK(props(c, copy).name == "Button");
    auto ev = c.takeEvents();
    REQUIRE(ev.documents.size() == 1);
    CHECK(ev.documents[0].kind == TxnKind::SYSTEM);
    CHECK(c.undoStack().undoLabel() == label);
    REQUIRE(c.txnBegin("x") == OK);
    CHECK(c.applyChanges({pub}, APPLY_SYSTEM) == E_BUSY);
    c.txnCancel();
  }
}

TEST_CASE("libraries (review #23): an asset's own payload wins over an older copy of it embedded in another payload") {
  Editor lib = load(libDoc(), kLibKey);
  makeAssets(lib);
  lib.ensureAssetKeys({});
  std::string button = keyOf(lib, BUTTON), icon = keyOf(lib, ICON);
  std::vector<Editor::EncodedAsset> b1;
  auto m1 = publish(lib, {button}, &b1);  // Button's payload embeds Icon as it is now
  // Only Icon changes; the next version ships Icon alone (Button's hash is the same: its stored payload stays).
  REQUIRE(lib.setProps({GLYPH}, change(F_OPACITY, [](NodeProps& p) { p.opacity = 0.25f; }), 0) == OK);
  std::vector<Editor::EncodedAsset> i2;
  auto m2 = publish(lib, {icon}, &i2);
  CHECK(lib.assetVersionHash(BUTTON) == b1[0].info.versionHash);
  for (bool reversed : {false, true}) {
    CAPTURE(reversed);
    std::vector<std::vector<NodeChange>> messages = {m1[0], m2[0]};
    if (reversed) std::swap(messages[0], messages[1]);
    Editor c = load(consumerDoc(), kConsumerKey);
    std::vector<Editor::ImportedAsset> out;
    REQUIRE(c.importLibrary(messages, opts(kLibKey), out) == OK);
    Guid iconCopy = copyOf(c, icon);
    CHECK(props(c, iconCopy).asset().version == i2[0].info.versionHash);
    CHECK(props(c, c.document().children(iconCopy)[0]).opacity == doctest::Approx(0.25));
    REQUIRE(run(c, CommandId::INSERT_INSTANCE, "{\"main\":" + q(copyOf(c, button)) + "}") == OK);
    CHECK(props(c, sub(c.selection()[0], {NESTED, GLYPH})).opacity == doctest::Approx(0.25));
  }
  // Update all: the same.
  Editor c = load(consumerDoc(), kConsumerKey);
  std::vector<Editor::ImportedAsset> out;
  REQUIRE(c.importLibrary(m1, opts(kLibKey), out) == OK);
  REQUIRE(lib.setProps({LABEL}, change(F_TEXT_DATA, [](NodeProps& p) { p.text().textData.characters = "v3"; }), 0) == OK);
  auto m3 = publish(lib, {button});  // embeds Icon at 0.25
  REQUIRE(lib.setProps({GLYPH}, change(F_OPACITY, [](NodeProps& p) { p.opacity = 0.75f; }), 0) == OK);
  std::vector<Editor::EncodedAsset> i4;
  auto m4 = publish(lib, {icon}, &i4);
  REQUIRE(c.importLibrary({m3[0], m4[0]}, opts(kLibKey, true), out) == OK);
  Guid iconCopy = copyOf(c, icon);
  CHECK(props(c, iconCopy).asset().version == i4[0].info.versionHash);
  CHECK(props(c, c.document().children(iconCopy)[0]).opacity == doctest::Approx(0.75));
  // Without Icon's own payload, the embedded one is used — whole.
  Editor d = load(consumerDoc(), kConsumerKey);
  REQUIRE(d.importLibrary({m3[0]}, opts(kLibKey), out) == OK);
  CHECK(props(d, d.document().children(copyOf(d, icon))[0]).opacity == doctest::Approx(0.25));
}

TEST_CASE("libraries (review #24, contract c): copies are one library's — a duplicated library's assets get their own") {
  Editor lib = load(libDoc(), kLibKey);
  makeAssets(lib);
  lib.ensureAssetKeys({});
  std::string button = keyOf(lib, BUTTON);
  auto m1 = publish(lib, {button});
  // "Kit (Copy)": the same document (same keys) under another FileKey, its Background red.
  const char* dupKey = "DuplicatedLibKey0007";
  Editor dup = load(lib.encodeDocument(), dupKey);
  REQUIRE(keyOf(dup, BUTTON) == button);
  REQUIRE(dup.setProps({BG}, change(F_OPACITY, [](NodeProps& p) { p.opacity = 0.3f; }), 0) == OK);
  auto d1 = publish(dup, {button});
  Editor c = load(consumerDoc(), kConsumerKey);
  std::vector<Editor::ImportedAsset> out;
  REQUIRE(c.importLibrary(m1, opts(kLibKey), out) == OK);
  Guid fromLib = copyOf(c, button);
  REQUIRE(c.importLibrary(d1, opts(dupKey), out) == OK);
  Guid fromDup = kNoGuid;
  for (auto& x : out)
    if (x.key == button) fromDup = x.id;
  REQUIRE(fromDup != kNoGuid);
  CHECK(fromDup != fromLib);
  CHECK(props(c, fromLib).asset().sourceLibraryKey == kLibKey);
  CHECK(props(c, fromDup).asset().sourceLibraryKey == dupKey);
  CHECK(props(c, c.document().children(fromDup)[0]).opacity == doctest::Approx(0.3));
  CHECK(props(c, c.document().children(fromLib)[0]).opacity == doctest::Approx(1));
  // An update from one library never touches the other's copy.
  REQUIRE(lib.setProps({LABEL}, change(F_TEXT_DATA, [](NodeProps& p) { p.text().textData.characters = "Lib v2"; }), 0) == OK);
  auto m2 = publish(lib, {button});
  REQUIRE(c.importLibrary(m2, opts(kLibKey, true), out) == OK);
  CHECK(props(c, c.document().children(fromLib)[1]).text().textData.characters == "Lib v2");
  CHECK(props(c, c.document().children(fromDup)[1]).text().textData.characters == "Label");
  CHECK(props(c, fromDup).asset().sourceLibraryKey == dupKey);
  // A cross-file paste from the duplicate finds the duplicate's copy.
  dup.setSelection({IB});
  Clipboard clip;
  REQUIRE(dup.copySelection(clip));
  REQUIRE(c.paste(clip, true) == 1);
  CHECK(props(c, c.selection()[0]).comp().symbolData.symbolID == fromDup);
}

// ---- Review fixes, second round (docs/engine-build.md "Libraries — review fixes") ----

namespace {
// Every GUID reference this file's fixtures use, mapped (the same document in another file: other GUIDs everywhere).
void remapVariableData(VariableData& d, const std::function<void(Guid&)>& f) {
  f(d.alias.guid);
  for (VariableData& a : d.args) remapVariableData(a, f);
}
void remapDoc(std::vector<NodeChange>& doc, const std::function<void(Guid&)>& f) {
  for (NodeChange& n : doc) {
    NodeProps& p = n.props;
    f(n.guid);
    f(p.parentIndex.guid);
    f(p.comp().symbolData.symbolID);
    for (Paint& pt : p.fillPaints)
      if (pt.colorVar.present()) remapVariableData(pt.colorVar.edit(), f);
    for (ParamBinding& b : p.parameterConsumptionMap) remapVariableData(b.data, f);
    for (VariableModeValue& v : p.asset().variableDataValues) remapVariableData(v.data, f);
    f(p.refs().styleIdForFill.guid);
    f(p.asset().variableSetID.guid);
    for (VariableModeEntry& m : p.refs().variableModeBySetMap) f(m.set.guid);
    for (ComponentPropDef& d : p.comp().componentPropDefs) {
      f(d.initialValue.guidValue);
      for (PreferredValue& v : d.preferredValues) {
        bool ok = false;
        Guid g = Guid::parse(v.key, &ok);
        if (ok) f(g), v.key = g.toString();
      }
    }
  }
}

// An INSTANCE_SWAP property on `main` (default Icon) preferring `preferred`.
ComponentPropDef swapProp(std::vector<std::string> preferred) {
  ComponentPropDef d;
  d.id = Guid{1, 500};
  d.name = "Icon";
  d.type = ComponentPropType::INSTANCE_SWAP;
  d.initialValue.guidValue = ICON;
  d.sortPosition = "!";
  for (const std::string& k : preferred) d.preferredValues.push_back(PreferredValue{false, k});
  return d;
}

Guid sublayerMain(const Editor& c, Guid inst) { return props(c, inst).comp().symbolData.symbolID; }
}  // namespace

TEST_CASE("libraries (review #4): a hidden asset an asset uses — directly or through hidden aliases — is part of its versionHash") {
  Editor e = load(libDoc(), kLibKey);
  makeAssets(e);
  // _Primitives (hidden): Blue, and Alias → Blue. Tokens (listed): Accent → Blue.
  REQUIRE(run(e, CommandId::CREATE_VARIABLE_COLLECTION, R"({"name":"_Primitives"})") == OK);
  Guid prims = e.lastCreated()[0], primMode = e.lastCreated()[1];
  REQUIRE(run(e, CommandId::CREATE_VARIABLE, "{\"collection\":" + q(prims) + R"(,"type":"COLOR","name":"Blue","value":{"r":0,"g":0,"b":1,"a":1}})") == OK);
  Guid blue = e.lastCreated()[0];
  REQUIRE(run(e, CommandId::CREATE_VARIABLE, "{\"collection\":" + q(prims) + R"(,"type":"COLOR","name":"Alias","value":{"type":"VARIABLE_ALIAS","id":)" + q(blue) + "}}") == OK);
  Guid alias = e.lastCreated()[0];
  REQUIRE(run(e, CommandId::CREATE_VARIABLE_COLLECTION, R"({"name":"Tokens"})") == OK);
  Guid tokens = e.lastCreated()[0];
  REQUIRE(run(e, CommandId::CREATE_VARIABLE, "{\"collection\":" + q(tokens) + R"(,"type":"COLOR","name":"Accent","value":{"type":"VARIABLE_ALIAS","id":)" + q(blue) + "}}") == OK);
  Guid accent = e.lastCreated()[0];
  // Button's Label bound to the hidden Alias; Icon's Glyph to the listed Accent.
  REQUIRE(run(e, CommandId::BIND_VARIABLE, "{\"refs\":[" + q(LABEL) + "],\"target\":\"fillPaints[0].color\",\"variable\":" + q(alias) + "}") == OK);
  REQUIRE(run(e, CommandId::BIND_VARIABLE, "{\"refs\":[" + q(GLYPH) + "],\"target\":\"fillPaints[0].color\",\"variable\":" + q(accent) + "}") == OK);
  CHECK(fillOf(e, LABEL) == Color{0, 0, 1, 1});
  e.ensureAssetKeys({});
  auto assets = e.localAssets();
  REQUIRE(findAsset(assets, blue));
  CHECK(findAsset(assets, blue)->hidden);
  CHECK(findAsset(assets, alias)->hidden);
  CHECK(!findAsset(assets, accent)->hidden);
  std::string button0 = e.assetVersionHash(BUTTON), icon0 = e.assetVersionHash(ICON), accent0 = e.assetVersionHash(accent),
              alias0 = e.assetVersionHash(alias), blue0 = e.assetVersionHash(blue);

  // The hidden primitive's value: what uses it through hidden assets changes (Button, through Alias; Alias); the
  // listed Accent changes (it is published on its own), and what uses Accent doesn't (Icon).
  REQUIRE(run(e, CommandId::SET_VARIABLE_VALUE, "{\"variable\":" + q(blue) + ",\"mode\":" + q(primMode) + R"(,"value":{"r":0,"g":1,"b":0,"a":1}})") == OK);
  CHECK(fillOf(e, LABEL) == Color{0, 1, 0, 1});
  CHECK(e.assetVersionHash(blue) != blue0);
  CHECK(e.assetVersionHash(alias) != alias0);
  CHECK(e.assetVersionHash(BUTTON) != button0);
  CHECK(e.assetVersionHash(accent) != accent0);
  CHECK(e.assetVersionHash(ICON) == icon0);
  // localAssets and encodeAssets agree.
  assets = e.localAssets();
  CHECK(findAsset(assets, BUTTON)->versionHash == e.assetVersionHash(BUTTON));
  std::vector<Editor::EncodedAsset> enc;
  std::vector<ImageHash> images;
  e.encodeAssets({keyOf(e, BUTTON)}, enc, images);
  REQUIRE(!enc.empty());
  CHECK(enc[0].info.versionHash == e.assetVersionHash(BUTTON));
  // Undone: the hashes are what they were (content only).
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(e.assetVersionHash(BUTTON) == button0);
  CHECK(e.assetVersionHash(accent) == accent0);

  // A hidden main nested in Button: its content is Button's too.
  const Guid PK{1, 21}, NESTP{1, 14};
  NodeChange np = make(NESTP, NodeType::INSTANCE, BUTTON, "$", {0, 0, 10, 10}, "_Private");
  np.props.comp().symbolData.symbolID = PRIVATE;
  np.props.fillPaints.clear();
  REQUIRE(e.applyChanges({make(PK, NodeType::ELLIPSE, PRIVATE, "!", {0, 0, 10, 10}, "Dot"), np}, APPLY_USER) == OK);
  std::string button1 = e.assetVersionHash(BUTTON);
  REQUIRE(e.setProps({PK}, change(F_OPACITY, [](NodeProps& p) { p.opacity = 0.5f; }), 0) == OK);
  CHECK(e.assetVersionHash(BUTTON) != button1);
  // Hidden mains, variables and styles listed (Hide when publishing): the same.
  REQUIRE(e.setProps({PK}, change(F_OPACITY, [](NodeProps& p) { p.opacity = 1; }), 0) == OK);
  CHECK(e.assetVersionHash(BUTTON) == button1);

  // No GUIDs: the same content in another file (every GUID different) hashes the same.
  std::vector<NodeChange> doc = e.encodeDocument();
  remapDoc(doc, [](Guid& g) {
    if (g.sessionID == 1) g = Guid{9, g.localID + 1000};
  });
  Editor other = load(doc, "OtherFileKey00000009");
  REQUIRE(other.document().has(Guid{9, BUTTON.localID + 1000}));
  CHECK(other.assetVersionHash(Guid{9, BUTTON.localID + 1000}) == e.assetVersionHash(BUTTON));
  CHECK(other.assetVersionHash(Guid{9, accent.localID + 1000}) == e.assetVersionHash(accent));
}

TEST_CASE("libraries (review #4): a hidden variable's new value is published with what uses it and reaches consumers") {
  Editor lib = load(libDoc(), kLibKey);
  makeAssets(lib);
  REQUIRE(run(lib, CommandId::CREATE_VARIABLE_COLLECTION, R"({"name":"_Tokens"})") == OK);
  Guid set = lib.lastCreated()[0], mode = lib.lastCreated()[1];
  REQUIRE(run(lib, CommandId::CREATE_VARIABLE, "{\"collection\":" + q(set) + R"(,"type":"COLOR","name":"Secret","value":{"r":1,"g":0,"b":0,"a":1}})") == OK);
  Guid secret = lib.lastCreated()[0];
  REQUIRE(run(lib, CommandId::BIND_VARIABLE, "{\"refs\":[" + q(LABEL) + "],\"target\":\"fillPaints[0].color\",\"variable\":" + q(secret) + "}") == OK);
  lib.ensureAssetKeys({});
  std::string button = keyOf(lib, BUTTON);
  std::vector<Editor::EncodedAsset> v1;
  auto m1 = publish(lib, {button}, &v1);
  Editor c = load(consumerDoc(), kConsumerKey);
  std::vector<Editor::ImportedAsset> out;
  REQUIRE(c.importLibrary(m1, opts(kLibKey), out) == OK);
  REQUIRE(run(c, CommandId::INSERT_INSTANCE, "{\"main\":" + q(copyOf(c, button)) + ",\"x\":100,\"y\":100}") == OK);
  Guid inst = c.selection()[0];
  CHECK(fillOf(c, sub(inst, {LABEL})) == Color{1, 0, 0, 1});
  // The library edits the hidden variable: Button is Modified (the publish lists it), its payload carries the value.
  REQUIRE(run(lib, CommandId::SET_VARIABLE_VALUE, "{\"variable\":" + q(secret) + ",\"mode\":" + q(mode) + R"(,"value":{"r":0,"g":1,"b":0,"a":1}})") == OK);
  auto assets = lib.localAssets();
  const Editor::AssetInfo* b = findAsset(assets, BUTTON);
  REQUIRE(b);
  CHECK(b->versionHash != b->publishedVersion);
  std::vector<Editor::EncodedAsset> v2;
  auto m2 = publish(lib, {button}, &v2);
  CHECK(v2[0].info.versionHash != v1[0].info.versionHash);
  // Update all (the asset and the dependency-only copy it uses): the new colour.
  REQUIRE(c.importLibrary(m2, opts(kLibKey, true), out) == OK);
  CHECK(props(c, copyOf(c, button)).asset().version == v2[0].info.versionHash);
  CHECK(fillOf(c, sub(inst, {LABEL})) == Color{0, 1, 0, 1});
}

TEST_CASE("libraries (review #4): a reference to a node that isn't there hashes the same whatever its GUID was") {
  Editor e = load(libDoc(), kLibKey);
  const Guid PK{1, 21};
  REQUIRE(e.applyChanges({make(PK, NodeType::ELLIPSE, PRIVATE, "!", {0, 0, 10, 10}, "Dot")}, APPLY_USER) == OK);
  REQUIRE(e.setProps({BUTTON}, change(F_COMPONENT_PROP_DEFS, [&](NodeProps& p) { p.comp().componentPropDefs = {swapProp({ICON.toString(), PRIVATE.toString()})}; }), 0) == OK);
  e.ensureAssetKeys({});
  std::string button0 = e.assetVersionHash(BUTTON), private0 = e.assetVersionHash(PRIVATE);
  // A cut + paste of the preferred main in its own file: the same main under a new GUID — the preferred value follows.
  e.setSelection({PRIVATE});
  Clipboard clip;
  REQUIRE(e.copySelection(clip, true));
  REQUIRE(e.command(CommandId::DELETE) == OK);
  e.setSelection({});
  REQUIRE(e.paste(clip, true) == 1);
  Guid pasted = e.selection()[0];
  REQUIRE(pasted != PRIVATE);
  CHECK(props(e, pasted).asset().version.empty());  // the clipboard's hash note isn't kept
  CHECK(props(e, BUTTON).comp().componentPropDefs[0].preferredValues[1].key == pasted.toString());
  CHECK(e.assetVersionHash(pasted) == private0);
  CHECK(e.assetVersionHash(BUTTON) == button0);
  REQUIRE(e.command(CommandId::UNDO) == OK);  // the paste (and the preferred value) undone
  CHECK(props(e, BUTTON).comp().componentPropDefs[0].preferredValues[1].key == PRIVATE.toString());
  // Now it points at nothing: a real change, hashed the same whichever GUID it named (never the GUID).
  std::string dangling = e.assetVersionHash(BUTTON);
  CHECK(dangling != button0);
  REQUIRE(e.setProps({BUTTON}, change(F_COMPONENT_PROP_DEFS, [&](NodeProps& p) { p.comp().componentPropDefs = {swapProp({ICON.toString(), "7:999"})}; }), 0) == OK);
  CHECK(e.assetVersionHash(BUTTON) == dangling);
  // A bound style that isn't there: the same.
  REQUIRE(e.setProps({BG}, change(kStyleIdFields, [&](NodeProps& p) { p.refs().styleIdForFill = AssetId::of(Guid{7, 998}); }), 0) == OK);
  std::string noStyle = e.assetVersionHash(BUTTON);
  REQUIRE(e.setProps({BG}, change(kStyleIdFields, [&](NodeProps& p) { p.refs().styleIdForFill = AssetId::of(Guid{7, 997}); }), 0) == OK);
  CHECK(e.assetVersionHash(BUTTON) == noStyle);
}

TEST_CASE("libraries (review #5): an unchanged published main pastes at exactly its publishedVersion, whatever its preferred values name") {
  Editor lib = load(libDoc(), kLibKey);
  makeAssets(lib);
  // Preferred instances: Icon (in the clipboard: Button nests it) and _Private (not in it).
  REQUIRE(lib.setProps({BUTTON}, change(F_COMPONENT_PROP_DEFS, [&](NodeProps& p) { p.comp().componentPropDefs = {swapProp({ICON.toString(), PRIVATE.toString()})}; }), 0) == OK);
  // And a hidden variable it uses (its hash folds in).
  REQUIRE(run(lib, CommandId::CREATE_VARIABLE_COLLECTION, R"({"name":"_Tokens"})") == OK);
  Guid set = lib.lastCreated()[0];
  REQUIRE(run(lib, CommandId::CREATE_VARIABLE, "{\"collection\":" + q(set) + R"(,"type":"COLOR","name":"Secret","value":{"r":1,"g":0,"b":0,"a":1}})") == OK);
  REQUIRE(run(lib, CommandId::BIND_VARIABLE, "{\"refs\":[" + q(LABEL) + "],\"target\":\"fillPaints[0].color\",\"variable\":" + q(lib.lastCreated()[0]) + "}") == OK);
  lib.ensureAssetKeys({});
  std::string button = keyOf(lib, BUTTON);
  std::vector<Editor::EncodedAsset> v1;
  publish(lib, {button}, &v1);
  REQUIRE(props(lib, BUTTON).asset().publishedVersion == v1[0].info.versionHash);
  lib.setSelection({IB});
  Clipboard clip;
  REQUIRE(lib.copySelection(clip));
  bool hasPrivate = false;
  for (auto& n : clip.nodes) hasPrivate |= n.guid == PRIVATE;
  CHECK(!hasPrivate);
  // Through the wire (the system clipboard carries the engine's JSON).
  clip.nodes = wire(clip.nodes);
  Editor c = load(consumerDoc(), kConsumerKey);
  c.setSelection({});
  REQUIRE(c.paste(clip, true) == 1);
  CHECK(c.unresolvedReferences() == 0);
  Guid copy = copyOf(c, button);
  REQUIRE(copy != kNoGuid);
  CHECK(props(c, copy).asset().version == v1[0].info.versionHash);
  // Its preferred instances: Icon's copy here; _Private (not here) by key — never this file's node with its GUID
  // (here 1:1 is the Screen frame).
  ComponentInfo info;
  REQUIRE(c.componentInfo(c.selection()[0], info));
  REQUIRE(info.properties.size() == 1);
  CHECK(info.properties[0].preferredValues == std::vector<Guid>{copyOf(c, keyOf(lib, ICON))});
  CHECK(props(c, copy).comp().componentPropDefs[0].preferredValues.size() == 2);
  CHECK(props(c, copy).comp().componentPropDefs[0].preferredValues[1].key == keyOf(lib, PRIVATE));
  // Edited since: never the published version (the hash of what it holds).
  REQUIRE(lib.setProps({BG}, change(F_OPACITY, [](NodeProps& p) { p.opacity = 0.5f; }), 0) == OK);
  lib.setSelection({IB});
  REQUIRE(lib.copySelection(clip));
  Editor d = load(consumerDoc(), kConsumerKey);
  REQUIRE(d.paste(clip, true) == 1);
  CHECK(props(d, copyOf(d, button)).asset().version == lib.assetVersionHash(BUTTON));
  CHECK(props(d, copyOf(d, button)).asset().version != v1[0].info.versionHash);
}

TEST_CASE("libraries (review #1): a set copy pasted from another consumer carries the library's GUIDs; a deleted variant's copy keeps rendering") {
  Editor lib = load(libDoc(), kLibKey);
  // A set of three variants, two sharing name and key (Add variant, Duplicate); each glyph its own opacity.
  lib.setSelection({ICON});
  REQUIRE(lib.command(CommandId::ADD_VARIANT) == OK);
  Guid set = lib.document().parentOf(ICON);
  lib.setSelection({ICON});
  REQUIRE(lib.command(CommandId::DUPLICATE) == OK);
  auto variants = lib.document().children(set);
  REQUIRE(variants.size() == 3);
  std::map<Guid, float> op;
  float o = 1;
  for (Guid v : variants) {
    float oo = o;
    REQUIRE(lib.setProps({lib.document().children(v)[0]}, change(F_OPACITY, [&](NodeProps& p) { p.opacity = oo; }), 0) == OK);
    op[v] = oo;
    o -= 0.25f;
  }
  lib.ensureAssetKeys({});
  std::string setKey = keyOf(lib, set);
  auto m1 = publish(lib, {setKey});
  auto glyphOp = [](const Editor& e, Guid main) { return props(e, e.document().children(main)[0]).opacity; };

  SUBCASE("pasted from another consumer") {
    Editor c1 = load(consumerDoc(), "Consumer1FileKey0001");
    std::vector<Editor::ImportedAsset> out;
    REQUIRE(c1.importLibrary(m1, opts(kLibKey), out) == OK);
    auto by1 = variantsByPublishID(c1, copyOf(c1, setKey));
    Editor c2 = load(consumerDoc(), "Consumer2FileKey0002");
    c2.setSelection({RECT});
    REQUIRE(c2.command(CommandId::DUPLICATE) == OK);  // c2's GUIDs differ from c1's
    std::map<Guid, Guid> inst;
    for (Guid v : variants) {
      REQUIRE(run(c1, CommandId::INSERT_INSTANCE, "{\"main\":" + q(by1[v]) + ",\"x\":10,\"y\":10}") == OK);
      Clipboard clip;
      REQUIRE(c1.copySelection(clip));
      c2.setSelection({});
      REQUIRE(c2.paste(clip, true) == 1);
      inst[v] = c2.selection()[0];
    }
    Guid set2 = copyOf(c2, setKey);
    REQUIRE(set2 != kNoGuid);
    // The library's GUIDs, not c1's.
    auto by2 = variantsByPublishID(c2, set2);
    REQUIRE(by2.size() == 3);
    for (Guid v : variants) CHECK(by2.count(v) == 1);
    // The library deletes the first Default (its duplicate keeps the name and the key): the survivors keep their own
    // content, and the deleted one's instance keeps rendering it.
    lib.setSelection({ICON});
    REQUIRE(lib.command(CommandId::DELETE) == OK);
    auto m2 = publish(lib, {setKey});
    REQUIRE(c2.importLibrary(m2, opts(kLibKey, true), out) == OK);
    CHECK(c2.document().children(set2).size() == 2);
    for (Guid v : variants) {
      CAPTURE(v.toString());
      Guid main = sublayerMain(c2, inst[v]);
      REQUIRE(c2.document().has(main));
      CHECK(glyphOp(c2, main) == doctest::Approx(op[v]));
      CHECK(props(c2, main).asset().publishID == v);
    }
  }

  SUBCASE("a variant deleted and one added with the same key in one publish") {
    Editor c = load(consumerDoc(), kConsumerKey);
    std::vector<Editor::ImportedAsset> out;
    REQUIRE(c.importLibrary(m1, opts(kLibKey), out) == OK);
    Guid setCopy = copyOf(c, setKey);
    auto by = variantsByPublishID(c, setCopy);
    REQUIRE(run(c, CommandId::INSERT_INSTANCE, "{\"main\":" + q(by[ICON]) + ",\"x\":10,\"y\":10}") == OK);
    Guid inst = c.selection()[0];
    // Library: a variant added from the last one (Add variant: its key), then the first Default deleted.
    lib.setSelection({variants[2]});
    REQUIRE(lib.command(CommandId::ADD_VARIANT) == OK);
    Guid added = lib.selection()[0];
    REQUIRE(lib.setProps({lib.document().children(added)[0]}, change(F_OPACITY, [](NodeProps& p) { p.opacity = 0.1f; }), 0) == OK);
    lib.setSelection({ICON});
    REQUIRE(lib.command(CommandId::DELETE) == OK);
    auto m2 = publish(lib, {setKey});
    c.takeEvents();
    REQUIRE(c.importLibrary(m2, opts(kLibKey, true), out) == OK);
    // The new variant is a new node; the deleted one's copy isn't overwritten by it.
    Guid main = sublayerMain(c, inst);
    REQUIRE(main == by[ICON]);
    CHECK(props(c, main).asset().publishID == ICON);
    CHECK(props(c, main).name == "Property 1=Default");
    CHECK(glyphOp(c, main) == doctest::Approx(1));
    CHECK(props(c, sub(inst, {GLYPH})).opacity == doctest::Approx(1));
    auto after = variantsByPublishID(c, setCopy);
    CHECK(after.size() == 3);
    CHECK(!after.count(ICON));
    REQUIRE(after.count(added));
    CHECK(after[added] != main);
    CHECK(glyphOp(c, after[added]) == doctest::Approx(0.1));
    // It stays as a copy of its own (the removed asset's: the editor lists it as removed), out of the set.
    CHECK(c.document().parentOf(main) == kInternal);
    CHECK(c.isLibraryCopy(main));
    CHECK(props(c, main).asset().sourceLibraryKey == kLibKey);
    bool listed = false;
    for (auto& u : c.libraryUsage()) listed |= u.id == main && u.key == props(c, main).asset().key && u.usage == 1;
    CHECK(listed);
    // Not used: removed as before.
    REQUIRE(c.command(CommandId::UNDO) == OK);
    CHECK(c.document().parentOf(main) == setCopy);
    c.setSelection({inst});
    REQUIRE(c.command(CommandId::DELETE) == OK);
    REQUIRE(c.importLibrary(m2, opts(kLibKey, true), out) == OK);
    CHECK(!c.document().has(main));
    CHECK(c.document().children(setCopy).size() == 3);
  }
}

TEST_CASE("libraries (review #3): a cross-file paste of an instance of a variant the set copy here lacks brings a new copy") {
  Editor lib = load(libDoc(), kLibKey);
  makeAssets(lib);
  lib.setSelection({ICON, PRIVATE});
  REQUIRE(lib.command(CommandId::COMBINE_AS_VARIANTS) == OK);
  Guid set = lib.selection()[0];
  lib.ensureAssetKeys({});
  std::string setKey = keyOf(lib, set), button = keyOf(lib, BUTTON);
  auto m1 = publish(lib, {button});
  Editor c = load(consumerDoc(), kConsumerKey);
  std::vector<Editor::ImportedAsset> out;
  REQUIRE(c.importLibrary(m1, opts(kLibKey), out) == OK);
  Guid setCopy = copyOf(c, setKey);
  REQUIRE(run(c, CommandId::INSERT_INSTANCE, "{\"main\":" + q(copyOf(c, button)) + ",\"x\":100,\"y\":100}") == OK);
  Guid used = c.selection()[0];
  // A variant added in the library and published.
  const Guid NV{1, 70}, NVK{1, 71};
  REQUIRE(lib.applyChanges({make(NV, NodeType::SYMBOL, kPage, "~", {800, 0, 24, 24}, "Variant=Star"),
                            make(NVK, NodeType::ELLIPSE, NV, "!", {0, 0, 24, 24}, "Dot")},
                           APPLY_USER) == OK);
  REQUIRE(lib.moveNodes({NV}, set, 2) == 1);
  lib.ensureAssetKeys({});
  auto m2 = publish(lib, {setKey});

  SUBCASE("from the library") {
    REQUIRE(run(lib, CommandId::INSERT_INSTANCE, "{\"main\":" + q(NV) + ",\"x\":900,\"y\":900}") == OK);
    Clipboard clip;
    REQUIRE(lib.copySelection(clip));
    c.setSelection({});
    REQUIRE(c.paste(clip, true) == 1);
    Guid pasted = c.selection()[0];
    Guid main = sublayerMain(c, pasted);
    REQUIRE(c.document().has(main));
    CHECK(props(c, main).asset().publishID == NV);
    CHECK(c.document().children(pasted).size() == 1);
    CHECK(c.unresolvedReferences() == 0);
    CHECK(c.document().parentOf(main) != setCopy);  // a new set copy; the old one keeps its users as they were
    CHECK(c.document().children(setCopy).size() == 2);
    CHECK(c.document().children(sub(used, {NESTED})).size() == 1);
  }

  SUBCASE("from a file that has the newer copy") {
    Editor d = load(consumerDoc(), "ThirdFileKey00000004");
    REQUIRE(d.importLibrary(m2, opts(kLibKey), out) == OK);
    Guid dNV = variantsByPublishID(d, copyOf(d, setKey))[NV];
    REQUIRE(dNV != kNoGuid);
    REQUIRE(run(d, CommandId::INSERT_INSTANCE, "{\"main\":" + q(dNV) + ",\"x\":100,\"y\":100}") == OK);
    Clipboard clip;
    REQUIRE(d.copySelection(clip));
    c.setSelection({});
    REQUIRE(c.paste(clip, true) == 1);
    Guid pasted = c.selection()[0];
    Guid main = sublayerMain(c, pasted);
    REQUIRE(c.document().has(main));
    CHECK(props(c, main).asset().publishID == NV);
    CHECK(c.document().children(pasted).size() == 1);
    CHECK(c.unresolvedReferences() == 0);
    CHECK(c.document().children(setCopy).size() == 2);
  }

  SUBCASE("a clipboard without the main: counted, never silent") {
    Clipboard clip;
    clip.fileKey = "SomeOtherFileKey0009";
    NodeChange inst = make(Guid{5, 1}, NodeType::INSTANCE, Guid{5, 0}, "!", {0, 0, 24, 24}, "Lost");
    inst.props.comp().symbolData.symbolID = Guid{5, 77};
    clip.nodes = {inst};
    clip.regions = {{Guid{5, 0}, {Guid{5, 1}}, {}}};
    c.setSelection({});
    REQUIRE(c.paste(clip, true) == 1);
    CHECK(c.unresolvedReferences() == 1);
    CHECK(sublayerMain(c, c.selection()[0]) == kNoGuid);
  }
}

TEST_CASE("libraries (review #3): a main copied in from another file that lacks a variant a later paste needs is copied in again") {
  Editor lib = load(libDoc(), kLibKey);
  lib.setSelection({ICON, PRIVATE});
  REQUIRE(lib.command(CommandId::COMBINE_AS_VARIANTS) == OK);
  Guid set = lib.selection()[0];
  // Unpublished: an instance of a variant pasted elsewhere copies the set in as that file's own.
  REQUIRE(run(lib, CommandId::INSERT_INSTANCE, "{\"main\":" + q(ICON) + ",\"x\":900,\"y\":900}") == OK);
  Clipboard clip;
  REQUIRE(lib.copySelection(clip));
  Editor c = load(consumerDoc(), kConsumerKey);
  c.setSelection({});
  REQUIRE(c.paste(clip, true) == 1);
  Guid first = c.selection()[0];
  Guid copiedSet = c.document().parentOf(sublayerMain(c, first));
  REQUIRE(c.isCopiedMain(copiedSet));
  // Pasted again: the same copied-in set.
  REQUIRE(lib.copySelection(clip));
  REQUIRE(c.paste(clip, true) == 1);
  CHECK(c.document().parentOf(sublayerMain(c, c.selection()[0])) == copiedSet);
  // A variant added in the source; an instance of it pasted: the set is copied in again (the old one keeps its users).
  const Guid NV{1, 70}, NVK{1, 71};
  REQUIRE(lib.applyChanges({make(NV, NodeType::SYMBOL, kPage, "~", {800, 0, 24, 24}, "Variant=Star"),
                            make(NVK, NodeType::ELLIPSE, NV, "!", {0, 0, 24, 24}, "Dot")},
                           APPLY_USER) == OK);
  REQUIRE(lib.moveNodes({NV}, set, 2) == 1);
  REQUIRE(run(lib, CommandId::INSERT_INSTANCE, "{\"main\":" + q(NV) + ",\"x\":900,\"y\":900}") == OK);
  REQUIRE(lib.copySelection(clip));
  REQUIRE(c.paste(clip, true) == 1);
  CHECK(c.unresolvedReferences() == 0);
  Guid star = sublayerMain(c, c.selection()[0]);
  REQUIRE(c.document().has(star));
  CHECK(c.document().children(c.selection()[0]).size() == 1);
  CHECK(c.document().parentOf(star) != copiedSet);
  CHECK(c.isCopiedMain(c.document().parentOf(star)));
  CHECK(c.document().children(copiedSet).size() == 2);
  CHECK(c.document().parentOf(sublayerMain(c, first)) == copiedSet);
  // A later paste takes the newest copy.
  lib.setSelection({lib.selection()[0]});
  REQUIRE(lib.copySelection(clip));
  REQUIRE(c.paste(clip, true) == 1);
  CHECK(c.document().parentOf(sublayerMain(c, c.selection()[0])) == c.document().parentOf(star));
}

TEST_CASE("libraries (review #24): preferred instances named by key resolve in the main's own library") {
  Editor lib = load(libDoc(), kLibKey);
  makeAssets(lib);
  lib.ensureAssetKeys({});
  std::string button = keyOf(lib, BUTTON), icon = keyOf(lib, ICON);
  // A local main: its own file's asset, named by GUID or (as a .fig has it) by key.
  ComponentInfo info;
  for (const std::string& named : {ICON.toString(), icon}) {
    REQUIRE(lib.setProps({BUTTON}, change(F_COMPONENT_PROP_DEFS, [&](NodeProps& p) { p.comp().componentPropDefs = {swapProp({named})}; }), 0) == OK);
    REQUIRE(lib.componentInfo(IB, info));
    REQUIRE(info.properties.size() == 1);
    CHECK(info.properties[0].preferredValues == std::vector<Guid>{ICON});
  }
  auto m1 = publish(lib, {button});
  const char* dupKey = "DuplicatedLibKey0007";
  Editor dup = load(lib.encodeDocument(), dupKey);
  auto d1 = publish(dup, {button});
  Editor c = load(consumerDoc(), kConsumerKey);
  std::vector<Editor::ImportedAsset> out;
  // The duplicate's copies first (lower GUIDs here), then the library's.
  REQUIRE(c.importLibrary(d1, opts(dupKey), out) == OK);
  REQUIRE(c.importLibrary(m1, opts(kLibKey), out) == OK);
  auto copyIn = [&](const std::string& library, const std::string& key) {
    Guid found = kNoGuid;
    c.document().forEach([&](const Node& n) {
      if (!n.guid.isDerived() && n.props.asset().key == key && n.props.asset().sourceLibraryKey == library) found = n.guid;
    });
    return found;
  };
  Guid libButton = copyIn(kLibKey, button), dupButton = copyIn(dupKey, button);
  Guid libIcon = copyIn(kLibKey, icon), dupIcon = copyIn(dupKey, icon);
  REQUIRE(libButton != kNoGuid);
  REQUIRE(dupButton != kNoGuid);
  REQUIRE(libIcon != dupIcon);
  // The copies name it by key.
  CHECK(props(c, libButton).comp().componentPropDefs[0].preferredValues[0].key == icon);
  for (auto [main, want] : {std::pair{libButton, libIcon}, std::pair{dupButton, dupIcon}}) {
    REQUIRE(run(c, CommandId::INSERT_INSTANCE, "{\"main\":" + q(main) + ",\"x\":0,\"y\":0}") == OK);
    REQUIRE(c.componentInfo(c.selection()[0], info));
    REQUIRE(info.properties.size() == 1);
    CHECK(info.properties[0].preferredValues == std::vector<Guid>{want});
  }
}

TEST_CASE("libraries (review): BOOLEAN variables keep their type; payloads and imports report their images") {
  Editor lib = load(libDoc(), kLibKey);
  Lib l = makeAssets(lib);
  REQUIRE(run(lib, CommandId::CREATE_VARIABLE, "{\"collection\":" + q(l.set) + R"(,"type":"BOOLEAN","name":"Flag"})") == OK);
  Guid flag = lib.lastCreated()[0];
  REQUIRE(props(lib, flag).asset().variableResolvedType == VariableResolvedType::BOOLEAN);
  // An image on Icon's glyph.
  Paint ip;
  ip.type = PaintType::IMAGE;
  ip.image = ImageHash::fromHex("1111111111111111111111111111111111111111");
  REQUIRE(lib.setProps({GLYPH}, change(F_FILLS, [&](NodeProps& p) { p.fillPaints = {ip}; }), 0) == OK);
  lib.ensureAssetKeys({});
  // Save → reopen: the type is written (BOOLEAN is the absence value).
  std::string saved = messageJson(lib.encodeDocument());
  CHECK(saved.find("\"variableResolvedType\":\"BOOLEAN\"") != std::string::npos);
  Editor reopened = load(wire(lib.encodeDocument()), kLibKey);
  CHECK(props(reopened, flag).asset().variableResolvedType == VariableResolvedType::BOOLEAN);
  // Publish → import.
  std::vector<Editor::EncodedAsset> assets;
  std::vector<ImageHash> images;
  lib.encodeAssets({keyOf(lib, flag), keyOf(lib, BUTTON)}, assets, images);
  REQUIRE(assets.size() >= 2);
  CHECK(messageJson(assets[0].nodes).find("\"variableResolvedType\":\"BOOLEAN\"") != std::string::npos);
  const std::string img = "1111111111111111111111111111111111111111";
  CHECK(assets[0].images.empty());                                          // Flag
  REQUIRE(assets[1].images.size() == 1);                                    // Button (its nested Icon)
  CHECK(assets[1].images[0].hex() == img);
  REQUIRE(images.size() == 1);
  std::vector<std::vector<NodeChange>> messages;
  for (auto& a : assets) messages.push_back(wire(a.nodes));
  Editor c = load(consumerDoc(), kConsumerKey);
  std::vector<Editor::ImportedAsset> out;
  std::vector<ImageHash> used;
  REQUIRE(c.importLibrary(messages, opts(kLibKey), out, &used) == OK);
  Guid flagCopy = copyOf(c, keyOf(lib, flag));
  REQUIRE(flagCopy != kNoGuid);
  CHECK(props(c, flagCopy).asset().variableResolvedType == VariableResolvedType::BOOLEAN);
  REQUIRE(used.size() == 1);
  CHECK(used[0].hex() == img);
  // Reused copies report theirs too.
  REQUIRE(c.importLibrary(messages, opts(kLibKey), out, &used) == OK);
  CHECK(used.size() == 1);
}

// ---- The C ABI ----

using Ptr = uintptr_t;
using Handle = uintptr_t;
extern "C" {
Ptr engine_result_ptr();
uint32_t engine_result_len();
Handle engine_create(const char* selector, Ptr optsPtr, uint32_t optsLen);
void engine_destroy(Handle h);
int32_t engine_load(Handle h, Ptr ptr, uint32_t len);
int32_t engine_command(Handle h, uint32_t commandId, Ptr argsPtr, uint32_t argsLen);
int32_t engine_get_selection(Handle h);
int32_t engine_set_selection(Handle h, Ptr ptr, uint32_t len);
int32_t engine_encode_selection(Handle h, uint32_t flags);
int32_t engine_paste(Handle h, Ptr ptr, uint32_t len, uint32_t flags);
int32_t engine_component_info(Handle h, Ptr refPtr, uint32_t refLen);
int32_t engine_variable_collections(Handle h, uint32_t flags);
int32_t engine_variables(Handle h, Ptr collPtr, uint32_t collLen, uint32_t flags);
int32_t engine_styles(Handle h, uint32_t type, uint32_t flags);
int32_t engine_set_file_key(Handle h, Ptr ptr, uint32_t len);
int32_t engine_ensure_asset_keys(Handle h, Ptr refsPtr, uint32_t refsLen);
int32_t engine_local_assets(Handle h);
int32_t engine_encode_assets(Handle h, Ptr keysPtr, uint32_t keysLen);
int32_t engine_mark_published(Handle h, Ptr ptr, uint32_t len);
int32_t engine_import_library_assets(Handle h, Ptr msgPtr, uint32_t msgLen, Ptr optsPtr, uint32_t optsLen);
int32_t engine_apply_library_update(Handle h, Ptr msgPtr, uint32_t msgLen, Ptr optsPtr, uint32_t optsLen);
int32_t engine_library_usage(Handle h);
int32_t engine_apply_changes(Handle h, Ptr ptr, uint32_t len, uint32_t flags);
int32_t engine_read_nodes(Handle h, Ptr ptr, uint32_t len, uint32_t flags);
int32_t engine_set_wire_format(Handle h, uint32_t format);
int32_t engine_attachment(Handle h, uint32_t index);
}

namespace {
struct Text {
  std::string s;
  Ptr ptr() const { return reinterpret_cast<Ptr>(s.data()); }
  uint32_t len() const { return static_cast<uint32_t>(s.size()); }
};
std::string resultText() { return std::string(reinterpret_cast<const char*>(engine_result_ptr()), engine_result_len()); }
json::Value resultJson() {
  json::Value v;
  REQUIRE(json::parse(resultText(), v));
  return v;
}
Handle openFile(const std::vector<NodeChange>& nodes, const std::string& fileKey, uint32_t session) {
  Text opts{"{\"sessionID\":" + std::to_string(session) + "}"};
  Handle h = engine_create(nullptr, opts.ptr(), opts.len());
  REQUIRE(h);
  Text d{codec::writeMessage(0, nodes)};
  REQUIRE(engine_load(h, d.ptr(), d.len()) == OK);
  Text k{fileKey};
  REQUIRE(engine_set_file_key(h, k.ptr(), k.len()) == OK);
  return h;
}
const json::Value* byMember(const json::Value& list, const char* member, const std::string& value) {
  for (auto& e : list.array)
    if (auto* m = e.get(member); m && m->isString() && m->string == value) return &e;
  return nullptr;
}
}  // namespace

TEST_CASE("libraries: the C ABI — keys, local assets, payloads, publish, import, update, usage, cross-file clipboard") {
  // The library: its assets made in an Editor, then loaded into an engine.
  Editor made = load(libDoc(), kLibKey);
  Lib l = makeAssets(made);
  Handle lib = openFile(made.encodeDocument(), kLibKey, 3);
  Handle con = openFile(consumerDoc(), kConsumerKey, 4);

  // ensureAssetKeys (all), then localAssets.
  REQUIRE(engine_ensure_asset_keys(lib, 0, 0) == OK);
  json::Value keys = resultJson();
  REQUIRE(keys.isArray());
  CHECK(keys.array.size() == 7);
  const json::Value* b = byMember(keys, "id", BUTTON.toString());
  REQUIRE(b);
  std::string button = b->get("key")->string;
  CHECK(isKey(button));
  Text one{"[\"" + BUTTON.toString() + "\"]"};
  REQUIRE(engine_ensure_asset_keys(lib, one.ptr(), one.len()) == OK);
  CHECK(resultJson().array.size() == 1);
  REQUIRE(engine_local_assets(lib) == OK);
  json::Value assets = resultJson();
  CHECK(assets.array.size() == 7);
  const json::Value* ba = byMember(assets, "key", button);
  REQUIRE(ba);
  CHECK(ba->get("kind")->string == "COMPONENT");
  CHECK(ba->get("name")->string == "Button");
  CHECK(!ba->get("hiddenFromPublishing")->boolean);
  CHECK(!ba->get("softDeleted")->boolean);
  CHECK(isKey(ba->get("versionHash")->string));
  CHECK(ba->get("publishedVersion")->isNull());
  CHECK(ba->get("dependencies")->array.size() == 5);
  CHECK(ba->get("containingFrame")->get("pageName")->string == "Page 1");
  const json::Value* brandInfo = byMember(assets, "id", l.brand.toString());
  REQUIRE(brandInfo);
  CHECK(brandInfo->get("kind")->string == "VARIABLE");
  CHECK(brandInfo->get("resolvedType")->string == "COLOR");
  CHECK(brandInfo->get("collectionId")->string == l.set.toString());
  CHECK(brandInfo->get("containingFrame")->isNull());
  CHECK(byMember(assets, "id", l.style.toString())->get("styleType")->string == "FILL");

  // encodeAssets: payload Messages; markPublished.
  Text ask{"[\"" + button + "\"]"};
  REQUIRE(engine_encode_assets(lib, ask.ptr(), ask.len()) == OK);
  json::Value encoded = resultJson();
  const json::Value& list = *encoded.get("assets");
  REQUIRE(list.array.size() == 6);
  CHECK(!list.array[0].get("dependencyOnly")->boolean);
  CHECK(list.array[1].get("dependencyOnly")->boolean);
  CHECK(list.array[0].get("message")->get("type")->string == "NODE_CHANGES");
  CHECK(list.array[0].get("message")->get("nodeChanges")->array.size() == 10);
  CHECK(encoded.get("images")->array.empty());
  std::string messages = "{\"messages\":[", published = "[";
  for (size_t i = 0; i < list.array.size(); i++) {
    const json::Value& a = list.array[i];
    messages += (i ? "," : "") + json::encode(*a.get("message"));
    published += std::string(i ? "," : "") + "{\"key\":\"" + a.get("key")->string + "\",\"versionHash\":\"" + a.get("versionHash")->string + "\"}";
  }
  messages += "]}";
  published += "]";
  Text pub{published};
  REQUIRE(engine_mark_published(lib, pub.ptr(), pub.len()) == OK);
  REQUIRE(engine_local_assets(lib) == OK);
  CHECK(byMember(resultJson(), "key", button)->get("publishedVersion")->string == list.array[0].get("versionHash")->string);

  // importLibraryAssets.
  Text msg{messages}, opts{std::string("{\"libraryKey\":\"") + kLibKey + "\"}"};
  REQUIRE(engine_import_library_assets(con, msg.ptr(), msg.len(), opts.ptr(), opts.len()) == OK);
  json::Value imported = resultJson();
  CHECK(imported.get("status")->number == 0);
  const json::Value* bc = byMember(*imported.get("assets"), "key", button);
  REQUIRE(bc);
  CHECK(bc->get("kind")->string == "COMPONENT");
  CHECK(bc->get("libraryKey")->string == kLibKey);
  CHECK(bc->get("created")->boolean);
  CHECK(!bc->get("updated")->boolean);
  std::string copy = bc->get("id")->string;
  // An instance of the copy; componentInfo says where its main comes from.
  std::string insert = "{\"main\":\"" + copy + "\"}";
  Text ins{insert};
  REQUIRE(engine_command(con, static_cast<uint32_t>(CommandId::INSERT_INSTANCE), ins.ptr(), ins.len()) == OK);
  REQUIRE(engine_get_selection(con) == OK);
  std::string inst = resultJson().get("refs")->array[0].string;
  Text ref{inst};
  REQUIRE(engine_component_info(con, ref.ptr(), ref.len()) == OK);
  json::Value info = resultJson();
  const json::Value* remote = info.get("main")->get("remote");
  REQUIRE(remote->isObject());
  CHECK(remote->get("libraryKey")->string == kLibKey);
  CHECK(remote->get("key")->string == button);
  CHECK(!info.get("main")->get("copied")->boolean);
  CHECK(!info.get("canPush")->boolean);
  // Reads: local only unless INCLUDE_REMOTE.
  REQUIRE(engine_variable_collections(con, 0) == OK);
  CHECK(resultJson().array.empty());
  REQUIRE(engine_variable_collections(con, 1) == OK);
  json::Value cols = resultJson();
  REQUIRE(cols.array.size() == 1);
  CHECK(cols.array[0].get("remote")->boolean);
  CHECK(cols.array[0].get("libraryKey")->string == kLibKey);
  REQUIRE(engine_variables(con, 0, 0, 1) == OK);
  CHECK(resultJson().array.size() == 2);
  REQUIRE(engine_styles(con, 0, 0) == OK);
  CHECK(resultJson().array.empty());
  REQUIRE(engine_styles(con, 0, 1) == OK);
  CHECK(resultJson().array[0].get("remote")->boolean);
  // libraryUsage.
  REQUIRE(engine_library_usage(con) == OK);
  json::Value usage = resultJson();
  CHECK(usage.array.size() == 6);
  const json::Value* bu = byMember(usage, "key", button);
  REQUIRE(bu);
  CHECK(bu->get("usageCount")->number == 1);
  CHECK(bu->get("libraryKey")->string == kLibKey);
  CHECK(bu->get("publishID")->string == BUTTON.toString());
  CHECK(bu->get("version")->string == list.array[0].get("versionHash")->string);
  // applyLibraryUpdate (nothing new: OK, nothing updated).
  Text upd{std::string("{\"libraryKey\":\"") + kLibKey + "\",\"keys\":[\"" + button + "\"],\"redirects\":[]}"};
  REQUIRE(engine_apply_library_update(con, msg.ptr(), msg.len(), upd.ptr(), upd.len()) == OK);
  CHECK(!byMember(*resultJson().get("assets"), "key", button)->get("updated")->boolean);
  Text bad{"{}"};
  CHECK(engine_import_library_assets(con, msg.ptr(), msg.len(), bad.ptr(), bad.len()) == E_INVALID);

  // The clipboard carries the file and the cut; a paste in another file brings the library copy.
  Text sel{"[\"" + IB.toString() + "\"]"};
  REQUIRE(engine_set_selection(lib, sel.ptr(), sel.len()) == OK);
  REQUIRE(engine_encode_selection(lib, 1) == OK);
  std::string clip = resultText();
  json::Value clipJson = resultJson();
  CHECK(clipJson.get("pasteFileKey")->string == kLibKey);
  CHECK(clipJson.get("isCut")->boolean);
  REQUIRE(engine_encode_selection(lib, 0) == OK);
  clip = resultText();
  CHECK(resultJson().get("isCut") == nullptr);
  Text c{clip};
  REQUIRE(engine_paste(con, c.ptr(), c.len(), 1) == 1);
  REQUIRE(engine_library_usage(con) == OK);
  CHECK(byMember(resultJson(), "key", button)->get("usageCount")->number == 2);

  engine_destroy(lib);
  engine_destroy(con);
}

TEST_CASE("libraries (review): the C ABI — asNew, copies, fromLibraryKey, images, null versionHash, APPLY_SYSTEM / APPLY_EXACT") {
  Editor made = load(libDoc(), kLibKey);
  makeAssets(made);
  Paint ip;
  ip.type = PaintType::IMAGE;
  ip.image = ImageHash::fromHex("2222222222222222222222222222222222222222");
  REQUIRE(made.setProps({GLYPH}, change(F_FILLS, [&](NodeProps& p) { p.fillPaints = {ip}; }), 0) == OK);
  Handle lib = openFile(made.encodeDocument(), kLibKey, 3);
  Handle con = openFile(consumerDoc(), kConsumerKey, 4);
  REQUIRE(engine_ensure_asset_keys(lib, 0, 0) == OK);
  std::string button = byMember(resultJson(), "id", BUTTON.toString())->get("key")->string;
  auto encode = [&](const std::string& key, std::string& messages, std::string& hash) {
    Text ask{"[\"" + key + "\"]"};
    REQUIRE(engine_encode_assets(lib, ask.ptr(), ask.len()) == OK);
    json::Value encoded = resultJson();
    const json::Value& list = *encoded.get("assets");
    REQUIRE(list.array.size() == 6);
    // Each asset's own images; the union beside them.
    CHECK(list.array[0].get("images")->array.size() == 1);
    CHECK(list.array[0].get("images")->array[0].string == ip.image.hex());
    CHECK(encoded.get("images")->array.size() == 1);
    messages = "{\"messages\":[";
    for (size_t i = 0; i < list.array.size(); i++) messages += (i ? "," : "") + json::encode(*list.array[i].get("message"));
    messages += "]}";
    hash = list.array[0].get("versionHash")->string;
  };
  std::string m1, h1;
  encode(button, m1, h1);
  Text pub{"[{\"key\":\"" + button + "\",\"versionHash\":\"" + h1 + "\"}]"};
  REQUIRE(engine_mark_published(lib, pub.ptr(), pub.len()) == OK);

  // Import: the images the copies use.
  Text msg1{m1}, opts{std::string("{\"libraryKey\":\"") + kLibKey + "\"}"};
  REQUIRE(engine_import_library_assets(con, msg1.ptr(), msg1.len(), opts.ptr(), opts.len()) == OK);
  json::Value imported = resultJson();
  REQUIRE(imported.get("images")->array.size() == 1);
  CHECK(imported.get("images")->array[0].string == ip.image.hex());
  std::string oldCopy = byMember(*imported.get("assets"), "key", button)->get("id")->string;
  // asNew: a second, complete copy.
  Text fresh{std::string("{\"libraryKey\":\"") + kLibKey + "\",\"asNew\":true}"};
  REQUIRE(engine_import_library_assets(con, msg1.ptr(), msg1.len(), fresh.ptr(), fresh.len()) == OK);
  json::Value second = resultJson();
  const json::Value* nb = byMember(*second.get("assets"), "key", button);
  REQUIRE(nb);
  std::string newCopy = nb->get("id")->string;
  CHECK(newCopy != oldCopy);
  CHECK(nb->get("created")->boolean);
  Text read{"[\"" + newCopy + "\"]"};
  REQUIRE(engine_read_nodes(con, read.ptr(), read.len(), 1) == OK);
  CHECK(resultJson().get("nodeChanges")->array[0].get("childIds")->array.size() == 3);
  REQUIRE(engine_library_usage(con) == OK);
  size_t buttons = 0;
  for (auto& u : resultJson().array) buttons += u.get("key")->string == button;
  CHECK(buttons == 2);

  // A new version; an update restricted to the new copy.
  Text label{"[{\"guid\":\"" + LABEL.toString() + "\",\"textData\":{\"characters\":\"v2\"}}]"};
  std::string change = "{\"type\":\"NODE_CHANGES\",\"sessionID\":3,\"nodeChanges\":" + label.s + "}";
  Text ch{change};
  REQUIRE(engine_apply_changes(lib, ch.ptr(), ch.len(), 1) == OK);
  std::string m2, h2;
  encode(button, m2, h2);
  CHECK(h2 != h1);
  Text msg2{m2}, only{std::string("{\"libraryKey\":\"") + kLibKey + "\",\"keys\":[\"" + button + "\"],\"copies\":[\"" + newCopy + "\"]}"};
  REQUIRE(engine_apply_library_update(con, msg2.ptr(), msg2.len(), only.ptr(), only.len()) == OK);
  json::Value upd = resultJson();
  CHECK(byMember(*upd.get("assets"), "id", newCopy)->get("updated")->boolean);
  Text both{"[\"" + oldCopy + "\",\"" + newCopy + "\"]"};
  REQUIRE(engine_read_nodes(con, both.ptr(), both.len(), 0) == OK);
  json::Value nodes = resultJson();
  CHECK(byMember(*nodes.get("nodeChanges"), "guid", oldCopy)->get("version")->string == h1);
  CHECK(byMember(*nodes.get("nodeChanges"), "guid", newCopy)->get("version")->string == h2);
  // A redirect from another library's copies (fromLibraryKey) matches none here; the update of the key brings every
  // copy of it here up to date, the old one too.
  Text other{std::string("{\"libraryKey\":\"") + kLibKey + "\",\"keys\":[\"" + button + "\"],\"redirects\":[{\"fromKey\":\"" + button +
             "\",\"toKey\":\"" + button + "\",\"fromLibraryKey\":\"SomeOtherLibrary0008\"}]}"};
  REQUIRE(engine_apply_library_update(con, msg2.ptr(), msg2.len(), other.ptr(), other.len()) == OK);
  REQUIRE(engine_read_nodes(con, both.ptr(), both.len(), 0) == OK);
  CHECK(byMember(*resultJson().get("nodeChanges"), "guid", oldCopy)->get("version")->string == h2);

  // markPublished with a null versionHash: no longer published.
  Text removed{"[{\"key\":\"" + button + "\",\"versionHash\":null}]"};
  REQUIRE(engine_mark_published(lib, removed.ptr(), removed.len()) == OK);
  REQUIRE(engine_local_assets(lib) == OK);
  CHECK(byMember(resultJson(), "key", button)->get("publishedVersion")->isNull());

  // APPLY_SYSTEM (8): written, not into copies; APPLY_EXACT (16) with APPLY_USER: into copies too.
  std::string rename = "{\"type\":\"NODE_CHANGES\",\"sessionID\":4,\"nodeChanges\":[{\"guid\":\"" + oldCopy +
                       "\",\"name\":\"Renamed\"},{\"guid\":\"" + RECT.toString() + "\",\"name\":\"System\"}]}";
  Text rn{rename};
  REQUIRE(engine_apply_changes(con, rn.ptr(), rn.len(), 8) == OK);
  Text two{"[\"" + oldCopy + "\",\"" + RECT.toString() + "\"]"};
  REQUIRE(engine_read_nodes(con, two.ptr(), two.len(), 0) == OK);
  json::Value after = resultJson();
  CHECK(byMember(*after.get("nodeChanges"), "guid", oldCopy)->get("name")->string == "Button");
  CHECK(byMember(*after.get("nodeChanges"), "guid", RECT.toString())->get("name")->string == "System");
  REQUIRE(engine_apply_changes(con, rn.ptr(), rn.len(), 1 | 16) == OK);
  REQUIRE(engine_read_nodes(con, two.ptr(), two.len(), 0) == OK);
  CHECK(byMember(*resultJson().get("nodeChanges"), "guid", oldCopy)->get("name")->string == "Renamed");

  engine_destroy(lib);
  engine_destroy(con);
}

TEST_CASE("libraries: the C ABI with kiwi payloads — encode_assets attachments, a message list import") {
  Editor made = load(libDoc(), kLibKey);
  Lib l = makeAssets(made);
  (void)l;
  Handle lib = openFile(made.encodeDocument(), kLibKey, 3);
  Handle con = openFile(consumerDoc(), kConsumerKey, 4);
  REQUIRE(engine_set_wire_format(lib, 1) == OK);
  REQUIRE(engine_ensure_asset_keys(lib, 0, 0) == OK);
  json::Value keys = resultJson();
  const json::Value* b = byMember(keys, "id", BUTTON.toString());
  REQUIRE(b);
  std::string button = b->get("key")->string;
  // The payloads come as attachments (kiwi Messages, sessionID 0), referred to by index.
  Text ask{"[\"" + button + "\"]"};
  REQUIRE(engine_encode_assets(lib, ask.ptr(), ask.len()) == OK);
  json::Value encoded = resultJson();
  const json::Value& list = *encoded.get("assets");
  REQUIRE(list.array.size() == 6);
  CHECK(list.array[0].get("message") == nullptr);
  std::vector<std::string> payloads;
  for (auto& a : list.array) {
    REQUIRE(a.get("payload"));
    REQUIRE(engine_attachment(lib, static_cast<uint32_t>(a.get("payload")->number)) == OK);
    payloads.push_back(resultText());
  }
  codec::KiwiMessage first;
  REQUIRE(codec::readMessage(payloads[0], first));
  CHECK(first.sessionID == 0);
  CHECK(first.changes.size() == 10);
  // Imported from a kiwi message list.
  Text msg{codec::writeMessageList(payloads)}, opts{std::string("{\"libraryKey\":\"") + kLibKey + "\"}"};
  REQUIRE(engine_import_library_assets(con, msg.ptr(), msg.len(), opts.ptr(), opts.len()) == OK);
  json::Value imported = resultJson();
  CHECK(imported.get("status")->number == 0);
  const json::Value* bc = byMember(*imported.get("assets"), "key", button);
  REQUIRE(bc);
  CHECK(bc->get("kind")->string == "COMPONENT");
  CHECK(bc->get("created")->boolean);
  // One kiwi Message alone is a payload too (the copy is reused).
  Text single{payloads[0]};
  REQUIRE(engine_import_library_assets(con, single.ptr(), single.len(), opts.ptr(), opts.len()) == OK);
  json::Value importedAgain = resultJson();
  const json::Value* again = byMember(*importedAgain.get("assets"), "key", button);
  REQUIRE(again);
  CHECK(!again->get("created")->boolean);
  CHECK(again->get("id")->string == bc->get("id")->string);
  engine_destroy(lib);
  engine_destroy(con);
}
