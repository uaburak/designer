/**
 * Durable file operations (docs/data.md §3.2). Every JSON file and every snapshot is written atomically:
 *   1. write to tmp/<random>  2. fsync it  3. rename it into place  4. fsync the parent directory.
 * Journals are the only files appended in place (journal.ts).
 */
import { randomBytes } from "node:crypto";
import { constants, promises as fsp } from "node:fs";
import { dirname, join } from "node:path";

export const TMP_DIR = "tmp";

export async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await fsp.mkdir(path, { recursive: true });
}

/** fsync a directory so a rename into it is durable (macOS and Linux allow opening a directory read-only). */
export async function fsyncDir(dir: string): Promise<void> {
  let fh: fsp.FileHandle | null = null;
  try {
    fh = await fsp.open(dir, "r");
    await fh.sync();
  } catch (e) {
    // Some filesystems refuse fsync on directories (EINVAL/EISDIR/EPERM); the rename is still atomic.
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EISDIR" && code !== "EPERM" && code !== "EBADF") throw e;
  } finally {
    await fh?.close();
  }
}

/** Writes `data` at `path` atomically through `tmpDir` (same volume as `path`). */
export async function atomicWrite(tmpDir: string, path: string, data: Uint8Array | string): Promise<void> {
  const tmp = join(tmpDir, `${randomBytes(8).toString("hex")}.tmp`);
  const fh = await fsp.open(tmp, "w", 0o644);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.rename(tmp, path);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  await fsyncDir(dirname(path));
}

export async function writeJsonAtomic(tmpDir: string, path: string, value: unknown): Promise<void> {
  await atomicWrite(tmpDir, path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Writes JSON atomically and keeps the previous generation as `<path>.bak` (workspace.json and prefs.json, §3.2):
 * the old file is renamed to .bak first, so at every instant either the file or its .bak is complete.
 */
export async function writeJsonWithBackup(tmpDir: string, path: string, value: unknown): Promise<void> {
  const tmp = join(tmpDir, `${randomBytes(8).toString("hex")}.tmp`);
  const fh = await fsp.open(tmp, "w", 0o644);
  try {
    await fh.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await fh.sync();
  } finally {
    await fh.close();
  }
  if (await exists(path)) await fsp.rename(path, `${path}.bak`);
  await fsp.rename(tmp, path);
  await fsyncDir(dirname(path));
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await fsp.readFile(path, "utf8")) as T;
}

/** Reads `<path>`, falling back to `<path>.bak`; null when neither is readable. */
export async function readJsonWithBackup<T>(path: string): Promise<{ value: T; fromBackup: boolean } | null> {
  try {
    return { value: await readJson<T>(path), fromBackup: false };
  } catch {
    try {
      return { value: await readJson<T>(`${path}.bak`), fromBackup: true };
    } catch {
      return null;
    }
  }
}

export async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path);
  } catch {
    return null;
  }
}

/** Hard link, falling back to a copy (versions share immutable snapshots, §6). */
export async function linkOrCopy(from: string, to: string): Promise<void> {
  try {
    await fsp.link(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return;
    await fsp.copyFile(from, to);
  }
}

export async function fileSize(path: string): Promise<number> {
  try {
    return (await fsp.stat(path)).size;
  } catch {
    return 0;
  }
}

export async function dirSize(path: string): Promise<number> {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(path, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += await fileSize(p);
  }
  return total;
}
