// The TS side of the engine ABI agrees with the C++ side (hand-kept twins until apigen generates them).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CommandId, TOOLS } from "../abi";
import { cssCursor, FIGMA_CURSOR_NAMES, resizeCursor, rotateCursor } from "../cursors";
import { FIGMA_CURSORS } from "../cursorArt/figmaCursors.generated";
import { USED_EXPORTS } from "../EngineExports";
import { KEY_CODES, keyCodeOf } from "../keyCodes";

const engine = (path: string) => readFileSync(fileURLToPath(new URL(`../../../../../engine/${path}`, import.meta.url)), "utf8");

describe("engine ABI twins", () => {
  it("key codes: keyCodes.ts = ENG_KEY_CODES in Keys.h, same order", () => {
    const block = engine("src/editor/Keys.h").match(/#define ENG_KEY_CODES\(X\)([\s\S]*?)\n\s*\n/)![1];
    const names = [...block.matchAll(/X\((\w+)\)/g)].map((m) => m[1]);
    expect(names).toEqual([...KEY_CODES]);
    expect(keyCodeOf("KeyV")).toBe(names.indexOf("KeyV"));
    expect(keyCodeOf("F13")).toBe(0);
  });

  it("commands: abi.ts = Commands.h", () => {
    const header = engine("src/editor/Commands.h");
    const ids = Object.fromEntries([...header.matchAll(/^\s+([A-Z_0-9]+) = (\d+),/gm)].map((m) => [m[1], Number(m[2])]));
    expect(ids).toEqual(CommandId);
  });

  it("tools: abi.ts = the Tool enum in Editor.h", () => {
    const body = engine("src/editor/Editor.h").match(/enum class Tool : uint8_t \{([\s\S]*?)\};/)![1];
    const names = body.split(",").map((s) => s.trim()).filter((s) => s && s !== "Count");
    expect(names).toEqual([...TOOLS]);
  });

  it("exports: every function the wrapper calls is exported (api/exports.txt)", () => {
    const exported = new Set(engine("api/exports.txt").split("\n").map((s) => s.trim().replace(/^_/, "")).filter(Boolean));
    for (const name of USED_EXPORTS) expect(exported, name).toContain(name);
  });
});

describe("cursors", () => {
  it("maps a resize handle's angle to the nearest CSS cursor", () => {
    // Drawn at the handle's exact angle (whole degrees), the nearest system cursor behind it.
    // Figma's double arrow at the handle's exact angle (whole degrees) about the box's middle, the nearest system one behind.
    expect(decodeURIComponent(resizeCursor(0))).toMatch(/^image-set\(.* 16 16, ew-resize$/);
    expect(decodeURIComponent(resizeCursor(0))).not.toContain("rotate(");
    expect(resizeCursor(45)).toMatch(/, nwse-resize$/);
    expect(resizeCursor(-90)).toMatch(/, ns-resize$/);
    expect(resizeCursor(135)).toMatch(/, nesw-resize$/);
    expect(decodeURIComponent(resizeCursor(30.4))).toContain("rotate(30 16 16)");
    expect(resizeCursor(210)).toBe(resizeCursor(30));
    expect(resizeCursor(-45)).toMatch(/, nesw-resize$/);
    expect(cssCursor("ROTATE", 30)).toMatch(/^image-set\(url\("data:image\/svg\+xml,.*alias$/);
  });

  it("draws Figma's own pictures at 1x and 2x (64 px for Retina) with Figma's hot spots", () => {
    const css = decodeURIComponent(cssCursor("DEFAULT", 0));
    expect(css).toMatch(/^image-set\(url\("data:image\/svg\+xml,<svg [^>]*width="32"[^)]*\) 1x, url\("data:image\/svg\+xml,<svg [^>]*width="64".*\) 2x\) 4 4, default$/);
    // The arrow's black body (cursor-black-ui3.svg) as Figma's resource has it.
    expect(css).toContain(`<path d="${FIGMA_CURSORS["black-ui3"].body.split('d="')[2]!.split('"')[0]}" fill="#000000"/>`);
    expect(cssCursor("HAND", 0)).toMatch(/ 16 16, grab$/);
    expect(cssCursor("GRABBING", 0)).toMatch(/ 16 16, grabbing$/);
    expect(cssCursor("CROSSHAIR", 0)).toMatch(/ 16 16, crosshair$/);
    expect(cssCursor("EYEDROPPER", 0)).toMatch(/ 8 24, crosshair$/);
    expect(cssCursor("PENCIL", 0)).toMatch(/ 8 24, crosshair$/);
    expect(cssCursor("PEN", 0)).toMatch(/ 4 4, crosshair$/);
    expect(cssCursor("IBEAM", 0)).toBe("text");
    for (const kind of ["BEND", "PAINT_BUCKET", "CUT", "LASSO", "PEN_ADD", "PEN_REMOVE", "PEN_CLOSE", "BRUSH", "TEXT_PATH"] as const) expect(cssCursor(kind, 0)).toMatch(/^image-set\(url\(/);
  });

  it("turns the rotate cursor to the corner: Figma's picture is the top-right corner's", () => {
    expect(decodeURIComponent(rotateCursor(-45))).not.toContain("rotate(");
    expect(decodeURIComponent(rotateCursor(45))).toContain("rotate(90 16 16)");
    expect(decodeURIComponent(rotateCursor(37.4))).toContain("rotate(82 16 16)");
    expect(rotateCursor(-45)).toBe(rotateCursor(315));
  });

  it("draws the spacing cursor (auto layout's padding / gap bars, round 15) at the drag's angle, col / row resize behind", () => {
    expect(cssCursor("SPACING", 0)).toMatch(/^image-set\(url\(.* 16 16, col-resize$/);
    expect(cssCursor("SPACING", 90)).toMatch(/row-resize$/);
    expect(decodeURIComponent(cssCursor("SPACING", 30))).toContain("rotate(30 16 16)");
    expect(cssCursor("SPACING", 270)).toBe(cssCursor("SPACING", 90));
  });

  it("has every picture of Figma's set, each with a hot spot inside its box", () => {
    expect(FIGMA_CURSOR_NAMES.length).toBeGreaterThan(50);
    for (const name of FIGMA_CURSOR_NAMES) {
      const c = FIGMA_CURSORS[name];
      expect(c.hot[0], name).toBeLessThan(c.w);
      expect(c.hot[1], name).toBeLessThan(c.h);
      expect(c.body, name).toMatch(/^<path d="M/);
    }
  });
});
