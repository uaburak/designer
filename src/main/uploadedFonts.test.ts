// Settings › Your uploaded fonts in main: files checked, copied once under their hash, listed by face, removed.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" }, dialog: {}, webContents: { getAllWebContents: () => [] } }));
const { addFontFiles, removeUploadedFont, uploadedFonts } = await import("./uploadedFonts");
const { readFont } = await import("./fonts");

const inter = fileURLToPath(new URL("../renderer/src/engine/fonts/Inter-3.19.ttf", import.meta.url));
let dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "uploaded-fonts-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("uploaded fonts", () => {
  it("copies a font in once, lists its faces (readable for the sample), refuses what isn't a font, removes its file", async () => {
    const folder = temp();
    const junk = join(temp(), "notes.ttf");
    writeFileSync(junk, "not a font");
    const r = await addFontFiles([inter, inter, junk], folder);
    expect(r).toEqual({ added: 2, failed: ["notes.ttf"] });
    expect(readdirSync(folder)).toHaveLength(1);
    expect(readdirSync(folder)[0]).toMatch(/^Inter-[0-9a-f]{8}\.ttf$/);
    const rows = await uploadedFonts(folder);
    expect(rows).toHaveLength(18);
    expect(rows[0]).toMatchObject({ family: "Inter", style: "Thin", weight: 100, italic: false });
    expect(rows.find((f) => f.style === "Bold Italic")).toMatchObject({ weight: 700, italic: true });
    // The sample's bytes: the face's file, found without waiting for the index's rescan.
    expect((await readFont(rows[0].id)).length).toBeGreaterThan(100_000);
    expect(await removeUploadedFont(rows[0].id, folder)).toEqual([]);
    expect(readdirSync(folder)).toEqual([]);
  });
});
