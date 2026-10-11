/**
 * The multiplayer wire protocol (docs/multiplayer.md §4). One WebSocket per open file to that
 * file's room — one authoritative process per file, Figma's model. The server is a sequencer: it never reads the
 * kiwi payload, it orders it, stores it and fans it out. Conflicts resolve the Figma way — every client applies the
 * accepted changes in the server's order and keeps its own unacknowledged properties on top (per-property last writer
 * wins by server order); the engine applies remote changes with APPLY_REMOTE (no undo entry).
 *
 * Control messages are JSON text frames; document changes are binary frames (the kiwi Message needs no re-encoding).
 */
import type { RoomPolicy } from "../org/identity";
import type { RestJob, RestJobPart } from "../rest/types";

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
  | { t: "hello"; since: number; /** This client can answer REST render jobs (docs/multiplayer.md §16.6): an editor view with the file's engine loaded */ render?: boolean; /** With `render`: the desktop app's hidden render helper (docs/multiplayer.md §16.6), asked after editors and viewers */ helper?: boolean }
  /** Ephemeral (never stored): cursor, selection, viewport … opaque to the server. */
  | { t: "presence"; data: unknown }
  /** Ephemeral, to one session of the file (never stored): "Ask to spotlight", audio's WebRTC offers / answers / ICE. */
  | { t: "signal"; to: number; data: unknown }
  /** A REST render job's parts are uploaded (`PUT /files/:key/rest-jobs/:id/parts/:name`, docs/multiplayer.md §16.6) */
  | { t: "rest-job-done"; id: string; parts: RestJobPart[] }
  | { t: "rest-job-failed"; id: string; err: string };

/** The largest signal the room relays (a WebRTC offer with its candidates fits easily) */
export const MAX_SIGNAL_BYTES = 32_000;

export type ServerControl =
  /** The session this connection is. `sessionID` is unique for the file: use it in new nodes' GUIDs. `seq`: the last accepted frame. */
  | { t: "welcome"; sessionID: number; role: Role; seq: number; peers: PeerInfo[]; snapshotSeq: number; policy?: RoomPolicy }
  /** The catch-up after `since` is complete (the frames before it were sent as binary frames). */
  | { t: "ready"; seq: number }
  | { t: "peer-joined"; peer: PeerInfo }
  | { t: "peer-left"; sessionID: number }
  | { t: "presence"; sessionID: number; data: unknown }
  | { t: "signal"; from: number; data: unknown }
  /** Something about the file for its people: an "Ask to edit" request (to editors), its answer (to the requester) */
  | { t: "notice"; kind: "access-request" | "access-granted" | "access-denied"; userId: string; name?: string }
  /** The file's comments changed (docs/multiplayer.md §10): read them again */
  | { t: "comments"; threadId: string; by: string }
  /** The org changed cursor chat or audio (docs/multiplayer.md §15.9) */
  | { t: "policy"; policy: RoomPolicy }
  /** A REST render job for this client (docs/multiplayer.md §16.6): run it, upload the parts, answer rest-job-done / -failed */
  | { t: "rest-job"; id: string; job: RestJob }
  | { t: "error"; code: "unauthorized" | "forbidden" | "bad-frame" | "too-large" | "too-old"; message: string };

/** On a person's inbox socket, never stored (docs/multiplayer.md §16.6): a room of theirs has no client that can render */
export type RestInboxMessage = { t: "rest-wanted"; fileKey: string };

/** The room is moving to another region (§15.10): reconnect after a moment */
export const CLOSE_MOVING = 4012;

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
