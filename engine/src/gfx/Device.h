// The graphics interface between the renderer and a GPU backend
// (docs/engine.md §6.1): resources by id and explicit-argument draws, no
// global bound state above the backend — the move Figma made before WebGPU.
// WebGL2 implements it today (gfx/gl), the native tests use a recording device
// (gfx/null), a WebGPU backend comes later (E9).
//
// Interim (E1) subset of §6.1: buffers, pipelines over the built-in shaders,
// one pass on the default framebuffer, small inline uniforms. Textures,
// targets, MSAA resolve and readback come with E3/E5.
#pragma once

#include <cstdint>
#include <span>

namespace eng::gfx {

using BufferId = uint32_t;    // 0 = none
using PipelineId = uint32_t;  // 0 = none

enum class BufferKind : uint8_t { Vertex, Instance, Index, Uniform };
enum class Usage : uint8_t { Static, Dynamic, Stream };

// The built-in shaders (engine/src/gfx/gl/Shaders.h). Each has a fixed
// instance layout, documented with the shader.
enum class ShaderId : uint8_t {
  Shape = 0,  // SDF rect / rounded rect / ellipse, fill + stroke, analytic AA; render/ShapeInstance.h
};

enum class StencilFunc : uint8_t { Always, Equal };
enum class StencilOp : uint8_t { Keep, Increment, Decrement };
struct StencilState {
  bool enabled = false;
  StencilFunc func = StencilFunc::Always;
  StencilOp pass = StencilOp::Keep;
};

enum class ColorMask : uint8_t { None, All };
enum class Blend : uint8_t { Opaque, Premultiplied };

struct PipelineDesc {
  ShaderId shader = ShaderId::Shape;
  Blend blend = Blend::Premultiplied;
  StencilState stencil;
  ColorMask colorMask = ColorMask::All;
};

struct IRect {
  int x = 0, y = 0, w = 0, h = 0;  // device px, origin top left
};

struct BufferSlice {
  BufferId buffer = 0;
  uint32_t offset = 0;  // bytes
  uint32_t size = 0;    // bytes
};

struct PassDesc {
  float clear[4] = {0, 0, 0, 1};
  uint8_t clearStencil = 0;
  IRect viewport;
};

struct DrawCall {
  PipelineId pipeline = 0;
  BufferSlice instances;
  uint32_t count = 6;  // vertices per instance
  uint32_t instanceCount = 1;
  // Inline uniforms: draw space → clip space rows (m00 m01 m02 m10 m11 m12), then two spare floats.
  float uniforms[8] = {1, 0, 0, 0, 1, 0, 0, 0};
  bool scissorEnabled = false;
  IRect scissor;
  uint8_t stencilRef = 0;
};

struct Caps {
  uint32_t maxTextureSize = 4096;
  bool stencil = true;
};

class Device {
 public:
  virtual ~Device() = default;
  virtual Caps caps() const = 0;
  virtual BufferId createBuffer(BufferKind kind, uint32_t bytes, Usage usage) = 0;
  // Grows the buffer (contents lost) when `bytes` exceeds its size.
  virtual void reserve(BufferId buffer, uint32_t bytes) = 0;
  virtual void write(BufferId buffer, uint32_t offset, std::span<const uint8_t> data) = 0;
  virtual PipelineId createPipeline(const PipelineDesc& desc) = 0;
  // False when there is nothing to draw into (context lost).
  virtual bool beginPass(const PassDesc& pass) = 0;
  virtual void draw(const DrawCall& call) = 0;
  virtual void endPass() = 0;
  virtual void submit() = 0;
  virtual void destroyBuffer(BufferId buffer) = 0;
};

}  // namespace eng::gfx
