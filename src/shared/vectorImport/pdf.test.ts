import { readFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pdfToSvg } from "./pdf";
import { parseXml, type XmlElement } from "./xml";

const inflate = (b: Uint8Array) => new Uint8Array(inflateSync(b));
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

const all = (el: XmlElement, name: string): XmlElement[] => [...(el.name === name ? [el] : []), ...el.children.flatMap((c) => all(c, name))];

/** A one-page PDF around `content` (Flate-compressed when `flate`), with optional extra objects from 5 on. */
function makePdf(content: string, opts: { flate?: boolean; resources?: string; extra?: string[]; mediaBox?: string } = {}): Uint8Array {
  const body = opts.flate ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  const parts: Buffer[] = [Buffer.from("%PDF-1.6\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  parts.push(Buffer.from("1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n"));
  parts.push(Buffer.from(`2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[${opts.mediaBox ?? "0 0 200 100"}]>>\nendobj\n`));
  parts.push(Buffer.from(`3 0 obj\n<</Type/Page/Parent 2 0 R/Contents 4 0 R/Resources<<${opts.resources ?? ""}>>>>\nendobj\n`));
  parts.push(Buffer.from(`4 0 obj\n<</Length ${body.length}${opts.flate ? "/Filter/FlateDecode" : ""}>>stream\n`, "latin1"), body, Buffer.from("\nendstream\nendobj\n"));
  (opts.extra ?? []).forEach((o, i) => parts.push(Buffer.from(`${5 + i} 0 obj\n${o}\nendobj\n`, "latin1")));
  parts.push(Buffer.from("trailer\n<</Root 1 0 R>>\n%%EOF\n"));
  return new Uint8Array(Buffer.concat(parts));
}

describe("pdfToSvg", () => {
  it("reads Illustrator's clipboard PDF (a real copy: rectangle, stroked circle, dashed star, a clip group, text)", () => {
    const r = pdfToSvg(fixture("illustrator-copy.pdf"), inflate)!;
    expect(r).not.toBeNull();
    const svg = parseXml(r.svg)!;
    expect(svg.attrs.viewBox).toBe("0 0 320 223");
    const paths = all(svg, "path").filter((p) => !all(svg, "clipPath").some((c) => c.children.includes(p)));
    // Rectangle, circle (stroke), star fill, star stroke, the clipped rectangle.
    expect(paths).toHaveLength(5);
    expect(paths[0].attrs.fill).toBe("#e62832");
    expect(paths[0].attrs.d).toBe("M0 93L120 93L120 13L0 13Z");
    expect(paths[1].attrs).toMatchObject({ fill: "none", stroke: "#145ae6", "stroke-width": "6" });
    expect(paths[3].attrs["stroke-dasharray"]).toBe("8 4");
    // The artboard clip is left out; the circle clip stays, around the last rectangle only.
    const clips = all(svg, "clipPath");
    expect(clips).toHaveLength(1);
    const clipped = all(svg, "g").filter((g) => g.attrs["clip-path"]);
    expect(clipped).toHaveLength(1);
    expect(all(clipped[0], "path")).toHaveLength(1);
    expect(r.skipped.text).toBe(1);
  });

  it("converts CMYK, gray, line styles, even-odd fills and Flate streams", () => {
    const pdf = makePdf(
      ["0 1 1 0 k 10 10 50 30 re f", "0.5 G 2 J 1 j 4 w 100 10 m 150 10 l 150 60 l S", "0 0 1 rg 0 0 m 40 0 l 40 40 l 0 40 l h 10 10 m 30 10 l 30 30 l 10 30 l h f*", "1 0 0 RG 1 0 0 1 20 20 cm 0 0 m 10 0 10 10 0 10 c s"].join("\n"),
      { flate: true },
    );
    const r = pdfToSvg(pdf, inflate)!;
    const paths = all(parseXml(r.svg)!, "path");
    expect(paths).toHaveLength(4);
    expect(paths[0].attrs.fill).toBe("#ff0000"); // C0 M1 Y1 K0
    expect(paths[0].attrs.d).toBe("M10 90L60 90L60 60L10 60Z"); // y flipped
    expect(paths[1].attrs).toMatchObject({ fill: "none", stroke: "#808080", "stroke-width": "4", "stroke-linecap": "square", "stroke-linejoin": "round" });
    expect(paths[2].attrs["fill-rule"]).toBe("evenodd");
    expect(paths[3].attrs.d).toBe("M20 80C30 80 30 70 20 70Z");
    expect(paths[3].attrs.stroke).toBe("#ff0000");
  });

  it("keeps clips as clip groups, applies ExtGState alpha, follows Form XObjects, ICC and Separation colour", () => {
    const pdf = makePdf(
      [
        "q 20 20 60 60 re W n",
        "/GS0 gs /CS0 cs 0 0 1 scn 0 0 100 100 re f",
        "/CS1 cs 0.5 scn 50 50 10 10 re f",
        "Q",
        "q 1 0 0 1 100 0 cm /Fm0 Do Q",
      ].join("\n"),
      {
        resources: "/ExtGState<</GS0 5 0 R>>/ColorSpace<</CS0 [/ICCBased 6 0 R] /CS1 [/Separation/Spot/DeviceCMYK 7 0 R]>>/XObject<</Fm0 8 0 R>>",
        extra: [
          "<</Type/ExtGState/ca 0.5>>",
          "<</N 3/Length 0>>stream\n\nendstream",
          "<</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[0 0 0 1]/N 1>>",
          "<</Type/XObject/Subtype/Form/BBox[0 0 50 50]/Matrix[1 0 0 1 10 0]/Length 18>>stream\n0 1 0 rg 0 0 5 5 re f\nendstream",
        ],
      },
    );
    const r = pdfToSvg(pdf, inflate)!;
    const svg = parseXml(r.svg)!;
    const g = all(svg, "g").filter((x) => x.attrs["clip-path"]);
    expect(g).toHaveLength(1);
    const inside = all(g[0], "path");
    expect(inside).toHaveLength(2);
    expect(inside[0].attrs).toMatchObject({ fill: "#0000ff", "fill-opacity": "0.5" });
    expect(inside[1].attrs.fill).toBe("#808080");
    const form = all(svg, "path").at(-1)!;
    expect(form.attrs.fill).toBe("#00ff00");
    expect(form.attrs.d).toBe("M110 100L115 100L115 95L110 95Z");
  });

  it("turns a shading inside a clip into a gradient-filled path", () => {
    const pdf = makePdf("q 0 0 100 50 re W n /Sh0 sh Q", {
      resources: "/Shading<</Sh0 5 0 R>>",
      extra: ["<</ShadingType 2/ColorSpace/DeviceRGB/Coords[0 0 100 0]/Function 6 0 R>>", "<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[0 0 1]/N 1>>"],
    });
    const r = pdfToSvg(pdf, inflate)!;
    const svg = parseXml(r.svg)!;
    const grad = all(svg, "linearGradient")[0];
    expect(grad.children.map((s) => s.attrs["stop-color"])).toEqual(["#ff0000", "#0000ff"]);
    const p = all(svg, "path").filter((x) => x.attrs.fill?.startsWith("url"));
    expect(p).toHaveLength(1);
  });

  it("is not a PDF: null", () => {
    expect(pdfToSvg(new TextEncoder().encode("hello"), inflate)).toBeNull();
  });
});
