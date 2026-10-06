#include "gfx/null/NullDevice.h"

#include <algorithm>

namespace eng::gfx {

BufferId NullDevice::createBuffer(BufferKind, uint32_t bytes, Usage) {
  buffers_.emplace_back(bytes);
  return static_cast<BufferId>(buffers_.size() - 1);
}

void NullDevice::reserve(BufferId buffer, uint32_t bytes) {
  if (buffers_.at(buffer).size() < bytes) buffers_[buffer].assign(bytes, 0);
}

void NullDevice::write(BufferId buffer, uint32_t offset, std::span<const uint8_t> data) {
  auto& b = buffers_.at(buffer);
  if (b.size() < offset + data.size()) b.resize(offset + data.size());
  std::copy(data.begin(), data.end(), b.begin() + offset);
}

PipelineId NullDevice::createPipeline(const PipelineDesc& desc) {
  pipelines_.push_back(desc);
  return static_cast<PipelineId>(pipelines_.size() - 1);
}

bool NullDevice::beginPass(const PassDesc& pass) {
  if (pass.target && (pass.target >= targets_.size() || !targets_[pass.target].live)) return false;
  if (submitted_) {
    draws.clear();
    submitted_ = false;
  }
  lastPass = pass;
  passes++;
  if (pass.target)
    for (int i = 0; i < 4; i++) targets_[pass.target].clear[i] = pass.clear[i];
  return true;
}

TargetId NullDevice::createTarget(uint32_t width, uint32_t height) {
  if (!width || !height) return 0;
  TextureId tex = createTexture(TextureFormat::RGBA8, width, height);
  targets_.push_back({width, height, {0, 0, 0, 0}, true, tex});
  return static_cast<TargetId>(targets_.size() - 1);
}

TextureId NullDevice::targetTexture(TargetId target) { return target && target < targets_.size() ? targets_[target].texture : 0; }

void NullDevice::destroyTarget(TargetId target) {
  if (target && target < targets_.size()) {
    targets_[target].live = false;
    destroyTexture(targets_[target].texture);
  }
}

bool NullDevice::readPixels(TargetId target, IRect rect, std::span<uint8_t> rgba8) {
  if (!target || target >= targets_.size() || !targets_[target].live) return false;
  if (rgba8.size() < static_cast<size_t>(rect.w) * rect.h * 4) return false;
  const Target& t = targets_[target];
  for (size_t i = 0; i + 3 < rgba8.size(); i += 4)
    for (int c = 0; c < 4; c++) rgba8[i + c] = static_cast<uint8_t>(t.clear[c] * 255 + 0.5f);
  return true;
}

void NullDevice::draw(const DrawCall& call) {
  Recorded r{call, pipelines_.at(call.pipeline), {}};
  if (call.instances.buffer) {
    const auto& b = buffers_.at(call.instances.buffer);
    r.instances.assign(b.begin() + call.instances.offset, b.begin() + call.instances.offset + call.instances.size);
  }
  draws.push_back(std::move(r));
}

TextureId NullDevice::createTexture(const TextureDesc& desc) {
  if (!desc.width || !desc.height) return 0;
  Texture t;
  t.format = desc.format;
  t.width = desc.width;
  t.height = desc.height;
  // Float data is kept (tests read the curves back); colour textures only by size.
  if (desc.format == TextureFormat::RGBA32F) t.bytes.assign(static_cast<size_t>(desc.width) * desc.height * 16, 0);
  t.live = true;
  textures_.push_back(std::move(t));
  return static_cast<TextureId>(textures_.size() - 1);
}

void NullDevice::writeTexture(TextureId id, IRect rect, std::span<const uint8_t> data) {
  Texture& t = textures_.at(id);
  if (t.format != TextureFormat::RGBA32F) return;
  const size_t texel = 16, row = static_cast<size_t>(rect.w) * texel;
  for (int y = 0; y < rect.h; y++) {
    size_t dst = (static_cast<size_t>(rect.y + y) * t.width + static_cast<size_t>(rect.x)) * texel;
    if (dst + row > t.bytes.size() || static_cast<size_t>(y + 1) * row > data.size()) return;
    std::copy(data.begin() + static_cast<long>(static_cast<size_t>(y) * row), data.begin() + static_cast<long>(static_cast<size_t>(y + 1) * row),
              t.bytes.begin() + static_cast<long>(dst));
  }
}

void NullDevice::destroyTexture(TextureId id) {
  if (id && id < textures_.size()) textures_[id] = Texture{};
}

void NullDevice::destroyBuffer(BufferId buffer) { buffers_.at(buffer).clear(); }

}  // namespace eng::gfx
