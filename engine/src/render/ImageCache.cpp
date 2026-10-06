#include "render/ImageCache.h"

#include <algorithm>

namespace eng {

ImageRegistry& ImageRegistry::get() {
  static ImageRegistry* registry = new ImageRegistry();
  return *registry;
}

const ImageRegistry::Source* ImageRegistry::find(const ImageHash& hash) {
  if (!hash.present) return nullptr;
  auto it = sources_.find(hash);
  if (it != sources_.end()) return &it->second;
  if (asked_.insert(hash).second) requests_.push_back(hash);
  return nullptr;
}

void ImageRegistry::addBitmap(const ImageHash& hash, uint32_t bitmapId, uint32_t width, uint32_t height) {
  Source s;
  s.bitmapId = bitmapId;
  s.width = width;
  s.height = height;
  sources_[hash] = s;
  generation_++;
}

void ImageRegistry::addRgba(const ImageHash& hash, uint32_t width, uint32_t height, Bytes premultiplied) {
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

std::vector<ImageHash> ImageRegistry::takeRequests() {
  std::vector<ImageHash> out;
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
}

ImageCache::Texture ImageCache::texture(const ImageHash& hash, bool* failed) {
  if (failed) *failed = false;
  if (!hash.present) return {};
  auto it = textures_.find(hash);
  if (it != textures_.end()) {
    it->second.lastFrame = frame_;
    return it->second.texture;
  }
  const ImageRegistry::Source* src = ImageRegistry::get().find(hash);
  if (!src) return {};
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
