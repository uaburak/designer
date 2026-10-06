// Images (docs/engine.md §6.6). Decoding is the browser's: TypeScript answers
// REQUEST_IMAGE {hash} by decoding the file with createImageBitmap (premultiplied)
// and handing the bitmap over (engine_image_add_bitmap; the GL backend uploads it
// with texImage2D(ImageBitmap), no pixels through Wasm memory), or raw RGBA
// (engine_image_add_rgba: Node, tests). The registry is module-wide, like the
// fonts; each renderer keeps its own GPU textures (mipmapped), within a budget,
// least recently drawn first out — an evicted image is uploaded again from the
// registry when it is drawn again.
#pragma once

#include <cstdint>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "gfx/Device.h"
#include "scene/Node.h"

namespace eng {

struct ImageHashKey {
  size_t operator()(const ImageHash& h) const noexcept {
    uint64_t v = 0;
    for (int i = 0; i < 8; i++) v = (v << 8) | h.bytes[static_cast<size_t>(i)];
    return std::hash<uint64_t>()(v);
  }
};

class ImageRegistry {
 public:
  struct Source {
    uint32_t bitmapId = 0;  // a JavaScript ImageBitmap (Module.engineBitmaps)
    Bytes rgba;             // or premultiplied RGBA8 pixels
    uint32_t width = 0, height = 0;
    bool failed = false;
  };

  static ImageRegistry& get();
  // The image's pixels, once they arrived; nullptr before (and a REQUEST_IMAGE is queued, once).
  const Source* find(const ImageHash& hash);
  void addBitmap(const ImageHash& hash, uint32_t bitmapId, uint32_t width, uint32_t height);
  void addRgba(const ImageHash& hash, uint32_t width, uint32_t height, Bytes premultiplied);
  void fail(const ImageHash& hash);
  // Asks for an image again (its texture was evicted and its source dropped).
  void forget(const ImageHash& hash);
  bool hasRequests() const { return !requests_.empty(); }
  std::vector<ImageHash> takeRequests();
  // Bumps whenever an image arrives or fails (engines draw again).
  uint32_t generation() const { return generation_; }
  void clear();

 private:
  std::unordered_map<ImageHash, Source, ImageHashKey> sources_;
  std::unordered_set<ImageHash, ImageHashKey> asked_;
  std::vector<ImageHash> requests_;
  uint32_t generation_ = 0;
};

class ImageCache {
 public:
  static constexpr uint64_t kBudgetBytes = 512ull << 20;

  explicit ImageCache(gfx::Device& device) : device_(device) {}
  ~ImageCache();
  ImageCache(const ImageCache&) = delete;
  ImageCache& operator=(const ImageCache&) = delete;

  struct Texture {
    gfx::TextureId id = 0;
    uint32_t width = 0, height = 0;
  };
  // The image's texture for this frame (uploaded on first use); id 0 while it loads or when it failed.
  Texture texture(const ImageHash& hash, bool* failed = nullptr);
  // After a frame: past the budget, textures not drawn in it are freed, oldest first.
  void endFrame();
  uint64_t bytes() const { return bytes_; }
  size_t count() const { return textures_.size(); }

 private:
  struct Entry {
    Texture texture;
    uint64_t bytes = 0;
    uint64_t lastFrame = 0;
  };
  gfx::Device& device_;
  std::unordered_map<ImageHash, Entry, ImageHashKey> textures_;
  uint64_t bytes_ = 0;
  uint64_t frame_ = 1;
};

}  // namespace eng
