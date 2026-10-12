// GUIDs on either wire (engine/guids.ts): the kiwi wire's DOCUMENT_CHANGED decodes {sessionID, localID} objects while
// NodeChange.guid is typed string; changesOf / Engine.onDocumentChanged give every reader "s:l".
import { describe, expect, it } from "vitest";
import { changesOf, guidString } from "../guids";
import { changesOf as compatChangesOf } from "../../editor/engineCompat";

describe("engine GUIDs", () => {
  it("guidString prints either form as s:l", () => {
    expect(guidString("0:7")).toBe("0:7");
    expect(guidString({ sessionID: 3, localID: 12 })).toBe("3:12");
    expect(guidString("")).toBeNull();
    expect(guidString(null)).toBeNull();
    expect(guidString(42)).toBeNull();
  });

  it("changesOf: a kiwi-shaped message's guid and parentIndex.guid become s:l, once per event", () => {
    const event = {
      message: {
        nodeChanges: [
          { guid: { sessionID: 1, localID: 5 }, phase: "CREATED", type: "TEXT", parentIndex: { guid: { sessionID: 0, localID: 1 }, position: "!" } },
          { guid: { sessionID: 1, localID: 6 }, name: "B" },
        ],
      },
    };
    const view = changesOf(event);
    expect(view.map((c) => c.guid)).toEqual(["1:5", "1:6"]);
    expect(view[0].parentIndex).toEqual({ guid: "0:1", position: "!" });
    expect(view[0].phase).toBe("CREATED");
    expect("name" in view[1]).toBe(true);
    // keyed by the string, as the editor's maps are
    const ids = new Set(view.map((c) => c.guid));
    expect(ids.has("1:5")).toBe(true);
    expect(changesOf(event)).toBe(view);
    // the editor's old import path is the same function
    expect(compatChangesOf).toBe(changesOf);
  });

  it("changesOf: the JSON wire's list comes back as it is", () => {
    const list = [{ guid: "1:5" }, { guid: "1:6", phase: "REMOVED" }];
    expect(changesOf({ message: { nodeChanges: list } })).toBe(list);
    expect(changesOf({ message: { nodeChanges: [] } })).toEqual([]);
  });
});
