import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { ToolFile } from "../../shared/agents/tools";

/**
 * Files a tool made in the editor view (export_animation, docs/motion.md §9) saved here in main — the view can't write
 * files: into the chat's own working folder (where the agent reads and writes its files), or Downloads for an outside
 * MCP client. A name is the file's own (no folders), made unique ("Frame (2).gif") rather than overwriting.
 */

export interface ToolFilesFs {
  exists(p: string): boolean;
  mkdir(p: string): void;
  write(p: string, bytes: Uint8Array): void;
}

export const nodeToolFilesFs: ToolFilesFs = { exists: (p) => existsSync(p), mkdir: (p) => void mkdirSync(p, { recursive: true }), write: (p, b) => writeFileSync(p, b) };

/** The largest file saved (as export_animation's limit). */
export const MAX_TOOL_FILE_BYTES = 200 * 1024 * 1024;

/** A file name with nothing that names a folder or the OS can't hold. */
export function safeFileName(name: string): string {
  const base = [...basename(name.replace(/\\/g, "/"))].map((c) => (c.charCodeAt(0) < 0x20 || '<>:"|?*'.includes(c) ? "_" : c)).join("").replace(/^\.+/, "").trim();
  return base.slice(0, 180) || "Export";
}

/** Saves each file in `dir`; returns their paths (a file too large or not base64 is skipped). */
export function saveToolFiles(dir: string, files: readonly ToolFile[], fs: ToolFilesFs = nodeToolFilesFs): string[] {
  const out: string[] = [];
  for (const f of files.slice(0, 10)) {
    if (typeof f?.name !== "string" || typeof f.data !== "string") continue;
    const bytes = Buffer.from(f.data, "base64");
    if (!bytes.length || bytes.length > MAX_TOOL_FILE_BYTES) continue;
    const name = safeFileName(f.name);
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    fs.mkdir(dir);
    let path = join(dir, name);
    for (let i = 2; fs.exists(path) && i < 1000; i++) path = join(dir, `${stem} (${i})${ext}`);
    fs.write(path, bytes);
    out.push(path);
  }
  return out;
}
