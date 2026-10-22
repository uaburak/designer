// A cleared field travels in the NODE_CHANGES message (docs/schema.md §4.2: `clearedFields` = unset): clearing a field
// with setProps({field: null}) on one engine clears it on a peer applying the changes, in a journal replayed from the
// snapshot, after undo / redo, and in the TS patcher the store compacts with. 2026-10-22: the forward change of a
// cleared unmodelled field (prototypeStartingPoint, hyperlink, pluginData, the overlay fields…) was an empty `{guid}`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { Message, NodeChange, NodeFieldsPatch } from "../codec";
import { Engine, type WireFormat } from "../Engine";
import { loadEngine } from "../loadEngine";
import { SAMPLE_DOCUMENT } from "../sampleDocument";
import { decodeMessage as decodeKiwi } from "@shared/schema/codec";
import { nodeFieldId } from "@shared/schema/patch";

const wasm = fileURLToPath(new URL("../wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

const FRAME = "1:1"; // top-level frame
const RECT = "1:5";
const PAGE = "0:1";
const DOC = "0:0";

/** Each family: the node, the fields set (then each cleared with null). */
const FAMILIES: { name: string; ref: string; fields: Record<string, unknown> }[] = [
  { name: "flow starting point", ref: FRAME, fields: { prototypeStartingPoint: { name: "Flow 1", description: "", position: "!" } } },
  { name: "hyperlink", ref: RECT, fields: { hyperlink: { url: "https://example.com" } } },
  {
    name: "overlay settings",
    ref: FRAME,
    fields: {
      overlayPositionType: "TOP_LEFT",
      overlayBackgroundInteraction: "CLOSE_ON_CLICK_OUTSIDE",
      overlayBackgroundAppearance: { backgroundType: "SOLID_COLOR", backgroundColor: { r: 0, g: 0, b: 0, a: 0.5 } },
      overlayStack: { gap: 8, max: 3 },
    },
  },
  { name: "plugin data", ref: RECT, fields: { pluginData: [{ pluginID: "shared:social", key: "post", value: "{}" }] } },
  { name: "prototype cursor and text input", ref: RECT, fields: { prototypeCursor: "POINTER", prototypeTextInput: { type: "EMAIL", maxLength: 40 } } },
  { name: "thumbnail", ref: DOC, fields: { thumbnailInfo: { nodeID: { sessionID: 1, localID: 1 }, thumbnailVersion: "1" } } },
  { name: "prototype device", ref: PAGE, fields: { prototypeDevice: { type: "PRESET", presetIdentifier: "IPHONE_16", rotation: "NONE" } } },
];

async function pair(wire: WireFormat) {
  const a = await Engine.create(null, { sessionID: 1, wire });
  a.load(SAMPLE_DOCUMENT);
  const snapshot = a.encodeDocumentKiwi();
  const b = await Engine.create(null, { sessionID: 2 });
  b.loadKiwi(snapshot);
  const journal: (Uint8Array | Message)[] = [];
  const messages: NodeChange[][] = [];
  a.onDocumentChanged((changes, e) => {
    messages.push([...changes]);
    const frame = e.bytes ? e.bytes.slice() : ({ type: "NODE_CHANGES", sessionID: 1, nodeChanges: [...changes] } as Message);
    journal.push(frame);
    apply(b, frame);
  });
  return { a, b, snapshot, journal, messages };
}

function apply(e: Engine, frame: Uint8Array | Message) {
  if (frame instanceof Uint8Array) e.applyChangesKiwi(frame, "remote");
  else e.applyChanges(frame, "remote");
}

const has = (e: Engine, ref: string, field: string) => {
  const n = e.readNode(ref, { fields: [field] }) as Record<string, unknown> | null;
  return n !== null && n[field] !== undefined && n[field] !== null;
};

describe.each(["kiwi", "json"] as const)("a cleared field reaches the changes (%s wire)", (wire) => {
  it.each(FAMILIES)("$name: cleared on A → cleared on B, in the journal replay, through undo / redo", async ({ ref, fields }) => {
    const { a, b, snapshot, journal, messages } = await pair(wire);
    const keys = Object.keys(fields);
    expect(a.setProps([ref], fields as NodeFieldsPatch)).toBe(0);
    for (const k of keys) {
      expect(has(a, ref, k), `A has ${k}`).toBe(true);
      expect(has(b, ref, k), `B has ${k}`).toBe(true);
    }
    expect(a.setProps([ref], Object.fromEntries(keys.map((k) => [k, null])) as NodeFieldsPatch)).toBe(0);
    // The forward change says what was cleared (never an empty {guid}).
    const clear = messages.at(-1)!.find((c) => c.guid === ref)!;
    expect(Object.keys(clear).length).toBeGreaterThan(1);
    for (const k of keys) {
      expect(has(a, ref, k), `A cleared ${k}`).toBe(false);
      expect(has(b, ref, k), `B cleared ${k}`).toBe(false);
    }
    // The journal replayed over the snapshot (a reopened file).
    const replay = await Engine.create(null, { sessionID: 3 });
    replay.loadKiwi(snapshot);
    for (const f of journal) apply(replay, f);
    for (const k of keys) expect(has(replay, ref, k), `replay cleared ${k}`).toBe(false);
    // Undo puts the fields back on B; redo clears them again.
    a.undo();
    for (const k of keys) expect(has(b, ref, k), `B undo ${k}`).toBe(true);
    a.redo();
    for (const k of keys) expect(has(b, ref, k), `B redo ${k}`).toBe(false);
    replay.destroy();
    a.destroy();
    b.destroy();
  });
});

describe("a cleared field on the kiwi wire", () => {
  it("is listed in clearedFields by its schema id (what the journal, peers and the store's patcher read)", async () => {
    const { a, b, journal } = await pair("kiwi");
    a.setProps([FRAME], { prototypeStartingPoint: { name: "Flow 1", description: "", position: "!" }, overlayStack: { gap: 4, max: 0 } } as NodeFieldsPatch);
    a.setProps([FRAME], { prototypeStartingPoint: null, overlayStack: null } as NodeFieldsPatch);
    const m = decodeKiwi(journal.at(-1) as Uint8Array);
    const change = m.nodeChanges!.find((c) => c.guid!.sessionID === 1 && c.guid!.localID === 1)!;
    expect([...(change.clearedFields ?? [])].sort((x, y) => x - y)).toEqual(
      [nodeFieldId("prototypeStartingPoint")!, nodeFieldId("overlayStack")!].sort((x, y) => x - y),
    );
    a.destroy();
    b.destroy();
  });

  it("only the touched node's other unmodelled fields stay as they are", async () => {
    const { a, b } = await pair("kiwi");
    a.setProps([FRAME], { prototypeStartingPoint: { name: "Flow 1", description: "", position: "!" }, overlayPositionType: "TOP_LEFT" } as NodeFieldsPatch);
    a.setProps([FRAME], { overlayPositionType: null } as NodeFieldsPatch);
    expect(has(b, FRAME, "prototypeStartingPoint")).toBe(true);
    expect(has(b, FRAME, "overlayPositionType")).toBe(false);
    a.destroy();
    b.destroy();
  });
});
