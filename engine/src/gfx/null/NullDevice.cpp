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
  draws.clear();
  lastPass = pass;
  passes++;
  return true;
}

void NullDevice::draw(const DrawCall& call) {
  const auto& b = buffers_.at(call.instances.buffer);
  Recorded r{call, pipelines_.at(call.pipeline), {}};
  r.instances.assign(b.begin() + call.instances.offset, b.begin() + call.instances.offset + call.instances.size);
  draws.push_back(std::move(r));
}

void NullDevice::destroyBuffer(BufferId buffer) { buffers_.at(buffer).clear(); }

}  // namespace eng::gfx
