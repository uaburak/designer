import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ clipboard: { read: async () => [] } }));

const { readVectorClipboard } = await import("./clipboard");

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../shared/vectorImport/fixtures/${name}`, import.meta.url)));
const raw = (uti: string) => `electron application/osclipboard;format="${uti}"`;

/** A pasteboard holding these types (what Electron's clipboard.read() listed for a real Illustrator copy). */
const board = (data: Record<string, Uint8Array>) => ({ types: Object.keys(data), read: async (t: string) => data[t] ?? null });
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("readVectorClipboard", () => {
  it("prefers Illustrator's own SVG (text as outlines) over the other flavours", async () => {
    const r = await readVectorClipboard(
      board({
        "image/svg+xml": png, // Chromium's name for the PNG here
        [raw("CorePasteboardFlavorType 0x73766720")]: fixture("illustrator-copy.public.svg"),
        [raw("com.adobe.illustrator.svg")]: fixture("illustrator-copy.svg"),
        [raw("com.adobe.pdf")]: fixture("illustrator-copy.pdf"),
        [raw("com.adobe.illustrator.aicb")]: new Uint8Array([1]),
      }),
    );
    expect(r?.source).toBe("com.adobe.illustrator.svg");
    expect(r?.svg).toContain("cls-3");
  });

  it("falls back to Illustrator's PDF when its SVG flavour is off", async () => {
    const r = await readVectorClipboard(board({ "image/svg+xml": png, "image/png": png, [raw("com.adobe.pdf")]: fixture("illustrator-copy.pdf"), [raw("com.adobe.illustrator.aicb")]: new Uint8Array([1]) }));
    expect(r?.source).toBe("com.adobe.pdf");
    expect(r?.svg).toMatch(/^<svg[^>]*viewBox="0 0 320 223"/);
    expect(r?.skipped.text).toBe(1);
  });

  it("leaves a picture-only clipboard, and another app's PDF, to the image paste", async () => {
    expect(await readVectorClipboard(board({ "image/png": png, "image/svg+xml": png }))).toBeNull();
    expect(await readVectorClipboard(board({ "image/png": png, [raw("Apple PDF pasteboard type")]: fixture("illustrator-copy.pdf") }))).toBeNull();
  });
});
