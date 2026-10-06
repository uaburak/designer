// The TS side of the engine ABI agrees with the C++ side (hand-kept twins until apigen generates them).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CommandId, TOOLS } from "../abi";
import { cssCursor, resizeCursor } from "../cursors";
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
    expect(resizeCursor(0)).toBe("ew-resize");
    expect(resizeCursor(45)).toBe("nwse-resize");
    expect(resizeCursor(-90)).toBe("ns-resize");
    expect(resizeCursor(135)).toBe("nesw-resize");
    expect(resizeCursor(-45)).toBe("nesw-resize");
    expect(cssCursor("HAND", 0)).toBe("grab");
    expect(cssCursor("ROTATE", 30)).toMatch(/^url\("data:image\/svg\+xml,.*alias$/);
  });
});
