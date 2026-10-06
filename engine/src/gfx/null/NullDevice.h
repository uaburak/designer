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
  void submit() override {}
  void destroyBuffer(BufferId buffer) override;

  std::vector<Recorded> draws;  // this frame's
  PassDesc lastPass;
  int passes = 0;

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
};

}  // namespace eng::gfx
