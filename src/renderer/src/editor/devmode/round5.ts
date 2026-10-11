/**
 * Dev Mode's round 5 in the editor (docs/editor.md "Dev Mode — round 5"): what Inspect reads beyond the document —
 * dev resources (D-3), Code Connect mappings and their snippets (D-1), codegen plugins' languages (docs/plugins.md §7)
 * — through the store's `devMode` repository and the plugin host; and the round's windows (the Code Connect UI, the
 * playground, the Ready for dev view), kept here per editor rather than in UIState.
 *
 * - `editorDevData(ed)`: the `DevData` the viewer's Inspect reads (src/viewer/context.ts).
 * - `attachRound5(ed)`: the file's access (who may edit Dev Mode's data), "viewed in Dev Mode" reports (D-4, at most
 *   hourly), and the mapping cache dropped when the store says the file's mappings changed (here or, through the room's
 *   broadcast, someone else's).
 */
import { useCallback, useSyncExternalStore } from "react";
import type { Guid } from "@/engine/codec";
import { getStoreClient } from "@/store";
import { createSandbox, type PluginRun } from "../plugins";
import { pluginsOf, type PluginEntry } from "../plugins/service";
import type { CodeConnectMapping, DevModeRepository } from "@shared/devmode/types";
import type { CodegenHost, CodegenLanguage, DevData } from "../../../../viewer/context";
import type { EditorController } from "../controller";

export type ReadyFilter = "all" | "ready" | "completed";
export type ReadySort = "recent" | "pages" | "name";

export interface Round5State {
  /** The Code Connect UI ("Connect components to code"), focused on these components when opened from Inspect */
  connect: { focus: Guid[] } | null;
  /** "Explore component behavior" on this component or instance */
  playground: Guid | null;
  /** The Ready for dev view over the canvas */
  ready: boolean;
  readyFilter: ReadyFilter;
  readySort: ReadySort;
  /** May add dev resources and Code Connect UI mappings (edit access and, in orgs, a Full or Dev seat) */
  canEdit: boolean;
}

class StateStore {
  private value: Round5State = { connect: null, playground: null, ready: false, readyFilter: "all", readySort: "recent", canEdit: false };
  private readonly listeners = new Set<() => void>();
  get = () => this.value;
  set(patch: Partial<Round5State>) {
    this.value = { ...this.value, ...patch };
    this.listeners.forEach((l) => l());
  }
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
}

const stores = new WeakMap<EditorController, StateStore>();
export function round5Store(ed: EditorController): StateStore {
  let s = stores.get(ed);
  if (!s) stores.set(ed, (s = new StateStore()));
  return s;
}
export const round5 = (ed: EditorController) => round5Store(ed).get();
export const setRound5 = (ed: EditorController, patch: Partial<Round5State>) => round5Store(ed).set(patch);

export function useRound5<S>(ed: EditorController, select: (s: Round5State) => S): S {
  const store = round5Store(ed);
  const get = useCallback(() => select(store.get()), [store, select]);
  return useSyncExternalStore(store.subscribe, get);
}

/** The store's Dev Mode repository; null without a store (tests on a memory source) */
export function devRepo(): DevModeRepository | null {
  try {
    return (getStoreClient() as { devMode?: DevModeRepository }).devMode ?? null;
  } catch {
    return null;
  }
}

export const fileKeyOf = (ed: EditorController): string | null => (ed.source as { fileKey?: string }).fileKey ?? null;

// ---- Code Connect mappings, cached per file ---------------------------------------------------------------------------

const mappingCaches = new WeakMap<EditorController, Map<string, Promise<CodeConnectMapping[]>>>();
function mappingCache(ed: EditorController) {
  let m = mappingCaches.get(ed);
  if (!m) mappingCaches.set(ed, (m = new Map()));
  return m;
}

export function mappingsOf(ed: EditorController, repo: Pick<DevModeRepository, "codeConnect">, fileKey: string): Promise<CodeConnectMapping[]> {
  const cache = mappingCache(ed);
  let p = cache.get(fileKey);
  if (!p) {
    p = repo.codeConnect(fileKey).catch(() => [] as CodeConnectMapping[]);
    cache.set(fileKey, p);
  }
  return p;
}

// ---- Codegen plugins ------------------------------------------------------------------------------------------------

/** Codegen plugins in Inspect (docs/plugins.md §7): one headless run while its language is chosen. */
class Codegen implements CodegenHost {
  private run: Promise<PluginRun | null> | null = null;
  private runFor: string | null = null;
  private cache: { entries: readonly PluginEntry[]; list: CodegenLanguage[] } | null = null;

  constructor(private readonly ed: EditorController) {}

  private entries(): readonly PluginEntry[] {
    return pluginsOf(this.ed)?.entries() ?? [];
  }

  languages = (): CodegenLanguage[] => {
    const service = pluginsOf(this.ed);
    const snap = service?.get();
    const entries = snap ? [snap.development, snap.organization].flat() : [];
    if (this.cache && this.cache.entries.length === entries.length && this.cache.entries.every((e, i) => e === entries[i])) return this.cache.list;
    const list: CodegenLanguage[] = [];
    for (const e of entries) {
      const m = e.manifest;
      if (!m || e.disabled || !m.capabilities?.includes("codegen")) continue;
      for (const l of m.codegenLanguages ?? []) list.push({ pluginId: e.ref.id, pluginName: e.ref.name, label: l.label, value: l.value });
    }
    this.cache = { entries, list };
    return list;
  };

  subscribe = (listener: () => void): (() => void) => {
    const service = pluginsOf(this.ed);
    return service ? service.subscribe(listener) : () => {};
  };

  private start(pluginId: string): Promise<PluginRun | null> {
    if (this.run && this.runFor === pluginId) return this.run;
    this.stop();
    const entry = this.entries().find((e) => e.ref.id === pluginId);
    const service = pluginsOf(this.ed);
    this.runFor = pluginId;
    this.run = entry && service ? service.run(entry.ref, "", { mode: "codegen" }) : Promise.resolve(null);
    return this.run;
  }

  private stop(): void {
    const run = this.run;
    this.run = null;
    this.runFor = null;
    void run?.then((r) => r?.close(null)).catch(() => {});
  }

  select = (lang: CodegenLanguage | null): void => {
    if (!lang) this.stop();
    else void this.start(lang.pluginId);
  };

  generate = async (lang: CodegenLanguage, nodeId: string) => {
    let run = await this.start(lang.pluginId);
    if (run && !run.running) {
      // The plugin closed itself: a fresh run for this answer.
      this.stop();
      run = await this.start(lang.pluginId);
    }
    if (!run) return { blocks: [], error: `${lang.pluginName} couldn't be started` };
    const r = await run.generate(nodeId, lang.value);
    if (r.error) return { blocks: [], error: r.error };
    const list = Array.isArray(r.result) ? (r.result as { title?: unknown; code?: unknown; language?: unknown }[]) : [];
    return { blocks: list.map((b) => ({ title: String(b.title ?? ""), code: String(b.code ?? ""), language: String(b.language ?? "PLAINTEXT") })), error: null };
  };
}

const codegens = new WeakMap<EditorController, Codegen>();
function codegenOf(ed: EditorController): Codegen {
  let c = codegens.get(ed);
  if (!c) codegens.set(ed, (c = new Codegen(ed)));
  return c;
}

// ---- DevData ----------------------------------------------------------------------------------------------------------

type DesktopDev = { designer?: { devMode?: { linkTitle(url: string): Promise<string | null> }; openExternal?(url: string): void } };

/** What the viewer's Inspect reads in the editor's Dev Mode; null without a store or a file key. */
export function editorDevData(ed: EditorController, given?: DevModeRepository | null): DevData | null {
  const fileKey = fileKeyOf(ed);
  if (!fileKey) return null;
  const repo = given === undefined ? devRepo() : given;
  if (!repo) return null;
  const canEdit = round5(ed).canEdit;
  const desktop = (globalThis as unknown as DesktopDev).designer;
  return {
    fileKey,
    canEdit,
    devResources: (key, nodeIds) => repo.devResources(key, nodeIds),
    addDevResource: canEdit ? (nodeId, input) => repo.addDevResource(fileKey, { nodeId, ...input }) : undefined,
    editDevResource: canEdit ? (id, patch) => repo.editDevResource(fileKey, id, patch) : undefined,
    removeDevResource: canEdit ? (id) => repo.removeDevResource(fileKey, id) : undefined,
    linkTitle: desktop?.devMode ? (url) => desktop.devMode!.linkTitle(url).catch(() => null) : undefined,
    codeConnect: { fileKey, mappings: (key) => mappingsOf(ed, repo, key), sandbox: createSandbox },
    watch: (listener) => repo.watch((e) => listener(e.what)),
    codegen: codegenOf(ed),
    onConnectComponents: canEdit ? (nodeIds) => setRound5(ed, { connect: { focus: nodeIds } }) : undefined,
    onPlayground: (nodeId) => setRound5(ed, { playground: nodeId }),
    openUrl: (url) => (desktop?.openExternal ? desktop.openExternal(url) : void window.open(url, "_blank", "noopener")),
  };
}

// ---- Attaching -------------------------------------------------------------------------------------------------------

const VIEWED_KEY = "designer.devmode.viewed";
const HOUR = 3_600_000;

/** "Viewed in Dev Mode" (D-4): at most once an hour per file from this installation (the server also folds). */
export function reportViewed(fileKey: string, repo: Pick<DevModeRepository, "viewed">, now = Date.now()): boolean {
  let seen: Record<string, number> = {};
  try {
    seen = JSON.parse(localStorage.getItem(VIEWED_KEY) ?? "{}") as Record<string, number>;
  } catch {
    // none
  }
  if (now - (seen[fileKey] ?? 0) < HOUR) return false;
  seen[fileKey] = now;
  try {
    localStorage.setItem(VIEWED_KEY, JSON.stringify(seen));
  } catch {
    // this session only
  }
  void repo.viewed(fileKey).catch(() => {});
  return true;
}

/** Whether this person may change the file's Dev Mode data: a local file, or edit access with Dev Mode in the org. */
async function loadAccess(fileKey: string): Promise<boolean> {
  let store;
  try {
    store = getStoreClient();
  } catch {
    return true;
  }
  const st = await store.multiplayer.fileState(fileKey).catch(() => null);
  if (!st?.shared) return true;
  if (st.role === "viewer") return false;
  const info = (await store.multiplayer.fileInfo(fileKey).catch(() => null)) as { access?: { canDevMode?: boolean; capped?: string | null } | null } | null;
  const a = info?.access;
  return !a || (a.canDevMode !== false && a.capped !== "external");
}

export function attachRound5(ed: EditorController, given?: DevModeRepository | null): () => void {
  const fileKey = fileKeyOf(ed);
  const repo = !fileKey ? null : given === undefined ? devRepo() : given;
  const offs: (() => void)[] = [];
  if (fileKey) void loadAccess(fileKey).then((canEdit) => !ed.engine.destroyed && setRound5(ed, { canEdit }));
  if (repo) {
    // A file's change is said under its local and room keys, and a library's records are held under its key: drop all.
    offs.push(repo.watch((e) => e.what === "codeConnect" && mappingCache(ed).clear()));
  }
  let wasDev = ed.ui.get().mode === "dev";
  if (wasDev && fileKey && repo) reportViewed(fileKey, repo);
  offs.push(
    ed.ui.subscribe(() => {
      const dev = ed.ui.get().mode === "dev";
      if (dev && !wasDev && fileKey && repo) reportViewed(fileKey, repo);
      if (!dev && wasDev) setRound5(ed, { ready: false, connect: null, playground: null });
      wasDev = dev;
    })
  );
  return () => {
    offs.forEach((off) => off());
    codegens.get(ed)?.select(null);
  };
}
