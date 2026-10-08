// Export settings and files as Figma makes them (model/exports.ts, shared/exportFiles.ts): scales, defaults, names,
// PNG DPI, the browser's ZIP, Copy as code's CSS, Export frames to PDF's order.
import { describe, expect, it } from "vitest";
import { exportMime, planExportPaths, safeParts } from "../../../../shared/exportFiles";
import {
  crc32,
  cssOf,
  describeSetting,
  exportFileName,
  nextExportSetting,
  parseScale,
  pngWithDpi,
  qualityOf,
  readingOrder,
  scaleLabel,
  withFormat,
  zipStored,
  type ExportSettings,
} from "../model/exports";

describe("export settings", () => {
  it("label and parse the scale field: 2x, 0.5x, 512w, 512h (SVG and PDF are 1x)", () => {
    expect(scaleLabel({ constraint: { type: "CONTENT_SCALE", value: 2 } })).toBe("2x");
    expect(scaleLabel({ constraint: { type: "CONTENT_SCALE", value: 0.75 } })).toBe("0.75x");
    expect(scaleLabel({ constraint: { type: "CONTENT_WIDTH", value: 512 } })).toBe("512w");
    expect(scaleLabel({ constraint: { type: "CONTENT_HEIGHT", value: 512 } })).toBe("512h");
    expect(scaleLabel({ imageType: "SVG", constraint: { type: "CONTENT_SCALE", value: 3 } })).toBe("1x");
    expect(scaleLabel({})).toBe("1x");
    expect(parseScale("2x")).toEqual({ type: "CONTENT_SCALE", value: 2 });
    expect(parseScale(" 1.5 ")).toEqual({ type: "CONTENT_SCALE", value: 1.5 });
    expect(parseScale(".5x")).toEqual({ type: "CONTENT_SCALE", value: 0.5 });
    expect(parseScale("512W")).toEqual({ type: "CONTENT_WIDTH", value: 512 });
    expect(parseScale("300h")).toEqual({ type: "CONTENT_HEIGHT", value: 300 });
    expect(parseScale("0x")).toBeNull();
    expect(parseScale("abc")).toBeNull();
    expect(parseScale("-2x")).toBeNull();
  });

  it("'+' adds 1x, then 2x @2x, then 3x @3x (Figma's defaults), PNG", () => {
    const list: ExportSettings[] = [];
    for (let i = 0; i < 3; i++) list.push(nextExportSetting(list));
    expect(list.map((s) => [scaleLabel(s), s.suffix, s.imageType])).toEqual([
      ["1x", "", "PNG"],
      ["2x", "@2x", "PNG"],
      ["3x", "@3x", "PNG"],
    ]);
    expect(list[0].contentsOnly).toBe(true);
  });

  it("a format change keeps the suffix (as Figma does) and makes SVG / PDF 1x", () => {
    const s = withFormat({ suffix: "@3x", imageType: "PNG", constraint: { type: "CONTENT_SCALE", value: 3 } }, "SVG");
    expect(s.suffix).toBe("@3x");
    expect(s.constraint).toEqual({ type: "CONTENT_SCALE", value: 1 });
    expect(withFormat({ constraint: { type: "CONTENT_WIDTH", value: 512 } }, "JPEG").constraint).toEqual({ type: "CONTENT_WIDTH", value: 512 });
  });

  it("names files after the layer and suffix; describes settings; image quality defaults", () => {
    expect(exportFileName("HomePage", { suffix: "draft", imageType: "PNG" })).toBe("HomePagedraft.png");
    expect(exportFileName("Frame 1", { suffix: "@2x", imageType: "JPEG" })).toBe("Frame 1@2x.jpg");
    expect(exportFileName("  ", { imageType: "PDF" })).toBe("Untitled.pdf");
    expect(describeSetting({ imageType: "PNG", constraint: { type: "CONTENT_SCALE", value: 2 } })).toBe("2x PNG");
    expect(describeSetting({ imageType: "SVG" })).toBe("SVG");
    expect(qualityOf({ imageType: "JPEG" })).toBeCloseTo(0.92);
    expect(qualityOf({ imageType: "PDF" })).toBeCloseTo(0.8);
  });
});

describe("export files", () => {
  it("plans paths: slashes make folders, unsafe characters go, taken names get ' 2'", () => {
    expect(safeParts("button/pill/default.png")).toEqual(["button", "pill", "default.png"]);
    expect(safeParts("../a:b/..")).toEqual(["a-b"]);
    expect(safeParts("")).toEqual(["Untitled"]);
    expect(planExportPaths(["Frame 1.png", "Frame 1.png", "frame 1.png", "icons/a.svg"], (p) => p === "icons/a.svg")).toEqual([
      "Frame 1.png",
      "Frame 1 2.png",
      "frame 1 3.png",
      "icons/a 2.svg",
    ]);
    expect(exportMime("x.jpg")).toBe("image/jpeg");
    expect(exportMime("x.pdf")).toBe("application/pdf");
  });

  it("writes Figma's DPI into a PNG (pHYs after IHDR, 72 × scale)", () => {
    // A 1×1 PNG: signature, IHDR, IDAT, IEND.
    const png = Uint8Array.from(
      Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1f5d4f20000000049454e44ae426082", "hex")
    );
    const out = pngWithDpi(png, 144);
    expect(out.length).toBe(png.length + 21);
    const at = 33;
    const view = new DataView(out.buffer);
    expect(String.fromCharCode(...out.subarray(at + 4, at + 8))).toBe("pHYs");
    expect(view.getUint32(at + 8)).toBe(Math.round(144 / 0.0254));
    expect(view.getUint32(at + 17)).toBe(crc32(out, at + 4, at + 17));
    expect(pngWithDpi(out, 72)).toBe(out);  // has one already
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
  });

  it("zips several files for a browser download (stored, readable back)", () => {
    const files = [
      { name: "Frame 1.png", bytes: new Uint8Array([1, 2, 3]) },
      { name: "icons/Star.svg", bytes: new TextEncoder().encode("<svg/>") },
    ];
    const zip = zipStored(files);
    const view = new DataView(zip.buffer);
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    let at = view.getUint32(end + 16, true);
    for (const f of files) {
      expect(view.getUint32(at, true)).toBe(0x02014b50);
      const nameLen = view.getUint16(at + 28, true);
      expect(new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen))).toBe(f.name);
      const local = view.getUint32(at + 42, true);
      const size = view.getUint32(local + 18, true);
      const data = zip.subarray(local + 30 + view.getUint16(local + 26, true), local + 30 + view.getUint16(local + 26, true) + size);
      expect([...data]).toEqual([...f.bytes]);
      expect(view.getUint32(at + 16, true)).toBe(crc32(f.bytes));
      at += 46 + nameLen;
    }
  });
});

describe("Export frames to PDF", () => {
  it("orders frames in rows top to bottom, left to right", () => {
    const f = (name: string, x: number, y: number) => ({ name, x, y, w: 100, h: 100 });
    const order = readingOrder([f("c", 0, 300), f("b", 220, 8), f("a", 0, 0), f("d", 220, 300)]);
    expect(order.map((o) => o.name)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("Copy as code", () => {
  it("writes Figma's CSS: a comment, the box, then the look", () => {
    const css = cssOf({
      name: "Card",
      type: "ROUNDED_RECTANGLE",
      size: { x: 100, y: 50 },
      transform: { m00: 1, m01: 0, m02: 10, m10: 0, m11: 1, m12: 20 },
      fillPaints: [{ type: "SOLID", color: { r: 0.85, g: 0.85, b: 0.85, a: 1 } }],
      cornerRadius: 8,
      strokePaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
      strokeWeight: 1,
      strokeAlign: "INSIDE",
      effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 4 }],
      opacity: 0.5,
    });
    expect(css).toBe(
      [
        "/* Card */",
        "",
        "position: absolute;",
        "width: 100px;",
        "height: 50px;",
        "left: 10px;",
        "top: 20px;",
        "",
        "background: #D9D9D9;",
        "border: 1px solid #000000;",
        "box-sizing: border-box;",
        "border-radius: 8px;",
        "box-shadow: 0px 4px 4px rgba(0, 0, 0, 0.25);",
        "opacity: 0.5;",
        "",
      ].join("\n")
    );
    const text = cssOf({ name: "Title", type: "TEXT", size: { x: 40, y: 15 }, fontName: { family: "Inter", style: "Semi Bold" }, fontSize: 12, fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }] });
    expect(text).toContain("font-family: 'Inter';");
    expect(text).toContain("font-weight: 600;");
    expect(text).toContain("color: #000000;");
  });
});
