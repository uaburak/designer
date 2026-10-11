// The three-way merge of branching (docs/data.md §15.4) against §15.8's corpus: each case builds the base B, then main
// and the branch by applying change Messages, merges in both directions and checks the batch, the chunks and the
// conflicts.
import { describe, expect, it } from "vitest";
import { newDocumentMessage, type Message, type NodeChange } from "../schema/codec";
import { guidKey, sessionIdFor, type GUID } from "../schema/guid";
import { NodeTable, nodeFieldId } from "../schema/patch";
import { diff, displayNodeOf, merge3, MergeInvalidError, mergeTables, type MergeInput, type MergeResult, type Resolutions } from "./index";
import { ABSENT } from "./types";

const S = sessionIdFor(1, 2);
const g = (localID: number, sessionID = S): GUID => ({ sessionID, localID });
const k = (localID: number, sessionID = S) => guidKey(g(localID, sessionID));
const DOC = { sessionID: 0, localID: 0 };
const PAGE = { sessionID: 0, localID: 1 };
const INTERNAL = { sessionID: 0, localID: 2 };
const at = (parent: GUID, position: string) => ({ guid: parent, position });
const msg = (nodeChanges: NodeChange[], blobs: { bytes: Uint8Array }[] = []): Message => ({ type: "NODE_CHANGES", sessionID: S, ackID: 0, nodeChanges, blobs });
const node = (localID: number, type: NodeChange["type"], parent: { guid: GUID; position: string }, extra: Partial<NodeChange> = {}): NodeChange => ({
  guid: g(localID),
  phase: "CREATED",
  type,
  name: `N${localID}`,
  parentIndex: parent,
  size: { x: 10, y: 10 },
  ...extra,
});
const upd = (localID: number, fields: Partial<NodeChange>): NodeChange => ({ guid: g(localID), ...fields });
const del = (...ids: number[]): NodeChange[] => ids.map((id) => ({ guid: g(id), phase: "REMOVED" }));
const solid = (r: number) => [{ type: "SOLID" as const, color: { r, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }];

/** Page 1 with frames 10 (children 11, 12) and 20 (child 21); the internal canvas. */
function baseDoc(extra: NodeChange[] = []): NodeTable {
  return NodeTable.fromMessage(
    msg([
      ...newDocumentMessage().nodeChanges!,
      node(10, "FRAME", at(PAGE, "!"), { fillPaints: solid(1) }),
      node(11, "ROUNDED_RECTANGLE", at(g(10), "!")),
      node(12, "ROUNDED_RECTANGLE", at(g(10), '"')),
      node(20, "FRAME", at(PAGE, '"')),
      node(21, "TEXT", at(g(20), "!"), { textData: { characters: "Hello" } }),
      ...extra,
    ]),
  );
}

function edit(t: NodeTable, ...changes: (NodeChange | NodeChange[])[]): NodeTable {
  const c = t.clone();
  c.apply(msg(changes.flat()));
  return c;
}

function run(base: NodeTable, main: NodeTable, branch: NodeTable, direction: MergeInput["direction"], resolutions?: Resolutions): MergeResult {
  return merge3({ base, main, branch, direction, resolutions });
}

/** The target after the batch: main on merge, the branch on update. */
function applied(r: MergeResult, main: NodeTable, branch: NodeTable): NodeTable {
  const t = (r.direction === "merge" ? main : branch).clone();
  t.apply(r.batch);
  return t;
}

const same = (a: NodeTable, b: NodeTable) => diff(a, b).deltas.size === 0;
const ids = (r: MergeResult) => r.conflicts.map((c) => c.id).sort();

describe("merge3 — §15.8 corpus", () => {
  it("1. nothing changed: empty batch, no chunks", () => {
    const b = baseDoc();
    for (const dir of ["merge", "update"] as const) {
      const r = run(b, b.clone(), b.clone(), dir);
      expect(r.batch.nodeChanges).toEqual([]);
      expect(r.chunks).toEqual([]);
      expect(r.conflicts).toEqual([]);
    }
  });

  it("2. only one side changed: the batch is that side's diff; with T == B, M == O", () => {
    const b = baseDoc();
    const branch = edit(b, upd(11, { name: "Renamed" }), node(13, "ELLIPSE", at(g(10), "#")), del(21));
    const merge = run(b, b.clone(), branch, "merge");
    expect(merge.conflicts).toEqual([]);
    expect(same(applied(merge, b, branch), branch)).toBe(true);
    expect(merge.stats).toMatchObject({ created: 1, removed: 1, updated: 1 });
    // Merging into an unchanged branch (update) writes nothing: the branch already is main + its changes.
    const update = run(b, b.clone(), branch, "update");
    expect(update.batch.nodeChanges).toEqual([]);
    // M == O exactly, as a table.
    const { merged } = mergeTables({ base: b, main: b.clone(), branch, direction: "merge" });
    expect(same(merged.toTable(), branch)).toBe(true);
  });

  it("3. different nodes on each side: clean", () => {
    const b = baseDoc();
    const main = edit(b, upd(21, { name: "Main's" }));
    const branch = edit(b, upd(11, { name: "Branch's" }));
    const m = run(b, main, branch, "merge");
    expect(m.conflicts).toEqual([]);
    expect(m.batch.nodeChanges).toEqual([{ guid: g(11), name: "Branch's" }]);
    const u = run(b, main, branch, "update");
    expect(u.batch.nodeChanges).toEqual([{ guid: g(21), name: "Main's" }]);
    expect(applied(m, main, branch).get(k(21))!.name).toBe("Main's");
  });

  it("4. different fields of one node: both kept", () => {
    const b = baseDoc();
    const main = edit(b, upd(11, { opacity: 0.5 }));
    const branch = edit(b, upd(11, { name: "B" }));
    const out = applied(run(b, main, branch, "merge"), main, branch).get(k(11))!;
    expect(out).toMatchObject({ opacity: 0.5, name: "B" });
    const out2 = applied(run(b, main, branch, "update"), main, branch).get(k(11))!;
    expect(out2).toMatchObject({ opacity: 0.5, name: "B" });
  });

  it("5. same field, same value: clean, no write", () => {
    const b = baseDoc();
    const main = edit(b, upd(11, { name: "X" }));
    const branch = edit(b, upd(11, { name: "X" }));
    const r = run(b, main, branch, "merge");
    expect(r.conflicts).toEqual([]);
    expect(r.batch.nodeChanges).toEqual([]);
  });

  it("6. same field, different values: one field conflict; pick by id, chunk and *", () => {
    const b = baseDoc();
    const main = edit(b, upd(11, { name: "Main" }));
    const branch = edit(b, upd(11, { name: "Branch" }));
    const r = run(b, main, branch, "merge");
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0];
    expect(c).toMatchObject({ id: `${k(11)}|name`, kind: "field", field: "name", base: "N11", main: "Main", branch: "Branch" });
    expect(r.unresolved).toEqual([c.id]);
    // The conflict sits in frame 10's chunk.
    expect(r.chunks[c.chunk].displayNode).toBe(k(10));
    expect(r.chunks[c.chunk].conflicts).toEqual([c.id]);
    expect(r.chunks[c.chunk].changedOn.sort()).toEqual(["branch", "main"]);
    for (const [res, want] of [
      [{ [c.id]: "branch" }, "Branch"],
      [{ [c.id]: "main" }, "Main"],
      [{ [`chunk:${c.chunk}`]: "branch" }, "Branch"],
      [{ "*": "main" }, "Main"],
    ] as [Resolutions, string][]) {
      for (const dir of ["merge", "update"] as const) {
        const rr = run(b, main, branch, dir, res);
        expect(rr.unresolved).toEqual([]);
        expect(applied(rr, main, branch).get(k(11))!.name).toBe(want);
      }
    }
    // The id is stable across previews and directions.
    expect(run(b, main, branch, "update").conflicts[0].id).toBe(c.id);
  });

  it("7. textData on both sides: a field conflict, no character merge", () => {
    const b = baseDoc();
    const main = edit(b, upd(21, { textData: { characters: "Hello main" } }));
    const branch = edit(b, upd(21, { textData: { characters: "Hello branch" } }));
    const r = run(b, main, branch, "merge");
    expect(ids(r)).toEqual([`${k(21)}|textData`]);
    expect(r.chunks[r.conflicts[0].chunk].displayNode).toBe(k(20));
  });

  it("8. main edits a child, the branch deletes its top-level frame: delete-edit on the frame's chunk", () => {
    const b = baseDoc();
    const main = edit(b, upd(11, { name: "Edited" }));
    const branch = edit(b, del(11, 12, 10));
    const r = run(b, main, branch, "merge");
    expect(ids(r)).toEqual([`${k(11)}|node`]);
    const c = r.conflicts[0];
    expect(c).toMatchObject({ kind: "delete-edit", removedOn: "branch" });
    expect(r.chunks[c.chunk].displayNode).toBe(k(10));
    // Keep the deletion: frame and child gone.
    const gone = applied(run(b, main, branch, "merge", { [c.id]: "branch" }), main, branch);
    expect(gone.get(k(10))).toBeUndefined();
    expect(gone.get(k(11))).toBeUndefined();
    expect(gone.get(k(12))).toBeUndefined();
    // Keep the edit: the child comes back with its removed ancestor; its untouched sibling stays deleted.
    const kept = applied(run(b, main, branch, "merge", { [c.id]: "main" }), main, branch);
    expect(kept.get(k(11))!.name).toBe("Edited");
    expect(kept.get(k(10))).toBeDefined();
    expect(kept.get(k(12))).toBeUndefined();
    // The same on update: the branch gets the frame back from main.
    const up = applied(run(b, main, branch, "update", { [c.id]: "main" }), main, branch);
    expect(up.get(k(11))!.name).toBe("Edited");
    expect(up.get(k(10))).toBeDefined();
  });

  it("9. created on one side under a node removed on the other: delete-edit", () => {
    const b = baseDoc();
    const main = edit(b, node(30, "ELLIPSE", at(g(20), '"')));
    const branch = edit(b, del(21, 20));
    const r = run(b, main, branch, "merge");
    expect(ids(r)).toEqual([`${k(20)}|node`]);
    // Keep the deletion: what main created inside goes too.
    const gone = applied(run(b, main, branch, "merge", { "*": "branch" }), main, branch);
    expect(gone.get(k(20))).toBeUndefined();
    expect(gone.get(k(30))).toBeUndefined();
    // Keep the edit (update, into the branch): the frame is back, with the new child.
    const kept = applied(run(b, main, branch, "update", { "*": "main" }), main, branch);
    expect(kept.get(k(20))).toBeDefined();
    expect(kept.get(k(30))).toBeDefined();
    expect(kept.get(k(21))).toBeUndefined();
  });

  it("10. removed on both sides: clean", () => {
    const b = baseDoc();
    const r = run(b, edit(b, del(21, 20)), edit(b, del(21, 20)), "merge");
    expect(r.conflicts).toEqual([]);
    expect(r.batch.nodeChanges).toEqual([]);
  });

  it("11. moves: different parents conflict, positions don't, a swap is a cycle", () => {
    const b = baseDoc();
    const mainMove = edit(b, upd(11, { parentIndex: at(g(20), '"') }));
    const branchMove = edit(b, upd(11, { parentIndex: at(PAGE, "#") }));
    expect(ids(run(b, mainMove, branchMove, "merge"))).toEqual([`${k(11)}|parentIndex`]);
    expect(run(b, mainMove, branchMove, "merge").conflicts[0].kind).toBe("move");
    // Same parent, different positions: the incoming side's position, no conflict.
    const mainPos = edit(b, upd(11, { parentIndex: at(g(10), "#") }));
    const branchPos = edit(b, upd(11, { parentIndex: at(g(10), " ~") }));
    const m = run(b, mainPos, branchPos, "merge");
    expect(m.conflicts).toEqual([]);
    expect(applied(m, mainPos, branchPos).get(k(11))!.parentIndex!.position).toBe(" ~");
    const u = run(b, mainPos, branchPos, "update");
    expect(applied(u, mainPos, branchPos).get(k(11))!.parentIndex!.position).toBe("#");
    // Main puts frame 10 into 20, the branch 20 into 10.
    const a = edit(b, upd(10, { parentIndex: at(g(20), "#") }));
    const c = edit(b, upd(20, { parentIndex: at(g(10), "#") }));
    const cyc = run(b, a, c, "merge");
    expect(cyc.conflicts.map((x) => x.kind)).toEqual(["cycle", "cycle"]);
    expect(cyc.unresolved).toHaveLength(2);
    const pickMain = applied(run(b, a, c, "merge", { "*": "main" }), a, c);
    expect(guidKey(pickMain.get(k(10))!.parentIndex!.guid)).toBe(k(20));
    expect(guidKey(pickMain.get(k(20))!.parentIndex!.guid)).toBe("0:1");
    const pickBranch = applied(run(b, a, c, "merge", { "*": "branch" }), a, c);
    expect(guidKey(pickBranch.get(k(20))!.parentIndex!.guid)).toBe(k(10));
    expect(guidKey(pickBranch.get(k(10))!.parentIndex!.guid)).toBe("0:1");
  });

  it("12. siblings inserted at one position: the incoming one is re-keyed, deterministically", () => {
    const b = baseDoc();
    const main = edit(b, node(30, "ELLIPSE", at(g(10), "#")));
    const branch = edit(b, node(31, "ELLIPSE", at(g(10), "#")));
    const r = run(b, main, branch, "merge");
    expect(r.stats.reKeyed).toBe(1);
    const out = applied(r, main, branch);
    const p30 = out.get(k(30))!.parentIndex!.position;
    const p31 = out.get(k(31))!.parentIndex!.position;
    expect(p30).toBe("#");
    expect(p31 > p30).toBe(true);
    expect(run(b, main, branch, "merge").batch).toEqual(r.batch);
  });

  it("13. instance overrides: different paths merge into one symbolData; the same path and field conflict", () => {
    const sym = node(40, "SYMBOL", at(PAGE, "#"));
    const inst = node(41, "INSTANCE", at(PAGE, "$"), { symbolData: { symbolID: g(40), symbolOverrides: [] } });
    const b = baseDoc([sym, inst]);
    const ov = (path: number, fields: Partial<NodeChange>) => ({ guidPath: { guids: [g(path)] }, ...fields });
    const main = edit(b, upd(41, { symbolData: { symbolID: g(40), symbolOverrides: [ov(50, { name: "main 50" })] } }));
    const branch = edit(b, upd(41, { symbolData: { symbolID: g(40), symbolOverrides: [ov(51, { opacity: 0.5 })] } }));
    const r = run(b, main, branch, "merge");
    expect(r.conflicts).toEqual([]);
    const sd = applied(r, main, branch).get(k(41))!.symbolData!;
    expect(sd.symbolOverrides).toHaveLength(2);
    expect(sd.symbolOverrides!.find((o) => guidKey(o.guidPath!.guids![0]) === k(50))!.name).toBe("main 50");
    expect(sd.symbolOverrides!.find((o) => guidKey(o.guidPath!.guids![0]) === k(51))!.opacity).toBe(0.5);
    // The same path, other fields: still clean.
    const b2 = edit(b, upd(41, { symbolData: { symbolID: g(40), symbolOverrides: [ov(50, { name: "x" })] } }));
    const m2 = edit(b2, upd(41, { symbolData: { symbolID: g(40), symbolOverrides: [ov(50, { name: "x", opacity: 0.2 })] } }));
    const br2 = edit(b2, upd(41, { symbolData: { symbolID: g(40), symbolOverrides: [ov(50, { name: "y" })] } }));
    const r2 = run(b2, m2, br2, "merge");
    expect(r2.conflicts).toEqual([]);
    expect(applied(r2, m2, br2).get(k(41))!.symbolData!.symbolOverrides![0]).toMatchObject({ name: "y", opacity: 0.2 });
    // The same path and field: a keyed conflict.
    const br3 = edit(b2, upd(41, { symbolData: { symbolID: g(40), symbolOverrides: [ov(50, { name: "x", opacity: 0.9 })] } }));
    const r3 = run(b2, m2, br3, "merge");
    expect(r3.conflicts).toHaveLength(1);
    expect(r3.conflicts[0]).toMatchObject({ kind: "keyed", field: "symbolData", itemKey: `${k(50)}#opacity`, main: 0.2, branch: 0.9 });
  });

  it("14. componentPropAssignments, componentPropDefs, parameterConsumptionMap, prototypeInteractions per key", () => {
    const defA = { id: g(60), name: "A", type: "BOOL" as const, initialValue: { boolValue: true } };
    const defB = { id: g(61), name: "B", type: "BOOL" as const, initialValue: { boolValue: true } };
    const sym = node(40, "SYMBOL", at(PAGE, "#"), { componentPropDefs: [defA, defB] });
    const inst = node(41, "INSTANCE", at(PAGE, "$"), { symbolData: { symbolID: g(40) }, componentPropAssignments: [{ defID: g(60), value: { boolValue: true } }, { defID: g(61), value: { boolValue: true } }] });
    const b = baseDoc([sym, inst]);
    const main = edit(b, upd(40, { componentPropDefs: [{ ...defA, name: "A main" }, defB] }), upd(41, { componentPropAssignments: [{ defID: g(60), value: { boolValue: false } }, { defID: g(61), value: { boolValue: true } }] }));
    const branch = edit(b, upd(40, { componentPropDefs: [defA, { ...defB, name: "B branch" }] }), upd(41, { componentPropAssignments: [{ defID: g(60), value: { boolValue: true } }, { defID: g(61), value: { boolValue: false } }] }));
    const r = run(b, main, branch, "merge");
    expect(r.conflicts).toEqual([]);
    const out = applied(r, main, branch);
    expect(out.get(k(40))!.componentPropDefs!.map((d) => d.name)).toEqual(["A main", "B branch"]);
    expect(out.get(k(41))!.componentPropAssignments!.map((a) => a.value!.boolValue)).toEqual([false, false]);
    // Interactions and bindings, by id and by field.
    const ix = (id: number, dest: number) => ({ id: g(id), event: { interactionType: "ON_CLICK" as const }, actions: [{ transitionNodeID: g(dest), navigationType: "NAVIGATE" as const }] });
    const b2 = edit(b, upd(11, { prototypeInteractions: [ix(70, 20), ix(71, 20)] }));
    const m2 = edit(b2, upd(11, { prototypeInteractions: [ix(70, 10), ix(71, 20)] }));
    const br2 = edit(b2, upd(11, { prototypeInteractions: [ix(70, 20), ix(71, 10)] }));
    const r2 = run(b2, m2, br2, "merge");
    expect(r2.conflicts).toEqual([]);
    expect(applied(r2, m2, br2).get(k(11))!.prototypeInteractions!.map((i) => guidKey(i.actions![0].transitionNodeID!))).toEqual([k(10), k(10)]);
    const alias = (id: number) => ({ value: { alias: { guid: g(id) } }, dataType: "ALIAS" as const, resolvedDataType: "FLOAT" as const });
    const m3 = edit(b2, upd(11, { parameterConsumptionMap: { entries: [{ variableField: "OPACITY", variableData: alias(80) }] } }));
    const br3 = edit(b2, upd(11, { parameterConsumptionMap: { entries: [{ variableField: "WIDTH", variableData: alias(81) }] } }));
    const r3 = run(b2, m3, br3, "merge");
    expect(r3.conflicts).toEqual([]);
    expect(applied(r3, m3, br3).get(k(11))!.parameterConsumptionMap!.entries!.map((e) => e.variableField).sort()).toEqual(["OPACITY", "WIDTH"]);
    const br4 = edit(b2, upd(11, { parameterConsumptionMap: { entries: [{ variableField: "OPACITY", variableData: alias(81) }] } }));
    expect(run(b2, m3, br4, "merge").conflicts.map((c) => c.id)).toEqual([`${k(11)}|parameterConsumptionMap|OPACITY`]);
  });

  describe("15. variables", () => {
    const mode = (id: number, pos: string) => ({ id: g(id), name: `M${id}`, sortPosition: pos });
    const value = (r: number) => ({ value: { colorValue: { r, g: 0, b: 0, a: 1 } }, dataType: "COLOR" as const, resolvedDataType: "COLOR" as const });
    const coll = node(90, "VARIABLE_SET", at(INTERNAL, "!"), { variableSetModes: [mode(91, "!"), mode(92, '"')] });
    const v = node(95, "VARIABLE", at(INTERNAL, '"'), { variableSetID: { guid: g(90) }, variableResolvedType: "COLOR", variableDataValues: { entries: [{ modeID: g(91), variableData: value(0) }, { modeID: g(92), variableData: value(0) }] } });
    const b = baseDoc([coll, v]);
    const vals = (a: number, c: number) => upd(95, { variableDataValues: { entries: [{ modeID: g(91), variableData: value(a) }, { modeID: g(92), variableData: value(c) }] } });

    it("values in different modes merge; the same mode conflicts (keyed); grouped under the collection", () => {
      const main = edit(b, vals(1, 0));
      const branch = edit(b, vals(0, 1));
      const r = run(b, main, branch, "merge");
      expect(r.conflicts).toEqual([]);
      const e = applied(r, main, branch).get(k(95))!.variableDataValues!.entries!;
      expect(e.map((x) => x.variableData!.value!.colorValue!.r)).toEqual([1, 1]);
      expect(r.chunks.map((c) => c.displayNode)).toEqual([k(90)]);
      expect(r.chunks[0].canvasIsInternal).toBe(true);
      const r2 = run(b, main, edit(b, vals(0.5, 0)), "merge");
      expect(r2.conflicts.map((c) => c.id)).toEqual([`${k(95)}|variableDataValues|${k(91)}`]);
    });

    it("a mode added on one side, a variable on the other: valid", () => {
      const main = edit(b, upd(90, { variableSetModes: [mode(91, "!"), mode(92, '"'), mode(93, "#")] }));
      const branch = edit(b, node(96, "VARIABLE", at(INTERNAL, "#"), { variableSetID: { guid: g(90) }, variableResolvedType: "COLOR", variableDataValues: { entries: [{ modeID: g(91), variableData: value(1) }] } }));
      for (const dir of ["merge", "update"] as const) {
        const r = run(b, main, branch, dir);
        expect(r.conflicts).toEqual([]);
        const out = applied(r, main, branch);
        expect(out.get(k(90))!.variableSetModes).toHaveLength(3);
        expect(out.get(k(96))).toBeDefined();
      }
    });

    it("a collection removed vs a variable edited: delete-edit; keeping the edit brings the collection back", () => {
      const main = edit(b, del(95, 90));
      const branch = edit(b, vals(1, 1));
      const r = run(b, main, branch, "merge");
      expect(r.conflicts.map((c) => c.kind)).toEqual(["delete-edit"]);
      expect(r.conflicts[0].removedOn).toBe("main");
      const kept = applied(run(b, main, branch, "merge", { "*": "branch" }), main, branch);
      expect(kept.get(k(95))).toBeDefined();
      expect(kept.get(k(90))).toBeDefined();
    });

    it("an extended collection's override vs the parent's value: different nodes, clean", () => {
      const ext = node(97, "VARIABLE_SET", at(INTERNAL, "$"), { variableSetModes: [{ id: g(98), name: "Ext", sortPosition: "!", parentVariableSetId: { guid: g(90) }, parentModeId: g(91) }] });
      const ovr = node(99, "VARIABLE_OVERRIDE", at(g(97), "!"), { overriddenVariableId: { guid: g(95) }, variableSetID: { guid: g(97) }, variableDataValues: { entries: [{ modeID: g(98), variableData: value(0.2) }] } });
      const b2 = edit(b, ext, ovr);
      const main = edit(b2, vals(0.7, 0));
      const branch = edit(b2, upd(99, { variableDataValues: { entries: [{ modeID: g(98), variableData: value(0.9) }] } }));
      const r = run(b2, main, branch, "merge");
      expect(r.conflicts).toEqual([]);
      expect(r.chunks.map((c) => c.displayNode)).toEqual([k(97)]);
      const out = applied(r, main, branch);
      expect(out.get(k(95))!.variableDataValues!.entries![0].variableData!.value!.colorValue!.r).toBeCloseTo(0.7);
      expect(out.get(k(99))!.variableDataValues!.entries![0].variableData!.value!.colorValue!.r).toBeCloseTo(0.9);
    });
  });

  it("16. styles: edited on both sides conflicts; removed on main while the branch applies it is delete-edit", () => {
    const style = node(100, "ROUNDED_RECTANGLE", at(INTERNAL, "!"), { styleType: "FILL", fillPaints: solid(0.1) });
    const b = baseDoc([style]);
    const r = run(b, edit(b, upd(100, { fillPaints: solid(0.3) })), edit(b, upd(100, { fillPaints: solid(0.4) })), "merge");
    expect(r.conflicts.map((c) => c.id)).toEqual([`${k(100)}|fillPaints`]);
    expect(r.chunks[r.conflicts[0].chunk].displayNode).toBe(k(100));
    const main = edit(b, del(100));
    const branch = edit(b, upd(11, { styleIdForFill: { guid: g(100) }, fillPaints: solid(0.1) }));
    const r2 = run(b, main, branch, "merge");
    expect(r2.conflicts.map((c) => [c.id, c.kind, c.removedOn])).toEqual([[`${k(100)}|node`, "delete-edit", "main"]]);
    const kept = applied(run(b, main, branch, "merge", { "*": "branch" }), main, branch);
    expect(kept.get(k(100))).toBeDefined();
  });

  it("17. components: a main edited on both sides; a variant added while the set is renamed: clean", () => {
    const set = node(110, "FRAME", at(INTERNAL, "!"), { isStateGroup: true, name: "Button" });
    const v1 = node(111, "SYMBOL", at(g(110), "!"), { name: "State=Default" });
    const b = baseDoc([set, v1]);
    const main = edit(b, upd(110, { name: "Button 2" }));
    const branch = edit(b, node(112, "SYMBOL", at(g(110), '"'), { name: "State=Hover" }));
    const r = run(b, main, branch, "merge");
    expect(r.conflicts).toEqual([]);
    expect(r.chunks.map((c) => c.displayNode)).toEqual([k(110)]);
    const out = applied(r, main, branch);
    expect(out.get(k(110))!.name).toBe("Button 2");
    expect(out.get(k(112))).toBeDefined();
    const r2 = run(b, edit(b, upd(111, { opacity: 0.5 })), edit(b, upd(111, { opacity: 0.6 })), "merge");
    expect(r2.conflicts.map((c) => c.id)).toEqual([`${k(111)}|opacity`]);
  });

  it("18. library copies: the newer copy wins whole, no conflict; enabled libraries merge per key", () => {
    const LIB = "LibraryFileKey00000000";
    const copy = (version: string, childName: string, extraChild = false): NodeChange[] => [
      node(120, "SYMBOL", at(INTERNAL, "!"), { sourceLibraryKey: LIB, key: "a".repeat(40), version, publishID: g(1, 9) }),
      node(121, "TEXT", at(g(120), "!"), { name: childName, overrideKey: g(5, 9) }),
      ...(extraChild ? [node(122, "ELLIPSE", at(g(120), '"'))] : []),
    ];
    const b = baseDoc(copy("v3", "three"));
    const main = edit(b, copy("v5", "five", true));
    const branch = edit(b, copy("v4", "four"));
    const versions: Record<string, number> = { v3: 3, v4: 4, v5: 5 };
    const lv = (_lib: string, _key: string, h: string) => versions[h] ?? null;
    const m = merge3({ base: b, main, branch, direction: "merge" }, { libraryVersion: lv });
    expect(m.conflicts).toEqual([]);
    expect(m.batch.nodeChanges).toEqual([]); // main already has 5
    const u = merge3({ base: b, main, branch, direction: "update" }, { libraryVersion: lv });
    expect(u.conflicts).toEqual([]);
    const out = applied(u, main, branch);
    expect(out.get(k(120))!.version).toBe("v5");
    expect(out.get(k(121))!.name).toBe("five");
    expect(out.get(k(122))).toBeDefined();
    // Without version numbers: two different updates conflict on the copy's version, picked whole.
    const nv = merge3({ base: b, main, branch, direction: "update" });
    expect(nv.conflicts.map((c) => c.id)).toEqual([`${k(120)}|version`]);
    // Enabled libraries per libraryKey.
    const subs = (...keys: string[]) => upd(0, { librarySubscriptions: keys.map((libraryKey) => ({ libraryKey, name: libraryKey })) });
    const docUpd = (...keys: string[]) => ({ ...subs(...keys), guid: DOC });
    const r = run(b, edit(b, docUpd("L1")), edit(b, docUpd("L2")), "merge");
    expect(r.conflicts).toEqual([]);
    expect(r.chunks.map((c) => c.displayType)).toEqual(["DOCUMENT"]);
    expect(applied(r, edit(b, docUpd("L1")), edit(b, docUpd("L2"))).get("0:0")!.librarySubscriptions!.map((s) => s.libraryKey).sort()).toEqual(["L1", "L2"]);
  });

  it("19. local asset bookkeeping is main's", () => {
    const comp = node(130, "SYMBOL", at(PAGE, "#"), { key: "c".repeat(40) });
    const b = baseDoc([comp]);
    const main = edit(b, upd(130, { publishedVersion: "1".repeat(40) }));
    const branch = edit(b, upd(130, { publishedVersion: "2".repeat(40), name: "Renamed" }));
    for (const dir of ["merge", "update"] as const) {
      const r = run(b, main, branch, dir);
      expect(r.conflicts).toEqual([]);
      const out = applied(r, main, branch).get(k(130))!;
      expect(out.publishedVersion).toBe("1".repeat(40));
      expect(out.name).toBe("Renamed");
    }
  });

  it("20. pages: added on both sides, reordered, renamed vs deleted", () => {
    const b = baseDoc();
    const pageAt = (id: number, pos: string) => ({ guid: g(id), phase: "CREATED" as const, type: "CANVAS" as const, name: `P${id}`, parentIndex: at(DOC, pos) });
    const main = edit(b, pageAt(140, "O"));
    const branch = edit(b, pageAt(141, "O"));
    const r = run(b, main, branch, "merge");
    expect(r.conflicts).toEqual([]);
    expect(r.stats.reKeyed).toBe(1);
    const out = applied(r, main, branch);
    expect(out.get(k(141))!.parentIndex!.position > "O").toBe(true);
    expect(out.get(k(141))!.parentIndex!.position < "~").toBe(true);
    expect(r.chunks.map((c) => c.displayNode)).toEqual([k(141)]);
    expect(r.chunks[0].phase).toBe("CREATED");
    // Renamed on main, deleted (with its layers) on the branch.
    const renamed = edit(b, { guid: PAGE, name: "Cover" });
    const deleted = edit(b, del(11, 12, 10, 21, 20), [{ guid: PAGE, phase: "REMOVED" }]);
    const r2 = run(b, renamed, deleted, "merge");
    expect(r2.conflicts.map((c) => c.id)).toEqual(["0:1|node"]);
    expect(r2.chunks[r2.conflicts[0].chunk].displayNode).toBe("0:1");
    expect(r2.chunks[r2.conflicts[0].chunk].phase).toBe("REMOVED");
  });

  it("21. images and blobs: a branch-only image travels; blob fields compare by bytes across tables", () => {
    const X = new Uint8Array([1, 2, 3]);
    const Y = new Uint8Array([9, 9, 9, 9]);
    const vec = (blob: number) => ({ vectorNetworkBlob: blob, normalizedSize: { x: 1, y: 1 } });
    const bMsg = msg([...newDocumentMessage().nodeChanges!, node(150, "VECTOR", at(PAGE, "!"), { vectorData: vec(0) })], [{ bytes: X }]);
    const b = NodeTable.fromMessage(bMsg);
    // The same document whose blob table numbers X differently: no change.
    const other = NodeTable.fromMessage(msg([...newDocumentMessage().nodeChanges!, node(150, "VECTOR", at(PAGE, "!"), { vectorData: vec(1) })], [{ bytes: Y }, { bytes: X }]));
    expect(diff(b, other).deltas.size).toBe(0);
    const hash = new Uint8Array(20).fill(7);
    const branch = other.clone();
    branch.apply(msg([upd(150, { vectorData: vec(0), fillPaints: [{ type: "IMAGE", image: { hash }, opacity: 1, visible: true }] })], [{ bytes: Y }]));
    const r = run(b, b.clone(), branch, "merge");
    expect(r.batch.blobs).toHaveLength(1);
    expect([...r.batch.blobs![0].bytes!]).toEqual([...Y]);
    const out = applied(r, b, branch);
    expect([...out.blob(out.get(k(150))!.vectorData!.vectorNetworkBlob!)!]).toEqual([...Y]);
    expect(out.imageHashes().has("07".repeat(20))).toBe(true);
  });

  it("22. a type change on one side vs an edit on the other: a field conflict on the node, resolved whole", () => {
    const b = baseDoc();
    const main = edit(b, del(11), node(11, "ELLIPSE", at(g(10), "!"), { name: "Now an ellipse" }));
    const branch = edit(b, upd(11, { opacity: 0.4 }));
    const r = run(b, main, branch, "merge");
    expect(r.conflicts.map((c) => [c.id, c.kind])).toEqual([[`${k(11)}|node`, "field"]]);
    const pickBranch = applied(run(b, main, branch, "merge", { "*": "branch" }), main, branch).get(k(11))!;
    expect(pickBranch).toMatchObject({ type: "ROUNDED_RECTANGLE", opacity: 0.4 });
    const pickMain = applied(run(b, main, branch, "merge", { "*": "main" }), main, branch).get(k(11))!;
    expect(pickMain).toMatchObject({ type: "ELLIPSE", name: "Now an ellipse" });
    // A conversion (FRAME → SYMBOL) is an ordinary field change and merges with other fields.
    const conv = edit(b, upd(10, { type: "SYMBOL" }));
    const other = edit(b, upd(10, { name: "Card" }));
    const rc = run(b, conv, other, "merge");
    expect(rc.conflicts).toEqual([]);
    expect(applied(rc, conv, other).get(k(10))).toMatchObject({ type: "SYMBOL", name: "Card" });
  });

  it("23. a field cleared on one side and set to its default on the other: convergent", () => {
    const b = edit(baseDoc(), upd(11, { opacity: 0.5 }));
    const main = edit(b, { guid: g(11), clearedFields: [nodeFieldId("opacity")!] });
    const branch = edit(b, upd(11, { opacity: 1 }));
    for (const dir of ["merge", "update"] as const) {
      const r = run(b, main, branch, dir);
      expect(r.conflicts).toEqual([]);
      expect(r.batch.nodeChanges).toEqual([]);
    }
  });

  it("24. @derived fields are never in the batch", () => {
    const b = baseDoc();
    const branch = b.clone();
    branch.apply({ ...msg([upd(21, { name: "x", derivedTextData: { layoutSize: { x: 1, y: 1 } } as never })]) });
    const created = edit(branch, node(160, "TEXT", at(PAGE, "#"), { derivedTextData: { layoutSize: { x: 1, y: 1 } } as never }));
    const r = run(b, b.clone(), created, "merge");
    for (const nc of r.batch.nodeChanges ?? []) expect("derivedTextData" in nc).toBe(false);
  });

  it("25. update then merge: a conflict resolved during the update doesn't come back", () => {
    const b = baseDoc();
    const main = edit(b, upd(11, { name: "Main" }));
    const branch = edit(b, upd(11, { name: "Branch" }));
    const up = run(b, main, branch, "update", { "*": "branch" });
    const branch2 = applied(up, main, branch);
    // The base is now main's head.
    const merge = run(main, main, branch2, "merge");
    expect(merge.conflicts).toEqual([]);
    expect(applied(merge, main, branch2).get(k(11))!.name).toBe("Branch");
  });

  it("the chunk of a moved node is its destination's; the source lists it", () => {
    const b = baseDoc();
    const branch = edit(b, upd(11, { parentIndex: at(g(20), '"') }));
    const r = run(b, b.clone(), branch, "merge");
    const dst = r.chunks.find((c) => c.displayNode === k(20))!;
    const src = r.chunks.find((c) => c.displayNode === k(10))!;
    expect(dst.nodeChanges).toHaveLength(1);
    expect(src.chunksAffectingThisChunk).toEqual([dst.index]);
    expect(dst.parentHierarchyGuids).toEqual(["0:0", "0:1"]);
    expect(dst.canvasName).toBe("Page 1");
  });

  it("displayNodeOf: top-level layer, page, collection, style, copy root, document", () => {
    const b = baseDoc([node(90, "VARIABLE_SET", at(INTERNAL, "!")), node(95, "VARIABLE", at(INTERNAL, '"'), { variableSetID: { guid: g(90) } })]);
    expect(displayNodeOf(b, k(11))).toBe(k(10));
    expect(displayNodeOf(b, k(10))).toBe(k(10));
    expect(displayNodeOf(b, "0:1")).toBe("0:1");
    expect(displayNodeOf(b, "0:0")).toBe("0:0");
    expect(displayNodeOf(b, k(95))).toBe(k(90));
  });

  it("an invalid merged table is refused (rule 11)", () => {
    const b = baseDoc();
    // Two sides each make the other's parent a page child of a node that doesn't exist: the branch moves 11 under a
    // node no side has.
    const branch = edit(b, upd(11, { parentIndex: at(g(999), "!") }));
    expect(() => run(b, b.clone(), branch, "merge")).toThrow(MergeInvalidError);
  });

  it("conflict values distinguish absence", () => {
    const b = baseDoc();
    const main = edit(b, upd(12, { opacity: 0.3 }));
    const branch = edit(b, upd(12, { opacity: 0.6 }));
    expect(run(b, main, branch, "merge").conflicts[0].base).toBe(ABSENT);
  });
});

describe("merge3 — a large table", () => {
  it("20 000 layers, 500 edits across 50 frames on the branch, 100 on main: bounded time", () => {
    const nodes: NodeChange[] = [...newDocumentMessage().nodeChanges!];
    let id = 1000;
    const frames: number[] = [];
    for (let f = 0; f < 200; f++) {
      const fid = id++;
      frames.push(fid);
      nodes.push(node(fid, "FRAME", at(PAGE, String.fromCharCode(33 + (f % 90)) + String.fromCharCode(33 + Math.floor(f / 90))), { fillPaints: solid(f / 200) }));
      for (let c = 0; c < 99; c++) nodes.push(node(id++, "ROUNDED_RECTANGLE", at(g(fid), String.fromCharCode(33 + (c % 90)) + String.fromCharCode(33 + Math.floor(c / 90))), { fillPaints: solid(c / 100), opacity: 1 }));
    }
    const b = NodeTable.fromMessage(msg(nodes));
    expect(b.size).toBeGreaterThan(20_000);
    const branchEdits: NodeChange[] = [];
    for (let i = 0; i < 500; i++) branchEdits.push(upd(frames[i % 50] + 1 + Math.floor(i / 50), { opacity: 0.5, name: `b${i}` }));
    const mainEdits: NodeChange[] = [];
    for (let i = 0; i < 100; i++) mainEdits.push(upd(frames[100 + (i % 50)] + 1 + Math.floor(i / 50), { name: `m${i}` }));
    const branch = edit(b, branchEdits);
    const main = edit(b, mainEdits);
    const t0 = performance.now();
    const r = run(b, main, branch, "merge");
    const ms = performance.now() - t0;
    expect(r.conflicts).toEqual([]);
    expect(r.batch.nodeChanges).toHaveLength(500);
    expect(r.chunks).toHaveLength(50);
    expect(ms).toBeLessThan(8000);
  });
});
