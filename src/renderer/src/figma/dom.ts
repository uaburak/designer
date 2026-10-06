/** The editor's reading of the page: a layer's rect as the canvas drew it, whether a text is being typed, which key is the modifier. */

import type { SceneNode } from "./model";

/** A canvas rect of a node as drawn (canvas px) — read from the canvas's DOM. */
export function domRect(id: string): { x: number; y: number; w: number; h: number } | null {
  const canvas = document.querySelector<HTMLElement>("[data-figma-canvas]");
  const el = canvas?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
  const world = canvas?.querySelector<HTMLElement>("[data-design-scope]");
  if (!canvas || !el || !world) return null;
  const w = world.getBoundingClientRect();
  // The world's probe (see Canvas): a 1000px span whose drawn width is the zoom — the world itself has no width of its own (everything in it is placed absolutely).
  const probe = world.querySelector<HTMLElement>("[data-zoom-probe]");
  const pw = probe?.getBoundingClientRect().width ?? 0;
  const zoom = pw > 0 ? pw / 1000 : w.width / Math.max(1, world.offsetWidth || 1);
  // Not drawn (hidden, inside a hidden frame): no rect of its own — the caller falls back on the model's place and size.
  if (el.getClientRects().length === 0) return null;
  const r = el.getBoundingClientRect();
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return { x: (r.left - w.left) / scale, y: (r.top - w.top) / scale, w: r.width / scale, h: r.height / scale };
}

/** A layer's canvas rect: as drawn — or, not drawn (hidden), its own place in its parent's rect and its own size. */
export function rectOf(node: SceneNode, parentRect: { x: number; y: number } | null): { x: number; y: number; w: number; h: number } {
  return domRect(node.id) ?? { x: (parentRect?.x ?? 0) + node.x, y: (parentRect?.y ?? 0) + node.y, w: node.width, h: node.height };
}

/** Is a text being typed (a text field, a textarea, a text typed in place)? A focused dropdown, checkbox or slider is not typing: the keys stay the editor's. */
export const isTyping = () => {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && /^(text|search|email|url|tel|password|number|)$/.test((el as HTMLInputElement).type);
};

/** A Mac: ⌘ is the modifier (Ctrl is a key of its own — ^⌥T, ^⌘M); elsewhere Ctrl is. */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
