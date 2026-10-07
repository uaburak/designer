// The font index's sfnt reader on the bundled Inter (a variable font: one face per named instance) and, on a Mac,
// on a system collection.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));
const { parseFile } = await import("./fonts");

describe("fonts index (main)", () => {
  it("lists a variable font's named instances", async () => {
    const path = fileURLToPath(new URL("../renderer/src/engine/fonts/InterVariable.ttf", import.meta.url));
    const faces = await parseFile(path, "user");
    expect(faces.map((f) => f.style)).toContain("Regular");
    const bold = faces.find((f) => f.style === "Bold")!;
    expect(bold.family).toMatch(/^Inter/);
    expect(bold.weight).toBe(700);
    expect(bold.italic).toBe(false);
    expect(new Set(faces.map((f) => f.id)).size).toBe(1);
    const italic = await parseFile(path.replace("InterVariable.ttf", "InterVariable-Italic.ttf"), "user");
    expect(italic.every((f) => f.italic)).toBe(true);
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
