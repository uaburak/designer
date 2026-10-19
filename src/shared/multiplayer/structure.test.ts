import { describe, expect, it } from "vitest";
import { cycleFrom, repairStructure, structureTouched, type Structure } from "./structure";
import type { NodeChange } from "../schema/codec";

const g = (k: string) => ({ sessionID: Number(k.split(":")[0]), localID: Number(k.split(":")[1]) });
const at = (parent: string, position = "a") => ({ guid: g(parent), position });
const tree = (entries: Record<string, string | null>): Structure => new Map(Object.entries(entries).map(([k, p]) => [k, p ? at(p) : null]));
const moves = (changes: NodeChange[]) => changes.map((c) => [`${c.guid!.sessionID}:${c.guid!.localID}`, c.parentIndex ? `${c.parentIndex.guid.sessionID}:${c.parentIndex.guid.localID}` : null]);

describe("the tree under concurrent moves (docs/multiplayer.md §18.12)", () => {
  it("finds the cycle a node is on", () => {
    expect(cycleFrom(tree({ "0:0": null, "1:1": "1:2", "1:2": "1:1" }), "1:1")).toEqual(["1:1", "1:2"]);
    expect(cycleFrom(tree({ "0:0": null, "1:1": "0:0", "1:2": "1:1" }), "1:2")).toBeNull();
  });

  it("our move that closes a cycle goes back where the room has it; the other node on it is written again for the engine", () => {
    const room = tree({ "0:0": null, "0:1": "0:0", "1:10": "0:1", "1:11": "1:10" });
    const local = new Map(room);
    local.set("1:10", at("1:11"));
    const fix = repairStructure({ local, room, ancestry: room, placed: new Set(["1:10"]), removed: new Set() });
    expect(moves(fix.corrections)).toEqual([["1:10", "0:1"]]);
    expect(moves(fix.reasserts)).toEqual([["1:11", "1:10"]]);
  });

  it("leaves a cycle it didn't close to the copy that did", () => {
    const local = tree({ "0:0": null, "1:10": "1:11", "1:11": "1:10" });
    expect(repairStructure({ local, room: local, ancestry: local, placed: new Set(["1:12"]), removed: new Set() })).toEqual({ corrections: [], reasserts: [] });
  });

  it("puts a layer we moved or drew into a deleted frame at the nearest existing place above it", () => {
    const before = tree({ "0:0": null, "0:1": "0:0", "1:5": "0:1", "1:6": "1:5", "1:7": "0:1" });
    const local = tree({ "0:0": null, "0:1": "0:0", "1:7": "1:6" });
    const fix = repairStructure({ local, room: local, ancestry: before, placed: new Set(["1:7"]), removed: new Set() });
    expect(moves(fix.corrections)).toEqual([["1:7", "0:1"]]);
  });

  it("rescues someone else's layer put into a frame we deleted; not one in a frame someone else deleted", () => {
    const before = tree({ "0:0": null, "0:1": "0:0", "1:5": "0:1", "2:1": "0:1" });
    const local = tree({ "0:0": null, "0:1": "0:0", "2:1": "1:5" });
    expect(moves(repairStructure({ local, room: local, ancestry: before, placed: new Set(), removed: new Set(["1:5"]) }).corrections)).toEqual([["2:1", "0:1"]]);
    expect(repairStructure({ local, room: local, ancestry: before, placed: new Set(), removed: new Set() }).corrections).toEqual([]);
  });

  it("knows what waiting changes place and remove, the last one winning", () => {
    const t = structureTouched([
      { nodeChanges: [{ guid: g("1:1"), phase: "CREATED", parentIndex: at("0:1") }, { guid: g("1:2"), parentIndex: at("0:1") }] },
      { nodeChanges: [{ guid: g("1:2"), phase: "REMOVED" }, { guid: g("1:3"), name: "x" }] },
    ] as never);
    expect([...t.placed]).toEqual(["1:1"]);
    expect([...t.removed]).toEqual(["1:2"]);
  });
});
