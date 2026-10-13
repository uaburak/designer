/**
 * A room snapshot on the wire (docs/multiplayer.md §4): the raw kiwi Message gzipped behind a four-byte mark — a large
 * file's Message is ~80 MB raw and ~12 MB gzipped (Figma sends its documents compressed too). The room stores and
 * serves the bytes as they come (it never decodes kiwi, and gzipping there would cost the Worker's CPU), so every
 * reader unpacks: the store's opens and links, version history, branch bases, the viewer's embeds. A snapshot sent
 * before this mark existed is a bare Message and is read as it is.
 *
 * Web streams only (CompressionStream / DecompressionStream: Node ≥ 18 and every browser): both stores and the
 * viewer run it, and the work runs off the calling thread's event loop in Node's zlib pool.
 */

/** "WCZ1", then a gzip member */
const MARK = [0x57, 0x43, 0x5a, 0x31];

export function isPackedSnapshot(bytes: Uint8Array): boolean {
  return bytes.length > 7 && MARK.every((b, i) => bytes[i] === b) && bytes[4] === 0x1f && bytes[5] === 0x8b;
}

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** The raw Message, packed for the room (already packed: as it is) */
export async function packSnapshot(message: Uint8Array): Promise<Uint8Array> {
  if (isPackedSnapshot(message)) return message;
  const gz = await through(message, new CompressionStream("gzip"));
  const out = new Uint8Array(MARK.length + gz.length);
  out.set(MARK, 0);
  out.set(gz, MARK.length);
  return out;
}

/** The raw Message from the room's bytes (a bare one, sent before packing existed, as it is) */
export async function unpackSnapshot(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isPackedSnapshot(bytes)) return bytes;
  return through(bytes.subarray(MARK.length), new DecompressionStream("gzip"));
}
