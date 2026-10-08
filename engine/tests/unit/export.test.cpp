// Export (E7): the zlib writer, export bounds and sizes, the SVG writer (well formed, and its shapes cover what the
// document's do: the SVG re-rendered by point sampling), the PDF writer (structure, xref, streams, Type 3 text), and
// the C ABI (engine_export / _info / _list).
#include <zlib.h>

#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "base/Json.h"
#include "doctest.h"
#include "editor/Editor.h"
#include "export/Deflate.h"
#include "export/Export.h"
#include "export/PdfWriter.h"
#include "export/Scene.h"
#include "export/SvgWriter.h"
#include "geometry/Shapes.h"
#include "Helpers.h"
#include "TextHelpers.h"

using namespace eng;
using namespace eng::test;

using Ptr = uintptr_t;
using Handle = uintptr_t;

extern "C" {
Ptr engine_result_ptr();
uint32_t engine_result_len();
Handle engine_create(const char* selector, Ptr optsPtr, uint32_t optsLen);
void engine_destroy(Handle h);
int32_t engine_load(Handle h, Ptr ptr, uint32_t len);
int32_t engine_export(Handle h, Ptr refsPtr, uint32_t refsLen, Ptr settingsPtr, uint32_t settingsLen, uint32_t flags);
int32_t engine_export_info(Handle h, Ptr refsPtr, uint32_t refsLen, Ptr settingsPtr, uint32_t settingsLen);
int32_t engine_export_list(Handle h, uint32_t pageSessionID, uint32_t pageLocalID);
int32_t engine_export_image(Handle h, Ptr hashPtr, uint32_t hashLen, uint32_t kind, uint32_t width, uint32_t height, Ptr dataPtr,
                            uint32_t dataLen, Ptr alphaPtr, uint32_t alphaLen);
void engine_export_clear_images();
}

namespace {

std::string inflate(std::string_view z) {
  std::string out(std::max<size_t>(z.size() * 8, 1024), '\0');
  for (;;) {
    uLongf len = out.size();
    int r = uncompress(reinterpret_cast<Bytef*>(out.data()), &len, reinterpret_cast<const Bytef*>(z.data()), z.size());
    if (r == Z_OK) {
      out.resize(len);
      return out;
    }
    if (r != Z_BUF_ERROR) return "<inflate error " + std::to_string(r) + ">";
    out.resize(out.size() * 2);
  }
}

// ---- A small XML reader: elements, attributes, nesting (enough to check what the SVG writer writes) ----

struct El {
  std::string tag;
  std::map<std::string, std::string> attrs;
  std::vector<El> kids;
  std::string text;
  const std::string* attr(const std::string& k) const {
    auto it = attrs.find(k);
    return it == attrs.end() ? nullptr : &it->second;
  }
};

struct Xml {
  std::string_view s;
  size_t i = 0;
  bool ok = true;
  void ws() {
    while (i < s.size() && isspace(static_cast<unsigned char>(s[i]))) i++;
  }
  bool element(El& out) {
    ws();
    if (i >= s.size() || s[i] != '<') return false;
    i++;
    size_t start = i;
    while (i < s.size() && !isspace(static_cast<unsigned char>(s[i])) && s[i] != '>' && s[i] != '/') i++;
    out.tag = std::string(s.substr(start, i - start));
    for (;;) {
      ws();
      if (i >= s.size()) return ok = false;
      if (s[i] == '/') {
        if (i + 1 >= s.size() || s[i + 1] != '>') return ok = false;
        i += 2;
        return true;
      }
      if (s[i] == '>') {
        i++;
        break;
      }
      size_t k = i;
      while (i < s.size() && s[i] != '=' && !isspace(static_cast<unsigned char>(s[i]))) i++;
      std::string key(s.substr(k, i - k));
      if (i >= s.size() || s[i] != '=' || i + 1 >= s.size() || s[i + 1] != '"') return ok = false;
      i += 2;
      size_t v = s.find('"', i);
      if (v == std::string_view::npos) return ok = false;
      if (out.attrs.count(key)) return ok = false;  // a duplicate attribute isn't XML
      out.attrs[key] = std::string(s.substr(i, v - i));
      i = v + 1;
    }
    for (;;) {
      size_t lt = s.find('<', i);
      if (lt == std::string_view::npos) return ok = false;
      out.text += std::string(s.substr(i, lt - i));
      i = lt;
      if (s.substr(i, 2) == "</") {
        size_t gt = s.find('>', i);
        if (gt == std::string_view::npos) return ok = false;
        std::string close(s.substr(i + 2, gt - i - 2));
        i = gt + 1;
        if (close != out.tag) return ok = false;
        return true;
      }
      El kid;
      if (!element(kid)) return ok = false;
      out.kids.push_back(std::move(kid));
    }
  }
};

bool parseXml(const std::string& text, El& root) {
  root = El{};
  Xml x{text};
  if (!x.element(root) || !x.ok) return false;
  x.ws();
  return x.i == text.size();
}

void collect(const El& e, const std::string& tag, std::vector<const El*>& out) {
  if (e.tag == tag) out.push_back(&e);
  for (auto& k : e.kids) collect(k, tag, out);
}

// ---- SVG geometry back to paths ----

std::vector<double> numbers(const std::string& s) {
  std::vector<double> out;
  const char* p = s.c_str();
  while (*p) {
    char* end = nullptr;
    double v = std::strtod(p, &end);
    if (end == p) {
      p++;
      continue;
    }
    out.push_back(v);
    p = end;
  }
  return out;
}

Mat2x3 transformOf(const El& e) {
  const std::string* t = e.attr("transform");
  if (!t || t->rfind("matrix(", 0) != 0) return {};
  auto v = numbers(t->substr(7));
  if (v.size() != 6) return {};
  return {v[0], v[2], v[4], v[1], v[3], v[5]};
}

geom::Path parsePathData(const std::string& d) {
  geom::Path p;
  size_t i = 0;
  Vec2 cur;
  auto next = [&]() {
    while (i < d.size() && (d[i] == ' ' || d[i] == ',')) i++;
    char* end = nullptr;
    double v = std::strtod(d.c_str() + i, &end);
    i = static_cast<size_t>(end - d.c_str());
    return v;
  };
  while (i < d.size()) {
    char c = d[i++];
    switch (c) {
      case 'M': cur = {next(), next()}; p.moveTo(cur); break;
      case 'L': cur = {next(), next()}; p.lineTo(cur); break;
      case 'H': cur.x = next(); p.lineTo(cur); break;
      case 'V': cur.y = next(); p.lineTo(cur); break;
      case 'Q': {
        Vec2 a{next(), next()};
        cur = {next(), next()};
        p.quadTo(a, cur);
        break;
      }
      case 'C': {
        Vec2 a{next(), next()}, b{next(), next()};
        cur = {next(), next()};
        p.cubicTo(a, b, cur);
        break;
      }
      case 'Z': p.close(); break;
      default: break;
    }
  }
  return p;
}

double attrNum(const El& e, const char* k, double fallback = 0) {
  const std::string* v = e.attr(k);
  return v ? std::strtod(v->c_str(), nullptr) : fallback;
}

// A filled element's area as a path in the file's space (empty when it isn't a shape).
geom::Path shapeOf(const El& e) {
  Mat2x3 m = transformOf(e);
  if (e.tag == "rect") {
    Rect r{attrNum(e, "x"), attrNum(e, "y"), attrNum(e, "width"), attrNum(e, "height")};
    double rx = attrNum(e, "rx");
    return geom::rectPath({r.w, r.h}, {rx, rx, rx, rx}).transformed(m * Mat2x3::translate(r.x, r.y));
  }
  if (e.tag == "circle" || e.tag == "ellipse") {
    double rx = e.tag == "circle" ? attrNum(e, "r") : attrNum(e, "rx"), ry = e.tag == "circle" ? attrNum(e, "r") : attrNum(e, "ry");
    return geom::ellipsePath({2 * rx, 2 * ry}, ArcData{}).transformed(m * Mat2x3::translate(attrNum(e, "cx") - rx, attrNum(e, "cy") - ry));
  }
  if (e.tag == "path") return parsePathData(*e.attr("d")).transformed(m);
  return {};
}

std::string resultBytes() { return std::string(reinterpret_cast<const char*>(engine_result_ptr()), engine_result_len()); }

uint32_t u32(const std::string& s, size_t at) {
  return static_cast<uint32_t>(static_cast<uint8_t>(s[at])) | static_cast<uint32_t>(static_cast<uint8_t>(s[at + 1])) << 8 |
         static_cast<uint32_t>(static_cast<uint8_t>(s[at + 2])) << 16 | static_cast<uint32_t>(static_cast<uint8_t>(s[at + 3])) << 24;
}

// A page of shapes: a frame with a red rectangle, a circle, a rotated rectangle, a star; a group with a shadowed rect.
std::vector<NodeChange> sheet() {
  auto nodes = baseChanges();
  NodeChange frame = make({1, 1}, NodeType::FRAME, kPage, "!", {0, 0, 200, 160}, "Card");
  frame.props.fillPaints = {Paint::solid(Color{1, 1, 1, 1})};
  nodes.push_back(frame);
  NodeChange rect = make({1, 2}, NodeType::ROUNDED_RECTANGLE, {1, 1}, "!", {10, 10, 60, 40}, "Red");
  rect.props.fillPaints = {Paint::solid(Color{1, 0, 0, 1})};
  rect.props.cornerRadii = {8, 8, 8, 8};
  nodes.push_back(rect);
  NodeChange circle = make({1, 3}, NodeType::ELLIPSE, {1, 1}, "\"", {100, 10, 50, 50}, "Dot");
  circle.props.fillPaints = {Paint::solid(Color::hex(0x0D99FF))};
  nodes.push_back(circle);
  NodeChange rot = make({1, 4}, NodeType::ROUNDED_RECTANGLE, {1, 1}, "#", {40, 80, 50, 30}, "Tilted");
  rot.props.transform = Mat2x3::translate(60, 80) * Mat2x3::rotate(0.5);
  rot.props.fillPaints = {Paint::solid(Color{0, 0.5f, 0, 1})};
  nodes.push_back(rot);
  NodeChange star = make({1, 5}, NodeType::STAR, {1, 1}, "$", {130, 90, 50, 50}, "Star");
  star.props.count = 5;
  star.props.starInnerScale = 0.4;
  star.props.fillPaints = {Paint::solid(Color{1, 0.8f, 0.1f, 1})};
  nodes.push_back(star);
  return nodes;
}

}  // namespace

TEST_CASE("export: zlib streams inflate back to their input") {
  std::string big;
  for (int i = 0; i < 200000; i++) big += static_cast<char>((i * 7919) % 251 < 40 ? 'a' + (i % 3) : (i * 31) & 0xff);
  std::string flat(100000, '\x42');
  std::string text;
  for (int i = 0; i < 3000; i++) text += "0 0 1 rg\n10 20 m\n30 40 l\nh\nf\n";
  for (const std::string& in : {std::string(), std::string("x"), std::string("abcabcabcabc"), big, flat, text}) {
    std::string z = exporter::zlibCompress(in);
    CHECK(inflate(z) == in);
    if (in.size() > 1000 && in.size() < 150000) CHECK(z.size() < in.size() / 4);  // repetitive input compresses
  }
}

TEST_CASE("export: settings default to Figma's and read the schema's names") {
  json::Value v;
  REQUIRE(json::parse(R"({"imageType":"JPEG","constraint":{"type":"CONTENT_WIDTH","value":512},"suffix":"@w"})", v));
  exporter::Settings s = exporter::parseSettings(v);
  CHECK(s.format == exporter::Format::JPEG);
  CHECK(s.constraint == exporter::Constraint::WIDTH);
  CHECK(s.value == 512);
  CHECK(s.contentsOnly);
  CHECK(s.svgOutlineText);
  CHECK(s.svgSimplifyStroke);
  CHECK_FALSE(s.svgIds);
  REQUIRE(json::parse(R"({"imageType":"SVG","constraint":{"type":"CONTENT_SCALE","value":3},"svgIDMode":"ALWAYS","svgOutlineText":false,"svgForceStrokeMasks":true,"contentsOnly":false})", v));
  s = exporter::parseSettings(v);
  CHECK(s.format == exporter::Format::SVG);
  CHECK(s.value == 1);  // SVG and PDF: 1x only
  CHECK(s.svgIds);
  CHECK_FALSE(s.svgOutlineText);
  CHECK_FALSE(s.svgSimplifyStroke);
  CHECK_FALSE(s.contentsOnly);
  CHECK(std::string(exporter::extensionOf(exporter::Format::JPEG)) == "jpg");
}

TEST_CASE("export: bounds — content, clipping, shadows, strokes, bounding box; sizes for 1x, 2x, 512w, 512h") {
  auto nodes = baseChanges();
  NodeChange frame = make({1, 1}, NodeType::FRAME, kPage, "!", {10, 20, 100, 50}, "Frame");
  nodes.push_back(frame);
  NodeChange inside = make({1, 2}, NodeType::ROUNDED_RECTANGLE, {1, 1}, "!", {80, 10, 60, 20}, "Overflow");  // past the frame's right edge
  inside.props.fillPaints = {Paint::solid(Color{1, 0, 0, 1})};
  nodes.push_back(inside);
  NodeChange shadowed = make({1, 3}, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {300, 0, 100, 100}, "Shadowed");
  shadowed.props.fillPaints = {Paint::solid(Color{1, 1, 1, 1})};
  Effect drop;
  drop.type = EffectType::DROP_SHADOW;
  drop.offset = {0, 4};
  drop.radius = 4;
  shadowed.props.effects = {drop};
  nodes.push_back(shadowed);
  NodeChange stroked = make({1, 4}, NodeType::ELLIPSE, kPage, "#", {500, 0, 40, 40}, "Ring");
  stroked.props.strokePaints = {Paint::solid(Color{0, 0, 0, 1})};
  stroked.props.strokeWeight = 4;
  stroked.props.strokeAlign = StrokeAlign::OUTSIDE;
  nodes.push_back(stroked);
  Editor e;
  e.loadDocument(nodes, kNoGuid);
  const Document& doc = e.document();
  // A frame clips its content: the overflow doesn't count.
  Rect fb = exporter::contentBounds(doc, &e, {1, 1});
  CHECK(fb.x == doctest::Approx(10));
  CHECK(fb.w == doctest::Approx(100));
  CHECK(fb.h == doctest::Approx(50));
  // Figma's shadow bounds: a 100×100 rect with a (0, 4, blur 4) drop shadow exports 108 × 108.
  Rect sb = exporter::contentBounds(doc, &e, {1, 3});
  CHECK(sb.x == doctest::Approx(296));
  CHECK(sb.y == doctest::Approx(0));
  CHECK(sb.w == doctest::Approx(108));
  CHECK(sb.h == doctest::Approx(108));
  // An outside stroke grows the ellipse by its weight on every side.
  Rect rb = exporter::contentBounds(doc, &e, {1, 4});
  CHECK(rb.w == doctest::Approx(48).epsilon(0.01));
  // "Include bounding box": the layer's box, effects left out.
  exporter::Settings s;
  s.useAbsoluteBounds = true;
  exporter::Target t;
  REQUIRE(exporter::resolveTarget(doc, &e, kNoGuid, {1, 3}, s, t));
  CHECK(t.bounds.w == doctest::Approx(100));
  // Sizes.
  s = exporter::Settings{};
  REQUIRE(exporter::resolveTarget(doc, &e, kNoGuid, {1, 1}, s, t));
  CHECK_FALSE(t.region);
  CHECK(exporter::rasterOf(t.bounds, s).width == 100);
  s.value = 2;
  CHECK(exporter::rasterOf(t.bounds, s).width == 200);
  CHECK(exporter::rasterOf(t.bounds, s).height == 100);
  s.constraint = exporter::Constraint::WIDTH;
  s.value = 512;
  CHECK(exporter::rasterOf(t.bounds, s).width == 512);
  CHECK(exporter::rasterOf(t.bounds, s).height == 256);
  s.constraint = exporter::Constraint::HEIGHT;
  CHECK(exporter::rasterOf(t.bounds, s).height == 512);
  CHECK(exporter::rasterOf(t.bounds, s).width == 1024);
  // Too large: scaled down to fit.
  s.constraint = exporter::Constraint::SCALE;
  s.value = 1000;
  exporter::Raster big = exporter::rasterOf(t.bounds, s);
  CHECK(big.width <= exporter::kMaxSide);
  CHECK(static_cast<double>(big.width) * big.height <= exporter::kMaxPixels * 1.01);
  // Ignore overlapping layers off: a region of the page.
  s = exporter::Settings{};
  s.contentsOnly = false;
  REQUIRE(exporter::resolveTarget(doc, &e, kNoGuid, {1, 1}, s, t));
  CHECK(t.region);
  CHECK(t.scope == kPage);
  // Nothing selected: the canvas, on the page colour.
  REQUIRE(exporter::resolveTarget(doc, &e, kPage, kNoGuid, exporter::Settings{}, t));
  CHECK(t.background);
  CHECK(t.bounds.x == doctest::Approx(10));
  CHECK(t.bounds.right() == doctest::Approx(544));
}

TEST_CASE("export: a slice exports its box with what shows under it") {
  auto nodes = baseChanges();
  NodeChange frame = make({1, 1}, NodeType::FRAME, kPage, "!", {0, 0, 100, 100}, "Frame");
  frame.props.fillPaints = {Paint::solid(Color{1, 1, 1, 1})};
  nodes.push_back(frame);
  nodes.push_back(make({1, 2}, NodeType::SLICE, {1, 1}, "!", {10, 10, 30, 20}, "Slice 1"));
  nodes.push_back(make({1, 3}, NodeType::SLICE, kPage, "\"", {200, 0, 50, 50}, "Slice 2"));
  Editor e;
  e.loadDocument(nodes, kNoGuid);
  exporter::Target t;
  REQUIRE(exporter::resolveTarget(e.document(), &e, kNoGuid, {1, 2}, exporter::Settings{}, t));
  CHECK(t.region);
  CHECK(t.scope == Guid{1, 1});  // contents only: its frame's content
  CHECK(t.bounds.w == doctest::Approx(30));
  exporter::Settings all;
  all.contentsOnly = false;
  REQUIRE(exporter::resolveTarget(e.document(), &e, kNoGuid, {1, 2}, all, t));
  CHECK(t.scope == kPage);
  REQUIRE(exporter::resolveTarget(e.document(), &e, kNoGuid, {1, 3}, exporter::Settings{}, t));
  CHECK(t.scope == kPage);  // outside any frame: the page
  // The slice's SVG shows the frame's white within its box.
  std::string svg = exporter::writeSvg(e.document(), &e, t, exporter::Settings{});
  CHECK(svg.find("width=\"50\" height=\"50\" viewBox=\"0 0 50 50\"") != std::string::npos);
}

TEST_CASE("export: SVG is well formed, Figma-shaped, and its shapes cover what the layers do") {
  Editor e;
  e.loadDocument(sheet(), kNoGuid);
  const Document& doc = e.document();
  exporter::Settings s;
  s.format = exporter::Format::SVG;
  exporter::Target t;
  REQUIRE(exporter::resolveTarget(doc, &e, kNoGuid, {1, 1}, s, t));
  std::string svg = exporter::writeSvg(doc, &e, t, s);
  El root;
  INFO(svg);
  REQUIRE(parseXml(svg, root));
  CHECK(root.tag == "svg");
  CHECK(*root.attr("width") == "200");
  CHECK(*root.attr("height") == "160");
  CHECK(*root.attr("viewBox") == "0 0 200 160");
  CHECK(*root.attr("fill") == "none");
  CHECK(*root.attr("xmlns") == "http://www.w3.org/2000/svg");
  // Figma's shapes: the frame clips (clip0_1_1), the red rounded rect is a <rect rx>, the circle a <circle>.
  CHECK(svg.find("clip-path=\"url(#clip0_1_1)\"") != std::string::npos);
  CHECK(svg.find("<rect x=\"10\" y=\"10\" width=\"60\" height=\"40\" rx=\"8\" fill=\"#FF0000\"/>") != std::string::npos);
  CHECK(svg.find("<circle cx=\"125\" cy=\"35\" r=\"25\" fill=\"#0D99FF\"/>") != std::string::npos);
  CHECK(svg.find("<rect width=\"200\" height=\"160\" fill=\"white\"/>") != std::string::npos);
  CHECK(svg.find("id=\"Card\"") == std::string::npos);  // no ids unless asked
  // Re-rendered by point sampling: inside a coloured shape in the SVG ⇔ inside one in the document.
  std::vector<const El*> shapes;
  for (const char* tag : {"rect", "circle", "ellipse", "path"}) {
    std::vector<const El*> found;
    for (auto& k : root.kids)
      if (k.tag != "defs") collect(k, tag, found);
    for (auto* f : found)
      if (f->attr("fill") && *f->attr("fill") != "white" && *f->attr("fill") != "none") shapes.push_back(f);
  }
  REQUIRE(shapes.size() == 4);
  std::vector<std::vector<geom::Polyline>> svgPolys, docPolys;
  for (auto* el : shapes) svgPolys.push_back(geom::flatten(shapeOf(*el), 0.01));
  for (Guid id : {Guid{1, 2}, Guid{1, 3}, Guid{1, 4}, Guid{1, 5}}) {
    exporter::Shape sh = exporter::fillShape(doc, id, doc.get(id)->props);
    docPolys.push_back(geom::flatten(sh.path().transformed(doc.worldTransform(id)), 0.01));
  }
  int inside = 0, checked = 0;
  for (double y = 0.5; y < 160; y += 1.7) {
    for (double x = 0.5; x < 200; x += 1.7) {
      Vec2 p{x, y};
      bool near = false, inSvg = false, inDoc = false;
      for (auto& poly : svgPolys) {
        near |= geom::distanceTo(poly, p) < 0.25;
        inSvg |= geom::contains(poly, p, false);
      }
      for (auto& poly : docPolys) {
        near |= geom::distanceTo(poly, p) < 0.25;
        inDoc |= geom::contains(poly, p, false);
      }
      if (near) continue;
      checked++;
      inside += inDoc ? 1 : 0;
      if (inSvg != inDoc) FAIL_CHECK("SVG and document disagree at " << x << ", " << y);
    }
  }
  CHECK(checked > 9000);
  CHECK(inside > 1000);
}

TEST_CASE("export: SVG paints, strokes, effects, masks, ids") {
  auto nodes = baseChanges();
  NodeChange grad = make({2, 1}, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 100, 50}, "Gradient");
  Paint g;
  g.type = PaintType::GRADIENT_LINEAR;
  g.stops = {{Color{1, 0, 0, 1}, 0}, {Color{0, 0, 1, 0.5f}, 1}};
  g.transform = Mat2x3{1, 0, 0, 0, 1, 0};
  grad.props.fillPaints = {g};
  grad.props.strokePaints = {Paint::solid(Color{0, 0, 0, 1})};
  grad.props.strokeWeight = 2;
  grad.props.strokeAlign = StrokeAlign::INSIDE;
  Effect drop;
  drop.type = EffectType::DROP_SHADOW;
  drop.offset = {0, 4};
  drop.radius = 4;
  drop.color = {0, 0, 0, 0.25f};
  grad.props.effects = {drop};
  nodes.push_back(grad);
  NodeChange group = make({2, 2}, NodeType::FRAME, kPage, "\"", {0, 100, 100, 100}, "Group 1");
  group.props.resizeToFit = true;
  nodes.push_back(group);
  NodeChange mask = make({2, 3}, NodeType::ELLIPSE, {2, 2}, "!", {0, 0, 100, 100}, "Mask");
  mask.props.fillPaints = {Paint::solid(Color{0, 0, 0, 1})};
  mask.props.mask = true;
  nodes.push_back(mask);
  NodeChange masked = make({2, 4}, NodeType::ROUNDED_RECTANGLE, {2, 2}, "\"", {0, 0, 100, 100}, "Vector");
  masked.props.fillPaints = {Paint::solid(Color{0, 1, 0, 1})};
  masked.props.opacity = 0.5;
  nodes.push_back(masked);
  NodeChange line = make({2, 5}, NodeType::LINE, kPage, "#", {200, 10, 100, 0}, "Vector");
  line.props.strokePaints = {Paint::solid(Color{0, 0, 0, 1})};
  line.props.strokeWeight = 1;
  line.props.strokeCap = StrokeCap::ROUND;
  nodes.push_back(line);
  Editor e;
  e.loadDocument(nodes, kNoGuid);
  const Document& doc = e.document();
  exporter::Settings s;
  s.format = exporter::Format::SVG;
  exporter::Target t;
  // Gradient + inside stroke + drop shadow, simplified: an inset rect stroke.
  REQUIRE(exporter::resolveTarget(doc, &e, kNoGuid, {2, 1}, s, t));
  std::string svg = exporter::writeSvg(doc, &e, t, s);
  El root;
  INFO(svg);
  REQUIRE(parseXml(svg, root));
  CHECK(*root.attr("width") == "108");
  CHECK(*root.attr("height") == "58");
  CHECK(svg.find("<g filter=\"url(#filter0_d_2_1)\">") != std::string::npos);
  CHECK(svg.find("<linearGradient id=\"paint0_linear_2_1\" x1=\"4\" y1=\"25\" x2=\"104\" y2=\"25\" gradientUnits=\"userSpaceOnUse\">") != std::string::npos);
  CHECK(svg.find("<stop offset=\"1\" stop-color=\"#0000FF\" stop-opacity=\"0.5\"/>") != std::string::npos);
  CHECK(svg.find("<rect x=\"5\" y=\"1\" width=\"98\" height=\"48\" stroke=\"black\" stroke-width=\"2\"/>") != std::string::npos);
  CHECK(svg.find("<feOffset dy=\"4\"/>") != std::string::npos);
  CHECK(svg.find("<feGaussianBlur stdDeviation=\"2\"/>") != std::string::npos);
  CHECK(svg.find("values=\"0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0\"") != std::string::npos);
  CHECK(svg.find("<filter id=\"filter0_d_2_1\" x=\"0\" y=\"0\" width=\"108\" height=\"58\"") != std::string::npos);
  // Simplify stroke off: twice the weight under a mask of the fill.
  s.svgSimplifyStroke = false;
  svg = exporter::writeSvg(doc, &e, t, s);
  INFO(svg);
  REQUIRE(parseXml(svg, root));
  CHECK(svg.find("<mask id=\"path-1-inside-1_2_1\" fill=\"white\">") != std::string::npos);
  CHECK(svg.find("stroke-width=\"4\" mask=\"url(#path-1-inside-1_2_1)\"") != std::string::npos);
  // A mask group: <mask> then the masked layers in a <g mask>; ids from the layer names, duplicates numbered.
  s = exporter::Settings{};
  s.format = exporter::Format::SVG;
  s.svgIds = true;
  REQUIRE(exporter::resolveTarget(doc, &e, kNoGuid, {2, 2}, s, t));
  svg = exporter::writeSvg(doc, &e, t, s);
  INFO(svg);
  REQUIRE(parseXml(svg, root));
  CHECK(svg.find("<mask id=\"mask0_2_2\" style=\"mask-type:alpha\" maskUnits=\"userSpaceOnUse\" x=\"0\" y=\"0\" width=\"100\" height=\"100\">") !=
        std::string::npos);
  CHECK(svg.find("<g mask=\"url(#mask0_2_2)\">") != std::string::npos);
  CHECK(svg.find("id=\"Group 1\"") != std::string::npos);
  CHECK(svg.find("<rect id=\"Vector\" width=\"100\" height=\"100\" fill=\"#00FF00\" opacity=\"0.5\"/>") != std::string::npos);
  // A line: a round-capped centre stroke as a path.
  s.svgIds = false;
  REQUIRE(exporter::resolveTarget(doc, &e, kNoGuid, {2, 5}, s, t));
  svg = exporter::writeSvg(doc, &e, t, s);
  INFO(svg);
  REQUIRE(parseXml(svg, root));
  CHECK(*root.attr("width") == "101");
  CHECK(*root.attr("height") == "1");
  CHECK(svg.find("stroke=\"black\" stroke-linecap=\"round\"") != std::string::npos);
}

TEST_CASE("export: SVG text as outlines or as <text>") {
  loadInter();
  auto nodes = baseChanges();
  NodeChange t = make({3, 1}, NodeType::TEXT, kPage, "!", {10, 10, 100, 20}, "Hello");
  t.props.textData.characters = "Hello & <you>";
  t.props.textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
  t.props.fillPaints = {Paint::solid(Color{0, 0, 0, 1})};
  nodes.push_back(t);
  Editor e;
  e.loadDocument(nodes, kNoGuid);
  exporter::Settings s;
  s.format = exporter::Format::SVG;
  exporter::Target target;
  REQUIRE(exporter::resolveTarget(e.document(), &e, kNoGuid, {3, 1}, s, target));
  // The ink, not the box: no taller than the line, no wider than the text.
  CHECK(target.bounds.h < 16);
  std::string svg = exporter::writeSvg(e.document(), &e, target, s);
  El root;
  INFO(svg);
  REQUIRE(parseXml(svg, root));
  std::vector<const El*> paths;
  collect(root, "path", paths);
  CHECK(paths.size() == 1);
  CHECK(svg.find("<text") == std::string::npos);
  s.svgOutlineText = false;
  svg = exporter::writeSvg(e.document(), &e, target, s);
  INFO(svg);
  REQUIRE(parseXml(svg, root));
  std::vector<const El*> texts;
  collect(root, "text", texts);
  REQUIRE(texts.size() == 1);
  CHECK(*texts[0]->attr("font-family") == "Inter");
  CHECK(*texts[0]->attr("font-size") == "12");
  CHECK(*texts[0]->attr("letter-spacing") == "0em");
  CHECK(*texts[0]->attr("xml:space") == "preserve");
  REQUIRE(texts[0]->kids.size() == 1);
  CHECK(texts[0]->kids[0].text == "Hello &amp; &lt;you&gt;");
}

TEST_CASE("export: PDF structure, streams and text as Type 3 glyphs") {
  loadInter();
  auto nodes = sheet();
  NodeChange t = make({3, 1}, NodeType::TEXT, {1, 1}, "%", {10, 120, 100, 20}, "Label");
  t.props.textData.characters = "Hi";
  t.props.textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
  t.props.fillPaints = {Paint::solid(Color{0, 0, 0, 1})};
  nodes.push_back(t);
  NodeChange second = make({4, 1}, NodeType::FRAME, kPage, "\"", {400, 0, 120, 90}, "Second");
  Paint g;
  g.type = PaintType::GRADIENT_ANGULAR;
  g.stops = {{Color{1, 0, 0, 1}, 0}, {Color{0, 0, 1, 1}, 1}};
  second.props.fillPaints = {g};
  nodes.push_back(second);
  Editor e;
  e.loadDocument(nodes, kNoGuid);
  const Document& doc = e.document();
  exporter::Settings s;
  s.format = exporter::Format::PDF;
  std::vector<exporter::Target> pages(2);
  REQUIRE(exporter::resolveTarget(doc, &e, kNoGuid, {1, 1}, s, pages[0]));
  REQUIRE(exporter::resolveTarget(doc, &e, kNoGuid, {4, 1}, s, pages[1]));
  std::string pdf = exporter::writePdf(doc, &e, pages, s, nullptr);
  REQUIRE(pdf.rfind("%PDF-1.7\n", 0) == 0);
  CHECK(pdf.size() > 500);
  // The xref table points at every object.
  size_t sx = pdf.rfind("startxref\n");
  REQUIRE(sx != std::string::npos);
  size_t xref = std::stoul(pdf.substr(sx + 10));
  REQUIRE(pdf.compare(xref, 5, "xref\n") == 0);
  size_t at = pdf.find('\n', xref + 5);
  int count = std::stoi(pdf.substr(xref + 7, at - xref - 7));
  CHECK(count > 10);
  size_t entries = at + 1;
  for (int i = 1; i < count; i++) {
    size_t off = std::stoul(pdf.substr(entries + static_cast<size_t>(i) * 20, 10));
    CHECK(pdf.compare(off, std::to_string(i).size() + 6, std::to_string(i) + " 0 obj") == 0);
  }
  CHECK(pdf.find("/Type /Pages /Kids [") != std::string::npos);
  CHECK(pdf.find("/Count 2") != std::string::npos);
  CHECK(pdf.find("/MediaBox [0 0 200 160]") != std::string::npos);
  CHECK(pdf.find("/MediaBox [0 0 120 90]") != std::string::npos);
  CHECK(pdf.find("/Subtype /Type3") != std::string::npos);
  CHECK(pdf.find("/ShadingType 1") != std::string::npos);  // the angular gradient: a function shading
  CHECK(pdf.find("/FunctionType 4") != std::string::npos);
  // Every stream inflates; the first page draws the red rect, the text with Tj, and its ToUnicode maps H and i.
  std::string all;
  size_t pos = 0;
  int streams = 0;
  while ((pos = pdf.find("stream\n", pos)) != std::string::npos) {
    size_t dict = pdf.rfind("<<", pos);
    size_t end = pdf.find("\nendstream", pos);
    REQUIRE(end != std::string::npos);
    std::string data = pdf.substr(pos + 7, end - pos - 7);
    std::string head = pdf.substr(dict, pos - dict);
    size_t len = head.find("/Length ");
    REQUIRE(len != std::string::npos);
    CHECK(std::stoul(head.substr(len + 8)) == data.size());
    if (head.find("/FlateDecode") != std::string::npos) data = inflate(data);
    CHECK(data.find("<inflate error") == std::string::npos);
    all += data + "\n";
    pos = end + 10;
    streams++;
  }
  CHECK(streams > 4);
  CHECK(all.find("1 0 0 rg") != std::string::npos);
  CHECK(all.find(" Tj") != std::string::npos);
  CHECK(all.find("/F0 1 Tf") != std::string::npos);
  CHECK(all.find("<00> <0048>") != std::string::npos);
  CHECK(all.find("<01> <0069>") != std::string::npos);
  CHECK(all.find(" d1\n") != std::string::npos);
  CHECK(all.find("atan") != std::string::npos);
}

TEST_CASE("export: the C ABI — PNG / JPEG pixels, SVG, PDF, info, images, the export list") {
  const char* doc = R"({"type":"NODE_CHANGES","sessionID":0,"nodeChanges":[
    {"guid":"0:0","phase":"CREATED","type":"DOCUMENT","name":"Document"},
    {"guid":"0:1","phase":"CREATED","type":"CANVAS","name":"Page 1","parentIndex":{"guid":"0:0","position":"!"},"backgroundEnabled":true,"backgroundColor":{"r":0.9,"g":0.9,"b":0.9,"a":1}},
    {"guid":"1:1","phase":"CREATED","type":"FRAME","name":"Frame 1","parentIndex":{"guid":"0:1","position":"!"},
     "size":{"x":200,"y":100},"fillPaints":[{"type":"SOLID","color":{"r":1,"g":1,"b":1,"a":1}}],
     "exportSettings":[{"suffix":"","imageType":"PNG","constraint":{"type":"CONTENT_SCALE","value":2}},{"suffix":"","imageType":"SVG","constraint":{"type":"CONTENT_SCALE","value":1}}]},
    {"guid":"1:2","phase":"CREATED","type":"ROUNDED_RECTANGLE","name":"Photo","parentIndex":{"guid":"1:1","position":"!"},
     "size":{"x":50,"y":50},"transform":{"m00":1,"m01":0,"m02":10,"m10":0,"m11":1,"m12":10},
     "fillPaints":[{"type":"IMAGE","imageScaleMode":"FILL","image":{"hash":"0123456789abcdef0123456789abcdef01234567"},"originalImageWidth":2,"originalImageHeight":2}]}
  ]})";
  std::string opts = R"({"sessionID":1})";
  Handle h = engine_create(nullptr, reinterpret_cast<Ptr>(opts.data()), static_cast<uint32_t>(opts.size()));
  REQUIRE(h != 0);
  REQUIRE(engine_load(h, reinterpret_cast<Ptr>(doc), static_cast<uint32_t>(std::strlen(doc))) == 0);
  auto call = [&](const std::string& refs, const std::string& settings, uint32_t flags) {
    return engine_export(h, reinterpret_cast<Ptr>(refs.data()), static_cast<uint32_t>(refs.size()), reinterpret_cast<Ptr>(settings.data()),
                         static_cast<uint32_t>(settings.size()), flags);
  };
  std::string frame = R"(["1:1"])";
  // The image hasn't arrived: busy (it's requested) unless pending is allowed.
  CHECK(call(frame, R"({"imageType":"PNG"})", 0) == -7);
  REQUIRE(call(frame, R"({"imageType":"PNG","constraint":{"type":"CONTENT_SCALE","value":2}})", 1) == 0);
  std::string r = resultBytes();
  CHECK(u32(r, 0) == 400);
  CHECK(u32(r, 4) == 200);
  REQUIRE(r.size() == 8 + 400 * 200 * 4);
  CHECK(static_cast<uint8_t>(r[8 + 3]) == 0);  // the recording device: an export clears to transparent
  REQUIRE(call(frame, R"({"imageType":"JPEG","constraint":{"type":"CONTENT_WIDTH","value":100}})", 1) == 0);
  r = resultBytes();
  CHECK(u32(r, 0) == 100);
  CHECK(u32(r, 4) == 50);
  CHECK(static_cast<uint8_t>(r[8]) == 255);  // JPEG: on white
  CHECK(static_cast<uint8_t>(r[8 + 3]) == 255);
  // The canvas (nothing selected): on the page colour.
  REQUIRE(call("[]", R"({"imageType":"PNG"})", 1) == 0);
  r = resultBytes();
  CHECK(u32(r, 0) == 200);
  CHECK(std::abs(static_cast<int>(static_cast<uint8_t>(r[8])) - 230) <= 1);
  // Info: the sizes and the images an SVG needs.
  std::string svgSettings = R"({"imageType":"SVG"})";
  REQUIRE(engine_export_info(h, reinterpret_cast<Ptr>(frame.data()), static_cast<uint32_t>(frame.size()), reinterpret_cast<Ptr>(svgSettings.data()),
                             static_cast<uint32_t>(svgSettings.size())) == 0);
  json::Value info;
  REQUIRE(json::parse(resultBytes(), info));
  CHECK(info.get("targets")->array[0].get("width")->number == 200);
  REQUIRE(info.get("images")->array.size() == 1);
  CHECK(info.get("images")->array[0].string == "0123456789abcdef0123456789abcdef01234567");
  // Handed in, the image is inlined as a data URI in a pattern.
  std::string hash = "0123456789abcdef0123456789abcdef01234567";
  std::string png = std::string("\x89PNG\r\n\x1a\n", 8) + "fake";
  REQUIRE(engine_export_image(h, reinterpret_cast<Ptr>(hash.data()), 40, 0, 2, 2, reinterpret_cast<Ptr>(png.data()), static_cast<uint32_t>(png.size()), 0,
                              0) == 0);
  REQUIRE(call(frame, svgSettings, 1) == 0);
  std::string svg = resultBytes();
  CHECK(svg.find("xmlns:xlink=\"http://www.w3.org/1999/xlink\"") != std::string::npos);
  CHECK(svg.find("fill=\"url(#pattern0_1_1)\"") != std::string::npos);
  CHECK(svg.find("xlink:href=\"data:image/png;base64,iVBORw0KGgpmYWtl\"") != std::string::npos);
  El root;
  CHECK(parseXml(svg, root));
  engine_export_clear_images();
  // PDF of two refs: two pages.
  std::string two = R"(["1:1","1:2"])";
  REQUIRE(call(two, R"({"imageType":"PDF"})", 1) == 0);
  CHECK(resultBytes().find("/Count 2") != std::string::npos);
  CHECK(call(two, R"({"imageType":"PNG"})", 1) == -3);  // one layer at a time
  CHECK(call(R"(["9:9"])", R"({"imageType":"PNG"})", 1) == -5);
  // The export list: the layers with export settings, their settings as JSON.
  REQUIRE(engine_export_list(h, 0xffffffffu, 0xffffffffu) == 0);
  json::Value list;
  REQUIRE(json::parse(resultBytes(), list));
  REQUIRE(list.array.size() == 1);
  CHECK(list.array[0].get("guid")->string == "1:1");
  REQUIRE(list.array[0].get("exportSettings")->array.size() == 2);
  CHECK(list.array[0].get("exportSettings")->array[1].get("imageType")->string == "SVG");
  engine_destroy(h);
}
