/**
 * Thin, typed helpers over the generated codec (document.generated.ts) and the document's initial content.
 */
import { codec, type Message, type NodeChange } from "./document.generated";
import { DOCUMENT_GUID, FIRST_PAGE_GUID, INTERNAL_CANVAS_GUID } from "./guid";

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
}

/** A new file: exactly the three nodes of docs/schema.md §3.1. */
export function newDocumentNodes(opts: NewDocumentOptions = {}): NodeChange[] {
  const doc: NodeChange = { guid: DOCUMENT_GUID, phase: "CREATED", type: "DOCUMENT", name: "Document", documentColorProfile: "SRGB" };
  if (opts.libraries?.length) doc.librarySubscriptions = opts.libraries.map((l) => ({ libraryKey: l.libraryKey, name: l.name }));
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
  ];
}

export function newDocumentMessage(opts: NewDocumentOptions = {}): Message {
  return { type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: newDocumentNodes(opts), blobs: [] };
}
