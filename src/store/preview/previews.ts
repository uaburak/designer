/**
 * Developer previews in the store (docs/data.md §13, docs/multiplayer.md §9): the package made from the editor's
 * derived snapshot, written as one self-contained HTML file (main's Save dialog picked the path; `previews.exportHtml`
 * is main-only) or published to the multiplayer server (`/previews/<id>/…`, opened at `<server>/p/<id>`) with the
 * session main handed the store (`multiplayer.setSession`). Publishing needs that session: logged out, "Log in to
 * publish".
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { PreviewDevData, PreviewPackage } from "../../shared/preview/format";
import { inlinePreviewHtml } from "../../shared/preview/html";
import { buildPreviewPackage } from "../../shared/preview/package";
import { StoreError } from "../../shared/store/protocol";
import type { PreviewService } from "../../shared/store/repositories";
import { isFileKey, type FileKey, type PreviewOptions, type PreviewRecord } from "../../shared/store/types";
import { writeFileAtomically } from "../export/fig";
import { nodeCodecs } from "../kiwi/codecs";
import { readJsonOrNull, writeJsonAtomic } from "../local/fsutil";
import { newPreviewId } from "../local/ids";

export const PREVIEWS_FILE = "previews.json";
export const LOG_IN_TO_PUBLISH = "Log in to publish";

/** The signed-in session with the server (docs/multiplayer.md §2) */
export interface PreviewSession {
  server: string;
  token: string;
}

/** What the previews need of the store (LocalStore, or a test double). */
export interface PreviewHost {
  root: string;
  tmpDir: string;
  now(): number;
  fileName(fileKey: FileKey): string;
  readBlob(sha1: string): Promise<Uint8Array>;
  /** The session main handed over, null while logged out */
  session(): PreviewSession | null;
  fetch: typeof fetch;
  /** The viewer's built page (out/viewer/index.html) */
  viewerTemplate: string | null;
  /** Serializes writes of previews.json */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** The file's dev resources and Code Connect mappings for the viewer's Inspect (docs/editor.md D-1, D-3) */
  devData?(fileKey: FileKey): Promise<PreviewDevData | null>;
}

export function validPreviewOptions(o: Partial<PreviewOptions> | undefined): PreviewOptions {
  const pageIds = Array.isArray(o?.pageIds) ? o.pageIds.filter((p) => typeof p === "string" && /^\d+:\d+$/.test(p)).slice(0, 1000) : "all";
  const days = o?.expiresInDays;
  return {
    pageIds: pageIds === "all" || pageIds.length === 0 ? "all" : pageIds,
    inspect: o?.inspect !== false,
    export: o?.export !== false,
    expiresInDays: days === 7 || days === 30 ? days : null,
  };
}

function checkSnapshot(snapshot: unknown): Uint8Array {
  if (!(snapshot instanceof Uint8Array) || snapshot.length === 0) throw new StoreError("invalid", "A preview needs the file's snapshot");
  return snapshot;
}

async function packageFor(host: PreviewHost, fileKey: FileKey, snapshot: Uint8Array, options: PreviewOptions, previewId: string): Promise<PreviewPackage> {
  const devMode = options.inspect && host.devData ? await host.devData(fileKey).catch(() => null) : null;
  try {
    return await buildPreviewPackage(
      { snapshot, fileName: host.fileName(fileKey), previewId, now: host.now(), options, readImage: (sha1) => host.readBlob(sha1).catch(() => null), devMode },
      nodeCodecs,
    );
  } catch (e) {
    throw new StoreError("invalid", `The preview couldn't be made: ${(e as Error).message}`);
  }
}

/** One call to the server with the session; its refusals as StoreErrors in the Share dialog's words. */
async function request(host: PreviewHost, session: PreviewSession, method: string, path: string, body?: Uint8Array | object): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${session.token}` };
  let payload: RequestInit["body"];
  if (body instanceof Uint8Array) {
    payload = body as unknown as RequestInit["body"];
    headers["content-type"] = "application/octet-stream";
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  let res: Response;
  try {
    res = await host.fetch(new URL(path, session.server).toString(), { method, headers, body: payload });
  } catch {
    throw new StoreError("offline", "Couldn't reach the server. Check your connection and try again.");
  }
  if (res.ok) return res;
  const text = await res.text().catch(() => "");
  let message = text;
  try {
    message = (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    // plain text
  }
  if (res.status === 401) throw new StoreError("forbidden", "Your session expired. Log in again.");
  if (res.status === 404) throw new StoreError("not-found", message || "No such preview");
  throw new StoreError("invalid", message || `The server said ${res.status}`);
}

/**
 * Uploads a package to the server (docs/multiplayer.md §9): the images it doesn't have yet, doc.kiwi (staged), then
 * the manifest, which makes it live — a reader never sees a manifest whose files are missing. Returns the link.
 */
export async function uploadPreview(host: PreviewHost, session: PreviewSession, pkg: PreviewPackage, fileKey: FileKey): Promise<string> {
  const base = `/previews/${pkg.manifest.previewId}`;
  const { missing } = (await (await request(host, session, "POST", `${base}/images/missing`, { sha1s: [...pkg.images.keys()] })).json()) as { missing: string[] };
  for (const sha1 of missing) {
    const bytes = pkg.images.get(sha1);
    if (bytes) await request(host, session, "PUT", `${base}/images/${sha1}`, bytes);
  }
  await request(host, session, "PUT", `${base}/doc`, pkg.doc);
  const { url } = (await (await request(host, session, "PUT", `${base}/manifest`, { manifest: pkg.manifest, fileKey })).json()) as { url: string };
  return url;
}

export interface ExportHtmlResult {
  path: string;
  bytes: number;
  images: number;
}

/** The previews: the `previews.*` service plus main's `exportHtml` and the store's `sweepExpired`. */
export function previewService(host: PreviewHost): PreviewService & {
  exportHtml(fileKey: FileKey, input: { snapshot: Uint8Array; options?: Partial<PreviewOptions> }, path: string): Promise<ExportHtmlResult>;
  sweepExpired(): Promise<string[]>;
} {
  const file = join(host.root, PREVIEWS_FILE);
  const read = async () => (await readJsonOrNull<PreviewRecord[]>(file)) ?? [];
  const write = (records: PreviewRecord[]) => writeJsonAtomic(host.tmpDir, file, records);
  const signedIn = () => {
    const session = host.session();
    if (!session) throw new StoreError("offline", LOG_IN_TO_PUBLISH);
    return session;
  };
  const unpublish = async (session: PreviewSession, previewId: string) => {
    try {
      await request(host, session, "DELETE", `/previews/${encodeURIComponent(previewId)}`);
    } catch (e) {
      // Already gone from the server (expired and deleted, or unpublished elsewhere): forgotten here too.
      if (!(e instanceof StoreError && e.code === "not-found")) throw e;
    }
  };
  return {
    async status() {
      return host.session() ? { publish: true, reason: null } : { publish: false, reason: LOG_IN_TO_PUBLISH };
    },

    async list(fileKey) {
      const all = await read();
      return fileKey ? all.filter((p) => p.fileKey === fileKey) : all;
    },

    async publish(fileKey, input) {
      if (!isFileKey(fileKey)) throw new StoreError("invalid", "Not a file key");
      const snapshot = checkSnapshot(input?.snapshot);
      const options = validPreviewOptions(input?.options);
      const session = signedIn();
      host.fileName(fileKey); // the file exists
      return host.run(async () => {
        const records = await read();
        const previous = records.find((r) => r.fileKey === fileKey) ?? null;
        const previewId = previous?.previewId ?? newPreviewId();
        const pkg = await packageFor(host, fileKey, snapshot, options, previewId);
        const url = await uploadPreview(host, session, pkg, fileKey);
        const now = pkg.manifest.publishedAt;
        const record: PreviewRecord = {
          previewId,
          fileKey,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          expiresAt: pkg.manifest.expiresAt,
          options,
          blobRefs: pkg.manifest.images,
          url,
        };
        await write([...records.filter((r) => r.previewId !== previewId), record]);
        return record;
      });
    },

    async stop(previewId) {
      const session = signedIn();
      return host.run(async () => {
        const records = await read();
        if (!records.some((r) => r.previewId === previewId)) throw new StoreError("not-found", "No such preview");
        await unpublish(session, previewId);
        await write(records.filter((r) => r.previewId !== previewId));
      });
    },

    /**
     * Expired previews (their `expiresAt` passed) are deleted from the server and forgotten — run when main hands the
     * store a session. The server already refuses them and deletes their files at expiry (its alarm); this drops its
     * row and the local record. Logged out or offline, the next session tries again. Returns the swept ids.
     */
    async sweepExpired() {
      const session = host.session();
      if (!session) return [];
      return host.run(async () => {
        const records = await read();
        const now = host.now();
        const expired = records.filter((r) => r.expiresAt !== null && r.expiresAt !== undefined && r.expiresAt <= now);
        if (!expired.length) return [];
        const swept: string[] = [];
        for (const r of expired) {
          try {
            await unpublish(session, r.previewId);
            swept.push(r.previewId);
          } catch {
            // offline: the next session tries again
          }
        }
        await write(records.filter((r) => !swept.includes(r.previewId)));
        return swept;
      });
    },

    async exportHtml(fileKey, input, path) {
      if (!isFileKey(fileKey)) throw new StoreError("invalid", "Not a file key");
      if (typeof path !== "string" || !path) throw new StoreError("invalid", "exportHtml needs a path");
      const snapshot = checkSnapshot(input?.snapshot);
      if (!host.viewerTemplate) throw new StoreError("io", "The preview viewer isn't part of this build");
      const template = await fsp.readFile(host.viewerTemplate, "utf8").catch(() => {
        throw new StoreError("io", "The preview viewer isn't built (npm run build:viewer)");
      });
      const pkg = await packageFor(host, fileKey, snapshot, validPreviewOptions(input?.options), newPreviewId());
      const html = new TextEncoder().encode(inlinePreviewHtml(template, pkg));
      await writeFileAtomically(host.tmpDir, path, html);
      return { path, bytes: html.length, images: pkg.images.size };
    },
  };
}
