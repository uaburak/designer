/**
 * Settings › Account › "Your uploaded fonts" (docs/desktop.md §14.2): "Upload fonts for your personal use. These fonts
 * will be available across the files you view or edit." Main's Open dialog picks TTF / OTF / TTC / OTC files; each is
 * parsed (no face: refused), copied into `userData/fonts/uploaded` under its content hash (the same file twice is one
 * file) and scanned with the user's fonts (fonts.ts), so every file's font picker lists it after the watcher's rescan
 * (`fonts:changed`). Views never see paths: a face's id, its family and style, the file's name.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { copyFile, readdir, readFile, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { app, dialog, type BaseWindow } from "electron";
import type { FontFaceInfo, UploadedFont } from "../shared/ipc";
import { parseFile, registerFaces, setUploadedFontsDir } from "./fonts";
import { t } from "../shared/i18n";

const EXT = /\.(ttf|otf|ttc|otc)$/i;
/** Figma's limit for a font file is unpublished; a font past 50 MB is surely not one */
const MAX_BYTES = 50 * 1024 * 1024;

let root: string | null = null;
const dir = () => (root ??= join(app.getPath("userData"), "fonts", "uploaded"));

/** At launch, before the font index is built: the folder exists (so it is watched) and is scanned with the user's fonts. */
export function initUploadedFonts(): void {
  mkdirSync(dir(), { recursive: true });
  setUploadedFontsDir(dir());
}

const toRow = (f: FontFaceInfo, file: string): UploadedFont => ({ id: f.id, family: f.family, style: f.style, weight: f.weight, italic: f.italic, file });

/** Every face of every uploaded file, by family then weight (Figma's list: "Matter / Bold", "Matter / Bold Italic"…). */
export async function uploadedFonts(folder = dir()): Promise<UploadedFont[]> {
  let names: string[] = [];
  try {
    names = (await readdir(folder)).filter((n) => EXT.test(n));
  } catch {
    return [];
  }
  const rows: UploadedFont[] = [];
  for (const name of names) {
    const path = join(folder, name);
    try {
      const faces = await parseFile(path, "user");
      registerFaces(path, faces);
      // A variable font's named instances share one file: each is a row, as each is a style in the picker.
      for (const f of faces) rows.push(toRow(f, name));
    } catch {
      // unreadable: left out
    }
  }
  return rows.sort((a, b) => a.family.localeCompare(b.family) || a.weight - b.weight || Number(a.italic) - Number(b.italic) || a.style.localeCompare(b.style));
}

/** Copies font files in: each kept under `<family>-<sha1 8>.<ext>` when it holds at least one face. */
export async function addFontFiles(paths: string[], folder = dir()): Promise<{ added: number; failed: string[] }> {
  mkdirSync(folder, { recursive: true });
  const failed: string[] = [];
  let added = 0;
  for (const p of paths) {
    const name = basename(p);
    try {
      if (!EXT.test(p)) throw new Error("not a font file");
      const bytes = await readFile(p);
      if (bytes.length > MAX_BYTES) throw new Error("too large");
      const faces = await parseFile(p, "user");
      if (!faces.length) throw new Error("no font in it");
      const safe = faces[0].family.replace(/[^A-Za-z0-9 _-]/g, "").trim().replace(/\s+/g, "-") || "font";
      const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 8);
      const dest = join(folder, `${safe}-${hash}${extname(p).toLowerCase()}`);
      await copyFile(p, dest);
      added++;
    } catch {
      failed.push(name);
    }
  }
  return { added, failed };
}

/** The Upload font button: main's Open dialog, then the files copied in. */
export async function uploadFonts(win: BaseWindow): Promise<{ fonts: UploadedFont[]; failed: string[] } | { cancelled: true }> {
  const r = await dialog.showOpenDialog(win, { title: t("Upload font"), buttonLabel: t("Upload"), properties: ["openFile", "multiSelections"], filters: [{ name: t("Fonts"), extensions: ["ttf", "otf", "ttc", "otc"] }] });
  if (r.canceled || !r.filePaths.length) return { cancelled: true };
  const { failed } = await addFontFiles(r.filePaths);
  return { fonts: await uploadedFonts(), failed };
}

/** The trash button: the file holding that face goes (a collection's other faces with it). */
export async function removeUploadedFont(id: string, folder = dir()): Promise<UploadedFont[]> {
  const row = (await uploadedFonts(folder)).find((f) => f.id === id);
  if (row && EXT.test(row.file) && basename(row.file) === row.file) await rm(join(folder, row.file), { force: true });
  return uploadedFonts(folder);
}
