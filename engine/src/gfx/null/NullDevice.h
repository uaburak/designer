// A Device that draws nothing and records everything: the native tests assert
// batching, clipping and instance data with it (docs/engine.md §11.1).
#pragma once

#include <cstring>
#include <vector>

#include "gfx/Device.h"

namespace eng::gfx {

class NullDevice final : public Device {
 public:
  struct Recorded {
    DrawCall call;
    PipelineDesc pipeline;
    std::vector<uint8_t> instances;  // the bytes of call.instances at draw time
  };

  Caps caps() const override { return {}; }
  BufferId createBuffer(BufferKind kind, uint32_t bytes, Usage usage) override;
  void reserve(BufferId buffer, uint32_t bytes) override;
  void write(BufferId buffer, uint32_t offset, std::span<const uint8_t> data) override;
  PipelineId createPipeline(const PipelineDesc& desc) override;
  bool beginPass(const PassDesc& pass) override;
  void draw(const DrawCall& call) override;
  void endPass() override {}
  // The frame's draws stay in `draws` until the next frame's first pass.
  void submit() override { submitted_ = true; }
  void destroyBuffer(BufferId buffer) override;
  // Targets record their size and the last pass's clear colour; readback returns that colour.
  TargetId createTarget(uint32_t width, uint32_t height) override;
  void destroyTarget(TargetId target) override;
  bool readPixels(TargetId target, IRect rect, std::span<uint8_t> rgba8) override;
  TextureId targetTexture(TargetId target) override;
  void copyToTexture(TextureId, IRect) override { copies++; }
  // Textures keep their bytes (tests read them back).
  TextureId createTexture(const TextureDesc& desc) override;
  using Device::createTexture;
  void writeTexture(TextureId texture, IRect rect, std::span<const uint8_t> data) override;
  void generateMipmaps(TextureId) override {}
  bool uploadBitmap(TextureId, uint32_t) override { return false; }
  void destroyTexture(TextureId texture) override;
  struct Texture {
    TextureFormat format = TextureFormat::RGBA32F;
    uint32_t width = 0, height = 0;
    std::vector<uint8_t> bytes;
    bool live = false;
  };
  const Texture& texture(TextureId id) const { return textures_.at(id); }

  std::vector<Recorded> draws;  // this frame's (every pass)
  PassDesc lastPass;            // the last pass begun (the canvas pass comes last)
  int passes = 0;
  int copies = 0;

  // The instances of draw `i` as T (e.g. ShapeInstance).
  template <typename T>
  std::vector<T> instancesOf(size_t i) const {
    const auto& bytes = draws.at(i).instances;
    std::vector<T> out(bytes.size() / sizeof(T));
    for (size_t k = 0; k < out.size(); k++) std::memcpy(&out[k], bytes.data() + k * sizeof(T), sizeof(T));
    return out;
  }

 private:
  std::vector<std::vector<uint8_t>> buffers_{{}};  // index = BufferId; 0 unused
  std::vector<PipelineDesc> pipelines_{{}};
  struct Target {
    uint32_t width = 0, height = 0;
    float clear[4] = {0, 0, 0, 0};
    bool live = false;
    TextureId texture = 0;
  };
  std::vector<Target> targets_{{}};  // index = TargetId; 0 = the default framebuffer
  std::vector<Texture> textures_{{}};  // index = TextureId; 0 unused
  bool submitted_ = true;

 public:
  size_t liveTargets() const {
    size_t n = 0;
    for (auto& t : targets_) n += t.live ? 1 : 0;
    return n;
  }
};

}  // namespace eng::gfx
