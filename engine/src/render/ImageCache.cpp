#include "render/ImageCache.h"

#include <algorithm>
#include <cmath>

#include "schema/SchemaTable.h"

namespace eng {

// ---- ThumbHash ----------------------------------------------------------------------------------

bool decodeThumbHash(const uint8_t* hash, size_t len, ThumbImage& out) {
  if (!hash || len < 5) return false;
  const double PI = 3.14159265358979323846;
  uint32_t header24 = hash[0] | (hash[1] << 8) | (hash[2] << 16);
  uint32_t header16 = hash[3] | (hash[4] << 8);
  double lDc = (header24 & 63) / 63.0;
  double pDc = ((header24 >> 6) & 63) / 31.5 - 1;
  double qDc = ((header24 >> 12) & 63) / 31.5 - 1;
  double lScale = ((header24 >> 18) & 31) / 31.0;
  bool hasAlpha = (header24 >> 23) != 0;
  double pScale = ((header16 >> 3) & 63) / 63.0;
  double qScale = ((header16 >> 9) & 63) / 63.0;
  bool landscape = (header16 >> 15) != 0;
  int lx = std::max(3, landscape ? (hasAlpha ? 5 : 7) : static_cast<int>(header16 & 7));
  int ly = std::max(3, landscape ? static_cast<int>(header16 & 7) : (hasAlpha ? 5 : 7));
  if (hasAlpha && len < 6) return false;
  double aDc = hasAlpha ? (hash[5] & 15) / 15.0 : 1;
  double aScale = hasAlpha ? (hash[5] >> 4) / 15.0 : 0;
  size_t acStart = hasAlpha ? 6 : 5;
  size_t acIndex = 0;
  bool ok = true;
  auto channel = [&](int nx, int ny, double scale) {
    std::vector<double> ac;
    for (int cy = 0; cy < ny; cy++)
      for (int cx = cy ? 0 : 1; cx * ny < nx * (ny - cy); cx++) {
        size_t at = acStart + (acIndex >> 1);
        if (at >= len) {
          ok = false;
          ac.push_back(0);
        } else {
          ac.push_back((((hash[at] >> ((acIndex & 1) << 2)) & 15) / 7.5 - 1) * scale);
        }
        acIndex++;
      }
    return ac;
  };
  std::vector<double> lAc = channel(lx, ly, lScale);
  std::vector<double> pAc = channel(3, 3, pScale * 1.25);
  std::vector<double> qAc = channel(3, 3, qScale * 1.25);
  std::vector<double> aAc = hasAlpha ? channel(5, 5, aScale) : std::vector<double>();
  if (!ok) return false;
  // The approximate aspect ratio (thumbHashToApproximateAspectRatio).
  int rx = landscape ? (hasAlpha ? 5 : 7) : (hash[3] & 7);
  int ry = landscape ? (hash[3] & 7) : (hasAlpha ? 5 : 7);
  double ratio = ry ? static_cast<double>(rx) / ry : 1;
  uint32_t w = static_cast<uint32_t>(std::lround(ratio > 1 ? 32 : 32 * ratio));
  uint32_t h = static_cast<uint32_t>(std::lround(ratio > 1 ? 32 / ratio : 32));
  w = std::max(w, 1u), h = std::max(h, 1u);
  out.width = w;
  out.height = h;
  out.rgba.assign(static_cast<size_t>(w) * h * 4, 0);
  std::vector<double> fx(8), fy(8);
  for (uint32_t y = 0, i = 0; y < h; y++) {
    for (uint32_t x = 0; x < w; x++, i += 4) {
      double l = lDc, p = pDc, q = qDc, a = aDc;
      for (int cx = 0, n = std::max(lx, hasAlpha ? 5 : 3); cx < n; cx++) fx[static_cast<size_t>(cx)] = std::cos(PI / w * (x + 0.5) * cx);
      for (int cy = 0, n = std::max(ly, hasAlpha ? 5 : 3); cy < n; cy++) fy[static_cast<size_t>(cy)] = std::cos(PI / h * (y + 0.5) * cy);
      for (int cy = 0, j = 0; cy < ly; cy++) {
        double fy2 = fy[static_cast<size_t>(cy)] * 2;
        for (int cx = cy ? 0 : 1; cx * ly < lx * (ly - cy); cx++, j++) l += lAc[static_cast<size_t>(j)] * fx[static_cast<size_t>(cx)] * fy2;
      }
      for (int cy = 0, j = 0; cy < 3; cy++) {
        double fy2 = fy[static_cast<size_t>(cy)] * 2;
        for (int cx = cy ? 0 : 1; cx < 3 - cy; cx++, j++) {
          double f = fx[static_cast<size_t>(cx)] * fy2;
          p += pAc[static_cast<size_t>(j)] * f;
          q += qAc[static_cast<size_t>(j)] * f;
        }
      }
      if (hasAlpha)
        for (int cy = 0, j = 0; cy < 5; cy++) {
          double fy2 = fy[static_cast<size_t>(cy)] * 2;
          for (int cx = cy ? 0 : 1; cx < 5 - cy; cx++, j++) a += aAc[static_cast<size_t>(j)] * fx[static_cast<size_t>(cx)] * fy2;
        }
      double b = l - 2.0 / 3.0 * p;
      double r = (3 * l - b + q) / 2;
      double g = r - q;
      // As the reference decoder writes bytes (truncated), then premultiplied as the editor's port does.
      auto byte = [](double v) { return static_cast<uint32_t>(std::max(0.0, 255 * std::min(1.0, v))); };
      uint32_t R = byte(r), G = byte(g), B = byte(b), A = byte(a);
      if (A != 255) {
        R = (R * A + 127) / 255;
        G = (G * A + 127) / 255;
        B = (B * A + 127) / 255;
      }
      out.rgba[i] = static_cast<uint8_t>(R);
      out.rgba[i + 1] = static_cast<uint8_t>(G);
      out.rgba[i + 2] = static_cast<uint8_t>(B);
      out.rgba[i + 3] = static_cast<uint8_t>(A);
    }
  }
  return true;
}

ImageHints imageHints(const Paint& paint) {
  ImageHints h;
  h.originalWidth = paint.originalImageWidth;
  h.originalHeight = paint.originalImageHeight;
  if (paint.extra.empty()) return h;
  static const schema::Def* def = schema::SchemaTable::get().def("Paint");
  if (!def) return h;
  schema::SchemaTable::get().forEachField(*def, paint.extra, [&](const schema::FieldDef& f, std::string_view v) {
    kiwi::ByteBuffer bb(reinterpret_cast<const uint8_t*>(v.data()), v.size());
    if (f.value == 25) {  // thumbHash: byte[]
      uint32_t n = 0;
      if (!bb.readVarUint(n) || bb.index() + n > v.size()) return;
      h.thumbHash.assign(reinterpret_cast<const uint8_t*>(v.data()) + bb.index(), reinterpret_cast<const uint8_t*>(v.data()) + bb.index() + n);
    } else if (f.value == 9) {  // imageThumbnail: Image {hash = 1}
      for (;;) {
        uint32_t g = 0;
        if (!bb.readVarUint(g) || !g) return;
        if (g == 1) {
          uint32_t n = 0;
          if (!bb.readVarUint(n) || bb.index() + n > v.size()) return;
          if (n == 20) {
            std::copy_n(reinterpret_cast<const uint8_t*>(v.data()) + bb.index(), 20, h.thumbnail.bytes.begin());
            h.thumbnail.present = true;
          }
          return;
        }
        static const schema::Def* image = schema::SchemaTable::get().def("Image");
        const schema::FieldDef* fd = image ? image->byId(g) : nullptr;
        if (!fd || !schema::SchemaTable::get().skipValue(bb, *fd)) return;
      }
    }
  });
  return h;
}

ImageRegistry& ImageRegistry::get() {
  static ImageRegistry* registry = new ImageRegistry();
  return *registry;
}

const ImageRegistry::Source* ImageRegistry::find(const ImageHash& hash, double devicePx, const ImageHints* hints) {
  if (!hash.present) return nullptr;
  uint32_t want = devicePx > 0 ? static_cast<uint32_t>(std::min(devicePx, 1e6)) : 0;
  auto it = sources_.find(hash);
  auto asked = asked_.find(hash);
  if (it == sources_.end()) {
    if (asked == asked_.end()) {
      asked_.emplace(hash, want);
      requests_.push_back({hash, want, hints ? hints->thumbnail : ImageHash{}});
    }
    return nullptr;
  }
  // Drawn larger than what came (a tier, or a copy the editor downscaled): asked again, larger — never past the
  // original (when the paint knows it), never more than once per 25 %.
  const Source& s = it->second;
  if (!s.failed && want && asked != asked_.end()) {
    uint32_t have = std::max(s.width, s.height);
    uint32_t original = hints ? std::max(hints->originalWidth, hints->originalHeight) : 0;
    bool partial = original ? have < original : have <= 512;
    if (partial && want > have * 1.25 && want > asked->second * 1.25) {
      asked->second = want;
      requests_.push_back({hash, want, hints ? hints->thumbnail : ImageHash{}});
    }
  }
  return &s;
}

void ImageRegistry::addBitmap(const ImageHash& hash, uint32_t bitmapId, uint32_t width, uint32_t height) {
  // The larger copy is kept (a tier arriving after the full image changes nothing).
  if (auto it = sources_.find(hash); it != sources_.end() && !it->second.failed && std::max(it->second.width, it->second.height) > std::max(width, height))
    return;
  Source s;
  s.bitmapId = bitmapId;
  s.width = width;
  s.height = height;
  sources_[hash] = s;
  generation_++;
}

void ImageRegistry::addRgba(const ImageHash& hash, uint32_t width, uint32_t height, Bytes premultiplied) {
  if (auto it = sources_.find(hash); it != sources_.end() && !it->second.failed && std::max(it->second.width, it->second.height) > std::max(width, height))
    return;
  Source s;
  s.rgba = std::move(premultiplied);
  s.width = width;
  s.height = height;
  sources_[hash] = s;
  generation_++;
}

void ImageRegistry::fail(const ImageHash& hash) {
  Source s;
  s.failed = true;
  sources_[hash] = s;
  generation_++;
}

void ImageRegistry::forget(const ImageHash& hash) {
  sources_.erase(hash);
  asked_.erase(hash);
}

std::vector<ImageRegistry::Request> ImageRegistry::takeRequests() {
  std::vector<Request> out;
  out.swap(requests_);
  return out;
}

void ImageRegistry::clear() {
  sources_.clear();
  asked_.clear();
  requests_.clear();
  generation_++;
}

ImageCache::~ImageCache() {
  for (auto& [h, e] : textures_)
    if (e.texture.id) device_.destroyTexture(e.texture.id);
  for (auto& [h, t] : thumbs_)
    if (t.id) device_.destroyTexture(t.id);
}

ImageCache::Texture ImageCache::texture(const ImageHash& hash, bool* failed, double devicePx, const ImageHints* hints, bool* placeholder) {
  if (failed) *failed = false;
  if (placeholder) *placeholder = false;
  if (!hash.present) return {};
  const ImageRegistry::Source* src = ImageRegistry::get().find(hash, devicePx, hints);
  auto it = textures_.find(hash);
  if (it != textures_.end()) {
    // A larger copy arrived since: uploaded again.
    if (src && !src->failed && (src->width != it->second.texture.width || src->height != it->second.texture.height)) {
      bytes_ -= it->second.bytes;
      device_.destroyTexture(it->second.texture.id);
      textures_.erase(it);
    } else {
      it->second.lastFrame = frame_;
      return it->second.texture;
    }
  }
  if (!src) {
    // Loading: the paint's ThumbHash, decoded once.
    if (!hints || hints->thumbHash.empty()) return {};
    auto th = thumbs_.find(hash);
    if (th == thumbs_.end()) {
      Texture t;
      ThumbImage img;
      if (decodeThumbHash(hints->thumbHash.data(), hints->thumbHash.size(), img)) {
        gfx::TextureDesc d;
        d.format = gfx::TextureFormat::RGBA8;
        d.width = img.width;
        d.height = img.height;
        t.id = device_.createTexture(d);
        if (t.id) {
          device_.writeTexture(t.id, {0, 0, static_cast<int>(img.width), static_cast<int>(img.height)}, {img.rgba.data(), img.rgba.size()});
          t.width = img.width;
          t.height = img.height;
        }
      }
      th = thumbs_.emplace(hash, t).first;
    }
    if (th->second.id && placeholder) *placeholder = true;
    return th->second;
  }
  if (src->failed || !src->width || !src->height) {
    if (failed) *failed = true;
    return {};
  }
  gfx::TextureDesc d;
  d.format = gfx::TextureFormat::RGBA8;
  d.width = src->width;
  d.height = src->height;
  d.mipmaps = true;
  gfx::TextureId id = device_.createTexture(d);
  if (!id) return {};
  bool ok = false;
  if (src->bitmapId) ok = device_.uploadBitmap(id, src->bitmapId);
  else if (src->rgba && src->rgba->size() >= static_cast<size_t>(src->width) * src->height * 4) {
    device_.writeTexture(id, {0, 0, static_cast<int>(src->width), static_cast<int>(src->height)}, {src->rgba->data(), src->rgba->size()});
    ok = true;
  }
  if (!ok) {
    device_.destroyTexture(id);
    return {};
  }
  device_.generateMipmaps(id);
  Entry e;
  e.texture = {id, src->width, src->height};
  e.bytes = static_cast<uint64_t>(src->width) * src->height * 4 * 4 / 3;
  e.lastFrame = frame_;
  bytes_ += e.bytes;
  textures_[hash] = e;
  // The placeholder has done its work.
  if (auto th = thumbs_.find(hash); th != thumbs_.end()) {
    if (th->second.id) device_.destroyTexture(th->second.id);
    thumbs_.erase(th);
  }
  return e.texture;
}

void ImageCache::endFrame() {
  if (bytes_ > kBudgetBytes) {
    std::vector<std::pair<uint64_t, ImageHash>> old;
    for (auto& [h, e] : textures_)
      if (e.lastFrame < frame_) old.push_back({e.lastFrame, h});
    std::sort(old.begin(), old.end(), [](auto& a, auto& b) { return a.first < b.first; });
    for (auto& [f, h] : old) {
      if (bytes_ <= kBudgetBytes) break;
      auto it = textures_.find(h);
      bytes_ -= it->second.bytes;
      device_.destroyTexture(it->second.texture.id);
      textures_.erase(it);
    }
  }
  frame_++;
}

}  // namespace eng
