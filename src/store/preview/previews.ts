/**
 * Developer previews in the store (docs/data.md §13): the package made from the editor's derived snapshot, written as
 * one self-contained HTML file (main's Save dialog picked the path; `previews.exportHtml` is main-only) or published
 * to Firebase Storage `previews/{previewId}/…` behind the same adapter seam as sync (`StorageDriver`: the SDK while
 * sync runs, `MemoryStorage` in tests). Publishing is off until `firebase/config.json` exists and sync is on.
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { PREVIEW_DOC_NAME, PREVIEW_MANIFEST_NAME, previewImageName, type PreviewPackage } from "../../shared/preview/format";
import { inlinePreviewHtml } from "../../shared/preview/html";
import { buildPreviewPackage } from "../../shared/preview/package";
import { StoreError } from "../../shared/store/protocol";
import type { PreviewService } from "../../shared/store/repositories";
import { isFileKey, type FileKey, type PreviewOptions, type PreviewRecord } from "../../shared/store/types";
import { writeFileAtomically } from "../export/fig";
import { nodeCodecs } from "../kiwi/codecs";
import { readJsonOrNull, writeJsonAtomic } from "../local/fsutil";
import { newPreviewId } from "../local/ids";
import { storagePaths } from "../sync/paths";
import type { StorageDriver } from "../sync/drivers";
import type { SyncConfig } from "../sync/config";

export const PREVIEWS_FILE = "previews.json";

/** What the previews need of the store (LocalStore, or a test double). */
export interface PreviewHost {
  root: string;
  tmpDir: string;
  now(): number;
  fileName(fileKey: FileKey): string;
  readBlob(sha1: string): Promise<Uint8Array>;
  /** firebase/config.json (null: not configured) */
  sync: SyncConfig | null;
  /** Firebase Storage while sync runs (startSync sets it), else null */
  storage(): StorageDriver | null;
  /** The viewer's built page (out/viewer/index.html) */
  viewerTemplate: string | null;
  /** Serializes writes of previews.json */
  run<T>(fn: () => Promise<T>): Promise<T>;
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
  try {
    return await buildPreviewPackage(
      { snapshot, fileName: host.fileName(fileKey), previewId, now: host.now(), options, readImage: (sha1) => host.readBlob(sha1).catch(() => null) },
      nodeCodecs,
    );
  } catch (e) {
    throw new StoreError("invalid", `The preview couldn't be made: ${(e as Error).message}`);
  }
}

/** The link a published preview has: the config's viewer origin, else the project's default Hosting site. */
export function previewUrl(sync: SyncConfig, previewId: string): string {
  const origin = sync.viewer?.origin ?? `https://${sync.firebase.projectId}.web.app`;
  return `${origin}/p/${previewId}`;
}

const NO_CACHE = "no-cache";
const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Uploads a package (§13 step 3): doc.kiwi, the images not there yet, then manifest.json **last** with custom
 * metadata `revoked: "false"` — a reader never sees a manifest whose files are missing. Images an earlier version
 * used and this one doesn't are deleted after the manifest switched.
 */
export async function uploadPreview(storage: StorageDriver, pkg: PreviewPackage, previousImages: readonly string[] = []): Promise<void> {
  const id = pkg.manifest.previewId;
  const path = (name: string) => storagePaths.preview(id, name);
  await storage.put(path(PREVIEW_DOC_NAME), pkg.doc, { contentType: "application/octet-stream", cacheControl: NO_CACHE });
  const had = new Set(previousImages);
  for (const [sha1, bytes] of pkg.images) {
    if (had.has(sha1) && (await storage.exists(path(previewImageName(sha1))))) continue;
    await storage.put(path(previewImageName(sha1)), bytes, { contentType: "application/octet-stream", cacheControl: IMMUTABLE });
  }
  const manifest = new TextEncoder().encode(JSON.stringify(pkg.manifest));
  await storage.put(path(PREVIEW_MANIFEST_NAME), manifest, { contentType: "application/json", cacheControl: NO_CACHE, custom: { revoked: "false" } });
  for (const sha1 of had) if (!pkg.images.has(sha1)) await storage.delete(path(previewImageName(sha1))).catch(() => {});
}

/** Stop sharing (§13 step 4): the manifest marked `revoked: "true"` first (the rules refuse it from then on), then the folder deleted. */
export async function revokePreview(storage: StorageDriver, previewId: string, images: readonly string[]): Promise<void> {
  const path = (name: string) => storagePaths.preview(previewId, name);
  const manifest = await storage.get(path(PREVIEW_MANIFEST_NAME)).catch(() => null);
  if (manifest) await storage.put(path(PREVIEW_MANIFEST_NAME), manifest, { contentType: "application/json", cacheControl: NO_CACHE, custom: { revoked: "true" } });
  for (const sha1 of images) await storage.delete(path(previewImageName(sha1))).catch(() => {});
  await storage.delete(path(PREVIEW_DOC_NAME)).catch(() => {});
  await storage.delete(path(PREVIEW_MANIFEST_NAME)).catch(() => {});
}

export interface ExportHtmlResult {
  path: string;
  bytes: number;
  images: number;
}

/** The previews: the `previews.*` service plus main's `exportHtml`. */
export function previewService(host: PreviewHost): PreviewService & { exportHtml(fileKey: FileKey, input: { snapshot: Uint8Array; options?: Partial<PreviewOptions> }, path: string): Promise<ExportHtmlResult> } {
  const file = join(host.root, PREVIEWS_FILE);
  const read = async () => (await readJsonOrNull<PreviewRecord[]>(file)) ?? [];
  const write = (records: PreviewRecord[]) => writeJsonAtomic(host.tmpDir, file, records);
  const publishing = () => {
    if (!host.sync) throw new StoreError("offline", "Sharing previews needs Firebase sync, which isn't set up");
    const storage = host.storage();
    if (!storage) throw new StoreError("offline", "Turn on sync to publish previews");
    return { sync: host.sync, storage };
  };
  return {
    async status() {
      if (!host.sync) return { publish: false, reason: "Sharing previews needs Firebase sync, which isn't set up" };
      if (!host.storage()) return { publish: false, reason: "Turn on sync to publish previews" };
      return { publish: true, reason: null };
    },

    async list(fileKey) {
      const all = await read();
      return fileKey ? all.filter((p) => p.fileKey === fileKey) : all;
    },

    async publish(fileKey, input) {
      if (!isFileKey(fileKey)) throw new StoreError("invalid", "Not a file key");
      const snapshot = checkSnapshot(input?.snapshot);
      const options = validPreviewOptions(input?.options);
      const { sync, storage } = publishing();
      host.fileName(fileKey); // the file exists
      return host.run(async () => {
        const records = await read();
        const previous = records.find((r) => r.fileKey === fileKey) ?? null;
        const previewId = previous?.previewId ?? newPreviewId();
        const pkg = await packageFor(host, fileKey, snapshot, options, previewId);
        try {
          await uploadPreview(storage, pkg, previous?.blobRefs ?? []);
        } catch (e) {
          throw new StoreError("offline", `The preview couldn't be uploaded: ${(e as Error).message}`);
        }
        const now = pkg.manifest.publishedAt;
        const record: PreviewRecord = {
          previewId,
          fileKey,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          expiresAt: pkg.manifest.expiresAt,
          options,
          blobRefs: pkg.manifest.images,
          url: previewUrl(sync, previewId),
        };
        await write([...records.filter((r) => r.previewId !== previewId), record]);
        return record;
      });
    },

    async stop(previewId) {
      const { storage } = publishing();
      return host.run(async () => {
        const records = await read();
        const record = records.find((r) => r.previewId === previewId);
        if (!record) throw new StoreError("not-found", "No such preview");
        await revokePreview(storage, previewId, record.blobRefs);
        await write(records.filter((r) => r.previewId !== previewId));
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
