// The `discovery_text` job's client side (docs/governance.md §2.11) on the committed wasm engine: the fields it reads
// exist under these names, and a document's texts, annotations and component documentation come back.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { loadEngine } from "@/engine/loadEngine";
import type { Message, NodeChange } from "@/engine/codec";
import { discoveryText } from "../discoveryText";

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync("src/renderer/src/engine/wasm/engine.wasm");
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

const DOC: Message = {
  type: "NODE_CHANGES",
  sessionID: 0,
  nodeChanges: [
    { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
    { guid: "0:1", phase: "CREATED", type: "CANVAS", name: "Page 1", parentIndex: { guid: "0:0", position: "!" } },
    { guid: "1:2", phase: "CREATED", type: "TEXT", name: "Hello", parentIndex: { guid: "0:1", position: "!" }, size: { x: 50, y: 20 }, textData: { characters: "Hello world" } },
    { guid: "1:3", phase: "CREATED", type: "FRAME", name: "Card", parentIndex: { guid: "0:1", position: '"' }, size: { x: 100, y: 100 }, annotations: [{ label: "Use 16 padding" }] },
    { guid: "1:4", phase: "CREATED", type: "SYMBOL", name: "Button", parentIndex: { guid: "0:1", position: "#" }, size: { x: 80, y: 32 }, description: "Primary action", symbolLinks: [{ uri: "https://example.com/button" }] },
  ] as unknown as NodeChange[],
};

describe("discoveryText on the engine", () => {
  it("reads TEXT characters, annotations, component descriptions and links", async () => {
    const engine = await Engine.create(null, { sessionID: 1 });
    try {
      engine.load(DOC);
      expect(discoveryText(engine)).toEqual([
        { nodeId: "1:2", textType: "in_file", text: "Hello world" },
        { nodeId: "1:3", textType: "dev_mode_annotation", text: "Use 16 padding" },
        { nodeId: "1:4", textType: "component_documentation_description", text: "Primary action" },
        { nodeId: "1:4", textType: "component_documentation_link", text: "https://example.com/button" },
      ]);
    } finally {
      engine.destroy();
    }
  });
});
