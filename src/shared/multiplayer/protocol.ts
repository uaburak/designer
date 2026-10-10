/**
 * The multiplayer wire protocol (docs/multiplayer.md §4). One WebSocket per open file to that
 * file's room — one authoritative process per file, Figma's model. The server is a sequencer: it never reads the
 * kiwi payload, it orders it, stores it and fans it out. Conflicts resolve the Figma way — every client applies the
 * accepted changes in the server's order and keeps its own unacknowledged properties on top (per-property last writer
 * wins by server order); the engine applies remote changes with APPLY_REMOTE (no undo entry).
 *
 * Control messages are JSON text frames; document changes are binary frames (the kiwi Message needs no re-encoding).
 */

/** Binary frame: client → server. `[u8 1][u32 batch][kiwi Message]` */
export const FRAME_CHANGES_UP = 1;
/** Binary frame: server → clients, also back to the sender as its acknowledgement.
 *  `[u8 2][u32 seq][u32 sessionID][u32 batch][kiwi Message]` */
export const FRAME_CHANGES_DOWN = 2;

export const CHANGES_UP_HEADER = 5;
export const CHANGES_DOWN_HEADER = 13;

export type ClientControl =
  /** First message. `since`: the last seq this client holds (its snapshot's seq, or the last frame it applied). Who
   *  the client is comes from the Worker (the session token on the socket's URL), not from here. */
  | { t: "hello"; since: number }
  /** Ephemeral (never stored): cursor, selection, viewport … opaque to the server. */
  | { t: "presence"; data: unknown };

export type ServerControl =
  /** The session this connection is. `sessionID` is unique for the file: use it in new nodes' GUIDs. `seq`: the last accepted frame. */
  | { t: "welcome"; sessionID: number; role: Role; seq: number; peers: PeerInfo[]; snapshotSeq: number }
  /** The catch-up after `since` is complete (the frames before it were sent as binary frames). */
  | { t: "ready"; seq: number }
  | { t: "peer-joined"; peer: PeerInfo }
  | { t: "peer-left"; sessionID: number }
  | { t: "presence"; sessionID: number; data: unknown }
  | { t: "error"; code: "unauthorized" | "forbidden" | "bad-frame" | "too-large" | "too-old"; message: string };

/** Figma's file roles: owner, "can edit", "can view" */
export type Role = "owner" | "editor" | "viewer";

export interface PeerInfo {
  sessionID: number;
  userId: string;
  name?: string;
  role: Role;
  presence?: unknown;
}

/** The largest change batch the room accepts: an SQLite value holds 2 MB. Images travel as blobs (R2), not here. */
export const MAX_FRAME_BYTES = 1_900_000;

export function encodeChangesUp(batch: number, message: Uint8Array): Uint8Array {
  const out = new Uint8Array(CHANGES_UP_HEADER + message.length);
  const v = new DataView(out.buffer);
  v.setUint8(0, FRAME_CHANGES_UP);
  v.setUint32(1, batch >>> 0);
  out.set(message, CHANGES_UP_HEADER);
  return out;
}

export function decodeChangesUp(frame: Uint8Array): { batch: number; message: Uint8Array } | null {
  if (frame.length < CHANGES_UP_HEADER || frame[0] !== FRAME_CHANGES_UP) return null;
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return { batch: v.getUint32(1), message: frame.subarray(CHANGES_UP_HEADER) };
}

export interface ChangesDown {
  seq: number;
  sessionID: number;
  batch: number;
  message: Uint8Array;
}

export function encodeChangesDown(f: ChangesDown): Uint8Array {
  const out = new Uint8Array(CHANGES_DOWN_HEADER + f.message.length);
  const v = new DataView(out.buffer);
  v.setUint8(0, FRAME_CHANGES_DOWN);
  v.setUint32(1, f.seq >>> 0);
  v.setUint32(5, f.sessionID >>> 0);
  v.setUint32(9, f.batch >>> 0);
  out.set(f.message, CHANGES_DOWN_HEADER);
  return out;
}

export function decodeChangesDown(frame: Uint8Array): ChangesDown | null {
  if (frame.length < CHANGES_DOWN_HEADER || frame[0] !== FRAME_CHANGES_DOWN) return null;
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return { seq: v.getUint32(1), sessionID: v.getUint32(5), batch: v.getUint32(9), message: frame.subarray(CHANGES_DOWN_HEADER) };
}
