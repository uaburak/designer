import { app, dialog, webContents, type BaseWindow } from "electron";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DevelopmentPlugin, IpcInvoke } from "../../shared/ipc";
import type { PluginBundle, PluginManifest } from "../../shared/plugins/types";
import { emit } from "../tabs";
import { allViews } from "../views";
import { mainFetch } from "../net";
import { pluginFetch } from "./fetch";
import { DevelopmentPlugins, loadManifest, watchedFiles } from "./manifests";
import { pluginRuns } from "./runs";
import { ClientStorage } from "./storage";
import { TEMPLATE_EDITOR, TEMPLATE_IDS, templateFiles, type TemplateId } from "./templates";
import { PluginWatcher } from "./watch";

/**
 * Main's side of plugins (docs/plugins.md §3.3), behind the `plugins:*` channels (src/main/ipc.ts): development
 * plugins in `userData/plugins/development.json`, their hot reload, the runs' fetch and clientStorage, New plugin….
 */

const dir = () => join(app.getPath("userData"), "plugins");

let dev: DevelopmentPlugins | null = null;
let storage: ClientStorage | null = null;
let watcher: PluginWatcher | null = null;

const development = () => (dev ??= new DevelopmentPlugins(dir()));
export const clientStorage = () => (storage ??= new ClientStorage(join(dir(), "storage")));

/** `plugins:changed {id}` to every editor view */
function changed(id: string) {
  for (const [wcId, info] of allViews()) {
    if (info.role !== "editor") continue;
    const wc = webContents.fromId(wcId);
    if (wc && !wc.isDestroyed()) emit(wc, "plugins:changed", { id });
  }
}

/** Keeps the hot reload's watches to the listed plugins (a plugin whose manifest can't be read: its manifest only). */
async function syncWatches(list: DevelopmentPlugin[]) {
  watcher ??= new PluginWatcher(changed);
  const entries = await Promise.all(
    list.map(async (p) => {
      const files = await loadManifest(p.path).then(({ manifest }) => watchedFiles(manifest), () => ["manifest.json"]);
      return { id: p.id, path: p.path, files };
    }),
  );
  watcher.sync(entries);
}

export async function listDevelopment(): Promise<DevelopmentPlugin[]> {
  const list = await development().list();
  void syncWatches(list);
  return list;
}

async function addDevelopment(manifestPath: string): Promise<{ plugin: DevelopmentPlugin; manifest: PluginManifest }> {
  const { plugin, manifest, warnings } = await development().add(manifestPath);
  for (const w of warnings) console.warn(`[plugins] ${manifest.name}: ${w}`);
  void syncWatches(await development().list());
  return { plugin, manifest };
}

/** "Import new plugin from manifest…" */
export async function importManifest(win: BaseWindow): Promise<IpcInvoke["plugins:import-manifest"]["result"]> {
  const r = await dialog.showOpenDialog(win, { title: "Import new plugin from manifest", buttonLabel: "Open", properties: ["openFile"], filters: [{ name: "Plugin manifest", extensions: ["json"] }] });
  if (r.canceled || !r.filePaths[0]) return { cancelled: true };
  return addDevelopment(r.filePaths[0]);
}

export async function removeDevelopment(id: string): Promise<DevelopmentPlugin[]> {
  const list = await development().remove(id);
  void syncWatches(list);
  return list;
}

export const readDevelopment = (id: string): Promise<PluginBundle> => development().read(id);

/** New plugin…: the template's files in a new folder the person names, then imported. */
export async function newPlugin(win: BaseWindow, input: { name: unknown; template: unknown }): Promise<IpcInvoke["plugins:new-plugin"]["result"]> {
  const name = typeof input?.name === "string" ? input.name.trim().slice(0, 100) : "";
  if (!name) throw new Error("plugins:new-plugin: a name");
  if (!TEMPLATE_IDS.includes(input.template as TemplateId)) throw new Error("plugins:new-plugin: an unknown template");
  const template = input.template as TemplateId;
  const r = await dialog.showSaveDialog(win, { title: "Save plugin as", buttonLabel: "Save", defaultPath: join(app.getPath("documents"), name.replace(/[/\\:*?"<>|]/g, "-")), properties: ["createDirectory", "showOverwriteConfirmation"] });
  if (r.canceled || !r.filePath) return { cancelled: true };
  const folder = r.filePath;
  // A new folder, or an empty one: nothing of the person's is overwritten.
  const existing = await stat(folder).catch(() => null);
  if (existing && (!existing.isDirectory() || (await readdir(folder)).some((f) => f !== ".DS_Store"))) throw new Error(`"${basename(folder)}" already exists and isn't an empty folder`);
  await mkdir(folder, { recursive: true });
  for (const [file, text] of Object.entries(templateFiles(template, name))) await writeFile(join(folder, file), text, { flag: "wx" });
  return { ...(await addDevelopment(join(folder, "manifest.json"))), editorType: TEMPLATE_EDITOR[template] };
}

/** `fetch` from a run's code: its own view's run only */
export function fetchForRun(owner: number, p: IpcInvoke["plugins:fetch"]["args"][0]) {
  const run = pluginRuns.ownedBy(owner, p?.runId);
  return pluginFetch(run.domains, p?.url, p?.init, mainFetch);
}

/** Tests and quitting */
export function closePlugins() {
  watcher?.close();
  watcher = null;
}
