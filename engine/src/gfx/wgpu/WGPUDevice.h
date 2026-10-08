// The WebGPU backend of gfx::Device (wasm builds only; emdawnwebgpu's webgpu.h over the browser's WebGPU).
#pragma once

#include <memory>

#include "gfx/Device.h"

namespace eng::gfx {

// True when TypeScript requested a GPUDevice for the engine (Module.engineGpuDevice): WebGPU is available and
// not blocklisted (src/renderer/src/engine/gfx.ts).
bool webGPUOffered();

// A device drawing into the canvas `selector` names with the offered GPUDevice, or nullptr when there is none or the
// canvas can't take a WebGPU context.
std::unique_ptr<Device> createWebGPUDevice(const char* selector);

}  // namespace eng::gfx
