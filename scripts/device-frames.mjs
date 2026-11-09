// The prototype player's device frames from Apple's own product bezels (developer.apple.com/design/resources,
// "Product Bezels"): downloads the disk images, takes each preset model's portrait PNG, measures its screen (the
// transparent hole around the image's centre) and writes a smaller WebP plus manifest.json to
// src/renderer/public/device-frames/. The player lays the device out with the measured insets and the page draws the
// picture over its canvas (present/deviceArt.ts); a preset without a picture keeps the engine's drawn frame.
//
//   node scripts/device-frames.mjs            # downloads (~800 MB, cached in ~/Library/Caches/wecra-device-frames)
//
// Apple's Design Resources license allows the bezels for mock-ups of apps for Apple's platforms only, and not their
// redistribution — the output is git-ignored; every machine that builds the app runs this once.
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";

const CDN = "https://devimages-cdn.apple.com/design/resources/download/";
const CACHE = path.join(os.homedir(), "Library/Caches/wecra-device-frames");
const OUT = path.resolve(import.meta.dirname, "../src/renderer/public/device-frames");
/** The picture's longest side at most (the hole stays sharp at a window's size, the app stays small). */
const MAX_SIDE = 2400;

const phone = (dmg, dir, name) => (color) => ({ dmg, file: `PNG/${dir}/${name} - ${color} - Portrait.png` });
const iphone16 = phone("Bezel-iPhone-16", "iPhone 16", "iPhone 16");
const iphone16Plus = phone("Bezel-iPhone-16", "iPhone 16 Plus", "iPhone 16 Plus");
const iphone16Pro = phone("Bezel-iPhone-16", "iPhone 16 Pro", "iPhone 16 Pro");
const iphone16ProMax = phone("Bezel-iPhone-16", "iPhone 16 Pro Max", "iPhone 16 Pro Max");
const ipad = (dmg, name) => (color) => ({ dmg, file: `PNG/${name} - ${color} - Portrait.png` });
const ipadMini = ipad("Bezel-iPad-mini-(A20-Pro)", "iPad mini (A20 Pro)");
const ipadPro11 = ipad("Bezel-iPad-Pro-(M5)", 'iPad Pro (M5) 11"');
const ipadPro13 = ipad("Bezel-iPad-Pro-(M5)", 'iPad Pro (M5) 13"');
const mac = (dmg, name) => (color) => ({ dmg, file: `PNG/${name} ${color}.png` });
const air = mac("Bezel-MacBook-Air-M5", "MacBook Air M5 13-inch");
const pro14 = mac("Bezel-MacBook-Pro-M5", "MacBook Pro M5 14-inch");
const pro16 = mac("Bezel-MacBook-Pro-M5", "MacBook Pro M5 16-inch");
const watch = (band) => ({ dmg: "Bezel-Apple-Watch-Series-11-2025", file: `PNG/Sport Band/Apple Watch S11 - 46mm - ${band}.png` });

// engine/src/proto/Devices.cpp's presets and models → Apple's pictures. The iPhone 15 family has no bezels on Apple's
// page any more: the iPhone 16 one of the same size class and the nearest finish stand in.
const TABLE = {
  IPHONE_16: { BLACK: iphone16("Black"), WHITE: iphone16("White"), PINK: iphone16("Pink"), TEAL: iphone16("Teal"), ULTRAMARINE: iphone16("Ultramarine") },
  IPHONE_16_PLUS: { BLACK: iphone16Plus("Black"), WHITE: iphone16Plus("White"), PINK: iphone16Plus("Pink"), TEAL: iphone16Plus("Teal"), ULTRAMARINE: iphone16Plus("Ultramarine") },
  IPHONE_16_PRO: {
    BLACK_TITANIUM: iphone16Pro("Black Titanium"), WHITE_TITANIUM: iphone16Pro("White Titanium"),
    NATURAL_TITANIUM: iphone16Pro("Natural Titanium"), DESERT_TITANIUM: iphone16Pro("Desert Titanium"),
  },
  IPHONE_16_PRO_MAX: {
    BLACK_TITANIUM: iphone16ProMax("Black Titanium"), WHITE_TITANIUM: iphone16ProMax("White Titanium"),
    NATURAL_TITANIUM: iphone16ProMax("Natural Titanium"), DESERT_TITANIUM: iphone16ProMax("Desert Titanium"),
  },
  IPHONE_15: { BLACK: iphone16("Black"), BLUE: iphone16("Teal"), GREEN: iphone16("Teal"), YELLOW: iphone16("White"), PINK: iphone16("Pink") },
  IPHONE_15_PRO: {
    BLACK_TITANIUM: iphone16Pro("Black Titanium"), WHITE_TITANIUM: iphone16Pro("White Titanium"),
    BLUE_TITANIUM: iphone16Pro("Black Titanium"), NATURAL_TITANIUM: iphone16Pro("Natural Titanium"),
  },
  IPHONE_15_PRO_MAX: {
    BLACK_TITANIUM: iphone16ProMax("Black Titanium"), WHITE_TITANIUM: iphone16ProMax("White Titanium"),
    BLUE_TITANIUM: iphone16ProMax("Black Titanium"), NATURAL_TITANIUM: iphone16ProMax("Natural Titanium"),
  },
  IPAD_MINI: { SPACE_GRAY: ipadMini("Midnight"), BLUE: ipadMini("Starlight"), PURPLE: ipadMini("Starlight"), STARLIGHT: ipadMini("Starlight") },
  IPAD_PRO_11: { SPACE_BLACK: ipadPro11("Space Black"), SILVER: ipadPro11("Silver") },
  IPAD_PRO_13: { SPACE_BLACK: ipadPro13("Space Black"), SILVER: ipadPro13("Silver") },
  MACBOOK_AIR: { MIDNIGHT: air("Midnight"), STARLIGHT: air("Starlight"), SPACE_GRAY: air("Midnight"), SILVER: air("Silver") },
  MACBOOK_PRO_14: { SPACE_BLACK: pro14("Space Black"), SILVER: pro14("Silver") },
  MACBOOK_PRO_16: { SPACE_BLACK: pro16("Space Black"), SILVER: pro16("Silver") },
  APPLE_WATCH: {
    JET_BLACK: watch("Aluminum Jet Black + Sport Band Black"), ROSE_GOLD: watch("Aluminum Rose Gold + Sport Band Light Blush"),
    SILVER: watch("Aluminum Silver + Sport Band Purple Fog"),
  },
};

/** The disk image's files, copied out once (Apple's images ask to agree to their license: `yes` answers). */
function extract(dmg) {
  const dir = path.join(CACHE, dmg);
  if (fs.existsSync(path.join(dir, "PNG"))) return dir;
  fs.mkdirSync(CACHE, { recursive: true });
  const image = path.join(CACHE, `${dmg}.dmg`);
  if (!fs.existsSync(image)) {
    console.log(`downloading ${dmg}.dmg`);
    execSync(`curl -sfL -o ${JSON.stringify(image)} ${JSON.stringify(CDN + encodeURIComponent(dmg) + ".dmg")}`, { stdio: "inherit" });
  }
  const out = execSync(`yes | hdiutil attach -nobrowse -readonly -noverify ${JSON.stringify(image)}`, { encoding: "utf8" });
  const mount = out.trim().split("\n").pop().split("\t").pop();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(path.join(mount, "PNG"), path.join(dir, "PNG"), { recursive: true });
  } finally {
    execSync(`hdiutil detach ${JSON.stringify(mount)} -quiet`);
  }
  fs.rmSync(image);
  return dir;
}

/** The screen: the transparent region around the picture's centre (a flood fill), its box and its corner radius. */
async function measure(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const clear = (x, y) => data[(y * W + x) * 4 + 3] < 128;
  // From the centre, or the nearest clear pixel up the middle (a laptop's base sits under its centre).
  let sx = W >> 1, sy = H >> 1;
  while (sy > 0 && !clear(sx, sy)) sy--;
  if (!clear(sx, sy)) throw new Error(`no screen in ${file}`);
  const seen = new Uint8Array(W * H);
  const stack = [sy * W + sx];
  seen[stack[0]] = 1;
  let x0 = sx, y0 = sy, x1 = sx, y1 = sy;
  while (stack.length) {
    const i = stack.pop();
    const x = i % W, y = (i - x) / W;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (seen[j] || !clear(nx, ny)) continue;
      seen[j] = 1;
      stack.push(j);
    }
  }
  if (x0 === 0 || y0 === 0 || x1 === W - 1 || y1 === H - 1) throw new Error(`the screen of ${file} reaches the picture's edge`);
  // The corner: the first clear pixel along the top-left diagonal is R(1 − 1/√2) in.
  let d = 0;
  while (d < Math.min(x1 - x0, y1 - y0) / 2 && !seen[(y0 + d) * W + x0 + d]) d++;
  return { W, H, hole: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, radius: d / (1 - Math.SQRT1_2) };
}

const pictures = new Map();
async function picture(src) {
  const key = `${src.dmg}/${src.file}`;
  if (pictures.has(key)) return pictures.get(key);
  const dir = extract(src.dmg);
  const file = path.join(dir, src.file);
  const m = await measure(file);
  const k = Math.min(1, MAX_SIDE / Math.max(m.W, m.H));
  const name = path.basename(src.file, ".png").replace(/[^A-Za-z0-9]+/g, "-").replace(/-+$/, "").toLowerCase() + ".webp";
  const w = Math.round(m.W * k), h = Math.round(m.H * k);
  await sharp(file).resize(w, h).webp({ quality: 88, alphaQuality: 100 }).toFile(path.join(OUT, name));
  const r = (v) => Math.round(v * k * 10) / 10;
  const p = { file: name, w, h, hole: { x: r(m.hole.x), y: r(m.hole.y), w: r(m.hole.w), h: r(m.hole.h) }, radius: r(m.radius) };
  pictures.set(key, p);
  console.log(`${name}  ${w}×${h}  screen ${p.hole.w}×${p.hole.h} at ${p.hole.x},${p.hole.y}  radius ${p.radius}`);
  return p;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const manifest = { source: "Apple Design Resources — Product Bezels", frames: {} };
for (const [preset, models] of Object.entries(TABLE)) {
  manifest.frames[preset] = {};
  for (const [model, src] of Object.entries(models)) manifest.frames[preset][model] = await picture(src);
}
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`${pictures.size} pictures → ${path.relative(process.cwd(), OUT)}`);
