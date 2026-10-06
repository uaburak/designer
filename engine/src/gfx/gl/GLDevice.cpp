#include "gfx/gl/GLDevice.h"

#include <GLES3/gl3.h>
#include <emscripten/html5.h>

#include <cstdio>
#include <vector>

#include "gfx/gl/Shaders.h"

namespace eng::gfx {

namespace {

GLuint compile(GLenum type, const char* source) {
  GLuint s = glCreateShader(type);
  glShaderSource(s, 1, &source, nullptr);
  glCompileShader(s);
  GLint ok = 0;
  glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[1024];
    glGetShaderInfoLog(s, sizeof log, nullptr, log);
    std::fprintf(stderr, "engine: shader failed to compile: %s\n", log);
    glDeleteShader(s);
    return 0;
  }
  return s;
}

GLuint link(const char* vertex, const char* fragment) {
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
    char log[1024];
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
    attrs.alpha = false;  // the engine paints the page background
    attrs.depth = false;
    // Interim: frame clipping uses the default framebuffer's stencil until the
    // engine has its own MSAA targets (docs/engine.md §6.1 asks stencil=false then).
    attrs.stencil = true;
    attrs.antialias = false;  // shapes are anti-aliased analytically
    attrs.premultipliedAlpha = true;
    attrs.preserveDrawingBuffer = false;
    attrs.powerPreference = EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;
    context_ = emscripten_webgl_create_context(selector, &attrs);
    if (context_ <= 0) {
      context_ = 0;
      return false;
    }
    emscripten_webgl_make_context_current(context_);
    shape_.program = link(gl::kVertexShader, gl::kFragmentShader);
    if (!shape_.program) return false;
    shape_.row0 = glGetUniformLocation(shape_.program, "u_row0");
    shape_.row1 = glGetUniformLocation(shape_.program, "u_row1");
    shape_.stencilPass = glGetUniformLocation(shape_.program, "u_stencilPass");
    glGenVertexArrays(1, &vao_);
    glBindVertexArray(vao_);
    for (GLuint i = 0; i < 6; i++) {
      glEnableVertexAttribArray(i);
      glVertexAttribDivisor(i, 1);
    }
    return true;
  }

  Caps caps() const override {
    Caps c;
    GLint size = 4096;
    glGetIntegerv(GL_MAX_TEXTURE_SIZE, &size);
    c.maxTextureSize = static_cast<uint32_t>(size);
    return c;
  }

  BufferId createBuffer(BufferKind kind, uint32_t bytes, Usage usage) override {
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
    Buffer& b = buffers_.at(id);
    if (bytes <= b.size) return;
    b.size = bytes;
    glBindBuffer(b.target, b.gl);
    glBufferData(b.target, bytes, nullptr, b.usage);
  }

  void write(BufferId id, uint32_t offset, std::span<const uint8_t> data) override {
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
    height_ = pass.viewport.h;
    glViewport(pass.viewport.x, pass.viewport.y, pass.viewport.w, pass.viewport.h);
    glDisable(GL_SCISSOR_TEST);
    glDisable(GL_DEPTH_TEST);
    glDisable(GL_CULL_FACE);
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    glStencilMask(0xff);
    glClearColor(pass.clear[0], pass.clear[1], pass.clear[2], pass.clear[3]);
    glClearStencil(pass.clearStencil);
    glClear(GL_COLOR_BUFFER_BIT | GL_STENCIL_BUFFER_BIT);
    glBindVertexArray(vao_);
    return true;
  }

  void draw(const DrawCall& call) override {
    if (!call.instanceCount || call.pipeline == 0) return;
    const PipelineDesc& p = pipelines_.at(call.pipeline);
    const Buffer& b = buffers_.at(call.instances.buffer);

    glUseProgram(shape_.program);
    glBindBuffer(GL_ARRAY_BUFFER, b.gl);
    const GLsizei stride = 6 * 4 * sizeof(float);  // render/ShapeInstance.h
    for (GLuint i = 0; i < 6; i++)
      glVertexAttribPointer(i, 4, GL_FLOAT, GL_FALSE, stride,
                            reinterpret_cast<const void*>(static_cast<uintptr_t>(call.instances.offset + i * 4 * sizeof(float))));
    glUniform3f(shape_.row0, call.uniforms[0], call.uniforms[1], call.uniforms[2]);
    glUniform3f(shape_.row1, call.uniforms[3], call.uniforms[4], call.uniforms[5]);

    if (p.blend == Blend::Premultiplied) {
      glEnable(GL_BLEND);
      glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
    } else {
      glDisable(GL_BLEND);
    }
    bool colour = p.colorMask == ColorMask::All;
    glColorMask(colour, colour, colour, colour);
    glUniform1i(shape_.stencilPass, colour ? 0 : 1);

    if (p.stencil.enabled) {
      glEnable(GL_STENCIL_TEST);
      glStencilFunc(p.stencil.func == StencilFunc::Equal ? GL_EQUAL : GL_ALWAYS, call.stencilRef, 0xff);
      GLenum op = p.stencil.pass == StencilOp::Increment ? GL_INCR : p.stencil.pass == StencilOp::Decrement ? GL_DECR : GL_KEEP;
      glStencilOp(GL_KEEP, GL_KEEP, op);
    } else {
      glDisable(GL_STENCIL_TEST);
    }

    if (call.scissorEnabled) {
      glEnable(GL_SCISSOR_TEST);
      glScissor(call.scissor.x, height_ - call.scissor.y - call.scissor.h, call.scissor.w, call.scissor.h);
    } else {
      glDisable(GL_SCISSOR_TEST);
    }
    glDrawArraysInstanced(GL_TRIANGLES, 0, static_cast<GLsizei>(call.count), static_cast<GLsizei>(call.instanceCount));
  }

  void endPass() override {
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    glDisable(GL_STENCIL_TEST);
    glDisable(GL_SCISSOR_TEST);
  }

  void submit() override {}  // the browser presents the canvas after the task

  void destroyBuffer(BufferId id) override {
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
  struct ShapeProgram {
    GLuint program = 0;
    GLint row0 = -1, row1 = -1, stencilPass = -1;
  };

  EMSCRIPTEN_WEBGL_CONTEXT_HANDLE context_ = 0;
  ShapeProgram shape_;
  GLuint vao_ = 0;
  std::vector<Buffer> buffers_{Buffer{}};          // index = BufferId; 0 unused
  std::vector<PipelineDesc> pipelines_{PipelineDesc{}};
  int height_ = 0;
};

}  // namespace

std::unique_ptr<Device> createWebGL2Device(const char* selector) {
  auto device = std::make_unique<WebGL2Device>();
  if (!device->init(selector)) return nullptr;
  return device;
}

}  // namespace eng::gfx
