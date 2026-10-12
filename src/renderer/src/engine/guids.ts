/**
 * GUIDs as the bindings print them ("sessionID:localID") whatever the engine's wire. On the kiwi wire
 * (docs/engine-build.md "Figma parity round 3") a DOCUMENT_CHANGED's `message` is the kiwi-shaped Message, decoded
 * lazily from its `bytes`, so its GUIDs are `{sessionID, localID}` objects while `codec.ts`'s `NodeChange.guid` says
 * string. `changesOf` gives the string view once per event; `Engine.onDocumentChanged` hands it to every handler, so
 * the type is true there and no reader converts on its own.
 */
import type { Guid, NodeChange } from "./codec";

type GuidLike = string | { sessionID: number; localID: number } | null | undefined;

/** "s:l" for a GUID in either form (a string as it is); null for nothing or anything else. */
export function guidString(g: unknown): Guid | null {
  if (typeof g === "string") return g || null;
  if (g && typeof g === "object" && "sessionID" in g && "localID" in g) return `${(g as { sessionID: number }).sessionID}:${(g as { localID: number }).localID}`;
  return null;
}

const viewCache = new WeakMap<object, readonly NodeChange[]>();

/**
 * A DOCUMENT_CHANGED's node changes with GUIDs as "s:l" strings (`guid`, `parentIndex.guid`), whatever the engine's
 * wire. A shallow view — every other field is as the wire gives it, so readers test keys (`"name" in c`), phases and
 * GUIDs, not values. One view per event, shared by every reader; the JSON wire's list is returned as it is.
 */
export function changesOf(event: { message: { nodeChanges?: readonly unknown[] } }): readonly NodeChange[] {
  const cached = viewCache.get(event);
  if (cached) return cached;
  const list = (event.message?.nodeChanges ?? []) as (NodeChange & { guid: GuidLike })[];
  const view = list.some((c) => typeof c?.guid !== "string")
    ? list.map((c) => {
        const v = { ...c, guid: guidString(c.guid) ?? "" } as NodeChange;
        const p = (c as { parentIndex?: { guid: GuidLike; position: string } }).parentIndex;
        if (p) v.parentIndex = { ...p, guid: guidString(p.guid) ?? "" };
        return v;
      })
    : (list as NodeChange[]);
  viewCache.set(event, view);
  return view;
}
