/**
 * The Figma connection (docs/desktop.md §13 "Images from Figma"): the person's personal access token, sealed with
 * safeStorage (sealed.ts) in userData/figma.json with the account it belongs to, and the REST calls that use it
 * (src/shared/figmaApi.ts) — made here, so the token never reaches a page and Figma's CORS never matters. The token
 * goes to api.figma.com only; it is never logged and never part of the store's (synced) data.
 */
import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchFigmaImages, figmaMe, isFigmaFileKey, isImageRef, looksLikeFigmaToken, type FetchLike, type FigmaResult, type FigmaUser } from "../shared/figmaApi";
import type { FigmaConnection, FigmaImagesResult } from "../shared/ipc";
import { mainFetch } from "./net";
import { sealAsync, unsealAsync, type SealOptions } from "./sealed";

interface Stored {
  /** "enc:…" (safeStorage) or "raw:…" (no OS encryption) */
  token?: string;
  user?: FigmaUser | null;
}

export interface FigmaDeps {
  /** userData/figma.json */
  path?: string;
  fetch?: FetchLike;
  seal?: SealOptions;
}

/** At most this many images a request (a paste names a few; a page of them is still a few hundred). */
const MAX_HASHES = 2000;

export class FigmaConnectionStore {
  private readonly path: string;
  private readonly fetch: FetchLike;
  private cached: string | null | undefined;

  constructor(private readonly deps: FigmaDeps = {}) {
    this.path = deps.path ?? join(app.getPath("userData"), "figma.json");
    this.fetch = deps.fetch ?? (mainFetch as unknown as FetchLike);
  }

  private read(): Stored {
    try {
      if (!existsSync(this.path)) return {};
      const v = JSON.parse(readFileSync(this.path, "utf8")) as Stored;
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }

  private write(s: Stored): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  private async token(): Promise<string | null> {
    if (this.cached !== undefined) return this.cached;
    this.cached = await unsealAsync(this.read().token, this.deps.seal);
    return this.cached;
  }

  async status(): Promise<FigmaConnection> {
    const s = this.read();
    return s.token ? { connected: true, user: s.user ?? null } : { connected: false, user: null };
  }

  /** Checks the token with Figma (`/v1/me`) and keeps it only when Figma takes it. */
  async connect(token: string): Promise<FigmaResult<FigmaConnection>> {
    const clean = token.trim();
    if (!looksLikeFigmaToken(clean)) return { ok: false, error: "invalid-token" };
    const me = await figmaMe(clean, this.fetch);
    if (!me.ok) return me;
    this.write({ token: await sealAsync(clean, this.deps.seal), user: me.value });
    this.cached = clean;
    return { ok: true, value: { connected: true, user: me.value } };
  }

  async disconnect(): Promise<FigmaConnection> {
    this.write({});
    this.cached = null;
    return { connected: false, user: null };
  }

  /** The images a paste needs from the file it came from. */
  async images(fileKey: string, hashes: readonly string[]): Promise<FigmaImagesResult> {
    if (!isFigmaFileKey(fileKey)) return { ok: false, error: "not-found" };
    const token = await this.token();
    if (!token) return { ok: false, error: "no-token" };
    return fetchFigmaImages(token, fileKey, hashes.filter(isImageRef).slice(0, MAX_HASHES), this.fetch);
  }
}

let store: FigmaConnectionStore | null = null;
/** The app's one connection (created on first use: userData is known by then). */
export const figmaConnection = (): FigmaConnectionStore => (store ??= new FigmaConnectionStore());
