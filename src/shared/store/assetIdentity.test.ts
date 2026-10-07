// A file's library bookkeeping through Duplicate and Restore version (docs/schema.md §8.1, docs/data.md §6, §9.1):
// the pure rules both stores run.
import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, newDocumentMessage, type Message, type NodeChange } from "../schema/codec";
import { sessionIdFor } from "../schema/guid";
import { NodeTable, nodeFieldId } from "../schema/patch";
import { isAbsentValue, libraryCopyNodes, restoreDiff, withNewAssetIdentity } from "./assetIdentity";

const S = sessionIdFor(1, 2);
const g = (localID: number, sessionID = S) => ({ sessionID, localID });
const PAGE = { sessionID: 0, localID: 1 };
const INTERNAL = { sessionID: 0, localID: 2 };
const KEY = (c: string) => c.repeat(40);
const msg = (nodeChanges: NodeChange[]): Message => ({ type: "NODE_CHANGES", sessionID: S, ackID: 0, nodeChanges, blobs: [] });
const node = (localID: number, type: NodeChange["type"], parent: NodeChange["parentIndex"] extends infer P ? P : never, extra: Partial<NodeChange> = {}): NodeChange => ({
  guid: g(localID),
  phase: "CREATED",
  type,
  name: `N${localID}`,
  parentIndex: parent,
  size: { x: 10, y: 10 },
  ...extra,
});
const id = (name: string) => nodeFieldId(name)!;

/** A library file: a local main (published, with a move pending), a local set with a variant, a copy of another library's set. */
function libraryDoc(): Message {
  const doc = newDocumentMessage();
  return msg([
    ...doc.nodeChanges!,
    node(1, "SYMBOL", { guid: PAGE, position: "!" }, { key: KEY("a"), publishedVersion: KEY("1"), libraryMoveInfo: { oldKey: KEY("9"), pasteFileKey: "OtherFileKey0000000000" } }),
    node(2, "FRAME", { guid: PAGE, position: "#" }, { isStateGroup: true, key: KEY("b"), publishedVersion: KEY("2") }),
    node(3, "SYMBOL", { guid: g(2), position: "!" }, { key: KEY("c") }),
    // A main that prefers the local main by key (as a .fig writes it) and the copy's set by key.
    node(4, "SYMBOL", { guid: PAGE, position: "$" }, {
      key: KEY("d"),
      componentPropDefs: [{ id: g(40), name: "Icon", type: "INSTANCE_SWAP", preferredValues: { instanceSwapValues: [{ type: "COMPONENT", key: KEY("a") }, { type: "STATE_GROUP", key: KEY("e") }] } }],
    }),
    // A library copy (another library's set, with a variant): copies keep their identity.
    node(10, "FRAME", { guid: INTERNAL, position: "!" }, { isStateGroup: true, sourceLibraryKey: "LibraryFileKey00000000", key: KEY("e"), version: KEY("5"), publishID: g(7, 1) }),
    node(11, "SYMBOL", { guid: g(10), position: "!" }, { key: KEY("f"), publishID: g(8, 1) }),
  ]);
}

describe("library copies in a document", () => {
  it("are a node with sourceLibraryKey and everything under it", () => {
    const t = NodeTable.fromMessage(libraryDoc());
    expect([...libraryCopyNodes(t.nodes)].sort()).toEqual([`${S}:10`, `${S}:11`]);
  });
});

describe("Duplicate file / Duplicate version (docs/schema.md §8.1 \"Duplicated assets get a new key\")", () => {
  it("clears local assets' key, published version and move; library copies keep theirs", () => {
    const dup = withNewAssetIdentity(libraryDoc());
    const t = NodeTable.fromMessage(decodeMessage(encodeMessage(dup)));
    for (const l of [1, 2, 3, 4]) {
      const n = t.get(g(l))!;
      expect([n.key, n.publishedVersion, n.libraryMoveInfo]).toEqual([undefined, undefined, undefined]);
    }
    expect(t.get(g(10))).toMatchObject({ sourceLibraryKey: "LibraryFileKey00000000", key: KEY("e"), version: KEY("5") });
    expect(t.get(g(11))!.key).toBe(KEY("f"));
    // A preferred value naming a local main by its old key names it by GUID; the copy's key stays.
    expect(t.get(g(4))!.componentPropDefs![0].preferredValues!.instanceSwapValues!.map((v) => v.key)).toEqual([`${S}:1`, KEY("e")]);
    // Nothing else changes.
    expect(t.get(g(1))!.name).toBe("N1");
  });

  it("returns the same Message when there is nothing to clear", () => {
    const plain = msg([...newDocumentMessage().nodeChanges!, node(1, "SYMBOL", { guid: PAGE, position: "!" })]);
    expect(withNewAssetIdentity(plain)).toBe(plain);
  });
});

describe("Restore version's diff (docs/data.md §6)", () => {
  it("leaves local assets' bookkeeping as it is; writes library copies exactly", () => {
    const head = NodeTable.fromMessage(libraryDoc());
    const version = head.clone();
    // The version was saved before the first publish (no keys yet), and before the copy was updated.
    version.apply(msg([
      { guid: g(1), name: "Old name", clearedFields: [id("key"), id("publishedVersion"), id("libraryMoveInfo")] },
      { guid: g(3), clearedFields: [id("key")] },
      { guid: g(10), version: KEY("4") },
    ]));
    const diff = restoreDiff(head, version).nodeChanges!;
    expect(diff).toEqual([
      { guid: g(1), name: "Old name" },
      { guid: g(10), version: KEY("4") },
    ]);
    // A copy's identity is the version's, whatever it is.
    const v2 = head.clone();
    v2.apply(msg([{ guid: g(11), clearedFields: [id("key")] }]));
    expect(restoreDiff(head, v2).nodeChanges).toEqual([{ guid: g(11), clearedFields: [id("key")] }]);
  });

  it("keeps the document's enabled libraries (the store's list isn't versioned either)", () => {
    const head = NodeTable.fromMessage(libraryDoc());
    const version = head.clone();
    head.apply(msg([{ guid: { sessionID: 0, localID: 0 }, librarySubscriptions: [{ libraryKey: "LibraryFileKey00000000", name: "Kit" }] }]));
    expect(restoreDiff(head, version).nodeChanges).toEqual([]);
  });

  it("brings a removed asset back as it was (the editor reconciles its published version); a re-created one keeps the head's", () => {
    const head = NodeTable.fromMessage(libraryDoc());
    const version = head.clone();
    head.apply(msg([{ guid: g(1), phase: "REMOVED" }]));
    const back = restoreDiff(head, version).nodeChanges!.find((n) => n.guid!.localID === 1)!;
    expect(back).toMatchObject({ phase: "CREATED", key: KEY("a"), publishedVersion: KEY("1") });
    // A type change is written REMOVED + CREATED: the asset keeps its bookkeeping.
    const now = NodeTable.fromMessage(libraryDoc());
    const then = now.clone();
    then.apply(msg([{ ...node(4, "FRAME", { guid: PAGE, position: "$" }) }]));
    const four = restoreDiff(now, then).nodeChanges!.filter((n) => n.guid!.localID === 4);
    expect(four.map((n) => n.phase)).toEqual(["REMOVED", "CREATED"]);
    expect(four[1].key).toBe(KEY("d"));
  });

  it("an explicit default and an absent field are the same; a reset to a non-zero default is written as its value", () => {
    const doc = newDocumentMessage();
    const head = NodeTable.fromMessage(msg([...doc.nodeChanges!, node(1, "ROUNDED_RECTANGLE", { guid: PAGE, position: "!" }, { opacity: 1, effects: [], visible: true, cornerRadius: 0 })]));
    const version = NodeTable.fromMessage(msg([...doc.nodeChanges!, node(1, "ROUNDED_RECTANGLE", { guid: PAGE, position: "!" })]));
    expect(restoreDiff(head, version).nodeChanges).toEqual([]);
    expect(restoreDiff(version, head).nodeChanges).toEqual([]);
    // Hidden when publishing, then restored to a version without the flag: written true (absence means true).
    head.apply(msg([{ guid: g(1), opacity: 0.5, isSymbolPublishable: false, cornerRadius: 4 }]));
    expect(restoreDiff(head, version).nodeChanges).toEqual([{ guid: g(1), opacity: 1, isSymbolPublishable: true, clearedFields: [id("cornerRadius")] }]);
  });

  it("knows what absence means (docs/schema.md §3.4)", () => {
    expect(isAbsentValue("opacity", 1)).toBe(true);
    expect(isAbsentValue("opacity", 0)).toBe(false);
    expect(isAbsentValue("visible", true)).toBe(true);
    expect(isAbsentValue("isSymbolPublishable", false)).toBe(false);
    expect(isAbsentValue("effects", [])).toBe(true);
    expect(isAbsentValue("variableScopes", [])).toBe(false); // empty = shown in no picker
    expect(isAbsentValue("name", "")).toBe(true);
    expect(isAbsentValue("transform", { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 })).toBe(true);
    expect(isAbsentValue("symbolData", {})).toBe(false);
  });
});
