import type * as Real from "@/lib/storage";
import { checkUpload, mediaPath, webSized } from "@/lib/media";
import * as db from "./db";

/**
 * The demo's bucket: uploads kept in this computer's IndexedDB, each file a
 * data URL under a path as the real bucket's (media/YYYY/MM/…). The editor's
 * pictures point at those data URLs. No Firebase Storage.
 */

export type { KeptFiles, UploadProgress } from "@/lib/storage";

const PREFIX = "file:";
/** path → data URL, read at once (publicUrl and the kept list are asked synchronously) */
const files = new Map<string, string>();
const listeners = new Set<() => void>();
const loaded = db.keys(PREFIX).then(async (keys) => {
  for (const key of keys) {
    const url = await db.get<string>(key);
    if (url) files.set(key.slice(PREFIX.length), url);
  }
  listeners.forEach((l) => l());
});

const readAsDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

export const WEB_IMAGE: typeof Real.WEB_IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;
export const LIST_FRESH_FOR: typeof Real.LIST_FRESH_FOR = Infinity;

export const uploadFile: typeof Real.uploadFile = async (file, path, onProgress) => {
  const url = await readAsDataUrl(file);
  await db.set(PREFIX + path, url);
  files.set(path, url);
  onProgress?.(100);
  listeners.forEach((l) => l());
  return url;
};

export const uploadMedia: typeof Real.uploadMedia = async (file, folder = "media", onProgress) => {
  checkUpload(file);
  const ready = await webSized(file);
  return uploadFile(ready, mediaPath(ready, folder), onProgress);
};

export const publicUrl: typeof Real.publicUrl = (path) => files.get(path) ?? "";
export const storagePathOf: typeof Real.storagePathOf = (url) => {
  for (const [path, data] of files) if (data === url) return path;
  return null;
};
export const listFiles: typeof Real.listFiles = async (prefix) => {
  await loaded;
  return [...files.keys()].filter((p) => p.startsWith(prefix));
};
export const keptFiles: typeof Real.keptFiles = (prefix) => ({ at: Date.now(), paths: [...files.keys()].filter((p) => p.startsWith(prefix)) });
export const isFresh: typeof Real.isFresh = () => true;
export const onKeptFilesChange: typeof Real.onKeptFilesChange = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const listKept: typeof Real.listKept = (prefix) => listFiles(prefix);
export const rememberUrl: typeof Real.rememberUrl = () => undefined;
export const knownUrl: typeof Real.knownUrl = (path) => files.get(path);
export const downloadUrl: typeof Real.downloadUrl = async (path) => {
  await loaded;
  return files.get(path) ?? "";
};
export const deleteFile: typeof Real.deleteFile = async (path) => {
  await db.del(PREFIX + path);
  files.delete(path);
  listeners.forEach((l) => l());
};
