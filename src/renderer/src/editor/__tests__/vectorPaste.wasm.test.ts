// Vector paste on the real engine (headless): Illustrator's clipboard SVG (a real copy, src/shared/vectorImport/fixtures)
// and its PDF flavour converted by main's converter become editable layers in one paste — Vectors with their networks,
// a Rectangle, an Ellipse, a clip group with an outline mask — selected, one undo step; the engine draws them (its SVG
// export of the pasted group has every shape).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { loadEngine } from "@/engine/loadEngine";
import { EMPTY_DOCUMENT } from "../fixtures";
import { svgToMessage } from "../model/svgImport";
import { pdfToSvg } from "../../../../shared/vectorImport/pdf";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));
const fixture = (name: string) => readFileSync(new URL(`../../../../shared/vectorImport/fixtures/${name}`, import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function emptyEngine() {
  const engine = await Engine.create(null, { sessionID: 7 });
  engine.load(EMPTY_DOCUMENT);
  engine.setViewport(1280, 800, 1, 1280, 800);
  return engine;
}

/** Every node under `id`, depth first, back to front. */
function subtree(engine: Engine, id: string): ReturnType<Engine["readNode"]>[] {
  const n = engine.readNode(id, { childIds: true });
  if (!n) return [];
  return [n, ...(n.childIds ?? []).flatMap((c) => subtree(engine, c))];
}

describe("vector paste", () => {
  it("pastes Illustrator's SVG as editable layers in one undo step", async () => {
    const engine = await emptyEngine();
    const { message } = svgToMessage(fixture("illustrator-copy.svg").toString("utf8"), { x: 100, y: 50 });
    expect(engine.paste(message!, { inPlace: true })).toBe(1);
    const [group] = engine.getSelection().refs;
    const nodes = subtree(engine, group);
    expect(nodes[0]).toMatchObject({ type: "FRAME", name: "Group", resizeToFit: true, transform: { m02: 100, m12: 50 } });
    const types = nodes.map((n) => n!.type);
    expect(types.filter((t) => t === "VECTOR").length).toBe(4); // star, clip mask, two glyphs
    expect(types).toContain("ROUNDED_RECTANGLE");
    expect(types).toContain("ELLIPSE");
    const mask = nodes.find((n) => n!.mask);
    expect(mask).toMatchObject({ type: "VECTOR", maskType: "OUTLINE" });
    // The engine kept the networks: a vector's size and normalized size as pasted.
    const star = nodes.find((n) => n!.type === "VECTOR" && n!.dashPattern?.length)!;
    expect(star.size!.x).toBeCloseTo(76.08, 1);
    expect(star.vectorData?.normalizedSize?.x).toBeCloseTo(76.08, 1);
    // Drawn: the group's SVG export has a path for every shape.
    const out = engine.exportNodes([group], { imageType: "SVG" } as never, { allowPending: true });
    expect(out.status).toBe("ok");
    const svg = new TextDecoder().decode((out as { bytes: Uint8Array }).bytes);
    expect((svg.match(/<path|<rect|<circle|<ellipse/g) ?? []).length).toBeGreaterThanOrEqual(6);
    // One undo step removes all of it.
    expect(engine.undo()).toBe(true);
    expect(engine.readNode(group)).toBeNull();
    engine.destroy();
  });

  it("pastes Illustrator's PDF flavour (converted as main does) as vectors", async () => {
    const engine = await emptyEngine();
    const pdf = pdfToSvg(new Uint8Array(fixture("illustrator-copy.pdf")), (b) => new Uint8Array(inflateSync(b)))!;
    const { message } = svgToMessage(pdf.svg);
    expect(engine.paste(message!, {})).toBe(1);
    const nodes = subtree(engine, engine.getSelection().refs[0]);
    expect(nodes.filter((n) => n!.type === "VECTOR")).toHaveLength(6);
    expect(nodes.some((n) => n!.name === "Clip path group")).toBe(true);
    engine.destroy();
  });
});
