/**
 * Ids as Figma's REST API writes them (developers.figma.com/docs/rest-api/variables-endpoints): variables
 * `VariableID:1:2`, collections `VariableCollectionId:1:3`, a library's copy `VariableID:<key>/1:2`; modes and nodes
 * are plain GUIDs ("1:4"). Our document's ids are the GUIDs; these helpers go both ways.
 */
export const restVariableId = (id: string, libraryKey?: string | null): string => `VariableID:${libraryKey ? `${libraryKey}/` : ""}${id}`;
export const restCollectionId = (id: string, libraryKey?: string | null): string => `VariableCollectionId:${libraryKey ? `${libraryKey}/` : ""}${id}`;

/** A REST id (or a bare GUID) → the document's GUID; null when it isn't one */
export function guidOf(rest: string): string | null {
  const bare = rest.replace(/^(VariableID|VariableCollectionId):/, "");
  const guid = bare.includes("/") ? bare.slice(bare.lastIndexOf("/") + 1) : bare;
  return /^-?\d+:-?\d+$/.test(guid) ? guid : null;
}

/** A GUID inside a structure — "1:2", or `{sessionID, localID}` as decoded files write it — as "1:2"; null when none */
export function guidStr(v: unknown): string | null {
  if (typeof v === "string") return v || null;
  if (v && typeof v === "object") {
    const o = v as { sessionID?: unknown; localID?: unknown; guid?: unknown };
    if (o.guid !== undefined) return guidStr(o.guid);
    if (typeof o.sessionID === "number" && typeof o.localID === "number") return `${o.sessionID}:${o.localID}`;
  }
  return null;
}
