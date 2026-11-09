// @vitest-environment happy-dom
/**
 * Device frames as pictures (present/deviceArt.ts): a preset's picture from the manifest (Figma's "APPLE_" ids too), the
 * room the player leaves around the screen, and the picture's place over the canvas — its hole on the screen, portrait
 * and turned for landscape.
 */
import { describe, expect, it } from "vitest";
import { artInsets, artOf, artPlacement, type DeviceArt } from "@/present/deviceArt";

const phone = { file: "phone.webp", w: 120, h: 240, hole: { x: 10, y: 20, w: 100, h: 200 }, radius: 15 };
const manifest = { frames: { IPHONE_16: { BLACK: phone, PINK: { ...phone, file: "pink.webp" } }, IPHONE_16_PRO: { BLACK_TITANIUM: { ...phone, file: "pro.webp" } }, IPAD_PRO_11: { SILVER: { ...phone, file: "ipad.webp" } } } };

describe("deviceArt", () => {
  it("finds a preset's picture: its model, else the first; the longest preset; Figma's APPLE_ ids", () => {
    expect(artOf(manifest, "IPHONE_16_PINK")?.url).toMatch(/pink\.webp$/);
    expect(artOf(manifest, "IPHONE_16")?.url).toMatch(/phone\.webp$/);
    expect(artOf(manifest, "IPHONE_16_PRO_BLACK_TITANIUM")?.url).toMatch(/pro\.webp$/);
    expect(artOf(manifest, "APPLE_IPAD_PRO_11_SILVER")?.url).toMatch(/ipad\.webp$/);
    expect(artOf(manifest, "GOOGLE_PIXEL_8")).toBeNull();
    expect(artOf(manifest, "IPHONE_160")).toBeNull();
  });

  it("leaves room around the screen as fractions of it", () => {
    const art = artOf(manifest, "IPHONE_16")!;
    expect(artInsets(art)).toEqual({ left: 0.1, top: 0.1, right: 0.1, bottom: 0.1, radius: 0.15 });
  });

  it("puts the picture's hole on the screen, portrait and landscape", () => {
    const art: DeviceArt = { ...phone, url: "x" };
    // Portrait: the screen 50 × 100 at (100, 40) → half size, the hole's corner on the screen's.
    const p = artPlacement(art, { x: 100, y: 40, w: 50, h: 100 });
    expect(p).toEqual({ width: 60, height: 120, transform: "translate(95px, 30px)" });
    // Landscape (100 × 50): turned a quarter left; the hole (5, 10, 50 × 100 at half size) lands on the screen.
    const l = artPlacement(art, { x: 100, y: 40, w: 100, h: 50 });
    expect(l.width).toBe(60);
    expect(l.height).toBe(120);
    expect(l.transform).toBe("translate(90px, 95px) rotate(-90deg)");
    // rotate(-90°) about the top-left: (x, y) → (y, −x), then the translation — the hole's corners on the screen's.
    const at = (x: number, y: number) => [90 + y, 95 - x];
    expect(at(5, 10)).toEqual([100, 90]);
    expect(at(55, 110)).toEqual([200, 40]);
  });
});
