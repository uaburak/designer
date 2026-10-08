/**
 * Where exported files go (Export…, the Design panel's Export section): Figma
 * names a file after its layer plus the setting's suffix ("HomePage" +
 * "@2x" → "HomePage@2x.png"), and a layer name with slashes makes folders
 * ("button/pill/default" → button/pill/default.png). Names are made safe for
 * a file system and kept apart Finder-style ("Frame 1 2.png") when two files
 * — or a file already in the folder — would share one.
 */

/** One name's path parts, each safe for macOS, Windows and Linux; empty parts and "."/".." dropped. */
export function safeParts(name: string): string[] {
  const parts = name
    .split("/")
    // eslint-disable-next-line no-control-regex
    .map((p) => p.replace(/[\\:*?"<>|\u0000-\u001f]/g, "-").trim())
    .filter((p) => p && p !== "." && p !== "..")
    .map((p) => (p.startsWith(".") ? `-${p.slice(1)}` : p).slice(0, 200));
  return parts.length ? parts : ["Untitled"];
}

/** "a.png" → ["a", ".png"]; no extension → [name, ""]. */
function splitExt(file: string): [string, string] {
  const dot = file.lastIndexOf(".");
  return dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ""];
}

/**
 * The relative paths ("/"-separated) for `names`, in order: safe, and unique among themselves and against `taken`
 * (paths already there, compared without case as macOS and Windows do).
 */
export function planExportPaths(names: readonly string[], taken: (path: string) => boolean = () => false): string[] {
  const used = new Set<string>();
  const free = (p: string) => !used.has(p.toLowerCase()) && !taken(p);
  return names.map((name) => {
    const parts = safeParts(name);
    const dir = parts.slice(0, -1).join("/");
    const [base, ext] = splitExt(parts[parts.length - 1]);
    const at = (file: string) => (dir ? `${dir}/${file}` : file);
    let path = at(base + ext);
    for (let n = 2; !free(path); n++) path = at(`${base} ${n}${ext}`);
    used.add(path.toLowerCase());
    return path;
  });
}

/** The media type of an exported file by its extension. */
export function exportMime(name: string): string {
  const ext = splitExt(name)[1].toLowerCase();
  return ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".svg" ? "image/svg+xml" : ext === ".pdf" ? "application/pdf" : "application/octet-stream";
}
