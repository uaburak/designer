import { describe, expect, it } from "vitest";
import type { Message, NodeChange } from "../../shared/schema/document.generated";
import { nodeFieldId } from "../../shared/schema/patch";
import { formatHlc } from "../local/ids";
import { coalesce, mergeRecord, planPull, planPush, type NodeOps } from "./lww";

const h = (ms: number, device = 1) => formatHlc(ms, 0, device);
const G = (l: number) => ({ sessionID: 7, localID: l });
const msg = (...nodeChanges: NodeChange[]): Message => ({ type: "NODE_CHANGES", sessionID: 7, ackID: 0, nodeChanges, blobs: [] });
const VISIBLE = nodeFieldId("visible")!;

describe("coalesce (push step 1)", () => {
  it("keeps the last value and HLC per (guid, field); clears are writes; REMOVED is a tombstone; CREATED replaces", () => {
    const ops = coalesce([
      { hlc: h(1), message: msg({ guid: G(1), phase: "CREATED", type: "FRAME", name: "A", visible: true }, { guid: G(2), phase: "CREATED", name: "B" }) },
      { hlc: h(2), message: msg({ guid: G(1), name: "A2", clearedFields: [VISIBLE] }) },
      { hlc: h(3), message: msg({ guid: G(2), phase: "REMOVED" }, { guid: G(3), phase: "REMOVED" }) },
      { hlc: h(4), message: msg({ guid: G(3), phase: "CREATED", name: "C again" }) },
    ]);
    const a = ops.get("7:1")!;
    expect(a.replacedAt).toBe(h(1));
    expect(a.removed).toBeNull();
    expect(Object.fromEntries(a.fields)).toEqual({ type: { value: "FRAME", hlc: h(1) }, name: { value: "A2", hlc: h(2) }, visible: { value: undefined, hlc: h(2) } });
    const b = ops.get("7:2")!;
    expect(b).toMatchObject({ removed: h(3), replacedAt: null });
    expect(b.fields.size).toBe(0);
    const c = ops.get("7:3")!;
    expect(c).toMatchObject({ removed: null, replacedAt: h(4) });
    expect([...c.fields.keys()]).toEqual(["name"]);
  });
});

function ops(fields: Record<string, [unknown, string]>, extra: Partial<NodeOps> = {}): NodeOps {
  return { guid: "7:1", removed: null, replacedAt: null, fields: new Map(Object.entries(fields).map(([k, [value, hlc]]) => [k, { value, hlc }])), blobsOf: new Map(), ...extra };
}

describe("planPush (push step 3)", () => {
  it("writes everything to a node nobody has written yet", () => {
    const plan = planPush(ops({ name: ["A", h(5)], visible: [undefined, h(5)] }), null);
    expect(plan).toEqual({ set: ["name"], clear: ["visible"], clk: { name: h(5), visible: h(5) }, del: null, empty: false });
  });

  it("skips fields the remote wrote later, and fields deleted remotely after the write", () => {
    const remote = { fields: { name: "Remote", opacity: 1 }, clk: { name: h(9), opacity: h(1) }, del: null };
    expect(planPush(ops({ name: ["Local", h(5)], opacity: [0.5, h(5)] }), remote)).toMatchObject({ set: ["opacity"], clk: { opacity: h(5) } });
    const deleted = { fields: {}, clk: {}, del: h(9) };
    expect(planPush(ops({ name: ["Local", h(5)] }), deleted).empty).toBe(true);
    // An equal stamp is the same write: nothing to do.
    expect(planPush(ops({ name: ["Same", h(9)] }), remote).empty).toBe(true);
  });

  it("lets a local tombstone win over older remote fields", () => {
    const remote = { fields: { name: "A", opacity: 1 }, clk: { name: h(2), opacity: h(8) }, del: null };
    const plan = planPush(ops({}, { removed: h(5) }), remote);
    expect(plan).toMatchObject({ del: h(5), clear: ["name"], clk: { name: h(5) }, empty: false });
    expect(planPush(ops({}, { removed: h(5) }), { fields: {}, clk: {}, del: h(6) }).empty).toBe(true);
  });

  it("makes a CREATED a full replace: older remote fields it doesn't carry go away", () => {
    const remote = { fields: { name: "Old", opacity: 0.3, visible: false }, clk: { name: h(2), opacity: h(2), visible: h(9) }, del: null };
    const plan = planPush(ops({ name: ["New", h(5)] }, { replacedAt: h(5) }), remote);
    expect(plan.set).toEqual(["name"]);
    expect(plan.clear).toEqual(["opacity"]); // visible was written after the replace
    expect(plan.clk).toEqual({ name: h(5), opacity: h(5) });
  });
});

describe("planPull", () => {
  it("takes remote fields newer than the local clocks; a remote clear becomes clearedFields", () => {
    const remote = { fields: { name: "Remote", opacity: 0.5 }, clk: { name: h(9, 2), opacity: h(1, 2), visible: h(9, 2) }, del: null };
    const r = planPull("7:1", remote, { clk: { name: h(5), opacity: h(5) }, del: null });
    expect(r.removed).toBe(false);
    expect(r.taken).toEqual({ name: h(9, 2), visible: h(9, 2) });
    expect(r.change).toEqual({ guid: G(1), name: "Remote", clearedFields: [VISIBLE] });
    expect(planPull("7:1", remote, { clk: { name: h(10), opacity: h(10), visible: h(10) }, del: null }).change).toBeNull();
  });

  it("removes the node when the remote tombstone is the newest write", () => {
    expect(planPull("7:1", { fields: {}, clk: { name: h(2, 2) }, del: h(8, 2) }, { clk: { name: h(3) }, del: null })).toMatchObject({ removed: true, change: null });
    // A local write after the remote delete keeps the node.
    expect(planPull("7:1", { fields: {}, clk: {}, del: h(8, 2) }, { clk: { name: h(9) }, del: null }).removed).toBe(false);
    // A local tombstone hides older remote writes.
    expect(planPull("7:1", { fields: { name: "x" }, clk: { name: h(4, 2) }, del: null }, { clk: {}, del: h(6) }).change).toBeNull();
  });
});

describe("mergeRecord (records' field-level LWW)", () => {
  it("pushes everything when the remote has no record, and otherwise merges field by field", () => {
    const local = { name: "Local", color: "red", _clk: { name: h(5), color: h(1) } };
    expect(mergeRecord(local, null)).toEqual({ merged: local, pushFields: ["name", "color"], pullFields: [] });
    const remote = { name: "Remote", color: "blue", parentId: "p", _clk: { name: h(3), color: h(4), parentId: h(4) } };
    const r = mergeRecord(local, remote);
    expect(r.merged).toEqual({ name: "Local", color: "blue", parentId: "p", _clk: { name: h(5), color: h(4), parentId: h(4) } });
    expect(r.pushFields).toEqual(["name"]);
    expect(r.pullFields.sort()).toEqual(["color", "parentId"]);
  });
});
