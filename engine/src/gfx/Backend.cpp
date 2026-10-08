#include "gfx/Backend.h"

#include "gfx/gl/GLDevice.h"
#include "gfx/wgpu/WGPUDevice.h"

namespace eng::gfx {

std::unique_ptr<Device> createCanvasDevice(const char* selector, Backend preferred) {
  if (preferred == Backend::WebGPU) {
    if (auto device = createWebGPUDevice(selector)) return device;
    // A canvas that took a WebGPU context can't take WebGL2 any more: createWebGL2Device fails then, and the
    // caller moves to a fresh canvas.
  }
  return createWebGL2Device(selector);
}

}  // namespace eng::gfx
