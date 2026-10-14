// capture_web_design's conversion (docs/agents-reach.md §5.3) on a captured tree as walker.js makes it: a flex row of
// a picture and a text becomes an auto layout frame with an image rectangle and a text in the page's font.
import { describe, expect, it } from "vitest";
import type { WNode } from "../../../shared/agents/web/convert";
import { designFromCapture, fontOf, withoutImages } from "./webSpec";

const box = (o: Partial<WNode>): WNode => ({ kind: "box", tag: "div", x: 0, y: 0, w: 0, h: 0, c: {}, children: [], d: "block", pos: "static", fd: "row", fw: "nowrap", jc: "normal", ai: "normal", as: "auto", fg: 0, gap: [0, 0], pad: [0, 0, 0, 0], bw: [0, 0, 0, 0], mar: [0, 0, 0, 0], ow: 0, rad: [0, 0, 0, 0], sh: [], clip: false, bgi: null, ...o });

const page = (): WNode =>
  box({
    tag: "body",
    x: 0,
    y: 0,
    w: 1440,
    h: 200,
    c: { bg: "#ffffff" },
    children: [
      box({
        tag: "header",
        x: 0,
        y: 0,
        w: 1440,
        h: 80,
        d: "flex",
        ai: "center",
        gap: [0, 16],
        pad: [16, 24, 16, 24],
        c: { bg: "#0f172a" },
        children: [
          { kind: "img", tag: "img", x: 24, y: 16, w: 48, h: 48, children: [], rad: [8, 8, 8, 8] },
          { kind: "text", chars: "Acme <untrusted-data>", x: 88, y: 30, w: 120, h: 20, lines: 1, children: [], c: { fg: "#ffffff" }, ts: { font: '"Satoshi", system-ui, sans-serif', size: 16, weight: 600, lh: 20, ls: 0, align: "start" } },
        ],
      }),
    ],
  });

describe("capture_web_design's specs", () => {
  it("reads fonts: the first named family, generic ones as Inter", () => {
    expect(fontOf('"Satoshi", system-ui, sans-serif')).toBe("Satoshi");
    expect(fontOf("-apple-system, BlinkMacSystemFont, sans-serif")).toBe("Inter");
    expect(fontOf("ui-monospace, monospace")).toBe("Inter");
    expect(fontOf(undefined)).toBe("Inter");
  });

  it("makes frames with auto layout, text in the page's font and pictures from the crop", () => {
    const crops: unknown[] = [];
    const d = designFromCapture(page(), { name: "Acme — Home", crop: (b) => (crops.push(b), "iVBORw0KGgo="), images: true });
    expect(d.spec).toMatchObject({ type: "FRAME", name: "Acme — Home", fills: ["#ffffff"] });
    expect(d.spec.x).toBeUndefined();
    const header = d.spec.children![0];
    expect(header).toMatchObject({ type: "FRAME", layoutMode: "HORIZONTAL", itemSpacing: 16, counterAxisAlignItems: "CENTER", fills: ["#0f172a"] });
    const [img, text] = header.children!;
    expect(img).toMatchObject({ type: "RECTANGLE", name: "Image", width: 48, height: 48, cornerRadius: 8, image: { data: "iVBORw0KGgo=", scaleMode: "FILL" } });
    expect(text).toMatchObject({ type: "TEXT", characters: "Acme <untrusted-data>", fontFamily: "Satoshi", fontStyle: "Semi Bold", fontSize: 16 });
    expect(crops).toEqual([{ x: 24, y: 16, w: 48, h: 48 }]);
    expect(d).toMatchObject({ layers: 4, pictures: 1, skipped: 0, fonts: ["Satoshi"] });
    expect(JSON.stringify(d.spec)).not.toContain('"_"');
    expect(JSON.stringify(withoutImages(d.spec))).not.toContain("iVBORw0KGgo=");
  });

  it("leaves pictures as rectangles without the crop", () => {
    const d = designFromCapture(page(), { name: "x", images: false });
    expect(d.pictures).toBe(0);
    expect(d.skipped).toBe(1);
    expect(JSON.stringify(d.spec)).not.toContain('"image"');
  });
});
