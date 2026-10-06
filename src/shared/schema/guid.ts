/**
 * GUIDs (docs/schema.md §9, docs/data.md §1): `{sessionID, localID}`, string form "s:l", URL form "s-l".
 *
 * sessionID = (deviceOrdinal << 20) | n — deviceOrdinal 1..4095 (1 until sync assigns one), n counts edit-mode opens of
 * one file on one device (persisted in the file's store.json). sessionID < 2^20 (ordinal 0) is reserved for the
 * document root, the initial pages, pages made by Home and GUIDs kept from a .fig import.
 */
import type { GUID } from "./document.generated";

export type { GUID };

export const SESSION_BITS = 20;
/** Sessions below this are reserved (ordinal 0). */
export const RESERVED_SESSION_LIMIT = 2 ** SESSION_BITS;
export const MAX_DEVICE_ORDINAL = 4095;
/** Figma's "none" sentinel (seen on overrideKey); DesignerV2 never writes it: absence means none. */
export const NONE_ID = 4294967295;

export const DOCUMENT_GUID: GUID = { sessionID: 0, localID: 0 };
export const FIRST_PAGE_GUID: GUID = { sessionID: 0, localID: 1 };
export const INTERNAL_CANVAS_GUID: GUID = { sessionID: 0, localID: 2 };

export const guidKey = (g: GUID): string => `${g.sessionID}:${g.localID}`;
export const guidUrl = (g: GUID): string => `${g.sessionID}-${g.localID}`;
export const guidEquals = (a: GUID | undefined, b: GUID | undefined): boolean => !!a && !!b && a.sessionID === b.sessionID && a.localID === b.localID;
export const isNoneGuid = (g: GUID): boolean => g.sessionID === NONE_ID && g.localID === NONE_ID;

/** Parses "s:l" or "s-l". */
export function parseGuid(text: string): GUID {
  const m = /^(\d+)[:-](\d+)$/.exec(text);
  if (!m) throw new Error(`not a GUID: ${JSON.stringify(text)}`);
  const sessionID = Number(m[1]);
  const localID = Number(m[2]);
  if (sessionID > NONE_ID || localID > NONE_ID) throw new Error(`GUID out of range: ${text}`);
  return { sessionID, localID };
}

/** Order used for ties between equal positions: sessionID, then localID. */
export function compareGuids(a: GUID, b: GUID): number {
  return a.sessionID - b.sessionID || a.localID - b.localID;
}

/** (deviceOrdinal << 20) | n as an unsigned 32-bit number (JS shifts are signed, hence the multiplication). */
export function sessionIdFor(deviceOrdinal: number, n: number): number {
  if (!Number.isInteger(deviceOrdinal) || deviceOrdinal < 1 || deviceOrdinal > MAX_DEVICE_ORDINAL) throw new Error(`device ordinal out of range: ${deviceOrdinal}`);
  if (!Number.isInteger(n) || n < 1 || n >= RESERVED_SESSION_LIMIT) throw new Error(`session counter out of range: ${n}`);
  return deviceOrdinal * RESERVED_SESSION_LIMIT + n;
}

export function splitSessionId(sessionID: number): { deviceOrdinal: number; n: number } {
  return { deviceOrdinal: Math.floor(sessionID / RESERVED_SESSION_LIMIT), n: sessionID % RESERVED_SESSION_LIMIT };
}

export const isReservedSession = (sessionID: number) => sessionID < RESERVED_SESSION_LIMIT;

/**
 * Hands out localIDs within one session, from 1, skipping ids already used in that session (the engine's rule,
 * engine.md §2.5). The engine is the only allocator in an editor; TS uses this for import remapping and Home.
 */
export class GuidAllocator {
  private next_ = 1;
  private readonly used: Set<number>;

  constructor(
    readonly sessionID: number,
    used: Iterable<GUID> = [],
  ) {
    this.used = new Set<number>();
    for (const g of used) if (g.sessionID === sessionID) this.used.add(g.localID);
  }

  next(): GUID {
    while (this.used.has(this.next_)) this.next_++;
    if (this.next_ >= NONE_ID) throw new Error(`session ${this.sessionID} is out of localIDs`);
    const g = { sessionID: this.sessionID, localID: this.next_ };
    this.used.add(this.next_++);
    return g;
  }
}
