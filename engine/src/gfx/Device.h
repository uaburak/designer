// The graphics interface between the renderer and a GPU backend
// (docs/engine.md §6.1): resources by id and explicit-argument draws, no
// global bound state above the backend — the move Figma made before WebGPU.
// WebGL2 implements it today (gfx/gl), the native tests use a recording device
// (gfx/null), a WebGPU backend comes later (E9).
//
// Interim subset of §6.1: buffers, pipelines over the built-in shaders,
// passes on the default framebuffer or on offscreen targets (an RGBA8 colour
// texture that can be sampled + a stencil buffer; readback for thumbnails),
// copies of the bound framebuffer into a texture (backdrops), small inline
// uniforms, textures (float data, RGBA8 images with mipmaps, ImageBitmaps
// uploaded by JavaScript). No MSAA: every edge is anti-aliased analytically.
#pragma once

#include <cstdint>
#include <span>

namespace eng::gfx {

using BufferId = uint32_t;    // 0 = none
using PipelineId = uint32_t;  // 0 = none
using TargetId = uint32_t;    // 0 = the default framebuffer (the canvas)
using TextureId = uint32_t;   // 0 = none

// RGBA32F: unfiltered float data read with texelFetch (curves). RGBA8: colour (premultiplied), filtered.
enum class TextureFormat : uint8_t { RGBA32F, RGBA8 };

struct TextureDesc {
  TextureFormat format = TextureFormat::RGBA8;
  uint32_t width = 0, height = 0;
  bool mipmaps = false;  // RGBA8: trilinear filtering, levels made by generateMipmaps
  bool repeat = false;   // wrap (else clamp to edge)
  bool linear = true;    // RGBA8: bilinear filtering (else nearest)
};

enum class BufferKind : uint8_t { Vertex, Instance, Index, Uniform };
enum class Usage : uint8_t { Static, Dynamic, Stream };

// The built-in shaders (engine/src/gfx/gl/Shaders.h).
enum class ShaderId : uint8_t {
  // Instanced shapes, paths and glyphs in one program (render/DrawInstance.h): SDF rect / rounded rect / ellipse
  // (fill or stroke, shadows) and coverage from quadratic curves (fill rules, a clip path), every paint, a clip
  // rectangle per instance — so runs of mixed content batch into one draw.
  Shape = 0,
  Composite = 1,  // a layer onto its parent: opacity, blend modes, masks, shadows (one quad, no instances)
  Blur = 2,       // separable Gaussian blur and dilate / erode (one quad, no instances)
};

enum class StencilFunc : uint8_t { Always, Equal };
enum class StencilOp : uint8_t { Keep, Increment, Decrement };
struct StencilState {
  bool enabled = false;
  StencilFunc func = StencilFunc::Always;
  StencilOp pass = StencilOp::Keep;
};

enum class ColorMask : uint8_t { None, All };
// Premultiplied: src + dst·(1 − src.a). Replace: src (the shader did the blending itself).
enum class Blend : uint8_t { Opaque, Premultiplied, Replace };

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
  TargetId target = 0;
  bool keep = false;  // true: no clear, keep what the target holds (a pass resumed after a backdrop blur)
  float clear[4] = {0, 0, 0, 1};
  uint8_t clearStencil = 0;
  IRect viewport;  // also the target's content height for scissors (y flips against viewport.h)
};

// Inline uniforms: vec4 slots. Slots 0–1 map draw space to clip space (rows m00 m01 m02 / m10 m11 m12);
// the others mean what each shader says (gfx/gl/Shaders.h).
inline constexpr int kUniformSlots = 12;

struct DrawCall {
  PipelineId pipeline = 0;
  BufferSlice instances;  // Shape: the instances; Composite / Blur: none (one quad)
  uint32_t count = 6;     // vertices per instance
  uint32_t instanceCount = 1;
  float uniforms[kUniformSlots][4] = {{1, 0, 0, 0}, {0, 1, 0, 0}};
  bool scissorEnabled = false;
  IRect scissor;
  uint8_t stencilRef = 0;
  // Shape: 0 curves (paths), 1 gradient ramps, 2 image or backdrop. Composite: 0 source, 1 mask /
  // node alpha, 2 backdrop. Blur: 0 source.
  TextureId textures[3] = {0, 0, 0};
};

struct Caps {
  uint32_t maxTextureSize = 4096;
  bool stencil = true;
};

// What the device holds on the GPU now (estimated bytes: colour texels, mip levels, stencil buffers, buffers).
struct MemoryStats {
  uint32_t textures = 0, targets = 0, buffers = 0;
  uint64_t bytes = 0;
};

class Device {
 public:
  virtual ~Device() = default;
  virtual Caps caps() const = 0;
  // Live resources and their size (budgets are checked against it: tests, engine_stats).
  virtual MemoryStats memory() const = 0;
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
  // An offscreen target of w×h device px: an RGBA8 colour texture (targetTexture) + stencil; 0 when it can't be made.
  virtual TargetId createTarget(uint32_t width, uint32_t height) = 0;
  virtual void destroyTarget(TargetId target) = 0;
  virtual TextureId targetTexture(TargetId target) = 0;
  // The target's pixels in `rect` (origin top left), rows top to bottom, premultiplied
  // RGBA8 into `rgba8` (rect.w × rect.h × 4 bytes). False when nothing could be read.
  virtual bool readPixels(TargetId target, IRect rect, std::span<uint8_t> rgba8) = 0;
  // Inside a pass: copies `rect` of the bound target (origin top left, its content height being the
  // pass viewport's) into `texture` at (0, 0), rows flipped as rendering stores them.
  virtual void copyToTexture(TextureId texture, IRect rect) = 0;
  // A texture (contents undefined); 0 when it can't be made.
  virtual TextureId createTexture(const TextureDesc& desc) = 0;
  TextureId createTexture(TextureFormat format, uint32_t width, uint32_t height) {
    TextureDesc d;
    d.format = format;
    d.width = width;
    d.height = height;
    d.linear = format == TextureFormat::RGBA8;
    return createTexture(d);
  }
  // Writes `rect` of the texture (rows top to bottom, tightly packed; RGBA32F or RGBA8 per its format).
  virtual void writeTexture(TextureId texture, IRect rect, std::span<const uint8_t> data) = 0;
  virtual void generateMipmaps(TextureId texture) = 0;
  // Uploads the JavaScript ImageBitmap `bitmapId` (Module.engineBitmaps) into an RGBA8 texture of its size.
  // False when there is no such bitmap (or no JavaScript: the native tests).
  virtual bool uploadBitmap(TextureId texture, uint32_t bitmapId) = 0;
  virtual void destroyTexture(TextureId texture) = 0;
};

}  // namespace eng::gfx
