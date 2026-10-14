import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DevelopmentPlugin } from "../../shared/ipc";
import type { PluginBundle, PluginManifest } from "../../shared/plugins/types";
import { parseManifest } from "../../shared/plugins/manifest";
import { t } from "../../shared/i18n";

/**
 * Development plugins (docs/plugins.md §3.3): "Import new plugin from manifest…" keeps `{path, id, name, addedAt}`
 * in `userData/plugins/development.json`; `read` reads a plugin's manifest, `main` and `ui` from its folder — paths
 * inside the folder only, after symlinks, ≤ 20 MB each. The manifest's `build` is never run. Views never read files.
 */

export const MAX_PLUGIN_FILE_BYTES = 20 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

export class PluginFileError extends Error {}

/** The id a development plugin goes by: its manifest's, else `dev:<sha1(path)>` (§4). */
export const developmentId = (manifest: PluginManifest, manifestPath: string) => manifest.id || `dev:${createHash("sha1").update(manifestPath).digest("hex")}`;

/** A file the manifest names, resolved inside `dir` after symlinks; refused outside it. */
export async function insideFolder(dir: string, rel: string): Promise<string> {
  if (isAbsolute(rel) || rel.includes("\0")) throw new PluginFileError(t("“{file}” isn’t inside the plugin’s folder", { file: rel }));
  const root = await realpath(dir);
  let file: string;
  try {
    file = await realpath(resolve(root, rel));
  } catch {
    throw new PluginFileError(t("Couldn’t find “{file}” in the plugin’s folder", { file: rel }));
  }
  const r = relative(root, file);
  if (!r || r.startsWith("..") || isAbsolute(r) || r.split(sep).includes("..")) throw new PluginFileError(t("“{file}” isn’t inside the plugin’s folder", { file: rel }));
  return file;
}

/** A text file of at most `max` bytes (read through one handle, so a file that grows meanwhile is still capped). */
export async function readCapped(file: string, max = MAX_PLUGIN_FILE_BYTES): Promise<string> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    if (size > max) throw new PluginFileError(t("“{file}” is larger than {mb} MB", { file, mb: Math.round(max / 1024 / 1024) }));
    const buf = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buf, 0, size, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** The manifest at `manifestPath`, parsed and checked (throws with Figma-like messages). */
export async function loadManifest(manifestPath: string): Promise<{ manifest: PluginManifest; warnings: string[] }> {
  let text: string;
  try {
    text = await readCapped(manifestPath, MAX_MANIFEST_BYTES);
  } catch (err) {
    if (err instanceof PluginFileError) throw err;
    throw new PluginFileError(t("Couldn’t read {path}", { path: manifestPath }));
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PluginFileError(t("The manifest isn’t valid JSON"));
  }
  const r = parseManifest(json, { development: true });
  if ("errors" in r) throw new PluginFileError(`${t("The manifest has errors:")}\n${r.errors.join("\n")}`);
  const manifest = { ...r.manifest, id: developmentId(r.manifest, manifestPath) };
  return { manifest, warnings: r.warnings };
}

/** The plugin's code and UI documents from its folder. */
export async function readBundle(manifestPath: string): Promise<PluginBundle> {
  const { manifest } = await loadManifest(manifestPath);
  const dir = dirname(manifestPath);
  const code = await readCapped(await insideFolder(dir, manifest.main));
  const ui: Record<string, string> = {};
  if (typeof manifest.ui === "string") ui[""] = await readCapped(await insideFolder(dir, manifest.ui));
  else if (manifest.ui) for (const [key, rel] of Object.entries(manifest.ui)) ui[key] = await readCapped(await insideFolder(dir, rel));
  return { manifest, code, ui };
}

/** The files a plugin's hot reload watches (relative to its folder): `main` and the `ui` files. */
export function watchedFiles(manifest: PluginManifest): string[] {
  const ui = typeof manifest.ui === "string" ? [manifest.ui] : manifest.ui ? Object.values(manifest.ui) : [];
  return ["manifest.json", manifest.main, ...ui].map((p) => p.replace(/^\.\//, ""));
}

const isEntry = (v: unknown): v is DevelopmentPlugin => {
  const e = v as DevelopmentPlugin;
  return !!e && typeof e.path === "string" && typeof e.id === "string" && typeof e.name === "string" && typeof e.addedAt === "number";
};

/** The list in `<dir>/development.json`, written atomically (temp + rename). */
export class DevelopmentPlugins {
  private cache: DevelopmentPlugin[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private get file() {
    return join(this.dir, "development.json");
  }

  async list(): Promise<DevelopmentPlugin[]> {
    if (this.cache) return [...this.cache];
    try {
      const json = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      this.cache = Array.isArray(json) ? json.filter(isEntry) : [];
    } catch {
      this.cache = [];
    }
    return [...this.cache];
  }

  get(id: string): Promise<DevelopmentPlugin | undefined> {
    return this.list().then((l) => l.find((p) => p.id === id));
  }

  private save(list: DevelopmentPlugin[]): Promise<DevelopmentPlugin[]> {
    this.cache = list;
    const write = this.queue.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(list, null, 2));
      await rename(tmp, this.file);
    });
    this.queue = write.catch(() => undefined);
    return write.then(() => [...list]);
  }

  /** Imports (or re-imports) the manifest at `manifestPath`. A plugin with the same id is replaced (one id, one plugin). */
  async add(manifestPath: string, now = Date.now()): Promise<{ plugin: DevelopmentPlugin; manifest: PluginManifest; warnings: string[] }> {
    const path = resolve(manifestPath);
    const { manifest, warnings } = await loadManifest(path);
    // The files it names must be there now (Figma checks on import too).
    await readBundle(path);
    const list = await this.list();
    const old = list.find((p) => p.id === manifest.id || p.path === path);
    const plugin: DevelopmentPlugin = { path, id: manifest.id, name: manifest.name, addedAt: old?.addedAt ?? now };
    await this.save([plugin, ...list.filter((p) => p !== old && p.id !== manifest.id && p.path !== path)]);
    return { plugin, manifest, warnings };
  }

  async remove(id: string): Promise<DevelopmentPlugin[]> {
    const list = await this.list();
    return this.save(list.filter((p) => p.id !== id));
  }

  /** A listed plugin's bundle; its name is refreshed when the manifest's changed. */
  async read(id: string): Promise<PluginBundle> {
    const entry = await this.get(id);
    if (!entry) throw new PluginFileError(t("This development plugin isn’t imported"));
    const bundle = await readBundle(entry.path);
    if (bundle.manifest.name !== entry.name) {
      const list = await this.list();
      void this.save(list.map((p) => (p.id === id ? { ...p, name: bundle.manifest.name } : p)));
    }
    // A manifest whose id changed since the import keeps the listed id: the list and the run agree.
    return { ...bundle, manifest: { ...bundle.manifest, id } };
  }
}
