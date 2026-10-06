import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, newDocumentMessage, type Message, type NodeChange } from "./codec";
import { GuidAllocator, parseGuid, sessionIdFor, splitSessionId } from "./guid";
import { diffTables, NodeTable, tablesEqual } from "./patch";

const S = sessionIdFor(1, 3);
const g = (localID: number, sessionID = S) => ({ sessionID, localID });
const PAGE = { sessionID: 0, localID: 1 };
const msg = (nodeChanges: NodeChange[], blobs: Uint8Array[] = []): Message => ({ type: "NODE_CHANGES", sessionID: S, ackID: 0, nodeChanges, blobs: blobs.map((bytes) => ({ bytes })) });
const rect = (localID: number, position: string, parent = PAGE, extra: Partial<NodeChange> = {}): NodeChange => ({
  guid: g(localID),
  phase: "CREATED",
  type: "ROUNDED_RECTANGLE",
  name: `R${localID}`,
  parentIndex: { guid: parent, position },
  size: { x: 10, y: 10 },
  ...extra,
});

function base(): NodeTable {
  return NodeTable.fromMessage(newDocumentMessage());
}

describe("NodeTable.apply (docs/schema.md §4.3)", () => {
  it("creates, updates wholesale, clears and removes", () => {
    const t = base();
    t.apply(msg([rect(1, "!", PAGE, { fillPaints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }], opacity: 0.5 })]));
    const r = t.apply(msg([{ guid: g(1), fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 1, a: 1 } }], clearedFields: [8 /* opacity */] }]));
    expect(r.updated).toBe(1);
    const n = t.get(g(1))!;
    expect(n.fillPaints).toEqual([{ type: "SOLID", color: { r: 0, g: 0, b: 1, a: 1 } }]);
    expect(n.opacity).toBeUndefined();
    expect("clearedFields" in n).toBe(false);
    t.apply(msg([{ guid: g(1), phase: "REMOVED" }]));
    expect(t.get(g(1))).toBeUndefined();
  });

  it("treats CREATED for a live GUID as a full replace", () => {
    const t = base();
    t.apply(msg([rect(1, "!", PAGE, { opacity: 0.25, cornerRadius: 4 })]));
    const r = t.apply(msg([rect(1, "#", PAGE, { name: "Again" })]));
    expect(r.replaced).toBe(1);
    const n = t.get(g(1))!;
    expect(n.name).toBe("Again");
    expect(n.opacity).toBeUndefined();
    expect(n.cornerRadius).toBeUndefined();
  });

  it("reports updates of absent nodes, ignores unknown REMOVED and refuses to clear identity fields", () => {
    const t = base();
    const r = t.apply(msg([{ guid: g(9), opacity: 1 }, { guid: g(10), phase: "REMOVED" }]));
    expect(r.missing).toEqual([`${S}:9`]);
    expect(r.ignoredRemoves).toBe(1);
    t.apply(msg([rect(1, "!")]));
    const r2 = t.apply(msg([{ guid: g(1), clearedFields: [1, 3, 4, 9999] }]));
    expect(r2.invalidClears).toBe(4);
    expect(t.get(g(1))!.type).toBe("ROUNDED_RECTANGLE");
  });

  it("does not infer descendants: a subtree is removed by one REMOVED per node", () => {
    const t = base();
    t.apply(msg([{ ...rect(1, "!"), type: "FRAME" }, rect(2, "!", g(1))]));
    t.apply(msg([{ guid: g(1), phase: "REMOVED" }]));
    expect(t.get(g(2))).toBeDefined(); // orphaned until its own REMOVED arrives
    expect(t.orderedKeys().at(-1)).toBe(`${S}:2`); // orphans still round-trip, after the tree
    t.apply(msg([{ guid: g(2), phase: "REMOVED" }]));
    expect(t.size).toBe(3);
  });
});

describe("snapshot order and blobs", () => {
  it("orders DOCUMENT first, then pre-order by position with GUID tie-break", () => {
    const t = base();
    t.apply(
      msg([
        rect(5, '"'),
        rect(4, "!"),
        { ...rect(3, "!"), guid: g(3) }, // same position as 4: GUID order (3 before 4)
        rect(6, "!", g(4)),
        { guid: g(7), phase: "CREATED", type: "CANVAS", name: "Page 2", parentIndex: { guid: { sessionID: 0, localID: 0 }, position: "P" } },
      ]),
    );
    const names = t.toMessage().nodeChanges!.map((n) => n.name);
    expect(names).toEqual(["Document", "Page 1", "R3", "R4", "R6", "R5", "Page 2", "Internal Only Canvas"]);
  });

  it("rebases blob indices into its own pool, dedupes by content and re-densifies on output", () => {
    const t = base();
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5]);
    t.apply(msg([rect(1, "!", PAGE, { type: "VECTOR", vectorData: { vectorNetworkBlob: 1, normalizedSize: { x: 1, y: 1 } } })], [b, a]));
    t.apply(msg([rect(2, '"', PAGE, { type: "VECTOR", vectorData: { vectorNetworkBlob: 0, normalizedSize: { x: 1, y: 1 } } })], [a]));
    t.apply(msg([rect(3, "#", PAGE, { fillGeometry: [{ windingRule: "NONZERO", commandsBlob: 0 }] })], [b]));
    expect(t.blobs.size).toBe(2); // a and b, each once
    const out = t.toMessage();
    expect(out.blobs!.map((x) => [...x.bytes])).toEqual([[1, 2, 3]]); // fillGeometry is @derived: dropped with its blob
    const v = out.nodeChanges!.filter((n) => n.type === "VECTOR");
    expect(v.map((n) => n.vectorData!.vectorNetworkBlob)).toEqual([0, 0]);
    const kept = t.toMessage({ keepDerived: true });
    expect(kept.blobs!.length).toBe(2);
    expect(decodeMessage(encodeMessage(out))).toEqual(out);
  });

  it("collects image hashes from paints at any depth", () => {
    const t = base();
    const hash = new Uint8Array(20).fill(0xab);
    const hash2 = new Uint8Array(20).fill(0x01);
    t.apply(
      msg([
        rect(1, "!", PAGE, { fillPaints: [{ type: "IMAGE", image: { hash } }] }),
        {
          ...rect(2, '"'),
          type: "TEXT",
          textData: { characters: "Hi", styleOverrideTable: [{ styleID: 1, fillPaints: [{ type: "IMAGE", image: { hash: hash2 } }] }] },
        },
      ]),
    );
    expect([...t.imageHashes()].sort()).toEqual(["01".repeat(20), "ab".repeat(20)]);
  });
});

describe("diffTables (restore)", () => {
  function edited(): { a: NodeTable; b: NodeTable } {
    const a = base();
    a.apply(msg([{ ...rect(1, "!"), type: "FRAME" }, rect(2, "!", g(1), { opacity: 0.5 }), rect(3, '"', g(1)), rect(4, "#")], []));
    const b = a.clone();
    b.apply(
      msg(
        [
          { guid: g(2), clearedFields: [8], name: "Renamed" }, // field change + clear
          { guid: g(3), phase: "REMOVED" },
          rect(5, "$", g(1), { type: "VECTOR", vectorData: { vectorNetworkBlob: 0 } }),
          { guid: g(1), type: "SYMBOL" }, // a conversion: an update
          { guid: g(4), type: "ELLIPSE" }, // not a conversion: REMOVED + CREATED
        ],
        [new Uint8Array([9, 9, 9])],
      ),
    );
    return { a, b };
  }

  it("turns the current table into the version, both ways", () => {
    const { a, b } = edited();
    for (const [from, to] of [
      [a, b],
      [b, a],
    ]) {
      const diff = diffTables(from, to);
      const applied = from.clone();
      applied.apply(decodeMessage(encodeMessage(diff)));
      expect(tablesEqual(applied, to)).toBe(true);
    }
  });

  it("writes REMOVED children first, CREATED parents first, and clears with clearedFields", () => {
    const { a, b } = edited();
    const back = diffTables(b, a).nodeChanges!;
    const removed5 = back.findIndex((n) => n.phase === "REMOVED" && n.guid!.localID === 5);
    expect(removed5).toBeGreaterThanOrEqual(0);
    const created3 = back.find((n) => n.phase === "CREATED" && n.guid!.localID === 3)!;
    expect(created3.name).toBe("R3");
    const upd2 = back.find((n) => n.guid!.localID === 2 && !n.phase)!;
    expect(upd2).toEqual({ guid: g(2), name: "R2", opacity: 0.5 });
    const fwd = diffTables(a, b).nodeChanges!;
    expect(fwd.find((n) => n.guid!.localID === 2 && !n.phase)).toEqual({ guid: g(2), name: "Renamed", clearedFields: [8] });
    const four = fwd.filter((n) => n.guid!.localID === 4).map((n) => n.phase);
    expect(four).toEqual(["REMOVED", "CREATED"]);
    expect(fwd.find((n) => n.guid!.localID === 1)).toEqual({ guid: g(1), type: "SYMBOL" });
    expect(diffTables(a, a.clone()).nodeChanges).toEqual([]);
  });
});

describe("GUIDs", () => {
  it("composes sessionIDs as (deviceOrdinal << 20) | n, unsigned", () => {
    expect(sessionIdFor(1, 1)).toBe(1048577);
    expect(sessionIdFor(4095, 1)).toBe(4095 * 2 ** 20 + 1);
    expect(splitSessionId(sessionIdFor(4095, 77))).toEqual({ deviceOrdinal: 4095, n: 77 });
    expect(() => sessionIdFor(0, 1)).toThrow();
    expect(parseGuid("12-34")).toEqual({ sessionID: 12, localID: 34 });
    const alloc = new GuidAllocator(S, [g(1), g(2), g(4)]);
    expect([alloc.next(), alloc.next()]).toEqual([g(3), g(5)]);
  });
});
