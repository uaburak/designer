/**
 * Thin, typed helpers over the generated codec (document.generated.ts) and the document's initial content.
 */
import { codec, type Message, type NodeChange, type Paint } from "./document.generated";
import { DOCUMENT_GUID, FIRST_PAGE_GUID, INTERNAL_CANVAS_GUID, THUMBNAIL_FRAME_GUID, THUMBNAIL_PAGE_GUID } from "./guid";

export type * from "./document.generated";
export { codec, DOCUMENT_FORMAT_VERSION, SCHEMA_BINARY, SCHEMA_SHA1 } from "./document.generated";

export function encodeMessage(message: Message): Uint8Array {
  return codec.encodeMessage(message);
}

/** Decodes a Message written with the current schema (data from another schema goes through transcode, data.md §5.8). */
export function decodeMessage(bytes: Uint8Array): Message {
  return codec.decodeMessage(bytes);
}

/** Figma's default page colour #F5F5F5 (docs/schema.md §3.1), as the 32-bit float a file stores (0.9607843160629272). */
const F5 = Math.fround(245 / 255);
export const DEFAULT_PAGE_COLOR = { r: F5, g: F5, b: F5, a: 1 };

export interface NewDocumentOptions {
  /** Name of the first page (default "Page 1") */
  pageName?: string;
  /** Libraries enabled from the start (Workspace.defaultLibraries): DOCUMENT.librarySubscriptions */
  libraries?: { libraryKey: string; name: string }[];
  /**
   * A design file made from Home or the editor (ours, docs/schema.md §3.1): a second page "Thumbnail" holding one
   * 1920 × 1080 frame "Thumbnail", set as the file's thumbnail, filled with one of THUMBNAIL_BACKGROUNDS — `true` a
   * random one, a number that one (mod the list). Imports and the store's internal documents leave it out.
   */
  thumbnail?: boolean | number;
}

const rgb = (hex: string) => ({ r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255, a: 1 });
const solid = (hex: string): Paint => ({ type: "SOLID", color: rgb(hex), opacity: 1, visible: true, blendMode: "NORMAL" });
/** A linear gradient from the top-left corner to the bottom-right (Paint.transform maps the layer's unit square to the gradient's: t = (x + y) / 2). */
const diagonal = (from: string, to: string): Paint => ({
  type: "GRADIENT_LINEAR",
  color: rgb(from),
  opacity: 1,
  visible: true,
  blendMode: "NORMAL",
  stops: [
    { color: rgb(from), position: 0 },
    { color: rgb(to), position: 1 },
  ],
  transform: { m00: 0.5, m01: 0.5, m02: 0, m10: -0.5, m11: 0.5, m12: 0.5 },
});

/** The new file's Thumbnail frame's backgrounds (the owner's covers): deep solids and black-to-colour gradients. */
export const THUMBNAIL_BACKGROUNDS: readonly Paint[] = [
  solid("#3B27D9"), // deep blue-violet
  diagonal("#000000", "#00C2E8"), // black to cyan
  diagonal("#000000", "#14C46A"), // black to green
  solid("#0C8CE9"), // blue
  diagonal("#0E0A2A", "#7B4DFF"), // night to violet
  diagonal("#000000", "#FF4F7B"), // black to pink
  solid("#FF5C2E"), // orange
  diagonal("#101828", "#F5A524"), // ink to amber
  solid("#0F3D2E"), // deep green
];

/** The Thumbnail page and its frame (docs/schema.md §3.1), the frame filled with `background`. */
function thumbnailNodes(background: Paint): NodeChange[] {
  return [
    {
      guid: THUMBNAIL_PAGE_GUID,
      phase: "CREATED",
      type: "CANVAS",
      name: "Thumbnail",
      parentIndex: { guid: DOCUMENT_GUID, position: "P" },
      backgroundColor: { ...DEFAULT_PAGE_COLOR },
      backgroundOpacity: 1,
      backgroundEnabled: true,
    },
    {
      guid: THUMBNAIL_FRAME_GUID,
      phase: "CREATED",
      type: "FRAME",
      name: "Thumbnail",
      parentIndex: { guid: THUMBNAIL_PAGE_GUID, position: "P" },
      visible: true,
      opacity: 1,
      size: { x: 1920, y: 1080 },
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
      fillPaints: [structuredClone(background)],
    },
  ];
}

/** A new file: the three nodes of docs/schema.md §3.1 (with `thumbnail`, the Thumbnail page and frame after them). */
export function newDocumentNodes(opts: NewDocumentOptions = {}): NodeChange[] {
  const doc: NodeChange = { guid: DOCUMENT_GUID, phase: "CREATED", type: "DOCUMENT", name: "Document", documentColorProfile: "SRGB" };
  if (opts.libraries?.length) doc.librarySubscriptions = opts.libraries.map((l) => ({ libraryKey: l.libraryKey, name: l.name }));
  const extra: NodeChange[] = [];
  if (opts.thumbnail !== undefined && opts.thumbnail !== false) {
    const n = THUMBNAIL_BACKGROUNDS.length;
    const i = typeof opts.thumbnail === "number" ? ((Math.trunc(opts.thumbnail) % n) + n) % n : Math.floor(Math.random() * n);
    doc.thumbnailInfo = { nodeID: { ...THUMBNAIL_FRAME_GUID }, thumbnailVersion: "" };
    extra.push(...thumbnailNodes(THUMBNAIL_BACKGROUNDS[i]));
  }
  return [
    doc,
    {
      guid: FIRST_PAGE_GUID,
      phase: "CREATED",
      type: "CANVAS",
      name: opts.pageName ?? "Page 1",
      parentIndex: { guid: DOCUMENT_GUID, position: "!" },
      backgroundColor: { ...DEFAULT_PAGE_COLOR },
      backgroundOpacity: 1,
      backgroundEnabled: true,
    },
    {
      guid: INTERNAL_CANVAS_GUID,
      phase: "CREATED",
      type: "CANVAS",
      name: "Internal Only Canvas",
      parentIndex: { guid: DOCUMENT_GUID, position: "~" },
      internalOnly: true,
      visible: false,
    },
    ...extra,
  ];
}

export function newDocumentMessage(opts: NewDocumentOptions = {}): Message {
  return { type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: newDocumentNodes(opts), blobs: [] };
}
