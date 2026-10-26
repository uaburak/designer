/**
 * Links on the canvas (Figma's text links, and Wecra's canvas buttons): a link goes to a website, to a layer of this
 * file, or to a layer of another file. Figma's way: "Copy link" (⌘L, Copy/Paste as ▸) copies the selection's link,
 * pasted into a link field it links to that layer. Ours: a layer's link is `designer://file/<fileKey>?node-id=1-2`
 * (the app's own scheme; the file's key, not a shared room's). A text's link to a layer of this file is kept as
 * Figma keeps it (`Hyperlink.guid`); to another file's layer, as its link (`Hyperlink.url`).
 */
import type { Guid } from "@/engine/codec";
import type { EditorController } from "../controller";
import { normalizeLink } from "./text";

export type LinkTarget = { kind: "url"; url: string } | { kind: "node"; fileKey: string | null; nodeId: Guid };

const NODE_ID = /[?&]node-id=([0-9]+)[-:]([0-9]+)/;

/** A layer's link: `designer://file/<fileKey>?node-id=1-2`, with where it is (`place=`, "Copy link") for another file's menus. */
export function nodeLink(fileKey: string, nodeId: Guid, place?: string | null): string {
  return `designer://file/${encodeURIComponent(fileKey)}?node-id=${nodeId.replace(":", "-")}${place ? `&place=${encodeURIComponent(place)}` : ""}`;
}

/**
 * What a typed or pasted link points at: a layer's link (ours, or an editor address `?editor&file=…&node-id=…`), a
 * bare layer id ("12:34") in this file, else a website (`normalizeLink`). `here`: this file's key — a link to one of
 * its layers comes back with `fileKey` null.
 */
export function parseLinkTarget(text: string, here: string | null): LinkTarget | null {
  const s = text.trim();
  if (!s) return null;
  if (/^[0-9]+[:-][0-9]+$/.test(s)) return { kind: "node", fileKey: null, nodeId: s.replace("-", ":") };
  const node = NODE_ID.exec(s);
  const ours = /^designer:\/\/file\/([^/?#]+)/.exec(s);
  const editor = /[?&]file=([^&#]+)/.exec(s);
  const key = ours ? decodeURIComponent(ours[1]) : /[?&]editor\b/.test(s) && editor ? decodeURIComponent(editor[1]) : null;
  if (key && node) return { kind: "node", fileKey: key === here ? null : key, nodeId: `${node[1]}:${node[2]}` };
  const url = normalizeLink(s);
  return url ? { kind: "url", url } : null;
}

/** A text run's link as the target it names (`guid`: a layer of this file). */
export function hyperlinkTarget(link: { url?: string; guid?: unknown } | null | undefined, here: string | null): LinkTarget | null {
  if (!link) return null;
  const g = link.guid as { sessionID?: number; localID?: number } | string | undefined;
  const guid = typeof g === "string" ? g : g && typeof g.sessionID === "number" && typeof g.localID === "number" ? `${g.sessionID}:${g.localID}` : null;
  if (guid && /^[0-9]+:[0-9]+$/.test(guid)) return { kind: "node", fileKey: null, nodeId: guid };
  return link.url ? (parseLinkTarget(link.url, here) ?? { kind: "url", url: link.url }) : null;
}

/** The target as a text run's `hyperlink` (Figma's: a layer of this file by guid). */
export function hyperlinkOf(target: LinkTarget, here: string | null): { url?: string; guid?: { sessionID: number; localID: number } } {
  if (target.kind === "url") return { url: target.url };
  const [sessionID, localID] = target.nodeId.split(":").map(Number);
  if (!target.fileKey || target.fileKey === here) return { guid: { sessionID, localID } };
  return { url: nodeLink(target.fileKey, target.nodeId) };
}

/** The target as the link a field shows. */
export function linkText(target: LinkTarget, here: string | null): string {
  if (target.kind === "url") return target.url;
  return here || target.fileKey ? nodeLink(target.fileKey ?? here!, target.nodeId) : target.nodeId;
}

export const fileKeyOf = (ed: EditorController): string | null => (ed.source as { fileKey?: string }).fileKey ?? null;

/**
 * Where a layer is, as a link's menu names it: its outermost frame on the page (the screen it is on — "/home"), else
 * its own name. Null when the layer isn't in this file.
 */
export function placeName(ed: EditorController, nodeId: Guid): string | null {
  const pages = new Set(ed.store.pages.map((p) => p.guid));
  const self = ed.engine.readNode(nodeId, { fields: ["name", "parentIndex"] });
  if (!self) return null;
  let top = self;
  let cur: Guid | undefined = self.parentIndex?.guid;
  for (let guard = 0; cur && !pages.has(cur) && guard < 256; guard++) {
    const n = ed.engine.readNode(cur, { fields: ["name", "parentIndex", "type"] });
    if (!n) break;
    if (n.type !== "SECTION") top = n;
    cur = n.parentIndex?.guid;
  }
  return top.name ?? null;
}

/** A website's link as a short label: host and path, without the scheme. */
export const urlLabel = (url: string): string => url.replace(/^https?:\/\//i, "").replace(/\/$/, "");

type Nav = { openFile?: (f: { fileKey: string; nodeId?: string }) => Promise<unknown> };
type Desktop = { designer?: { nav?: Nav; openExternal?: (url: string) => void } };

/** Follows a link: a website in the browser, a layer of this file selected and in view, another file's in its tab. */
export function followLink(ed: EditorController, target: LinkTarget, land: (nodeId: Guid) => void): void {
  const d = (window as unknown as Desktop).designer;
  if (target.kind === "url") {
    if (d?.openExternal) d.openExternal(target.url);
    else window.open(target.url, "_blank", "noopener");
    return;
  }
  const here = fileKeyOf(ed);
  if (!target.fileKey || target.fileKey === here) return land(target.nodeId);
  if (d?.nav?.openFile) void d.nav.openFile({ fileKey: target.fileKey, nodeId: target.nodeId });
  else window.open(`${location.pathname}?editor&file=${encodeURIComponent(target.fileKey)}&node-id=${target.nodeId.replace(":", "-")}`, "_blank", "noopener");
}
