// Annotations, measurements and annotation categories read from (and measurements written to) the document's kiwi
// fields (see Annotations.h).

#include "editor/Annotations.h"

#include <cmath>
#include <cstdio>

#include "scene/CodecKiwi.h"

namespace eng::annot {

namespace {

const json::Value* member(const json::Value& v, const char* key) { return v.isObject() ? v.get(key) : nullptr; }

std::string str(const json::Value* v) { return v && v->isString() ? v->string : std::string(); }

json::Value parsedExtra(const NodeProps& p, const char* field) {
  json::Value v;
  auto it = p.extra.find(field);
  if (it == p.extra.end() || it->second.empty()) return v;
  json::parse(codec::extraValueToJson("NodeChange", it->second), v);
  return v;
}

std::string number(double v);

}  // namespace

std::string formatNumber(double v) { return number(v); }

namespace {

std::string number(double v) {
  char buf[32];
  std::snprintf(buf, sizeof buf, "%.2f", std::round(v * 100) / 100);
  std::string s = buf;
  while (!s.empty() && s.back() == '0') s.pop_back();
  if (!s.empty() && s.back() == '.') s.pop_back();
  return s == "-0" ? "0" : s;
}

std::string hex(const Color& c) {
  auto byte = [](float f) { return static_cast<int>(std::lround(std::fmin(1.f, std::fmax(0.f, f)) * 255)); };
  char buf[16];
  std::snprintf(buf, sizeof buf, "#%02X%02X%02X", byte(c.r), byte(c.g), byte(c.b));
  return buf;
}

std::string paintValue(const std::vector<Paint>& paints) {
  for (const Paint& p : paints) {
    if (!p.visible) continue;
    if (p.type == PaintType::SOLID) {
      std::string s = hex(p.color);
      double a = p.opacity * p.color.a;
      if (a < 0.999) s += " " + number(a * 100) + "%";
      return s;
    }
    if (p.type == PaintType::IMAGE) return "Image";
    return "Gradient";
  }
  return "";
}

// Text with HTML tags removed and the common entities decoded (older files keep notes as HTML).
std::string htmlText(const std::string& s) {
  if (s.find('<') == std::string::npos) return s;
  std::string out;
  bool tag = false;
  std::string name;
  for (size_t i = 0; i < s.size(); i++) {
    char c = s[i];
    if (tag) {
      if (c == '>') {
        tag = false;
        if (name == "p" || name == "/p" || name == "br" || name == "br/" || name == "li" || name == "/li" || name == "div" || name == "/div")
          if (!out.empty() && out.back() != '\n') out += '\n';
      } else if (c != ' ' || name.empty()) {
        if (c != ' ') name += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      } else {
        name += ' ';  // attributes follow: the tag's name is complete
      }
      if (name.find(' ') != std::string::npos) name = name.substr(0, name.find(' '));
      continue;
    }
    if (c == '<') {
      tag = true;
      name.clear();
      continue;
    }
    if (c == '&') {
      static const std::pair<const char*, const char*> kEntities[] = {{"&amp;", "&"}, {"&lt;", "<"}, {"&gt;", ">"}, {"&quot;", "\""}, {"&#39;", "'"}, {"&nbsp;", " "}};
      bool done = false;
      for (auto& [e, r] : kEntities)
        if (s.compare(i, std::char_traits<char>::length(e), e) == 0) {
          out += r;
          i += std::char_traits<char>::length(e) - 1;
          done = true;
          break;
        }
      if (done) continue;
    }
    out += c;
  }
  while (!out.empty() && out.back() == '\n') out.pop_back();
  return out;
}

// Inline markdown markers removed: **, __, ~~, `, *, _ (when they pair up), [text](url) → text.
std::string inlinePlain(const std::string& s) {
  std::string out;
  for (size_t i = 0; i < s.size(); i++) {
    char c = s[i];
    if (c == '\\' && i + 1 < s.size()) {
      out += s[++i];
      continue;
    }
    if (c == '[') {
      size_t close = s.find(']', i);
      if (close != std::string::npos && close + 1 < s.size() && s[close + 1] == '(') {
        size_t paren = s.find(')', close);
        if (paren != std::string::npos) {
          out += inlinePlain(s.substr(i + 1, close - i - 1));
          i = paren;
          continue;
        }
      }
    }
    if (c == '`') continue;
    if ((c == '*' || c == '_' || c == '~')) {
      // A run of the same marker that has a closing run later: dropped.
      size_t run = 1;
      while (i + run < s.size() && s[i + run] == c) run++;
      std::string marker(run, c);
      bool opens = i + run < s.size() && s[i + run] != ' ';
      bool closes = i > 0 && s[i - 1] != ' ';
      if ((opens && s.find(marker, i + run) != std::string::npos) || closes) {
        // Underscores inside words stay (snake_case).
        if (c == '_' && closes && opens) {
          out += marker;
        }
        i += run - 1;
        continue;
      }
    }
    out += c;
  }
  return out;
}

std::string trimmed(const std::string& s) {
  size_t a = s.find_first_not_of(" \t\r");
  if (a == std::string::npos) return std::string();
  size_t b = s.find_last_not_of(" \t\r");
  return s.substr(a, b - a + 1);
}

}  // namespace

const char* sideName(Side s) {
  switch (s) {
    case Side::TOP: return "TOP";
    case Side::BOTTOM: return "BOTTOM";
    case Side::LEFT: return "LEFT";
    case Side::RIGHT: return "RIGHT";
  }
  return "LEFT";
}

bool sideFromName(const std::string& name, Side& out) {
  if (name == "TOP") out = Side::TOP;
  else if (name == "BOTTOM") out = Side::BOTTOM;
  else if (name == "LEFT") out = Side::LEFT;
  else if (name == "RIGHT") out = Side::RIGHT;
  else return false;
  return true;
}

Color categoryColor(const std::string& n) {
  if (n == "YELLOW") return Color::hex(0xFFC21A);
  if (n == "ORANGE") return Color::hex(0xFF8C1A);
  if (n == "RED") return Color::hex(0xF24822);
  if (n == "PINK") return Color::hex(0xFF24BD);
  if (n == "VIOLET") return Color::hex(0x9747FF);
  if (n == "BLUE") return Color::hex(0x0D99FF);
  if (n == "TEAL") return Color::hex(0x00B5A3);
  if (n == "GREEN") return Color::hex(0x14AE5C);
  return defaultNoteColor();
}

std::string presetColorName(const std::string& preset) {
  if (preset == "DEVELOPMENT") return "BLUE";
  if (preset == "INTERACTION") return "VIOLET";
  if (preset == "ACCESSIBILITY") return "GREEN";
  if (preset == "CONTENT") return "ORANGE";
  if (preset == "BEHAVIOR") return "TEAL";
  return "GREEN";
}

std::string presetLabel(const std::string& preset) {
  if (preset == "DEVELOPMENT") return "Development";
  if (preset == "INTERACTION") return "Interaction";
  if (preset == "ACCESSIBILITY") return "Accessibility";
  if (preset == "CONTENT") return "Content";
  if (preset == "BEHAVIOR") return "Behavior";
  return "";
}

Color defaultNoteColor() { return Color::hex(0x14AE5C); }
Color measurementColor() { return Color::hex(0xFF24BD); }

Guid guidOf(const json::Value* v) {
  if (!v) return kNoGuid;
  if (v->isString()) {
    bool ok = false;
    Guid g = Guid::parse(v->string, &ok);
    return ok ? g : kNoGuid;
  }
  if (v->isObject()) {
    Guid g;
    g.sessionID = static_cast<uint32_t>(member(*v, "sessionID") ? member(*v, "sessionID")->numberOr(0) : 0);
    g.localID = static_cast<uint32_t>(member(*v, "localID") ? member(*v, "localID")->numberOr(0) : 0);
    return g;
  }
  return kNoGuid;
}

json::Value guidValue(Guid g) {
  json::Value v;
  v.kind = json::Value::Kind::Object;
  json::Value s, l;
  s.kind = l.kind = json::Value::Kind::Number;
  s.number = g.sessionID;
  l.number = g.localID;
  v.object.emplace_back("sessionID", s);
  v.object.emplace_back("localID", l);
  return v;
}

bool hasNotes(const NodeProps& p) {
  auto it = p.extra.find("annotations");
  return it != p.extra.end() && !it->second.empty();
}

std::vector<Note> notesOf(const NodeProps& p) {
  std::vector<Note> out;
  if (!hasNotes(p)) return out;
  json::Value list = parsedExtra(p, "annotations");
  if (!list.isArray()) return out;
  for (const json::Value& a : list.array) {
    Note n;
    std::string v2 = str(member(a, "labelV2"));
    n.markdown = !v2.empty() ? v2 : htmlText(str(member(a, "label")));
    if (const json::Value* props = member(a, "properties"); props && props->isArray())
      for (const json::Value& q : props->array)
        if (const json::Value* t = member(q, "type"); t && t->isString()) n.properties.push_back(t->string);
    n.category = guidOf(member(a, "categoryId"));
    out.push_back(std::move(n));
  }
  return out;
}

std::vector<Measurement> measurementsOf(const NodeProps& page) {
  std::vector<Measurement> out;
  auto it = page.extra.find("measurements");
  if (it == page.extra.end() || it->second.empty()) return out;
  json::Value list = parsedExtra(page, "measurements");
  if (!list.isArray()) return out;
  for (const json::Value& m : list.array) {
    Measurement x;
    x.id = guidOf(member(m, "id"));
    x.from = guidOf(member(m, "fromNode"));
    x.to = guidOf(member(m, "toNode"));
    sideFromName(str(member(m, "fromNodeSide")), x.side);
    if (const json::Value* b = member(m, "toSameSide"); b && b->isBool()) x.toSameSide = b->boolean;
    if (const json::Value* n = member(m, "innerOffsetRelative")) x.inner = n->numberOr(0);
    if (const json::Value* n = member(m, "outerOffsetFixed")) x.outer = n->numberOr(0);
    x.freeText = str(member(m, "freeText"));
    out.push_back(std::move(x));
  }
  return out;
}

std::string encodeMeasurements(const std::vector<Measurement>& list) {
  if (list.empty()) return std::string();
  json::Value arr;
  arr.kind = json::Value::Kind::Array;
  auto num = [](double d) {
    json::Value v;
    v.kind = json::Value::Kind::Number;
    v.number = d;
    return v;
  };
  auto text = [](const std::string& s) {
    json::Value v;
    v.kind = json::Value::Kind::String;
    v.string = s;
    return v;
  };
  for (const Measurement& m : list) {
    json::Value o;
    o.kind = json::Value::Kind::Object;
    o.object.emplace_back("id", guidValue(m.id));
    o.object.emplace_back("fromNode", guidValue(m.from));
    o.object.emplace_back("toNode", guidValue(m.to));
    o.object.emplace_back("fromNodeSide", text(sideName(m.side)));
    json::Value same;
    same.kind = json::Value::Kind::Bool;
    same.boolean = m.toSameSide;
    o.object.emplace_back("toSameSide", same);
    if (m.inner != 0) o.object.emplace_back("innerOffsetRelative", num(m.inner));
    if (m.outer != 0) o.object.emplace_back("outerOffsetFixed", num(m.outer));
    if (!m.freeText.empty()) o.object.emplace_back("freeText", text(m.freeText));
    arr.array.push_back(std::move(o));
  }
  return codec::extraFromJson("NodeChange", "measurements", arr);
}

std::vector<Category> categoriesOf(const NodeProps* document) {
  std::vector<Category> out;
  json::Value v;
  if (document) v = parsedExtra(*document, "annotationCategories");
  const json::Value* items = member(v, "items");
  if (items && items->isArray()) {
    for (const json::Value& it : items->array) {
      Category c;
      c.id = guidOf(member(it, "id"));
      c.preset = str(member(it, "preset"));
      if (c.preset == "NONE") c.preset.clear();
      const json::Value* custom = member(it, "custom");
      std::string label = str(member(custom ? *custom : json::Value{}, "label"));
      std::string color = str(member(custom ? *custom : json::Value{}, "color"));
      c.label = !label.empty() ? label : presetLabel(c.preset);
      c.colorName = custom && member(*custom, "color") ? color : presetColorName(c.preset);
      c.color = categoryColor(c.colorName);
      out.push_back(std::move(c));
    }
    return out;
  }
  // Figma's four presets (the order its files keep them in).
  for (const char* preset : {"DEVELOPMENT", "INTERACTION", "ACCESSIBILITY", "CONTENT"}) {
    Category c;
    c.preset = preset;
    c.label = presetLabel(preset);
    c.colorName = presetColorName(preset);
    c.color = categoryColor(c.colorName);
    out.push_back(std::move(c));
  }
  return out;
}

const Category* findCategory(const std::vector<Category>& list, Guid id) {
  if (id == kNoGuid) return nullptr;
  for (const Category& c : list)
    if (c.id == id) return &c;
  return nullptr;
}

std::vector<Line> markdownLines(const std::string& markdown) {
  std::vector<Line> out;
  size_t start = 0;
  bool code = false;
  while (start <= markdown.size()) {
    size_t end = markdown.find('\n', start);
    if (end == std::string::npos) end = markdown.size();
    std::string raw = markdown.substr(start, end - start);
    start = end + 1;
    std::string t = trimmed(raw);
    if (t.rfind("```", 0) == 0) {
      code = !code;
      continue;
    }
    if (t.empty()) {
      if (end >= markdown.size()) break;
      continue;
    }
    Line l;
    if (code) {
      l.text = t;
    } else if (t.rfind("#", 0) == 0) {
      size_t k = t.find_first_not_of('#');
      l.heading = true;
      l.text = inlinePlain(trimmed(t.substr(k == std::string::npos ? t.size() : k)));
    } else if ((t[0] == '-' || t[0] == '*' || t[0] == '+') && t.size() > 1 && t[1] == ' ') {
      l.bullet = true;
      l.text = inlinePlain(trimmed(t.substr(2)));
    } else {
      size_t digits = 0;
      while (digits < t.size() && std::isdigit(static_cast<unsigned char>(t[digits]))) digits++;
      if (digits > 0 && digits + 1 < t.size() && (t[digits] == '.' || t[digits] == ')') && t[digits + 1] == ' ') {
        l.number = std::atoi(t.substr(0, digits).c_str());
        l.text = inlinePlain(trimmed(t.substr(digits + 2)));
      } else {
        l.text = inlinePlain(t);
      }
    }
    out.push_back(std::move(l));
    if (end >= markdown.size()) break;
  }
  return out;
}

std::string markdownPlain(const std::string& markdown) {
  std::string out;
  for (const Line& l : markdownLines(markdown)) {
    if (!out.empty()) out += '\n';
    if (l.bullet) out += "• ";
    if (l.number) out += std::to_string(l.number) + ". ";
    out += l.text;
  }
  return out;
}

std::string propertyLabel(const std::string& t) {
  static const std::pair<const char*, const char*> kLabels[] = {
      {"FILL", "Fill"}, {"STROKE", "Stroke"}, {"WIDTH", "Width"}, {"HEIGHT", "Height"}, {"MIN_WIDTH", "Min width"},
      {"MIN_HEIGHT", "Min height"}, {"MAX_WIDTH", "Max width"}, {"MAX_HEIGHT", "Max height"}, {"STROKE_WIDTH", "Stroke weight"},
      {"CORNER_RADIUS", "Corner radius"}, {"EFFECT", "Effects"}, {"TEXT_STYLE", "Text style"}, {"TEXT_ALIGN_HORIZONTAL", "Text align"},
      {"FONT_FAMILY", "Font family"}, {"FONT_SIZE", "Font size"}, {"FONT_WEIGHT", "Font weight"}, {"LINE_HEIGHT", "Line height"},
      {"LETTER_SPACING", "Letter spacing"}, {"STACK_SPACING", "Gap"}, {"STACK_PADDING", "Padding"}, {"STACK_MODE", "Layout"},
      {"STACK_ALIGNMENT", "Alignment"}, {"OPACITY", "Opacity"}, {"COMPONENT", "Main component"}, {"FONT_STYLE", "Font style"},
      {"GRID_ROW_GAP", "Row gap"}, {"GRID_COLUMN_GAP", "Column gap"}, {"GRID_ROW_COUNT", "Rows"}, {"GRID_COLUMN_COUNT", "Columns"},
      {"GRID_ROW_ANCHOR_INDEX", "Row"}, {"GRID_COLUMN_ANCHOR_INDEX", "Column"}, {"GRID_ROW_SPAN", "Row span"},
      {"GRID_COLUMN_SPAN", "Column span"}};
  for (auto& [k, v] : kLabels)
    if (t == k) return v;
  return t;
}

namespace {

int weightOf(const std::string& style) {
  static const std::pair<const char*, int> kWeights[] = {{"Thin", 100}, {"Hairline", 100}, {"ExtraLight", 200}, {"Extra Light", 200},
                                                         {"UltraLight", 200}, {"Light", 300}, {"Medium", 500}, {"SemiBold", 600},
                                                         {"Semi Bold", 600}, {"DemiBold", 600}, {"ExtraBold", 800}, {"Extra Bold", 800},
                                                         {"UltraBold", 800}, {"Black", 900}, {"Heavy", 900}, {"Bold", 700}};
  for (auto& [k, w] : kWeights)
    if (style.find(k) != std::string::npos) return w;
  return 400;
}

std::string numberWithUnits(const Number& n, double fontSize, bool lineHeight) {
  if (n.units == NumberUnits::PIXELS) return number(n.value);
  if (n.units == NumberUnits::PERCENT) {
    if (lineHeight && n.value == 100) return "Auto";
    return number(n.value) + "%";
  }
  return lineHeight ? number(n.value * 100) + "%" : number(n.value * fontSize);
}

}  // namespace

std::string propertyValue(const Document& doc, Guid id, const std::string& t) {
  const Node* n = doc.get(id);
  if (!n) return "—";
  const NodeProps& p = n->props;
  auto orDash = [](const std::string& s) { return s.empty() ? std::string("—") : s; };
  if (t == "WIDTH") return number(p.size.x);
  if (t == "HEIGHT") return number(p.size.y);
  if (t == "MIN_WIDTH") return p.rare().minSize.x > 0 ? number(p.rare().minSize.x) : "—";
  if (t == "MIN_HEIGHT") return p.rare().minSize.y > 0 ? number(p.rare().minSize.y) : "—";
  if (t == "MAX_WIDTH") return p.rare().maxSize.x > 0 ? number(p.rare().maxSize.x) : "—";
  if (t == "MAX_HEIGHT") return p.rare().maxSize.y > 0 ? number(p.rare().maxSize.y) : "—";
  if (t == "FILL") return orDash(paintValue(p.fillPaints));
  if (t == "STROKE") return orDash(paintValue(p.strokePaints));
  if (t == "STROKE_WIDTH") return p.strokePaints.empty() ? "—" : number(p.strokeWeight);
  if (t == "CORNER_RADIUS") {
    const CornerRadii& r = p.cornerRadii;
    if (r[0] == r[1] && r[1] == r[2] && r[2] == r[3]) return number(r[0]);
    return number(r[0]) + " " + number(r[1]) + " " + number(r[2]) + " " + number(r[3]);
  }
  if (t == "OPACITY") return number(p.opacity * 100) + "%";
  if (t == "EFFECT") {
    std::string s;
    for (const Effect& e : p.effects) {
      if (!e.visible) continue;
      if (!s.empty()) s += ", ";
      s += e.type == EffectType::DROP_SHADOW    ? "Drop shadow"
           : e.type == EffectType::INNER_SHADOW ? "Inner shadow"
           : e.type == EffectType::FOREGROUND_BLUR ? "Layer blur"
           : e.type == EffectType::BACKGROUND_BLUR ? "Background blur"
                                                   : "Effect";
    }
    return orDash(s);
  }
  if (p.type == NodeType::TEXT) {
    const TextFacet& tx = p.text();
    if (t == "FONT_FAMILY") return tx.fontName.family;
    if (t == "FONT_STYLE") return tx.fontName.style;
    if (t == "FONT_SIZE") return number(tx.fontSize);
    if (t == "FONT_WEIGHT") return std::to_string(weightOf(tx.fontName.style));
    if (t == "LINE_HEIGHT") return numberWithUnits(tx.lineHeight, tx.fontSize, true);
    if (t == "LETTER_SPACING") return numberWithUnits(tx.letterSpacing, tx.fontSize, false);
    if (t == "TEXT_ALIGN_HORIZONTAL")
      return tx.textAlignHorizontal == TextAlignHorizontal::CENTER  ? "Center"
             : tx.textAlignHorizontal == TextAlignHorizontal::RIGHT ? "Right"
             : tx.textAlignHorizontal == TextAlignHorizontal::JUSTIFIED ? "Justified"
                                                                        : "Left";
  }
  if (p.isAutoLayout() || p.stack().stackMode != StackMode::NONE) {
    const StackFacet& s = p.stack();
    if (t == "STACK_SPACING") return number(s.stackSpacing);
    if (t == "STACK_PADDING") {
      double l = s.stackPaddingLeft, tp = s.stackPaddingTop, r = s.stackPaddingRight, b = s.stackPaddingBottom;
      if (l == tp && tp == r && r == b) return number(l);
      if (l == r && tp == b) return number(tp) + " " + number(l);
      return number(tp) + " " + number(r) + " " + number(b) + " " + number(l);
    }
    if (t == "STACK_MODE")
      return s.stackMode == StackMode::HORIZONTAL ? (s.stackWrap == StackWrap::WRAP ? "Wrap" : "Horizontal")
             : s.stackMode == StackMode::VERTICAL ? "Vertical"
             : s.stackMode == StackMode::GRID     ? "Grid"
                                                  : "None";
    if (t == "STACK_ALIGNMENT") {
      static const char* kJustify[] = {"Start", "Center", "End", "Space between", "Space between", "Space around", "Space evenly"};
      static const char* kAlign[] = {"Start", "Center", "End", "Baseline"};
      return std::string(kJustify[static_cast<int>(s.stackPrimaryAlignItems) % 7]) + ", " + kAlign[static_cast<int>(s.stackCounterAlignItems) % 4];
    }
  }
  if (t == "COMPONENT" && p.type == NodeType::INSTANCE) {
    const Node* main = doc.get(p.comp().symbolData.symbolID);
    return main ? main->props.name : "—";
  }
  return "—";
}

}  // namespace eng::annot
