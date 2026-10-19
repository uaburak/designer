// Atlas 15 (wave 4) — the clipboard as Figma's: a spreadsheet's HTML table → a grid of texts (model/tablePaste.ts),
// a URL or e-mail pasted onto selected characters → a link (clipboardIO.ts `pastedLink`), Copy properties' STYLE
// Message in the clipboard's HTML (model/clipboard.ts) — a fig-kiwi archive with MessageType.STYLE, as Figma writes it,
// and Figma's own read back — that ⌘V never pastes as layers.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { decodeBinarySchema } from "kiwi-schema";
import { describe, expect, it } from "vitest";
import type { NodeChange } from "@/engine/codec";
import { propertiesOnClipboard, pastedLink } from "../clipboardIO";
import { bytesToB64, decodePropertiesClipboard, encodePropertiesClipboard, readClipboard } from "../model/clipboard";
import { figContainer, readCanvasChunks } from "../../../../shared/fig/container";
import { readFigFile } from "../../../../shared/fig/figFile";
import { interpretSchema } from "../../../../shared/schema/dynamic";
import { isSpreadsheetHtml, spreadsheetCells, spreadsheetToMessage } from "../model/tablePaste";

const SHEETS =
  '<meta charset="utf-8"><google-sheets-html-origin><style type="text/css"><!--td {border: 1px solid #cccccc;}--></style>' +
  '<table xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0" dir="ltr" border="1"><colgroup><col width="100"/><col width="100"/></colgroup>' +
  '<tbody><tr style="height:21px;"><td style="overflow:hidden;">Name</td><td>Price</td></tr><tr><td>Tea &amp; milk</td><td style="text-align:right;">2,50</td></tr>' +
  '<tr><td colspan="2" rowspan="1">Total<br/>(VAT)</td></tr></tbody></table>';

describe("spreadsheet paste", () => {
  it("knows a spreadsheet's HTML: Google Sheets, Excel, or one table and nothing else", () => {
    expect(isSpreadsheetHtml(SHEETS)).toBe(true);
    expect(isSpreadsheetHtml('<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta name=ProgId content=Excel.Sheet></head><body><table><tr><td>1</td></tr></table></body></html>')).toBe(true);
    expect(isSpreadsheetHtml("<meta charset='utf-8'><table><tr><td>a</td></tr></table>")).toBe(true);
    expect(isSpreadsheetHtml("<p>Intro</p><table><tr><td>a</td></tr></table>")).toBe(false);
    expect(isSpreadsheetHtml("<table><tr><td>a</td></tr></table><table><tr><td>b</td></tr></table>")).toBe(false);
    expect(isSpreadsheetHtml("plain text")).toBe(false);
  });

  it("reads the cells row by row (entities, line breaks, a spanning cell's empty neighbours)", () => {
    expect(spreadsheetCells(SHEETS)).toEqual([
      ["Name", "Price"],
      ["Tea & milk", "2,50"],
      ["Total\n(VAT)", ""],
    ]);
  });

  it("makes a grid frame with a text per non-empty cell anchored to its column and row", () => {
    const m = spreadsheetToMessage(spreadsheetCells(SHEETS)!);
    const [frame, ...cells] = m.nodeChanges as (NodeChange & Record<string, unknown>)[];
    expect(frame).toMatchObject({ type: "FRAME", stackMode: "GRID", gridReflowEnabled: false });
    const cols = (frame.gridColumns as { entries: { id: unknown }[] }).entries;
    const rows = (frame.gridRows as { entries: { id: unknown }[] }).entries;
    expect(cols).toHaveLength(2);
    expect(rows).toHaveLength(3);
    expect((frame.gridColumnsSizing as { entries: { trackSize: { maxSizing: { type: string } } }[] }).entries[0].trackSize.maxSizing.type).toBe("HUG");
    expect(cells.map((c) => (c.textData as { characters: string }).characters)).toEqual(["Name", "Price", "Tea & milk", "2,50", "Total\n(VAT)"]);
    expect(cells.every((c) => c.type === "TEXT" && c.parentIndex?.guid === frame.guid)).toBe(true);
    expect(cells[3]).toMatchObject({ gridColumnAnchor: cols[1].id, gridRowAnchor: rows[1].id });
    expect(new Set(m.nodeChanges.map((n) => n.guid)).size).toBe(m.nodeChanges.length);
  });
});

describe("a link pasted onto selected text", () => {
  it("takes URLs and e-mail addresses, nothing else", () => {
    expect(pastedLink("https://figma.com/design/abc")).toBe("https://figma.com/design/abc");
    expect(pastedLink("  www.example.org/path?q=1 ")).toBe("https://www.example.org/path?q=1");
    expect(pastedLink("hello@example.com")).toBe("mailto:hello@example.com");
    expect(pastedLink("mailto:a@b.co")).toBe("mailto:a@b.co");
    expect(pastedLink("file.txt")).toBeNull();
    expect(pastedLink("see https://figma.com")).toBeNull();
    expect(pastedLink("https://")).toBeNull();
  });
});

describe("Copy properties through the clipboard", () => {
  it("writes Figma's STYLE Message (one node at 0:0, the file it came from) as a fig-kiwi archive and reads it back", () => {
    const formats = encodePropertiesClipboard({ type: "ROUNDED_RECTANGLE", opacity: 0.5, cornerRadius: 8 } as unknown as NodeChange, "lib-1");
    expect(formats["text/html"]).toContain("(figma)");
    const read = (type: string) => formats[type];
    const props = decodePropertiesClipboard(read);
    expect(props).toEqual({ node: { type: "ROUNDED_RECTANGLE", opacity: 0.5, cornerRadius: 8, guid: "0:0", phase: "CREATED" }, fileKey: "lib-1" });
    // From the HTML alone (another window's copy), and never as layers.
    expect(decodePropertiesClipboard((type) => (type === "text/html" ? formats["text/html"] : null))?.node.opacity).toBe(0.5);
    expect(readClipboard(read)).toBeNull();
    expect(readClipboard((type) => (type === "text/html" ? formats["text/html"] : null))).toBeNull();
    expect(decodePropertiesClipboard(() => "<p>hi</p>")).toBeNull();
  });

  it("reads a Figma ⌥⌘C: its STYLE Message in Figma's schema, compressed", async () => {
    // Figma's binary schema, as embedded in the owner's sample (docs/research/figma/samples/sections.fig).
    const sample = readFigFile(new Uint8Array(readFileSync(join(__dirname, "../../../../../docs/research/figma/samples/sections.fig"))), { inflateRaw: (b) => new Uint8Array(inflateRawSync(b)) });
    const schema = new Uint8Array(inflateRawSync(readCanvasChunks(sample.canvas).chunks[0]));
    const message = interpretSchema(decodeBinarySchema(schema)).encode("Message", {
      type: "STYLE",
      sessionID: 0,
      pasteFileKey: "AbCdEf",
      nodeChanges: [{ guid: { sessionID: 0, localID: 0 }, phase: "CREATED", type: "ROUNDED_RECTANGLE", opacity: 0.25, cornerRadius: 4 }],
    });
    const archive = bytesToB64(figContainer(schema, message, 106, { deflateRaw: (b) => new Uint8Array(deflateRawSync(b)), inflateRaw: (b) => new Uint8Array(inflateRawSync(b)) }));
    const html = `<meta charset="utf-8"><div><span data-metadata="<!--(figmeta)e30=(/figmeta)-->"></span><span data-buffer="<!--(figma)${archive}(/figma)-->"></span></div>`;
    const read = (type: string) => (type === "text/html" ? html : null);
    const props = await propertiesOnClipboard(read);
    expect(props?.node).toMatchObject({ type: "ROUNDED_RECTANGLE", opacity: 0.25, cornerRadius: 4 });
    expect(props?.fileKey).toBe("AbCdEf");
  });
});
