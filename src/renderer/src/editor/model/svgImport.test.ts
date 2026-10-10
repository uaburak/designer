import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { Matrix, Message, NodeChange } from "@/engine/codec";
import { pdfToSvg } from "../../../../shared/vectorImport/pdf";
import { parsePathData } from "../../../../shared/vectorImport/geometry";
import { looksLikeSvg, networkBlob, svgToMessage } from "./svgImport";

const fixture = (name: string) => readFileSync(new URL(`../../../../shared/vectorImport/fixtures/${name}`, import.meta.url));

/** A vector network blob read back: vertices, segments (with tangents), regions' winding and loops. */
function readNetwork(b64: string) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const v = new DataView(bytes.buffer);
  let at = 0;
  const u32 = () => ((at += 4), v.getUint32(at - 4, true));
  const f32 = () => ((at += 4), v.getFloat32(at - 4, true));
  const [nv, ns, nr] = [u32(), u32(), u32()];
  const verts = Array.from({ length: nv }, () => (u32(), { x: f32(), y: f32() }));
  const segs = Array.from({ length: ns }, () => (u32(), { a: u32(), ts: { x: f32(), y: f32() }, b: u32(), te: { x: f32(), y: f32() } }));
  const regions = Array.from({ length: nr }, () => {
    const w = u32();
    const loops = Array.from({ length: u32() }, () => Array.from({ length: u32() }, () => u32()));
    return { nonzero: (w & 1) === 1, loops };
  });
  return { verts, segs, regions };
}

const byName = (m: Message, name: string) => m.nodeChanges.filter((n) => n.name === name);
const childrenOf = (m: Message, guid: string) => m.nodeChanges.filter((n) => n.parentIndex?.guid === guid).sort((a, b) => (a.parentIndex!.position < b.parentIndex!.position ? -1 : 1));
const apply = (t: Matrix, x: number, y: number) => ({ x: t.m00 * x + t.m01 * y + t.m02, y: t.m10 * x + t.m11 * y + t.m12 });

describe("svgToMessage", () => {
  it("pastes Illustrator's own SVG flavour (a real copy) as editable layers", () => {
    const { message, skipped } = svgToMessage(fixture("illustrator-copy.svg").toString("utf8"));
    const m = message!;
    expect(skipped.text).toBe(0); // its text is outlines already
    const top = m.nodeChanges[0];
    expect(top).toMatchObject({ type: "FRAME", name: "Group", resizeToFit: true, parentIndex: { guid: "4294967294:0" } });
    expect(top.transform).toMatchObject({ m02: 0, m12: 0 });
    expect(m.clipboardSelectionRegions?.[0].nodes).toEqual([top.guid]);
    const kids = childrenOf(m, top.guid);
    expect(kids.map((k) => [k.type, k.name])).toEqual([
      ["ROUNDED_RECTANGLE", "Rectangle"],
      ["ELLIPSE", "Ellipse"],
      ["VECTOR", "Vector"],
      ["FRAME", "Clip path group"],
      ["FRAME", "Group"],
    ]);
    const [rect, circle, star, clipGroup, text] = kids;
    // The artwork's top-left is the circle's top (y 3) and the rectangle's left (x 0): the rectangle sits at 0, 10.
    expect(rect).toMatchObject({ size: { x: 120, y: 80 }, transform: { m02: 0, m12: 10 }, fillPaints: [{ type: "SOLID", color: { r: 230 / 255, g: 40 / 255, b: 50 / 255, a: 1 } }] });
    expect(circle).toMatchObject({ size: { x: 100, y: 100 }, fillPaints: [], strokePaints: [{ type: "SOLID" }], strokeWeight: 6, strokeAlign: "CENTER", miterLimit: 10 });
    expect(star).toMatchObject({ dashPattern: [8, 4], strokeWeight: 2, strokeJoin: "MITER" });
    const net = readNetwork(m.blobs![star.vectorData!.vectorNetworkBlob!]);
    expect(net.verts).toHaveLength(10); // the polygon's repeated first point is the same vertex
    expect(net.segs).toHaveLength(10);
    expect(net.regions).toEqual([{ nonzero: true, loops: [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]] }]);
    expect(star.vectorData!.normalizedSize).toEqual(star.size);
    // The clip: a group whose bottom layer is the circle as an outline mask, over the rectangle.
    const [mask, clipped] = childrenOf(m, clipGroup.guid);
    expect(mask).toMatchObject({ type: "VECTOR", mask: true, maskType: "OUTLINE", name: "clippath" });
    expect(clipped).toMatchObject({ type: "ROUNDED_RECTANGLE", size: { x: 120, y: 100 } });
    // The outlined "Hi": two vectors with curves in a group.
    const glyphs = childrenOf(m, text.guid);
    expect(glyphs.map((g) => g.type)).toEqual(["VECTOR", "VECTOR"]);
  });

  it("counts the text of the public SVG flavour as skipped", () => {
    const { message, skipped } = svgToMessage(fixture("illustrator-copy.public.svg").toString("utf8"));
    expect(skipped.text).toBe(1);
    expect(childrenOf(message!, message!.nodeChanges[0].guid)).toHaveLength(4);
  });

  it("pastes Illustrator's clipboard PDF (a real copy) through the PDF converter", () => {
    const pdf = pdfToSvg(new Uint8Array(fixture("illustrator-copy.pdf")), (b) => new Uint8Array(inflateSync(b)))!;
    const { message } = svgToMessage(pdf.svg);
    const m = message!;
    const vectors = m.nodeChanges.filter((n) => n.type === "VECTOR");
    expect(vectors.length).toBe(6); // rectangle, circle, star fill, star stroke, clip mask, clipped rectangle
    expect(vectors.filter((n) => n.mask)).toHaveLength(1);
    expect(byName(m, "Clip path group")).toHaveLength(1);
    const top = m.nodeChanges[0];
    expect(top.size!.x).toBeCloseTo(320, 3);
  });

  it("bakes transforms into the geometry; axis-aligned rects and ellipses stay shapes, turned ones become vectors", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
      <g transform="translate(10 20) scale(2)">
        <rect id="Box" width="10" height="5" rx="1" fill="red"/>
        <rect width="10" height="10" transform="rotate(45)" fill="blue" stroke="#000" stroke-width="1"/>
        <circle cx="50" cy="50" r="5" fill="green" opacity="0.5"/>
      </g>
    </svg>`;
    const m = svgToMessage(svg, { x: 100, y: 100 }).message!;
    const [box, turned, circle] = childrenOf(m, m.nodeChanges[0].guid);
    expect(box).toMatchObject({ type: "ROUNDED_RECTANGLE", name: "Box", size: { x: 20, y: 10 }, cornerRadius: 2 });
    expect(turned.type).toBe("VECTOR");
    expect(turned.strokeWeight).toBeCloseTo(2);
    expect(circle).toMatchObject({ type: "ELLIPSE", size: { x: 20, y: 20 }, opacity: 0.5 });
    // The group's top-left lands at the origin.
    expect(m.nodeChanges[0].transform).toMatchObject({ m02: 100, m12: 100 });
  });

  it("reads <style> classes, inherited fills, currentColor, fill-rule and use", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">
      <defs><style>.a{fill:#00f}#b{fill:#0f0} path{stroke:none}</style><path id="p" d="M0 0h10v10H0z"/></defs>
      <g fill="#f00" color="#123456">
        <path d="M0 0h10v10H0z"/>
        <path class="a" d="M20 0h10v10H20z"/>
        <path id="b" class="a" d="M40 0h10v10H40z"/>
        <path fill="currentColor" fill-rule="evenodd" d="M60 0h10v10H60z M62 2h6v6h-6z"/>
        <use xlink:href="#p" x="80" y="0"/>
      </g>
    </svg>`;
    const m = svgToMessage(svg).message!;
    const kids = childrenOf(m, m.nodeChanges[0].guid);
    const hex = (n: NodeChange) => {
      const c = (n.fillPaints![0] as { color: { r: number; g: number; b: number } }).color;
      return [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
    };
    expect(kids.map(hex)).toEqual(["ff0000", "0000ff", "00ff00", "123456", "ff0000"]);
    const evenOdd = readNetwork(m.blobs![kids[3].vectorData!.vectorNetworkBlob!]);
    expect(evenOdd.regions).toEqual([{ nonzero: false, loops: [[0, 1, 2, 3], [4, 5, 6, 7]] }]);
    expect(kids[4].transform).toMatchObject({ m02: 80 });
  });

  it("maps a linear gradient to Figma's paint transform (start at 0, end at 1 along x)", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <linearGradient id="g" x1="10" y1="0" x2="90" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000" stop-opacity=".5"/></linearGradient>
      <rect x="0" y="0" width="100" height="40" fill="url(#g)"/>
    </svg>`;
    const rect = svgToMessage(svg).message!.nodeChanges[0];
    const paint = rect.fillPaints![0];
    expect(paint.type).toBe("GRADIENT_LINEAR");
    expect(paint.stops![1].color.a).toBeCloseTo(0.5);
    // engine: gradient space = transform × (local px / size)
    const t = paint.transform!;
    const at = (x: number, y: number) => apply(t, x / 100, y / 40);
    expect(at(10, 20).x).toBeCloseTo(0);
    expect(at(90, 20).x).toBeCloseTo(1);
    expect(at(10, 0).y).toBeCloseTo(0.5); // the gradient line runs along y 0
  });

  it("encodes curves with tangents relative to their vertices", () => {
    const net = readNetwork(networkBlob(parsePathData("M0 0C10 0 20 10 20 20"), { x: 0, y: 0 }, false));
    expect(net.segs[0]).toEqual({ a: 0, ts: { x: 10, y: 0 }, b: 1, te: { x: 0, y: -10 } });
    expect(net.regions).toEqual([]);
  });

  it("parses arc flags written together", () => {
    const sp = parsePathData("M0 0a5 5 0 105 5")[0];
    expect(sp.segs.at(-1)!.p).toEqual({ x: 5, y: 5 });
    expect(sp.segs.length).toBeGreaterThan(1); // the large arc: three quarters
  });

  it("recognises SVG text", () => {
    expect(looksLikeSvg('<?xml version="1.0"?>\n<!-- Generator: Adobe Illustrator -->\n<svg viewBox="0 0 1 1"/>')).toBe(true);
    expect(looksLikeSvg("hello <svg>")).toBe(false);
    expect(svgToMessage("<svg/>").message).toBeNull();
  });
});
