/**
 * A change too large for one frame, as several (docs/multiplayer.md §18.1; Figma streams such a change between
 * `STREAM_START` and `STREAM_END`): the room takes at most MAX_FRAME_BYTES a frame, so a bigger journal frame — a large
 * paste, an import into a shared file — is sent as parts, each a whole NODE_CHANGES Message of some of its node changes
 * (in their order, parents before children as the engine wrote them) with the blobs they use. Every part goes under the
 * same batch; the sender counts their echoes, and a reconnect sends only the parts the room didn't take. Others apply
 * each part as a frame of its own: the change shows up in a few steps, as in Figma.
 *
 * Deterministic — the same frame always splits the same way — so a client that restarted mid-way sends the rest.
 * A node change too large on its own goes field by field (a CREATED's first part keeps the phase, its type and place);
 * a single field over the limit can't travel (null): the sender rolls the change back (service.ts `rollBack`).
 */
import { decodeMessage, encodeMessage, type Message, type NodeChange } from "../schema/codec";
import { MODEL } from "../schema/model";
import { rebaseBlobIndices } from "../schema/patch";
import { MAX_FRAME_BYTES } from "./protocol";

/** Room for the frame's header and the Message's own fields */
export const SPLIT_LIMIT = MAX_FRAME_BYTES - 64 * 1024;

/** The parts `bytes` travels as: `[bytes]` when it fits; null when one of its fields alone is over the limit. */
export function splitFrame(bytes: Uint8Array, limit = SPLIT_LIMIT): Uint8Array[] | null {
  if (bytes.length <= limit) return [bytes];
  const message = decodeMessage(bytes);
  const out: Uint8Array[] = [];
  return fill(message, message.nodeChanges ?? [], limit, out) ? out : null;
}

/** The parts of `nodes` (some of `message`'s), appended to `out`; false when a field can't fit */
function fill(message: Message, nodes: NodeChange[], limit: number, out: Uint8Array[]): boolean {
  if (!nodes.length) return true;
  const part = partOf(message, nodes);
  if (part.length <= limit) {
    out.push(part);
    return true;
  }
  if (nodes.length > 1) {
    const half = Math.ceil(nodes.length / 2);
    return fill(message, nodes.slice(0, half), limit, out) && fill(message, nodes.slice(half), limit, out);
  }
  const fields = fieldsOf(nodes[0]);
  if (fields.length <= 1) return false;
  return fill(message, fields, limit, out);
}

/** One node change as several, a field or two each (keyed as the original: guid; a CREATED's first keeps what makes it) */
function fieldsOf(nc: NodeChange): NodeChange[] {
  const any = nc as unknown as Record<string, unknown>;
  const head: Record<string, unknown> = { guid: nc.guid };
  if (nc.phase) head.phase = nc.phase;
  for (const k of ["type", "parentIndex"]) if (k in any) head[k] = any[k];
  const rest = Object.keys(any).filter((k) => !(k in head) && k !== "clearedFields");
  const out: NodeChange[] = [head as unknown as NodeChange];
  if (nc.clearedFields?.length) out.push({ guid: nc.guid, clearedFields: nc.clearedFields } as NodeChange);
  // The first field rides with the head: a CREATED arrives with something
  rest.forEach((k, i) => {
    if (i === 0 && !nc.clearedFields?.length) head[k] = any[k];
    else out.push({ guid: nc.guid, [k]: any[k] } as unknown as NodeChange);
  });
  return out;
}

/** A Message of some node changes with only the blobs they use, renumbered */
function partOf(message: Message, nodes: NodeChange[]): Uint8Array {
  const src = message.blobs ?? [];
  const blobs: { bytes: Uint8Array }[] = [];
  const map = new Map<number, number>();
  const rebased = src.length
    ? nodes.map((nc) =>
        rebaseBlobIndices(MODEL, nc, (i) => {
          let j = map.get(i);
          if (j === undefined) {
            j = blobs.push({ bytes: src[i]?.bytes ?? new Uint8Array(0) }) - 1;
            map.set(i, j);
          }
          return j;
        }),
      )
    : nodes;
  return encodeMessage({ ...message, nodeChanges: rebased, blobs });
}
