// The app's icon (build/icon.png, 1024px — electron-builder makes the .icns from it), drawn by Electron from the SVG below:
//   npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

// macOS's grid: an 824px rounded square in the 1024px canvas, a soft shadow under it. The mark: AppMark (src/renderer/src/app/icons.tsx) at 824/48.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0c8ce9"/><stop offset="1" stop-color="#9747ff"/></linearGradient>
    <filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.28"/></filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#g)" filter="url(#s)"/>
  <g fill="none" stroke="#fff" stroke-width="38" stroke-linejoin="round" stroke-linecap="round">
    <path d="M512 289L660 502L598 691H426L364 502Z"/>
    <path d="M512 289V461"/>
    <path d="M426 753H598"/>
  </g>
  <circle cx="512" cy="498" r="38" fill="#fff"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(1);
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0;background:transparent;overflow:hidden">${SVG}</body></html>`)}`);
  await new Promise((r) => setTimeout(r, 500));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const out = join(__dirname, "..", "build", "icon.png");
  writeFileSync(out, image.resize({ width: 1024, height: 1024, quality: "best" }).toPNG());
  console.log("icon:", out, image.getSize());
  app.quit();
});
