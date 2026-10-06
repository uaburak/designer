/**
 * Save Local Copy (docs/data.md §11.2): flush, compact, then a ZIP of stored entries — canvas.fig (the head snapshot
 * bytes as they are), meta.json, thumbnail.png, images/<sha1> — written to a temporary file and renamed onto `path`.
 * Version history, UI state and the library registry are not included, as in Figma.
 */
import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";
import { writeFigFile, type FigMeta } from "../../shared/fig/figFile";
import type { FileMeta } from "../../shared/store/types";
import type { LocalBlobs } from "../local/blobs";
import { fsyncDir } from "../local/fsutil";
import { currentMessage, readSnapshotFile } from "../local/snapshot";

export async function writeLocalCopy(input: {
  snapshotPath: string;
  meta: FileMeta;
  thumbnailPath: string;
  blobRefs: string[];
  blobs: LocalBlobs;
  tmpDir: string;
  path: string;
  now: number;
}): Promise<{ bytes: number; images: number }> {
  const canvas = new Uint8Array(await fsp.readFile(input.snapshotPath));
  const snap = await readSnapshotFile(input.snapshotPath);
  const message = currentMessage(snap);
  // meta.json's background colour is the first page's.
  const pages = (message.nodeChanges ?? []).filter((n) => n.type === "CANVAS" && !n.internalOnly && n.parentIndex?.guid?.sessionID === 0 && n.parentIndex.guid.localID === 0);
  pages.sort((a, b) => ((a.parentIndex?.position ?? "") < (b.parentIndex?.position ?? "") ? -1 : 1));
  const bg = pages[0]?.backgroundColor ?? { r: 0.9607843160629272, g: 0.9607843160629272, b: 0.9607843160629272, a: 1 };
  const thumbnail = await fsp.readFile(input.thumbnailPath).then((b) => new Uint8Array(b)).catch(() => null);
  const meta: FigMeta = {
    client_meta: {
      background_color: { r: bg.r, g: bg.g, b: bg.b, a: bg.a },
      thumbnail_size: { width: input.meta.thumbnail?.width ?? 0, height: input.meta.thumbnail?.height ?? 0 },
      render_coordinates: { x: 0, y: 0, width: input.meta.thumbnail?.width ?? 0, height: input.meta.thumbnail?.height ?? 0 },
    },
    file_name: input.meta.name,
    exported_at: new Date(input.now).toISOString(),
  };
  const images: [string, Uint8Array][] = [];
  for (const sha1 of [...input.blobRefs].sort()) {
    try {
      images.push([sha1, await input.blobs.get(sha1)]);
    } catch {
      /* a referenced image that is not in the blob store: the paint shows as missing, as in Figma */
    }
  }
  const zip = writeFigFile({ canvas, meta, thumbnail, images }, { date: new Date(input.now) });
  await writeFileAtomically(input.tmpDir, input.path, zip);
  return { bytes: zip.length, images: images.length };
}

/** Writes through the workspace's tmp/ when it is on the same volume as `path`, else next to `path`. */
async function writeFileAtomically(tmpDir: string, path: string, data: Uint8Array): Promise<void> {
  const name = `.${randomBytes(6).toString("hex")}.tmp`;
  for (const dir of [tmpDir, dirname(path)]) {
    const tmp = join(dir, name);
    const fh = await fsp.open(tmp, "w", 0o644);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await fsp.rename(tmp, path);
      await fsyncDir(dirname(path));
      return;
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    }
  }
}
