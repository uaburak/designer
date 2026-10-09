// Round 10 on the real engine (headless Wasm): the live capture's file as `&doc=capture` opens it — "Page 1" first,
// then "Capture" (the page it opens on), the Vector a real triangle (vector edit mode has its three points) — and a
// memory source keeps a document's blobs, each change's moved into its own list.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import type { Message } from "@/engine/codec";
import { EditorController } from "../controller";
import { memoryDocumentSource, rehomeBlobs } from "../documentSource";
import { CAPTURE_DOCUMENT, CAPTURE_UI_STATE, CAPTURE_VECTOR_POINTS, polygonNetwork } from "../fixtures";
import { pageMenu } from "../menus";
import { restoreUiState } from "../persistence";

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
  const ed = new EditorController(engine, new EngineStore(engine), source);
  restoreUiState(ed);
  return { ed, engine, source };
}

describe("round 10: the capture fixture", () => {
  it("has the live file's pages, Page 1 then Capture, and opens on Capture", async () => {
    const { ed, engine } = await capture();
    expect(engine.pages().map((p) => p.name)).toEqual(["Page 1", "Capture"]);
    expect(ed.store.page).toBe("0:1");
    expect(engine.pages()[0].guid).toBe("0:3");
    engine.destroy();
  });

  it("offers Move up and Delete page on Capture's row (live context-page-row.txt)", async () => {
    const { ed, engine } = await capture();
    const ids = pageMenu(ed, "0:1").map((e) => (e === "-" ? "-" : "id" in e ? `${e.id}${e.disabled ? " (disabled)" : ""}` : ""));
    expect(ids).toEqual(["page:copy-link (disabled)", "-", "page:rename", "page:duplicate", "-", "page:move-up", "-", "page:delete"]);
    engine.destroy();
  });

  it("draws the Vector as live's triangle: vector edit mode has its three points and three segments", async () => {
    const { engine } = await capture();
    const v = engine.readNode("7:66")!;
    expect(v.vectorData).toEqual({ vectorNetworkBlob: 0, normalizedSize: { x: 80, y: 90 } });
    expect(engine.startVectorEdit("7:66")).toBe(0);
    expect(engine.vectorEdit).toMatchObject({ active: true, ref: "7:66", vertexCount: 3, segmentCount: 3 });
    engine.endVectorEdit();
    // Its network is the fixture's (the engine writes it back the same).
    const doc = engine.encodeDocument();
    const node = doc.nodeChanges.find((n) => n.guid === "7:66")!;
    expect(doc.blobs?.[node.vectorData!.vectorNetworkBlob!]).toBe(polygonNetwork(CAPTURE_VECTOR_POINTS));
    engine.destroy();
  });
});

describe("round 10: memoryDocumentSource keeps blobs", () => {
  it("loads a document's blobs and moves each change's into the same list", async () => {
    const source = memoryDocumentSource(CAPTURE_DOCUMENT);
    const a = polygonNetwork(CAPTURE_VECTOR_POINTS);
    expect((await source.load()).blobs).toEqual([a]);
    const b = polygonNetwork([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    const change: Message = {
      type: "NODE_CHANGES",
      sessionID: 1,
      blobs: [b, a],
      nodeChanges: [
        { guid: "9:1", phase: "CREATED", type: "VECTOR", name: "New", parentIndex: { guid: "0:1", position: "~" }, size: { x: 10, y: 10 }, vectorData: { vectorNetworkBlob: 0, normalizedSize: { x: 10, y: 10 } } },
        { guid: "7:66", vectorData: { vectorNetworkBlob: 1, normalizedSize: { x: 80, y: 90 } } },
      ],
    };
    source.onChanges(change);
    const snap = source.snapshot();
    expect(snap.blobs).toEqual([a, b]);
    expect(snap.nodeChanges.find((n) => n.guid === "9:1")!.vectorData!.vectorNetworkBlob).toBe(1);
    expect(snap.nodeChanges.find((n) => n.guid === "7:66")!.vectorData!.vectorNetworkBlob).toBe(0);
    // The change itself is kept as it came.
    expect(source.changes[0].nodeChanges[0].vectorData!.vectorNetworkBlob).toBe(0);
    // No blobs: the changes as they are.
    const plain: Message = { type: "NODE_CHANGES", sessionID: 1, nodeChanges: [{ guid: "7:66", name: "V" }] };
    expect(rehomeBlobs(plain, [])).toBe(plain.nodeChanges);
  });
});
