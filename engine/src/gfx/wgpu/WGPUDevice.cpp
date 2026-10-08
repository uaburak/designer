#include "gfx/wgpu/WGPUDevice.h"

#include <webgpu/webgpu.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

#include "gfx/wgpu/Shaders.h"

// gfx/wgpu/library_engine_wgpu.js
extern "C" {
int engine_wgpu_offered();
WGPUDevice engine_wgpu_import_device(const char* selector, int32_t* lostFlag);
void engine_wgpu_forget_device(WGPUDevice device);
int engine_wgpu_preferred_bgra();
int engine_wgpu_display_p3();
int engine_wgpu_upload_bitmap(WGPUDevice device, WGPUTexture texture, uint32_t bitmapId);
int engine_wgpu_read_pixels(WGPUDevice device, WGPUTexture texture, int x, int y, int w, int h, uint8_t* out);
void engine_wgpu_check_async(WGPUDevice device, WGPUTexture texture, int x, int y, int r, int g, int b, int a);
}

namespace eng::gfx {

namespace {

WGPUStringView sv(const char* s) { return WGPUStringView{s, WGPU_STRLEN}; }

// The shaders' bind group 1 layouts (gfx/wgpu/Shaders.h); index = ShaderId, then the device's own.
enum Layout : int { kLayoutDraw = 0, kLayoutComposite = 1, kLayoutBlur = 2, kLayoutUtility = 3, kLayouts = 4 };

// Per draw: the 12 vec4 slots of DrawCall::uniforms + the device's (y sign, framebuffer height, stencil pass, 0).
constexpr uint32_t kUniformBytes = 13 * 16;
constexpr uint32_t kUniformStride = 256;            // minUniformBufferOffsetAlignment (WebGPU's default limit)
constexpr uint32_t kChunkBytes = 64 * 1024;         // 256 draws per uniform buffer
constexpr uint32_t kInstanceStride = 10 * 4 * 4;    // vec4s per instance (render/DrawInstance.h)

class WebGPUDevice final : public Device {
 public:
  ~WebGPUDevice() override {
    if (!device_) return;
    engine_wgpu_forget_device(device_);  // its loss from now on is nobody's
    if (pass_) {
      wgpuRenderPassEncoderEnd(pass_);
      wgpuRenderPassEncoderRelease(pass_);
    }
    if (encoder_) wgpuCommandEncoderRelease(encoder_);
    releaseCanvas();
    collect();
    for (auto& [k, g] : bindGroups_) wgpuBindGroupRelease(g);
    for (size_t i = 1; i < targets_.size(); i++) release(targets_[i]);
    for (size_t i = 1; i < textures_.size(); i++) release(textures_[i]);
    for (size_t i = 1; i < buffers_.size(); i++)
      if (buffers_[i].gpu) {
        wgpuBufferDestroy(buffers_[i].gpu);
        wgpuBufferRelease(buffers_[i].gpu);
      }
    for (auto& c : chunks_) {
      wgpuBindGroupRelease(c.group);
      wgpuBufferDestroy(c.buffer);
      wgpuBufferRelease(c.buffer);
    }
    for (auto& per : gpuPipelines_)
      for (WGPURenderPipeline p : per)
        if (p) wgpuRenderPipelineRelease(p);
    for (WGPURenderPipeline p : utilityPipelines_)
      if (p) wgpuRenderPipelineRelease(p);
    for (WGPUSampler s : samplers_)
      if (s) wgpuSamplerRelease(s);
    if (dummy_.gpu) release(dummy_);
    if (canvasStencil_) {
      wgpuTextureViewRelease(canvasStencilView_);
      wgpuTextureDestroy(canvasStencil_);
      wgpuTextureRelease(canvasStencil_);
    }
    for (WGPUPipelineLayout l : pipelineLayouts_)
      if (l) wgpuPipelineLayoutRelease(l);
    for (WGPUBindGroupLayout l : textureLayouts_)
      if (l) wgpuBindGroupLayoutRelease(l);
    if (uniformLayout_) wgpuBindGroupLayoutRelease(uniformLayout_);
    for (WGPUShaderModule m : modules_)
      if (m) wgpuShaderModuleRelease(m);
    if (surface_) {
      wgpuSurfaceUnconfigure(surface_);
      wgpuSurfaceRelease(surface_);
    }
    if (instance_) wgpuInstanceRelease(instance_);
    wgpuQueueRelease(queue_);
    wgpuDeviceRelease(device_);
  }

  bool init(const char* selector) {
    device_ = engine_wgpu_import_device(selector, &lost_);
    if (!device_) return false;
    queue_ = wgpuDeviceGetQueue(device_);
    instance_ = wgpuCreateInstance(nullptr);
    WGPUEmscriptenSurfaceSourceCanvasHTMLSelector source = WGPU_EMSCRIPTEN_SURFACE_SOURCE_CANVAS_HTML_SELECTOR_INIT;
    source.selector = sv(selector);
    WGPUSurfaceDescriptor sd = WGPU_SURFACE_DESCRIPTOR_INIT;
    sd.nextInChain = &source.chain;
    // getContext('webgpu'): null when the canvas already has another context.
    surface_ = wgpuInstanceCreateSurface(instance_, &sd);
    if (!surface_) return false;
    canvasFormat_ = engine_wgpu_preferred_bgra() ? WGPUTextureFormat_BGRA8Unorm : WGPUTextureFormat_RGBA8Unorm;
    configureSurface(engine_wgpu_display_p3() != 0);
    WGPULimits limits = WGPU_LIMITS_INIT;
    if (wgpuDeviceGetLimits(device_, &limits) == WGPUStatus_Success) maxTexture_ = limits.maxTextureDimension2D;
    if (!buildShaders()) return false;
    WGPUTextureDescriptor dd = WGPU_TEXTURE_DESCRIPTOR_INIT;
    dd.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    dd.size = {1, 1, 1};
    dd.format = WGPUTextureFormat_RGBA8Unorm;
    dummy_.gpu = wgpuDeviceCreateTexture(device_, &dd);
    dummy_.view = wgpuTextureCreateView(dummy_.gpu, nullptr);
    dummy_.width = dummy_.height = 1;
    dummy_.serial = nextSerial_++;
    // An unbound GL texture samples as (0, 0, 0, 1).
    const uint8_t black[4] = {0, 0, 0, 255};
    writeRaw(dummy_, {0, 0, 1, 1}, black, 4);
    selfTest();
    return true;
  }

  const char* backend() const override { return "webgpu"; }

  Caps caps() const override {
    Caps c;
    c.maxTextureSize = maxTexture_;
    return c;
  }

  // The same estimate as the WebGL2 backend (gl/GLDevice.cpp), so budgets mean the same on both: colour texels
  // (+ a third for mip levels), 4 bytes a pixel for a target's stencil, buffers.
  MemoryStats memory() const override {
    MemoryStats m;
    for (size_t i = 1; i < textures_.size(); i++) {
      const Texture& t = textures_[i];
      if (!t.gpu) continue;
      m.textures++;
      uint64_t b = static_cast<uint64_t>(t.width) * t.height * (t.format == TextureFormat::RGBA32F ? 16 : 4);
      m.bytes += t.mipmaps ? b * 4 / 3 : b;
    }
    for (size_t i = 1; i < targets_.size(); i++) {
      const Target& t = targets_[i];
      if (!t.stencil) continue;
      m.targets++;
      m.bytes += static_cast<uint64_t>(t.width) * t.height * 4;
    }
    for (size_t i = 1; i < buffers_.size(); i++) {
      if (!buffers_[i].gpu) continue;
      m.buffers++;
      m.bytes += buffers_[i].size;
    }
    return m;
  }

  // ---- Buffers ----

  BufferId createBuffer(BufferKind kind, uint32_t bytes, Usage usage) override {
    Buffer b;
    b.kind = kind;
    b.size = align4(std::max<uint32_t>(bytes, 4));
    b.gpu = makeBuffer(kind, b.size);
    buffers_.push_back(b);
    return static_cast<BufferId>(buffers_.size() - 1);
  }

  void reserve(BufferId id, uint32_t bytes) override {
    Buffer& b = buffers_.at(id);
    if (bytes <= b.size) return;
    if (b.gpu) retire(b.gpu);
    b.size = align4(bytes);
    b.gpu = makeBuffer(b.kind, b.size);
  }

  void write(BufferId id, uint32_t offset, std::span<const uint8_t> data) override {
    Buffer& b = buffers_.at(id);
    if (!b.gpu || data.empty()) return;
    // queue.writeBuffer runs before the commands still being recorded: they go first (GL's order).
    flush();
    size_t n = std::min<size_t>(data.size(), b.size > offset ? b.size - offset : 0);
    size_t whole = n & ~size_t{3};
    if (whole) wgpuQueueWriteBuffer(queue_, b.gpu, offset, data.data(), whole);
    if (n > whole) {
      uint8_t tail[4] = {0, 0, 0, 0};
      std::memcpy(tail, data.data() + whole, n - whole);
      wgpuQueueWriteBuffer(queue_, b.gpu, offset + whole, tail, 4);
    }
  }

  void destroyBuffer(BufferId id) override {
    Buffer& b = buffers_.at(id);
    if (b.gpu) retire(b.gpu);
    b.gpu = nullptr;
    b.size = 0;
  }

  // ---- Pipelines ----

  PipelineId createPipeline(const PipelineDesc& desc) override {
    pipelines_.push_back(desc);
    gpuPipelines_.push_back({nullptr, nullptr});
    PipelineId id = static_cast<PipelineId>(pipelines_.size() - 1);
    // Compiled now, for targets and the canvas: the first frame doesn't wait on them.
    pipelineFor(id, WGPUTextureFormat_RGBA8Unorm);
    pipelineFor(id, canvasFormat_);
    return id;
  }

  // ---- Passes and draws ----

  bool beginPass(const PassDesc& pass) override {
    if (lost_) return false;
    if (pass.target && (pass.target >= targets_.size() || !targets_[pass.target].stencil)) return false;
    if (inPass_) endPass();
    pass_desc_ = pass;
    inPass_ = true;
    if (!openPass(!pass.keep)) {
      inPass_ = false;
      return false;
    }
    return true;
  }

  void draw(const DrawCall& call) override {
    if (!inPass_ || !call.instanceCount || call.pipeline == 0 || call.pipeline >= pipelines_.size()) return;
    if (!pass_ && !openPass(false)) return;
    const PipelineDesc& p = pipelines_[call.pipeline];
    const bool instanced = p.shader == ShaderId::Shape;
    if (instanced && (call.instances.buffer >= buffers_.size() || !buffers_[call.instances.buffer].gpu)) return;
    // The scissor, in the framebuffer's rows (GL's box flipped on the canvas), within the attachment.
    int sx = 0, sy = 0, sw = attachW_, sh = attachH_;
    if (call.scissorEnabled) {
      int w = std::max(0, call.scissor.w), h = std::max(0, call.scissor.h);
      int glY = passH() - call.scissor.y - h;  // GL's box: rows from the bottom
      int y = onCanvas() ? attachH_ - glY - h : glY;
      int x0 = std::clamp(call.scissor.x, 0, attachW_), x1 = std::clamp(call.scissor.x + w, 0, attachW_);
      int y0 = std::clamp(y, 0, attachH_), y1 = std::clamp(y + h, 0, attachH_);
      if (x1 <= x0 || y1 <= y0) return;  // nothing passes
      sx = x0;
      sy = y0;
      sw = x1 - x0;
      sh = y1 - y0;
    }
    WGPURenderPipeline pipeline = pipelineFor(call.pipeline, onCanvas() ? canvasFormat_ : WGPUTextureFormat_RGBA8Unorm);
    if (!pipeline) return;
    if (st_.pipeline != pipeline) {
      wgpuRenderPassEncoderSetPipeline(pass_, pipeline);
      st_.pipeline = pipeline;
    }
    // Uniforms: one 256-byte slot per distinct set, written with the frame's other uniforms at submit (Figma's
    // encodeDraw / submit: one upload, draws at offsets into it).
    float u[13][4];
    std::memcpy(u, call.uniforms, sizeof call.uniforms);
    u[12][0] = onCanvas() ? 1.0f : -1.0f;
    u[12][1] = static_cast<float>(attachH_);
    u[12][2] = p.colorMask == ColorMask::None ? 1.0f : 0.0f;
    u[12][3] = 0;
    bindUniforms(u);
    bindTextures(static_cast<int>(p.shader), call.textures);
    if (instanced) {
      const Buffer& b = buffers_[call.instances.buffer];
      if (st_.vertexBuffer != b.gpu || st_.vertexOffset != call.instances.offset) {
        uint32_t offset = std::min(call.instances.offset, b.size);
        wgpuRenderPassEncoderSetVertexBuffer(pass_, 0, b.gpu, offset, b.size - offset);
        st_.vertexBuffer = b.gpu;
        st_.vertexOffset = call.instances.offset;
      }
    }
    if (st_.scissor[0] != sx || st_.scissor[1] != sy || st_.scissor[2] != sw || st_.scissor[3] != sh) {
      wgpuRenderPassEncoderSetScissorRect(pass_, static_cast<uint32_t>(sx), static_cast<uint32_t>(sy), static_cast<uint32_t>(sw),
                                          static_cast<uint32_t>(sh));
      st_.scissor[0] = sx;
      st_.scissor[1] = sy;
      st_.scissor[2] = sw;
      st_.scissor[3] = sh;
    }
    if (p.stencil.enabled && st_.stencilRef != call.stencilRef) {
      wgpuRenderPassEncoderSetStencilReference(pass_, call.stencilRef);
      st_.stencilRef = call.stencilRef;
    }
    if (instanced)
      wgpuRenderPassEncoderDraw(pass_, call.count, call.instanceCount, 0, 0);
    else
      wgpuRenderPassEncoderDraw(pass_, 6, 1, 0, 0);
  }

  void endPass() override {
    closePass();
    inPass_ = false;
  }

  void submit() override {
    flush();
    // The canvas's texture is the browser's once this task ends: the next frame asks for a new one.
    releaseCanvas();
  }

  // ---- Targets ----

  TargetId createTarget(uint32_t width, uint32_t height) override {
    if (lost_ || !width || !height || width > maxTexture_ || height > maxTexture_) return 0;
    Target t;
    t.width = width;
    t.height = height;
    TextureDesc d;
    d.format = TextureFormat::RGBA8;
    d.width = width;
    d.height = height;
    t.texture = createTexture(d);
    if (!t.texture) return 0;
    t.stencil = makeStencil(width, height);
    t.stencilView = wgpuTextureCreateView(t.stencil, nullptr);
    for (size_t i = 1; i < targets_.size(); i++)
      if (!targets_[i].stencil) {
        targets_[i] = t;
        return static_cast<TargetId>(i);
      }
    targets_.push_back(t);
    return static_cast<TargetId>(targets_.size() - 1);
  }

  void destroyTarget(TargetId id) override {
    if (!id || id >= targets_.size() || !targets_[id].stencil) return;
    release(targets_[id]);
  }

  TextureId targetTexture(TargetId id) override { return id && id < targets_.size() ? targets_[id].texture : 0; }

  bool readPixels(TargetId id, IRect rect, std::span<uint8_t> rgba8) override {
    if (lost_ || !id || id >= targets_.size() || !targets_[id].stencil) return false;
    size_t row = static_cast<size_t>(rect.w) * 4;
    if (rect.w <= 0 || rect.h <= 0 || rgba8.size() < row * static_cast<size_t>(rect.h)) return false;
    const Target& t = targets_[id];
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > static_cast<int>(t.width) || rect.y + rect.h > static_cast<int>(t.height)) return false;
    flush();
    // Rows sit as GL leaves them (bottom first): read them, then turn them top first (gl/GLDevice.cpp).
    int y = static_cast<int>(t.height) - rect.y - rect.h;
    if (!engine_wgpu_read_pixels(device_, textures_[t.texture].gpu, rect.x, y, rect.w, rect.h, rgba8.data())) return false;
    std::vector<uint8_t> tmp(row);
    for (int r = 0; r < rect.h / 2; r++) {
      uint8_t* a = rgba8.data() + static_cast<size_t>(r) * row;
      uint8_t* b = rgba8.data() + static_cast<size_t>(rect.h - 1 - r) * row;
      std::copy(a, a + row, tmp.data());
      std::copy(b, b + row, a);
      std::copy(tmp.data(), tmp.data() + row, b);
    }
    return true;
  }

  // Inside a pass: the render pass ends, the copy is encoded, the next draw resumes the pass (load).
  void copyToTexture(TextureId texture, IRect rect) override {
    if (!inPass_ || !texture || texture >= textures_.size() || !textures_[texture].gpu || rect.w <= 0 || rect.h <= 0) return;
    Texture& dst = textures_[texture];
    int w = std::min<int>(rect.w, static_cast<int>(dst.width));
    int h = std::min<int>(rect.h, static_cast<int>(dst.height));
    int glY = passH() - rect.y - rect.h;  // GL's source rows (from the bottom), as glCopyTexSubImage2D takes them
    closePass();
    ensureEncoder();
    if (!onCanvas()) {
      const Target& t = targets_[pass_desc_.target];
      Texture& src = textures_[t.texture];
      int x0 = std::max(0, rect.x), y0 = std::max(0, glY);
      int x1 = std::min<int>(rect.x + w, static_cast<int>(src.width)), y1 = std::min<int>(glY + h, static_cast<int>(src.height));
      if (x1 <= x0 || y1 <= y0) return;
      WGPUTexelCopyTextureInfo from = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
      from.texture = src.gpu;
      from.origin = {static_cast<uint32_t>(x0), static_cast<uint32_t>(y0), 0};
      WGPUTexelCopyTextureInfo to = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
      to.texture = dst.gpu;
      to.origin = {static_cast<uint32_t>(x0 - rect.x), static_cast<uint32_t>(y0 - glY), 0};
      WGPUExtent3D size = {static_cast<uint32_t>(x1 - x0), static_cast<uint32_t>(y1 - y0), 1};
      wgpuCommandEncoderCopyTextureToTexture(encoder_, &from, &to, &size);
      return;
    }
    // The canvas stores its rows top first: a draw turns them as GL's copy from the canvas leaves them.
    if (!acquireCanvas()) return;
    float u[13][4] = {};
    u[0][0] = static_cast<float>(rect.x);
    u[0][1] = static_cast<float>(canvasH_ - 1 - glY);
    uint32_t offset = 0;
    Chunk& chunk = uniformSlot(u, offset);
    WGPUTextureView view = levelView(dst, 0);
    WGPUBindGroup group = utilityGroup(canvasView_, samplers_[0]);
    WGPURenderPassColorAttachment ca = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    ca.view = view;
    ca.loadOp = WGPULoadOp_Load;
    ca.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor rp = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    rp.colorAttachmentCount = 1;
    rp.colorAttachments = &ca;
    WGPURenderPassEncoder enc = wgpuCommandEncoderBeginRenderPass(encoder_, &rp);
    wgpuRenderPassEncoderSetPipeline(enc, utilityPipelines_[1]);
    wgpuRenderPassEncoderSetBindGroup(enc, 0, chunk.group, 1, &offset);
    wgpuRenderPassEncoderSetBindGroup(enc, 1, group, 0, nullptr);
    wgpuRenderPassEncoderSetScissorRect(enc, 0, 0, static_cast<uint32_t>(w), static_cast<uint32_t>(h));
    wgpuRenderPassEncoderDraw(enc, 6, 1, 0, 0);
    wgpuRenderPassEncoderEnd(enc);
    wgpuRenderPassEncoderRelease(enc);
    wgpuBindGroupRelease(group);
    if (view != dst.view) wgpuTextureViewRelease(view);
  }

  // ---- Textures ----

  TextureId createTexture(const TextureDesc& desc) override {
    if (lost_ || !desc.width || !desc.height || desc.width > maxTexture_ || desc.height > maxTexture_) return 0;
    Texture t;
    t.width = desc.width;
    t.height = desc.height;
    t.format = desc.format;
    t.mipmaps = desc.mipmaps && desc.format == TextureFormat::RGBA8;
    t.levels = t.mipmaps ? static_cast<uint32_t>(std::floor(std::log2(static_cast<double>(std::max(desc.width, desc.height))))) + 1 : 1;
    t.sampler = t.format == TextureFormat::RGBA32F ? 0 : samplerIndex(desc.linear, t.mipmaps, desc.repeat);
    WGPUTextureDescriptor d = WGPU_TEXTURE_DESCRIPTOR_INIT;
    d.size = {desc.width, desc.height, 1};
    d.mipLevelCount = t.levels;
    if (desc.format == TextureFormat::RGBA32F) {
      d.format = WGPUTextureFormat_RGBA32Float;
      d.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    } else {
      d.format = WGPUTextureFormat_RGBA8Unorm;
      d.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst | WGPUTextureUsage_CopySrc | WGPUTextureUsage_RenderAttachment;
    }
    t.gpu = wgpuDeviceCreateTexture(device_, &d);
    if (!t.gpu) return 0;
    t.view = wgpuTextureCreateView(t.gpu, nullptr);
    t.serial = nextSerial_++;
    for (size_t i = 1; i < textures_.size(); i++)
      if (!textures_[i].gpu) {
        textures_[i] = t;
        return static_cast<TextureId>(i);
      }
    textures_.push_back(t);
    return static_cast<TextureId>(textures_.size() - 1);
  }

  void writeTexture(TextureId id, IRect rect, std::span<const uint8_t> data) override {
    if (!id || id >= textures_.size() || !textures_[id].gpu || rect.w <= 0 || rect.h <= 0) return;
    Texture& t = textures_[id];
    flush();  // queue writes run before the commands still being recorded
    writeRaw(t, rect, data.data(), data.size());
  }

  void generateMipmaps(TextureId id) override {
    if (!id || id >= textures_.size() || !textures_[id].gpu) return;
    Texture& t = textures_[id];
    if (t.levels < 2) return;
    closePass();
    ensureEncoder();
    WGPUTextureView prev = levelView(t, 0);
    for (uint32_t level = 1; level < t.levels; level++) {
      WGPUTextureView view = levelView(t, level);
      WGPUBindGroup group = utilityGroup(prev, samplers_[samplerIndex(true, false, false)]);
      WGPURenderPassColorAttachment ca = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
      ca.view = view;
      ca.loadOp = WGPULoadOp_Clear;
      ca.storeOp = WGPUStoreOp_Store;
      WGPURenderPassDescriptor rp = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
      rp.colorAttachmentCount = 1;
      rp.colorAttachments = &ca;
      WGPURenderPassEncoder enc = wgpuCommandEncoderBeginRenderPass(encoder_, &rp);
      wgpuRenderPassEncoderSetPipeline(enc, utilityPipelines_[0]);
      uint32_t offset = 0;
      float u[13][4] = {};
      Chunk& chunk = uniformSlot(u, offset);
      wgpuRenderPassEncoderSetBindGroup(enc, 0, chunk.group, 1, &offset);
      wgpuRenderPassEncoderSetBindGroup(enc, 1, group, 0, nullptr);
      wgpuRenderPassEncoderDraw(enc, 6, 1, 0, 0);
      wgpuRenderPassEncoderEnd(enc);
      wgpuRenderPassEncoderRelease(enc);
      wgpuBindGroupRelease(group);
      wgpuTextureViewRelease(prev);
      prev = view;
    }
    wgpuTextureViewRelease(prev);
  }

  bool uploadBitmap(TextureId id, uint32_t bitmapId) override {
    if (!id || id >= textures_.size() || !textures_[id].gpu) return false;
    flush();
    return engine_wgpu_upload_bitmap(device_, textures_[id].gpu, bitmapId) != 0;
  }

  void destroyTexture(TextureId id) override {
    if (!id || id >= textures_.size() || !textures_[id].gpu) return;
    release(textures_[id]);
  }

 private:
  struct Buffer {
    WGPUBuffer gpu = nullptr;
    BufferKind kind = BufferKind::Instance;
    uint32_t size = 0;
  };
  struct Texture {
    WGPUTexture gpu = nullptr;
    WGPUTextureView view = nullptr;
    uint32_t width = 0, height = 0, levels = 1;
    TextureFormat format = TextureFormat::RGBA8;
    bool mipmaps = false;
    int sampler = 0;
    uint64_t serial = 0;
  };
  struct Target {
    TextureId texture = 0;
    WGPUTexture stencil = nullptr;
    WGPUTextureView stencilView = nullptr;
    uint32_t width = 0, height = 0;
  };
  struct Chunk {
    WGPUBuffer buffer = nullptr;
    WGPUBindGroup group = nullptr;
    std::vector<uint8_t> staging;
    uint32_t used = 0;
  };
  // What the open render pass has set (draws only send what changes: every call crosses into JavaScript).
  struct PassState {
    WGPURenderPipeline pipeline = nullptr;
    WGPUBindGroup uniforms = nullptr;
    uint32_t uniformOffset = 0xffffffffu;
    WGPUBindGroup textures = nullptr;
    WGPUBuffer vertexBuffer = nullptr;
    uint32_t vertexOffset = 0xffffffffu;
    int scissor[4] = {-1, -1, -1, -1};
    int stencilRef = -1;
  };
  struct GroupKey {
    int layout;
    uint64_t serials[3];
    bool operator==(const GroupKey& o) const {
      return layout == o.layout && serials[0] == o.serials[0] && serials[1] == o.serials[1] && serials[2] == o.serials[2];
    }
  };
  struct GroupKeyHash {
    size_t operator()(const GroupKey& k) const {
      uint64_t h = static_cast<uint64_t>(k.layout) * 0x9E3779B97F4A7C15ull;
      for (uint64_t s : k.serials) h = (h ^ s) * 0x100000001B3ull;
      return static_cast<size_t>(h ^ (h >> 32));
    }
  };

  static uint32_t align4(uint32_t n) { return (n + 3u) & ~3u; }
  static int samplerIndex(bool linear, bool mipmaps, bool repeat) { return (linear ? 1 : 0) | (mipmaps ? 2 : 0) | (repeat ? 4 : 0); }

  bool onCanvas() const { return pass_desc_.target == 0; }
  int passH() const { return pass_desc_.viewport.h; }

  WGPUBuffer makeBuffer(BufferKind kind, uint32_t size) {
    WGPUBufferDescriptor d = WGPU_BUFFER_DESCRIPTOR_INIT;
    d.size = size;
    d.usage = WGPUBufferUsage_CopyDst | (kind == BufferKind::Index ? WGPUBufferUsage_Index
                                         : kind == BufferKind::Uniform ? WGPUBufferUsage_Uniform
                                                                       : WGPUBufferUsage_Vertex);
    return wgpuDeviceCreateBuffer(device_, &d);
  }

  WGPUTexture makeStencil(uint32_t width, uint32_t height) {
    WGPUTextureDescriptor d = WGPU_TEXTURE_DESCRIPTOR_INIT;
    d.size = {width, height, 1};
    d.format = WGPUTextureFormat_Stencil8;
    d.usage = WGPUTextureUsage_RenderAttachment;
    return wgpuDeviceCreateTexture(device_, &d);
  }

  void writeRaw(Texture& t, IRect rect, const uint8_t* data, size_t size) {
    uint32_t bpp = t.format == TextureFormat::RGBA32F ? 16 : 4;
    size_t need = static_cast<size_t>(rect.w) * rect.h * bpp;
    if (size < need) return;
    WGPUTexelCopyTextureInfo dst = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    dst.texture = t.gpu;
    dst.origin = {static_cast<uint32_t>(rect.x), static_cast<uint32_t>(rect.y), 0};
    WGPUTexelCopyBufferLayout layout = WGPU_TEXEL_COPY_BUFFER_LAYOUT_INIT;
    layout.bytesPerRow = static_cast<uint32_t>(rect.w) * bpp;
    layout.rowsPerImage = static_cast<uint32_t>(rect.h);
    WGPUExtent3D extent = {static_cast<uint32_t>(rect.w), static_cast<uint32_t>(rect.h), 1};
    wgpuQueueWriteTexture(queue_, &dst, data, need, &layout, &extent);
  }

  // A resource the commands being recorded may still use: destroyed after they are submitted.
  void retire(WGPUBuffer b) {
    if (encoder_) garbageBuffers_.push_back(b);
    else {
      wgpuBufferDestroy(b);
      wgpuBufferRelease(b);
    }
  }
  void retire(WGPUTexture t) {
    if (encoder_) garbageTextures_.push_back(t);
    else {
      wgpuTextureDestroy(t);
      wgpuTextureRelease(t);
    }
  }
  void collect() {
    for (WGPUBuffer b : garbageBuffers_) {
      wgpuBufferDestroy(b);
      wgpuBufferRelease(b);
    }
    for (WGPUTexture t : garbageTextures_) {
      wgpuTextureDestroy(t);
      wgpuTextureRelease(t);
    }
    garbageBuffers_.clear();
    garbageTextures_.clear();
  }

  void release(Texture& t) {
    if (!t.gpu) return;
    // Bind groups naming it go with it.
    for (auto it = bindGroups_.begin(); it != bindGroups_.end();) {
      const GroupKey& k = it->first;
      if (k.serials[0] == t.serial || k.serials[1] == t.serial || k.serials[2] == t.serial) {
        if (st_.textures == it->second) st_.textures = nullptr;
        wgpuBindGroupRelease(it->second);
        it = bindGroups_.erase(it);
      } else {
        ++it;
      }
    }
    wgpuTextureViewRelease(t.view);
    retire(t.gpu);
    t = Texture{};
  }
  void release(Target& t) {
    if (t.stencilView) wgpuTextureViewRelease(t.stencilView);
    if (t.stencil) retire(t.stencil);
    if (t.texture && t.texture < textures_.size()) release(textures_[t.texture]);
    t = Target{};
  }

  WGPUTextureView levelView(Texture& t, uint32_t level) {
    if (t.levels == 1 && level == 0) return t.view;
    WGPUTextureViewDescriptor d = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
    d.format = WGPUTextureFormat_RGBA8Unorm;
    d.dimension = WGPUTextureViewDimension_2D;
    d.baseMipLevel = level;
    d.mipLevelCount = 1;
    d.baseArrayLayer = 0;
    d.arrayLayerCount = 1;
    return wgpuTextureCreateView(t.gpu, &d);
  }

  // ---- The canvas ----

  void configureSurface(bool p3) {
    WGPUSurfaceColorManagement colour = WGPU_SURFACE_COLOR_MANAGEMENT_INIT;
    colour.colorSpace = p3 ? WGPUPredefinedColorSpace_DisplayP3 : WGPUPredefinedColorSpace_SRGB;
    colour.toneMappingMode = WGPUToneMappingMode_Standard;
    WGPUSurfaceConfiguration c = WGPU_SURFACE_CONFIGURATION_INIT;
    c.nextInChain = &colour.chain;
    c.device = device_;
    c.format = canvasFormat_;
    // Copies and draws read it (backdrops of blend modes and background blurs drawn straight onto the canvas).
    c.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc | WGPUTextureUsage_TextureBinding;
    c.alphaMode = WGPUCompositeAlphaMode_Premultiplied;
    c.width = 0;  // the canvas keeps the size the engine gives it (engine_set_viewport)
    c.height = 0;
    wgpuSurfaceConfigure(surface_, &c);
    p3_ = p3;
  }

  bool acquireCanvas() {
    if (canvasTexture_) return true;
    bool p3 = engine_wgpu_display_p3() != 0;
    if (p3 != p3_) configureSurface(p3);
    WGPUSurfaceTexture st = WGPU_SURFACE_TEXTURE_INIT;
    wgpuSurfaceGetCurrentTexture(surface_, &st);
    if (!st.texture || (st.status != WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal &&
                        st.status != WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal))
      return false;
    canvasTexture_ = st.texture;
    canvasView_ = wgpuTextureCreateView(canvasTexture_, nullptr);
    canvasW_ = static_cast<int>(wgpuTextureGetWidth(canvasTexture_));
    canvasH_ = static_cast<int>(wgpuTextureGetHeight(canvasTexture_));
    if (!canvasStencil_ || canvasStencilW_ != canvasW_ || canvasStencilH_ != canvasH_) {
      if (canvasStencil_) {
        wgpuTextureViewRelease(canvasStencilView_);
        retire(canvasStencil_);
      }
      canvasStencil_ = makeStencil(static_cast<uint32_t>(canvasW_), static_cast<uint32_t>(canvasH_));
      canvasStencilView_ = wgpuTextureCreateView(canvasStencil_, nullptr);
      canvasStencilW_ = canvasW_;
      canvasStencilH_ = canvasH_;
    }
    return true;
  }

  void releaseCanvas() {
    if (!canvasTexture_) return;
    wgpuTextureViewRelease(canvasView_);
    wgpuTextureRelease(canvasTexture_);
    canvasView_ = nullptr;
    canvasTexture_ = nullptr;
  }

  // ---- Encoding ----

  void ensureEncoder() {
    if (!encoder_) encoder_ = wgpuDeviceCreateCommandEncoder(device_, nullptr);
  }

  // Opens the render pass of pass_desc_: cleared (`clear`) or resumed with what the target holds.
  bool openPass(bool clear) {
    WGPUTextureView colour = nullptr, stencil = nullptr;
    if (onCanvas()) {
      if (!acquireCanvas()) return false;
      colour = canvasView_;
      stencil = canvasStencilView_;
      attachW_ = canvasW_;
      attachH_ = canvasH_;
    } else {
      const Target& t = targets_[pass_desc_.target];
      colour = textures_[t.texture].view;
      stencil = t.stencilView;
      attachW_ = static_cast<int>(t.width);
      attachH_ = static_cast<int>(t.height);
    }
    ensureEncoder();
    WGPURenderPassColorAttachment ca = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    ca.view = colour;
    ca.loadOp = clear ? WGPULoadOp_Clear : WGPULoadOp_Load;
    ca.storeOp = WGPUStoreOp_Store;
    ca.clearValue = {pass_desc_.clear[0], pass_desc_.clear[1], pass_desc_.clear[2], pass_desc_.clear[3]};
    WGPURenderPassDepthStencilAttachment ds = WGPU_RENDER_PASS_DEPTH_STENCIL_ATTACHMENT_INIT;
    ds.view = stencil;
    ds.stencilLoadOp = clear ? WGPULoadOp_Clear : WGPULoadOp_Load;
    ds.stencilStoreOp = WGPUStoreOp_Store;
    ds.stencilClearValue = pass_desc_.clearStencil;
    WGPURenderPassDescriptor rp = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    rp.colorAttachmentCount = 1;
    rp.colorAttachments = &ca;
    rp.depthStencilAttachment = &ds;
    pass_ = wgpuCommandEncoderBeginRenderPass(encoder_, &rp);
    st_ = PassState{};
    // GL's viewport (rows from the bottom) in the framebuffer's rows, within the attachment.
    const IRect& v = pass_desc_.viewport;
    float vy = static_cast<float>(onCanvas() ? attachH_ - v.y - v.h : v.y);
    float vx = static_cast<float>(v.x);
    float vw = static_cast<float>(std::max(1, v.w)), vh = static_cast<float>(std::max(1, v.h));
    vx = std::clamp(vx, 0.0f, static_cast<float>(attachW_ - 1));
    vy = std::clamp(vy, 0.0f, static_cast<float>(attachH_ - 1));
    vw = std::min(vw, static_cast<float>(attachW_) - vx);
    vh = std::min(vh, static_cast<float>(attachH_) - vy);
    wgpuRenderPassEncoderSetViewport(pass_, vx, vy, vw, vh, 0.0f, 1.0f);
    return true;
  }

  void closePass() {
    if (!pass_) return;
    wgpuRenderPassEncoderEnd(pass_);
    wgpuRenderPassEncoderRelease(pass_);
    pass_ = nullptr;
  }

  // Submits what was recorded: the frame's uniforms first, then the commands.
  void flush() {
    if (!encoder_) return;
    closePass();
    for (Chunk& c : chunks_) {
      if (!c.used) continue;
      wgpuQueueWriteBuffer(queue_, c.buffer, 0, c.staging.data(), c.used);
      c.used = 0;
    }
    chunk_ = 0;
    lastUniformValid_ = false;
    WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder_, nullptr);
    wgpuCommandEncoderRelease(encoder_);
    encoder_ = nullptr;
    wgpuQueueSubmit(queue_, 1, &commands);
    wgpuCommandBufferRelease(commands);
    collect();
  }

  // A uniform slot holding `u` (the last one again when nothing changed).
  Chunk& uniformSlot(const float (&u)[13][4], uint32_t& offset) {
    if (lastUniformValid_ && std::memcmp(lastUniform_, u, kUniformBytes) == 0) {
      offset = lastOffset_;
      return chunks_[lastChunk_];
    }
    if (chunk_ < chunks_.size() && chunks_[chunk_].used + kUniformStride > kChunkBytes) chunk_++;
    if (chunk_ >= chunks_.size()) {
      Chunk c;
      WGPUBufferDescriptor d = WGPU_BUFFER_DESCRIPTOR_INIT;
      d.size = kChunkBytes;
      d.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
      c.buffer = wgpuDeviceCreateBuffer(device_, &d);
      c.staging.resize(kChunkBytes);
      WGPUBindGroupEntry e = WGPU_BIND_GROUP_ENTRY_INIT;
      e.binding = 0;
      e.buffer = c.buffer;
      e.offset = 0;
      e.size = kUniformBytes;
      WGPUBindGroupDescriptor bd = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
      bd.layout = uniformLayout_;
      bd.entryCount = 1;
      bd.entries = &e;
      c.group = wgpuDeviceCreateBindGroup(device_, &bd);
      chunks_.push_back(std::move(c));
    }
    Chunk& c = chunks_[chunk_];
    offset = c.used;
    std::memcpy(c.staging.data() + offset, u, kUniformBytes);
    c.used += kUniformStride;
    std::memcpy(lastUniform_, u, kUniformBytes);
    lastChunk_ = chunk_;
    lastOffset_ = offset;
    lastUniformValid_ = true;
    return c;
  }

  void bindUniforms(const float (&u)[13][4]) {
    uint32_t offset = 0;
    Chunk& c = uniformSlot(u, offset);
    if (st_.uniforms == c.group && st_.uniformOffset == offset) return;
    wgpuRenderPassEncoderSetBindGroup(pass_, 0, c.group, 1, &offset);
    st_.uniforms = c.group;
    st_.uniformOffset = offset;
  }

  // The draw's textures as bind group 1 (cached by the textures' serials: Figma's bind group reuse).
  void bindTextures(int layout, const TextureId (&ids)[3]) {
    const Texture* tex[3];
    GroupKey key{layout, {0, 0, 0}};
    for (int i = 0; i < 3; i++) {
      TextureId id = ids[i];
      tex[i] = id && id < textures_.size() && textures_[id].gpu ? &textures_[id] : &dummy_;
      key.serials[i] = tex[i]->serial;
    }
    WGPUBindGroup group;
    auto it = bindGroups_.find(key);
    if (it != bindGroups_.end()) {
      group = it->second;
    } else {
      WGPUBindGroupEntry e[6];
      size_t n = 0;
      auto texture = [&](uint32_t binding, const Texture* t) {
        e[n] = WGPU_BIND_GROUP_ENTRY_INIT;
        e[n].binding = binding;
        e[n].textureView = t->view;
        n++;
      };
      auto sampler = [&](uint32_t binding, const Texture* t) {
        e[n] = WGPU_BIND_GROUP_ENTRY_INIT;
        e[n].binding = binding;
        e[n].sampler = samplers_[t->sampler];
        n++;
      };
      if (layout == kLayoutDraw) {
        texture(0, tex[0]);
        texture(1, tex[1]);
        sampler(2, tex[1]);
        texture(3, tex[2]);
        sampler(4, tex[2]);
      } else if (layout == kLayoutComposite) {
        for (uint32_t i = 0; i < 3; i++) {
          texture(i * 2, tex[i]);
          sampler(i * 2 + 1, tex[i]);
        }
      } else {
        texture(0, tex[0]);
        sampler(1, tex[0]);
      }
      WGPUBindGroupDescriptor bd = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
      bd.layout = textureLayouts_[layout];
      bd.entryCount = n;
      bd.entries = e;
      group = wgpuDeviceCreateBindGroup(device_, &bd);
      bindGroups_.emplace(key, group);
    }
    if (st_.textures == group) return;
    wgpuRenderPassEncoderSetBindGroup(pass_, 1, group, 0, nullptr);
    st_.textures = group;
  }

  WGPUBindGroup utilityGroup(WGPUTextureView view, WGPUSampler sampler) {
    WGPUBindGroupEntry e[2] = {WGPU_BIND_GROUP_ENTRY_INIT, WGPU_BIND_GROUP_ENTRY_INIT};
    e[0].binding = 0;
    e[0].textureView = view;
    e[1].binding = 1;
    e[1].sampler = sampler;
    WGPUBindGroupDescriptor bd = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    bd.layout = textureLayouts_[kLayoutUtility];
    bd.entryCount = 2;
    bd.entries = e;
    return wgpuDeviceCreateBindGroup(device_, &bd);
  }

  // ---- Shaders, layouts, pipelines ----

  WGPUShaderModule module(const std::string& code, const char* label) {
    WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
    wgsl.code = WGPUStringView{code.data(), code.size()};
    WGPUShaderModuleDescriptor d = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
    d.nextInChain = &wgsl.chain;
    d.label = sv(label);
    return wgpuDeviceCreateShaderModule(device_, &d);
  }

  bool buildShaders() {
    using namespace wgsl;
    modules_[0] = module(std::string(kCommon) + kDraw, "draw");
    modules_[1] = module(std::string(kCommon) + kComposite, "composite");
    modules_[2] = module(std::string(kCommon) + kBlur, "blur");
    modules_[3] = module(std::string(kCommon) + kUtility, "utility");
    for (WGPUShaderModule m : modules_)
      if (!m) return false;
    // Group 0: the draw's uniforms (a dynamic offset into the frame's uniform buffer).
    WGPUBindGroupLayoutEntry ue = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    ue.binding = 0;
    ue.visibility = WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
    ue.buffer.type = WGPUBufferBindingType_Uniform;
    ue.buffer.hasDynamicOffset = true;
    ue.buffer.minBindingSize = kUniformBytes;
    WGPUBindGroupLayoutDescriptor ud = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    ud.entryCount = 1;
    ud.entries = &ue;
    uniformLayout_ = wgpuDeviceCreateBindGroupLayout(device_, &ud);
    // Group 1: textures and samplers.
    auto layout = [&](std::initializer_list<int> kinds) {  // 0 filterable texture, 1 unfilterable texture, 2 sampler
      WGPUBindGroupLayoutEntry e[6];
      size_t n = 0;
      for (int kind : kinds) {
        e[n] = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        e[n].binding = static_cast<uint32_t>(n);
        e[n].visibility = WGPUShaderStage_Fragment;
        if (kind == 2) {
          e[n].sampler.type = WGPUSamplerBindingType_Filtering;
        } else {
          e[n].texture.sampleType = kind == 1 ? WGPUTextureSampleType_UnfilterableFloat : WGPUTextureSampleType_Float;
          e[n].texture.viewDimension = WGPUTextureViewDimension_2D;
        }
        n++;
      }
      WGPUBindGroupLayoutDescriptor d = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
      d.entryCount = n;
      d.entries = e;
      return wgpuDeviceCreateBindGroupLayout(device_, &d);
    };
    textureLayouts_[kLayoutDraw] = layout({1, 0, 2, 0, 2});
    textureLayouts_[kLayoutComposite] = layout({0, 2, 0, 2, 0, 2});
    textureLayouts_[kLayoutBlur] = layout({0, 2});
    textureLayouts_[kLayoutUtility] = layout({0, 2});
    for (int i = 0; i < kLayouts; i++) {
      WGPUBindGroupLayout groups[2] = {uniformLayout_, textureLayouts_[i]};
      WGPUPipelineLayoutDescriptor d = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
      d.bindGroupLayoutCount = 2;
      d.bindGroupLayouts = groups;
      pipelineLayouts_[i] = wgpuDeviceCreatePipelineLayout(device_, &d);
    }
    for (int i = 0; i < 8; i++) {
      bool linear = (i & 1) != 0, mip = (i & 2) != 0, repeat = (i & 4) != 0;
      WGPUSamplerDescriptor d = WGPU_SAMPLER_DESCRIPTOR_INIT;
      d.addressModeU = d.addressModeV = d.addressModeW = repeat ? WGPUAddressMode_Repeat : WGPUAddressMode_ClampToEdge;
      d.magFilter = linear ? WGPUFilterMode_Linear : WGPUFilterMode_Nearest;
      // GL: LINEAR_MIPMAP_LINEAR when mipmapped, else the magnification filter.
      d.minFilter = mip ? WGPUFilterMode_Linear : d.magFilter;
      d.mipmapFilter = mip ? WGPUMipmapFilterMode_Linear : WGPUMipmapFilterMode_Nearest;
      d.lodMinClamp = 0;
      d.lodMaxClamp = mip ? 32.0f : 0.0f;
      d.maxAnisotropy = 1;
      samplers_[i] = wgpuDeviceCreateSampler(device_, &d);
    }
    // The device's own: mip levels, the canvas copy (both into RGBA8, no stencil).
    const char* entries[2] = {"mip", "flipCopy"};
    for (int i = 0; i < 2; i++) {
      WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
      target.format = WGPUTextureFormat_RGBA8Unorm;
      target.writeMask = WGPUColorWriteMask_All;
      WGPUFragmentState fs = WGPU_FRAGMENT_STATE_INIT;
      fs.module = modules_[3];
      fs.entryPoint = sv(entries[i]);
      fs.targetCount = 1;
      fs.targets = &target;
      WGPURenderPipelineDescriptor d = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
      d.layout = pipelineLayouts_[kLayoutUtility];
      d.vertex.module = modules_[3];
      d.vertex.entryPoint = sv("vs");
      d.primitive.topology = WGPUPrimitiveTopology_TriangleList;
      d.fragment = &fs;
      utilityPipelines_[i] = wgpuDeviceCreateRenderPipeline(device_, &d);
    }
    return true;
  }

  WGPURenderPipeline pipelineFor(PipelineId id, WGPUTextureFormat format) {
    int slot = format == WGPUTextureFormat_RGBA8Unorm ? 0 : 1;
    WGPURenderPipeline& cached = gpuPipelines_[id][static_cast<size_t>(slot)];
    if (cached) return cached;
    const PipelineDesc& p = pipelines_[id];
    int shader = static_cast<int>(p.shader);
    WGPUVertexAttribute attributes[10];
    for (uint32_t i = 0; i < 10; i++) {
      attributes[i] = WGPU_VERTEX_ATTRIBUTE_INIT;
      attributes[i].format = WGPUVertexFormat_Float32x4;
      attributes[i].offset = i * 16;
      attributes[i].shaderLocation = i;
    }
    WGPUVertexBufferLayout instances = WGPU_VERTEX_BUFFER_LAYOUT_INIT;
    instances.stepMode = WGPUVertexStepMode_Instance;
    instances.arrayStride = kInstanceStride;
    instances.attributeCount = 10;
    instances.attributes = attributes;
    WGPUBlendState premultiplied = WGPU_BLEND_STATE_INIT;
    premultiplied.color = {WGPUBlendOperation_Add, WGPUBlendFactor_One, WGPUBlendFactor_OneMinusSrcAlpha};
    premultiplied.alpha = {WGPUBlendOperation_Add, WGPUBlendFactor_One, WGPUBlendFactor_OneMinusSrcAlpha};
    WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
    target.format = format;
    target.blend = p.blend == Blend::Premultiplied ? &premultiplied : nullptr;
    target.writeMask = p.colorMask == ColorMask::All ? WGPUColorWriteMask_All : WGPUColorWriteMask_None;
    WGPUFragmentState fs = WGPU_FRAGMENT_STATE_INIT;
    fs.module = modules_[shader];
    fs.entryPoint = sv("fs");
    fs.targetCount = 1;
    fs.targets = &target;
    WGPUStencilFaceState face = WGPU_STENCIL_FACE_STATE_INIT;
    face.compare = p.stencil.enabled && p.stencil.func == StencilFunc::Equal ? WGPUCompareFunction_Equal : WGPUCompareFunction_Always;
    face.failOp = WGPUStencilOperation_Keep;
    face.depthFailOp = WGPUStencilOperation_Keep;
    face.passOp = !p.stencil.enabled                          ? WGPUStencilOperation_Keep
                  : p.stencil.pass == StencilOp::Increment ? WGPUStencilOperation_IncrementClamp
                  : p.stencil.pass == StencilOp::Decrement ? WGPUStencilOperation_DecrementClamp
                                                           : WGPUStencilOperation_Keep;
    WGPUDepthStencilState ds = WGPU_DEPTH_STENCIL_STATE_INIT;
    ds.format = WGPUTextureFormat_Stencil8;
    ds.stencilFront = face;
    ds.stencilBack = face;
    ds.stencilReadMask = 0xff;
    ds.stencilWriteMask = 0xff;
    WGPURenderPipelineDescriptor d = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    d.layout = pipelineLayouts_[shader];
    d.vertex.module = modules_[shader];
    d.vertex.entryPoint = sv("vs");
    if (p.shader == ShaderId::Shape) {
      d.vertex.bufferCount = 1;
      d.vertex.buffers = &instances;
    }
    d.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    d.primitive.cullMode = WGPUCullMode_None;
    d.depthStencil = &ds;
    d.fragment = &fs;
    cached = wgpuDeviceCreateRenderPipeline(device_, &d);
    return cached;
  }

  // Figma's compatibility check: one composite (opacity 0.5 of an orange target) checked once the GPU ran it,
  // without waiting for it (library_engine_wgpu.js reports a mismatch; the session then moves to WebGL2).
  void selfTest() {
    TargetId a = createTarget(4, 4), b = createTarget(4, 4);
    if (!a || !b) return;
    PipelineDesc pd;
    pd.shader = ShaderId::Composite;
    pd.blend = Blend::Premultiplied;
    PipelineId pipeline = createPipeline(pd);
    PassDesc pass;
    pass.target = a;
    pass.clear[0] = 1.0f;
    pass.clear[1] = 0.5f;
    pass.clear[2] = 0.0f;
    pass.clear[3] = 1.0f;
    pass.viewport = {0, 0, 4, 4};
    if (beginPass(pass)) endPass();
    pass.target = b;
    pass.clear[0] = pass.clear[1] = pass.clear[2] = pass.clear[3] = 0.0f;
    if (beginPass(pass)) {
      DrawCall call;
      call.pipeline = pipeline;
      const float u[11][4] = {{0.5f, 0, -1, 0}, {0, -0.5f, 1, 0}, {0, 0, 4, 4}, {0, 0, 4, 1}, {}, {}, {}, {0.5f, 0, 0, 0}, {}, {}, {}};
      std::memcpy(call.uniforms, u, sizeof u);
      call.textures[0] = targetTexture(a);
      draw(call);
      endPass();
    }
    flush();
    engine_wgpu_check_async(device_, textures_[targets_[b].texture].gpu, 1, 1, 128, 64, 0, 128);
    destroyTarget(a);
    destroyTarget(b);
  }

  WGPUInstance instance_ = nullptr;
  WGPUDevice device_ = nullptr;
  WGPUQueue queue_ = nullptr;
  WGPUSurface surface_ = nullptr;
  WGPUTextureFormat canvasFormat_ = WGPUTextureFormat_RGBA8Unorm;
  bool p3_ = false;
  int32_t lost_ = 0;  // set by library_engine_wgpu.js when the device is lost
  uint32_t maxTexture_ = 8192;

  WGPUShaderModule modules_[4] = {};
  WGPUBindGroupLayout uniformLayout_ = nullptr;
  WGPUBindGroupLayout textureLayouts_[kLayouts] = {};
  WGPUPipelineLayout pipelineLayouts_[kLayouts] = {};
  WGPUSampler samplers_[8] = {};
  WGPURenderPipeline utilityPipelines_[2] = {};
  Texture dummy_;
  uint64_t nextSerial_ = 1;

  std::vector<Buffer> buffers_{Buffer{}};      // index = BufferId; 0 unused
  std::vector<Texture> textures_{Texture{}};   // index = TextureId; 0 unused
  std::vector<Target> targets_{Target{}};      // index = TargetId; 0 = the canvas
  std::vector<PipelineDesc> pipelines_{PipelineDesc{}};
  std::vector<std::array<WGPURenderPipeline, 2>> gpuPipelines_{{nullptr, nullptr}};  // [RGBA8 target, canvas]
  std::unordered_map<GroupKey, WGPUBindGroup, GroupKeyHash> bindGroups_;

  WGPUCommandEncoder encoder_ = nullptr;
  WGPURenderPassEncoder pass_ = nullptr;
  PassDesc pass_desc_;
  bool inPass_ = false;  // between beginPass and endPass (the render pass itself may be closed for a copy)
  int attachW_ = 0, attachH_ = 0;
  PassState st_;

  std::vector<Chunk> chunks_;
  size_t chunk_ = 0;
  float lastUniform_[13][4] = {};
  size_t lastChunk_ = 0;
  uint32_t lastOffset_ = 0;
  bool lastUniformValid_ = false;

  WGPUTexture canvasTexture_ = nullptr;
  WGPUTextureView canvasView_ = nullptr;
  int canvasW_ = 0, canvasH_ = 0;
  WGPUTexture canvasStencil_ = nullptr;
  WGPUTextureView canvasStencilView_ = nullptr;
  int canvasStencilW_ = 0, canvasStencilH_ = 0;

  std::vector<WGPUBuffer> garbageBuffers_;
  std::vector<WGPUTexture> garbageTextures_;
};

}  // namespace

bool webGPUOffered() { return engine_wgpu_offered() != 0; }

std::unique_ptr<Device> createWebGPUDevice(const char* selector) {
  if (!webGPUOffered()) return nullptr;
  auto device = std::make_unique<WebGPUDevice>();
  if (!device->init(selector)) return nullptr;
  return device;
}

}  // namespace eng::gfx
