/**
 * The Figma connection as a view sees it (docs/desktop.md §13 "Images from Figma"). On the desktop it is main's
 * (`figma:*`): the token is sealed there with safeStorage and never comes back to a page. In a browser there is no
 * main: the token is kept in this tab's sessionStorage only (gone when the tab closes) and Figma is called directly —
 * which works only where Figma's CORS lets the browser through.
 */
import type { FigmaConnection, FigmaImagesResult } from "@shared/ipc";
import { fetchFigmaImages, figmaMe, looksLikeFigmaToken, type FetchLike, type FigmaResult, type FigmaUser } from "@shared/figmaApi";
import type { FigmaConnectionApi } from "@shared/desktop";

export interface FigmaClient {
  /** "desktop": sealed in main; "web": this tab's session only */
  readonly kind: "desktop" | "web";
  status(): Promise<FigmaConnection>;
  connect(token: string): Promise<FigmaResult<FigmaConnection>>;
  disconnect(): Promise<FigmaConnection>;
  images(fileKey: string, hashes: string[], onProgress?: (done: number, total: number) => void): Promise<FigmaImagesResult>;
}

type Bridge = FigmaConnectionApi & { images?(fileKey: string, hashes: string[]): Promise<FigmaImagesResult> };

const listeners = new Set<() => void>();
/** Connected, replaced or disconnected anywhere in this view: Settings and the paste's dialog read it again. */
export function onFigmaConnectionChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}
const changed = () => listeners.forEach((l) => l());

/** The desktop's connection through the preload. */
export function desktopFigmaClient(bridge: Bridge): FigmaClient {
  return {
    kind: "desktop",
    status: () => bridge.status(),
    connect: async (token) => {
      const r = await bridge.connect(token);
      if (r.ok) changed();
      return r;
    },
    disconnect: async () => {
      const r = await bridge.disconnect();
      changed();
      return r;
    },
    images: async (fileKey, hashes) => (bridge.images ? bridge.images(fileKey, hashes) : { ok: false, error: "failed" }),
  };
}

export const WEB_TOKEN_KEY = "designer.figmaConnection";

/** The browser's connection: sessionStorage, Figma called from the page. */
export function webFigmaClient(fetch: FetchLike, storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null): FigmaClient {
  const read = (): { token: string; user: FigmaUser | null } | null => {
    try {
      const v = JSON.parse(storage?.getItem(WEB_TOKEN_KEY) ?? "null") as { token?: unknown; user?: FigmaUser | null } | null;
      return v && looksLikeFigmaToken(v.token) ? { token: v.token, user: v.user ?? null } : null;
    } catch {
      return null;
    }
  };
  return {
    kind: "web",
    status: async () => {
      const s = read();
      return { connected: !!s, user: s?.user ?? null };
    },
    connect: async (token) => {
      const clean = token.trim();
      const me = await figmaMe(clean, fetch);
      if (!me.ok) return me;
      try {
        storage?.setItem(WEB_TOKEN_KEY, JSON.stringify({ token: clean, user: me.value }));
      } catch {
        /* no storage: connected for this call only */
      }
      changed();
      return { ok: true, value: { connected: true, user: me.value } };
    },
    disconnect: async () => {
      try {
        storage?.removeItem(WEB_TOKEN_KEY);
      } catch {
        /* nothing kept */
      }
      changed();
      return { connected: false, user: null };
    },
    images: async (fileKey, hashes, onProgress) => {
      const s = read();
      if (!s) return { ok: false, error: "no-token" };
      return fetchFigmaImages(s.token, fileKey, hashes, fetch, { onProgress });
    },
  };
}

/** This view's client: main's on the desktop (Home, editors), else the browser's. */
export function figmaClient(): FigmaClient {
  const d = (globalThis as unknown as { designer?: { figma?: Bridge } }).designer;
  if (d?.figma) return desktopFigmaClient(d.figma);
  let storage: Storage | null = null;
  try {
    storage = globalThis.sessionStorage ?? null;
  } catch {
    storage = null;
  }
  return webFigmaClient(((url, init) => globalThis.fetch(url, init)) as FetchLike, storage);
}
