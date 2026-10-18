import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, type NodeChange } from "../schema/codec";
import { NodeTable } from "../schema/patch";
import { splitFrame } from "./split";

/* eslint-disable @typescript-eslint/no-explicit-any */

const node = (localID: number, fields: Record<string, unknown>): NodeChange => ({ guid: { sessionID: 3, localID }, ...fields }) as NodeChange;
const msg = (nodeChanges: NodeChange[], blobs: Uint8Array[] = []) => encodeMessage({ type: "NODE_CHANGES", sessionID: 3, ackID: 0, nodeChanges, blobs: blobs.map((bytes) => ({ bytes })) });
const filled = (n: number, v: number) => new Uint8Array(n).fill(v);

/** The document a sequence of Messages makes (each applied in turn, as the receivers do) */
const replay = (frames: Uint8Array[]) => {
  const t = new NodeTable();
  for (const f of frames) t.apply(decodeMessage(f));
  return t;
};

describe("splitFrame (docs/multiplayer.md §18.1)", () => {
  it("keeps a frame that fits as it is", () => {
    const m = msg([node(1, { name: "A" })]);
    expect(splitFrame(m, 1000)).toEqual([m]);
  });

  it("splits by node changes in their order, each part with only the blobs it uses, renumbered", () => {
    const vec = (localID: number, blob: number) => node(localID, { phase: "CREATED", type: "VECTOR", vectorData: { vectorNetworkBlob: blob } });
    const whole = msg([vec(1, 0), vec(2, 1), vec(3, 0), node(4, { phase: "CREATED", name: "Last" })], [filled(600, 1), filled(600, 2)]);
    const parts = splitFrame(whole, 800)!;
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(800);
    expect(parts.flatMap((p) => decodeMessage(p).nodeChanges!.map((n) => n.guid!.localID))).toEqual([1, 2, 3, 4]);
    for (const p of parts) {
      const d = decodeMessage(p);
      for (const n of d.nodeChanges!) if (n.vectorData) expect(d.blobs![n.vectorData.vectorNetworkBlob!].bytes.length).toBe(600);
    }
    // Applied one after another, the parts make the same document as the frame.
    const a = replay([whole]);
    const b = replay(parts);
    expect(b.size).toBe(a.size);
    for (const [k, n] of a.nodes) {
      const m = b.nodes.get(k)! as any;
      if ((n as any).vectorData) expect(b.blob(m.vectorData.vectorNetworkBlob)).toEqual(a.blob((n as any).vectorData.vectorNetworkBlob));
      else expect(m).toEqual(n);
    }
  });

  it("splits one node change too large on its own field by field (a creation's first part keeps its type and place)", () => {
    const created = node(1, { phase: "CREATED", type: "TEXT", parentIndex: { guid: { sessionID: 0, localID: 1 }, position: "!" }, name: "x".repeat(500), description: "y".repeat(500) });
    const parts = splitFrame(msg([created]), 700)!;
    expect(parts.length).toBe(2);
    expect(decodeMessage(parts[0]).nodeChanges![0]).toMatchObject({ phase: "CREATED", type: "TEXT", parentIndex: { position: "!" } });
    expect(decodeMessage(parts[1]).nodeChanges![0].phase).toBeUndefined();
    expect(replay(parts).get("3:1")).toEqual(replay([msg([created])]).get("3:1"));
  });

  it("is the same every time (a restarted client sends the rest), and gives up on a field no frame can carry", () => {
    const whole = msg([node(1, { name: "a".repeat(400) }), node(2, { name: "b".repeat(400) }), node(3, { name: "c".repeat(400) })]);
    expect(splitFrame(whole, 500)).toEqual(splitFrame(whole, 500));
    expect(splitFrame(msg([node(1, { name: "z".repeat(2000) })]), 500)).toBeNull();
  });
});
