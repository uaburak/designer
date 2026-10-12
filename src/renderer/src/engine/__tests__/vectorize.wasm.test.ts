// Vectorize in the real engine (the committed release Wasm), headless (docs/ai.md §5): engine_trace's TraceResult,
// the live preview (begin / update / end as one undo step, cancel), and the budget's bench case (1024², 8 colours).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { Pixels } from "../codec";
import { Engine } from "../Engine";
import { loadEngine } from "../loadEngine";
import { SAMPLE_DOCUMENT } from "../sampleDocument";

const wasm = fileURLToPath(new URL("../wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

function image(width: number, height: number, f: (x: number, y: number) => [number, number, number, number]): Pixels {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) pixels.set(f(x, y), (y * width + x) * 4);
  return { width, height, pixels };
}

const target = image(80, 80, (x, y) => {
  const d = Math.hypot(x + 0.5 - 40, y + 0.5 - 40);
  return d < 20 ? [200, 30, 30, 255] : d < 32 ? [20, 20, 160, 255] : [255, 255, 255, 255];
});

describe("vectorize (wasm, headless)", () => {
  it("traces pixels to stacked colour layers", async () => {
    const engine = await Engine.create(null, { sessionID: 9 });
    const r = engine.trace(target, { mode: "FULL_COLOR", colors: 3 })!;
    expect(r.width).toBe(80);
    expect(r.layers.map((l) => l.color)).toEqual(["#FFFFFF", "#1414A0", "#C81E1E"].slice(0, r.layers.length));
    expect(r.layers).toHaveLength(3);
    expect(r.layers[0].d.startsWith("M 0 0")).toBe(true);
    const bw = engine.trace(target, { mode: "BLACK_AND_WHITE", threshold: 0 })!;
    expect(bw.layers).toHaveLength(1);
    expect(engine.trace({ width: 4, height: 4, pixels: new Uint8Array(3) }, { mode: "GRAYSCALE" })).toBeNull();
    engine.destroy();
  });

  it("a 1024² flat logo keeps its colours (k-means samples spread over the whole picture in 32-bit wasm)", async () => {
    // Found running Vectorize in the app (2026-10-12): s × pixel count overflowed wasm's 32-bit size_t, every sample
    // came from the white top rows and the logo traced as one layer of its mean colour.
    const engine = await Engine.create(null, { sessionID: 9 });
    const logo = image(1024, 1024, (x, y) => {
      const d = Math.hypot(x + 0.5 - 512, y + 0.5 - 512);
      return d < 150 ? [251, 191, 36, 255] : d < 400 ? [30, 64, 175, 255] : [255, 255, 255, 255];
    });
    const r = engine.trace(logo, { mode: "FULL_COLOR", colors: 8 })!;
    expect(r.layers.map((l) => l.color).sort()).toEqual(["#1E40AF", "#FBBF24", "#FFFFFF"]);
    engine.destroy();
  });

  it("previews, commits one undo step, undoes, cancels", async () => {
    const engine = await Engine.create(null, { sessionID: 9 });
    engine.load(SAMPLE_DOCUMENT);
    const layer = "1:5";
    const name = engine.readNode(layer)!.name;
    const labels: string[] = [];
    engine.onAny((e) => {
      if (e.type === "DOCUMENT_CHANGED") labels.push(e.label);
    });
    const begun = engine.vectorizeBegin(layer, target);
    expect(begun.status).toBe("ok");
    if (begun.status !== "ok") return;
    expect(engine.vectorizeBegin(layer, target).status).toBe("busy");
    const stats = engine.vectorizeUpdate({ mode: "FULL_COLOR", colors: 3 })!;
    expect(stats.layers).toBe(3);
    expect(stats.exceeded).toBe(false);
    expect(engine.readNode(begun.frame, { childIds: true })!.childIds).toHaveLength(3);
    expect(engine.vectorizeUpdate({ mode: "GRAYSCALE", grays: 2 })!.layers).toBe(2);
    expect(labels).toEqual([]);  // nothing leaves the engine while previewing
    expect(engine.vectorizeEnd(true)).toBe(begun.frame);
    expect(labels).toEqual(["Vectorize"]);
    expect(engine.readNode(layer)).toBeNull();
    const frame = engine.readNode(begun.frame, { childIds: true })!;
    expect(frame.type).toBe("FRAME");
    expect(frame.name).toBe(name);
    expect(frame.childIds).toHaveLength(2);
    expect(engine.readNode(frame.childIds![0])!.type).toBe("VECTOR");
    engine.command("UNDO");
    expect(engine.readNode(layer)).not.toBeNull();
    expect(engine.readNode(begun.frame)).toBeNull();

    const again = engine.vectorizeBegin(layer, target);
    expect(again.status).toBe("ok");
    engine.vectorizeUpdate({ mode: "BLACK_AND_WHITE", threshold: 60 });
    expect(engine.vectorizeEnd(false)).toBeNull();
    expect(engine.readNode(layer)).not.toBeNull();
    if (again.status === "ok") expect(engine.readNode(again.frame)).toBeNull();
    expect(engine.vectorizeUpdate({ mode: "FULL_COLOR" })).toBeNull();
    engine.destroy();
  });

  it("bench: 1024², 8 colours (the budget: ≤ 250 ms per update in release wasm)", async () => {
    const engine = await Engine.create(null, { sessionID: 9 });
    let s = 12345;
    const photo = image(1024, 1024, (x, y) => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const n = ((s >>> 24) % 24) - 12;
      const fx = x / 1024, fy = y / 1024;
      const c = (v: number) => Math.max(0, Math.min(255, Math.trunc(v * 255 + n)));
      return [c(0.5 + 0.5 * Math.sin(fx * 7 + fy * 3)), c(0.5 + 0.5 * Math.cos(fy * 9 - fx * 2)), c(fx * fy), 255];
    });
    engine.load(SAMPLE_DOCUMENT);
    const begun = engine.vectorizeBegin("1:5", photo);
    expect(begun.status).toBe("ok");
    const times: string[] = [];
    const totals: number[] = [];
    for (const colors of [8, 6, 8]) {
      const t0 = performance.now();
      const stats = engine.vectorizeUpdate({ mode: "FULL_COLOR", colors })!;
      totals.push(performance.now() - t0);
      expect(stats.exceeded).toBe(false);
      expect(stats.layers).toBe(colors);
      times.push(`${stats.ms} trace / ${totals[totals.length - 1].toFixed(1)} update`);
    }
    engine.vectorizeEnd(false);
    if (process.env.VECTORIZE_BENCH) process.stderr.write(`vectorize bench 1024² (ms): ${times.join(", ")}\n`);
    // Generous here (shared machines); the measured figure is recorded in docs/ai.md §5 "As built".
    expect(Math.min(...totals)).toBeLessThan(1000);
    engine.destroy();
  });
});
