#include "text/Fonts.h"

#include <hb-ot.h>
#include <hb.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>

#include "base/Sha1.h"

namespace eng::text {

// A parsed font file (one face of it).
class Face {
 public:
  Face(uint8_t* bytes, size_t length, uint32_t index) {
    blob_ = hb_blob_create(reinterpret_cast<const char*>(bytes), static_cast<unsigned>(length), HB_MEMORY_MODE_READONLY, bytes,
                           [](void* p) { std::free(p); });
    face_ = hb_face_create(blob_, index);
  }
  ~Face() {
    hb_face_destroy(face_);
    hb_blob_destroy(blob_);  // frees the bytes
  }
  Face(const Face&) = delete;
  Face& operator=(const Face&) = delete;
  hb_face_t* hb() const { return face_; }
  bool valid() const { return hb_face_get_glyph_count(face_) > 0; }
  // SHA-1 of the file's bytes, computed once (when derived text data is written or checked).
  const std::array<uint8_t, 20>& digest() {
    if (!hasDigest_) {
      unsigned len = 0;
      const char* data = hb_blob_get_data(blob_, &len);
      Sha1 h;
      h.update(data, len);
      digest_ = h.digest();
      hasDigest_ = true;
    }
    return digest_;
  }

 private:
  hb_blob_t* blob_ = nullptr;
  hb_face_t* face_ = nullptr;
  std::array<uint8_t, 20> digest_{};
  bool hasDigest_ = false;
};

// ---- Font -------------------------------------------------------------------------------

uint32_t Font::nextId_ = 1;

Font::Font(std::shared_ptr<Face> face, int namedInstance, std::vector<std::pair<uint32_t, float>> variations)
    : id_(nextId_++), face_(std::move(face)), variations_(variations) {
  // Two HarfBuzz fonts on the face: outlines and metrics at kHbScale, shaping in font units (its own font, not a
  // sub-font: a sub-font scales its parent's rounded positions and truncates them).
  upem_ = static_cast<int>(hb_face_get_upem(face_->hb()));
  auto make = [&](int scale) {
    hb_font_t* f = hb_font_create(face_->hb());
    hb_font_set_scale(f, scale, scale);
    if (namedInstance >= 0) hb_font_set_var_named_instance(f, static_cast<unsigned>(namedInstance));
    if (!variations.empty()) {
      std::vector<hb_variation_t> v;
      for (auto& [tag, value] : variations) v.push_back({tag, value});
      hb_font_set_variations(f, v.data(), static_cast<unsigned>(v.size()));
    }
    return f;
  };
  font_ = make(kHbScale);
  units_ = make(upem_);
  auto metric = [&](hb_ot_metrics_tag_t tag, double& out) {
    hb_position_t p = 0;
    if (hb_ot_metrics_get_position(font_, tag, &p)) out = static_cast<double>(p) / kHbScale;
    return out;
  };
  double asc = ascent, desc = -descent, gap = lineGap;
  metric(HB_OT_METRICS_TAG_HORIZONTAL_ASCENDER, asc);
  metric(HB_OT_METRICS_TAG_HORIZONTAL_DESCENDER, desc);
  metric(HB_OT_METRICS_TAG_HORIZONTAL_LINE_GAP, gap);
  ascent = asc;
  descent = -desc;
  lineGap = std::max(0.0, gap);
  double uo = -underlineOffset;
  metric(HB_OT_METRICS_TAG_UNDERLINE_OFFSET, uo);
  metric(HB_OT_METRICS_TAG_UNDERLINE_SIZE, underlineThickness);
  // HarfBuzz's underline offset is the line's centre in some fonts and its top in others (post.underlinePosition
  // is the top by spec); the top, below the baseline, as most renderers read it.
  underlineOffset = -uo;
  metric(HB_OT_METRICS_TAG_STRIKEOUT_OFFSET, strikeoutOffset);
  metric(HB_OT_METRICS_TAG_STRIKEOUT_SIZE, strikeoutThickness);
  metric(HB_OT_METRICS_TAG_CAP_HEIGHT, capHeight);
  if (underlineThickness <= 0) underlineThickness = 0.05;
  if (strikeoutThickness <= 0) strikeoutThickness = underlineThickness;
}

Font::Font() : id_(nextId_++) {}

Font::~Font() {
  if (units_) hb_font_destroy(units_);
  if (font_) hb_font_destroy(font_);
}

const std::array<uint8_t, 20>& Font::digest() const {
  static const std::array<uint8_t, 20> kNone{};
  return face_ ? face_->digest() : kNone;
}

uint32_t Font::glyphFor(uint32_t cp) const {
  hb_codepoint_t g = 0;
  return font_ && hb_font_get_nominal_glyph(font_, cp, &g) ? g : 0;
}

Font* Font::withVariations(const std::vector<std::pair<uint32_t, float>>& variations) {
  if (!face_ || variations.empty() || !hb_ot_var_has_data(face_->hb())) return this;
  // The instance's own coordinates, then the given ones (axes the font doesn't have are dropped).
  std::vector<std::pair<uint32_t, float>> merged;
  for (const AxisInfo& a : axes()) merged.push_back({a.tag, a.value});
  bool changed = false;
  for (auto& [tag, value] : variations)
    for (auto& m : merged)
      if (m.first == tag && m.second != value) {
        m.second = value;
        changed = true;
      }
  if (!changed) return this;
  std::string key;
  for (auto& [tag, value] : merged) key += std::to_string(tag) + "=" + std::to_string(value) + ";";
  std::unique_ptr<Font>& v = variants_[key];
  if (!v) v = std::make_unique<Font>(face_, -1, merged);
  return v.get();
}

std::vector<AxisInfo> Font::axes() const {
  std::vector<AxisInfo> out;
  if (!face_) return out;
  hb_face_t* hf = face_->hb();
  unsigned count = hb_ot_var_get_axis_count(hf);
  if (!count) return out;
  std::vector<hb_ot_var_axis_info_t> infos(count);
  unsigned n = count;
  hb_ot_var_get_axis_infos(hf, 0, &n, infos.data());
  unsigned coordsLen = 0;
  const float* coords = hb_font_get_var_coords_design(font_, &coordsLen);
  for (unsigned i = 0; i < n; i++) {
    AxisInfo a;
    a.tag = infos[i].tag;
    a.min = infos[i].min_value;
    a.def = infos[i].default_value;
    a.max = infos[i].max_value;
    a.value = coords && i < coordsLen ? coords[i] : a.def;
    a.hidden = (infos[i].flags & HB_OT_VAR_AXIS_FLAG_HIDDEN) != 0;
    char buf[128];
    unsigned len = sizeof buf;
    if (hb_ot_name_get_utf8(hf, infos[i].name_id, HB_LANGUAGE_INVALID, &len, buf) > 0)
      a.name.assign(buf, std::min<size_t>(len, sizeof buf - 1));
    out.push_back(std::move(a));
  }
  return out;
}

std::vector<FeatureInfo> Font::features() const {
  std::vector<FeatureInfo> out;
  if (!face_) return out;
  hb_face_t* hf = face_->hb();
  for (hb_tag_t table : {HB_OT_TAG_GSUB, HB_OT_TAG_GPOS}) {
    unsigned total = hb_ot_layout_table_get_feature_tags(hf, table, 0, nullptr, nullptr);
    std::vector<hb_tag_t> tags(total);
    unsigned n = total;
    hb_ot_layout_table_get_feature_tags(hf, table, 0, &n, tags.data());
    for (unsigned i = 0; i < n; i++) {
      bool seen = false;
      for (const FeatureInfo& f : out) seen |= f.tag == tags[i];
      if (seen) continue;
      FeatureInfo f;
      f.tag = tags[i];
      // Stylistic sets and character variants name themselves (the UI shows "Alternate digits", "Open four"…).
      unsigned index = 0;
      if (table == HB_OT_TAG_GSUB && hb_ot_layout_language_find_feature(hf, table, 0, HB_OT_LAYOUT_DEFAULT_LANGUAGE_INDEX, tags[i], &index)) {
        hb_ot_name_id_t label = HB_OT_NAME_ID_INVALID;
        if (hb_ot_layout_feature_get_name_ids(hf, table, index, &label, nullptr, nullptr, nullptr, nullptr) &&
            label != HB_OT_NAME_ID_INVALID) {
          char buf[128];
          unsigned len = sizeof buf;
          if (hb_ot_name_get_utf8(hf, label, HB_LANGUAGE_INVALID, &len, buf) > 0) f.name.assign(buf, std::min<size_t>(len, sizeof buf - 1));
        }
      }
      out.push_back(std::move(f));
    }
  }
  return out;
}

bool Font::hasFeature(uint32_t tag) const {
  for (const FeatureInfo& f : features())
    if (f.tag == tag) return true;
  return false;
}

double Font::advance(uint32_t glyph) const {
  return font_ ? static_cast<double>(hb_font_get_glyph_h_advance(font_, glyph)) / kHbScale : 0;
}

namespace {

struct OutlineBuilder {
  GlyphOutline* out;
  float sx = 0, sy = 0;  // the contour's start
  float cx = 0, cy = 0;  // the current point
  bool open = false;
  static constexpr float kScale = 1.0f / kHbScale;

  void quad(float x0, float y0, float x1, float y1, float x2, float y2) {
    float c[6] = {x0 * kScale, -y0 * kScale, x1 * kScale, -y1 * kScale, x2 * kScale, -y2 * kScale};
    out->curves.insert(out->curves.end(), c, c + 6);
  }
  void line(float x, float y) {
    if (x == cx && y == cy) return;
    quad(cx, cy, (cx + x) / 2, (cy + y) / 2, x, y);
    cx = x, cy = y;
  }
  void close() {
    if (open && (cx != sx || cy != sy)) line(sx, sy);
    open = false;
  }
};

OutlineBuilder* builder(void* data) { return static_cast<OutlineBuilder*>(data); }

hb_draw_funcs_t* drawFuncs() {
  static hb_draw_funcs_t* funcs = [] {
    hb_draw_funcs_t* f = hb_draw_funcs_create();
    hb_draw_funcs_set_move_to_func(
        f,
        [](hb_draw_funcs_t*, void* d, hb_draw_state_t*, float x, float y, void*) {
          auto* b = builder(d);
          b->close();
          b->sx = b->cx = x;
          b->sy = b->cy = y;
          b->open = true;
        },
        nullptr, nullptr);
    hb_draw_funcs_set_line_to_func(
        f, [](hb_draw_funcs_t*, void* d, hb_draw_state_t*, float x, float y, void*) { builder(d)->line(x, y); }, nullptr, nullptr);
    hb_draw_funcs_set_quadratic_to_func(
        f,
        [](hb_draw_funcs_t*, void* d, hb_draw_state_t*, float qx, float qy, float x, float y, void*) {
          auto* b = builder(d);
          b->quad(b->cx, b->cy, qx, qy, x, y);
          b->cx = x, b->cy = y;
        },
        nullptr, nullptr);
    hb_draw_funcs_set_cubic_to_func(
        f,
        [](hb_draw_funcs_t*, void* d, hb_draw_state_t*, float c1x, float c1y, float c2x, float c2y, float x, float y, void*) {
          auto* b = builder(d);
          // Split into n quadratics; the error of each shrinks with n³.
          float x0 = b->cx, y0 = b->cy;
          float ex = x - 3 * c2x + 3 * c1x - x0, ey = y - 3 * c2y + 3 * c1y - y0;
          float err = std::sqrt(ex * ex + ey * ey) * 0.0481125f;  // √3/36
          float tol = kHbScale * 0.0004f;
          int n = std::clamp(static_cast<int>(std::ceil(std::cbrt(err / tol))), 1, 16);
          auto at = [&](float t, float& px, float& py) {
            float u = 1 - t;
            px = u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x;
            py = u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y;
          };
          auto deriv = [&](float t, float& dx, float& dy) {
            float u = 1 - t;
            dx = 3 * (u * u * (c1x - x0) + 2 * u * t * (c2x - c1x) + t * t * (x - c2x));
            dy = 3 * (u * u * (c1y - y0) + 2 * u * t * (c2y - c1y) + t * t * (y - c2y));
          };
          for (int i = 0; i < n; i++) {
            float t0 = static_cast<float>(i) / n, t1 = static_cast<float>(i + 1) / n, h = t1 - t0;
            float ax, ay, bx, by, d0x, d0y, d1x, d1y;
            at(t0, ax, ay);
            at(t1, bx, by);
            deriv(t0, d0x, d0y);
            deriv(t1, d1x, d1y);
            // The piece's cubic controls, then the quadratic control that best matches them.
            float q1x = ax + d0x * h / 3, q1y = ay + d0y * h / 3, q2x = bx - d1x * h / 3, q2y = by - d1y * h / 3;
            float qx = (3 * (q1x + q2x) - ax - bx) / 4, qy = (3 * (q1y + q2y) - ay - by) / 4;
            b->quad(ax, ay, qx, qy, bx, by);
          }
          b->cx = x, b->cy = y;
        },
        nullptr, nullptr);
    hb_draw_funcs_set_close_path_func(f, [](hb_draw_funcs_t*, void* d, hb_draw_state_t*, void*) { builder(d)->close(); }, nullptr,
                                      nullptr);
    hb_draw_funcs_make_immutable(f);
    return f;
  }();
  return funcs;
}

}  // namespace

const GlyphOutline& Font::outline(uint32_t glyph) {
  auto it = outlines_.find(glyph);
  if (it != outlines_.end()) return it->second;
  GlyphOutline& o = outlines_[glyph];
  if (!font_) return o;  // an outline-only font: what it was given
  OutlineBuilder b{&o};
  hb_font_draw_glyph(font_, glyph, drawFuncs(), &b);
  b.close();
  if (!o.curves.empty()) {
    float x0 = o.curves[0], y0 = o.curves[1], x1 = x0, y1 = y0;
    for (size_t i = 0; i < o.curves.size(); i += 2) {
      x0 = std::min(x0, o.curves[i]);
      x1 = std::max(x1, o.curves[i]);
      y0 = std::min(y0, o.curves[i + 1]);
      y1 = std::max(y1, o.curves[i + 1]);
    }
    o.bounds[0] = x0, o.bounds[1] = y0, o.bounds[2] = x1, o.bounds[3] = y1;
  }
  return o;
}

// ---- Style names ------------------------------------------------------------------------

std::string normalizeStyle(const std::string& style) {
  std::string out;
  for (char c : style) {
    if (c == ' ' || c == '-' || c == '_') continue;
    out += static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c);
  }
  return out;
}

void styleWeight(const std::string& style, int& weight, bool& italic) {
  std::string s = normalizeStyle(style);
  italic = s.find("italic") != std::string::npos || s.find("oblique") != std::string::npos;
  weight = 400;
  struct W {
    const char* name;
    int weight;
  };
  // Longest names first ("extrabold" before "bold").
  static constexpr W kWeights[] = {{"extralight", 200}, {"ultralight", 200}, {"semibold", 600}, {"demibold", 600},
                                   {"extrabold", 800},  {"ultrabold", 800},  {"hairline", 100}, {"thin", 100},
                                   {"light", 300},      {"medium", 500},     {"bold", 700},     {"heavy", 900},
                                   {"black", 900},      {"book", 400},       {"regular", 400}};
  for (const W& w : kWeights)
    if (s.find(w.name) != std::string::npos) {
      weight = w.weight;
      return;
    }
}

// ---- Registry ---------------------------------------------------------------------------

FontRegistry& FontRegistry::get() {
  static FontRegistry* r = new FontRegistry();
  return *r;
}

std::string FontRegistry::keyOf(const std::string& family, const std::string& style) { return family + "\n" + normalizeStyle(style); }

int32_t FontRegistry::addFace(uint8_t* bytes, size_t length, uint32_t index) {
  if (!bytes || !length) {
    std::free(bytes);
    return -1;
  }
  auto face = std::make_shared<Face>(bytes, length, index);
  if (!face->valid()) return -1;
  faces_.push_back(std::move(face));
  return static_cast<int32_t>(faces_.size() - 1);
}

bool FontRegistry::bind(const std::string& family, const std::string& style, int32_t faceId) {
  if (faceId < 0 || static_cast<size_t>(faceId) >= faces_.size()) return false;
  const std::shared_ptr<Face>& face = faces_[static_cast<size_t>(faceId)];
  hb_face_t* hf = face->hb();
  int instance = -1;
  std::vector<std::pair<uint32_t, float>> variations;
  std::string want = normalizeStyle(style);
  unsigned count = hb_ot_var_get_named_instance_count(hf);
  for (unsigned i = 0; i < count && instance < 0; i++) {
    hb_ot_name_id_t nameId = hb_ot_var_named_instance_get_subfamily_name_id(hf, i);
    char buf[128];
    unsigned len = sizeof buf;
    if (hb_ot_name_get_utf8(hf, nameId, HB_LANGUAGE_INVALID, &len, buf) == 0) continue;
    if (normalizeStyle(std::string(buf, std::min<size_t>(len, sizeof buf - 1))) == want) instance = static_cast<int>(i);
  }
  if (instance < 0 && hb_ot_var_has_data(hf)) {
    int weight = 400;
    bool italic = false;
    styleWeight(style, weight, italic);
    hb_ot_var_axis_info_t axis;
    if (hb_ot_var_find_axis_info(hf, HB_TAG('w', 'g', 'h', 't'), &axis))
      variations.push_back({HB_TAG('w', 'g', 'h', 't'), std::clamp(static_cast<float>(weight), axis.min_value, axis.max_value)});
    if (italic && hb_ot_var_find_axis_info(hf, HB_TAG('i', 't', 'a', 'l'), &axis))
      variations.push_back({HB_TAG('i', 't', 'a', 'l'), axis.max_value});
    else if (italic && hb_ot_var_find_axis_info(hf, HB_TAG('s', 'l', 'n', 't'), &axis))
      variations.push_back({HB_TAG('s', 'l', 'n', 't'), axis.min_value});
  }
  Entry& e = entries_[keyOf(family, style)];
  e.state = State::Ready;
  e.font = std::make_unique<Font>(face, instance, std::move(variations));
  generation_++;
  return true;
}

void FontRegistry::markMissing(const std::string& family, const std::string& style) {
  Entry& e = entries_[keyOf(family, style)];
  if (e.state == State::Ready) return;
  e.state = State::Missing;
  generation_++;
}

void FontRegistry::setFallbacks(std::vector<std::string> families) {
  fallbacks_ = std::move(families);
  generation_++;
}

FontRegistry::State FontRegistry::state(const FontName& name) const {
  auto it = entries_.find(keyOf(name.family, name.style));
  return it == entries_.end() ? State::Unknown : it->second.state;
}

Font* FontRegistry::find(const FontName& name, State* state) {
  Entry& e = entries_[keyOf(name.family, name.style)];
  if (e.state == State::Unknown) {
    e.state = State::Requested;
    requests_.push_back({name.family, name.style, name.postscript});
  }
  if (state) *state = e.state;
  return e.state == State::Ready ? e.font.get() : nullptr;
}

Font* FontRegistry::defaultFont() { return find(FontName{"Inter", "Regular", ""}); }

Font* FontRegistry::fallbackFor(uint32_t cp) {
  for (const std::string& family : fallbacks_) {
    State s;
    Font* f = find(FontName{family, "Regular", ""}, &s);
    if (s == State::Requested) return nullptr;  // wait for it before trying the next one
    if (f && f->covers(cp)) return f;
  }
  return nullptr;
}

std::vector<FontName> FontRegistry::takeRequests() {
  std::vector<FontName> out;
  out.swap(requests_);
  return out;
}

void FontRegistry::reset() {
  entries_.clear();
  faces_.clear();
  requests_.clear();
  fallbacks_.clear();
  generation_++;
}

}  // namespace eng::text
