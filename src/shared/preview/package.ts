/**
 * Builds a developer preview's package (docs/data.md §13) from the editor's derived snapshot: the engine's
 * `encodeDocumentKiwi({derived: true})` Message — every page with its instances' sublayer layout and each text's glyph
 * outlines (`derivedTextData`), so the viewer draws exact text without the owner's fonts (docs/schema.md §4.1,
 * "preview snapshot"). Pure: the store (Node's zlib) and tests (any deflate) call it with their codecs.
 */
import type { FigCodecs } from "../fig/compression";
import { encodeCanvas } from "../fig/container";
import { codec, DOCUMENT_FORMAT_VERSION, SCHEMA_BINARY, type Message, type NodeChange } from "../schema/document.generated";
import { compareKeys } from "../schema/fractionalIndex";
import { compareGuids, guidKey } from "../schema/guid";
import { messageImageHashes } from "../schema/patch";
import { expiryOf, PREVIEW_DOC_NAME, PREVIEW_FORMAT, type PreviewManifest, type PreviewPackage, type PreviewPage } from "./format";

export interface PreviewPackageOptions {
  /** Page ids ("s:l") to include, or every page */
  pageIds: string[] | "all";
  inspect: boolean;
  export: boolean;
  expiresInDays: 7 | 30 | null;
}

export interface BuildPreviewInput {
  /** The raw kiwi Message (not a container) */
  snapshot: Uint8Array;
  fileName: string;
  previewId: string;
  now: number;
  options: PreviewPackageOptions;
  /** An image file by SHA-1 (null: not in the blob store; its paints draw Figma's grey placeholder) */
  readImage(sha1: string): Promise<Uint8Array | null>;
}

interface Tree {
  byKey: Map<string, NodeChange>;
  children: Map<string, NodeChange[]>;
  documentKey: string | null;
}

function treeOf(message: Message): Tree {
  const byKey = new Map<string, NodeChange>();
  const children = new Map<string, NodeChange[]>();
  let documentKey: string | null = null;
  for (const n of message.nodeChanges ?? []) {
    if (!n.guid || n.phase === "REMOVED") continue;
    const key = guidKey(n.guid);
    byKey.set(key, n);
    if (n.type === "DOCUMENT") documentKey = key;
    if (n.parentIndex) {
      const p = guidKey(n.parentIndex.guid);
      const list = children.get(p) ?? [];
      list.push(n);
      children.set(p, list);
    }
  }
  for (const list of children.values()) list.sort((a, b) => compareKeys(a.parentIndex!.position, b.parentIndex!.position) || compareGuids(a.guid!, b.guid!));
  return { byKey, children, documentKey };
}

/** The pages a viewer lists (the internal canvas — components' and library copies' home — excluded), in order. */
function pagesOf(tree: Tree): NodeChange[] {
  if (!tree.documentKey) return [];
  return (tree.children.get(tree.documentKey) ?? []).filter((n) => n.type === "CANVAS" && !n.internalOnly);
}

/** Every page and its top-level layers (topmost first, as the Layers panel lists them). */
export function previewPagesOf(message: Message): PreviewPage[] {
  const tree = treeOf(message);
  return pagesOf(tree).map((page) => ({
    id: guidKey(page.guid!),
    name: page.name ?? "Page",
    frames: [...(tree.children.get(guidKey(page.guid!)) ?? [])]
      .filter((n) => n.visible !== false)
      .reverse()
      .map((n) => ({ id: guidKey(n.guid!), name: n.name ?? "", type: n.type ?? "FRAME" })),
  }));
}

/**
 * The Message without the pages not chosen (and everything under them). The internal canvas stays: instances on the
 * chosen pages need their mains. Returns the same Message when nothing is dropped.
 */
export function keepPages(message: Message, pageIds: string[] | "all"): Message {
  if (pageIds === "all") return message;
  const tree = treeOf(message);
  const wanted = new Set(pageIds);
  const pages = pagesOf(tree);
  if (!pages.some((p) => wanted.has(guidKey(p.guid!)))) throw new Error("none of the chosen pages is in the file");
  const dropped = new Set<string>();
  const drop = (key: string) => {
    dropped.add(key);
    for (const c of tree.children.get(key) ?? []) drop(guidKey(c.guid!));
  };
  for (const p of pages) if (!wanted.has(guidKey(p.guid!))) drop(guidKey(p.guid!));
  if (!dropped.size) return message;
  return { ...message, nodeChanges: (message.nodeChanges ?? []).filter((n) => !n.guid || !dropped.has(guidKey(n.guid))) };
}

export async function buildPreviewPackage(input: BuildPreviewInput, codecs: Pick<FigCodecs, "deflateRaw">): Promise<PreviewPackage> {
  const decoded = codec.decodeMessage(input.snapshot);
  if (!(decoded.nodeChanges ?? []).some((n) => n.type === "DOCUMENT")) throw new Error("the snapshot has no document");
  const message = keepPages(decoded, input.options.pageIds);
  const bytes = message === decoded ? input.snapshot : codec.encodeMessage(message);
  const images = new Map<string, Uint8Array>();
  for (const sha1 of [...messageImageHashes(message)].sort()) {
    const data = await input.readImage(sha1).catch(() => null);
    if (data) images.set(sha1, data);
  }
  const manifest: PreviewManifest = {
    format: PREVIEW_FORMAT,
    previewId: input.previewId,
    fileName: input.fileName,
    publishedAt: input.now,
    expiresAt: expiryOf(input.options.expiresInDays, input.now),
    pages: previewPagesOf(message),
    snapshot: PREVIEW_DOC_NAME,
    documentFormatVersion: DOCUMENT_FORMAT_VERSION,
    derivedDataVersion: message.derivedDataVersion ?? 0,
    images: [...images.keys()],
    options: { inspect: input.options.inspect, export: input.options.export },
  };
  const doc = encodeCanvas({ schema: SCHEMA_BINARY, message: bytes, version: DOCUMENT_FORMAT_VERSION, compression: "deflate-raw" }, { deflateRaw: codecs.deflateRaw, inflateRaw: () => new Uint8Array() });
  return { manifest, doc, images };
}
