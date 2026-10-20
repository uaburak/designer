// Pasted into a prototype page (Figma's /proto presentation, or Wecra's editor with the inline preview — then point
// __canvas at #preview-canvas): a fake clock that only advances on __step(ms) (performance.now, Date.now and the
// animation frames' time), rAF callbacks queued and run by __step, and a pixel reader that runs in the same task as the
// draw (a WebGL / WebGPU canvas reads back blank afterwards). The REA prototype round's probe,
// docs/research/rea/prototype.md.
(() => {
  if (window.__clk) return 'already';
  window.__clk = true;
  window.__fake = performance.now();
  Performance.prototype.now = function () { return window.__fake; };
  try { performance.now = function () { return window.__fake; }; } catch { /* read-only: the prototype's patch holds */ }
  const realDateNow = Date.now; const d0 = realDateNow(); const f0 = window.__fake;
  Date.now = () => d0 + (window.__fake - f0);
  window.__q = [];
  window.requestAnimationFrame = (cb) => { window.__q.push(cb); return window.__q.length + 1e6; };
  window.cancelAnimationFrame = () => {};
  window.__step = (ms) => {
    window.__fake += ms;
    const q = window.__q; window.__q = [];
    for (const cb of q) { try { cb(window.__fake); } catch (e) { console.error(e); } }
  };
  window.__canvas = () => [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  // runs of colour classes on row y (fraction of height), and the red box's bounds
  window.__meas = (rowFrac = 0.5) => {
    const cv = window.__canvas();
    const off = document.createElement('canvas'); off.width = cv.width; off.height = cv.height;
    const c = off.getContext('2d'); c.drawImage(cv, 0, 0);
    const W = off.width, H = off.height, d = c.getImageData(0, 0, W, H).data;
    const cls = (r, g, b) => (r > 150 && g < 110 && b < 110 ? 'R' : r < 60 && g < 60 && b > 150 ? 'B' : r + g + b < 40 ? 'K' : r > 235 && g > 235 && b > 235 ? 'W' : 'O');
    const y = Math.round(H * rowFrac); const runs = [];
    for (let x = 0; x < W; x++) {
      const i = 4 * (y * W + x); const k = cls(d[i], d[i + 1], d[i + 2]);
      const last = runs[runs.length - 1];
      if (last && last[0] === k) last[2] = x; else runs.push([k, x, x, [d[i], d[i + 1], d[i + 2]]]);
    }
    let rx0 = 1e9, rx1 = -1, ry0 = 1e9, ry1 = -1, rs = 0;
    for (let yy = 0; yy < H; yy += 2) for (let x = 0; x < W; x++) {
      const i = 4 * (yy * W + x);
      if (d[i] > 150 && d[i + 1] < 110 && d[i + 2] < 110) { rs++; if (x < rx0) rx0 = x; if (x > rx1) rx1 = x; if (yy < ry0) ry0 = yy; if (yy > ry1) ry1 = yy; }
    }
    return { W, H, runs: runs.filter((r) => r[2] - r[1] > 2), red: rs ? [rx0, rx1, ry0, ry1] : null };
  };
  window.__run = (dt, n, rowFrac) => {
    const out = [];
    for (let i = 0; i < n; i++) { window.__step(dt); out.push([+(window.__fake - window.__t0).toFixed(1), window.__meas(rowFrac)]); }
    return out;
  };
  return 'ok';
})();
