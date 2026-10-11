/**
 * The store's `plugins` repository (docs/plugins.md §6 "Saved plugins and recents", §10; round 5g).
 *
 * - **Saved and recents** are this installation's (`Workspace/plugins.json` on the desktop, `designer.devStore.v1.plugins`
 *   in the browser): `{saved, recents (≤ 10, newest first), published: {orgId + development path → plugin id}}`.
 * - **Private plugins** (§10.1) are the server's. Lists are cached per org for offline use (`spaces/plugins/orgs/<orgId>.json`,
 *   keyed by the signed-in person); bundles are downloaded once per version (`spaces/plugins/<id>/<version>/…`, immutable).
 * - **Publishing** is three steps: `POST /orgs/:org/plugins` (the parts' SHA-1s) → `PUT` each missing part → `POST …/commit`.
 *   The first publish of a development plugin remembers its id, so later ones update it (version + 1).
 * - **`allowed`** (§10.2) reads the file's org from `FileMeta.space`, the org's settings and the caller's role from the
 *   org cache (OrgService), and the approved list online first (kept 30 s, cached for offline use), dropped when the
 *   Inbox says `{t: "plugins", orgId}`.
 * - **Events** (topic `plugins`): `{what: "local"}` after saved / recents change, `{what: "org", orgId}` after a change
 *   made here or heard from the Inbox.
 *
 * No Node or DOM imports: the desktop store (LocalStore) and the browser's dev store (MemoryStore) both run it.
 */
import type { OrgInfo } from "../../shared/org/types";
import type { PluginApproval, PluginBundle, PluginKind, PluginManifest, PluginRef, PluginRequest, PluginsEvent, PluginsRepository, PrivatePlugin } from "../../shared/plugins/types";
import { StoreError } from "../../shared/store/protocol";
import type { Unsubscribe } from "../../shared/store/repositories";
import type { FileKey, FileMeta } from "../../shared/store/types";
import { callBytes, callJson, isOffline, seg, type LibraryCacheStore, type LibraryServer } from "../libraries/org";

/** Figma's Recents list in Actions › Plugins & widgets */
export const MAX_RECENTS = 10;
/** How long an approved list read from the server answers `allowed` without asking again */
export const APPROVED_TTL_MS = 30_000;
export const MAX_PART_BYTES = 10 * 1024 * 1024;
const PLUGIN_ID = /^[1-9][0-9]{18}$/;
const UI_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

/** What the store gives the service. */
export interface PluginsHost {
  server: LibraryServer;
  /** `spaces/` (plugins/… names) */
  cache: LibraryCacheStore;
  /** plugins.json */
  loadLocal(): Promise<unknown>;
  saveLocal(value: LocalPlugins): Promise<void>;
  getMeta(fileKey: FileKey): FileMeta | null;
  /** The org as the org cache has it (settings, the caller's role); null when unknown */
  orgInfo(orgId: string): Promise<OrgInfo | null>;
  /** A team's workspace (Enterprise); null when none; fails when it can't be read */
  teamWorkspace(teamId: string): Promise<string | null>;
  /** The Inbox's `{t: "plugins", orgId}` */
  notices?: { onPlugins(listener: (n: { orgId: string }) => void): Unsubscribe };
  now(): number;
  log(level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown): void;
}

export interface LocalPlugins {
  v: 1;
  saved: PluginRef[];
  recents: PluginRef[];
  /** `${orgId}\n${developmentPath}` → the published plugin's id */
  published: Record<string, string>;
}

interface OrgPluginsCache {
  v: 1;
  uid: string | null;
  plugins?: PrivatePlugin[];
  approved?: Partial<Record<PluginKind, PluginApproval[]>>;
  /** Teams' workspaces as last read (a file's workspace decides workspace approvals) */
  teams?: Record<string, string | null>;
}

const EDITOR_TYPES = new Set(["figma", "figjam", "dev", "slides", "buzz"]);

/** A ref as callers may send it: checked and copied */
export function cleanRef(v: unknown): PluginRef {
  const r = v as PluginRef;
  if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.id || r.id.length > 200) throw new StoreError("invalid", "a plugin is {id, name, kind, source, editorTypes}");
  if (r.kind !== "plugin" && r.kind !== "widget") throw new StoreError("invalid", "kind is plugin or widget");
  const s = r.source as PluginRef["source"] | undefined;
  let source: PluginRef["source"];
  if (s?.type === "development" && typeof s.path === "string" && s.path) source = { type: "development", path: s.path };
  else if (s?.type === "private" && typeof s.orgId === "string" && s.orgId && Number.isInteger(s.version) && s.version >= 0) source = { type: "private", orgId: s.orgId, version: s.version };
  else throw new StoreError("invalid", "source is {type: development, path} or {type: private, orgId, version}");
  const editorTypes = Array.isArray(r.editorTypes) ? r.editorTypes.filter((t) => EDITOR_TYPES.has(t)) : [];
  return { id: r.id, name: typeof r.name === "string" ? r.name.slice(0, 200) : r.id, kind: r.kind, source, editorTypes };
}

/** The same plugin (a private plugin's versions are one) */
const refKey = (r: PluginRef): string => (r.source.type === "development" ? `d\n${r.source.path}\n${r.id}` : `p\n${r.source.orgId}\n${r.id}`);

/** A bundle's parts as the server names them: `code`, `ui` (one file) or `ui:<key>` */
export function bundleParts(bundle: PluginBundle): { name: string; text: string }[] {
  if (!bundle || typeof bundle !== "object" || typeof bundle.code !== "string") throw new StoreError("invalid", "a bundle is {manifest, code, ui}");
  const out = [{ name: "code", text: bundle.code }];
  const ui = bundle.ui && typeof bundle.ui === "object" ? bundle.ui : {};
  const keys = Object.keys(ui);
  for (const k of keys) {
    if (typeof ui[k] !== "string") throw new StoreError("invalid", `ui ${k} isn't text`);
    if (k === "") {
      if (keys.length > 1) throw new StoreError("invalid", "a single ui file can't sit beside named ones");
      out.push({ name: "ui", text: ui[k] });
    } else if (!UI_KEY.test(k)) throw new StoreError("invalid", `bad ui key ${k}`);
    else out.push({ name: `ui:${k}`, text: ui[k] });
  }
  return out;
}

/** The parts a manifest's `ui` implies */
function partsOfManifest(m: PluginManifest): string[] {
  const ui = m.ui;
  if (typeof ui === "string") return ["code", "ui"];
  if (ui && typeof ui === "object") return ["code", ...Object.keys(ui).filter((k) => UI_KEY.test(k)).map((k) => `ui:${k}`)];
  return ["code"];
}

export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const d = await globalThis.crypto.subtle.digest("SHA-1", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export class PluginsService {
  private readonly listeners = new Set<(e: PluginsEvent) => void>();
  private local: LocalPlugins | null = null;
  private localChain: Promise<unknown> = Promise.resolve();
  /** Approved lists read from the server lately: `${orgId}\n${kind}` → when and what */
  private readonly approvedMemo = new Map<string, { at: number; list: PluginApproval[] }>();
  private readonly offs: Unsubscribe[] = [];

  constructor(private readonly host: PluginsHost) {
    if (host.notices) this.offs.push(host.notices.onPlugins((n) => this.orgChanged(n.orgId)));
    if (host.server.onSession) this.offs.push(host.server.onSession(() => this.approvedMemo.clear()));
  }

  close(): void {
    for (const off of this.offs.splice(0)) off();
  }

  onEvent(listener: (e: PluginsEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: PluginsEvent): void {
    for (const l of [...this.listeners]) l(e);
  }

  /** An org's plugins changed (here or, said by the Inbox, elsewhere): the approved lists are read again */
  orgChanged(orgId: string): void {
    for (const k of [...this.approvedMemo.keys()]) if (k.startsWith(`${orgId}\n`)) this.approvedMemo.delete(k);
    this.emit({ what: "org", orgId });
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return callJson<T>(this.host.server, method, path, body);
  }

  // ---- saved / recents ----

  private async loadLocal(): Promise<LocalPlugins> {
    if (this.local) return this.local;
    const raw = (await this.host.loadLocal().catch(() => null)) as Partial<LocalPlugins> | null;
    const refs = (v: unknown): PluginRef[] => {
      if (!Array.isArray(v)) return [];
      const out: PluginRef[] = [];
      for (const r of v) {
        try {
          out.push(cleanRef(r));
        } catch {
          /* dropped */
        }
      }
      return out;
    };
    const published: Record<string, string> = {};
    if (raw?.published && typeof raw.published === "object") for (const [k, id] of Object.entries(raw.published)) if (typeof id === "string" && PLUGIN_ID.test(id)) published[k] = id;
    this.local = { v: 1, saved: refs(raw?.saved), recents: refs(raw?.recents).slice(0, MAX_RECENTS), published };
    return this.local;
  }

  private changeLocal(change: (l: LocalPlugins) => LocalPlugins | null, event = true): Promise<void> {
    const run = async () => {
      const cur = await this.loadLocal();
      const next = change(structuredClone(cur));
      if (!next) return;
      await this.host.saveLocal(next);
      this.local = next;
      if (event) this.emit({ what: "local" });
    };
    const p = this.localChain.then(run, run);
    this.localChain = p.catch(() => undefined);
    return p;
  }

  // ---- org caches ----

  private async orgCache(orgId: string): Promise<OrgPluginsCache> {
    const c = await this.host.cache.readJson<OrgPluginsCache>(`plugins/orgs/${orgId}.json`).catch(() => null);
    return c && c.v === 1 && c.uid === this.host.server.userId ? c : { v: 1, uid: this.host.server.userId };
  }

  private async saveOrgCache(orgId: string, patch: Partial<OrgPluginsCache>): Promise<void> {
    const c = await this.orgCache(orgId);
    await this.host.cache.writeJson(`plugins/orgs/${orgId}.json`, { ...c, ...patch, approved: { ...c.approved, ...patch.approved }, uid: this.host.server.userId }).catch((e) => this.host.log("warn", `${orgId}: the plugins cache wasn't kept`, e));
  }

  /** The approved list of an org (members' route), online first; offline, the cache; nothing cached → null */
  private async approved(orgId: string, kind: PluginKind): Promise<PluginApproval[] | null> {
    const k = `${orgId}\n${kind}`;
    const memo = this.approvedMemo.get(k);
    if (memo && this.host.now() - memo.at < APPROVED_TTL_MS) return memo.list;
    try {
      const list = (await this.call<{ approved: PluginApproval[] }>("GET", `/orgs/${seg(orgId, "org id")}/plugins/approved?kind=${kind}`)).approved ?? [];
      this.approvedMemo.set(k, { at: this.host.now(), list });
      await this.saveOrgCache(orgId, { approved: { [kind]: list } });
      return list;
    } catch (e) {
      if (!isOffline(e)) throw e;
      return (await this.orgCache(orgId)).approved?.[kind] ?? null;
    }
  }

  /** A team's workspace, as the org cache says; remembered here for offline checks */
  private async workspaceOf(orgId: string, teamId: string): Promise<string | null> {
    try {
      const ws = await this.host.teamWorkspace(teamId);
      const c = await this.orgCache(orgId);
      if (c.teams?.[teamId] !== ws) await this.saveOrgCache(orgId, { teams: { ...c.teams, [teamId]: ws } });
      return ws;
    } catch {
      return (await this.orgCache(orgId)).teams?.[teamId] ?? null;
    }
  }

  private bundleName(id: string, version: number, part: string): string {
    return `plugins/${id}/${version}/${part.replace(":", "-")}`;
  }

  // ---- allowed (§10.2) ----

  async allowed(fileKey: string, refIn: PluginRef): Promise<{ ok: true } | { ok: false; reason: "approval"; canRequest: boolean } | { ok: false; reason: "guest" }> {
    const ref = cleanRef(refIn);
    // Private plugins: org members only (guests refused, as Figma), wherever they run
    if (ref.source.type === "private") {
      const org = await this.host.orgInfo(ref.source.orgId);
      if (org?.role === "guest") return { ok: false, reason: "guest" };
    }
    const space = typeof fileKey === "string" ? (this.host.getMeta(fileKey)?.space ?? null) : null;
    if (!space) return { ok: true }; // outside organizations nothing restricts plugins
    const org = await this.host.orgInfo(space.orgId);
    if (!org) return { ok: true }; // not a member any more: the file itself won't open for long
    const approval = ref.kind === "widget" ? org.settings.widgetApproval : org.settings.pluginApproval;
    if (approval !== "approved") return { ok: true };
    // Exempt: the org's own private plugins; development plugins run by the person developing them (ours)
    if (ref.source.type === "private" && ref.source.orgId === space.orgId) return { ok: true };
    if (ref.source.type === "development") return { ok: true };
    const workspaceId = space.teamId ? await this.workspaceOf(space.orgId, space.teamId) : null;
    const list = await this.approved(space.orgId, ref.kind).catch((e) => {
      this.host.log("warn", `${space.orgId}: the approved ${ref.kind}s couldn't be read`, e);
      return null;
    });
    if (list?.some((a) => a.pluginId === ref.id && a.kind === ref.kind && (a.scope.type === "org" || (workspaceId !== null && a.scope.id === workspaceId)))) return { ok: true };
    const requests = ref.kind === "widget" ? org.settings.widgetRequests : org.settings.pluginRequests;
    let canRequest = requests && org.role !== "guest";
    if (canRequest) {
      // One pending request per person and plugin (the server's rule): asked already → nothing more to ask
      const mine = await this.call<{ requests: PluginRequest[] }>("GET", `/orgs/${seg(space.orgId, "org id")}/plugins/requests`).catch(() => ({ requests: [] as PluginRequest[] }));
      if (mine.requests?.some((q) => q.pluginId === ref.id && q.kind === ref.kind && q.state === "pending")) canRequest = false;
    }
    return { ok: false, reason: "approval", canRequest };
  }

  // ---- the repository ----

  repository(): PluginsRepository {
    return {
      local: async () => {
        const l = await this.loadLocal();
        return { saved: structuredClone(l.saved), recents: structuredClone(l.recents) };
      },
      setSaved: async (refIn, saved) => {
        const ref = cleanRef(refIn);
        await this.changeLocal((l) => {
          const has = l.saved.findIndex((r) => refKey(r) === refKey(ref));
          if (saved === true) {
            if (has >= 0) l.saved[has] = ref;
            else l.saved.push(ref);
          } else if (has >= 0) l.saved.splice(has, 1);
          else return null;
          return l;
        });
      },
      ranRecently: async (refIn) => {
        const ref = cleanRef(refIn);
        await this.changeLocal((l) => {
          l.recents = [ref, ...l.recents.filter((r) => refKey(r) !== refKey(ref))].slice(0, MAX_RECENTS);
          // A saved private plugin follows the version that ran
          l.saved = l.saved.map((r) => (refKey(r) === refKey(ref) ? ref : r));
          return l;
        });
      },
      listPrivate: async (orgId) => {
        const id = seg(orgId, "org id");
        try {
          const plugins = (await this.call<{ plugins: PrivatePlugin[] }>("GET", `/orgs/${id}/plugins`)).plugins ?? [];
          await this.saveOrgCache(id, { plugins });
          return plugins;
        } catch (e) {
          if (!isOffline(e)) throw e;
          const cached = (await this.orgCache(id)).plugins;
          if (!cached) throw e;
          return cached;
        }
      },
      bundle: async (pluginId, version) => {
        if (typeof pluginId !== "string" || !PLUGIN_ID.test(pluginId)) throw new StoreError("invalid", "bad plugin id");
        if (!Number.isInteger(version) || version < 1) throw new StoreError("invalid", "bad version");
        const cache = this.host.cache;
        const manifestName = this.bundleName(pluginId, version, "manifest.json");
        let manifest = await cache.readJson<PluginManifest>(manifestName).catch(() => null);
        if (!manifest) {
          const { plugin } = await this.call<{ plugin: PrivatePlugin }>("GET", `/plugins/${pluginId}`);
          if (plugin.version !== version) throw new StoreError("conflict", `Version ${version} of ${plugin.name} isn't the current one`, { current: plugin.version });
          manifest = plugin.manifest;
        }
        const ui: Record<string, string> = {};
        let code = "";
        for (const part of partsOfManifest(manifest)) {
          const name = this.bundleName(pluginId, version, part);
          let bytes = await cache.readBytes(name).catch(() => null);
          if (!bytes) {
            bytes = await callBytes(this.host.server, "GET", `/plugins/${pluginId}/parts/${version}/${encodeURIComponent(part)}`);
            await cache.writeBytes(name, bytes).catch((e) => this.host.log("warn", `plugin ${pluginId}: a part wasn't cached`, e));
          }
          const text = dec.decode(bytes);
          if (part === "code") code = text;
          else ui[part === "ui" ? "" : part.slice(3)] = text;
        }
        await cache.writeJson(manifestName, manifest).catch(() => undefined);
        return { manifest, code, ui };
      },
      publish: async (orgId, bundle, meta) => {
        const org = seg(orgId, "org id");
        const parts = bundleParts(bundle);
        const manifest = bundle.manifest;
        if (!manifest || typeof manifest !== "object") throw new StoreError("invalid", "the bundle has no manifest");
        const devPath = typeof meta?.developmentPath === "string" ? meta.developmentPath : "";
        const mapKey = `${org}\n${devPath}`;
        const encoded = await Promise.all(
          parts.map(async (p) => {
            const bytes = enc.encode(p.text);
            if (bytes.byteLength > MAX_PART_BYTES) throw new StoreError("too-large", `${p.name === "code" ? "The plugin's code" : "Its UI"} is larger than 10 MB`);
            return { name: p.name, bytes, sha1: await sha1Hex(bytes) };
          }),
        );
        const body = {
          manifest,
          parts: encoded.map((p) => ({ name: p.name, sha1: p.sha1, size: p.bytes.byteLength })),
          ...(typeof meta?.name === "string" && meta.name.trim() ? { name: meta.name.trim().slice(0, 100) } : {}),
          ...(typeof meta?.description === "string" ? { description: meta.description.slice(0, 2000) } : {}),
        };
        // 1. reserve the version (an update of the plugin published from this folder before, unless it is gone)
        const known = devPath ? (await this.loadLocal()).published[mapKey] : undefined;
        let started: { plugin: PrivatePlugin; version: number; missing: string[] };
        try {
          started = await this.call("POST", `/orgs/${org}/plugins`, known ? { ...body, pluginId: known } : body);
        } catch (e) {
          if (!known || !(e instanceof StoreError) || e.code !== "not-found") throw e;
          started = await this.call("POST", `/orgs/${org}/plugins`, body);
        }
        const id = started.plugin.id;
        if (devPath && known !== id) await this.changeLocal((l) => ((l.published[mapKey] = id), l), false);
        // 2. the parts the server doesn't have
        const missing = new Set(started.missing ?? []);
        for (const p of encoded) if (missing.has(p.name)) await this.call("PUT", `/plugins/${id}/parts/${started.version}/${encodeURIComponent(p.name)}`, p.bytes);
        // 3. commit
        const { plugin } = await this.call<{ plugin: PrivatePlugin }>("POST", `/plugins/${id}/versions/${started.version}/commit`);
        // The bundle just published runs from the cache without a download
        for (const p of encoded) await this.host.cache.writeBytes(this.bundleName(id, plugin.version, p.name), p.bytes).catch(() => undefined);
        await this.host.cache.writeJson(this.bundleName(id, plugin.version, "manifest.json"), plugin.manifest).catch(() => undefined);
        this.orgChanged(org);
        return plugin;
      },
      removePrivate: async (pluginId) => {
        if (typeof pluginId !== "string" || !PLUGIN_ID.test(pluginId)) throw new StoreError("invalid", "bad plugin id");
        const { plugin } = await this.call<{ plugin: PrivatePlugin }>("GET", `/plugins/${pluginId}`);
        await this.call("DELETE", `/plugins/${pluginId}`);
        await this.changeLocal((l) => {
          const gone = (r: PluginRef) => r.source.type === "private" && r.id === pluginId;
          for (const [k, id] of Object.entries(l.published)) if (id === pluginId) delete l.published[k];
          l.saved = l.saved.filter((r) => !gone(r));
          l.recents = l.recents.filter((r) => !gone(r));
          return l;
        });
        this.orgChanged(plugin.orgId);
      },
      allowed: (fileKey, ref) => this.allowed(fileKey, ref),
      request: async (orgId, input) => {
        const org = seg(orgId, "org id");
        if (!input || typeof input.pluginId !== "string" || !input.pluginId || (input.kind !== "plugin" && input.kind !== "widget")) throw new StoreError("invalid", "a request is {pluginId, kind, name, manifest, reason}");
        const body = { pluginId: input.pluginId, kind: input.kind, name: typeof input.name === "string" ? input.name : input.pluginId, manifest: input.manifest ?? null, reason: typeof input.reason === "string" ? input.reason : "", ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) };
        const { request } = await this.call<{ request: PluginRequest }>("POST", `/orgs/${org}/plugins/requests`, body);
        this.orgChanged(org);
        return request;
      },
      admin: async (orgId, kind) => {
        const k = kind === "widget" ? "widget" : "plugin";
        const out = await this.call<{ approved: PluginApproval[]; requests: PluginRequest[]; private: PrivatePlugin[] }>("GET", `/orgs/${seg(orgId, "org id")}/admin/plugins?kind=${k}`);
        return { approved: out.approved ?? [], requests: out.requests ?? [], private: out.private ?? [] };
      },
      approve: async (orgId, input) => {
        const org = seg(orgId, "org id");
        if (!input || typeof input.pluginId !== "string" || !input.pluginId) throw new StoreError("invalid", "an approval is {pluginId, kind, name, scope}");
        const scope = input.scope?.type === "workspace" ? { type: "workspace", ids: Array.isArray(input.scope.ids) ? input.scope.ids.map((i) => seg(i, "workspace id")) : [] } : { type: "org" };
        await this.call("POST", `/orgs/${org}/admin/plugins/approvals`, { pluginId: input.pluginId, kind: input.kind === "widget" ? "widget" : "plugin", name: typeof input.name === "string" ? input.name : input.pluginId, scope });
        this.orgChanged(org);
      },
      unapprove: async (orgId, pluginId, workspaceId) => {
        const org = seg(orgId, "org id");
        if (typeof pluginId !== "string" || !pluginId || pluginId.length > 200) throw new StoreError("invalid", "bad plugin id");
        // The route takes the kind (default plugin): a widget's approval is found in the cached lists
        const cached = (await this.orgCache(org)).approved;
        const kind: PluginKind = cached?.widget?.some((a) => a.pluginId === pluginId) && !cached?.plugin?.some((a) => a.pluginId === pluginId) ? "widget" : "plugin";
        const q = new URLSearchParams({ kind });
        if (workspaceId) q.set("workspace", seg(workspaceId, "workspace id"));
        await this.call("DELETE", `/orgs/${org}/admin/plugins/approvals/${encodeURIComponent(pluginId)}?${q}`);
        this.orgChanged(org);
      },
      answer: async (orgId, requestId, input) => {
        const org = seg(orgId, "org id");
        const body: { approve: boolean; reason?: string; workspaceIds?: string[] } = { approve: input?.approve === true };
        if (typeof input?.reason === "string") body.reason = input.reason;
        if (Array.isArray(input?.workspaceIds)) body.workspaceIds = input.workspaceIds.map((i) => seg(i, "workspace id"));
        const { request } = await this.call<{ request: PluginRequest }>("POST", `/orgs/${org}/admin/plugins/requests/${seg(requestId, "request id")}`, body);
        this.orgChanged(org);
        return request;
      },
      watch: (listener) => this.onEvent(listener),
    };
  }
}
