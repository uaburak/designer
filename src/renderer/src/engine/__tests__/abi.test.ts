// The TS side of the engine ABI agrees with the C++ side (hand-kept twins until apigen generates them).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CommandId, TOOLS } from "../abi";
import { cssCursor, resizeCursor, rotateCursor } from "../cursors";
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
    expect(decodeURIComponent(resizeCursor(0))).toMatch(/rotate\(0 12 12\).* 12 12, ew-resize$/);
    expect(resizeCursor(45)).toMatch(/, nwse-resize$/);
    expect(resizeCursor(-90)).toMatch(/, ns-resize$/);
    expect(resizeCursor(135)).toMatch(/, nesw-resize$/);
    expect(decodeURIComponent(resizeCursor(30.4))).toContain("rotate(30 12 12)");
    expect(resizeCursor(210)).toBe(resizeCursor(30));
    expect(resizeCursor(-45)).toMatch(/, nesw-resize$/);
    expect(cssCursor("HAND", 0)).toBe("grab");
    expect(cssCursor("ROTATE", 30)).toMatch(/^image-set\(url\("data:image\/svg\+xml,.*alias$/);
  });

  it("draws every cursor at 1x and 2x (48 px for Retina), rotate cursors at the corner's exact angle", () => {
    const css = decodeURIComponent(cssCursor("DEFAULT", 0));
    expect(css).toMatch(/^image-set\(url\("data:image\/svg\+xml,<svg [^>]*width="24"[^)]*\) 1x, url\("data:image\/svg\+xml,<svg [^>]*width="48".*\) 2x\) 5 3, default$/);
    expect(decodeURIComponent(rotateCursor(37.4))).toContain("rotate(37 12 12)");
    expect(rotateCursor(-45)).toBe(rotateCursor(315));
    for (const kind of ["PENCIL", "BEND", "PAINT_BUCKET", "CUT", "LASSO"] as const) expect(cssCursor(kind, 0)).toMatch(/^image-set\(url\(/);
  });
});
