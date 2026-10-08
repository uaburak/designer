#include "export/PdfWriter.h"

#include <cmath>
#include <cstdio>
#include <map>
#include <unordered_map>

#include "export/Deflate.h"
#include "export/Scene.h"
#include "geometry/Shapes.h"
#include "text/Fonts.h"
#include "text/Unicode.h"

namespace eng::exporter {

namespace {

std::string n(double v) { return num(v, 4); }

std::string matrixOps(const Mat2x3& m) {
  return n(m.m00) + " " + n(m.m10) + " " + n(m.m01) + " " + n(m.m11) + " " + n(m.m02) + " " + n(m.m12);
}

const char* blendName(BlendMode m) {
  switch (m) {
    case BlendMode::DARKEN: return "Darken";
    case BlendMode::MULTIPLY: return "Multiply";
    case BlendMode::COLOR_BURN: return "ColorBurn";
    case BlendMode::LIGHTEN: return "Lighten";
    case BlendMode::SCREEN: return "Screen";
    case BlendMode::COLOR_DODGE: return "ColorDodge";
    case BlendMode::OVERLAY: return "Overlay";
    case BlendMode::SOFT_LIGHT: return "SoftLight";
    case BlendMode::HARD_LIGHT: return "HardLight";
    case BlendMode::DIFFERENCE: return "Difference";
    case BlendMode::EXCLUSION: return "Exclusion";
    case BlendMode::HUE: return "Hue";
    case BlendMode::SATURATION: return "Saturation";
    case BlendMode::COLOR: return "Color";
    case BlendMode::LUMINOSITY: return "Luminosity";
    // Plus darker / plus lighter: PDF has none (Figma: "not supported in PDF exports").
    default: return nullptr;
  }
}

std::string rgb(const Color& c) { return n(c.r) + " " + n(c.g) + " " + n(c.b); }

// PDF objects, numbered from 1, written with an xref table.
class File {
 public:
  int alloc() {
    objs_.emplace_back();
    return static_cast<int>(objs_.size());
  }
  void set(int id, std::string body) { objs_[static_cast<size_t>(id - 1)] = std::move(body); }
  int add(std::string body) {
    int id = alloc();
    set(id, std::move(body));
    return id;
  }
  static std::string stream(std::string dict, std::string data, bool compress) {
    if (compress && data.size() > 64) {
      data = zlibCompress(data);
      dict += " /Filter /FlateDecode";
    }
    return "<< " + dict + " /Length " + std::to_string(data.size()) + " >>\nstream\n" + data + "\nendstream";
  }
  std::string finish(int catalog, int info) const {
    std::string out = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
    std::vector<size_t> offsets;
    for (size_t i = 0; i < objs_.size(); i++) {
      offsets.push_back(out.size());
      out += std::to_string(i + 1) + " 0 obj\n" + objs_[i] + "\nendobj\n";
    }
    size_t xref = out.size();
    out += "xref\n0 " + std::to_string(objs_.size() + 1) + "\n0000000000 65535 f \n";
    char line[32];
    for (size_t o : offsets) {
      std::snprintf(line, sizeof line, "%010zu 00000 n \n", o);
      out += line;
    }
    out += "trailer\n<< /Size " + std::to_string(objs_.size() + 1) + " /Root " + std::to_string(catalog) + " 0 R /Info " + std::to_string(info) +
           " 0 R >>\nstartxref\n" + std::to_string(xref) + "\n%%EOF\n";
    return out;
  }

 private:
  std::vector<std::string> objs_;
};

// A Type 3 font of glyph outlines (up to 256 glyphs).
struct Type3 {
  int obj = 0;
  std::string name;
  std::vector<int> procs;
  std::vector<double> widths;
  std::vector<std::u16string> unicode;
  double bbox[4] = {0, 0, 0, 0};
};

class Writer {
 public:
  Writer(const Document& doc, TextLayouts* texts, const Rasterize& raster) : doc_(doc), texts_(texts), raster_(raster) {
    resources_ = file_.alloc();
  }

  std::string run(const std::vector<Target>& targets) {
    int pagesId = file_.alloc();
    std::string kids;
    for (const Target& t : targets) {
      t_ = &t;
      H_ = t.bounds.h;
      W_ = t.bounds.w;
      origin_ = Mat2x3::translate(-t.bounds.x, -t.bounds.y);
      F_ = Mat2x3{1, 0, 0, 0, -1, H_};
      std::string content;
      if (t.background) content += rgb(t.backgroundColor) + " rg\n0 0 " + n(W_) + " " + n(H_) + " re\nf\n";
      if (!t.region) {
        node(content, t.node, 1);
      } else if (t.scope != t.page) {
        node(content, t.scope, 1);
      } else {
        std::vector<Drawn> roots;
        for (const Drawn& d : drawnChildren(doc_, t.page))
          if (doc_.renderBounds(d.id).intersects(t.bounds)) roots.push_back(d);
        siblings(content, roots, 0, 1);
      }
      int contents = file_.add(File::stream("", content, true));
      int page = file_.add("<< /Type /Page /Parent " + ref(pagesId) + " /MediaBox [0 0 " + n(W_) + " " + n(H_) + "] /Resources " + ref(resources_) +
                           " /Contents " + ref(contents) + " /Group << /Type /Group /S /Transparency /CS /DeviceRGB >> >>");
      kids += ref(page) + " ";
    }
    file_.set(pagesId, "<< /Type /Pages /Kids [" + kids + "] /Count " + std::to_string(targets.size()) + " >>");
    writeFonts();
    std::string res = "<< /ProcSet [/PDF /Text /ImageB /ImageC]";
    auto dict = [&](const char* key, const std::vector<std::pair<std::string, int>>& list) {
      if (list.empty()) return;
      res += std::string(" /") + key + " <<";
      for (auto& [name, id] : list) res += " /" + name + " " + ref(id);
      res += " >>";
    };
    dict("ExtGState", gsList_);
    dict("Pattern", patterns_);
    dict("XObject", xobjects_);
    std::vector<std::pair<std::string, int>> fonts;
    for (auto& f : fonts_) fonts.push_back({f.name, f.obj});
    dict("Font", fonts);
    res += " >>";
    file_.set(resources_, res);
    int catalog = file_.add("<< /Type /Catalog /Pages " + ref(pagesId) + " >>");
    int info = file_.add("<< /Producer (DesignerV2) >>");
    return file_.finish(catalog, info);
  }

 private:
  static std::string ref(int id) { return std::to_string(id) + " 0 R"; }

  // ---- Paths ----

  void path(std::string& o, const geom::Path& p, const Mat2x3& M) {
    size_t pi = 0;
    Vec2 cur;
    auto pt = [&](Vec2 v) {
      Vec2 q = M.apply(v);
      return n(q.x) + " " + n(q.y);
    };
    Vec2 start;
    for (geom::Verb v : p.verbs) {
      switch (v) {
        case geom::Verb::Move:
          cur = start = p.points[pi++];
          o += pt(cur) + " m\n";
          break;
        case geom::Verb::Line:
          cur = p.points[pi++];
          o += pt(cur) + " l\n";
          break;
        case geom::Verb::Quad: {
          Vec2 c = p.points[pi], e = p.points[pi + 1];
          pi += 2;
          Vec2 c1 = cur + (c - cur) * (2.0 / 3), c2 = e + (c - e) * (2.0 / 3);
          o += pt(c1) + " " + pt(c2) + " " + pt(e) + " c\n";
          cur = e;
          break;
        }
        case geom::Verb::Cubic:
          o += pt(p.points[pi]) + " " + pt(p.points[pi + 1]) + " " + pt(p.points[pi + 2]) + " c\n";
          cur = p.points[pi + 2];
          pi += 3;
          break;
        case geom::Verb::Close:
          o += "h\n";
          cur = start;
          break;
      }
    }
  }

  // ---- Graphics states, patterns, functions ----

  std::string gs(double fillAlpha, double strokeAlpha, BlendMode bm, int smask = 0) {
    const char* blend = blendName(bm);
    std::string key = n(fillAlpha) + "|" + n(strokeAlpha) + "|" + (blend ? blend : "") + "|" + std::to_string(smask);
    auto it = gsByKey_.find(key);
    if (it != gsByKey_.end()) return "/" + it->second + " gs\n";
    std::string body = "<< /Type /ExtGState";
    if (fillAlpha < 1) body += " /ca " + n(fillAlpha);
    if (strokeAlpha < 1) body += " /CA " + n(strokeAlpha);
    if (blend) body += std::string(" /BM /") + blend;
    if (smask) body += " /SMask " + ref(smask);
    body += " >>";
    std::string name = "GS" + std::to_string(gsList_.size());
    gsList_.push_back({name, file_.add(body)});
    gsByKey_[key] = name;
    return "/" + name + " gs\n";
  }

  static bool plainState(double a, BlendMode bm) { return a >= 1 && !blendName(bm); }

  // A sampled-free ramp: a stitching function of linear segments (gray: the stops' alpha).
  std::string rampFunction(const std::vector<ColorStop>& stops, bool gray) {
    auto c = [&](const ColorStop& s) { return gray ? n(s.color.a) : rgb(s.color); };
    if (stops.size() == 1) return "<< /FunctionType 2 /Domain [0 1] /C0 [" + c(stops[0]) + "] /C1 [" + c(stops[0]) + "] /N 1 >>";
    std::vector<std::string> fns;
    std::vector<double> bounds;
    auto seg = [&](const ColorStop& a, const ColorStop& b) {
      fns.push_back("<< /FunctionType 2 /Domain [0 1] /C0 [" + c(a) + "] /C1 [" + c(b) + "] /N 1 >>");
    };
    double last = 0;
    if (stops.front().position > 0) {
      seg(stops.front(), stops.front());
      last = stops.front().position;
      bounds.push_back(last);
    }
    for (size_t i = 0; i + 1 < stops.size(); i++) {
      seg(stops[i], stops[i + 1]);
      double b = std::max(stops[i + 1].position, last + 1e-5);
      if (i + 2 < stops.size() || stops.back().position < 1) bounds.push_back(std::min(b, 1.0));
      last = b;
    }
    if (stops.back().position < 1) seg(stops.back(), stops.back());
    if (fns.size() == 1) return fns[0];
    while (bounds.size() + 1 > fns.size()) bounds.pop_back();
    std::string f = "<< /FunctionType 3 /Domain [0 1] /Functions [";
    for (auto& x : fns) f += x + " ";
    f += "] /Bounds [";
    for (double b : bounds) f += n(b) + " ";
    f += "] /Encode [";
    for (size_t i = 0; i < fns.size(); i++) f += "0 1 ";
    return f + "] >>";
  }

  // Angular / diamond: a PostScript calculator function of (x, y) in the gradient's space.
  int calculatorFunction(const Paint& paint, bool gray, const double domain[4]) {
    std::string code = "{ ";
    if (paint.type == PaintType::GRADIENT_ANGULAR) code += "0.5 sub exch 0.5000001 sub atan 360 div ";
    else code += "0.5 sub abs exch 0.5 sub abs add 2 mul ";
    const auto& st = paint.stops;
    auto color = [&](const ColorStop& s) { return gray ? n(s.color.a) : rgb(s.color); };
    std::function<std::string(size_t)> seg = [&](size_t i) -> std::string {
      if (i + 1 >= st.size()) return "pop " + color(st.back());
      const ColorStop &a = st[i], &b = st[i + 1];
      double d = b.position - a.position;
      std::string interp;
      if (d <= 1e-9) {
        interp = "pop " + color(b);
      } else if (gray) {
        interp = n(a.position) + " sub " + n(d) + " div " + n(b.color.a - a.color.a) + " mul " + n(a.color.a) + " add";
      } else {
        interp = n(a.position) + " sub " + n(d) + " div dup " + n(b.color.r - a.color.r) + " mul " + n(a.color.r) + " add exch dup " +
                 n(b.color.g - a.color.g) + " mul " + n(a.color.g) + " add exch " + n(b.color.b - a.color.b) + " mul " + n(a.color.b) + " add";
      }
      return "dup " + n(b.position) + " le { " + interp + " } { " + seg(i + 1) + " } ifelse";
    };
    code += "dup " + n(st.front().position) + " le { pop " + color(st.front()) + " } { " + seg(0) + " } ifelse }";
    std::string dict = "/FunctionType 4 /Domain [" + n(domain[0]) + " " + n(domain[1]) + " " + n(domain[2]) + " " + n(domain[3]) + "] /Range [" +
                       (gray ? "0 1" : "0 1 0 1 0 1") + "]";
    return file_.add(File::stream(dict, code, false));
  }

  // A shading pattern for a gradient paint over `area` (export space; the function shading's domain covers it).
  std::string shadingPattern(const Paint& paint, Vec2 size, const Mat2x3& E, const Rect& area, bool gray) {
    Mat2x3 G = gradientMatrix(paint, size);
    Mat2x3 Gi = G.inverse();
    Mat2x3 P = F_ * E * Gi;
    std::string cs = gray ? "/DeviceGray" : "/DeviceRGB";
    std::string shading;
    if (paint.type == PaintType::GRADIENT_LINEAR) {
      shading = "<< /ShadingType 2 /ColorSpace " + cs + " /Coords [0 0.5 1 0.5] /Function " + rampFunction(paint.stops, gray) +
                " /Extend [true true] >>";
    } else if (paint.type == PaintType::GRADIENT_RADIAL) {
      shading = "<< /ShadingType 3 /ColorSpace " + cs + " /Coords [0.5 0.5 0 0.5 0.5 0.5] /Function " + rampFunction(paint.stops, gray) +
                " /Extend [true true] >>";
    } else {
      // The area in gradient space (where the function is evaluated).
      Mat2x3 toG = G * E.inverse();
      Rect g = transformedBounds(toG * Mat2x3::translate(area.x, area.y), area.w, area.h);
      double domain[4] = {g.x - 0.01, g.right() + 0.01, g.y - 0.01, g.bottom() + 0.01};
      int fn = calculatorFunction(paint, gray, domain);
      shading = "<< /ShadingType 1 /ColorSpace " + cs + " /Domain [" + n(domain[0]) + " " + n(domain[1]) + " " + n(domain[2]) + " " + n(domain[3]) +
                "] /Function " + ref(fn) + " >>";
    }
    std::string name = "P" + std::to_string(patterns_.size());
    patterns_.push_back({name, file_.add("<< /Type /Pattern /PatternType 2 /Shading " + shading + " /Matrix [" + matrixOps(P) + "] >>")});
    return name;
  }

  // A form XObject (a transparency group) holding `content`.
  int form(const std::string& content, bool gray = false) {
    return file_.add(File::stream("/Type /XObject /Subtype /Form /BBox [0 0 " + n(W_) + " " + n(H_) + "] /Group << /Type /Group /S /Transparency /CS " +
                                      (gray ? "/DeviceGray" : "/DeviceRGB") + " >> /Resources " + ref(resources_),
                                  content, true));
  }
  std::string xobject(int id) {
    std::string name = "X" + std::to_string(xobjects_.size());
    xobjects_.push_back({name, id});
    return name;
  }

  // An image paint's pixels as an image XObject (with its alpha as a soft mask), once per image.
  std::string imageObject(const ImageHash& hash, const ImageData& d) {
    std::string key = hash.hex();
    auto it = images_.find(key);
    if (it != images_.end()) return it->second;
    std::string name = imageXObject(d.width, d.height, d.jpeg, d.rgb, d.alpha);
    images_[key] = name;
    return name;
  }
  std::string imageXObject(uint32_t w, uint32_t h, const std::string& jpeg, const std::string& raw, const std::string& alpha) {
    std::string dict = "/Type /XObject /Subtype /Image /Width " + std::to_string(w) + " /Height " + std::to_string(h) +
                       " /ColorSpace /DeviceRGB /BitsPerComponent 8";
    if (!alpha.empty()) {
      int mask = file_.add(File::stream("/Type /XObject /Subtype /Image /Width " + std::to_string(w) + " /Height " + std::to_string(h) +
                                            " /ColorSpace /DeviceGray /BitsPerComponent 8",
                                        alpha, true));
      dict += " /SMask " + ref(mask);
    }
    int id = !jpeg.empty() ? file_.add(File::stream(dict + " /Filter /DCTDecode", jpeg, false)) : file_.add(File::stream(dict, raw, true));
    std::string name = "Im" + std::to_string(xobjects_.size());
    xobjects_.push_back({name, id});
    return name;
  }

  // ---- Paints ----

  // `p` (export space through E: node → export) filled with `paint` at `alpha`.
  void fillWith(std::string& o, const geom::Path& p, bool evenOdd, const Paint& paint, Vec2 size, const Mat2x3& E, double alpha) {
    if (p.empty() || !drawable(paint)) return;
    Mat2x3 M = F_ * E;
    double a = alpha * paint.opacity;
    const char* fill = evenOdd ? "f*\n" : "f\n";
    const char* clip = evenOdd ? "W* n\n" : "W n\n";
    if (paint.type == PaintType::SOLID) {
      a *= paint.color.a;
      o += "q\n";
      if (!plainState(a, paint.blendMode)) o += gs(a, 1, paint.blendMode);
      o += rgb(paint.color) + " rg\n";
      path(o, p, M);
      o += std::string(fill) + "Q\n";
      return;
    }
    if (paint.isGradient()) {
      if (paint.stops.empty() || gradientMatrix(paint, size).determinant() == 0) return;
      Rect area = p.transformed(E).bounds();
      std::string pat = shadingPattern(paint, size, E, area, false);
      bool stopAlpha = false;
      for (auto& s : paint.stops) stopAlpha |= s.color.a < 1;
      int smask = 0;
      if (stopAlpha) {
        // The stops' opacity: a luminosity soft mask of the same gradient in grey.
        std::string grey = shadingPattern(paint, size, E, area, true);
        std::string mc = "/Pattern cs /" + grey + " scn\n";
        path(mc, p, M);
        mc += fill;
        int g = form(mc, true);
        smask = file_.add("<< /Type /Mask /S /Luminosity /G " + ref(g) + " >>");
      }
      o += "q\n";
      if (!plainState(a, paint.blendMode) || smask) o += gs(a, 1, paint.blendMode, smask);
      o += "/Pattern cs /" + pat + " scn\n";
      path(o, p, M);
      o += std::string(fill) + "Q\n";
      return;
    }
    if (paint.type == PaintType::IMAGE) {
      const ImageData* d = paint.image.present ? ImageStore::get().find(paint.image) : nullptr;
      if (!d || (d->jpeg.empty() && d->rgb.empty()) || !d->width || !d->height) {
        fillWith(o, p, evenOdd, Paint::solid(Color::hex(0xE6E6E6), paint.opacity), size, E, alpha);
        return;
      }
      double iw = 0, ih = 0;
      imageSize(paint, d->width, d->height, iw, ih);
      Mat2x3 I = imageMatrix(paint, size, iw, ih);
      if (I.determinant() == 0) return;
      std::string im = imageObject(paint.image, *d);
      Mat2x3 uvToPdf = F_ * E * I.inverse();
      o += "q\n";
      if (!plainState(a, paint.blendMode)) o += gs(a, 1, paint.blendMode);
      path(o, p, M);
      o += clip;
      if (paint.imageScaleMode == ImageScaleMode::TILE) {
        int cell = file_.add(File::stream("/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 1 1] /XStep 1 /YStep 1 /Matrix [" +
                                              matrixOps(uvToPdf) + "] /Resources " + ref(resources_),
                                          "q 1 0 0 -1 0 1 cm /" + im + " Do Q\n", false));
        std::string name = "P" + std::to_string(patterns_.size());
        patterns_.push_back({name, cell});
        Rect b = p.transformed(M).bounds();
        o += "/Pattern cs /" + name + " scn\n" + n(b.x) + " " + n(b.y) + " " + n(b.w) + " " + n(b.h) + " re\nf\n";
      } else {
        Mat2x3 U{1, 0, 0, 0, -1, 1};  // the image's unit square (row 0 at the top) → uv
        o += matrixOps(uvToPdf * U) + " cm\n/" + im + " Do\n";
      }
      o += "Q\n";
    }
  }

  void stroke(std::string& o, const Stroke& st, const Shape& fill, Vec2 size, const Mat2x3& E, double alpha) {
    if (!st.present()) return;
    Mat2x3 M = F_ * E;
    double scale = std::sqrt(std::fabs(E.determinant()));
    double tol = 0.05 / std::max(scale, 1e-9);
    for (const Paint* paint : st.paints) {
      bool native = !st.outlineOnly && (paint->type == PaintType::SOLID || paint->type == PaintType::GRADIENT_LINEAR ||
                                        paint->type == PaintType::GRADIENT_RADIAL);
      if (!native) {
        fillWith(o, strokeArea(st, fill, tol), false, *paint, size, E, alpha);
        continue;
      }
      geom::Path center = st.center;
      double width = st.weight * (st.aligned ? 2 : 1) * scale;
      o += "q\n";
      double a = alpha * paint->opacity * (paint->type == PaintType::SOLID ? paint->color.a : 1);
      if (!plainState(a, paint->blendMode)) o += gs(1, a, paint->blendMode);
      if (st.aligned) {
        geom::Path f = st.primitive != Shape::Kind::Path ? st.center : fill.path();
        bool odd = st.primitive == Shape::Kind::Path && fill.evenOdd();
        if (st.align == StrokeAlign::INSIDE) {
          path(o, f, M);
          o += odd ? "W* n\n" : "W n\n";
        } else {
          Rect b = f.transformed(M).bounds();
          double g = width + 2;
          o += n(b.x - g) + " " + n(b.y - g) + " " + n(b.w + 2 * g) + " " + n(b.h + 2 * g) + " re\n";
          path(o, f, M);
          o += "W* n\n";
        }
      }
      o += n(width) + " w\n";
      o += std::string(st.cap == StrokeCap::ROUND ? "1" : st.cap == StrokeCap::SQUARE ? "2" : "0") + " J\n";
      o += std::string(st.join == StrokeJoin::ROUND ? "1" : st.join == StrokeJoin::BEVEL ? "2" : "0") + " j\n";
      if (st.join == StrokeJoin::MITER) o += n(std::max(1.0, st.miterLimit)) + " M\n";
      if (!st.dashes.empty()) {
        o += "[";
        for (double d : st.dashes) o += n(d * scale) + " ";
        o += "] 0 d\n";
      }
      if (paint->type == PaintType::SOLID) {
        o += rgb(paint->color) + " RG\n";
      } else {
        Rect area = center.transformed(E).bounds();
        area = {area.x - width, area.y - width, area.w + 2 * width, area.h + 2 * width};
        o += "/Pattern CS /" + shadingPattern(*paint, size, E, area, false) + " SCN\n";
      }
      path(o, center, M);
      o += "S\nQ\n";
    }
  }

  // ---- Text ----

  // The (font, code) of a glyph in the Type 3 fonts, made on first use.
  std::pair<size_t, int> glyphCode(const text::LaidGlyph& g, const std::u16string& unicode) {
    uint64_t key = (static_cast<uint64_t>(g.font ? g.font->id() : 0) << 32) | g.glyph;
    auto it = glyphs_.find(key);
    if (it != glyphs_.end()) return it->second;
    if (fonts_.empty() || fonts_.back().procs.size() >= 256) {
      Type3 f;
      f.obj = file_.alloc();
      f.name = "F" + std::to_string(fonts_.size());
      fonts_.push_back(std::move(f));
    }
    Type3& f = fonts_.back();
    int code = static_cast<int>(f.procs.size());
    // The glyph procedure: its outline in glyph space (1000 per em, y up), filled with the current colour (d1).
    std::string proc;
    double adv = g.font ? g.font->advance(g.glyph) * 1000 : 0;
    double bb[4] = {0, 0, 0, 0};
    std::string body;
    if (g.font) {
      const text::GlyphOutline& o = g.font->outline(g.glyph);
      bb[0] = o.bounds[0] * 1000, bb[1] = -o.bounds[3] * 1000, bb[2] = o.bounds[2] * 1000, bb[3] = -o.bounds[1] * 1000;
      geom::Path gp = glyphPath(text::LaidGlyph{g.font, g.glyph, 0, 0, 1, 0, 0, 0});
      if (!gp.empty()) {
        path(body, gp, Mat2x3{1000, 0, 0, 0, -1000, 0});
        body += "f\n";
      }
    }
    proc = n(adv) + " 0 " + n(bb[0]) + " " + n(bb[1]) + " " + n(bb[2]) + " " + n(bb[3]) + " d1\n" + body;
    f.procs.push_back(file_.add(File::stream("", proc, true)));
    f.widths.push_back(adv);
    f.unicode.push_back(unicode);
    if (code == 0) std::copy(bb, bb + 4, f.bbox);
    else {
      f.bbox[0] = std::min(f.bbox[0], bb[0]), f.bbox[1] = std::min(f.bbox[1], bb[1]);
      f.bbox[2] = std::max(f.bbox[2], bb[2]), f.bbox[3] = std::max(f.bbox[3], bb[3]);
    }
    auto r = std::make_pair(fonts_.size() - 1, code);
    glyphs_[key] = r;
    return r;
  }

  void writeFonts() {
    for (Type3& f : fonts_) {
      std::string procs, diffs, widths;
      for (size_t i = 0; i < f.procs.size(); i++) {
        procs += "/g" + std::to_string(i) + " " + ref(f.procs[i]) + " ";
        diffs += "/g" + std::to_string(i) + " ";
        widths += n(f.widths[i]) + " ";
      }
      // ToUnicode: what each code stands for (selecting and copying the text).
      std::string cmap =
          "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> "
          "def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n";
      std::vector<std::string> entries;
      for (size_t i = 0; i < f.unicode.size(); i++) {
        if (f.unicode[i].empty()) continue;
        char code[8];
        std::snprintf(code, sizeof code, "<%02X>", static_cast<unsigned>(i));
        std::string hex = "<";
        for (char16_t c : f.unicode[i]) {
          char u[8];
          std::snprintf(u, sizeof u, "%04X", static_cast<unsigned>(c));
          hex += u;
        }
        entries.push_back(std::string(code) + " " + hex + ">");
      }
      for (size_t i = 0; i < entries.size(); i += 100) {
        size_t end = std::min(entries.size(), i + 100);
        cmap += std::to_string(end - i) + " beginbfchar\n";
        for (size_t k = i; k < end; k++) cmap += entries[k] + "\n";
        cmap += "endbfchar\n";
      }
      cmap += "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
      int toUnicode = file_.add(File::stream("", cmap, true));
      file_.set(f.obj, "<< /Type /Font /Subtype /Type3 /FontBBox [" + n(f.bbox[0]) + " " + n(f.bbox[1]) + " " + n(f.bbox[2]) + " " + n(f.bbox[3]) +
                           "] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << " + procs + ">> /Encoding << /Type /Encoding /Differences [0 " + diffs +
                           "] >> /FirstChar 0 /LastChar " + std::to_string(f.procs.size() - 1) + " /Widths [" + widths + "] /Resources << >> /ToUnicode " +
                           ref(toUnicode) + " >>");
    }
  }

  void textNode(std::string& o, Guid id, const NodeProps& p, const Mat2x3& E, double alpha) {
    const text::TextLayout* L = texts_ ? texts_->textLayout(id) : nullptr;
    if (!L) return;
    // What each glyph stands for: its cluster's characters (up to the next cluster on its line).
    std::vector<std::u16string> unicode(L->glyphs.size());
    std::u16string_view text16(L->text);
    for (const text::LaidLine& line : L->lines) {
      for (uint32_t i = line.firstGlyph; i < line.firstGlyph + line.glyphCount; i++) {
        uint32_t from = L->glyphs[i].cluster, to = line.end;
        bool first = true;
        for (uint32_t j = line.firstGlyph; j < line.firstGlyph + line.glyphCount; j++) {
          uint32_t c = L->glyphs[j].cluster;
          if (c > from && c < to) to = c;
          if (c == from && j < i) first = false;
        }
        if (!first || from >= text16.size()) continue;
        to = std::min<uint32_t>(to, static_cast<uint32_t>(text16.size()));
        std::u16string s(text16.substr(from, to - from));
        while (!s.empty() && (s.back() == u'\n' || s.back() == u' ' || s.back() == u'\r')) s.pop_back();
        unicode[i] = text::applyCase(s, L->styles[L->glyphs[i].style].textCase);
      }
    }
    Mat2x3 M = F_ * E;
    size_t layers = 0;
    for (const auto& s : L->styles) layers = std::max(layers, s.fills ? s.fills->size() : 0);
    for (size_t f = 0; f < layers; f++) {
      const Paint* current = nullptr;
      std::string run;
      size_t font = SIZE_MAX;
      auto flush = [&]() {
        if (run.empty() || !current) return;
        double a = alpha * current->opacity * (current->type == PaintType::SOLID ? current->color.a : 1);
        o += "q\n";
        if (!plainState(a, current->blendMode)) o += gs(a, 1, current->blendMode);
        if (current->type == PaintType::SOLID) {
          o += rgb(current->color) + " rg\n";
        } else {
          Rect area = transformedBounds(E * Mat2x3::translate(L->inkBounds.x, L->inkBounds.y), L->inkBounds.w, L->inkBounds.h);
          o += "/Pattern cs /" + shadingPattern(*current, p.size, E, area, false) + " scn\n";
        }
        o += "BT\n" + run + "ET\nQ\n";
        run.clear();
        font = SIZE_MAX;
      };
      for (size_t i = 0; i < L->glyphs.size(); i++) {
        const text::LaidGlyph& g = L->glyphs[i];
        const auto* fills = L->styles[g.style].fills;
        if (!fills || f >= fills->size() || !drawable((*fills)[f])) continue;
        const Paint& paint = (*fills)[f];
        if (paint.type == PaintType::IMAGE || paint.type == PaintType::GRADIENT_ANGULAR || paint.type == PaintType::GRADIENT_DIAMOND) {
          // Images and CSS-only gradients: the glyph's outline as a path.
          flush();
          current = nullptr;
          fillWith(o, glyphPath(g), false, paint, p.size, E, alpha);
          continue;
        }
        if (!current || !(*current == paint)) {
          flush();
          current = &paint;
        }
        auto [fi, code] = glyphCode(g, unicode[i]);
        if (fi != font) {
          run += "/" + fonts_[fi].name + " 1 Tf\n";
          font = fi;
        }
        Mat2x3 T = M * Mat2x3{g.size, 0, g.x, 0, -g.size, g.y};
        char hex[8];
        std::snprintf(hex, sizeof hex, "<%02X>", static_cast<unsigned>(code));
        run += matrixOps(T) + " Tm " + hex + " Tj\n";
      }
      flush();
      for (const text::Decoration& d : L->decorations) {
        const auto* fills = L->styles[d.style].fills;
        if (!fills || f >= fills->size()) continue;
        geom::Path r = geom::rectPath({d.rect.w, d.rect.h}, CornerRadii{0, 0, 0, 0}).transformed(Mat2x3::translate(d.rect.x, d.rect.y));
        fillWith(o, r, false, (*fills)[f], p.size, E, alpha);
      }
    }
  }

  // ---- Layers ----

  void siblings(std::string& o, const std::vector<Drawn>& list, size_t from, double alpha) {
    for (size_t i = from; i < list.size(); i++) {
      const NodeProps& m = list[i].node->props;
      if (!m.mask) {
        node(o, list[i].id, alpha);
        continue;
      }
      // A mask over the siblings above it: a soft mask from the mask layer (alpha, luminance, or its outline).
      std::string mc;
      if (m.maskType == MaskType::OUTLINE) {
        Mat2x3 E = origin_ * doc_.worldTransform(list[i].id);
        Shape sh = fillShape(doc_, list[i].id, m);
        if (!sh.empty()) fillWith(mc, sh.path(), sh.evenOdd(), Paint::solid(Color{1, 1, 1, 1}), m.size, E, 1);
        if (m.fitsChildren()) siblings(mc, drawnChildren(doc_, list[i].id), 0, 1);
      } else {
        node(mc, list[i].id, 1);
      }
      int g = form(mc);
      int smask = file_.add(std::string("<< /Type /Mask /S /") + (m.maskType == MaskType::LUMINANCE ? "Luminosity" : "Alpha") + " /G " + ref(g) + " >>");
      std::string masked;
      siblings(masked, list, i + 1, 1);
      o += "q\n" + gs(alpha, alpha, BlendMode::NORMAL, smask) + "/" + xobject(form(masked)) + " Do\nQ\n";
      return;
    }
  }

  bool hasEffects(const NodeProps& p) const {
    for (const Effect& e : p.effects)
      if (e.visible && (e.isShadow() || ((e.type == EffectType::FOREGROUND_BLUR || e.type == EffectType::BACKGROUND_BLUR) && e.radius > 0)))
        return true;
    return false;
  }

  void node(std::string& o, Guid id, double alpha) {
    const Node* nd = doc_.get(id);
    if (!nd) return;
    const NodeProps& p = nd->props;
    if (!p.visible || p.opacity <= 0 || p.type == NodeType::SLICE) return;
    Mat2x3 E = origin_ * doc_.worldTransform(id);
    // Effects: PDF has no blur — the layer as an image the renderer draws (shadows and blurs included).
    if (hasEffects(p) && raster_) {
      Rect world = contentBounds(doc_, texts_, id);
      double scale = 2;
      double side = std::max(world.w, world.h) * scale;
      if (side > 4096) scale *= 4096 / side;
      int w = 0, h = 0;
      std::string rgba;
      if (world.w > 0 && world.h > 0 && raster_(id, world, scale, w, h, rgba) && w > 0 && h > 0 &&
          rgba.size() >= static_cast<size_t>(w) * h * 4) {
        std::string raw(static_cast<size_t>(w) * h * 3, '\0'), a(static_cast<size_t>(w) * h, '\0');
        bool opaque = true;
        for (size_t k = 0; k < static_cast<size_t>(w) * h; k++) {
          raw[k * 3] = rgba[k * 4], raw[k * 3 + 1] = rgba[k * 4 + 1], raw[k * 3 + 2] = rgba[k * 4 + 2];
          a[k] = rgba[k * 4 + 3];
          opaque &= static_cast<uint8_t>(a[k]) == 255;
        }
        std::string im = imageXObject(static_cast<uint32_t>(w), static_cast<uint32_t>(h), "", raw, opaque ? "" : a);
        Rect r{world.x - t_->bounds.x, world.y - t_->bounds.y, world.w, world.h};
        o += "q\n";
        if (!plainState(alpha, p.blendMode)) o += gs(alpha, alpha, p.blendMode);
        o += n(r.w) + " 0 0 " + n(r.h) + " " + n(r.x) + " " + n(H_ - r.y - r.h) + " cm\n/" + im + " Do\nQ\n";
        return;
      }
    }
    Shape sh = fillShape(doc_, id, p);
    Stroke st = strokeOf(doc_, id, p);
    bool container = drawsChildren(p) && !doc_.children(id).empty();
    size_t paints = 0;
    for (auto& f : p.fillPaints) paints += drawable(f) ? 1 : 0;
    paints += st.present() ? st.paints.size() : 0;
    bool blend = blendName(p.blendMode) != nullptr;
    bool group = blend || (p.opacity < 1 && (container || paints > 1 || p.type == NodeType::TEXT));
    double a = group ? 1 : alpha * p.opacity;
    std::string body;
    std::string& out = group ? body : o;
    if (p.type == NodeType::TEXT) {
      textNode(out, id, p, E, a);
      if (st.present()) {
        Shape glyphs;
        if (const NodeGeometry* g = doc_.geometry(id); g && !g->fills.empty()) {
          glyphs.kind = Shape::Kind::Path;
          glyphs.size = p.size;
          glyphs.regions = g->fills;
        }
        stroke(out, st, glyphs, p.size, E, a);
      }
    } else if (p.isGroupLike()) {
      siblings(out, drawnChildren(doc_, id), 0, a);
    } else {
      // Fills: per region when a vector's regions have their own fills.
      if (sh.kind == Shape::Kind::Path) {
        for (auto& r : sh.regions) {
          const VectorStyle* vs = r.styleID ? p.shape().vectorData.style(r.styleID) : nullptr;
          const std::vector<Paint>& fills = vs && (vs->mask & VS_FILLS) ? vs->fillPaints : p.fillPaints;
          for (const Paint& f : fills) fillWith(out, r.path, r.windingRule == WindingRule::ODD, f, p.size, E, a);
        }
      } else if (!sh.empty()) {
        geom::Path sp = sh.path();
        for (const Paint& f : p.fillPaints) fillWith(out, sp, false, f, p.size, E, a);
      }
      if (drawsChildren(p)) {
        std::vector<Drawn> kids = drawnChildren(doc_, id);
        if (!kids.empty()) {
          bool clips = p.clipsContent();
          if (clips) {
            out += "q\n";
            Shape c = sh;
            if (c.empty()) {
              c.kind = Shape::Kind::Rect;
              c.size = p.size;
            }
            path(out, c.path(), F_ * E);
            out += c.evenOdd() ? "W* n\n" : "W n\n";
          }
          siblings(out, kids, 0, a);
          if (clips) out += "Q\n";
        }
      }
      stroke(out, st, sh, p.size, E, a);
    }
    if (group && !body.empty()) {
      double ga = alpha * p.opacity;
      o += "q\n";
      if (!plainState(ga, p.blendMode)) o += gs(ga, ga, p.blendMode);
      o += "/" + xobject(form(body)) + " Do\nQ\n";
    }
  }

  const Document& doc_;
  TextLayouts* texts_;
  const Rasterize& raster_;
  File file_;
  int resources_ = 0;
  const Target* t_ = nullptr;
  double W_ = 0, H_ = 0;
  Mat2x3 origin_, F_;
  std::unordered_map<std::string, std::string> gsByKey_;
  std::vector<std::pair<std::string, int>> gsList_, patterns_, xobjects_;
  std::unordered_map<std::string, std::string> images_;
  std::vector<Type3> fonts_;
  std::unordered_map<uint64_t, std::pair<size_t, int>> glyphs_;
};

}  // namespace

std::string writePdf(const Document& doc, TextLayouts* texts, const std::vector<Target>& pages, const Settings& settings,
                     const Rasterize& rasterize) {
  (void)settings;  // PDF has no format options of its own (1x, contents as the targets say)
  if (pages.empty()) return {};
  Writer w(doc, texts, rasterize);
  return w.run(pages);
}

}  // namespace eng::exporter
