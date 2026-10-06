import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { NodeChange } from "../../shared/schema/document.generated";
import { DERIVED_FIELDS } from "../../shared/schema/patch";
import { decodeNodeFields, encodeNodeFields, INLINE_BYTES_LIMIT, plainBytes, type DecodeContext, type EncodeContext } from "./fieldCodec";

function contexts(blobs: Uint8Array[] = []) {
  const storage = new Map<string, Uint8Array>();
  const enc: EncodeContext = {
    bytes: plainBytes,
    blob: (i) => blobs[i],
    spill: (b) => {
      const sha1 = createHash("sha1").update(b).digest("hex");
      storage.set(sha1, b.slice());
      return sha1;
    },
  };
  const dec: DecodeContext = {
    bytes: plainBytes,
    fetch: (sha1) => {
      const b = storage.get(sha1);
      if (!b) throw new Error(`no ${sha1}`);
      return b;
    },
  };
  return { enc, dec, storage };
}

const F = Math.fround;

describe("node documents (docs/data.md §12.4)", () => {
  it("maps kiwi values to Firestore values and back: GUIDs as strings, enums by name, structs as maps, arrays, bytes", () => {
    const hash = new Uint8Array(20).map((_, i) => i * 7);
    const node: NodeChange = {
      guid: { sessionID: 1048577, localID: 9 },
      phase: "CREATED",
      type: "ROUNDED_RECTANGLE",
      name: "Card",
      visible: true,
      opacity: F(0.5),
      parentIndex: { guid: { sessionID: 0, localID: 1 }, position: "!" },
      size: { x: 100, y: F(40.5) },
      fillPaints: [
        { type: "SOLID", color: { r: 1, g: F(0.2), b: 0, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" },
        { type: "IMAGE", image: { hash, name: "photo.png" }, imageScaleMode: "FILL" },
      ],
    };
    const { enc, dec } = contexts();
    const doc = encodeNodeFields(node, enc);
    expect(Object.keys(doc).sort()).toEqual(["fillPaints", "name", "opacity", "parentIndex", "size", "type", "visible"]); // no guid/phase
    expect(doc.parentIndex).toEqual({ guid: "0:1", position: "!" });
    expect(doc.type).toBe("ROUNDED_RECTANGLE");
    expect((doc.fillPaints as { image?: { hash: unknown } }[])[1].image!.hash).toEqual({ $b: hash });
    // A Firestore round trip is a structured clone.
    const back = decodeNodeFields("1048577:9", structuredClone(doc), dec);
    const { phase: _p, ...expected } = node;
    expect(back.node).toEqual(expected);
    expect(back.blobs).toEqual([]);
  });

  it("carries blob-index fields as bytes, spilling past 256 KB to Storage, and re-indexes them on the way back", () => {
    const small = new Uint8Array([1, 2, 3, 4]);
    const big = new Uint8Array(INLINE_BYTES_LIMIT + 1).fill(9);
    const node: NodeChange = { guid: { sessionID: 5, localID: 1 }, vectorData: { vectorNetworkBlob: 1, normalizedSize: { x: 10, y: 10 } }, fillPaints: [{ type: "IMAGE", image: { dataBlob: 0 } }] };
    const { enc, dec, storage } = contexts([big, small]);
    const doc = encodeNodeFields(node, enc);
    expect((doc.vectorData as { vectorNetworkBlob: unknown }).vectorNetworkBlob).toEqual({ $b: small });
    expect((doc.fillPaints as { image: { dataBlob: unknown } }[])[0].image.dataBlob).toEqual({ $blob: createHash("sha1").update(big).digest("hex") });
    expect(storage.size).toBe(1);
    const back = decodeNodeFields("5:1", structuredClone(doc), dec);
    const n = back.node;
    expect(back.blobs[n.vectorData!.vectorNetworkBlob!]).toEqual(small);
    expect(back.blobs[n.fillPaints![0].image!.dataBlob!]).toEqual(big);
  });

  it("spills values nested deeper than 20 levels and documents over 900 KB as kiwi Messages in Storage", () => {
    let deep: NodeChange = { name: "leaf" };
    for (let i = 0; i < 12; i++) deep = { vectorData: { styleOverrideTable: [deep] } };
    const huge = "x".repeat(950 * 1024);
    const node: NodeChange = { guid: { sessionID: 5, localID: 2 }, vectorData: deep.vectorData, name: huge, visible: false };
    const { enc, dec, storage } = contexts();
    const doc = encodeNodeFields(node, enc);
    expect(Object.keys(doc.vectorData as object)).toEqual(["$kiwi"]);
    expect(Object.keys(doc.name as object)).toEqual(["$kiwi"]);
    expect(doc.visible).toBe(false);
    expect(storage.size).toBe(2);
    const back = decodeNodeFields("5:2", structuredClone(doc), dec);
    expect(back.node.name).toBe(huge);
    expect(back.node.vectorData).toEqual(deep.vectorData);
  });

  it("refuses derived caches and unknown fields, and ignores sync metadata when decoding", () => {
    const { enc, dec } = contexts();
    const derived = [...DERIVED_FIELDS][0];
    if (derived) expect(() => encodeNodeFields({ guid: { sessionID: 1, localID: 1 }, [derived]: [] } as NodeChange, enc)).toThrow(/derived/);
    expect(() => encodeNodeFields({ guid: { sessionID: 1, localID: 1 }, notAField: 1 } as unknown as NodeChange, enc)).toThrow(/no field/);
    const back = decodeNodeFields("1:1", { name: "A", _clk: { name: "x" }, _t: 5, _del: null, _dev: 1, unknown: 3 }, dec);
    expect(back.node).toEqual({ guid: { sessionID: 1, localID: 1 }, name: "A" });
  });

  it("encodes only the fields asked for", () => {
    const { enc } = contexts();
    expect(encodeNodeFields({ guid: { sessionID: 1, localID: 1 }, name: "A", visible: true, opacity: 1 }, enc, ["visible"])).toEqual({ visible: true });
  });
});
