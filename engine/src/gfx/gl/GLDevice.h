// The WebGL2 backend of gfx::Device (wasm builds only).
#pragma once

#include <memory>

#include "gfx/Device.h"

namespace eng::gfx {

// A device drawing into the canvas `selector` names (e.g. "#engine-canvas"), or
// nullptr when WebGL2 isn't available.
std::unique_ptr<Device> createWebGL2Device(const char* selector);

}  // namespace eng::gfx
