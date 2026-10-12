/**
 * The `canvas.fig` of a Save Local Copy, written the way Figma writes its own (docs/data.md §11.2). Our snapshots are
 * not that: their header carries our DOCUMENT_FORMAT_VERSION (1, where Figma's files carry 15..106), their schema has
 * our reserved `_rN` placeholders at the numbers of Figma's fields we drop and fields Figma doesn't have
 * (`Message.derivedDataVersion = 100`, NodeChange 1000..1002), their Message carries our session and our engine's
 * derived data, and their zstd frame has a checksum. Real Figma took such a file into its file list but never finished
 * opening it (2026-10-12, a Save Local Copy of "sansato"), so an export is re-encoded:
 *
 *   header      "fig-kiwi", FIGMA_FILE_VERSION (the version of the newest Figma export we have, sections.fig / the
 *               owner's file: 106)
 *   chunk 0     deflate-raw of `figmaExportSchema()`: our schema without the placeholders and our own fields — a strict
 *               subset of Figma's (every definition, field, number and type as Figma's; checked against Figma's 106
 *               schema in figmaExport.test.ts)
 *   chunk 1     the Message (`toFigmaMessage`), zstd as Figma 106 writes it (the caller's codec; no checksum)
 *
 * The Message is encoded with our codec: with our fields removed, its bytes are the same under the subset schema.
 */
import { decodeBinarySchema, encodeBinarySchema, type Definition, type Schema } from "kiwi-schema";
import { codec, FIELD_FLAGS, NODE_FIELDS, SCHEMA_BINARY, type Message, type NodeChange } from "../schema/document.generated";
import { NodeTable } from "../schema/patch";
import type { FigCodecs } from "./compression";
import { encodeCanvas, PRELUDE_DESIGN, writeCanvasChunks } from "./container";
import { FIGMA_DERIVED_DATA_VERSION } from "./convert";

/** The `fig-kiwi` version Figma writes today (docs/research/figma/samples/sections.fig, the owner's 2026-10 export). */
export const FIGMA_FILE_VERSION = 106;

/** NodeChange fields Figma doesn't have (`@ours`): never in an export. */
const OUR_NODE_FIELDS: ReadonlySet<string> = new Set(NODE_FIELDS.filter((f) => f.flags & FIELD_FLAGS.OURS).map((f) => f.name));
/** Message fields Figma doesn't have (`@ours` in schema/document.kiwi). */
const OUR_MESSAGE_FIELDS: ReadonlySet<string> = new Set(["derivedDataVersion"]);
const PLACEHOLDER = /^_r\d+$/;

function reachable(defs: Definition[], root: string): Set<string> {
  const byName = new Map(defs.map((d) => [d.name, d]));
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    const d = byName.get(name);
    if (!d) continue;
    seen.add(name);
    for (const f of d.fields) if (f.type && byName.has(f.type)) stack.push(f.type);
  }
  return seen;
}

let exportSchema: Uint8Array | null = null;

/** Our schema as Figma knows it: placeholders, `@ours` fields and the definitions only they used are left out. */
export function figmaExportSchema(): Uint8Array {
  if (exportSchema) return exportSchema;
  const ours = decodeBinarySchema(SCHEMA_BINARY);
  const before = reachable(ours.definitions, "Message");
  const definitions: Definition[] = ours.definitions.map((d) => ({
    ...d,
    fields:
      d.kind !== "MESSAGE"
        ? d.fields
        : d.fields.filter((f) => !PLACEHOLDER.test(f.name) && !(d.name === "NodeChange" && OUR_NODE_FIELDS.has(f.name)) && !(d.name === "Message" && OUR_MESSAGE_FIELDS.has(f.name))),
  }));
  const after = reachable(definitions, "Message");
  const schema: Schema = { package: ours.package, definitions: definitions.filter((d) => !(before.has(d.name) && !after.has(d.name))) };
  return (exportSchema = encodeBinarySchema(schema));
}

const IDENTITY = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

/**
 * One node as Figma writes it. Figma writes `visible`, `opacity`, `transform` and the stroke basics on every node (and
 * a TEXT's type settings and paragraph lines) even at their defaults; absence means our default (schema/document.kiwi
 * `@default`, else the kiwi zero value), which need not be Figma's, so they are written out.
 */
function figmaNode(n: NodeChange): NodeChange {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) if (!OUR_NODE_FIELDS.has(k) && v !== undefined) out[k] = v;
  const root = n.type === "DOCUMENT" || n.type === "CANVAS";
  out.visible ??= true;
  out.opacity ??= 1;
  out.transform ??= IDENTITY;
  out.strokeWeight ??= 0;
  out.strokeAlign ??= "CENTER";
  out.strokeJoin ??= root ? "BEVEL" : "MITER";
  if (!root) out.size ??= { x: 0, y: 0 };
  if (n.type === "TEXT") {
    out.fontName ??= { family: "Inter", style: "Regular", postscript: "Inter-Regular" };
    out.fontSize ??= 12;
    out.lineHeight ??= { value: 100, units: "PERCENT" };
    out.letterSpacing ??= { value: 0, units: "PERCENT" };
    out.textAlignHorizontal ??= "LEFT";
    out.textAlignVertical ??= "TOP";
    const td = (out.textData ?? { characters: "" }) as NonNullable<NodeChange["textData"]>;
    if (!td.lines?.length) {
      const paragraphs = (td.characters ?? "").split("\n").length;
      const line = { lineType: "PLAIN", styleId: 0, indentationLevel: 0, sourceDirectionality: "AUTO", listStartOffset: 0, isFirstLineOfList: false } as const;
      out.textData = { ...td, lines: Array.from({ length: paragraphs }, () => ({ ...line })) };
    }
  }
  return out as NodeChange;
}

/**
 * The Message of an export: every live node CREATED in our snapshot order (DOCUMENT first, parents before children),
 * session 0 as in Figma's files, and a dense blob table of what is still referenced. `@derived` fields go unless they
 * are Figma's own (a `.fig` import keeps Figma's text layout and instance geometry, stamped FIGMA_DERIVED_DATA_VERSION):
 * our engine's glyph outlines and layout are not what Figma's text engine writes, and Figma lays text out, builds
 * instance sublayers and geometry itself when they are absent.
 */
export function toFigmaMessage(message: Message): Message {
  const table = NodeTable.fromMessage(message);
  const plain = table.toMessage({ keepDerived: table.derivedDataVersion === FIGMA_DERIVED_DATA_VERSION, sessionID: 0 });
  return { type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: (plain.nodeChanges ?? []).map(figmaNode), blobs: plain.blobs ?? [] };
}

/** `canvas.fig` bytes for a `.fig` export of `message` (zstd when the codecs have it, else deflate-raw). */
export function encodeFigmaCanvas(message: Message, codecs: FigCodecs): Uint8Array {
  return encodeCanvas(
    {
      prelude: PRELUDE_DESIGN,
      version: FIGMA_FILE_VERSION,
      schema: figmaExportSchema(),
      message: codec.encodeMessage(toFigmaMessage(message)),
      compression: codecs.zstdCompress ? "zstd" : "deflate-raw",
      zstdLevel: 3,
    },
    codecs,
  );
}

/**
 * `encodeFigmaCanvas` with an asynchronous deflate (a browser's CompressionStream; the web app's Save local copy…):
 * both chunks deflate-raw, which Figma reads as it reads its older files.
 */
export async function encodeFigmaCanvasAsync(message: Message, deflateRaw: (data: Uint8Array) => Promise<Uint8Array>): Promise<Uint8Array> {
  const [schema, body] = await Promise.all([deflateRaw(figmaExportSchema()), deflateRaw(codec.encodeMessage(toFigmaMessage(message)))]);
  return writeCanvasChunks({ prelude: PRELUDE_DESIGN, version: FIGMA_FILE_VERSION, chunks: [schema, body] });
}
