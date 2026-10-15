// Figma Draw's commands (docs/draw.md §4.2–4.5, §4.7; Phase 7 round 7b): transform groups' modifiers (ADD / SET /
// REMOVE / MOVE_TRANSFORM_MODIFIER, APPLY_TRANSFORMS), stroke kinds and brushes (SET_STROKE_KIND, SET_STROKE_BRUSH,
// SET_BRUSH_SETTINGS, CREATE_BRUSH), text on a path (CREATE_TEXT_PATH, FLIP_TEXT_PATH, SET_TEXT_PATH_START); brushes
// installed and listed (INSTALL_BRUSH, the Brush styles menu), and carried by the clipboard. Each command is one undo
// step with §4.7's name; inside an open step (a panel scrub) it joins it.
//
// Everything written is a source field (NodeChange.transformModifiers 455, textPathStart 432, strokeBrushGuid 446,
// dynamic / scatter / stretch settings 448–450, strokeSeed 482, brushType 452) kept in NodeProps::extra; what they
// make — repeats, glyph placement, stroke outlines — is derived (7a: geometry/Repeat, text/TextPathLayout,
// geometry/DynamicStroke, geometry/Brush).

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <functional>
#include <set>

#include "base/FractionalIndex.h"
#include "editor/Editor.h"
#include "geometry/Brush.h"
#include "geometry/Repeat.h"
#include "scene/CodecKiwi.h"
#include "text/TextPathLayout.h"

namespace eng {

namespace {

// ---- JSON ⇄ NodeProps::extra ------------------------------------------------------------------------------------------

bool extraJson(const NodeProps& p, const char* key, json::Value& out) {
  auto it = p.extra.find(key);
  if (it == p.extra.end() || it->second.empty()) return false;
  return json::parse(codec::extraValueToJson("NodeChange", it->second), out) && !out.isNull();
}

std::string encodeExtra(const char* key, const json::Value& v) { return codec::extraFromJson("NodeChange", key, v); }

std::string encodeExtra(const char* key, const std::string& jsonText) {
  json::Value v;
  if (!json::parse(jsonText, v)) return {};
  return encodeExtra(key, v);
}

std::string num(double v) {
  json::Writer w;
  w.number(std::isfinite(v) ? v : 0);
  return w.take();
}

std::string guidJson(Guid g) {
  return "{\"sessionID\":" + std::to_string(g.sessionID) + ",\"localID\":" + std::to_string(g.localID) + "}";
}

const json::Value* member(const json::Value& o, const char* k) { return o.isObject() ? o.get(k) : nullptr; }

double numberOf(const json::Value* v, double fallback) { return v && v->isNumber() ? v->number : fallback; }

bool guidOf(const json::Value* v, Guid& out) {
  if (!v || !v->isString()) return false;
  bool ok = false;
  out = Guid::parse(v->string, &ok);
  return ok;
}

void setMember(json::Value& o, const std::string& key, json::Value v) {
  if (!o.isObject()) {
    o = json::Value{};
    o.kind = json::Value::Kind::Object;
  }
  for (auto& [k, x] : o.object)
    if (k == key) {
      x = std::move(v);
      return;
    }
  o.object.emplace_back(key, std::move(v));
}

json::Value number(double v) {
  json::Value x;
  x.kind = json::Value::Kind::Number;
  x.number = v;
  return x;
}
json::Value string(const std::string& s) {
  json::Value x;
  x.kind = json::Value::Kind::String;
  x.string = s;
  return x;
}
json::Value boolean(bool b) {
  json::Value x;
  x.kind = json::Value::Kind::Bool;
  x.boolean = b;
  return x;
}

// ---- Brush settings -------------------------------------------------------------------------------------------------------

// Figma's scatter settings: the base every application starts from (figma_app.min.js module 258160 `F2`: gap 0.9, the
// rest 0; docs/research/rea/vector.md §5) and the ranges the engine keeps them in (the plugin's; gap's and wiggle's
// upper bounds ours).
struct ScatterRange {
  const char* key;
  double base, lo, hi;
};
constexpr ScatterRange kScatterFields[] = {
    {"gap", 0.9, 0.25, 20}, {"wiggle", 0, 0, 20}, {"angularJitter", 0, -180, 180}, {"rotation", 0, -180, 180}, {"sizeJitter", 0, 0, 3}};

json::Value scatterBase() {
  json::Value s;
  s.kind = json::Value::Kind::Object;
  for (const ScatterRange& r : kScatterFields) setMember(s, r.key, number(r.base));
  return s;
}

// `over`'s known numeric fields written onto `s`, clamped.
void scatterOver(json::Value& s, const json::Value* over) {
  if (!over || !over->isObject()) return;
  for (const ScatterRange& r : kScatterFields)
    if (const json::Value* v = member(*over, r.key); v && v->isNumber() && std::isfinite(v->number))
      setMember(s, r.key, number(std::clamp(v->number, r.lo, r.hi)));
}

// ---- Transform modifiers ----------------------------------------------------------------------------------------------

// The chrome's RepeatModifierInput (src/shared/draw/types.ts) — `partial`: only what it carries — onto a document
// TransformModifier (JSON, the schema's names).
void applyRepeatInput(json::Value& m, const json::Value& in, bool whole) {
  if (whole) {
    setMember(m, "type", string("REPEAT"));
    setMember(m, "visible", boolean(true));
    setMember(m, "count", number(geom::kRepeatCountMin));
    setMember(m, "repeatType", string("LINEAR"));
    setMember(m, "axis", string("X"));
    setMember(m, "unitType", string("PIXELS"));
    setMember(m, "order", string("FORWARD"));
  }
  if (const json::Value* v = member(in, "repeatType"); v && v->isString() && (v->string == "LINEAR" || v->string == "RADIAL"))
    setMember(m, "repeatType", *v);
  if (const json::Value* v = member(in, "count"); v && v->isNumber())
    setMember(m, "count", number(std::clamp(std::round(v->number), static_cast<double>(geom::kRepeatCountMin), static_cast<double>(geom::kRepeatCountMax))));
  if (const json::Value* v = member(in, "unitType"); v && v->isString() && (v->string == "PIXELS" || v->string == "RELATIVE"))
    setMember(m, "unitType", *v);
  if (const json::Value* v = member(in, "axis"); v && v->isString() && (v->string == "X" || v->string == "Y" || v->string == "X_AND_Y"))
    setMember(m, "axis", *v);
  if (const json::Value* v = member(in, "order"); v && v->isString() && (v->string == "FORWARD" || v->string == "REVERSE"))
    setMember(m, "order", *v);
  if (const json::Value* v = member(in, "visible"); v && v->isBool()) setMember(m, "visible", *v);
  if (const json::Value* v = member(in, "offset"); v && v->isNumber()) {
    // LINEAR: the gap along the axis (both axes for X_AND_Y); RADIAL: the gap from the content to the centre (x).
    json::Value o;
    o.kind = json::Value::Kind::Object;
    setMember(o, "x", number(v->number));
    const json::Value* axis = member(m, "axis");
    bool both = axis && axis->isString() && axis->string == "X_AND_Y";
    const json::Value* old = member(m, "offset");
    double y = both ? v->number : numberOf(old ? member(*old, "y") : nullptr, 0);
    setMember(o, "y", number(y));
    setMember(m, "offset", std::move(o));
  } else if (whole) {
    json::Value o;
    o.kind = json::Value::Kind::Object;
    setMember(o, "x", number(0));
    setMember(o, "y", number(0));
    setMember(m, "offset", std::move(o));
  }
}

json::Value modifiersJson(const NodeProps& p) {
  json::Value v;
  if (!extraJson(p, "transformModifiers", v) || !v.isArray()) {
    v = json::Value{};
    v.kind = json::Value::Kind::Array;
  }
  return v;
}

// ---- A software rasterizer for brush previews (nonzero, 4 × 4 samples a pixel) ---------------------------------------

void rasterize(const geom::Path& path, int w, int h, std::string& rgba) {
  rgba.assign(static_cast<size_t>(w) * h * 4, '\0');
  std::vector<geom::Polyline> polys = geom::flatten(path, 0.1);
  struct Edge {
    Vec2 a, b;
    int dir;
  };
  std::vector<Edge> edges;
  for (const geom::Polyline& pl : polys) {
    size_t n = pl.points.size();
    for (size_t i = 0; i < n; i++) {
      Vec2 a = pl.points[i], b = pl.points[(i + 1) % n];
      if (a.y == b.y) continue;
      edges.push_back(a.y < b.y ? Edge{a, b, 1} : Edge{b, a, -1});
    }
  }
  constexpr int S = 4;
  std::vector<float> cover(static_cast<size_t>(w));
  std::vector<std::pair<double, int>> xs;
  for (int y = 0; y < h; y++) {
    std::fill(cover.begin(), cover.end(), 0.f);
    for (int sy = 0; sy < S; sy++) {
      double yy = y + (sy + 0.5) / S;
      xs.clear();
      for (const Edge& e : edges)
        if (yy >= e.a.y && yy < e.b.y) xs.push_back({e.a.x + (yy - e.a.y) * (e.b.x - e.a.x) / (e.b.y - e.a.y), e.dir});
      std::sort(xs.begin(), xs.end());
      int wind = 0;
      for (size_t i = 0; i + 1 < xs.size(); i++) {
        wind += xs[i].second;
        if (wind == 0) continue;
        // Inside from xs[i] to xs[i+1]: horizontal sub-samples.
        double x0 = xs[i].first, x1 = xs[i + 1].first;
        for (int sx = static_cast<int>(std::floor(x0 * S)); sx < static_cast<int>(std::ceil(x1 * S)); sx++) {
          double cx = (sx + 0.5) / S;
          if (cx < x0 || cx >= x1) continue;
          int px = sx / S;
          if (px >= 0 && px < w) cover[static_cast<size_t>(px)] += 1.f / (S * S);
        }
      }
    }
    for (int x = 0; x < w; x++) {
      float c = std::min(1.f, cover[static_cast<size_t>(x)]);
      size_t at = (static_cast<size_t>(y) * w + x) * 4;
      rgba[at + 3] = static_cast<char>(static_cast<uint8_t>(std::lround(c * 255)));
    }
  }
}

}  // namespace

// ---- SVG path data (BrushArtwork.d: absolute M L H V Q C Z, relative too) ---------------------------------------------

bool parseSvgPath(std::string_view d, geom::Path& out) {
  out.clear();
  size_t i = 0;
  auto skip = [&]() {
    while (i < d.size() && (std::isspace(static_cast<unsigned char>(d[i])) || d[i] == ',')) i++;
  };
  auto readNum = [&](double& v) {
    skip();
    if (i >= d.size()) return false;
    const char* start = d.data() + i;
    std::string buf(start, std::min<size_t>(64, d.size() - i));
    char* end = nullptr;
    v = std::strtod(buf.c_str(), &end);
    if (end == buf.c_str()) return false;
    i += static_cast<size_t>(end - buf.c_str());
    return std::isfinite(v);
  };
  char cmd = 0;
  Vec2 cur, start;
  bool open = false;
  while (true) {
    skip();
    if (i >= d.size()) break;
    char c = d[i];
    if (std::isalpha(static_cast<unsigned char>(c))) {
      cmd = c;
      i++;
    } else if (!cmd) {
      return false;
    }
    bool rel = std::islower(static_cast<unsigned char>(cmd)) != 0;
    Vec2 base = rel ? cur : Vec2{};
    switch (std::toupper(static_cast<unsigned char>(cmd))) {
      case 'M': {
        double x, y;
        if (!readNum(x) || !readNum(y)) return false;
        cur = start = base + Vec2{x, y};
        out.moveTo(cur);
        open = true;
        cmd = rel ? 'l' : 'L';  // pairs after a moveto are linetos
        break;
      }
      case 'L': {
        double x, y;
        if (!readNum(x) || !readNum(y) || !open) return false;
        cur = base + Vec2{x, y};
        out.lineTo(cur);
        break;
      }
      case 'H': {
        double x;
        if (!readNum(x) || !open) return false;
        cur = {(rel ? cur.x : 0) + x, cur.y};
        out.lineTo(cur);
        break;
      }
      case 'V': {
        double y;
        if (!readNum(y) || !open) return false;
        cur = {cur.x, (rel ? cur.y : 0) + y};
        out.lineTo(cur);
        break;
      }
      case 'Q': {
        double x1, y1, x, y;
        if (!readNum(x1) || !readNum(y1) || !readNum(x) || !readNum(y) || !open) return false;
        out.quadTo(base + Vec2{x1, y1}, base + Vec2{x, y});
        cur = base + Vec2{x, y};
        break;
      }
      case 'C': {
        double x1, y1, x2, y2, x, y;
        if (!readNum(x1) || !readNum(y1) || !readNum(x2) || !readNum(y2) || !readNum(x) || !readNum(y) || !open) return false;
        out.cubicTo(base + Vec2{x1, y1}, base + Vec2{x2, y2}, base + Vec2{x, y});
        cur = base + Vec2{x, y};
        break;
      }
      case 'Z':
        if (open) out.close();
        cur = start;
        cmd = 0;
        break;
      default: return false;
    }
  }
  return !out.empty();
}

// ---- Brush previews (the Brush styles menu, docs/draw.md §4.5) ---------------------------------------------------------

bool brushPreview(const geom::Path& artwork, Vec2 box, bool scatter, int w, int h, double weight, std::string& rgba,
                  const geom::ScatterSettings* settings) {
  if (w <= 0 || h <= 0 || w > 4096 || h > 4096 || artwork.empty() || !(box.x > 0) || !(box.y > 0)) return false;
  weight = std::clamp(weight, 0.5, static_cast<double>(h));
  // A fixed S-curve across the box, kept a stroke's reach inside it.
  double m = std::max(1.0, weight * (scatter ? 1.0 : 0.6));
  double cy = h / 2.0, a = std::max(0.0, cy - m) * 0.55;
  geom::Path center;
  center.moveTo({m, cy + a * 0.6});
  center.cubicTo({w * 0.35, cy - a * 2.2}, {w * 0.65, cy + a * 2.2}, {w - m, cy - a * 0.6});
  geom::Path outline = scatter ? geom::scatterBrush(center, artwork, box, weight, settings ? *settings : geom::ScatterSettings{}, 1, 0.1)
                               : geom::stretchBrush(center, artwork, box, weight, false, 0.1);
  rasterize(outline, w, h, rgba);
  return true;
}

// ---- Brushes ------------------------------------------------------------------------------------------------------------

bool Editor::brushArtwork(Guid id, geom::Path& out, Vec2& box, bool& scatter, geom::ScatterSettings* settings) const {
  const Node* n = doc_.get(id);
  if (!n || n->props.type != NodeType::BRUSH) return false;
  const NodeGeometry* g = doc_.geometry(id);
  if (!g || g->fills.empty()) return false;
  out.clear();
  for (const auto& f : g->fills) out.append(f.path);
  box = n->props.size;
  json::Value t;
  scatter = extraJson(n->props, "brushType", t) && t.isString() && t.string == "SCATTER";
  json::Value own;
  if (settings && extraJson(n->props, "scatterStrokeSettings", own)) scatterSettingsOver(*settings, own);
  return !out.empty();
}

std::vector<Editor::BrushInfo> Editor::listBrushes() const {
  std::vector<BrushInfo> out;
  doc_.forEach([&](const Node& n) {
    if (n.props.type != NodeType::BRUSH || n.guid.isDerived()) return;
    json::Value t;
    bool scatter = extraJson(n.props, "brushType", t) && t.isString() && t.string == "SCATTER";
    out.push_back({n.guid, n.props.name, scatter});
  });
  std::sort(out.begin(), out.end(), [](const BrushInfo& a, const BrushInfo& b) { return a.guid < b.guid; });
  return out;
}

namespace {

NodeProps brushProps(const std::string& name, bool scatter, Vec2 size, const geom::Path& artwork, WindingRule rule,
                     const json::Value* settings) {
  NodeProps p = defaultProps(NodeType::BRUSH);
  p.type = NodeType::BRUSH;
  p.name = name;
  p.size = size;
  p.fillPaints = {Paint::solid(Color{0, 0, 0, 1})};
  p.strokePaints.clear();
  geom::VectorNetwork net = geom::networkFromPath(artwork, rule);
  VectorData d;
  d.present = true;
  d.normalizedSize = size;
  d.network = std::make_shared<std::vector<uint8_t>>(net.encode());
  p.shape().vectorData = d;
  p.extra["brushType"] = encodeExtra("brushType", std::string(scatter ? "\"SCATTER\"" : "\"STRETCH\""));
  if (scatter) {
    // The node's own settings (449): what applying the brush starts from, over Figma's base.
    json::Value s = scatterBase();
    scatterOver(s, settings);
    p.extra["scatterStrokeSettings"] = encodeExtra("scatterStrokeSettings", s);
  }
  return p;
}

}  // namespace

Guid Editor::installBrush(const std::string& name, bool scatter, Vec2 size, const geom::Path& artwork, WindingRule rule,
                          const json::Value* settings) {
  if (name.empty() || artwork.empty() || !(size.x > 0) || !(size.y > 0)) return kNoGuid;
  for (const BrushInfo& b : listBrushes()) {
    if (b.name != name || b.scatter != scatter) continue;
    // A built-in installed before its settings were known (round 7e) gets them now, as installing would write them.
    json::Value own;
    if (scatter && settings && settings->isObject() && !extraJson(doc_.get(b.guid)->props, "scatterStrokeSettings", own) && !(busy() && !txn_.open)) {
      json::Value s = scatterBase();
      scatterOver(s, settings);
      NodeChange c = NodeChange::changed(b.guid);
      c.mask = F_EXTRA;
      c.props.extra["scatterStrokeSettings"] = encodeExtra("scatterStrokeSettings", s);
      const bool alone = !txn_.open;
      if (alone) begin(TxnKind::SYSTEM, "Install brush");
      write(c);
      if (alone) commit();
    }
    return b.guid;
  }
  if (busy() && !txn_.open) return kNoGuid;
  // Inside an open step (a stroke, Stroke settings' Brush): part of it, so undoing it removes the brush too; otherwise a
  // system write — choosing a brush isn't an edit (docs/draw.md §4.5).
  bool own = !txn_.open;
  if (own) begin(TxnKind::SYSTEM, "Install brush");
  Guid canvas = internalCanvas(true);
  Guid id = kNoGuid;
  if (canvas != kNoGuid) {
    NodeProps p = brushProps(name, scatter, size, artwork, rule, settings);
    p.parentIndex = {canvas, doc_.positionAtEnd(canvas)};
    id = newGuid();
    write(NodeChange::created(id, p));
  }
  if (own) commit();
  return id;
}

// The clipboard carries the BRUSH nodes its layers' strokes use (docs/draw.md §4.5), outside its regions.
void Editor::brushClipboard(std::vector<NodeChange>& nodes, const std::vector<const NodeProps*>& copied) const {
  std::vector<Guid> brushes;
  std::set<Guid> have;
  for (const NodeChange& c : nodes) have.insert(c.guid);
  for (const NodeProps* p : copied) {
    Guid b = strokeBrushOf(*p);
    const Node* bn = b != kNoGuid ? doc_.get(b) : nullptr;
    if (bn && bn->props.type == NodeType::BRUSH && have.insert(b).second) brushes.push_back(b);
  }
  for (Guid b : brushes) nodes.push_back(NodeChange::created(b, doc_.get(b)->props));
}

// A paste's BRUSH nodes: one of this file with the same name, type and artwork is used; else a copy goes on the Internal
// Only Canvas. `remap`: the clipboard's GUID → this file's.
void Editor::brushPaste(const std::vector<NodeChange>& clip, std::unordered_map<Guid, Guid, GuidHash>& remap) {
  auto artworkKey = [](const NodeProps& p) {
    const VectorData& d = p.shape().vectorData;
    std::string k = d.network ? std::string(d.network->begin(), d.network->end()) : std::string();
    json::Value t;
    bool scatter = extraJson(p, "brushType", t) && t.isString() && t.string == "SCATTER";
    return p.name + '\x1f' + (scatter ? "S" : "T") + '\x1f' + std::to_string(p.size.x) + "x" + std::to_string(p.size.y) + '\x1f' + k;
  };
  std::unordered_map<std::string, Guid> local;
  for (const BrushInfo& b : listBrushes()) local.emplace(artworkKey(doc_.get(b.guid)->props), b.guid);
  for (const NodeChange& c : clip) {
    if (c.phase == Phase::REMOVED || c.props.type != NodeType::BRUSH || remap.count(c.guid)) continue;
    std::string key = artworkKey(c.props);
    if (auto it = local.find(key); it != local.end()) {
      remap[c.guid] = it->second;
      continue;
    }
    Guid canvas = internalCanvas(true);
    if (canvas == kNoGuid) continue;
    NodeProps p = c.props;
    p.parentIndex = {canvas, doc_.positionAtEnd(canvas)};
    p.transform = Mat2x3{};
    Guid id = newGuid();
    write(NodeChange::created(id, p));
    local.emplace(key, id);
    remap[c.guid] = id;
  }
}

void Editor::remapStrokeBrush(NodeProps& p, const std::unordered_map<Guid, Guid, GuidHash>& remap) const {
  Guid b = strokeBrushOf(p);
  auto it = b != kNoGuid ? remap.find(b) : remap.end();
  if (it != remap.end() && it->second != b) p.extra["strokeBrushGuid"] = encodeExtra("strokeBrushGuid", guidJson(it->second));
}

std::string Editor::appliedBrushSettings(Guid brush, bool scatter, const json::Value* user) const {
  const Node* bn = doc_.get(brush);
  json::Value own;
  bool has = bn && extraJson(bn->props, scatter ? "scatterStrokeSettings" : "stretchStrokeSettings", own) && own.isObject();
  if (scatter) {
    json::Value s = scatterBase();
    if (has) scatterOver(s, &own);
    scatterOver(s, user);
    return encodeExtra("scatterStrokeSettings", s);
  }
  // Stretch: {orientation FORWARD}, the node's, then the user's Direction.
  std::string o = "FORWARD";
  if (has)
    if (const json::Value* v = member(own, "orientation"); v && v->isString() && v->string == "REVERSE") o = "REVERSE";
  if (const json::Value* d = user ? member(*user, "direction") : nullptr; d && d->isString()) o = d->string == "BACKWARD" ? "REVERSE" : "FORWARD";
  return encodeExtra("stretchStrokeSettings", "{\"orientation\":\"" + o + "\"}");
}

// ---- Helpers ------------------------------------------------------------------------------------------------------------

std::vector<Guid> Editor::drawTargets(const CommandArgs& args) const {
  std::vector<Guid> out;
  if (const json::Value* refs = member(args.raw, "refs"); refs && refs->isArray()) {
    for (const json::Value& r : refs->array) {
      Guid g;
      if (guidOf(&r, g) && doc_.has(g)) out.push_back(g);
    }
    return out;
  }
  if (const json::Value* ref = member(args.raw, "ref")) {
    Guid g;
    if (guidOf(ref, g) && doc_.has(g)) out.push_back(g);
    return out;
  }
  for (Guid g : selection_)
    if (doc_.has(g)) out.push_back(g);
  return out;
}

uint64_t Editor::newStrokeSeed() {
  // splitmix64; kept within 2^53 so the chrome reads it exactly.
  uint64_t z = (seedState_ += 0x9E3779B97F4A7C15ull);
  z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
  z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
  z ^= z >> 31;
  return (z & ((1ull << 53) - 1)) | 1;
}

namespace {

bool vectorLike(const NodeProps& p) {
  return p.type == NodeType::VECTOR || p.type == NodeType::LINE || p.isRectLike() || p.type == NodeType::ELLIPSE ||
         p.type == NodeType::STAR || p.type == NodeType::REGULAR_POLYGON || p.type == NodeType::BOOLEAN_OPERATION;
}

// Whether every fill contour of a layer is closed (Create brush: "Only closed vector paths can be sources").
bool closedFills(const NodeGeometry* geo) {
  if (!geo || geo->fills.empty()) return false;
  bool closed = true;
  for (const auto& f : geo->fills) geom::forEachSegment(f.path, [](Vec2) {}, [](geom::Verb, Vec2, const Vec2*) {}, [&](bool c) { closed = closed && c; });
  return closed;
}

// Writes `extra` keys onto `c` (an empty value clears the key).
void putExtra(NodeChange& c, const char* key, std::string value) {
  c.mask |= F_EXTRA;
  c.props.extra[key] = std::move(value);
}

}  // namespace

// ---- Text on a path -----------------------------------------------------------------------------------------------------

Status Editor::createTextPath(Guid src, double tValue, bool replace, Guid* made) {
  const Node* sn = doc_.get(src);
  if (!sn || src.isDerived() || sn->props.locked || sn->props.isTextLike()) return E_INVALID;
  geom::VectorNetwork net;
  bool convert = false;
  if (!networkOf(src, net, convert) || net.segments.empty()) return E_INVALID;
  const NodeProps& sp = sn->props;
  Vec2 size = sp.size;
  // The network at the shape's size (its node space): stored as it is, normalizedSize = size.
  NodeProps p = toolProps(NodeType::TEXT);
  p.type = NodeType::TEXT_PATH;
  p.name = replace ? sp.name : "Text";
  p.text().autoRename = !replace;
  p.text().textAutoResize = TextAutoResize::NONE;
  p.text().textAlignVertical = TextAlignVertical::BOTTOM;
  p.text().textData = TextData{};
  p.size = size;
  p.transform = sp.transform;
  VectorData d;
  d.present = true;
  d.normalizedSize = size;
  d.network = std::make_shared<std::vector<uint8_t>>(net.encode());
  p.shape().vectorData = d;
  tValue = std::clamp(tValue, 0.0, static_cast<double>(net.segments.size()));
  p.extra["textPathStart"] = encodeExtra("textPathStart", "{\"tValue\":" + num(tValue) + ",\"forward\":true}");
  Guid parent = sp.parentIndex.guid;
  begin(TxnKind::USER, "Text on path");
  if (replace) {
    p.parentIndex = sp.parentIndex;
  } else {
    const auto& siblings = doc_.children(parent);
    size_t index = static_cast<size_t>(std::find(siblings.begin(), siblings.end(), src) - siblings.begin()) + 1;
    p.parentIndex = {parent, placeAt(parent, index, kNoGuid)};
  }
  Guid id = newGuid();
  if (replace) {
    // The plugin's createTextPath: the source goes and the text path takes its place (docs/draw.md §3.4).
    std::vector<Guid> order;
    auto collect = [&](auto&& self, Guid g) -> void {
      for (Guid c : std::vector<Guid>(doc_.children(g))) self(self, c);
      order.push_back(g);
    };
    collect(collect, src);
    for (Guid g : order) write(NodeChange::removed(g));
  }
  write(NodeChange::created(id, p));
  changeSelection({id});
  commit();
  created_.push_back(id);
  if (made) *made = id;
  return OK;
}

// ---- Dispatch ---------------------------------------------------------------------------------------------------------

Status Editor::drawCommand(CommandId id, const CommandArgs& args) {
  const json::Value& raw = args.raw;
  std::vector<Guid> targets = drawTargets(args);
  auto liveTargets = [&](auto&& pred) {
    std::vector<Guid> out;
    for (Guid g : targets) {
      const Node* n = doc_.get(g);
      if (n && !n->props.locked && !isLibraryCopy(g) && pred(n->props)) out.push_back(g);
    }
    return out;
  };
  auto isTransform = [](const NodeProps& p) { return p.type == NodeType::TRANSFORM; };
  auto oneTransform = [&](Guid& out) {
    Guid g;
    if (!guidOf(member(raw, "ref"), g)) return false;
    const Node* n = doc_.get(g);
    if (!n || n->props.type != NodeType::TRANSFORM || n->props.locked) return false;
    out = g;
    return true;
  };
  auto writeModifiers = [&](Guid g, const json::Value& list) {
    NodeChange c = NodeChange::changed(g);
    putExtra(c, "transformModifiers", list.array.empty() ? std::string() : encodeExtra("transformModifiers", list));
    write(c);
  };

  switch (id) {
    case CommandId::ADD_TRANSFORM_MODIFIER: {
      const json::Value* in = member(raw, "modifier");
      if (!in || !in->isObject()) return E_INVALID;
      json::Value m;
      applyRepeatInput(m, *in, true);
      std::vector<Guid> live = liveTargets([](const NodeProps& p) { return p.type != NodeType::CANVAS && p.type != NodeType::DOCUMENT; });
      for (Guid g : live)
        if (g.isDerived()) return E_INVALID;
      if (live.empty()) return E_INVALID;
      if (live.size() == 1 && doc_.get(live[0])->props.type == NodeType::TRANSFORM) {
        json::Value list = modifiersJson(doc_.get(live[0])->props);
        list.array.push_back(m);
        begin(TxnKind::USER, "Add repeat");
        writeModifiers(live[0], list);
        commit();
        return OK;
      }
      // Wrapped in a new transform group, as Group ⌘G wraps: at the topmost layer's place, in its parent.
      std::vector<Guid> top = topLevelSelection(doc_, live);
      std::stable_sort(top.begin(), top.end(), [&](Guid a, Guid b) { return doc_.paintsBefore(a, b); });
      Guid topmost = top.back();
      Guid parent = doc_.parentOf(topmost);
      std::unordered_set<Guid, GuidHash> moving(top.begin(), top.end());
      size_t index = 0;
      for (Guid c : doc_.children(parent)) {
        if (c == topmost) break;
        if (!moving.count(c)) index++;
      }
      Mat2x3 toParent = doc_.worldTransform(parent).inverse();
      Rect u;
      bool any = false;
      for (Guid g : top) {
        const Node* n = doc_.get(g);
        Rect b = transformedBounds(toParent * doc_.worldTransform(g), n->props.size.x, n->props.size.y);
        u = any ? u.united(b) : b;
        any = true;
      }
      begin(TxnKind::USER, "Add repeat");
      NodeProps p = defaultProps(NodeType::FRAME);
      p.type = NodeType::TRANSFORM;
      p.name = nextName("Repeat group");
      p.resizeToFit = true;
      p.fillPaints.clear();
      p.frameMaskDisabled = true;
      p.transform = Mat2x3::translate(u.x, u.y);
      p.size = {u.w, u.h};
      p.parentIndex = {parent, placeManyAt(parent, index, 1, moving)[0]};
      json::Value list;
      list.kind = json::Value::Kind::Array;
      list.array.push_back(m);
      p.extra["transformModifiers"] = encodeExtra("transformModifiers", list);
      Guid group = newGuid();
      write(NodeChange::created(group, p));
      auto keys = fractional::keysBetween("", std::nullopt, static_cast<int>(top.size()));
      for (size_t i = 0; i < top.size(); i++) reparent(top[i], group, keys[i]);
      changeSelection({group});
      commit();
      created_.push_back(group);
      return OK;
    }
    case CommandId::SET_TRANSFORM_MODIFIER:
    case CommandId::REMOVE_TRANSFORM_MODIFIER:
    case CommandId::MOVE_TRANSFORM_MODIFIER: {
      Guid g;
      if (!oneTransform(g)) return E_INVALID;
      json::Value list = modifiersJson(doc_.get(g)->props);
      int n = static_cast<int>(list.array.size());
      if (id == CommandId::MOVE_TRANSFORM_MODIFIER) {
        int from = static_cast<int>(numberOf(member(raw, "from"), -1)), to = static_cast<int>(numberOf(member(raw, "to"), -1));
        if (from < 0 || from >= n || to < 0 || to >= n) return E_INVALID;
        if (from == to) return OK;
        json::Value m = list.array[static_cast<size_t>(from)];
        list.array.erase(list.array.begin() + from);
        list.array.insert(list.array.begin() + to, m);
      } else {
        int index = static_cast<int>(numberOf(member(raw, "index"), -1));
        if (index < 0 || index >= n) return E_INVALID;
        if (id == CommandId::REMOVE_TRANSFORM_MODIFIER) {
          list.array.erase(list.array.begin() + index);
        } else {
          const json::Value* in = member(raw, "modifier");
          if (!in || !in->isObject()) return E_INVALID;
          applyRepeatInput(list.array[static_cast<size_t>(index)], *in, false);
        }
      }
      begin(TxnKind::USER, id == CommandId::REMOVE_TRANSFORM_MODIFIER ? "Remove repeat" : "Change repeat");
      writeModifiers(g, list);
      commit();
      return OK;
    }
    case CommandId::APPLY_TRANSFORMS: {
      std::vector<Guid> groups = liveTargets(isTransform);
      if (groups.empty()) return E_INVALID;
      begin(TxnKind::USER, "Apply transforms");
      std::vector<Guid> result;
      // Inside out: a transform group's own transform groups first.
      std::function<Guid(Guid)> apply = [&](Guid g) -> Guid {
        for (Guid c : std::vector<Guid>(doc_.children(g)))
          if (const Node* cn = doc_.get(c); cn && cn->props.type == NodeType::TRANSFORM) apply(c);
        flushLayout();
        const Node* gn = doc_.get(g);
        if (!gn) return kNoGuid;
        const geom::RepeatResult* rep = repeatOf(doc_, g);
        std::vector<Mat2x3> instances = rep ? rep->instances : std::vector<Mat2x3>{Mat2x3{}};
        NodeProps p = gn->props;
        p.type = NodeType::FRAME;  // a group (Figma's groups are resizing frames)
        p.resizeToFit = true;
        p.frameMaskDisabled = true;
        p.extra.erase("transformModifiers");
        Guid copy = newGuid();
        write(NodeChange::created(copy, p));
        std::vector<Guid> kids = doc_.children(g);
        auto keys = fractional::keysBetween("", std::nullopt, static_cast<int>(kids.size() * instances.size()));
        size_t k = 0;
        bool sourceDone = false;
        for (const Mat2x3& inst : instances) {
          bool source = !sourceDone && inst == Mat2x3{};
          if (source) sourceDone = true;
          for (Guid c : kids) {
            const Node* cn = doc_.get(c);
            if (!cn) continue;
            if (source) reparent(c, copy, keys[k++]);
            else cloneSubtree(c, copy, keys[k++], inst * cn->props.transform);
          }
        }
        write(NodeChange::removed(g));
        return copy;
      };
      for (Guid g : groups)
        if (doc_.has(g)) {
          Guid made = apply(g);
          if (made != kNoGuid) result.push_back(made);
        }
      changeSelection(result);
      commit();
      return OK;
    }
    case CommandId::SET_STROKE_KIND: {
      const json::Value* kind = member(raw, "kind");
      if (!kind || !kind->isString() || (kind->string != "BASIC" && kind->string != "DYNAMIC")) return E_INVALID;
      std::vector<Guid> live = liveTargets([](const NodeProps& p) { return p.type != NodeType::CANVAS && p.type != NodeType::DOCUMENT; });
      if (live.empty()) return E_INVALID;
      bool dynamic = kind->string == "DYNAMIC";
      auto settingsJson = [](const geom::DynamicSettings& s) {
        return "{\"frequency\":" + num(s.frequency) + ",\"wiggle\":" + num(s.wiggle) + ",\"smoothen\":" + num(s.smoothen) + "}";
      };
      begin(TxnKind::USER, "Change stroke");
      for (Guid g : live) {
        const NodeProps& p = doc_.get(g)->props;
        NodeChange c = NodeChange::changed(g);
        // Figma writes -1:-1 (no brush) whenever a stroke becomes Dynamic or Basic (docs/research/rea/vector.md §2).
        putExtra(c, "strokeBrushGuid", encodeExtra("strokeBrushGuid", guidJson(kNoGuid)));
        json::Value old;
        bool present = extraJson(p, "dynamicStrokeSettings", old) && old.isObject();
        if (dynamic) {
          // The layer's own settings unless they are the neutral value Basic left (then Figma's defaults).
          geom::DynamicSettings s;
          if (present) {
            geom::DynamicSettings was{numberOf(member(old, "frequency"), s.frequency), numberOf(member(old, "wiggle"), s.wiggle),
                                      numberOf(member(old, "smoothen"), s.smoothen)};
            if (!geom::isNeutralDynamic(was)) s = was;
          }
          if (const json::Value* in = member(raw, "dynamic")) {
            s.frequency = numberOf(member(*in, "frequency"), s.frequency);
            s.wiggle = numberOf(member(*in, "wiggle"), s.wiggle);
            s.smoothen = numberOf(member(*in, "smoothen"), s.smoothen);
          }
          // The plugin's ranges: frequency 0.01–20, wiggle ≥ 0 (no upper bound; geometry caps it), smoothen 0–1.
          s.frequency = std::clamp(s.frequency, 0.01, 20.0);
          s.wiggle = std::isfinite(s.wiggle) ? std::max(0.0, s.wiggle) : 0.0;
          s.smoothen = std::clamp(s.smoothen, 0.0, 1.0);
          putExtra(c, "dynamicStrokeSettings", encodeExtra("dynamicStrokeSettings", settingsJson(s)));
          // Width points and dashes stay (Figma keeps them; they are not drawn on a dynamic stroke).
          if (strokeSeedOf(p) == 0) putExtra(c, "strokeSeed", encodeExtra("strokeSeed", num(static_cast<double>(newStrokeSeed()))));
        } else if (present) {
          // Basic keeps the field at Figma's neutral value instead of removing it.
          putExtra(c, "dynamicStrokeSettings", encodeExtra("dynamicStrokeSettings", settingsJson(geom::kDynamicNeutral)));
        }
        write(c);
      }
      commit();
      return OK;
    }
    case CommandId::SET_STROKE_BRUSH: {
      Guid brush;
      if (!guidOf(member(raw, "brush"), brush)) return E_INVALID;
      const Node* bn = doc_.get(brush);
      if (!bn || bn->props.type != NodeType::BRUSH) return E_INVALID;
      json::Value bt;
      bool scatter = extraJson(bn->props, "brushType", bt) && bt.isString() && bt.string == "SCATTER";
      std::vector<Guid> live = liveTargets([](const NodeProps& p) { return p.type != NodeType::CANVAS && p.type != NodeType::DOCUMENT && p.type != NodeType::BRUSH; });
      if (live.empty()) return E_INVALID;
      begin(TxnKind::USER, "Change stroke");
      for (Guid g : live) {
        const NodeProps& p = doc_.get(g)->props;
        NodeChange c = NodeChange::changed(g);
        putExtra(c, "strokeBrushGuid", encodeExtra("strokeBrushGuid", guidJson(brush)));
        putExtra(c, "dynamicStrokeSettings", "");
        // Width points and dashes stay (Figma keeps them across kind changes, docs/research/rea/vector.md §4).
        putExtra(c, "scatterBrushTransforms", "");  // Figma's stored stamps were for the old brush
        // {base, ...the brush's own, ...the user's}: the previous brush's settings are replaced (rea/vector.md §5).
        putExtra(c, scatter ? "scatterStrokeSettings" : "stretchStrokeSettings", appliedBrushSettings(brush, scatter, member(raw, scatter ? "scatter" : "stretch")));
        if (strokeSeedOf(p) == 0) putExtra(c, "strokeSeed", encodeExtra("strokeSeed", num(static_cast<double>(newStrokeSeed()))));
        write(c);
      }
      commit();
      return OK;
    }
    case CommandId::SET_BRUSH_SETTINGS: {
      const json::Value* scatter = member(raw, "scatter");
      const json::Value* stretch = member(raw, "stretch");
      if ((!scatter || !scatter->isObject()) && (!stretch || !stretch->isObject())) return E_INVALID;
      std::vector<Guid> live = liveTargets([](const NodeProps& p) { return p.type != NodeType::CANVAS && p.type != NodeType::DOCUMENT; });
      if (live.empty()) return E_INVALID;
      begin(TxnKind::USER, "Change stroke");
      for (Guid g : live) {
        const NodeProps& p = doc_.get(g)->props;
        NodeChange c = NodeChange::changed(g);
        if (scatter && scatter->isObject()) {
          json::Value s;
          if (!extraJson(p, "scatterStrokeSettings", s) || !s.isObject()) {
            // None yet: what the layer draws with — the base under its brush's own settings.
            s = scatterBase();
            json::Value own;
            Guid b = strokeBrushOf(p);
            if (const Node* bn = b != kNoGuid ? doc_.get(b) : nullptr; bn && extraJson(bn->props, "scatterStrokeSettings", own)) scatterOver(s, &own);
          }
          scatterOver(s, scatter);
          putExtra(c, "scatterStrokeSettings", encodeExtra("scatterStrokeSettings", s));
          putExtra(c, "scatterBrushTransforms", "");  // laid out again from the settings
        }
        if (stretch && stretch->isObject()) {
          const json::Value* dir = member(*stretch, "direction");
          if (dir && dir->isString())
            putExtra(c, "stretchStrokeSettings",
                     encodeExtra("stretchStrokeSettings", std::string("{\"orientation\":\"") + (dir->string == "BACKWARD" ? "REVERSE" : "FORWARD") + "\"}"));
        }
        write(c);
      }
      commit();
      return OK;
    }
    case CommandId::CREATE_BRUSH: {
      Guid g;
      if (!guidOf(member(raw, "ref"), g)) {
        if (selection_.size() != 1) return E_INVALID;
        g = selection_[0];
      }
      const json::Value* type = member(raw, "brushType");
      bool scatter = type && type->isString() && type->string == "SCATTER";
      if (type && !(type->isString() && (type->string == "SCATTER" || type->string == "STRETCH"))) return E_INVALID;
      const Node* n = doc_.get(g);
      if (!n || !vectorLike(n->props)) return E_INVALID;
      const NodeGeometry* geo = doc_.geometry(g);
      if (!geo || geo->fills.empty()) return E_INVALID;  // an open path has no fill geometry: "Outline stroke" first
      geom::Path art;
      for (const auto& f : geo->fills) {
        bool closed = true;
        geom::forEachSegment(f.path, [](Vec2) {}, [](geom::Verb, Vec2, const Vec2*) {}, [&](bool c) { closed = closed && c; });
        if (!closed) return E_INVALID;
        art.append(f.path);
      }
      Rect b = art.bounds();
      if (!(b.w > 0) || !(b.h > 0)) return E_INVALID;
      art.transform(Mat2x3::translate(-b.x, -b.y));
      begin(TxnKind::USER, "Create brush");
      Guid canvas = internalCanvas(true);
      NodeProps p = brushProps(n->props.name, scatter, {b.w, b.h}, art, geo->fills[0].windingRule, nullptr);  // the base
      p.parentIndex = {canvas, doc_.positionAtEnd(canvas)};
      Guid made = newGuid();
      write(NodeChange::created(made, p));
      commit();
      created_.push_back(made);
      return OK;
    }
    case CommandId::CREATE_TEXT_PATH: {
      Guid g;
      if (!guidOf(member(raw, "ref"), g)) {
        if (selection_.size() != 1) return E_INVALID;
        g = selection_[0];
      }
      double segment = std::max(0.0, std::floor(numberOf(member(raw, "segment"), 0)));
      double position = std::clamp(numberOf(member(raw, "position"), 0), 0.0, 1.0);
      const json::Value* rep = member(raw, "replace");
      return createTextPath(g, segment + position, rep && rep->isBool() && rep->boolean, nullptr);
    }
    case CommandId::FLIP_TEXT_PATH: {
      std::vector<Guid> live = liveTargets([](const NodeProps& p) { return p.type == NodeType::TEXT_PATH; });
      if (live.empty()) return E_INVALID;
      begin(TxnKind::USER, "Flip text path");
      for (Guid g : live) {
        double t = 0;
        bool forward = true;
        text::textPathStartOf(doc_.get(g)->props, t, forward);
        NodeChange c = NodeChange::changed(g);
        putExtra(c, "textPathStart", encodeExtra("textPathStart", "{\"tValue\":" + num(t) + ",\"forward\":" + (forward ? "false" : "true") + "}"));
        write(c);
      }
      commit();
      return OK;
    }
    case CommandId::SET_TEXT_PATH_START: {
      Guid g;
      if (!guidOf(member(raw, "ref"), g)) return E_INVALID;
      const Node* n = doc_.get(g);
      if (!n || n->props.type != NodeType::TEXT_PATH || n->props.locked) return E_INVALID;
      double segment = std::max(0.0, std::floor(numberOf(member(raw, "segment"), 0)));
      double position = std::clamp(numberOf(member(raw, "position"), 0), 0.0, 1.0);
      double t = 0;
      bool forward = true;
      text::textPathStartOf(n->props, t, forward);
      begin(TxnKind::USER, "Move text start");
      NodeChange c = NodeChange::changed(g);
      putExtra(c, "textPathStart", encodeExtra("textPathStart", "{\"tValue\":" + num(segment + position) + ",\"forward\":" + (forward ? "true" : "false") + "}"));
      write(c);
      commit();
      return OK;
    }
    default: return E_UNSUPPORTED;
  }
}

uint32_t Editor::drawCommandState(CommandId id) const {
  std::vector<const NodeProps*> sel;
  for (Guid g : selection_)
    if (const Node* n = doc_.get(g); n && !n->props.locked) sel.push_back(&n->props);
  auto anyOf = [&](NodeType t) {
    for (const NodeProps* p : sel)
      if (p->type == t) return true;
    return false;
  };
  switch (id) {
    case CommandId::ADD_TRANSFORM_MODIFIER: {
      if (sel.empty()) return 0;
      for (Guid g : selection_)
        if (g.isDerived()) return 0;
      return CMD_ENABLED;
    }
    case CommandId::SET_TRANSFORM_MODIFIER:
    case CommandId::REMOVE_TRANSFORM_MODIFIER:
    case CommandId::MOVE_TRANSFORM_MODIFIER:
    case CommandId::APPLY_TRANSFORMS: return anyOf(NodeType::TRANSFORM) ? CMD_ENABLED : 0;
    case CommandId::SET_STROKE_KIND:
    case CommandId::SET_STROKE_BRUSH:
    case CommandId::SET_BRUSH_SETTINGS: return sel.empty() ? 0 : CMD_ENABLED;
    case CommandId::CREATE_BRUSH: {
      if (sel.size() != 1 || !vectorLike(*sel[0])) return 0;
      return closedFills(doc_.geometry(selection_[0])) ? CMD_ENABLED : 0;
    }
    case CommandId::CREATE_TEXT_PATH: return sel.size() == 1 && vectorLike(*sel[0]) && sel[0]->type != NodeType::BOOLEAN_OPERATION ? CMD_ENABLED : 0;
    case CommandId::FLIP_TEXT_PATH: return anyOf(NodeType::TEXT_PATH) ? CMD_ENABLED : 0;
    case CommandId::SET_TEXT_PATH_START: return sel.size() == 1 && sel[0]->type == NodeType::TEXT_PATH ? CMD_ENABLED : 0;
    default: return 0;
  }
}

}  // namespace eng
