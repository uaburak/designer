/**
 * The editor's plugins (docs/plugins.md §6): which plugins this person can run here — development plugins (main's
 * list, 5e), the org's private plugins (the store, 5g), saved and recent ones — and running them: approval checked
 * through `store.plugins.allowed`, the bundle read (main for development plugins, the store for private ones), a
 * PluginRun started, "Run last plugin", Hot reload, "Use developer VM". One per editor (`attachPlugins`, EditorApp);
 * menus, Actions and the Tools tab read it with `pluginsOf(ed)`.
 */
import { useSyncExternalStore } from "react";
import { showToast } from "@/ds";
import { t } from "@/i18n";
import type { DevelopmentPlugin } from "@shared/ipc";
import { notRunnableReason, parseManifest, runnableIn } from "@shared/plugins/manifest";
import type { PluginBundle, PluginManifest, PluginMenuItem, PluginRef, PluginsRepository, PrivatePlugin } from "@shared/plugins/types";
import type { EditorController } from "../controller";
import { pluginDesktop, type PluginDesktop } from "./desktop";
import { PluginRun, type RunEnv, type RunSpec } from "./host";
import { PluginUiStore } from "./ui/store";

/** A plugin the person can run here, with its manifest when known. */
export interface PluginEntry {
  ref: PluginRef;
  manifest: PluginManifest | null;
  /** Why it can't run here (an editor type, a widget, a broken manifest), or null */
  disabled: string | null;
}

export interface PluginsSnapshot {
  development: PluginEntry[];
  organization: PluginEntry[];
  orgName: string | null;
  saved: PluginRef[];
  recents: PluginRef[];
  running: { runId: string; ref: PluginRef }[];
  last: { ref: PluginRef; command: string } | null;
  hotReload: boolean;
  developerVm: boolean;
  /** "Create a plugin" is open (New plugin…) */
  creating: boolean;
}

const LOCAL_KEY = "designer.plugins.local";
const PREFS_KEY = "designer.plugins.prefs";
const RECENTS_MAX = 10;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode: kept for this view only.
  }
}

const sameRef = (a: PluginRef, b: PluginRef) => a.id === b.id && a.source.type === b.source.type;

export interface PluginServiceOptions {
  desktop?: PluginDesktop | null;
  store?: Pick<PluginsRepository, "local" | "setSaved" | "ranRecently" | "listPrivate" | "bundle" | "allowed"> | null;
  /** RunEnv extras (tests) */
  env?: Partial<RunEnv>;
}

export class PluginService {
  readonly ui = new PluginUiStore();
  private readonly desktop: PluginDesktop | null;
  private readonly store: PluginServiceOptions["store"];
  private readonly runs = new Map<string, { run: PluginRun; ref: PluginRef; command: string }>();
  private readonly manifests = new Map<string, PluginManifest>();
  private snap: PluginsSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly offs: (() => void)[] = [];
  private disposed = false;

  constructor(
    readonly ed: EditorController,
    private readonly options: PluginServiceOptions = {}
  ) {
    this.desktop = options.desktop === undefined ? pluginDesktop() : options.desktop;
    this.store = options.store ?? null;
    const prefs = readJson(PREFS_KEY, { hotReload: true, developerVm: false, last: null as PluginsSnapshot["last"] });
    const local = readJson(LOCAL_KEY, { saved: [] as PluginRef[], recents: [] as PluginRef[] });
    this.snap = { development: [], organization: [], orgName: null, saved: local.saved, recents: local.recents, running: [], last: prefs.last ?? null, hotReload: prefs.hotReload !== false, developerVm: !!prefs.developerVm, creating: false };
    if (this.desktop) this.offs.push(this.desktop.onChanged(({ id }) => void this.hotReload(id)));
  }

  // ---- The snapshot React reads ----------------------------------------------------------------------------------------

  get = (): PluginsSnapshot => this.snap;
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  private set(patch: Partial<PluginsSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** Reads the lists (development plugins from main, private ones and saved / recents from the store). */
  async refresh(): Promise<void> {
    const dev = this.desktop ? await this.desktop.listDevelopment().catch(() => [] as DevelopmentPlugin[]) : [];
    const development = await Promise.all(dev.map((p) => this.developmentEntry(p)));
    const space = this.ed.source.fileSpace?.() ?? null;
    let organization: PluginEntry[] = [];
    let orgName: string | null = null;
    if (space && this.store) {
      const list = await this.store.listPrivate(space.orgId).catch(() => [] as PrivatePlugin[]);
      organization = list.filter((p) => p.kind === "plugin").map((p) => {
        this.manifests.set(p.id, p.manifest);
        return { ref: { id: p.id, name: p.name, kind: "plugin" as const, source: { type: "private" as const, orgId: p.orgId, version: p.version }, editorTypes: p.manifest.editorType ?? ["figma"] }, manifest: p.manifest, disabled: notRunnableReason(p.manifest) };
      });
      orgName = (await this.ed.source.orgName?.(space.orgId).catch(() => null)) ?? null;
    }
    const local = this.store ? await this.store.local().catch(() => null) : null;
    if (this.disposed) return;
    this.set({ development, organization, orgName, ...(local ? { saved: local.saved, recents: local.recents } : {}) });
  }

  private async developmentEntry(p: DevelopmentPlugin): Promise<PluginEntry> {
    const ref: PluginRef = { id: p.id, name: p.name, kind: "plugin", source: { type: "development", path: p.path }, editorTypes: ["figma"] };
    const known = this.manifests.get(p.id);
    if (known) return { ref: { ...ref, editorTypes: known.editorType ?? ["figma"] }, manifest: known, disabled: notRunnableReason(known) };
    try {
      const bundle = await this.desktop!.read(p.id);
      this.manifests.set(p.id, bundle.manifest);
      return { ref: { ...ref, editorTypes: bundle.manifest.editorType ?? ["figma"] }, manifest: bundle.manifest, disabled: notRunnableReason(bundle.manifest) };
    } catch (e) {
      return { ref, manifest: null, disabled: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Every plugin that runs here (development first, then the org's), for menus and the panels. */
  entries(): PluginEntry[] {
    return [...this.snap.development, ...this.snap.organization];
  }

  manifestOf(id: string): PluginManifest | null {
    return this.manifests.get(id) ?? null;
  }

  // ---- Preferences -----------------------------------------------------------------------------------------------------

  private savePrefs(): void {
    writeJson(PREFS_KEY, { hotReload: this.snap.hotReload, developerVm: this.snap.developerVm, last: this.snap.last });
  }

  toggleHotReload(): void {
    this.set({ hotReload: !this.snap.hotReload });
    this.savePrefs();
  }

  toggleDeveloperVm(): void {
    this.set({ developerVm: !this.snap.developerVm });
    this.savePrefs();
  }

  async setSaved(ref: PluginRef, saved: boolean): Promise<void> {
    const list = this.snap.saved.filter((r) => !sameRef(r, ref));
    const next = saved ? [...list, ref] : list;
    this.set({ saved: next });
    writeJson(LOCAL_KEY, { saved: next, recents: this.snap.recents });
    await this.store?.setSaved(ref, saved).catch(() => {});
  }

  isSaved(ref: PluginRef): boolean {
    return this.snap.saved.some((r) => sameRef(r, ref));
  }

  // ---- Development plugins (main) ---------------------------------------------------------------------------------------

  async importManifest(): Promise<void> {
    if (!this.desktop) return void showToast({ message: t("Developing plugins needs the desktop app") });
    try {
      const r = await this.desktop.importManifest();
      if ("cancelled" in r) return;
      this.manifests.set(r.plugin.id, r.manifest);
      await this.refresh();
    } catch (e) {
      showToast({ message: e instanceof Error ? t(e.message) : String(e), kind: "error" });
    }
  }

  /** New plugin…: the "Create a plugin" dialog (needs main). */
  openNewPlugin(open = true): void {
    this.set({ creating: open && !!this.desktop });
  }

  /** "Save as": main writes the template into a folder the person picks; the plugin joins Development. */
  async newPlugin(name: string, template: "default" | "run-once" | "custom-ui" | "inspect" | "codegen"): Promise<boolean> {
    if (!this.desktop) return false;
    try {
      const r = await this.desktop.newPlugin({ name, template });
      if ("cancelled" in r) return false;
      this.manifests.set(r.plugin.id, r.manifest);
      await this.refresh();
      return true;
    } catch (e) {
      showToast({ message: e instanceof Error ? t(e.message) : String(e), kind: "error" });
      return false;
    }
  }

  get canDevelop(): boolean {
    return !!this.desktop;
  }

  async removeDevelopment(id: string): Promise<void> {
    if (!this.desktop) return;
    await this.desktop.removeDevelopment(id).catch(() => {});
    this.manifests.delete(id);
    await this.refresh();
  }

  openConsole(): void {
    void this.desktop?.openConsole().catch(() => {});
  }

  // ---- Running ------------------------------------------------------------------------------------------------------

  private async bundleOf(ref: PluginRef): Promise<PluginBundle> {
    if (ref.source.type === "development") {
      if (!this.desktop) throw new Error(t("Developing plugins needs the desktop app"));
      return this.desktop.read(ref.id);
    }
    if (!this.store) throw new Error(t("Private plugins need the workspace"));
    return this.store.bundle(ref.id, ref.source.version);
  }

  /** Runs a plugin (a menu command, a relaunch button, Actions). Resolves with the run, or null when it didn't start. */
  async run(ref: PluginRef, command = "", options: { parameters?: Record<string, unknown>; awaitParameters?: boolean; mode?: RunSpec["mode"] } = {}): Promise<PluginRun | null> {
    const fileKey = (this.ed.source as { fileKey?: string }).fileKey ?? "";
    if (this.store) {
      const allowed = await this.store.allowed(fileKey, ref).catch(() => ({ ok: true }) as const);
      if (!allowed.ok) {
        showToast({ message: allowed.reason === "guest" ? t("Guests can't run this organization's plugins") : t("Your organization only allows approved plugins"), kind: "error" });
        return null;
      }
    }
    let bundle: PluginBundle;
    try {
      bundle = await this.bundleOf(ref);
    } catch (e) {
      showToast({ message: t("Couldn't load {name}: {error}", { name: ref.name, error: e instanceof Error ? e.message : String(e) }), kind: "error" });
      return null;
    }
    const parsed = parseManifest(bundle.manifest, { development: ref.source.type === "development", path: ref.source.type === "development" ? ref.source.path : undefined });
    if ("errors" in parsed) {
      showToast({ message: `${ref.name}: ${parsed.errors[0]}`, kind: "error" });
      return null;
    }
    const manifest = parsed.manifest;
    const why = notRunnableReason(manifest);
    if (why) {
      showToast({ message: t(why), kind: "error" });
      return null;
    }
    this.manifests.set(ref.id, manifest);
    // Figma's first run of a plugin without dynamic-page access loads every page (ours are loaded already).
    const pages = this.ed.engine.pages().length;
    if (!manifest.documentAccess && pages > 1) showToast({ message: t("Loading {n} pages", { n: pages }), duration: 1200 });
    const spec: RunSpec = {
      pluginId: manifest.id,
      name: manifest.name,
      manifest,
      code: bundle.code,
      ui: bundle.ui,
      development: ref.source.type === "development",
      command,
      parameters: options.parameters,
      awaitParameters: options.awaitParameters,
      mode: options.mode,
      editorType: runnableIn(manifest).includes("figma") ? "figma" : "dev",
      developerVm: this.snap.developerVm && ref.source.type === "development",
    };
    const run = new PluginRun(spec, {
      ed: this.ed,
      desktop: this.desktop,
      ui: this.ui,
      onEnd: (r) => {
        this.runs.delete(r.runId);
        this.set({ running: this.snap.running.filter((x) => x.runId !== r.runId) });
      },
      ...this.options.env,
    });
    this.runs.set(run.runId, { run, ref, command });
    const recents = [ref, ...this.snap.recents.filter((r) => !sameRef(r, ref))].slice(0, RECENTS_MAX);
    this.set({ running: [...this.snap.running, { runId: run.runId, ref }], recents, last: { ref, command } });
    writeJson(LOCAL_KEY, { saved: this.snap.saved, recents });
    this.savePrefs();
    void this.store?.ranRecently(ref).catch(() => {});
    try {
      await run.start();
    } catch {
      return null;
    }
    return run;
  }

  /** ⌥⌘P */
  runLast(): void {
    const last = this.snap.last;
    if (last) void this.run(last.ref, last.command);
  }

  /** Hot reload: a running development plugin restarts with its new code (Figma's "restarts after you rebuild"). */
  private async hotReload(id: string): Promise<void> {
    this.manifests.delete(id);
    if (!this.snap.hotReload) return;
    for (const { run, ref, command } of [...this.runs.values()]) {
      if (ref.id !== id || ref.source.type !== "development") continue;
      run.stop();
      await run.ended;
      await this.run(ref, command);
    }
  }

  stopAll(): void {
    for (const { run } of this.runs.values()) run.stop();
  }

  dispose(): void {
    this.disposed = true;
    for (const { run } of this.runs.values()) void run.close(null);
    this.offs.splice(0).forEach((off) => off());
  }
}

// ---- One per editor ----------------------------------------------------------------------------------------------------

const services = new WeakMap<EditorController, PluginService>();
const registryListeners = new Set<() => void>();
const registryChanged = () => registryListeners.forEach((l) => l());

export function pluginsOf(ed: EditorController): PluginService | null {
  return services.get(ed) ?? null;
}

/** The editor's service as React reads it (null until attachPlugins). */
export function usePluginService(ed: EditorController): PluginService | null {
  return useSyncExternalStore(
    (l) => {
      registryListeners.add(l);
      return () => registryListeners.delete(l);
    },
    () => pluginsOf(ed),
    () => pluginsOf(ed)
  );
}

/** EditorApp's one line: the editor's plugin service (and its lists read), until the editor goes. */
export function attachPlugins(ed: EditorController, options: PluginServiceOptions = {}): () => void {
  const s = new PluginService(ed, options);
  services.set(ed, s);
  registryChanged();
  void s.refresh();
  return () => {
    s.dispose();
    if (services.get(ed) === s) services.delete(ed);
    registryChanged();
  };
}

export function usePlugins(service: PluginService | null): PluginsSnapshot | null {
  return useSyncExternalStore(
    (l) => (service ? service.subscribe(l) : () => {}),
    () => service?.get() ?? null,
    () => service?.get() ?? null
  );
}

/** A manifest's menu as flat runnable commands (Actions' search lists them as rows). */
export function commandsOf(menu: readonly PluginMenuItem[] | undefined, path: string[] = []): { label: string; command: string }[] {
  const out: { label: string; command: string }[] = [];
  for (const m of menu ?? []) {
    if ("separator" in m) continue;
    if ("menu" in m) out.push(...commandsOf(m.menu, [...path, m.name]));
    else out.push({ label: [...path, m.name].join(" › "), command: m.command });
  }
  return out;
}
