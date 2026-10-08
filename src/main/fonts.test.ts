// The font index's sfnt reader on the bundled Inter (a variable font: one face per named instance) and, on a Mac,
// on a system collection.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));
const { parseFile } = await import("./fonts");

describe("fonts index (main)", () => {
  it("lists a variable font's named instances", async () => {
    // Figma's Inter (3.19): one file, wght and slnt axes, eighteen named instances.
    const path = fileURLToPath(new URL("../renderer/src/engine/fonts/Inter-3.19.ttf", import.meta.url));
    const faces = await parseFile(path, "user");
    expect(faces).toHaveLength(18);
    const bold = faces.find((f) => f.style === "Bold")!;
    expect(bold.family).toBe("Inter");
    expect(bold.weight).toBe(700);
    expect(bold.italic).toBe(false);
    expect(bold.variable).toBe(true);
    expect(new Set(faces.map((f) => f.id)).size).toBe(1);
    const italic = faces.filter((f) => f.style.includes("Italic"));
    expect(italic).toHaveLength(9);
    expect(italic.every((f) => f.italic)).toBe(true);
    // Inter 4.1 (kept for the engine's native tests): its italic file's instances are all italic.
    const v4 = fileURLToPath(new URL("../renderer/src/engine/fonts/InterVariable-Italic.ttf", import.meta.url));
    expect((await parseFile(v4, "user")).every((f) => f.italic)).toBe(true);
  });

  it.runIf(existsSync("/System/Library/Fonts/Helvetica.ttc"))("reads a TrueType collection's faces", async () => {
    const faces = await parseFile("/System/Library/Fonts/Helvetica.ttc", "system");
    expect(faces.length).toBeGreaterThan(2);
    expect(faces.every((f) => f.family === "Helvetica")).toBe(true);
    expect(faces.some((f) => f.weight >= 700)).toBe(true);
    expect(new Set(faces.map((f) => f.collectionIndex)).size).toBe(faces.length);
  });
});

describe("fonts:read slices a collection to one face", () => {
  it.runIf(existsSync("/System/Library/Fonts/Helvetica.ttc"))("keeps the face at its collection index, in a far smaller file", async () => {
    const { sliceFace } = await import("./fonts");
    const { open, readFile, stat, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const path = "/System/Library/Fonts/Helvetica.ttc";
    const faces = await parseFile(path, "system");
    const target = faces.find((f) => f.collectionIndex > 0)!;
    const fh = await open(path, "r");
    let sliced: Uint8Array | null = null;
    try {
      const head = Buffer.alloc(12 + 64 * 4);
      await fh.read(head, 0, head.length, 0);
      const base = head.readUInt32BE(12 + target.collectionIndex * 4);
      sliced = await sliceFace(fh, base, target.collectionIndex);
    } finally {
      await fh.close();
    }
    expect(sliced).not.toBeNull();
    const whole = (await stat(path)).size;
    expect(sliced!.length).toBeLessThan(whole / 2);
    // Parsed back as a collection: the face sits at the same index, with the same names and weight.
    const out = join(tmpdir(), `designer-sliced-${process.pid}.ttc`);
    await writeFile(out, sliced!);
    const again = await parseFile(out, "system");
    const same = again.filter((f) => f.collectionIndex === target.collectionIndex);
    expect(same.length).toBeGreaterThan(0);
    expect(same[0].family).toBe(target.family);
    expect(same[0].style).toBe(target.style);
    expect(same[0].weight).toBe(target.weight);
    expect((await readFile(out)).subarray(0, 4).toString("latin1")).toBe("ttcf");
  });
});

describe("fonts:changed (the font folders watched)", () => {
  it("rescans after a font is installed or removed and reports once per change", async () => {
    const { watchFonts } = await import("./fonts");
    const { copyFileSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fonts-watch-"));
    const inter = fileURLToPath(new URL("../renderer/src/engine/fonts/Inter-3.19.ttf", import.meta.url));
    const rescan = async () => (await Promise.all(readdirSync(dir).filter((n) => n.endsWith(".ttf")).map((n) => parseFile(join(dir, n), "user")))).flat();
    const versions: number[] = [];
    const stop = watchFonts((v) => versions.push(v), { dirs: [dir], debounceMs: 50, rescan });
    try {
      await new Promise((r) => setTimeout(r, 100));
      copyFileSync(inter, join(dir, "Inter.ttf"));
      await vi.waitFor(() => expect(versions).toHaveLength(1), { timeout: 3000, interval: 50 });
      // A file that isn't a font changes nothing a picker shows.
      writeFileSync(join(dir, "notes.txt"), "x");
      await new Promise((r) => setTimeout(r, 300));
      expect(versions).toHaveLength(1);
      unlinkSync(join(dir, "Inter.ttf"));
      await vi.waitFor(() => expect(versions).toHaveLength(2), { timeout: 3000, interval: 50 });
      expect(versions[1]).toBeGreaterThan(versions[0]);
    } finally {
      stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
