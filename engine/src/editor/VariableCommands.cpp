// Variables, modes and styles: the commands (docs/engine-build.md "E6 variables"). Collections, modes and
// variables are VARIABLE_SET / VARIABLE nodes on the internal canvas, styles are style nodes there
// (docs/schema.md §6); every command is one undo step, and what it changes reaches the layers that use it in the
// same commit (editor/Variables.cpp).

#include <algorithm>
#include <cmath>
#include <functional>
#include <random>
#include <set>

#include "base/FractionalIndex.h"
#include "editor/Editor.h"
#include "scene/CodecJson.h"
#include "text/TextEdit.h"

namespace eng {

namespace {

constexpr size_t kMaxModes = 40;           // Figma's REST limit (R3-07)
constexpr size_t kMaxModeNameLength = 40;
constexpr size_t kMaxVariables = 5000;     // per collection

const json::Value* arg(const CommandArgs& a, const char* k) { return a.raw.isObject() ? a.raw.get(k) : nullptr; }

bool argString(const CommandArgs& a, const char* k, std::string& out) {
  const json::Value* v = arg(a, k);
  if (!v || !v->isString()) return false;
  out = v->string;
  return true;
}

bool argNumber(const CommandArgs& a, const char* k, double& out) {
  const json::Value* v = arg(a, k);
  if (!v || !v->isNumber()) return false;
  out = v->number;
  return true;
}

Guid guidOf(const json::Value& v) {
  Guid g;
  if (v.isString()) {
    bool ok = false;
    g = Guid::parse(v.string, &ok);
    return ok ? g : kNoGuid;
  }
  return codec::readGuid(v, g) ? g : kNoGuid;
}

Guid argGuid(const CommandArgs& a, const char* k) {
  const json::Value* v = arg(a, k);
  return v ? guidOf(*v) : kNoGuid;
}

// One or several GUIDs (a string or an array), from the first key present.
std::vector<Guid> argGuids(const CommandArgs& a, std::initializer_list<const char*> keys) {
  std::vector<Guid> out;
  for (const char* k : keys) {
    const json::Value* v = arg(a, k);
    if (!v) continue;
    if (v->isArray()) {
      for (auto& e : v->array)
        if (Guid g = guidOf(e); g != kNoGuid && std::find(out.begin(), out.end(), g) == out.end()) out.push_back(g);
    } else if (Guid g = guidOf(*v); g != kNoGuid) {
      out.push_back(g);
    }
    return out;
  }
  return out;
}

std::string trim(const std::string& s) {
  size_t a = s.find_first_not_of(" \t\n");
  if (a == std::string::npos) return {};
  size_t b = s.find_last_not_of(" \t\n");
  return s.substr(a, b - a + 1);
}

// A slash path, its segments trimmed ("a / b" = "a/b"); empty when a segment is empty.
std::string normalizePath(const std::string& s) {
  std::string out;
  size_t start = 0;
  while (true) {
    size_t slash = s.find('/', start);
    std::string seg = trim(s.substr(start, slash == std::string::npos ? std::string::npos : slash - start));
    if (seg.empty()) return {};
    if (!out.empty()) out += "/";
    out += seg;
    if (slash == std::string::npos) break;
    start = slash + 1;
  }
  return out;
}

std::string groupOf(const std::string& name) {
  size_t slash = name.rfind('/');
  return slash == std::string::npos ? std::string() : name.substr(0, slash);
}

std::string leafOf(const std::string& name) {
  size_t slash = name.rfind('/');
  return slash == std::string::npos ? name : name.substr(slash + 1);
}

std::string joinPath(const std::string& group, const std::string& rest) { return group.empty() ? rest : rest.empty() ? group : group + "/" + rest; }

bool underGroup(const std::string& name, const std::string& group) {
  return name.size() > group.size() && name.compare(0, group.size(), group) == 0 && name[group.size()] == '/';
}

// `base`, else "base 2", "base 3"… — the first that `taken` doesn't hold.
template <typename Taken>
std::string uniqueName(const std::string& base, Taken taken) {
  if (!taken(base)) return base;
  for (int i = 2;; i++) {
    std::string s = base + " " + std::to_string(i);
    if (!taken(s)) return s;
  }
}

bool typeFromName(const std::string& s, VariableResolvedType& t) {
  if (s == "COLOR") return t = VariableResolvedType::COLOR, true;
  if (s == "FLOAT" || s == "NUMBER") return t = VariableResolvedType::FLOAT, true;
  if (s == "STRING") return t = VariableResolvedType::STRING, true;
  if (s == "BOOLEAN") return t = VariableResolvedType::BOOLEAN, true;
  return false;
}

// Figma's defaults for a new variable (unverified against Figma: the names, white, 0, "", false).
const char* defaultVariableName(VariableResolvedType t) {
  switch (t) {
    case VariableResolvedType::COLOR: return "Color";
    case VariableResolvedType::FLOAT: return "Number";
    case VariableResolvedType::STRING: return "String";
    default: return "Boolean";
  }
}
VariableData defaultValue(VariableResolvedType t) {
  switch (t) {
    case VariableResolvedType::COLOR: return VariableData::color(Color{1, 1, 1, 1});
    case VariableResolvedType::FLOAT: return VariableData::number(0);
    case VariableResolvedType::STRING: return VariableData::string("");
    default: return VariableData::boolean(false);
  }
}

bool scopeFromName(const std::string& s, VariableScope& out) {
  if (s == "STROKE_COLOR") return out = VariableScope::STROKE, true;  // the plugin API's names
  if (s == "FONT_WEIGHT") return out = VariableScope::FONT_STYLE, true;
  return enumFromName(s, out);
}

bool styleTypeFromName(const std::string& s, StyleType& t) {
  if (s == "FILL" || s == "PAINT" || s == "COLOR") return t = StyleType::FILL, true;
  if (s == "TEXT") return t = StyleType::TEXT, true;
  if (s == "EFFECT") return t = StyleType::EFFECT, true;
  if (s == "GRID") return t = StyleType::GRID, true;
  return false;
}

// A binding target (docs/engine-build.md "Binding targets").
struct BindTarget {
  // PROPERTY: "componentProperties.<name>" — an instance's variant property, or a main's boolean / text default.
  enum class Kind : uint8_t { FIELD, PAINT, EFFECT, GRID, PROPERTY } kind = Kind::FIELD;
  VariableField field = VariableField::MISSING;
  bool strokes = false;
  size_t index = 0;
  int stop = -1;
  std::string member;
};

bool parseIndex(std::string_view s, size_t& pos, size_t& out) {
  if (pos >= s.size() || s[pos] != '[') return false;
  size_t end = s.find(']', pos);
  if (end == std::string_view::npos || end == pos + 1) return false;
  out = 0;
  for (size_t i = pos + 1; i < end; i++) {
    if (s[i] < '0' || s[i] > '9') return false;
    out = out * 10 + static_cast<size_t>(s[i] - '0');
  }
  pos = end + 1;
  return true;
}

bool parseTarget(std::string_view s, BindTarget& t) {
  t = BindTarget{};
  auto list = [&](std::string_view prefix) { return s.size() > prefix.size() && s.substr(0, prefix.size()) == prefix && s[prefix.size()] == '['; };
  size_t pos = 0;
  constexpr std::string_view kProps = "componentProperties.";
  if (s.size() > kProps.size() && s.substr(0, kProps.size()) == kProps) {
    t.kind = BindTarget::Kind::PROPERTY;
    t.member = std::string(s.substr(kProps.size()));
    return true;
  }
  if (list("fillPaints") || list("strokePaints")) {
    t.kind = BindTarget::Kind::PAINT;
    t.strokes = s[0] == 's';
    pos = t.strokes ? 12 : 10;
  } else if (list("effects")) {
    t.kind = BindTarget::Kind::EFFECT;
    pos = 7;
  } else if (list("layoutGrids")) {
    t.kind = BindTarget::Kind::GRID;
    pos = 11;
  } else {
    VariableField f = VariableField::MISSING;
    if (!enumFromName(s, f) || f == VariableField::MISSING || f == VariableField::OVERRIDDEN_SYMBOL_ID ||
        f == VariableField::SLOT_CONTENT_ID || f == VariableField::VARIANT_PROPERTIES)
      return false;
    t.field = f;
    return true;
  }
  if (!parseIndex(s, pos, t.index)) return false;
  if (t.kind == BindTarget::Kind::PAINT && s.substr(pos, 6) == ".stops") {
    pos += 6;
    size_t stop = 0;
    if (!parseIndex(s, pos, stop)) return false;
    t.stop = static_cast<int>(stop);
  }
  if (pos >= s.size() || s[pos] != '.') return false;
  t.member = std::string(s.substr(pos + 1));
  switch (t.kind) {
    case BindTarget::Kind::PAINT: return t.stop >= 0 ? t.member == "color" : (t.member == "color" || t.member == "opacity");
    case BindTarget::Kind::EFFECT: return t.member == "color" || t.member == "radius" || t.member == "spread" || t.member == "x" || t.member == "y";
    case BindTarget::Kind::GRID:
      return t.member == "numSections" || t.member == "offset" || t.member == "sectionSize" || t.member == "gutterSize";
    default: return false;
  }
}

// What a target takes (FONT_STYLE takes a STRING or a FLOAT; a property: checked against its type when bound).
bool accepts(const BindTarget& t, VariableResolvedType type) {
  if (t.kind == BindTarget::Kind::PROPERTY)
    return type == VariableResolvedType::STRING || type == VariableResolvedType::FLOAT || type == VariableResolvedType::BOOLEAN;
  if (t.kind == BindTarget::Kind::FIELD) {
    switch (t.field) {
      case VariableField::VISIBLE: return type == VariableResolvedType::BOOLEAN;
      case VariableField::TEXT_DATA:
      case VariableField::FONT_FAMILY:
      case VariableField::HYPERLINK: return type == VariableResolvedType::STRING;
      case VariableField::FONT_STYLE: return type == VariableResolvedType::STRING || type == VariableResolvedType::FLOAT;
      default: return type == VariableResolvedType::FLOAT;
    }
  }
  if (t.member == "color") return type == VariableResolvedType::COLOR;
  return type == VariableResolvedType::FLOAT;
}

// The binding of a variable to a target, as Figma writes it.
VariableData bindingData(const BindTarget& t, Guid variable, VariableResolvedType type) {
  if (t.kind == BindTarget::Kind::FIELD && t.field == VariableField::FONT_STYLE) {
    VariableData d;
    d.kind = VariableData::Kind::FONT_STYLE;
    d.hasDataType = d.hasResolvedType = true;
    d.dataType = VariableDataType::FONT_STYLE;
    d.resolvedDataType = VariableResolvedType::FONT_STYLE;
    if (type == VariableResolvedType::STRING) d.args = {VariableData::aliasOf(variable, type)};
    else d.args = {VariableData{}, VariableData::aliasOf(variable, type)};
    return d;
  }
  // Visibility: IS_TRUTHY(alias), as Figma's files hold every boolean bound to visibility.
  if (t.kind == BindTarget::Kind::FIELD && t.field == VariableField::VISIBLE) return VariableData::isTruthy(VariableData::aliasOf(variable, type));
  return VariableData::aliasOf(variable, type);
}

const char* defaultStyleName(StyleType t) {
  switch (t) {
    case StyleType::FILL: return "Color style";
    case StyleType::TEXT: return "Text style";
    case StyleType::EFFECT: return "Effect style";
    default: return "Layout guide style";
  }
}

constexpr uint32_t kTextStyleRunFields = R_FONT_NAME | R_FONT_SIZE | R_LINE_HEIGHT | R_LETTER_SPACING | R_TEXT_CASE | R_TEXT_DECORATION;
constexpr FieldMask kTextStyleFieldsMask = F_FONT_NAME | F_FONT_SIZE | F_LINE_HEIGHT | F_LETTER_SPACING | F_PARAGRAPH_SPACING |
                                           F_PARAGRAPH_INDENT | F_TEXT_CASE | F_TEXT_DECORATION;
bool isTypographyField(VariableField f) {
  return f == VariableField::FONT_FAMILY || f == VariableField::FONT_STYLE || f == VariableField::FONT_SIZE ||
         f == VariableField::LINE_HEIGHT || f == VariableField::LETTER_SPACING || f == VariableField::PARAGRAPH_SPACING ||
         f == VariableField::PARAGRAPH_INDENT || f == VariableField::FONT_VARIATIONS;
}

// Every alias inside a value (expressions and font styles included).
void aliasesOf(const VariableData& d, std::vector<const AssetId*>& out) {
  if (d.kind == VariableData::Kind::ALIAS) out.push_back(&d.alias);
  for (auto& a : d.args) aliasesOf(a, out);
}

}  // namespace

std::string Editor::newAssetKey() {
  // 160 random bits as 40 lowercase hex digits (docs/schema.md §8.1).
  if (keyState_ == 0) {
    std::random_device rd;
    keyState_ = (static_cast<uint64_t>(rd()) << 32) ^ rd() ^ (static_cast<uint64_t>(sessionID_) << 17) ^ 0x9E3779B97F4A7C15ull;
  }
  auto next = [&]() {
    uint64_t z = (keyState_ += 0x9E3779B97F4A7C15ull);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
    return z ^ (z >> 31);
  };
  static const char* digits = "0123456789abcdef";
  std::string out;
  uint64_t bits = 0;
  for (int i = 0; i < 40; i++) {
    if (i % 16 == 0) bits = next();
    out += digits[bits & 15];
    bits >>= 4;
  }
  return out;
}

uint32_t Editor::variableCommandState(CommandId id) const {
  switch (id) {
    case CommandId::BIND_VARIABLE:
    case CommandId::DETACH_VARIABLE:
    case CommandId::APPLY_STYLE:
    case CommandId::DETACH_STYLE: return selection_.empty() ? 0 : CMD_ENABLED;
    default: return CMD_ENABLED;
  }
}

Status Editor::variableCommand(CommandId id, const CommandArgs& args) {
  // ---- Shared lookups ----
  auto collectionNode = [&](Guid g) -> const NodeProps* {
    const Node* n = doc_.get(g);
    return n && n->props.type == NodeType::VARIABLE_SET ? &n->props : nullptr;
  };
  auto variableNode = [&](Guid g) -> const NodeProps* {
    const Node* n = doc_.get(g);
    return n && n->props.type == NodeType::VARIABLE ? &n->props : nullptr;
  };
  auto styleOf = [&](Guid g) -> const NodeProps* {
    const Node* n = doc_.get(g);
    return n && n->props.isStyle() ? &n->props : nullptr;
  };
  auto collectionOfVar = [&](Guid v) {
    const NodeProps* p = variableNode(v);
    return p ? findCollection(p->asset().variableSetID) : kNoGuid;
  };
  // The live variables of a collection by name (excluding `except`).
  auto nameTaken = [&](Guid collection, const std::string& name, const std::unordered_set<Guid, GuidHash>& except) {
    for (Guid v : variablesOf(collection))
      if (!except.count(v) && doc_.get(v)->props.name == name) return true;
    return false;
  };
  // A variable name: a slash path without `.`, `{`, `}` (Figma's rule).
  auto validName = [&](const std::string& raw, std::string& out) {
    out = normalizePath(raw);
    return !out.empty() && out.find_first_of(".{}") == std::string::npos;
  };
  // A key after the last of `ordered` (sortPosition).
  auto keyAfter = [&](const std::vector<Guid>& ordered) {
    std::string last;
    for (Guid g : ordered)
      if (doc_.get(g)->props.asset().sortPosition > last) last = doc_.get(g)->props.asset().sortPosition;
    std::string k = fractional::keyBetween(last, std::nullopt, fractional::Bias::Low);
    return k.empty() ? std::string("!") : k;
  };
  // Writes sortPositions so that `order` is the order; only `moved` change when their neighbours allow it.
  auto writeOrder = [&](const std::vector<Guid>& order, const std::unordered_set<Guid, GuidHash>& moved) {
    std::vector<std::string> keys(order.size());
    for (size_t i = 0; i < order.size(); i++) keys[i] = doc_.get(order[i])->props.asset().sortPosition;
    bool ok = true;
    for (size_t i = 0; i < order.size() && ok;) {
      if (!moved.count(order[i])) {
        i++;
        continue;
      }
      size_t j = i;
      while (j < order.size() && moved.count(order[j])) j++;
      std::string lo = i > 0 ? keys[i - 1] : std::string();
      std::optional<std::string> hi;
      if (j < order.size()) hi = keys[j];
      if ((i > 0 && lo.empty()) || (hi && hi->empty()) || (hi && !(lo < *hi))) {
        ok = false;
        break;
      }
      auto ks = fractional::keysBetween(lo, hi ? std::optional<std::string_view>(*hi) : std::nullopt, static_cast<int>(j - i));
      if (ks.size() != j - i) {
        ok = false;
        break;
      }
      for (size_t k = i; k < j; k++) {
        if (ks[k - i].size() > fractional::kMaxKeyLength) ok = false;
        keys[k] = ks[k - i];
      }
      i = j;
    }
    if (!ok) keys = fractional::rebalancedKeys(static_cast<int>(order.size()));
    for (size_t i = 0; i < order.size(); i++) {
      if (doc_.get(order[i])->props.asset().sortPosition == keys[i]) continue;
      NodeChange c = NodeChange::changed(order[i]);
      c.mask = F_SORT_POSITION;
      c.props.asset().sortPosition = keys[i];
      write(c);
    }
  };
  // `items` moved to `index` among `all` (counted without them).
  auto reorder = [&](const std::vector<Guid>& all, const std::vector<Guid>& items, double index) {
    std::unordered_set<Guid, GuidHash> moving(items.begin(), items.end());
    std::vector<Guid> rest;
    for (Guid g : all)
      if (!moving.count(g)) rest.push_back(g);
    std::vector<Guid> moved;
    for (Guid g : all)
      if (moving.count(g)) moved.push_back(g);  // they keep their relative order
    for (Guid g : items)
      if (std::find(moved.begin(), moved.end(), g) == moved.end()) moved.push_back(g);
    size_t at = static_cast<size_t>(std::clamp(index, 0.0, static_cast<double>(rest.size())));
    rest.insert(rest.begin() + static_cast<long>(at), moved.begin(), moved.end());
    writeOrder(rest, moving);
  };
  auto variableAliases = [&](const NodeProps& vp, Guid target) {
    for (auto& v : vp.asset().variableDataValues) {
      std::vector<const AssetId*> as;
      aliasesOf(v.data, as);
      for (const AssetId* a : as)
        if (findVariable(*a) == target || a->guid == target) return true;
    }
    return false;
  };
  // Whether `from`'s values reach `target` through aliases (any mode): setting target := alias(from) would cycle.
  auto reaches = [&](Guid from, Guid target) {
    std::vector<Guid> stack{from};
    std::unordered_set<Guid, GuidHash> seen;
    while (!stack.empty()) {
      Guid v = stack.back();
      stack.pop_back();
      if (v == target) return true;
      if (!seen.insert(v).second) continue;
      const NodeProps* vp = variableNode(v);
      if (!vp) continue;
      for (auto& val : vp->asset().variableDataValues) {
        std::vector<const AssetId*> as;
        aliasesOf(val.data, as);
        for (const AssetId* a : as) {
          Guid t = findVariable(*a);
          if (t != kNoGuid) stack.push_back(t);
        }
      }
    }
    return false;
  };
  // A VariableValue (Figma's plugin shapes) for a variable of `type` (`self`: the variable being set, for cycles).
  auto parseValue = [&](const json::Value& v, VariableResolvedType type, Guid self, VariableData& out) -> bool {
    auto aliasTo = [&](const json::Value& a, VariableResolvedType want, VariableData& d) -> bool {
      const json::Value* idv = a.get("id");
      Guid target = idv ? guidOf(*idv) : kNoGuid;
      const NodeProps* tp = variableNode(target);
      if (!tp || tp->asset().variableResolvedType != want) return false;
      if (self != kNoGuid && (target == self || reaches(target, self))) return false;  // no cycles, no self-alias
      d = VariableData::aliasOf(target, want);
      return true;
    };
    auto isAlias = [](const json::Value& a) {
      const json::Value* t = a.isObject() ? a.get("type") : nullptr;
      return t && t->isString() && t->string == "VARIABLE_ALIAS";
    };
    auto colorOf = [](const json::Value& c, Color& out) -> bool {
      if (!c.isObject() || !c.get("r") || !c.get("g") || !c.get("b")) return false;
      out = {static_cast<float>(c.get("r")->numberOr(0)), static_cast<float>(c.get("g")->numberOr(0)),
             static_cast<float>(c.get("b")->numberOr(0)), static_cast<float>(c.get("a") ? c.get("a")->numberOr(1) : 1)};
      return true;
    };
    if (isAlias(v)) return aliasTo(v, type, out);
    switch (type) {
      case VariableResolvedType::BOOLEAN:
        if (!v.isBool()) return false;
        out = VariableData::boolean(v.boolean);
        return true;
      case VariableResolvedType::FLOAT:
        if (!v.isNumber() || !std::isfinite(v.number)) return false;
        out = VariableData::number(v.number);
        return true;
      case VariableResolvedType::STRING:
        if (!v.isString()) return false;
        out = VariableData::string(v.string);
        return true;
      case VariableResolvedType::COLOR: {
        Color c;
        if (colorOf(v, c)) {
          out = VariableData::color(c);
          return true;
        }
        // A composed colour: {color: RGBA | alias, opacity: % | alias}.
        const json::Value* cv = v.isObject() ? v.get("color") : nullptr;
        const json::Value* ov = v.isObject() ? v.get("opacity") : nullptr;
        if (!cv || !ov) return false;
        VariableData color, opacity;
        if (isAlias(*cv)) {
          if (!aliasTo(*cv, VariableResolvedType::COLOR, color)) return false;
        } else if (colorOf(*cv, c)) {
          color = VariableData::color(c);
        } else {
          return false;
        }
        if (isAlias(*ov)) {
          if (!aliasTo(*ov, VariableResolvedType::FLOAT, opacity)) return false;
        } else if (ov->isNumber() && std::isfinite(ov->number)) {
          opacity = VariableData::number(ov->number);
        } else {
          return false;
        }
        if (color.kind == VariableData::Kind::COLOR && opacity.kind == VariableData::Kind::FLOAT) {
          // Two literals: just a colour.
          color.colorValue.a = static_cast<float>(std::clamp(opacity.floatValue / 100, 0.0, 1.0));
          out = color;
          return true;
        }
        out = VariableData::composeColor(std::move(color), std::move(opacity));
        return true;
      }
      default: return false;
    }
  };
  // Whether anything outside `deleting` still uses `v` (layers, styles, other variables' aliases).
  auto referenced = [&](Guid v, const std::unordered_set<Guid, GuidHash>& deleting) {
    if (auto it = varConsumers_.find(v); it != varConsumers_.end())
      for (Guid g : it->second)
        if (doc_.has(g) && !deleting.count(g)) return true;
    bool found = false;
    doc_.forEach([&](const Node& n) {
      if (found || n.props.type != NodeType::VARIABLE || n.guid == v || deleting.count(n.guid)) return;
      if (variableAliases(n.props, v)) found = true;
    });
    return found;
  };
  // Deletes variables (soft when still referenced; Figma's deletedButReferenced).
  auto deleteVariables = [&](const std::vector<Guid>& vars) {
    std::unordered_set<Guid, GuidHash> deleting(vars.begin(), vars.end());
    for (Guid v : vars) {
      if (!variableNode(v)) continue;
      if (referenced(v, deleting)) {
        NodeChange c = NodeChange::changed(v);
        c.mask = F_IS_SOFT_DELETED;
        c.props.comp().isSoftDeleted = true;
        write(c);
      } else {
        write(NodeChange::removed(v));
        // Extended collections' values for it go with it.
        std::vector<Guid> gone;
        for (auto& [ext, byVar] : overridesBySet_)
          if (auto it = byVar.find(v); it != byVar.end()) gone.push_back(it->second);
        for (Guid o : gone)
          if (doc_.has(o)) write(NodeChange::removed(o));
      }
    }
  };
  auto newVariable = [&](Guid collection, const std::string& name, VariableResolvedType type, const std::vector<VariableModeValue>& values,
                         const std::string& sortPosition) {
    NodeProps p;
    p.type = NodeType::VARIABLE;
    p.name = name;
    p.asset().variableSetID = AssetId::of(collection);
    p.asset().variableResolvedType = type;
    p.asset().variableDataValues = values;
    p.asset().sortPosition = sortPosition;
    p.asset().key = newAssetKey();
    Guid canvas = internalCanvas(true);
    p.parentIndex = {canvas, doc_.positionAtEnd(canvas)};
    Guid g = newGuid();
    write(NodeChange::created(g, p));
    created_.push_back(g);
    return g;
  };
  // Copies of `vars` (into `collection`, modes mapped by `modeMap` when given) named by `rename`, placed after
  // their sources (or at the end when `atEnd`).
  auto copyVariables = [&](const std::vector<Guid>& vars, Guid collection, const std::unordered_map<Guid, Guid, GuidHash>* modeMap,
                           auto rename, bool atEnd) {
    std::unordered_map<Guid, Guid, GuidHash> copies;
    std::vector<Guid> made;
    for (Guid v : vars) {
      const NodeProps src = *variableNode(v);
      std::vector<VariableModeValue> values = src.asset().variableDataValues;
      if (modeMap)
        for (auto& mv : values)
          if (auto it = modeMap->find(mv.modeID); it != modeMap->end()) mv.modeID = it->second;
      Guid g = newVariable(collection, rename(src.name), src.asset().variableResolvedType, values, std::string());
      NodeChange c = NodeChange::changed(g);
      c.mask = F_VARIABLE_SCOPES | F_CODE_SYNTAX | F_DESCRIPTION | F_IS_PUBLISHABLE;
      c.props.asset().variableScopes = src.asset().variableScopes;
      c.props.asset().codeSyntax = src.asset().codeSyntax;
      c.props.asset().description = src.asset().description;
      c.props.asset().isPublishable = src.asset().isPublishable;
      write(c);
      copies[v] = g;
      made.push_back(g);
    }
    // Aliases between the copied variables point at the copies.
    for (Guid g : made) {
      NodeProps p = doc_.get(g)->props;
      bool changed = false;
      std::function<void(VariableData&)> remap = [&](VariableData& d) {
        if (d.kind == VariableData::Kind::ALIAS)
          if (auto it = copies.find(findVariable(d.alias)); it != copies.end()) d.alias = AssetId::of(it->second), changed = true;
        for (auto& a : d.args) remap(a);
      };
      for (auto& mv : p.asset().variableDataValues) remap(mv.data);
      if (changed) {
        NodeChange c = NodeChange::changed(g);
        c.mask = F_VARIABLE_DATA_VALUES;
        c.props.asset().variableDataValues = p.asset().variableDataValues;
        write(c);
      }
    }
    // Order: each copy right after its source, or all at the end.
    std::vector<Guid> order = variablesOf(collection);
    std::unordered_set<Guid, GuidHash> moved(made.begin(), made.end());
    std::vector<Guid> next;
    for (Guid g : order)
      if (!moved.count(g)) next.push_back(g);
    if (atEnd) {
      next.insert(next.end(), made.begin(), made.end());
    } else {
      for (auto it = vars.rbegin(); it != vars.rend(); ++it) {
        auto at = std::find(next.begin(), next.end(), *it);
        Guid copy = copies[*it];
        if (at == next.end()) next.push_back(copy);
        else next.insert(at + 1, copy);
      }
    }
    writeOrder(next, moved);
    return made;
  };
  auto modesOf = [&](Guid collection) { return collectionNode(collection)->orderedModes(); };
  // Mode keys for `modes` in this order (only where needed).
  auto orderModes = [&](std::vector<VariableSetMode>& modes, Guid moved) {
    for (size_t i = 0; i < modes.size(); i++) {
      if (modes[i].id != moved) continue;
      std::string lo = i > 0 ? modes[i - 1].sortPosition : std::string();
      std::optional<std::string_view> hi;
      if (i + 1 < modes.size()) hi = modes[i + 1].sortPosition;
      std::string k = (i > 0 && lo.empty()) ? std::string() : fractional::keyBetween(lo, hi, fractional::Bias::Mid);
      if (!k.empty() && k.size() <= fractional::kMaxKeyLength) {
        modes[i].sortPosition = k;
        return;
      }
    }
    auto keys = fractional::rebalancedKeys(static_cast<int>(modes.size()));
    for (size_t i = 0; i < modes.size(); i++) modes[i].sortPosition = keys[i];
  };
  auto writeModes = [&](Guid collection, const std::vector<VariableSetMode>& modes) {
    NodeChange c = NodeChange::changed(collection);
    c.mask = F_VARIABLE_SET_MODES;
    c.props.asset().variableSetModes = modes;
    write(c);
  };
  auto refsOrSelection = [&]() { return refsArg(args, arg(args, "refs") ? "refs" : "ref"); };

  switch (id) {
    // ---- Collections ----
    case CommandId::CREATE_VARIABLE_COLLECTION: {
      std::string name;
      if (argString(args, "name", name)) {
        name = trim(name);
        if (name.empty()) return E_INVALID;
      } else {
        name = uniqueName("Collection", [&](const std::string& s) {
          for (Guid c : collections())
            if (doc_.get(c)->props.name == s) return true;
          return false;
        });
      }
      begin(TxnKind::USER, "Create collection");
      Guid canvas = internalCanvas(true);
      NodeProps p;
      p.type = NodeType::VARIABLE_SET;
      p.name = name;
      Guid mode = newGuid();
      p.asset().variableSetModes = {{mode, "Mode 1", "!", {}, kNoGuid}};
      p.asset().sortPosition = keyAfter(collections());
      p.asset().key = newAssetKey();
      p.parentIndex = {canvas, doc_.positionAtEnd(canvas)};
      Guid g = newGuid();
      write(NodeChange::created(g, p));
      created_ = {g, mode};
      commit();
      return OK;
    }
    case CommandId::RENAME_VARIABLE_COLLECTION: {
      Guid g = argGuid(args, "collection");
      std::string name;
      if (!collectionNode(g) || !argString(args, "name", name) || trim(name).empty()) return E_INVALID;
      begin(TxnKind::USER, "Rename collection");
      NodeChange c = NodeChange::changed(g);
      c.mask = F_NAME;
      c.props.name = trim(name);
      write(c);
      commit();
      return OK;
    }
    case CommandId::DELETE_VARIABLE_COLLECTION: {
      Guid g = argGuid(args, "collection");
      if (!collectionNode(g)) return E_INVALID;
      begin(TxnKind::USER, "Delete collection");
      // Its extended collections (and theirs) go with it, their overrides with them.
      {
        std::vector<Guid> chain{g};
        for (size_t i = 0; i < chain.size() && i < 256; i++)
          for (Guid e : extensionsOf(chain[i])) chain.push_back(e);
        for (size_t i = chain.size(); i-- > 1;) {
          for (Guid o : std::vector<Guid>(doc_.children(chain[i]))) write(NodeChange::removed(o));
          write(NodeChange::removed(chain[i]));
        }
        for (Guid o : std::vector<Guid>(doc_.children(g))) write(NodeChange::removed(o));
      }
      deleteVariables(variablesOf(g, true));
      bool kept = !variablesOf(g, true).empty();
      if (kept) {
        NodeChange c = NodeChange::changed(g);
        c.mask = F_IS_SOFT_DELETED;
        c.props.comp().isSoftDeleted = true;
        write(c);
      } else {
        write(NodeChange::removed(g));
      }
      commit();
      return OK;
    }
    case CommandId::MOVE_VARIABLE_COLLECTION: {
      Guid g = argGuid(args, "collection");
      double index = 0;
      if (!collectionNode(g) || !argNumber(args, "index", index)) return E_INVALID;
      begin(TxnKind::USER, "Move collection");
      reorder(collections(), {g}, index);
      commit();
      return OK;
    }
    case CommandId::DUPLICATE_VARIABLE_COLLECTION: {
      if (extensionParent(argGuid(args, "collection")) != kNoGuid) return E_INVALID;
      Guid g = argGuid(args, "collection");
      const NodeProps* sp = collectionNode(g);
      if (!sp) return E_INVALID;
      const NodeProps src = *sp;
      begin(TxnKind::USER, "Duplicate collection");
      Guid canvas = internalCanvas(true);
      NodeProps p;
      p.type = NodeType::VARIABLE_SET;
      p.name = src.name + " copy";
      std::unordered_map<Guid, Guid, GuidHash> modeMap;
      for (const VariableSetMode& m : src.asset().variableSetModes) {
        Guid nm = newGuid();
        modeMap[m.id] = nm;
        p.asset().variableSetModes.push_back({nm, m.name, m.sortPosition, {}, kNoGuid});
      }
      p.asset().description = src.asset().description;
      p.asset().isPublishable = src.asset().isPublishable;
      p.asset().key = newAssetKey();
      p.parentIndex = {canvas, doc_.positionAtEnd(canvas)};
      Guid copy = newGuid();
      // Right after the source.
      std::vector<Guid> order = collections();
      write(NodeChange::created(copy, p));
      created_ = {copy};
      auto at = std::find(order.begin(), order.end(), g);
      order.insert(at == order.end() ? order.end() : at + 1, copy);
      writeOrder(order, {copy});
      copyVariables(variablesOf(g), copy, &modeMap, [](const std::string& n) { return n; }, true);
      commit();
      return OK;
    }

    // ---- Modes ----
    case CommandId::ADD_VARIABLE_MODE: {
      if (extensionParent(argGuid(args, "collection")) != kNoGuid) return E_INVALID;  // an extended collection inherits its modes
      Guid g = argGuid(args, "collection");
      const NodeProps* sp = collectionNode(g);
      if (!sp || sp->asset().variableSetModes.size() >= kMaxModes) return E_INVALID;
      auto modes = modesOf(g);
      std::string name;
      if (argString(args, "name", name)) {
        name = trim(name);
        if (name.empty() || name.size() > kMaxModeNameLength) return E_INVALID;
      } else {
        name = uniqueName("Mode " + std::to_string(modes.size() + 1), [&](const std::string& s) {
          for (auto& m : modes)
            if (m.name == s) return true;
          return false;
        });
      }
      Guid def = sp->defaultMode();
      begin(TxnKind::USER, "Add mode");
      Guid mode = newGuid();
      std::string k = fractional::keyBetween(modes.empty() ? std::string() : modes.back().sortPosition, std::nullopt, fractional::Bias::Low);
      modes.push_back({mode, name, k, {}, kNoGuid});
      if (k.empty() || k.size() > fractional::kMaxKeyLength) orderModes(modes, kNoGuid);
      writeModes(g, modes);
      // The new column starts with the default mode's values (Figma).
      for (Guid v : variablesOf(g, true)) {
        const NodeProps& vp = doc_.get(v)->props;
        NodeChange c = NodeChange::changed(v);
        c.mask = F_VARIABLE_DATA_VALUES;
        c.props.asset().variableDataValues = vp.asset().variableDataValues;
        VariableData value = defaultValue(vp.asset().variableResolvedType);
        for (auto& mv : vp.asset().variableDataValues)
          if (mv.modeID == def) value = mv.data;
        c.props.asset().variableDataValues.push_back({mode, value});
        write(c);
      }
      created_ = {mode};
      commit();
      return OK;
    }
    case CommandId::RENAME_VARIABLE_MODE: {
      if (extensionParent(argGuid(args, "collection")) != kNoGuid) return E_INVALID;  // an extended collection inherits its modes
      Guid g = argGuid(args, "collection"), mode = argGuid(args, "mode");
      std::string name;
      if (!collectionNode(g) || !argString(args, "name", name)) return E_INVALID;
      name = trim(name);
      if (name.empty() || name.size() > kMaxModeNameLength) return E_INVALID;
      auto modes = collectionNode(g)->asset().variableSetModes;
      auto it = std::find_if(modes.begin(), modes.end(), [&](const VariableSetMode& m) { return m.id == mode; });
      if (it == modes.end()) return E_INVALID;
      it->name = name;
      begin(TxnKind::USER, "Rename mode");
      writeModes(g, modes);
      commit();
      return OK;
    }
    case CommandId::DELETE_VARIABLE_MODE: {
      if (extensionParent(argGuid(args, "collection")) != kNoGuid) return E_INVALID;  // an extended collection inherits its modes
      Guid g = argGuid(args, "collection"), mode = argGuid(args, "mode");
      if (!collectionNode(g)) return E_INVALID;
      auto modes = collectionNode(g)->asset().variableSetModes;
      auto it = std::find_if(modes.begin(), modes.end(), [&](const VariableSetMode& m) { return m.id == mode; });
      if (it == modes.end() || modes.size() < 2) return E_INVALID;
      modes.erase(it);
      begin(TxnKind::USER, "Delete mode");
      writeModes(g, modes);
      for (Guid v : variablesOf(g, true)) {
        NodeChange c = NodeChange::changed(v);
        c.mask = F_VARIABLE_DATA_VALUES;
        c.props.asset().variableDataValues = doc_.get(v)->props.asset().variableDataValues;
        auto& vals = c.props.asset().variableDataValues;
        vals.erase(std::remove_if(vals.begin(), vals.end(), [&](const VariableModeValue& mv) { return mv.modeID == mode; }), vals.end());
        write(c);
      }
      commit();
      return OK;
    }
    case CommandId::MOVE_VARIABLE_MODE: {
      if (extensionParent(argGuid(args, "collection")) != kNoGuid) return E_INVALID;  // an extended collection inherits its modes
      Guid g = argGuid(args, "collection"), mode = argGuid(args, "mode");
      double index = 0;
      if (!collectionNode(g) || !argNumber(args, "index", index)) return E_INVALID;
      auto modes = modesOf(g);
      auto it = std::find_if(modes.begin(), modes.end(), [&](const VariableSetMode& m) { return m.id == mode; });
      if (it == modes.end()) return E_INVALID;
      VariableSetMode m = *it;
      modes.erase(it);
      size_t at = static_cast<size_t>(std::clamp(index, 0.0, static_cast<double>(modes.size())));
      modes.insert(modes.begin() + static_cast<long>(at), m);
      orderModes(modes, mode);
      begin(TxnKind::USER, at == 0 ? "Set as default" : "Move mode");
      writeModes(g, modes);
      commit();
      return OK;
    }
    case CommandId::DUPLICATE_VARIABLE_MODE: {
      if (extensionParent(argGuid(args, "collection")) != kNoGuid) return E_INVALID;  // an extended collection inherits its modes
      Guid g = argGuid(args, "collection"), mode = argGuid(args, "mode");
      if (!collectionNode(g) || collectionNode(g)->asset().variableSetModes.size() >= kMaxModes) return E_INVALID;
      auto modes = modesOf(g);
      auto it = std::find_if(modes.begin(), modes.end(), [&](const VariableSetMode& m) { return m.id == mode; });
      if (it == modes.end()) return E_INVALID;
      size_t at = static_cast<size_t>(it - modes.begin()) + 1;
      std::string name = uniqueName(it->name + " copy", [&](const std::string& s) {
        for (auto& m : modes)
          if (m.name == s) return true;
        return false;
      });
      if (name.size() > kMaxModeNameLength) name = name.substr(0, kMaxModeNameLength);
      begin(TxnKind::USER, "Duplicate mode");
      Guid copy = newGuid();
      modes.insert(modes.begin() + static_cast<long>(at), VariableSetMode{copy, name, std::string(), {}, kNoGuid});
      orderModes(modes, copy);
      writeModes(g, modes);
      for (Guid v : variablesOf(g, true)) {
        NodeChange c = NodeChange::changed(v);
        c.mask = F_VARIABLE_DATA_VALUES;
        c.props.asset().variableDataValues = doc_.get(v)->props.asset().variableDataValues;
        for (auto& mv : doc_.get(v)->props.asset().variableDataValues)
          if (mv.modeID == mode) c.props.asset().variableDataValues.push_back({copy, mv.data});
        write(c);
      }
      created_ = {copy};
      commit();
      return OK;
    }

    // ---- Variables ----
    case CommandId::CREATE_VARIABLE: {
      if (extensionParent(argGuid(args, "collection")) != kNoGuid) return E_INVALID;  // inherited from its parent (Figma)
      Guid g = argGuid(args, "collection");
      std::string typeName, name, group;
      VariableResolvedType type = VariableResolvedType::COLOR;
      const NodeProps* sp = collectionNode(g);
      if (!sp || !argString(args, "type", typeName) || !typeFromName(typeName, type)) return E_INVALID;
      if (variablesOf(g).size() >= kMaxVariables) return E_INVALID;
      if (argString(args, "group", group) && !group.empty()) {
        group = normalizePath(group);
        if (group.empty()) return E_INVALID;
      }
      if (argString(args, "name", name)) {
        if (!validName(joinPath(group, name), name) || nameTaken(g, name, {})) return E_INVALID;
      } else {
        name = uniqueName(joinPath(group, defaultVariableName(type)), [&](const std::string& s) { return nameTaken(g, s, {}); });
      }
      VariableData value = defaultValue(type);
      if (const json::Value* v = arg(args, "value"); v && !parseValue(*v, type, kNoGuid, value)) return E_INVALID;
      std::vector<VariableModeValue> values;
      for (auto& m : sp->asset().variableSetModes) values.push_back({m.id, value});
      begin(TxnKind::USER, "Create variable");
      newVariable(g, name, type, values, keyAfter(variablesOf(g, true)));
      commit();
      return OK;
    }
    case CommandId::RENAME_VARIABLE: {
      Guid v = argGuid(args, "variable");
      std::string name;
      if (!variableNode(v) || !argString(args, "name", name) || !validName(name, name)) return E_INVALID;
      if (nameTaken(collectionOfVar(v), name, {v})) return E_INVALID;
      begin(TxnKind::USER, "Rename variable");
      NodeChange c = NodeChange::changed(v);
      c.mask = F_NAME;
      c.props.name = name;
      write(c);
      commit();
      return OK;
    }
    case CommandId::DELETE_VARIABLES: {
      std::vector<Guid> vars = argGuids(args, {"variables", "variable"});
      vars.erase(std::remove_if(vars.begin(), vars.end(), [&](Guid v) { return !variableNode(v); }), vars.end());
      if (vars.empty()) return E_INVALID;
      begin(TxnKind::USER, vars.size() == 1 ? "Delete variable" : "Delete variables");
      deleteVariables(vars);
      commit();
      return OK;
    }
    case CommandId::MOVE_VARIABLES: {
      std::vector<Guid> vars = argGuids(args, {"variables", "variable"});
      double index = 0;
      if (vars.empty() || !argNumber(args, "index", index)) return E_INVALID;
      Guid g = collectionOfVar(vars[0]);
      for (Guid v : vars)
        if (!variableNode(v) || collectionOfVar(v) != g) return E_INVALID;
      std::string group;
      bool regroup = argString(args, "group", group);
      if (regroup && !group.empty() && (group = normalizePath(group)).empty()) return E_INVALID;
      std::unordered_set<Guid, GuidHash> moving(vars.begin(), vars.end());
      std::vector<std::pair<Guid, std::string>> names;
      if (regroup) {
        std::set<std::string> fresh;
        for (Guid v : vars) {
          std::string n = joinPath(group, leafOf(doc_.get(v)->props.name));
          if (!fresh.insert(n).second || nameTaken(g, n, moving)) return E_INVALID;
          names.push_back({v, n});
        }
      }
      begin(TxnKind::USER, "Move variables");
      for (auto& [v, n] : names) {
        NodeChange c = NodeChange::changed(v);
        c.mask = F_NAME;
        c.props.name = n;
        write(c);
      }
      reorder(variablesOf(g), vars, index);
      commit();
      return OK;
    }
    case CommandId::DUPLICATE_VARIABLES: {
      std::vector<Guid> vars = argGuids(args, {"variables", "variable"});
      if (vars.empty()) return E_INVALID;
      Guid g = collectionOfVar(vars[0]);
      for (Guid v : vars)
        if (!variableNode(v) || collectionOfVar(v) != g) return E_INVALID;
      begin(TxnKind::USER, vars.size() == 1 ? "Duplicate variable" : "Duplicate variables");
      std::set<std::string> fresh;
      copyVariables(
          vars, g, nullptr,
          [&](const std::string& n) {
            std::string name = uniqueName(n + " copy", [&](const std::string& s) { return fresh.count(s) || nameTaken(g, s, {}); });
            fresh.insert(name);
            return name;
          },
          false);
      commit();
      return OK;
    }
    case CommandId::SET_VARIABLE_VALUE: {
      Guid v = argGuid(args, "variable");
      const NodeProps* vp = variableNode(v);
      const json::Value* value = arg(args, "value");
      if (!vp || !value) return E_INVALID;
      Guid g = findCollection(vp->asset().variableSetID);
      Guid mode = arg(args, "mode") ? argGuid(args, "mode") : (collectionNode(g) ? collectionNode(g)->defaultMode() : kNoGuid);
      bool known = false;
      if (const NodeProps* sp = collectionNode(g))
        for (auto& m : sp->asset().variableSetModes) known |= m.id == mode;
      VariableData data;
      // A mode of an extended collection: the extension's override for this variable (Figma: overrides show in blue).
      Guid ext = !known && g != kNoGuid ? collectionOfMode(g, mode) : kNoGuid;
      if (ext != kNoGuid && ext != g) {
        if (isLibraryCopy(ext) || !parseValue(*value, vp->asset().variableResolvedType, v, data)) return E_INVALID;
        begin(TxnKind::USER, "Edit variable");
        Guid o = overrideNode(ext, v);
        if (o == kNoGuid) {
          NodeProps op;
          op.type = NodeType::VARIABLE_OVERRIDE;
          op.name = vp->name;
          op.asset().variableSetID = AssetId::of(ext);
          op.asset().overriddenVariableId = AssetId::of(v);
          op.asset().variableResolvedType = vp->asset().variableResolvedType;
          op.asset().variableDataValues = {{mode, data}};
          op.parentIndex = {ext, doc_.positionAtEnd(ext)};
          write(NodeChange::created(newGuid(), op));
        } else {
          std::vector<VariableModeValue> values = doc_.get(o)->props.asset().variableDataValues;
          auto it = std::find_if(values.begin(), values.end(), [&](const VariableModeValue& mv) { return mv.modeID == mode; });
          if (it != values.end()) it->data = data;
          else values.push_back({mode, data});
          NodeChange c = NodeChange::changed(o);
          c.mask = F_VARIABLE_DATA_VALUES;
          c.props.asset().variableDataValues = values;
          write(c);
        }
        commit();
        return OK;
      }
      if (!known || !parseValue(*value, vp->asset().variableResolvedType, v, data)) return E_INVALID;
      std::vector<VariableModeValue> values = vp->asset().variableDataValues;
      auto it = std::find_if(values.begin(), values.end(), [&](const VariableModeValue& mv) { return mv.modeID == mode; });
      if (it != values.end()) it->data = data;
      else values.push_back({mode, data});
      begin(TxnKind::USER, "Edit variable");
      NodeChange c = NodeChange::changed(v);
      c.mask = F_VARIABLE_DATA_VALUES;
      c.props.asset().variableDataValues = values;
      write(c);
      commit();
      return OK;
    }
    case CommandId::SET_VARIABLE_SCOPES: {
      std::vector<Guid> vars = argGuids(args, {"variables", "variable"});
      const json::Value* list = arg(args, "scopes");
      if (vars.empty() || !list || !list->isArray()) return E_INVALID;
      std::vector<VariableScope> scopes;
      for (auto& e : list->array) {
        VariableScope sc = VariableScope::ALL_SCOPES;
        if (!e.isString() || !scopeFromName(e.string, sc)) return E_INVALID;
        if (std::find(scopes.begin(), scopes.end(), sc) == scopes.end()) scopes.push_back(sc);
      }
      // "Show in all" excludes the others; all fills excludes the fill kinds (Figma's rule, R3-16).
      if (std::find(scopes.begin(), scopes.end(), VariableScope::ALL_SCOPES) != scopes.end()) scopes = {VariableScope::ALL_SCOPES};
      if (std::find(scopes.begin(), scopes.end(), VariableScope::ALL_FILLS) != scopes.end())
        scopes.erase(std::remove_if(scopes.begin(), scopes.end(), [](VariableScope s) {
                       return s == VariableScope::FRAME_FILL || s == VariableScope::SHAPE_FILL || s == VariableScope::TEXT_FILL;
                     }),
                     scopes.end());
      for (Guid v : vars)
        if (!variableNode(v)) return E_INVALID;
      begin(TxnKind::USER, "Edit variable scopes");
      for (Guid v : vars) {
        NodeChange c = NodeChange::changed(v);
        c.mask = F_VARIABLE_SCOPES;
        c.props.asset().variableScopes = scopes;
        write(c);
      }
      commit();
      return OK;
    }
    case CommandId::SET_VARIABLE_CODE_SYNTAX: {
      Guid v = argGuid(args, "variable");
      std::string platform, value;
      CodeSyntaxPlatform pl = CodeSyntaxPlatform::WEB;
      if (!variableNode(v) || !argString(args, "platform", platform) || !enumFromName(platform, pl)) return E_INVALID;
      argString(args, "value", value);
      value = trim(value);
      std::vector<CodeSyntaxEntry> list = variableNode(v)->asset().codeSyntax;
      list.erase(std::remove_if(list.begin(), list.end(), [&](const CodeSyntaxEntry& e) { return e.platform == pl; }), list.end());
      if (!value.empty()) list.push_back({pl, value});
      std::sort(list.begin(), list.end(), [](const CodeSyntaxEntry& a, const CodeSyntaxEntry& b) { return a.platform < b.platform; });
      begin(TxnKind::USER, "Edit code syntax");
      NodeChange c = NodeChange::changed(v);
      c.mask = F_CODE_SYNTAX;
      c.props.asset().codeSyntax = list;
      write(c);
      commit();
      return OK;
    }
    case CommandId::SET_VARIABLE_DESCRIPTION: {
      Guid v = argGuid(args, "variable");
      std::string description;
      if (!variableNode(v) || !argString(args, "description", description)) return E_INVALID;
      begin(TxnKind::USER, "Edit description");
      NodeChange c = NodeChange::changed(v);
      c.mask = F_DESCRIPTION;
      c.props.asset().description = description;
      write(c);
      commit();
      return OK;
    }
    case CommandId::SET_VARIABLE_HIDDEN: {
      std::vector<Guid> vars = argGuids(args, {"variables", "variable"});
      const json::Value* hidden = arg(args, "hidden");
      if (vars.empty() || !hidden || !hidden->isBool()) return E_INVALID;
      for (Guid v : vars)
        if (!variableNode(v)) return E_INVALID;
      begin(TxnKind::USER, "Hide from publishing");
      for (Guid v : vars) {
        NodeChange c = NodeChange::changed(v);
        c.mask = F_IS_PUBLISHABLE;
        c.props.asset().isPublishable = !hidden->boolean;
        write(c);
      }
      commit();
      return OK;
    }

    // ---- Groups (slash names) ----
    case CommandId::GROUP_VARIABLES: {
      std::vector<Guid> vars = argGuids(args, {"variables", "variable"});
      std::string name;
      if (vars.empty() || !argString(args, "name", name) || (name = normalizePath(name)).empty()) return E_INVALID;
      Guid g = collectionOfVar(vars[0]);
      for (Guid v : vars)
        if (!variableNode(v) || collectionOfVar(v) != g) return E_INVALID;
      // The new group sits in the deepest group the selection shares.
      std::string common = groupOf(doc_.get(vars[0])->props.name);
      for (Guid v : vars) {
        const std::string& n = doc_.get(v)->props.name;
        while (!common.empty() && !underGroup(n, common)) common = groupOf(common);
      }
      std::unordered_set<Guid, GuidHash> moving(vars.begin(), vars.end());
      std::vector<std::pair<Guid, std::string>> names;
      for (Guid v : vars) {
        const std::string& n = doc_.get(v)->props.name;
        std::string rest = common.empty() ? n : n.substr(common.size() + 1);
        std::string fresh = joinPath(joinPath(common, name), rest);
        if (fresh.find_first_of(".{}") != std::string::npos || nameTaken(g, fresh, moving)) return E_INVALID;
        names.push_back({v, fresh});
      }
      begin(TxnKind::USER, "Group variables");
      for (auto& [v, n] : names) {
        NodeChange c = NodeChange::changed(v);
        c.mask = F_NAME;
        c.props.name = n;
        write(c);
      }
      commit();
      return OK;
    }
    case CommandId::RENAME_VARIABLE_GROUP:
    case CommandId::UNGROUP_VARIABLES:
    case CommandId::DELETE_VARIABLE_GROUP:
    case CommandId::DUPLICATE_VARIABLE_GROUP: {
      Guid g = argGuid(args, "collection");
      std::string group, name;
      if (!collectionNode(g) || !argString(args, "group", group) || (group = normalizePath(group)).empty()) return E_INVALID;
      std::vector<Guid> vars;
      for (Guid v : variablesOf(g))
        if (underGroup(doc_.get(v)->props.name, group)) vars.push_back(v);
      if (vars.empty()) return E_INVALID;
      if (id == CommandId::DELETE_VARIABLE_GROUP) {
        begin(TxnKind::USER, "Delete group");
        deleteVariables(vars);
        commit();
        return OK;
      }
      std::string newGroup;
      if (id == CommandId::RENAME_VARIABLE_GROUP) {
        if (!argString(args, "name", name) || (name = normalizePath(name)).empty()) return E_INVALID;
        newGroup = joinPath(groupOf(group), name);
      } else if (id == CommandId::UNGROUP_VARIABLES) {
        newGroup = groupOf(group);
      } else {
        newGroup = uniqueName(group + " copy", [&](const std::string& s) {
          for (Guid v : variablesOf(g))
            if (underGroup(doc_.get(v)->props.name, s)) return true;
          return false;
        });
      }
      std::unordered_set<Guid, GuidHash> moving;
      if (id != CommandId::DUPLICATE_VARIABLE_GROUP) moving.insert(vars.begin(), vars.end());
      std::vector<std::pair<Guid, std::string>> names;
      std::set<std::string> fresh;
      for (Guid v : vars) {
        std::string n = joinPath(newGroup, doc_.get(v)->props.name.substr(group.size() + 1));
        if (n.find_first_of(".{}") != std::string::npos || !fresh.insert(n).second || nameTaken(g, n, moving)) return E_INVALID;
        names.push_back({v, n});
      }
      if (id == CommandId::DUPLICATE_VARIABLE_GROUP) {
        begin(TxnKind::USER, "Duplicate group");
        std::unordered_map<std::string, std::string> rename;
        for (auto& [v, n] : names) rename[doc_.get(v)->props.name] = n;
        copyVariables(vars, g, nullptr, [&](const std::string& n) { return rename[n]; }, true);
        commit();
        return OK;
      }
      begin(TxnKind::USER, id == CommandId::RENAME_VARIABLE_GROUP ? "Rename group" : "Ungroup");
      for (auto& [v, n] : names) {
        NodeChange c = NodeChange::changed(v);
        c.mask = F_NAME;
        c.props.name = n;
        write(c);
      }
      commit();
      return OK;
    }

    // ---- Using variables ----
    case CommandId::BIND_VARIABLE:
    case CommandId::DETACH_VARIABLE: {
      std::string targetName;
      BindTarget t;
      if (!argString(args, "target", targetName) || !parseTarget(targetName, t)) return E_INVALID;
      Guid var = kNoGuid;
      VariableResolvedType type = VariableResolvedType::BOOLEAN;
      if (id == CommandId::BIND_VARIABLE) {
        const json::Value* v = arg(args, "variable");
        if (v && !v->isNull() && !(v->isString() && v->string.empty())) {
          var = guidOf(*v);
          const NodeProps* vp = variableNode(var);
          if (!vp || vp->comp().isSoftDeleted || !accepts(t, vp->asset().variableResolvedType)) return E_INVALID;
          type = vp->asset().variableResolvedType;
        }
      }
      std::vector<Guid> refs = refsOrSelection();
      std::vector<Guid> live;
      for (Guid r : refs)
        if (doc_.has(r)) live.push_back(r);
      if (live.empty()) return E_INVALID;
      begin(TxnKind::USER, var != kNoGuid ? "Apply variable" : "Detach variable");
      for (Guid r : live) {
        const NodeProps& p = doc_.get(r)->props;
        NodeChange c = NodeChange::changed(r);
        VariableData data = var != kNoGuid ? bindingData(t, var, type) : VariableData{};
        uint32_t rf = 0, rt = 0;
        bool ranged = p.type == NodeType::TEXT && textRange(r, rf, rt);
        if (ranged && t.kind == BindTarget::Kind::FIELD && isTypographyField(t.field)) {
          // Part of a text: the selected runs take the binding (their parameterConsumptionMap).
          TextData td = p.text().textData;
          const TextStyle* at = nullptr;
          uint32_t sid = rf < td.characterStyleIDs.size() ? td.characterStyleIDs[rf] : 0;
          for (const TextStyle& e : td.styleOverrideTable)
            if (e.styleID == sid) at = &e;
          NodeProps rp = at ? text::runProps(*at) : NodeProps{};
          auto& map = rp.parameterConsumptionMap;
          map.erase(std::remove_if(map.begin(), map.end(), [&](const ParamBinding& b) { return b.field == t.field; }), map.end());
          if (var != kNoGuid) {
            ParamBinding b;
            b.field = t.field;
            b.data = data;
            map.push_back(b);
          }
          text::applyRunExtras(td, rf, rt, {{"parameterConsumptionMap", text::extraEntry(rp, F_PARAM_MAP, "parameterConsumptionMap")}}, p);
          c.mask = F_TEXT_DATA;
          c.props.text().textData = td;
          write(c);
          continue;
        }
        if (ranged && t.kind == BindTarget::Kind::PAINT && !t.strokes && t.stop < 0) {
          // Part of a text: the selected runs' fills (those at the selection's start, with the variable).
          TextData td = p.text().textData;
          uint32_t sid = rf < td.characterStyleIDs.size() ? td.characterStyleIDs[rf] : 0;
          std::vector<Paint> paints = p.fillPaints;
          for (const TextStyle& e : td.styleOverrideTable)
            if (e.styleID == sid && (e.mask & R_FILLS)) paints = e.fillPaints;
          if (t.index >= paints.size()) continue;
          (t.member == "color" ? paints[t.index].colorVar : paints[t.index].opacityVar) = data;
          TextStyle fields;
          fields.mask = R_FILLS;
          fields.fillPaints = paints;
          text::applyRunStyle(td, rf, rt, fields, p);
          c.mask = F_TEXT_DATA;
          c.props.text().textData = td;
          write(c);
          continue;
        }
        switch (t.kind) {
          case BindTarget::Kind::FIELD: {
            c.mask = F_PARAM_MAP;
            c.props.parameterConsumptionMap = p.parameterConsumptionMap;
            auto& map = c.props.parameterConsumptionMap;
            // One parameter per field (Figma's 2025 rule): a component property binding of it goes too.
            map.erase(std::remove_if(map.begin(), map.end(), [&](const ParamBinding& b) { return b.field == t.field; }), map.end());
            if (var != kNoGuid) {
              ParamBinding b;
              b.field = t.field;
              b.data = data;
              map.push_back(b);
              // A typography binding on a styled text detaches the style (the layer now deviates from it).
              if (isTypographyField(t.field) && p.refs().styleIdForText.present()) c.mask |= F_STYLE_ID_TEXT;
            }
            break;
          }
          case BindTarget::Kind::PROPERTY: {
            if (p.type == NodeType::INSTANCE) {
              // A variant property of an instance ("Assign variable", R3-13): one RESOLVE_VARIANT binding holding every
              // bound property (Figma's files); string, number and boolean variables. Boolean and text properties of an
              // instance take no variable (Figma: "boolean variables cannot be applied to boolean properties").
              Guid main = mainOf(r);
              Guid set = main != kNoGuid ? setOf(main) : kNoGuid;
              const ComponentPropDef* def = set != kNoGuid ? findDef(set, t.member) : nullptr;
              if (!def || def->type != ComponentPropType::VARIANT) continue;
              std::vector<std::pair<std::string, Guid>> keys;
              std::vector<VariableData> values;
              for (const ParamBinding& b : p.parameterConsumptionMap)
                if (b.field == VariableField::VARIANT_PROPERTIES && b.data.kind == VariableData::Kind::EXPRESSION && !b.data.args.empty() &&
                    b.data.args[0].kind == VariableData::Kind::MAP) {
                  const VariableData& m = b.data.args[0];
                  for (size_t i = 0; i < m.args.size(); i++) {
                    Guid k = i < m.mapGuidKeys.size() ? m.mapGuidKeys[i] : kNoGuid;
                    std::string name = i < m.mapKeys.size() ? m.mapKeys[i] : std::string();
                    if (k == def->id || (k == kNoGuid && name == def->name)) continue;
                    keys.push_back({name, k});
                    values.push_back(m.args[i]);
                  }
                }
              if (var != kNoGuid) {
                keys.push_back({def->name, def->id});
                values.push_back(VariableData::aliasOf(var, type));
              }
              c.mask = F_PARAM_MAP;
              c.props.parameterConsumptionMap = p.parameterConsumptionMap;
              auto& map = c.props.parameterConsumptionMap;
              map.erase(std::remove_if(map.begin(), map.end(), [](const ParamBinding& b) { return b.field == VariableField::VARIANT_PROPERTIES; }),
                        map.end());
              if (!keys.empty()) {
                ParamBinding b;
                b.field = VariableField::VARIANT_PROPERTIES;
                b.data = VariableData::resolveVariant(keys, std::move(values));
                map.push_back(std::move(b));
              }
              break;
            }
            // A main's (or a set's) boolean / text property: its default bound to a variable ("Apply variable" in the
            // property's settings).
            Guid owner = propOwner(r);
            const ComponentPropDef* def = owner != kNoGuid ? findDef(owner, t.member) : nullptr;
            if (!def) continue;
            if (var != kNoGuid && !((def->type == ComponentPropType::BOOL && type == VariableResolvedType::BOOLEAN) ||
                                    (def->type == ComponentPropType::TEXT && type == VariableResolvedType::STRING)))
              continue;
            Guid defId = def->id;
            NodeChange d = NodeChange::changed(owner);
            d.mask = F_COMPONENT_PROP_DEFS;
            d.props.comp().componentPropDefs = doc_.get(owner)->props.comp().componentPropDefs;
            for (ComponentPropDef& e : d.props.comp().componentPropDefs) {
              if (e.id != defId) continue;
              e.boundValue = var != kNoGuid ? VariableData::aliasOf(var, type) : VariableData{};
              // The default shows the variable's value (its default modes) while it is bound.
              Resolved rv;
              if (var != kNoGuid && resolveVariable(var, kNoGuid, rv)) {
                if (e.type == ComponentPropType::BOOL && rv.kind == Resolved::Kind::BOOL) e.initialValue.hasBool = true, e.initialValue.boolValue = rv.b;
                if (e.type == ComponentPropType::TEXT && rv.kind == Resolved::Kind::STRING) {
                  e.initialValue.hasText = true;
                  e.initialValue.textValue = TextData{};
                  e.initialValue.textValue.characters = rv.s;
                }
              }
            }
            write(d);
            continue;
          }
          case BindTarget::Kind::PAINT: {
            std::vector<Paint> paints = t.strokes ? p.strokePaints : p.fillPaints;
            if (t.index >= paints.size()) continue;
            Paint& pt = paints[t.index];
            if (t.stop >= 0) {
              if (static_cast<size_t>(t.stop) >= pt.stops.size()) continue;
              if (pt.stopVars.size() <= static_cast<size_t>(t.stop)) pt.stopVars.resize(static_cast<size_t>(t.stop) + 1);
              pt.stopVars[static_cast<size_t>(t.stop)] = data;
              while (!pt.stopVars.empty() && !pt.stopVars.back().present()) pt.stopVars.pop_back();
            } else if (t.member == "color") {
              pt.colorVar = data;
            } else {
              pt.opacityVar = data;
            }
            c.mask = t.strokes ? F_STROKES : F_FILLS;
            (t.strokes ? c.props.strokePaints : c.props.fillPaints) = paints;
            break;
          }
          case BindTarget::Kind::EFFECT: {
            std::vector<Effect> effects = p.effects;
            if (t.index >= effects.size()) continue;
            Effect& e = effects[t.index];
            (t.member == "color" ? e.colorVar : t.member == "radius" ? e.radiusVar : t.member == "spread" ? e.spreadVar
                                                : t.member == "x"   ? e.xVar
                                                                    : e.yVar) = data;
            c.mask = F_EFFECTS;
            c.props.effects = effects;
            break;
          }
          case BindTarget::Kind::GRID: {
            std::vector<LayoutGrid> grids = p.rare().layoutGrids;
            if (t.index >= grids.size()) continue;
            LayoutGrid& g = grids[t.index];
            (t.member == "numSections" ? g.numSectionsVar : t.member == "offset" ? g.offsetVar
                                                         : t.member == "sectionSize" ? g.sectionSizeVar
                                                                                     : g.gutterSizeVar) = data;
            c.mask = F_LAYOUT_GRIDS;
            c.props.rare().layoutGrids = grids;
            break;
          }
        }
        write(c);
        // A bound width / height is a fixed size (Hug / Fill → Fixed; auto-resizing text → its fixed axis).
        if (var != kNoGuid && t.kind == BindTarget::Kind::FIELD && (t.field == VariableField::WIDTH || t.field == VariableField::HEIGHT))
          keepResizedSize(r, t.field == VariableField::WIDTH, t.field == VariableField::HEIGHT);
      }
      commit();
      return OK;
    }
    case CommandId::EXTEND_VARIABLE_COLLECTION: {
      // "Extend collection" (R3-32): a collection inheriting this one's variables and modes, overriding values only.
      Guid g = argGuid(args, "collection");
      const NodeProps* sp = collectionNode(g);
      if (!sp) return E_INVALID;
      const NodeProps src = *sp;
      std::string name;
      if (argString(args, "name", name)) {
        name = trim(name);
        if (name.empty()) return E_INVALID;
      } else {
        name = uniqueName(src.name + " extended", [&](const std::string& n) {
          for (Guid c : collections(true))
            if (doc_.get(c)->props.name == n) return true;
          return false;
        });
      }
      begin(TxnKind::USER, "Extend collection");
      Guid canvas = internalCanvas(true);
      NodeProps p;
      p.type = NodeType::VARIABLE_SET;
      p.name = name;
      for (const VariableSetMode& m : src.orderedModes()) {
        VariableSetMode mine;
        mine.id = newGuid();
        mine.name = m.name;
        mine.sortPosition = m.sortPosition;
        mine.parentSet = AssetId::of(g);
        mine.parentMode = m.id;
        p.asset().variableSetModes.push_back(mine);
      }
      p.asset().key = newAssetKey();
      p.parentIndex = {canvas, doc_.positionAtEnd(canvas)};
      Guid ext = newGuid();
      std::vector<Guid> order = collections();
      write(NodeChange::created(ext, p));
      created_ = {ext};
      auto at = std::find(order.begin(), order.end(), g);
      order.insert(at == order.end() ? order.end() : at + 1, ext);
      writeOrder(order, {ext});
      commit();
      return OK;
    }
    case CommandId::RESET_VARIABLE_OVERRIDE: {
      // "Reset change": an extended collection's value back to its parent's (one mode, or every mode).
      Guid ext = argGuid(args, "collection");
      std::vector<Guid> vars = argGuids(args, {"variables", "variable"});
      if (extensionParent(ext) == kNoGuid || vars.empty() || isLibraryCopy(ext)) return E_INVALID;
      Guid mode = arg(args, "mode") ? argGuid(args, "mode") : kNoGuid;
      begin(TxnKind::USER, "Reset change");
      for (Guid v : vars) {
        Guid o = overrideNode(ext, v);
        if (o == kNoGuid) continue;
        std::vector<VariableModeValue> values = doc_.get(o)->props.asset().variableDataValues;
        if (mode != kNoGuid)
          values.erase(std::remove_if(values.begin(), values.end(), [&](const VariableModeValue& mv) { return mv.modeID == mode; }), values.end());
        else
          values.clear();
        if (values.empty()) {
          write(NodeChange::removed(o));
        } else {
          NodeChange c = NodeChange::changed(o);
          c.mask = F_VARIABLE_DATA_VALUES;
          c.props.asset().variableDataValues = values;
          write(c);
        }
      }
      commit();
      return OK;
    }
    case CommandId::SET_VARIABLE_MODE: {
      Guid g = argGuid(args, "collection");
      // An extended collection's mode: the entry of its root collection, naming the extension (one mode value per
      // collection, Figma).
      Guid extension = kNoGuid;
      if (extensionParent(g) != kNoGuid) {
        extension = g;
        g = rootCollection(g);
      }
      const NodeProps* sp = collectionNode(g);
      if (!sp) return E_INVALID;
      Guid mode = kNoGuid;
      if (const json::Value* m = arg(args, "mode"); m && !m->isNull() && !(m->isString() && m->string.empty())) {
        mode = guidOf(*m);
        bool known = false;
        const NodeProps* owner = extension != kNoGuid ? collectionNode(extension) : sp;
        for (auto& x : owner->asset().variableSetModes) known |= x.id == mode;
        if (!known) return E_INVALID;
      }
      std::vector<Guid> refs;
      if (Guid page = argGuid(args, "page"); page != kNoGuid) refs = {page};
      else refs = refsOrSelection();
      refs.erase(std::remove_if(refs.begin(), refs.end(), [&](Guid r) { return !doc_.has(r); }), refs.end());
      if (refs.empty()) return E_INVALID;
      begin(TxnKind::USER, "Apply variable mode");
      for (Guid r : refs) {
        const NodeProps& p = doc_.get(r)->props;
        NodeChange c = NodeChange::changed(r);
        c.mask = F_VARIABLE_MODES;
        c.props.refs().variableModeBySetMap = p.refs().variableModeBySetMap;
        auto& list = c.props.refs().variableModeBySetMap;
        list.erase(std::remove_if(list.begin(), list.end(),
                                  [&](const VariableModeEntry& e) { return e.set.guid == g || (!e.set.key.empty() && e.set.key == sp->asset().key); }),
                   list.end());
        if (mode != kNoGuid) list.push_back({AssetId::of(g), mode, extension != kNoGuid ? AssetId::of(extension) : AssetId{}});
        write(c);
      }
      commit();
      return OK;
    }

    // ---- Styles ----
    case CommandId::CREATE_STYLE: {
      std::string typeName, name, targetName;
      StyleType type = StyleType::NONE;
      if (!argString(args, "type", typeName) || !styleTypeFromName(typeName, type)) return E_INVALID;
      bool strokes = argString(args, "target", targetName) && targetName == "STROKE";
      if (argString(args, "name", name)) {
        name = normalizePath(name);
        if (name.empty()) return E_INVALID;
      } else {
        name = defaultStyleName(type);
      }
      Guid from = argGuid(args, "from");
      const NodeProps* fp = doc_.has(from) ? &doc_.get(from)->props : nullptr;
      if (type == StyleType::TEXT && fp && fp->type != NodeType::TEXT) fp = nullptr;
      NodeProps p = defaultProps(type == StyleType::TEXT ? NodeType::TEXT : NodeType::ROUNDED_RECTANGLE);
      p.fillPaints.clear();
      p.strokeWeight = 0;
      p.size = {100, 100};
      p.name = name;
      p.asset().styleType = type;
      p.text().autoRename = false;
      switch (type) {
        case StyleType::FILL:
          p.fillPaints = fp ? (strokes ? fp->strokePaints : fp->fillPaints) : std::vector<Paint>{Paint::solid(Color{1, 1, 1, 1})};
          break;
        case StyleType::TEXT:
          p.text().textData.characters = "Ag";
          p.text().textAutoResize = TextAutoResize::NONE;
          p.fillPaints = {Paint::solid(Color{0, 0, 0, 1})};
          if (fp) {
            copyFields(p, *fp, kTextStyleFieldsMask);
            for (const ParamBinding& b : fp->parameterConsumptionMap)
              if (b.isVariable() && isTypographyField(b.field)) p.parameterConsumptionMap.push_back(b);
          }
          break;
        case StyleType::EFFECT:
          if (fp) {
            p.effects = fp->effects;
          } else {
            Effect e;  // Figma's default drop shadow: black 25 %, y 4, blur 4
            e.type = EffectType::DROP_SHADOW;
            e.color = Color{0, 0, 0, 0.25f};
            e.offset = {0, 4};
            e.radius = 4;
            p.effects = {e};
          }
          break;
        case StyleType::GRID:
          if (fp) {
            p.rare().layoutGrids = fp->rare().layoutGrids;
          } else {
            LayoutGrid g;  // Figma's default layout guide: a 10 px grid, red 10 %
            g.type = LayoutGridType::STRETCH;
            g.pattern = LayoutGridPattern::GRID;
            g.sectionSize = 10;
            g.color = Color{1, 0, 0, 0.1f};
            p.rare().layoutGrids = {g};
          }
          break;
        default: break;
      }
      const json::Value* apply = arg(args, "apply");
      bool applyIt = fp && apply && apply->isBool() && apply->boolean;
      begin(TxnKind::USER, "Create style");
      Guid canvas = internalCanvas(true);
      p.asset().sortPosition = keyAfter(stylesOf(StyleType::NONE));
      p.asset().key = newAssetKey();
      p.parentIndex = {canvas, doc_.positionAtEnd(canvas)};
      Guid g = newGuid();
      write(NodeChange::created(g, p));
      created_ = {g};
      if (applyIt) {
        NodeChange c = NodeChange::changed(from);
        FieldMask bit = type == StyleType::FILL ? (strokes ? F_STYLE_ID_STROKE : F_STYLE_ID_FILL)
                        : type == StyleType::TEXT ? F_STYLE_ID_TEXT
                        : type == StyleType::EFFECT ? F_STYLE_ID_EFFECT
                                                    : F_STYLE_ID_GRID;
        c.mask = bit;
        AssetId ref = AssetId::of(g);
        if (bit == F_STYLE_ID_FILL) c.props.refs().styleIdForFill = ref;
        else if (bit == F_STYLE_ID_STROKE) c.props.refs().styleIdForStrokeFill = ref;
        else if (bit == F_STYLE_ID_TEXT) c.props.refs().styleIdForText = ref;
        else if (bit == F_STYLE_ID_EFFECT) c.props.refs().styleIdForEffect = ref;
        else c.props.refs().styleIdForGrid = ref;
        write(c);
      }
      commit();
      return OK;
    }
    case CommandId::DELETE_STYLE: {
      std::vector<Guid> styles = argGuids(args, {"styles", "style"});
      styles.erase(std::remove_if(styles.begin(), styles.end(), [&](Guid s) { return !styleOf(s); }), styles.end());
      if (styles.empty()) return E_INVALID;
      std::unordered_set<Guid, GuidHash> gone(styles.begin(), styles.end());
      auto ours = [&](const AssetId& a) { return a.present() && gone.count(findStyle(a)); };
      begin(TxnKind::USER, styles.size() == 1 ? "Delete style" : "Delete styles");
      // Its users keep their values, detached (Figma); so do instance overrides that name it.
      std::vector<Guid> users;
      doc_.forEach([&](const Node& n) {
        if (!n.guid.isDerived() && !n.props.isStyle()) users.push_back(n.guid);
      });
      std::sort(users.begin(), users.end());
      for (Guid u : users) {
        const NodeProps& p = doc_.get(u)->props;
        NodeChange c = NodeChange::changed(u);
        if (ours(p.refs().styleIdForFill)) c.mask |= F_STYLE_ID_FILL;
        if (ours(p.refs().styleIdForStrokeFill)) c.mask |= F_STYLE_ID_STROKE;
        if (ours(p.refs().styleIdForText)) c.mask |= F_STYLE_ID_TEXT;
        if (ours(p.refs().styleIdForEffect)) c.mask |= F_STYLE_ID_EFFECT;
        if (ours(p.refs().styleIdForGrid)) c.mask |= F_STYLE_ID_GRID;
        if (p.type == NodeType::INSTANCE) {
          SymbolData sd = p.comp().symbolData;
          bool changed = false;
          for (SymbolOverride& o : sd.overrides) {
            for (auto [bit, ref] : {std::pair{F_STYLE_ID_FILL, &o.props.refs().styleIdForFill}, std::pair{F_STYLE_ID_STROKE, &o.props.refs().styleIdForStrokeFill},
                                    std::pair{F_STYLE_ID_TEXT, &o.props.refs().styleIdForText}, std::pair{F_STYLE_ID_EFFECT, &o.props.refs().styleIdForEffect},
                                    std::pair{F_STYLE_ID_GRID, &o.props.refs().styleIdForGrid}})
              if ((o.mask & bit) && ours(*ref)) *ref = AssetId{}, changed = true;
          }
          if (changed) c.mask |= F_SYMBOL_DATA, c.props.comp().symbolData = sd;
        }
        if (!c.mask) continue;
        bool prev = resolving_;
        resolving_ = true;  // a detach, not an edit of values
        write(c);
        resolving_ = prev;
      }
      for (Guid s : styles) write(NodeChange::removed(s));
      commit();
      return OK;
    }
    case CommandId::APPLY_STYLE:
    case CommandId::DETACH_STYLE: {
      std::string targetName;
      Guid style = kNoGuid;
      StyleType type = StyleType::NONE;
      argString(args, "target", targetName);
      if (id == CommandId::APPLY_STYLE) {
        style = argGuid(args, "style");
        const NodeProps* sp = styleOf(style);
        if (!sp) return E_INVALID;
        type = sp->asset().styleType;
        if (targetName.empty()) targetName = type == StyleType::FILL ? "FILL" : enumName(type);
        if (type == StyleType::FILL ? (targetName != "FILL" && targetName != "STROKE") : targetName != enumName(type)) return E_INVALID;
      } else if (targetName != "FILL" && targetName != "STROKE" && targetName != "TEXT" && targetName != "EFFECT" && targetName != "GRID") {
        return E_INVALID;
      }
      FieldMask bit = targetName == "FILL" ? F_STYLE_ID_FILL : targetName == "STROKE" ? F_STYLE_ID_STROKE
                      : targetName == "TEXT"  ? F_STYLE_ID_TEXT
                      : targetName == "EFFECT" ? F_STYLE_ID_EFFECT
                                               : F_STYLE_ID_GRID;
      std::vector<Guid> refs = refsOrSelection();
      refs.erase(std::remove_if(refs.begin(), refs.end(), [&](Guid r) { return !doc_.has(r) || doc_.get(r)->props.isStyle(); }), refs.end());
      if (refs.empty()) return E_INVALID;
      begin(TxnKind::USER, style != kNoGuid ? "Apply style" : "Detach style");
      for (Guid r : refs) {
        const NodeProps& p = doc_.get(r)->props;
        if (bit == F_STYLE_ID_TEXT && p.type != NodeType::TEXT) continue;
        NodeChange c = NodeChange::changed(r);
        uint32_t rf = 0, rt = 0;
        if (bit == F_STYLE_ID_TEXT && textRange(r, rf, rt)) {
          // Part of a text: the selected runs take the style (their styleIdForText); a detach keeps their values.
          TextData td = p.text().textData;
          NodeProps sp;
          if (style != kNoGuid) sp.refs().styleIdForText = AssetId::of(style);
          text::applyRunExtras(td, rf, rt, {{"styleIdForText", style != kNoGuid ? text::extraEntry(sp, F_STYLE_ID_TEXT, "styleIdForText") : std::string()}}, p);
          c.mask = F_TEXT_DATA;
          c.props.text().textData = td;
          write(c);
          continue;
        }
        c.mask = bit;
        AssetId ref = style != kNoGuid ? AssetId::of(style) : AssetId{};
        if (bit == F_STYLE_ID_FILL) c.props.refs().styleIdForFill = ref;
        else if (bit == F_STYLE_ID_STROKE) c.props.refs().styleIdForStrokeFill = ref;
        else if (bit == F_STYLE_ID_TEXT) c.props.refs().styleIdForText = ref;
        else if (bit == F_STYLE_ID_EFFECT) c.props.refs().styleIdForEffect = ref;
        else c.props.refs().styleIdForGrid = ref;
        if (bit == F_STYLE_ID_TEXT && style != kNoGuid) {
          // The whole layer takes the style: its runs' typography goes (their colours stay).
          TextData t = p.text().textData;
          text::clearRunFields(t, kTextStyleRunFields);
          if (!(t == p.text().textData)) c.mask |= F_TEXT_DATA, c.props.text().textData = t;
        }
        write(c);
      }
      commit();
      return OK;
    }
    case CommandId::MOVE_STYLE: {
      Guid s = argGuid(args, "style");
      double index = 0;
      if (!styleOf(s) || !argNumber(args, "index", index)) return E_INVALID;
      begin(TxnKind::USER, "Move style");
      reorder(stylesOf(styleOf(s)->asset().styleType), {s}, index);
      commit();
      return OK;
    }
    case CommandId::GROUP_STYLES: {
      std::vector<Guid> styles = argGuids(args, {"styles", "style"});
      std::string name;
      if (styles.empty() || !argString(args, "name", name) || (name = normalizePath(name)).empty()) return E_INVALID;
      for (Guid s : styles)
        if (!styleOf(s)) return E_INVALID;
      std::string common = groupOf(doc_.get(styles[0])->props.name);
      for (Guid s : styles) {
        const std::string& n = doc_.get(s)->props.name;
        while (!common.empty() && !underGroup(n, common)) common = groupOf(common);
      }
      begin(TxnKind::USER, "Add new folder");
      for (Guid s : styles) {
        const std::string& n = doc_.get(s)->props.name;
        NodeChange c = NodeChange::changed(s);
        c.mask = F_NAME;
        c.props.name = joinPath(joinPath(common, name), common.empty() ? n : n.substr(common.size() + 1));
        write(c);
      }
      commit();
      return OK;
    }
    case CommandId::RENAME_STYLE_GROUP:
    case CommandId::UNGROUP_STYLES: {
      std::string typeName, group, name;
      StyleType type = StyleType::NONE;
      if (!argString(args, "type", typeName) || !styleTypeFromName(typeName, type) || !argString(args, "group", group) ||
          (group = normalizePath(group)).empty())
        return E_INVALID;
      std::string newGroup = groupOf(group);
      if (id == CommandId::RENAME_STYLE_GROUP) {
        if (!argString(args, "name", name) || (name = normalizePath(name)).empty()) return E_INVALID;
        newGroup = joinPath(groupOf(group), name);
      }
      std::vector<Guid> styles;
      for (Guid s : stylesOf(type))
        if (underGroup(doc_.get(s)->props.name, group)) styles.push_back(s);
      if (styles.empty()) return E_INVALID;
      begin(TxnKind::USER, id == CommandId::RENAME_STYLE_GROUP ? "Rename folder" : "Ungroup");
      for (Guid s : styles) {
        NodeChange c = NodeChange::changed(s);
        c.mask = F_NAME;
        c.props.name = joinPath(newGroup, doc_.get(s)->props.name.substr(group.size() + 1));
        write(c);
      }
      commit();
      return OK;
    }
    default: break;
  }
  return E_UNSUPPORTED;
}

}  // namespace eng
