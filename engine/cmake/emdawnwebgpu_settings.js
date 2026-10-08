// emdawnwebgpu_engine.py: the pinned Dawn release's library_webgpu.js still reads the USE_WEBGPU setting, which
// Emscripten has removed; it is defined (off) here, before that library.
{{{
  globalThis.USE_WEBGPU ??= 0;
  null;
}}}
