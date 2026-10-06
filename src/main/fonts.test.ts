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
