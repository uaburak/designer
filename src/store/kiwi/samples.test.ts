/**
 * Real Figma files (docs/research/figma/samples/*.fig): the container reader, Figma's own schema, the eval-free
 * interpreter, the import-by-name check of docs/schema.md §1.1 point 5, and the full conversion.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileSchema, decodeBinarySchema } from "kiwi-schema";
import { describe, expect, it } from "vitest";
import { decodeCanvas, encodeCanvas, readCanvasChunks } from "../../shared/fig/container";
import { convertFigMessage, newImportReport, projectMessageByName } from "../../shared/fig/convert";
import { readFigFile, writeFigFile } from "../../shared/fig/figFile";
import { codec, SCHEMA_BINARY, type Message } from "../../shared/schema/document.generated";
import { interpretSchema } from "../../shared/schema/dynamic";
import { SchemaModel } from "../../shared/schema/model";
import { NodeTable } from "../../shared/schema/patch";
import { nodeCodecs } from "./codecs";
import { sha1Hex } from "./schemas";

const SAMPLES = join(__dirname, "../../../docs/research/figma/samples");
const NAMES = ["structure.fig", "sections.fig", "stacks_wrap.fig"];

function load(name: string) {
  const file = readFigFile(new Uint8Array(readFileSync(join(SAMPLES, name))), nodeCodecs);
  const canvas = decodeCanvas(file.canvas, nodeCodecs);
  const schema = decodeBinarySchema(canvas.schema);
  const compiled = compileSchema(schema);
  const message = compiled.decodeMessage(canvas.message);
  return { file, canvas, schema, compiled, message, model: new SchemaModel(schema) };
}

describe("Figma sample files", () => {
  for (const name of NAMES) {
    describe(name, () => {
      const s = load(name);

      it("reads the ZIP, meta.json, the thumbnail and the canvas container", () => {
        expect(s.file.bare).toBe(false);
        expect(s.file.meta?.client_meta?.background_color).toBeDefined();
        expect(s.file.thumbnail?.subarray(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47])); // "PNG"
        expect(s.canvas.prelude).toBe("fig-kiwi");
        expect(s.canvas.version).toBeGreaterThanOrEqual(20);
        expect(s.message.type).toBe("NODE_CHANGES");
        expect(s.message.nodeChanges.length).toBeGreaterThan(10);
        // decode.mjs's dump of the same file agrees on the node count.
        const dump = JSON.parse(readFileSync(join(SAMPLES, `${name}.json`), "utf8"));
        expect(s.message.nodeChanges.length).toBe(dump.nodeChanges.length);
      });

      it("images are named by the SHA-1 of their bytes", () => {
        for (const [hash, bytes] of s.file.images) expect(sha1Hex(bytes)).toBe(hash);
      });

      it("the interpreter decodes exactly what compileSchema decodes, and re-encodes the same bytes", () => {
        const dyn = interpretSchema(s.schema);
        const viaInterpreter = dyn.decode("Message", s.canvas.message);
        expect(viaInterpreter).toEqual(s.message);
        expect(dyn.encode("Message", viaInterpreter)).toEqual(s.compiled.encodeMessage(s.message));
      });

      it("rewrites the container and the .fig losslessly", () => {
        const chunks = readCanvasChunks(s.file.canvas);
        const again = encodeCanvas({ schema: s.canvas.schema, message: s.canvas.message, version: s.canvas.version, compression: s.canvas.compression }, nodeCodecs);
        const decoded = decodeCanvas(again, nodeCodecs);
        expect(decoded.schema).toEqual(s.canvas.schema);
        expect(decoded.message).toEqual(s.canvas.message);
        expect(chunks.chunks.length).toBeGreaterThanOrEqual(2);
        const zip = writeFigFile({ canvas: s.file.canvas, meta: s.file.meta, thumbnail: s.file.thumbnail, images: s.file.images });
        const back = readFigFile(zip, nodeCodecs);
        expect(back.canvas).toEqual(s.file.canvas);
        expect(back.meta).toEqual(s.file.meta);
        expect(back.thumbnail).toEqual(s.file.thumbnail);
        expect([...back.images.keys()]).toEqual([...s.file.images.keys()]);
      });

      it("imports by name (docs/schema.md §1.1 point 5): project, encode with our codec, decode, identical", () => {
        const report = newImportReport();
        const projected = projectMessageByName(s.message, s.model, undefined, report);
        const bytes = codec.encodeMessage(projected);
        const back = codec.decodeMessage(bytes);
        expect(back).toEqual(projected);
        expect(report.nodesOut + Object.values(report.droppedNodeTypes).reduce((a, b) => a + b, 0)).toBe(report.nodesIn);
        console.info(
          `${name}: by-name ${report.nodesIn} → ${report.nodesOut} nodes, ${bytes.length} bytes; dropped node types ${JSON.stringify(report.droppedNodeTypes)}; ` +
            `${Object.keys(report.droppedFields).length} dropped field names`,
        );
      });

      it("converts (mappings + projection) into a valid snapshot that survives our container", () => {
        const { message, report } = convertFigMessage(s.message, s.model);
        const table = NodeTable.fromMessage(message);
        const snapshot = table.toMessage();
        const bytes = codec.encodeMessage(snapshot);
        const canvas = encodeCanvas({ schema: SCHEMA_BINARY, message: bytes, version: 1, compression: "zstd" }, nodeCodecs);
        const back = codec.decodeMessage(decodeCanvas(canvas, nodeCodecs).message) as Message;
        expect(back.nodeChanges!.length).toBe(report.nodesOut);
        expect(back.nodeChanges![0].type).toBe("DOCUMENT");
        expect(NodeTable.fromMessage(back).toMessage()).toEqual(snapshot);
        // No GROUP or RECTANGLE survives, and no derived data.
        for (const n of back.nodeChanges!) {
          expect(n.type).not.toBe("GROUP");
          expect(n.type).not.toBe("RECTANGLE");
          expect(n.fillGeometry).toBeUndefined();
          expect(n.derivedSymbolData).toBeUndefined();
        }
        const fields = Object.entries(report.droppedFields)
          .filter(([k]) => k.startsWith("NodeChange."))
          .map(([k, v]) => `${k.slice(11)}×${v}`);
        console.info(`${name}: convert ${report.nodesIn} → ${report.nodesOut} nodes, snapshot ${canvas.length} bytes (zstd); mappings ${JSON.stringify(report.mappings)}; dropped NodeChange fields: ${fields.join(", ")}`);
      });
    });
  }
});
