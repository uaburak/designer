#include "gfx/gl/GLDevice.h"

#include <GLES3/gl3.h>
#include <emscripten/em_js.h>
#include <emscripten/html5.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "gfx/gl/Shaders.h"

// ImageBitmaps never cross into Wasm memory: TS keeps them in Module.engineBitmaps and the texture is filled
// from JavaScript (texSubImage2D(ImageBitmap)); `texture` is the GL texture name.
EM_JS(int, eng_upload_bitmap, (unsigned texture, unsigned bitmapId), {
  var bitmaps = Module["engineBitmaps"];
  var bitmap = bitmaps && bitmaps[bitmapId];
  if (!bitmap || !GLctx || !GL.textures[texture]) return 0;
  GLctx.bindTexture(GLctx.TEXTURE_2D, GL.textures[texture]);
  GLctx.texSubImage2D(GLctx.TEXTURE_2D, 0, 0, 0, GLctx.RGBA, GLctx.UNSIGNED_BYTE, bitmap);
  return 1;
});

namespace eng::gfx {

namespace {

GLuint compile(GLenum type, const std::string& source) {
  GLuint s = glCreateShader(type);
  const char* src = source.c_str();
  glShaderSource(s, 1, &src, nullptr);
  glCompileShader(s);
  GLint ok = 0;
  glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[2048];
    glGetShaderInfoLog(s, sizeof log, nullptr, log);
    std::fprintf(stderr, "engine: shader failed to compile: %s\n", log);
    glDeleteShader(s);
    return 0;
  }
  return s;
}

GLuint link(const std::string& vertex, const std::string& fragment) {
  GLuint vs = compile(GL_VERTEX_SHADER, vertex), fs = compile(GL_FRAGMENT_SHADER, fragment);
  if (!vs || !fs) return 0;
  GLuint p = glCreateProgram();
  glAttachShader(p, vs);
  glAttachShader(p, fs);
  glLinkProgram(p);
  glDeleteShader(vs);
  glDeleteShader(fs);
  GLint ok = 0;
  glGetProgramiv(p, GL_LINK_STATUS, &ok);
  if (!ok) {
    char log[2048];
    glGetProgramInfoLog(p, sizeof log, nullptr, log);
    std::fprintf(stderr, "engine: program failed to link: %s\n", log);
    glDeleteProgram(p);
    return 0;
  }
  return p;
}

class WebGL2Device final : public Device {
 public:
  ~WebGL2Device() override {
    if (context_) emscripten_webgl_destroy_context(context_);
  }

  bool init(const char* selector) {
    EmscriptenWebGLContextAttributes attrs;
    emscripten_webgl_init_context_attributes(&attrs);
    attrs.majorVersion = 2;
    attrs.minorVersion = 0;
    // An RGBA canvas (the engine paints the opaque page background itself): backdrops (blend modes,
    // background blur) are copied from it into RGBA8 textures, which WebGL2 refuses from an RGB framebuffer.
    attrs.alpha = true;
    attrs.depth = false;
    // Frame clipping uses the stencil of whatever target is drawn into (the canvas included).
    attrs.stencil = true;
    attrs.antialias = false;  // everything is anti-aliased analytically
    attrs.premultipliedAlpha = true;
    attrs.preserveDrawingBuffer = false;
    attrs.powerPreference = EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;
    context_ = emscripten_webgl_create_context(selector, &attrs);
    if (context_ <= 0) {
      context_ = 0;
      return false;
    }
    emscripten_webgl_make_context_current(context_);
    using namespace gl;
    if (!build(programs_[0], kDrawVertex, std::string(kDrawFragmentHead) + kPaintFunctions + kDrawFragmentBody)) return false;
    if (!build(programs_[1], kCompositeVertex, kCompositeFragment)) return false;
    if (!build(programs_[2], kBlurVertex, kBlurFragment)) return false;
    glGenVertexArrays(1, &vao_);
    glBindVertexArray(vao_);
    for (GLuint i = 0; i < kAttributes; i++) glVertexAttribDivisor(i, 1);
    return true;
  }

  MemoryStats memory() const override {
    MemoryStats m;
    for (size_t i = 1; i < textures_.size(); i++) {
      const Texture& t = textures_[i];
      if (!t.gl) continue;
      m.textures++;
      uint64_t b = static_cast<uint64_t>(t.width) * t.height * (t.format == TextureFormat::RGBA32F ? 16 : 4);
      m.bytes += t.mipmaps ? b * 4 / 3 : b;
    }
    for (size_t i = 1; i < targets_.size(); i++) {
      const Target& t = targets_[i];
      if (!t.framebuffer) continue;
      m.targets++;
      m.bytes += static_cast<uint64_t>(t.width) * t.height * 4;  // depth-stencil (the colour is a texture)
    }
    for (size_t i = 1; i < buffers_.size(); i++) {
      if (!buffers_[i].gl) continue;
      m.buffers++;
      m.bytes += buffers_[i].size;
    }
    return m;
  }

  Caps caps() const override {
    Caps c;
    GLint size = 4096;
    glGetIntegerv(GL_MAX_TEXTURE_SIZE, &size);
    c.maxTextureSize = static_cast<uint32_t>(size);
    return c;
  }

  BufferId createBuffer(BufferKind kind, uint32_t bytes, Usage usage) override {
    forget();  // binds behind the draws' back
    Buffer b;
    glGenBuffers(1, &b.gl);
    b.target = kind == BufferKind::Index ? GL_ELEMENT_ARRAY_BUFFER : kind == BufferKind::Uniform ? GL_UNIFORM_BUFFER : GL_ARRAY_BUFFER;
    b.usage = usage == Usage::Static ? GL_STATIC_DRAW : usage == Usage::Dynamic ? GL_DYNAMIC_DRAW : GL_STREAM_DRAW;
    b.size = bytes;
    glBindBuffer(b.target, b.gl);
    glBufferData(b.target, bytes, nullptr, b.usage);
    buffers_.push_back(b);
    return static_cast<BufferId>(buffers_.size() - 1);
  }

  void reserve(BufferId id, uint32_t bytes) override {
    forget();  // binds behind the draws' back
    Buffer& b = buffers_.at(id);
    if (bytes <= b.size) return;
    b.size = bytes;
    glBindBuffer(b.target, b.gl);
    glBufferData(b.target, bytes, nullptr, b.usage);
  }

  void write(BufferId id, uint32_t offset, std::span<const uint8_t> data) override {
    forget();  // binds behind the draws' back
    Buffer& b = buffers_.at(id);
    glBindBuffer(b.target, b.gl);
    // Writing from the start: orphan the old store so the GPU never waits on last frame's draws.
    if (offset == 0) glBufferData(b.target, b.size, nullptr, b.usage);
    glBufferSubData(b.target, offset, static_cast<GLsizeiptr>(data.size()), data.data());
  }

  PipelineId createPipeline(const PipelineDesc& desc) override {
    pipelines_.push_back(desc);
    return static_cast<PipelineId>(pipelines_.size() - 1);
  }

  bool beginPass(const PassDesc& pass) override {
    if (!context_ || emscripten_is_webgl_context_lost(context_)) return false;
    emscripten_webgl_make_context_current(context_);
    GLuint fb = 0;
    if (pass.target) {
      if (pass.target >= targets_.size() || !targets_[pass.target].framebuffer) return false;
      fb = targets_[pass.target].framebuffer;
    }
    glBindFramebuffer(GL_FRAMEBUFFER, fb);
    bound_ = fb;
    height_ = pass.viewport.h;
    glViewport(pass.viewport.x, pass.viewport.y, pass.viewport.w, pass.viewport.h);
    glDisable(GL_SCISSOR_TEST);
    glDisable(GL_DEPTH_TEST);
    glDisable(GL_CULL_FACE);
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    glStencilMask(0xff);
    if (!pass.keep) {
      glClearColor(pass.clear[0], pass.clear[1], pass.clear[2], pass.clear[3]);
      glClearStencil(pass.clearStencil);
      glClear(GL_COLOR_BUFFER_BIT | GL_STENCIL_BUFFER_BIT);
    }
    glBindVertexArray(vao_);
    forget();
    return true;
  }

  // What the last draws left bound (draws only re-send what changes: every GL call crosses into JavaScript and
  // the browser's command buffer). Anything that binds behind the draws' back (texture uploads, copies, other
  // framebuffers) calls forget().
  void forget() {
    state_ = State{};
  }

  void draw(const DrawCall& call) override {
    if (!call.instanceCount || call.pipeline == 0) return;
    const PipelineDesc& p = pipelines_.at(call.pipeline);
    int index = static_cast<int>(p.shader);
    const Program& prog = programs_[index];
    if (!prog.program) return;
    State& st = state_;
    if (st.program != prog.program) {
      glUseProgram(prog.program);
      st.program = prog.program;
    }
    const bool instanced = p.shader == ShaderId::Shape;
    if (instanced) {
      const Buffer& b = buffers_.at(call.instances.buffer);
      if (st.attributes != 1) {
        for (GLuint i = 0; i < kAttributes; i++) glEnableVertexAttribArray(i);
        st.attributes = 1;
      }
      const uint32_t instOffset = call.instances.offset;
      if (st.instanceBuffer != b.gl || st.instanceOffset != instOffset) {
        glBindBuffer(GL_ARRAY_BUFFER, b.gl);
        const GLsizei stride = kAttributes * 4 * sizeof(float);  // render/DrawInstance.h
        for (GLuint i = 0; i < kAttributes; i++)
          glVertexAttribPointer(i, 4, GL_FLOAT, GL_FALSE, stride,
                                reinterpret_cast<const void*>(static_cast<uintptr_t>(instOffset + i * 4 * sizeof(float))));
        st.instanceBuffer = b.gl;
        st.instanceOffset = instOffset;
      }
    } else if (st.attributes != 0) {
      for (GLuint i = 0; i < kAttributes; i++) glDisableVertexAttribArray(i);
      st.attributes = 0;
    }
    int pi = index;
    if (!st.uniformsValid[pi] || std::memcmp(st.uniforms[pi], call.uniforms, sizeof call.uniforms) != 0) {
      glUniform4fv(prog.v, kUniformSlots, &call.uniforms[0][0]);
      std::memcpy(st.uniforms[pi], call.uniforms, sizeof call.uniforms);
      st.uniformsValid[pi] = true;
    }
    for (int t = 0; t < 3; t++) {
      TextureId id = call.textures[t];
      GLuint gl = id && id < textures_.size() ? textures_[id].gl : 0;
      if (st.textures[t] == gl && st.texturesValid) continue;
      glActiveTexture(GL_TEXTURE0 + t);
      glBindTexture(GL_TEXTURE_2D, gl);
      st.textures[t] = gl;
    }
    st.texturesValid = true;
    int blend = p.blend == Blend::Premultiplied ? 1 : 0;
    if (st.blend != blend) {
      if (blend) {
        glEnable(GL_BLEND);
        glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
      } else {
        glDisable(GL_BLEND);
      }
      st.blend = blend;
    }
    bool colour = p.colorMask == ColorMask::All;
    if (st.colour != (colour ? 1 : 0)) {
      glColorMask(colour, colour, colour, colour);
      st.colour = colour ? 1 : 0;
    }
    if (prog.stencilPass >= 0 && st.stencilPass[pi] != (colour ? 0 : 1)) {
      glUniform1i(prog.stencilPass, colour ? 0 : 1);
      st.stencilPass[pi] = colour ? 0 : 1;
    }
    if (p.stencil.enabled) {
      if (st.stencil != 1) {
        glEnable(GL_STENCIL_TEST);
        st.stencil = 1;
      }
      int func = p.stencil.func == StencilFunc::Equal ? GL_EQUAL : GL_ALWAYS;
      if (st.stencilFunc != func || st.stencilRef != call.stencilRef) {
        glStencilFunc(static_cast<GLenum>(func), call.stencilRef, 0xff);
        st.stencilFunc = func;
        st.stencilRef = call.stencilRef;
      }
      int op = p.stencil.pass == StencilOp::Increment ? GL_INCR : p.stencil.pass == StencilOp::Decrement ? GL_DECR : GL_KEEP;
      if (st.stencilOp != op) {
        glStencilOp(GL_KEEP, GL_KEEP, static_cast<GLenum>(op));
        st.stencilOp = op;
      }
    } else if (st.stencil != 0) {
      glDisable(GL_STENCIL_TEST);
      st.stencil = 0;
    }
    if (call.scissorEnabled) {
      if (st.scissor != 1) {
        glEnable(GL_SCISSOR_TEST);
        st.scissor = 1;
      }
      int box[4] = {call.scissor.x, height_ - call.scissor.y - call.scissor.h, std::max(0, call.scissor.w), std::max(0, call.scissor.h)};
      if (std::memcmp(box, st.scissorBox, sizeof box) != 0) {
        glScissor(box[0], box[1], box[2], box[3]);
        std::memcpy(st.scissorBox, box, sizeof box);
      }
    } else if (st.scissor != 0) {
      glDisable(GL_SCISSOR_TEST);
      st.scissor = 0;
    }
    if (instanced)
      glDrawArraysInstanced(GL_TRIANGLES, 0, static_cast<GLsizei>(call.count), static_cast<GLsizei>(call.instanceCount));
    else
      glDrawArrays(GL_TRIANGLES, 0, 6);
  }

  void endPass() override {
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    glDisable(GL_STENCIL_TEST);
    glDisable(GL_SCISSOR_TEST);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    bound_ = 0;
    forget();
  }

  TargetId createTarget(uint32_t width, uint32_t height) override {
    forget();  // binds behind the draws' back
    if (!context_ || emscripten_is_webgl_context_lost(context_) || !width || !height) return 0;
    emscripten_webgl_make_context_current(context_);
    Target t;
    t.width = width;
    t.height = height;
    TextureDesc d;
    d.format = TextureFormat::RGBA8;
    d.width = width;
    d.height = height;
    t.texture = createTexture(d);
    if (!t.texture) return 0;
    glGenFramebuffers(1, &t.framebuffer);
    glBindFramebuffer(GL_FRAMEBUFFER, t.framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, textures_[t.texture].gl, 0);
    glGenRenderbuffers(1, &t.stencil);
    glBindRenderbuffer(GL_RENDERBUFFER, t.stencil);
    glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH24_STENCIL8, static_cast<GLsizei>(width), static_cast<GLsizei>(height));
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_RENDERBUFFER, t.stencil);
    bool complete = glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
    // Back to whatever pass is going on.
    glBindFramebuffer(GL_FRAMEBUFFER, bound_);
    glBindRenderbuffer(GL_RENDERBUFFER, 0);
    if (!complete) {
      release(t);
      return 0;
    }
    for (size_t i = 1; i < targets_.size(); i++)
      if (!targets_[i].framebuffer) {
        targets_[i] = t;
        return static_cast<TargetId>(i);
      }
    targets_.push_back(t);
    return static_cast<TargetId>(targets_.size() - 1);
  }

  void destroyTarget(TargetId id) override {
    forget();  // binds behind the draws' back
    if (!id || id >= targets_.size()) return;
    release(targets_[id]);
  }

  TextureId targetTexture(TargetId id) override { return id && id < targets_.size() ? targets_[id].texture : 0; }

  bool readPixels(TargetId id, IRect rect, std::span<uint8_t> rgba8) override {
    forget();  // binds behind the draws' back
    if (!id || id >= targets_.size() || !targets_[id].framebuffer) return false;
    size_t row = static_cast<size_t>(rect.w) * 4;
    if (rect.w <= 0 || rect.h <= 0 || rgba8.size() < row * static_cast<size_t>(rect.h)) return false;
    const Target& t = targets_[id];
    glBindFramebuffer(GL_FRAMEBUFFER, t.framebuffer);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    // GL's rows run bottom to top.
    glReadPixels(rect.x, static_cast<GLint>(t.height) - rect.y - rect.h, rect.w, rect.h, GL_RGBA, GL_UNSIGNED_BYTE, rgba8.data());
    glBindFramebuffer(GL_FRAMEBUFFER, bound_);
    std::vector<uint8_t> tmp(row);
    for (int y = 0; y < rect.h / 2; y++) {
      uint8_t* a = rgba8.data() + static_cast<size_t>(y) * row;
      uint8_t* b = rgba8.data() + static_cast<size_t>(rect.h - 1 - y) * row;
      std::copy(a, a + row, tmp.data());
      std::copy(b, b + row, a);
      std::copy(tmp.data(), tmp.data() + row, b);
    }
    return true;
  }

  void copyToTexture(TextureId texture, IRect rect) override {
    if (!texture || texture >= textures_.size() || !textures_[texture].gl || rect.w <= 0 || rect.h <= 0) return;
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, textures_[texture].gl);
    int w = std::min<int>(rect.w, static_cast<int>(textures_[texture].width));
    int h = std::min<int>(rect.h, static_cast<int>(textures_[texture].height));
    glCopyTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, rect.x, height_ - rect.y - rect.h, w, h);
    forget();
  }

  TextureId createTexture(const TextureDesc& desc) override {
    forget();  // binds behind the draws' back
    if (!context_ || emscripten_is_webgl_context_lost(context_) || !desc.width || !desc.height) return 0;
    emscripten_webgl_make_context_current(context_);
    Texture t;
    t.width = desc.width;
    t.height = desc.height;
    t.format = desc.format;
    t.mipmaps = desc.mipmaps && desc.format == TextureFormat::RGBA8;
    glGenTextures(1, &t.gl);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, t.gl);
    if (desc.format == TextureFormat::RGBA32F) {
      glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA32F, static_cast<GLsizei>(desc.width), static_cast<GLsizei>(desc.height));
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    } else {
      GLsizei levels = 1;
      if (desc.mipmaps)
        levels = static_cast<GLsizei>(std::floor(std::log2(static_cast<double>(std::max(desc.width, desc.height))))) + 1;
      glTexStorage2D(GL_TEXTURE_2D, levels, GL_RGBA8, static_cast<GLsizei>(desc.width), static_cast<GLsizei>(desc.height));
      GLint mag = desc.linear ? GL_LINEAR : GL_NEAREST;
      GLint min = desc.mipmaps ? GL_LINEAR_MIPMAP_LINEAR : mag;
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, min);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, mag);
    }
    GLint wrap = desc.repeat ? GL_REPEAT : GL_CLAMP_TO_EDGE;
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, wrap);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, wrap);
    glBindTexture(GL_TEXTURE_2D, 0);
    for (size_t i = 1; i < textures_.size(); i++)
      if (!textures_[i].gl) {
        textures_[i] = t;
        return static_cast<TextureId>(i);
      }
    textures_.push_back(t);
    return static_cast<TextureId>(textures_.size() - 1);
  }

  void writeTexture(TextureId id, IRect rect, std::span<const uint8_t> data) override {
    forget();  // binds behind the draws' back
    if (!id || id >= textures_.size() || !textures_[id].gl) return;
    emscripten_webgl_make_context_current(context_);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, textures_[id].gl);
    if (textures_[id].format == TextureFormat::RGBA32F) {
      glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
      glTexSubImage2D(GL_TEXTURE_2D, 0, rect.x, rect.y, rect.w, rect.h, GL_RGBA, GL_FLOAT, data.data());
    } else {
      glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
      glTexSubImage2D(GL_TEXTURE_2D, 0, rect.x, rect.y, rect.w, rect.h, GL_RGBA, GL_UNSIGNED_BYTE, data.data());
    }
    glBindTexture(GL_TEXTURE_2D, 0);
  }

  void generateMipmaps(TextureId id) override {
    forget();  // binds behind the draws' back
    if (!id || id >= textures_.size() || !textures_[id].gl) return;
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, textures_[id].gl);
    glGenerateMipmap(GL_TEXTURE_2D);
    glBindTexture(GL_TEXTURE_2D, 0);
  }

  bool uploadBitmap(TextureId id, uint32_t bitmapId) override {
    forget();  // binds behind the draws' back
    if (!id || id >= textures_.size() || !textures_[id].gl) return false;
    emscripten_webgl_make_context_current(context_);
    bool ok = eng_upload_bitmap(textures_[id].gl, bitmapId) != 0;
    glBindTexture(GL_TEXTURE_2D, 0);
    return ok;
  }

  void destroyTexture(TextureId id) override {
    forget();  // binds behind the draws' back
    if (!id || id >= textures_.size() || !textures_[id].gl) return;
    glDeleteTextures(1, &textures_[id].gl);
    textures_[id] = Texture{};
  }

  void submit() override {}  // the browser presents the canvas after the task

  void destroyBuffer(BufferId id) override {
    forget();  // binds behind the draws' back
    Buffer& b = buffers_.at(id);
    if (b.gl) glDeleteBuffers(1, &b.gl);
    b.gl = 0;
  }

 private:
  struct Buffer {
    GLuint gl = 0;
    GLenum target = GL_ARRAY_BUFFER, usage = GL_STREAM_DRAW;
    uint32_t size = 0;
  };
  struct Target {
    GLuint framebuffer = 0, stencil = 0;
    TextureId texture = 0;
    uint32_t width = 0, height = 0;
  };
  void release(Target& t) {
    if (t.framebuffer) glDeleteFramebuffers(1, &t.framebuffer);
    if (t.stencil) glDeleteRenderbuffers(1, &t.stencil);
    if (t.texture) destroyTexture(t.texture);
    t = Target{};
  }
  struct Program {
    GLuint program = 0;
    GLint v = -1, stencilPass = -1;
  };
  bool build(Program& p, const char* vertex, const std::string& fragment) {
    p.program = link(vertex, fragment);
    if (!p.program) return false;
    p.v = glGetUniformLocation(p.program, "u_v");
    p.stencilPass = glGetUniformLocation(p.program, "u_stencilPass");
    glUseProgram(p.program);
    const char* samplers[3] = {"u_t0", "u_t1", "u_t2"};
    for (int i = 0; i < 3; i++) {
      GLint loc = glGetUniformLocation(p.program, samplers[i]);
      if (loc >= 0) glUniform1i(loc, i);
    }
    return true;
  }
  struct Texture {
    GLuint gl = 0;
    uint32_t width = 0, height = 0;
    TextureFormat format = TextureFormat::RGBA8;
    bool mipmaps = false;
  };

  static constexpr GLuint kAttributes = 10;  // vec4s per instance (render/DrawInstance.h)
  struct State {
    GLuint program = 0;
    int attributes = -1;  // −1: unknown
    GLuint instanceBuffer = 0;
    uint32_t instanceOffset = 0xffffffffu;
    float uniforms[3][kUniformSlots][4] = {};
    bool uniformsValid[3] = {false, false, false};
    int stencilPass[3] = {-1, -1, -1};
    GLuint textures[3] = {0, 0, 0};
    bool texturesValid = false;
    int blend = -1, colour = -1, stencil = -1, stencilFunc = -1, stencilOp = -1, scissor = -1;
    int stencilRef = -1;
    int scissorBox[4] = {-1, -1, -1, -1};
  };

  EMSCRIPTEN_WEBGL_CONTEXT_HANDLE context_ = 0;
  Program programs_[3];
  State state_;
  std::vector<Texture> textures_{Texture{}};  // index = TextureId; 0 unused
  GLuint vao_ = 0;
  std::vector<Buffer> buffers_{Buffer{}};          // index = BufferId; 0 unused
  std::vector<PipelineDesc> pipelines_{PipelineDesc{}};
  std::vector<Target> targets_{Target{}};          // index = TargetId; 0 = the canvas
  int height_ = 0;
  GLuint bound_ = 0;  // the framebuffer of the pass going on (0: none, or the canvas)
};

}  // namespace

std::unique_ptr<Device> createWebGL2Device(const char* selector) {
  auto device = std::make_unique<WebGL2Device>();
  if (!device->init(selector)) return nullptr;
  return device;
}

}  // namespace eng::gfx
