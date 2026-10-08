// The open path with kiwi at the engine's boundary (docs/engine-build.md "Figma parity round 3"), on the real wasm:
// the store's own snapshot and journal bytes go to the engine as they are (engine_load_at, then each frame applied
// as "load"), and the document the engine holds equals what the JSON path gives; the engine's own kiwi snapshot goes
// back to the store, which adopts it, and the next open loads from it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Status } from "@/engine/abi";
import { Engine } from "@/engine/Engine";
import { loadEngine } from "@/engine/loadEngine";
import type { Message, NodeChange } from "@/engine/codec";
import { openStoreDocument } from "@/store/documentSource";
import { rpcTestbed, type RpcTestbed } from "../../../../store/testing/rpcHarness";
import { decodeMessage } from "../../../../shared/schema/codec";
import { applyEngineBytes, changeBytesOf, changesOf, encodeDocumentBytes, engineDerivedDataVersion, engineWireFormat, loadEngineBytes } from "../engineCompat";
import { EngineStore } from "@/engine/EngineStore";
import { archiveMessage, CLIPBOARD_TYPE, encodeClipboardKiwi, readClipboard } from "../model/clipboard";
import { inflateRawStored } from "../../../../shared/fig/compression";
import { readCanvasChunks } from "../../../../shared/fig/container";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

let bed: RpcTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

const rect = (s: number, l: number, extra: Partial<NodeChange> = {}): NodeChange => ({
  guid: `${s}:${l}`,
  phase: "CREATED",
  type: "ROUNDED_RECTANGLE",
  name: `Rectangle ${l}`,
  parentIndex: { guid: "0:1", position: String.fromCharCode(33 + l) },
  size: { x: 100, y: 50 },
  transform: { m00: 1, m01: 0, m02: l * 10, m10: 0, m11: 1, m12: 20 },
  fillPaints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }],
  ...extra,
});

/** What a document is, for comparing two engines: every node's name, parent, size and position, by GUID. */
function shape(engine: Engine): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const n of engine.encodeDocument().nodeChanges) out[n.guid] = { name: n.name, type: n.type, parent: n.parentIndex?.guid ?? null, size: n.size ?? null, x: n.transform?.m02 ?? null, fill: n.fillPaints?.[0]?.color ?? null };
  return out;
}

describe("kiwi at the engine's boundary (wasm, headless)", () => {
  it("loads the store's snapshot and journal bytes as they are, the same document as the JSON path", async () => {
    const probe = await Engine.create(null, { sessionID: 1 });
    const kiwi = engineWireFormat(probe) === "kiwi";
    probe.destroy();
    expect(kiwi).toBe(true); // the committed wasm has kiwi at its boundary (round 3)
    if (!kiwi) return; // an engine without kiwi at its boundary (the JSON path is covered elsewhere)

    bed = await rpcTestbed();
    const client = await bed.connect("editor");
    const f = await client.workspace.createFile({ name: "Kiwi", folderId: null });
    const src = await openStoreDocument(client, f.fileKey);
    const s = src.sessionID;
    const msg = (nodeChanges: NodeChange[]): Message => ({ type: "NODE_CHANGES", sessionID: s, nodeChanges });
    src.onChanges(msg([rect(s, 1), rect(s, 2)]), { kind: "USER", label: "Create" });
    src.onChanges(msg([{ guid: `${s}:2`, name: "Hero", fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 1, a: 1 }, opacity: 1, visible: true }] }]), { kind: "USER", label: "Rename" });
    src.onChanges(msg([{ guid: `${s}:1`, phase: "REMOVED" }]), { kind: "USER", label: "Delete" });
    await src.close();

    const again = await openStoreDocument(client, f.fileKey);
    const prepared = again.prepare("kiwi");
    expect(prepared.raw?.frames.length).toBe(3);
    expect((await prepared.document).bytes).toBeNull(); // nothing converted

    // The kiwi path: the snapshot, then each frame, as the store holds them.
    const viaKiwi = await Engine.create(null, { sessionID: again.sessionID });
    expect(loadEngineBytes(viaKiwi, prepared.raw!.snapshot, "kiwi", { page: "0:1" })).toBe(Status.OK);
    for (const frame of prepared.raw!.frames) expect(applyEngineBytes(viaKiwi, frame, "load")).toBe(Status.OK);
    // The JSON path, as before.
    const viaJson = await Engine.create(null, { sessionID: again.sessionID });
    expect(viaJson.load(await again.load())).toBe(Status.OK);
    expect(shape(viaKiwi)).toEqual(shape(viaJson));
    expect((shape(viaKiwi)[`${s}:2`] as { name: string }).name).toBe("Hero");
    expect(shape(viaKiwi)[`${s}:1`]).toBeUndefined();

    // The engine's own kiwi snapshot goes back to the store at the head the source stands at; the next open loads it.
    const snapshot = encodeDocumentBytes(viaKiwi, { derived: true });
    expect(snapshot).not.toBeNull();
    const decoded = decodeMessage(snapshot!);
    expect(decoded.nodeChanges![0].type).toBe("DOCUMENT");
    expect(await again.saveSnapshot(snapshot!, { derivedDataVersion: decoded.derivedDataVersion ?? 0 })).toBe(true);
    await again.close();
    const third = await openStoreDocument(client, f.fileKey);
    const p3 = third.prepare("kiwi");
    expect(p3.raw?.frames).toEqual([]);
    expect(p3.raw?.derivedDataVersion).toBe(decoded.derivedDataVersion ?? 0);
    const viaSnapshot = await Engine.create(null, { sessionID: third.sessionID });
    expect(loadEngineBytes(viaSnapshot, p3.raw!.snapshot, "kiwi")).toBe(Status.OK);
    expect(shape(viaSnapshot)).toEqual(shape(viaJson));
    await third.close();
    for (const e of [viaKiwi, viaJson, viaSnapshot]) e.destroy();
  });

  it("copies into Figma's fig-kiwi clipboard archive and pastes it back with no conversion", async () => {
    const engine = await Engine.create(null, { sessionID: 1048577 });
    expect(engineWireFormat(engine)).toBe("kiwi");
    engine.load({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: [{ guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" }, { guid: "0:1", phase: "CREATED", type: "CANVAS", name: "Page 1", parentIndex: { guid: "0:0", position: "!" } }, rect(1048577, 1), rect(1048577, 2)] });
    engine.setSelection(["1048577:1", "1048577:2"]);
    const bytes = engine.encodeSelectionKiwi()!;
    expect(bytes?.length).toBeGreaterThan(0);
    const formats = encodeClipboardKiwi(bytes, { fileKey: "F1" });
    expect(formats["text/plain"]).toBe("Rectangle 1\nRectangle 2");
    expect(formats["text/html"]).toContain("(figma)");
    expect(formats["text/html"]).toContain("(figmeta)");
    // The archive: fig-kiwi, our schema and the Message as stored deflate (any inflater reads it).
    const payload = readClipboard((t) => (t === "text/html" ? formats["text/html"] : undefined));
    expect(payload?.kind).toBe("archive");
    const archive = (payload as { archive: Uint8Array }).archive;
    const chunks = readCanvasChunks(archive);
    expect(chunks.prelude).toBe("fig-kiwi");
    expect(Buffer.from(inflateRawStored(chunks.chunks[1])).equals(Buffer.from(bytes))).toBe(true);
    expect(readClipboard((t) => (t === CLIPBOARD_TYPE ? formats[CLIPBOARD_TYPE] : undefined))?.kind).toBe("archive");
    const back = await archiveMessage(archive);
    expect(Buffer.from(back!).equals(Buffer.from(bytes))).toBe(true);
    const before = engine.encodeDocument().nodeChanges.length;
    expect(engine.pasteKiwi(back!)).toBe(2);
    expect(engine.encodeDocument().nodeChanges.length).toBe(before + 2);
    engine.destroy();
  });

  it("the kiwi wire: changes carry the journal's bytes, the panels read them with string GUIDs, the store's cache follows", async () => {
    const engine = await Engine.create(null, { sessionID: 1048577, wire: "kiwi" } as never);
    expect(engine.wire).toBe("kiwi");
    expect(engineDerivedDataVersion(engine)).toBeGreaterThan(0);
    engine.load({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: [{ guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" }, { guid: "0:1", phase: "CREATED", type: "CANVAS", name: "Page 1", parentIndex: { guid: "0:0", position: "!" } }, rect(1048577, 1)] });
    const store = new EngineStore(engine);
    expect(store.readNode("1048577:1")?.name).toBe("Rectangle 1");
    const seen: { bytes?: Uint8Array; guids: string[]; parents: (string | undefined)[] }[] = [];
    engine.on("DOCUMENT_CHANGED", (e) => seen.push({ bytes: changeBytesOf(e), guids: changesOf(e).map((c) => c.guid), parents: changesOf(e).map((c) => c.parentIndex?.guid) }));
    engine.txnBegin("Rename");
    engine.setProps(["1048577:1"], { name: "Hero" });
    engine.txnCommit();
    expect(seen).toHaveLength(1);
    expect(seen[0].guids).toEqual(["1048577:1"]);
    const journaled = decodeMessage(seen[0].bytes!);
    expect(journaled.nodeChanges![0]).toMatchObject({ guid: { sessionID: 1048577, localID: 1 }, name: "Hero" });
    expect(store.readNode("1048577:1")?.name).toBe("Hero"); // the cache was dropped for the string GUID
    store.dispose();
    engine.destroy();
  });
});
