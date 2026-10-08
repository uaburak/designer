// The generated kiwi codecs compile and work (docs/schema.md §2.2): a Message
// through the tree codec and back, the visitor codec re-encoding it byte for
// byte, and the engine's field ids agreeing with the generated registry.
#include <cmath>
#include <cstring>
#include <string_view>

#include "doctest.h"
#include "kiwi.h"
#include "scene/Node.h"
#include "schema/document.stream.h"
#include "schema/node_fields.h"

using namespace eng;

TEST_CASE("kiwi: a Message round-trips through the tree codec and the stream codec") {
  kiwi::MemoryPool pool;
  schema::Message m;
  m.set_type(schema::MessageType::NODE_CHANGES);
  m.set_sessionID(7);
  schema::NodeChange& n = m.set_nodeChanges(pool, 1)[0];
  schema::GUID guid;
  guid.set_sessionID(1);
  guid.set_localID(2);
  n.set_guid(&guid);
  n.set_phase(schema::NodePhase::CREATED);
  n.set_type(schema::NodeType::FRAME);
  n.set_name(kiwi::String("Frame 1"));
  schema::Vector size;
  size.set_x(100);
  size.set_y(50.5f);
  n.set_size(&size);
  n.set_stackMode(schema::StackMode::HORIZONTAL);
  n.set_stackSpacing(8);

  kiwi::ByteBuffer bb;
  REQUIRE(m.encode(bb));
  CHECK(bb.size() > 0);

  kiwi::ByteBuffer in(bb.data(), bb.size());
  kiwi::MemoryPool pool2;
  schema::Message back;
  REQUIRE(back.decode(in, pool2));
  REQUIRE(back.sessionID());
  CHECK(*back.sessionID() == 7);
  REQUIRE(back.nodeChanges());
  REQUIRE(back.nodeChanges()->size() == 1);
  schema::NodeChange& b = (*back.nodeChanges())[0];
  CHECK(*b.guid()->localID() == 2);
  CHECK(*b.type() == schema::NodeType::FRAME);
  CHECK(std::string_view(b.name()->c_str()) == "Frame 1");
  CHECK(*b.size()->y() == doctest::Approx(50.5));
  CHECK(*b.stackMode() == schema::StackMode::HORIZONTAL);
  CHECK(b.opacity() == nullptr);  // absent stays absent

  // The visitor codec: parse the bytes into its Writer, which writes them again.
  kiwi::ByteBuffer again(bb.data(), bb.size());
  kiwi::ByteBuffer copy;
  schema_stream::Writer writer(copy);
  REQUIRE(schema_stream::parseMessage(again, writer));
  REQUIRE(copy.size() == bb.size());
  CHECK(std::memcmp(copy.data(), bb.data(), bb.size()) == 0);
}

TEST_CASE("kiwi: the engine's kiwi field ids are the generated registry's") {
  auto nameOf = [](uint32_t id) -> std::string_view {
    for (const auto& f : schema::kNodeFields)
      if (f.id == id) return f.name;
    return {};
  };
  struct {
    Field field;
    const char* name;
  } expected[] = {
      {F_NAME, "name"}, {F_VISIBLE, "visible"}, {F_LOCKED, "locked"}, {F_OPACITY, "opacity"}, {F_TRANSFORM, "transform"},
      {F_SIZE, "size"}, {F_FILLS, "fillPaints"}, {F_STROKES, "strokePaints"}, {F_STROKE_WEIGHT, "strokeWeight"},
      {F_STROKE_ALIGN, "strokeAlign"}, {F_FRAME_MASK_DISABLED, "frameMaskDisabled"}, {F_RESIZE_TO_FIT, "resizeToFit"},
      {F_BACKGROUND_COLOR, "backgroundColor"}, {F_BACKGROUND_ENABLED, "backgroundEnabled"}, {F_INTERNAL_ONLY, "internalOnly"},
      {F_STACK_MODE, "stackMode"}, {F_STACK_SPACING, "stackSpacing"}, {F_STACK_PADDING_LEFT, "stackHorizontalPadding"},
      {F_STACK_PADDING_TOP, "stackVerticalPadding"}, {F_STACK_PADDING_RIGHT, "stackPaddingRight"},
      {F_STACK_PADDING_BOTTOM, "stackPaddingBottom"}, {F_STACK_PRIMARY_SIZING, "stackPrimarySizing"},
      {F_STACK_COUNTER_SIZING, "stackCounterSizing"}, {F_STACK_PRIMARY_ALIGN, "stackPrimaryAlignItems"},
      {F_STACK_COUNTER_ALIGN, "stackCounterAlignItems"}, {F_STACK_COUNTER_ALIGN_CONTENT, "stackCounterAlignContent"},
      {F_STACK_WRAP, "stackWrap"}, {F_STACK_COUNTER_SPACING, "stackCounterSpacing"}, {F_STACK_REVERSE_Z, "stackReverseZIndex"},
      {F_BORDERS_TAKE_SPACE, "bordersTakeSpace"}, {F_STACK_CHILD_GROW, "stackChildPrimaryGrow"},
      {F_STACK_CHILD_ALIGN_SELF, "stackChildAlignSelf"}, {F_STACK_POSITIONING, "stackPositioning"}, {F_MIN_SIZE, "minSize"},
      {F_MAX_SIZE, "maxSize"}, {F_H_CONSTRAINT, "horizontalConstraint"}, {F_V_CONSTRAINT, "verticalConstraint"},
      {F_PROPORTIONS_CONSTRAINED, "proportionsConstrained"},
      {F_TEXT_DATA, "textData"}, {F_FONT_NAME, "fontName"}, {F_FONT_SIZE, "fontSize"}, {F_LINE_HEIGHT, "lineHeight"},
      {F_LETTER_SPACING, "letterSpacing"}, {F_PARAGRAPH_SPACING, "paragraphSpacing"}, {F_PARAGRAPH_INDENT, "paragraphIndent"},
      {F_TEXT_ALIGN_H, "textAlignHorizontal"}, {F_TEXT_ALIGN_V, "textAlignVertical"}, {F_TEXT_AUTO_RESIZE, "textAutoResize"},
      {F_TEXT_TRUNCATION, "textTruncation"}, {F_MAX_LINES, "maxLines"}, {F_TEXT_CASE, "textCase"},
      {F_TEXT_DECORATION, "textDecoration"}, {F_AUTO_RENAME, "autoRename"},
  };
  for (auto& e : expected) {
    INFO(e.name);
    CHECK(nameOf(kiwiFieldId(e.field)) == e.name);
  }
  CHECK(nameOf(static_cast<uint32_t>(schema::NodeField::stackMode)) == "stackMode");
}

// ---- The engine's own kiwi codec (scene/CodecKiwi; docs/engine-build.md "Figma parity round 3") ----------------

#include "Helpers.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"
#include "schema/SchemaTable.h"

namespace {

using namespace eng::test;

VariableData aliasTo(Guid g) { return VariableData::aliasOf(g, VariableResolvedType::COLOR); }

json::Value parsed(const char* text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  return v;
}

// Every modelled field set to a value that is not its absence value (floats exactly representable in f32: kiwi
// stores floats as Figma's files do, in 32 bits).
NodeProps fullProps() {
  NodeProps p = defaultProps(NodeType::FRAME);
  p.name = "Full";
  p.visible = false;
  p.locked = true;
  p.opacity = 0.5;
  p.transform = {0.5, -0.25, 10, 0.25, 0.5, -20};
  p.size = {120, 80};
  Paint image;
  image.type = PaintType::IMAGE;
  image.color = Color{0, 0, 0, 1};
  image.opacity = 0.75f;
  image.visible = false;
  image.blendMode = BlendMode::SCREEN;
  image.transform = {2, 0, 0.5, 0, 2, 0.25};
  image.image = ImageHash::fromHex("0123456789abcdef0123456789abcdef01234567");
  image.imageName = "photo.png";
  image.imageScaleMode = ImageScaleMode::TILE;
  image.rotation = 90;
  image.scale = 0.5f;
  image.paintFilter.exposure = 0.25f;
  image.paintFilter.vibrance = -0.5f;
  image.originalImageWidth = 640;
  image.originalImageHeight = 480;
  image.extra = codec::extraFromJson("Paint", "thumbHash", parsed("[1,2,3,250]"));
  Paint gradient;
  gradient.type = PaintType::GRADIENT_LINEAR;
  gradient.stops = {{Color{0, 0, 0, 1}, 0}, {Color{1, 1, 1, 1}, 1}};
  gradient.transform = {1, 0, 0, 0, 1, 0.5};
  gradient.stopVars = {VariableData{}, aliasTo({5, 4})};
  gradient.opacityVar = VariableData::aliasOf({5, 6}, VariableResolvedType::FLOAT);
  Paint solid = Paint::solid(Color{1, 0, 0, 1}, 0.25f);
  solid.colorVar = VariableData::composeColor(aliasTo({5, 4}), VariableData::number(50));
  p.fillPaints = {solid, gradient, image};
  p.strokePaints = {Paint::solid(Color{0, 0, 1, 1})};
  p.strokeWeight = 2;
  p.strokeAlign = StrokeAlign::OUTSIDE;
  p.cornerRadii = {1, 2, 3, 4};
  p.frameMaskDisabled = true;
  p.rare().backgroundColor = Color{0.5f, 0.25f, 0.75f, 1};
  p.rare().backgroundEnabled = true;
  p.rare().internalOnly = true;
  p.parentIndex = {kPage, "Qd&"};
  p.blendMode = BlendMode::MULTIPLY;
  p.mask = true;
  p.maskType = MaskType::LUMINANCE;
  p.strokeCap = StrokeCap::ROUND;
  p.strokeJoin = StrokeJoin::BEVEL;
  p.miterLimit = 7;
  p.stroke().dashPattern = {4, 2};
  p.stroke().borderWeights = {1, 2, 3, 4};
  p.stroke().borderStrokeWeightsIndependent = true;
  p.stroke().cornerSmoothing = 0.75;
  Effect shadow;
  shadow.type = EffectType::DROP_SHADOW;
  shadow.color = Color{0, 0, 0, 0.5f};
  shadow.offset = {2, 4};
  shadow.radius = 8;
  shadow.visible = false;
  shadow.blendMode = BlendMode::DARKEN;
  shadow.spread = 1;
  shadow.showShadowBehindNode = true;
  shadow.radiusVar = VariableData::aliasOf({5, 6}, VariableResolvedType::FLOAT);
  shadow.extra = codec::extraFromJson("Effect", "blurOpType", parsed("\"PROGRESSIVE\""));
  p.effects = {shadow};
  p.shape().count = 5;
  p.shape().starInnerScale = 0.375;
  p.shape().arcData = {0.125, 3, 0.5};
  p.shape().vectorData.present = true;
  p.shape().vectorData.network = std::make_shared<std::vector<uint8_t>>(std::vector<uint8_t>{1, 2, 3, 4, 5});
  p.shape().vectorData.normalizedSize = {10, 20};
  VectorStyle vs;
  vs.styleID = 1;
  vs.mask = VS_FILLS | VS_STROKE_CAP | VS_CORNER_RADIUS;
  vs.fillPaints = {Paint::solid(Color{0, 1, 0, 1})};
  vs.strokeCap = StrokeCap::SQUARE;
  vs.cornerRadius = 3;
  vs.extra = codec::extraFromJson("NodeChange", "strokeWeight", parsed("3"));
  p.shape().vectorData.styleOverrideTable = {vs};
  p.shape().handleMirroring = VectorMirror::ANGLE;
  p.shape().booleanOperation = BooleanOperation::SUBTRACT;
  LayoutGrid grid;
  grid.type = LayoutGridType::STRETCH;
  grid.axis = Axis::Y;
  grid.visible = false;
  grid.numSections = 4;
  grid.offset = 8;
  grid.sectionSize = 60;
  grid.gutterSize = 16;
  grid.color = Color{1, 0, 0, 0.25f};
  grid.pattern = LayoutGridPattern::GRID;
  grid.gutterSizeVar = VariableData::aliasOf({5, 6}, VariableResolvedType::FLOAT);
  p.rare().layoutGrids = {grid};
  p.stack().stackMode = StackMode::HORIZONTAL;
  p.stack().stackSpacing = 8;
  p.stack().stackPaddingLeft = 1;
  p.stack().stackPaddingTop = 2;
  p.stack().stackPaddingRight = 3;
  p.stack().stackPaddingBottom = 4;
  p.stack().stackPrimarySizing = StackSize::FIXED;
  p.stack().stackCounterSizing = StackSize::RESIZE_TO_FIT;
  p.stack().stackPrimaryAlignItems = StackJustify::SPACE_BETWEEN;
  p.stack().stackCounterAlignItems = StackAlign::MAX;
  p.stack().stackCounterAlignContent = StackCounterAlignContent::SPACE_BETWEEN;
  p.stack().stackWrap = StackWrap::WRAP;
  p.stack().stackCounterSpacing = 12;
  p.stack().stackReverseZIndex = true;
  p.stack().bordersTakeSpace = true;
  p.stackChildPrimaryGrow = 1;
  p.stackChildAlignSelf = StackCounterAlign::STRETCH;
  p.stackPositioning = StackPositioning::ABSOLUTE;
  p.rare().minSize = {1, 2};
  p.rare().maxSize = {3, 4};
  p.horizontalConstraint = ConstraintType::SCALE;
  p.verticalConstraint = ConstraintType::STRETCH;
  p.proportionsConstrained = true;
  p.text().textData.characters = "Hi\nthere";
  p.text().textData.characterStyleIDs = {0, 1, 1};
  TextStyle run;
  run.styleID = 1;
  run.mask = R_FONT_NAME | R_FONT_SIZE | R_LINE_HEIGHT | R_LETTER_SPACING | R_TEXT_CASE | R_TEXT_DECORATION | R_FILLS;
  run.fontName = {"Inter", "Bold", "Inter-Bold"};
  run.fontSize = 32;
  run.lineHeight = {1.5, NumberUnits::RAW};
  run.letterSpacing = {2, NumberUnits::PIXELS};
  run.textCase = TextCase::LOWER;
  run.textDecoration = TextDecoration::STRIKETHROUGH;
  run.fillPaints = {Paint::solid(Color{1, 1, 0, 1})};
  run.extra = codec::extraFromJson("NodeChange", "isOverrideOverTextStyle", parsed("true"));
  p.text().textData.styleOverrideTable = {run};
  // Raw sequences are kept in field-id order (what every writer's bytes read into).
  p.text().textData.lines = {codec::extraFromJson("TextLineData", "lineType", parsed("\"ORDERED_LIST\"")) + codec::extraFromJson("TextLineData", "indentationLevel", parsed("2"))};
  p.text().fontName = {"Inter", "Medium", "Inter-Medium"};
  p.text().fontSize = 24;
  p.text().lineHeight = {1.5, NumberUnits::RAW};
  p.text().letterSpacing = {5, NumberUnits::PERCENT};
  p.text().paragraphSpacing = 4;
  p.text().paragraphIndent = 2;
  p.text().textAlignHorizontal = TextAlignHorizontal::CENTER;
  p.text().textAlignVertical = TextAlignVertical::BOTTOM;
  p.text().textAutoResize = TextAutoResize::HEIGHT;
  p.text().textTruncation = TextTruncation::ENDING;
  p.text().maxLines = 3;
  p.text().textCase = TextCase::UPPER;
  p.text().textDecoration = TextDecoration::UNDERLINE;
  p.text().autoRename = true;
  p.overrideKey = {1, 9};
  p.comp().symbolData.symbolID = {2, 1};
  SymbolOverride root;
  root.mask = F_NAME | F_FILLS;
  root.props.name = "Root";
  root.props.fillPaints = {Paint::solid(Color{0, 0, 0, 1})};
  SymbolOverride deep;
  deep.path = {{3, 1}, {3, 2}};
  deep.mask = F_VISIBLE | F_TEXT_DATA | F_PARAM_MAP | F_EXTRA | F_OVERRIDDEN_SYMBOL_ID;
  deep.props.visible = false;
  deep.props.text().textData.characters = "Label";
  ParamBinding unbind;
  unbind.field = VariableField::OPACITY;
  deep.props.parameterConsumptionMap = {unbind};
  deep.props.comp().overriddenSymbolID = {2, 7};
  deep.props.extra["exportSettings"] = codec::extraFromJson("NodeChange", "exportSettings", parsed("[{\"suffix\":\"@3x\"}]"));
  p.comp().symbolData.overrides = {root, deep};
  p.comp().symbolData.uniformScaleFactor = 2;
  p.comp().overriddenSymbolID = {2, 5};
  ComponentPropDef boolDef;
  boolDef.id = {4, 1};
  boolDef.name = "Show";
  boolDef.initialValue.hasBool = true;
  boolDef.initialValue.boolValue = true;
  boolDef.sortPosition = "!";
  boolDef.type = ComponentPropType::BOOL;
  ComponentPropDef swapDef;
  swapDef.id = {4, 2};
  swapDef.name = "Icon";
  swapDef.initialValue.guidValue = {2, 3};
  swapDef.type = ComponentPropType::INSTANCE_SWAP;
  swapDef.preferredValues = {{false, "k1"}, {true, "s1"}};
  swapDef.preferredExtra = codec::extraFromJson("ComponentPropPreferredValues", "stringValues", parsed("[\"a\",\"b\"]"));
  swapDef.description = "The icon";
  swapDef.extra = codec::extraFromJson("ComponentPropDef", "slotPropConfig", parsed("{\"minChildren\":1}"));
  ComponentPropDef textDef;
  textDef.id = {4, 3};
  textDef.name = "Label";
  textDef.initialValue.hasText = true;
  textDef.initialValue.textValue.characters = "Button";
  textDef.type = ComponentPropType::TEXT;
  p.comp().componentPropDefs = {boolDef, swapDef, textDef};
  ComponentPropAssignment assign;
  assign.defID = {4, 3};
  assign.value.hasText = true;
  assign.value.textValue.characters = "Go";
  assign.extra = codec::extraFromJson("ComponentPropAssignment", "varValue", parsed("{\"value\":{\"floatValue\":1},\"dataType\":\"FLOAT\",\"resolvedDataType\":\"FLOAT\"}"));
  p.comp().componentPropAssignments = {assign};
  ParamBinding opacity;
  opacity.field = VariableField::OPACITY;
  opacity.data = VariableData::aliasOf({5, 6}, VariableResolvedType::FLOAT);
  ParamBinding visible;
  visible.field = VariableField::VISIBLE;
  visible.propRef = {4, 1};
  ParamBinding font;
  font.field = VariableField::FONT_STYLE;
  font.data.kind = VariableData::Kind::FONT_STYLE;
  font.data.hasDataType = font.data.hasResolvedType = true;
  font.data.dataType = VariableDataType::FONT_STYLE;
  font.data.resolvedDataType = VariableResolvedType::FONT_STYLE;
  font.data.args = {VariableData::aliasOf({5, 7}, VariableResolvedType::STRING)};
  p.parameterConsumptionMap = {opacity, visible, font};
  p.comp().isStateGroup = true;
  p.comp().variantPropSpecs = {{{4, 5}, "Primary"}};
  p.comp().stateGroupPropertyValueOrders = {{"Type", {"Primary", "Secondary"}}};
  p.comp().propsAreBubbled = true;
  p.comp().isSlot = true;
  p.comp().isSlotContent = true;
  p.comp().detachedSymbolId = AssetId::of({2, 9});
  p.comp().isSoftDeleted = true;
  p.comp().ancestorPathBeforeDeletion = {{0, 1}, {1, 1}};
  p.refs().variableModeBySetMap = {{AssetId::of({5, 1}), {5, 3}}};
  p.refs().styleIdForFill = AssetId::of({6, 1});
  p.refs().styleIdForStrokeFill.key = "stroke-key";
  p.refs().styleIdForStrokeFill.version = "3:4";
  p.refs().styleIdForEffect = AssetId::of({6, 2});
  p.refs().styleIdForGrid = AssetId::of({6, 3});
  p.asset().styleType = StyleType::FILL;
  p.asset().sortPosition = "#";
  p.asset().description = "A description";
  p.asset().key = "0123456789abcdef0123456789abcdef01234567";
  p.asset().isPublishable = false;
  p.asset().variableSetModes = {{{5, 2}, "Light", "!", {}, kNoGuid}, {{5, 3}, "Dark", "\"", {}, kNoGuid}};
  p.asset().variableSetID = AssetId::of({5, 1});
  p.asset().variableResolvedType = VariableResolvedType::COLOR;
  VariableData expr;
  expr.kind = VariableData::Kind::EXPRESSION;
  expr.function = ExpressionFunction::COMPOSE_COLOR;
  expr.args = {aliasTo({5, 9}), VariableData::number(50)};
  expr.hasDataType = expr.hasResolvedType = true;
  expr.dataType = VariableDataType::EXPRESSION;
  expr.resolvedDataType = VariableResolvedType::COLOR;
  p.asset().variableDataValues = {{{5, 2}, VariableData::color(Color{1, 0, 0, 1})}, {{5, 3}, expr}};
  p.asset().variableScopes = std::vector<VariableScope>{VariableScope::ALL_FILLS, VariableScope::STROKE};
  p.asset().codeSyntax = {{CodeSyntaxPlatform::WEB, "--bg"}};
  p.asset().version = "v-hash";
  p.asset().publishedVersion = "p-hash";
  p.asset().sourceLibraryKey = "lib-key";
  p.asset().publishID = {7, 7};
  p.asset().libraryMoveInfo = {"old-key", "paste-file"};
  p.extra["exportSettings"] = codec::extraFromJson("NodeChange", "exportSettings", parsed("[{\"suffix\":\"@2x\",\"imageType\":\"PNG\"}]"));
  p.extra["isSymbolPublishable"] = codec::extraFromJson("NodeChange", "isSymbolPublishable", parsed("false"));
  p.extra["backgroundOpacity"] = codec::extraFromJson("NodeChange", "backgroundOpacity", parsed("0.5"));
  return p;
}

std::string jsonOf(const Node& n) {
  json::Writer w;
  codec::BlobsOut blobs;
  codec::writeNode(w, n, &blobs);
  return w.take();
}

}  // namespace

TEST_CASE("kiwi codec: every modelled field round-trips NodeProps → Message bytes → NodeProps") {
  NodeProps full = fullProps();
  std::vector<NodeChange> changes{NodeChange::created({1, 2}, full), NodeChange::removed({1, 3})};
  std::string bytes = codec::writeMessage(42, changes);
  CHECK(codec::looksKiwi(bytes));
  codec::KiwiMessage back;
  REQUIRE(codec::readMessage(bytes, back));
  CHECK(back.sessionID == 42);
  REQUIRE(back.changes.size() == 2);
  CHECK(back.changes[0].guid == Guid{1, 2});
  CHECK(back.changes[0].phase == Phase::CREATED);
  CHECK(back.changes[1].phase == Phase::REMOVED);
  const NodeProps& q = back.changes[0].props;
  FieldMask diff = differingFields(q, full);
  for (const std::string& k : codec::fieldKeys(diff)) FAIL_CHECK("differs: " << k);
  CHECK(diff == 0);
  CHECK(q.extra == full.extra);
  // The vector network travelled through Message.blobs (written after the changes, resolved all the same).
  REQUIRE(q.shape().vectorData.network);
  CHECK(*q.shape().vectorData.network == std::vector<uint8_t>{1, 2, 3, 4, 5});
  // The panels see the same JSON either way, unmodelled fields included.
  CHECK(jsonOf({{1, 2}, q}) == jsonOf({{1, 2}, full}));
  std::string json = jsonOf({{1, 2}, q});
  CHECK(json.find("\"exportSettings\":[{\"suffix\":\"@2x\",\"imageType\":\"PNG\"}]") != std::string::npos);
  CHECK(json.find("\"isSymbolPublishable\":false") != std::string::npos);
  CHECK(json.find("\"thumbHash\":[1,2,3,250]") != std::string::npos);
  CHECK(json.find("\"blurOpType\":\"PROGRESSIVE\"") != std::string::npos);
  CHECK(json.find("\"preferredValues\":{\"instanceSwapValues\":[{\"type\":\"COMPONENT\",\"key\":\"k1\"},{\"type\":\"STATE_GROUP\",\"key\":\"s1\"}],\"stringValues\":[\"a\",\"b\"]}") != std::string::npos);
  CHECK(json.find("\"lines\":[{\"lineType\":\"ORDERED_LIST\",\"indentationLevel\":2}]") != std::string::npos);
  CHECK(!codec::extraBool(q.extra, "isSymbolPublishable", true));
  // And once more: the bytes are stable.
  CHECK(codec::writeMessage(42, back.changes) == bytes);
}

TEST_CASE("kiwi codec: what the engine writes, the generated tree codec reads, and the other way round") {
  NodeProps full = fullProps();
  std::string bytes = codec::writeMessage(7, {NodeChange::created({1, 2}, full)});
  kiwi::ByteBuffer in(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size());
  kiwi::MemoryPool pool;
  ::schema::Message m;
  REQUIRE(m.decode(in, pool));
  REQUIRE((m.nodeChanges() && m.nodeChanges()->size() == 1));
  ::schema::NodeChange& n = (*m.nodeChanges())[0];
  CHECK(std::string_view(n.name()->c_str()) == "Full");
  CHECK(*n.type() == ::schema::NodeType::FRAME);
  CHECK(*n.phase() == ::schema::NodePhase::CREATED);
  CHECK(*n.opacity() == 0.5f);
  CHECK(*n.stackMode() == ::schema::StackMode::HORIZONTAL);
  CHECK(*n.rectangleBottomLeftCornerRadius() == 4);
  CHECK(*n.rectangleBottomRightCornerRadius() == 3);
  CHECK(*n.borderBottomWeight() == 3);
  CHECK(*n.borderLeftWeight() == 4);
  REQUIRE((n.fillPaints() && n.fillPaints()->size() == 3));
  CHECK(*(*n.fillPaints())[2].type() == ::schema::PaintType::IMAGE);
  CHECK((*n.fillPaints())[2].thumbHash()->size() == 4);
  CHECK((*n.fillPaints())[2].image()->hash()->size() == 20);
  REQUIRE((n.exportSettings() && n.exportSettings()->size() == 1));
  CHECK(std::string_view((*n.exportSettings())[0].suffix()->c_str()) == "@2x");
  CHECK(*n.isSymbolPublishable() == false);
  CHECK(*n.backgroundOpacity() == 0.5f);
  REQUIRE((n.symbolData() && n.symbolData()->symbolOverrides()->size() == 2));
  CHECK((*n.symbolData()->symbolOverrides())[1].guidPath()->guids()->size() == 2);
  REQUIRE((n.textData() && n.textData()->lines() && n.textData()->lines()->size() == 1));
  CHECK(*(*n.textData()->lines())[0].indentationLevel() == 2);
  REQUIRE((n.componentPropDefs() && n.componentPropDefs()->size() == 3));
  CHECK((*n.componentPropDefs())[1].preferredValues()->stringValues()->size() == 2);
  CHECK((*n.componentPropDefs())[1].preferredValues()->instanceSwapValues()->size() == 2);
  REQUIRE(n.vectorData());
  CHECK(*n.vectorData()->vectorNetworkBlob() == 0);
  REQUIRE((m.blobs() && m.blobs()->size() == 1));
  CHECK((*m.blobs())[0].bytes()->size() == 5);

  // The generated codec's own output (another writer, the fields in schema order) reads back the same.
  kiwi::ByteBuffer out;
  REQUIRE(m.encode(out));
  codec::KiwiMessage back;
  REQUIRE(codec::readMessage(std::string_view(reinterpret_cast<const char*>(out.data()), out.size()), back));
  REQUIRE(back.changes.size() == 1);
  FieldMask diff = differingFields(back.changes[0].props, full);
  for (const std::string& k : codec::fieldKeys(diff)) FAIL_CHECK("differs after the tree codec: " << k);
  CHECK(diff == 0);
  CHECK(back.changes[0].props.extra == full.extra);
}

TEST_CASE("kiwi codec: the engine's enums are numbered as the schema's") {
  const auto& table = eng::schema::SchemaTable::get();
  auto check = [&](const char* defName, auto tag) {
    using E = decltype(tag);
    const eng::schema::Def* d = table.def(defName);
    REQUIRE(d);
    for (size_t i = 0; i < EnumNames<E>::count; i++) {
      const char* name = EnumNames<E>::names[i];
      if (!name[0]) continue;
      INFO(defName << "::" << name);
      const eng::schema::FieldDef* f = d->byName(name);
      REQUIRE(f);
      CHECK(f->value == i);
    }
  };
  check("StrokeAlign", StrokeAlign{});
  check("BlendMode", BlendMode{});
  check("ImageScaleMode", ImageScaleMode{});
  check("StrokeCap", StrokeCap{});
  check("StrokeJoin", StrokeJoin{});
  check("MaskType", MaskType{});
  check("EffectType", EffectType{});
  check("VectorMirror", VectorMirror{});
  check("BooleanOperation", BooleanOperation{});
  check("WindingRule", WindingRule{});
  check("LayoutGridType", LayoutGridType{});
  check("LayoutGridPattern", LayoutGridPattern{});
  check("Axis", Axis{});
  check("StackMode", StackMode{});
  check("StackAlign", StackAlign{});
  check("StackCounterAlign", StackCounterAlign{});
  check("StackJustify", StackJustify{});
  check("StackSize", StackSize{});
  check("StackPositioning", StackPositioning{});
  check("StackWrap", StackWrap{});
  check("StackCounterAlignContent", StackCounterAlignContent{});
  check("ConstraintType", ConstraintType{});
  check("NumberUnits", NumberUnits{});
  check("TextAlignHorizontal", TextAlignHorizontal{});
  check("TextAlignVertical", TextAlignVertical{});
  check("TextAutoResize", TextAutoResize{});
  check("TextTruncation", TextTruncation{});
  check("TextCase", TextCase{});
  check("TextDecoration", TextDecoration{});
  check("ComponentPropType", ComponentPropType{});
  check("VariableField", VariableField{});
  check("VariableDataType", VariableDataType{});
  check("VariableResolvedDataType", VariableResolvedType{});
  check("ExpressionFunction", ExpressionFunction{});
  check("VariableScope", VariableScope{});
  check("CodeSyntaxPlatform", CodeSyntaxPlatform{});
  check("StyleType", StyleType{});
  // Node types: the engine's values are the schema's.
  const eng::schema::Def* nt = table.def("NodeType");
  REQUIRE(nt);
  for (NodeType t : {NodeType::DOCUMENT, NodeType::CANVAS, NodeType::FRAME, NodeType::TEXT, NodeType::SYMBOL, NodeType::INSTANCE,
                     NodeType::SECTION, NodeType::VARIABLE, NodeType::VARIABLE_SET, NodeType::BOOLEAN_OPERATION})
    CHECK(nt->byName(nodeTypeName(t))->value == static_cast<uint32_t>(t));
}

TEST_CASE("kiwi codec: updates carry their fields and clearedFields; a paint kind the schema doesn't know is kept") {
  NodeChange c = NodeChange::changed({1, 2});
  c.mask = F_NAME | F_STYLE_ID_FILL | F_VARIABLE_SCOPES | F_STACK_COUNTER_SPACING | F_OPACITY | F_EXTRA;
  c.props.name = "Renamed";
  c.props.opacity = 0.25;
  c.props.extra["exportSettings"] = std::string();  // removed
  c.props.extra["guides"] = codec::extraFromJson("NodeChange", "guides", parsed("[{\"axis\":\"Y\",\"offset\":3,\"guid\":\"1:2\"}]"));
  std::string bytes = codec::writeMessage(1, {c});
  codec::KiwiMessage back;
  REQUIRE(codec::readMessage(bytes, back));
  REQUIRE(back.changes.size() == 1);
  const NodeChange& b = back.changes[0];
  CHECK(b.phase == Phase::CHANGED);
  CHECK(b.mask == c.mask);
  CHECK(b.props.name == "Renamed");
  CHECK(b.props.opacity == 0.25);
  CHECK(!b.props.refs().styleIdForFill.present());
  CHECK(!b.props.asset().variableScopes.has_value());
  CHECK(!b.props.stack().stackCounterSpacing.has_value());
  REQUIRE(b.props.extra.count("exportSettings"));
  CHECK(b.props.extra.at("exportSettings").empty());
  CHECK(b.props.extra.at("guides") == c.props.extra.at("guides"));
  // The generated codec sees clearedFields for the absent optional fields (and the removed unmodelled one).
  kiwi::ByteBuffer in(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size());
  kiwi::MemoryPool pool;
  ::schema::Message m;
  REQUIRE(m.decode(in, pool));
  auto& cleared = *(*m.nodeChanges())[0].clearedFields();
  std::vector<uint32_t> ids(cleared.begin(), cleared.end());
  std::sort(ids.begin(), ids.end());
  CHECK(ids == std::vector<uint32_t>{45, 324, 332, 353});

  // A paint whose type the schema doesn't know (Figma's EMOJI = 6, dropped): hand-built bytes.
  eng::schema::Out o;
  o.varuint(1), o.varuint(1);  // type NODE_CHANGES
  o.varuint(4), o.varuint(1);  // one change
  o.varuint(1), o.varuint(1), o.varuint(5);  // guid 1:5
  o.varuint(2), o.varuint(0);                // CREATED
  o.varuint(4), o.varuint(4);                // FRAME
  o.varuint(38), o.varuint(1);               // fillPaints ×1
  o.varuint(1), o.varuint(6);                //   type 6
  o.varuint(3), o.varfloat(0.5f);            //   opacity
  o.varuint(4), o.byte(0);                   //   visible false
  o.byte(0);                                 // end paint
  o.byte(0);                                 // end change
  o.byte(0);                                 // end message
  REQUIRE(codec::readMessage(o.s, back));
  REQUIRE((back.changes.size() == 1 && back.changes[0].props.fillPaints.size() == 1));
  const Paint& p = back.changes[0].props.fillPaints[0];
  CHECK(p.type == PaintType::OTHER);
  CHECK(!p.visible);
  std::string json = jsonOf({{1, 5}, back.changes[0].props});
  CHECK(json.find("\"fillPaints\":[{\"type\":6,\"opacity\":0.5,\"visible\":false}]") != std::string::npos);
  std::string again = codec::writeMessage(0, back.changes);
  codec::KiwiMessage twice;
  REQUIRE(codec::readMessage(again, twice));
  CHECK(twice.changes[0].props.fillPaints[0] == p);
}

TEST_CASE("kiwi codec: clipboard extras, message lists, the JSON reader's unmodelled fields and bad bytes") {
  NodeChange c = make({1, 2}, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 10, 10});
  Guid page{0, 1};
  std::vector<codec::KiwiRegion> regions{{kPage, {{1, 2}}, {5, 6}}};
  codec::KiwiWriteOptions opts;
  opts.pastePageId = &page;
  opts.pasteFileKey = "file-key";
  opts.isCut = true;
  opts.regions = &regions;
  opts.derivedDataVersion = 3;
  std::string bytes = codec::writeMessage(9, {c}, opts);
  codec::KiwiMessage back;
  REQUIRE(codec::readMessage(bytes, back));
  CHECK(back.hasPastePage);
  CHECK(back.pastePageId == page);
  CHECK(back.pasteFileKey == "file-key");
  CHECK(back.isCut);
  CHECK(back.derivedDataVersion == 3);
  REQUIRE(back.regions.size() == 1);
  CHECK(back.regions[0].parent == kPage);
  CHECK(back.regions[0].nodes == std::vector<Guid>{{1, 2}});
  CHECK(back.regions[0].offset.x == 5);
  // Lists.
  std::string list = codec::writeMessageList({bytes, codec::writeMessage(1, {NodeChange::removed({1, 2})})});
  CHECK(codec::isMessageList(list));
  CHECK(!codec::looksKiwi("{\"a\":1}"));
  CHECK(!codec::looksKiwi("  [1]"));
  CHECK(codec::looksKiwi(list));
  std::vector<codec::KiwiMessage> messages;
  REQUIRE(codec::readMessageList(list, messages));
  REQUIRE(messages.size() == 2);
  CHECK(messages[0].pasteFileKey == "file-key");
  CHECK(messages[1].changes[0].phase == Phase::REMOVED);
  // The JSON reader keeps unmodelled fields the schema knows as kiwi bytes, shows them back as JSON, drops the rest.
  NodeChange j;
  REQUIRE(codec::readChange(parsed(R"({"guid":"1:1","phase":"CREATED","type":"FRAME","exportSettings":[{"suffix":"@2x"}],
    "guides":[{"axis":"Y","offset":3,"guid":{"sessionID":1,"localID":2}}],"notAField":5})"), j));
  CHECK(j.props.extra.size() == 2);
  std::string json = jsonOf({{1, 1}, j.props});
  CHECK(json.find("\"exportSettings\":[{\"suffix\":\"@2x\"}]") != std::string::npos);
  CHECK(json.find("\"guides\":[{\"axis\":\"Y\",\"offset\":3,\"guid\":{\"sessionID\":1,\"localID\":2}}]") != std::string::npos);
  CHECK(json.find("notAField") == std::string::npos);
  NodeChange u;
  REQUIRE(codec::readChange(parsed(R"({"guid":"1:1","exportSettings":null})"), u));
  CHECK((u.mask & F_EXTRA) != 0);
  CHECK(u.props.extra.at("exportSettings").empty());
  // Malformed bytes are refused, not read into something.
  std::string broken = bytes.substr(0, bytes.size() / 2);
  CHECK(!codec::readMessage(broken, back));
  CHECK(!codec::readMessage(std::string("\x05\x01\x02", 3), back));
}

TEST_CASE("kiwi codec: Figma's forms the engine reads round-trip as written (snapshot fidelity)") {
  // A frame detached from a library main names it by key (101 frames of a private test file did).
  NodeProps f;
  f.type = NodeType::FRAME;
  f.comp().detachedSymbolId.key = "17783905cbcf00ce0eee033580ceaf656044bf91";
  f.comp().detachedSymbolId.version = "305:76";
  // An explicit-mode entry Figma wrote without a mode; "no limit" written as {} (no value).
  f.refs().variableModeBySetMap = {{AssetId::of({5, 1}), kNoGuid}};
  NodeChange node = NodeChange::created({1, 2}, f);
  // An override of one corner only: the others stay the main's.
  NodeChange ovr = NodeChange::changed({1, 3});
  ovr.mask = F_CORNER_BR | F_MIN_SIZE;
  ovr.props.cornerRadii[2] = 0;
  std::string bytes = codec::writeMessage(1, {node, ovr});
  codec::KiwiMessage back;
  REQUIRE(codec::readMessage(bytes, back));
  REQUIRE(back.changes.size() == 2);
  const NodeProps& q = back.changes[0].props;
  CHECK(q.comp().detachedSymbolId.guid == kNoGuid);
  CHECK(q.comp().detachedSymbolId.key == "17783905cbcf00ce0eee033580ceaf656044bf91");
  CHECK(q.comp().detachedSymbolId.version == "305:76");
  REQUIRE(q.refs().variableModeBySetMap.size() == 1);
  CHECK(q.refs().variableModeBySetMap[0].mode == kNoGuid);
  CHECK(back.changes[1].mask == (F_CORNER_BR | F_MIN_SIZE));
  // The generated tree codec sees Figma's shapes: no mode GUID (not the none sentinel), {} for no limit, one corner.
  kiwi::ByteBuffer in(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size());
  kiwi::MemoryPool pool;
  ::schema::Message m;
  REQUIRE(m.decode(in, pool));
  REQUIRE((m.nodeChanges() && m.nodeChanges()->size() == 2));
  ::schema::NodeChange& fig = (*m.nodeChanges())[0];
  REQUIRE(fig.detachedSymbolId());
  CHECK(fig.detachedSymbolId()->guid() == nullptr);
  CHECK(std::string_view(fig.detachedSymbolId()->assetRef()->key()->c_str()) == "17783905cbcf00ce0eee033580ceaf656044bf91");
  CHECK((*fig.variableModeBySetMap()->entries())[0].variableModeID() == nullptr);
  ::schema::NodeChange& o = (*m.nodeChanges())[1];
  REQUIRE(o.minSize());
  CHECK(o.minSize()->value() == nullptr);
  CHECK(o.rectangleBottomRightCornerRadius() != nullptr);
  CHECK(o.cornerRadius() == nullptr);
  CHECK(o.rectangleTopLeftCornerRadius() == nullptr);
  CHECK(o.rectangleCornerRadiiIndependent() == nullptr);
  CHECK(codec::writeMessage(1, back.changes) == bytes);
  // An update with minSize {} clears a limit.
  NodeProps limited;
  limited.rare().minSize = {10, 20};
  NodeChange clear = NodeChange::changed({1, 2});
  clear.mask = F_MIN_SIZE;
  codec::KiwiMessage again;
  REQUIRE(codec::readMessage(codec::writeMessage(1, {clear}), again));
  NodeProps applied = limited;
  copyFields(applied, again.changes[0].props, again.changes[0].mask);
  CHECK(applied.rare().minSize.x == 0);
  CHECK(applied.rare().minSize.y == 0);
}

TEST_CASE("kiwi codec: a slot assignment's slotContentIdValue (Figma's form) is kept and readable") {
  const char* json = R"([{"guid":"3:1","phase":"CREATED","type":"INSTANCE","parentIndex":{"guid":"0:1","position":"!"},
    "symbolData":{"symbolID":"2:1"},
    "componentPropAssignments":[{"defID":"2:9","value":{},"varValue":{"value":{"slotContentIdValue":{"guid":"4:1"}},
      "dataType":"SLOT_CONTENT_ID","resolvedDataType":"SLOT_CONTENT_ID"}}]}])";
  json::Value v;
  REQUIRE(json::parse(json, v));
  auto changes = codec::readChanges(v);
  REQUIRE(changes.size() == 1);
  REQUIRE(changes[0].props.comp().componentPropAssignments.size() == 1);
  CHECK(codec::assignmentSlotContent(changes[0].props.comp().componentPropAssignments[0].extra) == Guid{4, 1});
  codec::KiwiMessage back;
  REQUIRE(codec::readMessage(codec::writeMessage(1, changes), back));
  CHECK(codec::assignmentSlotContent(back.changes[0].props.comp().componentPropAssignments[0].extra) == Guid{4, 1});
  // As a variable value the engine models it (SLOT_CONTENT).
  VariableData d;
  d.kind = VariableData::Kind::SLOT_CONTENT;
  d.slotContent = {4, 7};
  d.hasDataType = d.hasResolvedType = true;
  d.dataType = VariableDataType::SLOT_CONTENT_ID;
  d.resolvedDataType = VariableResolvedType::SLOT_CONTENT_ID;
  kiwi::ByteBuffer bb;
  codec::writeVariableData(bb, d);
  kiwi::ByteBuffer in(bb.data(), bb.size());
  VariableData r;
  REQUIRE(codec::readVariableData(in, r));
  CHECK(r == d);
}

TEST_CASE("kiwi codec: Figma's NaN row gap (a wrap's gap that follows the column gap) reads as absent") {
  // Figma's own files (stacks_wrap.fig's "Horizontal wrap top left") carry stackCounterSpacing = NaN.
  kiwi::MemoryPool pool;
  ::schema::Message m;
  m.set_type(::schema::MessageType::NODE_CHANGES);
  ::schema::NodeChange& n = m.set_nodeChanges(pool, 1)[0];
  ::schema::GUID guid;
  guid.set_sessionID(1);
  guid.set_localID(2);
  n.set_guid(&guid);
  n.set_phase(::schema::NodePhase::CREATED);
  n.set_type(::schema::NodeType::FRAME);
  n.set_stackMode(::schema::StackMode::HORIZONTAL);
  n.set_stackWrap(::schema::StackWrap::WRAP);
  n.set_stackSpacing(4);
  n.set_stackCounterSpacing(std::nanf(""));
  kiwi::ByteBuffer out;
  REQUIRE(m.encode(out));
  codec::KiwiMessage back;
  REQUIRE(codec::readMessage(std::string_view(reinterpret_cast<const char*>(out.data()), out.size()), back));
  REQUIRE(back.changes.size() == 1);
  CHECK(!back.changes[0].props.stack().stackCounterSpacing.has_value());
  CHECK(back.changes[0].props.stack().stackSpacing == 4);
}
