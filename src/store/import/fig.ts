/**
 * Import of a `.fig` in the store (docs/data.md §11.1): the shared import (src/shared/fig/importFig.ts) with Node's
 * zlib (deflate-raw + zstd), node:crypto and kiwi-schema's compiled codecs.
 */
import { prepareFigImport as prepareShared, type PreparedImport } from "../../shared/fig/importFig";
import { nodeCodecs } from "../kiwi/codecs";
import { decodeWithSchema, sha1Hex } from "../kiwi/schemas";

export { remapSessions, type PreparedImport } from "../../shared/fig/importFig";

/** `name`: a file name or path, used when the .fig's meta.json has no `file_name` (".fig" dropped). */
export function prepareFigImport(bytes: Uint8Array, opts: { name: string; sessionID: number }): PreparedImport {
  return prepareShared(bytes, opts, nodeCodecs, {
    sha1: sha1Hex,
    decode: (schema, message) => {
      const d = decodeWithSchema(schema, message, { keepDerived: true });
      return { message: d.message, report: d.report };
    },
  });
}
