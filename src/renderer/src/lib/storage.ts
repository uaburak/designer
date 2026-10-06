import { ref, uploadBytesResumable, getDownloadURL, deleteObject } from "firebase/storage";
import { auth, storage } from "@/lib/firebase";
import { checkUpload, mediaPath, webSized } from "@/lib/media";

export type UploadProgress = {
  percent: number;
  downloadURL?: string;
  error?: string;
};

/**
 * How long a browser keeps a file it downloaded: a year, never asking again
 * — every upload goes to a path of its own (a timestamp in its name), so a
 * file never changes under its address. (Firebase's default makes the
 * browser ask again on every view.)
 */
const CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * Upload a file to Firebase Storage and return its public download URL.
 *
 * @param file     The File object to upload.
 * @param path     Storage path, e.g. "projects/my-slug/image.png"
 * @param onProgress Optional callback for upload progress (0–100).
 */
export async function uploadFile(
  file: File,
  path: string,
  onProgress?: (percent: number) => void,
): Promise<string> {
  const storageRef = ref(storage, path);
  const task = uploadBytesResumable(storageRef, file, { cacheControl: CACHE_CONTROL, ...(file.type ? { contentType: file.type } : {}) });

  return new Promise((resolve, reject) => {
    task.on(
      "state_changed",
      (snapshot) => {
        const pct = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
        onProgress?.(pct);
      },
      (error) => reject(error),
      async () => {
        const url = await getDownloadURL(task.snapshot.ref);
        rememberUrl(url);
        touchFiles(path, "add");
        resolve(url);
      },
    );
  });
}

/**
 * An upload of the editor's (or the CV's): checked (a file the site can
 * show, 25 MB at most), a picture made web-sized (see webSized), put at a
 * path of its own under `folder` — its download URL back.
 */
export async function uploadMedia(file: File, folder = "media", onProgress?: (percent: number) => void): Promise<string> {
  checkUpload(file);
  const ready = await webSized(file);
  return uploadFile(ready, mediaPath(ready, folder), onProgress);
}

// ── Browsing the bucket ───────────────────────────────────────────────────────

const BUCKET = storage.app.options.storageBucket ?? "";
const API = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o`;

/** A picture a browser draws (not a HEIC, a TIFF…), by its path's extension. */
export const WEB_IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;

/**
 * A file's public address — built from its path, without asking Storage
 * for a download URL (its reads are open to all, as the site's pages need).
 */
export const publicUrl = (path: string) => `${API}/${encodeURIComponent(path)}?alt=media`;

/** The path of the bucket's file a download URL points to — null for any other address. */
export function storagePathOf(url: string): string | null {
  const at = url.indexOf(`/b/${BUCKET}/o/`);
  if (at < 0) return null;
  const rest = url.slice(at + `/b/${BUCKET}/o/`.length);
  const end = rest.search(/[?#]/);
  try {
    return decodeURIComponent(end < 0 ? rest : rest.slice(0, end));
  } catch {
    return null;
  }
}

/**
 * The paths of every file under `prefix`, its folders' too — asked of
 * Storage's REST list without a delimiter: one request per 1000 files,
 * where the SDK's listAll asks once per folder (a project's blocks are a
 * folder each).
 */
export async function listFiles(prefix: string): Promise<string[]> {
  const token = await auth.currentUser?.getIdToken().catch(() => undefined);
  const headers: HeadersInit = token ? { Authorization: `Firebase ${token}` } : {};
  const paths: string[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({ prefix, maxResults: "1000", ...(pageToken ? { pageToken } : {}) });
    const res = await fetch(`${API}?${query}`, { headers });
    if (!res.ok) throw new Error(`Storage list failed (${res.status})`);
    const page = (await res.json()) as { items?: { name: string }[]; nextPageToken?: string };
    paths.push(...(page.items ?? []).map((i) => i.name));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return paths;
}

// ── What the bucket holds, kept ───────────────────────────────────────────────
//
// Storage bills every request and every download, so what has been asked is
// kept: a folder's list (in memory and in localStorage, for a day — see
// listKept), the download URLs met (a file's token URL, the one pages draw
// with: the browser's cache keeps a picture by its address). Every upload and
// delete here changes the kept lists themselves; another tab's changes come
// through localStorage.

/** How long a kept list is used before its folder is asked again. */
export const LIST_FRESH_FOR = 24 * 60 * 60 * 1000;
const LIST_KEY = "storage-list:";

export interface KeptFiles {
  /** When the folder was listed */
  at: number;
  paths: string[];
}

const kept = new Map<string, KeptFiles>();
const listeners = new Set<() => void>();
/** The uploads and deletes made here, a while: a list asked for before one of them came back without it (see listKept). */
const journal: { at: number; path: string; change: "add" | "remove" }[] = [];
const asking = new Map<string, Promise<string[]>>();
const urls = new Map<string, string>();

function stored(prefix: string): KeptFiles | null {
  try {
    const raw = localStorage.getItem(LIST_KEY + prefix);
    const list = raw ? (JSON.parse(raw) as KeptFiles) : null;
    return list && Array.isArray(list.paths) && typeof list.at === "number" ? list : null;
  } catch {
    return null;
  }
}

/** The kept list of `prefix`'s files, however old (see isFresh) — null when it was never listed here. */
export function keptFiles(prefix: string): KeptFiles | null {
  let list = kept.get(prefix) ?? null;
  if (!list) {
    list = stored(prefix);
    if (list) kept.set(prefix, list);
  }
  return list;
}

export const isFresh = (list: KeptFiles) => Date.now() - list.at < LIST_FRESH_FOR;

function keepFiles(prefix: string, list: KeptFiles) {
  kept.set(prefix, list);
  try {
    localStorage.setItem(LIST_KEY + prefix, JSON.stringify(list));
  } catch { /* full or blocked: the memory's copy serves */ }
  listeners.forEach((l) => l());
}

/** Called whenever a kept list changes (here or in another tab); returns the unsubscribe. */
export function onKeptFilesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== "undefined") {
  // Another tab listed, uploaded or deleted: its lists are the ones to read.
  window.addEventListener("storage", (e) => {
    if (e.key && !e.key.startsWith(LIST_KEY)) return;
    if (e.key) kept.delete(e.key.slice(LIST_KEY.length));
    else kept.clear();
    listeners.forEach((l) => l());
  });
}

const changed = (paths: string[], path: string, change: "add" | "remove") => {
  const rest = paths.filter((p) => p !== path);
  return change === "add" ? [path, ...rest] : rest;
};

/** An upload in, a delete out — every kept list of a folder holding it, changed without asking Storage again. */
function touchFiles(path: string, change: "add" | "remove") {
  const now = Date.now();
  journal.push({ at: now, path, change });
  while (journal.length && (journal.length > 500 || now - journal[0].at > 10 * 60 * 1000)) journal.shift();
  const prefixes = new Set(kept.keys());
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(LIST_KEY)) prefixes.add(k.slice(LIST_KEY.length));
    }
  } catch { /* blocked */ }
  for (const prefix of prefixes) {
    if (!path.startsWith(prefix)) continue;
    // The memory's list is the latest (another tab's write takes it away — see the "storage" listener; a list too big to store lives only there).
    const list = kept.get(prefix) ?? stored(prefix);
    if (list) keepFiles(prefix, { ...list, paths: changed(list.paths, path, change) });
  }
}

/**
 * `prefix`'s files, asked of Storage (one request per 1000 — see listFiles)
 * and kept: an ask while one is out waits for it; what was uploaded or
 * deleted here while it was out is applied over what it brings.
 */
export function listKept(prefix: string): Promise<string[]> {
  let pending = asking.get(prefix);
  if (!pending) {
    const since = Date.now();
    pending = listFiles(prefix)
      .then((listed) => {
        const paths = journal.filter((j) => j.at >= since && j.path.startsWith(prefix)).reduce((list, j) => changed(list, j.path, j.change), listed);
        keepFiles(prefix, { at: Date.now(), paths });
        return paths;
      })
      .finally(() => asking.delete(prefix));
    asking.set(prefix, pending);
  }
  return pending;
}

/** A download URL met (an upload's, one asked for, one a page draws with): kept by its file's path. */
export function rememberUrl(url: string) {
  const path = storagePathOf(url);
  if (path && !urls.has(path)) urls.set(path, url);
}

/** The download URL kept for a file, if one was met. */
export const knownUrl = (path: string) => urls.get(path);

/**
 * A file's download URL — its token's, what stays valid whatever the
 * bucket's rules: the one kept, or asked once (one request) — its public
 * address when that fails.
 */
export async function downloadUrl(path: string): Promise<string> {
  const known = urls.get(path);
  if (known) return known;
  const url = await getDownloadURL(ref(storage, path)).catch(() => publicUrl(path));
  rememberUrl(url);
  return url;
}

/** Delete one file of the bucket, by its path — one already gone is deleted too. */
export async function deleteFile(path: string) {
  try {
    await deleteObject(ref(storage, path));
  } catch (err) {
    if ((err as { code?: string }).code !== "storage/object-not-found") throw err;
  }
  urls.delete(path);
  touchFiles(path, "remove");
}
