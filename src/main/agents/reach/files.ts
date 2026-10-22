import { lstat, open, readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { REACH_LIMITS, untrustedResult } from "../../../shared/agents/reach";
import type { ToolResult } from "../../../shared/agents/tools";
import type { ReachRunner, RunContext } from "./hub";
import { isDeniedPath, resolveGrantedPath } from "./paths";

/**
 * Local files (docs/agents-reach.md §10): read-only, inside the folders the owner granted. Every path goes through
 * `resolveGrantedPath` (realpath, inside a grant, not on the deny list); walks don't follow symlinks and leave out what
 * is denied, so a listing never shows a secret's name. Async fs only, so a big folder never stalls main. Electron-free.
 */

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/** Folders listed but not entered (and not searched): dependencies, builds, caches */
const HEAVY = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", "coverage", "vendor", "Pods", "DerivedData", ".venv", "venv", "__pycache__", "target"]);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|icns|pdf|zip|gz|tgz|bz2|xz|7z|rar|dmg|pkg|exe|dll|so|dylib|a|o|class|jar|wasm|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|webm|wav|ogg|psd|ai|sketch|fig|sqlite|db|bin)$/i;

const error = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

async function isBinary(path: string, size: number): Promise<boolean> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(8000, size));
    await fh.read(buf, 0, buf.length, 0);
    return buf.includes(0);
  } finally {
    await fh.close();
  }
}

async function listFiles(args: Record<string, unknown>, ctx: RunContext): Promise<ToolResult> {
  const grants = ctx.settings.files.folders;
  if (!grants.length) return error("No folder is granted. The owner can add one in Agent settings › Access › Local files.");
  if (args.path === undefined || args.path === null || args.path === "") return untrustedResult("files:granted", `Granted folders:\n${grants.map((g) => `${g}/`).join("\n")}`);
  const r = resolveGrantedPath(String(args.path), grants);
  if (!r.ok) return error(r.reason);
  const s = await stat(r.real);
  if (!s.isDirectory()) return untrustedResult(`files:${r.real}`, `${r.real}  ${s.size} B (a file: read_file reads it)`);
  const depth = Math.min(REACH_LIMITS.files.depth, Math.max(1, Math.round(Number(args.depth) || 1)));
  const lines: string[] = [];
  let more = 0;
  const walk = async (dir: string, level: number) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (ctx.signal.aborted) return;
      const full = join(dir, e.name);
      if (isDeniedPath(full)) continue;
      if (lines.length >= REACH_LIMITS.files.listEntries) {
        more++;
        continue;
      }
      const rel = relative(r.real, full);
      if (e.isSymbolicLink()) lines.push(`${rel} → (a link, not followed)`);
      else if (e.isDirectory()) {
        lines.push(`${rel}/${HEAVY.has(e.name) ? " (not entered)" : ""}`);
        if (level < depth && !HEAVY.has(e.name)) await walk(full, level + 1);
      } else if (e.isFile()) {
        const size = (await lstat(full).catch(() => null))?.size ?? 0;
        lines.push(`${rel}  ${size} B`);
      }
    }
  };
  await walk(r.real, 1);
  return untrustedResult(`files:${r.real}`, [`${r.real}/`, ...lines, ...(more ? [`[${more} more entries: list a sub-folder]`] : [])].join("\n"));
}

async function readFile(args: Record<string, unknown>, ctx: RunContext): Promise<ToolResult> {
  const r = resolveGrantedPath(String(args.path ?? ""), ctx.settings.files.folders);
  if (!r.ok) return error(r.reason);
  const s = await stat(r.real);
  if (s.isDirectory()) return error(`${r.real} is a folder: list_local_files lists it.`);
  if (!s.isFile()) return error(`${r.real} isn't a regular file.`);
  if (s.size > REACH_LIMITS.files.fileBytes) return error(`${r.real} is ${Math.round(s.size / 1024 / 1024)} MB: too large to read.`);
  const ext = /\.([a-z0-9]+)$/i.exec(r.real)?.[1]?.toLowerCase() ?? "";
  const fh = await open(r.real, "r");
  let bytes: Buffer;
  try {
    bytes = Buffer.alloc(s.size);
    await fh.read(bytes, 0, s.size, 0);
  } finally {
    await fh.close();
  }
  if (IMAGE_TYPES[ext]) {
    if (s.size > 4 * 1024 * 1024) return error(`${r.real} is a picture larger than 4 MB.`);
    return { content: [{ type: "text", text: `${r.real} (${s.size} B)` }, { type: "image", data: bytes.toString("base64"), mimeType: IMAGE_TYPES[ext] }] };
  }
  if (bytes.subarray(0, 8000).includes(0)) return error(`${r.real} is a binary file (${s.size} B): it can't be read as text.`);
  const text = bytes.toString("utf8");
  const offset = Math.max(0, Math.min(text.length, Math.round(Number(args.offset) || 0)));
  const end = Math.min(text.length, offset + REACH_LIMITS.text);
  const head = `${r.real} (${s.size} B)${offset || end < text.length ? `, characters ${offset}–${end} of ${text.length}${end < text.length ? ` — read on with offset ${end}` : ""}` : ""}`;
  return untrustedResult(`files:${r.real}`, `${head}\n${text.slice(offset, end)}`);
}

async function searchFiles(args: Record<string, unknown>, ctx: RunContext): Promise<ToolResult> {
  const grants = ctx.settings.files.folders;
  const query = String(args.query ?? "").trim().slice(0, 200);
  if (!query) return error("query: the text to look for.");
  let roots = grants;
  if (typeof args.path === "string" && args.path.trim()) {
    const r = resolveGrantedPath(args.path, grants);
    if (!r.ok) return error(r.reason);
    roots = [r.real];
  }
  if (!roots.length) return error("No folder is granted. The owner can add one in Agent settings › Access › Local files.");
  const q = query.toLowerCase();
  const out: string[] = [];
  const L = REACH_LIMITS.files;
  const until = Date.now() + 8000;
  let files = 0;
  let stopped = "";
  const full = () => out.length >= L.searchMatches;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (full() || ctx.signal.aborted) return;
      if (Date.now() > until) return void (stopped ||= "it took too long");
      const path = join(dir, e.name);
      if (isDeniedPath(path) || e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!HEAVY.has(e.name)) await walk(path);
        continue;
      }
      if (!e.isFile()) continue;
      if (++files > L.searchFiles) return void (stopped ||= `${L.searchFiles} files were looked at`);
      if (e.name.toLowerCase().includes(q)) out.push(`${path}  (name)`);
      if (BINARY_EXT.test(e.name)) continue;
      const s = await stat(path).catch(() => null);
      if (!s || s.size > L.searchFileBytes || s.size === 0 || (await isBinary(path, s.size).catch(() => true))) continue;
      const fh = await open(path, "r").catch(() => null);
      if (!fh) continue;
      try {
        const buf = Buffer.alloc(s.size);
        await fh.read(buf, 0, s.size, 0);
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length && !full(); i++) if (lines[i].toLowerCase().includes(q)) out.push(`${path}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
      } finally {
        await fh.close();
      }
    }
  };
  for (const root of roots) if (!full()) await walk(root);
  const notes = [full() ? `[stopped at ${L.searchMatches} matches]` : "", stopped ? `[stopped: ${stopped} — search a sub-folder with path]` : ""].filter(Boolean);
  return untrustedResult(`files:search ${basename(roots[0])}`, [`Matches for “${query}”:`, ...(out.length ? out : ["(none)"]), ...notes].join("\n"));
}

export const filesRunner = (): ReachRunner => async (tool, args, ctx) => {
  try {
    if (tool === "list_local_files") return await listFiles(args, ctx);
    if (tool === "read_file") return await readFile(args, ctx);
    if (tool === "search_files") return await searchFiles(args, ctx);
    return error(`Unknown tool: ${tool}`);
  } catch (err) {
    // Never the OS's own message (it can name paths outside the grant): one sentence.
    return error(`The file couldn't be read${(err as NodeJS.ErrnoException)?.code ? ` (${(err as NodeJS.ErrnoException).code})` : ""}.`);
  }
};
