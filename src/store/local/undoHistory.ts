/**
 * The local user's undo history kept beside a file (docs/engine.md §9.3; Figma's Message.localUndoStack 22 /
 * localRedoStack 23 — docs/research/rea/canvas.md §2.18): `files/<key>/undo.kiwi`, written when the editor closes the
 * file, read back at the next open on this device. Per device and never in a snapshot, a version or an export. It
 * stands at one journal seq: a file whose head moved since (another editor, a branch update, a sync) opens without it.
 *
 *   "WUH1" | headSeq (float64, little-endian) | the engine's history bytes
 *
 * Nothing in it is the document: a missing, short or foreign file reads as no history.
 */

export const UNDO_HISTORY_FILE = "undo.kiwi";
/** The engine exports at most 16 MB; anything past this isn't one of ours */
export const MAX_UNDO_HISTORY_BYTES = 32 << 20;
const MAGIC = [0x57, 0x55, 0x48, 0x31]; // "WUH1"
const HEADER = 12;

export function encodeUndoHistory(headSeq: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER + bytes.length);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setFloat64(4, headSeq, true);
  out.set(bytes, HEADER);
  return out;
}

/** The history and the seq it stands at, or null for anything else */
export function decodeUndoHistory(file: Uint8Array | null | undefined): { headSeq: number; bytes: Uint8Array } | null {
  if (!file || file.length <= HEADER || file.length > MAX_UNDO_HISTORY_BYTES + HEADER) return null;
  for (let i = 0; i < MAGIC.length; i++) if (file[i] !== MAGIC[i]) return null;
  const headSeq = new DataView(file.buffer, file.byteOffset, file.byteLength).getFloat64(4, true);
  if (!Number.isSafeInteger(headSeq) || headSeq < 0) return null;
  // A plain Uint8Array (not a Node Buffer) of its own: it crosses the port as bytes.
  return { headSeq, bytes: new Uint8Array(file.buffer.slice(file.byteOffset + HEADER, file.byteOffset + file.byteLength)) };
}
