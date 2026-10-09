// Round 11 on the real engine (headless Wasm): the capture's set "Chip" is live's — no stroke (live component-set.txt
// has an empty Stroke section), radius 5, a horizontal auto layout — and Add variant (the canvas's "+") takes the new
// variant into its flow: the set hugs it, its height stays, one undo step.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { loadEngine } from "@/engine/loadEngine";
import { memoryDocumentSource } from "../documentSource";
import { CAPTURE_DOCUMENT, CAPTURE_UI_STATE } from "../fixtures";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function capture() {
  const source = memoryDocumentSource(CAPTURE_DOCUMENT, { fileName: "Untitled", uiState: CAPTURE_UI_STATE });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setCurrentPage("0:1");
  return engine;
}

const variants = (engine: Engine) => engine.layerTree("0:1").filter((n) => n.parentIndex?.guid === "8:40" && n.type === "SYMBOL");

describe("round 11: the capture's component set", () => {
  it("has no stroke, as live's (its Stroke section is empty), a 5 px radius and a horizontal auto layout", async () => {
    const engine = await capture();
    const set = engine.readNode("8:40")!;
    expect(set.strokePaints ?? []).toEqual([]);
    expect(set.cornerRadius).toBe(5);
    expect(set.stackMode).toBe("HORIZONTAL");
    expect(set.size).toEqual({ x: 364, y: 40 });
    expect(variants(engine)).toHaveLength(3);
    engine.destroy();
  });

  it("Add variant (the canvas's +) puts the new variant in the flow after the last: the set hugs it, 480 × 40", async () => {
    const engine = await capture();
    engine.setSelection(["8:40"]);
    expect(engine.command("ADD_VARIANT")).toBe(0);
    const after = variants(engine);
    expect(after).toHaveLength(4);
    const added = engine.readNode(engine.getSelection().refs[0])!;
    expect(added.type).toBe("SYMBOL");
    expect(added.transform?.m02).toBe(364);
    expect(added.transform?.m12).toBe(16);
    expect(engine.readNode("8:40")!.size).toEqual({ x: 480, y: 40 });
    expect(engine.command("UNDO")).toBe(0);
    expect(variants(engine)).toHaveLength(3);
    expect(engine.readNode("8:40")!.size).toEqual({ x: 364, y: 40 });
    engine.destroy();
  });
});
