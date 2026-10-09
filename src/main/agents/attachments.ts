import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { ATTACHMENTS_DIR, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, attachmentProblem, safeFileName, sniffAttachment, type Attachment, type AttachResult, type TurnAttachment } from "../../shared/agents/attachments";

/**
 * The files a chat message carries (src/shared/agents/attachments.ts), on main's side: bytes from the view (a drop, a
 * paste) or files the user picked in main's dialog or copied in Finder are checked by their bytes and copied into the
 * chat's own folder (`<chat>/attachments/<id>-<name>`, mode 0600) — the only place they are written; a turn's
 * attachments must be files in that folder. Electron-free (the thumbnail is passed in): tested on a temporary folder.
 */

export interface AttachFs {
  mkdir(p: string): void;
  write(p: string, bytes: Uint8Array): void;
  realpath(p: string): string;
  size(p: string): number;
  read(p: string): Uint8Array;
  /** The file's first bytes (its type) */
  head(p: string): Uint8Array;
}

function head(p: string): Uint8Array {
  const fd = openSync(p, "r");
  try {
    const b = new Uint8Array(16);
    const n = readSync(fd, b, 0, 16, 0);
    return b.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export const nodeAttachFs: AttachFs = {
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  write: (p, b) => writeFileSync(p, b, { mode: 0o600 }),
  realpath: (p) => realpathSync(p),
  size: (p) => statSync(p).size,
  read: (p) => readFileSync(p),
  head,
};

export interface SaveOptions {
  fs?: AttachFs;
  /** A small picture of the copy (a data: URL), when one can be made */
  thumb?: (path: string, mime: string, bytes: Uint8Array) => Promise<string | undefined>;
  id?: () => string;
}

export const attachmentsDirOf = (chatDir: string) => join(chatDir, ATTACHMENTS_DIR);

/** Files into the chat's attachments folder: each checked (type by its bytes, size), at most MAX_ATTACHMENTS. */
export async function saveAttachments(chatDir: string, files: { name: string; bytes: Uint8Array }[], o: SaveOptions = {}): Promise<AttachResult> {
  const fs = o.fs ?? nodeAttachFs;
  const dir = attachmentsDirOf(chatDir);
  const errors: string[] = [];
  const attachments: Attachment[] = [];
  for (const f of files) {
    const name = String(f.name || "file").slice(0, 200);
    if (attachments.length >= MAX_ATTACHMENTS) {
      errors.push(`Up to ${MAX_ATTACHMENTS} files a message`);
      break;
    }
    const problem = attachmentProblem(name, f.bytes);
    if (problem) {
      errors.push(problem);
      continue;
    }
    const mime = sniffAttachment(f.bytes)!;
    const id = (o.id ?? (() => randomUUID().replace(/-/g, "").slice(0, 8)))();
    fs.mkdir(dir);
    const path = join(dir, `${id}-${safeFileName(name, mime)}`);
    fs.write(path, f.bytes);
    const thumb = await o.thumb?.(path, mime, f.bytes).catch(() => undefined);
    attachments.push({ id, name: basename(name), mime, size: f.bytes.length, path, ...(thumb ? { thumb } : {}) });
  }
  return { attachments, errors };
}

/** Files the user chose (main's dialog, Finder's clipboard) read for saveAttachments; the too large ones not read. */
export function readFiles(paths: string[], fs: AttachFs = nodeAttachFs): { files: { name: string; bytes: Uint8Array }[]; errors: string[] } {
  const files: { name: string; bytes: Uint8Array }[] = [];
  const errors: string[] = [];
  for (const p of paths.slice(0, MAX_ATTACHMENTS + 1)) {
    const name = basename(p);
    try {
      if (fs.size(p) > MAX_ATTACHMENT_BYTES) {
        errors.push(`“${name}” is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
        continue;
      }
      files.push({ name, bytes: fs.read(p) });
    } catch {
      errors.push(`“${name}” couldn’t be read`);
    }
  }
  return { files, errors };
}

/**
 * A turn's attachments as the view sent them, kept only when each is a file in the chat's attachments folder (after
 * symlinks) — a view can't point an agent at any other file.
 */
export function turnAttachments(chatDir: string, list: unknown, fs: AttachFs = nodeAttachFs): TurnAttachment[] {
  if (!Array.isArray(list)) return [];
  let base: string;
  try {
    base = fs.realpath(attachmentsDirOf(chatDir));
  } catch {
    return [];
  }
  return list.slice(0, MAX_ATTACHMENTS).flatMap((a): TurnAttachment[] => {
    const path = typeof a?.path === "string" ? a.path : "";
    if (!path || !isAbsolute(path)) return [];
    let real: string;
    try {
      real = fs.realpath(path);
    } catch {
      return [];
    }
    const rel = relative(base, real);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return [];
    let mime: ReturnType<typeof sniffAttachment> = null;
    try {
      mime = sniffAttachment(fs.head(real));
    } catch {
      /* gone */
    }
    if (!mime) return [];
    return [{ path: real, name: String(a?.name ?? basename(real)).slice(0, 200), mime }];
  });
}

/**
 * The files on the system clipboard as macOS puts them there when files are copied in Finder: the list of paths
 * (`NSFilenamesPboardType`, a property list of strings) or one file URL (`public.file-url`).
 */
export function clipboardPaths(formats: { filenames?: string; fileUrl?: string }): string[] {
  const fromList = [...(formats.filenames ?? "").matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
  if (fromList.length) return fromList.filter((p) => isAbsolute(p));
  const url = (formats.fileUrl ?? "").trim();
  if (!url.startsWith("file://")) return [];
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    return isAbsolute(path) ? [path] : [];
  } catch {
    return [];
  }
}
