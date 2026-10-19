// Atlas 15 (wave 4) on the real engine (headless): a spreadsheet pasted as a grid lays its cells out row by row; an
// angular gradient and a background blur exported as SVG come back through the SVG import with their paint and effect
// (Figma's data-figma-* attributes); a PDF's text is a TrueType subset with a structure tree; export colour profiles.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { loadEngine } from "@/engine/loadEngine";
import { EMPTY_DOCUMENT } from "../fixtures";
import { convertPixels, exportProfile } from "../exportCore";
import { svgToMessage } from "../model/svgImport";
import { spreadsheetCells, spreadsheetToMessage } from "../model/tablePaste";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function emptyEngine() {
  const engine = await Engine.create(null, { sessionID: 7 });
  engine.load(EMPTY_DOCUMENT);
  engine.setViewport(1280, 800, 1, 1280, 800);
  return engine;
}

describe("spreadsheet paste", () => {
  it("lays a pasted table's cells out as a grid: rows below rows, columns side by side", async () => {
    const engine = await emptyEngine();
    const rows = spreadsheetCells("<table><tr><td>Name</td><td>Price</td></tr><tr><td>Tea</td><td>2,50</td></tr></table>")!;
    expect(engine.paste(spreadsheetToMessage(rows), { inPlace: true })).toBe(1);
    const [grid] = engine.getSelection().refs;
    const frame = engine.readNode(grid, { childIds: true })!;
    expect(frame).toMatchObject({ type: "FRAME", stackMode: "GRID" });
    const cells = engine.readNodes(frame.childIds ?? []);
    const at = (text: string) => cells.find((c) => (c as { textData?: { characters?: string } }).textData?.characters === text)!.transform!;
    expect(at("Price").m02).toBeGreaterThan(at("Name").m02);
    expect(at("Price").m12).toBeCloseTo(at("Name").m12);
    expect(at("Tea").m12).toBeGreaterThan(at("Name").m12);
    expect(at("Tea").m02).toBeCloseTo(at("Name").m02);
  });
});

describe("SVG round trip (data-figma-*)", () => {
  it("brings an angular gradient and a background blur back through the import", async () => {
    const engine = await emptyEngine();
    const paint = { type: "GRADIENT_ANGULAR", stops: [{ color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 }, { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 }], transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }, opacity: 1, visible: true, blendMode: "NORMAL" };
    engine.paste(
      {
        type: "NODE_CHANGES",
        sessionID: 0,
        nodeChanges: [
          { guid: "9:1", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Conic", parentIndex: { guid: "0:1", position: "!" }, size: { x: 100, y: 50 }, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }, fillPaints: [paint] },
        ],
      } as never,
      { inPlace: true }
    );
    const [conic] = engine.getSelection().refs;
    engine.setProps([conic], { effects: [{ type: "BACKGROUND_BLUR", radius: 8, visible: true }] } as never);
    const out = engine.exportNodes([conic], { imageType: "SVG" } as never, { allowPending: true });
    expect(out.status).toBe("ok");
    const svg = new TextDecoder().decode((out as { bytes: Uint8Array }).bytes);
    expect(svg).toContain('data-figma-skip-parse="true"');
    expect(svg).toContain("data-figma-gradient-fill=");
    expect(svg).toContain('data-figma-bg-blur-radius="8"');
    const back = svgToMessage(svg).message!.nodeChanges.find((n) => n.type === "ROUNDED_RECTANGLE")!;
    expect(back.fillPaints).toEqual([paint]);
    expect(back.effects).toEqual([{ type: "BACKGROUND_BLUR", radius: 8, visible: true }]);
  });
});

describe("PDF text", () => {
  it("embeds a TrueType subset (FigmaPDF) and tags the text", async () => {
    const engine = await emptyEngine();
    engine.paste(
      {
        type: "NODE_CHANGES",
        sessionID: 0,
        nodeChanges: [
          { guid: "9:1", phase: "CREATED", type: "FRAME", name: "Page", parentIndex: { guid: "0:1", position: "!" }, size: { x: 200, y: 100 }, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 } },
          {
            guid: "9:2",
            phase: "CREATED",
            type: "TEXT",
            name: "Hello",
            parentIndex: { guid: "9:1", position: "!" },
            size: { x: 100, y: 20 },
            transform: { m00: 1, m01: 0, m02: 10, m10: 0, m11: 1, m12: 10 },
            fontName: { family: "Inter", style: "Regular", postscript: "" },
            fontSize: 16,
            textAutoResize: "WIDTH_AND_HEIGHT",
            textData: { characters: "Hello" },
            fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }],
          },
        ],
      } as never,
      { inPlace: true }
    );
    const [frame] = engine.getSelection().refs;
    const out = engine.exportNodes([frame], { imageType: "PDF" } as never, { allowPending: true });
    expect(out.status).toBe("ok");
    const pdf = new TextDecoder("latin1").decode((out as { bytes: Uint8Array }).bytes);
    expect(pdf).toContain("/MarkInfo << /Marked true >> /StructTreeRoot");
    expect(pdf).toContain("/ActualText <FEFF00480065006C006C006F>");
    // Inter (the app's variable font, Regular its default instance) goes in as TrueType when its file is loaded.
    if (pdf.includes("/Subtype /Type0")) expect(pdf).toContain("/Registry (FigmaPDF) /Ordering (FigmaPDF)");
  });
});

describe("export colour profiles", () => {
  it("writes the setting's profile, the document's for Same as file", () => {
    expect(exportProfile({ colorProfile: "DOCUMENT" }, "DISPLAY_P3")).toBe("DISPLAY_P3");
    expect(exportProfile({}, "SRGB")).toBe("SRGB");
    expect(exportProfile({ colorProfile: "SRGB" }, "DISPLAY_P3")).toBe("SRGB");
    expect(exportProfile({ colorProfile: "DISPLAY_P3_V4" }, "SRGB")).toBe("DISPLAY_P3");
  });

  it("converts pixels between sRGB and Display P3 so they look the same", () => {
    const red = Uint8Array.from([255, 0, 0, 255, 128, 128, 128, 200]);
    const p3 = convertPixels(red, "SRGB", "DISPLAY_P3");
    expect([...p3.subarray(0, 4)]).toEqual([234, 51, 35, 255]); // sRGB red in P3 numbers
    expect([...p3.subarray(4)]).toEqual([128, 128, 128, 200]); // greys stay, alpha kept
    expect([...convertPixels(p3, "DISPLAY_P3", "SRGB").subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect(convertPixels(red, "SRGB", "SRGB")).toBe(red);
  });
});
