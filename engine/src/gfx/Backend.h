// Which GPU backend draws a canvas (wasm builds only), as Figma chooses (docs/research/figma/R10-webgpu.md):
// WebGPU when the browser has it and it isn't blocklisted — TypeScript decides that and requests the GPUDevice
// before the engine starts (src/renderer/src/engine/gfx.ts) — else WebGL2. A WebGPU device that fails mid-session
// (lost, or its self test fails) hands the session to WebGL2 on a fresh canvas (engine_gfx_switch).
#pragma once

#include <memory>

#include "gfx/Device.h"

namespace eng::gfx {

enum class Backend : uint8_t { WebGL2 = 0, WebGPU = 1 };

// A device for the canvas `selector`: `preferred` when it can be made, else the other one; nullptr when neither.
std::unique_ptr<Device> createCanvasDevice(const char* selector, Backend preferred);

}  // namespace eng::gfx
