// The WebGPU backend's JavaScript side (gfx/wgpu/WGPUDevice.cpp): what emdawnwebgpu's webgpu.h bindings don't
// cover, written against the browser's API directly, as Figma did where Emscripten's bindings fell short
// (docs/research/figma/R10-webgpu.md).
//
// - The GPUDevice is requested by TypeScript before the engine starts (WebGPU's adapter and device requests are
//   promises; the engine's calls are synchronous): Module.engineGpuDevice. engine_wgpu_import_device hands it to
//   webgpu.h and watches it: a lost device or a failed self test calls
//   Module.onEngineGfxFailure(selector, reason) — TypeScript then moves the canvas to WebGL2 (Figma's dynamic
//   fallback).
// - ImageBitmaps (Module.engineBitmaps) go to textures with copyExternalImageToTexture.
// - Readback is synchronous for the engine's callers (thumbnails, exports): the texture is copied into a WebGPU
//   OffscreenCanvas whose image a 2D canvas reads (the browser waits for the GPU there, as glReadPixels does).
addToLibrary({
  $engineWgpu: {
    readCanvas: null,
    readContext: null,
    read2d: null,
    // Device id → what it was imported with.
    devices: {},
    fail(selector, reason) {
      console.warn(`[engine] WebGPU: ${reason}`);
      var cb = Module['onEngineGfxFailure'];
      if (cb) setTimeout(() => cb(selector, reason), 0);
    },
  },

  engine_wgpu_offered: () => (Module['engineGpuDevice'] && typeof navigator != 'undefined' && navigator.gpu) ? 1 : 0,

  // The device for the canvas `selector` (0: none offered). `lostFlag`: an int32 set to 1 when the device is lost.
  engine_wgpu_import_device__deps: ['$WebGPU', '$engineWgpu'],
  engine_wgpu_import_device: (selectorPtr, lostFlag) => {
    var device = Module['engineGpuDevice'];
    if (!device) return 0;
    var selector = UTF8ToString(selectorPtr);
    var id = WebGPU.importJsDevice(device);
    engineWgpu.devices[id] = { device, selector, alive: true };
    device.lost.then((info) => {
      var entry = engineWgpu.devices[id];
      if (!entry || !entry.alive) return;
      HEAP32[lostFlag >> 2] = 1;
      // Lost while the engine still draws with it (the engine forgets it before destroying anything): even
      // 'destroyed' then means someone else ended it.
      engineWgpu.fail(selector, `device lost (${info.reason}): ${info.message}`);
    });
    if (!device.engineErrorHandler) {
      device.engineErrorHandler = true;
      device.addEventListener('uncapturederror', (e) => console.warn(`[engine] WebGPU error: ${e.error && e.error.message}`));
    }
    return id;
  },

  // The device is no longer the engine's (it was destroyed, or another backend took over): its loss means nothing.
  engine_wgpu_forget_device__deps: ['$engineWgpu'],
  engine_wgpu_forget_device: (id) => {
    var entry = engineWgpu.devices[id];
    if (entry) entry.alive = false;
    delete engineWgpu.devices[id];
  },

  // 1: the canvas prefers bgra8unorm (macOS, Windows), 0: rgba8unorm.
  engine_wgpu_preferred_bgra: () => (navigator.gpu.getPreferredCanvasFormat() === 'bgra8unorm' ? 1 : 0),

  // 1 when the document is Display P3 (Engine.ts sets Module.engineColorSpace, as it sets the WebGL canvas's).
  engine_wgpu_display_p3: () => (Module['engineColorSpace'] === 'display-p3' ? 1 : 0),

  engine_wgpu_upload_bitmap__deps: ['$WebGPU'],
  engine_wgpu_upload_bitmap: (devicePtr, texturePtr, bitmapId) => {
    var bitmaps = Module['engineBitmaps'];
    var bitmap = bitmaps && bitmaps[bitmapId];
    var device = WebGPU.getJsObject(devicePtr);
    var texture = WebGPU.getJsObject(texturePtr);
    if (!bitmap || !device || !texture) return 0;
    try {
      device.queue.copyExternalImageToTexture({ source: bitmap }, {
        texture, premultipliedAlpha: true, colorSpace: Module['engineColorSpace'] === 'display-p3' ? 'display-p3' : 'srgb',
      }, [Math.min(bitmap.width, texture.width), Math.min(bitmap.height, texture.height)]);
    } catch (e) {
      console.warn(`[engine] WebGPU: image upload failed: ${e}`);
      return 0;
    }
    return 1;
  },

  // Copies x, y, w × h of the texture (memory rows, top first) into `out` as RGBA8, premultiplied, rows as stored.
  engine_wgpu_read_pixels__deps: ['$WebGPU', '$engineWgpu'],
  engine_wgpu_read_pixels: (devicePtr, texturePtr, x, y, w, h, out) => {
    var device = WebGPU.getJsObject(devicePtr);
    var texture = WebGPU.getJsObject(texturePtr);
    if (!device || !texture || w <= 0 || h <= 0) return 0;
    try {
      var E = engineWgpu;
      if (!E.readCanvas || E.readDevice !== device) {
        E.readCanvas = new OffscreenCanvas(w, h);
        E.readContext = E.readCanvas.getContext('webgpu');
        E.readDevice = device;
        E.readConfigured = '';
      }
      if (E.readCanvas.width !== w) E.readCanvas.width = w;
      if (E.readCanvas.height !== h) E.readCanvas.height = h;
      // Configured again after a resize (the size is part of what the context hands out).
      var key = `${w}x${h}`;
      if (E.readConfigured !== key) {
        E.readContext.configure({ device, format: 'rgba8unorm', alphaMode: 'premultiplied',
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
        E.readConfigured = key;
      }
      var encoder = device.createCommandEncoder();
      encoder.copyTextureToTexture({ texture, origin: [x, y] }, { texture: E.readContext.getCurrentTexture() }, [w, h]);
      device.queue.submit([encoder.finish()]);
      var bitmap = E.readCanvas.transferToImageBitmap();
      if (!E.read2d || E.read2d.canvas.width < w || E.read2d.canvas.height < h) {
        var c2 = new OffscreenCanvas(Math.max(w, E.read2d ? E.read2d.canvas.width : 0), Math.max(h, E.read2d ? E.read2d.canvas.height : 0));
        E.read2d = c2.getContext('2d', { willReadFrequently: true });
      }
      var g = E.read2d;
      g.globalCompositeOperation = 'copy';
      g.drawImage(bitmap, 0, 0);
      bitmap.close();
      var data = g.getImageData(0, 0, w, h).data;
      // getImageData un-premultiplies: premultiply again (exact: the round trip loses nothing at 8 bits).
      for (var i = 0; i < data.length; i += 4) {
        var a = data[i + 3];
        if (a === 255) continue;
        if (a === 0) { data[i] = data[i + 1] = data[i + 2] = 0; continue; }
        data[i] = Math.round(data[i] * a / 255);
        data[i + 1] = Math.round(data[i + 1] * a / 255);
        data[i + 2] = Math.round(data[i + 2] * a / 255);
      }
      HEAPU8.set(data, out);
      return 1;
    } catch (e) {
      console.warn(`[engine] WebGPU: readback failed: ${e}`);
      return 0;
    }
  },

  // Figma's compatibility check, after the session started and without blocking it: pixel (x, y) of `texture`
  // (memory rows, top first) should be (r, g, b, a) ± 3 once the work submitted so far ran; when it isn't, or the
  // readback fails, the device fails.
  engine_wgpu_check_async__deps: ['$WebGPU', '$engineWgpu'],
  engine_wgpu_check_async: (deviceId, texturePtr, x, y, r, g, b, a) => {
    var entry = engineWgpu.devices[deviceId];
    var texture = WebGPU.getJsObject(texturePtr);
    if (!entry || !texture) return;
    var device = entry.device, selector = entry.selector;
    var buffer;
    try {
      buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      var encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture, origin: [x, y] }, { buffer, bytesPerRow: 256 }, [1, 1]);
      device.queue.submit([encoder.finish()]);
    } catch (e) {
      engineWgpu.fail(selector, `self test failed: ${e}`);
      return;
    }
    buffer.mapAsync(GPUMapMode.READ).then(() => {
      var px = Array.from(new Uint8Array(buffer.getMappedRange(0, 4)));
      buffer.unmap();
      buffer.destroy();
      var want = [r, g, b, a];
      var ok = want.every((v, i) => Math.abs(px[i] - v) <= 3);
      if (!ok && engineWgpu.devices[deviceId]) engineWgpu.fail(selector, `self test drew [${px}], expected [${want}]`);
    }, (e) => {
      if (engineWgpu.devices[deviceId]) engineWgpu.fail(selector, `self test readback failed: ${e}`);
    });
  },
});
