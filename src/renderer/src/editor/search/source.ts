/**
 * What visual search indexes in the open file (docs/ai.md §6), read from the engine: each page's top-level frames
 * (frames in a section count as top-level), and every component and component set (Assets' list — they can sit in a
 * frame). Each one's content hash (its version), its text (name, description, texts, ≤ 2,000 chars) and its pixels
 * fitted into 224 px through the engine's export.
 */
import type { Guid, NodeChange } from "@/engine/codec";
import type { SearchKind } from "../../../../shared/ai/types";
import type { EditorController } from "../controller";
import type { RgbaImage } from "./embedder";

export interface IndexTarget {
  nodeId: Guid;
  kind: SearchKind;
  name: string;
  pageId: Guid;
  pageName: string;
  width: number;
  height: number;
}

export interface SearchSource {
  readonly fileKey: string;
  fileName(): string;
  /** Everything to index, now */
  targets(): IndexTarget[];
  /** A content hash of the node's subtree: it changes when anything drawn or named in it does */
  version(nodeId: Guid): string;
  /** Name, description and texts, ≤ 2,000 chars */
  text(nodeId: Guid): string;
  /** The node fitted into `size` px; "busy" while its fonts or images load; null when it draws nothing */
  pixels(nodeId: Guid, size: number, allowPending?: boolean): RgbaImage | "busy" | null;
  /** The node's ancestors and itself (which targets a change touches); [] when it is gone */
  chain(nodeId: Guid): Guid[];
}

export const THUMB_SIZE = 224;
export const MAX_TEXT = 2000;

/** FNV-1a, 64 bits as two 32-bit halves, in hex */
export function contentHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c >>> 4), 0x01000193) ^ (h1 >>> 7);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

type Node = NodeChange & { type?: string; resizeToFit?: boolean; isStateGroup?: boolean; visible?: boolean; description?: string; textData?: { characters?: string }; internalOnly?: boolean };

/** A file's texts in reading order, cut at `max` chars */
export function joinText(parts: readonly (string | undefined)[], max = MAX_TEXT): string {
  let out = "";
  for (const p of parts) {
    const t = p?.replace(/\s+/g, " ").trim();
    if (!t) continue;
    out = out ? `${out} ${t}` : t;
    if (out.length >= max) return out.slice(0, max);
  }
  return out;
}

export function editorSearchSource(ed: EditorController, fileKey: string): SearchSource {
  const engine = ed.engine;
  const read = (id: Guid, fields?: string[]) => (engine.destroyed ? null : (engine.readNode(id, fields ? { fields } : {}) as Node | null));
  return {
    fileKey,
    fileName: () => ed.source.fileName,
    targets() {
      if (engine.destroyed) return [];
      const out: IndexTarget[] = [];
      const seen = new Set<Guid>();
      for (const page of ed.store.pages) {
        const kids = engine.readNode(page.guid, { childIds: true })?.childIds ?? [];
        const walk = (ids: readonly Guid[]) => {
          if (!ids.length) return;
          for (const raw of engine.readNodes(ids, { childIds: true, fields: ["type", "name", "size", "resizeToFit", "isStateGroup", "visible"] })) {
            const n = ed.withRealType(raw) as Node;
            if (n.visible === false) continue;
            if (n.type === "SECTION") {
              walk(n.childIds ?? []);
              continue;
            }
            const kind: SearchKind | null = n.type === "SYMBOL" ? "component" : n.type === "FRAME" && n.isStateGroup ? "componentSet" : n.type === "FRAME" && !n.resizeToFit ? "frame" : null;
            if (!kind) continue;
            seen.add(n.guid);
            out.push({ nodeId: n.guid, kind, name: n.name ?? "", pageId: page.guid, pageName: page.name, width: n.size?.x ?? 0, height: n.size?.y ?? 0 });
          }
        };
        walk(kids);
      }
      // Components and sets inside frames (Assets lists them)
      for (const a of ed.components.assets()) {
        if (seen.has(a.id)) continue;
        const n = read(a.id, ["size"]);
        seen.add(a.id);
        out.push({ nodeId: a.id, kind: a.kind === "set" ? "componentSet" : "component", name: a.name, pageId: a.page, pageName: a.pageName, width: n?.size?.x ?? 0, height: n?.size?.y ?? 0 });
      }
      return out;
    },
    version(nodeId) {
      if (engine.destroyed) return "";
      return contentHash(JSON.stringify(engine.readNodes([nodeId], { subtree: true })));
    },
    text(nodeId) {
      if (engine.destroyed) return "";
      const nodes = engine.readNodes([nodeId], { subtree: true, fields: ["type", "name", "description", "textData"] }) as Node[];
      const top = nodes.find((n) => n.guid === nodeId);
      return joinText([top?.name, top?.description, ...nodes.filter((n) => n.type === "TEXT").map((n) => n.textData?.characters)]);
    },
    pixels(nodeId, size, allowPending = false) {
      if (engine.destroyed) return null;
      const n = read(nodeId, ["size"]);
      const w = n?.size?.x ?? 0;
      const h = n?.size?.y ?? 0;
      if (!(w > 0 && h > 0)) return null;
      const out = engine.exportNodes([nodeId], { imageType: "PNG", constraint: { type: w >= h ? "CONTENT_WIDTH" : "CONTENT_HEIGHT", value: size } }, { allowPending });
      if (out.status === "busy") return "busy";
      if (out.status !== "ok" || !("pixels" in out) || !out.pixels) return null;
      return out.pixels;
    },
    chain(nodeId) {
      const out: Guid[] = [];
      let id: Guid | undefined = nodeId;
      for (let i = 0; id && i < 256; i++) {
        const n = read(id, ["parentIndex"]);
        if (!n) break;
        out.push(id);
        id = n.parentIndex?.guid;
      }
      return out;
    },
  };
}
